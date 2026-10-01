import { transactionImmediate, type DatabaseSync } from '../../db/database.js';
import { recordAdminEvent } from '../../db/repositories/admin-events.js';
import { getDeletionRequest, DELETION_GRACE_MS } from '../../memory/deletion-requests.js';
import { forgetMessageInTransaction } from '../../memory/deletion.js';
import { continueJobAfterProgress, deferJob, getJob } from '../queue.js';
import type { JobHandler } from '../worker.js';

/** Each bounded batch commits the purge, progress, and continuation together. */
export function createExecuteDeletionHandler(deps: {
  db: DatabaseSync;
  guildId: string;
  deletionApproverUserIds: readonly string[];
  now: () => number;
  batchSize?: number;
}): JobHandler<'execute_deletion'> {
  return async ({ requestId }, job) => {
    const now = deps.now();
    transactionImmediate(deps.db, () => {
      const request = getDeletionRequest(deps.db, requestId, deps.guildId);
      const liveJob = getJob(deps.db, job.id);
      if (!request || request.job_id !== job.id || liveJob?.status !== 'running'
        || liveJob.lease_owner !== job.lease_owner || liveJob.lease_until_ms !== job.lease_until_ms
        || liveJob.attempts !== job.attempts || !['scheduled', 'executing'].includes(request.status)) return;
      if (liveJob.lease_until_ms === null || liveJob.lease_until_ms <= now) {
        // Returning normally without requeue would let the worker mark this
        // unexecuted request succeeded. Acquire a fresh lease on the next pass.
        deferJob(deps.db, job.id, now, 'Deletion lease expired before execution', now);
        return;
      }
      if (!request.approver_user_id || request.approver_user_id === request.requester_user_id
        || !deps.deletionApproverUserIds.includes(request.approver_user_id)
        || request.approved_at_ms === null || request.execute_after_ms === null
        || request.execute_after_ms < request.approved_at_ms + DELETION_GRACE_MS) {
        // Do not resume automatically if authorization is later re-added. A
        // partial purge remains explicitly partial; nothing is restored.
        deps.db.prepare("UPDATE deletion_requests SET status = 'cancelled', completed_at_ms = ? WHERE id = ?").run(now, request.id);
        deps.db.prepare('DELETE FROM deletion_request_messages WHERE request_id = ?').run(request.id);
        recordAdminEvent(deps.db, { guildId: deps.guildId, actorUserId: 'system',
          action: 'deletion_authority_revoked', target: request.id,
          details: { processed: request.processed_count }, createdAtMs: now });
        return;
      }
      if (now < request.execute_after_ms) {
        deferJob(deps.db, job.id, request.execute_after_ms, 'Deletion grace period has not elapsed', now);
        return;
      }
      const rows = deps.db.prepare(`SELECT dm.message_id FROM deletion_request_messages dm
        WHERE dm.request_id = ? ORDER BY dm.message_id LIMIT ?`)
        .all(request.id, Math.max(1, Math.min(deps.batchSize ?? 100, 100))) as Array<{ message_id: string }>;
      if (request.status === 'scheduled') {
        recordAdminEvent(deps.db, { guildId: deps.guildId, actorUserId: request.approver_user_id,
          action: 'deletion_started', target: request.id,
          details: { requesterUserId: request.requester_user_id, messageCount: request.message_count }, createdAtMs: now });
      }
      deps.db.prepare("UPDATE deletion_requests SET status = 'executing' WHERE id = ?").run(request.id);
      for (const row of rows) {
        // Manifest rows are guild-bound again at execution, even though the
        // request captured them inside the configured guild transactionally.
        const source = deps.db.prepare('SELECT workspace_id FROM messages WHERE id = ?').get(row.message_id);
        if (source?.workspace_id !== deps.guildId) throw new Error('Deletion manifest guild mismatch');
        forgetMessageInTransaction(deps.db, { messageId: row.message_id, guildId: deps.guildId,
          actorUserId: request.approver_user_id, nowMs: now });
        deps.db.prepare('DELETE FROM deletion_request_messages WHERE request_id = ? AND message_id = ?').run(request.id, row.message_id);
      }
      deps.db.prepare('UPDATE deletion_requests SET processed_count = processed_count + ? WHERE id = ?').run(rows.length, request.id);
      const remaining = deps.db.prepare('SELECT 1 FROM deletion_request_messages WHERE request_id = ? LIMIT 1').get(request.id);
      if (remaining) {
        // Reuse the leased job, so a crash cannot lose or duplicate continuation.
        continueJobAfterProgress(deps.db, job.id, now, now);
      } else {
        deps.db.prepare("UPDATE deletion_requests SET status = 'completed', completed_at_ms = ? WHERE id = ?").run(now, request.id);
        recordAdminEvent(deps.db, { guildId: deps.guildId, actorUserId: request.approver_user_id,
          action: 'deletion_completed', target: request.id,
          details: { requesterUserId: request.requester_user_id, processed: request.processed_count + rows.length }, createdAtMs: now });
      }
    });
  };
}
