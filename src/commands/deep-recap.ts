import type { DatabaseSync } from '../db/database.js';
import { transactionImmediate } from '../db/database.js';
import { authorizeAndAuditAdminAction } from '../policy/authorization.js';
import { enqueue } from '../jobs/queue.js';
import {
  cancelDeepRecap,
  createDeepRecap,
  deepRecapSynthesisRetryBlockReason,
  latestDeepRecapStatuses,
  resolveDeepRecapRef,
  retryDeepRecapSynthesis,
  type DeepRecapRequestRow,
  type DeepRecapStatusView,
  type DeepRecapSynthesisRetryBlockReason,
} from '../deep-recap/repository.js';

export type DeepRecapSubcommand = 'start' | 'status' | 'retry' | 'cancel';

export interface DeepRecapCommandInput {
  subcommand: DeepRecapSubcommand;
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  invocationChannelId: string;
  days?: number | null;
  topic?: string | null;
  channelId?: string | null;
  budgetUsd?: number | null;
  recapId?: string | null;
}

export interface DeepRecapCommandDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  maxWindowDays: number;
  maxBudgetUsd: number;
  enabled: boolean;
  isTargetAllowed: (channelId: string) => boolean;
  isSourceAllowed: (channelId: string) => boolean;
}

export type DeepRecapCommandOutcome =
  | { kind: 'not_authorized' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'started'; request: DeepRecapRequestRow }
  | { kind: 'listed'; requests: DeepRecapStatusView[]; nowMs: number }
  | { kind: 'retried'; request: DeepRecapRequestRow; originalRequestId: string }
  | { kind: 'cancelled'; request: DeepRecapRequestRow }
  | { kind: 'not_found' };

