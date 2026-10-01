import { type DatabaseSync } from '../../db/database.js';
import { prepareCached } from '../../db/repositories/util.js';
import { countJobsByStatus } from '../../jobs/queue.js';
import { authorizeAdmin, type AuthorizationReason } from '../authorization.js';
import { recordAdminEvent } from '../../db/repositories/admin-events.js';
import type { AutonomyMode } from '../../config.js';
import { normalizeBuildInfo, type BuildInfo } from '../../build-info.js';
import { isMnemeTestSurface } from '../test-channels.js';
import {
  collectDirectAnswerStatus24h,
  type DirectAnswerStatus24h,
} from '../../db/repositories/direct-answers.js';
import { countPendingProposals } from '../../db/repositories/proposals.js';

/**
 * `/mneme status` (Sections 27, 33).
 *
 * Returns bounded operational state to an authorized administrator: Gateway,
 * database, job queue, model, deployment mode, ingestion sync, proposals,
 * outbox, backup, and channel-policy coverage. Every field is a count, a state,
 * a size, or a timestamp — never message content, prompt bodies, or credentials
 * (Section 33). The command stays free of discord.js types; the dispatcher wires
 * the interaction to {@link handleStatusCommand} and replies with
 * {@link formatStatusReply}.
 *
 * The command responds quickly: it does not run `PRAGMA integrity_check` (that
 * is the dedicated `/mneme integrity-check` command) and it does not call the
 * model or Discord. Runtime-only fields the database cannot know — Gateway
 * connection state, model health, and backup recency — are supplied by the host.
 */

export interface GatewayStatus {
  connected: boolean;
  ready: boolean;
  lastEventAtMs: number | null;
  reconnectCount: number;
}

/** Model spend and token totals over one period, summed from `agent_runs`. */
export interface ModelUsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelStatus {
  healthy: boolean;
  lastCallAtMs: number | null;
  /** Configured org-day spend cap in USD, or null when no cap is set. */
  dailyBudgetUsd: number | null;
  /** Usage since the current org-day start. */
  today: ModelUsageTotals;
  /** Usage over the whole retained `agent_runs` history. */
  allTime: ModelUsageTotals;
}

export interface BackupStatus {
  lastBackupAtMs: number | null;
  /** Number of retained local backups, or null when unknown. */
  count: number | null;
  /** Latest durable backup job, populated by the shared status collector. */
  job?: BackupJobStatus | null;
}

export interface BackupJobStatus {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  maxAttempts: number;
  runAfterMs: number;
}

/** Host-supplied runtime state the database does not own. */
export interface StatusRuntimeInputs {
  /** Host clock captured for this snapshot. */
  nowMs: number;
  /** Explicit, non-secret identity resolved once at process startup. */
  build: BuildInfo;
  mode: AutonomyMode;
  gateway: GatewayStatus;
  model: ModelStatus;
  backup: BackupStatus;
  /** Current size of the WAL file in bytes, or null when not measured. */
  walSizeBytes: number | null;
  historicalCampaign?: { id: string; dayStartMs: number };
}

export interface DatabaseStatus {
  /** Live database size in bytes (page_size × page_count). */
  sizeBytes: number;
  /** WAL file size in bytes, or null when not measured. */
  walSizeBytes: number | null;
}

export interface QueueStatus {
  /** All rows currently in queued state (`due + deferred`). */
  queued: number;
  /** Queued rows eligible to be claimed now. */
  due: number;
  /** Queued rows intentionally scheduled for a future time. */
  deferred: number;
  running: number;
  /** Retained terminal failures over the database lifetime, not a current-health window. */
  failed: number;
  /** Highest-volume retained failure types, ordered by count then stable type name. */
  failedByType: FailedJobTypeCount[];
  /** Retained failures outside the bounded `failedByType` list. */
  failedOther: number;
  /** Oldest queued review/direct-answer row, including deferred work (compatibility field). */
  oldestQueuedReviewMs: number | null;
  /** Oldest due review/direct-answer job created_at_ms, or null. */
  oldestDueReviewMs: number | null;
}

export interface FailedJobTypeCount {
  type: string;
  count: number;
}

