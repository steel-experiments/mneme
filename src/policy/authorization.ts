import { type DatabaseSync } from '../db/database.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';

/**
 * Admin-role authorization and auditing (Sections 6.6, 27, 44).
 *
 * Guild-scoped Mneme commands and review controls are gated on the configured
 * role IDs in `MNEME_ADMIN_ROLE_IDS`. Authorization fails closed in two cases
 * required by Section 6.6: when no admin roles are configured (nobody is privileged)
 * and when the member's role data could not be resolved (a partial member or cache
 * miss must not be treated as authorized). Every attempted material admin action —
 * success or denial — is recorded in `admin_events` without content or secrets.
 */

export type AuthorizationReason =
  | 'ok'
  | 'no_admin_roles_configured'
  | 'role_data_unavailable'
  | 'not_authorized';

export interface AuthorizationOutcome {
  authorized: boolean;
  reason: AuthorizationReason;
}

/**
 * Decide whether a member may perform an admin action.
 *
 * - `no_admin_roles_configured` when the allowlist is empty (fail closed: nobody).
 * - `role_data_unavailable` when the member's roles could not be resolved
 *   (`memberRoleIds` is null/undefined). An empty but resolved array is a real
 *   "no admin role" result (`not_authorized`), not missing data.
 * - `ok` / `not_authorized` by set intersection otherwise.
 */
export function authorizeAdmin(
  memberRoleIds: readonly string[] | null | undefined,
  adminRoleIds: readonly string[],
): AuthorizationOutcome {
  if (!Array.isArray(adminRoleIds) || adminRoleIds.length === 0) {
    return { authorized: false, reason: 'no_admin_roles_configured' };
  }
  if (!Array.isArray(memberRoleIds)) {
    return { authorized: false, reason: 'role_data_unavailable' };
  }
  const admin = new Set(adminRoleIds);
  return memberRoleIds.some((id) => admin.has(id))
    ? { authorized: true, reason: 'ok' }
    : { authorized: false, reason: 'not_authorized' };
}

/** Thrown by `requireAdmin` when authorization is denied. Carries the outcome. */
export class AuthorizationDeniedError extends Error {
  constructor(public readonly outcome: AuthorizationOutcome) {
    super(`admin authorization denied: ${outcome.reason}`);
    this.name = 'AuthorizationDeniedError';
  }
}

/** Authorize, or throw `AuthorizationDeniedError`. Returns the outcome on success. */
export function requireAdmin(
  memberRoleIds: readonly string[] | null | undefined,
  adminRoleIds: readonly string[],
): AuthorizationOutcome {
  const outcome = authorizeAdmin(memberRoleIds, adminRoleIds);
  if (!outcome.authorized) throw new AuthorizationDeniedError(outcome);
  return outcome;
}

export interface AuthorizeAndAuditInput {
  memberRoleIds: readonly string[] | null | undefined;
  adminRoleIds: readonly string[];
  guildId: string;
  actorUserId: string;
  action: string;
  target?: string | null;
  details?: Record<string, unknown> | null;
  now: number;
}

/**
 * Authorize an attempted admin action and record it in `admin_events` regardless of
 * outcome, with the decision folded into the (sanitized) details. Returns the
 * authorization outcome so the caller can branch without re-deciding.
 */
export function authorizeAndAuditAdminAction(
  db: DatabaseSync,
  input: AuthorizeAndAuditInput,
): AuthorizationOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, input.adminRoleIds);
  recordAdminEvent(db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: input.action,
    target: input.target,
    details: { ...input.details, authorized: outcome.authorized, reason: outcome.reason },
    createdAtMs: input.now,
  });
  return outcome;
}
