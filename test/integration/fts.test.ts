import { describe, it, expect } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';

function insertMessage(db: TestDb['db'], id: string, content: string, author = 'Alice'): void {
  const { guildId, channelId } = seedIdentity(db);
  db.prepare(
    `INSERT INTO messages (id, workspace_id, channel_id, author_display_name, content, created_at_ms, ingested_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,1,1,1)`,
  ).run(id, guildId, channelId, author, content);
}

function ftsMessageCount(db: TestDb['db']): number {
  const row = db.prepare('SELECT count(*) AS n FROM messages_fts').get() as { n: number };
  return row.n;
}

function ftsMatches(db: TestDb['db'], term: string): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?')
    .get(term) as { n: number };
  return row.n;
}

describe('message FTS index and triggers', () => {
  it('indexes live messages and keeps tombstones out', () => {
    const t = createTestDb();
    insertMessage(t.db, 'm1', 'ship the onboarding trial');
    expect(ftsMessageCount(t.db)).toBe(1);
    expect(ftsMatches(t.db, 'onboarding')).toBe(1);

    // Tombstone removes from search.
    t.db.prepare('UPDATE messages SET deleted_at_ms = 5000, updated_at_ms = 5000 WHERE id = ?').run('m1');
    expect(ftsMatches(t.db, 'onboarding')).toBe(0);
    t.cleanup();
  });

  it('re-indexes a restored message', () => {
    const t = createTestDb();
    insertMessage(t.db, 'm1', 'decided to launch friday');
    t.db.prepare('UPDATE messages SET deleted_at_ms = 1 WHERE id = ?').run('m1');
    expect(ftsMatches(t.db, 'friday')).toBe(0);
    t.db.prepare('UPDATE messages SET deleted_at_ms = NULL WHERE id = ?').run('m1');
    expect(ftsMatches(t.db, 'friday')).toBe(1);
    t.cleanup();
  });

  it('updates the index on edit', () => {
    const t = createTestDb();
    insertMessage(t.db, 'm1', 'old wording about alpha');
    expect(ftsMatches(t.db, 'alpha')).toBe(1);
    expect(ftsMatches(t.db, 'omega')).toBe(0);
    t.db.prepare("UPDATE messages SET content = 'new wording about omega' WHERE id = ?").run('m1');
    expect(ftsMatches(t.db, 'alpha')).toBe(0);
    expect(ftsMatches(t.db, 'omega')).toBe(1);
    t.cleanup();
  });

  it('removes the row on hard delete', () => {
    const t = createTestDb();
    insertMessage(t.db, 'm1', 'temporary note');
    t.db.prepare('DELETE FROM messages WHERE id = ?').run('m1');
    expect(ftsMatches(t.db, 'temporary')).toBe(0);
    t.cleanup();
  });

  it('stays consistent after an unchanged-field reconciliation update', () => {
    // An update that touches only a non-indexed column still leaves exactly one
    // correct FTS row. (Avoiding the trigger entirely is the repository's job.)
    const t = createTestDb();
    insertMessage(t.db, 'm1', 'stable content keyword');
    t.db.prepare('UPDATE messages SET updated_at_ms = 9000 WHERE id = ?').run('m1');
    expect(ftsMessageCount(t.db)).toBe(1);
    expect(ftsMatches(t.db, 'keyword')).toBe(1);
    t.cleanup();
  });
});

describe('memory FTS index and triggers', () => {
  function insertMemory(db: TestDb['db'], id: string, statement: string): void {
    const { guildId } = seedIdentity(db);
    db.prepare(
      `INSERT INTO memories (id, workspace_id, scope_type, type, statement, confidence, importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,0.8,0.5,1,1,1,1)`,
    ).run(id, guildId, 'org', 'decision', statement);
  }

  it('indexes, updates, and deletes memory statements', () => {
    const t = createTestDb();
    insertMemory(t.db, 'mem1', 'we will adopt the new cache policy');
    expect(
      (t.db.prepare('SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?').get('cache') as { n: number }).n,
    ).toBe(1);

    t.db.prepare("UPDATE memories SET statement = 'we will adopt the new queue policy' WHERE id = ?").run('mem1');
    expect(
      (t.db.prepare('SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?').get('cache') as { n: number }).n,
    ).toBe(0);
    expect(
      (t.db.prepare('SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?').get('queue') as { n: number }).n,
    ).toBe(1);

    t.db.prepare('DELETE FROM memories WHERE id = ?').run('mem1');
    expect(
      (t.db.prepare('SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?').get('queue') as { n: number }).n,
    ).toBe(0);
    t.cleanup();
  });
});
