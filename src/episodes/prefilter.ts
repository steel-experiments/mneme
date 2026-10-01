import type { NormalizedMessage } from '../discord/normalize.js';

/**
 * Conservative local episode pre-filter (Sections 11.4, 45).
 *
 * Before an episode is sent to the model for memory review, a fully local
 * (no-model) filter may skip the review when the episode is unmistakably trivial.
 * Section 11.4 permits a skip only when **all** of the following hold:
 *
 *   1. fewer than two human messages;
 *   2. no Mneme mention;
 *   3. no decision-like phrase;
 *   4. no reaction burst;
 *   5. no link to an existing memory;
 *   6. content below a small minimum information threshold.
 *
 * The filter is deliberately conservative: missing an important review is far
 * worse than occasionally reviewing a harmless episode, so a skip requires every
 * condition, and a direct Mneme mention can never be skipped. Each condition
 * is an explicit, explainable predicate so a non-skip always carries a reason.
 */

/** Structural slice of a message the pre-filter inspects (NormalizedMessage fits). */
export interface PrefilterMessage {
  id: string;
  content: string;
  author: { id: string; isBot: boolean };
  mentions: ReadonlyArray<{ id: string }>;
  reactionCounts: ReadonlyArray<{ count: number }>;
}

/** Thresholds and overrides for the pre-filter. */
export interface EpisodePrefilterOptions {
  /** Reactions on a single emoji at/above this count constitute a burst. Default 3. */
  reactionBurstThreshold?: number;
  /** Combined trimmed human-message text below this many chars is "low information". Default 32. */
  minInformationChars?: number;
  /** Override the built-in decision-phrase list (matched case-insensitively at word boundaries). */
  decisionPhrases?: readonly string[];
  /** Message ids in the episode that link to an existing memory (caller-supplied). */
  memoryLinkedMessageIds?: ReadonlySet<string>;
}

export interface PrefilterConditions {
  fewHumanMessages: boolean;
  noMnemeMention: boolean;
  noDecisionPhrase: boolean;
  noReactionBurst: boolean;
  noMemoryLink: boolean;
  belowInformationThreshold: boolean;
}

/** Short codes for the conditions that prevented a skip (empty when the episode is skipped). */
export type PrefilterBlocker =
  | 'multiple_human_messages'
  | 'mneme_mention'
  | 'decision_phrase'
  | 'reaction_burst'
  | 'memory_link'
  | 'above_information_threshold';

export interface PrefilterEvaluation {
  /** True only when every triviality condition holds — the review may be skipped. */
  skip: boolean;
  conditions: PrefilterConditions;
  /** Conditions that did NOT hold and therefore forced a review. */
  blockers: PrefilterBlocker[];
  /** Number of human (non-bot, non-Mneme) messages in the episode. */
  humanMessageCount: number;
}

export interface PrefilterInput {
  messages: readonly PrefilterMessage[];
  mnemeId: string;
  options?: EpisodePrefilterOptions;
}

export const DEFAULT_REACTION_BURST_THRESHOLD = 3;
export const DEFAULT_MIN_INFORMATION_CHARS = 32;

/**
 * Default decision-like phrases. Intentionally broad: the cost of treating
 * decisional language as trivial (and skipping its review) is high, so any of
 * these signals forces a review. Matched case-insensitively on word boundaries.
 */
