// ABOUTME: Tests the read-only archive opener and the startup verification (plan 011 step 2).
// ABOUTME: Every write fails; a wrong, broken, or unknown archive stops startup with a clear error.
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openArchiveDatabase, verifyArchive, ARCHIVE_MIN_SCHEMA_VERSION } from '../../../src/platform-archive/database.js';
import { ARCHIVE_GUILD, createArchiveFixture, type ArchiveFixture } from '../../helpers/archive.js';

let fixture: ArchiveFixture | undefined;
let open: DatabaseSync | undefined;
afterEach(() => {
  try { open?.close(); } catch { /* already closed */ }
  open = undefined;
  fixture?.cleanup();
  fixture = undefined;
});

function newestSchema(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
  } finally {
    db.close();
  }
}

describe('openArchiveDatabase', () => {
  it.each([
    ['INSERT', "INSERT INTO workspaces (id, name, joined_at_ms, discovered_at_ms, updated_at_ms) VALUES ('x', 'x', 1, 1, 1)"],
    ['UPDATE', "UPDATE channels SET visibility_class = 'org'"],
    ['DELETE', 'DELETE FROM messages'],
    ['CREATE TEMP TABLE', 'CREATE TEMP TABLE scratch (x)'],
    ['PRAGMA user_version', 'PRAGMA user_version = 1'],
  ])('refuses %s', (_name, sql) => {
    fixture = createArchiveFixture();
    open = openArchiveDatabase(fixture.path);
    expect(() => open!.exec(sql)).toThrow();
  });

  it('does not change the archive file', () => {
    fixture = createArchiveFixture();
    const before = createHash('sha256').update(readFileSync(fixture.path)).digest('hex');
    open = openArchiveDatabase(fixture.path);
    verifyArchive(open, fixture.path, { platform: 'discord', newestSchemaVersion: newestSchema(fixture.path) });
    try { open.exec('DELETE FROM messages'); } catch { /* refused */ }
    open.close();
    open = undefined;
    expect(createHash('sha256').update(readFileSync(fixture.path)).digest('hex')).toBe(before);
  });

  it('fails clearly when the file does not exist', () => {
    expect(() => openArchiveDatabase('/nonexistent/archive.sqlite')).toThrow(/archive/i);
  });
});

describe('verifyArchive', () => {
  it('returns the archive summary', () => {
    fixture = createArchiveFixture();
    open = openArchiveDatabase(fixture.path);
    const newest = newestSchema(fixture.path);
    const summary = verifyArchive(open, fixture.path, { platform: 'discord', newestSchemaVersion: newest });
    expect(summary).toMatchObject({
      platform: 'discord',
      workspaceId: ARCHIVE_GUILD,
      schemaVersion: newest,
      sha256: createHash('sha256').update(readFileSync(fixture.path)).digest('hex'),
    });
    expect(summary.sizeBytes).toBe(readFileSync(fixture.path).length);
    // Org channel, org thread: 2 org messages. The test surface, restricted thread, and boundary channel do not count.
    expect(summary.orgMessages).toBe(2);
    // Only the active org memory counts.
    expect(summary.orgMemories).toBe(1);
  });

  it('refuses a schema older than the minimum', () => {
    fixture = createArchiveFixture({
      mutate: (db) => db.prepare('DELETE FROM schema_migrations WHERE version >= ?').run(ARCHIVE_MIN_SCHEMA_VERSION),
    });
    open = openArchiveDatabase(fixture.path);
    expect(() => verifyArchive(open!, fixture!.path, { platform: 'discord', newestSchemaVersion: 999 })).toThrow(/schema/i);
  });

  it('refuses a schema newer than this release knows', () => {
    fixture = createArchiveFixture();
    open = openArchiveDatabase(fixture.path);
    const newest = newestSchema(fixture.path);
    expect(() => verifyArchive(open!, fixture!.path, { platform: 'discord', newestSchemaVersion: newest - 1 })).toThrow(/schema/i);
  });

  it.each([
    ['no workspace', (db: DatabaseSync) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('DELETE FROM workspaces');
    }],
    ['two workspaces', (db: DatabaseSync) => {
      db.prepare('INSERT INTO workspaces (id, name, joined_at_ms, discovered_at_ms, updated_at_ms) VALUES (?, ?, 1, 1, 1)')
        .run('300000000000000099', 'Second');
    }],
  ])('refuses an archive with %s', (_name, mutate) => {
    fixture = createArchiveFixture({ mutate });
    open = openArchiveDatabase(fixture.path);
    expect(() => verifyArchive(open!, fixture!.path, { platform: 'discord', newestSchemaVersion: newestSchema(fixture!.path) }))
      .toThrow(/workspace/i);
  });

  it('refuses a workspace id of another platform', () => {
    fixture = createArchiveFixture();
    open = openArchiveDatabase(fixture.path);
    expect(() => verifyArchive(open!, fixture!.path, { platform: 'slack', newestSchemaVersion: newestSchema(fixture!.path) }))
      .toThrow(/workspace id/i);
  });

  it('refuses a corrupt file', () => {
    fixture = createArchiveFixture();
    const bytes = readFileSync(fixture.path);
    // Overwrite pages after the header with noise; the header stays valid so the file still opens.
    for (let i = 4096; i < bytes.length; i += 97) bytes[i] = (bytes[i]! + 101) % 256;
    writeFileSync(fixture.path, bytes);
    expect(() => {
      open = openArchiveDatabase(fixture!.path);
      verifyArchive(open, fixture!.path, { platform: 'discord', newestSchemaVersion: 999 });
    }).toThrow();
  });

  it('refuses a file in WAL journal mode (a hot copy, not a backup)', () => {
    fixture = createArchiveFixture();
    const rw = new DatabaseSync(fixture.path);
    rw.exec('PRAGMA journal_mode = WAL');
    rw.close();
    expect(() => {
      open = openArchiveDatabase(fixture!.path);
      verifyArchive(open, fixture!.path, { platform: 'discord', newestSchemaVersion: 999 });
    }).toThrow(/backup/i);
  });
});
