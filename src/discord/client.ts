import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import type { Logger } from '../logger.js';
import { type DatabaseSync } from '../db/database.js';
import { handleGatewayEvent, type IngestOptions } from './ingest.js';
import { normalizeMessage, type NormalizedMessage } from './normalize.js';
import { getMessage } from '../db/repositories/messages.js';
import type { IngestionObserver, IngestionOutcome, IngestionReason } from '../observability.js';

/**
 * Discord client (Sections 6.2, 9.3).
 *
 * One discord.js client for one guild, using only the five required intents —
 * `Guilds`, `GuildMessages`, `GuildMessageReactions`, `DirectMessages`,
 * `MessageContent` — and
 * deliberately NOT requesting presence or full guild-member intents. The client
 * validates that the authenticated guild matches the configured one and tracks
 * gateway health (ready, ping, session state, last event, reconnects,
 * invalidations, errors, shard lifecycle) for the status endpoint and readiness
 * probe.
 *
 * The health tracker and guild check are pure so they can be unit-tested without
 * a Discord connection; the factory wires discord.js lifecycle events to them.
 */

/** The only gateway intents Mneme requests (Section 6.2). */
export const MNEME_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.MessageContent,
] as const;

/** Fixed, content-free response for unsupported conversational DMs. */
export const DIRECT_MESSAGE_NOTICE =
  'Mneme doesn\'t answer DMs. Ask me in the Discord server by mentioning @Mneme in a channel I can access.';

/** One notice per sender per rolling 24 hours prevents repeated replies to a DM burst. */
export const DIRECT_MESSAGE_NOTICE_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const MAX_DIRECT_MESSAGE_NOTICE_SENDERS = 10_000;

export type DirectMessageNoticeOutcome = 'sent' | 'ignored' | 'rate_limited' | 'failed';

interface DirectMessageNoticeInput {
  guildId?: string | null;
  author?: { id?: string; bot?: boolean } | null;
  reply(options: {
    content: string;
    allowedMentions: { parse: never[]; repliedUser: false };
  }): Promise<unknown>;
}

