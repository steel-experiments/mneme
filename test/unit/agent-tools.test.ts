import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  createMemory,
  type RetrievalGrant,
  type MemoryEvidenceInput,
} from '../../src/memory/repository.js';
import {
  RunRetrievalState,
  type AgentRunContext,
} from '../../src/agent/run-context.js';
import { createSearchMessagesTool } from '../../src/agent/tools/search-messages.js';
import { createGetMessageContextTool } from '../../src/agent/tools/get-message-context.js';
import { createSearchMemoriesTool } from '../../src/agent/tools/search-memories.js';
import { createListMemoriesTool } from '../../src/agent/tools/list-memories.js';
import { createGetMemoryEvidenceTool } from '../../src/agent/tools/get-memory-evidence.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const NOW = 1_700_000_001_000;

let env: TestDb;

type Vis = 'org' | 'restricted' | 'review_only' | 'excluded';
function seedChannel(id: string, visibility: Vis): void {
  upsertChannel(env.db, {
    id,
    guildId: GUILD,
    parentId: null,
    kind: 'text',
    name: id,
    topic: null,
    position: null,
    isThread: false,
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

function addMessage(id: string, channel: string, content: string, atMs = NOW): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: channel,
    authorId: USER,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: atMs,
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
    ingestedAtMs: atMs,
    updatedAtMs: atMs,
  });
}

function ctx(grant: RetrievalGrant, budget = 60_000): AgentRunContext {
  return { db: env.db, grant, retrieval: new RunRetrievalState(budget, NOW, env.db) };
}

const ORG = 'org-c';
const RA = 'restricted-A';
const REV = 'review-c';
const EXC = 'excluded-c';

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
const CHANNEL_A_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RA],
};
function ev(messageId: string, stance: MemoryEvidenceInput['stance'] = 'origin'): MemoryEvidenceInput {
  return { messageId, stance };
}

