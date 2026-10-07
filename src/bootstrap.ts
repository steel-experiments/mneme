import { fileURLToPath } from 'node:url';
import { type AppConfig, type ArchiveConfig, type AutonomyMode } from './config.js';
import { createLogger } from './logger.js';
import { createCounters, type Counters } from './observability.js';
import { openDatabase, type DatabaseSync } from './db/database.js';
import { ArchiveError, openArchiveDatabase, verifyArchive, type ArchiveSummary } from './platform-archive/database.js';
import { applyMigrations } from './db/migrations.js';
import { startHttpServer, type HttpServerHandle, type ProbeResult } from './http/server.js';
import { createLivenessProbe } from './http/health.js';
import { createStatusProvider } from './http/status.js';
import { ConfigStore, loadInitialSnapshot, type ConfigSnapshot } from './config-reload.js';
import { RuntimeState, getRuntimeModeOverride } from './runtime-state.js';
import { ShutdownCoordinator, createShutdownDeps, type ShutdownResult } from './shutdown.js';
import { setShutdownCoordinator } from './shutdown.js';
import type { Logger } from 'pino';
import type { ChatPlatform, PlatformFormat, PlatformHealthTracker } from './platform/types.js';
import {
  normalizeBuildInfo,
  resolveBuildInfo,
  type BuildInfo,
} from './build-info.js';

/**
 * Application bootstrap (Sections 5, 9.2, 34).
 *
 * Wires the one-process architecture in the Section 9.2 startup order:
 *   1. open and migrate SQLite;
 *   2. start `/livez`;
 *   3. compile prompts and validate policy;
 *   4. connect the Discord Gateway;
 *   5. begin storing live Gateway events;
 *   6. register commands and mark `/readyz` ready;
 *   7. enumerate channels and active threads;
 *   8. enqueue historical backfill;
 *   9. enumerate archived threads;
 *  10. continue backfill in the background.
 *
 * The Gateway connects before historical import so no live event is lost while
 * backfill runs (Section 9.2). Each precondition fails cleanly: a missing token,
 * a bad policy, or a failed bind raises {@link BootstrapError} before the process
 * proceeds.
 *
 * The Discord, ingestion, command-registration, discovery/backfill, and job-runtime
 * steps are injectable seams. Defaults call the real modules where a token and live
 * client are available; tests inject fakes and assert the recorded milestone order
 * and the one-database / one-client / one-server singletons (Section 5.1).
 */

const REPO_MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

/** The ten Section 9.2 milestones, in startup order. */
export type BootstrapMilestone =
  | 'sqlite_migrated'
  | 'livez_started'
  | 'prompts_policy_compiled'
  | 'discord_connected'
  | 'ingestion_started'
  | 'readyz_ready'
  | 'channels_enumerated'
  | 'backfill_enqueued'
  | 'archived_threads_enumerated'
  | 'backfill_continued';

export interface RecordedMilestone {
  /** 1-based Section 9.2 step number. */
  step: number;
  name: BootstrapMilestone;
  atMs: number;
}

/** Discovery/backfill phases recorded during steps 7-10. */
export type StartupDiscoveryPhase =
  | 'enumerate-channels'
  | 'enqueue-backfill'
  | 'enumerate-archived-threads'
  | 'enqueue-archived-backfill';

/** A startup-phase callback used by the discovery/backfill seam (steps 7-10). */
export type PhaseRecorder = (phase: StartupDiscoveryPhase) => void;

/** Handle to the connected chat platform and its teardown. */
export interface PlatformWiring {
  /** The connected platform, when a real one was created. */
  platform?: ChatPlatform;
  /** The health tracker, when one is in use. */
  tracker?: PlatformHealthTracker;
  /** Disconnect from the platform (shutdown step 7). */
  destroy(): Promise<void> | void;
}

/** Handle to the job worker + scheduler and their teardown. */
export interface JobRuntimeWiring {
  worker?: any;
  scheduler?: any;
  /** Stop the worker and scheduler (composed into shutdown draining). */
  stop(): Promise<void> | void;
}

