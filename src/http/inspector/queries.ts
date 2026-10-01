/**
 * Grant-aware, bounded queries for the inspector pages (Section 32.6).
 *
 * Memory reads go through the same retrieval layer as the agent and MCP —
 * `listMemoriesPage`, `searchMemories`, `getMemoryDetails`, `getMemoryEvidence`
 * — so effective-scope recomputation and `scopePermitted` apply on every read.
 * Episode and message listings compose the shared `channelVisibilityPredicate`
 * in SQL: the same predicate the grant-aware repositories apply, never a
 * re-implementation.
 *
 * System tables (runs, jobs, outbox, admin events, channel policy rows) carry
 * no message-channel content of their own and are read with bounded, indexed
 * SELECTs. Raw Discord payload columns (`raw_json`, `embeds_json`,
 * `components_json`, `poll_json`) are never selected. Token hashes are never
 * selected. Proposal and outbox text is permitted content for this credential
 * (Section 32.6 content matrix).
 */

import { type DatabaseSync } from '../../db/database.js';
import { prepareCached } from '../../db/repositories/util.js';
import type { TerminalProposalView } from './policy-view.js';
import { parsePolicyDecision, parseTerminalProposal } from './policy-view.js';
import { fingerprintExposedMemory, fingerprintExposedMessage } from '../../agent/run-context.js';
import type { SQLInputValue } from 'node:sqlite';
import type { RetrievalGrant } from '../../db/repositories/message-search.js';
import { channelVisibilityPredicate } from '../../db/repositories/message-search.js';
import { isMnemeTestChannelName } from '../../discord/test-channels.js';
import {
  listMemoriesPage,
  listMemoryArchivePage,
  searchMemories,
  getMemoryDetails,
  getMemoryEvidencePage,
  type MemoryArchivePage,
  type MemoryArchiveCursor,
  type MemoryArchiveSort,
  type MemorySearchResult,
  type MemoryDetails,
  type MemoryEvidenceResult,
  type MemoryEvidenceCursor,
  type ListMemoriesInput,
} from '../../memory/search.js';

/** One page of rows everywhere: the repository cap for memories and evidence. */
export const INSPECTOR_PAGE_SIZE = 20;
/** Runs, episodes, jobs, audit, proposals, and outbox rows per page. */
const PAGE_SIZE = INSPECTOR_PAGE_SIZE;

function n(v: unknown): number | null {
  const x = Number(v);
  return v === null || v === undefined || !Number.isFinite(x) ? null : x;
}

