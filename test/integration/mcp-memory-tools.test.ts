import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createMcpServer, MCP_JSONRPC_ERROR } from '../../src/mcp/server.js';
import { MCP_UNTRUSTED_CONTENT_NOTE } from '../../src/mcp/tools.js';
import { createMcpToken } from '../../src/mcp/auth.js';
import { createRateLimiter } from '../../src/mcp/rate-limit.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { createMemory } from '../../src/memory/repository.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';

/**
 * MCP memory and channel tools through the scoped repositories (Sections 7.3,
 * 22.3, 22.4, 32.5.3; task T104).
 *
 * Acceptance — verbatim: "Explicit restricted grants reveal only named channels
 * and review_only remains inaccessible for every token."
 *
 * The suite mounts the MCP endpoint and drives `tools/call` for search_memories,
 * list_memories, get_memory, get_memory_evidence, and list_channels with an `org`-scope token
 * and an `org_plus_channels` token granting one restricted channel. Memories are
 * seeded across scopes (org, one restricted channel, and a cross-restricted
 * review_only memory) and channels across every visibility class. It proves the
 * tools read through the SAME scoped repositories as the agent-run tools: the org
 * token sees only org memories/channels, the channel token additionally sees its
 * named restricted channel, and a review_only memory never surfaces under any MCP
 * token (Section 44 — an MCP token never carries review_only access). An
 * out-of-scope get_memory yields the generic rejection (no oracle).
 */

const GUILD = '100000000000000001';
const ACTOR = '100000000000000003';
const USER = '100000000000000003';
const HOST = '127.0.0.1';
const PATH = '/mcp';
const NOW = 1_700_000_001_000;

const ORG = 'org-c';
const RA = 'restricted-A';
const RB = 'restricted-B';
const REV = 'review-only-c';
const EXC = 'excluded-c';

let env: TestDb;
const servers: HttpServerHandle[] = [];

// Memory ids are assigned by createMemory; captured during seeding.
let memOrg: string;
let memRa: string;
let memReview: string;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
  seedChannel(ORG, 'org');
  seedChannel(RA, 'restricted');
  seedChannel(RB, 'restricted');
  seedChannel(REV, 'review_only');
  seedChannel(EXC, 'excluded');

  addMessage('e-org', ORG, 'onboarding trial decision evidence');
  addMessage('e-ra', RA, 'onboarding restricted evidence');
  addMessage('e-rb', RB, 'onboarding other restricted evidence');

  // org-scoped memory (evidence only in an org channel).
  memOrg = createMemory(env.db, { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] }, {
    guildId: GUILD,
    type: 'decision',
    statement: 'Adopt the onboarding trial.',
    confidence: 0.8,
    importance: 0.7,
    evidence: [{ messageId: 'e-org', stance: 'origin' }],
    now: NOW,
  });
  // channel-scoped memory (evidence only in restricted-A).
  memRa = createMemory(
    env.db,
    { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [RA] },
    {
      guildId: GUILD,
      type: 'decision',
      statement: 'Restricted onboarding call.',
      confidence: 0.7,
      importance: 0.6,
      evidence: [{ messageId: 'e-ra', stance: 'origin' }],
      now: NOW,
    },
  );
  // review_only memory (evidence spans two restricted channels → collapses).
  memReview = createMemory(
    env.db,
    { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [RA, RB] },
    {
      guildId: GUILD,
      type: 'risk',
      statement: 'Cross-channel onboarding risk.',
      confidence: 0.6,
      importance: 0.6,
      evidence: [
        { messageId: 'e-ra', stance: 'origin' },
        { messageId: 'e-rb', stance: 'supports' },
      ],
      now: NOW,
    },
  );
});

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  env.cleanup();
});

type Vis = 'org' | 'restricted' | 'review_only' | 'excluded';

