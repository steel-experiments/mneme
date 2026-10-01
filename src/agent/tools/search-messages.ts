import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { type Static } from '@sinclair/typebox';
import { SearchMessagesToolInput } from '../schemas.js';
import {
  searchMessages,
  type MessageSearchResult,
} from '../../db/repositories/message-search.js';
import {
  fitItemsToBudget,
  type AgentRunContext,
} from '../run-context.js';
import { formatTimestamp, parseOptionalIso } from './render.js';

/**
 * `search_messages` — FTS over permitted messages (Sections 7.3, 21.2, 22.1).
 *
 * The host injects the run's {@link RetrievalGrant} as the scope ceiling; any
 * channel filter the model supplies can only narrow it. Results are clamped to
 * the per-call limit and then to the remaining per-run character budget, and
 * every exposed channel is recorded on the run's retrieval provenance.
 */
export interface SearchMessagesDetails {
  resultIds: string[];
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `Full-text search over messages the current run is permitted to see.
You may narrow with channelIds/authorIds/time window, but you cannot widen scope.
Returns message id, timestamp, author, channel, snippet, reactions, and a Discord link.`;

function renderMessage(r: MessageSearchResult): string {
  const reactions = r.reactionTotal > 0 ? ` reactions:${r.reactionTotal}` : '';
  return [
    `[${r.messageId}] ${formatTimestamp(r.createdAtMs)} ${r.authorDisplayName} in #${r.channelId}${reactions}`,
    r.snippet,
    r.link,
  ].join('\n');
}

export function createSearchMessagesTool(
  ctx: AgentRunContext,
): AgentTool<typeof SearchMessagesToolInput, SearchMessagesDetails> {
  return {
    name: 'search_messages',
    label: 'Search messages',
    description: DESCRIPTION,
    parameters: SearchMessagesToolInput,
    async execute(_toolCallId, params: Static<typeof SearchMessagesToolInput>): Promise<
      AgentToolResult<SearchMessagesDetails>
    > {
      const afterMs = parseOptionalIso(params.after, 'after');
      const beforeMs = parseOptionalIso(params.before, 'before');

      const results = searchMessages(ctx.db, ctx.grant, {
        query: params.query,
        channelIds: params.channelIds,
        authorIds: params.authorIds,
        afterMs,
        beforeMs,
        limit: params.limit,
        now: ctx.retrieval.nowMs,
      });

      const fit = fitItemsToBudget(
        ctx.retrieval,
        results,
        renderMessage,
        (n) => `[${n} more result(s) omitted — per-run character budget reached]`,
      );
      for (const r of fit.included) {
        ctx.retrieval.recordMessage(r.messageId, r.channelId, 'message_search');
      }

      const header =
        fit.included.length > 0
          ? `${fit.included.length} message(s):`
          : 'No permitted messages matched.';
      const text = `${header}\n${fit.lines.join('\n')}`;

      return {
        content: [{ type: 'text', text } as TextContent],
        details: {
          resultIds: fit.included.map((r) => r.messageId),
          truncated: fit.truncated,
          charsExposed: ctx.retrieval.charsExposed,
        },
      };
    },
  };
}