function s(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Escape a user-supplied LIKE pattern (Section 32.6 "wildcards escaped"). */
export function escapeLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const LIKE_ESCAPE_CLAUSE = " LIKE ? ESCAPE '\\'";

// ---- Overview ---------------------------------------------------------------

export interface InspectorOverview {
  memoryTotal: number;
  memoryActive: number;
  episodeCounts: Record<string, number>;
  runCounts: Record<string, number>;
  runsToday: number;
  spendTodayUsd: number | null;
  spendTotalUsd: number | null;
  inputTokensTotal: number | null;
  outputTokensTotal: number | null;
  detailedRunCount: number;
  totalRunCount: number;
  detailedUncachedInputTokens: number | null;
  detailedCacheReadTokens: number | null;
  detailedCacheWriteTokens: number | null;
  detailedOutputTokens: number | null;
  detailedReasoningTokens: number | null;
  cacheReadRatio: number | null;
  episodeShadowRuns: number;
  episodeShadowCompared: number;
  episodeShadowCategoryMatches: number;
  episodeShadowCostUsd: number | null;
  episodeShadowCohorts: EpisodeShadowCohort[];
  proposalCounts: Record<string, number>;
  outboxCounts: Record<string, number>;
  jobCounts: Record<string, number>;
  channelCounts: Record<string, number>;
  messageCount: number;
  guildId: string | null;
}

export interface EpisodeShadowCohort {
  model: string;
  thinkingLevel: string;
  runs: number;
  compared: number;
  categoryMatches: number;
  importantBaselines: number;
  importantCaught: number;
  silentBaselines: number;
  silentKept: number;
  authoritativeMemories: number;
  candidateMemories: number;
  costUsd: number | null;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  meanReasoningTokens: number | null;
  meanExecutionMs: number | null;
}

function countBy(db: DatabaseSync, key: string, sql: string, ...params: SQLInputValue[]): Record<string, number> {
  const rows = prepareCached(db, key, sql).all(...params) as Array<Record<string, unknown>>;
  const out: Record<string, number> = {};
  for (const row of rows) out[s(row.k)] = n(row.n) ?? 0;
  return out;
}

/**
 * The overview counters. Memory counts honor the grant through
 * {@link listMemoriesPage}'s exact count; the rest are system-level counts.
 */
export function overviewSnapshot(
  db: DatabaseSync,
  grant: RetrievalGrant,
  now: number,
  dayStartMs: number,
): InspectorOverview {
  const activeMemories = listMemoriesPage(db, grant, { statuses: ['active'], limit: 1, now } as ListMemoriesInput);
  const allMemories = listMemoriesPage(db, grant, {
    statuses: ['active', 'superseded', 'resolved', 'invalidated', 'expired'],
    limit: 1,
    now,
  } as ListMemoriesInput);
  const spend = prepareCached(
    db,
    'inspector.overview.spend',
    `SELECT SUM(CASE WHEN started_at_ms >= ? THEN 1 ELSE 0 END) AS runs_today,
            SUM(CASE WHEN started_at_ms >= ? THEN cost_usd ELSE 0 END) AS spend_today,
            SUM(cost_usd) AS spend_total,
            SUM(input_tokens) AS in_total,
            SUM(output_tokens) AS out_total,
            COUNT(*) AS total_runs,
            SUM(CASE WHEN uncached_input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS detailed_runs,
            SUM(CASE WHEN uncached_input_tokens IS NOT NULL THEN uncached_input_tokens ELSE 0 END) AS detailed_uncached,
            SUM(CASE WHEN uncached_input_tokens IS NOT NULL THEN cache_read_tokens ELSE 0 END) AS detailed_cache_read,
            SUM(CASE WHEN uncached_input_tokens IS NOT NULL THEN cache_write_tokens ELSE 0 END) AS detailed_cache_write,
            SUM(CASE WHEN uncached_input_tokens IS NOT NULL THEN output_tokens ELSE 0 END) AS detailed_output,
            SUM(CASE WHEN uncached_input_tokens IS NOT NULL THEN reasoning_tokens ELSE NULL END) AS detailed_reasoning,
            SUM(CASE WHEN shadow_of_run_id IS NOT NULL THEN 1 ELSE 0 END) AS shadow_runs,
            SUM(CASE WHEN shadow_comparison_json IS NOT NULL THEN 1 ELSE 0 END) AS shadow_compared,
            SUM(CASE WHEN json_extract(shadow_comparison_json,'$.categoryMatch') = 1 THEN 1 ELSE 0 END) AS shadow_matches,
            SUM(CASE WHEN shadow_of_run_id IS NOT NULL THEN cost_usd ELSE 0 END) AS shadow_cost
       FROM agent_runs`,
  ).get(dayStartMs, dayStartMs) as Record<string, unknown>;
  const detailedInput = (n(spend.detailed_uncached) ?? 0)
    + (n(spend.detailed_cache_read) ?? 0)
    + (n(spend.detailed_cache_write) ?? 0);
  const shadowCohorts = prepareCached(
    db,
    'inspector.overview.shadow-cohorts',
    `SELECT model,COALESCE(thinking_level,'unknown') AS thinking_level,
            COUNT(*) AS runs,
            SUM(CASE WHEN shadow_comparison_json IS NOT NULL THEN 1 ELSE 0 END) AS compared,
            SUM(CASE WHEN json_extract(shadow_comparison_json,'$.categoryMatch')=1 THEN 1 ELSE 0 END) AS matches,
            SUM(CASE WHEN json_extract(shadow_comparison_json,'$.authoritative.category')='important' THEN 1 ELSE 0 END) AS important_baselines,
            SUM(CASE WHEN json_extract(shadow_comparison_json,'$.authoritative.category')='important'
                      AND json_extract(shadow_comparison_json,'$.shadow.category')='important' THEN 1 ELSE 0 END) AS important_caught,
            SUM(CASE WHEN json_extract(shadow_comparison_json,'$.authoritative.category')='silent' THEN 1 ELSE 0 END) AS silent_baselines,
            SUM(CASE WHEN json_extract(shadow_comparison_json,'$.authoritative.category')='silent'
                      AND json_extract(shadow_comparison_json,'$.shadow.category')='silent' THEN 1 ELSE 0 END) AS silent_kept,
            SUM(COALESCE(json_extract(shadow_comparison_json,'$.authoritative.memoryCount'),0)) AS authoritative_memories,
            SUM(COALESCE(json_extract(shadow_comparison_json,'$.shadow.memoryCount'),0)) AS candidate_memories,
            SUM(cost_usd) AS cost,
            AVG(input_tokens) AS mean_input,
            AVG(output_tokens) AS mean_output,
            AVG(reasoning_tokens) AS mean_reasoning,
            AVG(CASE WHEN execution_started_at_ms IS NOT NULL AND ended_at_ms IS NOT NULL
                     THEN ended_at_ms-execution_started_at_ms ELSE NULL END) AS mean_execution_ms
       FROM agent_runs
      WHERE shadow_of_run_id IS NOT NULL
      GROUP BY model,COALESCE(thinking_level,'unknown')
      ORDER BY MAX(started_at_ms) DESC`,
  ).all() as Array<Record<string, unknown>>;
  return {
    memoryTotal: allMemories.totalMatching,
    memoryActive: activeMemories.totalMatching,
    episodeCounts: countBy(
      db,
      'inspector.overview.episodes',
      'SELECT status AS k, COUNT(*) AS n FROM episodes GROUP BY status',
    ),
    runCounts: countBy(
      db,
      'inspector.overview.runs',
      'SELECT status AS k, COUNT(*) AS n FROM agent_runs GROUP BY status',
    ),
    runsToday: n(spend.runs_today) ?? 0,
    spendTodayUsd: n(spend.spend_today),
    spendTotalUsd: n(spend.spend_total),
    inputTokensTotal: n(spend.in_total),
    outputTokensTotal: n(spend.out_total),
    detailedRunCount: n(spend.detailed_runs) ?? 0,
    totalRunCount: n(spend.total_runs) ?? 0,
    detailedUncachedInputTokens: n(spend.detailed_uncached),
    detailedCacheReadTokens: n(spend.detailed_cache_read),
    detailedCacheWriteTokens: n(spend.detailed_cache_write),
    detailedOutputTokens: n(spend.detailed_output),
    detailedReasoningTokens: n(spend.detailed_reasoning),
    cacheReadRatio: detailedInput > 0 ? (n(spend.detailed_cache_read) ?? 0) / detailedInput : null,
    episodeShadowRuns: n(spend.shadow_runs) ?? 0,
    episodeShadowCompared: n(spend.shadow_compared) ?? 0,
    episodeShadowCategoryMatches: n(spend.shadow_matches) ?? 0,
    episodeShadowCostUsd: n(spend.shadow_cost),
    episodeShadowCohorts: shadowCohorts.map((row) => ({
      model: s(row.model),
      thinkingLevel: s(row.thinking_level),
      runs: n(row.runs) ?? 0,
      compared: n(row.compared) ?? 0,
      categoryMatches: n(row.matches) ?? 0,
      importantBaselines: n(row.important_baselines) ?? 0,
      importantCaught: n(row.important_caught) ?? 0,
      silentBaselines: n(row.silent_baselines) ?? 0,
      silentKept: n(row.silent_kept) ?? 0,
      authoritativeMemories: n(row.authoritative_memories) ?? 0,
      candidateMemories: n(row.candidate_memories) ?? 0,
      costUsd: n(row.cost),
      meanInputTokens: n(row.mean_input),
      meanOutputTokens: n(row.mean_output),
      meanReasoningTokens: n(row.mean_reasoning),
      meanExecutionMs: n(row.mean_execution_ms),
    })),
    proposalCounts: countBy(
      db,
      'inspector.overview.proposals',
      'SELECT status AS k, COUNT(*) AS n FROM proposals GROUP BY status',
    ),
    outboxCounts: countBy(
      db,
      'inspector.overview.outbox',
      'SELECT status AS k, COUNT(*) AS n FROM outbox GROUP BY status',
    ),
    jobCounts: countBy(
      db,
      'inspector.overview.jobs',
      'SELECT status AS k, COUNT(*) AS n FROM jobs GROUP BY status',
    ),
    channelCounts: countBy(
      db,
      'inspector.overview.channels',
      'SELECT visibility_class AS k, COUNT(*) AS n FROM channels WHERE deleted_at_ms IS NULL GROUP BY visibility_class',
    ),
    messageCount: n(
      (prepareCached(db, 'inspector.overview.messages', 'SELECT COUNT(*) AS n FROM messages WHERE deleted_at_ms IS NULL')
        .get() as Record<string, unknown> | undefined)?.n,
    ) ?? 0,
    guildId: s(
      (prepareCached(db, 'inspector.overview.guild', 'SELECT id AS g FROM guilds ORDER BY discovered_at_ms LIMIT 1')
        .get() as Record<string, unknown> | undefined)?.g,
    ) || null,
  };
}

export interface OverviewProposalRow {
  id: string;
  status: string;
  targetChannelName: string;
  reason: string;
  createdAtMs: number;
}

/** The overview's recent-proposals strip (Section 32.6 pages table). */
export function recentProposals(db: DatabaseSync, limit = 5): OverviewProposalRow[] {
  const rows = prepareCached(
    db,
    'inspector.overview.proposals_recent',
    `SELECT p.id, p.status, c.name AS channel_name, p.reason, p.created_at_ms
       FROM proposals p JOIN channels c ON c.id = p.target_channel_id
      ORDER BY p.created_at_ms DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map((p) => ({
    id: s(p.id),
    status: s(p.status),
    targetChannelName: s(p.channel_name) || 'unknown channel',
    reason: s(p.reason),
    createdAtMs: n(p.created_at_ms) ?? 0,
  }));
}

// ---- Memories ----------------------------------------------------------------

export type MemoriesView =
  | { mode: 'browse'; page: MemoryArchivePage }
  | { mode: 'search'; results: MemorySearchResult[]; query: string };

const ALL_MEMORY_STATUSES: MemorySearchResult['status'][] = [
  'active',
  'superseded',
  'resolved',
  'invalidated',
  'expired',
];

/** Memory index: FTS search when `q` is present, ranked inventory otherwise. */
export function memoriesView(
  db: DatabaseSync,
  grant: RetrievalGrant,
  args: {
    q: string;
    status: string | null;
    type: string | null;
    now: number;
    sort: MemoryArchiveSort;
    cursor: MemoryArchiveCursor | null;
  },
): MemoriesView {
  if (args.q.trim().length > 0) {
    return {
      mode: 'search',
      query: args.q,
      results: searchMemories(db, grant, {
        query: args.q,
        limit: INSPECTOR_PAGE_SIZE,
        now: args.now,
        ...(args.type ? { types: [args.type as MemorySearchResult['type']] } : {}),
        // The dropdown's default label is "active"; search honors it the same
        // way the browse path does so the two views agree.
        statuses: args.status === 'any'
          ? ALL_MEMORY_STATUSES
          : [args.status
              ? (args.status as MemorySearchResult['status'])
              : 'active'],
      }),
    };
  }
  const page = listMemoryArchivePage(db, grant, {
    limit: INSPECTOR_PAGE_SIZE,
    now: args.now,
    sort: args.sort,
    cursor: args.cursor,
    ...(args.type ? { types: [args.type as MemorySearchResult['type']] } : {}),
    ...(args.status === 'any'
      ? { statuses: ALL_MEMORY_STATUSES }
      : args.status
        ? { statuses: [args.status as MemorySearchResult['status']] }
        : {}),
  });
  return { mode: 'browse', page };
}

export interface MemoryLineage {
  /** The memory this one superseded, when present and permitted. */
  supersedes: MemoryDetails | null;
  /** Memories that superseded this one (one hop, bounded). */
  supersededBy: MemoryDetails[];
  /** Link rows (one hop, bounded), each with the counterpart rendered if permitted. */
  links: Array<{ relation: string; otherId: string; other: MemoryDetails | null }>;
}

export interface MemoryDetailPageData {
  details: MemoryDetails;
  evidence: MemoryEvidenceResult[];
  evidenceNext: MemoryEvidenceCursor | null;
  evidenceTotal: number;
  lineage: MemoryLineage;
  /** Runs whose proposals created or last touched this memory, newest first. */
  reassessments: Array<{ runId: string; runType: string | null; status: string | null; startedAtMs: number | null }>;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  supersedesId: string | null;
}

/**
 * One memory with evidence and one-hop lineage. Hidden and missing ids are
 * indistinguishable: `getMemoryDetails` returns undefined in both cases.
 */
export function memoryDetailPage(
  db: DatabaseSync,
  grant: RetrievalGrant,
  memoryId: string,
  _now: number,
  evidenceCursor: MemoryEvidenceCursor | null = null,
): MemoryDetailPageData | undefined {
  const details = getMemoryDetails(db, grant, memoryId);
  if (!details) return undefined;
  const evidencePage = getMemoryEvidencePage(db, grant, memoryId, {
    limit: INSPECTOR_PAGE_SIZE,
    cursor: evidenceCursor,
  });

  const raw = prepareCached(
    db,
    'inspector.memory.row',
    'SELECT supersedes_memory_id, created_by_run_id, created_at_ms, updated_at_ms FROM memories WHERE id = ?',
  ).get(memoryId) as Record<string, unknown> | undefined;
  const supersedesId = raw ? (raw.supersedes_memory_id === null ? null : s(raw.supersedes_memory_id)) : null;
  const supersedes = supersedesId ? (getMemoryDetails(db, grant, supersedesId) ?? null) : null;

  const supersededByRows = prepareCached(
    db,
    'inspector.memory.superseded_by',
    'SELECT id FROM memories WHERE supersedes_memory_id = ? ORDER BY created_at_ms DESC LIMIT ?',
  ).all(memoryId, PAGE_SIZE) as Array<Record<string, unknown>>;
  const supersededBy = supersededByRows
    .map((r) => getMemoryDetails(db, grant, s(r.id)))
    .filter((d): d is MemoryDetails => d !== undefined);

  const linkRows = prepareCached(
    db,
    'inspector.memory.links',
    `SELECT source_memory_id, target_memory_id, relation FROM memory_links
      WHERE source_memory_id = ? OR target_memory_id = ?
      ORDER BY created_at_ms DESC LIMIT ?`,
  ).all(memoryId, memoryId, PAGE_SIZE) as Array<Record<string, unknown>>;
  const links = linkRows.map((r) => {
    const otherId = s(r.source_memory_id) === memoryId ? s(r.target_memory_id) : s(r.source_memory_id);
    return { relation: s(r.relation), otherId, other: getMemoryDetails(db, grant, otherId) ?? null };
  });

  // Bounded JSON-scan reassessments: this memory's id inside the newest run
  // proposals (LIKE with escaped wildcards). The IN subquery rides
  // agent_runs_started_idx and caps the JSON scan at the newest 2000 runs, so
  // a never-matching pattern cannot walk the whole table.
  const runRows = prepareCached(
    db,
    'inspector.memory.runs',
    `SELECT id, run_type, status, started_at_ms FROM agent_runs
      WHERE id IN (SELECT id FROM agent_runs ORDER BY started_at_ms DESC LIMIT 2000)
        AND final_proposal_json IS NOT NULL
        AND final_proposal_json ${LIKE_ESCAPE_CLAUSE}
      ORDER BY started_at_ms DESC LIMIT 40`,
  ).all(`%${escapeLike(`"${memoryId}"`)}%`) as Array<Record<string, unknown>>;
  const reassessments = runRows.map((r) => ({
    runId: s(r.id),
    runType: r.run_type === null ? null : s(r.run_type),
    status: r.status === null ? null : s(r.status),
    startedAtMs: n(r.started_at_ms),
  }));

  return {
    details,
    evidence: evidencePage.items,
    evidenceNext: evidencePage.next,
    evidenceTotal: evidencePage.totalMatching,
    lineage: { supersedes, supersededBy, links },
    reassessments,
    createdAtMs: raw ? n(raw.created_at_ms) : null,
    updatedAtMs: raw ? n(raw.updated_at_ms) : null,
    supersedesId,
  };
}

// ---- Episodes -----------------------------------------------------------------

export interface EpisodeListRow {
  id: string;
  channelId: string;
  channelName: string;
  status: string;
  startedAtMs: number;
  lastActivityAtMs: number;
  humanMessageCount: number;
  interventionScore: number | null;
  hasSummary: boolean;
}

/** Cursor for keyset pagination over the episode index. */
export interface EpisodeCursor {
  lastActivityAtMs: number;
  id: string;
}

/** Grant-aware episode index, newest activity first. */
export function listEpisodes(
  db: DatabaseSync,
  grant: RetrievalGrant,
  cursor: EpisodeCursor | null,
): { rows: EpisodeListRow[]; next: EpisodeCursor | null } {
  const pred = channelVisibilityPredicate(grant);
  // The shared predicate already references channel alias `c`, which the JOIN
  // below binds to each episode's conversation channel.
  const where = ['c.id = e.conversation_channel_id', pred.sql];
  const params: SQLInputValue[] = [...pred.params];
  if (cursor) {
    where.push('(e.last_activity_at_ms < ? OR (e.last_activity_at_ms = ? AND e.id < ?))');
    params.push(cursor.lastActivityAtMs, cursor.lastActivityAtMs, cursor.id);
  }
  params.push(PAGE_SIZE + 1);
  const rows = prepareCached(
    db,
    `inspector.episodes.list:${pred.sql}:${cursor ? 1 : 0}`,
    `SELECT e.id, e.conversation_channel_id, c.name AS channel_name, e.status,
            e.started_at_ms, e.last_activity_at_ms, e.human_message_count, e.intervention_score,
            e.summary IS NOT NULL AS has_summary
       FROM episodes e
       JOIN channels c ON c.id = e.conversation_channel_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.last_activity_at_ms DESC, e.id DESC
      LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  return paginate(rows.map(toEpisodeRow), PAGE_SIZE, (r) => ({ lastActivityAtMs: r.lastActivityAtMs, id: r.id }));
}

function toEpisodeRow(r: Record<string, unknown>): EpisodeListRow {
  return {
    id: s(r.id),
    channelId: s(r.conversation_channel_id),
    channelName: s(r.channel_name) || s(r.conversation_channel_id),
    status: s(r.status),
    startedAtMs: n(r.started_at_ms) ?? 0,
    lastActivityAtMs: n(r.last_activity_at_ms) ?? 0,
    humanMessageCount: n(r.human_message_count) ?? 0,
    interventionScore: n(r.intervention_score),
    hasSummary: Number(r.has_summary) === 1,
  };
}

export interface EpisodeDetailPageData {
  episode: {
    id: string;
    channelId: string;
    channelName: string;
    status: string;
    startedAtMs: number | null;
    endedAtMs: number | null;
    lastActivityAtMs: number | null;
    humanMessageCount: number | null;
    totalMessageCount: number | null;
    triggerReason: string | null;
    summary: string | null;
    consequential: boolean | null;
    interventionScore: number | null;
    reviewedAtMs: number | null;
  };
  /** One page of messages (repository cap), oldest first. */
  messages: Array<{
    messageId: string;
    ordinal: number;
    authorDisplayName: string;
    content: string;
    createdAtMs: number;
    discordLink: string | null;
  }>;
  /** The next page's cursor ordinal, or null when every message is shown. */
  messageNextOrdinal: number | null;
  runs: Array<{ id: string; runType: string | null; status: string | null; startedAtMs: number | null }>;
}

/**
 * One episode with one page of its permitted messages. The channel-visibility
 * predicate is applied in SQL; an episode in a channel the grant cannot read is
 * indistinguishable from a missing id. Messages paginate by `ordinal` — the
 * `UNIQUE (episode_id, ordinal)` constraint is the index the cursor rides —
 * at the 20-row repository cap.
 */
export function episodeDetailPage(
  db: DatabaseSync,
  grant: RetrievalGrant,
  episodeId: string,
  afterOrdinal: number | null = null,
): EpisodeDetailPageData | undefined {
  const pred = channelVisibilityPredicate(grant);
  const row = prepareCached(
    db,
    `inspector.episode.get:${pred.sql}`,
    `SELECT e.id, e.conversation_channel_id, c.name AS channel_name, e.status, e.started_at_ms,
            e.ended_at_ms, e.last_activity_at_ms, e.human_message_count, e.total_message_count,
            e.trigger_reason, e.summary, e.consequential, e.intervention_score, e.reviewed_at_ms
       FROM episodes e
       JOIN channels c ON c.id = e.conversation_channel_id
      WHERE e.id = ? AND ${pred.sql}`,
  ).get(episodeId, ...pred.params) as Record<string, unknown> | undefined;
  if (!row) return undefined;

  const messageWhere = ['em.episode_id = ?', 'm.deleted_at_ms IS NULL', pred.sql];
  const messageParams: SQLInputValue[] = [episodeId, ...pred.params];
  if (afterOrdinal !== null) {
    messageWhere.push('em.ordinal > ?');
    messageParams.push(afterOrdinal);
  }
  messageParams.push(PAGE_SIZE + 1);
  const messageRows = prepareCached(
    db,
    `inspector.episode.messages:${pred.sql}:${afterOrdinal !== null ? 1 : 0}`,
    `SELECT em.message_id, em.ordinal, m.author_display_name, m.content, m.created_at_ms,
            m.guild_id, m.channel_id, m.deleted_at_ms
       FROM episode_messages em
       JOIN messages m ON m.id = em.message_id
       JOIN channels c ON c.id = m.channel_id
      WHERE ${messageWhere.join(' AND ')}
      ORDER BY em.ordinal ASC
      LIMIT ?`,
  ).all(...messageParams) as Array<Record<string, unknown>>;
  const messagePage = paginate(
    messageRows.map((r) => ({
      messageId: s(r.message_id),
      ordinal: n(r.ordinal) ?? 0,
      authorDisplayName: s(r.author_display_name),
      content: s(r.content),
      createdAtMs: n(r.created_at_ms) ?? 0,
      discordLink:
        r.deleted_at_ms === null && r.guild_id !== null
          ? `https://discord.com/channels/${s(r.guild_id)}/${s(r.channel_id)}/${s(r.message_id)}`
          : null,
    })),
    PAGE_SIZE,
    (m) => m.ordinal,
  );

  const runRows = prepareCached(
    db,
    'inspector.episode.runs',
    'SELECT id, run_type, status, started_at_ms FROM agent_runs WHERE episode_id = ? ORDER BY started_at_ms DESC LIMIT 10',
  ).all(episodeId) as Array<Record<string, unknown>>;

  return {
    episode: {
      id: s(row.id),
      channelId: s(row.conversation_channel_id),
      channelName: s(row.channel_name) || s(row.conversation_channel_id),
      status: s(row.status),
      startedAtMs: n(row.started_at_ms),
      endedAtMs: n(row.ended_at_ms),
      lastActivityAtMs: n(row.last_activity_at_ms),
      humanMessageCount: n(row.human_message_count),
      totalMessageCount: n(row.total_message_count),
      triggerReason: row.trigger_reason === null ? null : s(row.trigger_reason),
      summary: row.summary === null ? null : s(row.summary),
      consequential: row.consequential === null ? null : Number(row.consequential) === 1,
      interventionScore: n(row.intervention_score),
      reviewedAtMs: n(row.reviewed_at_ms),
    },
    messages: messagePage.rows,
    messageNextOrdinal: messagePage.next,
    runs: runRows.map((r) => ({
      id: s(r.id),
      runType: r.run_type === null ? null : s(r.run_type),
      status: r.status === null ? null : s(r.status),
      startedAtMs: n(r.started_at_ms),
    })),
  };
}

// ---- Runs ----------------------------------------------------------------------

export interface RunListRow {
  id: string;
  runType: string;
  status: string;
  model: string;
  episodeId: string | null;
  startedAtMs: number;
  executionStartedAtMs: number | null;
  endedAtMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  reasoningTokens: number | null;
  providerTotalTokens: number | null;
  uncachedInputCostUsd: number | null;
  outputCostUsd: number | null;
  cacheReadCostUsd: number | null;
  cacheWriteCostUsd: number | null;
  thinkingLevel: string | null;
  shadowOfRunId: string | null;
  error: string | null;
}

/** Run index, newest first, keyset-paginated. */
export function listRuns(
  db: DatabaseSync,
  cursor: { startedAtMs: number; id: string } | null,
): { rows: RunListRow[]; next: { startedAtMs: number; id: string } | null } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (cursor) {
    where.push('(started_at_ms < ? OR (started_at_ms = ? AND id < ?))');
    params.push(cursor.startedAtMs, cursor.startedAtMs, cursor.id);
  }
  params.push(PAGE_SIZE + 1);
  const rows = prepareCached(
    db,
    `inspector.runs.list:${cursor ? 1 : 0}`,
    `SELECT id, run_type, status, model, episode_id, started_at_ms,
            execution_started_at_ms, ended_at_ms,
            input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
            cache_write_1h_tokens, output_tokens, reasoning_tokens, provider_total_tokens,
            cost_usd, uncached_input_cost_usd, output_cost_usd, cache_read_cost_usd,
            cache_write_cost_usd, thinking_level, shadow_of_run_id, error
       FROM agent_runs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY started_at_ms DESC, id DESC
      LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  const mapped = rows.map((r) => ({
    id: s(r.id),
    runType: s(r.run_type),
    status: s(r.status),
    model: s(r.model),
    episodeId: r.episode_id === null ? null : s(r.episode_id),
    startedAtMs: n(r.started_at_ms) ?? 0,
    executionStartedAtMs: n(r.execution_started_at_ms),
    endedAtMs: n(r.ended_at_ms),
    inputTokens: n(r.input_tokens),
    outputTokens: n(r.output_tokens),
    costUsd: n(r.cost_usd),
    uncachedInputTokens: n(r.uncached_input_tokens),
    cacheReadTokens: n(r.cache_read_tokens),
    cacheWriteTokens: n(r.cache_write_tokens),
    cacheWrite1hTokens: n(r.cache_write_1h_tokens),
    reasoningTokens: n(r.reasoning_tokens),
    providerTotalTokens: n(r.provider_total_tokens),
    uncachedInputCostUsd: n(r.uncached_input_cost_usd),
    outputCostUsd: n(r.output_cost_usd),
    cacheReadCostUsd: n(r.cache_read_cost_usd),
    cacheWriteCostUsd: n(r.cache_write_cost_usd),
    thinkingLevel: r.thinking_level === null ? null : s(r.thinking_level),
    shadowOfRunId: r.shadow_of_run_id === null ? null : s(r.shadow_of_run_id),
    error: r.error === null ? null : s(r.error),
  }));
  return paginate(mapped, PAGE_SIZE, (r) => ({ startedAtMs: r.startedAtMs, id: r.id }));
}

export interface RunDetailPageData {
  run: RunListRow & {
    guildId: string;
    promptVersion: string;
    provider: string;
    turns: number | null;
    proposal: {
      reason: string | null; message: string | null; score: number | null; targetChannelId: string | null;
      status: string | null; policyDecision: Record<string, unknown> | null;
      episodeSummary: string | null;
      consequential: boolean | null;
      memoryProposals: TerminalProposalView['memoryProposals'];
    } | null;
    shadowComparison: Record<string, unknown> | null;
  };
  pairedShadowRunId: string | null;
  speech: Array<{ kind: 'proposal' | 'outbox'; id: string; status: string; atMs: number | null; text: string | null }>;
  /** Raw audit columns for the context ledger; counts only, parsed by ledger.ts. */
  toolCallsJson: string | null;
  modelTurnsJson: string | null;
  provenanceJson: string | null;
}

/**
 * One run: metadata, ledger inputs, its proposal, and any delivered speech.
 * The run row carries no channel content of its own; the episode is linked
 * by id only, and the episode page applies the grant when followed.
 */
export function runDetailPage(db: DatabaseSync, _grant: RetrievalGrant, runId: string): RunDetailPageData | undefined {
  const r = prepareCached(
    db,
    'inspector.run.get',
    `SELECT id, guild_id, episode_id, run_type, prompt_version, provider, model, status,
            started_at_ms, execution_started_at_ms, ended_at_ms, input_tokens, uncached_input_tokens,
            cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens,
            reasoning_tokens, provider_total_tokens, cost_usd, uncached_input_cost_usd,
            output_cost_usd, cache_read_cost_usd, cache_write_cost_usd, thinking_level, error,
            shadow_of_run_id, shadow_comparison_json, final_proposal_json, tool_calls_json,
            model_turns_json, retrieval_provenance_json
       FROM agent_runs WHERE id = ?`,
  ).get(runId) as Record<string, unknown> | undefined;
  if (!r) return undefined;

  const terminal = parseTerminalProposal(
    r.final_proposal_json === null || r.final_proposal_json === undefined ? null : s(r.final_proposal_json),
    s(r.run_type),
  );
  let proposal: RunDetailPageData['run']['proposal'] = terminal ? {
    reason: terminal.reason, message: terminal.message, score: null,
    targetChannelId: terminal.targetChannelId, status: null, policyDecision: null,
    episodeSummary: terminal.episodeSummary,
    consequential: terminal.consequential,
    memoryProposals: terminal.memoryProposals,
  } : null;

  const proposalRows = prepareCached(
    db,
    'inspector.run.proposals',
    'SELECT id, status, reason, computed_score, target_channel_id, policy_decision_json, created_at_ms FROM proposals WHERE run_id = ? ORDER BY created_at_ms DESC LIMIT 5',
  ).all(runId) as Array<Record<string, unknown>>;
  const routed = proposalRows[0];
  if (routed) {
    proposal = {
      reason: proposal?.reason ?? (routed.reason === null ? null : s(routed.reason)),
      message: proposal?.message ?? null,
      score: n(routed.computed_score),
      targetChannelId: proposal?.targetChannelId ?? s(routed.target_channel_id),
      status: s(routed.status),
      policyDecision: parsePolicyDecision(routed.policy_decision_json === null ? null : s(routed.policy_decision_json)),
      episodeSummary: proposal?.episodeSummary ?? null,
      consequential: proposal?.consequential ?? null,
      memoryProposals: proposal?.memoryProposals ?? [],
    };
  }
  const outboxRows = prepareCached(
    db,
    'inspector.run.outbox',
    `SELECT o.id, o.status, o.content, o.sent_at_ms
       FROM outbox o JOIN proposals p ON p.id = o.proposal_id
      WHERE p.run_id = ? ORDER BY o.created_at_ms DESC LIMIT 5`,
  ).all(runId) as Array<Record<string, unknown>>;
  const pairedShadow = r.shadow_of_run_id === null
    ? prepareCached(
        db,
        'inspector.run.shadow_pair',
        'SELECT id FROM agent_runs WHERE shadow_of_run_id=? LIMIT 1',
      ).get(runId) as { id: string } | undefined
    : undefined;
  let shadowComparison: Record<string, unknown> | null = null;
  if (r.shadow_comparison_json !== null && r.shadow_comparison_json !== undefined) {
    try {
      const parsed = JSON.parse(s(r.shadow_comparison_json)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        shadowComparison = parsed as Record<string, unknown>;
      }
    } catch {
      shadowComparison = null;
    }
  }

  return {
    run: {
      id: s(r.id),
      guildId: s(r.guild_id),
      runType: s(r.run_type),
      status: s(r.status),
      model: s(r.model),
      promptVersion: s(r.prompt_version),
      provider: s(r.provider),
      episodeId: r.episode_id === null ? null : s(r.episode_id),
      startedAtMs: n(r.started_at_ms) ?? 0,
      executionStartedAtMs: n(r.execution_started_at_ms),
      endedAtMs: n(r.ended_at_ms),
      inputTokens: n(r.input_tokens),
      outputTokens: n(r.output_tokens),
      costUsd: n(r.cost_usd),
      uncachedInputTokens: n(r.uncached_input_tokens),
      cacheReadTokens: n(r.cache_read_tokens),
      cacheWriteTokens: n(r.cache_write_tokens),
      cacheWrite1hTokens: n(r.cache_write_1h_tokens),
      reasoningTokens: n(r.reasoning_tokens),
      providerTotalTokens: n(r.provider_total_tokens),
      uncachedInputCostUsd: n(r.uncached_input_cost_usd),
      outputCostUsd: n(r.output_cost_usd),
      cacheReadCostUsd: n(r.cache_read_cost_usd),
      cacheWriteCostUsd: n(r.cache_write_cost_usd),
      thinkingLevel: r.thinking_level === null ? null : s(r.thinking_level),
      shadowOfRunId: r.shadow_of_run_id === null ? null : s(r.shadow_of_run_id),
      error: r.error === null ? null : s(r.error),
      turns: null,
      proposal,
      shadowComparison,
    },
    pairedShadowRunId: pairedShadow?.id ?? null,
    speech: [
      ...proposalRows.map((p) => ({
        kind: 'proposal' as const,
        id: s(p.id),
        status: s(p.status),
        atMs: n(p.created_at_ms),
        text: p.reason === null || p.reason === undefined ? null : s(p.reason),
      })),
      ...outboxRows.map((o) => ({
        kind: 'outbox' as const,
        id: s(o.id),
        status: s(o.status),
        atMs: n(o.sent_at_ms),
        text: s(o.content),
      })),
    ],
    toolCallsJson: r.tool_calls_json === null || r.tool_calls_json === undefined ? null : s(r.tool_calls_json),
    modelTurnsJson: r.model_turns_json === null || r.model_turns_json === undefined ? null : s(r.model_turns_json),
    provenanceJson:
      r.retrieval_provenance_json === null || r.retrieval_provenance_json === undefined
        ? null
        : s(r.retrieval_provenance_json),
  };
}

export interface FocusedExposureView {
  rows: Array<{
    kind: 'message' | 'memory'; id: string; fingerprintStatus: 'unchanged' | 'changed' | 'historic_unavailable';
    content: string; secondary: string; atMs: number | null; discordLink: string | null;
  }>;
  unavailableCount: number;
  nextOffset: number | null;
}

export function focusedExposurePage(
  db: DatabaseSync,
  grant: RetrievalGrant,
  exposure: { messages: Array<{ id: string; fingerprint: string }>; memories: Array<{ id: string; fingerprint: string }> },
  offset = 0,
): FocusedExposureView {
  const refs = [
    ...exposure.messages.map((ref) => ({ ...ref, kind: 'message' as const })),
    ...exposure.memories.map((ref) => ({ ...ref, kind: 'memory' as const })),
  ];
  const start = Math.max(0, Math.floor(offset));
  const page = refs.slice(start, start + INSPECTOR_PAGE_SIZE);
  const messageRefs = page.filter((ref) => ref.kind === 'message');
  const messages = new Map<string, Record<string, unknown>>();
  if (messageRefs.length) {
    const pred = channelVisibilityPredicate(grant);
    const placeholders = messageRefs.map(() => '?').join(',');
    const rows = prepareCached(
      db,
      `inspector.run.exposure.messages:${messageRefs.length}:${pred.sql}`,
      `SELECT m.id, m.guild_id, m.channel_id, c.name AS channel_name, m.author_display_name,
              m.content, m.created_at_ms
         FROM messages m JOIN channels c ON c.id = m.channel_id
        WHERE m.id IN (${placeholders}) AND m.deleted_at_ms IS NULL AND ${pred.sql}`,
    ).all(...messageRefs.map((ref) => ref.id), ...pred.params) as Array<Record<string, unknown>>;
    for (const row of rows) messages.set(s(row.id), row);
  }
  const rows: FocusedExposureView['rows'] = [];
  let unavailableCount = 0;
  for (const ref of page) {
    if (ref.kind === 'message') {
      const row = messages.get(ref.id);
      if (!row) { unavailableCount += 1; continue; }
      const current = fingerprintExposedMessage(db, ref.id);
      rows.push({ kind: 'message', id: ref.id,
        fingerprintStatus: !current || ref.fingerprint === 'conflicting-exposure' || ref.fingerprint === 'unavailable-at-exposure'
          ? 'historic_unavailable' : current === ref.fingerprint ? 'unchanged' : 'changed',
        content: s(row.content), secondary: `${s(row.author_display_name)} in #${s(row.channel_name)}`,
        atMs: n(row.created_at_ms), discordLink: `https://discord.com/channels/${s(row.guild_id)}/${s(row.channel_id)}/${ref.id}` });
    } else {
      const memory = getMemoryDetails(db, grant, ref.id);
      if (!memory) { unavailableCount += 1; continue; }
      const current = fingerprintExposedMemory(db, ref.id);
      rows.push({ kind: 'memory', id: ref.id,
        fingerprintStatus: !current || ref.fingerprint === 'conflicting-exposure' || ref.fingerprint === 'unavailable-at-exposure'
          ? 'historic_unavailable' : current === ref.fingerprint ? 'unchanged' : 'changed',
        content: memory.statement, secondary: `${memory.type} · ${memory.status} · ${memory.scopeType}${memory.scopeKey ? `:${memory.scopeKey}` : ''}`,
        atMs: memory.reviewAfterMs, discordLink: null });
    }
  }
  return { rows, unavailableCount, nextOffset: start + INSPECTOR_PAGE_SIZE < refs.length ? start + INSPECTOR_PAGE_SIZE : null };
}

