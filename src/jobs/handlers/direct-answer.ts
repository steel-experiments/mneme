import type { Api, Model, ThinkingLevel } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { transaction, type DatabaseSync } from '../../db/database.js';
import { getMessage, type MessageRow } from '../../db/repositories/messages.js';
import {
  getChannel,
  resolveCurrentChannelScope,
  resolveRetrievableChannelScope,
  sourceLinkChannelLabel,
  type VisibilityClass,
} from '../../db/repositories/channels.js';
import {
  type RetrievalGrant,
} from '../../db/repositories/message-search.js';
import {
  getLatestProposalCardInChannel,
  getProposalByReviewMessageId,
  proposalShortId,
} from '../../db/repositories/proposals.js';
import { getScheduledProposalSubjects } from '../../memory/scheduled-notifications.js';
import {
  getMessageContext,
  type CompactMessage,
} from '../../db/repositories/message-context.js';
import {
  archiveSourceLink,
  isArchiveCitationId,
  MAX_SOURCE_LINKS,
  renderInlineCitations,
  sanitizeOutboundMessage,
  type MessageLink,
  type SourceLinkContext,
} from '../../outbound/message-safety.js';
import {
  evaluateProvenanceGate,
  resolveProvenanceScopes,
  validateOutboundEvidence,
  type OutboundEvidenceLookups,
  type TargetScope,
} from '../../agent/policy.js';
import type { CooldownDecision } from '../../agent/cooldowns.js';
import type { DuplicateResult } from '../../agent/duplicate-policy.js';
import type { PromptCompiler } from '../../agent/prompts.js';
import type { DocsIndex } from '../../agent/docs-index.js';
import {
  executeAgentRun,
  DEFAULT_RUN_LIMITS,
  type AgentRunOutcome,
  type AgentRunResult,
  type AgentRunUsage,
  type ExecuteAgentRunDeps,
  type RunLimits,
} from '../../agent/runtime.js';
import { enqueueOutbox } from '../../outbox/repository.js';
import {
  completeDirectAnswerRequest,
  DIRECT_ANSWER_DEADLINE_MS,
  ensureDirectAnswerRequest,
  getDirectAnswerRequest,
  type DirectAnswerCoverage,
  type DirectAnswerReasonCategory,
  type DirectAnswerRequestRow,
} from '../../db/repositories/direct-answers.js';
import type { Logger } from '../../logger.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';
import { DeferJobError, TransientJobError } from '../errors.js';
import { computeRetryDelay } from '../queue.js';
import { isMnemeTestSurface } from '../../ingestion/test-channels.js';
import { ModelAdmissionTimeoutError } from '../../agent/model-admission.js';
import { getMemory } from '../../memory/repository.js';
import { recomputeMemoryScopes } from '../../memory/search.js';
import { getRecentActivitySnapshot } from '../../db/repositories/recent-activity-snapshot.js';
import {
  fingerprintExposedMemory,
  fingerprintExposedMessage,
} from '../../agent/run-context.js';
import { messageLink } from '../../platform/links.js';
import { getArchiveMessage, type ArchiveReader } from '../../platform-archive/read.js';
import type { PlatformFormat } from '../../platform/types.js';

/**
 * `direct_answer` job handler (Sections 19, 26, 46.3).
 *
 * When a user explicitly addresses Mneme, one queued `direct_answer` job
 * becomes one bounded agent run that answers in the **same channel** it was asked
 * in. The handler pins that channel as both the retrieval scope and the only
 * legal target, renders the direct-answer prompt with a bounded preceding
 * conversation and the structured question, and executes exactly one
 * {@link executeAgentRun} outside any transaction. The run can only ever see
 * content permitted by the pinned channel's grant (the grant is the ceiling),
 * so a public question about private-channel content cannot be answered from
 * that content — and the host re-validates the proposal before any send.
 *
 * After a finalized run, every outbound check runs against current state before
 * the outbox enqueue: the target must equal the pinned channel, the message must
 * be free of mentions and within length, every cited source must exist and be
 * visible in the target scope, the reply anchor must be valid, and the channel's
 * cooldown / a near-duplicate must not suppress it. A direct answer never creates
 * a proposal row — it is an immediate reply, not a routed intervention. Primary
 * and fallback delivery share one source-question response intent, so retries or
 * a crash cannot create two outbox rows for the same addressed message.
 *
 * A question about Mneme herself is answered from the documentation shipped
 * with the image: the run receives `list_docs` and `read_doc` (Section 22.7). The
 * documentation carries no channel visibility, and it is private — the answer
 * quotes or summarizes it inline and never contains a documentation link.
 *
 * Admin-action requests (change policy, delete data, sync, disclose restricted
 * content) are handled by prompt instruction, not here: the handler never acts on
 * them through chat. Silence is a valid outcome when validation suppresses.
 */

/** Discord's hard cap on message length; assembly is rejected if it exceeds this. */
const DISCORD_MESSAGE_MAX = 2000;

/** Worst jitter is 999ms; retain enough time for a short second synthesis. */
const DIRECT_ANSWER_RETRY_COMPLETION_RESERVE_MS = 15_000;
const JOB_RETRY_MAX_JITTER_MS = 999;

/** Fixed, fact-free response used only after the live fallback gate succeeds. */
export const DIRECT_ANSWER_FALLBACK_MESSAGE =
  'I couldn\u2019t complete that request reliably. Please try again in a moment.';

/** Small automatic conversation window supplied before the model chooses tools. */
export const DIRECT_ANSWER_PRECEDING_MESSAGE_LIMIT = 10;

/** One untrusted Discord message rendered into the direct-answer task prompt. */
export interface DirectAnswerPromptMessage {
  messageId: string;
  channelId: string;
  authorId: string | null;
  authorDisplayName: string;
  content: string;
  createdAtMs: number;
  createdAtIso: string;
  replyToMessageId: string | null;
  link: string;
}

/** Bounded initial payload plus its exact message provenance. */
export interface DirectAnswerPromptContext {
  question: DirectAnswerPromptMessage;
  precedingConversation: DirectAnswerPromptMessage[];
  provenanceMessages: Array<{ messageId: string; channelId: string; fingerprint: string }>;
}

/**
 * Host-resolved proposal behind the review card a secure-review question refers
 * to (Section 26). Review cards are embeds with empty message content, so the
 * model cannot recover them from conversation or search; the host resolves the
 * card durably instead. Metadata fields are host-owned; `message` is the
 * model-proposed text and stays untrusted data.
 */
export interface ReferencedProposalContext {
  proposalId: string;
  shortId: string;
  status: string;
  targetChannelId: string;
  targetChannelLabel: string;
  reason: string;
  reviewReason: string | null;
  message: string | null;
  evidenceMessageIds: string[];
  subjectMemoryIds: string[];
  createdAtIso: string;
  expiresAtIso: string | null;
  reviewedAtIso: string | null;
  dismissalReason: string | null;
}

/**
 * Resolve the proposal a secure-review question is about: the exact card it
 * replies to when it is a reply, otherwise the newest card posted in the
 * channel before the question. Returns null outside the secure review channel
 * and when no card exists — visibility fails closed by construction because
 * cards are only ever posted to the secure review channel.
 */
