import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { get } from 'node:http';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { loadConfig } from '../../src/config.js';
import { bootstrapApplication, BootstrapError, type BootstrapSeams, type DiscordWiring } from '../../src/bootstrap.js';
import { setRuntimeModeOverride } from '../../src/runtime-state.js';

/**
 * Application bootstrap (Sections 5, 9.2, 34).
 *
 * Acceptance: "A bootstrap integration test records the Section 9.2 ordering and
 * demonstrates one-process singleton architecture."
 */

function baseEnv(): Record<string, string | undefined> {
  return {
    MNEME_PLATFORM: 'discord',
    DISCORD_TOKEN: 'a-real-discord-token-value',
    DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_GUILD_ID: '234567890123456789',
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'gpt-5.6-terra',
    FULL_HISTORY: 'true',
    OPENAI_API_KEY: 'sk-test-key-value',
    ORG_NAME: 'Test Org',
    ORG_TIMEZONE: 'UTC',
  };
}

const EXPECTED_ORDER = [
  'sqlite_migrated',
  'livez_started',
  'prompts_policy_compiled',
  'discord_connected',
  'ingestion_started',
  'readyz_ready',
  'channels_enumerated',
  'backfill_enqueued',
  'archived_threads_enumerated',
  'backfill_continued',
] as const;

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get({ port, host: '127.0.0.1', path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

/** Seams that record their invocation order and drive the discovery phases. */
function recordingSeams(log: string[]): BootstrapSeams {
  return {
    compilePromptsAndPolicy: () => {
      log.push('compile');
    },
    connectDiscord: async (): Promise<DiscordWiring> => {
      log.push('connect');
      return { destroy: () => log.push('discord-destroy') };
    },
    beginIngestion: () => {
      log.push('ingest');
    },
    registerCommands: () => {
      log.push('commands');
    },
    discoverAndBackfill: (_ctx, _discord, record) => {
      log.push('discover');
      record('enumerate-channels');
      record('enqueue-backfill');
      record('enumerate-archived-threads');
      record('enqueue-archived-backfill');
    },
    startJobRuntime: () => ({
      stop: () => {
        log.push('jobs-stop');
      },
    }),
  };
}

let env: TestDb;

beforeEach(() => {
  env = createTestDb();
});
afterEach(() => env.cleanup());

describe('bootstrapApplication — Section 9.2 ordering and singletons', () => {
  it('restores a durable Discord mode override before connecting', async () => {
    setRuntimeModeOverride(env.db, { mode: 'observe', actorUserId: 'admin', now: Date.now() });
    const config = loadConfig({ env: { ...baseEnv(), MNEME_MODE: 'review', MNEME_REVIEW_CHANNEL_ID: '345678901234567890' },
      channelPolicyReview: { id: '345678901234567890', secure: true } });
    let modeSeenAtConnect: string | undefined;
    const seams = recordingSeams([]);
    seams.startHttp = false;
    seams.connectDiscord = (ctx) => {
      modeSeenAtConnect = ctx.config.mode;
      return { destroy() {} };
    };
    const result = await bootstrapApplication({
      config,
      db: env.db,
      seams,
      installSignals: false,
    });

    expect(config.mode).toBe('observe');
    expect(modeSeenAtConnect).toBe('observe');
    await result.stop();
  });

  it('records the ten startup milestones in Section 9.2 order', async () => {
    const log: string[] = [];
    const result = await bootstrapApplication({
      config: loadConfig({ env: baseEnv() }),
      db: env.db,
      httpPort: 0,
      seams: recordingSeams(log),
      installSignals: false,
    });

    expect(result.milestones.map((m) => m.name)).toEqual(EXPECTED_ORDER);
    expect(result.milestones.map((m) => m.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Milestones are strictly increasing in time.
    const times = result.milestones.map((m) => m.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));

    await result.httpServer?.close();
  });

  it('drives each seam exactly once (one-process singletons)', async () => {
    const log: string[] = [];
    const result = await bootstrapApplication({
      config: loadConfig({ env: baseEnv() }),
      db: env.db,
      httpPort: 0,
      seams: recordingSeams(log),
      installSignals: false,
    });

    // One of each: the database passed in is the one used; one http server; one
    // discord connect; one job runtime.
    expect(result.db).toBe(env.db);
    expect(result.httpServer).not.toBeNull();
    expect(result.httpServer?.port).toBeGreaterThan(0);
    expect(log.filter((x) => x === 'connect')).toHaveLength(1);
    expect(log.filter((x) => x === 'ingest')).toHaveLength(1);
    expect(log.filter((x) => x === 'compile')).toHaveLength(1);

    await result.httpServer?.close();
  });

  it('serves /livez ok and /readyz ready after the full sequence', async () => {
    const result = await bootstrapApplication({
      config: loadConfig({ env: baseEnv() }),
      db: env.db,
      httpPort: 0,
      seams: recordingSeams([]),
      installSignals: false,
    });

    expect(result.runtime.isReady()).toBe(true);
    const port = result.httpServer!.port;

    const livez = await httpGet(port, '/livez');
    expect(livez.status).toBe(200);

    const readyz = await httpGet(port, '/readyz');
    expect(readyz.status).toBe(200);

    await result.httpServer?.close();
  });

  it('lets the early-started HTTP status provider observe the later live Discord tracker', async () => {
    const adminToken = 'bootstrap-status-admin-token';
    const seams = recordingSeams([]);
    seams.connectDiscord = () => ({
      tracker: {
        snapshot: () => ({
          status: 'resumed',
          ready: true,
          pingMs: 37,
          lastEventAtMs: 1_700_000_001_000,
          reconnects: 2,
        }),
      },
      destroy() {},
    });
    const result = await bootstrapApplication({
      config: loadConfig({ env: { ...baseEnv(), HTTP_ADMIN_TOKEN: adminToken } }),
      db: env.db,
      httpPort: 0,
      seams,
      installSignals: false,
    });

    const response = await fetch(`http://127.0.0.1:${result.httpServer!.port}/status`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = await response.json() as { discord: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.discord).toMatchObject({
      connected: true,
      ready: true,
      pingMs: 37,
      lastEventAtMs: 1_700_000_001_000,
      reconnectCount: 2,
    });

    await result.stop();
  });

  it('runs graceful shutdown through the coordinator', async () => {
    const log: string[] = [];
    const result = await bootstrapApplication({
      config: loadConfig({ env: baseEnv() }),
      db: env.db,
      httpPort: 0,
      seams: recordingSeams(log),
      installSignals: false,
    });

    const shutdown = await result.stop();
    expect(result.runtime.isShuttingDown()).toBe(true);
    expect(shutdown.drained).toBe(true);
    expect(shutdown.stages.database).toBe('ok');

    await result.httpServer?.close();
  });
});

describe('bootstrapApplication — clean preconditions', () => {
  it('unwinds an acquired Discord connection when a later startup step fails', async () => {
    const log: string[] = [];
    await expect(bootstrapApplication({
      config: loadConfig({ env: baseEnv() }),
      db: env.db,
      seams: {
        startHttp: false,
        compilePromptsAndPolicy: () => {},
        connectDiscord: () => ({ client: {}, destroy: () => { log.push('discord-destroy'); } }),
        beginIngestion: () => {},
        registerCommands: () => { throw new Error('command registration failed'); },
      },
      installSignals: false,
    })).rejects.toThrow('command registration failed');

    expect(log).toEqual(['discord-destroy']);
    // Caller-owned resources remain caller-owned and usable.
    expect(env.db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 });
  });

  it('fails cleanly when a connectDiscord seam raises a precondition error', async () => {
    const failingSeams: BootstrapSeams = {
      compilePromptsAndPolicy: () => {},
      connectDiscord: async () => {
        throw new BootstrapError('DISCORD_TOKEN is not configured; cannot connect the Discord Gateway');
      },
    };
    await expect(
      bootstrapApplication({
        config: loadConfig({ env: baseEnv() }),
        db: env.db,
        httpPort: 0,
        seams: failingSeams,
        installSignals: false,
      }),
    ).rejects.toBeInstanceOf(BootstrapError);
  });

  it('does not claim readiness when command registration has no real client or seam', async () => {
    const result = await bootstrapApplication({
      config: loadConfig({ env: baseEnv() }),
      db: env.db,
      httpPort: 0,
      seams: {
        compilePromptsAndPolicy: () => {},
        connectDiscord: async () => ({ destroy: () => {} }),
        beginIngestion: () => {},
      },
      installSignals: false,
    });

    const names = result.milestones.map((m) => m.name);
    expect(names).toContain('readyz_ready');
    // Discovery/backfill (7-10) only runs when its seam is supplied.
    expect(names).not.toContain('channels_enumerated');
    expect(result.runtime.isReady()).toBe(false);

    await result.httpServer?.close();
  });
});
