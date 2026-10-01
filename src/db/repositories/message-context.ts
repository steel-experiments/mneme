import { type DatabaseSync } from '../database.js';
import type { SQLOutputValue } from 'node:sqlite';
import { prepareCached } from './util.js';
import {
  channelVisibilityPredicate,
  discordMessageLink,
  type RetrievalGrant,
} from './message-search.js';

/**
 * Scope-bound message-context retrieval (Sections 7.3, 22.2).
 *
 * Returns a bounded window of neighbors around a permitted anchor, plus an
 * optional reply/thread chain. The anchor, every neighbor, and every reply are
 * filtered by the same SQL visibility grant, so an out-of-scope anchor yields
 * nothing and invisible neighbors never appear (Section 30.2).
 */

export const MAX_CONTEXT_COUNT = 50;
export const DEFAULT_CONTEXT_COUNT = 10;
/**
 * Reply-chain bound. No caller argument selects it, so it stays independent of
 * {@link MAX_CONTEXT_COUNT}: the neighbor window a caller asks to widen must not
 * also multiply the reply rows every call carries.
 */
export const MAX_REPLY_COUNT = 20;

export interface MessageContextInput {
  messageId: string;
  beforeCount?: number;
  afterCount?: number;
  includeReplies?: boolean;
}

export interface CompactMessage {
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string | null;
  authorDisplayName: string;
  content: string;
  createdAtMs: number;
  replyToMessageId: string | null;
  link: string;
}

export interface MessageContext {
  /** Null when the anchor is missing, deleted, or out of scope. */
  anchor: CompactMessage | null;
  before: CompactMessage[];
  after: CompactMessage[];
  replies: CompactMessage[];
}

const COLUMNS = `
  m.id AS message_id, m.workspace_id, m.channel_id, m.author_id,
  m.author_display_name, m.content, m.created_at_ms, m.reply_to_message_id
`;

function toCompact(row: Record<string, SQLOutputValue>): CompactMessage {
  const messageId = String(row.message_id);
  const guildId = String(row.workspace_id);
  const channelId = String(row.channel_id);
  return {
    messageId,
    guildId,
    channelId,
    authorId: row.author_id === null ? null : String(row.author_id),
    authorDisplayName: String(row.author_display_name),
    content: String(row.content),
    createdAtMs: Number(row.created_at_ms),
    replyToMessageId: row.reply_to_message_id === null ? null : String(row.reply_to_message_id),
    link: discordMessageLink(guildId, channelId, messageId),
  };
}

function clamp(n: number | undefined): number {
  return Math.min(MAX_CONTEXT_COUNT, Math.max(0, n ?? DEFAULT_CONTEXT_COUNT));
}

/**
 * Retrieve a bounded, scope-filtered context window around `messageId`. When the
 * anchor is not visible under `grant`, every field is empty and `anchor` is null.
 */
export function getMessageContext(
  db: DatabaseSync,
  grant: RetrievalGrant,
  input: MessageContextInput,
): MessageContext {
  const empty: MessageContext = { anchor: null, before: [], after: [], replies: [] };
  const pred = channelVisibilityPredicate(grant);
  const beforeN = clamp(input.beforeCount);
  const afterN = clamp(input.afterCount);

  const anchorSql = `
    SELECT ${COLUMNS}
      FROM messages m JOIN channels c ON c.id = m.channel_id
     WHERE m.id = ? AND m.deleted_at_ms IS NULL AND ${pred.sql}
  `;
  const anchorRow = prepareCached(db, `context.anchor:${pred.sql}`, anchorSql).get(
    input.messageId,
    ...pred.params,
  ) as Record<string, SQLOutputValue> | undefined;
  if (!anchorRow) return empty;
  const anchor = toCompact(anchorRow);

  const beforeSql = `
    SELECT ${COLUMNS}
      FROM messages m JOIN channels c ON c.id = m.channel_id
     WHERE m.channel_id = ? AND m.deleted_at_ms IS NULL AND ${pred.sql}
       AND (m.created_at_ms < ? OR (m.created_at_ms = ? AND m.id < ?))
     ORDER BY m.created_at_ms DESC, m.id DESC
     LIMIT ?
  `;
  const beforeRows = prepareCached(db, `context.before:${pred.sql}`, beforeSql).all(
    anchor.channelId,
    ...pred.params,
    anchor.createdAtMs,
    anchor.createdAtMs,
    anchor.messageId,
    beforeN,
  ) as Record<string, SQLOutputValue>[];
  // Reverse DESC → ascending for chronological output.
  const before = beforeRows.map(toCompact).reverse();

  const afterSql = `
    SELECT ${COLUMNS}
      FROM messages m JOIN channels c ON c.id = m.channel_id
     WHERE m.channel_id = ? AND m.deleted_at_ms IS NULL AND ${pred.sql}
       AND (m.created_at_ms > ? OR (m.created_at_ms = ? AND m.id > ?))
     ORDER BY m.created_at_ms ASC, m.id ASC
     LIMIT ?
  `;
  const after = (
    prepareCached(db, `context.after:${pred.sql}`, afterSql).all(
      anchor.channelId,
      ...pred.params,
      anchor.createdAtMs,
      anchor.createdAtMs,
      anchor.messageId,
      afterN,
    ) as Record<string, SQLOutputValue>[]
  ).map(toCompact);

  let replies: CompactMessage[] = [];
  if (input.includeReplies) {
    const repliesSql = `
      SELECT ${COLUMNS}
        FROM messages m JOIN channels c ON c.id = m.channel_id
       WHERE m.deleted_at_ms IS NULL AND ${pred.sql}
         AND (m.reply_to_message_id = ? OR m.id = ?)
         AND m.id <> ?
       ORDER BY m.created_at_ms ASC, m.id ASC
       LIMIT ?
    `;
    replies = (
      prepareCached(db, `context.replies:${pred.sql}`, repliesSql).all(
        ...pred.params,
        anchor.messageId,
        anchor.replyToMessageId,
        anchor.messageId,
        MAX_REPLY_COUNT,
      ) as Record<string, SQLOutputValue>[]
    ).map(toCompact);
  }

  return { anchor, before, after, replies };
}
