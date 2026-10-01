# Troubleshooting

Work from the symptom to the cause. Most failures show in
`/mneme status`, `/mneme channels`, or the structured logs, before
anyone needs shell access to the database.

## Quick checks first

Run these before anything else:

```text
/mneme status
/mneme channels
```

```bash
curl --fail http://mneme.example.internal/livez
curl --fail http://mneme.example.internal/readyz
```

`/mneme status` shows the gateway state, the model health, the latest
backup age, and the backfill progress. `/mneme channels` shows the live
channel policy next to the real Discord permissions. A readiness failure with
a healthy liveness means the process runs but a dependency is not ready.

## Bot is online but answers nothing

Check each cause in order:

- **Direct answers are disabled.** `DIRECT_ANSWER_ENABLED=false` removes
  replies to mentions. It defaults to `true`; the rollout guide sets it to
  `false` for a silent first phase.
- **The mention form is wrong.** Mneme answers explicit mentions in the
  server. It does not answer DMs; an inbound DM gets one fixed notice per
  sender per 24 hours.
- **The model gate is holding work.** The status line shows the model as
  `degraded` when the provider fails repeatedly or the daily budget is spent.
  See the next two sections.
- **The channel is a test console.** Any channel whose name contains
  `mneme` is treated as a console. Ordinary messages there are not
  ingested. Questions still get answers, but only from already-ingested
  evidence in other channels.

When a direct answer cannot complete, Mneme sends a short fixed fallback
message. That fallback is a signal to check the model health, not a bug in
Discord delivery.

## Permitted history is empty

- `FULL_HISTORY=false` starts memory from new messages onward. Nothing older
  is imported on first start.
- `FULL_HISTORY=true` runs a historical backfill. `/mneme status` shows
  the queue. Wait for it to drain before you judge coverage.
- At least one id must be present across the two selection lists. Both empty
  is a startup error, quoted below.
  Check `ORG_VISIBLE_CHANNEL_IDS` and `RESTRICTED_CHANNEL_IDS` against
  `/mneme channels`.
- Live ingestion problems show in the `discord.ingestion_outcome` log events;
  see [Investigate ingestion safely](#investigate-ingestion-safely).

## Missing role or gateway intent

- **Message Content Intent is off.** The bot connects, sees events, and stores
  no text. Enable the intent in the Discord Developer Portal, then restart
  Mneme.
- **No admin role is configured.** With an empty `MNEME_ADMIN_ROLE_IDS`,
  every administrative command is denied. Set at least one role ID.
- **The asking member lacks the admin role.** Administrative commands check
  the role of the member who sends them.
- **The bot role lacks Read Message History.** Mneme can only ingest
  channels where it holds both View Channel and Read Message History.
  `/mneme channels` reports the missing permissions per channel.

## Invalid model or provider key

- Startup fails with a named variable when a required value is missing or
  malformed: the Discord token, application ID, guild ID, provider, model,
  and the key for the selected provider. The error names the value to fix.
- Provider responses 401 and 403 mark an authentication problem: wrong key,
  wrong provider, or no access to the named model. Check that
  `LLM_PROVIDER` matches the key you set (`OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`).
- An unknown model name reaches the provider and fails there. Confirm
  `LLM_MODEL`; the default is `gpt-5.6-terra` with `LLM_PROVIDER=openai`.

Three consecutive provider failures of any kind trip a short outage window.
During it, all model work waits and readiness reports degraded. A single
success, or the end of the window, restores the healthy state.

## Daily budget is spent

`LLM_DAILY_BUDGET_USD` is a daily admission control, not a provider billing
ceiling. When spend reaches it:

- new model work is blocked and readiness reports the model as degraded
- queued reviews and other durable jobs are re-enqueued, not discarded
- direct answers get the short fallback message
- work that was already admitted may still finish and slightly exceed the
  threshold

The stop clears by itself at the start of the next organization day, computed
from `ORG_TIMEZONE`. To spend more, raise `LLM_DAILY_BUDGET_USD`, or set it
to the keyword `unlimited` to remove the cap, then restart. An unset or blank
value means 2 USD per day. The budget is admission control, not a billing
ceiling; provider and hosting charges are separate. Ingestion never depends on
the model, so messages keep flowing during the stop.

## Sync is still pending

Answers over a time window are incomplete until the channels in that window
have synced. Check `/mneme status` for backfill and reconciliation
progress. A catch-up that names a window wider than the synced history
returns a partial report and says so.

## Missing or wrong policy file

- `CHANNEL_POLICY_SOURCE=file` reads `CHANNEL_POLICY_PATH`. When the file is
  absent or the YAML is invalid, startup fails with the path in the error.
  Mount the file into the container at that path.
- `CHANNEL_POLICY_SOURCE=basic` (the default) ignores the file. When your
  edits to `config/channel-policy.yml` show no effect, check which source is
  active.
- Basic mode needs at least one id in `ORG_VISIBLE_CHANNEL_IDS` or
  `RESTRICTED_CHANNEL_IDS`. With both lists empty, startup fails with
  `channel policy: CHANNEL_POLICY_SOURCE=basic needs at least one id in ORG_VISIBLE_CHANNEL_IDS or RESTRICTED_CHANNEL_IDS; an existing channel-policy.yml needs CHANNEL_POLICY_SOURCE=file`.
  When you meant to use the YAML file, set `CHANNEL_POLICY_SOURCE=file`.
- Compare the live result with `/mneme channels`. Channels that should
  ingest must be reachable by policy and by Discord permissions.
- In file mode, `/mneme reload-policy` applies policy and prompt changes
  without a restart. In basic mode, the selection lists are read at startup,
  so a change needs a restart.

## Volume and permission problems

- The container image starts as root to repair ownership on the mounted
  volume, then runs the application as the `node` user. Errors such as
  `EACCES` or `SQLITE_CANTOPEN` under `/app/data` mean the volume is mounted
  read-only, or the platform skipped the entry point that performs the
  repair.
- `SQLITE_BUSY` or locked-database errors mean more than one process holds
  the database open. Run exactly one replica, and never mount one database
  volume into two active containers.
- After any volume incident, run `npm run integrity-check`, or
  `node dist/cli/commands.js integrity-check` inside the container, before
  you trust the database.

## Investigate ingestion safely

Gateway receipt means Mneme received an event. Persistence and recovery
are separate: a receipt can be healthy while a policy skip, malformed
payload, or missing dependency prevents storage. Use the content-free
`discord.ingestion_outcome` log event and its `eventType`, `outcome`, and
`reason` fields. Failures and recovery transitions are logged at warning
level; successful hot-path records are debug level.

The Prometheus adapter exposes the same finite dimensions through
`ingestion_events_total{event_type,outcome,reason}` and
`ingestion_recovery_total{outcome,reason}` when an operator mounts the already
bearer-protected metrics adapter. IDs are deliberately not metric labels.

For an authorized read-only SQLite inspection, count recovery work without
selecting message content:

```sql
SELECT status, reason, COUNT(*) AS requests
FROM ingestion_recovery_requests
GROUP BY status, reason
ORDER BY status, reason;
```

`PRAGMA foreign_key_check` detects referential violations. It cannot show a
Discord event that was never stored. Interpret retained failed jobs by their
timestamps and current status; historical rows do not prove an active
incident.

The JSON `level` field is a string (`debug`, `info`, `warn`, or `error`). This
makes level filtering portable across log platforms, but an operator must
verify a platform's filter behavior from naturally occurring records after
deployment.