export function resolveReferencedProposal(
  db: DatabaseSync,
  question: MessageRow,
  isSecureReview: boolean,
): ReferencedProposalContext | null {
  if (!isSecureReview) return null;
  const proposal = (question.reply_to_message_id
    ? getProposalByReviewMessageId(db, question.reply_to_message_id)
    : undefined)
    ?? getLatestProposalCardInChannel(db, question.channel_id, question.created_at_ms);
  if (!proposal) return null;
  const targetChannel = getChannel(db, proposal.targetChannelId);
  return {
    proposalId: proposal.id,
    shortId: proposalShortId(proposal.id),
    status: proposal.status,
    targetChannelId: proposal.targetChannelId,
    targetChannelLabel: targetChannel?.name ? `#${targetChannel.name}` : proposal.targetChannelId,
    reason: proposal.reason,
    reviewReason: proposal.reviewReason,
    message: proposal.message,
    evidenceMessageIds: proposal.evidenceMessageIds,
    subjectMemoryIds: getScheduledProposalSubjects(db, proposal.id)
      .map((subject) => subject.memoryId),
    createdAtIso: new Date(proposal.createdAtMs).toISOString(),
    expiresAtIso: proposal.expiresAtMs === null ? null : new Date(proposal.expiresAtMs).toISOString(),
    reviewedAtIso: proposal.reviewedAtMs === null ? null : new Date(proposal.reviewedAtMs).toISOString(),
    dismissalReason: proposal.dismissalReason,
  };
}

function promptMessage(message: CompactMessage): DirectAnswerPromptMessage {
  return {
    ...message,
    createdAtIso: new Date(message.createdAtMs).toISOString(),
  };
}

function promptQuestion(question: MessageRow): DirectAnswerPromptMessage {
  return {
    messageId: question.id,
    channelId: question.channel_id,
    authorId: question.author_id,
    authorDisplayName: question.author_display_name,
    content: question.content,
    createdAtMs: question.created_at_ms,
    createdAtIso: new Date(question.created_at_ms).toISOString(),
    replyToMessageId: question.reply_to_message_id,
    link: messageLink(question.workspace_id, question.channel_id, question.id),
  };
}

/**
 * Build the initial, scope-checked conversational context for a direct answer.
 *
 * The current question is host-known because it is the queued job anchor. The
 * preceding payload is deliberately small: the ten immediately preceding
 * permitted messages from the same channel, plus the exact replied-to parent
 * when it is permitted and falls outside that window. Future messages and
 * sibling replies are never included. Every embedded row is returned as exact
 * provenance for the agent runtime.
 */
export function buildDirectAnswerPromptContext(
  db: DatabaseSync,
  grant: RetrievalGrant,
  question: MessageRow,
): DirectAnswerPromptContext {
  // A test console is an answer surface, never a conversational evidence
  // source. Keep this empty even if stale policy accidentally marks the
  // concrete channel (or a thread below it) ingestion-enabled.
  const retrieved = isMnemeTestSurface(db, question.channel_id)
    ? { anchor: null, before: [], after: [], replies: [] }
    : getMessageContext(db, grant, {
        messageId: question.id,
        beforeCount: DIRECT_ANSWER_PRECEDING_MESSAGE_LIMIT,
        afterCount: 0,
        includeReplies: question.reply_to_message_id !== null,
      });

  const preceding = [...retrieved.before];
  const replyParent = question.reply_to_message_id
    ? retrieved.replies.find((message) =>
        message.messageId === question.reply_to_message_id
        && message.channelId === question.channel_id
        && (message.createdAtMs < question.created_at_ms
          || (message.createdAtMs === question.created_at_ms && message.messageId < question.id)))
    : undefined;
  if (replyParent && !preceding.some((message) => message.messageId === replyParent.messageId)) {
    preceding.push(replyParent);
  }
  preceding.sort((a, b) => a.createdAtMs - b.createdAtMs || a.messageId.localeCompare(b.messageId));

  const precedingConversation = preceding.map(promptMessage);
  const structuredQuestion = promptQuestion(question);
  const provenanceMessages = [...precedingConversation, structuredQuestion].map((message) => {
    const fingerprint = fingerprintExposedMessage(db, message.messageId);
    if (!fingerprint) {
      throw new Error('DIRECT_ANSWER_INITIAL_PROVENANCE_UNAVAILABLE');
    }
    return {
      messageId: message.messageId,
      channelId: message.channelId,
      fingerprint,
    };
  });
  return {
    question: structuredQuestion,
    precedingConversation,
    provenanceMessages,
  };
}

/** The schema-valid direct-answer proposal (Section 19). */
export interface DirectAnswerProposal {
  targetChannelId: string;
  message: string;
  citedMessageIds: string[];
  replyToMessageId?: string;
}

/** Agent runtime inputs; required unless `executeRun` overrides the run. */
export interface AgentRuntimeInputs {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  streamFn: StreamFn;
  providerId: string;
  modelId: string;
}

/** Per-channel retrieval scope + target metadata resolved by the host. */
export interface DirectAnswerChannelScope {
  grant: RetrievalGrant;
  target: TargetScope;
}

/** Rate/duplicate state for the candidate, gathered by the caller. */
export interface DirectAnswerRateChecks {
  cooldown: CooldownDecision;
  duplicate: DuplicateResult;
}

export interface DirectAnswerHandlerDeps {
  db: DatabaseSync;
  guildId: string;
  /** The active platform's text conventions (Section 24.5). */
  format: PlatformFormat;
  promptCompiler: PromptCompiler | (() => PromptCompiler);
  channelPolicyYml?: string | (() => string);
  mnemeYml?: string;
  /** Rendered system prompt, or a renderer using this run's complete context. */
  systemPrompt: string | ((context: Record<string, unknown>) => string);
  /** Resolve the retrieval grant and target scope for the question's channel. */
  resolveChannelScope: (channelId: string) => DirectAnswerChannelScope;
  /** Current cooldown + duplicate state for a candidate send. */
  rateChecks: (channelId: string, content: string, now: number) => DirectAnswerRateChecks;
  /** Deployment mode label rendered into the prompt. */
  mode: string | (() => string);
  /** Agent runtime inputs; required unless `executeRun` overrides the run. */
  agent?: AgentRuntimeInputs;
  /** Mneme's own documentation, exposed to the run through `list_docs` / `read_doc`. */
  docs?: DocsIndex;
  /** Override the agent-run executor (tests). Defaults to {@link executeAgentRun}. */
  executeRun?: (deps: ExecuteAgentRunDeps) => Promise<AgentRunResult>;
  now?: () => number;
  limits?: Partial<RunLimits>;
  logger?: Pick<Logger, 'info' | 'warn'>;
  /** The read-only platform archive; direct answers may cite its servable rows (plan 011). */
  archive?: ArchiveReader;
}

export type DirectAnswerOutcomeKind =
  | 'answered'
  | 'partial'
  | 'fallback'
  | 'suppressed';

export interface DirectAnswerOutcome {
  kind: DirectAnswerOutcomeKind;
  messageId: string;
  channelId: string;
  runId?: string;
  /** Redacted reasons for tests/diagnostics; never rendered to Discord. */
  reasons?: string[];
  reasonCategory?: DirectAnswerReasonCategory;
  outboxId?: string;
  coverage?: DirectAnswerCoverage;
  usage?: AgentRunUsage;
}

/**
 * Build a `direct_answer` handler. `runDirectAnswer(messageId, channelId)`
 * exposes the work for callers/tests; the JobHandler wrapper invokes it.
 */
