// ABOUTME: Durable proactive-attention state — subjects, material revisions,
// ABOUTME: evidence digests, consumption claims, and host trigger validation.
import { randomUUID } from 'node:crypto';
import { transactionImmediate, type DatabaseSync } from '../db/database.js';
import type { SQLOutputValue } from 'node:sqlite';
import { prepareCached } from '../db/repositories/util.js';
import { getMessage, type MessageRow } from '../db/repositories/messages.js';
import { resolveRetrievableChannelScope } from '../db/repositories/channels.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import { purgeDeadlineDecisionForMessage } from './deadline-decisions.js';
import {
  deadlineWindowIsRelevant,
  findCandidateDeadlineExpressions,
  parseDeadlineExpression,
} from './deadline-evidence.js';
import {
  findQuoteOffset,
  isNewerThanFrontier,
  sourceContentDigest,
  revisionKey as computeRevisionKey,
  MAX_TRIGGER_EVIDENCE,
  type AttentionRejectionReason,
  type AttentionRevisionState,
  type HumanEventOrder,
} from './attention.js';

/** Longest supersedes lineage walked to find an inherited subject (Section 12.4). */
const MAX_LINEAGE_DEPTH = 32;

/** Batch size for the closed-window expiry sweep. */
export const ATTENTION_EXPIRY_BATCH_SIZE = 250;

export interface AttentionSubjectRow {
  id: string;
  guildId: string;
  registrationState: 'pending' | 'complete';
  createdAtMs: number;
}

export interface AttentionRevisionRow {
  id: string;
  subjectId: string;
  revisionKey: string;
  humanEventAtMs: number;
  explicitDeadlineAtMs: number | null;
  deadlineTimezone: string | null;
  deadlineParserVersion: string | null;
  state: AttentionRevisionState;
  createdAtMs: number;
}

export interface AttentionClaimRow {
  revisionId: string;
  proposalId: string | null;
  consumedAtMs: number;
  eligibleFromMs: number;
  eligibleUntilMs: number;
}

/** One trigger evidence message with its verified verbatim quote offsets. */
export interface TriggerEvidenceRecord {
  messageId: string;
  content: string;
  createdAtMs: number;
  quoteStart: number;
  quoteEnd: number;
}

// ---------- subjects ----------

function rowToSubject(row: Record<string, SQLOutputValue>): AttentionSubjectRow {
  return {
    id: String(row.id),
    guildId: String(row.workspace_id),
    registrationState: String(row.registration_state) === 'complete' ? 'complete' : 'pending',
    createdAtMs: Number(row.created_at_ms),
  };
}

export function getAttentionSubject(db: DatabaseSync, subjectId: string): AttentionSubjectRow | null {
  const row = prepareCached(
    db,
    'attention.subject_get',
    'SELECT id, workspace_id, registration_state, created_at_ms FROM attention_subjects WHERE id = ?',
  ).get(subjectId) as Record<string, SQLOutputValue> | undefined;
  return row ? rowToSubject(row) : null;
}

/**
 * Find the subject a memory belongs to. Direct membership first; otherwise the
 * supersedes lineage is walked upward so a superseding memory inherits the
 * issue identity of the record it replaced. Consumed and superseded members
 * keep their subject: notification deduplication must not forget history.
 */
export function findSubjectForMember(db: DatabaseSync, memoryId: string): string | null {
  const member = prepareCached(
    db,
    'attention.member_subject',
    'SELECT subject_id FROM attention_subject_members WHERE memory_id = ?',
  ).get(memoryId) as { subject_id: string } | undefined;
  if (member) return member.subject_id;

  let currentId: string | undefined = memoryId;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH && currentId !== undefined; depth += 1) {
    const next = prepareCached(
      db,
      'attention.member_lineage',
      'SELECT supersedes_memory_id FROM memories WHERE id = ?',
    ).get(currentId) as { supersedes_memory_id: string | null } | undefined;
    if (!next || next.supersedes_memory_id === null) return null;
    const ancestor = next.supersedes_memory_id;
    const ancestorMember = prepareCached(
      db,
      'attention.member_subject',
      'SELECT subject_id FROM attention_subject_members WHERE memory_id = ?',
    ).get(ancestor) as { subject_id: string } | undefined;
    if (ancestorMember) return ancestorMember.subject_id;
    currentId = ancestor;
  }
  return null;
}

/**
 * Resolve the subject for a memory, creating it when this memory is the first
 * member, and attach the memory to an inherited subject so supersession keeps
 * one stable issue identity.
 */
export function ensureSubjectForMember(
  db: DatabaseSync,
  input: { guildId: string; memoryId: string; now: number },
): string {
  const existing = findSubjectForMember(db, input.memoryId);
  if (existing !== null) {
    attachSubjectMember(db, { subjectId: existing, memoryId: input.memoryId, now: input.now });
    return existing;
  }
  const subjectId = randomUUID();
  prepareCached(
    db,
    'attention.subject_insert',
    `INSERT INTO attention_subjects (id, workspace_id, registration_state, created_at_ms)
     VALUES (?, ?, 'pending', ?)`,
  ).run(subjectId, input.guildId, input.now);
  prepareCached(
    db,
    'attention.member_insert',
    `INSERT INTO attention_subject_members (memory_id, subject_id, created_at_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(memory_id) DO NOTHING`,
  ).run(input.memoryId, subjectId, input.now);
  return subjectId;
}

export function attachSubjectMember(
  db: DatabaseSync,
  input: { subjectId: string; memoryId: string; now: number },
): void {
  prepareCached(
    db,
    'attention.member_insert',
    `INSERT INTO attention_subject_members (memory_id, subject_id, created_at_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(memory_id) DO NOTHING`,
  ).run(input.memoryId, input.subjectId, input.now);
}

