import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  insertProposal,
  getProposal,
  setProposalReviewMessage,
  type ProposalStatus,
} from '../../src/db/repositories/proposals.js';
import { countAdminEvents } from '../../src/db/repositories/admin-events.js';
import { getOutboxByDedupeKey } from '../../src/outbox/repository.js';
import {
  recheckApprovalPolicy,
  approveProposal,
  dismissProposal,
  type ReviewResolution,
} from '../../src/review/workflow.js';
import type { OutboundEvidenceResult, ProvenanceGateResult } from '../../src/agent/policy.js';
import type { CooldownDecision } from '../../src/agent/cooldowns.js';
import type { DuplicateResult } from '../../src/agent/duplicate-policy.js';
import { createReviewButtonHandler } from '../../src/platform/discord/interactions.js';
import { signReviewComponent } from '../../src/platform/discord/review-message.js';
import type { ButtonInteraction } from 'discord.js';

/**
 * Authorized proposal approval and dismissal (Sections 6.6, 25).
 *
 * Acceptance: only configured admins can approve, and a policy change between
 * proposal and approval can prevent a send. The reviewer is recorded before the
 * outbox enqueue, every attempt is audited, and the review message is updated.
 */

const NOW = 1_700_000_001_000;
const ADMIN_ROLE = '900000000000000001';
const CHANNEL = '100000000000000002';

const allowEvidence: OutboundEvidenceResult = { outcome: 'allow', reasons: [] };
const allowProvenance: ProvenanceGateResult = { outcome: 'allow', reasons: [] };
const rejectEvidence: OutboundEvidenceResult = {
  outcome: 'reject',
  reasons: ['target channel "c" no longer allows interventions'],
};
const cooldownAllow: CooldownDecision = { allowed: true, blocks: [], retryAfterMs: null };
const cooldownBlock: CooldownDecision = {
  allowed: false,
  blocks: [{ rule: 'channel_cooldown', retryAfterMs: NOW + 60_000, detail: 'channel cooling down' }],
  retryAfterMs: NOW + 60_000,
};
const noDuplicate: DuplicateResult = { matched: false };
const duplicateMatch: DuplicateResult = {
  matched: true,
  kind: 'near',
  similarity: 0.92,
  matchedPreview: 'heads up',
  matchedSentAtMs: NOW - 1_000,
  source: 'outbox',
};

type Env = TestDb & { guildId: string; channelId: string; userId: string };

let env: Env;

