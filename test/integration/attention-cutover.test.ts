import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';
import { createMemory, type MemoryEvidenceInput } from '../../src/memory/repository.js';
import {
  claimRevision,
  ensureSubjectForMember,
  findConsumedTriggerMessageIds,
  getRevision,
  registerRevision,
  selectEligibleRevisions,
  validateTriggerEvidence,
} from '../../src/memory/attention-repository.js';
import { runAttentionCutover, ATTENTION_CUTOVER_VERSION } from '../../src/memory/attention-cutover.js';
import { forgetMessage } from '../../src/memory/deletion.js';
import type { AgentRunResult } from '../../src/agent/runtime.js';
import { DEFAULT_ATTENTION_WINDOW_MS } from '../../src/memory/attention.js';

const GUILD = '100000000000000001';
const ALICE = '100000000000000003';
const CHANNEL = '100000000000000002';
const NOW = 1_700_000_001_000;
const WINDOW = DEFAULT_ATTENTION_WINDOW_MS;

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };

let env: TestDb;

// Fixture messages predate the review by half an hour, so the Section 11.8
// settle gate sees a conversation that already ended.
const SETTLED_AT = NOW - 30 * 60_000;

function addMessage(id: string, content: string, at = SETTLED_AT): string {
  upsertMessageCreate(env.db, {
    id, guildId: GUILD, channelId: CHANNEL, authorId: ALICE, authorDisplayName: 'Alice', content,
    createdAtMs: at, editedAtMs: null, replyToMessageId: null, messageType: 0, flags: 0,
    pinned: false, mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]',
    componentsJson: '[]', pollJson: null, rawJson: null, ingestedAtMs: at, updatedAtMs: at,
  });
  return id;
}

function ev(id: string): MemoryEvidenceInput {
  return { messageId: id, stance: 'origin' };
}

function makeMemory(statement: string, evidence: MemoryEvidenceInput[]): string {
  return createMemory(env.db, ORG_GRANT, {
    guildId: GUILD, type: 'decision', statement, confidence: 0.7, importance: 0.5,
    evidence, now: NOW,
  });
}

function seedRunAndProposal(
  proposalId: string,
  runType: 'episode' | 'scheduled_review',
  status: string,
  evidenceIds: string[],
): void {
  env.db.prepare(
    `INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
     VALUES (?, ?, ?, 'p', 'faux', 'faux', 'completed', ?)`,
  ).run(`run-${proposalId}`, GUILD, runType, NOW);
  env.db.prepare(
    `INSERT INTO proposals (id,run_id,target_channel_id,status,computed_score,reason,evidence_message_ids_json,created_at_ms,updated_at_ms)
     VALUES (?, ?, ?, ?, 1, 'legacy', ?, ?, ?)`,
  ).run(proposalId, `run-${proposalId}`, CHANNEL, status, JSON.stringify(evidenceIds), NOW, NOW);
}

function seedOutbox(outboxId: string, proposalId: string, status: string): void {
  env.db.prepare(
    `INSERT INTO outbox (id, proposal_id, channel_id, content, dedupe_key, status, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 'text', ?, ?, 0, ?, ?, ?)`,
  ).run(outboxId, proposalId, CHANNEL, `outbox-${outboxId}`, status, NOW, NOW, NOW);
}

function runCutover() {
  return runAttentionCutover(env.db, {
    now: NOW, guildId: GUILD, actorUserId: '100000000000000099', attentionWindowMs: WINDOW,
  });
}

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  env.db.prepare("UPDATE channels SET visibility_class = 'org', allow_interventions = 1 WHERE id = ?").run(CHANNEL);
});

afterEach(() => env.cleanup());

