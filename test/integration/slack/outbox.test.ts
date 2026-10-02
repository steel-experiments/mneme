// ABOUTME: Tests Slack outbox delivery: targets, thread roots, fail-closed refusals, and error mapping.
// ABOUTME: Uses the spike fixtures for stored messages and a fake Web API at the network boundary.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { BOT_USER, conversation, fakeSlackApi, seedSlackWorkspace, slackPlatformError, slackTestConfig, TEAM } from '../../helpers/slack.js';
import { parseChannelPolicy } from '../../../src/policy/channel-policy.js';
import { runStartupSync } from '../../../src/ingestion/sync.js';
import { createLiveIngestionDeps } from '../../../src/ingestion/live.js';
import { createLogger } from '../../../src/logger.js';
import { createCounters } from '../../../src/observability.js';
import type { BootstrapContext } from '../../../src/bootstrap.js';
import { excludeSharedChannel } from '../../../src/platform/slack/channels.js';
import { listSlackChannels } from '../../../src/platform/slack/discovery.js';
import { handleSlackEnvelope, type SlackLiveContext } from '../../../src/platform/slack/events.js';
import type { SlackEnvelope } from '../../../src/platform/slack/connection.js';
import { slackFormat } from '../../../src/platform/slack/format.js';
import { createSlackSender, OUTBOX_METADATA_EVENT_TYPE } from '../../../src/platform/slack/sender.js';
import { PermanentJobError, TransientJobError } from '../../../src/jobs/errors.js';

const PUBLIC = 'C0000000001';
const PRIVATE = 'C0000000002';
const ROOT = `${PUBLIC}-1790933759.217369`;
const REPLY = `${PUBLIC}-1790933763.089139`;
const THREAD = `${PUBLIC}-T1790933759.217369`;
const NOW = 1_790_934_200_000;
const FIXTURES = fileURLToPath(new URL('../../fixtures/slack/events/', import.meta.url));
const POLICY = parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: org
  allow_interventions: true
channels: {}
`);

function fixture(prefix: string): SlackEnvelope {
  const name = readdirSync(FIXTURES).find((f) => f.startsWith(`${prefix}-`))!;
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as SlackEnvelope;
}

describe('Slack outbox sender', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  async function setup() {
    t = createTestDb();
    const db = t.db;
    seedSlackWorkspace(db);
    const api = fakeSlackApi();
    api.conversations.set(PUBLIC, conversation(PUBLIC));
    api.conversations.set(PRIVATE, conversation(PRIVATE, { is_private: true }));
    await runStartupSync({ db, guildId: TEAM, policy: POLICY, now: NOW, completeThreadSnapshot: true,
      channels: await listSlackChannels(api, db, TEAM), enqueueHistoricalBackfill: false });
    const ctx = {
      config: slackTestConfig(), db, logger: createLogger({ level: 'silent' }), counters: createCounters(),
      now: () => NOW, snapshot: { channelPolicy: POLICY }, format: slackFormat,
    } as unknown as BootstrapContext;
    const live: SlackLiveContext = {
      workspaceId: TEAM, selfUserId: BOT_USER, api, deps: createLiveIngestionDeps(ctx, BOT_USER),
      enqueueHistory: false, seenSubtypes: new Set(),
    };
    // The root and one reply, so the thread row exists.
    for (const p of ['11', '12']) await handleSlackEnvelope(live, fixture(p));
    const sender = createSlackSender({ api, db: () => db, teamDomain: () => 'acme' });
    return { db, api, sender };
  }

  it('posts a top-level message with the dedupe marker and no forbidden parameter', async () => {
    const { api, sender } = await setup();
    const result = await sender.send({ channelId: PUBLIC, content: 'Hello **team** <!here>', dedupeMarker: 'm-1' });
    expect(result.platformMessageId).toBe(`${PUBLIC}-${api.posted[0]!.ts}`);
    const post = api.posted[0]!;
    expect(post.channel).toBe(PUBLIC);
    expect(post.thread_ts).toBeUndefined();
    expect(post.text).toBe('Hello *team* &lt;!here&gt;');
    expect(post.metadata).toEqual({ event_type: OUTBOX_METADATA_EVENT_TYPE, event_payload: { marker: 'm-1' } });
    for (const key of ['link_names', 'reply_broadcast', 'username', 'icon_url', 'icon_emoji']) {
      expect(post).not.toHaveProperty(key);
    }
  });

  it('posts into the thread for a thread-row target', async () => {
    const { api, sender } = await setup();
    await sender.send({ channelId: THREAD, content: 'In the thread' });
    expect(api.posted[0]).toMatchObject({ channel: PUBLIC, thread_ts: '1790933759.217369' });
  });

  it('replies to a top-level anchor in a new thread under the anchor', async () => {
    const { api, sender } = await setup();
    await sender.send({ channelId: PUBLIC, content: 'Reply', replyToMessageId: ROOT });
    expect(api.posted[0]).toMatchObject({ channel: PUBLIC, thread_ts: '1790933759.217369' });
  });

  it('replies to an anchor in a thread under the thread root', async () => {
    const { api, sender } = await setup();
    await sender.send({ channelId: THREAD, content: 'Reply', replyToMessageId: REPLY });
    expect(api.posted[0]).toMatchObject({ channel: PUBLIC, thread_ts: '1790933759.217369' });
  });

  it('refuses an anchor in another channel and posts nothing', async () => {
    const { api, sender } = await setup();
    await expect(sender.send({ channelId: PRIVATE, content: 'Reply', replyToMessageId: ROOT }))
      .rejects.toBeInstanceOf(PermanentJobError);
    expect(api.posted).toHaveLength(0);
  });

  it('refuses a Slack Connect channel and its threads and posts nothing', async () => {
    const { db, api, sender } = await setup();
    excludeSharedChannel(db, PUBLIC, NOW + 1);
    await expect(sender.send({ channelId: PUBLIC, content: 'x' })).rejects.toBeInstanceOf(PermanentJobError);
    await expect(sender.send({ channelId: THREAD, content: 'x' })).rejects.toBeInstanceOf(PermanentJobError);
    expect(api.posted).toHaveLength(0);
  });

  it('refuses an unknown or archived channel', async () => {
    const { db, api, sender } = await setup();
    await expect(sender.send({ channelId: 'C0000000099', content: 'x' })).rejects.toBeInstanceOf(PermanentJobError);
    db.prepare('UPDATE channels SET is_archived = 1 WHERE id = ?').run(PRIVATE);
    await expect(sender.send({ channelId: PRIVATE, content: 'x' })).rejects.toBeInstanceOf(PermanentJobError);
    expect(api.posted).toHaveLength(0);
  });

  it.each([
    ['channel_not_found', PermanentJobError],
    ['not_in_channel', PermanentJobError],
    ['is_archived', PermanentJobError],
    ['invalid_auth', PermanentJobError],
    ['account_inactive', PermanentJobError],
    ['missing_scope', PermanentJobError],
    ['ratelimited', TransientJobError],
    ['internal_error', TransientJobError],
  ])('maps %s to the right job error', async (code, kind) => {
    const { api, sender } = await setup();
    api.failures.set('postMessage', [slackPlatformError(code)]);
    await expect(sender.send({ channelId: PUBLIC, content: 'x' })).rejects.toBeInstanceOf(kind);
  });

  it('treats a network failure as transient', async () => {
    const { api, sender } = await setup();
    api.failures.set('postMessage', [new Error('socket hang up')]);
    await expect(sender.send({ channelId: PUBLIC, content: 'x' })).rejects.toBeInstanceOf(TransientJobError);
  });
});
