import { type DatabaseSync } from '../db/database.js';
import {
  discoverChannels,
  type DiscoveredChannelDescriptor,
  type DiscoveryOptions,
  type DiscoveryResult,
  type DiscoveredChannelSummary,
} from './discovery.js';
import type { Logger } from '../logger.js';
import type { ChannelKind } from '../platform/types.js';

/**
 * Active and archived thread discovery (Sections 6.5, 7.1, 9.7).
 *
 * Active threads come from the guild cache (synchronous descriptors). Archived
 * threads come from Discord REST, paginated until `has_more` is false. Forum and
 * media posts are represented as threads and are enumerated from the same archive
 * endpoints of their parent. Every discovered thread inherits its parent's
 * visibility policy (resolved by {@link discoverChannels}); this module is the
 * fetching and orchestration layer that feeds thread descriptors into discovery.
 *
 * The core is testable without a live guild: an injected {@link ThreadArchiveSource}
 * stands in for `channel.threads.fetchArchived`.
 */

/** Parent channel kinds that can host threads (Section 6.5). */
export const THREAD_CAPABLE_PARENT_KINDS = new Set<ChannelKind>(['text', 'announcement', 'forum', 'media']);

/** One page of archived threads, mirroring the discord.js fetched-page shape. */
export interface ArchivedThreadPage {
  threads: DiscoveredChannelDescriptor[];
  hasMore: boolean;
}

/** A REST seam for archived-thread pagination. Implementations wrap discord.js. */
export interface ThreadArchiveSource {
  /** Fetch one page of public archived threads for a parent (cursor = last thread id). */
  fetchPublicArchived(parentId: string, cursor: string | undefined): Promise<ArchivedThreadPage> | ArchivedThreadPage;
  /** Fetch one page of private archived threads for a parent (cursor = last thread id). */
  fetchPrivateArchived(parentId: string, cursor: string | undefined): Promise<ArchivedThreadPage> | ArchivedThreadPage;
}

/** Reference to a thread-capable parent channel. */
export interface ThreadParentRef {
  id: string;
  kind: ChannelKind;
  /** Parent-local permission; explicit false narrows the coarse guild capability. */
  canManageThreads?: boolean;
}

export interface ThreadDiscoveryInput {
  /** Known parent channels and categories, used to walk the policy/category chain. */
  parents: DiscoveredChannelDescriptor[];
  /** Active threads observed in the guild cache. */
  activeThreads: DiscoveredChannelDescriptor[];
  /** Optional REST source for archived threads. Omit to skip archived discovery. */
  archiveSource?: ThreadArchiveSource;
  /** Whether Mneme holds Manage Threads (governs private-archived coverage). */
  canManageThreads?: boolean;
  /** Safety bound on pages per archive endpoint per parent (default 50). */
  maxPagesPerEndpoint?: number;
  options: DiscoveryOptions;
  logger?: Pick<Logger, 'warn'>;
}

export interface ThreadDiscoveryResult {
  discovery: DiscoveryResult;
  /** Threads discovered from the active cache. */
  activeCount: number;
  /** Archived threads discovered across all parents (public + private). */
  archivedCount: number;
  /** Total archive pages fetched (telemetry). */
  archivedPagesFetched: number;
  /** True when Manage Threads is missing so private archived coverage is incomplete. */
  archivedPrivateCoverageIncomplete: boolean;
  /** True when a page could not advance or the configured page bound was reached. */
  archivedPaginationCoverageIncomplete: boolean;
  /** True only when every public/private archive endpoint ended naturally. */
  archivedCoverageComplete: boolean;
  /** The discovered thread summaries (active first, then archived). */
  threads: DiscoveredChannelSummary[];
}

/** Human-readable text for the archived-private-coverage warning (Section 9.7). */
export function formatArchivedPrivateCoverageWarning(): string {
  return 'Missing Manage Threads: archived private-thread discovery is incomplete';
}

/** Whether a channel kind can host threads (Section 6.5). */
export function isThreadCapableParent(kind: ChannelKind): boolean {
  return THREAD_CAPABLE_PARENT_KINDS.has(kind);
}

/** Whether a descriptor represents a thread. */
export function isThreadDescriptor(d: DiscoveredChannelDescriptor): boolean {
  return d.kind === 'thread';
}

/** Extract active thread descriptors from a guild channel list. */
export function extractActiveThreads(channels: Iterable<DiscoveredChannelDescriptor>): DiscoveredChannelDescriptor[] {
  const out: DiscoveredChannelDescriptor[] = [];
  for (const c of channels) {
    if (isThreadDescriptor(c)) out.push(c);
  }
  return out;
}

/**
 * Paginate public and (where permitted) private archived threads for each parent
 * until `hasMore` is false. Returns the merged descriptors, the page count, and a
 * flag set when Manage Threads is absent (private archived threads cannot be fully
 * enumerated). Network I/O happens only inside the injected source.
 */
