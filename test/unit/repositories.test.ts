import { describe, it, expect } from 'vitest';
import { upsertGuild, getGuild } from '../../src/db/repositories/workspaces.js';
import { upsertChannel, getChannel, tombstoneChannel } from '../../src/db/repositories/channels.js';
import {
  ensureObservedGuildMember,
  ensureObservedUser,
  getUser,
  upsertGuildMember,
  upsertUser,
} from '../../src/db/repositories/users.js';
import { createTestDb } from '../helpers/db.js';
import type { DatabaseSync } from '../../src/db/database.js';

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002';
const USER = '100000000000000003';

function seed(db: DatabaseSync): void {
  upsertGuild(db, {
    id: GUILD,
    name: 'Guild',
    ownerId: null,
    joinedAtMs: null,
    discoveredAtMs: 1000,
    updatedAtMs: 1000,
    rawJson: null,
  });
  upsertChannel(db, {
    id: CHANNEL,
    guildId: GUILD,
    parentId: null,
    kind: 'text',
    name: 'general',
    topic: null,
    position: 0,
    isThread: false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: 'org',
    allowInterventions: true,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: 1000,
    updatedAtMs: 1000,
    rawJson: null,
  });
  upsertUser(db, {
    id: USER,
    username: 'alice',
    globalName: 'Alice',
    isBot: false,
    firstSeenAtMs: 1000,
    lastSeenAtMs: 1000,
    rawJson: null,
  });
}

describe('guild repository', () => {
  it('is a no-op on repeated identical input', () => {
    const t = createTestDb();
    seed(t.db);
    const before = getGuild(t.db, GUILD)!.updated_at_ms;
    const changes = upsertGuild(t.db, {
      id: GUILD,
      name: 'Guild',
      ownerId: null,
      joinedAtMs: null,
      discoveredAtMs: 9999,
      updatedAtMs: 2000,
      rawJson: null,
    });
    expect(changes).toBe(0);
    expect(getGuild(t.db, GUILD)!.updated_at_ms).toBe(before);
    t.cleanup();
  });

  it('updates only on changed fields and preserves discovered_at_ms', () => {
    const t = createTestDb();
    seed(t.db);
    const changes = upsertGuild(t.db, {
      id: GUILD,
      name: 'Renamed Guild',
      ownerId: '200000000000000002',
      joinedAtMs: 5000,
      discoveredAtMs: 9999,
      updatedAtMs: 3000,
      rawJson: null,
    });
    expect(changes).toBe(1);
    const row = getGuild(t.db, GUILD)!;
    expect(row.name).toBe('Renamed Guild');
    expect(row.discovered_at_ms).toBe(1000);
    expect(row.updated_at_ms).toBe(3000);
    t.cleanup();
  });
});

describe('channel repository', () => {
  it('tombstones on deletion and preserves referential history', () => {
    const t = createTestDb();
    seed(t.db);
    const changed = tombstoneChannel(t.db, CHANNEL, 5000);
    expect(changed).toBe(1);
    const tombstoned = getChannel(t.db, CHANNEL)!;
    expect(tombstoned.deleted_at_ms).toBe(5000);
    // Tombstoning twice is a no-op.
    expect(tombstoneChannel(t.db, CHANNEL, 6000)).toBe(0);
    t.cleanup();
  });

  it('clears the tombstone on rediscovery', () => {
    const t = createTestDb();
    seed(t.db);
    tombstoneChannel(t.db, CHANNEL, 5000);
    upsertChannel(t.db, {
      id: CHANNEL,
      guildId: GUILD,
      parentId: null,
      kind: 'text',
      name: 'general',
      topic: null,
      position: 0,
      isThread: false,
      isArchived: false,
      isLocked: false,
      ingestEnabled: true,
      visibilityClass: 'org',
      allowInterventions: true,
      permissionFingerprint: null,
      lastMessageId: null,
      discoveredAtMs: 9999,
      updatedAtMs: 7000,
      rawJson: null,
    });
    const resurrected = getChannel(t.db, CHANNEL)!;
    expect(resurrected.deleted_at_ms).toBeNull();
    expect(resurrected.updated_at_ms).toBe(7000);
    expect(resurrected.discovered_at_ms).toBe(1000);
    t.cleanup();
  });

  it('records a policy update (visibility change)', () => {
    const t = createTestDb();
    seed(t.db);
    const changes = upsertChannel(t.db, {
      id: CHANNEL,
      guildId: GUILD,
      parentId: null,
      kind: 'text',
      name: 'general',
      topic: null,
      position: 0,
      isThread: false,
      isArchived: false,
      isLocked: false,
      ingestEnabled: false,
      visibilityClass: 'excluded',
      allowInterventions: false,
      permissionFingerprint: 'fp-1',
      lastMessageId: null,
      discoveredAtMs: 9999,
      updatedAtMs: 8000,
      rawJson: null,
    });
    expect(changes).toBe(1);
    const row = getChannel(t.db, CHANNEL)!;
    expect(row.visibility_class).toBe('excluded');
    expect(row.ingest_enabled).toBe(0);
    t.cleanup();
  });
});

