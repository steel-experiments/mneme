import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { type DatabaseSync } from '../database.js';
import {
  channelVisibilityPredicate,
  type RetrievalGrant,
} from './message-search.js';
import { prepareCached } from './util.js';

/**
 * A single direct-answer activity snapshot may expose at most this many rows.
 * The separate character cap in the agent tool keeps the rendered payload
 * inside the run's 60k retrieval budget. Two hundred rows intentionally cover
 * the current 165-message catch-up window without pagination.
 */
export const RECENT_ACTIVITY_SNAPSHOT_MAX_MESSAGES = 200;

export interface RecentActivitySnapshotInput {
  /** Inclusive, model-selected lower bound. */
  afterMs: number;
  /** Exclusive, host-bounded upper bound. */
  beforeMs: number;
  /** Optional exact channel subset; visibility still comes from the host grant. */
  channelIds?: readonly string[];
}

export interface RecentActivitySnapshotMessage {
  messageId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  parentChannelId: string | null;
  isThread: boolean;
  authorId: string | null;
  authorDisplayName: string;
  authorIsBot: boolean | null;
  createdAtMs: number;
  replyToMessageId: string | null;
  content: string;
}

export interface RecentActivitySnapshotRepositoryResult {
  totalMatching: number;
  matchingChannelCount: number;
  /** All channels contributing to host-authored aggregate coverage. */
  matchedChannelIds: string[];
  oldestMatchedAtMs: number | null;
  newestMatchedAtMs: number | null;
  /** At most {@link RECENT_ACTIVITY_SNAPSHOT_MAX_MESSAGES}, oldest first. */
  messages: RecentActivitySnapshotMessage[];
  /** True when SQL sampling was needed to enforce the hard message cap. */
  messageCapApplied: boolean;
}

interface ChannelAggregateRow {
  channel_id: SQLOutputValue;
  matching_count: SQLOutputValue;
  oldest_matched_at_ms: SQLOutputValue;
  newest_matched_at_ms: SQLOutputValue;
}

interface ChannelAllocation {
  channelId: string;
  matchingCount: number;
  quota: number;
}

function validateBounds(input: RecentActivitySnapshotInput): void {
  if (!Number.isSafeInteger(input.afterMs) || !Number.isSafeInteger(input.beforeMs)) {
    throw new Error('Activity snapshot bounds must be safe integer epoch milliseconds.');
  }
  if (input.afterMs >= input.beforeMs) {
    throw new Error('Activity snapshot "after" must be earlier than "before".');
  }
}

function buildWhere(
  grant: RetrievalGrant,
  input: RecentActivitySnapshotInput,
): { sql: string; params: SQLInputValue[]; cacheKey: string } {
  const scope = channelVisibilityPredicate(grant);
  const where = [
    'm.deleted_at_ms IS NULL',
    'm.created_at_ms >= ?',
    'm.created_at_ms < ?',
    // Defense in depth for Mneme-named control/test consoles. They are not
    // retrieval sources even if a stale or misconfigured row says ingest=true.
    "INSTR(LOWER(COALESCE(c.name, '')), 'mneme') = 0",
    // A normally named thread below a Mneme test console is part of that
    // same test surface. Keep parent-name isolation independent of policy state.
    `(c.is_thread = 0 OR NOT EXISTS (
      SELECT 1 FROM channels test_parent
       WHERE test_parent.id = c.parent_id
         AND INSTR(LOWER(COALESCE(test_parent.name, '')), 'mneme') > 0
    ))`,
    scope.sql,
  ];
  const params: SQLInputValue[] = [input.afterMs, input.beforeMs, ...scope.params];
  const requestedChannels = input.channelIds === undefined
    ? undefined
    : [...new Set(input.channelIds)];

  // An explicitly empty subset means no channels. The model schema disallows
  // it, but the repository remains fail-closed for non-model callers.
  if (requestedChannels !== undefined) {
    if (requestedChannels.length === 0) {
      where.push('1=0');
    } else {
      where.push(`m.channel_id IN (${requestedChannels.map(() => '?').join(',')})`);
      params.push(...requestedChannels);
    }
  }

  return {
    sql: where.join(' AND '),
    params,
    cacheKey: [
      scope.sql,
      requestedChannels === undefined ? 'all' : requestedChannels.length,
    ].join(':'),
  };
}

