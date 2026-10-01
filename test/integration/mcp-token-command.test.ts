import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel, type ChannelUpsertInput, type VisibilityClass } from '../../src/db/repositories/channels.js';
import {
  handleMcpTokenCommand,
  formatMcpTokenReply,
  type HandleMcpTokenInput,
  type HandleMcpTokenDeps,
} from '../../src/commands/mcp-token.js';
import { resolveMcpToken, DEFAULT_MCP_TOKEN_TTL_MS } from '../../src/mcp/auth.js';
import { getMcpToken, listMcpTokens } from '../../src/db/repositories/mcp-tokens.js';

/**
 * `/mneme mcp-token create|list|revoke` integration suite (Sections 27,
 * 32.5.2).
 *
 * Acceptance — verbatim: "Only the creator interaction sees the token once and
 * revocation takes effect for the next request."
 *
 * The suite drives the command handler end to end against a seeded database and
 * asserts: the plaintext appears only in the `create` reply (never in `list`, the
 * audit log, or the stored row); authorization fails closed and is audited on
 * both denial and success; channel grants resolve from names; disallowed grants
 * are rejected before any row is written; and a revoked token is rejected by the
 * resolver on the very next request.
 */

const GUILD = '100000000000000001';
const ADMIN = '100000000000000010';
const OUTSIDER = '100000000000000011';
const ADMIN_ROLE = '900000000000000001';
const ADMIN_ROLES: readonly string[] = [ADMIN_ROLE];
const NOW = 1_700_000_001_000;

// seedIdentity creates the restricted 'general' channel (id ...002) and guild.
const GENERAL_ID = '100000000000000002';
const RESTRICTED_ENG = '200000000000000010'; // name: eng-private
const EXCLUDED_ID = '200000000000000020'; // name: excluded-1
const REVIEW_ONLY_ID = '200000000000000030'; // name: review-1

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db, GUILD);
  upsertChannel(db, channel(RESTRICTED_ENG, 'restricted', 'eng-private'));
  upsertChannel(db, channel(EXCLUDED_ID, 'excluded', 'excluded-1'));
  upsertChannel(db, channel(REVIEW_ONLY_ID, 'review_only', 'review-1'));
});

afterEach(() => {
  env.cleanup();
});

function channel(id: string, visibility: VisibilityClass, name: string): ChannelUpsertInput {
  return {
    id, guildId: GUILD, parentId: null, kind: 'text', name, topic: null, position: null,
    isThread: false, isArchived: false, isLocked: false, ingestEnabled: true,
    visibilityClass: visibility, allowInterventions: false, permissionFingerprint: null,
    lastMessageId: null, discoveredAtMs: NOW, updatedAtMs: NOW, rawJson: null,
  };
}

const ENDPOINT = 'https://mneme.example.com/mcp';

function deps(): HandleMcpTokenDeps {
  return { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW, endpointUrl: ENDPOINT };
}

function adminInput(subcommand: HandleMcpTokenInput['subcommand'], over: Partial<HandleMcpTokenInput> = {}): HandleMcpTokenInput {
  return { actorUserId: ADMIN, guildId: GUILD, memberRoleIds: [ADMIN_ROLE], subcommand, ...over };
}

function outsiderInput(subcommand: HandleMcpTokenInput['subcommand'], over: Partial<HandleMcpTokenInput> = {}): HandleMcpTokenInput {
  return { actorUserId: OUTSIDER, guildId: GUILD, memberRoleIds: [], subcommand, ...over };
}

function allAuditDetails(): string {
  const rows = db.prepare('SELECT details_json AS d FROM admin_events').all() as Array<{ d: string }> | undefined;
  return (rows ?? []).map((r) => r.d).join('\n');
}

