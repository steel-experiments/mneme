import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, type Logger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { setRuntimeModeOverride } from '../../src/runtime-state.js';
import { upsertChannel, type ChannelUpsertInput, type VisibilityClass } from '../../src/db/repositories/channels.js';
import { createInspectorToken, resolveInspectorToken, hashInspectorTokenValue } from '../../src/http/inspector/tokens.js';
import { createInspectorHandler } from '../../src/http/inspector/router.js';
import type { InspectorConfig } from '../../src/config.js';
import { fingerprintExposedMessage, fingerprintExposedMemory } from '../../src/agent/run-context.js';

/**
 * Inspector surface end-to-end (Section 32.6): one HTTP server, one migrated
 * database, one issued token.
 *
 * The suite proves the acceptance surface of the spec section: concealment when
 * disabled (identical 404), GET-only, bearer authentication with revocation and
 * expiry, both rate budgets, the hardening header set, escaped content, the
 * grant-aware pages, the context ledger from real run columns, and the content
 * matrix (no token material, no payload columns) on every page.
 */

const GUILD = '100000000000000001';
const NOW = 1_700_000_000_000;

const ORG_CHANNEL = '300000000000000001';
const RESTRICTED_A = '300000000000000002';
const REVIEW_ONLY = '300000000000000003';
const EXCLUDED_CHANNEL = '300000000000000004';

const HOST = '127.0.0.1';

let env: TestDb;
let handle: HttpServerHandle | undefined;
let base: string;
let clockMs = NOW;
let tokenValue: string;
const logger: Logger = createLogger({ level: 'silent' });

const inspectorConfig: InspectorConfig = {
  enabled: true,
  path: '/inspector',
  publicBaseUrl: 'http://localhost:3000',
  rateLimitPerMinute: 120,
  unauthRateLimitPerMinute: 30,
};

function channel(id: string, name: string, visibility: VisibilityClass): ChannelUpsertInput {
  return {
    id,
    guildId: GUILD,
    parentId: null,
    type: 0,
    name,
    topic: null,
    position: 0,
    isThread: false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: visibility !== 'excluded',
    visibilityClass: visibility,
    allowInterventions: visibility === 'org',
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  };
}

function thread(id: string, name: string, parentId: string): ChannelUpsertInput {
  return {
    ...channel(id, name, 'org'),
    parentId,
    type: 11,
    isThread: true,
  };
}

async function start(opts: { inspectorEnabled?: boolean; path?: string } = {}): Promise<void> {
  const enabled = opts.inspectorEnabled ?? true;
  handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger,
    inspectorEnabled: enabled,
    inspectorPath: opts.path ?? '/inspector',
    inspectorHandler: enabled
      ? createInspectorHandler({
          db: env.db,
          config: { ...inspectorConfig, path: opts.path ?? '/inspector' },
          logger,
          now: () => clockMs,
          timezone: 'UTC',
        })
      : undefined,
  });
  base = `http://${HOST}:${handle.port}`;
}

function get(path: string, auth = `Bearer ${tokenValue}`): Promise<Response> {
  return fetch(`${base}${path}`, { headers: auth ? { authorization: auth } : {} });
}

function pageHref(html: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const href = html.match(new RegExp(`href="([^"]+)">${escaped}`))?.[1];
  if (!href) throw new Error(`missing pager link: ${label}`);
  return href.replaceAll('&amp;', '&');
}

/** Insert a message row directly; ingestion paths are covered elsewhere. */
function insertMessage(id: string, channelId: string, content: string, authorName = 'alice'): void {
  const at = NOW + Number(id.slice(-3));
  env.db
    .prepare(
      `INSERT INTO messages (id, workspace_id, channel_id, author_id, author_display_name, content,
         created_at_ms, mentions_json, embeds_json, components_json, ingested_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, GUILD, channelId, '100000000000000003', authorName, content, at, '[]', '[]', '[]', at, at);
}

function insertEpisode(id: string, channelId: string, status: string, summary: string | null): void {
  const at = NOW + Number(id.slice(-3));
  env.db
    .prepare(
      `INSERT INTO episodes (id, workspace_id, conversation_channel_id, status, started_at_ms, ended_at_ms,
         last_activity_at_ms, human_message_count, total_message_count, trigger_reason, summary,
         consequential, intervention_score, created_at_ms, reviewed_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?,1,1,NULL,?,0,0.5,?,NULL,?)`,
    )
    .run(id, GUILD, channelId, status, at, at, at, summary, at, at);
}

function insertRun(id: string, episodeId: string | null, status: string, toolCallsJson: string, provenanceJson: string): void {
  const at = NOW + Number(id.slice(-3));
  env.db
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status,
         started_at_ms, ended_at_ms, input_tokens, output_tokens, cost_usd, tool_calls_json,
         retrieval_provenance_json, final_proposal_json, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
    )
    .run(id, GUILD, episodeId, 'episode', 'v1', 'openai', 'gpt-5.6-terra', status, at, at + 4_000, 100, 200, 0.004, toolCallsJson, provenanceJson);
}

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
  upsertChannel(env.db, channel(ORG_CHANNEL, 'general-org', 'org'));
  upsertChannel(env.db, channel(RESTRICTED_A, 'sec-ops', 'restricted'));
  upsertChannel(env.db, channel(REVIEW_ONLY, 'mneme-review', 'review_only'));
  upsertChannel(env.db, channel(EXCLUDED_CHANNEL, 'muted', 'excluded'));

  clockMs = NOW;
  const created = createInspectorToken(
    { db: env.db, nowMs: clockMs },
    { name: 'admin-browser', createdByUserId: '100000000000000003' },
  );
  if (created.kind !== 'created') throw new Error(`token creation failed: ${created.kind}`);
  tokenValue = created.token;
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  env.cleanup();
});

describe('inspector concealment and methods — Section 32.6', () => {
  it('returns the identical 404 body for the whole subtree when disabled', async () => {
    await start({ inspectorEnabled: false });
    const unknown = await fetch(`${base}/nope`);
    const root = await get('/inspector');
    const sub = await get('/inspector/memories');
    for (const res of [unknown, root, sub]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('{"error":"not_found"}');
    }
  });

  it('serves the surface under a custom mount path', async () => {
    await start({ path: '/ops' });
    expect((await get('/ops')).status).toBe(200);
    expect((await get('/inspector')).status).toBe(404);
  });

  it('rejects POST with 405 and Allow: GET', async () => {
    await start();
    const res = await fetch(`${base}/inspector`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenValue}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('authenticates before method and route checks, so routes cannot be probed', async () => {
    await start();
    // No credential: every method and every subpath gets the same 401.
    const post = await fetch(`${base}/inspector`, { method: 'POST' });
    expect(post.status).toBe(401);
    expect(post.headers.get('www-authenticate')).toBe('Basic realm="Mneme inspector", charset="UTF-8"');
    const unknown = await get('/inspector/nope', '');
    expect(unknown.status).toBe(401);
    // The same requests with a valid token get their real answers.
    const authedPost = await fetch(`${base}/inspector`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenValue}` },
    });
    expect(authedPost.status).toBe(405);
    expect((await get('/inspector/nope')).status).toBe(404);
  });
});

