import { Server, IncomingMessage, ServerResponse, createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Logger } from '../logger.js';

/**
 * HTTP interface: one `node:http` server bound to `0.0.0.0:${PORT}` with
 * explicit routing for health, readiness, status, metrics, and MCP (Section 32).
 * Optional routes (`/status`, `/metrics`, `/mcp`) return `404` when
 * their feature is disabled, indistinguishable from an unknown route, so an
 * attacker cannot discover which optional features are configured. Request,
 * header, body, method, and timeout limits are enforced and every error path
 * returns a safe JSON object — a malformed request can never crash the process.
 *
 * The status/metrics/MCP *data* is supplied by injected handlers owned by other
 * modules; this module owns routing, isolation, auth, and safety only.
 */

/** Liveness/readiness probe outcome. `ok:false` makes the endpoint return 503. */
export interface ProbeResult {
  ok: boolean;
  /** Optional failure detail (kept short; never includes content or secrets). */
  error?: string;
}

export type Probe = () => Promise<ProbeResult> | ProbeResult;

/** Opaque status snapshot returned by `/status` when authorized. */
export type StatusSnapshot = Record<string, unknown>;
export type StatusProvider = () => Promise<StatusSnapshot> | StatusSnapshot;

/** A route-level handler for the optional metrics/MCP features. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export interface HttpServerOptions {
  port: number;
  logger: Logger;
  /** Bind host (Section 32: `0.0.0.0`). */
  host?: string;
  /** SQLite liveness probe for `/livez` (Section 32.1). Default: process-alive. */
  healthProbe?: Probe;
  /** Readiness probe for `/readyz` (Section 32.2). Default: not-ready. */
  readinessProbe?: Probe;
  /** Admin bearer token; when unset, `/status` is disabled and returns 404. */
  adminToken?: string;
  /** `/status` data provider (used only when `adminToken` is set). */
  statusProvider?: StatusProvider;
  /** Enable `/metrics` (Section 32.4). Default: disabled. */
  metricsEnabled?: boolean;
  metricsHandler?: RouteHandler;
  /** MCP request path (Section 32.5, default `/mcp`). */
  mcpPath?: string;
  /** Enable the MCP endpoint. Default: disabled. */
  mcpEnabled?: boolean;
  mcpHandler?: RouteHandler;
  /** Inspector mount path (Section 32.6, default `/inspector`). */
  inspectorPath?: string;
  /** Enable the inspector surface. Default: disabled. */
  inspectorEnabled?: boolean;
  inspectorHandler?: RouteHandler;
  /**
   * OAuth discovery documents keyed by their exact path, served on `GET` when
   * `MCP_OAUTH_ENABLED` is set. Absent or empty, those paths `404` like any
   * unknown route, so a deployment without OAuth advertises nothing.
   */
  oauthMetadataRoutes?: Readonly<Record<string, unknown>>;
  /**
   * OAuth endpoint handlers keyed `"<METHOD> <path>"` (for example
   * `"GET /authorize"`). Empty or absent, those paths `404` like any unknown
   * route. Keyed by method as well as path so the sign-in endpoints can be added
   * without the router growing a branch for each one.
   */
  oauthRoutes?: Readonly<Record<string, RouteHandler>>;
  /** Whole-request timeout, ms (default 10_000). */
  requestTimeoutMs?: number;
  /** Per-header byte limit (default 16_384). */
  maxHeaderSize?: number;
  /** Maximum request body bytes for handlers that read one (default 1_048_576). */
  maxBodyBytes?: number;
}

export interface HttpServerHandle {
  readonly server: Server;
  /** Resolved local port (useful when `port: 0` was requested). */
  readonly port: number;
  /** Gracefully stop listening and close idle connections. */
  close(): Promise<void>;
}

const ALLOWED_METHODS = new Set(['GET', 'POST']);
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_HEADER_SIZE = 16_384;

/**
 * Build and start the HTTP server. Resolves on `listening`, rejects on bind
 * error. The request listener never throws to the runtime: every path is
 * wrapped so malformed input produces a JSON error response, not a crash.
 */
