import { describe, it, expect, afterEach } from 'vitest';
import { type DatabaseSync } from '../../src/db/database.js';
import { createTestDb, seedIdentity } from '../helpers/db.js';
import { forgetMessage } from '../../src/memory/deletion.js';
import { getAdminEvent } from '../../src/db/repositories/admin-events.js';
import { getMemoryDetails } from '../../src/memory/search.js';
import { rescopeMemories } from '../../src/memory/maintenance.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';

/**
 * Forget-message deletion workflow (Sections 27, 42.4, 43).
 *
 * Acceptance: forgotten content is absent from retrieval and archives, derived
 * memory handling is deterministic and fail-closed, and the admin action is
 * auditable without content.
 */

const NOW = 1_700_000_000_000;
const FORGET_NOW = NOW + 1000;

const ORG = '200000000000000001';
const RESTRICTED_A = '200000000000000010';
const RESTRICTED_B = '200000000000000011';
const ORG_GRANT: RetrievalGrant = {
  includeOrgMessages: true,
  includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [],
};
const REVIEW_GRANT: RetrievalGrant = {
  includeOrgMessages: true,
  includeOrgMemories: true,
  includeReviewOnly: true,
  channelIds: [RESTRICTED_A, RESTRICTED_B],
};

let setup: ReturnType<typeof createTestDb> | null = null;
function db(): DatabaseSync {
  setup = createTestDb();
  return setup.db;
}
afterEach(() => {
  setup?.cleanup();
  setup = null;
});

function seedChannel(d: DatabaseSync, id: string, visibility: string, guildId: string): void {
  d.prepare(
    `INSERT INTO channels (id, guild_id, parent_id, type, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
     VALUES (?, ?, NULL, 0, ?, 0, 0, 0, 1, ?, 1, ?, ?)`,
  ).run(id, guildId, id, visibility, NOW, NOW);
}

function seedMessage(
  d: DatabaseSync,
  id: string,
  channelId: string,
  guildId: string,
  authorId: string,
  content: string,
): void {
  d.prepare(
    `INSERT INTO messages (id, guild_id, channel_id, author_id, author_display_name, content,
       created_at_ms, ingested_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'Alice', ?, ?, ?, ?)`,
  ).run(id, guildId, channelId, authorId, content, NOW, NOW, NOW);
}

function seedAttachment(d: DatabaseSync, id: string, messageId: string, path: string | null): void {
  d.prepare(
    `INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, source_url, proxy_url,
       archive_status, local_path, sha256, created_at_ms, updated_at_ms)
     VALUES (?, ?, 'f.txt', 'text/plain', 10, 'https://x/y', 'https://x/y',
       'metadata', ?, 'abc', ?, ?)`,
  ).run(id, messageId, path, NOW, NOW);
}

function seedMemory(
  d: DatabaseSync,
  id: string,
  guildId: string,
  scopeType: string,
  scopeKey: string | null,
  status = 'active',
): void {
  d.prepare(
    `INSERT INTO memories (id, guild_id, scope_type, scope_key, type, statement, status,
       confidence, importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'decision', ?, ?, 0.8, 0.7, ?, ?, ?, ?)`,
  ).run(id, guildId, scopeType, scopeKey, `memory ${id}`, status, NOW, NOW, NOW, NOW);
}

function seedEvidence(
  d: DatabaseSync,
  memoryId: string,
  messageId: string,
  stance = 'origin',
): void {
  d.prepare(
    `INSERT INTO memory_evidence (memory_id, message_id, stance, weight, created_at_ms)
     VALUES (?, ?, ?, 1, ?)`,
  ).run(memoryId, messageId, stance, NOW);
}

function memoryState(d: DatabaseSync, id: string) {
  return d.prepare('SELECT scope_type, scope_key, status FROM memories WHERE id = ?').get(id) as {
    scope_type: string;
    scope_key: string | null;
    status: string;
  };
}

function ftsCount(d: DatabaseSync, term: string): number {
  return Number(
    d.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(term)?.n ?? 0,
  );
}

