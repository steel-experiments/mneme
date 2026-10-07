// ABOUTME: Org-only read functions over the read-only platform archive (plan 011 step 5, spec §5.4).
// ABOUTME: The SQL hard-codes the org-only rule and the redactions; no live grant or live link builder reaches the archive.
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../logger.js';
import type { PlatformId } from '../config.js';
import type { RetrievalGrant } from '../db/repositories/message-search.js';
import { DEFAULT_LIMIT, MAX_RESULT_LIMIT, parseFtsQuery } from '../db/fts-query.js';
import { discordMessageLink } from '../platform/links.js';
import { isDiscordId, isPlatformId, isSlackId, isSlackSyntheticId } from '../platform/ids.js';
import type { ArchiveSummary } from './database.js';
import { loadRedactions } from './redactions.js';
import { servableMemory, servableMessage } from './servable.js';

/**
 * The only scope that archive content ever has (plan 011 decision 2): org
 * messages and org memories, nothing else, with no exception for any run or
 * channel. The read functions take no grant; their SQL encodes this one.
 */
export const ARCHIVE_GRANT: Readonly<RetrievalGrant> = Object.freeze({
  includeOrgMessages: true,
  includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: Object.freeze([]) as readonly string[],
});

/** Every archive id that leaves this module carries this prefix. */
export const ARCHIVE_ID_PREFIX = 'archive:';

/** The verified archive, the live database that holds its redactions, and a logger. */
export interface ArchiveReader {
  db: DatabaseSync;
  liveDb: DatabaseSync;
  summary: ArchiveSummary;
  logger?: Pick<Logger, 'warn'>;
}

/** Where an archive result came from. Hosts render it; the model never builds it. */
export interface ArchiveSource {
  platform: PlatformId;
  label: 'archive';
  createdAtMs: number;
}

export interface ArchiveMessage {
  /** `archive:<message id>`. */
  id: string;
  messageId: string;
  channelId: string;
  /** The channel name, or the parent name for a thread. */
  channelName: string | null;
  authorDisplayName: string;
  createdAtMs: number;
  /** A search snippet, or the full content for context and evidence. */
  text: string;
  /** A host-built link on the archive's platform, or null when none can be built. */
  link: string | null;
  source: ArchiveSource;
}

export interface ArchiveMessageContext {
  target: ArchiveMessage;
  before: ArchiveMessage[];
  after: ArchiveMessage[];
}

export interface ArchiveMemory {
  /** `archive:<memory id>`. */
  id: string;
  memoryId: string;
  type: string;
  statement: string;
  lastConfirmedAtMs: number;
  source: ArchiveSource;
}

export interface ArchiveMemoryEvidence {
  memory: ArchiveMemory;
  evidence: ArchiveMessage[];
}

export function createArchiveReader(reader: ArchiveReader): ArchiveReader {
  return { ...reader };
}

interface RedactionParams {
  redacted_messages: string;
  redacted_users: string;
}

/** Load redactions for this call. A failure fails closed: the caller returns nothing. */
function redactionParams(reader: ArchiveReader): RedactionParams | null {
  try {
    const r = loadRedactions(reader.liveDb, reader.summary.workspaceId);
    return { redacted_messages: JSON.stringify(r.messageIds), redacted_users: JSON.stringify(r.userIds) };
  } catch (err) {
    reader.logger?.warn({
      event: 'platform_archive.redactions_unavailable',
      err: err instanceof Error ? err.message : String(err),
    }, 'archive redactions could not be loaded; archive reads return nothing');
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.floor(limit)));
}

/** The archive message id inside `id`, or null when `id` is not a valid archive message id. */
function archiveMessageId(reader: ArchiveReader, id: string): string | null {
  if (typeof id !== 'string' || !id.startsWith(ARCHIVE_ID_PREFIX)) return null;
  const raw = id.slice(ARCHIVE_ID_PREFIX.length);
  const valid = reader.summary.platform === 'discord' ? isDiscordId(raw) : isPlatformId(raw);
  return valid ? raw : null;
}

