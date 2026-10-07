import { type DatabaseSync } from './db/database.js';
import { type RuntimeState } from './runtime-state.js';
import { type JobWorker } from './jobs/worker.js';
import { createLogger } from './logger.js';
import type { Logger } from 'pino';

/**
 * Graceful process shutdown (Section 34).
 *
 * On `SIGTERM` or `SIGINT` the process tears down in a fixed order:
 *   1. mark readiness false;
 *   2. stop claiming jobs;
 *   3. stop opening new model runs;
 *   4. allow the current short database transaction to finish;
 *   5. wait up to `SHUTDOWN_TIMEOUT_SECONDS` (default 30) for in-flight work;
 *   6. persist open episode state;
 *   7. disconnect the Discord client;
 *   8. run a WAL checkpoint when safe;
 *   9. close SQLite;
 *  10. exit zero.
 *
 * Anything still running when the deadline elapses is left recoverable: running
 * jobs whose leases later expire and outbox rows in a sending state are picked
 * back up on the next process start (Sections 10, 11.4, 34).
 *
 * The coordinator is the single owner of this sequence. It is idempotent — a
 * second `SIGINT` while shutdown is already in flight returns the same promise
 * rather than restarting the teardown — and it exposes an abort signal so the
 * "stop new model runs" gate can observe that shutdown has begun.
 */

/** The ordered shutdown stages (Section 34). */
export type ShutdownStage =
  | 'readiness'
  | 'drain'
  | 'episodes'
  | 'discord'
  | 'checkpoint'
  | 'database';

/** Outcome of a single stage. */
export type StageStatus = 'ok' | 'skipped' | 'failed' | 'timeout';

export interface ShutdownResult {
  /** True when every in-flight worker handler settled before the deadline. */
  drained: boolean;
  /** True when the drain deadline elapsed before workers settled. */
  timedOut: boolean;
  /** Per-stage outcome, in shutdown order. */
  stages: Record<ShutdownStage, StageStatus>;
  /** Wall-clock duration of the whole sequence in ms. */
  durationMs: number;
}

/**
 * Hooks for each ordered teardown step. Every hook is individually guarded and
 * bounded, so a failure in one stage never prevents the later resource-closing
 * stages from running (the database must still close even if Discord disconnect
 * threw). Tests inject fakes here; {@link createShutdownDeps} builds the real
 * implementations from concrete runtime pieces.
 */
export interface ShutdownDeps {
  /** Step 1: flip readiness to false. */
  markReadinessDown: () => void | Promise<void>;
  /**
   * Steps 2-5: stop claiming new jobs and wait for in-flight handlers to settle.
   * Return true when everything settled cleanly, false when work was still
   * outstanding (its leases will expire and be recovered on the next start).
   * The abort signal is already aborted when this runs.
   */
  drainWorkers: (signal: AbortSignal) => Promise<boolean>;
  /** Step 6: flush any open/in-memory episode state to the database. */
  persistEpisodes: () => void | Promise<void>;
  /** Step 7: disconnect the Discord Gateway client. */
  disconnectDiscord: () => void | Promise<void>;
  /** Step 8: passive or truncate WAL checkpoint, when safe. */
  checkpoint: () => void | Promise<void>;
  /** Step 9: close the SQLite connection. */
  closeDatabase: () => void | Promise<void>;
}

export interface ShutdownCoordinatorOptions {
  /** Overall drain deadline in ms (steps 2-5). Default 30 000. */
  drainDeadlineMs?: number;
  /** Per-teardown-stage timeout in ms (steps 6-9). Default 5 000. */
  stageTimeoutMs?: number;
  log?: Logger;
}

const DEFAULT_DRAIN_DEADLINE_MS = 30_000;
const DEFAULT_STAGE_TIMEOUT_MS = 5_000;

/**
 * Drives the ordered shutdown sequence once. Idempotent: a second `begin()`
 * returns the already-running promise. The instance is single-use — once the
 * sequence resolves it stays resolved.
 */
export class ShutdownCoordinator {
  private readonly deps: ShutdownDeps;
  private readonly drainDeadlineMs: number;
  private readonly stageTimeoutMs: number;
  private readonly log: Logger;
  private readonly abort = new AbortController();
  private inflight: Promise<ShutdownResult> | null = null;

  constructor(deps: ShutdownDeps, options: ShutdownCoordinatorOptions = {}) {
    this.deps = deps;
    this.drainDeadlineMs = options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
    this.stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
    this.log = options.log ?? createLogger();
  }

  /** Aborted once shutdown has begun — the "stop new model runs" signal (step 3). */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** True once shutdown has begun. */
  isShuttingDown(): boolean {
    return this.abort.signal.aborted;
  }

