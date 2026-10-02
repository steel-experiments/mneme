// ABOUTME: Normalizes Slack messages into the platform-neutral message shape (plan 006 step 5).
// ABOUTME: Ids follow plan 002 decisions 3, 4, and 18; ignored subtypes return null.
import type {
  NormalizedAttachment,
  NormalizedMention,
  NormalizedMessage,
  NormalizedMessagePatch,
  NormalizedReactionCount,
} from '../types.js';
import type { SlackObject } from './api.js';
import { isSlackReply, slackMessageId, slackThreadRowId, slackTsToMs } from './ids.js';

/** Subtypes that carry conversation content (spec Section 9.3). */
export const STORED_SUBTYPES = new Set(['bot_message', 'file_share', 'thread_broadcast', 'me_message']);

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const BROADCAST = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/;

/** True when Mneme stores this message. Every unknown subtype is ignored (fail closed). */
export function isStoredSlackMessage(message: SlackObject): boolean {
  const subtype = message.subtype;
  return subtype === undefined || (typeof subtype === 'string' && STORED_SUBTYPES.has(subtype));
}

/** The stored row for a message: its thread row for a reply or broadcast reply, else the channel. */
export function slackRowChannelId(channel: string, message: SlackObject): string {
  return isSlackReply(message) ? slackThreadRowId(channel, String(message.thread_ts)) : channel;
}

function mentionsOf(text: string): NormalizedMention[] {
  const seen = new Set<string>();
  const out: NormalizedMention[] = [];
  for (const m of text.matchAll(USER_MENTION)) {
    if (seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    out.push({ id: m[1]!, username: null, globalName: null });
  }
  return out;
}

function attachmentsOf(messageId: string, files: unknown): NormalizedAttachment[] {
  if (!Array.isArray(files)) return [];
  const out: NormalizedAttachment[] = [];
  for (const f of files as SlackObject[]) {
    if (typeof f.id !== 'string') continue;
    out.push({
      // One file can be shared into more than one message (plan 002 decision 18).
      id: `${messageId}-${f.id}`,
      filename: typeof f.name === 'string' ? f.name : f.id,
      mimeType: typeof f.mimetype === 'string' ? f.mimetype : null,
      sizeBytes: typeof f.size === 'number' ? f.size : null,
      width: typeof f.original_w === 'number' ? f.original_w : null,
      height: typeof f.original_h === 'number' ? f.original_h : null,
      sourceUrl: typeof f.url_private === 'string' ? f.url_private : null,
      proxyUrl: null,
    });
  }
  return out;
}

function reactionsOf(reactions: unknown): NormalizedReactionCount[] {
  if (!Array.isArray(reactions)) return [];
  return (reactions as SlackObject[])
    .filter((r) => typeof r.name === 'string' && typeof r.count === 'number')
    .map((r) => ({ emojiKey: String(r.name), count: Number(r.count) }));
}

function authorOf(message: SlackObject, selfUserId: string): NormalizedMessage['author'] | null {
  if (message.subtype === 'bot_message' || (typeof message.bot_id === 'string' && typeof message.user !== 'string')) {
    const id = typeof message.bot_id === 'string' ? message.bot_id : null;
    if (!id) return null;
    return { id, username: null, globalName: null, isBot: true };
  }
  if (typeof message.user !== 'string') return null;
  return { id: message.user, username: null, globalName: null, isBot: message.user === selfUserId || typeof message.bot_id === 'string' };
}

/**
 * Normalize one Slack message from `channel`. Returns null for a message Mneme
 * does not store: an ignored subtype, or a message with no `ts` or author.
 */
export function normalizeSlackMessage(
  raw: SlackObject,
  channel: string,
  workspaceId: string,
  selfUserId: string,
): NormalizedMessage | null {
  if (!isStoredSlackMessage(raw) || typeof raw.ts !== 'string') return null;
  const author = authorOf(raw, selfUserId);
  if (!author) return null;
  const id = slackMessageId(channel, raw.ts);
  const text = typeof raw.text === 'string' ? raw.text : '';
  const edited = raw.edited as { ts?: unknown } | undefined;
  return {
    id,
    channelId: slackRowChannelId(channel, raw),
    guildId: workspaceId,
    author,
    isWebhook: false,
    content: text,
    createdAtMs: slackTsToMs(raw.ts),
    editedAtMs: typeof edited?.ts === 'string' ? slackTsToMs(edited.ts) : null,
    replyToMessageId: null,
    messageType: null,
    flags: null,
    pinned: Array.isArray(raw.pinned_to) && raw.pinned_to.length > 0,
    mentionEveryone: BROADCAST.test(text),
    mentions: mentionsOf(text),
    embeds: [],
    components: [],
    poll: null,
    attachments: attachmentsOf(id, raw.files),
    reactionCounts: reactionsOf(raw.reactions),
    raw,
  };
}

/** Normalize the new version of a message from a `message_changed` event. The id keeps the original `ts`. */
export function normalizeSlackMessageUpdate(
  event: SlackObject,
  workspaceId: string,
): NormalizedMessagePatch | null {
  const message = event.message as SlackObject | undefined;
  const channel = event.channel;
  if (!message || typeof channel !== 'string' || typeof message.ts !== 'string') return null;
  if (!isStoredSlackMessage(message)) return null;
  const id = slackMessageId(channel, message.ts);
  const text = typeof message.text === 'string' ? message.text : '';
  const edited = message.edited as { ts?: unknown } | undefined;
  return {
    id,
    channelId: slackRowChannelId(channel, message),
    guildId: workspaceId,
    raw: message,
    content: text,
    editedAtMs: typeof edited?.ts === 'string' ? slackTsToMs(edited.ts) : null,
    mentionEveryone: BROADCAST.test(text),
    mentions: mentionsOf(text),
    attachments: attachmentsOf(id, message.files),
  };
}

/** The stored id and row of the message that a `message_deleted` event removes. */
export function slackDeletedMessage(event: SlackObject): { id: string; channelId: string } | null {
  const channel = event.channel;
  const ts = event.deleted_ts;
  if (typeof channel !== 'string' || typeof ts !== 'string') return null;
  const previous = (event.previous_message as SlackObject | undefined) ?? { ts };
  return { id: slackMessageId(channel, ts), channelId: slackRowChannelId(channel, { ...previous, ts }) };
}
