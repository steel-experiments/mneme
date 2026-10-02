// ABOUTME: The MCP token endpoint — trades an authorization code or refresh token for access.
// ABOUTME: Verifies PKCE, mints an mcp_tokens row, and rotates refresh tokens.

import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { type DatabaseSync } from '../../db/database.js';
import {
  insertMcpToken,
  revokeMcpTokenFamily,
  type McpScopeType,
} from '../../db/repositories/mcp-tokens.js';
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  insertRefreshToken,
  revokeRefreshTokenFamily,
} from '../../db/repositories/oauth-flows.js';
import { generateMcpTokenValue, hashMcpTokenValue } from '../auth.js';
import { hashAuthorizationCode } from './callback.js';
import { MCP_OAUTH_SCOPE } from './metadata.js';

/**
 * The token endpoint (Section 32.5.2, amended; OAuth 2.1 Section 4.1.3).
 *
 * Two grants. `authorization_code` turns the single-use code from a completed
 * platform sign-in into an access token; `refresh_token` renews one without
 * troubling the person again.
 *
 * **The access token is an `mcp_tokens` row.** Not a JWT, not a parallel store —
 * the same table, hashing, expiry, and revocation the admin-issued tokens use, so
 * `resolveMcpToken` authenticates both without knowing the difference and there
 * is only ever one grant model to audit (Section 32.5.3: "no second query path").
 *
 * **Audience is structural rather than checked.** The MCP specification requires
 * a server to confirm a token was issued for it. An opaque value that exists only
 * as a row in this database cannot have been minted by anyone else, and
 * `/authorize` already refused any request naming a different `resource`, so
 * there is no cross-service confusion for an audience claim to prevent here. A
 * federated deployment would need one; this one would only be checking its own
 * arithmetic.
 *
 * **PKCE is the client authentication.** Claude is a public client with no
 * secret, so the proof that the party redeeming a code is the party that
 * requested it is the verifier matching the challenge — nothing else.
 */

/** How long an access token lives. Short, because a refresh token renews it. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;

/** The response body of a successful exchange (RFC 6749 Section 5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * An OAuth error response (RFC 6749 Section 5.2). `invalid_grant` covers every
 * way a code or refresh token can fail; Claude specifically relies on that code
 * to decide a stored credential is dead and a fresh sign-in is needed, so no
 * other code may be substituted for it.
 */
export interface TokenError {
  status: 400 | 401;
  body: { error: string; error_description: string };
}

export type TokenOutcome =
  | { ok: true; response: TokenResponse }
  | { ok: false; error: TokenError };

export interface TokenEndpointDeps {
  db: DatabaseSync;
  clientId: string;
  nowMs: number;
  /** Overridable for tests; production uses the real generator. */
  generateToken?: () => string;
}

/** The form fields a token request may carry. */
export interface TokenRequest {
  grantType: string | undefined;
  code: string | undefined;
  redirectUri: string | undefined;
  codeVerifier: string | undefined;
  refreshToken: string | undefined;
  clientId: string | undefined;
}