export function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const host = options.host ?? '0.0.0.0';
  const mcpPath = options.mcpPath ?? '/mcp';

  const server = createServer({
    maxHeaderSize: options.maxHeaderSize ?? DEFAULT_MAX_HEADER_SIZE,
  });

  server.on('request', (req, res) => {
    // Never let a handler throw reach the runtime. A thrown error after headers
    // are sent can only end the response; otherwise we send a safe 500.
    void handleRequest(req, res, options, mcpPath).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal' });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      options.logger.warn(
        { event: 'http.unhandled_error', method: req.method, path: safePathname(req.url), err: errMsg(err) },
        'http request handler threw',
      );
    });
  });

  // Malformed HTTP at the protocol level (bad request line/headers) surfaces
  // here rather than as a normal request; respond safely without crashing.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  server.headersTimeout = requestTimeout + 2_000; // > requestTimeout, per Node guidance.
  server.requestTimeout = requestTimeout;
  server.keepAliveTimeout = 5_000;

  return new Promise<HttpServerHandle>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : options.port;
      options.logger.info({ event: 'http.listening', host, port }, 'http server listening');
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, host);
  });
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').pathname.slice(0, 256);
  } catch {
    return '/';
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions,
  mcpPath: string,
): Promise<void> {
  const method = req.method ?? '';

  let pathname: string;
  try {
    pathname = new URL(req.url ?? '', 'http://localhost').pathname;
  } catch {
    sendJson(res, 400, { error: 'bad_request' });
    return;
  }

  if (!ALLOWED_METHODS.has(method)) {
    logUnmatched(options, method, pathname, req, 'method_not_allowed');
    sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, POST' });
    return;
  }

  if (method === 'GET' && pathname === '/livez') return livez(req, res, options);
  if (method === 'GET' && pathname === '/readyz') return readyz(req, res, options);
  if (method === 'GET' && pathname === '/status') return status(req, res, options);
  // Discovery documents are public by design: a client must read them *before*
  // it holds any credential, so requiring one would deadlock the sign-in flow.
  // They carry no secret — only URLs derived from the public origin.
  if (method === 'GET') {
    const document = options.oauthMetadataRoutes?.[pathname];
    if (document !== undefined) {
      sendJson(res, 200, document, { 'cache-control': 'public, max-age=300' });
      return;
    }
  }
  const oauthRoute = options.oauthRoutes?.[`${method} ${pathname}`];
  if (oauthRoute) return oauthRoute(req, res);

  if (method === 'GET' && pathname === '/metrics') {
    if (!options.metricsEnabled || !options.metricsHandler) {
      logUnmatched(options, method, pathname, req, 'feature_disabled');
      return notFound(res);
    }
    return options.metricsHandler(req, res);
  }
  // Streamable HTTP: a server without an SSE stream answers GET with 405. A
  // disabled endpoint stays a plain 404, like an unknown route.
  if (method === 'GET' && pathname === mcpPath && options.mcpEnabled && options.mcpHandler) {
    sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    return;
  }
  if (method === 'POST' && pathname === mcpPath) {
    if (!options.mcpEnabled || !options.mcpHandler) {
      logUnmatched(options, method, pathname, req, 'feature_disabled');
      return notFound(res);
    }
    return options.mcpHandler(req, res);
  }
  // Inspector (Section 32.6): the whole subtree under the mount path, GET only
  // (the handler rejects other methods itself). Disabled or unwired, the subtree
  // is indistinguishable from an unknown route — the Section 32.3 pattern.
  const inspectorPath = options.inspectorPath ?? '/inspector';
  if (pathname === inspectorPath || pathname.startsWith(`${inspectorPath}/`)) {
    if (!options.inspectorEnabled || !options.inspectorHandler) {
      logUnmatched(options, method, pathname, req, 'feature_disabled');
      return notFound(res);
    }
    return options.inspectorHandler(req, res);
  }
  logUnmatched(options, method, pathname, req, 'unknown_route');
  return notFound(res);
}

/**
 * Record a request that reached no handler, so an operator can see what an
 * external client asked for. A remote MCP client that fails to authenticate
 * probes a fixed set of OAuth discovery paths (`/.well-known/…`, `/register`)
 * before it reports a connection failure; without this record those probes are
 * invisible and the failure can only be guessed at.
 *
 * The record carries the method, the *path* only, the user agent, and which of
 * the three miss reasons applied. The query string is deliberately excluded: a
 * client that (incorrectly) puts a credential in the URL would otherwise write
 * it to the log. Headers and bodies are never read here.
 */
