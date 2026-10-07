// ABOUTME: Tests the platform archive line in /mneme status and the HTTP status snapshot (plan 011 step 3).
// ABOUTME: The line appears only when an archive is configured; without one the status is unchanged.
import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { collectStatusReport, formatStatusReply, type StatusRuntimeInputs } from '../../../src/commands/status.js';
import type { ArchiveSummary } from '../../../src/platform-archive/database.js';
import { APP_VERSION } from '../../../src/version.js';
import { buildStatusSnapshot } from '../../../src/http/status.js';
import { loadConfig } from '../../../src/config.js';
import { RuntimeState } from '../../../src/runtime-state.js';
import { renderRoute, type PageEnv } from '../../../src/http/inspector/pages.js';

const NOW = 1_790_000_000_000;

const RUNTIME: StatusRuntimeInputs = {
  nowMs: NOW,
  build: { appVersion: APP_VERSION, sourceRevision: null, railwayDeploymentId: null, buildId: null },
  mode: 'review',
  gateway: { connected: true, ready: true, lastEventAtMs: NOW, reconnectCount: 0 },
  model: {
    healthy: true,
    lastCallAtMs: NOW,
    dailyBudgetUsd: 5,
    today: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    allTime: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  },
  backup: { lastBackupAtMs: NOW - 3_600_000, count: 2 },
  walSizeBytes: 4096,
};

const SUMMARY: ArchiveSummary = {
  platform: 'discord',
  workspaceId: '300000000000000001',
  schemaVersion: 45,
  sizeBytes: 286_883_840,
  sha256: '0123456789abcdef'.repeat(4),
  orgMessages: 52_140,
  orgMemories: 312,
};

let env: TestDb | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

describe('status with a platform archive', () => {
  it('shows one archive line under Storage & scope', () => {
    env = createTestDb();
    const report = collectStatusReport(env.db, { ...RUNTIME, archive: SUMMARY });
    expect(report.archive).toEqual(SUMMARY);
    const text = formatStatusReply({ kind: 'done', report });
    expect(text).toContain('Archive: discord · 273.6MB · schema 45 · 52140 org messages · 312 org memories · sha256 0123456789ab');
    expect(text.indexOf('Archive:')).toBeGreaterThan(text.indexOf('**Storage & scope**'));
  });

  it('shows no archive line and no archive field without an archive', () => {
    env = createTestDb();
    const report = collectStatusReport(env.db, RUNTIME);
    expect(report.archive).toBeUndefined();
    expect(formatStatusReply({ kind: 'done', report })).not.toContain('Archive:');
  });

  it('adds the archive to the HTTP status snapshot only when configured', () => {
    env = createTestDb();
    const config = loadConfig({ env: {
      MNEME_PLATFORM: 'discord', DISCORD_TOKEN: 'a-real-discord-token-value', DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_GUILD_ID: '234567890123456789', LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-5.6-terra', OPENAI_API_KEY: 'sk-test-key-value',
      ORG_NAME: 'Test Org', ORG_TIMEZONE: 'UTC', FULL_HISTORY: 'true',
    } });
    const base = { db: env.db, config, buildInfo: RUNTIME.build, runtime: new RuntimeState(), startedAtMs: NOW, now: () => NOW };
    expect(buildStatusSnapshot({ ...base, archive: SUMMARY }).archive).toEqual(SUMMARY);
    expect('archive' in buildStatusSnapshot(base)).toBe(false);
  });

  it('shows the archive on the inspector overview only when configured', () => {
    env = createTestDb();
    const page: PageEnv = {
      db: env.db,
      grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: true, channelIds: [] },
      now: NOW,
      dayStartMs: NOW - 3_600_000,
      basePath: '/inspector',
    };
    const withArchive = renderRoute({ name: 'overview' }, { ...page, archive: SUMMARY }).html;
    expect(withArchive).toContain('archive: discord · 273.6MB · schema 45 · 52,140 org messages · 312 org memories · sha256 0123456789ab');
    expect(renderRoute({ name: 'overview' }, page).html).not.toContain('archive:');
  });
});
