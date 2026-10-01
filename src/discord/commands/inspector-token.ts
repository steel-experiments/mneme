import { type DatabaseSync } from '../../db/database.js';
import { authorizeAndAuditAdminAction } from '../authorization.js';
import {
  getInspectorToken,
  listInspectorTokens,
  revokeInspectorToken,
  type SafeInspectorTokenRow,
} from '../../db/repositories/inspector-tokens.js';
import { createInspectorToken, INSPECTOR_TOKEN_BYTES, hashInspectorTokenValue } from '../../http/inspector/tokens.js';

/**
 * `/mneme inspector-token create|list|revoke` (Sections 27, 32.6).
 *
 * The admin surface over inspector bearer tokens. `create` issues a token for
 * the Section 32.6 read-only web surface and returns the plaintext **exactly
 * once** in its reply — the same single-reveal rule as MCP tokens. `list`
 * returns metadata only: name, timestamps, revocation state — never the token
 * or its hash. `revoke` invalidates a token immediately.
 *
 * The handler is free of discord.js types; a dispatcher extracts the actor,
 * roles, and subcommand options, then replies with
 * {@link formatInspectorTokenReply}. Every attempt authorizes first via
 * {@link authorizeAndAuditAdminAction}, audited on both denial and success,
 * with no secret in the details. Issuance and validation reuse
 * {@link createInspectorToken} / {@link resolveInspectorToken} in the HTTP
 * layer, so there is one code path that hashes the plaintext.
 */

/** Truncated id used for human-readable display (full id is still accepted). */
const SHORT_ID_LENGTH = 8;
/** Cap the list reply so a large token table cannot flood the response. */
const MAX_LIST_ROWS = 25;

export type InspectorTokenSubcommand = 'create' | 'list' | 'revoke';

export interface HandleInspectorTokenInput {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  subcommand: InspectorTokenSubcommand;
  /** `create`: human-readable name (required by the command option). */
  name?: string | null;
  /** `create`: days until expiry, 1-365 (optional; default 30). */
  expiresDays?: number | null;
  /** `revoke`: token id to revoke (required by the command option). */
  tokenId?: string | null;
}

export interface HandleInspectorTokenDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  /** Inspector surface URL echoed in the `create` reply; omitted when unknown. */
  endpointUrl?: string | null;
  /** Whether the inspector surface is enabled. Defaults true for callers outside production wiring. */
  inspectorEnabled?: boolean;
}

export type InspectorTokenCommandOutcome =
  | { kind: 'not_authorized' }
  | { kind: 'create_invalid'; detail: string }
  | { kind: 'created'; token: string; row: SafeInspectorTokenRow; endpointUrl: string | null; endpointEnabled: boolean }
  | { kind: 'list'; rows: readonly SafeInspectorTokenRow[] }
  | { kind: 'revoked'; row: SafeInspectorTokenRow; alreadyRevoked: boolean }
  | { kind: 'not_found' };

/** Map a subcommand to its audit `action` label. */
function actionFor(sub: InspectorTokenSubcommand): string {
  return sub === 'create' ? 'inspector_token_create' : sub === 'list' ? 'inspector_token_list' : 'inspector_token_revoke';
}

/** Audit target: the requested name (create), id (revoke), or null (list). */
function targetFor(input: HandleInspectorTokenInput): string | null {
  if (input.subcommand === 'create') return input.name?.trim() || null;
  if (input.subcommand === 'revoke') return input.tokenId?.trim() || null;
  return null;
}

/** Non-secret audit details (the token value is never a detail). */
function detailsFor(input: HandleInspectorTokenInput): Record<string, unknown> | null {
  if (input.subcommand === 'create') {
    return {
      name: input.name?.trim() ?? null,
      requestedExpiresDays: input.expiresDays ?? null,
    };
  }
  return null;
}

/**
 * Run an `inspector-token` subcommand. Authorize first (audited on both denial
 * and success), then dispatch. The plaintext token is returned only on a
 * successful `create`; `list` and `revoke` carry metadata only.
 */
export function handleInspectorTokenCommand(
  input: HandleInspectorTokenInput,
  deps: HandleInspectorTokenDeps,
): InspectorTokenCommandOutcome {
  const outcome = authorizeAndAuditAdminAction(deps.db, {
    memberRoleIds: input.memberRoleIds,
    adminRoleIds: deps.adminRoleIds,
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: actionFor(input.subcommand),
    target: targetFor(input),
    details: detailsFor(input),
    now: deps.nowMs,
  });
  if (!outcome.authorized) return { kind: 'not_authorized' };

  switch (input.subcommand) {
    case 'create':
      return runCreate(input, deps);
    case 'list':
      return { kind: 'list', rows: listInspectorTokens(deps.db) };
    case 'revoke':
      return runRevoke(input, deps);
  }
}

/** Bounds for the `expires-days` option. Inspector tokens default to 30 days. */
export const MIN_INSPECTOR_TOKEN_EXPIRES_DAYS = 1;
export const MAX_INSPECTOR_TOKEN_EXPIRES_DAYS = 365;

/**
 * `create` — issue via the shared token layer. An omitted `expires-days` leaves
 * `expiresAtMs` undefined so the token layer applies its default lifetime; the
 * command never issues a non-expiring token.
 */
