import { applyDotEnvFile, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { installDefaultSignalHandlers } from './shutdown.js';
import { bootstrapApplication, BootstrapError } from './bootstrap.js';
import { resolveBuildInfo } from './build-info.js';

/**
 * Process entry point.
 *
 * Validates configuration, installs the SIGTERM/SIGINT handlers, then runs the
 * Section 9.2 startup sequence (SQLite, /livez, prompts/policy, Discord Gateway,
 * ingestion, readiness, discovery/backfill, job runtime) and wires the
 * {@link ShutdownCoordinator}. The bootstrap publishes the coordinator via
 * `setShutdownCoordinator` so the signal handlers run the full ordered teardown
 * (Section 34). The Discord/ingestion/discovery/job steps use the real default
 * seams, which require a configured token and the shipped prompt/policy files.
 */
async function main(): Promise<void> {
  // Native runs: fill process.env from ./.env before the logger reads
  // LOG_LEVEL. A real environment variable always wins over the file.
  applyDotEnvFile(process.env);
  const log = createLogger();
  const buildInfo = resolveBuildInfo();
  // Signal handlers first so a signal during bootstrap still exits cleanly.
  installDefaultSignalHandlers({ log });
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error({ event: 'startup.config_failed', err: (err as Error).message }, 'configuration validation failed');
    process.exitCode = 1;
    return;
  }
  log.info(
    {
      event: 'startup.init',
      mode: config.mode,
      provider: config.llm.provider,
      guildId: config.workspaceId,
      build: buildInfo,
      shutdownTimeoutSeconds: config.maintenance.shutdownTimeoutSeconds,
    },
    'mneme starting',
  );
  try {
    await bootstrapApplication({ config, buildInfo, logger: log });
  } catch (err) {
    if (err instanceof BootstrapError) {
      log.error({ event: 'startup.bootstrap_failed', err: err.message }, 'bootstrap precondition failed');
    } else {
      log.error({ event: 'startup.bootstrap_failed', err: (err as Error).message }, 'bootstrap failed');
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
