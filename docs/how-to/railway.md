# Deploy on Railway

This page describes how to run Mneme on Railway from the released container
image. You create one project, one service, and one volume. Railway does not
set up the chat platform or the model provider. You bring your own Discord
application or Slack app, your own provider key, and your own channel
selection.

Mneme has no Railway template. Do the steps on this page in the Railway
dashboard or with the Railway CLI. The CLI commands on this page are for
Railway CLI 5.x. Some settings are available only in the dashboard; the steps
say so.

## Prerequisites

Complete these parts of the [quickstart](../tutorials/getting-started.md)
first:

- **Chat platform.**
  - Discord: create the application in the Discord Developer Portal, enable
    Message Content Intent, install the bot with a least-privilege role, and
    invite it to your server. Collect `DISCORD_TOKEN`,
    `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID`. Create a dedicated Mneme
    admin role and copy its ID into `MNEME_ADMIN_ROLE_IDS`. With no admin
    role, every administrative command is denied.
  - Slack: create the app from `config/slack-app-manifest.yml`, as
    [Install Mneme](../tutorials/getting-started.md#slack) describes. Collect
    the bot token, the app-level token, your workspace id, and the user ids
    of the admins.
- **Channel selection.** List the channel or category IDs for
  `ORG_VISIBLE_CHANNEL_IDS` and `RESTRICTED_CHANNEL_IDS`. Channels not in
  either list are not ingested.
- **Provider key.** Set `OPENAI_API_KEY` for the default
  `openai/gpt-5.6-terra` model, or set `LLM_PROVIDER` and the matching
  `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY`.
- **Two decisions.** `FULL_HISTORY` must be set explicitly: `true` imports all
  reachable history for the selected channels, `false` starts with new
  messages. `LLM_DAILY_BUDGET_USD` starts at `2`; this is an admission
  control, not a provider billing ceiling.
- **Image digest.** Open the
  [release notes](https://github.com/steel-experiments/mneme/releases) of the
  release that you install. Copy the image reference with its digest, for
  example `ghcr.io/steel-experiments/mneme@sha256:<digest>`. Use the digest,
  not a tag.

## The deployment contract

Mneme is a singleton with a persistent database. Set up this contract and do
not change the singleton parts later:

- one always-running service from the digest-pinned release image
- one volume mounted at `/app/data`; the database and backup files live there
- one replica; do not scale to more than one
- a `/readyz` health check with a startup timeout of 300 seconds
- the restart policy `ALWAYS`
- an overlap of zero and a drain of 45 seconds, so the old deployment stops
  before the new one opens the database, and the 30-second shutdown drain of
  Mneme can finish
- no pre-deploy migration command; migrations run after the volume mounts, at
  container startup

Railway supplies `PORT`. Mneme uses it automatically.

## Create the project and the service

1. Sign in and create a project:

   ```bash
   railway login
   railway init --name mneme
   ```

2. Add one service from the digest-pinned image. Replace `<digest>` with the
   digest from the release notes:

   ```bash
   railway add --service mneme \
     --image ghcr.io/steel-experiments/mneme@sha256:<digest>
   railway service link mneme
   ```

   Railway can start a first deployment at once. It stops with a
   configuration error until you set the variables below. This is expected;
   Mneme does not connect or write data without a valid configuration.

3. Attach the volume to the service:

   ```bash
   railway volume add --mount-path /app/data
   ```

4. In the dashboard, open the service **Settings** and set these values. The
   Railway CLI does not set them:
   - **Healthcheck Path**: `/readyz`
   - **Healthcheck Timeout**: `300`
   - **Restart Policy**: `Always`
   - **Teardown**: overlap `0` seconds, draining `45` seconds
   - **Replicas**: `1`

5. If you connect MCP clients or open the inspector, create a public domain:

   ```bash
   railway domain
   ```

   Socket Mode on Slack and the Discord Gateway need no public inbound URL.

## Set the variables

Set the variables before the first start. Use `--skip-deploys` so that each
command does not start a deployment. Read secrets from standard input, so
that they do not stay in your shell history:

```bash
railway variable set MNEME_PLATFORM=discord FULL_HISTORY=true --skip-deploys
printf '%s' "$DISCORD_TOKEN" | railway variable set DISCORD_TOKEN --stdin --skip-deploys
printf '%s' "$OPENAI_API_KEY" | railway variable set OPENAI_API_KEY --stdin --skip-deploys
```

For Discord, set these variables:

| Variable | Required | Starter value |
| --- | --- | --- |
| `MNEME_PLATFORM` | yes | `discord` |
| `DISCORD_TOKEN` | yes | your bot token (secret) |
| `DISCORD_APPLICATION_ID` | yes | your application ID |
| `DISCORD_GUILD_ID` | yes | your server ID |
| `OPENAI_API_KEY` | yes, for the default provider | your key (secret) |
| `ORG_NAME` | recommended; defaults to `Your Company` | your organization name |
| `ORG_TIMEZONE` | recommended; defaults to `UTC` | your IANA time zone, for example `Europe/Berlin` |
| `MNEME_ADMIN_ROLE_IDS` | yes | your admin role ID |
| `ORG_VISIBLE_CHANNEL_IDS` | yes | comma-separated channel or category IDs |
| `RESTRICTED_CHANNEL_IDS` | no | comma-separated channel or category IDs |
| `FULL_HISTORY` | yes | `true` or `false`; there is no default |
| `LLM_DAILY_BUDGET_USD` | no | `2` |

Defaults you do not need to set: `MNEME_MODE=observe`,
`CHANNEL_POLICY_SOURCE=basic`, `LLM_PROVIDER=openai`,
`LLM_MODEL=gpt-5.6-terra`. A review channel is optional; when you add one,
set `MNEME_REVIEW_CHANNEL_ID` and `MNEME_REVIEW_CHANNEL_SECURE=true`
together after you verified its audience. Every setting is listed in
[Configuration](../reference/configuration.md).

## Deploy for Slack

For Slack, set `MNEME_PLATFORM=slack` and use these variables instead of the
Discord variables. Do not set `MNEME_ADMIN_ROLE_IDS`: Slack has no roles, and
startup refuses it on Slack.

| Variable | Required | Starter value |
| --- | --- | --- |
| `MNEME_PLATFORM` | yes | `slack` |
| `SLACK_BOT_TOKEN` | yes | the bot token, `xoxb-…` (secret) |
| `SLACK_APP_TOKEN` | yes | the app-level token for Socket Mode, `xapp-…` (secret) |
| `SLACK_TEAM_ID` | yes | your workspace (team) id |
| `MNEME_ADMIN_USER_IDS` | yes | comma-separated Slack user ids of the admins |
| `ORG_VISIBLE_CHANNEL_IDS` | yes | comma-separated Slack channel ids |
| `RESTRICTED_CHANNEL_IDS` | no | comma-separated Slack channel ids |

The provider, organization, `FULL_HISTORY`, and budget variables are the same
as for Discord. Invite the bot to each selected channel. The invitation is the
consent: Mneme does not join channels itself.

## Check the first start

1. Start the first deployment:

   ```bash
   railway service redeploy
   ```

   If the service has no deployment yet, use **Deploy** in the dashboard. The
   first start runs migrations, then connects to Discord or Slack. Wait for
   the `/readyz` health check to pass; the startup timeout is 300 seconds.
2. Run `/mneme status` and `/mneme channels` as an admin. Compare the reported
   channels with your selection lists.
3. With `FULL_HISTORY=true`, let the backfill queue drain before you judge
   memory coverage. `/mneme status` shows the progress.
4. [Verify your first answer](../tutorials/getting-started.md#8-verify-your-first-answer)
   in a safe test channel.

The volume keeps the database across redeploys. A redeploy that loses data is
a defect; stop and check the volume mount before any other action.

## Update configuration

Configuration lives in service variables, not in the image:

1. Change the variable values with `railway variable set` or in the service
   settings.
2. Redeploy the service.

Restart is required. In basic mode, Mneme reads the channel selection
lists at startup and does not reload them while running. Live reload with
`/mneme reload-policy` applies to file mode only.

## Back up and restore

Run `/mneme backup` as an admin. The backup files are written to
`/app/data/backups` on the volume. Copy them off Railway; a backup that stays
on the same volume is not an off-host copy. For the concrete export,
checksum, and restore commands for a Railway volume, see
[Back up and restore](backup-and-restore.md).

## Upgrade

1. Read the release notes. They carry the image digest of the release.
2. Confirm a completed backup when the release adds a migration. A queued
   backup is not enough.
3. Set the service image to the pinned digest
   `ghcr.io/steel-experiments/mneme@sha256:<digest>` in the service
   **Settings** (**Source** → image).
4. Redeploy. Expect a short interruption: Mneme is a singleton, and the
   old deployment stops before the new one starts.

Do not follow a floating `latest` tag for unattended upgrades. See
[Deploy Mneme](deploy.md) for the migration compatibility rules and the
reasons.