beforeEach(() => {
  const base = createTestDb();
  env = { ...base, ...seedIdentity(base.db) };
  env.db
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
       VALUES (?,?,NULL,'episode','pv','faux','faux-1','completed',?)`,
    )
    .run('run-1', env.guildId, NOW);
});
afterEach(() => env.cleanup());

function seedProposal(over: Partial<{ status: ProposalStatus; message: string | null; expiresAtMs: number | null }> = {}): string {
  const id = insertProposal(env.db, {
    runId: 'run-1',
    targetChannelId: CHANNEL,
    status: over.status ?? 'pending_review',
    computedScore: 0.84,
    reason: ['routed to review'],
    evidenceMessageIds: ['m1'],
    message: over.message === undefined ? 'safe outbound text' : over.message,
    expiresAtMs: over.expiresAtMs ?? null,
    now: NOW,
  });
  setProposalReviewMessage(env.db, id, 'rm-1', NOW);
  return id;
}

function resolveSink(): { calls: ReviewResolution[]; resolve: (r: ReviewResolution) => Promise<void> } {
  const calls: ReviewResolution[] = [];
  return {
    calls,
    resolve: async (r) => {
      calls.push(r);
    },
  };
}

describe('recheckApprovalPolicy — current-state gate', () => {
  it('allows when evidence, cooldown, and duplicate all pass', () => {
    expect(
      recheckApprovalPolicy({ provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate }),
    ).toEqual({ allow: true, reasons: [] });
  });

  it('blocks on a definite evidence violation', () => {
    const r = recheckApprovalPolicy({ provenance: allowProvenance, outboundEvidence: rejectEvidence, cooldown: cooldownAllow, duplicate: noDuplicate });
    expect(r.allow).toBe(false);
    expect(r.reasons).toContain('target channel "c" no longer allows interventions');
  });

  it('blocks on an active cooldown', () => {
    const r = recheckApprovalPolicy({ provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownBlock, duplicate: noDuplicate });
    expect(r.allow).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('rate-limited'))).toBe(true);
  });

  it('blocks on a matched duplicate', () => {
    const r = recheckApprovalPolicy({ provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: duplicateMatch });
    expect(r.allow).toBe(false);
    expect(r.reasons.some((x) => x.includes('duplicate'))).toBe(true);
  });

  it('fails closed on unresolved scope uncertainty even when a human is approving', () => {
    const r = recheckApprovalPolicy({
      provenance: allowProvenance,
      outboundEvidence: { outcome: 'force_review', reasons: ['unresolvable scope'] },
      cooldown: cooldownAllow,
      duplicate: noDuplicate,
    });
    expect(r.allow).toBe(false);
    expect(r.reasons).toContain('unresolvable scope');
  });

  it('blocks when original retrieval provenance is not permitted in the target', () => {
    const r = recheckApprovalPolicy({
      provenance: { outcome: 'force_review', reasons: ['restricted provenance'] },
      outboundEvidence: allowEvidence,
      cooldown: cooldownAllow,
      duplicate: noDuplicate,
    });
    expect(r.allow).toBe(false);
    expect(r.reasons).toContain('restricted provenance');
  });
});

describe('approveProposal — authorization', () => {
  it('approves for a configured admin and records the reviewer before enqueue', async () => {
    const id = seedProposal();
    const { calls, resolve } = resolveSink();

    const res = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db, resolveReview: resolve },
    );

    expect(res.outcome).toBe('approved');
    expect(res.enqueued).toBe(true);
    expect(res.outboxId).toBeTruthy();

    const proposal = getProposal(env.db, id)!;
    expect(proposal.status).toBe('approved');
    expect(proposal.reviewedByUserId).toBe('alice');
    expect(proposal.reviewedAtMs).toBe(NOW);

    // Exactly one queued outbox row, anchored on the proposal dedupe key.
    const row = getOutboxByDedupeKey(env.db, `proposal:${id}`)!;
    expect(row.status).toBe('queued');
    expect(row.content).toBe('safe outbound text');
    expect(row.channelId).toBe(CHANNEL);

    // The review message was updated to show the approved status.
    expect(calls).toEqual([{
      reviewMessageId: 'rm-1',
      label: '✅ Approved — delivery queued',
      removeControls: true,
    }]);

    // The attempt is audited.
    expect(countAdminEvents(env.db, env.guildId)).toBe(1);
  });

  it('rejects a non-admin click without changing the proposal or enqueueing', async () => {
    const id = seedProposal();
    const res = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: ['role-other'],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'bob',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db },
    );

    expect(res.outcome).toBe('unauthorized');
    expect(getProposal(env.db, id)!.status).toBe('pending_review');
    expect(getOutboxByDedupeKey(env.db, `proposal:${id}`)).toBeUndefined();
    // Denials are still audited.
    expect(countAdminEvents(env.db, env.guildId)).toBe(1);
  });

  it('fails closed when no admin roles are configured', async () => {
    const id = seedProposal();
    const res = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db },
    );
    expect(res.outcome).toBe('unauthorized');
    expect(getProposal(env.db, id)!.status).toBe('pending_review');
  });

  it('fails closed when the member role data is unavailable', async () => {
    const id = seedProposal();
    const res = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: null,
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db },
    );
    expect(res.outcome).toBe('unauthorized');
  });
});

describe('approveProposal — stale, expired, and missing proposals', () => {
  it('reports stale for an already-approved proposal and does not enqueue again', async () => {
    const id = seedProposal();
    await approveProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db },
    );
    const second = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'bob',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW + 1,
      },
      { db: env.db },
    );
    expect(second.outcome).toBe('stale');
    // Still exactly one outbox row (idempotent re-approval).
    expect(getOutboxByDedupeKey(env.db, `proposal:${id}`)!.status).toBe('queued');
    expect(countAdminEvents(env.db, env.guildId)).toBe(2);
  });

  it('finalizes an expired proposal without enqueuing', async () => {
    const id = seedProposal({ expiresAtMs: NOW - 1 });
    const { calls, resolve } = resolveSink();
    const res = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db, resolveReview: resolve },
    );
    expect(res.outcome).toBe('expired');
    expect(getProposal(env.db, id)!.status).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${id}`)).toBeUndefined();
    expect(calls[0]?.label).toContain('Expired');
  });

  it('reports not_found for an unknown proposal', async () => {
    const res = await approveProposal(
      {
        proposalId: 'nope',
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db },
    );
    expect(res.outcome).toBe('not_found');
  });
});

