import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';

export type ChannelPolicyReviewStatus =
  | 'pending'
  | 'org'
  | 'restricted'
  | 'excluded'
  | 'superseded';
export type ChannelPolicyReviewDecision = 'org' | 'restricted' | 'excluded';
export type ChannelPolicyReviewDeliveryState = 'queued' | 'sending' | 'sent' | 'failed';
export type ChannelPolicyReviewSupersededReason =
  | 'static_policy'
  | 'parent_changed'
  | 'channel_deleted'
  | 'unsupported'
  | 'review_channel';

export interface ChannelPolicyReviewRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  observed_parent_id: string | null;
  status: ChannelPolicyReviewStatus;
  delivery_state: ChannelPolicyReviewDeliveryState;
  review_message_id: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at_ms: number | null;
  superseded_reason: ChannelPolicyReviewSupersededReason | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export function getChannelPolicyReview(
  db: DatabaseSync,
  reviewId: string,
): ChannelPolicyReviewRow | undefined {
  return prepareCached(
    db,
    'channel-policy-reviews.get',
    'SELECT * FROM channel_policy_reviews WHERE id = ?',
  ).get(reviewId) as ChannelPolicyReviewRow | undefined;
}

export function getActiveChannelPolicyReview(
  db: DatabaseSync,
  channelId: string,
): ChannelPolicyReviewRow | undefined {
  return prepareCached(
    db,
    'channel-policy-reviews.get-active',
    `SELECT * FROM channel_policy_reviews
      WHERE channel_id = ? AND status <> 'superseded'
      LIMIT 1`,
  ).get(channelId) as ChannelPolicyReviewRow | undefined;
}

export interface ReconcileChannelPolicyReviewInput {
  guildId: string;
  channelId: string;
  observedParentId: string | null;
  eligible: boolean;
  ineligibleReason?: ChannelPolicyReviewSupersededReason;
  now: number;
}

export interface ReconcileChannelPolicyReviewResult {
  review?: ChannelPolicyReviewRow;
  created: boolean;
  superseded: boolean;
}

/**
 * Converge one channel's durable review observation. The caller owns the short
 * transaction. No Discord work occurs here.
 */
export function reconcileChannelPolicyReview(
  db: DatabaseSync,
  input: ReconcileChannelPolicyReviewInput,
): ReconcileChannelPolicyReviewResult {
  let active = getActiveChannelPolicyReview(db, input.channelId);
  let superseded = false;
  const parentMatches = active?.observed_parent_id === input.observedParentId;
  if (active && (!input.eligible || !parentMatches)) {
    const reason = input.eligible
      ? 'parent_changed'
      : input.ineligibleReason ?? 'unsupported';
    const changes = Number(prepareCached(
      db,
      'channel-policy-reviews.supersede',
      `UPDATE channel_policy_reviews
          SET status = 'superseded', superseded_reason = ?, updated_at_ms = ?
        WHERE id = ? AND status <> 'superseded'`,
    ).run(reason, input.now, active.id).changes);
    superseded = changes > 0;
    active = undefined;
  }

  if (!input.eligible) return { created: false, superseded };
  if (active) return { review: active, created: false, superseded };

  const id = randomUUID();
  prepareCached(
    db,
    'channel-policy-reviews.insert',
    `INSERT INTO channel_policy_reviews (
       id,workspace_id,channel_id,observed_parent_id,status,delivery_state,
       created_at_ms,updated_at_ms
     ) VALUES (?,?,?,?,'pending','queued',?,?)`,
  ).run(id, input.guildId, input.channelId, input.observedParentId, input.now, input.now);
  return {
    review: getChannelPolicyReview(db, id),
    created: true,
    superseded,
  };
}

export function markChannelPolicyReviewSending(
  db: DatabaseSync,
  reviewId: string,
  now: number,
): boolean {
  return Number(prepareCached(
    db,
    'channel-policy-reviews.mark-sending',
    `UPDATE channel_policy_reviews
        SET delivery_state='sending',updated_at_ms=?
      WHERE id=? AND status='pending' AND delivery_state IN ('queued','failed')`,
  ).run(now, reviewId).changes) > 0;
}

export function markChannelPolicyReviewSent(
  db: DatabaseSync,
  reviewId: string,
  platformMessageId: string,
  now: number,
): boolean {
  return Number(prepareCached(
    db,
    'channel-policy-reviews.mark-sent',
      `UPDATE channel_policy_reviews
        SET delivery_state='sent',review_message_id=?,updated_at_ms=?
      WHERE id=? AND status<>'superseded' AND delivery_state='sending'`,
  ).run(platformMessageId, now, reviewId).changes) > 0;
}

export function markChannelPolicyReviewDeliveryFailed(
  db: DatabaseSync,
  reviewId: string,
  now: number,
): boolean {
  return Number(prepareCached(
    db,
    'channel-policy-reviews.mark-failed',
    `UPDATE channel_policy_reviews
        SET delivery_state='failed',updated_at_ms=?
      WHERE id=? AND status='pending' AND delivery_state='sending'`,
  ).run(now, reviewId).changes) > 0;
}

export function resetSendingChannelPolicyReviews(db: DatabaseSync, now: number): number {
  return Number(prepareCached(
    db,
    'channel-policy-reviews.reset-sending',
    `UPDATE channel_policy_reviews
        SET delivery_state='queued',updated_at_ms=?
      WHERE status='pending' AND delivery_state='sending' AND review_message_id IS NULL`,
  ).run(now).changes);
}

/** Conditional decision primitive. Call inside the workflow's immediate transaction. */
export function decideChannelPolicyReview(
  db: DatabaseSync,
  input: {
    reviewId: string;
    decision: ChannelPolicyReviewDecision;
    actorUserId: string;
    now: number;
  },
): boolean {
  return Number(prepareCached(
    db,
    'channel-policy-reviews.decide',
    `UPDATE channel_policy_reviews
        SET status=?,reviewed_by_user_id=?,reviewed_at_ms=?,updated_at_ms=?
      WHERE id=? AND status='pending'`,
  ).run(input.decision, input.actorUserId, input.now, input.now, input.reviewId).changes) > 0;
}

export function countPendingChannelPolicyReviews(db: DatabaseSync, guildId: string): number {
  const row = prepareCached(
    db,
    'channel-policy-reviews.count-pending',
    `SELECT COUNT(*) AS count FROM channel_policy_reviews
      WHERE workspace_id=? AND status='pending'`,
  ).get(guildId) as { count: number };
  return row.count;
}

export function countFailedChannelPolicyReviewDeliveries(db: DatabaseSync, guildId: string): number {
  const row = prepareCached(
    db,
    'channel-policy-reviews.count-failed-delivery',
    `SELECT COUNT(*) AS count FROM channel_policy_reviews
      WHERE workspace_id=? AND status='pending' AND delivery_state='failed'`,
  ).get(guildId) as { count: number };
  return row.count;
}
