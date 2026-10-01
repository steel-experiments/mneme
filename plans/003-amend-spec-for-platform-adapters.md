# Plan 003: Amend the spec for platform adapters and Slack

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cc84413..HEAD -- MNEME_IMPLEMENTATION_SPEC.md AGENTS.md README.md plans/002-add-slack-support.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live text before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (documentation only; no code, test, or migration changes)
- **Depends on**: plan 002 (decisions 1–16)
- **Category**: docs
- **Planned at**: commit `cc84413`, 2026-10-01

## Why this matters

`MNEME_IMPLEMENTATION_SPEC.md` is the authority (`AGENTS.md`, `CONTRIBUTING.md`
lines 83–94). Plans 004–010 change the platform boundary and add Slack. A
reviewer must be able to compare each of those plans with a written rule. This
plan writes the platform-neutral definitions, the adapter contract, and the
Slack rules into the spec before any code changes.

`CONTRIBUTING.md` lines 88–94 say that code and spec change in the same pull
request, and that the spec must not describe behavior that does not exist. To
obey that rule, this plan labels every Slack rule with a status note. The note
names the plan that implements the rule. The plan that ships the behavior
removes the note. Until then, the spec says clearly that Mneme runs only on
Discord.

## Current state

- `MNEME_IMPLEMENTATION_SPEC.md:1-14` — front matter. Lines 2–6:

  ```yaml
  title: Mneme for Discord — Final Implementation Specification
  status: Final v1 specification
  version: 1.4
  date: 2026-08-21
  last_amended: 2026-09-18
  ```

- `MNEME_IMPLEMENTATION_SPEC.md:16` — `# Mneme for Discord — Final Implementation Specification`.
  Line 22 links `[Discord access and visibility boundaries](#6-discord-application-configuration)`.
- `MNEME_IMPLEMENTATION_SPEC.md:36` (§1) — "Mneme is a quiet organizational-memory
  agent for one Discord server. It ingests every message the bot is permitted to
  see, …, stays current through the Discord Gateway, …". Lines 40–47 list
  `one Discord bot` in the system block. Line 51 says the process "connects one
  Discord Gateway client".
- `MNEME_IMPLEMENTATION_SPEC.md:127-150` (§3 non-goals) — includes:

  ```text
  - Training or fine-tuning a model on Discord messages.
  - Multi-guild SaaS tenancy.
  - Running the Pi coding-agent shell, filesystem, or arbitrary network tools against Discord content.
  ```

- `MNEME_IMPLEMENTATION_SPEC.md:152-168` (§4 table) — has a row
  `| Discord integration | \`discord.js\` 14.x | … |` and no Slack row.
- `MNEME_IMPLEMENTATION_SPEC.md:229-255` (§5) — the mermaid diagram names
  `Discord Gateway`, `Discord REST API`, `Discord sender`, and `Discord channels`.
  §5.1 starts at line 257, §5.2 at line 323. There is no adapter section.
