import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel, type VisibilityClass } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  createDirectAnswerHandler,
  DIRECT_ANSWER_FALLBACK_MESSAGE,
  type DirectAnswerProposal,
  type DirectAnswerChannelScope,
  type DirectAnswerRateChecks,
} from '../../src/jobs/handlers/direct-answer.js';
import type {
  AgentRunResult,
  AgentRunOutcome,
  ExecuteAgentRunDeps,
} from '../../src/agent/runtime.js';
import type { CooldownDecision } from '../../src/agent/cooldowns.js';
import type { DuplicateResult } from '../../src/agent/duplicate-policy.js';
import type { PromptCompiler } from '../../src/agent/prompts.js';
import {
  getDirectAnswerRequest,
  DIRECT_ANSWER_DEADLINE_MS,
} from '../../src/db/repositories/direct-answers.js';
import {
  insertProposal,
  proposalShortId,
  setProposalReviewMessage,
} from '../../src/db/repositories/proposals.js';
import { ModelAdmissionTimeoutError } from '../../src/agent/model-admission.js';
import { enqueue, getJob } from '../../src/jobs/queue.js';
import { TransientJobError } from '../../src/jobs/errors.js';
import { createMemory } from '../../src/memory/repository.js';
import {
  fingerprintExposedMemory,
  fingerprintExposedMessage,
} from '../../src/agent/run-context.js';
import {
  RECENT_ACTIVITY_SNAPSHOT_MAX_MESSAGES,
} from '../../src/db/repositories/recent-activity-snapshot.js';
import { emptyAgentRunUsage } from '../../src/agent/usage.js';

/**
 * Direct-answer agent job (Sections 19, 26, 46.3).
 *
 * Acceptance: a public question about private-channel content refuses without
 * hints, and admin actions are redirected to slash commands. The handler pins the
 * question's channel, runs one bounded agent run scoped to that channel, then
 * re-validates the proposal (target, citations, mentions, reply anchor, rate
 * limits) before enqueueing a reply in the same channel.
 */

const NOW = 1_700_000_001_000;
const ORG_CHANNEL = '100000000000000010';

type Env = TestDb & { guildId: string; channelId: string; userId: string };

let env: Env;

beforeEach(() => {
  const base = createTestDb();
  env = { ...base, ...seedIdentity(base.db) };
  // The seeded channel (...002) is restricted with interventions off. Add an org
  // channel that allows interventions as the direct-answer target.
  upsertChannel(env.db, {
    id: ORG_CHANNEL,
    guildId: env.guildId,
    parentId: null,
    type: 0,
    name: 'general',
    topic: null,
    position: 0,
    isThread: false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: 'org',
    allowInterventions: true,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  });
});
afterEach(() => env.cleanup());

function seedMessage(
  id: string,
  channelId: string,
  content: string,
  options: { createdAtMs?: number; replyToMessageId?: string | null } = {},
): string {
  const createdAtMs = options.createdAtMs ?? NOW;
  upsertMessageCreate(env.db, {
    id,
    guildId: env.guildId,
    channelId,
    authorId: env.userId,
    authorDisplayName: 'Alice',
    content,
    createdAtMs,
    editedAtMs: null,
    replyToMessageId: options.replyToMessageId ?? null,
    messageType: 0,
    flags: null,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: createdAtMs,
    updatedAtMs: createdAtMs,
  });
  return id;
}

function seedChannel(
  id: string,
  name: string,
  options: {
    parentId?: string | null;
    isThread?: boolean;
    ingestEnabled?: boolean;
    visibilityClass?: VisibilityClass;
    allowInterventions?: boolean;
  } = {},
): string {
  const isThread = options.isThread ?? false;
  upsertChannel(env.db, {
    id,
    guildId: env.guildId,
    parentId: options.parentId ?? null,
    type: isThread ? 11 : 0,
    name,
    topic: null,
    position: 0,
    isThread,
    isArchived: false,
    isLocked: false,
    ingestEnabled: options.ingestEnabled ?? true,
    visibilityClass: options.visibilityClass ?? 'org',
    allowInterventions: options.allowInterventions ?? true,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  });
  return id;
}

const cooldownAllow: CooldownDecision = { allowed: true, blocks: [], retryAfterMs: null };
const noDuplicate: DuplicateResult = { matched: false };

interface FakeRunOpts {
  runId?: string;
  proposal?: DirectAnswerProposal | null;
  outcome?: AgentRunOutcome;
  provenance?: AgentRunResult['provenance'];
}

/** A run executor that writes the agent_runs row (satisfying the outbox FK) and
 *  returns a configured result. */
