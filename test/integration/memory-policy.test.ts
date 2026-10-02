import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { upsertUser } from '../../src/db/repositories/users.js';
import { createMemory, getMemory } from '../../src/memory/repository.js';
import { searchMemories } from '../../src/memory/search.js';
import { searchMessages, type RetrievalGrant } from '../../src/db/repositories/message-search.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { grantForSecureReview } from '../../src/production-runtime.js';
import {
  applyMemoryProposals,
  type AgentMemoryProposal,
  type ApplyMemoryProposalsDeps,
} from '../../src/agent/memory-policy.js';
import { claimRevision } from '../../src/memory/attention-repository.js';
import { DEADLINE_PARSER_VERSION } from '../../src/memory/deadline-evidence.js';

/**
 * Evidence and memory-proposal host validation (Sections 7, 12.2, 12.3, 23).
 *
 * Acceptance: invented, invisible, deleted, or insufficient evidence produces no
 * memory mutation and an auditable rejection. The host — not the model — owns
 * scope and exposure.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded, restricted
const ALICE = '100000000000000003'; // seeded human
const BOB = '100000000000000010';
const NOW = 1_700_000_001_000;

/** A grant that permits the seeded restricted channel plus org channels. */
const GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [CHANNEL],
};

let env: TestDb;

beforeEach(() => {
  env = createTestDb();
  exposedMemoryIds = new Set<string>();
  seedIdentity(env.db);
  upsertUser(env.db, {
    id: BOB,
    username: 'bob',
    globalName: 'Bob',
    isBot: false,
    firstSeenAtMs: NOW,
    lastSeenAtMs: NOW,
    rawJson: null,
  });
});
afterEach(() => env.cleanup());

function seedMessage(id: string, channel: string, content = 'Adopt the onboarding trial.'): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: channel,
    authorId: ALICE,
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

/** Seed a second restricted channel so exposure/visibility can be distinguished. */
function seedRestrictedChannel(id: string): void {
  seedPolicyChannel(id, 'restricted');
}

function seedPolicyChannel(
  id: string,
  visibility: 'org' | 'restricted',
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

let exposedMemoryIds = new Set<string>();

function makeDeps(exposedChannelIds: ReadonlySet<string>, grant: RetrievalGrant = GRANT): ApplyMemoryProposalsDeps {
  const exposedMessageIds = new Set((env.db.prepare(
    `SELECT id FROM messages WHERE channel_id IN (${[...exposedChannelIds].map(() => '?').join(',') || "''"})`,
  ).all(...exposedChannelIds) as Array<{ id: string }>).map((row) => row.id));
  return {
    db: env.db,
    grant,
    guildId: GUILD,
    runId: 'run-1',
    now: NOW,
    exposedChannelIds,
    exposedMessageIds,
    exposedMemoryIds,
  };
}

function createProposal(over: Partial<AgentMemoryProposal> & { action: AgentMemoryProposal['action'] }): AgentMemoryProposal {
  const evidenceMessageIds = over.evidenceMessageIds ?? ['m1'];
  return {
    type: 'decision',
    statement: 'Adopt the onboarding trial.',
    confidence: 0.8,
    importance: 0.7,
    evidenceMessageIds,
    evidenceQuotes: evidenceMessageIds.map((messageId) => ({
      messageId,
      quote: (env.db.prepare('SELECT content FROM messages WHERE id=?').get(messageId) as { content: string } | undefined)?.content ?? 'unsupported',
    })),
    durability: 'project',
    durabilityReason: 'This affects future project work.',
    ...over,
  };
}

/** Seed a target memory to act on with lifecycle proposals. Returns its id. */
function seedTargetMemory(evidenceId = 'm1'): string {
  seedMessage(evidenceId, CHANNEL, 'we decided');
  const id = createMemory(env.db, GRANT, {
    guildId: GUILD,
    type: 'decision',
    statement: 'Earlier decision.',
    confidence: 0.5,
    importance: 0.5,
    evidence: [{ messageId: evidenceId, stance: 'origin' }],
    createdByRunId: 'run-0',
    now: NOW,
  });
  exposedMemoryIds.add(id);
  return id;
}

describe('applyMemoryProposals — accepted proposals mutate memory', () => {
  it('creates a memory from valid, exposed evidence', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.applied).toHaveLength(1);
    expect(out.rejected).toHaveLength(0);
    const id = out.applied[0]!.memoryId!;
    const mem = getMemory(env.db, id);
    expect(mem).toBeDefined();
    expect(mem!.type).toBe('decision');
    expect(mem!.created_by_run_id).toBe('run-1');
  });

  it('applies confirm/update/resolve/invalidate/supersede against an existing target', () => {
    const targetId = seedTargetMemory('m1');
    const exposed = new Set([CHANNEL]);

    // confirm
    seedMessage('m2', CHANNEL, 'confirms');
    let out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({ action: 'confirm', existingMemoryId: targetId, evidenceMessageIds: ['m2'] }),
    ]);
    expect(out.applied[0]!.memoryId).toBe(targetId);

    // update
    seedMessage('m3', CHANNEL, 'Updated statement.');
    out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({
        action: 'update',
        existingMemoryId: targetId,
        statement: 'Updated statement.',
        confidence: 0.9,
        evidenceMessageIds: ['m3'],
      }),
    ]);
    expect(out.applied[0]!.memoryId).toBe(targetId);
    expect(getMemory(env.db, targetId)!.confidence).toBe(0.9);

    // resolve
    seedMessage('m4', CHANNEL, 'resolves');
    out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({ action: 'resolve', existingMemoryId: targetId, evidenceMessageIds: ['m4'] }),
    ]);
    expect(out.applied[0]!.accepted).toBe(true);
    expect(getMemory(env.db, targetId)!.status).toBe('resolved');

    // re-seed an active target for invalidate
    const t2 = seedTargetMemory('m5');
    out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({ action: 'invalidate', existingMemoryId: t2, evidenceMessageIds: ['m5'] }),
    ]);
    expect(getMemory(env.db, t2)!.status).toBe('invalidated');

    // supersede
    const t3 = seedTargetMemory('m6');
    out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({
        action: 'supersede',
        existingMemoryId: t3,
        statement: 'We decided.',
        evidenceMessageIds: ['m6'],
      }),
    ]);
    expect(out.applied[0]!.memoryId).not.toBe(t3);
    expect(getMemory(env.db, t3)!.status).toBe('superseded');
  });
});

