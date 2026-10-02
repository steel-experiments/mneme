// ABOUTME: Builds discovery descriptors from discord.js-shaped channel objects.
// ABOUTME: Keeps the Discord channel shape out of the platform-neutral discovery code.
import type { ChannelAccessCapabilities } from '../../db/repositories/channel-access.js';
import type { DiscoveredChannelDescriptor } from '../../ingestion/discovery.js';
import { PRIVATE_THREAD, channelKindOf } from './channel-types.js';

/**
 * A discord.js adapter: build a descriptor list from guild channel objects. Accepts
 * any object shaped like a discord.js channel (with id/parentId/type/name and an
 * optional permissions bitfield reduced to capabilities) so it stays testable.
 */
export interface JsChannelDescriptorSource {
  id: string;
  parentId?: string | null;
  type: number;
  name?: string | null;
  topic?: string | null;
  position?: number | null;
  archived?: boolean;
  locked?: boolean;
  lastMessageId?: string | null;
}

export function descriptorsFromJsChannels(
  channels: Iterable<JsChannelDescriptorSource>,
  capabilitiesFor: (channelId: string) => ChannelAccessCapabilities,
): DiscoveredChannelDescriptor[] {
  const out: DiscoveredChannelDescriptor[] = [];
  for (const c of channels) {
    out.push({
      id: c.id,
      parentId: c.parentId ?? null,
      kind: channelKindOf(c.type),
      isPrivateThread: c.type === PRIVATE_THREAD,
      name: c.name ?? null,
      topic: c.topic ?? null,
      position: c.position ?? null,
      archived: c.archived,
      locked: c.locked,
      lastMessageId: c.lastMessageId ?? null,
      capabilities: capabilitiesFor(c.id),
    });
  }
  return out;
}
