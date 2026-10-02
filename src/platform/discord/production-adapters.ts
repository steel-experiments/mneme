import {
  PermissionFlagsBits,
  type Client,
  type GuildBasedChannel,
} from 'discord.js';
import type { BackfillMessageFetcher } from '../../ingestion/backfill.js';
import { PRIVATE_THREAD, channelKindOf } from './channel-types.js';
import { rawMessageFromJs } from './client.js';
import { normalizeMessage } from './normalize.js';
import type { DiscoveredChannelDescriptor } from '../../ingestion/discovery.js';
import type { ThreadArchiveSource, ArchivedThreadPage } from '../../ingestion/threads.js';

/** Convert a discord.js channel into the plain, fail-closed discovery shape. */
export function descriptorFromDiscord(channel: GuildBasedChannel): DiscoveredChannelDescriptor {
  const member = channel.guild.members.me;
  const permissions = member ? channel.permissionsFor(member) : null;
  const thread = channel.isThread();
  return {
    id: channel.id,
    parentId: 'parentId' in channel ? channel.parentId : null,
    kind: channelKindOf(channel.type),
    isPrivateThread: channel.type === PRIVATE_THREAD,
    name: 'name' in channel ? channel.name : null,
    topic: 'topic' in channel ? channel.topic : null,
    position: 'position' in channel ? channel.position : null,
    archived: thread ? channel.archived ?? false : false,
    locked: thread ? channel.locked ?? false : false,
    lastMessageId: 'lastMessageId' in channel ? channel.lastMessageId : null,
    capabilities: {
      canView: permissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
      canReadHistory: permissions?.has(PermissionFlagsBits.ReadMessageHistory) ?? false,
      canSend: permissions?.has(PermissionFlagsBits.SendMessages) ?? false,
      canSendInThreads: permissions?.has(PermissionFlagsBits.SendMessagesInThreads) ?? false,
      canManageThreads: permissions?.has(PermissionFlagsBits.ManageThreads) ?? false,
    },
  };
}

/** Fetch the complete guild channel cache plus active threads from Discord. */
export async function fetchDiscoveryDescriptors(client: Client, guildId: string): Promise<DiscoveredChannelDescriptor[]> {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const active = await guild.channels.fetchActiveThreads();
  const byId = new Map<string, DiscoveredChannelDescriptor>();
  for (const channel of channels.values()) {
    if (channel) byId.set(channel.id, descriptorFromDiscord(channel));
  }
  for (const thread of active.threads.values()) {
    byId.set(thread.id, descriptorFromDiscord(thread));
  }
  return [...byId.values()];
}

/** discord.js message pagination adapter used by backfill and reconciliation. */
export function createDiscordMessageFetcher(client: Client): BackfillMessageFetcher {
  return {
    normalize: normalizeMessage,
    async fetchMessages(channelId, before, limit) {
      const channel = await client.channels.fetch(channelId, { cache: false, force: true });
      if (!channel || !channel.isTextBased() || !('messages' in channel)) return [];
      const page = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
      return [...page.values()].map((message) => rawMessageFromJs(message as unknown as Parameters<typeof rawMessageFromJs>[0]));
    },
    async fetchMessage(channelId, messageId) {
      const channel = await client.channels.fetch(channelId, { cache: false, force: true });
      if (!channel || !channel.isTextBased() || !('messages' in channel)) return null;
      const message = await channel.messages.fetch(messageId);
      return rawMessageFromJs(message as unknown as Parameters<typeof rawMessageFromJs>[0]);
    },
  };
}

/** discord.js archived-thread pagination adapter. */
export function createDiscordThreadArchiveSource(client: Client): ThreadArchiveSource {
  const fetchPage = async (
    parentId: string,
    cursor: string | undefined,
    type: 'public' | 'private',
  ): Promise<ArchivedThreadPage> => {
    const channel = await client.channels.fetch(parentId, { cache: false, force: true });
    if (!channel || !('threads' in channel)) return { threads: [], hasMore: false };
    const manager = channel.threads as unknown as {
      fetchArchived(options: { type: 'public' | 'private'; before?: string; limit: number; fetchAll?: boolean }): Promise<{
        threads: Map<string, GuildBasedChannel>;
        hasMore?: boolean;
      }>;
    };
    const guildChannel = channel as unknown as {
      guild?: { members?: { me?: unknown } };
      permissionsFor?: (member: unknown) => { has(flag: bigint): boolean } | null;
    };
    const member = guildChannel.guild?.members?.me;
    const canManageThreads = member
      ? guildChannel.permissionsFor?.(member)?.has(PermissionFlagsBits.ManageThreads) === true
      : false;
    const page = await manager.fetchArchived({ type, limit: 100,
      ...(type === 'private' && canManageThreads ? { fetchAll: true } : {}),
      ...(cursor ? { before: cursor } : {}) });
    return {
      threads: [...page.threads.values()].map(descriptorFromDiscord),
      hasMore: page.hasMore === true,
    };
  };
  return {
    fetchPublicArchived: (parentId, cursor) => fetchPage(parentId, cursor, 'public'),
    fetchPrivateArchived: (parentId, cursor) => fetchPage(parentId, cursor, 'private'),
  };
}