  /** Begin shutdown. Repeated calls return the same in-flight promise. */
  begin(): Promise<ShutdownResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run();
    return this.inflight;
  }

  private async run(): Promise<ShutdownResult> {
    const startedAt = Date.now();
    const stages: Record<ShutdownStage, StageStatus> = {
      readiness: 'ok',
      drain: 'ok',
      episodes: 'ok',
      discord: 'ok',
      checkpoint: 'ok',
      database: 'ok',
    };
    this.log.info({ event: 'shutdown.begin' }, 'graceful shutdown begun');

    // Step 1: readiness false. Then abort so new runs/work are refused (steps 2-3).
    try {
      await this.deps.markReadinessDown();
    } catch (err) {
      stages.readiness = 'failed';
      this.log.warn({ event: 'shutdown.stage_failed', stage: 'readiness', err: errMsg(err) }, 'readiness-down failed');
    }
    this.abort.abort();

    // Steps 2-5: stop claiming + drain, bounded by the deadline.
    let drained = true;
    let timedOut = false;
    try {
      const settled = await raceWithTimeout(this.deps.drainWorkers(this.abort.signal), this.drainDeadlineMs);
      if (settled === null) {
        timedOut = true;
        drained = false;
        stages.drain = 'timeout';
      } else {
        drained = settled;
        if (!settled) stages.drain = 'timeout';
      }
    } catch (err) {
      drained = false;
      stages.drain = 'failed';
      this.log.warn({ event: 'shutdown.stage_failed', stage: 'drain', err: errMsg(err) }, 'drain failed');
    }
    this.log.info(
      { event: 'shutdown.drained', drained, timedOut },
      drained ? 'in-flight work drained' : 'drain deadline elapsed; recoverable work left for restart',
    );

    // Steps 6-9: resource teardown, each guarded and individually bounded.
    stages.episodes = await this.runStage('episodes', this.deps.persistEpisodes);
    stages.discord = await this.runStage('discord', this.deps.disconnectDiscord);
    stages.checkpoint = await this.runStage('checkpoint', this.deps.checkpoint);
    stages.database = await this.runStage('database', this.deps.closeDatabase);

    const durationMs = Date.now() - startedAt;
    this.log.info({ event: 'shutdown.complete', drained, timedOut, stages, durationMs }, 'shutdown complete');
    return { drained, timedOut, stages, durationMs };
  }

  private async runStage(name: ShutdownStage, fn: () => void | Promise<void>): Promise<StageStatus> {
    try {
      const result = await raceWithTimeout((async () => {
        await fn();
      })(), this.stageTimeoutMs);
      if (result === null) {
        this.log.warn({ event: 'shutdown.stage_timeout', stage: name }, `${name} stage timed out`);
        return 'timeout';
      }
      return 'ok';
    } catch (err) {
      this.log.warn({ event: 'shutdown.stage_failed', stage: name, err: errMsg(err) }, `${name} stage failed`);
      return 'failed';
    }
  }
}

// ---- concrete deps ----------------------------------------------------------

export interface ShutdownRuntime {
  db: DatabaseSync;
  /** The read-only platform archive, closed with the live database (plan 011). */
  archiveDb?: DatabaseSync;
  runtime: RuntimeState;
  /** Workers whose claiming should stop and whose in-flight work should drain. */
  workers?: readonly JobWorker[];
  /** Discord client with a `destroy()` (Gateway disconnect). */
  discord?: { destroy?: () => void | Promise<void> };
  /** Flush open/in-memory episode state to the database (step 6). */
  persistOpenEpisodes?: () => void | Promise<void>;
  /** Stop in-process periodic timers before draining durable work. */
  stopSchedulers?: () => void | Promise<void>;
  /** Stop accepting HTTP requests before the database is closed. */
  closeHttp?: () => void | Promise<void>;
}

/**
 * Build the {@link ShutdownDeps} from concrete runtime pieces. Every hook is
 * defensive about an absent piece (no workers, no discord, no episode flusher)
 * so the same coordinator works before the full bootstrap has wired everything.
 */
