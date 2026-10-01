import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from '../../db/database.js';
import { transactionImmediate } from '../../db/database.js';
import { defaultIsIgnoredCommand, reviewEpisodeJobKey } from '../../episodes/builder.js';
import { enqueue } from '../queue.js';
import { DeferJobError } from '../errors.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';
import type { Logger } from '../../logger.js';
import { isMnemeTestSurface } from '../../ingestion/test-channels.js';
import { markSkipped } from '../../episodes/repository.js';

const LOW_PRIORITY = 200;

interface CursorRow {
  channel_id: string;
  cutoff_at_ms: number;
  last_created_at_ms: number | null;
  last_message_id: string | null;
}

interface CandidateRow {
  id: string;
  created_at_ms: number;
  content: string;
}

export interface HistoricalEpisodeConfig {
  /** Empty means all eligible org channels. */
  channelIds?: readonly string[];
  batchMessages: number;
  maxPendingReviews: number;
  quietSeconds: number;
  maxMessages: number;
  maxMinutes: number;
  campaign?: {
    id: string;
    fromAtMs: number;
    toAtMs: number;
  };
}

export interface HistoricalBatchResult {
  channelId: string | null;
  messagesScanned: number;
  episodesCreated: number;
  moreWork: boolean;
  throttled: boolean;
}

/** Add cursors only for fully backfilled, currently-org channels. */
function channelFilter(column: string, channelIds: readonly string[] | undefined): { sql: string; params: string[] } {
  const ids = [...new Set(channelIds ?? [])];
  return ids.length === 0
    ? { sql: '', params: [] }
    : { sql: `AND ${column} IN (${ids.map(() => '?').join(', ')})`, params: ids };
}

