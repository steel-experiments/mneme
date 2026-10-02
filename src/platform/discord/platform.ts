// ABOUTME: Composes the Discord adapter pieces into one ChatPlatform (spec Section 5.3).
// ABOUTME: Only this module creates the discord.js client and hands it to the other Discord parts.
import { defaultFetchBytes } from '../../ingestion/attachments.js';
import { isDiscordId } from '../ids.js';
import { createHash } from 'node:crypto';
import { Events, type Client } from 'discord.js';
import type { AppConfig } from '../../config.js';
import { upsertGuild } from '../../db/repositories/workspaces.js';
import type { Logger } from '../../logger.js';
import type { ChatPlatform, PlatformConnection } from '../types.js';
import { assertExpectedGuild, createDiscordClient, registerIngestionHandlers, type ClientHealthTracker } from './client.js';
import { registerGuildCommands } from './commands.js';
import { registerCommandDispatcher } from './command-dispatcher.js';
import { createReviewButtonHandler, createDiscordReviewResolver } from './interactions.js';
import { createDiscordReviewChannel, deliverProposalReview } from './review-message.js';
import {
  createDeliverChannelPolicyReviewHandler,
  createDiscordChannelPolicyReviewPort,
} from './channel-policy-review-message.js';
import { createChannelPolicyReviewButtonHandler } from './channel-policy-review-interactions.js';
import {
  createDiscordMessageFetcher,
  createDiscordThreadArchiveSource,
  fetchDiscoveryDescriptors,
} from './production-adapters.js';
import { createDiscordRecentSentLookup } from './recent-sent.js';
import { createDiscordSender } from './sender.js';
import { normalizeMessage } from './normalize.js';
import { createDiscordIdentityClient } from './oauth-identity.js';
import { discordFormat } from './format.js';

/** Review-card HMAC secret. The derivation keeps cards from earlier runs valid. */
export function discordReviewSecret(token: string): string {
  return createHash('sha256').update(token).update(':review-components').digest('hex');
}