export function markSubjectRegistrationComplete(db: DatabaseSync, subjectId: string): void {
  prepareCached(
    db,
    'attention.subject_registration_complete',
    `UPDATE attention_subjects SET registration_state = 'complete'
      WHERE id = ? AND registration_state = 'pending'`,
  ).run(subjectId);
}

// ---------- revisions ----------

function rowToRevision(row: Record<string, SQLOutputValue>): AttentionRevisionRow {
  return {
    id: String(row.id),
    subjectId: String(row.subject_id),
    revisionKey: String(row.revision_key),
    humanEventAtMs: Number(row.human_event_at_ms),
    explicitDeadlineAtMs: row.explicit_deadline_at_ms === null ? null : Number(row.explicit_deadline_at_ms),
    deadlineTimezone: row.deadline_timezone === null ? null : String(row.deadline_timezone),
    deadlineParserVersion: row.deadline_parser_version === null ? null : String(row.deadline_parser_version),
    state: String(row.state) as AttentionRevisionState,
    createdAtMs: Number(row.created_at_ms),
  };
}

export function getRevision(db: DatabaseSync, revisionId: string): AttentionRevisionRow | null {
  const row = prepareCached(
    db,
    'attention.revision_get',
    `SELECT id, subject_id, revision_key, human_event_at_ms, explicit_deadline_at_ms,
            deadline_timezone, deadline_parser_version, state, created_at_ms
       FROM attention_revisions WHERE id = ?`,
  ).get(revisionId) as Record<string, SQLOutputValue> | undefined;
  return row ? rowToRevision(row) : null;
}

export function getSubjectRevisionByKey(db: DatabaseSync, subjectId: string, key: string): AttentionRevisionRow | null {
  const row = prepareCached(
    db,
    'attention.revision_by_key',
    `SELECT id, subject_id, revision_key, human_event_at_ms, explicit_deadline_at_ms,
            deadline_timezone, deadline_parser_version, state, created_at_ms
       FROM attention_revisions WHERE subject_id = ? AND revision_key = ?`,
  ).get(subjectId, key) as Record<string, SQLOutputValue> | undefined;
  return row ? rowToRevision(row) : null;
}

export interface RegisterRevisionInput {
  subjectId: string;
  /** Verified trigger evidence records from validateTriggerEvidence. */
  triggers: readonly TriggerEvidenceRecord[];
  now: number;
}

export interface RegisterRevisionResult {
  revisionId: string;
  created: boolean;
}

/**
 * Idempotently register one material human revision. The revision key covers
 * the sorted trigger message IDs, so re-extraction, re-confirmation, or a new
 * stance over identical evidence returns the existing revision. Evidence rows
 * store content digests and quote offsets, never copies of Discord text.
 */
export function registerRevision(
  db: DatabaseSync,
  input: RegisterRevisionInput,
): RegisterRevisionResult {
  if (input.triggers.length === 0 || input.triggers.length > MAX_TRIGGER_EVIDENCE) {
    throw new Error('a revision requires 1..3 trigger evidence records');
  }
  const ids = input.triggers.map((trigger) => trigger.messageId);
  const key = computeRevisionKey(ids);
  const existing = getSubjectRevisionByKey(db, input.subjectId, key);
  if (existing !== null) return { revisionId: existing.id, created: false };

  const revisionId = randomUUID();
  const humanEventAtMs = Math.max(...input.triggers.map((trigger) => trigger.createdAtMs));
  prepareCached(
    db,
    'attention.revision_insert',
    `INSERT INTO attention_revisions
       (id, subject_id, revision_key, human_event_at_ms, explicit_deadline_at_ms,
        deadline_timezone, deadline_parser_version, state, created_at_ms)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'current', ?)`,
  ).run(revisionId, input.subjectId, key, humanEventAtMs, input.now);

  const evidence = prepareCached(
    db,
    'attention.evidence_insert',
    `INSERT INTO attention_revision_evidence
       (revision_id, message_id, role, source_content_digest, quote_start, quote_end)
     VALUES (?, ?, 'material_trigger', ?, ?, ?)`,
  );
  for (const trigger of input.triggers) {
    evidence.run(
      revisionId,
      trigger.messageId,
      sourceContentDigest(trigger.content),
      trigger.quoteStart,
      trigger.quoteEnd,
    );
  }
  return { revisionId, created: true };
}

export function setRevisionState(
  db: DatabaseSync,
  revisionId: string,
  state: AttentionRevisionState,
): void {
  prepareCached(
    db,
    'attention.revision_set_state',
    'UPDATE attention_revisions SET state = ? WHERE id = ?',
  ).run(state, revisionId);
}

/** Attach or replace verified deadline authority on one revision. */
export function setRevisionDeadline(
  db: DatabaseSync,
  input: {
    revisionId: string;
    deadlineAtMs: number;
    timezone: string;
    parserVersion: string;
    evidence: TriggerEvidenceRecord;
  },
): void {
  prepareCached(
    db,
    'attention.revision_set_deadline',
    `UPDATE attention_revisions
        SET explicit_deadline_at_ms = ?, deadline_timezone = ?, deadline_parser_version = ?
      WHERE id = ?`,
  ).run(input.deadlineAtMs, input.timezone, input.parserVersion, input.revisionId);
  prepareCached(
    db,
    'attention.evidence_insert_deadline',
    `INSERT INTO attention_revision_evidence
       (revision_id, message_id, role, source_content_digest, quote_start, quote_end)
     VALUES (?, ?, 'explicit_deadline', ?, ?, ?)
     ON CONFLICT(revision_id, message_id, role) DO UPDATE
       SET source_content_digest = excluded.source_content_digest,
           quote_start = excluded.quote_start,
           quote_end = excluded.quote_end`,
  ).run(
    input.revisionId,
    input.evidence.messageId,
    sourceContentDigest(input.evidence.content),
    input.evidence.quoteStart,
    input.evidence.quoteEnd,
  );
}

