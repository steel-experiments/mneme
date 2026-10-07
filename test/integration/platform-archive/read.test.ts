// ABOUTME: Tests the org-only archive read functions (plan 011 step 5) on a realistic seeded archive.
// ABOUTME: Only servable org content returns; redactions apply everywhere; links come from the archive's platform.
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import {
  ARCHIVE_AUTHOR,
  ARCHIVE_CHANNELS,
  ARCHIVE_GUILD,
  ARCHIVE_MEMORIES,
  ARCHIVE_MESSAGES,
  ARCHIVE_NOW,
  createArchiveFixture,
  type ArchiveFixture,
} from '../../helpers/archive.js';
import { openArchiveDatabase, verifyArchive } from '../../../src/platform-archive/database.js';
import {
  ARCHIVE_GRANT,
  createArchiveReader,
  getArchiveMemoryEvidence,
  getArchiveMessageContext,
  searchArchiveMemories,
  searchArchiveMessages,
  type ArchiveReader,
} from '../../../src/platform-archive/read.js';
import { discordMessageLink, useMessageLinkBuilder } from '../../../src/platform/links.js';

const OTHER_AUTHOR = '300000000000000003';
const EXTRA = {
  before2: '300000000000000201',
  before1: '300000000000000202',
  target: '300000000000000203',
  after1: '300000000000000204',
  after2: '300000000000000205',
  tombstoned: '300000000000000206',
  deleted: '300000000000000207',
  privateThreadMessage: '300000000000000208',
  privateThread: '300000000000000018',
} as const;
const MEMORY_RESTRICTED_EVIDENCE = 'archive-memory-org-with-restricted-evidence';
const MEMORY_TWO_EVIDENCE = 'archive-memory-org-two-evidence';

let fixture: ArchiveFixture | undefined;
let live: TestDb | undefined;
let archiveDb: DatabaseSync | undefined;
afterEach(() => {
  useMessageLinkBuilder(discordMessageLink);
  try { archiveDb?.close(); } catch { /* already closed */ }
  archiveDb = undefined;
  fixture?.cleanup();
  fixture = undefined;
  live?.cleanup();
  live = undefined;
});

