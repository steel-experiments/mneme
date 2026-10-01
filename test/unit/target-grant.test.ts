import { afterEach, describe, expect, it } from 'vitest';
import {
  grantForDirectAnswerChannel,
  grantForTargetChannel,
  resolveScheduledReviewScope,
} from '../../src/production-runtime.js';
import {
  resolveCurrentChannelScope,
  resolveRetrievableChannelScope,
  upsertChannel,
} from '../../src/db/repositories/channels.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';

let env: TestDb | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

describe('target-channel retrieval grants', () => {
  it('lets an ingest-disabled org console read ingested org sources', () => {
    expect(grantForTargetChannel({
      id: '100000000000000013', parent_id: null, visibility_class: 'org', deleted_at_ms: null,
    })).toEqual({ includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] });
  });

  it('fails closed for a deleted target', () => {
    expect(grantForTargetChannel({
      id: '100000000000000013', parent_id: null, visibility_class: 'org', deleted_at_ms: 1,
    })).toEqual({ includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false, channelIds: [] });
  });

  it('gives the configured secure review channel all current memory scopes', () => {
    env = createTestDb();
    const identity = seedIdentity(env.db);
    const reviewChannelId = '100000000000000009';
    const otherReviewOnlyId = '100000000000000008';
    const restrictedRootId = '100000000000000010';
    const restrictedThreadId = '100000000000000011';
    for (const channel of [
      { id: reviewChannelId, parentId: null, visibility: 'review_only', isThread: false },
      { id: otherReviewOnlyId, parentId: null, visibility: 'review_only', isThread: false },
      { id: restrictedRootId, parentId: null, visibility: 'restricted', isThread: false },
      { id: restrictedThreadId, parentId: restrictedRootId, visibility: 'restricted', isThread: true },
    ] as const) {
      upsertChannel(env.db, {
        id: channel.id,
        guildId: identity.guildId,
        parentId: channel.parentId,
        kind: channel.isThread ? 'thread' : 'text',
        name: channel.id,
        topic: null,
        position: 0,
        isThread: channel.isThread,
        isArchived: false,
        isLocked: false,
        ingestEnabled: true,
        visibilityClass: channel.visibility,
        allowInterventions: false,
        permissionFingerprint: null,
        lastMessageId: null,
        discoveredAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_000,
        rawJson: null,
      });
    }

    const accepted = ['org', 'restricted', 'review_only'] as const;
    const reviewGrant = grantForDirectAnswerChannel(env.db, reviewChannelId, reviewChannelId, accepted);
    expect(reviewGrant).toMatchObject({ includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: true });
    expect(new Set(reviewGrant.channelIds)).toEqual(
      new Set([identity.channelId, restrictedRootId]),
    );
    // Production can persist the secure review channel as an ordinary
    // restricted row. Prompt visibility still describes its special,
    // review-only audience rather than that inherited storage classification.
    env.db
      .prepare("UPDATE channels SET visibility_class = 'restricted' WHERE id = ?")
      .run(reviewChannelId);
    expect(resolveScheduledReviewScope(env.db, reviewChannelId, accepted)).toMatchObject({
      reviewChannelId,
      target: { label: `#${reviewChannelId}`, visibility: 'review_only' },
    });
    expect(grantForDirectAnswerChannel(env.db, reviewChannelId, reviewChannelId, ['org'])).toEqual({
      includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [],
    });
    expect(grantForDirectAnswerChannel(env.db, reviewChannelId, reviewChannelId, ['restricted'])).toMatchObject({
      includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: false,
    });
    expect(grantForDirectAnswerChannel(env.db, reviewChannelId, reviewChannelId, ['review_only'])).toEqual({
      includeOrgMessages: false, includeOrgMemories: false, includeReviewOnly: true, channelIds: [],
    });
    expect(() => resolveScheduledReviewScope(env.db, reviewChannelId, [])).toThrow(
      /accepts no visibility scopes/,
    );
    env.db
      .prepare("UPDATE channels SET visibility_class = 'review_only' WHERE id = ?")
      .run(reviewChannelId);
    expect(grantForDirectAnswerChannel(env.db, otherReviewOnlyId, reviewChannelId, accepted)).toEqual({
      includeOrgMessages: false, includeOrgMemories: false,
      includeReviewOnly: false,
      channelIds: [],
    });
    expect(grantForDirectAnswerChannel(env.db, identity.channelId, reviewChannelId, accepted)).toEqual({
      includeOrgMessages: false, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [identity.channelId],
    });
    expect(grantForDirectAnswerChannel(env.db, restrictedThreadId, reviewChannelId, accepted)).toEqual({
      includeOrgMessages: false, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [restrictedRootId],
    });

    env.db
      .prepare("UPDATE channels SET visibility_class = 'org' WHERE id = ?")
      .run(restrictedRootId);
    expect(grantForDirectAnswerChannel(env.db, restrictedThreadId, reviewChannelId, accepted)).toEqual({
      includeOrgMessages: false, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [restrictedRootId],
    });
    env.db
      .prepare("UPDATE channels SET visibility_class = 'org' WHERE id = ?")
      .run(restrictedThreadId);
    expect(grantForDirectAnswerChannel(env.db, restrictedThreadId, reviewChannelId, accepted)).toEqual({
      includeOrgMessages: true, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [],
    });
    env.db
      .prepare('UPDATE channels SET deleted_at_ms = ? WHERE id = ?')
      .run(1_700_000_001_000, restrictedRootId);
    expect(grantForDirectAnswerChannel(env.db, restrictedThreadId, reviewChannelId, accepted)).toEqual({
      includeOrgMessages: false, includeOrgMemories: false,
      includeReviewOnly: false,
      channelIds: [],
    });

    env.db
      .prepare('UPDATE channels SET deleted_at_ms = ? WHERE id = ?')
      .run(1_700_000_001_000, reviewChannelId);
    expect(grantForDirectAnswerChannel(env.db, reviewChannelId, reviewChannelId, accepted)).toEqual({
      includeOrgMessages: false, includeOrgMemories: false,
      includeReviewOnly: false,
      channelIds: [],
    });
    expect(() => resolveScheduledReviewScope(env.db, reviewChannelId, accepted)).toThrow(
      /scheduled review channel .* no longer available/,
    );
    expect(grantForDirectAnswerChannel(env.db, 'missing-review', 'missing-review')).toEqual({
      includeOrgMessages: false, includeOrgMemories: false,
      includeReviewOnly: false,
      channelIds: [],
    });
  });
});