/**
 * Allocate `cap` slots by deterministic water filling. Every unsaturated
 * channel receives one row per round in channel-id order; capacity unused by a
 * small channel is redistributed to busier channels. When at least `cap` rows
 * exist the quotas therefore sum to exactly `cap`.
 */
function allocateChannelQuotas(
  channels: readonly Omit<ChannelAllocation, 'quota'>[],
  cap: number,
): ChannelAllocation[] {
  const allocations = channels.map((channel) => ({ ...channel, quota: 0 }));
  let remaining = cap;
  while (remaining > 0) {
    let progressed = false;
    for (const allocation of allocations) {
      if (allocation.quota >= allocation.matchingCount) continue;
      allocation.quota += 1;
      remaining -= 1;
      progressed = true;
      if (remaining === 0) break;
    }
    if (!progressed) break;
  }
  return allocations;
}

const MESSAGE_COLUMNS = `
  m.id AS message_id,
  m.guild_id,
  m.channel_id,
  c.name AS channel_name,
  c.parent_id AS parent_channel_id,
  c.is_thread,
  m.author_id,
  m.author_display_name,
  u.is_bot AS author_is_bot,
  m.created_at_ms,
  m.reply_to_message_id,
  m.content
`;

function mapMessage(row: Record<string, SQLOutputValue>): RecentActivitySnapshotMessage {
  const channelId = String(row.channel_id);
  return {
    messageId: String(row.message_id),
    guildId: String(row.guild_id),
    channelId,
    channelName: row.channel_name === null ? channelId : String(row.channel_name),
    parentChannelId: row.parent_channel_id === null ? null : String(row.parent_channel_id),
    isThread: Number(row.is_thread) === 1,
    authorId: row.author_id === null ? null : String(row.author_id),
    authorDisplayName: String(row.author_display_name),
    authorIsBot: row.author_is_bot === null ? null : Number(row.author_is_bot) === 1,
    createdAtMs: Number(row.created_at_ms),
    replyToMessageId:
      row.reply_to_message_id === null ? null : String(row.reply_to_message_id),
    content: String(row.content),
  };
}

/**
 * Return one exact, visibility-scoped activity window for a direct answer.
 *
 * The interval is always `[afterMs, beforeMs)`. When more than 200 permitted
 * rows match, SQL gives each matching channel an equal deterministic quota
 * (totalling 200) and chooses the row nearest the centre of each chronological
 * bucket. This preserves both cross-channel and across-window coverage instead
 * of returning only the newest busy-channel rows.
 */
