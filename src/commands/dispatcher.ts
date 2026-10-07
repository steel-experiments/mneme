// ABOUTME: The platform-neutral `/mneme` route table (spec Section 27): one route per subcommand.
// ABOUTME: Each platform parses its own command payload into a CommandInvocation and calls runMnemeCommand.
import { statSync } from 'node:fs';
import { orgDayStartMs } from '../agent/cooldowns.js';
import type { BootstrapContext } from '../bootstrap.js';
import { authorizeAndAuditAdminAction } from '../policy/authorization.js';
import { handleStatusCommand, formatStatusReply } from './status.js';
import { handleModeCommand, formatModeReply } from './mode.js';
import { handleChannelsCommand, formatChannelsReply } from './channels.js';
import { handleSyncCommand, formatSyncReply } from './sync.js';
import { handlePauseCommand, handleResumeCommand, formatPauseReply, formatResumeReply } from './pause.js';
import { handleProposalsCommand, formatProposalsReply, handleApproveCommand, handleDismissCommand,
  formatApproveReply, formatDismissReply } from './proposals.js';
import { handleMemorySearchCommand, formatMemorySearchReply,
  handleMemoryGetCommand, formatMemoryGetReply } from './memory-search.js';
import { handleForgetMessageCommand } from './forget-message.js';
import { handleForgetUserCommand } from './forget-user.js';
import { handleArchiveCommand, type ArchiveSubcommand } from './archive.js';
import { createArchiveReader } from '../platform-archive/read.js';
import { handleDeletionCommand, type DeletionSubcommand } from './deletion.js';
import { handleReloadPolicyCommand, formatReloadPolicyReply } from './reload-policy.js';
import { handleIntegrityCheckCommand, formatIntegrityCheckReply } from './integrity.js';
import { handleMcpTokenCommand, formatMcpTokenReply, type McpTokenSubcommand } from './mcp-token.js';
import { handleInspectorTokenCommand, formatInspectorTokenReply, type InspectorTokenSubcommand } from './inspector-token.js';
import { readConfigCandidate } from '../config-reload.js';
import { mcpEndpointUrl, inspectorUrl } from '../config.js';
import { enqueue } from '../jobs/queue.js';
import { backupInventory } from '../db/backup.js';
import type { ApprovalPolicyRecheck, ReviewResolver } from '../review/workflow.js';
import { handleHistoricalCommand, formatHistoricalReply, type HistoricalSubcommand } from './historical.js';
import { handleDeepRecapCommand, formatDeepRecapReply, type DeepRecapSubcommand } from './deep-recap.js';
import { resolveCurrentChannelScope, resolveRetrievableChannelScope } from '../db/repositories/channels.js';
import type { PlatformHealthTracker } from '../platform/types.js';
import { MNEME_SUBCOMMANDS, MNEME_SUBCOMMAND_GROUPS } from './spec.js';

/** The parsed options of one `/mneme` call. */
export interface CommandOptionsReader {
  getSubcommand(): string;
  getSubcommandGroup(required: false): string | null;
  getString(name: string, required: true): string;
  getString(name: string, required?: boolean): string | null;
  getInteger(name: string, required?: boolean): number | null;
  getChannel(name: string): { id: string } | null;
  getUser(name: string, required: true): { id: string };
}

/** One `/mneme` call in neutral form. */
export interface CommandInvocation {
  /** The channel the command was used in. */
  channelId: string;
  options: CommandOptionsReader;
}

/** What the routes need from the runtime and the platform. */
export interface CommandRouteDeps {
  ctx: BootstrapContext;
  buildApprovalRecheck: (proposalId: string) => ApprovalPolicyRecheck;
  /** Live connection health for `status`. */
  tracker?: Pick<PlatformHealthTracker, 'snapshot'>;
  /** Edits the review card after an approve or dismiss command. */
  resolveReview?: ReviewResolver;
  /** Admin ids the actor's roles are checked against (Section 6.6). */
  adminIds: readonly string[];
}

