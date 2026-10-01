import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel, tombstoneChannel, type ChannelUpsertInput, type VisibilityClass } from '../../src/db/repositories/channels.js';
import {
  generateMcpTokenValue,
  hashMcpTokenValue,
  createMcpToken,
  resolveMcpToken,
  MCP_TOKEN_BYTES,
  DEFAULT_MCP_TOKEN_TTL_MS,
  type McpTokenRequest,
  type CreateMcpTokenOutcome,
} from '../../src/mcp/auth.js';
import {
  listMcpTokens,
  getMcpToken,
  revokeMcpToken,
} from '../../src/db/repositories/mcp-tokens.js';

/**
 * MCP bearer-token issuance and hashing (Sections 27, 32.5.2, 44).
 *
 * Acceptance — verbatim: "Plain tokens never enter SQLite or logs and token
 * creation rejects unknown, excluded, or review-only scope."
 *
 * The suite proves the four guarantees together: the plaintext is generated once
 * and stored only as a SHA-256 hash (round-trip + raw file scan), it never
 * reaches the SQLite files or console output, the safe row exposes no
 * secret-shaped key, and every disallowed grant (unknown / excluded /
 * review-only / deleted / non-restricted channel, bad scope, past expiry, blank
 * name) is rejected before any row is written.
 */

const GUILD = '100000000000000001';
const ACTOR = '100000000000000003'; // the user seedIdentity creates
const NOW = 1_700_000_000_000;
const FUTURE = NOW + 86_400_000;

const RESTRICTED_A = '200000000000000001';
const RESTRICTED_B = '200000000000000002';
const ORG_CHANNEL = '200000000000000003';
const EXCLUDED_CHANNEL = '200000000000000004';
const REVIEW_ONLY_CHANNEL = '200000000000000005';

let env: TestDb;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD); // guild + a restricted 'general' channel + the ACTOR user
  upsertChannel(env.db, channel(RESTRICTED_A, 'restricted'));
  upsertChannel(env.db, channel(RESTRICTED_B, 'restricted'));
  upsertChannel(env.db, channel(ORG_CHANNEL, 'org'));
  upsertChannel(env.db, channel(EXCLUDED_CHANNEL, 'excluded'));
  upsertChannel(env.db, channel(REVIEW_ONLY_CHANNEL, 'review_only'));
});

afterEach(() => {
  env.cleanup();
});

function channel(id: string, visibility: VisibilityClass): ChannelUpsertInput {
  return {
    id,
    guildId: GUILD,
    parentId: null,
    kind: 'text',
    name: id,
    topic: null,
    position: null,
    isThread: false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: visibility,
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  };
}

function req(over: Partial<McpTokenRequest> = {}): McpTokenRequest {
  return { name: 'ci-bot', createdByUserId: ACTOR, ...over };
}

function create(over: Partial<McpTokenRequest> = {}): CreateMcpTokenOutcome {
  return createMcpToken({ db: env.db, nowMs: NOW }, req(over));
}

function storedHash(): string {
  const row = env.db.prepare('SELECT token_hash AS h FROM mcp_tokens').get() as { h: string } | undefined;
  return row?.h ?? '';
}

