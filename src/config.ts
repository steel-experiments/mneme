import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger } from './logger.js';
import { CLAUDE_HOSTED_REDIRECT_URI, checkRedirectUri } from './mcp/oauth/client.js';
import {
  OAUTH_AUTHORIZE_PATH,
  OAUTH_TOKEN_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_AUTHORIZATION_SERVER_PATH,
  protectedResourceMetadataPath,
} from './mcp/oauth/metadata.js';
import { DEFAULT_SETTLE_SECONDS, DEFAULT_SETTLE_MAX_MINUTES } from './episodes/settle.js';
import { isDiscordId } from './platform/ids.js';
import { isSlackChannelId, isSlackTeamId, isSlackUserId } from './platform/slack/ids.js';

/**
 * Typed application configuration (Sections 14, 35).
 *
 * Precedence (highest wins):
 *   1. immutable security constraints enforced in source (this module);
 *   2. environment-variable overrides;
 *   3. config/mneme.yml;
 *   4. documented defaults.
 *
 * On native runs a ./.env file seeds keys the real environment does not set; a
 * real environment variable always wins over the file (see applyDotEnv).
 *
 * Secrets (Discord token, provider API key, HTTP admin token) come only from the
 * environment. They are never read from YAML and never embedded in it.
 */

export type NodeEnv = 'production' | 'development' | 'test';
export type LlmProvider = 'openai' | 'anthropic' | 'google';
export type AutonomyMode = 'observe' | 'review' | 'autonomous';
export type AttachmentMode = 'none' | 'metadata' | 'archive' | 'selective';
export type ThinkingLevel = 'low' | 'medium' | 'high';
/**
 * Where the initial channel policy comes from: 'basic' builds it from the
 * selection environment variables (the default), 'file' loads
 * channel-policy.yml. Live policy reload applies to file mode only.
 */
export type ChannelPolicySource = 'basic' | 'file';

/** Discord snowflake: 17–20 decimal digits. */

const PROVIDER_API_KEY: Record<LlmProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
};

/** Error raised for any configuration problem. Names the setting without echoing its value. */
export class ConfigError extends Error {
  readonly setting: string | undefined;
  constructor(message: string, setting?: string) {
    super(setting ? `${setting}: ${message}` : message);
    this.name = 'ConfigError';
    this.setting = setting;
  }
}

/** Chat platforms a deployment can run on (plan 002 decision 1). */
export const PLATFORM_IDS = ['discord', 'slack'] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export interface DiscordConfig {
  token: string;
  applicationId: string;
}

/** Slack credentials and admins (spec Section 6.7). Present only when `MNEME_PLATFORM=slack`. */
export interface SlackConfig {
  botToken: string;
  appToken: string;
  /** Slack user ids allowed to run admin operations (Slack has no roles). */
  adminUserIds: string[];
}

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  triageModel: string | undefined;
  baseUrl: string | undefined;
  /** Resolved from the provider-specific env var; never logged. */
  apiKey: string;
  /**
   * Admission-control ceiling for model spend per organization day (default 2
   * USD): Mneme stops starting new paid runs above it. Null means no cap
   * (`LLM_DAILY_BUDGET_USD=unlimited`). This is not a provider billing
   * ceiling, and hosting charges are separate.
   */
  dailyBudgetUsd: number | null;
}

export interface IngestionConfig {
  /**
   * Initial import scope; there is no default, so the operator must choose.
   * true imports all reachable history for the selected channels; false means
   * new messages onward. false is not a hard historical boundary: some sync
   * paths may still touch older rows.
   */
  fullHistory: boolean;
  backfillConcurrency: number;
  reconcileIntervalMinutes: number;
  reconcileOverlapHours: number;
  reconcileMaxPagesPerRun: number;
  threadDiscoveryIntervalMinutes: number;
  storeRawJson: boolean;
  retainEditHistory: boolean;
  retainDeletedContent: boolean;
  attachmentMode: AttachmentMode;
  attachmentMaxBytes: number;
  attachmentMimeAllowlist: string[];
}

export interface EpisodeConfig {
  quietSeconds: number;
  maxMessages: number;
  maxMinutes: number;
  /** Quiet seconds a conversation needs before its review may run (Section 11.8). */
  settleSeconds: number;
  /** Upper bound on holding a review for a busy conversation (Section 11.8). */
  settleMaxMinutes: number;
}

export interface HistoricalMemoryConfig {
  enabled: boolean;
  /** Empty means every eligible org channel; otherwise only these channel IDs. */
  channelIds: string[];
  batchMessages: number;
  maxPendingReviews: number;
  dailyBudgetUsd: number;
  /** A configured id enables the bounded campaign path; absent retains legacy behavior. */
  campaignId: string | undefined;
  direction: 'newest_first';
  fromAtMs: number | undefined;
  toAtMs: number | undefined;
  model: string | undefined;
  thinkingLevel: ThinkingLevel;
  totalBudgetUsd: number;
}

/**
 * Optional deep-recap feature (default off). The two budgets are subordinate
 * caps, active only while the feature is enabled; LLM_DAILY_BUDGET_USD stays
 * the global admission budget that gates all model spend.
 */
export interface DeepRecapConfig {
  enabled: boolean;
  maxWindowDays: number;
  maxBudgetUsd: number;
  dailyBudgetUsd: number;
}

export interface AgentConfig {
  maxConcurrency: number;
  timeoutSeconds: number;
  maxToolCalls: number;
  maxRetrievedCharacters: number;
  thinkingLevel: ThinkingLevel;
}

export interface EpisodeShadowConfig {
  enabled: boolean;
  /** Candidate model ID. Undefined reuses the authoritative primary model. */
  model: string | undefined;
  thinkingLevel: ThinkingLevel;
  maxRuns: number;
}

export interface InterventionConfig {
  threshold: number;
  minEvidenceStrength: number;
  minConfidence: number;
  channelCooldownMinutes: number;
  globalDailyLimit: number;
  maxMessageCharacters: number;
  /**
   * Proactive attention window in days (Section 12.7). A normal proactive
   * trigger is a human message created within this window of now. One material
   * revision of a subject earns at most one speaking opportunity; an explicit
   * human deadline may reopen an unconsumed revision once when it becomes due.
   */
  attentionWindowDays: number;
}

export interface MemoryConfig {
  minimumConfidence: number;
  minimumImportance: number;
  followupHorizonDays: number;
  followupMaxMessages: number;
  /**
   * Deprecated: parsed for backward compatibility with existing configuration
   * files, but no longer controls notification admission. Repeated proactive
   * speech is bounded by attention consumption per material revision
   * (Section 12.7), not by a reminder interval.
   */
  scheduledReviewReminderDays: number;
  /**
   * Deprecated: parsed for backward compatibility with existing configuration
   * files, but no longer controls notification admission or memory status.
   * Attention opportunities expire by their own windows (Section 12.7); the
   * durable memory lifecycle keeps its semantic states.
   */
  stalenessHorizonDays: number;
  requireEvidence: boolean;
  reviewPredictions: boolean;
  reviewAssumptions: boolean;
}

export interface MaintenanceConfig {
  backupEnabled: boolean;
  backupIntervalHours: number;
  backupRetentionDays: number;
  /** Terminal job rows older than this are pruned by the maintenance job (Section 10). */
  jobsRetentionDays: number;
  pragmaOptimizeIntervalHours: number;
  shutdownTimeoutSeconds: number;
}

export interface McpConfig {
  enabled: boolean;
  path: string;
  /**
   * Origin external clients reach the endpoint on, without a trailing slash
   * (for example `https://mneme.example.com`). Set from `MCP_PUBLIC_URL`,
   * or from the Railway public domain, or `http://localhost:PORT` as last
   * resort. {@link mcpEndpointUrl} joins it with {@link McpConfig.path}.
   */
  publicBaseUrl: string;
  rateLimitPerMinute: number;
  /** Shared budget of failed authentications per minute; excess returns 429. */
  unauthRateLimitPerMinute: number;
  toolListTtlMs: number;
  /**
   * Serve the OAuth discovery documents and point `401` responses at them
   * (`MCP_OAUTH_ENABLED`, default false). Off, the endpoint behaves exactly as
   * the admin-issued-bearer-token deployment does: the well-known paths are
   * `404` like any unknown route and the challenge is a bare `Bearer`. On, a
   * client can discover where to sign in, so it must not be enabled before the
   * authorization and token endpoints answer.
   */
  oauthEnabled: boolean;
  /**
   * The single OAuth client id an operator issues and pastes into the connector
   * dialog (`MCP_OAUTH_CLIENT_ID`). Required when {@link McpConfig.oauthEnabled}
   * is set, empty otherwise. An identifier, not a credential — it travels in
   * redirect URLs — but an unguessable value keeps a stranger who finds the
   * endpoint from starting a flow at all.
   */
  oauthClientId: string;
  /**
   * Redirect URIs the client may return to (`MCP_OAUTH_REDIRECT_URIS`, comma
   * separated). Defaults to the callback Anthropic publishes for the hosted
   * Claude surfaces, which is the same for web, Desktop, and mobile. Compared by
   * exact string match at authorization time.
   */
  oauthRedirectUris: readonly string[];
  /**
   * The identity provider's OAuth client id: `DISCORD_OAUTH_CLIENT_ID` on
   * Discord, `SLACK_OAUTH_CLIENT_ID` on Slack. The active chat platform is the
   * identity provider for MCP sign-ins: Mneme has no password to check and
   * instead asks the platform who the person is. Public, unlike
   * {@link McpConfig.oauthProviderClientSecret}. The keys of the other platform
   * are ignored.
   */
  oauthProviderClientId: string;
  /**
   * The identity provider's OAuth client secret: `DISCORD_OAUTH_CLIENT_SECRET`
   * or `SLACK_OAUTH_CLIENT_SECRET`. Used once per sign-in, server to server, to
   * exchange the provider's authorization code. Never logged and never sent to
   * a browser.
   */
  oauthProviderClientSecret: string;
}

