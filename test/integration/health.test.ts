import { describe, it, expect, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createLivenessProbe, classifyDatabaseError } from '../../src/http/health.js';
import { createTestDb, type TestDb } from '../helpers/db.js';

const HOST = '127.0.0.1';
const log = () => createLogger({ level: 'silent' });

let handle: HttpServerHandle | undefined;
let env: TestDb | undefined;
let base: string;

async function start(): Promise<void> {
  handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: log(),
    healthProbe: createLivenessProbe(env!.db),
  });
  base = `http://${HOST}:${handle.port}`;
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  if (env) env.cleanup();
  env = undefined;
});

describe('liveness endpoint', () => {
  it('returns 200 ok when SQLite SELECT 1 succeeds', async () => {
    env = createTestDb();
    await start();
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('fails liveness (503) when the database is unavailable, without leaking its path', async () => {
    env = createTestDb();
    await start();
    // Close the connection the probe reads from — SELECT 1 now throws.
    env.db.close();
    const dirName = env.dir;

    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unhealthy');
    expect(body.error).toBe('database_closed');
    // The response must not reveal the database path or any raw message.
    const text = JSON.stringify(body);
    expect(text).not.toContain(dirName.split(/[\\/]/).pop() as string);
    expect(text).not.toContain('.sqlite');
  });

  it('stays live regardless of Discord or model state (probe touches neither)', async () => {
    env = createTestDb();
    await start();
    // No Discord client, no model client is wired anywhere — liveness is up.
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(200);
  });

  it('classifies database errors into safe, content-free codes', () => {
    // A closed connection throws ERR_INVALID_STATE.
    const e = createTestDb();
    e.db.close();
    const closedErr = (() => {
      try {
        e.db.prepare('SELECT 1').get();
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(closedErr).not.toBeNull();
    expect(classifyDatabaseError(closedErr)).toBe('database_closed');
    e.cleanup();

    // Unknown error shapes collapse to the generic safe code.
    expect(classifyDatabaseError(new Error('something /app/data/mneme.sqlite'))).toBe(
      'database_unhealthy',
    );
    expect(classifyDatabaseError('not even an error')).toBe('database_unhealthy');
  });

  it('liveness is cheap and idempotent across repeated checks', async () => {
    env = createTestDb();
    await start();
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/livez`);
      expect(res.status).toBe(200);
    }
  });
});
