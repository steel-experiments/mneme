import { type DatabaseSync } from './db/database.js';
import { prepareCached } from './db/repositories/util.js';
import type { AutonomyMode } from './config.js';

/**
 * Runtime readiness state (Sections 9.2, 32.2, 34).
 *
 * `/readyz` returns 200 only after every required startup milestone has been
 * reached and while the process is not shutting down. Each milestone is a
 * **monotonic** flag — once the milestone is reached for this process it is
 * never cleared — so the only thing that can take readiness back down is the
 * current `shuttingDown` flag. This is what lets readiness survive a transient
 * model outage or a long-running backfill: they are simply not inputs to the
 * readiness gate (Section 21: "readiness may report degraded rather than fail
 * after initial startup"; Section 32.2: "Historical backfill does not need to be
 * complete").
 *
 * The required milestones, in startup order (Section 9.2):
 *   1. migrations applied;
 *   2. policy and prompts compiled;
 *   3. Discord authenticated at least once for this process;
 *   4. command registration completed.
 *
 * `modelCurrentlyHealthy` is tracked but is deliberately **non-gating**: it is
 * surfaced for `/status` and may warrant a "degraded" report, but it never
 * changes `isReady()` once the initial milestones are met.
 */

/** The required readiness milestones, in startup order. */
export type ReadinessMilestone =
  | 'migrationsApplied'
  | 'policyAndPromptsCompiled'
  | 'discordAuthenticatedOnce'
  | 'commandsRegistered';

export const READINESS_ORDER: readonly ReadinessMilestone[] = [
  'migrationsApplied',
  'policyAndPromptsCompiled',
  'discordAuthenticatedOnce',
  'commandsRegistered',
];

/** Safe, content-free reason codes surfaced by `/readyz` when not ready. */
export type ReadinessReasonCode =
  | 'migrations_pending'
  | 'policy_prompts_pending'
  | 'discord_auth_pending'
  | 'commands_pending'
  | 'shutting_down';

const REASON_CODES: Record<ReadinessMilestone, ReadinessReasonCode> = {
  migrationsApplied: 'migrations_pending',
  policyAndPromptsCompiled: 'policy_prompts_pending',
  discordAuthenticatedOnce: 'discord_auth_pending',
  commandsRegistered: 'commands_pending',
};

export interface ReadinessSnapshot {
  migrationsApplied: boolean;
  policyAndPromptsCompiled: boolean;
  discordAuthenticatedOnce: boolean;
  commandsRegistered: boolean;
  shuttingDown: boolean;
  /** True iff every required milestone is met and shutdown has not begun. */
  ready: boolean;
  /** Non-gating current model health, surfaced for `/status` only. */
  modelCurrentlyHealthy: boolean;
}

/**
 * Mutable process-wide readiness state. Milestone markers are idempotent and
 * only ever set their flag to true — there is intentionally no API to clear a
 * milestone, which is what makes readiness monotonic and immune to later
 * degradation. {@link beginShutdown} is the single transition that ends
 * readiness.
 */
export class RuntimeState {
  private migrationsApplied = false;
  private policyAndPromptsCompiled = false;
  private discordAuthenticatedOnce = false;
  private commandsRegistered = false;
  private shuttingDown = false;
  private modelCurrentlyHealthy = false;

  /** Milestone 1: SQLite opened and migrated. */
  markMigrationsApplied(): void {
    this.migrationsApplied = true;
  }
  /** Milestone 2: channel policy parsed and prompts compiled. */
  markPolicyAndPromptsCompiled(): void {
    this.policyAndPromptsCompiled = true;
  }
  /** Milestone 3: the Discord Gateway authenticated at least once this process. */
  markDiscordAuthenticated(): void {
    this.discordAuthenticatedOnce = true;
  }
  /** Milestone 4: slash commands registered with Discord. */
  markCommandsRegistered(): void {
    this.commandsRegistered = true;
  }