describe('applyMemoryProposals — rejected evidence produces no mutation', () => {
  it('rejects an UPDATE that could copy restricted run content into an org memory', () => {
    const orgChannel = '100000000000000041';
    seedRestrictedChannel(orgChannel);
    env.db.prepare("UPDATE channels SET visibility_class='org' WHERE id=?").run(orgChannel);
    seedMessage('org-origin', orgChannel, 'The public rollout remains unchanged.');
    seedMessage('restricted-update-source', CHANNEL, 'The restricted launch condition changed.');
    seedMessage('org-update-citation', orgChannel, 'Public follow-up evidence.');
    const targetId = createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'The public rollout remains unchanged.',
      confidence: 0.8,
      importance: 0.8,
      evidence: [{ messageId: 'org-origin', stance: 'origin' }],
      now: NOW,
    });
    exposedMemoryIds.add(targetId);

    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL, orgChannel])), [
      createProposal({
        action: 'update',
        existingMemoryId: targetId,
        statement: 'The restricted launch condition changed.',
        evidenceMessageIds: ['org-update-citation'],
      }),
    ]);

    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('evidence_out_of_scope');
    expect(getMemory(env.db, targetId)?.statement).toBe('The public rollout remains unchanged.');
  });

  it('rejects an org memory created after a restricted memory was exposed', () => {
    const orgChannel = '100000000000000040';
    seedRestrictedChannel(orgChannel);
    env.db.prepare("UPDATE channels SET visibility_class='org' WHERE id=?").run(orgChannel);
    seedMessage('restricted-source', CHANNEL, 'restricted source');
    seedMessage('org-citation', orgChannel, 'public citation');
    const restrictedMemory = createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Restricted statement.',
      confidence: 0.8,
      importance: 0.8,
      evidence: [{ messageId: 'restricted-source', stance: 'origin' }],
      now: NOW,
    });
    exposedMemoryIds.add(restrictedMemory);

    const out = applyMemoryProposals(makeDeps(new Set([orgChannel])), [
      createProposal({ action: 'create', statement: 'Restricted paraphrase.', evidenceMessageIds: ['org-citation'] }),
    ]);
    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('evidence_out_of_scope');
  });

  it('rejects invented evidence and creates no memory', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1', 'invented-id'] }),
    ]);
    expect(out.applied).toHaveLength(0);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reason).toBe('invented_evidence');
    expect(out.rejected[0]!.detail).toContain('invented-id');
    // No memory row was created.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('rejects deleted evidence and creates no memory', () => {
    seedMessage('m1', CHANNEL);
    env.db.prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?').run(NOW, 'm1');
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('deleted_evidence');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('rejects evidence the model did not see this run (a guessed-but-real id)', () => {
    // A second restricted channel whose message is real and visible under the
    // grant, but was NOT exposed to the model this run.
    seedRestrictedChannel('100000000000000020');
    seedMessage('m-secret', '100000000000000020', 'hidden context');
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m-secret'] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('evidence_not_exposed');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('rejects invisible (out-of-scope) evidence via the repository scope check', () => {
    // Evidence that exists, is undeleted, and is in the exposure set, but whose
    // channel the grant does not permit. The policy pre-checks pass; the
    // repository's scope authority rejects it. (In production exposure is a
    // subset of grant-visibility; this test isolates the repository gate.)
    seedRestrictedChannel('100000000000000030');
    seedMessage('m-oos', '100000000000000030', 'out of scope');
    const out = applyMemoryProposals(
      makeDeps(
        new Set([CHANNEL, '100000000000000030']),
        { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [CHANNEL] }, // grant excludes 030
      ),
      [createProposal({ action: 'create', evidenceMessageIds: ['m-oos'] })],
    );
    expect(out.rejected[0]!.reason).toBe('evidence_out_of_scope');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('rejects a proposal with no evidence', () => {
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: [] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('no_evidence');
  });
});

