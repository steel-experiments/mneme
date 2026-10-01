import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { getOpenEpisode, getEpisode, listEpisodeMessages } from '../../src/episodes/repository.js';
import type { NormalizedMessage } from '../../src/discord/normalize.js';
import {
  ingestEpisodeActivity,
  closeEpisodeAndQueueReview,
  hardCloseTrigger,
  quietTimeoutClose,
  closeEpisodeRunAfterMs,
  closeEpisodeJobKey,
  reviewEpisodeJobKey,
  DEFAULT_EPISODE_TIMING,
  type EpisodeBuilderConfig,
  type EpisodeTimingConfig,
} from '../../src/episodes/builder.js';
import { createCloseEpisodeHandler } from '../../src/jobs/handlers/close-episode.js';
import { JobWorker } from '../../src/jobs/worker.js';

/**
 * Deterministic episode closure (Sections 11.3, 11.5).
 *
 * Acceptance: fake-clock and boundary tests close exactly once at each threshold
 * (quiet, message cap, duration cap) and preserve the final episode message set.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded
const HUMAN = '100000000000000003';
const MNEME = '100000000000000010';
const T0 = 1_700_000_001_000;

const config: EpisodeBuilderConfig = { mnemeId: MNEME };
const SECOND = 1000;
const MINUTE = 60_000;

function nm(id: string, content: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id,
    channelId: CHANNEL,
    guildId: GUILD,
    author: { id: HUMAN, username: 'alice', globalName: 'Alice', isBot: false },
    content,
    createdAtMs: T0,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentions: [],
    embeds: [],
    components: [],
    poll: null,
    attachments: [],
    reactionCounts: [],
    raw: null,
    ...over,
  };
}

function persist(db: DatabaseSync, msg: NormalizedMessage): void {
  upsertMessageCreate(db, {
    id: msg.id,
    guildId: msg.guildId ?? GUILD,
    channelId: msg.channelId,
    authorId: msg.author.id,
    authorDisplayName: msg.author.globalName ?? msg.author.username ?? 'user',
    content: msg.content,
    createdAtMs: msg.createdAtMs,
    editedAtMs: msg.editedAtMs,
    replyToMessageId: msg.replyToMessageId,
    messageType: msg.messageType,
    flags: msg.flags,
    pinned: msg.pinned,
    mentionEveryone: msg.mentionEveryone,
    mentionsJson: JSON.stringify(msg.mentions),
    embedsJson: JSON.stringify(msg.embeds),
    componentsJson: JSON.stringify(msg.components),
    pollJson: msg.poll == null ? null : JSON.stringify(msg.poll),
    rawJson: null,
    ingestedAtMs: msg.createdAtMs,
    updatedAtMs: msg.createdAtMs,
  });
}

/** Open an episode with one human message at `now`, returning the episode id. */
function openAt(db: DatabaseSync, now: number, timing?: EpisodeTimingConfig): string {
  const msg = nm('open-seed', 'We decided to adopt Postgres.');
  msg.createdAtMs = now;
  persist(db, msg);
  const res = ingestEpisodeActivity(msg, config, { db, guildId: GUILD, now, timing });
  expect(res.episodeId).not.toBeNull();
  return res.episodeId!;
}

function extendAt(db: DatabaseSync, id: string, now: number, timing?: EpisodeTimingConfig): void {
  const msg = nm(id, `message ${id}`);
  msg.createdAtMs = now;
  persist(db, msg);
  ingestEpisodeActivity(msg, config, { db, guildId: GUILD, now, timing });
}

function activeJob(
  db: DatabaseSync,
  type: string,
  uniqueKey: string,
): { run_after_ms: number; status: string } | undefined {
  return db
    .prepare('SELECT run_after_ms, status FROM jobs WHERE type = ? AND unique_key = ? ORDER BY created_at_ms DESC LIMIT 1')
    .get(type, uniqueKey) as { run_after_ms: number; status: string } | undefined;
}

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

