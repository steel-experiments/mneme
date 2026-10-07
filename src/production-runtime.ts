import { readFileSync } from 'node:fs';
import { createArchiveReader } from './platform-archive/read.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { RetrievalGrant } from './db/repositories/message-search.js';
import {
  getChannel,
  resolveCurrentChannelScope,
  resolveRetrievableChannelScope,
  sourceLinkChannelLabel,
  type VisibilityClass,
} from './db/repositories/channels.js';
import { getMessage } from './db/repositories/messages.js';
import { getMemory } from './memory/repository.js';
import { recomputeMemoryScopes } from './memory/search.js';
import {
  evaluateRevisionAdmission,
  isNewerThanFrontier,
  type AttentionRejectionReason,
} from './memory/attention.js';
import {
  claimRevision,
  ensureSubjectForMember,
  findConsumedTriggerMessageIds,
  getClaim,
  getRevision,
  getSubjectConsumedFrontier,
  listSubjectRevisions,
  registerRevision,
  validateProposalAttention,
  validateRevisionEvidence,
  validateTriggerEvidence,
} from './memory/attention-repository.js';
import {
  DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
  getScheduledProposalSubjects,
} from './memory/scheduled-notifications.js';
import {
  renderScheduledNotificationDelivery,
  validateScheduledProposalDelivery,
  type ScheduledDeliveryCheck,
} from './memory/scheduled-delivery.js';
import type { ScheduledRouteOptions } from './memory/scheduled-routing.js';
import { enqueue } from './jobs/queue.js';
import { createJobWorker } from './jobs/handlers/index.js';
import { createBackfillChannelHandler } from './jobs/handlers/backfill-channel.js';
import { createBuildHistoricalEpisodesHandler } from './jobs/handlers/build-historical-episodes.js';
import { createReconcileChannelHandler } from './jobs/handlers/reconcile-channel.js';
import { createRecoverMessageHandler } from './jobs/handlers/recover-message.js';
import { createIngestionObserver } from './observability.js';
import { createCloseEpisodeHandler } from './jobs/handlers/close-episode.js';
import { createDirectAnswerHandler } from './jobs/handlers/direct-answer.js';
import { createDeepRecapHandler } from './jobs/handlers/deep-recap.js';
import { createReviewEpisodeHandler } from './jobs/handlers/review-episode.js';
import type { ApplyMemoryProposalsResult } from './agent/memory-policy.js';
import {
  type ReviewScope,
} from './jobs/handlers/review-due-memories.js';
import { createReviewDueMemoryDispatcherHandler } from './jobs/handlers/review-due-memory-dispatcher.js';
import { createReviewDueMemoryCohortHandler } from './jobs/handlers/review-due-memory-cohort.js';
import { createSendOutboxHandler } from './outbox/worker.js';
import {
  createProposalDeliverySyncHandler,
  type ProposalDeliveryReport,
} from './outbox/proposal-delivery.js';
import { createBackupDatabaseHandler } from './jobs/handlers/backup-database.js';
import { createDatabaseMaintenanceHandler } from './jobs/handlers/maintenance.js';
import { createExpireProposalsHandler } from './jobs/handlers/expire-proposals.js';
import { createRescopeMemoriesHandler } from './jobs/handlers/rescope-memories.js';
import { expireClosedAttentionRevisions, type ExpireAttentionResult } from './memory/attention-repository.js';
import { runAttentionCutover, type AttentionCutoverReport } from './memory/attention-cutover.js';
import { createForgetUserHandler } from './jobs/handlers/forget-user.js';
import { createExecuteDeletionHandler } from './jobs/handlers/execute-deletion.js';
import { createArchiveAttachmentHandler } from './jobs/handlers/archive-attachment.js';
import { createPurgeAttachmentFileHandler } from './jobs/handlers/purge-attachment-file.js';
import { runPlatformDiscovery } from './ingestion/sync.js';
import { isMnemeTestSurface } from './ingestion/test-channels.js';
import { scopeAnchorId, scopeAnchorSql } from './policy/scope-anchor.js';
import { PeriodicScheduler, buildSchedules, nodeTimerDriver } from './jobs/scheduler.js';
import { isPaused } from './runtime-state.js';
import { defaultModelLookup, resolveAgentModels } from './agent/model.js';
import { evaluateCooldowns, DEFAULT_COOLDOWN_CONFIG } from './agent/cooldowns.js';
import { evaluateSettle, lastHumanMessageAtMs } from './episodes/settle.js';
import { detectDuplicate } from './agent/duplicate-policy.js';
import { reconcileOutboxSending } from './outbox/recovery.js';
import { enqueueOutbox } from './outbox/repository.js';
import {
  insertProposal,
  getProposal,
  setProposalStatus,
  type ProposalRow,
} from './db/repositories/proposals.js';
import { renderInlineCitations, sanitizeOutboundMessage, stripScheduledFooter, type MessageLink } from './outbound/message-safety.js';
import {
  evaluateForcedReview,
  evaluateProvenanceGate,
  resolveProvenanceScopes,
  routeProposal,
  validateOutboundEvidence,
  type AttentionRoutingInput,
  type ProvenanceGateResult,
  type ProvenanceScopeEntry,
} from './agent/policy.js';
import type { ReviewProposalInput } from './platform/types.js';
import { recheckApprovalPolicy, type ApprovalPolicyRecheck } from './review/workflow.js';
import { ModelBudgetGate, OrgDayBudget, classifyModelError } from './agent/budget.js';
import { orgDayStartMs } from './agent/cooldowns.js';
import { executeAgentRun, type AgentRunResult, type ExecuteAgentRunDeps } from './agent/runtime.js';
import { buildEpisodePolicyDecision } from './agent/policy-audit.js';
import { configuredRunLimits, deadlineBoundWallClockMs } from './agent/run-limits.js';
import {
  directAnswerAdmissionWaitMs,
  DIRECT_ANSWER_MODEL_SLOT_WAIT_MS,
  ModelAdmissionController,
  ModelAdmissionTimeoutError,
} from './agent/model-admission.js';
import { loadDocsIndex } from './agent/docs-index.js';
import { DeferJobError, PermanentJobError, TransientJobError } from './jobs/errors.js';
import type { BootstrapContext, PlatformWiring, JobRuntimeWiring } from './bootstrap.js';
import type { ChatPlatform } from './platform/types.js';
import { transactionImmediate, type DatabaseSync } from './db/database.js';
import {
  repairDeepRecapOwnership,
  repairDurableWork,
  type DeepRecapOwnershipRepairReport,
} from './jobs/startup-repair.js';
import {
  ensureHistoricalCampaign,
  getHistoricalCampaign,
  historicalCampaignSpend,
  setHistoricalCampaignStatus,
  wakeHistoricalCampaignReviews,
} from './historical/campaign.js';
import { messageLink } from './platform/links.js';


/** The DM sent to the admin who asked for a backup (Section 31). */
export function backupCompletedNotice(platformId: ChatPlatform['id'], file: string, bytes: number): string {
  const where = platformId === 'slack' ? 'a Slack channel' : 'the Discord server';
  return `Mneme backup completed: ${file} (${bytes} bytes), integrity_check: ok.\n\n`
    + `Mneme doesn't answer questions in DMs. Ask me in ${where} by mentioning @Mneme in a channel I can access.`;
}

export { DIRECT_ANSWER_MODEL_SLOT_WAIT_MS } from './agent/model-admission.js';

/** Short allowance for prompt setup and durable outcome bookkeeping around a model call. */
export const JOB_LEASE_COMPLETION_MARGIN_MS = 5_000;

/**
 * Size production job leases for the longest interactive path while preserving
 * the established two-times-model-timeout recovery cushion for every job type.
 */
export function productionJobLeaseMs(agentTimeoutSeconds: number): number {
  const modelWallClockMs = agentTimeoutSeconds * 1_000;
  return Math.max(
    60_000,
    modelWallClockMs * 2,
    DIRECT_ANSWER_MODEL_SLOT_WAIT_MS
      + modelWallClockMs
      + JOB_LEASE_COMPLETION_MARGIN_MS,
  );
}

/** Current channels eligible for periodic reconciliation. */
export function scheduledIngestionChannelIds(db: DatabaseSync): string[] {
  return (db.prepare(
    'SELECT id FROM channels WHERE ingest_enabled = 1 AND deleted_at_ms IS NULL',
  ).all() as Array<{ id: string }>)
    .map((row) => row.id)
    .filter((channelId) => !isMnemeTestSurface(db, channelId));
}

/**
 * When a periodic schedule last ran, read from durable job history: the newest
 * job created under the schedule's unique key (`exact`), or under any key with
 * the given prefix (`prefix`, for per-channel fan-out). Null when no such job
 * exists — including when retention has pruned it, in which case the schedule
 * waits one full interval like a fresh install. Read once per schedule at boot.
 */
export function lastScheduledRunMs(db: DatabaseSync, key: string, match: 'exact' | 'prefix'): number | null {
  const row = (match === 'exact'
    ? db.prepare('SELECT MAX(created_at_ms) AS m FROM jobs WHERE unique_key = ?').get(key)
    : db.prepare('SELECT MAX(created_at_ms) AS m FROM jobs WHERE unique_key >= ? AND unique_key < ?')
      .get(key, `${key}\uffff`)) as { m: number | bigint | null } | undefined;
  return row?.m === null || row?.m === undefined ? null : Number(row.m);
}

export interface PeriodicMaintenanceCycleDeps {
  expireProposals: () => Promise<unknown>;
  /** Closed-window sweep for unconsumed attention revisions (Section 12.7). */
  expireAttention: () => ExpireAttentionResult;
  maintainDatabase: () => Promise<unknown>;
  repairDeepRecaps: () => DeepRecapOwnershipRepairReport;
  logger: Pick<BootstrapContext['logger'], 'info'>
    & Partial<Pick<BootstrapContext['logger'], 'warn'>>;
}

/** Run periodic maintenance and reconcile ownerless deep recaps afterward. */
export async function runPeriodicMaintenanceCycle(
  deps: PeriodicMaintenanceCycleDeps,
): Promise<DeepRecapOwnershipRepairReport> {
  await deps.expireProposals();
  const attentionSweep = deps.expireAttention();
  if (attentionSweep.expiredRevisionIds.length > 0) {
    deps.logger.info(
      { event: 'attention.window_expired', count: attentionSweep.expiredRevisionIds.length },
      'expired attention revisions whose supported windows closed',
    );
  }
  await deps.maintainDatabase();
  const repair = deps.repairDeepRecaps();
  deps.logger.info(
    {
      event: 'jobs.deep_recap_ownership_repair',
      jobsEnqueued: repair.jobsEnqueued,
      chunksReset: repair.chunksReset,
      duplicateJobsCancelled: repair.duplicateJobsCancelled,
      runningJobsRecovered: repair.runningJobsRecovered,
    },
    'periodic deep recap ownership reconciliation completed',
  );
  if (repair.duplicateJobsCancelled > 0) {
    deps.logger.warn?.(
      {
        event: 'jobs.deep_recap_duplicate_owners_repaired',
        duplicateJobsCancelled: repair.duplicateJobsCancelled,
      },
      'duplicate deep recap owners were reconciled',
    );
  }
  return repair;
}