describe('create: the token is shown once, only to the creator', () => {
  it('returns the plaintext in the create reply and stores only the hash', () => {
    const outcome = handleMcpTokenCommand(adminInput('create', { name: 'ci-bot' }), deps());
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;

    const reply = formatMcpTokenReply(outcome);
    expect(reply).toContain(outcome.token);
    expect(reply).toContain('shown once');

    // The stored row carries no plaintext or hash.
    const stored = getMcpToken(db, outcome.row.id);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(outcome.token);
  });

  it('names the endpoint URL so the client can be configured from the reply', () => {
    const outcome = handleMcpTokenCommand(adminInput('create', { name: 'ci-bot' }), deps());
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.endpointUrl).toBe(ENDPOINT);
    expect(formatMcpTokenReply(outcome)).toContain(`Endpoint: ${ENDPOINT}`);
  });

  it('omits the endpoint line when the URL is unknown', () => {
    const outcome = handleMcpTokenCommand(adminInput('create', { name: 'ci-bot' }), {
      db, adminRoleIds: ADMIN_ROLES, nowMs: NOW,
    });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.endpointUrl).toBeNull();
    expect(formatMcpTokenReply(outcome)).not.toContain('Endpoint:');
  });

  it('states that the endpoint is disabled without advertising its URL', () => {
    const outcome = handleMcpTokenCommand(adminInput('create', { name: 'later' }), {
      ...deps(), mcpEnabled: false,
    });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    const reply = formatMcpTokenReply(outcome);
    expect(outcome.endpointUrl).toBeNull();
    expect(reply).toContain('Endpoint: currently disabled');
    expect(reply).not.toContain(ENDPOINT);
  });

  it('resolves channel grants from comma-separated names', () => {
    const outcome = handleMcpTokenCommand(
      adminInput('create', { name: 'eng', channels: 'eng-private, general' }),
      deps(),
    );
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.scopeType).toBe('org_plus_channels');
    expect(outcome.row.channelIds).toEqual([RESTRICTED_ENG, GENERAL_ID]);
  });

  it('rejects an ambiguous channel name and requires an exact ID', () => {
    const duplicateId = '200000000000000011';
    upsertChannel(db, channel(duplicateId, 'restricted', 'eng-private'));
    const ambiguous = handleMcpTokenCommand(
      adminInput('create', { name: 'ambiguous', channels: 'eng-private' }),
      deps(),
    );
    expect(ambiguous).toMatchObject({ kind: 'create_invalid', reason: 'ambiguous_channel' });
    expect(listMcpTokens(db)).toHaveLength(0);

    const exact = handleMcpTokenCommand(
      adminInput('create', { name: 'exact', channels: duplicateId }),
      deps(),
    );
    expect(exact.kind).toBe('created');
    if (exact.kind === 'created') expect(exact.row.channelIds).toEqual([duplicateId]);
  });

  it('defaults to org scope when no channels are requested', () => {
    const outcome = handleMcpTokenCommand(adminInput('create', { name: 'org-only' }), deps());
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.scopeType).toBe('org');
    expect(outcome.row.channelIds).toEqual([]);
  });

  it('applies the 90-day default expiry when expires-days is omitted', () => {
    const outcome = handleMcpTokenCommand(adminInput('create', { name: 'ci-bot' }), deps());
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.expiresAtMs).toBe(NOW + DEFAULT_MCP_TOKEN_TTL_MS);
  });

  it('honors an explicit expires-days', () => {
    const outcome = handleMcpTokenCommand(
      adminInput('create', { name: 'short-lived', expiresDays: 7 }),
      deps(),
    );
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.expiresAtMs).toBe(NOW + 7 * 86_400_000);
  });

  it('rejects out-of-range or fractional expires-days before writing any row', () => {
    const before = listMcpTokens(db).length;
    for (const bad of [0, -1, 366, 1.5]) {
      const outcome = handleMcpTokenCommand(
        adminInput('create', { name: 'bad-expiry', expiresDays: bad }),
        deps(),
      );
      expect(outcome.kind).toBe('create_invalid');
      if (outcome.kind !== 'create_invalid') continue;
      expect(outcome.reason).toBe('invalid_expiry_days');
    }
    expect(listMcpTokens(db).length).toBe(before);
  });

  it('rejects a review_only channel grant before writing any row', () => {
    const before = listMcpTokens(db).length;
    const outcome = handleMcpTokenCommand(
      adminInput('create', { name: 'bad', channels: 'review-1' }),
      deps(),
    );
    expect(outcome.kind).toBe('create_invalid');
    if (outcome.kind !== 'create_invalid') return;
    expect(outcome.reason).toBe('review_only_channel');
    expect(listMcpTokens(db).length).toBe(before);
  });

  it('never writes the plaintext into the audit log', () => {
    const outcome = handleMcpTokenCommand(adminInput('create', { name: 'ci-bot' }), deps());
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(allAuditDetails()).not.toContain(outcome.token);
  });
});

describe('list: metadata only, never the token', () => {
  it('lists scope/expiry/last-use metadata and omits every token value', () => {
    const a = handleMcpTokenCommand(adminInput('create', { name: 'first' }), deps());
    const b = handleMcpTokenCommand(adminInput('create', { name: 'second', channels: 'eng-private' }), deps());
    expect(a.kind).toBe('created');
    expect(b.kind).toBe('created');
    if (a.kind !== 'created' || b.kind !== 'created') return;

    const list = handleMcpTokenCommand(adminInput('list'), deps());
    expect(list.kind).toBe('list');
    if (list.kind !== 'list') return;

    const reply = formatMcpTokenReply(list);
    expect(reply).toContain('first');
    expect(reply).toContain('second');
    expect(reply).toContain('org+1ch');
    // No plaintext token from either creation appears in the list reply.
    expect(reply).not.toContain(a.token);
    expect(reply).not.toContain(b.token);
  });

  it('reports an empty table cleanly', () => {
    const list = handleMcpTokenCommand(adminInput('list'), deps());
    expect(formatMcpTokenReply(list)).toContain('No MCP tokens');
  });
});