/** Remove deadline authority, keeping the revision and its trigger evidence. */
export function clearRevisionDeadline(db: DatabaseSync, revisionId: string, evidenceMessageId: string): void {
  prepareCached(
    db,
    'attention.revision_clear_deadline',
    `UPDATE attention_revisions
        SET explicit_deadline_at_ms = NULL, deadline_timezone = NULL, deadline_parser_version = NULL
      WHERE id = ?`,
  ).run(revisionId);
  prepareCached(
    db,
    'attention.evidence_delete_deadline',
    `DELETE FROM attention_revision_evidence
      WHERE revision_id = ? AND message_id = ? AND role = 'explicit_deadline'`,
  ).run(revisionId, evidenceMessageId);
}

/** Every revision of one subject, newest human event first. */
export function listSubjectRevisions(db: DatabaseSync, subjectId: string): AttentionRevisionRow[] {
  const rows = prepareCached(
    db,
    'attention.revisions_by_subject',
    `SELECT id, subject_id, revision_key, human_event_at_ms, explicit_deadline_at_ms,
            deadline_timezone, deadline_parser_version, state, created_at_ms
       FROM attention_revisions WHERE subject_id = ?
      ORDER BY human_event_at_ms DESC, id`,
  ).all(subjectId) as Array<Record<string, SQLOutputValue>>;
  return rows.map(rowToRevision);
}

// ---------- claims ----------

export function getClaim(db: DatabaseSync, revisionId: string): AttentionClaimRow | null {
  const row = prepareCached(
    db,
    'attention.claim_get',
    `SELECT revision_id, proposal_id, consumed_at_ms, eligible_from_ms, eligible_until_ms
       FROM proposal_attention_claims WHERE revision_id = ?`,
  ).get(revisionId) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  return {
    revisionId: String(row.revision_id),
    proposalId: row.proposal_id === null ? null : String(row.proposal_id),
    consumedAtMs: Number(row.consumed_at_ms),
    eligibleFromMs: Number(row.eligible_from_ms),
    eligibleUntilMs: Number(row.eligible_until_ms),
  };
}

export function getClaimByProposal(db: DatabaseSync, proposalId: string): AttentionClaimRow | null {
  const row = prepareCached(
    db,
    'attention.claim_by_proposal',
    `SELECT revision_id, proposal_id, consumed_at_ms, eligible_from_ms, eligible_until_ms
       FROM proposal_attention_claims WHERE proposal_id = ?`,
  ).get(proposalId) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  return {
    revisionId: String(row.revision_id),
    proposalId: row.proposal_id === null ? null : String(row.proposal_id),
    consumedAtMs: Number(row.consumed_at_ms),
    eligibleFromMs: Number(row.eligible_from_ms),
    eligibleUntilMs: Number(row.eligible_until_ms),
  };
}

/**
 * Claim one revision for one proposal. Returns false when the revision is
 * already consumed. The caller owns the immediate transaction so proposal
 * persistence and the claim commit atomically; concurrent claimants see
 * exactly one winner.
 */
export function claimRevision(
  db: DatabaseSync,
  input: {
    revisionId: string;
    proposalId: string;
    consumedAtMs: number;
    eligibleFromMs: number;
    eligibleUntilMs: number;
  },
): boolean {
  const persist = (): boolean => {
    // Registration is not a reservation. Another subject/revision can spend
    // this event between registration and the card, so recheck while owning
    // the same write lock as proposal persistence.
    if (input.consumedAtMs < input.eligibleFromMs || input.consumedAtMs > input.eligibleUntilMs
      || !validateRevisionEvidence(db, input.revisionId, input.consumedAtMs)
      || !revisionHasUnconsumedEvent(db, input.revisionId)) return false;
    const result = prepareCached(
      db,
      'attention.claim_insert',
      `INSERT INTO proposal_attention_claims
         (revision_id, proposal_id, consumed_at_ms, eligible_from_ms, eligible_until_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(revision_id) DO NOTHING`,
    ).run(
      input.revisionId,
      input.proposalId,
      input.consumedAtMs,
      input.eligibleFromMs,
      input.eligibleUntilMs,
    );
    return Number(result.changes) > 0;
  };
  return db.isTransaction ? persist() : transactionImmediate(db, persist);
}

/** Recheck event coverage at every admission boundary, including the claim. */
export function revisionHasUnconsumedEvent(db: DatabaseSync, revisionId: string): boolean {
  const revision = getRevision(db, revisionId);
  if (!revision || revision.state !== 'current' || getClaim(db, revisionId)) return false;
  const subject = getAttentionSubject(db, revision.subjectId);
  if (!subject) return false;
  const ids = listRevisionTriggerMessageIds(db, revisionId);
  const covered = findConsumedTriggerMessageIds(db, subject.guildId, ids);
  const frontier = getSubjectConsumedFrontier(db, revision.subjectId);
  return ids.some((messageId) => {
    if (covered.has(messageId)) return false;
    const source = getMessage(db, messageId);
    return source !== undefined && isNewerThanFrontier({
      createdAtMs: source.created_at_ms, messageId,
    }, frontier);
  });
}

/**
 * A stored revision is authority only while its exact human sources survive.
 * Check all original trigger IDs (also catches partial forgetting), quote
 * bounds, content digests, author, guild, and current retrievability. Deadlines
 * may have old sources, but their source version must remain the accepted one.
 */
