import { type DatabaseSync } from '../db/database.js';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { prepareCached } from '../db/repositories/util.js';
import {
  channelVisibilityPredicate,
  sanitizeFtsQuery,
  type RetrievalGrant,
} from '../db/repositories/message-search.js';
import {
  computeEffectiveScope,
  narrowestMemoryScope,
  type EffectiveScope,
  type ScopeEvidenceChannel,
  type ScopeType,
  type VisibilityLookup,
} from './scope.js';
import type { MemoryStatus, MemoryType } from './repository.js';
import { messageLink } from '../platform/links.js';

/**
 * Scope-bound memory retrieval (Sections 7.2, 7.3, 12.5, 22.3, 22.4, 30).
 *
 * The stored `scope_type`/`scope_key` is a monotonic audience ceiling. At read
 * time each result's scope is recomputed from its evidence channels' CURRENT
 * visibility and combined with that ceiling (Section 7.2). A channel
 * reclassification therefore tightens results immediately, while an automatic
 * recomputation can never widen them. Only memories whose effective scope is
 * permitted by the grant are returned.
 */

export const MAX_MEMORY_LIMIT = 50;
export const DEFAULT_MEMORY_LIMIT = 10;
/**
 * Page size for the memory archive and evidence pages when the caller names
 * none. It is pinned independently of {@link MAX_MEMORY_LIMIT} so raising the
 * ceiling an explicit caller may ask for never widens an unqualified page.
 */
export const DEFAULT_MEMORY_PAGE_LIMIT = 20;
const CANDIDATE_CAP = 100;
/** Bounded SQL candidate window for query-free memory inventory. Exported for regression tests. */
export const MEMORY_INVENTORY_CANDIDATE_CAP = 500;
const RECENCY_DECAY_DAYS = 30;

export interface SearchMemoriesInput {
  query: string;
  types?: readonly MemoryType[];
  statuses?: readonly MemoryStatus[];
  limit?: number;
  now: number;
}

export interface ListMemoriesInput {
  types?: readonly MemoryType[];
  statuses?: readonly MemoryStatus[];
  limit?: number;
  now: number;
}

/**
 * Bounded inventory page plus an exact count inside the caller's current grant.
 * `totalMatching` is computed before the inventory candidate/result caps, so a
 * caller can distinguish "showing 20" from "only 20 exist".
 */
export interface MemoryInventoryPage {
  items: MemorySearchResult[];
  totalMatching: number;
  returned: number;
  hasMore: boolean;
}

export interface MemoryArchiveCursor {
  importance?: number;
  lastConfirmedAtMs: number;
  id: string;
}

export type MemoryArchiveSort = 'importance' | 'recent';

export interface MemoryArchivePage {
  items: MemorySearchResult[];
  next: MemoryArchiveCursor | null;
  totalMatching: number;
}

export interface MemorySearchResult {
  memoryId: string;
  type: MemoryType;
  statement: string;
  status: MemoryStatus;
  scopeType: string;
  scopeKey: string | null;
  confidence: number;
  importance: number;
  lastConfirmedAtMs: number;
  evidenceCount: number;
  rank: number;
}

interface EvidenceChannelRow {
  memory_id: string;
  channel_id: string;
  visibility_class: string;
  parent_id: string | null;
  is_thread: number;
}

/**
 * Current effective scope derived in SQL so hidden rows cannot occupy a bounded
 * candidate window. The application still independently recomputes every
 * returned candidate below; this SQL layer is an early fail-closed filter, not
 * the sole privacy boundary.
 */
const CURRENT_EVIDENCE_VISIBILITY_SQL = `
  CASE
    WHEN msg.id IS NULL OR msg.deleted_at_ms IS NOT NULL OR c.id IS NULL THEN 'excluded'
    WHEN c.is_thread = 1 AND parent.id IS NULL THEN 'excluded'
    WHEN INSTR(LOWER(COALESCE(c.name, '')), 'mneme') > 0 THEN 'excluded'
    WHEN c.is_thread = 1
      AND INSTR(LOWER(COALESCE(parent.name, '')), 'mneme') > 0 THEN 'excluded'
    ELSE c.visibility_class
  END`;

