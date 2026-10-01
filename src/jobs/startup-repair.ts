import type { DatabaseSync } from '../db/database.js';
import { transactionImmediate } from '../db/database.js';
import { closeEpisodeJobKey, reviewEpisodeJobKey } from '../episodes/builder.js';
import { closeEpisode, markSkipped } from '../episodes/repository.js';
import { cancelJob, enqueue, findActiveUniqueJob, getJob } from './queue.js';
import { enqueueOutbox } from '../outbox/repository.js';
import { enqueueProposalDeliverySync } from '../outbox/proposal-delivery.js';
import {
  ensureDirectAnswerRequest,
  type DirectAnswerRequestRow,
} from '../db/repositories/direct-answers.js';
import {
  DIRECT_ANSWER_PRIORITY,
  directAnswerJobKey,
} from './direct-answer-identity.js';
import { isMnemeTestSurface } from '../ingestion/test-channels.js';
import {
  expirePendingProposals,
  PROPOSAL_EXPIRY_BATCH_SIZE,
} from '../db/repositories/proposals.js';
import { validateScheduledProposalDelivery } from '../memory/scheduled-delivery.js';
import type { ScheduledRouteOptions } from '../memory/scheduled-routing.js';
import { listPendingIngestionRecoveries } from '../db/repositories/ingestion-recovery.js';

export interface StartupRepairReport {
  proposalsExpired: number;
  scheduledReviewCardsFailed: number;
  reviewsReset: number;
  reviewJobs: number;
  closeJobs: number;
  backfillJobs: number;
  approvedOutboxes: number;
  proposalReviewSyncJobs: number;
  purgeJobs: number;
  directAnswerJobs: number;
  channelPolicyReviewJobs: number;
  deepRecapJobs: number;
  deepRecapRunningJobsRecovered: number;
  deepRecapDuplicateJobsCancelled: number;
  deepRecapChunksReset: number;
  ingestionRecoveryJobs: number;
}

export interface DeepRecapOwnershipRepairReport {
  jobsEnqueued: number;
  chunksReset: number;
  duplicateJobsCancelled: number;
  runningJobsRecovered: number;
}

interface ActiveDeepRecapOwner {
  id: string;
  status: 'queued' | 'running';
}

interface RunningDeepRecapOwner {
  id: string;
  recapId: string;
  leaseUntilMs: number | null;
}

function activeDeepRecapOwners(db: DatabaseSync, recapId: string): ActiveDeepRecapOwner[] {
  return db.prepare(`SELECT id,status FROM jobs
    WHERE type='deep_recap' AND status IN ('queued','running')
      AND CASE WHEN json_valid(payload_json)
               THEN json_extract(payload_json,'$.recapId')
               ELSE NULL END=?
    ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
             updated_at_ms DESC,created_at_ms ASC,id ASC`).all(recapId) as unknown as ActiveDeepRecapOwner[];
}

/**
 * Restore exactly one durable owner for every nonterminal deep recap.
 *
 * Historical continuation jobs did not always carry a unique key, so ownership
 * is resolved from the validated payload rather than `unique_key`. A chunk is
 * reset from `running` only when its prior owner is recovered or the request is
 * proven ownerless. Duplicate queued owners are cancelled while a running owner
 * is preserved; periodic maintenance may call this while a recap handler is active.
 */