export function createDirectAnswerHandler(
  deps: DirectAnswerHandlerDeps,
): JobHandler<'direct_answer'> & {
  runDirectAnswer(
    messageId: string,
    channelId: string,
    job?: JobRow,
  ): Promise<DirectAnswerOutcome>;
} {
  if (!deps.agent && !deps.executeRun) {
    throw new Error('createDirectAnswerHandler: either `agent` or `executeRun` must be provided');
  }
  const executeRun = deps.executeRun ?? executeAgentRun;
  const clock = deps.now ?? Date.now;

  const runDirectAnswerCore = async (
    messageId: string,
    channelId: string,
    job?: JobRow,
  ): Promise<DirectAnswerOutcome> => {
    const now = clock();
    const db = deps.db;
    const pinnedChannelId = channelId;
    const initialQuestion = getMessage(db, messageId);
    const questionCreatedAtMs = initialQuestion?.created_at_ms ?? job?.created_at_ms ?? now;
    let request = ensureDirectAnswerRequest(db, {
      sourceMessageId: messageId,
      jobId: job?.id,
      guildId: deps.guildId,
      targetChannelId: pinnedChannelId,
      questionCreatedAtMs,
      deadlineAtMs: questionCreatedAtMs + DIRECT_ANSWER_DEADLINE_MS,
      now,
    });

    // A crash after the atomic outbox/request commit but before job completion
    // returns here. Never run the model or enqueue another response.
    if (request.outcomeKind !== 'pending') {
      return outcomeFromRequest(request, messageId, channelId);
    }
    if (request.targetChannelId !== pinnedChannelId || request.guildId !== deps.guildId) {
      request = suppressRequest(db, request, 'target_invalid', now);
      return outcomeFromRequest(request, messageId, channelId);
    }

    const fallback = (
      reasonCategory: DirectAnswerReasonCategory,
      runId?: string,
      usage?: AgentRunUsage,
      coverage?: DirectAnswerCoverage,
    ): DirectAnswerOutcome => deliverSafeFallback(deps, {
      request,
      messageId,
      pinnedChannelId,
      reasonCategory,
      runId,
      usage,
      coverage,
      now: clock(),
    });

    // Mneme-named test consoles deliberately store an explicit mention even
    // when ordinary ingestion is disabled. Remember that narrow exception at
    // run start so the exact initial question can remain a reply anchor without
    // making any other row in the channel a retrievable/citable source.
    const targetChannelAtStart = getChannel(db, pinnedChannelId);
    const allowTestConsoleQuestion = Boolean(
      targetChannelAtStart
      && targetChannelAtStart.deleted_at_ms === null
      && isMnemeTestSurface(db, pinnedChannelId)
      && resolveCurrentChannelScope(db, pinnedChannelId)?.visibility !== 'excluded'
    );

    const question = initialQuestion;
    if (!question) {
      request = suppressRequest(db, request, 'missing_source', now);
      return outcomeFromRequest(request, messageId, channelId);
    }
    if (question.deleted_at_ms !== null) {
      request = suppressRequest(db, request, 'question_deleted', now);
      return outcomeFromRequest(request, messageId, channelId);
    }
    if (question.channel_id !== pinnedChannelId || question.workspace_id !== deps.guildId) {
      request = suppressRequest(db, request, 'target_invalid', now);
      return outcomeFromRequest(request, messageId, channelId);
    }
    if (now >= request.deadlineAtMs) {
      return fallback('deadline_exceeded');
    }

    let scope: DirectAnswerChannelScope;
    try {
      scope = deps.resolveChannelScope(pinnedChannelId);
    } catch {
      request = suppressRequest(db, request, 'policy_disabled', now);
      return outcomeFromRequest(request, messageId, channelId);
    }
    const initial = buildDirectAnswerPromptContext(db, scope.grant, question);
    const context = {
      question: initial.question,
      precedingConversation: initial.precedingConversation,
      // Non-null only for questions asked in the secure review channel, where
      // every proposal card is visible to the asker by construction.
      referencedProposal: resolveReferencedProposal(db, question, scope.target.isSecureReview),
      runtime: { mode: typeof deps.mode === 'function' ? deps.mode() : deps.mode, nowIso: new Date(now).toISOString() },
      target: { label: pinnedChannelId, visibility: scope.target.visibility },
    };
    const compiler = typeof deps.promptCompiler === 'function' ? deps.promptCompiler() : deps.promptCompiler;
    const promptText = compiler.render('direct-answer', context);
    const promptVersion = compiler.versionFor('direct-answer', {
      mnemeYml: deps.mnemeYml,
      channelPolicyYml: typeof deps.channelPolicyYml === 'function' ? deps.channelPolicyYml() : deps.channelPolicyYml,
    });

    // Execute outside any transaction; executeAgentRun persists its own run row.
    const a = deps.agent;
    const runDeps: ExecuteAgentRunDeps = {
      db,
      grant: scope.grant,
      systemPrompt: typeof deps.systemPrompt === 'function' ? deps.systemPrompt(context) : deps.systemPrompt,
      model: a?.model ?? (undefined as unknown as ExecuteAgentRunDeps['model']),
      thinkingLevel: a?.thinkingLevel ?? 'minimal',
      streamFn: a?.streamFn ?? (undefined as unknown as ExecuteAgentRunDeps['streamFn']),
      sessionId: `mneme:direct:${pinnedChannelId}:${messageId}`,
      cacheProfile: 'direct',
      promptText,
      promptVersion,
      runType: 'direct_answer',
      guildId: deps.guildId,
      episodeId: null,
      requestCreatedAtMs: request.questionCreatedAtMs,
      requestDeadlineAtMs: request.deadlineAtMs,
      pinnedTargetChannelId: pinnedChannelId,
      initialProvenanceChannelIds: [pinnedChannelId],
      initialProvenanceMessages: initial.provenanceMessages,
      docs: deps.docs,
      providerId: a?.providerId ?? '',
      modelId: a?.modelId ?? '',
      now,
      limits: {
        ...deps.limits,
        wallClockMs: Math.max(
          1,
          Math.min(
            deps.limits?.wallClockMs ?? DEFAULT_RUN_LIMITS.wallClockMs,
            request.deadlineAtMs - now,
          ),
        ),
      },
    };

    let result: AgentRunResult;
    try {
      result = await executeRun(runDeps);
    } catch (err) {
      const failureNow = clock();
      if (err instanceof ModelAdmissionTimeoutError) {
        return fallback('admission_timeout');
      }
      if (err instanceof DeferJobError) {
        const retryAt = failureNow + Math.max(0, err.retryAfterMs);
        if (job && retryAt < request.deadlineAtMs) throw err;
        return fallback('deadline_exceeded');
      }
      if (err instanceof TransientJobError) {
        // One short queue retry is permitted when it can still finish inside
        // the immutable response deadline. The second claim resolves visibly.
        const latestRetryStart = job
          ? failureNow + computeRetryDelay(job.attempts, JOB_RETRY_MAX_JITTER_MS)
          : Number.POSITIVE_INFINITY;
        if (
          job
          && job.attempts < 2
          && latestRetryStart + DIRECT_ANSWER_RETRY_COMPLETION_RESERVE_MS < request.deadlineAtMs
        ) throw err;
        return fallback('model_error');
      }
      deps.logger?.warn(
        { messageId, channelId, reasonCategory: 'model_error' },
        'direct_answer: run executor failed; resolving with safe fallback',
      );
      return fallback('model_error');
    }

    const parsedSnapshotCoverage = readRecentActivityCoverage(
      result.provenance,
      request.questionCreatedAtMs,
    );
    const snapshotWasProvided = Object.prototype.hasOwnProperty.call(
      result.provenance,
      'recentActivitySnapshot',
    );
    const snapshotCoverage = parsedSnapshotCoverage
      ? refreshRecentActivityCoverage(db, scope.grant, parsedSnapshotCoverage)
      : null;
    if (snapshotWasProvided && !snapshotCoverage) {
      return fallback('malformed', result.runId, result.usage);
    }
    if (clock() >= request.deadlineAtMs) {
      return fallback('deadline_exceeded', result.runId, result.usage, snapshotCoverage?.persisted);
    }
    if (result.outcome !== 'finalized' || !result.finalProposal) {
      const reasonCategory = reasonForRunOutcome(result.outcome);
      deps.logger?.info(
        { messageId, runId: result.runId, reasonCategory },
        'direct_answer: run did not finalize; resolving with safe fallback',
      );
      return fallback(reasonCategory, result.runId, result.usage, snapshotCoverage?.persisted);
    }

    const proposal = readDirectAnswerProposal(result.finalProposal);
    if (!proposal) {
      return fallback('malformed', result.runId, result.usage, snapshotCoverage?.persisted);
    }

    // Re-validate the proposal against current state before any enqueue.
    const replyToMessageId = proposal.replyToMessageId ?? messageId;
    const validation = validateDirectAnswer(db, {
      proposal,
      pinnedChannelId,
      target: scope.target,
      guildId: deps.guildId,
      format: deps.format,
      replyToMessageId,
      rateChecks: deps.rateChecks(pinnedChannelId, proposal.message, clock()),
      provenance: result.provenance,
      snapshotCoverage,
      initialMessageIds: initial.provenanceMessages.map((message) => message.messageId),
      questionMessageId: messageId,
      runStartedAtMs: result.startedAtMs,
      allowTestConsoleQuestion,
      ...(deps.archive ? { archive: deps.archive } : {}),
    });

    if (!validation.allow) {
      deps.logger?.info(
        { messageId, runId: result.runId, reasons: validation.reasons },
        'direct_answer: proposal suppressed by outbound validation',
      );
      if (validation.intentionalSuppression) {
        request = suppressRequest(
          db,
          request,
          validation.intentionalSuppression,
          clock(),
          result.runId,
          snapshotCoverage?.persisted,
        );
        return {
          ...outcomeFromRequest(request, messageId, channelId),
          runId: result.runId,
          reasons: validation.reasons,
          usage: result.usage,
        };
      }
      return fallback(
        'validation_rejection',
        result.runId,
        result.usage,
        snapshotCoverage?.persisted,
      );
    }

    const responseKind = snapshotCoverage && !snapshotCoverage.persisted.complete
      ? 'partial' as const
      : 'primary' as const;
    const enqueueNow = clock();
    if (enqueueNow >= request.deadlineAtMs) {
      return fallback('deadline_exceeded', result.runId, result.usage, snapshotCoverage?.persisted);
    }
    const outbox = transaction(db, () => {
      const enqueued = enqueueOutbox(db, {
        runId: result.runId,
        responseIntentKey: request.responseIntentKey,
        channelId: pinnedChannelId,
        content: validation.content!,
        replyToMessageId: validation.replyToMessageId,
        now: enqueueNow,
      });
      request = completeDirectAnswerRequest(db, {
        sourceMessageId: messageId,
        outcomeKind: responseKind,
        reasonCategory: 'none',
        runId: result.runId,
        outboxId: enqueued.outboxId,
        coverage: snapshotCoverage?.persisted,
        now: enqueueNow,
      });
      return enqueued;
    });

    deps.logger?.info(
      { messageId, runId: result.runId, outboxId: outbox.outboxId, outcomeKind: responseKind },
      'direct_answer: enqueued reply',
    );
    return {
      kind: responseKind === 'partial' ? 'partial' : 'answered',
      messageId,
      channelId,
      runId: result.runId,
      outboxId: outbox.outboxId,
      coverage: snapshotCoverage?.persisted,
      usage: result.usage,
    };
  };

  const runDirectAnswer = async (
    messageId: string,
    channelId: string,
    job?: JobRow,
  ): Promise<DirectAnswerOutcome> => {
    try {
      return await runDirectAnswerCore(messageId, channelId, job);
    } catch (err) {
      // Explicit retry signals retain their worker semantics. Every other host-
      // side failure (prompt preparation, validation plumbing, or the primary
      // atomic enqueue) gets one last fact-free delivery attempt. If that
      // fallback also cannot be persisted, let the error escape: the job must
      // fail visibly and the durable request remains pending for operations.
      if (err instanceof DeferJobError || err instanceof TransientJobError) throw err;
      const request = getDirectAnswerRequest(deps.db, messageId);
      if (!request) throw err;
      if (request.outcomeKind !== 'pending') {
        return outcomeFromRequest(request, messageId, channelId);
      }
      deps.logger?.warn(
        { messageId, channelId, reasonCategory: 'model_error' },
        'direct_answer: host processing failed; resolving with safe fallback',
      );
      return deliverSafeFallback(deps, {
        request,
        messageId,
        pinnedChannelId: channelId,
        reasonCategory: 'model_error',
        now: clock(),
      });
    }
  };

  const handler = async (
    payload: { messageId: string; channelId: string },
    job: JobRow,
  ): Promise<void> => {
    await runDirectAnswer(payload.messageId, payload.channelId, job);
  };

  return Object.assign(handler, { runDirectAnswer });
}

