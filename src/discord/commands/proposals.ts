import { type DatabaseSync } from '../../db/database.js';
import {
  listPendingProposals,
  resolveProposalReference,
  type ProposalListItem,
} from '../../db/repositories/proposals.js';
import { authorizeAndAuditAdminAction } from '../authorization.js';
import {
  approveProposal,
  dismissProposal,
  type ApprovalPolicyRecheck,
  type ApproveProposalResult,
  type ApproveOutcome,
  type DismissProposalResult,
  type DismissOutcome,
  type ReviewResolver,
} from '../../review/workflow.js';

/**
 * `/mneme proposals`, `/mneme approve <id>`, `/mneme dismiss <id>`
 * (Sections 25, 27).
 *
 * These commands are the slash-command twin of the review-message Approve/Dismiss
 * buttons. The list discloses only ids, a redacted reason, a host score or
 * categorical assessment, a channel name, and timestamps — never message
 * content or secrets. Approve and dismiss
 * resolve the typed reference, then delegate to the SAME review workflow the
 * buttons use ({@link approveProposal} / {@link dismissProposal}), so a click and
 * a command run identical authorization, revalidation, idempotency, and audit
 * behavior — there is exactly one funnel for either action.
 *
 * Scheduled-review proposals carry a categorical assessment instead of showing
 * their host routing sentinel as though it were a calibrated score.
 *
 * The handlers stay free of discord.js types; a dispatcher extracts the actor,
 * roles, and the `id` option, calls these, and replies with the format functions.
 */

const DEFAULT_LIST_LIMIT = 10;

// ---------------------------------------------------------------------------
// `/mneme proposals` — list bounded unexpired pending proposals.
// ---------------------------------------------------------------------------

export interface HandleProposalsInput {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
}

export interface HandleProposalsDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  /** Cap on the number of proposals returned (default 10). */
  limit?: number;
}

export type ProposalsOutcome =
  | { kind: 'not_authorized' }
  | { kind: 'done'; proposals: readonly ProposalCommandListItem[]; nowMs: number };

export interface ProposalCommandListItem extends ProposalListItem {
  /** Present when the originating run was a scheduled-memory review. */
  assessment: 'Recommended scheduled review' | null;
}

/**
 * Run `/mneme proposals`. Authorization is checked first and audited on both
 * denial and success, then the bounded unexpired pending list is read.
 */
export function handleProposalsCommand(
  input: HandleProposalsInput,
  deps: HandleProposalsDeps,
): ProposalsOutcome {
  const outcome = authorizeAndAuditAdminAction(deps.db, {
    memberRoleIds: input.memberRoleIds,
    adminRoleIds: deps.adminRoleIds,
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'proposals',
    now: deps.nowMs,
  });
  if (!outcome.authorized) return { kind: 'not_authorized' };
  const pending = listPendingProposals(deps.db, {
    now: deps.nowMs,
    limit: deps.limit ?? DEFAULT_LIST_LIMIT,
  });
  const runType = deps.db.prepare(
    `SELECT ar.run_type AS run_type
       FROM proposals p
       JOIN agent_runs ar ON ar.id = p.run_id
      WHERE p.id = ?`,
  );
  const proposals = pending.map((proposal): ProposalCommandListItem => {
    const row = runType.get(proposal.id) as { run_type?: string } | undefined;
    return {
      ...proposal,
      assessment: row?.run_type === 'scheduled_review'
        ? 'Recommended scheduled review'
        : null,
    };
  });
  return { kind: 'done', proposals, nowMs: deps.nowMs };
}

