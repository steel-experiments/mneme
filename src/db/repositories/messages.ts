import { type DatabaseSync } from '../database.js';
import type { SQLInputValue } from 'node:sqlite';
import { prepareCached, toInt } from './util.js';
import type { NormalizedMessagePatch } from '../../platform/types.js';

/**
 * Idempotent message persistence (Section 9.1, 9.4, 9.8, 29.1).
 *
 * The FTS update trigger (`messages_au`, migration 004) fires on every UPDATE
 * of `messages` and unconditionally deletes then re-inserts the indexed row.
 * To keep the index from churning under reconciliation — which re-reads every
 * recent message (Section 9.6) — every upsert here carries a `WHERE` clause
 * that makes the statement a no-op (zero rows changed) when nothing actually
 * differs. A zero-row UPDATE never fires its AFTER triggers, so an unchanged
 * re-delivery leaves the FTS index untouched.
 *
 * Attachment metadata lives in `repositories/attachments.ts`; reaction counts
 * in `repositories/reactions.ts`.
 */

export interface MessageRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  author_id: string | null;
  author_display_name: string;
  content: string;
  created_at_ms: number;
  edited_at_ms: number | null;
  deleted_at_ms: number | null;
  reply_to_message_id: string | null;
  message_type: number | null;
  flags: number | null;
  pinned: 0 | 1;
  mention_everyone: 0 | 1;
  mentions_json: string;
  embeds_json: string;
  components_json: string;
  poll_json: string | null;
  raw_json: string | null;
  ingested_at_ms: number;
  updated_at_ms: number;
}

export interface MessageCreateInput {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string | null;
  authorDisplayName: string;
  content: string;
  createdAtMs: number;
  editedAtMs: number | null;
  replyToMessageId: string | null;
  messageType: number | null;
  flags: number | null;
  pinned: boolean;
  mentionEveryone: boolean;
  mentionsJson: string;
  embedsJson: string;
  componentsJson: string;
  pollJson: string | null;
  rawJson: string | null;
  ingestedAtMs: number;
  updatedAtMs: number;
}

// created_at_ms / workspace_id / channel_id / ingested_at_ms are set on insert and
// preserved on conflict (a later re-delivery never rewrites origin fields).
// deleted_at_ms is cleared on conflict: a fresh CREATE means the message exists
// on Discord's side, so any stale tombstone is invalid (Section 9.8).
const CREATE_UPSERT_SQL = `
  INSERT INTO messages (
    id, workspace_id, channel_id, author_id, author_display_name, content,
    created_at_ms, edited_at_ms, deleted_at_ms, reply_to_message_id, message_type,
    flags, pinned, mention_everyone, mentions_json, embeds_json, components_json,
    poll_json, raw_json, ingested_at_ms, updated_at_ms
  ) VALUES (
    @id, @workspace_id, @channel_id, @author_id, @author_display_name, @content,
    @created_at_ms, @edited_at_ms, NULL, @reply_to_message_id, @message_type,
    @flags, @pinned, @mention_everyone, @mentions_json, @embeds_json, @components_json,
    @poll_json, @raw_json, @ingested_at_ms, @updated_at_ms
  )
  ON CONFLICT(id) DO UPDATE SET
    author_id = excluded.author_id,
    author_display_name = excluded.author_display_name,
    content = excluded.content,
    edited_at_ms = excluded.edited_at_ms,
    reply_to_message_id = excluded.reply_to_message_id,
    message_type = excluded.message_type,
    flags = excluded.flags,
    pinned = excluded.pinned,
    mention_everyone = excluded.mention_everyone,
    mentions_json = excluded.mentions_json,
    embeds_json = excluded.embeds_json,
    components_json = excluded.components_json,
    poll_json = excluded.poll_json,
    raw_json = CASE WHEN excluded.raw_json IS NULL THEN messages.raw_json ELSE excluded.raw_json END,
    deleted_at_ms = NULL,
    updated_at_ms = excluded.updated_at_ms
  WHERE excluded.author_id IS NOT messages.author_id
     OR excluded.author_display_name IS NOT messages.author_display_name
     OR excluded.content IS NOT messages.content
     OR excluded.edited_at_ms IS NOT messages.edited_at_ms
     OR excluded.reply_to_message_id IS NOT messages.reply_to_message_id
     OR excluded.message_type IS NOT messages.message_type
     OR excluded.flags IS NOT messages.flags
     OR excluded.pinned IS NOT messages.pinned
     OR excluded.mention_everyone IS NOT messages.mention_everyone
     OR excluded.mentions_json IS NOT messages.mentions_json
     OR excluded.embeds_json IS NOT messages.embeds_json
     OR excluded.components_json IS NOT messages.components_json
     OR excluded.poll_json IS NOT messages.poll_json
     OR excluded.raw_json IS NOT messages.raw_json
     OR messages.deleted_at_ms IS NOT NULL
`;

