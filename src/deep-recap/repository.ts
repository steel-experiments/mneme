import { randomUUID } from 'node:crypto';
import { type DatabaseSync, transactionImmediate } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';
import { enqueue } from '../jobs/queue.js';

export type DeepRecapStatus =
  | 'queued' | 'running' | 'synthesizing'
  | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface DeepRecapRequestRow {
  id: string;
  workspace_id: string;
  target_channel_id: string;
  requested_by_user_id: string;
  retry_of_request_id: string | null;
  retry_root_request_id: string | null;
  topic: string | null;
  channel_ids_json: string;
  after_at_ms: number;
  before_at_ms: number;
  budget_usd: number;
  spent_usd: number;
  synthesis_cost_usd: number;
  status: DeepRecapStatus;
  total_matching_messages: number;
  included_messages: number;
  planned_chunks: number;
  completed_chunks: number;
  coverage_complete: number;
  outbox_id: string | null;
  last_error_category: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
}

export interface DeepRecapChunkRow {
  request_id: string;
  ordinal: number;
  after_at_ms: number;
  before_at_ms: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  matching_messages: number;
  included_messages: number;
  coverage_complete: number;
  split_depth: number;
  truncation_reason: DeepRecapTruncationReason;
  summary: string | null;
  cited_message_ids_json: string;
  source_message_ids_json: string;
  source_fingerprints_json: string;
  run_id: string | null;
  cost_usd: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export type DeepRecapTruncationReason =
  | 'none' | 'message_cap' | 'character_cap' | 'message_and_character_cap';

export interface DeepRecapCoverageDiagnostics {
  plannedIncludedMessages: number;
  omittedMessages: number;
  splitPartitions: number;
  maxSplitDepth: number;
  messageCapPartitions: number;
  characterCapPartitions: number;
  deliveryParts: number;
}

export type DeepRecapModelCallPhase = 'chunk' | 'synthesis';

export interface DeepRecapModelCallRow {
  id: string;
  request_id: string;
  run_id: string | null;
  phase: DeepRecapModelCallPhase;
  chunk_ordinal: number | null;
  started_at_ms: number;
  cost_usd: number | null;
  accounted_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface DeepRecapJobState {
  activeJobCount: number;
  activeJobStatus: 'queued' | 'running' | null;
  activeJobRunAfterMs: number | null;
  latestJobStatus: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | null;
  latestJobUpdatedAtMs: number | null;
}

export interface DeepRecapStatusView {
  request: DeepRecapRequestRow;
  jobs: DeepRecapJobState;
  coverage: DeepRecapCoverageDiagnostics;
}

export type DeepRecapSynthesisRetryBlockReason =
  | 'request_not_failed'
  | 'chunks_incomplete'
  | 'budget_exhausted'
  | 'failure_not_retryable'
  | 'lineage_superseded'
  | 'lineage_already_succeeded';

const RETRYABLE_SYNTHESIS_FAILURES = new Set([
  'DEEP_RECAP_REPORT_TOO_LONG',
  'processing_error',
]);

export interface CreateDeepRecapInput {
  guildId: string;
  targetChannelId: string;
  requestedByUserId: string;
  topic?: string | null;
  channelIds?: readonly string[];
  afterAtMs: number;
  beforeAtMs: number;
  budgetUsd: number;
  now: number;
}

export function createDeepRecap(
  db: DatabaseSync,
  input: CreateDeepRecapInput,
): DeepRecapRequestRow {
  const id = randomUUID();
  prepareCached(db, 'deep_recap.create', `
    INSERT INTO deep_recap_requests (
      id,workspace_id,target_channel_id,requested_by_user_id,retry_root_request_id,
      topic,channel_ids_json,
      after_at_ms,before_at_ms,budget_usd,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    input.guildId,
    input.targetChannelId,
    input.requestedByUserId,
    id,
    input.topic?.trim() || null,
    JSON.stringify([...new Set(input.channelIds ?? [])]),
    input.afterAtMs,
    input.beforeAtMs,
    input.budgetUsd,
    input.now,
    input.now,
  );
  return getDeepRecap(db, id)!;
}

export function getDeepRecap(db: DatabaseSync, id: string): DeepRecapRequestRow | undefined {
  return prepareCached(db, 'deep_recap.get', 'SELECT * FROM deep_recap_requests WHERE id=?')
    .get(id) as DeepRecapRequestRow | undefined;
}

export function latestDeepRecaps(
  db: DatabaseSync,
  guildId: string,
  limit = 5,
): DeepRecapRequestRow[] {
  return prepareCached(db, 'deep_recap.latest', `
    SELECT * FROM deep_recap_requests WHERE workspace_id=?
    ORDER BY created_at_ms DESC LIMIT ?
  `).all(guildId, Math.max(1, Math.min(10, limit))) as unknown as DeepRecapRequestRow[];
}

/**
 * Return recent requests together with their durable worker ownership.
 *
 * Follow-up recap jobs historically did not always carry a `unique_key`, so ownership
 * must be resolved from the validated JSON payload rather than from that optional field.
 * A lazy CASE around `json_extract` keeps a malformed retained job from breaking status.
 */
export function latestDeepRecapStatuses(
  db: DatabaseSync,
  guildId: string,
  limit = 5,
): DeepRecapStatusView[] {
  return latestDeepRecaps(db, guildId, limit).map((request) => {
    const lineage = deepRecapRetryLineageBudget(db, request);
    return {
      // Status reports authoritative lineage consumption, including a crash row
      // whose cost is recoverable from agent_runs but not reconciled into caches yet.
      request: lineage ? { ...request, spent_usd: lineage.spentUsd } : request,
      jobs: deepRecapJobState(db, request.id),
      coverage: deepRecapCoverageDiagnostics(db, request.id),
    };
  });
}

export function deepRecapCoverageDiagnostics(
  db: DatabaseSync,
  requestId: string,
): DeepRecapCoverageDiagnostics {
  const row = prepareCached(db, 'deep_recap.coverage_diagnostics', `
    SELECT COALESCE(SUM(included_messages),0) AS planned_included,
           COALESCE(SUM(MAX(matching_messages-included_messages,0)),0) AS omitted,
           COALESCE(SUM(CASE WHEN split_depth>0 THEN 1 ELSE 0 END),0) AS split_partitions,
           COALESCE(MAX(split_depth),0) AS max_split_depth,
           COALESCE(SUM(CASE WHEN truncation_reason IN
             ('message_cap','message_and_character_cap') THEN 1 ELSE 0 END),0) AS message_caps,
           COALESCE(SUM(CASE WHEN truncation_reason IN
             ('character_cap','message_and_character_cap') THEN 1 ELSE 0 END),0) AS character_caps,
           (SELECT COUNT(*) FROM deep_recap_delivery_parts WHERE request_id=?) AS delivery_parts
      FROM deep_recap_chunks WHERE request_id=?
  `).get(requestId, requestId) as Record<string, number>;
  return {
    plannedIncludedMessages: Number(row.planned_included),
    omittedMessages: Number(row.omitted),
    splitPartitions: Number(row.split_partitions),
    maxSplitDepth: Number(row.max_split_depth),
    messageCapPartitions: Number(row.message_caps),
    characterCapPartitions: Number(row.character_caps),
    deliveryParts: Number(row.delivery_parts),
  };
}

export function deepRecapJobState(db: DatabaseSync, recapId: string): DeepRecapJobState {
  const row = prepareCached(db, 'deep_recap.job_state', `
    WITH recap_jobs AS (
      SELECT status,run_after_ms,updated_at_ms,created_at_ms
        FROM jobs
       WHERE type='deep_recap'
         AND CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json,'$.recapId')
                  ELSE NULL END = ?
    )
    SELECT
      (SELECT COUNT(*) FROM recap_jobs WHERE status IN ('queued','running')) AS active_count,
      (SELECT status FROM recap_jobs
        WHERE status IN ('queued','running')
        ORDER BY updated_at_ms DESC,created_at_ms DESC LIMIT 1) AS active_status,
      (SELECT run_after_ms FROM recap_jobs
        WHERE status IN ('queued','running')
        ORDER BY updated_at_ms DESC,created_at_ms DESC LIMIT 1) AS active_run_after_ms,
      (SELECT status FROM recap_jobs
        ORDER BY updated_at_ms DESC,created_at_ms DESC LIMIT 1) AS latest_status,
      (SELECT updated_at_ms FROM recap_jobs
        ORDER BY updated_at_ms DESC,created_at_ms DESC LIMIT 1) AS latest_updated_at_ms
  `).get(recapId) as {
    active_count: number;
    active_status: DeepRecapJobState['activeJobStatus'];
    active_run_after_ms: number | null;
    latest_status: DeepRecapJobState['latestJobStatus'];
    latest_updated_at_ms: number | null;
  };
  return {
    activeJobCount: Number(row.active_count),
    activeJobStatus: row.active_status,
    activeJobRunAfterMs: row.active_run_after_ms,
    latestJobStatus: row.latest_status,
    latestJobUpdatedAtMs: row.latest_updated_at_ms,
  };
}

export function resolveDeepRecapRef(
  db: DatabaseSync,
  guildId: string,
  ref: string,
): DeepRecapRequestRow | undefined {
  const rows = prepareCached(db, 'deep_recap.resolve_ref', `
    SELECT * FROM deep_recap_requests
     WHERE workspace_id=? AND (id=? OR id LIKE ?)
     ORDER BY created_at_ms DESC LIMIT 2
  `).all(guildId, ref, `${ref}%`) as unknown as DeepRecapRequestRow[];
  return rows.length === 1 ? rows[0] : undefined;
}

export interface DeepRecapRetryLineageBudget {
  rootRequestId: string;
  budgetUsd: number;
  spentUsd: number;
  hasDirectRetry: boolean;
  hasCompletedOrPartialResult: boolean;
}

/**
 * Resolve the immutable root ceiling, actual provider spend, and terminal state for a
 * retry lineage. The timestamped per-call ledger is authoritative; unsettled crash rows
 * derive their cost from `agent_runs`. Copied chunks have no call rows, so retries cannot
 * count inherited spend twice. A direct child means this request is no longer the leaf.
 */
export function deepRecapRetryLineageBudget(
  db: DatabaseSync,
  request: DeepRecapRequestRow,
): DeepRecapRetryLineageBudget | undefined {
  const rootRequestId = request.retry_root_request_id ?? request.id;
  const root = getDeepRecap(db, rootRequestId);
  if (!root || root.workspace_id !== request.workspace_id) return undefined;
  const row = prepareCached(db, 'deep_recap.retry_lineage_state', `
    SELECT
      COALESCE((
        SELECT SUM(COALESCE(mc.cost_usd,ar.cost_usd,0))
          FROM deep_recap_model_calls mc
          JOIN deep_recap_requests r ON r.id=mc.request_id
          LEFT JOIN agent_runs ar ON ar.id=mc.run_id
         WHERE r.retry_root_request_id=?
            OR (r.id=? AND r.retry_root_request_id IS NULL)
      ),0) AS spent,
      EXISTS (
        SELECT 1
          FROM deep_recap_requests r
         WHERE (r.retry_root_request_id=?
            OR (r.id=? AND r.retry_root_request_id IS NULL))
           AND r.status IN ('completed','partial')
      ) AS has_completed_or_partial_result,
      EXISTS (
        SELECT 1
          FROM deep_recap_requests child
         WHERE child.retry_of_request_id=?
      ) AS has_direct_retry
  `).get(
    rootRequestId,
    rootRequestId,
    rootRequestId,
    rootRequestId,
    request.id,
  ) as {
    spent: number;
    has_completed_or_partial_result: number;
    has_direct_retry: number;
  };
  return {
    rootRequestId,
    budgetUsd: root.budget_usd,
    spentUsd: Number(row.spent),
    hasDirectRetry: Boolean(row.has_direct_retry),
    hasCompletedOrPartialResult: Boolean(row.has_completed_or_partial_result),
  };
}

function assertModelCallShape(input: {
  phase: DeepRecapModelCallPhase;
  chunkOrdinal?: number | null;
}): number | null {
  const ordinal = input.chunkOrdinal ?? null;
  if (input.phase === 'chunk') {
    if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0) {
      throw new TypeError('chunk model calls require a non-negative chunkOrdinal');
    }
    return ordinal;
  }
  if (ordinal !== null) throw new TypeError('synthesis model calls cannot have a chunkOrdinal');
  return null;
}

/**
 * Persist recap ownership of a caller-selected run id before model admission.
 *
 * This reservation intentionally precedes `agent_runs`: if the process dies after
 * executeAgentRun persists billable usage, the run id still joins that usage to the
 * recap. Replaying an identical reservation is harmless; conflicting reuse fails.
 */
export function reserveDeepRecapModelCall(
  db: DatabaseSync,
  input: {
    requestId: string;
    runId: string;
    phase: DeepRecapModelCallPhase;
    chunkOrdinal?: number | null;
    startedAtMs: number;
    now: number;
  },
): boolean {
  if (!input.runId) throw new TypeError('runId is required');
  const ordinal = assertModelCallShape(input);
  const inserted = Number(prepareCached(db, 'deep_recap.reserve_model_call', `
    INSERT OR IGNORE INTO deep_recap_model_calls (
      id,request_id,run_id,phase,chunk_ordinal,started_at_ms,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    `run:${input.runId}`,
    input.requestId,
    input.runId,
    input.phase,
    ordinal,
    input.startedAtMs,
    input.now,
    input.now,
  ).changes) === 1;
  if (inserted) return true;
  const existing = prepareCached(db, 'deep_recap.model_call_by_run', `
    SELECT * FROM deep_recap_model_calls WHERE run_id=?
  `).get(input.runId) as DeepRecapModelCallRow | undefined;
  if (
    existing
    && existing.request_id === input.requestId
    && existing.phase === input.phase
    && existing.chunk_ordinal === ordinal
    && existing.started_at_ms === input.startedAtMs
  ) return false;
  throw new Error('deep recap model run id was already reserved for different work');
}

/** Settle one reserved call and update request/chunk display aggregates exactly once. */
export function settleDeepRecapModelCallCost(
  db: DatabaseSync,
  input: { runId: string; costUsd: number; now: number },
): boolean {
  if (!input.runId) throw new TypeError('runId is required');
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
    throw new TypeError('costUsd must be a finite non-negative number');
  }
  return transactionImmediate(db, () => {
    const call = prepareCached(db, 'deep_recap.model_call_by_run', `
      SELECT * FROM deep_recap_model_calls WHERE run_id=?
    `).get(input.runId) as DeepRecapModelCallRow | undefined;
    if (!call) throw new Error('deep recap model call was not reserved');
    if (call.cost_usd !== null) {
      if (call.cost_usd === input.costUsd) return false;
      throw new Error('deep recap model call cost conflicts with its settled value');
    }
    const changed = Number(prepareCached(db, 'deep_recap.settle_model_call', `
      UPDATE deep_recap_model_calls
         SET cost_usd=?,accounted_at_ms=?,updated_at_ms=?
       WHERE run_id=? AND cost_usd IS NULL
    `).run(input.costUsd, input.now, input.now, input.runId).changes);
    if (changed !== 1) throw new Error('deep recap model call could not be settled');
    if (call.phase === 'synthesis') {
      prepareCached(db, 'deep_recap.add_synthesis_call_cost', `
        UPDATE deep_recap_requests
           SET synthesis_cost_usd=synthesis_cost_usd+?,spent_usd=spent_usd+?,updated_at_ms=?
         WHERE id=?
      `).run(input.costUsd, input.costUsd, input.now, call.request_id);
    } else {
      prepareCached(db, 'deep_recap.add_chunk_call_cost', `
        UPDATE deep_recap_chunks SET cost_usd=cost_usd+?,updated_at_ms=?
         WHERE request_id=? AND ordinal=?
      `).run(input.costUsd, input.now, call.request_id, call.chunk_ordinal);
      prepareCached(db, 'deep_recap.add_request_call_cost', `
        UPDATE deep_recap_requests SET spent_usd=spent_usd+?,updated_at_ms=? WHERE id=?
      `).run(input.costUsd, input.now, call.request_id);
    }
    return true;
  });
}