/**
 * The read-only admin web surface (Section 32.6). Disabled by default: when
 * {@link InspectorConfig.enabled} is false every inspector path returns the
 * standard `404`, identical to an unknown route, so the surface's existence is
 * not discoverable.
 */
export interface InspectorConfig {
  enabled: boolean;
  /** Mount path; must start with `/`. Default `/inspector`. */
  path: string;
  /** Origin prefix for the URL echoed by `/mneme inspector-token create`. */
  publicBaseUrl: string;
  /** Per-token request ceiling for authenticated traffic. */
  rateLimitPerMinute: number;
  /** Shared budget of failed authentications per minute; excess returns 429. */
  unauthRateLimitPerMinute: number;
}

export interface PersonalityVoice {
  warmth: string;
  directness: string;
  verbosity: string;
  humor: string;
  emoji: string;
}

export interface PersonalityConfig {
  traits: readonly string[];
  avoid: readonly string[];
  voice: PersonalityVoice;
}

/**
 * A frozen, read-only Mneme database from another platform's deployment
 * (`MNEME_ARCHIVE_PATH`, `MNEME_ARCHIVE_PLATFORM`; plan 011).
 */
export interface ArchiveConfig {
  /** Absolute path of the archive file on the volume. */
  path: string;
  /** The platform whose deployment wrote the archive. */
  platform: PlatformId;
}

/**
 * The complete runtime configuration object. One typed value represents the
 * whole Section 35 contract plus the personality defaults from Section 14.
 */
export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  dataDir: string;
  databasePath: string;
  /** Backup destination; configurable independently for a separate volume. */
  backupDir: string;
  logLevel: string;
  promptDir: string;
  /** Directory of Mneme's own Markdown documentation (Sections 22.5–22.7). */
  docsDir: string;
  /** Optional canonical HTTPS base for host-built public documentation links. */
  docsPublicUrl: string | undefined;
  mnemeConfigPath: string;
  channelPolicyPath: string;
  /** Resolved CHANNEL_POLICY_SOURCE; 'basic' never reads {@link AppConfig.channelPolicyPath}. */
  channelPolicySource: ChannelPolicySource;
  /** The one Discord server or Slack workspace that this deployment serves. */
  /** The active chat platform (`MNEME_PLATFORM`). */
  platform: PlatformId;
  workspaceId: string;
  /** Present only when `MNEME_PLATFORM=discord`. */
  discord?: DiscordConfig;
  /** Present only when `MNEME_PLATFORM=slack`. */
  slack?: SlackConfig;
  /** The read-only archive of another platform (plan 011); absent when not configured. */
  archive?: ArchiveConfig;
  llm: LlmConfig;
  organization: { name: string; timezone: string };
  agent: { name: string; role: string };
  personality: PersonalityConfig;
  mode: AutonomyMode;
  reviewChannelId: string | undefined;
  adminRoleIds: string[];
  deletionApproverUserIds: string[];
  httpAdminToken: string | undefined;
  ingestion: IngestionConfig;
  episodes: EpisodeConfig;
  historicalMemory: HistoricalMemoryConfig;
  deepRecap: DeepRecapConfig;
  agentRuntime: AgentConfig;
  episodeShadow: EpisodeShadowConfig;
  intervention: InterventionConfig;
  memory: MemoryConfig;
  maintenance: MaintenanceConfig;
  mcp: McpConfig;
  /** Inspector web surface (Section 32.6). */
  inspector: InspectorConfig;
  directAnswerEnabled: boolean;
}

/** Subset of mneme.yml that influences operational config (Section 14). */
interface MnemeYaml {
  organization?: { name?: string; timezone?: string };
  agent?: { name?: string; role?: string };
  personality?: {
    traits?: unknown;
    avoid?: unknown;
    voice?: Record<string, unknown>;
  };
  intervention?: Record<string, unknown>;
  memory?: Record<string, unknown>;
}

export const DEFAULTS = {
  nodeEnv: 'production' as NodeEnv,
  port: 3000,
  // Native-run paths are relative to the working directory. The Docker image
  // bakes the absolute /app values as ENV, so containers are not affected.
  dataDir: './data',
  databasePath: './data/mneme.sqlite',
  logLevel: 'info',
  promptDir: './prompts',
  docsDir: './docs',
  mnemeConfigPath: './config/mneme.yml',
  channelPolicyPath: './config/channel-policy.yml',
  // Starter LLM defaults for a basic install; validation still applies when set.
  llmProvider: 'openai',
  llmModel: 'gpt-5.6-terra',
  llmDailyBudgetUsd: 2,
  organizationName: 'Your Company',
  organizationTimezone: 'UTC',
  agentName: 'Mneme',
  agentRole: 'organizational memory and constructive dissenter',
  personality: {
    traits: [
      'calm',
      'concise',
      'candid',
      'evidence-seeking',
      'skeptical without cynicism',
      'respectful',
      'hierarchy-independent',
    ],
    avoid: [
      'theatrical warnings',
      'smugness',
      'sarcasm',
      'management jargon',
      'generic summaries',
      'inferred motives',
      'employee scoring',
      'interpersonal adjudication',
    ],
    voice: {
      warmth: 'medium',
      directness: 'high',
      verbosity: 'concise',
      humor: 'rare',
      emoji: 'never',
    },
  },
  intervention: {
    threshold: 0.78,
    minEvidenceStrength: 0.65,
    minConfidence: 0.65,
    channelCooldownMinutes: 180,
    globalDailyLimit: 5,
    maxMessageCharacters: 1800,
    attentionWindowDays: 7,
  },
  memory: {
    minimumConfidence: 0.55,
    minimumImportance: 0.6,
    followupHorizonDays: 14,
    followupMaxMessages: 20,
    scheduledReviewReminderDays: 7,
    stalenessHorizonDays: 45,
    requireEvidence: true,
    reviewPredictions: true,
    reviewAssumptions: true,
  },
} as const;

export interface LoadConfigOptions {
  /**
   * Environment source. Defaults to process.env, which is layered over `./.env`
   * (see `envFileDir`). An injected object is an explicit contract: it is read
   * as given, and no `.env` file is loaded unless `envFileDir` is also set.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Directory whose `.env` file fills the keys the environment source leaves
   * undefined; the source object is modified in place with those keys, so a
   * key it already holds always wins. Default: the current working directory
   * when `env` is omitted, no file at all when `env` is injected.
   */
  envFileDir?: string;
  /** mneme.yml text. If omitted, the file is read from mnemeConfigPath. */
  yamlText?: string;
  /**
   * Review-channel facts resolved from channel-policy.yml, used to cross-check
   * the env review channel and the secure/accessible requirement.
   */
  channelPolicyReview?: { id?: string; secure?: boolean };
  /** Override “now” for deterministic tests. */
  now?: () => number;
}

// ---------- env parsing helpers ----------

function env(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`expected a boolean (true/false), got "${raw}"`);
}

function parseInt_(raw: string | undefined, fallback: number, setting: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`expected a non-negative integer, got "${raw}"`, setting);
  }
  return n;
}

function parseNumber(raw: string | undefined, fallback: number, setting: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`expected a non-negative number, got "${raw}"`, setting);
  }
  return n;
}

/**
 * Global admission budget for model spend per organization day: unset or blank
 * gives the 2 USD default, `unlimited` (any case) gives null (no cap), and any
 * other value must be a non-negative number (`0` admits no paid run).
 */
export function parseDailyBudget(raw: string | undefined): number | null {
  if (raw !== undefined && raw.trim().toLowerCase() === 'unlimited') return null;
  return parseNumber(raw, DEFAULTS.llmDailyBudgetUsd, 'LLM_DAILY_BUDGET_USD');
}

