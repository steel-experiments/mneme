import { describe, it, expect } from 'vitest';
import { GatewayIntentBits, Events } from 'discord.js';
import { createLogger } from '../../src/logger.js';
import {
  MNEME_INTENTS,
  MNEME_PARTIALS,
  ClientHealthTracker,
  createDiscordClient,
  handleReady,
  validateGuilds,
  assertExpectedGuild,
  DiscordIdentityError,
  initialHealth,
  mentionsAssignedBotRole,
  createDirectMessageNoticeHandler,
  DIRECT_MESSAGE_NOTICE,
} from '../../src/platform/discord/client.js';
import { Partials } from 'discord.js';

const log = () => createLogger({ level: 'silent' });

describe('Discord client intents and partials', () => {
  it('recognizes only parsed roles assigned to Mneme', () => {
    const mentions = { roles: new Map([['bot-role', { id: 'bot-role' }]]) };
    expect(mentionsAssignedBotRole(mentions, new Set(['bot-role']))).toBe(true);
    expect(mentionsAssignedBotRole(mentions, new Set(['other-role']))).toBe(false);
    expect(mentionsAssignedBotRole({ roles: new Map() }, new Set(['bot-role']))).toBe(false);
  });

  it('requests exactly the five required intents and no presence/full-member intents', () => {
    expect(MNEME_INTENTS).toContain(GatewayIntentBits.Guilds);
    expect(MNEME_INTENTS).toContain(GatewayIntentBits.GuildMessages);
    expect(MNEME_INTENTS).toContain(GatewayIntentBits.GuildMessageReactions);
    expect(MNEME_INTENTS).toContain(GatewayIntentBits.DirectMessages);
    expect(MNEME_INTENTS).toContain(GatewayIntentBits.MessageContent);
    expect(MNEME_INTENTS).not.toContain(GatewayIntentBits.GuildPresences);
    expect(MNEME_INTENTS).not.toContain(GatewayIntentBits.GuildMembers);
    expect(MNEME_INTENTS).toHaveLength(5);

    // Partials cover the uncached entity types the gateway events need.
    expect(MNEME_PARTIALS).toContain(Partials.Channel);
    expect(MNEME_PARTIALS).toContain(Partials.Message);
    expect(MNEME_PARTIALS).toContain(Partials.Reaction);
  });

  it('constructs the discord.js client with only those intents', () => {
    const { client } = createDiscordClient({
      token: 't',
      guildId: '123',
      logger: log(),
    });
    const intents = client.options.intents;
    for (const bit of MNEME_INTENTS) expect(intents.has(bit)).toBe(true);
    expect(intents.has(GatewayIntentBits.GuildPresences)).toBe(false);
    expect(intents.has(GatewayIntentBits.GuildMembers)).toBe(false);
    expect(intents.has(GatewayIntentBits.DirectMessages)).toBe(true);
    client.destroy();
  });
});

describe('direct-message UX notice', () => {
  it('sends fixed copy without inspecting message content', async () => {
    const replies: unknown[] = [];
    const handle = createDirectMessageNoticeHandler({ clock: () => 1_000 });
    const message = {
      guildId: null,
      author: { id: 'user-1', bot: false },
      get content(): never { throw new Error('DM content must not be read'); },
      reply: async (options: unknown) => { replies.push(options); },
    };

    await expect(handle(message)).resolves.toBe('sent');
    expect(replies).toEqual([{
      content: DIRECT_MESSAGE_NOTICE,
      allowedMentions: { parse: [], repliedUser: false },
    }]);
  });

  it('rate-limits per sender, ignores guild and bot messages, and retries a failed send', async () => {
    let now = 1_000;
    let sends = 0;
    const handle = createDirectMessageNoticeHandler({ clock: () => now, cooldownMs: 100 });
    const dm = (id: string, fail = false) => ({
      guildId: null,
      author: { id, bot: false },
      reply: async () => { sends += 1; if (fail) throw new Error('send failed'); },
    });

    await expect(handle(dm('user-1'))).resolves.toBe('sent');
    await expect(handle(dm('user-1'))).resolves.toBe('rate_limited');
    await expect(handle(dm('user-2'))).resolves.toBe('sent');
    await expect(handle({ ...dm('bot'), author: { id: 'bot', bot: true } })).resolves.toBe('ignored');
    await expect(handle({ ...dm('guild-user'), guildId: 'guild-1' })).resolves.toBe('ignored');
    await expect(handle(dm('failing-user', true))).resolves.toBe('failed');
    await expect(handle(dm('failing-user'))).resolves.toBe('sent');
    now += 100;
    await expect(handle(dm('user-1'))).resolves.toBe('sent');
    expect(sends).toBe(5);
  });
});

