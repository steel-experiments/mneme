/**
 * Per-token MCP request rate limiting (Section 32.5.4; task T100).
 *
 * Section 32.5.4 sets a per-token limit of `60` requests per minute; excess
 * returns `429`. Mneme is one process, so a bounded in-process limiter is
 * sufficient and avoids extra infrastructure: a fixed window per token id, held
 * in a `Map` that is pruned of stale windows on demand. The window is keyed on
 * the authenticated token id (never the plaintext token), so the limiter state
 * holds no credential material.
 *
 * The limiter is intentionally injectable: {@link authenticateMcpRequest} takes a
 * `RateLimiter`, letting tests use a tiny window/limit and the server bind the
 * configured `MCP_RATE_LIMIT_PER_MINUTE` (default `60`, Section 32.5.4).
 */

/** Default per-token request ceiling (Section 32.5.4: "default 60 per minute"). */
export const DEFAULT_MCP_RATE_LIMIT_PER_MINUTE = 60;
/** Default fixed-window length (one minute). */
export const DEFAULT_MCP_RATE_WINDOW_MS = 60_000;

export interface RateLimiterOptions {
  /** Maximum requests permitted per token within one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitDecision {
  /** Whether this request is permitted under the limit. */
  allowed: boolean;
  /** Requests remaining in the current window (0 once exhausted). */
  remaining: number;
  /** Milliseconds until the current window resets (for a `429` `Retry-After`). */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Consume one request for `key`; return the decision. */
  check(key: string, nowMs: number): RateLimitDecision;
  /** Drop windows older than one period; return how many were removed. */
  prune(nowMs: number): number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Create a fixed-window rate limiter. Each `check` either opens a fresh window
 * (first request in the period, or after the prior window expired) and counts
 * one, increments an open window while capacity remains, or denies once the
 * window is full. Denied requests do not consume capacity.
 */
export function createRateLimiter(options?: Partial<RateLimiterOptions>): RateLimiter {
  const limit = options?.limit ?? DEFAULT_MCP_RATE_LIMIT_PER_MINUTE;
  const windowMs = options?.windowMs ?? DEFAULT_MCP_RATE_WINDOW_MS;
  const buckets = new Map<string, Bucket>();

  return {
    check(key, nowMs) {
      const current = buckets.get(key);
      const expired = !current || nowMs - current.windowStart >= windowMs;
      if (expired) {
        buckets.set(key, { count: 1, windowStart: nowMs });
        return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterMs: windowMs };
      }
      const retryAfterMs = current.windowStart + windowMs - nowMs;
      if (current.count >= limit) {
        return { allowed: false, remaining: 0, retryAfterMs };
      }
      current.count += 1;
      return { allowed: true, remaining: Math.max(0, limit - current.count), retryAfterMs };
    },
    prune(nowMs) {
      let removed = 0;
      for (const [key, bucket] of buckets) {
        if (nowMs - bucket.windowStart >= windowMs) {
          buckets.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
