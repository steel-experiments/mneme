import { randomUUID } from 'node:crypto';
import { type DatabaseSync, transaction } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';

/**
 * Episode persistence (Section 11, 29).
 *
 * An episode groups one conversation: a thread (keyed by thread id) or a
 * non-thread channel (keyed by channel id). Because Discord reports a thread
 * message's `channel_id` as the thread id, the conversation key is simply that
 * channel id — the *parent* channel's visibility is resolved separately at
 * retrieval time (Section 7.2).
 *
 * Lifecycle: open → queued → reviewing → reviewed | skipped | error. At most
 * one `open` episode may exist per conversation; new messages after a close open
 * a fresh episode.
 */

export type EpisodeStatus =
  | 'open'
  | 'queued'
  | 'reviewing'
  | 'reviewed'
  | 'skipped'
  | 'error';

export interface EpisodeRow {
  id: string;
  workspace_id: string;
  conversation_channel_id: string;
  status: EpisodeStatus;
  started_at_ms: number;
  ended_at_ms: number | null;
  last_activity_at_ms: number;
  human_message_count: number;
  total_message_count: number;
  trigger_reason: string | null;
  summary: string | null;
  consequential: 0 | 1 | null;
  intervention_score: number | null;
  created_at_ms: number;
  reviewed_at_ms: number | null;
  updated_at_ms: number;
  origin: 'live' | 'historical';
}

export interface EpisodeMessageRow {
  episode_id: string;
  message_id: string;
  ordinal: number;
}

export interface OpenEpisodeInput {
  guildId: string;
  conversationChannelId: string;
  triggerMessageId?: string;
  triggerReason?: string;
  now: number;
}

export interface OpenEpisodeResult {
  episode: EpisodeRow;
  /** True when a new episode was created; false when an open one already existed. */
  created: boolean;
}

/**
 * The conversation key for a message: its channel id (which is the thread id for
 * thread messages, or the channel id otherwise) — Section 11.1.
 */
export function conversationKey(channelId: string): string {
  return channelId;
}

/**
 * Open or return the existing open episode for a conversation. Never creates a
 * second open episode for the same conversation (Section 11.1).
 */
export function openEpisode(db: DatabaseSync, input: OpenEpisodeInput): OpenEpisodeResult {
  return transaction(db, () => {
    const existing = prepareCached(
      db,
      'episodes.find_open',
      "SELECT * FROM episodes WHERE conversation_channel_id = ? AND status = 'open' LIMIT 1",
    ).get(input.conversationChannelId) as EpisodeRow | undefined;
    if (existing) return { episode: existing, created: false };

    const id = randomUUID();
    prepareCached(
      db,
      'episodes.open',
      `INSERT INTO episodes (id, workspace_id, conversation_channel_id, status, started_at_ms,
          last_activity_at_ms, human_message_count, total_message_count, trigger_reason,
          created_at_ms, updated_at_ms)
       VALUES (@id, @workspace_id, @conversation_channel_id, 'open', @now, @now, 0, 0,
          @trigger_reason, @now, @now)`,
    ).run({
      id,
      workspace_id: input.guildId,
      conversation_channel_id: input.conversationChannelId,
      now: input.now,
      trigger_reason: input.triggerReason ?? null,
    });

    const episode = getEpisode(db, id);
    if (!episode) throw new Error(`openEpisode: inserted episode ${id} not found`);
    return { episode, created: true };
  });
}

/** The open episode for a conversation, if any. */
export function getOpenEpisode(
  db: DatabaseSync,
  conversationChannelId: string,
): EpisodeRow | undefined {
  return prepareCached(
    db,
    'episodes.find_open',
    "SELECT * FROM episodes WHERE conversation_channel_id = ? AND status = 'open' LIMIT 1",
  ).get(conversationChannelId) as EpisodeRow | undefined;
}

export function getEpisode(db: DatabaseSync, id: string): EpisodeRow | undefined {
  return prepareCached(db, 'episodes.get', 'SELECT * FROM episodes WHERE id = ?').get(id) as
    | EpisodeRow
    | undefined;
}

export interface ExtendResult {
  /** True when a new message was linked (idempotent on message id). */
  extended: boolean;
  ordinal: number | undefined;
}

/**
 * Link a message to an episode at the next ordinal, preserving conversation
 * order. Idempotent on message id: re-extending the same message is a no-op that
 * does not advance counts or activity. `isHuman` counts toward
 * `human_message_count`.
 */