function seedChannel(
  id: string,
  visibility: Vis,
  options: { parentId?: string; isThread?: boolean } = {},
): void {
  upsertChannel(env.db, {
    id,
    guildId: GUILD,
    parentId: options.parentId ?? null,
    kind: options.isThread ? 'thread' : 'text',
    name: id,
    topic: null,
    position: null,
    isThread: options.isThread ?? false,
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

function addMessage(id: string, channel: string, content: string): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: channel,
    authorId: USER,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: NOW,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: NOW,
    updatedAtMs: NOW,
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

/** Collect the bracketed leading id from each rendered line. */
function idsIn(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^\[([^\]]+)\]/.exec(line);
    if (m && m[1]) ids.add(m[1]);
  }
  return ids;
}

describe('search_memories is scoped to the token grant', () => {
  it('an org token sees only org memories', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'search_memories', { query: 'onboarding' });
    const ids = idsIn(textOf(body.result as Record<string, unknown>));
    expect(ids.has(memOrg)).toBe(true);
    expect(ids.has(memRa)).toBe(false);
    expect(ids.has(memReview)).toBe(false);
    expect(textOf(body.result as Record<string, unknown>)).toContain(
      `https://discord.com/channels/${GUILD}/${ORG}/e-org`,
    );
  });

  it('supports a bounded wildcard inventory without broadening token scope', async () => {
    const { base, orgToken, channelToken } = await start();
    const org = await call(base, orgToken, 'search_memories', { query: '*' });
    const orgText = textOf(org.body.result as Record<string, unknown>);
    expect(idsIn(orgText).has(memOrg)).toBe(true);
    expect(idsIn(orgText).has(memRa)).toBe(false);
    expect(orgText).toContain(`https://discord.com/channels/${GUILD}/${ORG}/e-org`);

    const channel = await call(base, channelToken, 'search_memories', { query: '*' });
    const channelIds = idsIn(textOf(channel.body.result as Record<string, unknown>));
    expect(channelIds.has(memOrg)).toBe(true);
    expect(channelIds.has(memRa)).toBe(true);
    expect(channelIds.has(memReview)).toBe(false);
  });

  it('a channel token additionally sees its granted restricted channel memory', async () => {
    const { base, channelToken } = await start();
    const { body } = await call(base, channelToken, 'search_memories', { query: 'onboarding' });
    const ids = idsIn(textOf(body.result as Record<string, unknown>));
    expect(ids.has(memOrg)).toBe(true);
    expect(ids.has(memRa)).toBe(true);
    // The sibling restricted channel is not granted, so RB-only content stays hidden.
    // review_only remains inaccessible for every token (Section 44).
    expect(ids.has(memReview)).toBe(false);
  });

  it('review_only memory never surfaces under any MCP token', async () => {
    const { base, orgToken, channelToken } = await start();
    for (const token of [orgToken, channelToken]) {
      const { body } = await call(base, token, 'search_memories', { query: 'cross-channel' });
      const text = textOf(body.result as Record<string, unknown>);
      expect(text).not.toContain('Cross-channel onboarding risk');
    }
  });

  it('rejects an empty query with invalid_params', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'search_memories', { query: '' });
    expect((body.error as { code: number }).code).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
  });

  it('strictly validates query bounds, enum filters, item caps, limit, and unknown fields', async () => {
    const { base, orgToken } = await start();
    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ['missing query', {}],
      ['blank query', { query: '   ' }],
      ['oversized query', { query: 'x'.repeat(257) }],
      ['unknown field', { query: 'onboarding', extra: true }],
      ['non-array types', { query: 'onboarding', types: 'decision' }],
      ['invalid memory type', { query: 'onboarding', types: ['bogus'] }],
      ['too many memory types', { query: 'onboarding', types: Array(11).fill('decision') }],
      ['invalid memory status', { query: 'onboarding', statuses: ['bogus'] }],
      ['too many memory statuses', { query: 'onboarding', statuses: Array(6).fill('active') }],
      ['zero limit', { query: 'onboarding', limit: 0 }],
      ['oversized limit', { query: 'onboarding', limit: 51 }],
      ['fractional limit', { query: 'onboarding', limit: 1.5 }],
    ];

    for (const [label, args] of invalidCases) {
      const { body } = await call(base, orgToken, 'search_memories', args);
      expect((body.error as { code: number } | undefined)?.code, label).toBe(
        MCP_JSONRPC_ERROR.INVALID_PARAMS,
      );
    }

    const boundary = await call(base, orgToken, 'search_memories', {
      query: 'x'.repeat(256),
      types: [
        'decision', 'assumption', 'prediction', 'fact', 'risk', 'commitment',
        'experiment', 'disagreement', 'constraint', 'open_question',
      ],
      statuses: ['active', 'superseded', 'resolved', 'invalidated', 'expired'],
      limit: 50,
    });
    expect(boundary.body.error).toBeUndefined();
  });

  it('filters by memory type', async () => {
    const { base, channelToken } = await start();
    const { body } = await call(base, channelToken, 'search_memories', {
      query: 'onboarding',
      types: ['risk'],
    });
    // No permitted memory is a risk (the only risk is review_only, hidden).
    expect(textOf(body.result as Record<string, unknown>)).toContain('No permitted memories matched.');
  });
});

