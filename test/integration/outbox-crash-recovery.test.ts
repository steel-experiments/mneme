import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { insertProposal, getProposal } from '../../src/db/repositories/proposals.js';
import {
  enqueueOutbox,
  getOutbox,
  claimOutboxForSending,
} from '../../src/outbox/repository.js';
import {
  reconcileOutboxSending,
  type RecentSentMessageLookup,
  type RecentSentMessage,
} from '../../src/outbox/recovery.js';
import type { ProposalDeliveryReport } from '../../src/outbox/proposal-delivery.js';

/**
 * Outbox sending-state crash recovery (Section 10.1).
 *
 * Acceptance: a kill after the Discord send but before the database update
 * recovers the existing message (records its id, marks sent) and never posts a
 * duplicate. Only a completed lookup that finds no match may requeue.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002';
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

function seedProposal(runId = 'run-1'): string {
  seedRun(runId);
  return insertProposal(env.db, {
    runId,
    targetChannelId: CHANNEL,
    status: 'approved',
    computedScore: 0.8,
    reason: ['approved'],
    evidenceMessageIds: ['m1'],
    now: NOW,
  });
}

/** Enqueue and then claim (queued → sending) to simulate a crash mid-send. */
function sendingRow(
  over: Partial<{ proposalId: string | null; content: string }> = {},
): { id: string; proposalId: string | null; marker: string } {
  const proposalId = over.proposalId === undefined ? null : over.proposalId;
  const { outboxId } = enqueueOutbox(env.db, {
    proposalId,
    runId: 'run-1',
    channelId: CHANNEL,
    content: over.content ?? 'hi',
    now: NOW,
  });
  claimOutboxForSending(env.db, outboxId, NOW);
  return { id: outboxId, proposalId, marker: getOutbox(env.db, outboxId)!.dedupeMarker! };
}

function fakeLookup(
  byChannel: Record<string, RecentSentMessage[]>,
  throwFor?: string,
): RecentSentMessageLookup {
  return {
    async fetch(channelId) {
      if (throwFor === channelId) throw new Error('discord fetch failed');
      return byChannel[channelId] ?? [];
    },
  };
}

describe('reconcileOutboxSending — confirms a sent match', () => {
  it('records the existing Discord id, marks the row sent, and mirrors the proposal', async () => {
    const proposalId = seedProposal('run-1');
    const { id, marker } = sendingRow({ proposalId, content: 'we already posted this' });

    const report = await reconcileOutboxSending(
      env.db,
      fakeLookup({ [CHANNEL]: [{
        platformMessageId: 'discord-existing',
        content: 'we already posted this',
        dedupeMarker: marker,
        sentAtMs: NOW - 60_000,
      }] }),
      { now: NOW },
    );

    expect(report).toEqual({ examined: 1, confirmed: 1, requeued: 0, cancelled: 0, errored: 0 });
    const row = getOutbox(env.db, id)!;
    expect(row.status).toBe('sent');
    expect(row.platformMessageId).toBe('discord-existing');
    expect(row.sentAtMs).toBe(NOW - 60_000);
    expect(getProposal(env.db, proposalId)!.status).toBe('sent');
  });

  it('reports recovered proposal delivery only after sent state is durable', async () => {
    const proposalId = seedProposal('run-1');
    const { id, marker } = sendingRow({ proposalId, content: 'posted before the crash' });
    const reports: ProposalDeliveryReport[] = [];

    await reconcileOutboxSending(
      env.db,
      fakeLookup({
        [CHANNEL]: [{
          platformMessageId: 'discord-recovered',
          content: 'posted before the crash',
          dedupeMarker: marker,
        }],
      }),
      {
        now: NOW,
        reportProposalDelivery: (report) => {
          expect(getOutbox(env.db, id)?.status).toBe('sent');
          expect(getProposal(env.db, proposalId)?.status).toBe('sent');
          reports.push(report);
        },
      },
    );

    expect(reports).toEqual([{
      status: 'sent',
      proposalId,
      outboxId: id,
      platformMessageId: 'discord-recovered',
    }]);
  });

  it('keeps recovered delivery durable when presentation reporting fails', async () => {
    const proposalId = seedProposal('run-1');
    const { id, marker } = sendingRow({ proposalId, content: 'durable recovery' });

    await expect(reconcileOutboxSending(
      env.db,
      fakeLookup({
        [CHANNEL]: [{
          platformMessageId: 'discord-durable',
          content: 'durable recovery',
          dedupeMarker: marker,
        }],
      }),
      {
        now: NOW,
        reportProposalDelivery: async () => { throw new Error('review edit failed'); },
      },
    )).resolves.toEqual({ examined: 1, confirmed: 1, requeued: 0, cancelled: 0, errored: 0 });

    expect(getOutbox(env.db, id)?.status).toBe('sent');
    expect(getProposal(env.db, proposalId)?.status).toBe('sent');
  });

  it('does not accept identical normalized content without the marker', async () => {
    const { id } = sendingRow({ content: 'heads up' });
    await reconcileOutboxSending(
      env.db,
      fakeLookup({ [CHANNEL]: [{ platformMessageId: 'd-1', content: '  Heads Up.  ' }] }),
      { now: NOW },
    );
    expect(getOutbox(env.db, id)!.status).toBe('queued');
  });
});

