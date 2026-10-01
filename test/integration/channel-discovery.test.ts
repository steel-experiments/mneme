import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  computePermissionFingerprint,
  recordAccessAudit,
  getLatestAccessAudit,
  countAccessAudits,
  NO_ACCESS,
} from '../../src/db/repositories/channel-access.js';
import { getChannel } from '../../src/db/repositories/channels.js';
import {
  decideChannelPolicyReview,
  getActiveChannelPolicyReview,
} from '../../src/db/repositories/channel-policy-reviews.js';
import { parseChannelPolicy } from '../../src/policy/channel-policy.js';
import { basicChannelPolicySourceText } from '../../src/policy/channel-policy-bootstrap.js';
import { backfillJobKey, runStartupSync } from '../../src/ingestion/sync.js';
import {
  discoverChannels,
  describeAccessWarnings,
  DiscoveryError,
  GUILD_TEXT,
  GUILD_FORUM,
  PUBLIC_THREAD,
  GUILD_CATEGORY,
  type DiscoveredChannelDescriptor,
  type ChannelAccessCapabilities,
} from '../../src/ingestion/discovery.js';

/**
 * Channel discovery and access auditing (Sections 6.3, 6.5, 7, 9.2, 48).
 */

const GUILD = '100000000000000001';
const NOW = 1_700_000_001_000;

const CAT = '200000000000000001';
const TEXT = '200000000000000002';
const THREAD = '200000000000000003';
const EXCLUDED = '200000000000000004';
const FORUM = '200000000000000005';
const INACCESSIBLE = '200000000000000006';
const REVIEW = '200000000000000007';

const FULL: ChannelAccessCapabilities = {
  canView: true,
  canReadHistory: true,
  canSend: true,
  canSendInThreads: true,
  canManageThreads: true,
};

const POLICY_YAML = `
version: 1
default:
  ingest: true
  visibility: restricted
  allow_interventions: false
categories:
  "${CAT}":
    ingest: true
    visibility: org
    allow_interventions: true
channels:
  "${EXCLUDED}":
    ingest: false
    visibility: excluded
    allow_interventions: false
review_channel:
  id: "${REVIEW}"
  secure: true
  accepts_scopes: [org, restricted, review_only]
`;

function fullDescriptors(): DiscoveredChannelDescriptor[] {
  return [
    { id: CAT, parentId: null, type: GUILD_CATEGORY, name: 'Engineering' },
    { id: TEXT, parentId: CAT, type: GUILD_TEXT, name: 'general', capabilities: FULL, lastMessageId: '900000000000000001' },
    { id: THREAD, parentId: TEXT, type: PUBLIC_THREAD, name: 'side', capabilities: FULL },
    { id: EXCLUDED, parentId: null, type: GUILD_TEXT, name: 'legal', capabilities: FULL },
    { id: FORUM, parentId: null, type: GUILD_FORUM, name: 'forum', capabilities: FULL },
    // Inaccessible: cannot view → recorded but not persisted.
    { id: INACCESSIBLE, parentId: null, type: GUILD_TEXT, name: 'hidden', capabilities: NO_ACCESS },
    { id: REVIEW, parentId: null, type: GUILD_TEXT, name: 'review', capabilities: FULL },
  ];
}

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
  db.prepare('UPDATE schema_migrations SET applied_at_ms=? WHERE version=22').run(NOW - 1);
});
afterEach(() => env.cleanup());

describe('channel-access repository', () => {
  it('computePermissionFingerprint is deterministic and distinguishes capabilities', () => {
    expect(computePermissionFingerprint(FULL)).toBe(computePermissionFingerprint(FULL));
    const lesser: ChannelAccessCapabilities = { ...FULL, canManageThreads: false };
    expect(computePermissionFingerprint(lesser)).not.toBe(computePermissionFingerprint(FULL));
  });

  it('records and reads back the latest audit, including the warning text', () => {
    // Need a channel row for the FK.
    db.prepare(
      `INSERT INTO channels (id, workspace_id, parent_id, type, name, is_thread, is_archived, is_locked,
         ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
       VALUES (?, ?, NULL, 0, 'c', 0, 0, 0, 1, 'restricted', 0, ?, ?)`,
    ).run(TEXT, GUILD, NOW, NOW);

    recordAccessAudit(db, {
      channelId: TEXT,
      checkedAtMs: NOW,
      canView: true,
      canReadHistory: false,
      canSend: true,
      canSendInThreads: true,
      canManageThreads: false,
      warning: 'Missing Read Message History',
    });
    const latest = getLatestAccessAudit(db, TEXT)!;
    expect(latest.canView).toBe(1);
    expect(latest.canReadHistory).toBe(0);
    expect(latest.warning).toBe('Missing Read Message History');
    expect(countAccessAudits(db, TEXT)).toBe(1);

    // A newer audit becomes the latest.
    recordAccessAudit(db, {
      channelId: TEXT,
      checkedAtMs: NOW + 1000,
      canView: true,
      canReadHistory: true,
      canSend: true,
      canSendInThreads: true,
      canManageThreads: true,
      warning: null,
    });
    expect(getLatestAccessAudit(db, TEXT)!.checkedAtMs).toBe(NOW + 1000);
    expect(getLatestAccessAudit(db, TEXT)!.warning).toBeNull();
    expect(countAccessAudits(db, TEXT)).toBe(2);
  });
});

