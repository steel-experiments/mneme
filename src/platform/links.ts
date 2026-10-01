// ABOUTME: Builds the canonical message link for a stored message (spec Section 30.3).
// ABOUTME: Every host-generated message link comes from this one function.

/** Canonical message link (Section 30.3). Host-generated, never trusted. */
export function messageLink(workspaceId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${workspaceId}/${channelId}/${messageId}`;
}
