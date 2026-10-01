import type { DatabaseSync } from '../../db/database.js';
import { getIngestionRecovery, completeIngestionRecovery } from '../../db/repositories/ingestion-recovery.js';
import { channelIngestionIneligibilityReason } from '../../ingestion/ingestion-eligibility.js';
import { ingestMessageCreate, type IngestOptions } from '../../ingestion/ingest.js';
import type { BackfillMessageFetcher } from '../../ingestion/backfill.js';
import type { JobHandler } from '../worker.js';
import { DeferJobError } from '../errors.js';
import type { IngestionObserver } from '../../observability.js';

/** Resolve one missing dependency without exposing it to episodes or model work. */
export function createRecoverMessageHandler(deps: {
  db: DatabaseSync; fetcher: BackfillMessageFetcher; makeIngestOptions: (now: number) => IngestOptions;
  now?: () => number; expiryMs?: number;
  observer?: IngestionObserver;
}): JobHandler<'recover_message'> {
  return async ({ recoveryId }) => {
    const now = deps.now?.() ?? Date.now();
    const request = getIngestionRecovery(deps.db, recoveryId);
    if (!request || request.status !== 'pending') return;
    // Active jobs are intentionally collapsed by recovery id. A newer signal can
    // therefore advance the durable generation while this queued row still has
    // an older payload; claim the current generation instead of deferring that
    // stale payload forever.
    const currentGeneration = request.generation;
    if (now - request.firstObservedAtMs > (deps.expiryMs ?? 86_400_000)) {
      if (completeIngestionRecovery(deps.db, request.id, currentGeneration, 'expired', now)) deps.observer?.recovery('expired', 'none');
      return;
    }
    const eligibility = channelIngestionIneligibilityReason(deps.db, request.channelId);
    if (eligibility === 'missing' || eligibility === 'parent_missing') {
      deps.observer?.recovery('deferred', eligibility === 'missing' ? 'missing_channel' : 'parent_missing');
      throw new DeferJobError('recovery channel is not yet discovered', 60_000);
    }
    if (eligibility !== null) {
      if (completeIngestionRecovery(deps.db, request.id, currentGeneration, 'skipped', now)) deps.observer?.recovery('skipped', 'policy');
      return;
    }
    let raw: unknown | null;
    try {
      raw = deps.fetcher.fetchMessage
        ? await deps.fetcher.fetchMessage(request.channelId, request.messageId)
        : (await deps.fetcher.fetchMessages(request.channelId, undefined, 100))
          .find((value) => (value as { id?: string }).id === request.messageId) ?? null;
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error
        ? (error as { status?: unknown }).status : undefined;
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code : undefined;
      if (status === 404 || code === 10008) {
        if (completeIngestionRecovery(deps.db, request.id, currentGeneration, 'unavailable', now)) deps.observer?.recovery('unavailable', 'unavailable_source');
        return;
      }
      throw error;
    }
    if (!raw) {
      if (completeIngestionRecovery(deps.db, request.id, currentGeneration, 'unavailable', now)) deps.observer?.recovery('unavailable', 'unavailable_source');
      return;
    }
    const message = deps.fetcher.normalize(raw);
    if (message.id !== request.messageId || message.channelId !== request.channelId || message.guildId !== request.guildId) {
      if (completeIngestionRecovery(deps.db, request.id, currentGeneration, 'unavailable', now)) deps.observer?.recovery('unavailable', 'unavailable_source');
      return;
    }
    const current = getIngestionRecovery(deps.db, request.id);
    if (!current || current.status !== 'pending' || current.generation !== currentGeneration) {
      throw new DeferJobError('recovery generation advanced during fetch', 1);
    }
    ingestMessageCreate(deps.db, message, deps.makeIngestOptions(now));
    if (completeIngestionRecovery(deps.db, request.id, currentGeneration, 'succeeded', now)) deps.observer?.recovery('succeeded', 'none');
  };
}