function repairDeepRecapOwnershipInTransaction(
  db: DatabaseSync,
  now: number,
  mode: 'startup' | 'periodic',
): DeepRecapOwnershipRepairReport {
  let jobsEnqueued = 0;
  let chunksReset = 0;
  let duplicateJobsCancelled = 0;
  // No handler from the prior process can still be live during startup. During
  // periodic repair only a NULL lease is provably impossible for a claimed job;
  // an expired non-NULL lease can still belong to a long in-process handler.
  const runningOwners = db.prepare(`SELECT j.id,r.id AS recap_id,j.lease_until_ms
    FROM jobs j
    JOIN deep_recap_requests r
      ON r.id=CASE WHEN json_valid(j.payload_json)
                   THEN json_extract(j.payload_json,'$.recapId')
                   ELSE NULL END
    WHERE j.type='deep_recap' AND j.status='running'
      AND r.status IN ('queued','running','synthesizing')`).all() as unknown as Array<{
        id: string; recap_id: string; lease_until_ms: number | null;
      }>;
  const normalizedOwners: RunningDeepRecapOwner[] = runningOwners
    .map((owner) => ({
      id: owner.id,
      recapId: owner.recap_id,
      leaseUntilMs: owner.lease_until_ms,
    }))
    .filter((owner) => mode === 'startup' || owner.leaseUntilMs === null);
  const resetRecoveredChunks = new Set(normalizedOwners
    .filter((owner) => mode === 'startup' || !runningOwners.some((candidate) =>
      candidate.recap_id === owner.recapId && candidate.lease_until_ms !== null))
    .map((owner) => owner.recapId));
  for (const recapId of resetRecoveredChunks) {
    chunksReset += Number(db.prepare(`UPDATE deep_recap_chunks
      SET status='pending',updated_at_ms=?
      WHERE request_id=? AND status='running'`).run(now, recapId).changes);
  }
  const recoverRunningJob = db.prepare(`UPDATE jobs
    SET status='queued',run_after_ms=?,
        attempts=CASE WHEN EXISTS (
          SELECT 1 FROM deep_recap_chunks c
           WHERE c.request_id=? AND c.status='completed'
             AND c.updated_at_ms>=jobs.updated_at_ms
        ) THEN 0 ELSE attempts END,
        lease_owner=NULL,lease_until_ms=NULL,last_error=NULL,updated_at_ms=?
    WHERE id=? AND status='running'`);
  let runningJobsRecovered = 0;
  for (const owner of normalizedOwners) {
    runningJobsRecovered += Number(
      recoverRunningJob.run(now, owner.recapId, now, owner.id).changes,
    );
  }
  const pendingRecaps = db.prepare(`SELECT id FROM deep_recap_requests
    WHERE status IN ('queued','running','synthesizing')`).all() as Array<{ id: string }>;
  for (const row of pendingRecaps) {
    let owners = activeDeepRecapOwners(db, row.id);
    if (owners.length > 1) {
      const runningOwners = owners.filter((owner) => owner.status === 'running');
      if (runningOwners.length > 1) {
        // Database cancellation cannot stop an executing handler. With no safe
        // way to identify the live row, roll back and let the maintenance job
        // alert rather than permit overlapping writes.
        throw new Error('multiple running deep recap owners require operator recovery');
      }
      const keeper = runningOwners[0] ?? owners[0]!;
      for (const duplicate of owners.filter((owner) => owner.id !== keeper.id)) {
        if (duplicate.status !== 'queued') {
          throw new Error('running deep recap owner cannot be cancelled safely');
        }
        if (!cancelJob(db, duplicate.id, now)) {
          throw new Error('duplicate deep recap owner could not be cancelled');
        }
        duplicateJobsCancelled += 1;
      }
      owners = activeDeepRecapOwners(db, row.id);
    }
    if (owners.length === 0) {
      chunksReset += Number(db.prepare(`UPDATE deep_recap_chunks
        SET status='pending',updated_at_ms=?
        WHERE request_id=? AND status='running'`).run(now, row.id).changes);
      const enqueued = enqueue(db, {
        type: 'deep_recap', payload: { recapId: row.id },
        uniqueKey: `deep-recap:${row.id}`, priority: 30, maxAttempts: 3, now,
      });
      if (enqueued.enqueued) jobsEnqueued += 1;
      owners = activeDeepRecapOwners(db, row.id);
    }
    if (owners.length === 1) {
      // Upgrade historical unkeyed continuation rows so the queue's partial
      // unique index enforces this ownership invariant after the repair pass.
      db.prepare(`UPDATE jobs SET unique_key=?,updated_at_ms=?
        WHERE id=? AND unique_key IS NULL AND status IN ('queued','running')`)
        .run(`deep-recap:${row.id}`, now, owners[0]!.id);
    }
    // The immediate transaction excludes concurrent queue mutations. A failed
    // consolidation or collapsed enqueue therefore rolls the whole repair back.
    if (owners.length !== 1) {
      throw new Error('nonterminal deep recap does not have exactly one active repair owner');
    }
  }
  return { jobsEnqueued, chunksReset, duplicateJobsCancelled, runningJobsRecovered };
}

