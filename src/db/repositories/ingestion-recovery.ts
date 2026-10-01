import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';

export type IngestionRecoveryReason = 'missing_channel' | 'missing_message';
export type IngestionRecoveryStatus = 'pending' | 'succeeded' | 'unavailable' | 'skipped' | 'expired';
export interface IngestionRecoveryRow {
  id: string; guildId: string; channelId: string; messageId: string; generation: number;
  reason: IngestionRecoveryReason; status: IngestionRecoveryStatus;
  firstObservedAtMs: number; lastObservedAtMs: number; completedAtMs: number | null;
}
const COLS = `id,workspace_id AS guildId,channel_id AS channelId,message_id AS messageId,generation,
 reason,status,first_observed_at_ms AS firstObservedAtMs,last_observed_at_ms AS lastObservedAtMs,
 completed_at_ms AS completedAtMs`;
export function requestIngestionRecovery(db: DatabaseSync, input: {
  guildId: string; channelId: string; messageId: string; reason: IngestionRecoveryReason; now: number;
}): IngestionRecoveryRow {
  prepareCached(db, 'ingestion-recovery.request', `INSERT INTO ingestion_recovery_requests
    (id,workspace_id,channel_id,message_id,generation,reason,status,first_observed_at_ms,last_observed_at_ms)
    VALUES (@id,@guildId,@channelId,@messageId,1,@reason,'pending',@now,@now)
    ON CONFLICT(workspace_id,channel_id,message_id) DO UPDATE SET generation=generation+1,
      reason=excluded.reason,status='pending',last_observed_at_ms=excluded.last_observed_at_ms,completed_at_ms=NULL
  `).run({ ...input, id: randomUUID() });
  return prepareCached(db, 'ingestion-recovery.request-read', `SELECT ${COLS} FROM ingestion_recovery_requests
    WHERE workspace_id=? AND channel_id=? AND message_id=?`).get(input.guildId, input.channelId, input.messageId) as unknown as IngestionRecoveryRow;
}
export function getIngestionRecovery(db: DatabaseSync, id: string): IngestionRecoveryRow | null {
  return prepareCached(db, 'ingestion-recovery.get', `SELECT ${COLS} FROM ingestion_recovery_requests WHERE id=?`).get(id) as IngestionRecoveryRow | undefined ?? null;
}
export function completeIngestionRecovery(db: DatabaseSync, id: string, generation: number,
  status: Exclude<IngestionRecoveryStatus, 'pending'>, now: number): boolean {
  return Number(prepareCached(db, 'ingestion-recovery.complete', `UPDATE ingestion_recovery_requests
    SET status=?,completed_at_ms=? WHERE id=? AND generation=? AND status='pending'`)
    .run(status, now, id, generation).changes) === 1;
}
export function listPendingIngestionRecoveries(db: DatabaseSync): IngestionRecoveryRow[] {
  return prepareCached(db, 'ingestion-recovery.pending', `SELECT ${COLS} FROM ingestion_recovery_requests
    WHERE status='pending' ORDER BY last_observed_at_ms ASC`).all() as unknown as IngestionRecoveryRow[];
}
