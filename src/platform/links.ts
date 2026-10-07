// ABOUTME: Builds the canonical message link for a stored message (spec Section 30.3).
// ABOUTME: Every host-generated message link comes from this one function; the active adapter sets the format.

/** Build the link for one stored message. */
export type MessageLinkBuilder = (workspaceId: string, channelId: string, messageId: string) => string;

/** A Discord jump link. */
export const discordMessageLink: MessageLinkBuilder = (workspaceId, channelId, messageId) =>
  `https://discord.com/channels/${workspaceId}/${channelId}/${messageId}`;

let active: MessageLinkBuilder = discordMessageLink;

/** Select the link format of the active platform. The adapter calls this once it knows its workspace. */
export function useMessageLinkBuilder(builder: MessageLinkBuilder): void {
  active = builder;
}

/** Canonical message link (Section 30.3). Host-generated, never trusted. */
export function messageLink(workspaceId: string, channelId: string, messageId: string): string {
  return active(workspaceId, channelId, messageId);
}

/** The archive whose host-built links an adapter may render as links (plan 011). */
export interface ArchiveLinkTarget {
  platform: 'discord' | 'slack';
  workspaceId: string;
}

let archiveTarget: ArchiveLinkTarget | null = null;

/** Record the verified platform archive, or null when there is none. Startup calls this once. */
export function useArchiveLinkTarget(target: ArchiveLinkTarget | null): void {
  archiveTarget = target;
}

/**
 * True when `url` has exactly the shape of a message link that the host builds
 * for the verified archive: a Discord jump link in the archive's own
 * workspace. The shape alone does not prove that the host built the link.
 * Only the sanitized direct-answer path, where the sanitizer rejects every
 * Discord jump link in model text before the host adds its own, may render
 * such a link live.
 */
export function isHostBuiltArchiveLink(url: string): boolean {
  if (!archiveTarget || archiveTarget.platform !== 'discord') return false;
  if (!/^\d{17,20}$/.test(archiveTarget.workspaceId)) return false;
  return new RegExp(`^https://discord\\.com/channels/${archiveTarget.workspaceId}/\\d{17,20}/\\d{17,20}$`).test(url);
}
