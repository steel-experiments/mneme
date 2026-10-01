import { transaction, type DatabaseSync } from '../db/database.js';
import { enqueue, findActiveUniqueJob, getJob } from '../jobs/queue.js';
import {
  DIRECT_ANSWER_DEADLINE_MS,
  ensureDirectAnswerRequest,
  getDirectAnswerRequest,
} from '../db/repositories/direct-answers.js';
import {
  DIRECT_ANSWER_PRIORITY,
  directAnswerJobKey,
} from '../jobs/direct-answer-identity.js';
import type { NormalizedMessage, NormalizedMention } from './normalize.js';

export { DIRECT_ANSWER_PRIORITY, directAnswerJobKey } from '../jobs/direct-answer-identity.js';

/**
 * Explicit Mneme mention detection and direct-answer scheduling
 * (Sections 11.2, 26).
 *
 * A direct mention of Mneme creates an immediate high-priority direct-answer job
 * pinned to the current channel; the message also remains part of the normal episode
 * (handled by the episode builder). Detection uses Discord's parsed mention entities,
 * never substring text matching, so a lookalike in prose or a similarly named user
 * cannot trigger a response. The job is deduplicated by source message id and gated
 * by the durable source-message request identity. Enqueuing a direct answer never changes any channel's
 * visibility grant — its scope is computed at run time from current policy (Section
 * 26: direct questions never grant access to another restricted channel).
 */

/** A real Discord mention entity targeting Mneme. */
export interface MnemeMention {
  /** The message that contains the mention (the direct-answer source). */
  messageId: string;
  /** The channel the message lives in (the reply target). */
  channelId: string;
  guildId: string | null;
}

/**
 * Find an explicit Mneme mention among Discord's parsed mention entities. Returns
 * the first Mneme mention, or null when the message does not directly mention
 * Mneme. Entity-based only: a textual "@Mneme" lookalike is never matched.
 */
export function findDirectMention(
  msg: NormalizedMessage,
  mnemeId: string,
): MnemeMention | null {
  const hit = findMentionEntity(msg.mentions, mnemeId);
  if (!hit) return null;
  return { messageId: msg.id, channelId: msg.channelId, guildId: msg.guildId };
}

/** Whether the parsed mention list contains Mneme (entity-based). */
export function mentionsMneme(mentions: readonly NormalizedMention[], mnemeId: string): boolean {
  return findMentionEntity(mentions, mnemeId) !== undefined;
}

function findMentionEntity(
  mentions: readonly NormalizedMention[],
  mnemeId: string,
): NormalizedMention | undefined {
  if (!mentions || mentions.length === 0) return undefined;
  return mentions.find((m) => m.id === mnemeId);
}

export interface EnqueueDirectAnswerOptions {
  db: DatabaseSync;
  mnemeId: string;
  now: number;
  /** Mirrors DIRECT_ANSWER_ENABLED. When false, detection still runs but no job is queued. */
  enabled?: boolean;
  /** Bots are non-triggering unless explicitly classified as materially relevant. */
  allowlistedBotIds?: ReadonlySet<string>;
}

export interface EnqueueDirectAnswerResult {
  /** True when a direct-answer job was freshly queued. */
  enqueued: boolean;
  /** The detected mention, or null when the message did not mention Mneme. */
  mention: MnemeMention | null;
}

/**
 * When `msg` directly mentions Mneme, enqueue a high-priority direct-answer job
 * pinned to the current channel, deduplicated durably by source message ID and also
 * by the queue's active-unique key. Honors `enabled` (DIRECT_ANSWER_ENABLED). A repeat
 * mention in the same message (or a re-delivered event) collapses to a single job even
 * after its first job is terminal. Returns the detected
 * mention and whether a job was freshly enqueued.
 */
export function enqueueDirectAnswerForMention(
  msg: NormalizedMessage,
  options: EnqueueDirectAnswerOptions,
): EnqueueDirectAnswerResult {
  const mention = findDirectMention(msg, options.mnemeId);
  if (!mention) return { enqueued: false, mention: null };
  if (options.enabled === false) return { enqueued: false, mention };
  if (msg.author.id === options.mnemeId || msg.isWebhook) {
    return { enqueued: false, mention };
  }
  if (msg.author.isBot && !options.allowlistedBotIds?.has(msg.author.id)) {
    return { enqueued: false, mention };
  }
  // Mneme is guild-scoped; a DM mention has no valid policy/target grant.
  const guildId = mention.guildId;
  if (!guildId) return { enqueued: false, mention };
  const persist = (): boolean => {
    // A Gateway redelivery after completion must not create a fresh job. A
    // still-pending request is different: its prior job may have exhausted
    // retries, so redelivery is allowed to repair the missing active owner.
    const existingRequest = getDirectAnswerRequest(options.db, mention.messageId);
    if (existingRequest && existingRequest.outcomeKind !== 'pending') return false;
    if (existingRequest?.jobId) {
      const owner = getJob(options.db, existingRequest.jobId);
      if (owner?.type === 'direct_answer' && (owner.status === 'queued' || owner.status === 'running')) {
        return false;
      }
    }
    const uniqueKey = directAnswerJobKey(mention.messageId);
    const result = enqueue(options.db, {
      type: 'direct_answer',
      payload: { messageId: mention.messageId, channelId: mention.channelId },
      uniqueKey,
      priority: DIRECT_ANSWER_PRIORITY,
      maxAttempts: 2,
      now: options.now,
    });
    const jobId = result.enqueued
      ? result.id
      : findActiveUniqueJob(options.db, 'direct_answer', uniqueKey)?.id;
    if (!jobId) throw new Error('direct-answer job deduplicated without an active request owner');
    ensureDirectAnswerRequest(options.db, {
      sourceMessageId: mention.messageId,
      jobId,
      guildId,
      targetChannelId: mention.channelId,
      questionCreatedAtMs: msg.createdAtMs,
      deadlineAtMs: msg.createdAtMs + DIRECT_ANSWER_DEADLINE_MS,
      startedAtMs: null,
      now: options.now,
    });
    return result.enqueued;
  };
  const enqueued = options.db.isTransaction ? persist() : transaction(options.db, persist);
  return { enqueued, mention };
}