// ---- Speech trail ---------------------------------------------------------------

export interface DescTimeCursor {
  createdAtMs: number;
  id: string;
}

export type SpeechView = 'proposals' | 'deliveries';

export interface SpeechPageData {
  view: SpeechView;
  totalMatching: number;
  next: DescTimeCursor | null;
  proposals: Array<{
    id: string;
    runId: string;
    status: string;
    targetChannelName: string;
    reason: string;
    message: string | null;
    score: number | null;
    createdAtMs: number;
    reviewedByUserId: string | null;
    reviewedAtMs: number | null;
  }>;
  deliveries: Array<{
    id: string;
    status: string;
    channelName: string;
    content: string;
    attempts: number;
    lastError: string | null;
    createdAtMs: number;
    sentAtMs: number | null;
  }>;
}

/** The speech trail: what Mneme proposed, how it was decided, what was sent. */
export function speechPage(
  db: DatabaseSync,
  view: SpeechView,
  cursor: DescTimeCursor | null,
): SpeechPageData {
  const params: SQLInputValue[] = [];
  if (cursor) {
    params.push(cursor.createdAtMs, cursor.createdAtMs, cursor.id);
  }
  params.push(PAGE_SIZE + 1);
  const proposalRows = view === 'proposals'
    ? prepareCached(
        db,
        `inspector.speech.proposals:${cursor ? 1 : 0}`,
        `SELECT p.id, p.run_id, p.status, c.name AS channel_name, p.reason, p.message, p.computed_score,
                p.created_at_ms, p.reviewed_by_user_id, p.reviewed_at_ms
           FROM proposals p INDEXED BY proposals_inspector_archive_idx
           CROSS JOIN channels c ON c.id = p.target_channel_id
          ${cursor ? 'WHERE p.created_at_ms < ? OR (p.created_at_ms = ? AND p.id < ?)' : ''}
          ORDER BY p.created_at_ms DESC, p.id DESC LIMIT ?`,
      ).all(...params) as Array<Record<string, unknown>>
    : [];
  const outboxRows = view === 'deliveries'
    ? prepareCached(
        db,
        `inspector.speech.outbox:${cursor ? 1 : 0}`,
        `SELECT o.id, o.status, c.name AS channel_name, o.content, o.attempts, o.last_error,
                o.created_at_ms, o.sent_at_ms
           FROM outbox o INDEXED BY outbox_inspector_archive_idx
           CROSS JOIN channels c ON c.id = o.channel_id
          ${cursor ? 'WHERE o.created_at_ms < ? OR (o.created_at_ms = ? AND o.id < ?)' : ''}
          ORDER BY o.created_at_ms DESC, o.id DESC LIMIT ?`,
      ).all(...params) as Array<Record<string, unknown>>
    : [];
  const rawRows = view === 'proposals' ? proposalRows : outboxRows;
  const pageRows = rawRows.slice(0, PAGE_SIZE);
  const last = pageRows[pageRows.length - 1];
  return {
    view,
    totalMatching: n((prepareCached(
      db,
      `inspector.speech.count:${view}`,
      `SELECT COUNT(*) AS n FROM ${view === 'proposals' ? 'proposals' : 'outbox'}`,
    ).get() as Record<string, unknown> | undefined)?.n) ?? 0,
    next: rawRows.length > PAGE_SIZE && last
      ? { createdAtMs: n(last.created_at_ms) ?? 0, id: s(last.id) }
      : null,
    proposals: (view === 'proposals' ? pageRows : []).map((p) => ({
      id: s(p.id),
      runId: s(p.run_id),
      status: s(p.status),
      targetChannelName: s(p.channel_name) || 'unknown channel',
      reason: s(p.reason),
      message: p.message === null || p.message === undefined ? null : s(p.message),
      score: n(p.computed_score),
      createdAtMs: n(p.created_at_ms) ?? 0,
      reviewedByUserId: p.reviewed_by_user_id === null ? null : s(p.reviewed_by_user_id),
      reviewedAtMs: n(p.reviewed_at_ms),
    })),
    deliveries: (view === 'deliveries' ? pageRows : []).map((o) => ({
      id: s(o.id),
      status: s(o.status),
      channelName: s(o.channel_name) || 'unknown channel',
      content: s(o.content),
      attempts: n(o.attempts) ?? 0,
      lastError: o.last_error === null || o.last_error === undefined ? null : s(o.last_error),
      createdAtMs: n(o.created_at_ms) ?? 0,
      sentAtMs: n(o.sent_at_ms),
    })),
  };
}

