import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { GUILD, NOW, opts } from '../helpers/messages.js';
import { backfillChannel } from '../../src/ingestion/backfill.js';
import { getSyncCursor } from '../../src/db/repositories/sync-cursors.js';
import { insertProposal } from '../../src/db/repositories/proposals.js';
import { enqueueOutbox, getOutbox } from '../../src/outbox/repository.js';
import { createSendOutboxHandler } from '../../src/outbox/worker.js';
import { TransientJobError } from '../../src/jobs/errors.js';
import type { JobRow } from '../../src/jobs/types.js';
import { createSyntheticDiscord } from '../fixtures/discord/synthetic-adapter.js';

/**
 * Ingestion reliability integration suite (Section 46.2, task T119).
 *
 * Fills the three Section 46.2 scenarios that had no dedicated end-to-end test:
 *   - rate-limit retry on outbox delivery (HTTP 429)
 *   - rate-limit retry on historical backfill fetch (HTTP 429)
 *   - backfilling a forum-post thread to completion
 *
 * All three drive the public module boundaries through the shared synthetic
 * Discord adapter ({@link createSyntheticDiscord}) with no network.
 */

const CHANNEL = '100000000000000002';
const FORUM = '300000000000000005';
const FORUM_POST = '300000000000000104'; // a thread (forum post) under FORUM

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

function jobRow(maxAttempts = 10): JobRow {
  return { max_attempts: maxAttempts } as unknown as JobRow;
}

/** Seed an eligible forum parent and its thread so ancestry checks reflect production discovery. */
function seedThreadChannel(id: string, parentId: string, guild = GUILD): void {
  const now = NOW;
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, kind, name, topic, position, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, permission_fingerprint, last_message_id,
       discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json)
     VALUES (?, ?, NULL, 'forum', ?, NULL, NULL, 0, 0, 0, 1, 'restricted', 0, NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(parentId, guild, `${parentId}-name`, now, now);
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, kind, name, topic, position, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, permission_fingerprint, last_message_id,
       discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json)
     VALUES (?, ?, ?, 'thread', ?, NULL, NULL, 1, 0, 0, 1, 'restricted', 0, NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(id, guild, parentId, `${id}-name`, now, now);
}

/** A raw snake_case message in a given channel. */
function rawMessage(id: string, channelId: string, content: string): Record<string, unknown> {
  return {
    id,
    channel_id: channelId,
    guild_id: GUILD,
    author: { id: '100000000000000003', username: 'alice', global_name: 'Alice', bot: false },
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

function countMessages(channelId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(channelId) as { c: number }).c;
}

describe('Section 46.2 — rate-limit retry on outbox delivery (HTTP 429)', () => {
  it('classifies a 429 as transient, returns the row to queued, and a later attempt succeeds', async () => {
    db.prepare(
      `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
       VALUES(?, ?, NULL, 'episode', 'pv', 'faux', 'faux-1', 'completed', ?)`,
    ).run('run-1', GUILD, NOW);
    const proposalId = insertProposal(db, {
      runId: 'run-1',
      targetChannelId: CHANNEL,
      status: 'approved',
      computedScore: 0.8,
      reason: ['approved'],
      evidenceMessageIds: ['m1'],
      now: NOW,
    });
    const { outboxId } = enqueueOutbox(db, {
      proposalId,
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'rate-limited heads up',
      replyToMessageId: null,
      now: NOW,
    });

    const discord = createSyntheticDiscord({ now: NOW });
    // The first delivery is rejected by Discord with a 429.
    discord.scriptSendError({ status: 429, message: 'You are being rate limited.' }, 0);
    const deps = {
      db,
      sender: discord.sender,
      now: () => discord.clock.now(),
      retryDelayMs: () => 1_000,
    };

    await expect(createSendOutboxHandler(deps)({ outboxId }, jobRow())).rejects.toBeInstanceOf(
      TransientJobError,
    );

    const afterFail = getOutbox(db, outboxId)!;
    expect(afterFail.status).toBe('queued');
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.lastError).toContain('rate limited');
    expect(afterFail.nextAttemptAtMs).toBeGreaterThan(NOW);
    // Nothing was actually delivered yet.
    expect(discord.sentMessages).toHaveLength(0);

    // Advance time past the backoff and retry; call index 1 succeeds.
    discord.clock.advance(2_000);
    await createSendOutboxHandler(deps)({ outboxId }, jobRow());

    const afterSuccess = getOutbox(db, outboxId)!;
    expect(afterSuccess.status).toBe('sent');
    expect(afterSuccess.attempts).toBe(2);
    expect(afterSuccess.platformMessageId).toBeDefined();
    expect(discord.sentMessages).toHaveLength(1);
    expect(discord.sentMessages[0]!.content).toBe('rate-limited heads up');
  });
});

