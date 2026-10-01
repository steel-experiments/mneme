/**
 * Discord message normalization (Section 9.3, 9.4, 29.1).
 *
 * Converts raw Gateway / REST message objects (snake_case Discord API payloads)
 * into one normalized representation. Discord IDs are carried as strings end to
 * end — they are never coerced to a JS number, which would lose precision past
 * 2^53.
 *
 * Partial updates (MESSAGE_UPDATE) follow Section 9.4:
 *   - field absent  → keep the existing stored value (property omitted);
 *   - field null    → clear the stored value;
 *   - field present → update the stored value.
 */

import type { NormalizedAuthor, NormalizedMention, NormalizedAttachment, NormalizedReactionCount, NormalizedMessage, NormalizedMessagePatch } from '../types.js';

/** Build the shared emoji key used by `reactions` and `reaction_counts`. */
export function emojiKeyOf(emoji: unknown): string | null {
  if (!emoji || typeof emoji !== 'object') return null;
  const e = emoji as Record<string, unknown>;
  const name = typeof e.name === 'string' ? e.name : null;
  const id = typeof e.id === 'string' ? e.id : null;
  if (name === null && id === null) return null;
  // Discord sends id: null for unicode emoji.
  return id ? `${name ?? id}:${id}` : (name ?? '');
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * Discord snowflakes encode their creation time in the high bits:
 * (id >> 22) + epoch. Using BigInt preserves precision.
 */
export function snowflakeToMs(id: string): number | null {
  if (!/^\d{17,20}$/.test(id)) return null;
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  } catch {
    return null;
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function normalizeAuthor(raw: unknown): NormalizedAuthor | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== 'string') return null;
  return {
    id: a.id,
    username: asString(a.username),
    globalName: asString(a.global_name),
    isBot: asBoolean(a.bot) ?? asBoolean(a.system) ?? false,
  };
}

function normalizeMention(raw: unknown): NormalizedMention | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string') return null;
  return { id: m.id, username: asString(m.username), globalName: asString(m.global_name) };
}

function normalizeMentions(raw: unknown): NormalizedMention[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeMention).filter((m): m is NormalizedMention => m !== null);
}

function normalizeAttachment(raw: unknown): NormalizedAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== 'string') return null;
  return {
    id: a.id,
    filename: typeof a.filename === 'string' ? a.filename : '',
    mimeType: asString(a.content_type),
    sizeBytes: asNumber(a.size),
    width: asNumber(a.width),
    height: asNumber(a.height),
    sourceUrl: asString(a.url),
    proxyUrl: asString(a.proxy_url),
  };
}

function normalizeAttachments(raw: unknown): NormalizedAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeAttachment).filter((a): a is NormalizedAttachment => a !== null);
}

function normalizeReactionCounts(raw: unknown): NormalizedReactionCount[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedReactionCount[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const count = typeof r.count === 'number' && Number.isFinite(r.count) ? Math.trunc(r.count) : 0;
    const key = emojiKeyOf(r.emoji);
    if (key === null) continue;
    out.push({ emojiKey: key, count });
  }
  return out;
}

function normalizeArray(raw: unknown): unknown[] | null {
  return Array.isArray(raw) ? raw : null;
}

function resolveReplyTo(raw: Record<string, unknown>): string | null {
  const ref = raw.message_reference;
  if (ref && typeof ref === 'object') {
    const id = (ref as Record<string, unknown>).message_id;
    if (typeof id === 'string') return id;
  }
  return null;
}

/**
 * Normalize a full message (MESSAGE_CREATE / REST fetch). Requires `id`,
 * `channel_id`, and `author.id`. `content` defaults to '' when absent (some
 * message types legitimately have none), never overwriting an existing value at
 * this stage — the persistence layer treats create as authoritative.
 */
export function normalizeMessage(raw: unknown): NormalizedMessage {
  if (!raw || typeof raw !== 'object') {
    throw new Error('normalizeMessage: expected a message object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') throw new Error('normalizeMessage: message.id must be a string');
  if (typeof r.channel_id !== 'string') {
    throw new Error('normalizeMessage: message.channel_id must be a string');
  }
  const author = normalizeAuthor(r.author);
  if (!author) throw new Error('normalizeMessage: message.author.id must be a string');

  const createdAtMs =
    parseTimestamp(r.timestamp) ?? snowflakeToMs(r.id) ?? 0;

  return {
    id: r.id,
    channelId: r.channel_id,
    guildId: asString(r.guild_id),
    author,
    isWebhook: typeof r.webhook_id === 'string' && r.webhook_id.length > 0,
    content: typeof r.content === 'string' ? r.content : '',
    createdAtMs,
    editedAtMs: parseTimestamp(r.edited_timestamp),
    replyToMessageId: resolveReplyTo(r),
    messageType: asNumber(r.type),
    flags: asNumber(r.flags),
    pinned: asBoolean(r.pinned) ?? false,
    mentionEveryone: asBoolean(r.mention_everyone) ?? false,
    mentions: normalizeMentions(r.mentions),
    embeds: Array.isArray(r.embeds) ? r.embeds : [],
    components: Array.isArray(r.components) ? r.components : [],
    poll: hasOwn(r, 'poll') ? (r.poll ?? null) : null,
    attachments: normalizeAttachments(r.attachments),
    reactionCounts: normalizeReactionCounts(r.reactions),
    raw,
  };
}

/**
 * Normalize a partial message-update event (MESSAGE_UPDATE), preserving
 * absent / null / present semantics for every tracked field. A property is
 * present on the returned patch only when the corresponding source key was
 * present on the event.
 */
export function normalizeMessageUpdate(raw: unknown): NormalizedMessagePatch {
  if (!raw || typeof raw !== 'object') {
    throw new Error('normalizeMessageUpdate: expected a message object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') {
    throw new Error('normalizeMessageUpdate: message.id must be a string');
  }

  const patch: NormalizedMessagePatch = {
    id: r.id,
    channelId: typeof r.channel_id === 'string' ? r.channel_id : '',
    raw,
  };

  if (hasOwn(r, 'guild_id')) patch.guildId = asString(r.guild_id);
  if (hasOwn(r, 'author')) patch.author = r.author === null ? null : normalizeAuthor(r.author);
  if (hasOwn(r, 'content')) {
    patch.content = typeof r.content === 'string' ? r.content : '';
  }
  if (hasOwn(r, 'edited_timestamp')) {
    patch.editedAtMs = r.edited_timestamp === null ? null : parseTimestamp(r.edited_timestamp);
  }
  if (hasOwn(r, 'flags')) patch.flags = r.flags === null ? null : asNumber(r.flags);
  if (hasOwn(r, 'pinned')) patch.pinned = r.pinned === null ? null : (asBoolean(r.pinned) ?? false);
  if (hasOwn(r, 'mention_everyone')) {
    patch.mentionEveryone = r.mention_everyone === null ? null : (asBoolean(r.mention_everyone) ?? false);
  }
  if (hasOwn(r, 'mentions')) {
    patch.mentions = r.mentions === null ? null : normalizeMentions(r.mentions);
  }
  if (hasOwn(r, 'embeds')) patch.embeds = r.embeds === null ? null : normalizeArray(r.embeds);
  if (hasOwn(r, 'components')) {
    patch.components = r.components === null ? null : normalizeArray(r.components);
  }
  if (hasOwn(r, 'poll')) patch.poll = r.poll === null ? null : r.poll;
  if (hasOwn(r, 'attachments')) {
    patch.attachments = r.attachments === null ? null : normalizeAttachments(r.attachments);
  }

  return patch;
}