interface DirectMessageNoticeOptions {
  clock?: () => number;
  cooldownMs?: number;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Build the isolated DM-notice path. It inspects only guild presence, bot status,
 * and the sender id needed for an in-memory cooldown. DM content is never read,
 * persisted, logged, or passed to ingestion/the model.
 */
export function createDirectMessageNoticeHandler(
  options: DirectMessageNoticeOptions = {},
): (message: DirectMessageNoticeInput) => Promise<DirectMessageNoticeOutcome> {
  const clock = options.clock ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DIRECT_MESSAGE_NOTICE_COOLDOWN_MS;
  const lastNoticeByUser = new Map<string, number>();

  return async (message): Promise<DirectMessageNoticeOutcome> => {
    if (message.guildId != null || message.author?.bot === true) return 'ignored';
    const userId = message.author?.id;
    if (!userId) return 'ignored';

    const now = clock();
    const lastNoticeAt = lastNoticeByUser.get(userId);
    if (lastNoticeAt !== undefined && now - lastNoticeAt < cooldownMs) return 'rate_limited';
    if (lastNoticeByUser.size >= MAX_DIRECT_MESSAGE_NOTICE_SENDERS) {
      for (const [id, sentAt] of lastNoticeByUser) {
        if (now - sentAt >= cooldownMs) lastNoticeByUser.delete(id);
      }
      // Bound attacker-controlled sender cardinality even within one cooldown window.
      if (lastNoticeByUser.size >= MAX_DIRECT_MESSAGE_NOTICE_SENDERS) {
        const oldest = lastNoticeByUser.keys().next().value as string | undefined;
        if (oldest !== undefined) lastNoticeByUser.delete(oldest);
      }
    }
    lastNoticeByUser.set(userId, now);

    try {
      await message.reply({
        content: DIRECT_MESSAGE_NOTICE,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return 'sent';
    } catch {
      // A failed send may be retried by the next DM; never log DM content or identity.
      if (lastNoticeByUser.get(userId) === now) lastNoticeByUser.delete(userId);
      options.logger?.warn({ event: 'discord.dm_notice_failed' }, 'failed to send static DM notice');
      return 'failed';
    }
  };
}

/**
 * Partials required so events fire for uncached entities (Section 9.3/9.4):
 * deletes and reactions on old messages, and channel/thread events the client
 * has not seen this session.
 */
export const MNEME_PARTIALS = [
  Partials.Channel,
  Partials.Message,
  Partials.Reaction,
] as const;

export type GatewayStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'resumed'
  | 'disconnected'
  | 'error';

/** Snapshot of gateway/client health, surfaced by `/status` (Section 32.3). */
export interface ClientHealth {
  status: GatewayStatus;
  /** True once ready and not currently disconnected. */
  ready: boolean;
  /** Configured guild id, recorded once the client is ready. */
  guildId: string | null;
  /** True when the authenticated guild matches the configured one. */
  guildOk: boolean;
  /** True when a different/missing guild was observed. */
  guildMismatch: boolean;
  pingMs: number;
  lastEventAtMs: number | null;
  lastEventType: string | null;
  lastErrorAtMs: number | null;
  /** Number of shard reconnect attempts. */
  reconnects: number;
  /** Number of session invalidations. */
  invalidations: number;
  errors: number;
  updatedAtMs: number;
}

export function initialHealth(): ClientHealth {
  return {
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
  };
}

/**
 * Mutable gateway-health tracker. All transitions are pure functions of the
 * previous state plus the event; a clock is injected for deterministic tests.
 */
export class ClientHealthTracker {
  private state: ClientHealth;
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.state = initialHealth();
    this.state.updatedAtMs = clock();
  }

  markConnecting(): void {
    this.patch({ status: 'connecting' });
  }

  markReady(args: { guildId: string; guildOk: boolean; guildMismatch: boolean; pingMs: number }): void {
    this.patch({
      status: 'ready',
      ready: true,
      guildId: args.guildId,
      guildOk: args.guildOk,
      guildMismatch: args.guildMismatch,
      pingMs: args.pingMs,
      lastEventAtMs: this.clock(),
      lastEventType: 'ready',
    });
  }

  markResumed(pingMs: number): void {
    this.patch({
      status: 'resumed',
      ready: true,
      pingMs,
      lastEventAtMs: this.clock(),
      lastEventType: 'shardResume',
    });
  }

  markReconnecting(): void {
    this.patch({
      status: 'connecting',
      ready: false,
      reconnects: this.state.reconnects + 1,
      lastEventAtMs: this.clock(),
      lastEventType: 'shardReconnecting',
    });
  }

  markDisconnected(): void {
    this.patch({
      status: 'disconnected',
      ready: false,
      lastEventAtMs: this.clock(),
      lastEventType: 'shardDisconnect',
    });
  }

  markError(): void {
    this.patch({
      status: 'error',
      errors: this.state.errors + 1,
      lastErrorAtMs: this.clock(),
      lastEventAtMs: this.clock(),
      lastEventType: 'error',
    });
  }

  markInvalidated(): void {
    this.patch({
      status: 'disconnected',
      ready: false,
      invalidations: this.state.invalidations + 1,
      lastEventAtMs: this.clock(),
      lastEventType: 'invalidated',
    });
  }

  /** Record a gateway event (used by ingestion handlers too). */
  recordEvent(type: string): void {
    this.patch({ lastEventAtMs: this.clock(), lastEventType: type });
  }

  setPing(pingMs: number): void {
    this.patch({ pingMs });
  }

  /** A detached copy; mutating it does not affect the tracker. */
  snapshot(): ClientHealth {
    return { ...this.state };
  }

  private patch(values: Partial<ClientHealth>): void {
    this.state = { ...this.state, ...values, updatedAtMs: this.clock() };
  }
}

export interface GuildValidation {
  ok: boolean;
  mismatch: boolean;
  reason?: 'expected_guild_missing' | 'unexpected_guild_present';
}

/**
 * Validate the authenticated guild set against the single configured guild
 * (Section 6.6: one guild). Mismatch (expected missing, or an extra guild
 * present) fails the check without distinguishing the reason to the caller
 * beyond a safe code.
 */
export function validateGuilds(presentIds: readonly string[], expectedId: string): GuildValidation {
  if (!presentIds.includes(expectedId)) {
    return { ok: false, mismatch: true, reason: 'expected_guild_missing' };
  }
  const extras = presentIds.filter((id) => id !== expectedId);
  if (extras.length > 0) {
    return { ok: false, mismatch: true, reason: 'unexpected_guild_present' };
  }
  return { ok: true, mismatch: false };
}

/** Raised by `assertExpectedGuild` when the authenticated guild is wrong. */
export class DiscordIdentityError extends Error {
  constructor(public readonly reason: GuildValidation['reason']) {
    super(`discord identity check failed: ${reason}`);
    this.name = 'DiscordIdentityError';
  }
}

/** Throw on a guild mismatch — used at startup to fail fast (reject the guild). */
export function assertExpectedGuild(presentIds: readonly string[], expectedId: string): void {
  const result = validateGuilds(presentIds, expectedId);
  if (!result.ok) throw new DiscordIdentityError(result.reason);
}

/** Structural subset of a ready discord.js client, for testability. */
interface ReadyClientLike {
  guilds: { cache: { keys(): Iterable<string> } };
  ws: { ping: number };
}

/**
 * Apply the ready event: validate guild identity and record health. Returns the
 * validation result so the caller can decide whether to shut down on mismatch.
 */
export function handleReady(
  client: ReadyClientLike,
  tracker: ClientHealthTracker,
  expectedGuildId: string,
): GuildValidation {
  const presentIds = [...client.guilds.cache.keys()];
  const result = validateGuilds(presentIds, expectedGuildId);
  tracker.markReady({
    guildId: expectedGuildId,
    guildOk: result.ok,
    guildMismatch: result.mismatch,
    pingMs: client.ws.ping,
  });
  return result;
}

export interface CreateDiscordClientOptions {
  token: string;
  guildId: string;
  logger: Logger;
  /** Inject a clock for deterministic tests (default Date.now). */
  clock?: () => number;
}

export interface DiscordClientHandle {
  client: Client;
  tracker: ClientHealthTracker;
}

/**
 * Instantiate the discord.js client with Mneme's intents and partials, and
 * wire the gateway lifecycle events to the health tracker. The returned client
 * is not yet connected — the caller logs in (Section 5.1 bootstrap). Guild
 * identity is checked on `ready`; a mismatch is logged and recorded but does not
 * throw here (the bootstrap may call `assertExpectedGuild` to fail fast).
 */
export function createDiscordClient(options: CreateDiscordClientOptions): DiscordClientHandle {
  const clock = options.clock ?? Date.now;
  const tracker = new ClientHealthTracker(clock);
  const client = new Client({
    intents: [...MNEME_INTENTS],
    partials: [...MNEME_PARTIALS],
  });
  const handleDirectMessage = createDirectMessageNoticeHandler({
    clock,
    logger: options.logger,
  });
  client.on(Events.MessageCreate, (message) => {
    void handleDirectMessage(message);
  });

  client.once(Events.ClientReady, () => {
    const result = handleReady(client, tracker, options.guildId);
    if (!result.ok) {
      options.logger.error(
        { event: 'discord.guild_mismatch', reason: result.reason },
        'authenticated guild does not match the configured guild',
      );
    }
  });

  client.on(Events.ShardReady, () => {
    tracker.recordEvent('shardReady');
    tracker.setPing(client.ws.ping);
  });
  client.on(Events.ShardReconnecting, () => tracker.markReconnecting());
  client.on(Events.ShardResume, () => tracker.markResumed(client.ws.ping));
  client.on(Events.ShardDisconnect, () => tracker.markDisconnected());
  client.on(Events.ShardError, (err) => {
    tracker.markError();
    options.logger.warn({ event: 'discord.shard_error', err: err.message }, 'discord shard error');
  });
  client.on(Events.Error, (err) => {
    tracker.markError();
    options.logger.error({ event: 'discord.error', err: err.message }, 'discord client error');
  });
  client.on(Events.Invalidated, () => tracker.markInvalidated());

  return { client, tracker };
}

// ---- Gateway ingestion wiring (Section 9.3) ---------------------------------

/**
 * Adapters from discord.js event objects to the raw (snake_case) payloads the
 * normalization layer consumes. discord.js delivers camelCase class instances;
 * `normalizeMessage`/`normalizeMessageUpdate` expect raw Gateway shapes, so each
 * adapter rebuilds that shape without performing any normalization of its own.
 * Structural interfaces keep these testable with plain objects (no live client).
 */

/** Structural slice of a discord.js Message / PartialMessage. */
export interface JsMessageLike {
  id: string;
  channelId?: string | null;
  channel?: { id?: string } | null;
  guildId?: string | null;
  author?: { id: string; username?: string | null; globalName?: string | null; bot?: boolean } | null;
  webhookId?: string | null;
  content: string | null;
  createdTimestamp?: number;
  createdAt?: { toISOString(): string } | null;
  editedTimestamp?: number | null;
  editedAt?: { toISOString(): string } | null;
  type?: number;
  flags?: number;
  pinned?: boolean;
  mentionEveryone?: boolean;
  mentions?: unknown;
  embeds?: unknown[];
  components?: unknown[];
  attachments?: unknown;
  reactions?: unknown;
  reference?: { messageId?: string | null } | null;
  guild?: {
    members?: { me?: { roles?: { cache?: { has(id: string): boolean } } } | null };
  } | null;
}

function toIterable<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.values === 'function') return Array.from((o.values as () => Iterable<unknown>)()) as T[];
    if (typeof o.map === 'function') return (o.map as (cb: (v: unknown) => unknown) => unknown[])((v) => v) as T[];
  }
  return [];
}

