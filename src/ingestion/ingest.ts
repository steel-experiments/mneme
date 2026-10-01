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
import type { NormalizedMessage, NormalizedMessagePatch } from '../platform/types.js';
import type { AttachmentMode } from '../config.js';
import { enqueue } from '../jobs/queue.js';
import { checkArchiveEligibility, type AttachmentArchiveConfig } from './attachments.js';

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
  /** Stable emoji key from the platform adapter; an empty key drops the event. */
  emojiKey: string;
  /** Display name of the emoji, when the platform supplies one. */
  emojiName: string | null;
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
  const emojiKey = input.emojiKey;
  if (emojiKey === '') return { changed: false, dropped: true };
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
  const emojiKey = input.emojiKey;
  if (emojiKey === '') return { changed: false, dropped: true };
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