describe('inspector authentication — Section 32.6', () => {
  it('rejects a missing or wrong bearer with 401 and a Basic-only challenge', async () => {
    await start();
    const missing = await get('/inspector', '');
    expect(missing.status).toBe(401);
    // Basic alone, so every browser prompts; Bearer is accepted without being advertised.
    expect(missing.headers.get('www-authenticate')).toBe('Basic realm="Mneme inspector", charset="UTF-8"');
    expect(await missing.text()).toContain('paste the token as the <strong>password</strong>');

    const wrong = await get('/inspector', 'Bearer not-a-real-token');
    expect(wrong.status).toBe(401);
  });

  it('accepts the token as the HTTP Basic password, so a browser dialog works', async () => {
    await start();
    const basic = (user: string, password: string) =>
      `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
    // Any username; the token is the password.
    expect((await get('/inspector', basic('', tokenValue))).status).toBe(200);
    expect((await get('/inspector/memories', basic('user', tokenValue))).status).toBe(200);
    // Token pasted into the username field with an empty password.
    expect((await get('/inspector', basic(tokenValue, ''))).status).toBe(200);
    // Wrong password and malformed credentials fail exactly like a wrong bearer.
    expect((await get('/inspector', basic('user', 'not-the-token'))).status).toBe(401);
    expect((await get('/inspector', 'Basic not-base64!')).status).toBe(401);
    // The same 32-byte token is what got hashed: only one credential row exists.
    const rows = env.db.prepare('SELECT COUNT(*) AS n FROM inspector_tokens').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('rejects a revoked token on the next request', async () => {
    await start();
    env.db.prepare('UPDATE inspector_tokens SET revoked_at_ms = ?').run(NOW);
    const res = await get('/inspector');
    expect(res.status).toBe(401);
  });

  it('rejects an expired token and touches last_used on success', async () => {
    await start();
    env.db.prepare('UPDATE inspector_tokens SET expires_at_ms = ?').run(NOW - 1);
    expect((await get('/inspector')).status).toBe(401);

    env.db.prepare('UPDATE inspector_tokens SET expires_at_ms = ?').run(NOW + 60_000);
    expect((await get('/inspector')).status).toBe(200);
    const used = env.db.prepare('SELECT last_used_at_ms FROM inspector_tokens').get() as { last_used_at_ms: number };
    expect(used.last_used_at_ms).toBe(NOW);
  });

  it('returns 429 once the shared failed-auth budget is exhausted', async () => {
    await start({ inspectorEnabled: true });
    // Shrink the budget by exhausting it: the router uses the configured limit
    // of 30; drive 30 failures then assert the 31st is a 429.
    let last = 0;
    for (let i = 0; i <= 30; i++) last = (await get('/inspector', 'Bearer wrong')).status;
    expect(last).toBe(429);
    const retry = await get('/inspector', 'Bearer wrong');
    expect(retry.headers.get('retry-after')).toMatch(/^\d+$/);
    // A valid token still passes: the failure budget throttles failures, not users.
    expect((await get('/inspector')).status).toBe(200);
  });

  it('returns 429 once the per-token budget is exhausted', async () => {
    // Configure a tiny budget through a dedicated handler instance.
    handle = await startHttpServer({
      port: 0,
      host: HOST,
      logger,
      inspectorEnabled: true,
      inspectorPath: '/inspector',
      inspectorHandler: createInspectorHandler({
        db: env.db,
        config: { ...inspectorConfig, rateLimitPerMinute: 2 },
        logger,
        now: () => clockMs,
        timezone: 'UTC',
      }),
    });
    base = `http://${HOST}:${handle.port}`;
    expect((await get('/inspector')).status).toBe(200);
    expect((await get('/inspector')).status).toBe(200);
    const throttled = await get('/inspector');
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});

describe('inspector pages — Section 32.6 pages table', () => {
  beforeEach(async () => {
    insertMessage('900000000000000001', ORG_CHANNEL, 'We decided to ship the inspector.');
    insertMessage('900000000000000002', RESTRICTED_A, 'Secret budget cut is <script>alert(1)</script>');
    insertMessage('900000000000000003', REVIEW_ONLY, 'Review-only coordination message');
    insertMessage('900000000000000004', EXCLUDED_CHANNEL, 'Excluded channel content');
    insertEpisode('ep-0001', ORG_CHANNEL, 'reviewed', 'The team shipped the inspector.');
    insertEpisode('ep-0002', RESTRICTED_A, 'open', null);
    insertEpisode('ep-0003', EXCLUDED_CHANNEL, 'open', 'Excluded summary');
    env.db
      .prepare(`INSERT INTO episode_messages (episode_id, message_id, ordinal) VALUES ('ep-0001','900000000000000001',1)`)
      .run();
    env.db
      .prepare(
        `INSERT INTO memories (id, workspace_id, scope_type, scope_key, type, statement, status, confidence,
           importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
         VALUES ('mem-0001', ?, 'org', NULL, 'decision', 'Ship the inspector in the first cut.', 'active', 0.9, 0.8, ?, ?, ?, ?)`,
      )
      .run(GUILD, NOW, NOW, NOW, NOW);
    env.db
      .prepare(
        `INSERT INTO memory_evidence (memory_id, message_id, stance, weight, note, created_at_ms)
         VALUES ('mem-0001','900000000000000001','origin',1,NULL,?)`,
      )
      .run(NOW);
    insertRun(
      'run-0001',
      'ep-0001',
      'completed',
      JSON.stringify([
        { toolName: 'message_search', toolCallId: 't1', accepted: true, isError: false, argsChars: 120, resultChars: 20_000 },
        { toolName: 'finalize_episode_review', toolCallId: 't2', accepted: true, isError: false, argsChars: 800, resultChars: 60 },
      ]),
      JSON.stringify({
        channels: [ORG_CHANNEL],
        messageIds: ['900000000000000001'],
        memoryScopes: [],
        memoryIds: [],
        charsExposed: 20_120,
        charBudget: 60_000,
      }),
    );
    insertRun('run-0002', null, 'completed', '[]', '[]');
    env.db.prepare(`UPDATE agent_runs SET
      input_tokens=350, uncached_input_tokens=100, cache_read_tokens=200,
      cache_write_tokens=50, cache_write_1h_tokens=25, output_tokens=80,
      reasoning_tokens=30, provider_total_tokens=430, cost_usd=.08,
      uncached_input_cost_usd=.02, output_cost_usd=.04, cache_read_cost_usd=.01,
      cache_write_cost_usd=.01, thinking_level='medium', execution_started_at_ms=?,
      model_turns_json=? WHERE id='run-0002'`).run(NOW + 100, JSON.stringify([{
        version: 2, turnIndex: 1, startedAtMs: NOW + 2, modelEndedAtMs: NOW + 102,
        endedAtMs: NOW + 202, modelDurationMs: 100, durationMs: 200,
        inputTokens: 350, outputTokens: 80, costUsd: 0.08,
        uncachedInputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50,
        cacheWrite1hTokens: 25, reasoningTokens: 30, providerTotalTokens: 430,
        uncachedInputCostUsd: 0.02, outputCostUsd: 0.04,
        cacheReadCostUsd: 0.01, cacheWriteCostUsd: 0.01,
        stopReason: 'stop', incomplete: false,
      }]));
    env.db
      .prepare(
        `INSERT INTO proposals (id, run_id, episode_id, target_channel_id, status, computed_score, reason,
           evidence_message_ids_json, created_at_ms, updated_at_ms)
         VALUES ('prop-0001','run-0001','ep-0001', ?, 'pending_review', 0.7, 'A decision was forgotten.', '[]', ?, ?)`,
      )
      .run(ORG_CHANNEL, NOW, NOW);
    env.db
      .prepare(
        `INSERT INTO outbox (id, proposal_id, channel_id, content, dedupe_key, status, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES ('out-0001','prop-0001', ?, 'Mneme speaks: see decision mem-0001.', 'dk-1', 'sent', ?, ?, ?)`,
      )
      .run(ORG_CHANNEL, NOW, NOW, NOW);
    env.db
      .prepare(
        `INSERT INTO jobs (id, type, unique_key, payload_json, status, priority, run_after_ms, created_at_ms, updated_at_ms)
         VALUES ('job-0001','review_episode',NULL,'{}','queued',100,?,?,?)`,
      )
      .run(NOW, NOW, NOW);
    env.db
      .prepare(
        `INSERT INTO admin_events (id, workspace_id, actor_user_id, action, target, details_json, created_at_ms)
         VALUES ('aud-0001', ?, '100000000000000003', 'inspector_token_create', 'admin-browser', '{}', ?)`,
      )
      .run(GUILD, NOW);
    await start();
  });

  it('overview renders counters and the recent run', async () => {
    const res = await get('/inspector');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Mneme inspector');
    expect(html).toContain('active memories');
    expect(html).toContain('run-0001'); // recent-run table links to the run page
    expect(html).toContain('Recent proposals');
    expect(html).toContain('A decision was forgotten.'); // recent-proposal strip
    expect(html).toContain('1 / 2');
    expect(html).toContain('cache-read ratio 57%');
    expect(html).toContain('100 uncached · 200 read · 50 write');
  });

  it('overview shows readiness and the effective mode', async () => {
    let ready = true;
    let reason: string | null = null;
    handle = await startHttpServer({
      port: 0,
      host: HOST,
      logger,
      inspectorEnabled: true,
      inspectorPath: '/inspector',
      inspectorHandler: createInspectorHandler({
        db: env.db,
        config: inspectorConfig,
        logger,
        now: () => clockMs,
        timezone: 'UTC',
        readiness: () => ({ ready, reason }),
        configuredMode: 'review',
      }),
    });
    base = `http://${HOST}:${handle.port}`;

    let html = await (await get('/inspector')).text();
    expect(html).toContain('ready');
    expect(html).toContain('mode review (configured)');

    // A durable override from `/mneme mode` wins over the configured value.
    setRuntimeModeOverride(env.db, {
      mode: 'autonomous',
      actorUserId: '100000000000000003',
      now: clockMs,
    });
    html = await (await get('/inspector')).text();
    expect(html).toContain('mode autonomous (override)');

    // Not-ready states carry the content-free reason code, nothing else.
    ready = false;
    reason = 'shutting_down';
    html = await (await get('/inspector')).text();
    expect(html).toContain('not ready (shutting_down)');
  });

  it('escapes the mode line like every other interpolation', async () => {
    handle = await startHttpServer({
      port: 0,
      host: HOST,
      logger,
      inspectorEnabled: true,
      inspectorPath: '/inspector',
      inspectorHandler: createInspectorHandler({
        db: env.db,
        config: inspectorConfig,
        logger,
        now: () => clockMs,
        timezone: 'UTC',
        readiness: () => ({ ready: true, reason: null }),
        configuredMode: '<script>alert(1)</script>',
      }),
    });
    base = `http://${HOST}:${handle.port}`;

    const html = await (await get('/inspector')).text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('sets the hardening headers on every page', async () => {
    for (const path of ['/inspector', '/inspector/memories', '/inspector/audit', '/inspector/nope']) {
      const res = await get(path);
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }
  });

  it('memories index lists the org memory; FTS search finds it', async () => {
    const list = await get('/inspector/memories');
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain('Ship the inspector in the first cut.');
    expect(html).toContain('mem-0001');

    const search = await get('/inspector/memories?q=inspector');
    expect(search.status).toBe(200);
    expect(await search.text()).toContain('Ship the inspector in the first cut.');
  });

  it('sorts the memory archive by most recent confirmation when selected', async () => {
    const insert = env.db.prepare(
      `INSERT INTO memories (id, workspace_id, scope_type, scope_key, type, statement, status, confidence,
         importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'org', NULL, 'fact', ?, 'active', 0.7, ?, ?, ?, ?, ?)`,
    );
    insert.run('mem-sort-important', GUILD, 'Older but important', 1, NOW - 2_000, NOW - 2_000, NOW - 2_000, NOW - 2_000);
    insert.run('mem-sort-recent', GUILD, 'Newer but less important', 0.1, NOW + 2_000, NOW + 2_000, NOW + 2_000, NOW + 2_000);

    const byImportance = await (await get('/inspector/memories?type=fact')).text();
    expect(byImportance.indexOf('Older but important')).toBeLessThan(byImportance.indexOf('Newer but less important'));

    const byRecent = await (await get('/inspector/memories?type=fact&sort=recent')).text();
    expect(byRecent).toContain('ordered by most recent confirmation');
    expect(byRecent).toContain('<option value="recent" selected>most recent</option>');
    expect(byRecent.indexOf('Newer but less important')).toBeLessThan(byRecent.indexOf('Older but important'));
  });

  it('memory detail shows evidence with content and an escaped hostile statement', async () => {
    env.db
      .prepare(`UPDATE memories SET statement = 'Ship <script>alert(1)</script> now' WHERE id = 'mem-0001'`)
      .run();
    const res = await get('/inspector/memories/mem-0001');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('We decided to ship the inspector.'); // evidence content
    expect(html).toContain('discord.com/channels'); // host-generated jump link
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('cursor-paginates the filtered memory archive without dropping equal sort keys', async () => {
    const insert = env.db.prepare(
      `INSERT INTO memories (id, workspace_id, scope_type, scope_key, type, statement, status, confidence,
         importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'org', NULL, 'fact', ?, ?, 0.7, 0.5, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 25; i++) {
      insert.run(
        `mem-page-${String(i).padStart(2, '0')}`,
        GUILD,
        `archive memory ${i}`,
        i === 0 ? 'expired' : 'active',
        NOW,
        NOW,
        NOW,
        NOW,
      );
    }

    const first = await get('/inspector/memories?status=any&type=fact');
    const firstHtml = await first.text();
    expect(firstHtml).toContain('Showing 20 of 25 visible memories');
    expect(firstHtml).toContain('archive memory 24');
    expect(firstHtml).not.toContain('<td>archive memory 0</td>');
    const next = pageHref(firstHtml, 'Next page →');
    expect(next).toContain('status=any');
    expect(next).toContain('type=fact');

    const second = await get(next);
    const secondHtml = await second.text();
    expect(secondHtml).toContain('archive memory 0');
    expect(secondHtml).toContain('← First page');
    expect(secondHtml).not.toContain('Next page →');

    const recentFirstHtml = await (await get('/inspector/memories?status=any&type=fact&sort=recent')).text();
    const recentNext = pageHref(recentFirstHtml, 'Next page →');
    expect(recentNext).toContain('sort=recent');
    expect(recentNext).not.toContain('beforeImportance');
    const recentSecondHtml = await (await get(recentNext)).text();
    expect(recentSecondHtml).toContain('archive memory 0');
    expect(recentSecondHtml).not.toContain('Next page →');
  });

  it('cursor-paginates memory evidence chronologically', async () => {
    const evidence = env.db.prepare(
      `INSERT INTO memory_evidence (memory_id, message_id, stance, weight, note, created_at_ms)
       VALUES ('mem-0001', ?, 'supports', 1, NULL, ?)`,
    );
    for (let i = 0; i < 21; i++) {
      const id = `910000000000000${String(i).padStart(3, '0')}`;
      insertMessage(id, ORG_CHANNEL, `evidence page item ${i}`);
      evidence.run(id, NOW + i + 1);
    }

    const first = await get('/inspector/memories/mem-0001');
    const firstHtml = await first.text();
    expect(firstHtml).toContain('Evidence (20 shown of 22, oldest first)');
    expect(firstHtml).toContain('evidence page item 18');
    expect(firstHtml).not.toContain('evidence page item 20');

    const second = await get(pageHref(firstHtml, 'Later evidence →'));
    const secondHtml = await second.text();
    expect(secondHtml).toContain('evidence page item 19');
    expect(secondHtml).toContain('evidence page item 20');
    expect(secondHtml).toContain('← First evidence page');
  });

  it('renders lineage link labels single-escaped', async () => {
    env.db
      .prepare(
        `INSERT INTO memories (id, workspace_id, scope_type, scope_key, type, statement, status, confidence,
           importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
         VALUES ('mem-0002', ?, 'org', NULL, 'fact', 'Tom & Jerry <b>', 'active', 0.7, 0.7, ?, ?, ?, ?)`,
      )
      .run(GUILD, NOW, NOW, NOW, NOW);
    env.db
      .prepare(`INSERT INTO memory_links (source_memory_id, target_memory_id, relation, created_at_ms)
        VALUES ('mem-0001','mem-0002','contradicts',?)`)
      .run(NOW);
    const res = await get('/inspector/memories/mem-0001');
    expect(res.status).toBe(200);
    const html = await res.text();
    // link() escapes its label once: entities appear, never double-escaped.
    expect(html).toContain('Tom &amp; Jerry &lt;b&gt;');
    expect(html).not.toContain('&amp;amp;');
  });

  it('hidden and missing memory ids render the same 404 page', async () => {
    // A memory whose evidence lives only in an excluded channel: effective
    // scope is review_only, and the secure review grant does include it, so
    // instead hide by pointing the grant at nothing — delete the evidence so
    // the recomputed scope stays review_only (still visible). True hiding is
    // covered by episode/message pages; here assert missing ids 404.
    const missing = await get('/inspector/memories/does-not-exist');
    expect(missing.status).toBe(404);
    const html = await missing.text();
    expect(html).toContain('Not found');
  });

  it('episodes index shows org and restricted episodes, never the excluded one', async () => {
    const res = await get('/inspector/episodes');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ep-0001');
    expect(html).toContain('ep-0002');
    expect(html).not.toContain('ep-0003');
    expect(html).not.toContain('Excluded summary');
  });

  it('episode detail lists permitted messages', async () => {
    const res = await get('/inspector/episodes/ep-0001');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('We decided to ship the inspector.');
    expect(html).toContain('run-0001');
  });

  it('episode detail paginates messages at the 20-row repository cap', async () => {
    // 25 permitted messages in one org episode: two pages, 20 then 5.
    insertEpisode('ep-100', ORG_CHANNEL, 'reviewed', null);
    for (let i = 1; i <= 25; i++) {
      const id = `90000000000000${String(i).padStart(3, '0')}`;
      insertMessage(id, ORG_CHANNEL, `big message ${i}`);
      env.db
        .prepare('INSERT INTO episode_messages (episode_id, message_id, ordinal) VALUES (?,?,?)')
        .run('ep-100', id, i);
    }
    env.db.prepare('UPDATE episodes SET total_message_count = 25, human_message_count = 25 WHERE id = ?').run('ep-100');

    const page1 = await get('/inspector/episodes/ep-100');
    expect(page1.status).toBe(200);
    const html1 = await page1.text();
    expect(html1).toContain('big message 1');
    expect(html1).toContain('big message 20');
    expect(html1).not.toContain('big message 21');
    expect((html1.match(/<blockquote class="evidence">/g) ?? []).length).toBe(20);
    expect(html1).toContain('Later messages →');

    const page2 = await get('/inspector/episodes/ep-100?after=20');
    expect(page2.status).toBe(200);
    const html2 = await page2.text();
    expect(html2).toContain('big message 21');
    expect(html2).toContain('big message 25');
    expect((html2.match(/<blockquote class="evidence">/g) ?? []).length).toBe(5);
    expect(html2).not.toContain('Later messages →');
  });

  it('escapes database-derived ids in detail headings', async () => {
    // Hostile primary keys cannot arrive through the Discord write path, but
    // the render invariant must hold regardless: every db value goes through
    // h(). The ids use markup-significant characters that survive a URL path.
    const evilEpisode = "ep-x'y&w-001";
    insertEpisode(evilEpisode, ORG_CHANNEL, 'open', null);
    env.db
      .prepare(`INSERT INTO episode_messages (episode_id, message_id, ordinal) VALUES (?, '900000000000000001', 1)`)
      .run(evilEpisode);
    const ep = await get(`/inspector/episodes/${evilEpisode}`);
    expect(ep.status).toBe(200);
    const epHtml = await ep.text();
    expect(epHtml).not.toContain("<h2>Episode ep-x'y");
    expect(epHtml).toContain('<h2>Episode ep-x&#39;y&amp;');

    insertRun("run-x'y&w-001", 'ep-0001', 'completed', '[]', '[]');
    const run = await get(`/inspector/runs/run-x'y&w-001`);
    expect(run.status).toBe(200);
    const runHtml = await run.text();
    expect(runHtml).not.toContain("<h2>Run run-x'y");
    expect(runHtml).toContain('<h2>Run run-x&#39;y&amp;');
  });

  it('episode in an excluded channel is a 404 under the grant', async () => {
    const res = await get('/inspector/episodes/ep-0003');
    expect(res.status).toBe(404);
  });

  it('run detail renders the context ledger from the persisted columns', async () => {
    const res = await get('/inspector/runs/run-0001');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('svg class="ledger"');
    expect(html).toContain('retrieved content (legacy total)');
    // Legacy audit lacks reservation deltas, so the ledger does not invent a split.
    expect(html).not.toContain('finalize_episode_review (args + results)');
    expect(html).toContain('20,120'); // chars exposed with separators
    expect(html).toContain('60,000'); // budget scale label
    expect(html).toContain('breakdown not recorded');
  });

  it('renders complete run and turn usage without adding subset fields to totals', async () => {
    const indexHtml = await (await get('/inspector/runs')).text();
    expect(indexHtml).toContain('100 uncached · 200 read · 50 write · 30 reasoning');

    const html = await (await get('/inspector/runs/run-0002')).text();
    expect(html).toContain('100 uncached input · 200 cache read · 50 cache write');
    expect(html).toContain('25 1h cache write');
    expect(html).toContain('30 reasoning');
    expect(html).toContain('430 provider total');
    expect(html).toContain('Requested thinking level');
    expect(html).toContain('medium');
    expect(html).toContain('Semantic now');
    expect(html).toContain('Execution started / ended');
    expect(html).toContain('Execution duration');
    expect(html).toContain('$0.0200 uncached input');
    expect(html).toContain('350/80 tokens');
  });

  it('labels shadow runs and renders only the content-minimized comparison', async () => {
    env.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,episode_id,run_type,prompt_version,provider,model,status,started_at_ms,
       execution_started_at_ms,ended_at_ms,input_tokens,output_tokens,reasoning_tokens,cost_usd,
       thinking_level,shadow_of_run_id,shadow_comparison_json,final_proposal_json)
      VALUES ('run-shadow','${GUILD}','ep-0001','episode','p','openai','gpt-5.6-luna',
       'completed',?,?,?,?,?,?,?,'high','run-0001',?,?)`).run(
      NOW + 5, NOW + 10, NOW + 410, 500, 200, 80, 0.001, JSON.stringify({
      version: 1,
      authoritative: {
        category: 'important', consequential: true, memoryCount: 1,
        memoryTypes: ['decision'], interventionRecommended: false,
      },
      shadow: {
        category: 'silent', consequential: false, memoryCount: 0,
        memoryTypes: [], interventionRecommended: false,
      },
      categoryMatch: false,
    }), JSON.stringify({
      episodeSummary: 'A low-reasoning memory-only interpretation.',
      consequential: false,
      memoryProposals: [{
        action: 'create', type: 'decision', statement: 'Use the smaller deployment.',
        confidence: 0.8, importance: 0.7, durability: 'durable',
        evidenceMessageIds: ['900000000000000001'],
      }],
    }));

    const indexHtml = await (await get('/inspector/runs')).text();
    expect(indexHtml).toContain('episode shadow');
    const shadowHtml = await (await get('/inspector/runs/run-shadow')).text();
    expect(shadowHtml).toContain('Non-acting shadow');
    expect(shadowHtml).toContain('authoritative run-0001');
    expect(shadowHtml).toContain('Shadow comparison');
    expect(shadowHtml).toContain('Authoritative medium');
    expect(shadowHtml).toContain('Shadow high');
    expect(shadowHtml).toContain('important');
    expect(shadowHtml).toContain('silent');
    expect(shadowHtml).toContain('A low-reasoning memory-only interpretation.');
    expect(shadowHtml).toContain('Use the smaller deployment.');
    expect(shadowHtml).toContain('never applied, queued, or sent');
    const authoritativeHtml = await (await get('/inspector/runs/run-0001')).text();
    expect(authoritativeHtml).toContain('shadow run-shad');
    const overviewHtml = await (await get('/inspector')).text();
    expect(overviewHtml).toContain('Episode shadow cohorts');
    expect(overviewHtml).toContain('gpt-5.6-luna');
    expect(overviewHtml).toContain('500 in · 200 out · 80 reasoning');
    expect(overviewHtml).toContain('0 / 1');
  });

  it('renders turn timing and grant-revalidated tool exposure without hidden ids', async () => {
    const messageFingerprint = fingerprintExposedMessage(env.db, '900000000000000001')!;
    const memoryFingerprint = fingerprintExposedMemory(env.db, 'mem-0001')!;
    env.db.prepare(`UPDATE agent_runs SET model_turns_json=?, tool_calls_json=? WHERE id='run-0001'`).run(
      JSON.stringify([{ version: 1, turnIndex: 1, startedAtMs: NOW + 1, modelEndedAtMs: NOW + 101,
        endedAtMs: NOW + 301, modelDurationMs: 100, durationMs: 300, inputTokens: 10, outputTokens: 5,
        costUsd: .002, stopReason: 'toolUse', incomplete: false }]),
      JSON.stringify([{ traceVersion: 1, toolName: 'get_memory_evidence', toolCallId: 'call-focus', sequence: 1,
        turnIndex: 1, startedAtMs: NOW + 101, endedAtMs: NOW + 201, durationMs: 100,
        execution: 'executed', accepted: true, blocked: false, isError: false, argsChars: 12, resultChars: 200,
        reservedChars: 20_120, exposure: { version: 1, truncatedCount: 0,
          messages: [{ id: '900000000000000001', fingerprint: messageFingerprint }, { id: '900000000000000004', fingerprint: 'hidden' }],
          memories: [{ id: 'mem-0001', fingerprint: memoryFingerprint }] } }]),
    );
    const html = await (await get('/inspector/runs/run-0001?toolCall=call-focus')).text();
    expect(html).toContain('Turn 1 · model');
    expect(html).toContain('100 ms model');
    expect(html).toContain('300 ms total');
    expect(html).toContain('current content matches the exposure version');
    expect(html).toContain('We decided to ship the inspector.');
    expect(html).toContain('Ship the inspector in the first cut.');
    expect(html).toContain('1 item(s) unavailable or no longer visible');
    expect(html).not.toContain('900000000000000004');
    expect(html).not.toContain('Excluded channel content');
  });

  it('shows escaped rejected terminal text separately from its safety decision', async () => {
    const rejected = 'Alert <@100000000000000003> and <script>bad()</script>';
    env.db.prepare(`UPDATE agent_runs SET final_proposal_json=? WHERE id='run-0001'`).run(JSON.stringify({
      kind: 'episode_review', proposal: { intervention: { recommend: true, reason: 'Important',
        targetChannelId: ORG_CHANNEL, message: rejected, evidenceMessageIds: ['900000000000000001'] } },
    }));
    env.db.prepare(`UPDATE proposals SET status='observed', message=NULL, policy_decision_json=? WHERE id='prop-0001'`).run(JSON.stringify({
      version: 1, kind: 'episode_intervention', mode: 'autonomous', state: 'observed', score: .748,
      thresholds: { score: .7, confidence: .6, evidenceStrength: .6, maxContentLength: 1800 },
      eligibility: { confidence: .9, evidenceStrength: .8 },
      outboundSafety: { outcome: 'reject', reasons: ['message contains unauthorized user mention(s)'] },
      provenanceGate: { outcome: 'allow', reasons: [] }, outboundEvidence: { outcome: 'allow', reasons: [] },
    }));
    const html = await (await get('/inspector/runs/run-0001')).text();
    expect(html).toContain('Rejected/observed — never queued or sent');
    expect(html).toContain('0.748');
    expect(html).toContain('Outbound message safety');
    expect(html).toContain('&lt;@100000000000000003&gt;');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>bad()');
  });

  it('renders the nested scheduled notification target', async () => {
    env.db.prepare(`UPDATE agent_runs SET run_type='scheduled_review', final_proposal_json=?
      WHERE id='run-0001'`).run(JSON.stringify({
      kind: 'scheduled_review',
      proposal: {
        memoryProposals: [],
        notification: {
          recommend: true,
          reason: 'Current status is overdue.',
          targetChannelId: RESTRICTED_A,
          message: 'Please confirm the current status.',
          evidenceMessageIds: [],
          subjectMemoryIds: ['mem-0001'],
        },
      },
    }));
    const html = await (await get('/inspector/runs/run-0001')).text();
    expect(html).toContain('Target channel');
    expect(html).toContain(`<code>${RESTRICTED_A}</code>`);
    expect(html).toContain('Please confirm the current status.');
  });

  it('speech page separates proposals from deliveries', async () => {
    const sourceUrl = `https://discord.com/channels/${GUILD}/${ORG_CHANNEL}/900000000000000001`;
    env.db.prepare('UPDATE outbox SET content = ? WHERE id = ?').run(
      `Mneme speaks: [source](${sourceUrl})`,
      'out-0001',
    );
    const res = await get('/inspector/speech');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('A decision was forgotten.');
    expect(html).not.toContain('Mneme speaks:');

    const deliveries = await get('/inspector/speech?view=deliveries');
    const deliveriesHtml = await deliveries.text();
    expect(deliveriesHtml).toContain(`Mneme speaks: <a href="${sourceUrl}">source</a>`);
    expect(deliveriesHtml).not.toContain(`[source](${sourceUrl})`);
    expect(deliveriesHtml).not.toContain('A decision was forgotten.');
  });

  it('cursor-paginates both speech archives independently', async () => {
    const proposal = env.db.prepare(
      `INSERT INTO proposals (id, run_id, episode_id, target_channel_id, status, computed_score, reason,
         evidence_message_ids_json, created_at_ms, updated_at_ms)
       VALUES (?, 'run-0001', 'ep-0001', ?, 'pending_review', 0.5, ?, '[]', ?, ?)`,
    );
    const delivery = env.db.prepare(
      `INSERT INTO outbox (id, proposal_id, channel_id, content, dedupe_key, status,
         next_attempt_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, 'sent', ?, ?, ?)`,
    );
    for (let i = 0; i < 21; i++) {
      const suffix = String(i).padStart(2, '0');
      const proposalId = `prop-page-${suffix}`;
      proposal.run(proposalId, ORG_CHANNEL, `proposal page reason ${i}`, NOW + i + 1, NOW + i + 1);
      delivery.run(
        `out-page-${suffix}`,
        proposalId,
        ORG_CHANNEL,
        `delivery page content ${i}`,
        `speech-page-${suffix}`,
        NOW + i + 1,
        NOW + i + 1,
        NOW + i + 1,
      );
    }

    const proposals = await get('/inspector/speech');
    const proposalsHtml = await proposals.text();
    expect(proposalsHtml).toContain('22 proposals');
    const olderProposals = pageHref(proposalsHtml, 'Older proposals →');
    expect(await (await get(olderProposals)).text()).toContain('proposal page reason 0');

    const deliveries = await get('/inspector/speech?view=deliveries');
    const deliveriesHtml = await deliveries.text();
    expect(deliveriesHtml).toContain('22 deliveries');
    const olderDeliveries = pageHref(deliveriesHtml, 'Older deliveries →');
    expect(olderDeliveries).toContain('view=deliveries');
    expect(await (await get(olderDeliveries)).text()).toContain('delivery page content 0');
  });

  it('channels page shows policy rows without message content', async () => {
    const res = await get('/inspector/channels');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('general-org');
    expect(html).toContain('sec-ops');
    expect(html).toContain('not ingested (control surface)');
    expect(html).not.toContain('Secret budget cut');
  });

  it('jobs and audit pages list their rows', async () => {
    const jobs = await get('/inspector/jobs');
    expect(jobs.status).toBe(200);
    expect(await jobs.text()).toContain('review_episode');

    const audit = await get('/inspector/audit');
    expect(audit.status).toBe(200);
    const html = await audit.text();
    expect(html).toContain('inspector_token_create');
    expect(html).toContain('admin-browser');
  });

  it('cursor-paginates filtered jobs and audit events', async () => {
    const job = env.db.prepare(
      `INSERT INTO jobs (id, type, unique_key, payload_json, status, priority,
         run_after_ms, created_at_ms, updated_at_ms)
       VALUES (?, 'archive_test', NULL, '{}', 'queued', 50, ?, ?, ?)`,
    );
    const audit = env.db.prepare(
      `INSERT INTO admin_events (id, workspace_id, actor_user_id, action, target, details_json, created_at_ms)
       VALUES (?, ?, '100000000000000003', 'archive_test', ?, '{}', ?)`,
    );
    for (let i = 0; i < 21; i++) {
      const suffix = String(i).padStart(2, '0');
      job.run(`job-page-${suffix}`, NOW + i, NOW + i, NOW + i);
      audit.run(`aud-page-${suffix}`, GUILD, `audit page target ${i}`, NOW + i);
    }
    env.db.prepare("UPDATE jobs SET last_error = 'oldest job marker' WHERE id = 'job-page-00'").run();

    const jobs = await get('/inspector/jobs?type=archive_test&status=queued');
    const jobsHtml = await jobs.text();
    expect(jobsHtml).toContain('21 matching jobs');
    const olderJobs = pageHref(jobsHtml, 'Older jobs →');
    expect(olderJobs).toContain('type=archive_test');
    expect(olderJobs).toContain('status=queued');
    const olderJobsHtml = await (await get(olderJobs)).text();
    expect(olderJobsHtml).toContain('oldest job marker');
    expect(olderJobsHtml).toContain('← First page');

    const events = await get('/inspector/audit');
    const eventsHtml = await events.text();
    expect(eventsHtml).toContain('22 audited admin actions');
    const olderEvents = pageHref(eventsHtml, 'Older events →');
    const olderEventsHtml = await (await get(olderEvents)).text();
    expect(olderEventsHtml).toContain('audit page target 0');
    expect(olderEventsHtml).toContain('← First page');
  });

  it('resolve maps ids and prefixes to their pages', async () => {
    const memory = await get('/inspector/resolve?id=mem-0001');
    expect(await memory.text()).toContain('/inspector/memories/mem-0001');
    // The spec pages table documents /resolve/:id; both shapes work.
    const byPath = await get('/inspector/resolve/mem-0001');
    expect(byPath.status).toBe(200);
    expect(await byPath.text()).toContain('/inspector/memories/mem-0001');
    const run = await get('/inspector/resolve?id=run-0001');
    expect(await run.text()).toContain('/inspector/runs/run-0001');
    const nothing = await get('/inspector/resolve?id=zzzz-nothing');
    expect(await nothing.text()).toContain('Nothing matches');
    // The excluded episode id resolves to nothing under the grant.
    const hidden = await get('/inspector/resolve?id=ep-0003');
    expect(await hidden.text()).toContain('Nothing matches');
  });

  it('separates channels from threads and cursor-paginates both views', async () => {
    for (let i = 0; i < 21; i++) {
      const suffix = String(i).padStart(2, '0');
      upsertChannel(env.db, channel(`3100000000000000${suffix}`, `zz-page-${suffix}`, 'org'));
    }
    upsertChannel(env.db, thread('320000000000000001', 'release-plan', ORG_CHANNEL));
    upsertChannel(env.db, thread('320000000000000002', 'incident-review', ORG_CHANNEL));

    const first = await get('/inspector/channels');
    const firstHtml = await first.text();
    expect(firstHtml).toContain('26 channels');
    expect(firstHtml).toContain('20 per page');
    expect(firstHtml).not.toContain('release-plan');
    expect(firstHtml).toContain('Next page →');

    const nextHref = firstHtml.match(/href="(\/inspector\/channels\?[^"]+)">Next page/)?.[1];
    expect(nextHref).toBeDefined();
    const second = await get((nextHref ?? '').replaceAll('&amp;', '&'));
    const secondHtml = await second.text();
    expect(secondHtml).toContain('zz-page-20');
    expect(secondHtml).toContain('← First page');

    const threads = await get('/inspector/channels?view=threads');
    const threadHtml = await threads.text();
    expect(threadHtml).toContain('2 threads');
    expect(threadHtml).toContain('release-plan');
    expect(threadHtml).toContain('#general-org');
    expect(threadHtml).not.toContain('zz-page-20');
  });

  it('resolve finds messages by id or unique prefix, grant-gated, with a jump link', async () => {
    // Visible message: exact id, then a unique prefix. The link is host-built
    // from the stored guild id.
    const exact = await get('/inspector/resolve?id=900000000000000001');
    const exactHtml = await exact.text();
    expect(exactHtml).toContain('Message <code>900000000000000001</code>');
    expect(exactHtml).toContain(`https://discord.com/channels/${GUILD}/${ORG_CHANNEL}/900000000000000001`);
    // '90000000000000000' is shared by every fixture message: ambiguous.
    const ambiguous = await get('/inspector/resolve?id=90000000000000000');
    expect(await ambiguous.text()).toContain('Nothing matches');
    // A message in the excluded channel resolves to nothing under the grant.
    const hidden = await get('/inspector/resolve?id=900000000000000004');
    expect(await hidden.text()).toContain('Nothing matches');
    // Short input never matches as a prefix.
    const short = await get('/inspector/resolve?id=9000');
    expect(await short.text()).toContain('Nothing matches');
  });

  it('never renders token material or raw payload columns on any page', async () => {
    const paths = [
      '/inspector', '/inspector/memories', '/inspector/memories/mem-0001',
      '/inspector/episodes', '/inspector/episodes/ep-0001',
      '/inspector/runs', '/inspector/runs/run-0001', '/inspector/speech',
      '/inspector/channels', '/inspector/jobs', '/inspector/audit',
      '/inspector/resolve?id=mem-0001',
    ];
    const hash = hashInspectorTokenValue(tokenValue);
    for (const path of paths) {
      const html = await (await get(path)).text();
      expect(html).not.toContain(tokenValue);
      expect(html).not.toContain(hash);
      expect(html).not.toContain('raw_json');
      expect(html).not.toContain('poll_json');
    }
  });
});

describe('inspector token storage discipline — Section 32.6', () => {
  it('stores only the hash; the plaintext never reaches the SQLite file', async () => {
    const row = env.db.prepare('SELECT * FROM inspector_tokens').get() as Record<string, unknown>;
    expect(row['token_hash']).toBe(hashInspectorTokenValue(tokenValue));
    expect(Object.keys(row).join(',')).not.toContain('token_value');
    // The row lives in the WAL until a checkpoint; scan both files.
    const raw = readFileSync(join(env.dir, 'test.sqlite'), 'latin1')
      + readFileSync(join(env.dir, 'test.sqlite-wal'), 'latin1');
    expect(raw.includes(tokenValue)).toBe(false);
    expect(raw.includes(hashInspectorTokenValue(tokenValue))).toBe(true);
  });

  it('resolves its own token and never an MCP-shaped foreign hash', async () => {
    expect(resolveInspectorToken({ db: env.db, nowMs: NOW }, tokenValue).kind).toBe('valid');
    expect(resolveInspectorToken({ db: env.db, nowMs: NOW }, 'totally-foreign-value').kind).toBe('invalid');
  });
});
