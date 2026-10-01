# Plan 010: Document Slack setup and ship the app manifest

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cc84413..HEAD -- docs README.md AGENT_SETUP.md mkdocs.yml .env.example config/advanced.env.example scripts/check-public-docs.mjs .github/workflows/ci.yml src/fixture-mode.ts test/unit/docs-index.test.ts contributor-docs MNEME_IMPLEMENTATION_SPEC.md`
> Plans 003–009 change many of these files. This plan documents what they
> built, so drift is expected. Do not trust the line numbers below without a
> check. Trust the code, the spec, and the "Spike results" sections of plans
> 006, 007, and 009. When the docs and the code disagree, the code and the spec
> win; when the code and the spec disagree, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (docs, examples, one manifest, CI guards)
- **Depends on**: 007, 008, 009 (and through them 003–006)
- **Category**: docs
- **Planned at**: commit `cc84413`, 2026-10-01

## Why this matters

After plans 003–009, Mneme can run on Slack, but an operator cannot find out
how. The public docs, the README, the setup runbook for coding agents, and
the env examples describe only Discord. A Slack app needs exact scopes,
events, a slash command with escaping, Socket Mode, and the Messages tab
setting. One wrong scope fails silently (for example, a missing `files:read`
gives Slack's HTML sign-in page as an attachment). A manifest file that the
operator pastes into Slack, and a test that keeps it equal to the code, remove
that class of error. The docs must also state the Slack API Terms limit: each
team creates its own app and does not distribute it.

## Current state

- **No Slack docs.** `git grep -n -i slack -- docs README.md AGENT_SETUP.md`
  gives no output at `cc84413`.
- **Discord-specific pages.** Count of lines that contain "Discord" at
  `cc84413`: `AGENT_SETUP.md` 19, `docs/reference/configuration.md` 17,
  `docs/explanation/architecture.md` 17, `docs/reference/http-and-mcp.md` 13,
  `docs/how-to/railway.md` 13, `README.md` 12,
  `docs/tutorials/getting-started.md` 12, `contributor-docs/architecture.md`
  12, `docs/reference/discord-commands.md` 10,
  `docs/explanation/security-model.md` 9, `docs/how-to/troubleshooting.md` 8,
  `docs/explanation/speaking-and-review.md` 8,
  `docs/how-to/connect-mcp-clients.md` 7,
  `contributor-docs/acceptance-checklist.md` 6,
  `docs/reference/vm-requirements.md` 5, `docs/index.md` 5,
  `docs/explanation/conversation-analysis.md` 5, and 1–4 in
  `docs/privacy-notice.md`, `docs/how-to/use-mneme.md`,
  `docs/how-to/publish-privacy-notice.md`, `docs/how-to/backup-and-restore.md`,
  `docs/how-to/deploy.md`, `docs/explanation/safety-and-assurance.md`,
  `docs/explanation/memory-quality.md`, `CONTRIBUTING.md`, and
  `docs/how-to/roll-out-safely.md`. Re-run the count after the drift check:
  `for f in $(git ls-files docs README.md AGENT_SETUP.md contributor-docs CONTRIBUTING.md); do c=$(grep -c -i discord "$f"); [ "$c" -gt 0 ] && echo "$c $f"; done | sort -rn`

- **Titles.** `README.md:1` and `docs/index.md:1` are `# Mneme for Discord`.
  Plan 003 Step 6 keeps the README title until this plan.

- **Tutorial.** `docs/tutorials/getting-started.md` has steps "1. Create the
  Discord application" (line 15), "2. Create a least-privilege role"
  (line 36), "3. Create the environment file" (line 55), "4. Select the
  channels" (line 95), then steps 5–9 that do not depend on the platform.

- **Command reference.** `docs/reference/discord-commands.md` is linked from
  `README.md:126`, `docs/index.md:40`, `docs/how-to/backup-and-restore.md:243`,
  `mkdocs.yml:28`, and the docs-tool example at
  `MNEME_IMPLEMENTATION_SPEC.md:2850`. `test/unit/docs-index.test.ts:155` and
  `:158` index the real docs folder and expect this path and the title
  "Discord command reference".

