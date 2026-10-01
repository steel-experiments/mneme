import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  recordAdminEvent,
  getAdminEvent,
  countAdminEvents,
  sanitizeAdminDetails,
} from '../../src/db/repositories/admin-events.js';
import { authorizeAdmin, requireAdmin, AuthorizationDeniedError, authorizeAndAuditAdminAction } from '../../src/policy/authorization.js';
import { extractMemberRoleIds } from '../../src/platform/discord/authorization.js';

/**
 * Admin-role authorization and auditing (Sections 6.6, 27, 44).
 */

const GUILD = '100000000000000001';
const ACTOR = '100000000000000010';
const NOW = 1_700_000_000_000;
const ADMIN_ROLES = ['900000000000000001', '900000000000000002'];

let env: TestDb;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db); // creates the FK guild row
});

describe('admin authorization decisions', () => {
  it('authorizes a member holding a configured admin role', () => {
    expect(authorizeAdmin(['1', '900000000000000001'], ADMIN_ROLES)).toEqual({
      authorized: true,
      reason: 'ok',
    });
  });

  it('denies a member with no admin role', () => {
    expect(authorizeAdmin(['1', '2'], ADMIN_ROLES)).toEqual({
      authorized: false,
      reason: 'not_authorized',
    });
  });

  it('fails closed when no admin roles are configured', () => {
    // Even a member who would otherwise qualify is denied.
    expect(authorizeAdmin(['900000000000000001'], [])).toEqual({
      authorized: false,
      reason: 'no_admin_roles_configured',
    });
  });

  it('fails closed when role data is unavailable (null, not empty)', () => {
    expect(authorizeAdmin(null, ADMIN_ROLES)).toEqual({
      authorized: false,
      reason: 'role_data_unavailable',
    });
    expect(authorizeAdmin(undefined, ADMIN_ROLES).reason).toBe('role_data_unavailable');
    // A resolved-but-empty array is a real "no admin role", not missing data.
    expect(authorizeAdmin([], ADMIN_ROLES).reason).toBe('not_authorized');
  });
});

describe('requireAdmin', () => {
  it('returns the outcome when authorized and throws otherwise', () => {
    expect(requireAdmin(['900000000000000001'], ADMIN_ROLES).authorized).toBe(true);
    const err = (() => {
      try {
        requireAdmin(['1'], ADMIN_ROLES);
      } catch (e) {
        return e as AuthorizationDeniedError;
      }
    })();
    expect(err).toBeInstanceOf(AuthorizationDeniedError);
    expect(err!.outcome.reason).toBe('not_authorized');
  });
});

describe('member role extraction', () => {
  it('reads role ids from a discord.js-style member and returns null when unavailable', () => {
    const member = { roles: { cache: { keys: () => ['r1', 'r2'].values() } } };
    expect(extractMemberRoleIds(member)).toEqual(['r1', 'r2']);
    expect(extractMemberRoleIds({ roles: { cache: {} } })).toBeNull();
    expect(extractMemberRoleIds(null)).toBeNull();
  });
});

describe('admin-event detail sanitization', () => {
  it('redacts secret- and content-shaped keys and caps string length', () => {
    const out = sanitizeAdminDetails({
      proposalId: 'p-1',
      token: 'supersecret',
      apiKey: 'k',
      content: 'the actual message body',
      prompt: 'system prompt',
      nested: { secret: 'x', ok: 'fine' },
      long: 'x'.repeat(1000),
    });
    expect(out.proposalId).toBe('p-1');
    expect(out.token).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
    expect(out.content).toBe('[redacted]');
    expect(out.prompt).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).secret).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).ok).toBe('fine');
    expect((out.long as string).length).toBeLessThan(300);
    expect((out.long as string).endsWith('…')).toBe(true);
  });

  it('handles null and arrays without throwing', () => {
    expect(sanitizeAdminDetails(null)).toEqual({});
    expect(sanitizeAdminDetails(undefined)).toEqual({});
    const out = sanitizeAdminDetails({ ids: ['a', { token: 't' }] });
    expect(out.ids).toEqual(['a', { token: '[redacted]' }]);
  });
});

describe('admin-event persistence', () => {
  it('records and reads back an event with sanitized details', () => {
    const id = recordAdminEvent(env.db, {
      guildId: GUILD,
      actorUserId: ACTOR,
      action: 'backup',
      target: null,
      details: { note: 'manual', token: 'leak' },
      createdAtMs: NOW,
    });
    expect(id).toBeTruthy();
    const row = getAdminEvent(env.db, id);
    expect(row?.action).toBe('backup');
    expect(row?.actorUserId).toBe(ACTOR);
    const details = JSON.parse(row!.detailsJson);
    expect(details.token).toBe('[redacted]');
    expect(details.note).toBe('manual');
  });
});

describe('authorize + audit', () => {
  it('records authorized successes and denials, both auditable', () => {
    const ok = authorizeAndAuditAdminAction(env.db, {
      memberRoleIds: ['900000000000000001'],
      adminRoleIds: ADMIN_ROLES,
      guildId: GUILD,
      actorUserId: ACTOR,
      action: 'approve_proposal',
      target: 'prop-7',
      details: { token: 'should-not-leak' },
      now: NOW,
    });
    expect(ok.authorized).toBe(true);

    const denied = authorizeAndAuditAdminAction(env.db, {
      memberRoleIds: ['nope'],
      adminRoleIds: ADMIN_ROLES,
      guildId: GUILD,
      actorUserId: '100000000000000011',
      action: 'approve_proposal',
      target: 'prop-8',
      now: NOW + 1,
    });
    expect(denied.authorized).toBe(false);
    expect(denied.reason).toBe('not_authorized');

    expect(countAdminEvents(env.db, GUILD)).toBe(2);
    const one = countAdminEvents(env.db, GUILD, { fromMs: NOW, toMs: NOW });
    expect(one).toBe(1);
  });

  it('folds the decision into details and never persists secrets', () => {
    authorizeAndAuditAdminAction(env.db, {
      memberRoleIds: null, // role data unavailable -> fail closed
      adminRoleIds: ADMIN_ROLES,
      guildId: GUILD,
      actorUserId: ACTOR,
      action: 'force_sync',
      target: 'channel-9',
      details: { token: 'leak', content: 'hidden message' },
      now: NOW,
    });
    const rows = env.db
      .prepare('SELECT details_json FROM admin_events WHERE action = ?')
      .all('force_sync') as Array<{ details_json: string }>;
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0]!.details_json);
    expect(details.authorized).toBe(false);
    expect(details.reason).toBe('role_data_unavailable');
    expect(details.token).toBe('[redacted]');
    expect(details.content).toBe('[redacted]');
  });
});
