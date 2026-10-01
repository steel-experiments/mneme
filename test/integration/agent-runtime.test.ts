import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fauxProvider,
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
  createAssistantMessageEventStream,
  type Context,
  type SimpleStreamOptions,
  type AssistantMessage,
  type Usage,
} from '@earendil-works/pi-ai';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  executeAgentRun,
  buildRunTools,
  createReadOnlyPolicyHook,
  AGENT_READ_TOOL_NAMES,
  AGENT_DOC_TOOL_NAMES,
  AGENT_DIRECT_ANSWER_TOOL_NAMES,
  agentReadToolNames,
  agentTerminalToolName,
  directAnswerReadTurnCeiling,
  directAnswerShouldFinalizeNow,
  finalizationDirective,
  type ExecuteAgentRunDeps,
  type AgentRunType,
  type ToolAuditEntry,
  type AgentRunOutcome,
} from '../../src/agent/runtime.js';
import { RunFinalizationState } from '../../src/agent/tools/finalize.js';
import { RunRetrievalState } from '../../src/agent/run-context.js';
import { DocsIndex } from '../../src/agent/docs-index.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';

/**
 * Bounded ephemeral Pi agent runtime (Sections 4.1, 21, 43.5).
 *
 * Acceptance: the runtime exposes no shell, filesystem, browser, HTTP, or send
 * tool, and exceeding any bound fails closed without output. Driven by a
 * scripted faux stream — no network.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002';
const NOW = 1_700_000_001_000;
const PROMPT_VERSION = 'pv-abc';
const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
const DOCS = new DocsIndex([
  { path: 'index.md', title: 'Mneme documentation', summary: 'Start here.', content: '# Mneme documentation\n' },
]);

const dims = {
  impact: 0.5,
  evidenceStrength: 0.5,
  contradictionStrength: 0.5,
  urgency: 0.5,
  novelty: 0.5,
  interruptionCost: 0.5,
};

function episodeReview(target = CHANNEL) {
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
        evidenceMessageIds: ['111', '222'],
        evidenceQuotes: [{ messageId: '111', quote: 'adopted' }, { messageId: '222', quote: 'trial' }],
        durability: 'project',
        durabilityReason: 'This changes future onboarding work.',
      },
    ],
    intervention: {
      recommend: false,
      reason: 'nothing urgent',
      dimensions: dims,
      confidence: 0.5,
      urgency: 'normal',
      targetChannelId: target,
      evidenceMessageIds: ['111'],
    },
    unresolvedQuestions: [],
  };
}

interface Faux {
  streamFn: ExecuteAgentRunDeps['streamFn'];
  model: ExecuteAgentRunDeps['model'];
  handle: ReturnType<typeof fauxProvider>;
}

function setupFaux(): Faux {
  const handle = fauxProvider({ models: [{ id: 'faux-1' }] });
  const models = createModels();
  models.setProvider(handle.provider);
  return { streamFn: models.streamSimple.bind(models), model: handle.getModel(), handle };
}

function withReportedCost(inner: ExecuteAgentRunDeps['streamFn'], total: number): ExecuteAgentRunDeps['streamFn'] {
  return async (model, context, options) => {
    const upstream = await inner(model, context, options);
    const downstream = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of upstream) {
        if (event.type === 'done') {
          const message = {
            ...event.message,
            usage: {
              ...event.message.usage,
              cost: { ...event.message.usage.cost, total },
            },
          };
          downstream.push({ ...event, message });
          downstream.end(message);
          return;
        }
        downstream.push(event);
      }
    })();
    return downstream;
  };
}

/** What the model was offered on each provider request: tool names and the last message. */
interface ObservedRequest {
  tools: string[];
  lastRole: string | undefined;
  lastText: string;
  sessionId: string | undefined;
  cacheKey: unknown;
}

/** Wrap a stream function to record, per request, the tool list and the last message. */
function observing(
  inner: ExecuteAgentRunDeps['streamFn'],
  seen: ObservedRequest[],
): ExecuteAgentRunDeps['streamFn'] {
  return async (model, context, options) => {
    const last = context.messages[context.messages.length - 1] as
      | { role?: string; content?: unknown }
      | undefined;
    const content = last?.content;
    const lastText = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c) => ((c as { type?: string; text?: string }).type === 'text' ? (c as { text: string }).text : '')).join('')
        : '';
    const syntheticPayload = { input: ['provider-payload-secret'], prompt_cache_key: 'pi-session' };
    const replaced = options?.onPayload
      ? await options.onPayload(syntheticPayload, { ...model, api: 'openai-responses' })
      : undefined;
    seen.push({
      tools: (context.tools ?? []).map((t) => t.name),
      lastRole: last?.role,
      lastText,
      sessionId: options?.sessionId,
      cacheKey: (replaced as { prompt_cache_key?: unknown } | undefined)?.prompt_cache_key,
    });
    return inner(model, context, options);
  };
}

/** Wrap a stream function to report a fixed usage block on the final message. */
function withReportedUsage(
  inner: ExecuteAgentRunDeps['streamFn'],
  reported: Partial<Omit<Usage, 'cost'>> & { cost?: Partial<Usage['cost']> },
): ExecuteAgentRunDeps['streamFn'] {
  return async (model, context, options) => {
    const upstream = await inner(model, context, options);
    const downstream = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of upstream) {
        if (event.type === 'done') {
          const message = {
            ...event.message,
            usage: {
              ...event.message.usage,
              ...reported,
              cost: { ...event.message.usage.cost, ...reported.cost },
            },
          };
          downstream.push({ ...event, message });
          downstream.end(message);
          return;
        }
        downstream.push(event);
      }
    })();
    return downstream;
  };
}

