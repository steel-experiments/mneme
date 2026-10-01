import { type DatabaseSync, transaction } from '../db/database.js';
import { getChannel, upsertChannel } from '../db/repositories/channels.js';
import {
  computePermissionFingerprint,
  recordAccessAudit,
  NO_ACCESS,
  type ChannelAccessCapabilities,
} from '../db/repositories/channel-access.js';
import { getSyncCursor } from '../db/repositories/sync-cursors.js';
import {
  ChannelPolicyError,
  type ChannelPolicy,
  type PolicySource,
  type VisibilityClass,
} from '../policy/channel-policy.js';
import {
  reconcileObservedChannelPolicyReviewInTransaction,
  resolveObservedChannelPolicy,
} from '../policy/channel-policy-review-service.js';
import type { ChannelPolicySource } from '../config.js';
import type { ChannelKind } from '../platform/types.js';

/**
 * Channel discovery and access auditing (Sections 6.3, 6.5, 7, 9.2, 48 Ingestion).
 *
 * Discovery enumerates the text-bearing channels Discord exposes to Mneme —
 * guild text, announcement, forum, media, and public/private/announcement threads
 * (Section 6.5) — resolves each one's effective visibility policy, persists the
 * channel metadata and a capability audit, and reports the set the bot can actually
 * reach. It is the startup step 7 ("enumerate channels and active threads") and the
 * source of the `/mneme channels` and `list_channels` views.
 *
 * The core operates on plain descriptors so it is testable without a live guild; a
 * discord.js adapter converts guild channels into descriptors in production.
 */

/** Channel kinds discovery enumerates (Section 6.5). */
export function isSupportedChannelKind(kind: ChannelKind): boolean {
  return kind !== 'category' && kind !== 'other';
}

export type SyncState = 'pending' | 'backfilling' | 'live' | 'error' | 'excluded';

/**
 * A channel as seen by discovery. `capabilities` defaults to {@link NO_ACCESS} when
 * omitted so a descriptor never silently claims access it does not have (fail closed).
 */
export interface DiscoveredChannelDescriptor {
  id: string;
  parentId: string | null;
  kind: ChannelKind;
  name: string | null;
  topic?: string | null;
  position?: number | null;
  archived?: boolean;
  locked?: boolean;
  lastMessageId?: string | null;
  capabilities?: ChannelAccessCapabilities;
}

export interface DiscoveryOptions {
  guildId: string;
  policy: ChannelPolicy;
  now: number;
  /** When true, Manage Threads is required for archived private-thread discovery (Section 6.3). */
  requireManageThreads?: boolean;
  /**
   * How omission of a previously known thread is interpreted. `preserve` is only
   * for the first half of an in-flight active+archive scan; `close` requires one
   * fully paginated combined snapshot; `quarantine` is the fail-closed default for
   * incomplete, bounded, permission-limited, or failed archive coverage.
   */
  missingThreadMode?: 'preserve' | 'quarantine' | 'close';
  /**
   * Policy source; 'basic' suppresses classification review cards and ignores
   * stored review decisions (Section 8.4).
   */
  channelPolicySource?: ChannelPolicySource;
}

export interface DiscoveredChannelSummary {
  id: string;
  name: string | null;
  kind: ChannelKind;
  isThread: boolean;
  /** Resolved visibility class after policy inheritance (Section 7.1). */
  visibilityClass: VisibilityClass;
  /** Which precedence level produced the rule (Section 8 resolution order). */
  policySource: PolicySource | 'review';
  ingest: boolean;
  allowInterventions: boolean;
  syncState: SyncState;
  historyComplete: boolean;
  permissionWarnings: string[];
  permissionFingerprint: string;
  /** Mneme can View Channel — required to read or persist anything. */
  accessible: boolean;
  /** Excluded by policy (ingest=false or visibility=excluded). */
  excluded: boolean;
}

export interface ReviewChannelValidation {
  configured: boolean;
  channelId: string | null;
  /** Present among the discovered supported channels. */
  present: boolean;
  accessible: boolean;
  /** True unless secure review is enabled and the channel is absent/inaccessible. */
  ok: boolean;
  warning: string | null;
}

export interface DiscoveryResult {
  guildId: string;
  /** Channels Mneme can view that are not excluded by policy. */
  channels: DiscoveredChannelSummary[];
  /** Channels excluded by policy (still persisted with ingest_enabled=0). */
  excluded: DiscoveredChannelSummary[];
  /** Channels Mneme cannot view — recorded in the result, not persisted (FK-safe). */
  inaccessible: DiscoveredChannelSummary[];
  review: ReviewChannelValidation;
}

