// ABOUTME: The `search_archive_messages` agent tool: full-text search over servable org messages in the platform archive (plan 011).
// ABOUTME: Results use host headers and untrusted frames, count against the run budget, and are recorded as archive provenance.
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import type { Static } from '@sinclair/typebox';
import { SearchArchiveMessagesToolInput } from '../schemas.js';
import { searchArchiveMessages } from '../../platform-archive/read.js';
import { fitItemsToBudget, type AgentRunContext } from '../run-context.js';
import { parseOptionalIso } from './render.js';
import { ARCHIVE_TOOL_NOTE, renderArchiveMessage } from './archive-render.js';

export interface SearchArchiveMessagesDetails {
  resultIds: string[];
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `Full-text search over the read-only archive of the previous chat platform.
${ARCHIVE_TOOL_NOTE}
Returns archive id, date, channel, link, author, and a snippet.`;

export function createSearchArchiveMessagesTool(
  ctx: AgentRunContext,
): AgentTool<typeof SearchArchiveMessagesToolInput, SearchArchiveMessagesDetails> {
  return {
    name: 'search_archive_messages',
    label: 'Search archive messages',
    description: DESCRIPTION,
    parameters: SearchArchiveMessagesToolInput,
    async execute(_toolCallId, params: Static<typeof SearchArchiveMessagesToolInput>): Promise<
      AgentToolResult<SearchArchiveMessagesDetails>
    > {
      const results = ctx.archive
        ? searchArchiveMessages(ctx.archive, {
          query: params.query,
          afterMs: parseOptionalIso(params.after, 'after'),
          beforeMs: parseOptionalIso(params.before, 'before'),
          limit: params.limit,
        })
        : [];
      const fit = fitItemsToBudget(
        ctx.retrieval,
        results,
        (row) => renderArchiveMessage(row),
        (n) => `[${n} more archive result(s) omitted — per-run character budget reached]`,
      );
      for (const row of fit.included) ctx.retrieval.recordArchiveMessage(row.id);
      const header = fit.included.length > 0
        ? `${fit.included.length} archive message(s):`
        : 'No archive messages matched.';
      return {
        content: [{ type: 'text', text: `${header}\n${fit.lines.join('\n')}` } as TextContent],
        details: {
          resultIds: fit.included.map((row) => row.id),
          truncated: fit.truncated,
          charsExposed: ctx.retrieval.charsExposed,
        },
      };
    },
  };
}
