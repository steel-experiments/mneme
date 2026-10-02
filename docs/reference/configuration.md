# Configuration reference

Mneme reads operational settings from environment variables and product
behavior from two YAML files:

- `config/mneme.yml` contains organization, agent voice, intervention, and
  memory defaults.
- `config/channel-policy.yml` classifies Discord channels and categories. A
  synthetic sample ships at this path. Edit it, or mount your reviewed policy
  over it.

A first run needs neither file. Set the short environment list below and
`CHANNEL_POLICY_SOURCE=basic`, and Mneme builds the channel policy from
the environment. Set `CHANNEL_POLICY_SOURCE=file` to use the YAML files
instead. Both paths feed the same validated policy engine.

Environment values override YAML values where both are supported. Security
constraints in code override both. Secrets are accepted only through the
environment.

## First-run environment

`.env.example` is the short template for a basic install. The values it asks
for:

| Variable | Meaning |
| --- | --- |
| `MNEME_PLATFORM` | Chat platform for this deployment. Required, no default. The only supported value is `discord`. |
| `DISCORD_TOKEN` | Bot token. Secret. |
| `DISCORD_APPLICATION_ID` | Discord application snowflake. |
| `DISCORD_GUILD_ID` | The one guild Mneme may join. |
| `OPENAI_API_KEY` | API key for the selected provider. Secret. Use `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY` for the other providers. |
| `ORG_NAME` | Organization name rendered in prompts. |
| `ORG_TIMEZONE` | Valid IANA time zone used for daily limits. `UTC` when unset. |
| `MNEME_ADMIN_ROLE_IDS` | Comma-separated Discord role IDs. Empty is valid; see the warning under Mode and administration. |
| `CHANNEL_POLICY_SOURCE` | `basic` (default) or `file`. See Channel policy below. |
| `ORG_VISIBLE_CHANNEL_IDS` | Basic mode. Channels or categories selected for org visibility. |
| `RESTRICTED_CHANNEL_IDS` | Basic mode. Channels or categories selected as restricted. |
| `MNEME_REVIEW_CHANNEL_ID` | Basic mode. Secure review channel. Requires the audience assertion described below. |
| `MNEME_REVIEW_CHANNEL_SECURE` | Must be exactly `true` when a review channel id is set. |
| `FULL_HISTORY` | Initial import scope. Must be set explicitly. See Ingestion. |

Everything else has a default:

| Variable | Default | Notes |
| --- | --- | --- |
| `LLM_PROVIDER` | `openai` | `openai`, `anthropic`, or `google`. Set it only to use another provider. |
| `LLM_MODEL` | `gpt-5.6-terra` | Model ID known to the selected provider. Set it only to use another model. |
| `LLM_DAILY_BUDGET_USD` | `2` | Admission control for model work. `unlimited` removes the cap. See Episodes and model runs. |
| `DEEP_RECAP_ENABLED` | `false` | The admin-only durable recap command group stays off until enabled. |

`config/advanced.env.example` is the complete maintained reference for every
supported setting. Discord IDs must be 17 to 20 decimal digits. Mneme exits
before connecting if required configuration is missing or invalid.

## Environment file loading

A native run loads `./.env` from the process working directory before it reads
any other environment variable, including `LOG_LEVEL` for the first log line.
The operational commands `migrate`, `backup`, and `integrity-check` load it the
same way. Only keys that are not already present in the process environment are
applied, so a real environment value always wins. The parser reads `KEY=VALUE`
lines, trims them, and skips blank lines and `#` comment lines. It also accepts
an `export ` prefix, removes matching surrounding single or double quotes from a
value without escape processing, removes an inline ` # comment` from an unquoted
value, and ignores a UTF-8 byte order mark. Mneme never writes to this file.

Containers are not affected by this loader. Docker Compose passes the same
`.env` file through `env_file`, and host platforms inject variables directly.

