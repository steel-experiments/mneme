import type { DatabaseSync } from '../db/database.js';
import { transactionImmediate } from '../db/database.js';
import { isMnemeTestSurface } from '../discord/test-channels.js';

export type HistoricalCampaignStatus = 'running' | 'paused' | 'completed' | 'budget_exhausted';

export interface HistoricalCampaignDefinition {
  id: string;
  guildId: string;
  direction: 'newest_first';
  fromAtMs: number;
  toAtMs: number;
  provider: string;
  model: string;
  thinkingLevel: string;
  channelIds: readonly string[];
  dailyBudgetUsd: number;
  totalBudgetUsd: number;
}

export interface HistoricalCampaignRow {
  id: string;
  guild_id: string;
  status: HistoricalCampaignStatus;
  direction: 'newest_first';
  from_at_ms: number;
  to_at_ms: number;
  provider: string;
  model: string;
  thinking_level: string;
  channel_ids_json: string;
  daily_budget_usd: number;
  total_budget_usd: number;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
}

function canonicalChannels(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Create the configured campaign once, then validate its immutable identity on
 * every restart. Budgets are deliberately mutable so an evaluated $2 trial can
 * be raised without replacing cursors or losing attribution.
 */
export function ensureHistoricalCampaign(
  db: DatabaseSync,
  definition: HistoricalCampaignDefinition,
  now: number,
): HistoricalCampaignRow {
  const channelsJson = JSON.stringify(canonicalChannels(definition.channelIds));
  transactionImmediate(db, () => {
    db.prepare(`
      INSERT OR IGNORE INTO historical_memory_campaigns
        (id,guild_id,status,direction,from_at_ms,to_at_ms,provider,model,thinking_level,
         channel_ids_json,daily_budget_usd,total_budget_usd,created_at_ms,updated_at_ms)
      VALUES (?,?,'running',?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      definition.id,
      definition.guildId,
      definition.direction,
      definition.fromAtMs,
      definition.toAtMs,
      definition.provider,
      definition.model,
      definition.thinkingLevel,
      channelsJson,
      definition.dailyBudgetUsd,
      definition.totalBudgetUsd,
      now,
      now,
    );
    const row = getHistoricalCampaign(db, definition.id);
    if (!row) throw new Error(`historical campaign ${definition.id} was not created`);
    const immutableMatches = row.guild_id === definition.guildId
      && row.direction === definition.direction
      && row.from_at_ms === definition.fromAtMs
      && row.to_at_ms === definition.toAtMs
      && row.provider === definition.provider
      && row.model === definition.model
      && row.thinking_level === definition.thinkingLevel
      && row.channel_ids_json === channelsJson;
    if (!immutableMatches) {
      throw new Error(`historical campaign ${definition.id} does not match its persisted immutable definition`);
    }
    db.prepare(`UPDATE historical_memory_campaigns
      SET daily_budget_usd=?, total_budget_usd=?, updated_at_ms=? WHERE id=?`)
      .run(definition.dailyBudgetUsd, definition.totalBudgetUsd, now, definition.id);
  });
  return getHistoricalCampaign(db, definition.id)!;
}

export function getHistoricalCampaign(db: DatabaseSync, id: string): HistoricalCampaignRow | undefined {
  return db.prepare('SELECT * FROM historical_memory_campaigns WHERE id=?').get(id) as
    | HistoricalCampaignRow
    | undefined;
}

export function setHistoricalCampaignStatus(
  db: DatabaseSync,
  id: string,
  status: HistoricalCampaignStatus,
  now: number,
): boolean {
  const completedAt = status === 'completed' ? now : null;
  return Number(db.prepare(`UPDATE historical_memory_campaigns
    SET status=?, updated_at_ms=?, completed_at_ms=? WHERE id=?`)
    .run(status, now, completedAt, id).changes) > 0;
}

export function historicalCampaignSpend(db: DatabaseSync, campaignId: string, sinceMs?: number): number {
  const since = sinceMs === undefined ? '' : 'AND ar.started_at_ms >= ?';
  const params = sinceMs === undefined ? [campaignId] : [campaignId, sinceMs];
  const row = db.prepare(`
    SELECT COALESCE(SUM(ar.cost_usd),0) AS total
      FROM agent_runs ar
      JOIN episodes e ON e.id=ar.episode_id
     WHERE e.historical_campaign_id=? AND ar.cost_usd IS NOT NULL ${since}
  `).get(...params) as { total: number };
  return Number(row.total);
}

export function historicalCampaignRunCount(db: DatabaseSync, campaignId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM agent_runs ar
    JOIN episodes e ON e.id=ar.episode_id WHERE e.historical_campaign_id=?`)
    .get(campaignId) as { n: number };
  return Number(row.n);
}

/**
 * Wake queued reviews belonging to one running campaign after an operator raises
 * its budget and redeploys. Budget deferrals deliberately preserve attempts but
 * may set `run_after_ms` to the next org day; without this bounded reset, a
 * higher cap would appear ineffective until that old deadline elapsed.
 */
export function wakeHistoricalCampaignReviews(
  db: DatabaseSync,
  campaignId: string,
  now: number,
): number {
  const candidates = db.prepare(`
    SELECT jobs.id,e.conversation_channel_id
      FROM jobs
      JOIN episodes e ON e.id=json_extract(jobs.payload_json,'$.episodeId')
     WHERE jobs.type='review_episode' AND jobs.status='queued' AND jobs.run_after_ms>?
       AND e.historical_campaign_id=?
  `).all(now, campaignId) as Array<{ id: string; conversation_channel_id: string }>;
  const wake = db.prepare(`
    UPDATE jobs SET run_after_ms=?, updated_at_ms=?
     WHERE id=? AND type='review_episode' AND status='queued' AND run_after_ms>?
  `);
  const persist = () => candidates.reduce(
    (changes, candidate) => isMnemeTestSurface(db, candidate.conversation_channel_id)
      ? changes
      : changes + Number(wake.run(now, now, candidate.id, now).changes),
    0,
  );
  return db.isTransaction ? persist() : transactionImmediate(db, persist);
}
