import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  PeriodicScheduler,
  buildSchedules,
  nodeTimerDriver,
  initialDelayMs,
  STARTUP_GRACE_MS,
  BACKUP_STAGGER_MS,
  DEFAULT_REVIEW_DUE_INTERVAL_MS,
  RECONCILE_CHANNEL_KEY,
  DISCOVER_THREADS_KEY,
  REVIEW_DUE_KEY,
  BACKUP_KEY,
  MAINTENANCE_KEY,
  type TimerDriver,
  type ScheduleSpec,
} from '../../src/jobs/scheduler.js';
import type { EnqueueInput, JobType } from '../../src/jobs/types.js';

/**
 * Periodic operational scheduler (Sections 5.1, 9.6, 10, 12.4, 28, 42).
 *
 * Acceptance: fake-clock tests prove each job appears at its interval once, and
 * scheduler shutdown leaves no live timers.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Minimal valid environment; tests override intervals. */
function env(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    MNEME_PLATFORM: 'discord',
    DISCORD_TOKEN: 'a-real-discord-token-value',
    DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_GUILD_ID: '234567890123456789',
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'gpt-5.6-terra',
    FULL_HISTORY: 'true',
    OPENAI_API_KEY: 'sk-test-key-value',
    ORG_NAME: 'Test Org',
    ORG_TIMEZONE: 'UTC',
    ...overrides,
  };
}

