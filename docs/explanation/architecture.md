# Architecture

Mneme is one long-running Node.js process with three external boundaries:
Discord, a model provider, and optional MCP clients. SQLite is the durable center
of the system.

## Why one process and one database

Discord bots spend most of their time waiting for events or API responses.
SQLite can handle Mneme's write volume without another service, and a local
database makes scope checks, full-text search, jobs, and outbox state available
in one transaction boundary.

The tradeoff is explicit: Mneme cannot be horizontally scaled. A deployment
has one Discord client, one job runtime, one HTTP server, and one SQLite writer.
Recovery comes from durable state and reconciliation rather than replicas.

## Startup order

Startup is arranged to avoid a message gap:

1. open SQLite and apply migrations
2. start the HTTP health server
3. compile prompts and validate channel policy
4. register live Discord event handlers and connect the gateway
5. register guild-scoped commands and become ready
6. discover channels and active threads
7. queue historical backfill
8. discover archived threads and queue their backfill
9. start workers and periodic schedules

Live handlers are registered before Discord login. Messages that arrive while
history is being imported are written immediately. Idempotent upserts make
overlap between gateway delivery, backfill, and reconciliation safe.

If startup fails after acquiring a resource, bootstrap unwinds the job runtime,
Discord client, HTTP server, and owned database connection.

## Ingestion and conversation episodes

Channel discovery combines Discord capabilities with `channel-policy.yml`.
Mneme requires View Channel and Read Message History. Missing either one is
treated as inaccessible; a permission change disables ingestion on the next
discovery pass.

Messages are normalized and stored synchronously from gateway events. A channel
or thread has one open episode at a time. Quiet time, message count, or elapsed
time closes the episode and queues it for review.

Backfill walks message history from newest to oldest with a durable cursor.
Reconciliation refreshes a durable, bounded recent window from newest to oldest.
It resumes page-budgeted scans with the same frozen lower bound, so a known message
cannot hide an older gap and REST snapshots can refresh edits and reactions. Missing
event dependencies become id-only recovery requests; a worker rechecks visibility and
fetches the exact message before storage, without triggering episode or model work.

A shared parent-aware test-surface check excludes both Mneme-named channels and
normally named threads below them from live ingestion, backfill and reconciliation,
historical episode construction, startup repair, review, retrieval, and sync work/status.
Status classifies them as control surfaces. Review checks immediately before a provider
call and again before applying its result, so a rename safely skips queued work or discards
an in-flight result.

## The model proposes; the host decides

A model run receives:

- a host-pinned target channel
- a retrieval grant derived from current channel visibility
- a rendered system and task prompt
- scoped, read-only search and context tools
- one terminal tool that accepts a structured proposal

For an explicit Discord question, that same model run is the semantic query planner. It
interprets the user's information need and chooses between bounded `list_memories`,
topical `search_memories`, the direct-only `get_recent_activity_snapshot`, narrow
`list_recent_messages` browsing, message/context retrieval, or Mneme's documentation.
No second classifier model is called. Retrieval
implementations do not recognize English phrases; they execute the model's explicit
operation under host-owned limits and scope.

The direct-answer prompt receives the current question as structured message data and up
to ten immediately preceding permitted messages from the same channel, ordered oldest to
newest. If the question replies to an older message outside that window, its exact parent
is included when permitted. Later messages and sibling replies are not prefetched. The
host records every prefetched message ID, including the question, plus its content-free
exposure fingerprint while rendering the initial prompt; the model can request further
scoped context only through the read tools.
In a channel whose name contains `mneme`, or a thread below one, only the exact
explicit question is supplied to the run. The automatic preceding window is always
empty, including when stale policy accidentally leaves the test surface
ingestion-enabled.

The host treats that console as a reply target, not as a general evidence source. Only
the exact stored question from the initial payload may anchor its answer. All other
provenance and citations use the stricter current-source resolver, which requires the
channel and any thread parent to remain undeleted and ingestion-enabled through final
validation.

For catch-ups and time-window questions, `get_recent_activity_snapshot` performs one
model-visible, host-bounded collection across explicit `after`/`before` bounds. The model
sees only sampled message rows and fixed instructions that coverage belongs to the host;
exact matching counts, channel/time coverage, completeness, and truncation reason remain
private provenance. If the full window does not fit, the host selects deterministically
across channels and time. A genuine zero-match window is valid, but a nonempty match set
that cannot expose even one row is rejected rather than presented as empty. From an org-scoped
`#mneme-test` console, that means org-visible activity across the server; it never
includes restricted, review-only, excluded, deleted, or ingestion-disabled sources.
Restricted targets retain their narrower grant. Relative language such as "last two
days" is interpreted by the LLM from the question timestamp, while timestamps, bounds,
visibility, and coverage remain host-enforced. Immediately before enqueue, the host
reruns the same bounds and omitted-full-grant or exact requested-channel subset, validates
the exposed rows, and appends an authoritative complete or partial footer—even for a valid
empty `0/0` result. `list_recent_messages` retains its lossless pagination contract for
narrow browsing and MCP clients.

It does not receive a Discord sender. It cannot write memory directly. It cannot
use a shell, browser, filesystem tool, or generic HTTP client.

After finalization, the host validates the schema and recomputes policy. Memory
proposals must cite visible evidence and meet confidence rules. Intervention
proposals first pass baseline recommendation, score, confidence, evidence-strength,
content-length, and mention checks, then current target, provenance, citation, and scope
gates. Cooldown, daily-limit, and duplicate checks bind an autonomous target delivery or
a later administrator-approved delivery; they do not decide whether an otherwise eligible
review card can be shown.