describe('Section 46.2 — rate-limit retry on backfill fetch (HTTP 429)', () => {
  it('retains the committed cursor with the error and resumes without a gap or duplicates', async () => {
    const discord = createSyntheticDiscord({ now: NOW });
    // 150 messages → page 1 (newest 100) commits the cursor, then page 2 is rate-limited.
    const ids: string[] = [];
    for (let i = 150; i >= 1; i -= 1) ids.push('400000000000' + String(i).padStart(6, '0'));
    discord.seedChannelMessages(CHANNEL, ids.map((id, i) => rawMessage(id, CHANNEL, `msg-${i}`)));
    // The SECOND page fetch (call index 1) is rejected with a 429, after page 1 has committed.
    discord.scriptFetchError(CHANNEL, { status: 429, message: 'rate limited on fetch' }, 1);

    await expect(
      backfillChannel({ db, opts: opts({ now: NOW }), fetcher: discord.backfillFetcher, channelId: CHANNEL, pageSize: 100 }),
    ).rejects.toThrow(/rate limited on fetch/);

    // Page 1 (100 messages) was committed before the failure; the cursor is retained,
    // marked errored, and points at the page-1 boundary so a retry resumes mid-history.
    expect(countMessages(CHANNEL)).toBe(100);
    const cursor = getSyncCursor(db, CHANNEL)!;
    expect(cursor.historyComplete).toBe(false);
    expect(cursor.lastError).toContain('rate limited on fetch');
    expect(cursor.nextBeforeMessageId).not.toBeNull();

    // The retry resumes from the cursor (call index 2, no scripted error) and completes.
    discord.clock.advance(5_000);
    const result = await backfillChannel({
      db,
      opts: opts({ now: discord.clock.now() }),
      fetcher: discord.backfillFetcher,
      channelId: CHANNEL,
      pageSize: 100,
    });

    expect(result.historyComplete).toBe(true);
    expect(result.resumed).toBe(true);
    expect(result.messagesIngested).toBe(50);
    // All 150 messages are present exactly once; the overlap with page 1 deduped.
    expect(countMessages(CHANNEL)).toBe(150);
    expect(getSyncCursor(db, CHANNEL)!.historyComplete).toBe(true);
  });
});

describe('Section 46.2 — forum-post thread backfill', () => {
  it('ingests a forum-post thread to completion and records the bounds on the thread cursor', async () => {
    seedThreadChannel(FORUM_POST, FORUM);
    const discord = createSyntheticDiscord({ now: NOW });
    const ids = ['500000000000000004', '500000000000000003', '500000000000000002', '500000000000000001'];
    discord.seedChannelMessages(FORUM_POST, ids.map((id, i) => rawMessage(id, FORUM_POST, `post-msg-${i}`)));

    const result = await backfillChannel({
      db,
      opts: opts({ now: NOW }),
      fetcher: discord.backfillFetcher,
      channelId: FORUM_POST,
      pageSize: 100,
    });

    expect(result.historyComplete).toBe(true);
    expect(result.messagesIngested).toBe(4);
    expect(result.newestMessageId).toBe(ids[0]);
    expect(result.oldestMessageId).toBe(ids[ids.length - 1]);
    // Every ingested message is attributed to the thread channel, not the parent.
    expect(countMessages(FORUM_POST)).toBe(4);
    expect(countMessages(FORUM)).toBe(0);

    const cursor = getSyncCursor(db, FORUM_POST)!;
    expect(cursor.historyComplete).toBe(true);
    expect(cursor.state).toBe('live');
    expect(cursor.newestMessageId).toBe(ids[0]);
    expect(cursor.oldestMessageId).toBe(ids[ids.length - 1]);
  });
});
