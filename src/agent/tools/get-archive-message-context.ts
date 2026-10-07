// ABOUTME: The `get_archive_message_context` agent tool: one servable archive message and its servable neighbours (plan 011).
// ABOUTME: A hidden and a missing message get the same answer, so the tool does not reveal that hidden content exists.
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import type { Static } from '@sinclair/typebox';
import { GetArchiveMessageContextToolInput } from '../schemas.js';
import { getArchiveMessageContext, type ArchiveMessage } from '../../platform-archive/read.js';
import { fitItemsToBudget, type AgentRunContext } from '../run-context.js';
import { ARCHIVE_TOOL_NOTE, renderArchiveMessage } from './archive-render.js';

export interface GetArchiveMessageContextDetails {
  resultIds: string[];
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `Read one archive message with the messages around it in the same channel or thread.
${ARCHIVE_TOOL_NOTE}
Pass an archive message id from search_archive_messages.`;

const NOT_AVAILABLE = 'That archive message is not available.';

export function createGetArchiveMessageContextTool(
  ctx: AgentRunContext,
): AgentTool<typeof GetArchiveMessageContextToolInput, GetArchiveMessageContextDetails> {
  return {
    name: 'get_archive_message_context',
    label: 'Get archive message context',
    description: DESCRIPTION,
    parameters: GetArchiveMessageContextToolInput,
    async execute(_toolCallId, params: Static<typeof GetArchiveMessageContextToolInput>): Promise<
      AgentToolResult<GetArchiveMessageContextDetails>
    > {
      const context = ctx.archive
        ? getArchiveMessageContext(ctx.archive, params.messageId, {
          before: params.beforeCount ?? 5,
          after: params.afterCount ?? 5,
        })
        : null;
      if (!context) {
        return {
          content: [{ type: 'text', text: NOT_AVAILABLE } as TextContent],
          details: { resultIds: [], truncated: 0, charsExposed: ctx.retrieval.charsExposed },
        };
      }
      const rows: Array<{ row: ArchiveMessage; target: boolean }> = [
        ...context.before.map((row) => ({ row, target: false })),
        { row: context.target, target: true },
        ...context.after.map((row) => ({ row, target: false })),
      ];
      const fit = fitItemsToBudget(
        ctx.retrieval,
        rows,
        (item) => renderArchiveMessage(item.row, item.target ? ' (requested)' : ''),
        (n) => `[${n} more archive message(s) omitted — per-run character budget reached]`,
      );
      for (const item of fit.included) ctx.retrieval.recordArchive(item.row.id);
      return {
        content: [{ type: 'text', text: `Archive context, oldest first:\n${fit.lines.join('\n')}` } as TextContent],
        details: {
          resultIds: fit.included.map((item) => item.row.id),
          truncated: fit.truncated,
          charsExposed: ctx.retrieval.charsExposed,
        },
      };
    },
  };
}
