// ABOUTME: Discord numeric channel types and their mapping to the neutral channel kind.
// ABOUTME: Only the Discord adapter reads Discord channel type numbers (Section 6.5).
import type { ChannelKind } from '../types.js';

// Discord channel types (Section 6.5). Numeric to match raw payloads and avoid
// coupling the adapter to discord.js enum names.
export const GUILD_TEXT = 0;
export const GUILD_ANNOUNCEMENT = 5;
export const ANNOUNCEMENT_THREAD = 10;
export const PUBLIC_THREAD = 11;
export const PRIVATE_THREAD = 12;
export const GUILD_FORUM = 15;
export const GUILD_MEDIA = 16;
export const GUILD_CATEGORY = 4;

/** Thread-shaped channel types (forum/media posts are represented as threads). */
export const THREAD_TYPES = new Set<number>([ANNOUNCEMENT_THREAD, PUBLIC_THREAD, PRIVATE_THREAD]);

/** Map a Discord channel type to the neutral kind; unsupported types are `other`. */
export function channelKindOf(type: number): ChannelKind {
  switch (type) {
    case GUILD_TEXT: return 'text';
    case GUILD_ANNOUNCEMENT: return 'announcement';
    case GUILD_FORUM: return 'forum';
    case GUILD_MEDIA: return 'media';
    case GUILD_CATEGORY: return 'category';
    case ANNOUNCEMENT_THREAD:
    case PUBLIC_THREAD:
    case PRIVATE_THREAD:
      return 'thread';
    default: return 'other';
  }
}

/** The Discord type number shown on Discord cards for a reviewable top-level kind. */
export function discordTypeOfKind(kind: string): number | null {
  switch (kind) {
    case 'text': return GUILD_TEXT;
    case 'announcement': return GUILD_ANNOUNCEMENT;
    case 'forum': return GUILD_FORUM;
    case 'media': return GUILD_MEDIA;
    case 'category': return GUILD_CATEGORY;
    default: return null;
  }
}
