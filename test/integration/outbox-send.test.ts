import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { insertProposal, getProposal } from '../../src/db/repositories/proposals.js';
import {
  enqueueOutbox,
  getOutbox,
  claimOutboxForSending,
  markOutboxSent,
} from '../../src/outbox/repository.js';
import {
  createSendOutboxHandler,
  type ProposalDeliveryReport,
  type SendOutboxHandlerDeps,
} from '../../src/outbox/worker.js';
import { createDiscordSender } from '../../src/platform/discord/sender.js';
import type { OutboxSender, SendOutboxMessageInput } from '../../src/platform/types.js';
import { PermanentJobError, TransientJobError } from '../../src/jobs/errors.js';
import type { Client } from 'discord.js';
import type { JobRow } from '../../src/jobs/types.js';
import { createProposalDeliverySyncHandler } from '../../src/outbox/proposal-delivery.js';
import { completeDirectAnswerRequest, ensureDirectAnswerRequest } from '../../src/db/repositories/direct-answers.js';

/**
 * Outbox Discord sender (Sections 9.1, 10.1, 24.5).
 *
 * Acceptance: a successful send records one Discord id; failures retry safely or
 * become terminal without losing error audit data. The send path claims a row
 * (queued → sending) before the network call and records the outcome after.
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

function enqueue(
  over: Partial<{ proposalId: string | null; content: string; replyToMessageId: string | null }> = {},
): string {
  const proposalId = over.proposalId === undefined ? null : over.proposalId;
  const { outboxId } = enqueueOutbox(env.db, {
    proposalId,
    runId: 'run-1',
    channelId: CHANNEL,
    content: over.content ?? 'hi',
    replyToMessageId: over.replyToMessageId ?? null,
    now: NOW,
  });
  return outboxId;
}

function jobRow(maxAttempts = 10): JobRow {
  return { max_attempts: maxAttempts } as unknown as JobRow;
}

function makeDeps(sender: OutboxSender, over: Partial<SendOutboxHandlerDeps> = {}): SendOutboxHandlerDeps {
  return { db: env.db, sender, now: () => NOW, retryDelayMs: () => 1_000, ...over };
}

/** A scripted sender that records calls and optionally throws. */
function fakeSender(opts: { id?: string; error?: () => never } = {}): {
  sender: OutboxSender;
  calls: SendOutboxMessageInput[];
} {
  const calls: SendOutboxMessageInput[] = [];
  const sender: OutboxSender = {
    async send(input) {
      calls.push(input);
      if (opts.error) opts.error();
      return { platformMessageId: opts.id ?? 'discord-1' };
    },
  };
  return { sender, calls };
}

const transientError = (): never => {
  throw Object.assign(new Error('discord 500 internal'), { status: 500 });
};
const permanentError = (): never => {
  throw Object.assign(new Error('missing access to channel'), { status: 403 });
};

describe('outbox transitions — claim before send', () => {
  it('claimOutboxForSending moves queued → sending and increments attempts', () => {
    const id = enqueue({ content: 'x' });
    const claimed = claimOutboxForSending(env.db, id, NOW);
    expect(claimed).toBeDefined();
    expect(claimed!.status).toBe('sending');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.content).toBe('x');
    // A second claim is a no-op: the row is no longer queued.
    expect(claimOutboxForSending(env.db, id, NOW)).toBeUndefined();
  });
});