/**
 * Insert or refresh a message from a full create/fetch payload. Returns the
 * number of rows changed (0 for a no-op re-delivery).
 */
export function upsertMessageCreate(db: DatabaseSync, input: MessageCreateInput): number {
  if (hasMessageTombstone(db, input.id)) return 0;
  const stmt = prepareCached(db, 'messages.create', CREATE_UPSERT_SQL);
  const result = stmt.run({
    id: input.id,
    workspace_id: input.guildId,
    channel_id: input.channelId,
    author_id: input.authorId,
    author_display_name: input.authorDisplayName,
    content: input.content,
    created_at_ms: input.createdAtMs,
    edited_at_ms: input.editedAtMs,
    reply_to_message_id: input.replyToMessageId,
    message_type: input.messageType,
    flags: input.flags,
    pinned: toInt(input.pinned),
    mention_everyone: toInt(input.mentionEveryone),
    mentions_json: input.mentionsJson,
    embeds_json: input.embedsJson,
    components_json: input.componentsJson,
    poll_json: input.pollJson,
    raw_json: input.rawJson,
    ingested_at_ms: input.ingestedAtMs,
    updated_at_ms: input.updatedAtMs,
  });
  return Number(result.changes);
}

/** Return true when an explicit delete prevents later REST resurrection. */
export function hasMessageTombstone(db: DatabaseSync, messageId: string): boolean {
  return Boolean(prepareCached(
    db,
    'messages.has_tombstone',
    'SELECT 1 FROM message_tombstones WHERE message_id = ?',
  ).get(messageId));
}

/**
 * Map a present patch field to the column it touches and the bound value. Null
 * (clear) semantics are resolved here: NOT NULL columns clear to their empty
 * default; nullable columns clear to NULL.
 */
interface PatchColumn {
  col: string;
  val: SQLInputValue;
}

function collectPatchColumns(
  patch: NormalizedMessagePatch,
  authorDisplayName: string,
): PatchColumn[] {
  const cols: PatchColumn[] = [];
  if (patch.author !== undefined && patch.author !== null) {
    cols.push({ col: 'author_id', val: patch.author.id });
    cols.push({ col: 'author_display_name', val: authorDisplayName });
  }
  if (patch.content !== undefined) cols.push({ col: 'content', val: patch.content });
  if (patch.editedAtMs !== undefined) cols.push({ col: 'edited_at_ms', val: patch.editedAtMs });
  if (patch.flags !== undefined) cols.push({ col: 'flags', val: patch.flags });
  if (patch.pinned !== undefined) {
    cols.push({ col: 'pinned', val: patch.pinned === null ? 0 : toInt(patch.pinned) });
  }
  if (patch.mentionEveryone !== undefined) {
    cols.push({
      col: 'mention_everyone',
      val: patch.mentionEveryone === null ? 0 : toInt(patch.mentionEveryone),
    });
  }
  if (patch.mentions !== undefined) {
    cols.push({ col: 'mentions_json', val: patch.mentions === null ? '[]' : JSON.stringify(patch.mentions) });
  }
  if (patch.embeds !== undefined) {
    cols.push({ col: 'embeds_json', val: patch.embeds === null ? '[]' : JSON.stringify(patch.embeds) });
  }
  if (patch.components !== undefined) {
    cols.push({ col: 'components_json', val: patch.components === null ? '[]' : JSON.stringify(patch.components) });
  }
  if (patch.poll !== undefined) {
    cols.push({ col: 'poll_json', val: patch.poll === null ? null : JSON.stringify(patch.poll) });
  }
  return cols;
}

