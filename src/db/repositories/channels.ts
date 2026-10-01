import { type DatabaseSync } from '../database.js';
import type { SQLOutputValue } from 'node:sqlite';
import { prepareCached, toInt } from './util.js';
import type { RetrievalGrant } from './message-search.js';

/**
 * Idempotent channel metadata persistence (Section 9.1, 29.1).
 *
 * Channels are tombstoned on Discord removal (deleted_at_ms set) rather than
 * physically deleted, so message history stays referentially valid. Rediscovery
 * (a channel reappearing) clears the tombstone. `discovered_at_ms` is set once.
 */

export type VisibilityClass = 'org' | 'restricted' | 'review_only' | 'excluded';

export interface ChannelUpsertInput {
  id: string;
  guildId: string;
  parentId: string | null;
  type: number;
  name: string | null;
  topic: string | null;
  position: number | null;
  isThread: boolean;
  isArchived: boolean;
  isLocked: boolean;
  ingestEnabled: boolean;
  visibilityClass: VisibilityClass;
  allowInterventions: boolean;
  permissionFingerprint: string | null;
  lastMessageId: string | null;
  discoveredAtMs: number;
  updatedAtMs: number;
  rawJson: string | null;
}

export interface ChannelRow {
  id: string;
  guild_id: string;
  parent_id: string | null;
  type: number;
  name: string | null;
  topic: string | null;
  position: number | null;
  is_thread: 0 | 1;
  is_archived: 0 | 1;
  is_locked: 0 | 1;
  ingest_enabled: 0 | 1;
  visibility_class: VisibilityClass;
  allow_interventions: 0 | 1;
  permission_fingerprint: string | null;
  last_message_id: string | null;
  discovered_at_ms: number;
  updated_at_ms: number;
  deleted_at_ms: number | null;
}

const UPSERT_SQL = `
  INSERT INTO channels (
    id, guild_id, parent_id, type, name, topic, position,
    is_thread, is_archived, is_locked, ingest_enabled, visibility_class,
    allow_interventions, permission_fingerprint, last_message_id,
    discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json
  ) VALUES (
    @id, @guild_id, @parent_id, @type, @name, @topic, @position,
    @is_thread, @is_archived, @is_locked, @ingest_enabled, @visibility_class,
    @allow_interventions, @permission_fingerprint, @last_message_id,
    @discovered_at_ms, @updated_at_ms, NULL, @raw_json
  )
  ON CONFLICT(id) DO UPDATE SET
    parent_id = excluded.parent_id,
    type = excluded.type,
    name = excluded.name,
    topic = excluded.topic,
    position = excluded.position,
    is_thread = excluded.is_thread,
    is_archived = excluded.is_archived,
    is_locked = excluded.is_locked,
    ingest_enabled = excluded.ingest_enabled,
    visibility_class = excluded.visibility_class,
    allow_interventions = excluded.allow_interventions,
    permission_fingerprint = excluded.permission_fingerprint,
    last_message_id = excluded.last_message_id,
    raw_json = excluded.raw_json,
    deleted_at_ms = NULL,
    updated_at_ms = excluded.updated_at_ms
  WHERE excluded.parent_id IS NOT channels.parent_id
     OR excluded.type IS NOT channels.type
     OR excluded.name IS NOT channels.name
     OR excluded.topic IS NOT channels.topic
     OR excluded.position IS NOT channels.position
     OR excluded.is_thread IS NOT channels.is_thread
     OR excluded.is_archived IS NOT channels.is_archived
     OR excluded.is_locked IS NOT channels.is_locked
     OR excluded.ingest_enabled IS NOT channels.ingest_enabled
     OR excluded.visibility_class IS NOT channels.visibility_class
     OR excluded.allow_interventions IS NOT channels.allow_interventions
     OR excluded.permission_fingerprint IS NOT channels.permission_fingerprint
     OR excluded.last_message_id IS NOT channels.last_message_id
     OR excluded.raw_json IS NOT channels.raw_json
     OR channels.deleted_at_ms IS NOT NULL
`;

