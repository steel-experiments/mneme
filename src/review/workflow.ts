/**
 * Authorized proposal approval and dismissal (Sections 6.6, 25).
 *
 * When an admin clicks Approve/Dismiss on a review message, this module is the
 * single funnel that turns that click into a safe state change:
 *
 *   1. authorize the approver against the configured admin roles (fail closed);
 *   2. reject proposals that are missing, no longer pending, or past expiry;
 *   3. re-run the current target/evidence/cooldown/duplicate policy so a change
 *      between proposal and approval can still prevent the send (Section 25);
 *   4. in one immediate transaction, record the approver and timestamp and
 *      enqueue one outbox row (idempotent on the proposal dedupe key).
 *
 * Every attempt is audited in `admin_events` without content or secrets. The
 * review Discord message is updated through an optional {@link ReviewResolver}
 * port so the channel reflects the resolution.
 */

import { type DatabaseSync, transactionImmediate } from '../db/database.js';
import { getProposal, setProposalMessage, setProposalReviewed, setProposalStatus } from '../db/repositories/proposals.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import { authorizeAdmin, type AuthorizationOutcome } from '../policy/authorization.js';
import { enqueueOutbox } from '../outbox/repository.js';
import { enqueueProposalDeliverySync } from '../outbox/proposal-delivery.js';
import type { OutboundEvidenceResult, ProvenanceGateResult } from '../agent/policy.js';
import type { CooldownDecision } from '../agent/cooldowns.js';
import type { DuplicateResult } from '../agent/duplicate-policy.js';
import {
  DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
  findScheduledApprovalSubjectBlock,
} from '../memory/scheduled-notifications.js';

/** Pre-computed policy re-check results, gathered by the caller from current DB state. */
export interface ApprovalPolicyRecheck {
  /** Original run provenance resolved against current channel policy. */
  provenance: ProvenanceGateResult;
  /** Target-channel and cited-evidence gate (Sections 7.4, 24.2), re-run now. */
  outboundEvidence: OutboundEvidenceResult;
  /** Channel/topic/daily-limit cooldown (Section 24.4), re-run now. */
  cooldown: CooldownDecision;
  /** Near-/exact-duplicate of a recent Mneme message (Section 24.4), re-run now. */
  duplicate: DuplicateResult;
  /** Scheduled-subject quiet period used by the atomic approval recheck. */
  scheduledReminderIntervalMs?: number;
  /** Exact current scheduled subject/route result. Drift expires instead of retry-blocking. */
  scheduledDelivery?: { allow: boolean; reasons: string[]; deliveryContent?: string };
  /** Recompute scheduled delivery while the approval transaction owns the write lock. */
  revalidateScheduledDelivery?: () => { allow: boolean; reasons: string[]; deliveryContent?: string };
  /**
   * Attention ownership and window check (Section 12.7). The SAME proposal must
   * own its revision claim inside the immutable window; a definite failure
   * expires the proposal rather than blocking it for retry.
   */
  attention?: { allow: boolean; reasons: string[] };
  /** Recompute attention ownership while the approval transaction owns the write lock. */
  revalidateAttention?: () => { allow: boolean; reasons: string[] };
}

/**
 * Decide whether a proposal may still be sent given the *current* policy state.
 * Pure: a thin, auditable composition over caller-supplied sub-results, mirroring
 * {@link routeProposal}'s shape. A definite evidence violation (`reject`), an
 * active cooldown, or a matched duplicate blocks the send. Scope *uncertainty*
 * (`force_review`) does not block — a human is already approving, and the
 * original gates already routed this proposal to review; only a definite
 * violation, unresolved scope uncertainty, or a rate/duplicate state that arose
 * after routing prevents it. Human approval does not override the fail-closed
 * visibility invariant.
 */