export interface MessageUpdateInput {
  patch: NormalizedMessagePatch;
  /** Display name to store when the patch carries an author. */
  authorDisplayName: string;
  updatedAtMs: number;
}

/**
 * Apply a partial MESSAGE_UPDATE. Builds a dynamic UPDATE that touches only the
 * columns present on the patch and is a no-op when every present column already
 * matches the stored value (so an unchanged update does not churn FTS). Returns
 * the number of rows changed, or -1 when the patch carries no settable columns.
 */
export function applyMessageUpdate(db: DatabaseSync, input: MessageUpdateInput): number {
  const cols = collectPatchColumns(input.patch, input.authorDisplayName);
  if (cols.length === 0) return -1;

  // One named parameter per column, reused in the SET and the no-op guard. The
  // guard compares each stored column to its new value with `IS NOT` so NULL
  // comparisons behave correctly; updated_at_ms is excluded from the guard (it
  // always advances when a real change lands).
  const setClause = cols.map((c) => `${c.col} = @${c.col}`).join(', ');
  const guard = cols.map((c) => `messages.${c.col} IS NOT @${c.col}`).join(' OR ');
  const sql = `
    UPDATE messages SET ${setClause}, updated_at_ms = @updated_at_ms
    WHERE id = @id AND (${guard})
  `;
  // The SQL varies with which patch fields are present, so cache per column
  // signature rather than under one shared key.
  const cacheKey = `messages.update:${cols.map((c) => c.col).join(',')}`;
  const stmt = prepareCached(db, cacheKey, sql);

  const params: Record<string, SQLInputValue> = {
    id: input.patch.id,
    updated_at_ms: input.updatedAtMs,
  };
  for (const c of cols) params[c.col] = c.val;
  return Number(stmt.run(params).changes);
}

export function getMessage(db: DatabaseSync, id: string): MessageRow | undefined {
  return prepareCached(db, 'messages.get', 'SELECT * FROM messages WHERE id = ?').get(id) as
    | MessageRow
    | undefined;
}

/**
 * Return the subset of `ids` that already have a stored message row. Used by
 * reconciliation (Section 9.6) to detect the overlap point when walking backward,
 * in one query rather than N. Empty input returns an empty set.
 */
export function messageIdsExist(db: DatabaseSync, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  // SQLite parameter lists are bounded; page through in chunks of 500.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id FROM messages WHERE id IN (${placeholders})`)
      .all(...(chunk as SQLInputValue[])) as Array<{ id: string }>;
    for (const row of rows) out.add(row.id);
  }
  return out;
}

/**
 * Capture the current content as an edit-history version before it is
 * overwritten (Section 9.8, RETAIN_EDIT_HISTORY). The version number is computed
 * atomically inside the surrounding transaction. Returns the new version, or
 * undefined when nothing was captured.
 */
export function captureMessageVersion(
  db: DatabaseSync,
  messageId: string,
  current: { content: string; editedAtMs: number | null; rawJson: string | null },
  observedAtMs: number,
): number | undefined {
  const stmt = prepareCached(
    db,
    'messages.version',
    `INSERT INTO message_versions (message_id, version, content, edited_at_ms, observed_at_ms, raw_json)
     SELECT @message_id, COALESCE(MAX(version), 0) + 1, @content, @edited_at_ms, @observed_at_ms, @raw_json
     FROM message_versions WHERE message_id = @message_id
     RETURNING version`,
  );
  const row = stmt.get({
    message_id: messageId,
    content: current.content,
    edited_at_ms: current.editedAtMs,
    observed_at_ms: observedAtMs,
    raw_json: current.rawJson,
  }) as { version: number } | undefined;
  return row?.version;
}

