import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  configuredRunLimits,
  deadlineBoundWallClockMs,
} from '../../src/agent/run-limits.js';

function productionEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    MNEME_PLATFORM: 'discord',
    DISCORD_TOKEN: 'test-discord-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_GUILD_ID: '234567890123456789',
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'gpt-5.6-terra',
    FULL_HISTORY: 'true',
    OPENAI_API_KEY: 'sk-test-key',
    ORG_NAME: 'Test Org',
    ORG_TIMEZONE: 'UTC',
    AGENT_TIMEOUT_SECONDS: '47',
    AGENT_MAX_TOOL_CALLS: '5',
    AGENT_MAX_RETRIEVED_CHARACTERS: '12345',
  };
}

describe('production agent limit wiring', () => {
  it('maps validated environment values to the exact RunLimits property names', () => {
    const config = loadConfig({ env: productionEnv() });
    const limits = configuredRunLimits(config.agentRuntime);

    expect(limits).toEqual({
      wallClockMs: 47_000,
      maxToolCalls: 5,
      charBudget: 12_345,
    });
    expect(limits).not.toHaveProperty('timeoutMs');
    expect(limits).not.toHaveProperty('maxRetrievedCharacters');
  });

  it('re-clamps model execution after provider-slot waiting', () => {
    const now = 1_700_000_000_000;
    expect(deadlineBoundWallClockMs(120_000, now + 35_000, now)).toBe(35_000);
    expect(deadlineBoundWallClockMs(20_000, now + 35_000, now)).toBe(20_000);
    expect(deadlineBoundWallClockMs(120_000, now, now)).toBe(0);
    expect(deadlineBoundWallClockMs(120_000, Number.NaN, now)).toBe(0);
  });
});
