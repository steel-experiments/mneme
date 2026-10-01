/**
 * HTML rendering primitives for the inspector surface (Section 32.6).
 *
 * Every page is a complete server-rendered HTML document with no client
 * JavaScript, no cookies, and no external resource of any kind. The document
 * head carries `content-security-policy: default-src 'none'; style-src
 * 'unsafe-inline'`, so even an injected string cannot load a script or image.
 *
 * One rule governs this module: **every** interpolation of database-derived
 * text passes through {@link h}. The layout below calls `h` on title, nav, and
 * body sections; page renderers call it on each field. The only permitted
 * bypass is host-computed SVG geometry and enum constants, whose text is
 * escaped anyway (Section 32.6).
 */

/** Escape a string for HTML text and attribute context. */
export function h(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render `n` as a percent string; nullish renders as an em dash. */
export function fmtPct(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`;
}

/** Render an epoch-ms timestamp as ISO UTC; null renders as `never`. */
export function fmtMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? 'never' : new Date(ms).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

/** Render a number with thousands separators; nullish renders as an em dash. */
export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US');
}

/** Render a USD cost; nullish renders as an em dash. */
export function fmtUsd(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `$${n.toFixed(4)}`;
}

/** Truncate long prose for table cells; the detail views show full text. */
export function excerpt(s: string | null | undefined, max = 160): string {
  if (s === null || s === undefined) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const DISCORD_MARKDOWN_LINK = /\[([^[\]\r\n]{1,80})\]\((https:\/\/discord\.com\/channels\/[0-9]{17,20}\/[0-9]{17,20}\/[0-9]{17,20})\)/gu;

/**
 * Render a speech-table excerpt while preserving canonical host-generated
 * Discord message links. All other text, including malformed or external
 * Markdown destinations, remains escaped text.
 *
 * The limit applies to visible characters rather than the Markdown source, so
 * a long Discord destination renders as its short label without consuming the
 * table cell's excerpt budget.
 */
export function speechExcerpt(value: string | null | undefined, max = 160): string {
  if (value === null || value === undefined || value.length === 0) return '';

  const tokens: Array<{ text: string; href?: string }> = [];
  let cursor = 0;
  for (const match of value.matchAll(DISCORD_MARKDOWN_LINK)) {
    const index = match.index;
    const label = match[1];
    const href = match[2];
    if (index === undefined || label === undefined || href === undefined) continue;
    if (index > cursor) tokens.push({ text: value.slice(cursor, index) });
    tokens.push({ text: label, href });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) tokens.push({ text: value.slice(cursor) });

  const limit = Math.max(1, Math.floor(max));
  const visibleLength = tokens.reduce((total, token) => total + token.text.length, 0);
  const truncated = visibleLength > limit;
  let remaining = truncated ? limit - 1 : limit;
  let rendered = '';

  for (const token of tokens) {
    if (remaining <= 0) break;
    const text = token.text.slice(0, remaining);
    if (text.length === 0) continue;
    rendered += token.href
      ? `<a href="${h(token.href)}">${h(text)}</a>`
      : h(text);
    remaining -= text.length;
  }

  return `${rendered}${truncated ? '…' : ''}`;
}

/**
 * A small label chip. `tone` is a fixed enum resolved to a CSS class by the
 * stylesheet — never caller-supplied markup.
 */
export function badge(label: string, tone: 'neutral' | 'good' | 'warn' | 'bad' | 'scope' = 'neutral'): string {
  return `<span class="badge badge-${tone}">${h(label)}</span>`;
}

/** Map a lifecycle or visibility enum onto a badge tone. */
export function statusBadge(status: string | null | undefined): string {
  const s = status ?? '';
  if (['active', 'completed', 'succeeded', 'sent', 'ready', 'ok'].includes(s)) return badge(s || '—', 'good');
  if (['running', 'queued', 'sending', 'open', 'reviewing'].includes(s)) return badge(s || '—', 'scope');
  if (['failed', 'error', 'rejected', 'cancelled'].includes(s)) return badge(s || '—', 'bad');
  if (['superseded', 'resolved', 'invalidated', 'expired', 'dismissed', 'skipped'].includes(s)) return badge(s || '—', 'warn');
  return badge(s || '—');
}

/** One table row of cells; cells are pre-rendered HTML from the caller. */
export function tr(...cells: string[]): string {
  return `  <tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>\n`;
}

/** One table row with cells shaded as a header row. */
export function trHead(...cells: string[]): string {
  return `  <tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr>\n`;
}

/** A two-column definition row used by detail pages. */
export function kvRow(label: string, value: string): string {
  return `  <dt>${h(label)}</dt><dd>${value}</dd>\n`;
}

/** A hyperlink to another inspector page; href values are internal constants. */
export function link(href: string, label: string): string {
  return `<a href="${h(href)}">${h(label)}</a>`;
}

const NAV_ITEMS: readonly { href: string; label: string }[] = [
  { href: '', label: 'Overview' },
  { href: '/memories', label: 'Memories' },
  { href: '/episodes', label: 'Episodes' },
  { href: '/runs', label: 'Runs' },
  { href: '/speech', label: 'Speech' },
  { href: '/channels', label: 'Channels' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/audit', label: 'Audit' },
];

const INSPECTOR_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #1f2328; background: #ffffff;
}
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
header.inspector {
  display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
  padding: 14px 24px; border-bottom: 1px solid #d8dee4; background: #f6f8fa;
}
header.inspector h1 { font-size: 15px; font-weight: 600; margin: 0; }
header.inspector nav { display: flex; gap: 4px; flex-wrap: wrap; }
header.inspector nav a {
  padding: 3px 10px; border-radius: 6px; color: #57606a;
}
header.inspector nav a:hover { background: #eaeef2; color: #1f2328; text-decoration: none; }
header.inspector nav a[aria-current="page"] { background: #1f2328; color: #ffffff; }
main { max-width: 1080px; margin: 0 auto; padding: 24px; }
h2 { font-size: 14px; font-weight: 600; margin: 28px 0 8px; }
p.note { color: #57606a; font-size: 12.5px; margin: 4px 0 12px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eaeef2; vertical-align: top; overflow-wrap: anywhere; }
th { color: #57606a; font-weight: 600; font-size: 12px; white-space: nowrap; }
dl.details { display: grid; grid-template-columns: 200px 1fr; gap: 4px 16px; margin: 8px 0 16px; }
dl.details dt { color: #57606a; font-size: 12px; padding-top: 2px; }
dl.details dd { margin: 0; }
blockquote.evidence {
  margin: 0 0 10px; padding: 8px 12px; border-left: 3px solid #d0d7de;
  background: #f6f8fa; white-space: pre-wrap; overflow-wrap: anywhere;
}
.badge {
  display: inline-block; padding: 0 7px; border-radius: 10px; font-size: 11.5px;
  border: 1px solid #d0d7de; color: #57606a; background: #ffffff; white-space: nowrap;
}
.badge-good { border-color: #1a7f37; color: #1a7f37; }
.badge-warn { border-color: #9a6700; color: #9a6700; }
.badge-bad { border-color: #cf222e; color: #cf222e; }
.badge-scope { border-color: #0969da; color: #0969da; }
form.get { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0 12px; }
form.get input[type="search"], form.get select {
  font: inherit; padding: 4px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; color: inherit;
}
form.get button {
  font: inherit; padding: 4px 12px; border: 1px solid #d0d7de; border-radius: 6px;
  background: #f6f8fa; color: inherit; cursor: pointer;
}
form.get button:hover { background: #eaeef2; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin: 12px 0; }
.card { border: 1px solid #d8dee4; border-radius: 8px; padding: 10px 14px; }
.card .n { font-size: 20px; font-weight: 600; }
.card .l { color: #57606a; font-size: 12px; }
footer { max-width: 1080px; margin: 0 auto; padding: 8px 24px 32px; color: #8b949e; font-size: 11.5px; }
.pager { margin: 8px 0 24px; }
svg.ledger { width: 100%; height: auto; display: block; margin: 10px 0; }
.legend { list-style: none; padding: 0; margin: 0 0 8px; font-size: 12.5px; }
.legend li { display: flex; gap: 8px; align-items: baseline; margin: 2px 0; }
.legend .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; display: inline-block; }
.trace { display: grid; gap: 6px; margin: 10px 0 18px; }
.trace-row { display: grid; grid-template-columns: 180px minmax(180px, 1fr) 300px; gap: 10px; align-items: center; font-size: 12px; }
.trace-tool .trace-label { padding-left: 18px; }
.trace-track { position: relative; height: 12px; border-radius: 6px; background: #eaeef2; overflow: hidden; }
.trace-track span { position: absolute; top: 0; bottom: 0; min-width: 2px; border-radius: 6px; background: #0969da; }
.trace-tool .trace-track span { background: #8250df; }
.trace-detail { color: #57606a; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  a { color: #58a6ff; }
  header.inspector { background: #161b22; border-color: #30363d; }
  header.inspector nav a { color: #8b949e; }
  header.inspector nav a:hover { background: #21262d; color: #e6edf3; }
  header.inspector nav a[aria-current="page"] { background: #e6edf3; color: #0d1117; }
  th, td { border-color: #21262d; }
  th { color: #8b949e; }
  blockquote.evidence { background: #161b22; border-color: #30363d; }
  .badge { background: #0d1117; border-color: #30363d; color: #8b949e; }
  .badge-good { border-color: #3fb950; color: #3fb950; }
  .badge-warn { border-color: #d29922; color: #d29922; }
  .badge-bad { border-color: #f85149; color: #f85149; }
  .badge-scope { border-color: #58a6ff; color: #58a6ff; }
  .card { border-color: #30363d; }
  form.get input[type="search"], form.get select, form.get button { background: #161b22; border-color: #30363d; color: inherit; }
}
`;

/**
 * Wrap page body content in the shared document shell. `basePath` is the
 * configured mount path; `current` marks the active nav item so links stay
 * correct under any `INSPECTOR_PATH`.
 */
export function layout(args: { title: string; body: string; basePath: string; current?: string }): string {
  const nav = NAV_ITEMS.map((item) => {
    const key = item.href === '' ? 'overview' : item.href.slice(1);
    const currentAttr = args.current === key ? ' aria-current="page"' : '';
    return `<a href="${h(args.basePath + item.href)}"${currentAttr}>${h(item.label)}</a>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${h(args.title)} · Mneme inspector</title>
<style>${INSPECTOR_CSS}</style>
</head>
<body>
<header class="inspector">
  <h1>Mneme inspector</h1>
  <nav>${nav}</nav>
</header>
<main>
${args.body}
</main>
<footer>Read-only admin surface. Every query on this page ran under the secure review grant.</footer>
</body>
</html>
`;
}

/** The shared not-found page: unknown ids and hidden ids render identically. */
export function notFoundPage(basePath: string, what: string): string {
  return layout({
    title: 'Not found',
    basePath,
    body: `<h2>Not found</h2>\n<p class="note">${h(what)} does not exist, or is not visible under the inspector grant.</p>`,
  });
}
