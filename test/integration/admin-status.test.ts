import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  handleStatusCommand,
  collectStatusReport,
  formatStatusReply,
  STATUS_REPLY_MAX_LENGTH,
  type StatusRuntimeInputs,
} from '../../src/discord/commands/status.js';
import {
  handleChannelsCommand,
  collectChannelsReport,
  formatChannelsReply,
} from '../../src/discord/commands/channels.js';
import { recordAccessAudit } from '../../src/db/repositories/channel-access.js';
import { countAdminEvents } from '../../src/db/repositories/admin-events.js';
import { APP_VERSION } from '../../src/version.js';
import { listPendingProposals } from '../../src/db/repositories/proposals.js';

/**
 * `/mneme status` and `/mneme channels` (Sections 27, 33).
 *
 * Acceptance: commands respond quickly, expose all specified operational fields,
 * and contain no raw messages, prompts, or tokens. Every field is a count, state,
 * size, or timestamp.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded restricted channel
const ADMIN_ROLE = '900000000000000001';
const NOW = 1_700_000_001_000;

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
  // One agent run backing proposal FKs.
  db.prepare(
    `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
     VALUES (?,?,NULL,'episode','pv','faux','faux-1','completed',?)`,
  ).run('run-1', GUILD, NOW);
});
afterEach(() => env.cleanup());

const RUNTIME: StatusRuntimeInputs = {
  nowMs: NOW,
  build: {
    appVersion: APP_VERSION,
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    railwayDeploymentId: '00000000-0000-4000-8000-000000000001',
    buildId: null,
  },
  mode: 'review',
  gateway: { connected: true, ready: true, lastEventAtMs: NOW, reconnectCount: 0 },
  model: {
    healthy: true,
    lastCallAtMs: NOW,
    dailyBudgetUsd: 5,
    today: { costUsd: 0.43, inputTokens: 812_000, outputTokens: 96_000 },
    allTime: { costUsd: 12.3, inputTokens: 24_100_000, outputTokens: 2_900_000 },
  },
  backup: { lastBackupAtMs: NOW - 3600_000, count: 2 },
  walSizeBytes: 4096,
};

function seedChannel(id: string, cls: string, name: string, allowInterventions = 0): void {
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, type, name, topic, position, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, permission_fingerprint, last_message_id,
       discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json)
     VALUES (?, ?, NULL, 0, ?, NULL, NULL, 0, 0, 0, 1, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(id, GUILD, name, cls, allowInterventions, NOW, NOW);
}

function seedSyncCursor(channelId: string, state: string, historyComplete: number): void {
  db.prepare(
    'INSERT INTO sync_cursors (channel_id, state, history_complete, retry_count, updated_at_ms) VALUES (?,?,?,?,?)',
  ).run(channelId, state, historyComplete, 0, NOW);
}

function seedJob(id: string, type: string, status: string, createdAtMs: number): void {
  db.prepare(
    `INSERT INTO jobs (id, type, status, payload_json, run_after_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, type, status, '{}', NOW, createdAtMs, NOW);
}

function seedProposal(id: string, status: string, expiresAtMs: number | null = null): void {
  db.prepare(
    `INSERT INTO proposals (id, run_id, target_channel_id, status, computed_score, reason, message,
       evidence_message_ids_json, expires_at_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,NULL,'[]',?,?,?)`,
  ).run(id, 'run-1', CHANNEL, status, 0.5, 'r', expiresAtMs, NOW, NOW);
}

function seedOutbox(id: string, status: string, sentAtMs: number | null = null): void {
  db.prepare(
    `INSERT INTO outbox (id, channel_id, content, dedupe_key, status, next_attempt_at_ms,
       created_at_ms, updated_at_ms, sent_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, CHANNEL, 'x', `dk-${id}`, status, NOW, NOW, NOW, sentAtMs);
}

function seedDirectAnswer(
  id: string,
  outcome: 'primary' | 'partial' | 'fallback' | 'suppressed',
  options: { outboxId?: string; questionAtMs?: number; completedAtMs?: number } = {},
): void {
  const questionAtMs = options.questionAtMs ?? NOW - 10_000;
  const completedAtMs = options.completedAtMs ?? NOW - 5_000;
  db.prepare(`INSERT INTO direct_answer_requests (
    source_message_id, run_id, outbox_id, workspace_id, target_channel_id,
    question_created_at_ms, deadline_at_ms, response_intent_key, outcome_kind,
    reason_category, coverage_complete, created_at_ms, started_at_ms, completed_at_ms, updated_at_ms
  ) VALUES (?, 'run-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      options.outboxId ?? null,
      GUILD,
      CHANNEL,
      questionAtMs,
      questionAtMs + 120_000,
      `intent-${id}`,
      outcome,
      outcome === 'suppressed' ? 'rate_limit' : outcome === 'fallback' ? 'model_error' : 'none',
      outcome === 'partial' ? 0 : null,
      questionAtMs,
      questionAtMs,
      completedAtMs,
      completedAtMs,
    );
}

describe('collectStatusReport', () => {
  it('aggregates DB-backed counts and runtime fields with no content or secrets', () => {
    seedChannel('c-org', 'org', 'general', 1);
    seedChannel('c-rev', 'review_only', 'review');
    // CHANNEL (restricted) already seeded.
    seedSyncCursor('c-org', 'backfilling', 0);
    seedSyncCursor('c-rev', 'live', 1);
    seedSyncCursor(CHANNEL, 'error', 0);
    seedJob('j1', 'review_episode', 'queued', NOW - 60_000);
    seedJob('j2', 'send_outbox', 'running', NOW);
    seedJob('j3', 'backfill_channel', 'failed', NOW);
    seedProposal('p1', 'pending_review');
    seedProposal('p2', 'sent');
    seedProposal('p3', 'observed');
    seedOutbox('o1', 'queued');
    seedOutbox('o2', 'sent');
    db.prepare(`INSERT INTO channel_policy_reviews
      (id,workspace_id,channel_id,status,delivery_state,created_at_ms,updated_at_ms)
      VALUES ('channel-review',?,?,'pending','failed',?,?)`).run(GUILD, CHANNEL, NOW, NOW);

    const report = collectStatusReport(db, RUNTIME);

    expect(report.mode).toBe('review');
    expect(report.paused).toBe(false);
    expect(report.gateway.connected).toBe(true);
    expect(report.database.sizeBytes).toBeGreaterThan(0);
    expect(report.database.walSizeBytes).toBe(4096);
    expect(report.queue).toEqual({
      queued: 1,
      due: 1,
      deferred: 0,
      running: 1,
      failed: 1,
      failedByType: [{ type: 'backfill_channel', count: 1 }],
      failedOther: 0,
      oldestQueuedReviewMs: NOW - 60_000,
      oldestDueReviewMs: NOW - 60_000,
    });
    expect(report.sync).toEqual({
      channels: 3,
      historyComplete: 1,
      inProgress: 1,
      errors: 1,
      eligibleChannels: 3,
      eligibleHistoryComplete: 1,
      eligibleInProgress: 1,
      eligibleErrors: 1,
      controlIgnored: 0,
      policyExcluded: 0,
    });
    expect(report.proposals.pendingReview).toBe(1);
    expect(report.proposals.actionablePendingReview).toBe(1);
    expect(report.proposals.stalePendingReview).toBe(0);
    expect(report.proposals.sent).toBe(1);
    expect(report.proposals.observed).toBe(1);
    expect(report.outbox.queued).toBe(1);
    expect(report.outbox.sent).toBe(1);
    expect(report.policy).toEqual({ restricted: 1, org: 1, review_only: 1 });
    expect(report.channelPolicyReviews).toEqual({ pending: 1, failedDelivery: 1 });
    expect(formatStatusReply({ kind: 'done', report })).toContain(
      'Channel reviews: 1 pending · 1 delivery failed',
    );
    expect(report.backup.count).toBe(2);
    expect(report.directAnswers).toMatchObject({
      primary: { queued: 0, sent: 0, failed: 0 },
      partial: { queued: 0, sent: 0, failed: 0 },
      fallback: { queued: 0, sent: 0, failed: 0 },
      suppressed: 0,
      pending: 0,
      pendingOverdue: 0,
    });
  });

  it('reports rolling direct-answer outcomes, delivery state, and ingestion-to-send latency', () => {
    seedOutbox('direct-primary-q', 'queued');
    seedOutbox('direct-partial-s', 'sent', NOW - 1_000);
    seedOutbox('direct-fallback-f', 'failed');
    seedDirectAnswer('direct-primary', 'primary', { outboxId: 'direct-primary-q' });
    seedDirectAnswer('direct-partial', 'partial', {
      outboxId: 'direct-partial-s',
      questionAtMs: NOW - 6_000,
    });
    seedDirectAnswer('direct-fallback', 'fallback', { outboxId: 'direct-fallback-f' });
    seedDirectAnswer('direct-suppressed', 'suppressed');
    seedDirectAnswer('direct-old', 'suppressed', {
      questionAtMs: NOW - 25 * 60 * 60_000,
      completedAtMs: NOW - 25 * 60 * 60_000,
    });
    db.prepare(`INSERT INTO direct_answer_requests (
      source_message_id, workspace_id, target_channel_id, question_created_at_ms,
      deadline_at_ms, response_intent_key, created_at_ms, updated_at_ms
    ) VALUES
      ('direct-pending-current', ?, ?, ?, ?, 'intent-pending-current', ?, ?),
      ('direct-pending-overdue', ?, ?, ?, ?, 'intent-pending-overdue', ?, ?)`)
      .run(
        GUILD, CHANNEL, NOW - 1_000, NOW + 119_000, NOW - 1_000, NOW - 1_000,
        GUILD, CHANNEL, NOW - 180_000, NOW - 60_000, NOW - 180_000, NOW - 180_000,
      );

    const report = collectStatusReport(db, RUNTIME);

    expect(report.directAnswers).toEqual({
      windowStartAtMs: NOW - 24 * 60 * 60_000,
      primary: { queued: 1, sent: 0, failed: 0 },
      partial: { queued: 0, sent: 1, failed: 0 },
      fallback: { queued: 0, sent: 0, failed: 1 },
      suppressed: 1,
      pending: 2,
      pendingOverdue: 1,
      sentLatencyMs: { average: 5_000, maximum: 5_000, latest: 5_000 },
    });
    const text = formatStatusReply({ kind: 'done', report });
    expect(text).toContain(
      'Direct outcomes (24h): 1 primary · 1 partial · 1 fallback · 1 suppressed',
    );
    expect(text).toContain(
      'Direct requests: 2 pending · 1 overdue',
    );
    expect(text).toContain(
      'Direct delivery (24h): 1 sent · 1 queued/sending · 1 failed · latency avg 5s · max 5s',
    );
  });

  it('reflects the durable pause flag', () => {
    db.prepare('INSERT INTO settings (key, value_json, updated_at_ms) VALUES (?,?,?)').run(
      'pause_state',
      JSON.stringify({ paused: true, pausedAtMs: NOW, pausedByUserId: 'alice', updatedAtMs: NOW }),
      NOW,
    );
    const report = collectStatusReport(db, RUNTIME);
    expect(report.paused).toBe(true);
  });

  it('shows a retrying backup job alongside the latest verified backup', () => {
    seedJob('backup-retry', 'backup_database', 'queued', NOW - 120_000);
    db.prepare(
      `UPDATE jobs
          SET attempts = 2, max_attempts = 10, run_after_ms = ?
        WHERE id = 'backup-retry'`,
    ).run(NOW + 61_000);

    const report = collectStatusReport(db, RUNTIME);
    expect(report.backup.job).toEqual({
      status: 'queued',
      attempts: 2,
      maxAttempts: 10,
      runAfterMs: NOW + 61_000,
    });
    expect(formatStatusReply({ kind: 'done', report })).toContain(
      'Backup: 1h ago · 2 retained · retrying · attempt 2/10 · retry in 2m',
    );
  });

  it('separates due work from deferred rows and labels terminal failures as retained', () => {
    seedJob('due-review', 'review_episode', 'queued', NOW - 60_000);
    seedJob('deferred-review', 'review_episode', 'queued', NOW - 120_000);
    db.prepare('UPDATE jobs SET run_after_ms = ? WHERE id = ?').run(NOW + 60_000, 'deferred-review');
    seedJob('old-failure', 'review_episode', 'failed', NOW - 86_400_000);

    const report = collectStatusReport(db, RUNTIME);

    expect(report.queue).toMatchObject({ queued: 2, due: 1, deferred: 1, failed: 1 });
    expect(report.queue.oldestQueuedReviewMs).toBe(NOW - 120_000);
    expect(report.queue.oldestDueReviewMs).toBe(NOW - 60_000);
    expect(formatStatusReply({ kind: 'done', report })).toContain(
      'Jobs: 1 due · 1 deferred · 0 running · 1 failed retained · oldest due review 1m',
    );
    expect(formatStatusReply({ kind: 'done', report })).toContain(
      'Failure types: episode review 1',
    );
  });

  it('counts only durably owned recap work as active and exposes recovery-needed requests', () => {
    seedChannel('recap-orphan-channel', 'org', 'recap-orphan');
    const insertRequest = db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
       budget_usd,status,created_at_ms,updated_at_ms,completed_at_ms,last_error_category)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insertRequest.run(
      'recap-owned', GUILD, CHANNEL, 'admin', NOW - 86_400_000, NOW,
      5, 'synthesizing', NOW - 2_000, NOW - 1_000, null, null,
    );
    insertRequest.run(
      'recap-orphan', GUILD, 'recap-orphan-channel', 'admin', NOW - 2 * 86_400_000, NOW - 86_400_000,
      5, 'synthesizing', NOW - 3_000, NOW - 2_000, null, null,
    );
    insertRequest.run(
      'recap-failed', GUILD, CHANNEL, 'admin', NOW - 3 * 86_400_000, NOW - 2 * 86_400_000,
      5, 'failed', NOW - 4_000, NOW - 3_000, NOW - 3_000, 'processing_error',
    );
    db.prepare(`INSERT INTO jobs
      (id,type,unique_key,payload_json,status,run_after_ms,created_at_ms,updated_at_ms)
      VALUES ('recap-owned-job','deep_recap','deep-recap:recap-owned',?,'queued',?,?,?),
             ('recap-orphan-job','deep_recap','deep-recap:recap-orphan',?,'failed',?,?,?)`)
      .run(
        JSON.stringify({ recapId: 'recap-owned' }), NOW, NOW - 1_000, NOW - 1_000,
        JSON.stringify({ recapId: 'recap-orphan' }), NOW, NOW - 2_000, NOW - 2_000,
      );
    db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms,
       ended_at_ms,cost_usd)
      VALUES ('recap-crash-run',?,'direct_answer','deep','faux','faux','failed',?,?,.27)`)
      .run(GUILD, NOW - 2_500, NOW - 2_400);
    db.prepare(`INSERT INTO deep_recap_model_calls
      (id,request_id,run_id,phase,chunk_ordinal,started_at_ms,created_at_ms,updated_at_ms)
      VALUES ('recap-crash-call','recap-failed','recap-crash-run','synthesis',NULL,?,?,?)`)
      .run(NOW - 2_500, NOW - 2_500, NOW - 2_500);

    const report = collectStatusReport(db, RUNTIME);
    expect(report.deepRecaps).toMatchObject({
      active: 1, recoveryNeeded: 1, failed: 1, spentUsd: 0.27,
    });
    expect(formatStatusReply({ kind: 'done', report })).toContain(
      'Deep recaps: 1 active · 1 recovery needed · 0 complete · 0 partial · 1 failed',
    );
  });

  it('shows a bounded retained-failure type breakdown with an aggregate remainder', () => {
    for (let i = 0; i < 3; i++) seedJob(`reconcile-${i}`, 'reconcile_channel', 'failed', NOW - i);
    for (let i = 0; i < 2; i++) seedJob(`scheduled-${i}`, 'review_due_memories', 'failed', NOW - i);
    seedJob('backup-failed', 'backup_database', 'failed', NOW);
    seedJob('direct-failed', 'direct_answer', 'failed', NOW);
    seedJob('maintenance-failed', 'maintenance', 'failed', NOW);

    const report = collectStatusReport(db, RUNTIME);

    expect(report.queue.failed).toBe(8);
    expect(report.queue.failedByType).toEqual([
      { type: 'reconcile_channel', count: 3 },
      { type: 'review_due_memories', count: 2 },
      { type: 'backup_database', count: 1 },
      { type: 'direct_answer', count: 1 },
    ]);
    expect(report.queue.failedOther).toBe(1);
    expect(formatStatusReply({ kind: 'done', report })).toContain(
      'Failure types: reconciliation 3 · scheduled review 2 · backup 1 · direct answer 1 · other 1',
    );
  });

  it('uses the proposals command deadline boundary for actionable review counts', () => {
    seedProposal('past', 'pending_review', NOW - 1);
    seedProposal('boundary', 'pending_review', NOW);
    seedProposal('future', 'pending_review', NOW + 1);
    seedProposal('no-deadline', 'pending_review', null);

    const report = collectStatusReport(db, RUNTIME);

    // The legacy HTTP-compatible field remains the durable raw status count.
    expect(report.proposals.pendingReview).toBe(4);
    expect(report.proposals.actionablePendingReview).toBe(3);
    expect(report.proposals.stalePendingReview).toBe(1);
    expect(listPendingProposals(db, { now: NOW, limit: 10 })
      .map((proposal) => proposal.id).sort())
      .toEqual(['boundary', 'future', 'no-deadline']);
    expect(formatStatusReply({ kind: 'done', report })).toContain(
      'Proposals: 3 review · 1 stale awaiting expiry',
    );
  });

  it('does not present Mneme-named control channels as incomplete sync work', () => {
    seedChannel('c-control', 'review_only', 'mneme-review');
    seedChannel('c-disabled', 'excluded', 'archive-disabled');
    const report = collectStatusReport(db, RUNTIME);

    expect(report.sync).toMatchObject({
      channels: 3,
      eligibleChannels: 1,
      historyComplete: 0,
      eligibleHistoryComplete: 0,
      controlIgnored: 1,
      policyExcluded: 1,
    });
    expect(formatStatusReply({ kind: 'done', report })).toContain(
      'Sync: 0/1 complete · 0 active · 0 errors · 1 control ignored · 1 policy-excluded',
    );
  });

  it('reports bounded campaign progress, spend, model runs, and memory yield', () => {
    db.prepare(`INSERT INTO historical_memory_campaigns
      (id,workspace_id,status,direction,from_at_ms,to_at_ms,provider,model,thinking_level,
       channel_ids_json,daily_budget_usd,total_budget_usd,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'campaign-1', GUILD, 'running', 'newest_first', NOW - 10_000, NOW,
      'openai', 'gpt-5.6-luna', 'medium', JSON.stringify([CHANNEL]), 10, 2, NOW, NOW,
    );
    db.prepare(`INSERT INTO historical_campaign_cursors
      (campaign_id,channel_id,upper_created_at_ms,upper_message_id,state,messages_scanned,episodes_created,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`).run('campaign-1', CHANNEL, NOW - 5_000, null, 'pending', 23, 2, NOW);
    db.prepare(`INSERT INTO episodes
      (id,workspace_id,conversation_channel_id,status,started_at_ms,last_activity_at_ms,
       human_message_count,total_message_count,trigger_reason,created_at_ms,updated_at_ms,origin,historical_campaign_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'historical-ep', GUILD, CHANNEL, 'reviewed', NOW - 5_000, NOW - 4_000,
      2, 2, 'historical_backfill', NOW, NOW, 'historical', 'campaign-1',
    );
    db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,episode_id,run_type,prompt_version,provider,model,status,input_tokens,output_tokens,cost_usd,started_at_ms,ended_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'campaign-run', GUILD, 'historical-ep', 'episode', 'pv', 'openai', 'gpt-5.6-luna',
      'completed', 1000, 100, 0.25, NOW - 2_000, NOW - 1_000,
    );
    db.prepare(`INSERT INTO memories
      (id,workspace_id,scope_type,scope_key,type,statement,status,confidence,importance,
       first_seen_at_ms,last_confirmed_at_ms,created_by_run_id,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'campaign-memory', GUILD, 'org', null, 'decision', 'A decision', 'active', 0.9, 0.8,
      NOW, NOW, 'campaign-run', NOW, NOW,
    );

    const report = collectStatusReport(db, {
      ...RUNTIME,
      historicalCampaign: { id: 'campaign-1', dayStartMs: NOW - 20_000 },
    });

    expect(report.historicalMemory.campaign).toMatchObject({
      id: 'campaign-1', status: 'running', model: 'gpt-5.6-luna',
      spentTodayUsd: 0.25, spentTotalUsd: 0.25, channels: 1,
      completeChannels: 0, messagesScanned: 23, episodesCreated: 2,
      pendingReviews: 0, modelRuns: 1, memoriesCreated: 1,
    });
    const text = formatStatusReply({ kind: 'done', report });
    expect(text).toContain('Campaign: campaign-1 · running');
    expect(text.length).toBeLessThanOrEqual(STATUS_REPLY_MAX_LENGTH);

    // Defensive worst case: even an adapter returning a pathological display
    // value cannot cross Discord's limit or hide the high-value runtime/work
    // lines at the top of the dashboard.
    report.historicalMemory.campaign!.eligibleMessages = {
      toString: () => '9'.repeat(5_000),
    } as unknown as number;
    const bounded = formatStatusReply({ kind: 'done', report });
    expect(bounded.length).toBeLessThanOrEqual(STATUS_REPLY_MAX_LENGTH);
    expect(bounded).toContain('Build:');
    expect(bounded).toContain('Mode: **review**');
    expect(bounded).toContain('Jobs: 0 due · 0 deferred · 0 running · 0 failed retained');
    expect(bounded).toContain('…status truncated');
  });
});

describe('handleStatusCommand', () => {
  it('denies a non-admin and audits the denial without collecting', () => {
    const collect = () => {
      throw new Error('should not collect when unauthorized');
    };
    const out = handleStatusCommand(
      { actorUserId: 'bob', guildId: GUILD, memberRoleIds: [] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW, runtime: RUNTIME, collect },
    );
    expect(out.kind).toBe('not_authorized');
    expect(countAdminEvents(db, GUILD)).toBe(1);
  });

  it('returns the report for an admin and is audited', () => {
    const out = handleStatusCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW, runtime: RUNTIME },
    );
    expect(out.kind).toBe('done');
    expect(countAdminEvents(db, GUILD)).toBe(1);
  });

  it('formatStatusReply exposes the specified fields and no secrets/content', () => {
    const out = handleStatusCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW, runtime: RUNTIME },
    );
    if (out.kind !== 'done') throw new Error('expected done');
    const text = formatStatusReply(out);
    expect(text).toContain('**Mneme status**');
    expect(text).toContain(`Build: v${APP_VERSION} · commit `);
    expect(text).toContain('Railway deploy `00000000-000`');
    expect(text).toContain('Mode: **review** · running');
    expect(text).toContain('Gateway:');
    expect(text).toContain('**Work**');
    expect(text).toContain('Jobs:');
    expect(text).toContain('Sync:');
    expect(text).toContain('Usage:');
    expect(text).toContain('Proposals:');
    expect(text).toContain('Delivery:');
    expect(text).toContain('Direct outcomes (24h):');
    expect(text).toContain('Direct requests:');
    expect(text).toContain('Direct delivery (24h):');
    expect(text).toContain('Backup:');
    expect(text).toContain('Channels:');
    expect(text.length).toBeLessThanOrEqual(STATUS_REPLY_MAX_LENGTH);
    // No secrets, tokens, message content, or prompt bodies.
    expect(text).not.toMatch(/token|secret|password|Bearer/i);
    expect(text).not.toContain('prompt');
  });

  it('renders budget spend against the cap plus daily and all-time usage', () => {
    const out = handleStatusCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW, runtime: RUNTIME },
    );
    if (out.kind !== 'done') throw new Error('expected done');
    const text = formatStatusReply(out);
    expect(text).toContain('Model: healthy');
    expect(text).toContain('Spend: today $0.43 / $5.00 (9%) · all time $12.30');
    expect(text).toContain('Usage: today 812.0k in / 96.0k out · all time 24.1M in / 2.9M out');
  });

  it('omits the budget segment when no cap is configured, but still shows usage', () => {
    const runtime: StatusRuntimeInputs = {
      ...RUNTIME,
      model: { ...RUNTIME.model, dailyBudgetUsd: null },
    };
    const out = handleStatusCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW, runtime },
    );
    if (out.kind !== 'done') throw new Error('expected done');
    const text = formatStatusReply(out);
    expect(text).toContain('Model: healthy');
    expect(text).not.toContain('/ $5.00');
    expect(text).toContain('Spend: today $0.43 · all time $12.30');
  });

  it('shows sub-cent spend with enough precision to be visible', () => {
    const runtime: StatusRuntimeInputs = {
      ...RUNTIME,
      model: {
        ...RUNTIME.model,
        today: { costUsd: 0.0042, inputTokens: 900, outputTokens: 120 },
      },
    };
    const out = handleStatusCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW, runtime },
    );
    if (out.kind !== 'done') throw new Error('expected done');
    const text = formatStatusReply(out);
    expect(text).toContain('Spend: today $0.0042 / $5.00 (0%)');
    expect(text).toContain('Usage: today 900 in / 120 out');
  });

  it('shows deployment identity without inventing a source revision for a CLI upload', () => {
    const runtime: StatusRuntimeInputs = {
      ...RUNTIME,
      build: {
        appVersion: APP_VERSION,
        sourceRevision: null,
        railwayDeploymentId: '00000000-0000-4000-8000-000000000002',
        buildId: null,
      },
    };
    const out = handleStatusCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW, runtime },
    );
    const text = formatStatusReply(out);

    expect(text).toContain(`Build: v${APP_VERSION} · Railway deploy \`00000000-000\``);
    expect(text).not.toContain('commit');
  });

  it('uses an explicit short build id when no Railway deployment exists', () => {
    const runtime: StatusRuntimeInputs = {
      ...RUNTIME,
      build: {
        appVersion: APP_VERSION,
        sourceRevision: null,
        railwayDeploymentId: null,
        buildId: 'rel42abc-2026-08-16',
      },
    };
    const out = handleStatusCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW, runtime },
    );

    expect(formatStatusReply(out)).toContain(`Build: v${APP_VERSION} · build \`rel42abc-202\``);
  });
});

describe('collectChannelsReport', () => {
  it('paginates channels with policy class, sync state, and access warnings', () => {
    seedChannel('c-org', 'org', 'general', 1);
    seedChannel('c-rev', 'review_only', 'review');
    seedSyncCursor('c-org', 'live', 1);
    recordAccessAudit(db, {
      channelId: CHANNEL,
      checkedAtMs: NOW,
      canView: true,
      canReadHistory: false,
      canSend: true,
      canSendInThreads: true,
      canManageThreads: false,
      warning: 'missing read history',
    });

    const report = collectChannelsReport(db, { guildId: GUILD, page: 1, pageSize: 2, now: NOW });
    expect(report.total).toBe(3);
    expect(report.channels).toHaveLength(2);
    expect(report.hasMore).toBe(true);

    const restricted = report.channels.find((c) => c.id === CHANNEL)!;
    expect(restricted.visibilityClass).toBe('restricted');
    expect(restricted.warning).toBe('missing read history');

    const org = report.channels.find((c) => c.id === 'c-org')!;
    expect(org.visibilityClass).toBe('org');
    expect(org.allowInterventions).toBe(true);
    expect(org.syncState).toBe('live');
    expect(org.historyComplete).toBe(true);
  });

  it('page 2 returns the remaining channel and clears hasMore', () => {
    seedChannel('c-org', 'org', 'general');
    seedChannel('c-rev', 'review_only', 'review');
    const report = collectChannelsReport(db, { guildId: GUILD, page: 2, pageSize: 2, now: NOW });
    expect(report.total).toBe(3);
    expect(report.channels).toHaveLength(1);
    expect(report.hasMore).toBe(false);
  });

  it('an unsynced channel reports null sync state and history', () => {
    seedChannel('c-org', 'org', 'general');
    const report = collectChannelsReport(db, { guildId: GUILD, now: NOW });
    const org = report.channels.find((c) => c.id === 'c-org')!;
    expect(org.syncState).toBeNull();
    expect(org.historyComplete).toBeNull();
    expect(org.warning).toBeNull();
  });

  it('labels pending and decided runtime channel classifications', () => {
    db.prepare(`INSERT INTO channel_policy_reviews
      (id,workspace_id,channel_id,status,delivery_state,created_at_ms,updated_at_ms)
      VALUES ('pending-review',?,?,'pending','queued',?,?)`).run(GUILD, CHANNEL, NOW, NOW);
    const report = collectChannelsReport(db, { guildId: GUILD, now: NOW });
    expect(report.channels.find((channel) => channel.id === CHANNEL)?.policyReview).toBe('pending');
    expect(formatChannelsReply({ kind: 'done', report })).toContain('review-pending');
  });
});

describe('handleChannelsCommand + formatChannelsReply', () => {
  it('denies a non-admin and is audited', () => {
    const out = handleChannelsCommand(
      { actorUserId: 'bob', guildId: GUILD, memberRoleIds: [] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(out.kind).toBe('not_authorized');
    expect(countAdminEvents(db, GUILD)).toBe(1);
  });

  it('returns a bounded reply for an admin with a more-pages footer', () => {
    seedChannel('c-org', 'org', 'general');
    seedChannel('c-rev', 'review_only', 'review');
    const out = handleChannelsCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW, pageSize: 2 },
    );
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    const text = formatChannelsReply(out);
    expect(text).toContain('channels: 3 total (page 1');
    expect(text).toContain('more available');
    expect(text).toContain('page 2');
    // No content, topics, tokens.
    expect(text).not.toMatch(/token|secret|password/i);
    expect(text.length).toBeLessThanOrEqual(1900);
  });

  it('excludes deleted channels', () => {
    seedChannel('c-org', 'org', 'general');
    db.prepare('UPDATE channels SET deleted_at_ms = ? WHERE id = ?').run(NOW, CHANNEL);
    const report = collectChannelsReport(db, { guildId: GUILD, now: NOW });
    expect(report.total).toBe(1);
    expect(report.channels.find((c) => c.id === CHANNEL)).toBeUndefined();
  });
});
