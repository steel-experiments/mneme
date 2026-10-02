// ABOUTME: Discord private threads default to restricted unless an explicit thread rule says otherwise (spec Section 7.1).
// ABOUTME: Covers resolver order, discovery, isolation from parent and siblings, reload, Discord mapping, and Slack.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { discoverChannels, type DiscoveredChannelDescriptor } from '../../src/ingestion/discovery.js';
import { parseChannelPolicy, resolveChannel } from '../../src/policy/channel-policy.js';
import { getChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { searchMessages } from '../../src/db/repositories/message-search.js';
import { grantForTargetChannel } from '../../src/production-runtime.js';
import { ConfigStore, buildConfigSnapshot, reloadConfig } from '../../src/config-reload.js';
import type { PromptFiles } from '../../src/agent/prompts.js';
import { descriptorsFromJsChannels } from '../../src/platform/discord/channel-descriptors.js';
import { channelInputFromRaw } from '../../src/platform/discord/gateway-events.js';

const NOW = 1_700_000_000_000;
const PARENT = '300000000000000010';
const PRIVATE_A = '300000000000000011';
const PRIVATE_B = '300000000000000012';
const PUBLIC_T = '300000000000000013';
const FULL = { canView: true, canReadHistory: true, canSend: true, canSendInThreads: true, canManageThreads: true };

const ORG_DEFAULT = `version: 1
default:
  ingest: true
  visibility: org
  allow_interventions: false
`;

let env: TestDb | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function descriptors(): DiscoveredChannelDescriptor[] {
  return [
    { id: PARENT, parentId: null, kind: 'text', name: 'general', capabilities: FULL },
    { id: PRIVATE_A, parentId: PARENT, kind: 'thread', name: 'private-a', capabilities: FULL, isPrivateThread: true },
    { id: PRIVATE_B, parentId: PARENT, kind: 'thread', name: 'private-b', capabilities: FULL, isPrivateThread: true },
    { id: PUBLIC_T, parentId: PARENT, kind: 'thread', name: 'public-t', capabilities: FULL },
  ];
}

function discover(yml = ORG_DEFAULT): string {
  env = createTestDb();
  const { guildId } = seedIdentity(env.db);
  discoverChannels(env.db, descriptors(), { guildId, policy: parseChannelPolicy(yml), now: NOW });
  return guildId;
}

function message(id: string, channelId: string, guildId: string): void {
  upsertMessageCreate(env!.db, {
    id, guildId, channelId, authorId: '100000000000000003', authorDisplayName: 'Alice',
    content: 'Private thread codename is heron.', createdAtMs: NOW, editedAtMs: null, replyToMessageId: null,
    messageType: 0, flags: 0, pinned: false, mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]',
    componentsJson: '[]', pollJson: null, rawJson: null, ingestedAtMs: NOW, updatedAtMs: NOW,
  });
}

function visibleIn(channelId: string): string[] {
  const channel = getChannel(env!.db, channelId);
  const parent = channel?.parent_id ? getChannel(env!.db, channel.parent_id) : undefined;
  const grant = grantForTargetChannel(channel, parent?.visibility_class);
  return searchMessages(env!.db, grant, { query: 'heron', limit: 20, now: NOW }).map((m) => m.messageId);
}

describe('private thread policy resolution', () => {
  const policy = parseChannelPolicy(`${ORG_DEFAULT}channels:
  "${PRIVATE_B}":
    ingest: true
    visibility: org
    allow_interventions: false
  "300000000000000020":
    ingest: false
    visibility: excluded
    allow_interventions: false
`);

  it('defaults a private thread below an org parent to restricted', () => {
    const resolved = resolveChannel(policy, PRIVATE_A, { isThread: true, parentId: PARENT, isPrivateThread: true });
    expect(resolved.source).toBe('private_thread');
    expect(resolved.rule.visibility).toBe('restricted');
    expect(resolved.rule.ingest).toBe(true);
  });

  it('lets an explicit rule for the thread id set a private thread to org', () => {
    const resolved = resolveChannel(policy, PRIVATE_B, { isThread: true, parentId: PARENT, isPrivateThread: true });
    expect(resolved.source).toBe('channel');
    expect(resolved.rule.visibility).toBe('org');
  });

  it('keeps a narrower inherited class for a private thread', () => {
    const resolved = resolveChannel(policy, PRIVATE_A, { isThread: true, parentId: '300000000000000020', isPrivateThread: true });
    expect(resolved.rule.visibility).toBe('excluded');
  });

  it('lets a public thread inherit its org parent', () => {
    const resolved = resolveChannel(policy, PUBLIC_T, { isThread: true, parentId: PARENT });
    expect(resolved.source).toBe('default');
    expect(resolved.rule.visibility).toBe('org');
  });
});

