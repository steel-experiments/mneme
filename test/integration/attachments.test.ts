import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTestDb, seedIdentity, makeTempDir, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeMessage } from '../../src/platform/discord/normalize.js';
import { ingestMessageCreate } from '../../src/ingestion/ingest.js';
import { opts, rawMessage } from '../helpers/messages.js';
import {
  checkArchiveEligibility,
  isExecutableFilename,
  isArchiveMode,
  shouldStoreMetadata,
  safeExtension,
  resolveArchivePath,
  archiveAttachment,
  type AttachmentDownloadConfig,
  type FetchBytes,
} from '../../src/ingestion/attachments.js';
import {
  upsertAttachments,
  setAttachmentArchive,
  getAttachment,
} from '../../src/db/repositories/attachments.js';
import type { NormalizedAttachment } from '../../src/platform/types.js';
import { createArchiveAttachmentHandler } from '../../src/jobs/handlers/archive-attachment.js';
import { JobWorker } from '../../src/jobs/worker.js';

const NOW = 1_700_000_001_000;

/** A Discord-like attachment id rule: a snowflake. */
const DISCORD_ATTACHMENT_ID = (id: string): boolean => /^\d{17,20}$/.test(id);
/** A Slack-like attachment id rule: `<channel>-<ts>-<file>`. */
const SLACK_ATTACHMENT_ID = (id: string): boolean => /^[CG][A-Z0-9]{8,}-\d{10}\.\d{6}-F[A-Z0-9]{8,}$/.test(id);

function cfg(dataDir: string, over: Partial<AttachmentDownloadConfig> = {}): AttachmentDownloadConfig {
  return {
    mode: 'archive',
    maxBytes: 1_048_576,
    mimeAllowlist: ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'application/pdf'],
    dataDir,
    isValidAttachmentId: DISCORD_ATTACHMENT_ID,
    ...over,
  };
}

function attachment(over: Partial<NormalizedAttachment> = {}): NormalizedAttachment {
  return {
    id: '555000000000000001',
    filename: 'plan.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    width: null,
    height: null,
    sourceUrl: 'https://cdn.example.com/plan.txt',
    proxyUrl: 'https://media.example.com/plan.txt',
    ...over,
  };
}

const TEXT = new TextEncoder().encode('hello archive');

function fetcher(bytes: Uint8Array): FetchBytes {
  return async () => bytes;
}

describe('attachment safety predicates', () => {
  it('shouldStoreMetadata is false only for none', () => {
    expect(shouldStoreMetadata('none')).toBe(false);
    expect(shouldStoreMetadata('metadata')).toBe(true);
    expect(shouldStoreMetadata('archive')).toBe(true);
    expect(shouldStoreMetadata('selective')).toBe(true);
  });

  it('isArchiveMode is true only for archive and selective', () => {
    expect(isArchiveMode('archive')).toBe(true);
    expect(isArchiveMode('selective')).toBe(true);
    expect(isArchiveMode('metadata')).toBe(false);
    expect(isArchiveMode('none')).toBe(false);
  });

  it('isExecutableFilename blocks dangerous extensions regardless of case', () => {
    expect(isExecutableFilename('payload.exe')).toBe(true);
    expect(isExecutableFilename('Payload.SH')).toBe(true);
    expect(isExecutableFilename('script.js')).toBe(true);
    expect(isExecutableFilename('plan.txt')).toBe(false);
    expect(isExecutableFilename('archive.tar.gz')).toBe(false);
  });

  it('safeExtension sanitizes to a short alphanumeric token', () => {
    expect(safeExtension('plan.txt')).toBe('.txt');
    expect(safeExtension('file.PDF')).toBe('.pdf');
    expect(safeExtension('a.b.c.json')).toBe('.json');
    expect(safeExtension('unclean<>:.txt')).toBe('.txt');
    expect(safeExtension('noextension')).toBe('');
    expect(safeExtension('../../etc/passwd')).toBe('');
  });
});