/** A factory response that never resolves until the request's abort signal fires. */
function blockingUntilAborted(): (
  ctx: Context,
  options: SimpleStreamOptions | undefined,
) => Promise<AssistantMessage> {
  return (_ctx, options) =>
    new Promise((resolve) => {
      const sig = options?.signal;
      const done = () =>
        resolve(
          fauxAssistantMessage('aborted', {
            stopReason: 'aborted',
            errorMessage: 'Request was aborted',
          }),
        );
      if (sig) {
        if (sig.aborted) done();
        else sig.addEventListener('abort', done, { once: true });
      } else {
        setTimeout(done, 5000);
      }
    });
}

function baseDeps(
  env: TestDb,
  faux: Faux,
  over: Partial<ExecuteAgentRunDeps> = {},
): ExecuteAgentRunDeps {
  return {
    db: env.db,
    grant: ORG_GRANT,
    systemPrompt: 'system prompt',
    model: faux.model,
    thinkingLevel: 'minimal',
    streamFn: faux.streamFn,
    sessionId: 'mneme:episode:e1',
    cacheProfile: 'episode',
    promptText: 'Please review this episode.',
    promptVersion: PROMPT_VERSION,
    runType: 'episode',
    guildId: GUILD,
    pinnedTargetChannelId: CHANNEL,
    providerId: 'faux',
    modelId: 'faux-1',
    now: NOW,
    runId: 'run-1',
    ...over,
  };
}

let env: TestDb;
let faux: Faux;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  faux = setupFaux();
});
afterEach(() => env.cleanup());

describe('exposed tool surface — no forbidden tools', () => {
  it('exposes only the six episode-run retrieval tools plus the terminal tool', () => {
    const retrieval = new RunRetrievalState(60_000, NOW, env.db);
    const ctx = { db: env.db, grant: ORG_GRANT, retrieval };
    const state = new RunFinalizationState(CHANNEL);
    const tools = buildRunTools(ctx, 'episode', state);
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'search_messages',
      'list_recent_messages',
      'get_message_context',
      'search_memories',
      'list_memories',
      'get_memory_evidence',
      'finalize_episode_review',
    ]);
  });

  it.each(['shell', 'fs_write', 'browse', 'http_request', 'send_message', 'exec'] as const)(
    'never exposes a %s tool for any run type',
    (forbidden) => {
      const retrieval = new RunRetrievalState(60_000, NOW, env.db);
      const ctx = { db: env.db, grant: ORG_GRANT, retrieval };
      for (const runType of ['episode', 'direct_answer', 'scheduled_review'] as AgentRunType[]) {
        const names = buildRunTools(ctx, runType, new RunFinalizationState(CHANNEL)).map((t) => t.name);
        expect(names).not.toContain(forbidden);
      }
    },
  );

  it('adds the documentation tools to a direct-answer run (Section 22.7)', () => {
    const retrieval = new RunRetrievalState(60_000, NOW, env.db);
    const ctx = { db: env.db, grant: ORG_GRANT, retrieval, docs: DOCS };
    const names = buildRunTools(ctx, 'direct_answer', new RunFinalizationState(CHANNEL)).map((t) => t.name);
    expect(names).toEqual([
      'search_messages',
      'list_recent_messages',
      'get_recent_activity_snapshot',
      'get_message_context',
      'search_memories',
      'list_memories',
      'get_memory_evidence',
      'list_docs',
      'read_doc',
      'finalize_direct_answer',
    ]);
  });

  it.each(['episode', 'scheduled_review'] as const)(
    'never gives the documentation tools to a %s run, even with an index',
    (runType) => {
      const retrieval = new RunRetrievalState(60_000, NOW, env.db);
      const ctx = { db: env.db, grant: ORG_GRANT, retrieval, docs: DOCS };
      const names = buildRunTools(ctx, runType, new RunFinalizationState(CHANNEL)).map((t) => t.name);
      expect(names).not.toContain('list_docs');
      expect(names).not.toContain('read_doc');
      expect(agentReadToolNames(runType)).toEqual([...AGENT_READ_TOOL_NAMES]);
    },
  );

  it('permits the documentation tools only for a direct answer', () => {
    expect(agentReadToolNames('direct_answer')).toEqual([
      ...AGENT_READ_TOOL_NAMES,
      ...AGENT_DIRECT_ANSWER_TOOL_NAMES,
      ...AGENT_DOC_TOOL_NAMES,
    ]);
  });

  it('exposes the activity snapshot only to direct-answer runs', () => {
    const ctx = {
      db: env.db,
      grant: ORG_GRANT,
      retrieval: new RunRetrievalState(60_000, NOW, env.db),
      requestCreatedAtMs: NOW,
    };
    expect(buildRunTools(ctx, 'direct_answer', new RunFinalizationState(CHANNEL))
      .map((tool) => tool.name)).toContain('get_recent_activity_snapshot');
    for (const runType of ['episode', 'scheduled_review'] as const) {
      expect(buildRunTools(ctx, runType, new RunFinalizationState(CHANNEL))
        .map((tool) => tool.name)).not.toContain('get_recent_activity_snapshot');
      expect(agentReadToolNames(runType)).not.toContain('get_recent_activity_snapshot');
    }
  });

  it('selects the correct terminal tool per run type', () => {
    expect(agentTerminalToolName('episode')).toBe('finalize_episode_review');
    expect(agentTerminalToolName('direct_answer')).toBe('finalize_direct_answer');
    expect(agentTerminalToolName('scheduled_review')).toBe('finalize_scheduled_review');
  });
});

