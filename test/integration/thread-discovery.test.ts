import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { getChannel } from '../../src/db/repositories/channels.js';
import { parseChannelPolicy } from '../../src/policy/channel-policy.js';
import {
  discoverThreads,
  fetchArchivedThreads,
  extractActiveThreads,
  isThreadCapableParent,
  formatArchivedPrivateCoverageWarning,
  type ThreadArchiveSource,
  type ArchivedThreadPage,
} from '../../src/ingestion/threads.js';
import {
  type DiscoveredChannelDescriptor,
} from '../../src/ingestion/discovery.js';
import type { ChannelAccessCapabilities } from '../../src/db/repositories/channel-access.js';
import type { ChannelKind } from '../../src/platform/types.js';

/** Neutral channel kinds, named after the Discord channel types they replace. */
const GUILD_TEXT = 'text' as const;
const GUILD_FORUM = 'forum' as const;
const GUILD_CATEGORY = 'category' as const;
const PUBLIC_THREAD = 'thread' as const;
const ANNOUNCEMENT_THREAD = 'thread' as const;
const PRIVATE_THREAD = 'thread' as const;


/**
 * Active and archived thread discovery (Sections 6.5, 7.1, 9.7).
 */

const GUILD = '100000000000000001';
const NOW = 1_700_000_001_000;

const FULL: ChannelAccessCapabilities = {
  canView: true,
  canReadHistory: true,
  canSend: true,
  canSendInThreads: true,
  canManageThreads: true,
};

// Parents.
const CAT = '300000000000000001';
const TEXT = '300000000000000002';
const ANNOUNCE = '300000000000000003';
const FORUM = '300000000000000005';
const MEDIA = '300000000000000006';
// Threads.
const ACTIVE_PUBLIC = '300000000000000101';
const PUBLIC_ARCHIVED = '300000000000000102';
const PRIVATE_ARCHIVED = '300000000000000103';
const FORUM_POST = '300000000000000104';
const MEDIA_POST = '300000000000000105';

const POLICY_YAML = `
version: 1
default:
  ingest: true
  visibility: restricted
  allow_interventions: false
categories:
  "${CAT}":
    ingest: true
    visibility: org
    allow_interventions: true
channels:
  "${FORUM}":
    ingest: true
    visibility: restricted
    allow_interventions: false
`;

function parentDescriptors(): DiscoveredChannelDescriptor[] {
  return [
    { id: CAT, parentId: null, kind: 'category', name: 'Engineering' },
    { id: TEXT, parentId: CAT, kind: 'text', name: 'general', capabilities: FULL },
    { id: ANNOUNCE, parentId: CAT, kind: 'announcement', name: 'news', capabilities: FULL },
    { id: FORUM, parentId: null, kind: 'forum', name: 'forum', capabilities: FULL },
    { id: MEDIA, parentId: CAT, kind: 'media', name: 'media', capabilities: FULL },
  ];
}

function threadDescriptor(id: string, parentId: string, kind: ChannelKind, archived = true): DiscoveredChannelDescriptor {
  return { id, parentId, kind, name: id, archived, capabilities: FULL };
}

function page(threads: DiscoveredChannelDescriptor[], hasMore = false): ArchivedThreadPage {
  return { threads, hasMore };
}

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

describe('thread helpers', () => {
  it('identifies thread-capable parents and extracts active threads', () => {
    expect(isThreadCapableParent(GUILD_TEXT)).toBe(true);
    expect(isThreadCapableParent(GUILD_FORUM)).toBe(true);
    expect(isThreadCapableParent(GUILD_CATEGORY)).toBe(false);
    const active = extractActiveThreads([
      { id: '1', parentId: null, kind: 'text' },
      { id: '2', parentId: '1', kind: 'thread' },
      { id: '3', parentId: '1', kind: 'thread' },
    ]);
    expect(active.map((t) => t.id)).toEqual(['2', '3']);
  });

  it('formats the archived-private coverage warning', () => {
    expect(formatArchivedPrivateCoverageWarning()).toMatch(/Manage Threads/);
  });
});

