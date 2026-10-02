// ABOUTME: Tests the Slack configuration keys (spec Section 35.1, plan 006 step 2).
// ABOUTME: Each key fails closed with a clear setting name; token values never appear in errors.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../../../src/config.js';

let suiteCwd = '';
let emptyCwd = '';
beforeAll(() => {
  suiteCwd = process.cwd();
  emptyCwd = mkdtempSync(join(tmpdir(), 'mneme-slack-config-test-'));
  process.chdir(emptyCwd);
});
afterAll(() => {
  process.chdir(suiteCwd);
  rmSync(emptyCwd, { recursive: true, force: true });
});

const BOT = 'xoxb-1111-2222-secretbotvalue';
const APP = 'xapp-1-A0000-3333-secretappvalue';

function slackEnv(): Record<string, string | undefined> {
  return {
    MNEME_PLATFORM: 'slack',
    SLACK_BOT_TOKEN: BOT,
    SLACK_APP_TOKEN: APP,
    SLACK_TEAM_ID: 'T0000000001',
    MNEME_ADMIN_USER_IDS: 'U0000000001',
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'gpt-5.6-terra',
    OPENAI_API_KEY: 'sk-test-key-value',
    ORG_NAME: 'Test Org',
    ORG_TIMEZONE: 'UTC',
    FULL_HISTORY: 'true',
  };
}

function expectFail(env: Record<string, string | undefined>, setting: string): ConfigError {
  try {
    loadConfig({ env });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    const e = err as ConfigError;
    expect(e.setting).toBe(setting);
    expect(e.message).not.toContain('secretbotvalue');
    expect(e.message).not.toContain('secretappvalue');
    return e;
  }
  throw new Error('expected loadConfig to throw');
}

describe('Slack configuration', () => {
  it('loads a valid Slack environment without Discord settings', () => {
    const config = loadConfig({ env: slackEnv() });
    expect(config.platform).toBe('slack');
    expect(config.workspaceId).toBe('T0000000001');
    expect(config.slack).toEqual({ botToken: BOT, appToken: APP, adminUserIds: ['U0000000001'] });
    expect(config.discord).toBeUndefined();
    expect(config.adminRoleIds).toEqual([]);
  });

  it.each([
    ['SLACK_BOT_TOKEN', undefined],
    ['SLACK_BOT_TOKEN', 'xapp-wrong-kind-secretbotvalue'],
    ['SLACK_APP_TOKEN', undefined],
    ['SLACK_APP_TOKEN', 'xoxb-wrong-kind-secretappvalue'],
    ['SLACK_TEAM_ID', undefined],
    ['SLACK_TEAM_ID', 'C0000000001'],
    ['MNEME_ADMIN_USER_IDS', undefined],
    ['MNEME_ADMIN_USER_IDS', 'U0000000001,123456789012345678'],
  ])('fails closed when %s is %s', (key, value) => {
    expectFail({ ...slackEnv(), [key]: value }, key);
  });

  it('rejects Discord admin roles on Slack', () => {
    expectFail({ ...slackEnv(), MNEME_ADMIN_ROLE_IDS: '123456789012345678' }, 'MNEME_ADMIN_ROLE_IDS');
  });

  it('accepts a Slack review channel id and rejects a Discord one', () => {
    expect(loadConfig({ env: { ...slackEnv(), MNEME_REVIEW_CHANNEL_ID: 'C0000000009' } }).reviewChannelId).toBe('C0000000009');
    expectFail({ ...slackEnv(), MNEME_REVIEW_CHANNEL_ID: '123456789012345678' }, 'MNEME_REVIEW_CHANNEL_ID');
  });

  it('rejects MCP OAuth sign-in on Slack', () => {
    expectFail({ ...slackEnv(), MCP_OAUTH_ENABLED: 'true' }, 'MCP_OAUTH_ENABLED');
  });
});
