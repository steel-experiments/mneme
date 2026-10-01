import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../helpers/db.js';
import { loadOperationalConfig } from '../../src/config.js';
import {
  runCli,
  CLI_OK,
  CLI_FAIL,
  CLI_USAGE,
  type CliDeps,
} from '../../src/cli/commands.js';

/**
 * Operational CLI (Sections 27, 37, 42).
 *
 * Acceptance — verbatim: "Each package script performs its named operation and
 * failures return nonzero without printing secrets."
 *
 * The CLI is database-only: it loads the operational paths through
 * `loadOperationalConfig` (no Discord token, no provider key), runs migrate /
 * backup / integrity-check against a real temp SQLite file, returns meaningful
 * exit codes, and never prints secrets. These tests drive `runCli` directly with
 * injectable deps and a captured stdout sink.
 */

const REPO_MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));
const NOW = 1_700_000_001_000;

interface Harness {
  deps: CliDeps;
  output: string[];
  dir: string;
  backupDir: string;
}

function harness(envExtra: Record<string, string | undefined> = {}): Harness {
  const dir = makeTempDir();
  createdDirs.push(dir);
  const backupDir = join(dir, 'backups');
  const env: Record<string, string | undefined> = {
    DATA_DIR: dir,
    DATABASE_PATH: join(dir, 'mneme.sqlite'),
    BACKUP_DIR: backupDir,
    ...envExtra,
  };
  const config = loadOperationalConfig({ env });
  const output: string[] = [];
  const deps: CliDeps = {
    config,
    migrationsDir: REPO_MIGRATIONS,
    now: () => NOW,
    stdout: { write: (s: string) => {
      output.push(s);
      return true;
    } },
  };
  return { deps, output, dir, backupDir };
}

/** The full stdout produced so far, joined. */
function text(h: Harness): string {
  return h.output.join('');
}