const RESTRICTED_EVIDENCE_ANCHOR_SQL = `
  CASE WHEN c.is_thread = 1 THEN parent.id ELSE c.id END`;

const EFFECTIVE_MEMORY_SCOPES_CTE = `
  recomputed AS (
    SELECT mem0.id,
           CASE
             WHEN COUNT(me.message_id) = 0 THEN 'review_only'
             WHEN MAX(CASE WHEN (${CURRENT_EVIDENCE_VISIBILITY_SQL}) IN ('review_only','excluded') THEN 1 ELSE 0 END) = 1
               THEN 'review_only'
             WHEN COUNT(DISTINCT CASE WHEN (${CURRENT_EVIDENCE_VISIBILITY_SQL}) = 'restricted'
                                      THEN (${RESTRICTED_EVIDENCE_ANCHOR_SQL}) END) > 1
               THEN 'review_only'
             WHEN COUNT(DISTINCT CASE WHEN (${CURRENT_EVIDENCE_VISIBILITY_SQL}) = 'restricted'
                                      THEN (${RESTRICTED_EVIDENCE_ANCHOR_SQL}) END) = 1
               THEN 'channel'
             ELSE 'org'
           END AS scope_type,
           CASE
             WHEN COUNT(DISTINCT CASE WHEN (${CURRENT_EVIDENCE_VISIBILITY_SQL}) = 'restricted'
                                      THEN (${RESTRICTED_EVIDENCE_ANCHOR_SQL}) END) = 1
             THEN MIN(CASE WHEN (${CURRENT_EVIDENCE_VISIBILITY_SQL}) = 'restricted'
                           THEN (${RESTRICTED_EVIDENCE_ANCHOR_SQL}) END)
             ELSE NULL
           END AS scope_key
      FROM memories mem0
      LEFT JOIN memory_evidence me ON me.memory_id = mem0.id
      LEFT JOIN messages msg ON msg.id = me.message_id
      LEFT JOIN channels c ON c.id = msg.channel_id AND c.ingest_enabled = 1 AND c.deleted_at_ms IS NULL
      LEFT JOIN channels parent ON parent.id = c.parent_id AND parent.ingest_enabled = 1 AND parent.deleted_at_ms IS NULL
     GROUP BY mem0.id
  ),
  effective AS (
    SELECT recomputed.id,
           CASE
             WHEN mem.scope_type = 'review_only' OR recomputed.scope_type = 'review_only'
               THEN 'review_only'
             WHEN mem.scope_type = 'org' THEN recomputed.scope_type
             WHEN recomputed.scope_type = 'org' THEN mem.scope_type
             WHEN mem.scope_key = recomputed.scope_key THEN 'channel'
             ELSE 'review_only'
           END AS scope_type,
           CASE
             WHEN mem.scope_type = 'review_only' OR recomputed.scope_type = 'review_only'
               THEN NULL
             WHEN mem.scope_type = 'org' AND recomputed.scope_type = 'channel'
               THEN recomputed.scope_key
             WHEN mem.scope_type = 'channel' AND recomputed.scope_type = 'org'
               THEN mem.scope_key
             WHEN mem.scope_type = 'channel' AND recomputed.scope_type = 'channel'
               AND mem.scope_key = recomputed.scope_key THEN mem.scope_key
             ELSE NULL
           END AS scope_key
      FROM recomputed
      JOIN memories mem ON mem.id = recomputed.id
  )`;

