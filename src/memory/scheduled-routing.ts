import type { DatabaseSync } from '../db/database.js';
import { getChannel, resolveRetrievableChannelScope, type VisibilityClass } from '../db/repositories/channels.js';
import { isMnemeTestSurface } from '../discord/test-channels.js';
import { getMemory } from './repository.js';
import { recomputeMemoryScopes } from './search.js';

export type ScheduledRouteReason =
  | 'no_origin'
  | 'multiple_origins'
  | 'ambiguous_lineage'
  | 'review_only_scope'
  | 'scope_mismatch'
  | 'stale_origin'
  | 'interventions_disabled'
  | 'thread_unavailable'
  | 'control_surface'
  | 'unsafe_target'
  | 'review_channel_unavailable'
  | 'review_audience_mismatch'
  | 'wrong_guild'
  | 'memory_unavailable';

export type ScheduledMemoryRoute =
  | {
      kind: 'working';
      targetChannelId: string;
      scopeChannelId: string;
      visibility: 'org' | 'restricted';
    }
  | { kind: 'secure_maintenance'; targetChannelId: string; reason: ScheduledRouteReason }
  | { kind: 'suppress'; targetChannelId: null; reason: ScheduledRouteReason };

export interface ScheduledRouteOptions {
  guildId: string;
  reviewChannelId: string;
  reviewAcceptedScopes: readonly VisibilityClass[];
}

const MAX_LINEAGE_DEPTH = 32;

function audienceAccepts(scopeType: string, accepted: readonly VisibilityClass[]): boolean {
  if (scopeType === 'org') return accepted.includes('org');
  if (scopeType === 'channel') return accepted.includes('restricted');
  return accepted.includes('review_only');
}

function fallback(
  db: DatabaseSync,
  scopeType: string,
  reason: ScheduledRouteReason,
  options: ScheduledRouteOptions,
): ScheduledMemoryRoute {
  const review = getChannel(db, options.reviewChannelId);
  if (
    !review
    || review.workspace_id !== options.guildId
    || review.deleted_at_ms !== null
    || review.ingest_enabled !== 1
    || review.visibility_class === 'excluded'
    || options.reviewAcceptedScopes.length === 0
  ) {
    return { kind: 'suppress', targetChannelId: null, reason: 'review_channel_unavailable' };
  }
  if (!audienceAccepts(scopeType, options.reviewAcceptedScopes)) {
    return { kind: 'suppress', targetChannelId: null, reason: 'review_audience_mismatch' };
  }
  return { kind: 'secure_maintenance', targetChannelId: options.reviewChannelId, reason };
}

function directOrigins(db: DatabaseSync, memoryId: string): Array<{
  message_id: string;
  channel_id: string | null;
  message_guild_id: string | null;
  deleted_at_ms: number | null;
}> {
  return db.prepare(
    `SELECT me.message_id, msg.channel_id, msg.workspace_id AS message_guild_id, msg.deleted_at_ms
       FROM memory_evidence me
       LEFT JOIN messages msg ON msg.id = me.message_id
      WHERE me.memory_id = ? AND me.stance = 'origin'
      ORDER BY me.message_id`,
  ).all(memoryId) as Array<{
    message_id: string;
    channel_id: string | null;
    message_guild_id: string | null;
    deleted_at_ms: number | null;
  }>;
}

function inheritedOrigins(db: DatabaseSync, memoryId: string): {
  origins: ReturnType<typeof directOrigins>;
  reason?: ScheduledRouteReason;
} {
  const seen = new Set<string>();
  let currentId: string | null = memoryId;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH && currentId; depth += 1) {
    if (seen.has(currentId)) return { origins: [], reason: 'ambiguous_lineage' };
    seen.add(currentId);
    const memory = getMemory(db, currentId);
    if (!memory) return { origins: [], reason: 'ambiguous_lineage' };
    const origins = directOrigins(db, currentId);
    if (origins.length > 0) return { origins };
    currentId = memory.supersedes_memory_id;
  }
  if (currentId !== null) return { origins: [], reason: 'ambiguous_lineage' };
  return { origins: [], reason: 'no_origin' };
}

