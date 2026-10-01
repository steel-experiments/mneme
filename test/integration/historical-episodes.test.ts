import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { processHistoricalBatch } from '../../src/jobs/handlers/build-historical-episodes.js';
import { ensureHistoricalCampaign, wakeHistoricalCampaignReviews } from '../../src/historical/campaign.js';

const NOW = 1_700_100_000_000;
const config = { batchMessages: 200, maxPendingReviews: 4, quietSeconds: 90, maxMessages: 40, maxMinutes: 10 };
let env: TestDb;
let db: DatabaseSync;
let ids: ReturnType<typeof seedIdentity>;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  ids = seedIdentity(db);
  db.prepare("UPDATE channels SET visibility_class='org', ingest_enabled=1 WHERE id=?").run(ids.channelId);
  db.prepare(`INSERT INTO sync_cursors
    (channel_id,state,history_complete,updated_at_ms) VALUES (?,'live',1,?)`).run(ids.channelId, NOW);
});
afterEach(() => env.cleanup());

function seedChannel(
  id: string,
  options: { name?: string; parentId?: string | null; isThread?: boolean } = {},
): void {
  upsertChannel(db, {
    id,
    guildId: ids.guildId,
    parentId: options.parentId ?? null,
    type: options.isThread ? 11 : 0,
    name: options.name ?? id,
    topic: null,
    position: null,
    isThread: options.isThread ?? false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: 'org',
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  });
}

function message(id: string, createdAtMs: number, content: string, channelId = ids.channelId): void {
  upsertMessageCreate(db, {
    id, guildId: ids.guildId, channelId, authorId: ids.userId,
    authorDisplayName: 'Alice', content, createdAtMs, editedAtMs: null,
    replyToMessageId: null, messageType: 0, flags: 0, pinned: false,
    mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]', componentsJson: '[]',
    pollJson: null, rawJson: null, ingestedAtMs: NOW, updatedAtMs: NOW,
  });
}