## Core settings

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | `production`, `development`, or `test`. |
| `PORT` | `3000` | HTTP port, from 1 through 65535. |
| `DATA_DIR` | `./data` native, `/app/data` container | Mutable application data. |
| `DATABASE_PATH` | `./data/mneme.sqlite` native, `/app/data/mneme.sqlite` container | SQLite database path. |
| `BACKUP_DIR` | `$DATA_DIR/backups` | Online backup destination. |
| `LOG_LEVEL` | `info` | Pino level: `fatal` through `trace`, or `silent`. |
| `PROMPT_DIR` | `./prompts` native, `/app/prompts` container | Handlebars prompt directory. |
| `DOCS_DIR` | `./docs` native, `/app/docs` container | Public Markdown documentation. Mneme indexes only this tree for self-knowledge. |
| `DOCS_PUBLIC_URL` | unset | Optional canonical HTTPS base for host-built documentation links. |
| `MNEME_CONFIG_PATH` | `./config/mneme.yml` native, `/app/config/mneme.yml` container | Product configuration YAML. |
| `CHANNEL_POLICY_PATH` | `./config/channel-policy.yml` native, `/app/config/channel-policy.yml` container | Channel policy YAML. Read only when `CHANNEL_POLICY_SOURCE=file`. A synthetic sample ships at this path. |
| `ORG_NAME` | YAML value or `Your Company` | Organization name rendered in prompts. |
| `ORG_TIMEZONE` | YAML value or `UTC` | Valid IANA time zone used for daily limits. |
| `MNEME_SOURCE_REVISION` | unset | Optional hexadecimal source revision for deployments that do not provide trusted Git metadata. |
| `MNEME_BUILD_ID` | unset | Optional provider-neutral build identifier, shown only when no Railway deployment ID is available. |

Native defaults are relative to the process working directory. The Docker
image bakes the absolute `/app` values, so a container starts with the same
paths it always used.

Configured paths may be absolute or relative, but may not contain a `..` path
segment.

The application version comes from the built package and cannot be overridden by
the environment. At runtime Mneme also recognizes Railway's
`RAILWAY_DEPLOYMENT_ID` and `RAILWAY_GIT_COMMIT_SHA`, plus the standard
`GITHUB_SHA` and GitLab `CI_COMMIT_SHA` revision variables. Railway supplies Git
metadata only for a Git-triggered deployment, so a CLI upload normally shows its
deployment ID without claiming a source revision. Arbitrary ambient variables
such as `BUILD_ID`, `SOURCE_VERSION`, and `COMMIT_SHA` are intentionally ignored.
Only compact identifier-shaped values are accepted; these fields must never
contain secrets.

## Mode and administration

| Variable | Default | Notes |
| --- | --- | --- |
| `MNEME_MODE` | `observe` | `observe`, `review`, or `autonomous`. |
| `MNEME_REVIEW_CHANNEL_ID` | unset | Required in review and autonomous modes. Must match the review channel in the active channel policy. |
| `MNEME_ADMIN_ROLE_IDS` | empty | Comma-separated Discord role IDs. An empty list authorizes nobody. |
| `MNEME_ADMIN_USER_IDS` | none | Slack deployments only. Comma-separated Slack user IDs of the admins. Required, at least one. Slack has no roles, so a Slack deployment rejects `MNEME_ADMIN_ROLE_IDS`. On Slack, `MNEME_DELETION_APPROVER_USER_IDS` also holds Slack user IDs. |
| `MNEME_DELETION_APPROVER_USER_IDS` | empty | Comma-separated Discord **user** IDs allowed to approve another admin’s deletion request. Approvers also need an admin role. Empty disables new deletion requests and approvals; removal revokes uncompleted purges at their next batch. Restart to apply changes. |
| `HTTP_ADMIN_TOKEN` | unset | Enables bearer-protected `GET /status`. Secret. |
| `DIRECT_ANSWER_ENABLED` | `true` | Allows replies when Mneme is explicitly mentioned. |

An empty `MNEME_ADMIN_ROLE_IDS` is valid. Mneme logs a startup warning
in that case, and admin operations stay denied until the list is set. The
denial itself is fail closed; the warning is never an error.

Review and autonomous modes require a secure review channel in the active
channel policy. In file mode this is a `review_channel` entry marked
`secure: true`. In basic mode it is the `MNEME_REVIEW_CHANNEL_ID` and
`MNEME_REVIEW_CHANNEL_SECURE` pair described under Channel policy.
Startup also confirms that the bot can access that channel.