/** Identity inputs shared by every `/mneme` subcommand route. */
export interface RouteBase {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
}

/** Context inputs shared by every `/mneme` subcommand route. */
interface RouteCommon {
  db: BootstrapContext['db'];
  /** Admin ids: Discord role ids, or Slack user ids (actor id stands in for roles). */
  adminRoleIds: readonly string[];
  nowMs: number;
}

interface RouteArgs {
  i: CommandInvocation;
  deps: CommandRouteDeps;
  base: RouteBase;
  common: RouteCommon;
}

/** A route resolves one subcommand (or subcommand group) to reply text. */
type RouteHandler = (args: RouteArgs) => string | Promise<string>;

function completeRouteMap(
  expectedNames: readonly string[],
  entries: readonly (readonly [string, RouteHandler])[],
  label: string,
): ReadonlyMap<string, RouteHandler> {
  const routes = new Map(entries);
  const expected = new Set(expectedNames);
  const missing = expectedNames.filter((name) => !routes.has(name));
  const extra = [...routes.keys()].filter((name) => !expected.has(name));
  const duplicateCount = entries.length - routes.size;
  if (missing.length > 0 || extra.length > 0 || duplicateCount > 0) {
    throw new Error(
      `Mneme ${label} route table mismatch: missing=${missing.join(',') || 'none'}; `
      + `extra=${extra.join(',') || 'none'}; duplicates=${duplicateCount}`,
    );
  }
  return routes;
}

function routeMcpToken({ i, deps, base, common }: RouteArgs): string {
  const { ctx } = deps;
  const outcome = handleMcpTokenCommand({ ...base, subcommand: i.options.getSubcommand() as McpTokenSubcommand,
    name: i.options.getString('name'), channels: i.options.getString('channels'),
    expiresDays: i.options.getInteger('expires-days'), tokenId: i.options.getString('id') },
    {
      ...common,
      mcpEnabled: ctx.config.mcp.enabled,
      endpointUrl: ctx.config.mcp.enabled ? mcpEndpointUrl(ctx.config.mcp) : null,
    });
  return formatMcpTokenReply(outcome);
}

function routeInspectorToken({ i, deps, base, common }: RouteArgs): string {
  const { ctx } = deps;
  const outcome = handleInspectorTokenCommand({ ...base, subcommand: i.options.getSubcommand() as InspectorTokenSubcommand,
    name: i.options.getString('name'),
    expiresDays: i.options.getInteger('expires-days'), tokenId: i.options.getString('id') },
    {
      ...common,
      inspectorEnabled: ctx.config.inspector.enabled,
      endpointUrl: ctx.config.inspector.enabled ? inspectorUrl(ctx.config.inspector) : null,
    });
  return formatInspectorTokenReply(outcome);
}

function routeHistorical({ i, deps, base, common }: RouteArgs): string {
  const { ctx } = deps;
  const outcome = handleHistoricalCommand({ ...base, subcommand: i.options.getSubcommand() as HistoricalSubcommand }, {
    ...common, campaignId: ctx.config.historicalMemory.campaignId,
  });
  return formatHistoricalReply(outcome);
}