export interface SyncStatus {
  /** Every current channel row, including control and policy-excluded surfaces. */
  channels: number;
  /** Original all-cursor counts retained for HTTP status compatibility. */
  historyComplete: number;
  inProgress: number;
  errors: number;
  /** Channels currently expected to have a sync cursor. */
  eligibleChannels: number;
  /** Eligible-channel subset of the corresponding all-cursor count. */
  eligibleHistoryComplete: number;
  eligibleInProgress: number;
  eligibleErrors: number;
  /** Mneme-named control/test surfaces intentionally omitted from history sync. */
  controlIgnored: number;
  /** Other current channels disabled/excluded by policy or an unavailable parent. */
  policyExcluded: number;
}

export interface HistoricalMemoryStatus {
  channels: number;
  complete: number;
  messagesScanned: number;
  episodesCreated: number;
  pendingReviews: number;
  campaign: HistoricalCampaignStatus | null;
}

export interface HistoricalCampaignStatus {
  id: string;
  status: string;
  direction: string;
  fromAtMs: number;
  toAtMs: number;
  model: string;
  thinkingLevel: string;
  dailyBudgetUsd: number;
  totalBudgetUsd: number;
  spentTodayUsd: number;
  spentTotalUsd: number;
  eligibleMessages: number;
  channels: number;
  completeChannels: number;
  messagesScanned: number;
  episodesCreated: number;
  pendingReviews: number;
  modelRuns: number;
  memoriesCreated: number;
}

export interface ProposalStatusCounts {
  observed: number;
  /** Legacy durable count of every row whose stored status is `pending_review`. */
  pendingReview: number;
  /** Currently actionable subset, using the same deadline predicate as `/mneme proposals`. */
  actionablePendingReview: number;
  /** Past-deadline durable rows awaiting the idempotent expiry sweep. */
  stalePendingReview: number;
  approved: number;
  dismissed: number;
  expired: number;
  sent: number;
  failed: number;
}

export interface OutboxStatusCounts {
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  cancelled: number;
}

export interface DeepRecapStatusCounts {
  active: number;
  recoveryNeeded: number;
  completed: number;
  partial: number;
  failed: number;
  spentUsd: number;
}

export interface StatusReport {
  now: number;
  build: BuildInfo;
  mode: AutonomyMode;
  paused: boolean;
  gateway: GatewayStatus;
  database: DatabaseStatus;
  queue: QueueStatus;
  model: ModelStatus;
  sync: SyncStatus;
  historicalMemory: HistoricalMemoryStatus;
  proposals: ProposalStatusCounts;
  outbox: OutboxStatusCounts;
  /** Rolling response outcomes/delivery plus the current addressed-question backlog. */
  directAnswers: DirectAnswerStatus24h;
  deepRecaps: DeepRecapStatusCounts;
  backup: BackupStatus;
  /** Channel counts grouped by visibility class (org/restricted/review_only/excluded). */
  policy: Record<string, number>;
  channelPolicyReviews?: { pending: number; failedDelivery: number };
}

/**
 * Aggregate the bounded operational report from the database plus host-supplied
 * runtime state. Every value is a count/state/size/timestamp; no content or
 * secrets are read. Safe to run on every status invocation — no integrity check,
 * no model call, no Discord fetch.
 */
export function collectStatusReport(db: DatabaseSync, runtime: StatusRuntimeInputs): StatusReport {
  return {
    now: runtime.nowMs,
    build: normalizeBuildInfo(runtime.build),
    mode: runtime.mode,
    paused: isPaused(db),
    gateway: runtime.gateway,
    database: { sizeBytes: dbSizeBytes(db), walSizeBytes: runtime.walSizeBytes },
    queue: collectQueueStatus(db, runtime.nowMs),
    model: runtime.model,
    sync: collectSyncStatus(db),
    historicalMemory: collectHistoricalMemoryStatus(db, runtime.historicalCampaign),
    proposals: collectProposalCounts(db, runtime.nowMs),
    outbox: collectOutboxCounts(db),
    directAnswers: collectDirectAnswerStatus24h(db, runtime.nowMs),
    deepRecaps: collectDeepRecapStatus(db),
    backup: { ...runtime.backup, job: collectLatestBackupJob(db) },
    policy: collectPolicyCoverage(db),
    channelPolicyReviews: collectChannelPolicyReviewStatus(db),
  };
}

export interface HandleStatusInput {
  actorUserId: string;
  guildId: string;
  /** The caller's role ids, or null when unresolved (fail-closed). */
  memberRoleIds: readonly string[] | null;
}

