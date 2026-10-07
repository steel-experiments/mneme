// ABOUTME: Tests the offline archive rewrite (plan 011 step 10): a new file without redacted rows and their dependents.
// ABOUTME: The source archive never changes, the output passes verification, and redaction rows stay in the live database.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { ARCHIVE_AUTHOR, ARCHIVE_CHANNELS, ARCHIVE_GUILD, ARCHIVE_MEMORIES, ARCHIVE_MESSAGES, ARCHIVE_NOW, createArchiveFixture, type ArchiveFixture } from '../../helpers/archive.js';
import { openArchiveDatabase, verifyArchive } from '../../../src/platform-archive/database.js';
import { KEPT_ARCHIVE_TABLES, rewriteArchive } from '../../../src/platform-archive/rewrite.js';
import { createArchiveReader, searchArchiveMessages } from '../../../src/platform-archive/read.js';
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

const SECRET = 'zebra-quartz-secret-7731';

/** Put the secret into tables and columns that the archive never reads. */
function plantSecrets(db: DatabaseSync): void {
  addDependents(db);
  const org = ARCHIVE_CHANNELS.org;
  db.prepare(`INSERT INTO episodes (id, workspace_id, conversation_channel_id, status, started_at_ms, last_activity_at_ms,
      created_at_ms, updated_at_ms, summary) VALUES ('ep-secret', ?, ?, 'reviewed', ?, ?, ?, ?, ?)`)
    .run(ARCHIVE_GUILD, org, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW, SECRET);
  db.prepare(`INSERT INTO agent_runs (id, workspace_id, run_type, prompt_version, provider, model, status, started_at_ms, error)
      VALUES ('run-secret', ?, 'direct_answer', 'v', 'openai', 'm', 'failed', ?, ?)`).run(ARCHIVE_GUILD, ARCHIVE_NOW, SECRET);
  db.prepare(`INSERT INTO outbox (id, channel_id, content, dedupe_key, next_attempt_at_ms, created_at_ms, updated_at_ms)
      VALUES ('out-secret', ?, ?, 'dedupe-secret', ?, ?, ?)`).run(org, SECRET, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
  db.prepare(`INSERT INTO jobs (id, type, payload_json, run_after_ms, created_at_ms, updated_at_ms)
      VALUES ('job-secret', 'probe', ?, ?, ?, ?)`).run(JSON.stringify({ text: SECRET }), ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
  db.prepare(`INSERT INTO admin_events (id, workspace_id, actor_user_id, action, details_json, created_at_ms)
      VALUES ('admin-secret', ?, ?, 'probe', ?, ?)`).run(ARCHIVE_GUILD, ARCHIVE_AUTHOR, JSON.stringify({ text: SECRET }), ARCHIVE_NOW);
  const json = JSON.stringify({ quoted: SECRET });
  db.prepare('UPDATE messages SET raw_json = ?, embeds_json = ?, mentions_json = ?, components_json = ?, poll_json = ?')
    .run(json, json, json, json, json);
  db.prepare('UPDATE channels SET raw_json = ?, last_message_id = ?').run(json, SECRET);
  db.prepare('UPDATE users SET raw_json = ?').run(json);
  db.prepare('UPDATE workspaces SET raw_json = ?, owner_id = ?').run(json, SECRET);
  db.prepare('UPDATE memories SET metadata_json = ?').run(json);
  db.prepare('UPDATE memory_evidence SET note = ?').run(SECRET);
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

  it('keeps only what the archive serves: no copy of other tables or unread columns survives in the file', () => {
    fixture.cleanup();
    fixture = createArchiveFixture({ mutate: plantSecrets });
    expect(readFileSync(fixture.path).includes(SECRET)).toBe(true);
    const out = join(fixture.dir, 'minimized.sqlite');
    rewriteArchive({ archivePath: fixture.path, outPath: out, liveDb: live.db });

    expect(readFileSync(out).includes(SECRET)).toBe(false);
    const db = openArchiveDatabase(out);
    try {
      const summary = verifyArchive(db, out, { platform: 'discord', newestSchemaVersion: 1_000 });
      const reader = createArchiveReader({ db, liveDb: live.db, summary });
      const served = searchArchiveMessages(reader, { query: 'billing decision', limit: 50 }).map((row) => row.messageId);
      // The org message itself carries a tombstone from addDependents, so it is not served; its thread sibling is.
      expect(served.some((id) => id.endsWith(ARCHIVE_MESSAGES.orgThread))).toBe(true);
      const kept = new Set<string>(KEPT_ARCHIVE_TABLES);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
        .map((r) => r.name)
        .filter((name) => !kept.has(name) && !name.startsWith('messages_fts') && !name.startsWith('memories_fts'));
      expect(tables.length).toBeGreaterThan(20);
      for (const table of tables) expect(count(db, `SELECT count(*) AS n FROM "${table}"`), table).toBe(0);
      // The org message carries a tombstone (addDependents), so it and the memory
      // that cites it are not servable and are dropped; the org thread stays.
      expect(count(db, 'SELECT count(*) AS n FROM messages WHERE id = ?', ARCHIVE_MESSAGES.orgThread)).toBe(1);
      expect(count(db, 'SELECT count(*) AS n FROM messages WHERE id = ?', ARCHIVE_MESSAGES.org)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('drops content that the archive never serves, unless --keep-non-org is set', () => {
    const NON_ORG = 'otter-basalt-nonorg-4419';
    fixture.cleanup();
    fixture = createArchiveFixture({
      mutate: (db) => {
        for (const role of ['restricted', 'reviewOnly', 'excluded', 'testSurface', 'restrictedThread', 'boundary'] as const) {
          db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(`${NON_ORG} ${role}`, ARCHIVE_MESSAGES[role]);
        }
        db.prepare('UPDATE memories SET statement = ? WHERE id IN (?, ?, ?)')
          .run(NON_ORG, ARCHIVE_MEMORIES.channel, ARCHIVE_MEMORIES.reviewOnly, ARCHIVE_MEMORIES.superseded);
        db.prepare("UPDATE channels SET topic = ? WHERE id IN (?, ?)").run(NON_ORG, ARCHIVE_CHANNELS.restricted, ARCHIVE_CHANNELS.excluded);
      },
    });
    const servedFrom = (path: string): string[] => {
      const db = openArchiveDatabase(path);
      try {
        const summary = verifyArchive(db, path, { platform: 'discord', newestSchemaVersion: 1_000 });
        const reader = createArchiveReader({ db, liveDb: live.db, summary });
        return searchArchiveMessages(reader, { query: 'billing decision', limit: 50 }).map((row) => row.messageId).sort();
      } finally {
        db.close();
      }
    };
    const before = servedFrom(fixture.path);
    expect(before.length).toBeGreaterThan(0);

    const strict = join(fixture.dir, 'strict.sqlite');
    rewriteArchive({ archivePath: fixture.path, outPath: strict, liveDb: live.db });
    expect(readFileSync(strict).includes(NON_ORG)).toBe(false);
    expect(servedFrom(strict)).toEqual(before);
    const db = openArchiveDatabase(strict);
    try {
      const summary = verifyArchive(db, strict, { platform: 'discord', newestSchemaVersion: 1_000 });
      expect(summary.hiddenLegacyThreads).toBe(0);
      expect(count(db, 'SELECT count(*) AS n FROM memories WHERE id = ?', ARCHIVE_MEMORIES.org)).toBe(1);
      expect(count(db, 'SELECT count(*) AS n FROM channels WHERE id = ?', ARCHIVE_CHANNELS.restricted)).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }

    const wide = join(fixture.dir, 'wide.sqlite');
    rewriteArchive({ archivePath: fixture.path, outPath: wide, liveDb: live.db, keepNonOrg: true });
    expect(readFileSync(wide).includes(NON_ORG)).toBe(true);
    expect(servedFrom(wide)).toEqual(before);
  });

  it('writes the output readable by its owner only', () => {
    const out = join(fixture.dir, 'private.sqlite');
    rewriteArchive({ archivePath: fixture.path, outPath: out, liveDb: live.db });
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('refuses an output path with parent-directory segments', () => {
    const out = `${fixture.dir}/../escape.sqlite`;
    expect(() => rewriteArchive({ archivePath: fixture.path, outPath: out, liveDb: live.db })).toThrow(/parent-directory/);
  });

  it('leaves no output, temporary, or journal files behind when the rewrite fails', () => {
    const out = join(fixture.dir, 'failed.sqlite');
    const noRedactionTable = new DatabaseSync(':memory:');
    try {
      expect(() => rewriteArchive({ archivePath: fixture.path, outPath: out, liveDb: noRedactionTable })).toThrow();
    } finally {
      noRedactionTable.close();
    }
    expect(readdirSync(fixture.dir).filter((name) => name.startsWith('failed.sqlite'))).toEqual([]);
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
