// ABOUTME: Builds the in-memory index of Mneme's shipped Markdown documentation.
// ABOUTME: The index is the only path list the documentation tools accept.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Self-knowledge documentation index (Sections 4.1, 22).
 *
 * Mneme answers questions about herself — how she works, her Discord
 * commands, MCP client setup, her configuration — from the documentation shipped
 * with the image, not from model memory. The host scans `docsDir` once at load
 * time and keeps the title, summary, and content of every `*.md` file in memory,
 * so no filesystem access happens while a run executes. A model-supplied path is
 * only ever compared against an indexed relative path: the agent never receives
 * a filesystem tool and cannot reach a file outside the index.
 *
 * The indexed tree is the public documentation boundary. When a canonical base
 * is configured, the host also constructs the only public URL the agent may cite.
 */

/** Characters of the leading paragraph kept as an entry summary. */
const SUMMARY_MAX_CHARS = 200;

/** One indexed documentation file. */
export interface DocEntry {
  /** Path relative to the documentation root, with `/` separators. */
  readonly path: string;
  /** First level-1 heading, or the file name when the file has no heading. */
  readonly title: string;
  /** First paragraph as a single line, bounded by {@link SUMMARY_MAX_CHARS}. */
  readonly summary: string;
  /** Full file text, read at load time. */
  readonly content: string;
  /** Host-constructed canonical public URL, absent when publication is not configured. */
  readonly publicUrl?: string;
}

/**
 * An immutable, ordered set of documentation entries. Entries are sorted by
 * relative path, so `list_docs` output is deterministic across restarts.
 */
export class DocsIndex {
  readonly entries: readonly DocEntry[];
  private readonly byPath: Map<string, DocEntry>;

  constructor(entries: readonly DocEntry[]) {
    this.entries = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.byPath = new Map(this.entries.map((e) => [e.path, e]));
  }

  get size(): number {
    return this.entries.length;
  }

  /** The entry for an exact indexed path, or undefined for anything else. */
  entry(relativePath: string): DocEntry | undefined {
    return this.byPath.get(relativePath);
  }
}

/** Extract the first level-1 heading; falls back to the file name. */
export function docTitle(relativePath: string, content: string): string {
  for (const line of content.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return path.basename(relativePath, path.extname(relativePath));
}

/**
 * Extract the first paragraph that is not a heading, as one whitespace-collapsed
 * line bounded by {@link SUMMARY_MAX_CHARS}. Returns the empty string for a file
 * that holds only headings.
 */
export function docSummary(content: string): string {
  const paragraph: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  const summary = paragraph.join(' ').replace(/\s+/g, ' ');
  return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 3)}...` : summary;
}

/**
 * Collect the relative paths of every Markdown file under `dir`. Only real
 * directories and files are visited — a symbolic link is skipped, so the scan
 * cannot leave the documentation root.
 */
function markdownPaths(dir: string, prefix = ''): string[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const dirent of dirents) {
    const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
    if (dirent.isDirectory()) {
      found.push(...markdownPaths(path.join(dir, dirent.name), relative));
    } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md')) {
      found.push(relative);
    }
  }
  return found;
}

/**
 * Build the documentation index from `docsDir`. A missing or unreadable
 * directory yields an empty index: the documentation is a capability, so its
 * absence removes the tools' content but never stops the process.
 */
export function loadDocsIndex(docsDir: string, publicBaseUrl?: string): DocsIndex {
  const entries: DocEntry[] = [];
  for (const relative of markdownPaths(docsDir)) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(docsDir, ...relative.split('/')), 'utf8');
    } catch {
      continue;
    }
    entries.push({
      path: relative,
      title: docTitle(relative, content),
      summary: docSummary(content),
      content,
      ...(publicBaseUrl === undefined
        ? {}
        : { publicUrl: docPublicUrl(publicBaseUrl, relative) }),
    });
  }
  return new DocsIndex(entries);
}

/** Map an indexed Markdown path to MkDocs' directory-style canonical URL. */
export function docPublicUrl(publicBaseUrl: string, relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  const route = encoded === 'index.md'
    ? ''
    : encoded.endsWith('/index.md')
      ? encoded.slice(0, -'index.md'.length)
      : `${encoded.slice(0, -'.md'.length)}/`;
  const base = publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`;
  return new URL(route, base).toString();
}