/** Raised when secure review is enabled but the review channel is unusable (Section 8). */
export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/**
 * Build the human-readable capability warnings for a channel. Required capabilities
 * depend on policy: a channel that allows interventions needs Send Messages, and a
 * guild requiring archived-thread discovery needs Manage Threads. View and Read
 * Message History are always required to ingest (Section 6.3).
 */
export function describeAccessWarnings(
  caps: ChannelAccessCapabilities,
  opts: { allowInterventions: boolean; requireManageThreads: boolean },
): string[] {
  const warnings: string[] = [];
  if (!caps.canView) warnings.push('Missing View Channel');
  if (!caps.canReadHistory) warnings.push('Missing Read Message History');
  if (opts.allowInterventions) {
    if (!caps.canSend) warnings.push('Missing Send Messages (interventions blocked)');
    if (!caps.canSendInThreads) warnings.push('Missing Send Messages in Threads (interventions blocked)');
  }
  if (opts.requireManageThreads && !caps.canManageThreads) {
    warnings.push('Missing Manage Threads (archived thread discovery limited)');
  }
  return warnings;
}

/** Resolve the category id for a channel by walking its parent chain. */
function resolveCategoryId(byId: Map<string, DiscoveredChannelDescriptor>, channelId: string): string | null {
  let current = byId.get(channelId);
  let guard = 0;
  while (current && guard < 16) {
    guard += 1;
    if (current.kind === 'category') return current.id;
    if (!current.parentId) return null;
    current = byId.get(current.parentId);
  }
  return null;
}

/** Read the per-channel sync cursor, defaulting to pending when none exists yet. */
function readSyncState(db: DatabaseSync, channelId: string): { state: SyncState; historyComplete: boolean } {
  const cursor = getSyncCursor(db, channelId);
  if (!cursor) return { state: 'pending', historyComplete: false };
  return { state: cursor.state, historyComplete: cursor.historyComplete };
}

/**
 * Enumerate channels, resolve policy, persist metadata and capability audits, and
 * validate the review channel. Persistence runs in one transaction; no network I/O
 * occurs here. Throws {@link DiscoveryError} when secure review is enabled but the
 * review channel is absent or inaccessible (Section 8) — but only after persisting,
 * so the channel list still reflects reality on the failing run.
 */