describe('revoke: takes effect for the next request', () => {
  it('revokes a token so the resolver rejects it immediately afterward', () => {
    const created = handleMcpTokenCommand(adminInput('create', { name: 'doomed' }), deps());
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const { token, row } = created;

    // Valid before revocation.
    expect(resolveMcpToken({ db, nowMs: NOW }, token).kind).toBe('valid');

    const revoked = handleMcpTokenCommand(adminInput('revoke', { tokenId: row.id }), deps());
    expect(revoked.kind).toBe('revoked');
    expect(formatMcpTokenReply(revoked)).toContain('invalid for the next request');

    // Acceptance: revocation takes effect for the next request.
    expect(resolveMcpToken({ db, nowMs: NOW + 1 }, token).kind).toBe('revoked');
  });

  it('accepts the short id displayed by the list command', () => {
    const created = handleMcpTokenCommand(adminInput('create', { name: 'short-id' }), deps());
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;

    const listed = formatMcpTokenReply(handleMcpTokenCommand(adminInput('list'), deps()));
    const shortId = created.row.id.slice(0, 8);
    expect(listed).toContain(shortId);

    const revoked = handleMcpTokenCommand(adminInput('revoke', { tokenId: shortId }), deps());
    expect(revoked.kind).toBe('revoked');
    expect(resolveMcpToken({ db, nowMs: NOW + 1 }, created.token).kind).toBe('revoked');
  });

  it('reports not_found for an unknown token id', () => {
    const outcome = handleMcpTokenCommand(adminInput('revoke', { tokenId: 'no-such-token' }), deps());
    expect(outcome.kind).toBe('not_found');
    expect(formatMcpTokenReply(outcome)).toContain('No MCP token');
  });

  it('is idempotent: revoking an already-revoked token stays revoked', () => {
    const created = handleMcpTokenCommand(adminInput('create', { name: 'once' }), deps());
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;

    const first = handleMcpTokenCommand(adminInput('revoke', { tokenId: created.row.id }), deps());
    const second = handleMcpTokenCommand(adminInput('revoke', { tokenId: created.row.id }), deps());
    expect(first.kind).toBe('revoked');
    expect(second.kind).toBe('revoked');
    if (second.kind !== 'revoked') return;
    expect(second.alreadyRevoked).toBe(true);
  });
});

describe('authorization: fail closed, audited both ways', () => {
  it('denies an outsider and records the denial without issuing a token', () => {
    const before = listMcpTokens(db).length;
    const outcome = handleMcpTokenCommand(outsiderInput('create', { name: 'sneaky' }), deps());
    expect(outcome.kind).toBe('not_authorized');
    expect(formatMcpTokenReply(outcome)).toContain('not authorized');
    expect(listMcpTokens(db).length).toBe(before);

    // The denial is in the audit log.
    const rows = db
      .prepare("SELECT details_json AS d FROM admin_events WHERE action = 'mcp_token_create'")
      .all() as Array<{ d: string }> | undefined;
    const denied = (rows ?? []).some((r) => r.d.includes('"authorized":false'));
    expect(denied).toBe(true);
  });

  it('records a successful create in the audit log as authorized', () => {
    handleMcpTokenCommand(adminInput('create', { name: 'audited' }), deps());
    const rows = db
      .prepare("SELECT details_json AS d FROM admin_events WHERE action = 'mcp_token_create'")
      .all() as Array<{ d: string }> | undefined;
    const allowed = (rows ?? []).some((r) => r.d.includes('"authorized":true'));
    expect(allowed).toBe(true);
  });

  it('denies list and revoke to an outsider too', () => {
    // Seed a token as an admin first so there is something to list/revoke.
    const created = handleMcpTokenCommand(adminInput('create', { name: 'exists' }), deps());
    expect(created.kind).toBe('created');

    expect(handleMcpTokenCommand(outsiderInput('list'), deps()).kind).toBe('not_authorized');
    if (created.kind !== 'created') return;
    expect(handleMcpTokenCommand(outsiderInput('revoke', { tokenId: created.row.id }), deps()).kind).toBe(
      'not_authorized',
    );
    // Outsider could not revoke: the token is still valid.
    expect(resolveMcpToken({ db, nowMs: NOW }, created.token).kind).toBe('valid');
  });
});