/** Recover costs whose agent run committed before caller-side settlement. */
export function reconcileDeepRecapModelCallCosts(
  db: DatabaseSync,
  requestId: string,
  now: number,
): number {
  // A prior process can die after reservation but before executeAgentRun's
  // synchronous agent_runs insert. With one durable owner per recap, a later
  // handler pass can prove that a reservation lacking that row was never billed.
  prepareCached(db, 'deep_recap.purge_unstarted_model_calls', `
    DELETE FROM deep_recap_model_calls
     WHERE request_id=? AND run_id IS NOT NULL AND cost_usd IS NULL
       AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=deep_recap_model_calls.run_id)
  `).run(requestId);
  const rows = prepareCached(db, 'deep_recap.unsettled_model_calls', `
    SELECT mc.run_id,ar.cost_usd
      FROM deep_recap_model_calls mc
      JOIN agent_runs ar ON ar.id=mc.run_id
     WHERE mc.request_id=? AND mc.cost_usd IS NULL AND ar.cost_usd IS NOT NULL
     ORDER BY mc.started_at_ms,mc.id
  `).all(requestId) as unknown as Array<{ run_id: string; cost_usd: number }>;
  let settled = 0;
  for (const row of rows) {
    if (settleDeepRecapModelCallCost(db, {
      runId: row.run_id,
      costUsd: Number(row.cost_usd),
      now,
    })) settled += 1;
  }
  return settled;
}

