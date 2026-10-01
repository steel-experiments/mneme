import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { createMemory, type RetrievalGrant } from '../../src/memory/repository.js';
import {
  handleMemorySearchCommand,
  formatMemorySearchReply,
  handleMemoryGetCommand,
  formatMemoryGetReply,
  resolveMemorySearchScope,
} from '../../src/commands/memory-search.js';

/**
 * `/mneme memory-search` integration suite (Sections 7.3, 27).
 *
 * Acceptance: invoking the command outside the secure review channel cannot
 * disclose broader restricted or review-only memory. The host builds the
 * retrieval grant from the invocation channel and `searchMemories` recomputes
 * each memory's effective scope at read time, so the grant is the single
 * ceiling. These tests drive the command handler end to end and assert both the
 * results returned and the audit row, for org-only and secure-review disclosure.
 */

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const NOW = 1_700_000_001_000;
const ADMIN_ROLE = '900000000000000001';
const ADMIN_ROLES: readonly string[] = [ADMIN_ROLE];
const ADMIN = '100000000000000010';
const OUTSIDER = '100000000000000011';

const ORG = 'org-channel-x';
const RA = 'restricted-channel-A';
const RB = 'restricted-channel-B';
const REVIEW = 'secure-review-channel';

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

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
  seedChannel(ORG, 'org');
  seedChannel(RA, 'restricted');
  seedChannel(RB, 'restricted');
  seedChannel(REVIEW, 'restricted');
  addMessage('e-org', ORG, 'onboarding trial decision evidence');
  addMessage('e-ra', RA, 'onboarding restricted evidence');
  addMessage('e-rb', RB, 'onboarding other restricted evidence');
});
afterEach(() => env.cleanup());