function fakeExecutor(opts: FakeRunOpts = {}): (deps: ExecuteAgentRunDeps) => Promise<AgentRunResult> {
  return async (deps) => {
    const runId = opts.runId ?? 'run-da-1';
    deps.db
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
         VALUES (?,?,NULL,'direct_answer','pv','faux','faux-1','completed',?)`,
      )
      .run(runId, deps.guildId, NOW);
    const outcome = opts.outcome ?? 'finalized';
    const proposal = opts.proposal ?? {
      targetChannelId: deps.pinnedTargetChannelId,
      message: 'Here is the answer.',
      citedMessageIds: [],
    };
    const baseProvenance = opts.provenance ?? {
      channels: (deps.initialProvenanceChannelIds ?? []).map((channelId) => ({
        channelId,
        source: 'initial_payload' as const,
      })),
      messageIds: (deps.initialProvenanceMessages ?? []).map((message) => message.messageId),
      memoryScopes: [],
      memoryIds: [],
      charsExposed: 0,
      charBudget: 0,
    };
    const provenance: AgentRunResult['provenance'] = {
      ...baseProvenance,
      messageFingerprints: baseProvenance.messageIds.flatMap((messageId) => {
        const fingerprint = deps.initialProvenanceMessages
          ?.find((message) => message.messageId === messageId)?.fingerprint
          ?? fingerprintExposedMessage(deps.db, messageId);
        return fingerprint ? [{ messageId, fingerprint }] : [];
      }),
      memoryFingerprints: baseProvenance.memoryIds.flatMap((memoryId) => {
        const fingerprint = fingerprintExposedMemory(deps.db, memoryId);
        return fingerprint ? [{ memoryId, fingerprint }] : [];
      }),
    };
    return {
      runId,
      status: 'completed',
      outcome,
      failureReason: null,
      turns: 1,
      modelTurns: [],
      toolCalls: [],
      usage: emptyAgentRunUsage(),
      provenance,
      finalProposal:
        outcome === 'finalized' && proposal !== null
          ? { kind: 'direct_answer', proposal }
          : null,
      startedAtMs: NOW,
      endedAtMs: NOW,
    };
  };
}

const orgScope: DirectAnswerChannelScope = {
  grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [ORG_CHANNEL] },
  target: { channelId: ORG_CHANNEL, visibility: 'org' as VisibilityClass, isSecureReview: false },
};

function buildHandler(over: Partial<{
  executeRun: (d: ExecuteAgentRunDeps) => Promise<AgentRunResult>;
  rateChecks: (channelId: string, content: string, now: number) => DirectAnswerRateChecks;
  promptCompiler: PromptCompiler;
  scope: DirectAnswerChannelScope;
  now: () => number;
  logger: NonNullable<Parameters<typeof createDirectAnswerHandler>[0]['logger']>;
}> = {}) {
  const noopCompiler = { render: () => '', versionFor: () => 'pv' } as unknown as PromptCompiler;
  return createDirectAnswerHandler({
    db: env.db,
    guildId: env.guildId,
    promptCompiler: over.promptCompiler ?? noopCompiler,
    systemPrompt: '',
    mode: 'autonomous',
    resolveChannelScope: () => over.scope ?? orgScope,
    rateChecks:
      over.rateChecks ?? (() => ({ cooldown: cooldownAllow, duplicate: noDuplicate })),
    executeRun: over.executeRun ?? fakeExecutor(),
    now: over.now ?? (() => NOW),
    logger: over.logger,
  });
}

describe('createDirectAnswerHandler — answers in the pinned channel', () => {
  it('answers an explicit mention when unsolicited interventions are disabled', async () => {
    env.db.prepare('UPDATE channels SET allow_interventions = 0 WHERE id = ?').run(ORG_CHANNEL);
    const q = seedMessage('msg-q-opt-out', ORG_CHANNEL, '<@mneme> what do you remember?');
    const handler = buildHandler();

    const res = await handler.runDirectAnswer(q, ORG_CHANNEL);

    expect(res.kind).toBe('answered');
    expect(outboxCount()).toBe(1);
  });

  it('enqueues a reply in the question channel with the validated content', async () => {
    const q = seedMessage('msg-q-1', ORG_CHANNEL, '<@mneme> what is the deploy status?');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: { targetChannelId: ORG_CHANNEL, message: 'Deploy is green.', citedMessageIds: [] },
      }),
    });

    const res = await handler.runDirectAnswer(q, ORG_CHANNEL);

    expect(res.kind).toBe('answered');
    const row = env.db
      .prepare('SELECT channel_id, content, reply_to_message_id, status FROM outbox')
      .get() as {
      channel_id: string;
      content: string;
      reply_to_message_id: string;
      status: string;
    };
    expect(row.channel_id).toBe(ORG_CHANNEL);
    expect(row.content).toContain('Deploy is green.');
    expect(row.reply_to_message_id).toBe(q); // defaults to the question message
    expect(row.status).toBe('queued');
  });

  it('appends host-built masked source links for citations visible in the target', async () => {
    const cited = seedMessage('msg-cite-1', ORG_CHANNEL, 'deploy succeeded at noon');
    seedMessage('msg-q-2', ORG_CHANNEL, '<@mneme> status?');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: ORG_CHANNEL,
          message: `Deploy is green. [[cite:${cited}]]`,
          citedMessageIds: [cited],
          replyToMessageId: 'msg-q-2',
        },
      }),
    });

    const res = await handler.runDirectAnswer('msg-q-2', ORG_CHANNEL);
    expect(res.kind).toBe('answered');
    const row = env.db
      .prepare('SELECT content, reply_to_message_id FROM outbox')
      .get() as { content: string; reply_to_message_id: string };
    expect(row.content).toContain('[#general · 2023-11-14](');
    expect(row.content).not.toContain('Sources:');
    expect(row.content).toContain(cited);
    expect(row.reply_to_message_id).toBe('msg-q-2');
  });

  it('rejects a visible citation that was never exposed to the run', async () => {
    const cited = seedMessage('msg-visible-but-unexposed', ORG_CHANNEL, 'an unrelated old source');
    const question = seedMessage('msg-q-unexposed', ORG_CHANNEL, '<@mneme> status?');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: ORG_CHANNEL,
          message: 'Deploy is green.',
          citedMessageIds: [cited],
        },
        provenance: {
          channels: [{ channelId: ORG_CHANNEL, source: 'initial_payload' }],
          messageIds: [question],
          memoryScopes: [],
          memoryIds: [],
          charsExposed: 0,
          charBudget: 60_000,
        },
      }),
    });

    const res = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(res);
  });

  it('allows citations within the parent-anchored scope of a restricted thread', async () => {
    const threadId = '100000000000000012';
    upsertChannel(env.db, {
      id: threadId,
      guildId: env.guildId,
      parentId: env.channelId,
      type: 11,
      name: 'restricted-thread',
      topic: null,
      position: 0,
      isThread: true,
      isArchived: false,
      isLocked: false,
      ingestEnabled: true,
      visibilityClass: 'restricted',
      allowInterventions: true,
      permissionFingerprint: null,
      lastMessageId: null,
      discoveredAtMs: NOW,
      updatedAtMs: NOW,
      rawJson: null,
    });
    const cited = seedMessage('msg-thread-cite', threadId, 'The thread-local decision.', {
      createdAtMs: NOW - 1,
    });
    const question = seedMessage('msg-thread-question', threadId, '<@mneme> what did we decide?');
    const handler = buildHandler({
      scope: {
        grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [env.channelId] },
        target: {
          channelId: threadId,
          scopeChannelId: env.channelId,
          visibility: 'restricted',
          isSecureReview: false,
        },
      },
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: threadId,
          message: 'Use the thread-local decision.',
          citedMessageIds: [cited],
        },
      }),
    });

    const res = await handler.runDirectAnswer(question, threadId);

    expect(res.kind).toBe('answered');
    expect(outboxCount()).toBe(1);
  });

  it('suppresses a model-authored Discord link even when its cited id is valid', async () => {
    const cited = seedMessage('msg-cite-inline', ORG_CHANNEL, 'deploy succeeded at noon');
    const question = seedMessage('msg-q-inline', ORG_CHANNEL, '<@mneme> status?');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: ORG_CHANNEL,
          message: `Deploy is green: https://discord.com/channels/${env.guildId}/${ORG_CHANNEL}/${cited}`,
          citedMessageIds: [cited],
        },
      }),
    });

    const res = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(res);
    expect(onlyOutboxContent()).not.toContain('discord.com/channels');
  });

  it('redirects admin-action requests to chat only via prompt (never acts on them)', async () => {
    // The model "complies" by producing a normal answer; the handler does not
    // perform any admin action — it only enqueues the textual reply.
    seedMessage('msg-q-3', ORG_CHANNEL, '<@mneme> delete all messages');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: ORG_CHANNEL,
          message: 'I cannot do that from chat; use /mneme forget-user.',
          citedMessageIds: [],
        },
      }),
    });
    const res = await handler.runDirectAnswer('msg-q-3', ORG_CHANNEL);
    expect(res.kind).toBe('answered');
    // No admin_events were recorded for a chat request.
    const n = env.db.prepare('SELECT COUNT(*) AS c FROM admin_events').get() as { c: number };
    expect(n.c).toBe(0);
  });
});