describe('user and member repository', () => {
  it('is a no-op on identical user input but advances last_seen when observed later', () => {
    const t = createTestDb();
    seed(t.db);
    expect(
      upsertUser(t.db, {
        id: USER,
        username: 'alice',
        globalName: 'Alice',
        isBot: false,
        firstSeenAtMs: 9999,
        lastSeenAtMs: 1000, // same as seed
        rawJson: null,
      }),
    ).toBe(0);
    expect(
      upsertUser(t.db, {
        id: USER,
        username: 'alice',
        globalName: 'Alice',
        isBot: false,
        firstSeenAtMs: 9999,
        lastSeenAtMs: 9000,
        rawJson: null,
      }),
    ).toBe(1);
    const row = getUser(t.db, USER)!;
    expect(row.last_seen_at_ms).toBe(9000);
    expect(row.first_seen_at_ms).toBe(1000);
    t.cleanup();
  });

  it('upserts guild members idempotently', () => {
    const t = createTestDb();
    seed(t.db);
    const input = {
      guildId: GUILD,
      userId: USER,
      displayName: 'Alice',
      roleIdsJson: '["r1"]',
      updatedAtMs: 1000,
    };
    expect(upsertGuildMember(t.db, input)).toBe(1);
    expect(upsertGuildMember(t.db, input)).toBe(0);
    expect(upsertGuildMember(t.db, { ...input, roleIdsJson: '["r2"]', updatedAtMs: 2000 })).toBe(1);
    t.cleanup();
  });

  it('keeps explicit full-profile updates able to clear values', () => {
    const t = createTestDb();
    seed(t.db);
    upsertUser(t.db, {
      id: USER,
      username: null,
      globalName: null,
      isBot: true,
      firstSeenAtMs: 9999,
      lastSeenAtMs: 2000,
      rawJson: null,
    });
    expect(getUser(t.db, USER)).toMatchObject({ username: null, global_name: null, is_bot: 1 });
    t.cleanup();
  });

  it('inserts partial-observation placeholders but preserves known identity and membership', () => {
    const t = createTestDb();
    seed(t.db);
    upsertGuildMember(t.db, {
      guildId: GUILD,
      userId: USER,
      displayName: 'Alice Member',
      roleIdsJson: '["r1"]',
      updatedAtMs: 1000,
    });

    ensureObservedUser(t.db, { id: USER, observedAtMs: 900 });
    ensureObservedGuildMember(t.db, { guildId: GUILD, userId: USER, observedAtMs: 900 });
    expect(getUser(t.db, USER)).toMatchObject({
      username: 'alice', global_name: 'Alice', is_bot: 0, first_seen_at_ms: 1000, last_seen_at_ms: 1000,
    });
    expect(t.db.prepare('SELECT display_name, role_ids_json, updated_at_ms FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(GUILD, USER)).toEqual({ display_name: 'Alice Member', role_ids_json: '["r1"]', updated_at_ms: 1000 });

    ensureObservedUser(t.db, { id: '100000000000000004', observedAtMs: 2000 });
    ensureObservedGuildMember(t.db, { guildId: GUILD, userId: '100000000000000004', observedAtMs: 2000 });
    expect(getUser(t.db, '100000000000000004')).toMatchObject({
      username: null, global_name: null, is_bot: 0, first_seen_at_ms: 2000, last_seen_at_ms: 2000,
    });
    t.cleanup();
  });
});
