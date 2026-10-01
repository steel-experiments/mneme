import { type DatabaseSync } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';
import { getChannel } from '../db/repositories/channels.js';
import { authorizeAndAuditAdminAction } from '../policy/authorization.js';
import {
  createMcpToken,
  type InvalidScopeReason,
  type SafeMcpTokenRow,
} from '../mcp/auth.js';
import { listMcpTokens, getMcpToken, revokeMcpToken } from '../db/repositories/mcp-tokens.js';

/**
 * `/mneme mcp-token create|list|revoke` (Sections 27, 32.5.2).
 *
 * The admin surface over MCP bearer tokens. `create` issues a scoped token and
 * returns the plaintext **exactly once** in its reply — the only place it ever
 * appears outside the creator's ephemeral interaction (Section 32.5.2: "shown
 * exactly once"). `list` returns metadata only: name, scope, channel count,
 * timestamps, and revocation state — never the token or its hash. `revoke`
 * invalidates a token immediately so the next authenticated request is rejected.
 *
 * The handler is free of discord.js types; a dispatcher extracts the actor,
 * roles, and subcommand options, then replies with {@link formatMcpTokenReply}.
 * Every attempt authorizes first via {@link authorizeAndAuditAdminAction} — the
 * decision is audited on both denial and success, with the token name (create) or
 * id (revoke) as the target and no secret in the details. Grant issuance and
 * validation reuse {@link createMcpToken}, so there is one code path that hashes
 * the plaintext and enforces "never review_only / excluded."
 */

/** Truncated id used for human-readable display (full id is still accepted). */
const SHORT_ID_LENGTH = 8;
/** Cap the list reply so a large token table cannot flood the response. */
const MAX_LIST_ROWS = 25;

export type McpTokenSubcommand = 'create' | 'list' | 'revoke';

export interface HandleMcpTokenInput {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  subcommand: McpTokenSubcommand;
  /** `create`: human-readable name (required by the command option). */
  name?: string | null;
  /** `create`: comma-separated channel names or ids to grant (optional). */
  channels?: string | null;
  /** `create`: days until expiry, 1-365 (optional; default 90 via the auth layer). */
  expiresDays?: number | null;
  /** `revoke`: token id to revoke (required by the command option). */
  tokenId?: string | null;
}

export interface HandleMcpTokenDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  /** Full MCP endpoint URL echoed in the `create` reply; omitted when unknown. */
  endpointUrl?: string | null;
  /** Whether the HTTP MCP endpoint is currently enabled. Defaults true for callers outside production wiring. */
  mcpEnabled?: boolean;
}

export type McpTokenCommandOutcome =
  | { kind: 'not_authorized' }
  | { kind: 'create_invalid'; reason: InvalidScopeReason; detail: string }
  | { kind: 'created'; token: string; row: SafeMcpTokenRow; endpointUrl: string | null; endpointEnabled: boolean }
  | { kind: 'list'; rows: readonly SafeMcpTokenRow[] }
  | { kind: 'revoked'; row: SafeMcpTokenRow; alreadyRevoked: boolean }
  | { kind: 'not_found' };

/** Map a subcommand to its audit `action` label. */
function actionFor(sub: McpTokenSubcommand): string {
  return sub === 'create' ? 'mcp_token_create' : sub === 'list' ? 'mcp_token_list' : 'mcp_token_revoke';
}

/** Audit target: the requested name (create), id (revoke), or null (list). */
function targetFor(input: HandleMcpTokenInput): string | null {
  if (input.subcommand === 'create') return input.name?.trim() || null;
  if (input.subcommand === 'revoke') return input.tokenId?.trim() || null;
  return null;
}

/** Non-secret audit details (the token value is never a detail). */
function detailsFor(input: HandleMcpTokenInput): Record<string, unknown> | null {
  if (input.subcommand === 'create') {
    return {
      name: input.name?.trim() ?? null,
      requestedChannelCount: parseChannelRefs(input.channels).length,
      requestedExpiresDays: input.expiresDays ?? null,
    };
  }
  return null;
}

