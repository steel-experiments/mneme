import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { parseChannelPolicy } from '../../src/discord/channel-policy.js';
import {
  GUILD_TEXT,
  GUILD_CATEGORY,
  PUBLIC_THREAD,
  type DiscoveredChannelDescriptor,
} from '../../src/discord/discovery.js';
import type { ThreadArchiveSource } from '../../src/discord/threads.js';
import {
  runStartupSync,
  backfillJobKey,
  STARTUP_PHASES,
  type StartupPhase,
} from '../../src/discord/sync.js';
import { DiscoveryError } from '../../src/discord/discovery.js';
import { markBackfillComplete } from '../../src/db/repositories/sync-cursors.js';
import { getChannel } from '../../src/db/repositories/channels.js';
import { createReconcileChannelHandler } from '../../src/jobs/handlers/reconcile-channel.js';
import type { JobRow } from '../../src/jobs/types.js';
import { opts as messageOptions } from '../helpers/messages.js';

/**
 * Startup sync scheduling (Sections 9.2, 46.2).
 *
 * The acceptance criterion: an ordering test proves live event storage starts
 * before any historical import, and archived discovery follows the initial
 * channel enumeration.
 */

const GUILD = '100000000000000001';
const NOW = 1_700_000_001_000;

const CAT = '200000000000000001';
const TEXT = '200000000000000002';
const THREAD = '200000000000000003';
const ARCHIVED = '200000000000000004';
const EXCLUDED = '200000000000000005';

const FULL = {
  canView: true,
  canReadHistory: true,
  canSend: true,
  canSendInThreads: true,
  canManageThreads: true,
};

const POLICY_YAML = `
version: 1
default:
  ingest: true
  visibility: restricted
  allow_interventions: false
channels:
  "${EXCLUDED}":
    ingest: false
    visibility: excluded
    allow_interventions: false
`;

/** Parents + active thread; the archived thread is NOT in here (it comes from the source). */
function baseDescriptors(): DiscoveredChannelDescriptor[] {
  return [
    { id: CAT, parentId: null, type: GUILD_CATEGORY, name: 'Engineering' },
    { id: TEXT, parentId: CAT, type: GUILD_TEXT, name: 'general', capabilities: FULL },
    { id: THREAD, parentId: TEXT, type: PUBLIC_THREAD, name: 'active-side', capabilities: FULL },
    { id: EXCLUDED, parentId: null, type: GUILD_TEXT, name: 'legal', capabilities: FULL },
  ];
}

/** A fake REST source returning one public archived thread under TEXT, then done. */
function fakeArchiveSource(archivedId = ARCHIVED): ThreadArchiveSource {
  let publicCalled = false;
  return {
    fetchPublicArchived(parentId: string) {
      if (parentId === TEXT && !publicCalled) {
        publicCalled = true;
        return {
          threads: [
            { id: archivedId, parentId: TEXT, type: PUBLIC_THREAD, name: 'old-side', archived: true, capabilities: FULL },
          ],
          hasMore: false,
        };
      }
      return { threads: [], hasMore: false };
    },
    fetchPrivateArchived() {
      return { threads: [], hasMore: false };
    },
  };
}

/** Unique keys of every active backfill_channel job currently queued or running. */
function activeBackfillKeys(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      `SELECT unique_key FROM jobs
       WHERE type = 'backfill_channel' AND status IN ('queued', 'running') AND unique_key IS NOT NULL`,
    )
    .all() as { unique_key: string }[];
  return new Set(rows.map((r) => r.unique_key));
}

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

