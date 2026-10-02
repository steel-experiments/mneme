# Deploy on Railway

This page describes the Railway install path for Mneme. The template
provisions the infrastructure for one Mneme service from the released
container image. It does not set up the chat platform or the model provider.
You bring your own Discord application or Slack app, your own provider key,
and your own channel selection. The template's variables are for Discord; see
[Deploy for Slack](#deploy-for-slack) for a Slack deployment.

> **Template status: published 2026-09-16.** The template at
> <https://railway.com/template/mneme> provisions exactly the
> contract on this page: one service from the digest-pinned release image, one
> volume at `/app/data`, and the `/readyz` health check. The seed install was
> verified live on 2026-09-16, including the released image, the volume, and
> the backup drill. The anonymous template definition was checked variable by
> variable: every default is empty and the two secrets carry no value.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/mneme)

## Prerequisites

The template provisions infrastructure. It does not create your Discord
application or Slack app, install the bot, or choose your channels. Complete these parts of
the [quickstart](../tutorials/getting-started.md) first:

- **Discord application.** Create it in the Discord Developer Portal, enable
  Message Content Intent, install the bot with a least-privilege role, and
  invite it to your server. Collect `DISCORD_TOKEN`,
  `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID`. For Slack, create the app
  from `config/slack-app-manifest.yml` instead, as
  [Install Mneme](../tutorials/getting-started.md#slack) describes.
- **Admin role.** Create a dedicated Mneme admin role and copy its ID into
  `MNEME_ADMIN_ROLE_IDS`. With no admin role, every administrative command
  is denied.
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

## What the template creates

The template provisions this contract. Do not change the singleton parts
after install:

- one always-running service from the released image
  `ghcr.io/steel-experiments/mneme`
- one volume mounted at `/app/data`; the database and backup files live there
- one replica; do not scale to more than one
- a `/readyz` health check with the 300-second startup timeout and the
  restart policy `ALWAYS`
- a deployment drain of 45 seconds, pinned in `railway.json`
  (`drainingSeconds`), so the default 30-second shutdown drain
  can finish before the old deployment is stopped. You do not set it by hand
- no pre-deploy migration command; migrations run after the volume mounts, at
  container startup

Railway supplies `PORT`. Mneme uses it automatically.

## Fill in the template variables

The template asks for the basic configuration set. The service reads them as
environment variables:

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

The template is for Discord. There is no Slack template yet. For Slack, deploy
the same template, then change the service variables by hand before the first
start:

1. Set `MNEME_PLATFORM=slack`.
2. Remove `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, and
   `MNEME_ADMIN_ROLE_IDS`. Slack has no roles, and startup refuses
   `MNEME_ADMIN_ROLE_IDS` on Slack.
3. Add the Slack variables:

| Variable | Required | Starter value |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | the bot token, `xoxb-…` (secret) |
| `SLACK_APP_TOKEN` | yes | the app-level token for Socket Mode, `xapp-…` (secret) |
| `SLACK_TEAM_ID` | yes | your workspace (team) id |
| `MNEME_ADMIN_USER_IDS` | yes | comma-separated Slack user ids of the admins |
| `ORG_VISIBLE_CHANNEL_IDS` | yes | comma-separated Slack channel ids |
| `RESTRICTED_CHANNEL_IDS` | no | comma-separated Slack channel ids |

The other variables in the table above stay the same. Create the Slack app
first, as [Install Mneme](../tutorials/getting-started.md#slack) describes,
and invite the bot to each selected channel. Socket Mode needs no public
inbound URL; the Railway domain is necessary only for the health check and for
MCP clients.

## Check the first start

1. Deploy the template. The first start runs migrations, then connects to
   Discord or Slack. Wait for the `/readyz` health check to pass; the startup timeout
   is 300 seconds.
2. Run `/mneme status` and `/mneme channels` as an admin. Compare the reported channels with your selection
   lists.
3. With `FULL_HISTORY=true`, let the backfill queue drain before you judge
   memory coverage. `/mneme status` shows the progress.
4. [Verify your first answer](../tutorials/getting-started.md#8-verify-your-first-answer)
   in a safe test channel.

The volume keeps the database across redeploys. A redeploy that loses data is
a defect; stop and check the volume mount before any other action.

## Update configuration

Configuration lives in service variables, not in the image:

1. Change the variable values in the Railway service settings.
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
   `ghcr.io/steel-experiments/mneme@sha256:<digest>`.
4. Redeploy. Expect a short interruption: Mneme is a singleton, and the
   old deployment stops only after the new one is healthy.

Do not follow a floating `latest` tag for unattended upgrades. See
[Deploy Mneme](deploy.md) for the migration compatibility rules and the
reasons.
