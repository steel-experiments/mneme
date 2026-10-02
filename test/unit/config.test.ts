import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadOperationalConfig, parseDotEnv, mcpEndpointUrl, ConfigError } from '../../src/config.js';

const MNEME_YML = fileURLToPath(new URL('../../config/mneme.yml', import.meta.url));
const ENV_EXAMPLES = ['../../.env.example', '../../config/advanced.env.example'].map((rel) =>
  fileURLToPath(new URL(rel, import.meta.url)),
);

/**
 * Every test runs from a directory without ./.env, so a developer file at the
 * repo root cannot change the defaults under test. The .env loading tests
 * change into their own fixture directories.
 */
let suiteCwd = '';
let emptyCwd = '';

beforeAll(() => {
  suiteCwd = process.cwd();
  emptyCwd = mkdtempSync(join(tmpdir(), 'mneme-config-test-'));
  process.chdir(emptyCwd);
});

afterAll(() => {
  process.chdir(suiteCwd);
  rmSync(emptyCwd, { recursive: true, force: true });
});

/** A minimal valid environment. Overrides per test. */
function baseEnv(): Record<string, string | undefined> {
  return {
    MNEME_PLATFORM: 'discord',
    DISCORD_TOKEN: 'a-real-discord-token-value',
    DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_GUILD_ID: '234567890123456789',
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'gpt-5.6-terra',
    OPENAI_API_KEY: 'sk-test-key-value',
    ORG_NAME: 'Test Org',
    ORG_TIMEZONE: 'UTC',
    // The initial import scope must be an explicit operator choice.
    FULL_HISTORY: 'true',
  };
}

