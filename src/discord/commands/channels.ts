import { type DatabaseSync } from '../../db/database.js';
import { prepareCached } from '../../db/repositories/util.js';
import { getLatestAccessAudit } from '../../db/repositories/channel-access.js';
import { authorizeAdmin, type AuthorizationReason } from '../authorization.js';
import { recordAdminEvent } from '../../db/repositories/admin-events.js';

/**
 * `/mneme channels` (Sections 27, 33).
 *
 * Lists the visible channels an authorized administrator need a digest of: policy
 * (visibility) class, ingestion flag, intervention allowance, sync/history state,
 * and the latest permission warning from the access audit (Section 6.3).
 * Results are paginated to respect Discord response limits, and every line
 * carries only ids, flags, and a short warning label — never message content,
 * topic text, or credentials (Section 33).
 *
 * Free of discord.js types: the dispatcher binds the interaction to
 * {@link handleChannelsCommand} and replies with {@link formatChannelsReply}.
 */

/** One row of the channels digest. */
export interface ChannelSummary {
  id: string;
  name: string | null;
  visibilityClass: string;
  ingestEnabled: boolean;
  allowInterventions: boolean;
  isThread: boolean;
  isArchived: boolean;
  /** Sync-cursor state, or null when the channel has never been synced. */
  syncState: string | null;
  /** Whether history is fully backfilled, or null when no cursor exists. */
  historyComplete: boolean | null;
  /** Latest access-audit warning, or null when the channel is fully capable. */
  warning: string | null;
  /** Active runtime classification state, or null when YAML is authoritative. */
  policyReview: string | null;
}

export interface CollectChannelsOptions {
  guildId: string;
  /** 1-based page number (default 1). */
  page?: number;
  /** Page size (default 25, capped at 100). */
  pageSize?: number;
  now: number;
}

export interface ChannelsReport {
  now: number;
  /** Total non-deleted channels in the guild (across all pages). */
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  channels: ChannelSummary[];
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Collect one page of the channels digest. Channels are ordered by name then id
 * for stable pagination; each row joins its sync cursor and looks up the latest
 * access-audit warning. Deleted channels are excluded.
 */
export function collectChannelsReport(db: DatabaseSync, options: CollectChannelsOptions): ChannelsReport {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.max(1, Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  const offset = (page - 1) * pageSize;
  const now = options.now;

  const total = (
    prepareCached(
      db,
      'channels.count',
      'SELECT COUNT(*) AS n FROM channels WHERE workspace_id = ? AND deleted_at_ms IS NULL',
    ).get(options.guildId) as { n: number } | undefined
  )?.n ?? 0;

  const rows = prepareCached(
    db,
    'channels.page',
    `SELECT c.id, c.name, c.visibility_class, c.ingest_enabled, c.allow_interventions,
            c.is_thread, c.is_archived, sc.state AS sync_state, sc.history_complete AS history_complete,
            cpr.status AS policy_review
       FROM channels c
       LEFT JOIN sync_cursors sc ON sc.channel_id = c.id
       LEFT JOIN channel_policy_reviews cpr ON cpr.channel_id=c.id AND cpr.status<>'superseded'
      WHERE c.workspace_id = ? AND c.deleted_at_ms IS NULL
      ORDER BY COALESCE(c.name, c.id), c.id
      LIMIT ? OFFSET ?`,
  ).all(options.guildId, pageSize, offset) as Array<{
    id: string;
    name: string | null;
    visibility_class: string;
    ingest_enabled: number;
    allow_interventions: number;
    is_thread: number;
    is_archived: number;
    sync_state: string | null;
    history_complete: number | null;
    policy_review: string | null;
  }>;

  const channels: ChannelSummary[] = rows.map((row) => {
    const audit = getLatestAccessAudit(db, row.id);
    return {
      id: row.id,
      name: row.name,
      visibilityClass: row.visibility_class,
      ingestEnabled: row.ingest_enabled === 1,
      allowInterventions: row.allow_interventions === 1,
      isThread: row.is_thread === 1,
      isArchived: row.is_archived === 1,
      syncState: row.sync_state,
      historyComplete: row.history_complete === null ? null : row.history_complete === 1,
      warning: audit?.warning ?? null,
      policyReview: row.policy_review,
    };
  });

  return {
    now,
    total,
    page,
    pageSize,
    hasMore: total > offset + channels.length,
    channels,
  };
}

export interface HandleChannelsInput {
  actorUserId: string;
  guildId: string;
  /** The caller's role ids, or null when unresolved (fail-closed). */
  memberRoleIds: readonly string[] | null;
  /** 1-based page number (default 1). */
  page?: number;
}

export interface HandleChannelsDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  /** Page size (default 25, capped at 100). */
  pageSize?: number;
  /** Override the collector (tests). Defaults to {@link collectChannelsReport}. */
  collect?: () => ChannelsReport;
}

export type ChannelsOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'done'; report: ChannelsReport };

/** Run `/mneme channels`. Authorization is checked first and audited on denial. */
export function handleChannelsCommand(input: HandleChannelsInput, deps: HandleChannelsDeps): ChannelsOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!outcome.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'channels',
      details: { authorized: false, reason: outcome.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: outcome.reason };
  }
  recordAdminEvent(deps.db, {
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'channels',
    details: { authorized: true, page: input.page ?? 1 },
    createdAtMs: deps.nowMs,
  });
  const report = deps.collect
    ? deps.collect()
    : collectChannelsReport(deps.db, {
        guildId: input.guildId,
        page: input.page,
        pageSize: deps.pageSize,
        now: deps.nowMs,
      });
  return { kind: 'done', report };
}

/**
 * Format an ephemeral channels reply. Each line is short (id prefix, name, class,
 * flags, warning flag); when the page is not the last, a footer notes more pages.
 * Contains no message content, topics, or secrets.
 */
export function formatChannelsReply(outcome: ChannelsOutcome): string {
  if (outcome.kind === 'not_authorized') {
    return 'You are not authorized to list channels.';
  }
  const r = outcome.report;
  const lines = [`channels: ${r.total} total (page ${r.page}${r.hasMore ? '+, more available' : ''})`];
  for (const c of r.channels) {
    const flags = [
      c.visibilityClass,
      c.ingestEnabled ? 'ingest' : 'no-ingest',
      c.allowInterventions ? 'intervene' : null,
      c.isThread ? 'thread' : null,
      c.isArchived ? 'archived' : null,
      c.syncState ?? 'unsynced',
      c.historyComplete === false ? 'incomplete' : null,
      c.warning ? '⚠access' : null,
      c.policyReview === 'pending' ? 'review-pending' : c.policyReview ? `reviewed:${c.policyReview}` : null,
    ]
      .filter((x): x is string => x !== null);
    const name = c.name ?? '(unnamed)';
    lines.push(`${shortId(c.id)} ${name} · ${flags.join(' ')}`);
  }
  if (r.hasMore) {
    lines.push(`Use \`/mneme channels\` page ${r.page + 1} for more.`);
  }
  // Cap the reply length defensively; Discord caps an ephemeral followup body.
  return lines.join('\n').slice(0, 1900);
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-6) : id;
}