export function recheckApprovalPolicy(input: ApprovalPolicyRecheck): {
  allow: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (input.provenance.outcome !== 'allow') {
    reasons.push(...input.provenance.reasons);
  }
  if (input.outboundEvidence.outcome !== 'allow') {
    reasons.push(...input.outboundEvidence.reasons);
  }
  if (!input.cooldown.allowed) {
    reasons.push(...input.cooldown.blocks.map((b) => `rate-limited (${b.rule}): ${b.detail}`));
  }
  if (input.duplicate.matched) {
    reasons.push(
      `${input.duplicate.kind} duplicate of a recent ${input.duplicate.source} message (similarity ${input.duplicate.similarity.toFixed(3)})`,
    );
  }
  if (input.attention && !input.attention.allow) {
    reasons.push(...input.attention.reasons);
  }
  return { allow: reasons.length === 0, reasons };
}

/** Terminal outcomes of an approval attempt. */
export type ApproveOutcome =
  | 'not_found'
  | 'stale'
  | 'expired'
  | 'unauthorized'
  | 'policy_blocked'
  | 'approved';

export interface ApproveProposalInput {
  proposalId: string;
  /** Resolved role ids of the clicking member, or null when unresolved (fail closed). */
  memberRoleIds: readonly string[] | null | undefined;
  /** Configured admin role ids (`MNEME_ADMIN_ROLE_IDS`). */
  adminRoleIds: readonly string[];
  actorUserId: string;
  guildId: string;
  recheck: ApprovalPolicyRecheck;
  now: number;
}

export interface ApproveProposalResult {
  outcome: ApproveOutcome;
  proposalId: string;
  /** Redacted, content-free reasons (auth denial, stale state, recheck blocks). */
  reasons: string[];
  /** Outbox row id, when approved. */
  outboxId?: string;
  /** False when the dedupe key already had a row (idempotent re-approval), else true. */
  enqueued?: boolean;
  /** The authorization decision reached for this attempt. */
  authorization: AuthorizationOutcome;
}

/** A label patch applied to the review message after a review attempt. */
export interface ReviewResolution {
  /** Discord message id of the review message to update. */
  reviewMessageId: string;
  /** Short human label, e.g. "Approved — delivery queued". */
  label: string;
  /** Remove controls only when the proposal reached a terminal state. */
  removeControls: boolean;
}

/**
 * Optional port for updating the review message after an attempt (Section 25
 * step 6). Terminal outcomes remove the controls; retryable policy blocks leave
 * them in place. Failures are swallowed because the review message is only a
 * presentation of durable proposal state.
 */
export type ReviewResolver = (resolution: ReviewResolution) => Promise<void> | void;

export interface ApproveWorkflowDeps {
  db: DatabaseSync;
  /** Called with the attempt label and whether the controls should be removed. */
  resolveReview?: ReviewResolver;
}

function retryableBlockLabel(reason: string): string {
  return `⛔ Not sent: ${reason}. Proposal remains pending review and can be retried after the current block clears.`;
}

/** Audit an approval attempt with content-free details. */
function auditApproval(
  db: DatabaseSync,
  input: ApproveProposalInput,
  outcome: ApproveOutcome,
  reasons: string[],
  authorization: AuthorizationOutcome,
): void {
  recordAdminEvent(db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'proposal.approve',
    target: input.proposalId,
    details: {
      outcome,
      authorized: authorization.authorized,
      authReason: authorization.reason,
      reasons,
    },
    createdAtMs: input.now,
  });
}

/**
 * Authorize an admin's approval click and, if allowed and still valid, enqueue
 * the proposal for delivery (Section 25). Returns the outcome so the caller can
 * reply to the interaction and update the review message.
 *
 * Order: authorize first (fail closed, audited regardless), then state checks
 * (not-found / already-resolved / expired), then the policy re-check, then —
 * only when everything passes — record the reviewer and enqueue together in one
 * immediate transaction so neither durable state can exist without the other.
 */
