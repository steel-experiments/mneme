import type { DatabaseSync } from '../db/database.js';
import { transaction } from '../db/database.js';
import { getChannel, type ChannelRow } from '../db/repositories/channels.js';
import {
  getActiveChannelPolicyReview,
  reconcileChannelPolicyReview,
  type ChannelPolicyReviewSupersededReason,
} from '../db/repositories/channel-policy-reviews.js';
import { enqueue } from '../jobs/queue.js';
import type { ChannelPolicySource } from '../config.js';
import type { ChannelKind } from '../platform/types.js';
import { resolveChannel, type ChannelPolicy, type ResolvedPolicy } from './channel-policy.js';
import {
  isReviewableTopLevelChannelKind,
  resolveEffectiveChannelPolicy,
} from './channel-policy-review.js';

export const CHANNEL_POLICY_REVIEW_JOB_PRIORITY = 40;

export interface ObservedChannelIdentity {
  id: string;
  guildId: string;
  parentId: string | null;
  isThread: boolean;
  /** Channel kind used to reject voice/category/stage and other unsupported rows. */
  kind: ChannelKind;
  /** Optional already-resolved category from a complete discovery graph. */
  categoryId?: string | null;
  /**
   * Platform boundary seen now by the adapter. Omit it to use the stored value
   * of the row; a thread also inherits its parent's stored boundary.
   */
  platformBoundary?: 'excluded' | null;
  /**
   * True for a platform private thread (Discord type 12). Omit it to use the
   * stored value of the row.
   */
  isPrivateThread?: boolean;
}

/** The boundary that applies to a channel: its own, or its thread parent's (fail closed). */
export function platformBoundaryFor(db: DatabaseSync, channel: ObservedChannelIdentity): 'excluded' | null {
  if (channel.platformBoundary === 'excluded') return 'excluded';
  // A stored exclusion is permanent: a later observation without it does not open the channel.
  if (getChannel(db, channel.id)?.platform_boundary === 'excluded') return 'excluded';
  if (channel.isThread && channel.parentId && getChannel(db, channel.parentId)?.platform_boundary === 'excluded') {
    return 'excluded';
  }
  return null;
}

function staticPolicyForIdentity(
  db: DatabaseSync,
  policy: ChannelPolicy,
  channel: ObservedChannelIdentity,
): ResolvedPolicy {
  const parent = channel.isThread && channel.parentId
    ? getChannel(db, channel.parentId)
    : undefined;
  return resolveChannel(policy, channel.id, {
    isThread: channel.isThread,
    parentId: channel.isThread ? channel.parentId ?? undefined : undefined,
    categoryId: channel.categoryId
      ?? (channel.isThread ? parent?.parent_id ?? undefined : channel.parentId ?? undefined),
    isPrivateThread: channel.isThread
      && (channel.isPrivateThread ?? getChannel(db, channel.id)?.is_private_thread === 1),
  });
}

/**
 * Resolve the effective rule for one observed channel. A stored review
 * decision is consulted only when the policy source is 'file'. In basic mode
 * the selection lists decide every channel, so a review row left by an earlier
 * file-mode deployment is never read: an unselected channel keeps the
 * fail-closed default even before reconciliation supersedes the row
 * (Section 8.4).
 */
export function resolveObservedChannelPolicy(
  db: DatabaseSync,
  policy: ChannelPolicy,
  channel: ObservedChannelIdentity,
  options: { channelPolicySource?: ChannelPolicySource } = {},
) {
  const staticPolicy = staticPolicyForIdentity(db, policy, channel);
  return resolveEffectiveChannelPolicy({
    channelId: channel.id,
    guildId: channel.guildId,
    parentId: channel.parentId,
    isThread: channel.isThread,
    channelKind: channel.kind,
    reviewChannelId: policy.review_channel?.id,
    staticPolicy,
    activeReview: options.channelPolicySource === 'basic'
      ? undefined
      : getActiveChannelPolicyReview(db, channel.id),
    platformBoundary: platformBoundaryFor(db, channel),
  });
}

function ineligibleReason(
  policy: ChannelPolicy,
  channel: ObservedChannelIdentity,
  staticPolicy: ResolvedPolicy,
  override?: ChannelPolicyReviewSupersededReason,
): ChannelPolicyReviewSupersededReason {
  if (override) return override;
  if (channel.id === policy.review_channel?.id) return 'review_channel';
  if (staticPolicy.source !== 'default') return 'static_policy';
  return 'unsupported';
}