- **Env examples.** `.env.example:6-9` has a `# ---- Discord (required) ----`
  block. `config/advanced.env.example:9-12` has the same keys under
  `# ---- Required (Section 35.1) ----`. Plans 005–008 add `MNEME_PLATFORM`,
  the Slack keys, and the Slack OAuth keys. Check what is there now.

- **Railway.** `docs/how-to/railway.md:62-86` lists the template variables:
  only Discord keys. The template itself lives on railway.com, outside this
  repository (`https://railway.com/template/mneme`).
  `contributor-docs/release-process.md:90-94` records the template release.

- **Disclosure check.** `scripts/check-public-docs.mjs:10-16` fails on local
  paths, UUIDs, Discord snowflakes, and Railway hostnames in `docs/`. It has
  no check for Slack tokens or Slack ids.

- **CI.** `.github/workflows/ci.yml:66-77` asserts that `DISCORD_TOKEN` and the
  provider keys are empty in the smoke job. `src/fixture-mode.ts:349-361`
  (`assertFixtureModeSafe`) refuses to start when `DISCORD_TOKEN` is set.
  `test/integration/fixture-mode.test.ts:97-101` tests it. Fixture mode
  writes synthetic rows and never connects to a platform, so it does not need
  a Slack variant.

- **What the earlier plans define** (confirm each one in the code):
  - Plan 003: spec §6.7 (Slack application configuration: app type, bot
    scopes, events, "all chats", DMs, admins, manifest), the §7 Slack
    visibility rules, and §35 Slack keys.
  - Plan 006: the Slack keys (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
    `SLACK_TEAM_ID`, `MNEME_ADMIN_USER_IDS`), a code constant with the read
    scopes, the live events that the adapter handles (Step 6), the Slack
    Connect exclusion, and the reply-event spike results (Step 1).
  - Plan 007: the write scopes (`chat:write`, `commands`, `im:write`, and the
    metadata scope if its spike needs one), the slash command grammar, the
    `should_escape: true` requirement, and the spike result on the App Home
    Messages tab (Step 1, item 5).
  - Plan 008: `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`, and the
    callback path `/oauth/slack/callback`.
  - Plan 009: `files:read` for archive modes, and the spike results on file
    hosts.

- **API Terms** (plan 002 research summary): an internal app, created by a
  team for its own workspace, keeps Tier 3 limits for
  `conversations.history` and `conversations.replies`. A commercially
  distributed app that is not in the Marketplace gets 1 request per minute
  and 15 messages per page. Socket Mode apps cannot be in the Marketplace.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Manifest test | `npx vitest run test/unit/slack/manifest.test.ts` | exit 0; all tests pass |
| Docs index test | `npx vitest run test/unit/docs-index.test.ts` | exit 0; all tests pass |
| Fixture guard test | `npx vitest run test/integration/fixture-mode.test.ts` | exit 0; all tests pass |
| Documentation checks | `npm run docs:check-public && npm run docs:check-links` | exit 0; no errors |
| Docs site build | `mkdocs build --strict` (after `pip install -r requirements-docs.txt`) | exit 0; no warnings |
| Full verification | `npm run verify` | exit 0; SQLite check, lint, both typechecks, tests, and build all pass |

If `mkdocs` cannot be installed, record this in your report; CI builds the
site in `.github/workflows/pages.yml`.

## Scope

**In scope**:

- `config/slack-app-manifest.yml` (new)
- `test/unit/slack/manifest.test.ts` (new)
- `.env.example`, `config/advanced.env.example`
- Every file under `docs/`
- `docs/reference/discord-commands.md` → `docs/reference/commands.md` (rename)
- `README.md`, `AGENT_SETUP.md`, `CONTRIBUTING.md`, `AGENTS.md` (the "Slack
  support is in progress" text and the "(planned)" stack note that plan 003
  added)
- `contributor-docs/architecture.md`, `contributor-docs/release-process.md`,
  `contributor-docs/acceptance-checklist.md`
