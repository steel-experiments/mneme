import { type DatabaseSync, transaction } from '../db/database.js';
import type { SQLInputValue } from 'node:sqlite';
import { prepareCached } from '../db/repositories/util.js';
import { recomputeMemoryScopes } from './search.js';

/**
 * Host-side memory maintenance: cached-scope convergence (Sections 7.2, 27) and
 * staleness expiry for long-overdue review dates (Section 12.4).
 *
 * The effective scope of a memory is recomputed at read time from its evidence
 * channels' current visibility — that recomputation is the enforcement
 * boundary, so a reclassified channel tightens results immediately. This job
 * only converges the *cached* `scope_type`/`scope_key` columns to the current
 * policy and records each material change in `admin_events` for auditability;
 * it never changes what a run can read.
 */

export interface ScopeSnapshot {
  scopeType: string;
  scopeKey: string | null;
}

export interface ScopeChange {
  memoryId: string;
  from: ScopeSnapshot;
  to: ScopeSnapshot;
}

export interface RescopeOptions {
  /**
   * Channel ids whose policy changed. Only memories with evidence in these
   * channels (or in threads under them) are rescoped. Null rescopes every
   * memory — used by `reload-policy` (Section 7.2).
   */
  affectedChannelIds?: readonly string[] | null;
  /** Admin/system actor recorded on each audit event. */
  actorUserId: string;
  guildId: string;
  now: number;
}

export interface RescopeResult {
  scanned: number;
  changed: number;
  changes: ScopeChange[];
}

function snapshotEqual(a: ScopeSnapshot, b: ScopeSnapshot): boolean {
  return a.scopeType === b.scopeType && a.scopeKey === b.scopeKey;
}

export interface ExpireStaleMemoriesOptions {
  /** Staleness horizon in milliseconds; 0 disables the sweep (Section 12.4). */
  horizonMs: number;
  /** Admin/system actor recorded on each audit event. */
  actorUserId: string;
  guildId: string;
  now: number;
  /** Rows expired per transaction (default 250). */
  batchSize?: number;
}

export interface ExpireStaleMemoriesResult {
  /** Memory ids transitioned to `expired` this pass. */
  expiredIds: string[];
}

export const STALE_MEMORY_EXPIRY_BATCH_SIZE = 250;

/**
 * Expire memories whose review date passed more than the horizon ago with no
 * evidence message inside the horizon (Section 12.4). The newest evidence
 * message is the human-activity anchor: a reply or confirmation moves it, while
 * extraction of an old conversation does not, so backfilled memories about
 * long-quiet threads expire like any other stale item. This is a host-only
 * transition: it needs no new evidence and no model run, so it does not go
 * through the proposal-validated repository mutations. Memories owned by a
 * queued or running scheduled-review cohort are skipped and picked up on a
 * later pass. Each expiry writes one content-free `admin_events` row. Re-running
 * the sweep is a safe no-op.
 */
export function expireStaleMemories(
  db: DatabaseSync,
  options: ExpireStaleMemoriesOptions,
): ExpireStaleMemoriesResult {
  const { actorUserId, guildId, now } = options;
  if (options.horizonMs <= 0) return { expiredIds: [] };
  const cutoff = now - options.horizonMs;
  const batchSize = options.batchSize ?? STALE_MEMORY_EXPIRY_BATCH_SIZE;
  const expiredIds: string[] = [];

  for (;;) {
    const batch = transaction(db, () => {
      const rows = prepareCached(
        db,
        'stale.candidates',
        `SELECT id, review_after_ms,
                COALESCE((
                  SELECT MAX(msg.created_at_ms) FROM memory_evidence me2
                    JOIN messages msg ON msg.id = me2.message_id
                   WHERE me2.memory_id = mem.id), 0) AS newest_evidence_at_ms
           FROM memories mem
          WHERE mem.status = 'active'
            AND mem.review_after_ms IS NOT NULL
            AND mem.review_after_ms <= ?
            AND COALESCE((
              SELECT MAX(msg.created_at_ms) FROM memory_evidence me2
                JOIN messages msg ON msg.id = me2.message_id
               WHERE me2.memory_id = mem.id), 0) <= ?
            AND NOT EXISTS (
              SELECT 1 FROM scheduled_review_cohort_subject_leases lease
               JOIN jobs job ON job.id = lease.job_id
              WHERE lease.memory_id = mem.id AND job.status IN ('queued', 'running')
            )
          ORDER BY mem.id
          LIMIT ?`,
      ).all(cutoff, cutoff, batchSize) as Array<{
        id: string;
        review_after_ms: number;
        newest_evidence_at_ms: number;
      }>;

      const updateStmt = prepareCached(
        db,
        'stale.update',
        "UPDATE memories SET status = 'expired', updated_at_ms = ? WHERE id = ? AND status = 'active'",
      );
      const eventStmt = prepareCached(
        db,
        'stale.event',
        `INSERT INTO admin_events (id, workspace_id, actor_user_id, action, target, details_json, created_at_ms)
         VALUES (?, ?, ?, 'memory_staleness_expire', ?, ?, ?)`,
      );

      const ids: string[] = [];
      for (const row of rows) {
        updateStmt.run(now, row.id);
        eventStmt.run(
          `ae_stale_${row.id}_${now}`,
          guildId,
          actorUserId,
          row.id,
          JSON.stringify({
            reviewAfterMs: Number(row.review_after_ms),
            newestEvidenceAtMs: Number(row.newest_evidence_at_ms),
            horizonMs: options.horizonMs,
          }),
          now,
        );
        ids.push(row.id);
      }
      return ids;
    });
    expiredIds.push(...batch);
    if (batch.length < batchSize) break;
  }

  return { expiredIds };
}

