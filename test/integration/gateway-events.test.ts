import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { GUILD, CHANNEL, AUTHOR, NOW, opts, ftsMatches } from '../helpers/messages.js';
import { type IngestOptions } from '../../src/ingestion/ingest.js';
import { handleGatewayEvent, channelInputFromRaw, GATEWAY_EVENT_TYPES, type GatewayEventType } from '../../src/platform/discord/gateway-events.js';
import {
  registerIngestionHandlers,
  rawMessageFromJs,
  rawMessageUpdateFromJs,
  rawChannelFromJs,
  rawReactionFromJs,
} from '../../src/platform/discord/client.js';
import { getMessage } from '../../src/db/repositories/messages.js';
import { getChannel } from '../../src/db/repositories/channels.js';
import { normalizeMessage } from '../../src/platform/discord/normalize.js';
import { createCounters, createIngestionObserver, COUNTER_NAMES } from '../../src/observability.js';

/**
 * Gateway event dispatch (Section 9.3).
 *
 * Acceptance: a fixture for every mandatory Gateway event reaches the correct
 * persistence path without opening network calls inside transactions. The
 * dispatcher takes raw payloads; the discord.js adapter wiring is exercised
 * separately through synthetic emissions.
 */

const MSG_ID = '200000000000000001';
const MSG_ID_2 = '200000000000000002';
const MSG_ID_3 = '200000000000000003';
const NEW_CHANNEL = '100000000000000010';
const THREAD_ID = '100000000000000020';
const REACTION_USER = '100000000000000004';

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db); // guild ...001, channel ...002, user ...003
});

afterEach(() => env.cleanup());

/** Count per-user reaction rows for a message+emoji. */
function userReactionRows(messageId: string, emojiKey: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ? AND emoji_key = ? AND present = 1')
    .get(messageId, emojiKey) as { n: number };
  return row.n;
}

