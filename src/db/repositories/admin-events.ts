import { randomUUID } from 'node:crypto';
import { type DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';

/**
 * Admin-action audit log (Sections 6.6, 27, 44).
 *
 * Every attempted material admin action — whether it succeeds or is denied — is
 * recorded in `admin_events` with the actor, action, target, bounded details, and a
 * timestamp. The details are sanitized so no message content, prompt material, or
 * secret ever reaches the audit row (Section 44: "Record all admin actions" without
 * content or secrets).
 */

export interface AdminEventRecord {
  guildId: string;
  actorUserId: string;
  action: string;
  /** Optional target id (proposal id, channel id, memory id, token id, …). */
  target?: string | null;
  /** Bounded, non-secret metadata. Sanitized before storage. */
  details?: Record<string, unknown> | null;
  createdAtMs: number;
}

/** Stored admin event row. */
export interface AdminEventRow {
  id: string;
  guildId: string;
  actorUserId: string;
  action: string;
  target: string | null;
  detailsJson: string;
  createdAtMs: number;
}

/** Keys whose values must never be persisted to the audit log. */
const REDACT_KEY_RE =
  /^(token|tokens|secret|secrets|password|passwd|api[_-]?key|apikey|authorization|credential|credentials|private[_-]?key|cookie|access[_-]?token|refresh[_-]?token|content|prompt)$/i;

/** Cap any surviving string so a verbose field cannot dump large content. */
const MAX_DETAIL_STRING = 256;

/**
 * Deep-copy a details object, redacting secret- and content-shaped keys and capping
 * string length. Arrays and nested objects are walked; non-plain objects are left
 * intact. The result is safe to JSON-stringify into `details_json`.
 */
export function sanitizeAdminDetails(details: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return { ...(walk(details ?? {}) as Record<string, unknown>) };
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = REDACT_KEY_RE.test(key) ? '[redacted]' : walk(val);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > MAX_DETAIL_STRING) {
    return value.slice(0, MAX_DETAIL_STRING) + '…';
  }
  return value;
}

/**
 * Persist an admin event and return its generated id. Details are sanitized before
 * storage; a null/undefined target is stored as SQL NULL.
 */
export function recordAdminEvent(db: DatabaseSync, record: AdminEventRecord): string {
  const id = randomUUID();
  const detailsJson = JSON.stringify(sanitizeAdminDetails(record.details));
  prepareCached(
    db,
    'admin-events.insert',
    `INSERT INTO admin_events (id, workspace_id, actor_user_id, action, target, details_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, record.guildId, record.actorUserId, record.action, record.target ?? null, detailsJson, record.createdAtMs);
  return id;
}

/** Read an admin event by id (or null when absent). */
export function getAdminEvent(db: DatabaseSync, id: string): AdminEventRow | null {
  const row = prepareCached(
    db,
    'admin-events.get',
    `SELECT id,
            workspace_id AS guildId,
            actor_user_id AS actorUserId,
            action,
            target,
            details_json AS detailsJson,
            created_at_ms AS createdAtMs
       FROM admin_events WHERE id = ?`,
  ).get(id) as AdminEventRow | undefined;
  return row ?? null;
}

/** Count admin events for a guild within an optional [fromMs, toMs] window. */
export function countAdminEvents(
  db: DatabaseSync,
  guildId: string,
  window?: { fromMs?: number; toMs?: number },
): number {
  const conditions = ['workspace_id = ?'];
  const params: Array<string | number> = [guildId];
  if (window?.fromMs !== undefined) {
    conditions.push('created_at_ms >= ?');
    params.push(window.fromMs);
  }
  if (window?.toMs !== undefined) {
    conditions.push('created_at_ms <= ?');
    params.push(window.toMs);
  }
  const row = prepareCached(
    db,
    // Cache key includes the WHERE shape: each distinct clause set prepares once.
    `admin-events.count:${conditions.join('&')}`,
    `SELECT COUNT(*) AS c FROM admin_events WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as { c: number };
  return row.c;
}