describe('reconcileOutboxSending — requeues only after a clean no-match', () => {
  it('returns the row to queued when a completed lookup finds no match', async () => {
    const { id } = sendingRow({ content: 'never sent' });

    const report = await reconcileOutboxSending(
      env.db,
      fakeLookup({ [CHANNEL]: [{ platformMessageId: 'd-other', content: 'a different message' }] }),
      { now: NOW },
    );

    expect(report).toEqual({ examined: 1, confirmed: 0, requeued: 1, cancelled: 0, errored: 0 });
    const row = getOutbox(env.db, id)!;
    expect(row.status).toBe('queued');
    expect(row.lastError).toContain('no matching');
    expect(row.nextAttemptAtMs).toBeGreaterThan(NOW);
  });

  it('leaves the row sending when the lookup errors (no risky requeue)', async () => {
    const { id } = sendingRow({ content: 'maybe sent' });

    const report = await reconcileOutboxSending(
      env.db,
      fakeLookup({}, CHANNEL), // fetch throws for CHANNEL
      { now: NOW },
    );

    expect(report).toEqual({ examined: 1, confirmed: 0, requeued: 0, cancelled: 0, errored: 1 });
    // The row is still sending: recovery neither confirmed nor requeued it.
    expect(getOutbox(env.db, id)!.status).toBe('sending');
  });

  it('cancels a proven-unsent proposal when its delivery authority drifted', async () => {
    const proposalId = seedProposal('run-1');
    const { id } = sendingRow({ proposalId, content: 'stale scheduled notification' });
    const report = await reconcileOutboxSending(env.db, fakeLookup({ [CHANNEL]: [] }), {
      now: NOW,
      validateProposalSend: () => ({ allow: false, reasons: ['scheduled route changed'] }),
    });

    expect(report).toEqual({ examined: 1, confirmed: 0, requeued: 0, cancelled: 1, errored: 0 });
    expect(getOutbox(env.db, id)?.status).toBe('cancelled');
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
  });
});

describe('reconcileOutboxSending — scope and batching', () => {
  it('reconciles each sending row independently', async () => {
    const matched = sendingRow({ content: 'posted' });
    const missed = sendingRow({ content: 'not posted' });

    const report = await reconcileOutboxSending(
      env.db,
      fakeLookup({ [CHANNEL]: [{ platformMessageId: 'd-1', content: 'posted', dedupeMarker: matched.marker }] }),
      { now: NOW },
    );

    expect(report).toEqual({ examined: 2, confirmed: 1, requeued: 1, cancelled: 0, errored: 0 });
    expect(getOutbox(env.db, matched.id)!.status).toBe('sent');
    expect(getOutbox(env.db, missed.id)!.status).toBe('queued');
  });

  it('examines only rows in sending; queued and sent rows are untouched', async () => {
    // A queued row (not claimed) and a sent row should be invisible to recovery.
    const queuedId = enqueueOutbox(env.db, {
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'queued',
      now: NOW,
    }).outboxId;
    const sending = sendingRow({ content: 'sending' });
    // Manually finalize a third row as sent.
    const sentId = enqueueOutbox(env.db, {
      runId: 'run-1',
      channelId: CHANNEL,
      content: 'done',
      now: NOW,
    }).outboxId;
    claimOutboxForSending(env.db, sentId, NOW);
    env.db
      .prepare("UPDATE outbox SET status='sent', platform_message_id='d-x' WHERE id=?")
      .run(sentId);

    const report = await reconcileOutboxSending(
      env.db,
      fakeLookup({ [CHANNEL]: [{ platformMessageId: 'd-s', content: 'sending', dedupeMarker: sending.marker }] }),
      { now: NOW },
    );

    expect(report.examined).toBe(1); // only the `sending` row
    expect(getOutbox(env.db, sending.id)!.status).toBe('sent');
    expect(getOutbox(env.db, queuedId)!.status).toBe('queued'); // untouched
    expect(getOutbox(env.db, sentId)!.status).toBe('sent'); // untouched
  });

  it('reports nothing to do when no rows are sending', async () => {
    const report = await reconcileOutboxSending(env.db, fakeLookup({}), { now: NOW });
    expect(report).toEqual({ examined: 0, confirmed: 0, requeued: 0, cancelled: 0, errored: 0 });
  });
});
