// ABOUTME: Lists Slack channels for discovery and keeps known thread rows (spec Sections 6.7.4, 9.7).
// ABOUTME: Only member channels are in the snapshot; Slack Connect channels carry the excluded boundary.
import type { DatabaseSync } from '../../db/database.js';
import type { ChannelAccessCapabilities } from '../../db/repositories/channel-access.js';
import type { DiscoveredChannelDescriptor } from '../../ingestion/discovery.js';
import type { SlackApi, SlackObject } from './api.js';
import { isSlackChannelId } from './ids.js';

/** The Slack channel rediscovery interval. It applies Slack Connect changes that arrive without an event. */
export const SLACK_REDISCOVERY_INTERVAL_MS = 15 * 60_000;

/**
 * A member can read, see, and post in a channel (`chat:write`). The sender still
 * refuses an archived, excluded, or Slack Connect channel.
 */
export const SLACK_MEMBER_CAPABILITIES: ChannelAccessCapabilities = {
  canView: true,
  canReadHistory: true,
  canSend: true,
  canSendInThreads: true,
  canManageThreads: false,
};

/** True for a Slack Connect channel: shared, or waiting to be shared, with another organization. */
export function isExternallyShared(conversation: SlackObject): boolean {
  return conversation.is_ext_shared === true || conversation.is_pending_ext_shared === true;
}

/**
 * Map one conversation to a discovery descriptor, or null when the bot is not a
 * member. The bot does not join channels; a channel without the bot stays out
 * of the snapshot, and discovery then excludes any known row for it.
 */
export function descriptorFromConversation(conversation: SlackObject): DiscoveredChannelDescriptor | null {
  const id = conversation.id;
  if (!isSlackChannelId(id) || conversation.is_member !== true) return null;
  const topic = (conversation.topic as { value?: unknown } | undefined)?.value;
  return {
    id,
    parentId: null,
    kind: 'text',
    name: typeof conversation.name === 'string' ? conversation.name : null,
    topic: typeof topic === 'string' && topic.length > 0 ? topic : null,
    position: null,
    archived: conversation.is_archived === true,
    locked: false,
    lastMessageId: null,
    capabilities: SLACK_MEMBER_CAPABILITIES,
    platformBoundary: isExternallyShared(conversation) ? 'excluded' : null,
  };
}

/**
 * Descriptors for the known, not deleted thread rows whose parent is in the
 * snapshot. A Slack thread exists only while its parent exists, so these make
 * the snapshot complete for threads; discovery closes every other thread row.
 */
export function knownThreadDescriptors(
  db: DatabaseSync,
  workspaceId: string,
  parents: readonly DiscoveredChannelDescriptor[],
): DiscoveredChannelDescriptor[] {
  const byId = new Map(parents.map((p) => [p.id, p]));
  const rows = db.prepare(`SELECT id, parent_id FROM channels
    WHERE workspace_id = ? AND is_thread = 1 AND deleted_at_ms IS NULL AND parent_id IS NOT NULL`)
    .all(workspaceId) as Array<{ id: string; parent_id: string }>;
  const out: DiscoveredChannelDescriptor[] = [];
  for (const row of rows) {
    const parent = byId.get(row.parent_id);
    if (!parent) continue;
    out.push({
      id: row.id,
      parentId: parent.id,
      kind: 'thread',
      name: null,
      archived: false,
      locked: false,
      capabilities: parent.capabilities,
      platformBoundary: parent.platformBoundary ?? null,
    });
  }
  return out;
}

/** The complete discovery snapshot: member channels first, then their known threads. */
export async function listSlackChannels(
  api: SlackApi,
  db: DatabaseSync,
  workspaceId: string,
): Promise<DiscoveredChannelDescriptor[]> {
  const channels: DiscoveredChannelDescriptor[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listConversations(cursor);
    for (const conversation of page.channels) {
      const descriptor = descriptorFromConversation(conversation);
      if (descriptor) channels.push(descriptor);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return [...channels, ...knownThreadDescriptors(db, workspaceId, channels)];
}
