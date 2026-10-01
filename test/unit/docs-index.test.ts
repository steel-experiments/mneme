import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../helpers/db.js';
import {
  DocsIndex,
  docPublicUrl,
  docSummary,
  docTitle,
  loadDocsIndex,
} from '../../src/agent/docs-index.js';

/**
 * Self-knowledge documentation index (Sections 22.5–22.7).
 *
 * The index is the complete name space the documentation tools accept, so its
 * construction is part of the path-traversal defense: every entry path is
 * relative to the documentation root, the order is deterministic, and nothing
 * outside the root is ever indexed.
 */

const REPO_DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));

let dir: string;

function write(relative: string, content: string): void {
  const full = path.join(dir, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('docTitle — first heading with a file-name fallback', () => {
  it('takes the first level-1 heading', () => {
    expect(docTitle('reference/commands.md', '# Discord command reference\n\nBody.\n')).toBe(
      'Discord command reference',
    );
  });

  it('ignores a later heading', () => {
    expect(docTitle('a.md', '# First\n\n# Second\n')).toBe('First');
  });

  it('trims surrounding space and skips leading content', () => {
    expect(docTitle('a.md', 'Preamble.\n\n#   Spaced title   \n')).toBe('Spaced title');
  });

  it('falls back to the file name without its extension', () => {
    expect(docTitle('how-to/deploy.md', 'No heading here.\n')).toBe('deploy');
  });

  it('does not accept a level-2 heading as the title', () => {
    expect(docTitle('security.md', '## Subsection\n\nBody.\n')).toBe('security');
  });
});

describe('docSummary — first paragraph as one bounded line', () => {
  it('joins the first paragraph into a single line', () => {
    expect(docSummary('# Title\n\nFirst line\nsecond line.\n\nSecond paragraph.\n')).toBe(
      'First line second line.',
    );
  });

  it('skips headings before the paragraph', () => {
    expect(docSummary('# Title\n## Sub\n\nThe paragraph.\n')).toBe('The paragraph.');
  });

  it('collapses repeated whitespace', () => {
    expect(docSummary('#  T\n\nSpaced    out\ttext.\n')).toBe('Spaced out text.');
  });

  it('returns an empty summary for a file of headings only', () => {
    expect(docSummary('# Title\n\n## Another\n')).toBe('');
  });

  it('bounds the summary at 200 characters, ending with an ellipsis', () => {
    const summary = docSummary(`# T\n\n${'word '.repeat(200)}\n`);
    expect(summary).toHaveLength(200);
    expect(summary.endsWith('...')).toBe(true);
  });
});

describe('loadDocsIndex — scanning', () => {
  it('indexes every markdown file with a relative path, title, and summary', () => {
    write('index.md', '# Mneme documentation\n\nStart here.\n');
    write('reference/configuration.md', '# Configuration\n\nEvery setting.\n');

    const index = loadDocsIndex(dir);

    expect(index.entries.map((e) => e.path)).toEqual(['index.md', 'reference/configuration.md']);
    expect(index.entry('reference/configuration.md')).toMatchObject({
      title: 'Configuration',
      summary: 'Every setting.',
      content: '# Configuration\n\nEvery setting.\n',
    });
  });

  it('constructs canonical public URLs only when a base is configured', () => {
    write('index.md', '# Home\n');
    write('how-to/setup.md', '# Setup\n');

    const publicIndex = loadDocsIndex(dir, 'https://docs.example.com/mneme/');
    expect(publicIndex.entry('index.md')?.publicUrl).toBe('https://docs.example.com/mneme/');
    expect(publicIndex.entry('how-to/setup.md')?.publicUrl).toBe(
      'https://docs.example.com/mneme/how-to/setup/',
    );
    expect(loadDocsIndex(dir).entry('index.md')?.publicUrl).toBeUndefined();
  });

  it('orders entries by relative path, whatever the directory order', () => {
    write('z.md', '# Z\n');
    write('a/b.md', '# B\n');
    write('a.md', '# A\n');

    expect(loadDocsIndex(dir).entries.map((e) => e.path)).toEqual(['a.md', 'a/b.md', 'z.md']);
  });

  it('ignores files that are not markdown', () => {
    write('doc.md', '# Doc\n');
    write('image.png', 'binary');
    write('notes.txt', 'text');

    expect(loadDocsIndex(dir).entries.map((e) => e.path)).toEqual(['doc.md']);
  });

  it('never indexes a symbolic link, so the scan cannot leave the root', () => {
    write('doc.md', '# Doc\n');
    const outside = makeTempDir();
    try {
      writeFileSync(path.join(outside, 'secret.md'), '# Secret\n', 'utf8');
      symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'linked.md'));
      symlinkSync(outside, path.join(dir, 'linked-dir'));

      expect(loadDocsIndex(dir).entries.map((e) => e.path)).toEqual(['doc.md']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns an empty index for a missing directory instead of throwing', () => {
    const index = loadDocsIndex(path.join(dir, 'absent'));
    expect(index.size).toBe(0);
    expect(index.entries).toEqual([]);
  });

  it('indexes the documentation shipped with the repository', () => {
    const index = loadDocsIndex(REPO_DOCS);
    const paths = index.entries.map((e) => e.path);

    expect(paths).toContain('reference/discord-commands.md');
    expect(paths).toContain('reference/configuration.md');
    expect(paths).toContain('how-to/connect-mcp-clients.md');
    expect(index.entry('reference/discord-commands.md')?.title).toBe('Discord command reference');
    for (const entry of index.entries) {
      expect(entry.path.startsWith('/')).toBe(false);
      expect(entry.path.split('/')).not.toContain('..');
      expect(entry.content.length).toBeGreaterThan(0);
    }
  });
});

describe('docPublicUrl — MkDocs routes', () => {
  it('maps home, normal pages, and nested index pages', () => {
    expect(docPublicUrl('https://docs.example.com/base', 'index.md')).toBe(
      'https://docs.example.com/base/',
    );
    expect(docPublicUrl('https://docs.example.com/base/', 'reference/configuration.md')).toBe(
      'https://docs.example.com/base/reference/configuration/',
    );
    expect(docPublicUrl('https://docs.example.com/base/', 'guide/index.md')).toBe(
      'https://docs.example.com/base/guide/',
    );
  });
});

describe('DocsIndex — exact path lookup', () => {
  const index = new DocsIndex([
    { path: 'reference/commands.md', title: 'Commands', summary: 'All of them.', content: 'body' },
  ]);

  it('resolves an exact indexed path', () => {
    expect(index.entry('reference/commands.md')?.content).toBe('body');
  });

  it.each([
    '../secrets.md',
    'reference/../../etc/passwd',
    '/etc/passwd',
    '/app/docs/reference/commands.md',
    'reference\\commands.md',
    'REFERENCE/COMMANDS.MD',
    'reference/commands',
    '',
  ])('resolves nothing for "%s"', (candidate) => {
    expect(index.entry(candidate)).toBeUndefined();
  });
});