export function validateRevisionEvidence(db: DatabaseSync, revisionId: string, now: number): boolean {
  const revision = getRevision(db, revisionId);
  if (!revision || revision.state !== 'current') return false;
  const subject = getAttentionSubject(db, revision.subjectId);
  if (!subject) return false;
  const evidence = prepareCached(db, 'attention.revision_evidence_current', `
    SELECT message_id, role, source_content_digest, quote_start, quote_end
      FROM attention_revision_evidence WHERE revision_id = ?
  `).all(revisionId) as Array<{
    message_id: string; role: string; source_content_digest: string;
    quote_start: number; quote_end: number;
  }>;
  const triggers = evidence.filter((item) => item.role === 'material_trigger');
  if (triggers.length === 0 || triggers.length > MAX_TRIGGER_EVIDENCE
    || computeRevisionKey(triggers.map((item) => item.message_id)) !== revision.revisionKey) return false;
  if (revision.explicitDeadlineAtMs !== null && !evidence.some((item) => item.role === 'explicit_deadline')) return false;
  let newestAtMs = -Infinity;
  for (const item of evidence) {
    if (item.role === 'explicit_deadline' && revision.explicitDeadlineAtMs === null) continue;
    const source = getMessage(db, item.message_id);
    if (!source || source.workspace_id !== subject.guildId || source.deleted_at_ms !== null
      || source.created_at_ms > now || !resolveRetrievableChannelScope(db, source.channel_id)
      || sourceContentDigest(source.content) !== item.source_content_digest
      || item.quote_start < 0 || item.quote_end <= item.quote_start
      || item.quote_end > source.content.length) return false;
    const author = source.author_id === null ? undefined : prepareCached(db, 'attention.author',
      'SELECT is_bot FROM users WHERE id = ?').get(source.author_id) as { is_bot: number } | undefined;
    if (!author || author.is_bot !== 0) return false;
    if (item.role === 'material_trigger') newestAtMs = Math.max(newestAtMs, source.created_at_ms);
  }
  return newestAtMs === revision.humanEventAtMs;
}

// ---------- consumption coverage ----------

/**
 * Second conservative consumption check: which of these message IDs already
 * served as material trigger evidence for a consumed revision in the guild.
 * Coverage is compared by source identity, so a recreated memory or subject
 * cannot reuse consumed human evidence.
 */
export function findConsumedTriggerMessageIds(
  db: DatabaseSync,
  guildId: string,
  messageIds: readonly string[],
): Set<string> {
  if (messageIds.length === 0) return new Set();
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = prepareCached(
    db,
    `attention.consumed_evidence:${messageIds.length}`,
    `SELECT DISTINCT e.message_id AS message_id
       FROM attention_revision_evidence e
       JOIN attention_revisions r ON r.id = e.revision_id
       JOIN attention_subjects s ON s.id = r.subject_id
       JOIN proposal_attention_claims c ON c.revision_id = r.id
      WHERE s.workspace_id = ?
        AND e.role = 'material_trigger'
        AND e.message_id IN (${placeholders})
      UNION
     SELECT DISTINCT e.message_id AS message_id
       FROM attention_revision_evidence e
       JOIN attention_revisions r ON r.id = e.revision_id
       JOIN attention_subjects s ON s.id = r.subject_id
      WHERE s.workspace_id = ?
        AND e.role = 'material_trigger'
        AND r.state = 'legacy_consumed'
        AND e.message_id IN (${placeholders})`,
  ).all(guildId, ...messageIds, guildId, ...messageIds) as Array<{ message_id: string }>;
  return new Set(rows.map((row) => row.message_id));
}

/**
 * The newest consumed human event for a subject, ordered by source creation
 * time with the message ID as the stable tie-break. A candidate revision is a
 * new development only when it carries an event strictly newer than this
 * frontier. Proposal and attempt times are never compared: a correction that
 * arrived while an earlier run was in flight still counts.
 */
export function getSubjectConsumedFrontier(db: DatabaseSync, subjectId: string): HumanEventOrder | null {
  const row = prepareCached(
    db,
    'attention.subject_frontier',
    `SELECT m.created_at_ms AS created_at_ms, e.message_id AS message_id
       FROM attention_revision_evidence e
       JOIN attention_revisions r ON r.id = e.revision_id
       JOIN messages m ON m.id = e.message_id
      WHERE r.subject_id = ? AND e.role = 'material_trigger'
        AND (EXISTS (SELECT 1 FROM proposal_attention_claims c WHERE c.revision_id = r.id)
             OR r.state = 'legacy_consumed')
      ORDER BY m.created_at_ms DESC, e.message_id DESC
      LIMIT 1`,
  ).get(subjectId) as { created_at_ms: number; message_id: string } | undefined;
  if (!row) return null;
  return { createdAtMs: Number(row.created_at_ms), messageId: row.message_id };
}

// ---------- trigger evidence validation ----------

export interface TriggerEvidenceInput {
  guildId: string;
  /** Discord application id, so Mneme's own messages are never triggers. */
  mnemeId: string;
  evidence: ReadonlyArray<{ messageId: string; quote: string }>;
  now: number;
  windowMs: number;
}

export type TriggerEvidenceResult =
  | { ok: true; records: TriggerEvidenceRecord[]; humanEventAtMs: number }
  | { ok: false; reason: AttentionRejectionReason; detail?: string };

/**
 * Host validation of proposed trigger evidence. Every cited message must
 * exist, be undeleted, belong to the guild, be retrievable in current channel
 * scope, be authored by a known human (never Mneme or another bot), carry
 * a verbatim quote, and have been created inside the attention window by
 * original creation time — future timestamps fail closed.
 */
