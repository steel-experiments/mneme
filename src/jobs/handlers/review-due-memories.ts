import type { Api, Model, ThinkingLevel } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { type DatabaseSync, transaction, transactionImmediate } from '../../db/database.js';
import {
  resolveRetrievableChannelScope,
  type VisibilityClass,
} from '../../db/repositories/channels.js';
import { getMessage } from '../../db/repositories/messages.js';
import type { RetrievalGrant } from '../../db/repositories/message-search.js';
import { selectDueMemories, type DueMemoryCandidate } from '../../memory/due.js';
import {
  DEFAULT_ATTENTION_WINDOW_MS,
  evaluateRevisionAdmission,
} from '../../memory/attention.js';
import {
  claimRevision,
  findSubjectForMember,
  getClaim,
  getRevision,
  listRevisionTriggerMessageIds,
  markSubjectRegistrationComplete,
  revisionHasUnconsumedEvent,
  validateRevisionEvidence,
} from '../../memory/attention-repository.js';
import { insertProposal } from '../../db/repositories/proposals.js';
import { archiveCitationReasons, sanitizeOutboundMessage } from '../../outbound/message-safety.js';
import { isMnemeTestSurface } from '../../ingestion/test-channels.js';
import type { PromptCompiler } from '../../agent/prompts.js';
import {
  executeAgentRun,
  type AgentRunResult,
  type AgentRunUsage,
  type ExecuteAgentRunDeps,
  type RunLimits,
} from '../../agent/runtime.js';
import {
  applyMemoryProposals,
  type AgentMemoryProposal,
  type ApplyMemoryProposalsResult,
} from '../../agent/memory-policy.js';
import type { AutonomyMode } from '../../config.js';
import { buildScheduledPolicyDecision } from '../../agent/policy-audit.js';
import type { Logger } from '../../logger.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';
import { DeferJobError, PermanentJobError, TransientJobError } from '../errors.js';
import type { PlatformFormat } from '../../platform/types.js';
import {
  assembleScheduledDelivery,
  scheduledSourceLinkContext,
} from '../../memory/scheduled-delivery.js';
import {
  DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
  findScheduledSubjectBlock,
  insertScheduledProposalSubjects,
  resolveScheduledSubjects,
  scheduledTopicKey,
  type ScheduledSubjectSnapshot,
} from '../../memory/scheduled-notifications.js';

/**
 * Target-scoped scheduled cohort runner (Sections 12.4, 20, 24.3).
 *
 * The host-only `review_due_memories` dispatcher creates bounded cohort jobs.
 * This reusable runner loads one cohort, pins the run to its precomputed exact
 * working target (or the secure inbox for maintenance-only work), renders the
 * scheduled-review prompt, and executes exactly one
 * {@link executeAgentRun} of type `scheduled_review` outside any transaction.
 *
 * A finalized run yields two host-validated outcomes and nothing else:
 *   1. Memory lifecycle updates — applied through {@link applyMemoryProposals},
 *      which independently re-validates every cited message and target. Rejected
 *      proposals are retained for evaluation; no unsupported mutation occurs.
 *   2. A notification proposal — persisted through normal policy. A material,
 *      recommended working-channel notification becomes `pending_review` (its
 *      card is surfaced in the secure review channel); anything else is stored as
 *      `observed`. A scheduled notification is **never** routed `approved`: even
 *      in autonomous mode it goes to secure review, never directly to a working
 *      channel. The pinned target makes retargeting impossible (the finalization
 *      tool rejects any other `targetChannelId`).
 *
 * Silence is valid: when nothing is due, or the run does not finalize, no memory
 * is touched and no proposal is created. A failed agent run records itself and
 * completes the job. Deterministic prompt-preparation failures are terminal job
 * errors, while explicit transient/deferred runtime failures keep their retry
 * semantics.
 */

/** Default review window stamped on a pending scheduled proposal (Section 25). */
export const DEFAULT_SCHEDULED_PROPOSAL_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Safe durable/logged category for deterministic prompt preparation failures. */
export const SCHEDULED_REVIEW_PROMPT_PREPARATION_ERROR =
  'review_due_memories: prompt preparation failed; verify required target metadata and prompt templates';

/** Agent runtime inputs; required unless `executeRun` overrides the run. */
export interface AgentRuntimeInputs {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  streamFn: StreamFn;
  providerId: string;
  modelId: string;
}