export async function approveProposal(
  input: ApproveProposalInput,
  deps: ApproveWorkflowDeps,
): Promise<ApproveProposalResult> {
  const authorization = authorizeAdmin(input.memberRoleIds, input.adminRoleIds);
  const proposal = getProposal(deps.db, input.proposalId);

  // Unauthorized: audit the denial and stop. We do not leak proposal state.
  if (!authorization.authorized) {
    const reasons = [`not authorized: ${authorization.reason}`];
    auditApproval(deps.db, input, 'unauthorized', reasons, authorization);
    return { outcome: 'unauthorized', proposalId: input.proposalId, reasons, authorization };
  }

  if (!proposal) {
    const reasons = ['proposal not found'];
    auditApproval(deps.db, input, 'not_found', reasons, authorization);
    return { outcome: 'not_found', proposalId: input.proposalId, reasons, authorization };
  }

  // Stale: already resolved (approved/dismissed/sent/…) or never reached review.
  if (proposal.status !== 'pending_review') {
    const reasons = [`proposal is "${proposal.status}", not pending review`];
    auditApproval(deps.db, input, 'stale', reasons, authorization);
    return { outcome: 'stale', proposalId: input.proposalId, reasons, authorization };
  }

  // Expiry (Section 25: default 72h). A past-deadline proposal is finalized expired.
  if (proposal.expiresAtMs !== null && input.now > proposal.expiresAtMs) {
    setProposalStatus(deps.db, input.proposalId, 'expired', input.now);
    const reasons = [`proposal expired at ${new Date(proposal.expiresAtMs).toISOString()}`];
    auditApproval(deps.db, input, 'expired', reasons, authorization);
    await resolveReviewSafely(deps, proposal.reviewMessageId, '⏰ Expired');
    return { outcome: 'expired', proposalId: input.proposalId, reasons, authorization };
  }

  // Re-run the current policy (Section 25 steps 2-3). A change since routing can
  // block the send without discarding the proposal (it stays pending_review).
  const recheck = recheckApprovalPolicy(input.recheck);
  if (input.recheck.attention && !input.recheck.attention.allow) {
    const reasons = input.recheck.attention.reasons;
    transactionImmediate(deps.db, () => {
      setProposalStatus(deps.db, input.proposalId, 'expired', input.now);
      enqueueProposalDeliverySync(deps.db, input.proposalId, input.now);
      auditApproval(deps.db, input, 'expired', reasons, authorization);
    });
    await resolveReviewSafely(deps, proposal.reviewMessageId,
      `⏰ Expired: ${reasons[0] ?? 'attention authority changed'}`);
    return { outcome: 'expired', proposalId: input.proposalId, reasons, authorization };
  }
  if (input.recheck.scheduledDelivery && !input.recheck.scheduledDelivery.allow) {
    setProposalStatus(deps.db, input.proposalId, 'expired', input.now);
    const reasons = input.recheck.scheduledDelivery.reasons;
    auditApproval(deps.db, input, 'expired', reasons, authorization);
    await resolveReviewSafely(
      deps,
      proposal.reviewMessageId,
      `⏰ Expired: ${reasons[0] ?? 'scheduled delivery route changed'}`,
    );
    return { outcome: 'expired', proposalId: input.proposalId, reasons, authorization };
  }
  if (!recheck.allow) {
    auditApproval(deps.db, input, 'policy_blocked', recheck.reasons, authorization);
    await resolveReviewSafely(
      deps,
      proposal.reviewMessageId,
      retryableBlockLabel(recheck.reasons[0] ?? 'policy check failed'),
      false,
    );
    return { outcome: 'policy_blocked', proposalId: input.proposalId, reasons: recheck.reasons, authorization };
  }

  // A pending proposal must carry proposed text to send; guard against bad state.
  if (!proposal.message?.trim()) {
    const reasons = ['proposal has no proposed message text'];
    auditApproval(deps.db, input, 'policy_blocked', reasons, authorization);
    await resolveReviewSafely(
      deps,
      proposal.reviewMessageId,
      retryableBlockLabel(reasons[0]!),
      false,
    );
    return { outcome: 'policy_blocked', proposalId: input.proposalId, reasons, authorization };
  }

  let recorded = false;
  let outboxId = '';
  let enqueued = false;
  let scheduledBlockReason: string | null = null;
  let scheduledBlockExpired = false;
  transactionImmediate(deps.db, () => {
    // Attention ownership is rechecked under the write lock: the SAME proposal
    // must own its revision inside the immutable window. A definite failure is
    // terminal — the card expires instead of blocking for retry.
    const currentAttention = input.recheck.revalidateAttention?.();
    if (currentAttention && !currentAttention.allow) {
      scheduledBlockReason = currentAttention.reasons[0] ?? 'attention authority changed';
      scheduledBlockExpired = true;
      setProposalStatus(deps.db, input.proposalId, 'expired', input.now);
      auditApproval(deps.db, input, 'expired', currentAttention.reasons, authorization);
      enqueueProposalDeliverySync(deps.db, input.proposalId, input.now);
      return;
    }
    const currentScheduledDelivery = input.recheck.revalidateScheduledDelivery?.();
    if (currentScheduledDelivery && !currentScheduledDelivery.allow) {
      scheduledBlockReason = currentScheduledDelivery.reasons[0] ?? 'scheduled delivery route changed';
      scheduledBlockExpired = true;
      setProposalStatus(deps.db, input.proposalId, 'expired', input.now);
      auditApproval(
        deps.db,
        input,
        'expired',
        currentScheduledDelivery.reasons,
        authorization,
      );
      return;
    }
    const scheduledBlock = findScheduledApprovalSubjectBlock(
      deps.db,
      input.proposalId,
      input.now,
      input.recheck.scheduledReminderIntervalMs ?? DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
    );
    if (scheduledBlock.blocked) {
      scheduledBlockReason = scheduledBlock.reason;
      scheduledBlockExpired = scheduledBlock.reason === 'scheduled subject is no longer due'
        || scheduledBlock.reason === 'scheduled subject changed after proposal creation';
      if (scheduledBlockExpired) {
        setProposalStatus(deps.db, input.proposalId, 'expired', input.now);
      }
      auditApproval(
        deps.db,
        input,
        scheduledBlockExpired ? 'expired' : 'policy_blocked',
        [scheduledBlock.reason],
        authorization,
      );
      return;
    }
    recorded = setProposalReviewed(deps.db, input.proposalId, 'approved', input.actorUserId, input.now);
    if (!recorded) return;
    // A scheduled proposal delivers its host-rendered text (inline links,
    // identity footer). Persist that exact text on the proposal so the durable
    // record, the outbox row, and reply-feedback matching all agree.
    const deliveryContent = currentScheduledDelivery?.deliveryContent;
    if (deliveryContent !== undefined && deliveryContent !== proposal.message) {
      setProposalMessage(deps.db, input.proposalId, deliveryContent, input.now);
    }
    const outbox = enqueueOutbox(deps.db, {
      proposalId: input.proposalId,
      runId: proposal.runId,
      channelId: proposal.targetChannelId,
      content: deliveryContent ?? proposal.message!,
      replyToMessageId: proposal.replyToMessageId,
      now: input.now,
    });
    outboxId = outbox.outboxId;
    enqueued = outbox.enqueued;
    auditApproval(deps.db, input, 'approved', ['admin approved; enqueued for delivery'], authorization);
  });
  if (scheduledBlockReason) {
    await resolveReviewSafely(
      deps,
      proposal.reviewMessageId,
      scheduledBlockExpired
        ? `⏰ Expired: ${scheduledBlockReason}`
        : retryableBlockLabel(scheduledBlockReason),
      scheduledBlockExpired,
    );
    return {
      outcome: scheduledBlockExpired ? 'expired' : 'policy_blocked',
      proposalId: input.proposalId,
      reasons: [scheduledBlockReason],
      authorization,
    };
  }
  if (!recorded) {
    // Lost the race with a concurrent resolution: treat as stale.
    const reasons = ['proposal was resolved concurrently'];
    auditApproval(deps.db, input, 'stale', reasons, authorization);
    return { outcome: 'stale', proposalId: input.proposalId, reasons, authorization };
  }

  await resolveReviewSafely(deps, proposal.reviewMessageId, '✅ Approved — delivery queued');
  return {
    outcome: 'approved',
    proposalId: input.proposalId,
    reasons: [],
    outboxId,
    enqueued,
    authorization,
  };
}

