// ABOUTME: Guards the platform boundary: only the Discord adapter may import discord.js.
// ABOUTME: Core code reaches the Discord adapter only through the platform selector.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');
const ADAPTER_DIR = 'src/platform/discord/';
/** Core files that still import discord.js until the ChatPlatform seam replaces them (plan 005 Part B). */
const PENDING_CORE_IMPORTS = new Set(['src/outbox/recovery.ts', 'src/production-runtime.ts']);

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
      .filter((f) => !f.path.startsWith(ADAPTER_DIR) && !PENDING_CORE_IMPORTS.has(f.path))
      .filter((f) => /from 'discord\.js'|import\('discord\.js'\)/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it.todo('imports the Discord adapter only from the platform selector');

  it.todo('has no src/discord directory');
});