// ---- Channels -------------------------------------------------------------------

export interface ChannelListRow {
  id: string;
  name: string;
  /** SQLite's normalized ordering key, retained so the next cursor is exact. */
  sortName: string;
  parentId: string | null;
  parentName: string | null;
  isThread: boolean;
  threadCount: number;
  visibilityClass: string;
  ingestEnabled: boolean;
  deletedAtMs: number | null;
  lastMessageAtMs: number | null;
  messageCount: number;
  episodeCount: number;
  controlSurface: boolean;
}

export type ChannelListView = 'channels' | 'threads';

export interface ChannelCursor {
  deleted: number;
  sortName: string;
  id: string;
}

export interface ChannelListPage {
  rows: ChannelListRow[];
  next: ChannelCursor | null;
  totalMatching: number;
  view: ChannelListView;
}

/**
 * Channel policy view. Channel rows and counts are metadata — no message
 * content is selected, so this page is not grant-filtered; the inspector
 * credential is the admin who already owns this policy.
 */
export function channelsPage(
  db: DatabaseSync,
  view: ChannelListView,
  cursor: ChannelCursor | null,
): ChannelListPage {
  const isThread = view === 'threads' ? 1 : 0;
  const where = ['c.is_thread = ?'];
  const params: SQLInputValue[] = [isThread];
  if (cursor) {
    where.push(`(
      (c.deleted_at_ms IS NOT NULL) > ?
      OR ((c.deleted_at_ms IS NOT NULL) = ? AND LOWER(COALESCE(c.name, c.id)) > ?)
      OR ((c.deleted_at_ms IS NOT NULL) = ? AND LOWER(COALESCE(c.name, c.id)) = ? AND c.id > ?)
    )`);
    params.push(cursor.deleted, cursor.deleted, cursor.sortName, cursor.deleted, cursor.sortName, cursor.id);
  }
  params.push(PAGE_SIZE + 1);
  const rows = prepareCached(
    db,
    `inspector.channels:${view}:${cursor ? 1 : 0}`,
    `SELECT c.id, c.name, c.parent_id, parent.name AS parent_name, c.is_thread,
            c.visibility_class, c.ingest_enabled,
            c.deleted_at_ms,
            LOWER(COALESCE(c.name, c.id)) AS sort_name,
            (SELECT COUNT(*) FROM channels thread
              WHERE thread.parent_id = c.id AND thread.is_thread = 1) AS thread_count,
            (SELECT MAX(m.created_at_ms) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at_ms IS NULL)
              AS last_message_at_ms,
            (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at_ms IS NULL) AS message_count,
            (SELECT COUNT(*) FROM episodes e WHERE e.conversation_channel_id = c.id) AS episode_count
       FROM channels c
       LEFT JOIN channels parent ON parent.id = c.parent_id
      WHERE ${where.join(' AND ')}
      ORDER BY (c.deleted_at_ms IS NOT NULL), LOWER(COALESCE(c.name, c.id)), c.id
      LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  const mapped = rows.map((r) => ({
    id: s(r.id),
    name: s(r.name) || s(r.id),
    sortName: s(r.sort_name),
    parentId: r.parent_id === null ? null : s(r.parent_id),
    parentName: r.parent_name === null ? null : s(r.parent_name),
    isThread: Number(r.is_thread) === 1,
    threadCount: n(r.thread_count) ?? 0,
    visibilityClass: s(r.visibility_class),
    ingestEnabled: Number(r.ingest_enabled) === 1,
    deletedAtMs: n(r.deleted_at_ms),
    lastMessageAtMs: n(r.last_message_at_ms),
    messageCount: n(r.message_count) ?? 0,
    episodeCount: n(r.episode_count) ?? 0,
    controlSurface: isMnemeTestChannelName(s(r.name))
      || (Number(r.is_thread) === 1
        && isMnemeTestChannelName(r.parent_name === null ? null : s(r.parent_name))),
  }));
  const page = paginate(mapped, PAGE_SIZE, (row) => ({
    deleted: row.deletedAtMs === null ? 0 : 1,
    sortName: row.sortName,
    id: row.id,
  }));
  const total = prepareCached(
    db,
    `inspector.channels.count:${view}`,
    'SELECT COUNT(*) AS n FROM channels WHERE is_thread = ?',
  ).get(isThread) as Record<string, unknown> | undefined;
  return {
    ...page,
    totalMatching: n(total?.n) ?? 0,
    view,
  };
}

// ---- Jobs -------------------------------------------------------------------------

export interface JobListRow {
  id: string;
  type: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAfterMs: number | null;
  createdAtMs: number | null;
  completedAtMs: number | null;
}

/** Durable job queue health: recent rows plus the per-status counts. */
export function jobsPage(
  db: DatabaseSync,
  args: { cursor: DescTimeCursor | null; status: string | null; type: string | null },
): {
  rows: JobListRow[];
  counts: Record<string, number>;
  totalMatching: number;
  next: DescTimeCursor | null;
} {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (args.status) {
    where.push('status = ?');
    params.push(args.status);
  }
  if (args.type) {
    where.push('type = ?');
    params.push(args.type);
  }
  const filterWhere = [...where];
  const countParams = [...params];
  if (args.cursor) {
    where.push('(created_at_ms < ? OR (created_at_ms = ? AND id < ?))');
    params.push(args.cursor.createdAtMs, args.cursor.createdAtMs, args.cursor.id);
  }
  params.push(PAGE_SIZE + 1);
  const rows = prepareCached(
    db,
    `inspector.jobs:${args.status ? 1 : 0}:${args.type ? 1 : 0}:${args.cursor ? 1 : 0}`,
    `SELECT id, type, status, priority, attempts, max_attempts, last_error, run_after_ms,
            created_at_ms, completed_at_ms
       FROM jobs INDEXED BY jobs_inspector_archive_idx
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  const pageRows = rows.slice(0, PAGE_SIZE);
  const counts = countBy(
    db,
    'inspector.jobs.counts',
    'SELECT status AS k, COUNT(*) AS n FROM jobs GROUP BY status',
  );
  const mappedRows = pageRows.map((r) => ({
    id: s(r.id),
    type: s(r.type),
    status: s(r.status),
    priority: n(r.priority) ?? 0,
    attempts: n(r.attempts) ?? 0,
    maxAttempts: n(r.max_attempts) ?? 0,
    lastError: r.last_error === null || r.last_error === undefined ? null : s(r.last_error),
    runAfterMs: n(r.run_after_ms),
    createdAtMs: n(r.created_at_ms),
    completedAtMs: n(r.completed_at_ms),
  }));
  return {
    rows: mappedRows,
    counts,
    totalMatching: n((prepareCached(
      db,
      `inspector.jobs.total:${args.status ? 1 : 0}:${args.type ? 1 : 0}`,
      `SELECT COUNT(*) AS n FROM jobs ${filterWhere.length ? `WHERE ${filterWhere.join(' AND ')}` : ''}`,
    ).get(...countParams) as Record<string, unknown> | undefined)?.n) ?? 0,
    next: rows.length > PAGE_SIZE && mappedRows.length > 0
      ? {
          createdAtMs: mappedRows[mappedRows.length - 1]?.createdAtMs ?? 0,
          id: mappedRows[mappedRows.length - 1]?.id ?? '',
        }
      : null,
  };
}

// ---- Audit --------------------------------------------------------------------------

export interface AuditListRow {
  id: string;
  actorUserId: string;
  action: string;
  target: string | null;
  details: string | null;
  createdAtMs: number;
}

/**
 * Recent admin events. Details are stored pre-sanitized by the command layer
 * (Section 27); this view renders them as compact key=value text, bounded.
 */
export function auditPage(
  db: DatabaseSync,
  cursor: DescTimeCursor | null,
): { rows: AuditListRow[]; next: DescTimeCursor | null; totalMatching: number } {
  const where = cursor ? 'WHERE created_at_ms < ? OR (created_at_ms = ? AND id < ?)' : '';
  const params: SQLInputValue[] = cursor ? [cursor.createdAtMs, cursor.createdAtMs, cursor.id] : [];
  params.push(PAGE_SIZE + 1);
  const rows = prepareCached(
    db,
    `inspector.audit:${cursor ? 1 : 0}`,
    `SELECT id, actor_user_id, action, target, details_json, created_at_ms
       FROM admin_events INDEXED BY admin_events_inspector_archive_idx
       ${where} ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  const pageRows = rows.slice(0, PAGE_SIZE);
  const mapped = pageRows.map((r) => {
    let details: string | null = null;
    try {
      const parsed = JSON.parse(s(r.details_json) || '{}') as Record<string, unknown>;
      const entries = Object.entries(parsed)
        .slice(0, 8)
        .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 80) : s(v).slice(0, 80)}`);
      details = entries.length > 0 ? entries.join(' ') : null;
    } catch {
      details = null;
    }
    return {
      id: s(r.id),
      actorUserId: s(r.actor_user_id),
      action: s(r.action),
      target: r.target === null || r.target === undefined ? null : s(r.target),
      details,
      createdAtMs: n(r.created_at_ms) ?? 0,
    };
  });
  const last = mapped[mapped.length - 1];
  return {
    rows: mapped,
    totalMatching: n((prepareCached(db, 'inspector.audit.count', 'SELECT COUNT(*) AS n FROM admin_events')
      .get() as Record<string, unknown> | undefined)?.n) ?? 0,
    next: rows.length > PAGE_SIZE && last ? { createdAtMs: last.createdAtMs, id: last.id } : null,
  };
}

