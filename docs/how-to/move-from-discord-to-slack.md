# Move from Discord to Slack and keep the Discord archive

Use this procedure when your team moves from Discord to Slack and the Slack
deployment must still find what the team decided on Discord. The Discord
database becomes a frozen, read-only archive. The Slack deployment reads it
with archive tools, and Mneme answers can link to the old Discord messages.

The same procedure works from Slack to Discord. Change the platform names.

## What the archive gives you

- Org content only. Restricted, review-only, and excluded Discord content is
  never served, also not to admins. See
  [Security model](../explanation/security-model.md#read-only-platform-archive).
- Mneme answers to `@Mneme` questions can cite archive messages, with links to
  `discord.com`. Interventions, scheduled notices, and new memories do not cite
  the archive.
- MCP clients with an `org` token get four archive tools. See
  [HTTP and MCP](../reference/http-and-mcp.md).
- The archive never changes. Edits and deletions on Discord after the final
  backup do not reach it.

## Before you start

- The Discord deployment runs Mneme v3.1.0 or later, and it started at least
  once on that release. On that start, discovery records which threads are
  private. Threads that discovery did not see again stay hidden in the archive,
  because Mneme cannot prove that they are public.
- The release that you deploy for Slack includes the read-only archive (see
  the [changelog](https://github.com/steel-experiments/mneme/blob/main/CHANGELOG.md)).
- You have the Slack app and its settings ready. See
  [Install Mneme](../tutorials/getting-started.md) and
  [Configuration](../reference/configuration.md).

## Choose where the Slack deployment runs

**The same service and volume (recommended on Railway).** You switch the
existing service from Discord to Slack and give it a new database file. The
archive is made on the same volume, so you do not copy a large file between
services.

**A new service.** You must copy the archive file to the new volume. Railway
has no command that copies a file into a volume, and `railway ssh` is an
interactive terminal that is not reliable for large binary files. Use a
transfer method that you trust, for example a temporary storage bucket, and
compare the `sha256` of the file on both sides before you use it.

The steps below use the same service. For a new service, do steps 1–5 on the
Discord deployment, copy the file, then do steps 6–8 on the new service.

## 1. Stop new work on Discord

Set the Discord deployment to observe mode, so that it does not try to post:

```text
/mneme mode value:observe
```

## 2. Decide which channels the archive keeps

The archive serves only channels that are `org` at the time of the final
backup. If a restricted channel holds history that the whole team should find
later, classify it as `org` now:

- policy file mode: change the channel in `config/channel-policy.yml`, then run
  `/mneme reload-policy`;
- basic mode: add the channel to `ORG_VISIBLE_CHANNEL_IDS` and restart.

Check the result with `/mneme channels`.

## 3. Make the final backup

```text
/mneme backup
```

Wait for the direct message that names the file and says
`integrity_check: ok`. Note the file name, for example
`mneme-20261007-120000.sqlite` in `/app/data/backups`.

## 4. Make the archive file

Open a shell in the running container:

```bash
railway ssh --service <service>
```

In the shell, make a minimized copy of the backup:

```bash
mkdir -p /app/data/archive
MNEME_ARCHIVE_PATH=/app/data/backups/mneme-20261007-120000.sqlite \
  node dist/cli/commands.js archive-rewrite --out /app/data/archive/discord.sqlite
```

The command never changes the backup. In the copy, it keeps only what the
archive serves: org messages, org memories, and the channel rows that they
need. It empties all other tables, for example model traces, outbox text, and
review text, and clears raw payloads. It prints the counts and the `sha256` of
the new file. Do not put the archive in the backups folder; backup retention
could delete it, and Mneme refuses that path.

## 5. Keep a copy of the old data

Copy the final backup to storage outside the deployment, and keep it safe. It
is the only full copy of the Discord history, including non-org content.

## 6. Switch the service to Slack

Set the Slack variables, a new database file, and a new backups folder. The
new backups folder keeps backup retention away from the old Discord backups.

```bash
railway variable set --service <service> --skip-deploys \
  MNEME_PLATFORM=slack \
  DATABASE_PATH=/app/data/mneme-slack.sqlite \
  BACKUP_DIR=/app/data/backups-slack \
  MNEME_ARCHIVE_PATH=/app/data/archive/discord.sqlite \
  MNEME_ARCHIVE_PLATFORM=discord
```

Also set the Slack settings from [Configuration](../reference/configuration.md)
(`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_TEAM_ID`, `MNEME_ADMIN_USER_IDS`,
the review channel, the channel policy, and `FULL_HISTORY`). Remove the Discord
settings, including `MNEME_ADMIN_ROLE_IDS`, which Slack does not accept. Start
in `MNEME_MODE=observe`. Then deploy.

MCP tokens and OAuth grants live in the old database. MCP clients must sign in
again or get new tokens.

## 7. Check the archive

`/mneme status` shows one line for the archive:

```text
Archive: discord · 120.4MB · schema 47 · 29957 org messages · 412 org memories · sha256 3f9a1c0b2d4e
```

The `bootstrap.archive_verified` log event also reports `hiddenLegacyThreads`,
the number of threads that the archive hides because discovery did not see
them again. Then ask a question about an old decision with `@Mneme` in Slack.
The answer can link to the Discord message.

If the archive is wrong, damaged, or too new, startup stops with an error that
starts with `platform archive:`.

## 8. Shut down Discord

Remove the bot from the Discord server when the team no longer needs it. The
old live database and old backups stay on the volume. They hold content that
the archive never serves. When you trust the new setup and have the copy from
step 5, delete them from the volume.

## Delete archive content later

If a person asks for removal, an admin finds the old id and files a request in
the Slack secure review channel:

```text
/mneme archive user name:<part of the name>
/mneme archive forget-user id:<archive user id>
```

The request uses the normal approval and 24-hour grace period. After
execution, the archive hides the content at once. To remove the bytes from the
file too, run `archive-rewrite` again on the current archive, point
`MNEME_ARCHIVE_PATH` at the new file, and restart. A live `forget-user` does
not touch the archive; file both requests when a person asks for both.

## Known limits

- A model can restate archive content in a memory or notice without a
  citation. This cannot widen scope, because the archive holds only org
  content.
- Hiding a user does not remove the user's name or mentions from other
  people's messages.
- Channels whose names contain `mneme` or `cassandra` are test channels and are
  never served.
- Threads that discovery last saw before Mneme v3.1.0 stay hidden.
