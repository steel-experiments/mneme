import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fauxProvider,
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { loadPromptCompiler, type PromptCompiler } from '../../src/agent/prompts.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertUser } from '../../src/db/repositories/users.js';
import { addReaction } from '../../src/db/repositories/reactions.js';
import {
  openEpisode,
  extendEpisode,
  closeEpisode,
  getEpisode,
} from '../../src/episodes/repository.js';
import { RunRetrievalState } from '../../src/agent/run-context.js';
import type { AgentRunResult, ExecuteAgentRunDeps } from '../../src/agent/runtime.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';
import {
  createReviewEpisodeHandler,
  type ReviewEpisodeHandlerDeps,
  type AgentRuntimeInputs,
} from '../../src/jobs/handlers/review-episode.js';
import { JobWorker } from '../../src/jobs/worker.js';
import { enqueue } from '../../src/jobs/queue.js';
import { DeferJobError } from '../../src/jobs/errors.js';
import { getProposal, insertProposal } from '../../src/db/repositories/proposals.js';
import { getOutboxByDedupeKey } from '../../src/outbox/repository.js';
import { approveProposal } from '../../src/review/workflow.js';
import { createMemory } from '../../src/memory/repository.js';
import {
  buildApprovalRecheck,
  routeEpisodeIntervention,
} from '../../src/production-runtime.js';
import type { BootstrapContext } from '../../src/bootstrap.js';
import { emptyAgentRunUsage } from '../../src/agent/usage.js';

/**
 * Episode review job (Sections 11, 18, 21.4).
 *
 * Acceptance: a completed run stores prompt version, provenance, usage,
 * proposal, and episode summary; failures leave ingestion unaffected and send
 * nothing. Orchestration is driven by a stubbed executor; one end-to-end test
 * exercises the real runtime with a scripted faux stream (no network).
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded by seedIdentity (restricted)
const ALICE = '100000000000000003'; // seeded human user
const BOT = '100000000000000004';
const CASS = '999000000000000001';
const NOW = 1_700_000_001_000;
// Episode fixtures describe a conversation that already settled: the messages
// land half an hour before the review runs, and the episode closes ten minutes
// later. Reviewing a live conversation is held by the Section 11.8 settle gate,
// which the deferral tests cover explicitly.
const EPISODE_START = NOW - 30 * 60_000;
const EPISODE_END = NOW - 20 * 60_000;

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const promptDir = path.join(root, 'prompts');

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };

const dims = {
  impact: 0.5,
  evidenceStrength: 0.5,
  contradictionStrength: 0.5,
  urgency: 0.5,
  novelty: 0.5,
  interruptionCost: 0.5,
};

/** A schema-valid episode-review proposal targeting `target` (the pinned channel). */
function episodeProposal(target = CHANNEL, confidence = 0.5) {
  return {
    episodeSummary: 'We adopted the onboarding trial.',
    consequential: true,
    memoryProposals: [
      {
        action: 'create',
        type: 'decision',
        statement: 'Adopt the onboarding trial.',
        confidence: 0.8,
        importance: 0.7,
        evidenceMessageIds: ['m1'],
        evidenceQuotes: [{ messageId: 'm1', quote: 'onboarding trial' }],
        durability: 'project',
        durabilityReason: 'This changes future onboarding work.',
      },
    ],
    intervention: {
      recommend: false,
      reason: 'nothing urgent',
      dimensions: dims,
      confidence,
      urgency: 'normal',
      targetChannelId: target,
      evidenceMessageIds: ['m1'],
    },
    unresolvedQuestions: [],
  };
}

/** Build a scripted AgentRunResult (for the stubbed-executor orchestration tests). */
function runResult(over: Partial<AgentRunResult> & { runId: string }): AgentRunResult {
  return {
    status: over.outcome === 'finalized' ? 'completed' : 'failed',
    outcome: 'finalized',
    failureReason: null,
    turns: 1,
    modelTurns: [],
    toolCalls: [],
    usage: { ...emptyAgentRunUsage(), inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
    provenance: new RunRetrievalState(60_000, NOW, env.db).provenance(),
    finalProposal: { kind: 'episode_review', proposal: episodeProposal() },
    startedAtMs: NOW,
    endedAtMs: NOW,
    ...over,
  };
}

let env: TestDb;
let compiler: PromptCompiler;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  compiler = loadPromptCompiler(promptDir);
  upsertUser(env.db, {
    id: BOT,
    username: 'robo',
    globalName: 'Robo',
    isBot: true,
    firstSeenAtMs: NOW,
    lastSeenAtMs: NOW,
    rawJson: null,
  });
});
afterEach(() => env.cleanup());

function seedChannel(
  id: string,
  options: { name: string; parentId?: string | null; isThread?: boolean; guildId?: string },
): void {
  upsertChannel(env.db, {
    id,
    guildId: options.guildId ?? GUILD,
    parentId: options.parentId ?? null,
    type: options.isThread ? 11 : 0,
    name: options.name,
    topic: null,
    position: null,
    isThread: options.isThread ?? false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: 'org',
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  });
}

function insertMessage(
  id: string,
  channel: string,
  content: string,
  opts: { author?: string; mentionsJson?: string; createdAtMs?: number; guildId?: string } = {},
): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: opts.guildId ?? GUILD,
    channelId: channel,
    authorId: opts.author ?? ALICE,
    authorDisplayName: opts.author === BOT ? 'Robo' : 'Alice',
    content,
    createdAtMs: opts.createdAtMs ?? NOW,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: opts.mentionsJson ?? '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: opts.createdAtMs ?? NOW,
    updatedAtMs: opts.createdAtMs ?? NOW,
  });
}

/** Open an episode on `channel`, link `messages` in order, and close → queue it. */
function queuedEpisode(
  channel: string,
  messages: Array<{ id: string; content: string; isHuman?: boolean; author?: string }>,
): string {
  const { episode } = openEpisode(env.db, {
    guildId: GUILD,
    conversationChannelId: channel,
    now: EPISODE_START,
  });
  let t = EPISODE_START;
  for (const m of messages) {
    insertMessage(m.id, channel, m.content, { author: m.author, createdAtMs: t });
    extendEpisode(env.db, episode.id, m.id, m.isHuman ?? true, t);
    t += 1;
  }
  const id = closeEpisode(env.db, channel, EPISODE_END);
  if (!id) throw new Error('closeEpisode returned undefined');
  return id;
}

function outboxCount(): number {
  return Number(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n);
}

function episodeRunProvenance(
  messageIds: string[],
  memoryIds: string[] = [],
  memoryScopes: Array<{ scopeType: string; scopeKey: string | null; source: 'memory_search' }> = [],
) {
  return {
    channels: [{ channelId: CHANNEL, source: 'initial_payload' as const }],
    messageIds,
    messageFingerprints: [],
    memoryScopes,
    memoryIds,
    memoryFingerprints: [],
    charsExposed: 0,
    charBudget: 60_000,
  };
}

function seedEpisodeRun(
  runId: string,
  episodeId: string,
  messageIds: string[],
  memoryIds: string[] = [],
  memoryScopes: Array<{ scopeType: string; scopeKey: string | null; source: 'memory_search' }> = [],
): void {
  env.db.prepare(
    `INSERT INTO agent_runs
       (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status,
        retrieval_provenance_json, started_at_ms, ended_at_ms)
     VALUES (?, ?, ?, 'episode', 'episode@citation-test', 'faux', 'faux-1', 'completed', ?, ?, ?)`,
  ).run(
    runId,
    GUILD,
    episodeId,
    JSON.stringify(episodeRunProvenance(messageIds, memoryIds, memoryScopes)),
    NOW,
    NOW,
  );
}

function seedOrgMemory(sourceChannelId: string, sourceMessageId: string): string {
  seedChannel(sourceChannelId, { name: 'memory-source' });
  insertMessage(sourceMessageId, sourceChannelId, 'The organization adopted a shared launch policy.');
  return createMemory(env.db, ORG_GRANT, {
    guildId: GUILD,
    type: 'decision',
    statement: 'Use the shared launch policy.',
    confidence: 0.9,
    importance: 0.8,
    evidence: [{ messageId: sourceMessageId, stance: 'origin' }],
    now: NOW,
  });
}

