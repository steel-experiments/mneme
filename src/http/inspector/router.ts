/**
 * Inspector router: authentication, rate limiting, and dispatch (Section 32.6).
 *
 * The router is a `RouteHandler` bound by bootstrap behind the shared HTTP
 * server. Its contract with the server module:
 *
 * - The server conceals the surface when disabled (the same `404` body as an
 *   unknown route) and only forwards requests when `INSPECTOR_ENABLED=true`.
 * - Authentication resolves before method and route checks, so an
 *   unauthenticated caller cannot use a `405`/`404` difference to learn which
 *   subpaths exist; the failed-auth budget covers every rejected request.
 * - Only `GET` is honored; anything else is `405` with `Allow: GET`. No route
 *   here reads a body, sets a cookie, or writes to the database.
 *
 * Authentication follows the Section 32.5 discipline adapted in 32.6: a bearer
 * token is hashed and looked up in `inspector_tokens` (revocation and expiry
 * checked, `last_used_at_ms` touched). Failed authentications share one global
 * fixed-window budget; authenticated traffic carries a per-token budget. Both
 * budgets are global, not per-IP, for the Section 32.5.4 reason: Mneme
 * cannot see client identity behind a proxy, so a per-IP budget would be a
 * bypass, not a protection.
 *
 * The grant is recomputed per request and equals the secure review grant. No
 * route accepts a scope parameter. Views log one content-free Pino event.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../../logger.js';
import type { DatabaseSync } from '../../db/database.js';
import type { InspectorConfig } from '../../config.js';
import { type RateLimiter, createRateLimiter } from '../../mcp/rate-limit.js';
import { grantForSecureReview } from '../../production-runtime.js';
import { orgDayStartMs } from '../../agent/cooldowns.js';
import { resolveInspectorToken, INSPECTOR_UNAUTH_RATE_LIMIT_KEY } from './tokens.js';
import { getRuntimeModeOverride } from '../../runtime-state.js';
import { renderRoute, type InspectorRoute, type PageEnv, type InspectorRuntimeView } from './pages.js';
import { notFoundPage } from './html.js';

export interface InspectorRouterDeps {
  db: DatabaseSync;
  config: InspectorConfig;
  logger: Logger;
  /** Clock, injected for tests. Default: `Date.now`. */
  now?: () => number;
  /** Timezone for the org-day boundary on the overview page. */
  timezone?: string;
  /** Readiness source for the overview page; absent renders an unknown state. */
  readiness?: () => { ready: boolean; reason: string | null };
  /** Configured autonomy mode (`MNEME_MODE`); the durable override wins when set. */
  configuredMode?: string;
  /** Override limiters for tests; defaults derive from `config`. */
  tokenLimiter?: RateLimiter;
  unauthLimiter?: RateLimiter;
}

/** Bearer credential extraction; the header format is fixed. */
const BEARER_RE = /^Bearer\s+(\S+)$/i;
/** HTTP Basic credential: base64 of `user:password`. */
const BASIC_RE = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i;

/**
 * The challenge sent with every `401`. Browsers never prompt for `Bearer`, so
 * the challenge is `Basic`: a plain browser shows its login dialog, and the
 * admin pastes the token as the password. Only `Basic` is advertised, on
 * purpose. Chromium parses one `WWW-Authenticate` value as one challenge and
 * requires every parameter to be `name=value`; a second scheme appended after
 * a comma (`..., Bearer`) is read as a bare parameter, the whole challenge is
 * rejected, and no dialog appears. Command-line clients send `Bearer` without
 * needing it advertised; the server accepts both schemes.
 */
export const INSPECTOR_WWW_AUTHENTICATE = 'Basic realm="Mneme inspector", charset="UTF-8"';

/**
 * Extract the presented token from an `Authorization` header, or null when
 * the header is absent or malformed. `Bearer <token>` carries the token
 * directly. `Basic <base64>` carries it as the password (the username is
 * ignored); when the password is empty the username is taken instead, so a
 * token pasted into either field of a browser dialog works. Nothing here
 * validates the value — that is {@link resolveInspectorToken}'s job.
 */
export function presentedToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const bearer = header.match(BEARER_RE)?.[1];
  if (bearer) return bearer;
  const basic = header.match(BASIC_RE)?.[1];
  if (!basic) return null;
  const decoded = Buffer.from(basic, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return null;
  const user = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);
  const token = password.length > 0 ? password : user;
  return token.length > 0 ? token : null;
}

