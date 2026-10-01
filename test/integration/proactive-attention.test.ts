import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';
import { createMemory, type MemoryEvidenceInput } from '../../src/memory/repository.js';
import type { AgentRunResult } from '../../src/agent/runtime.js';
import { getProposal } from '../../src/db/repositories/proposals.js';
import { routeEpisodeIntervention } from '../../src/production-runtime.js';
import type { BootstrapContext } from '../../src/bootstrap.js';
import type { EpisodeRow } from '../../src/episodes/repository.js';
import { getEpisode, openEpisode, extendEpisode, closeEpisode } from '../../src/episodes/repository.js';
import {
  claimRevision,
  ensureSubjectForMember,
  getClaim,
  registerRevision,
  selectEligibleRevisions,
  setRevisionDeadline,
  validateProposalAttention,
  validateTriggerEvidence,
} from '../../src/memory/attention-repository.js';
import { DEFAULT_ATTENTION_WINDOW_MS } from '../../src/memory/attention.js';
import {
  createReviewDueMemoryDispatcherHandler,
} from '../../src/jobs/handlers/review-due-memory-dispatcher.js';
import {
  createReviewDueMemoriesHandler,
  type ReviewScope,
} from '../../src/jobs/handlers/review-due-memories.js';
import type { PromptCompiler } from '../../src/agent/prompts.js';
import { approveProposal, recheckApprovalPolicy } from '../../src/review/workflow.js';
import { buildApprovalRecheck } from '../../src/production-runtime.js';
import { createSendOutboxHandler } from '../../src/outbox/worker.js';
import { enqueueOutbox, claimOutboxForSending, getOutboxByDedupeKey } from '../../src/outbox/repository.js';
import type { OutboxSender } from '../../src/platform/discord/sender.js';

/**
 * End-to-end proactive-attention gating (Section 12.7): episode
 * interventions and scheduled notifications reach a review card or an
 * autonomous send only through an eligible, unconsumed revision.
 */

const GUILD = '100000000000000001';
const ALICE = '100000000000000003';
const CHANNEL = '100000000000000002';
const REVIEW_CHANNEL = '100000000000000009';
const NOW = 1_700_000_001_000;
const WINDOW = DEFAULT_ATTENTION_WINDOW_MS;

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };

let env: TestDb;

function addMessage(id: string, content: string, at = NOW, channelId = CHANNEL, authorId: string | null = ALICE): void {
  upsertMessageCreate(env.db, {
    id, guildId: GUILD, channelId, authorId, authorDisplayName: 'Alice', content,
    createdAtMs: at, editedAtMs: null, replyToMessageId: null, messageType: 0, flags: 0,
    pinned: false, mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]',
    componentsJson: '[]', pollJson: null, rawJson: null, ingestedAtMs: at, updatedAtMs: at,
  });
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

function seedProposalRow(proposalId: string): void {
  env.db.prepare(
    `INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
     VALUES (?, ?, 'episode', 'p', 'faux', 'faux', 'completed', ?)`,
  ).run(`run-${proposalId}`, GUILD, NOW);
  env.db.prepare(
    `INSERT INTO proposals (id,run_id,target_channel_id,status,computed_score,reason,evidence_message_ids_json,created_at_ms,updated_at_ms)
     VALUES (?, ?, ?, 'pending_review', 1, 'r', '[]', ?, ?)`,
  ).run(proposalId, `run-${proposalId}`, CHANNEL, NOW, NOW);
}

function attentionContext(): BootstrapContext {
  return {
    db: env.db,
    now: () => NOW,
    config: {
      workspaceId: GUILD, discord: { applicationId: '100000000000000099' },
      mode: 'review',
      reviewChannelId: REVIEW_CHANNEL,
      organization: { timezone: 'UTC' },
      episodes: { settleSeconds: 600, settleMaxMinutes: 60 },
      memory: { scheduledReviewReminderDays: 7 },
      intervention: {
        threshold: 0.6, minConfidence: 0.6, minEvidenceStrength: 0.6,
        maxMessageCharacters: 1_800, channelCooldownMinutes: 180, globalDailyLimit: 5,
        attentionWindowDays: 7,
      },
    },
    logger: { warn: () => undefined, info: () => undefined },
  } as unknown as BootstrapContext;
}

const dims = {
  impact: 0.9, evidenceStrength: 0.9, contradictionStrength: 0.9,
  urgency: 0.9, novelty: 0.9, interruptionCost: 0,
};

// Fixture conversations end half an hour before the review, so the Section 11.8
// settle gate sees a settled conversation and attention is what is under test.
const SETTLED_AT = NOW - 30 * 60_000;

function episodeWithMessages(messages: Array<{ id: string; content: string }>): EpisodeRow {
  const { episode } = openEpisode(env.db, { guildId: GUILD, conversationChannelId: CHANNEL, now: SETTLED_AT });
  let t = SETTLED_AT;
  for (const message of messages) {
    addMessage(message.id, message.content, t);
    extendEpisode(env.db, episode.id, message.id, true, t);
    t += 1;
  }
  closeEpisode(env.db, episode.id, SETTLED_AT + 60_000);
  return getEpisode(env.db, episode.id)!;
}

function runResultFor(provenanceMessageIds: string[], memoryIds: string[]): AgentRunResult {
  return runResultWithId(`run-${Math.random().toString(36).slice(2, 8)}`, provenanceMessageIds, memoryIds);
}

