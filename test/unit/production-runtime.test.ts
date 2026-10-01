import { describe, expect, it, vi } from 'vitest';
import {
  DIRECT_ANSWER_MODEL_SLOT_WAIT_MS,
  JOB_LEASE_COMPLETION_MARGIN_MS,
  productionJobLeaseMs,
  scheduledIngestionChannelIds,
  lastScheduledRunMs,
  runPeriodicMaintenanceCycle,
} from '../../src/production-runtime.js';
import { createTestDb, seedIdentity } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';

describe('production job lease sizing', () => {
  it('covers direct-answer admission plus model execution and completion bookkeeping', () => {
    const timeoutSeconds = 30;
    expect(productionJobLeaseMs(timeoutSeconds)).toBe(
      DIRECT_ANSWER_MODEL_SLOT_WAIT_MS
        + timeoutSeconds * 1_000
        + JOB_LEASE_COMPLETION_MARGIN_MS,
    );
  });

  it('never reduces the established two-times-timeout cushion', () => {
    expect(productionJobLeaseMs(120)).toBe(240_000);
    expect(productionJobLeaseMs(600)).toBe(1_200_000);
  });
});

describe('periodic reconciliation channel selection', () => {
  it('excludes a Mneme test channel and its normally named child thread', () => {
    const env = createTestDb();
    try {
      const ids = seedIdentity(env.db);
      const now = 1_700_000_001_000;
      const add = (id: string, name: string, parentId: string | null, isThread: boolean) =>
        upsertChannel(env.db, {
          id,
          guildId: ids.guildId,
          parentId,
          kind: isThread ? 'thread' : 'text',
          name,
          topic: null,
          position: 0,
          isThread,
          isArchived: false,
          isLocked: false,
          ingestEnabled: true,
          visibilityClass: 'org',
          allowInterventions: true,
          permissionFingerprint: null,
          lastMessageId: null,
          discoveredAtMs: now,
          updatedAtMs: now,
          rawJson: null,
        });
      add('test-parent', 'mneme-test', null, false);
      add('test-child', 'ordinary-thread', 'test-parent', true);
      add('ordinary', 'general', null, false);

      expect(scheduledIngestionChannelIds(env.db)).toContain('ordinary');
      expect(scheduledIngestionChannelIds(env.db)).not.toContain('test-parent');
      expect(scheduledIngestionChannelIds(env.db)).not.toContain('test-child');
    } finally {
      env.cleanup();
    }
  });
});

describe('schedule history from durable jobs', () => {
  function insertJob(db: import('node:sqlite').DatabaseSync, id: string, uniqueKey: string, createdAtMs: number): void {
    db.prepare(
      `INSERT INTO jobs (id, type, unique_key, payload_json, status, run_after_ms, created_at_ms, updated_at_ms, completed_at_ms)
       VALUES (?, 'maintenance', ?, '{}', 'succeeded', ?, ?, ?, ?)`,
    ).run(id, uniqueKey, createdAtMs, createdAtMs, createdAtMs, createdAtMs);
  }

  it('reads the newest job by exact key, by key prefix, and null when none exists', () => {
    const env = createTestDb();
    try {
      insertJob(env.db, 'm1', 'schedule:maintenance', 1_700_000_001_000);
      insertJob(env.db, 'm2', 'schedule:maintenance', 1_700_000_005_000);
      insertJob(env.db, 'r1', 'schedule:reconcile:channel:aaa', 1_700_000_002_000);
      insertJob(env.db, 'r2', 'schedule:reconcile:channel:bbb', 1_700_000_003_000);
      expect(lastScheduledRunMs(env.db, 'schedule:maintenance', 'exact')).toBe(1_700_000_005_000);
      expect(lastScheduledRunMs(env.db, 'schedule:reconcile:channel:', 'prefix')).toBe(1_700_000_003_000);
      // An exact lookup never matches a longer key; a prefix lookup never matches a shorter one.
      expect(lastScheduledRunMs(env.db, 'schedule:reconcile:channel:', 'exact')).toBeNull();
      expect(lastScheduledRunMs(env.db, 'schedule:backup', 'exact')).toBeNull();
      expect(lastScheduledRunMs(env.db, 'schedule:backup', 'prefix')).toBeNull();
    } finally {
      env.cleanup();
    }
  });
});

describe('periodic maintenance cycle', () => {
  it('repairs deep-recap ownership after maintenance and logs counts without identifiers', async () => {
    const order: string[] = [];
    const info = vi.fn();
    const warn = vi.fn();

    const repair = await runPeriodicMaintenanceCycle({
      expireProposals: async () => { order.push('expiry'); },
      expireAttention: () => { order.push('attention'); return { expiredRevisionIds: [] }; },
      maintainDatabase: async () => { order.push('database'); },
      repairDeepRecaps: () => {
        order.push('deep-recaps');
        return {
          jobsEnqueued: 1,
          chunksReset: 1,
          duplicateJobsCancelled: 2,
          runningJobsRecovered: 1,
        };
      },
      logger: { info, warn },
    });

    expect(order).toEqual(['expiry', 'attention', 'database', 'deep-recaps']);
    expect(repair).toEqual({
      jobsEnqueued: 1,
      chunksReset: 1,
      duplicateJobsCancelled: 2,
      runningJobsRecovered: 1,
    });
    expect(info).toHaveBeenCalledWith(
      {
        event: 'jobs.deep_recap_ownership_repair',
        jobsEnqueued: 1,
        chunksReset: 1,
        duplicateJobsCancelled: 2,
        runningJobsRecovered: 1,
      },
      'periodic deep recap ownership reconciliation completed',
    );
    expect(warn).toHaveBeenCalledWith(
      {
        event: 'jobs.deep_recap_duplicate_owners_repaired',
        duplicateJobsCancelled: 2,
      },
      'duplicate deep recap owners were reconciled',
    );
  });
});