/** Upsert channel metadata. Returns the number of rows changed (0 for a no-op). */
export function upsertChannel(db: DatabaseSync, input: ChannelUpsertInput): number {
  const stmt = prepareCached(db, 'channels.upsert', UPSERT_SQL);
  const result = stmt.run({
    id: input.id,
    guild_id: input.guildId,
    parent_id: input.parentId,
    type: input.type,
    name: input.name,
    topic: input.topic,
    position: input.position,
    is_thread: toInt(input.isThread),
    is_archived: toInt(input.isArchived),
    is_locked: toInt(input.isLocked),
    ingest_enabled: toInt(input.ingestEnabled),
    visibility_class: input.visibilityClass,
    allow_interventions: toInt(input.allowInterventions),
    permission_fingerprint: input.permissionFingerprint,
    last_message_id: input.lastMessageId,
    discovered_at_ms: input.discoveredAtMs,
    updated_at_ms: input.updatedAtMs,
    raw_json: input.rawJson,
  });
  return Number(result.changes);
}

export function getChannel(db: DatabaseSync, id: string): ChannelRow | undefined {
  return prepareCached(db, 'channels.get', 'SELECT * FROM channels WHERE id = ?').get(id) as
    | ChannelRow
    | undefined;
}

export interface CurrentChannelScope {
  /** The concrete Discord channel in which the message lives. */
  channelId: string;
  /** Parent channel for a thread, otherwise the concrete channel id. */
  scopeChannelId: string;
  /** Current resolved visibility; a thread row already stores any override/inheritance. */
  visibility: VisibilityClass;
}

/**
 * Resolve the current scope anchor for a live channel. A deleted channel, or a
 * thread whose parent is missing/deleted, is unresolvable and therefore fails
 * closed. A thread row already stores the policy resolver's effective class,
 * including any explicit thread override; the parent is only the canonical
 * restricted-scope anchor and an availability dependency. Ingestion policy is
 * intentionally separate: an ingest-disabled command console can still be a
 * valid reply target even though ordinary conversation rows from it are not
 * retrievable.
 */
export function resolveCurrentChannelScope(
  db: DatabaseSync,
  channelId: string,
): CurrentChannelScope | undefined {
  const channel = getChannel(db, channelId);
  if (!channel || channel.deleted_at_ms !== null) return undefined;
  if (channel.is_thread !== 1) {
    return { channelId, scopeChannelId: channelId, visibility: channel.visibility_class };
  }
  if (!channel.parent_id) return undefined;
  const parent = getChannel(db, channel.parent_id);
  if (!parent || parent.deleted_at_ms !== null) return undefined;
  return {
    channelId,
    scopeChannelId: parent.id,
    visibility: channel.visibility_class,
  };
}

/**
 * Resolve a channel as a readable evidence/provenance source. Unlike
 * {@link resolveCurrentChannelScope}, this requires ingestion to remain enabled
 * on both the concrete channel and a thread's parent. Use the looser resolver
 * only for host-pinned reply targets such as an ingest-disabled Mneme test
 * console; retrieved or cited source material must always use this function.
 */
export function resolveRetrievableChannelScope(
  db: DatabaseSync,
  channelId: string,
): CurrentChannelScope | undefined {
  const channel = getChannel(db, channelId);
  if (
    !channel
    || channel.deleted_at_ms !== null
    || channel.ingest_enabled !== 1
    || channel.visibility_class === 'excluded'
  ) return undefined;
  if (channel.is_thread !== 1) {
    return { channelId, scopeChannelId: channelId, visibility: channel.visibility_class };
  }
  if (!channel.parent_id) return undefined;
  const parent = getChannel(db, channel.parent_id);
  if (
    !parent
    || parent.deleted_at_ms !== null
    || parent.ingest_enabled !== 1
    || parent.visibility_class === 'excluded'
  ) return undefined;
  return {
    channelId,
    scopeChannelId: parent.id,
    visibility: channel.visibility_class,
  };
}

