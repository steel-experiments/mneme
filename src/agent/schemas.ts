import { Type, type TSchema, type TProperties, type TObject, type ObjectOptions } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Runtime schemas for agent tools and terminal proposals (Sections 22, 23).
 *
 * Every shape the model can produce is expressed as a TypeBox schema and
 * validated by the host before it touches the database or Discord — the model
 * proposes, the host validates. Schemas are strict (unknown properties fail) and
 * carry the enum, length, range, and item caps from the spec. {@link validate}
 * returns bounded field-level errors so the agent gets one correction attempt.
 */

/**
 * Object schema helper that forbids unknown properties. TypeBox's Type.Object
 * permits extra keys by default; the spec requires the host to reject them, so
 * every object schema is built through this and `additionalProperties: false`
 * applies at each level (including nested objects referenced in arrays).
 */
function strict<P extends TProperties>(props: P, options: ObjectOptions = {}): TObject<P> {
  return Type.Object(props, { additionalProperties: false, ...options }) as TObject<P>;
}

// ---- Shared enums ----------------------------------------------------------

export const MemoryTypeEnum = Type.Union([
  Type.Literal('decision'), Type.Literal('assumption'), Type.Literal('prediction'),
  Type.Literal('fact'), Type.Literal('risk'), Type.Literal('commitment'),
  Type.Literal('experiment'), Type.Literal('disagreement'), Type.Literal('constraint'),
  Type.Literal('open_question'),
]);
export const MemoryStatusEnum = Type.Union([
  Type.Literal('active'), Type.Literal('superseded'), Type.Literal('resolved'),
  Type.Literal('invalidated'), Type.Literal('expired'),
]);
export const MemoryActionEnum = Type.Union([
  Type.Literal('create'), Type.Literal('confirm'), Type.Literal('update'),
  Type.Literal('supersede'), Type.Literal('resolve'), Type.Literal('invalidate'),
]);
export const EvidenceStanceEnum = Type.Union([
  Type.Literal('origin'), Type.Literal('supports'), Type.Literal('contradicts'),
  Type.Literal('updates'), Type.Literal('resolves'),
]);
export const UrgencyEnum = Type.Union([
  Type.Literal('normal'), Type.Literal('time_sensitive'), Type.Literal('critical_review'),
]);

const Id = Type.String({ minLength: 1, maxLength: 64 });
const Score = Type.Number({ minimum: 0, maximum: 1 });

// ---- Episode-review contract (Section 23) ----------------------------------

export const EvidenceDimensions = strict({
  impact: Score,
  evidenceStrength: Score,
  contradictionStrength: Score,
  urgency: Score,
  novelty: Score,
  interruptionCost: Score,
});

export const MemoryEvidenceQuote = strict({
  messageId: Id,
  quote: Type.String({ minLength: 1, maxLength: 500 }),
});

// ---- Proactive attention (Section 12.7) ------------------------------------

/** Relation a material human development has to its subject. */
export const AttentionRelationEnum = Type.Union([
  Type.Literal('new_commitment'),
  Type.Literal('changed_decision'),
  Type.Literal('explicit_reopening'),
  Type.Literal('specific_outcome'),
  Type.Literal('contradiction'),
]);

export const AttentionEvidenceItem = strict({
  messageId: Id,
  quote: Type.String({ minLength: 1, maxLength: 500 }),
});

/** A material human development offered as attention-changing evidence. */
export const AttentionChange = strict({
  evidence: Type.Array(AttentionEvidenceItem, { minItems: 1, maxItems: 3 }),
  relation: AttentionRelationEnum,
  materialChange: Type.String({ minLength: 1, maxLength: 500 }),
});

/** Explicit human-stated deadline authority: set or clear with exact quotes. */
export const DeadlineChange = Type.Union([
  strict({
    action: Type.Literal('set'),
    sourceMessageId: Id,
    quote: Type.String({ minLength: 1, maxLength: 500 }),
    dateExpression: Type.String({ minLength: 1, maxLength: 64 }),
    proposedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  }),
  strict({
    action: Type.Literal('clear'),
    sourceMessageId: Id,
    quote: Type.String({ minLength: 1, maxLength: 500 }),
  }),
]);

/** Which durable memory an intervention speaks about. */
export const InterventionSubject = Type.Union([
  strict({ kind: Type.Literal('existing_memory'), memoryId: Id }),
  strict({ kind: Type.Literal('memory_proposal'), proposalIndex: Type.Integer({ minimum: 0, maximum: 19 }) }),
]);

/** The current reason to speak: a fresh human development or a due deadline. */
export const InterventionTrigger = Type.Union([
  strict({
    kind: Type.Literal('new_human_evidence'),
    evidence: Type.Array(AttentionEvidenceItem, { minItems: 1, maxItems: 3 }),
    relation: AttentionRelationEnum,
    materialChange: Type.String({ minLength: 1, maxLength: 500 }),
  }),
  strict({ kind: Type.Literal('human_deadline'), revisionId: Id }),
  strict({ kind: Type.Literal('none') }),
]);

export const MemoryDurabilityEnum = Type.Union([
  Type.Literal('transient'),
  Type.Literal('project'),
  Type.Literal('organizational'),
]);

export const MemoryProposal = strict({
  action: MemoryActionEnum,
  type: MemoryTypeEnum,
  statement: Type.String({ minLength: 1, maxLength: 1200 }),
  existingMemoryId: Type.Optional(Id),
  confidence: Score,
  importance: Score,
  evidenceMessageIds: Type.Array(Id, { minItems: 1, maxItems: 20 }),
  evidenceQuotes: Type.Array(MemoryEvidenceQuote, { minItems: 1, maxItems: 20 }),
  durability: MemoryDurabilityEnum,
  durabilityReason: Type.String({ minLength: 1, maxLength: 500 }),
  independentReason: Type.Optional(Type.String({ minLength: 20, maxLength: 500 })),
  ownerUserId: Type.Optional(Id),
  reviewAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  attentionChange: Type.Optional(AttentionChange),
  deadlineChange: Type.Optional(DeadlineChange),
});

