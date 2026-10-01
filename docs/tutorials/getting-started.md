# Install Mneme

This tutorial takes a new Discord server from no bot to a Mneme instance in
`observe` mode. Observe mode ingests and reviews conversations but does not send
unsolicited messages.

## What you need

- a Discord server where you can manage applications and roles
- Docker with Compose, or Node.js 24
- an API key for OpenAI, Anthropic, or Google
- the Discord IDs for the server, application, admin role, and any channels or
  categories you will name in the channel selection or policy

## 1. Create the Discord application

Open the [Discord Developer Portal](https://discord.com/developers/applications)
and create an application.

1. Copy the Application ID.
2. Open the Bot page, create a token, and store it in a secret manager.
3. Enable Message Content Intent.
4. Create an install URL with the `bot` and `applications.commands` scopes.
5. Add the bot to the server.

Mneme requests these gateway intents:

- Guilds
- Guild Messages
- Guild Message Reactions
- Direct Messages
- Message Content

It does not request presence or the full guild-member intent.

## 2. Create a least-privilege role

Create a dedicated Mneme role. Grant it:

- View Channel
- Read Message History
- Send Messages
- Send Messages in Threads
- Embed Links
- Use Application Commands

Add Attach Files only if Mneme needs to send files. Add Manage Threads only
if you need complete discovery of archived private threads. Do not grant
Administrator.

Apply the role at the category level. Explicitly deny access to excluded or
legally sensitive categories. Mneme can only ingest channels where it has
both View Channel and Read Message History.

## 3. Create the environment file

Copy the template:

```bash
cp .env.example .env
```

`.env.example` is the short first-run template. Set at least these values:

```dotenv
DISCORD_TOKEN=replace-me
DISCORD_APPLICATION_ID=<application-id>
DISCORD_GUILD_ID=<guild-id>
OPENAI_API_KEY=replace-me

ORG_NAME=Example Company
ORG_TIMEZONE=UTC
MNEME_MODE=observe
MNEME_ADMIN_ROLE_IDS=<admin-role-id>

ORG_VISIBLE_CHANNEL_IDS=<org-channel-or-category-ids>
RESTRICTED_CHANNEL_IDS=<restricted-channel-or-category-ids>
```

`LLM_PROVIDER` and `LLM_MODEL` default to `openai` and `gpt-5.6-terra`. Set
them only when you use another provider or model, and set only the API key for
that provider.

`FULL_HISTORY` must be set explicitly. It has no default. The choice:

- `FULL_HISTORY=true`: import all reachable history for the selected channels
  on first start.
- `FULL_HISTORY=false`: start with new messages onward.

Every supported setting is listed with its default in
`config/advanced.env.example`. A native run reads `./.env` automatically;
values already present in the process environment win. Keep tokens and keys
out of YAML and version control.

## 4. Select the channels

The default `CHANNEL_POLICY_SOURCE=basic` builds the channel policy from the
environment:

- `ORG_VISIBLE_CHANNEL_IDS`: channels or categories that org-scoped retrieval
  may use.
- `RESTRICTED_CHANNEL_IDS`: channels or categories whose content stays within
  that channel family.

Each id names one channel or one category. A category id classifies the
channels inside it. Selected channels ingest with interventions off. Channels
not in either list do not ingest. Threads inherit their parent channel's rule.

For full control, set `CHANNEL_POLICY_SOURCE=file` and edit the synthetic
sample at `config/channel-policy.yml`. Start conservatively:

```yaml
version: 1

default:
  ingest: true
  visibility: restricted
  allow_interventions: false

categories:
  "<org-category-id>":
    ingest: true
    visibility: org
    allow_interventions: false

  "<excluded-category-id>":
    ingest: false
    visibility: excluded
    allow_interventions: false
```

The resolution order is an explicit channel rule, thread parent, parent
category, then `default`. Threads normally inherit their parent's rule.

The visibility classes are:

- `org`: usable across org-scoped conversations
- `restricted`: usable only within that restricted channel family
- `review_only`: visible only in the secure review context
- `excluded`: not ingested or used

Leave every `allow_interventions` value false during initial setup. Basic mode
needs no action here: its rules cannot turn interventions on.

## 5. Verify the checkout

For a source installation:

```bash
npm ci --ignore-scripts
npm run verify:sqlite
npm run check
npm test
npm run build
```

For Docker, build the same image used in deployment:

```bash
docker build -t mneme:local .
```

## 6. Start Mneme

With Docker Compose:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up --build
```

The base Compose file exposes port 3000 only to other containers. The example
override publishes it on the host loopback interface (`127.0.0.1:3000`) for
local checks.

With Node.js, run from the repository root:

```bash
npm start
```

Mneme reads `./.env` at startup. Values already present in the process
environment win over the file.

## 7. Check the first start

Wait for `/readyz` to return 200:

```bash
curl --fail http://localhost:3000/readyz
```

Then run these ephemeral Discord commands as a member with a configured admin
role:

```text
/mneme status
/mneme channels
```

Compare the channel list with your selection lists or policy file. Check that:

- the gateway is ready and the model is healthy;
- the build revision is the one you deployed;
- unselected or excluded channels do not appear as ingestible, and missing
  permissions are reported;
- backfill and campaign work are either complete or visibly progressing.

If `FULL_HISTORY=true`, let the backfill queue drain before judging memory
coverage. Mneme stores live gateway events while the historical backfill is
running. When source channels have not synced yet, conversational answers are
incomplete even when Mneme itself is healthy.

## 8. Verify your first answer

Use a dedicated Discord channel as a safe console for this check. Ten minutes
is usually enough to verify the happy path.

Create a text channel named `mneme-test` and let Mneme:

- View Channel
- Read Message History
- Send Messages
- Use Application Commands

Mneme treats any channel whose name contains `mneme`,
case-insensitively, as a test console. Ordinary messages in it are not
ingested, backfilled, grouped into episodes, or turned into memories. An
explicit mention is stored as the exact reply anchor and direct-request
record, but remains excluded from episodes and memories. This makes the
channel useful for testing without teaching Mneme from the tests.

With `CHANNEL_POLICY_SOURCE=basic`, leave the console out of both selection
lists: an unselected channel does not ingest, and its visibility is also
restricted, so ask the memory and catch-up questions from an org-visible
channel. The console itself only confirms that Mneme answers mentions. With a file policy, give the
console an explicit rule. Replace the example ID with the Discord channel ID:

```yaml
channels:
  "<test-channel-id>": # mneme-test: safe org-visible console
    ingest: false
    visibility: org
    allow_interventions: false
```

`visibility: org` lets answers use already-ingested org-visible evidence from
other channels. It does **not** grant access to restricted, review-only,
excluded, deleted, or ingestion-disabled sources. Deploy or reload the
channel policy, then make sure the bot appears online, and send these as
normal Discord mentions, one at a time:

```text
@Mneme hi
@Mneme bring me up to speed on the last two days
@Mneme what do you remember?
@Mneme what decisions do you remember about authentication?
```

Expected behavior:

1. `hi` verifies direct replies.
2. The catch-up collects the requested window across the full permitted org
   scope in one bounded snapshot, not just `#mneme-test`, and cites up to
   three source conversations inline beside the relevant claims. If the
   window exceeds the cap, Mneme labels the report partial, states
   sampled/total coverage, and suggests narrowing the request. For a larger
   durable report, an admin can run
   `/mneme recap start days:14 budget-usd:5` in the desired destination.
3. The broad memory question inventories permitted durable memories.
4. The topical question searches for relevant memories and their source
   evidence.

A clear "no matching permitted activity" answer can be correct when no
matching data has been ingested. Silence is not a normal technical outcome
for an admitted direct question: if synthesis cannot complete, Mneme
sends a short processing-limit fallback when the target remains safe. Check
`/mneme status`, `/mneme channels`, the requested time window, and
channel visibility when the result is unexpected. When a check fails,
[Troubleshooting](../how-to/troubleshooting.md) maps each symptom to its
cause.

Mneme does not answer questions in DMs. An inbound DM receives one fixed
notice that directs the sender back to an explicit server mention; repeated
DMs from the same sender are limited to one notice per 24 hours. DM content
is not ingested, stored, logged, or sent to the model.

Know the console limits. `#mneme-test` is an answer destination, not a
memory source. Mneme has no automatic preceding-message context there;
follow-ups such as "what about that?" may lack the message they refer to; and
discussions held only in the test channel will not appear in later searches.
Make each test question self-contained.

## 9. Publish the privacy notice

Complete and post the template in
[Publish the member privacy notice](../how-to/publish-privacy-notice.md). Do this
before treating the installation as live.

## Next steps

Keep Mneme in observe mode until ingestion, extracted memories, and channel
scope have been checked with real server data. Continue with
[Roll out review and autonomy safely](../how-to/roll-out-safely.md).