describe('archive eligibility', () => {
  const c = cfg('/app/data');

  it('allows an allowlisted, in-limit text file in archive mode', () => {
    const r = checkArchiveEligibility(attachment(), c);
    expect(r.eligible).toBe(true);
  });

  it('rejects when the mode does not archive', () => {
    expect(checkArchiveEligibility(attachment(), cfg('/app/data', { mode: 'metadata' })).eligible).toBe(false);
    expect(checkArchiveEligibility(attachment(), cfg('/app/data', { mode: 'none' })).eligible).toBe(false);
  });

  it('rejects disallowed MIME types', () => {
    const r = checkArchiveEligibility(attachment({ mimeType: 'image/png' }), c);
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain('not allowlisted');
  });

  it('rejects oversized attachments', () => {
    const r = checkArchiveEligibility(attachment({ sizeBytes: 999_999_999 }), c);
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain('exceeds limit');
  });

  it('rejects executable filenames even with an allowlisted MIME', () => {
    const r = checkArchiveEligibility(
      attachment({ filename: 'payload.txt.exe', mimeType: 'text/plain' }),
      c,
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain('executable');
  });

  it('infers MIME from extension when absent', () => {
    const r = checkArchiveEligibility(attachment({ filename: 'notes.md', mimeType: null }), c);
    expect(r.eligible).toBe(true); // .md → text/markdown
  });

  it('selective mode applies the same allowlist and limit', () => {
    const r = checkArchiveEligibility(attachment(), cfg('/app/data', { mode: 'selective' }));
    expect(r.eligible).toBe(true);
  });
});

describe('resolveArchivePath — traversal safety', () => {
  const c = cfg('/app/data');

  it('builds an id-based path inside the attachments dir', () => {
    const { dir, path } = resolveArchivePath(c, '555000000000000001', 'plan.txt');
    expect(dir).toBe(join('/app/data', 'attachments'));
    expect(path).toBe(join(dir, '555000000000000001.txt'));
  });

  it('ignores traversal in the filename (path is id-based)', () => {
    const { path } = resolveArchivePath(c, '555000000000000001', '../../../../etc/passwd');
    expect(path).toBe(join(join('/app/data', 'attachments'), '555000000000000001'));
    expect(path.startsWith(join('/app/data', 'attachments'))).toBe(true);
  });

  it('throws on an attachment id that the platform rejects', () => {
    expect(() => resolveArchivePath(c, 'not-an-id', 'plan.txt')).toThrow(/not valid for this platform/);
    expect(() => resolveArchivePath(c, '../escape', 'plan.txt')).toThrow(/not valid for this platform/);
  });

  it('builds a path from a Slack attachment id', () => {
    const slack = cfg('/app/data', { isValidAttachmentId: SLACK_ATTACHMENT_ID });
    const { dir, path } = resolveArchivePath(slack, 'C0123ABCD-1712345678.000100-F0123ABCD', 'plan.txt');
    expect(path).toBe(join(dir, 'C0123ABCD-1712345678.000100-F0123ABCD.txt'));
  });

  it.each(['..', '.hidden', 'a/b', 'a\\b', 'a..b'])('rejects %s even when the platform rule accepts it', (id) => {
    const permissive = cfg('/app/data', { isValidAttachmentId: () => true });
    expect(() => resolveArchivePath(permissive, id, 'plan.txt')).toThrow(/not valid for this platform/);
  });
});

describe('archiveAttachment — download, hash, and write', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const expectedSha = createHash('sha256').update(TEXT).digest('hex');

  it('stores an eligible file with a verified sha256', async () => {
    const outcome = await archiveAttachment(attachment(), cfg(dir), fetcher(TEXT));
    expect(outcome.status).toBe('stored');
    expect(outcome.sha256).toBe(expectedSha);
    expect(outcome.sizeBytes).toBe(TEXT.length);
    expect(outcome.localPath).toBeDefined();
    expect(existsSync(outcome.localPath!)).toBe(true);
    expect(readFileSync(outcome.localPath!)).toEqual(Buffer.from(TEXT));
    expect(outcome.localPath).toContain('attachments');
  });

  it('skips oversized downloads even when sizeBytes was unknown', async () => {
    const big = new Uint8Array(cfg(dir).maxBytes + 10);
    const outcome = await archiveAttachment(
      attachment({ sizeBytes: null }),
      cfg(dir),
      fetcher(big),
    );
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toContain('exceeds limit');
    expect(existsSync(join(dir, 'attachments'))).toBe(false);
  });

  it('skips ineligible attachments without fetching', async () => {
    let called = false;
    const f: FetchBytes = async () => {
      called = true;
      return TEXT;
    };
    const outcome = await archiveAttachment(
      attachment({ mimeType: 'image/png' }),
      cfg(dir),
      f,
    );
    expect(outcome.status).toBe('skipped');
    expect(called).toBe(false); // short-circuited before any network call
  });

  it('reports failure when the fetch throws', async () => {
    const f: FetchBytes = async () => {
      throw new Error('network down');
    };
    const outcome = await archiveAttachment(attachment(), cfg(dir), f);
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('network down');
  });

  it('skips when there is no source url', async () => {
    const outcome = await archiveAttachment(
      attachment({ sourceUrl: null, proxyUrl: null }),
      cfg(dir),
      fetcher(TEXT),
    );
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toContain('no source url');
  });
});

