// ABOUTME: Maps raw Discord Gateway events to the platform-neutral ingest operations.
// ABOUTME: Holds the Discord event names, thread types, and payload parsing (Section 9.3).
import type { DatabaseSync } from '../../db/database.js';
import { getChannel, upsertChannel, tombstoneChannel, type ChannelUpsertInput } from '../../db/repositories/channels.js';
import { getMessage } from '../../db/repositories/messages.js';
import { prepareCached } from '../../db/repositories/util.js';
import { closeEpisodeAndQueueReview } from '../../episodes/builder.js';
import {
  ingestMessageCreate,
  ingestMessageDelete,
  ingestMessageDeleteBulk,
  ingestMessageUpdate,
  ingestReactionAdd,
  ingestReactionRemove,
  ingestReactionRemoveAll,
  type IngestOptions,
  type ReactionEventInput,
} from '../../ingestion/ingest.js';
import { emojiKeyOf, normalizeMessage, normalizeMessageUpdate } from './normalize.js';

// ---- Gateway event dispatch (Section 9.3) -----------------------------------

/** The raw Gateway event types the dispatcher routes (Section 9.3). */
export type GatewayEventType =
  | 'MESSAGE_CREATE'
  | 'MESSAGE_UPDATE'
  | 'MESSAGE_DELETE'
  | 'MESSAGE_DELETE_BULK'
  | 'MESSAGE_REACTION_ADD'
  | 'MESSAGE_REACTION_REMOVE'
  | 'MESSAGE_REACTION_REMOVE_ALL'
  | 'CHANNEL_CREATE'
  | 'CHANNEL_UPDATE'
  | 'CHANNEL_DELETE'
  | 'THREAD_CREATE'
  | 'THREAD_UPDATE'
  | 'THREAD_DELETE'
  | 'THREAD_LIST_SYNC';

export const GATEWAY_EVENT_TYPES: readonly GatewayEventType[] = [
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',
  'MESSAGE_DELETE_BULK',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL',
  'CHANNEL_CREATE',
  'CHANNEL_UPDATE',
  'CHANNEL_DELETE',
  'THREAD_CREATE',
  'THREAD_UPDATE',
  'THREAD_DELETE',
  'THREAD_LIST_SYNC',
];

export interface GatewayEventResult {
  handled: boolean;
  /** Why an event was not applied (unknown event, missing id, unseen message). */
  reason?: 'unknown_event' | 'guild_missing' | 'guild_mismatch' | 'unknown_message'
    | 'missing_id' | 'missing_ids' | 'missing_reaction_fields' | 'missing_channel_fields'
    | 'no_threads' | 'missing_channel' | 'missing_message';
}

/** Discord channel types that represent threads (announcement/public/private). */
const THREAD_TYPES = new Set([10, 11, 12]);

/**
 * Map a raw Discord channel or thread payload to a channel upsert input with safe
 * defaults. Visibility policy is applied upstream (Section 7); a freshly seen
 * channel defaults to `restricted` until policy resolves it. `discovered_at_ms` is
 * honored only on first insert — `upsertChannel` preserves it on later updates and
 * clears any tombstone when a channel reappears (Section 29.1).
 */
export function channelInputFromRaw(
  raw: unknown,
  guildId: string,
  now: number,
): ChannelUpsertInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  if (typeof r.guild_id !== 'string' || r.guild_id !== guildId) return null;
  const type = typeof r.type === 'number' ? r.type : 0;
  const meta =
    r.thread_metadata && typeof r.thread_metadata === 'object'
      ? (r.thread_metadata as Record<string, unknown>)
      : {};
  return {
    id: r.id,
    guildId: r.guild_id,
    parentId: typeof r.parent_id === 'string' ? r.parent_id : null,
    type,
    name: typeof r.name === 'string' ? r.name : null,
    topic: typeof r.topic === 'string' ? r.topic : null,
    position: typeof r.position === 'number' ? r.position : null,
    isThread: THREAD_TYPES.has(type),
    isArchived: meta.archived === true || r.archived === true,
    isLocked: meta.locked === true || r.locked === true,
    ingestEnabled: true,
    visibilityClass: 'restricted',
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: typeof r.last_message_id === 'string' ? r.last_message_id : null,
    discoveredAtMs: now,
    updatedAtMs: now,
    rawJson: null,
  };
}

function reactionInputFromRaw(raw: unknown): ReactionEventInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const messageId = typeof r.message_id === 'string' ? r.message_id : null;
  const userId = typeof r.user_id === 'string' ? r.user_id : null;
  if (!messageId || !userId) return null;
  const emoji = r.emoji && typeof r.emoji === 'object' ? (r.emoji as Record<string, unknown>) : null;
  return {
    messageId,
    userId,
    // A null key becomes '', which the ingest layer drops (Section 9.9).
    emojiKey: emojiKeyOf(r.emoji) ?? '',
    emojiName: typeof emoji?.name === 'string' ? emoji.name : null,
  };
}

function idOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const id = (payload as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}

function idsOfBulk(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const ids = (payload as Record<string, unknown>).ids;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

function explicitGuildId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const guildId = (payload as Record<string, unknown>).guild_id;
  return typeof guildId === 'string' ? guildId : null;
}

function storedMessageBelongsToGuild(
  db: DatabaseSync,
  messageId: string | null,
  guildId: string,
): boolean {
  if (!messageId) return false;
  return prepareCached(
    db,
    'gateway.message_guild',
    'SELECT 1 FROM messages WHERE id = ? AND workspace_id = ?',
  ).get(messageId, guildId) !== undefined;
}