describe('current target scope vs retrievable source scope', () => {
  it('keeps an ingestion-disabled channel target-valid but not source-valid', () => {
    env = createTestDb();
    const identity = seedIdentity(env.db);
    env.db.prepare('UPDATE channels SET ingest_enabled = 0 WHERE id = ?').run(identity.channelId);

    expect(resolveCurrentChannelScope(env.db, identity.channelId)).toEqual({
      channelId: identity.channelId,
      scopeChannelId: identity.channelId,
      visibility: 'restricted',
    });
    expect(resolveRetrievableChannelScope(env.db, identity.channelId)).toBeUndefined();
    expect(grantForDirectAnswerChannel(env.db, identity.channelId, undefined)).toEqual({
      includeOrgMessages: false, includeOrgMemories: true,
      includeReviewOnly: false,
      channelIds: [identity.channelId],
    });
  });

  it('keeps a live thread target-valid when its disabled parent makes it non-retrievable', () => {
    env = createTestDb();
    const identity = seedIdentity(env.db);
    const threadId = '100000000000000012';
    upsertChannel(env.db, {
      id: threadId,
      guildId: identity.guildId,
      parentId: identity.channelId,
      kind: 'thread',
      name: 'thread',
      topic: null,
      position: 0,
      isThread: true,
      isArchived: false,
      isLocked: false,
      ingestEnabled: true,
      visibilityClass: 'restricted',
      allowInterventions: true,
      permissionFingerprint: null,
      lastMessageId: null,
      discoveredAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      rawJson: null,
    });
    env.db.prepare('UPDATE channels SET ingest_enabled = 0 WHERE id = ?').run(identity.channelId);

    expect(resolveCurrentChannelScope(env.db, threadId)).toEqual({
      channelId: threadId,
      scopeChannelId: identity.channelId,
      visibility: 'restricted',
    });
    expect(resolveRetrievableChannelScope(env.db, threadId)).toBeUndefined();
  });
});
