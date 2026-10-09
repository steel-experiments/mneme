# Command reference

Mneme has one `/mneme` command. Every subcommand is admin-only, and only you
see the reply. A caller is an admin when:

- **Discord**: one of their roles appears in `MNEME_ADMIN_ROLE_IDS`.
- **Slack**: their user id appears in `MNEME_ADMIN_USER_IDS`.

If the setting for the platform is empty, nobody is authorized.

## Type a command

**Discord.** Mneme registers `/mneme` as a server command. Discord shows each
subcommand and its option fields as you type, for example `/mneme sync` and
then the `channel` field.

**Slack.** Type the subcommand and its arguments as text after `/mneme`:

```text
/mneme <subcommand> [arguments]
/mneme <group> <subcommand> [arguments]
```

- Give arguments in the order that the tables below show, or as `name:value`,
  for example `/mneme recap start days:7 topic:"pricing change"`.
- Use double quotes for a value with spaces. When the last option is text, it
  takes the rest of the line without quotes.
- For a channel option, type the channel (`#general`). For a user option,
  mention the user (`@name`).
- `/mneme help` lists every command. `/mneme help <group>` lists one group.
- Slack does not allow slash commands in threads. Type them in a channel.
- Mneme refuses commands in a channel that is shared with another
  organization (Slack Connect).

The tables below use the Discord option names. On Slack, the same names work
as `name:value`.

## Operations

| Command | Behavior |
| --- | --- |
| `/mneme status` | Shows a compact, sectioned dashboard with package version and safe build/deployment identity, mode, Gateway and model health, spend and usage, due/deferred work, eligible sync coverage, proposal/outbox state, rolling direct-reply outcomes and latency, storage, backups, and policy coverage. |
| `/mneme mode value:<configured|observe|review|autonomous> [confirmation]` | Changes the effective mode immediately. `configured` clears the durable override and returns control to `MNEME_MODE`; autonomous requires the exact confirmation `AUTONOMOUS`. |
| `/mneme channels` | Lists up to 25 current channels with visibility, ingestion, intervention, thread, archive, sync, history, and access-warning flags. |
| `/mneme sync [channel]` | Queues reconciliation for one channel or every non-excluded channel. Duplicate active work is collapsed. |
| `/mneme pause` | Pauses review and outbound jobs. Ingestion and backfill continue. |
| `/mneme resume` | Resumes paused work. |
| `/mneme historical status` | Shows the bounded campaign window, order, model, status, and budget. |
| `/mneme historical pause` | Pauses only historical construction and review; live work continues. |
| `/mneme historical resume` | Resumes a paused or newly funded campaign when cumulative budget remains. |
| `/mneme recap start [days] [topic] [channel] [budget-usd]` | Queues a durable, adaptively time-partitioned recap in the invocation channel. Defaults to 14 days and a $5 ceiling; configuration limits the maximum window and budget. The ceiling is not an estimate: a request may make up to 30 analysis calls plus synthesis before that spend gate stops new calls. |
| `/mneme recap status` | Shows the five most recent recap states, actual analyzed-message progress, adaptive partitions, omitted counts and limiting caps, authoritative retry-lineage spend, and durable worker ownership. A nonterminal request without exactly one queued or running owner is shown as `recovery needed`, never as active synthesis. |
| `/mneme recap retry id:<id>` | Creates a new synthesis-only attempt from the latest failed leaf of a recap lineage whose planned chunks all completed and whose shared budget has room. It reuses the stored summaries, citations, fingerprints, and lineage spend without re-analyzing message history. |
| `/mneme recap cancel id:<id>` | Cancels a queued or running recap by full ID or unique prefix. |
| `/mneme reload-policy` | File mode only. Validates and atomically reloads policy and prompt files, then queues memory re-scoping when needed. In basic mode the command is refused with a restart notice: the basic policy comes from the environment lists, and changes to those lists take effect after a restart. |
| `/mneme backup` | Queues an online SQLite backup, returns a short job ID, and sends a best-effort private completion DM that identifies the inbox as non-conversational. Track retries or failures with `/mneme status`. |
| `/mneme integrity-check` | Runs SQLite integrity and foreign-key checks. |

