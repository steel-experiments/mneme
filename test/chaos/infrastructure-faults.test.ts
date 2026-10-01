import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { GUILD, CHANNEL, NOW } from '../helpers/messages.js';
import { insertProposal } from '../../src/db/repositories/proposals.js';
import { enqueueOutbox, getOutbox } from '../../src/outbox/repository.js';
import { createSendOutboxHandler } from '../../src/outbox/worker.js';
import {
  classifyError,
  TransientJobError,
  PermanentJobError,
} from '../../src/jobs/errors.js';
import { computeRetryDelay, RETRY_MAX_DELAY_MS } from '../../src/jobs/queue.js';
import {
  enqueue,
  claimNextJob,
  reclaimExpiredLeases,
  getJob,
  failJob,
} from '../../src/jobs/queue.js';
import { createSyntheticDiscord } from '../fixtures/discord/synthetic-adapter.js';
import type { JobRow } from '../../src/jobs/types.js';

/**
 * Section 46.5 chaos cases 4 & 5 — "disconnect the network" and "corrupt a job
 * lease".
 *
 * Case 4 verdict: a raw network failure (no HTTP status — a dropped connection,
 * ECONNREFUSED, a Node `code: 'ECONNREFUSED'` string error) classifies as
 * transient, schedules a bounded retry, and the second attempt succeeds. No
 * message is lost and none is duplicated.
 *
 * Case 5 verdict: a job whose lease expired (worker died mid-job) is reclaimed
 * and re-run exactly once; a job that never succeeds terminates at
 * `max_attempts` instead of looping forever. (A lease whose `lease_until_ms` was
 * corrupted to NULL is NOT silently reclaimed — it stays `running` so it can
 * never be double-executed; it needs operator attention.)
 */

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

function jobRow(maxAttempts = 10): JobRow {
  return { max_attempts: maxAttempts } as unknown as JobRow;
}

function seedRun(id = 'run-1'): void {
  db.prepare(
    `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
     VALUES(?, ?, NULL, 'episode', 'pv', 'faux', 'faux-1', 'completed', ?)`,
  ).run(id, GUILD, NOW);
}

// ---------------------------------------------------------------------------
// Case 4: disconnect the network.
// ---------------------------------------------------------------------------