describe('createDirectAnswerHandler — outbound validation suppresses', () => {
  it('suppresses when the proposal targets a different channel than the pinned one', async () => {
    seedMessage('msg-q-4', ORG_CHANNEL, '<@mneme> hi');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: { targetChannelId: '999999999999999999', message: 'retargeted', citedMessageIds: [] },
      }),
    });
    const res = await handler.runDirectAnswer('msg-q-4', ORG_CHANNEL);
    expectNeutralFallback(res);
    expect(onlyOutboxContent()).not.toContain('retargeted');
  });

  it('refuses to send a public answer citing private-channel content (no hints)', async () => {
    // A citation to a restricted channel message is not visible in the org target.
    const restrictedCite = seedMessage('msg-secret', env.channelId, 'confidential detail');
    seedMessage('msg-q-5', ORG_CHANNEL, '<@mneme> what was decided?');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: ORG_CHANNEL,
          message: 'Here is the secret.',
          citedMessageIds: [restrictedCite],
        },
      }),
    });
    const res = await handler.runDirectAnswer('msg-q-5', ORG_CHANNEL);
    expectNeutralFallback(res);
    expect(onlyOutboxContent()).not.toContain('secret');
  });

  it('suppresses an uncited paraphrase when provenance includes restricted content', async () => {
    seedMessage('msg-q-provenance', ORG_CHANNEL, '<@mneme> what was decided?');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: ORG_CHANNEL,
          message: 'An uncited paraphrase of hidden material.',
          citedMessageIds: [],
        },
        provenance: {
          channels: [
            { channelId: env.channelId, source: 'message_search' },
          ],
          messageIds: [],
          memoryScopes: [],
          memoryIds: [],
          charsExposed: 20,
          charBudget: 60_000,
        },
      }),
    });
    const res = await handler.runDirectAnswer('msg-q-provenance', ORG_CHANNEL);
    expectNeutralFallback(res);
    expect(onlyOutboxContent()).not.toContain('hidden');
  });

  it('revalidates every exposed message even when the deleted row is not cited', async () => {
    const cited = seedMessage('msg-current-citation', ORG_CHANNEL, 'The live source.', {
      createdAtMs: NOW - 2_000,
    });
    const deleted = seedMessage('msg-deleted-uncited', ORG_CHANNEL, 'Sensitive stale detail.', {
      createdAtMs: NOW - 1_000,
    });
    const question = seedMessage(
      'msg-deleted-uncited-question',
      ORG_CHANNEL,
      '<@mneme> summarize that',
    );
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'Sensitive stale detail, according to the discussion.',
        citedMessageIds: [cited],
      },
      provenance: {
        channels: [{ channelId: ORG_CHANNEL, source: 'message_search' }],
        messageIds: [question, cited, deleted],
        memoryScopes: [],
        memoryIds: [],
        charsExposed: 50,
        charBudget: 60_000,
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        deps.db.prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?')
          .run(NOW + 1, deleted);
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result);
    expect(onlyOutboxContent()).not.toContain('Sensitive stale detail');
  });

  it('rejects an exposed message edit even when its writer reuses a stale timestamp', async () => {
    const cited = seedMessage('msg-edit-live-citation', ORG_CHANNEL, 'The live source.', {
      createdAtMs: NOW - 2_000,
    });
    const edited = seedMessage('msg-edited-uncited', ORG_CHANNEL, 'Pre-redaction detail.', {
      createdAtMs: NOW - 1_000,
    });
    const question = seedMessage('msg-edit-race-question', ORG_CHANNEL, '<@mneme> summarize');
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'The pre-redaction detail was discussed.',
        citedMessageIds: [cited],
      },
      provenance: {
        channels: [{ channelId: ORG_CHANNEL, source: 'message_search' }],
        messageIds: [question, cited, edited],
        memoryScopes: [],
        memoryIds: [],
        charsExposed: 50,
        charBudget: 60_000,
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        deps.db.prepare('UPDATE messages SET content = ?, updated_at_ms = ? WHERE id = ?')
          .run('Redacted.', NOW - 10_000, edited);
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result);
    expect(onlyOutboxContent()).not.toContain('pre-redaction');
  });

  it('binds the initial prompt version before admission or model execution', async () => {
    const question = seedMessage(
      'msg-initial-edit-race',
      ORG_CHANNEL,
      '<@mneme> summarize the pre-redaction request',
    );
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'The pre-redaction request asked for a summary.',
        citedMessageIds: [],
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        deps.db.prepare('UPDATE messages SET content = ?, updated_at_ms = ? WHERE id = ?')
          .run('<@mneme> redacted', NOW - 10_000, question);
        return base(deps);
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result);
    expect(onlyOutboxContent()).not.toContain('pre-redaction');
  });

  it('recomputes every exposed memory scope before sending an uncited paraphrase', async () => {
    const evidenceChannel = seedChannel('100000000000000097', 'memory-evidence');
    const evidence = seedMessage(
      'msg-memory-scope-evidence',
      evidenceChannel,
      'The internal launch decision.',
      { createdAtMs: NOW - 1_000 },
    );
    const memoryId = createMemory(env.db, {
      includeOrgMessages: true, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [],
    }, {
      guildId: env.guildId,
      type: 'decision',
      statement: 'Launch the internal program on Friday.',
      confidence: 0.9,
      importance: 0.8,
      evidence: [{ messageId: evidence, stance: 'origin' }],
      now: NOW,
    });
    const question = seedMessage(
      'msg-memory-scope-question',
      ORG_CHANNEL,
      '<@mneme> what was decided?',
    );
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'Launch the internal program on Friday.',
        citedMessageIds: [],
      },
      provenance: {
        channels: [{ channelId: ORG_CHANNEL, source: 'initial_payload' }],
        messageIds: [question],
        memoryScopes: [{ scopeType: 'org', scopeKey: null, source: 'memory_search' }],
        memoryIds: [memoryId],
        charsExposed: 50,
        charBudget: 60_000,
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        deps.db.prepare("UPDATE channels SET visibility_class = 'restricted' WHERE id = ?")
          .run(evidenceChannel);
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result);
    expect(onlyOutboxContent()).not.toContain('internal program');
  });

  it('rejects an exposed memory edit even when its writer reuses a stale timestamp', async () => {
    const evidence = seedMessage(
      'msg-memory-edit-evidence',
      ORG_CHANNEL,
      'Pre-redaction memory evidence.',
      { createdAtMs: NOW - 1_000 },
    );
    const memoryId = createMemory(env.db, {
      includeOrgMessages: true, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [],
    }, {
      guildId: env.guildId,
      type: 'decision',
      statement: 'Pre-redaction memory statement.',
      confidence: 0.9,
      importance: 0.8,
      evidence: [{ messageId: evidence, stance: 'origin' }],
      now: NOW,
    });
    const question = seedMessage('msg-memory-edit-question', ORG_CHANNEL, '<@mneme> recap');
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'Pre-redaction memory statement.',
        citedMessageIds: [],
      },
      provenance: {
        channels: [{ channelId: ORG_CHANNEL, source: 'initial_payload' }],
        messageIds: [question],
        memoryScopes: [{ scopeType: 'org', scopeKey: null, source: 'memory_search' }],
        memoryIds: [memoryId],
        charsExposed: 50,
        charBudget: 60_000,
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        deps.db.prepare('UPDATE memories SET statement = ?, updated_at_ms = ? WHERE id = ?')
          .run('Redacted memory statement.', NOW - 10_000, memoryId);
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result);
    expect(onlyOutboxContent()).not.toContain('Pre-redaction');
  });

  it('rejects a memory-only answer when its evidence is redacted with a stale timestamp', async () => {
    const evidenceChannel = seedChannel('100000000000000095', 'memory-source');
    const evidence = seedMessage(
      'msg-memory-source-redaction',
      evidenceChannel,
      'Launch the confidential pilot on Friday.',
      { createdAtMs: NOW - 1_000 },
    );
    const memoryId = createMemory(env.db, {
      includeOrgMessages: true, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [],
    }, {
      guildId: env.guildId,
      type: 'decision',
      statement: 'Launch the confidential pilot on Friday.',
      confidence: 0.9,
      importance: 0.8,
      evidence: [{ messageId: evidence, stance: 'origin' }],
      now: NOW,
    });
    const question = seedMessage('msg-memory-source-question', ORG_CHANNEL, '<@mneme> recap');
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'Launch the confidential pilot on Friday.',
        citedMessageIds: [],
      },
      provenance: {
        channels: [{ channelId: ORG_CHANNEL, source: 'initial_payload' }],
        messageIds: [question],
        memoryScopes: [{ scopeType: 'org', scopeKey: null, source: 'memory_search' }],
        memoryIds: [memoryId],
        charsExposed: 50,
        charBudget: 60_000,
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        deps.db.prepare('UPDATE messages SET content = ?, updated_at_ms = ? WHERE id = ?')
          .run('Redacted.', NOW - 10_000, evidence);
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result);
    expect(onlyOutboxContent()).not.toContain('confidential pilot');
  });

  it('rejects a changed memory-evidence relationship with no row timestamp to compare', async () => {
    const evidenceChannel = seedChannel('100000000000000096', 'evidence-notes');
    const evidence = seedMessage(
      'msg-memory-note-evidence',
      evidenceChannel,
      'The launch evidence.',
      { createdAtMs: NOW - 1_000 },
    );
    const memoryId = createMemory(env.db, {
      includeOrgMessages: true, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [],
    }, {
      guildId: env.guildId,
      type: 'decision',
      statement: 'Launch on Friday.',
      confidence: 0.9,
      importance: 0.8,
      evidence: [{ messageId: evidence, stance: 'origin', note: 'Pre-redaction note.' }],
      now: NOW,
    });
    const question = seedMessage('msg-memory-note-question', ORG_CHANNEL, '<@mneme> recap');
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'The pre-redaction note supported a Friday launch.',
        citedMessageIds: [],
      },
      provenance: {
        channels: [
          { channelId: ORG_CHANNEL, source: 'initial_payload' },
          { channelId: evidenceChannel, source: 'memory_evidence' },
        ],
        messageIds: [question, evidence],
        memoryScopes: [{ scopeType: 'org', scopeKey: null, source: 'memory_evidence' }],
        memoryIds: [memoryId],
        charsExposed: 80,
        charBudget: 60_000,
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        deps.db.prepare(`
          UPDATE memory_evidence SET note = ?
           WHERE memory_id = ? AND message_id = ? AND stance = 'origin'
        `).run('Redacted note.', memoryId, evidence);
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result);
    expect(onlyOutboxContent()).not.toContain('pre-redaction note');
  });

  it('suppresses a message containing a user mention', async () => {
    seedMessage('msg-q-6', ORG_CHANNEL, '<@mneme> hi');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: { targetChannelId: ORG_CHANNEL, message: 'hey <@123456789012345678>', citedMessageIds: [] },
      }),
    });
    const res = await handler.runDirectAnswer('msg-q-6', ORG_CHANNEL);
    expectNeutralFallback(res);
    expect(onlyOutboxContent()).not.toContain('<@');
  });

  it('suppresses when the channel is cooling down', async () => {
    seedMessage('msg-q-7', ORG_CHANNEL, '<@mneme> hi');
    const cooldownBlock: CooldownDecision = {
      allowed: false,
      blocks: [{ rule: 'channel_cooldown', retryAfterMs: NOW + 60_000, detail: 'cooling down' }],
      retryAfterMs: NOW + 60_000,
    };
    const handler = buildHandler({
      rateChecks: () => ({ cooldown: cooldownBlock, duplicate: noDuplicate }),
    });
    const res = await handler.runDirectAnswer('msg-q-7', ORG_CHANNEL);
    expect(res.kind).toBe('suppressed');
    expect(res.reasonCategory).toBe('rate_limit');
    expect(outboxCount()).toBe(0);
  });

  it('suppresses a near-duplicate of a recent Mneme message', async () => {
    seedMessage('msg-q-8', ORG_CHANNEL, '<@mneme> hi');
    const dup: DuplicateResult = {
      matched: true,
      kind: 'near',
      similarity: 0.93,
      matchedPreview: 'hi',
      matchedSentAtMs: NOW - 1,
      source: 'outbox',
    };
    const handler = buildHandler({ rateChecks: () => ({ cooldown: cooldownAllow, duplicate: dup }) });
    const res = await handler.runDirectAnswer('msg-q-8', ORG_CHANNEL);
    expect(res.kind).toBe('suppressed');
    expect(res.reasonCategory).toBe('duplicate');
  });

  it('suppresses when the reply anchor is in a different channel', async () => {
    const otherChannelMsg = seedMessage('msg-other', env.channelId, 'in restricted channel');
    seedMessage('msg-q-9', ORG_CHANNEL, '<@mneme> hi');
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: ORG_CHANNEL,
          message: 'answer',
          citedMessageIds: [],
          replyToMessageId: otherChannelMsg,
        },
      }),
    });
    const res = await handler.runDirectAnswer('msg-q-9', ORG_CHANNEL);
    expectNeutralFallback(res);
    expect((env.db.prepare('SELECT reply_to_message_id FROM outbox').get() as {
      reply_to_message_id: string;
    }).reply_to_message_id).toBe('msg-q-9');
  });
});

