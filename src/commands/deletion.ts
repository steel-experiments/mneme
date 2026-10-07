import { randomUUID } from 'node:crypto';
import { DELETION_GRACE_MS, getDeletionRequest, type DeletionRequest } from '../memory/deletion-requests.js';
import { transactionImmediate, type DatabaseSync } from '../db/database.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import { authorizeAdmin } from '../policy/authorization.js';
import { cancelJob, enqueue, getJob } from '../jobs/queue.js';
import { isPlatformId } from '../platform/ids.js';
import {
  ARCHIVE_ID_PREFIX,
  describeArchiveDeletionTarget,
  isArchiveMessageId,
  isArchiveUserId,
  type ArchiveReader,
} from '../platform-archive/read.js';

export type DeletionSubcommand = 'status' | 'approve' | 'cancel' | 'retry';
export interface DeletionCommandInput {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  invocationChannelId: string;
}
export interface DeletionCommandDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  deletionApproverUserIds: readonly string[];
  reviewChannelId: string | undefined;
  nowMs: number;
  /** The read-only platform archive, when one is configured (plan 011). */
  archive?: ArchiveReader;
}

/** True when a deletion target names a row in the read-only platform archive. */
export function isArchiveTarget(targetId: string): boolean {
  return targetId.startsWith(ARCHIVE_ID_PREFIX);
}

function audit(input: DeletionCommandInput, deps: DeletionCommandDeps, action: string, target: string | null, result: string): void {
  recordAdminEvent(deps.db, { guildId: input.guildId, actorUserId: input.actorUserId,
    action: `deletion_${action}`, target, details: { result }, createdAtMs: deps.nowMs });
}

function access(input: DeletionCommandInput, deps: DeletionCommandDeps): string | undefined {
  if (!authorizeAdmin(input.memberRoleIds, deps.adminRoleIds).authorized) {
    return 'You are not authorized to manage deletion requests.';
  }
  // Counts and identities can disclose restricted activity. Keep every preview
  // and request lookup in the configured secure admin review channel.
  if (!deps.reviewChannelId || input.invocationChannelId !== deps.reviewChannelId) {
    return 'Use deletion commands in the configured secure review channel.';
  }
  return undefined;
}

function describe(db: DatabaseSync, row: DeletionRequest): string {
  const job = row.job_id ? getJob(db, row.job_id) : undefined;
  const progress = `${row.processed_count}/${row.message_count} messages processed`;
  const time = row.execute_after_ms === null ? '' : `; purge no earlier than <t:${Math.floor(row.execute_after_ms / 1000)}:F>`;
  const archiveId = isArchiveTarget(row.target_id) ? row.target_id.slice(ARCHIVE_ID_PREFIX.length) : null;
  const target = archiveId !== null
    ? `archive ${row.target_kind} \`${archiveId}\``
    : row.target_kind === 'user' ? `user <@${row.target_id}> (\`${row.target_id}\`)` : `message \`${row.target_id}\``;
  return `Request \`${row.id}\`: ${target} — **${row.status}**; ${progress}${time}.`
    + ` Requested by <@${row.requester_user_id}>${row.approver_user_id ? `; approved by <@${row.approver_user_id}>` : ''}.`
    + (job?.status === 'failed' ? ' Worker failed; the original approver can use deletion retry.' : '');
}

