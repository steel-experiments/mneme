import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createMcpToken, resolveMcpToken } from '../../src/mcp/auth.js';
import { createRateLimiter } from '../../src/mcp/rate-limit.js';
import { getMcpToken, revokeMcpToken, listMcpTokens } from '../../src/db/repositories/mcp-tokens.js';
import { searchMessages, type RetrievalGrant } from '../../src/db/repositories/message-search.js';
import { getMessageContext } from '../../src/db/repositories/message-context.js';
import { createMemory, MemoryValidationError } from '../../src/memory/repository.js';
import { getMemoryDetails } from '../../src/memory/search.js';
import { evaluateProvenanceGate, type ProvenanceScopeEntry, type TargetScope } from '../../src/agent/policy.js';
import { createFinalizeDirectAnswerTool, RunFinalizationState } from '../../src/agent/tools/finalize.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  GUILD,
  USER,
  NOW,
  PUB,
  RESTRICTED_A,
  RESTRICTED_B,
  REVIEW_ONLY,
  MSG_PUB,
  MSG_A,
  MSG_THREAD_A,
  MSG_B,
  CANARY_A,
  CANARY_B,
  SEARCH_TERM,
  seedPrivacyFixture,
} from '../fixtures/privacy/seed.js';

/**
 * Mandatory end-to-end privacy matrix (Section 46.3; task T118).
 *
 * Acceptance — verbatim: "All ten Section 46.3 cases pass and any leak or hint
 * fails the suite."
 *
 * Each case asserts BOTH the absence of leaked results AND the absence of any
 * hint that hidden matching content exists (no oracles, no partial counts, no
 * distinctive canary substrings). The fixture uses a meaningless search term
 * ("meridian") with per-channel canary substrings so a leak is unambiguous.
 */

const ACTOR = USER;
const HOST = '127.0.0.1';
const PATH = '/mcp';

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
const CHANNEL_A_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RESTRICTED_A],
};
const CHANNEL_A_TARGET_GRANT: RetrievalGrant = {
  includeOrgMessages: false,
  includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RESTRICTED_A],
};
const CHANNEL_AB_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [RESTRICTED_A, RESTRICTED_B],
};
const REVIEW_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: true,
  channelIds: [RESTRICTED_A, RESTRICTED_B],
};

let env: TestDb;
const servers: HttpServerHandle[] = [];

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
  seedPrivacyFixture(env.db);
});

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  env.cleanup();
});

function idsOf(results: { messageId: string }[]): Set<string> {
  return new Set(results.map((r) => r.messageId));
}

/** Mount the MCP endpoint over HTTP; returns the base URL. */
async function mountMcp(now: () => number = () => NOW): Promise<string> {
  const mcp = createMcpServer({ db: env.db, rateLimiter: createRateLimiter({ limit: 60 }), now });
  const handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: createLogger(),
    mcpPath: PATH,
    mcpEnabled: true,
    mcpHandler: mcp.handler,
  });
  servers.push(handle);
  return `http://${HOST}:${handle.port}`;
}

async function mcpCall(base: string, token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: '1' }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function mcpResultText(result: Record<string, unknown>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join('\n');
}

// ---------------------------------------------------------------------------
// 1. A restricted-channel fact relevant to an org-channel discussion.
// ---------------------------------------------------------------------------

describe('46.3 case 1 — a restricted fact is not returned to an org-scoped run', () => {
  it('an org grant returns only org messages and never the restricted canary', () => {
    const r = searchMessages(env.db, ORG_GRANT, { query: SEARCH_TERM, now: NOW });
    expect(idsOf(r)).toEqual(new Set([MSG_PUB]));
    expect(r.some((m) => m.content.includes(CANARY_A))).toBe(false);
  });

  it('get_message_context for the restricted anchor is a generic rejection (no oracle)', () => {
    const ctx = getMessageContext(env.db, ORG_GRANT, { messageId: MSG_A });
    expect(ctx.anchor).toBeNull();
    // No channel id or existence hint leaks through the empty result.
    expect(JSON.stringify(ctx)).not.toContain(RESTRICTED_A);
  });
});