function effectiveScopeGrantPredicate(grant: RetrievalGrant): {
  sql: string;
  params: SQLInputValue[];
} {
  const permitted: string[] = [];
  const params: SQLInputValue[] = [];
  if (grant.includeOrgMemories) permitted.push("eff.scope_type = 'org'");
  if (grant.includeReviewOnly) permitted.push("eff.scope_type = 'review_only'");
  if (grant.channelIds.length > 0) {
    const ph = grant.channelIds.map(() => '?').join(',');
    permitted.push(`(eff.scope_type = 'channel' AND eff.scope_key IN (${ph}))`);
    params.push(...grant.channelIds);
  }
  return {
    sql: permitted.length > 0 ? `(${permitted.join(' OR ')})` : '1=0',
    params,
  };
}

/**
 * Recompute the effective scope of each memory from its evidence channels'
 * current visibility. Memories whose evidence has been purged (no surviving
 * channel rows) collapse to review_only — fail closed.
 */
export function recomputeMemoryScopes(
  db: DatabaseSync,
  memoryIds: readonly string[],
): Map<string, EffectiveScope> {
  const out = new Map<string, EffectiveScope>();
  if (memoryIds.length === 0) return out;

  const storedRows = prepareCached(
    db,
    `memory.stored_scopes:${memoryIds.length}`,
    `SELECT id, scope_type, scope_key FROM memories WHERE id IN (${memoryIds.map(() => '?').join(',')})`,
  ).all(...memoryIds) as Array<{ id: string; scope_type: ScopeType; scope_key: string | null }>;
  const stored = new Map(storedRows.map((row) => [
    row.id,
    { scopeType: row.scope_type, scopeKey: row.scope_key } satisfies EffectiveScope,
  ]));

  const ph = memoryIds.map(() => '?').join(',');
  const rows = prepareCached(
    db,
    `memory.recompute_scopes:${memoryIds.length}`,
    `SELECT me.memory_id,
            CASE WHEN (${CURRENT_EVIDENCE_VISIBILITY_SQL}) = 'excluded'
                   THEN 'unavailable:' || me.message_id
                 ELSE COALESCE(c.id, msg.channel_id, 'missing:' || me.message_id) END AS channel_id,
            ${CURRENT_EVIDENCE_VISIBILITY_SQL} AS visibility_class,
            CASE WHEN c.is_thread = 1 AND parent.id IS NOT NULL THEN parent.id ELSE NULL END AS parent_id,
            CASE WHEN c.is_thread = 1 AND parent.id IS NOT NULL THEN 1 ELSE 0 END AS is_thread
       FROM memory_evidence me
       LEFT JOIN messages msg ON msg.id = me.message_id
       LEFT JOIN channels c ON c.id = msg.channel_id AND c.ingest_enabled = 1 AND c.deleted_at_ms IS NULL
       LEFT JOIN channels parent ON parent.id = c.parent_id AND parent.ingest_enabled = 1 AND parent.deleted_at_ms IS NULL
      WHERE me.memory_id IN (${ph})`,
  ).all(...memoryIds) as Array<{
    memory_id: string;
    channel_id: string;
    visibility_class: string;
    parent_id: string | null;
    is_thread: number;
  }>;

  const grouped = new Map<string, EvidenceChannelRow[]>();
  for (const id of memoryIds) grouped.set(id, []);
  for (const r of rows) grouped.get(r.memory_id)?.push(r);

  for (const [id, chans] of grouped) {
    const chanMap = new Map<string, EvidenceChannelRow>();
    for (const c of chans) if (!chanMap.has(c.channel_id)) chanMap.set(c.channel_id, c);
    const lookup: VisibilityLookup = {
      visibilityClass: (cid) => chanMap.get(cid)?.visibility_class as never,
      parentChannelId: (cid) => chanMap.get(cid)?.parent_id ?? null,
    };
    const evidence: ScopeEvidenceChannel[] = chans.map((c) => ({
      channelId: c.channel_id,
      isThread: c.is_thread === 1,
    }));
    const recomputed = computeEffectiveScope(evidence, lookup);
    const adjudicated = stored.get(id);
    out.set(id, adjudicated ? narrowestMemoryScope(adjudicated, recomputed) : recomputed);
  }
  return out;
}