describe('describeAccessWarnings', () => {
  it('warns on missing view/history always, send only when interventions allowed', () => {
    const caps: ChannelAccessCapabilities = { ...FULL, canReadHistory: false, canSend: false };
    expect(describeAccessWarnings(caps, { allowInterventions: false, requireManageThreads: false })).toEqual([
      'Missing Read Message History',
    ]);
    expect(describeAccessWarnings(caps, { allowInterventions: true, requireManageThreads: false })).toEqual([
      'Missing Read Message History',
      'Missing Send Messages (interventions blocked)',
    ]);
  });

  it('warns on missing Manage Threads only when required', () => {
    const caps: ChannelAccessCapabilities = { ...FULL, canManageThreads: false };
    expect(describeAccessWarnings(caps, { allowInterventions: false, requireManageThreads: false })).toEqual([]);
    expect(describeAccessWarnings(caps, { allowInterventions: false, requireManageThreads: true })).toEqual([
      'Missing Manage Threads (archived thread discovery limited)',
    ]);
  });
});

describe('discoverChannels', () => {
  it('lists every accessible configured channel with effective policy, source, and warnings', () => {
    const result = discoverChannels(db, fullDescriptors(), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
    });

    const byId = new Map(result.channels.map((c) => [c.id, c]));
    // Text channel under an org category → org, category source, interventions allowed.
    expect(byId.get(TEXT)?.visibilityClass).toBe('org');
    expect(byId.get(TEXT)?.policySource).toBe('category');
    expect(byId.get(TEXT)?.allowInterventions).toBe(true);
    expect(byId.get(TEXT)?.permissionWarnings).toEqual([]);
    expect(byId.get(TEXT)?.syncState).toBe('pending');
    expect(byId.get(TEXT)?.historyComplete).toBe(false);

    // Thread inherits its parent's lineage → org via thread_parent source.
    expect(byId.get(THREAD)?.visibilityClass).toBe('org');
    expect(byId.get(THREAD)?.policySource).toBe('thread_parent');
    expect(byId.get(THREAD)?.isThread).toBe(true);

    // Forum with no parent → default restricted.
    expect(byId.get(FORUM)?.visibilityClass).toBe('restricted');
    expect(byId.get(FORUM)?.policySource).toBe('default');
    expect(getActiveChannelPolicyReview(db, FORUM)).toMatchObject({ status: 'pending' });
    expect(getActiveChannelPolicyReview(db, TEXT)).toBeUndefined();
    expect(getActiveChannelPolicyReview(db, THREAD)).toBeUndefined();
    expect(getActiveChannelPolicyReview(db, REVIEW)).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jobs
      WHERE type='deliver_channel_policy_review' AND status='queued'`).get()).toEqual({ n: 1 });
  });

  it('persists channel metadata with resolved policy and a permission fingerprint', () => {
    discoverChannels(db, fullDescriptors(), { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW });
    const text = getChannel(db, TEXT)!;
    expect(text.visibility_class).toBe('org');
    expect(text.allow_interventions).toBe(1);
    expect(text.ingest_enabled).toBe(1);
    expect(text.permission_fingerprint).toBe(computePermissionFingerprint(FULL));
    expect(text.last_message_id).toBe('900000000000000001');

    // Each accessible channel has exactly one audit row.
    expect(countAccessAudits(db, TEXT)).toBe(1);
    expect(countAccessAudits(db, THREAD)).toBe(1);
    expect(getLatestAccessAudit(db, TEXT)!.warning).toBeNull();
  });

  it('persists an explicit thread override instead of replacing it with parent visibility', () => {
    const policy = parseChannelPolicy(POLICY_YAML.replace(
      `channels:\n`,
      `channels:\n  "${THREAD}":\n    ingest: true\n    visibility: restricted\n    allow_interventions: false\n`,
    ));
    discoverChannels(db, fullDescriptors(), { guildId: GUILD, policy, now: NOW });
    expect(getChannel(db, TEXT)?.visibility_class).toBe('org');
    expect(getChannel(db, THREAD)?.visibility_class).toBe('restricted');
  });

  it('excludes channels per policy but still persists them as ingest_enabled=0', () => {
    const result = discoverChannels(db, fullDescriptors(), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
    });
    const excluded = result.excluded.find((c) => c.id === EXCLUDED)!;
    expect(excluded.visibilityClass).toBe('excluded');
    expect(excluded.ingest).toBe(false);
    expect(excluded.policySource).toBe('channel');
    // Persisted with the excluded policy so it is not re-flagged as new.
    const row = getChannel(db, EXCLUDED)!;
    expect(row.ingest_enabled).toBe(0);
    expect(row.visibility_class).toBe('excluded');
    expect(row.deleted_at_ms).toBeNull();
    // Excluded channels are not in the accessible list.
    expect(result.channels.find((c) => c.id === EXCLUDED)).toBeUndefined();
  });

  it('records inaccessible channels without persisting metadata (no FK row, no audit)', () => {
    const result = discoverChannels(db, fullDescriptors(), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
    });
    const hidden = result.inaccessible.find((c) => c.id === INACCESSIBLE)!;
    expect(hidden.accessible).toBe(false);
    expect(hidden.permissionWarnings).toContain('Missing View Channel');
    expect(getChannel(db, INACCESSIBLE)).toBeUndefined();
    expect(countAccessAudits(db, INACCESSIBLE)).toBe(0);
  });

  it('fails closed and disables ingestion when Read Message History is lost', () => {
    const descriptor = fullDescriptors().find((d) => d.id === TEXT)!;
    discoverChannels(db, fullDescriptors(), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
    });
    expect(getChannel(db, TEXT)?.ingest_enabled).toBe(1);

    const result = discoverChannels(db, fullDescriptors().map((d) => d.id === TEXT
      ? { ...descriptor, capabilities: { ...FULL, canReadHistory: false } }
      : d), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW + 1,
    });

    expect(result.inaccessible.some((c) => c.id === TEXT)).toBe(true);
    expect(getChannel(db, TEXT)?.ingest_enabled).toBe(0);
    expect(getChannel(db, TEXT)?.visibility_class).toBe('excluded');
    expect(getLatestAccessAudit(db, TEXT)?.canReadHistory).toBe(0);
  });

  it('fails closed when Discord omits a previously visible channel', () => {
    discoverChannels(db, fullDescriptors(), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
    });
    const result = discoverChannels(db, fullDescriptors().filter((d) => d.id !== TEXT), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW + 1,
    });
    expect(result.inaccessible.some((channel) => channel.id === TEXT)).toBe(true);
    expect(getChannel(db, TEXT)?.ingest_enabled).toBe(0);
    expect(getChannel(db, TEXT)?.visibility_class).toBe('excluded');
  });

  it('preserves an omitted known archived thread during the active-only phase', () => {
    const descriptors = fullDescriptors().map((descriptor) => descriptor.id === THREAD
      ? { ...descriptor, archived: true }
      : descriptor);
    discoverChannels(db, descriptors, {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      missingThreadMode: 'close',
    });

    const auditsBefore = countAccessAudits(db, THREAD);
    const result = discoverChannels(db, descriptors.filter((descriptor) => descriptor.id !== THREAD), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW + 1,
      missingThreadMode: 'preserve',
    });

    expect(result.inaccessible.some((channel) => channel.id === THREAD)).toBe(false);
    expect(getChannel(db, THREAD)?.ingest_enabled).toBe(1);
    expect(getChannel(db, THREAD)?.visibility_class).toBe('org');
    expect(countAccessAudits(db, THREAD)).toBe(auditsBefore);
  });

  it('quarantines an omitted thread when archive coverage is incomplete', () => {
    discoverChannels(db, fullDescriptors(), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      missingThreadMode: 'close',
    });

    const result = discoverChannels(db, fullDescriptors().filter((descriptor) => descriptor.id !== THREAD), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW + 1,
      missingThreadMode: 'quarantine',
    });

    expect(result.inaccessible.find((channel) => channel.id === THREAD)?.permissionWarnings)
      .toEqual(['archived thread access unverified: archive coverage incomplete']);
    expect(getChannel(db, THREAD)?.ingest_enabled).toBe(0);
    expect(getChannel(db, THREAD)?.visibility_class).toBe('excluded');
    expect(getLatestAccessAudit(db, THREAD)?.warning).toContain('coverage incomplete');
  });

  it('closes an omitted thread only for a complete combined snapshot', () => {
    discoverChannels(db, fullDescriptors(), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
      missingThreadMode: 'close',
    });

    const result = discoverChannels(db, fullDescriptors().filter((descriptor) => descriptor.id !== THREAD), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW + 1,
      missingThreadMode: 'close',
    });

    expect(result.inaccessible.find((channel) => channel.id === THREAD)?.permissionWarnings)
      .toEqual(['thread was omitted from complete active and archived discovery']);
    expect(getChannel(db, THREAD)?.ingest_enabled).toBe(0);
    expect(getLatestAccessAudit(db, THREAD)?.warning).toContain('complete active and archived');
  });

  it('reflects an existing sync cursor in the summary sync state', () => {
    // Pre-seed a cursor for the text channel.
    db.prepare(
      `INSERT INTO channels (id, workspace_id, parent_id, type, name, is_thread, is_archived, is_locked,
         ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
       VALUES (?, ?, NULL, 0, 'pre', 0, 0, 0, 1, 'restricted', 0, ?, ?)`,
    ).run(TEXT, GUILD, NOW - 1000, NOW - 1000);
    db.prepare(
      `INSERT INTO sync_cursors (channel_id, state, history_complete, updated_at_ms) VALUES (?, 'live', 1, ?)`,
    ).run(TEXT, NOW - 500);

    const result = discoverChannels(db, fullDescriptors(), {
      guildId: GUILD,
      policy: parseChannelPolicy(POLICY_YAML),
      now: NOW,
    });
    const text = result.channels.find((c) => c.id === TEXT)!;
    expect(text.syncState).toBe('live');
    expect(text.historyComplete).toBe(true);
  });

  it('records permission warnings when an org/intervention channel lacks Send Messages', () => {
    const caps: ChannelAccessCapabilities = { ...FULL, canSend: false, canSendInThreads: false };
    const descriptors: DiscoveredChannelDescriptor[] = [
      { id: CAT, parentId: null, type: GUILD_CATEGORY, name: 'c' },
      { id: TEXT, parentId: CAT, type: GUILD_TEXT, name: 'general', capabilities: caps },
      { id: REVIEW, parentId: null, type: GUILD_TEXT, name: 'review', capabilities: FULL },
    ];
    const result = discoverChannels(db, descriptors, { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW });
    const text = result.channels.find((c) => c.id === TEXT)!;
    expect(text.permissionWarnings).toEqual([
      'Missing Send Messages (interventions blocked)',
      'Missing Send Messages in Threads (interventions blocked)',
    ]);
    expect(getLatestAccessAudit(db, TEXT)!.warning).toContain('Missing Send Messages');
  });

  it('ignores non text-bearing channel types (voice, stage) in the enumeration', () => {
    const descriptors: DiscoveredChannelDescriptor[] = [
      { id: REVIEW, parentId: null, type: GUILD_TEXT, name: 'review', capabilities: FULL },
      { id: '200000000000000008', parentId: null, type: 2, name: 'voice', capabilities: FULL },
      { id: '200000000000000009', parentId: null, type: 13, name: 'stage', capabilities: FULL },
    ];
    const result = discoverChannels(db, descriptors, { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW });
    const ids = result.channels.map((c) => c.id);
    expect(ids).not.toContain('200000000000000008');
    expect(ids).not.toContain('200000000000000009');
  });

  it('is idempotent: re-discovery does not duplicate audits or churn metadata', () => {
    const policy = parseChannelPolicy(POLICY_YAML);
    const opts = { guildId: GUILD, policy, now: NOW };
    discoverChannels(db, fullDescriptors(), opts);
    const first = getChannel(db, TEXT)!;
    expect(countAccessAudits(db, TEXT)).toBe(1);

    discoverChannels(db, fullDescriptors(), opts);
    expect(countAccessAudits(db, TEXT)).toBe(2); // a new audit per run (latest-wins)
    const second = getChannel(db, TEXT)!;
    // discovered_at_ms preserved across rediscovery; no tombstone introduced.
    expect(second.discovered_at_ms).toBe(first.discovered_at_ms);
    expect(second.deleted_at_ms).toBeNull();
  });

  it('clears a stale tombstone when a previously-deleted channel reappears', () => {
    const policy = parseChannelPolicy(POLICY_YAML);
    discoverChannels(db, fullDescriptors(), { guildId: GUILD, policy, now: NOW });
    db.prepare('UPDATE channels SET deleted_at_ms = ? WHERE id = ?').run(NOW + 1, TEXT);
    expect(getChannel(db, TEXT)!.deleted_at_ms).not.toBeNull();

    discoverChannels(db, fullDescriptors(), { guildId: GUILD, policy, now: NOW + 2 });
    expect(getChannel(db, TEXT)!.deleted_at_ms).toBeNull();
  });

  describe('review channel validation', () => {
    it('passes when the secure review channel is present and accessible', () => {
      const result = discoverChannels(db, fullDescriptors(), {
        guildId: GUILD,
        policy: parseChannelPolicy(POLICY_YAML),
        now: NOW,
      });
      expect(result.review).toEqual({
        configured: true,
        channelId: REVIEW,
        present: true,
        accessible: true,
        ok: true,
        warning: null,
      });
    });

    it('throws DiscoveryError when the secure review channel is absent', () => {
      const descriptors = fullDescriptors().filter((d) => d.id !== REVIEW);
      expect(() =>
        discoverChannels(db, descriptors, { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW }),
      ).toThrow(DiscoveryError);
    });

    it('throws DiscoveryError when the review channel exists but is inaccessible', () => {
      const descriptors: DiscoveredChannelDescriptor[] = [
        { id: REVIEW, parentId: null, type: GUILD_TEXT, name: 'review', capabilities: NO_ACCESS },
      ];
      expect(() =>
        discoverChannels(db, descriptors, { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW }),
      ).toThrow(DiscoveryError);
    });

    it('does not require a review channel when none is configured', () => {
      const noReview = parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: restricted
  allow_interventions: false
`);
      const result = discoverChannels(db, [{ id: TEXT, parentId: null, type: GUILD_TEXT, name: 'g', capabilities: FULL }], {
        guildId: GUILD,
        policy: noReview,
        now: NOW,
      });
      expect(result.review.configured).toBe(false);
      expect(result.review.ok).toBe(true);
    });
  });
});

