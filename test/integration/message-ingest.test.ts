import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeMessage, normalizeMessageUpdate } from '../../src/discord/normalize.js';
import {
  ingestMessageCreate,
  ingestMessageUpdate,
  ingestMessageDelete,
} from '../../src/discord/ingest.js';
import { getMessage } from '../../src/db/repositories/messages.js';
import {
  AUTHOR,
  CHANNEL,
  GUILD,
  NOW,
  opts,
  rawMessage,
  ftsMatches,
  reactionCount,
} from '../helpers/messages.js';
import { upsertGuildMember } from '../../src/db/repositories/users.js';

describe('message ingest — idempotent persistence', () => {
  let env: TestDb;
  let db: DatabaseSync;
  beforeEach(() => {
    env = createTestDb();
    db = env.db;
    seedIdentity(db);
  });

  it('persists a message, its author, membership, and display name', () => {
    const m = normalizeMessage(rawMessage());
    const res = ingestMessageCreate(db, m, opts());
    expect(res.changed).toBe(true);

    const row = getMessage(db, m.id)!;
    expect(row.author_display_name).toBe('Alice');
    expect(row.content).toBe(m.content);
    expect(row.deleted_at_ms).toBeNull();
    expect(row.ingested_at_ms).toBe(NOW);

    const member = db
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(GUILD, AUTHOR);
    expect(member).toBeDefined();
  });

  it('does not replace existing member metadata with message-observation placeholders', () => {
    upsertGuildMember(db, {
      guildId: GUILD,
      userId: AUTHOR,
      displayName: 'Stored Alice',
      roleIdsJson: '["admin"]',
      updatedAtMs: NOW - 1,
    });

    ingestMessageCreate(db, normalizeMessage(rawMessage()), opts());

    expect(db.prepare('SELECT display_name, role_ids_json, updated_at_ms FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(GUILD, AUTHOR)).toEqual({
      display_name: 'Stored Alice', role_ids_json: '["admin"]', updated_at_ms: NOW - 1,
    });
  });

  it('is a no-op on an identical re-delivery (no updated_at bump, no FTS churn)', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    const first = getMessage(db, m.id)!;

    const res = ingestMessageCreate(db, m, opts());
    expect(res.changed).toBe(false);

    const second = getMessage(db, m.id)!;
    expect(second.updated_at_ms).toBe(first.updated_at_ms);
    expect(second.content).toBe(first.content);
    expect(ftsMatches(db, 'shipXuniq')).toBe(true);
  });

  it('a changed re-delivery updates content and the FTS index', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    expect(ftsMatches(db, 'shipXuniq')).toBe(true);

    const edited = normalizeMessage(rawMessage({ content: 'We decided to cancelXuniq the trial.' }));
    const res = ingestMessageCreate(db, edited, opts());
    expect(res.changed).toBe(true);

    expect(ftsMatches(db, 'shipXuniq')).toBe(false);
    expect(ftsMatches(db, 'cancelXuniq')).toBe(true);
  });

  it('an explicit delete prevents a later REST create from resurrecting content', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());
    ingestMessageDelete(db, m.id, opts());
    expect(getMessage(db, m.id)!.deleted_at_ms).not.toBeNull();
    expect(ftsMatches(db, 'shipXuniq')).toBe(false);

    // A stale REST page cannot override the explicit delete event.
    const res = ingestMessageCreate(db, m, opts());
    expect(res.changed).toBe(false);
    expect(getMessage(db, m.id)!.deleted_at_ms).not.toBeNull();
    expect(ftsMatches(db, 'shipXuniq')).toBe(false);
  });

  it('applies a partial update and is a no-op when fields already match', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());

    const patch = normalizeMessageUpdate({
      id: m.id,
      channel_id: CHANNEL,
      pinned: true,
      flags: 4,
    });
    const res = ingestMessageUpdate(db, patch, opts());
    expect(res.applied).toBe(true);
    expect(getMessage(db, m.id)!.pinned).toBe(1);
    expect(getMessage(db, m.id)!.flags).toBe(4);

    // Re-applying the identical patch is a no-op.
    const again = ingestMessageUpdate(db, patch, opts());
    expect(again.applied).toBe(false);
  });

  it('honors absent (keep) vs present (set) vs null (clear) on updates', () => {
    const m = normalizeMessage(rawMessage());
    ingestMessageCreate(db, m, opts());

    // Absent content must not overwrite (Section 9.4).
    const keep = normalizeMessageUpdate({ id: m.id, channel_id: CHANNEL, pinned: true });
    ingestMessageUpdate(db, keep, opts());
    expect(getMessage(db, m.id)!.content).toBe(m.content);

    // Present content overrides.
    const set = normalizeMessageUpdate({
      id: m.id,
      channel_id: CHANNEL,
      content: 'updatedXuniq content here',
    });
    ingestMessageUpdate(db, set, opts());
    expect(getMessage(db, m.id)!.content).toBe('updatedXuniq content here');
    expect(ftsMatches(db, 'updatedXuniq')).toBe(true);

    // Null edited_timestamp clears the field.
    const cleared = normalizeMessageUpdate({ id: m.id, channel_id: CHANNEL, edited_timestamp: null });
    ingestMessageUpdate(db, cleared, opts({ now: NOW + 1 }));
    expect(getMessage(db, m.id)!.edited_at_ms).toBeNull();
  });

  it('ignores a partial update for an unseen message', () => {
    const patch = normalizeMessageUpdate({
      id: '999999999999999999',
      channel_id: CHANNEL,
      content: 'x',
    });
    const res = ingestMessageUpdate(db, patch, opts());
    expect(res.applied).toBe(false);
    expect(res.unknownMessage).toBe(true);
  });

  it('persists REST reaction counts idempotently (backfill source)', () => {
    const m = normalizeMessage(
      rawMessage({
        reactions: [
          { count: 3, me: false, emoji: { id: null, name: '👍' } },
          { count: 1, me: true, emoji: { id: '555', name: 'gold' } },
        ],
      }),
    );
    ingestMessageCreate(db, m, opts());
    expect(reactionCount(db, m.id, '👍')).toBe(3);
    expect(reactionCount(db, m.id, 'gold:555')).toBe(1);

    // Re-delivering identical counts leaves them unchanged (idempotent).
    ingestMessageCreate(db, m, opts());
    expect(reactionCount(db, m.id, '👍')).toBe(3);

    // A full REST message is an authoritative aggregate snapshot.
    const changed = normalizeMessage(
      rawMessage({ reactions: [{ count: 5, me: false, emoji: { id: null, name: '👍' } }] }),
    );
    ingestMessageCreate(db, changed, opts());
    expect(reactionCount(db, m.id, '👍')).toBe(5);
    expect(reactionCount(db, m.id, 'gold:555')).toBeUndefined();
  });

  it('advances the channel last_message_id only forward', () => {
    const older = normalizeMessage(
      rawMessage({ id: '200000000000000001', timestamp: '2024-05-01T11:00:00.000+00:00' }),
    );
    const newer = normalizeMessage(
      rawMessage({ id: '200000000000000002', timestamp: '2024-05-01T12:30:00.000+00:00' }),
    );
    ingestMessageCreate(db, older, opts());
    expect(
      (db.prepare('SELECT last_message_id FROM channels WHERE id = ?').get(CHANNEL) as {
        last_message_id: string;
      }).last_message_id,
    ).toBe('200000000000000001');

    ingestMessageCreate(db, newer, opts());
    expect(
      (db.prepare('SELECT last_message_id FROM channels WHERE id = ?').get(CHANNEL) as {
        last_message_id: string;
      }).last_message_id,
    ).toBe('200000000000000002');

    // An older re-delivery must not rewind the cursor.
    ingestMessageCreate(db, older, opts());
    expect(
      (db.prepare('SELECT last_message_id FROM channels WHERE id = ?').get(CHANNEL) as {
        last_message_id: string;
      }).last_message_id,
    ).toBe('200000000000000002');
  });

  it("skips attachment metadata rows when mode is 'none'", () => {
    const m = normalizeMessage(
      rawMessage({
        attachments: [
          { id: '300000000000000001', filename: 'plan.txt', content_type: 'text/plain', size: 10 },
        ],
      }),
    );
    ingestMessageCreate(db, m, opts({ attachmentMode: 'none' }));
    expect(
      (db.prepare('SELECT COUNT(*) n FROM attachments WHERE message_id = ?').get(m.id) as { n: number })
        .n,
    ).toBe(0);

    ingestMessageCreate(db, m, opts({ attachmentMode: 'metadata' }));
    expect(
      (db.prepare('SELECT COUNT(*) n FROM attachments WHERE message_id = ?').get(m.id) as { n: number })
        .n,
    ).toBe(1);
  });
});
