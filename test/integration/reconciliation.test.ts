import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { GUILD, CHANNEL, AUTHOR, NOW, opts } from '../helpers/messages.js';
import { reconcileChannel } from '../../src/ingestion/reconcile.js';
import { createReconcileChannelHandler } from '../../src/jobs/handlers/reconcile-channel.js';
import { getSyncCursor } from '../../src/db/repositories/sync-cursors.js';
import { getMessage } from '../../src/db/repositories/messages.js';
import { normalizeMessage } from '../../src/platform/discord/normalize.js';
import { ingestMessageCreate, type IngestOptions } from '../../src/ingestion/ingest.js';
import type { BackfillMessageFetcher } from '../../src/ingestion/backfill.js';
import { enqueue } from '../../src/jobs/queue.js';
import { JobWorker } from '../../src/jobs/worker.js';

/**
 * Overlap-based restart reconciliation (Sections 9.6, 48).
 */

const THREAD_PARENT = '100000000000000010';
const THREAD_CHANNEL = '100000000000000011';

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

/** Generate N descending snowflake ids as strings (snowflides exceed MAX_SAFE_INTEGER). */
function makeIds(n: number, base = 400): string[] {
  const ids: string[] = [];
  for (let i = n; i >= 1; i -= 1) ids.push(String(base) + '00000000000' + String(i).padStart(6, '0'));
  return ids;
}

/** A fetcher backed by a fixed newest-first id list, with Discord `before` semantics. */
function makeFetcher(liveIds: string[]): BackfillMessageFetcher {
  return {
    normalize: normalizeMessage,
    async fetchMessages(_channelId: string, before: string | undefined, limit: number): Promise<unknown[]> {
      const startIdx = before ? liveIds.findIndex((id) => id < before) : 0;
      const slice = startIdx === -1 ? [] : liveIds.slice(startIdx, startIdx + limit);
      return slice.map((id) => rawMessage(id, `content-${id}`));
    },
  };
}

function seedMessages(db: DatabaseSync, ids: string[], ingestOpts: IngestOptions): void {
  for (const id of ids) {
    ingestMessageCreate(db, normalizeMessage(rawMessage(id, `seed-${id}`)), ingestOpts);
  }
}

function countChannelMessages(db: DatabaseSync, channelId = CHANNEL): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(channelId) as { c: number }).c;
}

function seedThread(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, kind, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
     VALUES (?, ?, NULL, 'text', 'project', 0, 0, 0, 1, 'org', 0, ?, ?)`,
  ).run(THREAD_PARENT, GUILD, NOW, NOW);
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, kind, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 'thread', 'discussion', 1, 1, 0, 1, 'org', 0, ?, ?)`,
  ).run(THREAD_CHANNEL, GUILD, THREAD_PARENT, NOW, NOW);
}

let env: TestDb;
let db: DatabaseSync;
let ingestOpts: IngestOptions;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
  ingestOpts = opts({ now: NOW });
});
afterEach(() => env.cleanup());