function collectionValues<T>(owner: unknown, key: string): T[] {
  if (Array.isArray(owner)) return owner as T[];
  if (!owner || typeof owner !== 'object') return [];
  return toIterable<T>((owner as Record<string, unknown>)[key]);
}

function bitfieldNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const bitfield = (value as { bitfield?: unknown }).bitfield;
    if (typeof bitfield === 'number') return bitfield;
    if (typeof bitfield === 'bigint') return Number(bitfield);
  }
  return 0;
}

function isoFromTimestamp(ms: number | undefined, date: { toISOString(): string } | null | undefined): string | undefined {
  if (date && typeof date.toISOString === 'function') return date.toISOString();
  if (typeof ms === 'number') return new Date(ms).toISOString();
  return undefined;
}

interface JsMentionLike {
  id: string;
  username?: string | null;
  globalName?: string | null;
}
interface JsAttachmentLike {
  id: string;
  filename?: string;
  size?: number;
  url?: string;
  proxyURL?: string;
  contentType?: string;
  width?: number;
  height?: number;
}
interface JsReactionLike {
  count?: number;
  emoji?: { name?: string | null; id?: string | null };
}

/** True only for a parsed role entity that is currently assigned to the bot. */
export function mentionsAssignedBotRole(
  mentions: unknown,
  botRoleCache: { has(id: string): boolean } | null | undefined,
): boolean {
  if (!botRoleCache) return false;
  return collectionValues<{ id: string }>(mentions, 'roles')
    .some((role) => typeof role.id === 'string' && botRoleCache.has(role.id));
}

