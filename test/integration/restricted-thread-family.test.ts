// ABOUTME: Security probe for restricted threads under an org parent (spec Sections 7.1, 12.3).
// ABOUTME: Asserts that a restricted thread's content and memories stay in that thread and secure review.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { createMemory, getMemory } from '../../src/memory/repository.js';
import { searchMemories } from '../../src/memory/search.js';
import { searchMessages, type RetrievalGrant } from '../../src/db/repositories/message-search.js';
import {
  grantForDirectAnswerChannel,
  grantForSecureReview,
  grantForTargetChannel,
} from '../../src/production-runtime.js';
import { getChannel } from '../../src/db/repositories/channels.js';
import { mcpGrantToRetrievalGrant } from '../../src/mcp/tools.js';
import { validateMcpTokenGrant } from '../../src/mcp/auth.js';
import { applyMemoryProposals, type AgentMemoryProposal } from '../../src/agent/memory-policy.js';

const GUILD = '100000000000000001';
const ALICE = '100000000000000003'; // seeded by seedIdentity
const PARENT = '200000000000000010'; // org parent P
const THREAD_A = '200000000000000011'; // explicit restricted thread under P
const THREAD_B = '200000000000000012'; // restricted sibling thread under P
const OTHER_ORG = '200000000000000013'; // unrelated org channel
const NOW = 1_700_000_001_000;

const A_MSG = 'a-secret';
const B_MSG = 'b-note';
const P_MSG = 'p-org';

let env: TestDb;

function channel(id: string, visibility: 'org' | 'restricted', parentId?: string): void {
  upsertChannel(env.db, {
    id, guildId: GUILD, parentId: parentId ?? null, kind: parentId ? 'thread' : 'text', name: `chan-${id.slice(-2)}`,
    topic: null, position: null, isThread: Boolean(parentId), isArchived: false, isLocked: false,
    ingestEnabled: true, visibilityClass: visibility, allowInterventions: false,
    permissionFingerprint: null, lastMessageId: null, discoveredAtMs: NOW, updatedAtMs: NOW, rawJson: null,
  });
}

function message(id: string, channelId: string, content: string): void {
  upsertMessageCreate(env.db, {
    id, guildId: GUILD, channelId, authorId: ALICE, authorDisplayName: 'Alice', content,
    createdAtMs: NOW, editedAtMs: null, replyToMessageId: null, messageType: 0, flags: 0, pinned: false,
    mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]', componentsJson: '[]', pollJson: null,
    rawJson: null, ingestedAtMs: NOW, updatedAtMs: NOW,
  });
}

function contentOf(id: string): string {
  return (env.db.prepare('SELECT content FROM messages WHERE id=?').get(id) as { content: string }).content;
}

function memoryIds(grant: RetrievalGrant, query: string): string[] {
  return searchMemories(env.db, grant, { query, limit: 20 }).map((m) => m.memoryId);
}

function messageIds(grant: RetrievalGrant, query: string): string[] {
  return searchMessages(env.db, grant, { query, limit: 20, now: NOW }).map((m) => m.messageId);
}

function mcpChannelGrant(channelId: string): RetrievalGrant {
  const v = validateMcpTokenGrant(env.db, { name: 'probe', channelIds: [channelId] }, NOW);
  if (!v.ok) throw new Error(`mcp grant invalid: ${JSON.stringify(v)}`);
  return mcpGrantToRetrievalGrant(v.grant);
}

const grantIn = (id: string): RetrievalGrant => grantForTargetChannel(getChannel(env.db, id));
const MCP_ORG: RetrievalGrant = mcpGrantToRetrievalGrant({ scopeType: 'org', channelIds: [] });

let secretMemory: string;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  channel(PARENT, 'org');
  channel(THREAD_A, 'restricted', PARENT);
  channel(THREAD_B, 'restricted', PARENT);
  channel(OTHER_ORG, 'org');
  message(A_MSG, THREAD_A, 'Acquisition codename is falcon and the price is ninety million.');
  message(B_MSG, THREAD_B, 'Acquisition planning sync moved to Thursday.');
  message(P_MSG, PARENT, 'General acquisition chatter for everyone.');
  secretMemory = createMemory(env.db, grantIn(THREAD_A), {
    guildId: GUILD, type: 'fact', statement: 'Acquisition codename is falcon.',
    confidence: 0.9, importance: 0.9, evidence: [{ messageId: A_MSG, stance: 'origin' }],
    createdByRunId: 'run-a', now: NOW,
  });
});
afterEach(() => env.cleanup());

