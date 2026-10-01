import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { createMemory, type RetrievalGrant } from '../../src/memory/repository.js';
import {
  searchMemories,
  listMemories,
  listMemoriesPage,
  MAX_MEMORY_LIMIT,
  MEMORY_INVENTORY_CANDIDATE_CAP,
  getMemoryDetails,
  getMemoryEvidence,
} from '../../src/memory/search.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const NOW = 1_700_000_001_000;

let env: TestDb;

const ORG = 'org-c';
const RA = 'restricted-A';
const RB = 'restricted-B';

function seedChannel(
  id: string,
  visibility: 'org' | 'restricted' | 'review_only',
  options: { parentId?: string; isThread?: boolean } = {},
): void {
  upsertChannel(env.db, {
    id,
    guildId: GUILD,
    parentId: options.parentId ?? null,
    kind: options.isThread ? 'thread' : 'text',
    name: id,
    topic: null,
    position: null,
    isThread: options.isThread ?? false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: visibility,
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  });
}

function addMessage(id: string, channel: string, content: string): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: channel,
    authorId: USER,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: NOW,
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
    ingestedAtMs: NOW,
    updatedAtMs: NOW,
  });
}

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
const CHANNEL_A_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RA],
};
const CHANNEL_AB_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RA, RB],
};
const REVIEW_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: true,
  channelIds: [RA, RB],
};

function idsOf(r: { memoryId: string }[]): Set<string> {
  return new Set(r.map((x) => x.memoryId));
}

