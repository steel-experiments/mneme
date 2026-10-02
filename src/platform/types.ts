// ABOUTME: Platform-neutral types shared by the core and every chat-platform adapter.
// ABOUTME: Adapters normalize platform payloads into these shapes before the core sees them.
import type { BootstrapContext } from '../bootstrap.js';
import type { ChannelPolicySource, PlatformId } from '../config.js';
import type { DatabaseSync } from '../db/database.js';
import type { BackfillMessageFetcher } from '../ingestion/backfill.js';
import type { DiscoveredChannelDescriptor } from '../ingestion/discovery.js';
import type { LiveIngestionDeps } from '../ingestion/live.js';
import type { ThreadArchiveSource } from '../ingestion/threads.js';
import type { JobHandler } from '../jobs/worker.js';
import type { RecentSentMessageLookup } from '../outbox/recovery.js';
import type { ChannelPolicy } from '../policy/channel-policy.js';
import type { ApprovalPolicyRecheck, ReviewResolver } from '../review/workflow.js';

/**
 * Platform-neutral channel kind (plan 002 decision 17). `other` is a channel the
 * platform reports but discovery does not enumerate, such as a voice channel.
 */
export type ChannelKind = 'text' | 'announcement' | 'forum' | 'media' | 'category' | 'thread' | 'other';

export interface NormalizedAuthor {
  id: string;
  username: string | null;
  globalName: string | null;
  isBot: boolean;
}

export interface NormalizedMention {
  id: string;
  username: string | null;
  globalName: string | null;
}

export interface NormalizedAttachment {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  sourceUrl: string | null;
  proxyUrl: string | null;
}

/**
 * An aggregate reaction count, as REST backfill returns them. Only live Gateway
 * events provide per-user data; backfill gives emoji + count and nothing more
 * (Section 9.9). `emojiKey` is stable across both sources so the two can be
 * reconciled: a unicode emoji uses its codepoint name, a custom emoji uses
 * `name:id`.
 */
export interface NormalizedReactionCount {
  emojiKey: string;
  count: number;
}


export interface NormalizedMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  author: NormalizedAuthor;
  /** True when Discord attributes the message to a webhook execution. */
  isWebhook: boolean;
  content: string;
  createdAtMs: number;
  editedAtMs: number | null;
  replyToMessageId: string | null;
  messageType: number | null;
  flags: number | null;
  pinned: boolean;
  mentionEveryone: boolean;
  mentions: NormalizedMention[];
  embeds: unknown[];
  components: unknown[];
  poll: unknown | null;
  attachments: NormalizedAttachment[];
  reactionCounts: NormalizedReactionCount[];
  raw: unknown;
}

/**
 * A partial patch. For every optional property:
 *   - property absent (undefined) → source field was absent (keep existing);
 *   - property null               → source field was present as null (clear);
 *   - property is a value         → source field was present with a value (update).
 *
 * `content` is special-cased: it is `string | undefined`. When present it
 * always carries a string (possibly ''), so an omitted content never becomes an
 * empty overwrite, and a present empty content is honored as a real edit.
 */
export interface NormalizedMessagePatch {
  id: string;
  channelId: string;
  raw: unknown;
  guildId?: string | null;
  author?: NormalizedAuthor | null;
  content?: string;
  editedAtMs?: number | null;
  flags?: number | null;
  pinned?: boolean | null;
  mentionEveryone?: boolean | null;
  mentions?: NormalizedMention[] | null;
  embeds?: unknown[] | null;
  components?: unknown[] | null;
  poll?: unknown | null;
  attachments?: NormalizedAttachment[] | null;
}

// ---- Outbound send port --------------------------------------------------

export interface SendOutboxMessageInput {
  channelId: string;
  content: string;
  /** Reply anchor in the target channel, when one was validated upstream. */
  replyToMessageId?: string | null;
  /** Stable Discord nonce used only for crash reconciliation. */
  dedupeMarker?: string | null;
}

export interface SendResult {
  /** The platform id of the created message. */
  platformMessageId: string;
}

/** Deliver one outbox message to the platform. Throws on any delivery failure. */
export interface OutboxSender {
  send(input: SendOutboxMessageInput): Promise<SendResult>;
}

// ---- MCP OAuth identity port (Section 32.5.2.1) -------------------------

/** A person's membership in the guild, as far as authorization cares. */
export interface DiscordMembership {
  /** The Discord user id — the subject of the token that follows. */
  userId: string;
  /**
   * Role ids held in the guild, or null when they could not be resolved. Null is
   * not an empty list: unresolved roles must fail closed, and `authorizeAdmin`
   * distinguishes the two.
   */
  roleIds: readonly string[] | null;
}

/** Why identifying the person failed. */
export type DiscordIdentityFailure =
  | 'code_exchange_failed'
  | 'not_a_guild_member'
  | 'membership_unavailable';

export type DiscordIdentityOutcome =
  | { ok: true; membership: DiscordMembership }
  | { ok: false; reason: DiscordIdentityFailure };

/** The seam: given Discord's code, say who the person is. */
export interface DiscordIdentityClient {
  identify(code: string): Promise<DiscordIdentityOutcome>;
}

// ---- Review cards (Section 25) --------------------------------------------

