import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  getPauseState,
  isPaused,
  setPaused,
} from '../../src/runtime-state.js';
import {
  handlePauseCommand,
  handleResumeCommand,
  formatPauseReply,
} from '../../src/commands/pause.js';
import { countAdminEvents } from '../../src/db/repositories/admin-events.js';
import { enqueue } from '../../src/jobs/queue.js';
import { JobWorker } from '../../src/jobs/worker.js';

/**
 * Durable pause and resume controls (Sections 27, 47).
 *
 * Acceptance: pause survives restart, ingestion continues while reviews and sends
 * are held, and resume safely releases the queued review/send work.
 */

const NOW = 1_700_000_001_000;
const ADMIN_ROLE = '900000000000000001';
const GUILD = '100000000000000001';

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
});
afterEach(() => env.cleanup());

describe('durable pause state', () => {
  it('is unpaused on a fresh database', () => {
    expect(isPaused(db)).toBe(false);
    expect(getPauseState(db)).toEqual({
      paused: false,
      pausedAtMs: null,
      pausedByUserId: null,
      updatedAtMs: 0,
    });
  });

  it('persists a pause with the actor and timestamp', () => {
    const state = setPaused(db, { paused: true, actorUserId: 'alice', now: NOW });
    expect(state).toEqual({
      paused: true,
      pausedAtMs: NOW,
      pausedByUserId: 'alice',
      updatedAtMs: NOW,
    });
    expect(isPaused(db)).toBe(true);
  });

  it('survives a restart (a fresh read returns the persisted state)', () => {
    setPaused(db, { paused: true, actorUserId: 'alice', now: NOW });
    // A new process re-reads the same settings row.
    expect(getPauseState(db).paused).toBe(true);
    // And the row is durable in the settings table.
    const row = db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('pause_state') as { value_json: string };
    expect(JSON.parse(row.value_json).paused).toBe(true);
  });

  it('clears the actor and timestamp on resume', () => {
    setPaused(db, { paused: true, actorUserId: 'alice', now: NOW });
    const state = setPaused(db, { paused: false, now: NOW + 1000 });
    expect(state.paused).toBe(false);
    expect(state.pausedAtMs).toBeNull();
    expect(state.pausedByUserId).toBeNull();
    expect(isPaused(db)).toBe(false);
  });

  it('fails open on a corrupted settings row (never locks into a pause)', () => {
    db.prepare('INSERT INTO settings (key, value_json, updated_at_ms) VALUES (?, ?, ?)').run(
      'pause_state',
      'not-json',
      NOW,
    );
    expect(isPaused(db)).toBe(false);
  });
});

describe('pause/resume commands', () => {
  it('pause: an admin sets the durable pause and is audited', () => {
    const outcome = handlePauseCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(outcome.kind).toBe('done');
    expect(outcome.already).toBe(false);
    expect(isPaused(db)).toBe(true);
    expect(getPauseState(db).pausedByUserId).toBe('alice');
    expect(countAdminEvents(db, GUILD)).toBe(1);
  });

  it('pause: a non-admin is denied without changing state, and the denial is audited', () => {
    const outcome = handlePauseCommand(
      { actorUserId: 'bob', guildId: GUILD, memberRoleIds: ['other'] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(outcome.kind).toBe('not_authorized');
    expect(isPaused(db)).toBe(false);
    expect(countAdminEvents(db, GUILD)).toBe(1);
  });

  it('pause: reports already-paused when the state was already paused', () => {
    handlePauseCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    const second = handlePauseCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW + 1 },
    );
    expect(second.kind).toBe('done');
    expect(second.already).toBe(true);
  });

  it('resume: an admin clears the pause and is audited', () => {
    setPaused(db, { paused: true, actorUserId: 'alice', now: NOW });
    const outcome = handleResumeCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW + 1 },
    );
    expect(outcome.kind).toBe('done');
    expect(outcome.already).toBe(false);
    expect(isPaused(db)).toBe(false);
    expect(countAdminEvents(db, GUILD)).toBe(1);
  });

  it('resume: a non-admin is denied and the pause stays in effect', () => {
    setPaused(db, { paused: true, actorUserId: 'alice', now: NOW });
    const outcome = handleResumeCommand(
      { actorUserId: 'bob', guildId: GUILD, memberRoleIds: [] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(outcome.kind).toBe('not_authorized');
    expect(isPaused(db)).toBe(true);
  });

  it('format replies carry no secrets and distinguish already/from states', () => {
    const paused = handlePauseCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW },
    );
    expect(formatPauseReply(paused)).toContain('paused');
    const again = handlePauseCommand(
      { actorUserId: 'alice', guildId: GUILD, memberRoleIds: [ADMIN_ROLE] },
      { db, adminRoleIds: [ADMIN_ROLE], nowMs: NOW + 1 },
    );
    expect(formatPauseReply(again)).toContain('already paused');
  });
});

describe('worker dispatch honors pause', () => {
  function makeWorker(pausedRef: { value: boolean }): JobWorker {
    return new JobWorker({
      db,
      owner: 'test-worker',
      leaseMs: 60_000,
      pollIntervalMs: 5,
      shutdownTimeoutMs: 1000,
      clock: () => NOW,
      isPaused: () => pausedRef.value,
    });
  }

  it('while paused, runs backfills but holds reviews and sends', async () => {
    const ran: string[] = [];
    const pausedRef = { value: true };
    const worker = makeWorker(pausedRef);
    worker.register('backfill_channel', 1, async () => {
      ran.push('backfill');
    });
    worker.register('review_episode', 1, async () => {
      ran.push('review');
    });
    worker.register('send_outbox', 1, async () => {
      ran.push('send');
    });

    enqueue(db, { type: 'backfill_channel', payload: { channelId: 'c1' }, now: NOW });
    enqueue(db, { type: 'review_episode', payload: { episodeId: 'e1' }, now: NOW });
    enqueue(db, { type: 'send_outbox', payload: { outboxId: 'o1' }, now: NOW });

    await worker.runOnce();

    // Ingestion ran; reviews and sends were held.
    expect(ran).toEqual(['backfill']);
    const statuses = db
      .prepare('SELECT type, status FROM jobs')
      .all() as Array<{ type: string; status: string }>;
    const byType = Object.fromEntries(statuses.map((s) => [s.type, s.status]));
    expect(byType['backfill_channel']).toBe('succeeded');
    expect(byType['review_episode']).toBe('queued');
    expect(byType['send_outbox']).toBe('queued');
  });

  it('resume safely releases the queued review and send work', async () => {
    const ran: string[] = [];
    const pausedRef = { value: true };
    const worker = makeWorker(pausedRef);
    worker.register('review_episode', 1, async () => {
      ran.push('review');
    });
    worker.register('send_outbox', 1, async () => {
      ran.push('send');
    });

    enqueue(db, { type: 'review_episode', payload: { episodeId: 'e1' }, now: NOW });
    enqueue(db, { type: 'send_outbox', payload: { outboxId: 'o1' }, now: NOW });

    await worker.runOnce(); // paused — nothing runs
    expect(ran).toEqual([]);

    // Resume: the predicate now reports unpaused, and the held work is released.
    pausedRef.value = false;
    await worker.runOnce();

    expect(ran.sort()).toEqual(['review', 'send']);
  });
});
