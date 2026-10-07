// ABOUTME: Tests that archive test channels stay hidden under both product names (plan 011, PR #17 review).
// ABOUTME: Before v2.0.0 the test channels were named "cassandra-*"; the archive treats both names as test surfaces.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { ARCHIVE_AUTHOR, ARCHIVE_GUILD, ARCHIVE_MESSAGES, ARCHIVE_NOW, createArchiveFixture, type ArchiveFixture } from '../../helpers/archive.js';
import { openArchiveDatabase, verifyArchive } from '../../../src/platform-archive/database.js';
import { createArchiveReader, searchArchiveMessages, type ArchiveReader } from '../../../src/platform-archive/read.js';

const CASSANDRA_TEST = '300000000000000040';
const CASSANDRA_REVIEW = '300000000000000041';
const THREAD_UNDER_CASSANDRA = '300000000000000042';
const MESSAGES = {
  cassandraTest: '300000000000000140',
  cassandraReview: '300000000000000141',
  threadUnderCassandra: '300000000000000142',
} as const;

let fixture: ArchiveFixture | undefined;
let live: TestDb | undefined;
let archiveDb: DatabaseSync | undefined;
afterEach(() => {
  try { archiveDb?.close(); } catch { /* already closed */ }
  archiveDb = undefined;
  fixture?.cleanup();
  fixture = undefined;
  live?.cleanup();
  live = undefined;
});

function channel(db: DatabaseSync, id: string, name: string, parentId: string | null): void {
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, kind, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, 'org', 0, ?, ?)`,
  ).run(id, ARCHIVE_GUILD, parentId, parentId ? 'thread' : 'text', name, parentId ? 1 : 0, ARCHIVE_NOW, ARCHIVE_NOW);
}

function message(db: DatabaseSync, id: string, channelId: string): void {
  db.prepare(
    `INSERT INTO messages (id, workspace_id, channel_id, author_id, author_display_name, content,
       created_at_ms, ingested_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'Archive Author', 'test surface billing decision', ?, ?, ?)`,
  ).run(id, ARCHIVE_GUILD, channelId, ARCHIVE_AUTHOR, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
}

function setup(): ArchiveReader {
  fixture = createArchiveFixture({
    mutate: (db) => {
      channel(db, CASSANDRA_TEST, 'cassandra-test', null);
      channel(db, CASSANDRA_REVIEW, 'Cassandra-Review', null);
      channel(db, THREAD_UNDER_CASSANDRA, 'ordinary-thread', CASSANDRA_TEST);
      message(db, MESSAGES.cassandraTest, CASSANDRA_TEST);
      message(db, MESSAGES.cassandraReview, CASSANDRA_REVIEW);
      message(db, MESSAGES.threadUnderCassandra, THREAD_UNDER_CASSANDRA);
    },
  });
  live = createTestDb();
  archiveDb = openArchiveDatabase(fixture.path);
  const summary = verifyArchive(archiveDb, fixture.path, { platform: 'discord', newestSchemaVersion: 1_000 });
  return createArchiveReader({ db: archiveDb, liveDb: live.db, summary });
}

describe('archive test surfaces', () => {
  it('hides channels named like the old Cassandra test channels, in any case', () => {
    const ids = searchArchiveMessages(setup(), { query: 'billing decision', limit: 50 }).map((r) => r.messageId);
    expect(ids).not.toContain(MESSAGES.cassandraTest);
    expect(ids).not.toContain(MESSAGES.cassandraReview);
  });

  it('hides a thread below an old Cassandra test channel', () => {
    const ids = searchArchiveMessages(setup(), { query: 'billing decision', limit: 50 }).map((r) => r.messageId);
    expect(ids).not.toContain(MESSAGES.threadUnderCassandra);
  });

  it('still hides Mneme test channels and serves ordinary org channels', () => {
    const ids = searchArchiveMessages(setup(), { query: 'billing decision', limit: 50 }).map((r) => r.messageId);
    expect(ids).not.toContain(ARCHIVE_MESSAGES.testSurface);
    expect(ids).toContain(ARCHIVE_MESSAGES.org);
    expect(ids).toContain(ARCHIVE_MESSAGES.orgThread);
  });
});