/** A deterministic fake clock that fires callbacks in scheduled order. */
class FakeClock implements TimerDriver {
  private nowMs: number;
  private queue: Array<{ fireAt: number; cb: () => void; id: number }> = [];
  private cancelled = new Set<number>();
  private seq = 1;
  constructor(start = 0) {
    this.nowMs = start;
  }
  now(): number {
    return this.nowMs;
  }
  schedule(cb: () => void, delayMs: number) {
    const id = this.seq++;
    this.queue.push({ fireAt: this.nowMs + delayMs, cb, id });
    return id;
  }
  clear(handle: unknown): void {
    this.cancelled.add(handle as number);
  }
  /** Advance virtual time, firing every timer due by the target time. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      this.queue = this.queue.filter((q) => !this.cancelled.has(q.id));
      const due = this.queue.filter((q) => q.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0]!;
      this.nowMs = next.fireAt;
      this.queue = this.queue.filter((q) => q !== next);
      next.cb();
    }
    if (this.nowMs < target) this.nowMs = target;
  }
  pending(): number {
    this.queue = this.queue.filter((q) => !this.cancelled.has(q.id));
    return this.queue.length;
  }
}

type EnqueueCall = { type: JobType; payload: unknown; uniqueKey?: string | null; now: number };

function makeEnqueue(returnEnqueued = true) {
  const calls: EnqueueCall[] = [];
  const fn = <T extends JobType>(input: EnqueueInput<T>): { id: string; enqueued: boolean } => {
    calls.push({
      type: input.type,
      payload: input.payload,
      uniqueKey: input.uniqueKey,
      now: input.now,
    });
    return { id: `job-${calls.length}`, enqueued: returnEnqueued };
  };
  return { fn, calls };
}

describe('PeriodicScheduler — fake-clock firing', () => {
  it('fires a spec once per elapsed interval and re-arms', () => {
    const clock = new FakeClock();
    const sched = new PeriodicScheduler(clock);
    let count = 0;
    sched.start([{ name: 'a', intervalMs: 100, run: () => (count += 1) }]);
    expect(sched.liveCount).toBe(1);
    clock.advance(100);
    expect(count).toBe(1);
    clock.advance(100);
    expect(count).toBe(2);
    clock.advance(300);
    expect(count).toBe(5); // 2 + 3 more
    expect(sched.liveCount).toBe(1); // still armed
  });

  it('fires independent specs at their own intervals', () => {
    const clock = new FakeClock();
    const sched = new PeriodicScheduler(clock);
    const counts = { a: 0, b: 0 };
    sched.start([
      { name: 'a', intervalMs: 100, run: () => (counts.a += 1) },
      { name: 'b', intervalMs: 300, run: () => (counts.b += 1) },
    ]);
    clock.advance(300);
    expect(counts).toEqual({ a: 3, b: 1 });
  });

  it('the first tick is one interval out (no immediate fire on start)', () => {
    const clock = new FakeClock();
    const sched = new PeriodicScheduler(clock);
    let count = 0;
    sched.start([{ name: 'a', intervalMs: 100, run: () => (count += 1) }]);
    clock.advance(99);
    expect(count).toBe(0);
    clock.advance(1);
    expect(count).toBe(1);
  });

  it('shutdown clears every live timer and halts firing', () => {
    const clock = new FakeClock();
    const sched = new PeriodicScheduler(clock);
    let count = 0;
    sched.start([
      { name: 'a', intervalMs: 100, run: () => (count += 1) },
      { name: 'b', intervalMs: 200, run: () => (count += 1) },
    ]);
    expect(clock.pending()).toBe(2);
    sched.stop();
    expect(sched.liveCount).toBe(0);
    expect(clock.pending()).toBe(0);
    clock.advance(10_000);
    expect(count).toBe(0);
  });

  it('stop is idempotent', () => {
    const clock = new FakeClock();
    const sched = new PeriodicScheduler(clock);
    sched.start([{ name: 'a', intervalMs: 100, run: () => undefined }]);
    sched.stop();
    expect(() => sched.stop()).not.toThrow();
    expect(sched.liveCount).toBe(0);
  });

  it('a thrown run is swallowed and the spec re-arms', () => {
    const clock = new FakeClock();
    const sched = new PeriodicScheduler(clock);
    let count = 0;
    sched.start([
      {
        name: 'a',
        intervalMs: 100,
        run: () => {
          count += 1;
          if (count === 1) throw new Error('transient');
        },
      },
    ]);
    clock.advance(100); // throws, caught
    expect(count).toBe(1);
    clock.advance(100); // re-armed despite the throw
    expect(count).toBe(2);
    expect(sched.liveCount).toBe(1);
  });
});

describe('PeriodicScheduler — resuming from the last recorded run', () => {
  const noop = () => undefined;

  it('never run: one full interval, as before', () => {
    expect(initialDelayMs({ name: 'a', intervalMs: HOUR, run: noop }, 10 * HOUR)).toBe(HOUR);
    expect(initialDelayMs({ name: 'a', intervalMs: HOUR, lastRunMs: null, run: noop }, 10 * HOUR)).toBe(HOUR);
  });

  it('overdue: fires after the startup grace, not another full interval', () => {
    const now = 10 * HOUR;
    expect(initialDelayMs({ name: 'a', intervalMs: HOUR, lastRunMs: now - 3 * HOUR, run: noop }, now))
      .toBe(STARTUP_GRACE_MS);
  });

  it('partly elapsed: keeps the remaining part of the interval', () => {
    const now = 10 * HOUR;
    expect(initialDelayMs({ name: 'a', intervalMs: HOUR, lastRunMs: now - 20 * MINUTE, run: noop }, now))
      .toBe(40 * MINUTE);
  });

  it('a run recorded in the future (clock skew) is clamped to one interval', () => {
    const now = 10 * HOUR;
    expect(initialDelayMs({ name: 'a', intervalMs: HOUR, lastRunMs: now + HOUR, run: noop }, now)).toBe(HOUR);
  });

  it('short intervals are never stretched to the grace period', () => {
    expect(initialDelayMs({ name: 'a', intervalMs: 100, lastRunMs: 0, run: noop }, 5_000)).toBe(100);
  });

  it('the stagger is added to the first delay', () => {
    const now = 10 * HOUR;
    expect(initialDelayMs({ name: 'a', intervalMs: HOUR, lastRunMs: now - 3 * HOUR, staggerMs: 15 * MINUTE, run: noop }, now))
      .toBe(STARTUP_GRACE_MS + 15 * MINUTE);
  });

  it('an overdue spec fires soon after boot and then keeps its cadence', () => {
    const clock = new FakeClock(100 * HOUR);
    const sched = new PeriodicScheduler(clock);
    const fired: number[] = [];
    sched.start([{ name: 'a', intervalMs: HOUR, lastRunMs: 90 * HOUR, run: (now) => fired.push(now) }]);
    clock.advance(STARTUP_GRACE_MS - 1);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([100 * HOUR + STARTUP_GRACE_MS]);
    clock.advance(HOUR);
    expect(fired).toEqual([100 * HOUR + STARTUP_GRACE_MS, 101 * HOUR + STARTUP_GRACE_MS]);
    sched.stop();
  });

  it('buildSchedules reads each schedule\'s history by key and staggers the backup', () => {
    const cfg = loadConfig({ env: env({ BACKUP_ENABLED: 'true', BACKUP_INTERVAL_HOURS: '24', PRAGMA_OPTIMIZE_INTERVAL_HOURS: '24' }) });
    const asked: Array<[string, string]> = [];
    const lastRun = 1_700_000_000_000;
    const specs = buildSchedules(cfg, {
      enqueue: makeEnqueue().fn,
      channelIds: () => [],
      lastRunMs: (key, match) => {
        asked.push([key, match]);
        return lastRun;
      },
    });
    const byName = new Map(specs.map((s) => [s.name, s]));
    expect(asked).toEqual(expect.arrayContaining([
      [RECONCILE_CHANNEL_KEY(''), 'prefix'],
      [DISCOVER_THREADS_KEY, 'exact'],
      [REVIEW_DUE_KEY, 'exact'],
      [MAINTENANCE_KEY, 'exact'],
      [BACKUP_KEY, 'exact'],
    ]));
    for (const spec of specs) expect(spec.lastRunMs).toBe(lastRun);
    // Equal history would fire maintenance and backup together; the stagger separates them.
    const now = lastRun + 3 * 24 * HOUR;
    expect(initialDelayMs(byName.get('maintenance')!, now)).toBe(STARTUP_GRACE_MS);
    expect(initialDelayMs(byName.get('backup')!, now)).toBe(STARTUP_GRACE_MS + BACKUP_STAGGER_MS);
  });

  it('without a history reader every schedule starts one interval out', () => {
    const cfg = loadConfig({ env: env() });
    const specs = buildSchedules(cfg, { enqueue: makeEnqueue().fn, channelIds: () => [] });
    for (const spec of specs) expect(spec.lastRunMs).toBeNull();
  });
});

describe('buildSchedules — config-driven specs', () => {
  it('runs discovery at the platform rediscovery interval when the platform sets one', () => {
    const cfg = loadConfig({ env: env({ THREAD_DISCOVERY_INTERVAL_MINUTES: '20' }) });
    const { fn } = makeEnqueue();
    const specs = buildSchedules(cfg, { enqueue: fn, channelIds: () => [], channelDiscoveryIntervalMs: 15 * MINUTE });
    expect(specs.find((s) => s.name === 'discover-threads')?.intervalMs).toBe(15 * MINUTE);
  });

  it('builds specs with config-backed intervals and stable unique keys', () => {
    const cfg = loadConfig({
      env: env({
        RECONCILE_INTERVAL_MINUTES: '10',
        THREAD_DISCOVERY_INTERVAL_MINUTES: '20',
        BACKUP_ENABLED: 'true',
        BACKUP_INTERVAL_HOURS: '6',
        PRAGMA_OPTIMIZE_INTERVAL_HOURS: '12',
      }),
    });
    const { fn, calls } = makeEnqueue();
    const specs = buildSchedules(cfg, { enqueue: fn, channelIds: () => [] });
    const byName = new Map(specs.map((s) => [s.name, s]));
    expect([...byName.keys()].sort()).toEqual(
      ['backup', 'discover-threads', 'maintenance', 'reconcile', 'review-due-memories'].sort(),
    );
    expect(byName.get('reconcile')?.intervalMs).toBe(10 * MINUTE);
    expect(byName.get('discover-threads')?.intervalMs).toBe(20 * MINUTE);
    expect(byName.get('backup')?.intervalMs).toBe(6 * HOUR);
    expect(byName.get('maintenance')?.intervalMs).toBe(12 * HOUR);
    expect(byName.get('review-due-memories')?.intervalMs).toBe(DEFAULT_REVIEW_DUE_INTERVAL_MS);

    // Each non-reconcile spec enqueues exactly one job per tick with its key.
    const now = 1_700_000_000_000;
    byName.get('discover-threads')!.run(now);
    byName.get('review-due-memories')!.run(now);
    byName.get('maintenance')!.run(now);
    byName.get('backup')!.run(now);
    expect(calls).toEqual([
      { type: 'discover_threads', payload: {}, uniqueKey: DISCOVER_THREADS_KEY, now },
      { type: 'review_due_memories', payload: {}, uniqueKey: REVIEW_DUE_KEY, now },
      { type: 'maintenance', payload: {}, uniqueKey: MAINTENANCE_KEY, now },
      { type: 'backup_database', payload: {}, uniqueKey: BACKUP_KEY, now },
    ]);
  });

  it('reconcile fans out per channel with per-channel unique keys', () => {
    const cfg = loadConfig({ env: env() });
    const { fn, calls } = makeEnqueue();
    const specs = buildSchedules(cfg, { enqueue: fn, channelIds: () => ['c1', 'c2'] });
    const reconcile = specs.find((s) => s.name === 'reconcile')!;
    reconcile.run(123);
    expect(calls).toEqual([
      { type: 'reconcile_channel', payload: { channelId: 'c1' }, uniqueKey: RECONCILE_CHANNEL_KEY('c1'), now: 123 },
      { type: 'reconcile_channel', payload: { channelId: 'c2' }, uniqueKey: RECONCILE_CHANNEL_KEY('c2'), now: 123 },
    ]);
  });

  it('omits the backup spec when backups are disabled', () => {
    const cfg = loadConfig({ env: env({ BACKUP_ENABLED: 'false' }) });
    const { fn } = makeEnqueue();
    const specs = buildSchedules(cfg, { enqueue: fn, channelIds: () => [] });
    expect(specs.find((s) => s.name === 'backup')).toBeUndefined();
    expect(specs.filter((s) => s.name !== 'backup')).toHaveLength(4);
  });

  it('attempts exactly one enqueue per tick even when the queue collapses a duplicate', () => {
    const cfg = loadConfig({ env: env() });
    const { fn, calls } = makeEnqueue(false); // simulate unique-key collapse
    const specs = buildSchedules(cfg, { enqueue: fn, channelIds: () => [] });
    const discover = specs.find((s) => s.name === 'discover-threads')!;
    discover.run(7);
    expect(calls).toHaveLength(1); // one attempt; suppression is the queue's job
  });
});

describe('scheduler + buildSchedules integration (fake clock)', () => {
  it('each periodic job appears once per interval; shutdown leaves no timers', () => {
    const cfg = loadConfig({
      env: env({
        RECONCILE_INTERVAL_MINUTES: '1', // 1 minute
        THREAD_DISCOVERY_INTERVAL_MINUTES: '2',
        BACKUP_ENABLED: 'true',
        BACKUP_INTERVAL_HOURS: '1',
        PRAGMA_OPTIMIZE_INTERVAL_HOURS: '1',
      }),
    });
    const { fn, calls } = makeEnqueue();
    const specs: ScheduleSpec[] = buildSchedules(cfg, { enqueue: fn, channelIds: () => ['c1'] });
    const clock = new FakeClock();
    const sched = new PeriodicScheduler(clock);
    sched.start(specs);
    // All specs (5) armed.
    expect(clock.pending()).toBe(5);

    // Advance past the shortest interval (reconcile = 1 min): only reconcile fires.
    clock.advance(MINUTE);
    const typesAfterOneMin = calls.map((c) => c.type);
    expect(typesAfterOneMin).toEqual(['reconcile_channel']);

    // Advance to 2 min: reconcile again + discover-threads.
    clock.advance(MINUTE);
    expect(calls.map((c) => c.type).sort()).toEqual(['discover_threads', 'reconcile_channel', 'reconcile_channel']);

    // Shutdown: no live timers remain and nothing fires afterwards.
    sched.stop();
    expect(clock.pending()).toBe(0);
    clock.advance(10 * HOUR);
    expect(calls).toHaveLength(3); // unchanged after stop (reconcile@1m, discover+reconcile@2m)
  });
});

describe('nodeTimerDriver', () => {
  it('schedules and clears a real timer', async () => {
    const handle = nodeTimerDriver.schedule(() => {
      throw new Error('should have been cleared');
    }, 10);
    nodeTimerDriver.clear(handle);
    // Wait past the scheduled fire; the cleared callback must not run.
    await new Promise((r) => setTimeout(r, 30));
    expect(nodeTimerDriver.now()).toBeGreaterThan(0);
  });
});