/** Whether a recomputed scope is visible under `grant` (Section 7.3). */
export function scopePermitted(
  db: DatabaseSync,
  grant: RetrievalGrant,
  scope: EffectiveScope,
): boolean {
  if (scope.scopeType === 'org') return grant.includeOrgMemories;
  if (scope.scopeType === 'review_only') return grant.includeReviewOnly;
  if (scope.scopeKey === null) return false;
  // A channel-scoped memory is authorized by the canonical scope key itself,
  // not by the anchor channel's own visibility. This matters when an explicitly
  // restricted thread sits below an org parent: the parent is the scope key but
  // must not turn the memory into org-readable content.
  if (!grant.channelIds.includes(scope.scopeKey)) return false;
  const row = prepareCached(
    db,
    'scope.permitted:live_anchor',
    `SELECT 1 FROM channels
      WHERE id = ? AND ingest_enabled = 1 AND deleted_at_ms IS NULL`,
  ).get(scope.scopeKey);
  return row !== undefined;
}

/**
 * FTS search over memories with structured filters (Sections 22.3, 30). Scope is
 * recomputed at read time and only permitted memories are returned, ranked by
 * importance, recency, and evidence density (Section 12.6).
 */
export function searchMemories(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: SearchMemoriesInput,
): MemorySearchResult[] {
  // Kept only as a compatibility sentinel for existing callers. Natural-language
  // intent belongs to the agent; every other string is a literal FTS query.
  if (input.query.trim() === '*') return listMemories(db, grant, input);
  const match = sanitizeFtsQuery(input.query);
  if (match === '') return [];
  const limit = Math.min(MAX_MEMORY_LIMIT, Math.max(1, input.limit ?? DEFAULT_MEMORY_LIMIT));

  const where: string[] = ['memories_fts MATCH ?'];
  const params: SQLInputValue[] = [match];
  if (input.types && input.types.length > 0) {
    const ph = input.types.map(() => '?').join(',');
    where.push(`mem.type IN (${ph})`);
    params.push(...input.types);
  }
  if (input.statuses && input.statuses.length > 0) {
    const ph = input.statuses.map(() => '?').join(',');
    where.push(`mem.status IN (${ph})`);
    params.push(...input.statuses);
  }
  const scope = effectiveScopeGrantPredicate(grant);
  where.push(scope.sql);
  params.push(...scope.params);
  params.push(CANDIDATE_CAP);

  const cacheKey = `memory.search:${input.types?.length ?? 0}:${input.statuses?.length ?? 0}:${grant.includeOrgMemories ? 1 : 0}:${grant.includeReviewOnly ? 1 : 0}:${grant.channelIds.length}`;
  const sql = `
    WITH ${EFFECTIVE_MEMORY_SCOPES_CTE}
    SELECT mem.id, mem.type, mem.statement, mem.status, mem.scope_type, mem.scope_key,
           mem.confidence, mem.importance, mem.last_confirmed_at_ms,
           (SELECT COUNT(*) FROM memory_evidence me WHERE me.memory_id = mem.id) AS evidence_count,
           bm25(memories_fts) AS bm25
      FROM memories_fts
      JOIN memories mem ON mem.rowid = memories_fts.rowid
      JOIN effective eff ON eff.id = mem.id
     WHERE ${where.join(' AND ')}
     ORDER BY bm25 ASC
     LIMIT ?
  `;
  const rows = prepareCached(db, cacheKey, sql).all(...params) as Record<
    string,
    SQLOutputValue
  >[];

  const candidateIds = rows.map((r) => String(r.id));
  const scopes = recomputeMemoryScopes(db, candidateIds);

  const visible = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => scopePermitted(db, grant, scopes.get(String(r.id))!));

  // Stable sort keeps the BM25 ordering (above) as the tiebreak.
  const scored = visible.map(({ r, i }) => {
    const importance = Number(r.importance);
    const lastConfirmed = Number(r.last_confirmed_at_ms);
    const ageDays = Math.max(0, (input.now - lastConfirmed) / 86_400_000);
    const recency = Math.exp(-ageDays / RECENCY_DECAY_DAYS);
    const density = Math.min(1, Number(r.evidence_count) / 5);
    // Lexical position within the candidate window (0 = best BM25).
    const lexical = 1 - i / Math.max(1, rows.length);
    const score = importance * 0.4 + recency * 0.3 + density * 0.2 + lexical * 0.1;
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ r }) => ({
    memoryId: String(r.id),
    type: String(r.type) as MemoryType,
    statement: String(r.statement),
    status: String(r.status) as MemoryStatus,
    scopeType: scopes.get(String(r.id))!.scopeType,
    scopeKey: scopes.get(String(r.id))!.scopeKey,
    confidence: Number(r.confidence),
    importance: Number(r.importance),
    lastConfirmedAtMs: Number(r.last_confirmed_at_ms),
    evidenceCount: Number(r.evidence_count),
    rank: Number(r.bm25),
  }));
}

