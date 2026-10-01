import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../../src/logger.js';
import { startHttpServer } from '../../src/http/server.js';
import {
  createStatusProvider,
  buildStatusSnapshot,
  type DiscordHealthSnapshot,
} from '../../src/http/status.js';
import { RuntimeState } from '../../src/runtime-state.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import type { AppConfig } from '../../src/config.js';
import { APP_VERSION } from '../../src/version.js';

/**
 * Protected `/status` endpoint (Section 32.3).
 *
 * Acceptance — verbatim: "Missing/wrong credentials receive no status data and
 * authorized output contains every required safe field."
 *
 * The HTTP layer's constant-time bearer gate (404 when no admin token, 401 on
 * bad/missing bearer) is exercised here against the REAL status provider bound
 * to a seeded database, and the authorized body is checked for every Section
 * 32.3 field and for reflected seeded values — with no secret leakage.
 */

const GUILD = '100000000000000001';
const HOST = '127.0.0.1';
const TOKEN = 'status-admin-token-xyz';
// A fixed "now" inside 2026-08-11 UTC so the org-day ("today") window is stable.
const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const TIMEZONE = 'UTC';
const BUILD_INFO = {
  appVersion: APP_VERSION,
  sourceRevision: null,
  railwayDeploymentId: '00000000-0000-4000-8000-000000000002',
  buildId: null,
};

interface Env {
  db: DatabaseSync;
  testDb: TestDb;
  runtime: RuntimeState;
  config: AppConfig;
  backupsDir: string;
}

const servers: Array<{ close(): Promise<void> }> = [];
const testDbs: TestDb[] = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (testDbs.length) testDbs.pop()!.cleanup();
});