function message(db: DatabaseSync, id: string, channelId: string, author: string, content: string, atMs: number): void {
  db.prepare(
    `INSERT INTO messages (id, workspace_id, channel_id, author_id, author_display_name, content,
       created_at_ms, ingested_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ARCHIVE_GUILD, channelId, author, author === OTHER_AUTHOR ? 'Other Author' : 'Archive Author', content, atMs, atMs, atMs);
}

function memory(db: DatabaseSync, id: string, evidence: string[]): void {
  db.prepare(
    `INSERT INTO memories (id, workspace_id, scope_type, scope_key, type, statement, status,
       confidence, importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'org', NULL, 'decision', ?, 'active', 0.8, 0.7, ?, ?, ?, ?)`,
  ).run(id, ARCHIVE_GUILD, `archived decision ${id}`, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW, ARCHIVE_NOW);
  for (const messageId of evidence) {
    db.prepare(
      `INSERT INTO memory_evidence (memory_id, message_id, stance, weight, created_at_ms)
       VALUES (?, ?, 'supports', 1, ?)`,
    ).run(id, messageId, ARCHIVE_NOW);
  }
}

/** Extra rows on top of the shared seed: context neighbours, deletions, a private thread, and edge-case memories. */
function seedExtras(db: DatabaseSync): void {
  db.prepare(
    'INSERT INTO users (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms, raw_json) VALUES (?,?,?,0,?,?,NULL)',
  ).run(OTHER_AUTHOR, 'other-author', 'Other Author', ARCHIVE_NOW, ARCHIVE_NOW);
  const org = ARCHIVE_CHANNELS.org;
  message(db, EXTRA.before2, org, ARCHIVE_AUTHOR, 'context before two', ARCHIVE_NOW + 10);
  message(db, EXTRA.before1, org, OTHER_AUTHOR, 'context before one from the other author', ARCHIVE_NOW + 20);
  message(db, EXTRA.target, org, ARCHIVE_AUTHOR, 'context target rollout decision', ARCHIVE_NOW + 30);
  message(db, EXTRA.after1, org, ARCHIVE_AUTHOR, 'context after one', ARCHIVE_NOW + 40);
  message(db, EXTRA.after2, org, ARCHIVE_AUTHOR, 'context after two', ARCHIVE_NOW + 50);
  message(db, EXTRA.tombstoned, org, ARCHIVE_AUTHOR, 'tombstoned billing decision', ARCHIVE_NOW + 35);
  db.prepare(
    'INSERT INTO message_tombstones (message_id, channel_id, workspace_id, deleted_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?)',
  ).run(EXTRA.tombstoned, org, ARCHIVE_GUILD, ARCHIVE_NOW + 36, ARCHIVE_NOW + 36);
  message(db, EXTRA.deleted, org, ARCHIVE_AUTHOR, 'deleted billing decision', ARCHIVE_NOW + 37);
  db.prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?').run(ARCHIVE_NOW + 38, EXTRA.deleted);
  // A private thread stored as org before private threads defaulted to restricted.
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, kind, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms, is_private_thread)
     VALUES (?, ?, ?, 'thread', 'secret-thread', 1, 0, 0, 1, 'org', 0, ?, ?, 1)`,
  ).run(EXTRA.privateThread, ARCHIVE_GUILD, org, ARCHIVE_NOW, ARCHIVE_NOW);
  message(db, EXTRA.privateThreadMessage, EXTRA.privateThread, ARCHIVE_AUTHOR, 'private thread billing decision', ARCHIVE_NOW + 60);
  memory(db, MEMORY_RESTRICTED_EVIDENCE, [ARCHIVE_MESSAGES.org, ARCHIVE_MESSAGES.restricted]);
  memory(db, MEMORY_TWO_EVIDENCE, [ARCHIVE_MESSAGES.org, EXTRA.target]);
}

function setup(): ArchiveReader {
  fixture = createArchiveFixture({ mutate: seedExtras });
  live = createTestDb();
  archiveDb = openArchiveDatabase(fixture.path);
  const summary = verifyArchive(archiveDb, fixture.path, { platform: 'discord', newestSchemaVersion: 1_000 });
  return createArchiveReader({ db: archiveDb, liveDb: live.db, summary });
}

function redact(kind: 'message' | 'user', target: string): void {
  live!.db.prepare(
    `INSERT INTO archive_redactions (id, archive_workspace_id, target_kind, target_id, archive_sha256, created_at_ms)
     VALUES (?, ?, ?, ?, 'audit-only', 1)`,
  ).run(`r-${kind}-${target}`, ARCHIVE_GUILD, kind, target);
}

const NOT_SERVABLE = [
  ARCHIVE_MESSAGES.restricted,
  ARCHIVE_MESSAGES.reviewOnly,
  ARCHIVE_MESSAGES.excluded,
  ARCHIVE_MESSAGES.testSurface,
  ARCHIVE_MESSAGES.restrictedThread,
  ARCHIVE_MESSAGES.boundary,
  EXTRA.tombstoned,
  EXTRA.deleted,
  EXTRA.privateThreadMessage,
];

const rawIds = (rows: Array<{ messageId: string }>): string[] => rows.map((r) => r.messageId).sort();

describe('ARCHIVE_GRANT', () => {
  it('is frozen and allows org content only', () => {
    expect(ARCHIVE_GRANT).toEqual({ includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] });
    expect(Object.isFrozen(ARCHIVE_GRANT)).toBe(true);
    expect(Object.isFrozen(ARCHIVE_GRANT.channelIds)).toBe(true);
  });
});