Direct answers are distinct from unsolicited interventions. A direct answer is
still subject to scope, evidence, duplicate, and rate checks, but does not require
the target channel's `allow_interventions` flag. Disable direct replies separately
with `DIRECT_ANSWER_ENABLED=false`. Catch-ups use a direct-only bounded activity
snapshot; they do not raise the public MCP `list_recent_messages` page size. Relative
windows end at the source question timestamp, so retry delay cannot change what "last two
days" means. Technical failures produce a fixed, content-free fallback only after the
current target and exact question reply anchor pass a separate outbound safety check.

## Ingestion

| Variable | Default | Notes |
| --- | --- | --- |
| `FULL_HISTORY` | none | Must be set explicitly. `true` queues historical backfill after discovery. `false` ingests new messages onward. |
| `BACKFILL_CONCURRENCY` | `2` | Concurrent backfill and reconciliation jobs. Must be positive. |
| `RECONCILE_INTERVAL_MINUTES` | `360` | Periodic message-gap reconciliation. |
| `RECONCILE_OVERLAP_HOURS` | `24` | Recent history refreshed on each completed reconciliation scan; 1–168. |
| `RECONCILE_MAX_PAGES_PER_RUN` | `10` | Page budget per reconciliation job run; 1–100. A later run resumes the same scan. |
| `THREAD_DISCOVERY_INTERVAL_MINUTES` | `360` | Periodic active and archived thread discovery. |
| `STORE_RAW_JSON` | `false` | Store raw Discord JSON where supported. |
| `RETAIN_EDIT_HISTORY` | `false` | Keep previous message versions. |
| `RETAIN_DELETED_CONTENT` | `false` | Keep normalized content after Discord deletion. |
| `ATTACHMENT_MODE` | `metadata` | `none`, `metadata`, `archive`, or `selective`. |
| `ATTACHMENT_MAX_BYTES` | `10485760` | Maximum archived file size. |
| `ATTACHMENT_MIME_ALLOWLIST` | text, Markdown, JSON, CSV, PDF | Comma-separated MIME types accepted for archival. |

`archive` and `selective` download eligible attachment bytes into `DATA_DIR`.
Downloads enforce both the declared content length and the streamed byte count.
`metadata` stores attachment metadata without file bytes.

`FULL_HISTORY` has no default. Mneme exits before connecting when it is
unset or blank, and names the explicit choice: `true` imports all reachable
history for the selected channels; `false` starts with new messages onward.
`FULL_HISTORY=false` is a starting point, not a hard historical boundary; some
sync paths may still touch older rows.

## Episodes and model runs