describe('send_outbox — success path', () => {
  it('claims, sends with disabled mentions, records the Discord id, and mirrors to the proposal', async () => {
    const proposalId = seedProposal('run-1');
    const outboxId = enqueue({
      proposalId,
      content: 'heads up: this supersedes the onboarding decision',
      replyToMessageId: 'msg-42',
    });
    const { sender, calls } = fakeSender({ id: 'discord-999' });

    await createSendOutboxHandler(makeDeps(sender))({ outboxId }, jobRow());

    const row = getOutbox(env.db, outboxId)!;
    expect(row.status).toBe('sent');
    expect(row.platformMessageId).toBe('discord-999');
    expect(row.sentAtMs).toBe(NOW);
    expect(row.attempts).toBe(1);
    expect(getProposal(env.db, proposalId)!.status).toBe('sent');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      channelId: CHANNEL,
      content: 'heads up: this supersedes the onboarding decision',
      replyToMessageId: 'msg-42',
    });
  });

  it('lets only a direct-answer row render platform-archive links live', async () => {
    seedRun('run-1');
    const directId = enqueue({ content: 'direct answer' });
    ensureDirectAnswerRequest(env.db, {
      sourceMessageId: 'question-1', guildId: GUILD, targetChannelId: CHANNEL,
      questionCreatedAtMs: NOW, deadlineAtMs: NOW + 60_000, now: NOW,
    });
    completeDirectAnswerRequest(env.db, {
      sourceMessageId: 'question-1', outcomeKind: 'primary', reasonCategory: 'none',
      runId: 'run-1', outboxId: directId, now: NOW,
    });
    const otherId = enqueue({ content: 'deep recap report' });
    const { sender, calls } = fakeSender();

    await createSendOutboxHandler(makeDeps(sender))({ outboxId: directId }, jobRow());
    await createSendOutboxHandler(makeDeps(sender))({ outboxId: otherId }, jobRow());

    expect(calls.map((c) => c.archiveLinks)).toEqual([true, false]);
  });

  it('reports proposal delivery only after sent state is durable', async () => {
    const proposalId = seedProposal('run-1');
    const outboxId = enqueue({ proposalId, content: 'report success' });
    const { sender } = fakeSender({ id: 'discord-reported' });
    const reports: ProposalDeliveryReport[] = [];

    await createSendOutboxHandler(makeDeps(sender, {
      reportProposalDelivery: (report) => {
        expect(getOutbox(env.db, outboxId)?.status).toBe('sent');
        expect(getProposal(env.db, proposalId)?.status).toBe('sent');
        reports.push(report);
      },
    }))({ outboxId }, jobRow());

    expect(reports).toEqual([{
      status: 'sent',
      proposalId,
      outboxId,
      platformMessageId: 'discord-reported',
    }]);
  });

  it('cancels a stale proposal after claim and before Discord I/O', async () => {
    const proposalId = seedProposal('run-1');
    const outboxId = enqueue({ proposalId, content: 'must not send' });
    const { sender, calls } = fakeSender();
    const reports: ProposalDeliveryReport[] = [];

    await createSendOutboxHandler(makeDeps(sender, {
      validateProposalSend: () => ({ allow: false, reasons: ['scheduled route changed'] }),
      reportProposalDelivery: (report) => { reports.push(report); },
    }))({ outboxId }, jobRow());

    expect(calls).toHaveLength(0);
    expect(getOutbox(env.db, outboxId)?.status).toBe('cancelled');
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
    expect(reports).toEqual([{ status: 'cancelled', proposalId, outboxId }]);
  });
});

