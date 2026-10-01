import { randomUUID, createHash } from 'node:crypto';
import { type DatabaseSync, transaction, transactionImmediate } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';
import { enqueue } from '../jobs/queue.js';

/**
 * Durable outbox enqueue (Sections 9.1, 10.1, 25; migration 003).
 *
 * Discord message creation is at-least-once and has no idempotency key, so the
 * `outbox.dedupe_key` UNIQUE column is the only thing that makes storage
 * effectively-once: repeated approval or routing of the same proposal cannot
 * produce two outbox rows for the same intended Discord message. The key is
 * derived from immutable proposal/send identity (never from content alone when a
 * proposal anchor exists), so a re-enqueue after a crash, a duplicate approval
 * click, or a re-route all collapse onto the original row.
 *
 * This module only enqueues and reads rows. The send path — claiming a due row,
 * marking it `sending` before the network call, and recording the Discord message
 * id — is the sender (Section 10.1). Crash recovery for rows left in
 * `sending` is likewise separate.
 *
 * Network calls are never made while holding a SQLite transaction (Section 9.1);
 * callers that want atomicity with the proposal approval wrap the
 * {@link enqueueOutbox} call and the proposals insert in one transaction.
 */

/** The set of `outbox.status` values accepted by the schema CHECK. */
export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface OutboxRow {
  id: string;
  proposalId: string | null;
  channelId: string;
  replyToMessageId: string | null;
  content: string;
  dedupeKey: string;
  dedupeMarker: string | null;
  status: OutboxStatus;
  platformMessageId: string | null;
  attempts: number;
  nextAttemptAtMs: number;
  lastError: string | null;
  createdAtMs: number;
  sentAtMs: number | null;
  updatedAtMs: number;
}

export interface EnqueueOutboxInput {
  /** Proposal that authorized this send; the dedupe anchor when present. */
  proposalId?: string | null;
  /** Run that produced the send (identity for ordinary proposal-less sends). */
  runId?: string | null;
  /**
   * Stable host-owned response identity. When present it supersedes run/content
   * identity so retries and a primary/fallback race collapse to one send.
   */
  responseIntentKey?: string | null;
  /** Host-pinned target channel (validated upstream by the outbound-evidence gate). */
  channelId: string;
  /** Safe outbound message text (already host-validated for scope and mentions). */
  content: string;
  /** Optional reply anchor in the target channel (validated upstream). */
  replyToMessageId?: string | null;
  /** Epoch ms when the first send attempt becomes due (defaults to `now`). */
  nextAttemptAtMs?: number;
  now: number;
}

export interface EnqueueOutboxResult {
  outboxId: string;
  dedupeKey: string;
  /** True when a new row was inserted; false when an identical row already existed. */
  enqueued: boolean;
}

interface OutboxDbRow {
  id: string;
  proposal_id: string | null;
  channel_id: string;
  reply_to_message_id: string | null;
  content: string;
  dedupe_key: string;
  dedupe_marker: string | null;
  status: OutboxStatus;
  platform_message_id: string | null;
  attempts: number;
  next_attempt_at_ms: number;
  last_error: string | null;
  created_at_ms: number;
  sent_at_ms: number | null;
  updated_at_ms: number;
}

const COLUMNS = `id, proposal_id, channel_id, reply_to_message_id, content, dedupe_key, dedupe_marker,
  status, platform_message_id, attempts, next_attempt_at_ms, last_error, created_at_ms,
  sent_at_ms, updated_at_ms`;

const ENQUEUE_SQL = `
  INSERT INTO outbox (id, proposal_id, channel_id, reply_to_message_id, content,
                      dedupe_key, dedupe_marker, status, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
  VALUES (@id, @proposal_id, @channel_id, @reply_to_message_id, @content,
          @dedupe_key, @dedupe_marker, 'queued', 0, @next_attempt_at_ms, @now, @now)
  ON CONFLICT(dedupe_key) DO NOTHING
`;

/**
 * Derive the stable dedupe key from immutable proposal/send identity.
 *
 * When a proposal authorized the send, the proposal id alone identifies the
 * intended message (one approved proposal → one outbound message), so content is
 * deliberately excluded — a re-enqueue collapses even if content were recomputed.
 * A host-owned response intent similarly identifies one addressed question across
 * primary/fallback races and run retries. Without either stable anchor, identity
 * falls back to run + target channel + a hash of the content, so distinct messages
 * do not collide but the same message does.
 */
