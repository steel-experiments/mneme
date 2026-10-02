// ABOUTME: Maps Slack Socket Mode envelopes to the neutral live ingestion operations (spec Section 9.3).
// ABOUTME: Foreign-team and unknown-channel events are dropped; a shared channel keeps only deletes; channel changes re-read the channel.
import type { DatabaseSync } from '../../db/database.js';
import { getChannel, tombstoneChannel, upsertChannel } from '../../db/repositories/channels.js';
import { getMessage } from '../../db/repositories/messages.js';
import { getSyncCursor } from '../../db/repositories/sync-cursors.js';
import {
  ingestMessageCreate,
  ingestMessageDelete,
  ingestMessageUpdate,
  ingestReactionAdd,
  ingestReactionRemove,
  type IngestOptions,
} from '../../ingestion/ingest.js';
import type { LiveIngestionDeps } from '../../ingestion/live.js';
import { backfillJobKey } from '../../ingestion/sync.js';
import { channelIngestionIneligibilityReason } from '../../ingestion/ingestion-eligibility.js';
import { isMnemeTestSurface } from '../../ingestion/test-channels.js';
import { enqueue } from '../../jobs/queue.js';
import type { SlackApi, SlackObject } from './api.js';
import { channelInputFromDescriptor, ensureThreadRow, excludeSharedChannel, markChannelUnavailable, refreshThreadRows } from './channels.js';
import type { SlackEnvelope } from './connection.js';
import { descriptorFromConversation } from './discovery.js';
import { isSlackChannelId, slackMessageId } from './ids.js';
import { isStoredSlackMessage, normalizeSlackMessage, normalizeSlackMessageUpdate, slackDeletedMessage } from './normalize.js';

export interface SlackLiveContext {
  workspaceId: string;
  selfUserId: string;
  api: SlackApi;
  deps: LiveIngestionDeps;
  /** Queue history import for a channel the bot joins (`FULL_HISTORY`). */
  enqueueHistory: boolean;
  /** Unknown subtypes already logged once. */
  seenSubtypes?: Set<string>;
}

export interface SlackEventOutcome {
  handled: boolean;
  reason?: 'not_events_api' | 'team_mismatch' | 'shared_channel' | 'unknown_channel' | 'ignored_subtype'
    | 'policy' | 'missing_fields' | 'unknown_message' | 'not_an_edit' | 'missing_message' | 'not_the_bot'
    | 'unknown_event';
}

const CHANNEL_REFRESH_EVENTS = new Set([
  'channel_created', 'channel_rename', 'channel_archive', 'channel_unarchive', 'group_rename', 'group_archive',
  'group_unarchive', 'channel_unshared',
]);

function optsOf(deps: LiveIngestionDeps): IngestOptions {
  return typeof deps.opts === 'function' ? deps.opts() : deps.opts;
}

function channelIdOf(event: SlackObject): string | null {
  const ch = event.channel;
  if (typeof ch === 'string') return ch;
  if (ch && typeof ch === 'object' && typeof (ch as SlackObject).id === 'string') return String((ch as SlackObject).id);
  return null;
}

/** Re-read one channel and store what the bot can see now. A non-member channel becomes unavailable. */
export async function refreshSlackChannel(
  ctx: SlackLiveContext,
  channel: string,
  change: 'create' | 'update',
): Promise<SlackEventOutcome> {
  const { db } = ctx.deps;
  const info = await ctx.api.conversationInfo(channel);
  const now = optsOf(ctx.deps).now;
  const descriptor = info ? descriptorFromConversation(info) : null;
  if (!descriptor) {
    if (getChannel(db, channel)) {
      markChannelUnavailable(db, channel, now);
      ctx.deps.onChannelChange?.('update', channel);
    }
    return { handled: true };
  }
  const input = channelInputFromDescriptor(descriptor, ctx.workspaceId, now);
  const known = getChannel(db, channel) !== undefined;
  upsertChannel(db, ctx.deps.applyChannelPolicy ? ctx.deps.applyChannelPolicy(input)
    : { ...input, ingestEnabled: false, visibilityClass: 'excluded', allowInterventions: false });
  refreshThreadRows(db, channel, ctx.deps.applyChannelPolicy, now);
  ctx.deps.onChannelChange?.(known ? change : 'create', channel);
  queueHistory(ctx, db, channel, now);
  return { handled: true };
}

