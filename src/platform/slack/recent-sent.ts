// ABOUTME: Reads Mneme's own recent Slack messages for outbox crash recovery (spec Section 10.1).
// ABOUTME: Matches each message to its outbox row by the dedupe marker in the message metadata.
import type { RecentSentMessage, RecentSentMessageLookup } from '../../outbox/recovery.js';
import type { SlackApi, SlackObject, SlackPage } from './api.js';
import { slackMessageId, slackTsToMs } from './ids.js';
import { slackTarget, OUTBOX_METADATA_EVENT_TYPE } from './sender.js';

/** The most pages one lookup reads, as on Discord. */
const MAX_PAGES = 100;
const PAGE_SIZE = 200;

function markerOf(message: SlackObject): string | null {
  const metadata = message.metadata as { event_type?: unknown; event_payload?: { marker?: unknown } } | undefined;
  if (metadata?.event_type !== OUTBOX_METADATA_EVENT_TYPE) return null;
  const marker = metadata.event_payload?.marker;
  return typeof marker === 'string' ? marker : null;
}

function isNotFound(err: unknown): boolean {
  const code = (err as { data?: { error?: unknown } } | null)?.data?.error;
  return code === 'channel_not_found' || code === 'not_in_channel' || code === 'thread_not_found';
}

/**
 * Slack recent-message lookup: reads the channel (or the thread, for a thread
 * row) back to `sinceMs` and keeps only messages that Mneme's bot user posted.
 * A message from another bot with the same marker is not Mneme's and is
 * ignored. A missing channel gives an empty list; a lookup that reaches the
 * page limit throws, as on Discord.
 */
export function createSlackRecentSentLookup(api: SlackApi, selfUserId: () => string): RecentSentMessageLookup {
  return {
    async fetch(channelId, sinceMs) {
      const target = slackTarget(channelId);
      const oldest = (Math.floor(sinceMs / 1000) - 1).toFixed(6);
      const self = selfUserId();
      const out: RecentSentMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        let result: SlackPage;
        try {
          result = target.threadTs
            ? await api.replies({ channel: target.channel, ts: target.threadTs, oldest, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) })
            : await api.history({ channel: target.channel, oldest, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        } catch (err) {
          if (isNotFound(err)) return [];
          throw err;
        }
        for (const m of result.messages) {
          const ts = typeof m.ts === 'string' ? m.ts : null;
          if (!ts || m.user !== self) continue;
          const sentAtMs = slackTsToMs(ts);
          if (sentAtMs < sinceMs) continue;
          out.push({ platformMessageId: slackMessageId(target.channel, ts), content: typeof m.text === 'string' ? m.text : '',
            sentAtMs, dedupeMarker: markerOf(m) });
        }
        if (!result.hasMore || !result.nextCursor) return out;
        cursor = result.nextCursor;
      }
      throw new Error('recent-message lookup exceeded its page limit');
    },
  };
}
