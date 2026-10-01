import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, makeTempDir, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  createBackup,
  backupInventory,
  formatBackupTimestamp,
  integrityCheck,
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
  MANIFEST_SUFFIX,
  type BackupManifest,
} from '../../src/db/backup.js';
import { createBackupDatabaseHandler } from '../../src/jobs/handlers/backup-database.js';
import type { JobRow } from '../../src/jobs/types.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const CHANNEL = '100000000000000002';

const BACKUP_JOB: JobRow = {
  id: 'backup-job-1',
  type: 'backup_database',
  unique_key: 'admin:backup',
  payload_json: '{}',
  status: 'running',
  priority: 100,
  run_after_ms: 1_700_000_020_000,
  lease_owner: 'test',
  lease_until_ms: 1_700_000_080_000,
  attempts: 1,
  max_attempts: 10,
  last_error: null,
  created_at_ms: 1_700_000_020_000,
  updated_at_ms: 1_700_000_020_000,
  completed_at_ms: null,
};

let env: TestDb;
let backupsDir: string;

function addMessage(id: string, content: string, createdAtMs: number): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: CHANNEL,
    authorId: USER,
    authorDisplayName: 'Alice',
    content,
    createdAtMs,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: createdAtMs,
    updatedAtMs: createdAtMs,
  });
}

