import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDocsIndex } from '../../src/agent/docs-index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS = path.join(ROOT, 'docs');

describe('public documentation boundary', () => {
  it('passes disclosure and local-link publication checks', () => {
    expect(() => execFileSync(process.execPath, ['scripts/check-public-docs.mjs', 'docs'], {
      cwd: ROOT,
      stdio: 'pipe',
    })).not.toThrow();
    expect(() => execFileSync(process.execPath, ['scripts/check-doc-links.mjs'], {
      cwd: ROOT,
      stdio: 'pipe',
    })).not.toThrow();
  });

  it('keeps internal operations and dated acceptance evidence out of self-documentation', () => {
    const paths = loadDocsIndex(DOCS).entries.map((entry) => entry.path);

    // Internal-operations notes carry dated or ops-style file names. Keep them out.
    const internalOpsName = /(internal|ops|lessons|incident|runbook|retrospective|\d{4}-\d{2}-\d{2})/i;
    for (const entry of paths) {
      expect(entry, `docs index holds ${entry}`).not.toMatch(internalOpsName);
    }
    expect(paths).not.toContain('acceptance-checklist.md');
    expect(paths).toContain('how-to/use-mneme.md');
    expect(paths).toContain('explanation/safety-and-assurance.md');
  });

  it('documents every setting in the environment template', () => {
    const template = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const reference = readFileSync(path.join(DOCS, 'reference/configuration.md'), 'utf8');
    const settings = [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);

    for (const setting of settings) expect(reference).toContain(`\`${setting}\``);
  });
});