/** Re-read a channel after it was excluded as shared. A failure is logged; the exclusion stays. */
async function refreshAfterShare(ctx: SlackLiveContext, channel: string): Promise<void> {
  try {
    await refreshSlackChannel(ctx, channel, 'update');
  } catch (err) {
    ctx.deps.logger?.warn({ event: 'slack.shared_channel_refresh_failed', channelId: channel,
      err: err instanceof Error ? err.message : String(err) }, 'shared channel re-read failed; the channel stays excluded');
  }
}

function queueHistory(ctx: SlackLiveContext, db: DatabaseSync, channel: string, now: number): void {
  if (!ctx.enqueueHistory || isMnemeTestSurface(db, channel)) return;
  const row = getChannel(db, channel);
  if (!row || row.ingest_enabled !== 1 || row.visibility_class === 'excluded') return;
  if (getSyncCursor(db, channel)?.historyComplete) return;
  enqueue(db, { type: 'backfill_channel', payload: { channelId: channel }, uniqueKey: backfillJobKey(channel), now });
}

function handleMessageCreate(ctx: SlackLiveContext, event: SlackObject, channel: string): SlackEventOutcome {
  const { db } = ctx.deps;
  const parent = getChannel(db, channel);
  if (!parent || parent.deleted_at_ms !== null) return { handled: false, reason: 'unknown_channel' };
  const msg = normalizeSlackMessage(event, channel, ctx.workspaceId, ctx.selfUserId);
  if (!msg) {
    const subtype = typeof event.subtype === 'string' ? event.subtype : null;
    if (subtype && !isStoredSlackMessage(event) && !ctx.seenSubtypes?.has(subtype)) {
      ctx.seenSubtypes?.add(subtype);
      ctx.deps.logger?.debug({ event: 'slack.subtype_ignored', subtype }, 'slack message subtype ignored');
    }
    return { handled: false, reason: 'ignored_subtype' };
  }
  const opts = optsOf(ctx.deps);
  if (msg.channelId !== channel) {
    const thread = ensureThreadRow(db, channel, String(event.thread_ts), ctx.deps.applyChannelPolicy, opts.now);
    if (!thread) return { handled: false, reason: 'unknown_channel' };
    if (thread.created) ctx.deps.onChannelChange?.('create', thread.id);
  }
  if (ctx.deps.shouldIngestMessage && !ctx.deps.shouldIngestMessage(msg.channelId, msg)) {
    return { handled: false, reason: 'policy' };
  }
  ingestMessageCreate(db, msg, opts);
  const stored = getMessage(db, msg.id);
  if (stored && stored.deleted_at_ms === null) ctx.deps.onMessageCreate?.(msg);
  return { handled: true };
}

function handleMessageChanged(ctx: SlackLiveContext, event: SlackObject): SlackEventOutcome {
  const { db } = ctx.deps;
  const patch = normalizeSlackMessageUpdate(event, ctx.workspaceId);
  if (!patch) return { handled: false, reason: 'missing_fields' };
  const stored = getMessage(db, patch.id);
  if (!stored) return { handled: false, reason: 'unknown_message' };
  // An excluded channel (for example a shared one) keeps no new content, edits included.
  const ineligible = channelIngestionIneligibilityReason(db, stored.channel_id);
  if (ineligible !== null && ineligible !== 'control_surface') return { handled: false, reason: 'policy' };
  // A reply delete updates the root's reply count, and a broadcast post repeats
  // the broadcast. Neither is a content edit.
  const message = event.message as SlackObject;
  if (message.edited === undefined && stored.content === patch.content) return { handled: false, reason: 'not_an_edit' };
  const result = ingestMessageUpdate(db, patch, optsOf(ctx.deps));
  return result.unknownMessage ? { handled: false, reason: 'unknown_message' } : { handled: true };
}

function handleReaction(ctx: SlackLiveContext, event: SlackObject, add: boolean): SlackEventOutcome {
  const item = event.item as SlackObject | undefined;
  if (!item || item.type !== 'message' || typeof item.channel !== 'string' || typeof item.ts !== 'string'
    || typeof event.user !== 'string' || typeof event.reaction !== 'string') {
    return { handled: false, reason: 'missing_fields' };
  }
  const messageId = slackMessageId(item.channel, item.ts);
  if (!getMessage(ctx.deps.db, messageId)) return { handled: false, reason: 'missing_message' };
  const input = { messageId, userId: event.user, emojiKey: event.reaction, emojiName: event.reaction };
  if (add) ingestReactionAdd(ctx.deps.db, input, optsOf(ctx.deps));
  else ingestReactionRemove(ctx.deps.db, input, optsOf(ctx.deps));
  return { handled: true };
}

