import type { VisibilityClass } from '../db/repositories/channels.js';
import { scopeAnchorId } from '../policy/scope-anchor.js';

/**
 * Effective memory-scope computation (Section 7.2).
 *
 * Each memory's evidence lives in one or more channels. Its effective scope is
 * the strictest scope that safely contains all of that evidence — never broader.
 * The model may *suggest* a scope; the host ignores it and computes the truth
 * from the evidence channels' current visibility classes.
 *
 * Rules (applied after normalizing each thread's evidence onto its parent):
 *   - any excluded or review_only evidence → review_only (fail closed)
 *   - evidence from multiple distinct restricted channels → review_only
 *   - evidence from exactly one restricted channel → channel (scope_key = it)
 *   - all-org evidence → org
 *
 * Unknown channels (no visibility record) cannot be proven org, so they are
 * treated as restricted contributors — consistent with the fail-closed default
 * (Section 7.1).
 */

export type ScopeType = 'org' | 'channel' | 'review_only';

export interface EffectiveScope {
  scopeType: ScopeType;
  /** Present only for `channel` scope; null for org/review_only. */
  scopeKey: string | null;
}

/**
 * Combine the stored, admin-adjudicated audience with the scope recomputed from
 * current evidence. Automatic reads may tighten immediately, but never widen a
 * memory beyond its stored audience. Different restricted anchors are
 * incomparable and therefore collapse to review-only.
 */
export function narrowestMemoryScope(
  stored: EffectiveScope,
  recomputed: EffectiveScope,
): EffectiveScope {
  if (
    stored.scopeType === 'review_only' ||
    recomputed.scopeType === 'review_only'
  ) {
    return { scopeType: 'review_only', scopeKey: null };
  }
  if (stored.scopeType === 'org') return recomputed;
  if (recomputed.scopeType === 'org') return stored;
  if (
    stored.scopeKey !== null &&
    recomputed.scopeKey !== null &&
    stored.scopeKey === recomputed.scopeKey
  ) {
    return { scopeType: 'channel', scopeKey: stored.scopeKey };
  }
  return { scopeType: 'review_only', scopeKey: null };
}

export interface ScopeEvidenceChannel {
  channelId: string;
  /** True when this evidence lives in a thread (see {@link scopeAnchorId}). */
  isThread: boolean;
}

export interface VisibilityLookup {
  /** The channel row's current resolved class, including explicit thread overrides. */
  visibilityClass(channelId: string): VisibilityClass | undefined;
  /** The parent channel id of a thread, or null when it is a top-level channel. */
  parentChannelId(channelId: string): string | null;
}

/**
 * Compute the effective scope for a memory from its evidence channels. An empty
 * evidence set is treated as review_only — a memory with no provenance cannot
 * be asserted at any scope.
 */
export function computeEffectiveScope(
  evidence: ScopeEvidenceChannel[],
  lookup: VisibilityLookup,
): EffectiveScope {
  if (evidence.length === 0) return { scopeType: 'review_only', scopeKey: null };

  const restrictedChannels = new Set<string>();

  for (const ev of evidence) {
    // A thread row already stores its fully resolved class, including an
    // explicit override. Only its restricted-scope anchor may move onto the
    // parent, and only when the parent is itself restricted (Section 7.2).
    // Replacing visibility with the parent's class would silently erase
    // explicit thread policy.
    const visibility = lookup.visibilityClass(ev.channelId);
    const parentId = ev.isThread ? lookup.parentChannelId(ev.channelId) : null;
    const anchorId = scopeAnchorId(
      { id: ev.channelId, isThread: ev.isThread, parentId },
      parentId === null ? undefined : lookup.visibilityClass(parentId),
    );

    switch (visibility) {
      case 'org':
        // Org evidence never broadens; it does not restrict. Contributes nothing.
        break;
      case 'review_only':
      case 'excluded':
        // Fail closed: excluded or review-only evidence cannot be asserted.
        return { scopeType: 'review_only', scopeKey: null };
      case 'restricted':
      case undefined:
        // Restricted (or unknown → treated as restricted) narrows scope.
        restrictedChannels.add(anchorId);
        break;
    }
  }

  if (restrictedChannels.size === 0) return { scopeType: 'org', scopeKey: null };
  if (restrictedChannels.size === 1) {
    return { scopeType: 'channel', scopeKey: [...restrictedChannels][0] ?? null };
  }
  return { scopeType: 'review_only', scopeKey: null };
}
