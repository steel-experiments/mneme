import { Agent, uuidv7 } from '@earendil-works/pi-agent-core';
import type {
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Api, Model, ThinkingLevel, Usage } from '@earendil-works/pi-ai';
import { hasBillablePricing } from './model.js';
import { type DatabaseSync } from '../db/database.js';
import type { RetrievalGrant } from '../db/repositories/message-search.js';
import {
  RunRetrievalState,
  type AgentRunContext,
  type RetrievalProvenance,
} from './run-context.js';
import { createSearchMessagesTool } from './tools/search-messages.js';
import { createListRecentMessagesTool } from './tools/list-recent-messages.js';
import { createGetRecentActivitySnapshotTool } from './tools/get-recent-activity-snapshot.js';
import { createGetMessageContextTool } from './tools/get-message-context.js';
import { createSearchMemoriesTool } from './tools/search-memories.js';
import { createListMemoriesTool } from './tools/list-memories.js';
import { createGetMemoryEvidenceTool } from './tools/get-memory-evidence.js';
import { createListDocsTool } from './tools/list-docs.js';
import { createReadDocTool } from './tools/read-doc.js';
import type { DocsIndex } from './docs-index.js';
import {
  createFinalizeEpisodeReviewTool,
  createFinalizeDirectAnswerTool,
  createFinalizeScheduledReviewTool,
  RunFinalizationState,
  type AcceptedProposal,
  type FinalizeCommit,
  type FinalizeSemanticValidator,
} from './tools/finalize.js';
import { FinalizeDirectAnswer } from './schemas.js';
import {
  RunTraceRecorder,
  type ModelTurnAuditEntry,
  type ToolAuditEntry,
} from './run-trace.js';
import {
  createUsageAccumulator,
  type AgentRunUsage,
} from './usage.js';
import {
  createPromptCacheAffinityHook,
  derivePromptCacheKey,
  type CacheProfile,
} from './prompt-cache.js';

export type { ModelTurnAuditEntry, ToolAuditEntry } from './run-trace.js';
export type { AgentRunUsage } from './usage.js';

/**
 * Bounded, ephemeral Pi Agent Core runtime (Sections 4.1, 21, 43.5).
 *
 * One fresh {@link Agent} session is constructed per review run. The agent
 * receives only purpose-built read-only retrieval tools and a single terminal
 * finalization tool — never a shell, filesystem, browser, HTTP, or Discord-send
 * tool (Section 4.1). Every bound is enforced by the host and failing a bound
 * fails closed: the run ends with a failed status and no accepted proposal, so
 * nothing is ever sent as a side effect of an over-budget or injected run
 * (Section 43.5).
 *
 * The runtime is transport-agnostic: {@link ExecuteAgentRunDeps.streamFn} and
 * the resolved {@link Model} are injected, so tests drive a scripted stream with
 * no network and production binds `Models.streamSimple`.
 */

/** The six read-only retrieval tools exposed to every run. */
export const AGENT_READ_TOOL_NAMES = [
  'search_messages',
  'list_recent_messages',
  'get_message_context',
  'search_memories',
  'list_memories',
  'get_memory_evidence',
] as const;

/** The documentation tools, exposed to direct-answer runs only (Section 22.7). */
export const AGENT_DOC_TOOL_NAMES = ['list_docs', 'read_doc'] as const;

/** One-call catch-up retrieval, exposed only to direct-answer runs. */
export const AGENT_DIRECT_ANSWER_TOOL_NAMES = ['get_recent_activity_snapshot'] as const;

/** Matches `agent_runs.run_type` (migrations/003_operations.sql). */
export type AgentRunType = 'episode' | 'direct_answer' | 'scheduled_review';

/** Matches `agent_runs.status`. */
export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'rejected';

/**
 * Why a run ended. `finalized` is the only success outcome; every other value
 * is a closed failure that produces no outbound proposal.
 */
export type AgentRunOutcome =
  | 'finalized'
  | 'aborted'
  | 'budget_exceeded'
  | 'blocked'
  | 'validation_rejected'
  | 'error'
  | 'no_finalization';

