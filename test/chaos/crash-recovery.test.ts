import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { rawMessage, opts, GUILD, NOW } from '../helpers/messages.js';
import { ingestMessagePage } from '../../src/ingestion/ingest.js';
import { normalizeMessage } from '../../src/platform/discord/normalize.js';
import { transaction } from '../../src/db/database.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';

/**
 * Section 46.5 chaos case 1 — "kill the process during a page insert".
 *
 * A page of messages is ingested inside one transaction. If the process dies
 * (here: a write fails midway, modelled as an FK violation on one message in the
 * page) the whole page rolls back — no partial episode, no orphaned messages.
 * Recovery is to re-run the page after restart; every persist is idempotent, so
 * the re-run neither loses data nor creates duplicates.
 *
 * Recovery verdict: no silent corruption; safe to retry; no privacy leak (the
 * transaction boundary holds regardless of message content).
 */

const CHANNEL = '100000000000000002'; // seeded by seedIdentity

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

function countMessages(): number {
  return Number((db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c);
}

describe('Section 46.5 — kill during a page insert (atomicity + safe retry)', () => {
  it('rolls back the whole page when a write fails midway, leaving nothing partial', () => {
    // A page whose third message targets a channel that does not exist. With
    // foreign_keys = ON the third insert throws an FK violation INSIDE the page
    // transaction, standing in for a process kill mid-page.
    const page = [
      normalizeMessage(rawMessage({ id: '200000000000000001' })),
      normalizeMessage(rawMessage({ id: '200000000000000002' })),
      normalizeMessage({ ...rawMessage({ id: '200000000000000003' }), channel_id: 'no-such-channel' }),
    ];

    expect(() => ingestMessagePage(db, page, opts({ now: NOW }))).toThrow();

    // Verdict: zero partial commit. No message from this page survived.
    expect(countMessages()).toBe(0);
  });

  it('recovers by re-running the page: valid messages appear, re-runs are idempotent (no dupes)', () => {
    // First attempt fails midway (bad third message).
    const badPage = [
      normalizeMessage(rawMessage({ id: '200000000000000001' })),
      normalizeMessage(rawMessage({ id: '200000000000000003', channel_id: 'no-such-channel' })),
    ];
    expect(() => ingestMessagePage(db, badPage, opts({ now: NOW }))).toThrow();
    expect(countMessages()).toBe(0);

    // After "restart", re-ingest only the valid messages.
    const valid = [normalizeMessage(rawMessage({ id: '200000000000000001' }))];
    const first = ingestMessagePage(db, valid, opts({ now: NOW }));
    expect(first.messages).toBe(1);
    expect(countMessages()).toBe(1);

    // A second delivery of the same page (overlap after a retry) is a no-op:
    // upserts are keyed by id, so there are never duplicates.
    const again = ingestMessagePage(db, valid, opts({ now: NOW }));
    expect(again.changed).toBe(0);
    expect(countMessages()).toBe(1);
  });

  it('does not corrupt prior committed pages when a later page fails', () => {
    // A page committed successfully before the crash.
    const committed = [normalizeMessage(rawMessage({ id: '200000000000000010' }))];
    ingestMessagePage(db, committed, opts({ now: NOW }));
    expect(countMessages()).toBe(1);

    // A subsequent page fails midway.
    const failing = [
      normalizeMessage(rawMessage({ id: '200000000000000011' })),
      normalizeMessage(rawMessage({ id: '200000000000000012', channel_id: 'no-such-channel' })),
    ];
    expect(() => ingestMessagePage(db, failing, opts({ now: NOW }))).toThrow();

    // Verdict: the prior page is intact; the failed page left nothing behind.
    expect(countMessages()).toBe(1);
    const survivor = db
      .prepare('SELECT id FROM messages WHERE channel_id = ?')
      .all(CHANNEL) as Array<{ id: string }>;
    expect(survivor.map((r) => r.id)).toEqual(['200000000000000010']);
  });
});

/**
 * Section 46.5 chaos case 6 — "fill disk in a test environment".
 *
 * There is no bespoke ENOSPC handling: every write runs inside a
 * `transaction()`/`transactionImmediate()` BEGIN/COMMIT wrapper, so a write
 * failure (here: an exception thrown from the middle of a transaction, modelling
 * SQLITE_FULL) rolls the transaction back and rethrows. No partial state is
 * committed and prior data is untouched. Recovery verdict: fail safe, no silent
 * corruption; the operator frees disk and retries.
 */
describe('Section 46.5 — disk-full mid-transaction rolls back with no partial commit', () => {
  it('rolls back the whole transaction when a write fails (modelled SQLITE_FULL)', () => {
    // Prior committed data.
    upsertMessageCreate(db, {
      id: '200000000000000020',
      guildId: GUILD,
      channelId: CHANNEL,
      authorId: '100000000000000003',
      authorDisplayName: 'Alice',
      content: 'committed before the disk filled',
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
    expect(countMessages()).toBe(1);

    // A transaction that writes one row, then "hits ENOSPC" on the second.
    expect(() =>
      transaction(db, () => {
        upsertMessageCreate(db, {
          id: '200000000000000021',
          guildId: GUILD,
          channelId: CHANNEL,
          authorId: '100000000000000003',
          authorDisplayName: 'Alice',
          content: 'first of the doomed transaction',
          createdAtMs: NOW + 1,
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
          ingestedAtMs: NOW + 1,
          updatedAtMs: NOW + 1,
        });
        throw new Error('disk I/O error (SQLITE_FULL)');
      }),
    ).toThrow(/SQLITE_FULL/);

    // Verdict: neither row of the failed transaction committed; the survivor is intact.
    expect(countMessages()).toBe(1);
    const ids = (db.prepare('SELECT id FROM messages').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['200000000000000020']);
  });
});
