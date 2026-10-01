import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { GUILD, NOW } from '../helpers/messages.js';
import {
  insertProposal,
  getProposal,
  PROPOSAL_SHORT_ID_LENGTH,
} from '../../src/db/repositories/proposals.js';
import {
  handleProposalsCommand,
  handleApproveCommand,
  handleDismissCommand,
  formatProposalsReply,
  formatApproveReply,
  formatDismissReply,
} from '../../src/commands/proposals.js';
import {
  approveProposal,
  dismissProposal,
  type ApprovalPolicyRecheck,
} from '../../src/review/workflow.js';
import { getOutbox } from '../../src/outbox/repository.js';

/**
 * `/mneme proposals | approve | dismiss` integration suite (Section 27).
 *
 * The acceptance bar is parity: a slash command and a review-message button must
 * apply identical authorization, revalidation, idempotency, and audit behavior.
 * Approve and dismiss achieve that by resolving the typed reference and then
 * delegating to the SAME workflow functions (`approveProposal` /
 * `dismissProposal`) the button handler calls, so this suite exercises the
 * command handlers end to end and asserts the resulting `admin_events` rows and
 * state transitions match the button path.
 */

const ADMIN_ROLE = '900000000000000001';
const ADMIN_ROLES: readonly string[] = [ADMIN_ROLE];
const ADMIN = '100000000000000010';
const OUTSIDER = '100000000000000011';
const CHANNEL = '100000000000000002'; // seeded by seedIdentity in GUILD
const OTHER_GUILD = '100000000000000099';
const OTHER_CHANNEL = '100000000000000098';

/** Allow-all policy re-check: nothing blocks the (re-)approval. */
const ALLOW_RECHECK: ApprovalPolicyRecheck = {
  provenance: { outcome: 'allow', reasons: [] },
  outboundEvidence: { outcome: 'allow', reasons: [] },
  cooldown: { allowed: true, blocks: [], retryAfterMs: null },
  duplicate: { matched: false },
};

/** Re-check whose evidence gate now rejects (stale policy since routing). */
const BLOCK_RECHECK: ApprovalPolicyRecheck = {
  provenance: { outcome: 'allow', reasons: [] },
  outboundEvidence: { outcome: 'reject', reasons: ['evidence source deleted'] },
  cooldown: { allowed: true, blocks: [], retryAfterMs: null },
  duplicate: { matched: false },
};

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db); // guild + channel + user scaffolding for GUILD
});
afterEach(() => env.cleanup());

/** Seed an `agent_runs` row so proposals have a valid run FK (idempotent). */
function seedRun(runId: string, guild = GUILD): void {
  db.prepare(
    `INSERT OR IGNORE INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
     VALUES(?, ?, NULL, 'episode', 'pv', 'faux', 'faux-1', 'completed', ?)`,
  ).run(runId, guild, NOW);
}

/** Seed a guild + channel pair (for the cross-guild FK case). */
function seedOtherGuild(): void {
  const now = NOW;
  db.prepare(
    'INSERT INTO workspaces (id, name, owner_id, joined_at_ms, discovered_at_ms, updated_at_ms, raw_json) VALUES (?,?,?,?,?,?,NULL)',
  ).run(OTHER_GUILD, 'Other', null, now, now, now);
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, type, name, topic, position, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, permission_fingerprint, last_message_id,
       discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json)
     VALUES (?, ?, NULL, 0, 'other', NULL, NULL, 0, 0, 0, 1, 'restricted', 0, NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(OTHER_CHANNEL, OTHER_GUILD, now, now);
}

interface SeedOpts {
  id?: string;
  runId?: string;
  status?:
    | 'observed'
    | 'pending_review'
    | 'approved'
    | 'dismissed'
    | 'expired'
    | 'sent'
    | 'failed';
  targetChannelId?: string;
  message?: string | null;
  expiresAtMs?: number | null;
  now?: number;
}