function runResultWithId(runId: string, provenanceMessageIds: string[], memoryIds: string[]): AgentRunResult {
  env.db.prepare(
    `INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms,retrieval_provenance_json)
     VALUES (?, ?, 'episode', 'p', 'faux', 'faux', 'completed', ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(runId, GUILD, NOW, JSON.stringify({
    channels: [{ channelId: CHANNEL, visibility: 'org' }],
    messageIds: provenanceMessageIds,
    memoryIds,
    memoryScopes: [],
  }));
  return {
    runId,
    outcome: 'finalized',
    endReason: 'finalized',
    failureReason: null,
    finalProposal: { kind: 'episode_review', proposal: {} },
    provenance: {
      channels: [{ channelId: CHANNEL, visibility: 'org' }],
      messageIds: provenanceMessageIds,
      memoryIds,
      memoryScopes: [],
      charsExposed: 0,
      charBudget: 60_000,
    },
    usage: {},
  } as unknown as AgentRunResult;
}

/** Fake scheduled-review run: persists the agent_runs row the proposal FK needs. */
function scheduledRunResult(runId: string, memoryId: string, notification: Record<string, unknown>, messageIds: string[] = ['m-new']): AgentRunResult {
  env.db.prepare(
    `INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
     VALUES (?, ?, 'scheduled_review', 'p', 'faux', 'faux', 'completed', ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(runId, GUILD, NOW);
  return {
    runId,
    outcome: 'finalized',
    endReason: 'finalized',
    failureReason: null,
    finalProposal: {
      kind: 'scheduled_review',
      proposal: { memoryProposals: [], notification },
    },
    provenance: {
      channels: [{ channelId: CHANNEL, visibility: 'org' }],
      messageIds,
      memoryIds: [memoryId],
      memoryScopes: [],
      charsExposed: 0,
      charBudget: 60_000,
    },
    usage: {},
  } as unknown as AgentRunResult;
}

function interventionProposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recommend: true,
    reason: 'A current change contradicts the stored decision.',
    dimensions: dims,
    confidence: 0.95,
    urgency: 'normal',
    targetChannelId: CHANNEL,
    evidenceMessageIds: ['m-trigger'],
    message: 'Please reconcile the changed plan.',
    ...over,
  };
}

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  env.db.prepare("UPDATE channels SET visibility_class = 'org', allow_interventions = 1 WHERE id = ?").run(CHANNEL);
  env.db.prepare(
    `INSERT INTO channels (id,workspace_id,type,name,visibility_class,ingest_enabled,allow_interventions,discovered_at_ms,updated_at_ms)
     VALUES (?, ?, 0, 'review', 'org', 1, 0, ?, ?)`,
  ).run(REVIEW_CHANNEL, GUILD, NOW, NOW);
});

afterEach(() => env.cleanup());