export const InterventionProposal = strict({
  recommend: Type.Boolean(),
  reason: Type.String({ maxLength: 1200 }),
  dimensions: EvidenceDimensions,
  confidence: Score,
  urgency: UrgencyEnum,
  targetChannelId: Id,
  replyToMessageId: Type.Optional(Id),
  evidenceMessageIds: Type.Array(Id, { maxItems: 10 }),
  message: Type.Optional(Type.String({ maxLength: 1800 })),
  subject: Type.Optional(InterventionSubject),
  trigger: Type.Optional(InterventionTrigger),
});

export const FinalizeEpisodeReview = strict({
  episodeSummary: Type.String({ maxLength: 1600 }),
  consequential: Type.Boolean(),
  memoryProposals: Type.Array(MemoryProposal, { maxItems: 20 }),
  intervention: InterventionProposal,
  unresolvedQuestions: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 10 }),
});

// ---- Direct-answer terminal (Section 19) -----------------------------------
// The agent answers one addressed question and may cite up to three permitted
// message links; everything else is host-computed.

export const FinalizeDirectAnswer = strict({
  targetChannelId: Id,
  message: Type.String({ minLength: 1, maxLength: 1800 }),
  citedMessageIds: Type.Array(Id, { maxItems: 3 }),
  replyToMessageId: Type.Optional(Id),
});

// ---- Scheduled-review terminal (Section 20) --------------------------------
// Review of due memories: proposed updates plus an optional notification whose
// exact target is supplied and pinned by the host cohort.

export const ScheduledNotification = strict({
  recommend: Type.Boolean(),
  reason: Type.String({ maxLength: 1200 }),
  targetChannelId: Id,
  message: Type.Optional(Type.String({ maxLength: 1800 })),
  evidenceMessageIds: Type.Array(Id, { maxItems: 3 }),
  subjectMemoryIds: Type.Array(Id, { maxItems: 1 }),
  /** Echo of the cohort's host-pinned attention revision (Section 12.7). */
  attentionRevisionId: Type.Optional(Id),
});

export const FinalizeScheduledReview = strict({
  memoryProposals: Type.Array(MemoryProposal, { maxItems: 20 }),
  notification: ScheduledNotification,
  notes: Type.Optional(Type.String({ maxLength: 1600 })),
});

// ---- Retrieval tool inputs (Section 22) ------------------------------------

export const SearchMessagesToolInput = strict({
  query: Type.String({ minLength: 1, maxLength: 256 }),
  channelIds: Type.Optional(Type.Array(Id, { maxItems: 50 })),
  authorIds: Type.Optional(Type.Array(Id, { maxItems: 50 })),
  before: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  after: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const ListRecentMessagesToolInput = strict({
  channelIds: Type.Optional(Type.Array(Id, { maxItems: 50 })),
  authorIds: Type.Optional(Type.Array(Id, { maxItems: 50 })),
  before: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  beforeMessageId: Type.Optional(Id),
  after: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

/**
 * Direct-answer-only one-call catch-up snapshot. Both bounds are required so a
 * conversational phrase can never silently widen into unbounded history.
 */
export const GetRecentActivitySnapshotToolInput = strict({
  after: Type.String({ minLength: 1, maxLength: 40 }),
  before: Type.String({ minLength: 1, maxLength: 40 }),
  channelIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 50 })),
});

export const GetMessageContextToolInput = strict({
  messageId: Id,
  beforeCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
  afterCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
  includeReplies: Type.Optional(Type.Boolean()),
});

export const SearchMemoriesToolInput = strict({
  query: Type.String({ minLength: 1, maxLength: 256 }),
  types: Type.Optional(Type.Array(MemoryTypeEnum, { maxItems: 10 })),
  statuses: Type.Optional(Type.Array(MemoryStatusEnum, { maxItems: 5 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

/** Archive ids carry the `archive:` prefix (plan 011). */
const ArchiveId = Type.String({ minLength: 9, maxLength: 200, pattern: '^archive:' });

export const SearchArchiveMessagesToolInput = strict({
  query: Type.String({ minLength: 1, maxLength: 256 }),
  before: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  after: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const GetArchiveMessageContextToolInput = strict({
  messageId: ArchiveId,
  beforeCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
  afterCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
});

export const SearchArchiveMemoriesToolInput = strict({
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const ListMemoriesToolInput = strict({
  types: Type.Optional(Type.Array(MemoryTypeEnum, { maxItems: 10 })),
  statuses: Type.Optional(Type.Array(MemoryStatusEnum, { maxItems: 5 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const GetMemoryEvidenceToolInput = strict({
  memoryId: Id,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

// ---- Documentation tool inputs (Sections 22.5, 22.6) -----------------------

export const ListDocsToolInput = strict({});

export const ReadDocToolInput = strict({
  /** Must equal a documentation index path exactly; the host resolves nothing else. */
  path: Type.String({ minLength: 1, maxLength: 256 }),
});

// ---- Validation ------------------------------------------------------------

export interface FieldError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: FieldError[];
}

/**
 * Validate `value` against a TypeBox schema, returning bounded field-level
 * errors (Section 23 — one correction attempt). Unknown properties, missing
 * required fields, and out-of-range values all fail.
 */
export function validate(schema: TSchema, value: unknown): ValidationResult {
  const errors = [...Value.Errors(schema, value)];
  if (errors.length === 0) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: errors.map((e) => ({ path: e.path, message: e.message })),
  };
}