/** Per-run host-enforced limits (Section 21.2). */
export interface RunLimits {
  /** Wall-clock cap; exceeding it aborts the run. */
  wallClockMs: number;
  /** Maximum completed model turns without a final proposal. */
  maxTurns: number;
  /** Maximum non-terminal (read-only) tool calls. */
  maxToolCalls: number;
  /** Maximum retrieved characters across the whole run. */
  charBudget: number;
}

/**
 * Section 21.2 defaults: 120 s wall-clock, 6 turns, 8 non-terminal tool calls,
 * 60 000 retrieved characters, one review worker (concurrency is the caller's
 * concern — the runtime itself is single-run).
 */
export const DEFAULT_RUN_LIMITS: RunLimits = {
  wallClockMs: 120_000,
  maxTurns: 6,
  maxToolCalls: 8,
  charBudget: 60_000,
};

/**
 * Turns every run keeps for finalization: the terminal call plus one
 * correction. Two turns before the turn limit — or as soon as the non-terminal
 * tool-call budget is spent, or when the model ends a turn without any tool
 * call — the host enters the finalize-only phase: the next provider request
 * offers the terminal tool alone, and one host-authored directive asks the
 * model to finalize with the evidence already retrieved. The work a run has
 * already paid for is not discarded because a limit was reached; the model is
 * given a turn in which finalizing is the only possible action.
 */
export const FINALIZATION_RESERVE_TURNS = 2;

/** The one directive sent when a run enters the finalize-only phase. */
export function finalizationDirective(terminalName: string): string {
  return `Retrieval is closed for this run. Call ${terminalName} now with the evidence already retrieved. `
    + 'If the evidence is insufficient, finalize conservatively and state what is missing.';
}

/** Direct answers keep the last two model turns for finalize + one correction. */
export const DIRECT_ANSWER_FINALIZATION_RESERVE_TURNS = FINALIZATION_RESERVE_TURNS;
const DIRECT_ANSWER_FINALIZE_NOW_RESULT =
  'Direct-answer retrieval is complete. Synthesize the best answer from the context already available and call finalize_direct_answer now. If evidence is insufficient, say what is missing.';

/**
 * Last turn belonging to the direct-answer read phase. The boundary turn is
 * used to return the non-terminal "finalize now" result, so normal retrieval is
 * allowed for at most `ceiling - 1` turns. Clamping keeps tiny test/override
 * budgets fail-closed without negative arithmetic.
 */
export function directAnswerReadTurnCeiling(maxTurns: number): number {
  const boundedTurns = Number.isFinite(maxTurns) ? Math.max(0, Math.floor(maxTurns)) : 0;
  return Math.max(
    0,
    boundedTurns - DIRECT_ANSWER_FINALIZATION_RESERVE_TURNS,
  );
}

/** True when another read must yield the read-phase boundary result. */
export function directAnswerShouldFinalizeNow(
  completedTurns: number,
  readTurnCeiling: number,
): boolean {
  if (readTurnCeiling <= 0) return true;
  return completedTurns >= readTurnCeiling - 1;
}

/** The outcome of a run, persisted to `agent_runs` and returned to the caller. */
export interface AgentRunResult {
  runId: string;
  status: AgentRunStatus;
  outcome: AgentRunOutcome;
  /** Redacted failure reason, or null on success. */
  failureReason: string | null;
  turns: number;
  modelTurns: ModelTurnAuditEntry[];
  toolCalls: ToolAuditEntry[];
  usage: AgentRunUsage;
  provenance: RetrievalProvenance;
  finalProposal: AcceptedProposal | null;
  startedAtMs: number;
  endedAtMs: number;
}

/** Terminal tool name for a run type (the run's single non-read-only tool). */
export function agentTerminalToolName(runType: AgentRunType): string {
  switch (runType) {
    case 'episode':
      return 'finalize_episode_review';
    case 'direct_answer':
      return 'finalize_direct_answer';
    case 'scheduled_review':
      return 'finalize_scheduled_review';
  }
}