describe('forgetMessage — content and archive removal', () => {
  it('tombstones the message, purges content, and drops it from FTS', () => {
    const d = db();
    const { guildId, userId } = seedIdentity(d);
    seedChannel(d, ORG, 'org', guildId);
    const SECRET = 'alphaflux-decision-record';
    seedMessage(d, 'm1', ORG, guildId, userId, SECRET);
    seedAttachment(d, 'a1', 'm1', null);

    expect(ftsCount(d, 'alphaflux')).toBe(1);
    const res = forgetMessage(d, { messageId: 'm1', guildId, actorUserId: userId, nowMs: FORGET_NOW });
    expect(res.found).toBe(true);
    expect(res.tombstoned).toBe(true);
    expect(res.attachmentsMarkedDeleted).toBe(1);

    const msg = d.prepare('SELECT content, deleted_at_ms FROM messages WHERE id = ?').get('m1') as {
      content: string;
      deleted_at_ms: number | null;
    };
    expect(msg.content).toBe('');
    expect(msg.deleted_at_ms).toBe(FORGET_NOW);
    expect(ftsCount(d, 'alphaflux')).toBe(0); // absent from retrieval

    const att = d.prepare('SELECT archive_status, local_path FROM attachments WHERE id = ?').get('a1') as {
      archive_status: string;
      local_path: string | null;
    };
    expect(att.archive_status).toBe('deleted'); // absent from archives
    expect(att.local_path).toBeNull();
  });

  it('returns found:false and still records an admin event for an unknown id', () => {
    const d = db();
    const { guildId, userId } = seedIdentity(d);
    const res = forgetMessage(d, { messageId: 'ghost', guildId, actorUserId: userId, nowMs: FORGET_NOW });
    expect(res.found).toBe(false);
    expect(res.tombstoned).toBe(false);
    const ev = getAdminEvent(d, res.adminEventId);
    expect(ev?.action).toBe('forget_message');
    expect(JSON.parse(ev!.detailsJson)).toMatchObject({ found: false });
  });

  it('is idempotent on an already-deleted message', () => {
    const d = db();
    const { guildId, userId } = seedIdentity(d);
    seedChannel(d, ORG, 'org', guildId);
    seedMessage(d, 'm1', ORG, guildId, userId, 'once');
    forgetMessage(d, { messageId: 'm1', guildId, actorUserId: userId, nowMs: FORGET_NOW });
    const again = forgetMessage(d, { messageId: 'm1', guildId, actorUserId: userId, nowMs: FORGET_NOW + 1 });
    expect(again.tombstoned).toBe(false);
  });

  it('records an auditable admin event without message content', () => {
    const d = db();
    const { guildId, userId } = seedIdentity(d);
    seedChannel(d, ORG, 'org', guildId);
    const SECRET = 'topsecret-content-value';
    seedMessage(d, 'm1', ORG, guildId, userId, SECRET);
    const res = forgetMessage(d, { messageId: 'm1', guildId, actorUserId: userId, nowMs: FORGET_NOW });
    const ev = getAdminEvent(d, res.adminEventId);
    expect(ev?.target).toBe('m1');
    expect(ev?.detailsJson).not.toContain(SECRET);
  });
});