// ---- Deletion (Section 9.8) -------------------------------------------------

export interface DeleteOptions {
  retainDeletedContent: boolean;
  nowMs: number;
}

/** Record a delete even when the normalized message row does not exist yet. */
export function recordMessageTombstone(
  db: DatabaseSync,
  input: { messageId: string; guildId?: string | null; channelId?: string | null; deletedAtMs: number },
): void {
  prepareCached(
    db,
    'messages.record_tombstone',
    `INSERT INTO message_tombstones (message_id, channel_id, workspace_id, deleted_at_ms, created_at_ms)
     VALUES (@messageId, @channelId, @guildId, @deletedAtMs, @deletedAtMs)
     ON CONFLICT(message_id) DO UPDATE SET
       channel_id = COALESCE(message_tombstones.channel_id, excluded.channel_id),
       workspace_id = COALESCE(message_tombstones.workspace_id, excluded.workspace_id),
       deleted_at_ms = min(message_tombstones.deleted_at_ms, excluded.deleted_at_ms)`,
  ).run({
    messageId: input.messageId,
    channelId: input.channelId ?? null,
    guildId: input.guildId ?? null,
    deletedAtMs: input.deletedAtMs,
  });
}

/**
 * Tombstone a message (set deleted_at_ms). The FTS delete trigger removes it
 * from search because `new.deleted_at_ms` becomes non-null. When content is not
 * retained, the indexed columns are blanked so deleted text is gone from SQLite
 * too — the FTS row is already dropped by the trigger. No-op if already deleted.
 * Returns rows changed.
 */
export function deleteMessage(db: DatabaseSync, id: string, opts: DeleteOptions): number {
  if (opts.retainDeletedContent) {
    return Number(
      prepareCached(
        db,
        'messages.delete.retain',
        'UPDATE messages SET deleted_at_ms = @now, updated_at_ms = @now WHERE id = @id AND deleted_at_ms IS NULL',
      ).run({ id, now: opts.nowMs }).changes,
    );
  }
  return Number(
    prepareCached(
      db,
      'messages.delete.purge',
      `UPDATE messages
         SET deleted_at_ms = @now,
             content = '',
             mentions_json = '[]',
             embeds_json = '[]',
             components_json = '[]',
             poll_json = NULL,
             raw_json = NULL,
             updated_at_ms = @now
       WHERE id = @id AND deleted_at_ms IS NULL`,
    ).run({ id, now: opts.nowMs }).changes,
  );
}

// ---- Sync extrema (Section 9.5) ---------------------------------------------

/**
 * Advance a channel's last_message_id when the given message is newer than the
 * one currently recorded. Idempotent: re-delivering an older message never
 * rewinds the cursor, and an unchanged cursor does not bump updated_at. Returns
 * rows changed.
 */
export function touchChannelLastMessage(
  db: DatabaseSync,
  channelId: string,
  messageId: string,
  createdAtMs: number,
  nowMs: number,
): number {
  // last_message_id is a Discord snowflake; comparing the strings directly is
  // not a safe ordering, so gate on the numeric created_at_ms of the cursor's
  // message (null cursor treated as older than everything).
  return Number(
    prepareCached(
      db,
      'channels.touch_last',
      `UPDATE channels
         SET last_message_id = @message_id, updated_at_ms = @now
       WHERE id = @channel_id
         AND (
           last_message_id IS NULL
           OR @created_at_ms > COALESCE(
             (SELECT created_at_ms FROM messages WHERE id = channels.last_message_id),
             -1
           )
         )`,
    ).run({ channel_id: channelId, message_id: messageId, created_at_ms: createdAtMs, now: nowMs })
      .changes,
  );
}