describe('applyMemoryProposals — restricted citation anchors', () => {
  const PARENT = '100000000000000060';
  const THREAD = '100000000000000061';
  const SIBLING = '100000000000000062';
  const ORG_MESSAGE = 'mixed-org-message';
  const THREAD_MESSAGE = 'mixed-thread-message';

  function seedMixedThreadFixture() {
    seedPolicyChannel(PARENT, 'org');
    seedPolicyChannel(THREAD, 'restricted', { parentId: PARENT, isThread: true });
    seedPolicyChannel(SIBLING, 'restricted', { parentId: PARENT, isThread: true });
    seedMessage(ORG_MESSAGE, PARENT, 'Project launch timeline was reviewed.');
    seedMessage(THREAD_MESSAGE, THREAD, 'Project launch credential is raven.');
    seedMessage('mixed-sibling-message', SIBLING, 'Project launch credential is raven.');
    const grant = grantForSecureReview(env.db, ['org', 'restricted']);
    const results = searchMessages(env.db, grant, { query: 'project launch', limit: 20, now: NOW });
    return {
      grant,
      exposedChannelIds: new Set(results.map((row) => row.channelId)),
      exposedMessageIds: new Set(results.map((row) => row.messageId)),
    };
  }

  function seedOrgTarget(grant: RetrievalGrant): string {
    const id = createMemory(env.db, grant, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Project launch timeline was reviewed.',
      confidence: 0.8,
      importance: 0.8,
      evidence: [{ messageId: ORG_MESSAGE, stance: 'origin' }],
      createdByRunId: 'run-0',
      now: NOW,
    });
    exposedMemoryIds.add(id);
    return id;
  }

  function mixedDeps(fixture: ReturnType<typeof seedMixedThreadFixture>): ApplyMemoryProposalsDeps {
    return {
      db: env.db,
      grant: fixture.grant,
      guildId: GUILD,
      runId: 'run-1',
      now: NOW + 1,
      exposedChannelIds: fixture.exposedChannelIds,
      exposedMessageIds: fixture.exposedMessageIds,
      exposedMemoryIds,
    };
  }

  it.each(['update', 'supersede'] as const)(
    'rejects org-parent evidence and accepts restricted-thread evidence for %s',
    (action) => {
      const fixture = seedMixedThreadFixture();
      const targetId = seedOrgTarget(fixture.grant);
      const fail = applyMemoryProposals(mixedDeps(fixture), [createProposal({
        action,
        existingMemoryId: targetId,
        statement: 'Project launch credential is raven.',
        evidenceMessageIds: [ORG_MESSAGE],
      })]);
      expect(fail.applied).toHaveLength(0);
      expect(fail.rejected[0]?.reason).toBe('evidence_out_of_scope');
      expect(getMemory(env.db, targetId)?.statement).toBe('Project launch timeline was reviewed.');

      // A run that saw only THREAD (and the org parent) may cite THREAD. The
      // sibling is a separate restricted scope (Section 7.2), so it is not exposed here.
      const threadOnly = {
        ...fixture,
        exposedChannelIds: new Set([...fixture.exposedChannelIds].filter((id) => id !== SIBLING)),
      };
      const pass = applyMemoryProposals(mixedDeps(threadOnly), [createProposal({
        action,
        existingMemoryId: targetId,
        statement: 'Project launch credential is raven.',
        evidenceMessageIds: [THREAD_MESSAGE],
      })]);
      expect(pass.applied).toHaveLength(1);
      const memoryId = pass.applied[0]!.memoryId!;
      expect(getMemory(env.db, memoryId)).toMatchObject({ scope_type: 'channel', scope_key: THREAD });
      expect(searchMemories(env.db, {
        includeOrgMessages: true,
        includeOrgMemories: true,
        includeReviewOnly: false,
        channelIds: [],
      }, { query: 'credential raven', now: NOW + 2 })).toEqual([]);
    },
  );

  it('rejects an org-parent citation for create after restricted thread exposure', () => {
    const fixture = seedMixedThreadFixture();
    const out = applyMemoryProposals(mixedDeps(fixture), [createProposal({
      action: 'create',
      statement: 'Project launch credential is raven.',
      evidenceMessageIds: [ORG_MESSAGE],
    })]);
    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('evidence_out_of_scope');
  });

  it('rejects org evidence when a restricted channel-scoped memory was exposed', () => {
    const fixture = seedMixedThreadFixture();
    const restrictedMemoryId = createMemory(env.db, fixture.grant, {
      guildId: GUILD,
      type: 'fact',
      statement: 'Project launch credential is raven.',
      confidence: 0.8,
      importance: 0.8,
      evidence: [{ messageId: THREAD_MESSAGE, stance: 'origin' }],
      createdByRunId: 'run-0',
      now: NOW,
    });
    const targetId = seedOrgTarget(fixture.grant);
    exposedMemoryIds.add(restrictedMemoryId);
    const out = applyMemoryProposals({
      ...mixedDeps(fixture),
      exposedChannelIds: new Set([PARENT]),
      exposedMessageIds: new Set([ORG_MESSAGE]),
    }, [createProposal({
      action: 'update',
      existingMemoryId: targetId,
      statement: 'Project launch credential is raven.',
      evidenceMessageIds: [ORG_MESSAGE],
    })]);
    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('evidence_out_of_scope');
    expect(getMemory(env.db, targetId)?.statement).toBe('Project launch timeline was reviewed.');
  });

  it('rejects a sibling restricted thread citation below an org parent', () => {
    seedPolicyChannel(PARENT, 'org');
    seedPolicyChannel(THREAD, 'restricted', { parentId: PARENT, isThread: true });
    seedPolicyChannel(SIBLING, 'restricted', { parentId: PARENT, isThread: true });
    seedMessage(THREAD_MESSAGE, THREAD, 'Project launch credential is raven.');
    seedMessage('mixed-sibling-message', SIBLING, 'Project launch credential is raven.');
    const grant = grantForSecureReview(env.db, ['org', 'restricted']);
    const out = applyMemoryProposals({
      db: env.db,
      grant,
      guildId: GUILD,
      runId: 'run-1',
      now: NOW + 1,
      // The run saw both threads; citing only the sibling cannot cover THREAD.
      exposedChannelIds: new Set([THREAD, SIBLING]),
      exposedMessageIds: new Set([THREAD_MESSAGE, 'mixed-sibling-message']),
      exposedMemoryIds,
    }, [createProposal({ action: 'create', evidenceMessageIds: ['mixed-sibling-message'], statement: 'Project launch credential is raven.' })]);
    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('evidence_out_of_scope');
  });

  it.each([
    { parentVisibility: 'restricted' as const, citation: 'restricted-parent-message' },
  ])('accepts restricted family evidence with a shared anchor: $parentVisibility parent', ({ parentVisibility, citation }) => {
    seedPolicyChannel(PARENT, parentVisibility);
    seedPolicyChannel(THREAD, 'restricted', { parentId: PARENT, isThread: true });
    seedPolicyChannel(SIBLING, 'restricted', { parentId: PARENT, isThread: true });
    seedMessage(THREAD_MESSAGE, THREAD, 'Project launch credential is raven.');
    if (parentVisibility === 'restricted') {
      seedMessage(citation, PARENT, 'Project launch credential is raven.');
    } else {
      seedMessage(citation, SIBLING, 'Project launch credential is raven.');
    }
    const grant = grantForSecureReview(env.db, ['org', 'restricted']);
    const results = searchMessages(env.db, grant, { query: 'project launch', limit: 20, now: NOW });
    const out = applyMemoryProposals({
      db: env.db,
      grant,
      guildId: GUILD,
      runId: 'run-1',
      now: NOW + 1,
      exposedChannelIds: new Set(results.map((row) => row.channelId)),
      exposedMessageIds: new Set(results.map((row) => row.messageId)),
      exposedMemoryIds,
    }, [createProposal({ action: 'create', evidenceMessageIds: [citation], statement: 'Project launch credential is raven.' })]);
    expect(out.rejected).toHaveLength(0);
    expect(getMemory(env.db, out.applied[0]!.memoryId!)).toMatchObject({
      scope_type: 'channel',
      scope_key: PARENT,
    });
  });

  it('accepts a restricted child-thread citation for its exposed restricted parent anchor', () => {
    seedPolicyChannel(PARENT, 'restricted');
    seedPolicyChannel(THREAD, 'restricted', { parentId: PARENT, isThread: true });
    seedMessage(THREAD_MESSAGE, THREAD, 'Project launch credential is raven.');
    const grant = grantForSecureReview(env.db, ['org', 'restricted']);
    const results = searchMessages(env.db, grant, { query: 'project launch', limit: 20, now: NOW });
    const out = applyMemoryProposals({
      db: env.db,
      grant,
      guildId: GUILD,
      runId: 'run-1',
      now: NOW + 1,
      exposedChannelIds: new Set([PARENT, ...results.map((row) => row.channelId)]),
      exposedMessageIds: new Set(results.map((row) => row.messageId)),
      exposedMemoryIds,
    }, [createProposal({
      action: 'create',
      evidenceMessageIds: [THREAD_MESSAGE],
      statement: 'Project launch credential is raven.',
    })]);
    expect(out.rejected).toHaveLength(0);
    expect(getMemory(env.db, out.applied[0]!.memoryId!)).toMatchObject({
      scope_type: 'channel',
      scope_key: PARENT,
    });
  });
});

