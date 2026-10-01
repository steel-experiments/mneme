import { type DatabaseSync } from './database.js';

/**
 * Database integrity and optimization maintenance (Section 28).
 *
 * Every operation here runs as PRAGMA statements or FTS rebuild commands
 * directly against the live connection. None of them copies the main `.sqlite`
 * file while it is open: Section 28 forbids raw file copies ("online backup API,
 * not raw file copy while open"; "Never move only the main .sqlite file while
 * the database is open"). A standalone snapshot is the backup subsystem's job;
 * maintenance only reclaims space and keeps the indexes honest.
 *
 * Operational rules from Section 28 these operations implement:
 * - `PRAGMA optimize` daily;
 * - passive WAL checkpoint periodically (truncate checkpoint at shutdown);
 * - `VACUUM` only as an explicit maintenance operation, *always* followed in the
 *   same operation by rebuilding both external-content FTS tables (VACUUM may
 *   renumber the rowids the FTS tables key on).
 */

/** WAL checkpoint mode (Section 28: PASSIVE periodically, TRUNCATE on shutdown). */
export type WalCheckpointMode = 'PASSIVE' | 'TRUNCATE' | 'RESTART';

/** A `PRAGMA wal_checkpoint(<mode>)` outcome. */
export interface WalCheckpointResult {
  mode: WalCheckpointMode;
  /** 1 when the checkpoint could not run to completion (busy / active reader); else 0. */
  busy: number;
  /** Number of frames currently in the WAL log after the checkpoint attempt. */
  logFrames: number;
  /** Number of frames written back into the main database file. */
  checkpointedFrames: number;
}

/**
 * Run a WAL checkpoint. `PASSIVE` (the default) does not block readers or
 * writers and checkpoints as much as it can — the periodic mode. `TRUNCATE`
 * additionally zeroes the WAL back to its minimum size and is intended for
 * graceful shutdown (Section 28).
 */
export function walCheckpoint(db: DatabaseSync, mode: WalCheckpointMode = 'PASSIVE'): WalCheckpointResult {
  const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
    | { busy: number | bigint; log: number | bigint; checkpointed: number | bigint }
    | undefined;
  return {
    mode,
    busy: Number(row?.busy ?? 1),
    logFrames: Number(row?.log ?? 0),
    checkpointedFrames: Number(row?.checkpointed ?? 0),
  };
}

/**
 * Run `PRAGMA optimize`. Cheap and idempotent; Section 28 calls for it daily. It
 * refreshes the `sqlite_stat1` statistics the query planner relies on.
 */
export function pragmaOptimize(db: DatabaseSync): void {
  db.exec('PRAGMA optimize');
}

/** Outcome of `PRAGMA integrity_check` on a connection. */
export interface IntegrityCheckResult {
  /** `true` only when the check reports a single `ok` line. */
  ok: boolean;
  /** `'ok'` when healthy, otherwise the integrity_check lines joined by newlines. */
  message: string;
}

/**
 * Run `PRAGMA integrity_check` on the live connection. Unlike the backup
 * subsystem's file-based check, this reads the open database directly — it is
 * the read path for `/mneme integrity-check` and the optional periodic
 * health probe. Returns `{ ok: true, message: 'ok' }` when consistent.
 */
export function runIntegrityCheck(db: DatabaseSync): IntegrityCheckResult {
  const rows = db.prepare('PRAGMA integrity_check').all() as ReadonlyArray<Record<string, unknown>>;
  const lines = rows.map((r) => {
    const v = Object.values(r)[0];
    return v === undefined ? '' : String(v);
  });
  const message = lines.length === 0 ? 'ok' : lines.join('\n');
  return { ok: message === 'ok', message };
}

/** Outcome of `PRAGMA foreign_key_check` on a connection. */
export interface ForeignKeyCheckResult {
  /** `true` only when there are zero foreign-key violations. */
  ok: boolean;
  /** Number of foreign-key violations (0 when none). */
  violations: number;
  /** The violation rows as JSON, one per line (empty when ok). */
  message: string;
}