describe('7.3 restricted-target grant separates message and memory authority', () => {
  it('returns same-anchor messages and org memories without exposing org messages', () => {
    const orgMemoryId = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Meridian public decision.',
      confidence: 0.8,
      importance: 0.8,
      evidence: [{ messageId: MSG_PUB, stance: 'origin' }],
      now: NOW,
    });

    const messages = searchMessages(env.db, CHANNEL_A_TARGET_GRANT, {
      query: SEARCH_TERM,
      now: NOW,
    });
    expect(idsOf(messages)).toEqual(new Set([MSG_A, MSG_THREAD_A]));
    expect(messages.some((message) => message.messageId === MSG_PUB)).toBe(false);
    expect(getMemoryDetails(env.db, CHANNEL_A_TARGET_GRANT, orgMemoryId)?.statement)
      .toBe('Meridian public decision.');
  });
});

// ---------------------------------------------------------------------------
// 2. A memory with evidence from two restricted channels is review_only.
// ---------------------------------------------------------------------------

describe('46.3 case 2 — cross-restricted evidence collapses to review_only', () => {
  it('a memory backed by two restricted channels is review_only and hidden from narrower grants', () => {
    const id = createMemory(env.db, CHANNEL_AB_GRANT, {
      guildId: GUILD,
      type: 'risk',
      statement: 'Meridian cross-channel risk.',
      confidence: 0.6,
      importance: 0.6,
      evidence: [
        { messageId: MSG_A, stance: 'origin' },
        { messageId: MSG_B, stance: 'supports' },
      ],
      now: NOW,
    });
    // A review grant sees it and confirms the recomputed scope is review_only.
    const details = getMemoryDetails(env.db, REVIEW_GRANT, id);
    expect(details?.scopeType).toBe('review_only');
    // A single-channel grant and the org grant cannot see it.
    expect(getMemoryDetails(env.db, CHANNEL_A_GRANT, id)).toBeUndefined();
    expect(getMemoryDetails(env.db, ORG_GRANT, id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. The model invents a source id.
// ---------------------------------------------------------------------------

describe('46.3 case 3 — an invented evidence id is rejected and stores nothing', () => {
  it('createMemory throws MemoryValidationError for a non-existent evidence id', () => {
    expect(() =>
      createMemory(env.db, CHANNEL_A_GRANT, {
        guildId: GUILD,
        type: 'decision',
        statement: 'Meridian invented-source decision.',
        confidence: 0.7,
        importance: 0.6,
        evidence: [{ messageId: 'msg-invented-9999', stance: 'origin' }],
        now: NOW,
      }),
    ).toThrow(MemoryValidationError);
    // Nothing was persisted.
    const count = env.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The model paraphrases restricted evidence without citation.
// ---------------------------------------------------------------------------

describe('46.3 case 4 — uncited paraphrase of restricted content is forced to review', () => {
  const orgTarget: TargetScope = { channelId: PUB, visibility: 'org', isSecureReview: false };
  const reviewTarget: TargetScope = { channelId: REVIEW_ONLY, visibility: 'review_only', isSecureReview: true };

  it('a run that retrieved restricted content cannot emit to an org target (force_review)', () => {
    const provenance: ProvenanceScopeEntry[] = [
      { kind: 'channel', channelId: RESTRICTED_A, visibility: 'restricted' },
      { kind: 'channel', channelId: PUB, visibility: 'org' },
    ];
    // The proposal cites no restricted evidence, but the gate keys on what the
    // run actually retrieved — so the paraphrase is still caught (Section 7.4).
    const result = evaluateProvenanceGate({
      pinnedTargetChannelId: PUB,
      proposedTargetChannelId: PUB,
      target: orgTarget,
      provenance,
    });
    expect(result.outcome).toBe('force_review');
    expect(result.reasons.join(' ')).toContain('restricted');
  });

  it('a run that retrieved only org content is allowed to an org target', () => {
    const result = evaluateProvenanceGate({
      pinnedTargetChannelId: PUB,
      proposedTargetChannelId: PUB,
      target: orgTarget,
      provenance: [{ kind: 'channel', channelId: PUB, visibility: 'org' }],
    });
    expect(result.outcome).toBe('allow');
  });

  it('the secure-review target accepts all retrieved scopes', () => {
    const result = evaluateProvenanceGate({
      pinnedTargetChannelId: REVIEW_ONLY,
      proposedTargetChannelId: REVIEW_ONLY,
      target: reviewTarget,
      provenance: [
        { kind: 'channel', channelId: RESTRICTED_A, visibility: 'restricted' },
        { kind: 'channel', channelId: RESTRICTED_B, visibility: 'restricted' },
      ],
    });
    expect(result.outcome).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 5. A public-channel question about a private channel.
// ---------------------------------------------------------------------------

describe('46.3 case 5 — a public-scoped run receives no private content to hint at', () => {
  it('an org-scoped search returns none of the private canaries', () => {
    const r = searchMessages(env.db, ORG_GRANT, { query: SEARCH_TERM, now: NOW });
    const blob = r.map((m) => `${m.content} ${m.snippet}`).join(' ');
    expect(blob).not.toContain(CANARY_A);
    expect(blob).not.toContain(CANARY_B);
  });

  it('an org-scoped context lookup yields the generic rejection with no channel hint', () => {
    const ctx = getMessageContext(env.db, ORG_GRANT, { messageId: MSG_A });
    expect(ctx.anchor).toBeNull();
    // The empty result carries no trace of the hidden channel or its content.
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain(CANARY_A);
    expect(serialized).not.toContain(RESTRICTED_A);
  });
});

// ---------------------------------------------------------------------------
// 6. The model proposes a targetChannelId different from the pinned target.
// ---------------------------------------------------------------------------

describe('46.3 case 6 — a retargeted finalization is rejected', () => {
  it('the provenance gate rejects a proposed target that differs from the pinned one', () => {
    const result = evaluateProvenanceGate({
      pinnedTargetChannelId: PUB,
      proposedTargetChannelId: RESTRICTED_A,
      target: { channelId: PUB, visibility: 'org', isSecureReview: false },
      provenance: [{ kind: 'channel', channelId: PUB, visibility: 'org' }],
    });
    expect(result.outcome).toBe('reject');
  });

  it('the finalize tool rejects and does not terminate when the target differs', async () => {
    const state = new RunFinalizationState(PUB);
    const tool = createFinalizeDirectAnswerTool(state);
    const res = await tool.execute('call-1', {
      targetChannelId: RESTRICTED_A, // retargeted away from the pinned PUB
      message: 'Leaking into a restricted channel.',
      citedMessageIds: [],
    });
    expect(res.details.accepted).toBe(false);
    expect(res.terminate).toBeFalsy();
    expect(state.accepted).toBeNull();
    expect(state.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. A channel is reclassified org → restricted after memories were created.
// ---------------------------------------------------------------------------

describe('46.3 case 7 — reclassification hides the memory on the next read', () => {
  it('an org memory disappears once its evidence channel becomes restricted (no re-scope job)', () => {
    const id = createMemory(env.db, ORG_GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Meridian public decision.',
      confidence: 0.8,
      importance: 0.7,
      evidence: [{ messageId: MSG_PUB, stance: 'origin' }],
      now: NOW,
    });

    // Visible to an org grant while the evidence channel is org.
    const before = getMemoryDetails(env.db, ORG_GRANT, id);
    expect(before?.scopeType).toBe('org');

    // Reclassify the evidence channel org → restricted.
    upsertChannel(env.db, {
      id: PUB,
      guildId: GUILD,
      parentId: null,
      kind: 'text',
      name: PUB,
      topic: null,
      position: null,
      isThread: false,
      isArchived: false,
      isLocked: false,
      ingestEnabled: true,
      visibilityClass: 'restricted',
      allowInterventions: false,
      permissionFingerprint: null,
      lastMessageId: null,
      discoveredAtMs: NOW,
      updatedAtMs: NOW + 1,
      rawJson: null,
    });

    // The stored scope_type is unchanged, but read-time recompute derives a
    // channel scope the org grant cannot see — immediately, without a job.
    expect(getMemoryDetails(env.db, ORG_GRANT, id)).toBeUndefined();
    // A grant naming the channel still sees it (scopePermitted follows the
    // channel's current visibility, not the stored label).
    const naming: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [PUB] };
    expect(getMemoryDetails(env.db, naming, id)?.statement).toBe('Meridian public decision.');
  });
});

// ---------------------------------------------------------------------------
// 8. An org-scoped MCP token searches for restricted-only content.
// ---------------------------------------------------------------------------

describe('46.3 case 8 — an org MCP token gets no results and no hint', () => {
  it('search_messages returns only the org message and no restricted canary', async () => {
    const base = await mountMcp();
    const issued = createMcpToken({ db: env.db, nowMs: NOW }, { name: 'org', createdByUserId: ACTOR });
    if (issued.kind !== 'created') throw new Error('token not created');

    const { status, body } = await mcpCall(base, issued.token, 'search_messages', { query: SEARCH_TERM });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const text = mcpResultText(body.result as Record<string, unknown>);
    expect(text).toContain(MSG_PUB);
    expect(text).not.toContain(CANARY_A);
    expect(text).not.toContain(CANARY_B);
    // No hint that matching content exists elsewhere (no partial counts).
    expect(text).not.toMatch(/restricted|hidden|redacted/i);
  });
});

// ---------------------------------------------------------------------------
// 9. A revoked or expired MCP token calls any tool.
// ---------------------------------------------------------------------------

describe('46.3 case 9 — revoked/expired tokens get 401 and the attempt is observable', () => {
  it('a revoked token receives 401 and resolves to the revoked kind (loggable)', async () => {
    const base = await mountMcp();
    const issued = createMcpToken({ db: env.db, nowMs: NOW }, { name: 'revoke-me', createdByUserId: ACTOR });
    if (issued.kind !== 'created') throw new Error('token not created');
    revokeMcpToken(env.db, issued.tokenId, NOW);

    // Server-side resolution yields the revoked kind — the loggable signal.
    const resolved = resolveMcpToken({ db: env.db, nowMs: NOW }, issued.token);
    expect(resolved.kind).toBe('revoked');
    // The rejected attempt never consumed a use.
    expect(getMcpToken(env.db, issued.tokenId)?.lastUsedAtMs).toBeNull();

    const { status } = await mcpCall(base, issued.token, 'search_messages', { query: SEARCH_TERM });
    expect(status).toBe(401);
  });

  it('an expired token receives 401 and resolves to the expired kind (loggable)', async () => {
    const base = await mountMcp(() => NOW + 60_000);
    const issued = createMcpToken(
      { db: env.db, nowMs: NOW },
      { name: 'expire-me', createdByUserId: ACTOR, expiresAtMs: NOW + 1_000 },
    );
    if (issued.kind !== 'created') throw new Error('token not created');

    const resolved = resolveMcpToken({ db: env.db, nowMs: NOW + 60_000 }, issued.token);
    expect(resolved.kind).toBe('expired');

    const { status } = await mcpCall(base, issued.token, 'search_messages', { query: SEARCH_TERM });
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 10. An MCP token is requested with review_only visibility.
// ---------------------------------------------------------------------------

describe('46.3 case 10 — an MCP token cannot be granted review_only visibility', () => {
  it('token creation naming a review_only channel is rejected and stores nothing', () => {
    const outcome = createMcpToken(
      { db: env.db, nowMs: NOW },
      {
        name: 'should-fail',
        scopeType: 'org_plus_channels',
        channelIds: [REVIEW_ONLY],
        createdByUserId: ACTOR,
      },
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.reason).toBe('review_only_channel');
    expect(listMcpTokens(env.db)).toHaveLength(0);
  });

  it('a restricted channel IS grantable (the rejection is specific to review_only)', () => {
    const outcome = createMcpToken(
      { db: env.db, nowMs: NOW },
      {
        name: 'ok-restricted',
        scopeType: 'org_plus_channels',
        channelIds: [RESTRICTED_A],
        createdByUserId: ACTOR,
      },
    );
    expect(outcome.kind).toBe('created');
  });
});
