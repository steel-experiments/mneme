// ABOUTME: Tests that archive threads last seen before migration 045 stay hidden (plan 011, PR #17 review).
// ABOUTME: Their private flag was never set, so a frozen archive cannot prove that they are not private threads.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { ARCHIVE_AUTHOR, ARCHIVE_CHANNELS, ARCHIVE_GUILD, ARCHIVE_NOW, createArchiveFixture, type ArchiveFixture } from '../../helpers/archive.js';
import { openArchiveDatabase, verifyArchive } from '../../../src/platform-archive/database.js';
import {
  createArchiveReader,
  getArchiveMemoryEvidence,
  getArchiveMessageContext,
  searchArchiveMemories,
  searchArchiveMessages,
  type ArchiveReader,
} from '../../../src/platform-archive/read.js';
import type { ArchiveSummary } from '../../../src/platform-archive/database.js';

/** When migration 045 (the private-thread flag) was applied in the archive's source database. */
const T45 = ARCHIVE_NOW - 1_000;
const DAY = 86_400_000;
const LEGACY_THREAD = '300000000000000030';
const LEGACY_MESSAGE = '300000000000000130';
const REOBSERVED_THREAD = '300000000000000031';
const REOBSERVED_MESSAGE = '300000000000000131';
const LEGACY_MEMORY = 'archive-memory-legacy-thread';

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

function thread(db: DatabaseSync, id: string, discoveredAtMs: number): void {
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, kind, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms, is_private_thread)
     VALUES (?, ?, ?, 'thread', ?, 1, 1, 0, 1, 'org', 0, ?, ?, 0)`,
  ).run(id, ARCHIVE_GUILD, ARCHIVE_CHANNELS.org, `thread-${id}`, discoveredAtMs, discoveredAtMs);
}

function message(db: DatabaseSync, id: string, channelId: string): void {
  db.prepare(
    `INSERT INTO messages (id, workspace_id, channel_id, author_id, author_display_name, content,
       created_at_ms, ingested_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'Archive Author', 'legacy thread billing decision', ?, ?, ?)`,
  ).run(id, ARCHIVE_GUILD, channelId, ARCHIVE_AUTHOR, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
}

function seed(db: DatabaseSync): void {
  db.prepare('UPDATE schema_migrations SET applied_at_ms = ? WHERE version = 45').run(T45);
  // Seen only before 045: the private flag was never written for this row.
  thread(db, LEGACY_THREAD, T45 - DAY);
  message(db, LEGACY_MESSAGE, LEGACY_THREAD);
  // Created before 045, but discovery observed it again afterwards and wrote the flag.
  thread(db, REOBSERVED_THREAD, T45 - DAY);
  message(db, REOBSERVED_MESSAGE, REOBSERVED_THREAD);
  db.prepare(
    `INSERT INTO channel_access_audits (id, channel_id, checked_at_ms, can_view, can_read_history, can_send,
       can_send_in_threads, can_manage_threads, warning) VALUES ('audit-reobserved', ?, ?, 1, 1, 1, 1, 0, NULL)`,
  ).run(REOBSERVED_THREAD, T45 + 1_000);
  db.prepare(
    `INSERT INTO memories (id, workspace_id, scope_type, scope_key, type, statement, status,
       confidence, importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'org', NULL, 'decision', 'legacy thread decision', 'active', 0.8, 0.7, ?, ?, ?, ?)`,
  ).run(LEGACY_MEMORY, ARCHIVE_GUILD, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
  db.prepare(
    `INSERT INTO memory_evidence (memory_id, message_id, stance, weight, created_at_ms)
     VALUES (?, ?, 'supports', 1, ?)`,
  ).run(LEGACY_MEMORY, LEGACY_MESSAGE, ARCHIVE_NOW);
}

function setup(mutate: (db: DatabaseSync) => void = seed): { reader: ArchiveReader; summary: ArchiveSummary } {
  fixture = createArchiveFixture({ mutate });
  live = createTestDb();
  archiveDb = openArchiveDatabase(fixture.path);
  const summary = verifyArchive(archiveDb, fixture.path, { platform: 'discord', newestSchemaVersion: 1_000 });
  return { reader: createArchiveReader({ db: archiveDb, liveDb: live.db, summary }), summary };
}

describe('archive threads last seen before migration 045', () => {
  it('hides a thread that was not observed after 045, and serves one that was', () => {
    const { reader } = setup();
    const ids = searchArchiveMessages(reader, { query: 'legacy thread billing', limit: 50 }).map((r) => r.messageId);
    expect(ids).not.toContain(LEGACY_MESSAGE);
    expect(ids).toContain(REOBSERVED_MESSAGE);
  });

  it('refuses context for a message in such a thread', () => {
    const { reader } = setup();
    expect(getArchiveMessageContext(reader, `archive:${LEGACY_MESSAGE}`, { before: 2, after: 2 })).toBeNull();
    expect(getArchiveMessageContext(reader, `archive:${REOBSERVED_MESSAGE}`, { before: 2, after: 2 })).not.toBeNull();
  });

  it('hides a memory whose evidence is in such a thread', () => {
    const { reader } = setup();
    expect(searchArchiveMemories(reader, { limit: 50 }).map((m) => m.memoryId)).not.toContain(LEGACY_MEMORY);
    expect(getArchiveMemoryEvidence(reader, `archive:${LEGACY_MEMORY}`)).toBeNull();
  });

  it('counts the hidden threads in the startup summary', () => {
    const { summary } = setup();
    expect(summary.hiddenLegacyThreads).toBe(1);
  });

  it('hides every thread when the archive has no record of migration 045', () => {
    const { reader } = setup((db) => {
      seed(db);
      db.prepare('DELETE FROM schema_migrations WHERE version = 45').run();
    });
    const ids = searchArchiveMessages(reader, { query: 'billing decision', limit: 50 }).map((r) => r.messageId);
    expect(ids).not.toContain(REOBSERVED_MESSAGE);
    expect(ids).not.toContain(LEGACY_MESSAGE);
  });
});
