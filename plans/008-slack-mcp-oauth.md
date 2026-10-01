# Plan 008: Add Sign in with Slack for MCP OAuth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cc84413..HEAD -- src/mcp/oauth src/platform src/config.ts src/bootstrap.ts test/integration/mcp-oauth-callback.test.ts test/integration/mcp-oauth-authorize.test.ts MNEME_IMPLEMENTATION_SPEC.md`
> Plans 005 and 006 are dependencies. They move `src/mcp/oauth/discord.ts` to
> `src/platform/discord/oauth-identity.ts`, add `ChatPlatform.oauthIdentity`,
> and change `src/config.ts` and `src/bootstrap.ts`. The excerpts below show the
> code at `cc84413`. Find each one at its new location (use `git log --follow`
> and `grep`). A change in behavior, not only in location, is a STOP condition.
> Record the new paths and line numbers in your report.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (a sign-in gate for the memory store)
- **Depends on**: 005 (the `ChatPlatform` seam, `oauthIdentity`, and
  `MNEME_PLATFORM`) and 006 (the Slack adapter directory, `SLACK_TEAM_ID`,
  `MNEME_ADMIN_USER_IDS`, and the Slack id validators). Plan 002 lists only
  005; the Slack configuration that this plan reads comes from 006.
- **Category**: feature
- **Planned at**: commit `cc84413`, 2026-10-01

## Why this matters

A remote MCP client (for example Claude) signs in through OAuth. Mneme is the
authorization server, and the chat platform is the identity provider. Today
the only identity provider is Discord. A Slack deployment of Mneme cannot
issue MCP tokens through a browser sign-in until Slack is an identity
provider. Plan 002 decision 15 sets the rules: Sign in with Slack, the
`team_id` must equal the configured workspace, admin status comes from
`MNEME_ADMIN_USER_IDS`, and the grant stays `org` scope.

## Current state

- `src/mcp/oauth/discord.ts` is the identity seam. `DiscordIdentityClient`
  (line 58) has one method, `identify(code)`. `createDiscordIdentityClient`
  (line 76) makes two server-to-server calls, each with a 4,000 ms timeout
  (`DISCORD_TIMEOUT_MS`, line 33): `exchangeCode` (line 92) and
  `fetchMembership` (line 127). The outcome carries the user id and the guild
  role ids:

  ```ts
  export type DiscordIdentityFailure =
    | 'code_exchange_failed'
    | 'not_a_guild_member'
    | 'membership_unavailable';

  export type DiscordIdentityOutcome =
    | { ok: true; membership: DiscordMembership }
    | { ok: false; reason: DiscordIdentityFailure };
  ```

- `src/mcp/oauth/authorize.ts` hard-codes the Discord leg. Lines 32–43:

  ```ts
  export const DISCORD_CALLBACK_PATH = '/oauth/discord/callback';
  const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
  export const DISCORD_SCOPES = 'identify guilds.members.read';
  ```

  `AuthorizationContext.discordClientId` (line 65), `discordAuthorizationUrl`
  (lines 182–190), and `discordCallbackUrl` (lines 193–195) use these values.
  `planAuthorization` (lines 107–174) is platform-neutral.

- `src/mcp/oauth/callback.ts` makes the decision. Line 6 imports
  `authorizeAdmin` from `src/discord/authorization.ts`. Lines 131–139:

  ```ts
  const identified = await deps.identity.identify(request.code);
  if (!identified.ok) {
    return refuse(session, identified.reason);
  }

  const decision = authorizeAdmin(identified.membership.roleIds, deps.adminRoleIds);
  if (!decision.authorized) {
    return refuse(session, decision.reason);
  }
  ```

  Every refusal sends the same `access_denied` (lines 191–199). The
  description says "This Discord account is not permitted to use this
  connector."

- `src/mcp/oauth/routes.ts` registers the callback route at line 59
  (`` [`GET ${DISCORD_CALLBACK_PATH}`]: discordCallbackHandler(deps) ``).
  `OAuthRouteDeps` (lines 38–49) carries `identity: DiscordIdentityClient` and
  `adminRoleIds`. `authorizeHandler` redirects with `discordAuthorizationUrl`
  at line 261.

- `src/bootstrap.ts:306-327` builds the Discord identity client from
  `config.mcp.oauthDiscordClientId`, `config.mcp.oauthDiscordClientSecret`,
  `config.mcp.publicBaseUrl`, and `config.discord.guildId`. It passes
  `adminRoleIds: config.adminRoleIds`.

