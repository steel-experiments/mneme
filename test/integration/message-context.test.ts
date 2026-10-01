import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  getMessageContext,
  MAX_CONTEXT_COUNT,
  MAX_REPLY_COUNT,
  type RetrievalGrant,
} from '../../src/db/repositories/message-context.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const NOW = 1_700_000_001_000;

let env: TestDb;

const ORG = 'org-c';
const RA = 'restricted-A';

function seedChannel(id: string, visibility: 'org' | 'restricted'): void {
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

function addMessage(id: string, channel: string, atMs: number, replyTo: string | null = null): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: channel,
    authorId: USER,
    authorDisplayName: 'Alice',
    content: 'msg ' + id,
    createdAtMs: atMs,
    editedAtMs: null,
    replyToMessageId: replyTo,
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

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
const CHANNEL_A_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RA],
};

describe('message context retrieval', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    seedChannel(ORG, 'org');
    seedChannel(RA, 'restricted');
    // Chronological org messages; m3 replies to m1.
    addMessage('m1', ORG, NOW);
    addMessage('m2', ORG, NOW + 1);
    addMessage('m3', ORG, NOW + 2, 'm1');
    addMessage('m4', ORG, NOW + 3);
    addMessage('m5', ORG, NOW + 4);
    // A restricted-channel message that replies to an org message (cross-channel).
    addMessage('r1', RA, NOW + 5, 'm2');
  });

  it('returns ordered permitted neighbors around a visible anchor', () => {
    const ctx = getMessageContext(env.db, ORG_GRANT, {
      messageId: 'm3',
      beforeCount: 2,
      afterCount: 2,
    });
    expect(ctx.anchor?.messageId).toBe('m3');
    expect(ctx.before.map((m) => m.messageId)).toEqual(['m1', 'm2']);
    expect(ctx.after.map((m) => m.messageId)).toEqual(['m4', 'm5']);
  });

  it('reveals nothing for an out-of-scope anchor', () => {
    const ctx = getMessageContext(env.db, ORG_GRANT, { messageId: 'r1' });
    expect(ctx.anchor).toBeNull();
    expect(ctx.before).toEqual([]);
    expect(ctx.after).toEqual([]);
    expect(ctx.replies).toEqual([]);
  });

  it('reveals nothing for a missing anchor', () => {
    const ctx = getMessageContext(env.db, ORG_GRANT, { messageId: 'nope' });
    expect(ctx.anchor).toBeNull();
  });

  it('excludes a deleted anchor', () => {
    env.db.prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?').run(NOW + 99, 'm3');
    const ctx = getMessageContext(env.db, ORG_GRANT, { messageId: 'm3' });
    expect(ctx.anchor).toBeNull();
  });

  it('includes the reply chain when requested', () => {
    // m3 replies to m1 → replies should surface m1 (the parent).
    const ctx = getMessageContext(env.db, ORG_GRANT, {
      messageId: 'm3',
      includeReplies: true,
    });
    expect(ctx.replies.map((m) => m.messageId)).toContain('m1');
  });

  it('never leaks a cross-channel reply from an out-of-scope channel', () => {
    // r1 (restricted) replies to m2 (org). Under an org grant, includeReplies on
    // m2 must NOT surface r1.
    const ctx = getMessageContext(env.db, ORG_GRANT, {
      messageId: 'm2',
      includeReplies: true,
    });
    expect(ctx.replies.map((m) => m.messageId)).not.toContain('r1');

    // But a channel-A grant DOES see r1.
    const ctx2 = getMessageContext(env.db, CHANNEL_A_GRANT, {
      messageId: 'm2',
      includeReplies: true,
    });
    expect(ctx2.replies.map((m) => m.messageId)).toContain('r1');
  });

  it('clamps before/after counts to the configured maximum', () => {
    const ctx = getMessageContext(env.db, ORG_GRANT, {
      messageId: 'm3',
      beforeCount: 999,
      afterCount: 999,
    });
    expect(ctx.before.length).toBeLessThanOrEqual(MAX_CONTEXT_COUNT);
    expect(ctx.after.length).toBeLessThanOrEqual(MAX_CONTEXT_COUNT);
  });

  it('bounds the reply chain independently of the neighbor window', () => {
    // No caller argument selects the reply bound, so widening the neighbour
    // window must not multiply the reply rows every call carries.
    expect(MAX_REPLY_COUNT).toBeLessThanOrEqual(MAX_CONTEXT_COUNT);
    for (let i = 0; i < MAX_REPLY_COUNT + 5; i++) {
      addMessage(`rep-${i}`, ORG, NOW + 100 + i, 'm1');
    }
    const ctx = getMessageContext(env.db, ORG_GRANT, {
      messageId: 'm1',
      includeReplies: true,
    });
    expect(ctx.replies.length).toBe(MAX_REPLY_COUNT);
  });

  it('generates Discord links for each returned message', () => {
    const ctx = getMessageContext(env.db, ORG_GRANT, { messageId: 'm3', beforeCount: 1 });
    expect(ctx.anchor?.link).toBe(
      'https://discord.com/channels/' + GUILD + '/' + ORG + '/m3',
    );
  });
});