function archiveMemoryId(id: string): string | null {
  if (typeof id !== 'string' || !id.startsWith(ARCHIVE_ID_PREFIX)) return null;
  const raw = id.slice(ARCHIVE_ID_PREFIX.length);
  return /^[A-Za-z0-9._:-]{1,128}$/.test(raw) ? raw : null;
}

function linkFor(reader: ArchiveReader, channelId: string, messageId: string): string | null {
  // Slack archive links need the old team domain, which the archive does not store.
  return reader.summary.platform === 'discord'
    ? discordMessageLink(reader.summary.workspaceId, channelId, messageId)
    : null;
}

const MESSAGE_COLUMNS = `
  m.id AS id, m.channel_id AS channel_id, m.author_display_name AS author,
  m.created_at_ms AS created_at_ms, m.content AS content,
  CASE WHEN c.is_thread = 1 THEN COALESCE(p.name, c.name) ELSE c.name END AS channel_name`;

const MESSAGE_JOINS = `
  LEFT JOIN channels c ON c.id = m.channel_id
  LEFT JOIN channels p ON p.id = c.parent_id`;

type MessageRow = {
  id: string;
  channel_id: string;
  author: string | null;
  created_at_ms: number;
  content: string | null;
  channel_name: string | null;
  snippet?: string | null;
};

function toMessage(reader: ArchiveReader, row: MessageRow, useSnippet: boolean): ArchiveMessage {
  return {
    id: `${ARCHIVE_ID_PREFIX}${row.id}`,
    messageId: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    authorDisplayName: row.author ?? 'unknown author',
    createdAtMs: row.created_at_ms,
    text: String((useSnippet ? row.snippet : row.content) ?? row.content ?? ''),
    link: linkFor(reader, row.channel_id, row.id),
    source: { platform: reader.summary.platform, label: 'archive', createdAtMs: row.created_at_ms },
  };
}

/** Full-text search over servable org archive messages. An empty query returns nothing. */
export function searchArchiveMessages(
  reader: ArchiveReader,
  options: { query: string; limit?: number; afterMs?: number; beforeMs?: number },
): ArchiveMessage[] {
  const parsed = parseFtsQuery(options.query);
  if (!parsed.match) return [];
  const params = redactionParams(reader);
  if (!params) return [];
  const rows = reader.db.prepare(`
    SELECT ${MESSAGE_COLUMNS},
           snippet(messages_fts, 0, '«', '»', ' … ', 24) AS snippet
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      ${MESSAGE_JOINS}
     WHERE messages_fts MATCH :match
       AND ${servableMessage('m', 'c', 'p')}
       AND (:after_ms IS NULL OR m.created_at_ms >= :after_ms)
       AND (:before_ms IS NULL OR m.created_at_ms < :before_ms)
     ORDER BY bm25(messages_fts), m.created_at_ms DESC, m.id
     LIMIT :limit`).all({
    ...params,
    match: parsed.match,
    after_ms: options.afterMs ?? null,
    before_ms: options.beforeMs ?? null,
    limit: clampLimit(options.limit),
  }) as MessageRow[];
  return rows.map((row) => toMessage(reader, row, true));
}

/**
 * The servable neighbours of one servable archive message in its own channel or
 * thread. Returns null when the id is not a servable archive message.
 */