- `src/config.ts:1028-1029` reads `DISCORD_OAUTH_CLIENT_ID` and
  `DISCORD_OAUTH_CLIENT_SECRET`. Lines 1043–1048 require both when
  `MCP_OAUTH_ENABLED` is set. Lines 1052–1057 require at least one admin role
  when `MCP_OAUTH_ENABLED` is set.

- `src/discord/authorization.ts:35-49` — `authorizeAdmin(memberRoleIds,
  adminRoleIds)` fails closed when no admin roles are configured
  (`no_admin_roles_configured`) and when role data is missing
  (`role_data_unavailable`).

- Tests: `test/integration/mcp-oauth-callback.test.ts` replaces the identity
  client with a fake (lines 41–46) and calls `/oauth/discord/callback`
  (line 94). `test/integration/mcp-oauth-authorize.test.ts` and
  `test/unit/mcp-oauth-authorize.test.ts` cover the authorize leg. No test
  covers the HTTP calls in `createDiscordIdentityClient`, and no test in the
  repository stubs global `fetch`.

- Spec: `MNEME_IMPLEMENTATION_SPEC.md` Section 32.5.2.1 (starts at line 4915)
  names Discord as the identity provider and describes the
  `/oauth/discord/callback` route.

- Slack facts (official docs, checked 2026-10-01; see plan 002 research
  summary). The discovery document is
  `https://slack.com/.well-known/openid-configuration`.
  - Authorize: `https://slack.com/openid/connect/authorize`
  - Token: `https://slack.com/api/openid.connect.token` (POST, form encoded)
  - User info: `https://slack.com/api/openid.connect.userInfo` (Tier 3)
  - JWKS: `https://slack.com/openid/connect/keys`
  - Scopes: `openid`, `profile`, `email`
  - Claims: `sub`, `https://slack.com/user_id`, `https://slack.com/team_id`
  - Slack Web API methods answer HTTP 200 with `{"ok": false, "error": …}`
    when they fail. HTTP status alone does not show success.

- What plans 005 and 006 give this plan (confirm each one before you start):
  - Plan 005 (Target layout and Step 8): `src/mcp/oauth/discord.ts` moves to
    `src/platform/discord/oauth-identity.ts`. `ChatPlatform` has
    `oauthIdentity?: OAuthIdentityClient`, `workspaceId`, `resolveActor`, and
    `isValidId`. `src/bootstrap.ts` takes the OAuth identity client from
    `platform.oauthIdentity`. `createPlatform(config, …)` in
    `src/platform/select.ts` switches on `config.platform`.
  - Plan 006 (Step 2): the Slack adapter lives beside the Discord adapter
    (plan 006 says `src/platform/slack/`; plan 005 says `src/platform/`; use
    the directory that exists). On `MNEME_PLATFORM=slack`, config reads
    `SLACK_TEAM_ID` and `MNEME_ADMIN_USER_IDS`, requires at least one admin user
    id, and validates user ids with `^[UW][A-Z0-9]{8,}$`.
  - Plan 007 (if it landed first) adds a Slack actor resolver that returns
    `{ userId, isAdmin: adminUserIds.has(userId) }`. Reuse it if it exists.

## Decision: call `userInfo`, do not verify the `id_token`

The Slack token response contains an `id_token` (a signed JWT) and an access
token. There are two ways to learn the user and team:

1. Verify the `id_token` signature against the JWKS, then read its claims.
2. Call `openid.connect.userInfo` with the access token.

Use option 2. Reasons:

- It keeps the current shape: two server-to-server calls, each with a timeout,
  as `createDiscordIdentityClient` does today.
- Mneme gets the token directly from Slack over TLS, so the TLS server check
  already authenticates the response (OpenID Connect Core 1.0, Section
  3.1.3.7, item 6, allows this for the code flow). A local signature check adds
  a JWKS fetch, key caching, key rotation, and clock-skew handling, with no
  added protection in this flow.
- It needs no new dependency. The repository has no JWT library.