function terminalToolFor(
  runType: AgentRunType,
  state: RunFinalizationState,
  ctx: AgentRunContext,
  commit?: FinalizeCommit,
  directAnswerSemanticValidator?: FinalizeSemanticValidator<typeof FinalizeDirectAnswer>,
): AgentTool<any> {
  if (runType === 'episode') return createFinalizeEpisodeReviewTool(state, commit);
  if (runType === 'direct_answer') {
    return createFinalizeDirectAnswerTool(
      state,
      commit,
      composeDirectAnswerSemanticValidators(ctx, directAnswerSemanticValidator),
    );
  }
  return createFinalizeScheduledReviewTool(state, commit);
}

function composeDirectAnswerSemanticValidators(
  ctx: AgentRunContext,
  validator?: FinalizeSemanticValidator<typeof FinalizeDirectAnswer>,
): FinalizeSemanticValidator<typeof FinalizeDirectAnswer> {
  return (proposal) => {
    const snapshot = ctx.retrieval.provenance().recentActivitySnapshot;
    if (snapshot && snapshot.exposedMessageIds.length > 0) {
      const exposedSnapshotIds = new Set(snapshot.exposedMessageIds);
      if (!proposal.citedMessageIds.some((id) => exposedSnapshotIds.has(id))) {
        return 'A nonempty recent activity snapshot must cite at least one message ID exposed by that snapshot.';
      }
    }
    return validator?.(proposal) ?? null;
  };
}

/**
 * The read-only tool names a run type may call: the six common retrieval tools,
 * plus the one-call activity snapshot and documentation tools for a direct
 * answer (Section 22.7). Episode and scheduled runs receive neither extension.
 */
export function agentReadToolNames(runType: AgentRunType): string[] {
  return runType === 'direct_answer'
    ? [
      ...AGENT_READ_TOOL_NAMES,
      ...AGENT_DIRECT_ANSWER_TOOL_NAMES,
      ...AGENT_DOC_TOOL_NAMES,
    ]
    : [...AGENT_READ_TOOL_NAMES];
}

/**
 * Build the exact, closed tool set a run exposes: the six common read-only
 * retrieval tools; the activity snapshot and, when indexed, documentation tools
 * for a direct answer; plus the one terminal finalization tool. No
 * shell, filesystem, browser, HTTP, or send tool is ever included (Section 4.1).
 * Exposed for tests that assert the exposed surface. The accepted proposal is
 * read from `state.accepted` after the run, so no commit callback is required.
 */
export function buildRunTools(
  ctx: AgentRunContext,
  runType: AgentRunType,
  state: RunFinalizationState,
  commit?: FinalizeCommit,
  directAnswerSemanticValidator?: FinalizeSemanticValidator<typeof FinalizeDirectAnswer>,
): AgentTool<any>[] {
  const docTools =
    runType === 'direct_answer' && ctx.docs
      ? [createListDocsTool(ctx, ctx.docs), createReadDocTool(ctx, ctx.docs)]
      : [];
  const directAnswerTools = runType === 'direct_answer'
    ? [createGetRecentActivitySnapshotTool(ctx)]
    : [];
  return [
    createSearchMessagesTool(ctx),
    createListRecentMessagesTool(ctx),
    ...directAnswerTools,
    createGetMessageContextTool(ctx),
    createSearchMemoriesTool(ctx),
    createListMemoriesTool(ctx),
    createGetMemoryEvidenceTool(ctx),
    ...docTools,
    terminalToolFor(runType, state, ctx, commit, directAnswerSemanticValidator),
  ];
}

// ---- Host policy hooks (Sections 21.1, 43.5) -------------------------------