describe('token generation and hashing', () => {
  it('generates a 256-bit base64url value (43 chars, URL-safe) that differs each call', () => {
    const a = generateMcpTokenValue();
    const b = generateMcpTokenValue();
    expect(MCP_TOKEN_BYTES).toBe(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes the exact presented string with SHA-256 (hex), distinct from the value', () => {
    const value = generateMcpTokenValue();
    const hash = hashMcpTokenValue(value);
    expect(hash).toBe(createHash('sha256').update(value).digest('hex'));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(value);
  });
});

describe('issuance round-trip', () => {
  it('creates an org-scoped token and resolves it back to the same grant', () => {
    const outcome = create();
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    const { token, row } = outcome;

    expect(row.scopeType).toBe('org');
    expect(row.channelIds).toEqual([]);
    expect(row.createdByUserId).toBe(ACTOR);
    expect(row.createdAtMs).toBe(NOW);
    expect(row.lastUsedAtMs).toBeNull();
    expect(row.revokedAtMs).toBeNull();

    const resolved = resolveMcpToken({ db: env.db, nowMs: NOW }, token);
    expect(resolved).toEqual({ kind: 'valid', row, grant: { scopeType: 'org', channelIds: [] } });
  });

  it('creates an org_plus_channels token granting only the named restricted channels', () => {
    const outcome = create({ channelIds: [RESTRICTED_A, RESTRICTED_B] });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.scopeType).toBe('org_plus_channels');
    expect(outcome.row.channelIds).toEqual([RESTRICTED_A, RESTRICTED_B]);

    const resolved = resolveMcpToken({ db: env.db, nowMs: NOW }, outcome.token);
    expect(resolved.kind).toBe('valid');
    if (resolved.kind !== 'valid') return;
    expect(resolved.grant.channelIds).toEqual([RESTRICTED_A, RESTRICTED_B]);
  });

  it('dedupes repeated channel ids and trims a whitespace-padded name', () => {
    const outcome = create({ name: '  ci-bot  ', channelIds: [RESTRICTED_A, RESTRICTED_A, RESTRICTED_B] });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.name).toBe('ci-bot');
    expect(outcome.row.channelIds).toEqual([RESTRICTED_A, RESTRICTED_B]);
  });

  it('normalizes an explicitly restricted thread grant to its parent scope anchor', () => {
    const threadId = '200000000000000099';
    upsertChannel(env.db, {
      ...channel(threadId, 'restricted'),
      parentId: ORG_CHANNEL,
      kind: 'thread',
      isThread: true,
    });
    const outcome = create({ channelIds: [threadId] });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.channelIds).toEqual([ORG_CHANNEL]);
    const resolved = resolveMcpToken({ db: env.db, nowMs: NOW }, outcome.token);
    expect(resolved.kind).toBe('valid');
    if (resolved.kind !== 'valid') return;
    expect(resolved.grant.channelIds).toEqual([ORG_CHANNEL]);
  });
});

describe('expiry defaults to the 90-day lifetime (Section 32.5.2)', () => {
  it('applies the default lifetime when no expiry is requested', () => {
    const outcome = create();
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.expiresAtMs).toBe(NOW + DEFAULT_MCP_TOKEN_TTL_MS);
  });

  it('honors an explicit future expiry', () => {
    const outcome = create({ expiresAtMs: FUTURE });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.expiresAtMs).toBe(FUTURE);
  });

  it('issues a non-expiring token only on an explicit null', () => {
    const outcome = create({ expiresAtMs: null });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.row.expiresAtMs).toBeNull();
  });

  it('rejects a default-lifetime token once that lifetime has passed', () => {
    const outcome = create();
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    const resolved = resolveMcpToken(
      { db: env.db, nowMs: NOW + DEFAULT_MCP_TOKEN_TTL_MS },
      outcome.token,
    );
    expect(resolved.kind).toBe('expired');
  });
});

describe('token creation rejects disallowed scope', () => {
  function reason(over: Partial<McpTokenRequest>): { reason: string; detail: string } | null {
    const o = create(over);
    return o.kind === 'invalid' ? { reason: o.reason, detail: o.detail } : null;
  }

  it('rejects an unknown channel id', () => {
    expect(reason({ channelIds: ['999999999999999999'] })?.reason).toBe('unknown_channel');
  });

  it('rejects an excluded channel', () => {
    expect(reason({ channelIds: [EXCLUDED_CHANNEL] })?.reason).toBe('excluded_channel');
  });

  it('rejects a review_only channel (never grantable)', () => {
    const r = reason({ channelIds: [REVIEW_ONLY_CHANNEL] });
    expect(r?.reason).toBe('review_only_channel');
    expect(r?.detail).toContain('review_only');
  });

  it('rejects an org channel as a non-restricted explicit grant', () => {
    expect(reason({ channelIds: [ORG_CHANNEL] })?.reason).toBe('non_restricted_channel');
  });

  it('rejects a deleted (tombstoned) channel', () => {
    tombstoneChannel(env.db, RESTRICTED_A, NOW);
    expect(reason({ channelIds: [RESTRICTED_A] })?.reason).toBe('deleted_channel');
  });

  it('rejects a blank name', () => {
    expect(reason({ name: '   ' })?.reason).toBe('empty_name');
    expect(reason({ name: '' })?.reason).toBe('empty_name');
  });

  it('rejects a past expiry', () => {
    expect(reason({ expiresAtMs: NOW })?.reason).toBe('past_expiry');
    expect(reason({ expiresAtMs: NOW - 1 })?.reason).toBe('past_expiry');
  });

  it('rejects org scope paired with explicit channels', () => {
    expect(reason({ scopeType: 'org', channelIds: [RESTRICTED_A] })?.reason).toBe('org_scope_with_channels');
  });

  it('rejects org_plus_channels scope with no channels', () => {
    expect(reason({ scopeType: 'org_plus_channels' })?.reason).toBe('org_plus_channels_requires_channels');
  });

  it('writes no row when the grant is rejected', () => {
    const before = listMcpTokens(env.db).length;
    expect(reason({ channelIds: [REVIEW_ONLY_CHANNEL] })?.reason).toBe('review_only_channel');
    expect(listMcpTokens(env.db).length).toBe(before);
  });
});

