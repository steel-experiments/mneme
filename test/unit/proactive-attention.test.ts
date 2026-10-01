import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';
import {
  createMemory,
  confirmMemory,
  supersedeMemory,
  updateMemory,
  type MemoryEvidenceInput,
} from '../../src/memory/repository.js';
import { fingerprintExposedMemory } from '../../src/agent/run-context.js';
import {
  DEFAULT_ATTENTION_WINDOW_MS,
  deadlineWindow,
  evaluateRevisionAdmission,
  effectiveWindowUntilMs,
  findQuoteOffset,
  humanEventWindow,
  isNewerThanFrontier,
  revisionKey,
  windowContains,
} from '../../src/memory/attention.js';
import {
  claimRevision,
  ensureSubjectForMember,
  findConsumedTriggerMessageIds,
  getClaim,
  getSubjectConsumedFrontier,
  getRevision,
  purgeAttentionForMessage,
  registerLegacyConsumedRevision,
  registerRevision,
  selectEligibleRevisions,
  selectRegistrationCandidates,
  expireClosedAttentionRevisions,
  setRevisionDeadline,
  validateTriggerEvidence,
  validateRevisionEvidence,
} from '../../src/memory/attention-repository.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const CHANNEL = '100000000000000002';
const MNEME = '100000000000000099';
const NOW = 1_700_000_000_000;
const WINDOW = DEFAULT_ATTENTION_WINDOW_MS;

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };

let env: TestDb;

function addMessage(id: string, content: string, at = NOW, authorId: string | null = USER): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: CHANNEL,
    authorId,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: at,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: at,
    updatedAtMs: at,
  });
}

function ev(id: string): MemoryEvidenceInput {
  return { messageId: id, stance: 'origin' };
}

/** Claims reference real proposal rows; seed one with its agent run. */
function seedProposal(proposalId: string): void {
  env.db.prepare(
    `INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
     VALUES (?, ?, 'episode', 'p', 'faux', 'faux', 'completed', ?)`,
  ).run(`run-${proposalId}`, GUILD, NOW);
  env.db.prepare(
    `INSERT INTO proposals (id,run_id,target_channel_id,status,computed_score,reason,evidence_message_ids_json,created_at_ms,updated_at_ms)
     VALUES (?, ?, ?, 'pending_review', 1, 'r', '[]', ?, ?)`,
  ).run(proposalId, `run-${proposalId}`, CHANNEL, NOW, NOW);
}

function makeMemory(statement: string, evidence: MemoryEvidenceInput[]): string {
  return createMemory(env.db, ORG_GRANT, {
    guildId: GUILD,
    type: 'decision',
    statement,
    confidence: 0.7,
    importance: 0.5,
    evidence,
    now: NOW,
  });
}


/** Narrow an admission to its rejection reason. */
function rejectionOf(result: ReturnType<typeof evaluateRevisionAdmission>): string {
  expect(result.eligible).toBe(false);
  if (!result.eligible) return result.reason;
  throw new Error('expected an ineligible admission');
}

/** Seed a bot user so bot-authorship can be exercised exactly. */
function seedBot(botId: string): void {
  env.db.prepare(
    'INSERT INTO users (id, username, is_bot, first_seen_at_ms, last_seen_at_ms) VALUES (?, ?, 1, ?, ?)',
  ).run(botId, 'robot', NOW, NOW);
}

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  env.db.prepare("UPDATE channels SET visibility_class = 'org' WHERE id = ?").run(CHANNEL);
  addMessage('e-1', 'we decided to ship the billing rewrite in March');
});

afterEach(() => {
  env.cleanup();
});

