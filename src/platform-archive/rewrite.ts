// ABOUTME: Writes a minimized copy of the read-only platform archive without the redacted rows (plan 011 step 10).
// ABOUTME: The source archive is never opened for writing; redaction rows stay in the live database and keep applying.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rejectUnsafePath } from '../config.js';
import { normalizeJournalMode } from '../db/backup.js';
import { loadRedactions } from './redactions.js';
import { servableMemory, servableMessage } from './servable.js';

export interface RewriteArchiveOptions {
  /** The current archive file. Read only. */
  archivePath: string;
  /** Where the new archive goes. Must not exist. */
  outPath: string;
  /** The live database that holds `archive_redactions`. */
  liveDb: DatabaseSync;
  /**
   * Keep content that the archive never serves (non-org channels, test
   * surfaces, shared or private threads, tombstoned rows, non-org memories).
   * Off by default: the org-only rule means such content has no use in the
   * archive. Only for an operator who may relax the rule later.
   */
  keepNonOrg?: boolean;
}

export interface RewriteArchiveResult {
  outPath: string;
  sha256: string;
  removedMessages: number;
  removedMemories: number;
  /** Messages, memories, and channels dropped because the archive never serves them. */
  prunedMessages: number;
  prunedMemories: number;
  prunedChannels: number;
}

/** Bound on the foreign-key cleanup rounds; each round removes one level of dependent rows. */
const MAX_CASCADE_ROUNDS = 20;

/**
 * The tables whose rows the archive reads (src/platform-archive and the
 * archive commands). A rewrite keeps rows only in these tables and in the
 * full-text indexes, which it rebuilds. Every other table is emptied, also a
 * table that a later migration adds, so a new table can never carry content
 * into a rewritten archive.
 */
export const KEPT_ARCHIVE_TABLES = [
  'schema_migrations',
  'workspaces',
  'channels',
  'channel_access_audits',
  'messages',
  'message_tombstones',
  'memories',
  'memory_evidence',
  'users',
] as const;

/** Full-text index tables; the rewrite rebuilds them from the kept rows. */
const FTS_TABLE_PREFIXES = ['messages_fts', 'memories_fts'];

/**
 * Columns of kept tables that the archive never reads but that can hold copies
 * of message content, quoted replies, or user ids. A rewrite clears them to
 * their column default (NULL, or the empty JSON value for NOT NULL columns).
 */
const UNREAD_COLUMNS: Record<string, readonly string[]> = {
  messages: ['raw_json', 'embeds_json', 'mentions_json', 'components_json', 'poll_json'],
  channels: ['raw_json', 'last_message_id'],
  users: ['raw_json'],
  workspaces: ['raw_json', 'owner_id'],
  memories: ['metadata_json'],
  memory_evidence: ['note'],
};

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Empty every table that the archive does not read and clear the unread
 * columns of the kept tables. Throws when a kept table has a foreign key into
 * an emptied table: that would make the kept rows depend on removed rows.
 */
