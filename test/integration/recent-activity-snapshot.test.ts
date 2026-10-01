import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  getRecentActivitySnapshot,
  RECENT_ACTIVITY_SNAPSHOT_MAX_MESSAGES,
} from '../../src/db/repositories/recent-activity-snapshot.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';

const GUILD = '100000000000000001';
const HUMAN = '100000000000000003';
const BOT = '100000000000000099';
const START = 1_780_000_000_000;
const END = START + 1_000_000;
const ORG_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [],
};

type Visibility = 'org' | 'restricted' | 'review_only' | 'excluded';

let env: TestDb;

function seedChannel(
  id: string,
  options: {
    name?: string;
    visibility?: Visibility;
    ingestEnabled?: boolean;
    parentId?: string | null;
    isThread?: boolean;
  } = {},
): void {
  upsertChannel(env.db, {
    id,
    guildId: GUILD,
    parentId: options.parentId ?? null,
    type: options.isThread ? 11 : 0,
    name: options.name ?? id,
    topic: null,
    position: null,
    isThread: options.isThread ?? false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: options.ingestEnabled ?? true,
    visibilityClass: options.visibility ?? 'org',
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: START,
    updatedAtMs: START,
    rawJson: null,
  });
}

function seedMessage(
  id: string,
  channelId: string,
  createdAtMs: number,
  options: {
    content?: string;
    authorId?: string;
    authorDisplayName?: string;
    replyToMessageId?: string | null;
  } = {},
): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId,
    authorId: options.authorId ?? HUMAN,
    authorDisplayName: options.authorDisplayName ?? 'Alice',
    content: options.content ?? `Update ${id}`,
    createdAtMs,
    editedAtMs: null,
    replyToMessageId: options.replyToMessageId ?? null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: createdAtMs,
    updatedAtMs: createdAtMs,
  });
}

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
  env.db.prepare(
    `INSERT INTO users
       (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms, raw_json)
     VALUES (?, 'mneme-helper', 'Mneme Helper', 1, ?, ?, NULL)`,
  ).run(BOT, START, START);
});

afterEach(() => env.cleanup());

