/**
 * discord.js review-button interaction handler (Sections 6.6, 25).
 *
 * Thin adapter: when a member clicks Approve/Dismiss on a review message, this
 * verifies the button's signed custom id, extracts the actor's
 * resolved roles, gathers the current policy re-check, and funnels the decision
 * through {@link approveProposal} / {@link dismissProposal} — the single place
 * that authorizes, re-validates, records, and enqueues. The handler then replies
 * to the interaction (ephemeral) so the clicker gets feedback without the review
 * channel being spammed.
 *
 * Buttons whose custom id does not verify against `secret` are ignored, so a
 * forged or unrelated component cannot reach the workflow.
 */

import type { Client, ButtonInteraction } from 'discord.js';
import { parseReviewComponent } from './review-message.js';
import { extractMemberRoleIds } from './authorization.js';
import {
  approveProposal,
  dismissProposal,
  type ApprovalPolicyRecheck,
  type ApproveOutcome,
  type DismissOutcome,
  type ReviewResolver,
} from '../../review/workflow.js';
import { type DatabaseSync } from '../../db/database.js';

export interface ReviewInteractionDeps {
  db: DatabaseSync;
  /** HMAC secret shared with {@link signReviewComponent}. */
  secret: string;
  /** Configured admin role ids (`MNEME_ADMIN_ROLE_IDS`). */
  adminRoleIds: readonly string[];
  /**
   * Build the current-state policy re-check for a proposal, gathered from the DB
   * (target/evidence visibility, cooldown, duplicate). The real wiring composes
   * the Section 7.4/24.4 lookups; this dep keeps the handler a pure adapter.
   */
  buildRecheck: (proposalId: string) => ApprovalPolicyRecheck;
  /** Optional review-message editor (Section 25 step 6). */
  resolveReview?: ReviewResolver;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/**
 * Build the discord.js handler for review-button interactions. Returns a
 * function suitable for subscribing to the `interactionCreate` gateway event.
 */
export function createReviewButtonHandler(deps: ReviewInteractionDeps) {
  return async (interaction: ButtonInteraction): Promise<void> => {
    if (!interaction.isButton()) return;
    const parsed = parseReviewComponent(interaction.customId, deps.secret);
    if (!parsed) return; // not one of ours — let another handler (or none) own it

    const guildId = interaction.guildId;
    const actorUserId = interaction.user.id;
    if (!guildId) {
      await replySafe(interaction, 'Mneme review controls only work inside a server.');
      return;
    }

    const memberRoleIds = extractMemberRoleIds(interaction.member);
    const now = (deps.now ?? Date.now)();
    const recheck = deps.buildRecheck(parsed.proposalId);

    if (parsed.action === 'approve') {
      const result = await approveProposal(
        {
          proposalId: parsed.proposalId,
          memberRoleIds,
          adminRoleIds: deps.adminRoleIds,
          actorUserId,
          guildId,
          recheck,
          now,
        },
        { db: deps.db, resolveReview: deps.resolveReview },
      );
      await replySafe(interaction, labelForApprove(result.outcome));
      return;
    }

    const result = await dismissProposal(
      {
        proposalId: parsed.proposalId,
        memberRoleIds,
        adminRoleIds: deps.adminRoleIds,
        actorUserId,
        guildId,
        now,
      },
      { db: deps.db, resolveReview: deps.resolveReview },
    );
    await replySafe(interaction, labelForDismiss(result.outcome));
  };
}

/** Ephemeral reply that never throws (a failed ack must not crash the gateway loop). */
async function replySafe(interaction: ButtonInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true, allowedMentions: { parse: [] } });
    } else {
      await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
    }
  } catch {
    /* the gateway may have timed out the interaction; nothing more to do */
  }
}

function labelForApprove(outcome: ApproveOutcome): string {
  switch (outcome) {
    case 'approved':
      return 'Approved — the message is queued for delivery.';
    case 'unauthorized':
      return 'You are not authorized to approve Mneme proposals.';
    case 'expired':
      return 'This proposal has expired.';
    case 'policy_blocked':
      return 'Not sent — this proposal remains pending review and can be retried after the current policy block clears.';
    case 'stale':
      return 'This proposal has already been resolved.';
    case 'not_found':
      return 'This proposal could not be found.';
  }
}

function labelForDismiss(outcome: DismissOutcome): string {
  switch (outcome) {
    case 'dismissed':
      return 'Proposal dismissed.';
    case 'unauthorized':
      return 'You are not authorized to dismiss Mneme proposals.';
    case 'stale':
      return 'This proposal has already been resolved.';
    case 'not_found':
      return 'This proposal could not be found.';
  }
}

/**
 * discord.js-backed {@link ReviewResolver}: edit the review message to show the
 * resolution label and remove the now-resolved buttons (Section 25 step 6).
 * Failures are swallowed by the workflow; this port only performs the edit.
 */
export function createDiscordReviewResolver(client: Client, reviewChannelId: string): ReviewResolver {
  return async ({ reviewMessageId, label, removeControls }) => {
    const channel = await client.channels.fetch(reviewChannelId, { cache: false, force: true });
    if (!channel || !channel.isTextBased()) return;
    const messages = (channel as { messages?: { fetch(id: string): Promise<{ edit(patch: unknown): Promise<unknown> }> } }).messages;
    if (!messages) return;
    const message = await messages.fetch(reviewMessageId);
    await message.edit({
      content: label,
      ...(removeControls ? { components: [] } : {}),
      allowedMentions: { parse: [] },
    });
  };
}
