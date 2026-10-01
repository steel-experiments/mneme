import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { parseChannelPolicy } from '../../src/policy/channel-policy.js';
import {
  reconcileStoredChannelPolicyReview,
  resolveObservedChannelPolicy,
} from '../../src/policy/channel-policy-review-service.js';
import {
  getActiveChannelPolicyReview,
  getChannelPolicyReview,
  markChannelPolicyReviewSending,
} from '../../src/db/repositories/channel-policy-reviews.js';
import {
  buildChannelPolicyReviewCard,
  channelPolicyReviewMarker,
  createDeliverChannelPolicyReviewHandler,
  parseChannelPolicyReviewComponent,
  signChannelPolicyReviewComponent,
  type ChannelPolicyReviewDiscordPort,
} from '../../src/platform/discord/channel-policy-review-message.js';
import { applyChannelPolicyReviewDecision } from '../../src/platform/discord/channel-policy-review-interactions.js';
import { basicChannelPolicySourceText } from '../../src/policy/channel-policy-bootstrap.js';
import type { JobRow } from '../../src/jobs/types.js';

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002';
const REVIEW_CHANNEL = '100000000000000004';
const ADMIN = '100000000000000005';
const ADMIN_ROLE = '100000000000000006';
const NOW = 1_780_000_000_000;
const SECRET = 'test-review-secret';