/** Request only: no source content, evidence, tombstones, or job is changed. */
export function requestDeletion(
  input: DeletionCommandInput & { targetKind: 'user' | 'message'; targetId: string },
  deps: DeletionCommandDeps,
): string {
  const denial = access(input, deps);
  if (denial) { audit(input, deps, 'request', null, 'denied'); return denial; }
  if (isArchiveTarget(input.targetId)) return requestArchiveDeletion(input, deps);
  if (!isPlatformId(input.targetId)) {
    audit(input, deps, 'request', null, 'invalid_target');
    return 'Invalid target. Select a Discord user or provide a numeric Discord message ID.';
  }
  if (deps.deletionApproverUserIds.length === 0) {
    audit(input, deps, 'request', input.targetId, 'disabled');
    return 'Deletion is disabled until the server operator configures deletion approvers.';
  }
  return transactionImmediate(deps.db, () => {
    const existing = deps.db.prepare(`SELECT * FROM deletion_requests
      WHERE workspace_id = ? AND target_kind = ? AND target_id = ?
        AND status IN ('pending', 'scheduled', 'executing')`).get(input.guildId, input.targetKind, input.targetId) as DeletionRequest | undefined;
    if (existing) {
      audit(input, deps, 'request', existing.id, 'already_active');
      return `An active request already exists. ${describe(deps.db, existing)}`;
    }
    const id = randomUUID();
    deps.db.prepare(`INSERT INTO deletion_requests
      (id, workspace_id, target_kind, target_id, requester_user_id, status, created_at_ms)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id, input.guildId, input.targetKind, input.targetId, input.actorUserId, deps.nowMs);
    // Pin actual row identities, not a future author/time predicate: late backfill
    // and messages arriving during approval/grace must not expand the request.
    const field = input.targetKind === 'user' ? 'author_id' : 'id';
    deps.db.prepare(`INSERT INTO deletion_request_messages (request_id, message_id)
      SELECT ?, id FROM messages WHERE workspace_id = ? AND ${field} = ? AND deleted_at_ms IS NULL`)
      .run(id, input.guildId, input.targetId);
    const count = Number(deps.db.prepare('SELECT count(*) AS n FROM deletion_request_messages WHERE request_id = ?').get(id)?.n ?? 0);
    if (count === 0) {
      deps.db.prepare('DELETE FROM deletion_requests WHERE id = ?').run(id);
      audit(input, deps, 'request', input.targetId, 'no_matching_messages');
      return 'No stored, undeleted messages match that target in this server. Nothing was scheduled.';
    }
    deps.db.prepare('UPDATE deletion_requests SET message_count = ? WHERE id = ?').run(count, id);
    audit(input, deps, 'request', id, 'pending');
    return `${describe(deps.db, getDeletionRequest(deps.db, id, input.guildId)!)}\n`
      + 'Nothing has been deleted. Only these currently stored messages are included; future messages and later backfill are excluded.\n'
      + `A different authorized approver must run \`/mneme deletion approve id:${id} confirmation:DELETE\`. `
      + `Approval starts a 24-hour cancellation window. Cancel with \`/mneme deletion cancel id:${id}\`. `
      + 'The final purge cannot be undone. Discord originals are not deleted.';
  });
}

const ARCHIVE_LIMIT_NOTE = 'A user redaction does not remove the user\u2019s name or mentions from other people\u2019s archive messages.';

/**
 * Request only, for a row in the read-only platform archive. The request goes
 * through the same approval and grace period as a live request. Execution
 * writes one archive redaction; the archive file itself never changes.
 */
function requestArchiveDeletion(
  input: DeletionCommandInput & { targetKind: 'user' | 'message'; targetId: string },
  deps: DeletionCommandDeps,
): string {
  const archive = deps.archive;
  if (!archive) {
    audit(input, deps, 'request', null, 'no_archive');
    return 'No platform archive is configured, so archive targets cannot be deleted.';
  }
  const raw = input.targetId.slice(ARCHIVE_ID_PREFIX.length);
  const valid = input.targetKind === 'user' ? isArchiveUserId(archive, raw) : isArchiveMessageId(archive, raw);
  if (!valid) {
    audit(input, deps, 'request', null, 'invalid_target');
    return `Invalid archive target. Use an archive ${input.targetKind} id from the ${archive.summary.platform} archive, for example from \`/mneme archive user\`.`;
  }
  if (deps.deletionApproverUserIds.length === 0) {
    audit(input, deps, 'request', input.targetId, 'disabled');
    return 'Deletion is disabled until the server operator configures deletion approvers.';
  }
  return transactionImmediate(deps.db, () => {
    const existing = deps.db.prepare(`SELECT * FROM deletion_requests
      WHERE workspace_id = ? AND target_kind = ? AND target_id = ?
        AND status IN ('pending', 'scheduled', 'executing')`).get(input.guildId, input.targetKind, input.targetId) as DeletionRequest | undefined;
    if (existing) {
      audit(input, deps, 'request', existing.id, 'already_active');
      return `An active request already exists. ${describe(deps.db, existing)}`;
    }
    const target = describeArchiveDeletionTarget(archive, input.targetKind, raw);
    if (target.kind === 'already_hidden') {
      audit(input, deps, 'request', input.targetId, 'already_hidden');
      return 'That archive target is already hidden by an earlier deletion. Nothing was scheduled.';
    }
    if (target.kind === 'no_match') {
      audit(input, deps, 'request', input.targetId, 'no_matching_messages');
      return 'No archive messages match that target. Nothing was scheduled.';
    }
    const id = randomUUID();
    // The archive is read-only, so there is no manifest of live rows. The count
    // is the number of archive messages that the redaction will hide.
    deps.db.prepare(`INSERT INTO deletion_requests
      (id, workspace_id, target_kind, target_id, requester_user_id, status, message_count, created_at_ms)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, input.guildId, input.targetKind, input.targetId, input.actorUserId, target.messageCount, deps.nowMs);
    audit(input, deps, 'request', id, 'pending');
    return `${describe(deps.db, getDeletionRequest(deps.db, id, input.guildId)!)}\n`
      + 'Nothing has been deleted. After approval and the grace period, Mneme hides these archive messages from every archive read; '
      + 'the archive file changes only when an operator runs `archive-rewrite`.\n'
      + (input.targetKind === 'user' ? `${ARCHIVE_LIMIT_NOTE}\n` : '')
      + `A different authorized approver must run \`/mneme deletion approve id:${id} confirmation:DELETE\`. `
      + `Approval starts a 24-hour cancellation window. Cancel with \`/mneme deletion cancel id:${id}\`.`;
  });
}

export function handleDeletionCommand(
  input: DeletionCommandInput & { subcommand: DeletionSubcommand; requestId?: string | null; confirmation?: string | null },
  deps: DeletionCommandDeps,
): string {
  const denial = access(input, deps);
  if (denial) { audit(input, deps, input.subcommand, null, 'denied'); return denial; }
  return transactionImmediate(deps.db, () => {
    if (input.subcommand === 'status') {
      const rows = input.requestId
        ? [getDeletionRequest(deps.db, input.requestId, input.guildId)].filter((r): r is DeletionRequest => !!r)
        : deps.db.prepare(`SELECT * FROM deletion_requests WHERE workspace_id = ? ORDER BY created_at_ms DESC, id LIMIT 4`)
          .all(input.guildId) as unknown as DeletionRequest[];
      return rows.length ? rows.map((r) => describe(deps.db, r)).join('\n') : 'No deletion requests found.';
    }
    const row = input.requestId ? getDeletionRequest(deps.db, input.requestId, input.guildId) : undefined;
    const result = (code: string, text: string): string => {
      audit(input, deps, input.subcommand, row?.id ?? null, code);
      return text;
    };
    if (!row) return result('not_found', 'No deletion request found. Use its full request ID.');
    const approver = deps.deletionApproverUserIds.includes(input.actorUserId);
    if (input.subcommand === 'cancel') {
      if (!approver && row.requester_user_id !== input.actorUserId) {
        return result('denied', 'Only the requester or an authorized deletion approver can cancel this request.');
      }
      if (row.status !== 'pending' && row.status !== 'scheduled') {
        return result('not_cancellable', `Request is ${row.status}. Cancellation is only available before the purge starts; completed deletion cannot be undone.`);
      }
      deps.db.prepare("UPDATE deletion_requests SET status = 'cancelled', completed_at_ms = ? WHERE id = ?").run(deps.nowMs, row.id);
      if (row.job_id) cancelJob(deps.db, row.job_id, deps.nowMs);
      deps.db.prepare('DELETE FROM deletion_request_messages WHERE request_id = ?').run(row.id);
      return result('cancelled', 'Deletion request cancelled. No messages were deleted by this request.');
    }
    if (!approver) return result('denied', 'Only a configured deletion approver can authorize a purge. An admin role alone is insufficient.');
    if (row.requester_user_id === input.actorUserId) {
      return result('self_approval_denied', 'You cannot approve your own deletion request. A different authorized approver must review it.');
    }
    if (input.subcommand === 'retry') {
      const job = row.job_id ? getJob(deps.db, row.job_id) : undefined;
      if (!job || job.status !== 'failed' || !['scheduled', 'executing'].includes(row.status)
        || row.approver_user_id !== input.actorUserId) {
        return result('not_retryable', 'Only the original approver can retry a failed scheduled or executing purge.');
      }
      const queued = enqueue(deps.db, { type: 'execute_deletion', payload: { requestId: row.id },
        runAfterMs: Math.max(deps.nowMs, row.execute_after_ms!), now: deps.nowMs });
      deps.db.prepare('UPDATE deletion_requests SET job_id = ? WHERE id = ?').run(queued.id, row.id);
      return result('retry_queued', 'Purge retry queued for the remaining approved messages. This does not restore deleted messages.');
    }
    if (input.subcommand !== 'approve') return result('unknown_command', 'Unknown deletion command.');
    if (row.status !== 'pending') return result('not_pending', `Request is already ${row.status}; its deadline has not changed.`);
    if (input.confirmation !== 'DELETE') {
      return result('confirmation_required', `${describe(deps.db, row)}\nReview the target and count. To confirm irreversible deletion after a 24-hour cancellation window, repeat with confirmation:DELETE.`);
    }
    const deadline = deps.nowMs + DELETION_GRACE_MS;
    const queued = enqueue(deps.db, { type: 'execute_deletion', payload: { requestId: row.id }, runAfterMs: deadline, now: deps.nowMs });
    deps.db.prepare(`UPDATE deletion_requests SET status = 'scheduled', approver_user_id = ?,
      approved_at_ms = ?, execute_after_ms = ?, job_id = ? WHERE id = ?`)
      .run(input.actorUserId, deps.nowMs, deadline, queued.id, row.id);
    return result('scheduled', `Scheduled for deletion no earlier than <t:${Math.floor(deadline / 1000)}:F>. Nothing has been deleted. `
      + `Cancel before the purge starts with \`/mneme deletion cancel id:${row.id}\`. After it starts, there is no undo.`);
  });
}