interface RecentActivityCoverage {
  persisted: DirectAnswerCoverage;
  exposedMessageIds: ReadonlySet<string>;
  matchedChannelIds: readonly string[];
  requestedChannelIds: readonly string[] | null;
  omitted: number;
}

function refreshRecentActivityCoverage(
  db: DatabaseSync,
  grant: RetrievalGrant,
  coverage: RecentActivityCoverage,
): RecentActivityCoverage | null {
  const current = getRecentActivitySnapshot(db, grant, {
    afterMs: coverage.persisted.fromAtMs!,
    beforeMs: coverage.persisted.toAtMs!,
    channelIds: coverage.requestedChannelIds ?? undefined,
  });
  const included = coverage.persisted.includedMessages ?? 0;
  const includedChannels = coverage.persisted.includedChannels ?? 0;
  if (
    (current.totalMatching > 0 && included === 0)
    || current.totalMatching < included
    || current.matchingChannelCount < includedChannels
    || [...coverage.exposedMessageIds].some((id) => {
      const message = getMessage(db, id);
      return !message
        || message.created_at_ms < coverage.persisted.fromAtMs!
        || message.created_at_ms >= coverage.persisted.toAtMs!
        || !current.matchedChannelIds.includes(message.channel_id);
    })
  ) return null;
  const omitted = current.totalMatching - included;
  const complete = omitted === 0;
  const messageCapApplied = current.messageCapApplied;
  const characterCapApplied = included < current.messages.length;
  const truncationReason = complete
    ? 'none' as const
    : messageCapApplied && characterCapApplied
      ? 'message_and_character_cap' as const
      : messageCapApplied
        ? 'message_cap' as const
        : 'character_cap' as const;
  return {
    ...coverage,
    persisted: {
      ...coverage.persisted,
      complete,
      omitted,
      truncationReason,
      matchedMessages: current.totalMatching,
      matchedChannels: current.matchingChannelCount,
      oldestMatchedAtMs: current.oldestMatchedAtMs,
      newestMatchedAtMs: current.newestMatchedAtMs,
    },
    matchedChannelIds: current.matchedChannelIds,
    omitted,
  };
}