export function computeDedupeKey(input: {
  proposalId?: string | null;
  runId?: string | null;
  responseIntentKey?: string | null;
  channelId: string;
  content: string;
}): string {
  if (input.proposalId) return `proposal:${input.proposalId}`;
  if (input.responseIntentKey) {
    const digest = createHash('sha256').update(input.responseIntentKey).digest('hex');
    return `intent:${digest}`;
  }
  if (!input.runId) {
    throw new TypeError('computeDedupeKey: runId or responseIntentKey is required');
  }
  const digest = createHash('sha256')
    .update(`${input.runId}\0${input.channelId}\0${input.content}`)
    .digest('hex')
    .slice(0, 32);
  return `run:${input.runId}:${input.channelId}:${digest}`;
}

/**
 * Enqueue one outbox row as `queued`. Idempotent on the dedupe key: a second
 * enqueue for the same intended message is a no-op that returns the existing row
 * id with `enqueued: false`. Returns `enqueued: true` with the new id otherwise.
 *
 * @throws when `content`, `channelId`, or both response identities are missing — these are
 *   programmer errors at the last stop before a Discord send, not user input.
 */
export function enqueueOutbox(db: DatabaseSync, input: EnqueueOutboxInput): EnqueueOutboxResult {
  const hasRunId = typeof input.runId === 'string' && input.runId.length > 0;
  const hasResponseIntent =
    typeof input.responseIntentKey === 'string' && input.responseIntentKey.length > 0;
  if (!hasRunId && !hasResponseIntent) {
    throw new TypeError('enqueueOutbox: runId or responseIntentKey is required');
  }
  if (typeof input.channelId !== 'string' || input.channelId.length === 0) {
    throw new TypeError('enqueueOutbox: channelId is required');
  }
  if (typeof input.content !== 'string' || input.content.length === 0) {
    throw new TypeError('enqueueOutbox: content must be a non-empty string');
  }

  const dedupeKey = computeDedupeKey(input);
  const dedupeMarker = createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24);
  const id = randomUUID();
  const nextAttemptAtMs = input.nextAttemptAtMs ?? input.now;

  const persist = (): EnqueueOutboxResult => {
    const changes = Number(
      prepareCached(db, 'outbox.enqueue', ENQUEUE_SQL).run({
        id,
        proposal_id: input.proposalId ?? null,
        channel_id: input.channelId,
        reply_to_message_id: input.replyToMessageId ?? null,
        content: input.content,
        dedupe_key: dedupeKey,
        dedupe_marker: dedupeMarker,
        next_attempt_at_ms: nextAttemptAtMs,
        now: input.now,
      }).changes,
    );

    const existing = changes > 0 ? undefined : getOutboxByDedupeKey(db, dedupeKey);
    const outboxId = changes > 0 ? id : (existing?.id ?? id);

    if (changes > 0 || existing?.status === 'queued') {
      enqueue(db, {
        type: 'send_outbox',
        payload: { outboxId },
        uniqueKey: `outbox:send:${outboxId}`,
        runAfterMs: nextAttemptAtMs,
        now: input.now,
      });
    }

    return { outboxId, dedupeKey, enqueued: changes > 0 };
  };
  return db.isTransaction ? persist() : transaction(db, persist);
}

/** Read one outbox row by id, or `undefined` when absent. */
export function getOutbox(db: DatabaseSync, id: string): OutboxRow | undefined {
  const row = prepareCached(db, 'outbox.get', `SELECT ${COLUMNS} FROM outbox WHERE id = ?`).get(
    id,
  ) as OutboxDbRow | undefined;
  return row ? mapOutboxRow(row) : undefined;
}

/** Read the outbox row for a dedupe key, or `undefined` when absent. */
export function getOutboxByDedupeKey(db: DatabaseSync, dedupeKey: string): OutboxRow | undefined {
  const row = prepareCached(
    db,
    'outbox.get_by_dedupe',
    `SELECT ${COLUMNS} FROM outbox WHERE dedupe_key = ?`,
  ).get(dedupeKey) as OutboxDbRow | undefined;
  return row ? mapOutboxRow(row) : undefined;
}

// ---------------------------------------------------------------------------
// Send-path state transitions (Section 10.1).
//
// Each transition is gated on the expected prior status and runs in a short
// transaction, so the send path is: claim (queued → sending) and commit BEFORE
// the Discord call; then, after the call, mark sent or retry/failed. A crash
// between claim and outcome leaves the row `sending`, which startup recovery
// reconciles. `attempts` is incremented at claim time so the retry
// count reflects send attempts, not job claims.
// ---------------------------------------------------------------------------

const CLAIM_SQL = `
  UPDATE outbox
     SET status = 'sending', attempts = attempts + 1, updated_at_ms = @now
   WHERE id = @id AND status = 'queued'
   RETURNING ${COLUMNS}
`;

