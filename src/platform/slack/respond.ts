// ABOUTME: Sends ephemeral replies to Slack slash commands and button clicks through their response_url.
// ABOUTME: Posts only to https://hooks.slack.com; text goes through the mrkdwn converter, so no mention stays live.
import { toSlackMrkdwn } from './mrkdwn.js';

/** Slack's practical limit for one ephemeral reply. */
export const EPHEMERAL_MAX_CHARS = 3_900;

/** Send one ephemeral reply. Throws only for a URL that is not Slack's. */
export type SlackRespond = (responseUrl: unknown, text: string) => Promise<void>;

/** True when `url` is a Slack response URL. Mneme posts nowhere else. */
export function isSlackResponseUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'hooks.slack.com' && parsed.port === '';
  } catch {
    return false;
  }
}

/** Cap a reply with the same truncation note as the Discord dispatcher. */
function bounded(text: string): string {
  return text.length <= EPHEMERAL_MAX_CHARS ? text : `${text.slice(0, EPHEMERAL_MAX_CHARS - 50)}\n…response truncated`;
}

export function createSlackResponder(
  teamDomain: () => string,
  fetchImpl: typeof fetch = fetch,
  onError: (err: unknown) => void = () => undefined,
): SlackRespond {
  return async (responseUrl, text) => {
    if (!isSlackResponseUrl(responseUrl)) {
      onError(new Error('slack response_url is not a Slack URL'));
      return;
    }
    const body = JSON.stringify({
      response_type: 'ephemeral',
      replace_original: false,
      text: toSlackMrkdwn(bounded(text), { teamDomain: teamDomain() }),
    });
    try {
      const res = await fetchImpl(responseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error' });
      if (!res.ok) onError(new Error(`slack response_url returned ${res.status}`));
    } catch (err) {
      onError(err);
    }
  };
}
