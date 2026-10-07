// ABOUTME: Converts the core Markdown subset to Slack mrkdwn (spec Section 24.5, plan 002 decision 7).
// ABOUTME: A trust boundary: all text is escaped, so no Slack mention or link survives unless the host built it.
import { isHostBuiltArchiveLink } from '../links.js';

/** How the converted text is delivered. */
export interface SlackMrkdwnOptions {
  /** The workspace domain from `auth.test` (`acme` in `acme.slack.com`). */
  teamDomain: string;
}

// Private-use code points mark placeholders. Input copies of them are removed
// first, so a message cannot forge a placeholder.
const MARK = '\uE000';
const BOLD = '\uE001';
const PLACEHOLDER = /\uE000(\d+)\uE000/g;
const PRIVATE_USE = /[\uE000-\uF8FF]/g;

const MARKDOWN_LINK = /\[([^\]\n]{0,500})\]\(([^)\s]{1,2000})\)/g;
const DATE_TOKEN = /<t:(\d{1,12}):[tTdDfFR]>/g;
const USER_TOKEN = /<@([UW][A-Z0-9]{8,})>/g;
const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;

function escapeControl(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape the three characters that Slack treats as control characters. */
export function escapeSlackText(text: string): string {
  return escapeControl(text.replace(PRIVATE_USE, ''));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `url` is a message link that the host builds for this workspace (spec Section 30.3). */
export function isHostBuiltSlackLink(url: string, teamDomain: string): boolean {
  const pattern = new RegExp(
    `^https://${escapeRegExp(teamDomain)}\\.slack\\.com/archives/[CG][A-Z0-9]{8,}/p\\d{16}`
    + '(?:\\?thread_ts=\\d{10}\\.\\d{6}&cid=[CG][A-Z0-9]{8,})?$',
  );
  return pattern.test(url);
}

/** A link label: escaped, with the characters that end a Slack link removed. */
function linkLabel(label: string): string {
  return escapeSlackText(label.replace(/[|<>]/g, '')).trim() || 'source';
}

function convertEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/\*([^*\n]+)\*/g, '_$1_')
    .replace(/\uE001/g, '*');
}

function convertQuotes(text: string): string {
  return text.replace(/^&gt;(?= |$)/gm, '>');
}

/**
 * Convert host text in the core Markdown subset to Slack mrkdwn. The output
 * contains no `<!…>`, `<@…>`, `<#…>`, or `<!subteam^…>` token, except a
 * `<!date^…>` timestamp.
 */
export function toSlackMrkdwn(content: string, options: SlackMrkdwnOptions): string {
  const kept: string[] = [];
  const keep = (value: string): string => {
    kept.push(value);
    return `${MARK}${kept.length - 1}${MARK}`;
  };
  let text = content.replace(PRIVATE_USE, '');

  // Code first: escape only, and no other conversion inside it.
  text = text.replace(FENCE, (code) => keep(escapeSlackText(code)));
  text = text.replace(INLINE_CODE, (code) => keep(escapeSlackText(code)));

  text = text.replace(MARKDOWN_LINK, (_raw, label: string, url: string) => (
    isHostBuiltSlackLink(url, options.teamDomain) || isHostBuiltArchiveLink(url)
      ? keep(`<${url}|${linkLabel(label)}>`)
      : keep(`${escapeSlackText(label)} (${escapeSlackText(url)})`)
  ));
  text = text.replace(DATE_TOKEN, (_raw, seconds: string) => {
    const iso = new Date(Number(seconds) * 1000).toISOString();
    return keep(`<!date^${seconds}^{date_long} {time}|${iso}>`);
  });
  // A user token becomes code text in every message. The text reaches the
  // converter as one string, so a host-built token cannot be told apart from
  // one in stored message text or an echoed command argument.
  text = text.replace(USER_TOKEN, (_raw, id: string) => keep(`\`${id}\``));

  text = convertQuotes(convertEmphasis(escapeControl(text)));
  return text.replace(PLACEHOLDER, (_raw, index: string) => kept[Number(index)] ?? '');
}