/**
 * Atomically claim a queued outbox row for sending (queued → sending) and
 * increment its attempt count. Returns the claimed row, or `undefined` when the
 * row is absent or not queued (already sending/sent/failed/cancelled) — a
 * duplicate or stale send job is a no-op.
 */
export function claimOutboxForSending(
  db: DatabaseSync,
  outboxId: string,
  now: number,
): OutboxRow | undefined {
  const row = transactionImmediate(db, () =>
    prepareCached(db, 'outbox.claim', CLAIM_SQL).get({ id: outboxId, now }) as
      | OutboxDbRow
      | undefined,
  );
  return row ? mapOutboxRow(row) : undefined;
}

const MARK_SENT_SQL = `
  UPDATE outbox
     SET status = 'sent', platform_message_id = @platformMessageId,
         sent_at_ms = @sentAtMs, updated_at_ms = @now
   WHERE id = @id AND status = 'sending'
`;

/**
 * Record a successful send (sending → sent) with the Discord message id. Returns
 * true when the transition applied; false when the row was no longer `sending`
 * (e.g. startup recovery already finalized it).
 */
export function markOutboxSent(
  db: DatabaseSync,
  id: string,
  platformMessageId: string,
  now: number,
  sentAtMs = now,
): boolean {
  return Number(
    prepareCached(db, 'outbox.mark_sent', MARK_SENT_SQL).run({
      id,
      platformMessageId,
      now,
      sentAtMs,
    }).changes,
  ) > 0;
}

const MARK_RETRY_SQL = `
  UPDATE outbox
     SET status = 'queued', last_error = @lastError, next_attempt_at_ms = @nextAttemptAtMs, updated_at_ms = @now
   WHERE id = @id AND status = 'sending'
`;

/** Return a transiently-failed row to `queued` with a backoff and the error for audit. */
export function markOutboxRetry(
  db: DatabaseSync,
  id: string,
  lastError: string,
  nextAttemptAtMs: number,
  now: number,
): boolean {
  return Number(
    prepareCached(db, 'outbox.mark_retry', MARK_RETRY_SQL).run({
      id,
      lastError,
      nextAttemptAtMs,
      now,
    }).changes,
  ) > 0;
}

const MARK_FAILED_SQL = `
  UPDATE outbox
     SET status = 'failed', last_error = @lastError, updated_at_ms = @now
   WHERE id = @id AND status = 'sending'
`;

/** Mark a row terminally `failed`, preserving `last_error` for audit. */
export function markOutboxFailed(
  db: DatabaseSync,
  id: string,
  lastError: string,
  now: number,
): boolean {
  return Number(
    prepareCached(db, 'outbox.mark_failed', MARK_FAILED_SQL).run({ id, lastError, now }).changes,
  ) > 0;
}

/** Cancel a claimed row before Discord I/O when its scheduled authority drifted. */
export function markOutboxCancelled(
  db: DatabaseSync,
  id: string,
  reason: string,
  now: number,
): boolean {
  return Number(prepareCached(
    db,
    'outbox.mark_cancelled',
    `UPDATE outbox
        SET status = 'cancelled', last_error = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'sending'`,
  ).run(reason, now, id).changes) > 0;
}

export interface SendingOutboxRow {
  id: string;
  channelId: string;
  content: string;
  proposalId: string | null;
  attempts: number;
  dedupeMarker: string | null;
}

/**
 * List every outbox row left in `sending` — the rows startup recovery
 * must reconcile before any requeue. A row is `sending` only between the claim
 * commit and the outcome commit, so this set is exactly the crash window.
 */
export function listOutboxSending(db: DatabaseSync): SendingOutboxRow[] {
  const rows = prepareCached(
    db,
    'outbox.list_sending',
    `SELECT id, channel_id, content, proposal_id, attempts, dedupe_marker
     FROM outbox WHERE status = 'sending'`,
  ).all() as Array<{
    id: string;
    channel_id: string;
    content: string;
    proposal_id: string | null;
    attempts: number;
    dedupe_marker: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    content: r.content,
    proposalId: r.proposal_id,
    attempts: r.attempts,
    dedupeMarker: r.dedupe_marker,
  }));
}

function mapOutboxRow(row: OutboxDbRow): OutboxRow {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    channelId: row.channel_id,
    replyToMessageId: row.reply_to_message_id,
    content: row.content,
    dedupeKey: row.dedupe_key,
    dedupeMarker: row.dedupe_marker,
    status: row.status,
    platformMessageId: row.platform_message_id,
    attempts: row.attempts,
    nextAttemptAtMs: row.next_attempt_at_ms,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    sentAtMs: row.sent_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}