/**
 * Drop a pre-admission reservation only when executeAgentRun never created its run row.
 * Once that row exists the association is retained, even if usage is not settled yet.
 */
export function releaseUnusedDeepRecapModelCall(
  db: DatabaseSync,
  runId: string,
): boolean {
  return Number(prepareCached(db, 'deep_recap.release_unused_model_call', `
    DELETE FROM deep_recap_model_calls
     WHERE run_id=? AND cost_usd IS NULL
       AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=?)
  `).run(runId, runId).changes) === 1;
}

/** Timestamped organization-day spend for the deep-recap policy cap. */
export function deepRecapDailySpend(db: DatabaseSync, since: number): number {
  const row = prepareCached(db, 'deep_recap.daily_model_call_spend', `
    SELECT COALESCE(SUM(COALESCE(mc.cost_usd,ar.cost_usd,0)),0) AS spent
      FROM deep_recap_model_calls mc
      LEFT JOIN agent_runs ar ON ar.id=mc.run_id
     WHERE mc.started_at_ms>=?
  `).get(since) as { spent: number };
  return Number(row.spent);
}

export function deepRecapSynthesisRetryBlockReason(
  db: DatabaseSync,
  request: DeepRecapRequestRow,
): DeepRecapSynthesisRetryBlockReason | null {
  if (request.status !== 'failed') return 'request_not_failed';
  if (request.planned_chunks <= 0 || request.completed_chunks !== request.planned_chunks) {
    return 'chunks_incomplete';
  }
  if (!request.last_error_category || !RETRYABLE_SYNTHESIS_FAILURES.has(request.last_error_category)) {
    return 'failure_not_retryable';
  }
  const lineage = deepRecapRetryLineageBudget(db, request);
  if (!lineage) return 'failure_not_retryable';
  if (lineage.hasCompletedOrPartialResult) return 'lineage_already_succeeded';
  if (lineage.hasDirectRetry) return 'lineage_superseded';
  if (lineage.spentUsd >= lineage.budgetUsd) return 'budget_exhausted';
  return null;
}

