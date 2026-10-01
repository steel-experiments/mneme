import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Client } from 'discord.js';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { type DatabaseSync } from '../../db/database.js';
import { setProposalReviewMessage } from '../../db/repositories/proposals.js';

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

/** The two review actions a button can request. */
export type ReviewAction = 'approve' | 'dismiss';

const PREFIX = 'cass';
const VERSION = 'rv';
const SIG_BYTES = 8; // 16 hex chars — 64 bits of signature, well under the 100-char custom_id cap
const EMBED_FIELD_MAX_CHARS = 1024;

function boundedFieldValue(value: string): string {
  if (value.length <= EMBED_FIELD_MAX_CHARS) return value;
  return `${value.slice(0, EMBED_FIELD_MAX_CHARS - 1)}…`;
}

export interface ReviewProposalInput {
  proposalId: string;
  /** Short display id for the embed title (defaults to the proposal id prefix). */
  shortId?: string;
  /** Target channel label, e.g. `#product`. */
  targetLabel: string;
  /** Host-computed intervention score. */
  score: number;
  /** Scheduled reviews use an honest categorical assessment instead of a synthetic score. */
  assessment?: string;
  /** Host-owned routing reason. */
  reason: string;
  /** Optional model recommendation shown separately on secure review surfaces. */
  recommendationReason?: string;
  /** Safe proposed outbound text (already scope-cleared for the target). */
  proposedMessage: string;
  /** Permitted source links (masked), at most three (Section 24.5). */
  sources: readonly string[];
  /** Optional proposal expiry (Section 25: default 72h). */
  expiresAtMs?: number | null;
}

export interface ReviewMessagePayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/** HMAC-SHA256 signature for one (action, proposal) pair, truncated to hex. */
function signature(action: ReviewAction, proposalId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${action}:${proposalId}`)
    .digest('hex')
    .slice(0, SIG_BYTES * 2);
}

/**
 * Build the signed custom_id for a review button. Format:
 * `cass:rv:<action>:<proposalId>:<sig>` — under Discord's 100-char limit for a
 * UUID proposal id.
 */
export function signReviewComponent(
  action: ReviewAction,
  proposalId: string,
  secret: string,
): string {
  return `${PREFIX}:${VERSION}:${action}:${proposalId}:${signature(action, proposalId, secret)}`;
}

export interface ParsedReviewComponent {
  action: ReviewAction;
  proposalId: string;
}

/**
 * Verify and parse a review button's custom_id against `secret`. Returns the
 * parsed action+proposal when the signature matches (constant-time compare), or
 * `undefined` for any malformed, unknown-action, or bad-signature id.
 */
export function parseReviewComponent(
  customId: string,
  secret: string,
): ParsedReviewComponent | undefined {
  const parts = customId.split(':');
  if (parts.length !== 5 || parts[0] !== PREFIX || parts[1] !== VERSION) return undefined;
  const action = parts[2] ?? '';
  const proposalId = parts[3] ?? '';
  const sig = parts[4] ?? '';
  if (action !== 'approve' && action !== 'dismiss') return undefined;
  const expected = signature(action, proposalId, secret);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return { action, proposalId };
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