/**
 * Run an `mcp-token` subcommand. Authorize first (audited on both denial and
 * success), then dispatch. The plaintext token is returned only on a successful
 * `create`; `list` and `revoke` carry metadata only.
 */
export function handleMcpTokenCommand(
  input: HandleMcpTokenInput,
  deps: HandleMcpTokenDeps,
): McpTokenCommandOutcome {
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
      return { kind: 'list', rows: listMcpTokens(deps.db) };
    case 'revoke':
      return runRevoke(input, deps);
  }
}

/** Bounds for the `expires-days` option (Section 32.5.2). */
export const MIN_MCP_TOKEN_EXPIRES_DAYS = 1;
export const MAX_MCP_TOKEN_EXPIRES_DAYS = 365;

/**
 * `create` — resolve channel refs to ids, then issue via the shared auth layer.
 * An omitted `expires-days` leaves `expiresAtMs` undefined so the auth layer
 * applies its default lifetime; the command never issues a non-expiring token.
 */
function runCreate(input: HandleMcpTokenInput, deps: HandleMcpTokenDeps): McpTokenCommandOutcome {
  const days = input.expiresDays ?? null;
  if (days !== null) {
    if (
      !Number.isInteger(days) ||
      days < MIN_MCP_TOKEN_EXPIRES_DAYS ||
      days > MAX_MCP_TOKEN_EXPIRES_DAYS
    ) {
      return {
        kind: 'create_invalid',
        reason: 'invalid_expiry_days',
        detail: `expires-days must be an integer between ${MIN_MCP_TOKEN_EXPIRES_DAYS} and ${MAX_MCP_TOKEN_EXPIRES_DAYS}`,
      };
    }
  }
  const channelIds: string[] = [];
  for (const ref of parseChannelRefs(input.channels)) {
    const resolution = resolveChannelRef(deps.db, ref);
    if (resolution.kind === 'ambiguous') {
      return {
        kind: 'create_invalid',
        reason: 'ambiguous_channel',
        detail: `channel name ${ref} matches ${resolution.matchCount} live channels; use the Discord channel ID`,
      };
    }
    channelIds.push(resolution.channelId);
  }
  const result = createMcpToken(
    { db: deps.db, nowMs: deps.nowMs },
    {
      name: input.name ?? '',
      channelIds,
      createdByUserId: input.actorUserId,
      ...(days !== null ? { expiresAtMs: deps.nowMs + days * 86_400_000 } : {}),
    },
  );
  if (result.kind === 'invalid') {
    return { kind: 'create_invalid', reason: result.reason, detail: result.detail };
  }
  return {
    kind: 'created',
    token: result.token,
    row: result.row,
    endpointUrl: deps.mcpEnabled === false ? null : deps.endpointUrl ?? null,
    endpointEnabled: deps.mcpEnabled !== false,
  };
}

/** `revoke` — revoke immediately (idempotent); report not_found for an unknown id. */
function runRevoke(input: HandleMcpTokenInput, deps: HandleMcpTokenDeps): McpTokenCommandOutcome {
  const id = input.tokenId?.trim() ?? '';
  const exact = id.length > 0 ? getMcpToken(deps.db, id) : undefined;
  const prefixMatches = exact || id.length < SHORT_ID_LENGTH
    ? []
    : listMcpTokens(deps.db).filter((row) => row.id.startsWith(id));
  const existing = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
  if (!existing) return { kind: 'not_found' };
  const alreadyRevoked = existing.revokedAtMs !== null;
  revokeMcpToken(deps.db, existing.id, deps.nowMs);
  const row = getMcpToken(deps.db, existing.id) ?? existing;
  return { kind: 'revoked', row, alreadyRevoked };
}

/**
 * Split the comma-separated `channels` option into trimmed, non-empty refs. Each
 * ref may be a channel id or a channel name (the command option accepts both).
 */