export function discoverChannels(
  db: DatabaseSync,
  descriptors: DiscoveredChannelDescriptor[],
  options: DiscoveryOptions,
): DiscoveryResult {
  const byId = new Map<string, DiscoveredChannelDescriptor>();
  for (const d of descriptors) byId.set(d.id, d);

  const channels: DiscoveredChannelSummary[] = [];
  const excluded: DiscoveredChannelSummary[] = [];
  const inaccessible: DiscoveredChannelSummary[] = [];
  const supportedById = new Map<string, DiscoveredChannelSummary>();

  // Persist every accessible supported channel (and excluded ones) in one transaction.
  transaction(db, () => {
    for (const d of descriptors) {
      if (!isSupportedChannelKind(d.kind)) continue;

      const caps = d.capabilities ?? NO_ACCESS;
      const fingerprint = computePermissionFingerprint(caps);
      const isThread = d.kind === 'thread';
      const categoryId = resolveCategoryId(byId, d.id);
      const identity = {
        id: d.id,
        guildId: options.guildId,
        parentId: d.parentId,
        isThread,
        kind: d.kind,
        categoryId,
      };
      const resolved = resolveObservedChannelPolicy(db, options.policy, identity, {
        channelPolicySource: options.channelPolicySource,
      });
      const rule = resolved.rule;
      const warnings = describeAccessWarnings(caps, {
        allowInterventions: rule.allow_interventions,
        requireManageThreads: options.requireManageThreads ?? false,
      });
      const isExcluded = !rule.ingest || rule.visibility === 'excluded';

      const hasIngestionAccess = caps.canView && caps.canReadHistory;
      const summary: DiscoveredChannelSummary = {
        id: d.id,
        name: d.name,
        kind: d.kind,
        isThread,
        visibilityClass: rule.visibility,
        policySource: resolved.source,
        ingest: rule.ingest,
        allowInterventions: rule.allow_interventions,
        syncState: 'pending',
        historyComplete: false,
        permissionWarnings: warnings,
        permissionFingerprint: fingerprint,
        accessible: hasIngestionAccess,
        excluded: isExcluded,
      };
      supportedById.set(d.id, summary);

      if (!caps.canView) {
        // Close access for a channel that was visible on an earlier discovery.
        // Unknown channels have no row to update and remain inaccessible.
        const existing = getChannel(db, d.id);
        if (existing) {
          upsertChannel(db, {
            id: existing.id,
            guildId: existing.workspace_id,
            parentId: existing.parent_id,
            kind: existing.kind,
            name: existing.name,
            topic: existing.topic,
            position: existing.position,
            isThread: existing.is_thread === 1,
            isArchived: existing.is_archived === 1,
            isLocked: existing.is_locked === 1,
            ingestEnabled: false,
            visibilityClass: 'excluded',
            allowInterventions: false,
            permissionFingerprint: fingerprint,
            lastMessageId: existing.last_message_id,
            discoveredAtMs: existing.discovered_at_ms,
            updatedAtMs: options.now,
            rawJson: null,
          });
          recordAccessAudit(db, {
            channelId: d.id, checkedAtMs: options.now, canView: false,
            canReadHistory: false, canSend: false, canSendInThreads: false,
            canManageThreads: false, warning: warnings.join('; '),
          });
          db.prepare("UPDATE sync_cursors SET state='excluded', updated_at_ms=? WHERE channel_id=?")
            .run(options.now, d.id);
          reconcileObservedChannelPolicyReviewInTransaction(
            db,
            options.policy,
            identity,
            options.now,
            { accessible: false, channelPolicySource: options.channelPolicySource },
          );
        }
        inaccessible.push(summary);
        continue;
      }

      if (!caps.canReadHistory) {
        // A visible channel without Read Message History is outside the spec's
        // definition of accessible. Persist a fail-closed row so permission
        // drift immediately disables live ingestion for a previously enabled
        // channel, while retaining the audit trail and channel identity.
        upsertChannel(db, {
          id: d.id,
          guildId: options.guildId,
          parentId: d.parentId,
          kind: d.kind,
          name: d.name,
          topic: d.topic ?? null,
          position: d.position ?? null,
          isThread,
          isArchived: d.archived ?? false,
          isLocked: d.locked ?? false,
          ingestEnabled: false,
          visibilityClass: 'excluded',
          allowInterventions: false,
          permissionFingerprint: fingerprint,
          lastMessageId: d.lastMessageId ?? null,
          discoveredAtMs: options.now,
          updatedAtMs: options.now,
          rawJson: null,
        });
        recordAccessAudit(db, {
          channelId: d.id,
          checkedAtMs: options.now,
          canView: caps.canView,
          canReadHistory: caps.canReadHistory,
          canSend: caps.canSend,
          canSendInThreads: caps.canSendInThreads,
          canManageThreads: caps.canManageThreads,
          warning: warnings.join('; '),
        });
        db.prepare("UPDATE sync_cursors SET state='excluded', updated_at_ms=? WHERE channel_id=?")
          .run(options.now, d.id);
        reconcileObservedChannelPolicyReviewInTransaction(
          db,
          options.policy,
          identity,
          options.now,
          { accessible: false, channelPolicySource: options.channelPolicySource },
        );
        inaccessible.push(summary);
        continue;
      }

      upsertChannel(db, {
        id: d.id,
        guildId: options.guildId,
        parentId: d.parentId,
        kind: d.kind,
        name: d.name,
        topic: d.topic ?? null,
        position: d.position ?? null,
        isThread,
        isArchived: d.archived ?? false,
        isLocked: d.locked ?? false,
        ingestEnabled: rule.ingest,
        visibilityClass: rule.visibility,
        allowInterventions: rule.allow_interventions,
        permissionFingerprint: fingerprint,
        lastMessageId: d.lastMessageId ?? null,
        discoveredAtMs: options.now,
        updatedAtMs: options.now,
        rawJson: null,
      });

      recordAccessAudit(db, {
        channelId: d.id,
        checkedAtMs: options.now,
        canView: caps.canView,
        canReadHistory: caps.canReadHistory,
        canSend: caps.canSend,
        canSendInThreads: caps.canSendInThreads,
        canManageThreads: caps.canManageThreads,
        warning: warnings.length > 0 ? warnings.join('; ') : null,
      });

      db.prepare(`UPDATE sync_cursors SET
        state = CASE WHEN ?=1 THEN 'excluded'
                     WHEN state='excluded' AND history_complete=1 THEN 'live'
                     WHEN state='excluded' THEN 'pending'
                     ELSE state END,
        updated_at_ms=? WHERE channel_id=?`).run(isExcluded ? 1 : 0, options.now, d.id);

      reconcileObservedChannelPolicyReviewInTransaction(
        db,
        options.policy,
        identity,
        options.now,
        { channelPolicySource: options.channelPolicySource },
      );

      if (isExcluded) {
        excluded.push(summary);
      } else {
        channels.push(summary);
      }
    }

    // Discord omits channels that the bot cannot view. The guild-channel portion
    // is a complete snapshot, so an omitted non-thread fails closed immediately.
    // Archived threads are fetched separately, however: an active-only pass cannot
    // prove a known thread is gone, while incomplete archive coverage cannot safely
    // leave the row retrievable. The caller therefore chooses preserve only during
    // the in-flight first phase, close for a complete combined snapshot, or the
    // fail-closed default quarantine for incomplete/failed coverage.
    const missing = db.prepare(`SELECT * FROM channels
      WHERE workspace_id = ? AND deleted_at_ms IS NULL`).all(options.guildId) as unknown as Array<{
        id: string; name: string | null; kind: ChannelKind; is_thread: number;
        visibility_class: VisibilityClass;
      }>;
    const noAccessFingerprint = computePermissionFingerprint(NO_ACCESS);
    for (const row of missing) {
      if (supportedById.has(row.id)) continue;
      const missingThreadMode = options.missingThreadMode ?? 'quarantine';
      if (row.is_thread === 1 && missingThreadMode === 'preserve') continue;
      const warning = row.is_thread === 1 && missingThreadMode === 'quarantine'
        ? 'archived thread access unverified: archive coverage incomplete'
        : row.is_thread === 1
          ? 'thread was omitted from complete active and archived discovery'
          : 'channel was omitted from discovery';
      db.prepare(`UPDATE channels SET ingest_enabled=0, visibility_class='excluded',
        allow_interventions=0, permission_fingerprint=?, updated_at_ms=? WHERE id=?`)
        .run(noAccessFingerprint, options.now, row.id);
      db.prepare("UPDATE sync_cursors SET state='excluded', updated_at_ms=? WHERE channel_id=?")
        .run(options.now, row.id);
      recordAccessAudit(db, {
        channelId: row.id, checkedAtMs: options.now, canView: false,
        canReadHistory: false, canSend: false, canSendInThreads: false,
        canManageThreads: false, warning,
      });
      const missingRow = getChannel(db, row.id);
      if (missingRow) {
        reconcileObservedChannelPolicyReviewInTransaction(
          db,
          options.policy,
          {
            id: missingRow.id,
            guildId: missingRow.workspace_id,
            parentId: missingRow.parent_id,
            isThread: missingRow.is_thread === 1,
            kind: missingRow.kind,
          },
          options.now,
          { accessible: false, channelPolicySource: options.channelPolicySource },
        );
      }
      inaccessible.push({
        id: row.id,
        name: row.name,
        kind: row.kind,
        isThread: row.is_thread === 1,
        visibilityClass: 'excluded',
        policySource: 'default',
        ingest: false,
        allowInterventions: false,
        syncState: 'excluded',
        historyComplete: false,
        permissionWarnings: [warning],
        permissionFingerprint: noAccessFingerprint,
        accessible: false,
        excluded: true,
      });
    }
  });

  // Populate sync state from the (possibly pre-existing) cursor rows.
  for (const summary of [...channels, ...excluded]) {
    const sync = readSyncState(db, summary.id);
    summary.syncState = sync.state;
    summary.historyComplete = sync.historyComplete;
  }
  for (const summary of inaccessible) {
    const sync = readSyncState(db, summary.id);
    summary.syncState = sync.state;
    summary.historyComplete = sync.historyComplete;
  }

  const review = validateReviewChannel(options.policy, supportedById);
  const result: DiscoveryResult = {
    guildId: options.guildId,
    channels,
    excluded,
    inaccessible,
    review,
  };

  if (!review.ok) {
    throw new DiscoveryError(review.warning ?? 'Secure review channel is unavailable');
  }

  return result;
}

function validateReviewChannel(
  policy: ChannelPolicy,
  discovered: Map<string, DiscoveredChannelSummary>,
): ReviewChannelValidation {
  const rc = policy.review_channel;
  if (!rc) {
    return { configured: false, channelId: null, present: false, accessible: false, ok: true, warning: null };
  }
  const summary = discovered.get(rc.id);
  const present = summary !== undefined;
  const accessible = summary?.accessible ?? false;
  let ok = true;
  let warning: string | null = null;
  if (rc.secure) {
    if (!present) {
      ok = false;
      warning = 'Secure review channel is configured but was not discovered';
    } else if (!accessible) {
      ok = false;
      warning = 'Secure review channel is inaccessible to Mneme';
    }
  }
  return { configured: true, channelId: rc.id, present, accessible, ok, warning };
}

/** Re-export for callers that construct policy errors from discovery context. */
export { ChannelPolicyError };