/** Build a raw MESSAGE_CREATE payload from a discord.js message. */
export function rawMessageFromJs(m: JsMessageLike): Record<string, unknown> {
  const mentions = collectionValues<JsMentionLike>(m.mentions, 'users');
  const attachments = toIterable<JsAttachmentLike>(m.attachments);
  const reactions = collectionValues<JsReactionLike>(m.reactions, 'cache');
  return {
    id: m.id,
    channel_id: m.channelId ?? m.channel?.id ?? '',
    guild_id: m.guildId ?? null,
    author: m.author
      ? { id: m.author.id, username: m.author.username ?? null, global_name: m.author.globalName ?? null, bot: m.author.bot ?? false }
      : null,
    webhook_id: m.webhookId ?? null,
    content: typeof m.content === 'string' ? m.content : '',
    timestamp: isoFromTimestamp(m.createdTimestamp, m.createdAt),
    edited_timestamp: m.editedTimestamp === null ? null : isoFromTimestamp(m.editedTimestamp ?? undefined, m.editedAt),
    type: m.type ?? 0,
    flags: bitfieldNumber(m.flags),
    pinned: m.pinned ?? false,
    mention_everyone: m.mentionEveryone ?? false,
    mentions: mentions.map((u) => ({ id: u.id, username: u.username ?? null, global_name: u.globalName ?? null })),
    embeds: m.embeds ?? [],
    components: m.components ?? [],
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename ?? '',
      content_type: a.contentType ?? null,
      size: a.size ?? 0,
      width: a.width ?? null,
      height: a.height ?? null,
      url: a.url ?? null,
      proxy_url: a.proxyURL ?? null,
    })),
    reactions: reactions.map((r) => ({ count: r.count ?? 0, emoji: { name: r.emoji?.name ?? null, id: r.emoji?.id ?? null } })),
    message_reference: m.reference?.messageId ? { message_id: m.reference.messageId } : undefined,
  };
}