/** Tombstone a deleted message. Applies in every channel state, excluded channels included. */
function applyDelete(ctx: SlackLiveContext, event: SlackObject): SlackEventOutcome {
  const deleted = slackDeletedMessage(event);
  if (!deleted) return { handled: false, reason: 'missing_fields' };
  ingestMessageDelete(ctx.deps.db, deleted.id, optsOf(ctx.deps), deleted.channelId);
  return { handled: true };
}

/** The bot left or was removed: the channel and its threads become unavailable. */
function leaveChannel(ctx: SlackLiveContext, channel: string | null): SlackEventOutcome {
  if (!channel) return { handled: false, reason: 'missing_fields' };
  if (getChannel(ctx.deps.db, channel)) {
    markChannelUnavailable(ctx.deps.db, channel, optsOf(ctx.deps).now);
    ctx.deps.onChannelChange?.('update', channel);
  }
  return { handled: true };
}

/** Handle one acknowledged envelope. Never opens network I/O inside a transaction. */
export async function handleSlackEnvelope(ctx: SlackLiveContext, envelope: SlackEnvelope): Promise<SlackEventOutcome> {
  if (envelope.type !== 'events_api') return { handled: false, reason: 'not_events_api' };
  const body = envelope.body;
  if (body.team_id !== ctx.workspaceId) return { handled: false, reason: 'team_mismatch' };
  const event = body.event as SlackObject | undefined;
  if (!event || typeof event.type !== 'string') return { handled: false, reason: 'missing_fields' };
  if (typeof event.team === 'string' && event.team !== ctx.workspaceId) return { handled: false, reason: 'team_mismatch' };
  const channel = channelIdOf(event);
  const { db } = ctx.deps;

  if (body.is_ext_shared_channel === true) {
    // The channel is shared with another organization: drop the content,
    // exclude the channel at once, then re-read it.
    if (channel && excludeSharedChannel(db, channel, optsOf(ctx.deps).now)) {
      ctx.deps.onChannelChange?.('update', channel);
      await refreshAfterShare(ctx, channel);
    }
    // A delete still applies: content that users remove must not stay stored.
    if (event.type === 'message' && event.subtype === 'message_deleted') return applyDelete(ctx, event);
    return { handled: false, reason: 'shared_channel' };
  }

  switch (event.type) {
    case 'message': {
      if (!channel || !isSlackChannelId(channel)) return { handled: false, reason: 'missing_fields' };
      if (event.subtype === 'message_changed') return handleMessageChanged(ctx, event);
      if (event.subtype === 'message_deleted') return applyDelete(ctx, event);
      return handleMessageCreate(ctx, event, channel);
    }
    case 'reaction_added':
      return handleReaction(ctx, event, true);
    case 'reaction_removed':
      return handleReaction(ctx, event, false);
    case 'member_joined_channel':
      if (event.user !== ctx.selfUserId || !channel) return { handled: false, reason: 'not_the_bot' };
      return refreshSlackChannel(ctx, channel, 'create');
    case 'member_left_channel':
      if (event.user !== ctx.selfUserId) return { handled: false, reason: 'not_the_bot' };
      return leaveChannel(ctx, channel);
    case 'channel_left':
    case 'group_left':
      return leaveChannel(ctx, channel);
    case 'channel_shared':
      if (!channel) return { handled: false, reason: 'missing_fields' };
      if (excludeSharedChannel(db, channel, optsOf(ctx.deps).now)) {
        ctx.deps.onChannelChange?.('update', channel);
        await refreshAfterShare(ctx, channel);
      }
      return { handled: true };
    case 'channel_deleted':
    case 'group_deleted':
      if (!channel) return { handled: false, reason: 'missing_fields' };
      if (getChannel(db, channel)) {
        markChannelUnavailable(db, channel, optsOf(ctx.deps).now);
        tombstoneChannel(db, channel, optsOf(ctx.deps).now);
        ctx.deps.onChannelChange?.('delete', channel);
      }
      return { handled: true };
    default:
      if (CHANNEL_REFRESH_EVENTS.has(event.type) && channel) return refreshSlackChannel(ctx, channel, 'update');
      return { handled: false, reason: 'unknown_event' };
  }
}
