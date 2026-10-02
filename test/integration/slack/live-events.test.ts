// ABOUTME: Feeds the spike fixtures through the Slack live-event handler (plan 006 step 6).
// ABOUTME: Checks stored rows, thread rows, non-edit updates, the Slack Connect boundary, and the bot leaving.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { BOT_USER, conversation, fakeSlackApi, seedSlackWorkspace, slackTestConfig, TEAM } from '../../helpers/slack.js';
import { parseChannelPolicy } from '../../../src/policy/channel-policy.js';
import { runStartupSync } from '../../../src/ingestion/sync.js';
import { createLiveIngestionDeps } from '../../../src/ingestion/live.js';
import { createLogger } from '../../../src/logger.js';
import { createCounters } from '../../../src/observability.js';
import type { BootstrapContext } from '../../../src/bootstrap.js';
import { getChannel } from '../../../src/db/repositories/channels.js';
import { getMessage } from '../../../src/db/repositories/messages.js';
import { listSlackChannels } from '../../../src/platform/slack/discovery.js';
import { handleSlackEnvelope, type SlackLiveContext } from '../../../src/platform/slack/events.js';
import { attachSocket, SlackHealthTracker, type SlackEnvelope } from '../../../src/platform/slack/connection.js';
import { slackFormat } from '../../../src/platform/slack/format.js';

const PUBLIC = 'C0000000001';
const PRIVATE = 'C0000000002';
const NOW = 1_790_934_200_000;
const FIXTURES = fileURLToPath(new URL('../../fixtures/slack/events/', import.meta.url));

const POLICY = parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: org
  allow_interventions: false
