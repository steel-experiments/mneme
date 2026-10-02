// ABOUTME: Platform-neutral review controls: signed button ids, channel-policy card delivery, and decisions (spec Section 25).
// ABOUTME: Each platform adapter builds its own card payload; the signing, recovery, and decision logic stays here.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from '../db/database.js';
import { transaction, transactionImmediate } from '../db/database.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import { getChannel } from '../db/repositories/channels.js';
import {
  decideChannelPolicyReview,
  getChannelPolicyReview,
  markChannelPolicyReviewDeliveryFailed,
  markChannelPolicyReviewSending,
  markChannelPolicyReviewSent,
  type ChannelPolicyReviewDecision,
} from '../db/repositories/channel-policy-reviews.js';
import { TransientJobError } from '../jobs/errors.js';
import { enqueue } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/worker.js';
import type { ChannelPolicySource } from '../config.js';
import { authorizeAdmin } from '../policy/authorization.js';
import { resolveChannel, type ChannelPolicy } from '../policy/channel-policy.js';
import { REVIEWED_CHANNEL_RULES } from '../policy/channel-policy-review.js';
import type { ChannelKind } from '../platform/types.js';
import type { ApproveOutcome, DismissOutcome } from './workflow.js';

/** The two review actions a button can request. */
export type ReviewAction = 'approve' | 'dismiss';

const PREFIX = 'cass';
const VERSION = 'rv';
const SIG_BYTES = 8; // 16 hex chars — 64 bits of signature, well under the 100-char custom_id cap

/** HMAC-SHA256 signature for one (action, proposal) pair, truncated to hex. */
function signature(action: ReviewAction, proposalId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${action}:${proposalId}`)
    .digest('hex')
    .slice(0, SIG_BYTES * 2);
}

/**
 * Build the signed custom_id for a review button. Format:
 * `cass:rv:<action>:<proposalId>:<sig>` — under Discord's 100-char limit for a
 * UUID proposal id.
 */
export function signReviewComponent(
  action: ReviewAction,
  proposalId: string,
  secret: string,
): string {
  return `${PREFIX}:${VERSION}:${action}:${proposalId}:${signature(action, proposalId, secret)}`;
}

export interface ParsedReviewComponent {
  action: ReviewAction;
  proposalId: string;
}

/**
 * Verify and parse a review button's custom_id against `secret`. Returns the
 * parsed action+proposal when the signature matches (constant-time compare), or
 * `undefined` for any malformed, unknown-action, or bad-signature id.
 */
export function parseReviewComponent(
  customId: string,
  secret: string,
): ParsedReviewComponent | undefined {
  const parts = customId.split(':');
  if (parts.length !== 5 || parts[0] !== PREFIX || parts[1] !== VERSION) return undefined;
  const action = parts[2] ?? '';
  const proposalId = parts[3] ?? '';
  const sig = parts[4] ?? '';
  if (action !== 'approve' && action !== 'dismiss') return undefined;
  const expected = signature(action, proposalId, secret);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return { action, proposalId };
}

export type ChannelPolicyReviewAction = 'org' | 'restricted' | 'excluded';
const CP_VERSION = 'cp';
export const CHANNEL_POLICY_REVIEW_MARKER_PREFIX = 'Mneme channel review ';

function channelPolicySignature(action: ChannelPolicyReviewAction, reviewId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${CP_VERSION}:${action}:${reviewId}`)
    .digest('hex')
    .slice(0, SIG_BYTES * 2);
}

export function signChannelPolicyReviewComponent(
  action: ChannelPolicyReviewAction,
  reviewId: string,
  secret: string,
): string {
  return `${PREFIX}:${CP_VERSION}:${action}:${reviewId}:${channelPolicySignature(action, reviewId, secret)}`;
}