describe('runStartupSync — phase ordering', () => {
  it('runs the five phases in the mandated Section 9.2 order', async () => {
    const phases: StartupPhase[] = [];
    const result = await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      beginLiveEventStorage: () => {},
      channels: baseDescriptors(),
      archiveSource: fakeArchiveSource(),
      canManageThreads: true,
      record: (p) => phases.push(p),
    });

    expect(phases).toEqual([
      'live-event-storage-started',
      'enumerate-channels',
      'enqueue-backfill',
      'enumerate-archived-threads',
      'enqueue-archived-backfill',
    ]);
    // The result mirrors the recorder for callers that did not pass one.
    expect(result.phases).toEqual(phases);
  });

  it('begins live event storage before enqueuing any historical import', async () => {
    const events: string[] = [];
    await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      // beginLiveEventStorage is step 5; any backfill enqueue is step 8/10.
      beginLiveEventStorage: () => events.push('live-started'),
      channels: baseDescriptors(),
      archiveSource: fakeArchiveSource(),
      canManageThreads: true,
      record: (p) => events.push(p),
    });

    const liveIdx = events.indexOf('live-started');
    const enqueueIdx = events.indexOf('enqueue-backfill');
    expect(liveIdx).toBeGreaterThanOrEqual(0);
    expect(enqueueIdx).toBeGreaterThan(liveIdx);
    expect(events[0]).toBe('live-started');
  });

  it('enumerates archived threads only after the initial channel enumeration', async () => {
    const phases: StartupPhase[] = [];
    await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      beginLiveEventStorage: () => {},
      channels: baseDescriptors(),
      archiveSource: fakeArchiveSource(),
      canManageThreads: true,
      record: (p) => phases.push(p),
    });

    expect(phases.indexOf('enumerate-channels')).toBeLessThan(phases.indexOf('enumerate-archived-threads'));
    expect(phases.indexOf('enqueue-backfill')).toBeLessThan(phases.indexOf('enumerate-archived-threads'));
  });

  it('keeps a known archived thread eligible while its delayed archive snapshot and reconciliation overlap', async () => {
    const policy = parseChannelPolicy(POLICY_YAML);
    await runStartupSync({
      db,
      guildId: GUILD,
      policy,
      now: NOW,
      channels: baseDescriptors(),
      archiveSource: fakeArchiveSource(),
      canManageThreads: true,
    });
    expect(getChannel(db, ARCHIVED)?.ingest_enabled).toBe(1);

    let announceArchiveStarted!: () => void;
    let releaseArchive!: () => void;
    const archiveStarted = new Promise<void>((resolve) => { announceArchiveStarted = resolve; });
    const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
    let deliveredArchivedThread = false;
    const delayedArchiveSource: ThreadArchiveSource = {
      async fetchPublicArchived(parentId) {
        if (parentId === TEXT && !deliveredArchivedThread) {
          deliveredArchivedThread = true;
          announceArchiveStarted();
          await archiveGate;
          return {
            threads: [{ id: ARCHIVED, parentId: TEXT, type: PUBLIC_THREAD, name: 'old-side', archived: true, capabilities: FULL }],
            hasMore: false,
          };
        }
        return { threads: [], hasMore: false };
      },
      fetchPrivateArchived() {
        return { threads: [], hasMore: false };
      },
    };

    const discoveryRun = runStartupSync({
      db,
      guildId: GUILD,
      policy,
      now: NOW + 1,
      channels: baseDescriptors(),
      archiveSource: delayedArchiveSource,
      canManageThreads: true,
    });
    await archiveStarted;

    // The active-only half has completed, but the archived REST source is still
    // blocked. The old implementation excluded ARCHIVED in this exact window.
    expect(getChannel(db, ARCHIVED)?.ingest_enabled).toBe(1);
    let reconcileFetches = 0;
    const handler = createReconcileChannelHandler({
      db,
      fetcher: {
        async fetchMessages(channelId) {
          expect(channelId).toBe(ARCHIVED);
          reconcileFetches += 1;
          return [];
        },
      },
      makeIngestOptions: (now) => messageOptions({ now }),
      now: () => NOW + 1,
    });
    await handler({ channelId: ARCHIVED }, {} as JobRow);
    expect(reconcileFetches).toBe(1);

    releaseArchive();
    const result = await discoveryRun;
    expect(result.archivedCoverageComplete).toBe(true);
    expect(getChannel(db, ARCHIVED)?.ingest_enabled).toBe(1);
  });
});