export function handleDeepRecapCommand(
  input: DeepRecapCommandInput,
  deps: DeepRecapCommandDeps,
): DeepRecapCommandOutcome {
  const auth = authorizeAndAuditAdminAction(deps.db, {
    memberRoleIds: input.memberRoleIds,
    adminRoleIds: deps.adminRoleIds,
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: `deep_recap_${input.subcommand}`,
    now: deps.nowMs,
  });
  if (!auth.authorized) return { kind: 'not_authorized' };

  if (input.subcommand === 'status') {
    return {
      kind: 'listed',
      requests: latestDeepRecapStatuses(deps.db, input.guildId),
      nowMs: deps.nowMs,
    };
  }
  if (input.subcommand === 'cancel') {
    const ref = input.recapId?.trim() ?? '';
    if (!ref) return { kind: 'invalid', reason: 'A recap id is required.' };
    const request = resolveDeepRecapRef(deps.db, input.guildId, ref);
    if (!request) return { kind: 'not_found' };
    if (!cancelDeepRecap(deps.db, request.id, deps.nowMs)) {
      return { kind: 'invalid', reason: 'That recap is already terminal and cannot be cancelled.' };
    }
    return { kind: 'cancelled', request: { ...request, status: 'cancelled' } };
  }
  if (input.subcommand === 'retry') {
    if (!deps.enabled) return { kind: 'invalid', reason: 'Deep recaps are disabled by configuration.' };
    const ref = input.recapId?.trim() ?? '';
    if (!ref) return { kind: 'invalid', reason: 'A recap id is required.' };
    const original = resolveDeepRecapRef(deps.db, input.guildId, ref);
    if (!original) return { kind: 'not_found' };
    if (original.target_channel_id !== input.invocationChannelId) {
      return { kind: 'invalid', reason: 'Retry this recap from its original destination channel.' };
    }
    if (!deps.isTargetAllowed(original.target_channel_id)) {
      return { kind: 'invalid', reason: 'The recap destination is no longer eligible.' };
    }
    const blocked = deepRecapSynthesisRetryBlockReason(deps.db, original);
    if (blocked) return { kind: 'invalid', reason: synthesisRetryBlockedMessage(blocked) };
    try {
      const request = retryDeepRecapSynthesis(deps.db, {
        requestId: original.id,
        requestedByUserId: input.actorUserId,
        now: deps.nowMs,
      });
      if (!request) {
        return { kind: 'invalid', reason: 'That recap changed while the retry was being created. Check its status and try again.' };
      }
      return { kind: 'retried', request, originalRequestId: original.id };
    } catch (error) {
      if (String(error).includes('deep_recap_requests.retry_of_request_id')) {
        return { kind: 'invalid', reason: synthesisRetryBlockedMessage('lineage_superseded') };
      }
      if (String(error).includes('UNIQUE constraint failed')) {
        return { kind: 'invalid', reason: 'A deep recap is already active for this channel.' };
      }
      throw error;
    }
  }

  if (!deps.enabled) return { kind: 'invalid', reason: 'Deep recaps are disabled by configuration.' };
  const days = input.days ?? 14;
  if (!Number.isInteger(days) || days < 1 || days > deps.maxWindowDays) {
    return { kind: 'invalid', reason: `Days must be between 1 and ${deps.maxWindowDays}.` };
  }
  const budgetUsd = input.budgetUsd ?? Math.min(5, deps.maxBudgetUsd);
  if (!Number.isInteger(budgetUsd) || budgetUsd < 1 || budgetUsd > deps.maxBudgetUsd) {
    return { kind: 'invalid', reason: `Budget must be a whole-dollar value from 1 to ${deps.maxBudgetUsd}.` };
  }
  const topic = input.topic?.trim() || null;
  if (topic && topic.length > 200) return { kind: 'invalid', reason: 'Topic must be at most 200 characters.' };
  if (!deps.isTargetAllowed(input.invocationChannelId)) {
    return { kind: 'invalid', reason: 'This channel is not an eligible recap destination.' };
  }
  const sourceChannelId = input.channelId ?? null;
  if (sourceChannelId && !deps.isSourceAllowed(sourceChannelId)) {
    return { kind: 'invalid', reason: 'The selected source channel is outside this destination’s permitted scope.' };
  }

  try {
    const request = transactionImmediate(deps.db, () => {
      const created = createDeepRecap(deps.db, {
        guildId: input.guildId,
        targetChannelId: input.invocationChannelId,
        requestedByUserId: input.actorUserId,
        topic,
        channelIds: sourceChannelId ? [sourceChannelId] : undefined,
        afterAtMs: deps.nowMs - days * 86_400_000,
        beforeAtMs: deps.nowMs,
        budgetUsd,
        now: deps.nowMs,
      });
      enqueue(deps.db, {
        type: 'deep_recap',
        payload: { recapId: created.id },
        uniqueKey: `deep-recap:${created.id}`,
        priority: 30,
        maxAttempts: 3,
        now: deps.nowMs,
      });
      return created;
    });
    return { kind: 'started', request };
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) {
      return { kind: 'invalid', reason: 'A deep recap is already active for this channel.' };
    }
    throw error;
  }
}

function progress(request: DeepRecapRequestRow): string {
  const chunks = request.planned_chunks > 0
    ? `${request.completed_chunks}/${request.planned_chunks} chunks`
    : 'planning';
  return `${chunks} · ${request.included_messages}/${request.total_matching_messages} messages · $${request.spent_usd.toFixed(2)}/$${request.budget_usd.toFixed(2)}`;
}

function coverageDetail(view: DeepRecapStatusView): string | null {
  const { request, coverage } = view;
  if (request.planned_chunks === 0 || request.total_matching_messages === 0) return null;
  const analyzed = request.completed_chunks === request.planned_chunks
    ? request.included_messages
    : coverage.plannedIncludedMessages;
  const omitted = Math.max(0, request.total_matching_messages - analyzed);
  const caps = [
    coverage.messageCapPartitions > 0 ? 'message cap' : null,
    coverage.characterCapPartitions > 0 ? 'character cap' : null,
  ].filter(Boolean).join(' + ');
  const split = coverage.splitPartitions > 0
    ? `${coverage.splitPartitions} adaptive partition${coverage.splitPartitions === 1 ? '' : 's'}`
    : null;
  if (omitted === 0 && !split) return null;
  return [omitted > 0 ? `${omitted} omitted${caps ? ` · ${caps}` : ''}` : null, split]
    .filter(Boolean).join(' · ');
}

