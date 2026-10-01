// ABOUTME: Conversation settle gate — when a closed episode is quiet enough to
// ABOUTME: review, and whether proactive speech may target it (Section 11.8).
import type { DatabaseSync } from '../db/database.js';

/** `EPISODE_SETTLE_SECONDS` — quiet seconds a conversation needs before review. */
export const DEFAULT_SETTLE_SECONDS = 600;

/** `EPISODE_SETTLE_MAX_MINUTES` — how long a review may be held for a busy channel. */
export const DEFAULT_SETTLE_MAX_MINUTES = 60;

export interface SettleConfig {
  settleSeconds: number;
  settleMaxMinutes: number;
}

export const DEFAULT_SETTLE_CONFIG: SettleConfig = {
  settleSeconds: DEFAULT_SETTLE_SECONDS,
  settleMaxMinutes: DEFAULT_SETTLE_MAX_MINUTES,
};

export interface SettleEvaluation {
  /** True when the conversation is quiet, or the hold bound has been reached. */
  proceed: boolean;
  /** True when the conversation itself is quiet (never true on a forced proceed). */
  settled: boolean;
  /** True when the hold bound released a still-live conversation for review. */
  forced: boolean;
  /** Epoch ms of the settle deadline; the time to retry a held review. */
  retryAtMs: number;
  /** Quiet milliseconds observed, or null when the channel has no human message. */
  idleMs: number | null;
}

/**
 * Evaluate the settle gate for one closed episode (Section 11.8).
 *
 * The conversation is settled when its last meaningful human message is at
 * least `settleSeconds` old. A live conversation holds the review until the
 * settle deadline, but only until `settleMaxMinutes` after the episode closed:
 * past that bound the review proceeds anyway, so memory extraction is never
 * blocked by a channel that stays busy. `forced` separates the two, because a
 * forced review may extract memory but must not speak.
 *
 * A channel with no human message at all (every message deleted, or only bots)
 * is settled: there is nothing left to interrupt.
 */
export function evaluateSettle(input: {
  lastHumanAtMs: number | null;
  episodeClosedAtMs: number;
  now: number;
  config: SettleConfig;
}): SettleEvaluation {
  const settleMs = input.config.settleSeconds * 1000;
  const boundMs = input.config.settleMaxMinutes * 60_000;
  if (input.lastHumanAtMs === null) {
    return { proceed: true, settled: true, forced: false, retryAtMs: input.now, idleMs: null };
  }
  const idleMs = input.now - input.lastHumanAtMs;
  const retryAtMs = input.lastHumanAtMs + settleMs;
  if (idleMs >= settleMs) {
    return { proceed: true, settled: true, forced: false, retryAtMs, idleMs };
  }
  // A future-dated message must not hold a review open forever; it is bounded
  // by the same hold bound as ordinary activity.
  const forced = input.now - input.episodeClosedAtMs >= boundMs;
  return { proceed: forced, settled: false, forced, retryAtMs, idleMs };
}

/**
 * Creation time of the most recent meaningful human message in a channel, or
 * null when there is none. Mneme's own messages, other bots, deleted
 * messages, and whitespace-only messages never count as activity — they cannot
 * be the conversation Mneme would interrupt.
 */
export function lastHumanMessageAtMs(
  db: DatabaseSync,
  channelId: string,
  mnemeId: string,
): number | null {
  const row = db.prepare(`
    SELECT MAX(m.created_at_ms) AS last_at_ms
      FROM messages m
      LEFT JOIN users u ON u.id=m.author_id
     WHERE m.channel_id=? AND m.deleted_at_ms IS NULL AND trim(m.content)<>''
       AND (m.author_id IS NULL OR (m.author_id<>? AND COALESCE(u.is_bot,0)=0))
  `).get(channelId, mnemeId) as { last_at_ms: number | null } | undefined;
  const value = row?.last_at_ms;
  return typeof value === 'number' ? value : null;
}