function readRecentActivityCoverage(
  provenance: AgentRunResult['provenance'],
  requestCreatedAtMs: number,
): RecentActivityCoverage | null {
  const raw = (provenance as AgentRunResult['provenance'] & {
    recentActivitySnapshot?: {
      afterMs: number;
      beforeMs: number;
      requestedChannelIds: string[] | null;
      totalMatching: number;
      included: number;
      matchingChannelCount: number;
      includedChannelCount: number;
      oldestMatchedAtMs: number | null;
      newestMatchedAtMs: number | null;
      oldestIncludedAtMs: number | null;
      newestIncludedAtMs: number | null;
      complete: boolean;
      omitted: number;
      truncationReason: 'none' | 'message_cap' | 'character_cap' | 'message_and_character_cap';
      exposedMessageIds: string[];
      matchedChannelIds: string[];
    };
  }).recentActivitySnapshot;
  if (!raw) return null;
  const nonNegativeInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (
    !nonNegativeInteger(raw.afterMs)
    || !nonNegativeInteger(raw.beforeMs)
    || !(raw.requestedChannelIds === null || (
      Array.isArray(raw.requestedChannelIds)
      && raw.requestedChannelIds.length > 0
      && raw.requestedChannelIds.every((id) => typeof id === 'string' && id.length > 0)
      && new Set(raw.requestedChannelIds).size === raw.requestedChannelIds.length
    ))
    || !nonNegativeInteger(raw.totalMatching)
    || !nonNegativeInteger(raw.included)
    || !nonNegativeInteger(raw.matchingChannelCount)
    || !nonNegativeInteger(raw.includedChannelCount)
    || !nonNegativeInteger(raw.omitted)
    || !nullableNonNegativeInteger(raw.oldestMatchedAtMs)
    || !nullableNonNegativeInteger(raw.newestMatchedAtMs)
    || !nullableNonNegativeInteger(raw.oldestIncludedAtMs)
    || !nullableNonNegativeInteger(raw.newestIncludedAtMs)
    || typeof raw.complete !== 'boolean'
    || !['none', 'message_cap', 'character_cap', 'message_and_character_cap']
      .includes(raw.truncationReason)
    || !Array.isArray(raw.exposedMessageIds)
    || raw.exposedMessageIds.some((id) => typeof id !== 'string' || id.length === 0)
    || !Array.isArray(raw.matchedChannelIds)
    || raw.matchedChannelIds.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(raw.matchedChannelIds).size !== raw.matchedChannelIds.length
    || raw.matchedChannelIds.length !== raw.matchingChannelCount
    || new Set(raw.exposedMessageIds).size !== raw.exposedMessageIds.length
    || raw.afterMs >= raw.beforeMs
    || raw.beforeMs > requestCreatedAtMs
    || raw.included > raw.totalMatching
    || raw.omitted !== raw.totalMatching - raw.included
    || raw.includedChannelCount > raw.matchingChannelCount
    || raw.matchingChannelCount > raw.totalMatching
    || raw.includedChannelCount > raw.included
    || (raw.totalMatching === 0) !== (raw.matchingChannelCount === 0)
    || (raw.included === 0) !== (raw.includedChannelCount === 0)
    || raw.exposedMessageIds.length !== raw.included
    || (raw.totalMatching > 0 && raw.included === 0)
    || raw.complete !== (raw.omitted === 0)
    || (raw.complete ? raw.truncationReason !== 'none' : raw.truncationReason === 'none')
    || !coverageTimeRangeIsConsistent(raw)
  ) return null;
  return {
    persisted: {
      complete: raw.complete,
      omitted: raw.omitted,
      truncationReason: raw.truncationReason,
      matchedMessages: raw.totalMatching,
      includedMessages: raw.included,
      matchedChannels: raw.matchingChannelCount,
      includedChannels: raw.includedChannelCount,
      fromAtMs: raw.afterMs,
      toAtMs: raw.beforeMs,
      oldestMatchedAtMs: raw.oldestMatchedAtMs,
      newestMatchedAtMs: raw.newestMatchedAtMs,
      oldestIncludedAtMs: raw.oldestIncludedAtMs,
      newestIncludedAtMs: raw.newestIncludedAtMs,
    },
    exposedMessageIds: new Set(raw.exposedMessageIds),
    matchedChannelIds: raw.matchedChannelIds,
    requestedChannelIds: raw.requestedChannelIds,
    omitted: raw.omitted,
  };
}

function coverageTimeRangeIsConsistent(raw: {
  afterMs: number;
  beforeMs: number;
  totalMatching: number;
  included: number;
  oldestMatchedAtMs: number | null;
  newestMatchedAtMs: number | null;
  oldestIncludedAtMs: number | null;
  newestIncludedAtMs: number | null;
}): boolean {
  const pairValid = (
    count: number,
    oldest: number | null,
    newest: number | null,
  ): boolean => {
    if (count === 0) return oldest === null && newest === null;
    return oldest !== null
      && newest !== null
      && oldest <= newest
      && oldest >= raw.afterMs
      && newest < raw.beforeMs;
  };
  return pairValid(raw.totalMatching, raw.oldestMatchedAtMs, raw.newestMatchedAtMs)
    && pairValid(raw.included, raw.oldestIncludedAtMs, raw.newestIncludedAtMs);
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function reasonForRunOutcome(outcome: AgentRunOutcome): DirectAnswerReasonCategory {
  switch (outcome) {
    case 'budget_exceeded': return 'budget';
    case 'no_finalization': return 'no_finalization';
    case 'aborted': return 'timeout';
    case 'blocked': return 'validation_rejection';
    case 'validation_rejected': return 'validation_rejection';
    case 'error': return 'model_error';
    case 'finalized': return 'no_finalization';
  }
}

function suppressRequest(
  db: DatabaseSync,
  request: DirectAnswerRequestRow,
  reasonCategory: DirectAnswerReasonCategory,
  now: number,
  runId?: string,
  coverage?: DirectAnswerCoverage,
): DirectAnswerRequestRow {
  return completeDirectAnswerRequest(db, {
    sourceMessageId: request.sourceMessageId,
    outcomeKind: 'suppressed',
    reasonCategory,
    runId,
    coverage,
    now,
  });
}

function outcomeFromRequest(
  request: DirectAnswerRequestRow,
  messageId: string,
  channelId: string,
): DirectAnswerOutcome {
  const common = {
    messageId,
    channelId,
    reasonCategory: request.reasonCategory,
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.outboxId ? { outboxId: request.outboxId } : {}),
    ...(request.coverage ? { coverage: request.coverage } : {}),
  };
  switch (request.outcomeKind) {
    case 'primary': return { kind: 'answered', ...common };
    case 'partial': return { kind: 'partial', ...common };
    case 'fallback': return { kind: 'fallback', ...common };
    case 'suppressed': return { kind: 'suppressed', reasons: [request.reasonCategory], ...common };
    case 'pending': throw new Error('pending direct-answer request has no terminal outcome');
  }
}

