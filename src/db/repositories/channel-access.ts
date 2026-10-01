import { randomUUID, createHash } from 'node:crypto';
import { type DatabaseSync } from '../database.js';
import { prepareCached, toInt } from './util.js';

/**
 * Channel access auditing (Sections 6.3, 7, 48 Ingestion).
 *
 * At discovery time Mneme records, per channel, the five Discord capability
 * bits it actually holds: View Channel, Read Message History, Send Messages, Send
 * Messages in Threads, and Manage Threads. The audit row is the basis for the
 * "permission warnings" surfaced by `/mneme channels` and the `list_channels`
 * MCP tool, and the permission fingerprint stored on the channel row lets a later
 * discovery detect that capabilities changed (Section 48: "Automated permission-
 * signature comparison based on Discord roles").
 */

/** The five Discord capability bits the audit records (Section 6.3). */
export interface ChannelAccessCapabilities {
  canView: boolean;
  canReadHistory: boolean;
  canSend: boolean;
  canSendInThreads: boolean;
  canManageThreads: boolean;
}

/** Convenience: no capability at all (used when the bot cannot resolve permissions). */
export const NO_ACCESS: ChannelAccessCapabilities = {
  canView: false,
  canReadHistory: false,
  canSend: false,
  canSendInThreads: false,
  canManageThreads: false,
};

export interface ChannelAccessAuditInput extends ChannelAccessCapabilities {
  channelId: string;
  checkedAtMs: number;
  /** Joined warning text, or null when the channel is fully capable. */
  warning: string | null;
}

/** Stored audit row (booleans arrive as 0/1 under STRICT INTEGER columns). */
export interface ChannelAccessAuditRow {
  id: string;
  channelId: string;
  checkedAtMs: number;
  canView: 0 | 1;
  canReadHistory: 0 | 1;
  canSend: 0 | 1;
  canSendInThreads: 0 | 1;
  canManageThreads: 0 | 1;
  warning: string | null;
}

const CAPABILITY_KEYS = ['canView', 'canReadHistory', 'canSend', 'canSendInThreads', 'canManageThreads'] as const;

/**
 * Deterministic SHA-256 over the five capability bits. Two audits with identical
 * capabilities share a fingerprint, so a channel whose permissions have not changed
 * does not appear to need re-auditing. This is the "permission signature".
 */
export function computePermissionFingerprint(caps: ChannelAccessCapabilities): string {
  const sig = CAPABILITY_KEYS.map((k) => (caps[k] ? '1' : '0')).join(',');
  return createHash('sha256').update(sig).digest('hex');
}

/** Insert an access-audit row and return its generated id. */
export function recordAccessAudit(db: DatabaseSync, input: ChannelAccessAuditInput): string {
  const id = randomUUID();
  prepareCached(
    db,
    'channel-access.insert',
    `INSERT INTO channel_access_audits
       (id, channel_id, checked_at_ms, can_view, can_read_history, can_send, can_send_in_threads, can_manage_threads, warning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.channelId,
    input.checkedAtMs,
    toInt(input.canView),
    toInt(input.canReadHistory),
    toInt(input.canSend),
    toInt(input.canSendInThreads),
    toInt(input.canManageThreads),
    input.warning,
  );
  return id;
}

/** The most recent audit for a channel (uses channel_access_latest_idx), or null. */
export function getLatestAccessAudit(db: DatabaseSync, channelId: string): ChannelAccessAuditRow | null {
  const row = prepareCached(
    db,
    'channel-access.latest',
    `SELECT id,
            channel_id AS channelId,
            checked_at_ms AS checkedAtMs,
            can_view AS canView,
            can_read_history AS canReadHistory,
            can_send AS canSend,
            can_send_in_threads AS canSendInThreads,
            can_manage_threads AS canManageThreads,
            warning
       FROM channel_access_audits
      WHERE channel_id = ?
      ORDER BY checked_at_ms DESC
      LIMIT 1`,
  ).get(channelId) as ChannelAccessAuditRow | undefined;
  return row ?? null;
}

/** Count audits recorded for a channel (useful for change-detection tests). */
export function countAccessAudits(db: DatabaseSync, channelId: string): number {
  const row = prepareCached(
    db,
    'channel-access.count',
    'SELECT COUNT(*) AS c FROM channel_access_audits WHERE channel_id = ?',
  ).get(channelId) as { c: number };
  return row.c;
}