function synthesisRetryBlockedMessage(reason: DeepRecapSynthesisRetryBlockReason): string {
  switch (reason) {
    case 'request_not_failed':
      return 'Only a failed deep recap can be retried.';
    case 'chunks_incomplete':
      return 'Synthesis-only retry requires every planned chunk to be complete. Start a new recap for unfinished analysis.';
    case 'budget_exhausted':
      return 'That recap has no request budget left. Start a new recap with a narrower scope or a new budget.';
    case 'failure_not_retryable':
      return 'That failure cannot be retried safely from stored summaries. Start a new narrower recap.';
    case 'lineage_superseded':
      return 'A newer synthesis retry already exists. Only the latest failed request in this lineage can be retried.';
    case 'lineage_already_succeeded':
      return 'This recap lineage already produced a completed or partial report and cannot be retried.';
  }
}

function safeFailureLabel(category: string | null): string {
  switch (category) {
    case 'DEEP_RECAP_REPORT_TOO_LONG':
      return 'report exceeded output limit';
    case 'DEEP_RECAP_SOURCE_CHANGED':
    case 'DEEP_RECAP_SOURCE_VERSION_CONFLICT':
      return 'message content changed';
    case 'DEEP_RECAP_SOURCE_COVERAGE_CHANGED':
      return 'message set changed';
    case 'DEEP_RECAP_SOURCE_UNAVAILABLE':
      return 'source unavailable';
    case 'DEEP_RECAP_SOURCE_SCOPE_INVALID':
      return 'visibility changed';
    case 'target_invalid':
      return 'destination unavailable';
    case 'budget':
      return 'request budget exhausted';
    case 'DEEP_RECAP_OUTBOUND_VALIDATION_REJECTED':
      return 'outbound validation rejected';
    default:
      return 'processing failed';
  }
}

function relativeTimestamp(atMs: number): string {
  return `<t:${Math.floor(atMs / 1_000)}:R>`;
}

function displayedState(view: DeepRecapStatusView, nowMs: number): string {
  const { request, jobs } = view;
  if (request.status === 'failed') return `failed · ${safeFailureLabel(request.last_error_category)}`;
  if (request.status === 'completed' || request.status === 'partial' || request.status === 'cancelled') {
    return request.status;
  }
  if (jobs.activeJobCount !== 1 || !jobs.activeJobStatus) return 'recovery needed';
  if (jobs.activeJobStatus === 'queued') {
    if (jobs.activeJobRunAfterMs !== null && jobs.activeJobRunAfterMs > nowMs) {
      return `retrying ${relativeTimestamp(jobs.activeJobRunAfterMs)}`;
    }
    if (request.status === 'synthesizing') return 'synthesis queued';
    return request.status === 'running' ? 'analysis queued' : 'queued';
  }
  if (request.status === 'synthesizing') return 'synthesizing';
  return request.status === 'running' ? 'analyzing' : 'planning';
}

function lastActivityAt(view: DeepRecapStatusView): number {
  return Math.max(view.request.updated_at_ms, view.jobs.latestJobUpdatedAtMs ?? 0);
}

export function formatDeepRecapReply(outcome: DeepRecapCommandOutcome): string {
  if (outcome.kind === 'not_authorized') return 'You are not authorized to manage deep recaps.';
  if (outcome.kind === 'invalid') return outcome.reason;
  if (outcome.kind === 'not_found') return 'No unique deep recap matched that id.';
  if (outcome.kind === 'started') {
    return `Deep recap ${outcome.request.id.slice(0, 8)} queued. ${progress(outcome.request)}. The budget is a ceiling, not a cost forecast; planning may use up to 30 analysis calls plus synthesis. The final report will be posted in this channel; use \`/mneme recap status\` to follow it.`;
  }
  if (outcome.kind === 'retried') {
    return `Deep recap ${outcome.request.id.slice(0, 8)} queued for synthesis from ${outcome.originalRequestId.slice(0, 8)}. Completed summaries and the existing spend ceiling were reused; message history will not be analyzed again. ${progress(outcome.request)}.`;
  }
  if (outcome.kind === 'cancelled') return `Deep recap ${outcome.request.id.slice(0, 8)} cancelled.`;
  if (outcome.requests.length === 0) return 'No deep recaps have been requested.';
  return outcome.requests.map((view) => {
    const detail = coverageDetail(view);
    return `${view.request.id.slice(0, 8)} · ${displayedState(view, outcome.nowMs)} · ${progress(view.request)}${detail ? ` · ${detail}` : ''} · updated ${relativeTimestamp(lastActivityAt(view))}`;
  }).join('\n');
}
