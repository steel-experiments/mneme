import { type DatabaseSync, transaction } from '../db/database.js';
import { unlinkSync } from 'node:fs';
import {
  ensureObservedGuildMember,
  ensureObservedUser,
  upsertUser,
} from '../db/repositories/users.js';
import {
  applyMessageUpdate,
  captureMessageVersion,
  deleteMessage,
  hasMessageTombstone,
  recordMessageTombstone,
  getMessage,
  touchChannelLastMessage,
  upsertMessageCreate,
  type MessageCreateInput,
} from '../db/repositories/messages.js';
import {
  listAttachmentLocalPaths,
  markAttachmentsDeleted,
  setAttachmentArchive,
  upsertAttachments,
  type AttachmentUpsertInput,
} from '../db/repositories/attachments.js';
import {
  addReaction,
  removeAllReactions,
  removeReaction,
  replaceBackfillReactionCounts,
} from '../db/repositories/reactions.js';
import { getChannel, upsertChannel, tombstoneChannel, type ChannelUpsertInput } from '../db/repositories/channels.js';
import { emojiKeyOf, normalizeMessage, normalizeMessageUpdate } from './normalize.js';
import type { NormalizedMessage, NormalizedMessagePatch } from './normalize.js';
import type { AttachmentMode } from '../config.js';
import { enqueue } from '../jobs/queue.js';
import { checkArchiveEligibility, type AttachmentArchiveConfig } from './attachments.js';
import { closeEpisodeAndQueueReview } from '../episodes/builder.js';
import { prepareCached } from '../db/repositories/util.js';

/**
 * Discord message ingestion (Sections 9.1–9.10).
 *
 * Each public function runs the persistence work for one event inside a single
 * short SQLite transaction. No function here performs network I/O — attachment
 * archiving and any Discord REST calls happen out of band (Section 9.1). The
 * caller is responsible for channel-visibility authorization before calling;
 * ingestion never re-checks policy (fail-closed is enforced upstream).
 */

export interface IngestOptions {
  /** Authoritative guild id (the normalized message may omit it). */
  guildId: string;
  /** STORE_RAW_JSON — disabled by default (Section 29.1). */
  storeRawJson: boolean;
  /** RETAIN_EDIT_HISTORY. */
  retainEditHistory: boolean;
  /** RETAIN_DELETED_CONTENT. */
  retainDeletedContent: boolean;
  /** ATTACHMENT_MODE — 'none' skips attachment metadata entirely. */
  attachmentMode: AttachmentMode;
  /** Present for archive/selective modes; eligible downloads become durable jobs. */
  attachmentArchive?: AttachmentArchiveConfig;
  /** Observation timestamp (ms). */
  now: number;
}

export interface CreateResult {
  /** Whether the message row was inserted or had a field change applied. */
  changed: boolean;
}

export interface PageResult {
  /** Number of messages that produced a row change across the page. */
  changed: number;
  /** Total messages processed in the page. */
  messages: number;
}

export interface UpdateResult {
  /** Whether the message row was found and updated. */
  applied: boolean;
  /** The message was not present; a partial update cannot be applied. */
  unknownMessage: boolean;
  /** Edit-history version captured, when retention is on and content changed. */
  editVersion: number | undefined;
}

export interface DeleteResult {
  /** Number of message rows tombstoned. */
  tombstoned: number;
  /** Local attachment paths removed from disk (post-commit, best-effort). */
  removedFiles: string[];
}

/** Display name fallback order: member/global/username/id (Section 9.3). */
export function resolveAuthorDisplayName(author: {
  globalName: string | null;
  username: string | null;
  id: string;
}): string {
  return author.globalName ?? author.username ?? author.id;
}

function rawJsonOf(opts: IngestOptions, raw: unknown): string | null {
  return opts.storeRawJson ? JSON.stringify(raw) : null;
}

