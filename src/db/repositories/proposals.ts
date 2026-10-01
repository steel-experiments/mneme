import { randomUUID } from 'node:crypto';
import { type DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';

/**
 * Proposal persistence (Sections 24, 29; base migration 003 and later schema additions).
 *
 * A proposal row is the durable record of one routed intervention: the run that
 * produced it, its target channel, the host-computed score, the routing state
 * (`observed`, `pending_review`, `approved`, …), the redacted routing reason, and the
 * cited evidence message ids. The repository only stores and reads rows; the
 * routing decision itself is made by {@link routeProposal} in `agent/policy.ts`,
 * and approval plus outbox enqueue are coordinated atomically by the review
 * workflow (Section 9.1). Routing reasons stay content-free; the optional
 * review reason is shown only on secure/admin review surfaces.
 */

/** The set of `proposals.status` values accepted by the schema CHECK. */
export type ProposalStatus =
  | 'observed'
  | 'pending_review'
  | 'approved'
  | 'dismissed'
  | 'expired'
  | 'sent'
  | 'failed';

export interface ProposalRow {
  id: string;
  runId: string;
  episodeId: string | null;
  targetChannelId: string;
  status: ProposalStatus;
  computedScore: number;
  reason: string;
  policyDecision: Record<string, unknown> | null;
  reviewReason: string | null;
  /** Stable host-computed subject key used by topic cooldown policy. */
  topicKey: string | null;
  message: string | null;
  evidenceMessageIds: string[];
  replyToMessageId: string | null;
  reviewMessageId: string | null;
  reviewedByUserId: string | null;
  reviewedAtMs: number | null;
  /** Bounded, content-free dismissal reason (Section 25), or null. */
  dismissalReason: string | null;
  expiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface InsertProposalInput {
  runId: string;
  /** Episode the proposal reviews; null for direct-answer / scheduled-review runs. */
  episodeId?: string | null;
  targetChannelId: string;
  status: ProposalStatus;
  computedScore: number;
  /** Redacted routing reasons, joined with `; ` for storage. */
  reason: readonly string[] | string;
  /** Versioned, host-built, content-free policy evaluation snapshot. */
  policyDecision?: object | null;
  /** Optional bounded model recommendation reason for secure review only. */
  reviewReason?: string | null;
  /** Optional stable host-computed subject key. Model-authored values are never accepted. */
  topicKey?: string | null;
  /** Safe proposed text when available; durable status, not text presence, authorizes delivery. */
  message?: string | null;
  /** Evidence message ids cited by the proposal (stored as JSON, never content). */
  evidenceMessageIds: readonly string[];
  replyToMessageId?: string | null;
  /** Optional review/expiry deadline in epoch ms. */
  expiresAtMs?: number | null;
  now: number;
}

interface ProposalDbRow {
  id: string;
  run_id: string;
  episode_id: string | null;
  target_channel_id: string;
  status: ProposalStatus;
  computed_score: number;
  reason: string;
  policy_decision_json: string | null;
  review_reason: string | null;
  topic_key: string | null;
  message: string | null;
  evidence_message_ids_json: string;
  reply_to_message_id: string | null;
  review_message_id: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at_ms: number | null;
  dismissal_reason: string | null;
  expires_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

/**
 * Insert one proposal row and return its id. Callers pass the routed state and
 * the redacted reasons; the host owns both, never the model.
 */
export function insertProposal(db: DatabaseSync, input: InsertProposalInput): string {
  const id = randomUUID();
  const reason = typeof input.reason === 'string' ? input.reason : input.reason.join('; ');
  const stmt = prepareCached(
    db,
    'proposals.insert',
    `INSERT INTO proposals (id, run_id, episode_id, target_channel_id, status, computed_score,
        reason, policy_decision_json, review_reason, topic_key, message, evidence_message_ids_json, reply_to_message_id, expires_at_ms, created_at_ms, updated_at_ms)
     VALUES (@id, @runId, @episodeId, @targetChannelId, @status, @computedScore,
        @reason, @policyDecisionJson, @reviewReason, @topicKey, @message, @evidenceMessageIdsJson, @replyToMessageId, @expiresAtMs, @now, @now)`,
  );
  stmt.run({
    id,
    runId: input.runId,
    episodeId: input.episodeId ?? null,
    targetChannelId: input.targetChannelId,
    status: input.status,
    computedScore: input.computedScore,
    reason,
    policyDecisionJson: input.policyDecision ? JSON.stringify(input.policyDecision) : null,
    reviewReason: input.reviewReason ?? null,
    topicKey: input.topicKey ?? null,
    message: input.message ?? null,
    evidenceMessageIdsJson: JSON.stringify(input.evidenceMessageIds),
    replyToMessageId: input.replyToMessageId ?? null,
    expiresAtMs: input.expiresAtMs ?? null,
    now: input.now,
  });
  return id;
}

/** Read one proposal by id, or `undefined` when absent. */
export function getProposal(db: DatabaseSync, id: string): ProposalRow | undefined {
  const stmt = prepareCached(
    db,
    'proposals.get',
    `SELECT id, run_id, episode_id, target_channel_id, status, computed_score,
        reason, policy_decision_json, review_reason, topic_key, message, evidence_message_ids_json, reply_to_message_id, review_message_id, reviewed_by_user_id,
        reviewed_at_ms, dismissal_reason, expires_at_ms, created_at_ms, updated_at_ms
     FROM proposals WHERE id = ?`,
  );
  const row = stmt.get(id) as ProposalDbRow | undefined;
  return row ? mapProposalRow(row) : undefined;
}

/** Read the proposal whose review card is the given Discord message, or `undefined`. */
export function getProposalByReviewMessageId(
  db: DatabaseSync,
  reviewMessageId: string,
): ProposalRow | undefined {
  const stmt = prepareCached(
    db,
    'proposals.get_by_review_message',
    `SELECT id, run_id, episode_id, target_channel_id, status, computed_score,
        reason, policy_decision_json, review_reason, topic_key, message, evidence_message_ids_json, reply_to_message_id, review_message_id, reviewed_by_user_id,
        reviewed_at_ms, dismissal_reason, expires_at_ms, created_at_ms, updated_at_ms
     FROM proposals WHERE review_message_id = ?
     ORDER BY created_at_ms DESC LIMIT 1`,
  );
  const row = stmt.get(reviewMessageId) as ProposalDbRow | undefined;
  return row ? mapProposalRow(row) : undefined;
}

/**
 * The proposal behind the newest review card posted in a channel at or before
 * the given time (Section 26). Used to resolve "this proposal" when someone
 * addresses Mneme in the secure review channel without replying to a card.
 */
export function getLatestProposalCardInChannel(
  db: DatabaseSync,
  channelId: string,
  beforeMs: number,
): ProposalRow | undefined {
  const stmt = prepareCached(
    db,
    'proposals.latest_card_in_channel',
    `SELECT p.id, p.run_id, p.episode_id, p.target_channel_id, p.status, p.computed_score,
        p.reason, p.policy_decision_json, p.review_reason, p.topic_key, p.message, p.evidence_message_ids_json, p.reply_to_message_id, p.review_message_id, p.reviewed_by_user_id,
        p.reviewed_at_ms, p.dismissal_reason, p.expires_at_ms, p.created_at_ms, p.updated_at_ms
     FROM proposals p
     JOIN messages m ON m.id = p.review_message_id
    WHERE m.channel_id = ? AND m.created_at_ms <= ? AND m.deleted_at_ms IS NULL
    ORDER BY m.created_at_ms DESC, m.id DESC LIMIT 1`,
  );
  const row = stmt.get(channelId, beforeMs) as ProposalDbRow | undefined;
  return row ? mapProposalRow(row) : undefined;
}

/**
 * Set a proposal's status (e.g. `sent` after delivery, `failed` after a terminal
 * outbox error). Returns true when a row was updated. Used by the outbox sender
 * to mirror send outcomes onto the originating proposal (Section 24).
 */
export function setProposalStatus(
  db: DatabaseSync,
  id: string,
  status: ProposalStatus,
  now: number,
): boolean {
  return Number(
    prepareCached(
      db,
      'proposals.set_status',
      'UPDATE proposals SET status = ?, updated_at_ms = ? WHERE id = ?',
    ).run(status, now, id).changes,
  ) > 0;
}

/**
 * Replace the durable message with the exact host-rendered delivery text
 * (Section 24.5). Called inside the approval transaction for scheduled
 * proposals so the stored message, the outbox row, and reply-feedback matching
 * carry the same text. Returns true when a row was updated.
 */
export function setProposalMessage(
  db: DatabaseSync,
  id: string,
  message: string,
  now: number,
): boolean {
  return Number(
    prepareCached(
      db,
      'proposals.set_message',
      'UPDATE proposals SET message = ?, updated_at_ms = ? WHERE id = ?',
    ).run(message, now, id).changes,
  ) > 0;
}

/**
 * Record the Discord id of the secure-review message that presented this
 * proposal (Section 25). Called when a pending proposal is posted to the review
 * channel; `reviewed_at_ms`/`reviewed_by_user_id` are set later, on human
 * approval/dismissal. Returns true when a row was updated.
 */
export function setProposalReviewMessage(
  db: DatabaseSync,
  id: string,
  reviewMessageId: string,
  now: number,
): boolean {
  return Number(
    prepareCached(
      db,
      'proposals.set_review_message',
      'UPDATE proposals SET review_message_id = ?, updated_at_ms = ? WHERE id = ?',
    ).run(reviewMessageId, now, id).changes,
  ) > 0;
}

const SET_REVIEWED_SQL = `
  UPDATE proposals
     SET status = @status, reviewed_by_user_id = @reviewedByUserId, reviewed_at_ms = @now,
         dismissal_reason = @dismissalReason, updated_at_ms = @now
   WHERE id = @id AND status = 'pending_review'
`;

/**
 * Resolve a pending proposal with a human decision (Section 25 steps 5-6): set
 * its status to `approved` or `dismissed` and stamp the reviewer + timestamp.
 * Gated on the current status being `pending_review`, so a duplicate button
 * click or a concurrent approval is a safe no-op (returns false) — the first
 * resolution wins and the outbox dedupe key (Section 9.1) makes the resulting
 * send effectively-once even if the click races.
 *
 * For a dismissal, pass the bounded, content-free `dismissalReason` so it is
 * persisted on the row for evaluation (Section 25); for an approval it is null.
 *
 * Approval callers perform this transition and the outbox enqueue inside one
 * immediate transaction, so neither durable state can survive without the other.
 */
export function setProposalReviewed(
  db: DatabaseSync,
  id: string,
  status: 'approved' | 'dismissed',
  reviewedByUserId: string,
  now: number,
  dismissalReason: string | null = null,
): boolean {
  return Number(
    prepareCached(db, 'proposals.set_reviewed', SET_REVIEWED_SQL).run({
      status,
      reviewedByUserId,
      now,
      dismissalReason,
      id,
    }).changes,
  ) > 0;
}

function mapProposalRow(row: ProposalDbRow): ProposalRow {
  return {
    id: row.id,
    runId: row.run_id,
    episodeId: row.episode_id,
    targetChannelId: row.target_channel_id,
    status: row.status,
    computedScore: row.computed_score,
    reason: row.reason,
    policyDecision: parseObject(row.policy_decision_json),
    reviewReason: row.review_reason,
    topicKey: row.topic_key,
    message: row.message,
    evidenceMessageIds: parseIdArray(row.evidence_message_ids_json),
    replyToMessageId: row.reply_to_message_id,
    reviewMessageId: row.review_message_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAtMs: row.reviewed_at_ms,
    dismissalReason: row.dismissal_reason,
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/** Maximum rows one expiry statement may update. Startup repair drains in bounded batches. */
export const PROPOSAL_EXPIRY_BATCH_SIZE = 250;

const EXPIRE_PENDING_SQL = `
  UPDATE proposals
     SET status = 'expired', updated_at_ms = @now
   WHERE status = 'pending_review'
     AND id IN (
       SELECT id
         FROM proposals
        WHERE status = 'pending_review'
          AND expires_at_ms IS NOT NULL
          AND expires_at_ms < @now
        ORDER BY expires_at_ms ASC, created_at_ms ASC, id ASC
        LIMIT @limit
     )
  RETURNING id
`;

/**
 * Idempotently finalize every past-deadline pending proposal as `expired`
 * (Section 25: "Proposal expiry defaults to 72 hours").
 *
 * Only `pending_review` rows with an `expires_at_ms` strictly in the past are
 * touched. Approved, sent, dismissed, observed, or already-expired proposals are
 * never expired — an approved or sent proposal may legitimately be in flight in
 * the outbox and must not be yanked back, and re-running the sweep is a safe
 * no-op because an expired row no longer matches `pending_review`. The default
 * 72-hour deadline is stamped onto each proposal at creation by the router.
 *
 * Each call updates at most {@link PROPOSAL_EXPIRY_BATCH_SIZE} rows so startup
 * repair and periodic maintenance never issue one unbounded write. Callers that
 * need immediate full convergence may repeat until a short batch is returned.
 *
 * Returns the ids of the rows transitioned this pass, for audit and metrics.
 */
export function expirePendingProposals(
  db: DatabaseSync,
  now: number,
  limit = PROPOSAL_EXPIRY_BATCH_SIZE,
): string[] {
  const boundedLimit = Math.max(1, Math.min(PROPOSAL_EXPIRY_BATCH_SIZE, Math.trunc(limit)));
  const rows = prepareCached(db, 'proposals.expire_pending', EXPIRE_PENDING_SQL).all({
    now,
    limit: boundedLimit,
  }) as
    | Array<{ id: string }>
    | undefined;
  return rows ? rows.map((r) => r.id) : [];
}

/** Parse the evidence-id JSON array defensively; a malformed value yields `[]`. */
function parseIdArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter((e): e is string => typeof e === 'string');
    }
  } catch {
    /* fall through */
  }
  return [];
}

function parseObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pending-proposal listing and short-id resolution (Section 27).
// ---------------------------------------------------------------------------

/** Length of the short id shown in the review message and the proposals list. */
export const PROPOSAL_SHORT_ID_LENGTH = 8;

/** The short, human-typed reference for a proposal (first 8 id chars). */
export function proposalShortId(id: string): string {
  return id.slice(0, PROPOSAL_SHORT_ID_LENGTH);
}

/** One bounded pending-proposal row for the `/mneme proposals` list. */
export interface ProposalListItem {
  id: string;
  shortId: string;
  targetChannelId: string;
  /** Channel name when the target channel row is still present, else null. */
  targetChannelName: string | null;
  computedScore: number;
  reason: string;
  createdAtMs: number;
  expiresAtMs: number | null;
}

export interface PendingProposalCounts {
  /** Durable raw status count retained for authenticated HTTP compatibility. */
  pendingReview: number;
  /** Rows an administrator can act on at the captured clock instant. */
  actionablePendingReview: number;
  /** Strictly past-deadline rows awaiting the idempotent expiry sweep. */
  stalePendingReview: number;
}

interface ProposalListDbRow {
  id: string;
  target_channel_id: string;
  target_channel_name: string | null;
  computed_score: number;
  reason: string;
  created_at_ms: number;
  expires_at_ms: number | null;
}

/** Shared deadline rule for status and `/mneme proposals`. */
const ACTIONABLE_PROPOSAL_DEADLINE_SQL =
  '(p.expires_at_ms IS NULL OR p.expires_at_ms >= @now)';

/** Count raw, actionable, and stale pending proposals from one captured clock. */
export function countPendingProposals(
  db: DatabaseSync,
  now: number,
): PendingProposalCounts {
  const row = prepareCached(
    db,
    'proposals.count_pending',
    `SELECT COUNT(*) AS pending_review,
            COALESCE(SUM(CASE WHEN ${ACTIONABLE_PROPOSAL_DEADLINE_SQL} THEN 1 ELSE 0 END), 0)
              AS actionable_pending_review
       FROM proposals p
      WHERE p.status = 'pending_review'`,
  ).get({ now }) as { pending_review: number; actionable_pending_review: number };
  const pendingReview = Number(row.pending_review);
  const actionablePendingReview = Number(row.actionable_pending_review);
  return {
    pendingReview,
    actionablePendingReview,
    stalePendingReview: Math.max(0, pendingReview - actionablePendingReview),
  };
}

/**
 * List bounded, still-unexpired `pending_review` proposals, newest first. Rows
 * whose `expires_at_ms` is already in the past are excluded even before the
 * expiry sweep finalizes them, so the list never offers an admin a proposal that
 * cannot be approved. Content and secrets are never read — only ids, the redacted
 * reason, a score, a channel name, and timestamps.
 */
export function listPendingProposals(
  db: DatabaseSync,
  opts: { now: number; limit?: number },
): ProposalListItem[] {
  const limit = opts.limit ?? 10;
  const rows = prepareCached(
    db,
    'proposals.list_pending',
    `SELECT p.id, p.target_channel_id, c.name AS target_channel_name,
            p.computed_score, p.reason, p.created_at_ms, p.expires_at_ms
       FROM proposals p
       LEFT JOIN channels c ON c.id = p.target_channel_id
      WHERE p.status = 'pending_review'
        AND ${ACTIONABLE_PROPOSAL_DEADLINE_SQL}
      ORDER BY p.created_at_ms DESC
      LIMIT @limit`,
  ).all({ now: opts.now, limit }) as unknown as ProposalListDbRow[] | undefined;
  if (!rows) return [];
  return rows.map((r) => ({
    id: r.id,
    shortId: proposalShortId(r.id),
    targetChannelId: r.target_channel_id,
    targetChannelName: r.target_channel_name,
    computedScore: r.computed_score,
    reason: r.reason,
    createdAtMs: r.created_at_ms,
    expiresAtMs: r.expires_at_ms,
  }));
}

export type ProposalReferenceResolution =
  | { kind: 'unique'; id: string }
  | { kind: 'ambiguous'; ids: string[] }
  | { kind: 'none' };

/**
 * Resolve a typed proposal reference (Section 27 `<id>`) to a single proposal id.
 *
 * Accepts either the full id (exact match) or the 8-character short id shown in
 * the review message and the proposals list. A short id that matches exactly one
 * proposal resolves to it; one that matches several is reported `ambiguous` so the
 * caller can ask the admin for the full id rather than guessing. `none` means no
 * proposal begins with the reference — the caller may still delegate the raw
 * reference to the workflow, which audits the `not_found` outcome after its own
 * authorization check (so an unauthorized caller learns nothing).
 *
 * The match is anchored with `substr`, not `LIKE`, so reference characters are
 * treated literally (no wildcard injection).
 */
export function resolveProposalReference(
  db: DatabaseSync,
  reference: string,
): ProposalReferenceResolution {
  const ref = reference.trim();
  if (ref.length === 0) return { kind: 'none' };

  // Exact match wins outright.
  if (getProposal(db, ref)) return { kind: 'unique', id: ref };

  const rows = prepareCached(
    db,
    'proposals.resolve_prefix',
    'SELECT id FROM proposals WHERE substr(id, 1, ?) = ?',
  ).all(ref.length, ref) as Array<{ id: string }> | undefined;
  const ids = (rows ?? []).map((r) => r.id);
  if (ids.length === 0) return { kind: 'none' };
  if (ids.length === 1) return { kind: 'unique', id: ids[0]! };
  return { kind: 'ambiguous', ids };
}