function policy(extraChannels = '') {
  return parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: restricted
  allow_interventions: false
channels:
${extraChannels || '  {}'}
review_channel:
  id: "${REVIEW_CHANNEL}"
  secure: true
  accepts_scopes: [org, restricted, review_only]
`);
}

function insertChannel(t: TestDb, id: string, name: string, parentId: string | null = null) {
  t.db.prepare(`INSERT INTO channels
    (id,workspace_id,parent_id,kind,name,is_thread,is_archived,is_locked,ingest_enabled,
     visibility_class,allow_interventions,discovered_at_ms,updated_at_ms)
    VALUES (?,?,?,'text',?,0,0,0,1,'restricted',0,?,?)`).run(id, GUILD, parentId, name, NOW, NOW);
}

describe('durable new-channel policy review', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  function setup() {
    t = createTestDb();
    seedIdentity(t.db, GUILD);
    t.db.prepare('UPDATE schema_migrations SET applied_at_ms=? WHERE version=22').run(NOW - 1);
    t.db.prepare('UPDATE channels SET discovered_at_ms=?,updated_at_ms=? WHERE id=?')
      .run(NOW, NOW, CHANNEL);
    insertChannel(t, REVIEW_CHANNEL, 'mneme-review');
    return t;
  }

  it('creates one pending review and one active delivery job for a default channel', () => {
    const db = setup().db;
    const first = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW);
    const second = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW + 1);

    expect(first.created).toBe(true);
    expect(first.enqueued).toBe(true);
    expect(second.created).toBe(false);
    expect(second.enqueued).toBe(false);
    const review = getActiveChannelPolicyReview(db, CHANNEL);
    expect(review).toMatchObject({ status: 'pending', observed_parent_id: null, delivery_state: 'queued' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jobs
      WHERE type='deliver_channel_policy_review' AND status IN ('queued','running')`).get())
      .toEqual({ n: 1 });
    expect(resolveObservedChannelPolicy(db, policy(), {
      id: CHANNEL, guildId: GUILD, parentId: null, isThread: false, kind: 'text',
    })).toMatchObject({ source: 'default', needsReview: true, rule: { visibility: 'restricted' } });
  });

  it('does not flood review with channels discovered before migration activation', () => {
    const db = setup().db;
    db.prepare('UPDATE schema_migrations SET applied_at_ms=? WHERE version=22').run(NOW + 1);
    const result = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW + 2);
    expect(result.created).toBe(false);
    expect(getActiveChannelPolicyReview(db, CHANNEL)).toBeUndefined();
    expect(resolveObservedChannelPolicy(db, policy(), {
      id: CHANNEL, guildId: GUILD, parentId: null, isThread: false, kind: 'text',
    }).rule.visibility).toBe('restricted');
  });

  it('does not review explicit channels, threads, or the secure review channel', () => {
    const db = setup().db;
    const explicit = policy(`  "${CHANNEL}":
    ingest: true
    visibility: org
    allow_interventions: true`);
    expect(reconcileStoredChannelPolicyReview(db, explicit, CHANNEL, NOW).created).toBe(false);
    expect(reconcileStoredChannelPolicyReview(db, explicit, REVIEW_CHANNEL, NOW).created).toBe(false);

    const thread = '100000000000000007';
    t!.db.prepare(`INSERT INTO channels
      (id,workspace_id,parent_id,kind,name,is_thread,is_archived,is_locked,ingest_enabled,
       visibility_class,allow_interventions,discovered_at_ms,updated_at_ms)
      VALUES (?,?,?,'thread','thread',1,0,0,1,'restricted',0,?,?)`)
      .run(thread, GUILD, CHANNEL, NOW, NOW);
    expect(reconcileStoredChannelPolicyReview(db, policy(), thread, NOW).created).toBe(false);
  });

  it('does not review unsupported top-level channel types', () => {
    const db = setup().db;
    const voice = '100000000000000009';
    t!.db.prepare(`INSERT INTO channels
      (id,workspace_id,parent_id,kind,name,is_thread,is_archived,is_locked,ingest_enabled,
       visibility_class,allow_interventions,discovered_at_ms,updated_at_ms)
      VALUES (?,?,?,'other','voice',0,0,0,1,'restricted',0,?,?)`)
      .run(voice, GUILD, null, NOW, NOW);
    expect(reconcileStoredChannelPolicyReview(db, policy(), voice, NOW)).toMatchObject({
      created: false,
      enqueued: false,
    });
    expect(getActiveChannelPolicyReview(db, voice)).toBeUndefined();
  });

  it('resolves a live non-thread raw parent as its category without a category row', () => {
    const db = setup().db;
    const category = '100000000000000008';
    const categoryPolicy = parseChannelPolicy(`
version: 1
default: { ingest: true, visibility: restricted, allow_interventions: false }
categories:
  "${category}": { ingest: true, visibility: org, allow_interventions: true }
review_channel:
  id: "${REVIEW_CHANNEL}"
  secure: true
  accepts_scopes: [org, restricted, review_only]
`);
    expect(resolveObservedChannelPolicy(db, categoryPolicy, {
      id: CHANNEL, guildId: GUILD, parentId: category, isThread: false, kind: 'text',
    })).toMatchObject({ source: 'category', needsReview: false, rule: { visibility: 'org' } });
    expect(db.prepare('SELECT 1 FROM channels WHERE id=?').get(category)).toBeUndefined();
  });

  it('renders metadata-only signed controls', () => {
    const card = buildChannelPolicyReviewCard({
      reviewId: '00000000-0000-4000-8000-000000000001',
      channelId: CHANNEL,
      channelName: 'private-project',
      channelType: 0,
      parentId: null,
      parentName: null,
    }, SECRET);
    const json = JSON.stringify(card);
    expect(json).toContain('New channel needs classification');
    expect(json).not.toContain('topic');
    const customId = signChannelPolicyReviewComponent('org', '00000000-0000-4000-8000-000000000001', SECRET);
    expect(customId.length).toBeLessThanOrEqual(100);
    expect(parseChannelPolicyReviewComponent(customId, SECRET)).toEqual({
      action: 'org', reviewId: '00000000-0000-4000-8000-000000000001',
    });
    expect(parseChannelPolicyReviewComponent(`${customId}x`, SECRET)).toBeUndefined();
  });

  it('recovers a sending card from its stable marker without sending twice', async () => {
    const db = setup().db;
    const reconciled = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW);
    const reviewId = reconciled.reviewId!;
    markChannelPolicyReviewSending(db, reviewId, NOW + 1);
    let sends = 0;
    const port: ChannelPolicyReviewDiscordPort = {
      async send() { sends += 1; return { id: 'sent-unexpected' }; },
      async findByMarker(_channelId, marker) {
        expect(marker).toBe(channelPolicyReviewMarker(reviewId));
        return { id: 'recovered-message' };
      },
      async resolve() {},
    };
    const handler = createDeliverChannelPolicyReviewHandler({
      db, reviewChannelId: REVIEW_CHANNEL, port, secret: SECRET, now: () => NOW + 2,
    });
    await handler({ reviewId }, {} as JobRow);
    expect(sends).toBe(0);
    expect(getChannelPolicyReview(db, reviewId)).toMatchObject({
      delivery_state: 'sent', review_message_id: 'recovered-message',
    });
  });

  it('records a click as delivery proof when it races the post-send database update', async () => {
    const db = setup().db;
    const reviewId = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW).reviewId!;
    const port: ChannelPolicyReviewDiscordPort = {
      async send() {
        const result = applyChannelPolicyReviewDecision({
          db,
          policy: policy(),
          reviewId,
          decision: 'restricted',
          actorUserId: ADMIN,
          guildId: GUILD,
          memberRoleIds: [ADMIN_ROLE],
          adminRoleIds: [ADMIN_ROLE],
          deliveredMessageId: 'clicked-card',
          now: NOW + 1,
        });
        expect(result).toMatchObject({ outcome: 'decided', reviewMessageId: 'clicked-card' });
        return { id: 'clicked-card' };
      },
      async findByMarker() { return undefined; },
      async resolve() {},
    };
    const handler = createDeliverChannelPolicyReviewHandler({
      db, reviewChannelId: REVIEW_CHANNEL, port, secret: SECRET, now: () => NOW + 2,
    });
    await handler({ reviewId }, {} as JobRow);
    expect(getChannelPolicyReview(db, reviewId)).toMatchObject({
      status: 'restricted',
      delivery_state: 'sent',
      review_message_id: 'clicked-card',
    });
  });

  it('applies one authorized decision and keeps interventions disabled', () => {
    const db = setup().db;
    const reviewId = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW).reviewId!;
    const first = applyChannelPolicyReviewDecision({
      db, policy: policy(), reviewId, decision: 'org', actorUserId: ADMIN, guildId: GUILD,
      memberRoleIds: [ADMIN_ROLE], adminRoleIds: [ADMIN_ROLE], now: NOW + 1,
    });
    const second = applyChannelPolicyReviewDecision({
      db, policy: policy(), reviewId, decision: 'excluded', actorUserId: ADMIN, guildId: GUILD,
      memberRoleIds: [ADMIN_ROLE], adminRoleIds: [ADMIN_ROLE], now: NOW + 2,
    });
    expect(first.outcome).toBe('decided');
    expect(second.outcome).toBe('stale');
    expect(db.prepare('SELECT ingest_enabled,visibility_class,allow_interventions FROM channels WHERE id=?')
      .get(CHANNEL)).toEqual({ ingest_enabled: 1, visibility_class: 'org', allow_interventions: 0 });
    expect(resolveObservedChannelPolicy(db, policy(), {
      id: CHANNEL, guildId: GUILD, parentId: null, isThread: false, kind: 'text',
    })).toMatchObject({ source: 'review', needsReview: false, rule: { visibility: 'org' } });
  });

  it('fails closed when durable review identity does not match the observed guild', () => {
    const db = setup().db;
    const reviewId = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW).reviewId!;
    applyChannelPolicyReviewDecision({
      db, policy: policy(), reviewId, decision: 'org', actorUserId: ADMIN, guildId: GUILD,
      memberRoleIds: [ADMIN_ROLE], adminRoleIds: [ADMIN_ROLE], now: NOW + 1,
    });
    const otherGuild = '100000000000000099';
    db.prepare(`INSERT INTO workspaces
      (id,name,owner_id,joined_at_ms,discovered_at_ms,updated_at_ms,raw_json)
      VALUES (?,'other',NULL,?,?,?,NULL)`).run(otherGuild, NOW, NOW, NOW);
    db.prepare('UPDATE channel_policy_reviews SET workspace_id=? WHERE id=?').run(otherGuild, reviewId);
    expect(resolveObservedChannelPolicy(db, policy(), {
      id: CHANNEL, guildId: GUILD, parentId: null, isThread: false, kind: 'text',
    })).toMatchObject({ source: 'default', needsReview: true, rule: { visibility: 'restricted' } });
  });

  it('denies unauthorized decisions and audits the attempt', () => {
    const db = setup().db;
    const reviewId = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW).reviewId!;
    const result = applyChannelPolicyReviewDecision({
      db, policy: policy(), reviewId, decision: 'excluded', actorUserId: ADMIN, guildId: GUILD,
      memberRoleIds: [], adminRoleIds: [ADMIN_ROLE], now: NOW + 1,
    });
    expect(result.outcome).toBe('unauthorized');
    expect(getChannelPolicyReview(db, reviewId)?.status).toBe('pending');
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_events WHERE action='channel_policy_review'").get())
      .toEqual({ n: 1 });
  });

  it('supersedes a decision after a parent move and creates a fresh restricted review', () => {
    const db = setup().db;
    const firstId = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW).reviewId!;
    applyChannelPolicyReviewDecision({
      db, policy: policy(), reviewId: firstId, decision: 'org', actorUserId: ADMIN, guildId: GUILD,
      memberRoleIds: [ADMIN_ROLE], adminRoleIds: [ADMIN_ROLE], now: NOW + 1,
    });
    const category = '100000000000000008';
    db.prepare('UPDATE channels SET parent_id=?,updated_at_ms=? WHERE id=?').run(category, NOW + 2, CHANNEL);
    const moved = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW + 2);
    expect(moved.created).toBe(true);
    expect(moved.superseded).toBe(true);
    expect(getChannelPolicyReview(db, firstId)).toMatchObject({ status: 'superseded', superseded_reason: 'parent_changed' });
    expect(getActiveChannelPolicyReview(db, CHANNEL)).toMatchObject({ status: 'pending', observed_parent_id: category });
    expect(resolveObservedChannelPolicy(db, policy(), {
      id: CHANNEL, guildId: GUILD, parentId: category, isThread: false, kind: 'text',
    }).rule.visibility).toBe('restricted');
  });
});