describe('scoped memory search', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    seedChannel(ORG, 'org');
    seedChannel(RA, 'restricted');
    seedChannel(RB, 'restricted');
    addMessage('e-org', ORG, 'onboarding trial decision evidence');
    addMessage('e-ra', RA, 'onboarding restricted evidence');
    addMessage('e-rb', RB, 'onboarding other restricted evidence');
  });

  it('returns org memories to an org grant', () => {
    const id = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Adopt the onboarding trial.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    const r = searchMemories(env.db, ORG_GRANT, { query: 'onboarding', now: NOW });
    expect(idsOf(r).has(id)).toBe(true);
  });

  it('quarantines stale memories when evidence becomes a Mneme test surface', () => {
    const testChannel = 'legacy-test-memory-source';
    seedChannel(testChannel, 'org');
    addMessage('e-legacy-test-memory', testChannel, 'legacy quarantine decision evidence');
    const id = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Legacy quarantine decision.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-legacy-test-memory', stance: 'origin' }],
      now: NOW,
    });
    env.db.prepare('UPDATE channels SET name = ? WHERE id = ?')
      .run('mneme-test-renamed', testChannel);

    expect(idsOf(searchMemories(env.db, ORG_GRANT, { query: 'quarantine', now: NOW })).has(id))
      .toBe(false);
    expect(idsOf(listMemories(env.db, ORG_GRANT, { now: NOW })).has(id)).toBe(false);
    expect(getMemoryDetails(env.db, REVIEW_GRANT, id)).toMatchObject({
      memoryId: id,
      scopeType: 'review_only',
    });
    expect(getMemoryEvidence(env.db, REVIEW_GRANT, id)).toEqual([]);
  });

  it.each([
    ['memory', 'Adopt the organizational memory retention policy.'],
    ['memories', 'These memories describe the retained onboarding policy.'],
    ['remember', 'Remember the retained onboarding policy.'],
    ['what do you remember', 'What do you remember about the retained onboarding policy?'],
    ['what do you know', 'What do you know about the retained onboarding policy?'],
    ['What do you remember?', 'What do you remember about the retained onboarding policy?'],
  ])('keeps former inventory alias %j as a literal FTS query', (query, statement) => {
    const literalId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement,
      confidence: 0.8,
      importance: 0.6,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    const unrelatedId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'risk',
      statement: 'Vendor concentration could delay onboarding.',
      confidence: 0.8,
      importance: 1,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW + 1,
    });

    const literal = searchMemories(env.db, ORG_GRANT, { query, now: NOW + 2 });
    expect(idsOf(literal)).toEqual(new Set([literalId]));
    expect(idsOf(literal).has(unrelatedId)).toBe(false);
  });

  it('keeps exact and surrounding-whitespace * as a filtered inventory compatibility alias', () => {
    createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Keep active onboarding guidance.',
      confidence: 0.8,
      importance: 1,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    const lowerRiskId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'risk',
      statement: 'Resolved lower-priority onboarding risk.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW + 1,
    });
    const topRiskId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'risk',
      statement: 'Resolved top-priority onboarding risk.',
      confidence: 0.8,
      importance: 0.9,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW + 2,
    });
    env.db
      .prepare("UPDATE memories SET status = 'resolved' WHERE id IN (?, ?)")
      .run(lowerRiskId, topRiskId);

    const filters = {
      types: ['risk'] as const,
      statuses: ['resolved'] as const,
      limit: 1,
      now: NOW + 3,
    };
    const listed = listMemories(env.db, ORG_GRANT, filters);
    expect(idsOf(listed)).toEqual(new Set([topRiskId]));
    expect(listMemoriesPage(env.db, ORG_GRANT, filters)).toMatchObject({
      totalMatching: 2,
      returned: 1,
      hasMore: true,
    });

    for (const query of ['*', '  *\n']) {
      const compatibility = searchMemories(env.db, ORG_GRANT, { query, ...filters });
      expect(idsOf(compatibility)).toEqual(idsOf(listed));
      expect(compatibility).toHaveLength(1);
      expect(compatibility[0]).toMatchObject({ type: 'risk', status: 'resolved' });
    }
  });

  it('listMemories defaults to active records and honors explicit lifecycle filters', () => {
    const activeId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Keep active onboarding guidance.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    const resolvedId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'risk',
      statement: 'Resolved onboarding migration risk.',
      confidence: 0.8,
      importance: 0.9,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW + 1,
    });
    env.db.prepare("UPDATE memories SET status = 'resolved' WHERE id = ?").run(resolvedId);

    expect(idsOf(listMemories(env.db, ORG_GRANT, { now: NOW + 2 }))).toEqual(
      new Set([activeId]),
    );
    const resolved = listMemories(env.db, ORG_GRANT, {
      statuses: ['resolved'],
      types: ['risk'],
      now: NOW + 2,
    });
    expect(idsOf(resolved)).toEqual(new Set([resolvedId]));
  });

  it('listMemories applies effective scope for org, channel, and review grants', () => {
    const orgId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Visible org inventory item.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    const restrictedId = createMemory(env.db, CHANNEL_A_GRANT, {
      guildId: GUILD,
      type: 'risk',
      statement: 'Restricted inventory item.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-ra', stance: 'origin' }],
      now: NOW + 1,
    });
    const reviewOnlyId = createMemory(env.db, CHANNEL_AB_GRANT, {
      guildId: GUILD,
      type: 'constraint',
      statement: 'Cross-channel review inventory item.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [
        { messageId: 'e-ra', stance: 'origin' },
        { messageId: 'e-rb', stance: 'supports' },
      ],
      now: NOW + 2,
    });

    expect(idsOf(listMemories(env.db, ORG_GRANT, { now: NOW + 3 }))).toEqual(
      new Set([orgId]),
    );
    expect(idsOf(listMemories(env.db, CHANNEL_A_GRANT, { now: NOW + 3 }))).toEqual(
      new Set([orgId, restrictedId]),
    );
    expect(idsOf(listMemories(env.db, REVIEW_GRANT, { now: NOW + 3 }))).toEqual(
      new Set([orgId, restrictedId, reviewOnlyId]),
    );
  });

  it('filters inventory visibility before the bounded candidate window', () => {
    const visibleId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Visible lower-priority inventory item.',
      confidence: 0.8,
      importance: 0.1,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    // If scope were applied only after the inventory candidate LIMIT, these
    // higher-priority hidden rows would starve the visible item.
    for (let i = 0; i < MEMORY_INVENTORY_CANDIDATE_CAP; i += 1) {
      createMemory(env.db, CHANNEL_A_GRANT, {
        guildId: GUILD,
        type: 'decision',
        statement: `Hidden higher-priority inventory item ${i}.`,
        confidence: 0.8,
        importance: 1,
        evidence: [{ messageId: 'e-ra', stance: 'origin' }],
        now: NOW + i + 1,
      });
    }

    expect(listMemories(env.db, ORG_GRANT, { limit: 1, now: NOW + 600 })[0]?.memoryId).toBe(
      visibleId,
    );
  });

  it('applies scope filtering before the global FTS candidate cap', () => {
    const visibleId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'candidatecapword',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    for (let i = 0; i < 100; i += 1) {
      createMemory(env.db, CHANNEL_A_GRANT, {
        guildId: GUILD,
        type: 'decision',
        statement: `candidatecapword candidatecapword hidden ${i}`,
        confidence: 0.8,
        importance: 0.7,
        evidence: [{ messageId: 'e-ra', stance: 'origin' }],
        now: NOW + i + 1,
      });
    }
    expect(idsOf(searchMemories(env.db, ORG_GRANT, {
      query: 'candidatecapword', limit: 10, now: NOW + 200,
    })).has(visibleId)).toBe(true);
  });

  it('hides a channel-scoped memory from a grant that cannot see that channel', () => {
    const id = createMemory(env.db, CHANNEL_A_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Restricted onboarding call.',
      confidence: 0.7,
      importance: 0.6,
      evidence: [
        { messageId: 'e-org', stance: 'origin' },
        { messageId: 'e-ra', stance: 'supports' },
      ],
      now: NOW,
    });
    // Channel-A grant sees it (recomputed scope = channel A).
    expect(idsOf(searchMemories(env.db, CHANNEL_A_GRANT, { query: 'onboarding', now: NOW })).has(id)).toBe(
      true,
    );
    // Org grant does not.
    expect(idsOf(searchMemories(env.db, ORG_GRANT, { query: 'onboarding', now: NOW })).has(id)).toBe(
      false,
    );
  });

  it('hides a review_only memory from non-review grants', () => {
    const id = createMemory(env.db, CHANNEL_AB_GRANT, {
      guildId: GUILD,
      type: 'risk',
      statement: 'Cross-channel onboarding risk.',
      confidence: 0.6,
      importance: 0.6,
      evidence: [
        { messageId: 'e-ra', stance: 'origin' },
        { messageId: 'e-rb', stance: 'supports' },
      ],
      now: NOW,
    });
    expect(idsOf(searchMemories(env.db, REVIEW_GRANT, { query: 'onboarding', now: NOW })).has(id)).toBe(
      true,
    );
    expect(
      idsOf(searchMemories(env.db, CHANNEL_A_GRANT, { query: 'onboarding', now: NOW })).has(id),
    ).toBe(false);
  });

  it('CHANNEL RECLASSIFICATION tightens results immediately (no maintenance job)', () => {
    // Start: org-scoped memory, visible to an org grant.
    const id = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Onboarding trial adopted.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    expect(idsOf(searchMemories(env.db, ORG_GRANT, { query: 'onboarding', now: NOW })).has(id)).toBe(
      true,
    );

    // Reclassify the evidence channel org → restricted.
    seedChannel(ORG, 'restricted');

    // The stored scope is still 'org', but read-time recompute now derives
    // 'channel' (scope_key = ORG) which an org grant cannot see.
    expect(idsOf(searchMemories(env.db, ORG_GRANT, { query: 'onboarding', now: NOW })).has(id)).toBe(
      false,
    );
    // ...and a grant that names the channel still sees it.
    const namingGrant: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [ORG] };
    expect(idsOf(searchMemories(env.db, namingGrant, { query: 'onboarding', now: NOW })).has(id)).toBe(
      true,
    );
  });

  it.each(['disabled', 'deleted'] as const)(
    'quarantines a memory when its evidence channel is %s across every read path',
    (state) => {
      const id = createMemory(env.db, ORG_GRANT, {
        guildId: GUILD,
        type: 'decision',
        statement: 'Quarantined onboarding decision.',
        confidence: 0.8,
        importance: 0.9,
        evidence: [{ messageId: 'e-org', stance: 'origin' }],
        now: NOW,
      });
      if (state === 'disabled') {
        env.db.prepare('UPDATE channels SET ingest_enabled = 0 WHERE id = ?').run(ORG);
      } else {
        env.db.prepare('UPDATE channels SET deleted_at_ms = ? WHERE id = ?').run(NOW + 1, ORG);
      }

      expect(listMemories(env.db, ORG_GRANT, { now: NOW + 2 })).toEqual([]);
      expect(searchMemories(env.db, ORG_GRANT, {
        query: 'quarantined',
        now: NOW + 2,
      })).toEqual([]);
      expect(getMemoryDetails(env.db, ORG_GRANT, id)).toBeUndefined();
      expect(getMemoryEvidence(env.db, ORG_GRANT, id)).toEqual([]);

      // Fail-closed quarantine keeps the durable statement repairable only in
      // secure review; inaccessible source content itself is never returned.
      expect(getMemoryDetails(env.db, REVIEW_GRANT, id)).toMatchObject({
        memoryId: id,
        scopeType: 'review_only',
        statement: 'Quarantined onboarding decision.',
      });
      expect(getMemoryEvidence(env.db, REVIEW_GRANT, id)).toEqual([]);
    },
  );

  it('does not let live evidence mask a deleted sibling message in the same channel', () => {
    addMessage('e-org-deleted-sibling', ORG, 'deleted sibling evidence');
    const id = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Mixed-availability evidence decision.',
      confidence: 0.8,
      importance: 0.9,
      evidence: [
        { messageId: 'e-org', stance: 'origin' },
        { messageId: 'e-org-deleted-sibling', stance: 'supports' },
      ],
      now: NOW,
    });
    env.db
      .prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?')
      .run(NOW + 1, 'e-org-deleted-sibling');

    expect(listMemories(env.db, ORG_GRANT, { now: NOW + 2 })).toEqual([]);
    expect(searchMemories(env.db, ORG_GRANT, {
      query: 'mixed availability',
      now: NOW + 2,
    })).toEqual([]);
    expect(getMemoryDetails(env.db, ORG_GRANT, id)).toBeUndefined();
    expect(getMemoryEvidence(env.db, ORG_GRANT, id)).toEqual([]);

    expect(getMemoryDetails(env.db, REVIEW_GRANT, id)).toMatchObject({
      memoryId: id,
      scopeType: 'review_only',
    });
    expect(getMemoryEvidence(env.db, REVIEW_GRANT, id).map((row) => row.messageId)).toEqual([
      'e-org',
    ]);
  });

  it('honors explicit thread visibility overrides and keeps the parent as restricted anchor', () => {
    const orgParent = 'override-org-parent';
    const restrictedThread = 'override-restricted-thread';
    const restrictedParent = 'override-restricted-parent';
    const orgThread = 'override-org-thread';
    seedChannel(orgParent, 'org');
    seedChannel(restrictedThread, 'restricted', { parentId: orgParent, isThread: true });
    seedChannel(restrictedParent, 'restricted');
    seedChannel(orgThread, 'org', { parentId: restrictedParent, isThread: true });
    addMessage('e-explicit-restricted-thread', restrictedThread, 'restricted thread override evidence');
    addMessage('e-explicit-org-thread', orgThread, 'org thread override evidence');

    const parentGrant: RetrievalGrant = {
      includeOrgMessages: true, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [orgParent],
    };
    const restrictedId = createMemory(env.db, parentGrant, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Keep the restricted thread override.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-explicit-restricted-thread', stance: 'origin' }],
      now: NOW,
    });
    expect(searchMemories(env.db, ORG_GRANT, { query: 'restricted override', now: NOW })).toEqual([]);
    expect(getMemoryDetails(env.db, ORG_GRANT, restrictedId)).toBeUndefined();
    expect(getMemoryDetails(env.db, parentGrant, restrictedId)).toMatchObject({
      scopeType: 'channel',
      scopeKey: orgParent,
    });

    const orgId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Keep the org thread override.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-explicit-org-thread', stance: 'origin' }],
      now: NOW,
    });
    expect(idsOf(searchMemories(env.db, ORG_GRANT, { query: 'org override', now: NOW })).has(orgId)).toBe(true);
    expect(getMemoryDetails(env.db, ORG_GRANT, orgId)?.scopeType).toBe('org');

    const mixedId = createMemory(env.db, parentGrant, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Mixed thread overrides stay restricted.',
      confidence: 0.8,
      importance: 0.7,
      // Put org first to prove same-parent evidence is not collapsed before
      // each thread's resolved visibility is considered.
      evidence: [
        { messageId: 'e-explicit-org-thread', stance: 'supports' },
        { messageId: 'e-explicit-restricted-thread', stance: 'origin' },
      ],
      now: NOW,
    });
    expect(getMemoryDetails(env.db, ORG_GRANT, mixedId)).toBeUndefined();
    expect(getMemoryDetails(env.db, parentGrant, mixedId)).toMatchObject({
      scopeType: 'channel',
      scopeKey: orgParent,
    });
  });

  it('quarantines thread evidence when its parent is disabled', () => {
    const parentId = 'disabled-thread-parent';
    const threadId = 'disabled-thread-child';
    seedChannel(parentId, 'org');
    seedChannel(threadId, 'org', { parentId, isThread: true });
    addMessage('e-disabled-thread', threadId, 'thread quarantine evidence');
    const id = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Thread quarantine decision.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: 'e-disabled-thread', stance: 'origin' }],
      now: NOW,
    });

    env.db.prepare('UPDATE channels SET ingest_enabled = 0 WHERE id = ?').run(parentId);

    expect(getMemoryDetails(env.db, ORG_GRANT, id)).toBeUndefined();
    expect(searchMemories(env.db, ORG_GRANT, { query: 'quarantine', now: NOW })).toEqual([]);
    expect(getMemoryEvidence(env.db, REVIEW_GRANT, id)).toEqual([]);
    expect(getMemoryDetails(env.db, REVIEW_GRANT, id)?.scopeType).toBe('review_only');
  });

  it('getMemoryDetails returns the memory only when its scope is permitted', () => {
    const id = createMemory(env.db, CHANNEL_A_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Restricted detail.',
      confidence: 0.7,
      importance: 0.6,
      evidence: [{ messageId: 'e-ra', stance: 'origin' }],
      now: NOW,
    });
    expect(getMemoryDetails(env.db, CHANNEL_A_GRANT, id)?.statement).toBe('Restricted detail.');
    expect(getMemoryDetails(env.db, ORG_GRANT, id)).toBeUndefined();
  });

  it('getMemoryEvidence returns nothing when the memory scope is not permitted', () => {
    const id = createMemory(env.db, CHANNEL_A_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Restricted evidence memory.',
      confidence: 0.7,
      importance: 0.6,
      evidence: [
        { messageId: 'e-org', stance: 'origin' },
        { messageId: 'e-ra', stance: 'supports' },
      ],
      now: NOW,
    });
    expect(getMemoryEvidence(env.db, ORG_GRANT, id)).toEqual([]);
    // Channel-A grant sees both org and restricted-A evidence.
    const ev = getMemoryEvidence(env.db, CHANNEL_A_GRANT, id);
    expect(new Set(ev.map((e) => e.messageId))).toEqual(new Set(['e-org', 'e-ra']));
  });

  it('filters by type and status', () => {
    createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Onboarding decision A.',
      confidence: 0.7,
      importance: 0.6,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'risk',
      statement: 'Onboarding risk B.',
      confidence: 0.7,
      importance: 0.6,
      evidence: [{ messageId: 'e-org', stance: 'origin' }],
      now: NOW,
    });
    const onlyRisks = searchMemories(env.db, ORG_GRANT, {
      query: 'onboarding',
      types: ['risk'],
      now: NOW,
    });
    expect(onlyRisks.every((m) => m.type === 'risk')).toBe(true);
    expect(onlyRisks.length).toBe(1);
  });

  it('caps results at the hard limit', () => {
    for (let i = 0; i < MAX_MEMORY_LIMIT + 5; i++) {
      createMemory(env.db, ORG_GRANT, {
        guildId: GUILD,
        type: 'fact',
        statement: `Onboarding fact ${i}.`,
        confidence: 0.5,
        importance: 0.5,
        evidence: [{ messageId: 'e-org', stance: 'origin' }],
        now: NOW + i,
      });
    }
    const r = searchMemories(env.db, ORG_GRANT, { query: 'onboarding', limit: 999, now: NOW });
    expect(r.length).toBe(MAX_MEMORY_LIMIT);
  });
});