export function extendEpisode(
  db: DatabaseSync,
  episodeId: string,
  messageId: string,
  isHuman: boolean,
  now: number,
): ExtendResult {
  return transaction(db, () => {
    const row = prepareCached(
      db,
      'episodes.extend',
      `INSERT INTO episode_messages (episode_id, message_id, ordinal)
       SELECT @episode_id, @message_id, COALESCE(MAX(ordinal), 0) + 1
       FROM episode_messages WHERE episode_id = @episode_id
       ON CONFLICT(episode_id, message_id) DO NOTHING
       RETURNING ordinal`,
    ).get({ episode_id: episodeId, message_id: messageId }) as { ordinal: number } | undefined;

    if (!row) return { extended: false, ordinal: undefined };

    prepareCached(
      db,
      'episodes.bump',
      `UPDATE episodes
         SET human_message_count = human_message_count + @human_inc,
             total_message_count = total_message_count + 1,
             last_activity_at_ms = @now,
             updated_at_ms = @now
       WHERE id = @id`,
    ).run({ id: episodeId, human_inc: isHuman ? 1 : 0, now });
    return { extended: true, ordinal: row.ordinal };
  });
}

/** Messages in conversation order. */
export function listEpisodeMessages(db: DatabaseSync, episodeId: string): EpisodeMessageRow[] {
  const rows = prepareCached(
    db,
    'episodes.list_messages',
    'SELECT episode_id, message_id, ordinal FROM episode_messages WHERE episode_id = ? ORDER BY ordinal',
  ).all(episodeId) as { episode_id: string; message_id: string; ordinal: number }[];
  return rows;
}

/**
 * Close the open episode for a conversation and queue it for review (sets
 * `ended_at_ms`). Returns the closed episode id, or undefined when no open
 * episode exists.
 */
export function closeEpisode(
  db: DatabaseSync,
  conversationChannelId: string,
  now: number,
): string | undefined {
  const persist = (): string | undefined => {
    const episode = getOpenEpisode(db, conversationChannelId);
    if (!episode) return undefined;
    prepareCached(
      db,
      'episodes.close',
      `UPDATE episodes
         SET status = 'queued', ended_at_ms = @now, updated_at_ms = @now
       WHERE id = @id AND status = 'open'`,
    ).run({ id: episode.id, now });
    return episode.id;
  };
  return db.isTransaction ? persist() : transaction(db, persist);
}

/** Transition a queued episode to reviewing. Returns true when applied. */
export function markReviewing(db: DatabaseSync, episodeId: string, now: number): boolean {
  return Number(
    prepareCached(
      db,
      'episodes.reviewing',
      "UPDATE episodes SET status = 'reviewing', updated_at_ms = @now WHERE id = @id AND status = 'queued'",
    ).run({ id: episodeId, now }).changes,
  ) > 0;
}

/** Return a deferred or interrupted review to the durable queued state. */
export function requeueReviewing(db: DatabaseSync, episodeId: string, now: number): boolean {
  return Number(
    prepareCached(
      db,
      'episodes.requeue_reviewing',
      "UPDATE episodes SET status = 'queued', updated_at_ms = @now WHERE id = @id AND status = 'reviewing'",
    ).run({ id: episodeId, now }).changes,
  ) > 0;
}

export interface ReviewOutcomeInput {
  summary?: string | null;
  consequential?: boolean;
  interventionScore?: number;
}

/** Mark a reviewing episode reviewed and record the review outcome. */
export function markReviewed(
  db: DatabaseSync,
  episodeId: string,
  input: ReviewOutcomeInput,
  now: number,
): boolean {
  return Number(
    prepareCached(
      db,
      'episodes.reviewed',
      `UPDATE episodes
         SET status = 'reviewed',
             reviewed_at_ms = @now,
             summary = COALESCE(@summary, summary),
             consequential = @consequential,
             intervention_score = @score,
             updated_at_ms = @now
       WHERE id = @id AND status = 'reviewing'`,
    ).run({
      id: episodeId,
      now,
      summary: input.summary ?? null,
      consequential: input.consequential === undefined ? null : input.consequential ? 1 : 0,
      score: input.interventionScore ?? null,
    }).changes,
  ) > 0;
}

/** Mark a reviewing/queued episode skipped (e.g. local pre-filter). */
export function markSkipped(db: DatabaseSync, episodeId: string, now: number): boolean {
  return Number(
    prepareCached(
      db,
      'episodes.skipped',
      "UPDATE episodes SET status = 'skipped', reviewed_at_ms = @now, updated_at_ms = @now WHERE id = @id AND status IN ('queued', 'reviewing')",
    ).run({ id: episodeId, now }).changes,
  ) > 0;
}

/** Mark a reviewing episode errored. */
export function markError(db: DatabaseSync, episodeId: string, now: number): boolean {
  return Number(
    prepareCached(
      db,
      'episodes.error',
      "UPDATE episodes SET status = 'error', reviewed_at_ms = @now, updated_at_ms = @now WHERE id = @id AND status = 'reviewing'",
    ).run({ id: episodeId, now }).changes,
  ) > 0;
}
