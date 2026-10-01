import { type DatabaseSync, transaction } from '../db/database.js';
import { ingestMessagePage, type IngestOptions } from './ingest.js';
import type { NormalizedMessage } from '../platform/types.js';
import { channelIngestionIneligibilityReason } from './ingestion-eligibility.js';
import {
  ensureSyncCursor,
  getSyncCursor,
  recordBackfillPage,
  markBackfillComplete,
  markBackfillError,
} from '../db/repositories/sync-cursors.js';

/**
 * Paginated historical backfill (Sections 9.2, 9.5, 11.5).
 *
 * For one channel, fetch message history newest-to-oldest in pages of (default)
 * 100, upsert each page in a single short transaction, persist the cursor after
 * every page, and mark `history_complete` only at the true end of history. The
 * durable cursor makes a mid-backfill restart resume without gaps or duplicate
 * rows; an error leaves the cursor intact so the job can retry (Section 9.5 step 7).
 *
 * Network I/O happens only inside the injected {@link BackfillMessageFetcher}; the
 * rest is pure database work, so the core is testable with a fake fetcher.
 */

/** A seam for fetching one page of Discord messages (wraps `channel.messages.fetch`). */
export interface BackfillMessageFetcher {
  /**
   * Fetch up to `limit` messages older than `before` (exclusive). Messages should be
   * returned newest-first, as Discord does; backfill sorts by id descending to be
   * safe. `before` is undefined for the first (newest) page.
   */
  fetchMessages(channelId: string, before: string | undefined, limit: number): Promise<readonly unknown[]>;
  /** Exact fetch used only by durable missing-dependency recovery. */
  fetchMessage?(channelId: string, messageId: string): Promise<unknown | null>;
  /** Normalize one raw message from this fetcher; throws on a malformed payload. */
  normalize(raw: unknown): NormalizedMessage;
}

export interface BackfillOptions {
  db: DatabaseSync;
  opts: IngestOptions;
  fetcher: BackfillMessageFetcher;
  channelId: string;
  /** Page size; Discord caps at 100 (Section 9.5 step 1). */
  pageSize?: number;
  /** Safety bound so a misbehaving fetcher cannot loop forever. Default 1000. */
  maxPages?: number;
  /** Optional logger warned when a single message cannot be normalized. */
  logger?: { warn(obj: unknown, msg: string): void };
}

export interface BackfillResult {
  pagesFetched: number;
  messagesIngested: number;
  /** Messages that could not be normalized and were skipped (never blocks a page). */
  messagesSkipped: number;
  /** True when backfill reached the end of history this run. */
  historyComplete: boolean;
  newestMessageId: string | null;
  oldestMessageId: string | null;
  /** True when this run resumed from an existing cursor. */
  resumed: boolean;
}

/** Default page size — the Discord maximum (Section 9.5). */
export const DEFAULT_PAGE_SIZE = 100;

/** Sort raw message payloads by id descending (newest-first). Snowflides sort lexicographically. */
function sortNewestFirst(raws: readonly unknown[]): unknown[] {
  return [...raws].sort((a, b) => {
    const ai = (a as { id?: string })?.id ?? '';
    const bi = (b as { id?: string })?.id ?? '';
    if (ai.length !== bi.length) return bi.length - ai.length;
    return bi < ai ? -1 : bi > ai ? 1 : 0;
  });
}

/**
 * Backfill one channel to completion (or the page bound). The cursor is advanced
 * after every page so a crash never loses progress; each page upsert is idempotent,
 * so overlaps on restart produce no duplicate rows.
 */
