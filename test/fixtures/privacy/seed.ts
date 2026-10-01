import type { DatabaseSync } from 'node:sqlite';
import { upsertChannel, type VisibilityClass } from '../../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../../src/db/repositories/messages.js';

/**
 * Synthetic privacy-matrix fixtures (Section 46.3; task T118).
 *
 * One channel per visibility class, plus a thread under a restricted channel,
 * and one message per channel that all match the synthetic term "meridian". The
 * term is deliberately meaningless so any search hit (or its absence) is
 * attributable only to scope, never to world knowledge. Each restricted channel
 * carries a distinctive canary substring ("confidential to channel A", "risk
 * noted in channel B") so a leak — or a hint that hidden matching content exists
 * — is unambiguous in an assertion.
 */

export const GUILD = '100000000000000001';
export const USER = '100000000000000003';
export const NOW = 1_700_000_001_000;

/** The synthetic search term every seeded message contains. */
export const SEARCH_TERM = 'meridian';

// Channel ids carry their visibility class for readability.
export const PUB = 'privacy-org';
export const RESTRICTED_A = 'privacy-restricted-a';
export const RESTRICTED_B = 'privacy-restricted-b';
export const REVIEW_ONLY = 'privacy-review-only';
export const EXCLUDED = 'privacy-excluded';
export const THREAD_A = 'privacy-thread-under-a';

export const MSG_PUB = 'msg-pub';
export const MSG_A = 'msg-a';
export const MSG_B = 'msg-b';
export const MSG_REVIEW = 'msg-review';
export const MSG_EXCLUDED = 'msg-exc';
export const MSG_THREAD_A = 'msg-thread-a';

/** Canary substrings that must NEVER appear outside a scope that permits them. */
export const CANARY_A = 'confidential to channel A';
export const CANARY_B = 'risk noted in channel B';

const CONTENTS: Record<string, string> = {
  [MSG_PUB]: 'The meridian launch is public knowledge.',
  [MSG_A]: `Meridian launch budget is ${CANARY_A}.`,
  [MSG_B]: `Meridian launch ${CANARY_B}.`,
  [MSG_REVIEW]: 'Meridian flagged for secure review.',
  [MSG_EXCLUDED]: 'Meridian excluded chatter.',
  [MSG_THREAD_A]: 'Meridian thread detail under channel A.',
};

/** Upsert the six visibility-class channels (plus the thread under A). */
export function seedPrivacyChannels(db: DatabaseSync): void {
  const add = (
    id: string,
    visibility: VisibilityClass,
    parent: string | null = null,
    isThread = false,
  ): void => {
    upsertChannel(db, {
      id,
      guildId: GUILD,
      parentId: parent,
      kind: isThread ? 'thread' : 'text',
      name: id,
      topic: null,
      position: null,
      isThread,
      isArchived: false,
      isLocked: false,
      ingestEnabled: true,
      visibilityClass: visibility,
      allowInterventions: false,
      permissionFingerprint: null,
      lastMessageId: null,
      discoveredAtMs: NOW,
      updatedAtMs: NOW,
      rawJson: null,
    });
  };
  add(PUB, 'org');
  add(RESTRICTED_A, 'restricted');
  add(RESTRICTED_B, 'restricted');
  add(REVIEW_ONLY, 'review_only');
  add(EXCLUDED, 'excluded');
  add(THREAD_A, 'restricted', RESTRICTED_A, true);
}

/** Insert one message per channel, each containing the synthetic search term. */
export function seedPrivacyMessages(db: DatabaseSync): void {
  const place = (id: string, channel: string): void => {
    upsertMessageCreate(db, {
      id,
      guildId: GUILD,
      channelId: channel,
      authorId: USER,
      authorDisplayName: 'Alice',
      content: CONTENTS[id] ?? `meridian message ${id}`,
      createdAtMs: NOW,
      editedAtMs: null,
      replyToMessageId: null,
      messageType: 0,
      flags: 0,
      pinned: false,
      mentionEveryone: false,
      mentionsJson: '[]',
      embedsJson: '[]',
      componentsJson: '[]',
      pollJson: null,
      rawJson: null,
      ingestedAtMs: NOW,
      updatedAtMs: NOW,
    });
  };
  place(MSG_PUB, PUB);
  place(MSG_A, RESTRICTED_A);
  place(MSG_B, RESTRICTED_B);
  place(MSG_REVIEW, REVIEW_ONLY);
  place(MSG_EXCLUDED, EXCLUDED);
  place(MSG_THREAD_A, THREAD_A);
}

/** Seed channels and messages together. */
export function seedPrivacyFixture(db: DatabaseSync): void {
  seedPrivacyChannels(db);
  seedPrivacyMessages(db);
}
