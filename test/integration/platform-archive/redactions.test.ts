// ABOUTME: Tests the archive redaction overlay in the live database (plan 011 step 4).
// ABOUTME: Redactions match on the archive workspace id, never on the archive file hash.
import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { loadRedactions } from '../../../src/platform-archive/redactions.js';

const WORKSPACE = '300000000000000001';
const OTHER_WORKSPACE = '300000000000000999';

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function redact(db: TestDb['db'], id: string, workspace: string, kind: 'user' | 'message', target: string, sha: string): void {
  db.prepare(
    `INSERT INTO archive_redactions (id, archive_workspace_id, target_kind, target_id, archive_sha256, created_at_ms)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(id, workspace, kind, target, sha);
}

describe('archive_redactions', () => {
  it('stores one redaction for each workspace, kind, and target', () => {
    t = createTestDb();
    redact(t.db, 'r1', WORKSPACE, 'message', 'm1', 'sha-a');
    expect(() => redact(t!.db, 'r2', WORKSPACE, 'message', 'm1', 'sha-b')).toThrow(/UNIQUE/);
    expect(() => redact(t!.db, 'r3', WORKSPACE, 'channel' as 'user', 'c1', 'sha-a')).toThrow(/CHECK/);
  });

  it('loads message and user redactions for the archive workspace only', () => {
    t = createTestDb();
    redact(t.db, 'r1', WORKSPACE, 'message', 'm1', 'sha-a');
    redact(t.db, 'r2', WORKSPACE, 'user', 'u1', 'sha-a');
    redact(t.db, 'r3', OTHER_WORKSPACE, 'message', 'm2', 'sha-a');
    expect(loadRedactions(t.db, WORKSPACE)).toEqual({ messageIds: ['m1'], userIds: ['u1'] });
    expect(loadRedactions(t.db, OTHER_WORKSPACE)).toEqual({ messageIds: ['m2'], userIds: [] });
  });

  it('applies a redaction whatever archive file was current when it was made', () => {
    t = createTestDb();
    redact(t.db, 'r1', WORKSPACE, 'message', 'm1', 'sha-of-an-older-file');
    redact(t.db, 'r2', WORKSPACE, 'message', 'm2', 'sha-of-the-current-file');
    expect(loadRedactions(t.db, WORKSPACE).messageIds.sort()).toEqual(['m1', 'm2']);
  });
});
