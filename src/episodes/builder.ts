import { type DatabaseSync, transaction } from '../db/database.js';
import type { NormalizedMessage } from '../platform/types.js';
import { enqueue, rescheduleQueuedUniqueJob } from '../jobs/queue.js';
import {
  openEpisode,
  extendEpisode,
  getOpenEpisode,
  getEpisode,
  closeEpisode,
  conversationKey,
  type EpisodeRow,
} from './repository.js';

/**
 * Human-message episode opening and extension (Sections 9.3, 11.2).
 *
 * Every permitted message is stored by the ingestion layer; this module decides
 * whether a stored message also opens or extends a conversation episode. The rule
 * (Section 11.2): open or extend when a non-bot human posts to an ingested channel
 * and the message is not only an ignored command or known noise event. Mneme's
 * own messages are stored but never trigger; other bots are non-triggering unless
 * allowlisted as materially relevant, and even an allowlisted bot only extends an
 * already-open episode — only humans open one.
 *
 * Classification is a pure function of the message and a small config; the apply
 * step executes the decision against the database. Splitting the two keeps the
 * classification trivially unit-testable and the database work isolated.
 */

export type MessageClass =
  | 'mneme'
  | 'allowlisted_bot'
  | 'other_bot'
  | 'human'
  | 'command'
  | 'noise';

export interface EpisodeBuilderConfig {
  /** Mneme's own user id. Self-messages are stored but never trigger. */
  mnemeId: string;
  /** Bot user ids deemed materially relevant (may extend an open episode). */
  allowlistedBotIds?: ReadonlySet<string>;
  /** True when content is purely an ignored command invocation. Overrides default. */
  isIgnoredCommand?: (content: string, msg: NormalizedMessage) => boolean;
  /** True when content is a known low-information noise event. Overrides default. */
  isKnownNoise?: (content: string, msg: NormalizedMessage) => boolean;
}

export interface EpisodeTriggerDecision {
  messageClass: MessageClass;
  /** May create a new episode when none is open (substantive human messages only). */
  opensEpisode: boolean;
  /** May link to an existing open episode (humans and allowlisted bots). */
  extendsEpisode: boolean;
  /** Counts toward the episode's human_message_count (human messages only). */
  isHuman: boolean;
  /** Whether the message directly mentions Mneme (Section 11.2 direct-answer). */
  mentionsMneme: boolean;
  /** Short reason recorded as the episode trigger_reason when a new one opens. */
  reason: string;
}

/**
 * Default ignored-command detector: a trimmed line beginning with a common prefix
 * command character (`!`, `.`, `/`, `?`) followed by an alphanumeric token, e.g.
 * `!kick`, `.play`, `/help`. Slash-command interactions do not arrive as text
 * messages, so this targets legacy prefix commands.
 */
export function defaultIsIgnoredCommand(content: string): boolean {
  return /^[!./?][A-Za-z0-9]/.test(content.trim());
}

/**
 * Default noise detector: a message with no text, no attachments, and no embeds —
 * a pure empty event. Conservatively narrow: lone emojis, acks, and other
 * low-information text are left to an injected detector when a deployment wants
 * them treated as noise.
 */
export function defaultIsKnownNoise(content: string, msg: NormalizedMessage): boolean {
  return content.trim().length === 0 && msg.attachments.length === 0 && msg.embeds.length === 0;
}

/** Whether a message directly mentions Mneme by user id. */
export function mentionsMneme(msg: NormalizedMessage, mnemeId: string): boolean {
  if (!msg.mentions || msg.mentions.length === 0) return false;
  return msg.mentions.some((m) => m.id === mnemeId);
}

/**
 * Classify a stored message and decide whether it opens or extends an episode.
 * Pure: no database access, no side effects.
 *
 * Precedence for human authors: a direct Mneme mention is always substantive
 * (it both triggers the episode and signals a direct-answer); otherwise a purely
 * ignored command or known-noise message does not trigger.
 */
