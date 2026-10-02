// ABOUTME: Builds Slack message permalinks from stored ids (spec Section 30.3, plan 002 decision 8).
// ABOUTME: The team domain comes from `auth.test` at startup.
import { parseSlackMessageId, parseSlackThreadRowId } from './ids.js';

/**
 * Link to a stored Slack message. `channelId` is the stored row: a channel, or a
 * synthetic thread row. A reply links into its thread with `thread_ts` and `cid`.
 */
export function slackMessageLink(teamDomain: string, channelId: string, messageId: string): string {
  const message = parseSlackMessageId(messageId);
  if (!message) return `https://${teamDomain}.slack.com/`;
  const base = `https://${teamDomain}.slack.com/archives/${message.channel}/p${message.ts.replace('.', '')}`;
  const thread = parseSlackThreadRowId(channelId);
  if (!thread || thread.threadTs === message.ts) return base;
  return `${base}?thread_ts=${thread.threadTs}&cid=${thread.channel}`;
}

/** The team domain (`acme` in `https://acme.slack.com/`) from the `auth.test` url. */
export function teamDomainFromUrl(url: string): string | null {
  const m = /^https:\/\/([a-z0-9-]+)\.slack\.com\/?$/i.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}