export function ensureHistoricalCursors(
  db: DatabaseSync,
  now: number,
  channelIds: readonly string[] = [],
): number {
  const filter = channelFilter('c.id', channelIds);
  const eligible = db.prepare(`
    SELECT c.id
      FROM channels c
      JOIN sync_cursors sc ON sc.channel_id = c.id
     WHERE c.deleted_at_ms IS NULL
       AND c.ingest_enabled = 1
       AND c.visibility_class = 'org'
       AND sc.history_complete = 1
       ${filter.sql}
  `).all(...filter.params) as Array<{ id: string }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO historical_episode_cursors
      (channel_id, cutoff_at_ms, state, updated_at_ms)
    VALUES (?, ?, 'pending', ?)
  `);
  const persist = () => eligible.reduce(
    (changes, channel) => isMnemeTestSurface(db, channel.id)
      ? changes
      : changes + Number(insert.run(channel.id, now, now).changes),
    0,
  );
  return db.isTransaction ? persist() : transactionImmediate(db, persist);
}

interface PendingEpisodeRow {
  id: string;
  conversation_channel_id: string;
  status: 'queued' | 'reviewing';
}

function countCurrentPendingReviews(
  db: DatabaseSync,
  rows: readonly PendingEpisodeRow[],
  now: number,
): number {
  let pending = 0;
  for (const row of rows) {
    if (!isMnemeTestSurface(db, row.conversation_channel_id)) {
      pending += 1;
      continue;
    }
    // A reviewing row may already have provider work in flight; its handler
    // performs a second current-surface gate before applying the result. A
    // merely queued row is safe to close locally now so it cannot throttle the
    // campaign or remain as misleading pending work.
    if (row.status === 'reviewing') pending += 1;
    else markSkipped(db, row.id, now);
  }
  return pending;
}

function pendingHistoricalReviews(
  db: DatabaseSync,
  channelIds: readonly string[] | undefined,
  now: number,
): number {
  const filter = channelFilter('conversation_channel_id', channelIds);
  const rows = db.prepare(`
    SELECT id,conversation_channel_id,status FROM episodes
     WHERE origin = 'historical' AND status IN ('queued', 'reviewing')
       ${filter.sql}
  `).all(...filter.params) as unknown as PendingEpisodeRow[];
  return countCurrentPendingReviews(db, rows, now);
}

function pendingCampaignReviews(db: DatabaseSync, campaignId: string, now: number): number {
  const rows = db.prepare(`SELECT id,conversation_channel_id,status FROM episodes
    WHERE historical_campaign_id=? AND status IN ('queued','reviewing')`)
    .all(campaignId) as unknown as PendingEpisodeRow[];
  return countCurrentPendingReviews(db, rows, now);
}

function nextCursor(
  db: DatabaseSync,
  channelIds: readonly string[] | undefined,
  now: number,
): CursorRow | undefined {
  const filter = channelFilter('hc.channel_id', channelIds);
  const candidates = db.prepare(`
    SELECT hc.channel_id, hc.cutoff_at_ms, hc.last_created_at_ms, hc.last_message_id
      FROM historical_episode_cursors hc
      JOIN channels c ON c.id = hc.channel_id
     WHERE hc.state = 'pending'
       AND c.deleted_at_ms IS NULL
       AND c.ingest_enabled = 1
       AND c.visibility_class = 'org'
       ${filter.sql}
     ORDER BY hc.updated_at_ms ASC, hc.channel_id ASC
  `).all(...filter.params) as unknown as CursorRow[];
  for (const cursor of candidates) {
    if (!isMnemeTestSurface(db, cursor.channel_id)) return cursor;
    db.prepare(`UPDATE historical_episode_cursors SET state='complete',updated_at_ms=?
      WHERE channel_id=? AND state='pending'`).run(now, cursor.channel_id);
  }
  return undefined;
}

function candidates(db: DatabaseSync, cursor: CursorRow, limit: number): CandidateRow[] {
  return db.prepare(`
    SELECT m.id, m.created_at_ms, m.content
      FROM messages m
      JOIN users u ON u.id = m.author_id
     WHERE m.channel_id = ?
       AND m.deleted_at_ms IS NULL
       AND u.is_bot = 0
       AND m.created_at_ms <= ?
       AND (? IS NULL OR m.created_at_ms > ?
            OR (m.created_at_ms = ? AND m.id > ?))
       AND NOT EXISTS (SELECT 1 FROM episode_messages em WHERE em.message_id = m.id)
     ORDER BY m.created_at_ms ASC, m.id ASC
     LIMIT ?
  `).all(
    cursor.channel_id,
    cursor.cutoff_at_ms,
    cursor.last_created_at_ms,
    cursor.last_created_at_ms,
    cursor.last_created_at_ms,
    cursor.last_message_id,
    limit,
  ) as unknown as CandidateRow[];
}

function substantive(row: CandidateRow): boolean {
  const content = row.content.trim();
  return content.length > 0 && !defaultIsIgnoredCommand(content);
}

function splitEpisodes(rows: CandidateRow[], config: HistoricalEpisodeConfig): CandidateRow[][] {
  const groups: CandidateRow[][] = [];
  let current: CandidateRow[] = [];
  const quietMs = config.quietSeconds * 1000;
  const maxDurationMs = config.maxMinutes * 60_000;

  for (const row of rows) {
    if (!substantive(row)) continue;
    const first = current[0];
    const last = current[current.length - 1];
    const boundary = Boolean(
      last && first && (
        row.created_at_ms - last.created_at_ms >= quietMs
        || current.length >= config.maxMessages
        || row.created_at_ms - first.created_at_ms >= maxDurationMs
      )
    );
    if (boundary) {
      groups.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function insertEpisode(
  db: DatabaseSync,
  guildId: string,
  channelId: string,
  rows: CandidateRow[],
  now: number,
  campaignId?: string,
): string {
  const id = randomUUID();
  const started = rows[0]!.created_at_ms;
  const ended = rows[rows.length - 1]!.created_at_ms;
  db.prepare(`
    INSERT INTO episodes
      (id, workspace_id, conversation_channel_id, status, started_at_ms, ended_at_ms,
       last_activity_at_ms, human_message_count, total_message_count, trigger_reason,
       created_at_ms, updated_at_ms, origin, historical_campaign_id)
    VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, 'historical_backfill', ?, ?, 'historical', ?)
  `).run(id, guildId, channelId, started, ended, ended, rows.length, rows.length, now, now, campaignId ?? null);
  const link = db.prepare('INSERT INTO episode_messages (episode_id, message_id, ordinal) VALUES (?, ?, ?)');
  rows.forEach((row, index) => link.run(id, row.id, index + 1));
  return id;
}

interface CampaignCursorRow {
  channel_id: string;
  upper_created_at_ms: number | null;
  upper_message_id: string | null;
}

function ensureCampaignCursors(db: DatabaseSync, config: HistoricalEpisodeConfig, now: number): number {
  const campaign = config.campaign!;
  const filter = channelFilter('c.id', config.channelIds);
  const eligible = db.prepare(`
    SELECT c.id
      FROM channels c JOIN sync_cursors sc ON sc.channel_id=c.id
     WHERE c.deleted_at_ms IS NULL AND c.ingest_enabled=1 AND c.visibility_class='org'
       AND sc.history_complete=1
       ${filter.sql}
  `).all(...filter.params) as Array<{ id: string }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO historical_campaign_cursors
      (campaign_id,channel_id,state,updated_at_ms)
    VALUES (?,?,'pending',?)
  `);
  const persist = () => eligible.reduce(
    (changes, channel) => isMnemeTestSurface(db, channel.id)
      ? changes
      : changes + Number(insert.run(campaign.id, channel.id, now).changes),
    0,
  );
  return db.isTransaction ? persist() : transactionImmediate(db, persist);
}