/** Shared context handed to every seam. */
export interface BootstrapContext {
  config: AppConfig;
  /** Safe identity of the application source/build/deployment running this process. */
  buildInfo: BuildInfo;
  /** Railway/environment baseline before any durable Discord override. */
  configuredMode: AutonomyMode;
  db: DatabaseSync;
  runtime: RuntimeState;
  /** Resolved prompt/policy snapshot after step 3. */
  snapshot?: ConfigSnapshot;
  /** Atomically reloadable production snapshot store. */
  configStore?: ConfigStore;
  logger: Logger;
  /** Process-lifetime, content-free operational counters. */
  counters: Counters;
  now: () => number;
  /** Text conventions of the active chat platform (equal to `platform.format`). */
  format: PlatformFormat;
  /** The verified read-only archive of another platform, when configured (plan 011). */
  platformArchive?: PlatformArchive;
}

/** Injectable startup seams. Each has a real default; tests override them. */
export interface BootstrapSeams {
  /** Step 3: compile prompts and validate channel policy. */
  compilePromptsAndPolicy?: (ctx: BootstrapContext) => void | Promise<void>;
  /** The chat platform for this deployment (default: selected by `MNEME_PLATFORM`). */
  createPlatform?: (ctx: BootstrapContext) => ChatPlatform | Promise<ChatPlatform>;
  /** Step 4: connect the chat platform and return a teardown handle. */
  connectPlatform?: (ctx: BootstrapContext) => Promise<PlatformWiring> | PlatformWiring;
  /** Step 5: begin persisting live Gateway events. */
  beginIngestion?: (ctx: BootstrapContext, discord: PlatformWiring) => void | Promise<void>;
  /** Step 6 (pre-ready): register guild-scoped admin commands. */
  registerCommands?: (ctx: BootstrapContext, discord: PlatformWiring) => void | Promise<void>;
  /** Steps 7-10: enumerate channels/threads and enqueue backfill. */
  discoverAndBackfill?: (
    ctx: BootstrapContext,
    discord: PlatformWiring,
    record: PhaseRecorder,
  ) => void | Promise<void>;
  /** Start the bounded job worker and periodic scheduler. */
  startJobRuntime?: (ctx: BootstrapContext, discord: PlatformWiring | null) => JobRuntimeWiring | Promise<JobRuntimeWiring>;
  /** Start the HTTP server (default true). Set false to skip the bind. */
  startHttp?: boolean;
}

export interface BootstrapDeps {
  config: AppConfig;
  /** Explicit build identity (production resolves it once in main). */
  buildInfo?: BuildInfo;
  logger?: Logger;
  /** An already-open database (tests pass `createTestDb().db`). */
  db?: DatabaseSync;
  /** Migrations directory (default: the repo migrations). */
  migrationsDir?: string;
  /** HTTP port (default: `config.port`). `0` requests an ephemeral port. */
  httpPort?: number;
  /** Bind host (default `0.0.0.0`). */
  httpHost?: string;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  /** Injectable seams (default: real modules). */
  seams?: BootstrapSeams;
  /** Register the coordinator for the default signal handlers (default true). */
  installSignals?: boolean;
}

export interface BootstrapResult {
  /** Section 9.2 milestones in the order they occurred. */
  milestones: RecordedMilestone[];
  db: DatabaseSync;
  runtime: RuntimeState;
  buildInfo: BuildInfo;
  httpServer: HttpServerHandle | null;
  discord: PlatformWiring | null;
  jobs: JobRuntimeWiring | null;
  coordinator: ShutdownCoordinator;
  snapshot?: ConfigSnapshot;
  /** Run graceful shutdown (Section 34). */
  stop(): Promise<ShutdownResult>;
}

/** A verified read-only archive and its summary (plan 011). */
export interface PlatformArchive {
  db: DatabaseSync;
  summary: ArchiveSummary;
}

/**
 * Open and verify the configured archive. The newest schema this release
 * knows is the live database's applied version, which was just migrated.
 */
function openPlatformArchive(liveDb: DatabaseSync, archive: ArchiveConfig, resources: StartupResources): PlatformArchive {
  const newestSchemaVersion = Number(
    (liveDb.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined)?.v ?? 0,
  );
  try {
    const archiveDb = openArchiveDatabase(archive.path);
    resources.archiveDb = archiveDb;
    const summary = verifyArchive(archiveDb, archive.path, { platform: archive.platform, newestSchemaVersion });
    return { db: archiveDb, summary };
  } catch (err) {
    if (err instanceof ArchiveError) throw new BootstrapError(err.message);
    throw err;
  }
}

/** Raised when a startup precondition is not met. */
export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

