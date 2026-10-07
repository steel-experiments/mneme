// ABOUTME: Builds a realistic read-only platform archive for tests (plan 011): a migrated Discord database copied like a backup.
// ABOUTME: Seeds every visibility class, threads, messages, and memories; never uses a production file.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeJournalMode } from '../../src/db/backup.js';
import { createTestDb } from './db.js';

export const ARCHIVE_GUILD = '300000000000000001';
export const ARCHIVE_AUTHOR = '300000000000000002';
export const ARCHIVE_NOW = 1_780_000_000_000;

/** Channel ids by role. The test-surface channel is org but named like a Mneme test channel. */
export const ARCHIVE_CHANNELS = {
  org: '300000000000000010',
  restricted: '300000000000000011',
  reviewOnly: '300000000000000012',
  excluded: '300000000000000013',
  testSurface: '300000000000000014',
  orgThread: '300000000000000015',
  restrictedThread: '300000000000000016',
  boundary: '300000000000000017',
} as const;

/** One message for each channel role, keyed like {@link ARCHIVE_CHANNELS}. */
export const ARCHIVE_MESSAGES = {
  org: '300000000000000110',
  restricted: '300000000000000111',
  reviewOnly: '300000000000000112',
  excluded: '300000000000000113',
  testSurface: '300000000000000114',
  orgThread: '300000000000000115',
  restrictedThread: '300000000000000116',
  boundary: '300000000000000117',
} as const;

export const ARCHIVE_MEMORIES = {
  org: 'archive-memory-org',
  channel: 'archive-memory-channel',
  reviewOnly: 'archive-memory-review-only',
  superseded: 'archive-memory-superseded',
} as const;

export interface ArchiveFixture {
  /** The backup-style archive file (DELETE journal mode). */
  path: string;
  dir: string;
  cleanup: () => void;
}

export interface ArchiveFixtureOptions {
  /** Change the source database before the copy, to build a broken or unusual archive. */
  mutate?: (db: DatabaseSync) => void;
}

function seedChannel(
  db: DatabaseSync,
  id: string,
  name: string,
  visibility: string,
  over: { parentId?: string; isThread?: boolean; boundary?: 'excluded' } = {},
): void {
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, kind, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms, platform_boundary)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id, ARCHIVE_GUILD, over.parentId ?? null, over.isThread ? 'thread' : 'text', name, over.isThread ? 1 : 0,
    visibility === 'excluded' ? 0 : 1, visibility, ARCHIVE_NOW, ARCHIVE_NOW, over.boundary ?? null,
  );
}

function seedMessage(db: DatabaseSync, id: string, channelId: string, content: string): void {
  db.prepare(
    `INSERT INTO messages (id, workspace_id, channel_id, author_id, author_display_name, content,
       created_at_ms, ingested_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'Archive Author', ?, ?, ?, ?)`,
  ).run(id, ARCHIVE_GUILD, channelId, ARCHIVE_AUTHOR, content, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
}

function seedMemory(db: DatabaseSync, id: string, scopeType: string, scopeKey: string | null, status: string, evidenceId: string): void {
  db.prepare(
    `INSERT INTO memories (id, workspace_id, scope_type, scope_key, type, statement, status,
       confidence, importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'decision', ?, ?, 0.8, 0.7, ?, ?, ?, ?)`,
  ).run(id, ARCHIVE_GUILD, scopeType, scopeKey, `archived decision ${id}`, status,
    ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
  db.prepare(
    `INSERT INTO memory_evidence (memory_id, message_id, stance, weight, created_at_ms)
     VALUES (?, ?, 'supports', 1, ?)`,
  ).run(id, evidenceId, ARCHIVE_NOW);
}

/** Seed the archive content: one channel and message for each visibility role, plus memories. */
export function seedArchiveContent(db: DatabaseSync): void {
  // A realistic archive: the private-thread flag (migration 045) existed
  // before any of the seeded rows, so their flags are known to be correct.
  db.prepare('UPDATE schema_migrations SET applied_at_ms = ? WHERE version = 45').run(ARCHIVE_NOW - 1_000);
  db.prepare(
    'INSERT INTO workspaces (id, name, owner_id, joined_at_ms, discovered_at_ms, updated_at_ms, raw_json) VALUES (?,?,?,?,?,?,NULL)',
  ).run(ARCHIVE_GUILD, 'Archived Guild', null, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
  db.prepare(
    'INSERT INTO users (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms, raw_json) VALUES (?,?,?,0,?,?,NULL)',
  ).run(ARCHIVE_AUTHOR, 'archive-author', 'Archive Author', ARCHIVE_NOW, ARCHIVE_NOW);
  const c = ARCHIVE_CHANNELS;
  seedChannel(db, c.org, 'general', 'org');
  seedChannel(db, c.restricted, 'leadership', 'restricted');
  seedChannel(db, c.reviewOnly, 'review', 'review_only');
  seedChannel(db, c.excluded, 'hr', 'excluded');
  seedChannel(db, c.testSurface, 'mneme-test', 'org');
  seedChannel(db, c.orgThread, 'thread', 'org', { parentId: c.org, isThread: true });
  seedChannel(db, c.restrictedThread, 'private-thread', 'restricted', { parentId: c.org, isThread: true });
  seedChannel(db, c.boundary, 'shared', 'excluded', { boundary: 'excluded' });
  for (const role of Object.keys(ARCHIVE_MESSAGES) as Array<keyof typeof ARCHIVE_MESSAGES>) {
    seedMessage(db, ARCHIVE_MESSAGES[role], ARCHIVE_CHANNELS[role], `archived ${role} billing decision`);
  }
  seedMemory(db, ARCHIVE_MEMORIES.org, 'org', null, 'active', ARCHIVE_MESSAGES.org);
  seedMemory(db, ARCHIVE_MEMORIES.channel, 'channel', ARCHIVE_CHANNELS.restricted, 'active', ARCHIVE_MESSAGES.restricted);
  seedMemory(db, ARCHIVE_MEMORIES.reviewOnly, 'review_only', null, 'active', ARCHIVE_MESSAGES.reviewOnly);
  seedMemory(db, ARCHIVE_MEMORIES.superseded, 'org', null, 'superseded', ARCHIVE_MESSAGES.orgThread);
}

/**
 * Build a migrated, seeded Discord database and copy it the way a backup is
 * made: `VACUUM INTO` a new file, then switch that file to `DELETE` journal mode.
 */
export function createArchiveFixture(options: ArchiveFixtureOptions = {}): ArchiveFixture {
  const source = createTestDb();
  seedArchiveContent(source.db);
  options.mutate?.(source.db);
  const path = join(source.dir, 'archive.sqlite');
  source.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  source.db.close();
  rmSync(source.path, { force: true });
  rmSync(`${source.path}-wal`, { force: true });
  rmSync(`${source.path}-shm`, { force: true });
  normalizeJournalMode(path);
  return { path, dir: source.dir, cleanup: source.cleanup };
}