The registered `sync` command performs overlap reconciliation. A full historical
backfill is scheduled at startup when `FULL_HISTORY=true`.

Status distinguishes work that is due now from queued work deferred until a
future `run_after` time. Its failed-job count is retained history, not a claim
that every failure is current. Sync progress is based on channels currently
eligible for history ingestion; Mneme-named control/test channels and other
policy-excluded surfaces are reported separately instead of making eligible sync
look incomplete. Build, source revision, and deployment identifiers are bounded,
sanitized, and shortened to 12 characters in the reply.

Normal mention-based catch-ups are intentionally one bounded snapshot. When the
footer says `Coverage: partial`, the answer is a deterministic, channel-balanced
and time-balanced sample—not a claim that only those messages exist. Narrow the
topic/channel/window, or use `/mneme recap start` for durable partitioned analysis.
Host-generated links are placed inline beside supported claims when the model supplies
valid citation markers; remaining valid citations appear in one descriptive `Sources:` line.
Deep recaps also post a fixed, content-free notice if bounded processing retries are
exhausted, so an expected report does not disappear silently. A synthesis retry gets a
new request and delivery identity; this prevents its report from colliding with the
original request's failure notice. Source scope and fingerprints are revalidated before
the retried report can be queued. Failures caused by changed sources, invalid targets,
unfinished chunks, or exhausted request budget are not retryable from stored summaries.
Every retry retains its immediate parent and immutable root request. Mneme charges
all chunk and synthesis attempts—including failed or aborted billable calls—in that family
against the root request's original cap. Per-call timestamps determine daily spend, and
copied retry summaries create no new charge,
so retrying an older ancestor cannot reset the remaining budget. Each failed request can
have at most one retry child: once a newer attempt exists, only that latest failed leaf can
be retried. A completed or partial report closes the entire lineage to further retries.

Status counters have the following scopes:

| Field | Meaning |
| --- | --- |
| `Gateway: ... reconnects` | Reconnect events since the current process started. The count is diagnostic; `ready` is the current state. |
| `Usage` and `Spend` | Model input/output tokens and estimated provider cost for the current organization day and across retained run history. Input combines uncached input, cache reads, and cache writes. Inspector shows the post-migration-034 cache/reasoning breakdown; the command keeps its existing aggregate shape. Input and output are separate totals and need not be similar. |
| `Jobs: due` | Queued jobs whose `run_after` time has arrived. |
| `Jobs: deferred` | Queued jobs intentionally waiting for a future `run_after`, including retries and budget-deferred work. |
| `Jobs: failed retained` | Terminal failed-job records kept for diagnosis, within the `JOBS_RETENTION_DAYS` window (default 30 days); the daily maintenance job removes older ones, so this count falls over time. They are historical until a current due/running job indicates active work. When nonzero, `Failure types` shows the four largest job-type groups and aggregates the remainder as `other`. |
| `Historical: analyses pending` | Historical episodes currently queued or being reviewed. |
| `Proposals: review` | Actionable `pending_review` rows, using the same captured-clock deadline rule as `/mneme proposals`: null, future, and exactly-current deadlines count; strictly past deadlines do not. A rare pre-sweep mismatch is shown separately as `stale awaiting expiry`. Startup repair expires stale rows before interactions start, and periodic maintenance repeats the sweep. |
| `Proposals: observed` | Durable proposals that were stored but not sent. This includes observe-mode proposals and proposals suppressed by recommendation, threshold, evidence, scope, rate, or duplicate checks. |
| Other proposal states | All-time counts of proposal rows in their current durable state, not today's activity. |
| `Delivery` | All-time counts of outbox rows in their current durable state. This can include direct answers and other deliveries, so it does not have to match proposal counts. |
| `Campaign progress: waiting` | Episodes from the named campaign currently queued or being reviewed. |
| `Deep recaps` | Durable admin-requested reports by owned-active, recovery-needed, and terminal state, plus their recorded spend. |

