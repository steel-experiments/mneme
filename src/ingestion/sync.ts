import { type DatabaseSync } from '../db/database.js';
import type { Logger } from '../logger.js';
import { enqueue } from '../jobs/queue.js';
import { discoverChannels, type DiscoveredChannelDescriptor, type DiscoveryOptions, type DiscoveryResult } from './discovery.js';
import {
  fetchArchivedThreads,
  isThreadCapableParent,
  type ThreadArchiveSource,
  type ThreadParentRef,
} from './threads.js';
import { getSyncCursor } from '../db/repositories/sync-cursors.js';
import type { ChannelPolicy } from '../policy/channel-policy.js';
import type { ChannelPolicySource } from '../config.js';
import { isMnemeTestSurface } from './test-channels.js';
import type { ChatPlatform } from '../platform/types.js';

/**
 * Startup sync scheduling (Sections 9.2, 46.2).
 *
 * Encodes the Section 9.2 startup ordering as one orchestrated sequence, focused on
 * the synchronization tail (steps 5, 7, 8, 9, 10): begin storing live Gateway events,
 * enumerate channels and active threads, enqueue historical backfill, then enumerate
 * archived threads and enqueue their backfill. Each backfill job carries an active-
 * unique key so a restart never duplicates queued synchronization work (the partial
 * unique index collapses it). The earlier startup steps (migrate, `/livez`, compile
 * prompts, connect Gateway) are the caller's responsibility and run before this.
 *
 * Every phase is emitted to an optional recorder so the ordering is observable in a
 * test (Section 46.2: "connect-live-before-backfill ordering").
 */

export type StartupPhase =
  | 'live-event-storage-started'
  | 'enumerate-channels'
  | 'enqueue-backfill'
  | 'enumerate-archived-threads'
  | 'enqueue-archived-backfill';

/** The mandated phase order (Section 9.2 steps 5, 7, 8, 9, 10). */
export const STARTUP_PHASES: readonly StartupPhase[] = [
  'live-event-storage-started',
  'enumerate-channels',
  'enqueue-backfill',
  'enumerate-archived-threads',
  'enqueue-archived-backfill',
];

/** The active-unique key for a channel's backfill job (restart-dedupe). */
export function backfillJobKey(channelId: string): string {
  return `backfill:channel:${channelId}`;
}

