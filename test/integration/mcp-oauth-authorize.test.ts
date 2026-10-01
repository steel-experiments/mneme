import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createOAuthRoutes } from '../../src/mcp/oauth/routes.js';
import { createRateLimiter } from '../../src/mcp/rate-limit.js';
import { CLAUDE_HOSTED_REDIRECT_URI } from '../../src/mcp/oauth/client.js';
import {
  consumeLoginSession,
  purgeExpiredLoginSessions,
  createLoginSession,
} from '../../src/db/repositories/oauth-flows.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

/**
 * The authorization endpoint end to end over HTTP (Section 32.5.2, amended).
 *
 * Drives `GET /authorize` on the real server and asserts the three dispositions:
 * a hand-off to Discord, an error returned to a registered redirect, and an error
 * that must be shown directly because no redirect can be trusted. The stored
 * pending request is checked alongside, since where a code is later delivered is
 * decided by that row and never by the return leg.
 */

const BASE = 'https://mneme.example';
const CLIENT_ID = 'b7f3c1a9d24e40f8';
const HOST = '127.0.0.1';
const OAUTH_RATE_LIMIT = 20;

let env: TestDb;
let handle: HttpServerHandle;
let base: string;

beforeEach(async () => {
  env = createTestDb();
  handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: createLogger({ level: 'silent' }),
    oauthRoutes: createOAuthRoutes({
      db: env.db,
      logger: createLogger({ level: 'silent' }),
      now: () => Date.now(),
      rateLimiter: createRateLimiter({ limit: OAUTH_RATE_LIMIT }),
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

function authorizeUrl(overrides: Record<string, string | null> = {}): string {
  const params: Record<string, string | null> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CLAUDE_HOSTED_REDIRECT_URI,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${BASE}/mcp`,
    ...overrides,
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) query.set(key, value);
  }
  return `${base}/authorize?${query.toString()}`;
}

/** Follow nothing: the redirect itself is the assertion. */
const noRedirect = { redirect: 'manual' as const };

describe('GET /authorize', () => {
  it('stops unauthenticated durable writes at the shared request budget', async () => {
    for (let index = 0; index < OAUTH_RATE_LIMIT; index += 1) {
      expect((await fetch(authorizeUrl(), noRedirect)).status).toBe(302);
    }
    const limited = await fetch(authorizeUrl(), noRedirect);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM oauth_login_sessions').get())
      .toEqual({ n: OAUTH_RATE_LIMIT });
  });

  it('hands a valid request to Discord and stores the pending request', async () => {
    const res = await fetch(authorizeUrl(), noRedirect);
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/discord/callback`);
    // A cached redirect would resend a later visitor into a consumed sign-in.
    expect(res.headers.get('cache-control')).toBe('no-store');

    // The client's redirect and state live in the row, not in the URL Discord sees.
    const sessionId = location.searchParams.get('state') ?? '';
    expect(sessionId.length).toBeGreaterThan(20);
    expect(location.toString()).not.toContain('claude.ai');
    expect(location.toString()).not.toContain('client-state');

    const stored = consumeLoginSession(env.db, sessionId, Date.now());
    expect(stored).toMatchObject({
      clientId: CLIENT_ID,
      redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
      clientState: 'client-state',
      resource: `${BASE}/mcp`,
      scope: 'mneme:read',
    });
  });

  it('returns a parameter error to the registered redirect', async () => {
    const res = await fetch(authorizeUrl({ code_challenge_method: 'plain' }), noRedirect);
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(CLAUDE_HOSTED_REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('iss')).toBe(BASE);
  });

  it('never redirects when the redirect itself is untrusted', async () => {
    for (const bad of [
      { redirect_uri: 'https://evil.test/steal' },
      { client_id: 'someone-elses-id' },
      { redirect_uri: null },
    ]) {
      const res = await fetch(authorizeUrl(bad), noRedirect);
      // A 302 here would make Mneme an open redirector.
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).not.toContain('evil.test');
    }
  });

  it('writes no pending request for a rejected authorization', async () => {
    await fetch(authorizeUrl({ client_id: 'someone-elses-id' }), noRedirect);
    await fetch(authorizeUrl({ response_type: 'token' }), noRedirect);
    const count = env.db.prepare('SELECT COUNT(*) AS n FROM oauth_login_sessions').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it('is absent when no OAuth routes are configured', async () => {
    const bare = await startHttpServer({ port: 0, host: HOST, logger: createLogger({ level: 'silent' }) });
    try {
      const res = await fetch(`http://${HOST}:${bare.port}/authorize?client_id=x`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    } finally {
      await bare.close();
    }
  });
});

describe('pending sign-in storage', () => {
  const input = {
    clientId: CLIENT_ID,
    redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
    clientState: 'abc',
    codeChallenge: 'challenge-value',
    resource: `${BASE}/mcp`,
    scope: 'mneme:read',
  };

  it('resolves a handle exactly once', async () => {
    const now = Date.now();
    const session = createLoginSession(env.db, { ...input, createdAtMs: now });
    expect(consumeLoginSession(env.db, session.id, now)).toMatchObject({ clientState: 'abc' });
    // A replayed return leg finds nothing.
    expect(consumeLoginSession(env.db, session.id, now)).toBeUndefined();
  });

  it('treats an expired handle as absent and removes it', async () => {
    const now = Date.now();
    const session = createLoginSession(env.db, { ...input, createdAtMs: now, ttlMs: 1000 });
    expect(consumeLoginSession(env.db, session.id, now + 1001)).toBeUndefined();
    const count = env.db.prepare('SELECT COUNT(*) AS n FROM oauth_login_sessions').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('reports nothing for a fabricated handle', async () => {
    expect(consumeLoginSession(env.db, 'never-issued', Date.now())).toBeUndefined();
    expect(consumeLoginSession(env.db, '', Date.now())).toBeUndefined();
  });

  it('sweeps abandoned sign-ins', async () => {
    const now = Date.now();
    createLoginSession(env.db, { ...input, createdAtMs: now, ttlMs: 1000 });
    createLoginSession(env.db, { ...input, createdAtMs: now, ttlMs: 60_000 });
    expect(purgeExpiredLoginSessions(env.db, now + 2000)).toBe(1);
    const count = env.db.prepare('SELECT COUNT(*) AS n FROM oauth_login_sessions').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('issues unguessable handles', async () => {
    const now = Date.now();
    const ids = new Set(
      Array.from({ length: 50 }, () => createLoginSession(env.db, { ...input, createdAtMs: now }).id),
    );
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(43);
  });
});
