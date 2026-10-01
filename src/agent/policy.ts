/**
 * Deterministic intervention policy (Section 24).
 *
 * The host — never the model — computes the intervention score from the
 * model-supplied dimensions. The arithmetic is fixed and independent of the
 * model's `recommend` flag: the score is a tuning input, not a safety boundary.
 * The controls that actually prevent a bad post (evidence validation, retrieval
 * provenance, cooldowns, duplicate detection, forced review) live elsewhere.
 */

import type { RetrievalProvenance } from './run-context.js';
import type { VisibilityClass } from '../db/repositories/channels.js';
import type { AutonomyMode } from '../config.js';
import type { CooldownDecision } from './cooldowns.js';
import type { DuplicateResult } from './duplicate-policy.js';
import type { AttentionRejectionReason } from '../memory/attention.js';

/** The six model-supplied dimensions, each expected in [0, 1]. */
export interface InterventionDimensions {
  impact: number;
  evidenceStrength: number;
  contradictionStrength: number;
  urgency: number;
  novelty: number;
  interruptionCost: number;
}

// Section 24.1 weights.
const W_IMPACT = 0.3;
const W_EVIDENCE = 0.25;
const W_CONTRADICTION = 0.2;
const W_URGENCY = 0.15;
const W_NOVELTY = 0.1;
const W_INTERRUPTION = 0.25;

/** Clamp a value to the closed interval [lo, hi]. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function assertDimension(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Intervention dimension "${name}" must be a finite number.`);
  }
  return value;
}

/**
 * Compute the Section 24.1 intervention score from model-supplied dimensions.
 *
 * ```text
 * positive = 0.30·impact + 0.25·evidenceStrength + 0.20·contradictionStrength
 *          + 0.15·urgency + 0.10·novelty
 * score    = clamp(positive − 0.25·interruptionCost, 0, 1)
 * ```
 *
 * Each dimension is numerically validated; the result is clamped to [0, 1] and
 * does not depend on the model's recommendation.
 */
export function computeInterventionScore(dimensions: InterventionDimensions): number {
  const impact = assertDimension('impact', dimensions.impact);
  const evidenceStrength = assertDimension('evidenceStrength', dimensions.evidenceStrength);
  const contradictionStrength = assertDimension(
    'contradictionStrength',
    dimensions.contradictionStrength,
  );
  const urgency = assertDimension('urgency', dimensions.urgency);
  const novelty = assertDimension('novelty', dimensions.novelty);
  const interruptionCost = assertDimension('interruptionCost', dimensions.interruptionCost);

  const positive =
    W_IMPACT * impact +
    W_EVIDENCE * evidenceStrength +
    W_CONTRADICTION * contradictionStrength +
    W_URGENCY * urgency +
    W_NOVELTY * novelty;

  return clamp(positive - W_INTERRUPTION * interruptionCost, 0, 1);
}

// ---------------------------------------------------------------------------
// Pinned-target and retrieval-provenance gate (Sections 7.3, 7.4, 23, 24.2,
// 46.3).
//
// Two host checks make paraphrase leaks structurally impossible (Section 7.4):
// (1) the proposal target must equal the host-pinned target, and (2) every scope
// the run actually retrieved must be permitted in the target scope — so a run
// that saw restricted or review-only content cannot emit to a broader target,
// even when the proposal cites no restricted evidence. The gate keys on
// retrieval provenance, not citations, which is what catches uncited paraphrase
// (Section 46.3 case 4). Uncertainty fails closed toward secure review.
// ---------------------------------------------------------------------------

/** The run kinds that carry distinct pinned-target resolution rules. */
export type PinnedTargetRunType = 'episode' | 'direct_answer' | 'scheduled_review';

export interface PinnedTargetContext {
  /** The episode's conversation channel (target for episode reviews). */
  episodeChannelId: string;
  /** The channel a direct mention arrived in (target for direct answers). */
  directAnswerChannelId: string;
  /** The configured secure review channel (target for scheduled reviews). */
  reviewChannelId: string;
  /** Host-derived working target for a scheduled cohort. */
  scheduledTargetChannelId?: string;
}