export function getRecentActivitySnapshot(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: RecentActivitySnapshotInput,
): RecentActivitySnapshotRepositoryResult {
  validateBounds(input);
  const filter = buildWhere(grant, input);

  const channelAggregates = prepareCached(
    db,
    `messages.activity.channel-aggregates:${filter.cacheKey}`,
    `
    SELECT m.channel_id,
           COUNT(*) AS matching_count,
           MIN(m.created_at_ms) AS oldest_matched_at_ms,
           MAX(m.created_at_ms) AS newest_matched_at_ms
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
     WHERE ${filter.sql}
     GROUP BY m.channel_id
     ORDER BY m.channel_id ASC
  `).all(...filter.params) as unknown as ChannelAggregateRow[];

  const channelCounts = channelAggregates.map((row) => ({
    channelId: String(row.channel_id),
    matchingCount: Number(row.matching_count),
  }));
  const totalMatching = channelCounts.reduce((total, channel) => total + channel.matchingCount, 0);
  const matchingChannelCount = channelCounts.length;
  const matchedChannelIds = channelCounts.map((channel) => channel.channelId);
  const oldestMatchedAtMs = channelAggregates.length === 0
    ? null
    : Math.min(...channelAggregates.map((row) => Number(row.oldest_matched_at_ms)));
  const newestMatchedAtMs = channelAggregates.length === 0
    ? null
    : Math.max(...channelAggregates.map((row) => Number(row.newest_matched_at_ms)));

  if (totalMatching === 0) {
    return {
      totalMatching,
      matchingChannelCount,
      matchedChannelIds,
      oldestMatchedAtMs,
      newestMatchedAtMs,
      messages: [],
      messageCapApplied: false,
    };
  }

  let rows: Record<string, SQLOutputValue>[];
  if (totalMatching <= RECENT_ACTIVITY_SNAPSHOT_MAX_MESSAGES) {
    rows = prepareCached(db, `messages.activity.complete:${filter.cacheKey}`, `
      SELECT ${MESSAGE_COLUMNS}
        FROM messages m
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN users u ON u.id = m.author_id
       WHERE ${filter.sql}
       ORDER BY m.created_at_ms ASC, m.id ASC
    `).all(...filter.params) as Record<string, SQLOutputValue>[];
  } else {
    const allocations = allocateChannelQuotas(
      channelCounts,
      RECENT_ACTIVITY_SNAPSHOT_MAX_MESSAGES,
    );
    const quotaValues = allocations
      .filter((allocation) => allocation.quota > 0)
      .map(() => '(?, ?)')
      .join(', ');
    const quotaParams: SQLInputValue[] = allocations
      .filter((allocation) => allocation.quota > 0)
      .flatMap((allocation) => [allocation.channelId, allocation.quota]);

    rows = prepareCached(
      db,
      `messages.activity.sampled:${filter.cacheKey}:${allocations.length}`,
      `
      WITH channel_quotas(channel_id, channel_quota) AS (
        VALUES ${quotaValues}
      ), scoped AS (
        SELECT ${MESSAGE_COLUMNS},
               cq.channel_quota,
               ROW_NUMBER() OVER (
                 PARTITION BY m.channel_id
                 ORDER BY m.created_at_ms ASC, m.id ASC
               ) AS channel_row_number,
               COUNT(*) OVER (PARTITION BY m.channel_id) AS channel_total
          FROM messages m
          JOIN channels c ON c.id = m.channel_id
          JOIN channel_quotas cq ON cq.channel_id = m.channel_id
          LEFT JOIN users u ON u.id = m.author_id
         WHERE ${filter.sql}
      ), bucketed AS (
        SELECT *,
               CAST(
                 ((channel_row_number - 1) * channel_quota) / channel_total
                 AS INTEGER
               ) AS time_bucket
          FROM scoped
      ), ranked AS (
        SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY channel_id, time_bucket
                 ORDER BY
                   ABS(
                     ((1.0 * channel_row_number - 0.5) / channel_total)
                     - ((1.0 * time_bucket + 0.5) / channel_quota)
                   ) ASC,
                   created_at_ms ASC,
                   message_id ASC
               ) AS bucket_rank
          FROM bucketed
      )
      SELECT message_id, guild_id, channel_id, channel_name, parent_channel_id,
             is_thread, author_id, author_display_name, author_is_bot,
             created_at_ms, reply_to_message_id, content
        FROM ranked
       WHERE bucket_rank = 1
       ORDER BY created_at_ms ASC, message_id ASC
    `).all(...quotaParams, ...filter.params) as Record<string, SQLOutputValue>[];
  }

  return {
    totalMatching,
    matchingChannelCount,
    matchedChannelIds,
    oldestMatchedAtMs,
    newestMatchedAtMs,
    messages: rows.map(mapMessage),
    messageCapApplied: totalMatching > rows.length,
  };
}
