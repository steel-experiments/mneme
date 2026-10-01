import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  getRuntimeModeOverride,
  setRuntimeModeOverride,
} from '../../src/runtime-state.js';
import {
  handleModeCommand,
  formatModeReply,
} from '../../src/discord/commands/mode.js';
import type { AutonomyMode } from '../../src/config.js';

const NOW = 1_700_000_001_000;
const ADMIN_ROLE = '900000000000000001';
const GUILD = '100000000000000001';

let env: TestDb;
let db: DatabaseSync;
let effectiveMode: AutonomyMode;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
  effectiveMode = 'review';
});
afterEach(() => env.cleanup());

function run(selection: string, confirmation: string | null = null, secureReviewReady = true) {
  return handleModeCommand({
    actorUserId: 'alice',
    guildId: GUILD,
    memberRoleIds: [ADMIN_ROLE],
    selection,
    confirmation,
  }, {
    db,
    adminRoleIds: [ADMIN_ROLE],
    configuredMode: 'review',
    currentMode: effectiveMode,
    secureReviewReady,
    nowMs: NOW,
    applyMode: (mode) => { effectiveMode = mode; },
  });
}

describe('/mneme mode', () => {
  it('applies and persists an observe override immediately', () => {
    const outcome = run('observe');
    expect(outcome).toMatchObject({ kind: 'done', previous: 'review', current: 'observe' });
    expect(effectiveMode).toBe('observe');
    expect(getRuntimeModeOverride(db)?.mode).toBe('observe');
    expect(formatModeReply(outcome)).toContain('survives redeploys');
  });

  it('clears the override and restores the Railway-configured mode', () => {
    setRuntimeModeOverride(db, { mode: 'observe', actorUserId: 'alice', now: NOW - 1 });
    effectiveMode = 'observe';
    const outcome = run('configured');
    expect(outcome).toMatchObject({ kind: 'done', current: 'review', source: 'configured' });
    expect(effectiveMode).toBe('review');
    expect(getRuntimeModeOverride(db)).toBeNull();
  });

  it('requires a secure review channel before broadening mode', () => {
    effectiveMode = 'observe';
    const outcome = run('review', null, false);
    expect(outcome).toEqual({ kind: 'review_channel_required', requested: 'review' });
    expect(effectiveMode).toBe('observe');
    expect(getRuntimeModeOverride(db)).toBeNull();
  });

  it('requires exact confirmation for autonomous mode', () => {
    expect(run('autonomous')).toEqual({ kind: 'confirmation_required' });
    expect(effectiveMode).toBe('review');
    const outcome = run('autonomous', 'AUTONOMOUS');
    expect(outcome).toMatchObject({ kind: 'done', current: 'autonomous' });
    expect(effectiveMode).toBe('autonomous');
  });

  it('fails closed to observe when a persisted mode value is corrupt', () => {
    db.prepare('INSERT INTO settings (key, value_json, updated_at_ms) VALUES (?, ?, ?)').run(
      'runtime_mode_override',
      '{"mode":"root"}',
      NOW,
    );
    expect(getRuntimeModeOverride(db)?.mode).toBe('observe');
  });

  it('rejects non-admin callers without changing state', () => {
    const outcome = handleModeCommand({
      actorUserId: 'mallory', guildId: GUILD, memberRoleIds: [], selection: 'observe', confirmation: null,
    }, {
      db, adminRoleIds: [ADMIN_ROLE], configuredMode: 'review', currentMode: 'review',
      secureReviewReady: true, nowMs: NOW, applyMode: (mode) => { effectiveMode = mode; },
    });
    expect(outcome.kind).toBe('not_authorized');
    expect(effectiveMode).toBe('review');
    expect(getRuntimeModeOverride(db)).toBeNull();
  });
});