function deliverSafeFallback(
  deps: DirectAnswerHandlerDeps,
  input: {
    request: DirectAnswerRequestRow;
    messageId: string;
    pinnedChannelId: string;
    reasonCategory: DirectAnswerReasonCategory;
    runId?: string;
    usage?: AgentRunUsage;
    coverage?: DirectAnswerCoverage;
    now: number;
  },
): DirectAnswerOutcome {
  const validation = validateSafeFallback(deps, input);
  if (!validation.allow) {
    const request = suppressRequest(
      deps.db,
      input.request,
      validation.reasonCategory,
      input.now,
      input.runId,
      input.coverage,
    );
    return {
      ...outcomeFromRequest(request, input.messageId, input.pinnedChannelId),
      ...(input.usage ? { usage: input.usage } : {}),
    };
  }

  let request = input.request;
  const outbox = transaction(deps.db, () => {
    const enqueued = enqueueOutbox(deps.db, {
      runId: input.runId,
      responseIntentKey: request.responseIntentKey,
      channelId: input.pinnedChannelId,
      content: validation.content,
      replyToMessageId: input.messageId,
      now: input.now,
    });
    request = completeDirectAnswerRequest(deps.db, {
      sourceMessageId: input.messageId,
      outcomeKind: 'fallback',
      reasonCategory: input.reasonCategory,
      runId: input.runId,
      outboxId: enqueued.outboxId,
      coverage: input.coverage,
      now: input.now,
    });
    return enqueued;
  });

  deps.logger?.info(
    {
      messageId: input.messageId,
      outboxId: outbox.outboxId,
      reasonCategory: input.reasonCategory,
    },
    'direct_answer: enqueued neutral fallback',
  );
  return {
    kind: 'fallback',
    messageId: input.messageId,
    channelId: input.pinnedChannelId,
    reasonCategory: input.reasonCategory,
    ...(input.runId ? { runId: input.runId } : {}),
    outboxId: outbox.outboxId,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

function validateSafeFallback(
  deps: DirectAnswerHandlerDeps,
  input: { messageId: string; pinnedChannelId: string; now: number },
):
  | { allow: true; content: string }
  | { allow: false; reasonCategory: DirectAnswerReasonCategory } {
  const question = getMessage(deps.db, input.messageId);
  if (!question) return { allow: false, reasonCategory: 'missing_source' };
  if (question.deleted_at_ms !== null) return { allow: false, reasonCategory: 'question_deleted' };
  if (
    question.workspace_id !== deps.guildId
    || question.channel_id !== input.pinnedChannelId
  ) return { allow: false, reasonCategory: 'target_invalid' };

  const channel = getChannel(deps.db, input.pinnedChannelId);
  const currentScope = resolveCurrentChannelScope(deps.db, input.pinnedChannelId);
  if (
    !channel
    || channel.workspace_id !== deps.guildId
    || channel.deleted_at_ms !== null
    || !currentScope
  ) return { allow: false, reasonCategory: 'target_invalid' };

  const testConsole = isMnemeTestSurface(deps.db, input.pinnedChannelId)
    && currentScope.visibility !== 'excluded';
  if (!testConsole && !resolveRetrievableChannelScope(deps.db, input.pinnedChannelId)) {
    return { allow: false, reasonCategory: 'policy_disabled' };
  }

  const sanitized = sanitizeOutboundMessage(
    {
      content: DIRECT_ANSWER_FALLBACK_MESSAGE,
      sourceLinkMessageIds: [],
      guildId: deps.guildId,
      format: deps.format,
    },
    { resolveChannelId: () => undefined },
  );
  if (sanitized.outcome !== 'allow' || sanitized.content !== DIRECT_ANSWER_FALLBACK_MESSAGE) {
    return { allow: false, reasonCategory: 'validation_rejection' };
  }

  const rate = deps.rateChecks(input.pinnedChannelId, sanitized.content, input.now);
  if (!rate.cooldown.allowed) return { allow: false, reasonCategory: 'rate_limit' };
  if (rate.duplicate.matched) return { allow: false, reasonCategory: 'duplicate' };
  return { allow: true, content: sanitized.content };
}

/** Read the accepted proposal as a direct-answer payload, or null if mis-shaped. */
export function readDirectAnswerProposal(
  accepted: { kind: string; proposal: unknown },
): DirectAnswerProposal | null {
  if (accepted.kind !== 'direct_answer') return null;
  const p = accepted.proposal as Partial<DirectAnswerProposal>;
  if (
    typeof p.targetChannelId !== 'string' ||
    typeof p.message !== 'string' ||
    !Array.isArray(p.citedMessageIds)
  ) {
    return null;
  }
  return {
    targetChannelId: p.targetChannelId,
    message: p.message,
    citedMessageIds: p.citedMessageIds.filter((id): id is string => typeof id === 'string'),
    replyToMessageId: typeof p.replyToMessageId === 'string' ? p.replyToMessageId : undefined,
  };
}

// ---- Outbound validation ----------------------------------------------------

export interface DirectAnswerValidation {
  allow: boolean;
  reasons: string[];
  intentionalSuppression?: Extract<DirectAnswerReasonCategory, 'duplicate' | 'rate_limit'>;
  content?: string;
  replyToMessageId?: string;
}

/**
 * Run every Section 7.4 / 24.4 outbound check against the proposal before it may
 * become an outbox row: pinned target, mention/length sanitization, cited-source
 * existence and visibility, reply-anchor validity, target-channel state,
 * cooldown, and duplicate. A direct answer cites only messages (never memories),
 * so `referencedMemoryIds` is empty. Definite violations suppress; the proposal
 * is never partially sent.
 */
export function validateDirectAnswer(
  db: DatabaseSync,
  input: {
    proposal: DirectAnswerProposal;
    pinnedChannelId: string;
    target: TargetScope;
    guildId: string;
    /** The active platform's text conventions (Section 24.5). */
    format: PlatformFormat;
    replyToMessageId?: string;
    rateChecks: DirectAnswerRateChecks;
    provenance: AgentRunResult['provenance'];
    snapshotCoverage: RecentActivityCoverage | null;
    /** Exact host-built initial context, never model supplied. */
    initialMessageIds: readonly string[];
    /** Exact host-owned source question; the sole non-retrievable source exception. */
    questionMessageId?: string;
    /** Conservative timestamp defense in addition to exact exposure fingerprints. */
    runStartedAtMs: number;
    /** Narrow exception for the exact question in a Mneme-named reply console. */
    allowTestConsoleQuestion: boolean;
    /**
     * The read-only platform archive. Only a direct answer passes it; without
     * it, an archive citation is rejected (plan 011 step 7).
     */
    archive?: ArchiveReader;
  },
): DirectAnswerValidation {
  const reasons: string[] = [];
  // Live checks see only live citations; archive citations are checked
  // separately against this run's archive exposure and the archive itself.
  const liveCitedIds = input.proposal.citedMessageIds.filter((id) => !isArchiveCitationId(id));
  const archiveCitedIds = [...new Set(input.proposal.citedMessageIds.filter(isArchiveCitationId))];
  const archiveLinks: MessageLink[] = [];
  // The source-link cap counts live and archive citations together. An answer
  // without archive citations keeps the live rule unchanged.
  const totalCited = new Set(liveCitedIds).size + archiveCitedIds.length;
  if (archiveCitedIds.length > 0 && totalCited > MAX_SOURCE_LINKS) {
    reasons.push(`the answer cites ${totalCited} sources; at most ${MAX_SOURCE_LINKS} are allowed`);
  }
  if (archiveCitedIds.length > 0) {
    if (!input.archive) {
      reasons.push('archive citations are not allowed in this message');
    } else {
      // Only archive MESSAGE ids received in this run can be cited.
      const exposedArchiveIds = new Set(input.provenance.archiveMessageIds ?? []);
      for (const id of archiveCitedIds) {
        if (!exposedArchiveIds.has(id)) {
          reasons.push(`cited archive message "${id}" was not exposed to this run`);
          continue;
        }
        const message = getArchiveMessage(input.archive, id);
        if (!message || message.link === null) {
          reasons.push(`cited archive message "${id}" is no longer servable`);
          continue;
        }
        archiveLinks.push(archiveSourceLink({
          archiveId: id,
          channelId: message.channelId,
          channelName: message.channelName,
          createdAtMs: message.createdAtMs,
          url: message.link,
        }));
      }
    }
  }
  const initialMessageIds = new Set(input.initialMessageIds);
  const currentPinnedChannel = getChannel(db, input.pinnedChannelId);
  const mayUseTestConsoleQuestion = Boolean(
    input.allowTestConsoleQuestion
    && currentPinnedChannel
    && currentPinnedChannel.deleted_at_ms === null
    && isMnemeTestSurface(db, input.pinnedChannelId)
  );
  const resolveProvenanceChannel = (
    channelId: string,
    source?: AgentRunResult['provenance']['channels'][number]['source'],
  ) => source === 'initial_payload'
      && channelId === input.pinnedChannelId
      && mayUseTestConsoleQuestion
    ? resolveCurrentChannelScope(db, channelId)
    : resolveRetrievableChannelScope(db, channelId);

  // Checks 1-2: pinned target and every scope actually exposed to the run. A
  // direct answer cannot be diverted to review, so uncertainty suppresses it.
  const provenance = evaluateProvenanceGate({
    pinnedTargetChannelId: input.pinnedChannelId,
    proposedTargetChannelId: input.proposal.targetChannelId,
    target: input.target,
    provenance: resolveProvenanceScopes({ ...input.provenance, memoryScopes: [] }, {
      channelVisibility: (id, source) => resolveProvenanceChannel(id, source)?.visibility,
      channelScopeId: (id, source) => resolveProvenanceChannel(id, source)?.scopeChannelId,
    }),
  });
  if (provenance.outcome !== 'allow') {
    reasons.push(...provenance.reasons);
  }

  // Channel-level provenance is not enough: a particular exposed row may be
  // deleted while its channel remains visible. Re-fetch every model-visible
  // message, compare it with the exact version captured at exposure time, and
  // gate its current concrete scope. Only the exact source question may use the
  // Mneme-console reply exception.
  const messageIds = [...new Set(input.provenance.messageIds ?? [])];
  const messageFingerprints = new Map<string, string>();
  for (const row of input.provenance.messageFingerprints ?? []) {
    if (
      typeof row?.messageId !== 'string'
      || typeof row?.fingerprint !== 'string'
      || messageFingerprints.has(row.messageId)
    ) {
      reasons.push('message exposure fingerprints are malformed');
      continue;
    }
    messageFingerprints.set(row.messageId, row.fingerprint);
  }
  if (
    messageFingerprints.size !== messageIds.length
    || [...messageFingerprints].some(([id]) => !messageIds.includes(id))
  ) {
    reasons.push('message exposure fingerprints are incomplete');
  }
  const currentMessageScopes: Array<{
    kind: 'channel';
    channelId: string;
    visibility: VisibilityClass;
  }> = [];
  for (const id of messageIds) {
    const message = getMessage(db, id);
    if (!message || message.deleted_at_ms !== null || message.workspace_id !== input.guildId) {
      reasons.push(`exposed message "${id}" is no longer available`);
      continue;
    }
    const currentFingerprint = fingerprintExposedMessage(db, id);
    if (!currentFingerprint || messageFingerprints.get(id) !== currentFingerprint) {
      reasons.push(`exposed message "${id}" changed after it was retrieved`);
      continue;
    }
    if (
      !Number.isSafeInteger(input.runStartedAtMs)
      || message.updated_at_ms > input.runStartedAtMs
    ) {
      reasons.push(`exposed message "${id}" changed while the answer was running`);
      continue;
    }
    const isExactTestQuestion = mayUseTestConsoleQuestion
      && id === input.questionMessageId
      && initialMessageIds.has(id)
      && message.channel_id === input.pinnedChannelId;
    const scope = isExactTestQuestion
      ? resolveCurrentChannelScope(db, message.channel_id)
      : resolveRetrievableChannelScope(db, message.channel_id);
    if (!scope || (!isExactTestQuestion && isMnemeTestSurface(db, message.channel_id))) {
      reasons.push(`exposed message "${id}" is no longer retrievable`);
      continue;
    }
    currentMessageScopes.push({
      kind: 'channel',
      channelId: scope.scopeChannelId,
      visibility: scope.visibility,
    });
  }
  if (currentMessageScopes.length > 0) {
    const currentMessagesGate = evaluateProvenanceGate({
      pinnedTargetChannelId: input.pinnedChannelId,
      proposedTargetChannelId: input.pinnedChannelId,
      target: input.target,
      provenance: currentMessageScopes,
    });
    if (currentMessagesGate.outcome !== 'allow') {
      reasons.push('an exposed message scope is no longer permitted in the target');
    }
  }

  // Memory scope is a read-time computation over current evidence. Never trust
  // the scope captured when the tool ran: a reclassification or deletion can
  // tighten it while synthesis is in flight.
  const exposedMemoryIds = [...new Set(input.provenance.memoryIds ?? [])];
  if ((input.provenance.memoryScopes?.length ?? 0) > 0 && exposedMemoryIds.length === 0) {
    reasons.push('memory provenance did not identify its exposed rows');
  }
  const memoryFingerprints = new Map<string, string>();
  for (const row of input.provenance.memoryFingerprints ?? []) {
    if (
      typeof row?.memoryId !== 'string'
      || typeof row?.fingerprint !== 'string'
      || memoryFingerprints.has(row.memoryId)
    ) {
      reasons.push('memory exposure fingerprints are malformed');
      continue;
    }
    memoryFingerprints.set(row.memoryId, row.fingerprint);
  }
  if (
    memoryFingerprints.size !== exposedMemoryIds.length
    || [...memoryFingerprints].some(([id]) => !exposedMemoryIds.includes(id))
  ) {
    reasons.push('memory exposure fingerprints are incomplete');
  }
  const recomputedMemoryScopes = recomputeMemoryScopes(db, exposedMemoryIds);
  const currentMemoryScopeRecords = exposedMemoryIds.flatMap((id) => {
    const memory = getMemory(db, id);
    if (!memory) {
      reasons.push(`exposed memory "${id}" is no longer available`);
      return [];
    }
    const currentFingerprint = fingerprintExposedMemory(db, id);
    if (!currentFingerprint || memoryFingerprints.get(id) !== currentFingerprint) {
      reasons.push(`exposed memory "${id}" changed after it was retrieved`);
      return [];
    }
    if (
      !Number.isSafeInteger(input.runStartedAtMs)
      || memory.updated_at_ms > input.runStartedAtMs
    ) {
      reasons.push(`exposed memory "${id}" changed while the answer was running`);
      return [];
    }
    const scope = recomputedMemoryScopes.get(id);
    if (!scope) {
      reasons.push(`exposed memory "${id}" scope cannot be resolved`);
      return [];
    }
    return [{
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      source: 'memory_search' as const,
    }];
  });
  if (currentMemoryScopeRecords.length > 0) {
    const currentMemoriesGate = evaluateProvenanceGate({
      pinnedTargetChannelId: input.pinnedChannelId,
      proposedTargetChannelId: input.pinnedChannelId,
      target: input.target,
      provenance: resolveProvenanceScopes({
        channels: [],
        messageIds: [],
        messageFingerprints: [],
        memoryScopes: currentMemoryScopeRecords,
        memoryIds: exposedMemoryIds,
        memoryFingerprints: input.provenance.memoryFingerprints ?? [],
        charsExposed: 0,
        charBudget: input.provenance.charBudget,
      }, { channelVisibility: () => undefined }),
    });
    if (currentMemoriesGate.outcome !== 'allow') {
      reasons.push('an exposed memory scope is no longer permitted in the target');
    }
  }

  // A visible, real message is not sufficient: the model may cite only exact
  // rows the host exposed during this run (initial context or a retrieval tool).
  const exposedMessageIds = new Set(input.provenance.messageIds ?? []);
  for (const id of new Set(liveCitedIds)) {
    if (!exposedMessageIds.has(id)) {
      reasons.push(`cited message "${id}" was not exposed to this run`);
    }
  }
  if (
    input.snapshotCoverage
    && input.snapshotCoverage.exposedMessageIds.size > 0
    && !liveCitedIds.some((id) =>
      input.snapshotCoverage?.exposedMessageIds.has(id))
  ) {
    reasons.push('answer did not cite an exposed recent-activity snapshot message');
  }
  if (input.snapshotCoverage && /^\s*coverage\s*:/imu.test(input.proposal.message)) {
    reasons.push('model-authored coverage lines are reserved for the host');
  }
  if (input.snapshotCoverage) {
    const coverageScopes = input.snapshotCoverage.matchedChannelIds.map((channelId) => {
      const scope = isMnemeTestSurface(db, channelId)
        ? undefined
        : resolveRetrievableChannelScope(db, channelId);
      return {
        kind: 'channel' as const,
        channelId: scope?.scopeChannelId ?? channelId,
        visibility: scope?.visibility,
      };
    });
    const coverageGate = evaluateProvenanceGate({
      pinnedTargetChannelId: input.pinnedChannelId,
      proposedTargetChannelId: input.pinnedChannelId,
      target: input.target,
      provenance: coverageScopes,
    });
    if (coverageGate.outcome !== 'allow') {
      reasons.push('recent-activity coverage scope is no longer permitted in the target');
    }
  }

  // Checks 8 (mentions), length, and citation count (Section 24.5).
  const resolveChannelId: SourceLinkContext['resolveChannelId'] = (id) =>
    getMessage(db, id)?.channel_id;
  const resolveLabel: SourceLinkContext['resolveLabel'] = (id) => {
    const message = getMessage(db, id);
    if (!message) return undefined;
    const channelLabel = sourceLinkChannelLabel(db, message.channel_id);
    return `${channelLabel} · ${new Date(message.created_at_ms).toISOString().slice(0, 10)}`;
  };
  const sanitized = sanitizeOutboundMessage(
    {
      content: input.proposal.message,
      sourceLinkMessageIds: liveCitedIds,
      guildId: input.guildId,
      format: input.format,
    },
    { resolveChannelId, resolveLabel },
  );
  if (sanitized.outcome === 'reject') {
    reasons.push(...sanitized.reasons);
  }

  // Checks 3-4 and 7: cited sources exist/are visible and the reply anchor is
  // valid, all against current DB state. `allow_interventions` controls
  // unsolicited speech, so an explicit direct answer does not require it.
  const lookups: OutboundEvidenceLookups = {
    resolveMessage: (id) => {
      const m = getMessage(db, id);
      if (!m) return undefined;
      const isPermittedInitialTargetMessage = mayUseTestConsoleQuestion
        && id === input.questionMessageId
        && initialMessageIds.has(id)
        && m.channel_id === input.pinnedChannelId;
      const scope = isPermittedInitialTargetMessage
        ? resolveCurrentChannelScope(db, m.channel_id)
        : resolveRetrievableChannelScope(db, m.channel_id);
      // Channel gone → its scope cannot be confirmed → fail closed (treat as
      // unresolvable so the citation is rejected rather than sent blind).
      if (!scope) return undefined;
      return {
        channelId: m.channel_id,
        scopeChannelId: scope.scopeChannelId,
        visibility: scope.visibility,
        deletedAtMs: m.deleted_at_ms,
      };
    },
    resolveChannel: (id) => {
      const ch = getChannel(db, id);
      if (!ch) return undefined;
      const scope = resolveCurrentChannelScope(db, id);
      return {
        visibility: scope?.visibility ?? 'excluded',
        allowInterventions: ch.allow_interventions === 1,
        deletedAtMs: ch.deleted_at_ms,
      };
    },
    // Direct answers cite messages only; no memory references to resolve.
    resolveMemoryScope: () => undefined,
  };
  const evidence = validateOutboundEvidence(
    {
      target: input.target,
      citedMessageIds: liveCitedIds,
      referencedMemoryIds: [],
      replyToMessageId: input.replyToMessageId,
      requireInterventionsEnabled: false,
    },
    lookups,
  );
  if (evidence.outcome === 'reject') reasons.push(...evidence.reasons);

  // Rate controls (Section 24.4): a channel cooldown or a near-duplicate suppresses.
  if (!input.rateChecks.cooldown.allowed) {
    reasons.push(
      ...input.rateChecks.cooldown.blocks.map((b) => `rate-limited (${b.rule}): ${b.detail}`),
    );
  }
  if (input.rateChecks.duplicate.matched) {
    reasons.push(
      `${input.rateChecks.duplicate.kind} duplicate of a recent ${input.rateChecks.duplicate.source} message`,
    );
  }

  if (reasons.length > 0) {
    return {
      allow: false,
      reasons,
      ...(input.rateChecks.cooldown.allowed
        ? input.rateChecks.duplicate.matched
          ? { intentionalSuppression: 'duplicate' as const }
          : {}
        : { intentionalSuppression: 'rate_limit' as const }),
    };
  }

  // Assemble the final content: the validated message plus host-built masked
  // source links (trusted, never model-controlled). Reject if assembly exceeds
  // Discord's hard limit.
  const inline = sanitized.outcome === 'allow'
    ? renderInlineCitations(sanitized.content, [...sanitized.sourceLinks, ...archiveLinks])
    : { outcome: 'reject' as const, reasons: ['outbound sanitization failed'] };
  if (inline.outcome === 'reject') {
    return { allow: false, reasons: inline.reasons };
  }
  const sourceLine = inline.unusedLinks.length > 0
    ? `Sources: ${inline.unusedLinks.map((link) => link.masked).join(' · ')}`
    : null;
  const coverageFooter = input.snapshotCoverage
    ? formatCoverageFooter(input.snapshotCoverage)
    : null;
  const suffixLines = [...(sourceLine ? [sourceLine] : []), ...(coverageFooter ? [coverageFooter] : [])];
  const suffix = suffixLines.length > 0 ? `\n\n${suffixLines.join('\n')}` : '';
  const baseContent = inline.content;
  const availableForBase = DISCORD_MESSAGE_MAX - suffix.length;
  if (availableForBase < 1 || baseContent.length > availableForBase) {
    return {
      allow: false,
      reasons: ['answer leaves insufficient room for validated source links and coverage'],
    };
  }
  const assembled = `${baseContent}${suffix}`;

  return { allow: true, reasons: [], content: assembled, replyToMessageId: input.replyToMessageId };
}

function formatCoverageFooter(coverage: RecentActivityCoverage): string {
  const included = coverage.persisted.includedMessages ?? 0;
  const matched = coverage.persisted.matchedMessages ?? included + coverage.omitted;
  const includedChannels = coverage.persisted.includedChannels ?? 0;
  const matchedChannels = coverage.persisted.matchedChannels ?? includedChannels;
  if (coverage.persisted.complete) {
    return `Coverage: complete — analyzed all ${matched} matching messages across ${matchedChannels} channels.`;
  }
  const allChannels = includedChannels === matchedChannels;
  const channels = allChannels
    ? `all ${matchedChannels} matching channels`
    : `${includedChannels}/${matchedChannels} matching channels`;
  const reason = coverage.persisted.truncationReason === 'message_cap'
    ? 'the 200-message limit applied'
    : coverage.persisted.truncationReason === 'character_cap'
      ? 'the 50,000-character limit applied'
      : 'the 200-message and 50,000-character limits applied';
  const narrow = matched > 0 && included / matched < 0.25
    ? ' Narrow the topic, channels, or time window for more detail.'
    : '';
  return `Coverage: partial — analyzed a balanced sample of ${included}/${matched} matching messages across ${channels}; ${reason}.${narrow}`;
}