/** Count rows in the backup by opening it read-only and independently. */
function backupCount(backupPath: string): number {
  const ro = new DatabaseSync(backupPath, { readOnly: true, allowExtension: false });
  try {
    const row = ro.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    return Number(row.c);
  } finally {
    ro.close();
  }
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('online SQLite backup', { timeout: 15_000 }, () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    backupsDir = makeTempDir();
  });
  afterEach(() => {
    env.cleanup();
    rmSync(backupsDir, { recursive: true, force: true });
  });

  it('creates a standalone backup that opens independently, passes integrity_check, matches its manifest hash, and contains committed data', async () => {
    addMessage('m1', 'we decided to ship the cutdown', 1_700_000_001_000);
    addMessage('m2', 'follow up: reverted the cutdown', 1_700_000_002_000);

    const NOW = 1_700_000_010_000;
    const { backupPath, manifestPath, manifest } = await createBackup({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: '9.9.9-test',
      now: NOW,
    });

    // Opens independently of the still-open source connection.
    expect(backupCount(backupPath)).toBe(2);

    // Passes integrity_check on the completed file.
    expect(integrityCheck(backupPath)).toBe('ok');

    // Manifest hash matches the file.
    expect(manifest.sha256).toBe(sha256Of(backupPath));

    // Manifest carries every Section 42.1 field.
    expect(manifest.applicationVersion).toBe('9.9.9-test');
    expect(manifest.timestampMs).toBe(NOW);
    expect(manifest.timestamp).toBe(new Date(NOW).toISOString());
    expect(manifest.sourceDatabasePath).toBe(env.path);
    expect(manifest.bytes).toBe(readFileSync(backupPath).length);
    expect(manifest.integrityCheck).toBe('ok');
    expect(manifest.file).toBe(backupPath.split(/[\\/]/).pop());
    // Schema version tracks the highest applied migration.
    expect(manifest.schemaVersion).toBeGreaterThanOrEqual(4);

    // The manifest is written beside the backup and round-trips.
    const written: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(written).toEqual(manifest);
    expect(manifestPath.endsWith(`${BACKUP_FILE_SUFFIX}${MANIFEST_SUFFIX}`)).toBe(true);
  }, 15_000);

  it('completes while the live connection holds an open write transaction', async () => {
    // Regression: the copy runs on a dedicated read-only connection. Backing up
    // through the live connection returns SQLITE_LOCKED ("not an error" via
    // node:sqlite) whenever a job handler holds a write transaction open,
    // which failed the scheduled production backups on busy evenings.
    addMessage('m-open-txn', 'committed before the backup', 1_700_000_001_000);
    env.db.exec('BEGIN IMMEDIATE');
    env.db
      .prepare("INSERT INTO users (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms) VALUES ('u-uncommitted', 'u', 'U', 0, 1, 1)")
      .run();
    try {
      const { backupPath, manifest } = await createBackup({
        db: env.db,
        backupsDir,
        sourceDatabasePath: env.path,
        appVersion: '9.9.9-test',
        now: 1_700_000_020_000,
      });
      expect(manifest.integrityCheck).toBe('ok');
      // The snapshot holds the committed state, not the open transaction.
      expect(backupCount(backupPath)).toBe(1);
      const snapshot = new DatabaseSync(backupPath, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'u-uncommitted'").get()).toEqual({ n: 0 });
      } finally {
        snapshot.close();
      }
    } finally {
      env.db.exec('COMMIT');
    }
  }, 15_000);

  it('is a point-in-time snapshot: rows committed after the backup are absent', async () => {
    addMessage('before', 'committed before backup', 1_700_000_001_000);
    const { backupPath } = await createBackup({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: '1.0.0',
      now: 1_700_000_005_000,
    });
    // A row committed on the live connection AFTER the snapshot must not appear.
    addMessage('after', 'committed after backup', 1_700_000_009_000);

    expect(backupCount(backupPath)).toBe(1);
    expect(integrityCheck(backupPath)).toBe('ok');
  });

  it('copies the whole source in one step by default with a positive page rate', async () => {
    // Enough rows to span many pages: the default rate must still finish the
    // copy in one step, and node:sqlite accepts only positive integer rates.
    for (let i = 0; i < 300; i++) addMessage(`seed-${i}`, `seed row ${i}`, 1_700_000_000_000 + i);
    const steps: Array<{ totalPages: number; remainingPages: number }> = [];
    const { backupPath } = await createBackup({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: '1.0.0',
      now: 1_700_010_000_000,
      onProgress: (info) => steps.push(info),
    });
    // The progress callback runs between steps only, so a one-step copy
    // reports no progress at all, while rate 1 on the same data reports many.
    expect(steps).toEqual([]);
    expect(backupCount(backupPath)).toBe(300);
    expect(integrityCheck(backupPath)).toBe('ok');
  });

  it('remains consistent when the same connection writes during the copy', async () => {
    // Seed enough rows to span several pages so rate:1 steps multiple times.
    for (let i = 0; i < 300; i++) addMessage(`seed-${i}`, `seed row ${i}`, 1_700_000_000_000 + i);
    const seeded = 300;

    let wroteDuring = false;
    const { backupPath, manifest } = await createBackup({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: '1.0.0',
      now: 1_700_010_000_000,
      rate: 1,
      onProgress: () => {
        // Same-connection writes during the backup are reflected immediately.
        if (!wroteDuring) {
          addMessage('during', 'written mid-backup on the source connection', 1_700_005_000_000);
          wroteDuring = true;
        }
      },
    });

    expect(wroteDuring).toBe(true);
    expect(integrityCheck(backupPath)).toBe('ok');
    expect(manifest.sha256).toBe(sha256Of(backupPath));
    // All committed (pre- and mid-backup) data is present.
    expect(backupCount(backupPath)).toBeGreaterThanOrEqual(seeded);
  });

  it('names the file mneme-YYYYMMDD-HHMMSS.sqlite (UTC) and pairs the manifest', async () => {
    const NOW = 1_701_234_567_000; // 2023-11-29T05:17:47.000Z
    const { backupPath, manifestPath } = await createBackup({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: '1.0.0',
      now: NOW,
    });

    const expectedName = `${BACKUP_FILE_PREFIX}${formatBackupTimestamp(NOW)}${BACKUP_FILE_SUFFIX}`;
    expect(backupPath.endsWith(expectedName)).toBe(true);
    expect(manifestPath).toBe(`${backupPath}${MANIFEST_SUFFIX}`);

    const files = readdirSync(backupsDir);
    expect(files).toContain(expectedName);
    expect(files).toContain(`${expectedName}${MANIFEST_SUFFIX}`);
    // No stray WAL/SHM companions — the backup is a single standalone file.
    expect(files.some((f) => f.endsWith('-wal') || f.endsWith('-shm'))).toBe(false);
  });

  it('disambiguates same-second backups without overwriting', async () => {
    const opts = {
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: '1.0.0',
      now: 1_700_000_000_000,
    };
    const a = await createBackup(opts);
    const b = await createBackup(opts);
    expect(a.backupPath).not.toBe(b.backupPath);
    expect(integrityCheck(a.backupPath)).toBe('ok');
    expect(integrityCheck(b.backupPath)).toBe('ok');
    // Two full backups plus two integrity checks: real file I/O that needs more
    // than the 5-second default when the suite runs its files in parallel.
  }, 15_000);

  it('removes the partial file when the copy fails, so no manifest-less backup remains', async () => {
    addMessage('h', 'hello', 1_700_000_001_000);
    await expect(createBackup({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: '1.0.0',
      now: 1_700_000_000_000,
      rate: 1,
      onProgress: () => {
        throw new Error('copy interrupted');
      },
    })).rejects.toThrow('copy interrupted');
    expect(readdirSync(backupsDir).filter((f) => f.endsWith(BACKUP_FILE_SUFFIX))).toEqual([]);
    expect(backupInventory(backupsDir)).toEqual({ lastBackupAtMs: null, count: 0 });
  });

  it('does not report an incomplete backup file without its verified manifest', () => {
    writeFileSync(join(backupsDir, 'mneme-20231114-221320.sqlite'), 'partial');
    expect(backupInventory(backupsDir)).toEqual({ lastBackupAtMs: null, count: 0 });
  });

  it('the backup_database job handler writes a backup and manifest into the backups directory', async () => {
    addMessage('h', 'hello', 1_700_000_001_000);
    const handler = createBackupDatabaseHandler({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: '7.7.7',
      now: () => 1_700_000_020_000,
    });
    const { result } = await handler.runBackup();

    expect(integrityCheck(result.backupPath)).toBe('ok');
    expect(result.manifest.applicationVersion).toBe('7.7.7');
    expect(result.manifest.sha256).toBe(sha256Of(result.backupPath));
    expect(backupCount(result.backupPath)).toBe(1);
    expect(readdirSync(backupsDir).length).toBe(2); // backup + manifest
    expect(backupInventory(backupsDir)).toEqual({
      lastBackupAtMs: 1_700_000_020_000,
      count: 1,
    });
  });

  it('logs the backup lifecycle and privately notifies an admin after verification', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const notifyCompleted = vi.fn().mockResolvedValue(undefined);
    const handler = createBackupDatabaseHandler({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      appVersion: '7.7.7',
      now: () => 1_700_000_020_000,
      logger: { info, warn },
      notifyCompleted,
    });

    await handler({ requesterUserId: USER }, BACKUP_JOB);

    expect(info.mock.calls.map((call) => call[0]?.event)).toEqual([
      'backup.started',
      'backup.succeeded',
      'backup.notification_sent',
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(notifyCompleted).toHaveBeenCalledWith(expect.objectContaining({
      requesterUserId: USER,
      file: 'mneme-20231114-221340.sqlite',
      timestampMs: 1_700_000_020_000,
    }));
  });

  it('keeps a verified backup successful when the private notification fails', async () => {
    const warn = vi.fn();
    const handler = createBackupDatabaseHandler({
      db: env.db,
      backupsDir,
      sourceDatabasePath: env.path,
      now: () => 1_700_000_020_000,
      logger: { info: vi.fn(), warn },
      notifyCompleted: vi.fn().mockRejectedValue(new Error('DMs disabled')),
    });

    await expect(handler({ requesterUserId: USER }, BACKUP_JOB)).resolves.toBeUndefined();
    expect(readdirSync(backupsDir)).toHaveLength(2);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: 'backup.notification_failed' });
  });

  it('logs failed attempts for Railway/Coolify diagnostics', async () => {
    const blocker = join(backupsDir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const warn = vi.fn();
    const handler = createBackupDatabaseHandler({
      db: env.db,
      backupsDir: join(blocker, 'backups'),
      sourceDatabasePath: env.path,
      logger: { info: vi.fn(), warn },
    });

    await expect(handler({}, BACKUP_JOB)).rejects.toThrow();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: 'backup.failed',
      jobId: BACKUP_JOB.id,
      attempt: 1,
      maxAttempts: 10,
    });
  });
});
