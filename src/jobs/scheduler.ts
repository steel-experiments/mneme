import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { EnqueueInput, JobType } from './types.js';

/**
 * Periodic operational scheduler (Sections 5.1, 9.6, 10, 12.4, 28, 42).
 *
 * Mneme has no external cron. Recurring operational work — channel
 * reconciliation, thread discovery, due-memory review, backups, and the
 * maintenance bundle (WAL checkpoints, `PRAGMA optimize`, proposal expiry,
 * cache convergence) — is driven by in-process timers that *enqueue* durable,
 * unique-keyed jobs rather than doing the work inline. Enqueuing (not executing)
 * keeps long work on the bounded job queue, and the per-spec unique key means a
 * restart or a slow tick never piles up duplicate active jobs (the queue's
 * `DO NOTHING` collapses them).
 *
 * Time is abstracted behind a {@link TimerDriver} so tests can drive a fake
 * clock; production uses {@link nodeTimerDriver}. {@link PeriodicScheduler.stop}
 * clears every live timer, so shutdown leaves nothing pending.
 */

/** Opaque timer handle produced by a {@link TimerDriver}. */
export type TimerHandle = unknown;

/**
 * Abstraction over the clock and one-shot timers. Production wraps
 * `setTimeout`/`clearTimeout`; tests inject a fake clock they can advance.
 */
