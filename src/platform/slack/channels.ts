// ABOUTME: Stores Slack channel and synthetic thread rows through the live channel-policy hook.
// ABOUTME: A thread row inherits its parent's boundary; a channel the bot leaves becomes unavailable.
import { transaction, type DatabaseSync } from '../../db/database.js';
import { getChannel, upsertChannel, type ChannelRow, type ChannelUpsertInput } from '../../db/repositories/channels.js';
import type { DiscoveredChannelDescriptor } from '../../ingestion/discovery.js';
import { slackThreadRowId } from './ids.js';

/** Applies the channel policy to an input before it is stored (fail closed when absent). */
export type ApplyChannelPolicy = ((input: ChannelUpsertInput) => ChannelUpsertInput) | undefined;

function failClosed(input: ChannelUpsertInput): ChannelUpsertInput {
  return { ...input, ingestEnabled: false, visibilityClass: 'excluded', allowInterventions: false };
}

/** The upsert input for a channel descriptor, before policy. */
export function channelInputFromDescriptor(
  d: DiscoveredChannelDescriptor,
  workspaceId: string,
  now: number,
): ChannelUpsertInput {
  return {
    id: d.id, guildId: workspaceId, parentId: d.parentId, kind: d.kind, name: d.name,
    topic: d.topic ?? null, position: d.position ?? null, isThread: d.kind === 'thread',
    isArchived: d.archived ?? false, isLocked: d.locked ?? false, ingestEnabled: true,
    visibilityClass: 'restricted', allowInterventions: false, permissionFingerprint: null,
    lastMessageId: null, discoveredAtMs: now, updatedAtMs: now, rawJson: null,
    platformBoundary: d.platformBoundary ?? null,
  };
}

function threadInput(row: ChannelRow | undefined, id: string, parent: ChannelRow, now: number): ChannelUpsertInput {
  return {
    id, guildId: parent.workspace_id, parentId: parent.id, kind: 'thread', name: null, topic: null,
    position: null, isThread: true, isArchived: false, isLocked: false, ingestEnabled: true,
    visibilityClass: 'restricted', allowInterventions: false,
    permissionFingerprint: row?.permission_fingerprint ?? null, lastMessageId: row?.last_message_id ?? null,
    discoveredAtMs: row?.discovered_at_ms ?? now, updatedAtMs: now, rawJson: null,
    platformBoundary: parent.platform_boundary,
  };
}

/**
 * Make sure the synthetic thread row exists before a reply is stored. Returns
 * the row id, or null when the parent channel is unknown or deleted.
 */
export function ensureThreadRow(
  db: DatabaseSync,
  channel: string,
  threadTs: string,
  apply: ApplyChannelPolicy,
  now: number,
): { id: string; created: boolean } | null {
  const id = slackThreadRowId(channel, threadTs);
  const existing = getChannel(db, id);
  if (existing && existing.deleted_at_ms === null) return { id, created: false };
  const parent = getChannel(db, channel);
  if (!parent || parent.deleted_at_ms !== null) return null;
  const input = threadInput(existing, id, parent, now);
  upsertChannel(db, apply ? apply(input) : failClosed(input));
  return { id, created: true };
}

/** Re-resolve every thread row of a channel after the channel changed (boundary, policy, availability). */
export function refreshThreadRows(db: DatabaseSync, channel: string, apply: ApplyChannelPolicy, now: number): void {
  const parent = getChannel(db, channel);
  if (!parent) return;
  const rows = db.prepare('SELECT * FROM channels WHERE parent_id = ? AND is_thread = 1 AND deleted_at_ms IS NULL')
    .all(channel) as unknown as ChannelRow[];
  for (const row of rows) {
    const input = threadInput(row, row.id, parent, now);
    upsertChannel(db, apply ? apply(input) : failClosed(input));
  }
}

/** The bot left or lost a channel: the channel and its threads fail closed at once. */
export function markChannelUnavailable(db: DatabaseSync, channel: string, now: number): void {
  transaction(db, () => {
    db.prepare(`UPDATE channels SET ingest_enabled=0, visibility_class='excluded', allow_interventions=0,
      updated_at_ms=? WHERE id=? OR parent_id=?`).run(now, channel, channel);
    db.prepare(`UPDATE sync_cursors SET state='excluded', updated_at_ms=?
      WHERE channel_id=? OR channel_id IN (SELECT id FROM channels WHERE parent_id=?)`).run(now, channel, channel);
  });
}