// ---- Resolve -----------------------------------------------------------------------

export type ResolvedEntity =
  | { kind: 'memory'; id: string }
  | { kind: 'episode'; id: string }
  | { kind: 'run'; id: string }
  | { kind: 'proposal'; id: string }
  | { kind: 'outbox'; id: string }
  | { kind: 'job'; id: string }
  | { kind: 'admin_event'; id: string }
  | { kind: 'channel'; id: string }
  | { kind: 'message'; id: string; channelId: string | null; guildId: string | null };

/** A prefix must be this long before the jump box will match on it. */
const RESOLVE_PREFIX_MIN = 8;

/**
 * Upper bound of the id range that shares `prefix`. Every id is ASCII (UUIDs
 * and Discord snowflakes), so appending the highest code point closes the
 * range for any stored value; ids are compared with the default BINARY
 * collation, so the range rides the primary-key index.
 */
function prefixUpperBound(prefix: string): string {
  return `${prefix}\uffff`;
}

/**
 * Jump box: resolve any entity id or unique 8+ char prefix to its page.
 * Scope-sensitive kinds (memory, episode, message) verify the grant before
 * answering; a hidden id resolves to nothing, same as a missing one.
 *
 * Both lookups ride each table's primary-key index: an exact `=` probe, then
 * a `>= prefix AND < upper` range when the input is long enough to be a
 * prefix. No `LIKE` is involved, so no wildcard escaping and no full scan —
 * the messages table in particular is never walked (Section 32.6 bounded
 * queries). Exactly one row resolves; zero or many (ambiguous prefix) do not.
 */