const STEP_BY_PHASE: Record<StartupDiscoveryPhase, number> = {
  'enumerate-channels': 7,
  'enqueue-backfill': 8,
  'enumerate-archived-threads': 9,
  'enqueue-archived-backfill': 10,
};
const MILESTONE_BY_PHASE = {
  'enumerate-channels': 'channels_enumerated',
  'enqueue-backfill': 'backfill_enqueued',
  'enumerate-archived-threads': 'archived_threads_enumerated',
  'enqueue-archived-backfill': 'backfill_continued',
} as const;

/**
 * Run the Section 9.2 startup sequence and return the assembled singletons. The
 * database, HTTP server, readiness state, and shutdown coordinator are always
 * real; the Discord/ingestion/discovery/job seams default to the real modules and
 * are overridable for tests.
 */
interface StartupResources {
  ownedDb?: DatabaseSync;
  archiveDb?: DatabaseSync;
  http?: HttpServerHandle;
  discord?: PlatformWiring;
  jobs?: JobRuntimeWiring;
}

/**
 * Public startup boundary. If any later startup step fails, unwind every
 * resource already acquired in reverse order. Without this guard a bad policy,
 * failed command registration, or discovery error could leave a listening HTTP
 * server, Gateway connection, and locked SQLite file in a half-started process.
 */
export async function bootstrapApplication(deps: BootstrapDeps): Promise<BootstrapResult> {
  const resources: StartupResources = {};
  try {
    return await bootstrapApplicationUnsafe(deps, resources);
  } catch (error) {
    const logger = deps.logger ?? createLogger();
    const cleanup = async (name: string, fn: (() => void | Promise<void>) | undefined): Promise<void> => {
      if (!fn) return;
      try { await fn(); }
      catch (cleanupError) {
        logger.warn({ event: 'bootstrap.cleanup_failed', resource: name,
          err: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }, 'startup cleanup failed');
      }
    };
    await cleanup('jobs', resources.jobs ? () => resources.jobs!.stop() : undefined);
    await cleanup('discord', resources.discord ? () => resources.discord!.destroy() : undefined);
    await cleanup('http', resources.http ? () => resources.http!.close() : undefined);
    await cleanup('archive', resources.archiveDb ? () => resources.archiveDb!.close() : undefined);
    await cleanup('database', resources.ownedDb ? () => resources.ownedDb!.close() : undefined);
    throw error;
  }
}