describe('applyMemoryProposals — lifecycle target and field validation', () => {
  it('rejects a lifecycle action with no existingMemoryId', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'confirm', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('missing_target');
  });

  it('rejects a lifecycle action whose target does not exist', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'update', existingMemoryId: 'mem-nope', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('target_not_found');
  });

  it('rejects a nonexistent owner', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'], ownerUserId: 'ghost-user' }),
    ]);
    expect(out.rejected[0]!.reason).toBe('owner_not_found');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('accepts a real owner', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'], ownerUserId: BOB }),
    ]);
    expect(out.applied).toHaveLength(1);
  });

  it('rejects an invalid reviewAt', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'], reviewAt: 'not-a-date' }),
    ]);
    expect(out.rejected[0]!.reason).toBe('invalid_review_at');
  });

  it('rejects a malformed proposal (confidence out of range)', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'], confidence: 1.5 }),
    ]);
    expect(out.rejected[0]!.reason).toBe('malformed_proposal');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });
});

describe('applyMemoryProposals — batch isolation and auditing', () => {
  it('applies valid proposals and retains rejections in the same batch', () => {
    seedMessage('m1', CHANNEL, 'First valid.');
    seedMessage('m2', CHANNEL, 'Second valid.');
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', statement: 'First valid.', evidenceMessageIds: ['m1'] }),
      createProposal({ action: 'create', evidenceMessageIds: ['invented'] }),
      createProposal({ action: 'create', statement: 'Second valid.', evidenceMessageIds: ['m2'] }),
    ]);
    expect(out.total).toBe(3);
    expect(out.applied).toHaveLength(2);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.index).toBe(1); // the middle proposal
    expect(out.rejected[0]!.reason).toBe('invented_evidence');
    // Two memories were created despite the middle rejection.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(2);
  });

  it('records the action and cited evidence on every outcome for audit', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1', 'm2'] }), // m2 invented
    ]);
    const r = out.rejected[0]!;
    expect(r.action).toBe('create');
    expect(r.evidenceMessageIds).toEqual(['m1', 'm2']);
    expect(r.reason).toBeDefined();
    expect(typeof r.detail).toBe('string');
    expect(r.detail).not.toContain('msg'); // no message content leaks into the audit detail
  });

  it('an episode-channel message is always exposed (evidence grounded in the transcript)', () => {
    seedMessage('m1', CHANNEL);
    // Even with an empty provenance set, the episode channel itself is exposed.
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.applied).toHaveLength(1);
  });
});

