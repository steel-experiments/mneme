import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  searchMessages,
  listRecentMessages,
  sanitizeFtsQuery,
  type RetrievalGrant,
} from '../../src/db/repositories/message-search.js';
import { messageLink } from '../../src/platform/links.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const NOW = 1_700_000_001_000;

let env: TestDb;

type Vis = 'org' | 'restricted' | 'review_only' | 'excluded';
function seedChannel(
  id: string,
  visibility: Vis,
  opts: { parent?: string; isThread?: boolean } = {},
): void {
  upsertChannel(env.db, {
    id,
    guildId: GUILD,
    parentId: opts.parent ?? null,
    kind: opts.isThread ? 'thread' : 'text',
    name: id,
    topic: null,
    position: null,
    isThread: opts.isThread ?? false,
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

function addMessage(id: string, channel: string, content: string, atMs = NOW): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: channel,
    authorId: USER,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: atMs,
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
    ingestedAtMs: atMs,
    updatedAtMs: atMs,
  });
}

function idsOf(results: { messageId: string }[]): Set<string> {
  return new Set(results.map((r) => r.messageId));
}

// Channel ids deliberately carry their visibility class for readability.
const ORG = 'org-channel-1';
const RA = 'restricted-A';
const RB = 'restricted-B';
const REV = 'review-only-1';
const EXC = 'excluded-1';
const THREAD_A = 'thread-under-A';

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
const CHANNEL_A_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RA],
};
const REVIEW_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: true,
  channelIds: [RA, RB],
};
const EMPTY_GRANT: RetrievalGrant = { includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] };