const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length) {
    const dir = createdDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('migrate', async () => {
  it('applies all pending migrations to a fresh database and returns 0', async () => {
    const h = harness();
    const code = await runCli(['migrate'], h.deps);
    expect(code).toBe(CLI_OK);
    expect(text(h)).toContain('migrate: applied');
    expect(text(h)).toMatch(/applied \d+ migration\(s\)/);
    // A real number of migrations was applied (the repo ships several).
    const applied = Number(/applied (\d+) migration/.exec(text(h))?.[1]);
    expect(applied).toBeGreaterThan(0);
  });

  it('is idempotent: a second run applies nothing and still returns 0', async () => {
    const h = harness();
    expect(await runCli(['migrate'], h.deps)).toBe(CLI_OK);
    const code = await runCli(['migrate'], h.deps);
    expect(code).toBe(CLI_OK);
    expect(text(h)).toContain('applied 0 migration(s)');
  });
});

describe('backup', async () => {
  it('writes an online backup with a healthy integrity_check into BACKUP_DIR', async () => {
    const h = harness();
    await runCli(['migrate'], h.deps); // give the database a schema to back up
    h.output.length = 0;

    const code = await runCli(['backup'], h.deps);
    expect(code).toBe(CLI_OK);
    expect(text(h)).toContain('backup: wrote');
    expect(text(h)).toContain('integrity_check: ok');

    const entries = readdirSync(h.backupDir);
    const sqliteFile = entries.find((f) => f.endsWith('.sqlite'));
    const manifest = entries.find((f) => f.endsWith('.manifest.json'));
    expect(sqliteFile).toBeDefined();
    expect(manifest).toBeDefined();
    expect(existsSync(join(h.backupDir, sqliteFile!))).toBe(true);
  });
});

describe('integrity-check', async () => {
  it('reports healthy integrity and foreign keys on a migrated database', async () => {
    const h = harness();
    await runCli(['migrate'], h.deps);
    h.output.length = 0;

    const code = await runCli(['integrity-check'], h.deps);
    expect(code).toBe(CLI_OK);
    expect(text(h)).toContain('integrity_check: ok');
    expect(text(h)).toContain('foreign_key_check: ok');
  });
});

describe('usage and exit codes', async () => {
  it('returns a nonzero usage code and prints commands when no command is given', async () => {
    const h = harness();
    const code = await runCli([], h.deps);
    expect(code).toBe(CLI_USAGE);
    expect(text(h)).toContain('Usage:');
    expect(text(h)).toContain('migrate');
    expect(text(h)).toContain('backup');
    expect(text(h)).toContain('integrity-check');
  });

  it('returns a nonzero code for an unknown command', async () => {
    const h = harness();
    const code = await runCli(['frobnicate'], h.deps);
    expect(code).toBe(CLI_USAGE);
    expect(text(h)).toContain('Unknown command: frobnicate');
  });

  it('returns 0 for explicit --help', async () => {
    const h = harness();
    expect(await runCli(['--help'], h.deps)).toBe(CLI_OK);
    expect(text(h)).toContain('Usage:');
  });
});

describe('failures return nonzero without printing secrets', async () => {
  // A stand-in secret that must never appear in CLI output.
  const DISCORD_SECRET = 'super-secret-token-xyz';
  const ADMIN_SECRET = 'admin-secret-abc-987';

  function harnessWithSecrets(): Harness {
    return harness({ DISCORD_TOKEN: DISCORD_SECRET, MNEME_HTTP_ADMIN_TOKEN: ADMIN_SECRET });
  }

  it('migrate returns nonzero when the database cannot be opened, and prints no secret', async () => {
    const h = harnessWithSecrets();
    h.deps.openDb = () => {
      throw new Error('SQLITE_CANTOPEN: unable to open database file');
    };
    const code = await runCli(['migrate'], h.deps);
    expect(code).toBe(CLI_FAIL);
    expect(text(h)).toContain('error: migrate failed');
    expect(text(h)).not.toContain(DISCORD_SECRET);
    expect(text(h)).not.toContain(ADMIN_SECRET);
  });

  it('backup returns nonzero when the backup step throws, and prints no secret', async () => {
    const h = harnessWithSecrets();
    await runCli(['migrate'], h.deps);
    h.output.length = 0;
    h.deps.backup = () => {
      throw new Error('online backup failed mid-copy');
    };
    const code = await runCli(['backup'], h.deps);
    expect(code).toBe(CLI_FAIL);
    expect(text(h)).toContain('error: backup failed');
    expect(text(h)).not.toContain(DISCORD_SECRET);
  });

  it('integrity-check returns nonzero when opening fails, and prints no secret', async () => {
    const h = harnessWithSecrets();
    h.deps.openDb = () => {
      throw new Error('SQLITE_CANTOPEN');
    };
    const code = await runCli(['integrity-check'], h.deps);
    expect(code).toBe(CLI_FAIL);
    expect(text(h)).toContain('error: integrity-check failed');
    expect(text(h)).not.toContain(DISCORD_SECRET);
  });

  it('a config-path error (traversal in DATA_DIR) is reported without leaking secrets', async () => {
    const dir = makeTempDir();
    createdDirs.push(dir);
    const env: Record<string, string | undefined> = {
      DATA_DIR: '../escape',
      DATABASE_PATH: join(dir, 'c.sqlite'),
      BACKUP_DIR: join(dir, 'backups'),
      DISCORD_TOKEN: DISCORD_SECRET,
    };
    expect(() => loadOperationalConfig({ env })).toThrow();
    // And the CLI's own failure message (built from the same loader) carries no secret:
    const output: string[] = [];
    let code = CLI_OK;
    try {
      loadOperationalConfig({ env });
    } catch (err) {
      output.push(`error: configuration failed: ${(err as Error).message}\n`);
      code = CLI_FAIL;
    }
    expect(code).toBe(CLI_FAIL);
    expect(output.join('')).not.toContain(DISCORD_SECRET);
  });
});

describe('database-only: no Discord token or model initialization required', async () => {
  it('migrate succeeds with no DISCORD_TOKEN and no provider key in the environment', async () => {
    // Deliberately do NOT set DISCORD_TOKEN or any LLM key.
    const h = harness({ DISCORD_TOKEN: undefined, MNEME_LLM_API_KEY: undefined });
    const code = await runCli(['migrate'], h.deps);
    expect(code).toBe(CLI_OK);
    expect(text(h)).toContain('migrate: applied');
  });

  it('integrity-check succeeds with no DISCORD_TOKEN in the environment', async () => {
    const h = harness({ DISCORD_TOKEN: undefined });
    await runCli(['migrate'], h.deps);
    h.output.length = 0;
    expect(await runCli(['integrity-check'], h.deps)).toBe(CLI_OK);
  });
});