/**
 * Resolve the host-pinned target channel for a run (Section 7.4 check 1): the
 * episode's conversation channel for episode reviews, the current channel for
 * direct answers, and the host-derived cohort target for scheduled reviews. The model
 * cannot retarget a proposal away from this value.
 */
export function pinnedTargetForRunType(
  runType: PinnedTargetRunType,
  ctx: PinnedTargetContext,
): string {
  switch (runType) {
    case 'episode':
      return ctx.episodeChannelId;
    case 'direct_answer':
      return ctx.directAnswerChannelId;
    case 'scheduled_review':
      return ctx.scheduledTargetChannelId ?? ctx.reviewChannelId;
  }
}

/** A single resolved retrieval-scope entry the run was exposed to. */
export interface ProvenanceScopeEntry {
  kind: 'channel' | 'memory';
  /** Channel id for channel entries and channel-scoped memories; null for org/global scopes. */
  channelId: string | null;
  /** Effective visibility of this scope. `undefined` means unresolvable (uncertain). */
  visibility: VisibilityClass | undefined;
}

/** The target channel's resolved scope. */
export interface TargetScope {
  channelId: string;
  /** Canonical restricted-scope anchor (the parent channel for a thread). */
  scopeChannelId?: string;
  visibility: VisibilityClass;
  /** True when this channel is the configured secure review channel. */
  isSecureReview: boolean;
}

export interface ProvenanceGateInput {
  /** Channel the host pinned for this run. */
  pinnedTargetChannelId: string;
  /** Target the proposal declares (must equal the pinned target). */
  proposedTargetChannelId: string;
  /** Resolved target scope. */
  target: TargetScope;
  /** Every scope the run retrieved, resolved to effective visibility. */
  provenance: readonly ProvenanceScopeEntry[];
}

export type ProvenanceGateOutcome = 'allow' | 'force_review' | 'reject';

export interface ProvenanceGateResult {
  outcome: ProvenanceGateOutcome;
  /** Human-readable reasons (redacted of message content — scope/visibility only). */
  reasons: string[];
}

/**
 * Whether a retrieved scope may appear in output for the target (Section 7.3).
 * The secure review channel accepts all scopes; otherwise an `org` scope is
 * always permitted, a `restricted` scope only when it is the target channel
 * itself, and `review_only` (and anything unresolvable/excluded) is never
 * permitted — failing closed toward review.
 */
function scopePermittedInTarget(entry: ProvenanceScopeEntry, target: TargetScope): boolean {
  // Secure review may receive every *known* readable scope, but it is not a
  // bypass for stale/missing/deleted source state. Unknown and excluded
  // provenance still fail closed so content that became unavailable mid-run is
  // never emitted merely because the destination is privileged.
  if (target.isSecureReview) {
    return entry.visibility === 'org'
      || entry.visibility === 'restricted'
      || entry.visibility === 'review_only';
  }
  switch (entry.visibility) {
    case 'org':
      return true;
    case 'restricted':
      return target.visibility === 'restricted'
        && entry.channelId !== null
        && entry.channelId === (target.scopeChannelId ?? target.channelId);
    case 'review_only':
    case 'excluded':
    default:
      return false;
  }
}

/**
 * Evaluate the pinned-target (check 1) and retrieval-provenance (check 2) gates.
 *
 * - A target that differs from the host-pinned target is `reject`ed outright.
 * - Any retrieved scope not permitted in the target forces the proposal to
 *   secure review (`force_review`), because the run saw content broader than the
 *   target allows — this catches paraphrased restricted content regardless of
 *   what the proposal cites.
 * - Otherwise `allow`; the remaining Section 7.4 checks run downstream.
 */
export function evaluateProvenanceGate(input: ProvenanceGateInput): ProvenanceGateResult {
  if (input.proposedTargetChannelId !== input.pinnedTargetChannelId) {
    return {
      outcome: 'reject',
      reasons: [
        `proposed target "${input.proposedTargetChannelId}" does not match the host-pinned target "${input.pinnedTargetChannelId}"`,
      ],
    };
  }

  const reasons: string[] = [];
  for (const entry of input.provenance) {
    if (!scopePermittedInTarget(entry, input.target)) {
      const where = entry.channelId ? `:${entry.channelId}` : '';
      reasons.push(
        `retrieved ${entry.kind} scope "${entry.visibility ?? 'unknown'}${where}" is not permitted in target scope "${input.target.visibility}"`,
      );
    }
  }
  if (reasons.length > 0) {
    return { outcome: 'force_review', reasons };
  }
  return { outcome: 'allow', reasons: [] };
}

