import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  closeEpisode,
  conversationKey,
  extendEpisode,
  getEpisode,
  getOpenEpisode,
  listEpisodeMessages,
  markError,
  markReviewed,
  markReviewing,
  markSkipped,
  openEpisode,
} from '../../src/episodes/repository.js';

const NOW = 1_700_000_001_000;
const OTHER_CHANNEL = '999000000000000099';
let env: TestDb;

function seedChannel(id: string): void {
  env.db
    .prepare(
      `INSERT INTO channels (id, workspace_id, parent_id, type, name, topic, position, is_thread,
         is_archived, is_locked, ingest_enabled, visibility_class, allow_interventions,
         permission_fingerprint, last_message_id, discovered_at_ms, updated_at_ms, deleted_at_ms,
         raw_json)
       VALUES (?, '100000000000000001', NULL, 0, ?, NULL, NULL, 0, 0, 0, 1, 'restricted', 0, NULL,
         NULL, ?, ?, NULL, NULL)`,
    )
    .run(id, id, NOW, NOW);
}

function insertMessage(id: string, channel: string, now: number): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: '100000000000000001',
    channelId: channel,
    authorId: '100000000000000003',
    authorDisplayName: 'Alice',
    content: 'msg ' + id,
    createdAtMs: now,
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
    ingestedAtMs: now,
    updatedAtMs: now,
  });
}

describe('episode repository', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    seedChannel(OTHER_CHANNEL);
  });

  it('opens one episode per conversation and dedupes a second open', () => {
    const key = conversationKey('100000000000000002');
    const first = openEpisode(env.db, {
      guildId: '100000000000000001',
      conversationChannelId: key,
      now: NOW,
    });
    expect(first.created).toBe(true);
    expect(first.episode.status).toBe('open');

    const second = openEpisode(env.db, {
      guildId: '100000000000000001',
      conversationChannelId: key,
      now: NOW + 1000,
    });
    expect(second.created).toBe(false);
    expect(second.episode.id).toBe(first.episode.id);
    expect(getOpenEpisode(env.db, key)?.id).toBe(first.episode.id);

    // A different conversation gets its own episode.
    const other = openEpisode(env.db, {
      guildId: '100000000000000001',
      conversationChannelId: OTHER_CHANNEL,
      now: NOW,
    });
    expect(other.created).toBe(true);
    expect(other.episode.id).not.toBe(first.episode.id);
  });

  it('extends with stable ordinals and counts humans separately', () => {
    insertMessage('m1', '100000000000000002', NOW);
    insertMessage('m2', '100000000000000002', NOW + 1);
    insertMessage('m3', '100000000000000002', NOW + 2);

    const { episode } = openEpisode(env.db, {
      guildId: '100000000000000001',
      conversationChannelId: '100000000000000002',
      now: NOW,
    });

    expect(extendEpisode(env.db, episode.id, 'm1', true, NOW).ordinal).toBe(1);
    expect(extendEpisode(env.db, episode.id, 'm2', false, NOW + 1).ordinal).toBe(2);
    expect(extendEpisode(env.db, episode.id, 'm3', true, NOW + 2).ordinal).toBe(3);

    // Re-extending the same message is a no-op (counts/activity unchanged).
    const again = extendEpisode(env.db, episode.id, 'm1', true, NOW + 999);
    expect(again.extended).toBe(false);
    expect(again.ordinal).toBeUndefined();

    const refreshed = getEpisode(env.db, episode.id);
    expect(refreshed?.total_message_count).toBe(3);
    expect(refreshed?.human_message_count).toBe(2);
    expect(refreshed?.last_activity_at_ms).toBe(NOW + 2);

    // Ordering preserved.
    expect(listEpisodeMessages(env.db, episode.id).map((m) => m.message_id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('closes the open episode → queued, then allows a fresh episode to open', () => {
    const key = '100000000000000002';
    const { episode } = openEpisode(env.db, {
      guildId: '100000000000000001',
      conversationChannelId: key,
      now: NOW,
    });

    const closedId = closeEpisode(env.db, key, NOW + 5000);
    expect(closedId).toBe(episode.id);
    expect(getEpisode(env.db, episode.id)?.status).toBe('queued');
    expect(getEpisode(env.db, episode.id)?.ended_at_ms).toBe(NOW + 5000);

    // No open episode after close.
    expect(getOpenEpisode(env.db, key)).toBeUndefined();

    // A new message opens a fresh episode for the same conversation.
    const next = openEpisode(env.db, {
      guildId: '100000000000000001',
      conversationChannelId: key,
      now: NOW + 10_000,
    });
    expect(next.created).toBe(true);
    expect(next.episode.id).not.toBe(episode.id);
  });

  it('transitions queued → reviewing → reviewed and records the outcome', () => {
    const key = '100000000000000002';
    const { episode } = openEpisode(env.db, {
      guildId: '100000000000000001',
      conversationChannelId: key,
      now: NOW,
    });
    closeEpisode(env.db, key, NOW + 1000);

    // reviewing can only start from queued.
    expect(markReviewing(env.db, episode.id, NOW + 2000)).toBe(true);
    expect(getEpisode(env.db, episode.id)?.status).toBe('reviewing');
    // second reviewing from a non-queued state is a no-op.
    expect(markReviewing(env.db, episode.id, NOW + 2001)).toBe(false);

    expect(
      markReviewed(
        env.db,
        episode.id,
        { summary: 'decided to ship the trial', consequential: true, interventionScore: 0.8 },
        NOW + 3000,
      ),
    ).toBe(true);
    const reviewed = getEpisode(env.db, episode.id);
    expect(reviewed?.status).toBe('reviewed');
    expect(reviewed?.summary).toBe('decided to ship the trial');
    expect(reviewed?.consequential).toBe(1);
    expect(reviewed?.intervention_score).toBeCloseTo(0.8);
    expect(reviewed?.reviewed_at_ms).toBe(NOW + 3000);
  });

  it('skips and errors from the allowed source states', () => {
    const key = '100000000000000002';
    const { episode } = openEpisode(env.db, {
      guildId: '100000000000000001',
      conversationChannelId: key,
      now: NOW,
    });

    // skip from open (queued-family) is NOT allowed; close to queued first.
    expect(markSkipped(env.db, episode.id, NOW)).toBe(false);
    closeEpisode(env.db, key, NOW + 1);
    expect(markSkipped(env.db, episode.id, NOW + 2)).toBe(true);
    expect(getEpisode(env.db, episode.id)?.status).toBe('skipped');

    // error only from reviewing.
    const { episode: e2 } = openEpisode(env.db, {
      guildId: '100000000000000001',
      conversationChannelId: OTHER_CHANNEL,
      now: NOW,
    });
    expect(markError(env.db, e2.id, NOW + 3)).toBe(false);
    closeEpisode(env.db, OTHER_CHANNEL, NOW + 4);
    markReviewing(env.db, e2.id, NOW + 5);
    expect(markError(env.db, e2.id, NOW + 6)).toBe(true);
    expect(getEpisode(env.db, e2.id)?.status).toBe('error');
  });
});