function nextCampaignCursor(
  db: DatabaseSync,
  campaignId: string,
  now: number,
): CampaignCursorRow | undefined {
  const candidates = db.prepare(`
    SELECT cc.channel_id,cc.upper_created_at_ms,cc.upper_message_id
      FROM historical_campaign_cursors cc
      JOIN channels c ON c.id=cc.channel_id
     WHERE cc.campaign_id=? AND cc.state='pending'
       AND c.deleted_at_ms IS NULL AND c.ingest_enabled=1 AND c.visibility_class='org'
     ORDER BY cc.updated_at_ms ASC,cc.channel_id ASC
  `).all(campaignId) as unknown as CampaignCursorRow[];
  for (const cursor of candidates) {
    if (!isMnemeTestSurface(db, cursor.channel_id)) return cursor;
    db.prepare(`UPDATE historical_campaign_cursors SET state='complete',updated_at_ms=?
      WHERE campaign_id=? AND channel_id=? AND state='pending'`)
      .run(now, campaignId, cursor.channel_id);
  }
  return undefined;
}

function campaignCandidates(
  db: DatabaseSync,
  cursor: CampaignCursorRow,
  config: HistoricalEpisodeConfig,
): CandidateRow[] {
  const campaign = config.campaign!;
  return db.prepare(`
    SELECT m.id,m.created_at_ms,m.content
      FROM messages m JOIN users u ON u.id=m.author_id
     WHERE m.channel_id=? AND m.deleted_at_ms IS NULL AND u.is_bot=0
       AND m.created_at_ms>=? AND m.created_at_ms<=?
       AND (? IS NULL OR m.created_at_ms<?
            OR (m.created_at_ms=? AND m.id<?))
       AND NOT EXISTS (
         SELECT 1 FROM episode_messages em JOIN episodes e ON e.id=em.episode_id
          WHERE em.message_id=m.id
            AND (e.historical_campaign_id=? OR e.status IN ('reviewed','skipped','error'))
       )
     ORDER BY m.created_at_ms DESC,m.id DESC LIMIT ?
  `).all(
    cursor.channel_id,
    campaign.fromAtMs,
    campaign.toAtMs,
    cursor.upper_created_at_ms,
    cursor.upper_created_at_ms,
    cursor.upper_created_at_ms,
    cursor.upper_message_id,
    campaign.id,
    config.batchMessages,
  ) as unknown as CandidateRow[];
}

function processHistoricalCampaignBatch(
  db: DatabaseSync,
  guildId: string,
  config: HistoricalEpisodeConfig,
  now: number,
): HistoricalBatchResult {
  const campaign = config.campaign!;
  ensureCampaignCursors(db, config, now);
  const pendingReviews = pendingCampaignReviews(db, campaign.id, now);
  const campaignState = db.prepare('SELECT status FROM historical_memory_campaigns WHERE id=?')
    .get(campaign.id) as { status: string } | undefined;
  if (!campaignState || campaignState.status !== 'running') {
    return { channelId: null, messagesScanned: 0, episodesCreated: 0, moreWork: false, throttled: true };
  }
  if (pendingReviews >= config.maxPendingReviews) {
    return { channelId: null, messagesScanned: 0, episodesCreated: 0, moreWork: true, throttled: true };
  }
  const cursor = nextCampaignCursor(db, campaign.id, now);
  if (!cursor) {
    db.prepare(`UPDATE historical_memory_campaigns SET status='completed',completed_at_ms=?,updated_at_ms=?
      WHERE id=? AND status='running'`).run(now, now, campaign.id);
    return { channelId: null, messagesScanned: 0, episodesCreated: 0, moreWork: false, throttled: false };
  }
  const rowsDescending = campaignCandidates(db, cursor, config);
  if (rowsDescending.length === 0) {
    db.prepare(`UPDATE historical_campaign_cursors SET state='complete',updated_at_ms=?
      WHERE campaign_id=? AND channel_id=?`).run(now, campaign.id, cursor.channel_id);
    return { channelId: cursor.channel_id, messagesScanned: 0, episodesCreated: 0, moreWork: true, throttled: false };
  }

  const capacity = Math.max(1, config.maxPendingReviews - pendingReviews);
  const chronological = [...rowsDescending].reverse();
  const groupsNewestFirst = splitEpisodes(chronological, config).reverse();
  const groups = groupsNewestFirst.slice(0, capacity);
  let lastIndex = rowsDescending.length - 1;
  if (groupsNewestFirst.length > capacity) {
    const selectedIds = new Set(groups.flatMap((group) => group.map((row) => row.id)));
    lastIndex = rowsDescending.reduce((max, row, index) => selectedIds.has(row.id) ? Math.max(max, index) : max, 0);
  }
  const consumed = rowsDescending.slice(0, lastIndex + 1);
  const last = consumed[consumed.length - 1]!;
  const episodeIds: string[] = [];
  transactionImmediate(db, () => {
    for (const group of groups) episodeIds.push(insertEpisode(db, guildId, cursor.channel_id, group, now, campaign.id));
    db.prepare(`UPDATE historical_campaign_cursors
      SET upper_created_at_ms=?,upper_message_id=?,messages_scanned=messages_scanned+?,
          episodes_created=episodes_created+?,updated_at_ms=?
      WHERE campaign_id=? AND channel_id=?`)
      .run(last.created_at_ms, last.id, consumed.length, episodeIds.length, now, campaign.id, cursor.channel_id);
  });
  for (const episodeId of episodeIds) {
    enqueue(db, { type: 'review_episode', payload: { episodeId }, uniqueKey: reviewEpisodeJobKey(episodeId), priority: LOW_PRIORITY, now });
  }
  return { channelId: cursor.channel_id, messagesScanned: consumed.length,
    episodesCreated: episodeIds.length, moreWork: true, throttled: false };
}