export function parseChannelPolicyReviewComponent(
  customId: string,
  secret: string,
): { action: ChannelPolicyReviewAction; reviewId: string } | undefined {
  const parts = customId.split(':');
  if (parts.length !== 5 || parts[0] !== PREFIX || parts[1] !== CP_VERSION) return undefined;
  const action = parts[2];
  const reviewId = parts[3] ?? '';
  const supplied = parts[4] ?? '';
  if (action !== 'org' && action !== 'restricted' && action !== 'excluded') return undefined;
  const expected = channelPolicySignature(action, reviewId, secret);
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  return { action, reviewId };
}

export function channelPolicyReviewMarker(reviewId: string): string {
  return `${CHANNEL_POLICY_REVIEW_MARKER_PREFIX}${reviewId}`;
}

/** The neutral content of one channel-policy review card. */
export interface ChannelPolicyReviewCard {
  reviewId: string;
  channelId: string;
  channelName: string | null;
  channelKind: ChannelKind;
  parentId: string | null;
  parentName: string | null;
}

/** How the core posts, finds, and resolves a channel-policy card on one platform. */
export interface ChannelPolicyReviewPort<P> {
  send(channelId: string, payload: P): Promise<{ id: string }>;
  findByMarker(channelId: string, marker: string): Promise<{ id: string } | undefined>;
  resolve(channelId: string, messageId: string, label: string): Promise<void>;
}

export function createChannelPolicyReviewDeliveryHandler<P>(deps: {
  db: DatabaseSync;
  reviewChannelId: string;
  port: ChannelPolicyReviewPort<P>;
  /** Build the platform card payload with signed controls. */
  build: (card: ChannelPolicyReviewCard, secret: string) => P;
  secret: string;
  now: () => number;
}): JobHandler<'deliver_channel_policy_review'> {
  return async ({ reviewId }) => {
    let review = getChannelPolicyReview(deps.db, reviewId);
    if (!review || review.status !== 'pending' || review.delivery_state === 'sent') return;
    const marker = channelPolicyReviewMarker(review.id);
    if (review.delivery_state === 'sending') {
      const found = await deps.port.findByMarker(deps.reviewChannelId, marker);
      if (found) {
        transaction(deps.db, () => markChannelPolicyReviewSent(deps.db, reviewId, found.id, deps.now()));
        return;
      }
      transaction(deps.db, () => markChannelPolicyReviewDeliveryFailed(deps.db, reviewId, deps.now()));
      review = getChannelPolicyReview(deps.db, reviewId);
    }
    if (!review || review.status !== 'pending') return;
    const channel = getChannel(deps.db, review.channel_id);
    if (!channel || channel.deleted_at_ms !== null || channel.is_thread === 1) return;
    const parent = channel.parent_id ? getChannel(deps.db, channel.parent_id) : undefined;
    const claimed = transaction(deps.db, () => markChannelPolicyReviewSending(deps.db, reviewId, deps.now()));
    if (!claimed) return;
    const payload = deps.build({
      reviewId,
      channelId: channel.id,
      channelName: channel.name,
      channelKind: channel.kind,
      parentId: channel.parent_id,
      parentName: parent?.name ?? null,
    }, deps.secret);
    let sent: { id: string };
    try {
      sent = await deps.port.send(deps.reviewChannelId, payload);
    } catch (cause) {
      transaction(deps.db, () => markChannelPolicyReviewDeliveryFailed(deps.db, reviewId, deps.now()));
      throw new TransientJobError('channel policy review card delivery failed', { cause });
    }
    // Deliberately outside the send catch: if SQLite fails after the platform accepted
    // the card, leave `sending` intact so marker recovery prevents a duplicate.
    const recorded = transaction(
      deps.db,
      () => markChannelPolicyReviewSent(deps.db, reviewId, sent.id, deps.now()),
    );
    if (!recorded) return;
    const afterSend = getChannelPolicyReview(deps.db, reviewId);
    if (afterSend && (afterSend.status === 'org' || afterSend.status === 'restricted' || afterSend.status === 'excluded')) {
      try {
        await deps.port.resolve(
          deps.reviewChannelId,
          sent.id,
          `Channel classification saved: ${afterSend.status}.`,
        );
      } catch {
        // The durable decision remains authoritative; this edit is cosmetic.
      }
    }
  };
}