A direct-answer proposal cites source message IDs, not links. The host rejects a Discord
jump destination written into model-authored answer text. For every initial or tool-exposed
message and memory, it compares the content-free SHA-256 fingerprint captured at the exact
exposure boundary with a newly computed fingerprint. Those fingerprints cover all
model-visible durable fields plus joined channel/parent/author, aggregate-reaction, and
memory-evidence relationship metadata; provenance stores hashes, not duplicate bodies. The
host also recomputes every exposed memory's current effective scope, validates every cited
ID against current visibility and provenance, and retains a conservative run-start
version check as defense in depth before appending canonical links. A
nonempty activity report must cite at least one exposed message. The terminal tool rejects
a missing snapshot citation before accepting the run, so the model can use its reserved
correction turn; the delivery handler repeats the check authoritatively. The delivery
handler rejects any model-authored line beginning with the reserved `Coverage:` label and
always appends the host's complete or partial footer after the model answer.

Valid direct-answer citations can carry `[[cite:message-id]]` markers. The model never
creates the URL: after current-state validation, the host replaces each marker with a
descriptive `#channel · date` Discord link. Valid citations without a marker are grouped
under one `Sources:` line. Durable deep recaps reuse the same outbound validation after
processing bounded, restart-safe time partitions in the background.

The host treats model output as untrusted, even when the model
was given good instructions.

## Visibility and provenance

Visibility is computed at read time from current channel state:

- org data may be used in org contexts
- restricted data stays within its restricted channel family
- evidence spanning multiple restricted families becomes review-only
- review-only data is limited to the exact secure review channel
- excluded data is not retrievable

If a memory's evidence message, channel, or required thread parent becomes missing,
deleted, or ingestion-disabled, current-scope recomputation quarantines the memory to
review-only. Org and MCP readers cannot see its statement. Secure review may inspect the
statement, while evidence retrieval continues to omit the inaccessible source content.

Threads inherit their parent's policy unless explicitly overridden. Memory
scope is recomputed from current evidence visibility, so changing a parent
channel from org to restricted tightens dependent memory reads immediately.

Every retrieval adds provenance to the run. Initial episode, question, and due
memory inputs also add provenance. Direct-answer message and memory exposures additionally
record exact ID-to-fingerprint mappings; a repeated exposure with a different fingerprint
is a conflict, and the outbound gate requires the complete mappings to match current state.
The gate checks all provenance, which catches an answer that paraphrases changed or
restricted material without citing it.

Human-reviewed episode and scheduled-review proposals use a different freshness boundary.
Their citations must be exact IDs exposed during the originating run, and the host checks
each cited source and its current scope when it creates the proposal. Approval rechecks
those persisted citations against current evidence and target visibility. These paths do
not claim the direct-answer path's automatic exact-fingerprint comparison across the time
spent waiting for a human.

## Durable jobs and outbox

SQLite-backed jobs run backfill, reconciliation, episode review, scheduled
memory review, attachment archival, backups, maintenance, deletion, memory
re-scoping, and outbox delivery.

Jobs have leases and bounded attempts. Provider outages and model-budget blocks
defer model work without consuming attempts. Unknown job types fail terminally
instead of sitting in the queue forever.

Continuous polling excludes handlers still active in this process from expired-lease
reclamation, while reclaiming other orphaned rows. Direct-answer leases cover both bounded
model-slot admission and the model run. A transient direct retry is admitted only when its
worst-case queue backoff still fits the immutable response deadline.

Discord output uses a separate outbox. Enqueueing an outbox row also creates its
send job in the same transaction. Dedupe keys prevent repeated intent from
creating repeated sends. On startup, Mneme reconciles rows left in
`sending`: it checks recent Discord history before deciding whether to mark the
row sent or requeue it.

Human approval and its outbox enqueue also share one immediate transaction. Approval is
therefore durably queued, not synchronously published; the outbox worker performs and
records the later Discord delivery.

Direct-answer completion and outbox enqueue share one transaction. A stale concurrent
execution that loses the terminal request transition rolls its outbox work back. If both
fallback storage attempts fail, the request stays visibly pending; startup repair or a
Gateway redelivery attaches one new active job, while a terminal request is never reopened.

## Operating modes

`observe` stores eligible proposals as observations. It does not send
unsolicited interventions.

`review` sends every proposal that clears the score, confidence, evidence, and definite
safety checks to the secure review channel; even a high-confidence proposal requires
approval. Approval runs current policy checks again before atomically recording the
reviewer and creating an outbox item. The proposal
remains `pending_review` until approval, dismissal, or expiry.

`autonomous` may approve an eligible proposal immediately. Forced-review cases
still go to the secure review channel, and definite policy failures are rejected.

A recommended scheduled-memory notification is always human-reviewed, even in
`autonomous` mode. Its model run is pinned in advance to the unique source/working channel.
The secure review channel receives the card; approval queues delivery to the shown working
target, which must allow interventions. No review channel, parent, or `#general` fallback
is used. An exact reply to the delivered message can become bounded feedback for the
scheduled subjects.

Direct answers are triggered by an explicit Discord mention and have their own
rate limit. They still pass the same scope and evidence boundaries.

See [How Mneme decides whether to speak](speaking-and-review.md) for the
complete decision flow, including uncertainty, suppression, scheduled reviews,
and the meaning of an approval.

## Shutdown and recovery

Shutdown first marks readiness false and stops periodic scheduling. Workers stop
claiming jobs and receive a bounded drain period. Mneme then disconnects
Discord, closes HTTP, checkpoints WAL, and closes SQLite.

If the deadline expires, leased jobs remain recoverable. The next process can
reclaim them after lease expiry, and outbox reconciliation handles uncertain
sends. Before registering Discord interactions or starting workers, startup
repair also expires every strictly past-deadline review proposal through
idempotent, bounded update batches; periodic maintenance repeats the sweep.