describe('recent activity snapshot repository', () => {
  it('returns all 165 permitted messages across 11 org channels and excludes every unsafe row', () => {
    const orgChannels = Array.from({ length: 11 }, (_, index) => `org-${String(index).padStart(2, '0')}`);
    for (const [index, channelId] of orgChannels.entries()) {
      seedChannel(channelId, index === 10
        ? { name: 'release-thread', isThread: true, parentId: orgChannels[0] }
        : {});
      for (let message = 0; message < 15; message += 1) {
        const id = `${channelId}-m-${String(message).padStart(2, '0')}`;
        seedMessage(id, channelId, START + 100 + message * 20 + index, {
          authorId: index === 2 && message === 3 ? BOT : HUMAN,
          authorDisplayName: index === 2 && message === 3 ? 'Mneme Helper' : 'Alice',
          replyToMessageId: index === 3 && message === 4 ? `${channelId}-m-03` : null,
        });
      }
    }

    seedChannel('restricted', { visibility: 'restricted' });
    seedChannel('excluded', { visibility: 'excluded' });
    seedChannel('disabled', { ingestEnabled: false });
    seedChannel('mneme-console-enabled', { name: '#MNEME-test' });
    seedChannel('mneme-console-disabled', {
      name: '#mneme-test-disabled',
      ingestEnabled: false,
    });
    seedChannel('mneme-parent-enabled', { name: '#mneme-thread-console' });
    seedChannel('ordinary-child-thread', {
      name: 'release-notes',
      parentId: 'mneme-parent-enabled',
      isThread: true,
    });
    seedMessage('restricted-row', 'restricted', START + 500);
    seedMessage('excluded-row', 'excluded', START + 501);
    seedMessage('disabled-row', 'disabled', START + 502);
    seedMessage('deleted-row', orgChannels[0]!, START + 503);
    env.db.prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?').run(START + 900, 'deleted-row');
    seedMessage('test-ordinary-enabled', 'mneme-console-enabled', START + 504);
    seedMessage('test-mention-enabled', 'mneme-console-enabled', START + 505, {
      content: `<@${HUMAN}> catch me up`,
    });
    seedMessage('test-ordinary-disabled', 'mneme-console-disabled', START + 506);
    seedMessage('test-parent-thread-row', 'ordinary-child-thread', START + 507);

    const snapshot = getRecentActivitySnapshot(env.db, ORG_GRANT, {
      afterMs: START,
      beforeMs: END,
    });

    expect(snapshot.totalMatching).toBe(165);
    expect(snapshot.messages).toHaveLength(165);
    expect(snapshot.matchingChannelCount).toBe(11);
    expect(snapshot.matchedChannelIds).toEqual(orgChannels);
    expect(snapshot.messageCapApplied).toBe(false);
    expect(new Set(snapshot.messages.map((message) => message.channelId))).toEqual(
      new Set(orgChannels),
    );
    const ids = new Set(snapshot.messages.map((message) => message.messageId));
    for (const unsafe of [
      'restricted-row',
      'excluded-row',
      'disabled-row',
      'deleted-row',
      'test-ordinary-enabled',
      'test-mention-enabled',
      'test-ordinary-disabled',
      'test-parent-thread-row',
    ]) {
      expect(ids.has(unsafe), unsafe).toBe(false);
    }
    expect(snapshot.messages.find((message) => message.authorId === BOT)).toMatchObject({
      authorIsBot: true,
    });
    expect(snapshot.messages.find((message) => message.replyToMessageId !== null)).toMatchObject({
      replyToMessageId: 'org-03-m-03',
    });
    expect(snapshot.messages.find((message) => message.channelId === 'org-10')).toMatchObject({
      isThread: true,
      parentChannelId: 'org-00',
    });

    const narrowed = getRecentActivitySnapshot(env.db, ORG_GRANT, {
      afterMs: START,
      beforeMs: END,
      channelIds: ['org-04'],
    });
    expect(narrowed.totalMatching).toBe(15);
    expect(narrowed.messages.every((message) => message.channelId === 'org-04')).toBe(true);
  });

  it('uses exact inclusive-after/exclusive-before bounds', () => {
    seedChannel('org-window');
    seedMessage('at-after', 'org-window', START);
    seedMessage('inside', 'org-window', START + 1);
    seedMessage('at-before', 'org-window', START + 2);

    const snapshot = getRecentActivitySnapshot(env.db, ORG_GRANT, {
      afterMs: START,
      beforeMs: START + 2,
    });
    expect(snapshot.messages.map((message) => message.messageId)).toEqual(['at-after', 'inside']);
  });

  it('water-fills unused quotas and samples busy channels across time deterministically', () => {
    const smallChannels = Array.from({ length: 10 }, (_, index) => `small-${String(index).padStart(2, '0')}`);
    for (const [index, channelId] of smallChannels.entries()) {
      seedChannel(channelId);
      seedMessage(`${channelId}-only`, channelId, START + index);
    }
    seedChannel('zz-busy');
    for (let index = 0; index < 300; index += 1) {
      seedMessage(
        `busy-${String(index).padStart(3, '0')}`,
        'zz-busy',
        START + 1_000 + index,
      );
    }

    const first = getRecentActivitySnapshot(env.db, ORG_GRANT, {
      afterMs: START,
      beforeMs: END,
    });
    const second = getRecentActivitySnapshot(env.db, ORG_GRANT, {
      afterMs: START,
      beforeMs: END,
    });

    expect(first.totalMatching).toBe(310);
    expect(first.messages).toHaveLength(RECENT_ACTIVITY_SNAPSHOT_MAX_MESSAGES);
    expect(first.messageCapApplied).toBe(true);
    expect(first.messages.map((message) => message.messageId)).toEqual(
      second.messages.map((message) => message.messageId),
    );
    const selectedIds = new Set(first.messages.map((message) => message.messageId));
    for (const channelId of smallChannels) {
      expect(selectedIds.has(`${channelId}-only`), channelId).toBe(true);
    }
    const busyIndexes = first.messages
      .filter((message) => message.channelId === 'zz-busy')
      .map((message) => Number(message.messageId.slice('busy-'.length)));
    expect(busyIndexes).toHaveLength(190);
    expect(Math.min(...busyIndexes)).toBeLessThan(5);
    expect(Math.max(...busyIndexes)).toBeGreaterThan(295);
  });
});