/** Swallow resolver errors: a failed review-message edit must not unwind an approved send. */
async function resolveReviewSafely(
  deps: ApproveWorkflowDeps,
  reviewMessageId: string | null,
  label: string,
  removeControls = true,
): Promise<void> {
  if (!deps.resolveReview || !reviewMessageId) return;
  try {
    await deps.resolveReview({ reviewMessageId, label, removeControls });
  } catch {
    /* presentation-only; the DB transition and outbox row are the source of truth */
  }
}

// ---------------------------------------------------------------------------
// Dismissal (Section 25: "Dismissal stores an optional reason for evaluation.").
// ---------------------------------------------------------------------------

/**
 * Upper bound on a stored dismissal reason (Section 25). The reason is kept for
 * evaluation only and must stay small, content-free, and free of secrets; longer
 * input is truncated rather than rejected so a dismissal is never blocked by it.
 */
export const MAX_DISMISSAL_REASON_CHARS = 500;

function boundDismissalReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_DISMISSAL_REASON_CHARS
    ? trimmed.slice(0, MAX_DISMISSAL_REASON_CHARS)
    : trimmed;
}

export type DismissOutcome = 'not_found' | 'stale' | 'unauthorized' | 'dismissed';

export interface DismissProposalInput {
  proposalId: string;
  memberRoleIds: readonly string[] | null | undefined;
  adminRoleIds: readonly string[];
  actorUserId: string;
  guildId: string;
  /** Optional dismissal reason (bounded, content-free) kept for evaluation. */
  reason?: string | null;
  now: number;
}