/** Resolve one due memory to its exact current delivery or maintenance audience. */
export function resolveScheduledMemoryRoute(
  db: DatabaseSync,
  memoryId: string,
  options: ScheduledRouteOptions,
): ScheduledMemoryRoute {
  const memory = getMemory(db, memoryId);
  if (!memory) return { kind: 'suppress', targetChannelId: null, reason: 'memory_unavailable' };
  if (memory.workspace_id !== options.guildId) {
    return { kind: 'suppress', targetChannelId: null, reason: 'wrong_guild' };
  }
  const effective = recomputeMemoryScopes(db, [memoryId]).get(memoryId)
    ?? { scopeType: 'review_only', scopeKey: null };
  const inherited = inheritedOrigins(db, memoryId);
  if (inherited.reason) return fallback(db, effective.scopeType, inherited.reason, options);
  if (inherited.origins.length === 0) return fallback(db, effective.scopeType, 'no_origin', options);

  let targetChannelId: string | undefined;
  for (const origin of inherited.origins) {
    if (
      origin.channel_id === null
      || origin.message_guild_id !== options.guildId
      || origin.deleted_at_ms !== null
      || !resolveRetrievableChannelScope(db, origin.channel_id)
    ) {
      return fallback(db, effective.scopeType, 'stale_origin', options);
    }
    if (targetChannelId !== undefined && targetChannelId !== origin.channel_id) {
      return fallback(db, effective.scopeType, 'multiple_origins', options);
    }
    targetChannelId = origin.channel_id;
  }
  if (!targetChannelId) return fallback(db, effective.scopeType, 'no_origin', options);
  if (targetChannelId === options.reviewChannelId || isMnemeTestSurface(db, targetChannelId)) {
    return fallback(db, effective.scopeType, 'control_surface', options);
  }

  const target = getChannel(db, targetChannelId);
  const current = resolveRetrievableChannelScope(db, targetChannelId);
  if (!target || !current || target.workspace_id !== options.guildId) {
    return fallback(db, effective.scopeType, 'unsafe_target', options);
  }
  if (target.is_thread === 1) {
    const parent = target.parent_id ? getChannel(db, target.parent_id) : undefined;
    if (
      target.is_archived === 1
      || target.is_locked === 1
      || !parent
      || parent.deleted_at_ms !== null
      || parent.ingest_enabled !== 1
      || parent.visibility_class === 'excluded'
    ) {
      return fallback(db, effective.scopeType, 'thread_unavailable', options);
    }
  }
  if (target.allow_interventions !== 1) {
    return fallback(db, effective.scopeType, 'interventions_disabled', options);
  }
  if (
    effective.scopeType === 'review_only'
    || !audienceAccepts(effective.scopeType, options.reviewAcceptedScopes)
  ) {
    return fallback(db, effective.scopeType, effective.scopeType === 'review_only'
      ? 'review_only_scope'
      : 'review_audience_mismatch', options);
  }
  if (current.visibility === 'restricted'
    && (!options.reviewAcceptedScopes.includes('org')
      || !options.reviewAcceptedScopes.includes('restricted'))) {
    // Restricted-target retrieval may expose same-anchor restricted data and
    // organizational memories. The approval inbox must accept both audiences.
    return fallback(db, effective.scopeType, 'review_audience_mismatch', options);
  }
  if (
    (effective.scopeType === 'org' && current.visibility !== 'org')
    || (effective.scopeType === 'channel'
      && (current.visibility !== 'restricted' || effective.scopeKey !== current.scopeChannelId))
  ) {
    return fallback(db, effective.scopeType, 'scope_mismatch', options);
  }
  return {
    kind: 'working',
    targetChannelId,
    scopeChannelId: current.scopeChannelId,
    visibility: current.visibility as 'org' | 'restricted',
  };
}

/** Require every subject to have the same current route and exact target. */
export function resolveScheduledSubjectRoute(
  db: DatabaseSync,
  memoryIds: readonly string[],
  options: ScheduledRouteOptions,
): ScheduledMemoryRoute | undefined {
  if (memoryIds.length === 0) return undefined;
  const routes = memoryIds.map((id) => resolveScheduledMemoryRoute(db, id, options));
  const first = routes[0];
  if (!first) return undefined;
  return routes.every((route) => route.kind === first.kind
    && route.targetChannelId === first.targetChannelId) ? first : undefined;
}
