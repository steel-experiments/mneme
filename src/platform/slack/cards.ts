// ABOUTME: Block Kit review cards for proposals and channel-policy reviews, and their Slack ports (spec Section 25).
// ABOUTME: Buttons carry the same signed ids as on Discord; cards go only to a known, unshared review channel.
import type { DatabaseSync } from '../../db/database.js';
import { setProposalReviewMessage } from '../../db/repositories/proposals.js';
import { PermanentJobError } from '../../jobs/errors.js';
import {
  CHANNEL_POLICY_REVIEW_MARKER_PREFIX,
  channelPolicyReviewMarker,
  signChannelPolicyReviewComponent,
  signReviewComponent,
  type ChannelPolicyReviewCard,
  type ChannelPolicyReviewPort,
} from '../../review/controls.js';
import type { ReviewResolver } from '../../review/workflow.js';
import type { ProposalReviewDeliveryDeps, ReviewProposalInput } from '../types.js';
import type { SlackApi, SlackObject } from './api.js';
import { parseSlackMessageId, slackMessageId } from './ids.js';
import { escapeSlackText, toSlackMrkdwn } from './mrkdwn.js';
import { slackSendRefusal } from './sender.js';

/** Slack's limit for the text of one section block. */
export const SECTION_TEXT_MAX_CHARS = 3_000;
/** Slack's limit for one section field. */
const FIELD_TEXT_MAX_CHARS = 2_000;

/** A Slack message payload: fallback text and blocks. */
export interface SlackCardPayload {
  text: string;
  blocks: SlackObject[];
}

/**
 * Shorten converted mrkdwn to `max` characters. The cut never splits a Slack
 * `<…>` token or an `&…;` entity, so a cut cannot leave a broken link.
 */
export function truncateMrkdwn(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  const open = text.lastIndexOf('<', cut);
  if (open !== -1 && text.indexOf('>', open) >= cut) cut = open;
  const amp = text.lastIndexOf('&', cut);
  if (amp !== -1 && amp > cut - 6 && text.indexOf(';', amp) >= cut) cut = amp;
  return `${text.slice(0, cut)}…`;
}

const section = (text: string): SlackObject => ({
  type: 'section', text: { type: 'mrkdwn', text: truncateMrkdwn(text, SECTION_TEXT_MAX_CHARS) },
});
const field = (label: string, value: string): SlackObject => ({
  type: 'mrkdwn', text: truncateMrkdwn(`*${escapeSlackText(label)}*\n${value}`, FIELD_TEXT_MAX_CHARS),
});
const button = (label: string, actionId: string, style?: 'primary' | 'danger'): SlackObject => ({
  type: 'button', text: { type: 'plain_text', text: label }, action_id: actionId, value: actionId, ...(style ? { style } : {}),
});

/** Build the proposal review card (Section 25). Pure. */
export function buildSlackProposalCard(input: ReviewProposalInput, secret: string, teamDomain: string): SlackCardPayload {
  const convert = (text: string): string => toSlackMrkdwn(text, { teamDomain });
  const shortId = input.shortId ?? input.proposalId.slice(0, 8);
  const quoted = (input.proposedMessage || '—').split(/\r\n|\r|\n/).map((line) => (line.length === 0 ? '>' : `> ${line}`)).join('\n');
  const fields: SlackObject[] = [
    field('Target', escapeSlackText(input.targetLabel)),
    input.assessment ? field('Assessment', escapeSlackText(input.assessment)) : field('Score', input.score.toFixed(2)),
  ];
  if (input.recommendationReason) {
    fields.push(field('Recommendation', convert(input.recommendationReason)), field('Routing', convert(input.reason || '—')));
  } else {
    fields.push(field('Reason', convert(input.reason || '—')));
  }
  const blocks: SlackObject[] = [
    { type: 'header', text: { type: 'plain_text', text: `Mneme proposal ${shortId}` } },
    section('Approval inbox: approving queues this exact text to the Target below.'),
    { type: 'section', fields },
    section(`*Proposed message:*\n${convert(quoted)}`),
  ];
  const sources = input.sources.slice(0, 3);
  if (sources.length > 0) blocks.push(section(`*Sources:*\n${sources.map((s) => `• ${convert(s)}`).join('\n')}`));
  if (input.expiresAtMs !== undefined && input.expiresAtMs !== null) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Expires ${new Date(input.expiresAtMs).toISOString()}` }] });
  }
  blocks.push({ type: 'actions', elements: [
    button('Approve', signReviewComponent('approve', input.proposalId, secret), 'primary'),
    button('Dismiss', signReviewComponent('dismiss', input.proposalId, secret)),
  ] });
  return { text: `Mneme proposal ${shortId}`, blocks };
}

/** The `block_id` that marks a channel-policy card for crash recovery (spec Section 10.2). */
export function channelPolicyMarkerBlockId(marker: string): string {
  return `mneme-cpr:${marker.startsWith(CHANNEL_POLICY_REVIEW_MARKER_PREFIX) ? marker.slice(CHANNEL_POLICY_REVIEW_MARKER_PREFIX.length) : marker}`;
}

/** Build the channel-policy review card. Pure. */
export function buildSlackChannelPolicyCard(card: ChannelPolicyReviewCard, secret: string): SlackCardPayload {
  const label = card.channelName ? `#${card.channelName}` : '(unnamed)';
  const parent = card.parentId ? `${card.parentName ? `#${card.parentName} · ` : ''}${card.parentId}` : 'none';
  const marker = channelPolicyReviewMarker(card.reviewId);
  return {
    text: 'New channel needs classification',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'New channel needs classification' } },
      section('Mneme is tracking this channel privately until an administrator classifies it. Interventions remain off for runtime-reviewed channels.'),
      { type: 'section', fields: [
        field('Channel', escapeSlackText(`${label} · ${card.channelId}`)),
        field('Type', escapeSlackText(card.channelKind)),
        field('Parent/category', escapeSlackText(parent)),
      ] },
      { type: 'context', block_id: channelPolicyMarkerBlockId(marker), elements: [{ type: 'mrkdwn', text: escapeSlackText(marker) }] },
      { type: 'actions', elements: [
        button('Track org-wide', signChannelPolicyReviewComponent('org', card.reviewId, secret), 'primary'),
        button('Track privately', signChannelPolicyReviewComponent('restricted', card.reviewId, secret)),
        button('Exclude', signChannelPolicyReviewComponent('excluded', card.reviewId, secret), 'danger'),
      ] },
    ],
  };
}

