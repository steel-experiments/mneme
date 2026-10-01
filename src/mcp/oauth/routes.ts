// ABOUTME: HTTP handlers for the MCP OAuth endpoints, mounted on the existing server.
// ABOUTME: Turns the pure authorization decision into a redirect, a page, or a log line.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { type DatabaseSync } from '../../db/database.js';
import { createLoginSession } from '../../db/repositories/oauth-flows.js';
import type { Logger } from '../../logger.js';
import type { RouteHandler } from '../../http/server.js';
import {
  DISCORD_CALLBACK_PATH,
  discordAuthorizationUrl,
  errorRedirectUrl,
  planAuthorization,
  type AuthorizationContext,
  type AuthorizationRequest,
} from './authorize.js';
import { completeSignIn, successRedirectUrl } from './callback.js';
import { exchangeToken } from './token.js';
import type { DiscordIdentityClient } from '../../platform/discord/oauth-identity.js';
import type { RateLimiter } from '../rate-limit.js';
import {
  purgeExpiredAuthorizationCodes,
  purgeExpiredOAuthAccessTokens,
  purgeExpiredLoginSessions,
  purgeExpiredRefreshTokens,
} from '../../db/repositories/oauth-flows.js';

/**
 * HTTP surface of the MCP sign-in flow (Section 32.5.2, amended).
 *
 * The decisions live in {@link ./authorize.js}; this module only performs them.
 * Keeping the split means the security-relevant branches are tested as values
 * rather than through a socket, and this file stays small enough to audit for the
 * one thing it must never do: put a credential, an authorization code, or a
 * `state` value into a log line.
 */

export interface OAuthRouteDeps {
  db: DatabaseSync;
  logger: Logger;
  now: () => number;
  context: AuthorizationContext;
  /** The identity provider seam; tests inject a fake so no network is touched. */
  identity: DiscordIdentityClient;
  /** Roles that may sign in — the same gate as `/mneme mcp-token create`. */
  adminRoleIds: readonly string[];
  /** Shared global budget for unauthenticated MCP and OAuth traffic. */
  rateLimiter: RateLimiter;
}

/**
 * Build the OAuth route table, keyed `"<METHOD> <path>"` for the HTTP server to
 * dispatch on. Later endpoints join this map rather than the core router, so the
 * router keeps one line of OAuth awareness regardless of how many endpoints exist.
 */
export function createOAuthRoutes(deps: OAuthRouteDeps): Record<string, RouteHandler> {
  return {
    'GET /authorize': authorizeHandler(deps),
    [`GET ${DISCORD_CALLBACK_PATH}`]: discordCallbackHandler(deps),
    'POST /token': tokenHandler(deps),
  };
}

/**
 * `POST /token`. Trades an authorization code or a refresh token for access.
 *
 * The body is `application/x-www-form-urlencoded` (RFC 6749 Section 4.1.3) — not
 * JSON. Claude sends both the initial exchange and every refresh this way, so a
 * JSON-only parser here would answer `415` and break the connector.
 */
function tokenHandler(deps: OAuthRouteDeps): RouteHandler {
  return async (req, res) => {
    if (!admitOAuthRequest(deps, res)) return;
    purgeExpiredOAuthFlows(deps);
    const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/x-www-form-urlencoded') {
      sendTokenJson(res, 415, { error: 'invalid_request', error_description: 'form encoding required' });
      return;
    }
    const raw = await readFormBody(req, MAX_TOKEN_BODY_BYTES);
    if (raw === null) {
      sendTokenJson(res, 400, { error: 'invalid_request', error_description: 'malformed body' });
      return;
    }
    const form = new URLSearchParams(raw);
    const outcome = exchangeToken(
      { db: deps.db, clientId: deps.context.client.clientId, nowMs: deps.now() },
      {
        grantType: form.get('grant_type') ?? undefined,
        code: form.get('code') ?? undefined,
        redirectUri: form.get('redirect_uri') ?? undefined,
        codeVerifier: form.get('code_verifier') ?? undefined,
        refreshToken: form.get('refresh_token') ?? undefined,
        clientId: form.get('client_id') ?? undefined,
      },
    );

    if (!outcome.ok) {
      // The grant type is safe to record; no field of the request body is.
      deps.logger.info(
        { event: 'mcp.oauth.token_rejected', oauthError: outcome.error.body.error },
        'token request rejected',
      );
      sendTokenJson(res, outcome.error.status, outcome.error.body);
      return;
    }
    deps.logger.info(
      { event: 'mcp.oauth.token_issued', expiresIn: outcome.response.expires_in },
      'access token issued',
    );
    sendTokenJson(res, 200, outcome.response);
  };
}

/** A token request is a handful of short fields; anything larger is not one. */
const MAX_TOKEN_BODY_BYTES = 8_192;

/**
 * Read a form-encoded body, capped. Returns null on an oversized body or a
 * transport error, which the caller reports as a malformed request.
 */
function readFormBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) finish(null);
      else chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
  });
}

/**
 * Write a token-endpoint response. `no-store` is required by RFC 6749
 * Section 5.1: the body holds a credential and must not be cached anywhere.
 */
function sendTokenJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

/**
 * `GET /oauth/discord/callback`. Discord returns the person here; Mneme
 * decides from their guild roles and, on approval, redirects a single-use
 * authorization code to the client that started the flow.
 */