export interface ProvenanceLookups {
  /** Resolve a channel id to its current visibility class. */
  channelVisibility: (
    channelId: string,
    source?: RetrievalProvenance['channels'][number]['source'],
  ) => VisibilityClass | undefined;
  /** Normalize a thread id to the parent channel that owns its restricted scope. */
  channelScopeId?: (
    channelId: string,
    source?: RetrievalProvenance['channels'][number]['source'],
  ) => string | undefined;
}

/**
 * Map a memory's stored scope (`scope_type`/`scope_key`) to an effective
 * visibility class: `org` → org, `review_only` → review_only, `channel` → the
 * scope marker → restricted, and anything else → `undefined` (uncertain, so the
 * gate fails closed). A channel scope stays restricted even when its canonical
 * anchor is an org parent for an explicitly restricted thread. Retrieval tools
 * record recomputed scopes, so this function must not reinterpret the scope key
 * as the memory's visibility class.
 */
function memoryScopeToVisibility(
  scopeType: string,
  scopeKey: string | null,
): VisibilityClass | undefined {
  if (scopeType === 'org') return 'org';
  if (scopeType === 'review_only') return 'review_only';
  if (scopeType === 'channel') return scopeKey ? 'restricted' : undefined;
  return undefined;
}

/**
 * Resolve a run's {@link RetrievalProvenance} into effective-scope entries for
 * the gate. Channel entries take their current visibility directly; memory
 * scopes map from the memory scope model (`org` → org, `channel` → restricted
 * with the scope key, `review_only` → review_only). Unknown scopes resolve to
 * `undefined` so the gate treats them as uncertain and fails closed.
 */
