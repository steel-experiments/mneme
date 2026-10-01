import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createMcpServer, MCP_JSONRPC_ERROR, SUPPORTED_MCP_PROTOCOL_VERSION } from '../../src/mcp/server.js';
import { createMcpToken } from '../../src/mcp/auth.js';
import { createRateLimiter } from '../../src/mcp/rate-limit.js';
import { wwwAuthenticateChallenge } from '../../src/mcp/oauth/metadata.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';

/**
 * Stateless MCP protocol endpoint (Sections 32.5, 48; task T101).
 *
 * Acceptance — verbatim: "Protocol fixtures complete every request in one
 * response and disabled MCP is indistinguishable from an absent route."
 *
 * The suite mounts the MCP handler on the real HTTP server and drives it with
 * protocol fixtures over `fetch`: a valid request completes in one JSON-RPC
 * response (no session id), a disabled endpoint returns the same `404` as an
 * unknown route, credential failures return `401`, exhaustion returns `429`, and
 * the JSON-RPC error paths (bad envelope, unsupported protocol version, unknown
 * method, handler error) and notification (`202`) behavior all hold.
 */

const GUILD = '100000000000000001';
const ACTOR = '100000000000000003';
const HOST = '127.0.0.1';
const PATH = '/mcp';

let env: TestDb;
const servers: HttpServerHandle[] = [];

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
});

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  env.cleanup();
});

interface StartOpts {
  enabled?: boolean;
  limiter?: ReturnType<typeof createRateLimiter>;
  unauthLimiter?: ReturnType<typeof createRateLimiter>;
  methods?: Record<string, ReturnType<typeof echoMethod>>;
  wwwAuthenticate?: string;
}

function echoMethod() {
  return async (params: unknown) => ({ ok: true, result: { echo: params } }) as const;
}

function issueToken(): string {
  const o = createMcpToken({ db: env.db, nowMs: Date.now() }, { name: 't', createdByUserId: ACTOR });
  if (o.kind !== 'created') throw new Error('token not created');
  return o.token;
}

async function start(opts: StartOpts = {}): Promise<{ base: string; token: string }> {
  const mcp = createMcpServer({
    db: env.db,
    rateLimiter: opts.limiter ?? createRateLimiter({ limit: 60 }),
    unauthRateLimiter: opts.unauthLimiter,
    methods: opts.methods ?? { echo: echoMethod() },
    wwwAuthenticate: opts.wwwAuthenticate,
  });
  const handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: createLogger(),
    mcpPath: PATH,
    mcpEnabled: opts.enabled ?? true,
    mcpHandler: mcp.handler,
  });
  servers.push(handle);
  return { base: `http://${HOST}:${handle.port}`, token: issueToken() };
}

function rpc(method: string, params: unknown, id: unknown = '1', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id, ...extra });
}

