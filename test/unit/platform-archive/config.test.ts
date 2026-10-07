// ABOUTME: Tests the read-only platform archive settings (plan 011 step 1, decision 1).
// ABOUTME: Both settings or neither; the archive must not be the live database or sit in the backup directory.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../../../src/config.js';

let suiteCwd = '';
let emptyCwd = '';
beforeAll(() => {
  suiteCwd = process.cwd();
  emptyCwd = mkdtempSync(join(tmpdir(), 'mneme-archive-config-test-'));
  process.chdir(emptyCwd);
});
afterAll(() => {
  process.chdir(suiteCwd);
  rmSync(emptyCwd, { recursive: true, force: true });
});

function slackEnv(): Record<string, string | undefined> {
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
    DATA_DIR: '/app/data',
    DATABASE_PATH: '/app/data/mneme.sqlite',
    BACKUP_DIR: '/app/data/backups',
  };
}

function expectFail(env: Record<string, string | undefined>, setting: string): ConfigError {
  try {
    loadConfig({ env });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).setting).toBe(setting);
    return err as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('platform archive settings', () => {
  it('has no archive when both settings are unset', () => {
    expect(loadConfig({ env: slackEnv() }).archive).toBeUndefined();
  });

  it('reads the archive path and platform', () => {
    const config = loadConfig({ env: { ...slackEnv(), MNEME_ARCHIVE_PATH: '/app/data/archive/discord.sqlite', MNEME_ARCHIVE_PLATFORM: 'discord' } });
    expect(config.archive).toEqual({ path: '/app/data/archive/discord.sqlite', platform: 'discord' });
  });

  it('refuses a path without a platform', () => {
    expectFail({ ...slackEnv(), MNEME_ARCHIVE_PATH: '/app/data/archive/discord.sqlite' }, 'MNEME_ARCHIVE_PLATFORM');
  });

  it('refuses a platform without a path', () => {
    expectFail({ ...slackEnv(), MNEME_ARCHIVE_PLATFORM: 'discord' }, 'MNEME_ARCHIVE_PATH');
  });

  it('refuses an unknown archive platform', () => {
    expectFail({ ...slackEnv(), MNEME_ARCHIVE_PATH: '/app/data/archive/x.sqlite', MNEME_ARCHIVE_PLATFORM: 'teams' }, 'MNEME_ARCHIVE_PLATFORM');
  });

  it('refuses an archive from the live platform', () => {
    expectFail({ ...slackEnv(), MNEME_ARCHIVE_PATH: '/app/data/archive/x.sqlite', MNEME_ARCHIVE_PLATFORM: 'slack' }, 'MNEME_ARCHIVE_PLATFORM');
  });

  it.each([
    ['a relative path', 'archive/discord.sqlite'],
    ['a parent-directory segment', '/app/data/../etc/discord.sqlite'],
  ])('refuses %s', (_name, path) => {
    expectFail({ ...slackEnv(), MNEME_ARCHIVE_PATH: path, MNEME_ARCHIVE_PLATFORM: 'discord' }, 'MNEME_ARCHIVE_PATH');
  });

  it('refuses the live database path', () => {
    expectFail({ ...slackEnv(), MNEME_ARCHIVE_PATH: '/app/data/mneme.sqlite', MNEME_ARCHIVE_PLATFORM: 'discord' }, 'MNEME_ARCHIVE_PATH');
  });

  it.each([
    ['in the backup directory', '/app/data/backups/mneme-20261002-201820.sqlite'],
    ['below the backup directory', '/app/data/backups/old/discord.sqlite'],
  ])('refuses a file %s, because retention could delete it', (_name, path) => {
    expectFail({ ...slackEnv(), MNEME_ARCHIVE_PATH: path, MNEME_ARCHIVE_PLATFORM: 'discord' }, 'MNEME_ARCHIVE_PATH');
  });

  it('accepts a sibling directory whose name starts like the backup directory', () => {
    const config = loadConfig({ env: { ...slackEnv(), MNEME_ARCHIVE_PATH: '/app/data/backups-archive/discord.sqlite', MNEME_ARCHIVE_PLATFORM: 'discord' } });
    expect(config.archive?.path).toBe('/app/data/backups-archive/discord.sqlite');
  });
});