function routeDeepRecap({ i, deps, base, common }: RouteArgs): string {
  const { ctx } = deps;
  const targetScope = resolveCurrentChannelScope(ctx.db, i.channelId);
  const secureReview = Boolean(ctx.config.reviewChannelId && i.channelId === ctx.config.reviewChannelId);
  const outcome = handleDeepRecapCommand({
    ...base,
    subcommand: i.options.getSubcommand() as DeepRecapSubcommand,
    invocationChannelId: i.channelId,
    days: i.options.getInteger('days'),
    topic: i.options.getString('topic'),
    channelId: i.options.getChannel('channel')?.id ?? null,
    budgetUsd: i.options.getInteger('budget-usd'),
    recapId: i.options.getString('id'),
  }, {
    ...common,
    maxWindowDays: ctx.config.deepRecap.maxWindowDays,
    maxBudgetUsd: ctx.config.deepRecap.maxBudgetUsd,
    enabled: ctx.config.deepRecap.enabled,
    isTargetAllowed: () => ctx.config.deepRecap.enabled && Boolean(targetScope)
      && targetScope?.visibility !== 'excluded'
      && (targetScope?.visibility !== 'review_only' || secureReview),
    isSourceAllowed: (sourceId) => {
      const source = resolveRetrievableChannelScope(ctx.db, sourceId);
      if (!source || !targetScope) return false;
      if (secureReview) return true;
      if (targetScope.visibility === 'org') return source.visibility === 'org';
      if (targetScope.visibility === 'restricted') {
        return source.visibility === 'org'
          || (source.visibility === 'restricted' && source.scopeChannelId === targetScope.scopeChannelId);
      }
      return false;
    },
  });
  return formatDeepRecapReply(outcome);
}

function routeStatus({ deps, base, common }: RouteArgs): string {
  const { ctx } = deps;
  const { nowMs } = common;
  const health = deps.tracker?.snapshot();
  let walSizeBytes: number | null = null;
  try { walSizeBytes = statSync(`${ctx.config.databasePath}-wal`).size; } catch { /* absent WAL */ }
  const modelRow = ctx.db.prepare(`
    SELECT MAX(started_at_ms) AS last_call,
           COALESCE(SUM(CASE WHEN started_at_ms >= ? THEN cost_usd ELSE 0 END), 0) AS spent_today,
           COALESCE(SUM(CASE WHEN started_at_ms >= ? THEN input_tokens ELSE 0 END), 0) AS in_today,
           COALESCE(SUM(CASE WHEN started_at_ms >= ? THEN output_tokens ELSE 0 END), 0) AS out_today,
           COALESCE(SUM(cost_usd), 0) AS spent_total,
           COALESCE(SUM(input_tokens), 0) AS in_total,
           COALESCE(SUM(output_tokens), 0) AS out_total
      FROM agent_runs`).get(
    ...Array(3).fill(orgDayStartMs(nowMs, ctx.config.organization.timezone)),
  ) as { last_call: number | null; spent_today: number; in_today: number; out_today: number;
    spent_total: number; in_total: number; out_total: number };
  let backup = { lastBackupAtMs: null as number | null, count: 0 };
  try { backup = backupInventory(ctx.config.backupDir); } catch (err) {
    ctx.logger.warn({
      event: 'backup.status_read_failed',
      err: err instanceof Error ? err.message : String(err),
    }, 'backup inventory could not be read for status');
  }
  return formatStatusReply(handleStatusCommand(base, { ...common, runtime: {
    nowMs,
    build: ctx.buildInfo,
    mode: ctx.config.mode,
    gateway: { connected: health?.status === 'ready', ready: health?.ready === true,
      lastEventAtMs: health?.lastEventAtMs ?? null, reconnectCount: health?.reconnects ?? 0 },
    model: { healthy: ctx.runtime.snapshot().modelCurrentlyHealthy, lastCallAtMs: modelRow.last_call,
      dailyBudgetUsd: ctx.config.llm.dailyBudgetUsd ?? null,
      today: { costUsd: Number(modelRow.spent_today), inputTokens: Number(modelRow.in_today),
        outputTokens: Number(modelRow.out_today) },
      allTime: { costUsd: Number(modelRow.spent_total), inputTokens: Number(modelRow.in_total),
        outputTokens: Number(modelRow.out_total) } },
    backup, walSizeBytes,
    ...(ctx.platformArchive ? { archive: ctx.platformArchive.summary } : {}),
    historicalCampaign: ctx.config.historicalMemory.campaignId
      ? { id: ctx.config.historicalMemory.campaignId,
          dayStartMs: orgDayStartMs(nowMs, ctx.config.organization.timezone) }
      : undefined,
  } }));
}