export function resolveEntity(db: DatabaseSync, grant: RetrievalGrant, input: string): ResolvedEntity | null {
  const id = input.trim();
  if (id.length < 4 || id.length > 128) return null;
  const asPrefix = id.length >= RESOLVE_PREFIX_MIN;
  const upper = prefixUpperBound(id);
  const unique = (rows: Array<Record<string, unknown>>): Record<string, unknown> | null =>
    rows.length === 1 ? (rows[0] ?? null) : null;

  /** Exact probe, then the prefix range; `select` names the columns to return. */
  const lookup = (table: string, select: string, extraWhere = '', extraParams: SQLInputValue[] = []) => {
    const exact = prepareCached(
      db,
      `inspector.resolve.${table}.exact:${extraWhere}`,
      `SELECT ${select} FROM ${table} WHERE id = ? ${extraWhere}`,
    ).all(id, ...extraParams) as Array<Record<string, unknown>>;
    if (exact.length === 1) return exact[0] ?? null;
    if (!asPrefix) return null;
    const ranged = prepareCached(
      db,
      `inspector.resolve.${table}.prefix:${extraWhere}`,
      `SELECT ${select} FROM ${table} WHERE id >= ? AND id < ? ${extraWhere} ORDER BY id LIMIT 2`,
    ).all(id, upper, ...extraParams) as Array<Record<string, unknown>>;
    return unique(ranged);
  };

  const mem = lookup('memories', 'id');
  if (mem && getMemoryDetails(db, grant, s(mem.id))) return { kind: 'memory', id: s(mem.id) };

  const epi = lookup('episodes', 'id');
  if (epi && episodeDetailPage(db, grant, s(epi.id))) return { kind: 'episode', id: s(epi.id) };

  // Every system table shares the `{ kind, id }` result shape; the message
  // variant (which carries channel and guild ids) is handled separately below.
  const tableKinds = [
    { table: 'agent_runs', kind: 'run' },
    { table: 'proposals', kind: 'proposal' },
    { table: 'outbox', kind: 'outbox' },
    { table: 'jobs', kind: 'job' },
    { table: 'admin_events', kind: 'admin_event' },
    { table: 'channels', kind: 'channel' },
  ] as const;
  for (const t of tableKinds) {
    const found = lookup(t.table, 'id');
    if (found) return { kind: t.kind, id: s(found.id) };
  }

  // Messages apply the channel-visibility predicate in SQL, like every other
  // message read; the predicate references channel alias `c`.
  const msgPred = channelVisibilityPredicate(grant);
  const msg = lookup(
    'messages m',
    'm.id AS id, m.channel_id, m.guild_id',
    `AND m.deleted_at_ms IS NULL AND EXISTS (SELECT 1 FROM channels c WHERE c.id = m.channel_id AND ${msgPred.sql})`,
    msgPred.params,
  );
  if (msg) {
    return {
      kind: 'message',
      id: s(msg.id),
      channelId: s(msg.channel_id) || null,
      guildId: s(msg.guild_id) || null,
    };
  }
  return null;
}

// ---- Shared pagination helper ----------------------------------------------------

/**
 * Keyset pagination over one fetched page: if the query returned `limit + 1`
 * rows, drop the extra and report it as the next cursor.
 */
export function paginate<T, C>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => C,
): { rows: T[]; next: C | null } {
  if (rows.length <= limit) return { rows, next: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return last === undefined ? { rows, next: null } : { rows: page, next: cursorOf(last) };
}