describe('handleGatewayEvent dispatcher', () => {
  describe('message lifecycle', () => {
    it('MESSAGE_CREATE persists the message and indexes it for search', () => {
      const res = handleGatewayEvent(db, opts(), 'MESSAGE_CREATE', {
        id: MSG_ID,
        channel_id: CHANNEL,
        guild_id: GUILD,
        author: { id: AUTHOR, username: 'alice', global_name: 'Alice', bot: false },
        content: 'We decided to adoptXuniq the new lint config.',
        timestamp: '2024-05-01T12:00:00.000+00:00',
        edited_timestamp: null,
        type: 0,
        flags: 0,
        pinned: false,
        mention_everyone: false,
        mentions: [],
        embeds: [],
        components: [],
        attachments: [],
      });
      expect(res).toEqual({ handled: true });
      expect(getMessage(db, MSG_ID)?.content).toBe('We decided to adoptXuniq the new lint config.');
      expect(ftsMatches(db, 'adoptXuniq')).toBe(true);
    });

    it('MESSAGE_UPDATE applies a partial patch to an existing message', () => {
      handleGatewayEvent(db, opts(), 'MESSAGE_CREATE', {
        id: MSG_ID,
        channel_id: CHANNEL,
        guild_id: GUILD,
        author: { id: AUTHOR, username: 'alice', global_name: 'Alice' },
        content: 'originalXuniq',
        timestamp: '2024-05-01T12:00:00.000+00:00',
        edited_timestamp: null,
      });
      const res = handleGatewayEvent(db, opts(), 'MESSAGE_UPDATE', {
        id: MSG_ID,
        content: 'editedXuniq',
        edited_timestamp: '2024-05-01T12:01:00.000+00:00',
      });
      expect(res).toEqual({ handled: true });
      expect(getMessage(db, MSG_ID)?.content).toBe('editedXuniq');
      expect(ftsMatches(db, 'originalXuniq')).toBe(false);
      expect(ftsMatches(db, 'editedXuniq')).toBe(true);
    });

    it('MESSAGE_UPDATE for an unseen message is reported unhandled, not invented', () => {
      const res = handleGatewayEvent(db, opts(), 'MESSAGE_UPDATE', {
        id: '999999999999999999',
        guild_id: GUILD,
        content: 'never seen',
      });
      expect(res).toEqual({ handled: false, reason: 'unknown_message' });
    });

    it('MESSAGE_DELETE tombstones the message and drops it from search', () => {
      handleGatewayEvent(db, opts(), 'MESSAGE_CREATE', {
        id: MSG_ID,
        channel_id: CHANNEL,
        guild_id: GUILD,
        author: { id: AUTHOR },
        content: 'deleteMeXuniq',
        timestamp: '2024-05-01T12:00:00.000+00:00',
        edited_timestamp: null,
      });
      const res = handleGatewayEvent(db, opts(), 'MESSAGE_DELETE', { id: MSG_ID, channel_id: CHANNEL, guild_id: GUILD });
      expect(res).toEqual({ handled: true });
      expect(getMessage(db, MSG_ID)?.deleted_at_ms).not.toBeNull();
      expect(ftsMatches(db, 'deleteMeXuniq')).toBe(false);
    });

    it('MESSAGE_DELETE without an id is reported unhandled', () => {
      expect(handleGatewayEvent(db, opts(), 'MESSAGE_DELETE', { channel_id: CHANNEL, guild_id: GUILD })).toEqual({
        handled: false,
        reason: 'missing_id',
      });
    });

    it('rejects foreign and unprovable guild events before persistence', () => {
      handleGatewayEvent(db, opts(), 'MESSAGE_CREATE', {
        id: MSG_ID,
        channel_id: CHANNEL,
        guild_id: GUILD,
        author: { id: AUTHOR },
        content: 'must remain live',
        timestamp: '2024-05-01T12:00:00.000+00:00',
      });
      expect(handleGatewayEvent(db, opts(), 'MESSAGE_DELETE', {
        id: MSG_ID,
        channel_id: CHANNEL,
        guild_id: '999999999999999999',
      })).toEqual({ handled: false, reason: 'guild_mismatch' });
      expect(getMessage(db, MSG_ID)?.deleted_at_ms).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS n FROM message_tombstones WHERE message_id = ?').get(MSG_ID))
        .toEqual({ n: 0 });

      expect(handleGatewayEvent(db, opts(), 'MESSAGE_CREATE', {
        id: MSG_ID_2,
        channel_id: CHANNEL,
        author: { id: AUTHOR },
        content: 'guildless create',
        timestamp: '2024-05-01T12:00:00.000+00:00',
      })).toEqual({ handled: false, reason: 'guild_missing' });
      expect(getMessage(db, MSG_ID_2)).toBeUndefined();
    });

    it('MESSAGE_DELETE_BULK tombstones a batch', () => {
      for (const id of [MSG_ID, MSG_ID_2]) {
        handleGatewayEvent(db, opts(), 'MESSAGE_CREATE', {
          id,
          channel_id: CHANNEL,
          guild_id: GUILD,
          author: { id: AUTHOR },
          content: `bulk${id}Xuniq`,
          timestamp: '2024-05-01T12:00:00.000+00:00',
          edited_timestamp: null,
        });
      }
      const res = handleGatewayEvent(db, opts(), 'MESSAGE_DELETE_BULK', { ids: [MSG_ID, MSG_ID_2] });
      expect(res).toEqual({ handled: true });
      expect(getMessage(db, MSG_ID)?.deleted_at_ms).not.toBeNull();
      expect(getMessage(db, MSG_ID_2)?.deleted_at_ms).not.toBeNull();
    });

    it('MESSAGE_DELETE_BULK with no ids is reported unhandled', () => {
      expect(handleGatewayEvent(db, opts(), 'MESSAGE_DELETE_BULK', { ids: [], guild_id: GUILD })).toEqual({
        handled: false,
        reason: 'missing_ids',
      });
    });
  });

  describe('reactions', () => {
    function seedMessage(id = MSG_ID): void {
      handleGatewayEvent(db, opts(), 'MESSAGE_CREATE', {
        id,
        channel_id: CHANNEL,
        guild_id: GUILD,
        author: { id: AUTHOR },
        content: 'reaction target',
        timestamp: '2024-05-01T12:00:00.000+00:00',
        edited_timestamp: null,
      });
    }

    it('MESSAGE_REACTION_ADD then REMOVE toggle a per-user row', () => {
      seedMessage();
      const add = handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_ADD', {
        message_id: MSG_ID,
        user_id: REACTION_USER,
        emoji: { name: '👍' },
      });
      expect(add).toEqual({ handled: true });
      expect(userReactionRows(MSG_ID, '👍')).toBe(1);

      const remove = handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_REMOVE', {
        message_id: MSG_ID,
        user_id: REACTION_USER,
        emoji: { name: '👍' },
      });
      expect(remove).toEqual({ handled: true });
      expect(userReactionRows(MSG_ID, '👍')).toBe(0);
    });

    it('MESSAGE_REACTION_ADD with an emoji that has no key is handled and stores no row', () => {
      seedMessage();
      const add = handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_ADD', {
        message_id: MSG_ID,
        user_id: REACTION_USER,
        emoji: { id: null, name: null },
      });
      expect(add).toEqual({ handled: true });
      const rows = db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').get(MSG_ID) as { n: number };
      expect(rows.n).toBe(0);
    });

    it('MESSAGE_REACTION_ADD with missing fields is dropped', () => {
      seedMessage();
      expect(
        handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_ADD', { message_id: MSG_ID, emoji: { name: '👍' } }),
      ).toEqual({ handled: false, reason: 'missing_reaction_fields' });
    });

    it('does not write a reaction whose message dependency is absent', () => {
      expect(handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_ADD', {
        message_id: '999999999999999999', user_id: REACTION_USER, guild_id: GUILD, emoji: { name: '👍' },
      })).toEqual({ handled: false, reason: 'missing_message' });
    });

    it('MESSAGE_REACTION_REMOVE_ALL clears every reaction on a message', () => {
      seedMessage();
      handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_ADD', {
        message_id: MSG_ID,
        user_id: REACTION_USER,
        emoji: { name: '🔥' },
      });
      const res = handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_REMOVE_ALL', { id: MSG_ID });
      expect(res).toEqual({ handled: true });
      expect(userReactionRows(MSG_ID, '🔥')).toBe(0);
    });
  });

  describe('channels and threads', () => {
    it('CHANNEL_CREATE inserts a restricted channel; CHANNEL_UPDATE changes its name', () => {
      const created = handleGatewayEvent(db, opts(), 'CHANNEL_CREATE', {
        id: NEW_CHANNEL,
        guild_id: GUILD,
        type: 0,
        name: 'engineering',
        position: 3,
      });
      expect(created).toEqual({ handled: true });
      expect(getChannel(db, NEW_CHANNEL)?.name).toBe('engineering');
      expect(getChannel(db, NEW_CHANNEL)?.visibility_class).toBe('restricted');
      expect(getChannel(db, NEW_CHANNEL)?.deleted_at_ms).toBeNull();

      const updated = handleGatewayEvent(db, opts(), 'CHANNEL_UPDATE', {
        id: NEW_CHANNEL,
        guild_id: GUILD,
        type: 0,
        name: 'engineering-team',
        position: 3,
      });
      expect(updated).toEqual({ handled: true });
      expect(getChannel(db, NEW_CHANNEL)?.name).toBe('engineering-team');
    });

    it('CHANNEL_DELETE tombstones the channel', () => {
      handleGatewayEvent(db, opts(), 'CHANNEL_CREATE', {
        id: NEW_CHANNEL,
        guild_id: GUILD,
        type: 0,
        name: 'temp',
      });
      const res = handleGatewayEvent(db, opts(), 'CHANNEL_DELETE', { id: NEW_CHANNEL, guild_id: GUILD });
      expect(res).toEqual({ handled: true });
      expect(getChannel(db, NEW_CHANNEL)?.deleted_at_ms).not.toBeNull();
    });

    it('CHANNEL_CREATE without an id is reported unhandled', () => {
      expect(handleGatewayEvent(db, opts(), 'CHANNEL_CREATE', { name: 'nope', guild_id: GUILD })).toEqual({
        handled: false,
        reason: 'missing_channel_fields',
      });
    });

    it('THREAD_CREATE upserts a thread-shaped channel (is_thread=1, archived flags)', () => {
      const res = handleGatewayEvent(db, opts(), 'THREAD_CREATE', {
        id: THREAD_ID,
        guild_id: GUILD,
        parent_id: CHANNEL,
        type: 11,
        name: 'side-thread',
        thread_metadata: { archived: true, locked: false },
      });
      expect(res).toEqual({ handled: true });
      const row = getChannel(db, THREAD_ID)!;
      expect(row.is_thread).toBe(1);
      expect(row.is_archived).toBe(1);
      expect(row.is_locked).toBe(0);
      expect(row.parent_id).toBe(CHANNEL);
    });

    it('THREAD_DELETE tombstones the thread', () => {
      handleGatewayEvent(db, opts(), 'THREAD_CREATE', {
        id: THREAD_ID,
        guild_id: GUILD,
        parent_id: CHANNEL,
        type: 11,
        name: 'gone',
      });
      const res = handleGatewayEvent(db, opts(), 'THREAD_DELETE', { id: THREAD_ID, guild_id: GUILD });
      expect(res).toEqual({ handled: true });
      expect(getChannel(db, THREAD_ID)?.deleted_at_ms).not.toBeNull();
    });

    it('THREAD_LIST_SYNC upserts each thread in the batch', () => {
      const res = handleGatewayEvent(db, opts(), 'THREAD_LIST_SYNC', {
        threads: [
          { id: '100000000000000030', guild_id: GUILD, parent_id: CHANNEL, type: 11, name: 'sync-a' },
          { id: '100000000000000031', guild_id: GUILD, parent_id: CHANNEL, type: 11, name: 'sync-b' },
        ],
      });
      expect(res).toEqual({ handled: true });
      expect(getChannel(db, '100000000000000030')?.name).toBe('sync-a');
      expect(getChannel(db, '100000000000000031')?.name).toBe('sync-b');
    });

    it('THREAD_LIST_SYNC applies the supplied policy resolver to every thread', () => {
      const resolveExcluded = (raw: unknown, guildId: string, now: number) => {
        const input = channelInputFromRaw(raw, guildId, now);
        return input ? { ...input, ingestEnabled: false, visibilityClass: 'excluded' as const } : null;
      };
      handleGatewayEvent(db, opts(), 'THREAD_LIST_SYNC', {
        threads: [{ id: '100000000000000032', guild_id: GUILD, parent_id: CHANNEL, type: 11, name: 'excluded' }],
      }, resolveExcluded);

      const row = getChannel(db, '100000000000000032')!;
      expect(row.ingest_enabled).toBe(0);
      expect(row.visibility_class).toBe('excluded');
    });
  });

  it('an unknown event type is reported unhandled', () => {
    expect(
      handleGatewayEvent(db, opts(), 'GUILD_BAN_ADD' as GatewayEventType, {}),
    ).toEqual({ handled: false, reason: 'unknown_event' });
  });

  it('every mandatory event type is enumerated', () => {
    // Section 9.3 surface — every type the dispatcher claims to route.
    const expected: GatewayEventType[] = [
      'MESSAGE_CREATE',
      'MESSAGE_UPDATE',
      'MESSAGE_DELETE',
      'MESSAGE_DELETE_BULK',
      'MESSAGE_REACTION_ADD',
      'MESSAGE_REACTION_REMOVE',
      'MESSAGE_REACTION_REMOVE_ALL',
      'CHANNEL_CREATE',
      'CHANNEL_UPDATE',
      'CHANNEL_DELETE',
      'THREAD_CREATE',
      'THREAD_UPDATE',
      'THREAD_DELETE',
      'THREAD_LIST_SYNC',
    ];
    expect(GATEWAY_EVENT_TYPES).toEqual(expected);
  });
});

