import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import type { NormalizedMessage, NormalizedMention } from '../../src/platform/types.js';
import {
  findDirectMention,
  mentionsMneme,
  enqueueDirectAnswerForMention,
  directAnswerJobKey,
  DIRECT_ANSWER_PRIORITY,
} from '../../src/ingestion/mentions.js';
import {
  DIRECT_ANSWER_DEADLINE_MS,
  getDirectAnswerRequest,
} from '../../src/db/repositories/direct-answers.js';

/**
 * Explicit Mneme mention detection and direct-answer scheduling (Sections 11.2,
 * 26).
 *
 * Acceptance: one real mention creates one high-priority job and never changes the
 * current channel's visibility grant.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded by seedIdentity
const MNEME = '100000000000000010';
const OTHER_USER = '100000000000000099';
const NOW = 1_700_000_001_000;

function mention(id: string, name = id): NormalizedMention {
  return { id, username: name.toLowerCase(), globalName: name };
}

function msg(over: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    channelId: CHANNEL,
    guildId: GUILD,
    author: { id: '100000000000000003', username: 'alice', globalName: 'Alice', isBot: false },
    isWebhook: false,
    content: 'hey',
    createdAtMs: NOW,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentions: [],
    embeds: [],
    components: [],
    poll: null,
    attachments: [],
    reactionCounts: [],
    raw: null,
    ...over,
  };
}

function directAnswerJobs(db: DatabaseSync): { unique_key: string; priority: number; payload_json: string; status: string; max_attempts: number }[] {
  return db
    .prepare("SELECT unique_key, priority, payload_json, status, max_attempts FROM jobs WHERE type = 'direct_answer' ORDER BY created_at_ms")
    .all() as { unique_key: string; priority: number; payload_json: string; status: string; max_attempts: number }[];
}

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

describe('findDirectMention — entity-based detection', () => {
  it('detects a real Mneme mention entity', () => {
    const m = findDirectMention(msg({ id: 'm1', mentions: [mention(MNEME, 'Mneme')] }), MNEME);
    expect(m).toEqual({ messageId: 'm1', channelId: CHANNEL, guildId: GUILD });
  });

  it('never matches a textual lookalike when no mention entity is present', () => {
    // Content says "@Mneme" but Discord parsed no mention entity for the bot id.
    const m = findDirectMention(msg({ id: 'm2', content: '@Mneme what do you think?' }), MNEME);
    expect(m).toBeNull();
  });

  it('ignores mentions of other users', () => {
    const m = findDirectMention(msg({ id: 'm3', mentions: [mention(OTHER_USER, 'bob')] }), MNEME);
    expect(m).toBeNull();
  });

  it('finds Mneme among several mention entities', () => {
    const m = findDirectMention(
      msg({ id: 'm4', mentions: [mention(OTHER_USER, 'bob'), mention(MNEME, 'Mneme')] }),
      MNEME,
    );
    expect(m?.messageId).toBe('m4');
  });

  it('returns null when there are no mentions', () => {
    expect(findDirectMention(msg({ id: 'm5' }), MNEME)).toBeNull();
  });
});

describe('mentionsMneme', () => {
  it('is true only when the mneme id is among parsed entities', () => {
    expect(mentionsMneme([mention(MNEME)], MNEME)).toBe(true);
    expect(mentionsMneme([mention(OTHER_USER)], MNEME)).toBe(false);
    expect(mentionsMneme([], MNEME)).toBe(false);
  });
});

describe('enqueueDirectAnswerForMention', () => {
  it('creates one high-priority job pinned to the current channel for a real mention', () => {
    const res = enqueueDirectAnswerForMention(
      msg({ id: 'm1', mentions: [mention(MNEME, 'Mneme')] }),
      { db, mnemeId: MNEME, now: NOW },
    );
    expect(res.enqueued).toBe(true);
    expect(res.mention?.messageId).toBe('m1');

    const jobs = directAnswerJobs(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.priority).toBe(DIRECT_ANSWER_PRIORITY);
    expect(jobs[0]!.priority).toBeLessThan(100); // higher priority than ordinary jobs
    expect(jobs[0]!.unique_key).toBe(directAnswerJobKey('m1'));
    expect(jobs[0]!.status).toBe('queued');
    expect(jobs[0]!.max_attempts).toBe(2);
    expect(JSON.parse(jobs[0]!.payload_json)).toEqual({ messageId: 'm1', channelId: CHANNEL });
    expect(getDirectAnswerRequest(db, 'm1')).toMatchObject({
      jobId: expect.any(String),
      guildId: GUILD,
      targetChannelId: CHANNEL,
      questionCreatedAtMs: NOW,
      deadlineAtMs: NOW + DIRECT_ANSWER_DEADLINE_MS,
      outcomeKind: 'pending',
    });
  });

  it('deduplicates by source message id: a repeat mention enqueues nothing new', () => {
    const message = msg({ id: 'm1', mentions: [mention(MNEME, 'Mneme')] });
    const first = enqueueDirectAnswerForMention(message, { db, mnemeId: MNEME, now: NOW });
    const second = enqueueDirectAnswerForMention(
      { ...message, createdAtMs: NOW + 999_999 },
      { db, mnemeId: MNEME, now: NOW + 1000 },
    );
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false); // active unique key collapsed the duplicate
    expect(directAnswerJobs(db)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM direct_answer_requests').get()).toEqual({ n: 1 });
    expect(getDirectAnswerRequest(db, 'm1')).toMatchObject({
      questionCreatedAtMs: NOW,
      deadlineAtMs: NOW + DIRECT_ANSWER_DEADLINE_MS,
    });
  });

  it('repairs a pending request when Discord redelivers after its first job is terminal', () => {
    const message = msg({ id: 'm-terminal-redelivery', mentions: [mention(MNEME)] });
    const first = enqueueDirectAnswerForMention(message, { db, mnemeId: MNEME, now: NOW });
    expect(first.enqueued).toBe(true);
    const firstJobId = getDirectAnswerRequest(db, message.id)?.jobId;
    db.prepare("UPDATE jobs SET status='succeeded', completed_at_ms=? WHERE type='direct_answer'")
      .run(NOW + 1);

    const repeated = enqueueDirectAnswerForMention(message, {
      db,
      mnemeId: MNEME,
      now: NOW + 1_000,
    });

    expect(repeated.enqueued).toBe(true);
    expect(directAnswerJobs(db)).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM direct_answer_requests').get()).toEqual({ n: 1 });
    expect(getDirectAnswerRequest(db, message.id)?.jobId).not.toBe(firstJobId);
  });

  it('does not recreate work when the durable request is already terminal', () => {
    const message = msg({ id: 'm-terminal-request-redelivery', mentions: [mention(MNEME)] });
    const first = enqueueDirectAnswerForMention(message, { db, mnemeId: MNEME, now: NOW });
    expect(first.enqueued).toBe(true);
    db.prepare(`UPDATE direct_answer_requests
      SET outcome_kind='suppressed', reason_category='target_invalid',
          completed_at_ms=?, updated_at_ms=?
      WHERE source_message_id=?`).run(NOW + 1, NOW + 1, message.id);
    db.prepare("UPDATE jobs SET status='succeeded', completed_at_ms=? WHERE type='direct_answer'")
      .run(NOW + 1);

    const repeated = enqueueDirectAnswerForMention(message, {
      db,
      mnemeId: MNEME,
      now: NOW + 1_000,
    });

    expect(repeated.enqueued).toBe(false);
    expect(directAnswerJobs(db)).toHaveLength(1);
  });

  it('rolls back the job when durable request creation fails', () => {
    db.exec(`CREATE TRIGGER reject_direct_request BEFORE INSERT ON direct_answer_requests
      BEGIN SELECT RAISE(ABORT, 'simulated request failure'); END`);

    expect(() => enqueueDirectAnswerForMention(
      msg({ id: 'm-request-fails', mentions: [mention(MNEME)] }),
      { db, mnemeId: MNEME, now: NOW },
    )).toThrow('simulated request failure');

    expect(directAnswerJobs(db)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM direct_answer_requests').get()).toEqual({ n: 0 });
  });

  it('honors DIRECT_ANSWER_ENABLED=false: detects the mention but queues no job', () => {
    const res = enqueueDirectAnswerForMention(
      msg({ id: 'm1', mentions: [mention(MNEME, 'Mneme')] }),
      { db, mnemeId: MNEME, now: NOW, enabled: false },
    );
    expect(res.enqueued).toBe(false);
    expect(res.mention?.messageId).toBe('m1'); // still detected
    expect(directAnswerJobs(db)).toHaveLength(0);
  });

  it('blocks self, ordinary bot, and webhook mentions while permitting an allowlisted bot', () => {
    const cases = [
      msg({ id: 'self', author: { id: MNEME, username: 'mneme', globalName: 'Mneme', isBot: true }, mentions: [mention(MNEME)] }),
      msg({ id: 'bot', author: { id: OTHER_USER, username: 'bot', globalName: 'Bot', isBot: true }, mentions: [mention(MNEME)] }),
      msg({ id: 'webhook', isWebhook: true, mentions: [mention(MNEME)] }),
    ];
    for (const message of cases) {
      expect(enqueueDirectAnswerForMention(message, {
        db,
        mnemeId: MNEME,
        now: NOW,
      }).enqueued).toBe(false);
    }

    const allowlisted = msg({
      id: 'allowlisted-bot',
      author: { id: OTHER_USER, username: 'bot', globalName: 'Bot', isBot: true },
      mentions: [mention(MNEME)],
    });
    expect(enqueueDirectAnswerForMention(allowlisted, {
      db,
      mnemeId: MNEME,
      now: NOW,
      allowlistedBotIds: new Set([OTHER_USER]),
    }).enqueued).toBe(true);
    expect(directAnswerJobs(db)).toHaveLength(1);
  });

  it('creates no job for a non-mention message', () => {
    const res = enqueueDirectAnswerForMention(
      msg({ id: 'm1', content: '@Mneme lookalike', mentions: [] }),
      { db, mnemeId: MNEME, now: NOW },
    );
    expect(res.enqueued).toBe(false);
    expect(res.mention).toBeNull();
    expect(directAnswerJobs(db)).toHaveLength(0);
  });

  it('never changes the current channel visibility grant or policy', () => {
    // Seed a restricted channel with a known policy and one access audit.
    db.prepare(
      `INSERT INTO channels (id, workspace_id, parent_id, type, name, is_thread, is_archived, is_locked,
         ingest_enabled, visibility_class, allow_interventions, permission_fingerprint,
         last_message_id, discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json)
       VALUES (?, ?, NULL, 0, 'secret', 0, 0, 0, 1, 'restricted', 0, 'fp', NULL, ?, ?, NULL, NULL)`,
    ).run('200000000000000555', GUILD, NOW, NOW);

    enqueueDirectAnswerForMention(
      msg({ id: 'm1', channelId: '200000000000000555', mentions: [mention(MNEME, 'Mneme')] }),
      { db, mnemeId: MNEME, now: NOW },
    );

    const ch = db.prepare('SELECT visibility_class, ingest_enabled, allow_interventions FROM channels WHERE id = ?').get('200000000000000555') as { visibility_class: string; ingest_enabled: number; allow_interventions: number };
    // The mention did not widen visibility, enable interventions, or touch policy.
    expect(ch.visibility_class).toBe('restricted');
    expect(ch.ingest_enabled).toBe(1);
    expect(ch.allow_interventions).toBe(0);
    // No new access audits and no policy rows were written by the enqueue.
    const audits = db.prepare('SELECT COUNT(*) AS n FROM channel_access_audits WHERE channel_id = ?').get('200000000000000555') as { n: number };
    expect(audits.n).toBe(0);
  });
});
