// ABOUTME: Opens a frozen platform archive read-only and verifies it at startup (plan 011 step 2, spec §5.4).
// ABOUTME: The archive is never migrated or written; a wrong, broken, or unknown archive stops startup.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PlatformId } from '../config.js';
import { isDiscordId } from '../platform/ids.js';
import { isSlackTeamId } from '../platform/slack/ids.js';

/** The oldest archive schema this release reads: 45 adds `channels.is_private_thread`. */
export const ARCHIVE_MIN_SCHEMA_VERSION = 45;

/** Facts about a verified archive, for status, the inspector, and redaction rows. */
export interface ArchiveSummary {
  platform: PlatformId;
  workspaceId: string;
  schemaVersion: number;
  sizeBytes: number;
  sha256: string;
  /** Messages in org channels that Mneme can serve from the archive. */
  orgMessages: number;
  /** Active org-scoped memories that Mneme can serve from the archive. */
  orgMemories: number;
}

export interface VerifyArchiveOptions {
  /** The platform named by `MNEME_ARCHIVE_PLATFORM`. */
  platform: PlatformId;
  /** The newest migration this release knows; a newer archive schema is refused. */
  newestSchemaVersion: number;
}

/** A clear startup failure about the archive file. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(`platform archive: ${message}`);
    this.name = 'ArchiveError';
  }
}

/**
 * Open the archive read-only. The canonical `openDatabase` pragmas are not
 * used: `journal_mode = WAL` writes to the file and fails on a read-only
 * connection to a backup in `DELETE` mode. `query_only` refuses every write,
 * also to temporary tables, as a second guard.
 */
export function openArchiveDatabase(path: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true });
  } catch (err) {
    throw new ArchiveError(`cannot open ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    db.enableLoadExtension(false);
  } catch {
    // The constructor option already disables extensions.
  }
  db.exec('PRAGMA query_only = ON');
  db.exec('PRAGMA trusted_schema = OFF');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function scalar(db: DatabaseSync, sql: string): unknown {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

// An org channel or thread that Mneme can serve: org class, ingested, not
// deleted, no platform boundary, and not a Mneme test surface (spec §7.1).
const SERVABLE_ORG_CHANNEL = `
  c.visibility_class = 'org'
  AND c.ingest_enabled = 1
  AND c.deleted_at_ms IS NULL
  AND c.platform_boundary IS NULL
  AND INSTR(LOWER(COALESCE(c.name, '')), 'mneme') = 0
  AND (c.is_thread = 0 OR (p.id IS NOT NULL AND INSTR(LOWER(COALESCE(p.name, '')), 'mneme') = 0))`;

/**
 * Verify the archive and return its summary. Throws {@link ArchiveError}
 * when the file is not a usable backup of one workspace of `platform`.
 */
export function verifyArchive(db: DatabaseSync, path: string, options: VerifyArchiveOptions): ArchiveSummary {
  const journalMode = String(scalar(db, 'PRAGMA journal_mode') ?? '');
  if (journalMode.toLowerCase() === 'wal') {
    throw new ArchiveError('the file is in WAL journal mode; use a completed backup file, not a copy of a live database');
  }
  const integrity = String(scalar(db, 'PRAGMA integrity_check') ?? '');
  if (integrity !== 'ok') throw new ArchiveError(`integrity check failed: ${integrity.slice(0, 200)}`);

  const hasMigrations = scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  if (Number(hasMigrations) !== 1) throw new ArchiveError('the file has no schema_migrations table; it is not a Mneme database');
  const schemaVersion = Number(scalar(db, 'SELECT MAX(version) FROM schema_migrations') ?? 0);
  if (schemaVersion < ARCHIVE_MIN_SCHEMA_VERSION) {
    throw new ArchiveError(`schema ${schemaVersion} is older than ${ARCHIVE_MIN_SCHEMA_VERSION}; make the backup with Mneme v3.1.0 or later`);
  }
  if (schemaVersion > options.newestSchemaVersion) {
    throw new ArchiveError(`schema ${schemaVersion} is newer than this release knows (${options.newestSchemaVersion}); upgrade Mneme`);
  }

  const workspaces = db.prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>;
  if (workspaces.length !== 1) throw new ArchiveError(`expected exactly one workspace, found ${workspaces.length}`);
  const workspaceId = workspaces[0]!.id;
  const idMatches = options.platform === 'discord' ? isDiscordId(workspaceId) : isSlackTeamId(workspaceId);
  if (!idMatches) {
    throw new ArchiveError(`the workspace id does not match MNEME_ARCHIVE_PLATFORM=${options.platform}`);
  }

  const orgMessages = Number(scalar(db, `
    SELECT COUNT(*) FROM messages m
    JOIN channels c ON c.id = m.channel_id
    LEFT JOIN channels p ON p.id = c.parent_id
    WHERE m.deleted_at_ms IS NULL AND ${SERVABLE_ORG_CHANNEL}`));
  const orgMemories = Number(scalar(db, "SELECT COUNT(*) FROM memories WHERE scope_type = 'org' AND status = 'active'"));

  return {
    platform: options.platform,
    workspaceId,
    schemaVersion,
    sizeBytes: statSync(path).size,
    sha256: sha256File(path),
    orgMessages,
    orgMemories,
  };
}