function parseOptionalDateMs(raw: string | undefined, setting: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new ConfigError('expected an ISO-8601 timestamp', setting);
  return parsed;
}

function parseEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  setting: string,
): T {
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw as T)) {
    throw new ConfigError(`expected one of ${allowed.join('|')}, got "${raw}"`, setting);
  }
  return raw as T;
}

function parseSnowflake(raw: string | undefined, setting: string): string {
  if (raw === undefined || raw === '') {
    throw new ConfigError('required setting is missing', setting);
  }
  if (!isDiscordId(raw)) {
    throw new ConfigError('expected a Discord snowflake (17–20 digits)', setting);
  }
  return raw;
}

type IdKind = 'channel' | 'user' | 'role';

/** Parse one id in the format of the active platform. */
function parseId(raw: string | undefined, setting: string, platform: PlatformId, kind: IdKind): string {
  if (platform === 'discord') return parseSnowflake(raw, setting);
  if (raw === undefined || raw === '') throw new ConfigError('required setting is missing', setting);
  const ok = kind === 'channel' ? isSlackChannelId(raw) : kind === 'user' ? isSlackUserId(raw) : false;
  if (!ok) throw new ConfigError(`expected a Slack ${kind} id`, setting);
  return raw;
}

/** Parse a comma-separated id list in the format of the active platform. */
function parseIdList(raw: string | undefined, setting: string, platform: PlatformId, kind: IdKind): string[] {
  if (platform === 'discord') return parseSnowflakeList(raw, setting);
  if (raw === undefined || raw === '') return [];
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const part of parts) parseId(part, setting, platform, kind);
  return parts;
}


/** Parse the credentials and workspace of the active platform (spec Sections 6, 6.7). */
function parsePlatformCredentials(
  e: NodeJS.ProcessEnv,
  platform: PlatformId,
): { discord?: DiscordConfig; slack?: SlackConfig; workspaceId: string } {
  if (platform === 'discord') {
    const token = env(e, 'DISCORD_TOKEN');
    if (!token) throw new ConfigError('required setting is missing', 'DISCORD_TOKEN');
    const applicationId = parseSnowflake(env(e, 'DISCORD_APPLICATION_ID'), 'DISCORD_APPLICATION_ID');
    const workspaceId = parseSnowflake(env(e, 'DISCORD_GUILD_ID'), 'DISCORD_GUILD_ID');
    return { discord: { token, applicationId }, workspaceId };
  }
  const botToken = env(e, 'SLACK_BOT_TOKEN');
  if (!botToken) throw new ConfigError('required setting is missing', 'SLACK_BOT_TOKEN');
  if (!botToken.startsWith('xoxb-')) throw new ConfigError('expected a bot token that starts with xoxb-', 'SLACK_BOT_TOKEN');
  const appToken = env(e, 'SLACK_APP_TOKEN');
  if (!appToken) throw new ConfigError('required setting is missing', 'SLACK_APP_TOKEN');
  if (!appToken.startsWith('xapp-')) throw new ConfigError('expected an app-level token that starts with xapp-', 'SLACK_APP_TOKEN');
  const teamId = env(e, 'SLACK_TEAM_ID');
  if (!teamId) throw new ConfigError('required setting is missing', 'SLACK_TEAM_ID');
  if (!isSlackTeamId(teamId)) throw new ConfigError('expected a Slack team id', 'SLACK_TEAM_ID');
  const adminUserIds = parseIdList(env(e, 'MNEME_ADMIN_USER_IDS'), 'MNEME_ADMIN_USER_IDS', platform, 'user');
  if (adminUserIds.length === 0) throw new ConfigError('at least one Slack user id is required', 'MNEME_ADMIN_USER_IDS');
  if (env(e, 'MNEME_ADMIN_ROLE_IDS')) {
    throw new ConfigError('Slack has no roles; list admins in MNEME_ADMIN_USER_IDS', 'MNEME_ADMIN_ROLE_IDS');
  }
  return { slack: { botToken, appToken, adminUserIds }, workspaceId: teamId };
}

/**
 * Parse the registered redirect URIs, defaulting to the hosted Claude callback.
 * Each entry is checked here so a malformed or insecure redirect stops the
 * process at boot rather than failing a user mid-sign-in.
 */
function parseRedirectUris(raw: string | undefined): readonly string[] {
  const parts =
    raw === undefined || raw.trim() === ''
      ? [CLAUDE_HOSTED_REDIRECT_URI]
      : raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  for (const part of parts) {
    const problem = checkRedirectUri(part);
    if (problem !== null) {
      throw new ConfigError(`"${part}" is rejected: ${problem}`, 'MCP_OAUTH_REDIRECT_URIS');
    }
  }
  return parts;
}

function parseSnowflakeList(raw: string | undefined, setting: string): string[] {
  if (raw === undefined || raw === '') return [];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const part of parts) {
    if (!isDiscordId(part)) {
      throw new ConfigError(`list contains a non-snowflake value`, setting);
    }
  }
  return parts;
}

/**
 * Parse `.env` text into ordered KEY=VALUE pairs. Rules:
 *   - a leading UTF-8 byte order mark is dropped; LF and CRLF line ends both work;
 *   - blank lines and `#` comment lines are skipped;
 *   - an optional `export ` prefix before the key is accepted;
 *   - keys and values are trimmed;
 *   - matching surrounding single or double quotes are removed from a value,
 *     with no escape processing of the text between them;
 *   - in an unquoted value, an inline comment (whitespace followed by `#`) is
 *     removed;
 *   - lines without `=`, or with a key that is not a plain identifier, are
 *     ignored.
 */
export function parseDotEnv(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  for (const rawLine of body.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    pairs.push([key, parseDotEnvValue(line.slice(eq + 1).trim())]);
  }
  return pairs;
}

/** Remove matching surrounding quotes, or an inline comment from an unquoted value. */
function parseDotEnvValue(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  const comment = value.search(/\s#/);
  return comment === -1 ? value : value.slice(0, comment).trimEnd();
}

/**
 * Apply `.env` pairs onto a target environment. A key that is already present
 * in the target is never overwritten, so the real environment always wins.
 */
export function applyDotEnv(target: NodeJS.ProcessEnv, text: string): void {
  for (const [key, value] of parseDotEnv(text)) {
    if (target[key] === undefined) target[key] = value;
  }
}

/**
 * Read `<dir>/.env` and fill the keys the target environment does not define,
 * then return the target. A missing file changes nothing; an unreadable one
 * surfaces its error at startup. An existing key is never overwritten, so the
 * environment source (real or injected) always wins over the file.
 */
export function applyDotEnvFile(target: NodeJS.ProcessEnv, dir: string = '.'): NodeJS.ProcessEnv {
  applyDotEnv(target, readTextFile(join(dir, '.env')));
  return target;
}

/**
 * Resolve the environment source for a loader: process.env layered over
 * `./.env` by default; an injected env as given, layered over `.env` only when
 * the caller names its directory (see {@link LoadConfigOptions}).
 */
function resolveEnv(options: LoadConfigOptions): NodeJS.ProcessEnv {
  if (options.env === undefined) return applyDotEnvFile(process.env, options.envFileDir ?? '.');
  return options.envFileDir === undefined ? options.env : applyDotEnvFile(options.env, options.envFileDir);
}

/**
 * Derive the backup directory from DATA_DIR. Plain concatenation (not join)
 * keeps the caller's path form, so './data' becomes './data/backups' and
 * '/app/data' becomes '/app/data/backups'.
 */
function deriveBackupDir(dataDir: string): string {
  return dataDir.endsWith('/') ? `${dataDir}backups` : `${dataDir}/backups`;
}

/**
 * Parse the optional read-only archive. Both settings or neither. The archive
 * comes from another platform, and it must not be the live database or sit in
 * the backup directory, where backup retention could delete it.
 */
function parseArchive(
  e: NodeJS.ProcessEnv,
  platform: PlatformId,
  databasePath: string,
  backupDir: string,
): ArchiveConfig | undefined {
  const path = env(e, 'MNEME_ARCHIVE_PATH');
  const platformRaw = env(e, 'MNEME_ARCHIVE_PLATFORM');
  if (path === undefined && platformRaw === undefined) return undefined;
  if (platformRaw === undefined) throw new ConfigError('required when MNEME_ARCHIVE_PATH is set', 'MNEME_ARCHIVE_PLATFORM');
  if (path === undefined) throw new ConfigError('required when MNEME_ARCHIVE_PLATFORM is set', 'MNEME_ARCHIVE_PATH');
  const archivePlatform = parseEnum(platformRaw, PLATFORM_IDS, platform, 'MNEME_ARCHIVE_PLATFORM');
  if (archivePlatform === platform) {
    throw new ConfigError('the archive must come from another platform than MNEME_PLATFORM', 'MNEME_ARCHIVE_PLATFORM');
  }
  rejectUnsafePath(path, 'MNEME_ARCHIVE_PATH');
  if (!isAbsolute(path)) throw new ConfigError('expected an absolute path', 'MNEME_ARCHIVE_PATH');
  if (resolve(path) === resolve(databasePath)) {
    throw new ConfigError('must not be the live database (DATABASE_PATH)', 'MNEME_ARCHIVE_PATH');
  }
  const fromBackups = relative(resolve(backupDir), resolve(path));
  if (fromBackups !== '' && !fromBackups.startsWith('..') && !isAbsolute(fromBackups)) {
    throw new ConfigError('must not be in BACKUP_DIR, where backup retention can delete it', 'MNEME_ARCHIVE_PATH');
  }
  return { path, platform: archivePlatform };
}

function rejectUnsafePath(path: string, setting: string): void {
  // Reject traversal segments; absolute or relative paths are otherwise allowed.
  const segments = path.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new ConfigError('path must not contain parent-directory (..) segments', setting);
  }
}

