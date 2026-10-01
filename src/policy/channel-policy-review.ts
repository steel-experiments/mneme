import type { ChannelRule, ResolvedPolicy } from './channel-policy.js';
import type { ChannelPolicyReviewRow } from '../db/repositories/channel-policy-reviews.js';
import type { ChannelKind } from '../platform/types.js';

export const REVIEWED_CHANNEL_RULES = {
  org: { ingest: true, visibility: 'org', allow_interventions: false },
  restricted: { ingest: true, visibility: 'restricted', allow_interventions: false },
  excluded: { ingest: false, visibility: 'excluded', allow_interventions: false },
} as const satisfies Record<'org' | 'restricted' | 'excluded', ChannelRule>;

const REVIEWABLE_TOP_LEVEL_CHANNEL_KINDS = new Set<ChannelKind>(['text', 'announcement', 'forum', 'media']);

export function isReviewableTopLevelChannelKind(kind: ChannelKind): boolean {
  return REVIEWABLE_TOP_LEVEL_CHANNEL_KINDS.has(kind);
}

export interface EffectiveChannelPolicyInput {
  channelId: string;
  guildId: string;
  parentId: string | null;
  isThread: boolean;
  channelKind: ChannelKind;
  reviewChannelId?: string;
  staticPolicy: ResolvedPolicy;
  activeReview?: ChannelPolicyReviewRow;
}

export interface EffectiveChannelPolicy {
  rule: ChannelRule;
  source: ResolvedPolicy['source'] | 'review';
  needsReview: boolean;
}

/** Pure precedence and fail-closed validation for one observed channel. */
export function resolveEffectiveChannelPolicy(
  input: EffectiveChannelPolicyInput,
): EffectiveChannelPolicy {
  if (
    input.isThread
    || !isReviewableTopLevelChannelKind(input.channelKind)
    || input.channelId === input.reviewChannelId
    || input.staticPolicy.source !== 'default'
  ) {
    return { ...input.staticPolicy, needsReview: false };
  }

  const review = input.activeReview;
  if (
    review
    && review.workspace_id === input.guildId
    && review.channel_id === input.channelId
    && review.observed_parent_id === input.parentId
    && (review.status === 'org' || review.status === 'restricted' || review.status === 'excluded')
  ) {
    return { rule: REVIEWED_CHANNEL_RULES[review.status], source: 'review', needsReview: false };
  }

  return { ...input.staticPolicy, needsReview: true };
}
