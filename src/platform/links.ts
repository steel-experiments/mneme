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
