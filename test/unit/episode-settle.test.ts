import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  evaluateSettle,
  lastHumanMessageAtMs,
  DEFAULT_SETTLE_CONFIG,
} from '../../src/episodes/settle.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { upsertUser } from '../../src/db/repositories/users.js';

/**
 * Conversation settle gate (Section 11.8).
 *
 * Episode closure is a review boundary, not proof that a discussion ended. The
 * gate decides when a closed episode is quiet enough to review and whether
 * proactive speech may target it.
 */

const NOW = 1_700_000_001_000;
const MINUTE = 60_000;
const CONFIG = DEFAULT_SETTLE_CONFIG; // 600s settle, 60-minute hold bound

describe('evaluateSettle — Section 11.8', () => {
  it('proceeds when the conversation has been quiet for the settle window', () => {
    const out = evaluateSettle({
      lastHumanAtMs: NOW - 11 * MINUTE,
      episodeClosedAtMs: NOW - 10 * MINUTE,
      now: NOW,
      config: CONFIG,
    });
    expect(out).toMatchObject({ proceed: true, settled: true, forced: false });
    expect(out.idleMs).toBe(11 * MINUTE);
  });

  it('holds a review while the conversation is still in progress', () => {
    const out = evaluateSettle({
      lastHumanAtMs: NOW - 2 * MINUTE,
      episodeClosedAtMs: NOW - 90_000,
      now: NOW,
      config: CONFIG,
    });
    expect(out).toMatchObject({ proceed: false, settled: false, forced: false });
    expect(out.retryAtMs).toBe(NOW - 2 * MINUTE + 600_000);
  });

  it('reproduces the incident: a 90-second quiet close is not a settled conversation', () => {
    // The production shape this gate exists for: the episode closed 90 seconds
    // after the last message and the card posted 33 seconds later, before the
    // people in the channel had finished answering each other.
    const lastHumanAtMs = NOW;
    const closedAtMs = lastHumanAtMs + 90_000;
    const routedAtMs = closedAtMs + 33_000;
    const out = evaluateSettle({
      lastHumanAtMs,
      episodeClosedAtMs: closedAtMs,
      now: routedAtMs,
      config: CONFIG,
    });
    expect(out.settled).toBe(false);
    expect(out.proceed).toBe(false);
  });

  it('releases a held review at the hold bound without calling it settled', () => {
    const out = evaluateSettle({
      lastHumanAtMs: NOW - MINUTE,
      episodeClosedAtMs: NOW - 61 * MINUTE,
      now: NOW,
      config: CONFIG,
    });
    // Memory extraction proceeds; `settled` stays false so speech is suppressed.
    expect(out).toMatchObject({ proceed: true, settled: false, forced: true });
  });

  it('treats a channel with no human message as settled', () => {
    const out = evaluateSettle({
      lastHumanAtMs: null,
      episodeClosedAtMs: NOW - MINUTE,
      now: NOW,
      config: CONFIG,
    });
    expect(out).toMatchObject({ proceed: true, settled: true, forced: false, idleMs: null });
  });

  it('bounds a future-dated message by the same hold bound', () => {
    const live = evaluateSettle({
      lastHumanAtMs: NOW + 86_400_000,
      episodeClosedAtMs: NOW - MINUTE,
      now: NOW,
      config: CONFIG,
    });
    expect(live.proceed).toBe(false);
    const bounded = evaluateSettle({
      lastHumanAtMs: NOW + 86_400_000,
      episodeClosedAtMs: NOW - 61 * MINUTE,
      now: NOW,
      config: CONFIG,
    });
    expect(bounded).toMatchObject({ proceed: true, settled: false, forced: true });
  });
});

describe('lastHumanMessageAtMs — Section 11.8', () => {
  const GUILD = '100000000000000001';
  const CHANNEL = '100000000000000002';
  const ALICE = '100000000000000003';
  const BOT = '100000000000000004';
  const CASS = '999000000000000001';
  let env: TestDb;

  function insert(id: string, author: string, createdAtMs: number, content = 'hello'): void {
    upsertMessageCreate(env.db, {
      id, guildId: GUILD, channelId: CHANNEL, authorId: author, authorDisplayName: author,
      content, createdAtMs, editedAtMs: null, replyToMessageId: null, messageType: 0, flags: 0,
      pinned: false, mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]',
      componentsJson: '[]', pollJson: null, rawJson: null,
      ingestedAtMs: createdAtMs, updatedAtMs: createdAtMs,
    });
  }

  function seedAuthor(id: string, isBot: boolean): void {
    upsertUser(env.db, {
      id, username: id, globalName: null, isBot, rawJson: null,
      firstSeenAtMs: NOW, lastSeenAtMs: NOW,
    });
  }

  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    seedAuthor(ALICE, false);
    seedAuthor(BOT, true);
    seedAuthor(CASS, true);
  });
  afterEach(() => env.cleanup());

  it('ignores Mneme, other bots, deleted, and empty messages', () => {
    insert('m-human', ALICE, NOW - 10 * MINUTE);
    insert('m-bot', BOT, NOW - 2 * MINUTE);
    insert('m-cass', CASS, NOW - MINUTE);
    insert('m-empty', ALICE, NOW - 30_000, '   ');
    insert('m-deleted', ALICE, NOW - 20_000);
    env.db.prepare('UPDATE messages SET deleted_at_ms=? WHERE id=?').run(NOW, 'm-deleted');

    expect(lastHumanMessageAtMs(env.db, CHANNEL, CASS)).toBe(NOW - 10 * MINUTE);
  });

  it('returns null when the channel holds no meaningful human message', () => {
    insert('m-cass', CASS, NOW - MINUTE);
    expect(lastHumanMessageAtMs(env.db, CHANNEL, CASS)).toBeNull();
  });
});