describe('plaintext never enters SQLite or logs', () => {
  it('stores only the SHA-256 hash; the plaintext is absent from the raw db file', () => {
    const outcome = create();
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    const { token } = outcome;

    // The stored hash is SHA-256 of the plaintext, and is not the plaintext.
    expect(storedHash()).toBe(hashMcpTokenValue(token));
    expect(storedHash()).not.toBe(token);

    // Flush WAL into the main file, then scan its bytes for the plaintext.
    env.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(env.path);
    expect(bytes.includes(Buffer.from(token, 'utf8'))).toBe(false);
    // The hash, by contrast, IS present.
    expect(bytes.includes(Buffer.from(storedHash(), 'utf8'))).toBe(true);
  });

  it('exposes no token/hash/secret field on the safe row', () => {
    const outcome = create();
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    const keys = Object.keys(outcome.row);
    expect(keys.some((k) => /token|hash|secret|value/i.test(k))).toBe(false);
  });

  it('emits no plaintext to stdout or stderr during creation', () => {
    const chunks: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const outcome = create();
      expect(outcome.kind).toBe('created');
      if (outcome.kind !== 'created') return;
      const emitted = chunks.join('');
      expect(emitted).not.toContain(outcome.token);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('resolution state: expiry, revocation, mismatch', () => {
  it('resolves a valid token and updates last_used_at_ms', () => {
    const created = create({ expiresAtMs: FUTURE });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    expect(getMcpToken(env.db, created.tokenId)?.lastUsedAtMs).toBeNull();

    const later = NOW + 1000;
    const resolved = resolveMcpToken({ db: env.db, nowMs: later }, created.token);
    expect(resolved.kind).toBe('valid');
    expect(getMcpToken(env.db, created.tokenId)?.lastUsedAtMs).toBe(later);
  });

  it('reports an expired token once expires_at_ms has passed', () => {
    const created = create({ expiresAtMs: FUTURE });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const past = FUTURE + 1;
    const resolved = resolveMcpToken({ db: env.db, nowMs: past }, created.token);
    expect(resolved.kind).toBe('expired');
  });

  it('reports a revoked token after revokeMcpToken', () => {
    const created = create();
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;

    const changes = revokeMcpToken(env.db, created.tokenId, NOW + 5);
    expect(changes).toBe(1);
    // Idempotent: revoking again is a no-op.
    expect(revokeMcpToken(env.db, created.tokenId, NOW + 6)).toBe(0);

    const resolved = resolveMcpToken({ db: env.db, nowMs: NOW + 7 }, created.token);
    expect(resolved.kind).toBe('revoked');
  });

  it('reports invalid for a wrong/unknown bearer value (no oracle detail)', () => {
    const resolved = resolveMcpToken({ db: env.db, nowMs: NOW }, 'not-a-real-token');
    expect(resolved).toEqual({ kind: 'invalid' });
    // An empty presentation is invalid too.
    expect(resolveMcpToken({ db: env.db, nowMs: NOW }, '')).toEqual({ kind: 'invalid' });
  });
});

describe('repository list/get/revoke (safe rows only)', () => {
  it('lists tokens oldest-first without exposing hashes', () => {
    const a = create({ name: 'first' });
    const b = create({ name: 'second', channelIds: [RESTRICTED_A] });
    expect(a.kind).toBe('created');
    expect(b.kind).toBe('created');

    const rows = listMcpTokens(env.db);
    expect(rows.map((r) => r.name)).toEqual(['first', 'second']);
    // Safe rows expose no token-derived material of any kind.
    expect(rows.every((r) => !Object.keys(r).some((k) => /token|hash|secret/i.test(k)))).toBe(true);

    const got = getMcpToken(env.db, (b as Extract<typeof b, { kind: 'created' }>).tokenId);
    expect(got?.name).toBe('second');
    expect(got?.scopeType).toBe('org_plus_channels');
  });
});