describe('private threads in discovery and retrieval', () => {
  it('stores a discovered private thread as restricted and keeps a public thread org', () => {
    discover();
    expect(getChannel(env!.db, PRIVATE_A)).toMatchObject({ visibility_class: 'restricted', is_private_thread: 1 });
    expect(getChannel(env!.db, PUBLIC_T)).toMatchObject({ visibility_class: 'org', is_private_thread: 0 });
  });

  it('keeps private thread content out of the parent, a sibling private thread, and public threads', () => {
    const guildId = discover();
    message('private-a-message', PRIVATE_A, guildId);
    expect(visibleIn(PRIVATE_A)).toContain('private-a-message');
    expect(visibleIn(PARENT)).not.toContain('private-a-message');
    expect(visibleIn(PRIVATE_B)).not.toContain('private-a-message');
    expect(visibleIn(PUBLIC_T)).not.toContain('private-a-message');
  });

  it('keeps a private thread restricted after a policy reload', () => {
    const guildId = discover();
    const prompts = {
      system: 'Mneme system prompt.', 'episode-review': 'Review {{json id}}.', 'direct-answer': 'Answer {{json question}}.',
      'scheduled-review': 'Scheduled.', partials: { personality: 'quiet', boundaries: 'strict', 'memory-taxonomy': 'taxonomy' },
    } as PromptFiles;
    const store = new ConfigStore(buildConfigSnapshot({ channelPolicyYml: ORG_DEFAULT, promptFiles: prompts, now: NOW }));
    const res = reloadConfig({
      db: env!.db, store, guildId, actorUserId: '100000000000000003', nowMs: NOW + 1,
      channelPolicyYml: ORG_DEFAULT.replace('allow_interventions: false', 'allow_interventions: true'),
      promptFiles: prompts, enqueueMaintenance: () => ({ id: 'm1', enqueued: true }),
    });
    expect(res.ok).toBe(true);
    expect(getChannel(env!.db, PRIVATE_A)?.visibility_class).toBe('restricted');
    expect(getChannel(env!.db, PUBLIC_T)?.visibility_class).toBe('org');
  });
});

describe('platform mapping', () => {
  it('marks Discord type 12 threads as private and type 11 threads as public', () => {
    const [privateThread, publicThread] = descriptorsFromJsChannels(
      [{ id: PRIVATE_A, parentId: PARENT, type: 12 }, { id: PUBLIC_T, parentId: PARENT, type: 11 }],
      () => FULL,
    );
    expect(privateThread?.isPrivateThread).toBe(true);
    expect(publicThread?.isPrivateThread).toBe(false);
    expect(channelInputFromRaw({ id: PRIVATE_A, guild_id: '100000000000000001', type: 12, parent_id: PARENT }, '100000000000000001', NOW)?.isPrivateThread).toBe(true);
    expect(channelInputFromRaw({ id: PUBLIC_T, guild_id: '100000000000000001', type: 11, parent_id: PARENT }, '100000000000000001', NOW)?.isPrivateThread).toBe(false);
  });

  it('lets a Slack thread row inherit its org channel, because Slack has no private threads', () => {
    env = createTestDb();
    const { guildId } = seedIdentity(env.db);
    discoverChannels(env.db, [
      { id: 'C0SLACK001', parentId: null, kind: 'text', name: 'team', capabilities: FULL },
      { id: 'C0SLACK001-T1790000000.000100', parentId: 'C0SLACK001', kind: 'thread', name: null, capabilities: FULL },
    ], { guildId, policy: parseChannelPolicy(ORG_DEFAULT), now: NOW });
    expect(getChannel(env.db, 'C0SLACK001-T1790000000.000100')).toMatchObject({ visibility_class: 'org', is_private_thread: 0 });
  });
});