/**
 * First-class bounded inventory of visible memories. The retrieval grant and
 * current effective evidence scope are applied in SQL before the candidate
 * limit, then independently recomputed before return. Active records are the
 * default so obsolete lifecycle states do not dominate a general inventory.
 */
export function listMemoriesPage(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: ListMemoriesInput,
): MemoryInventoryPage {
  const limit = Math.min(MAX_MEMORY_LIMIT, Math.max(1, input.limit ?? DEFAULT_MEMORY_LIMIT));
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (input.types && input.types.length > 0) {
    where.push(`mem.type IN (${input.types.map(() => '?').join(',')})`);
    params.push(...input.types);
  }
  const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : ['active'];
  where.push(`mem.status IN (${statuses.map(() => '?').join(',')})`);
  params.push(...statuses);
  const scope = effectiveScopeGrantPredicate(grant);
  where.push(scope.sql);
  params.push(...scope.params);
  const baseParams = [...params];
  const cacheShape = `${input.types?.length ?? 0}:${statuses.length}:${grant.includeOrgMemories ? 1 : 0}:${grant.includeReviewOnly ? 1 : 0}:${grant.channelIds.length}`;
  const count = prepareCached(
    db,
    `memory.list_count:${cacheShape}`,
    `WITH ${EFFECTIVE_MEMORY_SCOPES_CTE}
     SELECT COUNT(*) AS n
       FROM memories mem
       JOIN effective eff ON eff.id = mem.id
      WHERE ${where.join(' AND ')}`,
  ).get(...baseParams) as { n: number };
  params.push(MEMORY_INVENTORY_CANDIDATE_CAP);
  const rows = prepareCached(
    db,
    `memory.list:${cacheShape}`,
    `WITH ${EFFECTIVE_MEMORY_SCOPES_CTE}
     SELECT mem.id, mem.type, mem.statement, mem.status, mem.confidence, mem.importance,
            mem.last_confirmed_at_ms,
            (SELECT COUNT(*) FROM memory_evidence me WHERE me.memory_id=mem.id) AS evidence_count
       FROM memories mem
       JOIN effective eff ON eff.id = mem.id
      WHERE ${where.join(' AND ')}
      ORDER BY mem.importance DESC, mem.last_confirmed_at_ms DESC
      LIMIT ?`,
  ).all(...params) as Record<string, SQLOutputValue>[];

  const scopes = recomputeMemoryScopes(db, rows.map((row) => String(row.id)));
  const scored = rows.flatMap((row) => {
    const scope = scopes.get(String(row.id));
    if (!scope || !scopePermitted(db, grant, scope)) return [];
    const importance = Number(row.importance);
    const ageDays = Math.max(0, (input.now - Number(row.last_confirmed_at_ms)) / 86_400_000);
    const recency = Math.exp(-ageDays / RECENCY_DECAY_DAYS);
    const density = Math.min(1, Number(row.evidence_count) / 5);
    return [{ row, scope, score: importance * 0.45 + recency * 0.35 + density * 0.2 }];
  });
  scored.sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)));

  const items = scored.slice(0, limit).map(({ row, scope, score }) => ({
    memoryId: String(row.id),
    type: String(row.type) as MemoryType,
    statement: String(row.statement),
    status: String(row.status) as MemoryStatus,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    lastConfirmedAtMs: Number(row.last_confirmed_at_ms),
    evidenceCount: Number(row.evidence_count),
    rank: -score,
  }));
  const totalMatching = Number(count.n);
  return {
    items,
    totalMatching,
    returned: items.length,
    hasMore: totalMatching > items.length,
  };
}