function assertRange(n: number, min: number, max: number, setting: string): void {
  if (n < min || n > max) {
    throw new ConfigError(`value ${n} is outside the allowed range [${min}, ${max}]`, setting);
  }
}

function assertPositive(n: number, setting: string): void {
  if (n <= 0) {
    throw new ConfigError('value must be greater than 0', setting);
  }
}

function assertNonNegative(n: number, setting: string): void {
  if (n < 0) {
    throw new ConfigError('value must be 0 or greater', setting);
  }
}

function assertFraction(n: number, setting: string): void {
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new ConfigError('value must be a fraction in [0, 1]', setting);
  }
}

/**
 * The subset of configuration the operational CLI commands need: just the local
 * database paths. No Discord token, provider key, or HTTP admin token is
 * required, because `migrate` / `backup` / `integrity-check` run before Discord
 * login or model initialization (Sections 27, 42).
 */
export interface OperationalConfig {
  dataDir: string;
  databasePath: string;
  /** Backups directory — `BACKUP_DIR` if set, otherwise `DATA_DIR/backups` (§42.1). */
  backupDir: string;
  /** The read-only platform archive (`MNEME_ARCHIVE_PATH`), for `archive-rewrite` (plan 011). */
  archivePath?: string;
}

/**
 * Load and validate ONLY the database-operational paths (`DATA_DIR`,
 * `DATABASE_PATH`, and `BACKUP_DIR`). Intended for the operational CLI: unlike
 * {@link loadConfig} this never requires a Discord token or any runtime secret,
 * so database-only commands can run unattended. Loads `.env` under the same
 * rules as the full loader, and throws {@link ConfigError} on an unsafe path,
 * exactly as the full loader does.
 */
export function loadOperationalConfig(options: LoadConfigOptions = {}): OperationalConfig {
  const e = resolveEnv(options);
  const dataDir = env(e, 'DATA_DIR') ?? DEFAULTS.dataDir;
  rejectUnsafePath(dataDir, 'DATA_DIR');
  const databasePath = env(e, 'DATABASE_PATH') ?? DEFAULTS.databasePath;
  rejectUnsafePath(databasePath, 'DATABASE_PATH');

  const backupDir = env(e, 'BACKUP_DIR') ?? deriveBackupDir(dataDir);
  rejectUnsafePath(backupDir, 'BACKUP_DIR');
  const archivePath = env(e, 'MNEME_ARCHIVE_PATH');
  if (archivePath !== undefined) {
    rejectUnsafePath(archivePath, 'MNEME_ARCHIVE_PATH');
    if (!isAbsolute(archivePath)) throw new ConfigError('expected an absolute path', 'MNEME_ARCHIVE_PATH');
  }
  return { dataDir, databasePath, backupDir, ...(archivePath !== undefined ? { archivePath } : {}) };
}