describe('applyMemoryProposals — memory quality hardening', () => {
  it('rejects a real message from the same exposed channel when that exact message was not exposed', () => {
    seedMessage('m1', CHANNEL, 'we decided to use passkeys');
    seedMessage('m-unseen', CHANNEL, 'secret same-channel detail');
    const deps = makeDeps(new Set([CHANNEL]));
    deps.exposedMessageIds = new Set(['m1']);
    const out = applyMemoryProposals(deps, [
      createProposal({ action: 'create', evidenceMessageIds: ['m-unseen'] }),
    ]);
    expect(out.rejected[0]?.reason).toBe('evidence_not_exposed');
  });

  it('rejects a supporting quote that is not actually present in its cited message', () => {
    seedMessage('m1', CHANNEL, 'Use passkeys for the admin console.');
    const proposal = createProposal({ action: 'create', evidenceMessageIds: ['m1'] });
    proposal.evidenceQuotes = [{ messageId: 'm1', quote: 'for the customer dashboard' }];
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [proposal]);
    expect(out.rejected[0]?.reason).toBe('unsupported_evidence_quote');
  });

  it('rejects an unsupported material clause even when its cited quote is real', () => {
    seedMessage('m1', CHANNEL, 'Use passkeys for the admin console.');
    const proposal = createProposal({
      action: 'create',
      statement: 'Use passkeys for the admin console and validate Test Org specifications.',
      evidenceMessageIds: ['m1'],
    });
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [proposal]);
    expect(out.rejected[0]?.reason).toBe('unsupported_statement_clause');
  });

  it('rejects transient and low-importance creates before persistence', () => {
    seedMessage('m1', CHANNEL, 'the deploy is at 42 percent');
    const deps = { ...makeDeps(new Set([CHANNEL])), minimumImportance: 0.6 };
    const transient = createProposal({ action: 'create', durability: 'transient' });
    const low = createProposal({ action: 'create', statement: 'Track deploy percent.', importance: 0.2 });
    const out = applyMemoryProposals(deps, [transient, low]);
    expect(out.rejected.map((item) => item.reason)).toEqual(['transient_memory', 'below_minimum_importance']);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
  });

  it('confirms an exact active duplicate instead of creating another memory row', () => {
    seedMessage('m1', CHANNEL, 'Adopt the onboarding trial.');
    const existing = createMemory(env.db, GRANT, {
      guildId: GUILD, type: 'decision', statement: 'Adopt the onboarding trial.',
      confidence: 0.8, importance: 0.7,
      evidence: [{ messageId: 'm1', stance: 'origin' }], now: NOW - 1,
    });
    seedMessage('m2', CHANNEL, 'Adopt the onboarding trial.');
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m2'] }),
    ]);
    expect(out.applied[0]?.memoryId).toBe(existing);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 });
  });

  it('confirms a reworded same-type claim with substantially overlapping evidence', () => {
    seedMessage('m1', CHANNEL, 'Stealth Browser is not offered as a one-off line item or based on usage. It is offered exclusively to enterprise customers except POCs and trials.');
    const existing = createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'constraint',
      statement: 'Stealth Browser is offered only to enterprise accounts, except trials; there is no usage billing.',
      confidence: 0.9,
      importance: 0.8,
      evidence: [{ messageId: 'm1', stance: 'origin' }],
      now: NOW - 1,
    });
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({
        action: 'create',
        type: 'constraint',
        statement: 'Stealth Browser is not offered based on usage and is exclusive to enterprise customers except POCs and trials.',
        evidenceMessageIds: ['m1'],
      }),
    ]);
    expect(out.applied[0]?.memoryId).toBe(existing);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 });
  });

  it('keeps lexically distinct same-type claims from one source separate', () => {
    seedMessage('m1', CHANNEL, 'Adopt passkeys for admins. Keep the existing billing plan for customers.');
    createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Adopt passkeys for administrator authentication.',
      confidence: 0.9,
      importance: 0.8,
      evidence: [{ messageId: 'm1', stance: 'origin' }],
      now: NOW - 1,
    });
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({
        action: 'create',
        statement: 'Keep the existing billing plan for customers.',
        evidenceMessageIds: ['m1'],
      }),
    ]);
    expect(out.applied).toHaveLength(1);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 2 });
  });

  it('requires overlapping same-evidence proposals to justify separate canonical records', () => {
    seedMessage('m1', CHANNEL, 'Use passkeys for admin authentication and document the rollout.');
    const first = createProposal({ action: 'create', statement: 'Use passkeys for admin authentication.' });
    const second = createProposal({ action: 'create', type: 'risk', statement: 'Admin authentication with passkeys needs rollout documentation.' });
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [first, second]);
    expect(out.applied).toHaveLength(1);
    expect(out.rejected[0]?.reason).toBe('duplicate_memory');
  });
});