describe('proposal review-card status convergence', () => {
  it('queues and runs a durable sent-status card update', async () => {
    const proposalId = seedProposal('run-1');
    env.db.prepare('UPDATE proposals SET review_message_id = ? WHERE id = ?')
      .run('review-card', proposalId);
    const outboxId = enqueue({ proposalId, content: 'durable card status' });
    const { sender } = fakeSender({ id: 'discord-terminal' });

    await createSendOutboxHandler(makeDeps(sender))({ outboxId }, jobRow());

    expect(env.db.prepare(`SELECT type,unique_key,status FROM jobs
      WHERE type='sync_proposal_review'`).get()).toEqual({
      type: 'sync_proposal_review',
      unique_key: `proposal-review-status:${proposalId}`,
      status: 'queued',
    });
    const reports: ProposalDeliveryReport[] = [];
    await createProposalDeliverySyncHandler({
      db: env.db,
      reporter: (report) => { reports.push(report); },
    })({ proposalId }, jobRow());
    expect(reports).toEqual([{
      status: 'sent',
      proposalId,
      outboxId,
      platformMessageId: 'discord-terminal',
    }]);
  });

  it('propagates card edit failures so the durable job can retry', async () => {
    const proposalId = seedProposal('run-1');
    env.db.prepare('UPDATE proposals SET review_message_id = ? WHERE id = ?')
      .run('review-card', proposalId);
    const outboxId = enqueue({ proposalId, content: 'retry card status' });
    const { sender } = fakeSender({ id: 'discord-terminal' });
    await createSendOutboxHandler(makeDeps(sender))({ outboxId }, jobRow());

    await expect(createProposalDeliverySyncHandler({
      db: env.db,
      reporter: async () => { throw new Error('temporary review edit failure'); },
    })({ proposalId }, jobRow())).rejects.toThrow('temporary review edit failure');
    expect(getOutbox(env.db, outboxId)?.status).toBe('sent');
    expect(getProposal(env.db, proposalId)?.status).toBe('sent');
  });
});

describe('send_outbox — duplicate and stale jobs are no-ops', () => {
  it('does not resend a row a duplicate job targets (idempotent)', async () => {
    const outboxId = enqueue({ content: 'once' });
    const { sender, calls } = fakeSender();
    const handler = createSendOutboxHandler(makeDeps(sender));

    await handler({ outboxId }, jobRow());
    await handler({ outboxId }, jobRow()); // duplicate send_outbox job

    expect(calls).toHaveLength(1);
    expect(getOutbox(env.db, outboxId)!.status).toBe('sent');
  });

  it('is a no-op when the row is already terminal (sent)', async () => {
    const outboxId = enqueue({ content: 'done' });
    claimOutboxForSending(env.db, outboxId, NOW);
    markOutboxSent(env.db, outboxId, 'discord-x', NOW);

    const { sender, calls } = fakeSender();
    await createSendOutboxHandler(makeDeps(sender))({ outboxId }, jobRow());

    expect(calls).toHaveLength(0);
  });

  it('is a no-op for a missing outbox id and does not throw', async () => {
    const { sender } = fakeSender();
    await expect(
      createSendOutboxHandler(makeDeps(sender))({ outboxId: 'does-not-exist' }, jobRow()),
    ).resolves.toBeUndefined();
  });
});

describe('send_outbox — transient failure retries safely', () => {
  it('returns the row to queued with audit error and backoff, and throws TransientJobError', async () => {
    const proposalId = seedProposal('run-1');
    const outboxId = enqueue({ proposalId, content: 'retry me' });
    const { sender } = fakeSender({ error: transientError });

    const reports: ProposalDeliveryReport[] = [];
    await expect(
      createSendOutboxHandler(makeDeps(sender, {
        reportProposalDelivery: (report) => { reports.push(report); },
      }))({ outboxId }, jobRow()),
    ).rejects.toBeInstanceOf(TransientJobError);

    const row = getOutbox(env.db, outboxId)!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('discord 500 internal');
    expect(row.nextAttemptAtMs).toBeGreaterThan(NOW);
    expect(getProposal(env.db, proposalId)!.status).toBe('approved'); // unchanged
    expect(reports).toEqual([]);
  });

  it('a later attempt re-claims the queued row and succeeds', async () => {
    const outboxId = enqueue({ content: 'retry me' });
    const failing = fakeSender({ error: transientError });
    await expect(
      createSendOutboxHandler(makeDeps(failing.sender))({ outboxId }, jobRow()),
    ).rejects.toBeInstanceOf(TransientJobError);

    const ok = fakeSender({ id: 'discord-ok' });
    await createSendOutboxHandler(makeDeps(ok.sender))({ outboxId }, jobRow());

    const row = getOutbox(env.db, outboxId)!;
    expect(row.status).toBe('sent');
    expect(row.platformMessageId).toBe('discord-ok');
    expect(row.attempts).toBe(2); // claimed twice
  });
});

