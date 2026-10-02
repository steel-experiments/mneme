// ABOUTME: The Discord MCP OAuth identity provider: sends a person to Discord and identifies them on return.
// ABOUTME: Exchanges the authorization code, reads guild membership and roles, and makes the admin decision.

import type { IdentityOutcome, IdentityProvider } from '../../mcp/oauth/identity.js';
import { authorizeAdmin } from '../../policy/authorization.js';

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
 * The provider implements {@link IdentityProvider}, so the callback logic can be
 * tested without a network. `fetchImpl` lets tests stub HTTP without touching
 * globals.
 */

/** Path Discord returns to. Must be registered on the Discord application. */
export const DISCORD_CALLBACK_PATH = '/oauth/discord/callback';

/** Discord's authorization endpoint. */
const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

/**
 * Discord scopes requested: the user's id, and their membership in one guild.
 * `guilds.members.read` is what makes the role check possible; without it a
 * person could be identified but not authorized, which is the whole decision.
 */
export const DISCORD_SCOPES = 'identify guilds.members.read';

/** Discord's API origin. */
const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Ceiling on each Discord call. Anthropic fails a connector flow whose endpoints
 * take longer than ten seconds, and this callback makes two calls before it can
 * respond, so each is held well inside that budget.
 */
const DISCORD_TIMEOUT_MS = 4_000;

export interface DiscordIdentityConfig {
  clientId: string;
  clientSecret: string;
  /** Mneme's public origin; the callback URL is derived from it. */
  publicBaseUrl: string;
  /** The one guild Mneme serves. */
  guildId: string;
  /** Role ids that may sign in (`MNEME_ADMIN_ROLE_IDS`). */
  adminRoleIds: readonly string[];
  fetchImpl?: typeof fetch;
}

/** A person's membership in the guild, as far as authorization cares. */
interface DiscordMembership {
  userId: string;
  /** Role ids, or null when they could not be resolved (fails closed). */
  roleIds: readonly string[] | null;
}

type MembershipOutcome =
  | { ok: true; membership: DiscordMembership }
  | { ok: false; reason: 'not_a_workspace_member' | 'identity_unavailable' };

/** The callback URL, which must match the Discord application's registration exactly. */
export function discordCallbackUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl}${DISCORD_CALLBACK_PATH}`;
}

/**
 * Build the real provider. Failures are collapsed into a few reasons: the caller
 * decides what a person sees, and a transport error, a rejected code, and a
 * malformed response are the same event to them.
 */
export function createDiscordIdentityClient(config: DiscordIdentityConfig): IdentityProvider {
  return {
    callbackPath: DISCORD_CALLBACK_PATH,
    authorizationUrl(state: string): string {
      // The `state` is the opaque handle of the stored request; nothing about the
      // client's redirect travels through the browser.
      const url = new URL(DISCORD_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('scope', DISCORD_SCOPES);
      url.searchParams.set('redirect_uri', discordCallbackUrl(config.publicBaseUrl));
      url.searchParams.set('state', state);
      return url.toString();
    },
    async identify(code: string): Promise<IdentityOutcome> {
      const accessToken = await exchangeCode(config, code);
      if (accessToken === null) return { ok: false, reason: 'code_exchange_failed' };
      const member = await fetchMembership(config, accessToken);
      if (!member.ok) return member;
      // The same admin roles that gate `/mneme mcp-token create` (Section 6.6).
      // `authorizeAdmin` fails closed on no configured roles and on unresolved roles.
      return {
        ok: true,
        identity: {
          userId: member.membership.userId,
          authorization: authorizeAdmin(member.membership.roleIds, config.adminRoleIds),
        },
      };
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
    response = await (config.fetchImpl ?? fetch)(`${DISCORD_API}/oauth2/token`, {
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
): Promise<MembershipOutcome> {
  let response: Response;
  try {
    response = await (config.fetchImpl ?? fetch)(`${DISCORD_API}/users/@me/guilds/${config.guildId}/member`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'identity_unavailable' };
  }
  if (response.status === 404) return { ok: false, reason: 'not_a_workspace_member' };
  if (!response.ok) return { ok: false, reason: 'identity_unavailable' };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'identity_unavailable' };
  }
  const member = payload as { user?: { id?: unknown }; roles?: unknown } | null;
  const userId = member?.user?.id;
  if (typeof userId !== 'string' || userId.length === 0) {
    return { ok: false, reason: 'identity_unavailable' };
  }
  // A missing roles array means the field could not be resolved. Passing null on
  // rather than an empty array is what lets the decision fail closed.
  const roleIds = Array.isArray(member?.roles)
    ? member.roles.filter((r): r is string => typeof r === 'string')
    : null;
  return { ok: true, membership: { userId, roleIds } };
}
