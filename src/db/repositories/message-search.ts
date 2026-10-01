import { type DatabaseSync } from '../database.js';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { prepareCached } from './util.js';
import {
  parseFtsQuery,
  sanitizeFtsQuery,
  MAX_QUERY_LENGTH,
  MAX_RESULT_LIMIT,
  DEFAULT_LIMIT,
} from '../fts-query.js';

/**
 * Scope-bound message retrieval (Sections 7.3, 22.1, 30, 32.5.2).
 *
 * The host computes the maximum retrieval scope for a run or MCP token and hands
 * it here as a {@link RetrievalGrant}; the repository never trusts model- or
 * caller-supplied scope. Visibility is enforced IN SQL (Section 30.2) — deleted,
 * excluded, and out-of-scope restricted rows are filtered before any row reaches
 * the application, so there is no second code path that could leak them.
 */

export interface RetrievalGrant {
  /** When true, messages in `org`-visibility channels are readable. */
  includeOrgMessages: boolean;
  /** When true, `org`-scoped durable memories are readable. */
  includeOrgMemories: boolean;
  /** When true, `review_only` channels are readable (secure review only). */
  includeReviewOnly: boolean;
  /** Explicit restricted channel ids whose own messages and threads are readable. */
  channelIds: readonly string[];
}

export { sanitizeFtsQuery, MAX_QUERY_LENGTH, MAX_RESULT_LIMIT, DEFAULT_LIMIT };
export const MAX_MESSAGE_FILTER_IDS = 50;

function boundedFilterIds(ids: readonly string[] | undefined): readonly string[] {
  return ids?.slice(0, MAX_MESSAGE_FILTER_IDS) ?? [];
}

export interface SearchMessagesInput {
  query: string;
  /** Optional subset; intersected with the grant — can never broaden scope. */
  channelIds?: readonly string[];
  authorIds?: readonly string[];
  afterMs?: number;
  beforeMs?: number;
  limit?: number;
  /** Observation time for recency ranking; defaults to Date.now(). */
  now?: number;
}

export interface ListRecentMessagesInput {
  /** Optional subset; intersected with the grant — can never broaden scope. */
  channelIds?: readonly string[];
  authorIds?: readonly string[];
  /** Inclusive lower bound. */
  afterMs?: number;
  /** Exclusive upper bound, suitable for newest-first pagination. */
  beforeMs?: number;
  /** Exclusive newest-first cursor; resolved only when permitted by the grant. */
  beforeMessageId?: string;
  limit?: number;
}

export interface MessageSearchResult {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string | null;
  authorDisplayName: string;
  createdAtMs: number;
  content: string;
  snippet: string;
  reactionTotal: number;
  /** Host-computed combined rank; higher is better (Section 30.1). */
  rank: number;
  discordLink: string;
}

export interface RecentMessageResult {
  messageId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  authorId: string | null;
  authorDisplayName: string;
  createdAtMs: number;
  content: string;
  reactionTotal: number;
  discordLink: string;
}

/** Canonical Discord message jump link (Section 30.3). Host-generated, never trusted. */
export function discordMessageLink(
  guildId: string,
  channelId: string,
  messageId: string,
): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/**
 * The channel-visibility predicate for a grant, as a bare SQL expression
 * referencing channel alias `c` (no leading `AND`). Returns `1=0` when the
 * grant permits nothing — fail closed. Restricted evidence from a granted
 * channel also covers that channel's threads (matched via `parent_id`).
 *
 * Shared by message search, message context, and memory-evidence validation so
 * there is one authoritative scope predicate (Section 7.3, 32.5.2).
 */
export function channelVisibilityPredicate(grant: RetrievalGrant): {
  sql: string;
  params: SQLInputValue[];
} {
  const conds: string[] = [];
  const params: SQLInputValue[] = [];
  const outsideMnemeTestSurface = `
    INSTR(LOWER(COALESCE(c.name, '')), 'mneme') = 0
    AND (c.is_thread = 0 OR NOT EXISTS (
      SELECT 1 FROM channels test_parent
       WHERE test_parent.id = c.parent_id
         AND INSTR(LOWER(COALESCE(test_parent.name, '')), 'mneme') > 0
    ))`;
  const current = `c.ingest_enabled = 1 AND c.deleted_at_ms IS NULL
    AND ${outsideMnemeTestSurface}`;
  const liveThreadParent = `(SELECT parent.id
      FROM channels parent
     WHERE parent.id = c.parent_id
       AND parent.ingest_enabled = 1
       AND parent.deleted_at_ms IS NULL)`;
  // The thread row stores its fully resolved policy, including an explicit
  // override. Its parent is required to remain live, but does not replace that
  // resolved visibility; it is only the restricted-scope anchor below.
  const effectiveVisibility = `(CASE
    WHEN c.is_thread = 1 AND ${liveThreadParent} IS NULL THEN NULL
    ELSE c.visibility_class
  END)`;
  const scopeAnchor = '(CASE WHEN c.is_thread = 1 THEN c.parent_id ELSE c.id END)';
  if (grant.includeOrgMessages) conds.push(`(${current} AND ${effectiveVisibility} = 'org')`);
  if (grant.includeReviewOnly) {
    conds.push(`(${current} AND ${effectiveVisibility} = 'review_only')`);
  }
  const grantedChannelIds = boundedFilterIds(grant.channelIds);
  if (grantedChannelIds.length > 0) {
    const ph = grantedChannelIds.map(() => '?').join(',');
    conds.push(
      `(${current} AND ${effectiveVisibility} = 'restricted' AND ${scopeAnchor} IN (${ph}))`,
    );
    params.push(...grantedChannelIds);
  }
  if (conds.length === 0) return { sql: '1=0', params };
  return { sql: `(${conds.join(' OR ')})`, params };
}

