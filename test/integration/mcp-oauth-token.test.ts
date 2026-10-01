import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createOAuthRoutes } from '../../src/mcp/oauth/routes.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createRateLimiter } from '../../src/mcp/rate-limit.js';
import { CLAUDE_HOSTED_REDIRECT_URI } from '../../src/mcp/oauth/client.js';
import { ACCESS_TOKEN_TTL_MS, verifyPkce } from '../../src/mcp/oauth/token.js';
import {
  OAUTH_ACCESS_TOKEN_PURGE_GRACE_MS,
  purgeExpiredOAuthAccessTokens,
} from '../../src/db/repositories/oauth-flows.js';
import { insertMcpToken } from '../../src/db/repositories/mcp-tokens.js';
import type { DiscordIdentityClient, DiscordIdentityOutcome } from '../../src/platform/types.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';

/**
 * The token endpoint and the whole sign-in, end to end (Section 32.5.2, amended).
 *
 * The headline test drives every step a phone would: `/authorize`, the Discord
 * return, `/token`, and then a real MCP call with the resulting bearer. What it
 * proves is that an OAuth-issued token is an ordinary `mcp_tokens` row — the MCP
 * endpoint authenticates it without knowing where it came from, so there is one
 * grant model rather than two.
 */

const BASE = 'https://mneme.example';
const CLIENT_ID = 'b7f3c1a9d24e40f8';
const ADMIN_ROLE = '456789012345678901';
const USER_ID = '100000000000000007';
const GUILD = '100000000000000001';
const HOST = '127.0.0.1';

let env: TestDb;
let handle: HttpServerHandle;
let base: string;
let identityOutcome: DiscordIdentityOutcome;

const identity: DiscordIdentityClient = {
  identify: async () => identityOutcome,
};

/** A real PKCE pair: the challenge is base64url(sha256(verifier)). */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

beforeEach(async () => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
  identityOutcome = { ok: true, membership: { userId: USER_ID, roleIds: [ADMIN_ROLE] } };
  const mcp = createMcpServer({
    db: env.db,
    rateLimiter: createRateLimiter({ limit: 60 }),
    methods: { echo: async (params) => ({ ok: true, result: { echo: params } }) },
  });
  handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: createLogger({ level: 'silent' }),
    mcpEnabled: true,
    mcpPath: '/mcp',
    mcpHandler: mcp.handler,
    oauthRoutes: createOAuthRoutes({
      db: env.db,
      logger: createLogger({ level: 'silent' }),
      now: () => Date.now(),
      rateLimiter: createRateLimiter({ limit: 1_000 }),
      identity,
      adminRoleIds: [ADMIN_ROLE],
      context: {
        client: { clientId: CLIENT_ID, redirectUris: [CLAUDE_HOSTED_REDIRECT_URI] },
        resource: `${BASE}/mcp`,
        publicBaseUrl: BASE,
        discordClientId: '987654321098765432',
      },
    }),
  });
  base = `http://${HOST}:${handle.port}`;
});

afterEach(async () => {
  await handle.close();
  env.cleanup();
});

it('purges only stale OAuth access tokens in bounded batches', () => {
  const now = 1_700_000_000_000;
  const insert = (name: string, expiresAtMs: number, oauthFamilyId?: string) => insertMcpToken(env.db, {
    tokenHash: createHash('sha256').update(name).digest('hex'),
    name,
    scopeType: 'org',
    channelIds: [],
    createdByUserId: USER_ID,
    createdAtMs: now - 10_000,
    expiresAtMs,
    subjectUserId: oauthFamilyId ? USER_ID : null,
    oauthFamilyId: oauthFamilyId ?? null,
  });
  insert('stale-oauth', now - OAUTH_ACCESS_TOKEN_PURGE_GRACE_MS - 1, 'family-stale');
  insert('recent-oauth', now + ACCESS_TOKEN_TTL_MS, 'family-live');
  insert('expired-admin', now - OAUTH_ACCESS_TOKEN_PURGE_GRACE_MS - 1);

  expect(purgeExpiredOAuthAccessTokens(env.db, now, 1)).toBe(1);
  const names = (env.db.prepare('SELECT name FROM mcp_tokens ORDER BY name').all() as Array<{ name: string }>)
    .map((row) => row.name);
  expect(names).toEqual(['expired-admin', 'recent-oauth']);
});

