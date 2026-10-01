import type { IncomingMessage, ServerResponse } from 'node:http';
import { type DatabaseSync } from '../db/database.js';
import { sendJson, readJsonBody, type RouteHandler } from '../http/server.js';
import { createLogger, type Logger } from '../logger.js';
import { resolveMcpRequestAuth } from './auth.js';
import type { RateLimiter } from './rate-limit.js';
import {
  MCP_JSONRPC_ERROR,
  type McpJsonRpcError,
  type McpMethodResult,
  type McpRequestContext,
  type McpMethodHandler,
} from './types.js';
import {
  mcpServerDiscoverResult,
  mcpToolsListResult,
  mcpToolCall,
  mcpGrantToRetrievalGrant,
  MCP_TOOLS,
  MCP_TOOL_LIST_TTL_MS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_INSTRUCTIONS,
} from './tools.js';
import { APP_VERSION } from '../version.js';

// Re-exported here so the public API of this module is unchanged: the error
// codes, the JSON-RPC error/result shapes, the per-request context, and the
// method-handler signature all live in ./types.js (shared with tools.js).
export {
  MCP_JSONRPC_ERROR,
  type McpJsonRpcError,
  type McpMethodResult,
  type McpRequestContext,
  type McpMethodHandler,
} from './types.js';

/**
 * Stateless MCP protocol endpoint (Sections 32.5, 48; task T101).
 *
 * Serves the MCP 2026-07-28 *stateless streamable HTTP* transport on the existing
 * `node:http` server at `MCP_PATH` (default `/mcp`): every request is a
 * self-contained JSON-RPC 2.0 message that completes in a single response. It also
 * implements the legacy `initialize` lifecycle used by clients that have not yet
 * adopted 2026-07-28 discovery. Neither profile requires `Mcp-Session-Id` or a
 * held-open stream;
 * `Mcp-Method` / `Mcp-Name` routing headers are tolerated and ignored (Mneme
 * sits behind at most one reverse proxy). When `MCP_ENABLED` is false the HTTP
 * layer returns `404` before this handler is ever called, so a disabled endpoint
 * is indistinguishable from an absent route.
 *
 * This module is the protocol layer only. Authentication + per-token rate limiting
 * (401 / 429) come from {@link resolveMcpRequestAuth}; the JSON-RPC method
 * handlers — `server/discover`, `tools/list`, `tools/call` — are registered by the
 * later tasks (T102 discovery/listing, T103/T104 tools) via {@link McpServer.method}
 * or the `methods` option. Until a method is registered, unknown methods yield the
 * standard JSON-RPC `method not found` error. The handler never logs request
 * params or results; privacy-safe request auditing is added separately (T105).
 */

/** The single MCP protocol version this server speaks (Section 32.5.1). */
export const SUPPORTED_MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSION;

/** Initialize-capable protocol revisions supported for compatibility clients. */
export const MCP_INITIALIZE_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
] as const;

/** Version selected when an initialize client requests an unknown revision. */
export const MCP_DEFAULT_INITIALIZE_PROTOCOL_VERSION = '2025-11-25' as const;

const ALL_SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  ...MCP_INITIALIZE_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
]);

/** Default request-body cap (matches the HTTP server default). */
export const MCP_DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface McpServerOptions {
  db: DatabaseSync;
  rateLimiter: RateLimiter;
  /**
   * Global limiter for failed authentications (Section 32.5.4). Consumed only on
   * auth failure; once exhausted, failures return `429` instead of `401`. When
   * omitted, unauthenticated requests are not rate limited.
   */
  unauthRateLimiter?: RateLimiter;
  now?: () => number;
  maxBodyBytes?: number;
  /** `tools/list` cache hint override (default 300000 ms, Section 32.5.1). */
  toolListTtlMs?: number;
  /** Additional method handlers (T103/T104 register `tools/call`). */
  methods?: Record<string, McpMethodHandler>;
  /**
   * Privacy-safe audit sink invoked once per request (Section 32.5.4: "every
   * request is logged with token ID, tool name, result count, and duration;
   * content is never logged"). When omitted, records are written to the default
   * logger (or {@link McpServerOptions.logger} when supplied).
   */
  audit?: McpAuditSink;
  /** Logger for the default audit sink; a fresh logger is created when omitted. */
  logger?: Logger;
  /**
   * `WWW-Authenticate` value sent with every `401`. Defaults to a bare `Bearer`,
   * which tells a client only that a token is wanted. When OAuth discovery is
   * enabled the caller supplies the RFC 9728 challenge instead, whose
   * `resource_metadata` parameter names the document that starts the sign-in
   * chain — the difference between a client that can authorize and one that can
   * only fail.
   */
  wwwAuthenticate?: string;
}

