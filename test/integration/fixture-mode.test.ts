import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFixtureMode, assertFixtureModeSafe, type FixtureReport } from '../../src/fixture-mode.js';

/**
 * Phase 0 fixture mode (Section 47 Phase 0; task T123).
 *
 * Acceptance — verbatim: "Fixture mode exercises the full review path with no
 * network Discord connection and all mandatory privacy tests pass."
 *
 * The in-process test drives the real agent runtime against a synthetic fixture
 * (a scripted faux model — no network) and asserts the review finalizes, prompt
 * version is stored, privacy scoping keeps restricted content out of org
 * retrieval, and the online backup passes integrity check. The guard tests pin
 * the "cannot use production Discord credentials" requirement. A subprocess
 * test exercises the CLI entry point end-to-end (`tsx src/fixture-mode.ts`).
 */

const FIXTURE_MODE = fileURLToPath(new URL('../../src/fixture-mode.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

const NOW = 1_700_000_001_000;
// This full-stack SQLite/backup path competes with every integration worker in
// the repository-wide run; keep its case timeout aligned with the CLI guard.
const FIXTURE_CASE_TIMEOUT_MS = 60_000;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(envOverride: Record<string, string> = {}, timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, FIXTURE_MODE], {
      env: { ...process.env, ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += c));
    child.stderr?.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fixture-mode CLI did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('fixture mode in-process (Section 47 Phase 0)', () => {
  it('exercises the full review path offline and reports ok', async () => {
    const report: FixtureReport = await runFixtureMode({ now: () => NOW });
    expect(report.ok).toBe(true);
    expect(report.mode).toBe('fixture');
    expect(report.review.kind).toBe('reviewed');
  }, FIXTURE_CASE_TIMEOUT_MS);

  it('stores a per-run prompt version (64-char hex)', async () => {
    const report = await runFixtureMode({ now: () => NOW });
    expect(report.promptVersion).toMatch(/^[0-9a-f]{64}$/);
  }, FIXTURE_CASE_TIMEOUT_MS);

  it('records the migrated schema version', async () => {
    const report = await runFixtureMode({ now: () => NOW });
    expect(typeof report.schemaVersion).toBe('number');
    expect(report.schemaVersion).toBeGreaterThan(0);
  }, FIXTURE_CASE_TIMEOUT_MS);

  it('keeps restricted content out of org-scoped retrieval', async () => {
    const report = await runFixtureMode({ now: () => NOW });
    expect(report.privacy.canaryLeakedToOrg).toBe(false);
    expect(report.privacy.orgContentVisible).toBe(true);
    // The canary is stored but scope-filtered — privacy is enforced by scope,
    // not by absence of the data.
    expect(report.privacy.canaryStored).toBe(true);
  }, FIXTURE_CASE_TIMEOUT_MS);

  it('produces an integrity-checked online backup', async () => {
    const report = await runFixtureMode({ now: () => NOW });
    expect(report.backup.integrity).toBe('ok');
    expect(report.backup.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.backup.bytes).toBeGreaterThan(0);
  }, FIXTURE_CASE_TIMEOUT_MS);
});

describe('production-credential guard', () => {
  it('throws when DISCORD_TOKEN is set', () => {
    expect(() => assertFixtureModeSafe({ DISCORD_TOKEN: 'a-real-token' })).toThrow(/DISCORD_TOKEN/);
  });

  it.each(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'])('throws when %s is set', (name) => {
    expect(() => assertFixtureModeSafe({ [name]: 'a-real-token' })).toThrow(new RegExp(`${name}.*Slack credentials`));
  });

  it('is silent when DISCORD_TOKEN is unset', () => {
    expect(() => assertFixtureModeSafe({})).not.toThrow();
  });

  it('treats a whitespace-only token as unset', () => {
    expect(() => assertFixtureModeSafe({ DISCORD_TOKEN: '   ' })).not.toThrow();
  });
});

describe('fixture mode CLI entry point', () => {
  it('exits 0 and prints an ok report when no token is set', async () => {
    const { code, stdout } = await runCli({ DISCORD_TOKEN: '' });
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as FixtureReport;
    expect(report.ok).toBe(true);
    expect(report.review.kind).toBe('reviewed');
  }, 90_000);

  it('exits non-zero and refuses when DISCORD_TOKEN is set', async () => {
    const { code, stderr } = await runCli({ DISCORD_TOKEN: 'production-token' });
    expect(code).not.toBe(0);
    expect(stderr).toContain('DISCORD_TOKEN');
  }, 90_000);
});
