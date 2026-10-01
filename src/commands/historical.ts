import type { DatabaseSync } from '../db/database.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import { enqueue } from '../jobs/queue.js';
import {
  getHistoricalCampaign,
  historicalCampaignSpend,
  setHistoricalCampaignStatus,
  type HistoricalCampaignRow,
} from '../historical/campaign.js';
import { authorizeAdmin, type AuthorizationReason } from '../policy/authorization.js';

export type HistoricalSubcommand = 'status' | 'pause' | 'resume';

export interface HistoricalCommandInput {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  subcommand: HistoricalSubcommand;
}

export interface HistoricalCommandDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  campaignId: string | undefined;
}

export type HistoricalCommandOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'not_configured' }
  | { kind: 'done'; campaign: HistoricalCampaignRow; spendUsd: number; changed: boolean; message?: string };

export function handleHistoricalCommand(
  input: HistoricalCommandInput,
  deps: HistoricalCommandDeps,
): HistoricalCommandOutcome {
  const auth = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!auth.authorized) {
    recordAdminEvent(deps.db, { guildId: input.guildId, actorUserId: input.actorUserId,
      action: `historical_${input.subcommand}`, details: { authorized: false, reason: auth.reason }, createdAtMs: deps.nowMs });
    return { kind: 'not_authorized', reason: auth.reason };
  }
  if (!deps.campaignId) return { kind: 'not_configured' };
  let campaign = getHistoricalCampaign(deps.db, deps.campaignId);
  if (!campaign) return { kind: 'not_configured' };
  const spendUsd = historicalCampaignSpend(deps.db, campaign.id);
  let changed = false;
  let message: string | undefined;
  if (input.subcommand === 'pause' && campaign.status === 'running') {
    changed = setHistoricalCampaignStatus(deps.db, campaign.id, 'paused', deps.nowMs);
  } else if (input.subcommand === 'resume') {
    if (campaign.status === 'completed') message = 'A completed campaign cannot be resumed.';
    else if (spendUsd >= campaign.total_budget_usd) message = 'Raise the persisted total budget before resuming.';
    else if (campaign.status !== 'running') {
      changed = setHistoricalCampaignStatus(deps.db, campaign.id, 'running', deps.nowMs);
      enqueue(deps.db, { type: 'build_historical_episodes', payload: {},
        uniqueKey: 'schedule:historical-memory', priority: 200, now: deps.nowMs });
    }
  }
  campaign = getHistoricalCampaign(deps.db, campaign.id)!;
  recordAdminEvent(deps.db, { guildId: input.guildId, actorUserId: input.actorUserId,
    action: `historical_${input.subcommand}`, target: campaign.id,
    details: { authorized: true, changed, status: campaign.status }, createdAtMs: deps.nowMs });
  return { kind: 'done', campaign, spendUsd, changed, message };
}

export function formatHistoricalReply(outcome: HistoricalCommandOutcome): string {
  if (outcome.kind === 'not_authorized') return 'You are not authorized to control historical processing.';
  if (outcome.kind === 'not_configured') return 'No bounded historical campaign is configured.';
  const c = outcome.campaign;
  const header = `historical campaign ${c.id}: ${c.status}`;
  if (outcome.message) return `${header}\n${outcome.message}`;
  return [
    header,
    `window: ${new Date(c.from_at_ms).toISOString()} → ${new Date(c.to_at_ms).toISOString()}`,
    `order: newest → oldest`,
    `model: ${c.model}, reasoning=${c.thinking_level}`,
    `spend: $${outcome.spendUsd.toFixed(2)}/$${c.total_budget_usd.toFixed(2)}, daily cap=$${c.daily_budget_usd.toFixed(2)}`,
  ].join('\n');
}