describe('searchArchiveMessages', () => {
  it('returns only servable org messages, including org threads', () => {
    const reader = setup();
    const ids = rawIds(searchArchiveMessages(reader, { query: 'billing decision', limit: 50 }));
    expect(ids).toEqual([ARCHIVE_MESSAGES.org, ARCHIVE_MESSAGES.orgThread].sort());
    for (const id of NOT_SERVABLE) expect(ids).not.toContain(id);
  });

  it('labels every result as archive content with an archive id and a Discord link, also when Slack is live', () => {
    const reader = setup();
    useMessageLinkBuilder(() => 'https://example.slack.com/archives/live');
    const [row] = searchArchiveMessages(reader, { query: 'archived org billing', limit: 1 });
    expect(row).toMatchObject({
      id: `archive:${ARCHIVE_MESSAGES.org}`,
      messageId: ARCHIVE_MESSAGES.org,
      link: `https://discord.com/channels/${ARCHIVE_GUILD}/${ARCHIVE_CHANNELS.org}/${ARCHIVE_MESSAGES.org}`,
      source: { platform: 'discord', label: 'archive', createdAtMs: ARCHIVE_NOW },
    });
  });

  it('hides a redacted message and every message by a redacted user', () => {
    const reader = setup();
    redact('message', ARCHIVE_MESSAGES.org);
    expect(rawIds(searchArchiveMessages(reader, { query: 'billing decision', limit: 50 }))).toEqual([ARCHIVE_MESSAGES.orgThread]);
    redact('user', ARCHIVE_AUTHOR);
    expect(searchArchiveMessages(reader, { query: 'billing decision', limit: 50 })).toEqual([]);
    expect(rawIds(searchArchiveMessages(reader, { query: 'context', limit: 50 }))).toEqual([EXTRA.before1]);
  });

  it('returns nothing when the redactions cannot be loaded, and logs it', () => {
    const reader = setup();
    const warnings: unknown[] = [];
    live!.db.exec('DROP TABLE archive_redactions');
    const failing = { ...reader, logger: { warn: (o: unknown) => { warnings.push(o); } } };
    expect(searchArchiveMessages(failing, { query: 'billing decision', limit: 50 })).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ event: 'platform_archive.redactions_unavailable' })]);
  });

  it('treats FTS syntax in the query as plain words', () => {
    const reader = setup();
    for (const query of ['" OR 1=1 --', 'billing* NEAR(decision) ^restricted', 'content:leadership', '"', '***', '']) {
      const ids = rawIds(searchArchiveMessages(reader, { query, limit: 50 }));
      for (const id of NOT_SERVABLE) expect(ids).not.toContain(id);
    }
    expect(searchArchiveMessages(reader, { query: '', limit: 50 })).toEqual([]);
  });

  it('clamps the limit and filters by time', () => {
    const reader = setup();
    expect(searchArchiveMessages(reader, { query: 'context', limit: 2 })).toHaveLength(2);
    expect(rawIds(searchArchiveMessages(reader, { query: 'context', limit: 50, afterMs: ARCHIVE_NOW + 35 })))
      .toEqual([EXTRA.after1, EXTRA.after2]);
  });
});

describe('getArchiveMessageContext', () => {
  it('returns the servable neighbours of a servable message', () => {
    const reader = setup();
    const ctx = getArchiveMessageContext(reader, `archive:${EXTRA.target}`, { before: 5, after: 5 });
    expect(ctx?.target.messageId).toBe(EXTRA.target);
    expect(rawIds(ctx!.before)).toEqual([ARCHIVE_MESSAGES.org, EXTRA.before2, EXTRA.before1].sort());
    expect(rawIds(ctx!.after)).toEqual([EXTRA.after1, EXTRA.after2]);
    expect(rawIds([...ctx!.before, ...ctx!.after])).not.toContain(EXTRA.tombstoned);
    expect(rawIds([...ctx!.before, ...ctx!.after])).not.toContain(EXTRA.deleted);
  });

  it('drops redacted neighbours and refuses a redacted target', () => {
    const reader = setup();
    redact('user', OTHER_AUTHOR);
    redact('message', EXTRA.after1);
    const ctx = getArchiveMessageContext(reader, `archive:${EXTRA.target}`, { before: 5, after: 5 });
    expect(rawIds(ctx!.before)).not.toContain(EXTRA.before1);
    expect(rawIds(ctx!.after)).toEqual([EXTRA.after2]);
    expect(getArchiveMessageContext(reader, `archive:${EXTRA.after1}`, { before: 1, after: 1 })).toBeNull();
  });

  it.each(NOT_SERVABLE)('refuses a target that is not servable org content (%s)', (id) => {
    const reader = setup();
    expect(getArchiveMessageContext(reader, `archive:${id}`, { before: 2, after: 2 })).toBeNull();
  });

  it.each(['300000000000000110', 'archive:not-an-id', 'archive:', 'live:300000000000000110'])(
    'refuses an id without a valid archive prefix (%s)', (id) => {
      const reader = setup();
      expect(getArchiveMessageContext(reader, id, { before: 1, after: 1 })).toBeNull();
    },
  );
});