describe('list_memories is a scoped, query-free inventory', () => {
  it('lists visible memories with source links and never exposes review_only', async () => {
    const { base, orgToken, channelToken } = await start();
    const org = await call(base, orgToken, 'list_memories', {});
    const orgText = textOf(org.body.result as Record<string, unknown>);
    expect(orgText).toContain('Showing 1 of 1');
    expect(idsIn(orgText).has(memOrg)).toBe(true);
    expect(idsIn(orgText).has(memRa)).toBe(false);
    expect(idsIn(orgText).has(memReview)).toBe(false);
    expect(orgText).toContain(`https://discord.com/channels/${GUILD}/${ORG}/e-org`);

    const channel = await call(base, channelToken, 'list_memories', {
      types: ['decision'],
      statuses: ['active'],
      limit: 20,
    });
    const channelIds = idsIn(textOf(channel.body.result as Record<string, unknown>));
    expect(channelIds.has(memOrg)).toBe(true);
    expect(channelIds.has(memRa)).toBe(true);
    expect(channelIds.has(memReview)).toBe(false);
  });

  it('rejects query input so topical retrieval stays in search_memories', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'list_memories', { query: 'onboarding' });
    expect((body.error as { code: number }).code).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
  });

  it('strictly validates enum filters, item caps, limit, and additional properties', async () => {
    const { base, orgToken } = await start();
    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ['unknown field', { extra: true }],
      ['query field', { query: 'onboarding' }],
      ['non-array types', { types: 'decision' }],
      ['invalid memory type', { types: ['bogus'] }],
      ['too many memory types', { types: Array(11).fill('decision') }],
      ['non-array statuses', { statuses: 'active' }],
      ['invalid memory status', { statuses: ['bogus'] }],
      ['too many memory statuses', { statuses: Array(6).fill('active') }],
      ['zero limit', { limit: 0 }],
      ['oversized limit', { limit: 51 }],
      ['fractional limit', { limit: 1.5 }],
    ];

    for (const [label, args] of invalidCases) {
      const { body } = await call(base, orgToken, 'list_memories', args);
      expect((body.error as { code: number } | undefined)?.code, label).toBe(
        MCP_JSONRPC_ERROR.INVALID_PARAMS,
      );
    }

    const boundary = await call(base, orgToken, 'list_memories', {
      types: [
        'decision', 'assumption', 'prediction', 'fact', 'risk', 'commitment',
        'experiment', 'disagreement', 'constraint', 'open_question',
      ],
      statuses: ['active', 'superseded', 'resolved', 'invalidated', 'expired'],
      limit: 50,
    });
    expect(boundary.body.error).toBeUndefined();
  });
});