Do not read claims from the unverified `id_token`. Use only the `userInfo`
response.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused identity tests | `npx vitest run test/unit/slack-identity.test.ts test/unit/discord-identity.test.ts` | exit 0; all tests pass |
| Focused OAuth tests | `npx vitest run test/integration/mcp-oauth-callback.test.ts test/integration/mcp-oauth-authorize.test.ts test/unit/mcp-oauth-authorize.test.ts` | exit 0; all tests pass |
| Config tests | `npx vitest run test/unit/config.test.ts` | exit 0; all tests pass |
| Documentation checks | `npm run docs:check-public && npm run docs:check-links` | exit 0; no errors |
| Full verification | `npm run verify` | exit 0; SQLite check, lint, both typechecks, tests, and build all pass |

If `test/unit/config.test.ts` does not exist, find the config tests with
`ls test/unit | grep -i config` and use that file.

## Scope

**In scope**:

- The Discord OAuth identity file (`src/platform/discord/oauth-identity.ts`
  after plan 005; `src/mcp/oauth/discord.ts` before it)
- `<slack adapter dir>/oauth-identity.ts` (new)
- The Slack adapter composition file, only to set `oauthIdentity`
- `src/mcp/oauth/identity.ts` (new: the shared identity types)
- `src/platform/types.ts`, only to point `oauthIdentity` at the new type
- `src/mcp/oauth/authorize.ts`
- `src/mcp/oauth/callback.ts`
- `src/mcp/oauth/routes.ts`
- Comment text only in `src/mcp/oauth/token.ts`, `src/mcp/oauth/client.ts`,
  and `src/mcp/oauth/metadata.ts`, where it says Discord is the only identity
  provider
- `src/config.ts` (OAuth keys and the admin check only)
- `src/bootstrap.ts` (the OAuth wiring block only)
- `test/unit/slack-identity.test.ts` (new)
- `test/unit/discord-identity.test.ts` (new)
- `test/integration/mcp-oauth-callback.test.ts`
- `test/integration/mcp-oauth-authorize.test.ts`
- `test/unit/mcp-oauth-authorize.test.ts`
- The config test file
- `MNEME_IMPLEMENTATION_SPEC.md` (Section 32.5.2.1 and the Section 35
  environment table)
- `docs/how-to/connect-mcp-clients.md`
- `docs/reference/configuration.md` (the MCP section)
- `.env.example` and `config/advanced.env.example` (OAuth lines only)
- `plans/README.md` (status update only)

**Out of scope** (do not touch):

- `planAuthorization`, PKCE, the token endpoint, refresh-token rotation, and
  the metadata documents. They do not depend on the identity provider.
- Per-user channel access. A sign-in always grants `org` scope with no
  restricted channels. Do not derive scope from Slack channel membership.
- Slash commands, review cards, and the `/mneme mcp-token` commands (plan 007).
- The Slack adapter connection and discovery (plan 006).
- The full Slack setup guide (plan 010). Add only the OAuth part here.

## Git workflow

- Branch: `advisor/008-slack-mcp-oauth`
- Commit as one logical change, for example:
  `feat(mcp): sign in with Slack for MCP OAuth`
- Do not push or open a PR unless the operator instructs you.

## Steps

### Step 1: Make the identity seam platform-neutral

Create `src/mcp/oauth/identity.ts` (start with the two `ABOUTME:` lines). Move
the shared types into it and give them neutral names:

```ts
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
```

The admin rule is different on each platform. Discord uses role ids, and
Slack uses a list of user ids. So each provider makes the admin decision and
returns it in `authorization`. The callback only reads the decision. If plan
005 or 007 added a shared actor authorization function, call it from the
providers. Do not write a second copy of the rule.

Replace the `OAuthIdentityClient` type that plan 005 put on `ChatPlatform`
with `IdentityProvider`. Change the Discord OAuth identity file to implement
`IdentityProvider`:

- Move `DISCORD_CALLBACK_PATH`, the authorize URL, `DISCORD_SCOPES`,
  `discordAuthorizationUrl`, and `discordCallbackUrl` from `authorize.ts`
  into the Discord OAuth identity file.
- `identify` calls `authorizeAdmin(roleIds, adminRoleIds)` after it reads the
  membership. The config gets `adminRoleIds` and `clientId`.
- Map `not_a_guild_member` to `not_a_workspace_member`, and
  `membership_unavailable` to `identity_unavailable`.
- Add an optional `fetchImpl?: typeof fetch` to the config, with global
  `fetch` as the default, so tests can stub HTTP without touching globals.

Remove `discordClientId` from `AuthorizationContext` in `authorize.ts`.
`authorize.ts` keeps `planAuthorization`, `errorRedirectUrl`, and the
request and plan types.

