import type { Client } from 'discord.js';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { type DatabaseSync } from '../../db/database.js';
import { setProposalReviewMessage } from '../../db/repositories/proposals.js';
import type { ReviewProposalInput } from '../types.js';
import { signReviewComponent } from '../../review/controls.js';

export {
  parseReviewComponent,
  signReviewComponent,
  type ParsedReviewComponent,
  type ReviewAction,
} from '../../review/controls.js';

/**
 * Secure-channel review proposal message (Section 25).
 *
 * In `review` mode, a pending proposal is posted to the configured secure review
 * channel as one auditable embed with target, score, reason, the safe proposed
 * text, and permitted source links, plus Approve/Dismiss buttons. The buttons
 * carry HMAC-signed custom ids so the interaction handler can verify
 * each click was issued by Mneme for that exact proposal — a forged id that
 * merely names a proposal cannot approve it.
 *
 * Only content already cleared for the secure-channel scope appears; the review
 * channel accepts all scopes (Section 7.3), so the proposed text and sources are
 * shown verbatim. Nothing is hidden outside the channel: no secrets, credentials,
 * or prompt text are embedded.
 */

const EMBED_FIELD_MAX_CHARS = 1024;

function boundedFieldValue(value: string): string {
  if (value.length <= EMBED_FIELD_MAX_CHARS) return value;
  return `${value.slice(0, EMBED_FIELD_MAX_CHARS - 1)}…`;
}


export interface ReviewMessagePayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/**
 * Build the review embed and Approve/Dismiss button row for one proposal. Pure:
 * no Discord or database access, so the rendered shape is unit-testable.
 */
export function buildReviewMessage(
  input: ReviewProposalInput,
  secret: string,
): ReviewMessagePayload {
  const shortId = input.shortId ?? input.proposalId.slice(0, 8);
  const sources = input.sources.slice(0, 3);

  const quotedMessage = (input.proposedMessage || '—')
    .split(/\r\n|\r|\n/)
    // Empty lines need only the quote marker. Avoiding a trailing space keeps
    // even a maximally newline-heavy 1,800-character proposal under Discord's
    // 4,096-character embed-description limit.
    .map((line) => line.length === 0 ? '>' : `> ${line}`);
  const descriptionLines = [
    'Approval inbox: approving queues this exact text to the Target below.',
    '',
    'Proposed message:',
    ...quotedMessage,
  ];
  if (sources.length > 0) {
    descriptionLines.push('', 'Sources:', ...sources.map((s) => `- ${s}`));
  }

  const scoreOrAssessment = input.assessment
    ? { name: 'Assessment', value: input.assessment, inline: true }
    : { name: 'Score', value: input.score.toFixed(2), inline: true };

  const reasonFields = input.recommendationReason
    ? [
        {
          name: 'Recommendation',
          value: boundedFieldValue(input.recommendationReason),
          inline: false,
        },
        {
          name: 'Routing',
          value: boundedFieldValue(input.reason || '—'),
          inline: false,
        },
      ]
    : [{ name: 'Reason', value: boundedFieldValue(input.reason || '—'), inline: true }];

  const embed = new EmbedBuilder()
    .setTitle(`Mneme proposal ${shortId}`)
    .setDescription(descriptionLines.join('\n'))
    .addFields(
      { name: 'Target', value: input.targetLabel, inline: true },
      scoreOrAssessment,
      ...reasonFields,
    )
    .setColor(0x5865f2);

  if (input.expiresAtMs !== undefined && input.expiresAtMs !== null) {
    embed.setFooter({ text: `Expires ${new Date(input.expiresAtMs).toISOString()}` });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(signReviewComponent('approve', input.proposalId, secret))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(signReviewComponent('dismiss', input.proposalId, secret))
      .setLabel('Dismiss')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

/** Port for posting a review message to the secure review channel. */
export interface ReviewChannel {
  send(channelId: string, payload: ReviewMessagePayload): Promise<{ platformMessageId: string }>;
}

/** discord.js-backed review channel sender. */
export function createDiscordReviewChannel(client: Client): ReviewChannel {
  return {
    async send(channelId, payload) {
      const channel = await client.channels.fetch(channelId, { cache: false, force: true });
      if (!channel || !channel.isSendable()) {
        throw new Error(`review channel ${channelId} is not sendable`);
      }
      const message = await channel.send({
        embeds: payload.embeds,
        components: payload.components,
      });
      return { platformMessageId: message.id };
    },
  };
}

export interface DeliverProposalReviewDeps {
  db: DatabaseSync;
  reviewChannelId: string;
  channel: ReviewChannel;
  /** HMAC secret shared with the interaction handler (never logged). */
  secret: string;
  now: number;
}

/**
 * Build and post a proposal's review message to the secure review channel, then
 * record the review Discord message id on the proposal (Section 25). Returns the
 * posted message id. The proposal status is unchanged (still `pending_review`);
 * approval/dismissal sets the reviewed_* fields.
 */
export async function deliverProposalReview(
  input: ReviewProposalInput,
  deps: DeliverProposalReviewDeps,
): Promise<{ platformMessageId: string }> {
  const payload = buildReviewMessage(input, deps.secret);
  const { platformMessageId } = await deps.channel.send(deps.reviewChannelId, payload);
  setProposalReviewMessage(deps.db, input.proposalId, platformMessageId, deps.now);
  return { platformMessageId };
}
