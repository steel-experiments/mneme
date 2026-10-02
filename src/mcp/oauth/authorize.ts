// ABOUTME: The MCP authorization endpoint — validates a request before the person goes to the identity provider.
// ABOUTME: Decides purely; the caller performs the redirect and the database write.

import { MCP_OAUTH_SCOPE } from './metadata.js';
import { validateClient, type OAuthClientConfig } from './client.js';

/**
 * The authorization endpoint (Section 32.5.2, amended; OAuth 2.1 Section 4.1.1).
 *
 * A client sends a person here to be identified. Mneme does not ask for a
 * password — it has none to check — and instead hands the person to the active
 * chat platform, which already knows who they are. The platform is the
 * identity provider; Mneme is the authorization server that
 * decides, after the provider answers, whether that identity may read the
 * memory store.
 *
 * The module is deliberately a decision function rather than a request handler.
 * Where an error goes is the security-critical part of this endpoint, and a pure
 * function makes every branch of that decision directly testable.
 *
 * **Where errors go.** OAuth 2.1 Section 4.1.2.1 splits error reporting in two,
 * and the split is not cosmetic:
 *
 * - If `client_id` or `redirect_uri` is unrecognized, the error is shown to the
 *   person and **never redirected**. A request whose redirect is untrusted has no
 *   safe place to send anything; redirecting would turn this endpoint into an
 *   open redirector that launders attacker URLs through Mneme's domain.
 * - Once the redirect is known to be registered, every other failure travels back
 *   to it as an `error` parameter, because the waiting client needs to hear about
 *   it and the destination is now trusted.
 */

/** The query parameters of an authorization request, as strings or absent. */
export interface AuthorizationRequest {
  responseType: string | undefined;
  clientId: string | undefined;
  redirectUri: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
  scope: string | undefined;
  state: string | undefined;
  resource: string | undefined;
}

/** What the endpoint needs to know about itself. */
export interface AuthorizationContext {
  client: OAuthClientConfig;
  /** Canonical MCP endpoint URL; the only audience a token may be issued for. */
  resource: string;
  /** Mneme's public origin. */
  publicBaseUrl: string;
}

/** Everything needed to start a sign-in, once the request is known good. */
export interface AcceptedAuthorization {
  kind: 'accepted';
  redirectUri: string;
  clientState: string | null;
  codeChallenge: string;
  resource: string;
  scope: string;
}

/**
 * A failure the client must hear about, delivered to its registered redirect.
 * `error` is an OAuth 2.1 code; `description` is safe to show a person and names
 * no internal detail.
 */
export interface RedirectableError {
  kind: 'redirect_error';
  redirectUri: string;
  error: string;
  description: string;
  clientState: string | null;
}

/** A failure with nowhere trustworthy to send it; shown to the person instead. */
export interface TerminalError {
  kind: 'terminal_error';
  status: 400;
  error: string;
  description: string;
}

export type AuthorizationPlan = AcceptedAuthorization | RedirectableError | TerminalError;

/**
 * Validate an authorization request and decide what happens next.
 *
 * The client and redirect are checked first and separately, because until they
 * are known good there is no address any other error may be sent to.
 */
export function planAuthorization(
  ctx: AuthorizationContext,
  request: AuthorizationRequest,
): AuthorizationPlan {
  const client = validateClient(ctx.client, {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
  });
  if (!client.ok) {
    return {
      kind: 'terminal_error',
      status: 400,
      error: client.error,
      description: client.detail,
    };
  }

  const redirectUri = client.redirectUri;
  const clientState = typeof request.state === 'string' && request.state.length > 0 ? request.state : null;
  const fail = (error: string, description: string): RedirectableError => ({
    kind: 'redirect_error',
    redirectUri,
    error,
    description,
    clientState,
  });

  if (request.responseType !== 'code') {
    // OAuth 2.1 removes the implicit grant; `code` is the only response type.
    return fail('unsupported_response_type', 'response_type must be "code"');
  }

  // PKCE is mandatory. OAuth 2.1 requires it for public clients, and Mneme
  // issues to nothing else — there is no client secret to fall back on, so a
  // request without a challenge has no protection against code interception.
  if (typeof request.codeChallenge !== 'string' || request.codeChallenge.length === 0) {
    return fail('invalid_request', 'code_challenge is required');
  }
  if (request.codeChallengeMethod !== 'S256') {
    // `plain` is removed by OAuth 2.1 and offers no protection; an absent method
    // defaults to `plain` under RFC 7636, so silence is rejected too.
    return fail('invalid_request', 'code_challenge_method must be "S256"');
  }

  // RFC 8707: the client names the resource the token is for. Mneme issues
  // for itself and nothing else, so a request naming another audience is refused
  // rather than quietly re-pointed at this server.
  if (typeof request.resource === 'string' && request.resource.length > 0) {
    if (request.resource !== ctx.resource) {
      return fail('invalid_target', 'resource does not name this MCP server');
    }
  }

  // A client may ask for less than everything, but not for more.
  const requested = parseScope(request.scope);
  if (requested.some((s) => s !== MCP_OAUTH_SCOPE)) {
    return fail('invalid_scope', `the only supported scope is ${MCP_OAUTH_SCOPE}`);
  }

  return {
    kind: 'accepted',
    redirectUri,
    clientState,
    codeChallenge: request.codeChallenge,
    resource: ctx.resource,
    scope: MCP_OAUTH_SCOPE,
  };
}

/** Build the redirect that carries a failure back to the waiting client. */
export function errorRedirectUrl(failure: RedirectableError, issuer: string): string {
  const url = new URL(failure.redirectUri);
  url.searchParams.set('error', failure.error);
  url.searchParams.set('error_description', failure.description);
  if (failure.clientState !== null) url.searchParams.set('state', failure.clientState);
  // RFC 9207: naming the issuer on every response, errors included, lets a client
  // detect a response mixed in from a different authorization server.
  url.searchParams.set('iss', issuer);
  return url.toString();
}

/** Split a space-delimited scope parameter; absent or blank yields no entries. */
function parseScope(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(/\s+/).filter((s) => s.length > 0);
}