  /** Begin graceful shutdown; readiness becomes and stays false (Section 34). */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** Non-gating: record that the model is currently reachable. */
  markModelHealthy(): void {
    this.modelCurrentlyHealthy = true;
  }
  /** Non-gating: record a model outage; does NOT affect readiness. */
  markModelDegraded(): void {
    this.modelCurrentlyHealthy = false;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** The first milestone still pending in startup order, or null when all are met. */
  pendingMilestone(): ReadinessMilestone | null {
    for (const m of READINESS_ORDER) {
      if (!this.flag(m)) return m;
    }
    return null;
  }

  /**
   * True iff every required milestone is met and shutdown has not begun. Model
   * health and backfill progress are intentionally excluded so a transient model
   * outage or in-flight backfill cannot undo readiness after startup.
   */
  isReady(): boolean {
    return !this.shuttingDown && this.pendingMilestone() === null;
  }

  /** The single reason `/readyz` is not ready, or null when ready. */
  blockingReason(): ReadinessReasonCode | null {
    if (this.shuttingDown) return 'shutting_down';
    const pending = this.pendingMilestone();
    return pending ? REASON_CODES[pending] : null;
  }

  /** A copy of every flag, for `/status` and tests. */
  snapshot(): ReadinessSnapshot {
    return {
      migrationsApplied: this.migrationsApplied,
      policyAndPromptsCompiled: this.policyAndPromptsCompiled,
      discordAuthenticatedOnce: this.discordAuthenticatedOnce,
      commandsRegistered: this.commandsRegistered,
      shuttingDown: this.shuttingDown,
      ready: this.isReady(),
      modelCurrentlyHealthy: this.modelCurrentlyHealthy,
    };
  }

  private flag(m: ReadinessMilestone): boolean {
    switch (m) {
      case 'migrationsApplied':
        return this.migrationsApplied;
      case 'policyAndPromptsCompiled':
        return this.policyAndPromptsCompiled;
      case 'discordAuthenticatedOnce':
        return this.discordAuthenticatedOnce;
      case 'commandsRegistered':
        return this.commandsRegistered;
    }
  }
}

// ---------------------------------------------------------------------------
// Durable global pause (Sections 27, 47).
//
// The pause is a kill switch that stops NEW agent reviews and outbound sends
// while Discord ingestion and operational health keep running. Unlike the
// in-memory readiness flags above, it is persisted in the `settings` table so it
// survives a restart: a paused process that crashes comes back up still paused.
// Pause holds queued work only — a review or send already in flight runs to
// completion, since killing a handler mid-send could duplicate a post. Resume
// flips the flag off and the worker, which re-reads it each dispatch round,
// safely releases the accumulated review/send work.
// ---------------------------------------------------------------------------

const PAUSE_SETTINGS_KEY = 'pause_state';

/** The persisted pause state. */
export interface PauseState {
  paused: boolean;
  /** Epoch ms when the pause took effect, or null when running. */
  pausedAtMs: number | null;
  /** User who paused (admin action), or null when running. */
  pausedByUserId: string | null;
  updatedAtMs: number;
}

const UNPAUSED: PauseState = {
  paused: false,
  pausedAtMs: null,
  pausedByUserId: null,
  updatedAtMs: 0,
};

interface PauseSettingsRow {
  value_json: string;
  updated_at_ms: number;
}

/**
 * Read the persisted pause state. Returns the unpaused default when no row exists
 * (a fresh database is running). Malformed JSON also yields unpaused, so a
 * corrupted setting can never lock the process into a pause it cannot escape —
 * fail open on read; only an explicit pause command fails closed.
 */
export function getPauseState(db: DatabaseSync): PauseState {
  const row = prepareCached(
    db,
    'settings.pause.get',
    'SELECT value_json, updated_at_ms FROM settings WHERE key = ?',
  ).get(PAUSE_SETTINGS_KEY) as PauseSettingsRow | undefined;
  if (!row) return UNPAUSED;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<PauseState>;
    return {
      paused: parsed.paused === true,
      pausedAtMs: typeof parsed.pausedAtMs === 'number' ? parsed.pausedAtMs : null,
      pausedByUserId: typeof parsed.pausedByUserId === 'string' ? parsed.pausedByUserId : null,
      updatedAtMs: row.updated_at_ms,
    };
  } catch {
    return UNPAUSED;
  }
}

