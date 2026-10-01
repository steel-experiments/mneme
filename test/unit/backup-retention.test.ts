import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rotateBackups,
  listOwnedBackups,
  parseBackupTimestampMs,
  formatBackupTimestamp,
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
  MANIFEST_SUFFIX,
} from '../../src/db/backup.js';

const OLD = Date.UTC(2023, 0, 1, 0, 0, 0); // 2023-01-01T00:00:00Z
const MID = Date.UTC(2023, 5, 1, 0, 0, 0); // 2023-06-01
const NEW = Date.UTC(2023, 11, 1, 0, 0, 0); // 2023-12-01
const NOW = Date.UTC(2023, 11, 2, 0, 0, 0); // 2023-12-02

function backupName(t: number): string {
  return `${BACKUP_FILE_PREFIX}${formatBackupTimestamp(t)}${BACKUP_FILE_SUFFIX}`;
}

let dir: string;

function writePair(t: number): string {
  const file = backupName(t);
  writeFileSync(join(dir, file), 'sqlite-bytes', 'utf8');
  writeFileSync(join(dir, `${file}${MANIFEST_SUFFIX}`), '{}', 'utf8');
  return file;
}

function writeRaw(name: string): void {
  writeFileSync(join(dir, name), 'unrelated', 'utf8');
}

function exists(name: string): boolean {
  return readdirSync(dir).includes(name);
}

describe('backup retention rotation', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mneme-retain-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses and round-trips the owned backup filename timestamp', () => {
    expect(parseBackupTimestampMs(backupName(NEW))).toBe(NEW);
    expect(parseBackupTimestampMs('mneme-20230101-000000-7.sqlite')).toBe(OLD);
    expect(parseBackupTimestampMs('not-a-backup.sqlite')).toBeNull();
    expect(parseBackupTimestampMs('mneme-20230101-000000.sqlite-wal')).toBeNull();
  });

  it('deletes only pairs older than the retention window and keeps the rest', () => {
    writePair(OLD);
    writePair(MID);
    writePair(NEW);

    const res = rotateBackups({ backupsDir: dir, retentionDays: 30, now: NOW });

    expect(res.scanned).toBe(3);
    expect(res.deleted).toBe(2);
    expect(res.retained).toBe(1);
    expect(exists(backupName(OLD))).toBe(false);
    expect(exists(`${backupName(OLD)}${MANIFEST_SUFFIX}`)).toBe(false);
    expect(exists(backupName(MID))).toBe(false);
    expect(exists(backupName(NEW))).toBe(true);
    expect(exists(`${backupName(NEW)}${MANIFEST_SUFFIX}`)).toBe(true);
  });

  it('always retains the newest backup even when the whole window has expired', () => {
    writePair(OLD);
    writePair(MID); // newest of the two
    const res = rotateBackups({ backupsDir: dir, retentionDays: 7, now: NOW });

    expect(res.deleted).toBe(1);
    expect(exists(backupName(OLD))).toBe(false);
    expect(exists(backupName(MID))).toBe(true);
  });

  it('respects keepMinimum=0 and removes every expired backup', () => {
    writePair(OLD);
    writePair(MID);
    const res = rotateBackups({
      backupsDir: dir,
      retentionDays: 7,
      now: NOW,
      keepMinimum: 0,
    });
    expect(res.deleted).toBe(2);
    expect(exists(backupName(OLD))).toBe(false);
    expect(exists(backupName(MID))).toBe(false);
  });

  it('never touches unrelated files regardless of name or extension', () => {
    writePair(OLD);
    writeRaw('other.sqlite');
    writeRaw('mneme.txt');
    writeRaw('README.md');
    writeRaw('cascade-20230101-000000.sqlite'); // wrong prefix
    writeRaw('mneme-20230101-000000.sqlite-wal'); // sidecar, not a backup pair

    const res = rotateBackups({ backupsDir: dir, retentionDays: 7, now: NOW, keepMinimum: 0 });

    expect(res.scanned).toBe(1);
    expect(exists(backupName(OLD))).toBe(false);
    expect(exists('other.sqlite')).toBe(true);
    expect(exists('mneme.txt')).toBe(true);
    expect(exists('README.md')).toBe(true);
    expect(exists('cascade-20230101-000000.sqlite')).toBe(true);
    expect(exists('mneme-20230101-000000.sqlite-wal')).toBe(true);
  });

  it('is non-recursive: ignores nested directories and never follows them', () => {
    writePair(OLD);
    // A subdirectory whose name matches the backup pattern must not be treated
    // as a backup, and rotation must not descend into it.
    const nested = join(dir, backupName(Date.UTC(2020, 0, 1)));
    mkdirSync(nested);
    writeFileSync(join(nested, 'trapped.sqlite'), 'x', 'utf8');

    const res = rotateBackups({ backupsDir: dir, retentionDays: 1, now: NOW, keepMinimum: 0 });

    expect(res.scanned).toBe(1); // only the real file, not the directory
    expect(exists(backupName(OLD))).toBe(false);
    expect(readdirSync(nested)).toEqual(['trapped.sqlite']);
  });

  it('returns an empty result (no throw) when the backups directory is absent', () => {
    const res = rotateBackups({
      backupsDir: join(dir, 'does-not-exist'),
      retentionDays: 7,
      now: NOW,
    });
    expect(res).toEqual({ scanned: 0, deleted: 0, retained: 0, deletedFiles: [] });
  });

  it('logs a one-line summary of deletion counts when a sink is provided', () => {
    writePair(OLD);
    writePair(MID);
    const messages: string[] = [];
    rotateBackups({
      backupsDir: dir,
      retentionDays: 7,
      now: NOW,
      log: (m) => messages.push(m),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/scanned 2, deleted 1, retained 1/);
  });

  it('listOwnedBackups reports pairs (with manifest presence) sorted oldest-first', () => {
    writePair(MID);
    writePair(OLD);
    const listed = listOwnedBackups(dir);
    expect(listed.map((b) => b.timestampMs)).toEqual([OLD, MID]);
    expect(listed.every((b) => b.manifestFile !== null)).toBe(true);
  });
});