export async function fetchArchivedThreads(
  source: ThreadArchiveSource,
  parents: ThreadParentRef[],
  opts: { canManageThreads: boolean; maxPagesPerEndpoint: number },
): Promise<{
  threads: DiscoveredChannelDescriptor[];
  pages: number;
  privateCoverageIncomplete: boolean;
  paginationCoverageIncomplete: boolean;
  coverageComplete: boolean;
}> {
  const threads: DiscoveredChannelDescriptor[] = [];
  let pages = 0;
  let privateCoverageIncomplete = false;
  let paginationCoverageIncomplete = false;

  const fetchEndpoint = async (
    fetchPage: (cursor: string | undefined) => Promise<ArchivedThreadPage> | ArchivedThreadPage,
  ): Promise<void> => {
    let cursor: string | undefined;
    for (let i = 0; i < opts.maxPagesPerEndpoint; i += 1) {
      const page = await Promise.resolve(fetchPage(cursor));
      pages += 1;
      threads.push(...page.threads);
      if (!page.hasMore) return;
      // A non-advancing page cannot be paginated safely. Do not interpret the
      // partial result as evidence that an omitted known thread disappeared.
      if (page.threads.length === 0) {
        paginationCoverageIncomplete = true;
        return;
      }
      cursor = page.threads[page.threads.length - 1]!.id;
    }
    // The safety bound stopped while the endpoint still advertised more data (or
    // was configured as zero). Coverage is deliberately incomplete/fail-closed.
    paginationCoverageIncomplete = true;
  };

  for (const parent of parents) {
    if (!isThreadCapableParent(parent.kind)) continue;

    // Public archived: always enumerated.
    await fetchEndpoint((cursor) => source.fetchPublicArchived(parent.id, cursor));

    // Private archived: only when both the coarse capability and this exact
    // parent's permission allow it. One permissive parent is not proof for peers.
    const canManagePrivate = opts.canManageThreads && parent.canManageThreads !== false;
    if (canManagePrivate) {
      await fetchEndpoint((cursor) => source.fetchPrivateArchived(parent.id, cursor));
    } else {
      privateCoverageIncomplete = true;
    }
  }

  return {
    threads,
    pages,
    privateCoverageIncomplete,
    paginationCoverageIncomplete,
    coverageComplete: !privateCoverageIncomplete && !paginationCoverageIncomplete,
  };
}

/**
 * Discover active and archived threads for the guild. Active threads come from the
 * cache; archived threads are paginated through the injected source. All threads are
 * persisted via {@link discoverChannels}, inheriting their parent's policy. Throws
 * {@link DiscoveryError} (propagated) when secure review validation fails.
 */
export async function discoverThreads(db: DatabaseSync, input: ThreadDiscoveryInput): Promise<ThreadDiscoveryResult> {
  const maxPages = input.maxPagesPerEndpoint ?? 50;
  const canManageThreads = input.canManageThreads ?? false;

  let archivedThreads: DiscoveredChannelDescriptor[] = [];
  let archivedPages = 0;
  let privateCoverageIncomplete = false;
  let paginationCoverageIncomplete = false;
  let archivedCoverageComplete = false;

  if (input.archiveSource) {
    const parents: ThreadParentRef[] = input.parents
      .filter((p) => isThreadCapableParent(p.kind))
      .map((p) => ({ id: p.id, kind: p.kind, canManageThreads: p.capabilities?.canManageThreads }));
    let archived: Awaited<ReturnType<typeof fetchArchivedThreads>>;
    try {
      archived = await fetchArchivedThreads(input.archiveSource, parents, {
        canManageThreads,
        maxPagesPerEndpoint: maxPages,
      });
    } catch (error) {
      // A failed REST population is not evidence of absence. Quarantine omitted
      // known threads while preserving the positive parent/active descriptors,
      // then propagate so the caller can retry the discovery job.
      discoverChannels(db, [...input.parents, ...input.activeThreads], {
        ...input.options,
        missingThreadMode: 'quarantine',
      });
      input.logger?.warn(
        {
          event: 'thread_discovery.archive_fetch_failed',
          archiveSourceAvailable: true,
          omittedThreadsQuarantined: true,
        },
        'thread discovery failed; omitted known threads quarantined',
      );
      throw error;
    }
    archivedThreads = archived.threads;
    archivedPages = archived.pages;
    privateCoverageIncomplete = archived.privateCoverageIncomplete;
    paginationCoverageIncomplete = archived.paginationCoverageIncomplete;
    archivedCoverageComplete = archived.coverageComplete;
  } else {
    input.logger?.warn(
      {
        event: 'thread_discovery.archive_source_unavailable',
        archiveSourceAvailable: false,
        omittedThreadsQuarantined: true,
      },
      'archived thread source unavailable; omitted known threads quarantined',
    );
  }

  // Merge into one descriptor set: parents (for policy/category walking) first,
  // then archived, then active (active wins on id collision).
  const byId = new Map<string, DiscoveredChannelDescriptor>();
  for (const p of input.parents) byId.set(p.id, p);
  for (const a of archivedThreads) byId.set(a.id, a);
  for (const a of input.activeThreads) byId.set(a.id, a);
  const merged = Array.from(byId.values());

  const discovery = discoverChannels(db, merged, {
    ...input.options,
    missingThreadMode: archivedCoverageComplete ? 'close' : 'quarantine',
  });
  if (input.archiveSource && !archivedCoverageComplete) {
    input.logger?.warn(
      {
        event: 'thread_discovery.coverage_incomplete',
        archivedThreadsObserved: archivedThreads.length,
        privateCoverageIncomplete,
        paginationCoverageIncomplete,
        omittedThreadsQuarantined: true,
      },
      'thread discovery coverage incomplete; omitted known threads quarantined',
    );
  }

  const allThreads = discovery.channels.filter((c) => c.isThread);
  const activeIds = new Set(input.activeThreads.map((t) => t.id));
  const activeCount = allThreads.filter((t) => activeIds.has(t.id)).length;
  const archivedCount = allThreads.length - activeCount;

  return {
    discovery,
    activeCount,
    archivedCount,
    archivedPagesFetched: archivedPages,
    archivedPrivateCoverageIncomplete: privateCoverageIncomplete,
    archivedPaginationCoverageIncomplete: paginationCoverageIncomplete,
    archivedCoverageComplete,
    threads: allThreads,
  };
}
