// ABOUTME: Writes a new copy of the read-only platform archive without the redacted rows (plan 011 step 10).
// ABOUTME: The source archive is never opened for writing; redaction rows stay in the live database and keep applying.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeJournalMode } from '../db/backup.js';
import { loadRedactions } from './redactions.js';

export interface RewriteArchiveOptions {
  /** The current archive file. Read only. */
  archivePath: string;
  /** Where the new archive goes. Must not exist. */
  outPath: string;
  /** The live database that holds `archive_redactions`. */
  liveDb: DatabaseSync;
}

export interface RewriteArchiveResult {
  outPath: string;
  sha256: string;
  removedMessages: number;
  removedMemories: number;
}

/** Bound on the foreign-key cleanup rounds; each round removes one level of dependent rows. */
const MAX_CASCADE_ROUNDS = 20;

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
 * Copy the archive with `VACUUM INTO`, then remove the redacted messages, the
 * redacted users, every memory that cites a removed message or is owned by a
 * redacted user, their tombstones, and every dependent row. Rebuild the search
 * indexes, compact, check integrity, and move the copy into place.
 *
 * A memory that cites a removed message is removed even when it has other
 * evidence: its statement can carry the removed facts. The archive read rules
 * already hide such a memory.
 */
export function rewriteArchive(options: RewriteArchiveOptions): RewriteArchiveResult {
  const out = resolve(options.outPath);
  const tmp = `${out}.tmp`;
  if (existsSync(out)) throw new Error(`the output file already exists: ${out}`);
  if (out === resolve(options.archivePath)) throw new Error('the output path is the archive itself');
  if (existsSync(tmp)) throw new Error(`a temporary file already exists: ${tmp}`);

  const source = new DatabaseSync(options.archivePath, { readOnly: true, allowExtension: false });
  let workspaceId: string;
  try {
    const workspaces = source.prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>;
    if (workspaces.length !== 1) throw new Error(`expected exactly one workspace in the archive, found ${workspaces.length}`);
    workspaceId = workspaces[0]!.id;
    source.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }

  try {
    const redactions = loadRedactions(options.liveDb, workspaceId);
    const copy = new DatabaseSync(tmp, { allowExtension: false });
    let removedMessages = 0;
    let removedMemories = 0;
    try {
      copy.exec('PRAGMA foreign_keys = OFF');
      copy.exec('BEGIN IMMEDIATE');
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
    renameSync(tmp, out);
    return { outPath: out, sha256: sha256Of(out), removedMessages, removedMemories };
  } catch (err) {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}-journal`, { force: true });
    throw err;
  }
}