- `mkdocs.yml` (nav only)
- `MNEME_IMPLEMENTATION_SPEC.md` (the docs-tool example path at line 2850, and
  §6.7.7 if the manifest path or content differs)
- `test/unit/docs-index.test.ts` (the renamed path and title)
- `scripts/check-public-docs.mjs`
- `.github/workflows/ci.yml` (the credential assertion step only)
- `src/fixture-mode.ts` (`assertFixtureModeSafe` only) and
  `test/integration/fixture-mode.test.ts`
- `plans/README.md` (status update only)

**Out of scope** (do not touch):

- Any runtime behavior. If a doc needs the code to change, STOP.
- The Railway template on railway.com. Publishing it is an operator action.
- The test fixture under `test/unit/docs-tools.test.ts` that uses the path
  `reference/discord-commands.md`. It is a synthetic index, not the real docs
  folder.
- A Slack container smoke test. Fixture mode does not use a platform, so the
  existing smoke job covers the image on both platforms.
- Translations, screenshots, and new diagrams.

## Git workflow

- Branch: `advisor/010-slack-setup-docs`
- Commit in two logical parts:
  1. `feat(slack): ship the app manifest and keep it equal to the code`
     (manifest, manifest test, env examples, disclosure check, CI and
     fixture guard)
  2. `docs: document Slack setup and operation` (everything else)
- Do not push or open a PR unless the operator instructs you.

## Steps

### Step 1: Collect the facts and check that they agree

Before you write any doc, make a fact sheet (keep it in your notes, not in
the repository):

1. The bot scopes: the union of the scope constants in the Slack adapter
   (plan 006 read scopes, plan 007 write scopes, and `files:read` from plan
   009 if it is not already in the read set).
2. The bot events: the Slack events that the adapter registers (plan 006
   Step 6). Find them in the code, for example by the Bolt `app.event(…)`
   calls.
3. The env keys for Slack, with their rules, from the config loader.
4. The slash command grammar and `help` output from plan 007.
5. The Messages tab setting from plan 007 "Spike results", item 5.
6. The metadata scope result from plan 007 "Spike results", item 1.
7. The file host and redirect result from plan 009 "Spike results".
8. Spec §6.7.2 (scopes) and §6.7.3 (events).

Compare items 1 and 2 with items 8. Plan 003 wrote §6.7.3 before plan 006
existed, and plan 006 Step 6 handles `channel_created` and
`member_left_channel`, which §6.7.3 does not list. Make the spec match the
code if the only difference is a missing event or scope that the code
already handles. Any other difference is a STOP condition.

**Verify**: every item has a value from the code or a "Spike results"
section. If a spike section is missing, STOP.

### Step 2: Ship the manifest and a test that keeps it equal to the code

Export two constants from the Slack adapter if they do not exist:
`SLACK_BOT_SCOPES` (sorted array) and `SLACK_BOT_EVENTS` (sorted array). Use
them where the adapter already needs the lists. Do not create a second list.

Create `config/slack-app-manifest.yml`. Start it with a comment block that
says (ASD-STE100):

- Paste this file into "Create an app → From a manifest" in your own
  workspace.
- Do not turn on public distribution. Mneme is an internal app. A
  distributed app gets much lower history rate limits and other API Terms.
- Replace `mneme.example.com` with your public base URL, or remove the
  `oauth_config.redirect_urls` block if you do not use MCP OAuth.

Content (adjust only from the fact sheet):