/** Build the Discord platform. The discord.js client is created on `connect`. */
export function createDiscordPlatform(config: AppConfig, logger: Logger, clock: () => number): ChatPlatform {
  const workspaceId = config.workspaceId;
  const discordConfig = config.discord;
  if (!discordConfig) throw new Error('MNEME_PLATFORM=discord requires the Discord settings');
  const token = discordConfig.token;
  let client: Client | undefined;
  let tracker: ClientHealthTracker | undefined;
  const connected = (): Client => {
    if (!client) throw new Error('the Discord platform is not connected');
    return client;
  };

  return {
    id: 'discord',
    workspaceId,
    selfUserId: discordConfig.applicationId,
    reviewSecret: discordReviewSecret(token),
    hasCredentials: Boolean(token),

    async connect(ingestion): Promise<PlatformConnection> {
      const handle = createDiscordClient({ token, guildId: workspaceId, logger, clock });
      client = handle.client;
      tracker = handle.tracker;
      const live = handle.client;
      // Register ingestion handlers BEFORE login so no live event is missed.
      registerIngestionHandlers(live, { ...ingestion, tracker: handle.tracker });
      // Seed the configured guild identity before login so an event arriving in the
      // narrow ready/fetch window cannot violate message foreign keys.
      const seededAt = clock();
      upsertGuild(ingestion.db, {
        id: workspaceId,
        name: config.organization.name,
        ownerId: null,
        joinedAtMs: null,
        discoveredAtMs: seededAt,
        updatedAtMs: seededAt,
        rawJson: null,
      });
      await live.login(token);
      assertExpectedGuild([...live.guilds.cache.keys()], workspaceId);
      const guild = await live.guilds.fetch(workspaceId);
      const observedAt = clock();
      upsertGuild(ingestion.db, {
        id: guild.id,
        // Discord REST/cache hydration may transiently omit otherwise documented
        // guild fields. Never pass `undefined` across the SQLite boundary: Node's
        // built-in driver accepts strings/numbers/null, but rejects undefined.
        name: typeof guild.name === 'string' && guild.name.length > 0
          ? guild.name
          : config.organization.name,
        ownerId: typeof guild.ownerId === 'string' ? guild.ownerId : null,
        joinedAtMs: typeof guild.joinedTimestamp === 'number' ? guild.joinedTimestamp : null,
        discoveredAtMs: observedAt,
        updatedAtMs: observedAt,
        rawJson: config.ingestion.storeRawJson ? JSON.stringify(guild.toJSON()) : null,
      });
      return {
        tracker: handle.tracker,
        destroy: async () => {
          try {
            await live.destroy();
          } catch (err) {
            logger.warn({ event: 'discord.destroy_failed', err: (err as Error).message }, 'discord destroy failed');
          }
        },
      };
    },

    async registerCommands() {
      const rest = client?.rest;
      if (!rest) return { ok: false, message: 'Discord client has no REST adapter; commands cannot be registered' };
      const result = await registerGuildCommands({ rest, applicationId: discordConfig.applicationId, guildId: workspaceId });
      return result.ok ? { ok: true } : { ok: false, message: `Discord command registration failed: ${result.error}` };
    },

    registerCommandDispatch(deps) {
      registerCommandDispatcher({ ...deps, discord: { client: connected(), tracker } });
    },

    registerReviewControls(deps) {
      const live = connected();
      const reviewButtons = createReviewButtonHandler({
        db: deps.db,
        secret: deps.secret,
        adminRoleIds: deps.adminRoleIds,
        buildRecheck: deps.buildRecheck,
        resolveReview: deps.reviewChannelId ? createDiscordReviewResolver(live, deps.reviewChannelId) : undefined,
        now: deps.now,
      });
      const channelPolicyReviewButtons = deps.reviewChannelId
        ? createChannelPolicyReviewButtonHandler({
          db: deps.db,
          guildId: deps.workspaceId,
          secret: deps.secret,
          adminRoleIds: deps.adminRoleIds,
          policy: deps.policy,
          reviewChannelId: deps.reviewChannelId,
          port: createDiscordChannelPolicyReviewPort(live),
          channelPolicySource: deps.channelPolicySource,
          now: deps.now,
        })
        : undefined;
      live.on(Events.InteractionCreate, (interaction) => {
        if (interaction.isButton()) {
          void reviewButtons(interaction);
          if (channelPolicyReviewButtons) void channelPolicyReviewButtons(interaction);
        }
      });
    },

    listChannels: async () => fetchDiscoveryDescriptors(connected(), workspaceId),
    threadDiscovery: {
      mode: 'archive_scan',
      archive: {
        fetchPublicArchived: async (parentId, cursor) => createDiscordThreadArchiveSource(connected()).fetchPublicArchived(parentId, cursor),
        fetchPrivateArchived: async (parentId, cursor) => createDiscordThreadArchiveSource(connected()).fetchPrivateArchived(parentId, cursor),
      },
    },
    history: {
      normalize: normalizeMessage,
      fetchMessages: async (channelId, before, limit) => createDiscordMessageFetcher(connected()).fetchMessages(channelId, before, limit),
      fetchMessage: async (channelId, messageId) => {
        const fetcher = createDiscordMessageFetcher(connected());
        return fetcher.fetchMessage ? fetcher.fetchMessage(channelId, messageId) : null;
      },
    },
    recentSent: {
      fetch: async (channelId, sinceMs) => createDiscordRecentSentLookup(connected(), discordConfig.applicationId).fetch(channelId, sinceMs),
    },

    sender: { send: async (input) => createDiscordSender(connected()).send(input) },
    async sendDirect(userId, text) {
      const user = await connected().users.fetch(userId);
      await user.send({ content: text, allowedMentions: { parse: [] } });
    },
    deliverProposalReview: async (input, deps) =>
      deliverProposalReview(input, { ...deps, channel: createDiscordReviewChannel(connected()) }),
    reviewResolver: (reviewChannelId) => async (resolution) => createDiscordReviewResolver(connected(), reviewChannelId)(resolution),
    createChannelPolicyReviewDeliveryHandler: (deps) => createDeliverChannelPolicyReviewHandler({
      ...deps,
      port: {
        send: async (channelId, payload) => createDiscordChannelPolicyReviewPort(connected()).send(channelId, payload),
        findByMarker: async (channelId, marker) => createDiscordChannelPolicyReviewPort(connected()).findByMarker(channelId, marker),
        resolve: async (channelId, messageId, label) => createDiscordChannelPolicyReviewPort(connected()).resolve(channelId, messageId, label),
      },
    }),

    oauthIdentity: createDiscordIdentityClient({
      clientId: config.mcp.oauthProviderClientId,
      clientSecret: config.mcp.oauthProviderClientSecret,
      publicBaseUrl: config.mcp.publicBaseUrl,
      guildId: workspaceId,
      adminRoleIds: config.adminRoleIds,
    }),
    format: discordFormat,
    fetchBytes: defaultFetchBytes,
    isValidAttachmentId: (id) => isDiscordId(id),
  };
}