function safeRead(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

export function grantForTargetChannel(channel: {
  id: string;
  parent_id: string | null;
  visibility_class: string;
  deleted_at_ms: number | null;
  is_thread?: number;
} | undefined, parentVisibility?: VisibilityClass): RetrievalGrant {
  if (!channel || channel.deleted_at_ms !== null) {
    return { includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] };
  }
  if (channel.visibility_class === 'org') {
    return { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
  }
  if (channel.visibility_class === 'restricted') {
    // A thread shares its parent's restricted scope only when the parent is
    // itself restricted (Section 7.2). Without the parent's class, the thread
    // keeps its own, narrower anchor.
    const anchor = scopeAnchorId({ id: channel.id, isThread: channel.is_thread === 1, parentId: channel.parent_id }, parentVisibility);
    return { includeOrgMessages: false, includeOrgMemories: true, includeReviewOnly: false, channelIds: [anchor] };
  }
  // `review_only` is readable only through the separately verified, exact
  // configured secure-review channel path below.
  return { includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] };
}

/** Full read grant used only by the configured secure review channel. */
export function grantForSecureReview(
  db: DatabaseSync,
  acceptedScopes: readonly VisibilityClass[] = [],
): RetrievalGrant {
  const rows = db.prepare(
    `SELECT ${scopeAnchorSql('c')} AS anchor FROM channels c
      WHERE c.visibility_class = 'restricted' AND c.ingest_enabled = 1 AND c.deleted_at_ms IS NULL`,
  ).all() as Array<{ anchor: string }>;
  return {
    includeOrgMessages: acceptedScopes.includes('org'),
    includeOrgMemories: acceptedScopes.includes('org'),
    includeReviewOnly: acceptedScopes.includes('review_only'),
    channelIds: acceptedScopes.includes('restricted')
      ? [...new Set(rows.map((r) => r.anchor))]
      : [],
  };
}

/** Resolve the exact configured secure-review target for scheduled prompt rendering. */
export function resolveScheduledReviewScope(
  db: DatabaseSync,
  reviewChannelId: string,
  acceptedScopes: readonly VisibilityClass[] = [],
): ReviewScope {
  const targetScope = resolveCurrentChannelScope(db, reviewChannelId);
  const channel = getChannel(db, reviewChannelId);
  if (!targetScope || !channel) {
    throw new PermanentJobError(
      `scheduled review channel ${reviewChannelId} is missing or no longer available`,
    );
  }
  if (acceptedScopes.length === 0) {
    throw new PermanentJobError('scheduled review channel accepts no visibility scopes');
  }
  return {
    grant: grantForSecureReview(db, acceptedScopes),
    reviewChannelId,
    targetChannelId: reviewChannelId,
    notificationsAllowed: false,
    target: {
      label: channel.name ? `#${channel.name}` : reviewChannelId,
      // The configured secure review channel is the only audience permitted to
      // receive review_only evidence. Its ordinary persisted policy class may
      // be org/restricted, but that would understate this run's effective
      // audience and discourage the model from handling quarantined material.
      visibility: acceptedScopes.includes('review_only')
        ? 'review_only'
        : acceptedScopes.includes('restricted') ? 'restricted' : 'org',
    },
  };
}

/** Resolve an exact working target for a deliverable scheduled cohort. */
export function resolveScheduledWorkingScope(
  db: DatabaseSync,
  targetChannelId: string,
  reviewChannelId: string,
): ReviewScope {
  const current = resolveRetrievableChannelScope(db, targetChannelId);
  const channel = getChannel(db, targetChannelId);
  if (
    !current
    || !channel
    || channel.allow_interventions !== 1
    || channel.visibility_class === 'excluded'
    || isMnemeTestSurface(db, targetChannelId)
  ) {
    throw new PermanentJobError(`scheduled working target ${targetChannelId} is unavailable`);
  }
  return {
    grant: grantForTargetChannel(channel, channel.parent_id ? getChannel(db, channel.parent_id)?.visibility_class : undefined),
    reviewChannelId,
    targetChannelId,
    notificationsAllowed: true,
    target: {
      label: channel.name ? `#${channel.name}` : targetChannelId,
      visibility: current.visibility,
    },
  };
}

/** Resolve a direct-answer grant, recognizing the secure review channel by ID. */
export function grantForDirectAnswerChannel(
  db: DatabaseSync,
  channelId: string,
  reviewChannelId: string | undefined,
  reviewAcceptedScopes: readonly VisibilityClass[] = [],
): RetrievalGrant {
  const current = resolveCurrentChannelScope(db, channelId);
  if (!current) return { includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] };
  if (reviewChannelId && channelId === reviewChannelId) {
    return grantForSecureReview(db, reviewAcceptedScopes);
  }
  if (current.visibility === 'org') {
    return { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
  }
  if (current.visibility === 'restricted') {
    return { includeOrgMessages: false, includeOrgMemories: true, includeReviewOnly: false, channelIds: [current.scopeChannelId] };
  }
  return { includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] };
}

function recentChecks(
  ctx: BootstrapContext,
  channelId: string,
  content: string,
  now: number,
  kind: 'autonomous' | 'direct_answer' = 'direct_answer',
  topicKey: string | null = null,
) {
  // A civil day can be 25 hours at a DST transition. Query from the earlier of
  // the current org-day boundary and the duplicate/cooldown lookback so neither
  // daily limits nor long cooldowns silently undercount around that boundary.
  const cooldownLookbackMs = Math.max(
    24 * 60 * 60 * 1000,
    ctx.config.intervention.channelCooldownMinutes * 60_000,
    DEFAULT_COOLDOWN_CONFIG.topicCooldownHours * 3_600_000,
  );
  const sinceMs = Math.min(orgDayStartMs(now, ctx.config.organization.timezone), now - cooldownLookbackMs);
  const sent = ctx.db.prepare(
    `SELECT o.channel_id, o.content, o.sent_at_ms, o.proposal_id, p.topic_key
       FROM outbox o
       LEFT JOIN proposals p ON p.id = o.proposal_id
      WHERE o.status = 'sent' AND o.sent_at_ms IS NOT NULL AND o.sent_at_ms >= ?
      ORDER BY o.sent_at_ms DESC LIMIT 100`,
  ).all(sinceMs) as Array<{
    channel_id: string;
    content: string;
    sent_at_ms: number;
    proposal_id: string | null;
    topic_key: string | null;
  }>;
  const history = sent.map((r) => ({ channelId: r.channel_id, topicKey: r.topic_key,
    kind: r.proposal_id ? 'autonomous' as const : 'direct_answer' as const, sentAtMs: r.sent_at_ms }));
  return {
    cooldown: evaluateCooldowns(
      { ...DEFAULT_COOLDOWN_CONFIG, channelCooldownMinutes: ctx.config.intervention.channelCooldownMinutes,
        globalDailyLimit: ctx.config.intervention.globalDailyLimit, timeZone: ctx.config.organization.timezone },
      now,
      history,
      { channelId, topicKey, kind },
    ),
    duplicate: detectDuplicate({
      content,
      now,
      // The host-owned scheduled footer is constant boilerplate; strip it so it
      // cannot inflate similarity between otherwise-distinct notifications.
      recentMessages: sent.filter((r) => r.channel_id === channelId).map((r) => ({ content: stripScheduledFooter(r.content), sentAtMs: r.sent_at_ms, source: 'outbox' as const })),
    }),
  };
}

type CurrentReviewProvenance =
  | { outcome: 'resolved'; entries: ProvenanceScopeEntry[] }
  | { outcome: 'reject'; gate: ProvenanceGateResult };

/**
 * Resolve human-reviewed run provenance against current durable state.
 *
 * Memory scopes stored on the run describe what was visible when retrieval
 * happened, but they are only a cache. Every exact exposed memory is resolved
 * again from its current evidence before proposal creation and approval. A
 * legacy or malformed record that claims memory-scope exposure without naming
 * the exact rows cannot be revalidated and therefore fails closed.
 */
function resolveCurrentReviewProvenance(
  db: DatabaseSync,
  provenance: AgentRunResult['provenance'],
  guildId: string,
): CurrentReviewProvenance {
  const rawStoredMemoryScopes = (provenance as { memoryScopes?: unknown }).memoryScopes;
  if (!Array.isArray(rawStoredMemoryScopes)) {
    return {
      outcome: 'reject',
      gate: {
        outcome: 'reject',
        reasons: ['memory provenance is malformed'],
      },
    };
  }
  const storedMemoryScopes = rawStoredMemoryScopes;
  const rawMemoryIds = (provenance as { memoryIds?: unknown }).memoryIds;
  const hasStoredMemoryScopes = storedMemoryScopes.length > 0;

  if (!Array.isArray(rawMemoryIds)) {
    if (hasStoredMemoryScopes || rawMemoryIds !== undefined) {
      return {
        outcome: 'reject',
        gate: {
          outcome: 'reject',
          reasons: ['memory provenance does not contain valid exposed row identifiers'],
        },
      };
    }
  } else if (rawMemoryIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    return {
      outcome: 'reject',
      gate: {
        outcome: 'reject',
        reasons: ['memory provenance does not contain valid exposed row identifiers'],
      },
    };
  }

  const memoryIds = Array.isArray(rawMemoryIds)
    ? [...new Set(rawMemoryIds as string[])]
    : [];
  if (hasStoredMemoryScopes && memoryIds.length === 0) {
    return {
      outcome: 'reject',
      gate: {
        outcome: 'reject',
        reasons: ['memory provenance does not identify its exposed rows'],
      },
    };
  }

  const currentScopes = recomputeMemoryScopes(db, memoryIds);
  const memoryScopes: AgentRunResult['provenance']['memoryScopes'] = [];
  for (const memoryId of memoryIds) {
    const memory = getMemory(db, memoryId);
    if (!memory || memory.workspace_id !== guildId) {
      return {
        outcome: 'reject',
        gate: {
          outcome: 'reject',
          reasons: ['an exposed memory is no longer available'],
        },
      };
    }
    const scope = currentScopes.get(memoryId);
    if (!scope) {
      return {
        outcome: 'reject',
        gate: {
          outcome: 'reject',
          reasons: ['an exposed memory scope can no longer be resolved'],
        },
      };
    }
    memoryScopes.push({
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      source: 'memory_search',
    });
  }

  return {
    outcome: 'resolved',
    entries: resolveProvenanceScopes({
      ...provenance,
      // Never trust the retrieval-time cache when exact memory rows exist.
      memoryScopes,
      memoryIds,
    }, {
      channelVisibility: (id) => resolveRetrievableChannelScope(db, id)?.visibility,
      channelScopeId: (id) => resolveRetrievableChannelScope(db, id)?.scopeChannelId,
    }),
  };
}