describe('episode intervention attention gating', () => {
  it('suppresses a recommendation without a subject or trigger, whatever its score', async () => {
    const episode = episodeWithMessages([{ id: 'm-trigger', content: 'the team changed the rollout plan' }]);
    const result = runResultFor(['m-trigger'], []);
    const proposalId = await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', {
      proposal: { intervention: interventionProposal() },
      result,
      episode,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(['m-trigger']),
    });
    const stored = getProposal(env.db, proposalId!);
    expect(stored?.status).toBe('observed');
    expect(stored?.reason).toContain('attention gate (attention_authority_missing)');
  });

  it('routes a fresh human trigger on an existing memory to review and claims the revision', async () => {
    addMessage('m-old', 'the original rollout decision', NOW - 30 * 86_400_000);
    const memory = makeMemory('Rollout happens in Q3.', [ev('m-old')]);
    const episode = episodeWithMessages([{ id: 'm-trigger', content: 'we changed the rollout plan to Friday' }]);
    const result = runResultFor(['m-trigger'], [memory]);
    const proposalId = await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', {
      proposal: {
        intervention: interventionProposal({
          subject: { kind: 'existing_memory', memoryId: memory },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: 'm-trigger', quote: 'changed the rollout plan to Friday' }],
            relation: 'changed_decision',
            materialChange: 'Rollout moved to Friday.',
          },
        }),
      },
      result,
      episode,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(['m-trigger']),
    });
    const stored = getProposal(env.db, proposalId!);
    expect(stored?.status).toBe('pending_review');
    const revisions = selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 });
    expect(revisions).toEqual([]);
    const claimRow = env.db.prepare('SELECT * FROM proposal_attention_claims').get() as { proposal_id: string };
    expect(claimRow.proposal_id).toBe(proposalId);
  });

  // Section 11.8: the channel can come back to life while the model run is in
  // flight. A proposal aimed at a live conversation is stored observed, and it
  // claims no revision, so a later settled review may still raise the subject.
  it('stores a proposal observed when the target conversation went live during the run', async () => {
    addMessage('m-old', 'the original rollout decision', NOW - 30 * 86_400_000);
    const memory = makeMemory('Rollout happens in Q3.', [ev('m-old')]);
    const episode = episodeWithMessages([{ id: 'm-trigger', content: 'we changed the rollout plan to Friday' }]);
    // Somebody answers while the review is running.
    addMessage('m-still-talking', 'actually we already have a fix for that', NOW - 30_000);
    const result = runResultFor(['m-trigger'], [memory]);
    const proposalId = await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', {
      proposal: {
        intervention: interventionProposal({
          subject: { kind: 'existing_memory', memoryId: memory },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: 'm-trigger', quote: 'changed the rollout plan to Friday' }],
            relation: 'changed_decision',
            materialChange: 'Rollout moved to Friday.',
          },
        }),
      },
      result,
      episode,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(['m-trigger']),
    });
    const stored = getProposal(env.db, proposalId!);
    expect(stored?.status).toBe('observed');
    expect(stored?.reason).toContain('conversation_live');
    // No claim was taken, so the revision stays eligible for a settled review.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM proposal_attention_claims').get()).toMatchObject({ n: 0 });
    expect(selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 }).length).toBe(1);
  });

  it('cannot propose twice from one revision', async () => {
    addMessage('m-old', 'the original rollout decision', NOW - 30 * 86_400_000);
    const memory = makeMemory('Rollout happens in Q3.', [ev('m-old')]);
    const episode = episodeWithMessages([{ id: 'm-trigger', content: 'we changed the rollout plan to Friday' }]);
    const result = runResultFor(['m-trigger'], [memory]);
    const input = {
      proposal: {
        intervention: interventionProposal({
          subject: { kind: 'existing_memory', memoryId: memory },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: 'm-trigger', quote: 'changed the rollout plan to Friday' }],
            relation: 'changed_decision',
            materialChange: 'Rollout moved to Friday.',
          },
        }),
      },
      result,
      episode,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(['m-trigger']),
    };
    const first = await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', input);
    expect(getProposal(env.db, first!)?.status).toBe('pending_review');
    // A second run over the same trigger: consumed.
    const second = await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', {
      ...input,
      result: runResultFor(['m-trigger'], [memory]),
    });
    const stored = getProposal(env.db, second!)!;
    expect(stored.status).toBe('observed');
    expect(stored.reason).toContain('revision_consumed');
  });

  it('admits a materially newer human development after an earlier card', async () => {
    addMessage('m-old', 'the original rollout decision', NOW - 30 * 86_400_000);
    const memory = makeMemory('Rollout happens in Q3.', [ev('m-old')]);
    const first = episodeWithMessages([{ id: 'm-trigger', content: 'we changed the rollout plan to Friday' }]);
    const resultA = runResultFor(['m-trigger'], [memory]);
    await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', {
      proposal: {
        intervention: interventionProposal({
          subject: { kind: 'existing_memory', memoryId: memory },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: 'm-trigger', quote: 'changed the rollout plan to Friday' }],
            relation: 'changed_decision',
            materialChange: 'Rollout moved to Friday.',
          },
        }),
      },
      result: resultA,
      episode: first,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(['m-trigger']),
    });

    const later = NOW + 60_000;
    const second = episodeWithMessages([{ id: 'm-trigger-2', content: 'we cancelled the rollout entirely' }]);
    env.db.prepare('UPDATE episodes SET created_at_ms = ?, started_at_ms = ?, ended_at_ms = ? WHERE id = ?')
      .run(later, later, later, second.id);
    const resultB = runResultFor(['m-trigger-2'], [memory]);
    const proposalId = await routeEpisodeIntervention({
      ...attentionContext(),
      now: () => later,
    } as BootstrapContext, {} as never, 'secret', {
      proposal: {
        intervention: interventionProposal({
          evidenceMessageIds: ['m-trigger-2'],
          subject: { kind: 'existing_memory', memoryId: memory },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: 'm-trigger-2', quote: 'cancelled the rollout entirely' }],
            relation: 'changed_decision',
            materialChange: 'Rollout cancelled.',
          },
        }),
      },
      result: resultB,
      episode: second,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: later,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(['m-trigger-2']),
    });
    expect(getProposal(env.db, proposalId!)?.status).toBe('pending_review');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM proposal_attention_claims').get()).toEqual({ n: 2 });
  });

  it('rejects a trigger that is not episode or follow-up material', async () => {
    addMessage('m-old', 'the original rollout decision', NOW - 30 * 86_400_000);
    addMessage('m-elsewhere', 'unrelated channel chatter about rollout', NOW - 1000, REVIEW_CHANNEL);
    const memory = makeMemory('Rollout happens in Q3.', [ev('m-old')]);
    const episode = episodeWithMessages([{ id: 'm-trigger', content: 'quiet episode' }]);
    const result = runResultFor(['m-trigger', 'm-elsewhere'], [memory]);
    const proposalId = await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', {
      proposal: {
        intervention: interventionProposal({
          subject: { kind: 'existing_memory', memoryId: memory },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: 'm-elsewhere', quote: 'unrelated channel chatter' }],
            relation: 'changed_decision',
            materialChange: 'Not episode material.',
          },
        }),
      },
      result,
      episode,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(['m-trigger']),
    });
    const stored = getProposal(env.db, proposalId!);
    expect(stored?.status).toBe('observed');
    expect(stored?.reason).toContain('unrelated_trigger');
  });

  it('resolves a memory_proposal subject only through the accepted mapping', async () => {
    const episode = episodeWithMessages([{ id: 'm-trigger', content: 'we committed to the new gateway' }]);
    const result = runResultFor(['m-trigger'], []);
    const acceptedMemoryId = makeMemory('Use the new gateway.', [ev('m-trigger')]);
    const proposalId = await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', {
      proposal: {
        intervention: interventionProposal({
          subject: { kind: 'memory_proposal', proposalIndex: 0 },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: 'm-trigger', quote: 'committed to the new gateway' }],
            relation: 'new_commitment',
            materialChange: 'The team committed to the new gateway.',
          },
        }),
      },
      result,
      episode,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: {
        applied: [{ index: 0, action: 'create', accepted: true, memoryId: acceptedMemoryId, evidenceMessageIds: ['m-trigger'] }],
        rejected: [],
        total: 1,
      },
      episodeMessageIds: new Set(['m-trigger']),
    });
    expect(getProposal(env.db, proposalId!)?.status).toBe('pending_review');

    // An out-of-range or rejected index suppresses speech while the memory
    // mutation stands on its own.
    const bad = await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', {
      proposal: {
        intervention: interventionProposal({
          subject: { kind: 'memory_proposal', proposalIndex: 3 },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: 'm-trigger', quote: 'committed to the new gateway' }],
            relation: 'new_commitment',
            materialChange: 'Bad index.',
          },
        }),
      },
      result: runResultFor(['m-trigger'], []),
      episode,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(['m-trigger']),
    });
    expect(getProposal(env.db, bad!)?.status).toBe('observed');
  });
});

