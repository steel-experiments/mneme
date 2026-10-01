import { type DatabaseSync } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';
import { getChannel } from '../db/repositories/channels.js';
import { getEpisode } from '../episodes/repository.js';
import { enqueue } from '../jobs/queue.js';
import { RECONCILE_CHANNEL_KEY } from '../jobs/scheduler.js';
import { authorizeAdmin, type AuthorizationReason } from '../policy/authorization.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import { isMnemeTestSurface } from '../ingestion/test-channels.js';

/**
 * `/mneme sync [channel]` and the episode-flush operation
 * (Sections 11.3, 27).
 *
 * Both acknowledge the interaction immediately and enqueue the real work as
 * durable, unique-keyed jobs — they never run backfill, reconciliation, or
 * episode closure inline. The unique keys collapse duplicate active jobs: a
 * repeated request (or one that overlaps the periodic schedule) enqueues nothing
 * new and reports `enqueued: false` rather than piling up work (Section 10).
 *
 * Reconciliation reuses the periodic per-channel key so a manual sync never
 * duplicates a reconcile the scheduler already queued. Full backfill and an
 * explicit episode close use dedicated admin keys (no periodic equivalent for
 * backfill; the flush forces an immediate close evaluation). Every channel is
 * validated against the configured guild and policy scope before any job is
 * queued; excluded channels are rejected.
 */

const BACKFILL_KEY = (channelId: string) => `admin:backfill:channel:${channelId}`;
const FLUSH_KEY = (episodeId: string) => `admin:flush:episode:${episodeId}`;

export interface EnqueuedJob {
  /** Target channel id (sync) or episode id (flush) the job covers. */
  targetId: string;
  /** Durable job id, when a new job was actually enqueued. */
  jobId?: string;
  /** False when a duplicate active job caused this enqueue to collapse. */
  enqueued: boolean;
}

// ---- /mneme sync --------------------------------------------------------

export interface HandleSyncInput {
  actorUserId: string;
  guildId: string;
  /** The caller's role ids, or null when unresolved (fail-closed). */
  memberRoleIds: readonly string[] | null;
  /** Channel to sync; omitted means every in-scope channel in the guild. */
  channelId?: string | null;
  /** True to queue a full historical backfill instead of an overlap reconcile. */
  full?: boolean;
}

export interface HandleSyncDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
}

export type SyncOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'channel_not_found'; channelId: string }
  | { kind: 'channel_excluded'; channelId: string; visibilityClass: string }
  | { kind: 'enqueued'; full: boolean; jobs: EnqueuedJob[] };

/** Run `/mneme sync [channel]`. Authorize, validate scope, enqueue, return. */
export function handleSyncCommand(input: HandleSyncInput, deps: HandleSyncDeps): SyncOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!outcome.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'sync',
      details: { authorized: false, reason: outcome.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: outcome.reason };
  }

  const full = input.full === true;
  const resolved = resolveTargetChannels(deps.db, input);
  if (!resolved.ok) {
    return resolved.outcome; // channel_not_found | channel_excluded
  }
  const targetChannelIds = resolved.channelIds;

  const jobs: EnqueuedJob[] = targetChannelIds.map((channelId) => {
    const result = full
      ? enqueue(deps.db, {
          type: 'backfill_channel',
          payload: { channelId },
          uniqueKey: BACKFILL_KEY(channelId),
          now: deps.nowMs,
        })
      : enqueue(deps.db, {
          type: 'reconcile_channel',
          payload: { channelId },
          uniqueKey: RECONCILE_CHANNEL_KEY(channelId),
          now: deps.nowMs,
        });
    return {
      targetId: channelId,
      jobId: result.enqueued ? result.id : undefined,
      enqueued: result.enqueued,
    };
  });

  recordAdminEvent(deps.db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'sync',
    details: {
      authorized: true,
      full,
      channelIds: targetChannelIds,
      enqueued: jobs.filter((j) => j.enqueued).length,
      collapsed: jobs.filter((j) => !j.enqueued).length,
    },
    createdAtMs: deps.nowMs,
  });

  return { kind: 'enqueued', full, jobs };
}

/**
 * Resolve the channel ids to sync. A single named channel is validated against
 * the guild and policy scope; omitted means every non-deleted, non-excluded
 * channel in the guild. Returns an error outcome for an invalid/excluded channel.
 */
