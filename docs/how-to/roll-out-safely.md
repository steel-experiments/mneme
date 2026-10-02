# Roll out review and autonomy safely

Start with ingestion, inspect real behavior, then grant Mneme more ability
to speak. Each phase has an explicit rollback: set `MNEME_MODE=observe` and
restart. The `/mneme pause` command is a faster operational brake for review
and outbound jobs while ingestion continues.

## Phase 1: observe ingestion

Configure:

```dotenv
MNEME_MODE=observe
DIRECT_ANSWER_ENABLED=false
```

Keep every channel's `allow_interventions` false. The starter configuration
enforces this without extra work: basic-mode rules always set it false,
including the default rule for unselected channels. With a file-mode policy,
check every rule yourself.

Run Mneme long enough to complete discovery and, if enabled, historical
backfill. Check `/mneme channels` against the intended selection lists or
policy file. Inspect permission warnings and confirm unselected or excluded
channels have no stored messages.

Do not continue until:

- the privacy notice is posted
- the channel selection or policy matches the live guild
- backfill and reconciliation are healthy
- database growth and backup size are understood
- no unexpected outbound message was sent

Observe mode prevents unsolicited interventions. Mneme still ingests
messages and still calls the model to review episodes and extract memories; it
only never posts on its own. Disabling direct answers also removes replies to
explicit mentions, so this phase produces no output in chat.

## Phase 2: inspect memories

Keep observe mode active. Review `agent_runs`, memories, and observed
proposals with production conversation patterns.

Check:

- memory statements are supported by real evidence
- restricted memories remain in their channel scope
- summaries are concise and useful
- model cost stays within `LLM_DAILY_BUDGET_USD` (2 USD per day unless you
  change it; the keyword `unlimited` removes the cap)
- timeouts and provider failures defer or fail closed without affecting ingestion

Tune prompts and thresholds before enabling a review channel.

## Phase 3: require human review

Create a private review channel that only the review group and Mneme can
read.

Before you declare the channel, verify its audience: only the review group and
Mneme may hold read access. Enabling the channel requires an explicit
audience assertion from you. Mneme cannot verify the member list, so the
assertion is the operator's confirmation that the check happened.

Add the channel to your edited `config/channel-policy.yml`:

```yaml
review_channel:
  id: "<review-channel-id>"
  secure: true
  accepts_scopes:
    - org
    - restricted
    - review_only
```

Set the matching environment values:

```dotenv
MNEME_MODE=review
MNEME_REVIEW_CHANNEL_ID=<review-channel-id>
```

With `CHANNEL_POLICY_SOURCE=basic`, set the assertion pair instead of the YAML
block:

```dotenv
MNEME_MODE=review
MNEME_REVIEW_CHANNEL_ID=<review-channel-id>
MNEME_REVIEW_CHANNEL_SECURE=true
```

Restart Mneme. Startup fails if the IDs differ, the channel is not marked
secure, the basic-mode assertion pair is incomplete, or the bot cannot access
the channel.

Exercise both review buttons and slash commands. Approval rechecks current
visibility, evidence, cooldown, and duplicate state; a proposal can be blocked
even if it was valid when first created.

## Phase 4: allow limited autonomy

Choose one or two org channels. Set `allow_interventions: true` only on those
channels, then switch to:

```dotenv
MNEME_MODE=autonomous
GLOBAL_AUTONOMOUS_POST_LIMIT_PER_DAY=1
```

Basic mode cannot enable interventions; every rule it writes sets
`allow_interventions: false`. Set `CHANNEL_POLICY_SOURCE=file` and use a
policy file before this phase.

Keep a secure review channel configured. Restricted evidence, cross-restricted
evidence, urgent claims, and uncertain provenance still go to review or are
rejected.

Record each autonomous post and classify it as useful, harmless noise, or
incorrect. Also record whether people find the timing disruptive. Expand only
after an agreed observation window.

## Phase 5: expand with evidence

Before adding channels, write down:

- observation window
- minimum useful-post rate
- maximum incorrect-post count
- acceptable channel feedback
- who can pause or roll back the bot

Test the controls:

```text
/mneme pause
/mneme status
/mneme resume
```

While paused, live ingestion and backfill continue; review and send jobs wait.
To roll back persistently, set `MNEME_MODE=observe` and restart.

Increase `GLOBAL_AUTONOMOUS_POST_LIMIT_PER_DAY` slowly. The limit is a safety
control, not a measure of intervention quality.

## Run a bounded historical campaign

Treat historical memory extraction as a separate, reversible campaign. Use a
fixed time window and explicit channel IDs, start newest-first, choose the
historical model independently of the live model, and begin with a small
cumulative budget such as `$2`.

Keep `HISTORICAL_MEMORY_MAX_PENDING_REVIEWS=1` for the first sample. Confirm in
`/mneme status` that the intended model and window are active, then inspect
the resulting memories and their source links. Pause only the campaign with:

```text
/mneme historical pause
/mneme historical status
```

If quality and cost are acceptable, raise
`HISTORICAL_MEMORY_TOTAL_BUDGET_USD`, redeploy, and run
`/mneme historical resume`. The campaign ID, channel set, direction, model,
and timestamps are immutable for safety; use a new campaign ID for a different
scope. The global `LLM_DAILY_BUDGET_USD` must remain above the historical daily
cap so live work retains headroom.