describe('scheduled dispatcher and cohort attention gating', () => {
  it('advances rejected scan rows so consumed aliases cannot starve other current work', () => {
    addMessage('covered-trigger', 'We changed the rollout.', NOW - 1000);
    addMessage('valid-trigger', 'We reopened a different decision.', NOW - 2000);
    const register = (statement: string, messageId: string, quote: string) => {
      const memoryId = makeMemory(statement, [ev(messageId)]);
      const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });
      const evidence = validateTriggerEvidence(env.db, {
        guildId: GUILD, mnemeId: 'bot', evidence: [{ messageId, quote }], now: NOW, windowMs: WINDOW,
      });
      if (!evidence.ok) throw new Error('expected valid evidence');
      return { memoryId, ...registerRevision(env.db, { subjectId, triggers: evidence.records, now: NOW }) };
    };
    const original = register('Original rollout record.', 'covered-trigger', 'We changed the rollout.');
    for (let i = 0; i < 50; i += 1) register(`Another rollout record ${i}.`, 'covered-trigger', 'We changed the rollout.');
    const valid = register('A different reopened decision.', 'valid-trigger', 'We reopened a different decision.');
    seedProposalRow('already-used');
    expect(claimRevision(env.db, {
      revisionId: original.revisionId, proposalId: 'already-used', consumedAtMs: NOW,
      eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW - 1000 + WINDOW,
    })).toBe(true);
    const first = dispatcher().dispatch();
    expect(first.considered).toBe(50);
    expect(first.suppressed).toBe(50);
    expect(first.enqueued).toBe(0);
    expect(dispatcher().dispatch().enqueued).toBe(1);
    const job = env.db.prepare("SELECT payload_json FROM jobs WHERE type = 'review_due_memory_cohort'")
      .get() as { payload_json: string };
    expect(JSON.parse(job.payload_json).subjects[0].memoryId).toBe(valid.memoryId);
  });

  function dispatcher() {
    return createReviewDueMemoryDispatcherHandler({
      db: env.db,
      guildId: GUILD,
      reviewChannelId: REVIEW_CHANNEL,
      reviewAcceptedScopes: ['org', 'restricted'],
      now: () => NOW,
      attentionWindowMs: WINDOW,
    });
  }

  function eligibleRevisionMemory(): { memoryId: string; subjectId: string; revisionId: string } {
    addMessage('m-old', 'the original decision', NOW - 30 * 86_400_000);
    const memoryId = makeMemory('The canary runs at ten percent.', [ev('m-old')]);
    addMessage('m-new', 'the canary moved to fifty percent', NOW - 1000);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: '100000000000000099',
      evidence: [{ messageId: 'm-new', quote: 'moved to fifty percent' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    return { memoryId, subjectId, revisionId };
  }

  it('dispatches an attention_review cohort for an eligible revision', () => {
    const { revisionId } = eligibleRevisionMemory();
    const report = dispatcher().dispatch();
    expect(report.enqueued).toBe(1);
    const job = env.db.prepare(
      `SELECT payload_json FROM jobs WHERE type = 'review_due_memory_cohort'`,
    ).get() as { payload_json: string };
    const payload = JSON.parse(job.payload_json) as {
      mode: string;
      subjects: Array<{ attentionRevisionId?: string }>;
    };
    expect(payload.mode).toBe('attention_review');
    expect(payload.subjects[0]?.attentionRevisionId).toBe(revisionId);
  });

  it('dispatches no cohort once the revision is consumed', () => {
    const { revisionId } = eligibleRevisionMemory();
    seedProposalRow('prop-sched-1');
    expect(claimRevision(env.db, {
      revisionId, proposalId: 'prop-sched-1', consumedAtMs: NOW,
      eligibleFromMs: NOW - 1000, eligibleUntilMs: NOW - 1000 + WINDOW,
    })).toBe(true);
    const report = dispatcher().dispatch();
    expect(report.enqueued).toBe(0);
    expect(report.considered).toBe(0);
  });

  it('enqueues a bounded registration cohort for uncovered in-window evidence', () => {
    addMessage('m-recent', 'a fresh commitment nobody registered', NOW - 2000);
    makeMemory('A fresh commitment.', [ev('m-recent')]);
    const report = dispatcher().dispatch();
    expect(report.registrationEnqueued).toBe(1);
    const job = env.db.prepare(
      `SELECT payload_json FROM jobs WHERE type = 'review_due_memory_cohort'`,
    ).get() as { payload_json: string };
    const payload = JSON.parse(job.payload_json) as { mode: string };
    expect(payload.mode).toBe('attention_registration');
  });

  it('a registration run never creates an actionable proposal', async () => {
    addMessage('m-recent', 'a fresh commitment nobody registered', NOW - 2000);
    const memoryId = makeMemory('A fresh commitment.', [ev('m-recent')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });

    const fakeCompiler = {
      render: () => 'scheduled-review-prompt',
      versionFor: () => 'scheduled-review@v1',
    } as unknown as PromptCompiler;
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      mode: 'review',
      resolveReviewScope: (): ReviewScope => ({
        grant: ORG_GRANT,
        reviewChannelId: REVIEW_CHANNEL,
        targetChannelId: CHANNEL,
        notificationsAllowed: false,
        target: { label: '#general', visibility: 'org' },
      }),
      selectDue: () => [{
        memoryId, type: 'commitment', statement: 'A fresh commitment.', status: 'active',
        confidence: 0.7, importance: 0.6, reviewAfterMs: NOW, lastConfirmedAtMs: NOW,
        evidenceCount: 1, scopeType: 'org', scopeKey: null,
      }],
      executeRun: async () => scheduledRunResult('run-registration-1', memoryId, {
        recommend: true,
        reason: 'current change',
        targetChannelId: CHANNEL,
        message: 'Please confirm the commitment.',
        evidenceMessageIds: ['m-recent'],
        subjectMemoryIds: [memoryId],
      }, ['m-recent']),
      now: () => NOW,
      attentionMode: 'attention_registration',
      attentionWindowMs: WINDOW,
    });
    const outcome = await handler.runScheduledReview();
    expect(outcome.kind).toBe('reviewed');
    if (outcome.kind === 'reviewed') {
      expect(outcome.notification.routing.state).toBe('observed');
      expect(outcome.notification.routing.reasons).toContain('registration cohorts never produce notifications');
    }
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
    // The registration pass completed: the subject will not be reconsidered
    // for the same evidence each day.
    expect(env.db.prepare(
      "SELECT registration_state FROM attention_subjects WHERE id = ?",
    ).get(subjectId)).toEqual({ registration_state: 'complete' });
  });

  it('an attention_review run requires the pinned revision echo and claims it once', async () => {
    const { memoryId, revisionId } = eligibleRevisionMemory();
    const fakeCompiler = {
      render: () => 'scheduled-review-prompt',
      versionFor: () => 'scheduled-review@v1',
    } as unknown as PromptCompiler;
    const buildHandler = (echoRevisionId: string | undefined) => createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      mode: 'review',
      resolveReviewScope: (): ReviewScope => ({
        grant: ORG_GRANT,
        reviewChannelId: REVIEW_CHANNEL,
        targetChannelId: CHANNEL,
        notificationsAllowed: true,
        target: { label: '#general', visibility: 'org' },
      }),
      selectDue: () => [{
        memoryId, type: 'decision', statement: 'The canary runs at ten percent.', status: 'active',
        confidence: 0.7, importance: 0.5, reviewAfterMs: NOW, lastConfirmedAtMs: NOW,
        evidenceCount: 1, scopeType: 'org', scopeKey: null,
      }],
      executeRun: async () => scheduledRunResult('run-attention-1', memoryId, {
        recommend: true,
        reason: 'current change',
        targetChannelId: CHANNEL,
        message: 'The canary changed [[cite:m-new]].',
        evidenceMessageIds: ['m-new'],
        subjectMemoryIds: [memoryId],
        ...(echoRevisionId !== undefined ? { attentionRevisionId: echoRevisionId } : {}),
      }),
      now: () => NOW,
      attentionMode: 'attention_review',
      attentionRevisions: new Map([[memoryId, {
        revisionId, windowFromMs: NOW - 1000, windowUntilMs: NOW - 1000 + WINDOW,
      }]]),
      attentionWindowMs: WINDOW,
    });

    // Without the echo the notification is observed.
    const missing = await buildHandler(undefined).runScheduledReview();
    if (missing.kind !== 'reviewed') throw new Error('expected a reviewed outcome');
    expect(missing.notification.routing.state).toBe('observed');
    expect(missing.notification.routing.reasons).toContain('notification did not echo the pinned attention revision');

    // With the echo it becomes actionable and claims the revision.
    const good = await buildHandler(revisionId).runScheduledReview();
    if (good.kind !== 'reviewed') throw new Error('expected a reviewed outcome');
    expect(good.notification.routing.state).toBe('pending_review');
    expect(getClaim(env.db, revisionId)?.proposalId).toBe(good.notification.proposalId);

    // A second identical run can no longer become actionable.
    env.db.prepare('DELETE FROM jobs').run();
    const repeat = await buildHandler(revisionId).runScheduledReview();
    if (repeat.kind !== 'reviewed') throw new Error('expected a reviewed outcome');
    expect(repeat.notification.routing.state).toBe('observed');
    expect(repeat.notification.routing.reasons.join(' ')).toContain('revision_consumed');
  });
});