/**
 * Build a raw MESSAGE_UPDATE payload, including a field only when the discord.js
 * object carries it — so the normalization layer can distinguish absent (keep),
 * null (clear), and present (update) per Section 9.4.
 */
export function rawMessageUpdateFromJs(m: JsMessageLike): Record<string, unknown> {
  const out: Record<string, unknown> = { id: m.id };
  const channelId = m.channelId ?? m.channel?.id;
  if (channelId !== undefined) out.channel_id = channelId;
  if (m.guildId !== undefined) out.guild_id = m.guildId;
  if (m.author !== undefined) {
    out.author = m.author
      ? { id: m.author.id, username: m.author.username ?? null, global_name: m.author.globalName ?? null, bot: m.author.bot ?? false }
      : null;
  }
  if (m.content !== undefined) out.content = typeof m.content === 'string' ? m.content : '';
  if (m.editedTimestamp !== undefined) {
    out.edited_timestamp = m.editedTimestamp === null ? null : isoFromTimestamp(m.editedTimestamp, m.editedAt);
  }
  if (m.flags !== undefined) out.flags = m.flags;
  if (m.pinned !== undefined) out.pinned = m.pinned;
  if (m.mentionEveryone !== undefined) out.mention_everyone = m.mentionEveryone;
  if (m.mentions !== undefined) {
    const mentions = toIterable<JsMentionLike>(m.mentions);
    out.mentions = mentions.map((u) => ({ id: u.id, username: u.username ?? null, global_name: u.globalName ?? null }));
  }
  if (m.embeds !== undefined) out.embeds = m.embeds;
  if (m.components !== undefined) out.components = m.components;
  return out;
}

interface JsReactionEventLike {
  message?: { id?: string; guildId?: string | null; channelId?: string | null } | null;
  emoji?: unknown;
}
interface JsUserLike {
  id?: string;
}

/** Build a raw reaction payload `{message_id, user_id, emoji}` or null if incomplete. */
export function rawReactionFromJs(
  reaction: JsReactionEventLike | null,
  user: JsUserLike | null,
): { message_id: string; user_id: string; guild_id: string | null; channel_id: string | null; emoji: unknown } | null {
  const messageId = reaction?.message?.id;
  const userId = user?.id;
  if (typeof messageId !== 'string' || typeof userId !== 'string') return null;
  return {
    message_id: messageId,
    user_id: userId,
    guild_id: reaction?.message?.guildId ?? null,
    channel_id: reaction?.message?.channelId ?? null,
    emoji: reaction?.emoji ?? null,
  };
}

interface JsChannelLike {
  id: string;
  guildId?: string | null;
  guild?: { id?: string } | null;
  parentId?: string | null;
  type?: number;
  name?: string | null;
  topic?: string | null;
  position?: number | null;
  lastMessageId?: string | null;
  archived?: boolean;
  locked?: boolean;
}

/** Build a raw channel/thread payload from a discord.js channel. Returns null without an id. */
export function rawChannelFromJs(ch: JsChannelLike | null): Record<string, unknown> | null {
  if (!ch || typeof ch.id !== 'string') return null;
  const meta =
    ch.archived !== undefined || ch.locked !== undefined
      ? { archived: ch.archived ?? false, locked: ch.locked ?? false }
      : undefined;
  return {
    id: ch.id,
    guild_id: ch.guildId ?? ch.guild?.id ?? null,
    parent_id: ch.parentId ?? null,
    type: ch.type ?? 0,
    name: ch.name ?? null,
    topic: ch.topic ?? null,
    position: ch.position ?? null,
    last_message_id: ch.lastMessageId ?? null,
    thread_metadata: meta,
  };
}

