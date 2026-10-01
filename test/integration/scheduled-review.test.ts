import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { getMessage, upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { createMemory, getMemory, updateMemory } from '../../src/memory/repository.js';
import { claimRevision, ensureSubjectForMember, registerRevision } from '../../src/memory/attention-repository.js';
import { getProposal, insertProposal } from '../../src/db/repositories/proposals.js';
import { enqueueOutbox, getOutboxByDedupeKey } from '../../src/outbox/repository.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';
import { loadPromptCompiler, type PromptCompiler } from '../../src/agent/prompts.js';
import type { AgentRunResult, ExecuteAgentRunDeps } from '../../src/agent/runtime.js';
import {
  createReviewDueMemoriesHandler,
  routeScheduledNotification,
  DEFAULT_SCHEDULED_PROPOSAL_WINDOW_MS,
  SCHEDULED_REVIEW_PROMPT_PREPARATION_ERROR,
  type ScheduledReviewProposal,
  type ApplyArgs,
  type ScheduledReviewRenderContext,
} from '../../src/jobs/handlers/review-due-memories.js';
import {
  applyMemoryProposals,
  type AgentMemoryProposal,
} from '../../src/agent/memory-policy.js';
import { JobWorker } from '../../src/jobs/worker.js';
import { enqueue } from '../../src/jobs/queue.js';
import { approveProposal } from '../../src/review/workflow.js';
import {
  buildApprovalRecheck,
  buildScheduledReviewPresentation,
} from '../../src/production-runtime.js';
import type { BootstrapContext } from '../../src/bootstrap.js';
import { fingerprintExposedMemory } from '../../src/agent/run-context.js';
import {
  DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
  findScheduledSubjectBlock,
  insertScheduledProposalSubjects,
  scheduledTopicKey,
  type ScheduledSubjectSnapshot,
} from '../../src/memory/scheduled-notifications.js';
import { emptyAgentRunUsage } from '../../src/agent/usage.js';

/**
 * Scheduled-memory review job (Sections 12.4, 20, 24.3).
 *
 * Acceptance: scheduled runs classify due items and create no unsupported
 * mutation. Working cohorts are pinned to their exact source target, while the
 * proposal card is delivered to secure review; notifications are always
 * pending_review or observed — never approved autonomously.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded restricted channel
const REVIEW_CHANNEL = '100000000000000009'; // secure review channel
const ALICE = '100000000000000003';
const NOW = 1_700_000_001_000;

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const promptDir = path.join(root, 'prompts');

const GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: true,
  channelIds: [CHANNEL],
};

function reviewScope() {
  return {
    grant: GRANT,
    reviewChannelId: REVIEW_CHANNEL,
    target: { label: '#review', visibility: 'review_only' as const },
  };
}

function renderSystemPrompt(compiler: PromptCompiler, context: ScheduledReviewRenderContext): string {
  return compiler.render('system', {
    ...context,
    agent: { name: 'Mneme', role: 'organizational memory' },
    organization: { name: 'Test Co', timezone: 'UTC' },
    personality: { traits: ['calm'], avoid: ['sarcasm'] },
  });
}

let env: TestDb;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  env.db
    .prepare(
      `INSERT INTO channels (id, guild_id, parent_id, type, name, topic, position, is_thread,
         is_archived, is_locked, ingest_enabled, visibility_class, allow_interventions,
         permission_fingerprint, last_message_id, discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json)
       VALUES (?, ?, NULL, 0, ?, NULL, NULL, 0, 0, 0, 1, 'org', 0, NULL, NULL, ?, ?, NULL, NULL)`,
    )
    .run(REVIEW_CHANNEL, GUILD, 'review', NOW, NOW);
  // The faked executeRun does not persist its own agent_runs row, but the
  // proposal FK (proposals.run_id → agent_runs.id) requires one to exist.
  for (const runId of ['run-1', 'run-2']) {
    env.db
      .prepare(
        `INSERT INTO agent_runs (id, guild_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
         VALUES (?,?,NULL,'scheduled_review','scheduled-review@v1','faux','faux-1','completed',?)`,
      )
      .run(runId, GUILD, NOW);
  }
});
afterEach(() => env.cleanup());

const fakeCompiler = {
  render: () => 'scheduled-review-prompt',
  versionFor: () => 'scheduled-review@v1',
} as unknown as PromptCompiler;

function finalizeResult(
  proposal: ScheduledReviewProposal,
  channels: string[] = [CHANNEL],
  messageIds: string[] = ['m-due'],
  runId = 'run-1',
): AgentRunResult {
  return {
    runId,
    status: 'completed',
    outcome: 'finalized',
    failureReason: null,
    turns: 1,
    modelTurns: [],
    toolCalls: [],
    usage: { ...emptyAgentRunUsage(), inputTokens: 10, outputTokens: 5 },
    provenance: {
      channels: channels.map((channelId) => ({ channelId, source: 'search_messages' })),
      memoryScopes: [],
      memoryIds: [],
      messageIds,
      charsExposed: 100,
      charBudget: 100000,
    },
    finalProposal: { kind: 'scheduled_review', proposal },
    startedAtMs: NOW,
    endedAtMs: NOW + 1,
  } as unknown as AgentRunResult;
}

function notification(over: Partial<ScheduledReviewProposal['notification']> = {}): ScheduledReviewProposal['notification'] {
  return {
    recommend: true,
    reason: 'material and timely',
    targetChannelId: REVIEW_CHANNEL,
    message: 'Please record the current launch status.',
    evidenceMessageIds: ['m-due'],
    subjectMemoryIds: [],
    ...over,
  };
}

function seedDueMemory(): string {
  return createMemory(env.db, GRANT, {
    guildId: GUILD,
    type: 'prediction',
    statement: 'We will ship feature X by July.',
    confidence: 0.8,
    importance: 0.6,
    evidence: [{ messageId: seedMessage('m-due', CHANNEL, 'I predict July'), stance: 'origin' }],
    reviewAfterMs: NOW - 1000, // due
    now: NOW,
  });
}

function seedMessage(id: string, channel: string, content = 'msg'): string {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: channel,
    authorId: ALICE,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: NOW,
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
    ingestedAtMs: NOW,
    updatedAtMs: NOW,
  });
  return id;
}

function subjectSnapshot(memoryId: string): ScheduledSubjectSnapshot {
  const memoryFingerprint = fingerprintExposedMemory(env.db, memoryId);
  if (!memoryFingerprint) throw new Error(`missing memory fingerprint for ${memoryId}`);
  return { memoryId, memoryFingerprint };
}

function seedScheduledSubjectProposal(input: {
  memoryId: string;
  runId?: string;
  status?: 'pending_review' | 'sent' | 'dismissed';
  now?: number;
  message?: string;
}): string {
  const subjects = [subjectSnapshot(input.memoryId)];
  const now = input.now ?? NOW;
  const proposalId = insertProposal(env.db, {
    runId: input.runId ?? 'run-1',
    targetChannelId: REVIEW_CHANNEL,
    status: input.status ?? 'pending_review',
    computedScore: 1,
    reason: ['recommended; routed to secure review'],
    reviewReason: 'The subject needs a current status.',
    topicKey: scheduledTopicKey(subjects),
    message: input.message ?? 'Please record the current status.',
    evidenceMessageIds: ['m-due'],
    expiresAtMs: input.status === undefined || input.status === 'pending_review'
      ? now + DEFAULT_SCHEDULED_PROPOSAL_WINDOW_MS
      : null,
    now,
  });
  insertScheduledProposalSubjects(env.db, proposalId, subjects, now);
  return proposalId;
}


/** Post-cutover actionable scheduled proposals own an attention claim. */
function seedAttentionClaim(proposalId: string, memoryId: string): string {
  const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId, now: NOW });
  const source = getMessage(env.db, 'm-due')!;
  const { revisionId } = registerRevision(env.db, {
    subjectId, now: NOW,
    triggers: [{
      messageId: source.id, createdAtMs: source.created_at_ms, content: source.content,
      quoteStart: 0, quoteEnd: source.content.length,
    }],
  });
  expect(claimRevision(env.db, {
    revisionId, proposalId, consumedAtMs: NOW,
    eligibleFromMs: source.created_at_ms, eligibleUntilMs: source.created_at_ms + 7 * 86_400_000,
  })).toBe(true);
  return revisionId;
}