```yaml
display_information:
  name: Mneme
  description: Quiet organizational memory for this workspace.
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: false          # from plan 007 spike item 5
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Mneme
    always_online: true
  slash_commands:
    - command: /mneme
      description: Mneme admin commands. Type /mneme help.
      usage_hint: help
      should_escape: true
oauth_config:
  redirect_urls:
    - https://mneme.example.com/oauth/slack/callback
  scopes:
    bot: [ …SLACK_BOT_SCOPES… ]
settings:
  event_subscriptions:
    bot_events: [ …SLACK_BOT_EVENTS… ]
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Create `test/unit/slack/manifest.test.ts`. Parse the file with the `yaml`
package (already a dependency). Assert:

- `oauth_config.scopes.bot`, sorted, equals `SLACK_BOT_SCOPES`.
- `settings.event_subscriptions.bot_events`, sorted, equals
  `SLACK_BOT_EVENTS`.
- No scope is in the forbidden set: `channels:join`, `im:history`,
  `mpim:history`, `mpim:read`, `groups:write`, `channels:manage`,
  `chat:write.public`, `admin`, and any scope that starts with `admin.`.
- `settings.socket_mode_enabled` is true, `org_deploy_enabled` is false.
- The one slash command is `/mneme`, with `should_escape: true`.
- `features.app_home.messages_tab_enabled` equals the value from the plan 007
  spike.
- Every redirect URL ends with the Slack callback path constant from plan 008
  (`SLACK_CALLBACK_PATH`).

Then, in a test workspace (not production), create an app from the manifest.
Slack validates the file when it creates the app. Record the result in your
report. If Slack rejects a field, fix the manifest and the test together.

**Verify**: `npx vitest run test/unit/slack/manifest.test.ts` → exit 0.

### Step 3: Update the env examples, the disclosure check, and the CI guards

`.env.example`: at the top, a `# ---- Platform (required) ----` block with
`MNEME_PLATFORM=` and one comment line (`discord` or `slack`; there is no
default). Then a `# ---- Discord (only when MNEME_PLATFORM=discord) ----`
block and a `# ---- Slack (only when MNEME_PLATFORM=slack) ----` block with
`SLACK_BOT_TOKEN=`, `SLACK_APP_TOKEN=`, `SLACK_TEAM_ID=`, and
`MNEME_ADMIN_USER_IDS=`. Keep `MNEME_ADMIN_ROLE_IDS` in the Discord block.
Write which channel id forms the basic selection accepts on Slack (Slack has
no categories), as the config loader from plan 006 implements it.
`config/advanced.env.example`: the same structure, plus
`SLACK_OAUTH_CLIENT_ID=` and `SLACK_OAUTH_CLIENT_SECRET=` beside the Discord
OAuth keys. Do not add a key that the config loader does not read.

`scripts/check-public-docs.mjs`: add these checks:

- `Slack token`: `/\bxox[abposr]-[A-Za-z0-9-]{8,}/g` and
  `/\bxapp-\d-[A-Za-z0-9-]{8,}/g`.
- `Slack id`: `/\b[TCGUWF](?=[A-Z0-9]*\d)[A-Z0-9]{8,11}\b/g` (an id with at
  least one digit). Docs must use placeholders with no digit, for example
  `CXXXXXXXXX` and `UXXXXXXXXX`.

Run the check on `docs/` before you write the new docs, to prove that the
patterns give no false positives on the current text.

`.github/workflows/ci.yml` (the "Assert no credentials" step): add
`test -z "${SLACK_BOT_TOKEN:-}"`, `test -z "${SLACK_APP_TOKEN:-}"`, and
`test -z "${SLACK_OAUTH_CLIENT_SECRET:-}"`. Update the comment above the step.

`src/fixture-mode.ts`: `assertFixtureModeSafe` also refuses to start when
`SLACK_BOT_TOKEN` or `SLACK_APP_TOKEN` is set. The message names the
variable. Update the comment. In `test/integration/fixture-mode.test.ts`, add
one case for each Slack variable.

**Verify**: `npx vitest run test/integration/fixture-mode.test.ts` → exit 0,
then `npm run docs:check-public` → exit 0.

### Step 4: Rename the command reference and write the platform sections

`git mv docs/reference/discord-commands.md docs/reference/commands.md`.
Change the title to `# Command reference`. Add a section "Type a command" at
the top:

- **Discord**: the `/mneme` slash command with option fields, as now.
- **Slack**: `/mneme <subcommand> [arguments]` or
  `/mneme <group> <subcommand> [arguments]`, the argument rules from plan 007
  (positional order, double quotes, the last string option takes the rest of
  the line, user and channel options), `/mneme help`, and two notes: Slack
  does not allow slash commands in threads, and replies are visible only to
  you.