export interface ReviewProposalInput {
  proposalId: string;
  /** Short display id for the embed title (defaults to the proposal id prefix). */
  shortId?: string;
  /** Target channel label, e.g. `#product`. */
  targetLabel: string;
  /** Host-computed intervention score. */
  score: number;
  /** Scheduled reviews use an honest categorical assessment instead of a synthetic score. */
  assessment?: string;
  /** Host-owned routing reason. */
  reason: string;
  /** Optional model recommendation shown separately on secure review surfaces. */
  recommendationReason?: string;
  /** Safe proposed outbound text (already scope-cleared for the target). */
  proposedMessage: string;
  /** Permitted source links (masked), at most three (Section 24.5). */
  sources: readonly string[];
  /** Optional proposal expiry (Section 25: default 72h). */
  expiresAtMs?: number | null;
}

// ---- The chat-platform adapter (spec Section 5.3) ------------------------

/** Connection health that the status surfaces read. */
export interface PlatformHealthSnapshot {
  status?: string;
  ready?: boolean;
  pingMs?: number;
  lastEventAtMs?: number | null;
  reconnects?: number;
}

/** A live health source, updated by the adapter as events arrive. */
export interface PlatformHealthTracker {
  snapshot(): PlatformHealthSnapshot;
}

/** A connected platform session. */
export interface PlatformConnection {
  tracker?: PlatformHealthTracker;
  /** Disconnect from the platform (shutdown step 7). */
  destroy(): Promise<void>;
}

/** How the core learns about threads. */
export type ThreadDiscoveryMode =
  /** `listChannels` gives active threads only; the core pages the archive (Discord). */
  | { mode: 'archive_scan'; archive: ThreadArchiveSource }
  /**
   * `listChannels` gives every known thread; discovery closes any thread it omits.
   * The core repeats the full discovery at `rediscoveryIntervalMs`, so a boundary
   * change that arrives without an event is still applied (Slack).
   */
  | { mode: 'complete_snapshot'; rediscoveryIntervalMs: number };

export interface ProposalReviewDeliveryDeps {
  db: DatabaseSync;
  reviewChannelId: string;
  /** HMAC secret shared with the review controls (never logged). */
  secret: string;
  now: number;
}

export interface ChannelPolicyReviewDeliveryDeps {
  db: DatabaseSync;
  reviewChannelId: string;
  secret: string;
  now: () => number;
}

/** Neutral inputs for the proposal and channel-policy review controls. */
export interface ReviewControlDeps {
  db: DatabaseSync;
  workspaceId: string;
  secret: string;
  adminRoleIds: readonly string[];
  reviewChannelId: string | undefined;
  buildRecheck: (proposalId: string) => ApprovalPolicyRecheck;
  policy: () => ChannelPolicy;
  channelPolicySource: ChannelPolicySource;
  now: () => number;
}

/** Neutral inputs for the admin command surface (Section 27). */
export interface CommandDispatchDeps {
  ctx: BootstrapContext;
  buildApprovalRecheck: (proposalId: string) => ApprovalPolicyRecheck;
}

export interface ParsedMention {
  /** Raw matched token, e.g. `<@123>`, `<@&456>`, `@everyone`. */
  raw: string;
  kind: 'user' | 'role' | 'everyone' | 'here';
  /** Platform id for user/role mentions; undefined for everyone/here. */
  id?: string;
}

/** Text conventions of the active platform (Section 24.5). */
export interface PlatformFormat {
  /** Find user, role, and broadcast mentions in text. */
  parseMentions(content: string): ParsedMention[];
  /** True when text contains mention syntax that names an individual user. */
  hasIndividualMention(content: string): boolean;
}

/**
 * Everything the core needs from one chat platform. One adapter is active in a
 * process; `MNEME_PLATFORM` selects it (spec Section 5.3).
 */
export interface ChatPlatform {
  readonly id: PlatformId;
  readonly workspaceId: string;
  /** The bot's own user id on the platform. */
  readonly selfUserId: string;
  /** HMAC secret for review-card controls, derived from the bot token. */
  readonly reviewSecret: string;
  /** False when the platform credentials are not configured; the core then skips the live connection. */
  readonly hasCredentials: boolean;

  /** Register live ingestion, then connect. No event can arrive before the hooks are registered. */
  connect(ingestion: LiveIngestionDeps): Promise<PlatformConnection>;
  /** Register the admin command surface; a failure blocks readiness. */
  registerCommands(): Promise<{ ok: true } | { ok: false; message: string }>;
  registerCommandDispatch(deps: CommandDispatchDeps): void;
  registerReviewControls(deps: ReviewControlDeps): void;

  listChannels(): Promise<DiscoveredChannelDescriptor[]>;
  readonly threadDiscovery: ThreadDiscoveryMode;
  readonly history: BackfillMessageFetcher;
  readonly recentSent: RecentSentMessageLookup;

  readonly sender: OutboxSender;
  sendDirect(userId: string, text: string): Promise<void>;
  deliverProposalReview(input: ReviewProposalInput, deps: ProposalReviewDeliveryDeps): Promise<{ platformMessageId: string }>;
  reviewResolver(reviewChannelId: string): ReviewResolver;
  createChannelPolicyReviewDeliveryHandler(deps: ChannelPolicyReviewDeliveryDeps): JobHandler<'deliver_channel_policy_review'>;

  readonly oauthIdentity: DiscordIdentityClient;
  readonly format: PlatformFormat;
}