function setRunProvenance(
  runId: string,
  messageIds: string[],
  channels: string[] = [],
): void {
  env.db.prepare(
    `UPDATE agent_runs
        SET retrieval_provenance_json = ?
      WHERE id = ?`,
  ).run(JSON.stringify({
    channels: channels.map((channelId) => ({ channelId, source: 'message_search' })),
    memoryScopes: [],
    memoryIds: [],
    messageIds,
    messageFingerprints: [],
    memoryFingerprints: [],
    charsExposed: 0,
    charBudget: 100_000,
  }), runId);
}

async function persistScheduledNotification(
  proposed: ScheduledReviewProposal['notification'],
  exposedMessageIds: string[] = ['m-due'],
) {
  const memoryId = seedDueMemory();
  const grounded = proposed.recommend && proposed.subjectMemoryIds.length === 0
    ? { ...proposed, subjectMemoryIds: [memoryId] }
    : proposed;
  const handler = createReviewDueMemoriesHandler({
    db: env.db,
    guildId: GUILD,
    promptCompiler: fakeCompiler,
    systemPrompt: 'system',
    resolveReviewScope: reviewScope,
    mode: 'review',
    executeRun: async () => finalizeResult(
      { memoryProposals: [], notification: grounded },
      [CHANNEL],
      exposedMessageIds,
    ),
    now: () => NOW,
  });
  const outcome = await handler.runScheduledReview(NOW);
  if (outcome.kind !== 'reviewed') {
    throw new Error(`expected reviewed outcome, received ${outcome.kind}`);
  }
  return getProposal(env.db, outcome.notification.proposalId)!;
}

describe('routeScheduledNotification', () => {
  it('observe mode stores the notification observed', () => {
    const r = routeScheduledNotification({
      mode: 'observe',
      recommend: true,
      targetChannelId: REVIEW_CHANNEL,
      reviewChannelId: REVIEW_CHANNEL,
    });
    expect(r.state).toBe('observed');
  });

  it('a non-recommended notification is observed', () => {
    const r = routeScheduledNotification({
      mode: 'review',
      recommend: false,
      targetChannelId: REVIEW_CHANNEL,
      reviewChannelId: REVIEW_CHANNEL,
    });
    expect(r.state).toBe('observed');
  });

  it('a recommended notification targeting the review channel is pending_review', () => {
    const r = routeScheduledNotification({
      mode: 'review',
      recommend: true,
      targetChannelId: REVIEW_CHANNEL,
      reviewChannelId: REVIEW_CHANNEL,
    });
    expect(r.state).toBe('pending_review');
  });

  it('never routes approved, even in autonomous mode', () => {
    const r = routeScheduledNotification({
      mode: 'autonomous',
      recommend: true,
      targetChannelId: REVIEW_CHANNEL,
      reviewChannelId: REVIEW_CHANNEL,
    });
    expect(r.state).toBe('pending_review');
  });

  it('a notification retargeted away from the review channel is observed', () => {
    const r = routeScheduledNotification({
      mode: 'review',
      recommend: true,
      targetChannelId: CHANNEL, // a working channel
      reviewChannelId: REVIEW_CHANNEL,
    });
    expect(r.state).toBe('observed');
  });
});