describe('pure attention windows — Section 12.7', () => {
  it('opens the ordinary window for exactly seven elapsed days and no longer', () => {
    expect(windowContains(humanEventWindow(NOW - WINDOW, WINDOW), NOW)).toBe(true);
    expect(windowContains(humanEventWindow(NOW - WINDOW - 1, WINDOW), NOW)).toBe(false);
  });

  it('derives a stable revision key from human event identities only', () => {
    expect(revisionKey(['b', 'a'])).toBe(revisionKey(['a', 'b', 'a']));
    expect(revisionKey(['a'])).not.toBe(revisionKey(['b']));
    expect(revisionKey(['a'])).not.toBe(revisionKey(['a', 'b']));
  });

  it('orders human events by source time with the message id as tie-break', () => {
    expect(isNewerThanFrontier({ createdAtMs: 20, messageId: 'm2' }, null)).toBe(true);
    expect(isNewerThanFrontier({ createdAtMs: 20, messageId: 'm2' }, { createdAtMs: 10, messageId: 'm9' })).toBe(true);
    expect(isNewerThanFrontier({ createdAtMs: 10, messageId: 'm1' }, { createdAtMs: 10, messageId: 'm2' })).toBe(false);
    expect(isNewerThanFrontier({ createdAtMs: 10, messageId: 'm3' }, { createdAtMs: 10, messageId: 'm2' })).toBe(true);
    expect(isNewerThanFrontier({ createdAtMs: 5, messageId: 'm9' }, { createdAtMs: 10, messageId: 'm1' })).toBe(false);
  });

  it('accepts only verbatim quotes with exact offsets', () => {
    expect(findQuoteOffset('the gateway cutover is scheduled', 'gateway cutover')).toEqual({ start: 4, end: 19 });
    expect(findQuoteOffset('the gateway cutover is scheduled', 'the gateway cutover is scheduled')).toEqual({ start: 0, end: 32 });
    expect(findQuoteOffset('the gateway cutover is scheduled', 'gateway migration')).toBeNull();
    expect(findQuoteOffset('  padded  ', 'padded')).toEqual({ start: 2, end: 8 });
    expect(findQuoteOffset('anything', '   ')).toBeNull();
  });

  it('admits an unconsumed current revision inside its window', () => {
    const revision = {
      revisionId: 'r1',
      subjectId: 's1',
      state: 'current' as const,
      humanEventAtMs: NOW - 1000,
      explicitDeadlineAtMs: null,
    };
    expect(evaluateRevisionAdmission(revision, null, NOW, WINDOW)).toEqual({
      eligible: true,
      basis: 'new_human_evidence',
      window: humanEventWindow(NOW - 1000, WINDOW),
    });
  });

  it('never re-admits a consumed revision regardless of window state', () => {
    const revision = {
      revisionId: 'r1',
      subjectId: 's1',
      state: 'current' as const,
      humanEventAtMs: NOW - 1000,
      explicitDeadlineAtMs: null,
    };
    const claim = {
      revisionId: 'r1',
      proposalId: 'p1',
      consumedAtMs: NOW - 500,
      eligibleFromMs: NOW - 1000,
      eligibleUntilMs: NOW + WINDOW,
    };
    expect(rejectionOf(evaluateRevisionAdmission(revision, claim, NOW, WINDOW))).toBe('revision_consumed');
  });

  it('rejects legacy, superseded, and invalidated revisions with distinct reasons', () => {
    const base = { revisionId: 'r1', subjectId: 's1', humanEventAtMs: NOW - 1000, explicitDeadlineAtMs: null };
    expect(rejectionOf(evaluateRevisionAdmission({ ...base, state: 'legacy_consumed' as const }, null, NOW, WINDOW))).toBe('legacy_authority');
    expect(rejectionOf(evaluateRevisionAdmission({ ...base, state: 'superseded' as const }, null, NOW, WINDOW))).toBe('trigger_changed');
    expect(rejectionOf(evaluateRevisionAdmission({ ...base, state: 'invalidated' as const }, null, NOW, WINDOW))).toBe('trigger_changed');
  });

  it('fails closed on future source timestamps and closed windows', () => {
    const future = {
      revisionId: 'r1',
      subjectId: 's1',
      state: 'current' as const,
      humanEventAtMs: NOW + 5000,
      explicitDeadlineAtMs: null,
    };
    expect(rejectionOf(evaluateRevisionAdmission(future, null, NOW, WINDOW))).toBe('no_recent_human_trigger');
    const closed = {
      revisionId: 'r2',
      subjectId: 's1',
      state: 'current' as const,
      humanEventAtMs: NOW - WINDOW - 1,
      explicitDeadlineAtMs: null,
    };
    expect(rejectionOf(evaluateRevisionAdmission(closed, null, NOW, WINDOW))).toBe('attention_window_expired');
  });

  it('admits a due explicit deadline once inside its window and not before or after', () => {
    const revision = {
      revisionId: 'r1',
      subjectId: 's1',
      state: 'current' as const,
      humanEventAtMs: NOW - WINDOW - 10_000,
      explicitDeadlineAtMs: NOW,
    };
    expect(rejectionOf(evaluateRevisionAdmission(revision, null, NOW - 1, WINDOW))).toBe('deadline_not_yet_due');
    expect(evaluateRevisionAdmission(revision, null, NOW, WINDOW)).toEqual({
      eligible: true,
      basis: 'human_deadline',
      window: deadlineWindow(NOW, WINDOW),
    });
    expect(rejectionOf(evaluateRevisionAdmission(revision, null, NOW + WINDOW + 1, WINDOW))).toBe('attention_window_expired');
    expect(effectiveWindowUntilMs(revision, WINDOW)).toBe(NOW + WINDOW);
  });
});