Keep the subcommand tables. Where a row says "role", say "admin" and link to
the admin rule for each platform.

Update every link: `README.md`, `docs/index.md`,
`docs/how-to/backup-and-restore.md`, `mkdocs.yml` nav (`Commands:
reference/commands.md`), the spec example at
`MNEME_IMPLEMENTATION_SPEC.md:2850`, and `test/unit/docs-index.test.ts:155`
and `:158` (new path and title `Command reference`).

**Verify**: `npx vitest run test/unit/docs-index.test.ts` → exit 0, then
`npm run docs:check-links` → exit 0.

### Step 5: Write the Slack setup path

`docs/tutorials/getting-started.md`:

- Title stays "Install Mneme". "What you need" lists the items for each
  platform.
- Step 1 becomes "Create the chat app" with two parts. **Discord**: the
  current steps 1 and 2. **Slack**: create the app from
  `config/slack-app-manifest.yml` in your own workspace; do not turn on
  distribution, and say why (rate limits and API Terms, one sentence each);
  install it to the workspace; copy the bot token (`xoxb-`); create an
  app-level token with `connections:write` (`xapp-`); find the team id and
  your user id.
- Step 3 (environment file) shows the block for each platform.
- Step 4 (channels): on Slack, invite the bot to each channel with
  `/invite @Mneme`. The invite is the consent; Mneme never joins a channel
  itself. Slack Connect channels are always excluded, and no setting changes
  this. A private channel works only after an invite.
- Steps 5–9 stay the same. Where they say "Discord server", say "workspace"
  or "server", as fits.

`docs/how-to/railway.md`: add a "Deploy for Slack" section. Until a Slack
template exists, the operator deploys the same image and sets the Slack
variables by hand. Give the variable table for Slack. Do not link to a Slack
template that does not exist.

`AGENT_SETUP.md`: add a first step "Ask which platform" and a Slack branch for
each Discord-only step. Keep the rule that the agent never asks for a token in
chat. Add the Slack items to the definition of done (the bot is in the
channels that the person chose, `/mneme status` works for a user in
`MNEME_ADMIN_USER_IDS`, and no Slack Connect channel shows as ingested).

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0.

### Step 6: Update the reference, explanation, and how-to pages

Use the fact sheet from Step 1. Each item names the page and what to add.

- `docs/reference/configuration.md`: a "Platform" section first
  (`MNEME_PLATFORM`), then the Discord keys and the Slack keys in two tables.
  Merge with the rows that plans 005–009 added; do not duplicate them.
- `docs/reference/http-and-mcp.md`: the OAuth callback path for each
  platform; only the active one exists.
- `docs/reference/vm-requirements.md`: Slack needs outbound HTTPS and a
  WebSocket to Slack (`slack.com` and its subdomains, and the file hosts from
  plan 009). No inbound port is needed for Socket Mode.
- `docs/explanation/architecture.md`: the adapter seam (one sentence on what
  it holds), one platform for each deployment, Slack threads as thread rows,
  and the startup order for Slack.
- `docs/explanation/security-model.md`: Slack Connect channels are always
  excluded; the invite is the consent; the bot token goes only to Slack's
  file host; Slack has no mention allow-list, so Mneme escapes all text it
  did not build; admins are a user id list.
- `docs/privacy-notice.md` and `docs/how-to/publish-privacy-notice.md`: words
  that fit both platforms. On Slack, the notice must say which channels the
  bot was invited to.
- `docs/how-to/troubleshooting.md`: a "Slack" section with: the bot does not
  see a channel (not invited); history is empty for a private channel (not
  invited, or `groups:history` missing); a channel is excluded (Slack
  Connect); startup fails with a team mismatch; `invalid_auth` or
  `missing_scope`; Socket Mode does not connect (wrong or missing `xapp-`
  token, `connections:write` missing); an attachment fails with "HTML page"
  (`files:read` missing); a slash command does nothing in a thread.
- `docs/how-to/use-mneme.md`: how to mention Mneme on Slack (`@Mneme`), and
  that answers come as thread replies or in the channel as plan 007 built.