export interface StartupSyncDeps {
  db: DatabaseSync;
  guildId: string;
  policy: ChannelPolicy;
  /** Policy source; 'basic' suppresses classification review cards (Section 8.4). */
  channelPolicySource?: ChannelPolicySource;
  now: number;
  /** Lower priority runs first; backfill defaults to the job default. */
  backfillPriority?: number;
  /** Disable historical jobs while still persisting discovery (`FULL_HISTORY=false`). */
  enqueueHistoricalBackfill?: boolean;
  /** Step 5: called first to begin persisting live Gateway events. */
  beginLiveEventStorage?: () => void;
  /** Step 7: descriptors for parent channels, categories, and active threads. */
  channels: DiscoveredChannelDescriptor[];
  /** Step 9: optional archived-thread REST source. Omit to skip archived discovery. */
  archiveSource?: ThreadArchiveSource;
  /**
   * True when `channels` already holds every known thread (a platform that cannot
   * list threads). Discovery then closes any omitted thread and makes no archive call.
   */
  completeThreadSnapshot?: boolean;
  /** Whether the bot holds Manage Threads (governs archived private coverage). */
  canManageThreads?: boolean;
  /** Safety bound on archived pages per endpoint per parent. */
  maxArchivePages?: number;
  /** Receives each phase name in execution order. */
  record?: (phase: StartupPhase) => void;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface StartupSyncResult {
  /** Phase names in execution order (only those that ran). */
  phases: StartupPhase[];
  /** Result of the initial channel + active-thread enumeration. */
  discovery: DiscoveryResult;
  /** Result of the archived-thread persistence pass, or null when skipped. */
  archivedDiscovery: DiscoveryResult | null;
  /** Channel/thread ids for which a backfill job was freshly enqueued (step 8). */
  backfillEnqueued: string[];
  /** Archived-thread ids for which a backfill job was freshly enqueued (step 10). */
  archivedBackfillEnqueued: string[];
  /** True when archived private coverage is incomplete (missing Manage Threads). */
  archivedPrivateCoverageIncomplete: boolean;
  /** True when a page could not advance or the configured page bound was reached. */
  archivedPaginationCoverageIncomplete: boolean;
  /** True only when every public/private archive endpoint ended naturally. */
  archivedCoverageComplete: boolean;
}

/** Enqueue a backfill job for a channel unless its history is already complete. */
function enqueueBackfillIfIncomplete(
  deps: StartupSyncDeps,
  channelId: string,
): boolean {
  const cursor = getSyncCursor(deps.db, channelId);
  if (cursor?.historyComplete) return false; // nothing to do; never re-enqueue finished work
  const result = enqueue(deps.db, {
    type: 'backfill_channel',
    payload: { channelId },
    uniqueKey: backfillJobKey(channelId),
    priority: deps.backfillPriority,
    now: deps.now,
  });
  return result.enqueued;
}

/**
 * Run the Section 9.2 synchronization sequence: live storage → enumerate → enqueue
 * backfill → enumerate archived → enqueue archived backfill. Throws {@link DiscoveryError}
 * (propagated from discovery) when secure review validation fails.
 */
export async function runStartupSync(deps: StartupSyncDeps): Promise<StartupSyncResult> {
  const phases: StartupPhase[] = [];
  const record = (phase: StartupPhase): void => {
    phases.push(phase);
    deps.record?.(phase);
  };

  const discoveryOptions: DiscoveryOptions = {
    guildId: deps.guildId,
    policy: deps.policy,
    channelPolicySource: deps.channelPolicySource,
    now: deps.now,
    // Step 7 contains active threads only. Preserve known archived threads only
    // while a separately paginated archive pass is guaranteed to follow; without
    // a source there is no later proof, so omission is quarantined immediately.
    // A complete thread snapshot is that proof, so omission closes the thread.
    missingThreadMode: deps.completeThreadSnapshot ? 'close' : deps.archiveSource ? 'preserve' : 'quarantine',
  };

  // Step 5: live Gateway event storage must begin before any historical import so a
  // gap cannot open while backfill is running (Section 9.2).
  if (deps.beginLiveEventStorage) {
    deps.beginLiveEventStorage();
  }
  record('live-event-storage-started');

  // Step 7: enumerate channels and active threads.
  record('enumerate-channels');
  const discovery = discoverChannels(deps.db, deps.channels, discoveryOptions);

  // Step 8: enqueue historical backfill for every accessible, non-excluded channel
  // whose history is not already complete.
  record('enqueue-backfill');
  const backfillEnqueued: string[] = [];
  const alreadyEnqueued = new Set<string>();
  for (const channel of discovery.channels) {
    if (!isMnemeTestSurface(deps.db, channel.id) && deps.enqueueHistoricalBackfill !== false && enqueueBackfillIfIncomplete(deps, channel.id)) {
      backfillEnqueued.push(channel.id);
    }
    alreadyEnqueued.add(channel.id);
  }

  let archivedDiscovery: DiscoveryResult | null = null;
  let archivedPrivateCoverageIncomplete = false;
  let archivedPaginationCoverageIncomplete = false;
  let archivedCoverageComplete = false;
  const archivedBackfillEnqueued: string[] = [];

  // Steps 9 + 10: enumerate archived threads, persist them, then enqueue their backfill.
  if (deps.archiveSource && !deps.completeThreadSnapshot) {
    record('enumerate-archived-threads');
    const parents: ThreadParentRef[] = deps.channels
      .filter((c) => isThreadCapableParent(c.kind))
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        // Parent-local permission is the only safe proof. The coarse caller flag
        // remains a compatibility fallback inside fetchArchivedThreads, but an
        // explicit false here prevents one permissive parent from standing in for
        // every other parent.
        canManageThreads: c.capabilities?.canManageThreads,
      }));
    let archived: Awaited<ReturnType<typeof fetchArchivedThreads>>;
    try {
      archived = await fetchArchivedThreads(deps.archiveSource, parents, {
        canManageThreads: deps.canManageThreads ?? false,
        maxPagesPerEndpoint: deps.maxArchivePages ?? 50,
      });
    } catch (error) {
      // The active-only phase intentionally preserved missing archived threads
      // while REST was in flight. A failed archive pass ends that grace period:
      // quarantine every omitted known thread before propagating the error for the
      // durable job to retry. Positive active threads remain enabled.
      discoverChannels(deps.db, deps.channels, {
        ...discoveryOptions,
        missingThreadMode: 'quarantine',
      });
      deps.logger?.warn(
        {
          event: 'thread_discovery.archive_fetch_failed',
          archiveSourceAvailable: true,
          omittedThreadsQuarantined: true,
        },
        'thread discovery failed; omitted known threads quarantined',
      );
      throw error;
    }
    archivedPrivateCoverageIncomplete = archived.privateCoverageIncomplete;
    archivedPaginationCoverageIncomplete = archived.paginationCoverageIncomplete;
    archivedCoverageComplete = archived.coverageComplete;

    // Persist one combined active+archived snapshot. Even an empty archive result
    // needs this pass so a genuinely complete snapshot can close vanished threads.
    // Missing private permission, a non-advancing page, or the page bound makes
    // omission non-evidence and quarantines every known missing thread.
    const byId = new Map<string, DiscoveredChannelDescriptor>();
    for (const c of deps.channels) byId.set(c.id, c);
    for (const t of archived.threads) byId.set(t.id, t);
    archivedDiscovery = discoverChannels(deps.db, Array.from(byId.values()), {
      ...discoveryOptions,
      missingThreadMode: archivedCoverageComplete ? 'close' : 'quarantine',
    });
    if (!archivedCoverageComplete) {
      deps.logger?.warn(
        {
          event: 'thread_discovery.coverage_incomplete',
          archivedThreadsObserved: archived.threads.length,
          privateCoverageIncomplete: archivedPrivateCoverageIncomplete,
          paginationCoverageIncomplete: archivedPaginationCoverageIncomplete,
          omittedThreadsQuarantined: true,
        },
        'thread discovery coverage incomplete; omitted known threads quarantined',
      );
    }

    record('enqueue-archived-backfill');
    for (const thread of archived.threads) {
      if (alreadyEnqueued.has(thread.id)) continue; // discovered as active already
      if (isMnemeTestSurface(deps.db, thread.id)) continue;
      if (deps.enqueueHistoricalBackfill !== false && enqueueBackfillIfIncomplete(deps, thread.id)) {
        archivedBackfillEnqueued.push(thread.id);
      }
    }
  } else {
    deps.logger?.warn(
      {
        event: 'thread_discovery.archive_source_unavailable',
        archiveSourceAvailable: false,
        omittedThreadsQuarantined: true,
      },
      'archived thread source unavailable; omitted known threads quarantined',
    );
  }

  deps.logger?.info(
    {
      backfill: backfillEnqueued.length,
      archived: archivedBackfillEnqueued.length,
      archivedPrivateCoverageIncomplete,
      archivedPaginationCoverageIncomplete,
      archiveSnapshotComplete: archivedCoverageComplete,
    },
    'startup-sync: synchronization scheduled',
  );

  return {
    phases,
    discovery,
    archivedDiscovery,
    backfillEnqueued,
    archivedBackfillEnqueued,
    archivedPrivateCoverageIncomplete,
    archivedPaginationCoverageIncomplete,
    archivedCoverageComplete,
  };
}