export function validateTriggerEvidence(
  db: DatabaseSync,
  input: TriggerEvidenceInput,
): TriggerEvidenceResult {
  if (input.evidence.length === 0 || input.evidence.length > MAX_TRIGGER_EVIDENCE) {
    return { ok: false, reason: 'no_recent_human_trigger', detail: 'trigger evidence count out of bounds' };
  }
  const seen = new Set<string>();
  const records: TriggerEvidenceRecord[] = [];
  for (const item of input.evidence) {
    if (seen.has(item.messageId)) continue;
    seen.add(item.messageId);
    const message: MessageRow | undefined = getMessage(db, item.messageId);
    if (!message || message.deleted_at_ms !== null || message.workspace_id !== input.guildId) {
      return { ok: false, reason: 'trigger_changed', detail: `trigger message ${item.messageId} is not current` };
    }
    const scope = resolveRetrievableChannelScope(db, message.channel_id);
    if (!scope) {
      return { ok: false, reason: 'trigger_changed', detail: `trigger message ${item.messageId} is not retrievable` };
    }
    const author = message.author_id === null
      ? undefined
      : prepareCached(db, 'attention.author', 'SELECT is_bot FROM users WHERE id = ?')
          .get(message.author_id) as { is_bot: number } | undefined;
    if (!author || author.is_bot === 1 || message.author_id === input.mnemeId) {
      return { ok: false, reason: 'no_recent_human_trigger', detail: `trigger message ${item.messageId} is not human-authored` };
    }
    if (message.created_at_ms > input.now) {
      return { ok: false, reason: 'no_recent_human_trigger', detail: `trigger message ${item.messageId} is dated in the future` };
    }
    if (message.created_at_ms < input.now - input.windowMs) {
      return { ok: false, reason: 'no_recent_human_trigger', detail: `trigger message ${item.messageId} is outside the attention window` };
    }
    const offset = findQuoteOffset(message.content, item.quote);
    if (offset === null) {
      return { ok: false, reason: 'trigger_changed', detail: `trigger quote for ${item.messageId} is not verbatim` };
    }
    records.push({
      messageId: message.id,
      content: message.content,
      createdAtMs: message.created_at_ms,
      quoteStart: offset.start,
      quoteEnd: offset.end,
    });
  }
  if (records.length === 0) {
    return { ok: false, reason: 'no_recent_human_trigger', detail: 'trigger evidence was empty' };
  }
  return { ok: true, records, humanEventAtMs: Math.max(...records.map((r) => r.createdAtMs)) };
}

// ---------- selection ----------

export interface EligibleRevisionCandidate {
  revisionId: string;
  subjectId: string;
  guildId: string;
  /** Representative active member memory for route derivation and prompts. */
  memoryId: string;
  humanEventAtMs: number;
  explicitDeadlineAtMs: number | null;
  basis: 'new_human_evidence' | 'human_deadline';
  windowFromMs: number;
  windowUntilMs: number;
}

/**
 * Eligible, unconsumed, current revisions whose window contains `now`, one per
 * subject, excluding subjects whose representative memory holds an active
 * cohort lease. Selection is independent of `review_after_ms`.
 */
export function selectEligibleRevisions(
  db: DatabaseSync,
  input: {
    now: number; windowMs: number; limit: number;
    /** Rejected scan rows also need dispatcher fairness bookkeeping. */
    onRejected?: (memoryId: string) => void;
  },
): EligibleRevisionCandidate[] {
  const rows = prepareCached(
    db,
    'attention.select_eligible',
    `SELECT r.id AS revision_id, r.subject_id AS subject_id, s.workspace_id AS workspace_id,
            r.human_event_at_ms AS human_event_at_ms, r.explicit_deadline_at_ms AS explicit_deadline_at_ms,
            mem.id AS memory_id
       FROM attention_revisions r
       JOIN attention_subjects s ON s.id = r.subject_id
       JOIN attention_subject_members m ON m.subject_id = r.subject_id
       JOIN memories mem ON mem.id = m.memory_id AND mem.status = 'active'
       LEFT JOIN scheduled_review_dispatch_state state ON state.memory_id = mem.id
      WHERE r.state = 'current'
        AND NOT EXISTS (SELECT 1 FROM proposal_attention_claims c WHERE c.revision_id = r.id)
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_review_cohort_subject_leases lease
            JOIN jobs job ON job.id = lease.job_id
           WHERE lease.memory_id = mem.id AND job.status IN ('queued', 'running')
        )
        AND (
          (r.human_event_at_ms <= @now AND @now <= r.human_event_at_ms + @window)
          OR (r.explicit_deadline_at_ms IS NOT NULL
              AND r.explicit_deadline_at_ms <= @now
              AND @now <= r.explicit_deadline_at_ms + @window)
        )
      ORDER BY COALESCE(state.last_considered_at_ms, 0), r.human_event_at_ms DESC, r.id
      LIMIT @limit`,
  ).all({ now: input.now, window: input.windowMs, limit: input.limit }) as Array<
    Record<string, SQLOutputValue>
  >;

  const bySubject = new Map<string, EligibleRevisionCandidate>();
  for (const row of rows) {
    const subjectId = String(row.subject_id);
    if (bySubject.has(subjectId)) continue;
    if (!validateRevisionEvidence(db, String(row.revision_id), input.now)
      || !revisionHasUnconsumedEvent(db, String(row.revision_id))) {
      input.onRejected?.(String(row.memory_id));
      continue;
    }
    const humanEventAtMs = Number(row.human_event_at_ms);
    const deadlineAtMs = row.explicit_deadline_at_ms === null ? null : Number(row.explicit_deadline_at_ms);
    const ordinaryFrom = humanEventAtMs;
    const ordinaryUntil = humanEventAtMs + input.windowMs;
    const useDeadline = deadlineAtMs !== null
      && !ordinaryWindowOpen(ordinaryFrom, ordinaryUntil, input.now);
    const basis: 'new_human_evidence' | 'human_deadline' = useDeadline ? 'human_deadline' : 'new_human_evidence';
    bySubject.set(subjectId, {
      revisionId: String(row.revision_id),
      subjectId,
      guildId: String(row.workspace_id),
      memoryId: String(row.memory_id),
      humanEventAtMs,
      explicitDeadlineAtMs: deadlineAtMs,
      basis,
      windowFromMs: useDeadline && deadlineAtMs !== null ? deadlineAtMs : ordinaryFrom,
      windowUntilMs: useDeadline && deadlineAtMs !== null ? deadlineAtMs + input.windowMs : ordinaryUntil,
    });
  }
  return [...bySubject.values()];
}

