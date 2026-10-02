// ABOUTME: Tests Slack reconcile for channels and threads (plan 006 step 8).
// ABOUTME: A thread with replies newer than the stored ones is re-read; a thread without new replies is not.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { BOT_USER, conversation, fakeSlackApi, seedSlackWorkspace, TEAM } from '../../helpers/slack.js';
import { parseChannelPolicy } from '../../../src/policy/channel-policy.js';
import { runStartupSync } from '../../../src/ingestion/sync.js';
import { backfillChannel } from '../../../src/ingestion/backfill.js';
import { reconcileChannel } from '../../../src/ingestion/reconcile.js';
import type { IngestOptions } from '../../../src/ingestion/ingest.js';
import { resolveObservedChannelPolicy } from '../../../src/policy/channel-policy-review-service.js';
import type { ChannelUpsertInput } from '../../../src/db/repositories/channels.js';
import { getMessage } from '../../../src/db/repositories/messages.js';
import { listSlackChannels } from '../../../src/platform/slack/discovery.js';
import { createSlackHistory } from '../../../src/platform/slack/history.js';
import { RECONCILE_CHANNEL_KEY } from '../../../src/jobs/scheduler.js';

const C = 'C0000000001';
const ROOT = '1790939000.000100';
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

describe('Slack reconcile', () => {
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
      const r = resolveObservedChannelPolicy(db, POLICY, { id: input.id, guildId: input.guildId, parentId: input.parentId,
        isThread: input.isThread, kind: input.kind, platformBoundary: input.platformBoundary });
      return { ...input, ingestEnabled: r.rule.ingest, visibilityClass: r.rule.visibility, allowInterventions: r.rule.allow_interventions };
    };
    const fetcher = createSlackHistory({ api, workspaceId: TEAM, selfUserId: () => BOT_USER, db: () => db,
      applyChannelPolicy: () => apply, enqueueHistory: true, now: () => NOW });
    const opts: IngestOptions = { guildId: TEAM, storeRawJson: false, retainEditHistory: false,
      retainDeletedContent: false, attachmentMode: 'metadata', now: NOW };
    const reconcileJobs = () => (db.prepare("SELECT unique_key FROM jobs WHERE type = 'reconcile_channel'").all() as Array<{ unique_key: string }>)
      .map((j) => j.unique_key);
    // Import the channel and the thread once, as at startup.
    const root = msg(ROOT, { thread_ts: ROOT, reply_count: 1, latest_reply: '1790939000.000200' });
    api.channelMessages.set(C, [root]);
    api.threadMessages.set(`${C}:${ROOT}`, [root, msg('1790939000.000200', { thread_ts: ROOT })]);
    await backfillChannel({ db, opts, fetcher, channelId: C });
    await backfillChannel({ db, opts, fetcher, channelId: THREAD });
    return { db, api, fetcher, opts, reconcileJobs, root };
  }

  it('does not re-read a thread that has no new replies', async () => {
    const { db, fetcher, opts, reconcileJobs } = await setup();
    await reconcileChannel({ db, opts, fetcher, channelId: C });
    expect(reconcileJobs()).not.toContain(RECONCILE_CHANNEL_KEY(THREAD));
  });

  it('queues a thread re-read for replies made during downtime, and the re-read stores them', async () => {
    const { db, api, fetcher, opts, reconcileJobs, root } = await setup();
    const newer = { ...root, reply_count: 2, latest_reply: '1790939000.000300' };
    api.channelMessages.set(C, [newer]);
    api.threadMessages.set(`${C}:${ROOT}`, [newer, msg('1790939000.000200', { thread_ts: ROOT }), msg('1790939000.000300', { thread_ts: ROOT })]);
    await reconcileChannel({ db, opts, fetcher, channelId: C });
    expect(reconcileJobs()).toContain(RECONCILE_CHANNEL_KEY(THREAD));
    await reconcileChannel({ db, opts, fetcher, channelId: THREAD });
    expect(getMessage(db, `${C}-1790939000.000300`)?.channel_id).toBe(THREAD);
  });

  it('applies a reply edit made during downtime when the thread is reconciled', async () => {
    const { db, api, fetcher, opts, root } = await setup();
    api.threadMessages.set(`${C}:${ROOT}`, [root, msg('1790939000.000200', { thread_ts: ROOT, text: 'edited while offline',
      edited: { user: 'U0000000001', ts: '1790939500.000100' } })]);
    await reconcileChannel({ db, opts: { ...opts, now: NOW + 1 }, fetcher, channelId: THREAD });
    expect(getMessage(db, `${C}-1790939000.000200`)).toMatchObject({ content: 'edited while offline' });
  });
});