export interface IngestionHandlerDeps {
  db: DatabaseSync;
  /** Event-time options. A factory avoids freezing observation timestamps at startup. */
  opts: IngestOptions | (() => IngestOptions);
  /** Fail-closed policy hook evaluated before a new message is persisted. */
  shouldIngestMessage?: (channelId: string, message: NormalizedMessage) => boolean;
  /** Called only after a MESSAGE_CREATE was successfully persisted. */
  onMessageCreate?: (message: NormalizedMessage) => void;
  /** Resolve policy-aware channel metadata for gateway create/update events. */
  resolveChannelInput?: Parameters<typeof handleGatewayEvent>[4];
  /** Called after a channel/thread mutation has committed; must not perform inline network I/O. */
  onChannelChange?: (event: 'create' | 'update' | 'delete', channelId: string) => void;
  /** Queue an id-only recovery after a known-guild dependency arrives out of order. */
  onMissingDependency?: (input: { reason: 'missing_channel' | 'missing_message'; channelId: string; messageId: string }) =>
    { recoveryId: string; generation: number } | void;
  /** Content-free outcome counter owner. */
  observer?: IngestionObserver;
  /** Optional health tracker updated with the last event name (telemetry). */
  tracker?: { recordEvent(name: string): void };
  /** Optional logger for handler errors. */
  logger?: Pick<Logger, 'debug' | 'info' | 'warn'>;
}

/**
 * Register every mandatory Section 9.3 gateway handler on the client. Each handler
 * adapts its discord.js object to a raw payload, routes it through the dispatcher,
 * and updates last-event telemetry. Handler failures are logged and swallowed so a
 * single malformed event never tears down ingestion; no handler opens network I/O
 * inside its transaction (the dispatcher and ingest layer guarantee that).
 */