export function getArchiveMessageContext(
  reader: ArchiveReader,
  id: string,
  options: { before?: number; after?: number } = {},
): ArchiveMessageContext | null {
  const messageId = archiveMessageId(reader, id);
  if (!messageId) return null;
  const params = redactionParams(reader);
  if (!params) return null;
  const target = reader.db.prepare(`
    SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}
     WHERE m.id = :id AND ${servableMessage('m', 'c', 'p')}`).get({ ...params, id: messageId }) as MessageRow | undefined;
  if (!target) return null;
  const window = (direction: 'before' | 'after', count: number): ArchiveMessage[] => {
    const n = Math.max(0, Math.min(MAX_RESULT_LIMIT, Math.floor(count)));
    if (n === 0) return [];
    const comparison = direction === 'before'
      ? '(m.created_at_ms < :at OR (m.created_at_ms = :at AND m.id < :id))'
      : '(m.created_at_ms > :at OR (m.created_at_ms = :at AND m.id > :id))';
    const order = direction === 'before' ? 'DESC' : 'ASC';
    const rows = reader.db.prepare(`
      SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}
       WHERE m.channel_id = :channel AND ${comparison}
         AND ${servableMessage('m', 'c', 'p')}
       ORDER BY m.created_at_ms ${order}, m.id ${order}
       LIMIT :limit`).all({ ...params, channel: target.channel_id, at: target.created_at_ms, id: target.id, limit: n }) as MessageRow[];
    const messages = rows.map((row) => toMessage(reader, row, false));
    return direction === 'before' ? messages.reverse() : messages;
  };
  return {
    target: toMessage(reader, target, false),
    before: window('before', options.before ?? 5),
    after: window('after', options.after ?? 5),
  };
}

/**
 * One servable archive message, read at call time with the current
 * redactions. Returns null when the id is not a servable archive message.
 */
export function getArchiveMessage(reader: ArchiveReader, id: string): ArchiveMessage | null {
  const messageId = archiveMessageId(reader, id);
  if (!messageId) return null;
  const params = redactionParams(reader);
  if (!params) return null;
  const row = reader.db.prepare(`
    SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}
     WHERE m.id = :id AND ${servableMessage('m', 'c', 'p')}`).get({ ...params, id: messageId }) as MessageRow | undefined;
  return row ? toMessage(reader, row, false) : null;
}

type MemoryRow = { id: string; type: string; statement: string; last_confirmed_at_ms: number };

function toMemory(reader: ArchiveReader, row: MemoryRow): ArchiveMemory {
  return {
    id: `${ARCHIVE_ID_PREFIX}${row.id}`,
    memoryId: row.id,
    type: row.type,
    statement: row.statement,
    lastConfirmedAtMs: row.last_confirmed_at_ms,
    source: { platform: reader.summary.platform, label: 'archive', createdAtMs: row.last_confirmed_at_ms },
  };
}

/** Search servable org archive memories; without a query, list the most recently confirmed ones. */
export function searchArchiveMemories(
  reader: ArchiveReader,
  options: { query?: string; limit?: number },
): ArchiveMemory[] {
  const params = redactionParams(reader);
  if (!params) return [];
  const limit = clampLimit(options.limit);
  const parsed = parseFtsQuery(options.query ?? '');
  const rows = parsed.match
    ? reader.db.prepare(`
        SELECT mem.id, mem.type, mem.statement, mem.last_confirmed_at_ms
          FROM memories_fts
          JOIN memories mem ON mem.rowid = memories_fts.rowid
         WHERE memories_fts MATCH :match AND ${servableMemory('mem')}
         ORDER BY bm25(memories_fts), mem.last_confirmed_at_ms DESC, mem.id
         LIMIT :limit`).all({ ...params, match: parsed.match, limit }) as MemoryRow[]
    : (options.query ?? '').trim()
      ? []
      : reader.db.prepare(`
        SELECT mem.id, mem.type, mem.statement, mem.last_confirmed_at_ms
          FROM memories mem
         WHERE ${servableMemory('mem')}
         ORDER BY mem.last_confirmed_at_ms DESC, mem.id
         LIMIT :limit`).all({ ...params, limit }) as MemoryRow[];
  return rows.map((row) => toMemory(reader, row));
}

