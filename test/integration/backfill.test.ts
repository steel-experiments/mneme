import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { GUILD, CHANNEL, AUTHOR, NOW, opts } from '../helpers/messages.js';
import { backfillChannel, type BackfillMessageFetcher } from '../../src/discord/backfill.js';
import { createBackfillChannelHandler } from '../../src/jobs/handlers/backfill-channel.js';
import { getSyncCursor } from '../../src/db/repositories/sync-cursors.js';
import { enqueue } from '../../src/jobs/queue.js';
import { JobWorker } from '../../src/jobs/worker.js';

/**
 * Paginated historical backfill (Sections 9.2, 9.5, 11.5).
 */

/** Build a raw snake_case message payload for an id. */
const THREAD_PARENT = '100000000000000020';
const THREAD_CHANNEL = '100000000000000021';

function rawMessage(id: string, content: string, channelId = CHANNEL): Record<string, unknown> {
  return {
    id,
    channel_id: channelId,
    guild_id: GUILD,
    author: { id: AUTHOR, username: 'alice', global_name: 'Alice', bot: false },
    content,
    timestamp: '2024-05-01T12:00:00.000+00:00',
    edited_timestamp: null,
    type: 0,
    flags: 0,
    pinned: false,
    mention_everyone: false,
    mentions: [],
    embeds: [],
    components: [],
    attachments: [],
  };
}

/** Generate N message ids, newest first (descending snowflides of equal length). Built as strings because snowflides exceed Number.MAX_SAFE_INTEGER. */
function makeIds(n: number): string[] {
  const ids: string[] = [];
  for (let i = n; i >= 1; i -= 1) ids.push('300000000000' + String(i).padStart(6, '0'));
  return ids;
}

/**
 * A fake fetcher backed by a fixed id list. `fetchMessages` returns the `limit`
 * messages with id strictly less than `before` (or the newest when before is
 * undefined), newest-first — exactly Discord's `before` pagination semantics.
 */
function makeFetcher(allIds: string[]): BackfillMessageFetcher {
  return {
    async fetchMessages(_channelId: string, before: string | undefined, l: number): Promise<unknown[]> {
      const startIdx = before ? allIds.findIndex((id) => id < before) : 0;
      const slice = startIdx === -1 ? [] : allIds.slice(startIdx, startIdx + l);
      return slice.map((id, idx) => rawMessage(id, `msg-${id}-${idx}`));
    },
  };
}

function countChannelMessages(db: DatabaseSync, channelId = CHANNEL): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(channelId) as { c: number }).c;
}