For the relationship between confidence, review, suppression, and approval, see
[How Mneme decides whether to speak](../explanation/speaking-and-review.md).

## Proposal review

| Command | Behavior |
| --- | --- |
| `/mneme proposals` | Lists up to 10 unexpired pending proposals without message content. |
| `/mneme approve id:<id>` | Rechecks current evidence, visibility, cooldown, limit, and duplicate policy, then atomically records approval and queues the outbox delivery. It does not publish synchronously. |
| `/mneme dismiss id:<id>` | Dismisses the proposal and creates no outbox item. |

Proposal IDs may be full IDs or unique eight-character prefixes. If a prefix is
ambiguous, use the full ID. Review-channel buttons use the same approval and
dismissal workflow as the slash commands. A non-terminal policy block leaves the
proposal `pending_review` and keeps its buttons available for a later retry. Successful
approval or dismissal interactions remove the controls; an approval click that detects
expiry also resolves its card. Startup repair performs the idempotent expiry sweep in
bounded update batches before interactions start, and periodic maintenance repeats it as
defense in depth. Expiry changes database state but does not promise to edit an old
message, so a stale button may remain visible but cannot enqueue delivery.
Scheduled-memory cards live in the exact secure review channel, but approval queues the
notification to the separately shown source/working channel. That target must set
`allow_interventions: true`; `#general` is not a fallback, and threads remain exact targets.
Reply to the delivered notification (Discord Reply, or a thread reply on
Slack) to update the reviewed memory. Ordinary
review-channel messages do not alter memory. Cards show a categorical recommendation and
up to three current evidence links rather than a synthetic intervention score.

## Memory and deletion

| Command | Behavior |
| --- | --- |
| `/mneme memory-search query:<text>` | Runs a literal full-text memory search visible from the invocation context. Use `query:*` (surrounding whitespace is ignored) for the bounded inventory compatibility form. The exact secure review channel has broader review access. |
| `/mneme memory-get id:<memory-id>` | Returns one complete permitted memory with host-built source links. Use the full ID returned by `memory-search`. |
| `/mneme forget-message id:<message-id>` | Creates a deletion request for one currently stored message; shows its ID and count. Deletes nothing yet. |
| `/mneme forget-user user:<user>` | Select a user (Discord) or mention one (Slack) to request deletion of their currently stored messages. Free-text names are not accepted. Deletes nothing yet. |
| `/mneme deletion status [id:<request-id>]` | Shows the latest four requests, or one exact request, with target, requester, approver, count, status, deadline, and worker failure when present. |
| `/mneme deletion approve id:<request-id> [confirmation:DELETE]` | An independently authorized approver reviews the preview, then confirms. Schedules the purge no earlier than 24 hours later. |
| `/mneme deletion cancel id:<request-id>` | The requester or an authorized deletion approver cancels before the first purge batch starts. |
| `/mneme deletion retry id:<request-id>` | The original approver retries a failed worker job using the same approved message set and original deadline. Its job record is retained while the request needs recovery. |

Deletion commands work only in the configured secure review channel, whose policy
must accept `org`, `restricted`, and `review_only` scopes. Replies are ephemeral and
contain IDs and counts, never source message text. Attempts and state transitions
are audited. The owner discovers pending requests with `deletion status`; requests
do not automatically send a review card or DM.

Admin status permits requests, not approval. Approval additionally requires the
caller's user ID in `MNEME_DELETION_APPROVER_USER_IDS`. The requester can never
approve their own request, even if they are an approver or the target. With one
configured owner, another admin must initiate a request for that owner to approve.
No approver configured means deletion is disabled.

The message set is fixed when the request is created. New messages and later
backfilled history require another request. Approval starts a fixed 24-hour grace
period. Content remains stored and usable until the purge starts. Cancellation
works during that period and afterward if the worker has not started; it never
restores a purge already in progress. `/mneme pause` and observe mode do not
cancel or suspend an approved deletion.