export interface ReadOnlyPolicyOptions {
  /** Tool names permitted to execute (read-only tools + the terminal tool). */
  allowedNames: ReadonlySet<string>;
  /** The run's terminal tool name (excluded from the non-terminal budget). */
  terminalName: string;
  maxToolCalls: number;
  /** Direct-answer-only soft boundary; omitted for review and scheduled runs. */
  softReadTurnCeiling?: number;
  /** Completed provider turns, read lazily when the soft boundary is enabled. */
  completedTurns?: () => number;
  /** Called when a non-terminal call is allowed (for external counting, if any). */
  onNonTerminalCall?: () => void;
  /** Called when a read is replaced with the non-terminal finalize-now result. */
  onSoftReadLimit?: (entry: ToolAuditEntry) => void;
  /** Called when a call is blocked; receives the audit entry and end reason. */
  onBlock?: (entry: ToolAuditEntry, reason: Exclude<AgentRunOutcome, 'finalized'>) => void;
  /** Called once the non-terminal budget is spent, so the run can enter the finalize-only phase. */
  onBudgetExhausted?: () => void;
}

/**
 * `beforeToolCall` hook: enforce the read-only allowlist and the non-terminal
 * tool-call budget (Section 21.1: `enforceToolBudgetAndReadOnlyPolicy`). A call
 * to any tool outside the allowlist — a shell, filesystem, browser, HTTP, or
 * send tool — is blocked and terminates the run (fail closed). The non-terminal
 * budget blocks the (N+1)th read-only call the same way. Direct-answer runs may
 * additionally replace late reads with a non-terminal synthesize/finalize-now
 * result, leaving the hard call cap unchanged. Defense-in-depth: the agent can
 * only call registered tools, but this hook is the explicit host gate.
 */