export function classifyEpisodeTrigger(
  msg: NormalizedMessage,
  config: EpisodeBuilderConfig,
): EpisodeTriggerDecision {
  const author = msg.author;
  const mentioned = mentionsMneme(msg, config.mnemeId);

  // Mneme's own messages: stored, never open or extend.
  if (author.id === config.mnemeId) {
    return {
      messageClass: 'mneme',
      opensEpisode: false,
      extendsEpisode: false,
      isHuman: false,
      mentionsMneme: false,
      reason: 'self',
    };
  }

  const allowlisted = config.allowlistedBotIds?.has(author.id) ?? false;

  // Other bots: stored, non-triggering by default. An allowlisted bot is materially
  // relevant — it may extend an already-open episode, but it never opens one and
  // never counts as a human message (Section 9.3).
  if (author.isBot) {
    return {
      messageClass: allowlisted ? 'allowlisted_bot' : 'other_bot',
      opensEpisode: false,
      extendsEpisode: allowlisted,
      isHuman: false,
      mentionsMneme: mentioned,
      reason: allowlisted ? 'allowlisted_bot' : 'other_bot',
    };
  }

  // Human author. A Mneme mention is always substantive and overrides the
  // command/noise checks (Section 11.2: a direct mention remains part of the episode).
  const isCommand = !mentioned && (config.isIgnoredCommand ?? defaultIsIgnoredCommand)(msg.content, msg);
  const isNoise = !mentioned && (config.isKnownNoise ?? defaultIsKnownNoise)(msg.content, msg);

  if (isCommand) {
    return {
      messageClass: 'command',
      opensEpisode: false,
      extendsEpisode: false,
      isHuman: false,
      mentionsMneme: mentioned,
      reason: 'ignored_command',
    };
  }
  if (isNoise) {
    return {
      messageClass: 'noise',
      opensEpisode: false,
      extendsEpisode: false,
      isHuman: false,
      mentionsMneme: mentioned,
      reason: 'noise',
    };
  }

  return {
    messageClass: 'human',
    opensEpisode: true,
    extendsEpisode: true,
    isHuman: true,
    mentionsMneme: mentioned,
    reason: mentioned ? 'human_mention' : 'human',
  };
}

export interface ApplyEpisodeInput {
  db: DatabaseSync;
  msg: NormalizedMessage;
  decision: EpisodeTriggerDecision;
  guildId: string;
  now: number;
}

export interface ApplyEpisodeResult {
  /** True when the message was linked to an episode (a new episode_messages row). */
  linked: boolean;
  /** True when a brand-new episode was opened for this message. */
  opened: boolean;
  /** The episode id the message was considered against, or null when not triggering. */
  episodeId: string | null;
  /** The ordinal assigned, when linked. */
  ordinal: number | undefined;
}

/**
 * Execute a trigger decision against the database: open an episode when the message
 * may open one and none is open, then link the message when it may extend. An
 * allowlisted bot with no open episode does nothing (it may only extend, not open).
 * Idempotent on message id via {@link extendEpisode}.
 */
export function applyEpisodeTrigger(input: ApplyEpisodeInput): ApplyEpisodeResult {
  const { db, msg, decision } = input;
  if (!decision.extendsEpisode) {
    return { linked: false, opened: false, episodeId: null, ordinal: undefined };
  }

  const key = conversationKey(msg.channelId);
  let episode = getOpenEpisode(db, key);
  let opened = false;

  if (!episode) {
    if (!decision.opensEpisode) {
      // Allowlisted bot, but no open episode to extend — do not open one.
      return { linked: false, opened: false, episodeId: null, ordinal: undefined };
    }
    const res = openEpisode(db, {
      guildId: input.guildId,
      conversationChannelId: key,
      triggerMessageId: msg.id,
      triggerReason: decision.reason,
      now: input.now,
    });
    episode = res.episode;
    opened = res.created;
  }

  const ext = extendEpisode(db, episode.id, msg.id, decision.isHuman, input.now);
  return {
    linked: ext.extended,
    opened,
    episodeId: episode.id,
    ordinal: ext.ordinal,
  };
}

export interface IngestEpisodeActivityOptions {
  db: DatabaseSync;
  guildId: string;
  now: number;
  /** Episode timing thresholds; defaults to {@link DEFAULT_EPISODE_TIMING}. */
  timing?: EpisodeTimingConfig;
}

/**
 * Classify a stored message and apply its episode effect in one call. Intended as
 * the gateway ingestion hook: after a message is persisted, call this so qualifying
 * human activity opens or extends the conversation episode. When it extends, it
 * (re)schedules the quiet close job and closes immediately on a hard trigger
 * (message or duration cap), queuing review outside the closing transaction.
 */