function ordinaryWindowOpen(fromMs: number, untilMs: number, now: number): boolean {
  return now >= fromMs && now <= untilMs;
}

export interface RegistrationCandidate {
  memoryId: string;
  /** Existing subject id, or null when the memory has no subject yet. */
  subjectId: string | null;
  /** Newest uncovered human evidence message inside the window, when one exists. */
  uncoveredEvidenceAtMs: number | null;
  /** The memory's evidence carries a candidate future deadline expression. */
  candidateDeadline: boolean;
}

/** How far back the registration scan looks for candidate deadline expressions. */
export const DEADLINE_CANDIDATE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/** Evidence messages prescreened per memory for candidate deadline dates. */
const DEADLINE_PRESCREEN_MESSAGE_CAP = 20;

/**
 * Memories whose human evidence inside the attention window is not yet covered
 * by a revision: memories with no subject, and memories whose subject still
 * awaits its initial registration pass. Evidence already serving as a trigger
 * of the subject's revisions is covered. A second bounded pass looks back
 * further for sources carrying a supported candidate date whose deadline
 * window is current or future, so an old explicit deadline can still be
 * registered before it becomes due (Section 12.7). The dispatcher bounds both
 * scans; a candidate is never authority by itself.
 */
export function selectRegistrationCandidates(
  db: DatabaseSync,
  input: { guildId: string; now: number; windowMs: number; limit: number },
): RegistrationCandidate[] {
  const inWindow = registrationCandidatesInWindow(db, input);
  const byMemory = new Map<string, RegistrationCandidate>();
  for (const candidate of inWindow) {
    byMemory.set(candidate.memoryId, candidate);
  }
  if (byMemory.size < input.limit) {
    for (const candidate of registrationCandidatesWithDeadline(db, input)) {
      if (byMemory.size >= input.limit) break;
      if (!byMemory.has(candidate.memoryId)) byMemory.set(candidate.memoryId, candidate);
    }
  }
  return [...byMemory.values()];
}

function registrationCandidatesInWindow(
  db: DatabaseSync,
  input: { guildId: string; now: number; windowMs: number; limit: number },
): RegistrationCandidate[] {
  const rows = prepareCached(
    db,
    'attention.select_registration',
    `SELECT mem.id AS memory_id,
            m.subject_id AS subject_id,
            MAX(msg.created_at_ms) AS newest_evidence_ms,
            COUNT(DISTINCT e.message_id) AS evidence_count,
            COUNT(DISTINCT CASE WHEN cov.message_id IS NOT NULL THEN e.message_id END) AS covered_count
       FROM memories mem
       JOIN memory_evidence e ON e.memory_id = mem.id
       JOIN messages msg ON msg.id = e.message_id AND msg.deleted_at_ms IS NULL
       LEFT JOIN attention_subject_members m ON m.memory_id = mem.id
       LEFT JOIN attention_revision_evidence cov
              ON cov.message_id = e.message_id AND cov.role = 'material_trigger'
             AND cov.revision_id IN (
                   SELECT r.id FROM attention_revisions r WHERE r.subject_id = m.subject_id
                 )
      WHERE mem.workspace_id = @guildId
        AND mem.status = 'active'
        AND msg.created_at_ms > @from
        AND msg.created_at_ms <= @to
        AND (
          m.subject_id IS NULL
          OR EXISTS (SELECT 1 FROM attention_subjects s
                      WHERE s.id = m.subject_id AND s.registration_state = 'pending')
        )
      GROUP BY mem.id
     HAVING covered_count < evidence_count
      ORDER BY newest_evidence_ms DESC, mem.id
      LIMIT @limit`,
  ).all({
    guildId: input.guildId,
    from: input.now - input.windowMs,
    to: input.now,
    limit: input.limit,
  }) as Array<Record<string, SQLOutputValue>>;
  return rows.map((row) => ({
    memoryId: String(row.memory_id),
    subjectId: row.subject_id === null ? null : String(row.subject_id),
    uncoveredEvidenceAtMs: row.newest_evidence_ms === null ? null : Number(row.newest_evidence_ms),
    candidateDeadline: false,
  }));
}

/**
 * Bounded second pass: subjectless or pending-subject memories whose evidence
 * inside the lookback contains a supported date expression that parses to a
 * deadline window still current or future. The SQL preselects; the date
 * prescreen and parse happen here, never in SQL.
 */