export interface HandleStatusDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  runtime: StatusRuntimeInputs;
  /** Override the collector (tests). Defaults to {@link collectStatusReport}. */
  collect?: () => StatusReport;
}

export type StatusOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'done'; report: StatusReport };

/** Run `/mneme status`. Authorization is checked first and audited on denial. */
export function handleStatusCommand(input: HandleStatusInput, deps: HandleStatusDeps): StatusOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!outcome.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'status',
      details: { authorized: false, reason: outcome.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: outcome.reason };
  }
  recordAdminEvent(deps.db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'status',
    details: { authorized: true },
    createdAtMs: deps.nowMs,
  });
  const report = deps.collect ? deps.collect() : collectStatusReport(deps.db, deps.runtime);
  return { kind: 'done', report };
}

/** Leave headroom below Discord's 2,000-character message limit. */
export const STATUS_REPLY_MAX_LENGTH = 1_900;

/** Format an ephemeral, compact operational dashboard. No content or secrets. */
export function formatStatusReply(outcome: StatusOutcome): string {
  if (outcome.kind === 'not_authorized') {
    return 'You are not authorized to view Mneme status.';
  }
  const r = outcome.report;
  const g = r.gateway;
  const q = r.queue;
  const s = r.sync;
  const p = r.proposals;
  const o = r.outbox;
  const d = r.directAnswers;
  const gatewayState = g.ready ? 'ready' : g.connected ? 'connected, not ready' : 'disconnected';
  const syncExtras = [
    s.controlIgnored > 0 ? `${s.controlIgnored} control ignored` : null,
    s.policyExcluded > 0 ? `${s.policyExcluded} policy-excluded` : null,
  ].filter((value): value is string => value !== null);
  const lines = [
    '**Mneme status**',
    `Build: ${formatBuild(r.build)}`,
    `Mode: **${r.mode}** · ${r.paused ? 'paused' : 'running'}`,
    `Gateway: ${gatewayState} · ${formatLastSeen('event', g.lastEventAtMs, r.now)} · ${g.reconnectCount} reconnects`,
    `Model: ${r.model.healthy ? 'healthy' : 'degraded'} · ${formatLastSeen('call', r.model.lastCallAtMs, r.now)}`,
    `Spend: today ${formatDailySpend(r.model)} · all time ${formatUsd(r.model.allTime.costUsd)}`,
    `Usage: today ${formatTokenTotals(r.model.today)} · all time ${formatTokenTotals(r.model.allTime)}`,
    '',
    '**Work**',
    `Jobs: ${q.due} due · ${q.deferred} deferred · ${q.running} running · ${q.failed} failed retained${q.oldestDueReviewMs === null ? '' : ` · oldest due review ${age(r.now, q.oldestDueReviewMs)}`}`,
    `Sync: ${s.eligibleHistoryComplete}/${s.eligibleChannels} complete · ${s.eligibleInProgress} active · ${s.eligibleErrors} errors${syncExtras.length > 0 ? ` · ${syncExtras.join(' · ')}` : ''}`,
    `Historical: ${r.historicalMemory.complete}/${r.historicalMemory.channels} channels · ${r.historicalMemory.messagesScanned} scanned · ${r.historicalMemory.episodesCreated} episodes · ${r.historicalMemory.pendingReviews} analyses pending`,
    `Proposals: ${p.actionablePendingReview} review${p.stalePendingReview > 0 ? ` · ${p.stalePendingReview} stale awaiting expiry` : ''} · ${p.approved} approved · ${p.sent} sent · ${p.observed} observed · ${p.dismissed} dismissed · ${p.expired} expired · ${p.failed} failed`,
    `Channel reviews: ${r.channelPolicyReviews?.pending ?? 0} pending${(r.channelPolicyReviews?.failedDelivery ?? 0) > 0 ? ` · ${r.channelPolicyReviews!.failedDelivery} delivery failed` : ''}`,
    `Delivery: ${o.queued} queued · ${o.sending} sending · ${o.sent} sent · ${o.failed} failed · ${o.cancelled} cancelled`,
    `Direct outcomes (24h): ${deliveryTotal(d.primary)} primary · ${deliveryTotal(d.partial)} partial · ${deliveryTotal(d.fallback)} fallback · ${d.suppressed} suppressed`,
    `Direct requests: ${d.pending} pending · ${d.pendingOverdue} overdue`,
    `Direct delivery (24h): ${deliveryByState(d, 'sent')} sent · ${deliveryByState(d, 'queued')} queued/sending · ${deliveryByState(d, 'failed')} failed · latency avg ${formatDuration(d.sentLatencyMs.average)} · max ${formatDuration(d.sentLatencyMs.maximum)}`,
    `Deep recaps: ${r.deepRecaps.active} active · ${r.deepRecaps.recoveryNeeded} recovery needed · ${r.deepRecaps.completed} complete · ${r.deepRecaps.partial} partial · ${r.deepRecaps.failed} failed · ${formatUsd(r.deepRecaps.spentUsd)} spent`,
    '',
    '**Storage & scope**',
    `Database: ${formatBytes(r.database.sizeBytes)}${r.database.walSizeBytes !== null ? ` · WAL ${formatBytes(r.database.walSizeBytes)}` : ''}`,
    `Backup: ${formatBackupStatus(r.backup, r.now)}`,
    `Channels: ${formatPolicy(r.policy)}`,
  ];
  if (r.historicalMemory.campaign) {
    const c = r.historicalMemory.campaign;
    lines.splice(12, 0,
      `Campaign: ${inlineValue(c.id, 32)} · ${inlineValue(c.status, 20)} · ${inlineValue(c.model, 48)}/${inlineValue(c.thinkingLevel, 16)}`,
      `Campaign spend: ${formatUsd(c.spentTodayUsd)}/${formatUsd(c.dailyBudgetUsd)} today · ${formatUsd(c.spentTotalUsd)}/${formatUsd(c.totalBudgetUsd)} total`,
      `Campaign progress: ${c.completeChannels}/${c.channels} channels · ${c.eligibleMessages} eligible · ${c.messagesScanned} scanned · ${c.episodesCreated} episodes · ${c.pendingReviews} waiting · ${c.modelRuns} runs · ${c.memoriesCreated} memories`,
    );
  }
  const failedJobDetail = formatFailedJobDetail(q);
  if (failedJobDetail) lines.splice(10, 0, failedJobDetail);
  return boundStatusReply(lines.join('\n'));
}