function setup(): Env {
  const testDb = createTestDb();
  testDbs.push(testDb);
  const db = testDb.db;
  seedIdentity(db, GUILD);

  upsertChannel(db, channel('org-1', 'org'));
  upsertChannel(db, channel('restricted-1', 'restricted'));

  // One open + one reviewed episode.
  insertEpisode(db, 'ep-open', 'org-1', 'open', NOW - 60_000);
  insertEpisode(db, 'ep-reviewed', 'org-1', 'reviewed', NOW - 120_000);

  // One completed (success) and one failed agent run.
  insertAgentRun(db, 'run-ok', 'completed', NOW - 5_000, NOW - 4_000);
  insertAgentRun(db, 'run-fail', 'failed', NOW - 3_000, NOW - 2_500);

  // Two pending-review proposals (depend on run-ok + a channel).
  insertProposal(db, 'prop-1', 'run-ok', 'org-1', 'pending_review', NOW - 1_000);
  insertProposal(db, 'prop-2', 'run-ok', 'restricted-1', 'pending_review', NOW - 900);

  // Three sent-today outbox rows + one queued.
  insertOutbox(db, 'out-1', 'org-1', 'sent', NOW - 800);
  insertOutbox(db, 'out-2', 'org-1', 'sent', NOW - 700);
  insertOutbox(db, 'out-3', 'restricted-1', 'sent', NOW - 600);
  insertOutbox(db, 'out-4', 'org-1', 'queued', null);

  // A completed backup pair (the manifest marks post-integrity-check completion).
  const backupsDir = join(testDb.dir, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const backupFile = join(backupsDir, 'mneme-20260811-120000.sqlite');
  writeFileSync(backupFile, Buffer.alloc(64));
  writeFileSync(`${backupFile}.manifest.json`, '{}');

  const runtime = new RuntimeState();
  runtime.markMigrationsApplied();
  runtime.markPolicyAndPromptsCompiled();
  runtime.markDiscordAuthenticated();
  runtime.markCommandsRegistered();
  runtime.markModelHealthy();

  const config = {
    mode: 'review',
    databasePath: testDb.path,
    dataDir: testDb.dir,
    organization: { name: 'Test Org', timezone: TIMEZONE },
    llm: { dailyBudgetUsd: 5 },
  } as unknown as AppConfig;

  return { db, testDb, runtime, config, backupsDir };
}

function channel(id: string, visibility: 'org' | 'restricted' | 'review_only' | 'excluded') {
  return {
    id, guildId: GUILD, parentId: null, type: 0, name: id, topic: null, position: null,
    isThread: false, isArchived: false, isLocked: false, ingestEnabled: true,
    visibilityClass: visibility, allowInterventions: false, permissionFingerprint: null,
    lastMessageId: null, discoveredAtMs: NOW, updatedAtMs: NOW, rawJson: null,
  };
}

function insertEpisode(db: DatabaseSync, id: string, channel: string, status: string, startedAtMs: number): void {
  db.prepare(
    `INSERT INTO episodes (id, workspace_id, conversation_channel_id, status, started_at_ms, last_activity_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, GUILD, channel, status, startedAtMs, startedAtMs, startedAtMs, startedAtMs);
}

function insertAgentRun(
  db: DatabaseSync, id: string, status: string, startedAtMs: number, endedAtMs: number,
): void {
  const completed = status === 'completed';
  db.prepare(
    `INSERT INTO agent_runs (id, workspace_id, run_type, prompt_version, provider, model,
       status, started_at_ms, ended_at_ms, input_tokens, output_tokens, cost_usd,
       uncached_input_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens)
     VALUES (?, ?, 'episode', 'pv-1', 'openai', 'gpt-test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, GUILD, status, startedAtMs, endedAtMs,
    completed ? 100 : 50, completed ? 20 : 10, completed ? 0.01 : 0.005,
    completed ? 40 : null, completed ? 50 : null, completed ? 10 : null,
    completed ? 5 : null,
  );
}

function insertProposal(
  db: DatabaseSync, id: string, runId: string, channel: string, status: string, createdAtMs: number,
): void {
  db.prepare(
    `INSERT INTO proposals (id, run_id, target_channel_id, status, computed_score, reason, evidence_message_ids_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, runId, channel, status, 0.5, 'reason', createdAtMs, createdAtMs);
}

function insertOutbox(
  db: DatabaseSync, id: string, channel: string, status: string, sentAtMs: number | null,
): void {
  db.prepare(
    `INSERT INTO outbox (id, channel_id, content, dedupe_key, status, next_attempt_at_ms, attempts, created_at_ms, updated_at_ms, sent_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(id, channel, 'post body', `dk-${id}`, status, NOW, NOW, NOW, sentAtMs);
}

function discord(): DiscordHealthSnapshot {
  return { connected: true, ready: true, pingMs: 42, lastEventAtMs: NOW - 10, reconnectCount: 1 };
}

function start(env: Env, opts: { adminToken?: string } = {}): Promise<{ base: string }> {
  const provider = createStatusProvider({
    db: env.db,
    config: env.config,
    runtime: env.runtime,
    buildInfo: BUILD_INFO,
    startedAtMs: NOW - 60_000,
    now: () => NOW,
    backupsDir: env.backupsDir,
    discord,
  });
  return startHttpServer({
    port: 0,
    host: HOST,
    logger: createLogger(),
    adminToken: opts.adminToken,
    statusProvider: provider,
  }).then((handle) => {
    servers.push(handle);
    return { base: `http://${HOST}:${handle.port}` };
  });
}

describe('/status authorization gate', () => {
  it('returns 404 (disabled) when no admin token is configured', async () => {
    const env = setup();
    const { base } = await start(env); // no adminToken
    const res = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('returns 401 and no status data for a missing bearer', async () => {
    const env = setup();
    const { base } = await start(env, { adminToken: TOKEN });
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 and no status data for a wrong bearer', async () => {
    const env = setup();
    const { base } = await start(env, { adminToken: TOKEN });
    const res = await fetch(`${base}/status`, { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
    // No operational field leaks on denial.
    expect(body.version).toBeUndefined();
    expect(body.queue).toBeUndefined();
  });
});

describe('authorized output contains every required safe field', () => {
  async function authorizedBody(): Promise<Record<string, unknown>> {
    const env = setup();
    const { base } = await start(env, { adminToken: TOKEN });
    const res = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  it('includes version, uptime, mode, and readiness', async () => {
    const body = await authorizedBody();
    expect(body.version).toBe(APP_VERSION);
    expect(body.build).toEqual(BUILD_INFO);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.mode).toBe('review');
    expect(body.ready).toBe(true);
    expect(body.paused).toBe(false);
  });

  it('includes Discord ready/ping/last-event (no token)', async () => {
    const d = (await authorizedBody()).discord as Record<string, unknown>;
    expect(d.ready).toBe(true);
    expect(d.pingMs).toBe(42);
    expect(d.lastEventAtMs).toBe(NOW - 10);
    expect(d.connected).toBe(true);
  });

  it('includes channel counts by policy and backfill sync state', async () => {
    const body = await authorizedBody();
    const policy = body.policy as Record<string, number>;
    expect(policy.org).toBe(1);
    // seedIdentity seeds a 'general' restricted channel, plus our restricted-1.
    expect(policy.restricted).toBe(2);
    const sync = body.sync as Record<string, number>;
    for (const key of [
      'channels',
      'historyComplete',
      'inProgress',
      'errors',
      'eligibleChannels',
      'eligibleHistoryComplete',
      'eligibleInProgress',
      'eligibleErrors',
      'controlIgnored',
      'policyExcluded',
    ]) {
      expect(typeof sync[key]).toBe('number');
    }
  });

  it('includes job queue counts and open episodes', async () => {
    const body = await authorizedBody();
    const queue = body.queue as Record<string, unknown>;
    for (const key of ['queued', 'due', 'deferred', 'running', 'failed']) {
      expect(typeof queue[key]).toBe('number');
    }
    // Additive diagnostics preserve the legacy flat counters above.
    expect(Array.isArray(queue.failedByType)).toBe(true);
    expect(typeof queue.failedOther).toBe('number');
    expect((body.episodes as Record<string, number>).open).toBe(1);
  });

  it('includes pending proposals and outbox state', async () => {
    const body = await authorizedBody();
    const proposals = body.proposals as Record<string, number>;
    // `pendingReview` is the backward-compatible durable raw count; the two
    // additive fields distinguish what the admin can act on right now.
    expect(proposals.pendingReview).toBe(2);
    expect(proposals.actionablePendingReview).toBe(2);
    expect(proposals.stalePendingReview).toBe(0);
    // Outbox counts are the flat per-status map; sent reflects the 3 sent rows.
    const outbox = body.outbox as Record<string, number>;
    expect(outbox.sent).toBe(3);
    expect(typeof outbox.queued).toBe('number');
    const direct = body.directAnswers as Record<string, unknown>;
    expect(direct.suppressed).toBe(0);
    expect(direct.pending).toBe(0);
    expect(direct.pendingOverdue).toBe(0);
    expect(direct.primary).toEqual({ queued: 0, sent: 0, failed: 0 });
    expect(direct.partial).toEqual({ queued: 0, sent: 0, failed: 0 });
    expect(direct.fallback).toEqual({ queued: 0, sent: 0, failed: 0 });
    expect(direct.sentLatencyMs).toEqual({ average: null, maximum: null, latest: null });
  });

  it('includes last model success/failure timestamps reflecting agent_runs', async () => {
    const model = (await authorizedBody()).model as Record<string, unknown>;
    expect(model.healthy).toBe(true);
    expect(model.lastSuccessMs).toBe(NOW - 4_000);
    expect(model.lastFailureMs).toBe(NOW - 2_500);
    expect(typeof model.lastCallAtMs).toBe('number');
  });

  it('keeps status model totals on the existing aggregate columns', async () => {
    const model = (await authorizedBody()).model as Record<string, unknown>;
    expect(model.today).toEqual({ costUsd: 0.015, inputTokens: 150, outputTokens: 30 });
    expect(model.allTime).toEqual({ costUsd: 0.015, inputTokens: 150, outputTokens: 30 });
    expect(model).not.toHaveProperty('cacheReadTokens');
    expect(model).not.toHaveProperty('reasoningTokens');
  });

  it('includes database path/size, WAL size, and backup recency', async () => {
    const body = await authorizedBody();
    const database = body.database as Record<string, unknown>;
    expect(typeof database.path).toBe('string');
    expect(typeof database.sizeBytes).toBe('number');
    expect(database.sizeBytes).toBeGreaterThan(0);
    // WAL size is present (null or number) but not undefined.
    expect(database.walSizeBytes === null || typeof database.walSizeBytes === 'number').toBe(true);
    const backup = body.backup as Record<string, unknown>;
    expect(backup.count).toBe(1);
    expect(typeof backup.lastBackupAtMs).toBe('number');
  });

  it('includes the daily post count reflecting sent-today outbox rows', async () => {
    const body = await authorizedBody();
    expect(body.dailyPostCount).toBe(3);
  });
});

describe('authorized output never carries secrets', () => {
  it('does not echo the Discord token, provider key, or admin token', async () => {
    const env = setup();
    // Place stand-in secrets where the process env would hold them; the provider
    // must never read or echo them.
    const DISCORD = 'discord-bot-secret-123';
    const APIKEY = 'provider-key-secret-456';
    process.env.DISCORD_TOKEN = DISCORD;
    process.env.OPENAI_API_KEY = APIKEY;
    const { base } = await start(env, { adminToken: TOKEN });

    const res = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const text = await res.text();
    expect(text).not.toContain(DISCORD);
    expect(text).not.toContain(APIKEY);
    // The admin token itself must not appear outside the request header.
    expect(text).not.toContain(TOKEN);

    delete process.env.DISCORD_TOKEN;
    delete process.env.OPENAI_API_KEY;
  });
});

describe('buildStatusSnapshot is directly usable', () => {
  it('returns the full snapshot from deps without an HTTP round trip', () => {
    const env = setup();
    const snap = buildStatusSnapshot({
      db: env.db,
      config: env.config,
      runtime: env.runtime,
      buildInfo: BUILD_INFO,
      startedAtMs: NOW - 60_000,
      now: () => NOW,
      backupsDir: env.backupsDir,
      discord,
    });
    expect(snap.version).toEqual(expect.any(String));
    expect((snap.episodes as Record<string, number>).open).toBe(1);
    expect(snap.dailyPostCount).toBe(3);
    expect((snap.model as Record<string, unknown>).lastFailureMs).toBe(NOW - 2_500);
  });
});