export function buildApprovalRecheck(
  ctx: BootstrapContext,
  proposalId: string,
  now = ctx.now(),
  scheduledRouteOptions?: ScheduledRouteOptions,
): ApprovalPolicyRecheck {
  const proposal = getProposal(ctx.db, proposalId);
  if (!proposal) {
    return { provenance: { outcome: 'reject', reasons: ['proposal not found'] },
      outboundEvidence: { outcome: 'reject', reasons: ['proposal not found'] },
      cooldown: { allowed: false, blocks: [], retryAfterMs: null }, duplicate: { matched: false } };
  }
  const currentTarget = resolveCurrentChannelScope(ctx.db, proposal.targetChannelId);
  const target = { channelId: proposal.targetChannelId,
    scopeChannelId: currentTarget?.scopeChannelId ?? proposal.targetChannelId,
    visibility: currentTarget?.visibility ?? 'excluded',
    isSecureReview: proposal.targetChannelId === ctx.config.reviewChannelId };
  const evidenceMessageIds = [...new Set(proposal.evidenceMessageIds)];
  // Attention ownership: the SAME proposal must own its revision claim inside
  // the immutable window (Section 12.7). Recomputed under the approval write
  // lock by the closure below.
  const attention = validateProposalAttention(ctx.db, proposalId, now);
  let provenance: ApprovalPolicyRecheck['provenance'];
  let runType: string | undefined;
  let runGuildId: string | undefined;
  try {
    const run = ctx.db.prepare('SELECT run_type, workspace_id, retrieval_provenance_json FROM agent_runs WHERE id = ?').get(proposal.runId) as
      | { run_type: string; workspace_id: string; retrieval_provenance_json: string }
      | undefined;
    if (!run) throw new Error('originating run not found');
    runType = run.run_type;
    runGuildId = run.workspace_id;
    const parsed = JSON.parse(run.retrieval_provenance_json) as AgentRunResult['provenance'];
    if (!parsed || !Array.isArray(parsed.channels) || !Array.isArray(parsed.memoryScopes)) {
      throw new Error('originating run provenance is malformed');
    }
    const currentResolution = resolveCurrentReviewProvenance(ctx.db, parsed, run.workspace_id);
    const currentProvenance = currentResolution.outcome === 'reject'
      ? currentResolution.gate
      : evaluateProvenanceGate({
          pinnedTargetChannelId: proposal.targetChannelId,
          proposedTargetChannelId: proposal.targetChannelId,
          target,
          provenance: currentResolution.entries,
        });
    const runMessageIds = new Set(
      Array.isArray(parsed.messageIds)
        ? parsed.messageIds.filter((id): id is string => typeof id === 'string')
        : [],
    );
    const reviewRunLabel = runType === 'scheduled_review'
      ? 'scheduled'
      : runType === 'episode'
        ? 'episode'
        : undefined;
    if (reviewRunLabel && evidenceMessageIds.some((id) => !runMessageIds.has(id))) {
      provenance = {
        outcome: 'reject',
        reasons: [...currentProvenance.reasons,
          `${reviewRunLabel} proposal cites evidence not exposed by the originating run`],
      };
    } else {
      provenance = currentProvenance;
    }
  } catch (err) {
    provenance = { outcome: 'reject', reasons: [err instanceof Error ? err.message : 'run provenance unavailable'] };
  }
  const scheduledSubjects = runType === 'scheduled_review'
    ? getScheduledProposalSubjects(ctx.db, proposal.id)
    : [];
  let outboundEvidence: ApprovalPolicyRecheck['outboundEvidence'] = validateOutboundEvidence({ target, citedMessageIds: evidenceMessageIds,
    referencedMemoryIds: scheduledSubjects.map((subject) => subject.memoryId),
    requireInterventionsEnabled: true,
  }, {
    resolveMessage: (id) => { const m = getMessage(ctx.db, id); if (!m) return undefined;
      if ((runGuildId !== undefined && m.workspace_id !== runGuildId) || isMnemeTestSurface(ctx.db, m.channel_id)) {
        return undefined;
      }
      const scope = resolveRetrievableChannelScope(ctx.db, m.channel_id);
      return scope ? { channelId: m.channel_id, scopeChannelId: scope.scopeChannelId,
        visibility: scope.visibility, deletedAtMs: m.deleted_at_ms } : undefined; },
    resolveMemoryScope: (id) => { const m = getMemory(ctx.db, id); return m ? { scopeType: m.scope_type, scopeKey: m.scope_key } : undefined; },
    resolveChannel: (id) => { const c = getChannel(ctx.db, id); if (!c) return undefined;
      const scope = resolveCurrentChannelScope(ctx.db, id); return { visibility: scope?.visibility ?? 'excluded',
      allowInterventions: c.allow_interventions === 1, deletedAtMs: c.deleted_at_ms }; },
  });
  if (runType === 'scheduled_review') {
    const durableMessage = proposal.message;
    const textSafetyReasons: string[] = [];
    if (typeof durableMessage !== 'string' || durableMessage.trim().length === 0) {
      textSafetyReasons.push('proposal has no sendable message text');
    } else {
      // Episode proposals may already contain host-built source links in their
      // assembled durable text. Scheduled notifications store marker text —
      // links are substituted at delivery — so re-run the full
      // model-authored-text sanitizer here without changing episode logic.
      const sanitized = sanitizeOutboundMessage({ content: durableMessage, guildId: null, format: ctx.format });
      if (sanitized.outcome === 'reject') {
        textSafetyReasons.push(...sanitized.reasons);
      }
    }
    if (textSafetyReasons.length > 0) {
      outboundEvidence = {
        outcome: 'reject',
        reasons: [...outboundEvidence.reasons, ...textSafetyReasons],
      };
    }
  }
  const rate = recentChecks(
    ctx,
    proposal.targetChannelId,
    proposal.message ?? '',
    now,
    'autonomous',
    proposal.topicKey,
  );
  // Route validation plus delivery rendering: approval must ship the exact
  // assembled text the card showed, and a render failure (evidence no longer
  // resolvable to links) blocks delivery the same way route drift does.
  const checkScheduledDelivery = (): ScheduledDeliveryCheck | undefined => {
    // `runGuildId` is always set here: runType comes from the same run row.
    if (runType !== 'scheduled_review' || !scheduledRouteOptions || runGuildId === undefined) return undefined;
    const check = validateScheduledProposalDelivery(ctx.db, proposal.id, scheduledRouteOptions, now);
    if (!check.allow) return check;
    const rendered = renderScheduledNotificationDelivery(ctx.db, runGuildId, proposal);
    if (rendered.outcome === 'reject') {
      return { ...check, allow: false, reasons: rendered.reasons };
    }
    return { ...check, deliveryContent: rendered.content };
  };
  const scheduledDelivery = checkScheduledDelivery();
  return {
    provenance,
    outboundEvidence,
    cooldown: rate.cooldown,
    duplicate: rate.duplicate,
    scheduledReminderIntervalMs: ctx.config.memory?.scheduledReviewReminderDays
      ? ctx.config.memory.scheduledReviewReminderDays * 86_400_000
      : DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
    scheduledDelivery,
    revalidateScheduledDelivery: scheduledDelivery
      ? () => checkScheduledDelivery() ?? { allow: true, reasons: [] }
      : undefined,
    attention,
    revalidateAttention: attention.attention
      ? () => validateProposalAttention(ctx.db, proposalId, now)
      : undefined,
  };
}

/** Build the reviewer-facing scheduled proposal from durable, current host data. */
export function buildScheduledReviewPresentation(
  db: DatabaseSync,
  guildId: string,
  proposal: ProposalRow,
): ReviewProposalInput {
  const targetChannel = getChannel(db, proposal.targetChannelId);
  // The card quotes the exact assembled delivery text — inline links and
  // footer included — so approval queues precisely what the reviewer read.
  // A failed render (evidence gone since composition) falls back to the
  // durable marker text; approval re-renders and blocks in that case.
  const rendered = renderScheduledNotificationDelivery(db, guildId, proposal);

  return {
    proposalId: proposal.id,
    targetLabel: targetChannel?.name ? `#${targetChannel.name}` : `<#${proposal.targetChannelId}>`,
    score: proposal.computedScore,
    assessment: 'Recommended scheduled review',
    reason: proposal.reason,
    recommendationReason: proposal.reviewReason ?? undefined,
    proposedMessage: rendered.outcome === 'allow' ? rendered.content : (proposal.message ?? ''),
    sources: [],
    expiresAtMs: proposal.expiresAtMs,
  };
}

/**
 * Resolve the attention admission of one episode intervention (Section 12.7).
 * The subject is resolved through the accepted memory-outcome mapping — never a
 * model-guessed UUID — and the trigger evidence must be episode or follow-up
 * material that the run exposed. The revision is registered idempotently; the
 * claim happens later, inside the proposal-persistence transaction.
 */