describe('send_outbox — permanent failure and exhaustion become terminal', () => {
  it('a permanent error marks the row failed and the proposal failed', async () => {
    const proposalId = seedProposal('run-1');
    const outboxId = enqueue({ proposalId, content: 'nope' });
    const { sender } = fakeSender({ error: permanentError });

    const reports: ProposalDeliveryReport[] = [];
    await expect(
      createSendOutboxHandler(makeDeps(sender, {
        reportProposalDelivery: (report) => {
          expect(getOutbox(env.db, outboxId)?.status).toBe('failed');
          expect(getProposal(env.db, proposalId)?.status).toBe('failed');
          reports.push(report);
        },
      }))({ outboxId }, jobRow()),
    ).rejects.toBeInstanceOf(PermanentJobError);

    const row = getOutbox(env.db, outboxId)!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('missing access');
    expect(getProposal(env.db, proposalId)!.status).toBe('failed');
    expect(reports).toEqual([{ status: 'failed', proposalId, outboxId }]);
  });

  it('does not let a presentation reporter failure change durable delivery success', async () => {
    const proposalId = seedProposal('run-1');
    const outboxId = enqueue({ proposalId, content: 'reporter may fail' });
    const { sender } = fakeSender({ id: 'discord-still-sent' });

    await expect(createSendOutboxHandler(makeDeps(sender, {
      reportProposalDelivery: async () => { throw new Error('review edit failed'); },
    }))({ outboxId }, jobRow())).resolves.toBeUndefined();

    expect(getOutbox(env.db, outboxId)?.status).toBe('sent');
    expect(getProposal(env.db, proposalId)?.status).toBe('sent');
  });

  it('a transient error that exhausts max attempts becomes terminal failed', async () => {
    const outboxId = enqueue({ content: 'last try' });
    const { sender } = fakeSender({ error: transientError });

    await expect(
      createSendOutboxHandler(makeDeps(sender))({ outboxId }, jobRow(1)),
    ).rejects.toBeInstanceOf(PermanentJobError);

    const row = getOutbox(env.db, outboxId)!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('discord 500 internal');
  });
});

describe('createDiscordSender — disables mentions and replies', () => {
  function fakeClient(channel: unknown): Client {
    return { channels: { fetch: async () => channel } } as unknown as Client;
  }

  it('disables all automatic mentions and replies when an anchor is present', async () => {
    let captured: Record<string, unknown> = {};
    const channel = {
      isSendable: () => true,
      send: async (opts: Record<string, unknown>) => {
        captured = opts;
        return { id: 'discord-777' };
      },
    };
    const res = await createDiscordSender(fakeClient(channel)).send({
      channelId: 'c',
      content: 'hi',
      replyToMessageId: 'msg-1',
    });
    expect(res.platformMessageId).toBe('discord-777');
    expect(captured.allowedMentions).toEqual({ parse: [] });
    expect(captured.content).toBe('hi');
    expect((captured.reply as { messageReference: string }).messageReference).toBe('msg-1');
  });

  it('omits the reply when no anchor is present', async () => {
    let captured: Record<string, unknown> = {};
    const channel = {
      isSendable: () => true,
      send: async (opts: Record<string, unknown>) => {
        captured = opts;
        return { id: 'd' };
      },
    };
    await createDiscordSender(fakeClient(channel)).send({ channelId: 'c', content: 'hi' });
    expect(captured.reply).toBeUndefined();
    expect(captured.allowedMentions).toEqual({ parse: [] });
  });

  it('throws when the fetched channel is not sendable', async () => {
    const channel = { isSendable: () => false };
    await expect(
      createDiscordSender(fakeClient(channel)).send({ channelId: 'c', content: 'hi' }),
    ).rejects.toThrow(/not sendable/);
  });

  it('throws when the channel does not exist (fetch returns null)', async () => {
    await expect(
      createDiscordSender(fakeClient(null)).send({ channelId: 'c', content: 'hi' }),
    ).rejects.toThrow(/not sendable/);
  });
});