| Variable | Default | Notes |
| --- | --- | --- |
| `EPISODE_QUIET_SECONDS` | `90` | Close an inactive episode after this delay. |
| `EPISODE_MAX_MESSAGES` | `40` | Close an episode at this message count. |
| `EPISODE_MAX_MINUTES` | `10` | Maximum episode duration. |
| `EPISODE_SETTLE_SECONDS` | `600` | Quiet seconds the conversation needs before its review runs. A closed episode whose channel is still active is held, not reviewed. |
| `EPISODE_SETTLE_MAX_MINUTES` | `60` | Upper bound on holding one review. Past this, the review runs so memory is not blocked, but it cannot propose a message. |
| `AGENT_MAX_CONCURRENCY` | `1` | Concurrent model jobs. |
| `AGENT_TIMEOUT_SECONDS` | `120` | Wall-clock limit per run. |
| `AGENT_MAX_TOOL_CALLS` | `8` | Retrieval tool-call limit per run. When it is spent, the run enters a finalize-only phase: the model is offered the terminal tool alone and asked to finalize with the evidence already retrieved. |
| `AGENT_MAX_RETRIEVED_CHARACTERS` | `60000` | Cumulative retrieval text limit per run (about 15,000 tokens). It bounds cost, keeps searches focused, and caps how much organizational text one run can carry into a post. |
| `AGENT_THINKING_LEVEL` | `medium` | `low`, `medium`, or `high`. |
| `EPISODE_SHADOW_ENABLED` | `false` | Run a bounded, non-acting candidate comparison after a finalized live episode review. Requires the authoritative setting to remain `medium`. |
| `EPISODE_SHADOW_MODEL` | unset | Candidate model ID. Unset reuses `LLM_MODEL`, which supports reasoning-only comparisons. |
| `EPISODE_SHADOW_THINKING_LEVEL` | `low` | Candidate reasoning level: `low`, `medium`, or `high`. |
| `EPISODE_SHADOW_MAX_RUNS` | `50` | Cumulative live shadow-run cap per candidate model/reasoning pair. Historical episodes do not participate. |
| `TRIAGE_LLM_MODEL` | unset | Optional secondary model ID. |
| `LLM_BASE_URL` | unset | Optional provider base URL override. |
| `LLM_DAILY_BUDGET_USD` | `2` | Org-day admission cap for model work. `0` blocks model work. `unlimited` removes the cap; the provider and hosting bills are then the only limits. |
| `DEEP_RECAP_ENABLED` | `false` | Enables the admin-only durable recap command group. |
| `DEEP_RECAP_MAX_WINDOW_DAYS` | `30` | Largest accepted recap window; may be lowered but not raised above the hard 30-day bound. |
| `DEEP_RECAP_MAX_BUDGET_USD` | `20` | Largest per-request whole-dollar ceiling. |
| `DEEP_RECAP_DAILY_BUDGET_USD` | `20` | Separate organization-day ceiling for deep-recap chunk and synthesis runs. |
| `HISTORICAL_MEMORY_ENABLED` | `false` | Reconstruct memories from fully backfilled org history. |
| `HISTORICAL_MEMORY_CHANNEL_IDS` | unset | Optional comma-separated Discord channel allowlist for historical construction and review; empty means all eligible org channels. |
| `HISTORICAL_MEMORY_BATCH_MESSAGES` | `200` | Maximum historical messages scanned per durable batch. |
| `HISTORICAL_MEMORY_MAX_PENDING_REVIEWS` | `4` | Backpressure ceiling for queued/running historical reviews. |
| `HISTORICAL_MEMORY_DAILY_BUDGET_USD` | `1` | Dedicated org-day ceiling for historical model runs; `0` pauses them. |
| `HISTORICAL_MEMORY_CAMPAIGN_ID` | unset | Safe identifier enabling bounded campaign behavior. Persisted identity is immutable. |
| `HISTORICAL_MEMORY_DIRECTION` | `newest_first` | Campaign traversal order. Bounded campaigns currently require `newest_first`. |
| `HISTORICAL_MEMORY_FROM_AT` | unset | Required fixed ISO-8601 lower boundary for a campaign. |
| `HISTORICAL_MEMORY_TO_AT` | unset | Required fixed ISO-8601 upper boundary; it does not move on restart. |
| `HISTORICAL_MEMORY_LLM_MODEL` | unset | Required campaign-only model; live/direct work continues to use `LLM_MODEL`. |
| `HISTORICAL_MEMORY_THINKING_LEVEL` | `medium` | Campaign-only `low`, `medium`, or `high` reasoning. |
| `HISTORICAL_MEMORY_TOTAL_BUDGET_USD` | `0` | Required positive cumulative campaign ceiling, recovered from persisted runs. |

The daily model budget is hydrated from persisted `agent_runs`, so restarting
the process does not reset the current day's spend. `LLM_DAILY_BUDGET_USD` is
an admission control inside Mneme, not a billing ceiling at the provider:
the provider bills the hosting account separately, and an already-admitted call
can finish. When the provider is down or the budget is exhausted, model jobs
are deferred without consuming retry attempts. Ingestion continues.

Historical reconstruction uses a separate persisted budget and low-priority
queue. It never processes restricted/test channels and never sends an
intervention from an old episode. Its progress appears on `/mneme status`
as `historical: channels=… complete=… scanned=… episodes=… pending_reviews=…`.

A bounded campaign freezes its channel list, time window, direction, provider,
model, and reasoning level under `HISTORICAL_MEMORY_CAMPAIGN_ID`. Only its daily
and total budgets may be raised on a later deployment. The builder rotates among
eligible channels and walks newest-to-oldest inside each channel; messages inside
an episode remain chronological. Use `/mneme historical pause|resume|status`
for a campaign-specific kill switch that does not interrupt live answers.
On startup, a running campaign makes only its own queued, budget-deferred reviews
eligible again. This lets a raised budget take effect immediately after deployment
without consuming retry attempts or waking unrelated work.

