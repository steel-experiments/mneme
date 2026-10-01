import type { DatabaseSync } from '../../db/database.js';
import type { Logger } from '../../logger.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';
import {
  reconcileChannel,
  type ReconcileResult,
} from '../../ingestion/reconcile.js';
import {
  channelIngestionIneligibilityReason,
  type ChannelIngestionIneligibilityReason,
} from '../../ingestion/ingestion-eligibility.js';
import type { BackfillMessageFetcher } from '../../ingestion/backfill.js';
import type { IngestOptions } from '../../ingestion/ingest.js';
import { DeferJobError } from '../errors.js';

/**
 * `reconcile_channel` job handler (Sections 9.6, 10, 48).
 *
 * Runs the overlap-based reconciliation walk for one channel: fetch newest pages,
 * walk backward until a stored id overlaps, upsert the unseen messages, and stamp
 * `last_reconciled_at_ms`. It never infers deletions from REST-page absence. The
 * handler runs outside any transaction; only the per-page upserts are transactional.
 */

export interface ReconcileChannelHandlerDeps {
  db: DatabaseSync;
  fetcher: BackfillMessageFetcher;
  /** Builds the per-run ingest options; the handler supplies `now`. */
  makeIngestOptions: (now: number) => IngestOptions;
  now?: () => number;
  overlapHours?: number;
  maxPages?: number;
  logger?: Pick<Logger, 'warn' | 'info'>;
}

export interface ReconcileChannelHandlerResult {
  channelId: string;
  result: ReconcileResult;
}

/** Build a `reconcile_channel` handler. `runReconcile(channelId)` exposes the work for callers/tests. */
export function createReconcileChannelHandler(
  deps: ReconcileChannelHandlerDeps,
): JobHandler<'reconcile_channel'> & {
  runReconcile(channelId: string): Promise<ReconcileChannelHandlerResult>;
} {
  const runReconcile = async (channelId: string): Promise<ReconcileChannelHandlerResult> => {
    const now = deps.now?.() ?? Date.now();
    const result = await reconcileChannel({
      db: deps.db,
      channelId,
      fetcher: deps.fetcher,
      opts: deps.makeIngestOptions(now),
      overlapHours: deps.overlapHours,
      maxPages: deps.maxPages,
      logger: deps.logger,
    });
    if (deps.logger) {
      deps.logger.info(
        { channelId, pages: result.pagesFetched, upserted: result.messagesUpserted,
          overlap: result.overlapFound, complete: result.complete },
        'reconcile_channel: pass finished',
      );
    }
    return { channelId, result };
  };

  const handler = async (payload: { channelId: string }, _job: JobRow): Promise<void> => {
    const logSkip = (reason: ChannelIngestionIneligibilityReason, phase: 'before_fetch' | 'during_fetch'): void => {
      // Eligibility is rechecked at execution because discovery/policy can change
      // after enqueue. This is normal queue staleness, not a retained job failure.
      // Telemetry contains identifiers/state only and never message content.
      deps.logger?.info(
        { event: 'reconcile_channel.skipped', channelId: payload.channelId, reason, phase },
        'reconcile_channel: skipped ineligible channel',
      );
    };
    const beforeFetchReason = channelIngestionIneligibilityReason(deps.db, payload.channelId);
    if (beforeFetchReason) {
      logSkip(beforeFetchReason, 'before_fetch');
      return;
    }
    let outcome: ReconcileChannelHandlerResult;
    try {
      outcome = await runReconcile(payload.channelId);
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
    if (!outcome.result.complete) {
      throw new DeferJobError('reconcile batch complete; more pages remain', 1);
    }
  };

  return Object.assign(handler, { runReconcile });
}