export interface McpServer {
  /** The `RouteHandler` the HTTP server mounts at `MCP_PATH`. */
  handler: RouteHandler;
  /** Register an additional method handler at runtime. */
  method(name: string, handler: McpMethodHandler): void;
}

/**
 * The coarse outcome category for one audited request (Section 32.5.4). These are
 * status buckets, not HTTP codes — they let an operator see the *shape* of traffic
 * (auth failures, rate limiting, malformed envelopes, unknown methods/tools,
 * protocol mismatches, server errors, successes) without any message content.
 */
export type McpAuditStatus =
  | 'ok'
  | 'unauthenticated'
  | 'rate_limited'
  | 'malformed'
  | 'unknown_method'
  | 'unknown_tool'
  | 'bad_params'
  | 'protocol'
  | 'error';

/**
 * One record written per MCP request (Section 32.5.4). The fields are exactly the
 * privacy-safe metadata the spec permits: the resolved token id (never the
 * plaintext), the method/tool name, a coarse status, the result count reported by
 * the tool handler, and the wall-clock duration. There is deliberately no field
 * for query strings, request params, the Authorization header, or message
 * content — none of those travel through the audit path.
 */
export interface McpAuditRecord {
  readonly event: 'mcp.request';
  /** Which of the three auth outcomes the request reached. */
  readonly authOutcome: 'authenticated' | 'unauthenticated' | 'rate_limited';
  /** Authenticated token id; null when auth failed before a token was resolved. */
  readonly tokenId: string | null;
  /** The JSON-RPC method name; null when the envelope could not be parsed. */
  readonly method: string | null;
  /** The tool name for `tools/call`; null otherwise (and for malformed calls). */
  readonly toolName: string | null;
  readonly status: McpAuditStatus;
  /** Result count the handler reported (via `auditCount`); 0 for non-result paths. */
  readonly resultCount: number;
  readonly durationMs: number;
}

/** Sink for {@link McpAuditRecord}; defaults to the structured logger. */
export type McpAuditSink = (record: McpAuditRecord) => void;

type JsonRpcId = string | number | null;