Deep recaps are separate from historical memory extraction. They partition an explicit
recent window into bounded daily snapshots, process one low-priority chunk at a time,
persist progress and cost, and synthesize one report in the requested destination. They
do not create memories or autonomous interventions. The per-request and daily checks stop
new model calls; an already-admitted call can finish, so provider-reported spend may
exceed a boundary by that single in-flight call.

Budgets form one hierarchy. `LLM_DAILY_BUDGET_USD` is the global admission
budget and gates all model spend. The deep-recap ceilings
(`DEEP_RECAP_MAX_BUDGET_USD` and `DEEP_RECAP_DAILY_BUDGET_USD`, default `20`
and `20`) are subordinate caps: they apply only when
`DEEP_RECAP_ENABLED=true`, and they can never admit spend the global budget
has already blocked.

## Intervention and memory settings

| Variable | Default |
| --- | --- |
| `INTERVENTION_THRESHOLD` | `0.78` |
| `MIN_EVIDENCE_STRENGTH` | `0.65` |
| `MIN_INTERVENTION_CONFIDENCE` | `0.65` |
| `CHANNEL_COOLDOWN_MINUTES` | `180` |
| `GLOBAL_AUTONOMOUS_POST_LIMIT_PER_DAY` | `5` |
| `MNEME_MAX_MESSAGE_CHARACTERS` | `1800` |
| `INTERVENTION_ATTENTION_WINDOW_DAYS` | `7` |
| `MEMORY_MINIMUM_CONFIDENCE` | `0.55` |
| `MEMORY_MINIMUM_IMPORTANCE` | `0.60` |
| `MEMORY_FOLLOWUP_HORIZON_DAYS` | `14` |
| `MEMORY_FOLLOWUP_MAX_MESSAGES` | `20` |
| `MEMORY_SCHEDULED_REVIEW_REMINDER_DAYS` | `7` (deprecated) |
| `MEMORY_STALENESS_HORIZON_DAYS` | `45` (deprecated) |
| `MEMORY_REQUIRE_EVIDENCE` | `true` |
| `MEMORY_REVIEW_PREDICTIONS` | `true` |
| `MEMORY_REVIEW_ASSUMPTIONS` | `true` |

Scores and confidence values must be between 0 and 1. Concurrency, episode,
agent, intervention, attention-window, attachment-size, backup-interval, shutdown,
and MCP-limit settings must be positive. A zero reconciliation, thread-discovery,
or optimize interval disables that timer.

Episode review keeps its original short conversation boundaries, then supplies a
separate bounded look-ahead from the same conversation. The host scans at most 500
human messages inside the follow-up horizon, ranks direct replies, completion language,
topic overlap, and proximity, and exposes at most `MEMORY_FOLLOWUP_MAX_MESSAGES` to the
model. Historical campaigns additionally cap look-ahead at their immutable end time.
This allows an answer or completion posted hours or days later to resolve an open
question or commitment without turning the entire channel into one episode.

`INTERVENTION_ATTENTION_WINDOW_DAYS` sets the proactive attention window. Mneme
proposes unsolicited speech only when a meaningful human message about the subject was
created within this many days, or when an explicit human-stated deadline on an
unconsumed subject revision becomes due. One material human development earns at most
one speaking opportunity — a review card, a forced-review card, or an autonomous
message — no matter how the earlier attempt ended. A new human development on the same
subject creates a new opportunity. The window is separate from searchable memory: old
memories stay available, and explicit questions about older material keep their
existing behavior.

Deadlines must come from a known human's source message, with an exact quoted date
and commitment. Accepted forms are `YYYY-MM-DD`, an ISO timestamp with an explicit
offset, a full date such as `18 September 2026`, `today`, `tomorrow`, or an unqualified
weekday. Relative dates use the source message's date, not the review date. Date-only
deadlines fall at the end of the day in `ORG_TIMEZONE`; the accepted timezone
and interpretation are retained. Ambiguous forms such as `03/04/2026` or `next Friday`
do not authorize reminders. A newer human cancellation or reschedule replaces the
earlier deadline; re-extracting older evidence cannot restore it.

`MEMORY_SCHEDULED_REVIEW_REMINDER_DAYS` is deprecated. It is still parsed so existing
configuration files load, but it no longer controls notification admission; repeated
speech is bounded by attention consumption, not by a reminder interval.

