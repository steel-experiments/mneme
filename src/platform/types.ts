// ABOUTME: Platform-neutral types shared by the core and every chat-platform adapter.
// ABOUTME: Adapters normalize platform payloads into these shapes before the core sees them.

export interface NormalizedAuthor {
  id: string;
  username: string | null;
  globalName: string | null;
  isBot: boolean;
}

export interface NormalizedMention {
  id: string;
  username: string | null;
  globalName: string | null;
}

export interface NormalizedAttachment {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  sourceUrl: string | null;
  proxyUrl: string | null;
}

/**
 * An aggregate reaction count, as REST backfill returns them. Only live Gateway
 * events provide per-user data; backfill gives emoji + count and nothing more
 * (Section 9.9). `emojiKey` is stable across both sources so the two can be
 * reconciled: a unicode emoji uses its codepoint name, a custom emoji uses
 * `name:id`.
 */
export interface NormalizedReactionCount {
  emojiKey: string;
  count: number;
}


export interface NormalizedMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  author: NormalizedAuthor;
  /** True when Discord attributes the message to a webhook execution. */
  isWebhook: boolean;
  content: string;
  createdAtMs: number;
  editedAtMs: number | null;
  replyToMessageId: string | null;
  messageType: number | null;
  flags: number | null;
  pinned: boolean;
  mentionEveryone: boolean;
  mentions: NormalizedMention[];
  embeds: unknown[];
  components: unknown[];
  poll: unknown | null;
  attachments: NormalizedAttachment[];
  reactionCounts: NormalizedReactionCount[];
  raw: unknown;
}

/**
 * A partial patch. For every optional property:
 *   - property absent (undefined) → source field was absent (keep existing);
 *   - property null               → source field was present as null (clear);
 *   - property is a value         → source field was present with a value (update).
 *
 * `content` is special-cased: it is `string | undefined`. When present it
 * always carries a string (possibly ''), so an omitted content never becomes an
 * empty overwrite, and a present empty content is honored as a real edit.
 */
export interface NormalizedMessagePatch {
  id: string;
  channelId: string;
  raw: unknown;
  guildId?: string | null;
  author?: NormalizedAuthor | null;
  content?: string;
  editedAtMs?: number | null;
  flags?: number | null;
  pinned?: boolean | null;
  mentionEveryone?: boolean | null;
  mentions?: NormalizedMention[] | null;
  embeds?: unknown[] | null;
  components?: unknown[] | null;
  poll?: unknown | null;
  attachments?: NormalizedAttachment[] | null;
}
