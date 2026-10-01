import type { DatabaseSync } from '../db/database.js';
import { getChannel } from '../db/repositories/channels.js';

/** Channels whose names contain "mneme" are isolated test surfaces. */
export function isMnemeTestChannelName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.toLowerCase().includes('mneme');
}

/**
 * Resolve the complete test surface: a Mneme-named channel and every
 * normally named thread directly below it. Discord threads are one level deep.
 */
export function isMnemeTestSurface(db: DatabaseSync, channelId: string): boolean {
  const channel = getChannel(db, channelId);
  if (!channel) return false;
  if (isMnemeTestChannelName(channel.name)) return true;
  if (channel.is_thread !== 1 || channel.parent_id === null) return false;
  return isMnemeTestChannelName(getChannel(db, channel.parent_id)?.name);
}