/** True when new agent reviews and outbound sends should not be claimed. */
export function isPaused(db: DatabaseSync): boolean {
  return getPauseState(db).paused;
}

export interface SetPausedInput {
  paused: boolean;
  /** Admin who issued the command, when known (audited upstream). */
  actorUserId?: string | null;
  now: number;
}

/**
 * Persist the pause state and return what was written. Pausing stamps the actor
 * and the moment; resuming clears both. The row is upserted, so toggling is
 * idempotent and durable across restarts.
 */
export function setPaused(db: DatabaseSync, input: SetPausedInput): PauseState {
  const state: PauseState = input.paused
    ? { paused: true, pausedAtMs: input.now, pausedByUserId: input.actorUserId ?? null, updatedAtMs: input.now }
    : { paused: false, pausedAtMs: null, pausedByUserId: null, updatedAtMs: input.now };
  prepareCached(
    db,
    'settings.pause.set',
    `INSERT INTO settings (key, value_json, updated_at_ms)
       VALUES (@key, @valueJson, @now)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`,
  ).run({
    key: PAUSE_SETTINGS_KEY,
    valueJson: JSON.stringify(state),
    now: input.now,
  });
  return state;
}

// ---------------------------------------------------------------------------
// Durable runtime mode override (Section 27).
//
// Railway's MNEME_MODE remains the configured baseline. An administrator
// may override it from Discord without granting the bot Railway credentials;
// the override is stored in SQLite and therefore survives a redeploy. Clearing
// it returns control to the configured environment value.
// ---------------------------------------------------------------------------

const MODE_OVERRIDE_SETTINGS_KEY = 'runtime_mode_override';
const AUTONOMY_MODES = new Set<AutonomyMode>(['observe', 'review', 'autonomous']);

export interface RuntimeModeOverride {
  mode: AutonomyMode;
  changedAtMs: number;
  changedByUserId: string | null;
}

/**
 * Read the durable override. A malformed value fails closed to `observe`
 * instead of allowing a broader environment mode to take effect unnoticed.
 */
export function getRuntimeModeOverride(db: DatabaseSync): RuntimeModeOverride | null {
  const row = prepareCached(
    db,
    'settings.runtime_mode.get',
    'SELECT value_json, updated_at_ms FROM settings WHERE key = ?',
  ).get(MODE_OVERRIDE_SETTINGS_KEY) as PauseSettingsRow | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<RuntimeModeOverride>;
    if (!AUTONOMY_MODES.has(parsed.mode as AutonomyMode)) throw new Error('invalid mode');
    return {
      mode: parsed.mode as AutonomyMode,
      changedAtMs: row.updated_at_ms,
      changedByUserId: typeof parsed.changedByUserId === 'string' ? parsed.changedByUserId : null,
    };
  } catch {
    return { mode: 'observe', changedAtMs: row.updated_at_ms, changedByUserId: null };
  }
}

export interface SetRuntimeModeOverrideInput {
  mode: AutonomyMode | null;
  actorUserId?: string | null;
  now: number;
}

/** Set an override, or clear it when `mode` is null. */
export function setRuntimeModeOverride(
  db: DatabaseSync,
  input: SetRuntimeModeOverrideInput,
): RuntimeModeOverride | null {
  if (input.mode === null) {
    prepareCached(
      db,
      'settings.runtime_mode.clear',
      'DELETE FROM settings WHERE key = ?',
    ).run(MODE_OVERRIDE_SETTINGS_KEY);
    return null;
  }
  const state: RuntimeModeOverride = {
    mode: input.mode,
    changedAtMs: input.now,
    changedByUserId: input.actorUserId ?? null,
  };
  prepareCached(
    db,
    'settings.runtime_mode.set',
    `INSERT INTO settings (key, value_json, updated_at_ms)
       VALUES (@key, @valueJson, @now)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`,
  ).run({ key: MODE_OVERRIDE_SETTINGS_KEY, valueJson: JSON.stringify(state), now: input.now });
  return state;
}
