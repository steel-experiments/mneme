// ABOUTME: Delivers outbox messages to Slack with chat.postMessage (spec Sections 10.1, 24.5).
// ABOUTME: Fails closed on excluded or archived targets; a reply anchor becomes a reply in its thread.
import type { DatabaseSync } from '../../db/database.js';
import { getChannel, type ChannelRow } from '../../db/repositories/channels.js';
import { getMessage } from '../../db/repositories/messages.js';
import { PermanentJobError, TransientJobError } from '../../jobs/errors.js';
import type { OutboxSender } from '../types.js';
import type { SlackApi } from './api.js';
import { parseSlackMessageId, parseSlackThreadRowId, slackMessageId } from './ids.js';
import { toSlackMrkdwn } from './mrkdwn.js';

/** The metadata event type that carries the outbox dedupe marker (plan 002 decision 13). */
export const OUTBOX_METADATA_EVENT_TYPE = 'mneme_outbox';

/** Slack error codes that retrying cannot fix. */
const PERMANENT_ERRORS = new Set([
  'channel_not_found', 'not_in_channel', 'is_archived', 'invalid_auth', 'account_inactive', 'missing_scope',
  'token_revoked', 'restricted_action', 'cant_reply_to_message', 'thread_not_found', 'msg_too_long',
  'no_text', 'invalid_blocks', 'team_access_not_granted', 'not_authed', 'ekm_access_denied',
]);

/** Map a Slack Web API error to the job error that the outbox worker classifies. */
export function classifySlackError(err: unknown): Error {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  const code = typeof data?.error === 'string' ? data.error : null;
  const message = code ? `slack ${code}` : err instanceof Error ? err.message : 'slack request failed';
  if (code !== null && PERMANENT_ERRORS.has(code)) return new PermanentJobError(message, { cause: err });
  // Rate limits, 5xx, network errors, and unknown codes are transient.
  return new TransientJobError(message, { cause: err });
}

/** The Slack target of one stored channel row. */
export interface SlackTarget {
  channel: string;
  threadTs?: string;
}

/** Resolve a stored channel row to a Slack channel and an optional thread. */
export function slackTarget(channelId: string): SlackTarget {
  const thread = parseSlackThreadRowId(channelId);
  return thread ? { channel: thread.channel, threadTs: thread.threadTs } : { channel: channelId };
}

function refuse(row: ChannelRow | undefined, id: string): string | null {
  if (!row || row.deleted_at_ms !== null) return `target ${id} is not a known channel`;
  if (row.platform_boundary === 'excluded') return `target ${id} is a Slack Connect channel`;
  if (row.visibility_class === 'excluded') return `target ${id} is excluded`;
  if (row.is_archived === 1) return `target ${id} is archived`;
  return null;
}

/**
 * Second guard after the policy checks: never post into a channel that is
 * unknown, excluded, archived, or shared with another organization. For a
 * thread row, the parent channel is checked too.
 */
export function slackSendRefusal(db: DatabaseSync, channelId: string): string | null {
  const row = getChannel(db, channelId);
  const own = refuse(row, channelId);
  if (own) return own;
  if (row!.is_thread === 1) {
    const parentId = row!.parent_id;
    if (!parentId) return `thread ${channelId} has no parent`;
    return refuse(getChannel(db, parentId), parentId);
  }
  return null;
}

/** The thread root for a reply to `anchorId` in the Slack channel `channel`. */
function anchorThreadTs(db: DatabaseSync, anchorId: string, channel: string): string {
  const parsed = parseSlackMessageId(anchorId);
  if (!parsed || parsed.channel !== channel) {
    throw new PermanentJobError(`reply anchor ${anchorId} is not in the target channel`);
  }
  const stored = getMessage(db, anchorId);
  if (!stored) throw new PermanentJobError(`reply anchor ${anchorId} is not stored`);
  const thread = parseSlackThreadRowId(stored.channel_id);
  return thread ? thread.threadTs : parsed.ts;
}

export interface SlackSenderDeps {
  api: SlackApi;
  db: () => DatabaseSync;
  teamDomain: () => string;
}

/**
 * The Slack outbox sender. The text goes through the mrkdwn converter, so no
 * mention can ping. A reply anchor posts into the anchor's thread; Mneme never
 * broadcasts a thread reply to the channel.
 */
export function createSlackSender(deps: SlackSenderDeps): OutboxSender {
  return {
    async send(input) {
      const db = deps.db();
      const refusal = slackSendRefusal(db, input.channelId);
      if (refusal) throw new PermanentJobError(`slack send refused: ${refusal}`);
      const target = slackTarget(input.channelId);
      let threadTs = target.threadTs;
      if (input.replyToMessageId) {
        const anchorRoot = anchorThreadTs(db, input.replyToMessageId, target.channel);
        if (threadTs !== undefined && threadTs !== anchorRoot) {
          throw new PermanentJobError(`reply anchor ${input.replyToMessageId} is in another thread`);
        }
        threadTs = anchorRoot;
      }
      try {
        const posted = await deps.api.postMessage({
          channel: target.channel,
          text: toSlackMrkdwn(input.content, { teamDomain: deps.teamDomain() }),
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(input.dedupeMarker
            ? { metadata: { event_type: OUTBOX_METADATA_EVENT_TYPE, event_payload: { marker: input.dedupeMarker } } }
            : {}),
        });
        if (!posted.ts) throw new TransientJobError('slack chat.postMessage returned no ts');
        return { platformMessageId: slackMessageId(target.channel, posted.ts) };
      } catch (err) {
        if (err instanceof PermanentJobError || err instanceof TransientJobError) throw err;
        throw classifySlackError(err);
      }
    },
  };
}