function computeEpisodeAttentionAdmission(
  ctx: BootstrapContext,
  input: {
    intervention: NonNullable<Parameters<NonNullable<Parameters<typeof createReviewEpisodeHandler>[0]['routeIntervention']>>[0]['proposal']['intervention']>;
    memoryOutcome: ApplyMemoryProposalsResult;
    /** The bot's own user id on the platform. */
    selfUserId: string;
    episodeMessageIds: ReadonlySet<string>;
    exposedMessageIds: ReadonlySet<string>;
    exposedMemoryIds: ReadonlySet<string>;
    now: number;
  },
): AttentionRoutingInput {
  const windowMs = ctx.config.intervention.attentionWindowDays * 86_400_000;
  const intervention = input.intervention;
  if (intervention?.recommend !== true) {
    // Attention is only consulted for recommendations; silence needs no gate.
    return { required: false, eligible: true };
  }

  const fail = (reason: AttentionRejectionReason): AttentionRoutingInput => ({
    required: true, eligible: false, reason,
  });

  // Subject: an existing memory the run exposed, or an accepted proposal index.
  const subject = intervention.subject;
  let subjectMemoryId: string | undefined;
  if (subject?.kind === 'existing_memory' && typeof subject.memoryId === 'string') {
    const memory = getMemory(ctx.db, subject.memoryId);
    if (
      !memory
      || memory.workspace_id !== ctx.config.workspaceId
      || (!input.exposedMemoryIds.has(subject.memoryId)
        && !input.memoryOutcome.applied.some((o) => o.memoryId === subject.memoryId))
    ) {
      return fail('attention_authority_missing');
    }
    subjectMemoryId = subject.memoryId;
  } else if (subject?.kind === 'memory_proposal' && typeof subject.proposalIndex === 'number') {
    const applied = input.memoryOutcome.applied.find(
      (o) => o.index === subject.proposalIndex && o.accepted && typeof o.memoryId === 'string',
    );
    if (!applied?.memoryId) return fail('attention_authority_missing');
    subjectMemoryId = applied.memoryId;
  } else {
    return fail('attention_authority_missing');
  }

  const trigger = intervention.trigger;
  if (!trigger || trigger.kind === 'none') {
    return fail('no_recent_human_trigger');
  }

  const subjectId = ensureSubjectForMember(ctx.db, {
    guildId: ctx.config.workspaceId, memoryId: subjectMemoryId, now: input.now,
  });

  if (trigger.kind === 'human_deadline') {
    // The model cannot know host-assigned revision ids in an episode run, so
    // the host resolves the subject's due-deadline revision itself; a model
    // echo, when present, must still name a revision of this subject.
    const echoed = typeof trigger.revisionId === 'string' ? getRevision(ctx.db, trigger.revisionId) : null;
    if (echoed !== null && echoed.subjectId !== subjectId) {
      return fail('attention_authority_missing');
    }
    const revision = echoed ?? listSubjectRevisions(ctx.db, subjectId).find((candidate) => {
      if (candidate.state !== 'current' || candidate.explicitDeadlineAtMs === null) return false;
      if (getClaim(ctx.db, candidate.id) !== null) return false;
      return candidate.explicitDeadlineAtMs <= input.now
        && input.now <= candidate.explicitDeadlineAtMs + windowMs;
    }) ?? null;
    if (!revision) {
      return fail('deadline_unverified');
    }
    if (!validateRevisionEvidence(ctx.db, revision.id, input.now)) return fail('trigger_changed');
    const verdict = evaluateRevisionAdmission(
      {
        revisionId: revision.id, subjectId: revision.subjectId, state: revision.state,
        humanEventAtMs: revision.humanEventAtMs, explicitDeadlineAtMs: revision.explicitDeadlineAtMs,
      },
      getClaim(ctx.db, revision.id),
      input.now,
      windowMs,
    );
    if (!verdict.eligible) return fail(verdict.reason);
    return {
      required: true, eligible: true, revisionId: revision.id,
      windowFromMs: verdict.window.fromMs, windowUntilMs: verdict.window.untilMs,
    };
  }

  if (trigger.kind !== 'new_human_evidence' || !Array.isArray(trigger.evidence)) {
    return fail('no_recent_human_trigger');
  }
  const evidence = trigger.evidence.filter(
    (item): item is { messageId: string; quote: string } =>
      typeof item?.messageId === 'string' && typeof item?.quote === 'string',
  );
  if (evidence.length === 0) return fail('no_recent_human_trigger');
  // A recent message is a candidate, not proof of relevance: the trigger must
  // be episode or follow-up material, never merely retrieved background.
  for (const item of evidence) {
    if (!input.episodeMessageIds.has(item.messageId) || !input.exposedMessageIds.has(item.messageId)) {
      return fail('unrelated_trigger');
    }
  }
  const validation = validateTriggerEvidence(ctx.db, {
    guildId: ctx.config.workspaceId,
    mnemeId: input.selfUserId,
    evidence,
    now: input.now,
    windowMs,
  });
  if (!validation.ok) return fail(validation.reason);

  const messageIds = validation.records.map((record) => record.messageId);
  const covered = findConsumedTriggerMessageIds(ctx.db, ctx.config.workspaceId, messageIds);
  const fresh = validation.records.filter((record) => !covered.has(record.messageId));
  if (fresh.length === 0) return fail('revision_consumed');
  const frontier = getSubjectConsumedFrontier(ctx.db, subjectId);
  const newest = fresh.reduce((acc, record) => (record.createdAtMs > acc.createdAtMs ? record : acc));
  if (!isNewerThanFrontier({ createdAtMs: newest.createdAtMs, messageId: newest.messageId }, frontier)) {
    return fail('revision_consumed');
  }

  const { revisionId } = registerRevision(ctx.db, {
    subjectId,
    triggers: fresh,
    now: input.now,
  });
  const revision = getRevision(ctx.db, revisionId)!;
  if (!validateRevisionEvidence(ctx.db, revisionId, input.now)) return fail('trigger_changed');
  const verdict = evaluateRevisionAdmission(
    {
      revisionId: revision.id, subjectId: revision.subjectId, state: revision.state,
      humanEventAtMs: revision.humanEventAtMs, explicitDeadlineAtMs: revision.explicitDeadlineAtMs,
    },
    getClaim(ctx.db, revision.id),
    input.now,
    windowMs,
  );
  if (!verdict.eligible) return fail(verdict.reason);
  return {
    required: true, eligible: true, revisionId,
    windowFromMs: verdict.window.fromMs, windowUntilMs: verdict.window.untilMs,
  };
}

/** Discord hard cap for one plain message; an assembled intervention must fit it. */
const EPISODE_INTERVENTION_MAX_CHARS = 2000;

/** The prompt contract allows one to three inline citation markers; more reject. */
const MAX_EPISODE_CITATION_MARKERS = 3;

export type EpisodeInterventionAssembly =
  | { outcome: 'allow'; content: string }
  | { outcome: 'reject'; reasons: string[] };

/**
 * Assemble the deliverable episode intervention from sanitized content and its
 * host-built links (Section 24.5). Inline `[[cite:<id>]]` markers become masked
 * links; validated links no marker consumed become one trailing `Sources:`
 * line, which keeps markerless legacy proposals deliverable. Pure; rejects on
 * an invalid marker or when the assembled text cannot fit one Discord message.
 */
export function assembleEpisodeIntervention(
  content: string,
  links: readonly MessageLink[],
): EpisodeInterventionAssembly {
  const inline = renderInlineCitations(content, links);
  if (inline.outcome === 'reject') return { outcome: 'reject', reasons: inline.reasons };
  if (inline.markerCount > MAX_EPISODE_CITATION_MARKERS) {
    return {
      outcome: 'reject',
      reasons: ['message uses more than three inline citation markers'],
    };
  }
  const parts = [inline.content];
  if (inline.unusedLinks.length > 0) {
    parts.push(`Sources: ${inline.unusedLinks.map((link) => link.masked).join(' · ')}`);
  }
  const assembled = parts.join('\n\n');
  if (assembled.length > EPISODE_INTERVENTION_MAX_CHARS) {
    return {
      outcome: 'reject',
      reasons: ['intervention leaves insufficient room for validated source links'],
    };
  }
  return { outcome: 'allow', content: assembled };
}

/**
 * The review card quotes the exact assembled intervention — inline links and
 * the compact `Sources:` line included — so approval queues precisely what the
 * reviewer read (Section 25). Sources stay empty because every validated link
 * already sits inline in the quoted text.
 */
export function episodeReviewPresentation(assembled: string): { proposedMessage: string; sources: [] } {
  return { proposedMessage: assembled, sources: [] };
}