export interface DismissProposalResult {
  outcome: DismissOutcome;
  proposalId: string;
  reasons: string[];
  authorization: AuthorizationOutcome;
}

/**
 * Dismiss a pending proposal: authorize, stamp the reviewer, and finalize as
 * `dismissed` (no outbox row is ever created for a dismissed proposal). An
 * optional reason is recorded in the audit for later evaluation. Idempotent via
 * the `pending_review` status gate.
 */
export async function dismissProposal(
  input: DismissProposalInput,
  deps: ApproveWorkflowDeps,
): Promise<DismissProposalResult> {
  const authorization = authorizeAdmin(input.memberRoleIds, input.adminRoleIds);
  const proposal = getProposal(deps.db, input.proposalId);

  if (!authorization.authorized) {
    const reasons = [`not authorized: ${authorization.reason}`];
    auditDismiss(deps.db, input, 'unauthorized', reasons, authorization, boundDismissalReason(input.reason));
    return { outcome: 'unauthorized', proposalId: input.proposalId, reasons, authorization };
  }
  if (!proposal) {
    const reasons = ['proposal not found'];
    auditDismiss(deps.db, input, 'not_found', reasons, authorization, boundDismissalReason(input.reason));
    return { outcome: 'not_found', proposalId: input.proposalId, reasons, authorization };
  }
  if (proposal.status !== 'pending_review') {
    const reasons = [`proposal is "${proposal.status}", not pending review`];
    auditDismiss(deps.db, input, 'stale', reasons, authorization, boundDismissalReason(input.reason));
    return { outcome: 'stale', proposalId: input.proposalId, reasons, authorization };
  }

  const boundedReason = boundDismissalReason(input.reason);
  setProposalReviewed(
    deps.db,
    input.proposalId,
    'dismissed',
    input.actorUserId,
    input.now,
    boundedReason,
  );
  const reasons = ['admin dismissed proposal'];
  auditDismiss(deps.db, input, 'dismissed', reasons, authorization, boundedReason);
  await resolveReviewSafely(deps, proposal.reviewMessageId, '🗑 Dismissed');
  return { outcome: 'dismissed', proposalId: input.proposalId, reasons, authorization };
}

function auditDismiss(
  db: DatabaseSync,
  input: DismissProposalInput,
  outcome: DismissOutcome,
  reasons: string[],
  authorization: AuthorizationOutcome,
  boundedReason: string | null,
): void {
  recordAdminEvent(db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'proposal.dismiss',
    target: input.proposalId,
    details: {
      outcome,
      authorized: authorization.authorized,
      authReason: authorization.reason,
      reasons,
      dismissReason: boundedReason,
    },
    createdAtMs: input.now,
  });
}
