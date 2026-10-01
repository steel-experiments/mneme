import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { transaction } from '../../src/db/database.js';
import { insertProposal } from '../../src/db/repositories/proposals.js';
import {
  enqueueOutbox,
  getOutbox,
  getOutboxByDedupeKey,
  computeDedupeKey,
} from '../../src/outbox/repository.js';

/**
 * Durable outbox enqueue (Sections 9.1, 10.1, 25).
 *
 * Acceptance: repeated approval or routing of the same proposal cannot create two
 * outbox rows for the same intended Discord message. The dedupe key is the
 * effectively-once guarantee; content and channel are stored for the sender.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded restricted channel
const NOW = 1_700_000_001_000;

let env: TestDb;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
});
afterEach(() => env.cleanup());

function seedRun(id = 'run-1'): string {
  env.db
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
       VALUES (?,?,NULL,'episode','pv','faux','faux-1','completed',?)`,
    )
    .run(id, GUILD, NOW);
  return id;
}

/** Seed an approved proposal (and its run) and return the proposal id. */
function seedProposal(runId = 'run-1'): string {
  seedRun(runId);
  return insertProposal(env.db, {
    runId,
    targetChannelId: CHANNEL,
    status: 'approved',
    computedScore: 0.8,
    reason: ['all deterministic checks passed'],
    evidenceMessageIds: ['m1'],
    now: NOW,
  });
}

function outboxCount(): number {
  return Number(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n);
}

describe('enqueueOutbox — stores one queued row', () => {
  it('inserts a queued row with the content, channel, reply anchor, and due time', () => {
    const { outboxId, dedupeKey, enqueued } = enqueueOutbox(env.db, {
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'Heads up: this supersedes the onboarding decision.',
      replyToMessageId: 'msg-42',
      nextAttemptAtMs: NOW + 5_000,
      now: NOW,
    });
    expect(enqueued).toBe(true);

    const row = getOutbox(env.db, outboxId)!;
    expect(row.channelId).toBe(CHANNEL);
    expect(row.content).toBe('Heads up: this supersedes the onboarding decision.');
    expect(row.replyToMessageId).toBe('msg-42');
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAtMs).toBe(NOW + 5_000);
    expect(row.platformMessageId).toBeNull();
    expect(row.sentAtMs).toBeNull();
    expect(row.createdAtMs).toBe(NOW);
    expect(row.dedupeKey).toBe(dedupeKey);
    const sendJob = env.db
      .prepare("SELECT payload_json FROM jobs WHERE type = 'send_outbox' AND status = 'queued'")
      .get() as { payload_json: string } | undefined;
    expect(JSON.parse(sendJob!.payload_json)).toEqual({ outboxId });
  });

  it('defaults nextAttemptAtMs to now when not supplied', () => {
    const { outboxId } = enqueueOutbox(env.db, {
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'msg',
      now: NOW,
    });
    expect(getOutbox(env.db, outboxId)!.nextAttemptAtMs).toBe(NOW);
  });
});

describe('enqueueOutbox — dedupe by proposal identity', () => {
  it('collapses a repeated approval of the same proposal to one row', () => {
    const proposalId = seedProposal('run-1');

    const first = enqueueOutbox(env.db, {
      proposalId,
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'original message',
      now: NOW,
    });
    const second = enqueueOutbox(env.db, {
      proposalId,
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'original message',
      now: NOW,
    });

    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false); // collapsed, not a duplicate row
    expect(second.outboxId).toBe(first.outboxId);
    expect(outboxCount()).toBe(1);
  });

  it('collapses even when the second enqueue carries different content', () => {
    // The dedupe anchor is the proposal id, not the text — so a re-enqueue after
    // a crash or a double-click never produces a second intended message.
    const proposalId = seedProposal('run-1');

    const first = enqueueOutbox(env.db, {
      proposalId,
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'first draft',
      now: NOW,
    });
    const second = enqueueOutbox(env.db, {
      proposalId,
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'second draft',
      now: NOW,
    });

    expect(second.enqueued).toBe(false);
    expect(second.outboxId).toBe(first.outboxId);
    // The original content is preserved; the second draft did not overwrite it.
    expect(getOutbox(env.db, first.outboxId)!.content).toBe('first draft');
    expect(outboxCount()).toBe(1);
  });

  it('keeps distinct proposals as distinct rows', () => {
    const p1 = seedProposal('run-1');
    const p2 = seedProposal('run-2');

    const a = enqueueOutbox(env.db, { proposalId: p1, runId: 'run-1', channelId: CHANNEL, content: 'a', now: NOW });
    const b = enqueueOutbox(env.db, { proposalId: p2, runId: 'run-2', channelId: CHANNEL, content: 'b', now: NOW });

    expect(a.enqueued).toBe(true);
    expect(b.enqueued).toBe(true);
    expect(a.outboxId).not.toBe(b.outboxId);
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    expect(outboxCount()).toBe(2);
  });
});

