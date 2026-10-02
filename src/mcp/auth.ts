import { randomBytes, createHash } from 'node:crypto';
import { type DatabaseSync } from '../db/database.js';
import { getChannel, resolveRetrievableChannelScope } from '../db/repositories/channels.js';
import {
  insertMcpToken,
  getMcpToken,
  getMcpTokenByHash,
  touchMcpTokenLastUsed,
  type McpScopeType,
  type SafeMcpTokenRow,
} from '../db/repositories/mcp-tokens.js';
import type { RateLimiter } from './rate-limit.js';

/**
 * MCP bearer-token issuance, hashing, and resolution (Sections 27, 32.5.2, 44).
 *
 * v1 uses admin-issued bearer tokens rather than a full OAuth server. A token is
 * a random 256-bit value, shown exactly once, and stored only as a SHA-256 hash
 * (Section 32.5.2). Each token carries a visibility grant: `org` scope by
 * default, or `org_plus_channels` with an explicit list of **restricted**
 * channels granted at creation — never `review_only` and never `excluded` content
 * (Section 44: "Never grant `review_only` visibility to an MCP token").
 *
 * This module is the single place that holds the plaintext token value, and only
 * for the duration of {@link createMcpToken}: the value is generated, hashed, the
 * hash is persisted via the repository, and the plaintext is returned to the
 * caller exactly once. It is never written to SQLite, never placed in a log
 * field, and never held on a row object — the returned {@link SafeMcpTokenRow}
 * exposes neither the plaintext nor the hash. {@link resolveMcpToken} is the
 * counterpart: it hashes a presented value and looks the token up by its hash,
 * which is the only way to validate a credential whose plaintext was never kept.
 *
 * The scope grant reuses the channel-visibility rules: an explicit channel grant
 * must name an existing, non-deleted `restricted` channel, validated here against
 * the `channels` table so the rejection happens before any row is written.
 */

export type { McpScopeType, SafeMcpTokenRow } from '../db/repositories/mcp-tokens.js';

/** A token is 256 bits of randomness (Section 32.5.2). */
export const MCP_TOKEN_BYTES = 32;

/** Default token lifetime when no expiry is requested (Section 32.5.2: 90 days). */
export const DEFAULT_MCP_TOKEN_TTL_DAYS = 90;
/** {@link DEFAULT_MCP_TOKEN_TTL_DAYS} in milliseconds. */
export const DEFAULT_MCP_TOKEN_TTL_MS = DEFAULT_MCP_TOKEN_TTL_DAYS * 86_400_000;

/** The visibility grant a token carries, used to scope MCP tool results. */
export interface McpTokenGrant {
  scopeType: McpScopeType;
  /** Restricted channel ids the token may read (empty for `org` scope). */
  channelIds: readonly string[];
}

/**
 * Why a requested grant was rejected at creation. `invalid_expiry_days` is
 * reported by the Discord command layer, which validates its `expires-days`
 * option before calling {@link createMcpToken}.
 */
export type InvalidScopeReason =
  | 'empty_name'
  | 'past_expiry'
  | 'invalid_expiry_days'
  | 'ambiguous_channel'
  | 'org_scope_with_channels'
  | 'org_plus_channels_requires_channels'
  | 'unknown_channel'
  | 'deleted_channel'
  | 'excluded_channel'
  | 'review_only_channel'
  | 'non_restricted_channel';

/** A request to issue a token. The plaintext is generated, not supplied. */
export interface McpTokenRequest {
  name: string;
  /** Scope; defaults to `org` when no channels are requested. */
  scopeType?: McpScopeType;
  /** Restricted channel ids to grant; default none. */
  channelIds?: readonly string[];
  createdByUserId: string;
  /**
   * Absolute expiry (epoch ms). Must be in the future. When the field is absent
   * the token expires {@link DEFAULT_MCP_TOKEN_TTL_DAYS} days after creation; an
   * explicit `null` issues a non-expiring token (a deliberate programmatic
   * choice — the Discord command never sends `null`).
   */
  expiresAtMs?: number | null;
}

export interface CreateMcpTokenDeps {
  db: DatabaseSync;
  nowMs: number;
}

export interface ResolveMcpTokenDeps {
  db: DatabaseSync;
  nowMs: number;
}