describe('approveProposal — policy changes block the send', () => {
  it('leaves the proposal pending and does not enqueue when a cooldown arose', async () => {
    const id = seedProposal();
    const { calls, resolve } = resolveSink();
    const res = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownBlock, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db, resolveReview: resolve },
    );
    expect(res.outcome).toBe('policy_blocked');
    expect(getProposal(env.db, id)!.status).toBe('pending_review');
    expect(getOutboxByDedupeKey(env.db, `proposal:${id}`)).toBeUndefined();
    expect(calls[0]?.label).toContain('remains pending review');
    expect(calls[0]?.label).toContain('can be retried');
    expect(calls[0]?.removeControls).toBe(false);
  });

  it('keeps the review card actionable when the pending proposal has no message text', async () => {
    const id = seedProposal({ message: null });
    const { calls, resolve } = resolveSink();
    const res = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db, resolveReview: resolve },
    );

    expect(res.outcome).toBe('policy_blocked');
    expect(getProposal(env.db, id)!.status).toBe('pending_review');
    expect(getOutboxByDedupeKey(env.db, `proposal:${id}`)).toBeUndefined();
    expect(calls).toEqual([{
      reviewMessageId: 'rm-1',
      label: '⛔ Not sent: proposal has no proposed message text. Proposal remains pending review and can be retried after the current block clears.',
      removeControls: false,
    }]);
  });

  it('blocks when the target channel policy changed (evidence reject)', async () => {
    const id = seedProposal();
    const res = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: rejectEvidence, cooldown: cooldownAllow, duplicate: noDuplicate },
        now: NOW,
      },
      { db: env.db },
    );
    expect(res.outcome).toBe('policy_blocked');
    expect(getOutboxByDedupeKey(env.db, `proposal:${id}`)).toBeUndefined();
  });

  it('tells a button approver that a policy-blocked proposal remains retryable', async () => {
    const id = seedProposal();
    const replies: Array<{ content?: string }> = [];
    const interaction = {
      isButton: () => true,
      customId: signReviewComponent('approve', id, 'review-secret'),
      guildId: env.guildId,
      user: { id: 'alice' },
      member: { roles: [ADMIN_ROLE] },
      deferred: false,
      replied: false,
      reply: async (payload: { content?: string }) => { replies.push(payload); },
    } as unknown as ButtonInteraction;

    await createReviewButtonHandler({
      db: env.db,
      secret: 'review-secret',
      adminRoleIds: [ADMIN_ROLE],
      buildRecheck: () => ({
        provenance: allowProvenance,
        outboundEvidence: rejectEvidence,
        cooldown: cooldownAllow,
        duplicate: noDuplicate,
      }),
      now: () => NOW,
    })(interaction);

    expect(replies[0]?.content).toContain('remains pending review');
    expect(replies[0]?.content).toContain('can be retried');
    expect(getProposal(env.db, id)!.status).toBe('pending_review');
  });

  it('blocks when the message is now a duplicate', async () => {
    const id = seedProposal();
    const res = await approveProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        recheck: { provenance: allowProvenance, outboundEvidence: allowEvidence, cooldown: cooldownAllow, duplicate: duplicateMatch },
        now: NOW,
      },
      { db: env.db },
    );
    expect(res.outcome).toBe('policy_blocked');
  });
});

describe('dismissProposal', () => {
  it('finalizes a pending proposal as dismissed and never enqueues', async () => {
    const id = seedProposal();
    const { calls, resolve } = resolveSink();
    const res = await dismissProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        reason: 'already handled',
        now: NOW,
      },
      { db: env.db, resolveReview: resolve },
    );
    expect(res.outcome).toBe('dismissed');
    const proposal = getProposal(env.db, id)!;
    expect(proposal.status).toBe('dismissed');
    expect(proposal.reviewedByUserId).toBe('alice');
    expect(proposal.dismissalReason).toBe('already handled');
    expect(getOutboxByDedupeKey(env.db, `proposal:${id}`)).toBeUndefined();
    expect(calls[0]?.label).toContain('Dismissed');
    expect(countAdminEvents(env.db, env.guildId)).toBe(1);
  });

  it('rejects a non-admin dismissal', async () => {
    const id = seedProposal();
    const res = await dismissProposal(
      {
        proposalId: id,
        memberRoleIds: [],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'bob',
        guildId: env.guildId,
        now: NOW,
      },
      { db: env.db },
    );
    expect(res.outcome).toBe('unauthorized');
    expect(getProposal(env.db, id)!.status).toBe('pending_review');
  });
});