function interventionRuntimeContext(): BootstrapContext {
  return {
    db: env.db,
    now: () => NOW,
    config: {
      workspaceId: GUILD, discord: { applicationId: CASS },
      mode: 'review',
      reviewChannelId: undefined,
      organization: { timezone: 'UTC' },
      episodes: { settleSeconds: 600, settleMaxMinutes: 60 },
      intervention: {
        threshold: 0.6,
        minConfidence: 0.6,
        minEvidenceStrength: 0.6,
        maxMessageCharacters: 1_800,
        channelCooldownMinutes: 180,
        globalDailyLimit: 5,
        attentionWindowDays: 7,
      },
    },
    logger: { warn: () => undefined },
  } as unknown as BootstrapContext;
}

function agentRunsForEpisode(episodeId: string): Array<{ status: string; prompt_version: string; final_proposal_json: string | null }> {
  return env.db
    .prepare(
      'SELECT status, prompt_version, final_proposal_json FROM agent_runs WHERE episode_id = ? ORDER BY started_at_ms',
    )
    .all(episodeId) as Array<{ status: string; prompt_version: string; final_proposal_json: string | null }>;
}

function makeDeps(over: Partial<ReviewEpisodeHandlerDeps> = {}): ReviewEpisodeHandlerDeps {
  return {
    db: env.db,
    guildId: GUILD,
    mnemeId: CASS,
    promptCompiler: compiler,
    systemPrompt: 'Mneme system prompt.',
    resolveChannelScope: () => ({
      grant: ORG_GRANT,
      target: { label: '#general', visibility: 'restricted' },
    }),
    runtimeCounters: () => ({ recentChannelPosts: 0, globalPostsToday: 0 }),
    mode: 'passive',
    interventionThreshold: 0.6,
    now: () => NOW,
    ...over,
  };
}

describe('conversation settle gate — Section 11.8', () => {
  /** Queue an episode whose conversation is still in progress at `NOW`. */
  function liveEpisode(): string {
    const { episode } = openEpisode(env.db, {
      guildId: GUILD,
      conversationChannelId: CHANNEL,
      now: NOW - 6 * 60_000,
    });
    insertMessage('m-live-1', CHANNEL, 'the new deploy started failing at random', {
      createdAtMs: NOW - 6 * 60_000,
    });
    insertMessage('m-live-2', CHANNEL, 'switching now would be risky', {
      createdAtMs: NOW - 90_000,
    });
    extendEpisode(env.db, episode.id, 'm-live-1', true, NOW - 6 * 60_000);
    extendEpisode(env.db, episode.id, 'm-live-2', true, NOW - 90_000);
    const id = closeEpisode(env.db, CHANNEL, NOW);
    if (!id) throw new Error('closeEpisode returned undefined');
    return id;
  }

  it('holds the review of a live conversation and runs it once the channel settles', async () => {
    const episodeId = liveEpisode();
    let calls = 0;
    let now = NOW;
    const handler = createReviewEpisodeHandler(makeDeps({
      now: () => now,
      settle: { settleSeconds: 600, settleMaxMinutes: 60 },
      executeRun: async () => {
        calls += 1;
        return runResult({ runId: 'run-after-settle' });
      },
    }));

    // 90 seconds of quiet is a pause, not the end of a discussion.
    const held = await handler.runReview(episodeId);
    expect(held.kind).toBe('deferred');
    expect(calls).toBe(0);
    expect(getEpisode(env.db, episodeId)?.status).toBe('queued');

    // The team keeps talking; the hold keeps holding.
    insertMessage('m-live-3', CHANNEL, 'here is the fix for the random failures', {
      createdAtMs: NOW + 60_000,
    });
    now = NOW + 120_000;
    expect((await handler.runReview(episodeId)).kind).toBe('deferred');
    expect(calls).toBe(0);

    // Ten quiet minutes after the last human message, the review runs.
    now = NOW + 60_000 + 600_000;
    const reviewed = await handler.runReview(episodeId);
    expect(reviewed.kind).toBe('reviewed');
    expect(calls).toBe(1);
    expect(getEpisode(env.db, episodeId)?.status).toBe('reviewed');
  });

  it('gives the held review the later human messages the boundary could not see', async () => {
    const episodeId = liveEpisode();
    insertMessage('m-live-3', CHANNEL, 'here is the fix for the random failures', {
      createdAtMs: NOW + 60_000,
    });
    let prompt = '';
    const handler = createReviewEpisodeHandler(makeDeps({
      now: () => NOW + 60_000 + 600_000,
      settle: { settleSeconds: 600, settleMaxMinutes: 60 },
      executeRun: async (deps) => {
        prompt = deps.promptText;
        return runResult({ runId: 'run-with-followups' });
      },
    }));
    expect((await handler.runReview(episodeId)).kind).toBe('reviewed');
    expect(prompt).toContain('here is the fix for the random failures');
  });

  it('defers the durable job without consuming a retry attempt', async () => {
    const episodeId = liveEpisode();
    let now = NOW;
    const handler = createReviewEpisodeHandler(makeDeps({
      now: () => now,
      settle: { settleSeconds: 600, settleMaxMinutes: 60 },
      executeRun: async () => runResult({ runId: 'run-after-settle' }),
    }));
    enqueue(env.db, { type: 'review_episode', payload: { episodeId },
      uniqueKey: `episode:review:${episodeId}`, now });
    const worker = new JobWorker({ db: env.db, owner: 'test', leaseMs: 60_000,
      pollIntervalMs: 1, shutdownTimeoutMs: 100, clock: () => now });
    worker.register('review_episode', 1, handler);

    await worker.runOnce();
    const job = env.db.prepare(
      "SELECT status, attempts, run_after_ms FROM jobs WHERE type='review_episode'",
    ).get() as { status: string; attempts: number; run_after_ms: number };
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    // Retried at the settle deadline of the last human message, not immediately.
    expect(job.run_after_ms).toBe(NOW - 90_000 + 600_000);
    expect(getEpisode(env.db, episodeId)?.status).toBe('queued');

    now = NOW - 90_000 + 600_000;
    await worker.runOnce();
    expect(getEpisode(env.db, episodeId)?.status).toBe('reviewed');
  });

  it('reviews a conversation that never settles once the hold bound is reached', async () => {
    const episodeId = liveEpisode();
    insertMessage('m-live-busy', CHANNEL, 'still going', { createdAtMs: NOW + 59 * 60_000 });
    let calls = 0;
    const handler = createReviewEpisodeHandler(makeDeps({
      now: () => NOW + 61 * 60_000,
      settle: { settleSeconds: 600, settleMaxMinutes: 60 },
      executeRun: async () => {
        calls += 1;
        return runResult({ runId: 'run-at-bound' });
      },
    }));
    // Memory extraction is never blocked by a channel that stays busy; the
    // routing gate is what keeps a forced review from speaking.
    expect((await handler.runReview(episodeId)).kind).toBe('reviewed');
    expect(calls).toBe(1);
  });
});