export function parseChannelRefs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve one channel ref to its id. A direct id match wins. Name lookup accepts
 * exactly one live match and reports ambiguity when multiple channels share the
 * name. An unresolvable ref is returned unchanged so {@link createMcpToken} can
 * report it as `unknown_channel` rather than silently dropping it.
 */
export type ChannelRefResolution =
  | { kind: 'resolved'; channelId: string }
  | { kind: 'ambiguous'; matchCount: number };

export function resolveChannelRef(db: DatabaseSync, ref: string): ChannelRefResolution {
  if (getChannel(db, ref)) return { kind: 'resolved', channelId: ref };
  const rows = prepareCached(
    db,
    'mcp-token.channelByName',
    'SELECT id FROM channels WHERE name = ? AND deleted_at_ms IS NULL ORDER BY id LIMIT 2',
  ).all(ref) as Array<{ id: string }>;
  if (rows.length > 1) return { kind: 'ambiguous', matchCount: rows.length };
  return { kind: 'resolved', channelId: rows[0]?.id ?? ref };
}

/**
 * Format the outcome as an ephemeral reply. The plaintext token appears **only**
 * in the `created` branch; every other branch carries metadata, timestamps, or a
 * status — never the token or its hash.
 */
export function formatMcpTokenReply(outcome: McpTokenCommandOutcome): string {
  switch (outcome.kind) {
    case 'not_authorized':
      return 'You are not authorized to manage MCP tokens.';

    case 'create_invalid':
      return `Could not create the MCP token: ${outcome.detail}`;

    case 'created': {
      const { token, row, endpointUrl, endpointEnabled } = outcome;
      const scope =
        row.scopeType === 'org'
          ? 'org (no restricted channels)'
          : `org_plus_channels — grants ${row.channelIds.length} restricted channel(s)`;
      return [
        'MCP bearer token created — shown once, copy it now (stored only as a hash; it cannot be recovered):',
        '',
        token,
        '',
        ...(endpointUrl ? [`Endpoint: ${endpointUrl}`] : []),
        ...(!endpointEnabled ? ['Endpoint: currently disabled; the token is ready for later use.'] : []),
        `Name: ${row.name}`,
        `Scope: ${scope}`,
        `Created: ${formatMs(row.createdAtMs)}; Expires: ${formatMs(row.expiresAtMs)}`,
        ...(endpointUrl
          ? [
              '',
              'Point the client at that URL with header `Authorization: Bearer <token>`. ' +
                'Keep the token out of shell history and source control.',
            ]
          : []),
      ].join('\n');
    }

    case 'list': {
      const rows = outcome.rows;
      if (rows.length === 0) return 'No MCP tokens have been issued.';
      const truncated = rows.length > MAX_LIST_ROWS;
      const shown = rows.slice(0, MAX_LIST_ROWS);
      const header = `MCP tokens (${rows.length}${truncated ? `, showing first ${MAX_LIST_ROWS}` : ''}):`;
      const lines = [header];
      for (const r of shown) {
        const status = r.revokedAtMs !== null ? 'revoked' : 'active';
        const scope = r.scopeType === 'org' ? 'org' : `org+${r.channelIds.length}ch`;
        lines.push(
          `• ${tokenShortId(r.id)} ${r.name} — ${scope}, created ${formatMs(r.createdAtMs)}, ` +
            `expires ${formatMs(r.expiresAtMs)}, last used ${formatMs(r.lastUsedAtMs)}, ${status}`,
        );
      }
      return lines.join('\n');
    }

    case 'revoked': {
      const r = outcome.row;
      const note = outcome.alreadyRevoked ? ' (was already revoked)' : '';
      return `Revoked MCP token ${tokenShortId(r.id)} (${r.name})${note}. It is invalid for the next request.`;
    }

    case 'not_found':
      return 'No MCP token found for that id.';
  }
}

/** First `SHORT_ID_LENGTH` characters of a token id, for compact display. */
export function tokenShortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/** Format an epoch-ms timestamp as ISO UTC, or `never` when null. */
function formatMs(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toISOString();
}