`MEMORY_STALENESS_HORIZON_DAYS` is deprecated. It is still parsed so existing
configuration files load, but it no longer expires memories or blocks dispatch; closed
attention opportunities expire on their own windows, and durable memories keep their
semantic lifecycle states.

## Maintenance

| Variable | Default | Notes |
| --- | --- | --- |
| `BACKUP_ENABLED` | `true` | Enable scheduled backups. |
| `BACKUP_INTERVAL_HOURS` | `24` | Scheduled backup cadence. The schedule resumes from the last recorded backup across restarts and fires 15 minutes after the maintenance bundle. |
| `BACKUP_RETENTION_DAYS` | `7` | Local backup retention window. |
| `JOBS_RETENTION_DAYS` | `30` | Terminal job rows (`succeeded`, `failed`, `cancelled`) older than this are pruned by the daily maintenance job, in bounded batches. Queued and running rows are never pruned. |
| `PRAGMA_OPTIMIZE_INTERVAL_HOURS` | `24` | Maintenance cadence (`PRAGMA optimize`, WAL checkpoint, proposal expiry, job pruning). The schedule resumes from the last recorded run across restarts. |
| `SHUTDOWN_TIMEOUT_SECONDS` | `30` | Worker drain deadline. |

## MCP

| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_ENABLED` | `false` | Mount the stateless MCP endpoint. |
| `MCP_PATH` | `/mcp` | Must start with `/`. |
| `MCP_PUBLIC_URL` | Railway domain, else `http://localhost:PORT` | Public origin external clients reach, for example `https://mneme.example.com`. Joined with `MCP_PATH` and shown in the `/mneme mcp-token create` reply. |
| `MCP_RATE_LIMIT_PER_MINUTE` | `60` | Per-token limit. |
| `MCP_UNAUTH_RATE_LIMIT_PER_MINUTE` | `30` | Shared budget of failed authentications per minute; excess returns `429`. |
| `MCP_TOOL_LIST_TTL_MS` | `300000` | Tool-list cache hint. |
| `MCP_OAUTH_ENABLED` | `false` | Enables OAuth discovery and Discord-backed sign-in for remote connectors. |
| `MCP_OAUTH_CLIENT_ID` | unset | Required OAuth public-client identifier when OAuth is enabled. |
| `MCP_OAUTH_REDIRECT_URIS` | Claude callback | Comma-separated HTTPS redirect allowlist. Loopback HTTP is allowed for local clients. |
| `DISCORD_OAUTH_CLIENT_ID` | unset | Discord application client ID used for OAuth sign-in. |
| `DISCORD_OAUTH_CLIENT_SECRET` | unset | Discord OAuth secret. |

MCP tokens are created through Discord admin commands. They are separate from
`HTTP_ADMIN_TOKEN`.

## Inspector

| Variable | Default | Notes |
| --- | --- | --- |
| `INSPECTOR_ENABLED` | `false` | Mount the read-only admin web surface. |
| `INSPECTOR_PATH` | `/inspector` | Must start with `/` and must not end with `/`. It must not equal, or be a prefix of, a route the server matches first: `/`, `/livez`, `/readyz`, `/status`, `/metrics`, `MCP_PATH`, or an OAuth path. |
| `INSPECTOR_RATE_LIMIT_PER_MINUTE` | `120` | Per-token limit for authenticated page views. |
| `INSPECTOR_UNAUTH_RATE_LIMIT_PER_MINUTE` | `30` | Shared budget of failed authentications per minute; excess returns `429`. |

The surface origin for the `/mneme inspector-token create` reply follows
`MCP_PUBLIC_URL`, the Railway domain, or `http://localhost:PORT`, in that
order. Inspector tokens are issued through Discord admin commands and are
separate from MCP tokens and `HTTP_ADMIN_TOKEN`.

## Channel policy

`CHANNEL_POLICY_SOURCE` selects how the channel policy is built:

- `basic` (default): the policy is built from environment variables. No policy
  file is read, and `CHANNEL_POLICY_PATH` is ignored.
- `file`: the policy is loaded from `CHANNEL_POLICY_PATH`.

Both modes build the same validated policy object and enforce the same
fail-closed rules. Channel resolution follows this order in both modes:

1. explicit channel rule
2. thread parent rule
3. parent category rule
4. default rule

