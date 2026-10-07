// ABOUTME: Tests the offline archive rewrite (plan 011 step 10): a new file without redacted rows and their dependents.
// ABOUTME: The source archive never changes, the output passes verification, and redaction rows stay in the live database.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { ARCHIVE_AUTHOR, ARCHIVE_GUILD, ARCHIVE_MEMORIES, ARCHIVE_MESSAGES, ARCHIVE_NOW, createArchiveFixture, type ArchiveFixture } from '../../helpers/archive.js';
import { openArchiveDatabase, verifyArchive } from '../../../src/platform-archive/database.js';
import { rewriteArchive } from '../../../src/platform-archive/rewrite.js';
import { runCli, CLI_FAIL, CLI_OK, CLI_USAGE } from '../../../src/cli/commands.js';
import { openDatabase } from '../../../src/db/database.js';

let live: TestDb;
let fixture: ArchiveFixture;

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function redact(kind: 'message' | 'user', targetId: string): void {
  live.db.prepare(`INSERT INTO archive_redactions (id, archive_workspace_id, target_kind, target_id, archive_sha256, created_at_ms)
    VALUES (?, ?, ?, ?, 'audit-only', ?)`).run(`r-${kind}-${targetId}`, ARCHIVE_GUILD, kind, targetId, ARCHIVE_NOW);
}

function addDependents(db: DatabaseSync): void {
  const id = ARCHIVE_MESSAGES.org;
  db.prepare('INSERT INTO message_versions (message_id, version, content, observed_at_ms) VALUES (?, 1, ?, ?)').run(id, 'older org text', ARCHIVE_NOW);
  db.prepare('INSERT INTO reactions (message_id, user_id, emoji_key, created_at_ms) VALUES (?, ?, ?, ?)').run(id, ARCHIVE_AUTHOR, 'thumbs', ARCHIVE_NOW);
  db.prepare('INSERT INTO reaction_counts (message_id, emoji_key, count, updated_at_ms) VALUES (?, ?, 1, ?)').run(id, 'thumbs', ARCHIVE_NOW);
  db.prepare('INSERT INTO attachments (id, message_id, filename, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)').run('att-1', id, 'plan.pdf', ARCHIVE_NOW, ARCHIVE_NOW);
  db.prepare('INSERT INTO message_tombstones (message_id, channel_id, workspace_id, deleted_at_ms, created_at_ms) VALUES (?, NULL, NULL, ?, ?)').run(id, ARCHIVE_NOW, ARCHIVE_NOW);
}

function count(db: DatabaseSync, sql: string, ...args: string[]): number {
  return Number(db.prepare(sql).get(...args)?.n ?? 0);
}

beforeEach(() => {
  live = createTestDb();
  fixture = createArchiveFixture({ mutate: addDependents });
});

afterEach(() => {
  fixture.cleanup();
  live.cleanup();
});

describe('archive rewrite', () => {
  it('writes a verified copy without a redacted message, its dependents, and memories that cite it', () => {
    redact('message', ARCHIVE_MESSAGES.org);
    const before = sha(fixture.path);
    const out = join(fixture.dir, 'rewritten.sqlite');
    const result = rewriteArchive({ archivePath: fixture.path, outPath: out, liveDb: live.db });

    expect(sha(fixture.path)).toBe(before);
    expect(existsSync(`${out}.tmp`)).toBe(false);
    expect(result).toMatchObject({ outPath: out, sha256: sha(out), removedMessages: 1 });
    expect(result.removedMemories).toBeGreaterThanOrEqual(1);

    const db = openArchiveDatabase(out);
    try {
      expect(() => verifyArchive(db, out, { platform: 'discord', newestSchemaVersion: 1_000 })).not.toThrow();
      const id = ARCHIVE_MESSAGES.org;
      expect(count(db, 'SELECT count(*) AS n FROM messages WHERE id = ?', id)).toBe(0);
      for (const table of ['message_versions', 'reactions', 'reaction_counts', 'attachments', 'message_tombstones', 'memory_evidence']) {
        expect(count(db, `SELECT count(*) AS n FROM ${table} WHERE message_id = ?`, id)).toBe(0);
      }
      expect(count(db, 'SELECT count(*) AS n FROM memories WHERE id = ?', ARCHIVE_MEMORIES.org)).toBe(0);
      expect(count(db, "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'org'")).toBe(0);
      expect(count(db, 'SELECT count(*) AS n FROM messages WHERE id = ?', ARCHIVE_MESSAGES.orgThread)).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(String(db.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('delete');
    } finally {
      db.close();
    }
    expect(count(live.db, 'SELECT count(*) AS n FROM archive_redactions')).toBe(1);
  });

  it('removes every message, memory, and the user row for a redacted user', () => {
    redact('user', ARCHIVE_AUTHOR);
    const out = join(fixture.dir, 'rewritten-user.sqlite');
    rewriteArchive({ archivePath: fixture.path, outPath: out, liveDb: live.db });
    const db = openArchiveDatabase(out);
    try {
      expect(count(db, 'SELECT count(*) AS n FROM messages WHERE author_id = ?', ARCHIVE_AUTHOR)).toBe(0);
      expect(count(db, 'SELECT count(*) AS n FROM users WHERE id = ?', ARCHIVE_AUTHOR)).toBe(0);
      expect(count(db, 'SELECT count(*) AS n FROM memories')).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses an existing output file and the archive path itself', () => {
    const taken = join(fixture.dir, 'taken.sqlite');
    writeFileSync(taken, 'x');
    expect(() => rewriteArchive({ archivePath: fixture.path, outPath: taken, liveDb: live.db })).toThrow(/already exists/);
    expect(() => rewriteArchive({ archivePath: fixture.path, outPath: fixture.path, liveDb: live.db })).toThrow(/already exists|archive itself/);
  });
});

describe('archive-rewrite CLI', () => {
  function deps(archivePath: string | undefined, lines: string[]) {
    return {
      config: { dataDir: live.dir, databasePath: live.path, backupDir: join(live.dir, 'backups'), ...(archivePath ? { archivePath } : {}) },
      openDb: (path: string) => openDatabase(path),
      stdout: { write: (chunk: string) => { lines.push(chunk); } },
      log: { error: () => undefined },
    };
  }

  it('writes the copy and prints its sha256', async () => {
    redact('message', ARCHIVE_MESSAGES.org);
    const lines: string[] = [];
    const out = join(fixture.dir, 'cli.sqlite');
    expect(await runCli(['archive-rewrite', '--out', out], deps(fixture.path, lines))).toBe(CLI_OK);
    expect(lines.join('')).toContain(sha(out));
  });

  it('needs --out and a configured archive', async () => {
    expect(await runCli(['archive-rewrite'], deps(fixture.path, []))).toBe(CLI_USAGE);
    expect(await runCli(['archive-rewrite', '--out', join(fixture.dir, 'x.sqlite')], deps(undefined, []))).toBe(CLI_FAIL);
  });
});