describe('applyMemoryProposals — proactive attention registration — Section 12.7', () => {
  function seedProposalRow(proposalId: string): void {
    env.db.prepare(
      `INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
       VALUES (?, ?, 'episode', 'p', 'faux', 'faux', 'completed', ?)`,
    ).run(`run-${proposalId}`, GUILD, NOW);
    env.db.prepare(
      `INSERT INTO proposals (id,run_id,target_channel_id,status,computed_score,reason,evidence_message_ids_json,created_at_ms,updated_at_ms)
       VALUES (?, ?, ?, 'pending_review', 1, 'r', '[]', ?, ?)`,
    ).run(proposalId, `run-${proposalId}`, CHANNEL, NOW, NOW);
  }

  it('registers a revision for a material human development on an accepted create', () => {
    seedMessage('m1', CHANNEL, 'we changed the rollout decision this week');
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({
        action: 'create',
        statement: 'The rollout decision changed.',
        evidenceMessageIds: ['m1'],
        attentionChange: {
          evidence: [{ messageId: 'm1', quote: 'changed the rollout decision' }],
          relation: 'changed_decision',
          materialChange: 'The rollout decision changed this week.',
        },
      }),
    ]);
    expect(out.applied).toHaveLength(1);
    const attention = out.applied[0]!.attention;
    expect(attention?.requested).toBe(true);
    expect(attention?.registered).toBe(true);
    expect(attention?.revisionId).toBeDefined();
    const revision = env.db.prepare(
      'SELECT state, human_event_at_ms FROM attention_revisions WHERE id = ?',
    ).get(attention!.revisionId!) as { state: string; human_event_at_ms: number };
    expect(revision.state).toBe('current');
    expect(revision.human_event_at_ms).toBe(NOW);
  });

  it('keeps a valid memory mutation when attention registration is rejected', () => {
    seedMessage('m1', CHANNEL, 'we changed the rollout decision this week');
    seedMessage('m2', CHANNEL, 'an unexposed follow-up');
    const deps = makeDeps(new Set([CHANNEL]));
    // m2 exists but was never exposed to the run.
    deps.exposedMessageIds.delete('m2');
    const out = applyMemoryProposals(deps, [
      createProposal({
        action: 'create',
        statement: 'The rollout decision changed.',
        evidenceMessageIds: ['m1'],
        attentionChange: {
          evidence: [{ messageId: 'm2', quote: 'unexposed follow-up' }],
          relation: 'changed_decision',
          materialChange: 'Based on an unexposed message.',
        },
      }),
    ]);
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0]!.memoryId).toBeDefined();
    expect(out.applied[0]!.attention?.registered).toBe(false);
    expect(out.applied[0]!.attention?.reason).toBe('trigger_changed');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 });
  });

  it('cannot reuse consumed evidence for a second revision', () => {
    seedMessage('m1', CHANNEL, 'we changed the rollout decision this week');
    const deps = makeDeps(new Set([CHANNEL]));
    const first = applyMemoryProposals(deps, [
      createProposal({
        action: 'create',
        statement: 'The rollout decision changed.',
        evidenceMessageIds: ['m1'],
        attentionChange: {
          evidence: [{ messageId: 'm1', quote: 'changed the rollout decision' }],
          relation: 'changed_decision',
          materialChange: 'First development.',
        },
      }),
    ]);
    const revisionId = first.applied[0]!.attention!.revisionId!;
    seedProposalRow('prop-att-1');
    expect(claimRevision(env.db, {
      revisionId,
      proposalId: 'prop-att-1',
      consumedAtMs: NOW,
      eligibleFromMs: NOW,
      eligibleUntilMs: NOW + 7 * 86_400_000,
    })).toBe(true);

    const second = applyMemoryProposals(deps, [
      createProposal({
        action: 'create',
        type: 'risk',
        statement: 'A separate rollout risk statement.',
        evidenceMessageIds: ['m1'],
        independentReason: 'A distinct risk record that shares the source message.',
        attentionChange: {
          evidence: [{ messageId: 'm1', quote: 'changed the rollout decision' }],
          relation: 'changed_decision',
          materialChange: 'Replay of the same development.',
        },
      }),
    ]);
    // The memory side can still succeed; the attention replay cannot.
    const attention = second.applied[0]?.attention ?? second.rejected[0]?.attention;
    expect(attention?.registered).toBe(false);
    expect(attention?.reason).toBe('revision_consumed');
  });

  it('sets and clears source-verified deadline authority beside a memory mutation', () => {
    seedMessage('m1', CHANNEL, 'the report is promised by 18 September 2026');
    const deps = { ...makeDeps(new Set([CHANNEL])), attentionTimezone: 'UTC' };
    const set = applyMemoryProposals(deps, [
      createProposal({
        action: 'create',
        statement: 'A report is promised.',
        evidenceMessageIds: ['m1'],
        deadlineChange: {
          action: 'set',
          sourceMessageId: 'm1',
          quote: 'promised by 18 September 2026',
          dateExpression: '18 September 2026',
        },
      }),
    ]);
    expect(set.applied[0]!.deadline?.applied).toBe(true);
    const revisionId = set.applied[0]!.deadline!.revisionId!;
    const row = env.db.prepare(
      'SELECT explicit_deadline_at_ms, deadline_parser_version FROM attention_revisions WHERE id = ?',
    ).get(revisionId) as { explicit_deadline_at_ms: number; deadline_parser_version: string };
    expect(row.explicit_deadline_at_ms).toBe(Date.UTC(2026, 8, 18, 23, 59, 59, 999));
    expect(row.deadline_parser_version).toBe(DEADLINE_PARSER_VERSION);

    const memoryId = set.applied[0]!.memoryId!;
    exposedMemoryIds.add(memoryId);
    seedMessage('m2', CHANNEL, 'the report deadline is cancelled');
    const cleared = applyMemoryProposals({ ...deps, exposedMessageIds: new Set(['m1', 'm2']) }, [
      createProposal({
        action: 'update',
        existingMemoryId: memoryId,
        statement: 'A report was promised; the deadline was cancelled.',
        evidenceMessageIds: ['m1', 'm2'],
        deadlineChange: {
          action: 'clear',
          sourceMessageId: 'm2',
          quote: 'deadline is cancelled',
        },
      }),
    ]);
    expect(cleared.applied[0]!.deadline?.applied).toBe(true);
    const after = env.db.prepare(
      'SELECT explicit_deadline_at_ms FROM attention_revisions WHERE id = ?',
    ).get(revisionId) as { explicit_deadline_at_ms: number | null };
    expect(after.explicit_deadline_at_ms).toBeNull();
  });

  it('rejects a model-only date change while keeping the memory', () => {
    seedMessage('m1', CHANNEL, 'the report is promised by 18 September 2026');
    seedMessage('m2', CHANNEL, 'the report is promised by 30 September 2026');
    const deps = { ...makeDeps(new Set([CHANNEL])), attentionTimezone: 'UTC' };
    const out = applyMemoryProposals(deps, [
      createProposal({
        action: 'create',
        statement: 'A report is promised.',
        evidenceMessageIds: ['m1'],
        deadlineChange: {
          action: 'set',
          sourceMessageId: 'm1',
          quote: 'promised by 18 September 2026',
          dateExpression: '30 September 2026', // not present in the cited source
        },
      }),
    ]);
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0]!.memoryId).toBeDefined();
    expect(out.applied[0]!.deadline?.applied).toBe(false);
    expect(out.applied[0]!.deadline?.reason).toBe('deadline_unverified');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_revisions').get()).toEqual({ n: 0 });
  });
});

