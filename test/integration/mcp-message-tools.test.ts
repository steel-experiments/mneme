import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createMcpServer, MCP_JSONRPC_ERROR } from '../../src/mcp/server.js';
import {
  MCP_UNTRUSTED_CONTENT_NOTE,
  MCP_TOOL_HANDLERS,
  MCP_ARCHIVE_TOOL_NAMES,
  MCP_TOOL_NAMES,
} from '../../src/mcp/tools.js';
import { createMcpToken } from '../../src/mcp/auth.js';
import { createRateLimiter } from '../../src/mcp/rate-limit.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';

/**
 * MCP message tools through the scoped repositories (Sections 7.3, 22.1, 22.2,
 * 32.5.3; task T103).
 *
 * Acceptance — verbatim: "Tool results are scoped to the token grant and a
 * request without a grant receives nothing broader."
 *
 * The suite mounts the MCP endpoint on the real HTTP server and drives
 * `tools/call` (`search_messages`, `get_message_context`) over `fetch` with two
 * tokens — an `org`-scope token and an `org_plus_channels` token granting one
 * restricted channel — against a database seeded with one message per visibility
 * class. It proves the tools read through the SAME scoped repositories as the
 * agent-run tools (no second path): the org token sees only org content, the
 * channel token additionally sees its granted restricted channel and that
 * channel's thread, and neither ever sees `review_only` or `excluded` content.
 * An out-of-scope `get_message_context` returns the generic rejection (no
 * oracle), and every message result carries the `_meta` untrusted-content note.
 */

const GUILD = '100000000000000001';
const ACTOR = '100000000000000003';
const USER = '100000000000000003';
const HOST = '127.0.0.1';
const PATH = '/mcp';
const NOW = 1_700_000_001_000;

// Channel ids carry their visibility class for readability.
const ORG = 'org-channel-1';
const RA = 'restricted-A';
const RB = 'restricted-B';
const REV = 'review-only-1';
const EXC = 'excluded-1';
const THREAD_A = 'thread-under-A';

type Vis = 'org' | 'restricted' | 'review_only' | 'excluded';

let env: TestDb;
const servers: HttpServerHandle[] = [];

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
  // seedIdentity creates a default restricted channel 100000000000000002; the
  // explicit seedChannel calls below add the visibility-class fixtures used here.
  seedChannel(ORG, 'org');
  seedChannel(RA, 'restricted');
  seedChannel(RB, 'restricted');
  seedChannel(REV, 'review_only');
  seedChannel(EXC, 'excluded');
  seedChannel(THREAD_A, 'restricted', { parent: RA, isThread: true });

  addMessage('m-org', ORG, 'Onboarding trial launched today.');
  addMessage('m-ra', RA, 'Onboarding trial approval needs sign-off.');
  addMessage('m-rb', RB, 'Onboarding trial metrics look weak.');
  addMessage('m-rev', REV, 'Onboarding trial flagged for review.');
  addMessage('m-exc', EXC, 'Onboarding trial excluded discussion.');
  addMessage('m-thread', THREAD_A, 'Onboarding trial thread detail.');
  // A chronologically earlier message in RA, to exercise context ordering.
  addMessage('m-ra-before', RA, 'Earlier onboarding trial note.', NOW - 1000);
  addMessage('m-ra-reply', RA, 'Acknowledged in a direct reply.', NOW + 1000, 'm-ra');
});

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  env.cleanup();
});

function seedChannel(
  id: string,
  visibility: Vis,
  opts: { parent?: string; isThread?: boolean } = {},
): void {
  upsertChannel(env.db, {
    id,
    guildId: GUILD,
    parentId: opts.parent ?? null,
    kind: opts.isThread ? 'thread' : 'text',
    name: id,
    topic: null,
    position: null,
    isThread: opts.isThread ?? false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: visibility,
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  });
}

function addMessage(
  id: string,
  channel: string,
  content: string,
  atMs = NOW,
  replyToMessageId: string | null = null,
): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: channel,
    authorId: USER,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: atMs,
    editedAtMs: null,
    replyToMessageId,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: atMs,
    updatedAtMs: atMs,
  });
}