Newly discovered channels are evaluated against the active policy before live
messages are stored. Losing View Channel or Read Message History disables
ingestion on the next discovery pass.

Changes in either mode take effect after a restart. Mneme never swaps a
channel policy while it runs, except through the file-mode reload command
described below.

### Basic mode

Basic mode selects channels with two comma-separated snowflake lists. Each list
entry names one Discord channel or one category:

| Variable | Rule applied to each listed id |
| --- | --- |
| `ORG_VISIBLE_CHANNEL_IDS` | `ingest: true`, `visibility: org`, `allow_interventions: false` |
| `RESTRICTED_CHANNEL_IDS` | `ingest: true`, `visibility: restricted`, `allow_interventions: false` |

Selection semantics:

- Each id is entered in both the channel map and the category map of the
  policy. A snowflake names exactly one resource kind: the matching entry
  applies, and the other entry is inert.
- A category id therefore classifies the channels inside that category, unless
  a channel has a more specific rule.
- Every rule basic mode writes sets `allow_interventions: false`. A basic
  configuration cannot enable unsolicited interventions; switch to file mode
  for that.
- The default rule for ids not in either list is `ingest: false`,
  `visibility: restricted`, `allow_interventions: false`. At least one of the
  two lists must name an id; see the startup errors below.
- Basic mode never consults stored classification review decisions.
- Threads inherit their parent channel's resolved rule, as in file mode.

Startup fails with a named error when:

- both selection lists are empty. The error reads
  `channel policy: CHANNEL_POLICY_SOURCE=basic needs at least one id in ORG_VISIBLE_CHANNEL_IDS or RESTRICTED_CHANNEL_IDS; an existing channel-policy.yml needs CHANNEL_POLICY_SOURCE=file`;
- an id appears in both selection lists;
- a value is not a 17 to 20 digit snowflake after trimming;
- the review channel id appears in either selection list.

Basic mode cannot express `excluded` or `review_only` visibility. Unselected
channels are stored as `ingest: false` with `restricted` visibility. Use file
mode when you need those classes.

Classification review cards are file-mode only. Basic mode never posts one:
you select channels through the environment lists, and a channel that no list
names is simply not read.

### Review channel in basic mode

The review channel is declared with two variables, not with YAML:

```dotenv
MNEME_REVIEW_CHANNEL_ID=<review-channel-id>
MNEME_REVIEW_CHANNEL_SECURE=true
```

`MNEME_REVIEW_CHANNEL_SECURE=true` is an audience assertion by the
operator: you confirm that only the review group and Mneme can read the
channel. Verify the channel audience before you enable it. Mneme cannot
check the member list for you.

Startup fails when an id is set without `MNEME_REVIEW_CHANNEL_SECURE=true`,
or when the flag is set without an id. When both are set, the review channel
accepts the `org`, `restricted`, and `review_only` scopes. This is the same
scope set the shipped sample policy declares, and basic mode offers no way to
change it.

### File mode

Set `CHANNEL_POLICY_SOURCE=file` to load the policy from
`CHANNEL_POLICY_PATH`. When file mode is active, a non-empty
`ORG_VISIBLE_CHANNEL_IDS` or `RESTRICTED_CHANNEL_IDS` fails startup: unset
both or switch back to basic mode.

A minimal policy is:

```yaml
version: 1

default:
  ingest: true
  visibility: restricted
  allow_interventions: false
```

Rules may appear under `categories` and `channels`. An excluded rule should set
both `ingest: false` and `visibility: excluded`.

The optional secure review channel has this form:

```yaml
review_channel:
  id: "<review-channel-id>"
  secure: true
  accepts_scopes:
    - org
    - restricted
    - review_only
```

The shipped sample policy declares the `org`, `restricted`, and `review_only`
scopes. This is the same set basic mode writes for its review channel.

A new top-level channel that no rule names is held restricted, and Mneme
posts one classification review card to the review channel so an administrator
can classify it. Channels with an explicit rule and threads never produce a
card.

### Live reload

Use `/mneme reload-policy` after changing the mounted policy or prompt
files. The command validates the full candidate first. A rejected reload
leaves the previous snapshot active.

Live reload applies to file mode only. In basic mode the command is refused
with an operator-facing message that says a restart is required; the audit
trail and denial behavior stay intact.