function minimizeArchive(db: DatabaseSync): void {
  const kept = new Set<string>(KEPT_ARCHIVE_TABLES);
  const isFts = (name: string) => FTS_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
    .map((row) => row.name);
  for (const table of KEPT_ARCHIVE_TABLES) {
    const keys = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all() as Array<{ table: string; from: string }>;
    const outside = keys.find((key) => !kept.has(key.table));
    if (outside) throw new Error(`kept table ${table} has a foreign key (${outside.from}) into ${outside.table}, which a rewrite empties`);
  }
  for (const table of tables) {
    if (kept.has(table) || isFts(table)) continue;
    db.exec(`DELETE FROM ${quoteIdent(table)}`);
  }
  for (const [table, columns] of Object.entries(UNREAD_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    for (const column of columns) {
      const col = info.find((c) => c.name === column);
      if (!col) continue;
      const value = col.notnull ? col.dflt_value : 'NULL';
      if (value === null) throw new Error(`cannot clear ${table}.${column}: it is NOT NULL and has no default`);
      db.exec(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ${value}`);
    }
  }
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function scalar(db: DatabaseSync, sql: string, ...args: string[]): unknown {
  const row = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

/**
 * Remove every row that still points at a removed parent row, one level per
 * round, until `PRAGMA foreign_key_check` is empty. This removes message
 * revisions, reactions, attachment rows, episode links, memory evidence, and
 * every other dependent row, whatever table holds it.
 */
function removeDependentRows(db: DatabaseSync): void {
  for (let round = 0; round < MAX_CASCADE_ROUNDS; round += 1) {
    const violations = db.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string; rowid: number | null }>;
    if (violations.length === 0) return;
    for (const v of violations) {
      if (v.rowid === null) throw new Error(`cannot remove a dependent row from ${v.table}: it has no rowid`);
      db.prepare(`DELETE FROM "${v.table.replaceAll('"', '""')}" WHERE rowid = ?`).run(v.rowid);
    }
  }
  throw new Error(`dependent rows remain after ${MAX_CASCADE_ROUNDS} cleanup rounds`);
}

/**
 * Delete every row that the archive can never serve: messages that fail the
 * servable rule, memories that fail it, the evidence of removed memories,
 * tombstones, channels with no servable message (unless they are the parent of
 * one), their access audits, and users that no kept row names. The servable
 * rule needs channel rows, access audits, and schema_migrations, so the keep
 * sets are computed before anything is deleted.
 */
function pruneNonServable(db: DatabaseSync, params: { redacted_messages: string; redacted_users: string }):
  { messages: number; memories: number; channels: number } {
  db.exec('CREATE TEMP TABLE keep_messages (id TEXT PRIMARY KEY)');
  db.exec('CREATE TEMP TABLE keep_memories (id TEXT PRIMARY KEY)');
  db.exec('CREATE TEMP TABLE keep_channels (id TEXT PRIMARY KEY)');
  db.prepare(`INSERT INTO keep_messages (id)
    SELECT m.id FROM messages m
      LEFT JOIN channels c ON c.id = m.channel_id
      LEFT JOIN channels p ON p.id = c.parent_id
     WHERE ${servableMessage('m', 'c', 'p')}`).run(params);
  db.prepare(`INSERT INTO keep_memories (id) SELECT mem.id FROM memories mem WHERE ${servableMemory('mem')}`).run(params);
  db.exec(`INSERT OR IGNORE INTO keep_channels (id)
    SELECT DISTINCT m.channel_id FROM messages m JOIN keep_messages k ON k.id = m.id`);
  db.exec(`INSERT OR IGNORE INTO keep_channels (id)
    SELECT DISTINCT c.parent_id FROM channels c JOIN keep_channels k ON k.id = c.id WHERE c.parent_id IS NOT NULL`);
  const memories = Number(db.prepare('DELETE FROM memories WHERE id NOT IN (SELECT id FROM keep_memories)').run().changes);
  db.exec('DELETE FROM memory_evidence WHERE memory_id NOT IN (SELECT id FROM keep_memories)');
  db.exec('DELETE FROM message_tombstones');
  const messages = Number(db.prepare('DELETE FROM messages WHERE id NOT IN (SELECT id FROM keep_messages)').run().changes);
  db.exec('DELETE FROM channel_access_audits WHERE channel_id NOT IN (SELECT id FROM keep_channels)');
  const channels = Number(db.prepare('DELETE FROM channels WHERE id NOT IN (SELECT id FROM keep_channels)').run().changes);
  db.exec(`DELETE FROM users WHERE id NOT IN (SELECT author_id FROM messages WHERE author_id IS NOT NULL)
    AND id NOT IN (SELECT owner_user_id FROM memories WHERE owner_user_id IS NOT NULL)`);
  db.exec('DROP TABLE keep_messages');
  db.exec('DROP TABLE keep_memories');
  db.exec('DROP TABLE keep_channels');
  return { messages, memories, channels };
}

/**
 * Copy the archive with `VACUUM INTO`, keep only the tables and columns that
 * the archive reads (see {@link KEPT_ARCHIVE_TABLES}), then remove the redacted messages, the
 * redacted users, every memory that cites a removed message or is owned by a
 * redacted user, their tombstones, and every dependent row. Rebuild the search
 * indexes, compact, check integrity, and move the copy into place.
 *
 * A memory that cites a removed message is removed even when it has other
 * evidence: its statement can carry the removed facts. The archive read rules
 * already hide such a memory.
 */
export function rewriteArchive(options: RewriteArchiveOptions): RewriteArchiveResult {
  rejectUnsafePath(options.outPath, '--out');
  const out = resolve(options.outPath);
  const tmp = `${out}.tmp`;
  if (out === resolve(options.archivePath)) throw new Error('the output path is the archive itself');
  if (existsSync(tmp)) throw new Error(`a temporary file already exists: ${tmp}`);
  // Reserve the output path atomically: the exclusive create fails when the
  // file exists, and nothing created at that path later can be overwritten
  // except this owner-only placeholder, which the final rename replaces.
  try {
    closeSync(openSync(out, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`the output file already exists: ${out}`);
    throw err;
  }

  const removeLeftovers = (): void => {
    for (const path of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`, out]) rmSync(path, { force: true });
  };

  let workspaceId: string;
  try {
    const source = new DatabaseSync(options.archivePath, { readOnly: true, allowExtension: false });
    try {
      const workspaces = source.prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>;
      if (workspaces.length !== 1) throw new Error(`expected exactly one workspace in the archive, found ${workspaces.length}`);
      workspaceId = workspaces[0]!.id;
      source.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
  } catch (err) {
    removeLeftovers();
    throw err;
  }

  try {
    const redactions = loadRedactions(options.liveDb, workspaceId);
    const copy = new DatabaseSync(tmp, { allowExtension: false });
    let removedMessages = 0;
    let removedMemories = 0;
    let prunedMessages = 0;
    let prunedMemories = 0;
    let prunedChannels = 0;
    try {
      copy.exec('PRAGMA foreign_keys = OFF');
      copy.exec('BEGIN IMMEDIATE');
      minimizeArchive(copy);
      const users = { users: JSON.stringify(redactions.userIds) };
      const both = { messages: JSON.stringify(redactions.messageIds), ...users };
      copy.exec('CREATE TEMP TABLE removed_messages (id TEXT PRIMARY KEY)');
      copy.prepare(`INSERT INTO removed_messages (id)
        SELECT id FROM messages
         WHERE id IN (SELECT value FROM json_each(:messages))
            OR author_id IN (SELECT value FROM json_each(:users))`).run(both);
      removedMessages = Number(scalar(copy, 'SELECT COUNT(*) FROM removed_messages'));
      removedMemories = Number(copy.prepare(`DELETE FROM memories
        WHERE owner_user_id IN (SELECT value FROM json_each(:users))
           OR id IN (SELECT ev.memory_id FROM memory_evidence ev JOIN removed_messages r ON r.id = ev.message_id)`).run(users).changes);
      copy.exec('DELETE FROM message_tombstones WHERE message_id IN (SELECT id FROM removed_messages)');
      copy.exec('DELETE FROM messages WHERE id IN (SELECT id FROM removed_messages)');
      copy.prepare('DELETE FROM users WHERE id IN (SELECT value FROM json_each(:users))').run(users);
      removeDependentRows(copy);
      if (!options.keepNonOrg) {
        const pruned = pruneNonServable(copy, { redacted_messages: both.messages, redacted_users: users.users });
        prunedMessages = pruned.messages;
        prunedMemories = pruned.memories;
        prunedChannels = pruned.channels;
        removeDependentRows(copy);
      }
      copy.exec('DROP TABLE removed_messages');
      copy.exec('COMMIT');
      copy.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
      copy.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
      copy.exec('VACUUM');
      const integrity = String(scalar(copy, 'PRAGMA integrity_check'));
      if (integrity !== 'ok') throw new Error(`integrity check of the rewritten archive failed: ${integrity.slice(0, 200)}`);
      if ((copy.prepare('PRAGMA foreign_key_check').all()).length > 0) throw new Error('the rewritten archive has foreign key violations');
    } finally {
      copy.close();
    }
    normalizeJournalMode(tmp);
    chmodSync(tmp, 0o600);
    renameSync(tmp, out);
    return { outPath: out, sha256: sha256Of(out), removedMessages, removedMemories, prunedMessages, prunedMemories, prunedChannels };
  } catch (err) {
    removeLeftovers();
    throw err;
  }
}