/**
 * Create a fresh synthesis attempt from a failed request's completed summaries.
 *
 * The new request id deliberately creates a new response-intent identity, so a report
 * cannot collide with the old request's already-queued failure notice. Prior spend is
 * carried into the new request ceiling, while copied chunks have zero cost: the original
 * rows remain the organization-day accounting authority and are not counted twice. A
 * failed request can have only one child, so retries form one serialized, latest-leaf
 * chain rather than branching from older ancestors.
 */
export function retryDeepRecapSynthesis(
  db: DatabaseSync,
  input: { requestId: string; requestedByUserId: string; now: number },
): DeepRecapRequestRow | undefined {
  const original = getDeepRecap(db, input.requestId);
  if (!original || deepRecapSynthesisRetryBlockReason(db, original)) return undefined;

  return transactionImmediate(db, () => {
    const current = getDeepRecap(db, original.id);
    if (!current || deepRecapSynthesisRetryBlockReason(db, current)) return undefined;
    const lineage = deepRecapRetryLineageBudget(db, current);
    if (!lineage) return undefined;
    const id = randomUUID();
    const inserted = Number(prepareCached(db, 'deep_recap.retry_synthesis', `
      INSERT INTO deep_recap_requests (
        id,workspace_id,target_channel_id,requested_by_user_id,retry_of_request_id,
        retry_root_request_id,topic,channel_ids_json,after_at_ms,before_at_ms,
        budget_usd,spent_usd,synthesis_cost_usd,status,
        total_matching_messages,included_messages,planned_chunks,completed_chunks,
        coverage_complete,outbox_id,last_error_category,created_at_ms,updated_at_ms,
        completed_at_ms
      )
      SELECT ?,workspace_id,target_channel_id,?,?,?,topic,channel_ids_json,
             after_at_ms,before_at_ms,?,?,0,'synthesizing',
             total_matching_messages,included_messages,planned_chunks,completed_chunks,
             coverage_complete,NULL,NULL,?,?,NULL
        FROM deep_recap_requests
       WHERE id=? AND status='failed'
         AND planned_chunks>0 AND completed_chunks=planned_chunks
         AND last_error_category IN ('DEEP_RECAP_REPORT_TOO_LONG','processing_error')
    `).run(
      id,
      input.requestedByUserId,
      current.id,
      lineage.rootRequestId,
      lineage.budgetUsd,
      lineage.spentUsd,
      input.now,
      input.now,
      current.id,
    ).changes);
    if (inserted !== 1) return undefined;

    const copied = Number(prepareCached(db, 'deep_recap.retry_copy_chunks', `
      INSERT INTO deep_recap_chunks (
        request_id,ordinal,after_at_ms,before_at_ms,status,matching_messages,
        included_messages,coverage_complete,split_depth,truncation_reason,summary,cited_message_ids_json,
        source_message_ids_json,source_fingerprints_json,run_id,cost_usd,
        created_at_ms,updated_at_ms
      )
      SELECT ?,ordinal,after_at_ms,before_at_ms,'completed',matching_messages,
             included_messages,coverage_complete,split_depth,truncation_reason,summary,cited_message_ids_json,
             source_message_ids_json,source_fingerprints_json,run_id,0,?,?
        FROM deep_recap_chunks
       WHERE request_id=? AND status='completed'
       ORDER BY ordinal
    `).run(id, input.now, input.now, current.id).changes);
    if (copied !== current.planned_chunks) {
      throw new Error('deep recap synthesis retry did not copy every completed chunk');
    }

    enqueue(db, {
      type: 'deep_recap',
      payload: { recapId: id },
      uniqueKey: `deep-recap:${id}`,
      priority: 30,
      maxAttempts: 3,
      now: input.now,
    });
    return getDeepRecap(db, id)!;
  });
}