function discordCallbackHandler(deps: OAuthRouteDeps): RouteHandler {
  return async (req, res) => {
    if (!admitOAuthRequest(deps, res)) return;
    purgeExpiredOAuthFlows(deps);
    const query = parseQuery(req);
    const outcome = await completeSignIn(
      {
        db: deps.db,
        identity: deps.identity,
        adminRoleIds: deps.adminRoleIds,
        issuer: deps.context.publicBaseUrl,
        nowMs: deps.now(),
      },
      {
        code: query.get('code') ?? undefined,
        state: query.get('state') ?? undefined,
        error: query.get('error') ?? undefined,
      },
    );

    if (outcome.kind === 'terminal_error') {
      deps.logger.info(
        { event: 'mcp.oauth.callback_unresolved' },
        'discord returned for a sign-in that no longer exists',
      );
      sendHtml(res, outcome.status, 'Sign-in expired', outcome.description);
      return;
    }

    if (outcome.kind === 'redirect_error') {
      // The refusal reason is for the operator; the client is told only
      // access_denied, so nobody can probe guild membership through this.
      deps.logger.info(
        { event: 'mcp.oauth.sign_in_refused', refusal: outcome.refusal },
        'sign-in refused',
      );
      redirect(res, errorRedirectUrl(outcome, deps.context.publicBaseUrl));
      return;
    }

    // The subject id is a Discord user id, which the database already holds
    // everywhere; the code itself is a live credential and is never logged.
    deps.logger.info(
      { event: 'mcp.oauth.sign_in_granted', subjectUserId: outcome.subjectUserId },
      'authorization code issued',
    );
    redirect(res, successRedirectUrl(outcome, deps.context.publicBaseUrl));
  };
}

/**
 * `GET /authorize`. Validates the request, records it, and sends the person to
 * Discord to prove who they are. Nothing here writes a session cookie: the flow
 * is resumed by the opaque handle Discord echoes back, not by browser state.
 */
function authorizeHandler(deps: OAuthRouteDeps): RouteHandler {
  return (req, res) => {
    if (!admitOAuthRequest(deps, res)) return;
    purgeExpiredOAuthFlows(deps);
    const query = parseQuery(req);
    const plan = planAuthorization(deps.context, readAuthorizationRequest(query));

    if (plan.kind === 'terminal_error') {
      // No trustworthy redirect exists, so the person is told directly. Sending
      // this to a client-supplied address would make the endpoint an open
      // redirector (OAuth 2.1 Section 4.1.2.1).
      deps.logger.warn(
        { event: 'mcp.oauth.authorize_rejected', oauthError: plan.error },
        'authorization request rejected before a redirect could be trusted',
      );
      sendHtml(res, plan.status, 'Sign-in request rejected', plan.description);
      return;
    }

    if (plan.kind === 'redirect_error') {
      deps.logger.info(
        { event: 'mcp.oauth.authorize_error', oauthError: plan.error },
        'authorization request returned an error to the client',
      );
      redirect(res, errorRedirectUrl(plan, deps.context.publicBaseUrl));
      return;
    }

    const session = createLoginSession(deps.db, {
      clientId: deps.context.client.clientId,
      redirectUri: plan.redirectUri,
      clientState: plan.clientState,
      codeChallenge: plan.codeChallenge,
      resource: plan.resource,
      scope: plan.scope,
      createdAtMs: deps.now(),
    });
    // The session id is a live handle to a pending sign-in and the client's
    // `state` is the client's own secret-ish value; neither belongs in a log.
    deps.logger.info(
      { event: 'mcp.oauth.authorize_started', scope: plan.scope },
      'authorization request accepted, handing off to discord',
    );
    redirect(res, discordAuthorizationUrl(deps.context, session.id));
  };
}

function admitOAuthRequest(deps: OAuthRouteDeps, res: ServerResponse): boolean {
  const decision = deps.rateLimiter.check('mcp-unauthenticated', deps.now());
  if (decision.allowed) return true;
  const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  const body = JSON.stringify({ error: 'rate_limited' });
  res.writeHead(429, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'retry-after': String(retryAfter),
  });
  res.end(body);
  return false;
}

function purgeExpiredOAuthFlows(deps: OAuthRouteDeps): void {
  const now = deps.now();
  purgeExpiredLoginSessions(deps.db, now);
  purgeExpiredAuthorizationCodes(deps.db, now);
  purgeExpiredOAuthAccessTokens(deps.db, now);
  purgeExpiredRefreshTokens(deps.db, now);
}

/** Read the authorization parameters out of the parsed query string. */
function readAuthorizationRequest(query: URLSearchParams): AuthorizationRequest {
  const get = (name: string): string | undefined => query.get(name) ?? undefined;
  return {
    responseType: get('response_type'),
    clientId: get('client_id'),
    redirectUri: get('redirect_uri'),
    codeChallenge: get('code_challenge'),
    codeChallengeMethod: get('code_challenge_method'),
    scope: get('scope'),
    state: get('state'),
    resource: get('resource'),
  };
}

/** Parse a request's query string, tolerating a malformed URL as "no parameters". */
function parseQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Send a `302`. `cache-control: no-store` matters here: a cached redirect would
 * re-send a later visitor into a stale, already-consumed sign-in.
 */
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    'content-length': '0',
    'referrer-policy': 'no-referrer',
  });
  res.end();
}

/**
 * Render a minimal page for a human who cannot be redirected anywhere safe. The
 * message is escaped: it is assembled from fixed strings today, and escaping
 * keeps that safe if a future caller ever includes request-derived text.
 */
function sendHtml(res: ServerResponse, status: number, title: string, detail: string): void {
  const body =
    `<!doctype html><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<main style="font:16px/1.5 system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(detail)}</p>` +
    `<p>Close this window and check the connector settings.</p></main>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