describe('Section 46.5 — disconnect the network (transient classification + retry)', () => {
  it('classifies a raw connection failure as transient and schedules a bounded retry', () => {
    // A plain network error with no HTTP status — the classifier's default branch.
    const net = new Error('connect ECONNREFUSED 127.0.0.1:443');
    expect(classifyError(net).permanent).toBe(false);

    // Node convention: a string `code` (not numeric) also falls through to transient.
    const nodeStyle = Object.assign(new Error('getaddrinfo ENOTFOUND api.example'), {
      code: 'ENOTFOUND',
    });
    expect(classifyError(nodeStyle).permanent).toBe(false);

    // A transient retry delay is positive, grows with attempts, and is capped.
    expect(computeRetryDelay(1, 0)).toBeGreaterThan(0);
    expect(computeRetryDelay(3, 0)).toBeGreaterThan(computeRetryDelay(1, 0));
    expect(computeRetryDelay(100, 0)).toBe(RETRY_MAX_DELAY_MS);

    // Contrast: an auth failure is permanent — the classifier is not blanket-transient.
    expect(classifyError(Object.assign(new Error('forbidden'), { status: 403 })).permanent).toBe(true);
  });

  it('survives a network drop on outbox delivery: transient → queued → retry sends once', async () => {
    seedRun('run-1');
    const proposalId = insertProposal(db, {
      runId: 'run-1',
      targetChannelId: CHANNEL,
      status: 'approved',
      computedScore: 0.8,
      reason: ['approved'],
      evidenceMessageIds: ['m1'],
      now: NOW,
    });
    const { outboxId } = enqueueOutbox(db, {
      proposalId,
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'network-drop proof message',
      replyToMessageId: null,
      now: NOW,
    });

    const discord = createSyntheticDiscord({ now: NOW });
    // The first delivery dies with a raw network error (no HTTP status).
    discord.scriptSendError({ message: 'connect ECONNREFUSED 127.0.0.1:443' }, 0);
    const deps = {
      db,
      sender: discord.sender,
      now: () => discord.clock.now(),
      retryDelayMs: (a: number) => computeRetryDelay(a, 0),
    };

    await expect(createSendOutboxHandler(deps)({ outboxId }, jobRow())).rejects.toBeInstanceOf(
      TransientJobError,
    );

    // Verdict: the row is back to queued for a bounded retry; nothing was sent.
    const afterFail = getOutbox(db, outboxId)!;
    expect(afterFail.status).toBe('queued');
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.nextAttemptAtMs).toBeGreaterThan(NOW);
    expect(discord.sentMessages).toHaveLength(0);

    // The retry (call index 1, no scripted error) succeeds — exactly one send.
    discord.clock.advance(afterFail.nextAttemptAtMs - NOW + 1);
    await createSendOutboxHandler(deps)({ outboxId }, jobRow());
    expect(getOutbox(db, outboxId)!.status).toBe('sent');
    expect(discord.sentMessages).toHaveLength(1);
    expect(discord.sentMessages[0]!.content).toBe('network-drop proof message');
  });

  it('does not classify a network drop as a permanent outbox failure', async () => {
    seedRun('run-2');
    const proposalId = insertProposal(db, {
      runId: 'run-2',
      targetChannelId: CHANNEL,
      status: 'approved',
      computedScore: 0.7,
      reason: ['approved'],
      evidenceMessageIds: ['m1'],
      now: NOW,
    });
    const { outboxId } = enqueueOutbox(db, {
      proposalId,
      runId: 'run-2',
      channelId: CHANNEL,
      content: 'must stay retryable',
      replyToMessageId: null,
      now: NOW,
    });
    const discord = createSyntheticDiscord({ now: NOW });
    discord.scriptSendError({ message: 'fetch failed: network' }, 0);
    const deps = { db, sender: discord.sender, now: () => discord.clock.now() };

    // A network error must throw TransientJobError, NEVER PermanentJobError.
    await expect(createSendOutboxHandler(deps)({ outboxId }, jobRow())).rejects.not.toBeInstanceOf(
      PermanentJobError,
    );
    expect(getOutbox(db, outboxId)!.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// Case 5: corrupt a job lease.
// ---------------------------------------------------------------------------

describe('Section 46.5 — corrupt / expire a job lease (reclaim once, terminate at cap)', () => {
  it('reclaims an expired lease and re-runs the job exactly once (no loss, no double-run)', () => {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });
    const first = claimNextJob(db, { owner: 'worker-A', now: NOW, leaseMs: 60_000 })!;
    expect(first.status).toBe('running');
    expect(first.attempts).toBe(1);

    // While worker-A holds the lease, no other claimant can take it.
    expect(claimNextJob(db, { owner: 'worker-B', now: NOW + 1, leaseMs: 60_000 })).toBeUndefined();

    // The lease expires (worker-A "died"). reclaimExpiredLeases returns it to queued.
    const reclaimed = reclaimExpiredLeases(db, NOW + 120_000);
    expect(reclaimed).toBe(1);
    const after = getJob(db, first.id)!;
    expect(after.status).toBe('queued');
    expect(after.lease_owner).toBeNull();
    expect(after.lease_until_ms).toBeNull();

    // The next dispatch re-claims it (attempts now 2) — once, by a single claimant.
    const next = claimNextJob(db, { owner: 'worker-B', now: NOW + 120_001, leaseMs: 60_000 })!;
    expect(next.id).toBe(first.id);
    expect(next.attempts).toBe(2);
    expect(next.lease_owner).toBe('worker-B');
    expect(claimNextJob(db, { owner: 'worker-C', now: NOW + 120_002, leaseMs: 60_000 })).toBeUndefined();
  });

  it('terminates a job that never succeeds at max_attempts (no infinite loop)', () => {
    const jobId = enqueue(db, { type: 'backfill_channel', payload: { channelId: '222' }, now: NOW }).id;
    let t = NOW;
    let outcome: 'failed' | 'requeued' = 'requeued';
    let attempts = 0;
    // Claim → fail → advance past the requeued run_after, repeat. A transient
    // error requeues until attempts reaches max_attempts, then goes terminal.
    for (let i = 0; i < 30 && outcome !== 'failed'; i += 1) {
      const claimed = claimNextJob(db, { owner: 'w', now: t, leaseMs: 60_000 });
      if (!claimed) {
        // Not yet eligible (run_after is in the future); advance and retry.
        t = getJob(db, jobId)!.run_after_ms + 1;
        continue;
      }
      attempts = claimed.attempts;
      outcome = failJob(db, { id: claimed.id, error: 'always fails', now: t, jitterMs: 0 });
      if (outcome === 'failed') break;
      // Advance time past the requeued run_after so the next claim is eligible.
      t = getJob(db, jobId)!.run_after_ms + 1;
    }

    // Verdict: the job terminated (no infinite loop) exactly at the attempt cap.
    expect(outcome).toBe('failed');
    expect(attempts).toBe(10); // DEFAULT_MAX_ATTEMPTS
    expect(getJob(db, jobId)!.status).toBe('failed');
  });

  it('a lease corrupted to a NULL deadline is NOT silently reclaimed (no double-run)', () => {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '333' }, now: NOW });
    const claimed = claimNextJob(db, { owner: 'worker-A', now: NOW, leaseMs: 60_000 })!;
    // Corrupt the lease deadline to NULL — e.g. a partial write / disk glitch.
    db.prepare('UPDATE jobs SET lease_until_ms = NULL WHERE id = ?').run(claimed.id);

    // reclaimExpiredLeases uses `lease_until_ms < now`; NULL never satisfies that,
    // so the row is NOT returned to queued. It stays running rather than risk a
    // double-execution. This is the documented corruption edge: such a row needs
    // operator intervention; the system fails safe (no duplicate dispatch).
    expect(reclaimExpiredLeases(db, NOW + 999_999_999)).toBe(0);
    expect(getJob(db, claimed.id)!.status).toBe('running');
    expect(getJob(db, claimed.id)!.lease_until_ms).toBeNull();
  });
});