describe('runStartupSync — backfill enqueue', () => {
  it('enqueues backfill for accessible channels and active threads, skipping excluded ones', async () => {
    const result = await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      beginLiveEventStorage: () => {},
      channels: baseDescriptors(),
      archiveSource: fakeArchiveSource(),
      canManageThreads: true,
    });

    // Parent text channel + active thread are scheduled; category (no messages) and
    // the policy-excluded channel are not.
    expect(result.backfillEnqueued.sort()).toEqual([TEXT, THREAD]);
    const keys = activeBackfillKeys(db);
    expect(keys.has(backfillJobKey(TEXT))).toBe(true);
    expect(keys.has(backfillJobKey(THREAD))).toBe(true);
    expect(keys.has(backfillJobKey(EXCLUDED))).toBe(false);
    expect(keys.has(backfillJobKey(CAT))).toBe(false);
  });

  it('enqueues backfill for archived threads discovered in step 9', async () => {
    const result = await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      beginLiveEventStorage: () => {},
      channels: baseDescriptors(),
      archiveSource: fakeArchiveSource(),
      canManageThreads: true,
    });
    expect(result.archivedBackfillEnqueued).toEqual([ARCHIVED]);
    expect(activeBackfillKeys(db).has(backfillJobKey(ARCHIVED))).toBe(true);
  });

  it('does not re-enqueue a channel whose history is already complete', async () => {
    // Persist the text channel + a complete cursor so step 8 skips it.
    db.prepare(
      `INSERT INTO channels (id, workspace_id, parent_id, type, name, is_thread, is_archived, is_locked,
         ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
       VALUES (?, ?, NULL, 0, 'pre', 0, 0, 0, 1, 'restricted', 0, ?, ?)`,
    ).run(TEXT, GUILD, NOW - 1000, NOW - 1000);
    markBackfillComplete(db, TEXT, {}, NOW - 500);

    const result = await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      beginLiveEventStorage: () => {},
      channels: baseDescriptors(),
      // No archive source: only the step-8 path is exercised.
    });

    expect(result.backfillEnqueued).toEqual([THREAD]); // TEXT was complete
    expect(activeBackfillKeys(db).has(backfillJobKey(TEXT))).toBe(false);
  });

  it('restart is idempotent: active unique keys collapse duplicate backfill jobs', async () => {
    const deps = {
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      beginLiveEventStorage: () => {},
      channels: baseDescriptors(),
    };
    await runStartupSync(deps);
    const firstCount = activeBackfillKeys(db).size;
    expect(firstCount).toBeGreaterThan(0);

    // A restart re-runs the whole sequence; already-active jobs are not duplicated.
    const second = await runStartupSync(deps);
    expect(second.backfillEnqueued).toEqual([]); // nothing freshly enqueued
    expect(second.archivedBackfillEnqueued).toEqual([]);
    expect(activeBackfillKeys(db).size).toBe(firstCount);
  });
});