describe('applyMemoryProposals — deadline authority hardening — Section 12.7', () => {
  it('rejects a deadline set grounded in already-consumed evidence', async () => {
    seedMessage('m-consumed', CHANNEL, 'the audit is promised by 18 September 2026');
    const deps = { ...makeDeps(new Set([CHANNEL])), attentionTimezone: 'UTC' };
    const first = applyMemoryProposals(deps, [
      createProposal({
        action: 'create',
        statement: 'An audit is promised.',
        evidenceMessageIds: ['m-consumed'],
        attentionChange: {
          evidence: [{ messageId: 'm-consumed', quote: 'audit is promised' }],
          relation: 'new_commitment',
          materialChange: 'The audit commitment.',
        },
      }),
    ]);
    const revisionId = first.applied[0]!.attention!.revisionId!;
    env.db.prepare(
      `INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
       VALUES ('run-consumed-1', ?, 'episode', 'p', 'faux', 'faux', 'completed', ?)`,
    ).run(GUILD, NOW);
    env.db.prepare(
      `INSERT INTO proposals (id,run_id,target_channel_id,status,computed_score,reason,evidence_message_ids_json,created_at_ms,updated_at_ms)
       VALUES ('p-consumed-1', 'run-consumed-1', ?, 'approved', 1, 'r', '[]', ?, ?)`,
    ).run(CHANNEL, NOW, NOW);
    const { claimRevision } = await import('../../src/memory/attention-repository.js');
    expect(claimRevision(env.db, {
      revisionId, proposalId: 'p-consumed-1', consumedAtMs: NOW,
      eligibleFromMs: NOW, eligibleUntilMs: NOW + 7 * 86_400_000,
    })).toBe(true);

    // The same consumed message cannot reopen the subject as a deadline source.
    exposedMemoryIds.add(first.applied[0]!.memoryId!);
    const replay = applyMemoryProposals(deps, [
      createProposal({
        action: 'confirm',
        existingMemoryId: first.applied[0]!.memoryId!,
        statement: 'An audit is promised.',
        evidenceMessageIds: ['m-consumed'],
        deadlineChange: {
          action: 'set',
          sourceMessageId: 'm-consumed',
          quote: 'audit is promised by 18 September 2026',
          dateExpression: '18 September 2026',
        },
      }),
    ]);
    expect(replay.applied[0]!.accepted).toBe(true);
    expect(replay.applied[0]!.deadline?.applied).toBe(false);
    expect(replay.applied[0]!.deadline?.reason).toBe('revision_consumed');
  });

  it('rejects a bare weekday extracted from a qualified phrase', () => {
    seedMessage('m-qualified', CHANNEL, 'lets target next Friday for the migration');
    const deps = { ...makeDeps(new Set([CHANNEL])), attentionTimezone: 'UTC' };
    const out = applyMemoryProposals(deps, [
      createProposal({
        action: 'create',
        statement: 'The migration is scheduled.',
        evidenceMessageIds: ['m-qualified'],
        deadlineChange: {
          action: 'set',
          sourceMessageId: 'm-qualified',
          quote: 'next Friday for the migration',
          dateExpression: 'Friday',
        },
      }),
    ]);
    expect(out.applied[0]!.memoryId).toBeDefined();
    expect(out.applied[0]!.deadline?.applied).toBe(false);
    expect(out.applied[0]!.deadline?.reason).toBe('deadline_unverified');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM attention_revisions').get()).toEqual({ n: 0 });
  });

  it('rejects conflicting date expressions inside the quoted commitment', () => {
    seedMessage('m-conflicting', CHANNEL, 'ship either 18 September 2026 or 30 September 2026, not sure yet');
    const deps = { ...makeDeps(new Set([CHANNEL])), attentionTimezone: 'UTC' };
    const out = applyMemoryProposals(deps, [
      createProposal({
        action: 'create',
        statement: 'The ship date is undecided.',
        evidenceMessageIds: ['m-conflicting'],
        deadlineChange: {
          action: 'set',
          sourceMessageId: 'm-conflicting',
          quote: 'either 18 September 2026 or 30 September 2026',
          dateExpression: '18 September 2026',
        },
      }),
    ]);
    expect(out.applied[0]!.deadline?.applied).toBe(false);
    expect(out.applied[0]!.deadline?.reason).toBe('deadline_unverified');
  });

  it('a human reschedule supersedes the previous deadline authority', async () => {
    seedMessage('m-schedule-1', CHANNEL, 'the report is promised by 18 September 2026');
    const deps = { ...makeDeps(new Set([CHANNEL])), attentionTimezone: 'UTC' };
    const first = applyMemoryProposals(deps, [
      createProposal({
        action: 'create',
        statement: 'A report is promised.',
        evidenceMessageIds: ['m-schedule-1'],
        deadlineChange: {
          action: 'set',
          sourceMessageId: 'm-schedule-1',
          quote: 'promised by 18 September 2026',
          dateExpression: '18 September 2026',
        },
      }),
    ]);
    const memoryId = first.applied[0]!.memoryId!;
    exposedMemoryIds.add(memoryId);
    const firstRevision = first.applied[0]!.deadline!.revisionId!;

    seedMessage('m-schedule-2', CHANNEL, 'the report moved: it is promised by 30 September 2026');
    const rescheduledDeps = { ...makeDeps(new Set([CHANNEL])), attentionTimezone: 'UTC', now: NOW + 1000 };
    rescheduledDeps.exposedMessageIds = new Set(['m-schedule-1', 'm-schedule-2']);
    const rescheduled = applyMemoryProposals(rescheduledDeps, [
      createProposal({
        action: 'update',
        existingMemoryId: memoryId,
        statement: 'A report is promised at the end of September.',
        evidenceMessageIds: ['m-schedule-1', 'm-schedule-2'],
        deadlineChange: {
          action: 'set',
          sourceMessageId: 'm-schedule-2',
          quote: 'promised by 30 September 2026',
          dateExpression: '30 September 2026',
        },
      }),
    ]);
    expect(rescheduled.applied[0]!.deadline?.applied).toBe(true);
    const newRevision = rescheduled.applied[0]!.deadline!.revisionId!;
    expect(newRevision).not.toBe(firstRevision);
    const { getRevision } = await import('../../src/memory/attention-repository.js');
    expect(getRevision(env.db, firstRevision)?.state).toBe('superseded');
    expect(getRevision(env.db, newRevision)?.explicitDeadlineAtMs)
      .toBe(Date.UTC(2026, 8, 30, 23, 59, 59, 999));
  });
});