export function createInspectorHandler(deps: InspectorRouterDeps) {
  const now = deps.now ?? Date.now;
  const timezone = deps.timezone ?? 'UTC';
  const tokenLimiter = deps.tokenLimiter
    ?? createRateLimiter({ limit: deps.config.rateLimitPerMinute, windowMs: 60_000 });
  const unauthLimiter = deps.unauthLimiter
    ?? createRateLimiter({ limit: deps.config.unauthRateLimitPerMinute, windowMs: 60_000 });

  return function inspectorHandler(req: IncomingMessage, res: ServerResponse): void {
    void handle(req, res).catch((err) => {
      deps.logger.warn(
        { event: 'inspector.render_error', err: err instanceof Error ? err.message : String(err) },
        'inspector page render threw',
      );
      sendHtml(res, 500, errorPage(), {});
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = now();
    const method = req.method ?? '';
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }

    // ---- Authentication first ------------------------------------------------
    // Every unauthenticated request in the subtree — any method, any path,
    // known or not — gets the same 401 (or 429) and draws on the shared
    // failed-auth budget. Answering 405/404 before this gate would both spend
    // no budget and leak which subpaths exist (Section 32.6 concealment).
    const presented = presentedToken(req.headers['authorization']);
    if (!presented) {
      rejectUnauthenticated(res, pathname, startedAt, 'missing_token');
      return;
    }
    const resolved = resolveInspectorToken({ db: deps.db, nowMs: now() }, presented);
    if (resolved.kind !== 'valid') {
      rejectUnauthenticated(res, pathname, startedAt, resolved.kind);
      return;
    }

    // ---- Per-token budget ----------------------------------------------------
    const atMs = now();
    const decision = tokenLimiter.check(resolved.row.id, atMs);
    tokenLimiter.prune(atMs);
    if (!decision.allowed) {
      sendHtml(res, 429, tooManyRequestsPage(deps.config.path), {
        'retry-after': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
      });
      view(pathname, 429, resolved.row.id, startedAt);
      return;
    }

    // GET only (Section 32.6), behind the credential: the shared server
    // already rejects methods outside GET/POST with 405; POST lands here.
    if (method !== 'GET') {
      sendHtml(res, 405, methodNotAllowedPage(deps.config.path), { allow: 'GET' });
      view(pathname, 405, resolved.row.id, startedAt);
      return;
    }

    const route = parseRoute(pathname, deps.config.path, req.url ?? '');
    if (!route) {
      const html = notFoundPage(deps.config.path, 'This path');
      sendHtml(res, 404, html, {});
      view(pathname, 404, resolved.row.id, startedAt);
      return;
    }

    // ---- Render ----------------------------------------------------------------
    try {
      const nowMs = now();
      const runtime = runtimeView();
      const env: PageEnv = {
        db: deps.db,
        grant: grantForSecureReview(deps.db, ['org', 'restricted', 'review_only']),
        now: nowMs,
        dayStartMs: orgDayStartMs(nowMs, timezone),
        basePath: deps.config.path,
        ...(runtime ? { runtime } : {}),
      };
      const page = renderRoute(route, env);
      sendHtml(res, page.status, page.html, {});
      view(pathname, page.status, resolved.row.id, startedAt);
    } catch (err) {
      deps.logger.warn(
        { event: 'inspector.render_error', err: err instanceof Error ? err.message : String(err) },
        'inspector page render threw',
      );
      sendHtml(res, 500, errorPage(), {});
      view(pathname, 500, resolved.row.id, startedAt);
    }
  }

  /** Overview runtime block: readiness plus the effective mode (override wins). */
  function runtimeView(): InspectorRuntimeView | undefined {
    const readiness = deps.readiness?.() ?? null;
    const override = getRuntimeModeOverride(deps.db);
    const configured = deps.configuredMode ?? null;
    if (readiness === null && configured === null && override === null) return undefined;
    return {
      ready: readiness === null ? null : readiness.ready,
      blockingReason: readiness !== null && !readiness.ready ? readiness.reason : null,
      mode: override?.mode ?? configured,
      modeSource: override ? 'override' : configured !== null ? 'configured' : 'unknown',
    };
  }

  /** Failed authentication: one shared budget, one generic 401, one log line. */
  function rejectUnauthenticated(
    res: ServerResponse,
    pathname: string,
    startedAt: number,
    reason: string,
  ): void {
    const atMs = now();
    const decision = unauthLimiter.check(INSPECTOR_UNAUTH_RATE_LIMIT_KEY, atMs);
    unauthLimiter.prune(atMs);
    if (!decision.allowed) {
      sendHtml(res, 429, tooManyRequestsPage(deps.config.path), {
        'retry-after': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
      });
      view(pathname, 429, null, startedAt);
      return;
    }
    sendHtml(res, 401, unauthorizedPage(deps.config.path), { 'www-authenticate': INSPECTOR_WWW_AUTHENTICATE });
    // The reason is an enum: no credential material, no header echo.
    deps.logger.info(
      { event: 'inspector.auth_rejected', path: boundedPath(pathname), reason },
      'inspector authentication rejected',
    );
    view(pathname, 401, null, startedAt);
  }

  /** One content-free view log per request (path, status, token id, duration). */
  function view(pathname: string, status: number, tokenId: string | null, startedAt: number): void {
    deps.logger.info(
      {
        event: 'inspector.view',
        path: boundedPath(pathname),
        status,
        tokenId,
        durationMs: now() - startedAt,
      },
      'inspector page served',
    );
  }
}

/** Truncate the parsed pathname for logs; the query string is never logged. */
function boundedPath(pathname: string): string {
  return pathname.slice(0, 256);
}

/**
 * Map a pathname (plus its query string) under the mount path to a route, or
 * null when the subpath is unknown. Route parsing is strict: `/memories/abc`
 * is a memory id, `/memories/` with an empty id is not a route.
 */
export function parseRoute(pathname: string, basePath: string, rawUrl: string): InspectorRoute | null {
  if (pathname === basePath) return { name: 'overview' };
  if (!pathname.startsWith(`${basePath}/`)) return null;
  let query = new URLSearchParams();
  try {
    query = new URL(rawUrl, 'http://localhost').searchParams;
  } catch {
    query = new URLSearchParams();
  }
  const sub = pathname.slice(basePath.length + 1).replace(/\/+$/, '');
  const [head, ...rest] = sub.split('/');
  const tail = rest.join('/');
  switch (head) {
    // The bare mount path with a trailing slash renders the overview, matching
    // the exact mount path one segment earlier.
    case '':
      return { name: 'overview' };
    case 'memories':
      if (tail === '') {
        return {
          name: 'memories',
          q: (query.get('q') ?? '').slice(0, 200),
          type: nonEmpty(query.get('type')),
          status: nonEmpty(query.get('status')),
          sort: query.get('sort') === 'recent' ? 'recent' : 'importance',
          cursor: memoryArchiveCursor(query, query.get('sort') === 'recent' ? 'recent' : 'importance'),
        };
      }
      return {
        name: 'memory',
        id: tail.slice(0, 128),
        evidenceCursor: memoryEvidenceCursor(query),
      };
    case 'episodes': {
      if (tail === '') {
        const before = numParam(query, 'before');
        const id = query.get('id') ?? '';
        if (before !== null && id !== '') {
          return { name: 'episodes', cursor: { lastActivityAtMs: before, id } };
        }
        return { name: 'episodes', cursor: null };
      }
      return { name: 'episode', id: tail.slice(0, 128), after: numParam(query, 'after') };
    }
    case 'runs': {
      if (tail === '') {
        const before = numParam(query, 'before');
        const id = query.get('id') ?? '';
        if (before !== null && id !== '') {
          return { name: 'runs', cursor: { startedAtMs: before, id } };
        }
        return { name: 'runs', cursor: null };
      }
      return {
        name: 'run',
        id: tail.slice(0, 128),
        toolCallId: (query.get('toolCall') ?? '').slice(0, 128) || null,
        exposureAfter: numParam(query, 'exposureAfter'),
      };
    }
    case 'speech':
      return tail === ''
        ? {
            name: 'speech',
            view: query.get('view') === 'deliveries' ? 'deliveries' : 'proposals',
            cursor: descTimeCursor(query),
          }
        : null;
    case 'channels':
      if (tail !== '') return null;
      return {
        name: 'channels',
        view: query.get('view') === 'threads' ? 'threads' : 'channels',
        cursor: channelCursor(query),
      };
    case 'jobs':
      return tail === ''
        ? {
            name: 'jobs',
            cursor: descTimeCursor(query),
            status: nonEmpty(query.get('status')),
            type: nonEmpty(query.get('type')),
          }
        : null;
    case 'audit':
      return tail === '' ? { name: 'audit', cursor: descTimeCursor(query) } : null;
    case 'resolve':
      // Both documented shapes resolve: `/resolve/:id` (the spec pages table)
      // and `/resolve?id=` (the on-page form).
      return {
        name: 'resolve',
        id: (tail !== '' ? tail : (query.get('id') ?? '')).slice(0, 128),
      };
    default:
      return null;
  }
}

function nonEmpty(v: string | null): string | null {
  const trimmed = (v ?? '').trim();
  return trimmed === '' ? null : trimmed.slice(0, 64);
}

function numParam(query: URLSearchParams, key: string): number | null {
  const raw = query.get(key);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}

function channelCursor(query: URLSearchParams): Extract<InspectorRoute, { name: 'channels' }>['cursor'] {
  const deleted = numParam(query, 'afterDeleted');
  const sortName = query.get('afterName');
  const id = query.get('afterId');
  if ((deleted !== 0 && deleted !== 1) || sortName === null || sortName === '' || id === null || id === '') {
    return null;
  }
  return { deleted, sortName: sortName.slice(0, 200), id: id.slice(0, 128) };
}

function descTimeCursor(query: URLSearchParams): { createdAtMs: number; id: string } | null {
  const before = numParam(query, 'before');
  const id = query.get('id');
  return before !== null && id ? { createdAtMs: before, id: id.slice(0, 128) } : null;
}

function memoryArchiveCursor(
  query: URLSearchParams,
  sort: Extract<InspectorRoute, { name: 'memories' }>['sort'],
): Extract<InspectorRoute, { name: 'memories' }>['cursor'] {
  const importanceRaw = query.get('beforeImportance');
  const lastConfirmedAtMs = numParam(query, 'beforeConfirmed');
  const id = query.get('beforeId');
  if (lastConfirmedAtMs === null || !id) return null;
  if (sort === 'recent') return { lastConfirmedAtMs, id: id.slice(0, 128) };
  if (importanceRaw === null || importanceRaw === '') return null;
  const importance = Number(importanceRaw);
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) return null;
  return { importance, lastConfirmedAtMs, id: id.slice(0, 128) };
}