/**
 * Load and validate configuration. Throws ConfigError (exit before Discord
 * login) on any malformed or inconsistent setting.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  // Native runs: load ./.env before reading the environment. Keys already set
  // in the environment source always win and are never overwritten.
  const e = resolveEnv(options);

  // ---- YAML base (mneme.yml) ----
  let yamlText = options.yamlText;
  if (yamlText === undefined) {
    const path = env(e, 'MNEME_CONFIG_PATH') ?? DEFAULTS.mnemeConfigPath;
    try {
      yamlText = readTextFile(path);
    } catch {
      // Missing YAML is permitted: env + defaults still form a valid config.
      yamlText = '';
    }
  }
  const yaml: MnemeYaml = yamlText.trim() === '' ? {} : (parseYaml(yamlText) as MnemeYaml);
  if (yaml !== null && typeof yaml !== 'object') {
    throw new ConfigError('mneme.yml must parse to a mapping', 'MNEME_CONFIG_PATH');
  }

  // ---- Core ----
  const nodeEnv = parseEnum(env(e, 'NODE_ENV'), ['production', 'development', 'test'] as const, DEFAULTS.nodeEnv, 'NODE_ENV');
  const port = parseInt_(env(e, 'PORT'), DEFAULTS.port, 'PORT');
  assertRange(port, 1, 65535, 'PORT');

  const dataDir = env(e, 'DATA_DIR') ?? DEFAULTS.dataDir;
  rejectUnsafePath(dataDir, 'DATA_DIR');

  const databasePath = env(e, 'DATABASE_PATH') ?? DEFAULTS.databasePath;
  rejectUnsafePath(databasePath, 'DATABASE_PATH');

  const backupDir = env(e, 'BACKUP_DIR') ?? deriveBackupDir(dataDir);
  rejectUnsafePath(backupDir, 'BACKUP_DIR');

  const logLevel = env(e, 'LOG_LEVEL') ?? DEFAULTS.logLevel;
  const validLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
  if (!validLevels.includes(logLevel)) {
    throw new ConfigError(`expected one of ${validLevels.join('|')}, got "${logLevel}"`, 'LOG_LEVEL');
  }

  const promptDir = env(e, 'PROMPT_DIR') ?? DEFAULTS.promptDir;
  const docsDir = env(e, 'DOCS_DIR') ?? DEFAULTS.docsDir;
  const docsPublicUrl = resolveDocsPublicUrl(e);
  const mnemeConfigPath = env(e, 'MNEME_CONFIG_PATH') ?? DEFAULTS.mnemeConfigPath;
  const channelPolicyPath = env(e, 'CHANNEL_POLICY_PATH') ?? DEFAULTS.channelPolicyPath;
  // 'basic' (default) builds the policy from the selection lists and never
  // reads CHANNEL_POLICY_PATH; 'file' loads the YAML from the path above.
  const channelPolicySource = parseEnum(
    env(e, 'CHANNEL_POLICY_SOURCE'),
    ['basic', 'file'] as const,
    'basic',
    'CHANNEL_POLICY_SOURCE',
  );
  rejectUnsafePath(promptDir, 'PROMPT_DIR');
  rejectUnsafePath(docsDir, 'DOCS_DIR');
  rejectUnsafePath(mnemeConfigPath, 'MNEME_CONFIG_PATH');
  rejectUnsafePath(channelPolicyPath, 'CHANNEL_POLICY_PATH');

  // ---- Chat platform (required; one platform for each deployment) ----
  const platformRaw = env(e, 'MNEME_PLATFORM');
  if (!platformRaw) throw new ConfigError('required setting is missing', 'MNEME_PLATFORM');
  const platform = parseEnum(platformRaw, PLATFORM_IDS, 'discord', 'MNEME_PLATFORM');

  // ---- Platform credentials (Discord or Slack) ----
  const { discord, slack, workspaceId } = parsePlatformCredentials(e, platform);

  // ---- Read-only platform archive (optional; plan 011) ----
  const archive = parseArchive(e, platform, databasePath, backupDir);

  // ---- LLM provider (defaults: openai / gpt-5.6-terra) ----
  const provider = parseEnum(
    env(e, 'LLM_PROVIDER'),
    ['openai', 'anthropic', 'google'] as const,
    DEFAULTS.llmProvider,
    'LLM_PROVIDER',
  );
  const model = env(e, 'LLM_MODEL') ?? DEFAULTS.llmModel;
  const apiKeyEnv = PROVIDER_API_KEY[provider];
  const apiKey = env(e, apiKeyEnv);
  if (!apiKey) {
    // Do not echo the key value; name the expected env var by its setting name.
    throw new ConfigError(`selected provider "${provider}" requires its API credential`, apiKeyEnv);
  }
  const baseUrl = env(e, 'LLM_BASE_URL');
  const triageModel = env(e, 'TRIAGE_LLM_MODEL');
  const dailyBudgetUsd = parseDailyBudget(env(e, 'LLM_DAILY_BUDGET_USD'));

  // ---- Organization + agent (env overrides YAML) ----
  const organization = {
    name: env(e, 'ORG_NAME') ?? yaml.organization?.name ?? DEFAULTS.organizationName,
    timezone: env(e, 'ORG_TIMEZONE') ?? yaml.organization?.timezone ?? DEFAULTS.organizationTimezone,
  };
  if (!organization.name) throw new ConfigError('organization name is required', 'ORG_NAME');
  if (!validTimezone(organization.timezone)) {
    throw new ConfigError(`not a recognized IANA timezone`, 'ORG_TIMEZONE');
  }
  const agent = {
    name: yaml.agent?.name ?? DEFAULTS.agentName,
    role: yaml.agent?.role ?? DEFAULTS.agentRole,
  };

  // ---- Personality (YAML; fall back to documented defaults) ----
  const personality = parsePersonality(yaml);

  // ---- Mode + review channel ----
  const mode = parseEnum(env(e, 'MNEME_MODE'), ['observe', 'review', 'autonomous'] as const, 'observe', 'MNEME_MODE');
  const reviewChannelIdEnv = env(e, 'MNEME_REVIEW_CHANNEL_ID');
  const reviewChannelId = reviewChannelIdEnv
    ? parseId(reviewChannelIdEnv, 'MNEME_REVIEW_CHANNEL_ID', platform, 'channel')
    : undefined;
  const adminRoleIds = platform === 'discord'
    ? parseSnowflakeList(env(e, 'MNEME_ADMIN_ROLE_IDS'), 'MNEME_ADMIN_ROLE_IDS')
    : [];
  if (platform === 'discord' && adminRoleIds.length === 0) {
    // A warning, never an error: authorization already fails closed with no
    // roles configured, so admin operations stay denied until the operator
    // sets them.
    createLogger().warn(
      { event: 'config.admin_roles_empty' },
      'MNEME_ADMIN_ROLE_IDS is empty; admin operations stay denied',
    );
  }
  const deletionApproverUserIds = parseIdList(
    env(e, 'MNEME_DELETION_APPROVER_USER_IDS'), 'MNEME_DELETION_APPROVER_USER_IDS', platform, 'user',
  );
  const httpAdminToken = env(e, 'HTTP_ADMIN_TOKEN');

  // ---- Intervention (env overrides YAML overrides defaults) ----
  const iv = yaml.intervention ?? {};
  const intervention: InterventionConfig = {
    threshold: parseNumber(env(e, 'INTERVENTION_THRESHOLD'), numOr(iv.threshold, DEFAULTS.intervention.threshold), 'INTERVENTION_THRESHOLD'),
    minEvidenceStrength: parseNumber(env(e, 'MIN_EVIDENCE_STRENGTH'), numOr(iv.min_evidence_strength, DEFAULTS.intervention.minEvidenceStrength), 'MIN_EVIDENCE_STRENGTH'),
    minConfidence: parseNumber(env(e, 'MIN_INTERVENTION_CONFIDENCE'), numOr(iv.min_confidence, DEFAULTS.intervention.minConfidence), 'MIN_INTERVENTION_CONFIDENCE'),
    channelCooldownMinutes: parseInt_(env(e, 'CHANNEL_COOLDOWN_MINUTES'), intOr(iv.channel_cooldown_minutes, DEFAULTS.intervention.channelCooldownMinutes), 'CHANNEL_COOLDOWN_MINUTES'),
    globalDailyLimit: parseInt_(env(e, 'GLOBAL_AUTONOMOUS_POST_LIMIT_PER_DAY'), intOr(iv.global_daily_limit, DEFAULTS.intervention.globalDailyLimit), 'GLOBAL_AUTONOMOUS_POST_LIMIT_PER_DAY'),
    maxMessageCharacters: parseInt_(env(e, 'MNEME_MAX_MESSAGE_CHARACTERS'), intOr(iv.max_message_characters, DEFAULTS.intervention.maxMessageCharacters), 'MNEME_MAX_MESSAGE_CHARACTERS'),
    attentionWindowDays: parseInt_(env(e, 'INTERVENTION_ATTENTION_WINDOW_DAYS'), intOr(iv.attention_window_days, DEFAULTS.intervention.attentionWindowDays), 'INTERVENTION_ATTENTION_WINDOW_DAYS'),
  };
  assertFraction(intervention.threshold, 'INTERVENTION_THRESHOLD');
  assertFraction(intervention.minEvidenceStrength, 'MIN_EVIDENCE_STRENGTH');
  assertFraction(intervention.minConfidence, 'MIN_INTERVENTION_CONFIDENCE');
  assertPositive(intervention.channelCooldownMinutes, 'CHANNEL_COOLDOWN_MINUTES');
  assertPositive(intervention.globalDailyLimit, 'GLOBAL_AUTONOMOUS_POST_LIMIT_PER_DAY');
  assertPositive(intervention.maxMessageCharacters, 'MNEME_MAX_MESSAGE_CHARACTERS');
  assertPositive(intervention.attentionWindowDays, 'INTERVENTION_ATTENTION_WINDOW_DAYS');

  // ---- Memory (env overrides YAML overrides defaults) ----
  const mem = yaml.memory ?? {};
  const memory: MemoryConfig = {
    minimumConfidence: parseNumber(env(e, 'MEMORY_MINIMUM_CONFIDENCE'), numOr(mem.minimum_confidence, DEFAULTS.memory.minimumConfidence), 'MEMORY_MINIMUM_CONFIDENCE'),
    minimumImportance: parseNumber(env(e, 'MEMORY_MINIMUM_IMPORTANCE'), numOr(mem.minimum_importance, DEFAULTS.memory.minimumImportance), 'MEMORY_MINIMUM_IMPORTANCE'),
    followupHorizonDays: parseInt_(env(e, 'MEMORY_FOLLOWUP_HORIZON_DAYS'), intOr(mem.followup_horizon_days, DEFAULTS.memory.followupHorizonDays), 'MEMORY_FOLLOWUP_HORIZON_DAYS'),
    followupMaxMessages: parseInt_(env(e, 'MEMORY_FOLLOWUP_MAX_MESSAGES'), intOr(mem.followup_max_messages, DEFAULTS.memory.followupMaxMessages), 'MEMORY_FOLLOWUP_MAX_MESSAGES'),
    scheduledReviewReminderDays: parseInt_(env(e, 'MEMORY_SCHEDULED_REVIEW_REMINDER_DAYS'), intOr(mem.scheduled_review_reminder_days, DEFAULTS.memory.scheduledReviewReminderDays), 'MEMORY_SCHEDULED_REVIEW_REMINDER_DAYS'),
    stalenessHorizonDays: parseInt_(env(e, 'MEMORY_STALENESS_HORIZON_DAYS'), intOr(mem.staleness_horizon_days, DEFAULTS.memory.stalenessHorizonDays), 'MEMORY_STALENESS_HORIZON_DAYS'),
    requireEvidence: parseBool(env(e, 'MEMORY_REQUIRE_EVIDENCE'), boolOr(mem.require_evidence, DEFAULTS.memory.requireEvidence)),
    reviewPredictions: parseBool(env(e, 'MEMORY_REVIEW_PREDICTIONS'), boolOr(mem.review_predictions, DEFAULTS.memory.reviewPredictions)),
    reviewAssumptions: parseBool(env(e, 'MEMORY_REVIEW_ASSUMPTIONS'), boolOr(mem.review_assumptions, DEFAULTS.memory.reviewAssumptions)),
  };
  assertFraction(memory.minimumConfidence, 'MEMORY_MINIMUM_CONFIDENCE');
  assertFraction(memory.minimumImportance, 'MEMORY_MINIMUM_IMPORTANCE');
  assertPositive(memory.followupHorizonDays, 'MEMORY_FOLLOWUP_HORIZON_DAYS');
  assertPositive(memory.followupMaxMessages, 'MEMORY_FOLLOWUP_MAX_MESSAGES');
  assertPositive(memory.scheduledReviewReminderDays, 'MEMORY_SCHEDULED_REVIEW_REMINDER_DAYS');
  assertNonNegative(memory.stalenessHorizonDays, 'MEMORY_STALENESS_HORIZON_DAYS');

  // ---- Ingestion ----
  // FULL_HISTORY has no default: the operator must choose the initial scope.
  const fullHistoryRaw = env(e, 'FULL_HISTORY');
  if (fullHistoryRaw === undefined) {
    throw new ConfigError(
      'FULL_HISTORY must be set explicitly: choose the initial import scope (true = import all reachable history for selected channels, false = new messages onward)',
    );
  }
  const ingestion: IngestionConfig = {
    fullHistory: parseBool(fullHistoryRaw, true),
    backfillConcurrency: parseInt_(env(e, 'BACKFILL_CONCURRENCY'), 2, 'BACKFILL_CONCURRENCY'),
    reconcileIntervalMinutes: parseInt_(env(e, 'RECONCILE_INTERVAL_MINUTES'), 360, 'RECONCILE_INTERVAL_MINUTES'),
    reconcileOverlapHours: parseInt_(env(e, 'RECONCILE_OVERLAP_HOURS'), 24, 'RECONCILE_OVERLAP_HOURS'),
    reconcileMaxPagesPerRun: parseInt_(env(e, 'RECONCILE_MAX_PAGES_PER_RUN'), 10, 'RECONCILE_MAX_PAGES_PER_RUN'),
    threadDiscoveryIntervalMinutes: parseInt_(env(e, 'THREAD_DISCOVERY_INTERVAL_MINUTES'), 360, 'THREAD_DISCOVERY_INTERVAL_MINUTES'),
    storeRawJson: parseBool(env(e, 'STORE_RAW_JSON'), false),
    retainEditHistory: parseBool(env(e, 'RETAIN_EDIT_HISTORY'), false),
    retainDeletedContent: parseBool(env(e, 'RETAIN_DELETED_CONTENT'), false),
    attachmentMode: parseEnum(env(e, 'ATTACHMENT_MODE'), ['none', 'metadata', 'archive', 'selective'] as const, 'metadata', 'ATTACHMENT_MODE'),
    attachmentMaxBytes: parseInt_(env(e, 'ATTACHMENT_MAX_BYTES'), 10485760, 'ATTACHMENT_MAX_BYTES'),
    attachmentMimeAllowlist: parseMimeAllowlist(env(e, 'ATTACHMENT_MIME_ALLOWLIST')),
  };
  assertPositive(ingestion.backfillConcurrency, 'BACKFILL_CONCURRENCY');
  assertRange(ingestion.reconcileOverlapHours, 1, 168, 'RECONCILE_OVERLAP_HOURS');
  assertRange(ingestion.reconcileMaxPagesPerRun, 1, 100, 'RECONCILE_MAX_PAGES_PER_RUN');
  assertPositive(ingestion.attachmentMaxBytes, 'ATTACHMENT_MAX_BYTES');

  // ---- Episodes + agent ----
  const episodes: EpisodeConfig = {
    quietSeconds: parseInt_(env(e, 'EPISODE_QUIET_SECONDS'), 90, 'EPISODE_QUIET_SECONDS'),
    maxMessages: parseInt_(env(e, 'EPISODE_MAX_MESSAGES'), 40, 'EPISODE_MAX_MESSAGES'),
    maxMinutes: parseInt_(env(e, 'EPISODE_MAX_MINUTES'), 10, 'EPISODE_MAX_MINUTES'),
    settleSeconds: parseInt_(env(e, 'EPISODE_SETTLE_SECONDS'), DEFAULT_SETTLE_SECONDS, 'EPISODE_SETTLE_SECONDS'),
    settleMaxMinutes: parseInt_(env(e, 'EPISODE_SETTLE_MAX_MINUTES'), DEFAULT_SETTLE_MAX_MINUTES, 'EPISODE_SETTLE_MAX_MINUTES'),
  };
  assertPositive(episodes.quietSeconds, 'EPISODE_QUIET_SECONDS');
  assertPositive(episodes.maxMessages, 'EPISODE_MAX_MESSAGES');
  assertPositive(episodes.maxMinutes, 'EPISODE_MAX_MINUTES');
  assertPositive(episodes.settleSeconds, 'EPISODE_SETTLE_SECONDS');
  assertPositive(episodes.settleMaxMinutes, 'EPISODE_SETTLE_MAX_MINUTES');

  const historicalMemory: HistoricalMemoryConfig = {
    enabled: parseBool(env(e, 'HISTORICAL_MEMORY_ENABLED'), false),
    channelIds: parseSnowflakeList(env(e, 'HISTORICAL_MEMORY_CHANNEL_IDS'), 'HISTORICAL_MEMORY_CHANNEL_IDS'),
    batchMessages: parseInt_(env(e, 'HISTORICAL_MEMORY_BATCH_MESSAGES'), 200, 'HISTORICAL_MEMORY_BATCH_MESSAGES'),
    maxPendingReviews: parseInt_(env(e, 'HISTORICAL_MEMORY_MAX_PENDING_REVIEWS'), 4, 'HISTORICAL_MEMORY_MAX_PENDING_REVIEWS'),
    dailyBudgetUsd: parseNumber(env(e, 'HISTORICAL_MEMORY_DAILY_BUDGET_USD'), 1, 'HISTORICAL_MEMORY_DAILY_BUDGET_USD'),
    campaignId: env(e, 'HISTORICAL_MEMORY_CAMPAIGN_ID'),
    direction: parseEnum(env(e, 'HISTORICAL_MEMORY_DIRECTION'), ['newest_first'] as const, 'newest_first', 'HISTORICAL_MEMORY_DIRECTION'),
    fromAtMs: parseOptionalDateMs(env(e, 'HISTORICAL_MEMORY_FROM_AT'), 'HISTORICAL_MEMORY_FROM_AT'),
    toAtMs: parseOptionalDateMs(env(e, 'HISTORICAL_MEMORY_TO_AT'), 'HISTORICAL_MEMORY_TO_AT'),
    model: env(e, 'HISTORICAL_MEMORY_LLM_MODEL'),
    thinkingLevel: parseEnum(env(e, 'HISTORICAL_MEMORY_THINKING_LEVEL'), ['low', 'medium', 'high'] as const, 'medium', 'HISTORICAL_MEMORY_THINKING_LEVEL'),
    totalBudgetUsd: parseNumber(env(e, 'HISTORICAL_MEMORY_TOTAL_BUDGET_USD'), 0, 'HISTORICAL_MEMORY_TOTAL_BUDGET_USD'),
  };
  assertPositive(historicalMemory.batchMessages, 'HISTORICAL_MEMORY_BATCH_MESSAGES');
  assertPositive(historicalMemory.maxPendingReviews, 'HISTORICAL_MEMORY_MAX_PENDING_REVIEWS');
  if (historicalMemory.dailyBudgetUsd < 0) {
    throw new ConfigError('must be greater than or equal to 0', 'HISTORICAL_MEMORY_DAILY_BUDGET_USD');
  }
  if (historicalMemory.campaignId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(historicalMemory.campaignId)) {
      throw new ConfigError('must be 1-64 safe identifier characters', 'HISTORICAL_MEMORY_CAMPAIGN_ID');
    }
    if (historicalMemory.fromAtMs === undefined) throw new ConfigError('required for a bounded campaign', 'HISTORICAL_MEMORY_FROM_AT');
    if (historicalMemory.toAtMs === undefined) throw new ConfigError('required for a bounded campaign', 'HISTORICAL_MEMORY_TO_AT');
    if (historicalMemory.fromAtMs >= historicalMemory.toAtMs) {
      throw new ConfigError('must be earlier than HISTORICAL_MEMORY_TO_AT', 'HISTORICAL_MEMORY_FROM_AT');
    }
    if (!historicalMemory.model) throw new ConfigError('required for a bounded campaign', 'HISTORICAL_MEMORY_LLM_MODEL');
    if (historicalMemory.channelIds.length === 0) {
      throw new ConfigError('a bounded campaign requires an explicit channel allowlist', 'HISTORICAL_MEMORY_CHANNEL_IDS');
    }
    if (historicalMemory.totalBudgetUsd <= 0) {
      throw new ConfigError('must be greater than 0 for a bounded campaign', 'HISTORICAL_MEMORY_TOTAL_BUDGET_USD');
    }
  }

  const agentRuntime: AgentConfig = {
    maxConcurrency: parseInt_(env(e, 'AGENT_MAX_CONCURRENCY'), 1, 'AGENT_MAX_CONCURRENCY'),
    timeoutSeconds: parseInt_(env(e, 'AGENT_TIMEOUT_SECONDS'), 120, 'AGENT_TIMEOUT_SECONDS'),
    maxToolCalls: parseInt_(env(e, 'AGENT_MAX_TOOL_CALLS'), 8, 'AGENT_MAX_TOOL_CALLS'),
    maxRetrievedCharacters: parseInt_(env(e, 'AGENT_MAX_RETRIEVED_CHARACTERS'), 60000, 'AGENT_MAX_RETRIEVED_CHARACTERS'),
    thinkingLevel: parseEnum(env(e, 'AGENT_THINKING_LEVEL'), ['low', 'medium', 'high'] as const, 'medium', 'AGENT_THINKING_LEVEL'),
  };
  assertPositive(agentRuntime.maxConcurrency, 'AGENT_MAX_CONCURRENCY');
  assertPositive(agentRuntime.timeoutSeconds, 'AGENT_TIMEOUT_SECONDS');
  assertPositive(agentRuntime.maxToolCalls, 'AGENT_MAX_TOOL_CALLS');
  assertPositive(agentRuntime.maxRetrievedCharacters, 'AGENT_MAX_RETRIEVED_CHARACTERS');

  const episodeShadow: EpisodeShadowConfig = {
    enabled: parseBool(env(e, 'EPISODE_SHADOW_ENABLED'), false),
    model: env(e, 'EPISODE_SHADOW_MODEL'),
    thinkingLevel: parseEnum(
      env(e, 'EPISODE_SHADOW_THINKING_LEVEL'),
      ['low', 'medium', 'high'] as const,
      'low',
      'EPISODE_SHADOW_THINKING_LEVEL',
    ),
    maxRuns: parseInt_(env(e, 'EPISODE_SHADOW_MAX_RUNS'), 50, 'EPISODE_SHADOW_MAX_RUNS'),
  };
  assertPositive(episodeShadow.maxRuns, 'EPISODE_SHADOW_MAX_RUNS');
  if (episodeShadow.enabled && agentRuntime.thinkingLevel !== 'medium') {
    throw new ConfigError(
      'requires AGENT_THINKING_LEVEL=medium so the authoritative baseline remains fixed',
      'EPISODE_SHADOW_ENABLED',
    );
  }
  if (
    episodeShadow.enabled
    && (episodeShadow.model ?? model) === model
    && episodeShadow.thinkingLevel === agentRuntime.thinkingLevel
  ) {
    throw new ConfigError(
      'candidate model and reasoning equal the authoritative configuration',
      'EPISODE_SHADOW_ENABLED',
    );
  }

  const directAnswerEnabled = parseBool(env(e, 'DIRECT_ANSWER_ENABLED'), true);
  const deepRecap: DeepRecapConfig = {
    enabled: parseBool(env(e, 'DEEP_RECAP_ENABLED'), false),
    maxWindowDays: parseInt_(env(e, 'DEEP_RECAP_MAX_WINDOW_DAYS'), 30, 'DEEP_RECAP_MAX_WINDOW_DAYS'),
    maxBudgetUsd: parseNumber(env(e, 'DEEP_RECAP_MAX_BUDGET_USD'), 20, 'DEEP_RECAP_MAX_BUDGET_USD'),
    dailyBudgetUsd: parseNumber(env(e, 'DEEP_RECAP_DAILY_BUDGET_USD'), 20, 'DEEP_RECAP_DAILY_BUDGET_USD'),
  };
  assertPositive(deepRecap.maxWindowDays, 'DEEP_RECAP_MAX_WINDOW_DAYS');
  if (deepRecap.maxWindowDays > 30) {
    throw new ConfigError('must be at most 30', 'DEEP_RECAP_MAX_WINDOW_DAYS');
  }
  assertPositive(deepRecap.maxBudgetUsd, 'DEEP_RECAP_MAX_BUDGET_USD');
  assertPositive(deepRecap.dailyBudgetUsd, 'DEEP_RECAP_DAILY_BUDGET_USD');

  // ---- Maintenance ----
  const maintenance: MaintenanceConfig = {
    backupEnabled: parseBool(env(e, 'BACKUP_ENABLED'), true),
    backupIntervalHours: parseInt_(env(e, 'BACKUP_INTERVAL_HOURS'), 24, 'BACKUP_INTERVAL_HOURS'),
    backupRetentionDays: parseInt_(env(e, 'BACKUP_RETENTION_DAYS'), 7, 'BACKUP_RETENTION_DAYS'),
    jobsRetentionDays: parseInt_(env(e, 'JOBS_RETENTION_DAYS'), 30, 'JOBS_RETENTION_DAYS'),
    pragmaOptimizeIntervalHours: parseInt_(env(e, 'PRAGMA_OPTIMIZE_INTERVAL_HOURS'), 24, 'PRAGMA_OPTIMIZE_INTERVAL_HOURS'),
    shutdownTimeoutSeconds: parseInt_(env(e, 'SHUTDOWN_TIMEOUT_SECONDS'), 30, 'SHUTDOWN_TIMEOUT_SECONDS'),
  };
  assertPositive(maintenance.backupIntervalHours, 'BACKUP_INTERVAL_HOURS');
  assertPositive(maintenance.jobsRetentionDays, 'JOBS_RETENTION_DAYS');
  assertPositive(maintenance.shutdownTimeoutSeconds, 'SHUTDOWN_TIMEOUT_SECONDS');

  // ---- MCP ----
  // The identity provider's OAuth keys belong to the active platform.
  const oauthKeys = platform === 'slack'
    ? { clientId: 'SLACK_OAUTH_CLIENT_ID', clientSecret: 'SLACK_OAUTH_CLIENT_SECRET' }
    : { clientId: 'DISCORD_OAUTH_CLIENT_ID', clientSecret: 'DISCORD_OAUTH_CLIENT_SECRET' };
  const mcp: McpConfig = {
    enabled: parseBool(env(e, 'MCP_ENABLED'), false),
    path: env(e, 'MCP_PATH') ?? '/mcp',
    publicBaseUrl: resolvePublicBaseUrl(e, port),
    rateLimitPerMinute: parseInt_(env(e, 'MCP_RATE_LIMIT_PER_MINUTE'), 60, 'MCP_RATE_LIMIT_PER_MINUTE'),
    unauthRateLimitPerMinute: parseInt_(
      env(e, 'MCP_UNAUTH_RATE_LIMIT_PER_MINUTE'),
      30,
      'MCP_UNAUTH_RATE_LIMIT_PER_MINUTE',
    ),
    toolListTtlMs: parseInt_(env(e, 'MCP_TOOL_LIST_TTL_MS'), 300000, 'MCP_TOOL_LIST_TTL_MS'),
    oauthEnabled: parseBool(env(e, 'MCP_OAUTH_ENABLED'), false),
    oauthClientId: (env(e, 'MCP_OAUTH_CLIENT_ID') ?? '').trim(),
    oauthRedirectUris: parseRedirectUris(env(e, 'MCP_OAUTH_REDIRECT_URIS')),
    oauthProviderClientId: (env(e, oauthKeys.clientId) ?? '').trim(),
    oauthProviderClientSecret: (env(e, oauthKeys.clientSecret) ?? '').trim(),
  };
  assertPositive(mcp.rateLimitPerMinute, 'MCP_RATE_LIMIT_PER_MINUTE');
  assertPositive(mcp.unauthRateLimitPerMinute, 'MCP_UNAUTH_RATE_LIMIT_PER_MINUTE');
  if (mcp.path === '' || !mcp.path.startsWith('/')) {
    throw new ConfigError('MCP_PATH must start with "/"', 'MCP_PATH');
  }
  // Fail closed: discovery that advertises an authorization endpoint no client
  // can be recognized at would send every user into a flow that cannot complete.
  if (mcp.oauthEnabled && mcp.oauthClientId === '') {
    throw new ConfigError('a client id is required when MCP_OAUTH_ENABLED is set', 'MCP_OAUTH_CLIENT_ID');
  }
  // Without the identity provider's credentials there is nobody to ask who a
  // person is, so a sign-in could start and never complete.
  if (mcp.oauthEnabled && mcp.oauthProviderClientId === '') {
    throw new ConfigError('required when MCP_OAUTH_ENABLED is set', oauthKeys.clientId);
  }
  if (mcp.oauthEnabled && mcp.oauthProviderClientSecret === '') {
    throw new ConfigError('required when MCP_OAUTH_ENABLED is set', oauthKeys.clientSecret);
  }
  // Admin roles are what the Discord sign-in check consults. With none
  // configured `authorizeAdmin` denies everyone, so OAuth would advertise a flow
  // that can never succeed — surface that at boot instead of at a user's first
  // attempt. On Slack, MNEME_ADMIN_USER_IDS is already required.
  if (mcp.oauthEnabled && platform === 'discord' && adminRoleIds.length === 0) {
    throw new ConfigError(
      'at least one admin role is required when MCP_OAUTH_ENABLED is set',
      'MNEME_ADMIN_ROLE_IDS',
    );
  }

  // ---- Inspector (Section 32.6) ----
  const inspector: InspectorConfig = {
    enabled: parseBool(env(e, 'INSPECTOR_ENABLED'), false),
    path: env(e, 'INSPECTOR_PATH') ?? '/inspector',
    publicBaseUrl: resolvePublicBaseUrl(e, port),
    // Defaults mirror src/http/inspector/tokens.ts (120 / 30 per minute).
    rateLimitPerMinute: parseInt_(
      env(e, 'INSPECTOR_RATE_LIMIT_PER_MINUTE'),
      120,
      'INSPECTOR_RATE_LIMIT_PER_MINUTE',
    ),
    unauthRateLimitPerMinute: parseInt_(
      env(e, 'INSPECTOR_UNAUTH_RATE_LIMIT_PER_MINUTE'),
      30,
      'INSPECTOR_UNAUTH_RATE_LIMIT_PER_MINUTE',
    ),
  };
  assertPositive(inspector.rateLimitPerMinute, 'INSPECTOR_RATE_LIMIT_PER_MINUTE');
  assertPositive(inspector.unauthRateLimitPerMinute, 'INSPECTOR_UNAUTH_RATE_LIMIT_PER_MINUTE');
  if (inspector.path === '' || !inspector.path.startsWith('/')) {
    throw new ConfigError('INSPECTOR_PATH must start with "/"', 'INSPECTOR_PATH');
  }
  // A trailing slash would break the server's `${path}/...` prefix match for
  // every canonical sub-path URL, so reject it at boot instead of serving a
  // half-broken surface.
  if (inspector.path.endsWith('/')) {
    throw new ConfigError('INSPECTOR_PATH must not end with "/"', 'INSPECTOR_PATH');
  }
  // The HTTP server matches every other route before the inspector subtree, so
  // an exact collision hides the whole surface and a prefix collision hides one
  // sub-path. Reject both at boot instead of serving a half-broken surface.
  for (const reserved of reservedHttpPaths(mcp)) {
    if (inspector.path === reserved || reserved.startsWith(`${inspector.path}/`)) {
      throw new ConfigError(
        `INSPECTOR_PATH must not collide with the reserved route ${reserved}`,
        'INSPECTOR_PATH',
      );
    }
  }

  // ---- Cross-field validation ----
  validateReviewChannel({ mode, reviewChannelId, channelPolicyReview: options.channelPolicyReview });

  return {
    nodeEnv,
    port,
    dataDir,
    databasePath,
    backupDir,
    logLevel,
    promptDir,
    docsDir,
    docsPublicUrl,
    mnemeConfigPath,
    channelPolicyPath,
    channelPolicySource,
    platform,
    workspaceId,
    discord,
    slack,
    archive,
    llm: { provider, model, triageModel, baseUrl, apiKey, dailyBudgetUsd },
    organization,
    agent,
    personality,
    mode,
    reviewChannelId,
    adminRoleIds,
    deletionApproverUserIds,
    httpAdminToken,
    ingestion,
    episodes,
    historicalMemory,
    deepRecap,
    agentRuntime,
    episodeShadow,
    intervention,
    memory,
    maintenance,
    mcp,
    inspector,
    directAnswerEnabled,
  };
}

/** Validate the optional public documentation base and normalize it with a trailing slash. */
function resolveDocsPublicUrl(e: NodeJS.ProcessEnv): string | undefined {
  const raw = env(e, 'DOCS_PUBLIC_URL');
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ConfigError('expected an absolute https URL', 'DOCS_PUBLIC_URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new ConfigError(
      'expected an https URL without credentials, query parameters, or a fragment',
      'DOCS_PUBLIC_URL',
    );
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
  return parsed.toString();
}

