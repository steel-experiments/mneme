import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { createMemory } from '../../src/memory/repository.js';
import { searchMemories } from '../../src/memory/search.js';
import {
  searchMessages,
  type RetrievalGrant,
} from '../../src/db/repositories/message-search.js';
import {
  runMaintenance,
  pruneTerminalJobs,
  runIntegrityCheck,
  runForeignKeyCheck,
  walCheckpoint,
  vacuumAndRebuildFts,
  rebuildFullTextIndexes,
} from '../../src/db/maintenance.js';
import { createDatabaseMaintenanceHandler } from '../../src/jobs/handlers/maintenance.js';
import {
  handleIntegrityCheckCommand,
  formatIntegrityCheckReply,
} from '../../src/commands/integrity.js';

/**
 * Database integrity and optimization maintenance (Section 28).
 *
 * Acceptance — verbatim: "Maintenance reports outcomes, never copies live SQLite
 * files, and post-vacuum FTS results remain complete."
 *
 * These tests exercise the maintenance operations and the `maintenance` job
 * handler against a real migrated SQLite file, and the `/mneme
 * integrity-check` command handler end to end.
 */

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const NOW = 1_700_000_001_000;
const ADMIN_ROLE = '900000000000000001';
const ADMIN_ROLES: readonly string[] = [ADMIN_ROLE];
const ADMIN = '100000000000000010';
const OUTSIDER = '100000000000000011';

const ORG = 'org-channel-maint';

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };

/** A phrase unlikely to collide with FTS tokenizer quirks (no hyphens). */
const MESSAGE_PHRASE = 'mneme vacuum sentinel content';
const MEMORY_PHRASE = 'adopt the vacuum rebuild protocol decision';

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
  seedChannel(ORG, 'org');
});

afterEach(() => env.cleanup());

function seedChannel(
  id: string,
  visibility: 'org' | 'restricted' | 'review_only',
): void {
  upsertChannel(db, {
    id,
    guildId: GUILD,
    parentId: null,
    kind: 'text',
    name: id,
    topic: null,
    position: null,
    isThread: false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: visibility,
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  });
}

function addMessage(id: string, content: string): void {
  upsertMessageCreate(db, {
    id,
    guildId: GUILD,
    channelId: ORG,
    authorId: USER,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: NOW,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: NOW,
    updatedAtMs: NOW,
  });
}

/** Seed one org message + one org memory whose FTS phrases are distinctive. */
function seedSearchableRows(): { message: string; memory: string } {
  addMessage('m-sentinel', MESSAGE_PHRASE);
  const memory = createMemory(db, ORG_GRANT, {
    guildId: GUILD,
    type: 'decision',
    statement: MEMORY_PHRASE,
    confidence: 0.8,
    importance: 0.7,
    evidence: [{ messageId: 'm-sentinel', stance: 'origin' }],
    now: NOW,
  });
  return { message: 'm-sentinel', memory };
}

/** Files in the live db directory that look like a copied database snapshot. */
function dbCopyFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => /\.(sqlite|db|bak|backup|copy)$/i.test(f) || /-bak|-copy/i.test(f));
}

