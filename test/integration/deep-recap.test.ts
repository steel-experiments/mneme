import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  completeDeepRecapChunk,
  cancelDeepRecap,
  createDeepRecap,
  deepRecapDailySpend,
  getDeepRecap,
  replaceDeepRecapPlan,
  reserveDeepRecapModelCall,
  retryDeepRecapSynthesis,
  settleDeepRecapModelCallCost,
} from '../../src/deep-recap/repository.js';
import { createDeepRecapHandler } from '../../src/jobs/handlers/deep-recap.js';
import { DeferJobError, PermanentJobError, TransientJobError } from '../../src/jobs/errors.js';
import { loadPromptCompiler } from '../../src/agent/prompts.js';
import { fingerprintExposedMessage } from '../../src/agent/run-context.js';
import type { AgentRunResult, ExecuteAgentRunDeps } from '../../src/agent/runtime.js';
import { emptyAgentRunUsage } from '../../src/agent/usage.js';

const NOW = 1_700_000_000_000;
const CHANNEL = '100000000000000099';

describe('durable deep recap worker', () => {
  let env: TestDb;
  let ids: ReturnType<typeof seedIdentity>;
  beforeEach(() => {
    env = createTestDb();
    ids = seedIdentity(env.db);
    upsertChannel(env.db, {
      id: CHANNEL, guildId: ids.guildId, parentId: null, type: 0, name: 'general', topic: null,
      position: 0, isThread: false, isArchived: false, isLocked: false, ingestEnabled: true,
      visibilityClass: 'org', allowInterventions: true, permissionFingerprint: null,
      lastMessageId: null, discoveredAtMs: NOW, updatedAtMs: NOW, rawJson: null,
    });
  });
  afterEach(() => env.cleanup());

  function addMessage(
    id: string,
    content: string,
    channelId = CHANNEL,
    createdAtMs = NOW - 1_000,
  ): void {
    upsertMessageCreate(env.db, {
      id, guildId: ids.guildId, channelId, authorId: ids.userId,
      authorDisplayName: 'Alice', content, createdAtMs, editedAtMs: null,
      replyToMessageId: null, messageType: 0, flags: null, pinned: false,
      mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]', componentsJson: '[]',
      pollJson: null, rawJson: null, ingestedAtMs: NOW, updatedAtMs: NOW,
    });
  }

  function executor(): (deps: ExecuteAgentRunDeps) => Promise<AgentRunResult> {
    let sequence = 0;
    return async (deps) => {
      sequence += 1;
      const runId = deps.runId ?? `deep-run-${sequence}`;
      env.db.prepare(`INSERT INTO agent_runs
        (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms,cost_usd)
        VALUES (?,?,'direct_answer','deep','faux','faux','completed',?,0.01)`)
        .run(runId, ids.guildId, NOW);
      const initial = deps.initialProvenanceMessages ?? [];
      const cited = initial[0]?.messageId;
      const provenance = {
        channels: (deps.initialProvenanceChannelIds ?? []).map((channelId) => ({
          channelId, source: 'initial_payload' as const,
        })),
        messageIds: initial.map((row) => row.messageId),
        messageFingerprints: initial.flatMap((row) => row.fingerprint
          ? [{ messageId: row.messageId, fingerprint: row.fingerprint }]
          : []),
        memoryScopes: [], memoryIds: [], memoryFingerprints: [], charsExposed: 0, charBudget: 0,
      };
      return {
        runId, status: 'completed', outcome: 'finalized', failureReason: null,
        turns: 1, modelTurns: [], toolCalls: [],
        usage: { ...emptyAgentRunUsage(), inputTokens: 10, outputTokens: 10, costUsd: 0.01 },
        provenance,
        finalProposal: {
          kind: 'direct_answer',
          proposal: {
            targetChannelId: CHANNEL,
            message: cited
              ? `Infrastructure capacity remains the main issue. [[cite:${cited}]]`
              : 'No consequential activity was found.',
            citedMessageIds: cited ? [cited] : [],
          },
        },
        startedAtMs: NOW, endedAtMs: NOW,
      };
    };
  }

  function handler(
    executeRun = executor(),
    enabled = true,
    resolveChannelScope = () => ({
      grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] },
      target: { channelId: CHANNEL, visibility: 'org' as const, isSecureReview: false },
    }),
  ) {
    return createDeepRecapHandler({
      db: env.db,
      guildId: ids.guildId,
      promptCompiler: loadPromptCompiler('prompts'),
      systemPrompt: 'You are Mneme. Target {{target.label}}.',
      resolveChannelScope,
      rateChecks: () => ({
        cooldown: { allowed: true, blocks: [], retryAfterMs: null },
        duplicate: { matched: false },
      }),
      executeRun,
      agent: { model: {} as never, thinkingLevel: 'medium', streamFn: {} as never,
        providerId: 'faux', modelId: 'faux' },
      mode: 'review',
      enabled,
      dailyBudgetUsd: 20,
      dayStartMs: () => NOW - 60_000,
      now: () => NOW,
    });
  }

  function failedSynthesisRequest(sourceId: string) {
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId,
      targetChannelId: CHANNEL,
      requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000,
      beforeAtMs: NOW,
      budgetUsd: 5,
      now: NOW - 3_000,
    });
    replaceDeepRecapPlan(env.db, request.id, [{
      afterAtMs: request.after_at_ms,
      beforeAtMs: request.before_at_ms,
      matchingMessages: 1,
      includedMessages: 1,
      complete: true,
    }], NOW - 2_000);
    const fingerprint = fingerprintExposedMessage(env.db, sourceId);
    if (!fingerprint) throw new Error('expected source fingerprint');
    completeDeepRecapChunk(env.db, {
      requestId: request.id,
      ordinal: 0,
      matchingMessages: 1,
      includedMessages: 1,
      coverageComplete: true,
      summary: 'Stored partition summary.',
      citedMessageIds: [sourceId],
      sourceMessageIds: [sourceId],
      sourceFingerprints: [{ messageId: sourceId, fingerprint }],
      costUsd: 0.01,
      now: NOW - 1_000,
    });
    env.db.prepare(`UPDATE deep_recap_requests
      SET status='failed',last_error_category='DEEP_RECAP_REPORT_TOO_LONG',
          completed_at_ms=?,updated_at_ms=? WHERE id=?`)
      .run(NOW - 500, NOW - 500, request.id);
    return getDeepRecap(env.db, request.id)!;
  }

  it('chunks, synthesizes, cites inline, and records actual bounded coverage and spend', async () => {
    addMessage('source-1', 'We need to set a safe browser density before adding production traffic.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 2_000,
    });
    const base = executor();
    const renderedRuns: ExecuteAgentRunDeps[] = [];
    const run = handler(async (deps) => {
      renderedRuns.push(deps);
      return base(deps);
    });
    await expect(run(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toBeInstanceOf(DeferJobError);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'running', planned_chunks: 1, completed_chunks: 1,
      total_matching_messages: 1, included_messages: 1, spent_usd: 0.01,
    });
    await run({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'completed', completed_chunks: 1, synthesis_cost_usd: 0.01, spent_usd: 0.02,
    });
    const outbox = env.db.prepare('SELECT content FROM outbox').get() as { content: string };
    expect(outbox.content).toContain('[#general · 2023-11-14](');
    expect(outbox.content).toContain('Coverage: complete');
    expect(outbox.content).toContain('1/1 messages in 1/1 partitions');
    expect(fingerprintExposedMessage(env.db, 'source-1')).toBeTruthy();
    expect(renderedRuns).toHaveLength(2);
    for (const [index, rendered] of renderedRuns.entries()) {
      const stable = rendered.promptText.indexOf(index === 0 ? 'Identify only consequential' : 'Organize the answer');
      const host = rendered.promptText.indexOf('<host_runtime_context>');
      const untrusted = rendered.promptText.indexOf(index === 0
        ? '<untrusted_recap_messages>'
        : '<untrusted_partition_summaries>');
      expect(stable).toBeGreaterThanOrEqual(0);
      expect(host).toBeGreaterThan(stable);
      expect(untrusted).toBeGreaterThan(host);
      expect(rendered.promptText.slice(host, untrusted)).toContain(new Date(request.before_at_ms).toISOString());
      expect(rendered.promptText.slice(host, untrusted)).toContain('Operating mode: review');
      expect(rendered.promptText.slice(host, untrusted)).toContain(`Target conversation: ${CHANNEL}`);
      expect(rendered.promptText.slice(host, untrusted)).toContain('Target visibility: org');
      expect(rendered.cacheProfile).toBe('recap');
    }
  });

  it('adaptively splits a dense day before model calls so all messages fit', async () => {
    for (let index = 0; index < 240; index += 1) {
      addMessage(
        `adaptive-${String(index).padStart(3, '0')}`,
        `Dense recap message ${index}.`,
        CHANNEL,
        NOW - 86_000_000 + index * 300_000,
      );
    }
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 2_000,
    });
    await expect(handler()(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toBeInstanceOf(DeferJobError);

    const chunks = env.db.prepare(`SELECT split_depth,truncation_reason,matching_messages,
      included_messages FROM deep_recap_chunks WHERE request_id=? ORDER BY ordinal`).all(request.id) as unknown as Array<Record<string, number | string>>;
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => Number(chunk.split_depth) > 0)).toBe(true);
    expect(chunks.reduce((sum, chunk) => sum + Number(chunk.matching_messages), 0)).toBe(240);
    expect(chunks.every((chunk) => chunk.truncation_reason === 'none')).toBe(true);
  });

  it('atomically queues an ordered coverage part when a longer partial report will not fit', async () => {
    addMessage('multipart-included', 'Included evidence for a long partial recap.');
    addMessage('multipart-omitted', 'Counted evidence omitted by the bounded partition.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 2_000,
    });
    replaceDeepRecapPlan(env.db, request.id, [{
      afterAtMs: request.after_at_ms, beforeAtMs: request.before_at_ms,
      matchingMessages: 2, includedMessages: 1, complete: false,
      truncationReason: 'character_cap',
    }], NOW - 1_500);
    completeDeepRecapChunk(env.db, {
      requestId: request.id, ordinal: 0, matchingMessages: 2, includedMessages: 1,
      coverageComplete: false, truncationReason: 'character_cap', summary: 'Stored summary.',
      citedMessageIds: [], sourceMessageIds: ['multipart-included'],
      sourceFingerprints: [{
        messageId: 'multipart-included',
        fingerprint: fingerprintExposedMessage(env.db, 'multipart-included')!,
      }],
      costUsd: 0.01, now: NOW - 1_000,
    });
    const base = executor();
    await handler(async (deps) => {
      const result = await base(deps);
      if (!deps.sessionId.endsWith(':synthesis')) return result;
      return {
        ...result,
        finalProposal: {
          kind: 'direct_answer' as const,
          proposal: { targetChannelId: CHANNEL, message: 'R'.repeat(1_800), citedMessageIds: [] },
        },
      };
    })({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never);

    expect(getDeepRecap(env.db, request.id)).toMatchObject({ status: 'partial' });
    const parts = env.db.prepare(`SELECT p.ordinal,p.kind,o.content,o.next_attempt_at_ms
      FROM deep_recap_delivery_parts p JOIN outbox o ON o.id=p.outbox_id
      WHERE p.request_id=? ORDER BY p.ordinal`).all(request.id) as Array<{
        ordinal: number; kind: string; content: string; next_attempt_at_ms: number;
      }>;
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.kind)).toEqual(['report', 'coverage']);
    expect(parts[0]!.content).toHaveLength(1_800);
    expect(parts[1]!.content).toContain('1 omitted');
    expect(parts[1]!.content).toContain('character-limit partition');
    expect(parts[1]!.next_attempt_at_ms).toBeGreaterThan(parts[0]!.next_attempt_at_ms);
  });

  it('corrects one oversized synthesis finalization before accepting the report', async () => {
    addMessage('source-length-correction', 'A consequential update for the bounded recap.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 2_000,
    });
    const base = executor();
    let synthesisValidations = 0;
    const executeRun = async (deps: ExecuteAgentRunDeps) => {
      if (!deps.sessionId.endsWith(':synthesis')) {
        expect(deps.directAnswerSemanticValidator).toBeUndefined();
        return base(deps);
      }
      const validate = deps.directAnswerSemanticValidator;
      expect(validate).toBeTypeOf('function');
      const oversized = validate!({
        targetChannelId: CHANNEL,
        message: 'x'.repeat(1_801),
        citedMessageIds: [],
      });
      synthesisValidations += 1;
      expect(oversized).toContain('at most 1800 characters');
      expect(validate!({
        targetChannelId: CHANNEL,
        message: 'Corrected recap.',
        citedMessageIds: [],
      })).toBeNull();
      synthesisValidations += 1;
      return base(deps);
    };
    const run = handler(executeRun);

    await expect(run(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toBeInstanceOf(DeferJobError);
    await run({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never);

    expect(synthesisValidations).toBe(2);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'completed', last_error_category: null,
    });
    const { content } = env.db.prepare('SELECT content FROM outbox').get() as { content: string };
    expect(content.length).toBeLessThanOrEqual(2_000);
    expect(content).toContain('Coverage: complete');
  });

  it('reserves Coverage lines for the host and permits one corrected finalization', async () => {
    addMessage('source-coverage-correction', 'A consequential update with host-owned coverage.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 2_000,
    });
    const base = executor();
    let reservedLineRejections = 0;
    const run = handler(async (deps) => {
      if (deps.sessionId.endsWith(':synthesis')) {
        const validate = deps.directAnswerSemanticValidator;
        expect(validate).toBeTypeOf('function');
        expect(validate!({
          targetChannelId: CHANNEL,
          message: 'Summary.\nCoverage: complete — I checked everything.',
          citedMessageIds: [],
        })).toContain('reserved for the host');
        reservedLineRejections += 1;
      }
      return base(deps);
    });

    await expect(run(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toBeInstanceOf(DeferJobError);
    await run({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never);

    expect(reservedLineRejections).toBe(1);
    const { content } = env.db.prepare('SELECT content FROM outbox').get() as { content: string };
    expect(content.match(/^\s*Coverage\s*:/gimu)).toHaveLength(1);
  });

  it('runs a safe retry from completed summaries without repeating chunk model calls', async () => {
    addMessage('source-synthesis-retry', 'A completed partition source that remains current.');
    const original = failedSynthesisRequest('source-synthesis-retry');
    const retried = retryDeepRecapSynthesis(env.db, {
      requestId: original.id,
      requestedByUserId: ids.userId,
      now: NOW,
    });
    if (!retried) throw new Error('expected synthesis retry');

    let modelCalls = 0;
    const base = executor();
    const run = handler(async (deps) => {
      modelCalls += 1;
      expect(deps.sessionId).toBe(`mneme:deep-recap:${retried.id}:synthesis`);
      expect(deps.cacheProfile).toBe('recap');
      return base(deps);
    });
    await run({ recapId: retried.id }, { attempts: 1, max_attempts: 3 } as never);

    expect(modelCalls).toBe(1);
    expect(getDeepRecap(env.db, retried.id)).toMatchObject({
      status: 'completed',
      completed_chunks: 1,
      spent_usd: 0.02,
      synthesis_cost_usd: 0.01,
    });
    expect(env.db.prepare('SELECT cost_usd,status FROM deep_recap_chunks WHERE request_id=?')
      .get(retried.id)).toEqual({ cost_usd: 0, status: 'completed' });
    expect(getDeepRecap(env.db, original.id)).toMatchObject({
      status: 'failed',
      spent_usd: 0.01,
      synthesis_cost_usd: 0,
    });
  });

  it('fails a synthesis-only retry closed when a copied source fingerprint changed', async () => {
    addMessage('source-retry-changed', 'The source version captured by the completed chunk.');
    const original = failedSynthesisRequest('source-retry-changed');
    const retried = retryDeepRecapSynthesis(env.db, {
      requestId: original.id,
      requestedByUserId: ids.userId,
      now: NOW,
    });
    if (!retried) throw new Error('expected synthesis retry');
    addMessage('source-retry-changed', 'The source was edited after retry creation.');

    let modelCalls = 0;
    await expect(handler(async () => {
      modelCalls += 1;
      throw new Error('model must not run after fingerprint drift');
    })({ recapId: retried.id }, { attempts: 1, max_attempts: 3 } as never))
      .rejects.toThrow('DEEP_RECAP_SOURCE_CHANGED');

    expect(modelCalls).toBe(0);
    expect(getDeepRecap(env.db, retried.id)).toMatchObject({
      status: 'failed',
      last_error_category: 'DEEP_RECAP_SOURCE_CHANGED',
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });
  });

  it.each([
    ['missing', '[]'],
    ['malformed', '{"not":"a fingerprint array"}'],
  ])('fails closed before synthesis when copied source fingerprint coverage is %s', async (_kind, storedFingerprints) => {
    const sourceId = `source-retry-provenance-${_kind}`;
    addMessage(sourceId, 'A completed partition source whose provenance must remain exact.');
    const original = failedSynthesisRequest(sourceId);
    const retried = retryDeepRecapSynthesis(env.db, {
      requestId: original.id,
      requestedByUserId: ids.userId,
      now: NOW,
    });
    if (!retried) throw new Error('expected synthesis retry');
    env.db.prepare(`UPDATE deep_recap_chunks SET source_fingerprints_json=?
      WHERE request_id=?`).run(storedFingerprints, retried.id);

    let modelCalls = 0;
    await expect(handler(async () => {
      modelCalls += 1;
      throw new Error('model must not run with incomplete source provenance');
    })({ recapId: retried.id }, { attempts: 1, max_attempts: 3 } as never))
      .rejects.toThrow('DEEP_RECAP_SOURCE_PROVENANCE_INVALID');

    expect(modelCalls).toBe(0);
    expect(getDeepRecap(env.db, retried.id)).toMatchObject({
      status: 'failed',
      last_error_category: 'DEEP_RECAP_SOURCE_PROVENANCE_INVALID',
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });
  });

  it('authorizes synthesis citations only from chunk-cited IDs rendered in its prompt', async () => {
    const citedId = 'source-rendered-citation';
    const uncitedId = 'source-not-rendered-to-synthesis';
    addMessage(citedId, 'A source explicitly cited by the stored partition summary.');
    addMessage(uncitedId, 'A raw chunk source that the synthesis prompt does not identify.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 3_000,
    });
    replaceDeepRecapPlan(env.db, request.id, [{
      afterAtMs: request.after_at_ms,
      beforeAtMs: request.before_at_ms,
      matchingMessages: 2,
      includedMessages: 2,
      complete: true,
    }], NOW - 2_000);
    completeDeepRecapChunk(env.db, {
      requestId: request.id, ordinal: 0, matchingMessages: 2, includedMessages: 2,
      coverageComplete: true,
      summary: `Stored summary. [[cite:${citedId}]]`,
      citedMessageIds: [citedId],
      sourceMessageIds: [citedId, uncitedId],
      sourceFingerprints: [citedId, uncitedId].map((messageId) => ({
        messageId,
        fingerprint: fingerprintExposedMessage(env.db, messageId)!,
      })),
      costUsd: 0.01,
      now: NOW - 1_000,
    });
    const base = executor();
    let modelCalls = 0;
    await expect(handler(async (deps) => {
      modelCalls += 1;
      expect(deps.initialProvenanceMessages?.map((source) => source.messageId))
        .toEqual([citedId]);
      const result = await base(deps);
      return {
        ...result,
        finalProposal: {
          kind: 'direct_answer' as const,
          proposal: {
            targetChannelId: CHANNEL,
            message: `Unsupported citation. [[cite:${uncitedId}]]`,
            citedMessageIds: [uncitedId],
          },
        },
      };
    })({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never))
      .rejects.toThrow('DEEP_RECAP_OUTBOUND_VALIDATION_REJECTED');

    expect(modelCalls).toBe(1);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'failed',
      last_error_category: 'DEEP_RECAP_OUTBOUND_VALIDATION_REJECTED',
    });
    const { content } = env.db.prepare('SELECT content FROM outbox').get() as { content: string };
    expect(content).toContain('could not be completed reliably');
    expect(content).not.toContain(uncitedId);
  });

  it('revalidates current source scope before synthesis even when its fingerprint is current', async () => {
    const sourceChannelId = '100000000000000199';
    const putSourceChannel = (visibilityClass: 'org' | 'restricted') => upsertChannel(env.db, {
      id: sourceChannelId, guildId: ids.guildId, parentId: null, type: 0, name: 'source', topic: null,
      position: 1, isThread: false, isArchived: false, isLocked: false, ingestEnabled: true,
      visibilityClass, allowInterventions: true, permissionFingerprint: null,
      lastMessageId: null, discoveredAtMs: NOW, updatedAtMs: NOW + 1, rawJson: null,
    });
    putSourceChannel('org');
    const sourceId = 'source-scope-tightened';
    addMessage(sourceId, 'A source that later moves outside the target grant.', sourceChannelId);
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 3_000,
    });
    replaceDeepRecapPlan(env.db, request.id, [{
      afterAtMs: request.after_at_ms,
      beforeAtMs: request.before_at_ms,
      matchingMessages: 1,
      includedMessages: 1,
      complete: true,
    }], NOW - 2_000);
    const initialFingerprint = fingerprintExposedMessage(env.db, sourceId);
    if (!initialFingerprint) throw new Error('expected initial source fingerprint');
    completeDeepRecapChunk(env.db, {
      requestId: request.id,
      ordinal: 0,
      matchingMessages: 1,
      includedMessages: 1,
      coverageComplete: true,
      summary: 'Stored partition summary.',
      citedMessageIds: [sourceId],
      sourceMessageIds: [sourceId],
      sourceFingerprints: [{ messageId: sourceId, fingerprint: initialFingerprint }],
      costUsd: 0.01,
      now: NOW - 1_000,
    });

    putSourceChannel('restricted');
    const currentFingerprint = fingerprintExposedMessage(env.db, sourceId);
    if (!currentFingerprint) throw new Error('expected current source fingerprint');
    // Keep the stored version current so this assertion specifically exercises
    // current-scope/grant validation rather than the preceding version check.
    env.db.prepare(`UPDATE deep_recap_chunks SET source_fingerprints_json=?
      WHERE request_id=? AND ordinal=0`).run(
      JSON.stringify([{ messageId: sourceId, fingerprint: currentFingerprint }]),
      request.id,
    );

    let modelCalls = 0;
    await expect(handler(async () => {
      modelCalls += 1;
      throw new Error('model must not run after source scope tightens');
    })({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never))
      .rejects.toThrow('DEEP_RECAP_SOURCE_SCOPE_INVALID');

    expect(modelCalls).toBe(0);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'failed',
      last_error_category: 'DEEP_RECAP_SOURCE_SCOPE_INVALID',
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });
  });

  it('does not publish stale coverage counts when an omitted source leaves the grant', async () => {
    const omittedChannelId = '100000000000000249';
    const putOmittedChannel = (visibilityClass: 'org' | 'restricted') => upsertChannel(env.db, {
      id: omittedChannelId, guildId: ids.guildId, parentId: null, type: 0,
      name: 'omitted-source', topic: null, position: 2, isThread: false,
      isArchived: false, isLocked: false, ingestEnabled: true, visibilityClass,
      allowInterventions: true, permissionFingerprint: null, lastMessageId: null,
      discoveredAtMs: NOW, updatedAtMs: NOW + 1, rawJson: null,
    });
    putOmittedChannel('org');
    const includedId = 'coverage-included-org';
    addMessage(includedId, 'This fitted source remains in the current organizational grant.');
    addMessage(
      'coverage-omitted-tightened',
      'This omitted source later leaves the organizational grant.',
      omittedChannelId,
    );
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 3_000,
    });
    replaceDeepRecapPlan(env.db, request.id, [{
      afterAtMs: request.after_at_ms,
      beforeAtMs: request.before_at_ms,
      matchingMessages: 2,
      includedMessages: 1,
      complete: false,
    }], NOW - 2_000);
    completeDeepRecapChunk(env.db, {
      requestId: request.id, ordinal: 0, matchingMessages: 2, includedMessages: 1,
      coverageComplete: false, summary: 'Stored bounded summary.', citedMessageIds: [includedId],
      sourceMessageIds: [includedId],
      sourceFingerprints: [{
        messageId: includedId,
        fingerprint: fingerprintExposedMessage(env.db, includedId)!,
      }],
      costUsd: 0.01, now: NOW - 1_000,
    });
    putOmittedChannel('restricted');

    let modelCalls = 0;
    await expect(handler(async () => {
      modelCalls += 1;
      throw new Error('model must not run with stale coverage');
    })({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never))
      .rejects.toThrow('DEEP_RECAP_SOURCE_COVERAGE_CHANGED');

    expect(modelCalls).toBe(0);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'failed',
      last_error_category: 'DEEP_RECAP_SOURCE_COVERAGE_CHANGED',
    });
    const { content } = env.db.prepare('SELECT content FROM outbox').get() as { content: string };
    expect(content).toContain('could not be completed reliably');
    expect(content).not.toContain('1/2');
  });

  it('re-resolves the current source grant after synthesis before enqueue', async () => {
    const sourceChannelId = '100000000000000299';
    const putSourceChannel = (visibilityClass: 'org' | 'restricted') => upsertChannel(env.db, {
      id: sourceChannelId, guildId: ids.guildId, parentId: null, type: 0, name: 'source-mid-run', topic: null,
      position: 2, isThread: false, isArchived: false, isLocked: false, ingestEnabled: true,
      visibilityClass, allowInterventions: true, permissionFingerprint: null,
      lastMessageId: null, discoveredAtMs: NOW, updatedAtMs: NOW + 1, rawJson: null,
    });
    putSourceChannel('org');
    const sourceId = 'source-scope-tightened-mid-synthesis';
    addMessage(sourceId, 'A source whose grant tightens while synthesis is running.', sourceChannelId);
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 3_000,
    });
    replaceDeepRecapPlan(env.db, request.id, [{
      afterAtMs: request.after_at_ms,
      beforeAtMs: request.before_at_ms,
      matchingMessages: 1,
      includedMessages: 1,
      complete: true,
    }], NOW - 2_000);
    const fingerprint = fingerprintExposedMessage(env.db, sourceId);
    if (!fingerprint) throw new Error('expected source fingerprint');
    completeDeepRecapChunk(env.db, {
      requestId: request.id,
      ordinal: 0,
      matchingMessages: 1,
      includedMessages: 1,
      coverageComplete: true,
      summary: 'Stored partition summary.',
      citedMessageIds: [sourceId],
      sourceMessageIds: [sourceId],
      sourceFingerprints: [{ messageId: sourceId, fingerprint }],
      costUsd: 0.01,
      now: NOW - 1_000,
    });
    const base = executor();
    let modelCalls = 0;
    let grantTightened = false;
    await expect(handler(async (deps) => {
      modelCalls += 1;
      const result = await base(deps);
      grantTightened = true;
      return result;
    }, true, () => ({
      grant: {
        includeOrgMessages: !grantTightened,
        includeOrgMemories: true,
        includeReviewOnly: false,
        channelIds: [],
      },
      target: { channelId: CHANNEL, visibility: 'org' as const, isSecureReview: false },
    }))({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never))
      .rejects.toThrow('DEEP_RECAP_SOURCE_SCOPE_INVALID');

    expect(modelCalls).toBe(1);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'failed',
      last_error_category: 'DEEP_RECAP_SOURCE_SCOPE_INVALID',
      spent_usd: 0.02,
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });
  });

  it('does not enqueue a report when cancellation wins during synthesis', async () => {
    addMessage('source-cancel', 'A source that begins a recap before cancellation.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 2_000,
    });
    const base = executor();
    let calls = 0;
    const executeRun = async (deps: ExecuteAgentRunDeps) => {
      calls += 1;
      const result = await base(deps);
      if (calls === 2) cancelDeepRecap(env.db, request.id, NOW);
      return result;
    };
    const run = handler(executeRun);
    await expect(run(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toBeInstanceOf(DeferJobError);
    await run({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({ status: 'cancelled', outbox_id: null });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
  });

  it('defers without terminalizing durable work while the feature is disabled', async () => {
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 1, now: NOW - 2_000,
    });
    await expect(handler(executor(), false)(
      { recapId: request.id }, { attempts: 3, max_attempts: 3 } as never,
    )).rejects.toBeInstanceOf(DeferJobError);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({ status: 'queued', completed_at_ms: null });
  });

  it('attributes a failed production-wrapped model call once at its call timestamp', async () => {
    addMessage('source-billed-abort', 'A provider-aborted partition still incurs billable usage.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 2_000,
    });
    let billedRunId = '';
    const run = handler(async (deps) => {
      billedRunId = deps.runId ?? '';
      expect(billedRunId).not.toBe('');
      env.db.prepare(`INSERT INTO agent_runs
        (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms,
         ended_at_ms,cost_usd)
        VALUES (?,?,'direct_answer','deep','faux','faux','failed',?,?,.07)`)
        .run(billedRunId, ids.guildId, deps.now, deps.now + 1);
      throw new TransientJobError('model run aborted', {
        billableAgentRun: { runId: billedRunId, costUsd: 0.07, startedAtMs: deps.now },
      });
    });

    await expect(run(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toBeInstanceOf(TransientJobError);

    expect(getDeepRecap(env.db, request.id)).toMatchObject({ status: 'running', spent_usd: 0.07 });
    expect(env.db.prepare(`SELECT status,cost_usd FROM deep_recap_chunks
      WHERE request_id=? AND ordinal=0`).get(request.id)).toEqual({ status: 'pending', cost_usd: 0.07 });
    expect(env.db.prepare(`SELECT run_id,phase,cost_usd,started_at_ms,accounted_at_ms
      FROM deep_recap_model_calls WHERE request_id=?`).get(request.id)).toEqual({
      run_id: billedRunId,
      phase: 'chunk',
      cost_usd: 0.07,
      started_at_ms: NOW,
      accounted_at_ms: NOW,
    });
    expect(deepRecapDailySpend(env.db, NOW)).toBeCloseTo(0.07);
    expect(deepRecapDailySpend(env.db, NOW + 1)).toBe(0);
    expect(settleDeepRecapModelCallCost(env.db, {
      runId: billedRunId, costUsd: 0.07, now: NOW + 2,
    })).toBe(false);
    expect(getDeepRecap(env.db, request.id)?.spent_usd).toBeCloseTo(0.07);
  });

  it('releases a pre-call reservation when model admission defers before agent_runs', async () => {
    addMessage('source-admission-defer', 'A partition that reaches a closed model gate.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 2_000,
    });
    // Simulate a prior process dying after reservation but before executeAgentRun
    // synchronously inserted its durable run row.
    reserveDeepRecapModelCall(env.db, {
      requestId: request.id,
      runId: 'orphaned-pre-call-reservation',
      phase: 'synthesis',
      startedAtMs: NOW - 1_000,
      now: NOW - 1_000,
    });
    await expect(handler(async () => {
      throw new DeferJobError('model work deferred: budget gate', 60_000);
    })(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toBeInstanceOf(DeferJobError);
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM deep_recap_model_calls
      WHERE request_id=?`).get(request.id)).toEqual({ n: 0 });
  });

  it('reconciles a billed run committed before caller settlement and gates the retry', async () => {
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 1, now: NOW - 2_000,
    });
    replaceDeepRecapPlan(env.db, request.id, [{
      afterAtMs: request.after_at_ms,
      beforeAtMs: request.before_at_ms,
      matchingMessages: 1,
      includedMessages: 1,
      complete: true,
    }], NOW - 1_000);
    reserveDeepRecapModelCall(env.db, {
      requestId: request.id,
      runId: 'crash-after-agent-run',
      phase: 'chunk',
      chunkOrdinal: 0,
      startedAtMs: NOW - 500,
      now: NOW - 500,
    });
    env.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms,
       ended_at_ms,cost_usd)
      VALUES ('crash-after-agent-run',?,'direct_answer','deep','faux','faux',
              'failed',?,?,1)`).run(ids.guildId, NOW - 500, NOW - 400);
    let calls = 0;
    await handler(async () => {
      calls += 1;
      throw new Error('budget reconciliation must stop a second provider call');
    })({ recapId: request.id }, { attempts: 2, max_attempts: 3 } as never);

    expect(calls).toBe(0);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({ status: 'failed', spent_usd: 1 });
    expect(env.db.prepare(`SELECT cost_usd,accounted_at_ms FROM deep_recap_model_calls
      WHERE run_id='crash-after-agent-run'`).get()).toEqual({ cost_usd: 1, accounted_at_ms: NOW });
  });

  it('posts a fixed content-free notice when terminal processing retries are exhausted', async () => {
    addMessage('source-terminal', 'Activity that requires a model summary.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 1, now: NOW - 2_000,
    });
    await expect(handler(async () => { throw new Error('provider secret must not escape'); })(
      { recapId: request.id }, { attempts: 3, max_attempts: 3 } as never,
    )).rejects.toThrow();
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'failed', last_error_category: 'processing_error',
    });
    const { content } = env.db.prepare('SELECT content FROM outbox').get() as { content: string };
    expect(content).toContain('could not be completed reliably');
    expect(content).not.toContain('provider secret');
  });

  it('terminalizes a permanent processing failure before retry exhaustion', async () => {
    addMessage('source-permanent', 'Activity that reaches a permanent synthesis boundary.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 1, now: NOW - 2_000,
    });

    await expect(handler(async () => {
      throw new PermanentJobError('DEEP_RECAP_REPORT_TOO_LONG');
    })(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toThrow('DEEP_RECAP_REPORT_TOO_LONG');

    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'failed', last_error_category: 'DEEP_RECAP_REPORT_TOO_LONG',
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });

    await handler(async () => { throw new Error('terminal request must not rerun'); })(
      { recapId: request.id }, { attempts: 2, max_attempts: 3 } as never,
    );
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });
  });

  it('terminalizes a second oversized synthesis finalization and queues one failure notice', async () => {
    addMessage('source-length-failure', 'Activity that needs a bounded final synthesis.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 5, now: NOW - 2_000,
    });
    const base = executor();
    const executeRun = async (deps: ExecuteAgentRunDeps): Promise<AgentRunResult> => {
      const result = await base(deps);
      if (!deps.sessionId.endsWith(':synthesis')) return result;
      const validate = deps.directAnswerSemanticValidator;
      expect(validate).toBeTypeOf('function');
      const proposal = {
        targetChannelId: CHANNEL,
        message: 'x'.repeat(1_801),
        citedMessageIds: [] as string[],
      };
      expect(validate!(proposal)).toContain('at most 1800 characters');
      expect(validate!(proposal)).toContain('at most 1800 characters');
      return {
        ...result,
        status: 'failed',
        outcome: 'validation_rejected',
        failureReason: 'final proposal remained invalid after one correction',
        finalProposal: null,
      };
    };
    const run = handler(executeRun);

    await expect(run(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toBeInstanceOf(DeferJobError);
    await expect(run(
      { recapId: request.id },
      { attempts: 1, max_attempts: 3 } as never,
    )).rejects.toThrow('DEEP_RECAP_REPORT_TOO_LONG');

    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'failed',
      last_error_category: 'DEEP_RECAP_REPORT_TOO_LONG',
      synthesis_cost_usd: 0.01,
      spent_usd: 0.02,
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });
    const { content } = env.db.prepare('SELECT content FROM outbox').get() as { content: string };
    expect(content).toContain('could not be completed reliably');

    await run({ recapId: request.id }, { attempts: 2, max_attempts: 3 } as never);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });
  });

  it('posts a deterministic complete report for an empty permitted window without a model call', async () => {
    let calls = 0;
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 1, now: NOW - 2_000,
    });
    await handler(async () => { calls += 1; throw new Error('must not run'); })(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    );
    expect(calls).toBe(0);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({ status: 'completed', spent_usd: 0 });
    expect(env.db.prepare('SELECT content FROM outbox').get()).toEqual({
      content: 'No permitted activity matched this recap window.\n\nCoverage: complete — analyzed all 0 matching messages across 0 partitions.',
    });
  });

  it('does not post even an empty report when the destination is excluded', async () => {
    let calls = 0;
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 1, now: NOW - 2_000,
    });
    await handler(async () => {
      calls += 1;
      throw new Error('must not run');
    }, true, () => ({
      grant: {
        includeOrgMessages: false,
        includeOrgMemories: false,
        includeReviewOnly: false,
        channelIds: [],
      },
      target: { channelId: CHANNEL, visibility: 'excluded' as const, isSecureReview: false },
    }))({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never);

    expect(calls).toBe(0);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'failed',
      last_error_category: 'target_invalid',
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
  });

  it('fails closed to an empty source set when stored channel selection is malformed', async () => {
    addMessage('must-stay-hidden-from-malformed-selection', 'This org activity must not broaden a corrupt request.');
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      channelIds: [CHANNEL], afterAtMs: NOW - 86_400_000, beforeAtMs: NOW,
      budgetUsd: 1, now: NOW - 2_000,
    });
    env.db.prepare("UPDATE deep_recap_requests SET channel_ids_json='not-json' WHERE id=?")
      .run(request.id);
    let calls = 0;
    await handler(async () => { calls += 1; throw new Error('must not run'); })(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    );
    expect(calls).toBe(0);
    expect(env.db.prepare('SELECT content FROM outbox').get()).toEqual({
      content: 'No permitted activity matched this recap window.\n\nCoverage: complete — analyzed all 0 matching messages across 0 partitions.',
    });
  });

  it('delivers a truthful partial notice if an admitted chunk exhausts the request cap', async () => {
    const sourceIds = Array.from({ length: 5 }, (_, index) => `budget-source-${index}`);
    for (const sourceId of sourceIds) addMessage(sourceId, `Bounded source ${sourceId}.`);
    for (let index = 0; index < 5; index += 1) {
      addMessage(`budget-omitted-${index}`, `Omitted bounded source ${index}.`);
    }
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 1, now: NOW - 2_000,
    });
    replaceDeepRecapPlan(env.db, request.id, [
      { afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, matchingMessages: 10,
        includedMessages: 5, complete: false },
    ], NOW - 1_000);
    completeDeepRecapChunk(env.db, {
      requestId: request.id, ordinal: 0, matchingMessages: 10, includedMessages: 5,
      coverageComplete: false, summary: 'bounded summary', citedMessageIds: [],
      sourceMessageIds: sourceIds,
      sourceFingerprints: sourceIds.map((messageId) => ({
        messageId,
        fingerprint: fingerprintExposedMessage(env.db, messageId)!,
      })),
      costUsd: 1.01, now: NOW - 500,
    });
    let calls = 0;
    await handler(async () => { calls += 1; throw new Error('must not run'); })(
      { recapId: request.id }, { attempts: 1, max_attempts: 3 } as never,
    );
    expect(calls).toBe(0);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({ status: 'partial', spent_usd: 1.01 });
    const { content } = env.db.prepare('SELECT content FROM outbox').get() as { content: string };
    expect(content).toContain('No final synthesis was attempted');
    expect(content).toContain('Coverage: partial — analyzed 5/10');
  });

  it('does not expose stored activity counts when source scope tightens before a budget stop', async () => {
    const sourceChannelId = '100000000000000399';
    const putSourceChannel = (visibilityClass: 'org' | 'restricted') => upsertChannel(env.db, {
      id: sourceChannelId, guildId: ids.guildId, parentId: null, type: 0,
      name: 'budget-source', topic: null, position: 3, isThread: false,
      isArchived: false, isLocked: false, ingestEnabled: true, visibilityClass,
      allowInterventions: true, permissionFingerprint: null, lastMessageId: null,
      discoveredAtMs: NOW, updatedAtMs: NOW + 1, rawJson: null,
    });
    putSourceChannel('org');
    const sourceId = 'budget-source-tightened';
    addMessage(sourceId, 'Stored activity whose current grant later tightens.', sourceChannelId);
    const request = createDeepRecap(env.db, {
      guildId: ids.guildId, targetChannelId: CHANNEL, requestedByUserId: ids.userId,
      afterAtMs: NOW - 86_400_000, beforeAtMs: NOW, budgetUsd: 1, now: NOW - 2_000,
    });
    replaceDeepRecapPlan(env.db, request.id, [{
      afterAtMs: request.after_at_ms,
      beforeAtMs: request.before_at_ms,
      matchingMessages: 1,
      includedMessages: 1,
      complete: true,
    }], NOW - 1_000);
    const initialFingerprint = fingerprintExposedMessage(env.db, sourceId)!;
    completeDeepRecapChunk(env.db, {
      requestId: request.id, ordinal: 0, matchingMessages: 1, includedMessages: 1,
      coverageComplete: true, summary: 'stored bounded summary', citedMessageIds: [sourceId],
      sourceMessageIds: [sourceId],
      sourceFingerprints: [{ messageId: sourceId, fingerprint: initialFingerprint }],
      costUsd: 1.01, now: NOW - 500,
    });
    putSourceChannel('restricted');
    const currentFingerprint = fingerprintExposedMessage(env.db, sourceId)!;
    env.db.prepare(`UPDATE deep_recap_chunks SET source_fingerprints_json=?
      WHERE request_id=? AND ordinal=0`).run(
      JSON.stringify([{ messageId: sourceId, fingerprint: currentFingerprint }]),
      request.id,
    );

    let calls = 0;
    await expect(handler(async () => {
      calls += 1;
      throw new Error('must not run');
    })({ recapId: request.id }, { attempts: 1, max_attempts: 3 } as never))
      .rejects.toThrow('DEEP_RECAP_SOURCE_SCOPE_INVALID');

    expect(calls).toBe(0);
    expect(getDeepRecap(env.db, request.id)).toMatchObject({
      status: 'failed',
      last_error_category: 'DEEP_RECAP_SOURCE_SCOPE_INVALID',
    });
    const rows = env.db.prepare('SELECT content FROM outbox').all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('could not be completed reliably');
    expect(rows[0]!.content).not.toContain('1/1');
    expect(rows[0]!.content).not.toContain('No final synthesis was attempted');
  });
});