/** Dispatch on the grant type. An unknown grant is not a hint about anything. */
export function exchangeToken(deps: TokenEndpointDeps, request: TokenRequest): TokenOutcome {
  // The client id is not a credential, so this is an identity check rather than
  // authentication; PKCE and the refresh chain carry the actual proof.
  if (request.clientId !== deps.clientId) {
    return fail(401, 'invalid_client', 'unknown client_id');
  }
  if (request.grantType === 'authorization_code') return exchangeCode(deps, request);
  if (request.grantType === 'refresh_token') return exchangeRefresh(deps, request);
  return fail(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

/** Redeem an authorization code from a completed sign-in. */
function exchangeCode(deps: TokenEndpointDeps, request: TokenRequest): TokenOutcome {
  if (typeof request.code !== 'string' || request.code.length === 0) {
    return fail(400, 'invalid_request', 'code is required');
  }
  if (typeof request.codeVerifier !== 'string' || request.codeVerifier.length === 0) {
    return fail(400, 'invalid_request', 'code_verifier is required');
  }
  if (typeof request.redirectUri !== 'string' || request.redirectUri.length === 0) {
    return fail(400, 'invalid_request', 'redirect_uri is required');
  }

  const outcome = consumeAuthorizationCode(deps.db, hashAuthorizationCode(request.code), deps.nowMs);
  if (outcome.kind === 'reused') {
    // The code reached someone twice. Whatever was issued the first time is
    // suspect, so the whole chain ends (OAuth 2.1 Section 4.1.3).
    endFamilyIfAny(deps, outcome.record.subjectUserId);
    return invalidGrant();
  }
  if (outcome.kind !== 'valid') return invalidGrant();
  const record = outcome.record;

  // The redirect is bound at issue, so a code cannot be redeemed against a
  // different one than the person was sent to.
  if (request.redirectUri !== record.redirectUri) {
    return invalidGrant();
  }
  if (!verifyPkce(request.codeVerifier, record.codeChallenge)) return invalidGrant();

  return issue(deps, {
    familyId: randomUUID(),
    subjectUserId: record.subjectUserId,
    scope: record.scope,
    scopeType: record.scopeType,
    channelIds: record.channelIds,
  });
}

/** Renew an access token, rotating the refresh token in the process. */
function exchangeRefresh(deps: TokenEndpointDeps, request: TokenRequest): TokenOutcome {
  if (typeof request.refreshToken !== 'string' || request.refreshToken.length === 0) {
    return fail(400, 'invalid_request', 'refresh_token is required');
  }
  const outcome = consumeRefreshToken(deps.db, hashMcpTokenValue(request.refreshToken), deps.nowMs);
  if (outcome.kind === 'reused') {
    // A rotated token came back. Either the client replayed it or a thief has a
    // copy, and the two are indistinguishable, so the family ends.
    revokeRefreshTokenFamily(deps.db, outcome.familyId, deps.nowMs);
    revokeMcpTokenFamily(deps.db, outcome.familyId, deps.nowMs);
    return invalidGrant();
  }
  if (outcome.kind !== 'valid') return invalidGrant();
  const record = outcome.record;
  if (record.clientId !== deps.clientId) return invalidGrant();

  return issue(deps, {
    // The renewed token stays in the same family, so a later replay of any
    // ancestor still ends everything descended from that one sign-in.
    familyId: record.familyId,
    subjectUserId: record.subjectUserId,
    scope: record.scope,
    scopeType: record.scopeType,
    channelIds: record.channelIds,
  });
}

interface IssueInput {
  familyId: string;
  subjectUserId: string;
  scope: string;
  scopeType: McpScopeType;
  channelIds: readonly string[];
}

/**
 * Mint an access token and its successor refresh token. Both plaintexts exist
 * only in the returned response; the database receives their hashes.
 */
function issue(deps: TokenEndpointDeps, input: IssueInput): TokenOutcome {
  const generate = deps.generateToken ?? generateMcpTokenValue;
  const accessToken = generate();
  const refreshToken = generate();

  insertMcpToken(deps.db, {
    tokenHash: hashMcpTokenValue(accessToken),
    // Names the person, not a purpose, so `/mneme mcp-token list` reads
    // sensibly beside admin-issued tokens.
    name: `oauth:${input.subjectUserId}`,
    scopeType: input.scopeType,
    channelIds: input.channelIds,
    createdByUserId: input.subjectUserId,
    createdAtMs: deps.nowMs,
    expiresAtMs: deps.nowMs + ACCESS_TOKEN_TTL_MS,
    subjectUserId: input.subjectUserId,
    oauthFamilyId: input.familyId,
  });
  insertRefreshToken(deps.db, {
    tokenHash: hashMcpTokenValue(refreshToken),
    familyId: input.familyId,
    clientId: deps.clientId,
    subjectUserId: input.subjectUserId,
    scope: input.scope,
    scopeType: input.scopeType,
    channelIds: input.channelIds,
    createdAtMs: deps.nowMs,
  });

  return {
    ok: true,
    response: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: input.scope || MCP_OAUTH_SCOPE,
    },
  };
}

/**
 * Verify a PKCE verifier against the stored challenge (RFC 7636 Section 4.6):
 * the challenge is the base64url-encoded SHA-256 of the verifier. Compared in
 * constant time — the challenge is not secret, but the comparison sits on the
 * path that decides whether a code becomes a token, and a timing-independent
 * check costs nothing.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * End every token descended from a compromised authorization code. The code row
 * does not carry its family — the family is created when the code is redeemed —
 * so this revokes by subject, which is the widest safe interpretation: a replayed
 * code means that person's sign-in leaked.
 */
function endFamilyIfAny(deps: TokenEndpointDeps, subjectUserId: string): void {
  const rows = deps.db
    .prepare('SELECT DISTINCT oauth_family_id AS familyId FROM mcp_tokens WHERE subject_user_id = ?')
    .all(subjectUserId) as Array<{ familyId: string | null }>;
  for (const row of rows) {
    if (row.familyId === null) continue;
    revokeRefreshTokenFamily(deps.db, row.familyId, deps.nowMs);
    revokeMcpTokenFamily(deps.db, row.familyId, deps.nowMs);
  }
}

/**
 * The single failure a client sees for any bad code or refresh token. The kinds
 * are separated internally for the operator's log, but reporting them apart here
 * would tell a caller whether a value was ever valid.
 */
function invalidGrant(): TokenOutcome {
  return fail(400, 'invalid_grant', 'the grant is invalid, expired, or already used');
}

function fail(status: 400 | 401, error: string, description: string): TokenOutcome {
  return { ok: false, error: { status, body: { error, error_description: description } } };
}