/**
 * Reconcile and enqueue one already-persisted observation. The caller must own a
 * short transaction; this function performs no network I/O.
 */
export function reconcileObservedChannelPolicyReviewInTransaction(
  db: DatabaseSync,
  policy: ChannelPolicy,
  channel: ObservedChannelIdentity,
  now: number,
  options: {
    accessible?: boolean;
    deleted?: boolean;
    unsupported?: boolean;
    /** Explicit admin/config transition that intentionally classifies an older row. */
    forceReview?: boolean;
    /**
     * Source the active policy was built from. 'basic' suppresses
     * classification reviews: the selection lists are the operator's explicit
     * choice, an approved card would be undone by the next restart, and empty
     * lists in a large guild would queue one card per discovered channel
     * (Section 8.4). Omitted or 'file' queues a review for every eligible
     * default-resolved channel.
     */
    channelPolicySource?: ChannelPolicySource;
  } = {},
): { reviewId?: string; enqueued: boolean; created: boolean; superseded: boolean } {
  const staticPolicy = staticPolicyForIdentity(db, policy, channel);
  const row = getChannel(db, channel.id);
  const migration = db.prepare('SELECT applied_at_ms FROM schema_migrations WHERE version=22')
    .get() as { applied_at_ms: number } | undefined;
  const existingReview = getActiveChannelPolicyReview(db, channel.id);
  const observedAfterActivation = row !== undefined
    && migration !== undefined
    && row.discovered_at_ms >= migration.applied_at_ms;
  const classificationReviewsEnabled = options.channelPolicySource !== 'basic';
  const boundary = platformBoundaryFor(db, channel);
  const eligible = classificationReviewsEnabled
    && boundary === null
    && options.accessible !== false
    && options.deleted !== true
    && options.unsupported !== true
    && !channel.isThread
    && isReviewableTopLevelChannelKind(channel.kind)
    && policy.review_channel?.secure === true
    && channel.id !== policy.review_channel?.id
    && staticPolicy.source === 'default'
    && (options.forceReview === true || existingReview !== undefined || observedAfterActivation);
  const reason = options.deleted
    ? 'channel_deleted'
    : boundary !== null
      ? 'unsupported'
      : classificationReviewsEnabled
      ? ineligibleReason(policy, channel, staticPolicy)
      // The basic selection decides every channel explicitly (selected list or
      // fail-closed default), so a review row has nothing left to classify.
      : 'static_policy';
  const result = reconcileChannelPolicyReview(db, {
    guildId: channel.guildId,
    channelId: channel.id,
    observedParentId: channel.parentId,
    eligible,
    ineligibleReason: reason,
    now,
  });
  const review = result.review;
  if (!review || review.status !== 'pending' || review.delivery_state === 'sent') {
    return { reviewId: review?.id, enqueued: false, created: result.created, superseded: result.superseded };
  }
  const enqueued = enqueue(db, {
    type: 'deliver_channel_policy_review',
    payload: { reviewId: review.id },
    uniqueKey: `channel-policy-review:${review.id}`,
    priority: CHANNEL_POLICY_REVIEW_JOB_PRIORITY,
    now,
  }).enqueued;
  return { reviewId: review.id, enqueued, created: result.created, superseded: result.superseded };
}

export function reconcileStoredChannelPolicyReview(
  db: DatabaseSync,
  policy: ChannelPolicy,
  channelId: string,
  now: number,
  options: {
    accessible?: boolean;
    deleted?: boolean;
    unsupported?: boolean;
    forceReview?: boolean;
    /** Policy source; 'basic' suppresses classification reviews (Section 8.4). */
    channelPolicySource?: ChannelPolicySource;
  } = {},
) {
  return transaction(db, () => {
    const row = getChannel(db, channelId);
    if (!row) return { enqueued: false, created: false, superseded: false };
    return reconcileObservedChannelPolicyReviewInTransaction(
      db,
      policy,
      rowIdentity(row),
      now,
      options,
    );
  });
}

export function rowIdentity(row: ChannelRow): ObservedChannelIdentity {
  return {
    id: row.id,
    guildId: row.workspace_id,
    parentId: row.parent_id,
    isThread: row.is_thread === 1,
    kind: row.kind,
    platformBoundary: row.platform_boundary,
    isPrivateThread: row.is_private_thread === 1,
  };
}
