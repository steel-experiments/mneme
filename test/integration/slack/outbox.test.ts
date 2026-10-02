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
import { createSlackRecentSentLookup } from '../../../src/platform/slack/recent-sent.js';
import { claimOutboxForSending, enqueueOutbox, getOutbox } from '../../../src/outbox/repository.js';
import { reconcileOutboxSending } from '../../../src/outbox/recovery.js';

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

/** A database with two member channels, one thread root, and one reply. */
async function seedSlack(db: TestDb['db'], api: ReturnType<typeof fakeSlackApi>): Promise<void> {
  seedSlackWorkspace(db);
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
  for (const p of ['11', '12']) await handleSlackEnvelope(live, fixture(p));
}

describe('Slack outbox sender', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  async function setup() {
    t = createTestDb();
    const db = t.db;
    const api = fakeSlackApi();
    await seedSlack(db, api);
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

describe('Slack outbox crash recovery', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  async function setup() {
    t = createTestDb();
    const db = t.db;
    const api = fakeSlackApi();
    await seedSlack(db, api);
    db.prepare(`INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
      VALUES ('run-1', ?, NULL, 'episode', 'pv', 'faux', 'faux-1', 'completed', ?)`).run(TEAM, NOW);
    const sending = (channelId: string) => {
      const { outboxId } = enqueueOutbox(db, { proposalId: null, runId: 'run-1', channelId, content: 'hi', now: NOW });
      claimOutboxForSending(db, outboxId, NOW);
      return { id: outboxId, marker: getOutbox(db, outboxId)!.dedupeMarker! };
    };
    const lookup = createSlackRecentSentLookup(api, () => BOT_USER, () => db);
    return { db, api, sending, lookup };
  }

  const botMessage = (ts: string, marker: string, user = BOT_USER) => ({
    ts, user, bot_id: 'B0000000001', text: 'hi',
    metadata: { event_type: OUTBOX_METADATA_EVENT_TYPE, event_payload: { marker } },
  });

  it('marks a sending row sent when its marker is found, with no new post', async () => {
    const { db, api, sending, lookup } = await setup();
    const row = sending(PUBLIC);
    api.channelMessages.set(PUBLIC, [botMessage('1790934100.000100', row.marker)]);
    const report = await reconcileOutboxSending(db, lookup, { now: NOW + 60_000 });
    expect(report.confirmed).toBe(1);
    expect(getOutbox(db, row.id)).toMatchObject({ status: 'sent', platformMessageId: `${PUBLIC}-1790934100.000100` });
    expect(api.posted).toHaveLength(0);
  });

  it('looks in the thread for a thread-row target', async () => {
    const { db, api, sending, lookup } = await setup();
    const row = sending(THREAD);
    api.threadMessages.set(`${PUBLIC}:1790933759.217369`, [
      { ts: '1790933759.217369', user: 'U0000000001', text: 'root' },
      botMessage('1790934100.000200', row.marker),
    ]);
    const report = await reconcileOutboxSending(db, lookup, { now: NOW + 60_000 });
    expect(report.confirmed).toBe(1);
    expect(getOutbox(db, row.id)?.platformMessageId).toBe(`${PUBLIC}-1790934100.000200`);
  });

  it('finds a reply that started a new thread under a top-level anchor, with no new post', async () => {
    const { db, api, lookup } = await setup();
    const { outboxId } = enqueueOutbox(db, { proposalId: null, runId: 'run-1', channelId: PUBLIC, content: 'hi',
      replyToMessageId: ROOT, now: NOW });
    claimOutboxForSending(db, outboxId, NOW);
    const marker = getOutbox(db, outboxId)!.dedupeMarker!;
    api.threadMessages.set(`${PUBLIC}:1790933759.217369`, [
      { ts: '1790933759.217369', user: 'U0000000001', text: 'root' },
      botMessage('1790934100.000300', marker),
    ]);
    const report = await reconcileOutboxSending(db, lookup, { now: NOW + 60_000 });
    expect(report).toMatchObject({ confirmed: 1, requeued: 0 });
    expect(getOutbox(db, outboxId)).toMatchObject({ status: 'sent', platformMessageId: `${PUBLIC}-1790934100.000300` });
    expect(api.posted).toHaveLength(0);
  });

  it('finds a reply to an anchor inside a thread under the thread root', async () => {
    const { db, api, lookup } = await setup();
    const { outboxId } = enqueueOutbox(db, { proposalId: null, runId: 'run-1', channelId: PUBLIC, content: 'hi',
      replyToMessageId: REPLY, now: NOW });
    claimOutboxForSending(db, outboxId, NOW);
    const marker = getOutbox(db, outboxId)!.dedupeMarker!;
    api.threadMessages.set(`${PUBLIC}:1790933759.217369`, [botMessage('1790934100.000400', marker)]);
    const report = await reconcileOutboxSending(db, lookup, { now: NOW + 60_000 });
    expect(report.confirmed).toBe(1);
  });

  it('requeues a row whose marker is not found after a complete lookup', async () => {
    const { db, api, sending, lookup } = await setup();
    const row = sending(PUBLIC);
    api.channelMessages.set(PUBLIC, [botMessage('1790934100.000100', 'another-marker')]);
    const report = await reconcileOutboxSending(db, lookup, { now: NOW + 60_000 });
    expect(report.requeued).toBe(1);
    expect(getOutbox(db, row.id)?.status).toBe('queued');
  });

  it('ignores a message from another bot that carries the same marker', async () => {
    const { db, api, sending, lookup } = await setup();
    const row = sending(PUBLIC);
    api.channelMessages.set(PUBLIC, [botMessage('1790934100.000100', row.marker, 'U0000000077')]);
    const report = await reconcileOutboxSending(db, lookup, { now: NOW + 60_000 });
    expect(report.confirmed).toBe(0);
    expect(getOutbox(db, row.id)?.status).toBe('queued');
  });

  it('leaves the row sending when the lookup fails', async () => {
    const { db, api, sending, lookup } = await setup();
    const row = sending(PUBLIC);
    api.failures.set('history', [new Error('socket hang up')]);
    const report = await reconcileOutboxSending(db, lookup, { now: NOW + 60_000 });
    expect(report.errored).toBe(1);
    expect(getOutbox(db, row.id)?.status).toBe('sending');
  });

  it('returns no messages for a channel that is gone', async () => {
    const { api, lookup } = await setup();
    api.failures.set('history', [slackPlatformError('channel_not_found')]);
    await expect(lookup.fetch(PUBLIC, NOW)).resolves.toEqual([]);
  });
});
