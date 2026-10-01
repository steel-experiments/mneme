import type { ButtonInteraction, Client } from 'discord.js';
import type { DatabaseSync } from '../../db/database.js';
import { transactionImmediate } from '../../db/database.js';
import { recordAdminEvent } from '../../db/repositories/admin-events.js';
import { getChannel } from '../../db/repositories/channels.js';
import {
  decideChannelPolicyReview,
  getChannelPolicyReview,
  type ChannelPolicyReviewDecision,
} from '../../db/repositories/channel-policy-reviews.js';
import { enqueue } from '../../jobs/queue.js';
import type { ChannelPolicySource } from '../../config.js';
import { authorizeAdmin } from '../../policy/authorization.js';
import { extractMemberRoleIds } from './authorization.js';
import { resolveChannel, type ChannelPolicy } from '../../policy/channel-policy.js';
import {
  createDiscordChannelPolicyReviewPort,
  parseChannelPolicyReviewComponent,
  type ChannelPolicyReviewDiscordPort,
} from './channel-policy-review-message.js';
import { REVIEWED_CHANNEL_RULES } from '../../policy/channel-policy-review.js';

export type ChannelPolicyReviewInteractionOutcome =
  | 'decided'
  | 'unauthorized'
  | 'stale'
  | 'not_found'
  /** Basic mode refuses classification cards: the env selection decides (Section 8.4). */
  | 'basic_mode';