/** Reconcile deep-recap ownership independently of the full startup pass. */
export function repairDeepRecapOwnership(
  db: DatabaseSync,
  input: { now: number },
): DeepRecapOwnershipRepairReport {
  return transactionImmediate(db, () => repairDeepRecapOwnershipInTransaction(db, input.now, 'periodic'));
}

/** Restore domain work that older crashes could leave without an active job. */
export function repairDurableWork(db: DatabaseSync, input: {
  now: number;
  quietSeconds: number;
  fullHistory?: boolean;
  scheduledRouteOptions?: ScheduledRouteOptions;
}): StartupRepairReport {
  return transactionImmediate(db, () => {
    db.prepare(
      `DELETE FROM scheduled_review_cohort_subject_leases
        WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = scheduled_review_cohort_subject_leases.job_id)
           OR job_id IN (SELECT id FROM jobs WHERE status IN ('succeeded', 'failed', 'cancelled'))`,
    ).run();
    // Proposal deadlines are authoritative even when the process was offline.
    // Drain them synchronously before interactions are registered. Each UPDATE
    // has a fixed row bound; the surrounding startup-repair transaction still
    // covers the complete repair pass. Re-running after a restart is a no-op
    // once rows are expired.
    let proposalsExpired = 0;
    for (;;) {
      const batch = expirePendingProposals(db, input.now, PROPOSAL_EXPIRY_BATCH_SIZE);
      proposalsExpired += batch.length;
      if (batch.length < PROPOSAL_EXPIRY_BATCH_SIZE) break;
    }
    // Migration 031 intentionally invalidates legacy scheduled proposals whose
    // delivery target was the approval inbox (or whose current subject route
    // otherwise drifted). Reconcile them before registering interactions so a
    // stale button can never approve the old destination after a restart.
    if (input.scheduledRouteOptions) {
      const pendingScheduled = db.prepare(`SELECT p.id
          FROM proposals p
          JOIN agent_runs ar ON ar.id = p.run_id
         WHERE p.status = 'pending_review' AND ar.run_type = 'scheduled_review'`)
        .all() as Array<{ id: string }>;
      for (const row of pendingScheduled) {
        const current = validateScheduledProposalDelivery(
          db,
          row.id,
          input.scheduledRouteOptions,
          input.now,
        );
        if (current.allow) continue;
        const changed = db.prepare(
          "UPDATE proposals SET status='expired',updated_at_ms=? WHERE id=? AND status='pending_review'",
        ).run(input.now, row.id).changes;
        if (changed) {
          proposalsExpired += 1;
          enqueueProposalDeliverySync(db, row.id, input.now);
        }
      }
    }
    const scheduledReviewCardsFailed = Number(db.prepare(
      `UPDATE proposals
          SET status = 'failed', updated_at_ms = ?
        WHERE status = 'pending_review'
          AND review_message_id IS NULL
          AND EXISTS (
            SELECT 1 FROM agent_runs ar
             WHERE ar.id = proposals.run_id AND ar.run_type = 'scheduled_review'
          )`,
    ).run(input.now).changes);

    let reviewsReset = 0;
    const reviewing = db.prepare(
      "SELECT id,conversation_channel_id FROM episodes WHERE status='reviewing'",
    ).all() as Array<{ id: string; conversation_channel_id: string }>;
    const resetReview = db.prepare(
      "UPDATE episodes SET status='queued', updated_at_ms=? WHERE id=? AND status='reviewing'",
    );
    for (const row of reviewing) {
      if (isMnemeTestSurface(db, row.conversation_channel_id)) {
        markSkipped(db, row.id, input.now);
      } else {
        reviewsReset += Number(resetReview.run(input.now, row.id).changes);
      }
    }
    let reviewJobs = 0;
    const queued = db.prepare(
      "SELECT id,conversation_channel_id FROM episodes WHERE status='queued'",
    ).all() as Array<{ id: string; conversation_channel_id: string }>;
    for (const row of queued) {
      if (isMnemeTestSurface(db, row.conversation_channel_id)) {
        markSkipped(db, row.id, input.now);
        continue;
      }
      if (enqueue(db, { type: 'review_episode', payload: { episodeId: row.id },
        uniqueKey: reviewEpisodeJobKey(row.id), now: input.now }).enqueued) reviewJobs++;
    }

    let closeJobs = 0;
    const open = db.prepare(
      "SELECT id,last_activity_at_ms,conversation_channel_id FROM episodes WHERE status='open'",
    ).all() as Array<{ id: string; last_activity_at_ms: number; conversation_channel_id: string }>;
    for (const row of open) {
      if (isMnemeTestSurface(db, row.conversation_channel_id)) {
        const closed = closeEpisode(db, row.conversation_channel_id, input.now);
        if (closed) markSkipped(db, closed, input.now);
        continue;
      }
      if (enqueue(db, { type: 'close_episode', payload: { episodeId: row.id },
        uniqueKey: closeEpisodeJobKey(row.id),
        runAfterMs: row.last_activity_at_ms + input.quietSeconds * 1000, now: input.now }).enqueued) closeJobs++;
    }

    let backfillJobs = 0;
    const cursors = input.fullHistory === false ? [] : db.prepare(`SELECT sc.channel_id
      FROM sync_cursors sc JOIN channels c ON c.id=sc.channel_id
      WHERE sc.history_complete=0 AND c.ingest_enabled=1 AND c.visibility_class<>'excluded'
        AND c.deleted_at_ms IS NULL`).all() as Array<{ channel_id: string }>;
    for (const row of cursors) {
      if (isMnemeTestSurface(db, row.channel_id)) continue;
      if (enqueue(db, { type: 'backfill_channel', payload: { channelId: row.channel_id },
        uniqueKey: `backfill:${row.channel_id}`, now: input.now }).enqueued) backfillJobs++;
    }

    let approvedOutboxes = 0;
    const approved = db.prepare(`SELECT p.id,p.run_id,p.target_channel_id,p.message,p.reply_to_message_id
      FROM proposals p LEFT JOIN outbox o ON o.proposal_id=p.id
      WHERE p.status='approved' AND p.message IS NOT NULL AND o.id IS NULL`).all() as Array<{
        id: string; run_id: string; target_channel_id: string; message: string; reply_to_message_id: string | null;
      }>;
    for (const row of approved) {
      if (input.scheduledRouteOptions) {
        const current = validateScheduledProposalDelivery(
          db,
          row.id,
          input.scheduledRouteOptions,
          input.now,
        );
        if (current.scheduled && !current.allow) {
          db.prepare("UPDATE proposals SET status='expired',updated_at_ms=? WHERE id=? AND status='approved'")
            .run(input.now, row.id);
          enqueueProposalDeliverySync(db, row.id, input.now);
          continue;
        }
      }
      if (enqueueOutbox(db, { proposalId: row.id, runId: row.run_id, channelId: row.target_channel_id,
        content: row.message, replyToMessageId: row.reply_to_message_id, now: input.now }).enqueued) approvedOutboxes++;
    }

    let proposalReviewSyncJobs = 0;
    const terminalProposalCards = db.prepare(
      `SELECT p.id
         FROM proposals p
        WHERE p.status IN ('sent', 'failed', 'expired')
          AND p.review_message_id IS NOT NULL
          AND (p.status = 'expired' OR EXISTS (
            SELECT 1 FROM outbox o
             WHERE o.proposal_id = p.id AND o.status IN ('sent', 'failed', 'cancelled')
          ))`,
    ).all() as Array<{ id: string }>;
    for (const row of terminalProposalCards) {
      if (enqueueProposalDeliverySync(db, row.id, input.now)) proposalReviewSyncJobs += 1;
    }

    let purgeJobs = 0;
    const purges = db.prepare("SELECT id FROM attachment_file_purges WHERE status IN ('queued','failed')")
      .all() as Array<{ id: string }>;
    for (const row of purges) {
      if (enqueue(db, { type: 'purge_attachment_file', payload: { purgeId: row.id },
        uniqueKey: `attachment:purge:${row.id}`, now: input.now }).enqueued) purgeJobs++;
    }

    // No handler from the prior process can still be live. Preserve a `sending`
    // review state so the delivery handler performs marker recovery before send.
    db.prepare(`UPDATE jobs SET status='queued',run_after_ms=?,lease_owner=NULL,
      lease_until_ms=NULL,updated_at_ms=?
      WHERE type='deliver_channel_policy_review' AND status='running'`)
      .run(input.now, input.now);
    let channelPolicyReviewJobs = 0;
    const pendingChannelReviews = db.prepare(`SELECT id FROM channel_policy_reviews
      WHERE status='pending' AND delivery_state<>'sent'`).all() as Array<{ id: string }>;
    for (const row of pendingChannelReviews) {
      if (enqueue(db, {
        type: 'deliver_channel_policy_review',
        payload: { reviewId: row.id },
        uniqueKey: `channel-policy-review:${row.id}`,
        priority: 40,
        now: input.now,
      }).enqueued) channelPolicyReviewJobs += 1;
    }

    // A crash or repeated storage failure can exhaust a direct job while its
    // request is deliberately left pending. Recreate one active owner on every
    // startup; the handler will revalidate the exact source/target and either
    // send the fixed fallback or record an intentional suppression.
    let directAnswerJobs = 0;
    const pendingDirect = db.prepare(`SELECT
        source_message_id AS sourceMessageId,
        job_id AS jobId,
        workspace_id AS guildId,
        target_channel_id AS targetChannelId,
        question_created_at_ms AS questionCreatedAtMs,
        deadline_at_ms AS deadlineAtMs,
        started_at_ms AS startedAtMs
      FROM direct_answer_requests
      WHERE outcome_kind = 'pending'`).all() as Array<Pick<DirectAnswerRequestRow,
        'sourceMessageId' | 'jobId' | 'guildId' | 'targetChannelId' | 'questionCreatedAtMs'
        | 'deadlineAtMs' | 'startedAtMs'>>;
    for (const row of pendingDirect) {
      const currentOwner = row.jobId ? getJob(db, row.jobId) : undefined;
      if (
        currentOwner?.type === 'direct_answer'
        && (currentOwner.status === 'queued' || currentOwner.status === 'running')
      ) continue;
      const uniqueKey = directAnswerJobKey(row.sourceMessageId);
      const enqueued = enqueue(db, {
        type: 'direct_answer',
        payload: { messageId: row.sourceMessageId, channelId: row.targetChannelId },
        uniqueKey,
        priority: DIRECT_ANSWER_PRIORITY,
        maxAttempts: 2,
        now: input.now,
      });
      const jobId = enqueued.enqueued
        ? enqueued.id
        : findActiveUniqueJob(db, 'direct_answer', uniqueKey)?.id;
      if (!jobId) throw new Error('pending direct-answer request has no active repair job');
      ensureDirectAnswerRequest(db, {
        sourceMessageId: row.sourceMessageId,
        jobId,
        guildId: row.guildId,
        targetChannelId: row.targetChannelId,
        questionCreatedAtMs: row.questionCreatedAtMs,
        deadlineAtMs: row.deadlineAtMs,
        startedAtMs: row.startedAtMs,
        now: input.now,
      });
      if (enqueued.enqueued) directAnswerJobs += 1;
    }
    let ingestionRecoveryJobs = 0;
    for (const recovery of listPendingIngestionRecoveries(db)) {
      if (enqueue(db, {
        type: 'recover_message',
        payload: { recoveryId: recovery.id, generation: recovery.generation },
        uniqueKey: `recover-message:${recovery.id}`, priority: 20, now: input.now,
      }).enqueued) ingestionRecoveryJobs += 1;
    }
    const deepRecapRepair = repairDeepRecapOwnershipInTransaction(db, input.now, 'startup');
    return {
      proposalsExpired,
      scheduledReviewCardsFailed,
      reviewsReset,
      reviewJobs,
      closeJobs,
      backfillJobs,
      approvedOutboxes,
      proposalReviewSyncJobs,
      purgeJobs,
      directAnswerJobs,
      ingestionRecoveryJobs,
      channelPolicyReviewJobs,
      deepRecapJobs: deepRecapRepair.jobsEnqueued,
      deepRecapRunningJobsRecovered: deepRecapRepair.runningJobsRecovered,
      deepRecapDuplicateJobsCancelled: deepRecapRepair.duplicateJobsCancelled,
      deepRecapChunksReset: deepRecapRepair.chunksReset,
    };
  });
}