describe('get_memory honors recomputed scope', () => {
  it('returns details for an in-scope memory', async () => {
    const { base, channelToken } = await start();
    const { body } = await call(base, channelToken, 'get_memory', { memoryId: memRa });
    const text = textOf(body.result as Record<string, unknown>);
    expect(text).toContain(memRa);
    expect(text).toContain('Restricted onboarding call.');
    expect((body.result as Record<string, unknown>)._meta).toEqual({
      'io.mneme/untrustedContent': { note: MCP_UNTRUSTED_CONTENT_NOTE },
    });
  });

  it('returns the generic rejection for an out-of-scope memory (no oracle)', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'get_memory', { memoryId: memRa });
    const text = textOf(body.result as Record<string, unknown>);
    expect(text).toContain('not visible');
    // The restricted statement itself is never rendered.
    expect(text).not.toContain('Restricted onboarding call.');
  });

  it('a review_only memory is rejected for every token', async () => {
    const { base, orgToken, channelToken } = await start();
    for (const token of [orgToken, channelToken]) {
      const { body } = await call(base, token, 'get_memory', { memoryId: memReview });
      expect(textOf(body.result as Record<string, unknown>)).toContain('not visible');
    }
  });

  it('hides a known memory id after its evidence channel is disabled', async () => {
    const { base, orgToken } = await start();
    env.db.prepare('UPDATE channels SET ingest_enabled = 0 WHERE id = ?').run(ORG);

    const inventory = await call(base, orgToken, 'list_memories', {});
    const inventoryText = textOf(inventory.body.result as Record<string, unknown>);
    expect(inventoryText).not.toContain(memOrg);
    expect(inventoryText).not.toContain('Adopt the onboarding trial.');

    const search = await call(base, orgToken, 'search_memories', { query: 'onboarding' });
    const searchText = textOf(search.body.result as Record<string, unknown>);
    expect(searchText).not.toContain(memOrg);
    expect(searchText).not.toContain('Adopt the onboarding trial.');

    const details = await call(base, orgToken, 'get_memory', { memoryId: memOrg });
    const detailsText = textOf(details.body.result as Record<string, unknown>);
    expect(detailsText).toContain('not visible');
    expect(detailsText).not.toContain('Adopt the onboarding trial.');

    const evidence = await call(base, orgToken, 'get_memory_evidence', { memoryId: memOrg });
    const evidenceText = textOf(evidence.body.result as Record<string, unknown>);
    expect(evidenceText).toContain('No visible evidence');
    expect(evidenceText).not.toContain('onboarding trial decision evidence');
  });

  it('rejects a missing memoryId with invalid_params', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'get_memory', {});
    expect((body.error as { code: number }).code).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
  });
});

describe('get_memory_evidence returns only permitted evidence', () => {
  it('returns visible evidence for an in-scope memory', async () => {
    const { base, channelToken } = await start();
    const { body } = await call(base, channelToken, 'get_memory_evidence', { memoryId: memRa });
    const text = textOf(body.result as Record<string, unknown>);
    expect(text).toContain('e-ra');
    expect(text).toContain('onboarding restricted evidence');
    expect(text).toContain(`https://discord.com/channels/${GUILD}/${RA}/e-ra`);
    expect((body.result as Record<string, unknown>)._meta).toEqual({
      'io.mneme/untrustedContent': { note: MCP_UNTRUSTED_CONTENT_NOTE },
    });
  });

  it('returns no evidence when the memory scope is not permitted', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'get_memory_evidence', { memoryId: memRa });
    const text = textOf(body.result as Record<string, unknown>);
    expect(text).toContain('No visible evidence');
    expect(text).not.toContain('onboarding restricted evidence');
  });

  it('a review_only memory yields no evidence for any token', async () => {
    const { base, orgToken, channelToken } = await start();
    for (const token of [orgToken, channelToken]) {
      const { body } = await call(base, token, 'get_memory_evidence', { memoryId: memReview });
      expect(textOf(body.result as Record<string, unknown>)).toContain('No visible evidence');
    }
  });

  it('strictly validates the shared evidence schema without echoing invalid input', async () => {
    const { base, channelToken } = await start();
    const sensitive = 'SENSITIVE_EVIDENCE_ARGUMENT';
    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ['missing memoryId', {}],
      ['empty memoryId', { memoryId: '' }],
      ['oversized memoryId', { memoryId: `${sensitive}${'x'.repeat(65)}` }],
      ['zero limit', { memoryId: memRa, limit: 0 }],
      ['oversized limit', { memoryId: memRa, limit: 51 }],
      ['fractional limit', { memoryId: memRa, limit: 1.5 }],
      ['string limit', { memoryId: memRa, limit: '1' }],
      ['unknown field', { memoryId: memRa, extra: sensitive }],
    ];

    for (const [label, args] of invalidCases) {
      const { body } = await call(base, channelToken, 'get_memory_evidence', args);
      const error = body.error as { code: number; message: string } | undefined;
      expect(error?.code, label).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
      expect(error?.message, label).toContain('get_memory_evidence received invalid arguments: ');
      expect(JSON.stringify(body), label).not.toContain(sensitive);
      expect(body.result, label).toBeUndefined();
    }

    for (const limit of [1, 50]) {
      const { body } = await call(base, channelToken, 'get_memory_evidence', {
        memoryId: memRa,
        limit,
      });
      expect(body.error, `limit=${limit}`).toBeUndefined();
      expect(textOf(body.result as Record<string, unknown>), `limit=${limit}`).toContain('e-ra');
    }
  });
});

