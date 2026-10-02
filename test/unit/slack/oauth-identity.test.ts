// ABOUTME: Tests the Slack MCP OAuth identity provider with stubbed HTTP (spec Section 32.5.2.1, plan 008).
// ABOUTME: Covers the URL, the code exchange, userInfo, the team check, the admin decision, and every failure.
import { describe, it, expect } from 'vitest';
import {
  SLACK_CALLBACK_PATH,
  SLACK_SCOPES,
  createSlackIdentityProvider,
  type SlackIdentityConfig,
} from '../../../src/platform/slack/oauth-identity.js';

const BASE = 'https://mneme.example';
const TEAM = 'T0000000001';
const ADMIN = 'U0000000001';
const SECRET = 'slack-client-secret-value';
const ACCESS_TOKEN = 'xoxp-user-access-token-value';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type Scripted = Response | Error;

/** A `fetch` stub that records each request and answers from a script. */
function stubFetch(script: Scripted[]): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined || init.body === null ? null : String(init.body),
    });
    const next = script.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tokenOk = (): Response => json({ ok: true, access_token: ACCESS_TOKEN, token_type: 'Bearer', id_token: 'header.claims.sig' });
const userInfo = (claims: Record<string, unknown>): Response => json({ ok: true, ...claims });
const claimsFor = (teamId: string, userId: string): Record<string, unknown> => ({
  sub: userId,
  'https://slack.com/user_id': userId,
  'https://slack.com/team_id': teamId,
});

function provider(script: Scripted[], over: Partial<SlackIdentityConfig> = {}) {
  const stub = stubFetch(script);
  const p = createSlackIdentityProvider({
    clientId: '1111.2222',
    clientSecret: SECRET,
    publicBaseUrl: BASE,
    workspaceId: TEAM,
    adminUserIds: [ADMIN],
    fetchImpl: stub.fetchImpl,
    ...over,
  });
  return { p, calls: stub.calls };
}

describe('Slack identity provider', () => {
  it('sends the person to Slack with the callback, state, and team, and without email', () => {
    const { p } = provider([]);
    expect(p.callbackPath).toBe(SLACK_CALLBACK_PATH);
    const url = new URL(p.authorizationUrl('opaque-session-handle'));
    expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('1111.2222');
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/slack/callback`);
    expect(url.searchParams.get('state')).toBe('opaque-session-handle');
    expect(url.searchParams.get('team')).toBe(TEAM);
    expect(SLACK_SCOPES).not.toContain('email');
  });

  it('exchanges the code with a form POST, then reads userInfo with the bearer token', async () => {
    const { p, calls } = provider([tokenOk(), userInfo(claimsFor(TEAM, ADMIN))]);
    await p.identify('the-slack-code');

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://slack.com/api/openid.connect.token');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(calls[0]?.body ?? '');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-slack-code');
    expect(form.get('redirect_uri')).toBe(`${BASE}/oauth/slack/callback`);
    expect(form.get('client_id')).toBe('1111.2222');
    expect(form.get('client_secret')).toBe(SECRET);

    expect(calls[1]?.url).toBe('https://slack.com/api/openid.connect.userInfo');
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    // Every request goes to slack.com and nowhere else.
    for (const call of calls) expect(new URL(call.url).hostname).toBe('slack.com');
  });

  it('authorizes an admin of the configured workspace', async () => {
    const { p } = provider([tokenOk(), userInfo(claimsFor(TEAM, ADMIN))]);
    expect(await p.identify('c')).toEqual({
      ok: true,
      identity: { userId: ADMIN, authorization: { authorized: true, reason: 'ok' } },
    });
  });

  it('identifies a user who is not an admin, but does not authorize them', async () => {
    const { p } = provider([tokenOk(), userInfo(claimsFor(TEAM, 'U0000000099'))]);
    expect(await p.identify('c')).toEqual({
      ok: true,
      identity: { userId: 'U0000000099', authorization: { authorized: false, reason: 'not_authorized' } },
    });
  });

  it('authorizes nobody when no admin is configured', async () => {
    const { p } = provider([tokenOk(), userInfo(claimsFor(TEAM, ADMIN))], { adminUserIds: [] });
    const outcome = await p.identify('c');
    expect(outcome.ok && outcome.identity.authorization).toEqual({ authorized: false, reason: 'no_admin_roles_configured' });
  });

  it('refuses a person from another workspace, even with an admin user id', async () => {
    const { p } = provider([tokenOk(), userInfo(claimsFor('T0000000099', ADMIN))]);
    expect(await p.identify('c')).toEqual({ ok: false, reason: 'wrong_workspace' });
  });

  it.each<[string, Scripted]>([
    ['ok: false with HTTP 200', json({ ok: false, error: 'invalid_code' })],
    ['a missing access token', json({ ok: true })],
    ['an empty access token', json({ ok: true, access_token: '' })],
    ['a body that is not JSON', new Response('<html>', { status: 200 })],
    ['a non-2xx status', json({ ok: true, access_token: ACCESS_TOKEN }, 500)],
    ['a network error', new Error('socket hang up')],
    ['a timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
  ])('reports code_exchange_failed for %s from the token endpoint', async (_name, answer) => {
    const { p, calls } = provider([answer]);
    expect(await p.identify('c')).toEqual({ ok: false, reason: 'code_exchange_failed' });
    expect(calls).toHaveLength(1);
  });

  it.each<[string, Scripted]>([
    ['ok: false with HTTP 200', json({ ok: false, error: 'invalid_auth' })],
    ['a body that is not JSON', new Response('nope', { status: 200 })],
    ['a non-2xx status', json({ ok: true }, 503)],
    ['a network error', new Error('ECONNRESET')],
    ['a missing team claim', userInfo({ 'https://slack.com/user_id': ADMIN })],
    ['a missing user claim', userInfo({ 'https://slack.com/team_id': TEAM })],
    ['an empty team claim', userInfo(claimsFor('', ADMIN))],
    ['an empty user claim', userInfo(claimsFor(TEAM, ''))],
  ])('reports identity_unavailable for %s from userInfo', async (_name, answer) => {
    const { p } = provider([tokenOk(), answer]);
    expect(await p.identify('c')).toEqual({ ok: false, reason: 'identity_unavailable' });
  });

  it('never puts the access token or the client secret in an outcome', async () => {
    const answers: Scripted[][] = [
      [tokenOk(), userInfo(claimsFor(TEAM, ADMIN))],
      [tokenOk(), userInfo(claimsFor('T0000000099', ADMIN))],
      [tokenOk(), json({ ok: false })],
      [json({ ok: false })],
    ];
    for (const script of answers) {
      const { p } = provider(script);
      const text = JSON.stringify(await p.identify('c'));
      expect(text).not.toContain(ACCESS_TOKEN);
      expect(text).not.toContain(SECRET);
    }
  });
});