async function bootstrapApplicationUnsafe(deps: BootstrapDeps, resources: StartupResources): Promise<BootstrapResult> {
  const logger = deps.logger ?? createLogger();
  const now = deps.now ?? Date.now;
  const config = deps.config;
  const buildInfo = normalizeBuildInfo(deps.buildInfo ?? resolveBuildInfo());
  const seams = deps.seams ?? {};
  const milestones: RecordedMilestone[] = [];
  const record = (step: number, name: BootstrapMilestone): void => {
    milestones.push({ step, name, atMs: now() });
  };

  // Step 1: open and migrate SQLite.
  const ownsDb = !deps.db;
  const db = deps.db ?? openDatabase(config.databasePath);
  if (ownsDb) resources.ownedDb = db;
  applyMigrations(db, deps.migrationsDir ?? REPO_MIGRATIONS);
  const runtime = new RuntimeState();
  runtime.markMigrationsApplied();
  record(1, 'sqlite_migrated');
  logger.info({ event: 'bootstrap.sqlite_migrated', ownsDb }, 'sqlite opened and migrated');

  // Open and verify the read-only platform archive before anything can serve
  // it. A wrong, broken, or unknown archive stops startup (plan 011).
  const platformArchive = config.archive ? openPlatformArchive(db, config.archive, resources) : undefined;
  if (platformArchive) {
    const { summary } = platformArchive;
    logger.info({
      event: 'bootstrap.archive_verified',
      platform: summary.platform,
      schemaVersion: summary.schemaVersion,
      sizeBytes: summary.sizeBytes,
      sha256: summary.sha256.slice(0, 12),
      orgMessages: summary.orgMessages,
      orgMemories: summary.orgMemories,
      hiddenLegacyThreads: summary.hiddenLegacyThreads,
    }, 'platform archive verified');
  }

  const configuredMode = config.mode;
  const ctx: BootstrapContext = {
    config,
    buildInfo,
    configuredMode,
    db,
    runtime,
    logger,
    counters: createCounters(),
    now,
    format: (await import('./platform/select.js')).platformFormat(config.platform),
    platformArchive,
  };
  let platformInstance: ChatPlatform | undefined;
  const getPlatform = async (): Promise<ChatPlatform> => {
    if (!platformInstance) {
      platformInstance = seams.createPlatform
        ? await seams.createPlatform(ctx)
        : (await import('./platform/select.js')).createPlatform(config, logger, now);
    }
    return platformInstance;
  };
  // Declared before HTTP starts so the status-provider closure is safe during
  // early startup (null) and begins reporting live tracker state after step 4.
  let discord: PlatformWiring | null = null;

  // Step 2: start /livez (and /readyz, bound to the runtime).
  const statusStartedAtMs = now();
  let httpServer: HttpServerHandle | null = null;
  if (seams.startHttp !== false) {
    let mcpHandler: import('./http/server.js').RouteHandler | undefined;
    let oauthMetadataRoutes: Record<string, unknown> | undefined;
    let oauthRoutes: Record<string, import('./http/server.js').RouteHandler> | undefined;
    if (config.mcp.enabled) {
      const { createMcpServer } = await import('./mcp/server.js');
      const { createRateLimiter } = await import('./mcp/rate-limit.js');
      const unauthRateLimiter = createRateLimiter({
        limit: config.mcp.unauthRateLimitPerMinute,
        windowMs: 60_000,
      });
      // Discovery is opt-in and only meaningful alongside the MCP endpoint it
      // describes: the documents name a resource that must exist to be reached.
      let wwwAuthenticate: string | undefined;
      if (config.mcp.oauthEnabled) {
        const oauth = await import('./mcp/oauth/metadata.js');
        const metadataConfig = {
          publicBaseUrl: config.mcp.publicBaseUrl,
          mcpPath: config.mcp.path,
        };
        oauthMetadataRoutes = {
          [oauth.protectedResourceMetadataPath(config.mcp.path)]:
            oauth.protectedResourceMetadata(metadataConfig),
          [oauth.OAUTH_PROTECTED_RESOURCE_PATH]: oauth.protectedResourceMetadata(metadataConfig),
          [oauth.OAUTH_AUTHORIZATION_SERVER_PATH]:
            oauth.authorizationServerMetadata(metadataConfig),
        };
        wwwAuthenticate = oauth.wwwAuthenticateChallenge(metadataConfig);
        const { createOAuthRoutes } = await import('./mcp/oauth/routes.js');
        oauthRoutes = createOAuthRoutes({
          db,
          logger,
          now,
          identity: (await getPlatform()).oauthIdentity,
          rateLimiter: unauthRateLimiter,
          context: {
            client: {
              clientId: config.mcp.oauthClientId,
              redirectUris: config.mcp.oauthRedirectUris,
            },
            resource: oauth.mcpResourceIdentifier(metadataConfig),
            publicBaseUrl: config.mcp.publicBaseUrl,
          },
        });
        logger.info(
          {
            event: 'mcp.oauth_discovery_enabled',
            resource: oauth.mcpResourceIdentifier(metadataConfig),
            issuer: config.mcp.publicBaseUrl,
          },
          'serving mcp oauth discovery documents',
        );
      }
      mcpHandler = createMcpServer({
        wwwAuthenticate,
        db,
        rateLimiter: createRateLimiter({ limit: config.mcp.rateLimitPerMinute, windowMs: 60_000 }),
        unauthRateLimiter,
        now,
        toolListTtlMs: config.mcp.toolListTtlMs,
        logger,
      }).handler;
    }
    httpServer = await startHttpServer({
      port: deps.httpPort ?? config.port,
      host: deps.httpHost,
      logger,
      healthProbe: createLivenessProbe(db),
      readinessProbe: (): ProbeResult => {
        const ready = runtime.isReady();
        return { ok: ready, error: ready ? undefined : runtime.blockingReason() ?? 'not_ready' };
      },
      // Section 32.3: /status is disabled (404) unless HTTP_ADMIN_TOKEN is set.
      adminToken: config.httpAdminToken,
      statusProvider: createStatusProvider({
        db,
        config,
        runtime,
        buildInfo,
        startedAtMs: statusStartedAtMs,
        now,
        archive: platformArchive?.summary,
        discord: () => {
          const health = discord?.tracker?.snapshot?.();
          if (!health) return null;
          return {
            connected: health.ready === true || health.status === 'ready' || health.status === 'resumed',
            ready: health.ready === true,
            pingMs: typeof health.pingMs === 'number' && Number.isFinite(health.pingMs)
              ? health.pingMs
              : null,
            lastEventAtMs: typeof health.lastEventAtMs === 'number' ? health.lastEventAtMs : null,
            reconnectCount: typeof health.reconnects === 'number' ? health.reconnects : 0,
          };
        },
      }),
      mcpEnabled: config.mcp.enabled,
      mcpPath: config.mcp.path,
      mcpHandler,
      // Section 32.6: the inspector subtree is concealed (404) unless enabled.
      inspectorEnabled: config.inspector.enabled,
      inspectorPath: config.inspector.path,
      inspectorHandler: config.inspector.enabled
        ? (await import('./http/inspector/router.js')).createInspectorHandler({
            db,
            config: config.inspector,
            logger,
            now,
            timezone: config.organization.timezone,
            archive: platformArchive?.summary,
            readiness: () => {
              const ready = runtime.isReady();
              return {
                ready,
                reason: ready ? null : runtime.blockingReason() ?? 'not_ready',
              };
            },
            configuredMode: config.mode,
          })
        : undefined,
      oauthMetadataRoutes,
      oauthRoutes,
    });
    resources.http = httpServer;
  }
  record(2, 'livez_started');

  // Step 3: compile prompts and validate channel policy.
  if (seams.compilePromptsAndPolicy) {
    await seams.compilePromptsAndPolicy(ctx);
  } else {
    ctx.snapshot = loadInitialSnapshot(
      {
        channelPolicyPath: config.channelPolicyPath,
        promptDir: config.promptDir,
        channelPolicySource: config.channelPolicySource,
      },
      now(),
    );
    ctx.configStore = new ConfigStore(ctx.snapshot);
  }
  const modeOverride = getRuntimeModeOverride(db);
  if (modeOverride) {
    config.mode = modeOverride.mode;
    logger.info(
      { event: 'bootstrap.mode_override_applied', configuredMode, mode: modeOverride.mode },
      'durable runtime mode override applied',
    );
  }
  if (ctx.snapshot) {
    const policyReview = ctx.snapshot.channelPolicy.review_channel;
    if (config.reviewChannelId && policyReview?.id !== config.reviewChannelId) {
      throw new BootstrapError('MNEME_REVIEW_CHANNEL_ID must match channel-policy.yml review_channel.id');
    }
    if ((config.mode === 'review' || config.mode === 'autonomous') &&
        (!policyReview || !policyReview.secure || policyReview.id !== config.reviewChannelId)) {
      throw new BootstrapError(`mode "${config.mode}" requires the same secure review channel in environment and policy`);
    }
  }
  runtime.markPolicyAndPromptsCompiled();
  record(3, 'prompts_policy_compiled');

  // Step 4: connect the chat platform.
  if (seams.connectPlatform) {
    discord = await seams.connectPlatform(ctx);
  } else if ((await getPlatform()).hasCredentials) {
    discord = await defaultConnectPlatform(ctx, await getPlatform());
  } else {
    // No token and no seam: a clean, logged skip rather than a crash. The
    // readiness gate stays not-ready until a caller supplies a connection.
    logger.warn({ event: 'bootstrap.no_discord_token' }, 'DISCORD_TOKEN unset; skipping live Gateway connection');
  }
  if (discord) resources.discord = discord;
  record(4, 'discord_connected');

  // Step 5: begin storing live Gateway events.
  if (discord) {
    if (seams.beginIngestion) {
      await seams.beginIngestion(ctx, discord);
    } else {
      await defaultBeginIngestion(ctx, discord);
    }
  }
  record(5, 'ingestion_started');

  // Step 6: register commands, then mark ready (Discord auth + commands).
  if (discord) {
    if (seams.registerCommands) {
      await seams.registerCommands(ctx, discord);
      runtime.markCommandsRegistered();
    } else if (discord.platform) {
      await defaultRegisterCommands(discord.platform);
      runtime.markCommandsRegistered();
    }
    runtime.markDiscordAuthenticated();
  }
  record(6, 'readyz_ready');

  let jobs: JobRuntimeWiring | null = null;

  // Steps 7-10: enumerate channels/threads and enqueue backfill. The seam records
  // each phase; the bootstrap maps it to the matching Section 9.2 milestone.
  if (discord && (seams.discoverAndBackfill || discord.platform)) {
    const phaseRecorder: PhaseRecorder = (phase) => {
      record(STEP_BY_PHASE[phase], MILESTONE_BY_PHASE[phase]);
    };
    if (seams.discoverAndBackfill) await seams.discoverAndBackfill(ctx, discord, phaseRecorder);
    else await defaultDiscoverAndBackfill(ctx, discord, phaseRecorder);
  }

  // Start bounded workers only after startup discovery has populated channel
  // metadata and queued its initial durable work.
  if (seams.startJobRuntime) jobs = await seams.startJobRuntime(ctx, discord);
  else if (discord?.platform) jobs = await defaultStartJobRuntime(ctx, discord);
  if (jobs) resources.jobs = jobs;

  // Wire graceful shutdown over the assembled singletons.
  const coordinator = new ShutdownCoordinator(
    createShutdownDeps({
      db,
      archiveDb: platformArchive?.db,
      runtime,
      workers: jobs?.worker ? [jobs.worker] : [],
      discord: discord ?? undefined,
      stopSchedulers: () => jobs?.scheduler?.stop?.(),
      closeHttp: () => httpServer?.close(),
    }),
    { drainDeadlineMs: config.maintenance.shutdownTimeoutSeconds * 1000, log: logger },
  );
  if (deps.installSignals !== false) {
    setShutdownCoordinator(coordinator);
  }

  logger.info({
    event: 'bootstrap.complete',
    build: buildInfo,
    milestoneCount: milestones.length,
    ready: runtime.isReady(),
  }, 'bootstrap complete');

  return {
    milestones,
    db,
    runtime,
    buildInfo,
    httpServer,
    discord,
    jobs,
    coordinator,
    snapshot: ctx.snapshot,
    stop: () => coordinator.begin(),
  };
}