describe('scheduled-review approval regression', () => {
  // Rechecks assert each specific policy failure; legacy fixtures without an
  // attention claim now expire instead of retaining retryable review controls.
  function approvalContext(): BootstrapContext {
    return {
      db: env.db,
      now: () => NOW,
      config: {
        reviewChannelId: REVIEW_CHANNEL,
        intervention: { channelCooldownMinutes: 180, globalDailyLimit: 5 },
        organization: { timezone: 'UTC' },
      },
    } as unknown as BootstrapContext;
  }

  function seedScheduledProposal(runId = 'run-1'): string {
    setRunProvenance(runId, []);
    return insertProposal(env.db, {
      runId,
      targetChannelId: REVIEW_CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      message: 'Please record the current launch status.',
      evidenceMessageIds: [],
      expiresAtMs: NOW + 72 * 60 * 60_000,
      now: NOW,
    });
  }

  it('rejects a legacy scheduled notification aimed at the secure review channel', async () => {
    const proposalId = seedScheduledProposal();
    const recheck = buildApprovalRecheck(approvalContext(), proposalId, NOW);
    expect(recheck.outboundEvidence.outcome).toBe('reject');
    expect(recheck.outboundEvidence.reasons[0]).toContain('does not allow interventions');

    const result = await approveProposal({
      proposalId,
      memberRoleIds: ['admin-role'],
      adminRoleIds: ['admin-role'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck,
      now: NOW,
    }, { db: env.db });

    expect(result.outcome).toBe('expired');
    expect(getProposal(env.db, proposalId)!.status).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
  });

  it('approves a current scheduled proposal for its exact working channel', async () => {
    env.db.prepare('UPDATE channels SET allow_interventions=1 WHERE id=?').run(CHANNEL);
    const memoryId = seedDueMemory();
    const subjects = [subjectSnapshot(memoryId)];
    setRunProvenance('run-1', ['m-due'], [CHANNEL]);
    const proposalId = insertProposal(env.db, {
      runId: 'run-1',
      targetChannelId: CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      message: 'Please record the current launch status.',
      evidenceMessageIds: ['m-due'],
      expiresAtMs: NOW + 72 * 60 * 60_000,
      now: NOW,
    });
    insertScheduledProposalSubjects(env.db, proposalId, subjects, NOW);
    seedAttentionClaim(proposalId, memoryId);
    const recheck = buildApprovalRecheck(approvalContext(), proposalId, NOW, {
      guildId: GUILD,
      reviewChannelId: REVIEW_CHANNEL,
      reviewAcceptedScopes: ['org', 'restricted', 'review_only'],
    });
    expect(recheck.scheduledDelivery).toMatchObject({ scheduled: true, allow: true });

    const result = await approveProposal({
      proposalId,
      memberRoleIds: ['admin-role'],
      adminRoleIds: ['admin-role'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck,
      now: NOW,
    }, { db: env.db });

    expect(result.outcome).toBe('approved');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)?.channelId).toBe(CHANNEL);
  });

  it('delivers the rendered text: inline links substituted and footer appended', async () => {
    env.db.prepare('UPDATE channels SET allow_interventions=1 WHERE id=?').run(CHANNEL);
    const memoryId = seedDueMemory();
    setRunProvenance('run-1', ['m-due'], [CHANNEL]);
    const proposalId = insertProposal(env.db, {
      runId: 'run-1',
      targetChannelId: CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      message: '**Launch status**\nThe launch remains blocked. [[cite:m-due]]\nWhat is the current status?',
      evidenceMessageIds: ['m-due'],
      expiresAtMs: NOW + 72 * 60 * 60_000,
      now: NOW,
    });
    insertScheduledProposalSubjects(env.db, proposalId, [subjectSnapshot(memoryId)], NOW);
    seedAttentionClaim(proposalId, memoryId);
    const recheck = buildApprovalRecheck(approvalContext(), proposalId, NOW, {
      guildId: GUILD,
      reviewChannelId: REVIEW_CHANNEL,
      reviewAcceptedScopes: ['org', 'restricted', 'review_only'],
    });
    const result = await approveProposal({
      proposalId,
      memberRoleIds: ['admin-role'],
      adminRoleIds: ['admin-role'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck,
      now: NOW,
    }, { db: env.db });

    expect(result.outcome).toBe('approved');
    const outbox = getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)!;
    expect(outbox.content).toContain(
      `[#general · 2023-11-14](https://discord.com/channels/${GUILD}/${CHANNEL}/m-due)`,
    );
    expect(outbox.content).not.toContain('[[cite:');
    expect(outbox.content).toContain('Mneme tracks decisions and open commitments');
    // The durable proposal now carries the exact delivered text, so
    // reply-feedback association (content === message) keeps working.
    expect(getProposal(env.db, proposalId)!.message).toBe(outbox.content);
  });

  it('expires route drift recomputed inside the approval transaction', async () => {
    env.db.prepare('UPDATE channels SET allow_interventions=1 WHERE id=?').run(CHANNEL);
    const memoryId = seedDueMemory();
    setRunProvenance('run-1', ['m-due'], [CHANNEL]);
    const proposalId = insertProposal(env.db, {
      runId: 'run-1', targetChannelId: CHANNEL, status: 'pending_review', computedScore: 1,
      reason: ['review'], message: 'Please record the current launch status.',
      evidenceMessageIds: ['m-due'], expiresAtMs: NOW + 60_000, now: NOW,
    });
    insertScheduledProposalSubjects(env.db, proposalId, [subjectSnapshot(memoryId)], NOW);
    seedAttentionClaim(proposalId, memoryId);
    const recheck = buildApprovalRecheck(approvalContext(), proposalId, NOW, {
      guildId: GUILD, reviewChannelId: REVIEW_CHANNEL,
      reviewAcceptedScopes: ['org', 'restricted', 'review_only'],
    });
    expect(recheck.scheduledDelivery?.allow).toBe(true);

    // Simulate a policy reload after the interaction was parsed but before the
    // immediate approval transaction begins.
    env.db.prepare('UPDATE channels SET allow_interventions=0 WHERE id=?').run(CHANNEL);
    const result = await approveProposal({
      proposalId, memberRoleIds: ['admin-role'], adminRoleIds: ['admin-role'],
      actorUserId: ALICE, guildId: GUILD, recheck, now: NOW,
    }, { db: env.db });

    expect(result.outcome).toBe('expired');
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
  });

  it('does not bypass allow_interventions for a non-scheduled proposal', () => {
    env.db.prepare("UPDATE agent_runs SET run_type = 'episode' WHERE id = 'run-2'").run();
    const proposalId = seedScheduledProposal('run-2');
    const recheck = buildApprovalRecheck(approvalContext(), proposalId, NOW);
    expect(recheck.outboundEvidence.outcome).toBe('reject');
    expect(recheck.outboundEvidence.reasons[0]).toContain('does not allow interventions');
  });

  it('renders the real review-channel name and stored evidence link', () => {
    const evidenceId = seedMessage('scheduled-evidence', CHANNEL, 'Launch remains blocked.');
    setRunProvenance('run-1', [evidenceId], [CHANNEL]);
    const proposalId = insertProposal(env.db, {
      runId: 'run-1',
      targetChannelId: REVIEW_CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      message: 'Please record the current launch status.',
      evidenceMessageIds: [evidenceId],
      expiresAtMs: NOW + 72 * 60 * 60_000,
      now: NOW,
    });
    const proposal = getProposal(env.db, proposalId)!;

    const presentation = buildScheduledReviewPresentation(env.db, GUILD, proposal);
    expect(presentation.targetLabel).toBe('#review');
    expect(presentation.assessment).toBe('Recommended scheduled review');
    expect(presentation.reason).toBe('recommended; routed to secure review');
    // Links render inside the quoted delivery text, not as a separate card list.
    expect(presentation.sources).toEqual([]);
    expect(presentation.proposedMessage).toContain(
      `Sources: [#general · 2023-11-14](https://discord.com/channels/${GUILD}/${CHANNEL}/${evidenceId})`,
    );
    expect(presentation.proposedMessage).toContain('Mneme tracks decisions and open commitments');
  });

  it('omits card links that were not exposed by the scheduled run', () => {
    const evidenceId = seedMessage('not-run-exposed', CHANNEL, 'Current but never exposed.');
    setRunProvenance('run-1', []);
    const proposalId = insertProposal(env.db, {
      runId: 'run-1',
      targetChannelId: REVIEW_CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      message: 'Please record the current launch status.',
      evidenceMessageIds: [evidenceId],
      now: NOW,
    });

    const presentation = buildScheduledReviewPresentation(
      env.db,
      GUILD,
      getProposal(env.db, proposalId)!,
    );
    expect(presentation.sources).toEqual([]);
  });

  it('omits card links when an exposed source becomes a Mneme test surface', () => {
    const evidenceId = seedMessage('test-surface-source', CHANNEL, 'Initially ordinary.');
    setRunProvenance('run-1', [evidenceId], [CHANNEL]);
    const proposalId = insertProposal(env.db, {
      runId: 'run-1',
      targetChannelId: REVIEW_CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      message: 'Please record the current launch status.',
      evidenceMessageIds: [evidenceId],
      now: NOW,
    });
    env.db.prepare('UPDATE channels SET name = ? WHERE id = ?').run('mneme-test', CHANNEL);

    const presentation = buildScheduledReviewPresentation(
      env.db,
      GUILD,
      getProposal(env.db, proposalId)!,
    );
    expect(presentation.sources).toEqual([]);
  });

  it('shows the recommendation reason separately from host routing metadata', () => {
    const proposalId = insertProposal(env.db, {
      runId: 'run-1',
      targetChannelId: REVIEW_CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      reviewReason: 'The launch checkpoint is overdue and still material.',
      message: 'Please record the current launch status.',
      evidenceMessageIds: [],
      now: NOW,
    });
    const presentation = buildScheduledReviewPresentation(
      env.db,
      GUILD,
      getProposal(env.db, proposalId)!,
    );
    expect(presentation.recommendationReason).toBe(
      'The launch checkpoint is overdue and still material.',
    );
    expect(presentation.reason).toBe('recommended; routed to secure review');
  });

  it('rejects a scheduled citation that is absent from durable run provenance', async () => {
    const evidenceId = seedMessage('approval-unexposed', CHANNEL, 'Current source.');
    setRunProvenance('run-1', []);
    const proposalId = insertProposal(env.db, {
      runId: 'run-1',
      targetChannelId: REVIEW_CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      message: 'Please record the current launch status.',
      evidenceMessageIds: [evidenceId],
      now: NOW,
    });

    const recheck = buildApprovalRecheck(approvalContext(), proposalId, NOW);
    expect(recheck.provenance).toEqual({
      outcome: 'reject',
      reasons: ['scheduled proposal cites evidence not exposed by the originating run'],
    });
    const result = await approveProposal({
      proposalId,
      memberRoleIds: ['admin-role'],
      adminRoleIds: ['admin-role'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck,
      now: NOW,
    }, { db: env.db });
    expect(result.outcome).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
  });

  it('re-sanitizes durable proposal text immediately before approval', async () => {
    const proposalId = seedScheduledProposal();
    // Simulate corruption or a future edit after the original host validation.
    env.db.prepare('UPDATE proposals SET message = ? WHERE id = ?')
      .run('Notify @everyone now.', proposalId);

    const recheck = buildApprovalRecheck(approvalContext(), proposalId, NOW);
    expect(recheck.outboundEvidence.outcome).toBe('reject');
    expect(recheck.outboundEvidence.reasons).toContain(
      'message contains unauthorized everyone mention(s)',
    );
    const result = await approveProposal({
      proposalId,
      memberRoleIds: ['admin-role'],
      adminRoleIds: ['admin-role'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck,
      now: NOW,
    }, { db: env.db });
    expect(result.outcome).toBe('expired');
    expect(getProposal(env.db, proposalId)!.status).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
  });

  it('blocks the newer of two pending proposals for the same scheduled subject', async () => {
    const memoryId = seedDueMemory();
    const olderId = seedScheduledSubjectProposal({
      memoryId,
      runId: 'run-1',
      now: NOW,
      message: 'Please record the first current status.',
    });
    const newerId = seedScheduledSubjectProposal({
      memoryId,
      runId: 'run-2',
      now: NOW + 1,
      message: 'Please record the second current status.',
    });
    const allowRecheck = {
      provenance: { outcome: 'allow' as const, reasons: [] },
      outboundEvidence: { outcome: 'allow' as const, reasons: [] },
      cooldown: { allowed: true, blocks: [], retryAfterMs: null },
      duplicate: { matched: false as const },
    };

    const older = await approveProposal({
      proposalId: olderId,
      memberRoleIds: ['admin-role'],
      adminRoleIds: ['admin-role'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck: allowRecheck,
      now: NOW + 2,
    }, { db: env.db });
    const newer = await approveProposal({
      proposalId: newerId,
      memberRoleIds: ['admin-role'],
      adminRoleIds: ['admin-role'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck: allowRecheck,
      now: NOW + 3,
    }, { db: env.db });

    expect(older.outcome).toBe('approved');
    expect(newer.outcome).toBe('policy_blocked');
    expect(newer.reasons).toEqual(['scheduled subject already has a delivery in progress']);
    expect(getProposal(env.db, newerId)!.status).toBe('pending_review');
    expect(getOutboxByDedupeKey(env.db, `proposal:${newerId}`)).toBeUndefined();
    const outboxCount = env.db.prepare('SELECT count(*) AS n FROM outbox').get() as { n: number };
    expect(outboxCount.n).toBe(1);
  });

  it('expires a proposal when its scheduled subject changes before approval', async () => {
    const memoryId = seedDueMemory();
    const proposalId = seedScheduledSubjectProposal({ memoryId });
    env.db.prepare('UPDATE proposals SET review_message_id = ? WHERE id = ?')
      .run('stale-review-card', proposalId);
    updateMemory(env.db, GRANT, {
      memoryId,
      statement: 'Feature X is now planned for August.',
      evidence: [],
      now: NOW + 1,
    });
    const resolutions: Array<{ label: string; removeControls: boolean }> = [];
    const result = await approveProposal({
      proposalId,
      memberRoleIds: ['admin-role'],
      adminRoleIds: ['admin-role'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck: {
        provenance: { outcome: 'allow', reasons: [] },
        outboundEvidence: { outcome: 'allow', reasons: [] },
        cooldown: { allowed: true, blocks: [], retryAfterMs: null },
        duplicate: { matched: false },
      },
      now: NOW + 2,
    }, {
      db: env.db,
      resolveReview: ({ label, removeControls }) => {
        resolutions.push({ label, removeControls });
      },
    });

    expect(result.outcome).toBe('expired');
    expect(result.reasons).toEqual(['scheduled subject changed after proposal creation']);
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
    expect(resolutions).toEqual([{
      label: '⏰ Expired: scheduled subject changed after proposal creation',
      removeControls: true,
    }]);
  });

  it('applies the shared topic cooldown to a scheduled subject at approval', () => {
    setRunProvenance('run-1', []);
    setRunProvenance('run-2', []);
    const topicKey = 'scheduled:stable-subject-key';
    const sentAt = NOW - 2 * 60 * 60_000;
    const priorId = insertProposal(env.db, {
      runId: 'run-1',
      targetChannelId: REVIEW_CHANNEL,
      status: 'sent',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      topicKey,
      message: 'Record the earlier status.',
      evidenceMessageIds: [],
      now: sentAt,
    });
    const priorOutbox = enqueueOutbox(env.db, {
      proposalId: priorId,
      runId: 'run-1',
      channelId: REVIEW_CHANNEL,
      content: 'Record the earlier status.',
      now: sentAt,
    });
    env.db.prepare(
      `UPDATE outbox
          SET status = 'sent', discord_message_id = 'sent-topic-message',
              sent_at_ms = ?, updated_at_ms = ?
        WHERE id = ?`,
    ).run(sentAt, sentAt, priorOutbox.outboxId);

    const candidateId = insertProposal(env.db, {
      runId: 'run-2',
      targetChannelId: REVIEW_CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      topicKey,
      message: 'Which current gates remain open?',
      evidenceMessageIds: [],
      expiresAtMs: NOW + DEFAULT_SCHEDULED_PROPOSAL_WINDOW_MS,
      now: NOW,
    });
    const context = approvalContext();
    context.config.intervention.channelCooldownMinutes = 1;

    const recheck = buildApprovalRecheck(context, candidateId, NOW);
    expect(recheck.cooldown.blocks.map((block) => block.rule)).toContain('topic_cooldown');
    expect(recheck.cooldown.blocks.map((block) => block.rule)).not.toContain('channel_cooldown');
  });
});

describe('scheduled-review subject reminder policy', () => {
  it.each(['sent', 'dismissed'] as const)(
    'blocks an unchanged subject after a recent %s proposal',
    (status) => {
      const memoryId = seedDueMemory();
      const priorProposalId = seedScheduledSubjectProposal({ memoryId, status });

      expect(findScheduledSubjectBlock(env.db, {
        subjects: [subjectSnapshot(memoryId)],
        now: NOW + 1_000,
        reminderIntervalMs: DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
      })).toEqual({
        blocked: true,
        reason: 'scheduled subject is inside the reminder interval',
        priorProposalId,
      });
    },
  );

  it('allows an unchanged subject when the reminder interval has elapsed', () => {
    const memoryId = seedDueMemory();
    seedScheduledSubjectProposal({ memoryId, status: 'dismissed', now: NOW });

    expect(findScheduledSubjectBlock(env.db, {
      subjects: [subjectSnapshot(memoryId)],
      now: NOW + DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
      reminderIntervalMs: DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
    })).toEqual({ blocked: false });
  });

  it('allows a recently sent subject after its durable memory changes', () => {
    const memoryId = seedDueMemory();
    seedScheduledSubjectProposal({ memoryId, status: 'sent' });
    updateMemory(env.db, GRANT, {
      memoryId,
      statement: 'Feature X is now planned for August.',
      evidence: [],
      now: NOW + 1,
    });

    expect(findScheduledSubjectBlock(env.db, {
      subjects: [subjectSnapshot(memoryId)],
      now: NOW + 2,
      reminderIntervalMs: DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
    })).toEqual({ blocked: false });
  });

  it('allows a fresh proposal after an earlier pending subject becomes stale', () => {
    const memoryId = seedDueMemory();
    seedScheduledSubjectProposal({ memoryId, status: 'pending_review' });
    updateMemory(env.db, GRANT, {
      memoryId,
      statement: 'Feature X is now planned for August.',
      evidence: [],
      now: NOW + 1,
    });

    expect(findScheduledSubjectBlock(env.db, {
      subjects: [subjectSnapshot(memoryId)],
      now: NOW + 2,
      reminderIntervalMs: DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
    })).toEqual({ blocked: false });
  });

  it('allows an unrelated subject during another subject reminder interval', () => {
    const memoryId = seedDueMemory();
    seedScheduledSubjectProposal({ memoryId, status: 'dismissed' });
    seedMessage('m-other-due', CHANNEL, 'The migration is still planned for Friday.');
    const otherMemoryId = createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'commitment',
      statement: 'The migration will run on Friday.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'm-other-due', stance: 'origin' }],
      reviewAfterMs: NOW - 500,
      now: NOW,
    });

    expect(findScheduledSubjectBlock(env.db, {
      subjects: [subjectSnapshot(otherMemoryId)],
      now: NOW + 1_000,
      reminderIntervalMs: DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
    })).toEqual({ blocked: false });
  });

  it('finds an overlapping subject after many unrelated actionable proposals', () => {
    const memoryId = seedDueMemory();
    seedMessage('m-unrelated-volume', CHANNEL, 'The unrelated task remains open.');
    const unrelatedMemoryId = createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'open_question',
      statement: 'Who owns the unrelated task?',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'm-unrelated-volume', stance: 'origin' }],
      reviewAfterMs: NOW - 500,
      now: NOW,
    });
    for (let index = 0; index < 205; index++) {
      seedScheduledSubjectProposal({
        memoryId: unrelatedMemoryId,
        runId: index % 2 === 0 ? 'run-1' : 'run-2',
        now: NOW + index,
      });
    }
    const matchingProposalId = seedScheduledSubjectProposal({
      memoryId,
      now: NOW + 300,
    });

    expect(findScheduledSubjectBlock(env.db, {
      subjects: [subjectSnapshot(memoryId)],
      now: NOW + 400,
      reminderIntervalMs: DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
    })).toEqual({
      blocked: true,
      reason: 'scheduled subject already has an actionable proposal',
      priorProposalId: matchingProposalId,
    });
  });
});