/**
 * Build the MCP server. The returned {@link McpServer.handler} authenticates and
 * rate-limits every request (no body read for unauthenticated clients), parses the
 * JSON-RPC envelope, validates the protocol version, dispatches to the registered
 * method, and writes exactly one response — a JSON-RPC result/error for requests,
 * or `202` with no body for notifications.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const toolListTtlMs = options.toolListTtlMs ?? MCP_TOOL_LIST_TTL_MS;
  // Built-in protocol methods (Section 32.5.1): capability enumeration, the
  // cached tool listing, and `tools/call` execution. The `tools/call` handler
  // maps the token's grant to the same RetrievalGrant the agent-run tools use
  // (Section 32.5.3 — no second query path to audit) and dispatches to the
  // registered tool handlers. Callers may override any of these via `methods`.
  // `server/discover` and `tools/list` report a fixed result count to the audit
  // layer via `auditCount` so the count column is populated for built-ins too.
  const methods: Record<string, McpMethodHandler> = {
    initialize: (params) => initializeResult(params),
    'notifications/initialized': () => ({ ok: true, result: {} }),
    ping: () => ({ ok: true, result: {} }),
    'server/discover': () => ({
      ok: true,
      result: mcpServerDiscoverResult(toolListTtlMs),
      auditCount: 1,
    }),
    'tools/list': () => ({
      ok: true,
      result: mcpToolsListResult(toolListTtlMs),
      auditCount: MCP_TOOLS.length,
    }),
    'tools/call': async (params, ctx) =>
      mcpToolCall(params, {
        grant: mcpGrantToRetrievalGrant(ctx.grant),
        db: ctx.db,
        nowMs: ctx.nowMs,
      }),
    ...options.methods,
  };
  const maxBodyBytes = options.maxBodyBytes ?? MCP_DEFAULT_MAX_BODY_BYTES;
  // Exactly one audit record is written per request (Section 32.5.4). When the
  // caller injects a sink (tests), records go there; otherwise they go to the
  // supplied logger, or a fresh structured logger with the mandatory redaction.
  const audit: McpAuditSink = options.audit ?? defaultAuditSink(options.logger);
  const wwwAuthenticate = options.wwwAuthenticate ?? 'Bearer';

  const handler: RouteHandler = async (req, res) => {
    const startMs = (options.now ?? Date.now)();
    // Audit state, defaulted so the finally block always has a record to write
    // even on early return or an unexpected throw. `method`/`toolName` stay null
    // until the envelope is parsed; `tokenId` stays null until a token resolves.
    let authOutcome: McpAuditRecord['authOutcome'] = 'unauthenticated';
    let tokenId: string | null = null;
    let methodName: string | null = null;
    let toolName: string | null = null;
    let status: McpAuditStatus = 'error';
    let resultCount = 0;

    try {
      const nowMs = (options.now ?? Date.now)();

      // 1. Authenticate + rate-limit before reading any body (Section 32.5.2/32.5.4).
      const auth = resolveMcpRequestAuth(
        {
          db: options.db,
          nowMs,
          rateLimiter: options.rateLimiter,
          unauthRateLimiter: options.unauthRateLimiter,
        },
        { authorizationHeader: req.headers.authorization },
      );
      if (auth.kind === 'unauthenticated') {
        status = 'unauthenticated';
        sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': wwwAuthenticate });
        return;
      }
      if (auth.kind === 'rate_limited') {
        authOutcome = 'rate_limited';
        tokenId = auth.tokenId;
        status = 'rate_limited';
        const retryAfterSec = Math.max(1, Math.ceil(auth.retryAfterMs / 1000));
        sendJson(
          res,
          429,
          { error: 'rate_limited', retryAfterMs: auth.retryAfterMs },
          { 'retry-after': String(retryAfterSec) },
        );
        return;
      }
      authOutcome = 'authenticated';
      tokenId = auth.tokenId;

      // 2. Read + parse the JSON body.
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        status = 'malformed';
        sendJson(res, body.status, { error: body.error });
        return;
      }

      // 3. Validate the JSON-RPC 2.0 envelope.
      const envelope = parseEnvelope(body.value);
      if (envelope.kind === 'error') {
        status = 'malformed';
        respond(res, envelope.id, envelope.error);
        return;
      }
      const { request, id, isNotification } = envelope;
      methodName = typeof request.method === 'string' ? request.method.slice(0, 128) : null;
      if (
        methodName === 'tools/call' &&
        isPlainObject(request.params) &&
        typeof request.params.name === 'string'
      ) {
        toolName = request.params.name.slice(0, 128);
      }

      // 4. Validate the protocol version when one is supplied (header or _meta).
      const version = extractProtocolVersion(req, request);
      if (version !== null && !ALL_SUPPORTED_PROTOCOL_VERSIONS.has(version)) {
        status = 'protocol';
        if (isNotification) return accepted(res);
        respond(res, id, {
          code: MCP_JSONRPC_ERROR.UNSUPPORTED_PROTOCOL_VERSION,
          message: `Unsupported protocol version: ${version}`,
          data: {
            supported: [
              ...MCP_INITIALIZE_PROTOCOL_VERSIONS,
              SUPPORTED_MCP_PROTOCOL_VERSION,
            ],
          },
        });
        return;
      }

      // 5. Dispatch (tolerate Mcp-Method / Mcp-Name routing headers by ignoring them).
      const name = String(request.method);
      const ctx: McpRequestContext = { tokenId: auth.tokenId, grant: auth.grant, db: options.db, nowMs };
      const run = methods[name];
      if (!run) {
        status = 'unknown_method';
        if (isNotification) return accepted(res);
        respond(res, id, {
          code: MCP_JSONRPC_ERROR.METHOD_NOT_FOUND,
          message: `Method not found: ${name}`,
        });
        return;
      }

      let outcome: McpMethodResult;
      try {
        outcome = await run(request.params, ctx);
      } catch {
        status = 'error';
        if (isNotification) return accepted(res);
        respond(res, id, { code: MCP_JSONRPC_ERROR.INTERNAL_ERROR, message: 'internal error' });
        return;
      }
      if (outcome.ok) {
        status = 'ok';
        resultCount = outcome.auditCount ?? 0;
        if (isNotification) return accepted(res);
        sendJson(res, 200, { jsonrpc: '2.0', result: outcome.result, id });
        return;
      }
      status = errorStatus(outcome.error.code, name);
      if (isNotification) return accepted(res);
      respond(res, id, outcome.error);
    } finally {
      audit({
        event: 'mcp.request',
        authOutcome,
        tokenId,
        method: methodName,
        toolName,
        status,
        resultCount,
        durationMs: (options.now ?? Date.now)() - startMs,
      });
    }
  };

  return {
    handler,
    method: (name, h) => {
      methods[name] = h;
    },
  };
}

/** Build the legacy initialization response expected by current off-the-shelf clients. */
function initializeResult(params: unknown): McpMethodResult {
  if (!isPlainObject(params) || typeof params.protocolVersion !== 'string') {
    return {
      ok: false,
      error: {
        code: MCP_JSONRPC_ERROR.INVALID_PARAMS,
        message: 'initialize requires params.protocolVersion',
      },
    };
  }
  const requested = params.protocolVersion;
  const protocolVersion = (MCP_INITIALIZE_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_DEFAULT_INITIALIZE_PROTOCOL_VERSION;
  return {
    ok: true,
    result: {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: APP_VERSION },
      instructions: MCP_INSTRUCTIONS,
    },
    auditCount: 1,
  };
}