describe('review_episode — orchestration (stubbed executor)', () => {
  it('includes bounded delayed human follow-ups and excludes bot follow-ups', async () => {
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm-request', content: 'Can someone update the DNS record?' },
      { id: 'm-context', content: 'This blocks the release.' },
    ]);
    insertMessage('m-bot-followup', CHANNEL, 'automated status', { author: BOT, createdAtMs: NOW + 60_000 });
    for (let index = 0; index < 30; index += 1) {
      insertMessage(`m-noise-${index}`, CHANNEL, `unrelated discussion ${index}`, {
        createdAtMs: NOW + 2 * 60_000 + index,
      });
    }
    insertMessage('m-done', CHANNEL, 'done, DNS is updated', { createdAtMs: NOW + 2 * 60 * 60_000 });
    let captured: ExecuteAgentRunDeps | undefined;
    const handler = createReviewEpisodeHandler(makeDeps({
      now: () => NOW + 3 * 60 * 60_000,
      memoryFollowupHorizonDays: 7,
      memoryFollowupMaxMessages: 5,
      executeRun: async (runDeps) => {
        captured = runDeps;
        return runResult({ runId: 'run-followup', finalProposal: {
          kind: 'episode_review', proposal: { ...episodeProposal(CHANNEL), memoryProposals: [] },
        } });
      },
    }));
    const out = await handler.runReview(episodeId);
    expect(out.kind).toBe('reviewed');
    expect(captured?.promptText).toContain('done, DNS is updated');
    expect(captured?.cacheProfile).toBe('episode');
    expect(captured?.sessionId).toBe(`mneme:episode:${episodeId}`);
    expect(captured?.promptText).not.toContain('automated status');
    expect(captured?.initialProvenanceMessages?.map((message) => message.messageId)).toContain('m-done');
  });
  it('reports missing when the episode does not exist', async () => {
    const handler = createReviewEpisodeHandler(
      makeDeps({ executeRun: async () => runResult({ runId: 'r' }) }),
    );
    const out = await handler.runReview('nope');
    expect(out.kind).toBe('missing');
    expect(outboxCount()).toBe(0);
  });

  it('is a no-op when the episode is not queued (already reviewed)', async () => {
    const episodeId = queuedEpisode(CHANNEL, [{ id: 'm1', content: 'we decided to ship it' }]);
    // Manually mark it reviewed so it is no longer queued.
    const get = getEpisode(env.db, episodeId)!;
    env.db.prepare("UPDATE episodes SET status='reviewing' WHERE id=?").run(episodeId);
    env.db
      .prepare(
        "UPDATE episodes SET status='reviewed', summary='x', consequential=0, intervention_score=0.1 WHERE id=?",
      )
      .run(episodeId);
    void get;

    let calls = 0;
    const handler = createReviewEpisodeHandler(
      makeDeps({ executeRun: async () => (calls++, runResult({ runId: 'r' })) }),
    );
    const out = await handler.runReview(episodeId);
    expect(out.kind).toBe('not_queued');
    expect(calls).toBe(0); // the run never executed
  });

  it('skips a queued thread episode when its parent is renamed as a Mneme test surface', async () => {
    const parentId = '100000000000000020';
    const threadId = '100000000000000021';
    seedChannel(parentId, { name: 'project-history' });
    seedChannel(threadId, { name: 'release-planning', parentId, isThread: true });
    const episodeId = queuedEpisode(threadId, [
      { id: 'm-test-surface-1', content: 'We decided to keep this test-only.' },
      { id: 'm-test-surface-2', content: 'Agreed, do not extract it.' },
    ]);
    env.db.prepare('UPDATE channels SET name=?,updated_at_ms=? WHERE id=?')
      .run('mneme-project-history', NOW + 1, parentId);
    let calls = 0;
    const handler = createReviewEpisodeHandler(makeDeps({
      now: () => NOW + 1,
      executeRun: async () => (calls += 1, runResult({ runId: 'never-runs' })),
    }));

    const out = await handler.runReview(episodeId);

    expect(out).toMatchObject({ kind: 'skipped', reason: 'test_surface', episodeId });
    expect(calls).toBe(0);
    expect(getEpisode(env.db, episodeId)?.status).toBe('skipped');
    expect(agentRunsForEpisode(episodeId)).toHaveLength(0);
  });

  it('discards an in-flight review result when the thread parent becomes a test surface', async () => {
    const parentId = '100000000000000022';
    const threadId = '100000000000000023';
    seedChannel(parentId, { name: 'project-history' });
    seedChannel(threadId, { name: 'release-planning', parentId, isThread: true });
    const episodeId = queuedEpisode(threadId, [
      { id: 'm1', content: 'We decided to keep this test-only.' },
      { id: 'm2', content: 'Agreed, do not extract it.' },
    ]);
    const handler = createReviewEpisodeHandler(makeDeps({
      now: () => NOW + 1,
      executeRun: async () => {
        env.db.prepare('UPDATE channels SET name=?,updated_at_ms=? WHERE id=?')
          .run('mneme-project-history', NOW + 1, parentId);
        return runResult({
          runId: 'discarded-test-surface-run',
          finalProposal: { kind: 'episode_review', proposal: episodeProposal(threadId) },
        });
      },
    }));

    const out = await handler.runReview(episodeId);

    expect(out).toMatchObject({ kind: 'skipped', reason: 'test_surface', episodeId });
    expect(getEpisode(env.db, episodeId)?.status).toBe('skipped');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 0 });
  });

  it('skips a trivial episode via the pre-filter without a model call', async () => {
    const episodeId = queuedEpisode(CHANNEL, [{ id: 'm1', content: 'ok' }]); // one short human msg
    let calls = 0;
    const handler = createReviewEpisodeHandler(
      makeDeps({ executeRun: async () => (calls++, runResult({ runId: 'r' })) }),
    );
    const out = await handler.runReview(episodeId);
    expect(out.kind).toBe('skipped');
    expect(calls).toBe(0);
    expect(getEpisode(env.db, episodeId)?.status).toBe('skipped');
    expect(agentRunsForEpisode(episodeId)).toHaveLength(0); // no model run recorded
    expect(outboxCount()).toBe(0);
  });

  it('reviews and persists the proposal outcome on a finalized run', async () => {
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: 'we decided to adopt the trial' },
      { id: 'm2', content: 'agreed, ship it friday' },
    ]);
    const handler = createReviewEpisodeHandler(
      makeDeps({
        executeRun: async () =>
          runResult({
            runId: 'run-finalized',
            finalProposal: { kind: 'episode_review', proposal: episodeProposal(CHANNEL, 0.42) },
          }),
      }),
    );
    const out = await handler.runReview(episodeId);
    expect(out.kind).toBe('reviewed');
    if (out.kind !== 'reviewed') throw new Error('unreachable');

    const ep = getEpisode(env.db, episodeId)!;
    expect(ep.status).toBe('reviewed');
    expect(ep.summary).toBe('We adopted the onboarding trial.');
    expect(ep.consequential).toBe(1);
    expect(ep.intervention_score).toBe(0.375);
    expect(ep.reviewed_at_ms).toBe(NOW);

    // Usage from the run is surfaced to the caller.
    expect(out.usage.inputTokens).toBe(10);
    expect(out.usage.outputTokens).toBe(20);
    // Nothing was sent.
    expect(outboxCount()).toBe(0);
  });

  it('returns a deferred episode to queued before the worker retries it', async () => {
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: 'we decided to adopt the trial' },
      { id: 'm2', content: 'agreed, ship it friday' },
    ]);
    let defer = true;
    let now = NOW;
    const handler = createReviewEpisodeHandler(makeDeps({
      now: () => now,
      executeRun: async () => {
        if (defer) throw new DeferJobError('budget gate', 1);
        return runResult({ runId: 'run-after-defer' });
      },
    }));
    enqueue(env.db, { type: 'review_episode', payload: { episodeId },
      uniqueKey: `episode:review:${episodeId}`, now });
    const worker = new JobWorker({ db: env.db, owner: 'test', leaseMs: 60_000,
      pollIntervalMs: 1, shutdownTimeoutMs: 100, clock: () => now });
    worker.register('review_episode', 1, handler);

    await worker.runOnce();
    expect(getEpisode(env.db, episodeId)?.status).toBe('queued');
    defer = false;
    now += 1;
    await worker.runOnce();
    expect(getEpisode(env.db, episodeId)?.status).toBe('reviewed');
  });

  it('does not mark an episode reviewed when host-side routing fails', async () => {
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1-route-failure', content: 'we decided to adopt the trial' },
      { id: 'm2-route-failure', content: 'agreed, ship it friday' },
    ]);
    const handler = createReviewEpisodeHandler(makeDeps({
      executeRun: async () => runResult({
        runId: 'run-route-failure',
        finalProposal: { kind: 'episode_review', proposal: episodeProposal(CHANNEL, 0.42) },
      }),
      routeIntervention: async () => { throw new Error('proposal persistence failed'); },
    }));

    const out = await handler.runReview(episodeId);
    expect(out.kind).toBe('error');
    expect(getEpisode(env.db, episodeId)?.status).toBe('error');
    expect(outboxCount()).toBe(0);
  });

  it('marks the episode error and sends nothing on a timeout (aborted)', async () => {
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: 'we decided x' },
      { id: 'm2', content: 'second message here' },
    ]);
    const handler = createReviewEpisodeHandler(
      makeDeps({
        executeRun: async () =>
          runResult({
            runId: 'run-timeout',
            outcome: 'aborted',
            failureReason: 'wall-clock timeout exceeded',
            finalProposal: null,
          }),
      }),
    );
    const out = await handler.runReview(episodeId);
    expect(out.kind).toBe('error');
    expect(getEpisode(env.db, episodeId)?.status).toBe('error');
    expect(outboxCount()).toBe(0);
    // Ingestion is untouched: messages remain present and undeleted.
    const remaining = env.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE deleted_at_ms IS NULL')
      .get().n;
    expect(remaining).toBe(2);
  });

  it('marks error on budget_exceeded, no_finalization (validation rejection), and blocked', async () => {
    const outcomes = ['budget_exceeded', 'no_finalization', 'blocked'] as const;
    for (const outcome of outcomes) {
      const episodeId = queuedEpisode(CHANNEL, [
        { id: `m1-${outcome}`, content: 'we decided a' },
        { id: `m2-${outcome}`, content: 'second human message' },
      ]);
      const handler = createReviewEpisodeHandler(
        makeDeps({
          executeRun: async () =>
            runResult({ runId: `r-${outcome}`, outcome, failureReason: outcome, finalProposal: null }),
        }),
      );
      const out = await handler.runReview(episodeId);
      expect(out.kind).toBe('error');
      expect(getEpisode(env.db, episodeId)?.status).toBe('error');
    }
    expect(outboxCount()).toBe(0);
  });

  it('marks error and never throws when the executor itself throws', async () => {
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: 'we decided x' },
      { id: 'm2', content: 'another message' },
    ]);
    const handler = createReviewEpisodeHandler(
      makeDeps({ executeRun: async () => {
        throw new Error('provider connection refused');
      } }),
    );
    const out = await handler.runReview(episodeId);
    expect(out.kind).toBe('error');
    expect(getEpisode(env.db, episodeId)?.status).toBe('error');
    expect(outboxCount()).toBe(0);
  });

  it('the pre-filter never skips a Mneme mention', async () => {
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: `<@${CASS}> what do you think?` }, // single message, but mentions Mneme
    ]);
    let calls = 0;
    const handler = createReviewEpisodeHandler(
      makeDeps({ executeRun: async () => (calls++, runResult({ runId: 'r' })) }),
    );
    const out = await handler.runReview(episodeId);
    expect(out.kind).toBe('reviewed'); // mention forced a review
    expect(calls).toBe(1);
  });

  it('a reaction burst forces a review even for a single short message', async () => {
    const episodeId = queuedEpisode(CHANNEL, [{ id: 'm1', content: 'lol' }]);
    // Add a reaction burst (3 of the same emoji) on m1. Each reactor must exist.
    for (let i = 0; i < 3; i++) {
      upsertUser(env.db, {
        id: `u${i}`,
        username: `u${i}`,
        globalName: `U${i}`,
        isBot: false,
        firstSeenAtMs: NOW,
        lastSeenAtMs: NOW,
        rawJson: null,
      });
      addReaction(env.db, { messageId: 'm1', userId: `u${i}`, emojiKey: '👍', observedAtMs: NOW });
    }
    let calls = 0;
    const handler = createReviewEpisodeHandler(
      makeDeps({ executeRun: async () => (calls++, runResult({ runId: 'r' })) }),
    );
    const out = await handler.runReview(episodeId);
    expect(out.kind).toBe('reviewed');
    expect(calls).toBe(1);
  });
});

