import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createOAuthRoutes } from '../../src/mcp/oauth/routes.js';
import { createRateLimiter } from '../../src/mcp/rate-limit.js';
import { CLAUDE_HOSTED_REDIRECT_URI } from '../../src/mcp/oauth/client.js';
import { hashAuthorizationCode } from '../../src/mcp/oauth/callback.js';
import type { DiscordIdentityClient, DiscordIdentityOutcome } from '../../src/mcp/oauth/discord.js';
import {
  consumeAuthorizationCode,
  createLoginSession,
  purgeExpiredAuthorizationCodes,
} from '../../src/db/repositories/oauth-flows.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

/**
 * The Discord return leg end to end (Section 32.5.2, amended).
 *
 * Discord is replaced by a fake so no test touches the network. What is under
 * test is the decision: a person's guild roles determine whether an authorization
 * code exists at all, every refusal looks identical to the client, and the code
 * that is issued is bound to the stored request rather than to anything in the
 * return URL.
 */

const BASE = 'https://mneme.example';
const CLIENT_ID = 'b7f3c1a9d24e40f8';
const ADMIN_ROLE = '456789012345678901';
const MEMBER_ROLE = '456789012345678902';
const USER_ID = '100000000000000007';
const HOST = '127.0.0.1';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

let env: TestDb;
let handle: HttpServerHandle;
let base: string;
/** Swapped per test to stand in for whatever Discord would have said. */
let identityOutcome: DiscordIdentityOutcome;
let seenCodes: string[];

const identity: DiscordIdentityClient = {
  identify: async (code) => {
    seenCodes.push(code);
    return identityOutcome;
  },
};

