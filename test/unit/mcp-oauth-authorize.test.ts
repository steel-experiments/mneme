import { describe, it, expect } from 'vitest';
import {
  DISCORD_CALLBACK_PATH,
  DISCORD_SCOPES,
  discordAuthorizationUrl,
  discordCallbackUrl,
  errorRedirectUrl,
  planAuthorization,
  type AuthorizationContext,
  type AuthorizationRequest,
} from '../../src/mcp/oauth/authorize.js';
import { CLAUDE_HOSTED_REDIRECT_URI } from '../../src/mcp/oauth/client.js';

const BASE = 'https://mneme.example.up.railway.app';

const ctx: AuthorizationContext = {
  client: { clientId: 'b7f3c1a9d24e40f8', redirectUris: [CLAUDE_HOSTED_REDIRECT_URI] },
  resource: `${BASE}/mcp`,
  publicBaseUrl: BASE,
  discordClientId: '987654321098765432',
};

/** A request that should succeed; individual tests break one field at a time. */
function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    responseType: 'code',
    clientId: ctx.client.clientId,
    redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    scope: 'mneme:read',
    state: 'client-state-value',
    resource: `${BASE}/mcp`,
    ...overrides,
  };
}

describe('authorization request planning', () => {
  it('accepts a well-formed request and carries the client state forward', () => {
    expect(planAuthorization(ctx, request())).toEqual({
      kind: 'accepted',
      redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
      clientState: 'client-state-value',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      resource: `${BASE}/mcp`,
      scope: 'mneme:read',
    });
  });

  it('treats an absent state as absent rather than empty', () => {
    const plan = planAuthorization(ctx, request({ state: undefined }));
    expect(plan.kind === 'accepted' && plan.clientState).toBeNull();
    const blank = planAuthorization(ctx, request({ state: '' }));
    expect(blank.kind === 'accepted' && blank.clientState).toBeNull();
  });

  it('defaults an omitted scope and resource to this server', () => {
    // A client that sends neither still gets a token bound to this MCP endpoint.
    const plan = planAuthorization(ctx, request({ scope: undefined, resource: undefined }));
    expect(plan).toMatchObject({ kind: 'accepted', scope: 'mneme:read', resource: `${BASE}/mcp` });
  });

  describe('errors that must never be redirected', () => {
    // Until the redirect is known registered there is no trustworthy address;
    // redirecting would make the endpoint an open redirector.
    it('shows an unknown client id directly', () => {
      expect(planAuthorization(ctx, request({ clientId: 'not-the-configured-id' }))).toEqual({
        kind: 'terminal_error',
        status: 400,
        error: 'invalid_client',
        description: 'unknown client_id',
      });
    });

    it('shows an unregistered redirect directly', () => {
      const plan = planAuthorization(ctx, request({ redirectUri: 'https://evil.test/steal' }));
      expect(plan).toMatchObject({ kind: 'terminal_error', error: 'invalid_request' });
    });

    it('shows a missing client id or redirect directly', () => {
      expect(planAuthorization(ctx, request({ clientId: undefined })).kind).toBe('terminal_error');
      expect(planAuthorization(ctx, request({ redirectUri: undefined })).kind).toBe('terminal_error');
    });
  });

  describe('errors returned to the registered redirect', () => {
    const expectRedirectError = (overrides: Partial<AuthorizationRequest>, error: string) => {
      const plan = planAuthorization(ctx, request(overrides));
      expect(plan).toMatchObject({
        kind: 'redirect_error',
        redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
        error,
        clientState: 'client-state-value',
      });
    };

    it('rejects a response type other than code', () => {
      // OAuth 2.1 removes the implicit grant.
      expectRedirectError({ responseType: 'token' }, 'unsupported_response_type');
      expectRedirectError({ responseType: undefined }, 'unsupported_response_type');
    });

    it('requires a PKCE challenge', () => {
      // There is no client secret to fall back on, so this is the only defense
      // against an intercepted authorization code.
      expectRedirectError({ codeChallenge: undefined }, 'invalid_request');
      expectRedirectError({ codeChallenge: '' }, 'invalid_request');
    });

    it('requires the S256 challenge method', () => {
      // `plain` offers no protection and RFC 7636 defaults to it when the method
      // is omitted, so silence is rejected as well.
      expectRedirectError({ codeChallengeMethod: 'plain' }, 'invalid_request');
      expectRedirectError({ codeChallengeMethod: undefined }, 'invalid_request');
    });

    it('refuses to mint a token for another audience', () => {
      // RFC 8707: a token issued here is for this server and nothing else.
      expectRedirectError({ resource: 'https://someone-else.test/mcp' }, 'invalid_target');
      expectRedirectError({ resource: `${BASE}/mcp/` }, 'invalid_target');
    });

    it('refuses a scope beyond what this server issues', () => {
      expectRedirectError({ scope: 'mneme:read mneme:admin' }, 'invalid_scope');
      expectRedirectError({ scope: 'everything' }, 'invalid_scope');
    });
  });
});

describe('outbound URLs', () => {
  it('sends the person to Discord with only an opaque handle', () => {
    const url = new URL(discordAuthorizationUrl(ctx, 'opaque-session-handle'));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe(ctx.discordClientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(DISCORD_SCOPES);
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}${DISCORD_CALLBACK_PATH}`);
    expect(url.searchParams.get('state')).toBe('opaque-session-handle');

    // The client's own redirect must not travel through the browser, or the
    // return leg could change where an authorization code is delivered.
    expect(url.toString()).not.toContain('claude.ai');
  });

  it('needs the role scope to make an authorization decision possible', () => {
    expect(DISCORD_SCOPES).toContain('guilds.members.read');
    expect(discordCallbackUrl(BASE)).toBe(`${BASE}/oauth/discord/callback`);
  });

  it('returns an error to the client with its state and the issuer', () => {
    const url = new URL(
      errorRedirectUrl(
        {
          kind: 'redirect_error',
          redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
          error: 'invalid_scope',
          description: 'nope',
          clientState: 'abc',
        },
        BASE,
      ),
    );
    expect(url.origin + url.pathname).toBe(CLAUDE_HOSTED_REDIRECT_URI);
    expect(url.searchParams.get('error')).toBe('invalid_scope');
    expect(url.searchParams.get('error_description')).toBe('nope');
    expect(url.searchParams.get('state')).toBe('abc');
    // RFC 9207 — lets a client spot a response from a different server.
    expect(url.searchParams.get('iss')).toBe(BASE);
  });

  it('omits state entirely when the client sent none', () => {
    const url = new URL(
      errorRedirectUrl(
        {
          kind: 'redirect_error',
          redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
          error: 'invalid_request',
          description: 'x',
          clientState: null,
        },
        BASE,
      ),
    );
    expect(url.searchParams.has('state')).toBe(false);
  });
});
