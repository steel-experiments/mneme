import { type DatabaseSync } from '../db/database.js';
import { authorizeAndAuditAdminAction } from '../policy/authorization.js';
import {
  runIntegrityCheck,
  runForeignKeyCheck,
  walCheckpoint,
  type IntegrityCheckResult,
  type ForeignKeyCheckResult,
  type WalCheckpointResult,
} from '../db/maintenance.js';

/**
 * `/mneme integrity-check` (Section 28).
 *
 * An on-demand database health probe. The handler authorizes the caller first
 * (fail-closed, audited on both denial and success), then runs the canonical
 * integrity checks — `PRAGMA integrity_check` and `PRAGMA foreign_key_check` —
 * plus a passive WAL checkpoint that reports the outstanding WAL log size. The
 * reply reports the outcomes; it never echoes message content or secrets.
 *
 * This command reads the open database directly. It is deliberately distinct
 * from the backup subsystem's standalone-snapshot integrity check: it verifies
 * the *live* database the process is using. Maintenance (optimize, VACUUM +
 * FTS rebuild) is the periodic job's job; this command only inspects.
 *
 * The handler is free of discord.js types; a dispatcher extracts the actor and
 * roles from the interaction, then replies with {@link formatIntegrityCheckReply}.
 */

export interface HandleIntegrityCheckInput {
  actorUserId: string;
  guildId: string;
  /** The caller's role ids, or null when unresolved (fail-closed). */
  memberRoleIds: readonly string[] | null;
}

export interface HandleIntegrityCheckDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
}

/** The diagnostic data reported by a successful integrity check. */
export interface IntegrityCheckData {
  integrity: IntegrityCheckResult;
  foreignKeys: ForeignKeyCheckResult;
  checkpoint: WalCheckpointResult;
}

export type IntegrityCheckOutcome =
  | { kind: 'not_authorized' }
  | { kind: 'done'; data: IntegrityCheckData };

/**
 * Run `/mneme integrity-check`. Authorize first (audited on both denial and
 * success), then run the integrity checks and a passive WAL checkpoint, and
 * report the outcomes.
 */
export function handleIntegrityCheckCommand(
  input: HandleIntegrityCheckInput,
  deps: HandleIntegrityCheckDeps,
): IntegrityCheckOutcome {
  const outcome = authorizeAndAuditAdminAction(deps.db, {
    memberRoleIds: input.memberRoleIds,
    adminRoleIds: deps.adminRoleIds,
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'integrity_check',
    target: null,
    now: deps.nowMs,
  });
  if (!outcome.authorized) return { kind: 'not_authorized' };

  const integrity = runIntegrityCheck(deps.db);
  const foreignKeys = runForeignKeyCheck(deps.db);
  const checkpoint = walCheckpoint(deps.db, 'PASSIVE');
  return { kind: 'done', data: { integrity, foreignKeys, checkpoint } };
}

/**
 * Format the outcome as an ephemeral reply. Reports the verdicts and the WAL log
 * size; contains no content or secrets. Failure lines (when any) are included so
 * an operator sees the problem without re-running, capped to a sane length.
 */
export function formatIntegrityCheckReply(outcome: IntegrityCheckOutcome): string {
  if (outcome.kind === 'not_authorized') {
    return 'You are not authorized to run database integrity checks.';
  }
  const { integrity, foreignKeys, checkpoint } = outcome.data;
  const lines: string[] = [];
  lines.push(integrity.ok ? 'integrity_check: ok' : `integrity_check: FAILED — ${truncate(integrity.message)}`);
  lines.push(
    foreignKeys.ok
      ? 'foreign_key_check: ok'
      : `foreign_key_check: ${foreignKeys.violations} violation(s) — ${truncate(foreignKeys.message)}`,
  );
  const busy = checkpoint.busy === 1 ? ' (busy, retried later)' : '';
  lines.push(`wal_checkpoint(PASSIVE): ${checkpoint.checkpointedFrames} frame(s) written, ${checkpoint.logFrames} in log${busy}`);
  return lines.join('\n');
}

/** Cap a diagnostic string so a long integrity_report cannot flood the reply. */
function truncate(s: string, limit = 800): string {
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}