describe('attention cutover — Section 12.7', () => {
  it.each([500, 501])('baselines all %i legacy proposals across batch boundaries', (count) => {
    const messageIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const suffix = String(i).padStart(4, '0');
      const messageId = addMessage(`legacy-message-${suffix}`, `The team changed item ${i}.`);
      messageIds.push(messageId);
      seedRunAndProposal(`legacy-${suffix}`, 'episode', 'dismissed', [messageId]);
    }
    const report = runCutover();
    expect(report.legacyProposalsBaselined).toBe(count);
    expect(findConsumedTriggerMessageIds(env.db, GUILD, messageIds)).toEqual(new Set(messageIds));
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_revisions').get()).toEqual({ n: count });
    expect(runCutover().alreadyComplete).toBe(true);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_revisions').get()).toEqual({ n: count });
  });

  it('advances past empty, malformed, and partially covered legacy citations', () => {
    addMessage('shared', 'We agreed on the first milestone.');
    addMessage('uncovered', 'We agreed on the second milestone.');
    seedRunAndProposal('a-empty', 'episode', 'dismissed', []);
    seedRunAndProposal('b-malformed', 'episode', 'dismissed', []);
    env.db.prepare("UPDATE proposals SET evidence_message_ids_json = 'not json' WHERE id = 'b-malformed'").run();
    seedRunAndProposal('c-covered', 'episode', 'dismissed', ['shared']);
    seedRunAndProposal('d-partial', 'episode', 'dismissed', ['shared', 'uncovered', 'forgotten']);
    expect(runCutover().legacyProposalsBaselined).toBe(2);
    expect(findConsumedTriggerMessageIds(env.db, GUILD, ['shared', 'uncovered']))
      .toEqual(new Set(['shared', 'uncovered']));
  });

  it('repairs a prior cutover without baselining modern owned revisions', () => {
    addMessage('modern', 'We changed the rollout today.');
    const memoryId = makeMemory('Rollout moved.', [ev('modern')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });
    const evidence = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: 'bot', evidence: [{ messageId: 'modern', quote: 'changed the rollout' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!evidence.ok) throw new Error('expected valid evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: evidence.records, now: NOW });
    seedRunAndProposal('modern-proposal', 'episode', 'pending_review', ['modern']);
    expect(claimRevision(env.db, {
      revisionId, proposalId: 'modern-proposal', consumedAtMs: NOW,
      eligibleFromMs: NOW, eligibleUntilMs: NOW + WINDOW,
    })).toBe(true);
    env.db.prepare(`INSERT INTO admin_events (id,workspace_id,actor_user_id,action,details_json,created_at_ms)
      VALUES ('attention_cutover_v1', ?, 'bot', 'attention_cutover_complete', '{}', ?)`)
      .run(GUILD, NOW - 1000);
    addMessage('missed-legacy', 'A previously surfaced legacy event.');
    seedRunAndProposal('missed-proposal', 'episode', 'dismissed', ['missed-legacy']);
    expect(runCutover().legacyProposalsBaselined).toBe(1);
    expect(getRevision(env.db, revisionId)?.state).toBe('current');
    expect(env.db.prepare("SELECT status FROM proposals WHERE id = 'modern-proposal'").get())
      .toEqual({ status: 'pending_review' });
  });

  it('consumes an already registered but unclaimed revision of surfaced legacy evidence', () => {
    addMessage('re-registered', 'The rollout was already discussed.');
    const memoryId = makeMemory('The rollout moved.', [ev('re-registered')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });
    const validation = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: 'bot', evidence: [{ messageId: 're-registered', quote: 'already discussed' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!validation.ok) throw new Error('expected valid evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: validation.records, now: NOW });
    seedRunAndProposal('legacy-before-registration', 'episode', 'dismissed', ['re-registered']);
    expect(runCutover().legacyProposalsBaselined).toBe(1);
    expect(getRevision(env.db, revisionId)?.state).toBe('legacy_consumed');
    expect(findConsumedTriggerMessageIds(env.db, GUILD, ['re-registered'])).toEqual(new Set(['re-registered']));
    expect(selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 })).toEqual([]);
  });

  it('is a no-op on the second run', () => {
    addMessage('m-legacy', 'an old surfaced reminder');
    makeMemory('An old decision.', [ev('m-legacy')]);
    seedRunAndProposal('p-legacy-1', 'scheduled_review', 'sent', ['m-legacy']);

    const first = runCutover();
    expect(first.alreadyComplete).toBe(false);
    expect(first.legacyProposalsBaselined).toBe(1);

    const second = runCutover();
    expect(second).toEqual({
      version: ATTENTION_CUTOVER_VERSION,
      alreadyComplete: true,
      legacyProposalsBaselined: 0,
      pendingProposalsExpired: 0,
      queuedDeliveriesCancelled: 0,
      legacyCohortsCancelled: 0,
      registrationSubjectsMarked: 0,
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_revisions').get()).toEqual({ n: 1 });
  });

  it('baselines surfaced legacy evidence as consumed so it cannot return as fresh', async () => {
    addMessage('m-legacy', 'an old surfaced reminder');
    const memoryId = makeMemory('An old decision.', [ev('m-legacy')]);
    seedRunAndProposal('p-sent', 'scheduled_review', 'sent', ['m-legacy']);

    const report = runCutover();
    expect(report.legacyProposalsBaselined).toBe(1);
    expect(findConsumedTriggerMessageIds(env.db, GUILD, ['m-legacy'])).toEqual(new Set(['m-legacy']));

    // The consumed evidence cannot authorize a new card even under a new subject.
    expect(selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 })).toEqual([]);
    env.db.prepare(
      `INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
       VALUES (?, ?, 'episode', 'p', 'faux', 'faux', 'completed', ?)`,
    ).run(`run-replay-${NOW}`, GUILD, NOW);
    const { routeEpisodeIntervention } = await import('../../src/production-runtime.js');
    const { openEpisode, extendEpisode, closeEpisode, getEpisode } = await import('../../src/episodes/repository.js');
    const { episode } = openEpisode(env.db, { guildId: GUILD, conversationChannelId: CHANNEL, now: NOW });
    extendEpisode(env.db, episode.id, 'm-legacy', true, NOW);
    closeEpisode(env.db, episode.id, NOW);
    const proposalId = await routeEpisodeIntervention({
      db: env.db,
      now: () => NOW,
      config: {
        discord: { guildId: GUILD, applicationId: '100000000000000099' },
        mode: 'review',
        organization: { timezone: 'UTC' },
        episodes: { settleSeconds: 600, settleMaxMinutes: 60 },
        intervention: {
          threshold: 0.6, minConfidence: 0.6, minEvidenceStrength: 0.6,
          maxMessageCharacters: 1_800, channelCooldownMinutes: 180, globalDailyLimit: 5,
          attentionWindowDays: 7,
        },
      },
      logger: { warn: () => undefined, info: () => undefined },
    } as never, {} as never, 'secret', {
      proposal: {
        intervention: {
          recommend: true,
          reason: 'x',
          dimensions: { impact: 1, evidenceStrength: 1, contradictionStrength: 1, urgency: 1, novelty: 1, interruptionCost: 0 },
          confidence: 1,
          urgency: 'normal',
          targetChannelId: CHANNEL,
          evidenceMessageIds: ['m-legacy'],
          message: 'Please reconcile.',
          subject: { kind: 'existing_memory', memoryId },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: 'm-legacy', quote: 'old surfaced reminder' }],
            relation: 'changed_decision',
            materialChange: 'Replay of legacy evidence.',
          },
        },
      },
      result: ({
        runId: `run-replay-${NOW}`,
        provenance: {
          channels: [{ channelId: CHANNEL, source: 'initial_payload' as const }],
          messageIds: ['m-legacy'],
          memoryIds: [memoryId],
          memoryScopes: [],
          messageFingerprints: [],
          memoryFingerprints: [],
          charsExposed: 0,
          charBudget: 60_000,
        },
      } as unknown as AgentRunResult),
      episode: getEpisode(env.db, episode.id)!,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(['m-legacy']),
    });
    const stored = (await import('../../src/db/repositories/proposals.js')).getProposal(env.db, proposalId!);
    expect(stored?.status).toBe('observed');
    expect(stored?.reason).toContain('revision_consumed');
    // The memory and its history survive.
    expect(env.db.prepare('SELECT status FROM memories WHERE id = ?').get(memoryId))
      .toEqual({ status: 'active' });
  });

  it('suppresses ambiguous legacy evidence without declaring it fresh', () => {
    addMessage('m-ambiguous', 'an episode reminder with no resolvable memory');
    seedRunAndProposal('p-episode-1', 'episode', 'dismissed', ['m-ambiguous']);

    const report = runCutover();
    expect(report.legacyProposalsBaselined).toBe(1);
    expect(findConsumedTriggerMessageIds(env.db, GUILD, ['m-ambiguous'])).toEqual(new Set(['m-ambiguous']));
    // No memory was silently merged into a subject.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_subject_members').get()).toEqual({ n: 0 });
  });

  it('expires pending legacy proposals, cancels queued deliveries, and preserves sent rows', () => {
    addMessage('m-pending', 'an old pending reminder');
    makeMemory('An old decision.', [ev('m-pending')]);
    seedRunAndProposal('p-pending', 'scheduled_review', 'pending_review', ['m-pending']);
    seedRunAndProposal('p-approved', 'episode', 'approved', ['m-pending']);
    seedRunAndProposal('p-sent-ok', 'scheduled_review', 'approved', ['m-pending']);
    seedOutbox('ob-queued', 'p-pending', 'queued');
    seedOutbox('ob-sending', 'p-approved', 'sending');
    seedOutbox('ob-sent', 'p-sent-ok', 'sent');

    const report = runCutover();
    expect(report.pendingProposalsExpired).toBe(3);
    expect(report.queuedDeliveriesCancelled).toBe(1);

    expect(env.db.prepare('SELECT status FROM proposals WHERE id = ?').get('p-pending'))
      .toEqual({ status: 'expired' });
    expect(env.db.prepare('SELECT status FROM outbox WHERE id = ?').get('ob-queued'))
      .toEqual({ status: 'cancelled' });
    // Uncertain sending rows stay for marker reconciliation; sent rows persist.
    expect(env.db.prepare('SELECT status FROM outbox WHERE id = ?').get('ob-sending'))
      .toEqual({ status: 'sending' });
    expect(env.db.prepare('SELECT status FROM outbox WHERE id = ?').get('ob-sent'))
      .toEqual({ status: 'sent' });
    // A durable card-status sync job exists for the cancelled card.
    expect(env.db.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE type = 'sync_proposal_review' AND unique_key = ?`,
    ).get('proposal-review-status:p-pending')).toEqual({ n: 1 });
  });

  it('cancels legacy cohort payloads without a mode and keeps new-mode jobs', () => {
    env.db.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, priority, run_after_ms, attempts, max_attempts, created_at_ms, updated_at_ms)
       VALUES ('job-legacy', 'review_due_memory_cohort', ?, 'queued', 100, ?, 0, 10, ?, ?)`,
    ).run(JSON.stringify({ routeKind: 'working', targetChannelId: CHANNEL, subjects: [] }), NOW, NOW, NOW);
    env.db.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, priority, run_after_ms, attempts, max_attempts, created_at_ms, updated_at_ms)
       VALUES ('job-new', 'review_due_memory_cohort', ?, 'queued', 100, ?, 0, 10, ?, ?)`,
    ).run(JSON.stringify({
      routeKind: 'working', targetChannelId: CHANNEL, mode: 'attention_review',
      subjects: [{ memoryId: 'm', memoryFingerprint: 'f', attentionRevisionId: 'r' }],
    }), NOW, NOW, NOW);

    const report = runCutover();
    expect(report.legacyCohortsCancelled).toBe(1);
    expect(env.db.prepare('SELECT status FROM jobs WHERE id = ?').get('job-legacy'))
      .toEqual({ status: 'cancelled' });
    expect(env.db.prepare('SELECT status FROM jobs WHERE id = ?').get('job-new'))
      .toEqual({ status: 'queued' });
  });

  it('marks bounded uncovered in-window subjects for registration, never from reviewAt alone', () => {
    // In-window uncovered human evidence: marked for registration.
    addMessage('m-fresh', 'a fresh human development', NOW - 1000);
    const freshMemory = makeMemory('A fresh development.', [ev('m-fresh')]);
    // Old evidence with a recently moved review date: reviewAt is not a criterion.
    addMessage('m-stale', 'an old development', NOW - 90 * 86_400_000);
    const staleMemory = makeMemory('An old development.', [ev('m-stale')]);
    env.db.prepare('UPDATE memories SET review_after_ms = ? WHERE id = ?').run(NOW, staleMemory);

    const report = runCutover();
    expect(report.registrationSubjectsMarked).toBe(1);
    expect(env.db.prepare(
      'SELECT registration_state FROM attention_subjects s JOIN attention_subject_members m ON m.subject_id = s.id WHERE m.memory_id = ?',
    ).get(freshMemory)).toEqual({ registration_state: 'pending' });
    expect(env.db.prepare(
      'SELECT COUNT(*) AS n FROM attention_subject_members WHERE memory_id = ?',
    ).get(staleMemory)).toEqual({ n: 0 });
    // The cutover itself creates no proposal.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 0 });
  });
});

describe('forgetting purges attention state', () => {
  it('removes evidence for a forgotten source inside the deletion transaction', async () => {
    addMessage('m-base', 'the original decision', NOW - 30 * 86_400_000);
    const memoryId = makeMemory('The original decision.', [ev('m-base')]);
    addMessage('m-trigger', 'the decision changed this week', NOW - 1000);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: '100000000000000099',
      evidence: [{ messageId: 'm-trigger', quote: 'decision changed this week' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    env.db.prepare(
      `INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
       VALUES ('run-claim', ?, 'episode', 'p', 'faux', 'faux', 'completed', ?)`,
    ).run(GUILD, NOW);
    env.db.prepare(
      `INSERT INTO proposals (id,run_id,target_channel_id,status,computed_score,reason,evidence_message_ids_json,created_at_ms,updated_at_ms)
       VALUES ('p-claim', 'run-claim', ?, 'approved', 1, 'r', '[]', ?, ?)`,
    ).run(CHANNEL, NOW, NOW);
    expect(claimRevision(env.db, {
      revisionId, proposalId: 'p-claim', consumedAtMs: NOW,
      eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW - 1000 + WINDOW,
    })).toBe(true);

    const result = await forgetMessage(env.db, {
      messageId: 'm-trigger',
      retainDeletedContent: false,
      nowMs: NOW,
      guildId: GUILD,
      actorUserId: '100000000000000099',
    });
    expect(result).toBeDefined();

    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_revision_evidence').get())
      .toEqual({ n: 0 });
    // The orphan revision is invalidated and the claim stands: the consumed
    // evidence cannot return as fresh through a new subject.
    const revision = getRevision(env.db, revisionId);
    expect(revision?.state).toBe('invalidated');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM proposal_attention_claims').get()).toEqual({ n: 1 });
    expect(findConsumedTriggerMessageIds(env.db, GUILD, ['m-trigger'])).toEqual(new Set());
  });
});
