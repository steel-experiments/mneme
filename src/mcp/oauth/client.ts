// ABOUTME: Recognizes the one OAuth client an operator configures for the MCP endpoint.
// ABOUTME: Matches client ids and validates redirect URIs by exact string comparison.

/**
 * OAuth client identity (Section 32.5.2, amended).
 *
 * Mneme recognizes exactly one client: the id an operator sets in
 * `MCP_OAUTH_CLIENT_ID` and pastes into the connector dialog. There is no
 * registration endpoint and no client table, so this module is the whole of
 * "which clients exist" — a comparison against configuration.
 *
 * That is a deliberate trade. Dynamic Client Registration would let any caller
 * create a client, choosing the name and redirect URI that a consent screen then
 * shows a human; it is deprecated in the current MCP authorization draft for
 * related reasons. One configured id cannot be created by a stranger, cannot grow
 * without bound, and cannot put attacker-chosen text in front of the person
 * approving the request.
 *
 * The client id is an identifier, not a credential. It travels in redirect URLs
 * and appears in logs, and possessing it grants nothing: authorization still
 * requires a platform sign-in and admin status. An unguessable value is
 * nonetheless preferred, because a stranger who finds the endpoint then cannot
 * even begin a flow.
 */

/**
 * Where the hosted Claude surfaces — web, Desktop, mobile — return after a user
 * approves. Anthropic publishes this single callback for all of them, so an iOS
 * connector and a browser connector share one registered redirect.
 *
 * Claude Code is deliberately absent. It is a native client that binds an
 * ephemeral loopback port, which would require matching redirect URIs with the
 * port ignored (RFC 8252 Section 7.3) — a looser rule that lets any local process
 * receive an authorization code. Claude Code can present an admin-issued bearer
 * token instead, so Mneme does not take on that rule.
 */
export const CLAUDE_HOSTED_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

/** The configured client: one id and the redirect URIs it may return to. */
export interface OAuthClientConfig {
  clientId: string;
  /** Exact redirect URIs, already validated at configuration load. */
  redirectUris: readonly string[];
}

/** What a client presented at the authorization endpoint. */
export interface PresentedClient {
  clientId: string | undefined;
  redirectUri: string | undefined;
}

/**
 * Outcome of recognizing a client. The error codes are the OAuth 2.1 values for
 * the authorization endpoint. Both failures are terminal and **must not** be
 * reported by redirecting: a request whose client or redirect is unrecognized has
 * no trustworthy place to send the user, so the error is shown directly instead
 * (OAuth 2.1 Section 4.1.2.1).
 */
export type ClientValidation =
  | { ok: true; redirectUri: string }
  | { ok: false; error: 'invalid_client' | 'invalid_request'; detail: string };

/**
 * Recognize the client behind an authorization request.
 *
 * The redirect URI is compared by **exact string match** against the configured
 * list — no prefix match, no host-only match, no normalization of case, port,
 * trailing slash, or percent-encoding. OAuth 2.1 requires exact comparison
 * because every looser rule has been used to steal authorization codes: a prefix
 * match falls to an appended path, a host match falls to an open redirect on the
 * same host.
 *
 * The client id is compared by exact string match too. It is not a secret, so no
 * constant-time comparison is warranted; a mismatch reveals only that the
 * presented id is not the configured one, which the subsequent error says anyway.
 */
export function validateClient(
  config: OAuthClientConfig,
  presented: PresentedClient,
): ClientValidation {
  if (typeof presented.clientId !== 'string' || presented.clientId.length === 0) {
    return { ok: false, error: 'invalid_request', detail: 'client_id is required' };
  }
  if (presented.clientId !== config.clientId) {
    return { ok: false, error: 'invalid_client', detail: 'unknown client_id' };
  }
  if (typeof presented.redirectUri !== 'string' || presented.redirectUri.length === 0) {
    return { ok: false, error: 'invalid_request', detail: 'redirect_uri is required' };
  }
  if (!config.redirectUris.includes(presented.redirectUri)) {
    return { ok: false, error: 'invalid_request', detail: 'redirect_uri is not registered' };
  }
  return { ok: true, redirectUri: presented.redirectUri };
}

/** Why a configured redirect URI was rejected at load. */
export type RedirectUriProblem =
  | 'not_absolute'
  | 'insecure_scheme'
  | 'has_fragment'
  | 'has_credentials';

/**
 * Check that a redirect URI is fit to be registered, so a typo fails at boot
 * rather than mid-authorization. An authorization code is delivered to this URI,
 * so it must be absolute and confidential in transit: `https`, or `http` only on
 * a loopback host, where the traffic never leaves the machine (RFC 8252
 * Section 8.3). A fragment is not permitted on a registered redirect (RFC 6749
 * Section 3.1.2), and embedded credentials would be carried into a redirect
 * Mneme emits.
 */
export function checkRedirectUri(value: string): RedirectUriProblem | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not_absolute';
  }
  if (url.hash !== '') return 'has_fragment';
  if (url.username !== '' || url.password !== '') return 'has_credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null;
  return 'insecure_scheme';
}

/** Hosts whose traffic never leaves the machine, per RFC 8252 Section 7.3. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === 'localhost';
}
