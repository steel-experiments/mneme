import { statSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import { type DatabaseSync } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';
import { backupInventory } from '../db/backup.js';
import type { BuildInfo } from '../build-info.js';
import type { RuntimeState } from '../runtime-state.js';
import { orgDayStartMs } from '../agent/cooldowns.js';
import type { StatusProvider, StatusSnapshot } from './server.js';
import {
  collectStatusReport,
  type GatewayStatus,
  type ModelStatus,
  type BackupStatus,
  type StatusRuntimeInputs,
} from '../commands/status.js';

/**
 * `/status` operational snapshot (Section 32.3).
 *
 * The database-side fields are aggregated by the shared collector
 * {@link collectStatusReport} — the same function the `/mneme status` slash
 * command uses, so there is one source of truth for channel, sync, queue,
 * proposal, outbox, and database-size counts. This module is the HTTP adapter:
 * it assembles the host-supplied {@link StatusRuntimeInputs} (Gateway state, model
 * health, backup recency, WAL size) from injected accessors and the filesystem,
 * then enriches the report with the few Section 32.3 fields the shared shape does
 * not carry — `version`, `uptime`, the database `path`, Gateway `pingMs`, open
 * episodes, distinct model last-success/last-failure timestamps, and the daily
 * post count.
 *
 * The endpoint is reachable only after the HTTP layer's constant-time bearer
 * check passes (Section 32.3); when `HTTP_ADMIN_TOKEN` is unset the server
 * returns `404` before this provider is consulted, so its existence is not
 * discoverable. The snapshot is counts, sizes, timestamps, and short identifiers
 * only — never tokens, raw messages, prompt bodies, or provider secrets. The
 * provider never reads `config.discord.token`, `config.llm.apiKey`,
 * `config.httpAdminToken`, message content, episode summaries, or proposal text.
 */

/** Discord-derived health, supplied by an injected accessor (no token). */
export interface DiscordHealthSnapshot {
  connected: boolean;
  ready: boolean;
  pingMs: number | null;
  /** Epoch ms of the most recent Gateway event, or null when none recorded. */
  lastEventAtMs: number | null;
  reconnectCount: number;
}

export interface StatusProviderDeps {
  db: DatabaseSync;
  config: AppConfig;
  /** Safe identity resolved once at process startup. */
  buildInfo: BuildInfo;
  /** Process readiness state, for the `ready`/`shuttingDown` fields. */
  runtime: RuntimeState;
  /** Process start time (epoch ms); the basis for uptime. */
  startedAtMs: number;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  /** Backups directory (default `config`-derived `DATA_DIR/backups`). */
  backupsDir?: string;
  /**
   * Optional Discord-health accessor. Live ping, ready state, and last-event
   * come from the Discord wiring, injected here. When absent the Gateway fields
   * report unknown rather than failing the endpoint.
   */
  discord?: () => DiscordHealthSnapshot | null;
}

/**
 * The Section 32.3 snapshot: the shared {@link collectStatusReport} result plus
 * the enriched HTTP-only fields. Typed for clarity; the server treats it opaque.
 */
export type OperationalStatusSnapshot = StatusSnapshot &
  ReturnType<typeof buildStatusSnapshot>;

/**
 * Build the Section 32.3 snapshot. Reuses {@link collectStatusReport} for every
 * database-derived field and enriches with version/uptime/path/ping/episodes/
 * model-timestamps/daily-posts. Pure and synchronous; the HTTP layer awaits the
 * provider regardless. A missing WAL, backup, or Discord tracker reports
 * null/zero rather than throwing — the status endpoint must stay available.
 */
export function buildStatusSnapshot(deps: StatusProviderDeps): Record<string, unknown> {
  const now = (deps.now ?? Date.now)();
  const discord = deps.discord ? safe(deps.discord) : null;
  const gateway: GatewayStatus = {
    connected: discord?.connected ?? false,
    ready: discord?.ready ?? false,
    lastEventAtMs: discord?.lastEventAtMs ?? null,
    reconnectCount: discord?.reconnectCount ?? 0,
  };
  const model = modelRuntime(deps.db, deps.runtime, {
    dayStartMs: orgDayStartMs(now, deps.config.organization.timezone),
    dailyBudgetUsd: deps.config.llm.dailyBudgetUsd ?? null,
  });
  const backup = backupRuntime(deps.backupsDir ?? `${deps.config.dataDir}/backups`);

  const runtimeInputs: StatusRuntimeInputs = {
    nowMs: now,
    build: deps.buildInfo,
    mode: deps.config.mode,
    gateway,
    model: model.status,
    backup: backup.status,
    walSizeBytes: fileSize(`${deps.config.databasePath}-wal`),
    historicalCampaign: deps.config.historicalMemory?.campaignId
      ? { id: deps.config.historicalMemory.campaignId,
          dayStartMs: orgDayStartMs(now, deps.config.organization.timezone) }
      : undefined,
  };

  const report = collectStatusReport(deps.db, runtimeInputs);

  return {
    ...report,
    version: report.build.appVersion,
    startedAtMs: deps.startedAtMs,
    uptimeMs: Math.max(0, now - deps.startedAtMs),
    ready: deps.runtime.isReady(),
    shuttingDown: deps.runtime.isShuttingDown(),
    discord: {
      ...gateway,
      pingMs: discord?.pingMs ?? null,
    },
    database: { ...report.database, path: deps.config.databasePath },
    episodes: { open: openEpisodeCount(deps.db) },
    model: { ...report.model, ...model.enriched },
    dailyPostCount: dailyPostCount(deps.db, now, deps.config.organization.timezone),
  };
}

/**
 * Build a {@link StatusProvider} bound to `deps`. The HTTP layer calls this only
 * after the constant-time bearer check passes (Section 32.3).
 */
export function createStatusProvider(deps: StatusProviderDeps): StatusProvider {
  return () => buildStatusSnapshot(deps);
}

/** Derive the model health and usage fields from agent_runs + the runtime health flag. */
function modelRuntime(
  db: DatabaseSync,
  runtime: RuntimeState,
  opts: { dayStartMs: number; dailyBudgetUsd: number | null },
): {
  status: ModelStatus;
  enriched: { lastSuccessMs: number | null; lastFailureMs: number | null };
} {
  const lastCall = prepareCached(
    db,
    'status.model.lastCall',
    'SELECT MAX(started_at_ms) AS ms FROM agent_runs',
  ).get() as { ms: number | null } | undefined;
  const usage = prepareCached(
    db,
    'status.model.usage',
    `SELECT COALESCE(SUM(CASE WHEN started_at_ms >= ? THEN cost_usd ELSE 0 END), 0) AS spent_today,
            COALESCE(SUM(CASE WHEN started_at_ms >= ? THEN input_tokens ELSE 0 END), 0) AS in_today,
            COALESCE(SUM(CASE WHEN started_at_ms >= ? THEN output_tokens ELSE 0 END), 0) AS out_today,
            COALESCE(SUM(cost_usd), 0) AS spent_total,
            COALESCE(SUM(input_tokens), 0) AS in_total,
            COALESCE(SUM(output_tokens), 0) AS out_total
       FROM agent_runs`,
  ).get(opts.dayStartMs, opts.dayStartMs, opts.dayStartMs) as {
    spent_today: number; in_today: number; out_today: number;
    spent_total: number; in_total: number; out_total: number;
  };
  const lastSuccess = prepareCached(
    db,
    'status.model.success',
    "SELECT MAX(ended_at_ms) AS ms FROM agent_runs WHERE status = 'completed'",
  ).get() as { ms: number | null } | undefined;
  const lastFailure = prepareCached(
    db,
    'status.model.failure',
    "SELECT MAX(ended_at_ms) AS ms FROM agent_runs WHERE status IN ('failed', 'rejected')",
  ).get() as { ms: number | null } | undefined;
  const successMs = lastSuccess?.ms ?? null;
  const failureMs = lastFailure?.ms ?? null;
  // Healthy when the runtime flag says so, or when there is no failure more
  // recent than the last success (and at least one run has happened).
  const healthy = runtime.snapshot().modelCurrentlyHealthy
    || (failureMs === null ? true : successMs !== null && successMs >= failureMs);
  return {
    status: {
      healthy,
      lastCallAtMs: lastCall?.ms ?? null,
      dailyBudgetUsd: opts.dailyBudgetUsd,
      today: {
        costUsd: Number(usage.spent_today),
        inputTokens: Number(usage.in_today),
        outputTokens: Number(usage.out_today),
      },
      allTime: {
        costUsd: Number(usage.spent_total),
        inputTokens: Number(usage.in_total),
        outputTokens: Number(usage.out_total),
      },
    },
    enriched: { lastSuccessMs: successMs, lastFailureMs: failureMs },
  };
}

/** Derive backup recency from the backups directory listing. */
function backupRuntime(backupsDir: string): { status: BackupStatus } {
  return { status: safe(() => backupInventory(backupsDir)) ?? { lastBackupAtMs: null, count: 0 } };
}

/** Count open episodes (Section 32.3 "open episodes"). */
function openEpisodeCount(db: DatabaseSync): number {
  const row = prepareCached(db, 'status.episodes.open', "SELECT COUNT(*) AS c FROM episodes WHERE status = 'open'").get() as
    | { c: number }
    | undefined;
  return Number(row?.c ?? 0);
}

/**
 * Count outbound posts sent since the start of the current org day (Section 32.3
 * "current daily post count"). The org-day boundary is computed from the
 * configured organization timezone (shared with the cooldown policy so "today"
 * means the same thing); on any timezone error it falls back to the start of the
 * UTC day so the field is always present.
 */
function dailyPostCount(db: DatabaseSync, now: number, timezone: string): number {
  const sinceMs = safe(() => orgDayStartMs(now, timezone)) ?? startOfUtcDay(now);
  const row = prepareCached(
    db,
    'status.dailyPosts',
    "SELECT COUNT(*) AS c FROM outbox WHERE status = 'sent' AND sent_at_ms IS NOT NULL AND sent_at_ms >= ?",
  ).get(sinceMs) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/** File size in bytes, or null when the file is absent (a missing WAL is normal). */
function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Start of the current UTC day (epoch ms). */
function startOfUtcDay(now: number): number {
  return now - (now % 86_400_000);
}

/** Run `fn`, returning its value or null on any throw. */
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