/** One servable archive memory and its evidence messages, or null. */
export function getArchiveMemoryEvidence(reader: ArchiveReader, id: string): ArchiveMemoryEvidence | null {
  const memoryId = archiveMemoryId(id);
  if (!memoryId) return null;
  const params = redactionParams(reader);
  if (!params) return null;
  const memory = reader.db.prepare(`
    SELECT mem.id, mem.type, mem.statement, mem.last_confirmed_at_ms
      FROM memories mem WHERE mem.id = :id AND ${servableMemory('mem')}`).get({ ...params, id: memoryId }) as MemoryRow | undefined;
  if (!memory) return null;
  const evidence = reader.db.prepare(`
    SELECT ${MESSAGE_COLUMNS}
      FROM memory_evidence ev
      JOIN messages m ON m.id = ev.message_id
      ${MESSAGE_JOINS}
     WHERE ev.memory_id = :id AND ${servableMessage('m', 'c', 'p')}
     ORDER BY m.created_at_ms, m.id`).all({ ...params, id: memoryId }) as MessageRow[];
  return { memory: toMemory(reader, memory), evidence: evidence.map((row) => toMessage(reader, row, false)) };
}

/** One archive author that an admin can name in an archive user deletion request. */
export interface ArchiveUser {
  /** `archive:<user id>`. */
  id: string;
  userId: string;
  displayName: string;
  /** Servable org messages by this author. */
  orgMessageCount: number;
}

/** True when `raw` is a user id on the archive's platform. */
export function isArchiveUserId(reader: ArchiveReader, raw: string): boolean {
  return reader.summary.platform === 'discord' ? isDiscordId(raw) : isSlackUserId(raw);
}

/** True when `raw` is a message id on the archive's platform. */
export function isArchiveMessageId(reader: ArchiveReader, raw: string): boolean {
  return reader.summary.platform === 'discord' ? isDiscordId(raw) : isSlackSyntheticId(raw);
}

function isSlackUserId(raw: string): boolean {
  return isSlackId(raw) && (raw.startsWith('U') || raw.startsWith('W'));
}

/**
 * Archive authors whose display name contains `name`, with their servable org
 * message count. Only authors of servable, unredacted org messages appear, so
 * a redacted user is not findable. `%` and `_` in `name` are plain text.
 */
export function searchArchiveUsers(reader: ArchiveReader, options: { name: string; limit?: number }): ArchiveUser[] {
  const name = options.name.trim();
  if (!name) return [];
  const params = redactionParams(reader);
  if (!params) return [];
  const pattern = `%${name.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = reader.db.prepare(`
    SELECT m.author_id AS user_id, MAX(m.author_display_name) AS display_name, COUNT(*) AS n
      FROM messages m ${MESSAGE_JOINS}
     WHERE m.author_id IS NOT NULL
       AND m.author_display_name LIKE :pattern ESCAPE '\\'
       AND ${servableMessage('m', 'c', 'p')}
     GROUP BY m.author_id
     ORDER BY n DESC, m.author_id
     LIMIT :limit`).all({ ...params, pattern, limit: clampLimit(options.limit) }) as Array<{ user_id: string; display_name: string | null; n: number }>;
  return rows.map((row) => ({
    id: `${ARCHIVE_ID_PREFIX}${row.user_id}`,
    userId: row.user_id,
    displayName: row.display_name ?? 'unknown author',
    orgMessageCount: Number(row.n),
  }));
}

/** How a deletion request for an archive target stands before it is filed. */
export type ArchiveDeletionTarget =
  | { kind: 'ok'; messageCount: number }
  | { kind: 'already_hidden' }
  | { kind: 'no_match' };

/**
 * Count every archive message that a deletion of `targetId` covers, in any
 * visibility class: a redaction hides all of them. Reports a target that a
 * redaction already hides. The count reveals no content.
 */
export function describeArchiveDeletionTarget(
  reader: ArchiveReader,
  kind: 'user' | 'message',
  targetId: string,
): ArchiveDeletionTarget {
  const hidden = reader.liveDb.prepare(`SELECT 1 FROM archive_redactions
     WHERE archive_workspace_id = ? AND target_kind = ? AND target_id = ?`).get(reader.summary.workspaceId, kind, targetId);
  if (hidden) return { kind: 'already_hidden' };
  const field = kind === 'user' ? 'author_id' : 'id';
  const n = Number(reader.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${field} = ?`).get(targetId)?.n ?? 0);
  return n > 0 ? { kind: 'ok', messageCount: n } : { kind: 'no_match' };
}
