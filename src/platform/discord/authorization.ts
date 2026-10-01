// ABOUTME: Reads role ids from a discord.js member for admin authorization.
// ABOUTME: Returns null when roles cannot be read, so authorization fails closed.

/** Structural slice of a discord.js member/interaction carrying resolvable roles. */
export interface MemberWithRoles {
  /**
   * A cached `GuildMember` exposes `roles.cache.keys()`; a raw
   * `APIInteractionGuildMember` exposes `roles: string[]`. Both are accepted.
   */
  roles?:
    | { cache?: { keys?(): IterableIterator<string> } }
    | readonly string[]
    | null;
}

/**
 * Extract role IDs from a discord.js member, or return null when the roles could
 * not be resolved (partial member, cache miss). A cached `GuildMember` exposes
 * roles via `roles.cache.keys()`; a raw `APIInteractionGuildMember` (seen when
 * the member is not cached) exposes them as a plain `roles: string[]`. Returning
 * null — not an empty array — is what lets `authorizeAdmin` treat unresolved
 * roles as fail-closed.
 */
export function extractMemberRoleIds(
  member: MemberWithRoles | null | undefined,
): readonly string[] | null {
  const roles = member?.roles;
  // Cached GuildMember form: roles.cache.keys(). The runtime guard confirms a
  // non-array object; the cast bridges TS's readonly-array narrowing gap.
  if (roles !== null && typeof roles === 'object' && !Array.isArray(roles)) {
    const cache = (roles as { cache?: { keys?(): IterableIterator<string> } }).cache;
    if (cache && typeof cache.keys === 'function') return Array.from(cache.keys());
    return null;
  }
  // Raw APIInteractionGuildMember form: roles is a string[].
  if (Array.isArray(roles)) {
    return roles.filter((r): r is string => typeof r === 'string');
  }
  return null;
}