function resolveTargetChannels(
  db: DatabaseSync,
  input: HandleSyncInput,
): { ok: true; channelIds: string[] } | { ok: false; outcome: Exclude<SyncOutcome, { kind: 'enqueued' | 'not_authorized' }> } {
  if (input.channelId) {
    const channel = getChannel(db, input.channelId);
    if (!channel || channel.workspace_id !== input.guildId || channel.deleted_at_ms !== null) {
      return { ok: false, outcome: { kind: 'channel_not_found', channelId: input.channelId } };
    }
    if (channel.visibility_class === 'excluded' || isMnemeTestSurface(db, channel.id)) {
      return { ok: false, outcome: { kind: 'channel_excluded', channelId: input.channelId, visibilityClass: 'excluded' } };
    }
    return { ok: true, channelIds: [input.channelId] };
  }
  const rows = prepareCached(
    db,
    'sync.target_channels',
    `SELECT id FROM channels
      WHERE workspace_id = ? AND deleted_at_ms IS NULL AND visibility_class != 'excluded'
      ORDER BY id`,
  ).all(input.guildId) as Array<{ id: string }>;
  return {
    ok: true,
    channelIds: rows.map((row) => row.id)
      .filter((channelId) => !isMnemeTestSurface(db, channelId)),
  };
}

/** Format an ephemeral sync reply. Channel ids and counts only — no content. */
export function formatSyncReply(outcome: SyncOutcome): string {
  if (outcome.kind === 'not_authorized') return 'You are not authorized to run sync.';
  if (outcome.kind === 'channel_not_found') {
    return `Channel ${outcome.channelId} is not in this guild's configured scope.`;
  }
  if (outcome.kind === 'channel_excluded') {
    return `Channel ${outcome.channelId} is excluded from ingestion and cannot be synced.`;
  }
  const verb = outcome.full ? 'full backfill' : 'reconciliation';
  const enqueued = outcome.jobs.filter((j) => j.enqueued);
  const collapsed = outcome.jobs.filter((j) => !j.enqueued);
  const parts = [`Queued ${verb} for ${enqueued.length} channel(s).`];
  if (collapsed.length > 0) {
    parts.push(`${collapsed.length} already active (no duplicate created).`);
  }
  return parts.join(' ');
}

// ---- episode flush ----------------------------------------------------------

export interface HandleFlushInput {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  episodeId: string;
}

export interface HandleFlushDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
}

export type FlushOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'episode_not_found'; episodeId: string }
  | ({ kind: 'enqueued' } & EnqueuedJob);

/**
 * Run an explicit episode closure. Authorize, validate the episode belongs to
 * this guild, then enqueue a due-now `close_episode` job under a dedicated admin
 * key (a repeat collapses; it never conflicts with the periodic quiet-close
 * schedule, which is idempotent). Returns without waiting for the close.
 */
export function handleFlushEpisodesCommand(input: HandleFlushInput, deps: HandleFlushDeps): FlushOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!outcome.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'episode_flush',
      details: { authorized: false, reason: outcome.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: outcome.reason };
  }

  const episode = getEpisode(deps.db, input.episodeId);
  if (!episode || episode.workspace_id !== input.guildId) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'episode_flush',
      details: { authorized: true, episodeId: input.episodeId, found: false },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'episode_not_found', episodeId: input.episodeId };
  }

  // Due now (runAfterMs 0); the close handler closes a quiet episode or
  // reschedules one whose quiet window has not elapsed.
  const result = enqueue(deps.db, {
    type: 'close_episode',
    payload: { episodeId: input.episodeId },
    uniqueKey: FLUSH_KEY(input.episodeId),
    runAfterMs: 0,
    now: deps.nowMs,
  });

  recordAdminEvent(deps.db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'episode_flush',
    details: { authorized: true, episodeId: input.episodeId, enqueued: result.enqueued },
    createdAtMs: deps.nowMs,
  });

  return {
    kind: 'enqueued',
    targetId: input.episodeId,
    jobId: result.enqueued ? result.id : undefined,
    enqueued: result.enqueued,
  };
}

/** Format an ephemeral episode-flush reply. Episode id and status only. */
export function formatFlushReply(outcome: FlushOutcome): string {
  if (outcome.kind === 'not_authorized') return 'You are not authorized to flush episodes.';
  if (outcome.kind === 'episode_not_found') {
    return `Episode ${outcome.episodeId} was not found in this guild.`;
  }
  return outcome.enqueued
    ? `Queued an explicit close for episode ${outcome.targetId}.`
    : `A close for episode ${outcome.targetId} is already active (no duplicate created).`;
}
