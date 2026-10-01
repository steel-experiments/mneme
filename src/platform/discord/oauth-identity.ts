// ABOUTME: Talks to Discord to identify the person who just signed in.
// ABOUTME: Exchanges the authorization code and reads their guild membership and roles.

import { discordCallbackUrl } from '../../mcp/oauth/authorize.js';

/**
 * The identity-provider boundary (Section 32.5.2, amended).
 *
 * Two calls, both server to server, both bounded by a timeout: exchange Discord's
 * authorization code for a short-lived user access token, then read that user's
 * membership in the one guild Mneme serves. The membership response carries
 * the role ids, which is the whole basis of the authorization decision — a person
 * who is not in the guild, or whose roles cannot be read, is not authorized.
 *
 * The Discord access token obtained here is used once, immediately, and then
 * dropped. It is never stored, never logged, and never handed to a client; the
 * credential a client receives is minted by Mneme and means something else
 * entirely.
 *
 * Everything is expressed through an injectable {@link DiscordIdentityClient} so
 * the callback logic can be tested without a network. The default implementation
 * is the only code here that performs I/O.
 */

/** Discord's API origin. */
const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Ceiling on each Discord call. Anthropic fails a connector flow whose endpoints
 * take longer than ten seconds, and this callback makes two calls before it can
 * respond, so each is held well inside that budget.
 */
const DISCORD_TIMEOUT_MS = 4_000;

/** A person's membership in the guild, as far as authorization cares. */
export interface DiscordMembership {
  /** The Discord user id — the subject of the token that follows. */
  userId: string;
  /**
   * Role ids held in the guild, or null when they could not be resolved. Null is
   * not an empty list: unresolved roles must fail closed, and `authorizeAdmin`
   * distinguishes the two.
   */
  roleIds: readonly string[] | null;
}

/** Why identifying the person failed. */
export type DiscordIdentityFailure =
  | 'code_exchange_failed'
  | 'not_a_guild_member'
  | 'membership_unavailable';

export type DiscordIdentityOutcome =
  | { ok: true; membership: DiscordMembership }
  | { ok: false; reason: DiscordIdentityFailure };

/** The seam: given Discord's code, say who the person is. */
export interface DiscordIdentityClient {
  identify(code: string): Promise<DiscordIdentityOutcome>;
}

export interface DiscordIdentityConfig {
  clientId: string;
  clientSecret: string;
  /** Mneme's public origin; the callback URL is derived from it. */
  publicBaseUrl: string;
  /** The one guild Mneme serves. */
  guildId: string;
}

/**
 * Build the real client. Failures are collapsed into the three reasons above:
 * the caller decides what a person sees, and a transport error, a rejected code,
 * and a malformed response are the same event to them.
 */
export function createDiscordIdentityClient(config: DiscordIdentityConfig): DiscordIdentityClient {
  return {
    async identify(code: string): Promise<DiscordIdentityOutcome> {
      const accessToken = await exchangeCode(config, code);
      if (accessToken === null) return { ok: false, reason: 'code_exchange_failed' };
      return fetchMembership(config, accessToken);
    },
  };
}

/**
 * Exchange Discord's authorization code for a user access token. The redirect URI
 * is sent again because Discord binds the code to it, and the client secret
 * authenticates Mneme as the application that started the flow. Returns null
 * on any failure; the token is returned to the caller and never stored.
 */
async function exchangeCode(config: DiscordIdentityConfig, code: string): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: discordCallbackUrl(config.publicBaseUrl),
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  let response: Response;
  try {
    response = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const token = (payload as { access_token?: unknown } | null)?.access_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Read the person's membership in the configured guild. Discord answers `404`
 * when they are not a member, which is a definite "no" rather than an error, so
 * it is reported separately from a call that simply did not succeed.
 */
async function fetchMembership(
  config: DiscordIdentityConfig,
  accessToken: string,
): Promise<DiscordIdentityOutcome> {
  let response: Response;
  try {
    response = await fetch(`${DISCORD_API}/users/@me/guilds/${config.guildId}/member`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'membership_unavailable' };
  }
  if (response.status === 404) return { ok: false, reason: 'not_a_guild_member' };
  if (!response.ok) return { ok: false, reason: 'membership_unavailable' };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'membership_unavailable' };
  }
  const member = payload as { user?: { id?: unknown }; roles?: unknown } | null;
  const userId = member?.user?.id;
  if (typeof userId !== 'string' || userId.length === 0) {
    return { ok: false, reason: 'membership_unavailable' };
  }
  // A missing roles array means the field could not be resolved. Passing null on
  // rather than an empty array is what lets the decision fail closed.
  const roleIds = Array.isArray(member?.roles)
    ? member.roles.filter((r): r is string => typeof r === 'string')
    : null;
  return { ok: true, membership: { userId, roleIds } };
}