function persistAuthorAndMember(
  db: DatabaseSync,
  opts: IngestOptions,
  author: NormalizedMessage['author'],
): string {
  upsertUser(db, {
    id: author.id,
    username: author.username,
    globalName: author.globalName,
    isBot: author.isBot,
    firstSeenAtMs: opts.now,
    lastSeenAtMs: opts.now,
    rawJson: null,
  });
  // A message author carries a user profile but not authoritative membership
  // metadata. Ensure the row exists without replacing a prior display name or
  // role set supplied by a GUILD_MEMBER event.
  ensureObservedGuildMember(db, {
    guildId: opts.guildId,
    userId: author.id,
    observedAtMs: opts.now,
  });
  return resolveAuthorDisplayName(author);
}

/**
 * Persist a full message (MESSAGE_CREATE or a REST fetch) and everything it
 * carries: author, membership, the message row, attachment metadata, REST
 * reaction counts, and the channel's last-message cursor. Runs in its own short
 * transaction; callers that batch many messages should use {@link ingestMessagePage}
 * instead so one transaction covers the whole page.
 */
export function ingestMessageCreate(
  db: DatabaseSync,
  msg: NormalizedMessage,
  opts: IngestOptions,
): CreateResult {
  const changed = transaction(db, () => persistMessageCreate(db, msg, opts) > 0);
  return { changed };
}

/**
 * The transaction-free body of a message upsert, returning the change delta. It is
 * always called from inside a transaction — either a per-message one
 * ({@link ingestMessageCreate}) or a per-page one ({@link ingestMessagePage}). Exposed
 * privately so the same path serves gateway events and historical backfill.
 */
function persistMessageCreate(db: DatabaseSync, msg: NormalizedMessage, opts: IngestOptions): number {
  if (hasMessageTombstone(db, msg.id)) return 0;
  if (msg.guildId !== opts.guildId) return 0;
  const guildId = msg.guildId;
  const authorDisplayName = persistAuthorAndMember(db, opts, msg.author);

  const input: MessageCreateInput = {
    id: msg.id,
    guildId,
    channelId: msg.channelId,
    authorId: msg.author.id,
    authorDisplayName,
    content: msg.content,
    createdAtMs: msg.createdAtMs,
    editedAtMs: msg.editedAtMs,
    replyToMessageId: msg.replyToMessageId,
    messageType: msg.messageType,
    flags: msg.flags,
    pinned: msg.pinned,
    mentionEveryone: msg.mentionEveryone,
    mentionsJson: JSON.stringify(msg.mentions),
    embedsJson: JSON.stringify(msg.embeds),
    componentsJson: JSON.stringify(msg.components),
    pollJson: msg.poll == null ? null : JSON.stringify(msg.poll),
    rawJson: rawJsonOf(opts, msg.raw),
    ingestedAtMs: opts.now,
    updatedAtMs: opts.now,
  };
  let delta = upsertMessageCreate(db, input);

  if (opts.attachmentMode !== 'none' && msg.attachments.length > 0) {
    const items: AttachmentUpsertInput[] = msg.attachments.map((a) => ({
      id: a.id,
      messageId: msg.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      width: a.width,
      height: a.height,
      sourceUrl: a.sourceUrl,
      proxyUrl: a.proxyUrl,
      createdAtMs: opts.now,
      updatedAtMs: opts.now,
    }));
    delta += upsertAttachments(db, items);
    if (opts.attachmentArchive) {
      for (const attachment of msg.attachments) {
        if (!checkArchiveEligibility(attachment, opts.attachmentArchive).eligible) continue;
        setAttachmentArchive(db, {
          id: attachment.id, localPath: null, sha256: null, status: 'queued', updatedAtMs: opts.now,
        });
        enqueue(db, {
          type: 'archive_attachment', payload: { attachmentId: attachment.id },
          uniqueKey: `attachment:archive:${attachment.id}`, now: opts.now,
        });
      }
    }
  }

  delta += replaceBackfillReactionCounts(
    db,
    msg.id,
    msg.reactionCounts.map((r) => ({ messageId: msg.id, emojiKey: r.emojiKey, count: r.count })),
    opts.now,
  );

  touchChannelLastMessage(db, msg.channelId, msg.id, msg.createdAtMs, opts.now);
  return delta;
}

