import { describe, it, expect } from 'vitest';
import {
  h, fmtMs, fmtPct, fmtNum, excerpt, speechExcerpt, badge, statusBadge,
} from '../../src/http/inspector/html.js';
import {
  parseToolCalls, parseProvenance, buildLedger, renderLedgerSvg, DEFAULT_RUN_CHAR_BUDGET,
} from '../../src/http/inspector/ledger.js';
import { parseRoute, presentedToken, INSPECTOR_WWW_AUTHENTICATE } from '../../src/http/inspector/router.js';
import { escapeLike } from '../../src/http/inspector/queries.js';
import { parseModelTurns } from '../../src/http/inspector/trace.js';
import { loadConfig, inspectorUrl, reservedHttpPaths, ConfigError } from '../../src/config.js';

/** A minimal valid environment (mirrors config.test.ts). */
function baseEnv(): Record<string, string | undefined> {
  return {
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

describe('inspector html helpers — Section 32.6', () => {
  it('parses model-turn v1 and v2 without fabricating legacy usage detail', () => {
    const legacy = parseModelTurns(JSON.stringify([{
      version: 1, turnIndex: 1, startedAtMs: 1, modelEndedAtMs: 2, endedAtMs: 3,
      modelDurationMs: 1, durationMs: 2, inputTokens: 8, outputTokens: 3,
      costUsd: 0.01, stopReason: 'toolUse', incomplete: false,
    }]));
    expect(legacy[0]).toMatchObject({ version: 1, inputTokens: 8, uncachedInputTokens: null });

    const detailed = parseModelTurns(JSON.stringify([{
      version: 2, turnIndex: 1, startedAtMs: 1, modelEndedAtMs: 2, endedAtMs: 3,
      modelDurationMs: 1, durationMs: 2, inputTokens: 8, outputTokens: 3,
      costUsd: 0.01, uncachedInputTokens: 5, cacheReadTokens: 2,
      cacheWriteTokens: 1, cacheWrite1hTokens: null, reasoningTokens: 2,
      providerTotalTokens: 11, uncachedInputCostUsd: 0.003, outputCostUsd: 0.004,
      cacheReadCostUsd: 0.001, cacheWriteCostUsd: 0.002,
      stopReason: 'toolUse', incomplete: false,
    }]));
    expect(detailed[0]).toMatchObject({ version: 2, cacheReadTokens: 2, reasoningTokens: 2 });
    expect(parseModelTurns(JSON.stringify([{ ...detailed[0], cacheReadTokens: undefined }]))).toEqual([]);
  });

  it('escapes every HTML-significant character', () => {
    expect(h(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(h(null)).toBe('');
    expect(h(undefined)).toBe('');
    expect(h(42)).toBe('42');
  });

  it('formats timestamps, percentages, numbers, and excerpts', () => {
    expect(fmtMs(null)).toBe('never');
    expect(fmtMs(0)).toBe('1970-01-01 00:00:00Z');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(0.876, 1)).toBe('87.6%');
    expect(fmtNum(null)).toBe('—');
    expect(fmtNum(1234)).toBe('1,234');
    expect(excerpt('abcdefghij', 5)).toBe('abcd…');
    expect(excerpt('abc', 5)).toBe('abc');
  });

  it('renders canonical Discord Markdown links by label in speech excerpts', () => {
    const url = 'https://discord.com/channels/100000000000000001/100000000000000002/100000000000000003';
    expect(speechExcerpt(`Decision context: [source](${url})`, 200)).toBe(
      `Decision context: <a href="${url}">source</a>`,
    );
    expect(speechExcerpt(`See [<source>](${url})`, 200)).toBe(
      `See <a href="${url}">&lt;source&gt;</a>`,
    );
    expect(speechExcerpt('[source](https://example.com/a)', 200)).toBe(
      '[source](https://example.com/a)',
    );
  });

  it('limits speech excerpts by visible link-label length', () => {
    const url = 'https://discord.com/channels/100000000000000001/100000000000000002/100000000000000003';
    expect(speechExcerpt(`A [source](${url}) after`, 10)).toBe(
      `A <a href="${url}">source</a> …`,
    );
  });

  it('renders badges with fixed tones only', () => {
    expect(badge('org', 'scope')).toBe('<span class="badge badge-scope">org</span>');
    // A hostile label is escaped even though callers pass enums today.
    expect(badge('<script>')).toBe('<span class="badge badge-neutral">&lt;script&gt;</span>');
    expect(statusBadge('completed')).toContain('badge-good');
    expect(statusBadge('failed')).toContain('badge-bad');
    expect(statusBadge('superseded')).toContain('badge-warn');
  });
});

describe('context ledger parsing and rendering — Section 32.6', () => {
  it('parses tool-call audit entries defensively', () => {
    const calls = parseToolCalls(JSON.stringify([
      { toolName: 'message_search', accepted: true, isError: false, argsChars: 10, resultChars: 20 },
      { toolName: 'bogus', accepted: false, isError: true, argsChars: 'x', resultChars: -3 },
    ]));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.argsChars).toBe(0);
    expect(calls[1]?.resultChars).toBe(0);

    expect(parseToolCalls('not json')).toEqual([]);
    expect(parseToolCalls(null)).toEqual([]);
    expect(parseToolCalls('{"object":true}')).toEqual([]);
  });

  it('parses provenance objects and legacy arrays', () => {
    const single = parseProvenance(JSON.stringify({
      channels: ['c1'], messageIds: ['m1', 'm2'], memoryIds: [],
      charsExposed: 12_345, charBudget: 60_000, recentActivitySnapshot: { requestedChannelIds: [] },
    }));
    expect(single).toEqual({
      charsExposed: 12_345, charBudget: 60_000,
      channelCount: 1, messageCount: 2, memoryCount: 0, hasSnapshot: true,
    });

    expect(parseProvenance('[]')).toMatchObject({ charsExposed: null, charBudget: null });
    expect(parseProvenance('bad')).toMatchObject({ charsExposed: null });
  });

  it('uses provenance as the authoritative total and splits new traces by reservation', () => {
    const ledger = buildLedger(
      parseToolCalls(JSON.stringify([
        { traceVersion: 1, toolName: 'search_messages', toolCallId: 'a', sequence: 1, accepted: true, isError: false, argsChars: 100, resultChars: 30_000, reservedChars: 12_000 },
        { traceVersion: 1, toolName: 'search_messages', toolCallId: 'b', sequence: 2, accepted: true, isError: false, argsChars: 100, resultChars: 8_000, reservedChars: 8_000 },
      ])),
      { charsExposed: 20_000, charBudget: 100_000, channelCount: 1, messageCount: 5, memoryCount: 0, hasSnapshot: true },
    );
    const labels = ledger.segments.map((s) => s.label);
    expect(labels).toContain('search_messages #1');
    expect(labels).toContain('search_messages #2');
    expect(ledger.free).toBe(80_000);

    const overflow = buildLedger([], { charsExposed: 70_000, charBudget: 60_000, channelCount: 0, messageCount: 0, memoryCount: 0, hasSnapshot: false });
    expect(overflow.overflow).toBe(true);
    expect(overflow.free).toBe(0);

    const noProvenance = buildLedger([], { charsExposed: null, charBudget: null, channelCount: 0, messageCount: 0, memoryCount: 0, hasSnapshot: false });
    expect(noProvenance.budget).toBe(DEFAULT_RUN_CHAR_BUDGET);
    expect(noProvenance.segments).toEqual([]);
  });

  it('renders the SVG with escaped labels and a budget scale', () => {
    const ledger = buildLedger(
      parseToolCalls(JSON.stringify([{ traceVersion: 1, toolName: 'finalize_<w>', toolCallId: '<bad>', accepted: true, isError: false, argsChars: 100, resultChars: 100, reservedChars: 100 }])),
      { charsExposed: 10_000, charBudget: 60_000, channelCount: 0, messageCount: 0, memoryCount: 0, hasSnapshot: false },
    );
    const svg = renderLedgerSvg(ledger);
    expect(svg).toContain('<svg class="ledger"');
    expect(svg).toContain('60,000 char budget');
    expect(svg).toContain('finalize_&lt;w&gt;');
    expect(svg).not.toContain('finalize_<w>');
  });
});

describe('inspector route parsing — Section 32.6', () => {
  const base = '/inspector';

  it('parses every documented page and its query parameters', () => {
    expect(parseRoute('/inspector', base, '')).toEqual({ name: 'overview' });
    expect(parseRoute('/inspector/', base, '')).toEqual({ name: 'overview' });
    expect(parseRoute('/inspector/memories', base, '?q=ship&type=decision')).toEqual({
      name: 'memories', q: 'ship', type: 'decision', status: null, sort: 'importance', cursor: null,
    });
    expect(parseRoute('/inspector/memories', base, '?sort=recent&beforeConfirmed=7&beforeId=mem-7')).toEqual({
      name: 'memories', q: '', type: null, status: null, sort: 'recent',
      cursor: { lastConfirmedAtMs: 7, id: 'mem-7' },
    });
    expect(parseRoute('/inspector/memories/mem-1', base, '')).toEqual({
      name: 'memory', id: 'mem-1', evidenceCursor: null,
    });
    expect(parseRoute('/inspector/episodes', base, '?before=1700&id=ep-2')).toEqual({
      name: 'episodes', cursor: { lastActivityAtMs: 1700, id: 'ep-2' },
    });
    expect(parseRoute('/inspector/runs', base, '?before=5&before=6')).toEqual({ name: 'runs', cursor: null });
    expect(parseRoute('/inspector/runs/run-9', base, '')).toEqual({ name: 'run', id: 'run-9', toolCallId: null, exposureAfter: null });
    expect(parseRoute('/inspector/runs/run-9', base, '?toolCall=call-1&exposureAfter=20')).toEqual({ name: 'run', id: 'run-9', toolCallId: 'call-1', exposureAfter: 20 });
    expect(parseRoute('/inspector/speech', base, '')).toEqual({
      name: 'speech', view: 'proposals', cursor: null,
    });
    expect(parseRoute('/inspector/jobs', base, '?status=queued&type=review_episode&before=7&id=job-7')).toEqual({
      name: 'jobs', status: 'queued', type: 'review_episode', cursor: { createdAtMs: 7, id: 'job-7' },
    });
    expect(parseRoute('/inspector/audit', base, '?before=8&id=aud-8')).toEqual({
      name: 'audit', cursor: { createdAtMs: 8, id: 'aud-8' },
    });
    expect(parseRoute('/inspector/channels', base, '')).toEqual({
      name: 'channels', view: 'channels', cursor: null,
    });
    expect(parseRoute('/inspector/channels', base, '?view=threads&afterDeleted=0&afterName=release&afterId=th-9')).toEqual({
      name: 'channels', view: 'threads', cursor: { deleted: 0, sortName: 'release', id: 'th-9' },
    });
    expect(parseRoute('/inspector/resolve', base, '?id=abc')).toEqual({ name: 'resolve', id: 'abc' });
    // The spec pages table documents /resolve/:id; the form uses ?id=.
    expect(parseRoute('/inspector/resolve/mem-0001', base, '')).toEqual({ name: 'resolve', id: 'mem-0001' });
    expect(parseRoute('/inspector/episodes/ep-1', base, '?after=40')).toEqual({
      name: 'episode', id: 'ep-1', after: 40,
    });
  });

  it('rejects unknown subpaths, trailing segments, and bad cursors', () => {
    expect(parseRoute('/inspector/nope', base, '')).toBeNull();
    expect(parseRoute('/inspector/speech/extra', base, '')).toBeNull();
    expect(parseRoute('/inspector/episodes', base, '?before=NaN')).toEqual({ name: 'episodes', cursor: null });
    expect(parseRoute('/inspector/episodes/ep-1', base, '?after=NaN')).toEqual({
      name: 'episode', id: 'ep-1', after: null,
    });
    expect(parseRoute('/inspector/memories', base, '?beforeImportance=.8&beforeConfirmed=7')).toEqual({
      name: 'memories', q: '', type: null, status: null, sort: 'importance', cursor: null,
    });
    expect(parseRoute('/inspector/speech', base, '?view=unknown&before=7&id=x')).toEqual({
      name: 'speech', view: 'proposals', cursor: { createdAtMs: 7, id: 'x' },
    });
    expect(parseRoute('/elsewhere', base, '')).toBeNull();
  });

  it('accepts the token as Bearer, or as the Basic password or username', () => {
    const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64');
    expect(presentedToken('Bearer abc123')).toBe('abc123');
    expect(presentedToken('bearer abc123')).toBe('abc123');
    expect(presentedToken(`Basic ${b64(':abc123')}`)).toBe('abc123');
    expect(presentedToken(`Basic ${b64('token:abc123')}`)).toBe('abc123');
    // A token pasted into the username field with an empty password still works.
    expect(presentedToken(`Basic ${b64('abc123:')}`)).toBe('abc123');
    // A password containing ':' is kept whole: only the first colon splits.
    expect(presentedToken(`Basic ${b64('u:a:b')}`)).toBe('a:b');
    expect(presentedToken(`Basic ${b64('nocolon')}`)).toBeNull();
    expect(presentedToken(`Basic ${b64(':')}`)).toBeNull();
    expect(presentedToken('Basic !!!not-base64!!!')).toBeNull();
    expect(presentedToken('Digest abc')).toBeNull();
    expect(presentedToken('')).toBeNull();
    expect(presentedToken(undefined)).toBeNull();
    expect(presentedToken(['Bearer a', 'Bearer b'])).toBeNull();
    // Only the Basic challenge is advertised: a second comma-appended scheme
    // makes Chromium reject the challenge and skip the login dialog.
    expect(INSPECTOR_WWW_AUTHENTICATE).toBe('Basic realm="Mneme inspector", charset="UTF-8"');
    expect(INSPECTOR_WWW_AUTHENTICATE).not.toContain('Bearer');
  });

  it('escapes LIKE wildcards for the bounded JSON scan', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('inspector configuration — Section 32.6', () => {
  it('defaults to disabled at /inspector with the documented rate limits', () => {
    const cfg = loadConfig({ env: baseEnv() });
    expect(cfg.inspector).toEqual({
      enabled: false,
      path: '/inspector',
      publicBaseUrl: expect.any(String),
      rateLimitPerMinute: 120,
      unauthRateLimitPerMinute: 30,
    });
    expect(inspectorUrl(cfg.inspector)).toBe(`${cfg.inspector.publicBaseUrl}/inspector`);
  });

  it('accepts explicit settings and rejects bad paths', () => {
    const cfg = loadConfig({
      env: { ...baseEnv(), INSPECTOR_ENABLED: 'true', INSPECTOR_PATH: '/ops', INSPECTOR_RATE_LIMIT_PER_MINUTE: '60' },
    });
    expect(cfg.inspector.enabled).toBe(true);
    expect(cfg.inspector.path).toBe('/ops');
    expect(cfg.inspector.rateLimitPerMinute).toBe(60);

    for (const bad of ['inspector', '/', '/mcp', '/livez', '/status', '/inspector/']) {
      try {
        loadConfig({ env: { ...baseEnv(), INSPECTOR_PATH: bad } });
        throw new Error(`expected INSPECTOR_PATH=${bad} to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
      }
    }
    try {
      loadConfig({ env: { ...baseEnv(), INSPECTOR_RATE_LIMIT_PER_MINUTE: '0' } });
      throw new Error('expected a zero rate limit to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
    }
  });

  it('rejects a mount path that any earlier HTTP route would shadow', () => {
    // The server matches these paths before the inspector subtree, so an exact
    // match hides the whole surface and a prefix match hides one sub-path.
    const shadowed = [
      '/metrics',
      '/readyz',
      '/authorize',
      '/token',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known',
    ];
    for (const bad of shadowed) {
      try {
        loadConfig({ env: { ...baseEnv(), INSPECTOR_PATH: bad } });
        throw new Error(`expected INSPECTOR_PATH=${bad} to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
      }
    }
    // Every reserved path is listed whether or not OAuth is enabled.
    expect(reservedHttpPaths({ path: '/mcp' })).toContain('/metrics');
    expect(reservedHttpPaths({ path: '/mcp' })).toContain('/.well-known/oauth-protected-resource/mcp');
  });
});