describe('guild identity validation', () => {
  it('accepts the configured guild and rejects a different one', () => {
    expect(validateGuilds(['123'], '123')).toEqual({ ok: true, mismatch: false });
    // Different guild entirely.
    const missing = validateGuilds(['999'], '123');
    expect(missing.ok).toBe(false);
    expect(missing.mismatch).toBe(true);
    expect(missing.reason).toBe('expected_guild_missing');
    // Configured guild present but an extra guild is too.
    const extra = validateGuilds(['123', '456'], '123');
    expect(extra.ok).toBe(false);
    expect(extra.mismatch).toBe(true);
    expect(extra.reason).toBe('unexpected_guild_present');
  });

  it('assertExpectedGuild throws on mismatch and is silent on match', () => {
    expect(() => assertExpectedGuild(['999'], '123')).toThrow(DiscordIdentityError);
    expect(() => assertExpectedGuild(['123'], '123')).not.toThrow();
  });

  it('handleReady records guild mismatch into the tracker', () => {
    const tracker = new ClientHealthTracker(() => 1);
    const stub = { guilds: { cache: { keys: () => ['999'].values() } }, ws: { ping: 42 } };
    const result = handleReady(stub as never, tracker, '123');
    expect(result.ok).toBe(false);
    const snap = tracker.snapshot();
    expect(snap.guildOk).toBe(false);
    expect(snap.guildMismatch).toBe(true);
    expect(snap.guildId).toBe('123'); // configured id recorded regardless
    expect(snap.pingMs).toBe(42);
  });
});

describe('gateway health tracker', () => {
  it('starts idle and transitions through connecting → ready', () => {
    const t = new ClientHealthTracker(() => 100);
    expect(t.snapshot()).toMatchObject({ status: 'idle', ready: false, updatedAtMs: 100 });

    t.markConnecting();
    expect(t.snapshot().status).toBe('connecting');

    t.markReady({ guildId: '1', guildOk: true, guildMismatch: false, pingMs: 7 });
    const ready = t.snapshot();
    expect(ready).toMatchObject({
      status: 'ready',
      ready: true,
      guildId: '1',
      guildOk: true,
      pingMs: 7,
      lastEventType: 'ready',
    });
  });

  it('counts reconnects, invalidations, and errors and clears readiness on disconnect', () => {
    const t = new ClientHealthTracker(() => 5);
    t.markReady({ guildId: '1', guildOk: true, guildMismatch: false, pingMs: 1 });

    t.markReconnecting();
    t.markReconnecting();
    expect(t.snapshot()).toMatchObject({ reconnects: 2, ready: false, status: 'connecting' });

    t.markResumed(9);
    expect(t.snapshot()).toMatchObject({ status: 'resumed', ready: true, pingMs: 9 });

    t.markDisconnected();
    expect(t.snapshot()).toMatchObject({ status: 'disconnected', ready: false });

    t.markError();
    expect(t.snapshot()).toMatchObject({ errors: 1, status: 'error' });
    expect(t.snapshot().lastErrorAtMs).toBe(5);

    t.markInvalidated();
    expect(t.snapshot()).toMatchObject({ invalidations: 1, ready: false, status: 'disconnected' });
  });

  it('records gateway events and produces detached snapshots', () => {
    const t = new ClientHealthTracker(() => 7);
    t.recordEvent('messageCreate');
    const snap = t.snapshot();
    expect(snap).toMatchObject({ lastEventType: 'messageCreate', lastEventAtMs: 7 });
    snap.ready = true; // mutate the copy
    expect(t.snapshot().ready).toBe(false);
  });

  it('initialHealth is a clean zeroed baseline', () => {
    expect(initialHealth()).toEqual({
      status: 'idle',
      ready: false,
      guildId: null,
      guildOk: false,
      guildMismatch: false,
      pingMs: 0,
      lastEventAtMs: null,
      lastEventType: null,
      lastErrorAtMs: null,
      reconnects: 0,
      invalidations: 0,
      errors: 0,
      updatedAtMs: 0,
    });
  });
});

describe('discord client lifecycle wiring', () => {
  it('updates the tracker when shard/error/invalidated events fire on the real client', () => {
    let now = 1000;
    const { client, tracker } = createDiscordClient({
      token: 't',
      guildId: '1',
      logger: log(),
      clock: () => now,
    });

    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardResume, 0, 3);
    expect(tracker.snapshot()).toMatchObject({ reconnects: 1, status: 'resumed', ready: true });

    client.emit(Events.ShardDisconnect, { code: 1000 }, { id: 0 });
    expect(tracker.snapshot().ready).toBe(false);

    now = 2000;
    client.emit(Events.Error, new Error('boom'));
    expect(tracker.snapshot()).toMatchObject({ errors: 1, lastErrorAtMs: 2000 });

    client.emit(Events.Invalidated);
    expect(tracker.snapshot()).toMatchObject({ invalidations: 1 });

    client.destroy();
  });
});
