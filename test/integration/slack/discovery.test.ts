// ABOUTME: Tests Slack discovery: member-only channels, known threads, and Slack Connect exclusion.
// ABOUTME: Plan 006 step 4; the Slack Web API is a test double.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { conversation, fakeSlackApi, seedSlackWorkspace, TEAM } from '../../helpers/slack.js';
import { parseChannelPolicy } from '../../../src/policy/channel-policy.js';
import { runStartupSync } from '../../../src/ingestion/sync.js';
import { getChannel, upsertChannel } from '../../../src/db/repositories/channels.js';
import { listSlackChannels } from '../../../src/platform/slack/discovery.js';

const MEMBER = 'C0000000001';
const OTHER = 'C0000000002';
const SHARED = 'C0000000003';
const THREAD = `${MEMBER}-T1790933759.217369`;
const SHARED_THREAD = `${SHARED}-T1790933759.217369`;
const NOW = 1_790_000_000_000;

const POLICY = parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: org
  allow_interventions: false
channels: {}
`);

describe('Slack discovery', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  function setup() {
    t = createTestDb();
    seedSlackWorkspace(t.db);
    return t.db;
  }

  async function discover(db: ReturnType<typeof setup>, api: ReturnType<typeof fakeSlackApi>, now = NOW) {
    const channels = await listSlackChannels(api, db, TEAM);
    return runStartupSync({ db, guildId: TEAM, policy: POLICY, now, channels, completeThreadSnapshot: true,
      enqueueHistoricalBackfill: false });
  }

  function storeThread(db: ReturnType<typeof setup>, id: string, parentId: string) {
    upsertChannel(db, { id, guildId: TEAM, parentId, kind: 'thread', name: null, topic: null, position: null,
      isThread: true, isArchived: false, isLocked: false, ingestEnabled: true, visibilityClass: 'org',
      allowInterventions: false, permissionFingerprint: null, lastMessageId: null, discoveredAtMs: NOW,
      updatedAtMs: NOW, rawJson: null });
  }

  it('stores a member channel and leaves a non-member channel out', async () => {
    const db = setup();
    const api = fakeSlackApi();
    api.conversations.set(MEMBER, conversation(MEMBER));
    api.conversations.set(OTHER, conversation(OTHER, { is_member: false }));
    await discover(db, api);
    expect(getChannel(db, MEMBER)).toMatchObject({ ingest_enabled: 1, visibility_class: 'org', kind: 'text' });
    expect(getChannel(db, OTHER)).toBeUndefined();
  });

  it('excludes a channel the bot left on the next run, with its threads', async () => {
    const db = setup();
    const api = fakeSlackApi();
    api.conversations.set(MEMBER, conversation(MEMBER));
    await discover(db, api);
    storeThread(db, THREAD, MEMBER);
    await discover(db, api, NOW + 1);
    expect(getChannel(db, THREAD)).toMatchObject({ ingest_enabled: 1, visibility_class: 'org' });
    api.conversations.set(MEMBER, conversation(MEMBER, { is_member: false }));
    await discover(db, api, NOW + 2);
    expect(getChannel(db, MEMBER)).toMatchObject({ ingest_enabled: 0, visibility_class: 'excluded' });
    expect(getChannel(db, THREAD)).toMatchObject({ ingest_enabled: 0, visibility_class: 'excluded' });
  });

  it('excludes a Slack Connect channel and its threads with source platform_boundary', async () => {
    const db = setup();
    const api = fakeSlackApi();
    api.conversations.set(SHARED, conversation(SHARED, { is_ext_shared: true }));
    const first = await discover(db, api);
    storeThread(db, SHARED_THREAD, SHARED);
    const second = await discover(db, api, NOW + 1);
    expect(first.discovery.excluded.find((c) => c.id === SHARED)?.policySource).toBe('platform_boundary');
    expect(second.discovery.excluded.find((c) => c.id === SHARED_THREAD)?.policySource).toBe('platform_boundary');
    expect(getChannel(db, SHARED)).toMatchObject({ ingest_enabled: 0, visibility_class: 'excluded', platform_boundary: 'excluded' });
    expect(getChannel(db, SHARED_THREAD)).toMatchObject({ ingest_enabled: 0, visibility_class: 'excluded' });
  });

  it('keeps a channel excluded after it stops being shared', async () => {
    const db = setup();
    const api = fakeSlackApi();
    api.conversations.set(SHARED, conversation(SHARED, { is_ext_shared: true }));
    await discover(db, api);
    storeThread(db, SHARED_THREAD, SHARED);
    api.conversations.set(SHARED, conversation(SHARED));
    const later = await discover(db, api, NOW + 1);
    expect(later.discovery.excluded.find((c) => c.id === SHARED)?.policySource).toBe('platform_boundary');
    expect(getChannel(db, SHARED)).toMatchObject({ ingest_enabled: 0, visibility_class: 'excluded', platform_boundary: 'excluded' });
    expect(getChannel(db, SHARED_THREAD)).toMatchObject({ ingest_enabled: 0, visibility_class: 'excluded' });
  });

  it('excludes a channel that becomes shared between two runs', async () => {
    const db = setup();
    const api = fakeSlackApi();
    api.conversations.set(MEMBER, conversation(MEMBER));
    await discover(db, api);
    storeThread(db, THREAD, MEMBER);
    api.conversations.set(MEMBER, conversation(MEMBER, { is_pending_ext_shared: true }));
    await discover(db, api, NOW + 1);
    expect(getChannel(db, MEMBER)).toMatchObject({ visibility_class: 'excluded', platform_boundary: 'excluded' });
    expect(getChannel(db, THREAD)).toMatchObject({ visibility_class: 'excluded' });
  });
});