channels: {}
`);

function fixture(prefix: string): SlackEnvelope {
  const name = readdirSync(FIXTURES).find((f) => f.startsWith(`${prefix}-`))!;
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as SlackEnvelope;
}

describe('Slack live events', () => {
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
    const feed = async (...prefixes: string[]) => {
      const out = [];
      for (const p of prefixes) out.push(await handleSlackEnvelope(live, fixture(p)));
      return out;
    };
    return { db, api, live, feed };
  }

  it('stores, edits, and deletes a top-level message', async () => {
    const { db, feed } = await setup();
    await feed('08');
    expect(getMessage(db, `${PUBLIC}-1790933741.610379`)).toMatchObject({ channel_id: PUBLIC, deleted_at_ms: null });
    await feed('09');
    expect(getMessage(db, `${PUBLIC}-1790933741.610379`)?.edited_at_ms).not.toBeNull();
    await feed('10');
    const deleted = getMessage(db, `${PUBLIC}-1790933741.610379`);
    expect(deleted === undefined || deleted.deleted_at_ms !== null).toBe(true);
  });

  it('creates the thread row on the first reply and stores replies in it', async () => {
    const { db, feed } = await setup();
    await feed('11', '12');
    const thread = `${PUBLIC}-T1790933759.217369`;
    expect(getChannel(db, thread)).toMatchObject({ parent_id: PUBLIC, is_thread: 1, kind: 'thread', visibility_class: 'org' });
    expect(getMessage(db, `${PUBLIC}-1790933763.089139`)?.channel_id).toBe(thread);
    const [edit, del, rootUpdate] = await feed('13', '14', '15');
    expect(edit?.handled).toBe(true);
    expect(del?.handled).toBe(true);
    expect(rootUpdate).toEqual({ handled: false, reason: 'not_an_edit' });
  });

  it('stores a private-channel reply in its thread', async () => {
    const { db, feed } = await setup();
    await feed('04', '26');
    expect(getMessage(db, `${PRIVATE}-1790933865.512029`)?.channel_id).toBe(`${PRIVATE}-T1790933653.365189`);
  });

  it('stores a broadcast reply once, in the thread, and ignores the repeat update', async () => {
    const { db, feed } = await setup();
    const results = await feed('38', '40', '41', '42');
    expect(getMessage(db, `${PUBLIC}-1790934092.555719`)?.channel_id).toBe(`${PUBLIC}-T1790934079.184319`);
    expect(results[2]).toEqual({ handled: false, reason: 'not_an_edit' });
    expect(results[3]?.handled).toBe(true);
  });

  it('resolves a reaction on a reply to the stored message', async () => {
    const { db, feed } = await setup();
    const [, , reaction] = await feed('11', '20', '21');
    expect(reaction?.handled).toBe(true);
    const row = db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').get(`${PUBLIC}-1790933803.455219`) as { n: number };
    expect(row.n).toBe(1);
  });

  it('ignores channel-event messages and drops a foreign team', async () => {
    const { feed, live } = await setup();
    expect((await feed('03'))[0]).toEqual({ handled: false, reason: 'ignored_subtype' });
    const foreign = fixture('08');
    foreign.body = { ...foreign.body, team_id: 'T0000000099' };
    expect(await handleSlackEnvelope(live, foreign)).toEqual({ handled: false, reason: 'team_mismatch' });
  });

  it('drops events from a channel that is not known', async () => {
    const { live } = await setup();
    const env = fixture('08');
    env.body = { ...env.body, event: { ...(env.body.event as object), channel: 'C0000000077' } };
    expect(await handleSlackEnvelope(live, env)).toEqual({ handled: false, reason: 'unknown_channel' });
  });

  it('excludes a channel and its threads at once when it becomes shared', async () => {
    const { db, api, live, feed } = await setup();
    await feed('11', '12');
    api.conversations.set(PUBLIC, conversation(PUBLIC, { is_ext_shared: true }));
    await handleSlackEnvelope(live, { type: 'events_api', body: { team_id: TEAM, event: { type: 'channel_shared', channel: PUBLIC } } });
    expect(getChannel(db, PUBLIC)).toMatchObject({ visibility_class: 'excluded', platform_boundary: 'excluded' });
    expect(getChannel(db, `${PUBLIC}-T1790933759.217369`)).toMatchObject({ visibility_class: 'excluded' });
    const next = fixture('16');
    expect((await handleSlackEnvelope(live, next)).reason).toBe('policy');
  });

  it('excludes a shared channel and its threads before the channel re-read, even when the re-read fails', async () => {
    const { db, api, live, feed } = await setup();
    await feed('11', '12');
    const rateLimited = Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error' });
    api.failures.set('conversationInfo', [rateLimited]);
    const outcome = await handleSlackEnvelope(live, { type: 'events_api', body: { team_id: TEAM, event: { type: 'channel_shared', channel: PUBLIC } } });
    expect(outcome.handled).toBe(true);
    expect(getChannel(db, PUBLIC)).toMatchObject({ platform_boundary: 'excluded', ingest_enabled: 0, visibility_class: 'excluded' });
    expect(getChannel(db, `${PUBLIC}-T1790933759.217369`)).toMatchObject({ platform_boundary: 'excluded', ingest_enabled: 0, visibility_class: 'excluded' });
  });

  it('excludes the channel from a shared-channel envelope when the re-read fails', async () => {
    const { db, api, live, feed } = await setup();
    await feed('11', '12');
    api.failures.set('conversationInfo', [new Error('socket hang up')]);
    const env = fixture('16');
    env.body = { ...env.body, is_ext_shared_channel: true };
    expect(await handleSlackEnvelope(live, env)).toEqual({ handled: false, reason: 'shared_channel' });
    expect(getChannel(db, PUBLIC)).toMatchObject({ platform_boundary: 'excluded', ingest_enabled: 0 });
    expect(getChannel(db, `${PUBLIC}-T1790933759.217369`)).toMatchObject({ platform_boundary: 'excluded', ingest_enabled: 0 });
  });

  it('keeps a channel excluded after channel_unshared', async () => {
    const { db, api, live, feed } = await setup();
    await feed('11', '12');
    api.conversations.set(PUBLIC, conversation(PUBLIC, { is_ext_shared: true }));
    await handleSlackEnvelope(live, { type: 'events_api', body: { team_id: TEAM, event: { type: 'channel_shared', channel: PUBLIC } } });
    api.conversations.set(PUBLIC, conversation(PUBLIC));
    await handleSlackEnvelope(live, { type: 'events_api', body: { team_id: TEAM, event: { type: 'channel_unshared', channel: PUBLIC } } });
    expect(getChannel(db, PUBLIC)).toMatchObject({ platform_boundary: 'excluded', ingest_enabled: 0, visibility_class: 'excluded' });
    expect(getChannel(db, `${PUBLIC}-T1790933759.217369`)).toMatchObject({ platform_boundary: 'excluded', ingest_enabled: 0 });
    expect((await handleSlackEnvelope(live, fixture('16'))).reason).toBe('policy');
  });

  it('drops content flagged as coming from a shared channel', async () => {
    const { db, api, live } = await setup();
    api.conversations.set(PUBLIC, conversation(PUBLIC, { is_ext_shared: true }));
    const env = fixture('08');
    env.body = { ...env.body, is_ext_shared_channel: true };
    expect(await handleSlackEnvelope(live, env)).toEqual({ handled: false, reason: 'shared_channel' });
    expect(getMessage(db, `${PUBLIC}-1790933741.610379`)).toBeUndefined();
    expect(getChannel(db, PUBLIC)?.platform_boundary).toBe('excluded');
  });

  it('makes the channel and its threads unavailable when the bot leaves, and restores them on rejoin', async () => {
    const { db, api, feed } = await setup();
    await feed('11', '12');
    await feed('35');
    expect(getChannel(db, PUBLIC)).toMatchObject({ ingest_enabled: 0, visibility_class: 'excluded' });
    expect(getChannel(db, `${PUBLIC}-T1790933759.217369`)).toMatchObject({ ingest_enabled: 0, visibility_class: 'excluded' });
    api.conversations.set(PUBLIC, conversation(PUBLIC));
    await feed('36');
    expect(getChannel(db, PUBLIC)).toMatchObject({ ingest_enabled: 1, visibility_class: 'org' });
    expect(getChannel(db, `${PUBLIC}-T1790933759.217369`)).toMatchObject({ ingest_enabled: 1, visibility_class: 'org' });
  });
});

describe('Slack socket attachment', () => {
  it('acknowledges every envelope before its work, in arrival order', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      on: (event: string, fn: (...args: unknown[]) => void) => listeners.set(event, fn),
      start: async () => undefined,
      disconnect: async () => undefined,
    };
    const order: string[] = [];
    const tracker = new SlackHealthTracker(() => 5);
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    attachSocket(socket, tracker, async (envelope) => {
      order.push(`handle:${String(envelope.body.n)}`);
      if (envelope.body.n === 2) done();
    }, () => undefined);
    listeners.get('connected')!();
    for (const n of [1, 2]) {
      listeners.get('slack_event')!({ type: 'events_api', body: { n }, ack: async () => { order.push(`ack:${n}`); } });
    }
    await finished;
    expect(order.indexOf('ack:1')).toBeLessThan(order.indexOf('handle:1'));
    expect(order.indexOf('handle:1')).toBeLessThan(order.indexOf('handle:2'));
    expect(tracker.snapshot()).toMatchObject({ ready: true, lastEventAtMs: 5, reconnects: 0 });
    listeners.get('disconnected')!();
    listeners.get('connected')!();
    expect(tracker.snapshot().reconnects).toBe(1);
  });
});