async function start(): Promise<{ base: string; orgToken: string; channelToken: string }> {
  const mcp = createMcpServer({
    db: env.db,
    rateLimiter: createRateLimiter({ limit: 60 }),
  });
  const handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: createLogger(),
    mcpPath: PATH,
    mcpEnabled: true,
    mcpHandler: mcp.handler,
  });
  servers.push(handle);

  const org = createMcpToken({ db: env.db, nowMs: Date.now() }, { name: 'org', createdByUserId: ACTOR });
  if (org.kind !== 'created') throw new Error('org token not created');
  const ch = createMcpToken(
    { db: env.db, nowMs: Date.now() },
    { name: 'channel', scopeType: 'org_plus_channels', channelIds: [RA], createdByUserId: ACTOR },
  );
  if (ch.kind !== 'created') throw new Error('channel token not created');

  return {
    base: `http://${HOST}:${handle.port}`,
    orgToken: org.token,
    channelToken: ch.token,
  };
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = '1',
): Promise<CallResult> {
  const res = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function textOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join('\n');
}

function idsIn(text: string): Set<string> {
  // Each rendered line begins with [messageId]; collect those ids.
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^\[([^\]]+)\]/.exec(line);
    if (m && m[1]) ids.add(m[1]);
  }
  return ids;
}