describe('reconcileChannel — overlap walk', () => {
  it('refreshes an already stored newest page', async () => {
    const ids = makeIds(100);
    seedMessages(db, ids, ingestOpts); // everything already stored
    const result = await reconcileChannel({ db, opts: ingestOpts, fetcher: makeFetcher(ids), channelId: CHANNEL });

    expect(result.pagesFetched).toBe(2);
    expect(result.messagesUpserted).toBe(100);
    expect(result.overlapFound).toBe(false);
    expect(countChannelMessages(db)).toBe(100);
  });

  it('fills a short gap (within one page) up to the overlap', async () => {
    const ids = makeIds(100);
    // DB has the oldest 90; the newest 10 are the gap.
    seedMessages(db, ids.slice(10), ingestOpts);
    const result = await reconcileChannel({ db, opts: ingestOpts, fetcher: makeFetcher(ids), channelId: CHANNEL });

    expect(result.overlapFound).toBe(false);
    expect(result.messagesUpserted).toBe(100);
    expect(result.pagesFetched).toBe(2);
    expect(countChannelMessages(db)).toBe(100);
  });

  it('recovers a gap longer than one page by walking backward to the overlap', async () => {
    const ids = makeIds(350);
    // DB has only the oldest 50; a 300-message gap spans three full pages.
    seedMessages(db, ids.slice(300), ingestOpts);
    const result = await reconcileChannel({ db, opts: ingestOpts, fetcher: makeFetcher(ids), channelId: CHANNEL });

    expect(result.overlapFound).toBe(false);
    expect(result.messagesUpserted).toBe(350);
    expect(result.pagesFetched).toBe(4);
    expect(countChannelMessages(db)).toBe(350);
  });

  it('resumes a bounded walk from its durable page cursor', async () => {
    const ids = makeIds(250);
    seedMessages(db, ids.slice(200), ingestOpts);

    const first = await reconcileChannel({
      db, opts: ingestOpts, fetcher: makeFetcher(ids), channelId: CHANNEL,
      pageSize: 100, maxPages: 1,
    });
    expect(first.complete).toBe(false);
    expect(first.messagesUpserted).toBe(100);
    expect(getSyncCursor(db, CHANNEL)?.reconcileBeforeMessageId).toBe(ids[99]);

    const second = await reconcileChannel({
      db, opts: ingestOpts, fetcher: makeFetcher(ids), channelId: CHANNEL,
      pageSize: 100, maxPages: 5,
    });
    expect(second.complete).toBe(true);
    expect(second.overlapFound).toBe(false);
    expect(countChannelMessages(db)).toBe(250);
    expect(getSyncCursor(db, CHANNEL)?.reconcileBeforeMessageId).toBeNull();
  });

  it('reaches end of history without an overlap on an empty channel', async () => {
    const ids = makeIds(50); // less than a full page
    const result = await reconcileChannel({ db, opts: ingestOpts, fetcher: makeFetcher(ids), channelId: CHANNEL });
    expect(result.overlapFound).toBe(false);
    expect(result.reachedEnd).toBe(true);
    expect(result.messagesUpserted).toBe(50);
  });

  it('updates last_reconciled_at_ms and bumps the newest bound', async () => {
    const ids = makeIds(10);
    seedMessages(db, ids.slice(5), ingestOpts); // oldest 5 stored; newest 5 are new
    const before = getSyncCursor(db, CHANNEL);
    expect(before).toBeNull(); // no cursor yet

    await reconcileChannel({ db, opts: opts({ now: NOW + 5000 }), fetcher: makeFetcher(ids), channelId: CHANNEL });

    const cursor = getSyncCursor(db, CHANNEL)!;
    expect(cursor.lastReconciledAtMs).toBe(NOW + 5000);
    expect(cursor.newestMessageId).toBe(ids[0]); // bumped to the observed newest
  });

  it('does not let a REST page overwrite a newer live observation', async () => {
    const id = makeIds(1)[0]!;
    seedMessages(db, [id], opts({ now: NOW + 1 }));
    await reconcileChannel({ db, opts: ingestOpts, fetcher: makeFetcher([id]), channelId: CHANNEL });
    expect(getMessage(db, id)?.content).toBe(`seed-${id}`);
  });

  it('never tombstones messages absent from the fetched pages (no inferred deletes)', async () => {
    // DB has A, B, C all live. Discord's newest page returns only A (B, C are older
    // or were removed without a delete event). Reconciliation must leave B, C intact.
    const A = makeIds(3)[0]!; // newest
    const B = makeIds(3)[1]!;
    const C = makeIds(3)[2]!; // oldest
    seedMessages(db, [A, B, C], ingestOpts);
    expect(getMessage(db, B)!.deleted_at_ms).toBeNull();

    const result = await reconcileChannel({
      db,
      opts: ingestOpts,
      fetcher: makeFetcher([A]), // only A is present on Discord's newest page
      channelId: CHANNEL,
    });

    expect(result.overlapFound).toBe(false);
    expect(result.messagesUpserted).toBe(1);
    // Neither B nor C was tombstoned despite being absent from the page.
    expect(getMessage(db, A)!.deleted_at_ms).toBeNull();
    expect(getMessage(db, B)!.deleted_at_ms).toBeNull();
    expect(getMessage(db, C)!.deleted_at_ms).toBeNull();
  });

  it('skips un-normalizable payloads without abandoning the walk', async () => {
    const ids = makeIds(5);
    const fetcher: BackfillMessageFetcher = {
      normalize: normalizeMessage,
      async fetchMessages() {
        // Newest-first: two good, one malformed, then already-stored overlap.
        return [
          rawMessage(ids[0]!, 'a'),
          rawMessage(ids[1]!, 'b'),
          { id: ids[2] /* missing channel_id */ },
          rawMessage(ids[3]!, 'overlap'),
        ];
      },
    };
    seedMessages(db, [ids[3]!, ids[4]!], ingestOpts); // ids[3] is the overlap
    const result = await reconcileChannel({ db, opts: ingestOpts, fetcher, channelId: CHANNEL });
    expect(result.overlapFound).toBe(false);
    expect(result.messagesUpserted).toBe(3);
    expect(result.messagesSkipped).toBe(1);
    expect(result.complete).toBe(false);
  });

  it('does not complete an empty fetched page after the thread parent becomes a test surface', async () => {
    seedThread(db);
    const result = await reconcileChannel({
      db,
      opts: ingestOpts,
      channelId: THREAD_CHANNEL,
      fetcher: {
        normalize: normalizeMessage,
        async fetchMessages() {
          db.prepare("UPDATE channels SET name='mneme-project-test' WHERE id=?").run(THREAD_PARENT);
          return [];
        },
      },
    });

    expect(result.pagesFetched).toBe(1);
    expect(result.reachedEnd).toBe(true);
    expect(result.complete).toBe(false);
    expect(getSyncCursor(db, THREAD_CHANNEL)?.lastReconciledAtMs).toBeNull();
  });
});

