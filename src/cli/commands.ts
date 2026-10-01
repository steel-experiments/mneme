import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase, type DatabaseSync } from '../db/database.js';
import { applyMigrations, listAppliedMigrations } from '../db/migrations.js';
import { createBackup, integrityCheck, type CreateBackupOptions, type CreateBackupResult } from '../db/backup.js';
import { runIntegrityCheck, runForeignKeyCheck } from '../db/maintenance.js';
import { loadOperationalConfig, ConfigError, type OperationalConfig } from '../config.js';
import { APP_VERSION } from '../version.js';
import { createLogger } from '../logger.js';

/**
 * Operational CLI (Sections 27, 37, 42).
 *
 * The `npm run migrate|backup|integrity-check` scripts invoke
 * `dist/cli/commands.js <command>`. These commands are database-only: they open
 * SQLite, do their work, close, and exit. They perform **no** Discord login and
 * **no** model/provider initialization, and they read configuration through
 * {@link loadOperationalConfig} — which needs only `DATA_DIR` / `DATABASE_PATH`
 * (and optional `BACKUP_DIR`), never a Discord token or provider key. That lets
 * an operator migrate, back up, or integrity-check a database before the bot's
 * credentials exist or while it is stopped.
 *
 * Each command returns a meaningful process exit code: `0` on success, `1` on
 * operational failure, `2` on bad usage. Failures are reported as a short
 * human-readable message on stdout plus a structured `cli.failed` log line; the
 * CLI never prints secrets — it only ever emits paths, counts, and SQLite/config
 * error text (Section 33 redaction is in force via the logger, and the message
 * surfaces here carry no token, key, or content).
 */

const REPO_MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** The recognized operational commands. */
export type CliCommandName = 'migrate' | 'backup' | 'integrity-check';

/** Minimal structured-logger surface the CLI uses (pino satisfies this). */
export interface CliLogger {
  error: (obj: Record<string, unknown>, message: string) => void;
  info?: (obj: Record<string, unknown>, message: string) => void;
}

/** A writable with a `write(string)` method (stdout / stderr / a test buffer). */
export interface CliOut {
  write: (chunk: string) => void;
}

/** Dependencies for {@link runCli}; every operational concern is injectable. */
export interface CliDeps {
  config: OperationalConfig;
  /** Open the database connection (default {@link openDatabase}). */
  openDb?: (path: string) => DatabaseSync;
  /** Migrations directory (default: the repo `migrations/`). */
  migrationsDir?: string;
  /** Application version recorded in backup manifests (default {@link APP_VERSION}). */
  appVersion?: string;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  /** Human-readable output sink (default `process.stdout`). */
  stdout?: CliOut;
  /** Structured logger (default: a redacted pino logger). */
  log?: CliLogger;
  /** Override the backup step (tests inject a fake to force failure). */
  backup?: (options: CreateBackupOptions) => CreateBackupResult | Promise<CreateBackupResult>;
}

/** Exit codes used across the commands. */
export const CLI_OK = 0;
export const CLI_FAIL = 1;
export const CLI_USAGE = 2;

const KNOWN_COMMANDS: readonly string[] = ['migrate', 'backup', 'integrity-check'];

/**
 * Dispatch one operational command. `args` is the argv tail (e.g.
 * `process.argv.slice(2)`); `args[0]` is the command name. Returns the process
 * exit code (a Promise of it — `backup` awaits the async online-backup API)
 * without ever throwing — every failure is caught, logged, and turned into a
 * nonzero code.
 */
export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const command = args[0];
  switch (command) {
    case 'migrate':
      return runMigrate(deps);
    case 'backup':
      return runBackup(deps);
    case 'integrity-check':
      return runIntegrityCheckCommand(deps);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printUsage(deps);
      return command === undefined ? CLI_USAGE : CLI_OK;
    default:
      out(deps, `Unknown command: ${command}`);
      printUsage(deps);
      return CLI_USAGE;
  }
}

/** `migrate` — apply all pending migrations to the configured database. */
async function runMigrate(deps: CliDeps): Promise<number> {
  let db: DatabaseSync | undefined;
  try {
    db = openDb(deps);
    const result = applyMigrations(db, deps.migrationsDir ?? REPO_MIGRATIONS);
    const total = listAppliedMigrations(db).length;
    out(deps, `migrate: applied ${result.applied.length} migration(s); ${total} now at head`);
    return CLI_OK;
  } catch (err) {
    fail(deps, 'migrate', err);
    return CLI_FAIL;
  } finally {
    safeClose(db);
  }
}