describe('fetchArchivedThreads pagination', () => {
  function makeSource(
    publicByParent: Record<string, ArchivedThreadPage[]>,
    privateByParent: Record<string, ArchivedThreadPage[]> = {},
  ): ThreadArchiveSource & { publicCalls: number; privateCalls: number } {
    const state: Record<string, { pub: number; priv: number }> = {};
    const src: ThreadArchiveSource & { publicCalls: number; privateCalls: number } = {
      publicCalls: 0,
      privateCalls: 0,
      fetchPublicArchived(parentId: string) {
        src.publicCalls += 1;
        const pages = publicByParent[parentId] ?? [];
        const idx = (state[parentId] ?? (state[parentId] = { pub: 0, priv: 0 })).pub++;
        return pages[Math.min(idx, pages.length - 1)] ?? page([]);
      },
      fetchPrivateArchived(parentId: string) {
        src.privateCalls += 1;
        const pages = privateByParent[parentId] ?? [];
        const idx = (state[parentId] ?? (state[parentId] = { pub: 0, priv: 0 })).priv++;
        return pages[Math.min(idx, pages.length - 1)] ?? page([]);
      },
    };
    return src;
  }

  it('paginates public then private until hasMore is false', async () => {
    const t1 = threadDescriptor('300000000000000201', TEXT, PUBLIC_THREAD);
    const t2 = threadDescriptor('300000000000000202', TEXT, PUBLIC_THREAD);
    const p1 = threadDescriptor('300000000000000203', TEXT, PRIVATE_THREAD);
    const source = makeSource(
      { [TEXT]: [page([t1], true), page([t2], false)] },
      { [TEXT]: [page([p1], false)] },
    );

    const result = await fetchArchivedThreads(source, [{ id: TEXT, kind: 'text' }], {
      canManageThreads: true,
      maxPagesPerEndpoint: 50,
    });

    expect(result.threads.map((t) => t.id).sort()).toEqual(['300000000000000201', '300000000000000202', '300000000000000203']);
    // public: 2 pages (hasMore true then false); private: 1 page.
    expect(result.pages).toBe(3);
    expect(result.privateCoverageIncomplete).toBe(false);
    expect(result.paginationCoverageIncomplete).toBe(false);
    expect(result.coverageComplete).toBe(true);
  });

  it('skips private archived and flags coverage when Manage Threads is absent', async () => {
    const t1 = threadDescriptor('300000000000000201', TEXT, PUBLIC_THREAD);
    const source = makeSource({ [TEXT]: [page([t1], false)] }, { [TEXT]: [page([threadDescriptor('300000000000000203', TEXT, PRIVATE_THREAD)], false)] });

    const result = await fetchArchivedThreads(source, [{ id: TEXT, kind: 'text' }], {
      canManageThreads: false,
      maxPagesPerEndpoint: 50,
    });

    expect(result.threads.map((t) => t.id)).toEqual(['300000000000000201']);
    expect(source.privateCalls).toBe(0);
    expect(result.privateCoverageIncomplete).toBe(true);
    expect(result.coverageComplete).toBe(false);
  });

  it('respects the maxPagesPerEndpoint bound as a runaway guard', async () => {
    // hasMore never becomes false; the bound must stop pagination.
    const t = threadDescriptor('300000000000000201', TEXT, PUBLIC_THREAD);
    const source = makeSource({ [TEXT]: [page([t], true)] });
    const result = await fetchArchivedThreads(source, [{ id: TEXT, kind: 'text' }], {
      canManageThreads: false,
      maxPagesPerEndpoint: 3,
    });
    expect(source.publicCalls).toBe(3);
    expect(result.pages).toBe(3);
    expect(result.paginationCoverageIncomplete).toBe(true);
    expect(result.coverageComplete).toBe(false);
  });

  it('treats a non-advancing page that still has more as incomplete', async () => {
    const source = makeSource({ [TEXT]: [page([], true)] });
    const result = await fetchArchivedThreads(source, [{ id: TEXT, kind: 'text' }], {
      canManageThreads: true,
      maxPagesPerEndpoint: 50,
    });

    expect(source.publicCalls).toBe(1);
    expect(result.paginationCoverageIncomplete).toBe(true);
    expect(result.coverageComplete).toBe(false);
  });

  it('uses parent-local Manage Threads permission instead of a coarse guild-level true', async () => {
    const source = makeSource({ [TEXT]: [page([])], [ANNOUNCE]: [page([])] }, {
      [TEXT]: [page([])],
      [ANNOUNCE]: [page([])],
    });
    const result = await fetchArchivedThreads(source, [
      { id: TEXT, kind: 'text', canManageThreads: true },
      { id: ANNOUNCE, kind: 'announcement', canManageThreads: false },
    ], {
      canManageThreads: true,
      maxPagesPerEndpoint: 50,
    });

    expect(source.privateCalls).toBe(1);
    expect(result.privateCoverageIncomplete).toBe(true);
    expect(result.coverageComplete).toBe(false);
  });

  it('ignores parents that cannot host threads', async () => {
    const source = makeSource({});
    const result = await fetchArchivedThreads(source, [{ id: CAT, kind: 'category' }], {
      canManageThreads: true,
      maxPagesPerEndpoint: 50,
    });
    expect(source.publicCalls).toBe(0);
    expect(result.threads).toEqual([]);
  });
});