describe('pure close-trigger evaluation', () => {
  const timing: EpisodeTimingConfig = { quietSeconds: 90, maxMessages: 40, maxMinutes: 10 };
  const episode = {
    id: 'e1', started_at_ms: T0, last_activity_at_ms: T0, total_message_count: 5, status: 'open',
  } as never; // only the fields the pure functions read matter

  it('hardCloseTrigger fires on the message cap first, then duration', () => {
    expect(hardCloseTrigger({ ...episode, total_message_count: 40 } as never, timing, T0)).toEqual({ close: true, trigger: 'message_cap' });
    expect(hardCloseTrigger({ ...episode, total_message_count: 5 } as never, timing, T0 + 10 * MINUTE)).toEqual({ close: true, trigger: 'duration_cap' });
    expect(hardCloseTrigger({ ...episode, total_message_count: 5 } as never, timing, T0 + 9 * MINUTE)).toEqual({ close: false });
  });

  it('quietTimeoutClose closes at the threshold and reschedules below it', () => {
    expect(quietTimeoutClose({ ...episode, last_activity_at_ms: T0 } as never, timing, T0 + 90 * SECOND)).toEqual({ close: true, trigger: 'quiet' });
    const below = quietTimeoutClose({ ...episode, last_activity_at_ms: T0 } as never, timing, T0 + 89 * SECOND);
    expect(below.close).toBe(false);
    expect(below.rescheduleAt).toBe(T0 + 90 * SECOND);
  });

  it('closeEpisodeRunAfterMs is last_activity plus the quiet window', () => {
    expect(closeEpisodeRunAfterMs({ ...episode, last_activity_at_ms: T0 + 5 } as never, timing)).toBe(T0 + 5 + 90 * SECOND);
  });
});

describe('quiet-timeout close job', () => {
  it('schedules a close job when an episode opens, then closes at exactly the quiet threshold', async () => {
    const episodeId = openAt(db, T0);
    const job = activeJob(db, 'close_episode', closeEpisodeJobKey(episodeId));
    expect(job).toBeDefined();
    expect(job!.run_after_ms).toBe(T0 + DEFAULT_EPISODE_TIMING.quietSeconds * SECOND);

    const handler = createCloseEpisodeHandler({ db, now: () => T0 + 89 * SECOND });

    // One second before the threshold: rescheduled, not closed.
    const early = await handler.runClose(episodeId);
    expect(early.closed).toBe(false);
    expect(early.rescheduled).toBe(true);
    expect(getEpisode(db, episodeId)!.status).toBe('open');

    // At exactly the threshold: closed and review queued.
    const onTime = createCloseEpisodeHandler({ db, now: () => T0 + 90 * SECOND });
    const res = await onTime.runClose(episodeId);
    expect(res.closed).toBe(true);
    expect(res.trigger).toBe('quiet');
    expect(getEpisode(db, episodeId)!.status).toBe('queued');
    expect(getEpisode(db, episodeId)!.ended_at_ms).toBe(T0 + 90 * SECOND);
    expect(getOpenEpisode(db, CHANNEL)).toBeUndefined();
    expect(activeJob(db, 'review_episode', reviewEpisodeJobKey(episodeId))).toBeDefined();
  });

  it('reschedules when activity pushed last_activity past the job fire time', async () => {
    const episodeId = openAt(db, T0); // close scheduled for T0+90
    extendAt(db, 'mid', T0 + 50 * SECOND); // last_activity → T0+50

    const handler = createCloseEpisodeHandler({ db, now: () => T0 + 90 * SECOND });
    const early = await handler.runClose(episodeId);
    expect(early.closed).toBe(false); // 90-50 = 40s idle, under threshold
    expect(early.rescheduled).toBe(true);
    expect(getEpisode(db, episodeId)!.status).toBe('open');

    const later = createCloseEpisodeHandler({ db, now: () => T0 + 140 * SECOND });
    const res = await later.runClose(episodeId);
    expect(res.closed).toBe(true); // 140-50 = 90s, meets threshold
  });

  it('defers the running close job when it fires before the new quiet deadline', async () => {
    const timing: EpisodeTimingConfig = { quietSeconds: 90, maxMessages: 40, maxMinutes: 10 };
    const episodeId = openAt(db, T0, timing);
    extendAt(db, 'worker-mid', T0 + 50 * SECOND, timing);
    const key = closeEpisodeJobKey(episodeId);
    db.prepare("UPDATE jobs SET run_after_ms=? WHERE type='close_episode' AND unique_key=?")
      .run(T0 + 90 * SECOND, key);

    let now = T0 + 90 * SECOND;
    const worker = new JobWorker({ db, owner: 'test', leaseMs: 60_000,
      pollIntervalMs: 1, shutdownTimeoutMs: 100, clock: () => now });
    worker.register('close_episode', 1, createCloseEpisodeHandler({ db, timing, now: () => now }));
    await worker.runOnce();

    expect(getEpisode(db, episodeId)?.status).toBe('open');
    expect(activeJob(db, 'close_episode', key)).toEqual({
      status: 'queued', run_after_ms: T0 + 140 * SECOND,
    });
    now = T0 + 140 * SECOND;
    await worker.runOnce();
    expect(getEpisode(db, episodeId)?.status).toBe('queued');
  });

  it('is a no-op when the episode was already closed by another trigger', async () => {
    const episodeId = openAt(db, T0);
    closeEpisodeAndQueueReview(db, CHANNEL, T0 + 10); // closed by admin/archive
    expect(getEpisode(db, episodeId)!.status).toBe('queued');

    const handler = createCloseEpisodeHandler({ db, now: () => T0 + 90 * SECOND });
    const res = await handler.runClose(episodeId);
    expect(res.closed).toBe(false);
    expect(res.rescheduled).toBe(false);
    // Still exactly one review job.
    const reviews = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'review_episode' AND unique_key = ?").get(reviewEpisodeJobKey(episodeId)) as { n: number };
    expect(reviews.n).toBe(1);
  });
});