export function applyChannelPolicyReviewDecision(input: {
  db: DatabaseSync;
  policy: ChannelPolicy;
  reviewId: string;
  decision: ChannelPolicyReviewDecision;
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  adminRoleIds: readonly string[];
  /** The clicked Discord card proves delivery across the send/DB crash window. */
  deliveredMessageId?: string;
  /**
   * Source the active policy was built from. 'basic' refuses the decision: an
   * approved card would mutate a policy that rebuilds from the environment at
   * the next restart. Omitted or 'file' applies the decision.
   */
  channelPolicySource?: ChannelPolicySource;
  now: number;
}): { outcome: ChannelPolicyReviewInteractionOutcome; reviewMessageId?: string } {
  const authorization = authorizeAdmin(input.memberRoleIds, input.adminRoleIds);
  if (!authorization.authorized) {
    recordAdminEvent(input.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'channel_policy_review',
      target: input.reviewId,
      details: { authorized: false, reason: authorization.reason, decision: input.decision },
      createdAtMs: input.now,
    });
    return { outcome: 'unauthorized' };
  }

  return transactionImmediate(input.db, () => {
    const review = getChannelPolicyReview(input.db, input.reviewId);
    if (!review) {
      recordAdminEvent(input.db, {
        guildId: input.guildId, actorUserId: input.actorUserId,
        action: 'channel_policy_review', target: input.reviewId,
        details: { authorized: true, outcome: 'not_found', decision: input.decision },
        createdAtMs: input.now,
      });
      return { outcome: 'not_found' as const };
    }
    // Basic mode owns classification through the selection lists; a decision
    // here would be undone by the next restart. Refuse before the staleness
    // checks so even a valid card earns the operator-facing explanation.
    if (input.channelPolicySource === 'basic') {
      recordAdminEvent(input.db, {
        guildId: input.guildId, actorUserId: input.actorUserId,
        action: 'channel_policy_review', target: review.id,
        details: { authorized: true, outcome: 'basic_mode', decision: input.decision, channelId: review.channel_id },
        createdAtMs: input.now,
      });
      return { outcome: 'basic_mode' as const, reviewMessageId: review.review_message_id ?? undefined };
    }
    const channel = getChannel(input.db, review.channel_id);
    const parent = channel?.parent_id ? getChannel(input.db, channel.parent_id) : undefined;
    const staticPolicy = channel ? resolveChannel(input.policy, channel.id, {
      isThread: channel.is_thread === 1,
      parentId: channel.is_thread === 1 ? channel.parent_id ?? undefined : undefined,
      categoryId: channel.is_thread === 1 ? parent?.parent_id ?? undefined : channel.parent_id ?? undefined,
    }) : undefined;
    const valid = review.status === 'pending'
      && review.workspace_id === input.guildId
      && channel?.workspace_id === input.guildId
      && channel.deleted_at_ms === null
      && channel.is_thread === 0
      && channel.parent_id === review.observed_parent_id
      && channel.id !== input.policy.review_channel?.id
      && staticPolicy?.source === 'default';
    if (!valid || !channel) {
      recordAdminEvent(input.db, {
        guildId: input.guildId, actorUserId: input.actorUserId,
        action: 'channel_policy_review', target: input.reviewId,
        details: { authorized: true, outcome: 'stale', decision: input.decision, channelId: review.channel_id },
        createdAtMs: input.now,
      });
      return { outcome: 'stale' as const, reviewMessageId: review.review_message_id ?? undefined };
    }
    if (!decideChannelPolicyReview(input.db, {
      reviewId: review.id,
      decision: input.decision,
      actorUserId: input.actorUserId,
      now: input.now,
    })) {
      recordAdminEvent(input.db, {
        guildId: input.guildId, actorUserId: input.actorUserId,
        action: 'channel_policy_review', target: review.id,
        details: { authorized: true, outcome: 'race_lost', decision: input.decision, channelId: channel.id },
        createdAtMs: input.now,
      });
      return { outcome: 'stale' as const, reviewMessageId: review.review_message_id ?? undefined };
    }
    if (input.deliveredMessageId && review.review_message_id === null) {
      input.db.prepare(`UPDATE channel_policy_reviews
        SET delivery_state='sent',review_message_id=?,updated_at_ms=?
        WHERE id=? AND status=? AND review_message_id IS NULL`).run(
        input.deliveredMessageId,
        input.now,
        review.id,
        input.decision,
      );
    }
    const rule = REVIEWED_CHANNEL_RULES[input.decision];
    input.db.prepare(`UPDATE channels SET ingest_enabled=?,visibility_class=?,
      allow_interventions=0,updated_at_ms=? WHERE id=?`).run(
      rule.ingest ? 1 : 0,
      rule.visibility,
      input.now,
      channel.id,
    );
    input.db.prepare(`UPDATE sync_cursors SET state=CASE
      WHEN ?=0 THEN 'excluded'
      WHEN state='excluded' AND history_complete=1 THEN 'live'
      WHEN state='excluded' THEN 'pending'
      ELSE state END,updated_at_ms=? WHERE channel_id=?`).run(
      rule.ingest ? 1 : 0,
      input.now,
      channel.id,
    );
    if (rule.ingest) {
      const cursor = input.db.prepare('SELECT history_complete FROM sync_cursors WHERE channel_id=?')
        .get(channel.id) as { history_complete: number } | undefined;
      if (!cursor || cursor.history_complete !== 1) {
        enqueue(input.db, { type: 'backfill_channel', payload: { channelId: channel.id },
          uniqueKey: `backfill:${channel.id}`, now: input.now });
      }
      enqueue(input.db, { type: 'reconcile_channel', payload: { channelId: channel.id },
        uniqueKey: `reconcile:${channel.id}`, now: input.now });
    } else {
      enqueue(input.db, { type: 'rescope_memories', payload: {}, uniqueKey: 'policy:rescope', now: input.now });
    }
    recordAdminEvent(input.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'channel_policy_review',
      target: review.id,
      details: {
        authorized: true,
        outcome: 'decided',
        decision: input.decision,
        channelId: channel.id,
        previousVisibility: channel.visibility_class,
        visibility: rule.visibility,
      },
      createdAtMs: input.now,
    });
    return {
      outcome: 'decided' as const,
      reviewMessageId: review.review_message_id ?? input.deliveredMessageId,
    };
  });
}

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
    const labels: Record<ChannelPolicyReviewInteractionOutcome, string> = {
      decided: 'Channel classification saved.',
      unauthorized: 'You are not authorized to classify Mneme channels.',
      stale: 'This channel review is stale or already resolved.',
      not_found: 'This channel review could not be found.',
      basic_mode:
        'This deployment selects channels with environment variables, so classification cards are disabled. '
        + 'Change ORG_VISIBLE_CHANNEL_IDS or RESTRICTED_CHANNEL_IDS, or set CHANNEL_POLICY_SOURCE=file, then restart Mneme.',
    };
    await replySafe(interaction, labels[result.outcome]);
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