/**
 * Map a JSON-RPC error code (returned by a tool/method handler) to the coarse
 * audit status. `tools/call` failing with `method not found` means the tool name
 * was unknown — `unknown_tool` — while the same code on any other method means
 * the method itself was unknown.
 */
function errorStatus(code: number, methodName: string): McpAuditStatus {
  if (code === MCP_JSONRPC_ERROR.INVALID_PARAMS) return 'bad_params';
  if (code === MCP_JSONRPC_ERROR.METHOD_NOT_FOUND) {
    return methodName === 'tools/call' ? 'unknown_tool' : 'unknown_method';
  }
  if (code === MCP_JSONRPC_ERROR.UNSUPPORTED_PROTOCOL_VERSION) return 'protocol';
  return 'error';
}

/**
 * The default audit sink: writes each record to the structured logger as
 * privacy-safe fields only (Section 33). The field list is enumerated explicitly
 * so nothing from the request — not the query string, not the Authorization
 * header, not message content or params — can reach the log line via this path.
 */
function defaultAuditSink(logger?: Logger): McpAuditSink {
  const log = logger ?? createLogger();
  return (rec) => {
    log.info({
      event: rec.event,
      mcpAuthOutcome: rec.authOutcome,
      mcpTokenId: rec.tokenId,
      mcpMethod: rec.method,
      mcpTool: rec.toolName,
      mcpStatus: rec.status,
      mcpResultCount: rec.resultCount,
      durationMs: rec.durationMs,
    });
  };
}

/** A JSON-RPC 2.0 id is a string, number, or null. */
function isValidId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number' || value === null;
}

interface ParsedRequest {
  method: unknown;
  params: unknown;
  _meta: unknown;
}

type EnvelopeResult =
  | { kind: 'ok'; request: ParsedRequest; id: JsonRpcId; isNotification: boolean }
  | { kind: 'error'; id: JsonRpcId; error: McpJsonRpcError };

/** Validate a parsed value as a JSON-RPC 2.0 request or notification. */
function parseEnvelope(value: unknown): EnvelopeResult {
  if (!isPlainObject(value)) {
    return invalid(null, 'Invalid Request');
  }
  const { jsonrpc, method, params, _meta } = value;
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id');
  const idRaw = value.id;

  if (jsonrpc !== undefined && jsonrpc !== '2.0') {
    return invalid(isValidId(idRaw) ? idRaw : null, 'Invalid Request: jsonrpc must be "2.0"');
  }
  if (typeof method !== 'string' || method.length === 0) {
    return invalid(isValidId(idRaw) ? idRaw : null, 'Invalid Request: method is required');
  }
  if (hasId && !isValidId(idRaw)) {
    return invalid(null, 'Invalid Request: id must be a string, number, or null');
  }
  return {
    kind: 'ok',
    request: { method, params, _meta },
    id: hasId ? (idRaw as JsonRpcId) : null,
    isNotification: !hasId,
  };
}

/** Extract the protocol version from the `MCP-Protocol-Version` header or `_meta`. */
function extractProtocolVersion(req: IncomingMessage, request: ParsedRequest): string | null {
  const header = req.headers['mcp-protocol-version'];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  const topMeta = isPlainObject(request._meta) ? request._meta : null;
  const topVersion = topMeta?.['io.modelcontextprotocol/protocolVersion'] ?? topMeta?.protocolVersion;
  if (typeof topVersion === 'string') return topVersion;
  if (isPlainObject(request.params)) {
    const paramMeta = isPlainObject(request.params._meta) ? request.params._meta : null;
    const paramVersion =
      paramMeta?.['io.modelcontextprotocol/protocolVersion'] ?? paramMeta?.protocolVersion;
    if (typeof paramVersion === 'string') return paramVersion;
  }
  return null;
}

/** Write a JSON-RPC error response (HTTP 200; the error is in the body). */
function respond(res: ServerResponse, id: JsonRpcId, error: McpJsonRpcError): void {
  sendJson(res, 200, { jsonrpc: '2.0', error, id });
}

/** Write a `202 Accepted` with no body, for notifications (no JSON-RPC response). */
function accepted(res: ServerResponse): void {
  res.writeHead(202, { 'content-length': '0' });
  res.end();
}

function invalid(id: JsonRpcId, message: string): EnvelopeResult {
  return { kind: 'error', id, error: { code: MCP_JSONRPC_ERROR.INVALID_REQUEST, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