export interface PlatformDiscoveryDeps {
  db: DatabaseSync;
  guildId: string;
  policy: ChannelPolicy;
  channelPolicySource?: ChannelPolicySource;
  now: number;
  platform: Pick<ChatPlatform, 'listChannels' | 'threadDiscovery'>;
  enqueueHistoricalBackfill: boolean;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/**
 * The periodic discovery job (Section 9.7). An archive-scan platform pages its
 * thread archive; a complete-snapshot platform repeats the full channel
 * discovery, which also applies boundary changes that came without an event.
 */
export async function runPlatformDiscovery(deps: PlatformDiscoveryDeps): Promise<StartupSyncResult> {
  const mode = deps.platform.threadDiscovery;
  const descriptors = await deps.platform.listChannels();
  return runStartupSync({
    db: deps.db, guildId: deps.guildId, policy: deps.policy, channelPolicySource: deps.channelPolicySource,
    now: deps.now, channels: descriptors,
    archiveSource: mode.mode === 'archive_scan' ? mode.archive : undefined,
    completeThreadSnapshot: mode.mode === 'complete_snapshot',
    canManageThreads: descriptors.some((d) => d.capabilities?.canManageThreads === true),
    enqueueHistoricalBackfill: deps.enqueueHistoricalBackfill, logger: deps.logger,
  });
}
