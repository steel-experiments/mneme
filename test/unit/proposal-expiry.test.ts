import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  insertProposal,
  getProposal,
  setProposalReviewMessage,
  expirePendingProposals,
  type ProposalStatus,
} from '../../src/db/repositories/proposals.js';
import {
  dismissProposal,
  MAX_DISMISSAL_REASON_CHARS,
} from '../../src/review/workflow.js';
import { createExpireProposalsHandler } from '../../src/jobs/handlers/expire-proposals.js';
import { countAdminEvents } from '../../src/db/repositories/admin-events.js';

/**
 * Proposal dismissal reason and expiry maintenance (Section 25).
 *
 * Acceptance: dismissed and expired proposals cannot later enqueue output and
 * remain available for evaluation metrics. The dismissal reason is persisted on
 * the row; the expiry sweep is idempotent and only ever finalizes past-deadline
 * `pending_review` rows — never approved, sent, dismissed, observed, or
 * already-expired ones.
 */

const NOW = 1_700_000_000_000;
const ADMIN_ROLE = '900000000000000001';

type Env = TestDb & { guildId: string; channelId: string; userId: string };

let env: Env;
let db: DatabaseSync;

beforeEach(() => {
  const base = createTestDb();
  const seeded = seedIdentity(base.db);
  env = { ...base, ...seeded };
  db = env.db;
  db.prepare(
    `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
     VALUES (?,?,NULL,'episode','pv','faux','faux-1','completed',?)`,
  ).run('run-1', env.guildId, NOW);
});
afterEach(() => env.cleanup());

function seedProposal(over: Partial<{ status: ProposalStatus; expiresAtMs: number | null }> = {}): string {
  const id = insertProposal(db, {
    runId: 'run-1',
    targetChannelId: env.channelId,
    status: over.status ?? 'pending_review',
    computedScore: 0.84,
    reason: ['routed to review'],
    evidenceMessageIds: ['m1'],
    message: 'safe outbound text',
    expiresAtMs: over.expiresAtMs ?? null,
    now: NOW,
  });
  setProposalReviewMessage(db, id, 'rm-1', NOW);
  return id;
}