describe('archive memories', () => {
  it('returns only active org memories whose evidence is all servable', () => {
    const reader = setup();
    const ids = searchArchiveMemories(reader, { query: 'archived decision', limit: 50 }).map((m) => m.memoryId).sort();
    expect(ids).toEqual([ARCHIVE_MEMORIES.org, MEMORY_TWO_EVIDENCE].sort());
    expect(ids).not.toContain(ARCHIVE_MEMORIES.channel);
    expect(ids).not.toContain(ARCHIVE_MEMORIES.reviewOnly);
    expect(ids).not.toContain(ARCHIVE_MEMORIES.superseded);
    expect(ids).not.toContain(MEMORY_RESTRICTED_EVIDENCE);
  });

  it('lists the newest servable memories without a query', () => {
    const reader = setup();
    const ids = searchArchiveMemories(reader, { limit: 50 }).map((m) => m.memoryId).sort();
    expect(ids).toEqual([ARCHIVE_MEMORIES.org, MEMORY_TWO_EVIDENCE].sort());
  });

  it('hides a memory when any of its evidence is redacted, directly or by author', () => {
    const reader = setup();
    redact('message', EXTRA.target);
    expect(searchArchiveMemories(reader, { limit: 50 }).map((m) => m.memoryId)).toEqual([ARCHIVE_MEMORIES.org]);
    expect(getArchiveMemoryEvidence(reader, `archive:${MEMORY_TWO_EVIDENCE}`)).toBeNull();
    redact('user', ARCHIVE_AUTHOR);
    expect(searchArchiveMemories(reader, { limit: 50 })).toEqual([]);
  });

  it('returns the evidence of a servable memory with archive labels and links', () => {
    const reader = setup();
    const result = getArchiveMemoryEvidence(reader, `archive:${MEMORY_TWO_EVIDENCE}`);
    expect(result?.memory).toMatchObject({ id: `archive:${MEMORY_TWO_EVIDENCE}`, source: { platform: 'discord', label: 'archive' } });
    expect(rawIds(result!.evidence)).toEqual([ARCHIVE_MESSAGES.org, EXTRA.target].sort());
    for (const row of result!.evidence) expect(row.link).toMatch(/^https:\/\/discord\.com\/channels\/300000000000000001\//);
  });

  it.each([ARCHIVE_MEMORIES.channel, ARCHIVE_MEMORIES.reviewOnly, ARCHIVE_MEMORIES.superseded, MEMORY_RESTRICTED_EVIDENCE])(
    'refuses evidence for a memory that is not servable (%s)', (id) => {
      const reader = setup();
      expect(getArchiveMemoryEvidence(reader, `archive:${id}`)).toBeNull();
    },
  );
});

describe('the archive file', () => {
  it('does not change while every read function runs', () => {
    const reader = setup();
    const before = createHash('sha256').update(readFileSync(fixture!.path)).digest('hex');
    searchArchiveMessages(reader, { query: 'billing', limit: 50 });
    getArchiveMessageContext(reader, `archive:${EXTRA.target}`, { before: 5, after: 5 });
    searchArchiveMemories(reader, { query: 'decision', limit: 50 });
    getArchiveMemoryEvidence(reader, `archive:${ARCHIVE_MEMORIES.org}`);
    expect(createHash('sha256').update(readFileSync(fixture!.path)).digest('hex')).toBe(before);
  });
});