function memoryEvidenceCursor(query: URLSearchParams): Extract<InspectorRoute, { name: 'memory' }>['evidenceCursor'] {
  const createdAtMs = numParam(query, 'evidenceAfter');
  const messageId = query.get('evidenceMessage');
  const stance = query.get('evidenceStance');
  if (createdAtMs === null || !messageId || !stance) return null;
  return { createdAtMs, messageId: messageId.slice(0, 128), stance: stance.slice(0, 32) };
}

/** Write an HTML response with the Section 32.6 hardening header set. */
export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  extraHeaders: Record<string, string>,
): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(html);
}

/** Minimal pages for auth and limit outcomes; no data, fully static markup. */
function unauthorizedPage(basePath: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in required</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em;color:#1f2328}code{background:#f6f8fa;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>Mneme inspector</h1>
<p>This surface requires an inspector token. In a browser, reload and paste the token as the <strong>password</strong> in the login dialog (any username). From a command-line client, send it as a header:</p>
<p><code>Authorization: Bearer &lt;token&gt;</code></p>
<p>Tokens are issued with <code>/mneme inspector-token create</code> in the server.</p>
<p><a href="${basePath.replace(/"/g, '&quot;')}">Try again</a></p>
</body></html>`;
}

function tooManyRequestsPage(_basePath: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Too many requests</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em}</style>
</head><body>
<h1>Too many requests</h1>
<p>The inspector rate limit is in effect. Wait for the window to reset, then retry.</p>
</body></html>`;
}

function methodNotAllowedPage(_basePath: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Method not allowed</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em}</style>
</head><body>
<h1>Read only</h1>
<p>The inspector serves <code>GET</code> pages only. No inspector route mutates state.</p>
</body></html>`;
}

/** Static error page; details live in the log, never in the response. */
function errorPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Rendering failed</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em}</style>
</head><body>
<h1>Rendering failed</h1>
<p>The page could not be rendered. The failure was logged without content.</p>
</body></html>`;
}