describe('discord.js adapters', () => {
  it('rawMessageFromJs maps camelCase fields to the raw payload', () => {
    const raw = rawMessageFromJs({
      id: MSG_ID,
      channelId: CHANNEL,
      guildId: GUILD,
      author: { id: AUTHOR, username: 'alice', global_name: 'Alice', bot: false },
      content: 'hello',
      createdTimestamp: 1_714_462_400_000,
      editedTimestamp: null,
      flags: 0,
      pinned: false,
      mentionEveryone: false,
      mentions: [{ id: '1', username: 'bob', global_name: 'Bob' }],
      embeds: [],
      components: [],
      attachments: [
        { id: 'a1', filename: 'f.png', size: 10, url: 'u', proxyURL: 'pu', contentType: 'image/png', width: 1, height: 2 },
      ],
      reactions: [{ count: 2, emoji: { name: '👍', id: null } }],
      reference: { messageId: 'parent1' },
    });
    expect(raw.id).toBe(MSG_ID);
    expect(raw.channel_id).toBe(CHANNEL);
    expect(raw.guild_id).toBe(GUILD);
    expect((raw.author as Record<string, unknown>).username).toBe('alice');
    expect(raw.timestamp).toBe('2024-04-30T07:33:20.000Z');
    expect(raw.edited_timestamp).toBeNull();
    expect((raw.attachments as Array<Record<string, unknown>>)[0]!.proxy_url).toBe('pu');
    expect((raw.reactions as Array<Record<string, unknown>>)[0]!.emoji).toEqual({ name: '👍', id: null });
    expect(raw.message_reference).toEqual({ message_id: 'parent1' });
    expect(normalizeMessage(raw).replyToMessageId).toBe('parent1');
  });

  it('rawMessageUpdateFromJs includes only present fields (absent ⇒ keep)', () => {
    const raw = rawMessageUpdateFromJs({ id: MSG_ID, content: 'new', editedTimestamp: 1_714_462_460_000 });
    expect(Object.keys(raw).sort()).toEqual(['content', 'edited_timestamp', 'id']);
    expect(raw.content).toBe('new');
  });

  it('rawChannelFromJs maps a thread and returns null without an id', () => {
    const raw = rawChannelFromJs({ id: THREAD_ID, guildId: GUILD, parentId: CHANNEL, type: 11, name: 't', archived: true });
    expect(raw).not.toBeNull();
    expect(raw!.type).toBe(11);
    expect(raw!.thread_metadata).toEqual({ archived: true, locked: false });
    expect(rawChannelFromJs(null)).toBeNull();
  });

  it('rawReactionFromJs requires both message and user ids', () => {
    expect(rawReactionFromJs({ message: { id: 'm1' }, emoji: { name: '👍' } }, { id: 'u1' })).toEqual({
      message_id: 'm1',
      user_id: 'u1',
      guild_id: null,
      channel_id: null,
      emoji: { name: '👍' },
    });
    // A missing emoji is passed through as null — the dispatcher's emoji-key
    // check drops it, not the adapter. Only a missing message/user id yields null.
    expect(rawReactionFromJs({ message: { id: 'm1' } }, { id: 'u1' })).toEqual({
      message_id: 'm1',
      user_id: 'u1',
      emoji: null,
      guild_id: null,
      channel_id: null,
    });
    expect(rawReactionFromJs({ message: { id: 'm1' } }, null)).toBeNull();
  });
});

