import { describe, it, expect } from 'vitest';
import {
  CLAUDE_HOSTED_REDIRECT_URI,
  checkRedirectUri,
  validateClient,
  type OAuthClientConfig,
} from '../../src/mcp/oauth/client.js';

const config: OAuthClientConfig = {
  clientId: 'b7f3c1a9d24e40f8',
  redirectUris: [CLAUDE_HOSTED_REDIRECT_URI],
};

const good = { clientId: config.clientId, redirectUri: CLAUDE_HOSTED_REDIRECT_URI };

describe('MCP OAuth client recognition', () => {
  it('accepts the configured client returning to a registered redirect', () => {
    expect(validateClient(config, good)).toEqual({
      ok: true,
      redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
    });
  });

  it('publishes the callback Anthropic uses for every hosted surface', () => {
    // Web, Desktop, and mobile share this one callback, so an iOS connector and
    // a browser connector need no separate registration.
    expect(CLAUDE_HOSTED_REDIRECT_URI).toBe('https://claude.ai/api/mcp/auth_callback');
  });

  it('rejects a missing or unknown client id', () => {
    expect(validateClient(config, { ...good, clientId: undefined })).toEqual({
      ok: false,
      error: 'invalid_request',
      detail: 'client_id is required',
    });
    expect(validateClient(config, { ...good, clientId: '' }).ok).toBe(false);
    expect(validateClient(config, { ...good, clientId: 'someone-elses-id' })).toEqual({
      ok: false,
      error: 'invalid_client',
      detail: 'unknown client_id',
    });
  });

  it('compares redirect URIs exactly, refusing every near miss', () => {
    // Each of these is a documented way authorization codes get stolen when a
    // server matches loosely instead of by exact string.
    const nearMisses = [
      `${CLAUDE_HOSTED_REDIRECT_URI}/`, // trailing slash
      `${CLAUDE_HOSTED_REDIRECT_URI}?next=https://evil.test`, // appended query
      `${CLAUDE_HOSTED_REDIRECT_URI}/../../evil`, // path traversal
      'https://claude.ai.evil.test/api/mcp/auth_callback', // suffix on the host
      'https://evil.test/api/mcp/auth_callback', // different host, same path
      'https://claude.ai/api/mcp/auth_callback#x', // added fragment
      'http://claude.ai/api/mcp/auth_callback', // downgraded scheme
      'https://CLAUDE.AI/api/mcp/auth_callback', // case-changed host
    ];
    for (const redirectUri of nearMisses) {
      expect(validateClient(config, { ...good, redirectUri })).toEqual({
        ok: false,
        error: 'invalid_request',
        detail: 'redirect_uri is not registered',
      });
    }
  });

  it('requires a redirect URI to be present', () => {
    expect(validateClient(config, { ...good, redirectUri: undefined })).toEqual({
      ok: false,
      error: 'invalid_request',
      detail: 'redirect_uri is required',
    });
  });

  it('honors additional registered redirects without loosening the match', () => {
    const two: OAuthClientConfig = {
      clientId: config.clientId,
      redirectUris: [CLAUDE_HOSTED_REDIRECT_URI, 'https://staging.example.test/cb'],
    };
    expect(validateClient(two, { ...good, redirectUri: 'https://staging.example.test/cb' }).ok).toBe(true);
    expect(validateClient(two, { ...good, redirectUri: 'https://staging.example.test/cb2' }).ok).toBe(false);
  });
});

describe('registered redirect URI checks', () => {
  it('accepts https and loopback http', () => {
    expect(checkRedirectUri(CLAUDE_HOSTED_REDIRECT_URI)).toBeNull();
    for (const loopback of [
      'http://127.0.0.1:8080/callback',
      'http://localhost:3000/callback',
      'http://[::1]:9000/callback',
    ]) {
      expect(checkRedirectUri(loopback)).toBeNull();
    }
  });

  it('rejects a URI that cannot safely carry an authorization code', () => {
    // Plaintext to a remote host would expose the code in transit.
    expect(checkRedirectUri('http://example.test/cb')).toBe('insecure_scheme');
    expect(checkRedirectUri('ftp://example.test/cb')).toBe('insecure_scheme');
    // Not absolute: nothing to compare against.
    expect(checkRedirectUri('/callback')).toBe('not_absolute');
    expect(checkRedirectUri('not a url')).toBe('not_absolute');
    // A registered redirect may not carry a fragment (RFC 6749 3.1.2).
    expect(checkRedirectUri('https://example.test/cb#frag')).toBe('has_fragment');
    // Credentials would be carried into a redirect Mneme emits.
    expect(checkRedirectUri('https://user:pw@example.test/cb')).toBe('has_credentials');
  });
});