function registrationCandidatesWithDeadline(
  db: DatabaseSync,
  input: { guildId: string; now: number; windowMs: number; limit: number },
): RegistrationCandidate[] {
  const rows = prepareCached(
    db,
    'attention.select_registration_deadline',
    `SELECT mem.id AS memory_id,
            m.subject_id AS subject_id,
            MAX(msg.created_at_ms) AS newest_evidence_ms
       FROM memories mem
       JOIN memory_evidence e ON e.memory_id = mem.id
       JOIN messages msg ON msg.id = e.message_id AND msg.deleted_at_ms IS NULL
       LEFT JOIN attention_subject_members m ON m.memory_id = mem.id
      WHERE mem.workspace_id = @guildId
        AND mem.status = 'active'
        AND msg.created_at_ms > @lookbackFrom
        AND msg.created_at_ms <= @to
        AND (
          m.subject_id IS NULL
          OR EXISTS (SELECT 1 FROM attention_subjects s
                      WHERE s.id = m.subject_id AND s.registration_state = 'pending')
        )
      GROUP BY mem.id
      ORDER BY newest_evidence_ms DESC, mem.id
      LIMIT @limit`,
  ).all({
    guildId: input.guildId,
    lookbackFrom: input.now - DEADLINE_CANDIDATE_LOOKBACK_MS,
    to: input.now,
    limit: input.limit,
  }) as Array<Record<string, SQLOutputValue>>;

  const evidence = prepareCached(
    db,
    'attention.registration_deadline_evidence',
    `SELECT msg.content AS content, msg.created_at_ms AS created_at_ms
       FROM memory_evidence e
       JOIN messages msg ON msg.id = e.message_id AND msg.deleted_at_ms IS NULL
      WHERE e.memory_id = ?
      ORDER BY msg.created_at_ms DESC
      LIMIT ?`,
  );
  const out: RegistrationCandidate[] = [];
  for (const row of rows) {
    const memoryId = String(row.memory_id);
    const messages = evidence.all(memoryId, DEADLINE_PRESCREEN_MESSAGE_CAP) as Array<
      { content: string; created_at_ms: number }
    >;
    let candidateDeadline = false;
    for (const message of messages) {
      for (const expression of findCandidateDeadlineExpressions(message.content)) {
        const parsed = parseDeadlineExpression(expression, {
          sourceAtMs: Number(message.created_at_ms),
          timezone: 'UTC',
        });
        if (parsed.ok && deadlineWindowIsRelevant(parsed.deadline, input.now, input.windowMs)) {
          candidateDeadline = true;
          break;
        }
      }
      if (candidateDeadline) break;
    }
    if (!candidateDeadline) continue;
    out.push({
      memoryId,
      subjectId: row.subject_id === null ? null : String(row.subject_id),
      uncoveredEvidenceAtMs: row.newest_evidence_ms === null ? null : Number(row.newest_evidence_ms),
      candidateDeadline: true,
    });
  }
  return out;
}

// ---------- expiry sweep ----------

export interface ExpireAttentionResult {
  expiredRevisionIds: string[];
}

/**
 * Retire unconsumed revisions whose ordinary window has closed and whose
 * deadline window — when one exists — has also closed. Writes one content-free
 * `admin_events` row per revision. Durable memory status never changes because
 * of age alone. Re-running the sweep is a safe no-op.
 */
export function expireClosedAttentionRevisions(
  db: DatabaseSync,
  input: { now: number; windowMs: number; guildId: string; actorUserId: string },
): ExpireAttentionResult {
  const rows = prepareCached(
    db,
    'attention.expire_candidates',
    `SELECT r.id AS id, r.subject_id AS subject_id
       FROM attention_revisions r
      WHERE r.state = 'current'
        AND NOT EXISTS (SELECT 1 FROM proposal_attention_claims c WHERE c.revision_id = r.id)
        AND r.human_event_at_ms + ? < ?
        AND (r.explicit_deadline_at_ms IS NULL OR r.explicit_deadline_at_ms + ? < ?)
      ORDER BY r.human_event_at_ms, r.id
      LIMIT ?`,
  ).all(
    input.windowMs,
    input.now,
    input.windowMs,
    input.now,
    ATTENTION_EXPIRY_BATCH_SIZE,
  ) as Array<{ id: string; subject_id: string }>;

  const expireIds: string[] = [];
  for (const row of rows) {
    const changed = prepareCached(
      db,
      'attention.expire_update',
      `UPDATE attention_revisions SET state = 'invalidated'
        WHERE id = ? AND state = 'current'
          AND NOT EXISTS (SELECT 1 FROM proposal_attention_claims c WHERE c.revision_id = ?)`,
    ).run(row.id, row.id);
    if (Number(changed.changes) > 0) {
      expireIds.push(row.id);
      recordAdminEvent(db, {
        guildId: input.guildId,
        actorUserId: input.actorUserId,
        action: 'attention_window_expire',
        target: row.id,
        details: { subjectId: row.subject_id },
        createdAtMs: input.now,
      });
    }
  }
  return { expiredRevisionIds: expireIds };
}

// ---------- forgetting ----------

/**
 * Purge attention evidence linked to a forgotten message inside the
 * source-aware deletion transaction. Revisions left without any trigger
 * evidence are invalidated: they can no longer authorize speech, and their
 * claim (if any) still stands so the evidence cannot return as fresh.
 */
export function purgeAttentionForMessage(db: DatabaseSync, messageId: string, now = Date.now()): void {
  purgeDeadlineDecisionForMessage(db, messageId, now);
  prepareCached(
    db,
    'attention.purge_evidence',
    'DELETE FROM attention_revision_evidence WHERE message_id = ?',
  ).run(messageId);
  prepareCached(
    db,
    'attention.purge_orphan_revisions',
    `UPDATE attention_revisions SET state = 'invalidated'
      WHERE state = 'current'
        AND NOT EXISTS (
          SELECT 1 FROM attention_revision_evidence e
           WHERE e.revision_id = attention_revisions.id AND e.role = 'material_trigger'
        )`,
  ).run();
}

// ---------- legacy helpers (cutover) ----------