describe('trigger evidence validation', () => {
  it('accepts recent human messages with verbatim quotes', () => {
    addMessage('t-1', 'the gateway cutover moved to Friday', NOW - 60_000);
    const result = validateTriggerEvidence(env.db, {
      guildId: GUILD,
      mnemeId: MNEME,
      evidence: [{ messageId: 't-1', quote: 'moved to Friday' }],
      now: NOW,
      windowMs: WINDOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records[0]!.quoteStart).toBe(20);
      expect(result.humanEventAtMs).toBe(NOW - 60_000);
    }
  });

  it('rejects missing, deleted, and foreign-guild sources as changed triggers', () => {
    addMessage('t-del', 'deleted source', NOW - 60_000);
    env.db.prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?').run(NOW, 't-del');
    for (const messageId of ['t-missing', 't-del']) {
      const result = validateTriggerEvidence(env.db, {
        guildId: GUILD,
        mnemeId: MNEME,
        evidence: [{ messageId, quote: 'x' }],
        now: NOW,
        windowMs: WINDOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('trigger_changed');
    }
  });

  it('rejects bot authors, Mneme authors, and missing authors', () => {
    seedBot(MNEME);
    seedBot('100000000000000077');
    addMessage('t-cass', 'mneme note', NOW - 60_000, MNEME);
    addMessage('t-bot', 'other bot note', NOW - 60_000, '100000000000000077');
    addMessage('t-unknown', 'no author row', NOW - 60_000, null);
    for (const messageId of ['t-cass', 't-bot', 't-unknown']) {
      const result = validateTriggerEvidence(env.db, {
        guildId: GUILD,
        mnemeId: MNEME,
        evidence: [{ messageId, quote: 'note' }],
        now: NOW,
        windowMs: WINDOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('no_recent_human_trigger');
    }
  });

  it('rejects future timestamps and sources outside the attention window by creation time', () => {
    addMessage('t-edge', 'exactly seven days old', NOW - WINDOW);
    const edge = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-edge', quote: 'seven days old' }],
      now: NOW, windowMs: WINDOW,
    });
    expect(edge.ok).toBe(true);
    addMessage('t-future', 'from the future', NOW + 5000);
    addMessage('t-old', 'from march', NOW - WINDOW - 1);
    for (const messageId of ['t-future', 't-old']) {
      const result = validateTriggerEvidence(env.db, {
        guildId: GUILD,
        mnemeId: MNEME,
        evidence: [{ messageId, quote: 'from' }],
        now: NOW,
        windowMs: WINDOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('no_recent_human_trigger');
    }
  });

  it('rejects paraphrased quotes as changed triggers', () => {
    addMessage('t-quote', 'exact body text', NOW - 60_000);
    const result = validateTriggerEvidence(env.db, {
      guildId: GUILD,
      mnemeId: MNEME,
      evidence: [{ messageId: 't-quote', quote: 'body text roughly' }],
      now: NOW,
      windowMs: WINDOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('trigger_changed');
  });

  it('rejects evidence in a non-retrievable channel', () => {
    addMessage('t-gone', 'channel gone', NOW - 60_000);
    env.db.prepare('UPDATE channels SET ingest_enabled = 0 WHERE id = ?').run(CHANNEL);
    const result = validateTriggerEvidence(env.db, {
      guildId: GUILD,
      mnemeId: MNEME,
      evidence: [{ messageId: 't-gone', quote: 'channel gone' }],
      now: NOW,
      windowMs: WINDOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('trigger_changed');
  });
});

describe('subjects, revisions, and consumption', () => {
  it('creates one subject per memory and inherits it across supersession', () => {
    const memA = makeMemory('Use the old gateway.', [ev('e-1')]);
    const subjectA = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memA, now: NOW });
    expect(ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memA, now: NOW })).toBe(subjectA);

    const memB = supersedeMemory(env.db, ORG_GRANT, {
      existingMemoryId: memA,
      guildId: GUILD,
      type: 'decision',
      statement: 'Use the new gateway.',
      confidence: 0.8,
      importance: 0.6,
      evidence: [ev('e-1')],
      now: NOW + 1,
    });
    expect(ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memB, now: NOW + 1 })).toBe(subjectA);
  });

  it('registers revisions idempotently over identical evidence', () => {
    const memory = makeMemory('Ship the rewrite.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    addMessage('t-a', 'we changed the plan', NOW - 1000);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-a', quote: 'changed the plan' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const first = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    const second = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW + 1 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.revisionId).toBe(first.revisionId);
    const revision = getRevision(env.db, first.revisionId);
    expect(revision?.state).toBe('current');
    expect(revision?.humanEventAtMs).toBe(NOW - 1000);
  });

  it('grants exactly one claim per revision', () => {
    const memory = makeMemory('Ship the rewrite.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    addMessage('t-a', 'we changed the plan', NOW - 1000);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-a', quote: 'changed the plan' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    seedProposal('prop-1');
    expect(claimRevision(env.db, {
      revisionId, proposalId: 'prop-1', consumedAtMs: NOW,
      eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW - 1000 + WINDOW,
    })).toBe(true);
    seedProposal('prop-2');
    expect(claimRevision(env.db, {
      revisionId, proposalId: 'prop-2', consumedAtMs: NOW + 1,
      eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW - 1000 + WINDOW,
    })).toBe(false);
    expect(getClaim(env.db, revisionId)?.proposalId).toBe('prop-1');
  });

  it('reproduced regression: identical-evidence confirmation cannot reset consumption', () => {
    const memory = makeMemory('Ship the rewrite.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    addMessage('t-a', 'we changed the plan', NOW - 1000);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-a', quote: 'changed the plan' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    seedProposal('prop-1');
    claimRevision(env.db, {
      revisionId, proposalId: 'prop-1', consumedAtMs: NOW,
      eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW - 1000 + WINDOW,
    });

    const before = fingerprintExposedMemory(env.db, memory);
    // Confirmation of the identical evidence one second later: the security
    // fingerprint changes, but consumption must not.
    confirmMemory(env.db, ORG_GRANT, {
      memoryId: memory,
      evidence: [{ messageId: 'e-1', stance: 'supports' }],
      now: NOW + 1000,
    });
    const after = fingerprintExposedMemory(env.db, memory);
    expect(after).not.toBe(before);

    const revision = getRevision(env.db, revisionId)!;
    const claim = getClaim(env.db, revisionId);
    expect(rejectionOf(evaluateRevisionAdmission(
      {
        revisionId: revision.id,
        subjectId: revision.subjectId,
        state: revision.state,
        humanEventAtMs: revision.humanEventAtMs,
        explicitDeadlineAtMs: revision.explicitDeadlineAtMs,
      },
      claim,
      NOW + 1000,
      WINDOW,
    ))).toBe('revision_consumed');
  });

  it('reproduced regression: a fresh reviewAt cannot grant recent attention to old evidence', () => {
    const marchEvidence = NOW - 180 * 24 * 60 * 60 * 1000;
    addMessage('e-march', 'we planned the migration in march', marchEvidence);
    const memory = makeMemory('Migration happens in Q1.', [ev('e-march')]);
    ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });

    // The model pushes the review date to September; the old evidence stays old.
    updateMemory(env.db, ORG_GRANT, {
      memoryId: memory,
      evidence: [],
      reviewAfterMs: NOW - 1000,
      now: NOW + 1,
    });
    expect(env.db.prepare('SELECT review_after_ms FROM memories WHERE id = ?').get(memory))
      .toEqual({ review_after_ms: NOW - 1000 });

    const trigger = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 'e-march', quote: 'planned the migration' }],
      now: NOW + 1, windowMs: WINDOW,
    });
    expect(trigger.ok).toBe(false);
    if (!trigger.ok) expect(trigger.reason).toBe('no_recent_human_trigger');
    expect(selectEligibleRevisions(env.db, { now: NOW + 1, windowMs: WINDOW, limit: 10 })).toEqual([]);
    expect(selectRegistrationCandidates(env.db, { guildId: GUILD, now: NOW + 1, windowMs: WINDOW, limit: 10 })).toEqual([]);
  });
});