/**
 * Compatibility helper for callers that do not have an agent run id.
 *
 * Production reserves real run ids through `reserveDeepRecapModelCall`; this CAS path
 * still writes a timestamped synthetic ledger row so lineage gates have one authority.
 */
export function recordDeepRecapSynthesisCostOnce(
  db: DatabaseSync,
  input: {
    id: string;
    expectedSynthesisCostUsd: number;
    costUsd: number;
    now: number;
  },
): boolean {
  if (!Number.isFinite(input.expectedSynthesisCostUsd) || input.expectedSynthesisCostUsd < 0) {
    throw new TypeError('expectedSynthesisCostUsd must be a finite non-negative number');
  }
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
    throw new TypeError('costUsd must be a finite non-negative number');
  }
  // A zero-cost CAS cannot supply a unique replay identity.
  if (input.costUsd === 0) return false;
  return transactionImmediate(db, () => {
    const current = getDeepRecap(db, input.id);
    if (!current || current.synthesis_cost_usd !== input.expectedSynthesisCostUsd) return false;
    const id = `legacy:synthesis-cas:${input.id}:${input.expectedSynthesisCostUsd}`;
    const inserted = Number(prepareCached(db, 'deep_recap.record_legacy_synthesis_call', `
      INSERT OR IGNORE INTO deep_recap_model_calls (
        id,request_id,run_id,phase,chunk_ordinal,started_at_ms,cost_usd,
        accounted_at_ms,created_at_ms,updated_at_ms
      ) VALUES (?,?,NULL,'synthesis',NULL,?,?,?,?,?)
    `).run(
      id,
      input.id,
      input.now,
      input.costUsd,
      input.now,
      input.now,
      input.now,
    ).changes);
    if (inserted !== 1) return false;
    const updated = Number(prepareCached(db, 'deep_recap.record_synthesis_cost_once', `
      UPDATE deep_recap_requests
         SET synthesis_cost_usd=synthesis_cost_usd+?,
             spent_usd=spent_usd+?,
             updated_at_ms=?
       WHERE id=? AND synthesis_cost_usd=?
    `).run(
      input.costUsd,
      input.costUsd,
      input.now,
      input.id,
      input.expectedSynthesisCostUsd,
    ).changes);
    if (updated !== 1) throw new Error('deep recap synthesis cost CAS lost after ledger insert');
    return true;
  });
}

