// ABOUTME: Downloads a Slack private file with the bot token (spec Section 9.10, plan 009).
// ABOUTME: The token goes only to https://files.slack.com; redirects stay on Slack hosts and carry no token.
import { readLimitedBody, type FetchBytes } from '../../ingestion/attachments.js';

/** The one host that receives the bot token. */
const TOKEN_HOST = 'files.slack.com';
/** Redirect targets are allowed only on these host suffixes, over https. */
const REDIRECT_SUFFIXES = ['.slack.com', '.slack-edge.com'];
const MAX_REDIRECTS = 3;

function isTokenHost(url: URL): boolean {
  return url.protocol === 'https:' && url.port === '' && url.hostname === TOKEN_HOST;
}

function isAllowedRedirect(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port !== '') return false;
  return url.hostname === TOKEN_HOST || REDIRECT_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
}

/**
 * A fetcher for Slack `url_private` and `url_private_download` links. Error
 * messages name the status and the host only, never the URL query or the token.
 */
export function createSlackFetchBytes(botToken: string, fetchImpl: typeof fetch = fetch): FetchBytes {
  return async (rawUrl, maxBytes) => {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new Error('attachment url is not a Slack file url'); }
    if (!isTokenHost(url)) throw new Error('attachment url is not a Slack file url');

    for (let redirects = 0; ; redirects += 1) {
      const headers: Record<string, string> = isTokenHost(url) ? { Authorization: `Bearer ${botToken}` } : {};
      let res: Response;
      try {
        res = await fetchImpl(url.href, { headers, redirect: 'manual' });
      } catch {
        throw new Error(`attachment fetch failed: transport error ${url.hostname}`);
      }
      if (res.status >= 300 && res.status < 400) {
        if (redirects >= MAX_REDIRECTS) throw new Error(`attachment fetch failed: too many redirects ${url.hostname}`);
        const location = res.headers.get('location');
        if (!location) throw new Error(`attachment fetch failed: redirect with no location ${url.hostname}`);
        let next: URL;
        try { next = new URL(location, url); } catch {
          throw new Error(`attachment fetch failed: redirect to a host that is not allowed from ${url.hostname}`);
        }
        if (!isAllowedRedirect(next)) {
          throw new Error(`attachment fetch failed: redirect to a host that is not allowed from ${url.hostname}`);
        }
        url = next;
        continue;
      }
      if (!res.ok) throw new Error(`attachment fetch failed: ${res.status} ${url.hostname}`);
      if ((res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) {
        throw new Error('slack returned an HTML page; check the files:read scope');
      }
      return readLimitedBody(res, maxBytes);
    }
  };
}