describe('maintenance reports outcomes', () => {
  it('runMaintenance reports optimize, checkpoint, and (when requested) integrity outcomes', () => {
    const light = runMaintenance(db);
    expect(light.optimize.ran).toBe(true);
    expect(light.checkpoint.mode).toBe('PASSIVE');
    expect(light.integrity).toBeNull();
    expect(light.vacuum).toBeNull();

    const full = runMaintenance(db, { integrity: true });
    expect(full.integrity).not.toBeNull();
    expect(full.integrity!.ok).toBe(true);
    expect(full.integrity!.message).toBe('ok');
  });

  it('runMaintenance reports a VACUUM outcome with both FTS rebuilds', () => {
    seedSearchableRows();
    const out = runMaintenance(db, { vacuum: true });
    expect(out.vacuum).not.toBeNull();
    expect(out.vacuum!.vacuumed).toBe(true);
    expect(out.vacuum!.error).toBeNull();
    expect(out.vacuum!.ftsRebuilt).toEqual({ messages: true, memories: true });
  });

  it('the maintenance job handler reports the same outcome via runDatabaseMaintenance', async () => {
    let reported: { ok: boolean; vacuumed: boolean } | null = null;
    const handler = createDatabaseMaintenanceHandler({
      db,
      options: { integrity: true },
      now: () => NOW,
      onOutcome: (outcome) => {
        reported = { ok: outcome.integrity?.ok === true, vacuumed: outcome.vacuum?.vacuumed === true };
      },
    });
    const { outcome } = await handler.runDatabaseMaintenance();
    expect(outcome.optimize.ran).toBe(true);
    expect(outcome.integrity!.ok).toBe(true);
    expect(reported).toEqual({ ok: true, vacuumed: false });
  });

  it('the handler runs as a maintenance JobHandler without throwing', async () => {
    const handler = createDatabaseMaintenanceHandler({ db, now: () => NOW });
    // JobHandler<'maintenance'> payload is `Record<string, never>`.
    await handler({}, { id: 'j1', type: 'maintenance', attempts: 1 } as never);
  });
});