describe('basic-mode policy source and classification reviews', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  function setup() {
    t = createTestDb();
    seedIdentity(t.db, GUILD);
    t.db.prepare('UPDATE schema_migrations SET applied_at_ms=? WHERE version=22').run(NOW - 1);
    t.db.prepare('UPDATE channels SET discovered_at_ms=?,updated_at_ms=? WHERE id=?')
      .run(NOW, NOW, CHANNEL);
    insertChannel(t, REVIEW_CHANNEL, 'mneme-review');
    return t;
  }

  /** The real basic-built policy: one selected channel, fail-closed default, review channel from env. */
  function basicPolicy() {
    return parseChannelPolicy(basicChannelPolicySourceText({
      ORG_VISIBLE_CHANNEL_IDS: '100000000000000042',
      MNEME_REVIEW_CHANNEL_ID: REVIEW_CHANNEL,
      MNEME_REVIEW_CHANNEL_SECURE: 'true',
    }));
  }

  it('basic mode queues no classification review for a discovered default-resolved channel', () => {
    const db = setup().db;
    const result = reconcileStoredChannelPolicyReview(db, basicPolicy(), CHANNEL, NOW, {
      channelPolicySource: 'basic',
    });
    expect(result).toMatchObject({ created: false, enqueued: false, superseded: false });
    expect(result.reviewId).toBeUndefined();
    expect(getActiveChannelPolicyReview(db, CHANNEL)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM channel_policy_reviews').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jobs
      WHERE type='deliver_channel_policy_review'`).get()).toEqual({ n: 0 });
    // Discovery behavior itself is unchanged: the unselected channel stays
    // fail-closed restricted through the default rule.
    expect(resolveObservedChannelPolicy(db, basicPolicy(), {
      id: CHANNEL, guildId: GUILD, parentId: null, isThread: false, kind: 'text',
    })).toMatchObject({ source: 'default', rule: { ingest: false, visibility: 'restricted' } });
  });

  it('basic mode supersedes a card that a file-mode deployment left pending', () => {
    const db = setup().db;
    const reviewId = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW).reviewId!;
    const result = reconcileStoredChannelPolicyReview(db, basicPolicy(), CHANNEL, NOW + 1, {
      channelPolicySource: 'basic',
    });
    expect(result.superseded).toBe(true);
    expect(result.created).toBe(false);
    expect(getChannelPolicyReview(db, reviewId)).toMatchObject({
      status: 'superseded',
      superseded_reason: 'static_policy',
    });
    expect(getActiveChannelPolicyReview(db, CHANNEL)).toBeUndefined();
  });

  it('basic mode never consults an approved decision that a file-mode deployment stored', () => {
    const db = setup().db;
    const reviewId = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW).reviewId!;
    applyChannelPolicyReviewDecision({
      db, policy: policy(), reviewId, decision: 'org', actorUserId: ADMIN, guildId: GUILD,
      memberRoleIds: [ADMIN_ROLE], adminRoleIds: [ADMIN_ROLE], now: NOW + 1,
    });
    expect(getActiveChannelPolicyReview(db, CHANNEL)).toMatchObject({ status: 'org' });
    // The row is still active, yet the unselected channel resolves through the
    // fail-closed default rather than the stale org decision.
    expect(resolveObservedChannelPolicy(db, basicPolicy(), {
      id: CHANNEL, guildId: GUILD, parentId: null, isThread: false, kind: 'text',
    }, { channelPolicySource: 'basic' })).toMatchObject({
      source: 'default', rule: { ingest: false, visibility: 'restricted' },
    });
  });

  it('explicit file mode still queues the classification review', () => {
    const db = setup().db;
    const result = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW, {
      channelPolicySource: 'file',
    });
    expect(result.created).toBe(true);
    expect(result.enqueued).toBe(true);
    expect(getActiveChannelPolicyReview(db, CHANNEL)).toMatchObject({ status: 'pending' });
  });

  it('refuses a stale card decision in basic mode and keeps the audit trail', () => {
    const db = setup().db;
    const reviewId = reconcileStoredChannelPolicyReview(db, policy(), CHANNEL, NOW).reviewId!;
    const result = applyChannelPolicyReviewDecision({
      db, policy: basicPolicy(), reviewId, decision: 'org', actorUserId: ADMIN, guildId: GUILD,
      memberRoleIds: [ADMIN_ROLE], adminRoleIds: [ADMIN_ROLE],
      channelPolicySource: 'basic', now: NOW + 1,
    });
    expect(result.outcome).toBe('basic_mode');
    // Nothing is decided: the row, the channel, and the channel rule stay as-is.
    expect(getChannelPolicyReview(db, reviewId)?.status).toBe('pending');
    expect(db.prepare('SELECT ingest_enabled,visibility_class FROM channels WHERE id=?')
      .get(CHANNEL)).toEqual({ ingest_enabled: 1, visibility_class: 'restricted' });
    const events = db.prepare(
      "SELECT details_json FROM admin_events WHERE action='channel_policy_review'",
    ).all() as Array<{ details_json: string }>;
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event && JSON.parse(event.details_json)).toMatchObject({
      authorized: true,
      outcome: 'basic_mode',
      decision: 'org',
      channelId: CHANNEL,
    });
  });
});
