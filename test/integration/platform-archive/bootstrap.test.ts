// ABOUTME: Tests that startup opens and verifies the platform archive before the platform connects (plan 011 step 2).
// ABOUTME: A bad archive stops startup; shutdown closes the archive handle.
import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { ARCHIVE_GUILD, createArchiveFixture, type ArchiveFixture } from '../../helpers/archive.js';
import { loadConfig } from '../../../src/config.js';
import { bootstrapApplication, BootstrapError, type BootstrapContext, type BootstrapSeams } from '../../../src/bootstrap.js';

function slackEnv(archivePath?: string): Record<string, string | undefined> {
  return {
    MNEME_PLATFORM: 'slack',
    SLACK_BOT_TOKEN: 'xoxb-1111-2222-secretbotvalue',
    SLACK_APP_TOKEN: 'xapp-1-A0000-3333-secretappvalue',
    SLACK_TEAM_ID: 'T0000000001',
    MNEME_ADMIN_USER_IDS: 'U0000000001',
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'gpt-5.6-terra',
    OPENAI_API_KEY: 'sk-test-key-value',
    ORG_NAME: 'Test Org',
    ORG_TIMEZONE: 'UTC',
    FULL_HISTORY: 'true',
    ...(archivePath ? { MNEME_ARCHIVE_PATH: archivePath, MNEME_ARCHIVE_PLATFORM: 'discord' } : {}),
  };
}

function seams(onConnect: (ctx: BootstrapContext) => void): BootstrapSeams {
  return {
    startHttp: false,
    compilePromptsAndPolicy: () => {},
    connectPlatform: (ctx) => {
      onConnect(ctx);
      return { destroy() {} };
    },
    beginIngestion: () => {},
    registerCommands: () => {},
    discoverAndBackfill: () => {},
    startJobRuntime: () => ({ stop() {} }),
  };
}

let live: TestDb | undefined;
let archive: ArchiveFixture | undefined;
afterEach(() => {
  live?.cleanup();
  archive?.cleanup();
  live = undefined;
  archive = undefined;
});

describe('bootstrap with a platform archive', () => {
  it('opens and verifies the archive before the platform connects', async () => {
    live = createTestDb();
    archive = createArchiveFixture();
    let seen: BootstrapContext | undefined;
    const result = await bootstrapApplication({
      config: loadConfig({ env: slackEnv(archive.path) }),
      db: live.db,
      seams: seams((ctx) => { seen = ctx; }),
      installSignals: false,
    });
    expect(seen?.platformArchive?.summary).toMatchObject({ platform: 'discord', workspaceId: ARCHIVE_GUILD, orgMessages: 2, orgMemories: 1 });
    const handle = seen!.platformArchive!.db;
    await result.stop();
    expect(() => handle.prepare('SELECT 1').get()).toThrow();
  });

  it('has no archive when none is configured', async () => {
    live = createTestDb();
    let seen: BootstrapContext | undefined;
    const result = await bootstrapApplication({
      config: loadConfig({ env: slackEnv() }),
      db: live.db,
      seams: seams((ctx) => { seen = ctx; }),
      installSignals: false,
    });
    expect(seen).toBeDefined();
    expect(seen!.platformArchive).toBeUndefined();
    await result.stop();
  });

  it('stops startup on a bad archive and never connects the platform', async () => {
    live = createTestDb();
    archive = createArchiveFixture({
      mutate: (db) => db.prepare('INSERT INTO workspaces (id, name, joined_at_ms, discovered_at_ms, updated_at_ms) VALUES (?, ?, 1, 1, 1)')
        .run('300000000000000099', 'Second'),
    });
    let connected = false;
    await expect(bootstrapApplication({
      config: loadConfig({ env: slackEnv(archive.path) }),
      db: live.db,
      seams: seams(() => { connected = true; }),
      installSignals: false,
    })).rejects.toThrow(BootstrapError);
    expect(connected).toBe(false);
  });
});