function seedChannel(
  id: string,
  visibility: 'org' | 'restricted' | 'review_only',
): void {
  upsertChannel(db, {
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
  upsertMessageCreate(db, {
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

/** Seed one memory of each scope, all matching the word "onboarding". */
function seedMemorySet(): { org: string; restricted: string; reviewOnly: string } {
  const org = createMemory(db, ORG_GRANT, {
    guildId: GUILD,
    type: 'decision',
    statement: 'Adopt the onboarding trial across teams.',
    confidence: 0.8,
    importance: 0.7,
    evidence: [{ messageId: 'e-org', stance: 'origin' }],
    now: NOW,
  });
  const restricted = createMemory(db, CHANNEL_A_GRANT, {
    guildId: GUILD,
    type: 'assumption',
    statement: 'Restricted onboarding call inside channel A.',
    confidence: 0.7,
    importance: 0.6,
    evidence: [
      { messageId: 'e-org', stance: 'origin' },
      { messageId: 'e-ra', stance: 'supports' },
    ],
    now: NOW,
  });
  const reviewOnly = createMemory(db, CHANNEL_AB_GRANT, {
    guildId: GUILD,
    type: 'risk',
    statement: 'Cross-channel onboarding disagreement surfaced.',
    confidence: 0.6,
    importance: 0.5,
    evidence: [
      { messageId: 'e-ra', stance: 'supports' },
      { messageId: 'e-rb', stance: 'contradicts' },
    ],
    now: NOW,
  });
  return { org, restricted, reviewOnly };
}

function idsOf(outcome: { kind: string; results?: readonly { memoryId: string }[] }): Set<string> {
  return new Set((outcome.results ?? []).map((r) => r.memoryId));
}

function adminEvent(): { detailsJson: string; actorUserId: string; target: string | null } | undefined {
  return db
    .prepare(
      'SELECT details_json AS detailsJson, actor_user_id AS actorUserId, target FROM admin_events WHERE action = ? ORDER BY created_at_ms DESC LIMIT 1',
    )
    .get('memory_search') as { detailsJson: string; actorUserId: string; target: string | null } | undefined;
}

const adminInput = (memberRoleIds: readonly string[] | null, actor = ADMIN) => ({
  actorUserId: actor,
  guildId: GUILD,
  memberRoleIds,
});

describe('/mneme memory-search outside the secure review channel (org only)', () => {
  it('discloses only org memories: restricted-channel and review-only memories are never returned', () => {
    const ids = seedMemorySet();
    const outcome = handleMemorySearchCommand(
      { ...adminInput([ADMIN_ROLE]), query: 'onboarding', invocationChannelId: ORG },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );

    expect(outcome.kind).toBe('done');
    expect(outcome.kind === 'done' ? outcome.scope : undefined).toBe('org_only');
    const got = idsOf(outcome);
    expect(got.has(ids.org)).toBe(true);
    expect(got.has(ids.restricted)).toBe(false);
    expect(got.has(ids.reviewOnly)).toBe(false);
  });

  it('does not leak a restricted memory even on an exact-content match', () => {
    const ids = seedMemorySet();
    // Search a distinctive phrase from the restricted memory's own statement.
    const outcome = handleMemorySearchCommand(
      { ...adminInput([ADMIN_ROLE]), query: 'channel A', invocationChannelId: RA },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    expect(outcome.kind).toBe('done');
    // Invoking inside restricted channel RA is still NOT the review channel → org only.
    expect(outcome.kind === 'done' ? outcome.scope : undefined).toBe('org_only');
    expect(idsOf(outcome).has(ids.restricted)).toBe(false);
  });

  it('collapses to org-only in a DM (no invocation channel) and when no review channel is configured', () => {
    seedMemorySet();
    const dm = handleMemorySearchCommand(
      { ...adminInput([ADMIN_ROLE]), query: 'onboarding', invocationChannelId: null },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    expect(dm.kind === 'done' ? dm.scope : undefined).toBe('org_only');

    // No review channel configured at all → nothing can be "secure review".
    const noReview = handleMemorySearchCommand(
      { ...adminInput([ADMIN_ROLE]), query: 'onboarding', invocationChannelId: REVIEW },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: undefined },
    );
    expect(noReview.kind === 'done' ? noReview.scope : undefined).toBe('org_only');
  });

  it('reports a helpful empty result when only non-org memories match', () => {
    // Only restricted-scoped memories exist (no org memory).
    createMemory(db, CHANNEL_A_GRANT, {
      guildId: GUILD,
      type: 'assumption',
      statement: 'Secret onboarding assumption in A.',
      confidence: 0.7,
      importance: 0.6,
      evidence: [
        { messageId: 'e-org', stance: 'origin' },
        { messageId: 'e-ra', stance: 'supports' },
      ],
      now: NOW,
    });
    const outcome = handleMemorySearchCommand(
      { ...adminInput([ADMIN_ROLE]), query: 'onboarding', invocationChannelId: ORG },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    expect(outcome.kind).toBe('done');
    expect(outcome.kind === 'done' ? outcome.results.length : 0).toBe(0);
    const reply = formatMemorySearchReply(outcome.kind === 'done' ? outcome : { kind: 'not_authorized' });
    expect(reply).toContain('secure review channel');
  });
});

describe('/mneme memory-search inside the secure review channel (all scopes)', () => {
  it('discloses org, restricted-channel, and review-only memories', () => {
    const ids = seedMemorySet();
    const outcome = handleMemorySearchCommand(
      { ...adminInput([ADMIN_ROLE]), query: 'onboarding', invocationChannelId: REVIEW },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    expect(outcome.kind).toBe('done');
    expect(outcome.kind === 'done' ? outcome.scope : undefined).toBe('secure_review');
    const got = idsOf(outcome);
    expect(got.has(ids.org)).toBe(true);
    expect(got.has(ids.restricted)).toBe(true);
    expect(got.has(ids.reviewOnly)).toBe(true);
  });
});

describe('/mneme memory-get', () => {
  it('returns the complete statement and canonical source links', () => {
    const ids = seedMemorySet();
    const outcome = handleMemoryGetCommand(
      { ...adminInput([ADMIN_ROLE]), memoryId: ids.org, invocationChannelId: ORG },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    expect(outcome.kind).toBe('done');
    const reply = formatMemoryGetReply(outcome);
    expect(reply).toContain('Adopt the onboarding trial across teams.');
    expect(reply).toContain(`https://discord.com/channels/${GUILD}/${ORG}/e-org`);
  });

  it('does not disclose a restricted memory outside secure review', () => {
    const ids = seedMemorySet();
    const outcome = handleMemoryGetCommand(
      { ...adminInput([ADMIN_ROLE]), memoryId: ids.restricted, invocationChannelId: ORG },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    expect(outcome.kind).toBe('not_visible');
  });
});

describe('authorization, audit, and scope resolution', () => {
  it('denies an unauthorized caller, audits the denial, and searches nothing', () => {
    seedMemorySet();
    const outcome = handleMemorySearchCommand(
      { ...adminInput(['nope'], OUTSIDER), query: 'onboarding', invocationChannelId: REVIEW },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    expect(outcome.kind).toBe('not_authorized');
    expect(formatMemorySearchReply(outcome)).toContain('not authorized');

    const ev = adminEvent()!;
    expect(ev.actorUserId).toBe(OUTSIDER);
    const details = JSON.parse(ev.detailsJson);
    expect(details.authorized).toBe(false);
  });

  it('audits the disclosure scope on an authorized search', () => {
    seedMemorySet();
    handleMemorySearchCommand(
      { ...adminInput([ADMIN_ROLE]), query: 'onboarding', invocationChannelId: ORG },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    const details = JSON.parse(adminEvent()!.detailsJson);
    expect(details.authorized).toBe(true);
    expect(details.scope).toBe('org_only');
    expect(details.query).toBe('onboarding');
  });

  it('audits secure_review scope when invoked in the review channel', () => {
    seedMemorySet();
    handleMemorySearchCommand(
      { ...adminInput([ADMIN_ROLE]), query: 'onboarding', invocationChannelId: REVIEW },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    expect(JSON.parse(adminEvent()!.detailsJson).scope).toBe('secure_review');
  });

  it('fails closed on role data unavailable (null memberRoleIds)', () => {
    seedMemorySet();
    const outcome = handleMemorySearchCommand(
      { ...adminInput(null), query: 'onboarding', invocationChannelId: REVIEW },
      { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, reviewChannelId: REVIEW },
    );
    expect(outcome.kind).toBe('not_authorized');
    expect(JSON.parse(adminEvent()!.detailsJson).reason).toBe('role_data_unavailable');
  });

  it('resolveMemorySearchScope treats only the exact review channel as secure', () => {
    expect(resolveMemorySearchScope(REVIEW, REVIEW)).toBe('secure_review');
    expect(resolveMemorySearchScope(ORG, REVIEW)).toBe('org_only');
    expect(resolveMemorySearchScope(null, REVIEW)).toBe('org_only');
    expect(resolveMemorySearchScope(REVIEW, undefined)).toBe('org_only');
    expect(resolveMemorySearchScope(REVIEW, '')).toBe('org_only');
    expect(resolveMemorySearchScope(REVIEW, null)).toBe('org_only');
  });
});
