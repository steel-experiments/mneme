import type { ButtonInteraction, Client } from 'discord.js';
import type { DatabaseSync } from '../../db/database.js';
import { recordAdminEvent } from '../../db/repositories/admin-events.js';
import type { ChannelPolicySource } from '../../config.js';
import { extractMemberRoleIds } from './authorization.js';
import type { ChannelPolicy } from '../../policy/channel-policy.js';
import {
  createDiscordChannelPolicyReviewPort,
  parseChannelPolicyReviewComponent,
  type ChannelPolicyReviewDiscordPort,
} from './channel-policy-review-message.js';
import { applyChannelPolicyReviewDecision, CHANNEL_POLICY_REVIEW_LABELS } from '../../review/controls.js';

export {
  applyChannelPolicyReviewDecision,
  type ChannelPolicyReviewInteractionOutcome,
} from '../../review/controls.js';

export function createChannelPolicyReviewButtonHandler(deps: {
  db: DatabaseSync;
  guildId: string;
  secret: string;
  adminRoleIds: readonly string[];
  policy: () => ChannelPolicy;
  reviewChannelId: string;
  port: ChannelPolicyReviewDiscordPort;
  /** Policy source; 'basic' makes every card click answer with the restart notice. */
  channelPolicySource?: ChannelPolicySource;
  now?: () => number;
}) {
  return async (interaction: ButtonInteraction): Promise<void> => {
    if (!interaction.isButton()) return;
    const parsed = parseChannelPolicyReviewComponent(interaction.customId, deps.secret);
    if (!parsed) return;
    if (!interaction.guildId) {
      await replySafe(interaction, 'Mneme channel controls only work inside a server.');
      return;
    }
    if (interaction.guildId !== deps.guildId) {
      recordAdminEvent(deps.db, {
        guildId: deps.guildId,
        actorUserId: interaction.user.id,
        action: 'channel_policy_review',
        target: parsed.reviewId,
        details: {
          authorized: false,
          outcome: 'foreign_guild',
          decision: parsed.action,
          interactionGuildId: interaction.guildId,
        },
        createdAtMs: (deps.now ?? Date.now)(),
      });
      await replySafe(interaction, 'This channel review does not belong to this server.');
      return;
    }
    if (interaction.channelId !== deps.reviewChannelId) {
      recordAdminEvent(deps.db, {
        guildId: deps.guildId,
        actorUserId: interaction.user.id,
        action: 'channel_policy_review',
        target: parsed.reviewId,
        details: {
          authorized: false,
          outcome: 'foreign_channel',
          decision: parsed.action,
          interactionChannelId: interaction.channelId,
        },
        createdAtMs: (deps.now ?? Date.now)(),
      });
      await replySafe(interaction, 'This control is not in Mneme’s secure review channel.');
      return;
    }
    const result = applyChannelPolicyReviewDecision({
      db: deps.db,
      policy: deps.policy(),
      reviewId: parsed.reviewId,
      decision: parsed.action,
      actorUserId: interaction.user.id,
      guildId: deps.guildId,
      memberRoleIds: extractMemberRoleIds(interaction.member),
      adminRoleIds: deps.adminRoleIds,
      deliveredMessageId: interaction.message.id,
      channelPolicySource: deps.channelPolicySource,
      now: (deps.now ?? Date.now)(),
    });
    if (result.outcome === 'decided' && result.reviewMessageId) {
      try {
        await deps.port.resolve(
          deps.reviewChannelId,
          result.reviewMessageId,
          `Channel classification saved: ${parsed.action}.`,
        );
      } catch {
        // Durable decision is authoritative; a cosmetic edit is best effort.
      }
    }
    await replySafe(interaction, CHANNEL_POLICY_REVIEW_LABELS[result.outcome]);
  };
}

async function replySafe(interaction: ButtonInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true, allowedMentions: { parse: [] } });
    } else {
      await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
    }
  } catch {
    // Interaction acknowledgement is best effort.
  }
}

export function createDefaultChannelPolicyReviewPort(client: Client) {
  return createDiscordChannelPolicyReviewPort(client);
}