describe('createReconcileChannelHandler', () => {
  it('runs reconciliation via the handler and returns the result', async () => {
    const ids = makeIds(20);
    seedMessages(db, ids.slice(5), ingestOpts);
    const handler = createReconcileChannelHandler({
      db,
      fetcher: makeFetcher(ids),
      makeIngestOptions: (now) => opts({ now }),
      now: () => NOW,
    });
    const { channelId, result } = await handler.runReconcile(CHANNEL);
    expect(channelId).toBe(CHANNEL);
    expect(result.overlapFound).toBe(false);
    expect(result.messagesUpserted).toBe(20);
    expect(getSyncCursor(db, CHANNEL)!.lastReconciledAtMs).toBe(NOW);
  });

  it('completes a queued job as a benign skip when the channel becomes ineligible before execution', async () => {
    let fetches = 0;
    const info = vi.fn();
    const handler = createReconcileChannelHandler({
      db,
      fetcher: {
        normalize: normalizeMessage,
        async fetchMessages() {
          fetches += 1;
          return [];
        },
      },
      makeIngestOptions: (now) => opts({ now }),
      now: () => NOW,
      logger: { info, warn: vi.fn() },
    });
    const queued = enqueue(db, {
      type: 'reconcile_channel',
      payload: { channelId: CHANNEL },
      now: NOW,
    });
    db.prepare("UPDATE channels SET ingest_enabled=0, visibility_class='excluded' WHERE id=?").run(CHANNEL);

    const worker = new JobWorker({
      db,
      owner: 'reconcile-skip-test',
      leaseMs: 60_000,
      pollIntervalMs: 5,
      shutdownTimeoutMs: 1_000,
      clock: () => NOW,
    });
    worker.register('reconcile_channel', 1, handler);
    await worker.runOnce();

    const job = db.prepare('SELECT status, attempts, last_error FROM jobs WHERE id=?').get(queued.id) as {
      status: string;
      attempts: number;
      last_error: string | null;
    };
    expect(job).toEqual({ status: 'succeeded', attempts: 1, last_error: null });
    expect(fetches).toBe(0);
    expect(info).toHaveBeenCalledWith(
      { event: 'reconcile_channel.skipped', channelId: CHANNEL, reason: 'ineligible', phase: 'before_fetch' },
      'reconcile_channel: skipped ineligible channel',
    );
  });

  it('completes without ingest when a thread parent becomes a Mneme test surface during fetch', async () => {
    seedThread(db);
    let announceFetchStarted!: () => void;
    let releaseFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { announceFetchStarted = resolve; });
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const info = vi.fn();
    const handler = createReconcileChannelHandler({
      db,
      fetcher: {
        normalize: normalizeMessage,
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
      type: 'reconcile_channel',
      payload: { channelId: THREAD_CHANNEL },
      now: NOW,
    });
    const worker = new JobWorker({
      db,
      owner: 'reconcile-race-test',
      leaseMs: 60_000,
      pollIntervalMs: 5,
      shutdownTimeoutMs: 1_000,
      clock: () => NOW,
    });
    worker.register('reconcile_channel', 1, handler);
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
    expect(getSyncCursor(db, THREAD_CHANNEL)?.lastReconciledAtMs).toBeNull();
    expect(info).toHaveBeenCalledWith(
      { event: 'reconcile_channel.skipped', channelId: THREAD_CHANNEL, reason: 'control_surface', phase: 'during_fetch' },
      'reconcile_channel: skipped ineligible channel',
    );
  });

  it('turns a failed in-flight fetch into a benign skip when the thread parent becomes ineligible', async () => {
    seedThread(db);
    let announceFetchStarted!: () => void;
    let releaseFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { announceFetchStarted = resolve; });
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const info = vi.fn();
    const handler = createReconcileChannelHandler({
      db,
      fetcher: {
        normalize: normalizeMessage,
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
      type: 'reconcile_channel',
      payload: { channelId: THREAD_CHANNEL },
      now: NOW,
    });
    const worker = new JobWorker({
      db,
      owner: 'reconcile-failed-fetch-race-test',
      leaseMs: 60_000,
      pollIntervalMs: 5,
      shutdownTimeoutMs: 1_000,
      clock: () => NOW,
    });
    worker.register('reconcile_channel', 1, handler);
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
    expect(getSyncCursor(db, THREAD_CHANNEL)?.lastReconciledAtMs).toBeNull();
    expect(info).toHaveBeenCalledWith(
      { event: 'reconcile_channel.skipped', channelId: THREAD_CHANNEL, reason: 'parent_ineligible', phase: 'during_fetch' },
      'reconcile_channel: skipped ineligible channel',
    );
  });
});
