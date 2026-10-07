// ABOUTME: The `search_archive_memories` agent tool: servable org memories from the platform archive (plan 011).
// ABOUTME: Archive memories are history; they never become, update, or supersede live memories.
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import type { Static } from '@sinclair/typebox';
import { SearchArchiveMemoriesToolInput } from '../schemas.js';
import { searchArchiveMemories } from '../../platform-archive/read.js';
import { fitItemsToBudget, type AgentRunContext } from '../run-context.js';
import { ARCHIVE_TOOL_NOTE, renderArchiveMemory } from './archive-render.js';

export interface SearchArchiveMemoriesDetails {
  resultIds: string[];
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `Search the organization memories kept in the read-only archive of the previous chat platform.
${ARCHIVE_TOOL_NOTE}
Without a query, lists the most recently confirmed archive memories. Archive memories cannot be
updated, superseded, or used as evidence for a new memory.`;

export function createSearchArchiveMemoriesTool(
  ctx: AgentRunContext,
): AgentTool<typeof SearchArchiveMemoriesToolInput, SearchArchiveMemoriesDetails> {
  return {
    name: 'search_archive_memories',
    label: 'Search archive memories',
    description: DESCRIPTION,
    parameters: SearchArchiveMemoriesToolInput,
    async execute(_toolCallId, params: Static<typeof SearchArchiveMemoriesToolInput>): Promise<
      AgentToolResult<SearchArchiveMemoriesDetails>
    > {
      const results = ctx.archive
        ? searchArchiveMemories(ctx.archive, { query: params.query, limit: params.limit })
        : [];
      const fit = fitItemsToBudget(
        ctx.retrieval,
        results,
        renderArchiveMemory,
        (n) => `[${n} more archive memory result(s) omitted — per-run character budget reached]`,
      );
      for (const row of fit.included) ctx.retrieval.recordArchive(row.id);
      const header = fit.included.length > 0
        ? `${fit.included.length} archive memory result(s):`
        : 'No archive memories matched.';
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