describe('episode intervention citation exposure', () => {
  // Rechecks below still assert the specific provenance failure. Manually
  // inserted proposals without a claim also expire as legacy attention records.
  beforeEach(() => {
    env.db.prepare('UPDATE channels SET allow_interventions = 1 WHERE id = ?').run(CHANNEL);
  });

  it('stores an unexposed but current citation observed without review or outbox delivery', async () => {
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm-exposed', content: 'This message was exposed to the run.' },
      { id: 'm-unexposed', content: 'This current message was not exposed.' },
    ]);
    const runId = 'run-unexposed-creation';
    seedEpisodeRun(runId, episodeId, ['m-exposed']);
    const result = runResult({
      runId,
      provenance: episodeRunProvenance(['m-exposed']),
    });
    const proposal = {
      ...episodeProposal(CHANNEL, 1),
      intervention: {
        recommend: true,
        reason: 'A material conflict should be surfaced.',
        dimensions: { ...dims, impact: 1, evidenceStrength: 1, interruptionCost: 0 },
        confidence: 1,
        urgency: 'normal' as const,
        targetChannelId: CHANNEL,
        evidenceMessageIds: ['m-unexposed', 'm-unexposed'],
        message: 'Please reconcile this decision before proceeding.',
      },
    };

    const proposalId = await routeEpisodeIntervention(
      interventionRuntimeContext(),
      {} as never,
      'test-secret',
      {
        proposal,
        result,
        episode: getEpisode(env.db, episodeId)!,
        scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'restricted' } },
        now: NOW,
      },
    );

    expect(proposalId).toBeTruthy();
    const stored = getProposal(env.db, proposalId!);
    expect(stored?.status).toBe('observed');
    expect(stored?.reason).toBe(
      'episode proposal cites evidence not exposed by the originating run',
    );
    expect(stored?.evidenceMessageIds).toEqual(['m-unexposed']);
    expect(stored?.reviewMessageId).toBeNull();
    expect(outboxCount()).toBe(0);
  });

  it('blocks approval when a pending episode proposal cites an unexposed current message', async () => {
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm-approval-exposed', content: 'This message was exposed.' },
      { id: 'm-approval-unexposed', content: 'This current message was not exposed.' },
    ]);
    const runId = 'run-unexposed-approval';
    seedEpisodeRun(runId, episodeId, ['m-approval-exposed']);
    const proposalId = insertProposal(env.db, {
      runId,
      episodeId,
      targetChannelId: CHANNEL,
      status: 'pending_review',
      computedScore: 0.9,
      reason: ['eligible; review mode'],
      message: 'Please reconcile this decision before proceeding.',
      evidenceMessageIds: ['m-approval-unexposed'],
      expiresAtMs: NOW + 60_000,
      now: NOW,
    });

    const recheck = buildApprovalRecheck(interventionRuntimeContext(), proposalId, NOW);
    expect(recheck.provenance).toEqual({
      outcome: 'reject',
      reasons: ['episode proposal cites evidence not exposed by the originating run'],
    });
    expect(recheck.outboundEvidence.outcome).toBe('allow');

    const resolution = await approveProposal({
      proposalId,
      memberRoleIds: ['admin'],
      adminRoleIds: ['admin'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck,
      now: NOW,
    }, { db: env.db });

    expect(resolution.outcome).toBe('expired');
    expect(getProposal(env.db, proposalId)?.status).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
    expect(outboxCount()).toBe(0);
  });

  it.each([
    ['restricted', 'visibility'] as const,
    ['review_only', 'visibility'] as const,
    ['review_only', 'test_surface'] as const,
  ])(
    'recomputes an exposed org memory as %s at proposal creation (%s)',
    async (expectedScope, mutation) => {
      const suffix = mutation === 'test_surface' ? 'test' : expectedScope;
      const sourceChannelId = `memory-source-${suffix}`;
      const memoryId = seedOrgMemory(sourceChannelId, `memory-message-${suffix}`);
      if (mutation === 'test_surface') {
        env.db.prepare('UPDATE channels SET name = ? WHERE id = ?')
          .run('mneme-memory-source', sourceChannelId);
      } else {
        env.db.prepare('UPDATE channels SET visibility_class = ? WHERE id = ?')
          .run(expectedScope, sourceChannelId);
      }

      const evidenceId = `m-current-memory-${suffix}`;
      const episodeId = queuedEpisode(CHANNEL, [
        { id: evidenceId, content: 'Please reconcile the current launch decision.' },
      ]);
      const runId = `run-current-memory-${suffix}`;
      const cachedScopes = [{
        scopeType: 'org',
        scopeKey: null,
        source: 'memory_search' as const,
      }];
      seedEpisodeRun(runId, episodeId, [evidenceId], [memoryId], cachedScopes);
      const result = runResult({
        runId,
        provenance: episodeRunProvenance([evidenceId], [memoryId], cachedScopes),
      });
      const proposal = {
        ...episodeProposal(CHANNEL, 1),
        intervention: {
          recommend: true,
          reason: 'A material conflict should be surfaced.',
          dimensions: { ...dims, impact: 1, evidenceStrength: 1, interruptionCost: 0 },
          confidence: 1,
          urgency: 'normal' as const,
          targetChannelId: CHANNEL,
          evidenceMessageIds: [evidenceId],
          message: 'Please reconcile this decision before proceeding.',
          subject: { kind: 'existing_memory', memoryId },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: evidenceId, quote: 'Please reconcile the current launch decision.' }],
            relation: 'contradiction',
            materialChange: 'The current episode contradicts the stored launch decision.',
          },
        },
      };

      const proposalId = await routeEpisodeIntervention(
        interventionRuntimeContext(),
        {} as never,
        'test-secret',
        {
          proposal,
          result,
          episode: getEpisode(env.db, episodeId)!,
          scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'restricted' } },
          now: NOW,
          memoryOutcome: { applied: [], rejected: [], total: 0 },
          episodeMessageIds: new Set([evidenceId]),
        },
      );

      const stored = getProposal(env.db, proposalId!);
      expect(stored?.status).toBe('pending_review');
      expect(stored?.reason).toContain(`retrieved memory scope "${expectedScope}`);
      expect(outboxCount()).toBe(0);
    },
  );

  // Inline citation rendering on episode interventions (Section 24.5): the
  // host replaces validated [[cite:<id>]] markers with descriptive links beside
  // their claims, keeps one compact Sources line for markerless legacy
  // proposals, and fails closed on an invalid marker or an assembled overflow.
  const maskedEpisodeLink = (messageId: string) =>
    `[#general · 2023-11-14](https://discord.com/channels/${GUILD}/${CHANNEL}/${messageId})`;

  function seedInlineInterventionCase(suffix: string, evidenceContents: string[]) {
    const evidenceIds = evidenceContents.map((content, index) => `m-inline-${suffix}-${index}`);
    const episodeId = queuedEpisode(CHANNEL, evidenceContents.map((content, index) => ({
      id: evidenceIds[index]!, content,
    })));
    const memoryId = seedOrgMemory(`memory-source-${suffix}`, `memory-message-${suffix}`);
    const runId = `run-inline-${suffix}`;
    const cachedScopes = [{
      scopeType: 'org',
      scopeKey: null,
      source: 'memory_search' as const,
    }];
    seedEpisodeRun(runId, episodeId, evidenceIds, [memoryId], cachedScopes);
    return {
      evidenceIds,
      result: runResult({
        runId,
        provenance: episodeRunProvenance(evidenceIds, [memoryId], cachedScopes),
      }),
      episode: getEpisode(env.db, episodeId)!,
      proposal: (message: string, interventionEvidenceIds: string[]) => ({
        ...episodeProposal(CHANNEL, 1),
        intervention: {
          recommend: true,
          reason: 'A material conflict should be surfaced.',
          dimensions: { ...dims, impact: 1, evidenceStrength: 1, interruptionCost: 0 },
          confidence: 1,
          urgency: 'normal' as const,
          targetChannelId: CHANNEL,
          evidenceMessageIds: interventionEvidenceIds,
          message,
          subject: { kind: 'existing_memory', memoryId },
          trigger: {
            kind: 'new_human_evidence',
            evidence: [{ messageId: evidenceIds[0]!, quote: evidenceContents[0]! }],
            relation: 'contradiction',
            materialChange: 'The current episode contradicts the stored launch decision.',
          },
        },
      }),
    };
  }

  async function routeInlineCase(
    seed: ReturnType<typeof seedInlineInterventionCase>,
    message: string,
    interventionEvidenceIds: string[],
    context: BootstrapContext = interventionRuntimeContext(),
    client: unknown = {},
  ): Promise<string | undefined> {
    return routeEpisodeIntervention(context, client as never, 'test-secret', {
      proposal: seed.proposal(message, interventionEvidenceIds),
      result: seed.result,
      episode: seed.episode,
      scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'restricted' } },
      now: NOW,
      memoryOutcome: { applied: [], rejected: [], total: 0 },
      episodeMessageIds: new Set(seed.evidenceIds),
    });
  }

  function storedDecision(proposalId: string | undefined) {
    const stored = getProposal(env.db, proposalId!);
    expect(stored).toBeDefined();
    const decision = (stored!.policyDecision ?? {}) as {
      outboundSafety?: { outcome: string; reasons: string[] };
    };
    return { stored: stored!, decision };
  }

  it('renders two validated episode citations inline beside their claims', async () => {
    const seed = seedInlineInterventionCase('inline', [
      'We changed the launch owner.',
      'The stored owner record is stale.',
    ]);
    const proposalId = await routeInlineCase(
      seed,
      `The launch owner changed [[cite:${seed.evidenceIds[0]}]], so the stored record is stale [[cite:${seed.evidenceIds[1]}]].`,
      seed.evidenceIds,
    );

    const { stored } = storedDecision(proposalId);
    expect(stored.status).toBe('pending_review');
    expect(stored.message).toBe(
      `The launch owner changed ${maskedEpisodeLink(seed.evidenceIds[0])}, `
      + `so the stored record is stale ${maskedEpisodeLink(seed.evidenceIds[1])}.`,
    );
    expect(stored.message).not.toContain('[[cite:');
    expect(stored.message).not.toContain('[source]');
    expect(outboxCount()).toBe(0);
  });

  it('keeps a markerless episode intervention on one compact Sources line', async () => {
    const seed = seedInlineInterventionCase('fallback', [
      'We changed the launch owner.',
      'The stored owner record is stale.',
    ]);
    const message = 'The launch owner changed, so the stored record is stale.';
    const proposalId = await routeInlineCase(seed, message, seed.evidenceIds);

    const { stored } = storedDecision(proposalId);
    expect(stored.status).toBe('pending_review');
    expect(stored.message).toBe(
      `${message}\n\nSources: ${maskedEpisodeLink(seed.evidenceIds[0])} · ${maskedEpisodeLink(seed.evidenceIds[1])}`,
    );
    expect(outboxCount()).toBe(0);
  });

  async function expectMarkerRejection(message: string, expectedReason: string) {
    const seed = seedInlineInterventionCase('marker', ['We changed the launch owner.']);
    const proposalId = await routeInlineCase(seed, message, seed.evidenceIds);

    const { stored, decision } = storedDecision(proposalId);
    expect(stored.status).toBe('observed');
    expect(getOutboxByDedupeKey(env.db, `proposal:${stored.id}`)).toBeUndefined();
    expect(outboxCount()).toBe(0);
    expect(decision.outboundSafety?.outcome).toBe('reject');
    expect(decision.outboundSafety?.reasons.join('\n')).toContain(expectedReason);
    expect(stored.reason).toContain(expectedReason);
  }

  it('fails closed when a message uses more than three inline citation markers', async () => {
    const seed = seedInlineInterventionCase('marker-cap', [
      'We changed the launch owner.',
      'The stored owner record is stale.',
    ]);
    const proposalId = await routeInlineCase(
      seed,
      `One [[cite:${seed.evidenceIds[0]}]] two [[cite:${seed.evidenceIds[1]}]] `
      + `three [[cite:${seed.evidenceIds[0]}]] four [[cite:${seed.evidenceIds[1]}]].`,
      seed.evidenceIds,
    );

    const { stored, decision } = storedDecision(proposalId);
    expect(stored.status).toBe('observed');
    expect(outboxCount()).toBe(0);
    expect(decision.outboundSafety?.reasons.join('\n'))
      .toContain('more than three inline citation markers');
    expect(stored.reason).toContain('more than three inline citation markers');
  });

  it('fails closed when an inline citation marker is unknown', async () => {
    await expectMarkerRejection(
      'The stored record is stale [[cite:m-inline-unknown-marker]].',
      'is not a validated cited source',
    );
  });

  it('fails closed when an inline citation marker is malformed', async () => {
    await expectMarkerRejection(
      'The stored record is stale [[cite:broken-marker.',
      'malformed inline citation marker',
    );
  });

  it('fails closed when inserted source links push the assembled intervention past one Discord message', async () => {
    const seed = seedInlineInterventionCase('overflow', [
      'We changed the launch owner.',
      'The stored owner record is stale.',
      'The launch checklist was replaced.',
    ]);
    const proposalId = await routeInlineCase(seed, 'A'.repeat(1_800), seed.evidenceIds);

    const { stored, decision } = storedDecision(proposalId);
    expect(stored.status).toBe('observed');
    expect(stored.message).toBeNull();
    expect(outboxCount()).toBe(0);
    expect(decision.outboundSafety?.reasons.join('\n'))
      .toContain('insufficient room for validated source links');
  });

  it('quotes the exact assembled deliverable on the pending-review card', async () => {
    const seed = seedInlineInterventionCase('card', [
      'We changed the launch owner.',
      'The stored owner record is stale.',
    ]);
    const message = 'The launch owner changed, so the stored record is stale.';
    const assembled = `${message}\n\nSources: ${maskedEpisodeLink(seed.evidenceIds[0])} · ${maskedEpisodeLink(seed.evidenceIds[1])}`;
    const sent: string[] = [];
    const stubClient = {
      channels: {
        fetch: async () => ({
          isSendable: () => true,
          send: async (payload: { embeds: Array<{ toJSON: () => { description?: string } }> }) => {
            sent.push(payload.embeds[0]!.toJSON().description ?? '');
            return { id: 'review-message-card' };
          },
        }),
      },
    };
    const context = interventionRuntimeContext();
    context.config.reviewChannelId = '100000000000000099';
    const proposalId = await routeInlineCase(seed, message, seed.evidenceIds, context, stubClient);

    const { stored } = storedDecision(proposalId);
    expect(stored.status).toBe('pending_review');
    expect(stored.message).toBe(assembled);
    // The card quotes the exact assembled text — the compact Sources line sits
    // inside the quoted message, and no separate per-link block follows it.
    expect(sent).toHaveLength(1);
    const quoted = assembled.split('\n').map((line) => (line.length === 0 ? '>' : `> ${line}`)).join('\n');
    expect(sent[0]).toContain(quoted);
    expect(sent[0]).not.toMatch(/\nSources:\n- \[/);
  });

  it('autonomously enqueues the exact assembled text stored on the proposal', async () => {
    const seed = seedInlineInterventionCase('auto', ['We changed the launch owner.']);
    const context = interventionRuntimeContext();
    context.config.mode = 'autonomous';
    const proposalId = await routeInlineCase(
      seed,
      `The launch owner changed [[cite:${seed.evidenceIds[0]}]].`,
      seed.evidenceIds,
      context,
    );

    const { stored } = storedDecision(proposalId);
    const expected = `The launch owner changed ${maskedEpisodeLink(seed.evidenceIds[0])}.`;
    expect(stored.status).toBe('approved');
    expect(stored.message).toBe(expected);
    const outbox = getOutboxByDedupeKey(env.db, `proposal:${stored.id}`);
    expect(outbox?.content).toBe(expected);
    expect(outboxCount()).toBe(1);
  });

  it.each([
    ['restricted', 'visibility'] as const,
    ['review_only', 'visibility'] as const,
    ['review_only', 'test_surface'] as const,
  ])(
    'blocks approval after an exposed org memory tightens to %s (%s)',
    async (expectedScope, mutation) => {
      const suffix = mutation === 'test_surface' ? 'approval-test' : `approval-${expectedScope}`;
      const sourceChannelId = `memory-source-${suffix}`;
      const memoryId = seedOrgMemory(sourceChannelId, `memory-message-${suffix}`);
      const evidenceId = `m-${suffix}`;
      const episodeId = queuedEpisode(CHANNEL, [
        { id: evidenceId, content: 'The intervention has current evidence.' },
      ]);
      const runId = `run-${suffix}`;
      const cachedScopes = [{
        scopeType: 'org',
        scopeKey: null,
        source: 'memory_search' as const,
      }];
      seedEpisodeRun(runId, episodeId, [evidenceId], [memoryId], cachedScopes);
      const proposalId = insertProposal(env.db, {
        runId,
        episodeId,
        targetChannelId: CHANNEL,
        status: 'pending_review',
        computedScore: 0.9,
        reason: ['eligible; review mode'],
        message: 'Please reconcile this decision before proceeding.',
        evidenceMessageIds: [evidenceId],
        expiresAtMs: NOW + 60_000,
        now: NOW,
      });

      if (mutation === 'test_surface') {
        env.db.prepare('UPDATE channels SET name = ? WHERE id = ?')
          .run('mneme-memory-source', sourceChannelId);
      } else {
        env.db.prepare('UPDATE channels SET visibility_class = ? WHERE id = ?')
          .run(expectedScope, sourceChannelId);
      }

      const recheck = buildApprovalRecheck(interventionRuntimeContext(), proposalId, NOW);
      expect(recheck.provenance.outcome).toBe('force_review');
      expect(recheck.provenance.reasons[0]).toContain(`retrieved memory scope "${expectedScope}`);
      const resolution = await approveProposal({
        proposalId,
        memberRoleIds: ['admin'],
        adminRoleIds: ['admin'],
        actorUserId: ALICE,
        guildId: GUILD,
        recheck,
        now: NOW,
      }, { db: env.db });

      expect(resolution.outcome).toBe('expired');
      expect(getProposal(env.db, proposalId)?.status).toBe('expired');
      expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
      expect(outboxCount()).toBe(0);
    },
  );

  it('fails closed when stored memory scopes do not identify exact exposed memory rows', async () => {
    const evidenceId = 'm-memory-provenance-missing-ids';
    const episodeId = queuedEpisode(CHANNEL, [
      { id: evidenceId, content: 'The intervention has current evidence.' },
    ]);
    const runId = 'run-memory-provenance-missing-ids';
    const cachedScopes = [{
      scopeType: 'org',
      scopeKey: null,
      source: 'memory_search' as const,
    }];
    seedEpisodeRun(runId, episodeId, [evidenceId], [], cachedScopes);
    const proposalId = insertProposal(env.db, {
      runId,
      episodeId,
      targetChannelId: CHANNEL,
      status: 'pending_review',
      computedScore: 0.9,
      reason: ['eligible; review mode'],
      message: 'Please reconcile this decision before proceeding.',
      evidenceMessageIds: [evidenceId],
      expiresAtMs: NOW + 60_000,
      now: NOW,
    });

    const recheck = buildApprovalRecheck(interventionRuntimeContext(), proposalId, NOW);
    expect(recheck.provenance).toEqual({
      outcome: 'reject',
      reasons: ['memory provenance does not identify its exposed rows'],
    });
    const resolution = await approveProposal({
      proposalId,
      memberRoleIds: ['admin'],
      adminRoleIds: ['admin'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck,
      now: NOW,
    }, { db: env.db });
    expect(resolution.outcome).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
  });

  it.each([
    ['malformed identifiers', [123]],
    ['a missing memory row', ['memory-does-not-exist']],
  ])('fails closed for %s in durable run provenance', async (_label, memoryIds) => {
    const evidenceId = `m-memory-provenance-${String(memoryIds[0])}`;
    const episodeId = queuedEpisode(CHANNEL, [
      { id: evidenceId, content: 'The intervention has current evidence.' },
    ]);
    const runId = `run-memory-provenance-${String(memoryIds[0])}`;
    seedEpisodeRun(runId, episodeId, [evidenceId]);
    env.db.prepare('UPDATE agent_runs SET retrieval_provenance_json = ? WHERE id = ?').run(
      JSON.stringify({
        ...episodeRunProvenance([evidenceId]),
        memoryIds,
        memoryScopes: [{ scopeType: 'org', scopeKey: null, source: 'memory_search' }],
      }),
      runId,
    );
    const proposalId = insertProposal(env.db, {
      runId,
      episodeId,
      targetChannelId: CHANNEL,
      status: 'pending_review',
      computedScore: 0.9,
      reason: ['eligible; review mode'],
      message: 'Please reconcile this decision before proceeding.',
      evidenceMessageIds: [evidenceId],
      expiresAtMs: NOW + 60_000,
      now: NOW,
    });

    const recheck = buildApprovalRecheck(interventionRuntimeContext(), proposalId, NOW);
    expect(recheck.provenance.outcome).toBe('reject');
    expect(recheck.provenance.reasons).toHaveLength(1);
    expect(recheck.provenance.reasons[0]).not.toContain('shared launch policy');
    const resolution = await approveProposal({
      proposalId,
      memberRoleIds: ['admin'],
      adminRoleIds: ['admin'],
      actorUserId: ALICE,
      guildId: GUILD,
      recheck,
      now: NOW,
    }, { db: env.db });
    expect(resolution.outcome).toBe('expired');
    expect(getOutboxByDedupeKey(env.db, `proposal:${proposalId}`)).toBeUndefined();
  });

  it('rejects exposed citations that currently resolve to a Mneme test surface or another guild', async () => {
    const testChannelId = '100000000000000030';
    const foreignGuildId = '100000000000000031';
    const foreignChannelId = '100000000000000032';
    seedChannel(testChannelId, { name: 'mneme-playground' });
    env.db.prepare(
      `INSERT INTO workspaces
         (id, name, owner_id, joined_at_ms, discovered_at_ms, updated_at_ms, raw_json)
       VALUES (?, 'Other Guild', NULL, ?, ?, ?, NULL)`,
    ).run(foreignGuildId, NOW, NOW, NOW);
    seedChannel(foreignChannelId, {
      name: 'other-general',
      guildId: foreignGuildId,
    });
    insertMessage('m-test-surface-citation', testChannelId, 'Test-only evidence.');
    insertMessage('m-foreign-citation', foreignChannelId, 'Foreign-guild evidence.', {
      guildId: foreignGuildId,
    });
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm-target-1', content: 'A consequential decision was discussed.' },
      { id: 'm-target-2', content: 'The team agreed to proceed.' },
    ]);

    for (const [runId, evidenceId] of [
      ['run-test-surface-citation', 'm-test-surface-citation'],
      ['run-foreign-citation', 'm-foreign-citation'],
    ] as const) {
      seedEpisodeRun(runId, episodeId, [evidenceId]);
      const result = runResult({ runId, provenance: episodeRunProvenance([evidenceId]) });
      const proposal = {
        ...episodeProposal(CHANNEL, 1),
        intervention: {
          recommend: true,
          reason: 'A material conflict should be surfaced.',
          dimensions: { ...dims, impact: 1, evidenceStrength: 1, interruptionCost: 0 },
          confidence: 1,
          urgency: 'normal' as const,
          targetChannelId: CHANNEL,
          evidenceMessageIds: [evidenceId],
          message: 'Please reconcile this decision before proceeding.',
        },
      };

      const proposalId = await routeEpisodeIntervention(
        interventionRuntimeContext(),
        {} as never,
        'test-secret',
        {
          proposal,
          result,
          episode: getEpisode(env.db, episodeId)!,
          scope: { grant: ORG_GRANT, target: { label: '#general', visibility: 'restricted' } },
          now: NOW,
          memoryOutcome: { applied: [], rejected: [], total: 0 },
          episodeMessageIds: new Set([evidenceId]),
        },
      );
      const stored = getProposal(env.db, proposalId!);
      expect(stored?.status).toBe('observed');
      expect(stored?.reason).toBe(`cited message "${evidenceId}" does not exist`);
    }
    expect(outboxCount()).toBe(0);
  });
});