/**
 * Persist a whole page of normalized messages inside a single short transaction
 * (Section 9.5 step 2). Each message is upserted idempotently, so a re-delivered
 * or overlapping page produces no duplicate rows and no churn. Returns the number
 * of messages that produced a change.
 */
export function ingestMessagePage(
  db: DatabaseSync,
  messages: readonly NormalizedMessage[],
  opts: IngestOptions,
  freshness?: { preserveUpdatedAfterMs?: number },
): PageResult {
  if (messages.length === 0) return { changed: 0, messages: 0 };
  let changed = 0;
  const preserveUpdatedAfterMs = freshness?.preserveUpdatedAfterMs;
  const persist = (): void => {
    for (const msg of messages) {
      // A page fetched before a newer gateway update must not overwrite that
      // local observation. This is deliberately strict only for newer writes;
      // same-millisecond re-delivery remains idempotent and refreshable.
      const existing = preserveUpdatedAfterMs === undefined ? undefined : getMessage(db, msg.id);
      if (preserveUpdatedAfterMs !== undefined && existing && existing.updated_at_ms > preserveUpdatedAfterMs) continue;
      changed += persistMessageCreate(db, msg, opts);
    }
  };
  if (db.isTransaction) persist(); else transaction(db, persist);
  return { changed, messages: messages.length };
}

/**
 * Apply a partial MESSAGE_UPDATE. Requires an existing message row; a partial
 * patch for an unseen message is ignored (reconciliation will catch the full
 * message later). When RETAIN_EDIT_HISTORY is on and content changed, the prior
 * content is captured as a version inside the same transaction.
 */
export function ingestMessageUpdate(
  db: DatabaseSync,
  patch: NormalizedMessagePatch,
  opts: IngestOptions,
): UpdateResult {
  return transaction(db, () => {
    const current = getMessage(db, patch.id);
    if (!current) {
      return { applied: false, unknownMessage: true, editVersion: undefined };
    }

    let authorDisplayName = current.author_display_name;
    if (patch.author !== undefined && patch.author !== null) {
      authorDisplayName = persistAuthorAndMember(db, opts, patch.author);
    }

    let editVersion: number | undefined;
    if (
      opts.retainEditHistory &&
      patch.content !== undefined &&
      patch.content !== current.content
    ) {
      editVersion = captureMessageVersion(
        db,
        patch.id,
        {
          content: current.content,
          editedAtMs: current.edited_at_ms,
          rawJson: current.raw_json,
        },
        opts.now,
      );
    }

    const changed = applyMessageUpdate(db, {
      patch,
      authorDisplayName,
      updatedAtMs: opts.now,
    });
    return { applied: changed > 0, unknownMessage: false, editVersion };
  });
}

/**
 * Tombstone a message (MESSAGE_DELETE). The FTS trigger drops it from search;
 * when RETAIN_DELETED_CONTENT is off the content columns are blanked too. Local
 * attachment files (if any were archived) are removed after the transaction
 * commits. A delete missed while offline cannot be inferred from a REST page
 * absence (Section 9.8); only an explicit delete event tombstones here.
 */
export function ingestMessageDelete(
  db: DatabaseSync,
  messageId: string,
  opts: IngestOptions,
  channelId?: string | null,
): DeleteResult {
  const pathsToClean = transaction(db, () => {
    recordMessageTombstone(db, { messageId, guildId: opts.guildId, channelId, deletedAtMs: opts.now });
    const paths = listAttachmentLocalPaths(db, messageId);
    deleteMessage(db, messageId, {
      retainDeletedContent: opts.retainDeletedContent,
      nowMs: opts.now,
    });
    if (!opts.retainDeletedContent) {
      markAttachmentsDeleted(db, messageId, opts.now);
    }
    return paths;
  });

  const removedFiles = purgeLocalFiles(pathsToClean);
  return { tombstoned: 1, removedFiles };
}

