import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, getPragma, transaction } from '../../src/db/database.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

let dbs: TestDb[] = [];
afterEach(() => {
  for (const t of dbs) t.cleanup();
  dbs = [];
});

describe('database', () => {
  it('applies the canonical pragmas (Section 28)', () => {
    const t = createTestDb();
    dbs.push(t);
    expect(getPragma(t.db, 'foreign_keys')).toBe(1);
    expect(getPragma(t.db, 'journal_mode')).toBe('wal');
    expect(getPragma(t.db, 'synchronous')).toBe(1); // NORMAL
    expect(getPragma(t.db, 'busy_timeout')).toBe(5000);
    expect(getPragma(t.db, 'trusted_schema')).toBe(0);
    expect(getPragma(t.db, 'temp_store')).toBe(2); // MEMORY
  });

  it('enforces foreign keys', () => {
    const t = createTestDb();
    dbs.push(t);
    // Inserting a message into a non-existent channel must fail.
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO messages (id, workspace_id, channel_id, author_display_name, content, created_at_ms, ingested_at_ms, updated_at_ms)
           VALUES ('m1','999999999999999999','999999999999999998','x','',1,1,1)`,
        )
        .run(),
    ).toThrow();
  });

  it('rolls back a transaction on throw and commits on success', () => {
    const t = createTestDb();
    dbs.push(t);
    const { guildId } = { guildId: '100000000000000001' };
    const insert = t.db.prepare(
      "INSERT INTO workspaces (id, name, discovered_at_ms, updated_at_ms) VALUES (?,?,1,1)",
    );

    expect(() =>
      transaction(t.db, () => {
        insert.run(guildId, 'Will Rollback');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(t.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(guildId)).toBeUndefined();

    transaction(t.db, () => {
      insert.run(guildId, 'Committed');
    });
    const row = t.db.prepare('SELECT name FROM workspaces WHERE id = ?').get(guildId) as
      | { name: string }
      | undefined;
    expect(row?.name).toBe('Committed');
  });

  it('provides exactly one connection handle', () => {
    const t = createTestDb();
    dbs.push(t);
    expect(t.db).toBeInstanceOf(DatabaseSync);
  });

  it('opens read-only when requested (and db must exist)', () => {
    const t = createTestDb();
    dbs.push(t);
    const ro = openDatabase(t.path, { readOnly: true });
    dbs.push({ db: ro, path: t.path, dir: t.dir, cleanup: () => ro.close() });
    expect(() => ro.prepare("INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('z','z',1,1)").run()).toThrow();
  });
});