describe('restricted thread A under org parent P: memory retrieval', () => {
  it('stores the memory under the parent anchor (observed topology)', () => {
    expect(getMemory(env.db, secretMemory)).toMatchObject({ scope_type: 'channel', scope_key: PARENT });
  });

  it('is served in A itself', () => {
    expect(memoryIds(grantIn(THREAD_A), 'falcon')).toContain(secretMemory);
  });

  it('is served in the secure review channel', () => {
    expect(memoryIds(grantForSecureReview(env.db, ['org', 'restricted']), 'falcon')).toContain(secretMemory);
  });

  it('(a) is NOT served in org parent P (target grant and direct answer grant)', () => {
    expect(memoryIds(grantIn(PARENT), 'falcon')).not.toContain(secretMemory);
    expect(memoryIds(grantForDirectAnswerChannel(env.db, PARENT, undefined), 'falcon')).not.toContain(secretMemory);
  });

  it('(b) is NOT served in restricted sibling thread B (target grant)', () => {
    expect(memoryIds(grantIn(THREAD_B), 'falcon')).not.toContain(secretMemory);
  });

  it('(b) is NOT served in restricted sibling thread B (direct answer grant)', () => {
    expect(memoryIds(grantForDirectAnswerChannel(env.db, THREAD_B, undefined), 'falcon')).not.toContain(secretMemory);
  });

  it('(c) is NOT served in an unrelated org channel', () => {
    expect(memoryIds(grantIn(OTHER_ORG), 'falcon')).not.toContain(secretMemory);
  });

  it('(d) is NOT served to an org MCP token', () => {
    expect(memoryIds(MCP_ORG, 'falcon')).not.toContain(secretMemory);
  });

  it('(d) is NOT served to an MCP token granted only sibling thread B', () => {
    expect(memoryIds(mcpChannelGrant(THREAD_B), 'falcon')).not.toContain(secretMemory);
  });
});

describe('restricted thread A under org parent P: raw message retrieval', () => {
  it('is returned in A and the secure review channel', () => {
    expect(messageIds(grantIn(THREAD_A), 'falcon')).toContain(A_MSG);
    expect(messageIds(grantForSecureReview(env.db, ['org', 'restricted']), 'falcon')).toContain(A_MSG);
  });

  it('is NOT returned in org parent P, other org channels, or org MCP', () => {
    expect(messageIds(grantIn(PARENT), 'falcon')).not.toContain(A_MSG);
    expect(messageIds(grantIn(OTHER_ORG), 'falcon')).not.toContain(A_MSG);
    expect(messageIds(MCP_ORG, 'falcon')).not.toContain(A_MSG);
  });

  it('is NOT returned in restricted sibling thread B', () => {
    expect(messageIds(grantIn(THREAD_B), 'falcon')).not.toContain(A_MSG);
  });

  it('is NOT returned to an MCP token granted only sibling thread B', () => {
    expect(messageIds(mcpChannelGrant(THREAD_B), 'falcon')).not.toContain(A_MSG);
  });
});

describe('restricted thread A: laundering A-only facts through a sibling-B citation', () => {
  function proposal(over: Partial<AgentMemoryProposal> & { action: AgentMemoryProposal['action'] }): AgentMemoryProposal {
    const ids = over.evidenceMessageIds ?? [B_MSG];
    return {
      type: 'fact', statement: 'x', confidence: 0.8, importance: 0.8, evidenceMessageIds: ids,
      evidenceQuotes: ids.map((messageId) => ({ messageId, quote: contentOf(messageId) })),
      durability: 'project', durabilityReason: 'This affects future project work.', ...over,
    };
  }

  /** A run in A exposes A and (through the shared parent anchor) B. */
  function depsForRunIn(channelId: string, exposedMemoryIds = new Set<string>()) {
    const grant = grantIn(channelId);
    const rows = searchMessages(env.db, grant, { query: 'acquisition', limit: 20, now: NOW });
    return {
      db: env.db, grant, guildId: GUILD, runId: 'run-x', now: NOW + 1,
      exposedChannelIds: new Set(rows.map((r) => r.channelId)),
      exposedMessageIds: new Set(rows.map((r) => r.messageId)),
      exposedMemoryIds,
    };
  }

  it('rejects a create that states A-only facts while citing only sibling B', () => {
    const deps = depsForRunIn(THREAD_A);
    expect(deps.exposedChannelIds.has(THREAD_A)).toBe(true);
    const out = applyMemoryProposals(deps, [proposal({
      action: 'create',
      statement: 'Acquisition codename is falcon and the acquisition price is ninety million.',
      evidenceMessageIds: [B_MSG],
    })]);
    const id = out.applied[0]?.memoryId;
    // Safe outcome: rejected. If accepted, confirm it reaches B and record the leak.
    if (id) {
      expect({ accepted: true, servedInB: memoryIds(grantIn(THREAD_B), 'falcon').includes(id) })
        .toEqual({ accepted: false, servedInB: false });
    }
    expect(out.applied).toHaveLength(0);
  });

  it('rejects an update of a B memory that adds A-only facts while citing only sibling B', () => {
    const bMemory = createMemory(env.db, grantIn(THREAD_B), {
      guildId: GUILD, type: 'fact', statement: 'Acquisition planning sync moved to Thursday.',
      confidence: 0.8, importance: 0.8, evidence: [{ messageId: B_MSG, stance: 'origin' }],
      createdByRunId: 'run-b', now: NOW,
    });
    const deps = depsForRunIn(THREAD_A, new Set([bMemory]));
    const out = applyMemoryProposals(deps, [proposal({
      action: 'update', existingMemoryId: bMemory,
      statement: 'Acquisition planning sync moved to Thursday; acquisition codename is falcon.',
      evidenceMessageIds: [B_MSG],
    })]);
    expect(out.applied).toHaveLength(0);
    expect(getMemory(env.db, bMemory)?.statement).not.toContain('falcon');
  });
});
