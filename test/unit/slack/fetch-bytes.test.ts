// ABOUTME: Tests the Slack attachment fetcher (plan 009 step 4): the bot token goes only to files.slack.com.
// ABOUTME: Covers redirects, sign-in pages, size limits, and that no error message contains the token.
import { describe, it, expect } from 'vitest';
import { createSlackFetchBytes } from '../../../src/platform/slack/fetch-bytes.js';

const TOKEN = 'xoxb-test-token-0000';
const FILE = 'https://files.slack.com/files-pri/T0000000001-F0000000001/download/plan.txt';

interface Sent { url: string; authorization: string | null; redirect: RequestInit['redirect'] }

function stub(responses: Response[]): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(input), authorization: headers.get('authorization'), redirect: init?.redirect });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const ok = (body: string, headers: Record<string, string> = { 'content-type': 'text/plain' }) =>
  new Response(body, { status: 200, headers });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

async function message(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { return (err as Error).message; }
  throw new Error('expected a rejection');
}

describe('createSlackFetchBytes', () => {
  it('sends the bearer token to files.slack.com and returns the bytes', async () => {
    const { fetchImpl, sent } = stub([ok('hello')]);
    const bytes = await createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
    expect(sent).toEqual([{ url: FILE, authorization: `Bearer ${TOKEN}`, redirect: 'manual' }]);
  });

  it.each([
    ['another host', 'https://example.com/f'],
    ['http on the file host', 'http://files.slack.com/files-pri/x'],
    ['a look-alike host', 'https://files.slack.com.evil.example/x'],
    ['a non-default port', 'https://files.slack.com:8443/x'],
    ['a sub-domain of the file host', 'https://a.files.slack.com/x'],
  ])('refuses %s before any request', async (_label, url) => {
    const { fetchImpl, sent } = stub([]);
    expect(await message(createSlackFetchBytes(TOKEN, fetchImpl)(url, 100))).toMatch(/not a Slack file url/);
    expect(sent).toEqual([]);
  });

  it('follows a redirect to a Slack edge host without the token', async () => {
    const edge = 'https://files-edge.slack-edge.com/x/plan.txt';
    const { fetchImpl, sent } = stub([redirect(edge), ok('hello')]);
    const bytes = await createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
    expect(sent.map((s) => [s.url, s.authorization])).toEqual([[FILE, `Bearer ${TOKEN}`], [edge, null]]);
  });

  it('resolves a relative redirect against the current url and keeps the token on files.slack.com', async () => {
    const { fetchImpl, sent } = stub([redirect('/files-pri/T0000000001-F0000000001/other.txt'), ok('hi')]);
    await createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100);
    expect(sent[1]).toEqual({ url: 'https://files.slack.com/files-pri/T0000000001-F0000000001/other.txt',
      authorization: `Bearer ${TOKEN}`, redirect: 'manual' });
  });

  it.each([
    ['a foreign host', 'https://evil.example/steal'],
    ['http on a Slack host', 'http://files-edge.slack-edge.com/x'],
    ['a look-alike Slack host', 'https://slack.com.evil.example/x'],
  ])('refuses a redirect to %s and sends nothing there', async (_label, location) => {
    const { fetchImpl, sent } = stub([redirect(location)]);
    expect(await message(createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100))).toMatch(/redirect to a host that is not allowed/);
    expect(sent).toHaveLength(1);
  });

  it('refuses a redirect without a location', async () => {
    const { fetchImpl } = stub([new Response(null, { status: 302 })]);
    expect(await message(createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100))).toMatch(/no location/);
  });

  it('refuses a fourth redirect', async () => {
    const hop = (n: number) => redirect(`https://files.slack.com/hop/${n}`);
    const { fetchImpl, sent } = stub([hop(1), hop(2), hop(3), hop(4)]);
    expect(await message(createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100))).toMatch(/too many redirects/);
    expect(sent).toHaveLength(4);
  });

  it('refuses an HTML page with a hint about the files:read scope', async () => {
    const { fetchImpl } = stub([ok('<html>sign in</html>', { 'content-type': 'text/html; charset=utf-8' })]);
    expect(await message(createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100))).toMatch(/HTML page; check the files:read scope/);
  });

  it('refuses a declared size above the limit', async () => {
    const { fetchImpl } = stub([ok('hello', { 'content-type': 'text/plain', 'content-length': '500' })]);
    expect(await message(createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100))).toMatch(/exceeds configured byte limit/);
  });

  it('refuses a body that passes the limit while it streams', async () => {
    const { fetchImpl } = stub([ok('x'.repeat(200))]);
    expect(await message(createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100))).toMatch(/byte limit while streaming/);
  });

  it('names the status and host, not the url query, on a failed response', async () => {
    const { fetchImpl } = stub([new Response('no', { status: 403 })]);
    const text = await message(createSlackFetchBytes(TOKEN, fetchImpl)(`${FILE}?t=secret-query`, 100));
    expect(text).toBe('attachment fetch failed: 403 files.slack.com');
  });

  it('never puts the token in an error message', async () => {
    const cases: Response[][] = [[new Response('no', { status: 401 })], [redirect('https://evil.example/x')],
      [ok('<html></html>', { 'content-type': 'text/html' })]];
    for (const responses of cases) {
      const { fetchImpl } = stub(responses);
      expect(await message(createSlackFetchBytes(TOKEN, fetchImpl)(FILE, 100))).not.toContain(TOKEN);
    }
    const throwing = (async () => { throw new Error(`socket closed for ${TOKEN}`); }) as unknown as typeof fetch;
    expect(await message(createSlackFetchBytes(TOKEN, throwing)(FILE, 100))).not.toContain(TOKEN);
  });
});
