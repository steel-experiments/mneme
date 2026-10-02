// ABOUTME: Tests the Discord MCP OAuth identity provider with stubbed HTTP (spec Section 32.5.2.1, plan 008).
// ABOUTME: Proves the admin decision from guild roles and each failure reason without a network.
import { describe, it, expect } from 'vitest';
import { createDiscordIdentityClient } from '../../src/platform/discord/oauth-identity.js';

const BASE = 'https://mneme.example';
const GUILD = '123456789012345678';
const ADMIN_ROLE = '456789012345678901';
const USER = '100000000000000007';
const SECRET = 'discord-client-secret-value';
const ACCESS_TOKEN = 'discord-user-access-token-value';

type Scripted = Response | Error;

function stubFetch(script: Scripted[]): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = script.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tokenOk = (): Response => json({ access_token: ACCESS_TOKEN, token_type: 'Bearer' });

function provider(script: Scripted[]) {
  const stub = stubFetch(script);
  const p = createDiscordIdentityClient({
    clientId: '987654321098765432',
    clientSecret: SECRET,
    publicBaseUrl: BASE,
    guildId: GUILD,
    adminRoleIds: [ADMIN_ROLE],
    fetchImpl: stub.fetchImpl,
  });
  return { p, urls: stub.urls };
}

describe('Discord identity provider', () => {
  it('authorizes a guild member with an admin role', async () => {
    const { p, urls } = provider([tokenOk(), json({ user: { id: USER }, roles: [ADMIN_ROLE] })]);
    expect(await p.identify('c')).toEqual({
      ok: true,
      identity: { userId: USER, authorization: { authorized: true, reason: 'ok' } },
    });
    expect(urls).toEqual([
      'https://discord.com/api/v10/oauth2/token',
      `https://discord.com/api/v10/users/@me/guilds/${GUILD}/member`,
    ]);
  });

  it('identifies a member without the admin role, but does not authorize them', async () => {
    const { p } = provider([tokenOk(), json({ user: { id: USER }, roles: ['111111111111111111'] })]);
    const outcome = await p.identify('c');
    expect(outcome.ok && outcome.identity.authorization).toEqual({ authorized: false, reason: 'not_authorized' });
  });

  it('fails closed when the roles cannot be read', async () => {
    const { p } = provider([tokenOk(), json({ user: { id: USER } })]);
    const outcome = await p.identify('c');
    expect(outcome.ok && outcome.identity.authorization).toEqual({ authorized: false, reason: 'role_data_unavailable' });
  });

  it('reports a person who is not in the guild', async () => {
    const { p } = provider([tokenOk(), json({ message: 'Unknown Guild' }, 404)]);
    expect(await p.identify('c')).toEqual({ ok: false, reason: 'not_a_workspace_member' });
  });

  it.each<[string, Scripted]>([
    ['a non-2xx status', json({ error: 'invalid_grant' }, 400)],
    ['a missing access token', json({})],
    ['a network error', new Error('socket hang up')],
  ])('reports code_exchange_failed for %s', async (_name, answer) => {
    const { p } = provider([answer]);
    expect(await p.identify('c')).toEqual({ ok: false, reason: 'code_exchange_failed' });
  });

  it('reports identity_unavailable when the membership call fails', async () => {
    const { p } = provider([tokenOk(), json({}, 500)]);
    expect(await p.identify('c')).toEqual({ ok: false, reason: 'identity_unavailable' });
  });

  it('never puts the access token or the client secret in an outcome', async () => {
    const { p } = provider([tokenOk(), json({ user: { id: USER }, roles: [ADMIN_ROLE] })]);
    const text = JSON.stringify(await p.identify('c'));
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(SECRET);
  });
});