describe('registerIngestionHandlers wiring', () => {
  let client: Client;

  beforeEach(() => {
    client = new Client({ intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.Guilds] });
  });
  afterEach(() => client.destroy());

  function wire(o: Partial<IngestOptions> = {}): { tracked: string[] } {
    const tracked: string[] = [];
    registerIngestionHandlers(client, {
      db,
      opts: opts(o),
      tracker: { recordEvent: (name) => tracked.push(name) },
    });
    return { tracked };
  }

  function emitMessage(id: string, content: string): void {
    client.emit(Events.MessageCreate, { id, channelId: CHANNEL, guildId: GUILD, author: { id: AUTHOR }, content } as unknown as Message);
  }

  it('emitting MessageCreate routes a camelCase object to persistence and records telemetry', () => {
    const { tracked } = wire();
    emitMessage(MSG_ID, 'wiredXuniq');
    expect(getMessage(db, MSG_ID)?.content).toBe('wiredXuniq');
    expect(ftsMatches(db, 'wiredXuniq')).toBe(true);
    expect(tracked).toContain('messageCreate');
  });

  it('uses fresh event-time options and invokes the post-persist message hook', () => {
    const seen: string[] = [];
    let observedAt = NOW;
    registerIngestionHandlers(client, {
      db,
      opts: () => opts({ now: ++observedAt }),
      onMessageCreate: (message) => seen.push(message.id),
    });
    emitMessage(MSG_ID, 'first event');
    emitMessage(MSG_ID_2, 'second event');

    expect(getMessage(db, MSG_ID)?.ingested_at_ms).toBe(NOW + 1);
    expect(getMessage(db, MSG_ID_2)?.ingested_at_ms).toBe(NOW + 2);
    expect(seen).toEqual([MSG_ID, MSG_ID_2]);
  });

  it('does not persist or post-process messages rejected by channel policy', () => {
    const seen: string[] = [];
    registerIngestionHandlers(client, {
      db,
      opts: opts(),
      shouldIngestMessage: () => false,
      onMessageCreate: (message) => seen.push(message.id),
    });
    emitMessage(MSG_ID, 'excluded content');
    expect(getMessage(db, MSG_ID)).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('records policy skips and queued recovery without disclosing event content', () => {
    const counters = createCounters();
    const fields: Record<string, unknown>[] = [];
    registerIngestionHandlers(client, {
      db,
      opts: opts(),
      observer: createIngestionObserver(counters),
      shouldIngestMessage: (channelId) => channelId !== CHANNEL,
      onMissingDependency: () => ({ recoveryId: 'recovery-1', generation: 2 }),
      logger: {
        debug: (value) => { fields.push(value as Record<string, unknown>); },
        info: (value) => { fields.push(value as Record<string, unknown>); },
        warn: (value) => { fields.push(value as Record<string, unknown>); },
      },
    });
    client.emit(Events.MessageCreate, {
      id: MSG_ID, channelId: CHANNEL, guildId: GUILD, author: { id: AUTHOR }, content: 'private-sentinel',
    } as unknown as Message);
    client.emit(Events.MessageCreate, {
      id: MSG_ID_2, channelId: '100000000000000099', guildId: GUILD, author: { id: AUTHOR }, content: 'credential-sentinel',
    } as unknown as Message);
    client.emit(Events.MessageCreate, {
      id: MSG_ID_3, channelId: CHANNEL, guildId: GUILD, content: 'malformed-secret-sentinel',
    } as unknown as Message);
    expect(counters.get(COUNTER_NAMES.ingestionEvents, {
      event_type: 'MESSAGE_CREATE', outcome: 'policy_skipped', reason: 'policy',
    })).toBe(1);
    expect(counters.get(COUNTER_NAMES.ingestionEvents, {
      event_type: 'MESSAGE_CREATE', outcome: 'failed', reason: 'malformed_payload',
    })).toBe(1);
    expect(counters.get(COUNTER_NAMES.ingestionEvents, {
      event_type: 'MESSAGE_CREATE', outcome: 'recovery_queued', reason: 'missing_channel',
    })).toBe(1);
    expect(JSON.stringify(fields)).not.toContain('private-sentinel');
    expect(JSON.stringify(fields)).not.toContain('credential-sentinel');
    expect(JSON.stringify(fields)).not.toContain('malformed-secret-sentinel');
  });

  it('discards DMs before policy, normalization, persistence, and post-processing', () => {
    const seen: string[] = [];
    let policyCalls = 0;
    const { tracked } = (() => {
      const tracked: string[] = [];
      registerIngestionHandlers(client, {
        db,
        opts: opts(),
        tracker: { recordEvent: (name) => tracked.push(name) },
        shouldIngestMessage: () => { policyCalls += 1; return true; },
        onMessageCreate: (message) => seen.push(message.id),
      });
      return { tracked };
    })();
    client.emit(Events.MessageCreate, {
      id: 'dm-message',
      channelId: 'dm-channel',
      guildId: null,
      author: { id: AUTHOR },
      get content(): never { throw new Error('DM content must not be normalized'); },
    } as unknown as Message);

    expect(policyCalls).toBe(0);
    expect(getMessage(db, 'dm-message')).toBeUndefined();
    expect(seen).toEqual([]);
    expect(tracked).toEqual([]);
  });

  it('raw MessageUpdate preserves payload field presence', () => {
    wire();
    emitMessage(MSG_ID, 'firstXuniq');
    client.emit(Events.Raw, { t: 'MESSAGE_UPDATE', d: {
      id: MSG_ID, channel_id: CHANNEL, content: 'secondXuniq',
      edited_timestamp: '2024-04-30T07:34:20.000Z',
    } });
    expect(getMessage(db, MSG_ID)?.content).toBe('secondXuniq');
  });

  it('MessageDelete tombstones via the wiring', () => {
    wire();
    emitMessage(MSG_ID, 'goneXuniq');
    client.emit(Events.MessageDelete, { id: MSG_ID, channelId: CHANNEL, guildId: GUILD } as unknown as Partial<Message>);
    expect(getMessage(db, MSG_ID)?.deleted_at_ms).not.toBeNull();
  });

  it('ChannelCreate upserts a discovered channel through the wiring', () => {
    wire();
    client.emit(Events.ChannelCreate, { id: NEW_CHANNEL, guildId: GUILD, type: 0, name: 'via-wire' });
    expect(getChannel(db, NEW_CHANNEL)?.name).toBe('via-wire');
  });

  it('a handler that throws is swallowed and does not break subsequent events', () => {
    wire();
    // A message whose channel does not exist (FK violation) would normally throw
    // inside the transaction; the handler wrapper must catch it so the process
    // keeps ingesting later valid events.
    expect(() =>
      client.emit(Events.MessageCreate, {
        id: MSG_ID_3,
        channelId: '000000000000000000', // unknown channel → FK failure inside ingest
        guildId: GUILD,
        author: { id: AUTHOR },
        content: 'bad',
      } as unknown as Message),
    ).not.toThrow();
    // A subsequent valid event still lands.
    emitMessage(MSG_ID, 'recoversXuniq');
    expect(getMessage(db, MSG_ID)?.content).toBe('recoversXuniq');
  });
});