export interface TimerDriver {
  now(): number;
  schedule(callback: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

/**
 * One periodic job: fire `run` every `intervalMs`. The first tick resumes from
 * the last recorded run (see {@link initialDelayMs}); with no record it fires
 * one interval out.
 */
export interface ScheduleSpec {
  readonly name: string;
  readonly intervalMs: number;
  /** Invoked once per elapsed interval; typically enqueues a unique job. */
  readonly run: (now: number) => void;
  /**
   * When this schedule last ran (epoch ms), read from durable state at boot;
   * null or absent when it never ran. A process restarted more often than an
   * interval would otherwise never fire the schedule.
   */
  readonly lastRunMs?: number | null;
  /** Added to the first delay so two schedules with equal history do not fire together. */
  readonly staggerMs?: number;
}

/**
 * Shortest first delay for a schedule that is overdue at boot: long enough for
 * startup work (migrations, reconnect, outbox recovery) to settle first.
 */
export const STARTUP_GRACE_MS = 60_000;

/**
 * The backup fires this long after the maintenance bundle. Both default to the
 * same 24-hour interval and, resumed from equal history, would arm for the
 * same instant; the online backup then overlaps the WAL checkpoint and fails
 * its first attempt, leaving a partial file until the retry.
 */
export const BACKUP_STAGGER_MS = 15 * 60_000;

/**
 * First delay for a spec at boot. Never run: one full interval, so a fresh
 * install does not start every schedule at once. Otherwise the remaining part
 * of the interval since the last run, clamped between the startup grace and
 * one interval, so an overdue schedule fires soon after boot and a schedule
 * that just ran keeps its cadence. The stagger is added on top.
 */
export function initialDelayMs(spec: ScheduleSpec, now: number): number {
  const lastRun = spec.lastRunMs;
  const base = lastRun === null || lastRun === undefined
    ? spec.intervalMs
    : Math.min(spec.intervalMs, Math.max(STARTUP_GRACE_MS, lastRun + spec.intervalMs - now));
  return base + (spec.staggerMs ?? 0);
}

/** Stable unique keys so duplicate active jobs collapse across restarts/ticks. */
export const RECONCILE_CHANNEL_KEY = (channelId: string) => `schedule:reconcile:channel:${channelId}`;
export const DISCOVER_THREADS_KEY = 'schedule:discover-threads';
export const REVIEW_DUE_KEY = 'schedule:review-due-memories';
export const BACKUP_KEY = 'schedule:backup';
export const MAINTENANCE_KEY = 'schedule:maintenance';
export const HISTORICAL_MEMORY_KEY = 'schedule:historical-memory';

/** Daily cadence for surfacing due predictions/assumptions (Section 12.4). */
export const DEFAULT_REVIEW_DUE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Drives a set of {@link ScheduleSpec}s. Each spec arms a one-shot timer for its
 * interval; when it fires, `run` is invoked and the timer is re-armed, so the
 * period is measured from tick to tick. A thrown `run` is logged and swallowed
 * — one failing enqueue must not stall the schedule. {@link stop} clears every
 * live timer and prevents any already-queued callback from acting.
 */
export class PeriodicScheduler {
  private readonly live = new Map<string, TimerHandle>();
  private stopped = false;

  constructor(
    private readonly driver: TimerDriver,
    private readonly logger?: Logger,
  ) {}

  /** Arm every spec. Specs are independent; a later failure does not undo earlier arms. */
  start(specs: readonly ScheduleSpec[]): void {
    const now = this.driver.now();
    for (const spec of specs) {
      if (spec.intervalMs <= 0) continue; // defensive: a disabled/zero interval never fires
      const delayMs = initialDelayMs(spec, now);
      this.logger?.info(
        { event: 'scheduler.armed', spec: spec.name, delayMs, lastRunMs: spec.lastRunMs ?? null },
        'periodic schedule armed',
      );
      this.arm(spec, delayMs);
    }
  }

  /** Number of currently live timers (0 after {@link stop}). */
  get liveCount(): number {
    return this.live.size;
  }

  private arm(spec: ScheduleSpec, delayMs: number): void {
    if (this.stopped) return;
    if (spec.intervalMs <= 0) return; // defensive: a disabled/zero interval never fires
    const handle = this.driver.schedule(() => this.tick(spec), delayMs);
    this.live.set(spec.name, handle);
  }

  private tick(spec: ScheduleSpec): void {
    // Clear the handle before running: the tick re-arms itself on completion, so
    // the entry is refreshed; if stop() ran, do nothing.
    this.live.delete(spec.name);
    if (this.stopped) return;
    const now = this.driver.now();
    try {
      spec.run(now);
    } catch (err) {
      this.logger?.warn(
        { event: 'scheduler.tick_error', spec: spec.name, err: err instanceof Error ? err.message : String(err) },
        'scheduled tick threw; will re-arm',
      );
    }
    this.arm(spec, spec.intervalMs);
  }

  /** Clear every live timer and halt. Idempotent. No further ticks will fire. */
  stop(): void {
    this.stopped = true;
    for (const handle of this.live.values()) this.driver.clear(handle);
    this.live.clear();
  }
}

/** Production timer driver backed by Node's `setTimeout`/`Date.now`. */
export const nodeTimerDriver: TimerDriver = {
  now: () => Date.now(),
  schedule: (cb, delayMs) => setTimeout(cb, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Dependencies needed to turn configuration into enqueueing schedule specs. */
export interface ScheduleDeps {
  /** Enqueue a durable job; collapses duplicate active unique jobs. */
  enqueue: <T extends JobType>(input: EnqueueInput<T>) => { id: string; enqueued: boolean };
  /** Channel ids to reconcile periodically (injected so the scheduler need not read the DB). */
  channelIds: () => Iterable<string>;
  /**
   * Most recent run of a schedule, read from durable job history by unique key
   * (`exact`) or by key prefix (`prefix`, for per-channel fan-out). Absent, every
   * schedule starts one interval out.
   */
  lastRunMs?: (key: string, match: 'exact' | 'prefix') => number | null;
  /**
   * The platform's full rediscovery interval. When set, the discovery schedule
   * runs at this interval instead of the thread-discovery interval (Slack).
   */
  channelDiscoveryIntervalMs?: number;
}

/**
 * Build the periodic schedule specs from validated configuration. Each spec
 * enqueues its job(s) with a stable unique key, so a restart or overlapping tick
 * never queues duplicate active work. Reconciliation fans out per channel; the
 * other concerns are single unique jobs. Backup is omitted when disabled.
 */
export function buildSchedules(config: AppConfig, deps: ScheduleDeps): ScheduleSpec[] {
  const specs: ScheduleSpec[] = [];

  // Reconciliation (Section 9.6): per channel, at the reconcile interval.
  specs.push({
    name: 'reconcile',
    intervalMs: config.ingestion.reconcileIntervalMinutes * MINUTE_MS,
    lastRunMs: deps.lastRunMs?.(RECONCILE_CHANNEL_KEY(''), 'prefix') ?? null,
    run: (now) => {
      for (const channelId of deps.channelIds()) {
        deps.enqueue({
          type: 'reconcile_channel',
          payload: { channelId },
          uniqueKey: RECONCILE_CHANNEL_KEY(channelId),
          now,
        });
      }
    },
  });

  // Thread discovery (Section 9.7): discover active/archived threads periodically.
  specs.push({
    name: 'discover-threads',
    intervalMs: deps.channelDiscoveryIntervalMs ?? config.ingestion.threadDiscoveryIntervalMinutes * MINUTE_MS,
    lastRunMs: deps.lastRunMs?.(DISCOVER_THREADS_KEY, 'exact') ?? null,
    run: (now) => {
      deps.enqueue({ type: 'discover_threads', payload: {}, uniqueKey: DISCOVER_THREADS_KEY, now });
    },
  });

  // Due-memory review (Section 12.4): surface due predictions/assumptions.
  specs.push({
    name: 'review-due-memories',
    intervalMs: DEFAULT_REVIEW_DUE_INTERVAL_MS,
    lastRunMs: deps.lastRunMs?.(REVIEW_DUE_KEY, 'exact') ?? null,
    run: (now) => {
      deps.enqueue({ type: 'review_due_memories', payload: {}, uniqueKey: REVIEW_DUE_KEY, now });
    },
  });

  if (config.historicalMemory.enabled) {
    specs.push({
      name: 'historical-memory',
      intervalMs: 5 * MINUTE_MS,
      lastRunMs: deps.lastRunMs?.(HISTORICAL_MEMORY_KEY, 'exact') ?? null,
      run: (now) => {
        deps.enqueue({
          type: 'build_historical_episodes',
          payload: {},
          uniqueKey: HISTORICAL_MEMORY_KEY,
          priority: 200,
          now,
        });
      },
    });
  }

  // Maintenance bundle (Sections 28, 42): checkpoints, PRAGMA optimize, proposal
  // expiry, cache convergence — one periodic maintenance job covers them.
  specs.push({
    name: 'maintenance',
    intervalMs: config.maintenance.pragmaOptimizeIntervalHours * HOUR_MS,
    lastRunMs: deps.lastRunMs?.(MAINTENANCE_KEY, 'exact') ?? null,
    run: (now) => {
      deps.enqueue({ type: 'maintenance', payload: {}, uniqueKey: MAINTENANCE_KEY, now });
    },
  });

  // Backups (Section 42): only when enabled.
  if (config.maintenance.backupEnabled) {
    specs.push({
      name: 'backup',
      intervalMs: config.maintenance.backupIntervalHours * HOUR_MS,
      lastRunMs: deps.lastRunMs?.(BACKUP_KEY, 'exact') ?? null,
      staggerMs: BACKUP_STAGGER_MS,
      run: (now) => {
        deps.enqueue({ type: 'backup_database', payload: {}, uniqueKey: BACKUP_KEY, now });
      },
    });
  }

  return specs;
}
