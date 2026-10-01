import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { getMessage, upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { applyMemoryProposals, type AgentMemoryProposal } from '../../src/agent/memory-policy.js';
import {
  claimRevision, findSubjectForMember, getClaim, getRevision, listSubjectRevisions,
  validateRevisionEvidence,
} from '../../src/memory/attention-repository.js';
import { getDeadlineDecision, getDeadlineForgetCutoff } from '../../src/memory/deadline-decisions.js';
import { DEADLINE_PARSER_VERSION } from '../../src/memory/deadline-evidence.js';
import { forgetMessage } from '../../src/memory/deletion.js';

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002';
const ALICE = '100000000000000003';
const NOW = Date.parse('2026-09-15T12:00:00Z');
const DAY = 86_400_000;
const SEP18 = Date.parse('2026-09-18T23:59:59.999Z');
const SEP30 = Date.parse('2026-09-30T23:59:59.999Z');
const GRANT = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false, channelIds: [CHANNEL],
};
type DeadlineChange = NonNullable<AgentMemoryProposal['deadlineChange']>;
let env: TestDb;
let memoryId: string;
let subjectId: string;
let exposedMessageIds: Set<string>;

function seedMessage(id: string, content: string, createdAtMs = NOW - 2_000): void {
  upsertMessageCreate(env.db, {
    id, guildId: GUILD, channelId: CHANNEL, authorId: ALICE, authorDisplayName: 'Alice', content,
    createdAtMs, editedAtMs: null, replyToMessageId: null, messageType: 0, flags: 0, pinned: false,
    mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]', componentsJson: '[]', pollJson: null,
    rawJson: null, ingestedAtMs: NOW, updatedAtMs: NOW,
  });
  exposedMessageIds.add(id);
}

function deps(now = NOW, timezone = 'UTC') {
  return {
    db: env.db, grant: GRANT, guildId: GUILD, runId: 'run-deadline', now,
    exposedChannelIds: new Set([CHANNEL]), exposedMessageIds,
    exposedMemoryIds: new Set(memoryId ? [memoryId] : []), attentionTimezone: timezone,
  };
}

function proposal(sourceMessageId: string): AgentMemoryProposal {
  return {
    action: 'confirm', type: 'commitment', statement: 'The report is promised.', existingMemoryId: memoryId,
    confidence: 0.9, importance: 0.9, evidenceMessageIds: [sourceMessageId],
    evidenceQuotes: [{ messageId: sourceMessageId, quote: getMessage(env.db, sourceMessageId)!.content }],
    durability: 'project', durabilityReason: 'The report affects project delivery.',
  };
}

function apply(change: DeadlineChange, options: { now?: number; timezone?: string } = {}) {
  const outcome = applyMemoryProposals(deps(options.now, options.timezone), [{
    ...proposal(change.sourceMessageId), deadlineChange: change,
  }]);
  expect(outcome.rejected).toEqual([]);
  expect(outcome.applied).toHaveLength(1);
  subjectId = findSubjectForMember(env.db, memoryId)!;
  return outcome.applied[0]!.deadline!;
}

function set(sourceMessageId: string, expression = '18 September 2026'): DeadlineChange {
  return {
    action: 'set', sourceMessageId, quote: getMessage(env.db, sourceMessageId)!.content,
    dateExpression: expression,
  };
}

function clear(sourceMessageId: string): DeadlineChange {
  return { action: 'clear', sourceMessageId, quote: getMessage(env.db, sourceMessageId)!.content };
}