describe('forgetMessage — derived memory handling', () => {
  it('invalidates a memory whose only evidence was the forgotten message', () => {
    const d = db();
    const { guildId, userId } = seedIdentity(d);
    seedChannel(d, ORG, 'org', guildId);
    seedMessage(d, 'm1', ORG, guildId, userId, 'evidence one');
    seedMemory(d, 'mem1', guildId, 'org', null);
    seedEvidence(d, 'mem1', 'm1');

    const res = forgetMessage(d, { messageId: 'm1', guildId, actorUserId: userId, nowMs: FORGET_NOW });
    expect(res.memories).toEqual([
      expect.objectContaining({ memoryId: 'mem1', action: 'invalidated', newScopeType: 'review_only' }),
    ]);
    expect(memoryState(d, 'mem1').status).toBe('invalidated');
  });

  it('leaves an org memory in scope when it has other org evidence', () => {
    const d = db();
    const { guildId, userId } = seedIdentity(d);
    seedChannel(d, ORG, 'org', guildId);
    seedMessage(d, 'm1', ORG, guildId, userId, 'evidence one');
    seedMessage(d, 'm2', ORG, guildId, userId, 'evidence two');
    seedMemory(d, 'mem1', guildId, 'org', null);
    seedEvidence(d, 'mem1', 'm1');
    seedEvidence(d, 'mem1', 'm2');

    const res = forgetMessage(d, { messageId: 'm1', guildId, actorUserId: userId, nowMs: FORGET_NOW });
    expect(res.memories[0]?.action).toBe('evidence_removed');
    expect(memoryState(d, 'mem1')).toMatchObject({ scope_type: 'org', status: 'active' });
    // The link to the forgotten message is gone; the other evidence remains.
    const remaining = d.prepare('SELECT count(*) AS n FROM memory_evidence WHERE memory_id = ?').get('mem1')?.n;
    expect(remaining).toBe(1);
  });

  it('routes to review instead of broadening scope when restricted evidence is removed', () => {
    const d = db();
    const { guildId, userId } = seedIdentity(d);
    seedChannel(d, ORG, 'org', guildId);
    seedChannel(d, RESTRICTED_A, 'restricted', guildId);
    seedMessage(d, 'org1', ORG, guildId, userId, 'org evidence');
    seedMessage(d, 'rest1', RESTRICTED_A, guildId, userId, 'restricted evidence');
    // Channel-scoped memory (one restricted channel + org).
    seedMemory(d, 'mem1', guildId, 'channel', RESTRICTED_A);
    seedEvidence(d, 'mem1', 'org1');
    seedEvidence(d, 'mem1', 'rest1');

    const res = forgetMessage(d, { messageId: 'rest1', guildId, actorUserId: userId, nowMs: FORGET_NOW });
    expect(res.memories[0]?.action).toBe('routed_to_review');
    expect(memoryState(d, 'mem1').scope_type).toBe('review_only'); // not promoted to org
    expect(getMemoryDetails(d, ORG_GRANT, 'mem1')).toBeUndefined();
    expect(getMemoryDetails(d, REVIEW_GRANT, 'mem1')?.statement).toBe('memory mem1');

    const maintenance = rescopeMemories(d, {
      affectedChannelIds: null,
      actorUserId: 'system-mneme',
      guildId,
      now: FORGET_NOW + 1,
    });
    expect(maintenance.changed).toBe(0);
    expect(memoryState(d, 'mem1').scope_type).toBe('review_only');
    expect(getMemoryDetails(d, ORG_GRANT, 'mem1')).toBeUndefined();
  });

  it('keeps a channel-scoped memory in scope when a same-channel evidence row is removed', () => {
    const d = db();
    const { guildId, userId } = seedIdentity(d);
    seedChannel(d, RESTRICTED_A, 'restricted', guildId);
    seedMessage(d, 'ra1', RESTRICTED_A, guildId, userId, 'restricted one');
    seedMessage(d, 'ra2', RESTRICTED_A, guildId, userId, 'restricted two');
    seedMemory(d, 'mem1', guildId, 'channel', RESTRICTED_A);
    seedEvidence(d, 'mem1', 'ra1');
    seedEvidence(d, 'mem1', 'ra2');

    const res = forgetMessage(d, { messageId: 'ra1', guildId, actorUserId: userId, nowMs: FORGET_NOW });
    expect(res.memories[0]?.action).toBe('evidence_removed');
    expect(memoryState(d, 'mem1')).toMatchObject({ scope_type: 'channel', scope_key: RESTRICTED_A });
  });

  it('does not re-invalidate a memory already in a terminal status', () => {
    const d = db();
    const { guildId, userId } = seedIdentity(d);
    seedChannel(d, ORG, 'org', guildId);
    seedMessage(d, 'm1', ORG, guildId, userId, 'only evidence');
    seedMemory(d, 'mem1', guildId, 'org', null, 'resolved');
    seedEvidence(d, 'mem1', 'm1');

    const res = forgetMessage(d, { messageId: 'm1', guildId, actorUserId: userId, nowMs: FORGET_NOW });
    expect(res.memories[0]?.action).toBe('evidence_removed');
    expect(memoryState(d, 'mem1').status).toBe('resolved');
  });
});