export function resolveProvenanceScopes(
  provenance: RetrievalProvenance,
  lookups: ProvenanceLookups,
): ProvenanceScopeEntry[] {
  const entries: ProvenanceScopeEntry[] = [];
  for (const ch of provenance.channels) {
    entries.push({
      kind: 'channel',
      channelId: lookups.channelScopeId?.(ch.channelId, ch.source) ?? ch.channelId,
      visibility: lookups.channelVisibility(ch.channelId, ch.source),
    });
  }
  for (const mem of provenance.memoryScopes) {
    entries.push({
      kind: 'memory',
      channelId: mem.scopeKey ?? null,
      visibility: memoryScopeToVisibility(mem.scopeType, mem.scopeKey),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Outbound evidence and reply validation (Sections 7.4 checks 3-7, 24.2).
// Runs immediately before an outbox enqueue, against current DB/policy
// state, so invented/deleted/invisible/stale-policy/cross-channel references
// never become outbox rows. Definite violations suppress (reject); unresolvable
// scope is uncertain and fails closed to secure review.
// ---------------------------------------------------------------------------

export interface OutboundEvidenceLookups {
  /** Resolve a message: its channel, current visibility, and soft-delete time. */
  resolveMessage: (
    messageId: string,
  ) => {
    channelId: string;
    /** Canonical restricted-scope anchor; defaults to channelId. */
    scopeChannelId?: string;
    visibility: VisibilityClass;
    deletedAtMs: number | null;
  } | undefined;
  /** Resolve a referenced memory's stored scope. */
  resolveMemoryScope: (memoryId: string) => { scopeType: string; scopeKey: string | null } | undefined;
  /** Resolve a channel: current visibility, interventions flag, soft-delete time. */
  resolveChannel: (
    channelId: string,
  ) => { visibility: VisibilityClass; allowInterventions: boolean; deletedAtMs: number | null } | undefined;
}

export interface OutboundEvidenceInput {
  target: TargetScope;
  /** Cited evidence message ids from the proposal (Section 7.4 checks 3-4). */
  citedMessageIds: readonly string[];
  /** Referenced memory ids from the proposal (check 5). */
  referencedMemoryIds: readonly string[];
  /** Optional reply anchor from the proposal (check 7). */
  replyToMessageId?: string | null;
  /**
   * Whether the channel must opt in to unsolicited interventions. Explicit
   * direct answers set this false; autonomous/review proposals leave it true.
   */
  requireInterventionsEnabled?: boolean;
}

export type OutboundEvidenceOutcome = ProvenanceGateOutcome;

export interface OutboundEvidenceResult {
  outcome: OutboundEvidenceOutcome;
  reasons: string[];
}

/**
 * Validate cited sources, referenced memories, target policy, and the reply
 * anchor against current state immediately before enqueue (Sections 7.4, 24.2).
 *
 * Returns `reject` (suppress — no outbox row) for any definite violation: a
 * missing, deleted, or wrong-scope cited source or memory; a target channel
 * that was deleted, no longer allows interventions, or whose visibility changed
 * since the run pinned it (stale policy); or a reply anchor that is missing,
 * deleted, or in a different channel. Returns `force_review` only for genuinely
 * unresolvable scope (uncertain). Otherwise `allow`.
 */
export function validateOutboundEvidence(
  input: OutboundEvidenceInput,
  lookups: OutboundEvidenceLookups,
): OutboundEvidenceResult {
  const rejectReasons: string[] = [];
  const uncertainReasons: string[] = [];

  // Check 6 + stale target policy.
  const targetChannel = lookups.resolveChannel(input.target.channelId);
  if (!targetChannel) {
    rejectReasons.push(`target channel "${input.target.channelId}" no longer exists`);
  } else {
    if (targetChannel.deletedAtMs !== null) {
      rejectReasons.push(`target channel "${input.target.channelId}" was deleted`);
    }
    if (input.requireInterventionsEnabled !== false && !targetChannel.allowInterventions) {
      rejectReasons.push(`target channel "${input.target.channelId}" does not allow interventions`);
    }
    if (targetChannel.visibility !== input.target.visibility) {
      rejectReasons.push(
        `target channel "${input.target.channelId}" visibility is now "${targetChannel.visibility}", not "${input.target.visibility}" (stale policy)`,
      );
    }
  }

  // Checks 3-4: every cited source exists, is undeleted, and is visible in target.
  for (const id of input.citedMessageIds) {
    const msg = lookups.resolveMessage(id);
    if (!msg) {
      rejectReasons.push(`cited message "${id}" does not exist`);
      continue;
    }
    if (msg.deletedAtMs !== null) {
      rejectReasons.push(`cited message "${id}" was deleted`);
      continue;
    }
    if (!scopePermittedInTarget({
      kind: 'channel',
      channelId: msg.scopeChannelId ?? msg.channelId,
      visibility: msg.visibility,
    }, input.target)) {
      rejectReasons.push(
        `cited message "${id}" is in scope "${msg.visibility}:${msg.channelId}", not permitted in target scope "${input.target.visibility}"`,
      );
    }
  }

  // Check 5: every referenced memory is visible in target.
  for (const id of input.referencedMemoryIds) {
    const mem = lookups.resolveMemoryScope(id);
    if (!mem) {
      rejectReasons.push(`referenced memory "${id}" does not exist`);
      continue;
    }
    const visibility = memoryScopeToVisibility(mem.scopeType, mem.scopeKey);
    if (visibility === undefined) {
      uncertainReasons.push(`referenced memory "${id}" has unresolvable scope`);
      continue;
    }
    if (!scopePermittedInTarget({ kind: 'memory', channelId: mem.scopeKey, visibility }, input.target)) {
      rejectReasons.push(
        `referenced memory "${id}" scope "${visibility}${mem.scopeKey ? `:${mem.scopeKey}` : ''}" is not permitted in target scope "${input.target.visibility}"`,
      );
    }
  }

  // Check 7: a reply anchor must exist, be undeleted, and sit in the target channel.
  if (input.replyToMessageId) {
    const reply = lookups.resolveMessage(input.replyToMessageId);
    if (!reply) {
      rejectReasons.push(`reply anchor "${input.replyToMessageId}" does not exist`);
    } else {
      if (reply.deletedAtMs !== null) {
        rejectReasons.push(`reply anchor "${input.replyToMessageId}" was deleted`);
      }
      if (reply.channelId !== input.target.channelId) {
        rejectReasons.push(
          `reply anchor "${input.replyToMessageId}" is in channel "${reply.channelId}", not the target channel`,
        );
      }
    }
  }

  if (rejectReasons.length > 0) return { outcome: 'reject', reasons: rejectReasons };
  if (uncertainReasons.length > 0) return { outcome: 'force_review', reasons: uncertainReasons };
  return { outcome: 'allow', reasons: [] };
}

// ---------------------------------------------------------------------------
// Forced secure-review classification (Section 24.3).
//
// Independent of score, confidence, and limits: any proposal matching a forced-
// review rule is routed to the secure review channel even in autonomous mode.
// The five Section 24.3 cases map to deterministic host checks below. Rules fire
// on proposal characteristics the host computes itself; details never echo
// message content (only a category label), per the redaction rule.
// ---------------------------------------------------------------------------

export type ForcedReviewUrgency = 'normal' | 'time_sensitive' | 'critical_review';

/** Evidence strength at or above this counts as "strong" (Section 24.3). */
export const STRONG_EVIDENCE_THRESHOLD = 0.7;

export type ForcedReviewRuleName =
  | 'mixed_restricted_scopes'
  | 'sensitive_domain'
  | 'critical_without_strong_evidence'
  | 'names_individual_negatively'
  | 'validation_uncertainty';

export interface ForcedReviewRule {
  rule: ForcedReviewRuleName;
  /** Category label only (e.g. domain name) — never message content. */
  detail: string;
}

export interface ForcedReviewResult {
  /** True when any forced-review rule fired (proposal bypasses autonomous delivery). */
  forceReview: boolean;
  rules: ForcedReviewRule[];
}

export interface ForcedReviewInput {
  /** Proposed message text. */
  message: string;
  /** Model-supplied reason (optional; also scanned for sensitive-domain terms). */
  reason?: string;
  urgency: ForcedReviewUrgency;
  /** Model-supplied evidence-strength dimension in [0, 1]. */
  evidenceStrength: number;
  /** Distinct restricted channels the run retrieved (provenance). */
  distinctRestrictedChannelCount: number;
  /** True when any host validation was uncertain (Section 24.3 final case). */
  uncertain?: boolean;
  /**
   * Individual names the caller resolved as appearing in the message (for
   * negative-naming detection). The host never echoes these in output.
   */
  referencedIndividualNames?: readonly string[];
}

/** Sensitive-domain keyword sets (Section 24.3: legal/security/privacy/personnel/disciplinary). */
const SENSITIVE_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  legal: [
    'lawsuit', 'litigation', 'sue', 'attorney', 'lawyer', 'legal action', 'subpoena',
    'nda', 'contract breach', 'breach of contract', 'liability', 'statute',
  ],
  security: [
    'data breach', 'vulnerability', 'exploit', 'compromised', 'credential leak',
    'leaked credentials', 'phishing', 'malware', 'incident response', 'security incident',
    'ransomware',
  ],
  privacy: [
    'personal data', 'pii', 'gdpr', 'private information', 'doxx', 'doxing',
    'personal address', 'phone number', 'social security', 'medical record',
    'home address', 'salary',
  ],
  personnel: [
    'performance review', 'termination', 'terminated', 'fired', 'layoff', 'layoffs',
    'resignation', 'written up', 'pip', 'demotion', 'harassment', 'retaliation',
  ],
  disciplinary: [
    'misconduct', 'code of conduct', 'suspended', 'suspension', 'investigation',
    'warning issued', 'written warning', 'breach of trust', 'gross negligence',
  ],
};

/** Negative-context terms that, with an individual reference, trigger negative-naming review. */
const NEGATIVE_TERMS: readonly string[] = [
  'blame', 'blamed', 'failed', 'failure', 'responsible for', 'incompetent',
  'at fault', 'mistake', 'bad job', 'underperformed', 'missed', 'broke',
  'caused the', 'dropped the ball',
];

/** Mention syntax that names an individual, independent of model claims (Section 7.4 check 8 token form). */
const INDIVIDUAL_MENTION = /<@!?\d{17,20}>/;

function containsTerm(lowerText: string, term: string): boolean {
  const idx = lowerText.indexOf(term);
  if (idx === -1) return false;
  const before = idx === 0 ? ' ' : lowerText[idx - 1]!;
  const afterIdx = idx + term.length;
  const after = afterIdx >= lowerText.length ? ' ' : lowerText[afterIdx]!;
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

/**
 * Classify whether a proposal must be forced to secure review (Section 24.3).
 * Each fired rule is recorded with a category-level detail (never content), so
 * an operator can see *why* a proposal was held without the message leaving the
 * host. The check is independent of score and limits — a high-scoring proposal
 * that trips any rule still bypasses autonomous delivery.
 */
export function evaluateForcedReview(input: ForcedReviewInput): ForcedReviewResult {
  const rules: ForcedReviewRule[] = [];

  // Case: mixed restricted scopes — touched two or more restricted channels.
  if (input.distinctRestrictedChannelCount >= 2) {
    rules.push({
      rule: 'mixed_restricted_scopes',
      detail: `run retrieved ${input.distinctRestrictedChannelCount} restricted channels`,
    });
  }

  // Case: any host validation uncertainty.
  if (input.uncertain) {
    rules.push({ rule: 'validation_uncertainty', detail: 'host validation was uncertain' });
  }

  // Case: critical urgency without strong evidence.
  if (input.urgency === 'critical_review' && input.evidenceStrength < STRONG_EVIDENCE_THRESHOLD) {
    rules.push({
      rule: 'critical_without_strong_evidence',
      detail: `critical urgency with evidence strength ${input.evidenceStrength} below ${STRONG_EVIDENCE_THRESHOLD}`,
    });
  }

  const lowerMessage = input.message.toLowerCase();
  const lowerReason = (input.reason ?? '').toLowerCase();
  const scanText = `${lowerMessage}\n${lowerReason}`;

  // Case: legal / security / privacy / personnel / disciplinary implications.
  for (const [domain, terms] of Object.entries(SENSITIVE_DOMAINS)) {
    if (terms.some((t) => containsTerm(scanText, t))) {
      rules.push({ rule: 'sensitive_domain', detail: domain });
    }
  }

  // Case: a proposed message naming an individual negatively.
  const namesIndividual =
    INDIVIDUAL_MENTION.test(input.message) ||
    (input.referencedIndividualNames?.some((n) => n.trim().length > 0 && lowerMessage.includes(n.toLowerCase())) ?? false);
  if (namesIndividual && NEGATIVE_TERMS.some((t) => containsTerm(lowerMessage, t))) {
    rules.push({ rule: 'names_individual_negatively', detail: 'message names an individual in a negative context' });
  }

  return { forceReview: rules.length > 0, rules };
}

// ---------------------------------------------------------------------------
// Deployment-mode proposal routing (Sections 24.2, 24.3, 24.4).
//
// Composes every upstream host check — score, eligibility, the provenance and
// outbound-evidence gates, forced-review classification, cooldowns, and
// duplicate detection — into one mode-aware decision: `observed` (store only),
// `pending_review` (route to the secure review channel), or `approved` (eligible
// for the outbox / target send). The function is pure: callers precompute the
// sub-results (each is independently tested elsewhere) and pass them in, so this
// is a thin, auditable composition over already-validated inputs.
//
// Mode behavior (Section 24.3):
//   - observe     → every proposal is stored as `observed`; nothing is sent.
//   - review      → every eligible, non-suppressed proposal is `pending_review`.
//   - autonomous  → `approved` unless forced review diverts it to
//                   `pending_review`, or a cooldown / daily-limit / duplicate
//                   suppresses it to `observed`.
//
// Suppression (a definite policy violation) is honored in every mode: a target
// that disagrees with the pinned target, or evidence/scope that is definitely
// disallowed, produces `observed` even in review mode — nothing leaves the host.
// Cooldowns, the daily limit, and duplicate detection gate *target-channel
// delivery* and therefore bind only autonomous proposals; a review-channel post
// is not an autonomous send (Section 24.4) and is never rate-gated here.
// ---------------------------------------------------------------------------

/** The three durable states a routed proposal can land in (proposals.status). */
export type ProposalState = 'observed' | 'pending_review' | 'approved';

/** Configured minima an intervention must clear to be eligible (Section 24.2). */
export interface ProposalThresholds {
  score: number;
  confidence: number;
  evidenceStrength: number;
  /** Hard cap on proposed message length (Section 24.5: 1,800 characters). */
  maxContentLength: number;
}

/** The eligibility inputs the host derives from the proposal and dimensions. */
export interface ProposalEligibilityInputs {
  /** The model's `recommend` flag. */
  recommend: boolean;
  dimensions: InterventionDimensions;
  confidence: number;
  /** Model-supplied evidence-strength dimension, separately thresholded. */
  evidenceStrength: number;
  /** Count of distinct valid evidence messages after host validation. */
  evidenceCount: number;
  /** Length of the proposed outbound message. */
  contentLength: number;
  /** True when the proposal contains a mention the host disallows. */
  hasDisallowedMention: boolean;
}

export interface ProposalRoutingInput {
  mode: AutonomyMode;
  thresholds: ProposalThresholds;
  eligibility: ProposalEligibilityInputs;
  provenanceGate: ProvenanceGateResult;
  outboundEvidence: OutboundEvidenceResult;
  forcedReview: ForcedReviewResult;
  cooldown: CooldownDecision;
  duplicate: DuplicateResult;
  /** Proactive attention admission (Section 12.7). */
  attention: AttentionRoutingInput;
  /** Conversation settle gate for the target channel (Section 11.8). */
  liveness: LivenessRoutingInput;
}

/**
 * Conversation settle admission threaded into routing (Section 11.8). Episode
 * closure is a review boundary, not proof that a discussion ended, and a model
 * run takes long enough for the channel to come back to life while it runs. A
 * proposal aimed at a conversation that is live right now is stored `observed`
 * in every mode: it claims no attention revision, so a later review of the
 * settled conversation may still raise the same subject.
 */
export interface LivenessRoutingInput {
  /** True when the target conversation is quiet enough to speak into. */
  settled: boolean;
  /** Quiet milliseconds observed, for the audit record. */
  idleMs: number | null;
}

/**
 * Proactive attention admission threaded into routing (Section 12.7). A
 * recommendation that requires attention authority (`required`) must carry an
 * eligible, unconsumed revision; otherwise it is stored `observed` in every
 * mode, including review and forced-review cards.
 */
export interface AttentionRoutingInput {
  required: boolean;
  eligible: boolean;
  reason?: AttentionRejectionReason;
  /** The revision that authorizes speech, claimed at persistence. */
  revisionId?: string;
  /** Immutable window start of that revision. */
  windowFromMs?: number;
  /** Immutable window end of that revision. */
  windowUntilMs?: number;
}

export interface ProposalRoutingResult {
  state: ProposalState;
  /** The host-computed intervention score (Section 24.1), for audit/storage. */
  score: number;
  /** Redacted, human-readable reasons explaining the routing decision. */
  reasons: string[];
}

/** Format a score/confidence value for an audit reason without trailing noise. */
function fmt(n: number): string {
  return n.toFixed(3);
}

/**
 * Route a fully validated proposal to its deployment-mode state (Section 24.3).
 *
 * Order matters and is deliberate: eligibility first (cheap, model-derived), then
 * the two scope gates (a `reject` suppresses immediately; a `force_review`
 * accumulates), then forced-review classification, then the mode switch. Only the
 * autonomous-approved path reaches the rate controls, because cooldowns and
 * duplicates bind target delivery, not review delivery. The score is computed
 * here from the dimensions so callers cannot smuggle in a different value.
 */
export function routeProposal(input: ProposalRoutingInput): ProposalRoutingResult {
  const score = computeInterventionScore(input.eligibility.dimensions);
  const reasons: string[] = [];

  // A. Eligibility (Section 24.2): recommendation, score, confidence, evidence,
  //    length, and disallowed mentions. Any miss stores the proposal observed.
  const e = input.eligibility;
  if (!e.recommend) reasons.push('model did not recommend an intervention');
  if (score < input.thresholds.score) {
    reasons.push(`score ${fmt(score)} below threshold ${fmt(input.thresholds.score)}`);
  }
  if (e.confidence < input.thresholds.confidence) {
    reasons.push(`confidence ${fmt(e.confidence)} below minimum ${fmt(input.thresholds.confidence)}`);
  }
  if (e.evidenceStrength < input.thresholds.evidenceStrength) {
    reasons.push(`evidence strength ${fmt(e.evidenceStrength)} below minimum ${fmt(input.thresholds.evidenceStrength)}`);
  }
  if (e.evidenceCount < 1) reasons.push('no valid evidence');
  if (e.contentLength > input.thresholds.maxContentLength) {
    reasons.push(`content length ${e.contentLength} exceeds maximum ${input.thresholds.maxContentLength}`);
  }
  if (e.hasDisallowedMention) reasons.push('proposed message contains a disallowed mention');
  if (reasons.length > 0) return { state: 'observed', score, reasons };

  // B. Pinned-target / provenance gate (check 1-2) and outbound-evidence gate
  //    (checks 3-7). A definite violation (reject) suppresses in every mode;
  //    uncertainty (force_review) diverts toward secure review.
  if (input.provenanceGate.outcome === 'reject') {
    return { state: 'observed', score, reasons: input.provenanceGate.reasons };
  }
  let mustReview = input.provenanceGate.outcome === 'force_review';
  if (mustReview) reasons.push(...input.provenanceGate.reasons);

  if (input.outboundEvidence.outcome === 'reject') {
    return { state: 'observed', score, reasons: input.outboundEvidence.reasons };
  }
  if (input.outboundEvidence.outcome === 'force_review') {
    mustReview = true;
    reasons.push(...input.outboundEvidence.reasons);
  }

  // C. Forced secure-review classification (Section 24.3), independent of score
  //    and limits — a high-scoring proposal that trips a rule still diverts.
  if (input.forcedReview.forceReview) {
    mustReview = true;
    for (const r of input.forcedReview.rules) {
      reasons.push(`forced review (${r.rule}): ${r.detail}`);
    }
  }

  // C2. Proactive attention admission (Section 12.7): a baseline eligibility
  //     gate placed before the mode switch, so review and forced-review cards
  //     consume attention exactly like autonomous sends. An unqualified
  //     recommendation has no current reason to speak and is stored observed.
  if (input.attention.required && !input.attention.eligible) {
    reasons.push(`attention gate (${input.attention.reason ?? 'unqualified'}): no current reason to speak`);
    return { state: 'observed', score, reasons };
  }

  // C3. Conversation settle gate (Section 11.8): never speak into a discussion
  //     that is still in progress. Placed beside attention admission and before
  //     the mode switch, so a review card is gated exactly like a target send.
  if (!input.liveness.settled) {
    reasons.push('conversation_live: the target conversation is still in progress');
    return { state: 'observed', score, reasons };
  }

  // D. Deployment mode (Section 24.3).
  if (input.mode === 'observe') {
    // Observe stores every proposal without sending, regardless of eligibility.
    reasons.push('observe mode: proposals are stored without sending');
    return { state: 'observed', score, reasons };
  }
  if (input.mode === 'review') {
    // Review routes every eligible, non-suppressed proposal to the secure review
    // channel. Rate controls do not bind here (no autonomous target send).
    return { state: 'pending_review', score, reasons };
  }

  // autonomous — divert to review when any gate or forced-review rule requires it.
  if (mustReview) {
    return { state: 'pending_review', score, reasons };
  }

  // E. Rate controls gate the autonomous target send (Section 24.4): a channel
  //    cooldown, topic cooldown, or the global daily limit suppresses; a
  //    near-duplicate of a recent Mneme post suppresses. The proposal is
  //    stored observed so the dedupe is auditable, never silently dropped.
  if (!input.cooldown.allowed) {
    return {
      state: 'observed',
      score,
      reasons: input.cooldown.blocks.map((b) => `rate-limited (${b.rule}): ${b.detail}`),
    };
  }
  if (input.duplicate.matched) {
    return {
      state: 'observed',
      score,
      reasons: [
        `${input.duplicate.kind} duplicate of a recent ${input.duplicate.source} message (similarity ${fmt(input.duplicate.similarity)})`,
      ],
    };
  }

  return { state: 'approved', score, reasons: ['all deterministic checks passed'] };
}