function runCreate(
  input: HandleInspectorTokenInput,
  deps: HandleInspectorTokenDeps,
): InspectorTokenCommandOutcome {
  const days = input.expiresDays ?? null;
  if (days !== null) {
    if (
      !Number.isInteger(days) ||
      days < MIN_INSPECTOR_TOKEN_EXPIRES_DAYS ||
      days > MAX_INSPECTOR_TOKEN_EXPIRES_DAYS
    ) {
      return {
        kind: 'create_invalid',
        detail: `expires-days must be an integer between ${MIN_INSPECTOR_TOKEN_EXPIRES_DAYS} and ${MAX_INSPECTOR_TOKEN_EXPIRES_DAYS}`,
      };
    }
  }
  const result = createInspectorToken(
    { db: deps.db, nowMs: deps.nowMs },
    {
      name: input.name ?? '',
      createdByUserId: input.actorUserId,
      ...(days !== null ? { expiresAtMs: deps.nowMs + days * 86_400_000 } : {}),
    },
  );
  if (result.kind === 'invalid') {
    return { kind: 'create_invalid', detail: result.detail };
  }
  return {
    kind: 'created',
    token: result.token,
    row: result.row,
    endpointUrl: deps.inspectorEnabled === false ? null : deps.endpointUrl ?? null,
    endpointEnabled: deps.inspectorEnabled !== false,
  };
}

/** `revoke` — revoke immediately (idempotent); report not_found for an unknown id. */
function runRevoke(
  input: HandleInspectorTokenInput,
  deps: HandleInspectorTokenDeps,
): InspectorTokenCommandOutcome {
  const id = input.tokenId?.trim() ?? '';
  const exact = id.length > 0 ? getInspectorToken(deps.db, id) : undefined;
  const prefixMatches = exact || id.length < SHORT_ID_LENGTH
    ? []
    : listInspectorTokens(deps.db).filter((row) => row.id.startsWith(id));
  const existing = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
  if (!existing) return { kind: 'not_found' };
  const alreadyRevoked = existing.revokedAtMs !== null;
  revokeInspectorToken(deps.db, existing.id, deps.nowMs);
  const row = getInspectorToken(deps.db, existing.id) ?? existing;
  return { kind: 'revoked', row, alreadyRevoked };
}

/** Exposed for tests: hash helper re-export keeps the token module the single home. */
export { hashInspectorTokenValue, INSPECTOR_TOKEN_BYTES };

/**
 * Format the outcome as an ephemeral reply. The plaintext token appears **only**
 * in the `created` branch; every other branch carries metadata, timestamps, or a
 * status — never the token or its hash.
 */
export function formatInspectorTokenReply(outcome: InspectorTokenCommandOutcome): string {
  switch (outcome.kind) {
    case 'not_authorized':
      return 'You are not authorized to manage inspector tokens.';

    case 'create_invalid':
      return `Could not create the inspector token: ${outcome.detail}`;

    case 'created': {
      const { token, row, endpointUrl, endpointEnabled } = outcome;
      return [
        'Inspector bearer token created — shown once, copy it now (stored only as a hash; it cannot be recovered):',
        '',
        token,
        '',
        ...(endpointUrl ? [`Surface: ${endpointUrl}`] : []),
        ...(!endpointEnabled ? ['Surface: currently disabled; the token is ready for later use.'] : []),
        `Name: ${row.name}`,
        `Created: ${formatMs(row.createdAtMs)}; Expires: ${formatMs(row.expiresAtMs)}`,
        ...(endpointUrl
          ? [
              '',
              'In a browser, open that URL and paste the token as the password in the login dialog ' +
                '(any username). From a command-line client, send `Authorization: Bearer <token>`. ' +
                'The surface is read-only. Keep the token out of shell history and source control.',
            ]
          : []),
      ].join('\n');
    }

    case 'list': {
      const rows = outcome.rows;
      if (rows.length === 0) return 'No inspector tokens have been issued.';
      const truncated = rows.length > MAX_LIST_ROWS;
      const shown = rows.slice(0, MAX_LIST_ROWS);
      const header = `Inspector tokens (${rows.length}${truncated ? `, showing first ${MAX_LIST_ROWS}` : ''}):`;
      const lines = [header];
      for (const r of shown) {
        const status = r.revokedAtMs !== null ? 'revoked' : 'active';
        lines.push(
          `• ${r.id.slice(0, SHORT_ID_LENGTH)} ${r.name} — created ${formatMs(r.createdAtMs)}, ` +
            `expires ${formatMs(r.expiresAtMs)}, last used ${formatMs(r.lastUsedAtMs)}, ${status}`,
        );
      }
      return lines.join('\n');
    }

    case 'revoked': {
      const r = outcome.row;
      const note = outcome.alreadyRevoked ? ' (was already revoked)' : '';
      return `Revoked inspector token ${r.id.slice(0, SHORT_ID_LENGTH)} (${r.name})${note}. It is invalid for the next request.`;
    }

    case 'not_found':
      return 'No inspector token found for that id.';
  }
}

/** Format an epoch-ms timestamp as ISO UTC, or `never` when null. */
function formatMs(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toISOString();
}