export async function backfillChannel(input: BackfillOptions): Promise<BackfillResult> {
  const db = input.db;
  const opts = input.opts;
  const channelId = input.channelId;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = input.maxPages ?? 1000;

  ensureSyncCursor(db, channelId, opts.now);
  const cursor = getSyncCursor(db, channelId);
  const resumed = cursor?.nextBeforeMessageId != null;
  let before = cursor?.nextBeforeMessageId ?? undefined;

  let pagesFetched = 0;
  let messagesIngested = 0;
  let messagesSkipped = 0;
  let newestMessageId = cursor?.newestMessageId ?? null;
  let oldestMessageId = cursor?.oldestMessageId ?? null;
  let historyComplete = false;
  const enabled = (): boolean => channelIngestionIneligibilityReason(db, channelId) === null;

  try {
    for (let page = 0; page < maxPages; page += 1) {
      if (!enabled()) break;
      const raws = sortNewestFirst(await input.fetcher.fetchMessages(channelId, before, pageSize));
      pagesFetched += 1;

      if (raws.length === 0) {
        // No more history reachable. On a fresh channel this still means complete.
        historyComplete = enabled();
        break;
      }

      // Normalize per-message so one malformed payload never abandons the page.
      const messages: NormalizedMessage[] = [];
      for (const raw of raws) {
        try {
          messages.push(input.fetcher.normalize(raw));
        } catch (err) {
          messagesSkipped += 1;
          input.logger?.warn(
            { channelId, err: err instanceof Error ? err.message : String(err) },
            'backfill: skipping un-normalizable message',
          );
        }
      }

      if (messages.length > 0) {
        let pageAccepted = false;
        transaction(db, () => {
          if (!enabled()) return;
          ingestMessagePage(db, messages, opts);
          pageAccepted = true;
        });
        if (!pageAccepted) break;
        messagesIngested += messages.length;

        const pageNewest = messages[0]!;
        const pageOldest = messages[messages.length - 1]!;
        // The newest bound is recorded only when still unknown (first page ever);
        // a resumed run fetches older-than-cursor messages and must not overwrite it.
        if (newestMessageId == null) {
          newestMessageId = pageNewest.id;
        }
        oldestMessageId = pageOldest.id;
        before = pageOldest.id;

        recordBackfillPage(
          db,
          channelId,
          {
            oldestMessageId: pageOldest.id,
            oldestCreatedAtMs: pageOldest.createdAtMs,
            newestMessageId: cursor?.newestMessageId == null ? pageNewest.id : undefined,
            newestCreatedAtMs: cursor?.newestMessageId == null ? pageNewest.createdAtMs : undefined,
          },
          opts.now,
        );

        // Fewer than a full page means we have reached the end (Section 9.5 step 4).
        if (raws.length < pageSize) {
          historyComplete = true;
          break;
        }
      } else {
        // Advance with the oldest raw snowflake even if every payload was bad.
        if (!enabled()) break;
        const rawOldest = raws[raws.length - 1] as { id?: unknown } | undefined;
        const rawNewest = raws[0] as { id?: unknown } | undefined;
        if (typeof rawOldest?.id !== 'string') break;
        before = rawOldest.id;
        oldestMessageId = rawOldest.id;
        if (newestMessageId == null && typeof rawNewest?.id === 'string') newestMessageId = rawNewest.id;
        recordBackfillPage(db, channelId, {
          oldestMessageId: rawOldest.id, oldestCreatedAtMs: 0,
          newestMessageId: typeof rawNewest?.id === 'string' ? rawNewest.id : undefined,
          newestCreatedAtMs: 0,
        }, opts.now);
        if (raws.length < pageSize) { historyComplete = true; break; }
      }
    }
  } catch (err) {
    // Eligibility tightening while REST was in flight is a benign stale-work
    // boundary, not a channel sync error. The handler logs/completes the skip.
    if (!enabled()) {
      historyComplete = false;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      markBackfillError(db, channelId, message, opts.now);
      throw err;
    }
  }

  if (historyComplete && enabled()) {
    markBackfillComplete(
      db,
      channelId,
      {
        oldestMessageId,
        newestMessageId,
        oldestCreatedAtMs: null,
        newestCreatedAtMs: null,
      },
      opts.now,
    );
  } else {
    historyComplete = false;
  }

  return {
    pagesFetched,
    messagesIngested,
    messagesSkipped,
    historyComplete,
    newestMessageId,
    oldestMessageId,
    resumed,
  };
}