describe('approval and outbox attention enforcement', () => {
  /** Route an episode proposal to pending_review with a claimed revision. */
  async function routedPendingProposal(memoryId: string, triggerId: string, quote: string): Promise<string> {
    const episode = episodeWithMessages([{ id: triggerId, content: quote }]);
    const result = runResultFor([triggerId], [memoryId]);
    const proposalId = await routeEpisodeIntervention(attentionContext(), {} as never, 'secret', {
      proposal: {
        intervention: interventionProposal({
          evidenceMessageIds: [triggerId],
          subject: { kind: 'existing_memory', memoryId },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: triggerId, quote }],
            relation: 'changed_decision',
            materialChange: 'A current change.',
          },
        }),
      },
      result,
      episode,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'org' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set([triggerId]),
    });
    if (!proposalId) throw new Error('expected a routed proposal');
    return proposalId;
  }

  function seededSubject(): string {
    addMessage('m-old-approval', 'the original decision', NOW - 30 * 86_400_000);
    return makeMemory('The original decision stands.', [ev('m-old-approval')]);
  }

  it('lets the owner approve and send inside the attention window', async () => {
    const memoryId = seededSubject();
    addMessage('m-approval-trigger', 'we reversed the decision today', SETTLED_AT);
    const proposalId = await routedPendingProposal(
      memoryId, 'm-approval-trigger', 'we reversed the decision today',
    );
    env.db.prepare('UPDATE proposals SET message = ? WHERE id = ?', ).run('Please reconcile the reversal.', proposalId);

    const recheck = buildApprovalRecheck(attentionContext(), proposalId, NOW);
    expect(recheck.attention?.allow).toBe(true);
    const resolution = await approveProposal({
      proposalId, memberRoleIds: ['admin'], adminRoleIds: ['admin'],
      actorUserId: ALICE, guildId: GUILD, recheck, now: NOW,
    }, { db: env.db });
    expect(resolution.outcome).toBe('approved');
    const outbox = getOutboxByDedupeKey(env.db, `proposal:${proposalId}`);
    expect(outbox?.status).toBe('queued');
  });

  it.each(['edited', 'deleted', 'excluded', 'bot'])('expires an owner card when its trigger becomes %s', async (change) => {
    const proposalId = await routedPendingProposal(seededSubject(), 'changed-source', 'We moved the rollout to Friday.');
    if (change === 'edited') env.db.prepare("UPDATE messages SET content = 'Correction: no change.', edited_at_ms = ? WHERE id = 'changed-source'").run(NOW + 1);
    if (change === 'deleted') env.db.prepare("UPDATE messages SET deleted_at_ms = ? WHERE id = 'changed-source'").run(NOW + 1);
    if (change === 'excluded') env.db.prepare("UPDATE channels SET visibility_class = 'excluded' WHERE id = ?").run(CHANNEL);
    if (change === 'bot') env.db.prepare('UPDATE users SET is_bot = 1 WHERE id = ?').run(ALICE);
    const recheck = buildApprovalRecheck(attentionContext(), proposalId, NOW + 2);
    expect(recheck.attention?.allow).toBe(false);
    const result = await approveProposal({
      proposalId, memberRoleIds: ['admin'], adminRoleIds: ['admin'], actorUserId: ALICE,
      guildId: GUILD, recheck, now: NOW + 2,
    }, { db: env.db });
    expect(result.outcome).toBe('expired');
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'sync_proposal_review' AND unique_key = ?")
      .get(`proposal-review-status:${proposalId}`)).toEqual({ n: 1 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM proposal_attention_claims WHERE proposal_id = ?').get(proposalId))
      .toEqual({ n: 1 });
  });

  it('removes retry controls when a revision was superseded before approval', async () => {
    const proposalId = await routedPendingProposal(seededSubject(), 'superseded-source', 'We changed the rollout.');
    env.db.prepare("UPDATE proposals SET review_message_id = 'review-card' WHERE id = ?").run(proposalId);
    env.db.prepare("UPDATE attention_revisions SET state = 'superseded'").run();
    const resolutions: Array<{ removeControls: boolean }> = [];
    const result = await approveProposal({
      proposalId, memberRoleIds: ['admin'], adminRoleIds: ['admin'], actorUserId: ALICE,
      guildId: GUILD, recheck: buildApprovalRecheck(attentionContext(), proposalId, NOW), now: NOW,
    }, { db: env.db, resolveReview: (resolution) => { resolutions.push(resolution); } });
    expect(result.outcome).toBe('expired');
    expect(resolutions).toEqual([expect.objectContaining({ removeControls: true })]);
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
  });

  it('cancels an approved delivery when the trigger changes before the worker sends', async () => {
    const proposalId = await routedPendingProposal(seededSubject(), 'worker-edit', 'We changed the rollout.');
    const approval = await approveProposal({
      proposalId, memberRoleIds: ['admin'], adminRoleIds: ['admin'], actorUserId: ALICE,
      guildId: GUILD, recheck: buildApprovalRecheck(attentionContext(), proposalId, NOW), now: NOW,
    }, { db: env.db });
    expect(approval.outcome).toBe('approved');
    env.db.prepare("UPDATE messages SET content = 'Correction: keep the existing plan.' WHERE id = 'worker-edit'").run();
    let sends = 0;
    const handler = createSendOutboxHandler({
      db: env.db, now: () => NOW + 1,
      sender: { send: async () => { sends += 1; return { platformMessageId: 'must-not-send' }; } },
      validateProposalSend: (id, now) => recheckApprovalPolicy(buildApprovalRecheck(attentionContext(), id, now)),
    });
    await handler({ outboxId: approval.outboxId! }, { max_attempts: 5 } as never);
    expect(sends).toBe(0);
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)?.status).toBe('cancelled');
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
  });

  it('expires the proposal when the attention window closed before approval', async () => {
    const memoryId = seededSubject();
    addMessage('m-late-trigger', 'we reversed the decision a while ago', NOW - WINDOW + 1000);
    const proposalId = await routedPendingProposal(
      memoryId, 'm-late-trigger', 'we reversed the decision a while ago',
    );
    env.db.prepare('UPDATE proposals SET message = ? WHERE id = ?', ).run('Please reconcile the reversal.', proposalId);

    const late = NOW + WINDOW;
    const recheck = buildApprovalRecheck(attentionContext(), proposalId, late);
    expect(recheck.attention?.allow).toBe(false);
    expect(recheck.attention?.reasons[0]).toContain('attention window expired');
    const resolution = await approveProposal({
      proposalId, memberRoleIds: ['admin'], adminRoleIds: ['admin'],
      actorUserId: ALICE, guildId: GUILD, recheck, now: late,
    }, { db: env.db });
    expect(resolution.outcome).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
    // The consumption stands: the revision cannot produce a replacement card.
    expect(selectEligibleRevisions(env.db, { now: late, windowMs: WINDOW, limit: 10 })).toEqual([]);
  });

  it('cancels an approved send before Discord I/O when the window ended', async () => {
    const memoryId = seededSubject();
    addMessage('m-worker-trigger', 'we reversed the decision today', SETTLED_AT);
    const proposalId = await routedPendingProposal(
      memoryId, 'm-worker-trigger', 'we reversed the decision today',
    );
    env.db.prepare(
      `UPDATE proposals SET status = 'approved', message = ? WHERE id = ?`,
    ).run('Please reconcile the reversal.', proposalId);
    const runId = (env.db.prepare('SELECT run_id FROM proposals WHERE id = ?').get(proposalId) as { run_id: string }).run_id;
    const { outboxId } = enqueueOutbox(env.db, {
      proposalId, runId, channelId: CHANNEL, content: 'Please reconcile the reversal.', now: NOW,
    });

    const sends: SendRecording[] = [];
    const sender: OutboxSender = { send: async (input) => { sends.push(input); return { platformMessageId: 'sent-1' }; } };
    const late = NOW + WINDOW + 1;
    const handler = createSendOutboxHandler({
      db: env.db, sender, now: () => late, retryDelayMs: () => 1_000,
      validateProposalSend: (id) => {
        const check = validateProposalAttention(env.db, id, late);
        return { allow: check.allow, reasons: check.reasons };
      },
    });
    await handler({ outboxId }, { maxAttempts: 5 } as never);

    expect(sends).toHaveLength(0);
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)?.status).toBe('cancelled');
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
  });

  it('records an already-sent marker even when the attention window later ended', async () => {
    const memoryId = seededSubject();
    addMessage('m-sent-trigger', 'we reversed the decision today', SETTLED_AT);
    const proposalId = await routedPendingProposal(
      memoryId, 'm-sent-trigger', 'we reversed the decision today',
    );
    const runId = (env.db.prepare('SELECT run_id FROM proposals WHERE id = ?').get(proposalId) as { run_id: string }).run_id;
    const { outboxId } = enqueueOutbox(env.db, {
      proposalId, runId, channelId: CHANNEL, content: 'Please reconcile the reversal.', now: NOW,
    });
    const claimed = claimOutboxForSending(env.db, outboxId, NOW);
    expect(claimed).toBeDefined();

    const late = NOW + WINDOW + 1;
    const { reconcileOutboxSending } = await import('../../src/outbox/recovery.js');
    const sent = await reconcileOutboxSending(env.db, {
      fetch: async () => [{
        platformMessageId: 'discord-1',
        content: 'Please reconcile the reversal.',
        dedupeMarker: claimed!.dedupeMarker,
        sentAtMs: NOW,
      }],
    }, {
      now: late,
      validateProposalSend: (id) => {
        const check = validateProposalAttention(env.db, id, late);
        return { allow: check.allow, reasons: check.reasons };
      },
      requeueDelayMs: 1_000,
    });
    expect(sent.confirmed).toBe(1);
    expect(sent.cancelled).toBe(0);
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)?.status).toBe('sent');
    expect(getProposal(env.db, proposalId)?.status).toBe('sent');
  });
});