export function registerIngestionHandlers(client: Client, deps: IngestionHandlerDeps): void {
  const { db } = deps;
  const opts = (): IngestOptions =>
    typeof deps.opts === 'function' ? deps.opts() : deps.opts;
  const track = (name: string): void => {
    deps.tracker?.recordEvent(name);
  };
  const validId = (value: unknown): value is string => typeof value === 'string' && /^\d{17,20}$/.test(value);
  const emitOutcome = (
    eventType: string, outcome: IngestionOutcome, reason: IngestionReason,
    ids: { guildId?: unknown; channelId?: unknown; messageId?: unknown } = {},
  ): void => {
    deps.observer?.event(eventType, outcome, reason);
    const fields: Record<string, string> = { event: 'discord.ingestion_outcome', eventType, outcome, reason };
    if (validId(ids.guildId)) fields.guildId = ids.guildId;
    if (validId(ids.channelId)) fields.channelId = ids.channelId;
    if (validId(ids.messageId)) fields.messageId = ids.messageId;
    if (outcome === 'persisted' || outcome === 'duplicate') deps.logger?.debug(fields, 'discord ingestion outcome');
    else if (outcome === 'policy_skipped') deps.logger?.info(fields, 'discord ingestion outcome');
    else deps.logger?.warn(fields, 'discord ingestion outcome');
  };
  const errorReason = (err: unknown): IngestionReason => {
    if (err && typeof err === 'object') {
      const code = (err as { code?: unknown; errcode?: unknown }).code;
      const errcode = (err as { errcode?: unknown }).errcode;
      if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || errcode === 787) return 'foreign_key';
    }
    if (err instanceof Error && err.message.startsWith('normalizeMessage')) return 'malformed_payload';
    return 'unexpected_exception';
  };
  const run = (name: string, fn: () => void, eventType = name): void => {
    try {
      fn();
    } catch (err) {
      emitOutcome(eventType, 'failed', errorReason(err));
    }
    track(name);
  };

  client.on(Events.MessageCreate, (message) => {
    // DMs have a separate static-notice path. Discard them before adapting or
    // normalizing content so they cannot enter policy, persistence, or models.
    if ((message as unknown as JsMessageLike).guildId == null) return;
    run('messageCreate', () => {
      const raw = rawMessageFromJs(message as unknown as JsMessageLike);
      // Discord's autocomplete can select the managed bot role instead of the
      // bot user when both are named Mneme. Treat a parsed mention of a role
      // actually assigned to this bot as a direct bot mention; lookalike text
      // and unrelated role mentions remain inert.
      const botRoles = (message as unknown as JsMessageLike).guild?.members?.me?.roles?.cache;
      const botUser = client.user;
      if (botUser && mentionsAssignedBotRole((message as unknown as JsMessageLike).mentions, botRoles)) {
        const mentions = Array.isArray(raw.mentions) ? raw.mentions as Array<Record<string, unknown>> : [];
        if (!mentions.some((mention) => mention.id === botUser.id)) {
          mentions.push({ id: botUser.id, username: botUser.username, global_name: botUser.globalName });
          raw.mentions = mentions;
        }
      }
      const normalized = normalizeMessage(raw);
      if (deps.shouldIngestMessage && !deps.shouldIngestMessage(normalized.channelId, normalized)) {
        emitOutcome('MESSAGE_CREATE', 'policy_skipped', 'policy', { guildId: normalized.guildId, channelId: normalized.channelId, messageId: normalized.id });
        return;
      }
      const before = getMessage(db, normalized.id);
      const result = handleGatewayEvent(db, opts(), 'MESSAGE_CREATE', raw);
      if (result.reason === 'missing_channel') {
        const recovery = deps.onMissingDependency?.({ reason: result.reason, channelId: normalized.channelId, messageId: normalized.id });
        emitOutcome('MESSAGE_CREATE', 'recovery_queued', 'missing_channel', { guildId: normalized.guildId, channelId: normalized.channelId, messageId: normalized.id });
        if (recovery) deps.logger?.warn({ event: 'discord.ingestion_recovery_queued', recoveryId: recovery.recoveryId, generation: String(recovery.generation), channelId: normalized.channelId, messageId: normalized.id }, 'ingestion recovery queued');
      } else if (result.handled) {
        const duplicate = before?.content === normalized.content && before?.author_id === normalized.author.id
          && before?.edited_at_ms === normalized.editedAtMs;
        emitOutcome('MESSAGE_CREATE', duplicate ? 'duplicate' : 'persisted', 'none', { guildId: normalized.guildId, channelId: normalized.channelId, messageId: normalized.id });
      }
      const stored = getMessage(db, normalized.id);
      if (result.handled && stored?.deleted_at_ms === null) deps.onMessageCreate?.(normalized);
    }, 'MESSAGE_CREATE');
  });
  // MESSAGE_UPDATE must use the raw packet. discord.js hydrates omitted fields
  // with defaults, which destroys the Gateway absent/null/present distinction.
  client.on(Events.Raw, (packet) => {
    const raw = packet as { t?: string; d?: unknown };
    if (raw.t === 'MESSAGE_UPDATE') {
      run('messageUpdate', () => handleGatewayEvent(db, opts(), 'MESSAGE_UPDATE', raw.d));
    }
  });
  client.on(Events.MessageDelete, (message) =>
    run('messageDelete', () =>
      handleGatewayEvent(db, opts(), 'MESSAGE_DELETE', {
        id: (message as { id?: string }).id ?? '',
        channel_id: (message as { channelId?: string }).channelId ?? null,
        guild_id: (message as { guildId?: string }).guildId ?? null,
      }),
    ),
  );
  client.on(Events.MessageBulkDelete, (messages, channel) =>
    run('messageDeleteBulk', () =>
      handleGatewayEvent(db, opts(), 'MESSAGE_DELETE_BULK', {
        ids: toIterable<{ id?: string }>(messages).map((x) => x.id ?? ''),
        guild_id: (channel as { guildId?: string | null }).guildId ?? null,
      }),
    ),
  );
  client.on(Events.MessageReactionAdd, (reaction, user) =>
    run('messageReactionAdd', () => {
      const r = rawReactionFromJs(reaction as JsReactionEventLike, user as JsUserLike);
      if (r) {
        const result = handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_ADD', r);
        if (result.reason === 'missing_message' && r.channel_id) {
          const recovery = deps.onMissingDependency?.({ reason: result.reason, channelId: r.channel_id, messageId: r.message_id });
          emitOutcome('MESSAGE_REACTION_ADD', 'recovery_queued', 'missing_message', { guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id });
          if (recovery) deps.logger?.warn({ event: 'discord.ingestion_recovery_queued', recoveryId: recovery.recoveryId, generation: String(recovery.generation), channelId: r.channel_id, messageId: r.message_id }, 'ingestion recovery queued');
        } else if (result.handled) emitOutcome('MESSAGE_REACTION_ADD', 'persisted', 'none', { guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id });
      }
    }),
  );
  client.on(Events.MessageReactionRemove, (reaction, user) =>
    run('messageReactionRemove', () => {
      const r = rawReactionFromJs(reaction as JsReactionEventLike, user as JsUserLike);
      if (r) {
        const result = handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_REMOVE', r);
        if (result.reason === 'missing_message' && r.channel_id) {
          const recovery = deps.onMissingDependency?.({ reason: result.reason, channelId: r.channel_id, messageId: r.message_id });
          emitOutcome('MESSAGE_REACTION_REMOVE', 'recovery_queued', 'missing_message', { guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id });
          if (recovery) deps.logger?.warn({ event: 'discord.ingestion_recovery_queued', recoveryId: recovery.recoveryId, generation: String(recovery.generation), channelId: r.channel_id, messageId: r.message_id }, 'ingestion recovery queued');
        } else if (result.handled) emitOutcome('MESSAGE_REACTION_REMOVE', 'persisted', 'none', { guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id });
      }
    }),
  );
  client.on(Events.MessageReactionRemoveAll, (message) =>
    run('messageReactionRemoveAll', () => handleGatewayEvent(db, opts(), 'MESSAGE_REACTION_REMOVE_ALL', {
      id: (message as { id?: string }).id ?? '',
      guild_id: (message as { guildId?: string | null }).guildId ?? null,
    })),
  );
  client.on(Events.ChannelCreate, (channel) =>
    run('channelCreate', () => {
      const r = rawChannelFromJs(channel as JsChannelLike);
      if (r) {
        const result = handleGatewayEvent(db, opts(), 'CHANNEL_CREATE', r, deps.resolveChannelInput);
        if (result.handled && typeof r.id === 'string') deps.onChannelChange?.('create', r.id);
      }
    }),
  );
  client.on(Events.ChannelUpdate, (_old, channel) =>
    run('channelUpdate', () => {
      const r = rawChannelFromJs(channel as JsChannelLike);
      if (r) {
        const result = handleGatewayEvent(db, opts(), 'CHANNEL_UPDATE', r, deps.resolveChannelInput);
        if (result.handled && typeof r.id === 'string') deps.onChannelChange?.('update', r.id);
      }
    }),
  );
  client.on(Events.ChannelDelete, (channel) =>
    run('channelDelete', () => {
      const r = rawChannelFromJs(channel as JsChannelLike);
      if (r) {
        const result = handleGatewayEvent(db, opts(), 'CHANNEL_DELETE', r);
        if (result.handled && typeof r.id === 'string') deps.onChannelChange?.('delete', r.id);
      }
    }),
  );
  client.on(Events.ThreadCreate, (thread) =>
    run('threadCreate', () => {
      const r = rawChannelFromJs(thread as JsChannelLike);
      if (r) {
        const result = handleGatewayEvent(db, opts(), 'THREAD_CREATE', r, deps.resolveChannelInput);
        if (result.handled && typeof r.id === 'string') deps.onChannelChange?.('create', r.id);
      }
    }),
  );
  client.on(Events.ThreadUpdate, (_old, thread) =>
    run('threadUpdate', () => {
      const r = rawChannelFromJs(thread as JsChannelLike);
      if (r) {
        const result = handleGatewayEvent(db, opts(), 'THREAD_UPDATE', r, deps.resolveChannelInput);
        if (result.handled && typeof r.id === 'string') deps.onChannelChange?.('update', r.id);
      }
    }),
  );
  client.on(Events.ThreadDelete, (thread) =>
    run('threadDelete', () => {
      const r = rawChannelFromJs(thread as JsChannelLike);
      if (r) {
        const result = handleGatewayEvent(db, opts(), 'THREAD_DELETE', r);
        if (result.handled && typeof r.id === 'string') deps.onChannelChange?.('delete', r.id);
      }
    }),
  );
  client.on(Events.ThreadListSync, (threads) =>
    run('threadListSync', () => handleGatewayEvent(db, opts(), 'THREAD_LIST_SYNC', {
      threads: toIterable<JsChannelLike>(threads).map(rawChannelFromJs).filter((x): x is Record<string, unknown> => x !== null),
    }, deps.resolveChannelInput)),
  );
}
