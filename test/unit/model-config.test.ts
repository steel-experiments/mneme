import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  builtinModels,
} from '@earendil-works/pi-ai/providers/all';
import {
  readModelConfig,
  resolveCredential,
  supportsToolCalling,
  hasBillablePricing,
  resolveAgentModels,
  defaultModelLookup,
  configureAgentModels,
  ModelConfigError,
  TOOL_CAPABLE_APIS,
  type ModelLookup,
  type AgentModelConfig,
} from '../../src/agent/model.js';
import type { Api, Model } from '@earendil-works/pi-ai';

const MODEL_TS_PATH = fileURLToPath(new URL('../../src/agent/model.ts', import.meta.url));

/** A minimal model used only to exercise the tool-calling gate. */
function fakeModel(api: Api): Model<Api> {
  return {
    id: 'fake',
    name: 'fake',
    api,
    provider: 'openai',
    baseUrl: 'https://example.test/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  };
}

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'gpt-5.6-terra',
    OPENAI_API_KEY: 'sk-test',
    AGENT_THINKING_LEVEL: 'medium',
    ...overrides,
  };
}

const realLookup: ModelLookup = defaultModelLookup(builtinModels());

describe('agent model configuration', () => {
  it('resolves the configured provider and model dynamically from the catalog', () => {
    const resolved = configureAgentModels({ env: baseEnv() });
    expect(resolved.providerId).toBe('openai');
    expect(resolved.primary.model.id).toBe('gpt-5.6-terra');
    expect(resolved.primary.model.api).toBe('openai-responses');
    expect(resolved.primary.thinkingLevel).toBe('medium');
    expect(resolved.dailyBudgetUsd).toBe(2);
    expect(resolved.triage).toBeNull();
  });

  it('resolves the campaign Luna model through the production catalog', () => {
    const resolved = resolveAgentModels({
      providerId: 'openai', primaryModelId: 'gpt-5.6-luna', triageModelId: null,
      baseUrl: null, dailyBudgetUsd: 10, thinkingLevel: 'medium',
    }, realLookup);
    expect(resolved.primary.model.id).toBe('gpt-5.6-luna');
    expect(resolved.primary.model.api).toBe('openai-responses');
  });

  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'])(
    'resolves %s through the production catalog with billable pricing',
    (id) => {
      const resolved = resolveAgentModels({
        providerId: 'openai', primaryModelId: id, triageModelId: null,
        baseUrl: null, dailyBudgetUsd: 10, thinkingLevel: 'medium',
      }, realLookup);
      expect(resolved.primary.model.id).toBe(id);
      expect(resolved.primary.model.api).toBe('openai-responses');
      expect(hasBillablePricing(resolved.primary.model)).toBe(true);
    },
  );

  it('prices gpt-5.6-sol at the published short-context rates', () => {
    const { cost } = realLookup('openai', 'gpt-5.6-sol')!;
    expect(cost).toMatchObject({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
  });

  it('uses medium reasoning by default when AGENT_THINKING_LEVEL is unset', () => {
    const env = baseEnv();
    delete env.AGENT_THINKING_LEVEL;
    expect(readModelConfig(env).thinkingLevel).toBe('medium');
  });

  it('does not hard-code a model id in source — selection is configuration-driven', () => {
    const src = readFileSync(MODEL_TS_PATH, 'utf8');
    // None of these real catalog ids may appear as literals in the resolver.
    for (const id of ['gpt-5.6-terra', 'gpt-5.6-sol', 'claude-sonnet-5', 'claude-opus-5']) {
      expect(src).not.toContain(id);
    }
  });

  it('parses budget, base URL, and triage model when provided', () => {
    const cfg = readModelConfig(
      baseEnv({ LLM_DAILY_BUDGET_USD: '5', LLM_BASE_URL: 'https://gw.example/v1', TRIAGE_LLM_MODEL: 'gpt-5.6-sol' }),
    );
    expect(cfg.dailyBudgetUsd).toBe(5);
    expect(cfg.baseUrl).toBe('https://gw.example/v1');
    expect(cfg.triageModelId).toBe('gpt-5.6-sol');
  });

  it('reads the daily budget with the shared parser: blank is the default, unlimited is null', () => {
    expect(readModelConfig(baseEnv({ LLM_DAILY_BUDGET_USD: '' })).dailyBudgetUsd).toBe(2);
    expect(readModelConfig(baseEnv({ LLM_DAILY_BUDGET_USD: 'unlimited' })).dailyBudgetUsd).toBeNull();
    expect(readModelConfig(baseEnv({ LLM_DAILY_BUDGET_USD: '0' })).dailyBudgetUsd).toBe(0);
  });

  it('fails clearly when LLM_PROVIDER or LLM_MODEL is missing', () => {
    const noProvider = baseEnv();
    delete noProvider.LLM_PROVIDER;
    expect(() => readModelConfig(noProvider)).toThrow(ModelConfigError);
    const noModel = baseEnv();
    delete noModel.LLM_MODEL;
    expect(() => readModelConfig(noModel)).toThrow(ModelConfigError);
  });

  it('rejects an unknown thinking level and a non-numeric budget', () => {
    expect(() => readModelConfig(baseEnv({ AGENT_THINKING_LEVEL: 'turbo' }))).toThrow(ModelConfigError);
    expect(() => readModelConfig(baseEnv({ LLM_DAILY_BUDGET_USD: 'free' }))).toThrow(ModelConfigError);
    expect(() => readModelConfig(baseEnv({ LLM_DAILY_BUDGET_USD: '-1' }))).toThrow(ModelConfigError);
  });

  it('requires the selected provider credential and names the missing variable', () => {
    const missing = baseEnv();
    delete missing.OPENAI_API_KEY;
    expect(() => resolveCredential(missing, 'openai')).toThrow(/OPENAI_API_KEY/);
    // Present credential resolves cleanly.
    expect(resolveCredential(baseEnv(), 'openai').value).toBe('sk-test');
  });

  it('does not enforce credentials for unknown (custom) providers', () => {
    const r = resolveCredential({}, 'acme-internal');
    expect(r.required).toBe(false);
    expect(r.envVar).toBe('LLM_API_KEY');
  });

  it('fails clearly when the model is absent from the catalog', () => {
    const cfg = readModelConfig(baseEnv({ LLM_MODEL: 'no-such-model' }));
    expect(() => resolveAgentModels(cfg, realLookup)).toThrow(/not found/);
  });

  it('fails clearly when the model api lacks tool calling', () => {
    const cfg: AgentModelConfig = {
      providerId: 'openai',
      primaryModelId: 'fake',
      triageModelId: null,
      baseUrl: null,
      dailyBudgetUsd: null,
      thinkingLevel: 'medium',
    };
    const lookup: ModelLookup = () => fakeModel('images-v1' as Api);
    expect(() => resolveAgentModels(cfg, lookup)).toThrow(/tool calling/);
  });

  it('fails clearly when the triage model lacks tool calling', () => {
    const cfg = readModelConfig(baseEnv({ TRIAGE_LLM_MODEL: 'fake' }));
    let calls = 0;
    const lookup: ModelLookup = (_p) => {
      // First call resolves the primary via the real catalog; the triage call
      // returns a tool-less model.
      calls += 1;
      return calls === 1 ? realLookup('openai', 'gpt-5.6-terra') : fakeModel('images-v1' as Api);
    };
    expect(() => resolveAgentModels(cfg, lookup)).toThrow(/tool calling/);
  });

  it('treats every advertised tool-capable API as supported and others as not', () => {
    for (const api of TOOL_CAPABLE_APIS) {
      expect(supportsToolCalling(fakeModel(api))).toBe(true);
    }
    expect(supportsToolCalling(fakeModel('images-v1' as Api))).toBe(false);
  });

  it('distinguishes catalog pricing from a genuinely zero-priced fixture', () => {
    expect(hasBillablePricing(fakeModel('openai-responses'))).toBe(false);
    const priced = { ...fakeModel('openai-responses'), cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } };
    expect(hasBillablePricing(priced)).toBe(true);
  });

  it('applies a configured base URL override without mutating the catalog model', () => {
    const cfg = readModelConfig(baseEnv({ LLM_BASE_URL: 'https://gw.example/v1' }));
    const resolved = resolveAgentModels(cfg, realLookup);
    expect(resolved.primary.effectiveBaseUrl).toBe('https://gw.example/v1');
    // A second resolution without the override still sees the original URL.
    const plain = resolveAgentModels(readModelConfig(baseEnv()), realLookup);
    expect(plain.primary.effectiveBaseUrl).toBe('https://api.openai.com/v1');
  });
});