function assertReviewChannel(db: DatabaseSync, channelId: string): void {
  const refusal = slackSendRefusal(db, channelId);
  if (refusal) throw new PermanentJobError(`slack review card refused: ${refusal}`);
}

function storedMessage(id: string): { channel: string; ts: string } {
  const parsed = parseSlackMessageId(id);
  if (!parsed) throw new PermanentJobError(`not a Slack message id: ${id}`);
  return parsed;
}

export interface SlackCardDeps {
  api: SlackApi;
  db: () => DatabaseSync;
  teamDomain: () => string;
  selfUserId: () => string;
}

/** Post a proposal card to the review channel and record it on the proposal. */
export async function deliverSlackProposalReview(
  input: ReviewProposalInput,
  deps: ProposalReviewDeliveryDeps,
  slack: SlackCardDeps,
): Promise<{ platformMessageId: string }> {
  assertReviewChannel(deps.db, deps.reviewChannelId);
  const payload = buildSlackProposalCard(input, deps.secret, slack.teamDomain());
  const posted = await slack.api.postMessage({ channel: deps.reviewChannelId, ...payload });
  const platformMessageId = slackMessageId(posted.channel, posted.ts);
  setProposalReviewMessage(deps.db, input.proposalId, platformMessageId, deps.now);
  return { platformMessageId };
}

/**
 * Edit a review card to its resolution (Section 25 step 6). With
 * `removeControls`, the card becomes the label alone. Without it, the label is
 * a reply under the card, so the buttons stay.
 */
export function createSlackReviewResolver(api: SlackApi): ReviewResolver {
  return async ({ reviewMessageId, label, removeControls }) => {
    const { channel, ts } = storedMessage(reviewMessageId);
    const text = escapeSlackText(label);
    if (removeControls) await api.update({ channel, ts, text });
    else await api.postMessage({ channel, text, thread_ts: ts });
  };
}

/** The most history pages that one marker search reads (100 messages each). */
const MARKER_SEARCH_PAGES = 5;

/** The channel-policy card port: post, find by marker after a crash, and resolve. */
export function createSlackChannelPolicyPort(slack: SlackCardDeps): ChannelPolicyReviewPort<SlackCardPayload> {
  return {
    async send(channelId, payload) {
      assertReviewChannel(slack.db(), channelId);
      const posted = await slack.api.postMessage({ channel: channelId, ...payload });
      return { id: slackMessageId(posted.channel, posted.ts) };
    },
    async findByMarker(channelId, marker) {
      const blockId = channelPolicyMarkerBlockId(marker);
      let cursor: string | undefined;
      for (let page = 0; page < MARKER_SEARCH_PAGES; page++) {
        const result = await slack.api.history({ channel: channelId, limit: 100, ...(cursor ? { cursor } : {}) });
        for (const m of result.messages) {
          if (m.user !== slack.selfUserId() || typeof m.ts !== 'string' || !Array.isArray(m.blocks)) continue;
          if ((m.blocks as SlackObject[]).some((b) => b.block_id === blockId)) return { id: slackMessageId(channelId, m.ts) };
        }
        if (!result.hasMore || !result.nextCursor) return undefined;
        cursor = result.nextCursor;
      }
      return undefined;
    },
    async resolve(_channelId, messageId, label) {
      const { channel, ts } = storedMessage(messageId);
      await slack.api.update({ channel, ts, text: escapeSlackText(label) });
    },
  };
}
