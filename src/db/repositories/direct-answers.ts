import { createHash } from 'node:crypto';
import type { DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';

/** Immutable maximum age of an interactive request before it must resolve. */
export const DIRECT_ANSWER_DEADLINE_MS = 120_000;

export type DirectAnswerOutcomeKind =
  | 'pending'
  | 'primary'
  | 'partial'
  | 'fallback'
  | 'suppressed';

/** Content-free, allowlisted terminal reason stored for operations and status. */
export type DirectAnswerReasonCategory =
  | 'none'
  | 'timeout'
  | 'admission_timeout'
  | 'deadline_exceeded'
  | 'budget'
  | 'no_finalization'
  | 'malformed'
  | 'model_error'
  | 'validation_rejection'
  | 'missing_source'
  | 'question_deleted'
  | 'target_invalid'
  | 'policy_disabled'
  | 'duplicate'
  | 'rate_limit';

export interface DirectAnswerCoverage {
  complete: boolean;
  omitted?: number | null;
  truncationReason?: 'none' | 'message_cap' | 'character_cap' | 'message_and_character_cap' | null;
  matchedMessages?: number | null;
  includedMessages?: number | null;
  matchedChannels?: number | null;
  includedChannels?: number | null;
  fromAtMs?: number | null;
  toAtMs?: number | null;
  oldestMatchedAtMs?: number | null;
  newestMatchedAtMs?: number | null;
  oldestIncludedAtMs?: number | null;
  newestIncludedAtMs?: number | null;
}

export interface DirectAnswerRequestRow {
  sourceMessageId: string;
  jobId: string | null;
  runId: string | null;
  outboxId: string | null;
  guildId: string;
  targetChannelId: string;
  questionCreatedAtMs: number;
  deadlineAtMs: number;
  responseIntentKey: string;
  outcomeKind: DirectAnswerOutcomeKind;
  reasonCategory: DirectAnswerReasonCategory;
  coverage: DirectAnswerCoverage | null;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  updatedAtMs: number;
}

/** A competing execution already made this request terminal. */
export class DirectAnswerCompletionConflictError extends Error {
  constructor() {
    super('direct-answer request was already completed');
    this.name = 'DirectAnswerCompletionConflictError';
  }
}

export interface DirectAnswerDeliveryCounts {
  queued: number;
  sent: number;
  failed: number;
}

export interface DirectAnswerStatus24h {
  windowStartAtMs: number;
  primary: DirectAnswerDeliveryCounts;
  partial: DirectAnswerDeliveryCounts;
  fallback: DirectAnswerDeliveryCounts;
  suppressed: number;
  /** Current backlog across all creation times, not limited to the 24h window. */
  pending: number;
  /** Current pending requests whose immutable response deadline has passed. */
  pendingOverdue: number;
  sentLatencyMs: {
    average: number | null;
    maximum: number | null;
    latest: number | null;
  };
}

interface DirectAnswerRequestDbRow {
  source_message_id: string;
  job_id: string | null;
  run_id: string | null;
  outbox_id: string | null;
  workspace_id: string;
  target_channel_id: string;
  question_created_at_ms: number;
  deadline_at_ms: number;
  response_intent_key: string;
  outcome_kind: DirectAnswerOutcomeKind;
  reason_category: DirectAnswerReasonCategory;
  coverage_complete: number | null;
  coverage_omitted: number | null;
  coverage_truncation_reason: DirectAnswerCoverage['truncationReason'];
  coverage_matched_messages: number | null;
  coverage_included_messages: number | null;
  coverage_matched_channels: number | null;
  coverage_included_channels: number | null;
  coverage_from_at_ms: number | null;
  coverage_to_at_ms: number | null;
  coverage_oldest_matched_at_ms: number | null;
  coverage_newest_matched_at_ms: number | null;
  coverage_oldest_included_at_ms: number | null;
  coverage_newest_included_at_ms: number | null;
  created_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  updated_at_ms: number;
}

const COLUMNS = `source_message_id, job_id, run_id, outbox_id, workspace_id, target_channel_id,
  question_created_at_ms, deadline_at_ms, response_intent_key, outcome_kind, reason_category,
  coverage_complete, coverage_omitted, coverage_truncation_reason,
  coverage_matched_messages, coverage_included_messages,
  coverage_matched_channels, coverage_included_channels, coverage_from_at_ms, coverage_to_at_ms,
  coverage_oldest_matched_at_ms, coverage_newest_matched_at_ms,
  coverage_oldest_included_at_ms, coverage_newest_included_at_ms,
  created_at_ms, started_at_ms, completed_at_ms, updated_at_ms`;

/** Opaque, stable delivery identity. It contains no message text or model output. */
export function directAnswerResponseIntentKey(sourceMessageId: string): string {
  const digest = createHash('sha256').update(sourceMessageId).digest('hex');
  return `direct-answer:v1:${digest}`;
}

/**
 * Insert the immutable request envelope once. Retries may attach a job id and
 * start time, but can never move its target, question time, deadline, or intent.
 */
export function ensureDirectAnswerRequest(
  db: DatabaseSync,
  input: {
    sourceMessageId: string;
    jobId?: string | null;
    guildId: string;
    targetChannelId: string;
    questionCreatedAtMs: number;
    deadlineAtMs: number;
    /** Null while merely queued; defaults to `now` for handler-side repair. */
    startedAtMs?: number | null;
    now: number;
  },
): DirectAnswerRequestRow {
  const responseIntentKey = directAnswerResponseIntentKey(input.sourceMessageId);
  prepareCached(db, 'direct_answer.request.ensure', `
    INSERT INTO direct_answer_requests (
      source_message_id, job_id, workspace_id, target_channel_id, question_created_at_ms,
      deadline_at_ms, response_intent_key, outcome_kind, reason_category,
      created_at_ms, started_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'none', ?, ?, ?)
    ON CONFLICT(source_message_id) DO UPDATE SET
      job_id = CASE
        WHEN direct_answer_requests.outcome_kind = 'pending' AND excluded.job_id IS NOT NULL
          THEN excluded.job_id
        ELSE direct_answer_requests.job_id
      END,
      started_at_ms = COALESCE(direct_answer_requests.started_at_ms, excluded.started_at_ms),
      updated_at_ms = MAX(direct_answer_requests.updated_at_ms, excluded.updated_at_ms)
  `).run(
    input.sourceMessageId,
    input.jobId ?? null,
    input.guildId,
    input.targetChannelId,
    input.questionCreatedAtMs,
    input.deadlineAtMs,
    responseIntentKey,
    input.now,
    input.startedAtMs === undefined ? input.now : input.startedAtMs,
    input.now,
  );
  const row = getDirectAnswerRequest(db, input.sourceMessageId);
  if (!row) throw new Error('direct-answer request insert did not persist');
  return row;
}

export function getDirectAnswerRequest(
  db: DatabaseSync,
  sourceMessageId: string,
): DirectAnswerRequestRow | undefined {
  const row = prepareCached(
    db,
    'direct_answer.request.get',
    `SELECT ${COLUMNS} FROM direct_answer_requests WHERE source_message_id = ?`,
  ).get(sourceMessageId) as DirectAnswerRequestDbRow | undefined;
  return row ? mapRow(row) : undefined;
}

/** Mark one pending request terminal. A retry cannot rewrite a prior outcome. */
export function completeDirectAnswerRequest(
  db: DatabaseSync,
  input: {
    sourceMessageId: string;
    outcomeKind: Exclude<DirectAnswerOutcomeKind, 'pending'>;
    reasonCategory: DirectAnswerReasonCategory;
    runId?: string | null;
    outboxId?: string | null;
    coverage?: DirectAnswerCoverage | null;
    now: number;
  },
): DirectAnswerRequestRow {
  const coverage = normalizeCoverage(input.coverage);
  const changed = Number(prepareCached(db, 'direct_answer.request.complete', `
    UPDATE direct_answer_requests
       SET run_id = ?,
           outbox_id = ?,
           outcome_kind = ?,
           reason_category = ?,
           coverage_complete = ?,
           coverage_omitted = ?,
           coverage_truncation_reason = ?,
           coverage_matched_messages = ?,
           coverage_included_messages = ?,
           coverage_matched_channels = ?,
           coverage_included_channels = ?,
           coverage_from_at_ms = ?,
           coverage_to_at_ms = ?,
           coverage_oldest_matched_at_ms = ?,
           coverage_newest_matched_at_ms = ?,
           coverage_oldest_included_at_ms = ?,
           coverage_newest_included_at_ms = ?,
           completed_at_ms = ?,
           updated_at_ms = ?
     WHERE source_message_id = ? AND outcome_kind = 'pending'
  `).run(
    input.runId ?? null,
    input.outboxId ?? null,
    input.outcomeKind,
    input.reasonCategory,
    coverage ? Number(coverage.complete) : null,
    coverage?.omitted ?? null,
    coverage?.truncationReason ?? null,
    coverage?.matchedMessages ?? null,
    coverage?.includedMessages ?? null,
    coverage?.matchedChannels ?? null,
    coverage?.includedChannels ?? null,
    coverage?.fromAtMs ?? null,
    coverage?.toAtMs ?? null,
    coverage?.oldestMatchedAtMs ?? null,
    coverage?.newestMatchedAtMs ?? null,
    coverage?.oldestIncludedAtMs ?? null,
    coverage?.newestIncludedAtMs ?? null,
    input.now,
    input.now,
    input.sourceMessageId,
  ).changes);
  const row = getDirectAnswerRequest(db, input.sourceMessageId);
  if (!row) throw new Error('direct-answer request disappeared during completion');
  // Callers perform outbox enqueue + completion in one transaction. Throwing
  // here rolls back a losing execution's newly inserted outbox/send job rather
  // than committing an orphan after another execution won the terminal race.
  if (changed === 0) throw new DirectAnswerCompletionConflictError();
  return row;
}

/** Rolling operational counts only; no message text, model output, or errors. */
export function collectDirectAnswerStatus24h(
  db: DatabaseSync,
  now: number,
): DirectAnswerStatus24h {
  const windowStartAtMs = now - 24 * 60 * 60 * 1_000;
  const rows = prepareCached(db, 'direct_answer.status.outcomes_24h', `
    SELECT dar.outcome_kind, COALESCE(o.status, 'none') AS delivery_status, COUNT(*) AS n
      FROM direct_answer_requests dar
      LEFT JOIN outbox o ON o.id = dar.outbox_id
     WHERE dar.completed_at_ms >= ? AND dar.completed_at_ms <= ?
     GROUP BY dar.outcome_kind, COALESCE(o.status, 'none')
  `).all(windowStartAtMs, now) as Array<{
    outcome_kind: DirectAnswerOutcomeKind;
    delivery_status: string;
    n: number;
  }>;
  const empty = (): DirectAnswerDeliveryCounts => ({ queued: 0, sent: 0, failed: 0 });
  const status: DirectAnswerStatus24h = {
    windowStartAtMs,
    primary: empty(),
    partial: empty(),
    fallback: empty(),
    suppressed: 0,
    pending: 0,
    pendingOverdue: 0,
    sentLatencyMs: { average: null, maximum: null, latest: null },
  };
  for (const row of rows) {
    const n = Number(row.n);
    if (row.outcome_kind === 'suppressed') {
      status.suppressed += n;
      continue;
    }
    if (
      row.outcome_kind !== 'primary'
      && row.outcome_kind !== 'partial'
      && row.outcome_kind !== 'fallback'
    ) continue;
    const bucket = status[row.outcome_kind];
    if (row.delivery_status === 'queued' || row.delivery_status === 'sending') bucket.queued += n;
    else if (row.delivery_status === 'sent') bucket.sent += n;
    else if (row.delivery_status === 'failed' || row.delivery_status === 'cancelled') bucket.failed += n;
  }
  const pending = prepareCached(db, 'direct_answer.status.pending', `
    SELECT COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN deadline_at_ms <= ? THEN 1 ELSE 0 END), 0) AS overdue
      FROM direct_answer_requests
     WHERE outcome_kind = 'pending'
  `).get(now) as { n: number; overdue: number } | undefined;
  status.pending = Number(pending?.n ?? 0);
  status.pendingOverdue = Number(pending?.overdue ?? 0);

  const latency = prepareCached(db, 'direct_answer.status.latency_24h', `
    SELECT AVG(o.sent_at_ms - dar.question_created_at_ms) AS average_ms,
           MAX(o.sent_at_ms - dar.question_created_at_ms) AS maximum_ms,
           (
             SELECT o2.sent_at_ms - dar2.question_created_at_ms
               FROM direct_answer_requests dar2
               JOIN outbox o2 ON o2.id = dar2.outbox_id
              WHERE dar2.completed_at_ms >= ? AND dar2.completed_at_ms <= ?
                AND o2.status = 'sent' AND o2.sent_at_ms IS NOT NULL
              ORDER BY o2.sent_at_ms DESC
              LIMIT 1
           ) AS latest_ms
      FROM direct_answer_requests dar
      JOIN outbox o ON o.id = dar.outbox_id
     WHERE dar.completed_at_ms >= ? AND dar.completed_at_ms <= ?
       AND o.status = 'sent' AND o.sent_at_ms IS NOT NULL
  `).get(windowStartAtMs, now, windowStartAtMs, now) as {
    average_ms: number | null;
    maximum_ms: number | null;
    latest_ms: number | null;
  } | undefined;
  if (latency) {
    status.sentLatencyMs = {
      average: latency.average_ms === null ? null : Math.max(0, Math.round(latency.average_ms)),
      maximum: latency.maximum_ms === null ? null : Math.max(0, Number(latency.maximum_ms)),
      latest: latency.latest_ms === null ? null : Math.max(0, Number(latency.latest_ms)),
    };
  }
  return status;
}

function normalizeCoverage(coverage: DirectAnswerCoverage | null | undefined): DirectAnswerCoverage | null {
  if (!coverage) return null;
  const count = (value: number | null | undefined): number | null =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  const time = (value: number | null | undefined): number | null =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
  return {
    complete: coverage.complete === true,
    omitted: count(coverage.omitted),
    truncationReason: coverage.truncationReason === 'none'
      || coverage.truncationReason === 'message_cap'
      || coverage.truncationReason === 'character_cap'
      || coverage.truncationReason === 'message_and_character_cap'
      ? coverage.truncationReason
      : null,
    matchedMessages: count(coverage.matchedMessages),
    includedMessages: count(coverage.includedMessages),
    matchedChannels: count(coverage.matchedChannels),
    includedChannels: count(coverage.includedChannels),
    fromAtMs: time(coverage.fromAtMs),
    toAtMs: time(coverage.toAtMs),
    oldestMatchedAtMs: time(coverage.oldestMatchedAtMs),
    newestMatchedAtMs: time(coverage.newestMatchedAtMs),
    oldestIncludedAtMs: time(coverage.oldestIncludedAtMs),
    newestIncludedAtMs: time(coverage.newestIncludedAtMs),
  };
}

function mapRow(row: DirectAnswerRequestDbRow): DirectAnswerRequestRow {
  const coverage = row.coverage_complete === null ? null : {
    complete: row.coverage_complete === 1,
    omitted: row.coverage_omitted,
    truncationReason: row.coverage_truncation_reason,
    matchedMessages: row.coverage_matched_messages,
    includedMessages: row.coverage_included_messages,
    matchedChannels: row.coverage_matched_channels,
    includedChannels: row.coverage_included_channels,
    fromAtMs: row.coverage_from_at_ms,
    toAtMs: row.coverage_to_at_ms,
    oldestMatchedAtMs: row.coverage_oldest_matched_at_ms,
    newestMatchedAtMs: row.coverage_newest_matched_at_ms,
    oldestIncludedAtMs: row.coverage_oldest_included_at_ms,
    newestIncludedAtMs: row.coverage_newest_included_at_ms,
  };
  return {
    sourceMessageId: row.source_message_id,
    jobId: row.job_id,
    runId: row.run_id,
    outboxId: row.outbox_id,
    guildId: row.workspace_id,
    targetChannelId: row.target_channel_id,
    questionCreatedAtMs: row.question_created_at_ms,
    deadlineAtMs: row.deadline_at_ms,
    responseIntentKey: row.response_intent_key,
    outcomeKind: row.outcome_kind,
    reasonCategory: row.reason_category,
    coverage,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}
