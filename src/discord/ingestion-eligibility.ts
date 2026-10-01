import type { DatabaseSync } from '../db/database.js';
import { getChannel } from '../db/repositories/channels.js';
import { isMnemeTestSurface } from './test-channels.js';

export type ChannelIngestionIneligibilityReason =
  | 'missing'
  | 'control_surface'
  | 'deleted'
  | 'ineligible'
  | 'parent_missing'
  | 'parent_deleted'
  | 'parent_ineligible';

/**
 * Current, parent-aware eligibility for historical/reconciliation ingestion.
 * Both the concrete row and a thread's required parent must remain live and
 * ingestion-enabled, and neither may be part of a Mneme-named test surface.
 */
export function channelIngestionIneligibilityReason(
  db: DatabaseSync,
  channelId: string,
): ChannelIngestionIneligibilityReason | null {
  const channel = getChannel(db, channelId);
  if (!channel) return 'missing';
  if (isMnemeTestSurface(db, channelId)) return 'control_surface';
  if (channel.deleted_at_ms !== null) return 'deleted';
  if (channel.ingest_enabled !== 1 || channel.visibility_class === 'excluded') return 'ineligible';
  if (channel.is_thread !== 1) return null;
  if (!channel.parent_id) return 'parent_missing';
  const parent = getChannel(db, channel.parent_id);
  if (!parent) return 'parent_missing';
  if (parent.deleted_at_ms !== null) return 'parent_deleted';
  if (parent.ingest_enabled !== 1 || parent.visibility_class === 'excluded') return 'parent_ineligible';
  return null;
}