**Verify**: `npm run check` → exit 0. Expect errors only in `callback.ts`,
`routes.ts`, `bootstrap.ts`, and the tests. Step 2 fixes them.

### Step 2: Use the neutral seam in the callback and routes

In `src/mcp/oauth/callback.ts`:

- Replace `identity: DiscordIdentityClient` and `adminRoleIds` in
  `CallbackDeps` with `identity: IdentityProvider`.
- After `identify` succeeds, refuse when `identity.authorization.authorized`
  is false, with `identity.authorization.reason` as the refusal. Keep the
  rest of `completeSignIn` as it is: consume the session first, then hash and
  store the code, `org` scope, and no channel ids.
- `SignInRefusal` becomes
  `'provider_declined' | AuthorizationReason | IdentityFailure`.
- Change the refusal description to "This account is not permitted to use
  this connector." Every refusal must stay identical for the client.
- Remove the `authorizeAdmin` import.

In `src/mcp/oauth/routes.ts`:

- `OAuthRouteDeps.identity` becomes `IdentityProvider`. Remove
  `adminRoleIds`.
- Register the callback at `` `GET ${deps.identity.callbackPath}` ``. Only the
  active provider's path exists. A request to the other platform's path gets
  the normal unknown-route response.
- `authorizeHandler` redirects to `deps.identity.authorizationUrl(session.id)`.
- Rename `discordCallbackHandler` to `callbackHandler`. Change the log text
  "discord returned for a sign-in that no longer exists" to "the identity
  provider returned for a sign-in that no longer exists", and "handing off to
  discord" to "handing off to the identity provider". Keep the event names.

Update `test/integration/mcp-oauth-callback.test.ts` and the authorize tests
to the new seam. The fake provider has `callbackPath:
'/oauth/discord/callback'` and returns `authorization` directly. Keep every
existing case. Add one case: a provider that returns
`authorization: { authorized: false, reason: 'not_authorized' }` gives
`access_denied` with the same description as an identity failure.

**Verify**: `npx vitest run test/integration/mcp-oauth-callback.test.ts test/integration/mcp-oauth-authorize.test.ts test/unit/mcp-oauth-authorize.test.ts` → exit 0; all tests pass.

### Step 3: Add the Slack identity provider

Create `oauth-identity.ts` in the Slack adapter directory (start with two
`ABOUTME:` lines). Follow the structure and comment style of the Discord OAuth
identity file. The Slack adapter sets `oauthIdentity` to this provider when
`MCP_OAUTH_ENABLED` is set.

```ts
export const SLACK_CALLBACK_PATH = '/oauth/slack/callback';
const SLACK_AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/openid.connect.token';
const SLACK_USERINFO_URL = 'https://slack.com/api/openid.connect.userInfo';
export const SLACK_SCOPES = 'openid profile';
const SLACK_TIMEOUT_MS = 4_000;

export interface SlackIdentityConfig {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  /** The one Slack workspace Mneme serves (`SLACK_TEAM_ID`). */
  workspaceId: string;
  /** Slack user ids that may sign in (`MNEME_ADMIN_USER_IDS`). */
  adminUserIds: readonly string[];
  fetchImpl?: typeof fetch;
}
```

Do not request `email`. Mneme does not need it, and the data-minimization rule
applies (Section 3).

Behavior:

1. `authorizationUrl(state)` sets `response_type=code`, `client_id`,
   `scope=openid profile`, `redirect_uri` (`publicBaseUrl` +
   `SLACK_CALLBACK_PATH`), `state`, and `team=<workspaceId>`. The `team`
   parameter only preselects the workspace in the browser (UNVERIFIED that
   Slack honors it). It is not a security control. Step 3.4 is the control.
2. `identify(code)`, call 1: POST form-encoded `grant_type=authorization_code`,
   `code`, `redirect_uri`, `client_id`, and `client_secret` to
   `SLACK_TOKEN_URL`, with a `SLACK_TIMEOUT_MS` abort signal. Return
   `code_exchange_failed` on a transport error, a non-2xx status, a body that
   is not JSON, `ok !== true`, or a missing or empty `access_token`.
3. Call 2: GET `SLACK_USERINFO_URL` with `authorization: Bearer
   <access_token>` and the same timeout. Return `identity_unavailable` on a
   transport error, a non-2xx status, a body that is not JSON, or
   `ok !== true`.