/**
 * Run `PRAGMA foreign_key_check`. Complements {@link runIntegrityCheck}: the
 * integrity check confirms page/structure consistency, this confirms every
 * foreign-key reference resolves. Empty result means no violations.
 */
export function runForeignKeyCheck(db: DatabaseSync): ForeignKeyCheckResult {
  const rows = db.prepare('PRAGMA foreign_key_check').all() as ReadonlyArray<Record<string, unknown>>;
  const lines = rows.map((r) => JSON.stringify(r));
  return { ok: rows.length === 0, violations: rows.length, message: lines.join('\n') };
}

/** Outcome of a full FTS rebuild (Section 28: always run after VACUUM). */
export interface FtsRebuildResult {
  messages: boolean;
  memories: boolean;
}

/**
 * Rebuild both external-content FTS indexes from scratch (Section 28). Run after
 * a `VACUUM`, which may renumber the rowids of tables without an
 * `INTEGER PRIMARY KEY` and so desync the external-content FTS tables keyed on
 * those rowids. The special `'rebuild'` command repopulates them completely.
 */
export function rebuildFullTextIndexes(db: DatabaseSync): FtsRebuildResult {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  return { messages: true, memories: true };
}

/** Outcome of a `VACUUM` followed by the mandatory FTS rebuild (Section 28). */
export interface VacuumResult {
  /** `true` when the VACUUM ran; `false` when it failed (see `error`). */
  vacuumed: boolean;
  /** The FTS rebuild outcome; only meaningful when `vacuumed` is true. */
  ftsRebuilt: FtsRebuildResult;
  /** The error message when the VACUUM could not run; otherwise null. */
  error: string | null;
}

/**
 * Run `VACUUM` and then — in the same maintenance operation — rebuild both FTS
 * indexes. Section 28 is explicit: VACUUM is *always* followed in the same job
 * by both FTS rebuilds, because VACUUM may renumber the rowids the
 * external-content FTS tables key on. If the VACUUM itself fails (e.g. the
 * database is busy), no rebuild is attempted and the error is reported; the
 * caller decides whether to retry. Runs outside any transaction — `VACUUM`
 * cannot be transactional, and the worker runs handlers outside transactions
 * anyway (Section 10).
 */
export function vacuumAndRebuildFts(db: DatabaseSync): VacuumResult {
  try {
    db.exec('VACUUM');
  } catch (err) {
    return {
      vacuumed: false,
      ftsRebuilt: { messages: false, memories: false },
      error: errorMessage(err),
    };
  }
  const ftsRebuilt = rebuildFullTextIndexes(db);
  return { vacuumed: true, ftsRebuilt, error: null };
}

/** Job statuses that never run again; only these rows are ever pruned. */
const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
/** Rows deleted per statement, so each autocommit write stays short. */
export const JOB_PRUNE_BATCH_SIZE = 1_000;
/** Statements per maintenance run; the rest waits for the next day. */
export const JOB_PRUNE_MAX_BATCHES = 20;

export interface PruneJobsOptions {
  /** The clock at the start of the run. */
  nowMs: number;
  /** Terminal rows that finished more than this many days ago are deleted. */
  retentionDays: number;
  batchSize?: number;
  maxBatches?: number;
}

/** Outcome of one bounded pass over terminal job rows (Section 10). */
export interface JobPruneResult {
  /** Rows deleted in this run. */
  deleted: number;
  /** Rows had to finish before this epoch-ms instant to be deleted. */
  cutoffMs: number;
  /** Statements executed. */
  batches: number;
  /** True when the batch cap stopped the run with rows still eligible. */
  capped: boolean;
}

/**
 * Delete terminal job rows (`succeeded`, `failed`, `cancelled`) that finished
 * before the retention cutoff (Section 10). Rows that are `queued` or `running`
 * are never touched, whatever their age. The completion instant is
 * `completed_at_ms`, or `updated_at_ms` for a terminal row that never recorded
 * one.
 *
 * The delete runs in bounded batches, each its own short autocommit statement,
 * so a large backlog cannot hold the write connection (Section 28 short
 * transactions). The candidate scan is anchored on `created_at_ms` — every job
 * is created before it finishes, so `created_at_ms < cutoff` is a necessary
 * condition that rides `jobs_created_idx` and stops at the cutoff instead of
 * walking every terminal row. `INDEXED BY` pins that choice: without table
 * statistics the planner prefers the `status` equality index, which walks every
 * terminal row on every batch and sorts through a temp B-tree.
 */
