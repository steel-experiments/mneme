// ABOUTME: Tests Slack history import: channel pages, thread jobs, replies without the root, and resume.
// ABOUTME: Plan 006 step 7; recorded-shape pages come from a Web API test double.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { BOT_USER, conversation, fakeSlackApi, seedSlackWorkspace, TEAM } from '../../helpers/slack.js';
import { parseChannelPolicy } from '../../../src/policy/channel-policy.js';
import { runStartupSync } from '../../../src/ingestion/sync.js';
import { backfillChannel } from '../../../src/ingestion/backfill.js';
import { reconcileChannel } from '../../../src/ingestion/reconcile.js';
import { excludeSharedChannel } from '../../../src/platform/slack/channels.js';
import type { IngestOptions } from '../../../src/ingestion/ingest.js';
import { resolveObservedChannelPolicy } from '../../../src/policy/channel-policy-review-service.js';
import type { ChannelUpsertInput } from '../../../src/db/repositories/channels.js';
import { getMessage } from '../../../src/db/repositories/messages.js';
import { getSyncCursor } from '../../../src/db/repositories/sync-cursors.js';
import { listSlackChannels } from '../../../src/platform/slack/discovery.js';
import { createSlackHistory } from '../../../src/platform/slack/history.js';
import { MAX_RATE_LIMIT_RETRIES, withRateLimitRetry } from '../../../src/platform/slack/api.js';

const C = 'C0000000001';
const ROOT = '1790930000.000100';
const THREAD = `${C}-T${ROOT}`;
const NOW = 1_790_940_000_000;
const POLICY = parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: org
  allow_interventions: false