export function ingestEpisodeActivity(
  msg: NormalizedMessage,
  config: EpisodeBuilderConfig,
  options: IngestEpisodeActivityOptions,
): ApplyEpisodeResult {
  const decision = classifyEpisodeTrigger(msg, config);
  const res = applyEpisodeTrigger({ db: options.db, msg, decision, guildId: options.guildId, now: options.now });
  const timing = options.timing ?? DEFAULT_EPISODE_TIMING;

  if (res.episodeId) {
    const episode = getEpisode(options.db, res.episodeId);
    if (episode && episode.status === 'open') {
      const hard = hardCloseTrigger(episode, timing, options.now);
      if (hard.close) {
        // Hard trigger: close now and queue review (no point scheduling the quiet job).
        closeEpisodeAndQueueReview(options.db, conversationKey(msg.channelId), options.now);
      } else {
        scheduleEpisodeClose(options.db, episode, timing, options.now);
      }
    }
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Episode closure (Sections 11.3, 11.5).
//
// Close at the first of: quiet timeout, message cap, duration cap, thread
// archival, or admin flush. The quiet timer is a durable close_episode job
// (re)scheduled as the episode gains activity; the synchronous caps close
// immediately at extend time. Review is queued OUTSIDE the closing transaction
// (Section 11.5: never hold an episode transaction open during a model call).
// ─────────────────────────────────────────────────────────────────────────────

export interface EpisodeTimingConfig {
  /** EPISODE_QUIET_SECONDS — idle seconds before a quiet close. Default 90. */
  quietSeconds: number;
  /** EPISODE_MAX_MESSAGES — total messages before a cap close. Default 40. */
  maxMessages: number;
  /** EPISODE_MAX_MINUTES — episode age before a duration close. Default 10. */
  maxMinutes: number;
}

export const DEFAULT_EPISODE_TIMING: EpisodeTimingConfig = {
  quietSeconds: 90,
  maxMessages: 40,
  maxMinutes: 10,
};

export type CloseTrigger = 'quiet' | 'message_cap' | 'duration_cap' | 'thread_archive' | 'admin_flush';

export interface CloseEvaluation {
  close: boolean;
  trigger?: CloseTrigger;
}

/** The active-unique key for an episode's close job (restart/reschedule dedupe). */
export function closeEpisodeJobKey(episodeId: string): string {
  return `close:episode:${episodeId}`;
}

/** The active-unique key for an episode's review job. */
export function reviewEpisodeJobKey(episodeId: string): string {
  return `review:episode:${episodeId}`;
}

/**
 * Synchronous hard-close triggers evaluated at message-extend time: the message
 * cap and the duration cap. Message cap takes precedence (it is the tighter
 * signal per message). Quiet timeout is a job-time concern, not checked here.
 */
export function hardCloseTrigger(episode: EpisodeRow, timing: EpisodeTimingConfig, now: number): CloseEvaluation {
  if (episode.total_message_count >= timing.maxMessages) {
    return { close: true, trigger: 'message_cap' };
  }
  if (now - episode.started_at_ms >= timing.maxMinutes * 60_000) {
    return { close: true, trigger: 'duration_cap' };
  }
  return { close: false };
}

export interface QuietTimeoutEvaluation {
  close: boolean;
  trigger?: 'quiet';
  /** When quiet has not elapsed, the ms timestamp to reschedule the close job to. */
  rescheduleAt?: number;
}

/**
 * Quiet-timeout evaluation for the close_episode job. Closes when the idle gap
 * since `last_activity_at_ms` meets the threshold; otherwise returns the timestamp
 * at which the job should next fire (a later message bumped activity).
 */
export function quietTimeoutClose(episode: EpisodeRow, timing: EpisodeTimingConfig, now: number): QuietTimeoutEvaluation {
  const quietMs = timing.quietSeconds * 1000;
  const elapsed = now - episode.last_activity_at_ms;
  if (elapsed >= quietMs) return { close: true, trigger: 'quiet' };
  return { close: false, rescheduleAt: episode.last_activity_at_ms + quietMs };
}

/** The next quiet close job's `run_after_ms` for an open episode. */
export function closeEpisodeRunAfterMs(episode: EpisodeRow, timing: EpisodeTimingConfig): number {
  return episode.last_activity_at_ms + timing.quietSeconds * 1000;
}

/** (Re)schedule the durable quiet close job for an open episode (idempotent unique key). */
export function scheduleEpisodeClose(
  db: DatabaseSync,
  episode: EpisodeRow,
  timing: EpisodeTimingConfig,
  now: number,
): void {
  const runAfterMs = closeEpisodeRunAfterMs(episode, timing);
  const result = enqueue(db, {
    type: 'close_episode',
    payload: { episodeId: episode.id },
    uniqueKey: closeEpisodeJobKey(episode.id),
    runAfterMs,
    now,
  });
  if (!result.enqueued) {
    rescheduleQueuedUniqueJob(db, 'close_episode', closeEpisodeJobKey(episode.id), runAfterMs, now);
  }
}

/**
 * Close the open episode for a conversation and queue it for review. The close
 * runs in its own short transaction; the review enqueue happens after, outside
 * that transaction (Section 11.5). Returns whether an open episode was closed.
 * Used by the quiet-timeout job, thread archival, and admin flush alike.
 */
export function closeEpisodeAndQueueReview(
  db: DatabaseSync,
  conversationChannelId: string,
  now: number,
): { closed: boolean; episodeId: string | null } {
  let id: string | undefined;
  transaction(db, () => {
    id = closeEpisode(db, conversationChannelId, now);
    if (id) {
      enqueue(db, {
        type: 'review_episode', payload: { episodeId: id },
        uniqueKey: reviewEpisodeJobKey(id), now,
      });
    }
  });
  return { closed: id !== undefined, episodeId: id ?? null };
}
