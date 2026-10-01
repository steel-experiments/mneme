import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { ensureHistoricalCampaign } from '../../src/historical/campaign.js';
import { handleHistoricalCommand } from '../../src/discord/commands/historical.js';

const NOW = 1_700_100_000_000;
let env: TestDb;
let db: DatabaseSync;
let guildId: string;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  guildId = seedIdentity(db).guildId;
  ensureHistoricalCampaign(db, {
    id: 'trial', guildId, direction: 'newest_first', fromAtMs: NOW - 100_000, toAtMs: NOW,
    provider: 'openai', model: 'gpt-5.6-luna', thinkingLevel: 'medium', channelIds: [],
    dailyBudgetUsd: 10, totalBudgetUsd: 2,
  }, NOW);
});
afterEach(() => env.cleanup());

const input = { actorUserId: '100000000000000003', memberRoleIds: ['admin'], subcommand: 'status' as const };
const deps = () => ({ db, adminRoleIds: ['admin'], nowMs: NOW, campaignId: 'trial' });

describe('bounded historical campaign commands', () => {
  it('pauses and resumes only the configured campaign durably', () => {
    const paused = handleHistoricalCommand({ ...input, guildId, subcommand: 'pause' }, deps());
    expect(paused).toMatchObject({ kind: 'done', changed: true, campaign: { status: 'paused' } });
    const resumed = handleHistoricalCommand({ ...input, guildId, subcommand: 'resume' }, deps());
    expect(resumed).toMatchObject({ kind: 'done', changed: true, campaign: { status: 'running' } });
    expect(db.prepare("SELECT count(*) n FROM jobs WHERE type='build_historical_episodes' AND status='queued'").get())
      .toEqual({ n: 1 });
  });

  it('fails closed for callers without the admin role', () => {
    const result = handleHistoricalCommand({ ...input, guildId, memberRoleIds: [], subcommand: 'pause' }, deps());
    expect(result.kind).toBe('not_authorized');
    expect(db.prepare('SELECT status FROM historical_memory_campaigns WHERE id=?').get('trial'))
      .toEqual({ status: 'running' });
  });

  it('will not resume when the hard total budget has been reached', () => {
    db.prepare("UPDATE historical_memory_campaigns SET status='budget_exhausted' WHERE id='trial'").run();
    db.prepare(`INSERT INTO episodes
      (id,workspace_id,conversation_channel_id,status,started_at_ms,ended_at_ms,last_activity_at_ms,
       human_message_count,total_message_count,created_at_ms,updated_at_ms,origin,historical_campaign_id)
      SELECT 'ep',workspace_id,id,'reviewed',?,?,?,1,1,?,?,'historical','trial' FROM channels LIMIT 1`)
      .run(NOW - 1, NOW - 1, NOW - 1, NOW, NOW);
    db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,episode_id,run_type,prompt_version,provider,model,status,started_at_ms,cost_usd)
      VALUES ('run',?,'ep','episode','v','openai','gpt-5.6-luna','completed',?,2)`)
      .run(guildId, NOW);
    const result = handleHistoricalCommand({ ...input, guildId, subcommand: 'resume' }, deps());
    expect(result).toMatchObject({ kind: 'done', changed: false, campaign: { status: 'budget_exhausted' } });
  });
});