describe('discoverThreads — parent scope inheritance', () => {
  function archiveSource(): ThreadArchiveSource {
    return {
      fetchPublicArchived(parentId: string) {
        switch (parentId) {
          case ANNOUNCE:
            return page([threadDescriptor(PUBLIC_ARCHIVED, ANNOUNCE, ANNOUNCEMENT_THREAD)]);
          case FORUM:
            return page([threadDescriptor(FORUM_POST, FORUM, PUBLIC_THREAD)]);
          case MEDIA:
            return page([threadDescriptor(MEDIA_POST, MEDIA, PUBLIC_THREAD)]);
          default:
            return page([]);
        }
      },
      fetchPrivateArchived(parentId: string) {
        if (parentId === TEXT) return page([threadDescriptor(PRIVATE_ARCHIVED, TEXT, PRIVATE_THREAD)]);
        return page([]);
      },
    };
  }

  async function run(canManageThreads = true) {
    return discoverThreads(db, {
      parents: parentDescriptors(),
      activeThreads: [threadDescriptor(ACTIVE_PUBLIC, TEXT, PUBLIC_THREAD, false)],
      archiveSource: archiveSource(),
      canManageThreads,
      options: { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW },
    });
  }

  it('covers active, public archived, private archived, announcement, forum, and media threads', async () => {
    const result = await run(true);
    const ids = new Set(result.threads.map((t) => t.id));
    expect(ids).toEqual(new Set([ACTIVE_PUBLIC, PUBLIC_ARCHIVED, PRIVATE_ARCHIVED, FORUM_POST, MEDIA_POST]));
    expect(result.activeCount).toBe(1);
    expect(result.archivedCount).toBe(4);
  });

  it('inherits the correct parent scope for each thread variety', async () => {
    const result = await run(true);
    const byId = new Map(result.threads.map((t) => [t.id, t]));
    // TEXT and ANNOUNCE inherit org from the category.
    expect(byId.get(ACTIVE_PUBLIC)?.visibilityClass).toBe('org');
    expect(byId.get(PUBLIC_ARCHIVED)?.visibilityClass).toBe('org');
    expect(byId.get(PRIVATE_ARCHIVED)?.visibilityClass).toBe('org');
    // Announcement thread (Discord type 10) under an announcement parent.
    expect(byId.get(PUBLIC_ARCHIVED)?.kind).toBe(ANNOUNCEMENT_THREAD);
    // FORUM is explicitly restricted → its post is restricted.
    expect(byId.get(FORUM_POST)?.visibilityClass).toBe('restricted');
    // MEDIA inherits org from the category.
    expect(byId.get(MEDIA_POST)?.visibilityClass).toBe('org');
    // Every discovered thread is marked isThread.
    expect(result.threads.every((t) => t.isThread)).toBe(true);
  });

  it('persists each thread as its own channel row with parent policy', async () => {
    await run(true);
    expect(getChannel(db, ACTIVE_PUBLIC)?.visibility_class).toBe('org');
    expect(getChannel(db, ACTIVE_PUBLIC)?.is_thread).toBe(1);
    expect(getChannel(db, FORUM_POST)?.visibility_class).toBe('restricted');
    expect(getChannel(db, MEDIA_POST)?.is_thread).toBe(1);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.is_archived).toBe(1);
    expect(getChannel(db, ACTIVE_PUBLIC)?.is_archived).toBe(0);
  });

  it('reports incomplete private coverage when Manage Threads is absent', async () => {
    // Establish a previously accessible private archived thread first. The next
    // incomplete pass must quarantine it instead of treating omission as absence
    // or leaving stale org-visible access in place.
    await run(true);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.ingest_enabled).toBe(1);
    const result = await run(false);
    expect(result.archivedPrivateCoverageIncomplete).toBe(true);
    expect(result.archivedPaginationCoverageIncomplete).toBe(false);
    expect(result.archivedCoverageComplete).toBe(false);
    // The private archived thread should not appear (private endpoint not fetched).
    expect(result.threads.find((t) => t.id === PRIVATE_ARCHIVED)).toBeUndefined();
    expect(getChannel(db, PRIVATE_ARCHIVED)?.ingest_enabled).toBe(0);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.visibility_class).toBe('excluded');
  });

  it('reports complete coverage and includes private archived threads when permitted', async () => {
    const result = await run(true);
    expect(result.archivedPrivateCoverageIncomplete).toBe(false);
    expect(result.archivedPaginationCoverageIncomplete).toBe(false);
    expect(result.archivedCoverageComplete).toBe(true);
    expect(result.threads.find((t) => t.id === PRIVATE_ARCHIVED)).toBeDefined();
    expect(result.archivedPagesFetched).toBeGreaterThan(0);
  });

  it('discovers active threads even with no archive source', async () => {
    await run(true);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.ingest_enabled).toBe(1);
    const result = await discoverThreads(db, {
      parents: parentDescriptors(),
      activeThreads: [threadDescriptor(ACTIVE_PUBLIC, TEXT, PUBLIC_THREAD, false)],
      options: { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW },
    });
    expect(result.threads.map((t) => t.id)).toEqual([ACTIVE_PUBLIC]);
    expect(result.activeCount).toBe(1);
    expect(result.archivedCount).toBe(0);
    expect(result.archivedPrivateCoverageIncomplete).toBe(false);
    expect(result.archivedPaginationCoverageIncomplete).toBe(false);
    expect(result.archivedCoverageComplete).toBe(false);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.ingest_enabled).toBe(0);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.visibility_class).toBe('excluded');
  });

  it('quarantines omitted known archived threads when pagination hits its bound', async () => {
    await run(true);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.ingest_enabled).toBe(1);

    const endlessPublic = threadDescriptor('300000000000000299', TEXT, PUBLIC_THREAD);
    const result = await discoverThreads(db, {
      parents: parentDescriptors(),
      activeThreads: [threadDescriptor(ACTIVE_PUBLIC, TEXT, PUBLIC_THREAD, false)],
      archiveSource: {
        fetchPublicArchived(parentId) {
          return parentId === TEXT ? page([endlessPublic], true) : page([]);
        },
        fetchPrivateArchived() {
          return page([]);
        },
      },
      canManageThreads: true,
      maxPagesPerEndpoint: 1,
      options: { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW + 1 },
    });

    expect(result.archivedCoverageComplete).toBe(false);
    expect(result.archivedPaginationCoverageIncomplete).toBe(true);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.ingest_enabled).toBe(0);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.visibility_class).toBe('excluded');
  });

  it('quarantines omitted known archived threads when archive fetching fails', async () => {
    await run(true);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.ingest_enabled).toBe(1);

    await expect(discoverThreads(db, {
      parents: parentDescriptors(),
      activeThreads: [threadDescriptor(ACTIVE_PUBLIC, TEXT, PUBLIC_THREAD, false)],
      archiveSource: {
        fetchPublicArchived() {
          throw new Error('synthetic archive outage');
        },
        fetchPrivateArchived() {
          return page([]);
        },
      },
      canManageThreads: true,
      options: { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW + 1 },
    })).rejects.toThrow('synthetic archive outage');

    expect(getChannel(db, PRIVATE_ARCHIVED)?.ingest_enabled).toBe(0);
    expect(getChannel(db, PRIVATE_ARCHIVED)?.visibility_class).toBe('excluded');
  });
});