export function cancelDeepRecap(db: DatabaseSync, id: string, now: number): boolean {
  const changed = Number(prepareCached(db, 'deep_recap.cancel', `
    UPDATE deep_recap_requests
       SET status='cancelled',completed_at_ms=?,updated_at_ms=?
     WHERE id=? AND status IN ('queued','running','synthesizing')
  `).run(now, now, id).changes) > 0;
  if (changed) {
    prepareCached(db, 'deep_recap.cancel_jobs', `
      UPDATE jobs SET status='cancelled',completed_at_ms=?,updated_at_ms=?
       WHERE type='deep_recap' AND unique_key=? AND status='queued'
    `).run(now, now, `deep-recap:${id}`);
  }
  return changed;
}

export function replaceDeepRecapPlan(
  db: DatabaseSync,
  requestId: string,
  chunks: ReadonlyArray<{
    afterAtMs: number;
    beforeAtMs: number;
    matchingMessages: number;
    includedMessages: number;
    complete: boolean;
    splitDepth?: number;
    truncationReason?: DeepRecapTruncationReason;
  }>,
  now: number,
): void {
  prepareCached(db, 'deep_recap.delete_plan',
    "DELETE FROM deep_recap_chunks WHERE request_id=? AND status='pending'").run(requestId);
  const insert = prepareCached(db, 'deep_recap.insert_chunk', `
    INSERT INTO deep_recap_chunks (
      request_id,ordinal,after_at_ms,before_at_ms,matching_messages,
      included_messages,coverage_complete,split_depth,truncation_reason,created_at_ms,updated_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  chunks.forEach((chunk, ordinal) => insert.run(
    requestId, ordinal, chunk.afterAtMs, chunk.beforeAtMs,
    chunk.matchingMessages, chunk.includedMessages, chunk.complete ? 1 : 0,
    chunk.splitDepth ?? 0, chunk.truncationReason ?? (chunk.complete ? 'none' : 'message_cap'), now, now,
  ));
  const total = chunks.reduce((sum, chunk) => sum + chunk.matchingMessages, 0);
  prepareCached(db, 'deep_recap.plan_request', `
    UPDATE deep_recap_requests
       SET status='running',planned_chunks=?,total_matching_messages=?,included_messages=?,
           coverage_complete=?,updated_at_ms=?
     WHERE id=? AND status='queued'
  `).run(
    chunks.length,
    total,
    0,
    chunks.every((chunk) => chunk.complete) ? 1 : 0,
    now,
    requestId,
  );
}

export function nextDeepRecapChunk(
  db: DatabaseSync,
  requestId: string,
): DeepRecapChunkRow | undefined {
  return prepareCached(db, 'deep_recap.next_chunk', `
    SELECT * FROM deep_recap_chunks
     WHERE request_id=? AND status='pending'
     ORDER BY ordinal ASC LIMIT 1
  `).get(requestId) as DeepRecapChunkRow | undefined;
}

export function completedDeepRecapChunks(
  db: DatabaseSync,
  requestId: string,
): DeepRecapChunkRow[] {
  return prepareCached(db, 'deep_recap.completed_chunks', `
    SELECT * FROM deep_recap_chunks
     WHERE request_id=? AND status='completed'
     ORDER BY ordinal ASC
  `).all(requestId) as unknown as DeepRecapChunkRow[];
}

export function allDeepRecapChunks(
  db: DatabaseSync,
  requestId: string,
): DeepRecapChunkRow[] {
  return prepareCached(db, 'deep_recap.all_chunks', `
    SELECT * FROM deep_recap_chunks
     WHERE request_id=?
     ORDER BY ordinal ASC
  `).all(requestId) as unknown as DeepRecapChunkRow[];
}

export function completeDeepRecapChunk(
  db: DatabaseSync,
  input: {
    requestId: string;
    ordinal: number;
    matchingMessages: number;
    includedMessages: number;
    coverageComplete: boolean;
    truncationReason?: DeepRecapTruncationReason;
    summary: string;
    citedMessageIds: readonly string[];
    sourceMessageIds: readonly string[];
    sourceFingerprints: ReadonlyArray<{ messageId: string; fingerprint: string }>;
    runId?: string | null;
    costUsd: number;
    now: number;
  },
): boolean {
  const changed = Number(prepareCached(db, 'deep_recap.complete_chunk', `
    UPDATE deep_recap_chunks
       SET status='completed',matching_messages=?,included_messages=?,coverage_complete=?,truncation_reason=?,
           summary=?,cited_message_ids_json=?,source_message_ids_json=?,
           source_fingerprints_json=?,run_id=?,updated_at_ms=?
     WHERE request_id=? AND ordinal=? AND status IN ('pending','running')
  `).run(
    input.matchingMessages,
    input.includedMessages,
    input.coverageComplete ? 1 : 0,
    input.truncationReason ?? (input.coverageComplete ? 'none' : 'message_cap'),
    input.summary,
    JSON.stringify([...new Set(input.citedMessageIds)]),
    JSON.stringify([...new Set(input.sourceMessageIds)]),
    JSON.stringify(input.sourceFingerprints),
    input.runId ?? null,
    input.now,
    input.requestId,
    input.ordinal,
  ).changes) > 0;
  if (!changed) return false;

  const existingCalls = Number((prepareCached(db, 'deep_recap.chunk_model_call_count', `
    SELECT COUNT(*) AS count FROM deep_recap_model_calls
     WHERE request_id=? AND phase='chunk' AND chunk_ordinal=?
  `).get(input.requestId, input.ordinal) as { count: number }).count);
  if (existingCalls === 0 && input.costUsd > 0) {
    const inserted = Number(prepareCached(db, 'deep_recap.record_legacy_chunk_call', `
      INSERT OR IGNORE INTO deep_recap_model_calls (
        id,request_id,run_id,phase,chunk_ordinal,started_at_ms,cost_usd,
        accounted_at_ms,created_at_ms,updated_at_ms
      ) VALUES (?,?,?,'chunk',?,?,?,?,?,?)
    `).run(
      `legacy:chunk-completion:${input.requestId}:${input.ordinal}`,
      input.requestId,
      input.runId ?? null,
      input.ordinal,
      input.now,
      input.costUsd,
      input.now,
      input.now,
      input.now,
    ).changes);
    if (inserted === 1) {
      prepareCached(db, 'deep_recap.add_request_call_cost', `
        UPDATE deep_recap_requests SET spent_usd=spent_usd+?,updated_at_ms=? WHERE id=?
      `).run(input.costUsd, input.now, input.requestId);
    }
  }
  prepareCached(db, 'deep_recap.refresh_chunk_call_cost', `
    UPDATE deep_recap_chunks
       SET cost_usd=COALESCE((
         SELECT SUM(COALESCE(mc.cost_usd,ar.cost_usd,0))
           FROM deep_recap_model_calls mc
           LEFT JOIN agent_runs ar ON ar.id=mc.run_id
          WHERE mc.request_id=? AND mc.phase='chunk' AND mc.chunk_ordinal=?
       ),0)
     WHERE request_id=? AND ordinal=?
  `).run(input.requestId, input.ordinal, input.requestId, input.ordinal);
  prepareCached(db, 'deep_recap.bump_progress', `
    UPDATE deep_recap_requests
       SET completed_chunks=(SELECT COUNT(*) FROM deep_recap_chunks
                              WHERE request_id=? AND status='completed'),
           included_messages=(SELECT COALESCE(SUM(included_messages),0)
                                FROM deep_recap_chunks
                               WHERE request_id=? AND status='completed'),
           total_matching_messages=(SELECT COALESCE(SUM(matching_messages),0)
                                      FROM deep_recap_chunks WHERE request_id=?),
           coverage_complete=CASE WHEN EXISTS (
             SELECT 1 FROM deep_recap_chunks
              WHERE request_id=? AND coverage_complete=0
           ) THEN 0 ELSE 1 END,
           updated_at_ms=?
     WHERE id=?
  `).run(
    input.requestId,
    input.requestId,
    input.requestId,
    input.requestId,
    input.now,
    input.requestId,
  );
  return true;
}

export function markDeepRecapSynthesizing(db: DatabaseSync, id: string, now: number): void {
  prepareCached(db, 'deep_recap.synthesizing', `
    UPDATE deep_recap_requests SET status='synthesizing',updated_at_ms=?
     WHERE id=? AND status IN ('queued','running')
  `).run(now, id);
}

export function finishDeepRecap(
  db: DatabaseSync,
  input: {
    id: string;
    status: 'completed' | 'partial' | 'failed';
    outboxId?: string | null;
    errorCategory?: string | null;
    now: number;
  },
): void {
  prepareCached(db, 'deep_recap.finish', `
    UPDATE deep_recap_requests
       SET status=?,outbox_id=?,last_error_category=?,
           completed_at_ms=?,updated_at_ms=?
     WHERE id=? AND status IN ('queued','running','synthesizing')
  `).run(
    input.status,
    input.outboxId ?? null,
    input.errorCategory ?? null,
    input.now,
    input.now,
    input.id,
  );
}

/** Persist the ordered outbox rows that constitute one recap response. */
export function recordDeepRecapDeliveryPart(
  db: DatabaseSync,
  input: {
    requestId: string;
    ordinal: number;
    kind: 'report' | 'coverage' | 'notice';
    outboxId: string;
    now: number;
  },
): void {
  prepareCached(db, 'deep_recap.record_delivery_part', `
    INSERT INTO deep_recap_delivery_parts (request_id,ordinal,kind,outbox_id,created_at_ms)
    VALUES (?,?,?,?,?)
    ON CONFLICT(request_id,ordinal) DO NOTHING
  `).run(input.requestId, input.ordinal, input.kind, input.outboxId, input.now);
  const row = prepareCached(db, 'deep_recap.delivery_part_identity', `
    SELECT kind,outbox_id FROM deep_recap_delivery_parts WHERE request_id=? AND ordinal=?
  `).get(input.requestId, input.ordinal) as { kind: string; outbox_id: string } | undefined;
  if (!row || row.kind !== input.kind || row.outbox_id !== input.outboxId) {
    throw new Error('deep recap delivery part identity conflict');
  }
}