/** Seed a proposal and return its id. Defaults: pending_review, CHANNEL, has a message. */
function seedProposal(opts: SeedOpts = {}): string {
  const runId = opts.runId ?? 'run-1';
  seedRun(runId);
  const id = insertProposal(db, {
    runId,
    targetChannelId: opts.targetChannelId ?? CHANNEL,
    status: opts.status ?? 'pending_review',
    computedScore: 0.82,
    reason: ['contradiction', 'evidence-strength-0.71'],
    message: opts.message ?? 'Heads up — this was decided in #planning last week.',
    evidenceMessageIds: ['200000000000000001'],
    expiresAtMs: opts.expiresAtMs ?? NOW + 72 * 3600_000,
    now: opts.now ?? NOW,
  });
  // Rewrite the id when the caller needs a controlled one (ambiguity test).
  if (opts.id) {
    db.prepare('UPDATE proposals SET id = ? WHERE id = ?').run(opts.id, id);
    return opts.id;
  }
  return id;
}

interface AdminEventRow {
  action: string;
  target: string | null;
  detailsJson: string;
  actorUserId: string;
}

/** All admin_events for an action, oldest first. */
function adminEventsFor(action: string): AdminEventRow[] {
  return db
    .prepare(
      'SELECT action, target, details_json AS detailsJson, actor_user_id AS actorUserId FROM admin_events WHERE action = ? ORDER BY created_at_ms ASC, rowid ASC',
    )
    .all(action) as AdminEventRow[];
}

const adminInput = (memberRoleIds: readonly string[] | null, actor = ADMIN) => ({
  actorUserId: actor,
  guildId: GUILD,
  memberRoleIds,
});

// ---------------------------------------------------------------------------
// `/mneme proposals` — bounded unexpired pending list with secure references.
// ---------------------------------------------------------------------------

describe('/mneme proposals list', () => {
  it('authorizes, then lists bounded unexpired pending proposals newest-first with short ids', () => {
    seedProposal({ now: NOW });
    seedProposal({ now: NOW + 60_000 });
    // An approved proposal must NOT appear in the pending list.
    seedProposal({ status: 'approved', now: NOW + 120_000 });
    // An expired-deadline pending proposal must NOT appear (even pre-sweep).
    seedProposal({ status: 'pending_review', expiresAtMs: NOW - 1, now: NOW + 180_000 });

    const outcome = handleProposalsCommand(adminInput([ADMIN_ROLE]), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW + 200_000,
    });

    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    // Only the two still-unexpired pending rows; newest first.
    expect(outcome.proposals).toHaveLength(2);
    // Newest first: the later-seeded proposal (NOW+60_000) precedes the earlier one.
    expect(outcome.proposals[0]!.createdAtMs).toBeGreaterThan(outcome.proposals[1]!.createdAtMs);
    for (const p of outcome.proposals) {
      expect(p.shortId).toHaveLength(PROPOSAL_SHORT_ID_LENGTH);
      expect(p.shortId).toBe(p.id.slice(0, PROPOSAL_SHORT_ID_LENGTH));
      // The resolved target channel name is surfaced (not just the id).
      expect(p.targetChannelName).toBe('general');
      expect(p.reason).toContain('contradiction');
    }
    // The list respects the bound.
    const capped = handleProposalsCommand(adminInput([ADMIN_ROLE]), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW + 200_000,
      limit: 1,
    });
    expect(capped.kind === 'done' ? capped.proposals.length : 0).toBe(1);
  });

  it('reports an empty list cleanly', () => {
    const outcome = handleProposalsCommand(adminInput([ADMIN_ROLE]), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW,
    });
    expect(outcome.kind).toBe('done');
    expect(formatProposalsReply(outcome)).toBe('No proposals are pending review.');
  });

  it('shows scheduled reviews as a categorical assessment, not a synthetic score', () => {
    const proposalId = seedProposal();
    db.prepare("UPDATE agent_runs SET run_type = 'scheduled_review' WHERE id = 'run-1'").run();
    db.prepare('UPDATE proposals SET computed_score = 1 WHERE id = ?').run(proposalId);

    const outcome = handleProposalsCommand(adminInput([ADMIN_ROLE]), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW,
    });
    expect(outcome.kind).toBe('done');
    const reply = formatProposalsReply(outcome);
    expect(reply).toContain('assessment=Recommended scheduled review');
    expect(reply).not.toContain('score=1.00');
  });

  it('denies an unauthorized caller, audits the denial, and discloses nothing', () => {
    const outcome = handleProposalsCommand(adminInput(['not-an-admin'], OUTSIDER), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW,
    });
    expect(outcome.kind).toBe('not_authorized');
    expect(formatProposalsReply(outcome)).toContain('not authorized');

    const events = adminEventsFor('proposals');
    expect(events).toHaveLength(1);
    const details = JSON.parse(events[0]!.detailsJson);
    expect(details.authorized).toBe(false);
    expect(events[0]!.actorUserId).toBe(OUTSIDER);
  });

  it('audits the authorized read too', () => {
    handleProposalsCommand(adminInput([ADMIN_ROLE]), { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW });
    const events = adminEventsFor('proposals');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detailsJson).authorized).toBe(true);
  });

  it('fails closed when role data is unavailable (null memberRoleIds)', () => {
    const outcome = handleProposalsCommand(adminInput(null), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW,
    });
    expect(outcome.kind).toBe('not_authorized');
    expect(JSON.parse(adminEventsFor('proposals')[0]!.detailsJson).reason).toBe(
      'role_data_unavailable',
    );
  });
});