describe('second conservative consumption check', () => {
  it('rechecks pre-registered aliases inside the claim and permits a genuinely newer event', () => {
    const memory = makeMemory('Capacity canary plan.', [ev('e-1')]);
    const alias = makeMemory('Another record of the canary plan.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    const aliasId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: alias, now: NOW });
    addMessage('shared-event', 'We changed the canary.', NOW - 2000);
    addMessage('newer-event', 'We corrected the canary configuration.', NOW - 1000);
    const records = (id: string, quote: string) => {
      const validated = validateTriggerEvidence(env.db, {
        guildId: GUILD, mnemeId: MNEME, evidence: [{ messageId: id, quote }], now: NOW, windowMs: WINDOW,
      });
      if (!validated.ok) throw new Error('expected valid evidence');
      return validated.records;
    };
    const shared = records('shared-event', 'We changed the canary.');
    const original = registerRevision(env.db, { subjectId, triggers: shared, now: NOW }).revisionId;
    const duplicate = registerRevision(env.db, { subjectId: aliasId, triggers: shared, now: NOW }).revisionId;
    const correction = registerRevision(env.db, {
      subjectId, triggers: records('newer-event', 'We corrected the canary configuration.'), now: NOW,
    }).revisionId;
    const claim = (revisionId: string, proposalId: string) => {
      seedProposal(proposalId);
      return claimRevision(env.db, { revisionId, proposalId, consumedAtMs: NOW,
        eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW + WINDOW - 1000 });
    };
    expect(claim(original, 'original-card')).toBe(true);
    expect(claim(duplicate, 'duplicate-card')).toBe(false);
    // The correction predates proposal creation but follows the human event.
    expect(claim(correction, 'correction-card')).toBe(true);
    expect(getClaim(env.db, duplicate)).toBeNull();
  });

  it('blocks an older pre-registered subject revision after a newer event is consumed', () => {
    const memory = makeMemory('Canary plan.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    const ids = ['first-event', 'correction-event'].map((id, index) => {
      addMessage(id, `Human event ${index}`, NOW - 2000 + index * 1000);
      const validated = validateTriggerEvidence(env.db, {
        guildId: GUILD, mnemeId: MNEME, evidence: [{ messageId: id, quote: `Human event ${index}` }],
        now: NOW, windowMs: WINDOW,
      });
      if (!validated.ok) throw new Error('expected valid evidence');
      return registerRevision(env.db, { subjectId, triggers: validated.records, now: NOW }).revisionId;
    });
    seedProposal('newer-first');
    seedProposal('older-later');
    const window = { consumedAtMs: NOW, eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW + WINDOW - 1000 };
    expect(claimRevision(env.db, { ...window, revisionId: ids[1]!, proposalId: 'newer-first' })).toBe(true);
    expect(claimRevision(env.db, { ...window, revisionId: ids[0]!, proposalId: 'older-later' })).toBe(false);
  });

  it('fails closed after one source of a multi-message revision is forgotten', () => {
    const memory = makeMemory('Canary plan.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    addMessage('second-trigger', 'We moved the canary.', NOW - 1000);
    const validated = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 'e-1', quote: 'we decided' }, { messageId: 'second-trigger', quote: 'We moved the canary.' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!validated.ok) throw new Error('expected valid evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: validated.records, now: NOW });
    expect(validateRevisionEvidence(env.db, revisionId, NOW)).toBe(true);
    purgeAttentionForMessage(env.db, 'second-trigger');
    expect(validateRevisionEvidence(env.db, revisionId, NOW)).toBe(false);
    expect(selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 })).toEqual([]);
  });

  function consumedSetup(): string {
    const memory = makeMemory('Capacity canary plan.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    addMessage('t-a', 'canary at ten percent', NOW - 2000);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-a', quote: 'canary at ten percent' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    seedProposal('prop-1');
    claimRevision(env.db, {
      revisionId, proposalId: 'prop-1', consumedAtMs: NOW,
      eligibleFromMs: NOW - 2000, eligibleUntilMs: NOW - 2000 + WINDOW,
    });
    return subjectId;
  }

  it('marks consumed trigger messages as covered across subjects in the guild', () => {
    consumedSetup();
    expect(findConsumedTriggerMessageIds(env.db, GUILD, ['t-a', 't-other']))
      .toEqual(new Set(['t-a']));
  });

  it('keeps the consumed frontier at source-event time with id tie-break', () => {
    const subjectId = consumedSetup();
    const frontier = getSubjectConsumedFrontier(env.db, subjectId);
    expect(frontier).toEqual({ createdAtMs: NOW - 2000, messageId: 't-a' });
    // A correction at 10:30 is newer than the consumed 10:00 event even though
    // the card was persisted later: proposal time is never the comparison.
    expect(isNewerThanFrontier({ createdAtMs: NOW - 1000, messageId: 't-b' }, frontier)).toBe(true);
    // Replaying the covered event is not a new development.
    expect(isNewerThanFrontier({ createdAtMs: NOW - 2000, messageId: 't-a' }, frontier)).toBe(false);
  });

  it('treats legacy-consumed evidence as covered', () => {
    const memory = makeMemory('Old promise.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    registerLegacyConsumedRevision(env.db, {
      subjectId,
      triggerMessageIds: ['e-1'],
      consumedAtMs: NOW,
      now: NOW,
    });
    expect(findConsumedTriggerMessageIds(env.db, GUILD, ['e-1'])).toEqual(new Set(['e-1']));
    // Idempotent on the same natural key.
    registerLegacyConsumedRevision(env.db, {
      subjectId,
      triggerMessageIds: ['e-1'],
      consumedAtMs: NOW,
      now: NOW + 1,
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_revisions').get())
      .toEqual({ n: 1 });
  });
});

describe('selection and expiry', () => {
  it('selects eligible unconsumed revisions independent of review_after_ms', () => {
    const memory = makeMemory('Ship the rewrite.', [ev('e-1')]);
    // No review_after_ms at all: attention is the admission authority.
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    addMessage('t-a', 'we changed the plan', NOW - 1000);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-a', quote: 'changed the plan' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });

    const [candidate] = selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 });
    expect(candidate?.revisionId).toBe(revisionId);
    expect(candidate?.memoryId).toBe(memory);
    expect(candidate?.basis).toBe('new_human_evidence');

    seedProposal('prop-1');
    claimRevision(env.db, {
      revisionId, proposalId: 'prop-1', consumedAtMs: NOW,
      eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW - 1000 + WINDOW,
    });
    expect(selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 })).toEqual([]);
  });

  it('selects a due deadline revision on the deadline basis only', () => {
    const memory = makeMemory('Promised a report.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    const staleEvent = NOW - WINDOW - 5000;
    addMessage('t-old', 'we promised a report', staleEvent);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-old', quote: 'promised a report' }],
      now: staleEvent + 1000, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    setRevisionDeadline(env.db, {
      revisionId,
      deadlineAtMs: NOW + 1000,
      timezone: 'UTC',
      parserVersion: 'deadline-v1',
      evidence: records.records[0]!,
    });

    expect(selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 })).toEqual([]);
    const [due] = selectEligibleRevisions(env.db, { now: NOW + 1000, windowMs: WINDOW, limit: 10 });
    expect(due?.basis).toBe('human_deadline');
    expect(due?.windowFromMs).toBe(NOW + 1000);
  });

  it('expires only unconsumed revisions whose supported windows all closed', () => {
    const memory = makeMemory('Ship the rewrite.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    const oldEvent = NOW - WINDOW - 5000;
    addMessage('t-old', 'we changed the plan', oldEvent);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-old', quote: 'changed the plan' }],
      now: oldEvent + 1000, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });

    const later = NOW + 1;
    const result = expireClosedAttentionRevisions(env.db, {
      now: later, windowMs: WINDOW, guildId: GUILD, actorUserId: MNEME,
    });
    expect(result.expiredRevisionIds).toEqual([revisionId]);
    expect(getRevision(env.db, revisionId)?.state).toBe('invalidated');
    // Silence retires the opportunity, never the durable memory.
    expect(env.db.prepare('SELECT status FROM memories WHERE id = ?').get(memory))
      .toEqual({ status: 'active' });
    const events = env.db
      .prepare("SELECT action FROM admin_events WHERE action = 'attention_window_expire'")
      .all();
    expect(events).toHaveLength(1);
    // Idempotent: a second sweep changes nothing.
    expect(expireClosedAttentionRevisions(env.db, {
      now: later + 1, windowMs: WINDOW, guildId: GUILD, actorUserId: MNEME,
    }).expiredRevisionIds).toEqual([]);
  });

  it('keeps an unconsumed revision alive while its verified deadline is in the future', () => {
    const memory = makeMemory('Promised a report.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    const oldEvent = NOW - WINDOW - 5000;
    addMessage('t-old', 'we promised a report', oldEvent);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-old', quote: 'promised a report' }],
      now: oldEvent + 1000, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    setRevisionDeadline(env.db, {
      revisionId,
      deadlineAtMs: NOW + WINDOW,
      timezone: 'UTC',
      parserVersion: 'deadline-v1',
      evidence: records.records[0]!,
    });

    expect(expireClosedAttentionRevisions(env.db, {
      now: NOW + 1, windowMs: WINDOW, guildId: GUILD, actorUserId: MNEME,
    }).expiredRevisionIds).toEqual([]);
    expect(getRevision(env.db, revisionId)?.state).toBe('current');
  });
});

