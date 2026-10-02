import type { Client } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { DatabaseSync } from '../../db/database.js';
import { discordTypeOfKind } from './channel-types.js';
import type { JobHandler } from '../../jobs/worker.js';
import {
  channelPolicyReviewMarker,
  createChannelPolicyReviewDeliveryHandler,
  signChannelPolicyReviewComponent,
  type ChannelPolicyReviewPort,
} from '../../review/controls.js';

export {
  CHANNEL_POLICY_REVIEW_MARKER_PREFIX,
  channelPolicyReviewMarker,
  parseChannelPolicyReviewComponent,
  signChannelPolicyReviewComponent,
  type ChannelPolicyReviewAction,
} from '../../review/controls.js';

export interface ChannelPolicyReviewCardInput {
  reviewId: string;
  channelId: string;
  channelName: string | null;
  /** Discord channel type number, or the neutral kind when Discord has no number for it. */
  channelType: number | string;
  parentId: string | null;
  parentName: string | null;
}

export function buildChannelPolicyReviewCard(input: ChannelPolicyReviewCardInput, secret: string) {
  const channelLabel = input.channelName ? `#${input.channelName}` : '(unnamed)';
  const parent = input.parentId
    ? `${input.parentName ? `#${input.parentName} · ` : ''}${input.parentId}`
    : 'none';
  const embed = new EmbedBuilder()
    .setTitle('New channel needs classification')
    .setDescription('Mneme is tracking this channel privately until an administrator classifies it. Interventions remain off for runtime-reviewed channels.')
    .addFields(
      { name: 'Channel', value: `${channelLabel} · ${input.channelId}`, inline: false },
      { name: 'Type', value: String(input.channelType), inline: true },
      { name: 'Parent/category', value: parent, inline: false },
    )
    .setColor(0xfee75c)
    .setFooter({ text: channelPolicyReviewMarker(input.reviewId) });
  const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(signChannelPolicyReviewComponent('org', input.reviewId, secret))
      .setLabel('Track org-wide')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(signChannelPolicyReviewComponent('restricted', input.reviewId, secret))
      .setLabel('Track privately')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(signChannelPolicyReviewComponent('excluded', input.reviewId, secret))
      .setLabel('Exclude')
      .setStyle(ButtonStyle.Danger),
  )];
  return { embeds: [embed], components };
}

export type ChannelPolicyReviewDiscordPort = ChannelPolicyReviewPort<ReturnType<typeof buildChannelPolicyReviewCard>>;

export function createDiscordChannelPolicyReviewPort(client: Client): ChannelPolicyReviewDiscordPort {
  async function sendable(channelId: string) {
    const channel = await client.channels.fetch(channelId, { cache: false, force: true });
    if (!channel || !channel.isSendable()) throw new Error(`review channel ${channelId} is not sendable`);
    return channel;
  }
  return {
    async send(channelId, payload) {
      const channel = await sendable(channelId);
      const message = await channel.send({ embeds: payload.embeds, components: payload.components });
      return { id: message.id };
    },
    async findByMarker(channelId, marker) {
      const channel = await sendable(channelId);
      if (!channel.isTextBased() || !('messages' in channel)) return undefined;
      const messages = await channel.messages.fetch({ limit: 100 });
      for (const message of messages.values()) {
        if (client.user && message.author.id !== client.user.id) continue;
        if (message.embeds.some((embed) => embed.footer?.text === marker)) return { id: message.id };
      }
      return undefined;
    },
    async resolve(channelId, messageId, label) {
      const channel = await sendable(channelId);
      if (!channel.isTextBased() || !('messages' in channel)) return;
      const message = await channel.messages.fetch(messageId);
      await message.edit({ content: label, components: [], allowedMentions: { parse: [] } });
    },
  };
}

export function createDeliverChannelPolicyReviewHandler(deps: {
  db: DatabaseSync;
  reviewChannelId: string;
  port: ChannelPolicyReviewDiscordPort;
  secret: string;
  now: () => number;
}): JobHandler<'deliver_channel_policy_review'> {
  return createChannelPolicyReviewDeliveryHandler({
    ...deps,
    build: (card, secret) => buildChannelPolicyReviewCard({
      reviewId: card.reviewId,
      channelId: card.channelId,
      channelName: card.channelName,
      channelType: discordTypeOfKind(card.channelKind) ?? card.channelKind,
      parentId: card.parentId,
      parentName: card.parentName,
    }, secret),
  });
}
