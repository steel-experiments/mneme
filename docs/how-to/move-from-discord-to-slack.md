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
- The Discord deployment already runs a release that includes the read-only
  archive (see the
  [changelog](https://github.com/steel-experiments/mneme/blob/main/CHANGELOG.md)).
  Step 4 runs `archive-rewrite` inside the Discord deployment, so deploy that
  release there first, while it is still on Discord. The Slack deployment uses
  the same release.
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

To keep all stored history findable without changing the Discord policy, use
`archive-rewrite --all-org` in step 4 instead. It marks every stored channel
`org` in the archive copy only. This is an operator decision: everyone who can
ask Mneme in Slack can then read content that was restricted, review-only, or
excluded on Discord, for example hiring or deal channels. Test channels, shared
channels, unproven threads, and deleted rows stay hidden.

## 3. Make the final backup

```text
/mneme backup
```

Wait for the direct message that names the file and says
`integrity_check: ok`. Note the file name, for example
`mneme-20261007-120000.sqlite` in `/app/data/backups`.

If Discord no longer accepts commands (a read-only server), make the backup
from a shell in the container instead:

```bash
node dist/cli/commands.js backup
```

You can also make the archive source straight from the Discord database. The
archive refuses a file in WAL mode, so copy it with `VACUUM INTO`, which writes
a new file in `DELETE` mode:

```bash
gosu node mkdir -p /app/data/archive
gosu node node -e "const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/app/data/mneme.sqlite', { readOnly: true });
  db.exec(\"VACUUM INTO '/app/data/archive/discord-source.sqlite'\");"
```

Use the `DATABASE_PATH` of your Discord deployment.

## 4. Make the archive file

Open a shell in the running container:

```bash
railway ssh --service <service>
```

In the shell, make a minimized copy of the backup. Run the commands as the
`node` user, the user that runs Mneme:

```bash
gosu node mkdir -p /app/data/archive
MNEME_ARCHIVE_PATH=/app/data/backups/mneme-20261007-120000.sqlite \
  gosu node node dist/cli/commands.js archive-rewrite --out /app/data/archive/discord.sqlite
```

Add `--all-org` to keep all stored history findable (see step 2).

!!! warning "Give the files to the `node` user"
    A `railway ssh` shell runs as `root`, and `archive-rewrite` writes its
    output with mode `0600`. The container entrypoint changes the owner of the
    data folder only when the folder itself is not writable, so a file that
    `root` made stays unreadable to Mneme. Startup then fails with
    `platform archive: cannot open … unable to open database file`. If you ran
    a command as `root`, fix the owner before you set `MNEME_ARCHIVE_PATH`:

    ```bash
    chown -R node:node /app/data/archive
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
the review channel, the channel policy, and `FULL_HISTORY`). Then deploy.

These settings stop a Slack start when you switch the same service:

| Setting | What to do |
|---|---|
| `MNEME_ADMIN_ROLE_IDS` | Delete it. Slack has no roles and refuses it. |
| `MNEME_DELETION_APPROVER_USER_IDS` | Set Slack user ids. Discord ids are refused. |
| `channel-policy.yml` with a Discord `review_channel` | Startup fails, because the file and `MNEME_REVIEW_CHANNEL_ID` must name the same channel. Use `CHANNEL_POLICY_SOURCE=basic` with `ORG_VISIBLE_CHANNEL_IDS` and `MNEME_REVIEW_CHANNEL_ID`, or write a Slack policy file. |
| `HISTORICAL_MEMORY_*` | Turn the Discord campaign off (`HISTORICAL_MEMORY_ENABLED=false`). Its channel ids are Discord ids. |
| `DISCORD_*` | Slack ignores them. You can keep them for a rollback. |

With Railway CLI 5.25, `railway variable delete` did not start a deployment,
so you can delete settings before the deploy. Check this with your CLI version.

Before you deploy, check the planned settings with the release's configuration
loader, on a machine with the release build:

```bash
railway variables --service <service> --json > /tmp/planned.json   # then edit it
node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const { loadConfig } = await import('./dist/config.js');
  const env = JSON.parse(readFileSync('/tmp/planned.json', 'utf8'));
  loadConfig({ env }); console.log('configuration ok');"
```

Delete `/tmp/planned.json` afterwards; it holds secrets.

!!! warning "A failed start takes the service down"
    A Railway volume attaches to one deployment at a time, so Railway stops
    the old deployment before the new one starts. If the new one cannot start,
    nothing serves. Remove the setting that fails, for example
    `MNEME_ARCHIVE_PATH`, and redeploy. With the guarded deploy script, use
    `--recover-deployment <failed deployment id>`.

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
- Deletion requests need an approver who is not the requester. With one Slack
  admin, nobody can approve an archive deletion; add a second admin to
  `MNEME_ADMIN_USER_IDS` and `MNEME_DELETION_APPROVER_USER_IDS` first.