function logUnmatched(
  options: HttpServerOptions,
  method: string,
  pathname: string,
  req: IncomingMessage,
  reason: 'unknown_route' | 'feature_disabled' | 'method_not_allowed',
): void {
  const ua = req.headers['user-agent'];
  options.logger.info(
    {
      event: 'http.unmatched_route',
      method,
      path: pathname,
      reason,
      userAgent: typeof ua === 'string' ? ua.slice(0, 200) : null,
    },
    'http request matched no route',
  );
}

async function livez(_req: IncomingMessage, res: ServerResponse, options: HttpServerOptions): Promise<void> {
  const probe = options.healthProbe;
  if (!probe) {
    // No DB wired yet: handling the request proves the process and event loop.
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  let result: ProbeResult;
  try {
    result = await probe();
  } catch (err) {
    sendJson(res, 503, { status: 'unhealthy', error: 'probe_failed' });
    options.logger.warn({ event: 'http.livez_probe_error', err: errMsg(err) }, 'livez probe threw');
    return;
  }
  if (result.ok) {
    sendJson(res, 200, { status: 'ok' });
  } else {
    sendJson(res, 503, { status: 'unhealthy', error: result.error ?? 'unhealthy' });
  }
}

async function readyz(_req: IncomingMessage, res: ServerResponse, options: HttpServerOptions): Promise<void> {
  const probe = options.readinessProbe;
  if (!probe) {
    // Not ready until the bootstrap wires a readiness signal (Section 32.2).
    sendJson(res, 503, { status: 'not_ready' });
    return;
  }
  let result: ProbeResult;
  try {
    result = await probe();
  } catch (err) {
    sendJson(res, 503, { status: 'not_ready', error: 'probe_failed' });
    options.logger.warn({ event: 'http.readyz_probe_error', err: errMsg(err) }, 'readyz probe threw');
    return;
  }
  if (result.ok) {
    sendJson(res, 200, { status: 'ready' });
  } else {
    sendJson(res, 503, { status: 'not_ready', error: result.error ?? 'not_ready' });
  }
}

async function status(req: IncomingMessage, res: ServerResponse, options: HttpServerOptions): Promise<void> {
  // Section 32.3: a missing admin token disables the endpoint entirely; the 404
  // here is identical to the unknown-route response, so the endpoint's existence
  // is not discoverable.
  if (!options.adminToken) {
    logUnmatched(options, 'GET', '/status', req, 'feature_disabled');
    return notFound(res);
  }
  if (!bearerOk(req, options.adminToken)) {
    sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    return;
  }
  if (!options.statusProvider) {
    sendJson(res, 503, { error: 'status_unavailable' });
    return;
  }
  const snapshot = await options.statusProvider();
  sendJson(res, 200, snapshot);
}

/** Unknown route or disabled optional feature — identical response (Section 32). */
function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not_found' });
}

/**
 * Constant-time comparison of the `Authorization: Bearer <token>` header. Shared
 * by `/status` (Section 32.3) and `/metrics` (Section 32.4) so both optional
 * endpoints enforce the same admin-credential check with no duplicated logic.
 */
export function bearerOk(req: IncomingMessage, expected: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const expectedHeader = `Bearer ${expected}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expectedHeader);
  if (a.length !== b.length) {
    timingSafeEqual(b, b); // keep timing roughly uniform on length mismatch.
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Write a JSON response with hardening headers. No-op-safe if already sent. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(json);
}

/** Outcome of reading a JSON request body with a byte cap. */
export type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

/**
 * Read and JSON-parse a request body, rejecting bodies that exceed `maxBytes`
 * (413), empty bodies (400), and invalid JSON (400). Used by body-accepting
 * routes (MCP). GET routes do not read a body, so they are immune to body DoS.
 */
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<ReadJsonBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (r: ReadJsonBodyResult) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onErr);
      resolve(r);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading (removing the data listener pauses the stream) and let
        // the handler send 413; destroying the socket here would race the
        // response to the client.
        finish({ ok: false, status: 413, error: 'request_body_too_large' });
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        finish({ ok: false, status: 400, error: 'empty_body' });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(buf.toString('utf8')) });
      } catch {
        finish({ ok: false, status: 400, error: 'invalid_json' });
      }
    };
    const onErr = () => finish({ ok: false, status: 400, error: 'bad_request' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onErr);
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