4. Read `https://slack.com/team_id` and `https://slack.com/user_id`. If either
   is missing or empty, return `identity_unavailable`. If the team id is not
   equal to `workspaceId`, return `wrong_workspace`. A person who signs in to
   a different workspace must never get a code, even if their user id is in
   the admin list.
5. Admin decision: if `adminUserIds` is empty, return `authorization:
   { authorized: false, reason: 'no_admin_roles_configured' }`. (Plan 006
   config makes the list non-empty, but the provider must still fail closed.)
   Otherwise the person is authorized only if the user id is in
   `adminUserIds` (`not_authorized` if not). If the Slack actor resolver from
   plan 007 exists, use it.
6. Drop the access token when `identify` returns. Never store it, log it, or
   put it in an error message.

Create `test/unit/slack-identity.test.ts` with a stubbed `fetchImpl` that
records each request and returns a scripted `Response`. Cases:

- The authorization URL has the Slack authorize origin, `scope=openid
  profile`, the exact callback URL, the state, and the team id. It has no
  `email` scope.
- The token request is a POST to `SLACK_TOKEN_URL` with a form body that has
  the code, the redirect URI, the client id, and the client secret.
- The user info request sends the bearer token from the token response.
- Success: a matching team and an admin user id give `ok: true` with
  `authorized: true` and the Slack user id.
- A matching team and a user id that is not in the list give `ok: true` with
  `reason: 'not_authorized'`.
- An empty admin list gives `no_admin_roles_configured`.
- A different team id gives `wrong_workspace`.
- `{ ok: false, error: 'invalid_code' }` with HTTP 200 from the token
  endpoint gives `code_exchange_failed`.
- `{ ok: false }` from user info gives `identity_unavailable`.
- Missing claims, a body that is not JSON, a non-2xx status, and a stub that
  throws (timeout or network error) each give the correct failure.
- No error, log, or outcome contains the access token or the client secret.

Create `test/unit/discord-identity.test.ts` with the same stub pattern for
`createDiscordIdentityClient`. Cases: success with an admin role, a member
without the role, a 404 membership (`not_a_workspace_member`), a missing
roles array (`role_data_unavailable`), and a failed code exchange. This
closes the current test gap and proves Step 1 kept the Discord behavior.

**Verify**: `npx vitest run test/unit/slack-identity.test.ts test/unit/discord-identity.test.ts` → exit 0; all tests pass.

### Step 4: Read the Slack OAuth keys and wire the provider

In `src/config.ts`:

- Read `SLACK_OAUTH_CLIENT_ID` and `SLACK_OAUTH_CLIENT_SECRET` beside the
  Discord keys. Rename the config fields to provider-neutral names
  (`oauthProviderClientId` and `oauthProviderClientSecret`). Fill them from
  the keys of the active platform. Update the field comments.
- When `MCP_OAUTH_ENABLED` is set, require the client id and secret of the
  active platform. The `ConfigError` names the missing key
  (`SLACK_OAUTH_CLIENT_ID` or `DISCORD_OAUTH_CLIENT_ID`). Ignore the keys of
  the other platform.
- Keep the check that requires `MNEME_ADMIN_ROLE_IDS` when OAuth is on, for
  Discord only. On Slack, plan 006 already requires `MNEME_ADMIN_USER_IDS`. Do
  not add a second check.

In the Slack adapter composition, build the Slack provider from
`SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`, `MCP_PUBLIC_URL`
(the config field `mcp.publicBaseUrl`), `SLACK_TEAM_ID`, and
`MNEME_ADMIN_USER_IDS`. In the Discord adapter composition, pass
`adminRoleIds` and the client id into the Discord provider.

In `src/bootstrap.ts` (the OAuth block at lines 306–327 at `cc84413`), pass
`platform.oauthIdentity` to `createOAuthRoutes`. Remove `adminRoleIds` from
the call and `discordClientId` from the context. If OAuth is on and
`platform.oauthIdentity` is missing, fail startup.

Add config tests:

- Slack platform, OAuth on, and Slack keys missing → `ConfigError` that names
  `SLACK_OAUTH_CLIENT_ID`.
- Slack platform with only the Discord OAuth keys set → `ConfigError` that
  names the Slack key.
- The existing Discord cases still pass unchanged.

**Verify**: run the config test file, then `npm run check && npm run check:test` → all exit 0.

### Step 5: Amend the spec and the documentation