describe('agent retrieval tools', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    seedChannel(ORG, 'org');
    seedChannel(RA, 'restricted');
    seedChannel(REV, 'review_only');
    seedChannel(EXC, 'excluded');
  });

  // ---- search_messages --------------------------------------------

  it('search_messages returns only permitted channels and records their provenance', async () => {
    addMessage('m-org', ORG, 'We launched the onboarding trial.');
    addMessage('m-ra', RA, 'Onboarding trial sign-off needed.');
    addMessage('m-exc', EXC, 'Onboarding trial excluded talk.');

    const tool = createSearchMessagesTool(ctx(ORG_GRANT));
    const res = await tool.execute('c1', { query: 'onboarding' });

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('m-org');
    expect(text).not.toContain('m-ra');
    expect(text).not.toContain('m-exc');
  });

  it('model-supplied channelIds cannot broaden scope', async () => {
    addMessage('m-org', ORG, 'onboarding note');
    addMessage('m-ra', RA, 'onboarding secret');
    const tool = createSearchMessagesTool(ctx(ORG_GRANT));
    const res = await tool.execute('c1', { query: 'onboarding', channelIds: [RA] });
    expect(res.details.resultIds).toEqual([]);
  });

  it('clamps an oversized limit and rejects an invalid timestamp', async () => {
    addMessage('m-org', ORG, 'onboarding');
    const tool = createSearchMessagesTool(ctx(ORG_GRANT));
    const res = await tool.execute('c1', { query: 'onboarding', limit: 999 });
    expect(res.details.resultIds.length).toBeLessThanOrEqual(20);
    await expect(tool.execute('c1', { query: 'onboarding', before: 'not-a-date' })).rejects.toThrow(
      /ISO 8601/,
    );
  });

  it('truncates results against the per-run character budget and reports it', async () => {
    // Several matching org messages; a tiny budget forces truncation.
    for (let i = 0; i < 6; i++) addMessage(`m-${i}`, ORG, `onboarding trial detail number ${i}`);
    const tool = createSearchMessagesTool(ctx(ORG_GRANT, 120));
    const res = await tool.execute('c1', { query: 'onboarding' });
    expect(res.details.truncated).toBeGreaterThan(0);
    expect(res.details.resultIds.length).toBeLessThan(6);
    expect(res.details.charsExposed).toBeLessThanOrEqual(120);
  });

  it('accumulates provenance and budget across calls on the same run', async () => {
    addMessage('m-org', ORG, 'onboarding one');
    addMessage('m-ra', RA, 'onboarding two');
    const run = ctx(CHANNEL_A_GRANT);
    const t = createSearchMessagesTool(run);
    await t.execute('c1', { query: 'onboarding' });
    await t.execute('c2', { query: 'onboarding' });
    const prov = run.retrieval.provenance();
    const channels = new Set(prov.channels.map((c) => c.channelId));
    expect(channels.has(ORG)).toBe(true);
    expect(channels.has(RA)).toBe(true);
    // Two calls each exposed content, so budget was consumed twice.
    expect(prov.charsExposed).toBeGreaterThan(0);
  });

  // ---- get_message_context ----------------------------------------

  it('get_message_context returns neighbors for a visible anchor', async () => {
    addMessage('a1', ORG, 'before the anchor', NOW - 2);
    addMessage('anchor', ORG, 'the anchor onboarding', NOW);
    addMessage('a2', ORG, 'after the anchor', NOW + 2);
    const tool = createGetMessageContextTool(ctx(ORG_GRANT));
    const res = await tool.execute('c1', { messageId: 'anchor', beforeCount: 5, afterCount: 5 });
    expect(res.details.visible).toBe(true);
    expect(res.details.messageIds).toContain('anchor');
    expect(res.details.messageIds).toContain('a1');
    expect(res.details.messageIds).toContain('a2');
  });

  it('keeps the anchor when preceding messages exhaust the character budget', async () => {
    // A wide beforeCount plus long neighbors must never spend the whole budget
    // on preceding context and return a window without its subject message.
    for (let i = 0; i < 20; i++) {
      addMessage(`pre-${i}`, ORG, 'x'.repeat(200), NOW - 100 + i);
    }
    addMessage('anchor', ORG, 'the anchor onboarding', NOW);
    const run = ctx(ORG_GRANT, 1200);
    const tool = createGetMessageContextTool(run);
    const res = await tool.execute('c1', { messageId: 'anchor', beforeCount: 20, afterCount: 0 });
    expect(res.details.visible).toBe(true);
    expect(res.details.messageIds).toContain('anchor');
    expect(res.details.truncated).toBeGreaterThan(0);
    expect((res.content[0] as { text: string }).text).toContain('the anchor onboarding');
  });

  it('rejects an out-of-scope anchor generically without revealing existence', async () => {
    addMessage('hidden', RA, 'you cannot see this');
    const run = ctx(ORG_GRANT);
    const tool = createGetMessageContextTool(run);
    const forbidden = await tool.execute('c1', { messageId: 'hidden' });
    const missing = await tool.execute('c2', { messageId: 'does-not-exist' });
    expect(forbidden.details.visible).toBe(false);
    expect(missing.details.visible).toBe(false);
    // Identical generic text — no signal distinguishing missing from forbidden.
    expect((forbidden.content[0] as { text: string }).text).toBe(
      (missing.content[0] as { text: string }).text,
    );
    // No channel recorded for a rejected anchor.
    expect(run.retrieval.provenance().channels).toEqual([]);
  });

  // ---- search_memories / list_memories / get_memory_evidence ------

  describe('with seeded memories', () => {
    let orgMem: string;
    let channelMem: string;

    beforeEach(() => {
      addMessage('e-org', ORG, 'we decided to adopt the onboarding trial');
      addMessage('e-ra', RA, 'restricted onboarding decision evidence');
      // Org-scoped memory from org evidence.
      orgMem = createMemory(env.db, ORG_GRANT, {
        guildId: GUILD,
        type: 'decision',
        statement: 'Adopt the onboarding trial.',
        confidence: 0.8,
        importance: 0.7,
        evidence: [ev('e-org')],
        now: NOW,
      });
      // Channel-A-scoped memory from restricted evidence.
      channelMem = createMemory(env.db, CHANNEL_A_GRANT, {
        guildId: GUILD,
        type: 'decision',
        statement: 'Restricted onboarding sign-off.',
        confidence: 0.7,
        importance: 0.6,
        evidence: [ev('e-ra')],
        now: NOW,
      });
    });

    it('search_memories never returns a memory outside the run scope', async () => {
      const orgTool = createSearchMemoriesTool(ctx(ORG_GRANT));
      const orgRes = await orgTool.execute('c1', { query: 'onboarding' });
      // An org grant must not see the channel-A-scoped memory.
      expect(orgRes.details.resultIds).toContain(orgMem);
      expect(orgRes.details.resultIds).not.toContain(channelMem);

      const aTool = createSearchMemoriesTool(ctx(CHANNEL_A_GRANT));
      const aRes = await aTool.execute('c1', { query: 'onboarding' });
      expect(aRes.details.resultIds).toContain(channelMem);
    });

    it('browses top active permitted memories with the reserved wildcard query', async () => {
      const orgTool = createSearchMemoriesTool(ctx(ORG_GRANT));
      const orgRes = await orgTool.execute('c1', { query: '*' });
      expect(orgRes.details.resultIds).toContain(orgMem);
      expect(orgRes.details.resultIds).not.toContain(channelMem);

      const channelTool = createSearchMemoriesTool(ctx(CHANNEL_A_GRANT));
      const channelRes = await channelTool.execute('c2', { query: '*' });
      expect(channelRes.details.resultIds).toContain(orgMem);
      expect(channelRes.details.resultIds).toContain(channelMem);
    });

    it('lists top active memories without a query and preserves run scope', async () => {
      const orgTool = createListMemoriesTool(ctx(ORG_GRANT));
      const orgRes = await orgTool.execute('c1', {});
      expect(orgRes.details.resultIds).toContain(orgMem);
      expect(orgRes.details.resultIds).not.toContain(channelMem);
      expect(orgRes.details).toMatchObject({ totalMatching: 1, returned: 1, hasMore: false });
      expect((orgRes.content[0] as { text: string }).text).toContain('Showing 1 of 1');

      const run = ctx(CHANNEL_A_GRANT);
      const channelTool = createListMemoriesTool(run);
      const channelRes = await channelTool.execute('c2', { types: ['decision'], statuses: ['active'] });
      expect(channelRes.details.resultIds).toContain(orgMem);
      expect(channelRes.details.resultIds).toContain(channelMem);
      expect(run.retrieval.provenance().memoryScopes.map((scope) => scope.source)).toContain(
        'memory_list',
      );
      expect(run.retrieval.provenance().channels).toContainEqual({
        channelId: RA,
        source: 'memory_list',
      });
    });

    it('records exposed memory scopes and channels as provenance', async () => {
      const run = ctx(CHANNEL_A_GRANT);
      const tool = createSearchMemoriesTool(run);
      await tool.execute('c1', { query: 'onboarding' });
      const prov = run.retrieval.provenance();
      const scopes = prov.memoryScopes.map((s) => `${s.scopeType}:${s.scopeKey ?? ''}`);
      expect(scopes).toContain('org:');
      expect(scopes).toContain(`channel:${RA}`);
      // The channel-scoped memory also exposes restricted-A as a channel.
      expect(prov.channels.map((c) => c.channelId)).toContain(RA);
    });

    it('get_memory_evidence returns evidence only for a visible memory', async () => {
      const tool = createGetMemoryEvidenceTool(ctx(CHANNEL_A_GRANT));
      expect(tool.description).toContain('list_memories');
      expect(tool.description).toContain('search_memories');
      const res = await tool.execute('c1', { memoryId: channelMem });
      expect(res.details.evidenceIds).toContain('e-ra');
      expect((res.content[0] as { text: string }).text).toContain(
        `https://discord.com/channels/${GUILD}/${RA}/e-ra`,
      );

      // An org grant cannot see the channel-scoped memory's evidence.
      const orgTool = createGetMemoryEvidenceTool(ctx(ORG_GRANT));
      const blocked = await orgTool.execute('c2', { memoryId: channelMem });
      expect(blocked.details.evidenceIds).toEqual([]);
    });
  });
});
