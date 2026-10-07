// ABOUTME: Tests that archive ids never enter durable memory (plan 011 step 7): no archive evidence, no archive memory target.
// ABOUTME: Each rejection carries a precise reason and leaves the memories table unchanged.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../../helpers/db.js';
import { upsertMessageCreate } from '../../../src/db/repositories/messages.js';
import type { RetrievalGrant } from '../../../src/db/repositories/message-search.js';
import { applyMemoryProposals, type AgentMemoryProposal } from '../../../src/agent/memory-policy.js';
import { archiveCitationReasons } from '../../../src/outbound/message-safety.js';

const NOW = 1_700_000_001_000;
const ARCHIVE_MESSAGE = 'archive:300000000000000110';
const ARCHIVE_MEMORY = 'archive:archive-memory-org';
const GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };

let env: TestDb & { guildId: string; channelId: string; userId: string };

beforeEach(() => {
  const base = createTestDb();
  env = { ...base, ...seedIdentity(base.db) };
  env.db.prepare("UPDATE channels SET visibility_class = 'org' WHERE id = ?").run(env.channelId);
  upsertMessageCreate(env.db, {
    id: 'm1', guildId: env.guildId, channelId: env.channelId, authorId: env.userId, authorDisplayName: 'Alice',
    content: 'We decided to move billing to Postgres.', createdAtMs: NOW, editedAtMs: null, replyToMessageId: null,
    messageType: 0, flags: null, pinned: false, mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]',
    componentsJson: '[]', pollJson: null, rawJson: null, ingestedAtMs: NOW, updatedAtMs: NOW,
  });
});
afterEach(() => env.cleanup());

function proposal(over: Partial<AgentMemoryProposal> & { action: AgentMemoryProposal['action'] }): AgentMemoryProposal {
  return {
    type: 'decision',
    statement: 'We decided to move billing to Postgres.',
    confidence: 0.8,
    importance: 0.7,
    evidenceMessageIds: ['m1'],
    evidenceQuotes: [{ messageId: 'm1', quote: 'We decided to move billing to Postgres.' }],
    durability: 'project',
    durabilityReason: 'This affects future project work.',
    ...over,
  };
}

function apply(p: AgentMemoryProposal) {
  return applyMemoryProposals({
    db: env.db, grant: GRANT, guildId: env.guildId, runId: 'run-1', now: NOW,
    exposedChannelIds: new Set([env.channelId]), exposedMessageIds: new Set(['m1']), exposedMemoryIds: new Set(),
  }, [p]);
}

function memoryCount(): number {
  return (env.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
}

describe('archive ids in durable memory', () => {
  it('rejects a memory proposal with archive evidence', () => {
    const out = apply(proposal({
      action: 'create',
      evidenceMessageIds: ['m1', ARCHIVE_MESSAGE],
      evidenceQuotes: [
        { messageId: 'm1', quote: 'We decided to move billing to Postgres.' },
        { messageId: ARCHIVE_MESSAGE, quote: 'billing decision' },
      ],
    }));
    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('archive_evidence_not_durable');
    expect(memoryCount()).toBe(0);
  });

  it.each(['update', 'supersede', 'confirm'] as const)('rejects %s on an archive memory', (action) => {
    const out = apply(proposal({ action, existingMemoryId: ARCHIVE_MEMORY }));
    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('archive_memory_read_only');
    expect(memoryCount()).toBe(0);
  });
});

describe('archive citations outside direct answers', () => {
  it('names an archive evidence id and an archive marker precisely', () => {
    expect(archiveCitationReasons('intervention', 'Old plan.', ['m1', ARCHIVE_MESSAGE]))
      .toEqual([`interventions cannot cite the platform archive: ${ARCHIVE_MESSAGE}`]);
    expect(archiveCitationReasons('scheduled notification', `See [[cite:${ARCHIVE_MESSAGE}]].`, ['m1']))
      .toEqual([`scheduled notifications cannot cite the platform archive: ${ARCHIVE_MESSAGE}`]);
    expect(archiveCitationReasons('intervention', 'Plain text [[cite:m1]].', ['m1'])).toEqual([]);
  });
});