export function createReadOnlyPolicyHook(opts: ReadOnlyPolicyOptions) {
  let nonTerminalCalls = 0;
  return async (
    context: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> => {
    const name = context.toolCall.name;
    const id = context.toolCall.id;

    if (!opts.allowedNames.has(name)) {
      opts.onBlock?.(
        {
          toolName: name,
          toolCallId: id,
          accepted: false,
          blocked: true,
          blockReason: 'tool not in read-only allowlist',
          isError: true,
          argsChars: 0,
          resultChars: 0,
        },
        'blocked',
      );
      return {
        block: true,
        reason: `Tool "${name}" is not permitted: only read-only retrieval tools and the terminal finalization tool may execute.`,
        terminate: true,
      };
    }

    if (name !== opts.terminalName) {
      nonTerminalCalls += 1;
      opts.onNonTerminalCall?.();
      if (nonTerminalCalls > opts.maxToolCalls) {
        // The blocked call's result carries the finalization directive, and the
        // runtime narrows the next turn to the terminal tool. `budget_exceeded`
        // stays the fallback outcome for a model that still never finalizes.
        opts.onBlock?.(
          {
            toolName: name,
            toolCallId: id,
            accepted: false,
            blocked: true,
            blockReason: `non-terminal tool-call budget (${opts.maxToolCalls}) exceeded; finalize-only phase`,
            isError: true,
            argsChars: 0,
            resultChars: 0,
          },
          'budget_exceeded',
        );
        opts.onBudgetExhausted?.();
        return {
          block: true,
          reason: finalizationDirective(opts.terminalName),
          terminate: true,
        };
      }

      if (
        opts.softReadTurnCeiling !== undefined
        && directAnswerShouldFinalizeNow(
          opts.completedTurns?.() ?? 0,
          opts.softReadTurnCeiling,
        )
      ) {
        opts.onSoftReadLimit?.({
          toolName: name,
          toolCallId: id,
          accepted: false,
          blocked: true,
          blockReason: 'direct-answer read phase complete; finalize now',
          isError: false,
          argsChars: safeArgsChars(context.args),
          resultChars: DIRECT_ANSWER_FINALIZE_NOW_RESULT.length,
        });
        return {
          block: true,
          reason: DIRECT_ANSWER_FINALIZE_NOW_RESULT,
          terminate: false,
        };
      }
    }

    return undefined;
  };
}

export interface AuditHookOptions {
  /** Called for each executed tool with a size-only (content-redacted) entry. */
  onToolResult?: (entry: ToolAuditEntry) => void;
}

function safeArgsChars(args: unknown): number {
  try {
    return JSON.stringify(args ?? {}).length;
  } catch {
    return 0;
  }
}

/**
 * `afterToolCall` hook: record a content-redacted audit entry for each executed
 * tool (Section 21.1: `redactAndAuditToolResult`). Tool content is never stored
 * verbatim — only the rendered text length — and the executed tools already
 * redact what they return, so the hook records and does not override.
 */
export function createAuditHook(opts: AuditHookOptions) {
  return async (
    context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> => {
    const resultText = (context.result?.content ?? [])
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    opts.onToolResult?.({
      toolName: context.toolCall.name,
      toolCallId: context.toolCall.id,
      accepted: true,
      blocked: false,
      isError: !!context.isError,
      argsChars: safeArgsChars(context.args),
      resultChars: resultText.length,
    });
    return undefined;
  };
}

// ---- Error redaction --------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /[a-f0-9]{64,}/gi,
];

/** Strip credential-shaped substrings and cap length; never echo raw secrets. */
function redactError(msg: string | null | undefined): string | null {
  if (!msg) return null;
  let out = msg.slice(0, 500);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

function failureMessageFor(
  reason: Exclude<AgentRunOutcome, 'finalized'>,
  limits: RunLimits,
  streamError: string | null,
): string {
  switch (reason) {
    case 'aborted':
      return `wall-clock timeout (${limits.wallClockMs}ms) exceeded; run aborted without output.`;
    case 'budget_exceeded':
      return `run budget (maxTurns=${limits.maxTurns}, maxToolCalls=${limits.maxToolCalls}) exhausted and the model did not finalize after the finalize-only directive; nothing sent.`;
    case 'blocked':
      return 'agent attempted a tool outside the read-only allowlist; run failed closed without output.';
    case 'validation_rejected':
      return 'final proposal remained invalid after one correction; run failed closed without output.';
    case 'error': {
      const redacted = redactError(streamError);
      return redacted ? `model stream error: ${redacted}` : 'model stream error; details redacted.';
    }
    case 'no_finalization':
      return 'run ended without submitting a final proposal; nothing sent.';
  }
}

// ---- Persistence (agent_runs, migrations/003_operations.sql) ----------------

function insertRunningRun(
  db: DatabaseSync,
  deps: ExecuteAgentRunDeps,
  runId: string,
  semanticNow: number,
  executionStartedAtMs: number,
): void {
  db.prepare(
    `INSERT INTO agent_runs
       (id, guild_id, episode_id, run_type, prompt_version, provider, model, status,
        started_at_ms, execution_started_at_ms, thinking_level, shadow_of_run_id,
        tool_calls_json, model_turns_json, retrieval_provenance_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, '[]', '[]', '[]')`,
  ).run(
    runId,
    deps.guildId,
    deps.episodeId ?? null,
    deps.runType,
    deps.promptVersion,
    deps.providerId,
    deps.modelId,
    semanticNow,
    executionStartedAtMs,
    deps.thinkingLevel,
    deps.shadowOfRunId ?? null,
  );
}

function persistRunResult(db: DatabaseSync, runId: string, result: AgentRunResult): void {
  db.prepare(
    `UPDATE agent_runs SET
       status = ?, ended_at_ms = ?, input_tokens = ?,
       uncached_input_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
       cache_write_1h_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
       provider_total_tokens = ?, cost_usd = ?, uncached_input_cost_usd = ?,
       output_cost_usd = ?, cache_read_cost_usd = ?, cache_write_cost_usd = ?,
       tool_calls_json = ?, model_turns_json = ?, retrieval_provenance_json = ?, final_proposal_json = ?, error = ?
     WHERE id = ?`,
  ).run(
    result.status,
    result.endedAtMs,
    result.usage.inputTokens,
    result.usage.uncachedInputTokens,
    result.usage.cacheReadTokens,
    result.usage.cacheWriteTokens,
    result.usage.cacheWrite1hTokens,
    result.usage.outputTokens,
    result.usage.reasoningTokens,
    result.usage.providerTotalTokens,
    result.usage.costUsd,
    result.usage.uncachedInputCostUsd,
    result.usage.outputCostUsd,
    result.usage.cacheReadCostUsd,
    result.usage.cacheWriteCostUsd,
    JSON.stringify(result.toolCalls),
    JSON.stringify(result.modelTurns),
    JSON.stringify(result.provenance),
    result.finalProposal ? JSON.stringify(result.finalProposal.proposal) : null,
    result.failureReason,
    runId,
  );
}

// ---- Main entry point -------------------------------------------------------

export interface ExecuteAgentRunDeps {
  db: DatabaseSync;
  /** Host-computed scope ceiling injected into every retrieval tool. */
  grant: RetrievalGrant;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  /** Injected stream function; tests pass a scripted stream, production binds `Models.streamSimple`. */
  streamFn: StreamFn;
  sessionId: string;
  cacheProfile: CacheProfile;
  promptText: string;
  promptVersion: string;
  runType: AgentRunType;
  /** Scheduling class may be background even when reusing the direct-answer terminal schema. */
  admissionClass?: 'direct_answer' | 'background';
  guildId: string;
  episodeId?: string | null;
  /** Channel the host pinned as the proposal target; a mismatch rejects finalization. */
  pinnedTargetChannelId: string;
  /** Channels included in the initial prompt payload before any retrieval tool
   * is called. They are part of retrieval provenance just like tool results. */
  initialProvenanceChannelIds?: readonly string[];
  /** Exact messages embedded in the initial prompt payload. */
  initialProvenanceMessages?: ReadonlyArray<{
    messageId: string;
    channelId: string;
    /** Exact version captured while the host rendered the initial payload. */
    fingerprint?: string;
  }>;
  /** Memory scopes embedded in the initial task payload before tool retrieval. */
  initialProvenanceMemoryScopes?: ReadonlyArray<{ memoryId: string; scopeType: string; scopeKey: string | null }>;
  /** Mneme's own documentation; used by direct-answer runs (Section 22.7). */
  docs?: DocsIndex;
  providerId: string;
  modelId: string;
  now: number;
  /** Dedicated observation clock for content-free timing; semantic `now` remains immutable. */
  clock?: () => number;
  /** Immutable creation time of an interactive request, when one exists. */
  requestCreatedAtMs?: number;
  /** Absolute end-to-end deadline for an interactive request. */
  requestDeadlineAtMs?: number;
  limits?: Partial<RunLimits>;
  /** Override the generated run id (for deterministic tests). */
  runId?: string;
  /** Authoritative episode run paired with this non-acting evaluation run. */
  shadowOfRunId?: string;
  /** Fail closed when token usage cannot be priced for a model expected to be billable. */
  requireKnownPricing?: boolean;
  /** Optional host-owned semantic check for this direct-answer finalization only. */
  directAnswerSemanticValidator?: FinalizeSemanticValidator<typeof FinalizeDirectAnswer>;
}

/**
 * Run one bounded, ephemeral agent review to completion and persist its record.
 *
 * Constructs a fresh {@link Agent} with only the closed tool set, enforces the
 * wall-clock, turn, and tool-call budgets via host hooks, accumulates usage and
 * a content-redacted tool audit, and writes the final status, usage, cost, tool
 * audit, retrieval provenance, final proposal, and redacted error to
 * `agent_runs`. Returns the same result for the caller. The runtime itself never
 * sends anything: an over-budget or failing run yields no accepted proposal.
 */
export async function executeAgentRun(deps: ExecuteAgentRunDeps): Promise<AgentRunResult> {
  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...deps.limits };
  const runId = deps.runId ?? uuidv7();
  const terminalName = agentTerminalToolName(deps.runType);
  const softReadTurnCeiling = deps.runType === 'direct_answer'
    ? directAnswerReadTurnCeiling(limits.maxTurns)
    : undefined;

  const budget = {
    turns: 0,
    timedOut: false,
    endReason: null as AgentRunOutcome | null,
    usage: createUsageAccumulator(),
    streamError: null as string | null,
  };

  const allowedNames = new Set<string>([...agentReadToolNames(deps.runType), terminalName]);

  // Finalize-only phase (Section 21.2): entered after this many completed
  // turns, or earlier when the tool-call budget is spent or the model idles.
  const finalizeOnlyFromTurn = Math.max(0, limits.maxTurns - FINALIZATION_RESERVE_TURNS);
  const phase = { finalizeOnly: finalizeOnlyFromTurn === 0, directiveSent: false };

  const finalizeState = new RunFinalizationState(deps.pinnedTargetChannelId);

  const retrieval = new RunRetrievalState(limits.charBudget, deps.now, deps.db);
  const traceClock = deps.clock ?? Date.now;
  const observedStart = traceClock();
  const executionStartedAtMs = Number.isFinite(observedStart) && observedStart >= 0
    ? Math.floor(observedStart)
    : deps.now;
  const trace = new RunTraceRecorder(traceClock, () => retrieval.charsExposed);
  for (const channelId of deps.initialProvenanceChannelIds ?? []) {
    retrieval.recordChannel(channelId, 'initial_payload');
  }
  for (const message of deps.initialProvenanceMessages ?? []) {
    retrieval.recordMessage(
      message.messageId,
      message.channelId,
      'initial_payload',
      message.fingerprint,
    );
  }
  for (const memory of deps.initialProvenanceMemoryScopes ?? []) {
    retrieval.recordMemory(memory.memoryId);
    retrieval.recordMemoryScope(memory.scopeType, memory.scopeKey, 'initial_payload');
    if (memory.scopeType === 'channel' && memory.scopeKey) {
      retrieval.recordChannel(memory.scopeKey, 'initial_payload');
    }
  }
  const ctx: AgentRunContext = {
    db: deps.db,
    grant: deps.grant,
    retrieval,
    requestCreatedAtMs: deps.requestCreatedAtMs,
    docs: deps.docs,
  };
  const tools = buildRunTools(
    ctx,
    deps.runType,
    finalizeState,
    undefined,
    deps.directAnswerSemanticValidator,
  );
  let cacheKey: string | undefined;
  try {
    cacheKey = derivePromptCacheKey({
      profile: deps.cacheProfile,
      model: deps.model,
      requestedThinkingLevel: deps.thinkingLevel,
      promptVersion: deps.promptVersion,
      stableSystemPrompt: deps.systemPrompt,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        constrainedSampling: tool.constrainedSampling,
      })),
    });
  } catch {
    // Cache affinity is optional. Tool descriptor extraction must not fail a run.
    cacheKey = undefined;
  }

  const terminalTool = tools.find((tool) => tool.name === terminalName);
  if (!terminalTool) throw new Error(`terminal tool ${terminalName} missing from the run tool set`);
  const finalizeOnlyTools = [terminalTool];

  // Insert the 'running' row first so a crash still leaves a traceable record.
  insertRunningRun(deps.db, deps, runId, deps.now, executionStartedAtMs);

  const policyHook = createReadOnlyPolicyHook({
    allowedNames,
    terminalName,
    maxToolCalls: limits.maxToolCalls,
    softReadTurnCeiling,
    completedTurns: () => budget.turns,
    onSoftReadLimit: (entry) => trace.blocked(entry),
    onBlock: (entry, reason) => {
      trace.blocked(entry);
      if (budget.endReason === null) budget.endReason = reason;
    },
    onBudgetExhausted: () => {
      phase.finalizeOnly = true;
    },
  });
  const auditHook = createAuditHook({});

  const agent = new Agent({
    initialState: {
      systemPrompt: deps.systemPrompt,
      model: deps.model,
      thinkingLevel: deps.thinkingLevel,
      tools: phase.finalizeOnly ? finalizeOnlyTools : tools,
      messages: [],
    },
    streamFn: deps.streamFn,
    sessionId: deps.sessionId,
    onPayload: createPromptCacheAffinityHook(cacheKey),
    toolExecution: 'sequential',
    beforeToolCall: async (context) => {
      trace.before(context.toolCall.id, safeArgsChars(context.args));
      return policyHook(context);
    },
    afterToolCall: async (context) => {
      const resultText = (context.result?.content ?? [])
        .map((part) => part.type === 'text' ? part.text : '')
        .join('');
      trace.after(context, resultText.length);
      return auditHook(context);
    },
    // Runs after each turn, before the next provider request. Once the run is
    // in the finalize-only phase the model sees the terminal tool alone; a call
    // to any other tool is answered by Pi as "not found" and never executes.
    // The directive is sent exactly once, and only while a turn remains for it.
    prepareNextTurnWithContext: ({ message, context }) => {
      if (finalizeState.accepted || finalizeState.correctionExhausted) return undefined;
      const idle = !message.content.some((part) => part.type === 'toolCall');
      if (!phase.finalizeOnly && (budget.turns >= finalizeOnlyFromTurn || idle)) {
        phase.finalizeOnly = true;
      }
      if (!phase.finalizeOnly) return undefined;
      if (!phase.directiveSent && budget.turns < limits.maxTurns) {
        phase.directiveSent = true;
        agent.steer({
          role: 'user',
          content: [{ type: 'text', text: finalizationDirective(terminalName) }],
          timestamp: Date.now(),
        });
      }
      return { context: { ...context, tools: finalizeOnlyTools } };
    },
    shouldStopAfterTurn: () => {
      if (finalizeState.accepted) return true;
      if (finalizeState.correctionExhausted) {
        if (budget.endReason === null) budget.endReason = 'validation_rejected';
        return true;
      }
      if (budget.turns >= limits.maxTurns) {
        if (budget.endReason === null) budget.endReason = 'budget_exceeded';
        return true;
      }
      return false;
    },
  });

  const unsubscribe = agent.subscribe((event) => {
    trace.event(event);
    if (event.type === 'turn_end') {
      budget.turns += 1;
      const msg = event.message as {
        role?: string;
        usage?: Usage;
        stopReason?: string;
        errorMessage?: string;
      };
      if (msg && msg.role === 'assistant') {
        const u = msg.usage;
        if (u) budget.usage.add(u);
        if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
          budget.streamError = msg.errorMessage || msg.stopReason || 'stream error';
        }
      }
    }
  });

  const timer = setTimeout(() => {
    budget.timedOut = true;
    if (budget.endReason === null) budget.endReason = 'aborted';
    agent.abort();
  }, limits.wallClockMs);

  try {
    await agent.prompt(deps.promptText);
    await agent.waitForIdle();
  } catch (err) {
    budget.streamError = err instanceof Error ? err.message : String(err);
    if (budget.endReason === null) budget.endReason = 'error';
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }

  const usage = budget.usage.finalize();
  const positiveTokenUsage = usage.inputTokens + usage.outputTokens > 0;
  const pricingAnomaly = positiveTokenUsage
    && usage.costUsd === 0
    && (deps.requireKnownPricing === true || hasBillablePricing(deps.model));
  if (pricingAnomaly) {
    budget.streamError = 'model pricing unavailable for positive token usage';
  }

  // A pricing anomaly overrides finalization: otherwise an accepted proposal
  // could escape while its usage silently bypasses the persisted daily budget.
  let endReason: AgentRunOutcome;
  if (pricingAnomaly) endReason = 'error';
  else if (finalizeState.accepted) endReason = 'finalized';
  else if (budget.endReason !== null) endReason = budget.endReason;
  else if (budget.streamError) endReason = 'error';
  else endReason = 'no_finalization';

  const finalized = endReason === 'finalized';
  const status: AgentRunStatus = finalized ? 'completed' : 'failed';
  const failureReason = finalized
    ? null
    : failureMessageFor(endReason as Exclude<AgentRunOutcome, 'finalized'>, limits, budget.streamError);

  const provenance = retrieval.provenance();
  const traceResult = trace.result(provenance);
  const observedEnd = traceClock();
  const result: AgentRunResult = {
    runId,
    status,
    outcome: endReason,
    failureReason,
    turns: budget.turns,
    modelTurns: traceResult.modelTurns,
    toolCalls: traceResult.toolCalls,
    usage,
    provenance,
    finalProposal: finalized ? finalizeState.accepted : null,
    startedAtMs: deps.now,
    endedAtMs: Math.max(deps.now, Number.isFinite(observedEnd) ? Math.floor(observedEnd) : deps.now),
  };

  persistRunResult(deps.db, runId, result);
  return result;
}