describe('scoped message search', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    seedChannel(ORG, 'org');
    seedChannel(RA, 'restricted');
    seedChannel(RB, 'restricted');
    seedChannel(REV, 'review_only');
    seedChannel(EXC, 'excluded');
    seedChannel(THREAD_A, 'restricted', { parent: RA, isThread: true });

    // One matching message per channel.
    addMessage('m-org', ORG, 'We launched the onboarding trial today.');
    addMessage('m-ra', RA, 'Onboarding trial approval needs sign-off.');
    addMessage('m-rb', RB, 'Onboarding trial metrics look weak.');
    addMessage('m-rev', REV, 'Onboarding trial flagged for review.');
    addMessage('m-exc', EXC, 'Onboarding trial excluded discussion.');
    addMessage('m-thread', THREAD_A, 'Onboarding trial thread detail.');
  });

  it('an org grant returns only org messages', () => {
    const r = searchMessages(env.db, ORG_GRANT, { query: 'onboarding' });
    expect(idsOf(r)).toEqual(new Set(['m-org']));
  });

  it('a restricted-channel grant includes that channel and its threads, not siblings', () => {
    const r = searchMessages(env.db, CHANNEL_A_GRANT, { query: 'onboarding' });
    expect(idsOf(r)).toEqual(new Set(['m-org', 'm-ra', 'm-thread']));
    expect(idsOf(r).has('m-rb')).toBe(false);
    expect(idsOf(r).has('m-rev')).toBe(false);
  });

  it('honors explicit thread visibility overrides and anchors a restricted thread below an org parent on itself', () => {
    const orgParent = 'override-org-parent';
    const restrictedThread = 'override-restricted-thread';
    const restrictedParent = 'override-restricted-parent';
    const orgThread = 'override-org-thread';
    seedChannel(orgParent, 'org');
    seedChannel(restrictedThread, 'restricted', { parent: orgParent, isThread: true });
    seedChannel(restrictedParent, 'restricted');
    seedChannel(orgThread, 'org', { parent: restrictedParent, isThread: true });
    addMessage('m-explicit-restricted-thread', restrictedThread, 'override privacy marker');
    addMessage('m-explicit-org-thread', orgThread, 'override privacy marker');

    const orgIds = idsOf(searchMessages(env.db, ORG_GRANT, { query: 'override privacy' }));
    expect(orgIds.has('m-explicit-restricted-thread')).toBe(false);
    expect(orgIds.has('m-explicit-org-thread')).toBe(true);

    const parentGrant: RetrievalGrant = {
      includeOrgMessages: true, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [orgParent],
    };
    expect(idsOf(searchMessages(env.db, parentGrant, { query: 'override privacy' })).has(
      'm-explicit-restricted-thread',
    )).toBe(false);
    const threadGrant: RetrievalGrant = { ...parentGrant, channelIds: [restrictedThread] };
    expect(idsOf(searchMessages(env.db, threadGrant, { query: 'override privacy' })).has(
      'm-explicit-restricted-thread',
    )).toBe(true);
  });

  it('a review grant reaches review_only and all granted restricted channels', () => {
    const r = searchMessages(env.db, REVIEW_GRANT, { query: 'onboarding' });
    expect(idsOf(r)).toEqual(new Set(['m-org', 'm-ra', 'm-rb', 'm-rev', 'm-thread']));
  });

  it('never exposes excluded-channel messages under any grant', () => {
    expect(idsOf(searchMessages(env.db, REVIEW_GRANT, { query: 'onboarding' })).has('m-exc')).toBe(
      false,
    );
    // Even a grant that names the excluded channel explicitly cannot surface it:
    // the predicate only admits org / review_only / restricted classes.
    const namingExcluded: RetrievalGrant = {
      includeOrgMessages: true, includeOrgMemories: true,
      includeReviewOnly: true,
      channelIds: [EXC],
    };
    expect(idsOf(searchMessages(env.db, namingExcluded, { query: 'onboarding' })).has('m-exc')).toBe(
      false,
    );
  });

  it('never retrieves Mneme test surfaces or their normally named child threads', () => {
    const testChannel = 'mneme-test-stale';
    const childThread = 'ordinary-test-child';
    seedChannel(testChannel, 'org');
    seedChannel(childThread, 'org', { parent: testChannel, isThread: true });
    addMessage('m-test-surface', testChannel, 'quarantine marker direct');
    addMessage('m-test-child', childThread, 'quarantine marker thread');

    expect(searchMessages(env.db, ORG_GRANT, { query: 'quarantine marker' })).toEqual([]);
    expect(listRecentMessages(env.db, ORG_GRANT, { limit: 20 })).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'm-test-surface' }),
        expect.objectContaining({ messageId: 'm-test-child' }),
      ]),
    );
  });

  it('an empty grant returns nothing (fail closed)', () => {
    expect(searchMessages(env.db, EMPTY_GRANT, { query: 'onboarding' })).toEqual([]);
  });

  it('caller-supplied channelIds can only narrow, never broaden scope', () => {
    // org grant + requested restricted-A must NOT surface restricted-A content.
    const r = searchMessages(env.db, ORG_GRANT, { query: 'onboarding', channelIds: [RA] });
    expect(r).toEqual([]);
    // channel-A grant + requested [RA] keeps only RA among the granted set.
    const r2 = searchMessages(env.db, CHANNEL_A_GRANT, { query: 'onboarding', channelIds: [RA] });
    expect(idsOf(r2)).toEqual(new Set(['m-ra']));
  });

  it('excludes deleted messages', () => {
    env.db.prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?').run(NOW + 1, 'm-ra');
    const r = searchMessages(env.db, CHANNEL_A_GRANT, { query: 'onboarding' });
    expect(idsOf(r).has('m-ra')).toBe(false);
    expect(idsOf(r).has('m-thread')).toBe(true);
  });

  it('ranks by combined Section 30.1 signals (recency + reactions lift a match)', () => {
    const DAY = 86_400_000;
    // Two org messages matching the same term. One is stale with no reactions;
    // the other is recent and reacted — the latter must rank higher.
    addMessage('m-stale', ORG, 'onboarding notes', NOW);
    addMessage('m-fresh', ORG, 'onboarding notes', NOW + 10 * DAY);
    env.db
      .prepare(
        `INSERT INTO reaction_counts (message_id, emoji_key, count, source, updated_at_ms)
         VALUES (?, '👍', 5, 'live', ?)`,
      )
      .run('m-fresh', NOW + 10 * DAY);

    const r = searchMessages(env.db, ORG_GRANT, { query: 'onboarding', now: NOW + 10 * DAY });
    // The recent, reacted message ranks first.
    expect(r[0]!.messageId).toBe('m-fresh');
    // Combined rank is descending (higher is better).
    for (let i = 1; i < r.length; i++) {
      expect(r[i]!.rank).toBeLessThanOrEqual(r[i - 1]!.rank);
    }
  });

  it('caps an oversized request at the hard limit', () => {
    const r = searchMessages(env.db, REVIEW_GRANT, { query: 'onboarding', limit: 999 });
    expect(r.length).toBeLessThanOrEqual(20);
  });

  it('generates host-built Discord jump links', () => {
    const r = searchMessages(env.db, ORG_GRANT, { query: 'onboarding' });
    expect(r[0]!.link).toBe(messageLink(GUILD, ORG, 'm-org'));
    expect(r[0]!.link).toBe('https://discord.com/channels/' + GUILD + '/' + ORG + '/m-org');
  });

  it('filters by author', () => {
    env.db
      .prepare(
        'INSERT INTO users (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms, raw_json) VALUES (?,?,?,0,?,?,NULL)',
      )
      .run('100000000000000099', 'bob', 'Bob', NOW, NOW);
    addMessage('m-org-bob', ORG, 'onboarding again', NOW + 2);
    env.db
      .prepare('UPDATE messages SET author_id = ? WHERE id = ?')
      .run('100000000000000099', 'm-org-bob');
    const r = searchMessages(env.db, ORG_GRANT, {
      query: 'onboarding',
      authorIds: ['100000000000000099'],
    });
    expect(idsOf(r)).toEqual(new Set(['m-org-bob']));
  });

  it('respects the before/after time window', () => {
    const r = searchMessages(env.db, ORG_GRANT, { query: 'onboarding', afterMs: NOW + 1 });
    expect(r).toEqual([]); // the only org message is at NOW
  });

  it('lists recent messages newest-first across permitted org channels without keywords', () => {
    const secondOrg = 'org-channel-2';
    seedChannel(secondOrg, 'org');
    addMessage('m-org-newer', secondOrg, 'A completely unrelated update.', NOW + 2_000);
    addMessage('m-restricted-newer', RA, 'A hidden restricted update.', NOW + 3_000);

    const results = listRecentMessages(env.db, ORG_GRANT, {
      afterMs: NOW - 1,
      beforeMs: NOW + 3_000,
      limit: 20,
    });
    expect(results.map((result) => result.messageId)).toEqual(['m-org-newer', 'm-org']);
    expect(results[0]!.channelName).toBe(secondOrg);
    expect(idsOf(results).has('m-restricted-newer')).toBe(false);
  });

  it('recent-message filters only narrow scope and support exclusive-before pagination', () => {
    addMessage('m-ra-newer', RA, 'Restricted activity.', NOW + 2_000);
    const orgNarrowed = listRecentMessages(env.db, ORG_GRANT, { channelIds: [RA] });
    expect(orgNarrowed).toEqual([]);

    const first = listRecentMessages(env.db, CHANNEL_A_GRANT, { limit: 1 });
    expect(first).toHaveLength(1);
    const second = listRecentMessages(env.db, CHANNEL_A_GRANT, {
      beforeMessageId: first[0]!.messageId,
      limit: 20,
    });
    expect(idsOf(second).has(first[0]!.messageId)).toBe(false);
    expect(idsOf(second).has('m-rb')).toBe(false);
    expect(idsOf(second).has('m-rev')).toBe(false);
    expect(idsOf(second).has('m-exc')).toBe(false);
    expect(listRecentMessages(env.db, ORG_GRANT, { beforeMessageId: 'm-ra-newer' })).toEqual([]);
  });
});

describe('sanitizeFtsQuery', () => {
  it('quotes each token as a literal phrase', () => {
    expect(sanitizeFtsQuery('onboarding trial')).toBe('"onboarding" "trial"');
  });

  it('strips operator characters and embedded quotes', () => {
    expect(sanitizeFtsQuery('on*"board')).toBe('"on" "board"');
    expect(sanitizeFtsQuery('a "b" c')).toBe('"a" "b" "c"');
  });

  it('returns empty for blank or control-only input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('""')).toBe('');
  });
});