/** Keep failure diagnosis compact: four top types plus one aggregate remainder. */
function formatFailedJobDetail(queue: QueueStatus): string | null {
  if (queue.failed === 0 || queue.failedByType.length === 0) return null;
  const parts = queue.failedByType.map(
    ({ type, count }) => `${jobTypeLabel(type)} ${count}`,
  );
  if (queue.failedOther > 0) parts.push(`other ${queue.failedOther}`);
  return `Failure types: ${parts.join(' · ')}`;
}

function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? inlineValue(type.replaceAll('_', ' '), 24);
}

const JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  archive_attachment: 'attachment archive',
  backfill_channel: 'backfill',
  backup_database: 'backup',
  build_historical_episodes: 'historical build',
  close_episode: 'episode close',
  direct_answer: 'direct answer',
  deliver_channel_policy_review: 'channel review delivery',
  deep_recap: 'deep recap',
  discover_threads: 'thread discovery',
  forget_user: 'legacy deletion (disabled)',
  execute_deletion: 'approved deletion',
  maintenance: 'maintenance',
  purge_attachment_file: 'attachment purge',
  reconcile_channel: 'reconciliation',
  rescope_memories: 'memory rescope',
  review_due_memories: 'scheduled review',
  review_due_memory_cohort: 'scheduled review cohort',
  review_episode: 'episode review',
  send_outbox: 'delivery',
};

function formatBackupStatus(backup: BackupStatus, now: number): string {
  const parts = [backup.lastBackupAtMs !== null ? `${age(now, backup.lastBackupAtMs)} ago` : 'none'];
  if (backup.count !== null) parts.push(`${backup.count} retained`);
  const job = backup.job;
  if (!job) return parts.join(' · ');
  const state = job.status === 'queued' && job.attempts > 0 ? 'retrying' : job.status;
  parts.push(state);
  if (job.attempts > 0) parts.push(`attempt ${job.attempts}/${job.maxAttempts}`);
  if (job.status === 'queued' && job.runAfterMs > now) parts.push(`retry in ${futureAge(now, job.runAfterMs)}`);
  return parts.join(' · ');
}