function seedThread(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO channels (id, guild_id, parent_id, type, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
     VALUES (?, ?, NULL, 0, 'project', 0, 0, 0, 1, 'org', 0, ?, ?)`,
  ).run(THREAD_PARENT, GUILD, NOW, NOW);
  db.prepare(
    `INSERT INTO channels (id, guild_id, parent_id, type, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 11, 'history', 1, 1, 0, 1, 'org', 0, ?, ?)`,
  ).run(THREAD_CHANNEL, GUILD, THREAD_PARENT, NOW, NOW);
}

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

describe('backfillChannel — multi-page', () => {
  it('pages newest-to-oldest and marks history_complete only at the true end', async () => {
    const ids = makeIds(250); // 100 + 100 + 50
    const fetcher = makeFetcher(ids);
    const result = await backfillChannel({ db, opts: opts({ now: NOW }), fetcher, channelId: CHANNEL, pageSize: 100 });

    expect(result.pagesFetched).toBe(3);
    expect(result.messagesIngested).toBe(250);
    expect(result.historyComplete).toBe(true);
    expect(result.resumed).toBe(false);
    expect(result.newestMessageId).toBe(ids[0]);
    expect(result.oldestMessageId).toBe(ids[ids.length - 1]);
    expect(countChannelMessages(db)).toBe(250);

    const cursor = getSyncCursor(db, CHANNEL)!;
    expect(cursor.historyComplete).toBe(true);
    expect(cursor.state).toBe('live');
    expect(cursor.nextBeforeMessageId).toBeNull();
    expect(cursor.newestMessageId).toBe(ids[0]);
    expect(cursor.oldestMessageId).toBe(ids[ids.length - 1]);
    expect(cursor.lastError).toBeNull();
  });

  it('marks an empty channel complete on the first empty page', async () => {
    const fetcher = makeFetcher([]);
    const result = await backfillChannel({ db, opts: opts({ now: NOW }), fetcher, channelId: CHANNEL });
    expect(result.messagesIngested).toBe(0);
    expect(result.historyComplete).toBe(true);
    expect(getSyncCursor(db, CHANNEL)!.historyComplete).toBe(true);
  });

  it('completes when the final partial page returns fewer than the page size', async () => {
    const ids = makeIds(150); // 100 + 50
    const fetcher = makeFetcher(ids);
    const result = await backfillChannel({ db, opts: opts({ now: NOW }), fetcher, channelId: CHANNEL, pageSize: 100 });
    expect(result.pagesFetched).toBe(2);
    expect(result.historyComplete).toBe(true);
    expect(countChannelMessages(db)).toBe(150);
  });

  it('re-ingesting identical history creates no duplicate rows', async () => {
    const ids = makeIds(120);
    const fetcher = makeFetcher(ids);
    await backfillChannel({ db, opts: opts({ now: NOW }), fetcher, channelId: CHANNEL, pageSize: 100 });
    expect(countChannelMessages(db)).toBe(120);

    // A second full backfill over the same history adds nothing.
    const fetcher2 = makeFetcher(ids);
    await backfillChannel({ db, opts: opts({ now: NOW + 1 }), fetcher: fetcher2, channelId: CHANNEL, pageSize: 100 });
    expect(countChannelMessages(db)).toBe(120);
  });
});

describe('backfillChannel — restart resilience', () => {
  it('resumes from the durable cursor without gaps or duplicates', async () => {
    const ids = makeIds(250);

    // First run: stop after one page (e.g. a crash before the next fetch).
    const fetcher1 = makeFetcher(ids);
    const first = await backfillChannel({
      db,
      opts: opts({ now: NOW }),
      fetcher: fetcher1,
      channelId: CHANNEL,
      pageSize: 100,
      maxPages: 1,
    });
    expect(first.pagesFetched).toBe(1);
    expect(first.messagesIngested).toBe(100);
    expect(first.historyComplete).toBe(false);
    expect(countChannelMessages(db)).toBe(100);
    const cursor1 = getSyncCursor(db, CHANNEL)!;
    expect(cursor1.state).toBe('backfilling');
    expect(cursor1.historyComplete).toBe(false);
    expect(cursor1.nextBeforeMessageId).toBe(ids[99]); // oldest of the first page

    // Restart: a fresh process resumes from the persisted cursor.
    const fetcher2 = makeFetcher(ids);
    const second = await backfillChannel({
      db,
      opts: opts({ now: NOW + 1 }),
      fetcher: fetcher2,
      channelId: CHANNEL,
      pageSize: 100,
    });
    expect(second.resumed).toBe(true);
    expect(second.historyComplete).toBe(true);
    expect(second.messagesIngested).toBe(150); // only the remaining pages
    expect(countChannelMessages(db)).toBe(250); // no duplicates, no gaps

    const cursor2 = getSyncCursor(db, CHANNEL)!;
    expect(cursor2.historyComplete).toBe(true);
    expect(cursor2.state).toBe('live');
    expect(cursor2.oldestMessageId).toBe(ids[249]);
    expect(cursor2.newestMessageId).toBe(ids[0]); // newest preserved across restart
  });

  it('retains the cursor and rethrows on a transient fetch failure', async () => {
    const ids = makeIds(250);
    let calls = 0;
    const fetcher: BackfillMessageFetcher = {
      async fetchMessages(_c, _before, limit) {
        calls += 1;
        if (calls === 2) throw new Error('rate limited');
        const slice = ids.slice(0, limit);
        return slice.map((id, idx) => rawMessage(id, `msg-${id}-${idx}`));
      },
    };

    await expect(
      backfillChannel({ db, opts: opts({ now: NOW }), fetcher, channelId: CHANNEL, pageSize: 100 }),
    ).rejects.toThrow('rate limited');

    // Page 1 was committed and the cursor retained; the failure is recorded.
    expect(countChannelMessages(db)).toBe(100);
    const cursor = getSyncCursor(db, CHANNEL)!;
    expect(cursor.state).toBe('error');
    expect(cursor.lastError).toBe('rate limited');
    expect(cursor.nextBeforeMessageId).toBe(ids[99]);
    expect(cursor.retryCount).toBe(1);
  });
});

describe('backfillChannel — malformed payloads', () => {
  it('skips un-normalizable messages without abandoning the page', async () => {
    const ids = makeIds(3);
    const fetcher: BackfillMessageFetcher = {
      async fetchMessages() {
        return [
          rawMessage(ids[0]!, 'good-1'),
          { id: ids[1] /* missing channel_id → normalize throws */ },
          rawMessage(ids[2]!, 'good-3'),
        ];
      },
    };
    const result = await backfillChannel({ db, opts: opts({ now: NOW }), fetcher, channelId: CHANNEL, pageSize: 100 });
    expect(result.messagesIngested).toBe(2);
    expect(result.messagesSkipped).toBe(1);
    expect(result.historyComplete).toBe(true);
    expect(countChannelMessages(db)).toBe(2);
  });
});

describe('backfillChannel — current parent eligibility', () => {
  it('does not mark an empty fetched page complete after the thread parent becomes a test surface', async () => {
    seedThread(db);
    const result = await backfillChannel({
      db,
      opts: opts({ now: NOW }),
      channelId: THREAD_CHANNEL,
      fetcher: {
        async fetchMessages() {
          db.prepare("UPDATE channels SET name='mneme-project-test' WHERE id=?").run(THREAD_PARENT);
          return [];
        },
      },
    });

    expect(result.pagesFetched).toBe(1);
    expect(result.historyComplete).toBe(false);
    expect(getSyncCursor(db, THREAD_CHANNEL)?.historyComplete).toBe(false);
  });

  it('does not advance a malformed-only page after the thread parent becomes ineligible', async () => {
    seedThread(db);
    const result = await backfillChannel({
      db,
      opts: opts({ now: NOW }),
      channelId: THREAD_CHANNEL,
      fetcher: {
        async fetchMessages() {
          db.prepare("UPDATE channels SET ingest_enabled=0, visibility_class='excluded' WHERE id=?").run(THREAD_PARENT);
          return [{ id: makeIds(1)[0] }];
        },
      },
    });

    expect(result.pagesFetched).toBe(1);
    expect(result.messagesSkipped).toBe(1);
    expect(result.historyComplete).toBe(false);
    expect(getSyncCursor(db, THREAD_CHANNEL)?.nextBeforeMessageId).toBeNull();
  });
});

describe('createBackfillChannelHandler', () => {
  it('runs backfill via the job handler and returns the result', async () => {
    const ids = makeIds(100);
    const fetcher = makeFetcher(ids);
    const handler = createBackfillChannelHandler({
      db,
      fetcher,
      makeIngestOptions: (now) => opts({ now }),
      now: () => NOW,
    });
    const { channelId, result } = await handler.runBackfill(CHANNEL);
    expect(channelId).toBe(CHANNEL);
    expect(result.historyComplete).toBe(true);
    expect(result.messagesIngested).toBe(100);
    expect(countChannelMessages(db)).toBe(100);
  });

  it('dispatches as a registered backfill_channel handler', async () => {
    const ids = makeIds(50);
    const fetcher = makeFetcher(ids);
    const handler = createBackfillChannelHandler({
      db,
      fetcher,
      makeIngestOptions: (now) => opts({ now }),
      now: () => NOW,
    });
    // The handler signature matches JobHandler<'backfill_channel'>.
    await handler({ channelId: CHANNEL }, {
      id: 'job-1',
      type: 'backfill_channel',
      unique_key: null,
      payload_json: '{}',
      status: 'running',
      priority: 100,
      run_after_ms: NOW,
      lease_owner: 'test',
      lease_until_ms: NOW + 60000,
      attempts: 1,
      max_attempts: 10,
      last_error: null,
      created_at_ms: NOW,
      updated_at_ms: NOW,
      completed_at_ms: null,
    } as never);
    expect(countChannelMessages(db)).toBe(50);
  });

  it('discards a fetched thread page and succeeds when the parent becomes a test surface', async () => {
    seedThread(db);
    let announceFetchStarted!: () => void;
    let releaseFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { announceFetchStarted = resolve; });
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const info = vi.fn();
    const handler = createBackfillChannelHandler({
      db,
      fetcher: {
        async fetchMessages() {
          announceFetchStarted();
          await fetchGate;
          return [rawMessage(makeIds(1)[0]!, 'must-not-ingest', THREAD_CHANNEL)];
        },
      },
      makeIngestOptions: (now) => opts({ now }),
      now: () => NOW,
      logger: { info, warn: vi.fn() },
    });
    const queued = enqueue(db, {
      type: 'backfill_channel',
      payload: { channelId: THREAD_CHANNEL },
      now: NOW,
    });
    const worker = new JobWorker({
      db,
      owner: 'backfill-parent-race-test',
      leaseMs: 60_000,
      pollIntervalMs: 5,
      shutdownTimeoutMs: 1_000,
      clock: () => NOW,
    });
    worker.register('backfill_channel', 1, handler);
    expect(worker.dispatch()).toBe(1);
    await fetchStarted;

    db.prepare("UPDATE channels SET name='mneme-project-test' WHERE id=?").run(THREAD_PARENT);
    releaseFetch();
    await worker.settle();

    const job = db.prepare('SELECT status, attempts, last_error FROM jobs WHERE id=?').get(queued.id) as {
      status: string;
      attempts: number;
      last_error: string | null;
    };
    expect(job).toEqual({ status: 'succeeded', attempts: 1, last_error: null });
    expect(countChannelMessages(db, THREAD_CHANNEL)).toBe(0);
    expect(getSyncCursor(db, THREAD_CHANNEL)?.historyComplete).toBe(false);
    expect(info).toHaveBeenCalledWith(
      { event: 'backfill_channel.skipped', channelId: THREAD_CHANNEL, reason: 'control_surface', phase: 'during_fetch' },
      'backfill_channel: skipped ineligible channel',
    );
  });

  it('turns a failed in-flight fetch into a benign skip when the parent becomes ineligible', async () => {
    seedThread(db);
    let announceFetchStarted!: () => void;
    let releaseFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { announceFetchStarted = resolve; });
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const info = vi.fn();
    const handler = createBackfillChannelHandler({
      db,
      fetcher: {
        async fetchMessages() {
          announceFetchStarted();
          await fetchGate;
          throw new Error('synthetic fetch failure');
        },
      },
      makeIngestOptions: (now) => opts({ now }),
      now: () => NOW,
      logger: { info, warn: vi.fn() },
    });
    const queued = enqueue(db, {
      type: 'backfill_channel',
      payload: { channelId: THREAD_CHANNEL },
      now: NOW,
    });
    const worker = new JobWorker({
      db,
      owner: 'backfill-failed-fetch-race-test',
      leaseMs: 60_000,
      pollIntervalMs: 5,
      shutdownTimeoutMs: 1_000,
      clock: () => NOW,
    });
    worker.register('backfill_channel', 1, handler);
    expect(worker.dispatch()).toBe(1);
    await fetchStarted;

    db.prepare("UPDATE channels SET ingest_enabled=0, visibility_class='excluded' WHERE id=?").run(THREAD_PARENT);
    releaseFetch();
    await worker.settle();

    const job = db.prepare('SELECT status, attempts, last_error FROM jobs WHERE id=?').get(queued.id) as {
      status: string;
      attempts: number;
      last_error: string | null;
    };
    expect(job).toEqual({ status: 'succeeded', attempts: 1, last_error: null });
    expect(getSyncCursor(db, THREAD_CHANNEL)?.lastError).toBeNull();
    expect(info).toHaveBeenCalledWith(
      { event: 'backfill_channel.skipped', channelId: THREAD_CHANNEL, reason: 'parent_ineligible', phase: 'during_fetch' },
      'backfill_channel: skipped ineligible channel',
    );
  });
});