/** Internal wrapper preserving the EXISTS(...) shape used by message search. */
function scopePredicate(grant: RetrievalGrant): { sql: string; params: SQLInputValue[] } {
  const pred = channelVisibilityPredicate(grant);
  if (pred.sql === '1=0') return pred;
  return {
    sql: `EXISTS (SELECT 1 FROM channels c WHERE c.id = m.channel_id AND ${pred.sql})`,
    params: pred.params,
  };
}

// Section 30.1 ranking weights.
const RANK_LEXICAL = 0.4;
const RANK_PHRASE = 0.2;
const RANK_RECENCY = 0.2;
const RANK_REACTION = 0.2;
const RECENCY_DECAY_DAYS = 30;
const REACTION_SCALE = 10;
const CANDIDATE_CAP = 100;

interface Candidate {
  row: Record<string, SQLOutputValue>;
  bm25: number;
}

/**
 * Combine the Section 30.1 signals into a single host rank. Lexical strength
 * (normalized BM25), an exact-phrase bonus, recency, and reaction weight are
 * blended; channel/reply proximity and author are applied upstream as filters.
 */
function combinedRank(
  candidates: Candidate[],
  phrase: string,
  now: number,
): { row: Record<string, SQLOutputValue>; rank: number }[] {
  if (candidates.length === 0) return [];
  const bm25s = candidates.map((c) => c.bm25);
  const minBm = Math.min(...bm25s);
  const maxBm = Math.max(...bm25s);
  const range = maxBm - minBm;
  const phraseLower = phrase.toLowerCase();

  return candidates
    .map(({ row, bm25 }) => {
      // BM25 is lower-is-better; invert and normalize to [0, 1].
      const lexical = range > 0 ? (maxBm - bm25) / range : 1;
      const content = String(row.content).toLowerCase();
      const phraseBonus = phraseLower && content.includes(phraseLower) ? 1 : 0;
      const ageDays = Math.max(0, (now - Number(row.created_at_ms)) / 86_400_000);
      const recency = Math.exp(-ageDays / RECENCY_DECAY_DAYS);
      const reactionScore = Math.min(1, Number(row.reaction_total) / REACTION_SCALE);
      const rank =
        RANK_LEXICAL * lexical +
        RANK_PHRASE * phraseBonus +
        RANK_RECENCY * recency +
        RANK_REACTION * reactionScore;
      return { row, rank };
    })
    .sort((a, b) => b.rank - a.rank);
}

/**
 * FTS search over messages permitted by `grant` (Sections 22.1, 30). The grant
 * is the ceiling; any caller-supplied `channelIds` only narrow it. Deleted and
 * out-of-scope rows are excluded in SQL. Candidates are pulled by BM25, then
 * re-ranked by the combined Section 30.1 host score; results are capped at
 * {@link MAX_RESULT_LIMIT}.
 */