function claim(revisionId: string): void {
  env.db.prepare(`INSERT INTO agent_runs
    (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
    VALUES ('run-claim', ?, 'episode', 'p', 'test', 'test', 'completed', ?)`)
    .run(GUILD, NOW);
  env.db.prepare(`INSERT INTO proposals
    (id,run_id,target_channel_id,status,computed_score,reason,evidence_message_ids_json,created_at_ms,updated_at_ms)
    VALUES ('p-claim','run-claim',?,'pending_review',1,'r','[]',?,?)`)
    .run(CHANNEL, NOW, NOW);
  expect(claimRevision(env.db, {
    revisionId, proposalId: 'p-claim', consumedAtMs: NOW,
    eligibleFromMs: NOW - DAY, eligibleUntilMs: NOW + 6 * DAY,
  })).toBe(true);
}

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  exposedMessageIds = new Set();
  memoryId = '';
  seedMessage('origin', 'The report is promised.', NOW - 30 * DAY);
  const created = applyMemoryProposals(deps(), [{
    ...proposal('origin'), action: 'create', existingMemoryId: undefined,
  }]);
  expect(created.rejected).toEqual([]);
  memoryId = created.applied[0]!.memoryId!;
});
afterEach(() => env.cleanup());

describe('human deadline source ordering', () => {
  it('keeps a cancellation barrier when an old set is re-extracted', () => {
    seedMessage('old-set', 'The report is promised by 18 September 2026.', NOW - 20 * DAY);
    seedMessage('cancel', 'The report deadline is cancelled.', NOW - 19 * DAY);
    const first = apply(set('old-set'));
    expect(first.applied).toBe(true);
    expect(apply(clear('cancel')).applied).toBe(true);
    expect(apply(set('old-set'))).toMatchObject({ applied: false, reason: 'deadline_unverified' });
    expect(getDeadlineDecision(env.db, subjectId)).toMatchObject({ action: 'clear', sourceMessageId: 'cancel' });
    expect(getRevision(env.db, first.revisionId!)).toMatchObject({ state: 'superseded', explicitDeadlineAtMs: null });
    expect(env.db.prepare("SELECT COUNT(*) n FROM attention_revision_evidence WHERE role='explicit_deadline'").get())
      .toEqual({ n: 0 });
  });

  it('orders cancellation before any old set was registered, then accepts a newer human reschedule', () => {
    seedMessage('old-set', 'The report is promised by 18 September 2026.', NOW - 20 * DAY);
    seedMessage('cancel', 'The report deadline is cancelled.', NOW - 19 * DAY);
    seedMessage('new-set', 'The report is promised by 30 September 2026.', NOW - 18 * DAY);
    expect(apply(clear('cancel')).applied).toBe(true);
    expect(apply(set('old-set')).applied).toBe(false);
    expect(listSubjectRevisions(env.db, subjectId)).toHaveLength(0);
    expect(apply(set('new-set', '30 September 2026'))).toMatchObject({ applied: true, deadlineAtMs: SEP30 });
    expect(getDeadlineDecision(env.db, subjectId)).toMatchObject({ action: 'set', sourceMessageId: 'new-set' });
  });

  it('replaying a superseded set cannot supersede the current reschedule', () => {
    seedMessage('old-set', 'The report is promised by 18 September 2026.', NOW - 2_000);
    seedMessage('new-set', 'The report is promised by 30 September 2026.', NOW - 1_000);
    const old = apply(set('old-set'));
    const current = apply(set('new-set', '30 September 2026'));
    expect(apply(set('old-set')).applied).toBe(false);
    expect(getRevision(env.db, old.revisionId!)).toMatchObject({ state: 'superseded', explicitDeadlineAtMs: null });
    expect(getRevision(env.db, current.revisionId!)).toMatchObject({ state: 'current', explicitDeadlineAtMs: SEP30 });
    expect(validateRevisionEvidence(env.db, current.revisionId!, NOW)).toBe(true);
  });

  it('ignores delayed older sets and clears, using source IDs only to break equal creation-time ties', () => {
    seedMessage('m-001', 'The report is promised by 18 September 2026.', NOW - 1_000);
    seedMessage('m-002', 'The report is promised by 30 September 2026.', NOW - 1_000);
    seedMessage('old-clear', 'The report deadline is cancelled.', NOW - 2_000);
    const current = apply(set('m-002', '30 September 2026'));
    expect(apply(set('m-001')).applied).toBe(false);
    expect(apply(clear('old-clear')).applied).toBe(false);
    expect(getRevision(env.db, current.revisionId!)).toMatchObject({ state: 'current', explicitDeadlineAtMs: SEP30 });
  });

  it.each(['set', 'clear'] as const)('a newer %s invalidates claimed but unsent old authority while keeping its claim', (action) => {
    seedMessage('old-set', 'The report is promised by 18 September 2026.');
    const old = apply(set('old-set'));
    claim(old.revisionId!);
    seedMessage('new-source', action === 'set'
      ? 'The report is promised by 30 September 2026.'
      : 'The report deadline is cancelled.', NOW - 1_000);
    expect(apply(action === 'set' ? set('new-source', '30 September 2026') : clear('new-source')).applied).toBe(true);
    expect(getRevision(env.db, old.revisionId!)).toMatchObject({ state: 'superseded', explicitDeadlineAtMs: null });
    expect(getClaim(env.db, old.revisionId!)?.proposalId).toBe('p-claim');
    expect(validateRevisionEvidence(env.db, old.revisionId!, NOW)).toBe(false);
  });
});