/**
 * Stable, cursor-paginated memory archive for the inspector. Unlike the
 * agent/MCP inventory, this view deliberately uses persisted indexed columns
 * instead of a time-dependent relevance score. Visibility is still filtered
 * in SQL and independently recomputed before return.
 */
export function listMemoryArchivePage(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: ListMemoriesInput & {
    cursor?: MemoryArchiveCursor | null;
    sort?: MemoryArchiveSort;
  },
): MemoryArchivePage {
  const limit = Math.min(MAX_MEMORY_LIMIT, Math.max(1, input.limit ?? DEFAULT_MEMORY_PAGE_LIMIT));
  const sort = input.sort ?? 'importance';
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (input.types && input.types.length > 0) {
    where.push(`mem.type IN (${input.types.map(() => '?').join(',')})`);
    params.push(...input.types);
  }
  const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : ['active'];
  where.push(`mem.status IN (${statuses.map(() => '?').join(',')})`);
  params.push(...statuses);
  const scope = effectiveScopeGrantPredicate(grant);
  where.push(scope.sql);
  params.push(...scope.params);
  const countWhere = [...where];
  const baseParams = [...params];
  if (input.cursor) {
    if (sort === 'recent') {
      where.push(`(
        mem.last_confirmed_at_ms < ?
        OR (mem.last_confirmed_at_ms = ? AND mem.id < ?)
      )`);
      params.push(input.cursor.lastConfirmedAtMs, input.cursor.lastConfirmedAtMs, input.cursor.id);
    } else {
      where.push(`(
        mem.importance < ?
        OR (mem.importance = ? AND mem.last_confirmed_at_ms < ?)
        OR (mem.importance = ? AND mem.last_confirmed_at_ms = ? AND mem.id < ?)
      )`);
      params.push(
        input.cursor.importance ?? 0,
        input.cursor.importance ?? 0,
        input.cursor.lastConfirmedAtMs,
        input.cursor.importance ?? 0,
        input.cursor.lastConfirmedAtMs,
        input.cursor.id,
      );
    }
  }
  const cacheShape = `${input.types?.length ?? 0}:${statuses.length}:${grant.includeOrgMemories ? 1 : 0}:${grant.includeReviewOnly ? 1 : 0}:${grant.channelIds.length}`;
  const count = prepareCached(
    db,
    `memory.archive_count:${cacheShape}`,
    `WITH ${EFFECTIVE_MEMORY_SCOPES_CTE}
     SELECT COUNT(*) AS n
       FROM memories mem
       JOIN effective eff ON eff.id = mem.id
      WHERE ${countWhere.join(' AND ')}`,
  ).get(...baseParams) as { n: number };
  params.push(limit + 1);
  const archiveIndex = sort === 'recent'
    ? 'memories_inspector_recent_idx'
    : 'memories_inspector_archive_idx';
  const archiveOrder = sort === 'recent'
    ? 'mem.last_confirmed_at_ms DESC, mem.id DESC'
    : 'mem.importance DESC, mem.last_confirmed_at_ms DESC, mem.id DESC';
  const rows = prepareCached(
    db,
    `memory.archive:${sort}:${cacheShape}:${input.cursor ? 1 : 0}`,
    `WITH ${EFFECTIVE_MEMORY_SCOPES_CTE}
     SELECT mem.id, mem.type, mem.statement, mem.status, mem.confidence, mem.importance,
            mem.last_confirmed_at_ms,
            (SELECT COUNT(*) FROM memory_evidence me WHERE me.memory_id=mem.id) AS evidence_count
       FROM memories mem INDEXED BY ${archiveIndex}
       CROSS JOIN effective eff ON eff.id = mem.id
      WHERE ${where.join(' AND ')}
      ORDER BY ${archiveOrder}
      LIMIT ?`,
  ).all(...params) as Record<string, SQLOutputValue>[];
  const scopes = recomputeMemoryScopes(db, rows.map((row) => String(row.id)));
  const visible = rows.flatMap((row) => {
    const effective = scopes.get(String(row.id));
    if (!effective || !scopePermitted(db, grant, effective)) return [];
    return [{ row, effective }];
  });
  const pageRows = visible.slice(0, limit);
  const items = pageRows.map(({ row, effective }) => ({
    memoryId: String(row.id),
    type: String(row.type) as MemoryType,
    statement: String(row.statement),
    status: String(row.status) as MemoryStatus,
    scopeType: effective.scopeType,
    scopeKey: effective.scopeKey,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    lastConfirmedAtMs: Number(row.last_confirmed_at_ms),
    evidenceCount: Number(row.evidence_count),
    rank: -Number(row.importance),
  }));
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    totalMatching: Number(count.n),
    next: visible.length > limit && last
      ? {
          ...(sort === 'importance' ? { importance: Number(last.row.importance) } : {}),
          lastConfirmedAtMs: Number(last.row.last_confirmed_at_ms),
          id: String(last.row.id),
        }
      : null,
  };
}

