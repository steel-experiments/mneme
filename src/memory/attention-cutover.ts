// ABOUTME: Versioned, bounded, idempotent startup cutover of legacy proactive
// ABOUTME: state onto attention subjects, revisions, and consumption (Section 12.7).
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';
import { getMessage } from '../db/repositories/messages.js';
import { enqueueProposalDeliverySync } from '../outbox/proposal-delivery.js';
import {
  ensureSubjectForMember,
  findConsumedTriggerMessageIds,
  registerLegacyConsumedRevision,
  selectRegistrationCandidates,
} from './attention-repository.js';
import { DEFAULT_ATTENTION_WINDOW_MS } from './attention.js';

/** Bump when the cutover algorithm changes; each version runs once per database. */
export const ATTENTION_CUTOVER_VERSION = 2;

/** Batch size for the legacy baseline and expiry drains. */
const LEGACY_BASELINE_LIMIT = 500;
/** Safety ceiling for the drains; far above any real backlog. */
const LEGACY_DRAIN_MAX_BATCHES = 10_000;

/** Upper bound on subjects marked for registration per pass. */
const REGISTRATION_MARK_LIMIT = 50;

export interface AttentionCutoverReport {
  version: number;
  /** True when this version already ran; the pass was a no-op. */
  alreadyComplete: boolean;
  legacyProposalsBaselined: number;
  pendingProposalsExpired: number;
  queuedDeliveriesCancelled: number;
  legacyCohortsCancelled: number;
  registrationSubjectsMarked: number;
}

export interface AttentionCutoverOptions {
  now: number;
  guildId: string;
  actorUserId: string;
  attentionWindowMs?: number;
}

function cutoverMarkerId(version: number): string {
  return `attention_cutover_v${version}`;
}

/**
 * Cut legacy proactive state over to attention without resurfacing the
 * backlog. Applying migration 038 confers no attention authority: this pass is
 * what marks previously surfaced evidence as consumed. It runs inside one
 * immediate transaction, performs no Discord or model I/O, writes its version
 * marker atomically with the work, and a second run is a no-op.
 */
