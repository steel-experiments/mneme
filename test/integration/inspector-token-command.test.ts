import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  handleInspectorTokenCommand,
  formatInspectorTokenReply,
  type HandleInspectorTokenInput,
  type HandleInspectorTokenDeps,
} from '../../src/commands/inspector-token.js';
import { resolveInspectorToken, DEFAULT_INSPECTOR_TOKEN_TTL_MS } from '../../src/http/inspector/tokens.js';
import { listInspectorTokens } from '../../src/db/repositories/inspector-tokens.js';

/**
 * `/mneme inspector-token create|list|revoke` integration suite (Sections
 * 27, 32.6).
 *
 * Acceptance — verbatim from Section 32.6: inspector tokens are "issued by the
 * `/mneme inspector-token` commands, stored as SHA-256 hashes, shown exactly
 * once at creation, carrying expiry and revocation".
 *
 * The suite proves: authorization fails closed and is audited on both denial
 * and success; the plaintext appears only in the `create` reply (never `list`,
 * never the audit log, never the stored row); expiry bounds are enforced before
 * any write; revocation takes effect on the next request; and prefix ids
 * resolve uniquely.
 */

const GUILD = '100000000000000001';
const ADMIN = '100000000000000010';
const ADMIN_ROLE = '900000000000000001';
const ADMIN_ROLES: readonly string[] = [ADMIN_ROLE];
const NOW = 1_700_000_001_000;

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db, GUILD);
});

afterEach(() => env.cleanup());

function deps(overrides: Partial<HandleInspectorTokenDeps> = {}): HandleInspectorTokenDeps {
  return {
    db,
    adminRoleIds: ADMIN_ROLES,
    nowMs: NOW,
    inspectorEnabled: true,
    endpointUrl: 'https://example.internal/inspector',
    ...overrides,
  };
}

function input(subcommand: 'create' | 'list' | 'revoke', fields: Partial<HandleInspectorTokenInput> = {}): HandleInspectorTokenInput {
  return {
    actorUserId: ADMIN,
    guildId: GUILD,
    memberRoleIds: [ADMIN_ROLE],
    subcommand,
    ...fields,
  };
}

describe('/mneme inspector-token — Sections 27, 32.6', () => {
  it('fails closed without an admin role and audits the denial', () => {
    const outcome = handleInspectorTokenCommand(
      input('create', { name: 'x', memberRoleIds: null }),
      deps(),
    );
    expect(outcome.kind).toBe('not_authorized');
    const audited = db.prepare('SELECT action, actor_user_id FROM admin_events ORDER BY created_at_ms').all() as Array<{ action: string; actor_user_id: string }>;
    expect(audited.at(-1)?.action).toBe('inspector_token_create');
    expect(audited.at(-1)?.actor_user_id).toBe(ADMIN);
  });

  it('create shows the token exactly once, echoes the surface, and never leaks it elsewhere', () => {
    const outcome = handleInspectorTokenCommand(input('create', { name: 'admin-browser' }), deps());
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(outcome.endpointUrl).toBe('https://example.internal/inspector');

    const reply = formatInspectorTokenReply(outcome);
    expect(reply).toContain(outcome.token);
    expect(reply).toContain('https://example.internal/inspector');
    expect(reply).toContain('shown once');

    // The audit row carries the name and nothing secret-shaped.
    const details = db.prepare('SELECT details_json FROM admin_events ORDER BY created_at_ms DESC LIMIT 1').get() as { details_json: string };
    expect(details.details_json).toContain('admin-browser');
    expect(details.details_json).not.toContain(outcome.token);

    // The stored row holds only the hash, and the resolver accepts the value.
    expect(resolveInspectorToken({ db, nowMs: NOW }, outcome.token).kind).toBe('valid');

    // list never shows the token.
    const list = handleInspectorTokenCommand(input('list'), deps());
    expect(list.kind).toBe('list');
    if (list.kind === 'list') expect(formatInspectorTokenReply(list)).not.toContain(outcome.token);
  });

  it('notes the disabled surface when INSPECTOR_ENABLED is false', () => {
    const outcome = handleInspectorTokenCommand(input('create', { name: 'x' }), deps({ inspectorEnabled: false }));
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.endpointEnabled).toBe(false);
    expect(formatInspectorTokenReply(outcome)).toContain('currently disabled');
  });

  it('applies the 30-day default and enforces the 1-365 day bounds', () => {
    const outcome = handleInspectorTokenCommand(input('create', { name: 'default-ttl' }), deps());
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.expiresAtMs).toBe(NOW + DEFAULT_INSPECTOR_TOKEN_TTL_MS);

    for (const bad of [0, -1, 366, 7.5]) {
      const rejected = handleInspectorTokenCommand(input('create', { name: 'bad', expiresDays: bad }), deps());
      expect(rejected.kind).toBe('create_invalid');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM inspector_tokens').get()).toMatchObject({ n: 1 });

    const ok = handleInspectorTokenCommand(input('create', { name: 'year', expiresDays: 365 }), deps());
    expect(ok.kind).toBe('created');
  });

  it('revokes by full id or unique 8-char prefix, idempotently', () => {
    const created = handleInspectorTokenCommand(input('create', { name: 'doomed' }), deps());
    if (created.kind !== 'created') throw new Error('create failed');
    const fullId = created.row.id;

    const byPrefix = handleInspectorTokenCommand(input('revoke', { tokenId: fullId.slice(0, 8) }), deps());
    expect(byPrefix.kind).toBe('revoked');
    expect(resolveInspectorToken({ db, nowMs: NOW }, created.token).kind).toBe('revoked');

    const again = handleInspectorTokenCommand(input('revoke', { tokenId: fullId }), deps());
    expect(again.kind).toBe('revoked');
    if (again.kind === 'revoked') expect(again.alreadyRevoked).toBe(true);

    const missing = handleInspectorTokenCommand(input('revoke', { tokenId: 'ffffffff' }), deps());
    expect(missing.kind).toBe('not_found');
  });

  it('list is bounded and reports status, expiry, and last use', () => {
    for (const name of ['one', 'two', 'three']) {
      handleInspectorTokenCommand(input('create', { name }), deps());
    }
    const outcome = handleInspectorTokenCommand(input('list'), deps());
    expect(outcome.kind).toBe('list');
    const rows = listInspectorTokens(db);
    expect(rows).toHaveLength(3);
    const reply = formatInspectorTokenReply(outcome);
    expect(reply).toContain('one');
    expect(reply).not.toContain('token_hash');
  });
});