At execution, the worker rechecks approval, the current approver allowlist, the
deadline, and job ownership. It purges normalized content, removes evidence links,
and invalidates or narrows dependent memories in restart-safe batches. Attachment
file removal uses durable cleanup jobs. `completed` means the message batches are
complete; attachment file cleanup may still be queued. The original messages on Discord or Slack are not
deleted. No undo archive is kept; message tombstones prevent automatic reimport.

Removing an approver from configuration stops remaining batches after restart;
already purged messages stay deleted. Such a request is shown as cancelled with
its processed count, which may be nonzero. Before upgrading, verify a completed
backup: migration 040 cancels all active legacy `forget_user` jobs because they
have no independent approval. It does not restore previously deleted content.
An older image without migration 040 cannot start against the upgraded database.

### Archive users and archive deletion

These commands exist only when a read-only platform archive is configured
(`MNEME_ARCHIVE_PATH`). Like the deletion commands, they work only in the secure
review channel and need an admin.

| Command | Result |
|---|---|
| `/mneme archive user name:<text>` | Lists archive authors whose name contains the text, with their archive user ID and the number of their org messages. Only org content is searched; an author who is already hidden does not appear. |
| `/mneme archive forget-user id:<archive-user-id>` | Creates a deletion request that hides every archive message of that user. Deletes nothing yet. |
| `/mneme archive forget-message id:<archive-message-id>` | Creates a deletion request that hides one archive message. Deletes nothing yet. |

Archive requests use the same approval, 24-hour grace period, cancellation, and
`deletion` commands as live requests. The approver must be a different person
from the requester, so a deployment with one admin cannot complete an archive
deletion; add a second admin first. `forget-message id:archive:<id>` and
`forget-user` with an `archive:` id also work. At execution, Mneme does not
change the archive file: it records a redaction in the live database, and every
archive read, agent tool, MCP tool, and citation check hides the target from then
on. A redaction applies to every copy of the archive, rewritten or not. To remove
the rows from the file itself, an operator runs `archive-rewrite` (see
[Configuration](configuration.md)).

A user redaction hides the user's own messages and the memories that they own or
that cite their messages. It does not remove the user's name or mentions from
other people's archive messages.

## MCP token management

| Command | Behavior |
| --- | --- |
| `/mneme mcp-token create name:<name> [channels:<refs>] [expires-days:<1-365>]` | Creates a bearer token and displays it once. Channel refs are comma-separated IDs or names. |
| `/mneme mcp-token list` | Lists token metadata, scope, expiry, last use, and revocation state. |
| `/mneme mcp-token revoke id:<id>` | Revokes a token immediately. |

With no channel list, a token receives org scope. A channel list adds only valid
restricted channels. A restricted thread ref is stored as its canonical parent scope
anchor so the token can use the same thread boundary as chat retrieval. Review-only
and excluded channels cannot be granted. The
plaintext token cannot be recovered because Mneme stores only its SHA-256
hash. A token expires 90 days after creation unless `expires-days` sets a
different lifetime (1 to 365 days); the command cannot create a token that
never expires.

## Inspector token management

| Command | Behavior |
| --- | --- |
| `/mneme inspector-token create name:<name> [expires-days:<1-365>]` | Creates an inspector bearer token and displays it once. |
| `/mneme inspector-token list` | Lists token metadata, expiry, last use, and revocation state. |
| `/mneme inspector-token revoke id:<id>` | Revokes a token immediately. |

An inspector token authenticates the read-only admin web surface
(`INSPECTOR_ENABLED=true`). It carries no scope: every page runs under the
secure review grant. A token expires 30 days after creation unless
`expires-days` sets a different lifetime (1 to 365 days). In a browser, paste
the token as the password in the login dialog; from a command-line client, send
it as `Authorization: Bearer`. An inspector token never authenticates the MCP
endpoint, and an MCP token never authenticates the inspector.

## Auditing

Authorization successes and failures are written to `admin_events`. Audit rows
contain actor IDs, action names, targets, timestamps, and bounded metadata. They
do not contain message bodies or secret token values.