describe('historical episode reconstruction', () => {
  it('wakes only deferred review jobs belonging to the selected campaign', () => {
    const campaignId = 'wake-test';
    ensureHistoricalCampaign(db, {
      id: campaignId, guildId: ids.guildId, direction: 'newest_first',
      fromAtMs: NOW - 100_000, toAtMs: NOW, provider: 'openai',
      model: 'gpt-5.6-luna', thinkingLevel: 'medium', channelIds: [ids.channelId],
      dailyBudgetUsd: 1, totalBudgetUsd: 2,
    }, NOW);
    message('100000000000001099', NOW - 1_000, 'We decided to wake the review.');
    processHistoricalBatch(db, ids.guildId, { ...config, campaign: {
      id: campaignId, fromAtMs: NOW - 100_000, toAtMs: NOW, direction: 'newest_first' as const,
    } }, NOW);
    db.prepare("UPDATE jobs SET run_after_ms=? WHERE type='review_episode'").run(NOW + 86_400_000);
    const changed = wakeHistoricalCampaignReviews(db, campaignId, NOW + 1);
    expect(changed).toBe(1);
    expect(db.prepare("SELECT run_after_ms FROM jobs WHERE type='review_episode'").get())
      .toEqual({ run_after_ms: NOW + 1 });
  });

  it('does not wake a deferred campaign review after its thread parent becomes a test surface', () => {
    const parentId = '100000000000001090';
    const threadId = '100000000000001091';
    seedChannel(parentId, { name: 'project-history' });
    seedChannel(threadId, { name: 'release-planning', parentId, isThread: true });
    db.prepare(`INSERT INTO sync_cursors
      (channel_id,state,history_complete,updated_at_ms) VALUES (?,'live',1,?)`).run(threadId, NOW);
    const campaignId = 'wake-test-surface';
    ensureHistoricalCampaign(db, {
      id: campaignId,
      guildId: ids.guildId,
      direction: 'newest_first',
      fromAtMs: NOW - 100_000,
      toAtMs: NOW,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      thinkingLevel: 'medium',
      channelIds: [threadId],
      dailyBudgetUsd: 1,
      totalBudgetUsd: 2,
    }, NOW);
    message('100000000000001092', NOW - 1_000, 'We decided to defer this review.', threadId);
    processHistoricalBatch(db, ids.guildId, {
      ...config,
      channelIds: [threadId],
      campaign: { id: campaignId, fromAtMs: NOW - 100_000, toAtMs: NOW },
    }, NOW);
    const deferredUntil = NOW + 86_400_000;
    db.prepare("UPDATE jobs SET run_after_ms=? WHERE type='review_episode'").run(deferredUntil);
    db.prepare('UPDATE channels SET name=?,updated_at_ms=? WHERE id=?')
      .run('mneme-project-history', NOW + 1, parentId);

    expect(wakeHistoricalCampaignReviews(db, campaignId, NOW + 2)).toBe(0);
    expect(db.prepare("SELECT run_after_ms FROM jobs WHERE type='review_episode'").get())
      .toEqual({ run_after_ms: deferredUntil });

    const continued = processHistoricalBatch(db, ids.guildId, {
      ...config,
      maxPendingReviews: 1,
      channelIds: [threadId],
      campaign: { id: campaignId, fromAtMs: NOW - 100_000, toAtMs: NOW },
    }, NOW + 3);
    expect(continued).toMatchObject({ moreWork: false, throttled: false });
    expect(db.prepare('SELECT status FROM episodes WHERE historical_campaign_id=?')
      .get(campaignId)).toEqual({ status: 'skipped' });
    expect(db.prepare('SELECT status FROM historical_memory_campaigns WHERE id=?')
      .get(campaignId)).toEqual({ status: 'completed' });
  });
  it('groups backfilled human messages, persists a cursor, and queues low-priority reviews', () => {
    message('100000000000001001', NOW - 10_000, 'We decided to use passkeys.');
    message('100000000000001002', NOW - 5_000, 'I will document the rollout risk.');

    const result = processHistoricalBatch(db, ids.guildId, config, NOW);
    expect(result).toMatchObject({ channelId: ids.channelId, messagesScanned: 2, episodesCreated: 1, throttled: false });
    const episode = db.prepare('SELECT origin,status,human_message_count FROM episodes').get() as Record<string, unknown>;
    expect(episode).toMatchObject({ origin: 'historical', status: 'queued', human_message_count: 2 });
    const job = db.prepare("SELECT type,priority FROM jobs WHERE type='review_episode'").get() as Record<string, unknown>;
    expect(job).toMatchObject({ type: 'review_episode', priority: 200 });
    const cursor = db.prepare('SELECT messages_scanned,episodes_created FROM historical_episode_cursors WHERE channel_id=?')
      .get(ids.channelId) as Record<string, unknown>;
    expect(cursor).toMatchObject({ messages_scanned: 2, episodes_created: 1 });
  });

  it('does not create cursors or episodes for restricted channels', () => {
    db.prepare("UPDATE channels SET visibility_class='restricted' WHERE id=?").run(ids.channelId);
    message('100000000000001003', NOW - 1_000, 'We decided something restricted.');
    const result = processHistoricalBatch(db, ids.guildId, config, NOW);
    expect(result.moreWork).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM episodes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM historical_episode_cursors').get()).toEqual({ n: 0 });
  });

  it('never creates ordinary or campaign episodes for a child thread below a Mneme test parent', () => {
    const parentId = '100000000000001100';
    const threadId = '100000000000001101';
    seedChannel(parentId, { name: 'mneme-history-tests' });
    seedChannel(threadId, { name: 'release-planning', parentId, isThread: true });
    db.prepare(`INSERT INTO sync_cursors
      (channel_id,state,history_complete,updated_at_ms) VALUES (?,'live',1,?)`).run(threadId, NOW);
    message('100000000000001102', NOW - 1_000, 'We decided on the test-only plan.', threadId);

    const ordinary = processHistoricalBatch(db, ids.guildId, {
      ...config,
      channelIds: [threadId],
    }, NOW);
    expect(ordinary.moreWork).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM historical_episode_cursors
      WHERE channel_id=?`).get(threadId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE conversation_channel_id=?')
      .get(threadId)).toEqual({ n: 0 });

    const campaignId = 'test-parent-campaign';
    ensureHistoricalCampaign(db, {
      id: campaignId,
      guildId: ids.guildId,
      direction: 'newest_first',
      fromAtMs: NOW - 100_000,
      toAtMs: NOW,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      thinkingLevel: 'medium',
      channelIds: [threadId],
      dailyBudgetUsd: 1,
      totalBudgetUsd: 2,
    }, NOW);
    const campaign = processHistoricalBatch(db, ids.guildId, {
      ...config,
      channelIds: [threadId],
      campaign: { id: campaignId, fromAtMs: NOW - 100_000, toAtMs: NOW },
    }, NOW);
    expect(campaign.moreWork).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM historical_campaign_cursors
      WHERE campaign_id=?`).get(campaignId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE historical_campaign_id=?')
      .get(campaignId)).toEqual({ n: 0 });
  });

  it('does not resume an existing historical cursor after its parent is renamed as a test surface', () => {
    const parentId = '100000000000001110';
    const threadId = '100000000000001111';
    seedChannel(parentId, { name: 'project-history' });
    seedChannel(threadId, { name: 'release-planning', parentId, isThread: true });
    db.prepare(`INSERT INTO sync_cursors
      (channel_id,state,history_complete,updated_at_ms) VALUES (?,'live',1,?)`).run(threadId, NOW);
    db.prepare(`INSERT INTO historical_episode_cursors
      (channel_id,cutoff_at_ms,state,updated_at_ms) VALUES (?,?,'pending',?)`)
      .run(threadId, NOW, NOW);
    message('100000000000001112', NOW - 1_000, 'We decided after the cursor was created.', threadId);
    db.prepare('UPDATE channels SET name=?, updated_at_ms=? WHERE id=?')
      .run('mneme-project-history', NOW + 1, parentId);

    const result = processHistoricalBatch(db, ids.guildId, {
      ...config,
      channelIds: [threadId],
    }, NOW + 1);
    expect(result.moreWork).toBe(false);
    expect(db.prepare('SELECT state FROM historical_episode_cursors WHERE channel_id=?')
      .get(threadId)).toEqual({ state: 'complete' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE conversation_channel_id=?')
      .get(threadId)).toEqual({ n: 0 });

    const campaignId = 'renamed-test-parent-campaign';
    ensureHistoricalCampaign(db, {
      id: campaignId,
      guildId: ids.guildId,
      direction: 'newest_first',
      fromAtMs: NOW - 100_000,
      toAtMs: NOW,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      thinkingLevel: 'medium',
      channelIds: [threadId],
      dailyBudgetUsd: 1,
      totalBudgetUsd: 2,
    }, NOW + 1);
    db.prepare(`INSERT INTO historical_campaign_cursors
      (campaign_id,channel_id,state,updated_at_ms) VALUES (?,?,'pending',?)`)
      .run(campaignId, threadId, NOW + 1);
    const campaign = processHistoricalBatch(db, ids.guildId, {
      ...config,
      channelIds: [threadId],
      campaign: { id: campaignId, fromAtMs: NOW - 100_000, toAtMs: NOW },
    }, NOW + 2);
    expect(campaign.moreWork).toBe(false);
    expect(db.prepare(`SELECT state FROM historical_campaign_cursors
      WHERE campaign_id=? AND channel_id=?`).get(campaignId, threadId))
      .toEqual({ state: 'complete' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE historical_campaign_id=?')
      .get(campaignId)).toEqual({ n: 0 });
  });

  it('limits cursor creation and batches to the configured channel allowlist', () => {
    message('100000000000001007', NOW - 1_000, 'We chose the general-channel plan.');
    const result = processHistoricalBatch(db, ids.guildId, {
      ...config,
      channelIds: ['999999999999999999'],
    }, NOW);
    expect(result.moreWork).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM episodes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM historical_episode_cursors').get()).toEqual({ n: 0 });
  });

  it('throttles construction while the pending historical-review ceiling is reached', () => {
    message('100000000000001004', NOW - 1_000, 'We agreed on a migration plan.');
    const first = processHistoricalBatch(db, ids.guildId, { ...config, maxPendingReviews: 1 }, NOW);
    expect(first.episodesCreated).toBe(1);
    const second = processHistoricalBatch(db, ids.guildId, { ...config, maxPendingReviews: 1 }, NOW + 1);
    expect(second).toMatchObject({ throttled: true, episodesCreated: 0, messagesScanned: 0 });
  });

  it('skips ignored commands while advancing the durable cursor', () => {
    message('100000000000001005', NOW - 2_000, '/help');
    message('100000000000001006', NOW - 1_000, '');
    const result = processHistoricalBatch(db, ids.guildId, config, NOW);
    expect(result).toMatchObject({ messagesScanned: 2, episodesCreated: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM episodes').get()).toEqual({ n: 0 });
  });

  it('runs a bounded campaign newest-first while preserving chronological episode order', () => {
    const campaignId = 'recent-six-months-test';
    const fromAtMs = NOW - 400_000;
    ensureHistoricalCampaign(db, {
      id: campaignId, guildId: ids.guildId, direction: 'newest_first', fromAtMs, toAtMs: NOW,
      provider: 'openai', model: 'gpt-5.6-luna', thinkingLevel: 'medium',
      channelIds: [ids.channelId], dailyBudgetUsd: 10, totalBudgetUsd: 2,
    }, NOW);
    message('100000000000001010', NOW - 300_000, 'We decided on the old plan.');
    message('100000000000001011', NOW - 10_000, 'We decided on the newest plan.');
    message('100000000000001012', NOW - 5_000, 'I will document that newest decision.');
    message('100000000000001013', NOW - 500_000, 'Outside the campaign window.');

    const result = processHistoricalBatch(db, ids.guildId, {
      ...config,
      maxPendingReviews: 1,
      campaign: { id: campaignId, fromAtMs, toAtMs: NOW },
    }, NOW);
    expect(result).toMatchObject({ channelId: ids.channelId, episodesCreated: 1, messagesScanned: 2 });
    const episode = db.prepare(`SELECT historical_campaign_id,started_at_ms,ended_at_ms
      FROM episodes WHERE historical_campaign_id=?`).get(campaignId) as Record<string, unknown>;
    expect(episode).toMatchObject({ historical_campaign_id: campaignId,
      started_at_ms: NOW - 10_000, ended_at_ms: NOW - 5_000 });
    const ordered = db.prepare(`SELECT em.message_id FROM episode_messages em JOIN episodes e ON e.id=em.episode_id
      WHERE e.historical_campaign_id=? ORDER BY em.ordinal`).all(campaignId) as Array<{ message_id: string }>;
    expect(ordered.map((row) => row.message_id)).toEqual(['100000000000001011', '100000000000001012']);
    const cursor = db.prepare(`SELECT upper_created_at_ms,messages_scanned FROM historical_campaign_cursors
      WHERE campaign_id=? AND channel_id=?`).get(campaignId, ids.channelId) as Record<string, unknown>;
    expect(cursor).toMatchObject({ upper_created_at_ms: NOW - 10_000, messages_scanned: 2 });
  });

  it('does not advance a paused bounded campaign', () => {
    const campaignId = 'paused-test';
    ensureHistoricalCampaign(db, {
      id: campaignId, guildId: ids.guildId, direction: 'newest_first', fromAtMs: NOW - 100_000, toAtMs: NOW,
      provider: 'openai', model: 'gpt-5.6-luna', thinkingLevel: 'medium',
      channelIds: [ids.channelId], dailyBudgetUsd: 10, totalBudgetUsd: 2,
    }, NOW);
    db.prepare("UPDATE historical_memory_campaigns SET status='paused' WHERE id=?").run(campaignId);
    message('100000000000001020', NOW - 1_000, 'We decided something while paused.');
    const result = processHistoricalBatch(db, ids.guildId, {
      ...config, campaign: { id: campaignId, fromAtMs: NOW - 100_000, toAtMs: NOW },
    }, NOW);
    expect(result).toMatchObject({ throttled: true, episodesCreated: 0, moreWork: false });
    expect(db.prepare('SELECT count(*) n FROM episodes WHERE historical_campaign_id=?').get(campaignId)).toEqual({ n: 0 });
  });
});
