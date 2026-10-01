import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import { emojiKeyOf, normalizeMessage } from '../../src/platform/discord/normalize.js';
import { ingestMessageCreate, ingestReactionAdd, ingestReactionRemove, ingestReactionRemoveAll } from '../../src/ingestion/ingest.js';
import { upsertGuildMember, upsertUser } from '../../src/db/repositories/users.js';
import { NOW, opts, rawMessage } from '../helpers/messages.js';

const EMOJI_UNICODE = { id: null, name: '👍' };
const EMOJI_CUSTOM = { id: '600000000000000001', name: 'gold' };

/** The neutral reaction fields the Discord adapter derives from a raw emoji. */
function keyed(emoji: { id: string | null; name: string | null }): { emojiKey: string; emojiName: string | null } {
  return { emojiKey: emojiKeyOf(emoji) ?? '', emojiName: emoji.name };
}

function liveCount(db: DatabaseSync, messageId: string, emojiKey: string): number {
  const row = db
    .prepare('SELECT count, source FROM reaction_counts WHERE message_id = ? AND emoji_key = ?')
    .get(messageId, emojiKey) as { count: number; source: string } | undefined;
  return row ? row.count : 0;
}

function userReacted(db: DatabaseSync, messageId: string, userId: string, emojiKey: string): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji_key = ?',
      )
      .get(messageId, userId, emojiKey) !== undefined
  );
}

