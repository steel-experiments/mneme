import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { type Static } from '@sinclair/typebox';
import { GetMemoryEvidenceToolInput } from '../schemas.js';
import {
  getMemoryEvidence,
  getMemoryDetails,
  type MemoryEvidenceResult,
} from '../../memory/search.js';
import { fitItemsToBudget, type AgentRunContext } from '../run-context.js';
import { formatTimestamp } from './render.js';

/**
 * `get_memory_evidence` — the permitted evidence messages behind one memory
 * (Sections 7.3, 22.4). The repository returns evidence only when the memory's
 * recomputed scope is visible to the run, and only evidence messages that are
 * themselves visible; an invisible or nonexistent memory yields a generic empty
 * result that does not reveal which. Exposed channels count as provenance and
 * the output is bounded by the per-run character budget.
 */
export interface GetMemoryEvidenceDetails {
  memoryId: string;
  evidenceIds: string[];
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `Return the evidence messages behind one memory id (origin/supports/contradicts/...).
Only evidence visible to this run is returned. Use list_memories or search_memories first to find memory ids.`;

function renderEvidence(r: MemoryEvidenceResult): string {
  const note = r.note ? ` — ${r.note}` : '';
  return [
    `[${r.messageId}] ${formatTimestamp(r.createdAtMs)} ${r.authorDisplayName} in #${r.channelId} (${r.stance}, weight ${r.weight.toFixed(2)})${note}`,
    r.content,
    r.link,
  ].join('\n');
}

export function createGetMemoryEvidenceTool(
  ctx: AgentRunContext,
): AgentTool<typeof GetMemoryEvidenceToolInput, GetMemoryEvidenceDetails> {
  return {
    name: 'get_memory_evidence',
    label: 'Get memory evidence',
    description: DESCRIPTION,
    parameters: GetMemoryEvidenceToolInput,
    async execute(
      _toolCallId,
      params: Static<typeof GetMemoryEvidenceToolInput>,
    ): Promise<AgentToolResult<GetMemoryEvidenceDetails>> {
      const evidence = getMemoryEvidence(ctx.db, ctx.grant, params.memoryId, params.limit);

      const fit = fitItemsToBudget(
        ctx.retrieval,
        evidence,
        renderEvidence,
        (n) => `[${n} more evidence row(s) omitted — per-run character budget reached]`,
      );
      for (const r of fit.included) {
        ctx.retrieval.recordMessage(r.messageId, r.channelId, 'memory_evidence');
      }
      if (fit.included.length > 0) {
        ctx.retrieval.recordMemory(params.memoryId);
        const memory = getMemoryDetails(ctx.db, ctx.grant, params.memoryId);
        if (memory) {
          ctx.retrieval.recordMemoryScope(memory.scopeType, memory.scopeKey, 'memory_evidence');
          if (memory.scopeType === 'channel' && memory.scopeKey) {
            ctx.retrieval.recordChannel(memory.scopeKey, 'memory_evidence');
          }
        }
      }

      const header =
        fit.included.length > 0
          ? `${fit.included.length} evidence row(s) for ${params.memoryId}:`
          : `No visible evidence for ${params.memoryId}.`;
      const text = `${header}\n${fit.lines.join('\n')}`;

      return {
        content: [{ type: 'text', text } as TextContent],
        details: {
          memoryId: params.memoryId,
          evidenceIds: fit.included.map((r) => r.messageId),
          truncated: fit.truncated,
          charsExposed: ctx.retrieval.charsExposed,
        },
      };
    },
  };
}