export const DEFAULT_DECISION_PHRASES: readonly string[] = [
  'decided',
  'decision',
  'we decided',
  'agreed',
  'we agreed',
  'consensus',
  "let's go with",
  'going with',
  'going to go with',
  'action item',
  'action items',
  'to-do',
  'todo',
  'follow up',
  'followup',
  'we will',
  "we'll",
  'i will',
  "i'll",
  'assigned',
  'assign it',
  'owner',
  'deadline',
  'due date',
  'approved',
  'approve',
  'confirmed',
  'finalized',
  'finalize',
  'conclusion',
  'resolved',
  'resolve this',
  'risk',
  'assumption',
  'assume',
  'predict',
  'prediction',
  'blocked',
  'blocker',
  'priority',
  'milestone',
  'ship it',
  'deploy',
  'release',
  'estimate',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDecisionRegex(phrases: readonly string[]): RegExp {
  const alternation = phrases.map(escapeRegex).join('|');
  return new RegExp(`(?:${alternation})`, 'i');
}

/** A human message: authored by a non-bot that is not Mneme. */
function isHuman(msg: PrefilterMessage, mnemeId: string): boolean {
  return !msg.author.isBot && msg.author.id !== mnemeId;
}

/**
 * Whether a message directly mentions Mneme. The mentions array (populated
 * by normalization) is the primary signal; a defensive content scan for the raw
 * `<@id>` / `<@!id>` ping backs it up so a mention is never missed (Section 11.4:
 * never skip a direct mention).
 */
export function messageMentionsMneme(msg: PrefilterMessage, mnemeId: string): boolean {
  if (msg.mentions?.some((m) => m.id === mnemeId)) return true;
  return new RegExp(`<@!?${mnemeId}>`).test(msg.content);
}

/** Max single-emoji reaction count on a message (0 when it has no reactions). */
function maxReactionCount(msg: PrefilterMessage): number {
  let max = 0;
  for (const r of msg.reactionCounts ?? []) {
    if (typeof r.count === 'number' && r.count > max) max = r.count;
  }
  return max;
}

/**
 * Evaluate every Section 11.4 condition against an episode's messages and decide
 * whether the model review may be skipped. Pure: no I/O, no side effects.
 */
export function evaluateEpisodePrefilter(input: PrefilterInput): PrefilterEvaluation {
  const { messages, mnemeId } = input;
  const opts = input.options ?? {};
  const burstThreshold = opts.reactionBurstThreshold ?? DEFAULT_REACTION_BURST_THRESHOLD;
  const minChars = opts.minInformationChars ?? DEFAULT_MIN_INFORMATION_CHARS;
  const decisionRegex = buildDecisionRegex(opts.decisionPhrases ?? DEFAULT_DECISION_PHRASES);
  const memoryLinks = opts.memoryLinkedMessageIds ?? new Set<string>();

  let humanCount = 0;
  let humanChars = 0;
  const conditions: PrefilterConditions = {
    fewHumanMessages: true,
    noMnemeMention: true,
    noDecisionPhrase: true,
    noReactionBurst: true,
    noMemoryLink: true,
    belowInformationThreshold: true,
  };

  for (const msg of messages) {
    if (isHuman(msg, mnemeId)) {
      humanCount += 1;
      humanChars += msg.content.trim().length;
    }
    if (conditions.noMnemeMention && messageMentionsMneme(msg, mnemeId)) {
      conditions.noMnemeMention = false;
    }
    if (conditions.noDecisionPhrase && decisionRegex.test(msg.content)) {
      conditions.noDecisionPhrase = false;
    }
    if (conditions.noReactionBurst && maxReactionCount(msg) >= burstThreshold) {
      conditions.noReactionBurst = false;
    }
    if (conditions.noMemoryLink && memoryLinks.has(msg.id)) {
      conditions.noMemoryLink = false;
    }
  }

  conditions.fewHumanMessages = humanCount < 2;
  conditions.belowInformationThreshold = humanChars < minChars;

  const blockers: PrefilterBlocker[] = [];
  if (!conditions.fewHumanMessages) blockers.push('multiple_human_messages');
  if (!conditions.noMnemeMention) blockers.push('mneme_mention');
  if (!conditions.noDecisionPhrase) blockers.push('decision_phrase');
  if (!conditions.noReactionBurst) blockers.push('reaction_burst');
  if (!conditions.noMemoryLink) blockers.push('memory_link');
  if (!conditions.belowInformationThreshold) blockers.push('above_information_threshold');

  const skip =
    conditions.fewHumanMessages &&
    conditions.noMnemeMention &&
    conditions.noDecisionPhrase &&
    conditions.noReactionBurst &&
    conditions.noMemoryLink &&
    conditions.belowInformationThreshold;

  return { skip, conditions, blockers, humanMessageCount: humanCount };
}

/** Convenience: normalize already-normalized messages are accepted as-is. */
export function evaluateEpisodePrefilterNormalized(
  messages: readonly NormalizedMessage[],
  mnemeId: string,
  options?: EpisodePrefilterOptions,
): PrefilterEvaluation {
  return evaluateEpisodePrefilter({ messages, mnemeId, options });
}