export function processHistoricalBatch(
  db: DatabaseSync,
  guildId: string,
  config: HistoricalEpisodeConfig,
  now: number,
): HistoricalBatchResult {
  if (config.campaign) return processHistoricalCampaignBatch(db, guildId, config, now);
  ensureHistoricalCursors(db, now, config.channelIds);
  const pendingReviews = pendingHistoricalReviews(db, config.channelIds, now);
  if (pendingReviews >= config.maxPendingReviews) {
    return { channelId: null, messagesScanned: 0, episodesCreated: 0, moreWork: true, throttled: true };
  }
  const cursor = nextCursor(db, config.channelIds, now);
  if (!cursor) return { channelId: null, messagesScanned: 0, episodesCreated: 0, moreWork: false, throttled: false };

  const rows = candidates(db, cursor, config.batchMessages);
  if (rows.length === 0) {
    db.prepare("UPDATE historical_episode_cursors SET state='complete', updated_at_ms=? WHERE channel_id=?")
      .run(now, cursor.channel_id);
    return { channelId: cursor.channel_id, messagesScanned: 0, episodesCreated: 0, moreWork: true, throttled: false };
  }

  const capacity = Math.max(1, config.maxPendingReviews - pendingReviews);
  const allGroups = splitEpisodes(rows, config);
  const groups = allGroups.slice(0, capacity);
  let lastIndex = rows.length - 1;
  if (allGroups.length > capacity) {
    const firstDeferredId = allGroups[capacity]![0]!.id;
    lastIndex = Math.max(0, rows.findIndex((r) => r.id === firstDeferredId) - 1);
  }
  const consumed = rows.slice(0, lastIndex + 1);
  const last = consumed[consumed.length - 1]!;
  const episodeIds: string[] = [];

  transactionImmediate(db, () => {
    for (const group of groups) episodeIds.push(insertEpisode(db, guildId, cursor.channel_id, group, now));
    db.prepare(`
      UPDATE historical_episode_cursors
         SET last_created_at_ms=?, last_message_id=?,
             messages_scanned=messages_scanned+?, episodes_created=episodes_created+?, updated_at_ms=?
       WHERE channel_id=?
    `).run(last.created_at_ms, last.id, consumed.length, episodeIds.length, now, cursor.channel_id);
  });

  // Queuing is intentionally outside the episode transaction. Startup repair
  // restores any queued episode if the process stops between these steps.
  for (const episodeId of episodeIds) {
    enqueue(db, { type: 'review_episode', payload: { episodeId }, uniqueKey: reviewEpisodeJobKey(episodeId), priority: LOW_PRIORITY, now });
  }

  return {
    channelId: cursor.channel_id,
    messagesScanned: consumed.length,
    episodesCreated: episodeIds.length,
    moreWork: true,
    throttled: false,
  };
}

export function createBuildHistoricalEpisodesHandler(deps: {
  db: DatabaseSync;
  guildId: string;
  config: HistoricalEpisodeConfig;
  now?: () => number;
  logger?: Pick<Logger, 'info'>;
}): JobHandler<'build_historical_episodes'> & { runBatch(): HistoricalBatchResult } {
  const runBatch = () => processHistoricalBatch(deps.db, deps.guildId, deps.config, deps.now?.() ?? Date.now());
  const handler = async (_payload: Record<string, never>, _job: JobRow): Promise<void> => {
    const result = runBatch();
    deps.logger?.info({ event: 'historical_memory.batch', ...result }, 'historical memory batch processed');
    if (result.moreWork) throw new DeferJobError('historical memory continuation', result.throttled ? 60_000 : 1_000);
  };
  return Object.assign(handler, { runBatch });
}