interface SendRecording {
  channelId: string;
  content: string;
}

describe('cohort handler end-to-end through the production payload', () => {
  function fakeCompiler(): PromptCompiler {
    return {
      render: () => 'scheduled-review-prompt',
      versionFor: () => 'scheduled-review@v1',
    } as unknown as PromptCompiler;
  }

  async function runCohortJob(
    payload: Record<string, unknown>,
    notification: Record<string, unknown>,
    memoryId: string,
    messageIds: string[] = ['m-new'],
    selectedJobId?: string,
  ): Promise<{ outcomeState?: string; proposalId?: string }> {
    const { createReviewDueMemoryCohortHandler } = await import('../../src/jobs/handlers/review-due-memory-cohort.js');
    const jobId = selectedJobId ?? (env.db.prepare(
      `SELECT id FROM jobs WHERE type = 'review_due_memory_cohort'`,
    ).get() as { id: string }).id;
    let captured: { outcomeState?: string; proposalId?: string } = {};
    const handler = createReviewDueMemoryCohortHandler({
      db: env.db,
      guildId: GUILD,
      reviewChannelId: REVIEW_CHANNEL,
      reviewAcceptedScopes: ['org', 'restricted'],
      base: {
        promptCompiler: fakeCompiler(),
        systemPrompt: 'system',
        mode: 'review',
        executeRun: async () => scheduledRunResult(`run-cohort-${jobId}`, memoryId, notification, messageIds),
        now: () => NOW,
        attentionWindowMs: WINDOW,
      },
      resolveWorkingScope: () => ({
        grant: ORG_GRANT,
        reviewChannelId: REVIEW_CHANNEL,
        targetChannelId: CHANNEL,
        notificationsAllowed: true,
        target: { label: '#general', visibility: 'org' },
      }),
      resolveSecureScope: () => ({
        grant: ORG_GRANT,
        reviewChannelId: REVIEW_CHANNEL,
        notificationsAllowed: false,
        target: { label: '#review', visibility: 'review_only' },
      }),
      onPendingProposal: async (outcome) => {
        captured = {
          outcomeState: outcome.notification.routing.state,
          proposalId: outcome.notification.proposalId,
        };
      },
    });
    await handler(payload as never, { id: jobId } as never);
    return captured;
  }

  it('creates only one card when two subjects registered the same human event before either claimed it', async () => {
    eligibleRevisionMemoryForCohort();
    const aliasMemory = makeMemory('Another record of the same canary rollout.', [ev('m-new')]);
    const aliasSubject = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: aliasMemory, now: NOW });
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: 'bot', evidence: [{ messageId: 'm-new', quote: 'moved to fifty percent' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger');
    registerRevision(env.db, { subjectId: aliasSubject, triggers: records.records, now: NOW });
    const dispatch = createReviewDueMemoryDispatcherHandler({
      db: env.db, guildId: GUILD, reviewChannelId: REVIEW_CHANNEL, reviewAcceptedScopes: ['org', 'restricted'],
      now: () => NOW, attentionWindowMs: WINDOW,
    }).dispatch();
    expect(dispatch.enqueued).toBe(2);
    const jobs = env.db.prepare("SELECT id, payload_json FROM jobs WHERE type = 'review_due_memory_cohort' ORDER BY id")
      .all() as Array<{ id: string; payload_json: string }>;
    const cards: string[] = [];
    for (const job of jobs) {
      const payload = JSON.parse(job.payload_json) as { subjects: Array<{ memoryId: string; attentionRevisionId: string }> };
      const subject = payload.subjects[0]!;
      const captured = await runCohortJob(payload, {
        recommend: true, reason: 'current change', targetChannelId: CHANNEL,
        message: 'The canary changed [[cite:m-new]].', evidenceMessageIds: ['m-new'],
        subjectMemoryIds: [subject.memoryId], attentionRevisionId: subject.attentionRevisionId,
      }, subject.memoryId, ['m-new'], job.id);
      if (captured.proposalId) cards.push(captured.proposalId);
    }
    expect(cards).toHaveLength(1);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending_review'").get()).toEqual({ n: 1 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM proposal_attention_claims').get()).toEqual({ n: 1 });
    expect(selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 })).toEqual([]);
  });

  it('rejects a dispatched trigger edited after its memory snapshot was taken', async () => {
    const { memoryId, revisionId } = eligibleRevisionMemoryForCohort();
    createReviewDueMemoryDispatcherHandler({
      db: env.db, guildId: GUILD, reviewChannelId: REVIEW_CHANNEL, reviewAcceptedScopes: ['org', 'restricted'],
      now: () => NOW, attentionWindowMs: WINDOW,
    }).dispatch();
    const job = env.db.prepare("SELECT payload_json FROM jobs WHERE type = 'review_due_memory_cohort'")
      .get() as { payload_json: string };
    env.db.prepare("UPDATE messages SET content = 'Correction: the canary has not changed.' WHERE id = 'm-new'").run();
    const captured = await runCohortJob(JSON.parse(job.payload_json), {
      recommend: true, reason: 'current change', targetChannelId: CHANNEL,
      message: 'The canary changed [[cite:m-new]].', evidenceMessageIds: ['m-new'],
      subjectMemoryIds: [memoryId], attentionRevisionId: revisionId,
    }, memoryId);
    expect(captured).toEqual({});
    expect(getClaim(env.db, revisionId)).toBeNull();
  });

  it('produces a card from a dispatched attention_review payload', async () => {
    const { memoryId, revisionId } = eligibleRevisionMemoryForCohort();
    const dispatch = createReviewDueMemoryDispatcherHandler({
      db: env.db,
      guildId: GUILD,
      reviewChannelId: REVIEW_CHANNEL,
      reviewAcceptedScopes: ['org', 'restricted'],
      now: () => NOW,
      attentionWindowMs: WINDOW,
    }).dispatch();
    expect(dispatch.enqueued).toBe(1);
    const job = env.db.prepare(
      `SELECT payload_json FROM jobs WHERE type = 'review_due_memory_cohort'`,
    ).get() as { payload_json: string };
    const payload = JSON.parse(job.payload_json);

    const captured = await runCohortJob(payload, {
      recommend: true,
      reason: 'current change',
      targetChannelId: CHANNEL,
      message: 'The canary changed [[cite:m-new]].',
      evidenceMessageIds: ['m-new'],
      subjectMemoryIds: [memoryId],
      attentionRevisionId: revisionId,
    }, memoryId);
    expect(captured.outcomeState).toBe('pending_review');
    expect(getProposal(env.db, captured.proposalId!)?.status).toBe('pending_review');
    expect(getClaim(env.db, revisionId)?.proposalId).toBe(captured.proposalId);
    // The lease is released after the run.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM scheduled_review_cohort_subject_leases').get())
      .toEqual({ n: 0 });
  });

  it('delivers a deadline-due revision through the full dispatch path', async () => {
    // Day 0: a promise with a source-verified deadline on day 30.
    const promiseAt = NOW - 30 * 86_400_000;
    addMessage('m-promise', 'we promised the report by 18 September 2026', promiseAt);
    const memoryId = makeMemory('A report is promised.', [ev('m-promise')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });
    const message = env.db.prepare(
      'SELECT content, created_at_ms FROM messages WHERE id = ?',
    ).get('m-promise') as { content: string; created_at_ms: number };
    const records = {
      records: [{
        messageId: 'm-promise', content: message.content,
        createdAtMs: Number(message.created_at_ms), quoteStart: 0, quoteEnd: message.content.length,
      }],
    };
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    setRevisionDeadline(env.db, {
      revisionId,
      deadlineAtMs: NOW,
      timezone: 'UTC',
      parserVersion: 'deadline-v1',
      evidence: records.records[0]!,
    });

    const dispatch = createReviewDueMemoryDispatcherHandler({
      db: env.db,
      guildId: GUILD,
      reviewChannelId: REVIEW_CHANNEL,
      reviewAcceptedScopes: ['org', 'restricted'],
      now: () => NOW,
      attentionWindowMs: WINDOW,
    }).dispatch();
    expect(dispatch.enqueued).toBe(1);
    const job = env.db.prepare(
      `SELECT payload_json FROM jobs WHERE type = 'review_due_memory_cohort'`,
    ).get() as { payload_json: string };
    const payload = JSON.parse(job.payload_json) as { subjects: Array<{ attentionRevisionId?: string }> };
    expect(payload.subjects[0]?.attentionRevisionId).toBe(revisionId);

    const captured = await runCohortJob(payload, {
      recommend: true,
      reason: 'deadline due',
      targetChannelId: CHANNEL,
      message: 'The promised report is due today [[cite:m-promise]].',
      evidenceMessageIds: ['m-promise'],
      subjectMemoryIds: [memoryId],
      attentionRevisionId: revisionId,
    }, memoryId, ['m-promise']);
    expect(captured.outcomeState).toBe('pending_review');
    expect(getClaim(env.db, revisionId)?.proposalId).toBe(captured.proposalId);
  });

  it('keeps a deadline revision selectable through a plain memory supersede', async () => {
    const promiseAt = NOW - 30 * 86_400_000;
    addMessage('m-promise-2', 'we promised the audit by 18 September 2026', promiseAt);
    const memoryId = makeMemory('An audit is promised.', [ev('m-promise-2')]);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });
    const message = env.db.prepare(
      'SELECT content, created_at_ms FROM messages WHERE id = ?',
    ).get('m-promise-2') as { content: string; created_at_ms: number };
    const records = {
      records: [{
        messageId: 'm-promise-2', content: message.content,
        createdAtMs: Number(message.created_at_ms), quoteStart: 0, quoteEnd: message.content.length,
      }],
    };
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    setRevisionDeadline(env.db, {
      revisionId,
      deadlineAtMs: NOW,
      timezone: 'UTC',
      parserVersion: 'deadline-v1',
      evidence: records.records[0]!,
    });

    // A routine model supersede with no attention fields: the successor must
    // join the subject so the waiting deadline keeps its dispatch path.
    addMessage('m-refine', 'the audit scope is broader now', NOW - 1000);
    const { applyMemoryProposals } = await import('../../src/agent/memory-policy.js');
    applyMemoryProposals({
      db: env.db, grant: ORG_GRANT, guildId: GUILD, runId: 'run-refine', now: NOW,
      exposedChannelIds: new Set([CHANNEL]), exposedMessageIds: new Set(['m-refine', 'm-promise-2']),
      exposedMemoryIds: new Set([memoryId]),
    }, [{
      action: 'supersede',
      type: 'commitment',
      statement: 'An audit is promised with a broader scope.',
      existingMemoryId: memoryId,
      confidence: 0.8, importance: 0.7,
      evidenceMessageIds: ['m-promise-2', 'm-refine'],
      evidenceQuotes: [
        { messageId: 'm-promise-2', quote: 'promised the audit' },
        { messageId: 'm-refine', quote: 'broader now' },
      ],
      durability: 'project',
      durabilityReason: 'It governs the upcoming audit.',
    }]);

    const revisions = selectEligibleRevisions(env.db, { now: NOW, windowMs: WINDOW, limit: 10 });
    expect(revisions.map((r) => r.revisionId)).toContain(revisionId);
  });

  function eligibleRevisionMemoryForCohort(): { memoryId: string; revisionId: string } {
    addMessage('m-old', 'the original decision', NOW - 30 * 86_400_000);
    const memoryId = makeMemory('The canary runs at ten percent.', [ev('m-old')]);
    addMessage('m-new', 'the canary moved to fifty percent', NOW - 1000);
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: '100000000000000099',
      evidence: [{ messageId: 'm-new', quote: 'moved to fifty percent' }],
      now: NOW, windowMs: WINDOW,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });
    return { memoryId, revisionId };
  }
});