export type ChannelPolicyReviewInteractionOutcome =
  | 'decided'
  | 'unauthorized'
  | 'stale'
  | 'not_found'
  /** Basic mode refuses classification cards: the env selection decides (Section 8.4). */
  | 'basic_mode';

export function applyChannelPolicyReviewDecision(input: {
  db: DatabaseSync;
  policy: ChannelPolicy;
  reviewId: string;
  decision: ChannelPolicyReviewDecision;
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  adminRoleIds: readonly string[];
  /** The clicked card proves delivery across the send/DB crash window. */
  deliveredMessageId?: string;
  /**
   * Source the active policy was built from. 'basic' refuses the decision: an
   * approved card would mutate a policy that rebuilds from the environment at
   * the next restart. Omitted or 'file' applies the decision.
   */
  channelPolicySource?: ChannelPolicySource;
  now: number;
}): { outcome: ChannelPolicyReviewInteractionOutcome; reviewMessageId?: string } {
  const authorization = authorizeAdmin(input.memberRoleIds, input.adminRoleIds);
  if (!authorization.authorized) {
    recordAdminEvent(input.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'channel_policy_review',
      target: input.reviewId,
      details: { authorized: false, reason: authorization.reason, decision: input.decision },
      createdAtMs: input.now,
    });
    return { outcome: 'unauthorized' };
  }

  return transactionImmediate(input.db, () => {
    const review = getChannelPolicyReview(input.db, input.reviewId);
    if (!review) {
      recordAdminEvent(input.db, {
        guildId: input.guildId, actorUserId: input.actorUserId,
        action: 'channel_policy_review', target: input.reviewId,
        details: { authorized: true, outcome: 'not_found', decision: input.decision },
        createdAtMs: input.now,
      });
      return { outcome: 'not_found' as const };
    }
    // Basic mode owns classification through the selection lists; a decision
    // here would be undone by the next restart. Refuse before the staleness
    // checks so even a valid card earns the operator-facing explanation.
    if (input.channelPolicySource === 'basic') {
      recordAdminEvent(input.db, {
        guildId: input.guildId, actorUserId: input.actorUserId,
        action: 'channel_policy_review', target: review.id,
        details: { authorized: true, outcome: 'basic_mode', decision: input.decision, channelId: review.channel_id },
        createdAtMs: input.now,
      });
      return { outcome: 'basic_mode' as const, reviewMessageId: review.review_message_id ?? undefined };
    }
    const channel = getChannel(input.db, review.channel_id);
    const parent = channel?.parent_id ? getChannel(input.db, channel.parent_id) : undefined;
    const staticPolicy = channel ? resolveChannel(input.policy, channel.id, {
      isThread: channel.is_thread === 1,
      parentId: channel.is_thread === 1 ? channel.parent_id ?? undefined : undefined,
      categoryId: channel.is_thread === 1 ? parent?.parent_id ?? undefined : channel.parent_id ?? undefined,
      isPrivateThread: channel.is_thread === 1 && channel.is_private_thread === 1,
    }) : undefined;
    const valid = review.status === 'pending'
      && review.workspace_id === input.guildId
      && channel?.workspace_id === input.guildId
      && channel.deleted_at_ms === null
      && channel.is_thread === 0
      && channel.parent_id === review.observed_parent_id
      && channel.id !== input.policy.review_channel?.id
      && staticPolicy?.source === 'default';
    if (!valid || !channel) {
      recordAdminEvent(input.db, {
        guildId: input.guildId, actorUserId: input.actorUserId,
        action: 'channel_policy_review', target: input.reviewId,
        details: { authorized: true, outcome: 'stale', decision: input.decision, channelId: review.channel_id },
        createdAtMs: input.now,
      });
      return { outcome: 'stale' as const, reviewMessageId: review.review_message_id ?? undefined };
    }
    if (!decideChannelPolicyReview(input.db, {
      reviewId: review.id,
      decision: input.decision,
      actorUserId: input.actorUserId,
      now: input.now,
    })) {
      recordAdminEvent(input.db, {
        guildId: input.guildId, actorUserId: input.actorUserId,
        action: 'channel_policy_review', target: review.id,
        details: { authorized: true, outcome: 'race_lost', decision: input.decision, channelId: channel.id },
        createdAtMs: input.now,
      });
      return { outcome: 'stale' as const, reviewMessageId: review.review_message_id ?? undefined };
    }
    if (input.deliveredMessageId && review.review_message_id === null) {
      input.db.prepare(`UPDATE channel_policy_reviews
        SET delivery_state='sent',review_message_id=?,updated_at_ms=?
        WHERE id=? AND status=? AND review_message_id IS NULL`).run(
        input.deliveredMessageId,
        input.now,
        review.id,
        input.decision,
      );
    }
    const rule = REVIEWED_CHANNEL_RULES[input.decision];
    input.db.prepare(`UPDATE channels SET ingest_enabled=?,visibility_class=?,
      allow_interventions=0,updated_at_ms=? WHERE id=?`).run(
      rule.ingest ? 1 : 0,
      rule.visibility,
      input.now,
      channel.id,
    );
    input.db.prepare(`UPDATE sync_cursors SET state=CASE
      WHEN ?=0 THEN 'excluded'
      WHEN state='excluded' AND history_complete=1 THEN 'live'
      WHEN state='excluded' THEN 'pending'
      ELSE state END,updated_at_ms=? WHERE channel_id=?`).run(
      rule.ingest ? 1 : 0,
      input.now,
      channel.id,
    );
    if (rule.ingest) {
      const cursor = input.db.prepare('SELECT history_complete FROM sync_cursors WHERE channel_id=?')
        .get(channel.id) as { history_complete: number } | undefined;
      if (!cursor || cursor.history_complete !== 1) {
        enqueue(input.db, { type: 'backfill_channel', payload: { channelId: channel.id },
          uniqueKey: `backfill:${channel.id}`, now: input.now });
      }
      enqueue(input.db, { type: 'reconcile_channel', payload: { channelId: channel.id },
        uniqueKey: `reconcile:${channel.id}`, now: input.now });
    } else {
      enqueue(input.db, { type: 'rescope_memories', payload: {}, uniqueKey: 'policy:rescope', now: input.now });
    }
    recordAdminEvent(input.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'channel_policy_review',
      target: review.id,
      details: {
        authorized: true,
        outcome: 'decided',
        decision: input.decision,
        channelId: channel.id,
        previousVisibility: channel.visibility_class,
        visibility: rule.visibility,
      },
      createdAtMs: input.now,
    });
    return {
      outcome: 'decided' as const,
      reviewMessageId: review.review_message_id ?? input.deliveredMessageId,
    };
  });
}

/** The reviewer-facing reply for an approve outcome. */
export function labelForApprove(outcome: ApproveOutcome): string {
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

/** The reviewer-facing reply for a dismiss outcome. */
export function labelForDismiss(outcome: DismissOutcome): string {
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

/** The reviewer-facing reply for each channel-policy decision outcome. */
export const CHANNEL_POLICY_REVIEW_LABELS: Readonly<Record<ChannelPolicyReviewInteractionOutcome, string>> = {
  decided: 'Channel classification saved.',
  unauthorized: 'You are not authorized to classify Mneme channels.',
  stale: 'This channel review is stale or already resolved.',
  not_found: 'This channel review could not be found.',
  basic_mode:
    'This deployment selects channels with environment variables, so classification cards are disabled. '
    + 'Change ORG_VISIBLE_CHANNEL_IDS or RESTRICTED_CHANNEL_IDS, or set CHANNEL_POLICY_SOURCE=file, then restart Mneme.',
};