/**
 * Rewrite cached memory scopes to match the current channel policy and audit
 * every material change. Returns the set of changes (empty when the cache was
 * already converged). Read-time recomputation remains authoritative either way.
 */
export function rescopeMemories(db: DatabaseSync, options: RescopeOptions): RescopeResult {
  const { actorUserId, guildId, now } = options;
  const affected = options.affectedChannelIds ?? null;

  return transaction(db, () => {
    // Candidate memory ids: those with evidence in an affected channel (or its
    // threads), or every memory when no filter is supplied.
    let candidateIds: string[];
    if (affected && affected.length > 0) {
      const ph = affected.map(() => '?').join(',');
      const rows = prepareCached(
        db,
        `rescope.candidates:${affected.length}`,
        `SELECT DISTINCT me.memory_id
           FROM memory_evidence me
           JOIN messages m ON m.id = me.message_id
           JOIN channels c ON c.id = m.channel_id
          WHERE m.channel_id IN (${ph})
             OR (c.is_thread = 1 AND c.parent_id IN (${ph}))`,
      ).all(...affected, ...affected) as Array<{ memory_id: string }>;
      candidateIds = rows.map((r) => r.memory_id);
    } else {
      candidateIds = (
        prepareCached(db, 'rescope.candidates:all', 'SELECT id FROM memories').all() as Array<{
          id: string;
        }>
      ).map((r) => r.id);
    }

    if (candidateIds.length === 0) {
      return { scanned: 0, changed: 0, changes: [] };
    }

    const recomputed = recomputeMemoryScopes(db, candidateIds);

    // Read the stored cache for every candidate in one pass.
    const ph = candidateIds.map(() => '?').join(',');
    const storedRows = prepareCached(
      db,
      `rescope.stored:${candidateIds.length}`,
      `SELECT id, scope_type, scope_key FROM memories WHERE id IN (${ph})`,
    ).all(...candidateIds) as Array<{ id: string; scope_type: string; scope_key: string | null }>;

    const changes: ScopeChange[] = [];
    const updateStmt = prepareCached(
      db,
      'rescope.update',
      'UPDATE memories SET scope_type = ?, scope_key = ?, updated_at_ms = ? WHERE id = ?',
    );
    const eventStmt = prepareCached(
      db,
      'rescope.event',
      `INSERT INTO admin_events (id, workspace_id, actor_user_id, action, target, details_json, created_at_ms)
       VALUES (?, ?, ?, 'memory_rescope', ?, ?, ?)`,
    );

    for (const row of storedRows) {
      const next = recomputed.get(row.id);
      if (!next) continue;
      const from: ScopeSnapshot = {
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
      };
      const to: ScopeSnapshot = { scopeType: next.scopeType, scopeKey: next.scopeKey };
      if (snapshotEqual(from, to)) continue;

      const params: SQLInputValue[] = [
        to.scopeType,
        to.scopeKey,
        now,
        row.id,
      ];
      updateStmt.run(...params);
      eventStmt.run(
        `ae_${row.id}_${now}`,
        guildId,
        actorUserId,
        row.id,
        JSON.stringify({ from, to }),
        now,
      );
      changes.push({ memoryId: row.id, from, to });
    }

    return { scanned: candidateIds.length, changed: changes.length, changes };
  });
}