describe('immutable accepted deadline interpretations', () => {
  it('reuses the captured timezone and parser snapshot after re-extraction', () => {
    seedMessage('source', 'The report is promised by 18 September 2026.');
    const first = apply(set('source'), { timezone: 'Europe/Zagreb' });
    expect(first.deadlineAtMs).toBe(SEP18 - 2 * 3_600_000);
    // Simulate an accepted snapshot written by the preceding parser release.
    env.db.prepare("UPDATE attention_revisions SET deadline_parser_version='deadline-v1' WHERE id=?").run(first.revisionId!);
    env.db.prepare("UPDATE attention_deadline_decisions SET deadline_parser_version='deadline-v1' WHERE subject_id=?").run(subjectId);
    const decision = getDeadlineDecision(env.db, subjectId);
    expect(apply(set('source'), { timezone: 'UTC', now: NOW + 1_000 }))
      .toMatchObject({ applied: true, revisionId: first.revisionId, deadlineAtMs: first.deadlineAtMs });
    expect(getDeadlineDecision(env.db, subjectId)).toEqual(decision);
    expect(getRevision(env.db, first.revisionId!)).toMatchObject({
      deadlineTimezone: 'Europe/Zagreb', deadlineParserVersion: 'deadline-v1', explicitDeadlineAtMs: first.deadlineAtMs,
    });
    expect(DEADLINE_PARSER_VERSION).not.toBe('deadline-v1');
  });

  it('does not accept a timezone-induced proposed instant outside the captured local date', () => {
    seedMessage('source', 'The report is promised by 18 September 2026.');
    const first = apply(set('source'), { timezone: 'Europe/Zagreb' });
    expect(apply({ ...set('source'), proposedAt: '2026-09-18T23:59:59.999Z' }, { timezone: 'UTC' }).applied).toBe(false);
    expect(getRevision(env.db, first.revisionId!)?.explicitDeadlineAtMs).toBe(first.deadlineAtMs);
  });

  it('does not turn an edit or a different selected date in the same source into a new deadline', () => {
    seedMessage('source', 'The report is promised by 18 September 2026.');
    const first = apply(set('source'));
    const decision = getDeadlineDecision(env.db, subjectId);
    env.db.prepare('UPDATE messages SET content=?, edited_at_ms=? WHERE id=?')
      .run('The report is promised by 30 September 2026.', NOW, 'source');
    expect(apply(set('source', '30 September 2026')).applied).toBe(false);
    expect(getDeadlineDecision(env.db, subjectId)).toEqual(decision);
    expect(getRevision(env.db, first.revisionId!)?.explicitDeadlineAtMs).toBe(SEP18);
    expect(validateRevisionEvidence(env.db, first.revisionId!, NOW)).toBe(false);
  });

  it('does not revive the same source after its revision was invalidated', () => {
    seedMessage('source', 'The report is promised by 18 September 2026.');
    const first = apply(set('source'));
    env.db.prepare("UPDATE attention_revisions SET state='invalidated' WHERE id=?").run(first.revisionId!);
    expect(apply(set('source'))).toMatchObject({ applied: false, reason: 'trigger_changed' });
    expect(getRevision(env.db, first.revisionId!)?.state).toBe('invalidated');
  });
});