/** Tombstone a batch of messages (MESSAGE_DELETE_BULK). */
export function ingestMessageDeleteBulk(
  db: DatabaseSync,
  messageIds: string[],
  opts: IngestOptions,
): DeleteResult {
  const pathsToClean = transaction(db, () => {
    const paths: string[] = [];
    for (const id of messageIds) {
      recordMessageTombstone(db, { messageId: id, guildId: opts.guildId, deletedAtMs: opts.now });
      paths.push(...listAttachmentLocalPaths(db, id));
      deleteMessage(db, id, {
        retainDeletedContent: opts.retainDeletedContent,
        nowMs: opts.now,
      });
      if (!opts.retainDeletedContent) {
        markAttachmentsDeleted(db, id, opts.now);
      }
    }
    return paths;
  });

  const removedFiles = purgeLocalFiles(pathsToClean);
  return { tombstoned: messageIds.length, removedFiles };
}

/** Remove local attachment files (best-effort; never fails the delete). */
function purgeLocalFiles(paths: string[]): string[] {
  const removed: string[] = [];
  for (const p of paths) {
    try {
      unlinkSync(p);
      removed.push(p);
    } catch {
      // A missing or unreadable file is not a data-integrity failure: the DB
      // row is already marked deleted. Best-effort only.
    }
  }
  return removed;
}

// ---- Live reactions (Section 9.3, 9.9) --------------------------------------

export interface ReactionEventInput {
  messageId: string;
  userId: string;
  /** Raw Discord emoji object ({ name, id? }). */
  emoji: unknown;
}

export interface ReactionResult {
  /** Whether a per-user row was inserted or deleted. */
  changed: boolean;
  /** A stable emoji key could not be derived; the event was ignored. */
  dropped: boolean;
}

function ensureReactionUser(db: DatabaseSync, opts: IngestOptions, userId: string): void {
  // A reaction identifies a user but does not carry authoritative profile or
  // membership data. Insert a placeholder only when missing; do not erase an
  // existing name, bot flag, display name, or roles.
  ensureObservedUser(db, { id: userId, observedAtMs: opts.now });
  ensureObservedGuildMember(db, {
    guildId: opts.guildId,
    userId,
    observedAtMs: opts.now,
  });
}

/** MESSAGE_REACTION_ADD — store a per-user row and refresh the live aggregate. */
export function ingestReactionAdd(
  db: DatabaseSync,
  input: ReactionEventInput,
  opts: IngestOptions,
): ReactionResult {
  const emojiKey = emojiKeyOf(input.emoji);
  if (emojiKey === null || emojiKey === '') return { changed: false, dropped: true };
  return transaction(db, () => {
    ensureReactionUser(db, opts, input.userId);
    const inserted = addReaction(db, {
      messageId: input.messageId,
      userId: input.userId,
      emojiKey,
      observedAtMs: opts.now,
    });
    return { changed: inserted, dropped: false };
  });
}

/** MESSAGE_REACTION_REMOVE — drop a per-user row and refresh the aggregate. */
export function ingestReactionRemove(
  db: DatabaseSync,
  input: ReactionEventInput,
  opts: IngestOptions,
): ReactionResult {
  const emojiKey = emojiKeyOf(input.emoji);
  if (emojiKey === null || emojiKey === '') return { changed: false, dropped: true };
  return transaction(db, () => {
    ensureReactionUser(db, opts, input.userId);
    const removed = removeReaction(db, {
      messageId: input.messageId,
      userId: input.userId,
      emojiKey,
      observedAtMs: opts.now,
    });
    return { changed: removed, dropped: false };
  });
}

export interface RemoveAllResult {
  /** Number of per-user reaction rows removed. */
  removedReactions: number;
}

/** MESSAGE_REACTION_REMOVE_ALL — clear every reaction and aggregate on a message. */
export function ingestReactionRemoveAll(
  db: DatabaseSync,
  messageId: string,
  opts: IngestOptions,
): RemoveAllResult {
  return transaction(db, () => ({ removedReactions: removeAllReactions(db, messageId, opts.now) }));
}

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
  return { messageId, userId, emoji: r.emoji };
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