describe('tools/call message tools are scoped to the token grant', () => {
  it('list_recent_messages gives an org token a newest-first org-wide time window', async () => {
    addMessage('m-org-newest', ORG, 'A recent update with no shared search term.', NOW + 2_000);
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'list_recent_messages', {
      after: new Date(NOW - 1).toISOString(),
      before: new Date(NOW + 3_000).toISOString(),
      limit: 20,
    });
    expect(body.error).toBeUndefined();
    const text = textOf(body.result as Record<string, unknown>);
    expect([...idsIn(text)][0]).toBe('m-org-newest');
    expect(idsIn(text)).toEqual(new Set(['m-org-newest', 'm-org']));
    expect(text).not.toContain('m-ra');
    expect((body.result as Record<string, unknown>)._meta).toEqual({
      'io.mneme/untrustedContent': { note: MCP_UNTRUSTED_CONTENT_NOTE },
    });
  });

  it('list_recent_messages cannot use channelIds to broaden an org token', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'list_recent_messages', { channelIds: [RA] });
    expect(idsIn(textOf(body.result as Record<string, unknown>))).toEqual(new Set());
  });

  it('list_recent_messages validates timestamps, bounds, and unknown fields', async () => {
    const { base, orgToken } = await start();
    for (const args of [
      { after: 'not-a-date' },
      { limit: 51 },
      { query: 'should-not-be-accepted' },
    ]) {
      const { body } = await call(base, orgToken, 'list_recent_messages', args);
      expect((body.error as { code: number }).code).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
    }
  });

  it('search_messages with an org token returns only org content', async () => {
    const { base, orgToken } = await start();
    const { status, body } = await call(base, orgToken, 'search_messages', { query: 'onboarding' });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const result = body.result as Record<string, unknown>;
    expect(idsIn(textOf(result))).toEqual(new Set(['m-org']));
    expect(result.resultType).toBe('complete');
    expect(result.isError).toBe(false);
    expect(result._meta).toEqual({
      'io.mneme/untrustedContent': { note: MCP_UNTRUSTED_CONTENT_NOTE },
    });
  });

  it('search_messages with a channel token includes the granted channel and its thread', async () => {
    const { base, channelToken } = await start();
    const { body } = await call(base, channelToken, 'search_messages', { query: 'onboarding' });
    const ids = idsIn(textOf(body.result as Record<string, unknown>));
    expect(ids).toEqual(new Set(['m-org', 'm-ra', 'm-ra-before', 'm-thread']));
    // The sibling restricted channel, review-only, and excluded content never leak.
    expect(ids.has('m-rb')).toBe(false);
    expect(ids.has('m-rev')).toBe(false);
    expect(ids.has('m-exc')).toBe(false);
  });

  it('search_messages with a channel token + explicit channelId narrows further', async () => {
    const { base, channelToken } = await start();
    // Restrict to the granted channel id. This is an exact channel-id membership
    // filter intersected with the grant: it drops org content AND the RA thread
    // (whose channel_id is THREAD_A, not RA) — the same narrowing the agent-run
    // tool applies (scoped-message-search.test.ts: caller [RA] keeps only RA).
    const { body } = await call(base, channelToken, 'search_messages', {
      query: 'onboarding',
      channelIds: [RA],
    });
    expect(idsIn(textOf(body.result as Record<string, unknown>))).toEqual(
      new Set(['m-ra', 'm-ra-before']),
    );
  });

  it('a caller-supplied restricted channelId cannot broaden an org token', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'search_messages', {
      query: 'onboarding',
      channelIds: [RA],
    });
    // RA is not in the org grant, so the intersection is empty.
    expect(textOf(body.result as Record<string, unknown>)).toContain('No permitted messages matched.');
  });

  it('search_messages rejects an empty query with invalid_params', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'search_messages', { query: '   ' });
    const error = body.error as { code: number; message: string };
    expect(error.code).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
    expect(error.message).toContain('query');
  });

  it('search_messages rejects a malformed ISO filter with invalid_params (not a 500)', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'search_messages', {
      query: 'onboarding',
      after: 'not-a-date',
    });
    expect((body.error as { code: number }).code).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
  });

  it('search_messages enforces advertised array, limit, query, and object bounds', async () => {
    const { base, orgToken } = await start();
    const invalid = [
      { query: 'onboarding', channelIds: Array.from({ length: 51 }, (_, i) => `channel-${i}`) },
      { query: 'onboarding', authorIds: Array.from({ length: 51 }, (_, i) => `author-${i}`) },
      { query: 'onboarding', limit: 51 },
      { query: 'x'.repeat(257) },
      { query: 'onboarding', unexpected: true },
    ];
    for (const args of invalid) {
      const { body } = await call(base, orgToken, 'search_messages', args);
      expect((body.error as { code: number }).code).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
    }
  });

  it('names the field and bound so a client can repair one argument', async () => {
    const { base, orgToken } = await start();
    // Regression: a client that only learned "invalid arguments" repaired by
    // dropping every optional argument, which silently narrowed its own search.
    const overCap = await call(base, orgToken, 'search_messages', {
      query: 'onboarding',
      limit: 51,
    });
    const error = overCap.body.error as { code: number; message: string };
    expect(error.code).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
    expect(error.message).toBe(
      'search_messages received invalid arguments: /limit Expected integer to be less or equal to 50',
    );

    // Many broken fields stay bounded and never repeat one path/constraint pair.
    const manyErrors = await call(base, orgToken, 'search_messages', {
      query: '',
      limit: 51,
      channelIds: 'not-an-array',
      authorIds: 'not-an-array',
      before: 1,
      after: 2,
    });
    const detail = (manyErrors.body.error as { message: string }).message
      .replace('search_messages received invalid arguments: ', '')
      .split('; ');
    expect(detail.length).toBeLessThanOrEqual(4);
    expect(new Set(detail).size).toBe(detail.length);
  });

  it('get_message_context with an org token returns context for an org message', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'get_message_context', { messageId: 'm-org' });
    const ids = idsIn(textOf(body.result as Record<string, unknown>));
    expect(ids.has('m-org')).toBe(true);
    expect((body.result as Record<string, unknown>)._meta).toEqual({
      'io.mneme/untrustedContent': { note: MCP_UNTRUSTED_CONTENT_NOTE },
    });
  });

  it('get_message_context with a channel token reaches the granted restricted channel', async () => {
    const { base, channelToken } = await start();
    const { body } = await call(base, channelToken, 'get_message_context', {
      messageId: 'm-ra',
      beforeCount: 5,
      afterCount: 5,
    });
    const ids = idsIn(textOf(body.result as Record<string, unknown>));
    expect(ids.has('m-ra')).toBe(true);
    expect(ids.has('m-ra-before')).toBe(true); // chronological neighbor in RA
  });

  it('get_message_context honors zero-width windows and includeReplies', async () => {
    const { base, channelToken } = await start();
    const { body } = await call(base, channelToken, 'get_message_context', {
      messageId: 'm-ra',
      beforeCount: 0,
      afterCount: 0,
      includeReplies: true,
    });
    expect(body.error).toBeUndefined();
    const text = textOf(body.result as Record<string, unknown>);
    expect(idsIn(text)).toEqual(new Set(['m-ra', 'm-ra-reply']));
    expect(text).toContain('(reply)');
    expect(text).not.toContain('m-ra-before');
  });

  it('get_message_context strictly validates its shared agent-tool schema without echoing input', async () => {
    const { base, orgToken } = await start();
    const sensitive = 'SENSITIVE_CONTEXT_ARGUMENT';
    // Each case also pins the repair detail the client needs: the field path plus
    // the constraint it broke, and never the supplied value.
    const invalidCases: Array<[string, Record<string, unknown>, string]> = [
      ['missing messageId', {}, '/messageId'],
      ['empty messageId', { messageId: '' }, '/messageId'],
      ['oversized messageId', { messageId: `${sensitive}${'x'.repeat(65)}` }, '/messageId'],
      ['negative beforeCount', { messageId: 'm-org', beforeCount: -1 }, '/beforeCount'],
      [
        'oversized beforeCount',
        { messageId: 'm-org', beforeCount: 51 },
        '/beforeCount Expected integer to be less or equal to 50',
      ],
      ['fractional beforeCount', { messageId: 'm-org', beforeCount: 1.5 }, '/beforeCount'],
      ['negative afterCount', { messageId: 'm-org', afterCount: -1 }, '/afterCount'],
      [
        'oversized afterCount',
        { messageId: 'm-org', afterCount: 51 },
        '/afterCount Expected integer to be less or equal to 50',
      ],
      ['fractional afterCount', { messageId: 'm-org', afterCount: 1.5 }, '/afterCount'],
      [
        'non-boolean includeReplies',
        { messageId: 'm-org', includeReplies: 'true' },
        '/includeReplies Expected boolean',
      ],
      ['unknown field', { messageId: 'm-org', extra: sensitive }, '/extra Unexpected property'],
    ];

    for (const [label, args, expectedDetail] of invalidCases) {
      const { body } = await call(base, orgToken, 'get_message_context', args);
      const error = body.error as { code: number; message: string } | undefined;
      expect(error?.code, label).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
      expect(error?.message, label).toContain('get_message_context received invalid arguments: ');
      expect(error?.message, label).toContain(expectedDetail);
      expect(JSON.stringify(body), label).not.toContain(sensitive);
      expect(body.result, label).toBeUndefined();
    }

    const upperBoundary = await call(base, orgToken, 'get_message_context', {
      messageId: 'm-org',
      beforeCount: 50,
      afterCount: 50,
      includeReplies: false,
    });
    expect(upperBoundary.body.error).toBeUndefined();
  });

  it('get_message_context returns the generic rejection for an out-of-scope message', async () => {
    const { base, orgToken } = await start();
    // m-ra is restricted; the org token cannot see it → generic rejection, no oracle.
    const { body } = await call(base, orgToken, 'get_message_context', { messageId: 'm-ra' });
    const text = textOf(body.result as Record<string, unknown>);
    expect(text).toContain("not visible");
    // And critically, the restricted content itself is not rendered.
    expect(text).not.toContain('sign-off');
  });

  it('a request without a grant (no token) receives nothing broader', async () => {
    const { base } = await start();
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'search_messages', arguments: { query: 'onboarding' } },
        id: '1',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('tools/call on an unknown tool returns method not found, never a broadened scope', async () => {
    const { base, orgToken } = await start();
    // A name not in the catalog yields method not found — and never a result.
    const { body } = await call(base, orgToken, 'not_a_real_tool', {});
    const error = body.error as { code: number; message: string };
    expect(error.code).toBe(MCP_JSONRPC_ERROR.METHOD_NOT_FOUND);
  });

  it('the handler registry implements every advertised tool', () => {
    // Archive tools are advertised only when an archive is configured (plan 011).
    expect(Object.keys(MCP_TOOL_HANDLERS).sort()).toEqual([...MCP_TOOL_NAMES, ...MCP_ARCHIVE_TOOL_NAMES].sort());
  });

  it('never renders review_only or excluded content under any token', async () => {
    const { base, orgToken, channelToken } = await start();
    for (const token of [orgToken, channelToken]) {
      const { body } = await call(base, token, 'search_messages', { query: 'onboarding' });
      const text = textOf(body.result as Record<string, unknown>);
      expect(text).not.toContain('review');
      expect(text).not.toContain('excluded discussion');
    }
  });
});
