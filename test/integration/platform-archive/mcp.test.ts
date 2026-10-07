// ABOUTME: Tests the MCP archive tools (plan 011 step 8): listed only with an archive, org tokens only, servable rows only.
// ABOUTME: Results carry archive ids, host-built links, and the untrusted-content note; redactions apply at call time.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { openArchiveDatabase, verifyArchive } from '../../../src/platform-archive/database.js';
import { createArchiveReader, type ArchiveReader } from '../../../src/platform-archive/read.js';
import {
  MCP_ARCHIVE_TOOL_NAMES,
  mcpToolCall,
  mcpToolsListResult,
  type McpToolCallContext,
} from '../../../src/mcp/tools.js';
import { MCP_JSONRPC_ERROR, type McpMethodResult } from '../../../src/mcp/types.js';
import {
  ARCHIVE_CHANNELS,
  ARCHIVE_GUILD,
  ARCHIVE_MEMORIES,
  ARCHIVE_MESSAGES,
  createArchiveFixture,
  type ArchiveFixture,
} from '../../helpers/archive.js';

const NOW = 1_790_000_000_000;
let live: TestDb;
let fixture: ArchiveFixture;
let archiveDb: DatabaseSync;
let reader: ArchiveReader;

beforeEach(() => {
  live = createTestDb();
  fixture = createArchiveFixture();
  archiveDb = openArchiveDatabase(fixture.path);
  const summary = verifyArchive(archiveDb, fixture.path, { platform: 'discord', newestSchemaVersion: 1_000 });
  reader = createArchiveReader({ db: archiveDb, liveDb: live.db, summary });
});

afterEach(() => {
  try { archiveDb.close(); } catch { /* already closed */ }
  fixture.cleanup();
  live.cleanup();
});

function ctx(over: Partial<McpToolCallContext> = {}): McpToolCallContext {
  return {
    grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] },
    db: live.db,
    nowMs: NOW,
    tokenScopeType: 'org',
    archive: reader,
    ...over,
  };
}

async function call(name: string, args: Record<string, unknown>, over: Partial<McpToolCallContext> = {}): Promise<McpMethodResult> {
  return mcpToolCall({ name, arguments: args }, ctx(over));
}

function text(result: McpMethodResult): string {
  if (!result.ok) throw new Error(`tool error ${result.error.message}`);
  const r = result.result as { content: Array<{ text: string }> };
  return r.content.map((c) => c.text).join('\n');
}

function redact(kind: 'message' | 'user', target: string): void {
  live.db.prepare(
    `INSERT INTO archive_redactions (id, archive_workspace_id, target_kind, target_id, archive_sha256, created_at_ms)
     VALUES (?, ?, ?, ?, 'sha', ?)`,
  ).run(`r-${kind}-${target}`, ARCHIVE_GUILD, kind, target, NOW);
}

describe('MCP archive tools', () => {
  it('lists the archive tools only when an archive is configured', () => {
    const without = (mcpToolsListResult(1_000) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    const withArchive = (mcpToolsListResult(1_000, { archive: true }) as { tools: Array<{ name: string }> }).tools
      .map((t) => t.name);
    for (const name of MCP_ARCHIVE_TOOL_NAMES) {
      expect(without).not.toContain(name);
      expect(withArchive).toContain(name);
    }
    expect(MCP_ARCHIVE_TOOL_NAMES).toEqual([
      'search_archive_messages', 'get_archive_message_context', 'search_archive_memories', 'get_archive_memory',
    ]);
  });

  it('answers an unknown tool when no archive is configured', async () => {
    const res = await call('search_archive_messages', { query: 'billing' }, { archive: undefined });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(MCP_JSONRPC_ERROR.METHOD_NOT_FOUND);
  });

  it('refuses a channel-scoped token', async () => {
    const res = await call('search_archive_messages', { query: 'billing' }, {
      tokenScopeType: 'org_plus_channels',
      grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [ARCHIVE_CHANNELS.org] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.result as { isError: boolean }).isError).toBe(true);
    expect(text(res)).toContain('cannot read the platform archive');
    expect(text(res)).not.toContain('archive:3');
  });

  it('refuses a request whose token scope is unknown', async () => {
    const res = await call('search_archive_memories', {}, { tokenScopeType: undefined });
    expect(res.ok && (res.result as { isError: boolean }).isError).toBe(true);
  });

  it('returns only servable org messages, labeled as archive with host-built links', async () => {
    const res = await call('search_archive_messages', { query: 'billing decision', limit: 50 });
    const out = text(res);
    expect(out).toContain(`archive:${ARCHIVE_MESSAGES.org}`);
    expect(out).toContain(`https://discord.com/channels/${ARCHIVE_GUILD}/${ARCHIVE_CHANNELS.org}/${ARCHIVE_MESSAGES.org}`);
    expect(out).toContain('[archive · discord');
    for (const hidden of ['restricted', 'reviewOnly', 'excluded', 'testSurface', 'restrictedThread', 'boundary'] as const) {
      expect(out).not.toContain(ARCHIVE_MESSAGES[hidden]);
    }
    expect(res.ok && (res.result as { _meta?: Record<string, unknown> })._meta).toHaveProperty('io.mneme/untrustedContent');
  });

  it('applies redactions at call time to messages and context', async () => {
    redact('message', ARCHIVE_MESSAGES.org);
    expect(text(await call('search_archive_messages', { query: 'billing decision', limit: 50 })))
      .not.toContain(ARCHIVE_MESSAGES.org);
    expect(text(await call('get_archive_message_context', { messageId: `archive:${ARCHIVE_MESSAGES.org}` })))
      .toContain('not visible');
  });

  it('hides context for a message that is not org', async () => {
    const out = text(await call('get_archive_message_context', { messageId: `archive:${ARCHIVE_MESSAGES.restricted}` }));
    expect(out).toContain('not visible');
    expect(out).not.toContain('archived restricted');
  });

  it('serves org memories with their evidence and hides the others', async () => {
    const list = text(await call('search_archive_memories', {}));
    expect(list).toContain(`archive:${ARCHIVE_MEMORIES.org}`);
    for (const hidden of [ARCHIVE_MEMORIES.channel, ARCHIVE_MEMORIES.reviewOnly, ARCHIVE_MEMORIES.superseded]) {
      expect(list).not.toContain(hidden);
    }
    const one = text(await call('get_archive_memory', { memoryId: `archive:${ARCHIVE_MEMORIES.org}` }));
    expect(one).toContain(`archive:${ARCHIVE_MESSAGES.org}`);
    expect(text(await call('get_archive_memory', { memoryId: `archive:${ARCHIVE_MEMORIES.channel}` })))
      .toContain('not visible');
  });

  it('rejects an id without the archive prefix', async () => {
    const res = await call('get_archive_memory', { memoryId: ARCHIVE_MEMORIES.org });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(MCP_JSONRPC_ERROR.INVALID_PARAMS);
  });
});
