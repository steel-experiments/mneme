// ABOUTME: Tests the platform boundary policy source (plan 002 decision 9, plan 006 step 3).
// ABOUTME: An explicit org rule, a thread override, and an org review decision all lose to it.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { parseChannelPolicy } from '../../src/policy/channel-policy.js';
import { resolveEffectiveChannelPolicy } from '../../src/policy/channel-policy-review.js';
import {
  reconcileStoredChannelPolicyReview,
  resolveObservedChannelPolicy,
} from '../../src/policy/channel-policy-review-service.js';
import { getActiveChannelPolicyReview } from '../../src/db/repositories/channel-policy-reviews.js';
import { getChannel, upsertChannel, type ChannelUpsertInput } from '../../src/db/repositories/channels.js';

const TEAM = 'T0000000001';
const SHARED = 'C0000000001';
const THREAD = 'C0000000001-T1790933759.217369';
const REVIEW = 'C0000000009';
const NOW = 1_790_000_000_000;

function policy(channels = '  {}') {
  return parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: restricted
  allow_interventions: false
channels:
${channels}
review_channel:
  id: "${REVIEW}"
  secure: true
  accepts_scopes: [org, restricted, review_only]
`);
}

function channelInput(over: Partial<ChannelUpsertInput> = {}): ChannelUpsertInput {
  return {
    id: SHARED, guildId: TEAM, parentId: null, kind: 'text', name: 'partner', topic: null, position: null,
    isThread: false, isArchived: false, isLocked: false, ingestEnabled: true, visibilityClass: 'restricted',
    allowInterventions: false, permissionFingerprint: null, lastMessageId: null,
    discoveredAtMs: NOW, updatedAtMs: NOW, rawJson: null, ...over,
  };
}

describe('platform boundary policy source', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  function setup(boundary: 'excluded' | null) {
    t = createTestDb();
    t.db.prepare('INSERT INTO workspaces (id,name,owner_id,joined_at_ms,discovered_at_ms,updated_at_ms,raw_json) VALUES (?,?,?,?,?,?,NULL)')
      .run(TEAM, 'Team', null, NOW, NOW, NOW);
    upsertChannel(t.db, channelInput({ platformBoundary: boundary }));
    upsertChannel(t.db, channelInput({ id: REVIEW, name: 'mneme-review', platformBoundary: null }));
    return t.db;
  }

  it('wins over an explicit org rule', () => {
    const db = setup('excluded');
    const result = resolveObservedChannelPolicy(db, policy(`  "${SHARED}": { ingest: true, visibility: org, allow_interventions: true }`), {
      id: SHARED, guildId: TEAM, parentId: null, isThread: false, kind: 'text',
    });
    expect(result).toMatchObject({ source: 'platform_boundary', needsReview: false,
      rule: { ingest: false, visibility: 'excluded', allow_interventions: false } });
  });

  it('wins over a thread override, and a thread inherits the stored parent boundary', () => {
    const db = setup('excluded');
    const result = resolveObservedChannelPolicy(db, policy(`  "${THREAD}": { ingest: true, visibility: org, allow_interventions: false }`), {
      id: THREAD, guildId: TEAM, parentId: SHARED, isThread: true, kind: 'thread', platformBoundary: null,
    });
    expect(result.source).toBe('platform_boundary');
    expect(result.rule.visibility).toBe('excluded');
  });

  it('wins over an org review decision', () => {
    const db = setup('excluded');
    db.prepare(`INSERT INTO channel_policy_reviews (id,workspace_id,channel_id,observed_parent_id,status,delivery_state,
      reviewed_by_user_id,reviewed_at_ms,created_at_ms,updated_at_ms)
      VALUES ('r1',?,?,NULL,'org','sent','U0000000001',?,?,?)`).run(TEAM, SHARED, NOW, NOW, NOW);
    const result = resolveObservedChannelPolicy(db, policy(), {
      id: SHARED, guildId: TEAM, parentId: null, isThread: false, kind: 'text',
    });
    expect(result.source).toBe('platform_boundary');
    expect(resolveEffectiveChannelPolicy({
      channelId: SHARED, guildId: TEAM, parentId: null, isThread: false, channelKind: 'text',
      staticPolicy: { rule: { ingest: true, visibility: 'org', allow_interventions: true }, source: 'channel' },
      platformBoundary: 'excluded',
    }).rule.visibility).toBe('excluded');
  });

  it('creates no channel-policy review card for a boundary channel', () => {
    const db = setup('excluded');
    db.prepare('UPDATE schema_migrations SET applied_at_ms=? WHERE version=22').run(NOW - 1);
    const outcome = reconcileStoredChannelPolicyReview(db, policy(), SHARED, NOW);
    expect(outcome.enqueued).toBe(false);
    expect(getActiveChannelPolicyReview(db, SHARED)).toBeUndefined();
    const control = setup(null);
    control.prepare('UPDATE schema_migrations SET applied_at_ms=? WHERE version=22').run(NOW - 1);
    expect(reconcileStoredChannelPolicyReview(control, policy(), SHARED, NOW).enqueued).toBe(true);
  });

  it('keeps the stored boundary when an upsert omits it or sends null', () => {
    const db = setup('excluded');
    upsertChannel(db, channelInput({ name: 'renamed' }));
    expect(getChannel(db, SHARED)?.platform_boundary).toBe('excluded');
    upsertChannel(db, channelInput({ platformBoundary: null }));
    expect(getChannel(db, SHARED)?.platform_boundary).toBe('excluded');
  });

  it('sets a boundary on a channel that had none', () => {
    const db = setup(null);
    upsertChannel(db, channelInput({ platformBoundary: 'excluded' }));
    expect(getChannel(db, SHARED)?.platform_boundary).toBe('excluded');
  });

  it('rejects a direct update that clears the boundary', () => {
    const db = setup('excluded');
    expect(() => db.prepare('UPDATE channels SET platform_boundary = NULL WHERE id = ?').run(SHARED))
      .toThrow(/platform boundary is permanent/);
    expect(getChannel(db, SHARED)?.platform_boundary).toBe('excluded');
  });

  it('keeps the stored boundary when the platform now reports the channel as not shared', () => {
    const db = setup('excluded');
    const result = resolveObservedChannelPolicy(db, policy(`  "${SHARED}": { ingest: true, visibility: org, allow_interventions: true }`), {
      id: SHARED, guildId: TEAM, parentId: null, isThread: false, kind: 'text', platformBoundary: null,
    });
    expect(result.source).toBe('platform_boundary');
    expect(result.rule.visibility).toBe('excluded');
  });
});
