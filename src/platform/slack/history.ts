// ABOUTME: Pages Slack channel and thread history for backfill and reconcile (spec Sections 9.5, 9.6).
// ABOUTME: Channel pages come from conversations.history; thread pages from conversations.replies, without the root.
import type { DatabaseSync } from '../../db/database.js';
import type { Logger } from '../../logger.js';
import { getSyncCursor } from '../../db/repositories/sync-cursors.js';
import type { BackfillMessageFetcher } from '../../ingestion/backfill.js';
import { channelIngestionIneligibilityReason } from '../../ingestion/ingestion-eligibility.js';
import { backfillJobKey } from '../../ingestion/sync.js';
import { enqueue } from '../../jobs/queue.js';
import { RECONCILE_CHANNEL_KEY } from '../../jobs/scheduler.js';
import type { NormalizedMessage } from '../types.js';
import type { SlackApi, SlackObject } from './api.js';
import { ensureThreadRow, excludeSharedChannel, type ApplyChannelPolicy } from './channels.js';
import { isSlackReply, parseSlackMessageId, parseSlackThreadRowId, slackMessageId } from './ids.js';
import { isStoredSlackMessage, normalizeSlackMessage, slackForeignTeam } from './normalize.js';

/** The largest page Slack returns for internal apps (spec Section 6.7.1). */
export const SLACK_MAX_PAGE = 999;

/** One fetched message with its source channel; `id` is the stored message id the cursors use. */
export interface SlackHistoryItem {
  id: string;
  channel: string;
  message: SlackObject;
}

export interface SlackHistoryDeps {
  api: SlackApi;
  workspaceId: string;
  selfUserId: () => string;
  db: () => DatabaseSync;
  applyChannelPolicy: () => ApplyChannelPolicy;
  /** `FULL_HISTORY`: import a new thread's whole history, or only reconcile it. */
  enqueueHistory: boolean;
  now: () => number;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * A fetched page has a message from another team: the channel is shared.
 * Exclude it and its threads at once. The caller discards the whole page, so
 * nothing from it is stored (spec Section 7.1).
 */
function foreignTeamInPage(deps: SlackHistoryDeps, channel: string, messages: SlackObject[]): boolean {
  if (!messages.some((m) => slackForeignTeam(m, deps.workspaceId) !== null)) return false;
  excludeSharedChannel(deps.db(), channel, deps.now());
  deps.logger?.warn({ event: 'slack.history_foreign_team', channelId: channel },
    'history page has a message from another team; the channel is excluded as shared');
  return true;
}

function item(channel: string, message: SlackObject): SlackHistoryItem {
  return { id: slackMessageId(channel, String(message.ts)), channel, message };
}

function newestStoredReplyTs(db: DatabaseSync, threadRowId: string): string | null {
  const row = db.prepare('SELECT MAX(id) AS id FROM messages WHERE channel_id = ?').get(threadRowId) as { id: string | null };
  return row.id ? parseSlackMessageId(row.id)?.ts ?? null : null;
}

/**
 * A thread root seen in channel history. Store its thread row, then queue the
 * thread's history (first time), or a reconcile when it has replies that are
 * newer than the newest stored reply (for example replies made while Mneme was
 * offline). Each job has a unique key, so a thread is queued once.
 */
function noteThreadRoot(deps: SlackHistoryDeps, channel: string, root: SlackObject): void {
  if (typeof root.reply_count !== 'number' || root.reply_count <= 0 || root.thread_ts !== root.ts) return;
  const db = deps.db();
  const now = deps.now();
  const thread = ensureThreadRow(db, channel, String(root.ts), deps.applyChannelPolicy(), now);
  if (!thread || channelIngestionIneligibilityReason(db, thread.id) !== null) return;
  const complete = getSyncCursor(db, thread.id)?.historyComplete === true;
  if (deps.enqueueHistory && !complete) {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: thread.id }, uniqueKey: backfillJobKey(thread.id), now });
    return;
  }
  const latest = typeof root.latest_reply === 'string' ? root.latest_reply : null;
  const newest = newestStoredReplyTs(db, thread.id);
  if (latest !== null && (newest === null || latest > newest)) {
    enqueue(db, { type: 'reconcile_channel', payload: { channelId: thread.id }, uniqueKey: RECONCILE_CHANNEL_KEY(thread.id), now });
  }
}

/**
 * Up to `limit` stored messages older than `beforeTs`, newest first. Replies
 * and broadcast replies are left out: they belong to their thread (plan 002
 * decision 4). Ignored subtypes are left out too, and paging continues so a
 * short result always means the end of history.
 */
async function channelPage(deps: SlackHistoryDeps, channel: string, beforeTs: string | undefined, limit: number) {
  const kept: SlackHistoryItem[] = [];
  let latest = beforeTs;
  for (;;) {
    const page = await deps.api.history({ channel, latest, inclusive: false, limit: Math.min(SLACK_MAX_PAGE, limit) });
    if (page.messages.length === 0) break;
    if (foreignTeamInPage(deps, channel, page.messages)) return [];
    for (const message of page.messages) {
      latest = String(message.ts);
      if (isSlackReply(message) || !isStoredSlackMessage(message)) continue;
      noteThreadRoot(deps, channel, message);
      kept.push(item(channel, message));
      if (kept.length >= limit) return kept;
    }
    if (!page.hasMore) break;
  }
  return kept;
}

/** Up to `limit` replies older than `beforeTs`, newest first. The root stays in the parent channel. */
async function threadPage(deps: SlackHistoryDeps, channel: string, threadTs: string, beforeTs: string | undefined, limit: number) {
  const replies: SlackHistoryItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.api.replies({ channel, ts: threadTs, latest: beforeTs, inclusive: false, limit: Math.min(SLACK_MAX_PAGE, limit), cursor });
    if (foreignTeamInPage(deps, channel, page.messages)) return [];
    for (const message of page.messages) {
      if (message.ts === threadTs || !isStoredSlackMessage(message)) continue;
      replies.push(item(channel, message));
    }
    cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
  } while (cursor);
  replies.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return replies.slice(0, limit);
}

export function createSlackHistory(deps: SlackHistoryDeps): BackfillMessageFetcher {
  return {
    async fetchMessages(channelId, before, limit) {
      const beforeTs = before ? parseSlackMessageId(before)?.ts : undefined;
      const thread = parseSlackThreadRowId(channelId);
      return thread
        ? threadPage(deps, thread.channel, thread.threadTs, beforeTs, limit)
        : channelPage(deps, channelId, beforeTs, limit);
    },
    async fetchMessage(channelId, messageId) {
      const target = parseSlackMessageId(messageId);
      if (!target) return null;
      const thread = parseSlackThreadRowId(channelId);
      const page = thread
        ? await deps.api.replies({ channel: thread.channel, ts: thread.threadTs, latest: target.ts, oldest: target.ts, inclusive: true, limit: 1 })
        : await deps.api.history({ channel: target.channel, latest: target.ts, oldest: target.ts, inclusive: true, limit: 1 });
      const found = page.messages.find((m) => m.ts === target.ts);
      if (!found || foreignTeamInPage(deps, target.channel, [found])) return null;
      return item(target.channel, found);
    },
    normalize(raw): NormalizedMessage {
      const entry = raw as SlackHistoryItem;
      const msg = entry && typeof entry === 'object' && entry.message
        ? normalizeSlackMessage(entry.message, entry.channel, deps.workspaceId, deps.selfUserId())
        : null;
      if (!msg) throw new Error('normalizeSlackMessage: the message is not a stored Slack message');
      return msg;
    },
  };
}