describe('enqueueOutbox — proposal-less sends dedupe on run+channel+content', () => {
  it('collapses an identical proposal-less enqueue but keeps distinct content', () => {
    const same = enqueueOutbox(env.db, { runId: 'run-1', channelId: CHANNEL, content: 'same', now: NOW });
    const again = enqueueOutbox(env.db, { runId: 'run-1', channelId: CHANNEL, content: 'same', now: NOW });
    const other = enqueueOutbox(env.db, { runId: 'run-1', channelId: CHANNEL, content: 'different', now: NOW });

    expect(same.enqueued).toBe(true);
    expect(again.enqueued).toBe(false);
    expect(again.outboxId).toBe(same.outboxId);
    expect(other.enqueued).toBe(true);
    expect(outboxCount()).toBe(2);
  });
});

describe('computeDedupeKey — stable identity', () => {
  it('anchors on the proposal id and ignores content', () => {
    const a = computeDedupeKey({ proposalId: 'p1', runId: 'r1', channelId: 'c1', content: 'x' });
    const b = computeDedupeKey({ proposalId: 'p1', runId: 'r1', channelId: 'c1', content: 'y' });
    expect(a).toBe('proposal:p1');
    expect(a).toBe(b);
  });

  it('falls back to run+channel+content hash without a proposal', () => {
    const base = computeDedupeKey({ proposalId: null, runId: 'r1', channelId: 'c1', content: 'x' });
    const same = computeDedupeKey({ runId: 'r1', channelId: 'c1', content: 'x' });
    const diffContent = computeDedupeKey({ runId: 'r1', channelId: 'c1', content: 'y' });
    const diffRun = computeDedupeKey({ runId: 'r2', channelId: 'c1', content: 'x' });
    expect(base).toBe(same);
    expect(diffContent).not.toBe(same);
    expect(diffRun).not.toBe(same);
  });

  it('uses a host response intent across runs and content variants', () => {
    const a = computeDedupeKey({
      responseIntentKey: 'direct-answer:v1:abc',
      runId: 'r1',
      channelId: 'c1',
      content: 'primary',
    });
    const b = computeDedupeKey({
      responseIntentKey: 'direct-answer:v1:abc',
      runId: 'r2',
      channelId: 'c1',
      content: 'fallback',
    });
    const other = computeDedupeKey({
      responseIntentKey: 'direct-answer:v1:def',
      channelId: 'c1',
      content: 'fallback',
    });
    expect(a).toBe(b);
    expect(other).not.toBe(a);
    expect(a).not.toContain('abc');
  });

  it('enqueues an intent-anchored fallback without a model run id', () => {
    const first = enqueueOutbox(env.db, {
      responseIntentKey: 'direct-answer:v1:no-run',
      channelId: CHANNEL,
      content: 'neutral fallback',
      now: NOW,
    });
    const repeated = enqueueOutbox(env.db, {
      responseIntentKey: 'direct-answer:v1:no-run',
      channelId: CHANNEL,
      content: 'different recomputation',
      now: NOW + 1,
    });
    expect(first.enqueued).toBe(true);
    expect(repeated).toMatchObject({ enqueued: false, outboxId: first.outboxId });
  });
});

describe('enqueueOutbox — atomic with proposal approval', () => {
  it('commits the proposal and outbox row together in one transaction', () => {
    const runId = seedRun('run-1');
    let outboxId = '';
    const proposalId = transaction(env.db, () => {
      const pid = insertProposal(env.db, {
        runId,
        targetChannelId: CHANNEL,
        status: 'approved',
        computedScore: 0.8,
        reason: ['approved'],
        evidenceMessageIds: ['m1'],
        now: NOW,
      });
      outboxId = enqueueOutbox(env.db, {
        proposalId: pid,
        runId,
        channelId: CHANNEL,
        content: 'msg',
        now: NOW,
      }).outboxId;
      return pid;
    });

    expect(getOutbox(env.db, outboxId)).toBeDefined();
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeDefined();
    expect(outboxCount()).toBe(1);
  });

  it('rolls back the outbox row when a later step in the same transaction throws', () => {
    const runId = seedRun('run-1');
    expect(() =>
      transaction(env.db, () => {
        const pid = insertProposal(env.db, {
          runId,
          targetChannelId: CHANNEL,
          status: 'approved',
          computedScore: 0.8,
          reason: ['approved'],
          evidenceMessageIds: ['m1'],
          now: NOW,
        });
        enqueueOutbox(env.db, { proposalId: pid, runId, channelId: CHANNEL, content: 'msg', now: NOW });
        throw new Error('downstream approval step failed');
      }),
    ).toThrow('downstream approval step failed');

    // Neither the outbox row nor the proposal survived the rollback.
    expect(outboxCount()).toBe(0);
    expect(Number(env.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n)).toBe(0);
  });
});

describe('enqueueOutbox — input validation', () => {
  it('rejects empty content', () => {
    expect(() =>
      enqueueOutbox(env.db, { runId: 'run-1', channelId: CHANNEL, content: '', now: NOW }),
    ).toThrow(/content/);
  });

  it('rejects a missing channel id', () => {
    expect(() =>
      enqueueOutbox(env.db, { runId: 'run-1', channelId: '', content: 'msg', now: NOW }),
    ).toThrow(/channelId/);
  });

  it('rejects a missing run id when there is no proposal anchor', () => {
    expect(() =>
      enqueueOutbox(env.db, { runId: '', channelId: CHANNEL, content: 'msg', now: NOW }),
    ).toThrow(/runId/);
  });
});