/**
 * Resolve the origin external MCP clients use. `MCP_PUBLIC_URL` wins; a Railway
 * deployment supplies `RAILWAY_PUBLIC_DOMAIN` when a domain is assigned; a local
 * run falls back to the loopback address on the configured port. The result has
 * a scheme and no trailing slash.
 */
function resolvePublicBaseUrl(e: NodeJS.ProcessEnv, port: number): string {
  const explicit = env(e, 'MCP_PUBLIC_URL');
  if (explicit !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(explicit.trim());
    } catch {
      throw new ConfigError(`expected an absolute http(s) URL, got "${explicit}"`, 'MCP_PUBLIC_URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConfigError(`expected an http(s) URL, got "${explicit}"`, 'MCP_PUBLIC_URL');
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  }
  const railwayDomain = env(e, 'RAILWAY_PUBLIC_DOMAIN');
  if (railwayDomain !== undefined) return `https://${railwayDomain.trim().replace(/\/+$/, '')}`;
  return `http://localhost:${port}`;
}

/** Full URL of the MCP endpoint, for operators to paste into a client config. */
export function mcpEndpointUrl(mcp: Pick<McpConfig, 'publicBaseUrl' | 'path'>): string {
  return `${mcp.publicBaseUrl}${mcp.path}`;
}

/**
 * Every path the HTTP server matches before the inspector subtree (Section
 * 32.3, 32.5.2, 32.6). The OAuth paths are listed whether or not OAuth is
 * enabled: the surface must keep its mount path when OAuth is switched on
 * later.
 */
export function reservedHttpPaths(mcp: Pick<McpConfig, 'path'>): readonly string[] {
  return [
    '/',
    '/livez',
    '/readyz',
    '/status',
    '/metrics',
    mcp.path,
    OAUTH_AUTHORIZE_PATH,
    OAUTH_TOKEN_PATH,
    OAUTH_PROTECTED_RESOURCE_PATH,
    OAUTH_AUTHORIZATION_SERVER_PATH,
    protectedResourceMetadataPath(mcp.path),
  ];
}

/** Full URL of the inspector surface, echoed once when a token is issued. */
export function inspectorUrl(inspector: Pick<InspectorConfig, 'publicBaseUrl' | 'path'>): string {
  return `${inspector.publicBaseUrl}${inspector.path}`;
}

function validateReviewChannel(args: {
  mode: AutonomyMode;
  reviewChannelId: string | undefined;
  channelPolicyReview?: { id?: string; secure?: boolean };
}): void {
  const { mode, reviewChannelId, channelPolicyReview } = args;

  // If both env and channel-policy name a review channel, they must match.
  if (reviewChannelId && channelPolicyReview?.id && reviewChannelId !== channelPolicyReview.id) {
    throw new ConfigError(
      'MNEME_REVIEW_CHANNEL_ID and channel-policy.yml review_channel.id must match',
      'MNEME_REVIEW_CHANNEL_ID',
    );
  }

  const needsReviewChannel = mode === 'review' || mode === 'autonomous';
  if (!needsReviewChannel) return;

  const resolvedId = reviewChannelId ?? channelPolicyReview?.id;
  if (!resolvedId) {
    throw new ConfigError(`mode "${mode}" requires a secure review channel`, 'MNEME_REVIEW_CHANNEL_ID');
  }
  if (channelPolicyReview && channelPolicyReview.secure === false) {
    throw new ConfigError(`mode "${mode}" requires the review channel to be marked secure`, 'MNEME_REVIEW_CHANNEL_ID');
  }
}

// ---------- personality + yaml coercion ----------

function asStringList(value: unknown, setting: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError('expected a list of strings', setting);
  }
  return value.map((v, i) => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new ConfigError(`entry ${i} is not a non-empty string`, setting);
    }
    return v;
  });
}