beforeEach(async () => {
  env = createTestDb();
  seenCodes = [];
  identityOutcome = { ok: true, membership: { userId: USER_ID, roleIds: [ADMIN_ROLE] } };
  handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: createLogger({ level: 'silent' }),
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

/** Put a pending sign-in in the database and return its handle. */
function pendingSignIn(): string {
  return createLoginSession(env.db, {
    clientId: CLIENT_ID,
    redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
    clientState: 'client-state',
    codeChallenge: CHALLENGE,
    resource: `${BASE}/mcp`,
    scope: 'mneme:read',
    createdAtMs: Date.now(),
  }).id;
}

async function callback(params: Record<string, string>): Promise<Response> {
  const query = new URLSearchParams(params);
  return fetch(`${base}/oauth/discord/callback?${query.toString()}`, { redirect: 'manual' });
}

describe('GET /oauth/discord/callback', () => {
  it('issues a code to the waiting client when an admin signs in', async () => {
    const state = pendingSignIn();
    const res = await callback({ code: 'discord-code', state });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(CLAUDE_HOSTED_REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('iss')).toBe(BASE);
    expect(location.searchParams.has('error')).toBe(false);

    // Discord's code went to the identity provider; ours came back to the client.
    expect(seenCodes).toEqual(['discord-code']);
    const code = location.searchParams.get('code') ?? '';
    expect(code.length).toBeGreaterThanOrEqual(43);
    expect(code).not.toBe('discord-code');

    // What the code is bound to comes from the stored request, not the return URL.
    const stored = consumeAuthorizationCode(env.db, hashAuthorizationCode(code), Date.now());
    expect(stored).toMatchObject({
      kind: 'valid',
      record: {
        clientId: CLIENT_ID,
        redirectUri: CLAUDE_HOSTED_REDIRECT_URI,
        codeChallenge: CHALLENGE,
        resource: `${BASE}/mcp`,
        subjectUserId: USER_ID,
        scopeType: 'org',
        channelIds: [],
      },
    });
  });

  it('stores only the hash of the code it issued', async () => {
    const state = pendingSignIn();
    const res = await callback({ code: 'discord-code', state });
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const rows = env.db.prepare('SELECT * FROM oauth_authorization_codes').all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    // A copy of the database must not yield a redeemable credential.
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(rows[0]?.code_hash).toBe(hashAuthorizationCode(code));
  });

  it('refuses every unauthorized sign-in identically', async () => {
    // A guild member without the admin role, a non-member, a declined consent,
    // and an identity provider that failed must be indistinguishable to the
    // client — otherwise the connector URL becomes a guild-membership oracle.
    const cases: Array<[string, () => Record<string, string>]> = [
      [
        'member without the admin role',
        () => {
          identityOutcome = { ok: true, membership: { userId: USER_ID, roleIds: [MEMBER_ROLE] } };
          return { code: 'discord-code' };
        },
      ],
      [
        'roles that could not be resolved',
        () => {
          identityOutcome = { ok: true, membership: { userId: USER_ID, roleIds: null } };
          return { code: 'discord-code' };
        },
      ],
      [
        'not a guild member',
        () => {
          identityOutcome = { ok: false, reason: 'not_a_guild_member' };
          return { code: 'discord-code' };
        },
      ],
      [
        'code exchange failed',
        () => {
          identityOutcome = { ok: false, reason: 'code_exchange_failed' };
          return { code: 'discord-code' };
        },
      ],
      ['person declined at Discord', () => ({ error: 'access_denied' })],
    ];

    for (const [, setup] of cases) {
      const state = pendingSignIn();
      const res = await callback({ ...setup(), state });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location') ?? '');
      expect(location.origin + location.pathname).toBe(CLAUDE_HOSTED_REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.get('state')).toBe('client-state');
      expect(location.searchParams.get('iss')).toBe(BASE);
      expect(location.searchParams.has('code')).toBe(false);
    }

    // Not one refusal wrote a redeemable code.
    const count = env.db.prepare('SELECT COUNT(*) AS n FROM oauth_authorization_codes').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it('denies everyone when no admin role is configured', async () => {
    // authorizeAdmin fails closed on an empty allowlist; the endpoint must not
    // quietly treat "nobody is privileged" as "everybody is".
    const bare = await startHttpServer({
      port: 0,
      host: HOST,
      logger: createLogger({ level: 'silent' }),
      oauthRoutes: createOAuthRoutes({
        db: env.db,
        logger: createLogger({ level: 'silent' }),
        now: () => Date.now(),
        rateLimiter: createRateLimiter({ limit: 1_000 }),
        identity,
        adminRoleIds: [],
        context: {
          client: { clientId: CLIENT_ID, redirectUris: [CLAUDE_HOSTED_REDIRECT_URI] },
          resource: `${BASE}/mcp`,
          publicBaseUrl: BASE,
          discordClientId: '987654321098765432',
        },
      }),
    });
    try {
      const state = pendingSignIn();
      const res = await fetch(
        `http://${HOST}:${bare.port}/oauth/discord/callback?code=c&state=${state}`,
        { redirect: 'manual' },
      );
      const location = new URL(res.headers.get('location') ?? '');
      expect(location.searchParams.get('error')).toBe('access_denied');
    } finally {
      await bare.close();
    }
  });

  it('shows a page when the pending sign-in cannot be resolved', async () => {
    // No stored request means no registered redirect, so there is nowhere
    // trustworthy to send an error.
    for (const params of [{ code: 'c', state: 'never-issued' }, { code: 'c' }]) {
      const res = await callback(params);
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toContain('text/html');
    }
  });

  it('resolves a pending sign-in exactly once', async () => {
    const state = pendingSignIn();
    expect((await callback({ code: 'discord-code', state })).status).toBe(302);
    // A replayed return leg finds nothing to resume.
    const replay = await callback({ code: 'discord-code', state });
    expect(replay.status).toBe(400);
  });
});

describe('authorization code redemption', () => {
  const insert = (overrides: Record<string, unknown> = {}) => {
    const code = 'plaintext-code-value';
    const now = Date.now();
    env.db
      .prepare(
        `INSERT INTO oauth_authorization_codes
           (code_hash, client_id, redirect_uri, code_challenge, resource, scope,
            subject_user_id, scope_type, channel_ids_json, created_at_ms, expires_at_ms,
            consumed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'org', '[]', ?, ?, ?)`,
      )
      .run(
        hashAuthorizationCode(code),
        CLIENT_ID,
        CLAUDE_HOSTED_REDIRECT_URI,
        CHALLENGE,
        `${BASE}/mcp`,
        'mneme:read',
        USER_ID,
        now,
        (overrides.expiresAtMs as number) ?? now + 60_000,
        (overrides.consumedAtMs as number | null) ?? null,
      );
    return { code, now };
  };

  it('redeems once and reports a second attempt as a replay', async () => {
    const { code, now } = insert();
    expect(consumeAuthorizationCode(env.db, hashAuthorizationCode(code), now).kind).toBe('valid');
    // OAuth 2.1 4.1.3 — a code presented twice is evidence of interception, so
    // it is distinguished from an unknown code for the operator's log.
    expect(consumeAuthorizationCode(env.db, hashAuthorizationCode(code), now).kind).toBe('reused');
  });

  it('reports an unknown or expired code', async () => {
    expect(consumeAuthorizationCode(env.db, hashAuthorizationCode('never-issued'), Date.now()).kind).toBe(
      'invalid',
    );
    const { code, now } = insert({ expiresAtMs: Date.now() - 1 });
    expect(consumeAuthorizationCode(env.db, hashAuthorizationCode(code), now).kind).toBe('expired');
  });

  it('keeps an expired code long enough to still recognize a replay', async () => {
    const { code, now } = insert({ expiresAtMs: Date.now() - 1 });
    // A sweep at the moment of expiry leaves the row, so a replay arriving
    // seconds later is still reported as a replay rather than as an unknown code.
    expect(purgeExpiredAuthorizationCodes(env.db, now)).toBe(0);
    expect(consumeAuthorizationCode(env.db, hashAuthorizationCode(code), now).kind).toBe('expired');

    // Well past the grace period the row goes, and the code becomes unknown.
    expect(purgeExpiredAuthorizationCodes(env.db, now + 120_000)).toBe(1);
    expect(consumeAuthorizationCode(env.db, hashAuthorizationCode(code), now).kind).toBe('invalid');
  });
});
