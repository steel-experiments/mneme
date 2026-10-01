import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  createMemory,
  confirmMemory,
  updateMemory,
  supersedeMemory,
  resolveMemory,
  invalidateMemory,
  getMemory,
  MemoryValidationError,
  type RetrievalGrant,
  type MemoryEvidenceInput,
} from '../../src/memory/repository.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const NOW = 1_700_000_001_000;

let env: TestDb;

type Vis = 'org' | 'restricted' | 'review_only' | 'excluded';
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

function addMessage(id: string, channel: string, content = 'evidence', atMs = NOW): void {
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

const ORG = 'org-c';
const RA = 'restricted-A';
const RB = 'restricted-B';

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
const CHANNEL_A_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RA],
};
const CHANNEL_AB_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RA, RB],
};

function ev(messageId: string, stance: MemoryEvidenceInput['stance'] = 'origin'): MemoryEvidenceInput {
  return { messageId, stance };
}

describe('memory mutations', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    seedChannel(ORG, 'org');
    seedChannel(RA, 'restricted');
    seedChannel(RB, 'restricted');
    addMessage('e-org', ORG, 'we decided to adopt the trial');
    addMessage('e-ra', RA, 'restricted decision evidence');
    addMessage('e-rb', RB, 'other restricted evidence');
  });

  it('creates an active org-scoped memory from org evidence', () => {
    const id = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Adopt the onboarding trial.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [ev('e-org')],
      now: NOW,
    });
    const m = getMemory(env.db, id);
    expect(m?.status).toBe('active');
    expect(m?.scope_type).toBe('org');
    expect(m?.scope_key).toBeNull();
    expect(m?.normalized_key).toBe('adopt the onboarding trial.');
    const link = env.db
      .prepare('SELECT stance FROM memory_evidence WHERE memory_id = ?')
      .get(id) as { stance: string };
    expect(link.stance).toBe('origin');
  });

  it('scopes a restricted-evidence memory to that channel', () => {
    const id = createMemory(env.db, CHANNEL_A_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Restricted channel decision.',
      confidence: 0.7,
      importance: 0.6,
      evidence: [ev('e-org'), ev('e-ra')],
      now: NOW,
    });
    const m = getMemory(env.db, id);
    expect(m?.scope_type).toBe('channel');
    expect(m?.scope_key).toBe(RA);
  });

  it('collapses to review_only when evidence spans two restricted channels', () => {
    const id = createMemory(env.db, CHANNEL_AB_GRANT, {
      guildId: GUILD,
      type: 'risk',
      statement: 'Cross-channel risk.',
      confidence: 0.6,
      importance: 0.6,
      evidence: [ev('e-ra'), ev('e-rb')],
      now: NOW,
    });
    const m = getMemory(env.db, id);
    expect(m?.scope_type).toBe('review_only');
    expect(m?.scope_key).toBeNull();
  });

  it('rejects creation with no evidence', () => {
    expect(() =>
      createMemory(env.db, ORG_GRANT, {
        guildId: GUILD,
        type: 'fact',
        statement: 'No evidence.',
        confidence: 0.5,
        importance: 0.5,
        evidence: [],
        now: NOW,
      }),
    ).toThrowError(MemoryValidationError);
  });

  it('rejects cross-scope evidence (evidence not visible to the grant)', () => {
    // ORG grant cannot see restricted-A evidence.
    expect(() =>
      createMemory(env.db, ORG_GRANT, {
        guildId: GUILD,
        type: 'decision',
        statement: 'Sneaky restricted evidence.',
        confidence: 0.7,
        importance: 0.7,
        evidence: [ev('e-ra')],
        now: NOW,
      }),
    ).toThrowError(MemoryValidationError);
  });

  it('rejects nonexistent / deleted evidence messages', () => {
    expect(() =>
      createMemory(env.db, ORG_GRANT, {
        guildId: GUILD,
        type: 'fact',
        statement: 'Phantom evidence.',
        confidence: 0.5,
        importance: 0.5,
        evidence: [ev('does-not-exist')],
        now: NOW,
      }),
    ).toThrowError(MemoryValidationError);

    env.db.prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?').run(NOW + 1, 'e-org');
    expect(() =>
      createMemory(env.db, ORG_GRANT, {
        guildId: GUILD,
        type: 'fact',
        statement: 'Deleted evidence.',
        confidence: 0.5,
        importance: 0.5,
        evidence: [ev('e-org')],
        now: NOW + 2,
      }),
    ).toThrowError(MemoryValidationError);
  });

  it('rejects invalid type, out-of-range confidence, overlong statement, unknown owner', () => {
    const base = {
      guildId: GUILD,
      statement: 'ok',
      confidence: 0.5,
      importance: 0.5,
      evidence: [ev('e-org')],
      now: NOW,
    } as const;
    expect(() =>
      createMemory(env.db, ORG_GRANT, { ...base, type: 'bogus' as never }),
    ).toThrowError(MemoryValidationError);
    expect(() =>
      createMemory(env.db, ORG_GRANT, { ...base, type: 'fact', confidence: 1.5 }),
    ).toThrowError(MemoryValidationError);
    expect(() =>
      createMemory(env.db, ORG_GRANT, { ...base, type: 'fact', statement: 'x'.repeat(1201) }),
    ).toThrowError(MemoryValidationError);
    expect(() =>
      createMemory(env.db, ORG_GRANT, { ...base, type: 'fact', ownerUserId: 'no-such-user' }),
    ).toThrowError(MemoryValidationError);
  });

  it('confirms an active memory and refreshes the timestamp', () => {
    const id = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'assumption',
      statement: 'Assume X.',
      confidence: 0.6,
      importance: 0.5,
      evidence: [ev('e-org')],
      now: NOW,
    });
    confirmMemory(env.db, ORG_GRANT, { memoryId: id, evidence: [ev('e-org', 'supports')], now: NOW + 1000 });
    const m = getMemory(env.db, id);
    expect(m?.last_confirmed_at_ms).toBe(NOW + 1000);
    expect(m?.status).toBe('active');
    const stances = (
      env.db
        .prepare('SELECT stance FROM memory_evidence WHERE memory_id = ? ORDER BY stance')
        .all(id) as { stance: string }[]
    ).map((r) => r.stance);
    expect(stances).toEqual(['origin', 'supports']);
  });

  it('updates a memory and recomputes scope from all evidence', () => {
    const id = createMemory(env.db, CHANNEL_A_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'First take.',
      confidence: 0.6,
      importance: 0.5,
      evidence: [ev('e-org')],
      now: NOW,
    });
    // First created with org-only evidence → org scope.
    expect(getMemory(env.db, id)?.scope_type).toBe('org');

    // Add restricted-A evidence via update → scope narrows to channel A.
    updateMemory(env.db, CHANNEL_A_GRANT, {
      memoryId: id,
      statement: 'Revised take.',
      confidence: 0.75,
      evidence: [ev('e-ra', 'updates')],
      now: NOW + 500,
    });
    const m = getMemory(env.db, id);
    expect(m?.statement).toBe('Revised take.');
    expect(m?.confidence).toBeCloseTo(0.75);
    expect(m?.scope_type).toBe('channel');
    expect(m?.scope_key).toBe(RA);
  });

  it('supersedes: old memory becomes superseded, new is active, link recorded', () => {
    const oldId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Old decision.',
      confidence: 0.5,
      importance: 0.5,
      evidence: [ev('e-org')],
      now: NOW,
    });
    const newId = supersedeMemory(env.db, ORG_GRANT, {
      existingMemoryId: oldId,
      guildId: GUILD,
      type: 'decision',
      statement: 'New decision.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [ev('e-org')],
      now: NOW + 100,
    });
    expect(getMemory(env.db, oldId)?.status).toBe('superseded');
    const neu = getMemory(env.db, newId);
    expect(neu?.status).toBe('active');
    expect(neu?.supersedes_memory_id).toBe(oldId);
    const link = env.db
      .prepare('SELECT relation FROM memory_links WHERE source_memory_id = ? AND target_memory_id = ?')
      .get(newId, oldId) as { relation: string };
    expect(link.relation).toBe('supersedes');
  });

  it('resolves and invalidates active memories', () => {
    const a = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'prediction',
      statement: 'Will ship.',
      confidence: 0.6,
      importance: 0.5,
      evidence: [ev('e-org')],
      now: NOW,
    });
    resolveMemory(env.db, ORG_GRANT, { memoryId: a, evidence: [ev('e-org', 'resolves')], now: NOW + 1 });
    expect(getMemory(env.db, a)?.status).toBe('resolved');
    expect(getMemory(env.db, a)?.resolved_at_ms).toBe(NOW + 1);

    const b = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'assumption',
      statement: 'Wrong assumption.',
      confidence: 0.6,
      importance: 0.5,
      evidence: [ev('e-org')],
      now: NOW,
    });
    invalidateMemory(env.db, ORG_GRANT, {
      memoryId: b,
      evidence: [ev('e-org', 'contradicts')],
      now: NOW + 2,
    });
    expect(getMemory(env.db, b)?.status).toBe('invalidated');
  });

  it('rejects lifecycle transitions from the wrong source status', () => {
    const id = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'fact',
      statement: 'Temp fact.',
      confidence: 0.5,
      importance: 0.5,
      evidence: [ev('e-org')],
      now: NOW,
    });
    resolveMemory(env.db, ORG_GRANT, { memoryId: id, evidence: [ev('e-org', 'resolves')], now: NOW + 1 });
    // Already resolved → cannot confirm or resolve again.
    expect(() =>
      confirmMemory(env.db, ORG_GRANT, { memoryId: id, evidence: [ev('e-org', 'supports')], now: NOW + 2 }),
    ).toThrowError(MemoryValidationError);
    expect(() =>
      invalidateMemory(env.db, ORG_GRANT, {
        memoryId: id,
        evidence: [ev('e-org', 'contradicts')],
        now: NOW + 3,
      }),
    ).toThrowError(MemoryValidationError);
  });

  it('cannot supersede a non-active memory', () => {
    const oldId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Done decision.',
      confidence: 0.5,
      importance: 0.5,
      evidence: [ev('e-org')],
      now: NOW,
    });
    resolveMemory(env.db, ORG_GRANT, { memoryId: oldId, evidence: [ev('e-org', 'resolves')], now: NOW + 1 });
    expect(() =>
      supersedeMemory(env.db, ORG_GRANT, {
        existingMemoryId: oldId,
        guildId: GUILD,
        type: 'decision',
        statement: 'Replacement.',
        confidence: 0.7,
        importance: 0.6,
        evidence: [ev('e-org')],
        now: NOW + 2,
      }),
    ).toThrowError(MemoryValidationError);
  });
});