/** Backward-compatible item-only inventory surface for repository callers. */
export function listMemories(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: ListMemoriesInput,
): MemorySearchResult[] {
  return listMemoriesPage(db, grant, input).items;
}

export interface MemoryDetails {
  memoryId: string;
  type: MemoryType;
  statement: string;
  status: MemoryStatus;
  scopeType: string;
  scopeKey: string | null;
  confidence: number;
  importance: number;
  ownerUserId: string | null;
  reviewAfterMs: number | null;
}

/** One memory with status/confidence/importance, only if its scope is permitted. */
export function getMemoryDetails(
  db: DatabaseSync,
  grant: RetrievalGrant,
  memoryId: string,
): MemoryDetails | undefined {
  const row = prepareCached(db, 'memory.details', 'SELECT * FROM memories WHERE id = ?').get(
    memoryId,
  ) as Record<string, SQLOutputValue> | undefined;
  if (!row) return undefined;
  const scope = recomputeMemoryScopes(db, [memoryId]).get(memoryId)!;
  if (!scopePermitted(db, grant, scope)) return undefined;
  return {
    memoryId: String(row.id),
    type: String(row.type) as MemoryType,
    statement: String(row.statement),
    status: String(row.status) as MemoryStatus,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    ownerUserId: row.owner_user_id === null ? null : String(row.owner_user_id),
    reviewAfterMs: row.review_after_ms === null ? null : Number(row.review_after_ms),
  };
}

export interface MemoryEvidenceResult {
  stance: string;
  weight: number;
  note: string | null;
  messageId: string;
  channelId: string;
  authorId: string | null;
  authorDisplayName: string;
  content: string;
  createdAtMs: number;
  /** Host-generated canonical jump link to the permitted source message. */
  link: string;
}

export interface MemoryEvidenceCursor {
  createdAtMs: number;
  messageId: string;
  stance: string;
}

export interface MemoryEvidencePage {
  items: MemoryEvidenceResult[];
  next: MemoryEvidenceCursor | null;
  totalMatching: number;
}

