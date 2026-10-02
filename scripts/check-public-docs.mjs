// ABOUTME: Fails when the public documentation contains deployment-specific disclosures.
// ABOUTME: Scans both authored Markdown and the generated MkDocs artifact.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);
if (roots.length === 0) roots.push('docs');

const TEXT_EXTENSIONS = new Set(['.md', '.html', '.json', '.xml', '.txt', '.yml', '.yaml']);
const checks = [
  { name: 'local macOS user path', pattern: /\/Users\/[A-Za-z0-9._-]+\//g },
  { name: 'UUID', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi },
  { name: 'Discord snowflake value', pattern: /(?<!\d)\d{17,20}(?!\d)/g },
  { name: 'Railway deployment hostname', pattern: /\b[a-z0-9-]+\.up\.railway\.app\b/gi },
  { name: 'Railway dashboard resource URL', pattern: /https:\/\/railway\.com\/(?:project|service)\//gi },
  { name: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g },
  { name: 'Slack app-level token', pattern: /\bxapp-\d-[A-Za-z0-9-]{8,}/g },
  // A real Slack id has at least one digit. Docs use placeholders such as CXXXXXXXXX.
  { name: 'Slack id', pattern: /\b[TCGUWF](?=[A-Z0-9]*\d)[A-Z0-9]{8,11}\b/g },
];

function filesUnder(target) {
  const info = statSync(target);
  if (info.isFile()) return [target];
  const files = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(child));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(child);
    }
  }
  return files;
}

const findings = [];
for (const root of roots) {
  for (const file of filesUnder(root)) {
    const text = readFileSync(file, 'utf8');
    for (const check of checks) {
      check.pattern.lastIndex = 0;
      for (const match of text.matchAll(check.pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        findings.push(`${file}:${line}: ${check.name}: ${match[0]}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Public documentation disclosure check failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Public documentation disclosure check passed (${roots.join(', ')}).`);
}