/** Host-resolved retrieval ceiling, approval inbox, and pinned cohort target. */
export interface ReviewScope {
  grant: RetrievalGrant;
  /** Secure approval-inbox channel id. */
  reviewChannelId: string;
  /** Exact host-derived run and delivery target. Defaults to reviewChannelId for legacy callers. */
  targetChannelId?: string;
  /** False for secure-maintenance cohorts. */
  notificationsAllowed?: boolean;
  /** Host-resolved metadata required by the shared system prompt. */
  target: ScheduledReviewTarget;
}

export interface ScheduledReviewTarget {
  label: string;
  visibility: VisibilityClass;
}

/** Complete task/system render context owned by the scheduled-review host. */
export type ScheduledReviewRenderContext = {
  dueMemories: Array<Omit<DueMemoryCandidate, 'memoryId'> & {
    id: string;
    /** Host-pinned attention revision the notification must echo (Section 12.7). */
    attentionRevisionId?: string;
  }>;
  target: ScheduledReviewTarget;
  runtime: { mode: AutonomyMode; nowIso: string };
};

/** Structural read of the accepted scheduled-review proposal (host-validated). */
export interface ScheduledReviewProposal {
  memoryProposals: AgentMemoryProposal[];
  notification: ScheduledNotificationProposal;
  notes?: string;
}

export interface ScheduledNotificationProposal {
  recommend: boolean;
  reason: string;
  targetChannelId: string;
  message?: string;
  evidenceMessageIds: string[];
  subjectMemoryIds: string[];
  /** Echo of the cohort's host-pinned attention revision (Section 12.7). */
  attentionRevisionId?: string;
}

