import { type DatabaseSync, transaction } from '../db/database.js';
import { ingestMessagePage, type IngestOptions } from './ingest.js';
import { normalizeMessage } from '../platform/discord/normalize.js';
import type { NormalizedMessage } from '../platform/types.js';
import { beginReconcileScan, completeReconcileScan, ensureSyncCursor, getSyncCursor, recordReconcileScanProgress } from '../db/repositories/sync-cursors.js';
import type { BackfillMessageFetcher } from './backfill.js';
import { channelIngestionIneligibilityReason } from './ingestion-eligibility.js';

export interface ReconcileOptions {
  db: DatabaseSync; opts: IngestOptions; fetcher: BackfillMessageFetcher; channelId: string;
  pageSize?: number; maxPages?: number; overlapHours?: number;
  logger?: { warn(obj: unknown, msg: string): void };
}
export interface ReconcileResult {
  pagesFetched: number; messagesUpserted: number; messagesSkipped: number;
  overlapFound: boolean; reachedEnd: boolean; newestMessageId: string | null; complete: boolean;
}

/** Refresh a frozen recent window, resuming a bounded pass from durable state. */
export async function reconcileChannel(input: ReconcileOptions): Promise<ReconcileResult> {
  const { db, opts, channelId } = input;
  const pageSize = input.pageSize ?? 100;
  const maxPages = input.maxPages ?? 1000;
  const overlapMs = (input.overlapHours ?? 24) * 3_600_000;
  ensureSyncCursor(db, channelId, opts.now);
  const cursor = getSyncCursor(db, channelId)!;
  let scanStartedAtMs = cursor.reconcileScanStartedAtMs;
  let lowerBoundMs = cursor.reconcileLowerBoundMs;
  let before = cursor.reconcileBeforeMessageId ?? undefined;
  let newestMessageId = cursor.reconcileHeadMessageId;
  if (scanStartedAtMs === null || lowerBoundMs === null) {
    scanStartedAtMs = opts.now;
    lowerBoundMs = (cursor.lastCompletedReconcileScanStartedAtMs ?? opts.now) - overlapMs;
    beginReconcileScan(db, channelId, scanStartedAtMs, lowerBoundMs, null, opts.now);
    before = undefined; newestMessageId = null;
  }
  let pagesFetched = 0, messagesUpserted = 0, messagesSkipped = 0;
  let reachedEnd = false, boundaryReached = false, malformed = false;
  const enabled = (): boolean => channelIngestionIneligibilityReason(db, channelId) === null;
  for (let page = 0; page < maxPages; page += 1) {
    if (!enabled()) break;
    const raws = await input.fetcher.fetchMessages(channelId, before, pageSize);
    pagesFetched += 1;
    if (!raws.length) { reachedEnd = true; break; }
    const rawHead = (raws[0] as { id?: string } | undefined)?.id ?? null;
    if (newestMessageId === null && rawHead !== null) newestMessageId = rawHead;
    const rawTail = (raws[raws.length - 1] as { id?: string } | undefined)?.id;
    if (!rawTail || rawTail === before) { input.logger?.warn({ channelId }, 'reconcile: non-advancing REST page'); break; }
    const messages: NormalizedMessage[] = [];
    for (const raw of raws) {
      try {
        const message = normalizeMessage(raw);
        if (message.createdAtMs >= lowerBoundMs) messages.push(message); else boundaryReached = true;
      } catch (err) {
        malformed = true; messagesSkipped += 1;
        input.logger?.warn({ channelId, err: err instanceof Error ? err.message : String(err) }, 'reconcile: un-normalizable message blocks completion');
      }
    }
    let accepted = false;
    transaction(db, () => {
      if (!enabled()) return;
      if (messages.length) ingestMessagePage(db, messages, opts, { preserveUpdatedAfterMs: scanStartedAtMs });
      recordReconcileScanProgress(db, channelId, rawTail, newestMessageId, opts.now);
      accepted = true;
    });
    if (!accepted) break;
    messagesUpserted += messages.length; before = rawTail;
    if (boundaryReached || raws.length < pageSize) { reachedEnd = true; break; }
  }
  const complete = enabled() && !malformed && (boundaryReached || reachedEnd);
  if (complete) completeReconcileScan(db, channelId, scanStartedAtMs, newestMessageId, opts.now);
  return { pagesFetched, messagesUpserted, messagesSkipped, overlapFound: false, reachedEnd, newestMessageId, complete };
}