function parsePersonality(yaml: MnemeYaml): PersonalityConfig {
  const p = yaml.personality;
  if (!p) return { ...DEFAULTS.personality, voice: { ...DEFAULTS.personality.voice } };
  const traits = p.traits === undefined ? DEFAULTS.personality.traits : asStringList(p.traits, 'personality.traits');
  const avoid = p.avoid === undefined ? DEFAULTS.personality.avoid : asStringList(p.avoid, 'personality.avoid');
  const voiceSrc = p.voice ?? {};
  const voice: PersonalityVoice = {
    warmth: strOr(voiceSrc.warmth, DEFAULTS.personality.voice.warmth, 'personality.voice.warmth'),
    directness: strOr(voiceSrc.directness, DEFAULTS.personality.voice.directness, 'personality.voice.directness'),
    verbosity: strOr(voiceSrc.verbosity, DEFAULTS.personality.voice.verbosity, 'personality.voice.verbosity'),
    humor: strOr(voiceSrc.humor, DEFAULTS.personality.voice.humor, 'personality.voice.humor'),
    emoji: strOr(voiceSrc.emoji, DEFAULTS.personality.voice.emoji, 'personality.voice.emoji'),
  };
  return { traits, avoid, voice };
}

function strOr(v: unknown, fallback: string, setting: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== 'string') throw new ConfigError('expected a string', setting);
  return v;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function intOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) ? v : fallback;
}
function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function parseMimeAllowlist(raw: string | undefined): string[] {
  const defaultList = ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'application/pdf'];
  if (raw === undefined || raw.trim() === '') return defaultList;
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return defaultList;
  for (const part of parts) {
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(part)) {
      throw new ConfigError(`list contains an invalid MIME type "${part}"`, 'ATTACHMENT_MIME_ALLOWLIST');
    }
  }
  return parts;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 file, returning '' when missing. */
function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return '';
    throw err;
  }
}