function expectFail(env: Record<string, string | undefined>, setting: string): void {
  try {
    loadConfig({ env });
    throw new Error('expected loadConfig to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    const e = err as ConfigError;
    expect(e.setting).toBe(setting);
  }
}

/** Assert a failure whose whole message is pinned by the design contract. */
function expectPinnedError(env: Record<string, string | undefined>, message: string): void {
  try {
    loadConfig({ env, yamlText: '' });
    throw new Error('expected loadConfig to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(message);
  }
}

describe('config', () => {
  it('requires explicit snowflake deletion approvers, independently of admin roles', () => {
    expect(loadConfig({ env: baseEnv() }).deletionApproverUserIds).toEqual([]);
    expect(loadConfig({ env: { ...baseEnv(), MNEME_DELETION_APPROVER_USER_IDS: '900000000000000001' } }).deletionApproverUserIds).toEqual(['900000000000000001']);
    expectFail({ ...baseEnv(), MNEME_DELETION_APPROVER_USER_IDS: 'niko' }, 'MNEME_DELETION_APPROVER_USER_IDS');
  });
  it('loads a minimal valid configuration', () => {
    const cfg = loadConfig({ env: baseEnv() });
    expect(cfg.workspaceId).toBe('234567890123456789');
    expect(cfg.llm.provider).toBe('openai');
    expect(cfg.llm.apiKey).toBe('sk-test-key-value');
    expect(cfg.mode).toBe('observe');
    expect(cfg.episodeShadow).toEqual({ enabled: false, model: undefined, thinkingLevel: 'low', maxRuns: 50 });
    expect(cfg.deepRecap).toEqual({
      enabled: false,
      maxWindowDays: 30,
      maxBudgetUsd: 20,
      dailyBudgetUsd: 20,
    });
    expect(cfg.personality.traits).toContain('evidence-seeking');
    expect(cfg.historicalMemory).toEqual({
      enabled: false,
      channelIds: [],
      batchMessages: 200,
      maxPendingReviews: 4,
      dailyBudgetUsd: 1,
      campaignId: undefined,
      direction: 'newest_first',
      fromAtMs: undefined,
      toAtMs: undefined,
      model: undefined,
      thinkingLevel: 'medium',
      totalBudgetUsd: 0,
    });
  });

  // ---- Starter defaults ----

  it('defaults the provider and model when LLM_PROVIDER and LLM_MODEL are unset', () => {
    const env = baseEnv();
    delete env.LLM_PROVIDER;
    delete env.LLM_MODEL;
    const cfg = loadConfig({ env, yamlText: '' });
    expect(cfg.llm.provider).toBe('openai');
    expect(cfg.llm.model).toBe('gpt-5.6-terra');
    // A blank value behaves like an unset one; the enums still validate when set.
    const blank = loadConfig({
      env: { ...baseEnv(), LLM_PROVIDER: '', LLM_MODEL: '' },
      yamlText: '',
    });
    expect(blank.llm.provider).toBe('openai');
    expect(blank.llm.model).toBe('gpt-5.6-terra');
  });

  it('defaults the daily LLM admission budget to 2 USD when unset or blank', () => {
    expect(loadConfig({ env: baseEnv(), yamlText: '' }).llm.dailyBudgetUsd).toBe(2);
    expect(loadConfig({
      env: { ...baseEnv(), LLM_DAILY_BUDGET_USD: '' },
      yamlText: '',
    }).llm.dailyBudgetUsd).toBe(2);
    // An explicit value still wins; the cap is admission control, not billing.
    expect(loadConfig({
      env: { ...baseEnv(), LLM_DAILY_BUDGET_USD: '5' },
      yamlText: '',
    }).llm.dailyBudgetUsd).toBe(5);
  });

  it('accepts LLM_DAILY_BUDGET_USD=unlimited as no cap and rejects other words', () => {
    const budget = (value: string) =>
      loadConfig({ env: { ...baseEnv(), LLM_DAILY_BUDGET_USD: value }, yamlText: '' }).llm.dailyBudgetUsd;
    // The keyword is case-insensitive and yields null: the budget gate never blocks.
    expect(budget('unlimited')).toBeNull();
    expect(budget('UNLIMITED')).toBeNull();
    // Zero stays a real cap: no paid run is admitted.
    expect(budget('0')).toBe(0);
    expectFail({ ...baseEnv(), LLM_DAILY_BUDGET_USD: 'abc' }, 'LLM_DAILY_BUDGET_USD');
    expectFail({ ...baseEnv(), LLM_DAILY_BUDGET_USD: '-1' }, 'LLM_DAILY_BUDGET_USD');
  });

  it('defaults deep recap to disabled and keeps its subordinate budgets', () => {
    // The global admission budget gates all spend; these caps stay 20/20 and
    // apply only while the feature is enabled.
    const cfg = loadConfig({ env: baseEnv(), yamlText: '' });
    expect(cfg.deepRecap.enabled).toBe(false);
    expect(cfg.deepRecap.maxBudgetUsd).toBe(20);
    expect(cfg.deepRecap.dailyBudgetUsd).toBe(20);
  });

  it('fails when FULL_HISTORY is unset or blank', () => {
    const pinned =
      'FULL_HISTORY must be set explicitly: choose the initial import scope '
      + '(true = import all reachable history for selected channels, false = new messages onward)';
    const unset = baseEnv();
    delete unset.FULL_HISTORY;
    expectPinnedError(unset, pinned);
    expectPinnedError({ ...baseEnv(), FULL_HISTORY: '' }, pinned);
  });

  it('parses an explicit FULL_HISTORY choice', () => {
    expect(loadConfig({
      env: { ...baseEnv(), FULL_HISTORY: 'true' },
      yamlText: '',
    }).ingestion.fullHistory).toBe(true);
    // false means new messages onward, not a hard historical boundary.
    expect(loadConfig({
      env: { ...baseEnv(), FULL_HISTORY: 'false' },
      yamlText: '',
    }).ingestion.fullHistory).toBe(false);
  });

  it('defaults native-run paths to cwd-relative values', () => {
    // Containers keep absolute /app values from the Dockerfile; a native run
    // starts from the working directory instead.
    const cfg = loadConfig({ env: baseEnv(), yamlText: '' });
    expect(cfg.dataDir).toBe('./data');
    expect(cfg.databasePath).toBe('./data/mneme.sqlite');
    // Derived from DATA_DIR. The contract allows the literal './data/backups'
    // and the path.join derivation, which drops the leading './'.
    expect(['./data/backups', 'data/backups']).toContain(cfg.backupDir);
    expect(cfg.promptDir).toBe('./prompts');
    expect(cfg.docsDir).toBe('./docs');
    expect(cfg.mnemeConfigPath).toBe('./config/mneme.yml');
    expect(cfg.channelPolicyPath).toBe('./config/channel-policy.yml');
  });

  it('still rejects traversal in a relative path', () => {
    expectFail({ ...baseEnv(), DATA_DIR: '../outside' }, 'DATA_DIR');
    expectFail({ ...baseEnv(), CHANNEL_POLICY_PATH: './config/../secrets.yml' }, 'CHANNEL_POLICY_PATH');
  });

  it('validates and parses bounded deep recap settings', () => {
    const cfg = loadConfig({ env: {
      ...baseEnv(),
      DEEP_RECAP_ENABLED: 'false',
      DEEP_RECAP_MAX_WINDOW_DAYS: '7',
      DEEP_RECAP_MAX_BUDGET_USD: '12.5',
      DEEP_RECAP_DAILY_BUDGET_USD: '8',
    } });
    expect(cfg.deepRecap).toEqual({ enabled: false, maxWindowDays: 7, maxBudgetUsd: 12.5, dailyBudgetUsd: 8 });
    expectFail({ ...baseEnv(), DEEP_RECAP_MAX_WINDOW_DAYS: '0' }, 'DEEP_RECAP_MAX_WINDOW_DAYS');
    expectFail({ ...baseEnv(), DEEP_RECAP_MAX_WINDOW_DAYS: '31' }, 'DEEP_RECAP_MAX_WINDOW_DAYS');
    expectFail({ ...baseEnv(), DEEP_RECAP_DAILY_BUDGET_USD: '-1' }, 'DEEP_RECAP_DAILY_BUDGET_USD');
  });

  it('accepts a bounded candidate-model episode shadow experiment', () => {
    const cfg = loadConfig({ env: {
      ...baseEnv(),
      AGENT_THINKING_LEVEL: 'medium',
      EPISODE_SHADOW_ENABLED: 'true',
      EPISODE_SHADOW_MODEL: 'gpt-5.6-luna',
      EPISODE_SHADOW_THINKING_LEVEL: 'high',
      EPISODE_SHADOW_MAX_RUNS: '40',
    } });
    expect(cfg.episodeShadow).toEqual({
      enabled: true,
      model: 'gpt-5.6-luna',
      thinkingLevel: 'high',
      maxRuns: 40,
    });
    expectFail({ ...baseEnv(), AGENT_THINKING_LEVEL: 'low', EPISODE_SHADOW_ENABLED: 'true' },
      'EPISODE_SHADOW_ENABLED');
    expectFail({ ...baseEnv(), EPISODE_SHADOW_ENABLED: 'true', EPISODE_SHADOW_THINKING_LEVEL: 'medium' },
      'EPISODE_SHADOW_ENABLED');
    expectFail({ ...baseEnv(), EPISODE_SHADOW_MAX_RUNS: '0' }, 'EPISODE_SHADOW_MAX_RUNS');
  });

  it('parses the shipped mneme.yml into typed config', () => {
    const yamlText = readFileSync(MNEME_YML, 'utf8');
    // Drop env org overrides so the YAML values are exercised directly.
    const env = baseEnv();
    delete env.ORG_NAME;
    delete env.ORG_TIMEZONE;
    const cfg = loadConfig({ env, yamlText });
    expect(cfg.organization.name).toBe('Your Company');
    expect(cfg.organization.timezone).toBe('UTC');
    expect(cfg.agent.name).toBe('Mneme');
    expect(cfg.intervention.threshold).toBeCloseTo(0.78);
    expect(cfg.intervention.globalDailyLimit).toBe(5);
    expect(cfg.intervention.attentionWindowDays).toBe(7);
    expect(cfg.memory.minimumConfidence).toBeCloseTo(0.55);
    expect(cfg.memory.minimumImportance).toBeCloseTo(0.6);
    expect(cfg.memory.followupHorizonDays).toBe(14);
    expect(cfg.memory.followupMaxMessages).toBe(20);
    expect(cfg.memory.scheduledReviewReminderDays).toBe(7);
    expect(cfg.memory.stalenessHorizonDays).toBe(45);
    expect(cfg.memory.requireEvidence).toBe(true);
    expect(cfg.personality.voice.directness).toBe('high');
  });

  it('defaults and overrides the documentation directory', () => {
    expect(loadConfig({ env: baseEnv(), yamlText: '' }).docsDir).toBe('./docs');
    expect(loadConfig({ env: { ...baseEnv(), DOCS_DIR: '/srv/mneme/docs' }, yamlText: '' }).docsDir).toBe(
      '/srv/mneme/docs',
    );
  });

  it('parses and validates the scheduled-review reminder interval', () => {
    const cfg = loadConfig({
      env: { ...baseEnv(), MEMORY_SCHEDULED_REVIEW_REMINDER_DAYS: '14' },
    });
    expect(cfg.memory.scheduledReviewReminderDays).toBe(14);
    expectFail(
      { ...baseEnv(), MEMORY_SCHEDULED_REVIEW_REMINDER_DAYS: '0' },
      'MEMORY_SCHEDULED_REVIEW_REMINDER_DAYS',
    );
  });

  it('parses and validates the proactive attention window (Section 12.7)', () => {
    // Default is 7 days when neither env nor YAML sets a value.
    expect(loadConfig({ env: baseEnv() }).intervention.attentionWindowDays).toBe(7);
    const cfg = loadConfig({
      env: { ...baseEnv(), INTERVENTION_ATTENTION_WINDOW_DAYS: '14' },
    });
    expect(cfg.intervention.attentionWindowDays).toBe(14);
    // The window is a positive integer; zero and negative values fail.
    expectFail(
      { ...baseEnv(), INTERVENTION_ATTENTION_WINDOW_DAYS: '0' },
      'INTERVENTION_ATTENTION_WINDOW_DAYS',
    );
    expectFail(
      { ...baseEnv(), INTERVENTION_ATTENTION_WINDOW_DAYS: '-7' },
      'INTERVENTION_ATTENTION_WINDOW_DAYS',
    );
    expectFail(
      { ...baseEnv(), INTERVENTION_ATTENTION_WINDOW_DAYS: '2.5' },
      'INTERVENTION_ATTENTION_WINDOW_DAYS',
    );
    // The legacy reminder knob cannot disable the attention window and the
    // window cannot be reinterpreted from the legacy knob.
    expect(loadConfig({
      env: { ...baseEnv(), MEMORY_SCHEDULED_REVIEW_REMINDER_DAYS: '1' },
    }).intervention.attentionWindowDays).toBe(7);
  });

  it('parses and validates the staleness horizon', () => {
    const cfg = loadConfig({
      env: { ...baseEnv(), MEMORY_STALENESS_HORIZON_DAYS: '30' },
    });
    expect(cfg.memory.stalenessHorizonDays).toBe(30);
    // Zero disables the horizon and is valid; a negative value is not.
    expect(loadConfig({
      env: { ...baseEnv(), MEMORY_STALENESS_HORIZON_DAYS: '0' },
    }).memory.stalenessHorizonDays).toBe(0);
    expectFail(
      { ...baseEnv(), MEMORY_STALENESS_HORIZON_DAYS: '-1' },
      'MEMORY_STALENESS_HORIZON_DAYS',
    );
  });

  it('validates and normalizes the optional public documentation URL', () => {
    expect(loadConfig({ env: baseEnv() }).docsPublicUrl).toBeUndefined();
    expect(loadConfig({
      env: { ...baseEnv(), DOCS_PUBLIC_URL: 'https://docs.example.com/mneme' },
    }).docsPublicUrl).toBe('https://docs.example.com/mneme/');

    expectFail({ ...baseEnv(), DOCS_PUBLIC_URL: 'http://docs.example.com' }, 'DOCS_PUBLIC_URL');
    expectFail({ ...baseEnv(), DOCS_PUBLIC_URL: 'https://user@docs.example.com' }, 'DOCS_PUBLIC_URL');
    expectFail({ ...baseEnv(), DOCS_PUBLIC_URL: 'https://docs.example.com/?draft=1' }, 'DOCS_PUBLIC_URL');
  });

  it('fails on an unsafe (traversal) documentation directory', () => {
    expectFail({ ...baseEnv(), DOCS_DIR: '/app/../etc' }, 'DOCS_DIR');
  });

  it('defaults and overrides the MCP unauthenticated failure budget', () => {
    const cfg = loadConfig({ env: baseEnv() });
    expect(cfg.mcp.unauthRateLimitPerMinute).toBe(30);
    const overridden = loadConfig({
      env: { ...baseEnv(), MCP_UNAUTH_RATE_LIMIT_PER_MINUTE: '10' },
    });
    expect(overridden.mcp.unauthRateLimitPerMinute).toBe(10);
    expectFail(
      { ...baseEnv(), MCP_UNAUTH_RATE_LIMIT_PER_MINUTE: '0' },
      'MCP_UNAUTH_RATE_LIMIT_PER_MINUTE',
    );
  });

  it('resolves the MCP endpoint URL from the explicit, Railway, and local sources', () => {
    const local = loadConfig({ env: { ...baseEnv(), PORT: '3100' } });
    expect(local.mcp.publicBaseUrl).toBe('http://localhost:3100');
    expect(mcpEndpointUrl(local.mcp)).toBe('http://localhost:3100/mcp');

    const railway = loadConfig({
      env: { ...baseEnv(), RAILWAY_PUBLIC_DOMAIN: 'mneme.example.up.railway.app' },
    });
    expect(mcpEndpointUrl(railway.mcp)).toBe('https://mneme.example.up.railway.app/mcp');

    const explicit = loadConfig({
      env: {
        ...baseEnv(),
        RAILWAY_PUBLIC_DOMAIN: 'ignored.up.railway.app',
        MCP_PUBLIC_URL: 'https://memory.example.com/',
        MCP_PATH: '/agent-mcp',
      },
    });
    expect(mcpEndpointUrl(explicit.mcp)).toBe('https://memory.example.com/agent-mcp');
  });

  it('fails on an MCP_PUBLIC_URL that is not an absolute http(s) URL', () => {
    expectFail({ ...baseEnv(), MCP_PUBLIC_URL: 'memory.example.com' }, 'MCP_PUBLIC_URL');
    expectFail({ ...baseEnv(), MCP_PUBLIC_URL: 'ftp://memory.example.com' }, 'MCP_PUBLIC_URL');
  });

  it('fails when the selected provider credential is missing', () => {
    const env = baseEnv();
    delete env.OPENAI_API_KEY;
    expectFail(env, 'OPENAI_API_KEY');
  });

  it('fails when MNEME_PLATFORM is missing', () => {
    const env = baseEnv();
    delete env.MNEME_PLATFORM;
    expectFail(env, 'MNEME_PLATFORM');
  });

  it('fails when MNEME_PLATFORM names an unsupported platform', () => {
    expectFail({ ...baseEnv(), MNEME_PLATFORM: 'teams' }, 'MNEME_PLATFORM');
  });

  it('selects the Discord platform when MNEME_PLATFORM=discord', () => {
    expect(loadConfig({ env: baseEnv() }).platform).toBe('discord');
  });

  it('fails when DISCORD_TOKEN is missing', () => {
    const env = baseEnv();
    delete env.DISCORD_TOKEN;
    expectFail(env, 'DISCORD_TOKEN');
  });

  it('fails on a malformed Discord id', () => {
    expectFail({ ...baseEnv(), DISCORD_GUILD_ID: 'not-a-snowflake' }, 'DISCORD_GUILD_ID');
  });

  it('fails on an invalid autonomy mode', () => {
    expectFail({ ...baseEnv(), MNEME_MODE: 'YOLO' }, 'MNEME_MODE');
  });

  it('fails on an invalid LLM provider', () => {
    expectFail({ ...baseEnv(), LLM_PROVIDER: 'bedrock' }, 'LLM_PROVIDER');
  });

  it('fails on an invalid attachment mode enum', () => {
    expectFail({ ...baseEnv(), ATTACHMENT_MODE: 'everything' }, 'ATTACHMENT_MODE');
  });

  it('parses controlled historical-memory settings', () => {
    const cfg = loadConfig({ env: {
      ...baseEnv(),
      HISTORICAL_MEMORY_ENABLED: 'true',
      HISTORICAL_MEMORY_CHANNEL_IDS: '12345678901234567,23456789012345678',
      HISTORICAL_MEMORY_BATCH_MESSAGES: '80',
      HISTORICAL_MEMORY_MAX_PENDING_REVIEWS: '2',
      HISTORICAL_MEMORY_DAILY_BUDGET_USD: '0.75',
    } });
    expect(cfg.historicalMemory).toEqual({
      enabled: true,
      channelIds: ['12345678901234567', '23456789012345678'],
      batchMessages: 80,
      maxPendingReviews: 2,
      dailyBudgetUsd: 0.75,
      campaignId: undefined,
      direction: 'newest_first',
      fromAtMs: undefined,
      toAtMs: undefined,
      model: undefined,
      thinkingLevel: 'medium',
      totalBudgetUsd: 0,
    });
  });

  it('parses a fixed bounded historical campaign', () => {
    const cfg = loadConfig({ env: {
      ...baseEnv(),
      HISTORICAL_MEMORY_ENABLED: 'true',
      HISTORICAL_MEMORY_CHANNEL_IDS: '12345678901234567',
      HISTORICAL_MEMORY_CAMPAIGN_ID: 'recent-six-months',
      HISTORICAL_MEMORY_DIRECTION: 'newest_first',
      HISTORICAL_MEMORY_FROM_AT: '2026-02-13T00:00:00+01:00',
      HISTORICAL_MEMORY_TO_AT: '2026-08-13T20:00:00+02:00',
      HISTORICAL_MEMORY_LLM_MODEL: 'gpt-5.6-luna',
      HISTORICAL_MEMORY_THINKING_LEVEL: 'medium',
      HISTORICAL_MEMORY_TOTAL_BUDGET_USD: '2',
      HISTORICAL_MEMORY_DAILY_BUDGET_USD: '10',
    } });
    expect(cfg.historicalMemory).toMatchObject({ campaignId: 'recent-six-months',
      direction: 'newest_first', model: 'gpt-5.6-luna', thinkingLevel: 'medium',
      totalBudgetUsd: 2, dailyBudgetUsd: 10 });
    expect(cfg.historicalMemory.fromAtMs).toBe(Date.parse('2026-02-13T00:00:00+01:00'));
  });

  it('fails closed when a bounded campaign lacks a fixed window or model', () => {
    expectFail({ ...baseEnv(), HISTORICAL_MEMORY_CAMPAIGN_ID: 'trial',
      HISTORICAL_MEMORY_CHANNEL_IDS: '12345678901234567', HISTORICAL_MEMORY_TOTAL_BUDGET_USD: '2' },
    'HISTORICAL_MEMORY_FROM_AT');
  });

  it('rejects a negative historical-memory budget', () => {
    expectFail({ ...baseEnv(), HISTORICAL_MEMORY_DAILY_BUDGET_USD: '-1' }, 'HISTORICAL_MEMORY_DAILY_BUDGET_USD');
  });

  it('fails on an out-of-range fraction', () => {
    expectFail({ ...baseEnv(), INTERVENTION_THRESHOLD: '1.5' }, 'INTERVENTION_THRESHOLD');
  });

  it('fails on an unsafe (traversal) path', () => {
    expectFail({ ...baseEnv(), DATA_DIR: '/app/../etc' }, 'DATA_DIR');
  });

  it('fails on an invalid timezone', () => {
    expectFail({ ...baseEnv(), ORG_TIMEZONE: 'Not A Real Zone' }, 'ORG_TIMEZONE');
  });

  it('fails when review mode lacks a secure review channel', () => {
    expectFail({ ...baseEnv(), MNEME_MODE: 'review' }, 'MNEME_REVIEW_CHANNEL_ID');
  });

  it('fails when env and channel-policy review channel ids disagree', () => {
    const env = {
      ...baseEnv(),
      MNEME_MODE: 'review',
      MNEME_REVIEW_CHANNEL_ID: '345678901234567890',
    };
    try {
      loadConfig({
        env,
        channelPolicyReview: { id: '456789012345678901', secure: true },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).setting).toBe('MNEME_REVIEW_CHANNEL_ID');
    }
  });

  it('accepts review mode with a secure review channel', () => {
    const env = {
      ...baseEnv(),
      MNEME_MODE: 'review',
      MNEME_REVIEW_CHANNEL_ID: '345678901234567890',
    };
    const cfg = loadConfig({ env, channelPolicyReview: { id: '345678901234567890', secure: true } });
    expect(cfg.mode).toBe('review');
    expect(cfg.reviewChannelId).toBe('345678901234567890');
  });

  it('defaults MCP OAuth to off with the hosted Claude callback registered', () => {
    const cfg = loadConfig({ env: baseEnv() });
    expect(cfg.mcp.oauthEnabled).toBe(false);
    expect(cfg.mcp.oauthClientId).toBe('');
    expect(cfg.mcp.oauthRedirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('refuses to enable MCP OAuth while any prerequisite is missing', () => {
    // Fail closed: each of these would advertise a sign-in flow that cannot
    // complete — no client to recognize, no identity provider to ask, or no
    // admin role for the membership check to match.
    const oauthEnv = {
      ...baseEnv(),
      MCP_ENABLED: 'true',
      MCP_OAUTH_ENABLED: 'true',
      MCP_OAUTH_CLIENT_ID: 'b7f3c1a9d24e40f8',
      DISCORD_OAUTH_CLIENT_ID: '987654321098765432',
      DISCORD_OAUTH_CLIENT_SECRET: 'discord-oauth-secret-value',
      MNEME_ADMIN_ROLE_IDS: '456789012345678901',
    };
    expectFail({ ...oauthEnv, MCP_OAUTH_CLIENT_ID: undefined }, 'MCP_OAUTH_CLIENT_ID');
    expectFail({ ...oauthEnv, DISCORD_OAUTH_CLIENT_ID: undefined }, 'DISCORD_OAUTH_CLIENT_ID');
    expectFail({ ...oauthEnv, DISCORD_OAUTH_CLIENT_SECRET: undefined }, 'DISCORD_OAUTH_CLIENT_SECRET');
    expectFail({ ...oauthEnv, MNEME_ADMIN_ROLE_IDS: undefined }, 'MNEME_ADMIN_ROLE_IDS');

    const cfg = loadConfig({ env: oauthEnv });
    expect(cfg.mcp.oauthEnabled).toBe(true);
    expect(cfg.mcp.oauthClientId).toBe('b7f3c1a9d24e40f8');
    expect(cfg.mcp.oauthDiscordClientId).toBe('987654321098765432');
  });

  it('rejects a redirect URI that cannot safely carry an authorization code', () => {
    // Caught at boot, not mid-sign-in.
    expectFail({ ...baseEnv(), MCP_OAUTH_REDIRECT_URIS: 'http://example.test/cb' }, 'MCP_OAUTH_REDIRECT_URIS');
    expectFail({ ...baseEnv(), MCP_OAUTH_REDIRECT_URIS: '/relative' }, 'MCP_OAUTH_REDIRECT_URIS');

    const cfg = loadConfig({
      env: {
        ...baseEnv(),
        MCP_OAUTH_REDIRECT_URIS:
          'https://claude.ai/api/mcp/auth_callback, http://127.0.0.1:8080/callback',
      },
    });
    expect(cfg.mcp.oauthRedirectUris).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'http://127.0.0.1:8080/callback',
    ]);
  });

  it('never echoes secret values in error messages', () => {
    try {
      loadConfig({ ...baseEnv(), DISCORD_GUILD_ID: 'bad' });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('a-real-discord-token-value');
      expect(msg).not.toContain('sk-test-key-value');
    }
  });

  describe('native .env file loading', () => {
    /**
     * Run fn with a temp directory that holds the given .env content. The
     * loader layers that file under the environment source, so tests pass an
     * explicit env plus the fixture directory.
     */
    function withEnvFile(lines: string[], fn: (dir: string) => void): void {
      const dir = mkdtempSync(join(tmpdir(), 'mneme-dotenv-'));
      writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`, 'utf8');
      try {
        fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('fills only keys the environment does not already define', () => {
      withEnvFile([
        '# a comment line',
        '',
        'ORG_NAME=From The Dotenv File',
        'ORG_TIMEZONE=Europe/Berlin',
        'HTTP_ADMIN_TOKEN=trimmed-secret   ',
        'FULL_HISTORY=false',
      ], (dir) => {
        const env = { ...baseEnv(), FULL_HISTORY: 'true' };
        delete env.ORG_NAME;
        delete env.ORG_TIMEZONE;
        delete env.HTTP_ADMIN_TOKEN;
        const cfg = loadConfig({ env, yamlText: '', envFileDir: dir });
        // Keys absent from the environment come from .env; values are trimmed.
        expect(cfg.organization.name).toBe('From The Dotenv File');
        expect(cfg.organization.timezone).toBe('Europe/Berlin');
        expect(cfg.httpAdminToken).toBe('trimmed-secret');
        // A key already set in the environment is never overwritten.
        expect(cfg.ingestion.fullHistory).toBe(true);
      });
    });

    it('skips blank and comment lines instead of parsing them', () => {
      withEnvFile(['# ORG_NAME=Commented Out', '', '   '], (dir) => {
        const env = baseEnv();
        delete env.ORG_NAME;
        const cfg = loadConfig({ env, yamlText: '', envFileDir: dir });
        // The commented assignment never runs; the default applies.
        expect(cfg.organization.name).toBe('Your Company');
      });
    });

    it('reads no .env file when the environment is injected without envFileDir', () => {
      withEnvFile(['ORG_NAME=From The Dotenv File'], (dir) => {
        const before = process.cwd();
        process.chdir(dir);
        try {
          const env = baseEnv();
          delete env.ORG_NAME;
          // An injected env is an explicit contract: the cwd file is not layered in.
          expect(loadConfig({ env, yamlText: '' }).organization.name).toBe('Your Company');
          expect(loadOperationalConfig({ env: { DATA_DIR: '/srv/x' } }).dataDir).toBe('/srv/x');
        } finally {
          process.chdir(before);
        }
      });
    });

    it('layers .env under the operational CLI paths with the same precedence', () => {
      withEnvFile(['DATA_DIR=/srv/from-file', 'DATABASE_PATH=/srv/from-file/db.sqlite'], (dir) => {
        const cfg = loadOperationalConfig({ env: { DATABASE_PATH: '/srv/real/db.sqlite' }, envFileDir: dir });
        expect(cfg.dataDir).toBe('/srv/from-file');
        expect(cfg.backupDir).toBe('/srv/from-file/backups');
        // The environment source wins over the file.
        expect(cfg.databasePath).toBe('/srv/real/db.sqlite');
      });
    });

    it('fills process.env from the working-directory .env when no env is injected', () => {
      const keys = ['DATA_DIR', 'DATABASE_PATH', 'BACKUP_DIR'] as const;
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      for (const k of keys) delete process.env[k];
      process.env.BACKUP_DIR = '/srv/real/backups';
      withEnvFile(['DATA_DIR=/srv/from-file', 'BACKUP_DIR=/srv/from-file/backups'], (dir) => {
        const before = process.cwd();
        process.chdir(dir);
        try {
          const cfg = loadOperationalConfig();
          expect(cfg.dataDir).toBe('/srv/from-file');
          expect(cfg.backupDir).toBe('/srv/real/backups');
          expect(process.env.DATA_DIR).toBe('/srv/from-file');
        } finally {
          process.chdir(before);
          for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
          }
        }
      });
    });
  });

  describe('parseDotEnv', () => {
    const parse = (text: string) => Object.fromEntries(parseDotEnv(text));

    it('drops a UTF-8 byte order mark and handles CRLF line ends', () => {
      expect(parse('\uFEFFA=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
    });

    it('accepts an export prefix before the key', () => {
      expect(parse('export A=1\nexport  B=2\nexported=3')).toEqual({ A: '1', B: '2', exported: '3' });
    });

    it('removes matching surrounding quotes without escape processing', () => {
      expect(parse(`A="quoted value"\nB='single # not a comment'\nC="a\\nb"`)).toEqual({
        A: 'quoted value',
        B: 'single # not a comment',
        C: 'a\\nb',
      });
      // Unmatched or mixed quotes stay literal.
      expect(parse(`A="open\nB='mixed"\nC="`)).toEqual({ A: '"open', B: `'mixed"`, C: '"' });
    });

    it('removes an inline comment from an unquoted value only', () => {
      expect(parse('MODE=metadata  # none | metadata\nURL=https://x.example/#frag\nT=a\t# tab')).toEqual({
        MODE: 'metadata',
        URL: 'https://x.example/#frag',
        T: 'a',
      });
    });

    it('parses both shipped example files to values free of quotes and comments', () => {
      for (const file of ENV_EXAMPLES) {
        const pairs = parseDotEnv(readFileSync(file, 'utf8'));
        expect(pairs.length).toBeGreaterThan(10);
        for (const [key, value] of pairs) {
          expect(value, `${file}: ${key}`).not.toMatch(/#|^["']|["']$/);
        }
        expect(Object.fromEntries(pairs).LLM_DAILY_BUDGET_USD).toBe('2');
      }
      expect(Object.fromEntries(parseDotEnv(readFileSync(ENV_EXAMPLES[1]!, 'utf8'))).ATTACHMENT_MODE).toBe('metadata');
    });
  });
});
