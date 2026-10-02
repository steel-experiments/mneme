// ABOUTME: The small Slack Web API surface the adapter uses, with Retry-After handling.
// ABOUTME: Tests replace this interface with recorded responses; no test opens a network connection.
import { WebClient } from '@slack/web-api';

/** A Slack message or conversation object as the Web API returns it. */
export type SlackObject = Record<string, unknown>;

export interface SlackPage {
  messages: SlackObject[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** The Web API methods the adapter calls. Each call obeys `Retry-After` on a 429. */
export interface SlackApi {
  authTest(): Promise<{ teamId: string; userId: string; url: string }>;
  listConversations(cursor: string | undefined): Promise<{ channels: SlackObject[]; nextCursor: string | null }>;
  conversationInfo(channel: string): Promise<SlackObject | null>;
  history(input: { channel: string; latest?: string; oldest?: string; inclusive?: boolean; limit: number; cursor?: string }): Promise<SlackPage>;
  replies(input: { channel: string; ts: string; latest?: string; oldest?: string; inclusive?: boolean; limit: number; cursor?: string }): Promise<SlackPage>;
}

/** The most retries for one request after a rate limit (spec Section 9.5). */
export const MAX_RATE_LIMIT_RETRIES = 5;

interface RateLimitedLike {
  code?: unknown;
  retryAfter?: unknown;
}

function retryAfterMs(err: unknown): number | null {
  const e = err as RateLimitedLike | null;
  if (!e || e.code !== 'slack_webapi_rate_limited_error') return null;
  const seconds = typeof e.retryAfter === 'number' && e.retryAfter > 0 ? e.retryAfter : 1;
  return seconds * 1000;
}

/**
 * Run one call. A rate limit waits for `Retry-After` and tries again, at most
 * {@link MAX_RATE_LIMIT_RETRIES} times; then the error goes to the job retry.
 */
export async function withRateLimitRetry<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      const wait = retryAfterMs(err);
      if (wait === null || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
      await sleep(wait);
    }
  }
}

function page(res: { messages?: unknown; has_more?: unknown; response_metadata?: { next_cursor?: unknown } }): SlackPage {
  const next = res.response_metadata?.next_cursor;
  return {
    messages: Array.isArray(res.messages) ? res.messages as SlackObject[] : [],
    hasMore: res.has_more === true,
    nextCursor: typeof next === 'string' && next.length > 0 ? next : null,
  };
}

/** Build the production API over one bot-token `WebClient`. */
export function createSlackApi(botToken: string): SlackApi {
  // Rate limits come back as errors so withRateLimitRetry owns the wait and the bound.
  const web = new WebClient(botToken, { rejectRateLimitedCalls: true, retryConfig: { retries: 2 } });
  return {
    async authTest() {
      const res = await withRateLimitRetry(() => web.auth.test());
      return { teamId: String(res.team_id ?? ''), userId: String(res.user_id ?? ''), url: String(res.url ?? '') };
    },
    async listConversations(cursor) {
      const res = await withRateLimitRetry(() => web.conversations.list({
        types: 'public_channel,private_channel', exclude_archived: false, limit: 200, ...(cursor ? { cursor } : {}),
      }));
      const next = res.response_metadata?.next_cursor;
      return {
        channels: (res.channels ?? []) as SlackObject[],
        nextCursor: typeof next === 'string' && next.length > 0 ? next : null,
      };
    },
    async conversationInfo(channel) {
      try {
        const res = await withRateLimitRetry(() => web.conversations.info({ channel }));
        return (res.channel ?? null) as SlackObject | null;
      } catch (err) {
        const code = (err as { data?: { error?: unknown } }).data?.error;
        if (code === 'channel_not_found' || code === 'not_in_channel') return null;
        throw err;
      }
    },
    async history(input) {
      return page(await withRateLimitRetry(() => web.conversations.history({ ...input, include_all_metadata: true })));
    },
    async replies(input) {
      return page(await withRateLimitRetry(() => web.conversations.replies({ ...input, include_all_metadata: true })));
    },
  };
}