/**
 * Tombstone a channel (set deleted_at_ms) without removing it, preserving
 * referential history. No-op if already tombstoned. Returns rows changed.
 */
export function tombstoneChannel(db: DatabaseSync, id: string, nowMs: number): number {
  const stmt = prepareCached(
    db,
    'channels.tombstone',
    'UPDATE channels SET deleted_at_ms = ?, updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL',
  );
  return Number(stmt.run(nowMs, nowMs, id).changes);
}

/** A channel visible to a retrieval grant, with the metadata an MCP client needs. */
export interface VisibleChannel {
  id: string;
  name: string | null;
  visibilityClass: VisibilityClass;
  parentId: string | null;
  isThread: boolean;
  isArchived: boolean;
  /** Whether the channel is currently being ingested (sync state). */
  ingestEnabled: boolean;
}

function toVisibleChannel(row: Record<string, SQLOutputValue>): VisibleChannel {
  return {
    id: String(row.id),
    name: row.name === null ? null : String(row.name),
    visibilityClass: String(row.visibility_class) as VisibilityClass,
    parentId: row.parent_id === null ? null : String(row.parent_id),
    isThread: Number(row.is_thread) === 1,
    isArchived: Number(row.is_archived) === 1,
    ingestEnabled: Number(row.ingest_enabled) === 1,
  };
}

const VISIBLE_CHANNEL_COLS =
  'id, name, visibility_class, parent_id, is_thread, is_archived, ingest_enabled';

/**
 * List channels a retrieval grant may read (Sections 7.3, 32.5.3). `org`
 * channels are listed when the grant includes org; restricted channels are
 * listed only when explicitly named in the grant; `review_only` channels appear
 * only when the grant carries review-only access (never for an MCP token —
 * Section 44); `excluded` channels are never listed. Deleted channels are
 * omitted. There is no agent-run counterpart to this read, so it lives in the
 * channels repository to give the MCP layer a single scoped listing path.
 */
export function listChannelsForGrant(db: DatabaseSync, grant: RetrievalGrant): VisibleChannel[] {
  const classes: string[] = [];
  if (grant.includeOrgMessages) classes.push("'org'");
  if (grant.includeReviewOnly) classes.push("'review_only'");
  const classList = classes.length > 0 ? classes.join(',') : "'__none__'";
  const ids = grant.channelIds;
  if (ids.length === 0) {
    const rows = prepareCached(
      db,
      `channels.list:${classList}:0`,
      `SELECT ${VISIBLE_CHANNEL_COLS} FROM channels c
        WHERE c.deleted_at_ms IS NULL AND c.ingest_enabled = 1
          AND (c.is_thread = 0 OR EXISTS (
            SELECT 1 FROM channels parent
             WHERE parent.id = c.parent_id
               AND parent.deleted_at_ms IS NULL
               AND parent.ingest_enabled = 1
          ))
          AND c.visibility_class IN (${classList})
        ORDER BY COALESCE(name, id) ASC`,
    ).all() as Array<Record<string, SQLOutputValue>>;
    return rows.map(toVisibleChannel);
  }
  const ph = ids.map(() => '?').join(',');
  const rows = prepareCached(
    db,
    `channels.list:${classList}:${ids.length}`,
    `SELECT ${VISIBLE_CHANNEL_COLS} FROM channels c
       WHERE c.deleted_at_ms IS NULL AND c.ingest_enabled = 1
         AND (c.is_thread = 0 OR EXISTS (
           SELECT 1 FROM channels parent
            WHERE parent.id = c.parent_id
              AND parent.deleted_at_ms IS NULL
              AND parent.ingest_enabled = 1
         ))
         AND (c.visibility_class IN (${classList})
              OR (c.visibility_class = 'restricted'
                  AND (c.id IN (${ph}) OR (c.is_thread = 1 AND c.parent_id IN (${ph})))))
       ORDER BY COALESCE(name, id) ASC`,
  ).all(...ids, ...ids) as Array<Record<string, SQLOutputValue>>;
  return rows.map(toVisibleChannel);
}
