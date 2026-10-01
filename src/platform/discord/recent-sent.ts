// ABOUTME: Reads Mneme's own recent Discord messages for outbox crash recovery.
// ABOUTME: Matches each message to its outbox row by the Discord nonce (Section 10.1).
import type { Client } from 'discord.js';
import type { RecentSentMessage, RecentSentMessageLookup } from '../../outbox/recovery.js';

/**
 * discord.js-backed recent-message lookup: fetches up to 50 recent messages in
 * the channel and keeps only Mneme's own, within the window. Returns an empty
 * list (not a throw) for a missing or non-text channel — absence is a legitimate
 * "no match" outcome, not a lookup failure.
 */
export function createDiscordRecentSentLookup(
  client: Client,
  mnemeId: string,
): RecentSentMessageLookup {
  return {
    async fetch(channelId, sinceMs) {
      const channel = await client.channels.fetch(channelId, { cache: false });
      if (!channel || !channel.isTextBased()) return [];
      const out: RecentSentMessage[] = [];
      let before: string | undefined;
      let complete = false;
      for (let page = 0; page < 100; page++) {
        const fetched = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (fetched.size === 0) {
          complete = true;
          break;
        }
        let reachedBoundary = false;
        for (const m of fetched.values()) {
          if (typeof m.createdTimestamp === 'number' && m.createdTimestamp < sinceMs) {
            reachedBoundary = true;
            continue;
          }
          if (m.author?.id !== mnemeId) continue;
          out.push({ platformMessageId: m.id, content: m.content, sentAtMs: m.createdTimestamp,
            dedupeMarker: m.nonce == null ? null : String(m.nonce) });
        }
        if (reachedBoundary || fetched.size < 100) {
          complete = true;
          break;
        }
        before = fetched.last()?.id;
        if (!before) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new Error('recent-message lookup exceeded its page limit');
      return out;
    },
  };
}