describe('expirePendingProposals — idempotent sweep', () => {
  it('expires only past-deadline pending_review proposals', () => {
    const expired = seedProposal({ expiresAtMs: NOW - 1 }); // past deadline
    const future = seedProposal({ expiresAtMs: NOW + 60_000 }); // not yet due
    const noDeadline = seedProposal({ expiresAtMs: null }); // no expiry

    const ids = expirePendingProposals(db, NOW + 1);

    expect(ids).toEqual([expired]);
    expect(getProposal(db, expired)!.status).toBe('expired');
    expect(getProposal(db, future)!.status).toBe('pending_review');
    expect(getProposal(db, noDeadline)!.status).toBe('pending_review');
  });

  it.each([
    ['approved', 'approved'],
    ['sent', 'sent'],
    ['dismissed', 'dismissed'],
    ['observed', 'observed'],
    ['already-expired', 'expired'],
  ] as Array<[ProposalStatus, ProposalStatus]>)(
    'never expires a %s proposal even when its deadline passed',
    (_label, status) => {
      const id = seedProposal({ status, expiresAtMs: NOW - 1000 });
      const ids = expirePendingProposals(db, NOW);
      expect(ids).toEqual([]);
      expect(getProposal(db, id)!.status).toBe(status);
    },
  );

  it('is idempotent: a second sweep changes nothing', () => {
    const a = seedProposal({ expiresAtMs: NOW - 1 });
    const b = seedProposal({ expiresAtMs: NOW - 1 });

    const first = expirePendingProposals(db, NOW);
    expect(first.sort()).toEqual([a, b].sort());

    const second = expirePendingProposals(db, NOW);
    expect(second).toEqual([]);
    expect(getProposal(db, a)!.status).toBe('expired');
    expect(getProposal(db, b)!.status).toBe('expired');
  });

  it('updates at most the requested bounded batch and converges across passes', () => {
    const ids = [
      seedProposal({ expiresAtMs: NOW - 3 }),
      seedProposal({ expiresAtMs: NOW - 2 }),
      seedProposal({ expiresAtMs: NOW - 1 }),
    ];

    const first = expirePendingProposals(db, NOW, 2);
    expect(first).toHaveLength(2);
    expect(ids.filter((id) => getProposal(db, id)!.status === 'pending_review')).toHaveLength(1);

    const second = expirePendingProposals(db, NOW, 2);
    expect(second).toHaveLength(1);
    expect(ids.every((id) => getProposal(db, id)!.status === 'expired')).toBe(true);
  });

  it('expired proposals remain in the table for evaluation metrics', () => {
    const id = seedProposal({ expiresAtMs: NOW - 1 });
    expirePendingProposals(db, NOW);
    const row = getProposal(db, id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('expired');
  });
});

describe('expire-proposals maintenance handler', () => {
  it('runExpiry performs the sweep and returns the transitioned ids', async () => {
    const expired = seedProposal({ expiresAtMs: NOW - 1 });
    const pending = seedProposal({ expiresAtMs: NOW + 60_000 });

    const handler = createExpireProposalsHandler({ db, now: () => NOW });
    const res = await handler.runExpiry();

    expect(res.expiredIds).toEqual([expired]);
    expect(getProposal(db, expired)!.status).toBe('expired');
    expect(getProposal(db, pending)!.status).toBe('pending_review');
  });

  it('drains more than one bounded batch in a single maintenance run', async () => {
    const ids = Array.from({ length: 251 }, (_, index) =>
      seedProposal({ expiresAtMs: NOW - index - 1 }));
    const handler = createExpireProposalsHandler({ db, now: () => NOW });

    const res = await handler.runExpiry();

    expect(res.expiredIds).toHaveLength(251);
    expect(ids.every((id) => getProposal(db, id)!.status === 'expired')).toBe(true);
  });

  it('invoked as a job handler runs the sweep with an empty payload', async () => {
    const id = seedProposal({ expiresAtMs: NOW - 1 });
    const handler = createExpireProposalsHandler({ db, now: () => NOW });

    await handler({} as Record<string, never>, {} as never);

    expect(getProposal(db, id)!.status).toBe('expired');
  });

  it('is a no-op when nothing is past deadline', async () => {
    seedProposal({ expiresAtMs: NOW + 60_000 });
    const handler = createExpireProposalsHandler({ db, now: () => NOW });
    const res = await handler.runExpiry();
    expect(res.expiredIds).toEqual([]);
  });
});

describe('dismissal reason persistence', () => {
  it('stores the bounded dismissal reason on the proposal row', async () => {
    const id = seedProposal();
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
      { db },
    );
    expect(res.outcome).toBe('dismissed');
    const proposal = getProposal(db, id)!;
    expect(proposal.status).toBe('dismissed');
    expect(proposal.dismissalReason).toBe('already handled');
    expect(proposal.reviewedByUserId).toBe('alice');
    expect(proposal.reviewedAtMs).toBe(NOW);
    expect(countAdminEvents(db, env.guildId)).toBe(1);
  });

  it('stores null when no reason is given', async () => {
    const id = seedProposal();
    await dismissProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        now: NOW,
      },
      { db },
    );
    expect(getProposal(db, id)!.dismissalReason).toBeNull();
  });

  it('trims whitespace and truncates over-length reasons to the bound', async () => {
    const id = seedProposal();
    const long = 'x'.repeat(MAX_DISMISSAL_REASON_CHARS + 50);
    await dismissProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        reason: `   ${long}   `,
        now: NOW,
      },
      { db },
    );
    const stored = getProposal(db, id)!.dismissalReason!;
    expect(stored.length).toBe(MAX_DISMISSAL_REASON_CHARS);
    expect(stored).toBe('x'.repeat(MAX_DISMISSAL_REASON_CHARS));
  });

  it('a dismissed proposal never enqueues output', async () => {
    const id = seedProposal();
    await dismissProposal(
      {
        proposalId: id,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: [ADMIN_ROLE],
        actorUserId: 'alice',
        guildId: env.guildId,
        reason: 'dup',
        now: NOW,
      },
      { db },
    );
    // The outbox is keyed on the proposal; a dismissed proposal must not have one.
    const outbox = db
      .prepare('SELECT id FROM outbox WHERE proposal_id = ?')
      .all(id) as Array<{ id: string }>;
    expect(outbox).toEqual([]);
    expect(getProposal(db, id)!.status).toBe('dismissed');
  });

  it('an expired proposal is finalized and never enqueued output', () => {
    const id = seedProposal({ expiresAtMs: NOW - 1 });
    expirePendingProposals(db, NOW);
    // Expiry left the row in place for metrics but produced no outbox row.
    const outbox = db
      .prepare('SELECT id FROM outbox WHERE proposal_id = ?')
      .all(id) as Array<{ id: string }>;
    expect(outbox).toEqual([]);
    expect(getProposal(db, id)!.status).toBe('expired');
  });
});