/** `backup` — create an online SQLite backup in `BACKUP_DIR` and verify it. */
async function runBackup(deps: CliDeps): Promise<number> {
  let db: DatabaseSync | undefined;
  try {
    db = openDb(deps);
    const result = await (deps.backup ?? createBackup)({
      db,
      backupsDir: deps.config.backupDir,
      sourceDatabasePath: deps.config.databasePath,
      appVersion: deps.appVersion ?? APP_VERSION,
      now: (deps.now ?? Date.now)(),
    });
    // §42.1 step 3: integrity_check the completed backup before trusting it.
    const integrity = integrityCheck(result.backupPath);
    const ok = integrity === 'ok';
    out(
      deps,
      `backup: wrote ${result.backupPath} (${result.pages} pages); integrity_check: ${ok ? 'ok' : 'FAILED'}`,
    );
    return ok ? CLI_OK : CLI_FAIL;
  } catch (err) {
    fail(deps, 'backup', err);
    return CLI_FAIL;
  } finally {
    safeClose(db);
  }
}

/** `integrity-check` — run integrity_check + foreign_key_check on the live db. */
async function runIntegrityCheckCommand(deps: CliDeps): Promise<number> {
  let db: DatabaseSync | undefined;
  try {
    db = openDb(deps);
    const integrity = runIntegrityCheck(db);
    const foreignKeys = runForeignKeyCheck(db);
    out(deps, `integrity_check: ${integrity.ok ? 'ok' : 'FAILED'}`);
    if (!integrity.ok) out(deps, truncate(integrity.message));
    out(deps, `foreign_key_check: ${foreignKeys.ok ? 'ok' : `${foreignKeys.violations} violation(s)`}`);
    if (!foreignKeys.ok) out(deps, truncate(foreignKeys.message));
    return integrity.ok && foreignKeys.ok ? CLI_OK : CLI_FAIL;
  } catch (err) {
    fail(deps, 'integrity-check', err);
    return CLI_FAIL;
  } finally {
    safeClose(db);
  }
}


/** Print the supported commands. */
function printUsage(deps: CliDeps): void {
  out(deps, 'Usage: mneme <command>');
  out(deps, 'Commands:');
  out(deps, '  migrate          Apply pending database migrations.');
  out(deps, '  backup           Create an online SQLite backup in BACKUP_DIR.');
  out(deps, '  integrity-check  Run integrity_check and foreign_key_check.');
}

/** Open the configured database via the (injectable) opener. */
function openDb(deps: CliDeps): DatabaseSync {
  return (deps.openDb ?? openDatabase)(deps.config.databasePath);
}

/** Emit a line of human-readable output. */
function out(deps: CliDeps, line: string): void {
  (deps.stdout ?? process.stdout).write(`${line}\n`);
}

/**
 * Report a caught failure. Only the error message is surfaced — never a stack
 * trace, config dump, or environment — so no secret can leak through the CLI.
 * The message carries a path, a count, or SQLite/config text, none of which are
 * credentials (Section 33).
 */
function fail(deps: CliDeps, command: string, err: unknown): void {
  const detail = errorMessage(err);
  out(deps, `error: ${command} failed: ${detail}`);
  deps.log?.error({ event: 'cli.failed', command, ok: false }, detail);
}

function safeClose(db: DatabaseSync | undefined): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* a half-open handle during teardown is not worth failing the command for */
  }
}

function truncate(s: string, limit = 800): string {
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

function errorMessage(err: unknown): string {
  if (err instanceof ConfigError) return err.message;
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export { KNOWN_COMMANDS };

/**
 * Process entry point. Loads the operational config (no Discord token needed),
 * runs the command, and sets `process.exitCode` on failure. A config error
 * before any command runs is reported and exits nonzero without secrets.
 */
async function main(): Promise<void> {
  let deps: CliDeps;
  try {
    // The operational loader fills process.env from ./.env first, so the
    // logger created after it sees LOG_LEVEL from the file as well.
    deps = { config: loadOperationalConfig(), log: createLogger() };
  } catch (err) {
    process.stderr.write(`error: configuration failed: ${errorMessage(err)}\n`);
    process.exitCode = CLI_FAIL;
    return;
  }
  const code = await runCli(process.argv.slice(2), deps);
  if (code !== CLI_OK) process.exitCode = code;
}

/**
 * Run only when this module is the process entry point (`node dist/cli/commands.js
 * <command>`), not when it is imported — e.g. by tests, which call {@link runCli}
 * directly. Comparing the resolved entry path avoids triggering the CLI under the
 * test runner's own argv.
 */
if (isMainEntry()) void main();

function isMainEntry(): boolean {
  try {
    const entry = process.argv[1];
    return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}