function routeMode({ i, deps, base, common }: RouteArgs): string {
  const { ctx } = deps;
  const review = (ctx.configStore?.get() ?? ctx.snapshot)?.channelPolicy.review_channel;
  const secureReviewReady = Boolean(
    ctx.config.reviewChannelId &&
    review?.id === ctx.config.reviewChannelId &&
    review.secure &&
    review.accepts_scopes.length > 0,
  );
  return formatModeReply(handleModeCommand({
    ...base,
    selection: i.options.getString('value', true),
    confirmation: i.options.getString('confirmation'),
  }, {
    ...common,
    configuredMode: ctx.configuredMode,
    currentMode: ctx.config.mode,
    secureReviewReady,
    applyMode: (mode) => { ctx.config.mode = mode; },
  }));
}

function routeApprove({ i, deps, base, common }: RouteArgs): Promise<string> {
  return handleApproveCommand({ ...base, proposalRef: i.options.getString('id', true) }, {
    ...common, buildRecheck: deps.buildApprovalRecheck, resolveReview: deps.resolveReview,
  }).then((outcome) => formatApproveReply(outcome));
}

function routeDismiss({ i, deps, base, common }: RouteArgs): Promise<string> {
  return handleDismissCommand({ ...base, proposalRef: i.options.getString('id', true) }, {
    ...common, resolveReview: deps.resolveReview,
  }).then((outcome) => formatDismissReply(outcome));
}

function routeReloadPolicy({ deps, base, common }: RouteArgs): string {
  const { ctx } = deps;
  if (!ctx.configStore) return 'Runtime policy reload is unavailable.';
  return formatReloadPolicyReply(handleReloadPolicyCommand(base, { ...common, store: ctx.configStore,
    candidate: readConfigCandidate({ channelPolicyPath: ctx.config.channelPolicyPath, promptDir: ctx.config.promptDir,
      channelPolicySource: ctx.config.channelPolicySource }),
    enqueueMaintenance: () => enqueue(ctx.db, { type: 'rescope_memories', payload: {}, uniqueKey: 'policy:rescope', now: common.nowMs }) }));
}

function routeBackup({ deps, base, common }: RouteArgs): string {
  const { ctx } = deps;
  const { nowMs } = common;
  const auth = authorizeAndAuditAdminAction(ctx.db, { memberRoleIds: base.memberRoleIds, adminRoleIds: common.adminRoleIds,
    guildId: base.guildId, actorUserId: base.actorUserId, action: 'backup', now: nowMs });
  if (!auth.authorized) return 'You are not authorized to create backups.';
  const result = enqueue(ctx.db, {
    type: 'backup_database',
    payload: { requesterUserId: base.actorUserId },
    uniqueKey: 'admin:backup',
    now: nowMs,
  });
  return result.enqueued
    ? `Online backup queued (job ${result.id.slice(0, 8)}). I’ll send you a DM when it completes.`
    : 'A backup is already queued or running. Check `/mneme status` for its state.';
}

function deletionDeps({ deps, common }: RouteArgs) {
  const { ctx } = deps;
  const review = (ctx.configStore?.get() ?? ctx.snapshot)?.channelPolicy.review_channel;
  const safeReview = review?.secure && review.id === ctx.config.reviewChannelId
    && ['org', 'restricted', 'review_only'].every((scope) => review.accepts_scopes.some((accepted) => accepted === scope));
  return { ...common, deletionApproverUserIds: ctx.config.deletionApproverUserIds,
    reviewChannelId: safeReview ? ctx.config.reviewChannelId : undefined,
    ...(ctx.platformArchive ? { archive: createArchiveReader({ db: ctx.platformArchive.db, liveDb: ctx.db,
      summary: ctx.platformArchive.summary, logger: ctx.logger }) } : {}) };
}