async function post(base: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('disabled MCP is indistinguishable from an absent route', () => {
  it('returns the identical 404 body for a disabled endpoint, a non-POST, and an unknown path', async () => {
    const { base, token } = await start({ enabled: false });
    const disabled = await post(base, rpc('echo', {}), { authorization: `Bearer ${token}` });
    const enabledServer = await start({ enabled: true });
    const nonPost = await fetch(`${enabledServer.base}${PATH}`, { method: 'GET' });
    const unknown = await fetch(`${enabledServer.base}/nope`, { method: 'GET' });
    for (const res of [disabled, nonPost, unknown]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });
});

describe('a valid request completes in one response', () => {
  it('returns one JSON-RPC success with the result and no Mcp-Session-Id', async () => {
    const { base, token } = await start();
    const res = await post(base, rpc('echo', { hello: 'world' }), { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(await res.json()).toEqual({ jsonrpc: '2.0', result: { echo: { hello: 'world' } }, id: '1' });
  });

  it('tolerates Mcp-Method / Mcp-Name routing headers (ignored)', async () => {
    const { base, token } = await start();
    const res = await post(base, rpc('echo', 42), {
      authorization: `Bearer ${token}`,
      'mcp-method': 'tools/call',
      'mcp-name': 'search_messages',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({ echo: 42 });
  });

  it('accepts the supported protocol version via header or _meta', async () => {
    const { base, token } = await start();
    const byHeader = await post(base, rpc('echo', 1), {
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': SUPPORTED_MCP_PROTOCOL_VERSION,
    });
    expect(byHeader.status).toBe(200);
    const byMeta = await post(
      base,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'echo',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': SUPPORTED_MCP_PROTOCOL_VERSION,
          },
        },
        id: '9',
      }),
      { authorization: `Bearer ${token}` },
    );
    expect(byMeta.status).toBe(200);
  });
});

describe('authentication and rate limiting', () => {
  it('returns 401 with www-authenticate for a missing or wrong bearer', async () => {
    const { base } = await start();
    const missing = await post(base, rpc('echo', {}));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');

    const wrong = await post(base, rpc('echo', {}), { authorization: 'Bearer not-a-real-token' });
    expect(wrong.status).toBe(401);
  });

  it('carries the OAuth challenge on 401 when discovery is enabled', async () => {
    const challenge = wwwAuthenticateChallenge({
      publicBaseUrl: 'https://mneme.example',
      mcpPath: PATH,
    });
    const { base, token } = await start({ wwwAuthenticate: challenge });

    // Every credential failure returns the same challenge, so a prober cannot
    // tell a missing token from a wrong one.
    for (const headers of [{}, { authorization: 'Bearer not-a-real-token' }]) {
      const res = await post(base, rpc('echo', {}), headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(challenge);
      expect(res.headers.get('www-authenticate')).toContain(
        'resource_metadata="https://mneme.example/.well-known/oauth-protected-resource/mcp"',
      );
    }

    // A valid token is unaffected by the challenge.
    const ok = await post(base, rpc('echo', {}), { authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
  });

  it('returns 429 with retry-after once the per-token limit is exceeded', async () => {
    const { base, token } = await start({ limiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) });
    const first = await post(base, rpc('echo', {}), { authorization: `Bearer ${token}` });
    expect(first.status).toBe(200);
    const second = await post(base, rpc('echo', {}), { authorization: `Bearer ${token}` });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toMatch(/^\d+$/);
    const body = (await second.json()) as { error: string; retryAfterMs: number };
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it('returns 429 for unauthenticated requests once the failure budget is exhausted', async () => {
    const { base, token } = await start({
      unauthLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }),
    });
    const first = await post(base, rpc('echo', {}), { authorization: 'Bearer wrong-1' });
    expect(first.status).toBe(401);
    const second = await post(base, rpc('echo', {}));
    expect(second.status).toBe(401);

    const third = await post(base, rpc('echo', {}), { authorization: 'Bearer wrong-2' });
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toMatch(/^\d+$/);

    // A valid token is never throttled by the unauthenticated budget.
    const valid = await post(base, rpc('echo', {}), { authorization: `Bearer ${token}` });
    expect(valid.status).toBe(200);
  });
});

describe('transport-level body errors', () => {
  it('returns 400 for invalid JSON', async () => {
    const { base, token } = await start();
    const res = await post(base, '{not json', { authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json');
  });

  it('returns 400 for an empty body', async () => {
    const { base, token } = await start();
    const res = await post(base, '', { authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('empty_body');
  });
});

describe('JSON-RPC error paths', () => {
  async function errBody(res: Response): Promise<{ code: number; message: string }> {
    const body = (await res.json()) as { error: { code: number; message: string }; id: unknown };
    expect(res.status).toBe(200); // JSON-RPC errors travel in a 200 body.
    return body.error;
  }

  it('rejects a non-2.0 jsonrpc envelope with invalid_request', async () => {
    const { base, token } = await start();
    const res = await post(base, JSON.stringify({ jsonrpc: '1.0', method: 'echo', id: '1' }), {
      authorization: `Bearer ${token}`,
    });
    expect((await errBody(res)).code).toBe(MCP_JSONRPC_ERROR.INVALID_REQUEST);
  });

  it('rejects an unsupported protocol version', async () => {
    const { base, token } = await start();
    const res = await post(base, rpc('echo', {}), {
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': '1999-01-01',
    });
    const error = await errBody(res);
    expect(error.code).toBe(MCP_JSONRPC_ERROR.UNSUPPORTED_PROTOCOL_VERSION);
    expect(error.message).toContain('1999-01-01');
  });

  it('returns method not found for an unregistered method', async () => {
    const { base, token } = await start();
    const res = await post(base, rpc('does/not/exist', {}), { authorization: `Bearer ${token}` });
    expect((await errBody(res)).code).toBe(MCP_JSONRPC_ERROR.METHOD_NOT_FOUND);
  });

  it('returns an internal error when a handler throws', async () => {
    const { base, token } = await start({
      methods: { boom: async () => { throw new Error('boom'); } },
    });
    const res = await post(base, rpc('boom', {}), { authorization: `Bearer ${token}` });
    expect((await errBody(res)).code).toBe(MCP_JSONRPC_ERROR.INTERNAL_ERROR);
  });

  it('echoes the request id in both success and error responses', async () => {
    const { base, token } = await start();
    const ok = await (await post(base, rpc('echo', 1, 'abc'), { authorization: `Bearer ${token}` })).json();
    expect(ok).toEqual({ jsonrpc: '2.0', result: { echo: 1 }, id: 'abc' });
    const err = await (await post(base, rpc('nope', 1, 42), { authorization: `Bearer ${token}` })).json();
    expect((err as { id: number }).id).toBe(42);
  });
});

describe('notifications receive no response body', () => {
  it('returns 202 with an empty body for a request without an id', async () => {
    const { base, token } = await start();
    const res = await post(base, JSON.stringify({ jsonrpc: '2.0', method: 'echo', params: 1 }), {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('returns 202 for a notification even when the method is unknown', async () => {
    const { base, token } = await start();
    const res = await post(base, JSON.stringify({ jsonrpc: '2.0', method: 'missing' }), {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(202);
  });
});
