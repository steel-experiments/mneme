import { backup, DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

/**
 * Online SQLite backup creation (Sections 28, 42.1).
 *
 * SQLite's online backup API produces a standalone, consistent snapshot of the
 * database *without* copying the live `-wal`/`-shm` files. The copy runs on a
 * dedicated read-only source connection, never the live one: the live
 * connection keeps serving writes on the main thread, and a backup step through
 * it returns SQLITE_LOCKED whenever a write transaction is open (Section 42.1).
 * The API copies a single committed transaction boundary; the default one-step
 * copy leaves no between-step window for another connection's write to restart
 * it (Section 28: "online backup API, not raw file copy while open"; Section
 * 42.1: "Do not use `fs.copyFile` on only the main database file while WAL mode
 * is active").
 *
 * The resulting file is self-contained: the backup API checkpoints everything
 * into the main `.sqlite` file, so no companion `-wal`/`-shm` is required to
 * open it later.
 */

/** Filename prefix and extension for Mneme-owned backups (Section 42.1). */
export const BACKUP_FILE_PREFIX = 'mneme-';
export const BACKUP_FILE_SUFFIX = '.sqlite';
/** Appended to a backup filename to name its manifest. */
export const MANIFEST_SUFFIX = '.manifest.json';

/** Raised when `PRAGMA integrity_check` does not return `ok` on a backup. */
export class BackupIntegrityError extends Error {
  constructor(
    public readonly path: string,
    public readonly result: string,
  ) {
    super(`backup ${path} failed integrity_check: ${result}`);
    this.name = 'BackupIntegrityError';
  }
}

/**
 * The manifest written beside each backup (Section 42.1, step 4): application
 * version, schema version, timestamp, source database path, and SHA-256, plus
 * the size and filename needed to pair and verify the file later.
 */
export interface BackupManifest {
  applicationVersion: string;
  schemaVersion: number;
  timestampMs: number;
  timestamp: string;
  sourceDatabasePath: string;
  sha256: string;
  bytes: number;
  /** Backup filename (basename), for pairing the manifest to its file. */
  file: string;
  /** Always `'ok'`; a non-ok result throws before the manifest is written. */
  integrityCheck: 'ok';
}

/**
 * Backup step size that copies the whole source in one step: its current page
 * count, never below one. `sqlite3_backup_step(-1)` would do the same, but
 * `node:sqlite` validates `rate` as a positive integer.
 */
function singleStepRate(source: DatabaseSync): number {
  const row = source.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined;
  const pages = Number(row?.page_count ?? 0);
  return Number.isInteger(pages) && pages > 0 ? pages : 1;
}

export interface CreateBackupOptions {
  /** The open application database connection (used to read the schema version). */
  db: DatabaseSync;
  /** Directory to write backups into (created if missing). */
  backupsDir: string;
  /**
   * Absolute path of the live source database. Recorded in the manifest and
   * opened read-only as the dedicated backup source connection: backing up
   * through the live connection fails with SQLITE_LOCKED whenever a job holds
   * a write transaction open at a backup step.
   */
  sourceDatabasePath: string;
  /** Application version string (recorded in the manifest). */
  appVersion: string;
  /** Epoch milliseconds the backup is taken at (injectable for tests). */
  now: number;
  /**
   * Pages copied per backup step. Default: the source page count, so the copy
   * completes in one step and a write from another connection cannot restart
   * it between steps. Must be a positive integer; `node:sqlite` rejects zero
   * and negative values. Smaller values yield finer progress callbacks.
   */
  rate?: number;
  /** Optional progress callback, invoked after each step with page counts. */
  onProgress?: (info: { totalPages: number; remainingPages: number }) => void;
}

export interface CreateBackupResult {
  /** Absolute path of the completed backup file. */
  backupPath: string;
  /** Absolute path of the manifest JSON written beside the backup. */
  manifestPath: string;
  /** The manifest. */
  manifest: BackupManifest;
  /** Number of database pages the backup API copied. */
  pages: number;
}

/** Format an epoch-ms timestamp as a UTC `YYYYMMDD-HHMMSS` stem (filename-safe). */
export function formatBackupTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * Run `PRAGMA integrity_check` against a completed backup file, opening it
 * read-only and with extension loading disabled. Returns the full check result
 * (`'ok'` when clean, otherwise the concatenated error text). Does not mutate
 * the file — safe to run during restore (Section 42.3).
 */
export function integrityCheck(backupPath: string): string {
  const ro = new DatabaseSync(backupPath, { readOnly: true, allowExtension: false });
  try {
    ro.enableLoadExtension(false);
    const rows = ro.prepare('PRAGMA integrity_check').all() as Array<
      Record<string, SQLOutputValue>
    >;
    const lines = rows.map((r) => {
      const v = Object.values(r)[0];
      return v === undefined ? '' : String(v);
    });
    return lines.join('\n');
  } finally {
    ro.close();
  }
}

/**
 * Switch a completed backup out of WAL mode into rollback-journal (`DELETE`)
 * mode. The online backup of a WAL source inherits the WAL header, and any later
 * open — even read-only — would recreate `-wal`/`-shm` companions. Normalizing
 * to `DELETE` leaves a single self-contained file (Section 42.3 "completed
 * standalone backup"), with all data already checkpointed into the main file by
 * the backup API. On restore, `openDatabase` re-applies WAL (Section 28).
 * Returns the resulting journal mode.
 */
export function normalizeJournalMode(backupPath: string): string {
  const rw = new DatabaseSync(backupPath, { allowExtension: false });
  try {
    rw.enableLoadExtension(false);
    const row = rw.prepare('PRAGMA journal_mode = DELETE').get() as
      | Record<string, SQLOutputValue>
      | undefined;
    const mode = row ? Object.values(row)[0] : undefined;
    return mode === undefined ? '' : String(mode);
  } finally {
    rw.close();
  }
}

/** Read the highest applied migration version, or 0 when unmanaged. */
function readSchemaVersion(db: DatabaseSync): number {
  const managed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations' LIMIT 1")
    .get();
  if (!managed) return 0;
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_migrations')
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/** Remove a failed copy and any journal companions; absence is not an error. */
function removePartialBackup(backupPath: string): void {
  for (const path of [backupPath, `${backupPath}-wal`, `${backupPath}-shm`, `${backupPath}-journal`]) {
    rmSync(path, { force: true });
  }
}

/**
 * Create a timestamped standalone backup through the SQLite online backup API
 * (Section 42.1): ensure the backups directory exists, copy the live database
 * via the backup API, run `PRAGMA integrity_check` on the completed file, then
 * write a manifest recording application version, schema version, timestamp,
 * source path, and SHA-256.
 *
 * Must run outside a transaction (the backup API manages its own reads). The
 * source connection may continue to receive writes from the same connection
 * during the copy.
 */
export async function createBackup(options: CreateBackupOptions): Promise<CreateBackupResult> {
  const { db, backupsDir, sourceDatabasePath, appVersion, now } = options;
  mkdirSync(backupsDir, { recursive: true });

  const stem = formatBackupTimestamp(now);
  let backupPath = join(backupsDir, `${BACKUP_FILE_PREFIX}${stem}${BACKUP_FILE_SUFFIX}`);
  // Disambiguate same-second backups with a counter rather than overwriting.
  let counter = 1;
  while (existsSync(backupPath)) {
    backupPath = join(backupsDir, `${BACKUP_FILE_PREFIX}${stem}-${counter}${BACKUP_FILE_SUFFIX}`);
    counter++;
  }

  // Step 2: online backup from a dedicated read-only connection. The live
  // connection keeps serving jobs on the main thread while the backup steps on
  // a worker thread; sharing it makes sqlite3_backup_step return SQLITE_LOCKED
  // (surfaced by node:sqlite as "not an error") whenever a handler holds a
  // write transaction open, which is routine at busy hours. The default
  // single-step copy also removes the between-step windows in which a live
  // write would restart the copy. The backup API creates the destination file
  // before the first page is copied, so a copy that fails leaves a partial
  // file behind; remove it, so a backup file exists only together with its
  // manifest and a retry starts clean.
  let pages: number;
  const source = new DatabaseSync(sourceDatabasePath, { readOnly: true, allowExtension: false });
  try {
    source.enableLoadExtension(false);
    pages = await backup(source, backupPath, {
      rate: options.rate ?? singleStepRate(source),
      progress: options.onProgress,
    });

    // Normalize the inherited WAL header to rollback-journal mode so the backup
    // is a single standalone file (no `-wal`/`-shm` companions on later opens).
    normalizeJournalMode(backupPath);

    // Step 3: integrity_check on the completed standalone file.
    const integrity = integrityCheck(backupPath);
    if (integrity !== 'ok') {
      throw new BackupIntegrityError(backupPath, integrity);
    }
  } catch (err) {
    removePartialBackup(backupPath);
    throw err;
  } finally {
    source.close();
  }

  // Step 4: manifest fields. SHA-256 and size come from the completed file.
  const contents = readFileSync(backupPath);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const bytes = contents.length;

  const manifest: BackupManifest = {
    applicationVersion: appVersion,
    schemaVersion: readSchemaVersion(db),
    timestampMs: now,
    timestamp: new Date(now).toISOString(),
    sourceDatabasePath,
    sha256,
    bytes,
    file: basename(backupPath),
    integrityCheck: 'ok',
  };

  const manifestPath = `${backupPath}${MANIFEST_SUFFIX}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { backupPath, manifestPath, manifest, pages };
}

// ---------------------------------------------------------------------------
// Retention rotation (Section 42.1 step 5)
// ---------------------------------------------------------------------------

const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches a Mneme-owned backup *file* name: the canonical
 * `mneme-YYYYMMDD-HHMMSS.sqlite` plus the `‑N` disambiguator used when two
 * backups share a second. Capture group 1 is the UTC `YYYYMMDD-HHMMSS` stem, so
 * the backup instant can be recovered from the filename alone (independent of
 * mtime drift from copies or restores). Basenames only — no path separators.
 */
const OWNED_BACKUP_RE = new RegExp(
  `^${regexEscape(BACKUP_FILE_PREFIX)}(\\d{8}-\\d{6})(?:-\\d+)?${regexEscape(BACKUP_FILE_SUFFIX)}$`,
);

/** Parse the UTC backup instant (epoch ms) from an owned backup filename. */
export function parseBackupTimestampMs(backupFile: string): number | null {
  const m = OWNED_BACKUP_RE.exec(backupFile);
  if (!m) return null;
  const stem = m[1] as string;
  const yyyy = Number(stem.slice(0, 4));
  const mm = Number(stem.slice(4, 6));
  const dd = Number(stem.slice(6, 8));
  const hh = Number(stem.slice(9, 11));
  const mi = Number(stem.slice(11, 13));
  const ss = Number(stem.slice(13, 15));
  const epoch = Date.UTC(yyyy, mm - 1, dd, hh, mi, ss);
  return Number.isFinite(epoch) ? epoch : null;
}

export interface OwnedBackup {
  /** Basename of the `.sqlite` backup file. */
  file: string;
  /** Basename of its manifest, if present. */
  manifestFile: string | null;
  /** UTC backup instant parsed from the filename (null if unparseable). */
  timestampMs: number;
}

/** Bounded filesystem summary used by Discord and HTTP operational status. */
export interface BackupInventory {
  lastBackupAtMs: number | null;
  count: number;
}

export interface RotateBackupsOptions {
  /** Resolved backups directory (must be `DATA_DIR/backups`). */
  backupsDir: string;
  /** Backups older than this many days are eligible for deletion. */
  retentionDays: number;
  /** Epoch ms "now" (injectable for tests). */
  now: number;
  /**
   * Always retain at least this many newest backups regardless of age, so
   * rotation never leaves zero backups. Default 1.
   */
  keepMinimum?: number;
  /** Optional sink for a one-line summary (counts deleted/retained). */
  log?: (message: string) => void;
}

export interface RotateBackupsResult {
  /** Owned backup pairs found in the directory. */
  scanned: number;
  /** Owned backup pairs deleted. */
  deleted: number;
  /** Owned backup pairs retained. */
  retained: number;
  /** Basenames removed (sqlite + manifest together), for audit. */
  deletedFiles: string[];
}

/**
 * Enumerate the Mneme-owned backup pairs directly inside `backupsDir` (no
 * recursion). Used by rotation and by maintenance tooling; never lists nested
 * directories or files outside the directory.
 */
export function listOwnedBackups(backupsDir: string): OwnedBackup[] {
  const root = resolve(backupsDir);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: OwnedBackup[] = [];
  for (const name of entries) {
    if (!OWNED_BACKUP_RE.test(name)) continue;
    // Skip directories and symlinks — only delete real files we created.
    const stat = lstatSync(join(root, name));
    if (!stat.isFile()) continue;
    const ts = parseBackupTimestampMs(name);
    if (ts === null) continue;
    const manifestFile = existsSync(join(root, `${name}${MANIFEST_SUFFIX}`))
      ? `${name}${MANIFEST_SUFFIX}`
      : null;
    out.push({ file: name, manifestFile, timestampMs: ts });
  }
  out.sort((a, b) => a.timestampMs - b.timestampMs);
  return out;
}

/** Summarize completed Mneme-owned backups without opening their contents. */
export function backupInventory(backupsDir: string): BackupInventory {
  // The manifest is written only after the online copy and integrity check
  // succeed. Ignore an unpaired file left by an interrupted/failed attempt.
  const completed = listOwnedBackups(backupsDir).filter((backup) => backup.manifestFile !== null);
  const latest = completed.at(-1);
  return {
    lastBackupAtMs: latest?.timestampMs ?? null,
    count: completed.length,
  };
}

/**
 * Delete expired Mneme-created local backups and their manifests
 * (Section 42.1 step 5). Only direct children of `backupsDir` whose basenames
 * match the owned pattern are considered; the newest backups are always retained
 * (`keepMinimum`, default 1) even when older than the retention window, so
 * rotation never removes every backup.
 *
 * Safety: enumeration is non-recursive, every candidate basename matches a
 * strict pattern (no path separators or `..`), and each deletion target is
 * confirmed to resolve inside `backupsDir` before removal — rotation can never
 * follow a path outside `DATA_DIR/backups`.
 */
export function rotateBackups(options: RotateBackupsOptions): RotateBackupsResult {
  const { backupsDir, retentionDays, now } = options;
  const keepMinimum = Math.max(0, options.keepMinimum ?? 1);
  const root = resolve(backupsDir);
  const cutoff = now - retentionDays * 86_400_000;

  const owned = listOwnedBackups(root);
  // Newest first for retention indexing.
  const newestFirst = [...owned].sort((a, b) => b.timestampMs - a.timestampMs);
  const protectedSet = new Set(newestFirst.slice(0, keepMinimum).map((b) => b.file));

  const deletedFiles: string[] = [];
  for (const b of owned) {
    // Retain if it is one of the newest, or if it is still within the window.
    if (protectedSet.has(b.file) || b.timestampMs > cutoff) continue;

    const sqlitePath = join(root, b.file);
    const manifestPath = join(root, `${b.file}${MANIFEST_SUFFIX}`);
    // Defense-in-depth: confirm each target resolves inside the backups dir.
    if (!isWithin(sqlitePath, root)) continue;

    rmSync(sqlitePath, { force: false });
    deletedFiles.push(b.file);
    if (b.manifestFile && existsSync(manifestPath) && isWithin(manifestPath, root)) {
      rmSync(manifestPath, { force: false });
      deletedFiles.push(b.manifestFile);
    }
  }

  const deleted = deletedFiles.filter((f) => !f.endsWith(MANIFEST_SUFFIX)).length;
  const result: RotateBackupsResult = {
    scanned: owned.length,
    deleted,
    retained: owned.length - deleted,
    deletedFiles,
  };
  options.log?.(
    `backup retention: scanned ${result.scanned}, deleted ${result.deleted}, retained ${result.retained}`,
  );
  return result;
}

/** True when `target` resolves to `root` or somewhere directly beneath it. */
function isWithin(target: string, root: string): boolean {
  const t = resolve(target);
  return t === root || t.startsWith(`${root}${sep}`);
}
