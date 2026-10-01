import { mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DatabaseSync } from '../../src/db/database.js';
import { applyMigrations } from '../../src/db/migrations.js';

const REPO_MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface TestDb {
  db: DatabaseSync;
  path: string;
  dir: string;
  cleanup: () => void;
}

/**
 * Open a migrated temp-file database. WAL requires a real file (not :memory:),
 * so each test gets its own temp directory.
 */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'mneme-test-'));
  const path = join(dir, 'test.sqlite');
  const db = openDatabase(path);
  applyMigrations(db, REPO_MIGRATIONS);
  return {
    db,
    path,
    dir,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Copy the repo migrations into a temp dir so tests can mutate them safely. */
export function copyMigrationsToTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mneme-migrations-'));
  cpSync(REPO_MIGRATIONS, dir, { recursive: true });
  return dir;
}

export function writeMigration(dir: string, name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, 'utf8');
}

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mneme-tmp-'));
}

/** Minimal guild + channel + user scaffolding for FK-safe repository tests. */
export function seedIdentity(db: DatabaseSync, guildId = '100000000000000001'): {
  guildId: string;
  channelId: string;
  userId: string;
} {
  const now = 1_700_000_000_000;
  const channelId = '100000000000000002';
  const userId = '100000000000000003';
  db.prepare(
    'INSERT INTO guilds (id, name, owner_id, joined_at_ms, discovered_at_ms, updated_at_ms, raw_json) VALUES (?,?,?,?,?,?,NULL)',
  ).run(guildId, 'Guild', null, now, now, now);
  db.prepare(
    `INSERT INTO channels (id, guild_id, parent_id, type, name, topic, position, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, permission_fingerprint, last_message_id,
       discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json)
     VALUES (?, ?, NULL, ?, ?, NULL, NULL, 0, 0, 0, 1, 'restricted', 0, NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(channelId, guildId, 0, 'general', now, now);
  db.prepare(
    'INSERT INTO users (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms, raw_json) VALUES (?,?,?,0,?,?,NULL)',
  ).run(userId, 'alice', 'Alice', now, now);
  return { guildId, channelId, userId };
}

export { mkdirSync };