describe('attachment repository round-trip', () => {
  let env: TestDb;
  let db: DatabaseSync;
  beforeEach(() => {
    env = createTestDb();
    db = env.db;
    seedIdentity(db);
  });

  it('persists metadata and then archive state', () => {
    const msg = normalizeMessage(rawMessage());
    ingestMessageCreate(db, msg, opts());
    const a = attachment();
    upsertAttachments(db, [
      {
        id: a.id,
        messageId: msg.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        width: a.width,
        height: a.height,
        sourceUrl: a.sourceUrl,
        proxyUrl: a.proxyUrl,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ]);
    expect(getAttachment(db, a.id)!.archive_status).toBe('metadata');

    setAttachmentArchive(db, {
      id: a.id,
      localPath: '/app/data/attachments/555000000000000001.txt',
      sha256: 'abc123',
      status: 'stored',
      updatedAtMs: NOW + 1,
    });
    const row = getAttachment(db, a.id)!;
    expect(row.archive_status).toBe('stored');
    expect(row.local_path).toBe('/app/data/attachments/555000000000000001.txt');
    expect(row.sha256).toBe('abc123');
  });

  it('queues and executes an eligible archive download through the durable worker', async () => {
    const dir = makeTempDir();
    try {
      const a = attachment();
      const msg = normalizeMessage(rawMessage({ attachments: [{
        id: a.id, filename: a.filename, content_type: a.mimeType, size: a.sizeBytes,
        width: null, height: null, url: a.sourceUrl, proxy_url: a.proxyUrl,
      }] }));
      ingestMessageCreate(db, msg, opts({ attachmentMode: 'archive', attachmentArchive: cfg(dir) }));
      expect(getAttachment(db, a.id)?.archive_status).toBe('queued');
      const job = db.prepare("SELECT status FROM jobs WHERE type = 'archive_attachment'").get() as { status: string };
      expect(job.status).toBe('queued');

      const worker = new JobWorker({ db, owner: 'archive-test', leaseMs: 60_000, pollIntervalMs: 5,
        shutdownTimeoutMs: 1_000, clock: () => NOW });
      worker.register('archive_attachment', 1, createArchiveAttachmentHandler({ db, config: cfg(dir),
        now: () => NOW, fetcher: fetcher(TEXT) }));
      await worker.runOnce();

      const stored = getAttachment(db, a.id)!;
      expect(stored.archive_status).toBe('stored');
      expect(stored.sha256).toBe(createHash('sha256').update(TEXT).digest('hex'));
      expect(existsSync(stored.local_path!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps no file when the write transaction cannot start (database locked)', async () => {
    const dir = makeTempDir();
    const exec = db.exec.bind(db);
    try {
      const a = attachment();
      const msg = normalizeMessage(rawMessage({ attachments: [{
        id: a.id, filename: a.filename, content_type: a.mimeType, size: a.sizeBytes,
        width: null, height: null, url: a.sourceUrl, proxy_url: a.proxyUrl,
      }] }));
      ingestMessageCreate(db, msg, opts({ attachmentMode: 'archive', attachmentArchive: cfg(dir) }));
      const handler = createArchiveAttachmentHandler({ db, config: cfg(dir), now: () => NOW,
        fetcher: async () => {
          // Make the next write transaction fail to start, once.
          let locked = true;
          db.exec = (sql: string) => {
            if (locked && sql === 'BEGIN IMMEDIATE') { locked = false; throw new Error('database is locked'); }
            return exec(sql);
          };
          return TEXT;
        } });
      await expect(handler({ attachmentId: a.id }, {} as never)).rejects.toThrow('database is locked');
      const leftovers = readdirSync(dir, { recursive: true }).filter((f) => String(f).includes(a.id));
      expect(leftovers).toEqual([]);
    } finally {
      db.exec = exec;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes a file left by an earlier attempt when the channel is no longer eligible', async () => {
    const dir = makeTempDir();
    try {
      const a = attachment();
      const msg = normalizeMessage(rawMessage({ attachments: [{
        id: a.id, filename: a.filename, content_type: a.mimeType, size: a.sizeBytes,
        width: null, height: null, url: a.sourceUrl, proxy_url: a.proxyUrl,
      }] }));
      ingestMessageCreate(db, msg, opts({ attachmentMode: 'archive', attachmentArchive: cfg(dir) }));
      const { path } = resolveArchivePath(cfg(dir), a.id, a.filename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, TEXT);
      db.exec("UPDATE channels SET visibility_class = 'excluded'");
      const handler = createArchiveAttachmentHandler({ db, config: cfg(dir), now: () => NOW,
        fetcher: async () => { throw new Error('no download expected'); } });
      await handler({ attachmentId: a.id }, {} as never);
      expect(existsSync(path)).toBe(false);
      expect(getAttachment(db, a.id)!.archive_status).toBe('metadata');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['excluded', "UPDATE channels SET visibility_class = 'excluded'"],
    ['no longer ingested', 'UPDATE channels SET ingest_enabled = 0'],
  ])('keeps no file when the channel was %s during the download', async (_label, sql) => {
    const dir = makeTempDir();
    try {
      const a = attachment();
      const msg = normalizeMessage(rawMessage({ attachments: [{
        id: a.id, filename: a.filename, content_type: a.mimeType, size: a.sizeBytes,
        width: null, height: null, url: a.sourceUrl, proxy_url: a.proxyUrl,
      }] }));
      ingestMessageCreate(db, msg, opts({ attachmentMode: 'archive', attachmentArchive: cfg(dir) }));
      // The channel changes while the bytes are in flight.
      const racing: FetchBytes = async () => { db.exec(sql); return TEXT; };
      const worker = new JobWorker({ db, owner: 'archive-test', leaseMs: 60_000, pollIntervalMs: 5,
        shutdownTimeoutMs: 1_000, clock: () => NOW });
      worker.register('archive_attachment', 1, createArchiveAttachmentHandler({ db, config: cfg(dir),
        now: () => NOW, fetcher: racing }));
      await worker.runOnce();

      const row = getAttachment(db, a.id)!;
      expect(row.archive_status).toBe('metadata');
      expect(row.local_path).toBeNull();
      expect(row.sha256).toBeNull();
      const leftovers = readdirSync(dir, { recursive: true }).filter((f) => String(f).includes(a.id));
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['excluded', "UPDATE channels SET visibility_class = 'excluded'"],
    ['no longer ingested', 'UPDATE channels SET ingest_enabled = 0'],
    ['renamed into a test surface', "UPDATE channels SET name = 'mneme-test'"],
  ])('does not download when the channel was %s after the job was queued', async (_label, sql) => {
    const dir = makeTempDir();
    try {
      const a = attachment();
      const msg = normalizeMessage(rawMessage({ attachments: [{
        id: a.id, filename: a.filename, content_type: a.mimeType, size: a.sizeBytes,
        width: null, height: null, url: a.sourceUrl, proxy_url: a.proxyUrl,
      }] }));
      ingestMessageCreate(db, msg, opts({ attachmentMode: 'archive', attachmentArchive: cfg(dir) }));
      expect(getAttachment(db, a.id)?.archive_status).toBe('queued');
      db.exec(sql);

      let fetches = 0;
      const counting: FetchBytes = async () => { fetches += 1; return TEXT; };
      const worker = new JobWorker({ db, owner: 'archive-test', leaseMs: 60_000, pollIntervalMs: 5,
        shutdownTimeoutMs: 1_000, clock: () => NOW });
      worker.register('archive_attachment', 1, createArchiveAttachmentHandler({ db, config: cfg(dir),
        now: () => NOW, fetcher: counting }));
      await worker.runOnce();

      expect(fetches).toBe(0);
      const row = getAttachment(db, a.id)!;
      expect(row.archive_status).toBe('metadata');
      expect(row.local_path).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
