import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { type Static } from '@sinclair/typebox';
import { ListMemoriesToolInput } from '../schemas.js';
import {
  listMemoriesPage,
  type MemorySearchResult,
} from '../../memory/search.js';
import { fitItemsToBudget, type AgentRunContext } from '../run-context.js';

/**
 * `list_memories` — bounded inventory of the highest-value memories whose
 * current scope the run can see. Natural-language interpretation belongs to the
 * agent; this host primitive accepts only deterministic filters and never a
 * query. Every exposed scope is recorded as retrieval provenance.
 */
export interface ListMemoriesDetails {
  resultIds: string[];
  totalMatching: number;
  returned: number;
  hasMore: boolean;
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `List a bounded, relevance-ranked inventory of organizational memories
visible to this run. Use this for broad questions such as what Mneme remembers or knows.
Optionally filter by memory type or lifecycle status; active memories are the default.
No search query is needed. Returns an exact scoped total plus a ranked page (at most 50),
so never describe the returned page size as Mneme's total memory count. Returns id,
type, status, confidence, importance, scope, and statement.`;

function renderMemory(r: MemorySearchResult): string {
  const scope =
    r.scopeType === 'channel'
      ? `channel:${r.scopeKey ?? '?'}`
      : r.scopeType === 'review_only'
        ? 'review_only'
        : 'org';
  return [
    `[${r.memoryId}] ${r.type} (${r.status}, confidence ${r.confidence.toFixed(2)}, importance ${r.importance.toFixed(2)}, scope ${scope})`,
    r.statement,
  ].join('\n');
}

export function createListMemoriesTool(
  ctx: AgentRunContext,
): AgentTool<typeof ListMemoriesToolInput, ListMemoriesDetails> {
  return {
    name: 'list_memories',
    label: 'List memories',
    description: DESCRIPTION,
    parameters: ListMemoriesToolInput,
    async execute(_toolCallId, params: Static<typeof ListMemoriesToolInput>): Promise<
      AgentToolResult<ListMemoriesDetails>
    > {
      const page = listMemoriesPage(ctx.db, ctx.grant, {
        types: params.types,
        statuses: params.statuses,
        limit: params.limit,
        now: ctx.retrieval.nowMs,
      });

      const fit = fitItemsToBudget(
        ctx.retrieval,
        page.items,
        renderMemory,
        (n) => `[${n} more memory(s) omitted — per-run character budget reached]`,
      );
      for (const r of fit.included) {
        ctx.retrieval.recordMemory(r.memoryId);
        ctx.retrieval.recordMemoryScope(r.scopeType, r.scopeKey, 'memory_list');
        if (r.scopeType === 'channel' && r.scopeKey) {
          ctx.retrieval.recordChannel(r.scopeKey, 'memory_list');
        }
      }

      const header = page.totalMatching > 0
        ? `Showing ${fit.included.length} of ${page.totalMatching} permitted matching memory(ies), ranked by importance, recency, and evidence density:`
        : 'No permitted matching memories are available (0 total).';
      const text = `${header}\n${fit.lines.join('\n')}`;

      return {
        content: [{ type: 'text', text } as TextContent],
        details: {
          resultIds: fit.included.map((r) => r.memoryId),
          totalMatching: page.totalMatching,
          returned: fit.included.length,
          hasMore: page.totalMatching > fit.included.length,
          truncated: fit.truncated,
          charsExposed: ctx.retrieval.charsExposed,
        },
      };
    },
  };
}
