import { randomUUID } from 'node:crypto';
import { type DatabaseSync, transaction } from '../db/database.js';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { prepareCached } from '../db/repositories/util.js';
import {
  channelVisibilityPredicate,
  type RetrievalGrant,
} from '../db/repositories/message-search.js';
import {
  computeEffectiveScope,
  type EffectiveScope,
  type ScopeEvidenceChannel,
  type VisibilityLookup,
} from './scope.js';

/**
 * Host-controlled memory mutations (Sections 12.1–12.3, 23).
 *
 * Every action is transactional and evidence-bound: no durable memory exists
 * without at least one valid Discord message, and every evidence message must be
 * visible under the run's {@link RetrievalGrant}. Scope is computed from the
 * evidence (Section 7.2) and stored on the memory; the model never supplies it.
 * Invalid lifecycle transitions and cross-scope proposals are rejected before
 * any row is written.
 */

export type MemoryType =
  | 'decision'
  | 'assumption'
  | 'prediction'
  | 'fact'
  | 'risk'
  | 'commitment'
  | 'experiment'
  | 'disagreement'
  | 'constraint'
  | 'open_question';

export type MemoryStatus =
  | 'active'
  | 'superseded'
  | 'resolved'
  | 'invalidated'
  | 'expired';

export type EvidenceStance =
  | 'origin'
  | 'supports'
  | 'contradicts'
  | 'updates'
  | 'resolves';

const MEMORY_TYPES: readonly MemoryType[] = [
  'decision', 'assumption', 'prediction', 'fact', 'risk', 'commitment',
  'experiment', 'disagreement', 'constraint', 'open_question',
];
const STANCES: readonly EvidenceStance[] = [
  'origin', 'supports', 'contradicts', 'updates', 'resolves',
];

const MIN_STATEMENT = 1;
const MAX_STATEMENT = 1200;
const MAX_EVIDENCE = 20;

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

export interface MemoryEvidenceInput {
  messageId: string;
  stance: EvidenceStance;
  weight?: number;
  note?: string;
}

