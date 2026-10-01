import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeMessage, normalizeMessageUpdate } from '../../src/platform/discord/normalize.js';
import {
  ingestMessageCreate,
  ingestMessageUpdate,
  ingestMessageDelete,
  ingestMessageDeleteBulk,
} from '../../src/ingestion/ingest.js';
import { getMessage } from '../../src/db/repositories/messages.js';
import { CHANNEL, NOW, opts, rawMessage, ftsMatches } from '../helpers/messages.js';

describe('message ingest — edit history and deletion', () => {
  let env: TestDb;
  let db: DatabaseSync;
  beforeEach(() => {
    env = createTestDb();
    db = env.db;
    seedIdentity(db);
  });

  it('captures prior content as a version only when RETAIN_EDIT_HISTORY is on', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());

    const v1 = ingestMessageUpdate(
      db,
      normalizeMessageUpdate({ id: m.id, channel_id: CHANNEL, content: 'secondXuniq version' }),
      opts({ retainEditHistory: false }),
    );
    expect(v1.editVersion).toBeUndefined();
    expect(
      (db.prepare('SELECT COUNT(*) n FROM message_versions WHERE message_id = ?').get(m.id) as {
        n: number;
      }).n,
    ).toBe(0);

    const v2 = ingestMessageUpdate(
      db,
      normalizeMessageUpdate({ id: m.id, channel_id: CHANNEL, content: 'thirdXuniq version' }),
      opts({ retainEditHistory: true, now: NOW + 2 }),
    );
    expect(v2.editVersion).toBe(1);
    const versions = db
      .prepare('SELECT version, content FROM message_versions WHERE message_id = ? ORDER BY version')
      .all(m.id) as Array<{ version: number; content: string }>;
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('secondXuniq version'); // the OLD content was captured
  });

  it('does not capture a version when the edit content is unchanged', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    const res = ingestMessageUpdate(
      db,
      normalizeMessageUpdate({ id: m.id, channel_id: CHANNEL, content: m.content }),
      opts({ retainEditHistory: true }),
    );
    expect(res.editVersion).toBeUndefined();
    expect(res.applied).toBe(false);
  });

  it('delete tombstones and removes content from FTS; blanking depends on retention', () => {
    const purge = normalizeMessage(rawMessage());
    ingestMessageCreate(db, purge, opts());
    expect(ftsMatches(db, 'shipXuniq')).toBe(true);

    ingestMessageDelete(db, purge.id, opts({ retainDeletedContent: false }));
    const purged = getMessage(db, purge.id)!;
    expect(purged.deleted_at_ms).toBe(NOW);
    expect(purged.content).toBe(''); // content purged
    expect(ftsMatches(db, 'shipXuniq')).toBe(false); // dropped from FTS

    const retain = normalizeMessage(
      rawMessage({ id: '200000000000000002', content: 'retainZuniq content here' }),
    );
    ingestMessageCreate(db, retain, opts());
    ingestMessageDelete(db, retain.id, opts({ retainDeletedContent: true, now: NOW + 5 }));
    const kept = getMessage(db, retain.id)!;
    expect(kept.deleted_at_ms).toBe(NOW + 5);
    expect(kept.content).toBe('retainZuniq content here'); // content retained
    expect(ftsMatches(db, 'retainZuniq')).toBe(false); // still removed from FTS
  });

  it('delete is idempotent (a repeat delete does not overwrite the tombstone time)', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    ingestMessageDelete(db, m.id, opts({ now: NOW }));
    const res = ingestMessageDelete(db, m.id, opts({ now: NOW + 9 }));
    expect(res.tombstoned).toBe(1);
    expect(getMessage(db, m.id)!.deleted_at_ms).toBe(NOW); // not overwritten
  });

  it('bulk delete tombstones each message', () => {
    const a = normalizeMessage(rawMessage({ id: '200000000000000010' }));
    const b = normalizeMessage(rawMessage({ id: '200000000000000011' }));
    ingestMessageCreate(db, a, opts());
    ingestMessageCreate(db, b, opts());
    const res = ingestMessageDeleteBulk(db, [a.id, b.id], opts());
    expect(res.tombstoned).toBe(2);
    expect(getMessage(db, a.id)!.deleted_at_ms).toBe(NOW);
    expect(getMessage(db, b.id)!.deleted_at_ms).toBe(NOW);
  });

  it('keeps an unknown delete authoritative over a later backfill payload', () => {
    const message = normalizeMessage(rawMessage({ id: '200000000000000099', content: 'neverReturnXuniq' }));
    ingestMessageDelete(db, message.id, opts({ now: NOW }), CHANNEL);
    const created = ingestMessageCreate(db, message, opts({ now: NOW + 1 }));
    expect(created.changed).toBe(false);
    expect(getMessage(db, message.id)).toBeUndefined();
    expect(ftsMatches(db, 'neverReturnXuniq')).toBe(false);
  });
});
