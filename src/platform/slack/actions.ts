// ABOUTME: Handles Slack review-card button clicks (spec Sections 6.6, 25).
// ABOUTME: The envelope is acknowledged first; team, channel, signature, and admin are checked before any change.
import type { DatabaseSync } from '../../db/database.js';
import { recordAdminEvent } from '../../db/repositories/admin-events.js';
import { getChannel } from '../../db/repositories/channels.js';
import {
  applyChannelPolicyReviewDecision,
  CHANNEL_POLICY_REVIEW_LABELS,
  labelForApprove,
  labelForDismiss,
  parseChannelPolicyReviewComponent,
  parseReviewComponent,
  type ChannelPolicyReviewPort,
} from '../../review/controls.js';
import { approveProposal, dismissProposal, type ApprovalPolicyRecheck, type ReviewResolver } from '../../review/workflow.js';
import type { ChannelPolicySource } from '../../config.js';
import type { ChannelPolicy } from '../../policy/channel-policy.js';
import type { SlackObject } from './api.js';
import type { SlackCardPayload } from './cards.js';
import type { SlackEnvelope } from './connection.js';
import { slackMessageId } from './ids.js';
import type { SlackRespond } from './respond.js';

export interface SlackActionDeps {
  db: DatabaseSync;
  workspaceId: string;
  secret: string;
  /** Slack admins (`MNEME_ADMIN_USER_IDS`). An actor is an admin when its user id is in the list. */
  adminUserIds: readonly string[];
  reviewChannelId: string | undefined;
  buildRecheck: (proposalId: string) => ApprovalPolicyRecheck;
  policy: () => ChannelPolicy;
  channelPolicySource: ChannelPolicySource;
  resolveReview: ReviewResolver | undefined;
  channelPolicyPort: ChannelPolicyReviewPort<SlackCardPayload> | undefined;
  respond: SlackRespond;
  now: () => number;
}

export type SlackActionOutcome = 'ignored' | 'refused' | 'handled';

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Handle one acknowledged `interactive` envelope. Ids that do not verify are
 * ignored, so a forged or unrelated button cannot reach the workflow.
 */
export async function handleSlackAction(deps: SlackActionDeps, envelope: SlackEnvelope): Promise<SlackActionOutcome> {
  if (envelope.type !== 'interactive') return 'ignored';
  const body = envelope.body;
  if (body.type !== 'block_actions') return 'ignored';
  const action = (Array.isArray(body.actions) ? body.actions[0] : undefined) as SlackObject | undefined;
  const actionId = str(action?.action_id);
  if (!actionId || !actionId.startsWith('cass:')) return 'ignored';
  const review = parseReviewComponent(actionId, deps.secret);
  const policyReview = review ? undefined : parseChannelPolicyReviewComponent(actionId, deps.secret);
  if (!review && !policyReview) return 'ignored';

  const actorUserId = str((body.user as SlackObject | undefined)?.id) ?? 'unknown';
  const teamId = str((body.team as SlackObject | undefined)?.id);
  const channelId = str((body.channel as SlackObject | undefined)?.id);
  const messageTs = str((body.message as SlackObject | undefined)?.ts) ?? str((body.container as SlackObject | undefined)?.message_ts);
  const target = review?.proposalId ?? policyReview!.reviewId;
  const now = deps.now();
  const refuse = async (outcome: string, text: string): Promise<SlackActionOutcome> => {
    recordAdminEvent(deps.db, {
      guildId: deps.workspaceId, actorUserId, action: review ? `proposal.${review.action}` : 'channel_policy_review', target,
      details: { authorized: false, outcome, teamId, channelId }, createdAtMs: now,
    });
    await deps.respond(body.response_url, text);
    return 'refused';
  };
  if (teamId !== deps.workspaceId) return refuse('foreign_team', 'This review control does not belong to this workspace.');
  if (!deps.reviewChannelId || channelId !== deps.reviewChannelId) {
    return refuse('foreign_channel', 'This control is not in Mneme’s secure review channel.');
  }
  // A review channel that was shared with another organization accepts no click.
  if (getChannel(deps.db, channelId)?.platform_boundary === 'excluded') {
    return refuse('shared_channel', 'This review channel is shared with another organization; its controls are off.');
  }

  // Slack has no roles: the actor's own user id stands in for its roles, and the
  // admin list holds user ids, so the same fail-closed check applies.
  const memberRoleIds = [actorUserId];
  if (review) {
    const text = review.action === 'approve'
      ? labelForApprove((await approveProposal({
        proposalId: review.proposalId, memberRoleIds, adminRoleIds: deps.adminUserIds, actorUserId,
        guildId: deps.workspaceId, recheck: deps.buildRecheck(review.proposalId), now,
      }, { db: deps.db, resolveReview: deps.resolveReview })).outcome)
      : labelForDismiss((await dismissProposal({
        proposalId: review.proposalId, memberRoleIds, adminRoleIds: deps.adminUserIds, actorUserId,
        guildId: deps.workspaceId, now,
      }, { db: deps.db, resolveReview: deps.resolveReview })).outcome);
    await deps.respond(body.response_url, text);
    return 'handled';
  }

  const result = applyChannelPolicyReviewDecision({
    db: deps.db, policy: deps.policy(), reviewId: policyReview!.reviewId, decision: policyReview!.action,
    actorUserId, guildId: deps.workspaceId, memberRoleIds, adminRoleIds: deps.adminUserIds,
    ...(messageTs ? { deliveredMessageId: slackMessageId(channelId, messageTs) } : {}),
    channelPolicySource: deps.channelPolicySource, now,
  });
  if (result.outcome === 'decided' && result.reviewMessageId && deps.channelPolicyPort) {
    try {
      await deps.channelPolicyPort.resolve(deps.reviewChannelId, result.reviewMessageId,
        `Channel classification saved: ${policyReview!.action}.`);
    } catch {
      // The durable decision is authoritative; the card edit is best effort.
    }
  }
  await deps.respond(body.response_url, CHANNEL_POLICY_REVIEW_LABELS[result.outcome]);
  return 'handled';
}
