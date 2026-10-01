// ABOUTME: `list_docs` agent tool: the index of Mneme's own documentation.
// ABOUTME: Returns path, title, and summary per file, and no file bodies.
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { ListDocsToolInput } from '../schemas.js';
import type { DocEntry, DocsIndex } from '../docs-index.js';
import { fitItemsToBudget, type AgentRunContext } from '../run-context.js';

/**
 * `list_docs` — the documentation index for the current run (Section 22.5).
 *
 * The tool returns one line per documentation file and no file body, so the
 * agent spends few tokens to find what to read and then calls `read_doc` for
 * that one file. Documentation carries no channel visibility, so the listing
 * does not touch retrieval provenance; it does count against the per-run
 * character budget like every other retrieved text.
 */
export interface ListDocsDetails {
  paths: string[];
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `List Mneme's own documentation: how she works, her Discord commands,
MCP client setup, and her configuration. Returns a path, title, and summary per file, and no
file content. Read one file with read_doc. A listed canonical public URL is host-built and may
be cited exactly; never invent or rewrite a documentation URL.`;

function renderEntry(entry: DocEntry): string {
  const line = entry.summary === ''
    ? `${entry.path} — ${entry.title}`
    : `${entry.path} — ${entry.title}: ${entry.summary}`;
  return entry.publicUrl === undefined ? line : `${line} [canonical: ${entry.publicUrl}]`;
}

export function createListDocsTool(
  ctx: AgentRunContext,
  docs: DocsIndex,
): AgentTool<typeof ListDocsToolInput, ListDocsDetails> {
  return {
    name: 'list_docs',
    label: 'List documentation',
    description: DESCRIPTION,
    parameters: ListDocsToolInput,
    async execute(): Promise<AgentToolResult<ListDocsDetails>> {
      const fit = fitItemsToBudget(
        ctx.retrieval,
        docs.entries,
        renderEntry,
        (n) => `[${n} more documentation file(s) omitted — per-run character budget reached]`,
      );

      const header =
        fit.included.length > 0
          ? `${fit.included.length} documentation file(s):`
          : 'No documentation is available.';
      const text = `${header}\n${fit.lines.join('\n')}`;

      return {
        content: [{ type: 'text', text } as TextContent],
        details: {
          paths: fit.included.map((e) => e.path),
          truncated: fit.truncated,
          charsExposed: ctx.retrieval.charsExposed,
        },
      };
    },
  };
}
