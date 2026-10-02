// ABOUTME: The Slack MCP OAuth identity provider: Sign in with Slack (OpenID Connect).
// ABOUTME: Exchanges the code, reads userInfo, checks the team, and makes the admin decision.

import type { IdentityOutcome, IdentityProvider } from '../../mcp/oauth/identity.js';
import { authorizeAdmin } from '../../policy/authorization.js';

/**
 * The Slack identity provider (Section 32.5.2.1).
 *
 * Two calls, both server to server, both bounded by a timeout: exchange the
 * authorization code for an access token, then read `openid.connect.userInfo`.
 * Mneme gets the token directly from Slack over TLS, so the TLS server check
 * authenticates the response; the `id_token` is not read, and its claims are
 * never trusted unverified.
 *
 * **The team check is the security control.** A person who signs in to another
 * Slack workspace never gets a code, even if their user id is on the admin
 * list. The `team` URL parameter only preselects the workspace in the browser.
 *
 * The Slack access token is used once, immediately, and then dropped. It is
 * never stored, never logged, and never put in an outcome or an error.
 */

/** Path Slack returns to. Must be registered as a redirect URL on the Slack app. */
export const SLACK_CALLBACK_PATH = '/oauth/slack/callback';

const SLACK_AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/openid.connect.token';
const SLACK_USERINFO_URL = 'https://slack.com/api/openid.connect.userInfo';

/** No `email`: Mneme does not need it (data minimization, Section 3). */
export const SLACK_SCOPES = 'openid profile';

/**
 * Ceiling on each Slack call. The callback makes two calls before it can
 * respond, and a connector flow fails after ten seconds.
 */
const SLACK_TIMEOUT_MS = 4_000;

const TEAM_CLAIM = 'https://slack.com/team_id';
const USER_CLAIM = 'https://slack.com/user_id';

export interface SlackIdentityConfig {
  clientId: string;
  clientSecret: string;
  /** Mneme's public origin; the callback URL is derived from it. */
  publicBaseUrl: string;
  /** The one Slack workspace Mneme serves (`SLACK_TEAM_ID`). */
  workspaceId: string;
  /** Slack user ids that may sign in (`MNEME_ADMIN_USER_IDS`). */
  adminUserIds: readonly string[];
  fetchImpl?: typeof fetch;
}

/** The callback URL, which must match the Slack app's redirect URL exactly. */
export function slackCallbackUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl}${SLACK_CALLBACK_PATH}`;
}

/** Build the Slack provider. */
export function createSlackIdentityProvider(config: SlackIdentityConfig): IdentityProvider {
  return {
    callbackPath: SLACK_CALLBACK_PATH,
    authorizationUrl(state: string): string {
      const url = new URL(SLACK_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('scope', SLACK_SCOPES);
      url.searchParams.set('redirect_uri', slackCallbackUrl(config.publicBaseUrl));
      url.searchParams.set('state', state);
      url.searchParams.set('team', config.workspaceId);
      return url.toString();
    },
    async identify(code: string): Promise<IdentityOutcome> {
      const accessToken = await exchangeCode(config, code);
      if (accessToken === null) return { ok: false, reason: 'code_exchange_failed' };
      const claims = await fetchUserInfo(config, accessToken);
      if (claims === null) return { ok: false, reason: 'identity_unavailable' };
      const teamId = claims[TEAM_CLAIM];
      const userId = claims[USER_CLAIM];
      if (typeof teamId !== 'string' || teamId === '' || typeof userId !== 'string' || userId === '') {
        return { ok: false, reason: 'identity_unavailable' };
      }
      if (teamId !== config.workspaceId) return { ok: false, reason: 'wrong_workspace' };
      // Slack has no roles: the user's own id stands in for its roles, as in
      // Slack commands. `authorizeAdmin` fails closed on an empty admin list.
      return { ok: true, identity: { userId, authorization: authorizeAdmin([userId], config.adminUserIds) } };
    },
  };
}

/** Read a JSON body, or null when it is not JSON or not an object. */
async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload: unknown = await response.json();
    return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Exchange the code for an access token. Slack answers HTTP 200 with
 * `ok: false` on failure, so the status alone does not show success.
 */
async function exchangeCode(config: SlackIdentityConfig, code: string): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: slackCallbackUrl(config.publicBaseUrl),
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  let response: Response;
  try {
    response = await (config.fetchImpl ?? fetch)(SLACK_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const payload = await readJsonObject(response);
  if (payload?.ok !== true) return null;
  const token = payload.access_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** Read the signed-in user's claims, or null on any failure. */
async function fetchUserInfo(config: SlackIdentityConfig, accessToken: string): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await (config.fetchImpl ?? fetch)(SLACK_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const payload = await readJsonObject(response);
  return payload?.ok === true ? payload : null;
}