export function runAttentionCutover(
  db: DatabaseSync,
  options: AttentionCutoverOptions,
): AttentionCutoverReport {
  const markerId = cutoverMarkerId(ATTENTION_CUTOVER_VERSION);
  const existing = db.prepare('SELECT id FROM admin_events WHERE id = ?').get(markerId);
  if (existing) {
    return {
      version: ATTENTION_CUTOVER_VERSION,
      alreadyComplete: true,
      legacyProposalsBaselined: 0,
      pendingProposalsExpired: 0,
      queuedDeliveriesCancelled: 0,
      legacyCohortsCancelled: 0,
      registrationSubjectsMarked: 0,
    };
  }

  const windowMs = options.attentionWindowMs ?? DEFAULT_ATTENTION_WINDOW_MS;
  let baselined = 0;
  let expired = 0;
  let cancelledDeliveries = 0;
  let cancelledCohorts = 0;
  let markedSubjects = 0;
  const expiredProposalIds: string[] = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Baseline evidence behind every previously surfaced or possibly
    //    surfaced proposal as consumed, so historical triggers cannot return
    //    as fresh. Observed proposals never surfaced anything and are skipped.
    //    The drain runs in bounded batches until a short batch: a one-shot cap
    //    would leave the newest surfaced evidence unconsumed forever.
    const legacyQuery = prepareCached(
      db,
      'attention.cutover.legacy_proposals',
      `SELECT p.id AS id, p.created_at_ms, p.evidence_message_ids_json AS evidence_json,
              ar.run_type AS run_type
         FROM proposals p
         JOIN agent_runs ar ON ar.id = p.run_id
        WHERE ar.run_type IN ('episode', 'scheduled_review')
          AND ar.workspace_id = @guildId
          AND p.status IN ('pending_review', 'approved', 'sent', 'dismissed', 'expired', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM proposal_attention_claims c WHERE c.proposal_id = p.id
          )
          AND (@afterMs IS NULL OR (p.created_at_ms, p.id) > (@afterMs, @afterId))
        ORDER BY p.created_at_ms, p.id
        LIMIT @limit`,
    );
    type LegacyRow = {
      id: string;
      created_at_ms: number;
      evidence_json: string;
      run_type: string;
    };
    let afterMs: number | null = null;
    let afterId = '';
    for (let batchIndex = 0; ; batchIndex += 1) {
      const legacy = legacyQuery.all({
        guildId: options.guildId, afterMs, afterId, limit: LEGACY_BASELINE_LIMIT,
      }) as LegacyRow[];
      if (legacy.length === 0) break;
      if (batchIndex >= LEGACY_DRAIN_MAX_BATCHES) {
        throw new Error('attention cutover exceeded its legacy baseline bound');
      }
      for (const proposal of legacy) {
        let evidenceIds: string[] = [];
        try {
          const parsed = JSON.parse(proposal.evidence_json) as unknown;
          if (Array.isArray(parsed)) {
            evidenceIds = parsed.filter((id): id is string => typeof id === 'string');
          }
        } catch {
          evidenceIds = [];
        }
        evidenceIds = [...new Set(evidenceIds)].filter((id) =>
          getMessage(db, id)?.workspace_id === options.guildId);
        if (evidenceIds.length === 0) continue;
        const covered = findConsumedTriggerMessageIds(db, options.guildId, evidenceIds);
        if (evidenceIds.every((id) => covered.has(id))) continue;
        // Resolve the subject through stored memory-evidence relationships:
        // a memory the proposal's citations support is the same issue.
        const placeholders = evidenceIds.map(() => '?').join(', ');
        const related = prepareCached(
          db,
          `attention.cutover.related_memories:${evidenceIds.length}`,
          `SELECT DISTINCT me.memory_id AS memory_id
             FROM memory_evidence me
            WHERE me.message_id IN (${placeholders})`,
        ).all(...evidenceIds) as Array<{ memory_id: string }>;

        if (related.length > 0) {
          for (const row of related) {
            const subjectId = ensureSubjectForMember(db, {
              guildId: options.guildId, memoryId: row.memory_id, now: options.now,
            });
            registerLegacyConsumedRevision(db, {
              subjectId,
              triggerMessageIds: evidenceIds,
              consumedAtMs: options.now,
              now: options.now,
            });
          }
        } else {
          // Ambiguous legacy mapping: suppress reuse of the historical trigger
          // evidence under its existing visibility scope without declaring it
          // fresh. A member-less subject holds the consumed evidence.
          const syntheticSubject = randomUUID();
          prepareCached(
            db,
            'attention.cutover.synthetic_subject',
            `INSERT INTO attention_subjects (id, workspace_id, registration_state, created_at_ms)
             VALUES (?, ?, 'complete', ?)`,
          ).run(syntheticSubject, options.guildId, options.now);
          registerLegacyConsumedRevision(db, {
            subjectId: syntheticSubject,
            triggerMessageIds: evidenceIds,
            consumedAtMs: options.now,
            now: options.now,
          });
        }
        baselined += 1;
      }
      const last = legacy[legacy.length - 1]!;
      afterMs = last.created_at_ms;
      afterId = last.id;
      if (legacy.length < LEGACY_BASELINE_LIMIT) break;
    }

    // 2. Expire pending legacy proactive proposals lacking attention
    //    authority, preserve sent records, and cancel queued unsent
    //    proposal-backed deliveries. Uncertain `sending` rows stay for marker
    //    reconciliation, which runs after this pass.
    const pendingQuery = prepareCached(
      db,
      'attention.cutover.pending_proposals',
      `SELECT p.id AS id
         FROM proposals p
         JOIN agent_runs ar ON ar.id = p.run_id
        WHERE ar.run_type IN ('episode', 'scheduled_review')
          AND p.status IN ('pending_review', 'approved')
          AND NOT EXISTS (
            SELECT 1 FROM proposal_attention_claims c
             WHERE c.proposal_id = p.id
          )
        ORDER BY p.created_at_ms, p.id
        LIMIT ?`,
    );
    let pendingBatch = pendingQuery.all(LEGACY_BASELINE_LIMIT) as Array<{ id: string }>;
    for (let batchIndex = 0; pendingBatch.length > 0; batchIndex += 1) {
      if (batchIndex >= LEGACY_DRAIN_MAX_BATCHES) {
        throw new Error('attention cutover exceeded its pending proposal bound');
      }
      for (const row of pendingBatch) {
        const changed = prepareCached(
          db,
          'attention.cutover.expire_proposal',
          `UPDATE proposals SET status = 'expired', updated_at_ms = ?
             WHERE id = ? AND status IN ('pending_review', 'approved')`,
        ).run(options.now, row.id);
        if (Number(changed.changes) === 0) continue;
        expired += 1;
        expiredProposalIds.push(row.id);
        const cancelled = prepareCached(
          db,
          'attention.cutover.cancel_outbox',
          `UPDATE outbox SET status = 'cancelled', updated_at_ms = ?, last_error = 'attention cutover: legacy proposal expired'
             WHERE proposal_id = ? AND status = 'queued'`,
        ).run(options.now, row.id);
        cancelledDeliveries += Number(cancelled.changes);
        enqueueProposalDeliverySync(db, row.id, options.now);
      }
      // Expired rows no longer match the pending query, so the drain
      // converges; a short batch ends it.
      if (pendingBatch.length < LEGACY_BASELINE_LIMIT) break;
      pendingBatch = pendingQuery.all(LEGACY_BASELINE_LIMIT) as typeof pendingBatch;
    }

    // 3. Invalidate legacy cohort payloads lacking revision identity. A
    //    missing mode is not permission for registration; later new evidence
    //    produces valid work through the normal dispatcher.
    const staleJobs = prepareCached(
      db,
      'attention.cutover.stale_cohorts',
      `SELECT id, payload_json FROM jobs
        WHERE type = 'review_due_memory_cohort' AND status IN ('queued', 'running')`,
    ).all() as Array<{ id: string; payload_json: string }>;
    for (const job of staleJobs) {
      let mode: unknown;
      try {
        mode = (JSON.parse(job.payload_json) as { mode?: unknown }).mode;
      } catch {
        mode = undefined;
      }
      if (mode === 'attention_review' || mode === 'attention_registration') continue;
      prepareCached(
        db,
        'attention.cutover.cancel_job',
        `UPDATE jobs SET status = 'cancelled', updated_at_ms = ?, completed_at_ms = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
      ).run(options.now, options.now, job.id);
      prepareCached(
        db,
        'attention.cutover.release_lease',
        'DELETE FROM scheduled_review_cohort_subject_leases WHERE job_id = ?',
      ).run(job.id);
      cancelledCohorts += 1;
    }

    // 4. Mark bounded eligible uncovered subjects for registration. This
    //    confers no attention authority; the scoped registration run validates
    //    through the typed contract. Model-written reviewAt is never a
    //    criterion, and no proposal is created here.
    const candidates = selectRegistrationCandidates(db, {
      guildId: options.guildId,
      now: options.now,
      windowMs,
      limit: REGISTRATION_MARK_LIMIT,
    });
    for (const candidate of candidates) {
      if (candidate.subjectId !== null) continue;
      ensureSubjectForMember(db, {
        guildId: options.guildId, memoryId: candidate.memoryId, now: options.now,
      });
      markedSubjects += 1;
    }

    // 5. Version marker, atomically with the work above.
    db.prepare(
      `INSERT INTO admin_events (id, workspace_id, actor_user_id, action, target, details_json, created_at_ms)
       VALUES (?, ?, ?, 'attention_cutover_complete', NULL, ?, ?)`,
    ).run(
      markerId,
      options.guildId,
      options.actorUserId,
      JSON.stringify({ version: ATTENTION_CUTOVER_VERSION }),
      options.now,
    );
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The connection may already have rolled back; the error below is the
      // real failure.
    }
    throw err;
  }

  return {
    version: ATTENTION_CUTOVER_VERSION,
    alreadyComplete: false,
    legacyProposalsBaselined: baselined,
    pendingProposalsExpired: expired,
    queuedDeliveriesCancelled: cancelledDeliveries,
    legacyCohortsCancelled: cancelledCohorts,
    registrationSubjectsMarked: markedSubjects,
  };
}