describe('runStartupSync — archived coverage & variants', () => {
  it('omits archived phases when no archive source is provided', async () => {
    const phases: StartupPhase[] = [];
    const result = await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      beginLiveEventStorage: () => {},
      channels: baseDescriptors(),
      record: (p) => phases.push(p),
    });
    expect(phases).toEqual([
      'live-event-storage-started',
      'enumerate-channels',
      'enqueue-backfill',
    ]);
    expect(result.archivedDiscovery).toBeNull();
    expect(result.archivedPrivateCoverageIncomplete).toBe(false);
    expect(result.archivedPaginationCoverageIncomplete).toBe(false);
  });

  it('quarantines a known archived thread when no archive source can follow the active pass', async () => {
    const policy = parseChannelPolicy(POLICY_YAML);
    await runStartupSync({
      db,
      guildId: GUILD,
      policy,
      now: NOW,
      channels: baseDescriptors(),
      archiveSource: fakeArchiveSource(),
      canManageThreads: true,
    });
    expect(getChannel(db, ARCHIVED)?.ingest_enabled).toBe(1);

    const result = await runStartupSync({
      db,
      guildId: GUILD,
      policy,
      now: NOW + 1,
      channels: baseDescriptors(),
    });

    expect(result.archivedDiscovery).toBeNull();
    expect(result.archivedCoverageComplete).toBe(false);
    expect(getChannel(db, ARCHIVED)?.ingest_enabled).toBe(0);
    expect(getChannel(db, ARCHIVED)?.visibility_class).toBe('excluded');
  });

  it('flags incomplete archived private coverage when Manage Threads is missing', async () => {
    const warn = vi.fn();
    const result = await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      beginLiveEventStorage: () => {},
      channels: baseDescriptors(),
      archiveSource: fakeArchiveSource(),
      canManageThreads: false, // private archived threads cannot be enumerated
      logger: { info: vi.fn(), warn },
    });
    expect(result.archivedPrivateCoverageIncomplete).toBe(true);
    expect(result.archivedPaginationCoverageIncomplete).toBe(false);
    expect(result.archivedCoverageComplete).toBe(false);
    // Public archived threads are still discovered and scheduled.
    expect(result.archivedBackfillEnqueued).toEqual([ARCHIVED]);
    expect(warn).toHaveBeenCalledWith(
      {
        event: 'thread_discovery.coverage_incomplete',
        archivedThreadsObserved: 1,
        privateCoverageIncomplete: true,
        paginationCoverageIncomplete: false,
        omittedThreadsQuarantined: true,
      },
      'thread discovery coverage incomplete; omitted known threads quarantined',
    );
  });

  it('reports bounded archive pagination as an explicit content-free coverage warning', async () => {
    const warn = vi.fn();
    const result = await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      beginLiveEventStorage: () => {},
      channels: baseDescriptors(),
      archiveSource: {
        fetchPublicArchived(parentId) {
          return parentId === TEXT
            ? { threads: [{ id: ARCHIVED, parentId: TEXT, type: PUBLIC_THREAD, name: 'old-side', archived: true, capabilities: FULL }], hasMore: true }
            : { threads: [], hasMore: false };
        },
        fetchPrivateArchived() {
          return { threads: [], hasMore: false };
        },
      },
      canManageThreads: true,
      maxArchivePages: 1,
      logger: { info: vi.fn(), warn },
    });

    expect(result.archivedPrivateCoverageIncomplete).toBe(false);
    expect(result.archivedPaginationCoverageIncomplete).toBe(true);
    expect(result.archivedCoverageComplete).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      {
        event: 'thread_discovery.coverage_incomplete',
        archivedThreadsObserved: 1,
        privateCoverageIncomplete: false,
        paginationCoverageIncomplete: true,
        omittedThreadsQuarantined: true,
      },
      'thread discovery coverage incomplete; omitted known threads quarantined',
    );
  });

  it('records live storage even when beginLiveEventStorage is omitted (production wires it)', async () => {
    const phases: StartupPhase[] = [];
    await runStartupSync({
      db,
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      channels: baseDescriptors(),
      record: (p) => phases.push(p),
    });
    expect(phases[0]).toBe('live-event-storage-started');
  });

  it('propagates DiscoveryError when secure review validation fails', async () => {
    const policy = parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: restricted
  allow_interventions: false
review_channel:
  id: "200000000000000099"
  secure: true
  accepts_scopes: [org, restricted, review_only]
`);
    await expect(
      runStartupSync({
        db,
        guildId: GUILD,
        policy,
        now: NOW,
        beginLiveEventStorage: () => {},
        channels: baseDescriptors(),
      }),
    ).rejects.toBeInstanceOf(DiscoveryError);
  });

  it('exposes the mandated phase order as a constant for documentation/tests', () => {
    expect(STARTUP_PHASES).toEqual([
      'live-event-storage-started',
      'enumerate-channels',
      'enqueue-backfill',
      'enumerate-archived-threads',
      'enqueue-archived-backfill',
    ]);
  });
});
