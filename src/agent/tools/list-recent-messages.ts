import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { type Static } from '@sinclair/typebox';
import { ListRecentMessagesToolInput } from '../schemas.js';
import {
  listRecentMessages,
  type RecentMessageResult,
} from '../../db/repositories/message-search.js';
import { fitItemsToBudget, type AgentRunContext } from '../run-context.js';
import { formatTimestamp, parseOptionalIso } from './render.js';

export interface ListRecentMessagesDetails {
  resultIds: string[];
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `List newest permitted messages without a keyword query.
Use this for recaps, catch-ups, activity summaries, and explicit time-window questions.
Set after/before from the user's requested interval. Results are newest first; paginate
older results by setting beforeMessageId to the oldest returned message id. Leave channelIds
unset for an unqualified catch-up so the host searches the full permitted scope. The target
conversation is only where the answer will be delivered; it is not an implied channel filter.
Set channelIds only when the user explicitly requests specific channels. You may narrow scope
with channelIds or authorIds, but you cannot widen it.`;

function renderMessage(r: RecentMessageResult): string {
  const reactions = r.reactionTotal > 0 ? ` reactions:${r.reactionTotal}` : '';
  return [
    `[${r.messageId}] ${formatTimestamp(r.createdAtMs)} ${r.authorDisplayName} in #${r.channelName}${reactions}`,
    r.content,
    r.link,
  ].join('\n');
}

export function createListRecentMessagesTool(
  ctx: AgentRunContext,
): AgentTool<typeof ListRecentMessagesToolInput, ListRecentMessagesDetails> {
  return {
    name: 'list_recent_messages',
    label: 'List recent messages',
    description: DESCRIPTION,
    parameters: ListRecentMessagesToolInput,
    async execute(_toolCallId, params: Static<typeof ListRecentMessagesToolInput>): Promise<
      AgentToolResult<ListRecentMessagesDetails>
    > {
      const afterMs = parseOptionalIso(params.after, 'after');
      const beforeMs = parseOptionalIso(params.before, 'before');
      const results = listRecentMessages(ctx.db, ctx.grant, {
        channelIds: params.channelIds,
        authorIds: params.authorIds,
        afterMs,
        beforeMs,
        beforeMessageId: params.beforeMessageId,
        limit: params.limit,
      });
      const fit = fitItemsToBudget(
        ctx.retrieval,
        results,
        renderMessage,
        (n) => `[${n} more result(s) omitted — per-run character budget reached]`,
      );
      for (const result of fit.included) {
        ctx.retrieval.recordMessage(result.messageId, result.channelId, 'message_list');
      }
      const header = fit.included.length > 0
        ? `${fit.included.length} recent message(s), newest first:`
        : 'No permitted messages matched the requested window.';
      const oldest = fit.included.at(-1);
      const pagination = oldest && results.length >= (params.limit ?? 10)
        ? `\nMore messages may exist. Continue with beforeMessageId:${oldest.messageId}.`
        : '';
      return {
        content: [{ type: 'text', text: `${header}\n${fit.lines.join('\n')}${pagination}` } as TextContent],
        details: {
          resultIds: fit.included.map((result) => result.messageId),
          truncated: fit.truncated,
          charsExposed: ctx.retrieval.charsExposed,
        },
      };
    },
  };
}