`MNEME_IMPLEMENTATION_SPEC.md` Section 32.5.2.1:

- The identity provider is the active chat platform: Discord or Slack.
- Add the Slack callback route `GET /oauth/slack/callback`. Only the active
  platform's callback route exists.
- Slack sign-in: OpenID Connect with the `openid profile` scopes, a code
  exchange, then `openid.connect.userInfo`. The `https://slack.com/team_id`
  claim must equal the configured workspace. Admins come from
  `MNEME_ADMIN_USER_IDS`.
- State the decision to use `userInfo` and not to verify the `id_token`, with
  the reason in one sentence.
- Keep the text that says every refusal is `access_denied`, and add
  `wrong_workspace` to the list of refusals that look the same to the client.

In Section 35.6, plan 003 already lists `SLACK_OAUTH_CLIENT_ID` and
`SLACK_OAUTH_CLIENT_SECRET`. Check that the text matches what you built.

`docs/how-to/connect-mcp-clients.md`: add a Slack subsection. Tell the
operator to add the redirect URL `https://<public-base>/oauth/slack/callback`
in the Slack app settings under **OAuth & Permissions**, to set the two Slack
OAuth variables, and to make sure their own Slack user id is in
`MNEME_ADMIN_USER_IDS`. Use placeholders only. Do not use real ids.

`docs/reference/configuration.md` (MCP section), `.env.example`, and
`config/advanced.env.example`: add the Slack OAuth keys beside the Discord
keys, with one comment line that says which platform uses them.

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0.

### Step 6: Run the repository gate and inspect scope

**Verify**:

- `npm run verify` → exit 0.
- `git diff --check` → exit 0 with no output.
- `git status --short` → only files in the **In scope** list changed.
- `grep -rn -i "discord" src/mcp/oauth/` → no output. Discord-specific
  OAuth code stays only in the Discord adapter directory.
- Update this plan's row in `plans/README.md` to `DONE`.

## Test plan

- Slack provider: URL, token exchange, user info, team check, admin decision,
  and each failure mode, with no network (stubbed `fetchImpl`).
- Discord provider: the same behavior as before Step 1, now covered by its own
  unit test.
- Callback: every refusal, including `wrong_workspace` and
  `not_authorized`, gives the same `access_denied` and description.
- Routes: only the active platform's callback path is registered.
- Config: the active platform's keys and admin list are required when OAuth
  is on. The other platform's keys are ignored.
- Regression: all existing OAuth integration tests pass.

## Done criteria

- [ ] `IdentityProvider` exists, and `callback.ts`, `routes.ts`, and
      `authorize.ts` contain no Discord-specific code.
- [ ] A Slack sign-in from a different workspace never produces an
      authorization code.
- [ ] A Slack sign-in by a user who is not in `MNEME_ADMIN_USER_IDS` never
      produces an authorization code.
- [ ] Slack `ok: false` responses with HTTP 200 are treated as failures.
- [ ] Access tokens and client secrets appear in no log, error, or stored row.
- [ ] A successful sign-in still grants `org` scope with no channel ids.
- [ ] The spec, the MCP how-to, the configuration reference, and both env
      examples describe the Slack sign-in.
- [ ] `npm run verify` exits 0.
- [ ] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back without improvising if:

- An excerpt in `src/mcp/oauth/*` does not match the live code.
- Plan 005 did not add `ChatPlatform.oauthIdentity` or a platform selector,
  or plan 006 did not add `SLACK_TEAM_ID` and `MNEME_ADMIN_USER_IDS`. This
  plan must not invent them.
- Plan 006 or 007 added an admin rule for Slack that disagrees with
  `MNEME_ADMIN_USER_IDS` (for example a user group).
- The Slack token or user info endpoint returns a shape that is different
  from the shape described in Current state when you test it by hand.
- A step needs a change to per-user scope, the token endpoint, or PKCE.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- The team check is the security control. The `team` URL parameter only
  makes the browser flow easier.
- If Mneme ever gets a hosted, multi-workspace form, the `id_token` decision
  must be reviewed. That form is out of scope (plan 002).
- Slack guests can sign in with Slack. They get a code only if an operator
  puts their user id in `MNEME_ADMIN_USER_IDS`. Do not add a guest check
  unless the spec asks for it.
- Reviewers should check that the refusal for a different workspace looks
  exactly like every other refusal. Otherwise the connector tells a stranger
  which workspace Mneme serves.