- `MNEME_IMPLEMENTATION_SPEC.md:338-415` (§6 "Discord application
  configuration", subsections 6.1–6.6). §6.6 at lines 409–415 limits commands
  to `MNEME_ADMIN_ROLE_IDS`.
- `MNEME_IMPLEMENTATION_SPEC.md:421-453` (§7.1) — the table says `org` content
  "may support interventions in other `org` channels in the same guild". The
  default is `restricted` (line 432). Threads inherit the parent's class
  (lines 434–438).
- `MNEME_IMPLEMENTATION_SPEC.md:857-898` (§9.3 "Gateway events") — lists Discord
  event names only.
- `MNEME_IMPLEMENTATION_SPEC.md:911-932` (§9.5) — "Fetch up to 100 newest
  messages … Let `discord.js` and Discord REST rate-limit handling control pacing."
- `MNEME_IMPLEMENTATION_SPEC.md:1016-1055` (§9.7 "Threads") — active and archived
  thread discovery and archive quarantine. All of it is Discord-specific.
- `MNEME_IMPLEMENTATION_SPEC.md:1219-1224` (§11.1):

  ```text
  The episode key is:

  - thread ID for thread messages;
  - channel ID otherwise.
  ```

- `MNEME_IMPLEMENTATION_SPEC.md:3199-3216` (§24.5 "Discord message formatting") —
  `allowed_mentions.parse = []`, masked links, 1,800- and 2,000-character limits.
- `MNEME_IMPLEMENTATION_SPEC.md:3218` (§25 review workflow) and `:3417-3428`
  (§26.1 unsupported-DM notice: "Ask me in the Discord server …").
- `MNEME_IMPLEMENTATION_SPEC.md:3539-3593` (§27 slash commands, guild-scoped
  `/mneme …` table).
- `MNEME_IMPLEMENTATION_SPEC.md:4731-4744` (§30.3 "Discord links") — one
  `https://discord.com/channels/{guild_id}/{channel_id}/{message_id}` template.
- `MNEME_IMPLEMENTATION_SPEC.md:4915-4964` (§32.5.2.1 OAuth sign-in) — line 4934:
  "`GET /oauth/discord/callback` exchanges Discord's code, reads guild roles, …".
- `MNEME_IMPLEMENTATION_SPEC.md:5325-5347` (§35.1 required env) — starts with
  `DISCORD_TOKEN=`, `DISCORD_APPLICATION_ID=`, `DISCORD_GUILD_ID=`. §35.6 lines
  5559–5563 list `DISCORD_OAUTH_CLIENT_ID` and `DISCORD_OAUTH_CLIENT_SECRET`.
- `MNEME_IMPLEMENTATION_SPEC.md:6248-6259` (§43.2 "Discord data policy").
- `MNEME_IMPLEMENTATION_SPEC.md:6699` (§48 acceptance criteria; "Privacy" at
  6774) and `:6911-6923` (§51 references; only a "Discord" list for platforms).
- Amendment notes already use this form in place, for example line 1326:
  `(Amendment (plan 018): Mneme must not speak into a conversation that is still in …`.
- `AGENTS.md:1-8` — `# Mneme for Discord` and "for one Discord server". Line 16
  says `MNEME_IMPLEMENTATION_SPEC.md` (v1.4). Line 25 (Stack) lists `discord.js 14`.
- `README.md:1-6` — `# Mneme for Discord` and "for one Discord server".

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Documentation checks | `npm run docs:check-public && npm run docs:check-links` | exit 0; no errors |
| Find stale anchors | `grep -n "#6-discord-application-configuration" -r MNEME_IMPLEMENTATION_SPEC.md docs README.md contributor-docs` | no output after Step 2 |
| Find status notes | `grep -n "Amendment (plan 003)" MNEME_IMPLEMENTATION_SPEC.md` | one hit for each Slack rule added |
| Whitespace | `git diff --check` | exit 0, no output |
| Full verification | `npm run verify` | exit 0 (proves that no code changed) |

## Scope

**In scope**:

- `MNEME_IMPLEMENTATION_SPEC.md`
- `AGENTS.md` ("What this is", ground-rule spec version, Stack line)
- `README.md` (first paragraph only)
- `plans/README.md` (status update only)

**Out of scope** (do not touch):

- Any file in `src/`, `test/`, `migrations/`, `config/`, `prompts/`, `scripts/`.
- `docs/` (plan 010 writes the operator docs for Slack).
- §29 schema text and every `guild_id` or `discord_message_id` name in the spec.
  Plan 004 renames them together with the migration.
- Any statement that Slack works today. Every Slack rule carries a status note.

## Git workflow

- Branch: `advisor/003-amend-spec-for-platform-adapters`
- One commit, for example: `docs(spec): define platform adapters and Slack rules`
- Do not push or open a PR unless the operator instructs you.

## Steps

Write all new prose in ASD-STE100 English. Use the status note below for each
Slack-only rule. Replace `NNN` with the plan number from plan 002, "Child plans":

```text
(Amendment (plan 003): specified, not implemented. Plan NNN implements this
rule. Until then, Mneme runs only on Discord.)
```

### Step 1: Make the title, summary, and non-goals platform-neutral

1. Front matter: set `title: Mneme — Final Implementation Specification`,
   `version: 1.5`, `last_amended: 2026-10-01`. Change the H1 at line 16 to match.
2. §1 line 36: "for one Discord server" becomes "for one Discord server or one
   Slack workspace (one platform for each deployment)". "stays current through
   the Discord Gateway" becomes "stays current through the platform event
   connection (the Discord Gateway or Slack Socket Mode)". In the block at lines
   40–47, `one Discord bot` becomes `one chat-platform bot (Discord or Slack)`.
   Line 51: "connects one Discord Gateway client" becomes "connects one platform
   event connection". Line 56 "Discord history is ingested" becomes "Chat
   history is ingested". Add the status note after the first Slack mention.
3. Add a short definitions paragraph at the end of §1 (decisions 1, 3):
   - **Workspace**: the one Discord server (guild) or Slack workspace (team)
     that a deployment serves.
   - **Channel**: a conversation container that has a visibility class.
   - **Thread**: a `channels` row with `is_thread = 1` and a `parent_id`. A
     Discord thread is a native channel. A Slack thread is a synthetic row (§9.7).
4. §3: "Training or fine-tuning a model on Discord messages" becomes "… on chat
   messages". "Multi-guild SaaS tenancy" becomes "Multi-workspace SaaS tenancy,
   and one deployment that serves more than one platform". "… against Discord
   content" becomes "… against chat content". Add the Slack non-goals from
   plan 002 "Out of scope": Slack Marketplace distribution or a hosted
   multi-tenant service; Enterprise Grid org-wide installs; reading Slack DMs or
   group DMs (`mpim`); huddles, canvases, lists, and workflow steps; auto-join
   of public channels.

**Verify**: `grep -n "Mneme for Discord" MNEME_IMPLEMENTATION_SPEC.md` → no output.

### Step 2: Add the technology rows and the adapter section

1. §4 table: add `| Platform selection | \`MNEME_PLATFORM=discord\|slack\`, required, no default | One platform for each deployment keeps one database and one visibility model. |`
   and `| Slack integration | \`@slack/bolt\` 5.x in Socket Mode | No public inbound URL; one process. |`
   (status note: plan 006).
2. §5 diagram: rename `Discord Gateway` to `Platform events`, `Discord REST API`
   to `Platform API`, `Discord sender` to `Platform sender`, `Discord channels` to
   `Chat channels`, and `Ingestion adapter` to `Platform adapter`.
3. Add `### 5.3 Platform adapters` after §5.2 (before `## 6.`). Content, from
   plan 002 decisions:
   - One adapter is active in a process. `MNEME_PLATFORM` selects it. A missing
     or unknown value stops startup (decision 1).
   - The core does not import a platform SDK. The adapter supplies: connection
     lifecycle and health; channel discovery with capabilities; history
     pagination with an opaque `before` cursor; normalized live events; outbound
     send that never pings; review cards and buttons; command registration and
     dispatch; actor resolution `{ userId, isAdmin }`; message links; the id
     validator; the text-format object; attachment download; and the MCP OAuth
     identity provider (decisions 5, 7, 8, 10–15).
   - Ids match `^[A-Za-z0-9.-]+$`. The core orders messages by `created_at_ms`
     with the id as a tie-break. The adapter computes `created_at_ms`
     (decisions 5, 6).
   - The core emits one Markdown subset: `**bold**`, `*italic*`,
     `[label](url)`, `> quote`, and inline code. The adapter converts it to the
     platform format (decision 7).
   - The review-card HMAC secret comes from the active platform bot token
     (decision 12).
   - Status note: plan 005 implements the seam; plan 006 implements the Slack
     adapter.
4. Fix the navigation link at line 22: text `Platform access and visibility
   boundaries`, anchor `#6-platform-application-configuration`.

**Verify**: the "Find stale anchors" command → no output.

### Step 3: Add the Slack application configuration (parallel to §6)

1. Rename `## 6. Discord application configuration` to
   `## 6. Platform application configuration`. Add one sentence below it:
   "Sections 6.1–6.6 apply to Discord. Section 6.7 applies to Slack."
2. Add `### 6.7 Slack application configuration` after §6.6, with the status
   note (plan 006) and these subsections:
   - **6.7.1 App type.** Each team creates its own Slack app in its own
     workspace and does not distribute it. This keeps Tier 3 limits for
     `conversations.history` and `conversations.replies`. Socket Mode is on. The
     app-level token (`xapp-`) has `connections:write`. The bot token is `xoxb-`.
   - **6.7.2 Bot scopes.** `channels:history`, `groups:history`,
     `channels:read`, `groups:read`, `users:read`, `reactions:read`,
     `files:read`, `chat:write`, `commands`, `im:write`. Do not request
     `channels:join`, `im:history`, `mpim:history`, or `mpim:read`. Mark the
     scope that reads message metadata (decision 13) as "to be confirmed by
     plan 007".
   - **6.7.3 Events.** `message.channels`, `message.groups`,
     `reaction_added`, `reaction_removed`, `channel_created`, `channel_rename`,
     `channel_deleted`,
     `channel_archive`, `channel_unarchive`, `channel_left`, `group_rename`,
     `group_deleted`, `group_archive`, `group_unarchive`, `group_left`,
     `member_joined_channel`, `member_left_channel`, `channel_shared`,
     `channel_unshared`.
   - **6.7.4 "All chats" on Slack.** Public and private channels where the bot
     is a member and that are not Slack Connect channels. The bot does not join
     channels itself; an admin invites it, and the invite is the consent
     (decision 9).
   - **6.7.5 Direct messages.** The App Home Messages tab is off. Mneme does not
     read DMs. Admin notices use `chat.postMessage` to the user id (decision 14).
   - **6.7.6 Admin permissions.** `MNEME_ADMIN_USER_IDS` lists Slack user ids.
     The §6.6 rule ("always require an admin") applies without change
     (decision 10).
   - **6.7.7 App manifest.** The repository ships
     `config/slack-app-manifest.yml` with the scopes and events above (plan 010).

### Step 4: Add the Slack visibility and thread rules

1. §7.1 table: "in the same guild" becomes "in the same workspace".
2. After the thread-inheritance paragraph (line 438), add a Slack paragraph with
   the status note (plan 006):
   - A Slack Connect channel (`is_ext_shared` or `is_pending_ext_shared` is
     true) always resolves to `excluded`. Policy cannot override this. A channel
     that becomes shared is excluded at once, and its stored content stops
     being retrievable on the next read.
   - The policy resolver has a `platform_boundary` source that the adapter
     supplies. It wins over every other source, including explicit thread rules
     and review decisions. The Slack Connect rule uses this source.
   - A channel that the bot leaves, or is removed from, becomes unavailable and
     fails closed.
   - A Slack thread inherits its channel's class like a Discord thread.
3. §9.3: rename the heading to `### 9.3 Platform events`. Keep the Discord list.
   Add a Slack list that maps each event in §6.7.3 to the same ingest action.
   Include `message_changed`, `message_deleted`, and `thread_broadcast`
   subtypes (status note: plan 006).
4. §9.5: add a Slack paragraph: use `conversations.history` for channels and
   `conversations.replies` for each parent whose `reply_count > 0`; obey
   `Retry-After`; never use the Data Access API or the Real-Time Search API
   (status note: plan 006). Change "Let `discord.js` and Discord REST
   rate-limit handling control pacing" to "The adapter's SDK controls pacing".
5. §9.7: add a final `Slack threads` paragraph with the status note
   (plan 006), from decisions 3 and 4:
   - A Slack thread is a synthetic channel row with id `<channelId>-T<thread_ts>`
     and `parent_id = <channelId>`.
   - A Slack message id is `<channelId>-<ts>`. A reply has the parent channel id
     in its message id and the thread row id in `channel_id`. The root message
     stays in the parent channel. A `thread_broadcast` reply is stored once, in
     the thread.
   - Slack threads are never archived. The archive discovery and quarantine
     rules above apply only to Discord. Discovery finds threads from parent
     messages with `reply_count > 0` and from live messages with `thread_ts`.
     Slack cannot list threads, so the adapter builds thread descriptors from
     stored thread rows whose parent is present. Discovery uses the `close`
     missing-thread mode for Slack, not `quarantine`.
6. §11.1: add "For Slack, the thread id is the synthetic thread row id (§9.7)."

### Step 5: Add Slack rules for output, review, commands, links, and OAuth

Each item carries the status note with the plan shown.

1. §24.5: rename to `### 24.5 Message formatting`. Mark the current list as
   Discord. Add a Slack list (plan 007): convert the §5.3 Markdown subset to
   mrkdwn; escape `&`, `<`, `>`; never send `link_names`; remove `<@…>`,
   `<!…>`, and `<!subteam^…>` that the host did not build; keep the 1,800- and
   2,000-character limits.
2. §25: add a sentence (plan 007): on Slack, review cards are Block Kit
   messages; button action ids keep the same HMAC format.
3. §26.1: add "This notice applies to Discord. Slack has no DM surface
   (§6.7.5)."
4. §27: add a paragraph (plan 007): Slack has one `/mneme` command; the adapter
   parses the text into the same subcommand path and options; replies are
   ephemeral; Slack does not allow slash commands in threads.
5. §30.3: rename to `### 30.3 Message links`. Keep the Discord template. Add the
   Slack template (plan 006):
   `https://{team_domain}.slack.com/archives/{channel}/p{ts without dot}`, plus
   `?thread_ts={root_ts}&cid={channel}` for a reply. `team_domain` comes from
   `auth.test` at startup.
6. §32.5.2.1: add a paragraph (plan 008): on Slack, sign-in uses Sign in with
   Slack (OpenID Connect). The callback accepts a user only when the
   `https://slack.com/team_id` claim equals the configured workspace. Admin
   status comes from `MNEME_ADMIN_USER_IDS`. The grant stays org scope.
7. §35.1: add `MNEME_PLATFORM=` as required. Add a Slack block (plans 005–006):
   `SLACK_BOT_TOKEN=`, `SLACK_APP_TOKEN=`, `SLACK_TEAM_ID=`, and
   `MNEME_ADMIN_USER_IDS=`. State that the `DISCORD_*` block is required only
   when `MNEME_PLATFORM=discord`. §35.6: add `SLACK_OAUTH_CLIENT_ID=` and
   `SLACK_OAUTH_CLIENT_SECRET=` (plan 008).
8. §43.2: rename to `### 43.2 Platform data policy`. Keep the Discord list.
   Add the Slack API Terms rules: the app is internal to the installing
   organization; no LLM training; no Data Access API or Real-Time Search API;
   a hosted multi-tenant service is out of scope (§3).
9. §48: add a `### Slack` acceptance list with the status note (plans 006–010):
   Slack Connect channels are excluded with no override; a channel that becomes
   shared stops being retrievable; no outbound message pings; thread replies
   form their own conversation; built links open the correct message.
10. §51: add a `### Slack` list with the doc URLs from plan 002 "Research
    summary".

### Step 6: Update `AGENTS.md` and `README.md`

1. `AGENTS.md:1` → `# Mneme`. Line 5: "for one Discord server" → "for one Discord
   server or one Slack workspace (one platform for each deployment; Slack support
   is in progress, see plans 002–010)". Line 16: `(v1.4)` → `(v1.5)`. Line 25
   Stack: add `@slack/bolt 5 (planned)` after `discord.js 14`.
2. `README.md:1-3`: keep `# Mneme for Discord` and the Discord text, because the
   product supports only Discord today. Do not change the README until plan 010.
   (This item is a deliberate no-op; record it in the commit message body.)

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0.

### Step 7: Run the repository gate and inspect scope

**Verify**:

- `npm run verify` → exit 0.
- `git diff --check` → exit 0 with no output.
- `git status --short` → only `MNEME_IMPLEMENTATION_SPEC.md` and `AGENTS.md`
  are modified.
- Update this plan's row in `plans/README.md` to `DONE`, then re-run
  `git status --short`.

## Test plan

- No code changes, so the existing suite must pass without change.
- Manual review: every Slack-only rule has exactly one status note that names
  an implementing plan. `grep -c "Amendment (plan 003)"` matches the number of
  Slack rules added.
- Manual review: no paragraph says that Slack works today.

## Done criteria

- [ ] The title, H1, and §1 are platform-neutral; version is 1.5.
- [ ] §5.3 defines the adapter contract from plan 002.
- [ ] §6.7 defines the Slack app type, scopes, events, "all chats", DMs, admins, and manifest.
- [ ] §7.1, §9.3, §9.5, §9.7, and §11.1 state the Slack visibility and thread rules.
- [ ] §24.5, §25, §26.1, §27, §30.3, §32.5.2.1, §35, §43.2, §48, and §51 have their Slack additions.
- [ ] Every Slack rule carries the status note.
- [ ] `AGENTS.md` matches.
- [ ] Documentation checks and `npm run verify` exit 0.
- [ ] `git diff --check` exits 0 with no output.
- [ ] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back without improvising if:

- A plan 002 decision conflicts with an existing spec rule that this plan does
  not mention, for example a privacy-matrix rule in §46.3.
- A docs check fails because `docs/` links to an anchor that this plan renames
  (for example §24.5, §30.3, or §43.2). Report the links; do not edit `docs/`.
- Writing a Slack rule requires a fact that plan 002 marks UNVERIFIED and the
  rule cannot carry a "to be confirmed" note.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- Each later plan (004–010) must remove the status notes for the rules it
  ships, in the same pull request as its code. Plan 010 removes the last notes
  and changes the README.
- Plan 004 renames `guild_id` and `discord_message_id` in §29 together with the
  migration. Do not do that here.
- Plan 002 does not yet assign `MNEME_PLATFORM` and the config split to a child
  plan. This plan names plans 005–006. If the operator assigns it elsewhere,
  update the status notes.