// ---- real default seams -----------------------------------------------------

/**
 * Default platform connect: the platform registers the live-ingestion hooks
 * BEFORE it connects, so no live event is lost.
 */
async function defaultConnectPlatform(ctx: BootstrapContext, platform: ChatPlatform): Promise<PlatformWiring> {
  const { createLiveIngestionDeps } = await import('./ingestion/live.js');
  const connection = await platform.connect(createLiveIngestionDeps(ctx, () => platform.selfUserId));
  return { platform, tracker: connection.tracker, destroy: () => connection.destroy() };
}

/**
 * Default ingestion step: the default connect already registered the live
 * hooks before the connection opened (Section 9.2 step 5 ordering).
 */
async function defaultBeginIngestion(_ctx: BootstrapContext, _discord: PlatformWiring): Promise<void> {}

/** Register the canonical admin command surface before readiness. */
async function defaultRegisterCommands(platform: ChatPlatform): Promise<void> {
  const result = await platform.registerCommands();
  if (!result.ok) throw new BootstrapError(result.message);
}

/** Enumerate real channels/threads and durably schedule configured history. */
async function defaultDiscoverAndBackfill(
  ctx: BootstrapContext,
  discord: PlatformWiring,
  record: PhaseRecorder,
): Promise<void> {
  const snapshot = ctx.configStore?.get() ?? ctx.snapshot;
  const platform = discord.platform;
  if (!platform || !snapshot) return;
  const { runStartupSync } = await import('./ingestion/sync.js');
  const descriptors = await platform.listChannels();
  const canManageThreads = descriptors.some((d) => d.capabilities?.canManageThreads === true);
  await runStartupSync({
    db: ctx.db,
    guildId: ctx.config.workspaceId,
    policy: snapshot.channelPolicy,
    channelPolicySource: ctx.config.channelPolicySource,
    now: ctx.now(),
    channels: descriptors,
    archiveSource: platform.threadDiscovery.mode === 'archive_scan' ? platform.threadDiscovery.archive : undefined,
    completeThreadSnapshot: platform.threadDiscovery.mode === 'complete_snapshot',
    canManageThreads,
    enqueueHistoricalBackfill: ctx.config.ingestion.fullHistory,
    record: (phase) => {
      if (phase === 'enumerate-channels') record('enumerate-channels');
      else if (phase === 'enqueue-backfill') record('enqueue-backfill');
      else if (phase === 'enumerate-archived-threads') record('enumerate-archived-threads');
      else if (phase === 'enqueue-archived-backfill') record('enqueue-archived-backfill');
    },
    logger: ctx.logger,
  });
}

async function defaultStartJobRuntime(ctx: BootstrapContext, discord: PlatformWiring): Promise<JobRuntimeWiring> {
  const { createProductionJobRuntime } = await import('./production-runtime.js');
  return createProductionJobRuntime(ctx, discord);
}
