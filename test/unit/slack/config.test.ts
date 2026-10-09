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

  it('reads Slack deletion approvers and rejects Discord ids', () => {
    expect(loadConfig({ env: { ...slackEnv(), MNEME_DELETION_APPROVER_USER_IDS: 'U0000000001, W0000000002' } }).deletionApproverUserIds)
      .toEqual(['U0000000001', 'W0000000002']);
    expect(loadConfig({ env: slackEnv() }).deletionApproverUserIds).toEqual([]);
    expectFail({ ...slackEnv(), MNEME_DELETION_APPROVER_USER_IDS: '123456789012345678' }, 'MNEME_DELETION_APPROVER_USER_IDS');
  });

  describe('MCP OAuth sign-in on Slack', () => {
    const oauthEnv = (): Record<string, string | undefined> => ({
      ...slackEnv(),
      MCP_ENABLED: 'true',
      MCP_OAUTH_ENABLED: 'true',
      MCP_OAUTH_CLIENT_ID: 'b7f3c1a9d24e40f8',
      SLACK_OAUTH_CLIENT_ID: '1111.2222',
      SLACK_OAUTH_CLIENT_SECRET: 'slack-oauth-secret-value',
    });

    it('reads the Slack OAuth keys into the provider fields', () => {
      const cfg = loadConfig({ env: oauthEnv() });
      expect(cfg.mcp.oauthEnabled).toBe(true);
      expect(cfg.mcp.oauthProviderClientId).toBe('1111.2222');
      expect(cfg.mcp.oauthProviderClientSecret).toBe('slack-oauth-secret-value');
    });

    it('requires the Slack client id and secret', () => {
      expectFail({ ...oauthEnv(), SLACK_OAUTH_CLIENT_ID: undefined }, 'SLACK_OAUTH_CLIENT_ID');
      expectFail({ ...oauthEnv(), SLACK_OAUTH_CLIENT_SECRET: undefined }, 'SLACK_OAUTH_CLIENT_SECRET');
    });

    it('ignores the Discord OAuth keys', () => {
      const env = {
        ...oauthEnv(),
        SLACK_OAUTH_CLIENT_ID: undefined,
        SLACK_OAUTH_CLIENT_SECRET: undefined,
        DISCORD_OAUTH_CLIENT_ID: '987654321098765432',
        DISCORD_OAUTH_CLIENT_SECRET: 'discord-oauth-secret-value',
      };
      expectFail(env, 'SLACK_OAUTH_CLIENT_ID');
    });

    it('needs no admin roles, because Slack admins are user ids', () => {
      expect(loadConfig({ env: oauthEnv() }).adminRoleIds).toEqual([]);
    });
  });

  describe('history campaign channels', () => {
    it('refuses Discord ids in HISTORICAL_MEMORY_CHANNEL_IDS', () => {
      const e = expectFail({ ...slackEnv(), HISTORICAL_MEMORY_CHANNEL_IDS: '1537468798733516861' }, 'HISTORICAL_MEMORY_CHANNEL_IDS');
      expect(e.message).toContain('Slack channel id');
    });

    it('refuses a synthetic Slack thread id, because a campaign runs per channel', () => {
      expectFail({ ...slackEnv(), HISTORICAL_MEMORY_CHANNEL_IDS: 'C0C7YK7KL8Y-T1791552275.858689' }, 'HISTORICAL_MEMORY_CHANNEL_IDS');
    });

    it('accepts Slack channel ids', () => {
      const config = loadConfig({ env: { ...slackEnv(), HISTORICAL_MEMORY_CHANNEL_IDS: 'C0C7YK7KL8Y, G0C6Y1NNBGT' } });
      expect(config.historicalMemory.channelIds).toEqual(['C0C7YK7KL8Y', 'G0C6Y1NNBGT']);
    });
  });
});
