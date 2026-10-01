// ABOUTME: Checks local Markdown targets and optionally verifies external documentation links.
// ABOUTME: Keeps public navigation valid without adding a third-party link-check dependency.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const checkExternal = process.argv.includes('--external');
const docsRoot = path.resolve('docs');

function markdownFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(child);
  }
  return files;
}

function linksIn(text) {
  const links = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    links.push(match[1]);
  }
  for (const match of text.matchAll(/<(https?:\/\/[^>]+)>/g)) links.push(match[1]);
  return links;
}

const failures = [];
const external = new Set();
for (const file of markdownFiles(docsRoot)) {
  for (const raw of linksIn(readFileSync(file, 'utf8'))) {
    const target = raw.replace(/^<|>$/g, '');
    if (target.startsWith('http://') || target.startsWith('https://')) {
      if (!target.includes('<') && !target.includes('>')) external.add(target);
      continue;
    }
    if (target.startsWith('#') || target.startsWith('mailto:')) continue;
    const pathname = decodeURIComponent(target.split('#', 1)[0]);
    if (pathname === '') continue;
    const resolved = path.resolve(path.dirname(file), pathname);
    if (!resolved.startsWith(`${docsRoot}${path.sep}`) && resolved !== docsRoot) {
      failures.push(`${path.relative('.', file)}: link leaves docs/: ${target}`);
      continue;
    }
    try {
      statSync(resolved);
    } catch {
      failures.push(`${path.relative('.', file)}: missing target: ${target}`);
    }
  }
}

async function reachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'mneme-docs-link-check/1.0' },
    });
    return response.status < 400 || [401, 403, 429].includes(response.status);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (checkExternal) {
  for (const url of [...external].sort()) {
    if (!await reachable(url)) failures.push(`unreachable external link: ${url}`);
  }
}

if (failures.length > 0) {
  console.error('Documentation link check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation link check passed (${markdownFiles(docsRoot).length} pages${checkExternal ? `, ${external.size} external links` : ''}).`,
  );
}