describe('hard-close triggers at extend time', () => {
  it('closes on the message cap and preserves the final message set', () => {
    const timing: EpisodeTimingConfig = { quietSeconds: 90, maxMessages: 2, maxMinutes: 10 };
    const e1 = openAt(db, T0, timing); // total=1
    expect(getEpisode(db, e1)!.status).toBe('open');
    extendAt(db, 'second', T0 + SECOND, timing); // total=2 → cap closes
    expect(getEpisode(db, e1)!.status).toBe('queued');
    expect(getEpisode(db, e1)!.ended_at_ms).toBe(T0 + SECOND);
    expect(getOpenEpisode(db, CHANNEL)).toBeUndefined();

    // The closed episode's message set is intact, in order.
    const msgs = listEpisodeMessages(db, e1);
    expect(msgs.map((m) => m.message_id)).toEqual(['open-seed', 'second']);
    expect(msgs.map((m) => m.ordinal)).toEqual([1, 2]);
    // Review queued exactly once for the closed episode.
    expect(activeJob(db, 'review_episode', reviewEpisodeJobKey(e1))).toBeDefined();

    // A later message opens a fresh episode.
    extendAt(db, 'third', T0 + 2 * SECOND, timing);
    const reopened = getOpenEpisode(db, CHANNEL);
    expect(reopened).toBeDefined();
    expect(reopened!.id).not.toBe(e1);
  });

  it('closes on the duration cap at the boundary and not before', () => {
    const timing: EpisodeTimingConfig = { quietSeconds: 90, maxMessages: 40, maxMinutes: 1 }; // 60s
    const e1 = openAt(db, T0, timing);
    extendAt(db, 'm59', T0 + 59 * SECOND, timing); // 59s < 60s → still open
    expect(getEpisode(db, e1)!.status).toBe('open');
    extendAt(db, 'm60', T0 + 60 * SECOND, timing); // 60s ≥ 60s → duration close
    expect(getEpisode(db, e1)!.status).toBe('queued');
    expect(getEpisode(db, e1)!.ended_at_ms).toBe(T0 + 60 * SECOND);
  });
});

describe('force-close (thread archival / admin flush)', () => {
  it('closes an open episode and queues review; a second call is a no-op', () => {
    const episodeId = openAt(db, T0);
    const first = closeEpisodeAndQueueReview(db, CHANNEL, T0 + 5 * SECOND);
    expect(first.closed).toBe(true);
    expect(first.episodeId).toBe(episodeId);
    expect(getEpisode(db, episodeId)!.status).toBe('queued');

    const second = closeEpisodeAndQueueReview(db, CHANNEL, T0 + 6 * SECOND);
    expect(second.closed).toBe(false); // idempotent
    // Still one review job.
    const reviews = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'review_episode' AND unique_key = ?").get(reviewEpisodeJobKey(episodeId)) as { n: number };
    expect(reviews.n).toBe(1);
  });
});