describe('list_channels reveals only named restricted channels', () => {
  it('an org token lists org channels only', async () => {
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'list_channels', {});
    const ids = idsIn(textOf(body.result as Record<string, unknown>));
    expect(ids.has(ORG)).toBe(true);
    // No restricted, review_only, or excluded channel leaks to an org token.
    expect(ids.has(RA)).toBe(false);
    expect(ids.has(RB)).toBe(false);
    expect(ids.has(REV)).toBe(false);
    expect(ids.has(EXC)).toBe(false);
  });

  it('a channel token lists org channels plus its named restricted channel', async () => {
    const threadId = 'restricted-A-thread';
    seedChannel(threadId, 'restricted', { parentId: RA, isThread: true });
    const { base, channelToken } = await start();
    const { body } = await call(base, channelToken, 'list_channels', {});
    const ids = idsIn(textOf(body.result as Record<string, unknown>));
    expect(ids.has(ORG)).toBe(true);
    expect(ids.has(RA)).toBe(true);
    expect(ids.has(threadId)).toBe(true);
    // The sibling restricted channel is not named in the grant.
    expect(ids.has(RB)).toBe(false);
    // review_only and excluded are never listed for any token (Section 44).
    expect(ids.has(REV)).toBe(false);
    expect(ids.has(EXC)).toBe(false);
  });

  it('names a thread without its own name after its parent and the date in its id, never its text', async () => {
    const threadId = `${ORG}-T1790949700.173829`;
    seedChannel(threadId, 'org', { parentId: ORG, isThread: true });
    env.db.prepare('UPDATE channels SET name = NULL WHERE id = ?').run(threadId);
    addMessage('thread-root-msg', threadId, 'secret root words that must not be listed');
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'list_channels', {});
    const text = textOf(body.result as Record<string, unknown>);
    // The date comes from the thread root ts in the id, not from stored messages.
    const day = new Date(1790949700 * 1000).toISOString().slice(0, 10);
    expect(text).toContain(`[${threadId}] #${ORG} › thread from ${day}`);
    expect(text).not.toContain(`#${threadId}`);
    expect(text).not.toContain('secret root words');
  });

  it('does not name a parent that the caller may not see', async () => {
    const threadId = `${RA}-T1790949700.173829`;
    seedChannel(threadId, 'org', { parentId: RA, isThread: true });
    env.db.prepare('UPDATE channels SET name = NULL WHERE id = ?').run(threadId);
    env.db.prepare('UPDATE channels SET name = ? WHERE id = ?').run('restricted-parent-name', RA);
    const { base, orgToken } = await start();
    const { body } = await call(base, orgToken, 'list_channels', {});
    const text = textOf(body.result as Record<string, unknown>);
    const day = new Date(1790949700 * 1000).toISOString().slice(0, 10);
    expect(text).toContain(`[${threadId}] #thread from ${day}`);
    expect(text).not.toContain('restricted-parent-name');
  });

  it('carries visibility class and sync state, and no untrusted-content note', async () => {
    const { base, channelToken } = await start();
    const { body } = await call(base, channelToken, 'list_channels', {});
    const text = textOf(body.result as Record<string, unknown>);
    expect(text).toContain('ingest:on');
    expect(text).toContain('restricted');
    // list_channels returns channel metadata only, so the untrusted-content note
    // does not apply (Section 32.5.3).
    expect((body.result as Record<string, unknown>)._meta).toBeUndefined();
  });
});