describe('deadline validation and forgetting', () => {
  it('keeps a valid memory confirmation when the date belongs to a different quoted commitment', () => {
    seedMessage('source', 'The report is promised by 18 September 2026. Customer demo is on 30 September 2026.');
    expect(apply({ ...set('source', '30 September 2026'), quote: 'The report is promised by 18 September 2026' }))
      .toMatchObject({ applied: false, reason: 'deadline_unverified' });
    expect(env.db.prepare('SELECT COUNT(*) n FROM memory_evidence WHERE memory_id=? AND message_id=?').get(memoryId, 'source'))
      .toEqual({ n: 1 });
    expect(listSubjectRevisions(env.db, subjectId)).toHaveLength(0);
  });

  it.each(['Next Friday', 'next  Friday', 'Friday next week'])('rejects shortened %s authority through the real memory policy', (phrase) => {
    seedMessage('source', `The report is promised by ${phrase}.`);
    expect(apply({ ...set('source', 'Friday'), quote: 'Friday' }))
      .toMatchObject({ applied: false, reason: 'deadline_unverified' });
    expect(listSubjectRevisions(env.db, subjectId)).toHaveLength(0);
  });

  it('purges cancellation provenance and blocks unseen historical sets until a later human event', () => {
    seedMessage('unseen-old-set', 'The report is promised by 18 September 2026.', NOW - 20 * DAY);
    seedMessage('cancel', 'The report deadline is cancelled.', NOW - 19 * DAY);
    expect(apply(clear('cancel')).applied).toBe(true);
    forgetMessage(env.db, { messageId: 'cancel', guildId: GUILD, actorUserId: ALICE, nowMs: NOW });
    expect(getDeadlineDecision(env.db, subjectId)).toBeNull();
    expect(getDeadlineForgetCutoff(env.db, subjectId)).toBe(NOW);
    expect(getMessage(env.db, 'cancel')!.content).toBe('');
    expect(apply(set('unseen-old-set')).applied).toBe(false);
    seedMessage('same-instant', 'The report is promised by 30 September 2026.', NOW);
    expect(apply(set('same-instant', '30 September 2026')).applied).toBe(false);
    seedMessage('later', 'The report is promised by 30 September 2026.', NOW + 1);
    expect(apply(set('later', '30 September 2026'), { now: NOW + 1 }).applied).toBe(true);
  });

  it('purges a forgotten accepted snapshot and source evidence while preserving its consumed claim', () => {
    seedMessage('source', 'The report is promised by 18 September 2026.');
    const first = apply(set('source'));
    claim(first.revisionId!);
    forgetMessage(env.db, { messageId: 'source', guildId: GUILD, actorUserId: ALICE, nowMs: NOW });
    expect(getDeadlineDecision(env.db, subjectId)).toBeNull();
    expect(getRevision(env.db, first.revisionId!)).toMatchObject({
      state: 'invalidated', explicitDeadlineAtMs: null, deadlineTimezone: null, deadlineParserVersion: null,
    });
    expect(getClaim(env.db, first.revisionId!)?.proposalId).toBe('p-claim');
    expect(env.db.prepare('SELECT COUNT(*) n FROM attention_revision_evidence WHERE message_id=?').get('source')).toEqual({ n: 0 });
  });
});