export interface MemoryFields {
  type: MemoryType;
  statement: string;
  confidence: number;
  importance: number;
  ownerUserId?: string;
  reviewAfterMs?: number;
  validFromMs?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateMemoryInput extends MemoryFields {
  guildId: string;
  evidence: MemoryEvidenceInput[];
  createdByRunId?: string;
  now: number;
}

interface ResolvedEvidence {
  scope: EffectiveScope;
  /** One {messageId, stance, weight, note} per input evidence, validated. */
  rows: MemoryEvidenceInput[];
}

/**
 * Validate that every evidence message exists, is undeleted, and is visible under
 * `grant`; then compute the effective scope from the evidence channels. Throws
 * {@link MemoryValidationError} when any evidence is missing or out of scope
 * (cross-scope rejection — Section 7.3).
 */
function resolveEvidenceScope(
  db: DatabaseSync,
  grant: RetrievalGrant,
  evidence: MemoryEvidenceInput[],
  _now: number,
): ResolvedEvidence {
  if (evidence.length === 0) {
    throw new MemoryValidationError('at least one evidence message is required');
  }
  if (evidence.length > MAX_EVIDENCE) {
    throw new MemoryValidationError(`at most ${MAX_EVIDENCE} evidence messages are allowed`);
  }
  for (const ev of evidence) {
    if (!STANCES.includes(ev.stance)) {
      throw new MemoryValidationError(`invalid evidence stance: ${ev.stance}`);
    }
    if (ev.weight !== undefined && (ev.weight < 0 || ev.weight > 1)) {
      throw new MemoryValidationError('evidence weight must be in [0, 1]');
    }
  }

  const uniqueIds = [...new Set(evidence.map((e) => e.messageId))];
  const pred = channelVisibilityPredicate(grant);
  const ph = uniqueIds.map(() => '?').join(',');
  const sql = `
    SELECT m.id AS message_id, m.channel_id, c.visibility_class, c.parent_id, c.is_thread,
           parent.visibility_class AS parent_visibility_class
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
      LEFT JOIN channels parent ON parent.id = c.parent_id AND c.is_thread = 1
     WHERE m.deleted_at_ms IS NULL AND ${pred.sql} AND m.id IN (${ph})
  `;
  const cacheKey = `memory.evidence_scope:${pred.sql}:${uniqueIds.length}`;
  const rows = prepareCached(db, cacheKey, sql).all(
    ...pred.params,
    ...uniqueIds,
  ) as Array<{
    message_id: string;
    channel_id: string;
    visibility_class: string;
    parent_id: string | null;
    is_thread: number;
    parent_visibility_class: string | null;
  }>;

  if (rows.length < uniqueIds.length) {
    // Some evidence is missing, deleted, or out of grant scope.
    throw new MemoryValidationError(
      'one or more evidence messages are missing, deleted, or outside the run scope',
    );
  }

  const chanMap = new Map<
    string,
    { visibility: string; parentId: string | null; isThread: boolean }
  >();
  for (const r of rows) {
    if (!chanMap.has(r.channel_id)) {
      chanMap.set(r.channel_id, {
        visibility: r.visibility_class,
        parentId: r.parent_id,
        isThread: r.is_thread === 1,
      });
    }
  }
  // A thread's anchor depends on its parent's class (Section 7.2), so the
  // lookup also knows the parents of thread evidence.
  const parentVisibility = new Map<string, string>();
  for (const r of rows) {
    if (r.is_thread === 1 && r.parent_id !== null && r.parent_visibility_class !== null) {
      parentVisibility.set(r.parent_id, r.parent_visibility_class);
    }
  }
  const lookup: VisibilityLookup = {
    visibilityClass: (id) => (chanMap.get(id)?.visibility ?? parentVisibility.get(id)) as never,
    parentChannelId: (id) => chanMap.get(id)?.parentId ?? null,
  };
  const scopeEvidence: ScopeEvidenceChannel[] = rows.map((r) => ({
    channelId: r.channel_id,
    isThread: chanMap.get(r.channel_id)!.isThread,
  }));

  return { scope: computeEffectiveScope(scopeEvidence, lookup), rows: evidence };
}

function normalizeKey(statement: string): string {
  return statement.trim().toLowerCase().replace(/\s+/g, ' ');
}

function validateFields(fields: MemoryFields): void {
  if (!MEMORY_TYPES.includes(fields.type)) {
    throw new MemoryValidationError(`invalid memory type: ${fields.type}`);
  }
  const statement = fields.statement.trim();
  if (statement.length < MIN_STATEMENT || statement.length > MAX_STATEMENT) {
    throw new MemoryValidationError(
      `statement must be ${MIN_STATEMENT}–${MAX_STATEMENT} characters`,
    );
  }
  if (fields.confidence < 0 || fields.confidence > 1) {
    throw new MemoryValidationError('confidence must be in [0, 1]');
  }
  if (fields.importance < 0 || fields.importance > 1) {
    throw new MemoryValidationError('importance must be in [0, 1]');
  }
}

function assertOwnerExists(db: DatabaseSync, ownerUserId: string | undefined): void {
  if (ownerUserId === undefined) return;
  const row = prepareCached(db, 'memory.owner_exists', 'SELECT 1 FROM users WHERE id = ?').get(
    ownerUserId,
  );
  if (!row) throw new MemoryValidationError(`owner user does not exist: ${ownerUserId}`);
}

function insertEvidence(
  db: DatabaseSync,
  memoryId: string,
  evidence: MemoryEvidenceInput[],
  now: number,
): void {
  const stmt = prepareCached(
    db,
    'memory.insert_evidence',
    `INSERT INTO memory_evidence (memory_id, message_id, stance, weight, note, created_at_ms)
     VALUES (@memory_id, @message_id, @stance, @weight, @note, @created_at_ms)
     ON CONFLICT(memory_id, message_id, stance) DO UPDATE SET weight = excluded.weight`,
  );
  for (const ev of evidence) {
    stmt.run({
      memory_id: memoryId,
      message_id: ev.messageId,
      stance: ev.stance,
      weight: ev.weight ?? 1,
      note: ev.note ?? null,
      created_at_ms: now,
    });
  }
}

const INSERT_MEMORY_SQL = `
  INSERT INTO memories (id, workspace_id, scope_type, scope_key, type, statement, normalized_key,
      status, confidence, importance, owner_user_id, valid_from_ms, review_after_ms,
      resolved_at_ms, first_seen_at_ms, last_confirmed_at_ms, created_by_run_id,
      supersedes_memory_id, metadata_json, created_at_ms, updated_at_ms)
  VALUES (@id, @workspace_id, @scope_type, @scope_key, @type, @statement, @normalized_key,
      @status, @confidence, @importance, @owner_user_id, @valid_from_ms, @review_after_ms,
      NULL, @now, @now, @created_by_run_id, @supersedes_memory_id, @metadata_json, @now, @now)
`;

interface MemoryInsert {
  guildId: string;
  scope: EffectiveScope;
  type: MemoryType;
  statement: string;
  confidence: number;
  importance: number;
  ownerUserId: string | null;
  validFromMs: number;
  reviewAfterMs: number | null;
  createdByRunId: string | null;
  supersedesMemoryId: string | null;
  metadataJson: string;
  status: MemoryStatus;
  now: number;
}

function insertMemory(db: DatabaseSync, input: MemoryInsert): string {
  const id = randomUUID();
  prepareCached(db, 'memory.insert', INSERT_MEMORY_SQL).run({
    id,
    workspace_id: input.guildId,
    scope_type: input.scope.scopeType,
    scope_key: input.scope.scopeKey,
    type: input.type,
    statement: input.statement,
    normalized_key: normalizeKey(input.statement),
    status: input.status,
    confidence: input.confidence,
    importance: input.importance,
    owner_user_id: input.ownerUserId,
    valid_from_ms: input.validFromMs,
    review_after_ms: input.reviewAfterMs,
    created_by_run_id: input.createdByRunId,
    supersedes_memory_id: input.supersedesMemoryId,
    metadata_json: input.metadataJson,
    now: input.now,
  });
  return id;
}

export interface MemoryRow {
  id: string;
  workspace_id: string;
  scope_type: string;
  scope_key: string | null;
  type: MemoryType;
  statement: string;
  normalized_key: string | null;
  status: MemoryStatus;
  confidence: number;
  importance: number;
  owner_user_id: string | null;
  valid_from_ms: number | null;
  review_after_ms: number | null;
  resolved_at_ms: number | null;
  first_seen_at_ms: number;
  last_confirmed_at_ms: number;
  created_by_run_id: string | null;
  supersedes_memory_id: string | null;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export function getMemory(db: DatabaseSync, id: string): MemoryRow | undefined {
  const row = prepareCached(db, 'memory.get', 'SELECT * FROM memories WHERE id = ?').get(id) as
    | Record<string, SQLOutputValue>
    | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    scope_type: String(row.scope_type),
    scope_key: row.scope_key === null ? null : String(row.scope_key),
    type: String(row.type) as MemoryType,
    statement: String(row.statement),
    normalized_key: row.normalized_key === null ? null : String(row.normalized_key),
    status: String(row.status) as MemoryStatus,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    owner_user_id: row.owner_user_id === null ? null : String(row.owner_user_id),
    valid_from_ms: row.valid_from_ms === null ? null : Number(row.valid_from_ms),
    review_after_ms: row.review_after_ms === null ? null : Number(row.review_after_ms),
    resolved_at_ms: row.resolved_at_ms === null ? null : Number(row.resolved_at_ms),
    first_seen_at_ms: Number(row.first_seen_at_ms),
    last_confirmed_at_ms: Number(row.last_confirmed_at_ms),
    created_by_run_id: row.created_by_run_id === null ? null : String(row.created_by_run_id),
    supersedes_memory_id:
      row.supersedes_memory_id === null ? null : String(row.supersedes_memory_id),
    metadata_json: String(row.metadata_json),
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
  };
}

/** Require a memory to exist and be in one of `allowed` statuses; return it. */
function requireMemoryInStatus(
  db: DatabaseSync,
  id: string,
  allowed: MemoryStatus[],
): MemoryRow {
  const mem = getMemory(db, id);
  if (!mem) throw new MemoryValidationError(`memory does not exist: ${id}`);
  if (!allowed.includes(mem.status)) {
    throw new MemoryValidationError(
      `memory ${id} is ${mem.status}; expected ${allowed.join(' or ')}`,
    );
  }
  return mem;
}

/** Create a new active memory from validated evidence. */
export function createMemory(db: DatabaseSync, grant: RetrievalGrant, input: CreateMemoryInput): string {
  validateFields(input);
  assertOwnerExists(db, input.ownerUserId);
  const { scope } = resolveEvidenceScope(db, grant, input.evidence, input.now);

  return transaction(db, () => {
    const id = insertMemory(db, {
      guildId: input.guildId,
      scope,
      type: input.type,
      statement: input.statement.trim(),
      confidence: input.confidence,
      importance: input.importance,
      ownerUserId: input.ownerUserId ?? null,
      validFromMs: input.validFromMs ?? input.now,
      reviewAfterMs: input.reviewAfterMs ?? null,
      createdByRunId: input.createdByRunId ?? null,
      supersedesMemoryId: null,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      status: 'active',
      now: input.now,
    });
    insertEvidence(db, id, input.evidence, input.now);
    return id;
  });
}

export interface ConfirmMemoryInput {
  memoryId: string;
  evidence: MemoryEvidenceInput[];
  now: number;
}

/** Add supporting evidence and refresh the confirmation timestamp. */
export function confirmMemory(db: DatabaseSync, grant: RetrievalGrant, input: ConfirmMemoryInput): void {
  resolveEvidenceScope(db, grant, input.evidence, input.now);
  transaction(db, () => {
    requireMemoryInStatus(db, input.memoryId, ['active']);
    insertEvidence(db, input.memoryId, input.evidence, input.now);
    prepareCached(
      db,
      'memory.confirm',
      "UPDATE memories SET last_confirmed_at_ms = @now, updated_at_ms = @now WHERE id = @id AND status = 'active'",
    ).run({ id: input.memoryId, now: input.now });
  });
}

export interface UpdateMemoryInput extends Partial<MemoryFields> {
  memoryId: string;
  evidence: MemoryEvidenceInput[];
  now: number;
}

/** Update fields on an active memory; scope is recomputed over all its evidence. */
export function updateMemory(db: DatabaseSync, grant: RetrievalGrant, input: UpdateMemoryInput): void {
  const current = requireMemoryInStatus(db, input.memoryId, ['active']);
  validateFields({
    type: input.type ?? current.type,
    statement: input.statement ?? current.statement,
    confidence: input.confidence ?? current.confidence,
    importance: input.importance ?? current.importance,
  });
  // Recompute scope over the union of existing and new evidence so the memory
  // never broadens beyond what its total evidence justifies.
  const existing = prepareCached(
    db,
    'memory.existing_evidence',
    'SELECT message_id FROM memory_evidence WHERE memory_id = ?',
  ).all(input.memoryId) as { message_id: string }[];
  const unionEvidence: MemoryEvidenceInput[] = [
    ...existing.map((e) => ({ messageId: e.message_id, stance: 'origin' as EvidenceStance })),
    ...input.evidence,
  ];
  const { scope } = resolveEvidenceScope(db, grant, unionEvidence, input.now);

  transaction(db, () => {
    requireMemoryInStatus(db, input.memoryId, ['active']);
    insertEvidence(db, input.memoryId, input.evidence, input.now);
    const sets: string[] = [
      'updated_at_ms = @now',
      'last_confirmed_at_ms = @now',
      'scope_type = @scope_type',
      'scope_key = @scope_key',
    ];
    const params: Record<string, SQLInputValue> = {
      id: input.memoryId,
      now: input.now,
      scope_type: scope.scopeType,
      scope_key: scope.scopeKey,
    };
    if (input.statement !== undefined) {
      sets.push('statement = @statement', 'normalized_key = @normalized_key');
      params.statement = input.statement.trim();
      params.normalized_key = normalizeKey(input.statement);
    }
    if (input.type !== undefined) {
      sets.push('type = @type');
      params.type = input.type;
    }
    if (input.confidence !== undefined) {
      sets.push('confidence = @confidence');
      params.confidence = input.confidence;
    }
    if (input.importance !== undefined) {
      sets.push('importance = @importance');
      params.importance = input.importance;
    }
    if (input.reviewAfterMs !== undefined) {
      sets.push('review_after_ms = @review_after_ms');
      params.review_after_ms = input.reviewAfterMs;
    }
    if (input.metadata !== undefined) {
      sets.push('metadata_json = @metadata_json');
      params.metadata_json = JSON.stringify(input.metadata);
    }

    const sql = `UPDATE memories SET ${sets.join(', ')} WHERE id = @id AND status = 'active'`;
    prepareCached(db, `memory.update:${sets.join(',')}`, sql).run(params);
  });
}

export interface SupersedeMemoryInput extends MemoryFields {
  existingMemoryId: string;
  guildId: string;
  evidence: MemoryEvidenceInput[];
  createdByRunId?: string;
  now: number;
}

/** Create a new active memory that supersedes an existing active one. */
export function supersedeMemory(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: SupersedeMemoryInput,
): string {
  validateFields(input);
  assertOwnerExists(db, input.ownerUserId);
  const { scope } = resolveEvidenceScope(db, grant, input.evidence, input.now);

  return transaction(db, () => {
    requireMemoryInStatus(db, input.existingMemoryId, ['active']);
    const id = insertMemory(db, {
      guildId: input.guildId,
      scope,
      type: input.type,
      statement: input.statement.trim(),
      confidence: input.confidence,
      importance: input.importance,
      ownerUserId: input.ownerUserId ?? null,
      validFromMs: input.validFromMs ?? input.now,
      reviewAfterMs: input.reviewAfterMs ?? null,
      createdByRunId: input.createdByRunId ?? null,
      supersedesMemoryId: input.existingMemoryId,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      status: 'active',
      now: input.now,
    });
    insertEvidence(db, id, input.evidence, input.now);
    prepareCached(
      db,
      'memory.supersede_old',
      "UPDATE memories SET status = 'superseded', updated_at_ms = @now WHERE id = @id AND status = 'active'",
    ).run({ id: input.existingMemoryId, now: input.now });
    prepareCached(
      db,
      'memory.link_supersede',
      `INSERT INTO memory_links (source_memory_id, target_memory_id, relation, created_at_ms)
       VALUES (@src, @tgt, 'supersedes', @now)
       ON CONFLICT(source_memory_id, target_memory_id, relation) DO NOTHING`,
    ).run({ src: id, tgt: input.existingMemoryId, now: input.now });
    return id;
  });
}

export interface LifecycleInput {
  memoryId: string;
  evidence: MemoryEvidenceInput[];
  now: number;
}

/** Mark an active memory resolved (evidence stance `resolves`). */
export function resolveMemory(db: DatabaseSync, grant: RetrievalGrant, input: LifecycleInput): void {
  resolveEvidenceScope(db, grant, input.evidence, input.now);
  transaction(db, () => {
    requireMemoryInStatus(db, input.memoryId, ['active']);
    insertEvidence(db, input.memoryId, input.evidence, input.now);
    prepareCached(
      db,
      'memory.resolve',
      `UPDATE memories
         SET status = 'resolved', resolved_at_ms = @now, last_confirmed_at_ms = @now, updated_at_ms = @now
       WHERE id = @id AND status = 'active'`,
    ).run({ id: input.memoryId, now: input.now });
  });
}

/** Mark an active memory invalidated (evidence stance `contradicts`). */
export function invalidateMemory(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: LifecycleInput,
): void {
  resolveEvidenceScope(db, grant, input.evidence, input.now);
  transaction(db, () => {
    requireMemoryInStatus(db, input.memoryId, ['active']);
    insertEvidence(db, input.memoryId, input.evidence, input.now);
    prepareCached(
      db,
      'memory.invalidate',
      `UPDATE memories
         SET status = 'invalidated', resolved_at_ms = @now, last_confirmed_at_ms = @now, updated_at_ms = @now
       WHERE id = @id AND status = 'active'`,
    ).run({ id: input.memoryId, now: input.now });
  });
}
