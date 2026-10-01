import { describe, it, expect } from 'vitest';
import {
  MCP_OAUTH_SCOPE,
  OAUTH_AUTHORIZATION_SERVER_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  authorizationServerMetadata,
  mcpResourceIdentifier,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
  protectedResourceMetadataUrl,
  wwwAuthenticateChallenge,
} from '../../src/mcp/oauth/metadata.js';

// The deployed shape: a Railway public domain and the default MCP path.
const config = {
  publicBaseUrl: 'https://mneme.example.up.railway.app',
  mcpPath: '/mcp',
};

describe('MCP OAuth discovery documents', () => {
  it('identifies the resource by the exact endpoint URL a client is given', () => {
    // A client sends this as the RFC 8707 `resource` parameter and compares it
    // against the metadata; a trailing slash or a query would break the match.
    expect(mcpResourceIdentifier(config)).toBe(
      'https://mneme.example.up.railway.app/mcp',
    );
    expect(protectedResourceMetadata(config).resource).toBe(mcpResourceIdentifier(config));
  });

  it('publishes protected resource metadata at the RFC 9728 path-suffixed location', () => {
    // Section 3.1 inserts the resource path after the well-known segment.
    expect(protectedResourceMetadataPath('/mcp')).toBe('/.well-known/oauth-protected-resource/mcp');
    expect(protectedResourceMetadataUrl(config)).toBe(
      'https://mneme.example.up.railway.app/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('follows a non-default MCP path', () => {
    const custom = { ...config, mcpPath: '/agents/mcp' };
    expect(mcpResourceIdentifier(custom)).toBe(`${config.publicBaseUrl}/agents/mcp`);
    expect(protectedResourceMetadataPath('/agents/mcp')).toBe(
      '/.well-known/oauth-protected-resource/agents/mcp',
    );
  });

  it('names exactly one authorization server: Mneme itself', () => {
    const prm = protectedResourceMetadata(config);
    // A client uses the first entry and never falls back to later ones, so a
    // longer list would be dead weight.
    expect(prm.authorization_servers).toEqual([config.publicBaseUrl]);
    expect(prm.bearer_methods_supported).toEqual(['header']);
    expect(prm.scopes_supported).toEqual([MCP_OAUTH_SCOPE]);
  });

  it('advertises a public client with S256 PKCE and no registration endpoint', () => {
    const asm = authorizationServerMetadata(config);
    expect(asm.issuer).toBe(config.publicBaseUrl);
    expect(asm.authorization_endpoint).toBe(`${config.publicBaseUrl}/authorize`);
    expect(asm.token_endpoint).toBe(`${config.publicBaseUrl}/token`);
    // A connector on a phone cannot hold a secret; PKCE carries the protection.
    expect(asm.token_endpoint_auth_methods_supported).toEqual(['none']);
    // OAuth 2.1 removes `plain`.
    expect(asm.code_challenge_methods_supported).toEqual(['S256']);
    expect(asm.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(asm.response_types_supported).toEqual(['code']);
    // Dynamic Client Registration is deprecated and deliberately absent.
    expect(asm).not.toHaveProperty('registration_endpoint');
  });

  it('holds no secret-bearing field in either document', () => {
    const serialized = JSON.stringify([
      protectedResourceMetadata(config),
      authorizationServerMetadata(config),
    ]);
    for (const forbidden of ['secret', 'token_hash', 'password', 'client_secret']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('builds a parseable challenge that points at the metadata document', () => {
    const challenge = wwwAuthenticateChallenge(config);
    expect(challenge).toBe(
      'Bearer error="invalid_token", ' +
        'resource_metadata="https://mneme.example.up.railway.app' +
        '/.well-known/oauth-protected-resource/mcp", ' +
        `scope="${MCP_OAUTH_SCOPE}"`,
    );
    // The parameter a client extracts to start discovery.
    const found = /resource_metadata="([^"]+)"/.exec(challenge);
    expect(found?.[1]).toBe(protectedResourceMetadataUrl(config));
  });

  it('keeps the well-known path constants stable', () => {
    // These are the locations a client probes when a challenge is unavailable;
    // changing them silently would break discovery for already-added connectors.
    expect(OAUTH_PROTECTED_RESOURCE_PATH).toBe('/.well-known/oauth-protected-resource');
    expect(OAUTH_AUTHORIZATION_SERVER_PATH).toBe('/.well-known/oauth-authorization-server');
  });
});