/** Format the proposals list as an ephemeral reply. No content or secrets. */
export function formatProposalsReply(outcome: ProposalsOutcome): string {
  if (outcome.kind === 'not_authorized') {
    return 'You are not authorized to view Mneme proposals.';
  }
  if (outcome.proposals.length === 0) {
    return 'No proposals are pending review.';
  }
  const lines = outcome.proposals.map((p) => {
    const target = p.targetChannelName ?? p.targetChannelId;
    const ttl = p.expiresAtMs !== null ? `, expires in ${until(outcome.nowMs, p.expiresAtMs)}` : '';
    const assessment = p.assessment === null
      ? `score=${p.computedScore.toFixed(2)}`
      : `assessment=${p.assessment}`;
    return `${p.shortId}  ${assessment}  → #${target}  (${p.reason || 'no reason'}${ttl})`;
  });
  return ['Pending proposals:', ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// `/mneme approve <id>` and `/mneme dismiss <id>` — delegate to workflow.
// ---------------------------------------------------------------------------

export interface HandleApproveInput {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  /** The typed proposal reference: full id or 8-char short id. */
  proposalRef: string;
}

export interface HandleResolveDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  /** Build the current-state policy re-check for a proposal (same dep as buttons). */
  buildRecheck: (proposalId: string) => ApprovalPolicyRecheck;
  /** Optional review-message editor (Section 25 step 6). */
  resolveReview?: ReviewResolver;
}

export type ApproveCommandOutcome =
  | { kind: 'not_authorized' }
  | { kind: 'ambiguous'; matchCount: number }
  | { kind: 'resolved'; result: ApproveProposalResult };

export type DismissCommandOutcome =
  | { kind: 'not_authorized' }
  | { kind: 'ambiguous'; matchCount: number }
  | { kind: 'resolved'; result: DismissProposalResult };

/**
 * Run `/mneme approve <id>`. Resolve the reference; an ambiguous short id is
 * audited and reported so the admin can supply the full id. Every other path —
 * unique, not-found, or the raw reference — is delegated to {@link approveProposal},
 * which authorizes, revalidates, records, enqueues, and audits exactly as the
 * review button does.
 */
export async function handleApproveCommand(
  input: HandleApproveInput,
  deps: HandleResolveDeps,
): Promise<ApproveCommandOutcome> {
  const resolution = resolveProposalReference(deps.db, input.proposalRef);
  if (resolution.kind === 'ambiguous') {
    // Authorize before revealing that the prefix matched more than one proposal.
    const outcome = authorizeAndAuditAdminAction(deps.db, {
      memberRoleIds: input.memberRoleIds,
      adminRoleIds: deps.adminRoleIds,
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'proposal.approve',
      target: input.proposalRef,
      details: { outcome: 'ambiguous', matchCount: resolution.ids.length },
      now: deps.nowMs,
    });
    if (!outcome.authorized) return { kind: 'not_authorized' };
    return { kind: 'ambiguous', matchCount: resolution.ids.length };
  }

  const proposalId = resolution.kind === 'unique' ? resolution.id : input.proposalRef;
  const result = await approveProposal(
    {
      proposalId,
      memberRoleIds: input.memberRoleIds,
      adminRoleIds: deps.adminRoleIds,
      actorUserId: input.actorUserId,
      guildId: input.guildId,
      recheck: deps.buildRecheck(proposalId),
      now: deps.nowMs,
    },
    { db: deps.db, resolveReview: deps.resolveReview },
  );
  return { kind: 'resolved', result };
}

/**
 * Run `/mneme dismiss <id>`. Same resolution-and-delegate shape as approve,
 * but dismissal needs no policy re-check and never enqueues an outbox row.
 */
export async function handleDismissCommand(
  input: HandleApproveInput,
  deps: Omit<HandleResolveDeps, 'buildRecheck'>,
): Promise<DismissCommandOutcome> {
  const resolution = resolveProposalReference(deps.db, input.proposalRef);
  if (resolution.kind === 'ambiguous') {
    const outcome = authorizeAndAuditAdminAction(deps.db, {
      memberRoleIds: input.memberRoleIds,
      adminRoleIds: deps.adminRoleIds,
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'proposal.dismiss',
      target: input.proposalRef,
      details: { outcome: 'ambiguous', matchCount: resolution.ids.length },
      now: deps.nowMs,
    });
    if (!outcome.authorized) return { kind: 'not_authorized' };
    return { kind: 'ambiguous', matchCount: resolution.ids.length };
  }

  const proposalId = resolution.kind === 'unique' ? resolution.id : input.proposalRef;
  const result = await dismissProposal(
    {
      proposalId,
      memberRoleIds: input.memberRoleIds,
      adminRoleIds: deps.adminRoleIds,
      actorUserId: input.actorUserId,
      guildId: input.guildId,
      now: deps.nowMs,
    },
    { db: deps.db, resolveReview: deps.resolveReview },
  );
  return { kind: 'resolved', result };
}

// ---------------------------------------------------------------------------
// Reply formatting (mirrors the review-button labels in interactions.ts).
// ---------------------------------------------------------------------------

export function formatApproveReply(outcome: ApproveCommandOutcome): string {
  if (outcome.kind === 'not_authorized') return 'You are not authorized to approve Mneme proposals.';
  if (outcome.kind === 'ambiguous') {
    return `That short id matches ${outcome.matchCount} proposals. Use the full proposal id.`;
  }
  return labelForApprove(outcome.result.outcome);
}

export function formatDismissReply(outcome: DismissCommandOutcome): string {
  if (outcome.kind === 'not_authorized') return 'You are not authorized to dismiss Mneme proposals.';
  if (outcome.kind === 'ambiguous') {
    return `That short id matches ${outcome.matchCount} proposals. Use the full proposal id.`;
  }
  return labelForDismiss(outcome.result.outcome);
}

function labelForApprove(outcome: ApproveOutcome): string {
  switch (outcome) {
    case 'approved':
      return 'Approved — the message is queued for delivery.';
    case 'unauthorized':
      return 'You are not authorized to approve Mneme proposals.';
    case 'expired':
      return 'This proposal has expired.';
    case 'policy_blocked':
      return 'Not sent — this proposal remains pending review and can be retried after the current policy block clears.';
    case 'stale':
      return 'This proposal has already been resolved.';
    case 'not_found':
      return 'This proposal could not be found.';
  }
}

function labelForDismiss(outcome: DismissOutcome): string {
  switch (outcome) {
    case 'dismissed':
      return 'Proposal dismissed.';
    case 'unauthorized':
      return 'You are not authorized to dismiss Mneme proposals.';
    case 'stale':
      return 'This proposal has already been resolved.';
    case 'not_found':
      return 'This proposal could not be found.';
  }
}

/** Format a future deadline (expiresAtMs - now) as a short remaining-duration label. */
function until(now: number, atMs: number): string {
  const secs = Math.max(0, Math.round((atMs - now) / 1000));
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}