function futureAge(now: number, atMs: number): string {
  const seconds = Math.max(1, Math.ceil((atMs - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

function deliveryTotal(bucket: { queued: number; sent: number; failed: number }): number {
  return bucket.queued + bucket.sent + bucket.failed;
}

function deliveryByState(
  status: DirectAnswerStatus24h,
  state: keyof DirectAnswerStatus24h['primary'],
): number {
  return status.primary[state] + status.partial[state] + status.fallback[state];
}

function formatDuration(valueMs: number | null): string {
  if (valueMs === null) return 'none';
  if (valueMs < 1_000) return `${valueMs}ms`;
  const seconds = Math.round(valueMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/** `$0.43 / $5.00 (9%)` when capped, otherwise just today's spend. */
function formatDailySpend(m: ModelStatus): string {
  if (m.dailyBudgetUsd === null) return formatUsd(m.today.costUsd);
  const pct =
    m.dailyBudgetUsd === 0 ? 100 : Math.min(100, Math.round((m.today.costUsd / m.dailyBudgetUsd) * 100));
  return `${formatUsd(m.today.costUsd)} / ${formatUsd(m.dailyBudgetUsd)} (${pct}%)`;
}

/** `12.3k in / 4.5k out` — one period's token totals without content. */
function formatTokenTotals(u: ModelUsageTotals): string {
  return `${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out`;
}

/** Two decimals normally; four below one cent so small spend is not shown as $0.00. */
function formatUsd(v: number): string {
  return v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function age(now: number, atMs: number): string {
  const secs = Math.max(0, Math.round((now - atMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)}${units[i]}`;
}

function formatBuild(build: BuildInfo): string {
  const parts = [`v${inlineValue(build.appVersion, 32)}`];
  if (build.sourceRevision) parts.push(`commit \`${shortId(build.sourceRevision)}\``);
  if (build.railwayDeploymentId) {
    parts.push(`Railway deploy \`${shortId(build.railwayDeploymentId)}\``);
  } else if (build.buildId) {
    parts.push(`build \`${shortId(build.buildId)}\``);
  }
  return parts.join(' · ');
}

function formatLastSeen(label: string, atMs: number | null, now: number): string {
  return atMs === null ? `no ${label} yet` : `${label} ${age(now, atMs)} ago`;
}

function formatPolicy(policy: Record<string, number>): string {
  return [
    `org ${policy.org ?? 0}`,
    `restricted ${policy.restricted ?? 0}`,
    `review-only ${policy.review_only ?? 0}`,
    `excluded ${policy.excluded ?? 0}`,
  ].join(' · ');
}

function inlineValue(value: string, maxLength: number): string {
  const compact = value.replace(/[\r\n\t`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1))}…`;
}

function shortId(value: string): string {
  return inlineValue(value, 128).slice(0, 12);
}

function boundStatusReply(text: string): string {
  if (text.length <= STATUS_REPLY_MAX_LENGTH) return text;
  const suffix = '\n…status truncated';
  return `${text.slice(0, STATUS_REPLY_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

// ---- collectors -------------------------------------------------------------

function collectChannelPolicyReviewStatus(db: DatabaseSync): { pending: number; failedDelivery: number } {
  const row = prepareCached(db, 'status.channel-policy-reviews', `SELECT
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status='pending' AND delivery_state='failed' THEN 1 ELSE 0 END) AS failed
    FROM channel_policy_reviews`).get() as { pending: number | null; failed: number | null };
  return { pending: Number(row.pending ?? 0), failedDelivery: Number(row.failed ?? 0) };
}

function collectDeepRecapStatus(db: DatabaseSync): DeepRecapStatusCounts {
  const row = prepareCached(db, 'status.deep_recaps', `
    WITH recap_jobs AS (
      SELECT CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json,'$.recapId')
                  ELSE NULL END AS recap_id,
             status
        FROM jobs
       WHERE type='deep_recap'
    )
    SELECT
      SUM(CASE WHEN r.status IN ('queued','running','synthesizing') AND
                    (SELECT COUNT(*) FROM recap_jobs j
                      WHERE j.recap_id=r.id AND j.status IN ('queued','running'))=1
               THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN r.status IN ('queued','running','synthesizing') AND
                    (SELECT COUNT(*) FROM recap_jobs j
                      WHERE j.recap_id=r.id AND j.status IN ('queued','running'))<>1
               THEN 1 ELSE 0 END) AS recovery_needed,
      SUM(CASE WHEN r.status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN r.status='partial' THEN 1 ELSE 0 END) AS partial,
      SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END) AS failed,
      COALESCE((
        SELECT SUM(COALESCE(mc.cost_usd,ar.cost_usd,0))
          FROM deep_recap_model_calls mc
          LEFT JOIN agent_runs ar ON ar.id=mc.run_id
      ),0) AS spent
    FROM deep_recap_requests r
  `).get() as { active: number | null; recovery_needed: number | null; completed: number | null; partial: number | null; failed: number | null; spent: number };
  return {
    active: Number(row.active ?? 0),
    recoveryNeeded: Number(row.recovery_needed ?? 0),
    completed: Number(row.completed ?? 0),
    partial: Number(row.partial ?? 0),
    failed: Number(row.failed ?? 0),
    spentUsd: Number(row.spent),
  };
}

function dbSizeBytes(db: DatabaseSync): number {
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined)?.page_size ?? 0;
  const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined)?.page_count ?? 0;
  return pageSize * pageCount;
}

function isPaused(db: DatabaseSync): boolean {
  const row = prepareCached(
    db,
    'status.pause',
    "SELECT value_json FROM settings WHERE key = 'pause_state'",
  ).get() as { value_json: string } | undefined;
  if (!row) return false;
  try {
    return (JSON.parse(row.value_json) as { paused?: boolean }).paused === true;
  } catch {
    return false;
  }
}

function collectQueueStatus(db: DatabaseSync, now: number): QueueStatus {
  const oldestQueued = prepareCached(
    db,
    'status.oldest_queued_review',
    `SELECT MIN(created_at_ms) AS m FROM jobs
       WHERE status = 'queued'
         AND type IN ('review_episode', 'review_due_memories', 'review_due_memory_cohort', 'direct_answer')`,
  ).get() as { m: number | null } | undefined;
  const oldest = prepareCached(
    db,
    'status.oldest_due_review',
    `SELECT MIN(created_at_ms) AS m FROM jobs
       WHERE status = 'queued'
         AND run_after_ms <= ?
         AND type IN ('review_episode', 'review_due_memories', 'review_due_memory_cohort', 'direct_answer')`,
  ).get(now) as { m: number | null } | undefined;
  const queued = prepareCached(
    db,
    'status.queue.due_deferred',
    `SELECT COUNT(*) AS queued,
            COALESCE(SUM(CASE WHEN run_after_ms <= ? THEN 1 ELSE 0 END), 0) AS due,
            COALESCE(SUM(CASE WHEN run_after_ms > ? THEN 1 ELSE 0 END), 0) AS deferred
       FROM jobs
      WHERE status = 'queued'`,
  ).get(now, now) as { queued: number; due: number; deferred: number };
  const failed = countJobsByStatus(db, 'failed');
  const failedByType = prepareCached(
    db,
    'status.queue.failed_by_type',
    `SELECT type, COUNT(*) AS count
       FROM jobs
      WHERE status = 'failed'
      GROUP BY type
      ORDER BY count DESC, type ASC
      LIMIT 4`,
  ).all() as Array<{ type: string; count: number }>;
  const representedFailures = failedByType.reduce((sum, row) => sum + Number(row.count), 0);
  return {
    queued: Number(queued.queued),
    due: Number(queued.due),
    deferred: Number(queued.deferred),
    running: countJobsByStatus(db, 'running'),
    failed,
    failedByType: failedByType.map((row) => ({ type: row.type, count: Number(row.count) })),
    failedOther: Math.max(0, failed - representedFailures),
    oldestQueuedReviewMs: oldestQueued?.m ?? null,
    oldestDueReviewMs: oldest?.m ?? null,
  };
}

function collectLatestBackupJob(db: DatabaseSync): BackupJobStatus | null {
  const row = prepareCached(
    db,
    'status.backup.latest_job',
    `SELECT status, attempts, max_attempts, run_after_ms
       FROM jobs
      WHERE type = 'backup_database'
      ORDER BY created_at_ms DESC
      LIMIT 1`,
  ).get() as {
    status: BackupJobStatus['status'];
    attempts: number;
    max_attempts: number;
    run_after_ms: number;
  } | undefined;
  return row ? {
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfterMs: row.run_after_ms,
  } : null;
}

function collectSyncStatus(db: DatabaseSync): SyncStatus {
  const rows = prepareCached(
    db,
    'status.sync.scoped',
    `SELECT c.id, c.name, c.is_thread, c.ingest_enabled, c.visibility_class,
            parent.id AS parent_id, parent.ingest_enabled AS parent_ingest_enabled,
            parent.deleted_at_ms AS parent_deleted_at_ms,
            cursor.state, cursor.history_complete
       FROM channels c
       LEFT JOIN channels parent ON parent.id = c.parent_id
       LEFT JOIN sync_cursors cursor ON cursor.channel_id = c.id
      WHERE c.deleted_at_ms IS NULL`,
  ).all() as Array<{
    id: string;
    name: string | null;
    is_thread: number;
    ingest_enabled: number;
    visibility_class: string;
    parent_id: string | null;
    parent_ingest_enabled: number | null;
    parent_deleted_at_ms: number | null;
    state: string | null;
    history_complete: number | null;
  }>;
  let eligibleChannels = 0;
  let eligibleHistoryComplete = 0;
  let eligibleInProgress = 0;
  let eligibleErrors = 0;
  let controlIgnored = 0;
  let policyExcluded = 0;
  for (const row of rows) {
    if (isMnemeTestSurface(db, row.id)) {
      controlIgnored += 1;
      continue;
    }
    const parentAvailable = row.is_thread !== 1 || (
      row.parent_id !== null
      && row.parent_ingest_enabled === 1
      && row.parent_deleted_at_ms === null
    );
    if (row.ingest_enabled !== 1 || row.visibility_class === 'excluded' || !parentAvailable) {
      policyExcluded += 1;
      continue;
    }
    eligibleChannels += 1;
    if (row.history_complete === 1) eligibleHistoryComplete += 1;
    if (row.state === 'pending' || row.state === 'backfilling') eligibleInProgress += 1;
    if (row.state === 'error') eligibleErrors += 1;
  }
  return {
    channels: rows.length,
    historyComplete: countWhere(
      db,
      'status.sync.complete',
      'SELECT COUNT(*) AS n FROM sync_cursors WHERE history_complete = 1',
    ),
    inProgress: countWhere(
      db,
      'status.sync.in_progress',
      "SELECT COUNT(*) AS n FROM sync_cursors WHERE state IN ('pending', 'backfilling')",
    ),
    errors: countWhere(
      db,
      'status.sync.errors',
      "SELECT COUNT(*) AS n FROM sync_cursors WHERE state = 'error'",
    ),
    eligibleChannels,
    eligibleHistoryComplete,
    eligibleInProgress,
    eligibleErrors,
    controlIgnored,
    policyExcluded,
  };
}

function collectHistoricalMemoryStatus(
  db: DatabaseSync,
  active?: { id: string; dayStartMs: number },
): HistoricalMemoryStatus {
  const row = prepareCached(db, 'status.historical_memory', `
    SELECT COUNT(*) AS channels,
           COALESCE(SUM(CASE WHEN state='complete' THEN 1 ELSE 0 END), 0) AS complete,
           COALESCE(SUM(messages_scanned), 0) AS messages_scanned,
           COALESCE(SUM(episodes_created), 0) AS episodes_created
      FROM historical_episode_cursors
  `).get() as { channels: number; complete: number; messages_scanned: number; episodes_created: number };
  const pending = countWhere(db, 'status.historical_pending',
    "SELECT COUNT(*) AS n FROM episodes WHERE origin='historical' AND status IN ('queued','reviewing')");
  let campaign: HistoricalCampaignStatus | null = null;
  if (active) {
    const c = db.prepare('SELECT * FROM historical_memory_campaigns WHERE id=?').get(active.id) as
      | { id: string; status: string; direction: string; from_at_ms: number; to_at_ms: number;
          model: string; thinking_level: string; daily_budget_usd: number; total_budget_usd: number;
          channel_ids_json: string }
      | undefined;
    if (c) {
      const progress = db.prepare(`SELECT COUNT(*) channels,
        COALESCE(SUM(CASE WHEN state='complete' THEN 1 ELSE 0 END),0) complete,
        COALESCE(SUM(messages_scanned),0) scanned,COALESCE(SUM(episodes_created),0) episodes
        FROM historical_campaign_cursors WHERE campaign_id=?`).get(c.id) as
        { channels: number; complete: number; scanned: number; episodes: number };
      const usage = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN ar.started_at_ms>=? THEN ar.cost_usd ELSE 0 END),0) today,
        COALESCE(SUM(ar.cost_usd),0) total,COUNT(ar.id) runs
        FROM agent_runs ar JOIN episodes e ON e.id=ar.episode_id
        WHERE e.historical_campaign_id=?`).get(active.dayStartMs, c.id) as
        { today: number; total: number; runs: number };
      const eligible = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN users u ON u.id=m.author_id
        JOIN channels c ON c.id=m.channel_id
        LEFT JOIN channels parent ON parent.id=c.parent_id
        JOIN json_each(?) selected ON selected.value=m.channel_id
        WHERE m.deleted_at_ms IS NULL AND u.is_bot=0 AND trim(m.content)<>''
          AND INSTR(LOWER(COALESCE(c.name,'')), 'mneme')=0
          AND (c.is_thread=0 OR INSTR(LOWER(COALESCE(parent.name,'')), 'mneme')=0)
          AND m.created_at_ms>=? AND m.created_at_ms<=?`).get(c.channel_ids_json, c.from_at_ms, c.to_at_ms) as { n: number };
      const campaignPending = db.prepare(`SELECT COUNT(*) n FROM episodes
        WHERE historical_campaign_id=? AND status IN ('queued','reviewing')`).get(c.id) as { n: number };
      const memories = db.prepare(`SELECT COUNT(DISTINCT m.id) n FROM memories m
        JOIN agent_runs ar ON ar.id=m.created_by_run_id JOIN episodes e ON e.id=ar.episode_id
        WHERE e.historical_campaign_id=?`).get(c.id) as { n: number };
      campaign = { id: c.id, status: c.status, direction: c.direction, fromAtMs: c.from_at_ms,
        toAtMs: c.to_at_ms, model: c.model, thinkingLevel: c.thinking_level,
        dailyBudgetUsd: Number(c.daily_budget_usd), totalBudgetUsd: Number(c.total_budget_usd),
        spentTodayUsd: Number(usage.today), spentTotalUsd: Number(usage.total),
        eligibleMessages: Number(eligible.n), channels: Number(progress.channels),
        completeChannels: Number(progress.complete), messagesScanned: Number(progress.scanned),
        episodesCreated: Number(progress.episodes), pendingReviews: Number(campaignPending.n),
        modelRuns: Number(usage.runs), memoriesCreated: Number(memories.n) };
    }
  }
  return {
    channels: Number(row.channels),
    complete: Number(row.complete),
    messagesScanned: Number(row.messages_scanned),
    episodesCreated: Number(row.episodes_created),
    pendingReviews: pending,
    campaign,
  };
}

function collectProposalCounts(db: DatabaseSync, now: number): ProposalStatusCounts {
  const by = (status: string) =>
    countWhere(db, 'status.proposals.status', 'SELECT COUNT(*) AS n FROM proposals WHERE status = ?', status);
  const pending = countPendingProposals(db, now);
  return {
    observed: by('observed'),
    // Preserve the original raw HTTP field, while Discord renders the exact
    // actionable predicate used by `/mneme proposals`: equality remains
    // actionable and only a strictly past deadline is stale.
    ...pending,
    approved: by('approved'),
    dismissed: by('dismissed'),
    expired: by('expired'),
    sent: by('sent'),
    failed: by('failed'),
  };
}

function collectOutboxCounts(db: DatabaseSync): OutboxStatusCounts {
  const by = (status: string) =>
    countWhere(db, 'status.outbox.status', 'SELECT COUNT(*) AS n FROM outbox WHERE status = ?', status);
  return {
    queued: by('queued'),
    sending: by('sending'),
    sent: by('sent'),
    failed: by('failed'),
    cancelled: by('cancelled'),
  };
}

function collectPolicyCoverage(db: DatabaseSync): Record<string, number> {
  const rows = prepareCached(
    db,
    'status.policy',
    'SELECT visibility_class, COUNT(*) AS n FROM channels WHERE deleted_at_ms IS NULL GROUP BY visibility_class',
  ).all() as Array<{ visibility_class: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.visibility_class] = row.n;
  return out;
}

function countWhere(db: DatabaseSync, key: string, sql: string, ...params: readonly (string | number)[]): number {
  const row = prepareCached(db, key, sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}
