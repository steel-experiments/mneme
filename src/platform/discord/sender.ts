import type { Client, Snowflake } from 'discord.js';

/**
 * Outbound Discord delivery port (Sections 10.1, 24.5).
 *
 * The outbox sender calls this to deliver one message. It is an interface so the
 * send path can be tested with a fake sender and so the discord.js binding lives
 * in exactly one place. Discord message creation is at-least-once with no
 * idempotency key (Section 9.1); the outbox `dedupe_key` and the sending-state
 * crash recovery (Section 10.1) make storage effectively-once.
 */

export interface SendOutboxMessageInput {
  channelId: string;
  content: string;
  /** Reply anchor in the target channel, when one was validated upstream. */
  replyToMessageId?: string | null;
  /** Stable Discord nonce used only for crash reconciliation. */
  dedupeMarker?: string | null;
}

export interface SendResult {
  /** The platform id of the created message. */
  platformMessageId: string;
}

/** Deliver one outbox message to Discord. Throws on any delivery failure. */
export interface OutboxSender {
  send(input: SendOutboxMessageInput): Promise<SendResult>;
}

/**
 * discord.js-backed sender (Section 24.5):
 *   - disables all automatic mentions via `allowedMentions.parse = []`;
 *   - sends as a reply when a validated anchor is present;
 *   - fetches the channel fresh (no cache) so a reclassified or deleted channel
 *     surfaces as an error instead of posting from a stale cache.
 *
 * Errors are left for the caller to classify (Section 10): discord.js REST
 * errors carry a numeric `status`/`code` that {@link classifyError} maps to
 * permanent (401/403, missing access) or transient (429, 5xx, network).
 */
export function createDiscordSender(client: Client): OutboxSender {
  return {
    async send(input) {
      const channel = await client.channels.fetch(input.channelId, {
        cache: false,
        force: true,
      });
      if (!channel || !channel.isSendable()) {
        throw new Error(`outbox target channel ${input.channelId} is not sendable`);
      }
      const message = await channel.send({
        content: input.content,
        allowedMentions: { parse: [] },
        ...(input.dedupeMarker ? { nonce: input.dedupeMarker, enforceNonce: true } : {}),
        ...(input.replyToMessageId
          ? { reply: { messageReference: input.replyToMessageId as Snowflake } }
          : {}),
      });
      return { platformMessageId: message.id };
    },
  };
}
