// ABOUTME: Guards the platform boundary: only the Discord adapter may import discord.js.
// ABOUTME: Core code reaches the Discord adapter only through the platform selector.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');
const ADAPTER_DIR = 'src/platform/discord/';
const SELECTOR = 'src/platform/select.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

function repoPath(path: string): string {
  return relative(ROOT, path).split('\\').join('/');
}

describe('platform boundary', () => {
  const files = sourceFiles(SRC).map((path) => ({ path: repoPath(path), text: readFileSync(path, 'utf8') }));

  it('imports discord.js only inside the Discord adapter', () => {
    const offenders = files
      .filter((f) => !f.path.startsWith(ADAPTER_DIR))
      .filter((f) => /from 'discord\.js'|import\('discord\.js'\)/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('imports the Discord adapter only from the platform selector', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.path.startsWith(ADAPTER_DIR) || f.path === SELECTOR) continue;
      for (const m of f.text.matchAll(/(?:from |import\()'(\.{1,2}\/[^']+)'/g)) {
        const target = repoPath(resolve(dirname(join(ROOT, f.path)), m[1]!));
        if (target.startsWith(ADAPTER_DIR)) offenders.push(`${f.path} -> ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no src/discord directory', () => {
    expect(existsSync(join(SRC, 'discord'))).toBe(false);
  });
});
