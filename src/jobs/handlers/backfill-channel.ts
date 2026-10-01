import type { DatabaseSync } from '../../db/database.js';
import type { Logger } from '../../logger.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';
import {
  backfillChannel,
  type BackfillMessageFetcher,
  type BackfillResult,
} from '../../ingestion/backfill.js';
import type { IngestOptions } from '../../ingestion/ingest.js';
import { DeferJobError } from '../errors.js';
import {
  channelIngestionIneligibilityReason,
  type ChannelIngestionIneligibilityReason,
} from '../../ingestion/ingestion-eligibility.js';

/**
 * `backfill_channel` job handler (Sections 9.5, 10, 11.5).
 *
 * Paginates one channel's history newest-to-oldest, upserting each page
 * transactionally and advancing the durable cursor after every page. The cursor is
 * the source of truth for resumption: a mid-backfill crash or a transient fetch
 * failure leaves the last completed page's cursor in place, so the job retry
 * resumes without gaps or duplicate rows. The handler runs outside any database
 * transaction; only the per-page upserts are transactional.
 */

export interface BackfillChannelHandlerDeps {
  db: DatabaseSync;
  fetcher: BackfillMessageFetcher;
  /** Builds the per-run ingest options; the handler supplies `now`. */
  makeIngestOptions: (now: number) => IngestOptions;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  logger?: Pick<Logger, 'warn' | 'info'>;
}

export interface BackfillChannelHandlerResult {
  channelId: string;
  result: BackfillResult;
}

/**
 * Build a `backfill_channel` handler. `runBackfill(channelId)` exposes the same
 * work awaitable for callers and tests.
 */
export function createBackfillChannelHandler(
  deps: BackfillChannelHandlerDeps,
): JobHandler<'backfill_channel'> & {
  runBackfill(channelId: string): Promise<BackfillChannelHandlerResult>;
} {
  const runBackfill = async (channelId: string): Promise<BackfillChannelHandlerResult> => {
    const now = deps.now?.() ?? Date.now();
    const result = await backfillChannel({
      db: deps.db,
      channelId,
      fetcher: deps.fetcher,
      opts: deps.makeIngestOptions(now),
      logger: deps.logger,
    });
    if (deps.logger) {
      deps.logger.info(
        { channelId, pages: result.pagesFetched, messages: result.messagesIngested, complete: result.historyComplete },
        'backfill_channel: page batch complete',
      );
    }
    return { channelId, result };
  };

  const handler = async (
    payload: { channelId: string },
    _job: JobRow,
  ): Promise<void> => {
    const logSkip = (reason: ChannelIngestionIneligibilityReason, phase: 'before_fetch' | 'during_fetch'): void => {
      deps.logger?.info(
        { event: 'backfill_channel.skipped', channelId: payload.channelId, reason, phase },
        'backfill_channel: skipped ineligible channel',
      );
    };
    const beforeFetchReason = channelIngestionIneligibilityReason(deps.db, payload.channelId);
    if (beforeFetchReason) {
      logSkip(beforeFetchReason, 'before_fetch');
      return;
    }
    let outcome: BackfillChannelHandlerResult;
    try {
      outcome = await runBackfill(payload.channelId);
    } catch (error) {
      const duringFetchReason = channelIngestionIneligibilityReason(deps.db, payload.channelId);
      if (duringFetchReason) {
        logSkip(duringFetchReason, 'during_fetch');
        return;
      }
      throw error;
    }
    const duringFetchReason = channelIngestionIneligibilityReason(deps.db, payload.channelId);
    if (duringFetchReason) {
      logSkip(duringFetchReason, 'during_fetch');
      return;
    }
    if (!outcome.result.historyComplete) {
      throw new DeferJobError('backfill batch complete; more history remains', 1);
    }
  };

  return Object.assign(handler, { runBackfill });
}
