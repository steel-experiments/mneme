// ABOUTME: Handles the identity provider's return leg and issues an MCP authorization code.
// ABOUTME: Reads the provider's admin decision, then hands a single-use code to the client.

import { randomBytes, createHash } from 'node:crypto';
import { type DatabaseSync } from '../../db/database.js';
import type { AuthorizationReason } from '../../policy/authorization.js';
import {
  consumeLoginSession,
  insertAuthorizationCode,
  type LoginSession,
} from '../../db/repositories/oauth-flows.js';
import type { McpScopeType } from '../../db/repositories/mcp-tokens.js';
import type { IdentityFailure, IdentityProvider } from './identity.js';

/**
 * The identity-provider return leg (Section 32.5.2, amended).
 *
 * The identity provider sends the person back here with its own authorization
 * code. The provider exchanges it, identifies the person, and makes the admin
 * decision. Only then does a code exist that a client can redeem — the
 * credential is minted from Mneme's judgment, never from the provider's token.
 *
 * **Who may sign in.** The same admins who may run `/mneme mcp-token create`
 * (Section 6.6). A person who could not mint a token through a command must not
 * be able to mint one through a browser instead; that would be a privilege
 * expansion wearing a different hat. Each provider fails closed: no admins
 * configured means nobody, and unresolved admin data means nobody.
 *
 * **What they get.** `org` scope: everything the organization can see, and no
 * restricted channel. Restricted grants are named explicitly by an admin at token
 * creation (Section 44) and are deliberately not inferrable from a role, so a
 * sign-in cannot widen its own visibility.
 */

/** Bytes of randomness in an authorization code. */
const CODE_BYTES = 32;

/** The visibility a successful sign-in receives. */
const SIGN_IN_SCOPE_TYPE: McpScopeType = 'org';

export interface CallbackDeps {
  db: DatabaseSync;
  identity: IdentityProvider;
  /** Mneme's public origin, used as the RFC 9207 issuer. */
  issuer: string;
  nowMs: number;
}

/** The query parameters the identity provider returns with. */
export interface CallbackRequest {
  /** The provider's authorization code; absent when the person declined. */
  code: string | undefined;
  /** The opaque handle for the pending request. */
  state: string | undefined;
  /** Set by the provider when the person declined or the request failed. */
  error: string | undefined;
}

/**
 * Why a sign-in was refused, for the server log. These never reach the person in
 * this detail: a client is told `access_denied` either way, so a stranger cannot
 * learn whether a given account exists in the workspace, belongs to another
 * workspace, or merely lacks admin status.
 */
export type SignInRefusal =
  | 'provider_declined'
  | AuthorizationReason
  | IdentityFailure;

/** Deliver an authorization code to the waiting client. */
export interface CallbackSuccess {
  kind: 'success';
  redirectUri: string;
  /** The plaintext code. Travels only in the redirect; never stored or logged. */
  code: string;
  clientState: string | null;
  subjectUserId: string;
}

/** Report a failure to the waiting client at its registered redirect. */
export interface CallbackRedirectError {
  kind: 'redirect_error';
  redirectUri: string;
  error: string;
  description: string;
  clientState: string | null;
  refusal: SignInRefusal;
}

/**
 * No pending request could be resolved, so there is no registered redirect and
 * nowhere trustworthy to send anything. Shown to the person instead.
 */
export interface CallbackTerminalError {
  kind: 'terminal_error';
  status: 400;
  description: string;
}

export type CallbackOutcome = CallbackSuccess | CallbackRedirectError | CallbackTerminalError;

/**
 * Complete a sign-in.
 *
 * The pending request is resolved first and consumed in the process, so a
 * replayed return leg finds nothing. Everything that decides where the code goes
 * — the redirect URI, the PKCE challenge, the audience — comes from that stored
 * row and never from this request's parameters.
 */
export async function completeSignIn(
  deps: CallbackDeps,
  request: CallbackRequest,
): Promise<CallbackOutcome> {
  const session = consumeLoginSession(deps.db, request.state ?? '', deps.nowMs);
  if (!session) {
    return {
      kind: 'terminal_error',
      status: 400,
      description: 'This sign-in link has expired or was already used. Start again from Claude.',
    };
  }

  // A provider reports a declined consent as an error parameter rather than a code.
  if (typeof request.error === 'string' && request.error.length > 0) {
    return refuse(session, 'provider_declined');
  }
  if (typeof request.code !== 'string' || request.code.length === 0) {
    return refuse(session, 'provider_declined');
  }

  const identified = await deps.identity.identify(request.code);
  if (!identified.ok) {
    return refuse(session, identified.reason);
  }

  const decision = identified.identity.authorization;
  if (!decision.authorized) {
    return refuse(session, decision.reason);
  }

  // The plaintext exists here and in the redirect below; only its hash is stored.
  const code = randomBytes(CODE_BYTES).toString('base64url');
  insertAuthorizationCode(deps.db, {
    codeHash: hashAuthorizationCode(code),
    clientId: session.clientId,
    redirectUri: session.redirectUri,
    codeChallenge: session.codeChallenge,
    resource: session.resource,
    scope: session.scope,
    subjectUserId: identified.identity.userId,
    scopeType: SIGN_IN_SCOPE_TYPE,
    channelIds: [],
    createdAtMs: deps.nowMs,
  });

  return {
    kind: 'success',
    redirectUri: session.redirectUri,
    code,
    clientState: session.clientState,
    subjectUserId: identified.identity.userId,
  };
}

/**
 * SHA-256 hex of an authorization code. As with bearer tokens, only the hash is
 * persisted, so a database copy cannot be redeemed.
 */
export function hashAuthorizationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Build the redirect that delivers a code to the waiting client. `iss` lets the
 * client confirm which authorization server answered (RFC 9207), which is what
 * detects a response mixed in from somewhere else.
 */
export function successRedirectUrl(outcome: CallbackSuccess, issuer: string): string {
  const url = new URL(outcome.redirectUri);
  url.searchParams.set('code', outcome.code);
  if (outcome.clientState !== null) url.searchParams.set('state', outcome.clientState);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

/**
 * Refuse a sign-in. Every refusal reports the same `access_denied` to the client:
 * distinguishing "not in the workspace", "another workspace", and "no admin
 * status" would let anyone with the connector URL probe the workspace.
 */
function refuse(session: LoginSession, refusal: SignInRefusal): CallbackRedirectError {
  return {
    kind: 'redirect_error',
    redirectUri: session.redirectUri,
    error: 'access_denied',
    description: 'This account is not permitted to use this connector.',
    clientState: session.clientState,
    refusal,
  };
}