export function pruneTerminalJobs(db: DatabaseSync, options: PruneJobsOptions): JobPruneResult {
  const batchSize = Math.max(1, options.batchSize ?? JOB_PRUNE_BATCH_SIZE);
  const maxBatches = Math.max(1, options.maxBatches ?? JOB_PRUNE_MAX_BATCHES);
  const cutoffMs = options.nowMs - options.retentionDays * 86_400_000;
  const statuses = TERMINAL_JOB_STATUSES.map(() => '?').join(', ');
  const statement = db.prepare(
    `DELETE FROM jobs WHERE id IN (
       SELECT id FROM jobs INDEXED BY jobs_created_idx
        WHERE created_at_ms < ?
          AND status IN (${statuses})
          AND COALESCE(completed_at_ms, updated_at_ms) < ?
          AND NOT EXISTS (SELECT 1 FROM deletion_requests d WHERE d.job_id = jobs.id
            AND d.status IN ('scheduled', 'executing'))
        ORDER BY created_at_ms
        LIMIT ?)`,
  );
  let deleted = 0;
  let batches = 0;
  let lastChanges = batchSize;
  while (lastChanges >= batchSize && batches < maxBatches) {
    lastChanges = Number(statement.run(cutoffMs, ...TERMINAL_JOB_STATUSES, cutoffMs, batchSize).changes);
    deleted += lastChanges;
    batches += 1;
  }
  return { deleted, cutoffMs, batches, capped: lastChanges >= batchSize };
}

/** Full bundle of maintenance outcomes, for reporting. */
export interface MaintenanceOutcome {
  optimize: { ran: boolean };
  checkpoint: WalCheckpointResult;
  /** Present only when `integrity: true` was requested. */
  integrity: IntegrityCheckResult | null;
  /** Present only when `vacuum: true` was requested. */
  vacuum: VacuumResult | null;
  /** Present only when `pruneJobs` was requested. */
  jobsPruned: JobPruneResult | null;
}

export interface RunMaintenanceOptions {
  /** Run `PRAGMA integrity_check` (default `false`: the periodic bundle stays light). */
  integrity?: boolean;
  /** Run `VACUUM` + the mandatory FTS rebuild (default `false`: VACUUM is opt-in). */
  vacuum?: boolean;
  /** WAL checkpoint mode (default `PASSIVE`). */
  checkpointMode?: WalCheckpointMode;
  /** Prune terminal job rows past retention (absent: no pruning). */
  pruneJobs?: PruneJobsOptions;
}

/**
 * Run the maintenance bundle: `PRAGMA optimize`, a WAL checkpoint, and — only
 * when requested — an integrity check, a `VACUUM` followed by the mandatory FTS
 * rebuild (Section 28), and a bounded prune of terminal job rows (Section 10).
 * Each step reports its own outcome; a failed VACUUM skips only its own FTS
 * rebuild. The prune runs before the VACUUM so a VACUUM reclaims the space it
 * frees. Nothing here copies the live `.sqlite` file — the functions take the
 * open connection and run statements on it.
 */
export function runMaintenance(db: DatabaseSync, options: RunMaintenanceOptions = {}): MaintenanceOutcome {
  pragmaOptimize(db);
  const checkpoint = walCheckpoint(db, options.checkpointMode ?? 'PASSIVE');
  const integrity = options.integrity ? runIntegrityCheck(db) : null;
  const jobsPruned = options.pruneJobs ? pruneTerminalJobs(db, options.pruneJobs) : null;
  const vacuum = options.vacuum ? vacuumAndRebuildFts(db) : null;
  return { optimize: { ran: true }, checkpoint, integrity, vacuum, jobsPruned };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
