// ABOUTME: Tests that an archive memory owned by a redacted user is hidden (plan 011, PR #17 review).
// ABOUTME: Its evidence may come from other authors, so the evidence filter alone does not hide it.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { ARCHIVE_GUILD, ARCHIVE_MEMORIES, ARCHIVE_MESSAGES, ARCHIVE_NOW, createArchiveFixture, type ArchiveFixture } from '../../helpers/archive.js';
import { openArchiveDatabase, verifyArchive } from '../../../src/platform-archive/database.js';
import { createArchiveReader, getArchiveMemoryEvidence, searchArchiveMemories, type ArchiveReader } from '../../../src/platform-archive/read.js';

const OWNER = '300000000000000050';
const OWNED_MEMORY = 'archive-memory-owned';

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

function setup(): ArchiveReader {
  fixture = createArchiveFixture({
    mutate: (db) => {
      db.prepare(
        'INSERT INTO users (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms, raw_json) VALUES (?,?,?,0,?,?,NULL)',
      ).run(OWNER, 'owner', 'Memory Owner', ARCHIVE_NOW, ARCHIVE_NOW);
      db.prepare(
        `INSERT INTO memories (id, workspace_id, scope_type, scope_key, type, statement, status, owner_user_id,
           confidence, importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'org', NULL, 'decision', 'owned archived decision', 'active', ?, 0.8, 0.7, ?, ?, ?, ?)`,
      ).run(OWNED_MEMORY, ARCHIVE_GUILD, OWNER, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
      // The evidence is by the ordinary archive author, not by the owner.
      db.prepare(
        `INSERT INTO memory_evidence (memory_id, message_id, stance, weight, created_at_ms)
         VALUES (?, ?, 'supports', 1, ?)`,
      ).run(OWNED_MEMORY, ARCHIVE_MESSAGES.org, ARCHIVE_NOW);
    },
  });
  live = createTestDb();
  archiveDb = openArchiveDatabase(fixture.path);
  const summary = verifyArchive(archiveDb, fixture.path, { platform: 'discord', newestSchemaVersion: 1_000 });
  return createArchiveReader({ db: archiveDb, liveDb: live.db, summary });
}

function redactUser(userId: string): void {
  live!.db.prepare(
    `INSERT INTO archive_redactions (id, archive_workspace_id, target_kind, target_id, archive_sha256, created_at_ms)
     VALUES (?, ?, 'user', ?, 'audit-only', 1)`,
  ).run(`r-user-${userId}`, ARCHIVE_GUILD, userId);
}

describe('archive memory owners', () => {
  it('serves an owned memory while its owner is not redacted', () => {
    const reader = setup();
    expect(searchArchiveMemories(reader, { limit: 50 }).map((m) => m.memoryId)).toContain(OWNED_MEMORY);
  });

  it('hides a memory whose owner is redacted, even when its evidence is by another author', () => {
    const reader = setup();
    redactUser(OWNER);
    const ids = searchArchiveMemories(reader, { limit: 50 }).map((m) => m.memoryId);
    expect(ids).not.toContain(OWNED_MEMORY);
    expect(ids).toContain(ARCHIVE_MEMORIES.org);
    expect(getArchiveMemoryEvidence(reader, `archive:${OWNED_MEMORY}`)).toBeNull();
  });
});