describe('review_episode — end-to-end with the real runtime', () => {
  function fauxAgent(): { agent: AgentRuntimeInputs; handle: ReturnType<typeof fauxProvider> } {
    const handle = fauxProvider({ models: [{ id: 'faux-1' }] });
    const models = createModels();
    models.setProvider(handle.provider);
    return {
      agent: {
        model: handle.getModel(),
        thinkingLevel: 'medium',
        streamFn: models.streamSimple.bind(models),
        providerId: 'faux',
        modelId: 'faux-1',
      },
      handle,
    };
  }

  it('a completed run stores prompt version, provenance, usage, proposal, and episode summary', async () => {
    const { agent, handle } = fauxAgent();
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'onboarding' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('finalize_episode_review', episodeProposal(CHANNEL, 0.5))], {
        stopReason: 'toolUse',
      }),
    ]);

    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: 'we decided to adopt the onboarding trial' },
      { id: 'm2', content: 'agreed, lets ship it friday' },
    ]);

    const handler = createReviewEpisodeHandler(makeDeps({ agent }));
    const out = await handler.runReview(episodeId);

    expect(out.kind).toBe('reviewed');
    const ep = getEpisode(env.db, episodeId)!;
    expect(ep.status).toBe('reviewed');
    expect(ep.summary).toBe('We adopted the onboarding trial.');
    expect(ep.consequential).toBe(1);
    expect(ep.intervention_score).toBe(0.375);

    // The agent_runs row carries the prompt version, provenance, usage, and proposal.
    const runs = agentRunsForEpisode(episodeId);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe('completed');
    expect(run.prompt_version).toMatch(/^[0-9a-f]{64}$/);
    expect(run.final_proposal_json).toContain('We adopted the onboarding trial.');

    // Provenance and usage were persisted.
    const full = env.db
      .prepare(
        'SELECT input_tokens, output_tokens, retrieval_provenance_json FROM agent_runs WHERE episode_id = ?',
      )
      .get(episodeId) as { input_tokens: number; output_tokens: number; retrieval_provenance_json: string };
    expect(full.input_tokens).toBeGreaterThanOrEqual(0);
    expect(typeof full.retrieval_provenance_json).toBe('string');

    // Nothing was sent.
    expect(outboxCount()).toBe(0);
  });

  it('runs a different candidate model on the same live review without applying its effects', async () => {
    const { agent, handle } = fauxAgent();
    const authoritativeProposal = episodeProposal(CHANNEL, 0.5);
    const shadowProposal = {
      ...episodeProposal(CHANNEL, 0.5),
      episodeSummary: 'Shadow classified this as silence.',
      consequential: false,
      memoryProposals: [],
    };
    handle.setResponses([
      fauxAssistantMessage([
        fauxToolCall('finalize_episode_review', authoritativeProposal),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('finalize_episode_review', shadowProposal),
      ], { stopReason: 'toolUse' }),
    ]);
    env.db.prepare("UPDATE channels SET visibility_class='org' WHERE id=?").run(CHANNEL);
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: 'we decided to adopt the onboarding trial' },
      { id: 'm2', content: 'agreed, lets ship it friday' },
    ]);

    const candidateAgent = {
      ...agent,
      model: { ...agent.model, id: 'faux-luna' },
      modelId: 'faux-luna',
      thinkingLevel: 'high' as const,
    };
    const handler = createReviewEpisodeHandler(makeDeps({
      agent,
      episodeShadow: {
        enabled: true,
        agent: candidateAgent,
        thinkingLevel: 'high',
        maxRuns: 50,
      },
    }));
    const out = await handler.runReview(episodeId);

    expect(out.kind).toBe('reviewed');
    const rows = env.db.prepare(`SELECT id,model,thinking_level,shadow_of_run_id,
      shadow_comparison_json,prompt_version FROM agent_runs
      WHERE episode_id=? ORDER BY shadow_of_run_id IS NOT NULL`).all(episodeId) as Array<{
        id: string;
        model: string;
        thinking_level: string;
        shadow_of_run_id: string | null;
        shadow_comparison_json: string | null;
        prompt_version: string;
      }>;
    expect(rows).toHaveLength(2);
    const authoritative = rows[0]!;
    const shadow = rows[1]!;
    expect(authoritative.thinking_level).toBe('medium');
    expect(authoritative.shadow_of_run_id).toBeNull();
    expect(shadow.model).toBe('faux-luna');
    expect(shadow.thinking_level).toBe('high');
    expect(shadow.shadow_of_run_id).toBe(authoritative.id);
    expect(shadow.prompt_version).toBe(authoritative.prompt_version);
    expect(JSON.parse(shadow.shadow_comparison_json!)).toMatchObject({
      version: 1,
      authoritative: { category: 'important' },
      shadow: { category: 'silent' },
      categoryMatch: false,
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 });
    expect(env.db.prepare('SELECT created_by_run_id FROM memories').get()).toEqual({
      created_by_run_id: authoritative.id,
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE run_id=?').get(shadow.id))
      .toEqual({ n: 0 });
    expect(outboxCount()).toBe(0);
  });

  it('keeps the authoritative review successful when the shadow executor fails', async () => {
    const { agent } = fauxAgent();
    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: 'we decided to keep the launch date' },
      { id: 'm2', content: 'agreed, that is final' },
    ]);
    let calls = 0;
    const runInputs: ExecuteAgentRunDeps[] = [];
    const handler = createReviewEpisodeHandler(makeDeps({
      agent,
      episodeShadow: { enabled: true, thinkingLevel: 'low', maxRuns: 50 },
      executeRun: async (runDeps) => {
        runInputs.push(runDeps);
        calls += 1;
        if (calls === 2) throw new Error('shadow-only failure');
        return runResult({
          runId: 'authoritative-shadow-failure',
          finalProposal: {
            kind: 'episode_review',
            proposal: { ...episodeProposal(CHANNEL), memoryProposals: [] },
          },
        });
      },
    }));

    const out = await handler.runReview(episodeId);

    expect(out.kind).toBe('reviewed');
    expect(calls).toBe(2);
    expect(runInputs[1]).toMatchObject({
      promptText: runInputs[0]!.promptText,
      systemPrompt: runInputs[0]!.systemPrompt,
      promptVersion: runInputs[0]!.promptVersion,
      model: runInputs[0]!.model,
      grant: runInputs[0]!.grant,
      initialProvenanceChannelIds: runInputs[0]!.initialProvenanceChannelIds,
      initialProvenanceMessages: runInputs[0]!.initialProvenanceMessages,
      initialProvenanceMemoryScopes: runInputs[0]!.initialProvenanceMemoryScopes,
      thinkingLevel: 'low',
      shadowOfRunId: 'authoritative-shadow-failure',
    });
    expect(runInputs[0]!.thinkingLevel).toBe('medium');
    expect(getEpisode(env.db, episodeId)?.status).toBe('reviewed');
    expect(outboxCount()).toBe(0);
  });

  it('does not shadow historical episodes or exceed the cumulative cap', async () => {
    const { agent } = fauxAgent();
    const historicalEpisodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: 'we decided this historical policy' },
      { id: 'm2', content: 'agreed in the archive' },
    ]);
    env.db.prepare("UPDATE episodes SET origin='historical' WHERE id=?").run(historicalEpisodeId);
    let historicalCalls = 0;
    const historicalHandler = createReviewEpisodeHandler(makeDeps({
      agent,
      episodeShadow: { enabled: true, thinkingLevel: 'low', maxRuns: 1 },
      executeRun: async () => {
        historicalCalls += 1;
        return runResult({ runId: 'historical-authoritative', finalProposal: {
          kind: 'episode_review', proposal: { ...episodeProposal(CHANNEL), memoryProposals: [] },
        } });
      },
    }));
    expect((await historicalHandler.runReview(historicalEpisodeId)).kind).toBe('reviewed');
    expect(historicalCalls).toBe(1);

    env.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
      VALUES ('prior-authoritative',?,'episode','p','faux','faux-1','completed',?)`).run(GUILD, NOW - 2);
    env.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms,thinking_level,shadow_of_run_id)
      VALUES ('prior-shadow',?,'episode','p','faux','faux-1','completed',?,'low','prior-authoritative')`).run(GUILD, NOW - 1);
    const liveEpisodeId = queuedEpisode(CHANNEL, [
      { id: 'm3', content: 'we decided this live policy' },
      { id: 'm4', content: 'agreed for the live work' },
    ]);
    let liveCalls = 0;
    const cappedHandler = createReviewEpisodeHandler(makeDeps({
      agent,
      episodeShadow: { enabled: true, thinkingLevel: 'low', maxRuns: 1 },
      executeRun: async () => {
        liveCalls += 1;
        return runResult({ runId: 'live-authoritative', finalProposal: {
          kind: 'episode_review', proposal: { ...episodeProposal(CHANNEL), memoryProposals: [] },
        } });
      },
    }));
    expect((await cappedHandler.runReview(liveEpisodeId)).kind).toBe('reviewed');
    expect(liveCalls).toBe(1);

    const lunaEpisodeId = queuedEpisode(CHANNEL, [
      { id: 'm5', content: 'we decided this candidate policy' },
      { id: 'm6', content: 'agreed for the candidate benchmark' },
    ]);
    let lunaCalls = 0;
    const lunaAgent = {
      ...agent,
      model: { ...agent.model, id: 'faux-luna' },
      modelId: 'faux-luna',
      thinkingLevel: 'high' as const,
    };
    const lunaHandler = createReviewEpisodeHandler(makeDeps({
      agent,
      episodeShadow: {
        enabled: true,
        agent: lunaAgent,
        thinkingLevel: 'high',
        maxRuns: 1,
      },
      executeRun: async () => {
        lunaCalls += 1;
        return runResult({ runId: `luna-call-${lunaCalls}`, finalProposal: {
          kind: 'episode_review', proposal: { ...episodeProposal(CHANNEL), memoryProposals: [] },
        } });
      },
    }));
    expect((await lunaHandler.runReview(lunaEpisodeId)).kind).toBe('reviewed');
    expect(lunaCalls).toBe(2);
  });

  it('a budget-exhausted run that never finalizes fails closed: episode errored, nothing sent, no proposal stored', async () => {
    const { agent, handle } = fauxAgent();
    // Two retrieval calls with a one-call budget: the second is blocked, the
    // host offers the terminal tool alone and asks for finalization, and the
    // model answers with prose instead. The run ends `budget_exceeded`.
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'a' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'b' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('No proposal.'),
    ]);

    const episodeId = queuedEpisode(CHANNEL, [
      { id: 'm1', content: 'we decided x' },
      { id: 'm2', content: 'second human message' },
    ]);

    const handler = createReviewEpisodeHandler(makeDeps({ agent, limits: { maxToolCalls: 1 } }));
    const out = await handler.runReview(episodeId);

    expect(out.kind).toBe('error');
    expect(getEpisode(env.db, episodeId)?.status).toBe('error');
    expect(outboxCount()).toBe(0);
    const runs = agentRunsForEpisode(episodeId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.final_proposal_json).toBeNull();
  });
});