function gatewayEventBelongsToGuild(
  db: DatabaseSync,
  guildId: string,
  type: GatewayEventType,
  payload: unknown,
): boolean {
  const explicit = explicitGuildId(payload);
  if (explicit !== null) return explicit === guildId;
  if (type === 'THREAD_LIST_SYNC') {
    const threads = (payload as Record<string, unknown> | null)?.threads;
    return Array.isArray(threads) && threads.length > 0
      && threads.every((thread) => explicitGuildId(thread) === guildId);
  }
  if (type === 'MESSAGE_DELETE_BULK') {
    const ids = idsOfBulk(payload);
    return ids.length > 0 && ids.every((id) => storedMessageBelongsToGuild(db, id, guildId));
  }
  if (
    type === 'MESSAGE_UPDATE' || type === 'MESSAGE_DELETE' ||
    type === 'MESSAGE_REACTION_ADD' || type === 'MESSAGE_REACTION_REMOVE' ||
    type === 'MESSAGE_REACTION_REMOVE_ALL'
  ) {
    const row = payload as Record<string, unknown> | null;
    const messageId = type.startsWith('MESSAGE_REACTION')
      ? (typeof row?.message_id === 'string' ? row.message_id : idOf(payload))
      : idOf(payload);
    return storedMessageBelongsToGuild(db, messageId, guildId);
  }
  return false;
}

/**
 * Route one raw Gateway event to its idempotent persistence operation. Each
 * operation runs in a short transaction inside the ingest layer and performs no
 * network I/O (Section 9.1). Returns whether the event was handled, and a reason
 * when it was not — for example a partial MESSAGE_UPDATE for an unseen message,
 * which is left for reconciliation rather than inventing a row.
 */
export function handleGatewayEvent(
  db: DatabaseSync,
  opts: IngestOptions,
  type: GatewayEventType,
  payload: unknown,
  resolveChannelInput?: (raw: unknown, guildId: string, now: number) => ChannelUpsertInput | null,
): GatewayEventResult {
  if (!GATEWAY_EVENT_TYPES.includes(type)) {
    return { handled: false, reason: 'unknown_event' };
  }
  if (!gatewayEventBelongsToGuild(db, opts.guildId, type, payload)) {
    return { handled: false, reason: explicitGuildId(payload) === null ? 'guild_missing' : 'guild_mismatch' };
  }
  switch (type) {
    case 'MESSAGE_CREATE': {
      const msg = normalizeMessage(payload);
      if (!getChannel(db, msg.channelId)) return { handled: false, reason: 'missing_channel' };
      ingestMessageCreate(db, msg, opts);
      return { handled: true };
    }
    case 'MESSAGE_UPDATE': {
      const patch = normalizeMessageUpdate(payload);
      const res = ingestMessageUpdate(db, patch, opts);
      return res.unknownMessage ? { handled: false, reason: 'unknown_message' } : { handled: true };
    }
    case 'MESSAGE_DELETE': {
      const id = idOf(payload);
      if (!id) return { handled: false, reason: 'missing_id' };
      const channelId = payload && typeof payload === 'object'
        ? ((payload as Record<string, unknown>).channel_id as string | undefined)
        : undefined;
      ingestMessageDelete(db, id, opts, channelId);
      return { handled: true };
    }
    case 'MESSAGE_DELETE_BULK': {
      const ids = idsOfBulk(payload);
      if (ids.length === 0) return { handled: false, reason: 'missing_ids' };
      ingestMessageDeleteBulk(db, ids, opts);
      return { handled: true };
    }
    case 'MESSAGE_REACTION_ADD': {
      const input = reactionInputFromRaw(payload);
      if (!input) return { handled: false, reason: 'missing_reaction_fields' };
      if (!getMessage(db, input.messageId)) return { handled: false, reason: 'missing_message' };
      ingestReactionAdd(db, input, opts);
      return { handled: true };
    }
    case 'MESSAGE_REACTION_REMOVE': {
      const input = reactionInputFromRaw(payload);
      if (!input) return { handled: false, reason: 'missing_reaction_fields' };
      if (!getMessage(db, input.messageId)) return { handled: false, reason: 'missing_message' };
      ingestReactionRemove(db, input, opts);
      return { handled: true };
    }
    case 'MESSAGE_REACTION_REMOVE_ALL': {
      const id = idOf(payload);
      if (!id) return { handled: false, reason: 'missing_id' };
      ingestReactionRemoveAll(db, id, opts);
      return { handled: true };
    }
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE': {
      const input = resolveChannelInput
        ? resolveChannelInput(payload, opts.guildId, opts.now)
        : channelInputFromRaw(payload, opts.guildId, opts.now);
      if (!input) return { handled: false, reason: 'missing_channel_fields' };
      const previous = type === 'THREAD_UPDATE' ? getChannel(db, input.id) : undefined;
      upsertChannel(db, input);
      if (type === 'THREAD_UPDATE' && input.isArchived && previous?.is_archived === 0) {
        closeEpisodeAndQueueReview(db, input.id, opts.now);
      }
      return { handled: true };
    }
    case 'CHANNEL_DELETE':
    case 'THREAD_DELETE': {
      const id = idOf(payload);
      if (!id) return { handled: false, reason: 'missing_id' };
      tombstoneChannel(db, id, opts.now);
      return { handled: true };
    }
    case 'THREAD_LIST_SYNC': {
      const threads = (payload as Record<string, unknown> | null)?.threads;
      if (!Array.isArray(threads)) return { handled: true, reason: 'no_threads' };
      for (const t of threads) {
        const input = resolveChannelInput
          ? resolveChannelInput(t, opts.guildId, opts.now)
          : channelInputFromRaw(t, opts.guildId, opts.now);
        if (input) upsertChannel(db, input);
      }
      return { handled: true };
    }
    default:
      return { handled: false, reason: 'unknown_event' };
  }
}