- `docs/how-to/connect-mcp-clients.md`: check the Slack part that plan 008
  added; fix it only if it disagrees with the code.
- `docs/index.md`: title `# Mneme`, first paragraph for one Discord server or
  one Slack workspace.
- Every other page in the Current state count: replace "Discord" with a
  neutral word where the text is not about Discord. Keep "Discord" where the
  text is only about Discord, and add the Slack equivalent next to it when
  one exists.
- `contributor-docs/architecture.md` and
  `contributor-docs/acceptance-checklist.md`: add the Slack adapter paths and
  one acceptance row for each of plans 006–009, with their test file names.

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0.

### Step 7: Update the README and the release process

`README.md`:

- Title `# Mneme`. First paragraph: one Discord server or one Slack
  workspace, one platform for each deployment.
- In "Set it up with your coding agent" and the quick links, point to both
  setup paths.
- Add a short "Platforms" section: Discord and Slack, what is the same (memory,
  visibility rules, review, MCP), what is different (threads, invites as
  consent, Slack Connect excluded, command syntax), and the internal-app rule
  for Slack.
- Fix the command reference link (Step 4).

`AGENTS.md`: remove "Slack support is in progress, see plans 002–010" and
"(planned)", because this plan completes the work.

`contributor-docs/release-process.md`: add a release item: publish or update
a Railway template for Slack with the Slack variables, then update
`docs/how-to/railway.md` to link to it. This is an operator action outside the
repository.

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0.

### Step 8: Run the repository gate and inspect scope

**Verify**:

- `npm run verify` → exit 0.
- `mkdocs build --strict` → exit 0 (or record why it could not run).
- `git diff --check` → exit 0 with no output.
- `git status --short` → only files in the **In scope** list changed.
- `git grep -n -i "slack support is in progress\|(planned)" -- AGENTS.md README.md docs`
  → no output.
- Update this plan's row in `plans/README.md` to `DONE`.

## Test plan

- The manifest test fails when a scope or event is added to the code and not
  to the manifest, or the other way around.
- The manifest test fails when a forbidden scope appears.
- The disclosure check fails on a real-looking Slack token or Slack id in
  `docs/`, and passes on the placeholders.
- The fixture guard refuses Slack tokens.
- The docs index test proves the renamed command reference is indexed.
- The link check proves that no link points to the old path.
- Manual: a person who follows only the Slack path of the tutorial, in a test
  workspace, gets Mneme online in `observe` mode with one invited channel.

## Done criteria

- [ ] `config/slack-app-manifest.yml` exists, Slack accepts it in a test
      workspace, and the manifest test keeps it equal to the code constants.
- [ ] `.env.example` and `config/advanced.env.example` have a platform block
      and separate Discord and Slack blocks, with only keys that the code
      reads.
- [ ] The disclosure check catches Slack tokens and Slack ids.
- [ ] CI and fixture mode refuse Slack credentials.
- [ ] `docs/reference/commands.md` replaces `discord-commands.md`, and no link
      points to the old path.
- [ ] The tutorial, Railway how-to, agent runbook, configuration reference,
      security model, privacy pages, and troubleshooting cover Slack.
- [ ] The docs say that a Slack app must be internal (not distributed), and
      why.
- [ ] README and `docs/index.md` titles are `# Mneme`.
- [ ] `npm run verify` exits 0.
- [ ] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back without improvising if:

- A "Spike results" section in plan 006, 007, or 009 is missing or has an
  open question that a doc needs.
- The code and the spec disagree about a scope, an event, an env key, or a
  visibility rule (other than the missing-event case in Step 1).
- Slack rejects the manifest for a reason that needs a code change.
- A doc can only be correct if runtime behavior changes.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- The manifest test is the guard. When a plan adds a Slack scope or event, it
  must update the constant, and the test then forces the manifest change.
- The disclosure patterns are a coarse net. They catch a pasted token or id;
  they do not prove that a page has no secret.
- When a Slack Railway template exists, replace the manual section in
  `docs/how-to/railway.md` with a link to it.
- Keep the Slack and Discord parts of each page next to each other. Separate
  pages for each platform drift apart.
