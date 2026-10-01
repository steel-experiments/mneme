import { type DatabaseSync } from '../db/database.js';
import { authorizeAdmin, type AuthorizationReason } from '../policy/authorization.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import { getPauseState, setPaused, type PauseState } from '../runtime-state.js';

/**
 * `/mneme pause` and `/mneme resume` (Sections 27, 47).
 *
 * The pause is the global kill switch for new agent reviews and outbound sends;
 * ingestion and operational health continue, and the state is durable so it
 * survives a restart. Both commands require an admin role (Section 6.6) and are
 * audited in `admin_events` regardless of outcome — success or denial — without
 * content or secrets. This module is the pure command layer over the durable
 * {@link setPaused} state; the discord.js interaction dispatch and the worker's
 * {@link isPaused} predicate are wired separately.
 */

export interface PauseCommandInput {
  actorUserId: string;
  guildId: string;
  /** The caller's role ids, or null when unresolved (fail-closed). */
  memberRoleIds: readonly string[] | null;
}

export interface PauseCommandDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
}

export type PauseCommandOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'done'; state: PauseState; already: boolean };

/**
 * Run `/mneme pause`. Authorization is checked first and recorded on denial;
 * on success the durable pause is set (idempotent — pausing an already-paused
 * process is a no-op reported as `already`). The actor and timestamp are stamped
 * for auditability.
 */
export function handlePauseCommand(
  input: PauseCommandInput,
  deps: PauseCommandDeps,
): PauseCommandOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!outcome.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'pause',
      details: { authorized: false, reason: outcome.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: outcome.reason };
  }

  const before = getPauseState(deps.db);
  const state = setPaused(deps.db, { paused: true, actorUserId: input.actorUserId, now: deps.nowMs });
  recordAdminEvent(deps.db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'pause',
    details: { authorized: true, alreadyPaused: before.paused },
    createdAtMs: deps.nowMs,
  });
  return { kind: 'done', state, already: before.paused };
}

/**
 * Run `/mneme resume`. Same authorization and audit shape as pause; on
 * success the durable pause is cleared, which lets the worker claim the review
 * and send work that accumulated while paused (Section 47).
 */
export function handleResumeCommand(
  input: PauseCommandInput,
  deps: PauseCommandDeps,
): PauseCommandOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!outcome.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'resume',
      details: { authorized: false, reason: outcome.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: outcome.reason };
  }

  const before = getPauseState(deps.db);
  const state = setPaused(deps.db, { paused: false, actorUserId: input.actorUserId, now: deps.nowMs });
  recordAdminEvent(deps.db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'resume',
    details: { authorized: true, wasPaused: before.paused },
    createdAtMs: deps.nowMs,
  });
  return { kind: 'done', state, already: !before.paused };
}

/** Format an ephemeral pause reply. Contains no content or secrets. */
export function formatPauseReply(outcome: PauseCommandOutcome): string {
  if (outcome.kind === 'not_authorized') {
    return 'You are not authorized to pause Mneme.';
  }
  return outcome.already
    ? 'Mneme is already paused — reviews and sends are held; ingestion continues.'
    : 'Mneme paused. New reviews and outbound sends are held; ingestion continues. Use `/mneme resume` to release them.';
}

/** Format an ephemeral resume reply. Contains no content or secrets. */
export function formatResumeReply(outcome: PauseCommandOutcome): string {
  if (outcome.kind === 'not_authorized') {
    return 'You are not authorized to resume Mneme.';
  }
  return outcome.already
    ? 'Mneme is already running — reviews and sends are active.'
    : 'Mneme resumed. Queued reviews and sends are being released.';
}
