import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  createMemory,
  getMemory,
  type RetrievalGrant,
  type MemoryEvidenceInput,
} from '../../src/memory/repository.js';
import { rescopeMemories, type ScopeChange } from '../../src/memory/maintenance.js';
import { createRescopeMemoriesHandler } from '../../src/jobs/handlers/rescope-memories.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const NOW = 1_700_000_001_000;
const ACTOR = 'system-mneme';

let env: TestDb;

function seedChannel(id: string, visibility: 'org' | 'restricted' | 'review_only'): void {
  upsertChannel(env.db, {
    id,
    guildId: GUILD,
    parentId: null,
    type: 0,
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

function reclassify(channelId: string, visibility: 'org' | 'restricted' | 'review_only'): void {
  env.db
    .prepare('UPDATE channels SET visibility_class = ?, updated_at_ms = ? WHERE id = ?')
    .run(visibility, NOW + 1, channelId);
}

function ev(messageId: string): MemoryEvidenceInput {
  return { messageId, stance: 'origin' };
}

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };

function adminEvents(): Array<{ action: string; target: string | null; details_json: string }> {
  return env.db
    .prepare('SELECT action, target, details_json FROM admin_events ORDER BY created_at_ms')
    .all() as Array<{ action: string; target: string | null; details_json: string }>;
}

describe('memory re-scope maintenance', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
  });

  it('tightens a cached scope when its evidence channel is reclassified org→restricted', () => {
    seedChannel('org-a', 'org');
    seedChannel('org-b', 'org');
    addMessage('e-a', 'org-a', 'we decided to adopt the trial');
    addMessage('e-b', 'org-b', 'unrelated decision evidence');

    const memA = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Adopt the onboarding trial.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [ev('e-a')],
      now: NOW,
    });
    const memB = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'fact',
      statement: 'Unrelated org fact.',
      confidence: 0.6,
      importance: 0.4,
      evidence: [ev('e-b')],
      now: NOW,
    });
    expect(getMemory(env.db, memA)?.scope_type).toBe('org');

    // Reclassify org-a to restricted; rescope only affected memories.
    reclassify('org-a', 'restricted');
    const result = rescopeMemories(env.db, {
      affectedChannelIds: ['org-a'],
      actorUserId: ACTOR,
      guildId: GUILD,
      now: NOW + 2,
    });

    expect(result.scanned).toBe(1);
    expect(result.changed).toBe(1);
    const a = getMemory(env.db, memA);
    expect(a?.scope_type).toBe('channel');
    expect(a?.scope_key).toBe('org-a');
    // The unrelated memory is untouched.
    expect(getMemory(env.db, memB)?.scope_type).toBe('org');
  });

  it('records an admin_event for every material change and none when converged', () => {
    seedChannel('org-a', 'org');
    addMessage('e-a', 'org-a', 'decision evidence');
    const memA = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'A decision.',
      confidence: 0.7,
      importance: 0.5,
      evidence: [ev('e-a')],
      now: NOW,
    });

    reclassify('org-a', 'restricted');
    const first = rescopeMemories(env.db, {
      affectedChannelIds: ['org-a'],
      actorUserId: ACTOR,
      guildId: GUILD,
      now: NOW + 2,
    });
    expect(first.changes).toHaveLength(1);
    const change: ScopeChange = first.changes[0]!;
    expect(change.from.scopeType).toBe('org');
    expect(change.to.scopeType).toBe('channel');

    const events = adminEvents().filter((e) => e.action === 'memory_rescope');
    expect(events).toHaveLength(1);
    expect(events[0]!.target).toBe(memA);
    const details = JSON.parse(events[0]!.details_json);
    expect(details.from.scopeType).toBe('org');
    expect(details.to.scopeType).toBe('channel');

    // Re-running is idempotent: the cache already matches policy.
    const second = rescopeMemories(env.db, {
      affectedChannelIds: ['org-a'],
      actorUserId: ACTOR,
      guildId: GUILD,
      now: NOW + 3,
    });
    expect(second.changed).toBe(0);
    expect(adminEvents().filter((e) => e.action === 'memory_rescope')).toHaveLength(1);
  });

  it('collapses to review_only when evidence spreads across multiple restricted channels', () => {
    seedChannel('org-a', 'org');
    seedChannel('org-b', 'org');
    addMessage('e-a', 'org-a', 'shared decision part one');
    addMessage('e-b', 'org-b', 'shared decision part two');
    const mem = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Shared cross-channel decision.',
      confidence: 0.7,
      importance: 0.6,
      evidence: [ev('e-a'), ev('e-b')],
      now: NOW,
    });
    // Two org channels → org scope at creation.
    expect(getMemory(env.db, mem)?.scope_type).toBe('org');

    reclassify('org-a', 'restricted');
    reclassify('org-b', 'restricted');
    rescopeMemories(env.db, {
      affectedChannelIds: null, // full rescope on policy reload
      actorUserId: ACTOR,
      guildId: GUILD,
      now: NOW + 2,
    });

    // Evidence now spans two distinct restricted channels → review_only.
    const m = getMemory(env.db, mem);
    expect(m?.scope_type).toBe('review_only');
    expect(m?.scope_key).toBeNull();
  });

  it('does not automatically widen a stored channel scope after policy broadens', () => {
    seedChannel('restricted-a', 'restricted');
    addMessage('e-restricted', 'restricted-a', 'restricted decision evidence');
    const restrictedGrant: RetrievalGrant = {
      includeOrgMessages: false,
      includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: ['restricted-a'],
    };
    const memoryId = createMemory(env.db, restrictedGrant, {
      guildId: GUILD,
      type: 'decision',
      statement: 'A restricted decision.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [ev('e-restricted')],
      now: NOW,
    });

    reclassify('restricted-a', 'org');
    const result = rescopeMemories(env.db, {
      affectedChannelIds: ['restricted-a'],
      actorUserId: ACTOR,
      guildId: GUILD,
      now: NOW + 2,
    });

    expect(result.changed).toBe(0);
    expect(getMemory(env.db, memoryId)).toMatchObject({
      scope_type: 'channel',
      scope_key: 'restricted-a',
    });
  });

  it('the maintenance job handler rescopes every memory on a full reload', async () => {
    seedChannel('org-a', 'org');
    seedChannel('org-b', 'org');
    addMessage('e-a', 'org-a', 'one');
    addMessage('e-b', 'org-b', 'two');
    createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'A.',
      confidence: 0.7,
      importance: 0.5,
      evidence: [ev('e-a')],
      now: NOW,
    });
    createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'B.',
      confidence: 0.7,
      importance: 0.5,
      evidence: [ev('e-b')],
      now: NOW,
    });

    reclassify('org-a', 'restricted');
    reclassify('org-b', 'restricted');

    const handler = createRescopeMemoriesHandler({
      db: env.db,
      guildId: GUILD,
      actorUserId: ACTOR,
      now: () => NOW + 5,
    });
    const { result } = await handler.runRescope();

    // Each memory's evidence lives in exactly one (now-restricted) channel, so
    // each tightens from org to a distinct channel scope.
    expect(result.scanned).toBe(2);
    expect(result.changed).toBe(2);
    expect(result.changes.every((c) => c.to.scopeType === 'channel')).toBe(true);
    expect(new Set(result.changes.map((c) => c.to.scopeKey))).toEqual(new Set(['org-a', 'org-b']));
    expect(adminEvents().filter((e) => e.action === 'memory_rescope')).toHaveLength(2);
  });
});
