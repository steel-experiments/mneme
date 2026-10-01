// ABOUTME: OAuth discovery documents that tell an MCP client where to sign in.
// ABOUTME: Builds RFC 9728 protected-resource and RFC 8414 authorization-server metadata.

/**
 * MCP authorization discovery (Section 32.5.2, amended; spec Section 49 moves
 * "full MCP authorization" out of deferred work).
 *
 * A remote MCP client that receives `401` cannot ask a human for a credential:
 * the Claude connector dialog offers a URL and an OAuth client id, and nothing
 * else. The client instead follows a fixed discovery chain, and every step of it
 * is a document served from here:
 *
 *   1. `401` carries `WWW-Authenticate: Bearer … resource_metadata="<url>"`
 *      (RFC 9728 Section 5.1, required of MCP resource servers).
 *   2. The client fetches that URL — the protected resource metadata — and reads
 *      `authorization_servers` to learn which server issues tokens.
 *   3. The client fetches that server's metadata (RFC 8414) to learn the
 *      authorization and token endpoint URLs.
 *
 * Mneme is both roles at once: the resource server (`MCP_PATH`) and its own
 * authorization server, on one origin, in one process. So `authorization_servers`
 * names Mneme's own public origin and the two documents are consistent by
 * construction rather than by configuration.
 *
 * These documents are descriptive only — they hold no secret, and every value in
 * them is derived from `MCP_PUBLIC_URL`/`RAILWAY_PUBLIC_DOMAIN` and `MCP_PATH`.
 * They are served only when `MCP_OAUTH_ENABLED` is true, because a document that
 * advertises an authorization endpoint is a promise the endpoint answers.
 */

/**
 * The single scope Mneme issues. Retrieval breadth is decided by the signed-in
 * Discord identity — guild membership and the channel-visibility rules in
 * Section 7.3 — never by what a client asks for, so there is no second scope for a
 * client to request. Advertising per-visibility scopes would imply a client could
 * elect to read restricted channels, which it cannot.
 */
export const MCP_OAUTH_SCOPE = 'mneme:read';

/** Inputs for every document here: the public origin and the MCP request path. */
export interface OAuthMetadataConfig {
  /** Public origin without a trailing slash (`McpConfig.publicBaseUrl`). */
  publicBaseUrl: string;
  /** MCP request path beginning with `/` (`McpConfig.path`). */
  mcpPath: string;
}

/** RFC 9728 protected resource metadata. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: readonly string[];
  scopes_supported: readonly string[];
  bearer_methods_supported: readonly string[];
}

/** RFC 8414 authorization server metadata. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported: readonly string[];
  response_types_supported: readonly string[];
  grant_types_supported: readonly string[];
  token_endpoint_auth_methods_supported: readonly string[];
  code_challenge_methods_supported: readonly string[];
  authorization_response_iss_parameter_supported: boolean;
}

/** Path of the authorization endpoint, relative to the public origin. */
export const OAUTH_AUTHORIZE_PATH = '/authorize';
/** Path of the token endpoint, relative to the public origin. */
export const OAUTH_TOKEN_PATH = '/token';
/** Path of the protected resource metadata document, without a path suffix. */
export const OAUTH_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
/** Path of the authorization server metadata document. */
export const OAUTH_AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';

/**
 * The canonical resource identifier: the MCP endpoint URL exactly as an operator
 * types it into a client. RFC 8707 requires the client to send this value as the
 * `resource` parameter, and a client compares it against
 * {@link ProtectedResourceMetadata.resource} — so this must be the one string
 * both sides agree on, with no trailing slash and no query.
 */
export function mcpResourceIdentifier(config: OAuthMetadataConfig): string {
  return `${config.publicBaseUrl}${config.mcpPath}`;
}

/**
 * Location of the protected resource metadata for a resource whose identifier has
 * a path component. RFC 9728 Section 3.1 inserts the resource path *after* the
 * well-known segment, so `/mcp` is published at
 * `/.well-known/oauth-protected-resource/mcp` — not at the bare well-known path.
 * Clients try this form first, so it is the URL advertised in `WWW-Authenticate`.
 */
export function protectedResourceMetadataPath(mcpPath: string): string {
  return `${OAUTH_PROTECTED_RESOURCE_PATH}${mcpPath}`;
}

/** Absolute URL of the protected resource metadata document. */
export function protectedResourceMetadataUrl(config: OAuthMetadataConfig): string {
  return `${config.publicBaseUrl}${protectedResourceMetadataPath(config.mcpPath)}`;
}

/**
 * Build the protected resource metadata. `authorization_servers` holds exactly one
 * entry: a client uses the first entry and does not fall back to later ones, so a
 * list longer than one would make the extras dead weight that only invites drift.
 */
export function protectedResourceMetadata(config: OAuthMetadataConfig): ProtectedResourceMetadata {
  return {
    resource: mcpResourceIdentifier(config),
    authorization_servers: [config.publicBaseUrl],
    scopes_supported: [MCP_OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
  };
}

/**
 * Build the authorization server metadata.
 *
 * `token_endpoint_auth_methods_supported: ["none"]` states that Mneme issues
 * to **public** clients: a connector on a phone cannot keep a client secret, so
 * the flow is protected by PKCE rather than by a secret. `S256` is the only code
 * challenge method — OAuth 2.1 removes `plain`, and MCP clients send `S256`
 * unconditionally.
 *
 * There is deliberately no `registration_endpoint`. Dynamic Client Registration is
 * deprecated in the current MCP authorization draft, and an open registration
 * endpoint is an unauthenticated write path that grows rows and lets a caller
 * choose the name and redirect a consent screen would display. Mneme instead
 * recognizes a client id an operator configures once (`MCP_OAUTH_CLIENT_ID`) and
 * pastes into the connector dialog.
 */
export function authorizationServerMetadata(
  config: OAuthMetadataConfig,
): AuthorizationServerMetadata {
  return {
    issuer: config.publicBaseUrl,
    authorization_endpoint: `${config.publicBaseUrl}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${config.publicBaseUrl}${OAUTH_TOKEN_PATH}`,
    scopes_supported: [MCP_OAUTH_SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    // Every authorization response carries `iss`, so a client can tell which
    // server answered (RFC 9207). Advertising it obliges us to always send it —
    // both the success redirect and the error redirect do.
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * The `WWW-Authenticate` value for a `401` from the MCP endpoint. The
 * `resource_metadata` parameter is what starts the discovery chain; without it a
 * client has to guess the document's location by probing the origin, which costs
 * round trips and fails outright on hosts that cannot serve `/.well-known/*`.
 *
 * `error="invalid_token"` is emitted for every credential failure, including a
 * request that carried no credential at all. RFC 6750 Section 3 would omit the
 * error code in that one case, but Mneme deliberately does not distinguish
 * missing from invalid from expired (Section 32.5.2) — a varying challenge would
 * let a prober oracle token state. A constant challenge reveals nothing, and the
 * fixed string is what MCP clients expect to parse.
 */
export function wwwAuthenticateChallenge(config: OAuthMetadataConfig): string {
  return [
    'Bearer error="invalid_token"',
    `resource_metadata="${protectedResourceMetadataUrl(config)}"`,
    `scope="${MCP_OAUTH_SCOPE}"`,
  ].join(', ');
}