/** Drive /authorize and the Discord return, returning the authorization code. */
async function signIn(challenge: string): Promise<string> {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CLAUDE_HOSTED_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${BASE}/mcp`,
  });
  const started = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
  const sessionId =
    new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const returned = await fetch(
    `${base}/oauth/discord/callback?code=discord-code&state=${sessionId}`,
    { redirect: 'manual' },
  );
  return new URL(returned.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

/** POST a form-encoded token request, as Claude does. */
async function token(fields: Record<string, string>): Promise<Response> {
  const form = { client_id: CLIENT_ID, ...fields };
  if (form.grant_type === 'authorization_code' && !('redirect_uri' in form)) {
    Object.assign(form, { redirect_uri: CLAUDE_HOSTED_REDIRECT_URI });
  }
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}

async function callMcp(accessToken: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'echo', params: { hi: true } }),
  });
}

describe('the whole sign-in, end to end', () => {
  it('turns a Discord sign-in into a working MCP bearer token', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await signIn(challenge);
    expect(code).not.toBe('');

    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_HOSTED_REDIRECT_URI,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    });
    expect(res.status).toBe(200);
    // RFC 6749 5.1 — the body holds a credential, so it must not be cached.
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as Record<string, string | number>;
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('mneme:read');
    expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_MS / 1000);
    expect(typeof body.refresh_token).toBe('string');

    // The point of the exercise: the MCP endpoint accepts it like any other token.
    const call = await callMcp(String(body.access_token));
    expect(call.status).toBe(200);
    expect(await call.json()).toMatchObject({ result: { echo: { hi: true } } });
  });

  it('records the token as an ordinary mcp_tokens row naming the person', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await signIn(challenge);
    const body = (await (
      await token({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: CLAUDE_HOSTED_REDIRECT_URI,
      })
    ).json()) as Record<string, string>;

    const row = env.db
      .prepare('SELECT * FROM mcp_tokens WHERE subject_user_id = ?')
      .get(USER_ID) as Record<string, unknown>;
    expect(row.scope_type).toBe('org');
    expect(row.channel_ids_json).toBe('[]');
    expect(row.name).toBe(`oauth:${USER_ID}`);
    expect(row.oauth_family_id).not.toBeNull();
    // Only hashes are stored, never a redeemable value.
    const stored = JSON.stringify([
      row,
      env.db.prepare('SELECT * FROM oauth_refresh_tokens').all(),
    ]);
    expect(stored).not.toContain(body.access_token);
    expect(stored).not.toContain(body.refresh_token);
  });

  it('renews access without troubling the person again', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await signIn(challenge);
    const first = (await (
      await token({ grant_type: 'authorization_code', code, code_verifier: verifier })
    ).json()) as Record<string, string>;

    const renewed = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token ?? '',
      client_id: CLIENT_ID,
    });
    expect(renewed.status).toBe(200);
    const second = (await renewed.json()) as Record<string, string>;
    expect(second.access_token).not.toBe(first.access_token);
    // Rotation: the refresh token itself is replaced on every use.
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await callMcp(second.access_token ?? '')).status).toBe(200);
  });
});

describe('POST /token failures', () => {
  it('refuses a code whose PKCE verifier does not match', async () => {
    const { challenge } = pkcePair();
    const code = await signIn(challenge);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: pkcePair().verifier, // a different verifier
    });
    expect(res.status).toBe(400);
    // Claude keys "this credential is dead, sign in again" on invalid_grant.
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('requires a verifier at all', async () => {
    const { challenge } = pkcePair();
    const code = await signIn(challenge);
    const res = await token({ grant_type: 'authorization_code', code });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('refuses a code redeemed against a different redirect', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await signIn(challenge);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: 'https://evil.test/steal',
    });
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('reports an unknown, expired, or already-redeemed code identically', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await signIn(challenge);
    const first = await token({ grant_type: 'authorization_code', code, code_verifier: verifier });
    expect(first.status).toBe(200);

    // Replay of a spent code, and a code that never existed, look the same.
    for (const attempt of [code, 'never-issued']) {
      const res = await token({
        grant_type: 'authorization_code',
        code: attempt,
        code_verifier: verifier,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    }
  });

  it('ends the whole chain when a rotated refresh token comes back', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await signIn(challenge);
    const first = (await (
      await token({ grant_type: 'authorization_code', code, code_verifier: verifier })
    ).json()) as Record<string, string>;
    const second = (await (
      await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token ?? '' })
    ).json()) as Record<string, string>;

    // Replaying the rotated token: either the client repeated itself or someone
    // stole it, and the two cannot be told apart (OAuth 2.1 4.3.1).
    const replay = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token ?? '',
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });

    // Every access token from that sign-in is dead, including the newest.
    expect((await callMcp(second.access_token ?? '')).status).toBe(401);
    expect((await callMcp(first.access_token ?? '')).status).toBe(401);
    // And the rotated successor can no longer be exchanged either.
    const afterBreach = await token({
      grant_type: 'refresh_token',
      refresh_token: second.refresh_token ?? '',
    });
    expect(afterBreach.status).toBe(400);
  });

  it('rejects an unknown client id and an unsupported grant', async () => {
    const wrongClient = await token({ grant_type: 'refresh_token', client_id: 'someone-else' });
    expect(wrongClient.status).toBe(401);
    expect(await wrongClient.json()).toMatchObject({ error: 'invalid_client' });

    const wrongGrant = await token({ grant_type: 'client_credentials' });
    expect(wrongGrant.status).toBe(400);
    expect(await wrongGrant.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('requires the client id, redirect binding, and form content type', async () => {
    const missingClient = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=unknown',
    });
    expect(missingClient.status).toBe(401);
    expect(await missingClient.json()).toMatchObject({ error: 'invalid_client' });

    const { verifier, challenge } = pkcePair();
    const code = await signIn(challenge);
    const missingRedirect = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
      }),
    });
    expect(missingRedirect.status).toBe(400);
    expect(await missingRedirect.json()).toMatchObject({ error: 'invalid_request' });

    const json = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(415);
  });

  it('refuses an oversized body without reading it all', async () => {
    const res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${'x'.repeat(20_000)}`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });
});

describe('PKCE verification', () => {
  it('accepts only the verifier behind the challenge', () => {
    // RFC 7636 4.6, with the worked example from appendix B.
    expect(
      verifyPkce(
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      ),
    ).toBe(true);
    expect(verifyPkce('wrong-verifier', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
    // A length mismatch must not short-circuit into a throw.
    expect(verifyPkce('x', 'short')).toBe(false);
    expect(verifyPkce('', '')).toBe(false);
  });
});