/**
 * Record a legacy-consumed revision over already-surfaced evidence so
 * historical triggering messages cannot return as fresh triggers. Idempotent
 * on the natural revision key.
 */
export function registerLegacyConsumedRevision(
  db: DatabaseSync,
  input: {
    subjectId: string;
    triggerMessageIds: readonly string[];
    consumedAtMs: number;
    now: number;
  },
): string {
  const key = computeRevisionKey(input.triggerMessageIds);
  const existing = getSubjectRevisionByKey(db, input.subjectId, key);
  if (existing !== null && getClaim(db, existing.id) !== null) return existing.id;
  const revisionId = existing?.id ?? randomUUID();
  const humanEventAtMs = input.triggerMessageIds.reduce((newest, id) => {
    const message = getMessage(db, id);
    return message ? Math.max(newest, message.created_at_ms) : newest;
  }, 0);
  prepareCached(
    db,
    'attention.revision_insert_legacy',
    `INSERT INTO attention_revisions
       (id, subject_id, revision_key, human_event_at_ms, explicit_deadline_at_ms,
        deadline_timezone, deadline_parser_version, state, created_at_ms)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'legacy_consumed', ?)
     ON CONFLICT(subject_id, revision_key) DO UPDATE
       SET state = 'legacy_consumed', explicit_deadline_at_ms = NULL,
           deadline_timezone = NULL, deadline_parser_version = NULL`,
  ).run(revisionId, input.subjectId, key, humanEventAtMs, input.now);
  const digestSource = input.triggerMessageIds.map((id) => getMessage(db, id)?.content ?? '');
  const evidence = prepareCached(
    db,
    'attention.evidence_insert_legacy',
    `INSERT INTO attention_revision_evidence
       (revision_id, message_id, role, source_content_digest, quote_start, quote_end)
     VALUES (?, ?, 'material_trigger', ?, 0, 0)
     ON CONFLICT(revision_id, message_id, role) DO NOTHING`,
  );
  input.triggerMessageIds.forEach((id, index) => {
    evidence.run(revisionId, id, sourceContentDigest(digestSource[index] ?? ''));
  });
  prepareCached(
    db,
    'attention.claim_insert_legacy',
    `INSERT INTO proposal_attention_claims
       (revision_id, proposal_id, consumed_at_ms, eligible_from_ms, eligible_until_ms)
     VALUES (?, NULL, ?, 0, ?)
     ON CONFLICT(revision_id) DO NOTHING`,
  ).run(revisionId, input.consumedAtMs, input.consumedAtMs);
  return revisionId;
}

/** Representative memory ids of a subject, active members first. */
export function listSubjectMemoryIds(db: DatabaseSync, subjectId: string): string[] {
  const rows = prepareCached(
    db,
    'attention.subject_memories',
    `SELECT m.memory_id AS memory_id, mem.status AS status
       FROM attention_subject_members m
       LEFT JOIN memories mem ON mem.id = m.memory_id
      WHERE m.subject_id = ?
      ORDER BY CASE WHEN mem.status = 'active' THEN 0 ELSE 1 END, m.memory_id`,
  ).all(subjectId) as Array<{ memory_id: string }>;
  return rows.map((row) => row.memory_id);
}

/** Material-trigger message IDs of one revision. */
export function listRevisionTriggerMessageIds(db: DatabaseSync, revisionId: string): string[] {
  const rows = prepareCached(
    db,
    'attention.revision_triggers',
    `SELECT message_id FROM attention_revision_evidence
      WHERE revision_id = ? AND role = 'material_trigger'`,
  ).all(revisionId) as Array<{ message_id: string }>;
  return rows.map((row) => row.message_id);
}

/**
 * Attention ownership and window check for an unsent proposal (Section 12.7).
 * The SAME proposal must own its revision claim and sit inside the immutable
 * window; checking "unconsumed" here would wrongly block every send, so the
 * claim's owner and window are the authority. Episode and scheduled proposals
 * without a claim fail closed: post-cutover proposals always carry one.
 */
export function validateProposalAttention(
  db: DatabaseSync,
  proposalId: string,
  now: number,
): { attention: boolean; allow: boolean; reasons: string[]; revisionId?: string } {
  const proposal = db.prepare(
    'SELECT run_id FROM proposals WHERE id = ?',
  ).get(proposalId) as { run_id: string } | undefined;
  if (!proposal) return { attention: false, allow: true, reasons: [] };
  const run = db.prepare('SELECT run_type FROM agent_runs WHERE id = ?').get(proposal.run_id) as
    | { run_type: string }
    | undefined;
  if (run?.run_type !== 'episode' && run?.run_type !== 'scheduled_review') {
    return { attention: false, allow: true, reasons: [] };
  }
  const claim = getClaimByProposal(db, proposalId);
  if (!claim) {
    return {
      attention: true,
      allow: false,
      reasons: ['attention authority missing: the proposal claims no revision'],
    };
  }
  if (claim.proposalId !== proposalId) {
    return {
      attention: true,
      allow: false,
      reasons: ['attention ownership mismatch: the revision belongs to another proposal'],
      revisionId: claim.revisionId,
    };
  }
  if (now < claim.eligibleFromMs || now > claim.eligibleUntilMs) {
    return {
      attention: true,
      allow: false,
      reasons: ['attention window expired before delivery'],
      revisionId: claim.revisionId,
    };
  }
  const revision = getRevision(db, claim.revisionId);
  if (!revision || !validateRevisionEvidence(db, claim.revisionId, now)) {
    return {
      attention: true,
      allow: false,
      reasons: ['attention trigger changed: the revision is no longer current'],
      revisionId: claim.revisionId,
    };
  }
  return { attention: true, allow: true, reasons: [], revisionId: claim.revisionId };
}
