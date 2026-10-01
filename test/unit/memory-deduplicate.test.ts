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
  normalizeStatement,
  findDuplicateCandidates,
} from '../../src/memory/deduplicate.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const ORG_CH = '100000000000000002';
const REST_CH = '100000000000000099';
const NOW = 1_700_000_000_000;

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
const REST_GRANT: RetrievalGrant = {
  includeOrgMessages: false, includeOrgMemories: false,
  includeReviewOnly: false,
  channelIds: [REST_CH],
};

let env: TestDb;

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

function ev(id: string): MemoryEvidenceInput {
  return { messageId: id, stance: 'origin' };
}

function makeMemory(
  grant: RetrievalGrant,
  type: 'decision' | 'fact' | 'assumption',
  statement: string,
  evidenceIds: string[],
): string {
  return createMemory(env.db, grant, {
    guildId: GUILD,
    type,
    statement,
    confidence: 0.7,
    importance: 0.5,
    evidence: evidenceIds.map(ev),
    now: NOW,
  });
}

describe('statement normalization', () => {
  it('lowercases, strips apostrophes and punctuation, and collapses whitespace', () => {
    expect(normalizeStatement('We decided to Adopt the Trial!')).toBe('we decided to adopt the trial');
    expect(normalizeStatement("Mneme's  plan… (v2)")).toBe('mnemes plan v2');
    expect(normalizeStatement('  Multiple   spaces\tand\nnewlines  ')).toBe('multiple spaces and newlines');
    expect(normalizeStatement('')).toBe('');
  });
});

describe('duplicate candidate detection', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db); // creates ORG_CH as restricted
    env.db.prepare("UPDATE channels SET visibility_class = 'org' WHERE id = ?").run(ORG_CH);
    upsertChannel(env.db, {
      id: REST_CH,
      guildId: GUILD,
      parentId: null,
      kind: 'text',
      name: 'restricted',
      topic: null,
      position: null,
      isThread: false,
      isArchived: false,
      isLocked: false,
      ingestEnabled: true,
      visibilityClass: 'restricted',
      allowInterventions: false,
      permissionFingerprint: null,
      lastMessageId: null,
      discoveredAtMs: NOW,
      updatedAtMs: NOW,
      rawJson: null,
    });
    addMessage('e1', ORG_CH, 'we decided to adopt the onboarding trial');
    addMessage('e2', ORG_CH, 'the trial is going well');
    addMessage('e3', REST_CH, 'private decision evidence');
  });

  it('detects an exact duplicate (same normalized key and type)', () => {
    const id = makeMemory(ORG_GRANT, 'decision', 'Adopt the onboarding trial.', ['e1']);
    const res = findDuplicateCandidates(env.db, ORG_GRANT, {
      statement: 'adopt the onboarding trial.',
      type: 'decision',
    });
    expect(res.hasExact).toBe(true);
    const exact = res.candidates.find((c) => c.matchKind === 'exact');
    expect(exact?.memoryId).toBe(id);
    expect(exact?.normalizedKey).toBe(normalizeStatement('Adopt the onboarding trial.'));
  });

  it('treats casing and punctuation differences as exact', () => {
    makeMemory(ORG_GRANT, 'decision', 'Adopt the onboarding trial!', ['e1']);
    const res = findDuplicateCandidates(env.db, ORG_GRANT, {
      statement: 'ADOPT the onboarding TRIAL.',
      type: 'decision',
    });
    expect(res.hasExact).toBe(true);
    expect(res.candidates[0]!.matchKind).toBe('exact');
  });

  it('keeps unrelated lexical matches as ambiguous, not exact', () => {
    makeMemory(ORG_GRANT, 'decision', 'Adopt the onboarding trial.', ['e1']);
    // Shares tokens (onboarding, trial) but is a different statement.
    const res = findDuplicateCandidates(env.db, ORG_GRANT, {
      statement: 'onboarding trial',
      type: 'decision',
    });
    expect(res.hasExact).toBe(false);
    expect(res.candidates.every((c) => c.matchKind === 'ambiguous')).toBe(true);
    expect(res.candidates.length).toBeGreaterThan(0);
  });

  it('represents same-text different-type matches explicitly as ambiguous', () => {
    makeMemory(ORG_GRANT, 'decision', 'Adopt the onboarding trial.', ['e1']);
    // Same text, but the caller is creating a `fact` — that is uncertain.
    const res = findDuplicateCandidates(env.db, ORG_GRANT, {
      statement: 'Adopt the onboarding trial.',
      type: 'fact',
    });
    expect(res.hasExact).toBe(false);
    const cand = res.candidates.find((c) => c.statement === 'Adopt the onboarding trial.');
    expect(cand?.matchKind).toBe('ambiguous');
  });

  it('never mutates memories and returns nothing for a novel statement', () => {
    const before = env.db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number };
    const res = findDuplicateCandidates(env.db, ORG_GRANT, {
      statement: 'a completely novel unrelated topic zzz',
      type: 'decision',
    });
    const after = env.db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number };
    expect(res.candidates).toEqual([]);
    expect(res.hasExact).toBe(false);
    expect(after.c).toBe(before.c); // read-only: no rows written
  });

  it('excludes candidates outside the grant scope', () => {
    // A memory whose evidence lives in a restricted channel the org grant cannot see.
    const restId = makeMemory(REST_GRANT, 'decision', 'Adopt the onboarding trial.', ['e3']);
    void restId;
    // Same statement, but searched under the org grant — the restricted memory
    // must not surface as a candidate.
    const res = findDuplicateCandidates(env.db, ORG_GRANT, {
      statement: 'Adopt the onboarding trial.',
      type: 'decision',
    });
    expect(res.candidates.find((c) => c.memoryId === restId)).toBeUndefined();
  });

  it('sorts exact matches ahead of ambiguous ones', () => {
    makeMemory(ORG_GRANT, 'assumption', 'onboarding trial is risky', ['e2']); // ambiguous neighbor
    makeMemory(ORG_GRANT, 'decision', 'Adopt the onboarding trial.', ['e1']); // exact
    const res = findDuplicateCandidates(env.db, ORG_GRANT, {
      statement: 'Adopt the onboarding trial.',
      type: 'decision',
    });
    expect(res.candidates[0]!.matchKind).toBe('exact');
  });
});
