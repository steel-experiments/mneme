/**
 * Recent-message duplicate detection (Sections 7.4 check 9, 24.2).
 *
 * Before a proposal is enqueued, the host compares its text against Mneme's
 * recent messages in the target channel — both durable sends (outbox rows that
 * reached `sent`) and observed messages (the bot's own messages seen back through
 * the Gateway). An exact or bounded near-duplicate suppresses the new send so
 * Mneme does not repeat itself; substantively different interventions stay
 * eligible. This is content-level dedup, distinct from the outbox row-level
 * `dedupe_key` (Section 10.1) which only prevents the same proposal enqueueing
 * twice.
 *
 * The detector is a pure function over a caller-supplied recent-message list, so
 * it needs no database and fails closed toward an explainable match.
 */

/** How far back "recent" reaches (default: 24h, matching the same-topic cooldown). */
export const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Minimum normalized similarity to count as a near-duplicate (conservative). */
export const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.9;
/** Cap on how many recent messages to compare (bounds worst-case work). */
export const MAX_RECENT_COMPARE = 50;
/** Maximum preview length returned for explanation (content is not dumped). */
export const DUPLICATE_PREVIEW_CHARS = 80;

/** Where a recent Mneme message was seen. */
export type RecentMessageSource = 'outbox' | 'observed';

/** A recent Mneme message in the target channel to compare against. */
export interface RecentMnemeMessage {
  content: string;
  /** When the message was sent (epoch ms). */
  sentAtMs: number;
  source: RecentMessageSource;
}

export interface DuplicateCheckInput {
  /** Proposed outbound text. */
  content: string;
  /** Recent Mneme messages in the target channel (any order). */
  recentMessages: readonly RecentMnemeMessage[];
  now: number;
  /** Override the recent window (default {@link DEFAULT_RECENT_WINDOW_MS}). */
  windowMs?: number;
  /** Override the near-duplicate threshold (default {@link DEFAULT_NEAR_DUPLICATE_THRESHOLD}). */
  threshold?: number;
}

export type DuplicateKind = 'exact' | 'near';

export interface DuplicateMatch {
  matched: true;
  kind: DuplicateKind;
  /** Normalized similarity to the matched message (1.0 for exact). */
  similarity: number;
  /** Short preview of the matched content (bounded; full content is not returned). */
  matchedPreview: string;
  matchedSentAtMs: number;
  source: RecentMessageSource;
}

export interface NoDuplicate {
  matched: false;
}

export type DuplicateResult = DuplicateMatch | NoDuplicate;

/**
 * Normalize outbound text for duplicate comparison: lowercase, drop link/image
 * URLs (keeping their labels), drop bare URLs, then strip all remaining
 * punctuation and markup, and collapse whitespace. Minor-format differences —
 * case, spacing, bold, trailing punctuation, a link URL — collapse so they read
 * as the same message, while substance is preserved. The same transform is
 * applied to both sides, so stripping internal apostrophes (`don't` → `dont`) is
 * consistent and does not skew the comparison.
 */
export function normalizeForDuplicate(text: string): string {
  return text
    .toLowerCase()
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image ![alt](url) → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link [label](url) → label
    .replace(/https?:\/\/\S+/g, ' ') // bare URLs → space
    .replace(/[^a-z0-9\s]/g, ' ') // drop remaining punctuation/markup
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein edit distance with an early-exit length guard. If the length gap
 * alone makes the threshold unreachable, returns `Infinity` without computing.
 */
function boundedDistance(a: string, b: string, maxAcceptable: number): number {
  if (Math.abs(a.length - b.length) > maxAcceptable) return Infinity;
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, () => 0);
  let curr = Array.from({ length: n + 1 }, () => 0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowBest = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? Infinity) + 1;
      const ins = (curr[j - 1] ?? Infinity) + 1;
      const sub = (prev[j - 1] ?? Infinity) + cost;
      const val = Math.min(del, ins, sub);
      curr[j] = val;
      if (val < rowBest) rowBest = val;
    }
    // If every entry in this row already exceeds the cap, distance can only grow.
    if (rowBest > maxAcceptable) return Infinity;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n] ?? Infinity;
}

/** Normalized similarity in [0, 1]: 1 - distance / maxLen (1.0 when both empty). */
function similarity(a: string, b: string, threshold: number): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const maxAcceptable = Math.ceil(maxLen * (1 - threshold));
  const dist = boundedDistance(a, b, maxAcceptable);
  if (dist === Infinity) return 0;
  return 1 - dist / maxLen;
}

function preview(text: string): string {
  const n = text.length;
  if (n <= DUPLICATE_PREVIEW_CHARS) return text;
  return `${text.slice(0, DUPLICATE_PREVIEW_CHARS)}…`;
}

/**
 * Detect whether the proposed content is an exact or bounded near-duplicate of a
 * recent Mneme message in the target channel (Section 7.4 check 9). Returns
 * the best (most similar, exact preferred) match within the recent window, or a
 * no-match. A match suppresses the new send; substantively different text stays
 * eligible.
 */
export function detectDuplicate(input: DuplicateCheckInput): DuplicateResult {
  const windowMs = input.windowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const threshold = input.threshold ?? DEFAULT_NEAR_DUPLICATE_THRESHOLD;
  const proposed = normalizeForDuplicate(input.content);

  let best: DuplicateMatch | null = null;
  let compared = 0;

  for (const msg of input.recentMessages) {
    if (compared >= MAX_RECENT_COMPARE) break;
    if (input.now - msg.sentAtMs > windowMs) continue; // not recent
    compared += 1;

    const norm = normalizeForDuplicate(msg.content);
    const isExact = norm === proposed;
    const sim = isExact ? 1 : similarity(proposed, norm, threshold);
    if (!isExact && sim < threshold) continue;

    // Prefer exact over near, then the higher similarity.
    if (
      best === null ||
      (isExact && best.kind !== 'exact') ||
      (isExact === (best.kind === 'exact') && sim > best.similarity)
    ) {
      best = {
        matched: true,
        kind: isExact ? 'exact' : 'near',
        similarity: sim,
        matchedPreview: preview(norm),
        matchedSentAtMs: msg.sentAtMs,
        source: msg.source,
      };
    }
  }

  return best ?? { matched: false };
}