export async function routeEpisodeIntervention(
  ctx: BootstrapContext,
  platform: Pick<ChatPlatform, 'deliverProposalReview' | 'selfUserId'>,
  secret: string,
  input: Parameters<NonNullable<Parameters<typeof createReviewEpisodeHandler>[0]['routeIntervention']>>[0],
): Promise<string | undefined> {
  // Historical reconstruction exists to build memory, never to interrupt an
  // old conversation or create a review-channel posting proposal.
  if (input.episode.origin === 'historical') return undefined;
  const intervention = input.proposal.intervention;
  if (!intervention?.dimensions || !intervention.targetChannelId) return undefined;
  const targetRow = getChannel(ctx.db, input.episode.conversation_channel_id);
  const currentTarget = resolveCurrentChannelScope(ctx.db, input.episode.conversation_channel_id);
  const target = {
    channelId: input.episode.conversation_channel_id,
    scopeChannelId: currentTarget?.scopeChannelId ?? input.episode.conversation_channel_id,
    visibility: currentTarget?.visibility ?? 'excluded',
    isSecureReview: input.episode.conversation_channel_id === ctx.config.reviewChannelId,
  };
  const message = intervention.message ?? '';
  const evidenceIds = [...new Set(intervention.evidenceMessageIds ?? [])];
  const resolveCurrentEvidenceMessage = (id: string) => {
    const stored = getMessage(ctx.db, id);
    if (
      !stored
      || stored.workspace_id !== ctx.config.workspaceId
      || isMnemeTestSurface(ctx.db, stored.channel_id)
    ) return undefined;
    const scope = resolveRetrievableChannelScope(ctx.db, stored.channel_id);
    return scope ? { stored, scope } : undefined;
  };
  const sanitized = sanitizeOutboundMessage({ content: message, sourceLinkMessageIds: evidenceIds,
    guildId: ctx.config.workspaceId, format: ctx.format }, {
    resolveChannelId: (id) => resolveCurrentEvidenceMessage(id)?.stored.channel_id,
    resolveLabel: (id) => {
      const current = resolveCurrentEvidenceMessage(id);
      if (!current) return undefined;
      const channelLabel = sourceLinkChannelLabel(ctx.db, current.stored.channel_id);
      return `${channelLabel} · ${new Date(current.stored.created_at_ms).toISOString().slice(0, 10)}`;
    },
  });
  // Citations render only after the sanitizer allowed the raw content; an
  // unknown or malformed marker, or an assembled overflow, is an
  // outbound-safety rejection exactly like a sanitizer rejection.
  const assembly = sanitized.outcome === 'allow'
    ? assembleEpisodeIntervention(sanitized.content, sanitized.sourceLinks)
    : null;
  const outboundSafety = sanitized.outcome === 'reject'
    ? { outcome: 'reject' as const, reasons: sanitized.reasons }
    : assembly !== null && assembly.outcome === 'reject'
      ? { outcome: 'reject' as const, reasons: assembly.reasons }
      : { outcome: 'allow' as const, reasons: [] as string[] };
  const currentResolution = resolveCurrentReviewProvenance(
    ctx.db,
    input.result.provenance,
    ctx.config.workspaceId,
  );
  const provenanceEntries = currentResolution.outcome === 'resolved'
    ? currentResolution.entries
    : [];
  const currentProvenanceGate = currentResolution.outcome === 'reject'
    ? currentResolution.gate
    : evaluateProvenanceGate({ pinnedTargetChannelId: input.episode.conversation_channel_id,
        proposedTargetChannelId: intervention.targetChannelId, target, provenance: provenanceEntries });
  const exposedMessageIds = new Set(
    Array.isArray(input.result.provenance.messageIds)
      ? input.result.provenance.messageIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const provenanceGate = evidenceIds.some((id) => !exposedMessageIds.has(id))
    ? {
        outcome: 'reject' as const,
        reasons: ['episode proposal cites evidence not exposed by the originating run'],
      }
    : currentProvenanceGate;
  const outboundEvidence = validateOutboundEvidence({ target, citedMessageIds: evidenceIds, referencedMemoryIds: [],
    replyToMessageId: intervention.replyToMessageId }, {
    resolveMessage: (id) => {
      const current = resolveCurrentEvidenceMessage(id); if (!current) return undefined;
      return { channelId: current.stored.channel_id, scopeChannelId: current.scope.scopeChannelId,
        visibility: current.scope.visibility, deletedAtMs: current.stored.deleted_at_ms };
    },
    resolveMemoryScope: (id) => { const m = getMemory(ctx.db, id); return m ? { scopeType: m.scope_type, scopeKey: m.scope_key } : undefined; },
    resolveChannel: (id) => { const c = getChannel(ctx.db, id); if (!c) return undefined;
      const scope = resolveCurrentChannelScope(ctx.db, id); return { visibility: scope?.visibility ?? 'excluded',
      allowInterventions: c.allow_interventions === 1, deletedAtMs: c.deleted_at_ms }; },
  });
  const restrictedChannels = new Set(provenanceEntries.filter((p) => p.visibility === 'restricted').map((p) => p.channelId).filter(Boolean));
  const forcedReview = evaluateForcedReview({ message, format: ctx.format, reason: intervention.reason, urgency: intervention.urgency ?? 'normal',
    evidenceStrength: intervention.dimensions.evidenceStrength, distinctRestrictedChannelCount: restrictedChannels.size,
    uncertain: provenanceGate.outcome === 'force_review' || outboundEvidence.outcome === 'force_review' });
  const rate = recentChecks(ctx, target.channelId, message, input.now, 'autonomous');
  // Conversation settle, rechecked against the target channel now that the model
  // run has finished (Section 11.8). The run takes long enough for the channel
  // to come back to life while it is in flight.
  const liveness = evaluateSettle({
    lastHumanAtMs: lastHumanMessageAtMs(ctx.db, target.channelId, platform.selfUserId),
    episodeClosedAtMs: input.episode.ended_at_ms ?? input.episode.last_activity_at_ms,
    now: input.now,
    config: {
      settleSeconds: ctx.config.episodes.settleSeconds,
      settleMaxMinutes: ctx.config.episodes.settleMaxMinutes,
    },
  });
  const attention = computeEpisodeAttentionAdmission(ctx, {
    intervention,
    memoryOutcome: input.memoryOutcome,
    selfUserId: platform.selfUserId,
    episodeMessageIds: input.episodeMessageIds,
    exposedMessageIds,
    exposedMemoryIds: new Set(input.result.provenance.memoryIds ?? []),
    now: input.now,
  });
  const routingInput = { mode: ctx.config.mode,
    thresholds: { score: ctx.config.intervention.threshold, confidence: ctx.config.intervention.minConfidence,
      evidenceStrength: ctx.config.intervention.minEvidenceStrength, maxContentLength: ctx.config.intervention.maxMessageCharacters },
    eligibility: { recommend: intervention.recommend === true, dimensions: intervention.dimensions,
      confidence: intervention.confidence ?? 0, evidenceStrength: intervention.dimensions.evidenceStrength,
      evidenceCount: evidenceIds.length, contentLength: message.length, hasDisallowedMention: outboundSafety.outcome === 'reject' },
    provenanceGate, outboundEvidence, forcedReview, cooldown: rate.cooldown, duplicate: rate.duplicate,
    attention, liveness: { settled: liveness.settled, idleMs: liveness.idleMs } };
  const routing = routeProposal(routingInput);
  const policyDecision = buildEpisodePolicyDecision(routingInput, routing, outboundSafety);
  // The eligibility flag that carries outbound-safety failures renders as a
  // disallowed-mention line; the specific sanitizer/citation/overflow reasons
  // ride along so a stored row names its real cause.
  const storedReasons = outboundSafety.outcome === 'reject'
    ? [...routing.reasons, ...outboundSafety.reasons]
    : routing.reasons;
  const assembled = assembly !== null && assembly.outcome === 'allow' ? assembly.content : null;
  // The proposal deadline is the earlier of the ordinary 72-hour window and
  // the immutable attention window end (Section 12.7).
  const ordinaryExpiry = input.now + 72 * 60 * 60 * 1000;
  const expiresAtMs = routing.state === 'pending_review'
    ? (attention.windowUntilMs !== undefined ? Math.min(ordinaryExpiry, attention.windowUntilMs) : ordinaryExpiry)
    : null;
  let proposalId = '';
  let claimLost = false;
  if (routing.state === 'approved' && assembled) {
    transactionImmediate(ctx.db, () => {
      proposalId = insertProposal(ctx.db, { runId: input.result.runId, episodeId: input.episode.id,
        targetChannelId: target.channelId, status: routing.state, computedScore: routing.score, reason: storedReasons,
        policyDecision,
        message: assembled, evidenceMessageIds: evidenceIds, replyToMessageId: intervention.replyToMessageId,
        expiresAtMs, now: input.now });
      // Claim the eligible revision atomically with the proposal it authorizes.
      // A lost race downgrades this row to observed inside the same
      // transaction: two attempts can never both own one revision.
      if (attention.revisionId && !claimRevision(ctx.db, {
        revisionId: attention.revisionId, proposalId, consumedAtMs: input.now,
        eligibleFromMs: attention.windowFromMs ?? input.now,
        eligibleUntilMs: attention.windowUntilMs ?? input.now,
      })) {
        claimLost = true;
        ctx.db.prepare(
          `UPDATE proposals SET status = 'observed', updated_at_ms = ?,
             reason = 'attention gate (revision_consumed): the revision was claimed concurrently'
           WHERE id = ?`,
        ).run(input.now, proposalId);
        return;
      }
      enqueueOutbox(ctx.db, { proposalId, runId: input.result.runId, channelId: target.channelId,
        content: assembled, replyToMessageId: intervention.replyToMessageId, now: input.now });
    });
  } else if (routing.state === 'pending_review') {
    transactionImmediate(ctx.db, () => {
      proposalId = insertProposal(ctx.db, { runId: input.result.runId, episodeId: input.episode.id,
        targetChannelId: target.channelId, status: routing.state, computedScore: routing.score, reason: storedReasons,
        policyDecision,
        message: assembled, evidenceMessageIds: evidenceIds, replyToMessageId: intervention.replyToMessageId,
        expiresAtMs, now: input.now });
      if (attention.revisionId && !claimRevision(ctx.db, {
        revisionId: attention.revisionId, proposalId, consumedAtMs: input.now,
        eligibleFromMs: attention.windowFromMs ?? input.now,
        eligibleUntilMs: attention.windowUntilMs ?? input.now,
      })) {
        claimLost = true;
        ctx.db.prepare(
          `UPDATE proposals SET status = 'observed', updated_at_ms = ?,
             reason = 'attention gate (revision_consumed): the revision was claimed concurrently'
           WHERE id = ?`,
        ).run(input.now, proposalId);
      }
    });
  } else {
    proposalId = insertProposal(ctx.db, { runId: input.result.runId, episodeId: input.episode.id,
      targetChannelId: target.channelId, status: routing.state, computedScore: routing.score, reason: storedReasons,
      policyDecision,
      message: assembled, evidenceMessageIds: evidenceIds, replyToMessageId: intervention.replyToMessageId,
      expiresAtMs, now: input.now });
  }
  if (routing.state === 'approved' && assembled) {
    // The proposal and outbox are already durable in one transaction.
  } else if (routing.state === 'pending_review' && !claimLost && assembled && ctx.config.reviewChannelId) {
    const presentation = episodeReviewPresentation(assembled);
    try {
      await platform.deliverProposalReview({ proposalId, targetLabel: targetRow?.name ? `#${targetRow.name}` : target.channelId,
        score: routing.score, reason: routing.reasons.join('; '), proposedMessage: presentation.proposedMessage,
        sources: presentation.sources, expiresAtMs },
      { db: ctx.db, reviewChannelId: ctx.config.reviewChannelId, secret, now: input.now });
    } catch (err) {
      ctx.logger.warn({ event: 'proposal.review_delivery_failed', proposalId,
        err: err instanceof Error ? err.message : String(err) }, 'proposal remains pending and visible to admin commands');
    }
  }
  return proposalId;
}

/** Compose and start every durable production job handler and periodic schedule. */
export async function createProductionJobRuntime(
  ctx: BootstrapContext,
  wiring: PlatformWiring,
): Promise<JobRuntimeWiring> {
  const platform = wiring.platform;
  if (!platform) throw new Error('production job runtime requires a connected chat platform');
  const snapshot = () => ctx.configStore?.get() ?? ctx.snapshot!;
  const fetcher = platform.history;
  const ingestOptions = (now: number) => ({
    guildId: ctx.config.workspaceId,
    storeRawJson: ctx.config.ingestion.storeRawJson,
    retainEditHistory: ctx.config.ingestion.retainEditHistory,
    retainDeletedContent: ctx.config.ingestion.retainDeletedContent,
    attachmentMode: ctx.config.ingestion.attachmentMode,
    attachmentArchive: ctx.config.ingestion.attachmentMode === 'archive' || ctx.config.ingestion.attachmentMode === 'selective' ? {
      mode: ctx.config.ingestion.attachmentMode,
      maxBytes: ctx.config.ingestion.attachmentMaxBytes,
      mimeAllowlist: ctx.config.ingestion.attachmentMimeAllowlist,
      dataDir: ctx.config.dataDir,
    } : undefined,
    now,
  });
  const repair = repairDurableWork(ctx.db, {
    now: ctx.now(),
    quietSeconds: ctx.config.episodes.quietSeconds,
    fullHistory: ctx.config.ingestion.fullHistory,
    scheduledRouteOptions: ctx.config.reviewChannelId ? {
      guildId: ctx.config.workspaceId,
      reviewChannelId: ctx.config.reviewChannelId,
      reviewAcceptedScopes: snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
    } : undefined,
  });
  ctx.logger.info({ event: 'jobs.startup_repair', ...repair }, 'durable work repaired before worker startup');

  // Attention cutover runs before interactions and workers begin: pending
  // legacy cards cannot be approved after the cutover, and crash recovery for
  // uncertain sends runs later in this startup. No Discord or model I/O here.
  const attentionCutover: AttentionCutoverReport = runAttentionCutover(ctx.db, {
    now: ctx.now(),
    guildId: ctx.config.workspaceId,
    actorUserId: platform.selfUserId,
    attentionWindowMs: ctx.config.intervention.attentionWindowDays * 86_400_000,
  });
  ctx.logger.info(
    { event: 'attention.cutover', ...attentionCutover },
    'proactive attention cutover completed',
  );

  const models = builtinModels();
  const resolved = resolveAgentModels({
    providerId: ctx.config.llm.provider,
    primaryModelId: ctx.config.llm.model,
    triageModelId: ctx.config.llm.triageModel ?? null,
    baseUrl: ctx.config.llm.baseUrl ?? null,
    dailyBudgetUsd: ctx.config.llm.dailyBudgetUsd ?? null,
    thinkingLevel: ctx.config.agentRuntime.thinkingLevel,
  }, defaultModelLookup(models));
  const agent = {
    model: resolved.primary.model,
    thinkingLevel: ctx.config.agentRuntime.thinkingLevel,
    streamFn: models.streamSimple.bind(models),
    providerId: resolved.providerId,
    modelId: resolved.primary.model.id,
  };
  const shadowResolved = ctx.config.episodeShadow.enabled ? resolveAgentModels({
    providerId: ctx.config.llm.provider,
    primaryModelId: ctx.config.episodeShadow.model ?? ctx.config.llm.model,
    triageModelId: null,
    baseUrl: ctx.config.llm.baseUrl ?? null,
    dailyBudgetUsd: ctx.config.llm.dailyBudgetUsd ?? null,
    thinkingLevel: ctx.config.episodeShadow.thinkingLevel,
  }, defaultModelLookup(models)) : undefined;
  const episodeShadow = {
    ...ctx.config.episodeShadow,
    agent: shadowResolved ? {
      model: shadowResolved.primary.model,
      thinkingLevel: ctx.config.episodeShadow.thinkingLevel,
      streamFn: models.streamSimple.bind(models),
      providerId: shadowResolved.providerId,
      modelId: shadowResolved.primary.model.id,
    } : undefined,
  };
  const campaignConfig = ctx.config.historicalMemory.campaignId ? {
    id: ctx.config.historicalMemory.campaignId,
    guildId: ctx.config.workspaceId,
    direction: ctx.config.historicalMemory.direction,
    fromAtMs: ctx.config.historicalMemory.fromAtMs!,
    toAtMs: ctx.config.historicalMemory.toAtMs!,
    provider: ctx.config.llm.provider,
    model: ctx.config.historicalMemory.model!,
    thinkingLevel: ctx.config.historicalMemory.thinkingLevel,
    channelIds: ctx.config.historicalMemory.channelIds,
    dailyBudgetUsd: ctx.config.historicalMemory.dailyBudgetUsd,
    totalBudgetUsd: ctx.config.historicalMemory.totalBudgetUsd,
  } as const : undefined;
  const campaign = campaignConfig
    ? ensureHistoricalCampaign(ctx.db, campaignConfig, ctx.now())
    : undefined;
  const historicalResolved = campaignConfig ? resolveAgentModels({
    providerId: ctx.config.llm.provider,
    primaryModelId: campaignConfig.model,
    triageModelId: null,
    baseUrl: ctx.config.llm.baseUrl ?? null,
    dailyBudgetUsd: campaignConfig.dailyBudgetUsd,
    thinkingLevel: campaignConfig.thinkingLevel,
  }, defaultModelLookup(models)) : undefined;
  const historicalAgent = historicalResolved ? {
    model: historicalResolved.primary.model,
    thinkingLevel: campaignConfig!.thinkingLevel,
    streamFn: models.streamSimple.bind(models),
    providerId: historicalResolved.providerId,
    modelId: historicalResolved.primary.model.id,
  } : undefined;
  if (campaign) {
    ctx.logger.info({
      event: 'historical_campaign.ready',
      campaignId: campaign.id,
      status: campaign.status,
      direction: campaign.direction,
      fromAtMs: campaign.from_at_ms,
      toAtMs: campaign.to_at_ms,
      channelCount: campaignConfig!.channelIds.length,
      provider: campaign.provider,
      model: campaign.model,
      thinkingLevel: campaign.thinking_level,
      dailyBudgetUsd: campaign.daily_budget_usd,
      totalBudgetUsd: campaign.total_budget_usd,
    }, 'bounded historical campaign configured');
  }
  // The read-only platform archive, shared by every agent run (plan 011).
  const archiveReader = ctx.platformArchive
    ? createArchiveReader({ db: ctx.platformArchive.db, liveDb: ctx.db, summary: ctx.platformArchive.summary, logger: ctx.logger })
    : undefined;
  const modelGate = new ModelBudgetGate({ dailyBudgetUsd: ctx.config.llm.dailyBudgetUsd ?? null,
    timeZone: ctx.config.organization.timezone }, ctx.now());
  // The cap is operational policy, not process-local state. Hydrate today's
  // persisted spend so restarting Mneme cannot reset or bypass the budget.
  const persistedSpend = ctx.db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agent_runs WHERE started_at_ms >= ? AND cost_usd IS NOT NULL',
  ).get(orgDayStartMs(ctx.now(), ctx.config.organization.timezone)) as { total: number };
  modelGate.recordSpend(Number(persistedSpend.total), ctx.now());
  const historicalBudget = new OrgDayBudget({
    dailyBudgetUsd: ctx.config.historicalMemory.dailyBudgetUsd,
    timeZone: ctx.config.organization.timezone,
  }, ctx.now());
  const historicalDayStart = orgDayStartMs(ctx.now(), ctx.config.organization.timezone);
  const persistedHistoricalSpend = campaign
    ? historicalCampaignSpend(ctx.db, campaign.id, historicalDayStart)
    : Number((ctx.db.prepare(`
        SELECT COALESCE(SUM(ar.cost_usd), 0) AS total
          FROM agent_runs ar JOIN episodes e ON e.id = ar.episode_id
         WHERE e.origin = 'historical' AND ar.started_at_ms >= ? AND ar.cost_usd IS NOT NULL
      `).get(historicalDayStart) as { total: number }).total);
  historicalBudget.recordSpend(persistedHistoricalSpend, ctx.now());
  if (campaign?.status === 'running') {
    const reviewsWoken = wakeHistoricalCampaignReviews(ctx.db, campaign.id, ctx.now());
    if (reviewsWoken > 0) {
      ctx.logger.info({ event: 'historical_campaign.reviews_woken', campaignId: campaign.id, reviewsWoken },
        'deferred historical reviews made eligible after campaign startup');
    }
  }
  ctx.runtime.markModelHealthy();
  // Provider concurrency remains exactly AGENT_MAX_CONCURRENCY: interactive
  // priority is a non-preemptive queue order, not a fully reserved extra slot.
  // After three contested direct-answer handoffs, one background waiter runs so
  // a sustained mention stream cannot starve durable review work indefinitely.
  const modelAdmission = new ModelAdmissionController({
    capacity: ctx.config.agentRuntime.maxConcurrency,
    directBurstLimit: 3,
  });
  const gatedExecute = async (run: ExecuteAgentRunDeps) => {
    if (ctx.runtime.isShuttingDown()) {
      throw new DeferJobError('model work deferred: process is shutting down', 60_000);
    }
    const episode = run.episodeId
      ? ctx.db.prepare('SELECT origin,historical_campaign_id FROM episodes WHERE id=?').get(run.episodeId) as
        | { origin: string; historical_campaign_id: string | null }
        | undefined
      : undefined;
    const historical = episode?.origin === 'historical';
    const campaignRun = Boolean(campaign && episode?.historical_campaign_id === campaign.id);
    if (campaignRun) {
      const current = getHistoricalCampaign(ctx.db, campaign!.id);
      if (current?.status !== 'running') {
        throw new DeferJobError(`historical campaign is ${current?.status ?? 'missing'}`, 5 * 60_000);
      }
      if (historicalCampaignSpend(ctx.db, campaign!.id) >= current.total_budget_usd) {
        setHistoricalCampaignStatus(ctx.db, campaign!.id, 'budget_exhausted', ctx.now());
        throw new DeferJobError('historical campaign total budget exhausted', 5 * 60_000);
      }
    }
    if (historical && historicalBudget.isExhausted(ctx.now())) {
      throw new DeferJobError('historical model work deferred: daily budget exhausted', historicalBudget.msUntilNextDay(ctx.now()));
    }
    const decision = modelGate.evaluate(ctx.now());
    if (!decision.allow) {
      ctx.runtime.markModelDegraded();
      throw new DeferJobError(`model work deferred: ${decision.reason ?? 'gate'}`, decision.retryAfterMs ?? 60_000);
    }
    const interactiveAdmission = (run.admissionClass ?? run.runType) === 'direct_answer';
    const directAdmissionWaitMs = interactiveAdmission
      ? directAnswerAdmissionWaitMs(run.requestDeadlineAtMs, ctx.now())
      : undefined;
    if (directAdmissionWaitMs === 0) {
      throw new ModelAdmissionTimeoutError(0);
    }
    const releaseModelSlot = await modelAdmission.acquire(
      interactiveAdmission ? 'direct_answer' : 'background',
      directAdmissionWaitMs === undefined ? {} : { timeoutMs: directAdmissionWaitMs },
    );
    try {
      if (ctx.runtime.isShuttingDown()) {
        throw new DeferJobError('model work deferred: process is shutting down', 60_000);
      }
      const currentDecision = modelGate.evaluate(ctx.now());
      if (!currentDecision.allow) {
        ctx.runtime.markModelDegraded();
        throw new DeferJobError(
          `model work deferred: ${currentDecision.reason ?? 'gate'}`,
          currentDecision.retryAfterMs ?? 60_000,
        );
      }
      if (historical && historicalBudget.isExhausted(ctx.now())) {
        throw new DeferJobError('historical model work deferred: daily budget exhausted', historicalBudget.msUntilNextDay(ctx.now()));
      }
      if (campaignRun) {
        const current = getHistoricalCampaign(ctx.db, campaign!.id);
        if (!current || historicalCampaignSpend(ctx.db, campaign!.id) >= current.total_budget_usd) {
          setHistoricalCampaignStatus(ctx.db, campaign!.id, 'budget_exhausted', ctx.now());
          throw new DeferJobError('historical campaign total budget exhausted', 5 * 60_000);
        }
      }
      let execution = campaignRun && historicalAgent ? {
        ...run,
        model: historicalAgent.model,
        thinkingLevel: historicalAgent.thinkingLevel,
        streamFn: historicalAgent.streamFn,
        providerId: historicalAgent.providerId,
        modelId: historicalAgent.modelId,
      } : run;
      if (run.runType === 'direct_answer' && run.requestDeadlineAtMs !== undefined) {
        const wallClockMs = deadlineBoundWallClockMs(
          execution.limits?.wallClockMs
            ?? ctx.config.agentRuntime.timeoutSeconds * 1_000,
          run.requestDeadlineAtMs,
          ctx.now(),
        );
        if (wallClockMs === 0) throw new ModelAdmissionTimeoutError(0);
        execution = {
          ...execution,
          limits: { ...execution.limits, wallClockMs },
        };
      }
      execution = {
        ...execution,
        ...(archiveReader ? { archive: archiveReader } : {}),
        requireKnownPricing: historical
          ? ctx.config.historicalMemory.dailyBudgetUsd > 0
          : ctx.config.llm.dailyBudgetUsd !== null,
      };
      const result = await executeAgentRun(execution);
      modelGate.recordSpend(result.usage.costUsd, ctx.now());
      if (historical) historicalBudget.recordSpend(result.usage.costUsd, ctx.now());
      if (campaignRun) {
        const current = getHistoricalCampaign(ctx.db, campaign!.id);
        if (current && historicalCampaignSpend(ctx.db, campaign!.id) >= current.total_budget_usd) {
          setHistoricalCampaignStatus(ctx.db, campaign!.id, 'budget_exhausted', ctx.now());
        }
      }
      if (result.outcome === 'error' || result.outcome === 'aborted') {
        const failure = classifyModelError({ message: result.failureReason ?? result.outcome });
        modelGate.recordModelFailure(failure, ctx.now());
        ctx.runtime.markModelDegraded();
        throw new TransientJobError(result.failureReason ?? `model run ${result.outcome}`, {
          billableAgentRun: {
            runId: result.runId,
            costUsd: result.usage.costUsd,
            startedAtMs: result.startedAtMs,
          },
        });
      }
      modelGate.recordModelSuccess(ctx.now());
      if (modelGate.health.status(ctx.now()) === 'healthy') ctx.runtime.markModelHealthy();
      else ctx.runtime.markModelDegraded();
      return result;
    } finally {
      releaseModelSlot();
    }
  };
  const systemPrompt = (runContext: Record<string, unknown>) => snapshot().promptCompiler.render('system', {
    ...runContext,
    archive: ctx.platformArchive ? { platform: ctx.platformArchive.summary.platform } : null,
    agent: ctx.config.agent,
    organization: ctx.config.organization,
    personality: ctx.config.personality,
  });
  const reviewSecret = platform.reviewSecret;
  const limits = configuredRunLimits(ctx.config.agentRuntime);
  // Mneme's own documentation, scanned one time: a direct-answer run reads it
  // through `list_docs` / `read_doc` (Section 22.7).
  const docsIndex = loadDocsIndex(ctx.config.docsDir, ctx.config.docsPublicUrl);
  if (docsIndex.size === 0) {
    ctx.logger.warn(
      { docsDir: ctx.config.docsDir },
      'documentation index is empty; Mneme cannot answer questions about herself',
    );
  }
  const scope = (channelId: string) => {
    const current = resolveCurrentChannelScope(ctx.db, channelId);
    const visibility = current?.visibility ?? 'excluded';
    return {
      grant: grantForDirectAnswerChannel(
        ctx.db,
        channelId,
        ctx.config.reviewChannelId,
        snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
      ),
      target: { channelId, scopeChannelId: current?.scopeChannelId ?? channelId,
        visibility, isSecureReview: channelId === ctx.config.reviewChannelId },
    };
  };

  const worker = createJobWorker({
    db: ctx.db,
    owner: `mneme:${process.pid}`,
    leaseMs: productionJobLeaseMs(ctx.config.agentRuntime.timeoutSeconds),
    pollIntervalMs: 1_000,
    shutdownTimeoutMs: ctx.config.maintenance.shutdownTimeoutSeconds * 1000,
    isPaused: () => isPaused(ctx.db),
    clock: ctx.now,
  });
  worker.register('backfill_channel', ctx.config.ingestion.backfillConcurrency,
    createBackfillChannelHandler({ db: ctx.db, fetcher, makeIngestOptions: ingestOptions, now: ctx.now, logger: ctx.logger }));
  worker.register('build_historical_episodes', 1, createBuildHistoricalEpisodesHandler({
    db: ctx.db,
    guildId: ctx.config.workspaceId,
    config: {
      channelIds: ctx.config.historicalMemory.channelIds,
      batchMessages: ctx.config.historicalMemory.batchMessages,
      maxPendingReviews: ctx.config.historicalMemory.maxPendingReviews,
      quietSeconds: ctx.config.episodes.quietSeconds,
      maxMessages: ctx.config.episodes.maxMessages,
      maxMinutes: ctx.config.episodes.maxMinutes,
      campaign: campaign ? { id: campaign.id, fromAtMs: campaign.from_at_ms, toAtMs: campaign.to_at_ms } : undefined,
    },
    now: ctx.now,
    logger: ctx.logger,
  }));
  worker.register('archive_attachment', 1, createArchiveAttachmentHandler({ db: ctx.db, config: {
    mode: ctx.config.ingestion.attachmentMode,
    maxBytes: ctx.config.ingestion.attachmentMaxBytes,
    mimeAllowlist: ctx.config.ingestion.attachmentMimeAllowlist,
    dataDir: ctx.config.dataDir,
    isValidAttachmentId: (id) => platform.isValidAttachmentId(id),
  }, now: ctx.now, fetcher: platform.fetchBytes }));
  worker.register('purge_attachment_file', 1, createPurgeAttachmentFileHandler({ db: ctx.db, now: ctx.now }));
  worker.register('reconcile_channel', ctx.config.ingestion.backfillConcurrency,
    createReconcileChannelHandler({ db: ctx.db, fetcher, makeIngestOptions: ingestOptions, now: ctx.now,
      overlapHours: ctx.config.ingestion.reconcileOverlapHours,
      maxPages: ctx.config.ingestion.reconcileMaxPagesPerRun, logger: ctx.logger }));
  worker.register('recover_message', ctx.config.ingestion.backfillConcurrency,
    createRecoverMessageHandler({ db: ctx.db, fetcher, makeIngestOptions: ingestOptions, now: ctx.now,
      observer: createIngestionObserver(ctx.counters) }));
  worker.register('close_episode', 1, createCloseEpisodeHandler({ db: ctx.db, timing: ctx.config.episodes, now: ctx.now, logger: ctx.logger }));
  worker.register('direct_answer', ctx.config.agentRuntime.maxConcurrency, createDirectAnswerHandler({
    db: ctx.db, guildId: ctx.config.workspaceId, format: ctx.format, promptCompiler: () => snapshot().promptCompiler,
    channelPolicyYml: () => snapshot().channelPolicyYml, mnemeYml: safeRead(ctx.config.mnemeConfigPath),
    systemPrompt, resolveChannelScope: scope, rateChecks: (channelId, content, now) => recentChecks(ctx, channelId, content, now),
    mode: () => ctx.config.mode, agent, docs: docsIndex, executeRun: gatedExecute, now: ctx.now, limits, logger: ctx.logger,
  }));
  worker.register('deep_recap', 1, createDeepRecapHandler({
    db: ctx.db,
    guildId: ctx.config.workspaceId,
    format: ctx.format,
    promptCompiler: () => snapshot().promptCompiler,
    systemPrompt,
    resolveChannelScope: scope,
    rateChecks: (channelId, content, now) => recentChecks(ctx, channelId, content, now),
    executeRun: gatedExecute,
    agent,
    mode: () => ctx.config.mode,
    enabled: ctx.config.deepRecap.enabled,
    dailyBudgetUsd: ctx.config.deepRecap.dailyBudgetUsd,
    dayStartMs: (now) => orgDayStartMs(now, ctx.config.organization.timezone),
    now: ctx.now,
    limits,
    logger: ctx.logger,
  }));
  const reviewEpisode = createReviewEpisodeHandler({
    db: ctx.db, guildId: ctx.config.workspaceId, mnemeId: platform.selfUserId,
    promptCompiler: () => snapshot().promptCompiler, channelPolicyYml: () => snapshot().channelPolicyYml,
    mnemeYml: safeRead(ctx.config.mnemeConfigPath), systemPrompt,
    resolveChannelScope: (channelId) => {
      const s = scope(channelId);
      const channel = getChannel(ctx.db, channelId);
      return { grant: s.grant, target: { label: channel?.name ? `#${channel.name}` : channelId, visibility: s.target.visibility } };
    },
    runtimeCounters: (channelId, now) => {
      const channelPosts = Number((ctx.db.prepare("SELECT count(*) AS n FROM outbox WHERE channel_id = ? AND status = 'sent' AND sent_at_ms >= ?").get(channelId, now - 86_400_000) as { n: number }).n);
      const globalPosts = Number((ctx.db.prepare("SELECT count(*) AS n FROM outbox WHERE status = 'sent' AND sent_at_ms >= ?").get(now - 86_400_000) as { n: number }).n);
      return { recentChannelPosts: channelPosts, globalPostsToday: globalPosts };
    },
    mode: () => ctx.config.mode, interventionThreshold: ctx.config.intervention.threshold,
    agent, executeRun: gatedExecute, now: ctx.now, limits, logger: ctx.logger,
    episodeShadow,
    memoryMinimumConfidence: ctx.config.memory.minimumConfidence,
    memoryMinimumImportance: ctx.config.memory.minimumImportance,
    memoryFollowupHorizonDays: ctx.config.memory.followupHorizonDays,
    memoryFollowupMaxMessages: ctx.config.memory.followupMaxMessages,
    settle: {
      settleSeconds: ctx.config.episodes.settleSeconds,
      settleMaxMinutes: ctx.config.episodes.settleMaxMinutes,
    },
    attentionWindowMs: ctx.config.intervention.attentionWindowDays * 86_400_000,
    attentionTimezone: ctx.config.organization.timezone,
    routeIntervention: (input) => routeEpisodeIntervention(ctx, platform, reviewSecret, input),
  });
  worker.register('review_episode', ctx.config.agentRuntime.maxConcurrency, async (payload, job) => {
    const episode = ctx.db.prepare('SELECT origin, conversation_channel_id, historical_campaign_id FROM episodes WHERE id = ?').get(payload.episodeId) as
      | { origin: string; conversation_channel_id: string; historical_campaign_id: string | null }
      | undefined;
    const allowed = ctx.config.historicalMemory.channelIds;
    if (episode?.origin === 'historical' && campaign && episode.historical_campaign_id !== campaign.id) {
      throw new DeferJobError('legacy historical review held outside the active campaign', 5 * 60_000);
    }
    if (episode?.origin === 'historical' && campaign) {
      const current = getHistoricalCampaign(ctx.db, campaign.id);
      if (current?.status !== 'running') {
        throw new DeferJobError(`historical campaign is ${current?.status ?? 'missing'}`, 5 * 60_000);
      }
    }
    if (episode?.origin === 'historical' && allowed.length > 0 && !allowed.includes(episode.conversation_channel_id)) {
      throw new DeferJobError('historical review held outside configured channel allowlist', 5 * 60_000);
    }
    await reviewEpisode(payload, job);
  });
  if (ctx.config.reviewChannelId) {
    const routeOptions = () => ({
      guildId: ctx.config.workspaceId,
      reviewChannelId: ctx.config.reviewChannelId!,
      reviewAcceptedScopes: snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
    });
    worker.register('review_due_memories', 1, async () => {
      createReviewDueMemoryDispatcherHandler({
        db: ctx.db,
        ...routeOptions(),
        now: ctx.now,
        logger: ctx.logger,
        attentionWindowMs: ctx.config.intervention.attentionWindowDays * 86_400_000,
      }).dispatch();
    });
    const scheduledCohort = createReviewDueMemoryCohortHandler({
      db: ctx.db,
      ...routeOptions(),
      currentRouteOptions: routeOptions,
      base: {
        format: ctx.format,
        promptCompiler: () => snapshot().promptCompiler,
        channelPolicyYml: () => snapshot().channelPolicyYml,
        mnemeYml: safeRead(ctx.config.mnemeConfigPath),
        systemPrompt,
        mode: () => ctx.config.mode,
        agent,
        executeRun: gatedExecute,
        now: ctx.now,
        limits,
        logger: ctx.logger,
        memoryMinimumConfidence: ctx.config.memory.minimumConfidence,
        memoryMinimumImportance: ctx.config.memory.minimumImportance,
        scheduledReminderIntervalMs: ctx.config.memory.scheduledReviewReminderDays * 86_400_000,
        attentionWindowMs: ctx.config.intervention.attentionWindowDays * 86_400_000,
        attentionTimezone: ctx.config.organization.timezone,
        mnemeId: platform.selfUserId,
      },
      resolveWorkingScope: (targetChannelId) => resolveScheduledWorkingScope(
        ctx.db,
        targetChannelId,
        ctx.config.reviewChannelId!,
      ),
      resolveSecureScope: () => resolveScheduledReviewScope(
        ctx.db,
        ctx.config.reviewChannelId!,
        snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
      ),
      onPendingProposal: async (outcome) => {
        const proposal = getProposal(ctx.db, outcome.notification.proposalId);
        if (!proposal?.message) return;
        try {
          await platform.deliverProposalReview(
            buildScheduledReviewPresentation(ctx.db, ctx.config.workspaceId, proposal),
            { db: ctx.db, reviewChannelId: ctx.config.reviewChannelId!, secret: reviewSecret, now: ctx.now() },
          );
        } catch (err) {
          setProposalStatus(ctx.db, proposal.id, 'failed', ctx.now());
          ctx.logger.warn({ event: 'scheduled_review.delivery_failed', proposalId: proposal.id,
            err: err instanceof Error ? err.message : String(err) }, 'scheduled proposal card delivery failed');
        }
      },
    });
    worker.register('review_due_memory_cohort', ctx.config.agentRuntime.maxConcurrency, scheduledCohort);
  } else {
    worker.register('review_due_memories', 1, async () => {
      ctx.logger.warn({ event: 'scheduled_review.no_secure_channel' }, 'scheduled memory review skipped: no secure review channel');
    });
    worker.register('review_due_memory_cohort', 1, async () => {
      ctx.logger.warn({ event: 'scheduled_review.no_secure_channel' }, 'scheduled memory cohort skipped: no secure review channel');
    });
  }
  const deliveryReviewResolver = ctx.config.reviewChannelId
    ? platform.reviewResolver(ctx.config.reviewChannelId)
    : undefined;
  const reportProposalDelivery = deliveryReviewResolver
    ? async (report: ProposalDeliveryReport) => {
        const proposal = getProposal(ctx.db, report.proposalId);
        if (!proposal?.reviewMessageId) return;
        const label = report.status === 'sent'
          ? `✅ Sent — [open notification](${messageLink(
              ctx.config.workspaceId,
              proposal.targetChannelId,
              report.platformMessageId,
            )})`
          : report.status === 'cancelled'
            ? '⏰ Expired — delivery cancelled before send'
            : '❌ Delivery failed';
        await deliveryReviewResolver({
          reviewMessageId: proposal.reviewMessageId,
          label,
          removeControls: true,
        });
      }
    : undefined;
  const sendOutbox = createSendOutboxHandler({
    db: ctx.db,
    sender: platform.sender,
    now: ctx.now,
    logger: ctx.logger,
    reportProposalDelivery,
    validateProposalSend: (proposalId, now) => {
      const recheck = buildApprovalRecheck(ctx, proposalId, now, {
        guildId: ctx.config.workspaceId,
        reviewChannelId: ctx.config.reviewChannelId ?? '',
        reviewAcceptedScopes: snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
      });
      const policy = recheckApprovalPolicy(recheck);
      const scheduled = recheck.scheduledDelivery;
      return scheduled && !scheduled.allow
        ? { allow: false, reasons: [...policy.reasons, ...scheduled.reasons] }
        : policy;
    },
  });
  worker.register('send_outbox', 1, async (payload, job) => {
    // A downgrade to observe is an immediate kill switch for unsolicited or
    // approved proposal sends. Explicit direct answers have no proposal_id and
    // remain available, as required by Section 26.
    if (ctx.config.mode === 'observe') {
      const row = ctx.db.prepare('SELECT proposal_id FROM outbox WHERE id = ?').get(payload.outboxId) as
        | { proposal_id: string | null }
        | undefined;
      if (row?.proposal_id) throw new DeferJobError('proposal send held while mode is observe', 60_000);
    }
    await sendOutbox(payload, job);
  });
  worker.register(
    'sync_proposal_review',
    1,
    reportProposalDelivery
      ? createProposalDeliverySyncHandler({ db: ctx.db, reporter: reportProposalDelivery })
      : async () => undefined,
  );
  if (ctx.config.reviewChannelId) {
    worker.register('deliver_channel_policy_review', 1, platform.createChannelPolicyReviewDeliveryHandler({
      db: ctx.db,
      reviewChannelId: ctx.config.reviewChannelId,
      secret: reviewSecret,
      now: ctx.now,
    }));
  } else {
    worker.register('deliver_channel_policy_review', 1, async () => {
      throw new DeferJobError('channel policy review held without a secure review channel', 6 * 60 * 60_000);
    });
  }
  worker.register('backup_database', 1, createBackupDatabaseHandler({
    db: ctx.db,
    backupsDir: ctx.config.backupDir,
    sourceDatabasePath: ctx.config.databasePath,
    retentionDays: ctx.config.maintenance.backupRetentionDays,
    now: ctx.now,
    logger: ctx.logger,
    notifyCompleted: async ({ requesterUserId, file, bytes }) => {
      await platform.sendDirect(
        requesterUserId,
        backupCompletedNotice(platform.id, file, bytes),
      );
    },
  }));
  const maintenance = createDatabaseMaintenanceHandler({
    db: ctx.db,
    now: ctx.now,
    jobsRetentionDays: ctx.config.maintenance.jobsRetentionDays,
    onOutcome: (outcome) => {
      if (outcome.jobsPruned && outcome.jobsPruned.deleted > 0) {
        ctx.logger.info(
          { event: 'jobs.pruned', ...outcome.jobsPruned },
          'terminal job rows past retention were deleted',
        );
      }
    },
  });
  const expiry = createExpireProposalsHandler({ db: ctx.db, now: ctx.now, logger: ctx.logger });
  worker.register('maintenance', 1, async () => {
    await runPeriodicMaintenanceCycle({
      expireProposals: () => expiry.runExpiry(),
      expireAttention: () => expireClosedAttentionRevisions(ctx.db, {
        now: ctx.now(),
        windowMs: ctx.config.intervention.attentionWindowDays * 86_400_000,
        actorUserId: platform.selfUserId,
        guildId: ctx.config.workspaceId,
      }),
      maintainDatabase: () => maintenance.runDatabaseMaintenance(),
      repairDeepRecaps: () => repairDeepRecapOwnership(ctx.db, { now: ctx.now() }),
      logger: ctx.logger,
    });
  });
  worker.register('rescope_memories', 1, createRescopeMemoriesHandler({ db: ctx.db, guildId: ctx.config.workspaceId,
    actorUserId: platform.selfUserId, now: ctx.now }));
  worker.register('forget_user', 1, createForgetUserHandler());
  worker.register('execute_deletion', 1, createExecuteDeletionHandler({ db: ctx.db, guildId: ctx.config.workspaceId,
    deletionApproverUserIds: ctx.config.deletionApproverUserIds, now: ctx.now }));
  worker.register('discover_threads', ctx.config.ingestion.backfillConcurrency, async () => {
    await runPlatformDiscovery({ db: ctx.db, guildId: ctx.config.workspaceId, policy: snapshot().channelPolicy,
      channelPolicySource: ctx.config.channelPolicySource, now: ctx.now(), platform,
      enqueueHistoricalBackfill: ctx.config.ingestion.fullHistory, logger: ctx.logger });
  });

  const currentScheduledRouteOptions = () => ({
    guildId: ctx.config.workspaceId,
    reviewChannelId: ctx.config.reviewChannelId ?? '',
    reviewAcceptedScopes: snapshot().channelPolicy.review_channel?.accepts_scopes ?? [],
  });
  platform.registerCommandDispatch({ ctx, buildApprovalRecheck: (proposalId) =>
    buildApprovalRecheck(ctx, proposalId, ctx.now(), currentScheduledRouteOptions()) });
  platform.registerReviewControls({
    db: ctx.db,
    workspaceId: ctx.config.workspaceId,
    secret: reviewSecret,
    adminRoleIds: ctx.config.adminRoleIds,
    reviewChannelId: ctx.config.reviewChannelId,
    buildRecheck: (proposalId) => buildApprovalRecheck(ctx, proposalId, ctx.now(), currentScheduledRouteOptions()),
    policy: () => snapshot().channelPolicy,
    channelPolicySource: ctx.config.channelPolicySource,
    now: ctx.now,
  });

  await reconcileOutboxSending(ctx.db, platform.recentSent, {
    now: ctx.now(),
    reportProposalDelivery,
    validateProposalSend: (proposalId, now) => {
      const recheck = buildApprovalRecheck(ctx, proposalId, now, currentScheduledRouteOptions());
      const policy = recheckApprovalPolicy(recheck);
      return recheck.scheduledDelivery && !recheck.scheduledDelivery.allow
        ? { allow: false, reasons: [...policy.reasons, ...recheck.scheduledDelivery.reasons] }
        : policy;
    },
    logger: ctx.logger,
  });
  const scheduler = new PeriodicScheduler(nodeTimerDriver, ctx.logger);
  // Schedules resume from durable job history, so a restart never resets the
  // 24-hour timers (Section 10); a due-memory review that is overdue fires
  // shortly after boot under its stable unique key.
  scheduler.start(buildSchedules(ctx.config, {
    enqueue: (input) => enqueue(ctx.db, input),
    channelIds: () => scheduledIngestionChannelIds(ctx.db),
    lastRunMs: (key, match) => lastScheduledRunMs(ctx.db, key, match),
    channelDiscoveryIntervalMs: platform.threadDiscovery.mode === 'complete_snapshot'
      ? platform.threadDiscovery.rediscoveryIntervalMs : undefined,
  }));
  if (ctx.config.historicalMemory.enabled) {
    enqueue(ctx.db, {
      type: 'build_historical_episodes', payload: {}, uniqueKey: 'schedule:historical-memory',
      priority: 200, now: ctx.now(),
    });
  }
  worker.start();
  return { worker, scheduler, stop: async () => { scheduler.stop(); worker.stop(); await worker.waitForShutdown(); } };
}