export function searchMessages(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: SearchMessagesInput,
): MessageSearchResult[] {
  const parsed = parseFtsQuery(input.query);
  if (parsed.match === '') return [];

  const limit = Math.min(MAX_RESULT_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const now = input.now ?? Date.now();
  const scope = scopePredicate(grant);
  const channelIds = boundedFilterIds(input.channelIds);
  const authorIds = boundedFilterIds(input.authorIds);

  const where: string[] = ['messages_fts MATCH ?', 'm.deleted_at_ms IS NULL', scope.sql];
  const params: SQLInputValue[] = [parsed.match, ...scope.params];

  if (channelIds.length > 0) {
    const ph = channelIds.map(() => '?').join(',');
    where.push(`m.channel_id IN (${ph})`);
    params.push(...channelIds);
  }
  if (authorIds.length > 0) {
    const ph = authorIds.map(() => '?').join(',');
    where.push(`m.author_id IN (${ph})`);
    params.push(...authorIds);
  }
  if (input.afterMs !== undefined) {
    where.push('m.created_at_ms >= ?');
    params.push(input.afterMs);
  }
  if (input.beforeMs !== undefined) {
    where.push('m.created_at_ms <= ?');
    params.push(input.beforeMs);
  }
  params.push(CANDIDATE_CAP);

  const cacheKey = [
    'messages.search',
    scope.sql,
    channelIds.length,
    authorIds.length,
    input.afterMs !== undefined ? 1 : 0,
    input.beforeMs !== undefined ? 1 : 0,
  ].join(':');

  const sql = `
    SELECT m.id AS message_id, m.guild_id, m.channel_id, m.author_id,
           m.author_display_name, m.created_at_ms, m.content,
           snippet(messages_fts, 0, '«', '»', ' … ', 24) AS snippet,
           (SELECT COALESCE(SUM(count), 0) FROM reaction_counts rc
             WHERE rc.message_id = m.id) AS reaction_total,
           bm25(messages_fts) AS bm25
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
     WHERE ${where.join(' AND ')}
     ORDER BY bm25 ASC
     LIMIT ?
  `;

  const rows = prepareCached(db, cacheKey, sql).all(...params) as Record<
    string,
    SQLOutputValue
  >[];
  const candidates: Candidate[] = rows.map((row) => ({ row, bm25: Number(row.bm25) }));
  const ranked = combinedRank(candidates, parsed.phrase, now).slice(0, limit);

  return ranked.map(({ row, rank }) => {
    const messageId = String(row.message_id);
    const guildId = String(row.guild_id);
    const channelId = String(row.channel_id);
    return {
      messageId,
      guildId,
      channelId,
      authorId: row.author_id === null ? null : String(row.author_id),
      authorDisplayName: String(row.author_display_name),
      createdAtMs: Number(row.created_at_ms),
      content: String(row.content),
      snippet: String(row.snippet),
      reactionTotal: Number(row.reaction_total),
      rank,
      discordLink: discordMessageLink(guildId, channelId, messageId),
    };
  });
}

/**
 * Newest-first browse over permitted messages, without an FTS query.
 *
 * This is the deterministic operation used for time-window questions such as
 * "what happened in the last two days?". Natural-language interpretation stays
 * with the calling agent; this repository only applies explicit filters and the
 * host-injected visibility grant. Scope is filtered in SQL before LIMIT.
 */
export function listRecentMessages(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: ListRecentMessagesInput,
): RecentMessageResult[] {
  const limit = Math.min(MAX_RESULT_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const scope = channelVisibilityPredicate(grant);
  const channelIds = boundedFilterIds(input.channelIds);
  const authorIds = boundedFilterIds(input.authorIds);
  const where: string[] = ['m.deleted_at_ms IS NULL', scope.sql];
  const params: SQLInputValue[] = [...scope.params];

  if (channelIds.length > 0) {
    const ph = channelIds.map(() => '?').join(',');
    where.push(`m.channel_id IN (${ph})`);
    params.push(...channelIds);
  }
  if (authorIds.length > 0) {
    const ph = authorIds.map(() => '?').join(',');
    where.push(`m.author_id IN (${ph})`);
    params.push(...authorIds);
  }
  if (input.afterMs !== undefined) {
    where.push('m.created_at_ms >= ?');
    params.push(input.afterMs);
  }
  if (input.beforeMs !== undefined) {
    where.push('m.created_at_ms < ?');
    params.push(input.beforeMs);
  }
  if (input.beforeMessageId !== undefined) {
    const cursorScope = scopePredicate(grant);
    const cursor = prepareCached(db, `messages.recent.cursor:${cursorScope.sql}`, `
      SELECT m.id, m.created_at_ms
        FROM messages m
       WHERE m.id = ?
         AND m.deleted_at_ms IS NULL
         AND ${cursorScope.sql}
    `).get(input.beforeMessageId, ...cursorScope.params) as
      | { id: SQLOutputValue; created_at_ms: SQLOutputValue }
      | undefined;
    if (!cursor) return [];
    where.push('(m.created_at_ms < ? OR (m.created_at_ms = ? AND m.id < ?))');
    params.push(Number(cursor.created_at_ms), Number(cursor.created_at_ms), String(cursor.id));
  }
  params.push(limit);

  const cacheKey = [
    'messages.recent',
    scope.sql,
    channelIds.length,
    authorIds.length,
    input.afterMs !== undefined ? 1 : 0,
    input.beforeMs !== undefined ? 1 : 0,
    input.beforeMessageId !== undefined ? 1 : 0,
  ].join(':');

  const rows = prepareCached(db, cacheKey, `
    SELECT m.id AS message_id, m.guild_id, m.channel_id, c.name AS channel_name,
           m.author_id, m.author_display_name, m.created_at_ms, m.content,
           (SELECT COALESCE(SUM(count), 0) FROM reaction_counts rc
             WHERE rc.message_id = m.id) AS reaction_total
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.created_at_ms DESC, m.id DESC
     LIMIT ?
  `).all(...params) as Record<string, SQLOutputValue>[];

  return rows.map((row) => {
    const messageId = String(row.message_id);
    const guildId = String(row.guild_id);
    const channelId = String(row.channel_id);
    return {
      messageId,
      guildId,
      channelId,
      channelName: row.channel_name === null ? channelId : String(row.channel_name),
      authorId: row.author_id === null ? null : String(row.author_id),
      authorDisplayName: String(row.author_display_name),
      createdAtMs: Number(row.created_at_ms),
      content: String(row.content),
      reactionTotal: Number(row.reaction_total),
      discordLink: discordMessageLink(guildId, channelId, messageId),
    };
  });
}
