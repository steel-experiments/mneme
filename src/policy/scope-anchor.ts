// ABOUTME: Computes the canonical restricted-scope anchor of a channel (spec Sections 7.1 and 7.2).
// ABOUTME: One TypeScript rule and one matching SQL fragment; every scope check uses them.
import type { VisibilityClass } from '../db/repositories/channels.js';

/** The channel facts that decide its restricted-scope anchor. */
export interface ScopeAnchorChannel {
  id: string;
  isThread: boolean;
  parentId: string | null;
}

/**
 * The canonical restricted-scope anchor. A top-level channel anchors on itself.
 * A thread anchors on its parent only when the parent's resolved class is
 * restricted, so the thread shares the restricted family of that parent. A
 * thread below a parent with any other class (for example an explicitly
 * restricted thread below an org channel) anchors on itself, so its content
 * never reaches sibling threads. A missing parent never broadens the anchor;
 * callers that need a live parent check that separately and fail closed.
 */
export function scopeAnchorId(channel: ScopeAnchorChannel, parentVisibility: VisibilityClass | undefined): string {
  if (channel.isThread && channel.parentId !== null && parentVisibility === 'restricted') return channel.parentId;
  return channel.id;
}

/**
 * The SQL form of {@link scopeAnchorId} for a `channels` row aliased `alias`.
 * The two forms must agree; `test/unit/scope-anchor.test.ts` proves it.
 */
export function scopeAnchorSql(alias: string): string {
  return `(CASE WHEN ${alias}.is_thread = 1 AND EXISTS (
      SELECT 1 FROM channels scope_anchor_parent
       WHERE scope_anchor_parent.id = ${alias}.parent_id
         AND scope_anchor_parent.visibility_class = 'restricted'
    ) THEN ${alias}.parent_id ELSE ${alias}.id END)`;
}