export interface ReviewDueMemoriesHandlerDeps {
  /** The active platform's text conventions (Section 24.5). */
  format: PlatformFormat;
  db: DatabaseSync;
  guildId: string;
  promptCompiler: PromptCompiler | (() => PromptCompiler);
  /** `channel-policy.yml` source, included in the prompt version when present. */
  channelPolicyYml?: string | (() => string);
  /** `mneme.yml` source, included in the prompt version when present. */
  mnemeYml?: string;
  /** Rendered system prompt, or a renderer using this run's complete context. */
  systemPrompt: string | ((context: ScheduledReviewRenderContext) => string);
  /** Resolve the cohort retrieval grant, approval inbox, and prompt target metadata. */
  resolveReviewScope: () => ReviewScope;
  /** Deployment mode (observe / review / autonomous). */
  mode: AutonomyMode | (() => AutonomyMode);
  /** Upper bound on due items considered (default 50). */
  dueLimit?: number;
  /** Cohort-owned due selection override. */
  selectDue?: (now: number) => DueMemoryCandidate[];
  /** Snapshot/route guard run before and after model exposure. */
  validateSnapshot?: () => boolean;
  /** Current exact-route check after host memory updates. */
  validateNotificationSubjects?: (subjects: readonly ScheduledSubjectSnapshot[]) => boolean;
  /** Unique scheduled cohort session suffix. */
  sessionId?: string;
  /** Agent runtime inputs; required unless `executeRun` overrides the run. */
  agent?: AgentRuntimeInputs;
  /** Override the agent-run executor (tests). Defaults to {@link executeAgentRun}. */
  executeRun?: (deps: ExecuteAgentRunDeps) => Promise<AgentRunResult>;
  /** Override memory-proposal application (tests). Defaults to {@link applyMemoryProposals}. */
  applyMemory?: (deps: ApplyArgs, proposals: readonly AgentMemoryProposal[]) => ApplyMemoryProposalsResult;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  /** Per-run host-enforced limits (Section 21.2). */
  limits?: Partial<RunLimits>;
  memoryMinimumConfidence?: number;
  memoryMinimumImportance?: number;
  /** Quiet period for an unchanged subject after send/dismissal (default 7 days). */
  scheduledReminderIntervalMs?: number;
  /** Cohort attention mode (Section 12.7). Registration runs never post. */
  attentionMode?: 'attention_review' | 'attention_registration';
  /** Pinned attention revisions by subject memory (attention_review cohorts). */
  attentionRevisions?: ReadonlyMap<string, {
    revisionId: string;
    windowFromMs: number;
    windowUntilMs: number;
  }>;
  /** Proactive attention window (Section 12.7; default seven days). */
  attentionWindowMs?: number;
  /** Organization timezone captured with accepted deadline authority. */
  attentionTimezone?: string;
  /** Discord application id; Mneme's own messages are never triggers. */
  mnemeId?: string;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface ApplyArgs {
  db: DatabaseSync;
  grant: RetrievalGrant;
  guildId: string;
  runId: string;
  now: number;
  exposedChannelIds: ReadonlySet<string>;
  exposedMessageIds: ReadonlySet<string>;
  exposedMemoryIds: ReadonlySet<string>;
  minimumConfidence?: number;
  minimumImportance?: number;
  attentionWindowMs?: number;
  attentionTimezone?: string;
  mnemeId?: string;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface ScheduledNotificationRouting {
  state: 'observed' | 'pending_review';
  reasons: string[];
}

export type ScheduledReviewOutcome =
  | { kind: 'nothing_due'; dueCount: 0 }
  | {
      kind: 'reviewed';
      runId: string;
      dueCount: number;
      memory: ApplyMemoryProposalsResult;
      notification: { routing: ScheduledNotificationRouting; proposalId: string };
      usage: AgentRunUsage;
    }
  | {
      kind: 'no_finalization';
      runId: string;
      dueCount: number;
      outcome: Exclude<AgentRunResult['outcome'], 'finalized'>;
      failureReason: string | null;
      usage: AgentRunUsage;
    }
  | {
      kind: 'error';
      runId: string;
      dueCount: number;
      failureReason: string;
    };

/**
 * Route a scheduled notification through normal policy (Section 24.3).
 *
 * Scheduled notifications differ from interventions: they carry only a binary
 * `recommend`, so the heavy score/dimension eligibility of {@link routeProposal}
 * does not apply. A recommended notification whose host-pinned working target is
 * eligible becomes `pending_review` (card surfaced for a human) in review or
 * autonomous mode; in observe mode, maintenance cohorts, or when not recommended, it is stored as
 * `observed`. A scheduled notification is **never** routed `approved` — even in
 * autonomous mode it never sends directly to a working channel.
 */
export function routeScheduledNotification(input: {
  mode: AutonomyMode;
  recommend: boolean;
  targetChannelId: string;
  pinnedTargetChannelId?: string;
  /** @deprecated compatibility alias for pre-cohort callers. */
  reviewChannelId?: string;
  notificationsAllowed?: boolean;
}): ScheduledNotificationRouting {
  if (input.mode === 'observe') {
    return { state: 'observed', reasons: ['observe mode: proposals are stored only'] };
  }
  if (!input.recommend) {
    return { state: 'observed', reasons: ['notification not recommended'] };
  }
  if (input.notificationsAllowed === false) {
    return { state: 'observed', reasons: ['secure maintenance does not allow notifications'] };
  }
  if (input.targetChannelId !== (input.pinnedTargetChannelId ?? input.reviewChannelId)) {
    return {
      state: 'observed',
      reasons: ['notification target differs from the host-pinned working channel'],
    };
  }
  return {
    state: 'pending_review',
    reasons: ['recommended; routed to secure review'],
  };
}

interface PreparedScheduledNotification {
  /** Host-sanitized text. Unsafe or blank text is never retained. */
  message: string | null;
  /** Deduplicated citations that were both exposed by this run and remain retrievable. */
  evidenceMessageIds: string[];
  /** Host-validated due memories that this notification is about. */
  subjects: ScheduledSubjectSnapshot[];
  /** Stable host-computed key for the exact subject set. */
  topicKey: string | null;
  /** Content-free reasons that force an otherwise recommended notification to observed. */
  blockingReasons: string[];
  outboundSafety: { outcome: 'allow' | 'reject'; reasons: string[] };
}

/**
 * Validate the model-authored part of a scheduled notification before it is
 * persisted. Scheduled reviews do not use direct-answer fingerprint parity
 * because the same run may legitimately mutate the due memories, but their
 * message citations still have to be exact rows exposed by this run.
 */
function prepareScheduledNotification(
  db: DatabaseSync,
  guildId: string,
  format: PlatformFormat,
  notification: ScheduledNotificationProposal | undefined,
  provenance: AgentRunResult['provenance'],
  dueMemoryIds: ReadonlySet<string>,
  now: number,
  pinnedAttention?: { revisionId: string; triggerMessageIds: readonly string[] },
): PreparedScheduledNotification {
  const blockingReasons: string[] = [];
  const recommendationReason = typeof notification?.reason === 'string'
    ? notification.reason.trim()
    : '';
  if (notification?.recommend === true && recommendationReason.length === 0) {
    blockingReasons.push('notification has no recommendation reason');
  }
  // The model must echo the host-pinned revision and cite its triggering
  // evidence; historical context citations do not count as the trigger.
  if (notification?.recommend === true && pinnedAttention) {
    if (notification.attentionRevisionId !== pinnedAttention.revisionId) {
      blockingReasons.push('notification did not echo the pinned attention revision');
    } else {
      const cited = new Set(
        Array.isArray(notification.evidenceMessageIds) ? notification.evidenceMessageIds : [],
      );
      if (!pinnedAttention.triggerMessageIds.some((id) => cited.has(id))) {
        blockingReasons.push('notification does not cite the pinned revision trigger');
      }
    }
  }

  const rawEvidenceIds = Array.isArray(notification?.evidenceMessageIds)
    ? notification.evidenceMessageIds
    : [];
  // A scheduled notification never cites the platform archive (plan 011 decision 4).
  blockingReasons.push(...archiveCitationReasons(
    'scheduled notification',
    typeof notification?.message === 'string' ? notification.message : '',
    rawEvidenceIds.filter((id): id is string => typeof id === 'string'),
  ));
  const proposedIds: string[] = [];
  const seen = new Set<string>();
  let malformedEvidence = false;
  for (const candidate of rawEvidenceIds) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      malformedEvidence = true;
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    proposedIds.push(candidate);
  }

  const exposedIds = new Set(
    Array.isArray(provenance.messageIds) ? provenance.messageIds : [],
  );
  const evidenceMessageIds: string[] = [];
  let hasUnexposedEvidence = malformedEvidence;
  let hasUnavailableEvidence = false;

  for (const messageId of proposedIds) {
    if (!exposedIds.has(messageId)) {
      hasUnexposedEvidence = true;
      continue;
    }
    const current = getMessage(db, messageId);
    if (
      !current
      || current.workspace_id !== guildId
      || current.deleted_at_ms !== null
      || isMnemeTestSurface(db, current.channel_id)
      || !resolveRetrievableChannelScope(db, current.channel_id)
    ) {
      hasUnavailableEvidence = true;
      continue;
    }
    evidenceMessageIds.push(messageId);
  }

  if (hasUnexposedEvidence) {
    blockingReasons.push('notification evidence was not exposed by the originating run');
  }
  if (hasUnavailableEvidence) {
    blockingReasons.push('notification evidence is no longer retrievable');
  }

  const rawMessage = typeof notification?.message === 'string' ? notification.message : null;
  const trimmedMessage = rawMessage?.trim() ?? '';
  let message: string | null = null;
  let outboundSafety: PreparedScheduledNotification['outboundSafety'] = { outcome: 'allow', reasons: [] };

  if (trimmedMessage.length === 0) {
    if (notification?.recommend === true) {
      blockingReasons.push('notification has no sendable message text');
    }
  } else {
    // The durable text keeps `[[cite:<id>]]` markers; links are host-built at
    // delivery time (Section 24.5). This call stays the authoritative
    // text-safety boundary, and the assembly below proves the markers resolve
    // against validated evidence and that the delivered form fits one message.
    const sanitized = sanitizeOutboundMessage(
      {
        content: trimmedMessage,
        guildId,
        format,
        sourceLinkMessageIds: evidenceMessageIds,
      },
      scheduledSourceLinkContext(db, guildId),
    );
    if (sanitized.outcome === 'allow') {
      const assembled = assembleScheduledDelivery(sanitized.content, sanitized.sourceLinks);
      if (assembled.outcome === 'allow') {
        message = sanitized.content;
      } else {
        blockingReasons.push(...assembled.reasons);
        outboundSafety = { outcome: 'reject', reasons: assembled.reasons };
      }
    } else {
      blockingReasons.push('notification failed outbound safety validation');
      outboundSafety = { outcome: 'reject', reasons: sanitized.reasons };
    }
  }

  const resolvedSubjects = hasUnexposedEvidence || hasUnavailableEvidence
    ? { subjects: [], blockingReasons: [] }
    : resolveScheduledSubjects(db, {
        dueMemoryIds,
        proposedSubjectMemoryIds: Array.isArray(notification?.subjectMemoryIds)
          ? notification.subjectMemoryIds
          : [],
        citedMessageIds: new Set(evidenceMessageIds),
        now,
        ...(pinnedAttention !== undefined
          ? { acceptedTriggerMessageIds: new Set(pinnedAttention.triggerMessageIds) }
          : {}),
      });
  if (notification?.recommend === true) {
    blockingReasons.push(...resolvedSubjects.blockingReasons);
  }

  return {
    message,
    evidenceMessageIds,
    subjects: resolvedSubjects.subjects,
    topicKey: scheduledTopicKey(resolvedSubjects.subjects),
    blockingReasons: [...new Set(blockingReasons)],
    outboundSafety,
  };
}

/**
 * Attention admission for the cohort's pinned revision (Section 12.7). Returns
 * a content-free blocking reason when the pinned revision is no longer
 * eligible, or null when it authorizes speech (or the cohort is a registration
 * pass, which cannot produce notifications at all).
 */
function evaluateCohortAttention(
  deps: ReviewDueMemoriesHandlerDeps,
  due: readonly DueMemoryCandidate[],
  now: number,
): string | null {
  if (deps.attentionMode !== 'attention_review') return null;
  const memoryId = due[0]?.memoryId;
  const pinned = memoryId !== undefined ? deps.attentionRevisions?.get(memoryId) : undefined;
  if (!pinned) {
    return 'attention gate (attention_authority_missing): cohort has no pinned revision';
  }
  const revision = getRevision(deps.db, pinned.revisionId);
  if (!revision) {
    return 'attention gate (trigger_changed): the pinned revision is gone';
  }
  if (!validateRevisionEvidence(deps.db, pinned.revisionId, now)) {
    return 'attention gate (trigger_changed): the pinned sources are no longer current';
  }
  if (!revisionHasUnconsumedEvent(deps.db, pinned.revisionId)) {
    return 'attention gate (revision_consumed): the human event has already been used';
  }
  const verdict = evaluateRevisionAdmission(
    {
      revisionId: revision.id,
      subjectId: revision.subjectId,
      state: revision.state,
      humanEventAtMs: revision.humanEventAtMs,
      explicitDeadlineAtMs: revision.explicitDeadlineAtMs,
    },
    getClaim(deps.db, pinned.revisionId),
    now,
    deps.attentionWindowMs ?? DEFAULT_ATTENTION_WINDOW_MS,
  );
  if (!verdict.eligible) {
    return `attention gate (${verdict.reason}): the pinned revision is not eligible`;
  }
  return null;
}

/** Build a `review_due_memories` handler. `runScheduledReview()` exposes the work. */
export function createReviewDueMemoriesHandler(
  deps: ReviewDueMemoriesHandlerDeps,
): JobHandler<'review_due_memories'> & {
  runScheduledReview(sinceMs?: number): Promise<ScheduledReviewOutcome>;
} {
  if (!deps.agent && !deps.executeRun) {
    throw new Error('createReviewDueMemoriesHandler: either `agent` or `executeRun` must be provided');
  }
  const executeRun = deps.executeRun ?? executeAgentRun;
  const applyMemory = deps.applyMemory ?? applyMemoryProposals;

  const runScheduledReview = async (sinceMs?: number): Promise<ScheduledReviewOutcome> => {
    const now = deps.now?.() ?? Date.now();
    const db = deps.db;

    // The job's `sinceMs` is the tick that scheduled it; selection uses `now` so
    // a delayed job still reviews everything due at execution time.
    void sinceMs;
    const due = deps.selectDue?.(now) ?? selectDueMemories(db, { now, limit: deps.dueLimit });
    if (due.length === 0) {
      return { kind: 'nothing_due', dueCount: 0 };
    }

    const scope = deps.resolveReviewScope();
    const pinnedTargetChannelId = scope.targetChannelId ?? scope.reviewChannelId;
    if (deps.validateSnapshot && !deps.validateSnapshot()) {
      return { kind: 'nothing_due', dueCount: 0 };
    }
    let context: ScheduledReviewRenderContext;
    let promptText: string;
    let promptVersion: string;
    let renderedSystemPrompt: string;
    try {
      assertReviewScope(scope);
      context = buildRenderContext(due, deps, scope, now);
      const compiler = typeof deps.promptCompiler === 'function' ? deps.promptCompiler() : deps.promptCompiler;
      promptText = compiler.render('scheduled-review', context);
      promptVersion = compiler.versionFor('scheduled-review', {
        mnemeYml: deps.mnemeYml,
        channelPolicyYml: typeof deps.channelPolicyYml === 'function' ? deps.channelPolicyYml() : deps.channelPolicyYml,
      });
      renderedSystemPrompt = typeof deps.systemPrompt === 'function'
        ? deps.systemPrompt(context)
        : deps.systemPrompt;
    } catch (err) {
      if (err instanceof DeferJobError || err instanceof TransientJobError) throw err;
      const failure = promptPreparationError(err);
      deps.logger?.warn(
        { errorCategory: 'prompt_preparation_failed' },
        'review_due_memories: prompt preparation failed; job will not retry',
      );
      throw failure;
    }

    const a = deps.agent;
    const runDeps: ExecuteAgentRunDeps = {
      db,
      grant: scope.grant,
      systemPrompt: renderedSystemPrompt,
      model: a?.model ?? (undefined as unknown as ExecuteAgentRunDeps['model']),
      thinkingLevel: a?.thinkingLevel ?? 'minimal',
      streamFn: a?.streamFn ?? (undefined as unknown as ExecuteAgentRunDeps['streamFn']),
      sessionId: deps.sessionId ?? 'mneme:scheduled-review',
      cacheProfile: 'scheduled',
      promptText,
      promptVersion,
      runType: 'scheduled_review',
      guildId: deps.guildId,
      episodeId: null,
      pinnedTargetChannelId,
      initialProvenanceMemoryScopes: due.map((d) => ({
        memoryId: d.memoryId,
        scopeType: d.scopeType,
        scopeKey: d.scopeKey,
      })),
      providerId: a?.providerId ?? '',
      modelId: a?.modelId ?? '',
      now,
      limits: deps.limits,
    };

    let result: AgentRunResult;
    try {
      result = await executeRun(runDeps);
    } catch (err) {
      if (err instanceof DeferJobError || err instanceof TransientJobError) throw err;
      const failureReason = err instanceof Error ? err.message : String(err);
      deps.logger?.warn(
        { err: failureReason },
        'review_due_memories: run executor threw',
      );
      return { kind: 'error', runId: 'unknown', dueCount: due.length, failureReason };
    }

    if (result.outcome !== 'finalized' || !result.finalProposal) {
      deps.logger?.warn(
        { runId: result.runId, outcome: result.outcome, failureReason: result.failureReason },
        'review_due_memories: run did not finalize; no memory or notification applied',
      );
      return {
        kind: 'no_finalization',
        runId: result.runId,
        dueCount: due.length,
        // A finalized run with no accepted proposal is treated as no-finalization;
        // the runtime guarantees a finalized run carries an accepted proposal.
        outcome: result.outcome === 'finalized' ? 'no_finalization' : result.outcome,
        failureReason: result.failureReason,
        usage: result.usage,
      };
    }

    if (deps.validateSnapshot && !deps.validateSnapshot()) {
      deps.logger?.warn(
        { runId: result.runId },
        'review_due_memories: cohort changed during model execution; all host effects discarded',
      );
      return {
        kind: 'no_finalization',
        runId: result.runId,
        dueCount: due.length,
        outcome: 'no_finalization',
        failureReason: 'scheduled cohort snapshot changed',
        usage: result.usage,
      };
    }

    const proposal = result.finalProposal.proposal as ScheduledReviewProposal;
    const memoryProposals = Array.isArray(proposal.memoryProposals) ? proposal.memoryProposals : [];
    const notification = proposal.notification;

    // 1. Apply memory lifecycle updates through the host validation gate. Only
    //    channels the model actually saw this run may ground a memory.
    const exposedChannelIds = new Set(result.provenance.channels.map((c) => c.channelId));
    const exposedMemoryIds = new Set([
      ...due.map((memory) => memory.memoryId),
      ...(result.provenance.memoryIds ?? []),
    ]);
    const exposedMessageIds = new Set(result.provenance.messageIds ?? []);
    const memory = applyMemory(
      {
        db,
        grant: scope.grant,
        guildId: deps.guildId,
        runId: result.runId,
        now,
        exposedChannelIds,
        exposedMessageIds,
        exposedMemoryIds,
        minimumConfidence: deps.memoryMinimumConfidence,
        minimumImportance: deps.memoryMinimumImportance,
        attentionWindowMs: deps.attentionWindowMs,
        attentionTimezone: deps.attentionTimezone,
        mnemeId: deps.mnemeId,
        logger: deps.logger,
      },
      memoryProposals,
    );

    // 2. Persist the notification proposal through normal policy. Never approved.
    const pinnedSubjectMemoryId = due[0]?.memoryId;
    const pinnedRevision = pinnedSubjectMemoryId !== undefined
      ? deps.attentionRevisions?.get(pinnedSubjectMemoryId)
      : undefined;
    const pinnedAttention = pinnedRevision !== undefined
      ? {
          revisionId: pinnedRevision.revisionId,
          triggerMessageIds: listRevisionTriggerMessageIds(db, pinnedRevision.revisionId),
        }
      : undefined;
    const preparedNotification = prepareScheduledNotification(
      db,
      deps.guildId,
      deps.format,
      notification,
      result.provenance,
      new Set(due.map((memory) => memory.memoryId)),
      now,
      pinnedAttention,
    );
    const currentMode = typeof deps.mode === 'function' ? deps.mode() : deps.mode;
    const baseRouting = routeScheduledNotification({
      mode: currentMode,
      recommend: notification?.recommend === true,
      targetChannelId: notification?.targetChannelId ?? pinnedTargetChannelId,
      pinnedTargetChannelId,
      notificationsAllowed: scope.notificationsAllowed,
    });
    const subjectBlock = baseRouting.state === 'pending_review'
      && preparedNotification.blockingReasons.length === 0
      ? findScheduledSubjectBlock(db, {
          subjects: preparedNotification.subjects,
          now,
          reminderIntervalMs: deps.scheduledReminderIntervalMs
            ?? DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
        })
      : { blocked: false as const };
    const attentionGate = evaluateCohortAttention(deps, due, now);
    const allBlockingReasons = [
      ...preparedNotification.blockingReasons,
      ...(deps.attentionMode === 'attention_registration' && notification?.recommend === true
        ? ['registration cohorts never produce notifications']
        : []),
      ...(attentionGate !== null ? [attentionGate] : []),
      ...(deps.validateNotificationSubjects
        && !deps.validateNotificationSubjects(preparedNotification.subjects)
        ? ['notification subjects no longer resolve to the host-pinned working channel']
        : []),
      ...(subjectBlock.blocked ? [subjectBlock.reason] : []),
    ];
    const routing: ScheduledNotificationRouting = allBlockingReasons.length === 0
      ? baseRouting
      : {
          state: 'observed',
          reasons: [...new Set([
            ...(baseRouting.state === 'observed' ? baseRouting.reasons : []),
            ...allBlockingReasons,
          ])],
        };
    const recommendationReason = typeof notification?.reason === 'string'
      ? notification.reason.trim()
      : '';
    const policyDecision = buildScheduledPolicyDecision({
      mode: currentMode,
      state: routing.state,
      recommend: notification?.recommend === true,
      notificationsAllowed: scope.notificationsAllowed !== false,
      targetMatches: (notification?.targetChannelId ?? pinnedTargetChannelId) === pinnedTargetChannelId,
      outboundSafety: preparedNotification.outboundSafety,
      subjectBlockingReasons: allBlockingReasons,
      reasons: routing.reasons,
      attention: {
        mode: deps.attentionMode ?? '',
        pinned: pinnedRevision !== undefined,
        eligible: attentionGate === null,
        ...(pinnedRevision !== undefined ? { revisionId: pinnedRevision.revisionId } : {}),
        windowFromMs: pinnedRevision?.windowFromMs ?? 0,
        windowUntilMs: pinnedRevision?.windowUntilMs ?? 0,
      },
    });
    let proposalId = '';
    let claimLost = false;
    // The proposal deadline is the earlier of the ordinary window and the
    // immutable attention window end (Section 12.7).
    const ordinaryProposalExpiry = now + DEFAULT_SCHEDULED_PROPOSAL_WINDOW_MS;
    const attentionExpiry = pinnedRevision !== undefined ? pinnedRevision.windowUntilMs : undefined;
    const proposalExpiry = attentionExpiry !== undefined
      ? Math.min(ordinaryProposalExpiry, attentionExpiry)
      : ordinaryProposalExpiry;
    if (routing.state === 'pending_review') {
      transactionImmediate(db, () => {
        proposalId = insertProposal(db, {
          runId: result.runId,
          episodeId: null,
          targetChannelId: pinnedTargetChannelId,
          status: routing.state,
          computedScore: notification?.recommend === true ? 1 : 0,
          reason: routing.reasons,
          policyDecision,
          reviewReason: recommendationReason || null,
          topicKey: preparedNotification.topicKey,
          message: preparedNotification.message,
          evidenceMessageIds: preparedNotification.evidenceMessageIds,
          expiresAtMs: proposalExpiry,
          now,
        });
        insertScheduledProposalSubjects(db, proposalId, preparedNotification.subjects, now);
        // Claim the pinned revision atomically with the actionable proposal. A
        // lost race downgrades this row to observed inside the same
        // transaction; an observed proposal claims nothing.
        if (pinnedRevision && !claimRevision(db, {
          revisionId: pinnedRevision.revisionId,
          proposalId,
          consumedAtMs: now,
          eligibleFromMs: pinnedRevision.windowFromMs,
          eligibleUntilMs: pinnedRevision.windowUntilMs,
        })) {
          claimLost = true;
          db.prepare(
            `UPDATE proposals SET status = 'observed', updated_at_ms = ?,
               reason = 'attention gate (revision_consumed): the revision was claimed concurrently'
             WHERE id = ?`,
          ).run(now, proposalId);
        }
      });
    } else {
      transaction(db, () => {
        proposalId = insertProposal(db, {
          runId: result.runId,
          episodeId: null,
          targetChannelId: pinnedTargetChannelId,
          status: routing.state,
          computedScore: notification?.recommend === true ? 1 : 0,
          reason: routing.reasons,
          policyDecision,
          reviewReason: recommendationReason || null,
          topicKey: preparedNotification.topicKey,
          message: preparedNotification.message,
          evidenceMessageIds: preparedNotification.evidenceMessageIds,
          expiresAtMs: null,
          now,
        });
        insertScheduledProposalSubjects(db, proposalId, preparedNotification.subjects, now);
      });
    }
    // A completed registration pass marks its subjects complete so the same
    // uncovered evidence is not reconsidered each day.
    if (deps.attentionMode === 'attention_registration') {
      for (const memoryId of new Set(due.map((memory) => memory.memoryId))) {
        const subjectId = findSubjectForMember(db, memoryId);
        if (subjectId !== null) markSubjectRegistrationComplete(db, subjectId);
      }
    }

    deps.logger?.info(
      {
        runId: result.runId,
        dueCount: due.length,
        memoryApplied: memory.applied.length,
        memoryRejected: memory.rejected.length,
        notificationState: routing.state,
        proposalId,
      },
      'review_due_memories: finalized',
    );

    return {
      kind: 'reviewed',
      runId: result.runId,
      dueCount: due.length,
      memory,
      // A lost claim race downgraded the durable row to observed inside the
      // transaction; the outcome must agree so no card is posted for it.
      notification: {
        routing: claimLost
          ? {
              state: 'observed',
              reasons: ['attention gate (revision_consumed): the revision was claimed concurrently'],
            }
          : routing,
        proposalId,
      },
      usage: result.usage,
    };
  };

  const handler = async (payload: { sinceMs?: number }, _job: JobRow): Promise<void> => {
    await runScheduledReview(payload.sinceMs);
  };

  return Object.assign(handler, { runScheduledReview });
}

function buildRenderContext(
  due: DueMemoryCandidate[],
  deps: ReviewDueMemoriesHandlerDeps,
  scope: ReviewScope,
  now: number,
): ScheduledReviewRenderContext {
  return {
    dueMemories: due.map((d) => ({
      id: d.memoryId,
      type: d.type,
      statement: d.statement,
      status: d.status,
      confidence: d.confidence,
      importance: d.importance,
      reviewAfterMs: d.reviewAfterMs,
      lastConfirmedAtMs: d.lastConfirmedAtMs,
      evidenceCount: d.evidenceCount,
      scopeType: d.scopeType,
      scopeKey: d.scopeKey,
      ...(deps.attentionRevisions?.get(d.memoryId) !== undefined
        ? { attentionRevisionId: deps.attentionRevisions.get(d.memoryId)!.revisionId }
        : {}),
    })),
    target: scope.target,
    runtime: { mode: typeof deps.mode === 'function' ? deps.mode() : deps.mode, nowIso: new Date(now).toISOString() },
  };
}

function assertReviewScope(scope: ReviewScope): void {
  if (typeof scope.reviewChannelId !== 'string' || scope.reviewChannelId.trim().length === 0) {
    throw new PermanentJobError('review_due_memories: resolved scope is missing reviewChannelId');
  }
  if (
    !scope.target
    || typeof scope.target.label !== 'string'
    || scope.target.label.trim().length === 0
    || !isVisibilityClass(scope.target.visibility)
  ) {
    throw new PermanentJobError(
      'review_due_memories: resolved scope must include target.label and target.visibility',
    );
  }
}

function promptPreparationError(err: unknown): PermanentJobError {
  return new PermanentJobError(
    SCHEDULED_REVIEW_PROMPT_PREPARATION_ERROR,
    { cause: err },
  );
}

function isVisibilityClass(value: unknown): value is VisibilityClass {
  return value === 'org'
    || value === 'restricted'
    || value === 'review_only'
    || value === 'excluded';
}