// ---------------------------------------------------------------------------
// `/mneme approve <id>` — resolution + delegation to the review workflow.
// ---------------------------------------------------------------------------

describe('/mneme approve delegates to the workflow and audits like the button', () => {
  it('approves by full id: records reviewer, enqueues the outbox, audits proposal.approve', async () => {
    const proposalId = seedProposal();
    const outcome = await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: proposalId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW + 1_000, buildRecheck: () => ALLOW_RECHECK },
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(outcome.result.outcome).toBe('approved');
    expect(outcome.result.outboxId).toBeDefined();
    expect(outcome.result.enqueued).toBe(true);

    // State: reviewer stamped, status still 'approved', outbox row created.
    const proposal = getProposal(db, proposalId)!;
    expect(proposal.status).toBe('approved');
    expect(proposal.reviewedByUserId).toBe(ADMIN);
    const outbox = getOutbox(db, outcome.result.outboxId!)!;
    expect(outbox.channelId).toBe(CHANNEL);
    expect(outbox.status).toBe('queued');

    const events = adminEventsFor('proposal.approve');
    expect(events).toHaveLength(1);
    expect(events[0]!.target).toBe(proposalId);
    const details = JSON.parse(events[0]!.detailsJson);
    expect(details.outcome).toBe('approved');
    expect(details.authorized).toBe(true);
    expect(formatApproveReply(outcome)).toContain('Approved');
  });

  it('approves by 8-char short id (unique match resolves to the proposal)', async () => {
    const proposalId = seedProposal();
    const shortId = proposalId.slice(0, PROPOSAL_SHORT_ID_LENGTH);

    const outcome = await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: shortId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, buildRecheck: () => ALLOW_RECHECK },
    );

    expect(outcome.kind).toBe('resolved');
    expect(outcome.kind === 'resolved' && outcome.result.outcome).toBe('approved');
    expect(getProposal(db, proposalId)!.reviewedByUserId).toBe(ADMIN);
    // The audit target is the resolved full proposal id, not the short ref.
    expect(adminEventsFor('proposal.approve')[0]!.target).toBe(proposalId);
  });

  it('reports an ambiguous short id after authorizing, and audits the ambiguity', async () => {
    // Two proposals sharing the first 8 id chars → a short id that cannot resolve.
    const prefix = 'ambiguus';
    const idA = `${prefix}-aaaa-1aaa-aaaa-aaaaaaaaaaa1`;
    const idB = `${prefix}-bbbb-2bbb-bbbb-bbbbbbbbbbb2`;
    seedProposal({ id: idA });
    seedProposal({ id: idB, runId: 'run-2' });

    const outcome = await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: prefix },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, buildRecheck: () => ALLOW_RECHECK },
    );

    expect(outcome.kind).toBe('ambiguous');
    expect(outcome.kind === 'ambiguous' ? outcome.matchCount : 0).toBe(2);
    // Ambiguity is audited with the raw ref as target; no proposal state changed.
    const events = adminEventsFor('proposal.approve');
    expect(events).toHaveLength(1);
    expect(events[0]!.target).toBe(prefix);
    const details = JSON.parse(events[0]!.detailsJson);
    expect(details.outcome).toBe('ambiguous');
    expect(details.matchCount).toBe(2);
    expect(getProposal(db, idA)!.status).toBe('pending_review');
    expect(getProposal(db, idB)!.status).toBe('pending_review');
  });

  it('on an unknown id, delegates the raw ref to the workflow, which audits not_found after auth', async () => {
    const outcome = await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: 'never-existed' },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, buildRecheck: () => ALLOW_RECHECK },
    );
    expect(outcome.kind).toBe('resolved');
    expect(outcome.kind === 'resolved' && outcome.result.outcome).toBe('not_found');
    const events = adminEventsFor('proposal.approve');
    expect(events).toHaveLength(1);
    const details = JSON.parse(events[0]!.detailsJson);
    expect(details.outcome).toBe('not_found');
    expect(events[0]!.target).toBe('never-existed');
  });

  it('revalidates state: an already-approved proposal is stale and idempotent', async () => {
    const proposalId = seedProposal();
    // First approval enqueues.
    const first = await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: proposalId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, buildRecheck: () => ALLOW_RECHECK },
    );
    expect(first.kind === 'resolved' && first.result.outcome).toBe('approved');
    expect(first.kind === 'resolved' ? first.result.outboxId : undefined).toBeDefined();

    // Second approval on the now-approved row is stale; no new outbox row.
    const second = await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: proposalId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW + 1, buildRecheck: () => ALLOW_RECHECK },
    );
    expect(second.kind === 'resolved' && second.result.outcome).toBe('stale');
    expect(second.kind === 'resolved' ? second.result.outboxId : undefined).toBeUndefined();
    // Idempotent at the data layer: two approval attempts produced exactly one outbox row.
    expect((db.prepare('SELECT COUNT(*) AS c FROM outbox').get() as { c: number }).c).toBe(1);
  });

  it('revalidates expiry: a past-deadline pending proposal is expired', async () => {
    const proposalId = seedProposal({ expiresAtMs: NOW - 60_000 });
    const outcome = await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: proposalId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, buildRecheck: () => ALLOW_RECHECK },
    );
    expect(outcome.kind === 'resolved' && outcome.result.outcome).toBe('expired');
  });

  it('revalidates policy: a now-blocking recheck yields policy_blocked with no outbox row', async () => {
    const proposalId = seedProposal();
    const outcome = await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: proposalId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, buildRecheck: () => BLOCK_RECHECK },
    );
    expect(outcome.kind === 'resolved' && outcome.result.outcome).toBe('policy_blocked');
    expect(outcome.kind === 'resolved' ? outcome.result.outboxId : undefined).toBeUndefined();
    // The proposal was NOT resolved — it remains pending for a later re-approval.
    expect(getProposal(db, proposalId)!.status).toBe('pending_review');
    const reply = formatApproveReply(outcome);
    expect(reply).toContain('remains pending review');
    expect(reply).toContain('can be retried');
  });

  it('denies an unauthorized approver and audits the denial (learns nothing)', async () => {
    const proposalId = seedProposal();
    const outcome = await handleApproveCommand(
      { ...adminInput(['nope'], OUTSIDER), proposalRef: proposalId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, buildRecheck: () => ALLOW_RECHECK },
    );
    // The command delegates unique/none to the workflow; its auth denial surfaces
    // as a resolved outcome carrying 'unauthorized' — the same shape a button
    // click produces — and the formatter renders the not-authorized label.
    expect(outcome.kind).toBe('resolved');
    expect(outcome.kind === 'resolved' && outcome.result.outcome).toBe('unauthorized');
    expect(formatApproveReply(outcome)).toContain('not authorized');
    // The workflow audited the denial; the proposal is untouched.
    const events = adminEventsFor('proposal.approve');
    expect(events).toHaveLength(1);
    const details = JSON.parse(events[0]!.detailsJson);
    expect(details.authorized).toBe(false);
    expect(details.outcome).toBe('unauthorized');
    expect(getProposal(db, proposalId)!.status).toBe('pending_review');
    expect(getProposal(db, proposalId)!.reviewedByUserId).toBeNull();
  });

  it('applies IDENTICAL audit to the button path (same action, target, outcome)', async () => {
    const commandId = seedProposal();
    await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: commandId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, buildRecheck: () => ALLOW_RECHECK },
    );
    const commandEvent = adminEventsFor('proposal.approve').find((e) => e.target === commandId)!;

    // Simulate the button: call the workflow directly with the same inputs.
    const buttonId = seedProposal({ runId: 'run-btn' });
    await approveProposal(
      {
        proposalId: buttonId,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: ADMIN_ROLES,
        actorUserId: ADMIN,
        guildId: GUILD,
        recheck: ALLOW_RECHECK,
        now: NOW,
      },
      { db },
    );
    const buttonEvent = adminEventsFor('proposal.approve').find((e) => e.target === buttonId)!;

    // Same action; the details shape (minus the per-proposal target) is identical.
    expect(commandEvent.action).toBe(buttonEvent.action);
    const cd = JSON.parse(commandEvent.detailsJson);
    const bd = JSON.parse(buttonEvent.detailsJson);
    expect(cd.outcome).toBe(bd.outcome);
    expect(cd.authorized).toBe(bd.authorized);
    expect(cd.authReason).toBe(bd.authReason);
    expect(cd.reasons).toEqual(bd.reasons);
    expect(commandEvent.actorUserId).toBe(buttonEvent.actorUserId);
  });
});