describe('discoverChannels in basic mode', () => {
  /** A basic-built policy that selects only the org category. */
  function basicPolicy() {
    return parseChannelPolicy(basicChannelPolicySourceText({ ORG_VISIBLE_CHANNEL_IDS: CAT }));
  }

  it('never consults a stored approved review for an unselected channel', async () => {
    // A file-mode deployment discovered the forum, queued a card, and an admin
    // approved it as org. The row is stale once the deployment moves to basic
    // mode: the selection lists decide, and the forum is unselected.
    discoverChannels(db, fullDescriptors(), { guildId: GUILD, policy: parseChannelPolicy(POLICY_YAML), now: NOW });
    const pending = getActiveChannelPolicyReview(db, FORUM);
    expect(pending).toMatchObject({ status: 'pending' });
    decideChannelPolicyReview(db, {
      reviewId: pending!.id, decision: 'org', actorUserId: '100000000000000003', now: NOW + 1,
    });
    expect(getActiveChannelPolicyReview(db, FORUM)).toMatchObject({ status: 'org' });

    const result = await runStartupSync({
      db,
      guildId: GUILD,
      policy: basicPolicy(),
      channelPolicySource: 'basic',
      now: NOW + 2,
      channels: fullDescriptors().filter((d) => d.id !== REVIEW),
    });

    const forum = result.discovery.channels.find((c) => c.id === FORUM);
    expect(forum).toBeUndefined();
    expect(result.discovery.excluded.find((c) => c.id === FORUM)).toMatchObject({
      ingest: false, visibilityClass: 'restricted', policySource: 'default',
    });
    expect(getChannel(db, FORUM)).toMatchObject({ ingest_enabled: 0, visibility_class: 'restricted' });
    expect(result.backfillEnqueued).not.toContain(FORUM);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='backfill_channel' AND unique_key=?")
      .get(backfillJobKey(FORUM))).toEqual({ n: 0 });
    // The stale decision is closed out rather than left active.
    expect(getActiveChannelPolicyReview(db, FORUM)).toBeUndefined();
    expect(db.prepare('SELECT status, superseded_reason FROM channel_policy_reviews WHERE id=?').get(pending!.id))
      .toEqual({ status: 'superseded', superseded_reason: 'static_policy' });
    // The selected category still applies to the text channel under it.
    expect(result.discovery.channels.find((c) => c.id === TEXT)).toMatchObject({
      visibilityClass: 'org', policySource: 'category',
    });
  });
});
