// ABOUTME: The MCP OAuth identity-provider seam shared by every chat platform.
// ABOUTME: A provider sends a person to sign in, identifies them on return, and makes the admin decision.

import type { AuthorizationOutcome } from '../../policy/authorization.js';

/**
 * The identity-provider boundary (Section 32.5.2.1).
 *
 * Mneme is the authorization server; the active chat platform is the identity
 * provider. Each platform has its own admin rule (role ids on one platform,
 * user ids on another), so the provider makes the admin decision and returns
 * it. The callback only reads the decision and never applies a platform rule.
 */

/** Why identifying the person failed. */
export type IdentityFailure =
  | 'code_exchange_failed'
  | 'not_a_workspace_member'
  | 'wrong_workspace'
  | 'identity_unavailable';

/** The person who signed in, and the platform's admin decision for them. */
export interface SignedInIdentity {
  userId: string;
  authorization: AuthorizationOutcome;
}

export type IdentityOutcome =
  | { ok: true; identity: SignedInIdentity }
  | { ok: false; reason: IdentityFailure };

/** One identity provider: where to send a person, and how to identify them on return. */
export interface IdentityProvider {
  /** Callback path on Mneme's origin. Must be registered with the provider. */
  callbackPath: string;
  /** The URL that sends a person to the provider. `state` is the login session id. */
  authorizationUrl(state: string): string;
  identify(code: string): Promise<IdentityOutcome>;
}