export function createShutdownDeps(rt: ShutdownRuntime): ShutdownDeps {
  return {
    markReadinessDown: async () => {
      rt.runtime.beginShutdown();
      await rt.stopSchedulers?.();
    },
    drainWorkers: async () => {
      const workers = rt.workers ?? [];
      if (workers.length === 0) return true;
      const results = await Promise.all(workers.map((w) => w.waitForShutdown()));
      return results.every((ok) => ok === true);
    },
    persistEpisodes: async () => {
      if (rt.persistOpenEpisodes) await rt.persistOpenEpisodes();
    },
    disconnectDiscord: async () => {
      let failure: unknown;
      try { if (rt.discord?.destroy) await rt.discord.destroy(); } catch (err) { failure = err; }
      try { if (rt.closeHttp) await rt.closeHttp(); } catch (err) { failure ??= err; }
      if (failure) throw failure;
    },
    checkpoint: () => {
      // TRUNCATE checkpoints as much as possible and truncates the WAL back to
      // the db when no readers hold it. Safe at shutdown when work has drained.
      rt.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },
    closeDatabase: () => {
      try {
        rt.archiveDb?.close();
      } finally {
        rt.db.close();
      }
    },
  };
}

// ---- signal handlers --------------------------------------------------------

/** Minimal process surface the signal installer needs (for test fakes). */
export interface SignalHandlerTarget {
  on(event: 'SIGTERM' | 'SIGINT', listener: (signal: NodeJS.Signals) => void): unknown;
  off(event: 'SIGTERM' | 'SIGINT', listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code?: number): void;
}

export interface SignalHandlerOptions {
  log?: Logger;
  /** Defaults to `process`. */
  target?: SignalHandlerTarget;
}

/**
 * Install SIGTERM/SIGINT handlers that run the given coordinator and then exit
 * zero. Idempotent at the coordinator level (a repeat signal reuses the promise).
 * Returns a function that removes the handlers (for tests).
 */
export function installShutdownSignalHandlers(
  coordinator: ShutdownCoordinator,
  opts: SignalHandlerOptions = {},
): () => void {
  const log = opts.log ?? createLogger();
  const target = opts.target ?? (process as unknown as SignalHandlerTarget);
  let exiting = false;
  const handler = (signal: NodeJS.Signals): void => {
    log.info({ event: 'shutdown.signal', signal }, 'shutdown signal received');
    // Only the first signal drives the exit; later signals reuse the same
    // (idempotent) coordinator promise and are otherwise ignored.
    if (exiting) return;
    exiting = true;
    void coordinator
      .begin()
      .then(() => {
        log.info({ event: 'shutdown.exit', code: 0 }, 'shutdown complete; exiting');
        target.exit(0);
      })
      .catch((err) => {
        log.error({ event: 'shutdown.exit_failed', err: errMsg(err) }, 'shutdown errored; exiting nonzero');
        target.exit(1);
      });
  };
  target.on('SIGTERM', handler);
  target.on('SIGINT', handler);
  return () => {
    target.off('SIGTERM', handler);
    target.off('SIGINT', handler);
  };
}

// ---- the process-wide coordinator registry ----------------------------------
//
// The full runtime (db, discord, workers) is assembled by the application
// bootstrap. `main` installs default signal handlers that exit cleanly; once
// the bootstrap builds a coordinator it publishes it here so the handlers run
// the real sequence.

let registeredCoordinator: ShutdownCoordinator | null = null;

/** Publish the process-wide coordinator (called by the bootstrap). */
export function setShutdownCoordinator(coordinator: ShutdownCoordinator | null): void {
  registeredCoordinator = coordinator;
}

/**
 * Install default SIGTERM/SIGINT handlers bound to the registered coordinator.
 * With no coordinator registered yet (bootstrap pending) a signal logs and
 * exits zero. Returns a remover (for tests).
 */
export function installDefaultSignalHandlers(opts: SignalHandlerOptions = {}): () => void {
  const log = opts.log ?? createLogger();
  const target = opts.target ?? (process as unknown as SignalHandlerTarget);
  let exiting = false;
  const handler = (signal: NodeJS.Signals): void => {
    log.info({ event: 'shutdown.signal', signal }, 'shutdown signal received');
    if (exiting) return;
    exiting = true;
    const coordinator = registeredCoordinator;
    if (!coordinator) {
      log.warn({ event: 'shutdown.no_coordinator' }, 'no shutdown coordinator registered; exiting');
      target.exit(0);
      return;
    }
    void coordinator
      .begin()
      .then(() => {
        log.info({ event: 'shutdown.exit', code: 0 }, 'shutdown complete; exiting');
        target.exit(0);
      })
      .catch((err) => {
        log.error({ event: 'shutdown.exit_failed', err: errMsg(err) }, 'shutdown errored; exiting nonzero');
        target.exit(1);
      });
  };
  target.on('SIGTERM', handler);
  target.on('SIGINT', handler);
  return () => {
    target.off('SIGTERM', handler);
    target.off('SIGINT', handler);
  };
}

// ---- helpers ----------------------------------------------------------------

/** Resolve with `null` after `ms`, so a stage can be bounded without cancelling it. */
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