channels: {}
`);

const msg = (ts: string, over: Record<string, unknown> = {}) => ({ type: 'message', user: 'U0000000001', ts, text: `m${ts}`, ...over });

describe('Slack backfill', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  async function setup() {
    t = createTestDb();
    const db = t.db;
    seedSlackWorkspace(db);
    const api = fakeSlackApi();
    api.conversations.set(C, conversation(C));
    await runStartupSync({ db, guildId: TEAM, policy: POLICY, now: NOW, completeThreadSnapshot: true,
      channels: await listSlackChannels(api, db, TEAM), enqueueHistoricalBackfill: false });
    const apply = (input: ChannelUpsertInput): ChannelUpsertInput => {
      const resolved = resolveObservedChannelPolicy(db, POLICY, { id: input.id, guildId: input.guildId,
        parentId: input.parentId, isThread: input.isThread, kind: input.kind, platformBoundary: input.platformBoundary });
      return { ...input, ingestEnabled: resolved.rule.ingest, visibilityClass: resolved.rule.visibility,
        allowInterventions: resolved.rule.allow_interventions };
    };
    const fetcher = createSlackHistory({ api, workspaceId: TEAM, selfUserId: () => BOT_USER, db: () => db,
      applyChannelPolicy: () => apply, enqueueHistory: true, now: () => NOW });
    const opts: IngestOptions = { guildId: TEAM, storeRawJson: false, retainEditHistory: false,
      retainDeletedContent: false, attachmentMode: 'metadata', now: NOW };
    const jobs = (type: string) => db.prepare('SELECT unique_key FROM jobs WHERE type = ?').all(type) as Array<{ unique_key: string }>;
    return { db, api, fetcher, opts, jobs };
  }

  it('imports two pages of channel history newest first and completes', async () => {
    const { db, api, fetcher, opts } = await setup();
    api.channelMessages.set(C, [msg('1790930003.000100'), msg('1790930002.000100'), msg('1790930001.000100')]);
    const result = await backfillChannel({ db, opts, fetcher, channelId: C, pageSize: 2 });
    expect(result.messagesIngested).toBe(3);
    expect(result.historyComplete).toBe(true);
    expect(getMessage(db, `${C}-1790930001.000100`)?.channel_id).toBe(C);
  });

  it('does not commit a page fetched before the channel became shared', async () => {
    const { db, api, fetcher, opts } = await setup();
    api.channelMessages.set(C, [msg('1790930002.000100'), msg('1790930001.000100')]);
    const history = api.history.bind(api);
    api.history = async (input) => {
      const page = await history(input);
      excludeSharedChannel(db, C, NOW);
      return page;
    };
    const result = await backfillChannel({ db, opts, fetcher, channelId: C });
    expect(result.messagesIngested).toBe(0);
    expect(getMessage(db, `${C}-1790930002.000100`)).toBeUndefined();
    expect(getMessage(db, `${C}-1790930001.000100`)).toBeUndefined();
  });

  it('does not commit a reconcile page fetched before the channel became shared', async () => {
    const { db, api, fetcher, opts } = await setup();
    api.channelMessages.set(C, [msg('1790930001.000100')]);
    await backfillChannel({ db, opts, fetcher, channelId: C });
    api.channelMessages.set(C, [msg('1790930009.000100'), msg('1790930001.000100')]);
    const history = api.history.bind(api);
    api.history = async (input) => {
      const page = await history(input);
      excludeSharedChannel(db, C, NOW);
      return page;
    };
    await reconcileChannel({ db, opts: { ...opts, now: NOW + 60_000 }, fetcher, channelId: C });
    expect(getMessage(db, `${C}-1790930009.000100`)).toBeUndefined();
  });

  it('excludes the channel and commits nothing when a channel page has a message from another team', async () => {
    const { db, api, fetcher, opts } = await setup();
    api.channelMessages.set(C, [msg('1790930002.000100', { team: 'T0000000099' }), msg('1790930001.000100', { team: TEAM })]);
    const result = await backfillChannel({ db, opts, fetcher, channelId: C });
    expect(result.messagesIngested).toBe(0);
    expect(result.historyComplete).toBe(false);
    expect(getMessage(db, `${C}-1790930002.000100`)).toBeUndefined();
    expect(getMessage(db, `${C}-1790930001.000100`)).toBeUndefined();
    const row = db.prepare('SELECT platform_boundary, ingest_enabled, visibility_class FROM channels WHERE id = ?').get(C);
    expect(row).toEqual({ platform_boundary: 'excluded', ingest_enabled: 0, visibility_class: 'excluded' });
  });

  it.each(['user_team', 'source_team'])('treats a foreign %s in a reconcile page as a share', async (field) => {
    const { db, api, fetcher, opts } = await setup();
    api.channelMessages.set(C, [msg('1790930001.000100')]);
    await backfillChannel({ db, opts, fetcher, channelId: C });
    api.channelMessages.set(C, [msg('1790930009.000100', { [field]: 'T0000000099' }), msg('1790930001.000100')]);
    await reconcileChannel({ db, opts: { ...opts, now: NOW + 60_000 }, fetcher, channelId: C });
    expect(getMessage(db, `${C}-1790930009.000100`)).toBeUndefined();
    expect((db.prepare('SELECT platform_boundary FROM channels WHERE id = ?').get(C) as { platform_boundary: string }).platform_boundary)
      .toBe('excluded');
  });

  it('excludes the parent channel and its thread when a thread page has a reply from another team', async () => {
    const { db, api, fetcher, opts } = await setup();
    const root = msg(ROOT, { thread_ts: ROOT, reply_count: 2, latest_reply: '1790930000.000300' });
    api.channelMessages.set(C, [root]);
    api.threadMessages.set(`${C}:${ROOT}`, [root, msg('1790930000.000200', { thread_ts: ROOT }),
      msg('1790930000.000300', { thread_ts: ROOT, user_team: 'T0000000099' })]);
    await backfillChannel({ db, opts, fetcher, channelId: C });
    const thread = await backfillChannel({ db, opts, fetcher, channelId: THREAD });
    expect(thread.messagesIngested).toBe(0);
    expect(getMessage(db, `${C}-1790930000.000200`)).toBeUndefined();
    const rows = db.prepare('SELECT id, platform_boundary FROM channels WHERE id IN (?, ?) ORDER BY id').all(C, THREAD);
    expect(rows).toEqual([{ id: C, platform_boundary: 'excluded' }, { id: THREAD, platform_boundary: 'excluded' }]);
  });

  it('returns no message and excludes the channel when a single fetched message is from another team', async () => {
    const { db, api, fetcher } = await setup();
    api.channelMessages.set(C, [msg('1790930001.000100', { team: 'T0000000099' })]);
    expect(await fetcher.fetchMessage!(C, `${C}-1790930001.000100`)).toBeNull();
    expect((db.prepare('SELECT platform_boundary FROM channels WHERE id = ?').get(C) as { platform_boundary: string }).platform_boundary)
      .toBe('excluded');
  });

  it('queues one thread job for a root with replies, then stores the replies without the root', async () => {
    const { db, api, fetcher, opts, jobs } = await setup();
    const root = msg(ROOT, { thread_ts: ROOT, reply_count: 2, latest_reply: '1790930000.000300' });
    api.channelMessages.set(C, [root]);
    api.threadMessages.set(`${C}:${ROOT}`, [root, msg('1790930000.000200', { thread_ts: ROOT }), msg('1790930000.000300', { thread_ts: ROOT })]);
    await backfillChannel({ db, opts, fetcher, channelId: C });
    await backfillChannel({ db, opts, fetcher, channelId: C });
    expect(jobs('backfill_channel').filter((j) => j.unique_key.includes(THREAD))).toHaveLength(1);
    expect(getMessage(db, `${C}-${ROOT}`)?.channel_id).toBe(C);

    const thread = await backfillChannel({ db, opts, fetcher, channelId: THREAD });
    expect(thread.messagesIngested).toBe(2);
    expect(thread.historyComplete).toBe(true);
    expect(getMessage(db, `${C}-1790930000.000300`)?.channel_id).toBe(THREAD);
    const rootRows = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(`${C}-${ROOT}`) as { n: number };
    expect(rootRows.n).toBe(1);
  });

  it('stores a broadcast reply once, in the thread', async () => {
    const { db, api, fetcher, opts } = await setup();
    const root = msg(ROOT, { thread_ts: ROOT, reply_count: 1, latest_reply: '1790930000.000200' });
    const broadcast = msg('1790930000.000200', { subtype: 'thread_broadcast', thread_ts: ROOT });
    api.channelMessages.set(C, [broadcast, root]);
    api.threadMessages.set(`${C}:${ROOT}`, [root, broadcast]);
    const channel = await backfillChannel({ db, opts, fetcher, channelId: C });
    expect(channel.messagesIngested).toBe(1);
    await backfillChannel({ db, opts, fetcher, channelId: THREAD });
    const rows = db.prepare('SELECT channel_id FROM messages WHERE id = ?').all(`${C}-1790930000.000200`) as Array<{ channel_id: string }>;
    expect(rows).toEqual([{ channel_id: THREAD }]);
  });

  it('pages past ignored subtypes so a short page still means the end', async () => {
    const { db, api, fetcher, opts } = await setup();
    api.channelMessages.set(C, [msg('1790930004.000100'), msg('1790930003.000100', { subtype: 'channel_join' }),
      msg('1790930002.000100'), msg('1790930001.000100')]);
    const result = await backfillChannel({ db, opts, fetcher, channelId: C, pageSize: 2 });
    expect(result.messagesIngested).toBe(3);
    expect(result.historyComplete).toBe(true);
  });

  it('resumes from the cursor after a crash between pages', async () => {
    const { db, api, fetcher, opts } = await setup();
    api.channelMessages.set(C, [msg('1790930003.000100'), msg('1790930002.000100'), msg('1790930001.000100')]);
    const original = api.history.bind(api);
    let calls = 0;
    api.history = async (input) => {
      calls += 1;
      if (calls === 2) throw new Error('connection reset');
      return original(input);
    };
    await expect(backfillChannel({ db, opts, fetcher, channelId: C, pageSize: 2 })).rejects.toThrow('connection reset');
    expect(getSyncCursor(db, C)?.nextBeforeMessageId).toBe(`${C}-1790930002.000100`);
    const resumed = await backfillChannel({ db, opts, fetcher, channelId: C, pageSize: 2 });
    expect(resumed.resumed).toBe(true);
    expect(resumed.historyComplete).toBe(true);
    const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(C) as { n: number };
    expect(n.n).toBe(3);
  });
});

describe('Slack rate limits', () => {
  it('waits for Retry-After and then succeeds', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await withRateLimitRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 2 });
      return 'ok';
    }, async (ms) => { waits.push(ms); });
    expect(result).toBe('ok');
    expect(waits).toEqual([2000]);
  });

  it('gives up after the retry bound and lets the job retry', async () => {
    const waits: number[] = [];
    const call = withRateLimitRetry(async () => {
      throw Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error', retryAfter: 1 });
    }, async (ms) => { waits.push(ms); });
    await expect(call).rejects.toThrow('rate limited');
    expect(waits).toHaveLength(MAX_RATE_LIMIT_RETRIES);
  });

  it('does not retry other errors', async () => {
    const waits: number[] = [];
    await expect(withRateLimitRetry(async () => { throw new Error('boom'); }, async (ms) => { waits.push(ms); }))
      .rejects.toThrow('boom');
    expect(waits).toEqual([]);
  });
});
