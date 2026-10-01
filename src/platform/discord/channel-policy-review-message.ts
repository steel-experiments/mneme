import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Client } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { DatabaseSync } from '../../db/database.js';
import { transaction } from '../../db/database.js';
import { getChannel } from '../../db/repositories/channels.js';
import { discordTypeOfKind } from './channel-types.js';
import {
  getChannelPolicyReview,
  markChannelPolicyReviewDeliveryFailed,
  markChannelPolicyReviewSending,
  markChannelPolicyReviewSent,
} from '../../db/repositories/channel-policy-reviews.js';
import { TransientJobError } from '../../jobs/errors.js';
import type { JobHandler } from '../../jobs/worker.js';

export type ChannelPolicyReviewAction = 'org' | 'restricted' | 'excluded';
const PREFIX = 'cass';
const VERSION = 'cp';
const SIG_BYTES = 8;
export const CHANNEL_POLICY_REVIEW_MARKER_PREFIX = 'Mneme channel review ';

function signature(action: ChannelPolicyReviewAction, reviewId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${VERSION}:${action}:${reviewId}`)
    .digest('hex')
    .slice(0, SIG_BYTES * 2);
}

export function signChannelPolicyReviewComponent(
  action: ChannelPolicyReviewAction,
  reviewId: string,
  secret: string,
): string {
  return `${PREFIX}:${VERSION}:${action}:${reviewId}:${signature(action, reviewId, secret)}`;
}

export function parseChannelPolicyReviewComponent(
  customId: string,
  secret: string,
): { action: ChannelPolicyReviewAction; reviewId: string } | undefined {
  const parts = customId.split(':');
  if (parts.length !== 5 || parts[0] !== PREFIX || parts[1] !== VERSION) return undefined;
  const action = parts[2];
  const reviewId = parts[3] ?? '';
  const supplied = parts[4] ?? '';
  if (action !== 'org' && action !== 'restricted' && action !== 'excluded') return undefined;
  const expected = signature(action, reviewId, secret);
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  return { action, reviewId };
}

export function channelPolicyReviewMarker(reviewId: string): string {
  return `${CHANNEL_POLICY_REVIEW_MARKER_PREFIX}${reviewId}`;
}

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

export interface ChannelPolicyReviewDiscordPort {
  send(channelId: string, payload: ReturnType<typeof buildChannelPolicyReviewCard>): Promise<{ id: string }>;
  findByMarker(channelId: string, marker: string): Promise<{ id: string } | undefined>;
  resolve(channelId: string, messageId: string, label: string): Promise<void>;
}

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
  return async ({ reviewId }) => {
    let review = getChannelPolicyReview(deps.db, reviewId);
    if (!review || review.status !== 'pending' || review.delivery_state === 'sent') return;
    const marker = channelPolicyReviewMarker(review.id);
    if (review.delivery_state === 'sending') {
      const found = await deps.port.findByMarker(deps.reviewChannelId, marker);
      if (found) {
        transaction(deps.db, () => markChannelPolicyReviewSent(deps.db, reviewId, found.id, deps.now()));
        return;
      }
      transaction(deps.db, () => markChannelPolicyReviewDeliveryFailed(deps.db, reviewId, deps.now()));
      review = getChannelPolicyReview(deps.db, reviewId);
    }
    if (!review || review.status !== 'pending') return;
    const channel = getChannel(deps.db, review.channel_id);
    if (!channel || channel.deleted_at_ms !== null || channel.is_thread === 1) return;
    const parent = channel.parent_id ? getChannel(deps.db, channel.parent_id) : undefined;
    const claimed = transaction(deps.db, () => markChannelPolicyReviewSending(deps.db, reviewId, deps.now()));
    if (!claimed) return;
    const payload = buildChannelPolicyReviewCard({
      reviewId,
      channelId: channel.id,
      channelName: channel.name,
      channelType: discordTypeOfKind(channel.kind) ?? channel.kind,
      parentId: channel.parent_id,
      parentName: parent?.name ?? null,
    }, deps.secret);
    let sent: { id: string };
    try {
      sent = await deps.port.send(deps.reviewChannelId, payload);
    } catch (cause) {
      transaction(deps.db, () => markChannelPolicyReviewDeliveryFailed(deps.db, reviewId, deps.now()));
      throw new TransientJobError('channel policy review card delivery failed', { cause });
    }
    // Deliberately outside the send catch: if SQLite fails after Discord accepted
    // the card, leave `sending` intact so marker recovery prevents a duplicate.
    const recorded = transaction(
      deps.db,
      () => markChannelPolicyReviewSent(deps.db, reviewId, sent.id, deps.now()),
    );
    if (!recorded) return;
    const afterSend = getChannelPolicyReview(deps.db, reviewId);
    if (afterSend && (afterSend.status === 'org' || afterSend.status === 'restricted' || afterSend.status === 'excluded')) {
      try {
        await deps.port.resolve(
          deps.reviewChannelId,
          sent.id,
          `Channel classification saved: ${afterSend.status}.`,
        );
      } catch {
        // The durable decision remains authoritative; this edit is cosmetic.
      }
    }
  };
}