/** Permitted evidence messages behind a memory (Section 22.4). */
export function getMemoryEvidence(
  db: DatabaseSync,
  grant: RetrievalGrant,
  memoryId: string,
  limit = DEFAULT_MEMORY_PAGE_LIMIT,
): MemoryEvidenceResult[] {
  return getMemoryEvidencePage(db, grant, memoryId, { limit }).items;
}

/** Permitted evidence with a stable chronological cursor for inspector audit. */
export function getMemoryEvidencePage(
  db: DatabaseSync,
  grant: RetrievalGrant,
  memoryId: string,
  options: { limit?: number; cursor?: MemoryEvidenceCursor | null } = {},
): MemoryEvidencePage {
  const scope = recomputeMemoryScopes(db, [memoryId]).get(memoryId);
  if (!scope || !scopePermitted(db, grant, scope)) return { items: [], next: null, totalMatching: 0 };
  const pred = channelVisibilityPredicate(grant);
  const cap = Math.min(MAX_MEMORY_LIMIT, Math.max(1, options.limit ?? DEFAULT_MEMORY_PAGE_LIMIT));
  const where = ['me.memory_id = ?', 'm.deleted_at_ms IS NULL', pred.sql];
  const params: SQLInputValue[] = [memoryId, ...pred.params];
  if (options.cursor) {
    where.push(`(
      me.created_at_ms > ?
      OR (me.created_at_ms = ? AND me.message_id > ?)
      OR (me.created_at_ms = ? AND me.message_id = ? AND me.stance > ?)
    )`);
    params.push(
      options.cursor.createdAtMs,
      options.cursor.createdAtMs,
      options.cursor.messageId,
      options.cursor.createdAtMs,
      options.cursor.messageId,
      options.cursor.stance,
    );
  }
  const total = prepareCached(
    db,
    `memory.evidence_count:${pred.sql}`,
    `SELECT COUNT(*) AS n
       FROM memory_evidence me
       JOIN messages m ON m.id = me.message_id
       JOIN channels c ON c.id = m.channel_id
      WHERE me.memory_id = ? AND m.deleted_at_ms IS NULL AND ${pred.sql}`,
  ).get(memoryId, ...pred.params) as { n: number };
  params.push(cap + 1);
  const rows = prepareCached(
    db,
    `memory.evidence_page:${pred.sql}:${options.cursor ? 1 : 0}`,
    `SELECT me.stance, me.weight, me.note, m.id AS message_id, m.workspace_id, m.channel_id,
            m.author_id, m.author_display_name, m.content, m.created_at_ms,
            me.created_at_ms AS evidence_created_at_ms
       FROM memory_evidence me INDEXED BY memory_evidence_inspector_archive_idx
       CROSS JOIN messages m ON m.id = me.message_id
       CROSS JOIN channels c ON c.id = m.channel_id
      WHERE ${where.join(' AND ')}
      ORDER BY me.created_at_ms ASC, me.message_id ASC, me.stance ASC
      LIMIT ?`,
  ).all(...params) as Record<string, SQLOutputValue>[];
  const pageRows = rows.slice(0, cap);
  const items = pageRows.map((r) => ({
    stance: String(r.stance),
    weight: Number(r.weight),
    note: r.note === null ? null : String(r.note),
    messageId: String(r.message_id),
    channelId: String(r.channel_id),
    authorId: r.author_id === null ? null : String(r.author_id),
    authorDisplayName: String(r.author_display_name),
    content: String(r.content),
    createdAtMs: Number(r.created_at_ms),
    link: messageLink(String(r.workspace_id), String(r.channel_id), String(r.message_id)),
  }));
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    totalMatching: Number(total.n),
    next: rows.length > cap && last
      ? {
          createdAtMs: Number(last.evidence_created_at_ms),
          messageId: String(last.message_id),
          stance: String(last.stance),
        }
      : null,
  };
}