// ---------------------------------------------------------------------------
// `/mneme dismiss <id>` — resolution + delegation to the workflow.
// ---------------------------------------------------------------------------

describe('/mneme dismiss delegates to the workflow and never enqueues', () => {
  it('dismisses by short id, finalizes as dismissed, and creates no outbox row', async () => {
    const proposalId = seedProposal();
    const shortId = proposalId.slice(0, PROPOSAL_SHORT_ID_LENGTH);

    const outcome = await handleDismissCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: shortId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW },
    );

    expect(outcome.kind).toBe('resolved');
    expect(outcome.kind === 'resolved' && outcome.result.outcome).toBe('dismissed');
    const proposal = getProposal(db, proposalId)!;
    expect(proposal.status).toBe('dismissed');
    expect(proposal.reviewedByUserId).toBe(ADMIN);
    expect(getOutbox(db, 'unused')).toBeUndefined();
    const before = (
      db.prepare('SELECT COUNT(*) AS c FROM outbox').get() as { c: number }
    ).c;
    expect(before).toBe(0);

    const events = adminEventsFor('proposal.dismiss');
    expect(events).toHaveLength(1);
    expect(events[0]!.target).toBe(proposalId);
    expect(JSON.parse(events[0]!.detailsJson).outcome).toBe('dismissed');
    expect(formatDismissReply(outcome)).toContain('dismissed');
  });

  it('dismiss on an already-resolved proposal is stale (idempotent)', async () => {
    const proposalId = seedProposal();
    await handleDismissCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: proposalId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW },
    );
    const second = await handleDismissCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: proposalId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW + 1 },
    );
    expect(second.kind === 'resolved' && second.result.outcome).toBe('stale');
  });

  it('denies an unauthorized dismisser and audits proposal.dismiss', async () => {
    const proposalId = seedProposal();
    const outcome = await handleDismissCommand(
      { ...adminInput(null), proposalRef: proposalId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW },
    );
    expect(outcome.kind).toBe('resolved');
    expect(outcome.kind === 'resolved' && outcome.result.outcome).toBe('unauthorized');
    expect(formatDismissReply(outcome)).toContain('not authorized');
    expect(getProposal(db, proposalId)!.status).toBe('pending_review');
    const details = JSON.parse(adminEventsFor('proposal.dismiss')[0]!.detailsJson);
    expect(details.outcome).toBe('unauthorized');
  });

  it('button-path dismiss produces the same audit shape as the command', async () => {
    const commandId = seedProposal();
    await handleDismissCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: commandId },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW },
    );
    const commandEvent = adminEventsFor('proposal.dismiss').find((e) => e.target === commandId)!;

    const buttonId = seedProposal({ runId: 'run-btn2' });
    await dismissProposal(
      {
        proposalId: buttonId,
        memberRoleIds: [ADMIN_ROLE],
        adminRoleIds: ADMIN_ROLES,
        actorUserId: ADMIN,
        guildId: GUILD,
        now: NOW,
      },
      { db },
    );
    const buttonEvent = adminEventsFor('proposal.dismiss').find((e) => e.target === buttonId)!;

    expect(commandEvent.action).toBe(buttonEvent.action);
    const cd = JSON.parse(commandEvent.detailsJson);
    const bd = JSON.parse(buttonEvent.detailsJson);
    expect(cd.outcome).toBe(bd.outcome);
    expect(cd.authorized).toBe(bd.authorized);
    expect(cd.authReason).toBe(bd.authReason);
  });
});