describe('Section 10 — terminal job retention', () => {
  const DAY = 86_400_000;

  function insertJob(id: string, status: string, createdAtMs: number, completedAtMs: number | null): void {
    db.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, run_after_ms, created_at_ms, updated_at_ms, completed_at_ms)
       VALUES (?, 'review_episode', '{}', ?, ?, ?, ?, ?)`,
    ).run(id, status, createdAtMs, createdAtMs, completedAtMs ?? createdAtMs, completedAtMs);
  }

  function remainingIds(): string[] {
    return (db.prepare('SELECT id FROM jobs ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
  }

  it('deletes only terminal rows that finished before the cutoff', () => {
    const old = NOW - 40 * DAY;
    insertJob('old-succeeded', 'succeeded', old, old + 1_000);
    insertJob('old-failed', 'failed', old, old + 1_000);
    insertJob('old-cancelled', 'cancelled', old, null); // falls back to updated_at_ms
    insertJob('old-queued', 'queued', old, null);
    insertJob('old-running', 'running', old, null);
    // Created long ago but finished inside the window: kept.
    insertJob('old-created-recent-finish', 'succeeded', old, NOW - 2 * DAY);
    insertJob('recent-succeeded', 'succeeded', NOW - 5 * DAY, NOW - 5 * DAY + 1_000);

    const result = pruneTerminalJobs(db, { nowMs: NOW, retentionDays: 30 });

    expect(result.deleted).toBe(3);
    expect(result.cutoffMs).toBe(NOW - 30 * DAY);
    expect(result.capped).toBe(false);
    expect(remainingIds()).toEqual([
      'old-created-recent-finish',
      'old-queued',
      'old-running',
      'recent-succeeded',
    ]);
  });

  it('runs in bounded batches and reports when the cap stopped it', () => {
    const old = NOW - 40 * DAY;
    for (let i = 0; i < 5; i += 1) insertJob(`old-${i}`, 'succeeded', old + i, old + i + 1);

    const capped = pruneTerminalJobs(db, { nowMs: NOW, retentionDays: 30, batchSize: 2, maxBatches: 2 });
    expect(capped).toEqual({ deleted: 4, cutoffMs: NOW - 30 * DAY, batches: 2, capped: true });
    expect(remainingIds()).toEqual(['old-4']);

    const rest = pruneTerminalJobs(db, { nowMs: NOW, retentionDays: 30, batchSize: 2, maxBatches: 2 });
    expect(rest).toEqual({ deleted: 1, cutoffMs: NOW - 30 * DAY, batches: 1, capped: false });
    expect(remainingIds()).toEqual([]);
  });

  it('keeps a finished direct-answer request and nulls its job reference', () => {
    const old = NOW - 40 * DAY;
    insertJob('old-answer-job', 'succeeded', old, old + 1_000);
    db.prepare(
      `INSERT INTO direct_answer_requests
         (source_message_id, job_id, workspace_id, target_channel_id, question_created_at_ms, deadline_at_ms,
          response_intent_key, outcome_kind, reason_category, completed_at_ms, created_at_ms, updated_at_ms)
       VALUES ('q-1', 'old-answer-job', ?, ?, ?, ?, 'intent-q-1', 'suppressed', 'timeout', ?, ?, ?)`,
    ).run(GUILD, ORG, old, old + 60_000, old + 1_000, old, old + 1_000);

    const result = pruneTerminalJobs(db, { nowMs: NOW, retentionDays: 30 });
    expect(result.deleted).toBe(1);
    const request = db
      .prepare('SELECT job_id, outcome_kind FROM direct_answer_requests WHERE source_message_id = ?')
      .get('q-1') as { job_id: string | null; outcome_kind: string };
    expect(request).toEqual({ job_id: null, outcome_kind: 'suppressed' });
  });

  it('the maintenance handler prunes with the configured retention and reports it', async () => {
    const old = NOW - 40 * DAY;
    insertJob('old-succeeded', 'succeeded', old, old + 1_000);
    insertJob('recent-succeeded', 'succeeded', NOW - DAY, NOW - DAY + 1_000);

    const withoutRetention = createDatabaseMaintenanceHandler({ db, now: () => NOW });
    const { outcome: untouched } = await withoutRetention.runDatabaseMaintenance();
    expect(untouched.jobsPruned).toBeNull();
    expect(remainingIds()).toEqual(['old-succeeded', 'recent-succeeded']);

    let reported: number | null = null;
    const handler = createDatabaseMaintenanceHandler({
      db,
      now: () => NOW,
      jobsRetentionDays: 30,
      onOutcome: (outcome) => {
        reported = outcome.jobsPruned?.deleted ?? null;
      },
    });
    const { outcome } = await handler.runDatabaseMaintenance();
    expect(outcome.jobsPruned).toEqual({ deleted: 1, cutoffMs: NOW - 30 * DAY, batches: 1, capped: false });
    expect(reported).toBe(1);
    expect(remainingIds()).toEqual(['recent-succeeded']);
  });
});

describe('maintenance never copies live SQLite files', () => {
  it('creates no new database/copy files in the data directory (optimize + checkpoint)', () => {
    const before = new Set(readdirSync(env.dir));
    runMaintenance(db);
    const newcomers = readdirSync(env.dir).filter((f) => !before.has(f));
    expect(newcomers).toEqual([]);
  });

  it('creates no new database/copy files even when VACUUM runs', () => {
    seedSearchableRows();
    const before = new Set(dbCopyFiles(env.dir));
    runMaintenance(db, { vacuum: true });
    const after = new Set(dbCopyFiles(env.dir));
    expect([...after].filter((f) => !before.has(f))).toEqual([]);
    // The live database file is the only base file; no standalone copy appeared.
    expect([...after].some((f) => /^test\.sqlite$/.test(f))).toBe(true);
  });

  it('the operations module takes a connection, not a path: no copy API surface', () => {
    // Section 28 forbids raw file copies while open. The maintenance functions
    // accept the open DatabaseSync and run PRAGMAs; there is no source-path or
    // fs.copy parameter to misuse. Sanity-check the core entry points exist and
    // are callable without any path argument.
    expect(() => runIntegrityCheck(db)).not.toThrow();
    expect(() => runForeignKeyCheck(db)).not.toThrow();
    expect(() => walCheckpoint(db, 'PASSIVE')).not.toThrow();
    expect(() => rebuildFullTextIndexes(db)).not.toThrow();
  });
});

describe('post-vacuum FTS results remain complete', () => {
  it('messages_fts still resolves a phrase after VACUUM + rebuild', () => {
    const { message } = seedSearchableRows();
    const before = searchMessages(db, ORG_GRANT, { query: MESSAGE_PHRASE });
    expect(before.map((r) => r.messageId)).toContain(message);

    vacuumAndRebuildFts(db);

    const after = searchMessages(db, ORG_GRANT, { query: MESSAGE_PHRASE });
    expect(after.map((r) => r.messageId)).toContain(message);
    expect(after.length).toBe(before.length);
  });

  it('memories_fts still resolves a phrase after VACUUM + rebuild', () => {
    const { memory } = seedSearchableRows();
    const before = searchMemories(db, ORG_GRANT, { query: MEMORY_PHRASE });
    expect(before.map((r) => r.memoryId)).toContain(memory);

    vacuumAndRebuildFts(db);

    const after = searchMemories(db, ORG_GRANT, { query: MEMORY_PHRASE });
    expect(after.map((r) => r.memoryId)).toContain(memory);
    expect(after.length).toBe(before.length);
  });

  it('a rebuild alone (no VACUUM) keeps FTS complete and idempotent', () => {
    const { memory } = seedSearchableRows();
    rebuildFullTextIndexes(db);
    rebuildFullTextIndexes(db);
    const results = searchMemories(db, ORG_GRANT, { query: MEMORY_PHRASE });
    expect(results.map((r) => r.memoryId)).toContain(memory);
  });

  it('integrity_check and foreign_key_check are healthy on the live database', () => {
    seedSearchableRows();
    vacuumAndRebuildFts(db);
    expect(runIntegrityCheck(db)).toEqual({ ok: true, message: 'ok' });
    expect(runForeignKeyCheck(db).ok).toBe(true);
    expect(runForeignKeyCheck(db).violations).toBe(0);
  });
});

describe('/mneme integrity-check command', () => {
  const adminInput = (memberRoleIds: readonly string[] | null, actor = ADMIN) => ({
    actorUserId: actor,
    guildId: GUILD,
    memberRoleIds,
  });

  it('reports healthy integrity, foreign keys, and a WAL checkpoint to an authorized admin', () => {
    seedSearchableRows();
    const outcome = handleIntegrityCheckCommand(adminInput([ADMIN_ROLE]), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW,
    });
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.data.integrity.ok).toBe(true);
    expect(outcome.data.foreignKeys.ok).toBe(true);
    expect(outcome.data.checkpoint.mode).toBe('PASSIVE');

    const reply = formatIntegrityCheckReply(outcome);
    expect(reply).toContain('integrity_check: ok');
    expect(reply).toContain('foreign_key_check: ok');
    expect(reply).toContain('wal_checkpoint(PASSIVE)');
  });

  it('denies an unauthorized caller, audits the denial, and runs no check', () => {
    const outcome = handleIntegrityCheckCommand(adminInput(['nope'], OUTSIDER), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW,
    });
    expect(outcome.kind).toBe('not_authorized');
    expect(formatIntegrityCheckReply(outcome)).toContain('not authorized');

    const ev = db
      .prepare(
        'SELECT details_json AS detailsJson, actor_user_id AS actorUserId FROM admin_events WHERE action = ? ORDER BY created_at_ms DESC LIMIT 1',
      )
      .get('integrity_check') as { detailsJson: string; actorUserId: string } | undefined;
    expect(ev).toBeDefined();
    expect(ev!.actorUserId).toBe(OUTSIDER);
    expect(JSON.parse(ev!.detailsJson).authorized).toBe(false);
  });

  it('fails closed on null member role data', () => {
    const outcome = handleIntegrityCheckCommand(adminInput(null), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW,
    });
    expect(outcome.kind).toBe('not_authorized');
  });

  it('audits an authorized run', () => {
    handleIntegrityCheckCommand(adminInput([ADMIN_ROLE]), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW,
    });
    const ev = db
      .prepare('SELECT details_json AS detailsJson FROM admin_events WHERE action = ? ORDER BY created_at_ms DESC LIMIT 1')
      .get('integrity_check') as { detailsJson: string } | undefined;
    expect(ev).toBeDefined();
    expect(JSON.parse(ev!.detailsJson).authorized).toBe(true);
  });
});