describe('live reactions', () => {
  let env: TestDb;
  let db: DatabaseSync;
  beforeEach(() => {
    env = createTestDb();
    db = env.db;
    seedIdentity(db);
  });

  it('stores per-user rows and a recomputed live aggregate', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());

    const u1 = '400000000000000001';
    const u2 = '400000000000000002';
    ingestReactionAdd(db, { messageId: m.id, userId: u1, ...keyed(EMOJI_UNICODE) }, opts());
    ingestReactionAdd(db, { messageId: m.id, userId: u2, ...keyed(EMOJI_UNICODE) }, opts());

    expect(userReacted(db, m.id, u1, '👍')).toBe(true);
    expect(userReacted(db, m.id, u2, '👍')).toBe(true);
    expect(liveCount(db, m.id, '👍')).toBe(2);
  });

  it('is idempotent across duplicate add events', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    const u = '400000000000000001';

    const first = ingestReactionAdd(db, { messageId: m.id, userId: u, ...keyed(EMOJI_UNICODE) }, opts());
    const second = ingestReactionAdd(db, { messageId: m.id, userId: u, ...keyed(EMOJI_UNICODE) }, opts());
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false); // duplicate add is a no-op
    expect(liveCount(db, m.id, '👍')).toBe(1);
  });

  it('handles out-of-order add/remove and clamps the aggregate at zero', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    const u = '400000000000000001';

    // Remove before any add: idempotent no-op, no negative count.
    const early = ingestReactionRemove(db, { messageId: m.id, userId: u, ...keyed(EMOJI_UNICODE) }, opts());
    expect(early.changed).toBe(false);
    expect(liveCount(db, m.id, '👍')).toBe(0);

    ingestReactionAdd(db, { messageId: m.id, userId: u, ...keyed(EMOJI_UNICODE) }, opts());
    ingestReactionRemove(db, { messageId: m.id, userId: u, ...keyed(EMOJI_UNICODE) }, opts());
    expect(liveCount(db, m.id, '👍')).toBe(0); // clamped, not negative

    // Re-adding after removal works (reversal).
    ingestReactionAdd(db, { messageId: m.id, userId: u, ...keyed(EMOJI_UNICODE) }, opts());
    expect(liveCount(db, m.id, '👍')).toBe(1);
  });

  it('keeps independent emoji aggregates separate (custom vs unicode)', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    const u = '400000000000000001';

    ingestReactionAdd(db, { messageId: m.id, userId: u, ...keyed(EMOJI_UNICODE) }, opts());
    ingestReactionAdd(db, { messageId: m.id, userId: u, ...keyed(EMOJI_CUSTOM) }, opts());
    expect(liveCount(db, m.id, '👍')).toBe(1);
    expect(liveCount(db, m.id, 'gold:600000000000000001')).toBe(1);
  });

  it('remove-all clears every per-user row and every aggregate (both sources)', () => {
    const m = normalizeMessage(
      rawMessage({ reactions: [{ count: 3, me: false, emoji: EMOJI_UNICODE }] }),
    );
    ingestMessageCreate(db, m, opts()); // backfill: 👍 = 3
    expect(liveCount(db, m.id, '👍')).toBe(3);

    ingestReactionAdd(db, { messageId: m.id, userId: '400000000000000001', ...keyed(EMOJI_CUSTOM) }, opts());
    expect(liveCount(db, m.id, 'gold:600000000000000001')).toBe(1);

    const res = ingestReactionRemoveAll(db, m.id, opts());
    expect(res.removedReactions).toBe(1); // one live per-user row removed
    expect(liveCount(db, m.id, '👍')).toBe(0); // backfill aggregate cleared too
    expect(liveCount(db, m.id, 'gold:600000000000000001')).toBe(0);
  });

  it('applies live transitions on top of a REST baseline', () => {
    const m = normalizeMessage(rawMessage({ reactions: [{ count: 5, me: false, emoji: EMOJI_UNICODE }] }));
    ingestMessageCreate(db, m, opts());
    const user = '400000000000000008';
    ingestReactionAdd(db, { messageId: m.id, userId: user, ...keyed(EMOJI_UNICODE) }, opts({ now: NOW + 1 }));
    expect(liveCount(db, m.id, '👍')).toBe(6);
    ingestReactionAdd(db, { messageId: m.id, userId: user, ...keyed(EMOJI_UNICODE) }, opts({ now: NOW + 2 }));
    expect(liveCount(db, m.id, '👍')).toBe(6);
    ingestReactionRemove(db, { messageId: m.id, userId: user, ...keyed(EMOJI_UNICODE) }, opts({ now: NOW + 3 }));
    expect(liveCount(db, m.id, '👍')).toBe(5);
  });

  it('drops an event whose emoji cannot be keyed', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    const res = ingestReactionAdd(
      db,
      { messageId: m.id, userId: '400000000000000001', ...keyed({ id: null, name: null }) },
      opts(),
    );
    expect(res.dropped).toBe(true);
    expect(res.changed).toBe(false);
  });

  it('ensures the reacting user exists (FK) even without identity', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    const u = '400000000000000009';
    ingestReactionAdd(db, { messageId: m.id, userId: u, ...keyed(EMOJI_UNICODE) }, opts());
    expect(
      (db.prepare('SELECT 1 FROM users WHERE id = ?').get(u) as { 1?: number } | undefined) !==
        undefined,
    ).toBe(true);
    expect(
      (db
        .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .get(opts().guildId, u) as { 1?: number } | undefined) !== undefined,
    ).toBe(true);
  });

  it.each([
    ['add', (messageId: string, userId: string) => ingestReactionAdd(
      db, { messageId, userId, ...keyed(EMOJI_UNICODE) }, opts({ now: NOW + 10 }),
    )],
    ['remove', (messageId: string, userId: string) => ingestReactionRemove(
      db, { messageId, userId, ...keyed(EMOJI_UNICODE) }, opts({ now: NOW + 10 }),
    )],
  ])('preserves a known bot identity and membership on reaction %s', (_event, react) => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    const botId = '400000000000000010';
    upsertUser(db, {
      id: botId,
      username: 'known-bot',
      globalName: 'Known Bot',
      isBot: true,
      firstSeenAtMs: NOW - 10,
      lastSeenAtMs: NOW,
      rawJson: null,
    });
    upsertGuildMember(db, {
      guildId: opts().guildId,
      userId: botId,
      displayName: 'Bot Display',
      roleIdsJson: '["bot-role"]',
      updatedAtMs: NOW,
    });

    react(m.id, botId);

    expect(db.prepare('SELECT username, global_name, is_bot, last_seen_at_ms FROM users WHERE id = ?')
      .get(botId)).toEqual({
      username: 'known-bot', global_name: 'Known Bot', is_bot: 1, last_seen_at_ms: NOW + 10,
    });
    expect(db.prepare('SELECT display_name, role_ids_json, updated_at_ms FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(opts().guildId, botId)).toEqual({
      display_name: 'Bot Display', role_ids_json: '["bot-role"]', updated_at_ms: NOW,
    });
  });

  it('creates a stable placeholder for an unknown reacting user', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    const userId = '400000000000000011';

    ingestReactionAdd(db, { messageId: m.id, userId, ...keyed(EMOJI_UNICODE) }, opts({ now: NOW + 10 }));
    ingestReactionRemove(db, { messageId: m.id, userId, ...keyed(EMOJI_UNICODE) }, opts({ now: NOW + 5 }));

    expect(db.prepare('SELECT username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms FROM users WHERE id = ?')
      .get(userId)).toEqual({
      username: null, global_name: null, is_bot: 0, first_seen_at_ms: NOW + 10, last_seen_at_ms: NOW + 10,
    });
  });
});