describe('createReviewDueMemoriesHandler', () => {
  it('reports nothing due when no memory is overdue', async () => {
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () => finalizeResult({ memoryProposals: [], notification: notification() }),
    });
    const out = await handler.runScheduledReview(NOW);
    expect(out.kind).toBe('nothing_due');
  });

  it('renders the real scheduled-review and system prompts with resolved target metadata', async () => {
    seedDueMemory();
    const compiler = loadPromptCompiler(promptDir);
    let captured: ExecuteAgentRunDeps | undefined;
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: compiler,
      systemPrompt: (context) => renderSystemPrompt(compiler, context),
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async (run) => {
        captured = run;
        return finalizeResult({ memoryProposals: [], notification: notification({ recommend: false }) });
      },
      now: () => NOW,
    });

    const out = await handler.runScheduledReview(NOW);

    expect(out.kind).toBe('reviewed');
    expect(captured?.promptText).toContain('We will ship feature X by July.');
    expect(captured?.promptText).toContain('Target conversation: #review');
    expect(captured?.promptText).toContain('Target visibility: review_only');
    expect(captured?.systemPrompt).not.toContain('Target conversation:');
    expect(captured?.cacheProfile).toBe('scheduled');
  });

  it('applies accepted memory updates and routes a recommended notification to secure review', async () => {
    const memId = seedDueMemory();
    const applied: AgentMemoryProposal[][] = [];
    const confirm: AgentMemoryProposal = {
      action: 'confirm',
      type: 'prediction',
      statement: 'We will ship feature X by July.',
      existingMemoryId: memId,
      confidence: 0.9,
      importance: 0.6,
      evidenceMessageIds: ['m-due'],
      evidenceQuotes: [{ messageId: 'm-due', quote: 'I predict July' }],
      durability: 'project',
      durabilityReason: 'This prediction remains relevant to future delivery work.',
    };

    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () =>
        finalizeResult({
          memoryProposals: [confirm],
          notification: notification({
            evidenceMessageIds: ['m-due', 'm-due'],
            subjectMemoryIds: [memId],
          }),
        }),
      applyMemory: (dargs: ApplyArgs, proposals) => {
        applied.push(proposals);
        return applyMemoryProposals(dargs, proposals);
      },
      now: () => NOW,
    });

    const out = await handler.runScheduledReview(NOW);
    expect(out.kind).toBe('reviewed');
    if (out.kind !== 'reviewed') return;

    // The confirm proposal reached the gate and was applied.
    expect(applied[0]).toHaveLength(1);
    expect(out.memory.applied).toHaveLength(1);
    expect(out.memory.applied[0]!.action).toBe('confirm');

    // The notification is pending_review, targeted at the review channel, never approved.
    expect(out.notification.routing.state).toBe('pending_review');
    const proposal = getProposal(env.db, out.notification.proposalId)!;
    expect(proposal.status).toBe('pending_review');
    expect(proposal.targetChannelId).toBe(REVIEW_CHANNEL);
    expect(proposal.runId).toBe('run-1');
    expect(proposal.episodeId).toBeNull();
    expect(proposal.reason).toBe('recommended; routed to secure review');
    expect(proposal.reviewReason).toBe('material and timely');
    expect(proposal.message).toBe('Please record the current launch status.');
    expect(proposal.evidenceMessageIds).toEqual(['m-due']);
    // A pending scheduled proposal carries the default review window (Section 25).
    expect(proposal.expiresAtMs).toBe(NOW + DEFAULT_SCHEDULED_PROPOSAL_WINDOW_MS);
  });

  it('observes a notification when the same run resolves its due subject', async () => {
    const memId = seedDueMemory();
    const resolution: AgentMemoryProposal = {
      action: 'resolve',
      type: 'prediction',
      statement: 'We will ship feature X by July.',
      existingMemoryId: memId,
      confidence: 0.9,
      importance: 0.6,
      evidenceMessageIds: ['m-due'],
      evidenceQuotes: [{ messageId: 'm-due', quote: 'I predict July' }],
      durability: 'project',
      durabilityReason: 'The result closes a project prediction.',
    };
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () => finalizeResult({
        memoryProposals: [resolution],
        notification: notification({ subjectMemoryIds: [memId] }),
      }),
      now: () => NOW,
    });

    const outcome = await handler.runScheduledReview(NOW);
    expect(outcome.kind).toBe('reviewed');
    if (outcome.kind !== 'reviewed') return;
    expect(outcome.memory.applied).toHaveLength(1);
    expect(getMemory(env.db, memId)?.status).toBe('resolved');
    const proposal = getProposal(env.db, outcome.notification.proposalId)!;
    expect(proposal.status).toBe('observed');
    expect(proposal.reason).toBe('notification subject is no longer due');
  });

  it('stores a paraphrased repeat for the same due memory observed', async () => {
    const memoryId = seedDueMemory();
    let execution = 0;
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () => {
        execution++;
        return finalizeResult({
          memoryProposals: [],
          notification: notification({
            message: execution === 1
              ? 'Please record the current launch status.'
              : 'Which launch gates still need work? Add the latest result.',
            subjectMemoryIds: [memoryId],
          }),
        }, [CHANNEL], ['m-due'], execution === 1 ? 'run-1' : 'run-2');
      },
      now: () => NOW,
    });

    const first = await handler.runScheduledReview(NOW);
    const second = await handler.runScheduledReview(NOW);
    expect(first.kind).toBe('reviewed');
    expect(second.kind).toBe('reviewed');
    if (first.kind !== 'reviewed' || second.kind !== 'reviewed') return;

    expect(getProposal(env.db, first.notification.proposalId)!.status).toBe('pending_review');
    const repeated = getProposal(env.db, second.notification.proposalId)!;
    expect(repeated.status).toBe('observed');
    expect(repeated.message).toBe('Which launch gates still need work? Add the latest result.');
    expect(repeated.reason).toBe('scheduled subject already has an actionable proposal');
  });

  it('stores a recommended notification with no subject observed', async () => {
    seedDueMemory();
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () => finalizeResult({
        memoryProposals: [],
        notification: notification({ subjectMemoryIds: [] }),
      }),
      now: () => NOW,
    });

    const outcome = await handler.runScheduledReview(NOW);
    expect(outcome.kind).toBe('reviewed');
    if (outcome.kind !== 'reviewed') return;
    const proposal = getProposal(env.db, outcome.notification.proposalId)!;
    expect(proposal.status).toBe('observed');
    expect(proposal.reason).toBe('notification has no due-memory subject');
  });

  it('stores a recommended notification with a non-due subject observed', async () => {
    seedDueMemory();
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () => finalizeResult({
        memoryProposals: [],
        notification: notification({ subjectMemoryIds: ['not-a-due-memory'] }),
      }),
      now: () => NOW,
    });

    const outcome = await handler.runScheduledReview(NOW);
    expect(outcome.kind).toBe('reviewed');
    if (outcome.kind !== 'reviewed') return;
    const proposal = getProposal(env.db, outcome.notification.proposalId)!;
    expect(proposal.status).toBe('observed');
    expect(proposal.reason).toBe('notification subject was not due and exposed in this run');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   \n\t  '],
  ])('stores a recommended notification with %s text observed', async (_label, message) => {
    const proposal = await persistScheduledNotification(notification({ message }));
    expect(proposal.status).toBe('observed');
    expect(proposal.message).toBeNull();
    expect(proposal.reason).toBe('notification has no sendable message text');
    expect(proposal.expiresAtMs).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   \n\t  '],
  ])('stores a recommended notification with %s reason observed', async (_label, reason) => {
    const proposal = await persistScheduledNotification(notification({ reason }));
    expect(proposal.status).toBe('observed');
    expect(proposal.message).toBe('Please record the current launch status.');
    expect(proposal.reviewReason).toBeNull();
    expect(proposal.reason).toBe('notification has no recommendation reason');
    expect(proposal.expiresAtMs).toBeNull();
    expect(proposal.reviewMessageId).toBeNull();
  });

  it.each([
    ['user', `Notify <@${ALICE}> now.`],
    ['role', 'Notify <@&100000000000000004> now.'],
    ['mass', 'Notify @everyone now.'],
  ])('stores a notification with an unauthorized %s mention observed', async (_label, message) => {
    const proposal = await persistScheduledNotification(notification({ message }));
    expect(proposal.status).toBe('observed');
    expect(proposal.message).toBeNull();
    expect(proposal.reason).toBe('notification failed outbound safety validation');
    expect(proposal.reason).not.toContain(ALICE);
    expect(proposal.expiresAtMs).toBeNull();
  });

  it('stores a notification containing a model-authored Discord jump URL observed', async () => {
    const proposal = await persistScheduledNotification(notification({
      message: `Review https://discord.com/channels/${GUILD}/${CHANNEL}/m-due`,
    }));
    expect(proposal.status).toBe('observed');
    expect(proposal.message).toBeNull();
    expect(proposal.reason).toBe('notification failed outbound safety validation');
    expect(proposal.reason).not.toContain('discord.com');
  });

  it('stores an oversized notification observed without retaining its text', async () => {
    const proposal = await persistScheduledNotification(notification({
      message: 'x'.repeat(2_001),
    }));
    expect(proposal.status).toBe('observed');
    expect(proposal.message).toBeNull();
    expect(proposal.reason).toBe('notification failed outbound safety validation');
  });

  it('keeps validated inline citation markers in the durable proposal text', async () => {
    const proposal = await persistScheduledNotification(notification({
      message: '**Launch status**\nThe launch remains blocked. [[cite:m-due]]\nWhat is the current status?',
    }));
    expect(proposal.status).toBe('pending_review');
    // Durable text carries the marker; links are host-built at delivery.
    expect(proposal.message).toContain('[[cite:m-due]]');
    expect(proposal.message).not.toContain('discord.com');
    expect(proposal.message).not.toContain('Mneme tracks decisions');
  });

  it('observes a notification whose citation marker is not validated evidence', async () => {
    const proposal = await persistScheduledNotification(notification({
      message: 'The launch remains blocked. [[cite:never-cited]]',
    }));
    expect(proposal.status).toBe('observed');
    expect(proposal.message).toBeNull();
    expect(proposal.reason).toContain('is not a validated cited source');
  });

  it('observes a notification whose rendered delivery cannot fit one message', async () => {
    seedMessage('ev-b', CHANNEL, 'supporting note b');
    seedMessage('ev-c', CHANNEL, 'supporting note c');
    const proposal = await persistScheduledNotification(
      notification({
        message: `${'x'.repeat(1_640)}[[cite:m-due]][[cite:ev-b]][[cite:ev-c]]`,
        evidenceMessageIds: ['m-due', 'ev-b', 'ev-c'],
      }),
      ['m-due', 'ev-b', 'ev-c'],
    );
    expect(proposal.status).toBe('observed');
    expect(proposal.message).toBeNull();
    expect(proposal.reason).toBe(
      'notification leaves insufficient room for validated source links and the footer',
    );
  });

  it('observes an existing citation that was never exposed by the originating run', async () => {
    const unexposedId = seedMessage('existing-but-unexposed', CHANNEL, 'Not shown to this run.');
    const proposal = await persistScheduledNotification(
      notification({ evidenceMessageIds: [unexposedId] }),
      ['m-due'],
    );
    expect(proposal.status).toBe('observed');
    expect(proposal.reason).toBe('notification evidence was not exposed by the originating run');
    expect(proposal.evidenceMessageIds).toEqual([]);
    expect(proposal.expiresAtMs).toBeNull();
  });

  it('observes run-exposed evidence that is currently on a Mneme test surface', async () => {
    const memId = seedDueMemory();
    env.db.prepare('UPDATE channels SET name = ? WHERE id = ?').run('mneme-test', CHANNEL);
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () => finalizeResult({
        memoryProposals: [],
        notification: notification({ evidenceMessageIds: ['m-due'], subjectMemoryIds: [memId] }),
      }),
      now: () => NOW,
    });

    const outcome = await handler.runScheduledReview(NOW);
    expect(outcome.kind).toBe('reviewed');
    if (outcome.kind !== 'reviewed') return;
    const proposal = getProposal(env.db, outcome.notification.proposalId)!;
    expect(proposal.status).toBe('observed');
    expect(proposal.reason).toBe('notification evidence is no longer retrievable');
    expect(proposal.evidenceMessageIds).toEqual([]);
  });

  it('stores a non-recommended notification observed and creates no review post', async () => {
    seedDueMemory();
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () =>
        finalizeResult({ memoryProposals: [], notification: notification({ recommend: false }) }),
      now: () => NOW,
    });
    const out = await handler.runScheduledReview(NOW);
    expect(out.kind).toBe('reviewed');
    if (out.kind !== 'reviewed') return;
    expect(out.notification.routing.state).toBe('observed');
    const proposal = getProposal(env.db, out.notification.proposalId)!;
    expect(proposal.status).toBe('observed');
    expect(proposal.expiresAtMs).toBeNull();
  });

  it('create no unsupported mutation: a proposal with invented evidence is rejected, not applied', async () => {
    const memId = seedDueMemory();
    const bad: AgentMemoryProposal = {
      action: 'confirm',
      type: 'prediction',
      statement: 'x',
      existingMemoryId: memId,
      confidence: 0.9,
      importance: 0.6,
      evidenceMessageIds: ['invented-message-id'],
      evidenceQuotes: [{ messageId: 'invented-message-id', quote: 'x' }],
      durability: 'project',
      durabilityReason: 'This would affect future delivery work.',
    };
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () => finalizeResult({ memoryProposals: [bad], notification: notification() }),
      now: () => NOW,
    });
    const out = await handler.runScheduledReview(NOW);
    expect(out.kind).toBe('reviewed');
    if (out.kind !== 'reviewed') return;
    expect(out.memory.applied).toHaveLength(0);
    expect(out.memory.rejected).toHaveLength(1);
    expect(out.memory.rejected[0]!.reason).toBe('invented_evidence');
    // The rejected confirm added no confirming evidence (still only the origin).
    const ev = env.db
      .prepare('SELECT count(*) AS n FROM memory_evidence WHERE memory_id = ?')
      .get(memId) as { n: number };
    expect(ev.n).toBe(1);
  });

  it('a run that does not finalize applies no memory and creates no proposal', async () => {
    seedDueMemory();
    let applyCalled = false;
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () =>
        ({ runId: 'run-2', outcome: 'no_finalization', finalProposal: null }) as unknown as AgentRunResult,
      applyMemory: () => {
        applyCalled = true;
        return { applied: [], rejected: [], total: 0 };
      },
      now: () => NOW,
    });
    const out = await handler.runScheduledReview(NOW);
    expect(out.kind).toBe('no_finalization');
    expect(applyCalled).toBe(false);
    const proposals = env.db.prepare('SELECT count(*) AS n FROM proposals').get() as { n: number };
    expect(proposals.n).toBe(0);
  });

  it('an executor throw is recorded as an error without throwing', async () => {
    seedDueMemory();
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: fakeCompiler,
      systemPrompt: 'system',
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () => {
        throw new Error('model provider down');
      },
      now: () => NOW,
    });
    const out = await handler.runScheduledReview(NOW);
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.failureReason).toContain('model provider down');
    }
    const proposals = env.db.prepare('SELECT count(*) AS n FROM proposals').get() as { n: number };
    expect(proposals.n).toBe(0);
  });

  it('records a real prompt-render failure once instead of retrying the job ten times', async () => {
    seedDueMemory();
    const compiler = loadPromptCompiler(promptDir);
    let executeCalls = 0;
    const handler = createReviewDueMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      promptCompiler: compiler,
      // Exercise a real strict system render failure on stable required context.
      systemPrompt: (context) => compiler.render('system', {
        ...context,
        agent: { name: 'Mneme', role: 'organizational memory' },
        organization: { name: 'Test Co' },
        personality: { traits: ['calm'], avoid: ['sarcasm'] },
      }),
      resolveReviewScope: reviewScope,
      mode: 'review',
      executeRun: async () => {
        executeCalls++;
        return finalizeResult({ memoryProposals: [], notification: notification() });
      },
      now: () => NOW,
    });
    const queued = enqueue(env.db, {
      type: 'review_due_memories',
      payload: { sinceMs: NOW },
      maxAttempts: 10,
      now: NOW,
    });
    const worker = new JobWorker({
      db: env.db,
      owner: 'scheduled-review-test',
      leaseMs: 60_000,
      pollIntervalMs: 1,
      shutdownTimeoutMs: 100,
      clock: () => NOW,
    });
    worker.register('review_due_memories', 1, handler);

    await worker.runOnce();

    const job = env.db.prepare(
      'SELECT status, attempts, max_attempts, last_error FROM jobs WHERE id = ?',
    ).get(queued.id) as {
      status: string;
      attempts: number;
      max_attempts: number;
      last_error: string;
    };
    expect(job).toMatchObject({ status: 'failed', attempts: 1, max_attempts: 10 });
    expect(job.last_error).toBe(SCHEDULED_REVIEW_PROMPT_PREPARATION_ERROR);
    expect(job.last_error).not.toContain('Cannot convert object to primitive value');
    expect(executeCalls).toBe(0);
    expect(worker.dispatch()).toBe(0);
    const runs = env.db.prepare('SELECT count(*) AS n FROM agent_runs').get() as { n: number };
    expect(runs.n).toBe(2);
  });
});