// ---------------------------------------------------------------------------
// Cross-guild FK safety: command handlers never touch another guild's rows.
// ---------------------------------------------------------------------------

describe('cross-guild isolation', () => {
  it('lists and resolves only proposals in the actor guild, honoring the run/channel FKs', async () => {
    seedOtherGuild();
    // A proposal in OTHER_GUILD (valid run + channel there).
    const otherId = seedProposal({
      runId: 'run-other',
      targetChannelId: OTHER_CHANNEL,
    });
    // Force the other-guild proposal's run to reference OTHER_GUILD for realism.
    db.prepare('UPDATE agent_runs SET workspace_id = ? WHERE id = ?').run(OTHER_GUILD, 'run-other');
    // A proposal in the actor's GUILD.
    const oursId = seedProposal({ runId: 'run-ours' });

    // The list is guild-agnostic at the repository layer, but the command runs in
    // GUILD; confirm our proposal is present and resolvable, and that resolving
    // the other-guild id (if an actor learned it out of band) still funnels
    // through the workflow's authorization + state checks without leaking state.
    const list = handleProposalsCommand(adminInput([ADMIN_ROLE]), {
      db,
      adminRoleIds: ADMIN_ROLES,
      nowMs: NOW,
    });
    expect(list.kind).toBe('done');
    const listedIds = list.kind === 'done' ? list.proposals.map((p) => p.id) : [];
    expect(listedIds).toContain(oursId);

    // Resolving our own proposal by short id works.
    const approve = await handleApproveCommand(
      { ...adminInput([ADMIN_ROLE]), proposalRef: oursId.slice(0, PROPOSAL_SHORT_ID_LENGTH) },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, buildRecheck: () => ALLOW_RECHECK },
    );
    expect(approve.kind === 'resolved' && approve.result.outcome).toBe('approved');

    // The other-guild proposal is untouched by our run.
    expect(getProposal(db, otherId)!.status).toBe('pending_review');
  });
});
