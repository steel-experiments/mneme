import { fileURLToPath } from 'node:url';
import { type AppConfig, type AutonomyMode } from './config.js';
import { createLogger } from './logger.js';
import { createCounters, createIngestionObserver, type Counters } from './observability.js';
import { openDatabase, type DatabaseSync } from './db/database.js';
import { applyMigrations } from './db/migrations.js';
import { startHttpServer, type HttpServerHandle, type ProbeResult } from './http/server.js';
import { createLivenessProbe } from './http/health.js';
import { createStatusProvider } from './http/status.js';
import { ConfigStore, loadInitialSnapshot, type ConfigSnapshot } from './config-reload.js';
import { RuntimeState, getRuntimeModeOverride } from './runtime-state.js';
import { ShutdownCoordinator, createShutdownDeps, type ShutdownResult } from './shutdown.js';
import { setShutdownCoordinator } from './shutdown.js';
import type { Logger } from 'pino';
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

/** Handle to the connected Discord client and its teardown. */
export interface DiscordWiring {
  /** The discord.js client, when a real one was created. */
  client?: any;
  /** The health tracker, when one is in use. */
  tracker?: any;
  /** Disconnect the Gateway (shutdown step 7). */
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
  discordToken: string | undefined;
}

/** Injectable startup seams. Each has a real default; tests override them. */
export interface BootstrapSeams {
  /** Step 3: compile prompts and validate channel policy. */
  compilePromptsAndPolicy?: (ctx: BootstrapContext) => void | Promise<void>;
  /** Step 4: connect the Discord Gateway and return a teardown handle. */
  connectDiscord?: (ctx: BootstrapContext) => Promise<DiscordWiring> | DiscordWiring;
  /** Step 5: begin persisting live Gateway events. */
  beginIngestion?: (ctx: BootstrapContext, discord: DiscordWiring) => void | Promise<void>;
  /** Step 6 (pre-ready): register guild-scoped admin commands. */
  registerCommands?: (ctx: BootstrapContext, discord: DiscordWiring) => void | Promise<void>;
  /** Steps 7-10: enumerate channels/threads and enqueue backfill. */
  discoverAndBackfill?: (
    ctx: BootstrapContext,
    discord: DiscordWiring,
    record: PhaseRecorder,
  ) => void | Promise<void>;
  /** Start the bounded job worker and periodic scheduler. */
  startJobRuntime?: (ctx: BootstrapContext, discord: DiscordWiring | null) => JobRuntimeWiring | Promise<JobRuntimeWiring>;
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
  discord: DiscordWiring | null;
  jobs: JobRuntimeWiring | null;
  coordinator: ShutdownCoordinator;
  snapshot?: ConfigSnapshot;
  /** Run graceful shutdown (Section 34). */
  stop(): Promise<ShutdownResult>;
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
  http?: HttpServerHandle;
  discord?: DiscordWiring;
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
    discordToken: config.discord.token,
  };
  // Declared before HTTP starts so the status-provider closure is safe during
  // early startup (null) and begins reporting live tracker state after step 4.
  let discord: DiscordWiring | null = null;

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
        const { createDiscordIdentityClient } = await import('./platform/discord/oauth-identity.js');
        oauthRoutes = createOAuthRoutes({
          db,
          logger,
          now,
          identity: createDiscordIdentityClient({
            clientId: config.mcp.oauthDiscordClientId,
            clientSecret: config.mcp.oauthDiscordClientSecret,
            publicBaseUrl: config.mcp.publicBaseUrl,
            guildId: config.workspaceId,
          }),
          adminRoleIds: config.adminRoleIds,
          rateLimiter: unauthRateLimiter,
          context: {
            client: {
              clientId: config.mcp.oauthClientId,
              redirectUris: config.mcp.oauthRedirectUris,
            },
            resource: oauth.mcpResourceIdentifier(metadataConfig),
            publicBaseUrl: config.mcp.publicBaseUrl,
            discordClientId: config.mcp.oauthDiscordClientId,
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

  // Step 4: connect the Discord Gateway.
  if (seams.connectDiscord) {
    discord = await seams.connectDiscord(ctx);
  } else if (config.discord.token) {
    discord = await defaultConnectDiscord(ctx);
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
    } else if (discord.client) {
      await defaultRegisterCommands(ctx, discord);
      runtime.markCommandsRegistered();
    }
    runtime.markDiscordAuthenticated();
  }
  record(6, 'readyz_ready');

  let jobs: JobRuntimeWiring | null = null;

  // Steps 7-10: enumerate channels/threads and enqueue backfill. The seam records
  // each phase; the bootstrap maps it to the matching Section 9.2 milestone.
  if (discord && (seams.discoverAndBackfill || discord.client)) {
    const phaseRecorder: PhaseRecorder = (phase) => {
      record(STEP_BY_PHASE[phase], MILESTONE_BY_PHASE[phase]);
    };
    if (seams.discoverAndBackfill) await seams.discoverAndBackfill(ctx, discord, phaseRecorder);
    else await defaultDiscoverAndBackfill(ctx, discord, phaseRecorder);
  }

  // Start bounded workers only after startup discovery has populated channel
  // metadata and queued its initial durable work.
  if (seams.startJobRuntime) jobs = await seams.startJobRuntime(ctx, discord);
  else if (discord?.client) jobs = await defaultStartJobRuntime(ctx, discord);
  if (jobs) resources.jobs = jobs;

  // Wire graceful shutdown over the assembled singletons.
  const coordinator = new ShutdownCoordinator(
    createShutdownDeps({
      db,
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
 * Default Discord connect: instantiate the client, register ingestion handlers
 * BEFORE login so no live event is lost, then log in. Throws cleanly when no
 * token is configured.
 */
async function defaultConnectDiscord(ctx: BootstrapContext): Promise<DiscordWiring> {
  if (!ctx.discordToken) {
    throw new BootstrapError('DISCORD_TOKEN is not configured; cannot connect the Discord Gateway');
  }
  // Imported lazily so the bootstrap (and its tests) do not require discord.js
  // at module load unless the real default is actually used.
  const { createDiscordClient } = await import('./platform/discord/client.js');
  const { client, tracker } = createDiscordClient({
    token: ctx.discordToken,
    guildId: ctx.config.workspaceId,
    logger: ctx.logger,
    clock: ctx.now,
  });
  const wiring: DiscordWiring = {
    client,
    tracker,
    destroy: async () => {
      try {
        await client.destroy();
      } catch (err) {
        ctx.logger.warn({ event: 'discord.destroy_failed', err: (err as Error).message }, 'discord destroy failed');
      }
    },
  };
  // Register ingestion handlers BEFORE login so no live event is missed.
  await defaultBeginIngestion(ctx, wiring);
  // Seed the configured guild identity before login so an event arriving in the
  // narrow ready/fetch window cannot violate message foreign keys.
  const { upsertGuild } = await import('./db/repositories/workspaces.js');
  const seededAt = ctx.now();
  upsertGuild(ctx.db, {
    id: ctx.config.workspaceId,
    name: ctx.config.organization.name,
    ownerId: null,
    joinedAtMs: null,
    discoveredAtMs: seededAt,
    updatedAtMs: seededAt,
    rawJson: null,
  });
  await client.login(ctx.discordToken);
  const { assertExpectedGuild } = await import('./platform/discord/client.js');
  assertExpectedGuild([...client.guilds.cache.keys()], ctx.config.workspaceId);
  const guild = await client.guilds.fetch(ctx.config.workspaceId);
  const observedAt = ctx.now();
  upsertGuild(ctx.db, {
    id: guild.id,
    // Discord REST/cache hydration may transiently omit otherwise documented
    // guild fields. Never pass `undefined` across the SQLite boundary: Node's
    // built-in driver accepts strings/numbers/null, but rejects undefined.
    name: typeof guild.name === 'string' && guild.name.length > 0
      ? guild.name
      : ctx.config.organization.name,
    ownerId: typeof guild.ownerId === 'string' ? guild.ownerId : null,
    joinedAtMs: typeof guild.joinedTimestamp === 'number' ? guild.joinedTimestamp : null,
    discoveredAtMs: observedAt,
    updatedAtMs: observedAt,
    rawJson: ctx.config.ingestion.storeRawJson ? JSON.stringify(guild.toJSON()) : null,
  });
  return wiring;
}

const ingestionRegisteredClients = new WeakSet<object>();

/** Default ingestion: register the Section 9.3 gateway handlers on the client. */
async function defaultBeginIngestion(ctx: BootstrapContext, discord: DiscordWiring): Promise<void> {
  if (!discord.client) return;
  if (ingestionRegisteredClients.has(discord.client as object)) return;
  const { registerIngestionHandlers } = await import('./platform/discord/client.js');
  const { ingestEpisodeActivity } = await import('./episodes/builder.js');
  const { enqueueDirectAnswerForMention } = await import('./ingestion/mentions.js');
  const { getChannel } = await import('./db/repositories/channels.js');
  const { channelInputFromRaw } = await import('./platform/discord/gateway-events.js');
  const { requestIngestionRecovery } = await import('./db/repositories/ingestion-recovery.js');
  const { enqueue } = await import('./jobs/queue.js');
  const {
    reconcileStoredChannelPolicyReview,
    resolveObservedChannelPolicy,
  } = await import('./policy/channel-policy-review-service.js');
  const { isMnemeTestSurface } = await import('./ingestion/test-channels.js');
  const { mentionsMneme } = await import('./ingestion/mentions.js');
  const ing = ctx.config.ingestion;
  registerIngestionHandlers(discord.client, {
    db: ctx.db,
    opts: () => ({
      guildId: ctx.config.workspaceId,
      storeRawJson: ing.storeRawJson,
      retainEditHistory: ing.retainEditHistory,
      retainDeletedContent: ing.retainDeletedContent,
      attachmentMode: ing.attachmentMode,
      attachmentArchive: ing.attachmentMode === 'archive' || ing.attachmentMode === 'selective' ? {
        mode: ing.attachmentMode,
        maxBytes: ing.attachmentMaxBytes,
        mimeAllowlist: ing.attachmentMimeAllowlist,
        dataDir: ctx.config.dataDir,
      } : undefined,
      now: ctx.now(),
    }),
    shouldIngestMessage: (channelId, message) => {
      const isDirectMention = mentionsMneme(message.mentions, ctx.config.discord.applicationId);
      const channel = getChannel(ctx.db, channelId);
      if (channel) {
        if (isMnemeTestSurface(ctx.db, channelId)) {
          if (isDirectMention) {
            ctx.logger.info({ event: 'discord.direct_mention_received', channelId, testOnly: true }, 'direct mention accepted in test-only channel');
          }
          return isDirectMention;
        }
        if (isDirectMention) {
          ctx.logger.info({ event: 'discord.direct_mention_received', channelId, testOnly: false }, 'direct mention accepted');
        }
        return channel.ingest_enabled === 1 && channel.visibility_class !== 'excluded';
      }
      const policy = ctx.configStore?.get().channelPolicy ?? ctx.snapshot?.channelPolicy;
      const explicit = policy?.channels.get(channelId);
      const rule = explicit ?? policy?.default;
      return rule ? rule.ingest && rule.visibility !== 'excluded' : false;
    },
    onMissingDependency: ({ reason, channelId, messageId }) => {
      const now = ctx.now();
      const recovery = requestIngestionRecovery(ctx.db, {
        guildId: ctx.config.workspaceId, channelId, messageId, reason, now,
      });
      enqueue(ctx.db, {
        type: 'recover_message', payload: { recoveryId: recovery.id, generation: recovery.generation },
        uniqueKey: `recover-message:${recovery.id}`, priority: 20, now,
      });
      return { recoveryId: recovery.id, generation: recovery.generation };
    },
    observer: createIngestionObserver(ctx.counters),
    onMessageCreate: (message) => {
      const observedAt = ctx.now();
      if (!isMnemeTestSurface(ctx.db, message.channelId)) {
        ingestEpisodeActivity(
          message,
          { mnemeId: ctx.config.discord.applicationId },
          {
            db: ctx.db,
            guildId: ctx.config.workspaceId,
            now: observedAt,
            timing: {
              quietSeconds: ctx.config.episodes.quietSeconds,
              maxMessages: ctx.config.episodes.maxMessages,
              maxMinutes: ctx.config.episodes.maxMinutes,
            },
          },
        );
      }
      const direct = enqueueDirectAnswerForMention(message, {
        db: ctx.db,
        mnemeId: ctx.config.discord.applicationId,
        enabled: ctx.config.directAnswerEnabled,
        now: observedAt,
      });
      if (direct.mention) {
        ctx.logger.info({ event: 'discord.direct_answer_queued', channelId: message.channelId,
          messageId: message.id, enqueued: direct.enqueued }, 'direct-answer scheduling evaluated');
      }
    },
    resolveChannelInput: (raw, guildId, now) => {
      const input = channelInputFromRaw(raw, guildId, now);
      if (!input) return null;
      const policy = ctx.configStore?.get().channelPolicy ?? ctx.snapshot?.channelPolicy;
      if (!policy) return { ...input, ingestEnabled: false, visibilityClass: 'excluded', allowInterventions: false };
      const resolved = resolveObservedChannelPolicy(ctx.db, policy, {
        id: input.id,
        guildId,
        parentId: input.parentId,
        isThread: input.isThread,
        type: input.type,
      }, { channelPolicySource: ctx.config.channelPolicySource });
      const existing = getChannel(ctx.db, input.id);
      return {
        ...input,
        ingestEnabled: resolved.rule.ingest,
        visibilityClass: resolved.rule.visibility,
        allowInterventions: resolved.rule.allow_interventions,
        permissionFingerprint: existing?.permission_fingerprint ?? null,
      };
    },
    onChannelChange: (event, channelId) => {
      const config = ctx.configStore?.get();
      const policy = config?.channelPolicy ?? ctx.snapshot?.channelPolicy;
      if (!policy) return;
      const result = reconcileStoredChannelPolicyReview(
        ctx.db,
        policy,
        channelId,
        ctx.now(),
        {
          ...(event === 'delete' ? { deleted: true } : event === 'create' ? { forceReview: true } : {}),
          channelPolicySource: config?.channelPolicySource,
        },
      );
      if (result.created || result.superseded || result.enqueued) {
        ctx.logger.info({
          event: 'channel_policy_review.reconciled',
          channelId,
          created: result.created,
          superseded: result.superseded,
          enqueued: result.enqueued,
        }, 'channel policy review reconciled');
      }
    },
    tracker: discord.tracker,
    logger: ctx.logger,
  });
  ingestionRegisteredClients.add(discord.client as object);
}

/** Register the canonical guild-scoped slash-command surface before readiness. */
async function defaultRegisterCommands(ctx: BootstrapContext, discord: DiscordWiring): Promise<void> {
  if (!discord.client?.rest) {
    throw new BootstrapError('Discord client has no REST adapter; commands cannot be registered');
  }
  const { registerGuildCommands } = await import('./platform/discord/commands.js');
  const result = await registerGuildCommands({
    rest: discord.client.rest,
    applicationId: ctx.config.discord.applicationId,
    guildId: ctx.config.workspaceId,
  });
  if (!result.ok) {
    throw new BootstrapError(`Discord command registration failed: ${result.error}`);
  }
}

/** Enumerate real Discord channels/threads and durably schedule configured history. */
async function defaultDiscoverAndBackfill(
  ctx: BootstrapContext,
  discord: DiscordWiring,
  record: PhaseRecorder,
): Promise<void> {
  const snapshot = ctx.configStore?.get() ?? ctx.snapshot;
  if (!discord.client || !snapshot) return;
  const { fetchDiscoveryDescriptors, createDiscordThreadArchiveSource } = await import('./platform/discord/production-adapters.js');
  const { runStartupSync } = await import('./ingestion/sync.js');
  const descriptors = await fetchDiscoveryDescriptors(discord.client, ctx.config.workspaceId);
  const canManageThreads = descriptors.some((d) => d.capabilities?.canManageThreads === true);
  await runStartupSync({
    db: ctx.db,
    guildId: ctx.config.workspaceId,
    policy: snapshot.channelPolicy,
    channelPolicySource: ctx.config.channelPolicySource,
    now: ctx.now(),
    channels: descriptors,
    archiveSource: createDiscordThreadArchiveSource(discord.client),
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

async function defaultStartJobRuntime(ctx: BootstrapContext, discord: DiscordWiring): Promise<JobRuntimeWiring> {
  const { createProductionJobRuntime } = await import('./production-runtime.js');
  return createProductionJobRuntime(ctx, discord);
}