describe('forgetting', () => {
  it('purges evidence for a forgotten message and invalidates orphan revisions', () => {
    const memory = makeMemory('Ship the rewrite.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    addMessage('t-a', 'we changed the plan', NOW - 1000);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-a', quote: 'changed the plan' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });

    purgeAttentionForMessage(env.db, 't-a');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_revision_evidence').get())
      .toEqual({ n: 0 });
    // The orphan revision can no longer authorize speech.
    expect(getRevision(env.db, revisionId)?.state).toBe('invalidated');
    // The subject and its member memory survive: forgetting a source never
    // deletes the memory or the subject identity.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_subjects').get()).toEqual({ n: 1 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_subject_members').get()).toEqual({ n: 1 });
  });

  it('keeps a consumed claim when its trigger evidence is forgotten', () => {
    const memory = makeMemory('Ship the rewrite.', [ev('e-1')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: memory, now: NOW });
    addMessage('t-a', 'we changed the plan', NOW - 1000);
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: MNEME,
      evidence: [{ messageId: 't-a', quote: 'changed the plan' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    seedProposal('prop-1');
    claimRevision(env.db, {
      revisionId, proposalId: 'prop-1', consumedAtMs: NOW,
      eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW - 1000 + WINDOW,
    });

    purgeAttentionForMessage(env.db, 't-a');
    expect(getClaim(env.db, revisionId)).not.toBeNull();
    const row = getRevision(env.db, revisionId)!;
    const verdict = evaluateRevisionAdmission(
      {
        revisionId: row.id,
        subjectId: row.subjectId,
        state: row.state,
        humanEventAtMs: row.humanEventAtMs,
        explicitDeadlineAtMs: row.explicitDeadlineAtMs,
      },
      getClaim(env.db, revisionId),
      NOW + 1,
      WINDOW,
    );
    expect(verdict.eligible).toBe(false);
    if (!verdict.eligible) expect(verdict.reason).toBe('revision_consumed');
  });
});