/** `/mneme archive …`: registered only when a platform archive is configured. */
function routeArchive(args: RouteArgs): string {
  return handleArchiveCommand({ ...args.base, invocationChannelId: args.i.channelId,
    subcommand: args.i.options.getSubcommand() as ArchiveSubcommand,
    name: args.i.options.getString('name'), id: args.i.options.getString('id') }, deletionDeps(args));
}

const groupRoutes = completeRouteMap(MNEME_SUBCOMMAND_GROUPS.map((group) => group.name), [
  ['deletion', (args) => handleDeletionCommand({ ...args.base, invocationChannelId: args.i.channelId,
    subcommand: args.i.options.getSubcommand() as DeletionSubcommand, requestId: args.i.options.getString('id'),
    confirmation: args.i.options.getString('confirmation') }, deletionDeps(args))],
  ['recap', routeDeepRecap],
  ['historical', routeHistorical],
  ['mcp-token', routeMcpToken],
  ['inspector-token', routeInspectorToken],
], 'group');

const commandRoutes = completeRouteMap(MNEME_SUBCOMMANDS.map((command) => command.name), [
  ['status', routeStatus],
  ['mode', routeMode],
  ['channels', ({ base, common }) => formatChannelsReply(handleChannelsCommand(base, common))],
  ['sync', ({ i, base, common }) => formatSyncReply(handleSyncCommand({ ...base, channelId: i.options.getChannel('channel')?.id ?? null }, common))],
  ['pause', ({ base, common }) => formatPauseReply(handlePauseCommand(base, common))],
  ['resume', ({ base, common }) => formatResumeReply(handleResumeCommand(base, common))],
  ['proposals', ({ base, common }) => formatProposalsReply(handleProposalsCommand(base, common))],
  ['approve', routeApprove],
  ['dismiss', routeDismiss],
  ['memory-search', ({ i, deps, base, common }) => formatMemorySearchReply(handleMemorySearchCommand({ ...base,
    query: i.options.getString('query', true), invocationChannelId: i.channelId }, { ...common, reviewChannelId: deps.ctx.config.reviewChannelId }))],
  ['memory-get', ({ i, deps, base, common }) => formatMemoryGetReply(handleMemoryGetCommand({ ...base,
    memoryId: i.options.getString('id', true), invocationChannelId: i.channelId }, { ...common, reviewChannelId: deps.ctx.config.reviewChannelId }))],
  ['forget-message', (args) => handleForgetMessageCommand({ ...args.base,
    invocationChannelId: args.i.channelId, messageId: args.i.options.getString('id', true) }, deletionDeps(args))],
  ['forget-user', (args) => handleForgetUserCommand({ ...args.base,
    invocationChannelId: args.i.channelId, userId: args.i.options.getUser('user', true).id }, deletionDeps(args))],
  ['reload-policy', routeReloadPolicy],
  ['backup', routeBackup],
  ['integrity-check', ({ base, common }) => formatIntegrityCheckReply(handleIntegrityCheckCommand(base, common))],
], 'command');

/** Content-free inventory used to keep the dispatcher aligned with command registration. */
export function listCommandDispatcherRouteNames(): {
  commands: string[];
  groups: string[];
} {
  return {
    commands: [...commandRoutes.keys()],
    groups: [...groupRoutes.keys()],
  };
}

/** Run one `/mneme` call and return the reply text. */
export async function runMnemeCommand(i: CommandInvocation, base: RouteBase, deps: CommandRouteDeps): Promise<string> {
  const common: RouteCommon = { db: deps.ctx.db, adminRoleIds: deps.adminIds, nowMs: deps.ctx.now() };
  // Read the subcommand first: an invocation without one throws here.
  const command = i.options.getSubcommand();
  const group = i.options.getSubcommandGroup(false);
  const route = (group === 'archive' ? routeArchive : undefined)
    ?? (group !== null ? groupRoutes.get(group) : undefined)
    ?? commandRoutes.get(command)
    ?? (() => 'Unknown Mneme command.');
  return route({ i, deps, base, common });
}