describe('createDirectAnswerHandler — source availability vs reply targets', () => {
  it('suppresses when a normal org source becomes ingestion-disabled during the run', async () => {
    const question = seedMessage(
      'msg-source-disabled-question',
      ORG_CHANNEL,
      '<@mneme> what is the status?',
    );
    const completeRun = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'The status is green.',
        citedMessageIds: [],
        replyToMessageId: question,
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        deps.db.prepare('UPDATE channels SET ingest_enabled = 0 WHERE id = ?').run(ORG_CHANNEL);
        return completeRun(deps);
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expect(result.kind).toBe('suppressed');
    expect(result.reasonCategory).toBe('policy_disabled');
    expect(outboxCount()).toBe(0);
  });

  it('answers in an ingest-disabled Mneme console using only the exact question as its anchor', async () => {
    const consoleId = seedChannel('100000000000000013', 'mneme-test', {
      ingestEnabled: false,
      allowInterventions: false,
    });
    seedMessage('msg-console-prior', consoleId, 'Unrelated prior console row.', {
      createdAtMs: NOW - 1_000,
    });
    const question = seedMessage(
      'msg-console-question',
      consoleId,
      '<@mneme> can you answer here?',
    );
    let capturedRun: ExecuteAgentRunDeps | undefined;
    const completeRun = fakeExecutor({
      proposal: {
        targetChannelId: consoleId,
        message: 'Yes.',
        citedMessageIds: [],
        replyToMessageId: question,
      },
    });
    const handler = buildHandler({
      scope: {
        grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] },
        target: {
          channelId: consoleId,
          visibility: 'org',
          isSecureReview: false,
        },
      },
      executeRun: async (deps) => {
        capturedRun = deps;
        return completeRun(deps);
      },
    });

    const result = await handler.runDirectAnswer(question, consoleId);

    expect(result.kind).toBe('answered');
    expect(capturedRun?.initialProvenanceMessages?.map(({ messageId, channelId }) => ({
      messageId,
      channelId,
    }))).toEqual([
      { messageId: question, channelId: consoleId },
    ]);
    expect(capturedRun?.grant).toEqual({
      includeOrgMessages: true, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [],
    });
    expect(capturedRun?.cacheProfile).toBe('direct');
    expect(env.db.prepare('SELECT reply_to_message_id FROM outbox').get()).toEqual({
      reply_to_message_id: question,
    });
  });

  it('never exposes prior rows from an ingestion-enabled Mneme test surface', async () => {
    const consoleId = seedChannel('100000000000000016', 'mneme-enabled-console', {
      ingestEnabled: true,
    });
    seedMessage('msg-enabled-console-prior', consoleId, 'Ordinary stale test chatter.', {
      createdAtMs: NOW - 1_000,
    });
    const question = seedMessage(
      'msg-enabled-console-question',
      consoleId,
      '<@mneme> bring me up to speed',
    );
    let rendered: Record<string, unknown> | undefined;
    let capturedRun: ExecuteAgentRunDeps | undefined;
    const promptCompiler = {
      render: (_name: string, context: Record<string, unknown>) => {
        rendered = context;
        return 'rendered prompt';
      },
      versionFor: () => 'pv',
    } as unknown as PromptCompiler;
    const base = fakeExecutor();
    const handler = buildHandler({
      promptCompiler,
      scope: {
        grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] },
        target: { channelId: consoleId, visibility: 'org', isSecureReview: false },
      },
      executeRun: async (deps) => {
        capturedRun = deps;
        return base(deps);
      },
    });

    const result = await handler.runDirectAnswer(question, consoleId);

    expect(result.kind).toBe('answered');
    expect(rendered?.precedingConversation).toEqual([]);
    expect(capturedRun?.initialProvenanceMessages?.map(({ messageId, channelId }) => ({
      messageId,
      channelId,
    }))).toEqual([
      { messageId: question, channelId: consoleId },
    ]);
  });

  it('does not let the Mneme-console exception cite an unrelated prior row', async () => {
    const consoleId = seedChannel('100000000000000014', 'Mneme Console', {
      ingestEnabled: false,
    });
    const unrelated = seedMessage(
      'msg-console-unrelated',
      consoleId,
      'This row is not the explicit question.',
      { createdAtMs: NOW - 1_000 },
    );
    const question = seedMessage(
      'msg-console-citation-question',
      consoleId,
      '<@mneme> answer without using other console rows',
    );
    const handler = buildHandler({
      scope: {
        grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] },
        target: {
          channelId: consoleId,
          visibility: 'org',
          isSecureReview: false,
        },
      },
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: consoleId,
          message: 'The prior row says so.',
          citedMessageIds: [unrelated],
          replyToMessageId: question,
        },
        // Pretend the run reports the row as exposed so this assertion reaches
        // the current source-scope check, rather than only the exposure-id gate.
        provenance: {
          channels: [{ channelId: consoleId, source: 'initial_payload' }],
          messageIds: [question, unrelated],
          memoryScopes: [],
          memoryIds: [],
          charsExposed: 0,
          charBudget: 60_000,
        },
      }),
    });

    const result = await handler.runDirectAnswer(question, consoleId);

    expectNeutralFallback(result);
    expect(onlyOutboxContent()).not.toContain('prior row');
  });

  it('suppresses when an org thread parent becomes ingestion-disabled during the run', async () => {
    const threadId = seedChannel('100000000000000015', 'normal-org-thread', {
      parentId: ORG_CHANNEL,
      isThread: true,
    });
    const question = seedMessage(
      'msg-parent-disabled-question',
      threadId,
      '<@mneme> what is the status?',
    );
    const completeRun = fakeExecutor({
      proposal: {
        targetChannelId: threadId,
        message: 'The status is green.',
        citedMessageIds: [],
        replyToMessageId: question,
      },
    });
    const handler = buildHandler({
      scope: {
        grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] },
        target: {
          channelId: threadId,
          scopeChannelId: ORG_CHANNEL,
          visibility: 'org',
          isSecureReview: false,
        },
      },
      executeRun: async (deps) => {
        deps.db.prepare('UPDATE channels SET ingest_enabled = 0 WHERE id = ?').run(ORG_CHANNEL);
        return completeRun(deps);
      },
    });

    const result = await handler.runDirectAnswer(question, threadId);

    expect(result.kind).toBe('suppressed');
    expect(result.reasonCategory).toBe('policy_disabled');
    expect(outboxCount()).toBe(0);
  });
});

