import type { DatabaseSync } from 'node:sqlite';
import type { IngestOptions } from '../../src/ingestion/ingest.js';

export const GUILD = '100000000000000001';
export const CHANNEL = '100000000000000002';
export const AUTHOR = '100000000000000003';
export const NOW = 1_700_000_001_000;

export function opts(over: Partial<IngestOptions> = {}): IngestOptions {
  return {
    guildId: GUILD,
    storeRawJson: false,
    retainEditHistory: false,
    retainDeletedContent: false,
    attachmentMode: 'metadata',
    now: NOW,
    ...over,
  };
}

interface RawMsg {
  id?: string;
  content?: string;
  edited_timestamp?: string | null;
  attachments?: unknown[];
  reactions?: unknown[];
  author?: { id: string; username?: string; global_name?: string; bot?: boolean };
  pinned?: boolean;
  flags?: number;
  guild_id?: string;
  timestamp?: string;
}

export function rawMessage(over: RawMsg = {}): Record<string, unknown> {
  return {
    id: '200000000000000001',
    channel_id: CHANNEL,
    guild_id: GUILD,
    author: { id: AUTHOR, username: 'alice', global_name: 'Alice', bot: false },
    content: 'We decided to shipXuniq the onboarding trial.',
    timestamp: '2024-05-01T12:00:00.000+00:00',
    edited_timestamp: null,
    type: 0,
    flags: 0,
    pinned: false,
    mention_everyone: false,
    mentions: [],
    embeds: [],
    components: [],
    attachments: [],
    ...over,
  } as Record<string, unknown>;
}

/** True when the FTS index currently contains a message matching the phrase. */
export function ftsMatches(db: DatabaseSync, phrase: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM messages_fts WHERE messages_fts MATCH ? LIMIT 1')
    .get(phrase) as { 1?: number } | undefined;
  return row !== undefined;
}

export function reactionCount(
  db: DatabaseSync,
  messageId: string,
  emojiKey: string,
): number | undefined {
  return (
    db
      .prepare('SELECT count, source FROM reaction_counts WHERE message_id = ? AND emoji_key = ?')
      .get(messageId, emojiKey) as { count: number; source: string } | undefined
  )?.count;
}
