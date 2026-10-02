# Set up Mneme with an AI coding agent

This is the installation runbook for an AI coding agent helping a person set up
Mneme on Discord or Slack. Follow it in order. Stay with the person until
Mneme is deployed, connected to the chat platform, and verified, or until you
can name the exact external action that blocks progress.

The canonical repository is
<https://github.com/steel-experiments/mneme>. The default install
uses the published [Railway template](https://railway.com/template/mneme)
and its released, digest-pinned container image. Use a source deployment or a
different host only when the person asks for one.

## Definition of done

Do not call the installation complete until all of these are true:

- one Mneme process is running, with no second replica using its database
  or bot token;
- its data directory is persistent (`/app/data` for a container deployment);
- the hosting platform reports the `/readyz` health check as ready;
- on Railway, the deployment being verified has reached `SUCCESS`, not merely
  `QUEUED` or `DEPLOYING`;
- Mneme appears online in the intended Discord server or Slack workspace;
- `/mneme status` and `/mneme channels` work for an admin (Discord: a member
  with a role in `MNEME_ADMIN_ROLE_IDS`; Slack: a user in
  `MNEME_ADMIN_USER_IDS`);
- on Slack, the bot is a member of exactly the channels that the person chose,
  and no Slack Connect channel shows as ingested;
- the reported channel selection matches the person's choices;
- Mneme is in `observe` mode;
- the person knows whether historical backfill is complete or still running;
- the member privacy notice has been published before the installation is
  treated as live.

## Rules for the setup agent

1. Never ask the person to paste a Discord token, a Slack token (`xoxb-` or
   `xapp-`), or a model-provider API key into chat. Have them enter secrets directly into Railway's variable form or a
   user-controlled secret prompt. Never print, list, or read secret values back.
2. Do not put secrets in a tracked file, a command argument, a commit, or a pull
   request. A local `.env` is acceptable only for a local installation; it is
   ignored by Git and must remain local.
3. Ask for human input in small, related groups. Explain where to find an ID
   before asking for it. Discord and Slack IDs are not secrets; tokens and API
   keys are.
4. Keep `MNEME_MODE=observe` for the first installation. Do not enable
   review or autonomous posting during setup.
5. Fail closed on channel selection. If the person is unsure whether a channel
   should be organization-visible, classify it as restricted or leave it out.
6. Do not add a database, Redis, object storage, a second service, a pre-deploy
   migration, or another replica. Mneme is one process with SQLite on one
   persistent volume.
7. Do not change application code to work around a setup error. Diagnose the
   deployment, permissions, or variables first.
8. Before using an unfamiliar or changed CLI command, inspect its current
   `--help`. Do not assume an old Railway CLI syntax still works.
9. If the coding environment provides an official Railway skill or MCP
   connection, load its current instructions before operating Railway. Prefer
   deterministic CLI commands for work tied to this checkout.

## 1. Get a trustworthy local copy

If the current working directory is already this repository, verify the remote
and continue. Otherwise clone it into a new directory:

```bash
git clone https://github.com/steel-experiments/mneme.git
cd mneme
```

Confirm that `origin` is the canonical repository and note the checked-out
commit. Do not silently replace an existing checkout or discard local changes.

Read these local files before operating the installation:

- `README.md`
- `docs/tutorials/getting-started.md`
- `docs/how-to/railway.md`
- `.env.example`

The checkout supplies versioned instructions and a safe directory for Railway's
ignored local link state. When using the released Railway template, do **not**
run `railway up` from this checkout: that would deploy the checkout as a new
source build instead of using the template's pinned release image.

If cloning is impossible, fetch the four files above from the canonical
repository's raw `main` URLs and continue with the template path.

## 2. Establish the install choices

First ask which chat platform this deployment serves: **Discord** or
**Slack**. One deployment serves one platform. Set `MNEME_PLATFORM` to the
answer, and follow only that platform's branch in the steps below.

Use these defaults unless the person asks for something else:

- hosting: Railway template;
- model provider: OpenAI;
- model: `gpt-5.6-terra`;
- mode: `observe`;
- daily model admission budget: `2` USD;
- channel policy: basic mode.

If the person asks for Docker, a native Node.js install, or another host, follow
`docs/tutorials/getting-started.md` and `docs/how-to/deploy.md` instead of the
Railway sections below. Preserve the same secret-handling, singleton, observe
mode, channel-scope, platform verification, and privacy-notice requirements.

Collect the following non-secret decisions and IDs. Discord exposes **Copy ID**
after the person enables Developer Mode under User Settings → Advanced. On
Slack, the workspace (team) id is in the browser address of Slack on the web, a
user id is under the profile's **More** menu (**Copy member ID**), and a
channel id is at the bottom of the channel details.

| Item | What to establish |
| --- | --- |
| Organization | `ORG_NAME` and an IANA `ORG_TIMEZONE`, such as `Europe/Zagreb` |
| Discord server | Server ID for `DISCORD_GUILD_ID` |
| Discord application | Application ID for `DISCORD_APPLICATION_ID` |
| Admin role | A role ID for `MNEME_ADMIN_ROLE_IDS` |
| Slack workspace (Slack only, instead of the three Discord rows) | Team ID for `SLACK_TEAM_ID` |
| Slack admins (Slack only) | User IDs for `MNEME_ADMIN_USER_IDS`; at least one |
| Organization-visible sources | Channel or category IDs (Slack: channel IDs only) whose contents may support answers in other organization-visible channels |
| Restricted sources | Channel or category IDs whose contents must stay inside that channel family |
| Initial history | `FULL_HISTORY=true` to import reachable history, or `false` to start with new messages |

At least one ID must be present across `ORG_VISIBLE_CHANNEL_IDS` and
`RESTRICTED_CHANNEL_IDS`. An ID must not appear in both lists. Channels omitted
from both lists are not ingested in basic mode. Leave any channel whose name
contains `mneme`, including `mneme-test`, out of both lists.

Make the `FULL_HISTORY` tradeoff explicit. A large server can take time and
model spend to process after a full import; starting from new messages is faster
but does not create organizational memory from earlier conversations.

## 3. Guide the chat app setup

### Discord

Have the person complete these browser-only steps in the
[Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and copy its Application ID.
2. Open **Bot**, create or reset the bot token, and place it directly into a
   password manager or the Railway secret field. Do not ask to see it.
3. Enable **Message Content Intent**.
4. Create an install URL with the `bot` and `applications.commands` scopes and
   add the bot to the intended server.
5. Give a dedicated Mneme role these permissions: View Channel, Read
   Message History, Send Messages, Send Messages in Threads, Embed Links, and
   Use Application Commands. Do not grant Administrator.
6. Explicitly deny that role on excluded or sensitive categories.
7. Create or choose a separate human admin role whose ID will be placed in
   `MNEME_ADMIN_ROLE_IDS`.
8. Create a text channel named `mneme-test` for the final direct-reply
   check. Keep it out of both channel-selection lists.

### Slack

Have the person complete these browser-only steps at
[api.slack.com/apps](https://api.slack.com/apps):

1. **Create New App** → **From a manifest** → the intended workspace. Paste
   `config/slack-app-manifest.yml` from this checkout. Remove the
   `redirect_urls` block unless MCP OAuth is part of this installation.
2. Do not turn on public distribution. Mneme must stay an internal app: a
   distributed app gets much lower history rate limits and falls under other
   Slack API Terms.
3. **Basic Information** → **App-Level Tokens**: generate a token with
   `connections:write`, and place the `xapp-` token directly into a password
   manager or the Railway secret field.
4. **Install App** → install to the workspace. Place the **Bot User OAuth
   Token** (`xoxb-`) the same way. Do not ask to see either token.
5. In each selected channel, the person types `/invite @Mneme`. The invite is
   the consent; Mneme never joins a channel itself. Do not select a channel
   that is shared with another organization (Slack Connect): Mneme always
   excludes it.
6. Create a private review channel if one is planned, and a channel named
   `mneme-test` for the final direct-reply check. Invite the bot to both. Keep
   them out of both channel-selection lists.

Pause only for browser authentication, MFA, consent, or secret entry that the
person must perform. Resume the setup as soon as that action is complete.

## 4. Deploy the Railway template

Open <https://railway.com/template/mneme>. The template should
create one service from the released image and one volume mounted at
`/app/data`.

Have the person enter the secrets directly in Railway:

- Discord: `DISCORD_TOKEN`
- Slack: `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
- `OPENAI_API_KEY` for the default provider

Then fill in the non-secret values established earlier:

```text
MNEME_PLATFORM=discord
DISCORD_APPLICATION_ID
DISCORD_GUILD_ID
ORG_NAME
ORG_TIMEZONE
MNEME_ADMIN_ROLE_IDS
ORG_VISIBLE_CHANNEL_IDS
RESTRICTED_CHANNEL_IDS
FULL_HISTORY
LLM_DAILY_BUDGET_USD=2
```

For Slack, use `MNEME_PLATFORM=slack`, replace the three Discord rows and
`MNEME_ADMIN_ROLE_IDS` with `SLACK_TEAM_ID` and `MNEME_ADMIN_USER_IDS`, and
remove the Discord variables that the template created. See
[Deploy for Slack](docs/how-to/railway.md#deploy-for-slack).

Leave an empty restricted list unset if Railway rejects an empty value. Do not
set `MNEME_MODE`; its default is `observe`. Do not add a pre-deploy command.

Before deploying, inspect the template summary with the person and confirm:

- there is one application service;
- there is one volume mounted at `/app/data`;
- the service is configured for one replica;
- the health check path is `/readyz`;
- the required values are present and the secret fields are masked.

If the person chooses Anthropic or Google instead, set `LLM_PROVIDER` and the
matching provider key described in `.env.example`; do not also require an
OpenAI key.

## 5. Install and connect the Railway CLI

Use the CLI for inspection and verification after the template has created the
project. First check whether it is installed:

```bash
command -v railway
railway --version
```

If it is missing, use Railway's current official installer for the person's
platform. On macOS, Linux, or WSL the agent-aware installer is:

```bash
curl -fsSL https://agents.railway.com | sh
```

An npm fallback is:

```bash
npm install -g @railway/cli
```

After installation, verify `railway --version`. Run `railway login` and let the
person complete the browser flow. On a genuinely headless machine, immediately
show the person the device-code URL and code while the command remains running;
the code expires, so never wait silently for the command to finish.

From the Mneme checkout, inspect any existing Railway link before changing
it:

```bash
railway status --json
```

If the checkout is unlinked, run `railway link` and select the
template-created project, production environment, and Mneme service. If it
is already linked to a different project, preserve that state: use a fresh
checkout for this installation or pass explicit project, environment, and
service IDs. Do not silently relink somebody's working directory. Run
`railway status --json` again after linking and verify the selected names and
IDs with the person.

Do not run or display `railway variable list`; its output formats can include raw
values. The application's readiness and Discord checks provide safer validation
of the configuration.

## 6. Verify Railway and the chat platform

Use Railway's structured status commands and follow the exact deployment that
the template created:

```bash
railway volume list --json
railway deployment list --limit 5 --json
railway logs <deployment-id> --lines 100 --json
```

Confirm that the volume is attached to the Mneme service at `/app/data` and
the exact deployment ID created by the template reaches `SUCCESS`. If it is
still building or deploying, keep polling that deployment. If it fails or
crashes, inspect that deployment's build and runtime logs, correct the named
configuration issue, redeploy, and then follow the replacement deployment ID
until it reaches `SUCCESS`.

The service does not need a public domain for Discord, for Slack Socket Mode,
or for Railway's health check. If it already has a public domain, an additional readiness check is:

```bash
curl --fail https://<railway-domain>/readyz
```

Have an admin run, in a channel (not in a Slack thread):

```text
/mneme status
/mneme channels
```

Verify that the platform connection and model are healthy, the mode is
`observe`, and only the intended channels are ingesting. On Slack, check that no
channel shared with another organization is ingesting. Missing permissions must be fixed before
continuing. If `FULL_HISTORY=true`, `/mneme status` may show a backfill in
progress; record that clearly rather than presenting partial coverage as final.

In `#mneme-test`, mention the bot with `@Mneme hi`. After some content
has been ingested, ask the next questions from a selected organization-visible
channel. If the installation has only restricted sources, ask from one of those
restricted channels and expect answers to stay within that channel family.

```text
@Mneme bring me up to speed on the last two days
@Mneme what do you remember?
```

“No matching permitted activity” is valid when there is no ingested matching
content. A missing reply, permission error, or unhealthy status is not a
successful setup.

## 7. Finish the handoff

Guide the person through
[the member privacy notice](docs/how-to/publish-privacy-notice.md) before the
installation is treated as live. Confirm that Railway volume backups are
enabled when the person's plan supports them, and explain that `/mneme
backup` writes a backup to the same volume rather than creating an off-host
copy.

Give a concise handoff containing:

- Railway project, environment, service, and successful deployment ID;
- the selected organization-visible and restricted channel IDs;
- whether full-history backfill is complete or still running;
- current mode (`observe`) and daily admission budget;
- volume mount and backup status;
- any unresolved blocker, without calling the installation complete until it is
  cleared.

Never include secret values in the handoff.

## Common failures

| Symptom | What to check |
| --- | --- |
| `FULL_HISTORY must be set explicitly` | Set exactly `true` or `false`, then redeploy. |
| `CHANNEL_POLICY_SOURCE=basic needs at least one id` | Add at least one channel or category to one selection list. |
| `An invalid token was provided` | Have the person reset and replace `DISCORD_TOKEN` directly in Railway. |
| Bot is offline | Check the deployment state, runtime logs, token, and Message Content Intent. |
| Slash commands deny access | Discord: confirm the caller has a role listed in `MNEME_ADMIN_ROLE_IDS`. Slack: confirm the caller's user ID is in `MNEME_ADMIN_USER_IDS`. |
| A channel is absent | Check its selection list. Discord: the bot's View Channel and Read Message History permissions. Slack: that the bot was invited to the channel. |
| Slack: `invalid_auth` or `missing_scope` at startup | Have the person check both tokens in Railway, and that the app was created from the manifest and reinstalled after any scope change. |
| Slack: a channel shows as excluded | It is or was shared with another organization (Slack Connect). This is permanent by design. |
| Answers find nothing | Check sync progress, channel scope, requested time window, and whether matching content exists. |
| Data disappears after a redeploy | Stop and verify that the volume is still mounted at `/app/data` before doing anything else. |

Use [Troubleshooting](docs/how-to/troubleshooting.md) for the complete symptom
map. Do not weaken visibility policy or grant Administrator to make a check
pass.