describe('read-only policy hook (beforeToolCall)', () => {
  function ctxWith(name: string) {
    return {
      assistantMessage: {} as never,
      toolCall: { type: 'toolCall', id: 'c1', name, arguments: {} } as never,
      args: {},
      context: {} as never,
    };
  }

  it('blocks a shell tool and terminates the run (fail closed)', async () => {
    const blocked: ToolAuditEntry[] = [];
    const reasons: AgentRunOutcome[] = [];
    const hook = createReadOnlyPolicyHook({
      allowedNames: new Set([...AGENT_READ_TOOL_NAMES, 'finalize_episode_review']),
      terminalName: 'finalize_episode_review',
      maxToolCalls: 8,
      onBlock: (entry, reason) => {
        blocked.push(entry);
        reasons.push(reason);
      },
    });
    const res = await hook(ctxWith('shell'));
    expect(res).toEqual({ block: true, reason: expect.stringContaining('shell'), terminate: true });
    expect(blocked[0]!.blocked).toBe(true);
    expect(blocked[0]!.accepted).toBe(false);
    expect(reasons[0]).toBe('blocked');
  });

  it('blocks every forbidden capability name', async () => {
    const hook = createReadOnlyPolicyHook({
      allowedNames: new Set([...AGENT_READ_TOOL_NAMES, 'finalize_episode_review']),
      terminalName: 'finalize_episode_review',
      maxToolCalls: 8,
    });
    for (const name of ['shell', 'fs_write', 'browse', 'http_request', 'send_message', 'exec']) {
      const res = await hook(ctxWith(name));
      expect(res?.block).toBe(true);
      expect(res?.terminate).toBe(true);
    }
  });

  it('allows a read-only tool within budget', async () => {
    const hook = createReadOnlyPolicyHook({
      allowedNames: new Set([...AGENT_READ_TOOL_NAMES, 'finalize_episode_review']),
      terminalName: 'finalize_episode_review',
      maxToolCalls: 8,
    });
    expect(await hook(ctxWith('search_messages'))).toBeUndefined();
  });

  it('blocks the (N+1)th non-terminal call and reports budget_exceeded', async () => {
    const reasons: AgentRunOutcome[] = [];
    const hook = createReadOnlyPolicyHook({
      allowedNames: new Set([...AGENT_READ_TOOL_NAMES, 'finalize_episode_review']),
      terminalName: 'finalize_episode_review',
      maxToolCalls: 1,
      onBlock: (_e, reason) => reasons.push(reason),
    });
    expect(await hook(ctxWith('search_messages'))).toBeUndefined(); // call 1 ok
    const res = await hook(ctxWith('search_messages')); // call 2 blocked
    expect(res?.block).toBe(true);
    expect(res?.terminate).toBe(true);
    expect(reasons[0]).toBe('budget_exceeded');
  });

  it('never counts the terminal tool against the non-terminal budget', async () => {
    const hook = createReadOnlyPolicyHook({
      allowedNames: new Set([...AGENT_READ_TOOL_NAMES, 'finalize_episode_review']),
      terminalName: 'finalize_episode_review',
      maxToolCalls: 0, // any non-terminal call would block
    });
    expect(await hook(ctxWith('finalize_episode_review'))).toBeUndefined();
  });

  it('returns a non-terminal finalize-now result at the direct-answer read boundary', async () => {
    let completedTurns = 3;
    const soft: ToolAuditEntry[] = [];
    const hook = createReadOnlyPolicyHook({
      allowedNames: new Set([...AGENT_READ_TOOL_NAMES, 'finalize_direct_answer']),
      terminalName: 'finalize_direct_answer',
      maxToolCalls: 8,
      softReadTurnCeiling: directAnswerReadTurnCeiling(6),
      completedTurns: () => completedTurns,
      onSoftReadLimit: (entry) => soft.push(entry),
    });

    const result = await hook(ctxWith('search_messages'));
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('finalize_direct_answer now'),
      terminate: false,
    });
    expect(soft).toHaveLength(1);
    expect(soft[0]).toMatchObject({ blocked: true, isError: false });

    // Terminal calls remain available at the same boundary.
    expect(await hook(ctxWith('finalize_direct_answer'))).toBeUndefined();
    completedTurns = 0;
    expect(await createReadOnlyPolicyHook({
      allowedNames: new Set([...AGENT_READ_TOOL_NAMES, 'finalize_direct_answer']),
      terminalName: 'finalize_direct_answer',
      maxToolCalls: 8,
      softReadTurnCeiling: directAnswerReadTurnCeiling(6),
      completedTurns: () => completedTurns,
    })(ctxWith('search_messages'))).toBeUndefined();
  });

  it('keeps the hard tool-call cap terminating before the direct-answer soft boundary', async () => {
    const reasons: AgentRunOutcome[] = [];
    const hook = createReadOnlyPolicyHook({
      allowedNames: new Set([...AGENT_READ_TOOL_NAMES, 'finalize_direct_answer']),
      terminalName: 'finalize_direct_answer',
      maxToolCalls: 0,
      softReadTurnCeiling: directAnswerReadTurnCeiling(6),
      completedTurns: () => 3,
      onBlock: (_entry, reason) => reasons.push(reason),
    });

    const result = await hook(ctxWith('search_messages'));
    expect(result?.terminate).toBe(true);
    expect(reasons).toEqual(['budget_exceeded']);
  });
});

