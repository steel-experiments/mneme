import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  handleSyncCommand,
  handleFlushEpisodesCommand,
  formatSyncReply,
  formatFlushReply,
} from '../../src/discord/commands/sync.js';
import { getJob, enqueue } from '../../src/jobs/queue.js';
import { RECONCILE_CHANNEL_KEY } from '../../src/jobs/scheduler.js';
import { countAdminEvents } from '../../src/db/repositories/admin-events.js';

/**
 * `/mneme sync [channel]` and the episode-flush operation (Sections 11.3, 27;
 * ).
 *
 * Acceptance: "Long sync work never blocks an interaction and duplicate requests
 * do not create duplicate active jobs." The commands enqueue durable, unique-keyed
 * jobs and return immediately; a repeated (or schedule-overlapping) request
 * collapses rather than piling up work.
 */

const GUILD = '100000000000000001';
const OTHER_GUILD = '999000000000000000';
const CHANNEL = '100000000000000002'; // seeded restricted channel
const ADMIN_ROLE = '900000000000000001';
const NOW = 1_700_000_001_000;

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

function seedChannel(id: string, cls: string, name: string, guild = GUILD): void {
  db.prepare(
    `INSERT INTO channels (id, workspace_id, parent_id, type, name, topic, position, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, permission_fingerprint, last_message_id,
       discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json)
     VALUES (?, ?, NULL, 0, ?, NULL, NULL, 0, 0, 0, 1, ?, 0, NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(id, guild, name, cls, NOW, NOW);
}

function seedThread(id: string, parentId: string, cls: string, name: string): void {
  seedChannel(id, cls, name);
  db.prepare('UPDATE channels SET parent_id=?, type=11, is_thread=1 WHERE id=?')
    .run(parentId, id);
}

function seedGuild(id: string, name = 'Other'): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, owner_id, joined_at_ms, discovered_at_ms, updated_at_ms, raw_json) VALUES (?,?,?,?,?,?,NULL)',
  ).run(id, name, null, NOW, NOW, NOW);
}

function seedEpisode(id: string, guild = GUILD, channel = CHANNEL): void {
  db.prepare(
    `INSERT INTO episodes (id, workspace_id, conversation_channel_id, status, started_at_ms, last_activity_at_ms, created_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, guild, channel, 'open', NOW, NOW, NOW, NOW);
}

const admin = () => ({ memberRoleIds: [ADMIN_ROLE] as readonly string[] });
const nonAdmin = () => ({ memberRoleIds: [] as readonly string[] });

describe('handleSyncCommand — authorization', () => {
  it('denies a non-admin, audits the denial, and enqueues nothing', () => {
    seedChannel('c-org', 'org', 'general');
    const out = handleSyncCommand(
      { actorUserId: 'bob', guildId: GUILD, channelId: 'c-org', ...nonAdmin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(out.kind).toBe('not_authorized');
    expect(countAdminEvents(db, GUILD)).toBe(1);
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'reconcile_channel'")
      .get() as { n: number };
    expect(active.n).toBe(0);
  });
});

describe('handleSyncCommand — reconcile (single channel)', () => {
  beforeEach(() => seedChannel('c-org', 'org', 'general'));

  it('enqueues a reconcile_channel job under the periodic key and returns its id', () => {
    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-org', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(out.kind).toBe('enqueued');
    if (out.kind !== 'enqueued') return;
    expect(out.full).toBe(false);
    expect(out.jobs).toHaveLength(1);
    const job = out.jobs[0]!;
    expect(job.targetId).toBe('c-org');
    expect(job.enqueued).toBe(true);
    expect(job.jobId).toBeTruthy();

    const row = getJob(db, job.jobId!)!;
    expect(row.type).toBe('reconcile_channel');
    expect(row.unique_key).toBe(RECONCILE_CHANNEL_KEY('c-org'));
    expect(row.status).toBe('queued');
    expect(JSON.parse(row.payload_json as string)).toEqual({ channelId: 'c-org' });
    expect(countAdminEvents(db, GUILD)).toBe(1);
  });

  it('collapses a duplicate request: second call enqueues nothing', () => {
    const first = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-org', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    const second = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-org', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    if (first.kind !== 'enqueued' || second.kind !== 'enqueued') throw new Error('expected enqueued');
    expect(first.jobs[0]!.enqueued).toBe(true);
    expect(second.jobs[0]!.enqueued).toBe(false);
    expect(second.jobs[0]!.jobId).toBeUndefined();
    // Exactly one active reconcile job exists for the channel.
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='reconcile_channel' AND unique_key=?")
        .get(RECONCILE_CHANNEL_KEY('c-org')) as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it('collapses against an already-active periodic schedule job (no duplicate)', () => {
    // Simulate the scheduler having already queued a periodic reconcile.
    enqueue(db, {
      type: 'reconcile_channel',
      payload: { channelId: 'c-org' },
      uniqueKey: RECONCILE_CHANNEL_KEY('c-org'),
      now: NOW,
    });
    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-org', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    expect(out.jobs[0]!.enqueued).toBe(false);
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='reconcile_channel' AND unique_key=?")
        .get(RECONCILE_CHANNEL_KEY('c-org')) as { n: number }
    ).n;
    expect(n).toBe(1);
  });
});

describe('handleSyncCommand — full backfill', () => {
  beforeEach(() => seedChannel('c-org', 'org', 'general'));

  it('enqueues a backfill_channel job under the admin backfill key', () => {
    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-org', full: true, ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    expect(out.full).toBe(true);
    const job = out.jobs[0]!;
    expect(job.enqueued).toBe(true);
    const row = getJob(db, job.jobId!)!;
    expect(row.type).toBe('backfill_channel');
    expect(row.unique_key).toBe('admin:backfill:channel:c-org');
  });
});

describe('handleSyncCommand — all channels', () => {
  beforeEach(() => {
    seedChannel('c-a', 'org', 'a');
    seedChannel('c-b', 'restricted', 'b');
    seedChannel('c-x', 'excluded', 'x');
  });

  it('syncs every non-deleted, non-excluded channel when none is named', () => {
    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    const targets = out.jobs.map((j) => j.targetId).sort();
    expect(targets).toEqual(['c-a', 'c-b', CHANNEL].sort());
    expect(out.jobs.every((j) => j.enqueued)).toBe(true);
    expect(out.jobs).toHaveLength(3);
  });

  it('skips a Mneme test channel and its normally named child thread', () => {
    seedChannel('c-mneme', 'org', 'mneme-test');
    seedThread('c-mneme-thread', 'c-mneme', 'org', 'ordinary-thread');

    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );

    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    expect(out.jobs.map((job) => job.targetId)).not.toContain('c-mneme');
    expect(out.jobs.map((job) => job.targetId)).not.toContain('c-mneme-thread');
  });
});

describe('handleSyncCommand — channel validation', () => {
  it('rejects a channel from another guild as channel_not_found', () => {
    seedGuild(OTHER_GUILD);
    seedChannel('c-other', 'org', 'other', OTHER_GUILD);
    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-other', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(out.kind).toBe('channel_not_found');
    const n = (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('rejects an excluded channel as channel_excluded', () => {
    seedChannel('c-x', 'excluded', 'secret');
    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-x', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(out.kind).toBe('channel_excluded');
    expect((out as { kind: string }).kind).toBe('channel_excluded');
  });

  it('rejects a normally named thread below a Mneme test channel', () => {
    seedChannel('c-mneme', 'org', 'mneme-test');
    seedThread('c-mneme-thread', 'c-mneme', 'org', 'ordinary-thread');

    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-mneme-thread', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );

    expect(out.kind).toBe('channel_excluded');
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='reconcile_channel'").get() as { n: number }).n).toBe(0);
  });

  it('treats a deleted channel as channel_not_found', () => {
    seedChannel('c-del', 'org', 'gone');
    db.prepare('UPDATE channels SET deleted_at_ms = ? WHERE id = ?').run(NOW, 'c-del');
    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-del', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(out.kind).toBe('channel_not_found');
  });

  it('formatSyncReply reports enqueued and collapsed counts without content', () => {
    seedChannel('c-a', 'org', 'a');
    const out = handleSyncCommand(
      { actorUserId: 'alice', guildId: GUILD, channelId: 'c-a', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    const text = formatSyncReply(out);
    expect(text).toContain('reconciliation');
    expect(text).toContain('1 channel');
    expect(text).not.toMatch(/token|secret|password/i);
  });
});

describe('handleFlushEpisodesCommand', () => {
  beforeEach(() => seedEpisode('ep-1'));

  it('denies a non-admin and audits without enqueuing', () => {
    const out = handleFlushEpisodesCommand(
      { actorUserId: 'bob', guildId: GUILD, episodeId: 'ep-1', ...nonAdmin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(out.kind).toBe('not_authorized');
    expect(countAdminEvents(db, GUILD)).toBe(1);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='close_episode'").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('enqueues a due-now close_episode job under the admin flush key', () => {
    const out = handleFlushEpisodesCommand(
      { actorUserId: 'alice', guildId: GUILD, episodeId: 'ep-1', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(out.kind).toBe('enqueued');
    if (out.kind !== 'enqueued') return;
    expect(out.targetId).toBe('ep-1');
    expect(out.enqueued).toBe(true);
    expect(out.jobId).toBeTruthy();

    const row = getJob(db, out.jobId!)!;
    expect(row.type).toBe('close_episode');
    expect(row.unique_key).toBe('admin:flush:episode:ep-1');
    expect(row.status).toBe('queued');
    expect(JSON.parse(row.payload_json as string)).toEqual({ episodeId: 'ep-1' });
    // Due immediately — no future run_after delay beyond now.
    expect(Number(row.run_after_ms)).toBeLessThanOrEqual(NOW);
  });

  it('collapses a duplicate flush without creating a second job', () => {
    const first = handleFlushEpisodesCommand(
      { actorUserId: 'alice', guildId: GUILD, episodeId: 'ep-1', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    const second = handleFlushEpisodesCommand(
      { actorUserId: 'alice', guildId: GUILD, episodeId: 'ep-1', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    if (first.kind !== 'enqueued' || second.kind !== 'enqueued') throw new Error('expected enqueued');
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='close_episode' AND unique_key=?")
        .get('admin:flush:episode:ep-1') as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it('rejects an episode from another guild as episode_not_found (audited)', () => {
    seedGuild(OTHER_GUILD);
    seedChannel('c-other', 'org', 'other', OTHER_GUILD);
    seedEpisode('ep-other', OTHER_GUILD, 'c-other');
    const out = handleFlushEpisodesCommand(
      { actorUserId: 'alice', guildId: GUILD, episodeId: 'ep-other', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(out.kind).toBe('episode_not_found');
    // Audited against the configured guild (the caller's scope), not the foreign one.
    expect(countAdminEvents(db, GUILD)).toBe(1);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='close_episode'").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('formatFlushReply reports status without content', () => {
    const out = handleFlushEpisodesCommand(
      { actorUserId: 'alice', guildId: GUILD, episodeId: 'ep-1', ...admin() },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    expect(formatFlushReply(out)).toContain('ep-1');
    expect(formatFlushReply(out)).not.toMatch(/token|secret|password/i);
  });
});