describe('createDirectAnswerHandler — run and message state', () => {
  it('supplies bounded preceding context, a reply parent, and exact initial provenance', async () => {
    const parent = seedMessage(
      'msg-context-parent',
      ORG_CHANNEL,
      'The older message this question replies to.',
      { createdAtMs: NOW - 20_000 },
    );
    for (let i = 0; i < 11; i++) {
      seedMessage(`msg-context-${String(i).padStart(2, '0')}`, ORG_CHANNEL, `context ${i}`, {
        createdAtMs: NOW - 11_000 + i * 1_000,
      });
    }
    const question = seedMessage('msg-context-question', ORG_CHANNEL, '<@mneme> what about that?', {
      createdAtMs: NOW,
      replyToMessageId: parent,
    });
    seedMessage('msg-context-after', ORG_CHANNEL, 'This arrived later.', { createdAtMs: NOW + 1_000 });
    seedMessage('msg-context-child', ORG_CHANNEL, 'A later reply to the question.', {
      createdAtMs: NOW + 2_000,
      replyToMessageId: question,
    });

    let rendered: Record<string, unknown> | undefined;
    let capturedRun: ExecuteAgentRunDeps | undefined;
    const promptCompiler = {
      render: (_name: string, context: Record<string, unknown>) => {
        rendered = context;
        return 'rendered prompt';
      },
      versionFor: () => 'pv',
    } as unknown as PromptCompiler;
    const baseExecutor = fakeExecutor();
    const handler = buildHandler({
      promptCompiler,
      executeRun: async (deps) => {
        capturedRun = deps;
        return baseExecutor(deps);
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expect(result.kind).toBe('answered');
    expect(rendered?.question).toMatchObject({
      messageId: question,
      channelId: ORG_CHANNEL,
      content: '<@mneme> what about that?',
      replyToMessageId: parent,
    });
    // Outside the secure review channel no proposal record is attached.
    expect(rendered?.referencedProposal).toBeNull();
    const preceding = rendered?.precedingConversation as Array<{ messageId: string }>;
    expect(preceding).toHaveLength(11); // ten immediate predecessors + the older reply parent
    expect(preceding.map((message) => message.messageId)).toContain(parent);
    expect(preceding.map((message) => message.messageId)).not.toContain('msg-context-00');
    expect(preceding.map((message) => message.messageId)).not.toContain('msg-context-after');
    expect(preceding.map((message) => message.messageId)).not.toContain('msg-context-child');
    expect(capturedRun?.initialProvenanceMessages?.map(({ messageId, channelId }) => ({
      messageId,
      channelId,
    }))).toEqual([
      ...preceding.map((message) => ({ messageId: message.messageId, channelId: ORG_CHANNEL })),
      { messageId: question, channelId: ORG_CHANNEL },
    ]);
    expect(capturedRun?.requestCreatedAtMs).toBe(NOW);
    expect(capturedRun?.requestDeadlineAtMs).toBe(NOW + DIRECT_ANSWER_DEADLINE_MS);
    expect(capturedRun?.limits?.wallClockMs).toBe(DIRECT_ANSWER_DEADLINE_MS);
  });

  it('enqueues a neutral fallback when the run does not finalize', async () => {
    seedMessage('msg-q-10', ORG_CHANNEL, '<@mneme> hi');
    const handler = buildHandler({ executeRun: fakeExecutor({ outcome: 'no_finalization' }) });
    const res = await handler.runDirectAnswer('msg-q-10', ORG_CHANNEL);
    expectNeutralFallback(res, 'no_finalization');
    expect(res.reasonCategory).toBe('no_finalization');
  });

  it('records an intentional suppression when the question message does not exist', async () => {
    const handler = buildHandler();
    const res = await handler.runDirectAnswer('nope', ORG_CHANNEL);
    expect(res.kind).toBe('suppressed');
    expect(res.reasonCategory).toBe('missing_source');
    expect(outboxCount()).toBe(0);
  });

  it('records an intentional suppression when the question is not in the pinned channel', async () => {
    const q = seedMessage('msg-q-11', env.channelId, '<@mneme> hi'); // restricted channel
    const handler = buildHandler();
    const res = await handler.runDirectAnswer(q, ORG_CHANNEL); // pinned to a different channel
    expect(res.kind).toBe('suppressed');
    expect(res.reasonCategory).toBe('target_invalid');
  });
});

describe('createDirectAnswerHandler — durable completion and safe fallback', () => {
  it('turns prompt-preparation failures into a neutral fallback instead of silent job success', async () => {
    const sensitive = 'prompt-render-private-detail';
    const question = seedMessage('msg-prompt-fallback', ORG_CHANNEL, '<@mneme> catch me up');
    const promptCompiler = {
      render: () => { throw new Error(sensitive); },
      versionFor: () => 'unreachable',
    } as unknown as PromptCompiler;
    const handler = buildHandler({ promptCompiler });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result, 'model_error');
    expect(JSON.stringify(getDirectAnswerRequest(env.db, question))).not.toContain(sensitive);
    expect(onlyOutboxContent()).not.toContain(sensitive);
  });

  it('atomically links the source, job, run, and stable outbox intent', async () => {
    const question = seedMessage('msg-durable-primary', ORG_CHANNEL, '<@mneme> status?');
    const queued = enqueue(env.db, {
      type: 'direct_answer',
      payload: { messageId: question, channelId: ORG_CHANNEL },
      uniqueKey: `direct:${question}`,
      now: NOW,
    });
    const job = getJob(env.db, queued.id)!;
    let executions = 0;
    const handler = buildHandler({
      executeRun: async (deps) => {
        executions += 1;
        return fakeExecutor({ runId: 'run-durable-primary' })(deps);
      },
    });

    const first = await handler.runDirectAnswer(question, ORG_CHANNEL, job);
    const second = await handler.runDirectAnswer(question, ORG_CHANNEL, job);

    expect(first.kind).toBe('answered');
    expect(second).toMatchObject({ kind: 'answered', outboxId: first.outboxId });
    expect(executions).toBe(1);
    expect(outboxCount()).toBe(1);
    expect(getDirectAnswerRequest(env.db, question)).toMatchObject({
      sourceMessageId: question,
      jobId: job.id,
      runId: 'run-durable-primary',
      outboxId: first.outboxId,
      targetChannelId: ORG_CHANNEL,
      questionCreatedAtMs: NOW,
      deadlineAtMs: NOW + DIRECT_ANSWER_DEADLINE_MS,
      outcomeKind: 'primary',
      reasonCategory: 'none',
    });
  });

  it('turns model-admission timeout into one neutral, source-anchored fallback', async () => {
    const question = seedMessage('msg-admission-fallback', ORG_CHANNEL, '<@mneme> catch me up');
    const handler = buildHandler({
      executeRun: async () => { throw new ModelAdmissionTimeoutError(60_000); },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result, 'admission_timeout');
    expect(env.db.prepare('SELECT reply_to_message_id FROM outbox').get()).toEqual({
      reply_to_message_id: question,
    });
    expect(getDirectAnswerRequest(env.db, question)).toMatchObject({
      outcomeKind: 'fallback',
      reasonCategory: 'admission_timeout',
      outboxId: result.outboxId,
    });
  });

  it('retries one transient run only when worst-case queue backoff fits the deadline', async () => {
    const question = seedMessage('msg-transient-retry-fits', ORG_CHANNEL, '<@mneme> catch me up');
    const queued = enqueue(env.db, {
      type: 'direct_answer',
      payload: { messageId: question, channelId: ORG_CHANNEL },
      uniqueKey: `direct:${question}`,
      maxAttempts: 2,
      now: NOW,
    });
    const job = { ...getJob(env.db, queued.id)!, attempts: 1 };
    const handler = buildHandler({
      executeRun: async () => { throw new TransientJobError('provider unavailable'); },
    });

    await expect(handler.runDirectAnswer(question, ORG_CHANNEL, job))
      .rejects.toBeInstanceOf(TransientJobError);
    expect(getDirectAnswerRequest(env.db, question)?.outcomeKind).toBe('pending');
    expect(outboxCount()).toBe(0);
  });

  it('falls back when worst-case retry backoff would overrun the immutable deadline', async () => {
    const question = seedMessage('msg-transient-retry-too-late', ORG_CHANNEL, '<@mneme> catch me up');
    const queued = enqueue(env.db, {
      type: 'direct_answer',
      payload: { messageId: question, channelId: ORG_CHANNEL },
      uniqueKey: `direct:${question}`,
      maxAttempts: 2,
      now: NOW,
    });
    const job = { ...getJob(env.db, queued.id)!, attempts: 1 };
    const currentNow = NOW + DIRECT_ANSWER_DEADLINE_MS - 11_500;
    const handler = buildHandler({
      now: () => currentNow,
      executeRun: async () => { throw new TransientJobError('provider unavailable'); },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL, job);

    expectNeutralFallback(result, 'model_error');
    expect(getDirectAnswerRequest(env.db, question)?.outcomeKind).toBe('fallback');
  });

  it('falls back when the validated primary response cannot be persisted', async () => {
    const question = seedMessage('msg-primary-enqueue-fails', ORG_CHANNEL, '<@mneme> status?');
    env.db.exec(`CREATE TRIGGER reject_primary_direct_outbox BEFORE INSERT ON outbox
      WHEN NEW.content = 'Here is the answer.'
      BEGIN SELECT RAISE(ABORT, 'simulated primary outbox failure'); END`);
    const handler = buildHandler();

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result, 'model_error');
    expect(getDirectAnswerRequest(env.db, question)).toMatchObject({
      outcomeKind: 'fallback',
      reasonCategory: 'model_error',
      outboxId: result.outboxId,
    });
  });

  it('rolls back a stale answer when another execution suppresses the request first', async () => {
    const question = seedMessage('msg-terminal-race', ORG_CHANNEL, '<@mneme> status?');
    const duplicate: DuplicateResult = {
      matched: true,
      kind: 'near',
      similarity: 0.99,
      matchedPreview: 'existing reply',
      matchedSentAtMs: NOW - 1,
      source: 'outbox',
    };
    let executions = 0;
    let releaseSecond!: () => void;
    const firstValidated = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const handler = buildHandler({
      executeRun: async (deps) => {
        executions += 1;
        const index = executions;
        if (index === 2) await firstValidated;
        return fakeExecutor({
          runId: `run-terminal-race-${index}`,
          proposal: {
            targetChannelId: ORG_CHANNEL,
            message: index === 1 ? 'suppress this response' : 'stale answer must not send',
            citedMessageIds: [],
          },
        })(deps);
      },
      rateChecks: (_channelId, content) => {
        if (content === 'suppress this response') {
          releaseSecond();
          return { cooldown: cooldownAllow, duplicate };
        }
        return { cooldown: cooldownAllow, duplicate: noDuplicate };
      },
    });

    const [winner, stale] = await Promise.all([
      handler.runDirectAnswer(question, ORG_CHANNEL),
      handler.runDirectAnswer(question, ORG_CHANNEL),
    ]);

    expect(winner).toMatchObject({ kind: 'suppressed', reasonCategory: 'duplicate' });
    expect(stale).toMatchObject({ kind: 'suppressed', reasonCategory: 'duplicate' });
    expect(getDirectAnswerRequest(env.db, question)).toMatchObject({
      outcomeKind: 'suppressed',
      reasonCategory: 'duplicate',
      outboxId: null,
    });
    expect(outboxCount()).toBe(0);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='send_outbox'").get())
      .toEqual({ n: 0 });
  });

  it('stores no provider error or retrieved content in the durable outcome or fallback', async () => {
    const sensitive = 'customer-secret-error-detail';
    const question = seedMessage('msg-private-fallback', ORG_CHANNEL, `<@mneme> ${sensitive}`);
    const handler = buildHandler({
      executeRun: async () => { throw new Error(sensitive); },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result, 'model_error');
    const durable = env.db.prepare(
      'SELECT * FROM direct_answer_requests WHERE source_message_id = ?',
    ).get(question);
    expect(JSON.stringify(durable)).not.toContain(sensitive);
    expect(onlyOutboxContent()).not.toContain(sensitive);
  });

  it('throws and leaves the request pending when fallback enqueue fails', async () => {
    const question = seedMessage('msg-fallback-enqueue-fails', ORG_CHANNEL, '<@mneme> status?');
    env.db.exec(`CREATE TRIGGER reject_direct_outbox BEFORE INSERT ON outbox
      BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END`);
    const handler = buildHandler({
      executeRun: async () => { throw new ModelAdmissionTimeoutError(); },
    });

    await expect(handler.runDirectAnswer(question, ORG_CHANNEL)).rejects.toThrow(
      'simulated outbox failure',
    );
    expect(outboxCount()).toBe(0);
    expect(getDirectAnswerRequest(env.db, question)?.outcomeKind).toBe('pending');
  });

  it('records partial snapshot coverage, requires a snapshot citation, and appends a footer', async () => {
    seedMessage('msg-snapshot-omitted', ORG_CHANNEL, 'A second recent update.', {
      createdAtMs: NOW - 2_000,
    });
    const cited = seedMessage('msg-snapshot-cited', ORG_CHANNEL, 'A recent deploy decision.', {
      createdAtMs: NOW - 1_000,
    });
    const question = seedMessage('msg-snapshot-question', ORG_CHANNEL, '<@mneme> catch me up');
    const provenance = {
      channels: [{ channelId: ORG_CHANNEL, source: 'activity_snapshot' as const }],
      messageIds: [question, cited],
      memoryScopes: [],
      memoryIds: [],
      charsExposed: 40,
      charBudget: 60_000,
      recentActivitySnapshot: {
        afterMs: NOW - 86_400_000,
        beforeMs: NOW,
        requestedChannelIds: null,
        totalMatching: 2,
        included: 1,
        matchingChannelCount: 1,
        includedChannelCount: 1,
        oldestMatchedAtMs: NOW - 2_000,
        newestMatchedAtMs: NOW - 1_000,
        oldestIncludedAtMs: NOW - 1_000,
        newestIncludedAtMs: NOW - 1_000,
        complete: false,
        omitted: 1,
        truncationReason: 'character_cap' as const,
        exposedMessageIds: [cited],
        matchedChannelIds: [ORG_CHANNEL],
      },
    };
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: ORG_CHANNEL,
          message: 'The recent deploy decision is the main update.',
          citedMessageIds: [cited],
        },
        provenance,
      }),
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expect(result.kind).toBe('partial');
    expect(onlyOutboxContent()).toContain('Coverage: partial — analyzed a balanced sample of 1/2');
    expect(getDirectAnswerRequest(env.db, question)).toMatchObject({
      outcomeKind: 'partial',
      coverage: {
        complete: false,
        omitted: 1,
        truncationReason: 'character_cap',
        matchedMessages: 2,
        includedMessages: 1,
      },
    });
  });

  it('preserves dual message-and-character truncation after refreshing snapshot coverage', async () => {
    const matchingMessages = RECENT_ACTIVITY_SNAPSHOT_MAX_MESSAGES + 1;
    let cited = '';
    for (let index = 0; index < matchingMessages; index += 1) {
      const messageId = `msg-dual-cap-${index}`;
      seedMessage(messageId, ORG_CHANNEL, `Recent update ${index}.`, {
        createdAtMs: NOW - 1_000 - index,
      });
      if (index === 0) cited = messageId;
    }
    const question = seedMessage(
      'msg-dual-cap-question',
      ORG_CHANNEL,
      '<@mneme> catch me up',
    );
    const provenance = {
      channels: [{ channelId: ORG_CHANNEL, source: 'activity_snapshot' as const }],
      messageIds: [question, cited],
      memoryScopes: [],
      memoryIds: [],
      charsExposed: 40,
      charBudget: 60_000,
      recentActivitySnapshot: {
        afterMs: NOW - 86_400_000,
        beforeMs: NOW,
        requestedChannelIds: null,
        totalMatching: matchingMessages,
        included: 1,
        matchingChannelCount: 1,
        includedChannelCount: 1,
        oldestMatchedAtMs: NOW - 1_000 - (matchingMessages - 1),
        newestMatchedAtMs: NOW - 1_000,
        oldestIncludedAtMs: NOW - 1_000,
        newestIncludedAtMs: NOW - 1_000,
        complete: false,
        omitted: matchingMessages - 1,
        truncationReason: 'message_and_character_cap' as const,
        exposedMessageIds: [cited],
        matchedChannelIds: [ORG_CHANNEL],
      },
    };
    const handler = buildHandler({
      executeRun: fakeExecutor({
        proposal: {
          targetChannelId: ORG_CHANNEL,
          message: 'The newest recent update is the main item.',
          citedMessageIds: [cited],
        },
        provenance,
      }),
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expect(result.kind).toBe('partial');
    expect(getDirectAnswerRequest(env.db, question)).toMatchObject({
      outcomeKind: 'partial',
      coverage: {
        complete: false,
        omitted: matchingMessages - 1,
        truncationReason: 'message_and_character_cap',
        matchedMessages: matchingMessages,
        includedMessages: 1,
      },
    });
  });

  it('falls back when a nonempty snapshot answer cites none of its exposed rows', async () => {
    const cited = seedMessage('msg-snapshot-uncited', ORG_CHANNEL, 'A recent decision.', {
      createdAtMs: NOW - 1_000,
    });
    const question = seedMessage('msg-snapshot-no-citation', ORG_CHANNEL, '<@mneme> catch me up');
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'Here is the update.',
        citedMessageIds: [],
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        (result.provenance as AgentRunResult['provenance'] & Record<string, unknown>)
          .recentActivitySnapshot = {
            afterMs: NOW - 10_000, beforeMs: NOW, requestedChannelIds: null,
            totalMatching: 1, included: 1,
            matchingChannelCount: 1, includedChannelCount: 1,
            oldestMatchedAtMs: NOW - 1_000, newestMatchedAtMs: NOW - 1_000,
            oldestIncludedAtMs: NOW - 1_000, newestIncludedAtMs: NOW - 1_000,
            complete: true, omitted: 0, truncationReason: 'none', exposedMessageIds: [cited],
            matchedChannelIds: [ORG_CHANNEL],
          };
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result);
  });

  it('falls back when a nonempty snapshot claims it exposed zero rows', async () => {
    const question = seedMessage(
      'msg-snapshot-zero-included',
      ORG_CHANNEL,
      '<@mneme> catch me up',
    );
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'The available snapshot could not fit any message rows.',
        citedMessageIds: [],
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        (result.provenance as AgentRunResult['provenance'] & Record<string, unknown>)
          .recentActivitySnapshot = {
            afterMs: NOW - 10_000, beforeMs: NOW, requestedChannelIds: null,
            totalMatching: 1, included: 0,
            matchingChannelCount: 1, includedChannelCount: 0,
            oldestMatchedAtMs: NOW - 1_000, newestMatchedAtMs: NOW - 1_000,
            oldestIncludedAtMs: null, newestIncludedAtMs: null,
            complete: false, omitted: 1, truncationReason: 'character_cap',
            exposedMessageIds: [], matchedChannelIds: [ORG_CHANNEL],
          };
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result, 'malformed');
    expect(onlyOutboxContent()).not.toContain('available snapshot');
  });

  it('falls back when snapshot provenance claims an empty time interval', async () => {
    const question = seedMessage(
      'msg-snapshot-empty-interval',
      ORG_CHANNEL,
      '<@mneme> catch me up',
    );
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'There was no permitted activity in that interval.',
        citedMessageIds: [],
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        result.provenance.recentActivitySnapshot = {
          afterMs: NOW,
          beforeMs: NOW,
          requestedChannelIds: null,
          totalMatching: 0,
          included: 0,
          matchingChannelCount: 0,
          includedChannelCount: 0,
          oldestMatchedAtMs: null,
          newestMatchedAtMs: null,
          oldestIncludedAtMs: null,
          newestIncludedAtMs: null,
          complete: true,
          omitted: 0,
          truncationReason: 'none',
          exposedMessageIds: [],
          matchedChannelIds: [],
        };
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result, 'malformed');
    expect(onlyOutboxContent()).not.toContain('no permitted activity');
  });

  it('allows an empty snapshot only with a host-authored complete coverage footer', async () => {
    const question = seedMessage('msg-snapshot-empty', ORG_CHANNEL, '<@mneme> catch me up');
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'There was no permitted activity in that window.',
        citedMessageIds: [],
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        result.provenance.recentActivitySnapshot = {
          afterMs: NOW - 10_000,
          beforeMs: NOW,
          requestedChannelIds: null,
          totalMatching: 0,
          included: 0,
          matchingChannelCount: 0,
          includedChannelCount: 0,
          oldestMatchedAtMs: null,
          newestMatchedAtMs: null,
          oldestIncludedAtMs: null,
          newestIncludedAtMs: null,
          complete: true,
          omitted: 0,
          truncationReason: 'none',
          exposedMessageIds: [],
          matchedChannelIds: [],
        };
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expect(result.kind).toBe('answered');
    expect(onlyOutboxContent()).toContain('Coverage: complete — analyzed all 0 matching messages');
  });

  it('falls back when a proven-empty window becomes nonempty before delivery', async () => {
    const question = seedMessage(
      'msg-snapshot-empty-race',
      ORG_CHANNEL,
      '<@mneme> catch me up',
    );
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'There was no activity in that window.',
        citedMessageIds: [],
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        result.provenance.recentActivitySnapshot = {
          afterMs: NOW - 10_000,
          beforeMs: NOW,
          requestedChannelIds: null,
          totalMatching: 0,
          included: 0,
          matchingChannelCount: 0,
          includedChannelCount: 0,
          oldestMatchedAtMs: null,
          newestMatchedAtMs: null,
          oldestIncludedAtMs: null,
          newestIncludedAtMs: null,
          complete: true,
          omitted: 0,
          truncationReason: 'none',
          exposedMessageIds: [],
          matchedChannelIds: [],
        };
        seedMessage('msg-snapshot-late-backfill', ORG_CHANNEL, 'A late-ingested update.', {
          createdAtMs: NOW - 1_000,
        });
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result, 'malformed');
    expect(onlyOutboxContent()).not.toContain('no activity');
  });

  it('rejects a model-authored coverage line and keeps host coverage authoritative', async () => {
    const question = seedMessage(
      'msg-snapshot-model-coverage',
      ORG_CHANNEL,
      '<@mneme> catch me up',
    );
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'Coverage: complete — I reviewed everything.\nNo activity.',
        citedMessageIds: [],
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        result.provenance.recentActivitySnapshot = {
          afterMs: NOW - 10_000,
          beforeMs: NOW,
          requestedChannelIds: null,
          totalMatching: 0,
          included: 0,
          matchingChannelCount: 0,
          includedChannelCount: 0,
          oldestMatchedAtMs: null,
          newestMatchedAtMs: null,
          oldestIncludedAtMs: null,
          newestIncludedAtMs: null,
          complete: true,
          omitted: 0,
          truncationReason: 'none',
          exposedMessageIds: [],
          matchedChannelIds: [],
        };
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result);
    expect(onlyOutboxContent()).not.toContain('I reviewed everything');
  });

  it('rechecks the clock after model work and never enqueues a late primary answer', async () => {
    const question = seedMessage('msg-late-primary', ORG_CHANNEL, '<@mneme> status?');
    let currentNow = NOW;
    const base = fakeExecutor({
      proposal: { targetChannelId: ORG_CHANNEL, message: 'Late facts.', citedMessageIds: [] },
    });
    const handler = buildHandler({
      now: () => currentNow,
      executeRun: async (deps) => {
        const result = await base(deps);
        currentNow = NOW + DIRECT_ANSWER_DEADLINE_MS;
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expectNeutralFallback(result, 'deadline_exceeded');
    expect(onlyOutboxContent()).not.toContain('Late facts');
    const request = getDirectAnswerRequest(env.db, question)!;
    expect(request.completedAtMs).toBe(currentNow);
    expect(request.deadlineAtMs).toBe(NOW + DIRECT_ANSWER_DEADLINE_MS);
  });

  it('recomputes coverage when an omitted channel tightens scope before delivery', async () => {
    const omittedChannel = seedChannel('100000000000000099', 'recent-other-org');
    seedMessage('msg-race-omitted', omittedChannel, 'Soon-to-be restricted.', {
      createdAtMs: NOW - 2_000,
    });
    const cited = seedMessage('msg-race-cited', ORG_CHANNEL, 'Permitted recent item.', {
      createdAtMs: NOW - 1_000,
    });
    const question = seedMessage('msg-race-question', ORG_CHANNEL, '<@mneme> catch me up');
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'Here is the recent activity.',
        citedMessageIds: [cited],
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        (result.provenance as AgentRunResult['provenance'] & Record<string, unknown>)
          .recentActivitySnapshot = {
            afterMs: NOW - 10_000, beforeMs: NOW, requestedChannelIds: null,
            totalMatching: 5, included: 1,
            matchingChannelCount: 2, includedChannelCount: 1,
            oldestMatchedAtMs: NOW - 9_000, newestMatchedAtMs: NOW - 1_000,
            oldestIncludedAtMs: NOW - 1_000, newestIncludedAtMs: NOW - 1_000,
            complete: false, omitted: 4, truncationReason: 'message_cap',
            exposedMessageIds: [cited], matchedChannelIds: [ORG_CHANNEL, omittedChannel],
          };
        deps.db.prepare("UPDATE channels SET visibility_class='restricted' WHERE id=?")
          .run(omittedChannel);
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expect(result.kind).toBe('answered');
    expect(onlyOutboxContent()).not.toContain('5 matching');
    expect(onlyOutboxContent()).toContain('Coverage: complete — analyzed all 1 matching messages');
  });

  it('recomputes coverage when an omitted channel becomes a Mneme test surface', async () => {
    const omittedChannel = seedChannel('100000000000000098', 'recent-rename-source');
    seedMessage('msg-rename-omitted', omittedChannel, 'Soon-to-be a test surface.', {
      createdAtMs: NOW - 2_000,
    });
    const cited = seedMessage('msg-rename-cited', ORG_CHANNEL, 'Permitted recent item.', {
      createdAtMs: NOW - 1_000,
    });
    const question = seedMessage('msg-rename-question', ORG_CHANNEL, '<@mneme> catch me up');
    const base = fakeExecutor({
      proposal: {
        targetChannelId: ORG_CHANNEL,
        message: 'Here is the recent activity.',
        citedMessageIds: [cited],
      },
    });
    const handler = buildHandler({
      executeRun: async (deps) => {
        const result = await base(deps);
        (result.provenance as AgentRunResult['provenance'] & Record<string, unknown>)
          .recentActivitySnapshot = {
            afterMs: NOW - 10_000, beforeMs: NOW, requestedChannelIds: null,
            totalMatching: 5, included: 1,
            matchingChannelCount: 2, includedChannelCount: 1,
            oldestMatchedAtMs: NOW - 9_000, newestMatchedAtMs: NOW - 1_000,
            oldestIncludedAtMs: NOW - 1_000, newestIncludedAtMs: NOW - 1_000,
            complete: false, omitted: 4, truncationReason: 'message_cap',
            exposedMessageIds: [cited], matchedChannelIds: [ORG_CHANNEL, omittedChannel],
          };
        deps.db.prepare('UPDATE channels SET name = ? WHERE id = ?')
          .run('mneme-renamed-console', omittedChannel);
        return result;
      },
    });

    const result = await handler.runDirectAnswer(question, ORG_CHANNEL);

    expect(result.kind).toBe('answered');
    expect(onlyOutboxContent()).toContain('Coverage: complete — analyzed all 1 matching messages');
  });
});

function outboxCount(): number {
  return (env.db.prepare('SELECT COUNT(*) AS c FROM outbox').get() as { c: number }).c;
}

function onlyOutboxContent(): string {
  return (env.db.prepare('SELECT content FROM outbox').get() as { content: string }).content;
}

function expectNeutralFallback(
  result: { kind: string; reasonCategory?: string },
  reasonCategory = 'validation_rejection',
): void {
  expect(result.kind).toBe('fallback');
  expect(result.reasonCategory).toBe(reasonCategory);
  expect(outboxCount()).toBe(1);
  expect(onlyOutboxContent()).toBe(DIRECT_ANSWER_FALLBACK_MESSAGE);
}

describe('referenced proposal resolution in the secure review channel — Section 26', () => {
  const REVIEW = 'review-channel-0000001';

  const reviewScope: DirectAnswerChannelScope = {
    grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: true, channelIds: [REVIEW] },
    target: { channelId: REVIEW, visibility: 'restricted' as VisibilityClass, isSecureReview: true },
  };

  function seedCardProposal(cardId: string, cardAtMs: number, message: string): string {
    seedMessage(cardId, REVIEW, '', { createdAtMs: cardAtMs });
    const proposalId = insertProposal(env.db, {
      runId: 'card-run-1',
      targetChannelId: ORG_CHANNEL,
      status: 'pending_review',
      computedScore: 1,
      reason: ['recommended; routed to secure review'],
      reviewReason: 'The subject needs a current status.',
      message,
      evidenceMessageIds: [],
      expiresAtMs: NOW + 72 * 60 * 60_000,
      now: cardAtMs,
    });
    setProposalReviewMessage(env.db, proposalId, cardId, cardAtMs);
    return proposalId;
  }

  function reviewSetup(): void {
    seedChannel(REVIEW, 'review', { visibilityClass: 'restricted', allowInterventions: false });
    env.db
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
         VALUES (?,?,NULL,'scheduled_review','scheduled-review@v1','faux','faux-1','completed',?)`,
      )
      .run('card-run-1', env.guildId, NOW);
  }

  function captureHandler(): {
    handler: ReturnType<typeof buildHandler>;
    rendered: () => Record<string, unknown> | undefined;
  } {
    let context: Record<string, unknown> | undefined;
    const promptCompiler = {
      render: (_name: string, ctx: Record<string, unknown>) => {
        context = ctx;
        return 'rendered prompt';
      },
      versionFor: () => 'pv',
    } as unknown as PromptCompiler;
    const handler = buildHandler({
      promptCompiler,
      scope: reviewScope,
      executeRun: fakeExecutor({
        proposal: { targetChannelId: REVIEW, message: 'About that proposal.', citedMessageIds: [] },
      }),
    });
    return { handler, rendered: () => context };
  }

  it('resolves the exact card the question replies to', async () => {
    reviewSetup();
    const older = seedCardProposal('card-older', NOW - 30_000, 'Older proposed text.');
    const target = seedCardProposal('card-target', NOW - 20_000, 'Please record the launch status.');
    seedCardProposal('card-newest', NOW - 10_000, 'Newest proposed text.');
    void older;
    const question = seedMessage('msg-rev-q1', REVIEW, '<@mneme> is this proposal still current?', {
      createdAtMs: NOW,
      replyToMessageId: 'card-target',
    });

    const { handler, rendered } = captureHandler();
    const result = await handler.runDirectAnswer(question, REVIEW);

    expect(result.kind).toBe('answered');
    expect(rendered()?.referencedProposal).toMatchObject({
      proposalId: target,
      shortId: proposalShortId(target),
      status: 'pending_review',
      targetChannelLabel: '#general',
      message: 'Please record the launch status.',
      reviewReason: 'The subject needs a current status.',
      subjectMemoryIds: [],
    });
  });

  it('falls back to the newest card before the question when not a reply', async () => {
    reviewSetup();
    seedCardProposal('card-a', NOW - 30_000, 'First proposed text.');
    const newest = seedCardProposal('card-b', NOW - 10_000, 'Second proposed text.');
    const question = seedMessage('msg-rev-q2', REVIEW, '<@mneme> this proposal is super old', {
      createdAtMs: NOW,
    });

    const { handler, rendered } = captureHandler();
    const result = await handler.runDirectAnswer(question, REVIEW);

    expect(result.kind).toBe('answered');
    expect(rendered()?.referencedProposal).toMatchObject({
      proposalId: newest,
      message: 'Second proposed text.',
    });
  });

  it('attaches null when the review channel has no cards', async () => {
    reviewSetup();
    const question = seedMessage('msg-rev-q3', REVIEW, '<@mneme> anything pending?', {
      createdAtMs: NOW,
    });

    const { handler, rendered } = captureHandler();
    const result = await handler.runDirectAnswer(question, REVIEW);

    expect(result.kind).toBe('answered');
    expect(rendered()?.referencedProposal).toBeNull();
  });
});