/** Result of validating a requested grant before any token is generated. */
export type ValidateGrantOutcome =
  | { ok: true; grant: McpTokenGrant }
  | { ok: false; reason: InvalidScopeReason; detail: string };

/** Result of {@link createMcpToken}. The plaintext appears only on success. */
export type CreateMcpTokenOutcome =
  | { kind: 'invalid'; reason: InvalidScopeReason; detail: string }
  | { kind: 'created'; tokenId: string; token: string; row: SafeMcpTokenRow };

/**
 * Result of authenticating a presented bearer value. `expired`, `revoked`, and
 * `invalid` all map to `401` at the HTTP layer (Section 32.5.2); the kinds exist
 * for server-side logging and carry no plaintext.
 */
export type ResolveMcpTokenOutcome =
  | { kind: 'invalid' }
  | { kind: 'expired'; row: SafeMcpTokenRow }
  | { kind: 'revoked'; row: SafeMcpTokenRow }
  | { kind: 'valid'; row: SafeMcpTokenRow; grant: McpTokenGrant };

/**
 * Generate a fresh 256-bit token value, base64url-encoded (43 chars, URL-safe for
 * an `Authorization: Bearer` header). The value is shown exactly once; nothing
 * here is persisted.
 */
export function generateMcpTokenValue(bytes: number = MCP_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 hex digest of the exact token string the client will send. This hash —
 * never the plaintext — is what `mcp_tokens.token_hash` stores, so a stored row
 * cannot be reversed into a usable credential.
 */
export function hashMcpTokenValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Validate a requested visibility grant against the `channels` table. A channel
 * grant may name only existing, non-deleted `restricted` channels; `excluded`
 * and `review_only` channels are rejected outright, and an explicit grant of an
 * `org` channel is rejected as redundant (org content is already in scope).
 * Duplicate ids are deduped silently — the grant is a set.
 */
export function validateMcpTokenGrant(
  db: DatabaseSync,
  request: McpTokenRequest,
  nowMs: number,
): ValidateGrantOutcome {
  const name = (request.name ?? '').trim();
  if (name.length === 0) return invalid('empty_name', 'a non-empty token name is required');

  if (request.expiresAtMs !== undefined && request.expiresAtMs !== null && request.expiresAtMs <= nowMs) {
    return invalid('past_expiry', 'expires_at_ms must be in the future');
  }

  const channelIds = dedupe(request.channelIds ?? []);
  const scopeType: McpScopeType = request.scopeType ?? (channelIds.length > 0 ? 'org_plus_channels' : 'org');

  if (channelIds.length === 0) {
    if (scopeType !== 'org') {
      return invalid(
        'org_plus_channels_requires_channels',
        'org_plus_channels scope requires at least one restricted channel',
      );
    }
    return { ok: true, grant: { scopeType: 'org', channelIds: [] } };
  }

  if (scopeType === 'org') {
    return invalid(
      'org_scope_with_channels',
      'org scope cannot carry explicit channels; use org_plus_channels',
    );
  }

  const scopeAnchors: string[] = [];
  for (const id of channelIds) {
    const ch = getChannel(db, id);
    if (!ch) return invalid('unknown_channel', `channel ${id} does not exist`);
    if (ch.deleted_at_ms !== null) return invalid('deleted_channel', `channel ${id} is deleted`);
    const current = resolveRetrievableChannelScope(db, id);
    if (!current) {
      return invalid('excluded_channel', `channel ${id} is unavailable for retrieval`);
    }
    const vc = current.visibility;
    if (vc === 'excluded') return invalid('excluded_channel', `channel ${id} is excluded`);
    if (vc === 'review_only') {
      return invalid(
        'review_only_channel',
        `channel ${id} is review_only; review-only content is never grantable to an MCP token`,
      );
    }
    if (vc !== 'restricted') {
      return invalid('non_restricted_channel', `channel ${id} is not restricted (${vc})`);
    }
    // Persist the canonical restricted-scope anchor (Section 7.2): the parent
    // for a thread below a restricted parent, otherwise the channel itself. A
    // restricted thread below an org parent therefore grants only that thread,
    // never its sibling threads.
    scopeAnchors.push(current.scopeChannelId);
  }

  return {
    ok: true,
    grant: { scopeType: 'org_plus_channels', channelIds: dedupe(scopeAnchors) },
  };
}

/**
 * Issue a scoped MCP bearer token. Validates the grant (rejecting unknown,
 * excluded, review-only, or otherwise non-restricted channels before any write),
 * then generates a 256-bit value, persists only its SHA-256 hash, and returns the
 * plaintext exactly once alongside the safe row. The plaintext is the caller's
 * sole copy; it must be displayed ephemerally and never logged. A request that
 * omits `expiresAtMs` gets the {@link DEFAULT_MCP_TOKEN_TTL_DAYS}-day default so
 * no issuance path can mint an eternal token by accident.
 */
export function createMcpToken(deps: CreateMcpTokenDeps, request: McpTokenRequest): CreateMcpTokenOutcome {
  const validation = validateMcpTokenGrant(deps.db, request, deps.nowMs);
  if (!validation.ok) {
    return { kind: 'invalid', reason: validation.reason, detail: validation.detail };
  }
  const grant = validation.grant;
  const token = generateMcpTokenValue();
  const tokenHash = hashMcpTokenValue(token);
  const tokenId = insertMcpToken(deps.db, {
    tokenHash,
    name: request.name.trim(),
    scopeType: grant.scopeType,
    channelIds: grant.channelIds,
    createdByUserId: request.createdByUserId,
    createdAtMs: deps.nowMs,
    expiresAtMs:
      request.expiresAtMs === undefined ? deps.nowMs + DEFAULT_MCP_TOKEN_TTL_MS : request.expiresAtMs,
  });
  const row = getMcpToken(deps.db, tokenId);
  if (!row) {
    // Unreachable: the row was just inserted. Fail loudly without surfacing the
    // plaintext — the message carries no token-derived material.
    throw new Error('mcp token was not readable immediately after insert');
  }
  return { kind: 'created', tokenId, token, row };
}

/**
 * Authenticate a presented bearer value and resolve its grant (Section 32.5.2).
 * The value is hashed and looked up by `token_hash`; because the plaintext is
 * never stored, this hash-and-lookup is the only validation path. On success the
 * grant is returned and `last_used_at_ms` is touched. Mismatched, expired, and
 * revoked tokens yield their respective kinds; all three are `401` to the client.
 */
export function resolveMcpToken(deps: ResolveMcpTokenDeps, presentedValue: string): ResolveMcpTokenOutcome {
  if (typeof presentedValue !== 'string' || presentedValue.length === 0) return { kind: 'invalid' };
  const row = getMcpTokenByHash(deps.db, hashMcpTokenValue(presentedValue));
  if (!row) return { kind: 'invalid' };
  if (row.revokedAtMs !== null) return { kind: 'revoked', row };
  if (row.expiresAtMs !== null && row.expiresAtMs <= deps.nowMs) return { kind: 'expired', row };
  touchMcpTokenLastUsed(deps.db, row.id, deps.nowMs);
  return { kind: 'valid', row, grant: { scopeType: row.scopeType, channelIds: row.channelIds } };
}

/**
 * Extract a bearer token from an `Authorization` header (RFC 6750: the literal
 * scheme `Bearer`, case-insensitive, followed by the token). The presented value
 * is returned only to be hashed immediately by {@link resolveMcpRequestAuth}; it
 * is never logged here. A missing, empty, or non-Bearer header yields `null`,
 * which the caller treats as `401`.
 */
export function extractBearerToken(authorizationHeader: string | null | undefined): string | null {
  if (typeof authorizationHeader !== 'string') return null;
  const trimmed = authorizationHeader.trim();
  if (trimmed.length === 0) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  return match ? (match[1] ?? null) : null;
}

/**
 * The single key under which all unauthenticated failures are counted. The budget
 * is deliberately global rather than per-IP: behind the (at most one) reverse
 * proxy every client shares one socket address, and trusting `X-Forwarded-For`
 * would let a direct caller spoof unlimited fresh buckets. One shared window
 * cannot be gamed and holds no per-client state.
 */
export const MCP_UNAUTH_RATE_LIMIT_KEY = 'unauthenticated';

/** Dependencies for {@link resolveMcpRequestAuth}: the database, clock, and limiters. */
export interface McpRequestAuthDeps {
  db: DatabaseSync;
  nowMs: number;
  /** Per-token rate limiter (Section 32.5.4); keyed on the authenticated token id. */
  rateLimiter: RateLimiter;
  /**
   * Global limiter for failed authentications (Section 32.5.4). Consumed only
   * when a request fails to authenticate, so valid-token clients are never
   * throttled by it; once exhausted, further failures return `429` instead of
   * `401`. Optional so callers without a budget keep the plain `401` behavior.
   */
  unauthRateLimiter?: RateLimiter;
}

/** Input to {@link resolveMcpRequestAuth}. */
export interface McpRequestAuthInput {
  /** The raw `Authorization` header value from the HTTP request. */
  authorizationHeader: string | null | undefined;
}

/**
 * The outcome of authenticating one stateless MCP request. `unauthenticated`
 * covers every credential failure (missing, malformed, unknown, expired,
 * revoked) and maps to HTTP `401`; the kinds are not distinguished to the client
 * so a probe cannot oracle token state. `rate_limited` maps to `429` — with the
 * authenticated token id when a valid token exceeded its per-token limit, or
 * with `tokenId: null` when the global unauthenticated-failure budget ran out.
 * Only `authenticated` carries the resolved grant, and it never carries the
 * plaintext.
 */
export type McpRequestAuthOutcome =
  | { kind: 'unauthenticated'; status: 401 }
  | { kind: 'rate_limited'; status: 429; retryAfterMs: number; tokenId: string | null }
  | { kind: 'authenticated'; tokenId: string; grant: McpTokenGrant; remaining: number };

/**
 * Authenticate one MCP request end to end (Section 32.5.2 / 32.5.4). Extract the
 * bearer value, resolve it to a grant via {@link resolveMcpToken} (which hashes
 * the value, checks expiry and revocation, and updates `last_used_at_ms`), then
 * consume one unit of the per-token rate limit. Invalid, expired, and revoked
 * credentials yield `401` and consume one unit of the shared unauthenticated
 * budget; once that budget is exhausted, further failures yield `429` until the
 * window resets. Excess valid requests yield `429`. The presented value and any
 * message content are never logged by this path — only the eventual server log
 * carries the token id, tool name, result count, and duration.
 */
export function resolveMcpRequestAuth(deps: McpRequestAuthDeps, input: McpRequestAuthInput): McpRequestAuthOutcome {
  const presented = extractBearerToken(input.authorizationHeader);
  if (presented === null) return unauthenticated(deps);
  const resolved = resolveMcpToken({ db: deps.db, nowMs: deps.nowMs }, presented);
  if (resolved.kind !== 'valid') return unauthenticated(deps);
  const decision = deps.rateLimiter.check(resolved.row.id, deps.nowMs);
  if (!decision.allowed) {
    return {
      kind: 'rate_limited',
      status: 429,
      retryAfterMs: decision.retryAfterMs,
      tokenId: resolved.row.id,
    };
  }
  return {
    kind: 'authenticated',
    tokenId: resolved.row.id,
    grant: resolved.grant,
    remaining: decision.remaining,
  };
}

/**
 * Resolve a failed authentication: consume one unit of the shared
 * unauthenticated-failure budget (when one is configured) and report `401`,
 * or `429` once the budget is exhausted. The `429` carries no token id — no
 * token was resolved — and its `Retry-After` reveals only the window length.
 */
function unauthenticated(deps: McpRequestAuthDeps): McpRequestAuthOutcome {
  if (deps.unauthRateLimiter) {
    const decision = deps.unauthRateLimiter.check(MCP_UNAUTH_RATE_LIMIT_KEY, deps.nowMs);
    if (!decision.allowed) {
      return { kind: 'rate_limited', status: 429, retryAfterMs: decision.retryAfterMs, tokenId: null };
    }
  }
  return { kind: 'unauthenticated', status: 401 };
}

/** Build a failed-validation outcome. */
function invalid(reason: InvalidScopeReason, detail: string): ValidateGrantOutcome {
  return { ok: false, reason, detail };
}

/** Drop empties and duplicates from a channel-id list, preserving first-seen order. */
function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