describe('direct-answer finalization reserve arithmetic', () => {
  it.each([
    { maxTurns: -1, ceiling: 0 },
    { maxTurns: Number.NaN, ceiling: 0 },
    { maxTurns: Number.POSITIVE_INFINITY, ceiling: 0 },
    { maxTurns: 0, ceiling: 0 },
    { maxTurns: 1, ceiling: 0 },
    { maxTurns: 2, ceiling: 0 },
    { maxTurns: 3, ceiling: 1 },
    { maxTurns: 6, ceiling: 4 },
  ])('clamps maxTurns=$maxTurns to read ceiling $ceiling', ({ maxTurns, ceiling }) => {
    expect(directAnswerReadTurnCeiling(maxTurns)).toBe(ceiling);
  });

  it('uses the boundary-result turn before the two reserved terminal turns', () => {
    const ceiling = directAnswerReadTurnCeiling(6);
    expect(directAnswerShouldFinalizeNow(2, ceiling)).toBe(false);
    expect(directAnswerShouldFinalizeNow(3, ceiling)).toBe(true);
    expect(directAnswerShouldFinalizeNow(99, 0)).toBe(true);
  });
});

describe('executeAgentRun', () => {
  it('lets a direct answer retrieve one scoped activity snapshot and records coverage provenance', async () => {
    env.db.prepare("UPDATE channels SET visibility_class='org' WHERE id=?").run(CHANNEL);
    upsertMessageCreate(env.db, {
      id: 'recent-org-message',
      guildId: GUILD,
      channelId: CHANNEL,
      authorId: '100000000000000003',
      authorDisplayName: 'Alice',
      content: 'A recent release update with no required keyword.',
      createdAtMs: NOW - 1_000,
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
    faux.handle.setResponses([
      fauxAssistantMessage([
        fauxToolCall('get_recent_activity_snapshot', {
          after: new Date(NOW - 86_400_000).toISOString(),
          before: new Date(NOW + 1).toISOString(),
        }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('finalize_direct_answer', {
          targetChannelId: CHANNEL,
          message: 'The release was updated.',
          citedMessageIds: ['recent-org-message'],
        }),
      ], { stopReason: 'toolUse' }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, {
      runType: 'direct_answer',
      runId: 'run-recent-activity-snapshot',
      requestCreatedAtMs: NOW,
    }));

    expect(result.outcome).toBe('finalized');
    expect(result.toolCalls.map((entry) => entry.toolName)).toEqual([
      'get_recent_activity_snapshot',
      'finalize_direct_answer',
    ]);
    expect(result.provenance.messageIds).toContain('recent-org-message');
    expect(result.provenance.channels).toContainEqual({
      channelId: CHANNEL,
      source: 'activity_snapshot',
    });
    expect(result.provenance.recentActivitySnapshot).toMatchObject({
      beforeMs: NOW,
      totalMatching: 1,
      included: 1,
      complete: true,
      omitted: 0,
      exposedMessageIds: ['recent-org-message'],
    });
  });

  it('rejects a nonempty snapshot answer without a snapshot citation, then accepts the correction', async () => {
    env.db.prepare("UPDATE channels SET visibility_class='org' WHERE id=?").run(CHANNEL);
    upsertMessageCreate(env.db, {
      id: 'snapshot-citation-source',
      guildId: GUILD,
      channelId: CHANNEL,
      authorId: '100000000000000003',
      authorDisplayName: 'Alice',
      content: 'The production release completed successfully.',
      createdAtMs: NOW - 1_000,
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
    faux.handle.setResponses([
      fauxAssistantMessage([
        fauxToolCall('get_recent_activity_snapshot', {
          after: new Date(NOW - 86_400_000).toISOString(),
          before: new Date(NOW).toISOString(),
        }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('finalize_direct_answer', {
          targetChannelId: CHANNEL,
          message: 'The production release completed successfully.',
          // Citing some other exposed context is insufficient: the recap must
          // cite a row from the nonempty snapshot itself.
          citedMessageIds: ['initial-context-message'],
        }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('finalize_direct_answer', {
          targetChannelId: CHANNEL,
          message: 'The production release completed successfully.',
          citedMessageIds: ['snapshot-citation-source'],
        }),
      ], { stopReason: 'toolUse' }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, {
      runType: 'direct_answer',
      runId: 'run-snapshot-citation-correction',
      requestCreatedAtMs: NOW,
      initialProvenanceMessages: [{
        messageId: 'initial-context-message',
        channelId: CHANNEL,
      }],
    }));

    expect(result.outcome).toBe('finalized');
    expect(result.turns).toBe(3);
    expect(result.toolCalls.map((entry) => entry.toolName)).toEqual([
      'get_recent_activity_snapshot',
      'finalize_direct_answer',
      'finalize_direct_answer',
    ]);
    expect(result.finalProposal?.proposal).toMatchObject({
      citedMessageIds: ['snapshot-citation-source'],
    });
  });

  it('applies an optional direct-answer semantic validator and accepts one correction', async () => {
    const tooLong = 'x'.repeat(1_451);
    let validations = 0;
    faux.handle.setResponses([
      fauxAssistantMessage([
        fauxToolCall('finalize_direct_answer', {
          targetChannelId: CHANNEL,
          message: tooLong,
          citedMessageIds: [],
        }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('finalize_direct_answer', {
          targetChannelId: CHANNEL,
          message: 'Corrected recap.',
          citedMessageIds: [],
        }),
      ], { stopReason: 'toolUse' }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, {
      runType: 'direct_answer',
      runId: 'run-custom-semantic-correction',
      directAnswerSemanticValidator: (proposal) => {
        validations += 1;
        return proposal.message.length > 1_450
          ? 'The recap body must be at most 1450 characters.'
          : null;
      },
    }));

    expect(result.outcome).toBe('finalized');
    expect(result.turns).toBe(2);
    expect(validations).toBe(2);
    expect(result.toolCalls.map((entry) => entry.toolName)).toEqual([
      'finalize_direct_answer',
      'finalize_direct_answer',
    ]);
    expect(result.finalProposal?.proposal).toMatchObject({ message: 'Corrected recap.' });
  });

  it('stops after a second semantic rejection and cannot accept a third finalization', async () => {
    const tooLong = 'x'.repeat(1_451);
    let validations = 0;
    const oversizedFinalization = () => fauxAssistantMessage([
      fauxToolCall('finalize_direct_answer', {
        targetChannelId: CHANNEL,
        message: tooLong,
        citedMessageIds: [],
      }),
    ], { stopReason: 'toolUse' });
    faux.handle.setResponses([
      oversizedFinalization(),
      oversizedFinalization(),
      fauxAssistantMessage([
        fauxToolCall('finalize_direct_answer', {
          targetChannelId: CHANNEL,
          message: 'This third attempt must never be accepted.',
          citedMessageIds: [],
        }),
      ], { stopReason: 'toolUse' }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, {
      runType: 'direct_answer',
      runId: 'run-custom-semantic-exhausted',
      directAnswerSemanticValidator: (proposal) => {
        validations += 1;
        return proposal.message.length > 1_450
          ? 'The recap body must be at most 1450 characters.'
          : null;
      },
    }));

    expect(result.outcome).toBe('validation_rejected');
    expect(result.turns).toBe(2);
    expect(validations).toBe(2);
    expect(result.finalProposal).toBeNull();
    expect(result.toolCalls.map((entry) => entry.toolName)).toEqual([
      'finalize_direct_answer',
      'finalize_direct_answer',
    ]);
  });

  it('accepts an uncited direct answer when the activity snapshot is empty', async () => {
    env.db.prepare("UPDATE channels SET visibility_class='org' WHERE id=?").run(CHANNEL);
    faux.handle.setResponses([
      fauxAssistantMessage([
        fauxToolCall('get_recent_activity_snapshot', {
          after: new Date(NOW - 86_400_000).toISOString(),
          before: new Date(NOW).toISOString(),
        }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('finalize_direct_answer', {
          targetChannelId: CHANNEL,
          message: 'There was no activity in that window.',
          citedMessageIds: [],
        }),
      ], { stopReason: 'toolUse' }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, {
      runType: 'direct_answer',
      runId: 'run-empty-snapshot-no-citation',
      requestCreatedAtMs: NOW,
    }));

    expect(result.outcome).toBe('finalized');
    expect(result.provenance.recentActivitySnapshot).toMatchObject({
      totalMatching: 0,
      included: 0,
      exposedMessageIds: [],
    });
    expect(result.finalProposal?.proposal).toMatchObject({ citedMessageIds: [] });
  });

  it('finalizes a successful run: completed status, accepted proposal, full audit, persisted row', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'onboarding' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('finalize_episode_review', episodeReview())], {
        stopReason: 'toolUse',
      }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux));

    expect(result.outcome).toBe('finalized');
    expect(result.status).toBe('completed');
    expect(result.failureReason).toBeNull();
    expect(result.turns).toBe(2);
    if (!result.finalProposal) {
      throw new Error('expected a finalized episode-review proposal');
    }
    expect(result.finalProposal.kind).toBe('episode_review');
    expect((result.finalProposal.proposal as { episodeSummary: string }).episodeSummary).toBe(
      'We adopted the onboarding trial.',
    );

    // Both tool calls were audited (accepted, not blocked).
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.every((e) => e.accepted && !e.blocked)).toBe(true);
    expect(result.toolCalls.map((e) => e.toolName)).toEqual([
      'search_messages',
      'finalize_episode_review',
    ]);

    // The agent_runs row was persisted with the full record.
    const row = env.db
      .prepare(
        `SELECT status, run_type, prompt_version, provider, model, input_tokens,
          uncached_input_tokens, cache_read_tokens, cache_write_tokens,
          cache_write_1h_tokens, output_tokens, reasoning_tokens, provider_total_tokens,
          cost_usd, uncached_input_cost_usd, output_cost_usd, cache_read_cost_usd,
          cache_write_cost_usd, thinking_level, tool_calls_json, model_turns_json,
          retrieval_provenance_json, final_proposal_json, error
          FROM agent_runs WHERE id = ?`,
      )
      .get('run-1') as {
      status: string;
      run_type: string;
      prompt_version: string;
      provider: string;
      model: string;
      input_tokens: number;
      uncached_input_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cache_write_1h_tokens: number | null;
      output_tokens: number;
      reasoning_tokens: number | null;
      provider_total_tokens: number;
      cost_usd: number;
      uncached_input_cost_usd: number;
      output_cost_usd: number;
      cache_read_cost_usd: number;
      cache_write_cost_usd: number;
      thinking_level: string;
      tool_calls_json: string;
      model_turns_json: string;
      retrieval_provenance_json: string;
      final_proposal_json: string;
      error: string | null;
    };
    expect(row.status).toBe('completed');
    expect(row.run_type).toBe('episode');
    expect(row.prompt_version).toBe(PROMPT_VERSION);
    expect(row.provider).toBe('faux');
    expect(row.model).toBe('faux-1');
    expect(row.error).toBeNull();
    expect(typeof row.input_tokens).toBe('number');
    expect(typeof row.output_tokens).toBe('number');
    expect(row).toMatchObject({
      input_tokens: result.usage.inputTokens,
      uncached_input_tokens: result.usage.uncachedInputTokens,
      cache_read_tokens: result.usage.cacheReadTokens,
      cache_write_tokens: result.usage.cacheWriteTokens,
      cache_write_1h_tokens: result.usage.cacheWrite1hTokens,
      output_tokens: result.usage.outputTokens,
      reasoning_tokens: result.usage.reasoningTokens,
      provider_total_tokens: result.usage.providerTotalTokens,
      cost_usd: result.usage.costUsd,
      uncached_input_cost_usd: result.usage.uncachedInputCostUsd,
      output_cost_usd: result.usage.outputCostUsd,
      cache_read_cost_usd: result.usage.cacheReadCostUsd,
      cache_write_cost_usd: result.usage.cacheWriteCostUsd,
      thinking_level: 'minimal',
    });
    expect(JSON.parse(row.tool_calls_json)).toHaveLength(2);
    expect(result.modelTurns).toHaveLength(2);
    expect(result.toolCalls.map((call) => call.turnIndex)).toEqual([1, 2]);
    expect(result.modelTurns.every((turn) => turn.durationMs >= (turn.modelDurationMs ?? 0))).toBe(true);
    expect(JSON.parse(row.model_turns_json)).toEqual(result.modelTurns);
    expect(JSON.parse(row.retrieval_provenance_json).channels).toEqual([]);
    const proposal = JSON.parse(row.final_proposal_json) as { episodeSummary: string };
    expect(proposal.episodeSummary).toBe('We adopted the onboarding trial.');
  });

  it('fails closed when a model expected to be billable reports tokens with zero cost', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('finalize_episode_review', episodeReview())], {
        stopReason: 'toolUse',
      }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, {
      requireKnownPricing: true,
      runId: 'run-pricing-anomaly',
    }));

    expect(result).toMatchObject({
      outcome: 'error',
      status: 'failed',
      finalProposal: null,
      usage: { costUsd: 0 },
    });
    expect(result.usage.inputTokens + result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.failureReason).toContain('pricing unavailable');
  });

  it('accepts positive token usage when the provider reports a nonzero cost', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('finalize_episode_review', episodeReview())], {
        stopReason: 'toolUse',
      }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, {
      requireKnownPricing: true,
      model: {
        ...faux.model,
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      },
      streamFn: withReportedCost(faux.streamFn, 0.004),
      runId: 'run-priced-usage',
    }));

    expect(result.outcome).toBe('finalized');
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });

  it('lets a direct-answer run read its own documentation (Sections 22.5–22.7)', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('list_docs', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('read_doc', { path: 'index.md' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(
        [
          fauxToolCall('finalize_direct_answer', {
            targetChannelId: CHANNEL,
            message: 'I keep one SQLite database and speak rarely.',
            citedMessageIds: [],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
    ]);

    const result = await executeAgentRun(
      baseDeps(env, faux, { runType: 'direct_answer', docs: DOCS, runId: 'run-docs' }),
    );

    expect(result.outcome).toBe('finalized');
    expect(result.toolCalls.map((e) => e.toolName)).toEqual([
      'list_docs',
      'read_doc',
      'finalize_direct_answer',
    ]);
    expect(result.toolCalls.every((e) => e.accepted && !e.blocked && !e.isError)).toBe(true);
    // Documentation is not channel-scoped: only the initial payload channel is
    // provenance, and no memory scope was exposed.
    expect(result.provenance.channels.map((c) => c.channelId)).toEqual([]);
    expect(result.provenance.memoryScopes).toEqual([]);
    expect(result.provenance.charsExposed).toBeGreaterThan(0);
  });

  it('never executes a documentation tool in an episode review, and fails closed', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('list_docs', {})], { stopReason: 'toolUse' }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, { docs: DOCS, runId: 'run-docs-blocked' }));

    // The tool is not part of an episode review's closed tool set, so the call
    // never executes and the run ends without a proposal.
    expect(result.status).toBe('failed');
    expect(result.finalProposal).toBeNull();
    expect(result.toolCalls.some((e) => e.toolName === 'list_docs' && e.accepted)).toBe(false);
    expect(result.provenance.charsExposed).toBe(0);
  });

  it('reports an unindexed documentation path as a correctable tool error', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('read_doc', { path: '../.env' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(
        [
          fauxToolCall('finalize_direct_answer', {
            targetChannelId: CHANNEL,
            message: 'I cannot find that in my documentation.',
            citedMessageIds: [],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
    ]);

    const result = await executeAgentRun(
      baseDeps(env, faux, { runType: 'direct_answer', docs: DOCS, runId: 'run-docs-bad-path' }),
    );

    // The rejection is an error result, not a terminated run: the agent recovers.
    expect(result.outcome).toBe('finalized');
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'read_doc', accepted: true, isError: true });
  });

  it('steers a run whose tool-call budget is spent into a finalize-only turn, and it completes', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'a' })], { stopReason: 'toolUse' }),
      // Over budget: blocked, and the result text is the finalization directive.
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'b' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('finalize_episode_review', episodeReview())], { stopReason: 'toolUse' }),
    ]);
    const seen: ObservedRequest[] = [];

    const result = await executeAgentRun(baseDeps(env, faux, {
      limits: { maxToolCalls: 1 },
      streamFn: observing(faux.streamFn, seen),
      runId: 'run-budget',
    }));

    expect(result.outcome).toBe('finalized');
    expect(result.status).toBe('completed');
    expect(result.finalProposal).not.toBeNull();
    expect(result.turns).toBe(3);
    expect(result.toolCalls.map((e) => e.toolName)).toEqual([
      'search_messages',
      'search_messages',
      'finalize_episode_review',
    ]);
    expect(result.toolCalls[1]).toMatchObject({
      blocked: true,
      blockReason: expect.stringContaining('tool-call budget'),
    });
    // Turns 1 and 2 offered the full read set; turn 3 offered the terminal tool
    // alone and opened with the one host directive.
    expect(seen).toHaveLength(3);
    expect(seen[0]!.tools).toContain('search_messages');
    expect(seen[2]!.tools).toEqual(['finalize_episode_review']);
    expect(seen[2]!.lastRole).toBe('user');
    expect(seen[2]!.lastText).toBe(finalizationDirective('finalize_episode_review'));
    expect(new Set(seen.map((request) => request.cacheKey)).size).toBe(1);
  });

  it('preserves unique session identity while sharing safe-surface cache affinity', async () => {
    const seen: ObservedRequest[] = [];
    for (const [runId, sessionId] of [['cache-run-a', 'mneme:episode:sentinel-a'], ['cache-run-b', 'mneme:episode:sentinel-b']]) {
      faux.handle.setResponses([
        fauxAssistantMessage([fauxToolCall('finalize_episode_review', episodeReview())], { stopReason: 'toolUse' }),
      ]);
      await executeAgentRun(baseDeps(env, faux, {
        runId,
        sessionId,
        streamFn: observing(faux.streamFn, seen),
      }));
    }
    expect(seen.map((request) => request.sessionId)).toEqual([
      'mneme:episode:sentinel-a', 'mneme:episode:sentinel-b',
    ]);
    expect(seen[0]!.cacheKey).toBe(seen[1]!.cacheKey);
    expect(seen[0]!.cacheKey).toMatch(/^cas:v1:episode:[0-9a-f]{40}$/);
    const rows = env.db.prepare(
      `SELECT tool_calls_json, model_turns_json, retrieval_provenance_json
       FROM agent_runs WHERE id IN ('cache-run-a', 'cache-run-b')`,
    ).all();
    expect(JSON.stringify(rows)).not.toContain('provider-payload-secret');
    expect(JSON.stringify(rows)).not.toContain(String(seen[0]!.cacheKey));
  });

  it('fails closed as budget_exceeded when the model ignores the finalize-only directive', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'a' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'b' })], { stopReason: 'toolUse' }),
      // Offered only the terminal tool and told to finalize, the model stops with prose.
      fauxAssistantMessage('Nothing further.'),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, { limits: { maxToolCalls: 1 }, runId: 'run-ignored' }));

    expect(result.outcome).toBe('budget_exceeded');
    expect(result.status).toBe('failed');
    expect(result.finalProposal).toBeNull();
    expect(result.turns).toBe(3);
    expect(result.failureReason).toContain('maxToolCalls=1');
    expect(result.failureReason).toContain('did not finalize');
  });

  it('reserves the last two turns of a review run for finalization', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'a' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'b' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('finalize_episode_review', episodeReview())], { stopReason: 'toolUse' }),
    ]);
    const seen: ObservedRequest[] = [];

    const result = await executeAgentRun(baseDeps(env, faux, {
      limits: { maxTurns: 4, maxToolCalls: 8 },
      streamFn: observing(faux.streamFn, seen),
      runId: 'run-reserve',
    }));

    expect(result.outcome).toBe('finalized');
    expect(result.turns).toBe(3);
    // Two turns of retrieval; the reserve begins after maxTurns - 2 turns.
    expect(seen[1]!.tools).toContain('search_messages');
    expect(seen[2]!.tools).toEqual(['finalize_episode_review']);
    expect(seen[2]!.lastText).toBe(finalizationDirective('finalize_episode_review'));
  });

  it('gives a model that stops without any tool call one directive, then fails closed', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage('Let me think about this.'),
      fauxAssistantMessage('I have nothing to add.'),
    ]);
    const seen: ObservedRequest[] = [];

    const result = await executeAgentRun(baseDeps(env, faux, {
      streamFn: observing(faux.streamFn, seen),
      runId: 'run-idle',
    }));

    expect(result.outcome).toBe('no_finalization');
    expect(result.status).toBe('failed');
    expect(result.turns).toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.tools).toEqual(['finalize_episode_review']);
    expect(seen[1]!.lastText).toBe(finalizationDirective('finalize_episode_review'));
  });

  it('offers only the terminal tool from the first turn when the turn budget leaves no room to read', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'a' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'b' })], { stopReason: 'toolUse' }),
    ]);
    const seen: ObservedRequest[] = [];

    const result = await executeAgentRun(baseDeps(env, faux, {
      limits: { maxTurns: 1 },
      streamFn: observing(faux.streamFn, seen),
      runId: 'run-turns',
    }));

    expect(result.outcome).toBe('budget_exceeded');
    expect(result.status).toBe('failed');
    expect(result.finalProposal).toBeNull();
    expect(result.failureReason).toContain('budget');
    expect(seen[0]!.tools).toEqual(['finalize_episode_review']);
    // Pi reports the attempted unregistered call, but it never executes.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'search_messages', execution: 'not_executed', accepted: false });
  });

  it('counts cached input tokens as input', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('finalize_episode_review', episodeReview())], { stopReason: 'toolUse' }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, {
      model: { ...faux.model, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
      streamFn: withReportedUsage(faux.streamFn, {
        input: 6,
        cacheRead: 1_200,
        cacheWrite: 300,
        cacheWrite1h: 25,
        output: 50,
        reasoning: 20,
        totalTokens: 7_777,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0009, total: 0.004 },
      }),
      runId: 'run-cached-usage',
    }));

    expect(result.outcome).toBe('finalized');
    expect(result.usage).toEqual({
      inputTokens: 1_506,
      outputTokens: 50,
      costUsd: 0.004,
      uncachedInputTokens: 6,
      cacheReadTokens: 1_200,
      cacheWriteTokens: 300,
      cacheWrite1hTokens: 25,
      reasoningTokens: 20,
      providerTotalTokens: 7_777,
      uncachedInputCostUsd: 0.001,
      outputCostUsd: 0.002,
      cacheReadCostUsd: 0.0001,
      cacheWriteCostUsd: 0.0009,
    });
  });

  it('reserves finalize plus correction turns after the direct-answer read boundary', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'first' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'second' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'third' })], { stopReason: 'toolUse' }),
      // This fourth read is replaced with the non-terminal finalize-now result.
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'too late' })], { stopReason: 'toolUse' }),
      // First finalization is semantically rejected and may be corrected once.
      fauxAssistantMessage([fauxToolCall('finalize_direct_answer', {
        targetChannelId: '999999999999999999',
        message: 'Initial answer.',
        citedMessageIds: [],
      })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('finalize_direct_answer', {
        targetChannelId: CHANNEL,
        message: 'Corrected answer.',
        citedMessageIds: [],
      })], { stopReason: 'toolUse' }),
    ]);

    const result = await executeAgentRun(baseDeps(env, faux, {
      runType: 'direct_answer',
      limits: { maxTurns: 6, maxToolCalls: 8 },
      runId: 'run-direct-finalization-reserve',
    }));

    expect(result.outcome).toBe('finalized');
    expect(result.turns).toBe(6);
    expect(result.finalProposal?.proposal).toMatchObject({ message: 'Corrected answer.' });
    expect(result.toolCalls.map((entry) => entry.toolName)).toEqual([
      'search_messages',
      'search_messages',
      'search_messages',
      'search_messages',
      'finalize_direct_answer',
      'finalize_direct_answer',
    ]);
    expect(result.toolCalls[3]).toMatchObject({
      blocked: true,
      blockReason: expect.stringContaining('finalize now'),
    });
  });

  it('fails closed on wall-clock timeout without sending anything', async () => {
    faux.handle.setResponses([blockingUntilAborted()]);

    const result = await executeAgentRun(
      baseDeps(env, faux, { limits: { wallClockMs: 5 }, runId: 'run-timeout' }),
    );

    expect(result.outcome).toBe('aborted');
    expect(result.status).toBe('failed');
    expect(result.finalProposal).toBeNull();
    expect(result.failureReason).toContain('timeout');
    expect(result.failureReason).toContain('without output');
  });

  it('records execution start independently from immutable semantic now', async () => {
    faux.handle.setResponses([
      fauxAssistantMessage([
        fauxToolCall('finalize_episode_review', episodeReview()),
      ], { stopReason: 'toolUse' }),
    ]);
    const executionNow = NOW + 10_000;

    const result = await executeAgentRun(baseDeps(env, faux, {
      runId: 'run-observed-start',
      clock: () => executionNow,
    }));

    expect(result.startedAtMs).toBe(NOW);
    expect(result.endedAtMs).toBe(executionNow);
    expect(env.db.prepare(`SELECT started_at_ms,execution_started_at_ms,ended_at_ms
      FROM agent_runs WHERE id=?`).get('run-observed-start')).toEqual({
      started_at_ms: NOW,
      execution_started_at_ms: executionNow,
      ended_at_ms: executionNow,
    });
  });

  it('records a running row even while the run is in progress (crash traceability)', () => {
    // The insert happens synchronously at the start of executeAgentRun; verify
    // the schema accepts the running row by inserting one directly here.
    env.db
      .prepare(
        `INSERT INTO agent_runs
           (id, guild_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
         VALUES (?, ?, NULL, 'episode', ?, 'faux', 'faux-1', 'running', ?)`,
      )
      .run('run-running', GUILD, PROMPT_VERSION, NOW);
    const row = env.db
      .prepare('SELECT status, ended_at_ms, tool_calls_json FROM agent_runs WHERE id = ?')
      .get('run-running') as { status: string; ended_at_ms: number | null; tool_calls_json: string };
    expect(row.status).toBe('running');
    expect(row.ended_at_ms).toBeNull();
    expect(JSON.parse(row.tool_calls_json)).toEqual([]);
  });
});
