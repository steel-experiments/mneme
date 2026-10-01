# How Mneme analyzes conversations

Mneme does not review every message independently and does not automatically
send a fixed window around every message to the model. It first groups nearby
messages from one Discord conversation into a bounded **episode**, then reviews
that complete episode. The model may retrieve additional permitted evidence
when the episode alone is insufficient.

## Conversation and thread boundaries

A Discord channel and each Discord thread are separate conversations. Messages
from different conversations never enter the same episode. Reply relationships
are preserved as metadata, but replies do not determine episode boundaries.

For a bounded historical campaign, a channel or thread is processed only when
its own Discord ID is in the campaign allowlist. Allowlisting a parent channel
does not implicitly include all of its child threads.

A Mneme-named channel is a test surface, as is every child thread even when the
thread itself has a normal name. The same parent-aware boundary applies to live ingestion,
history and reconciliation, historical episode construction, startup repair, review,
retrieval, and sync status. Episode review checks immediately before the model call and
again before applying the result: a rename into the test surface skips queued work or
discards an in-flight result.

## Episode boundaries

Within one conversation, Mneme keeps messages in chronological order and
starts a new episode when any configured boundary is reached:

- the gap since the previous message is at least `EPISODE_QUIET_SECONDS`;
- the current episode has reached `EPISODE_MAX_MESSAGES`; or
- the time since the episode's first message has reached
  `EPISODE_MAX_MINUTES`.

The defaults are 90 seconds of quiet, 40 messages, and 10 minutes. Reactions
enrich the stored message but do not reset the quiet timer by default. Deleted
messages, bot messages, empty messages, and ignored commands are not used to
construct historical episodes.

For example:

```text
10:00:00  Alice  We should use OAuth.
10:00:30  Bob    Agreed; it avoids managing passwords.
10:01:05  Alice  I'll implement it next week.
           [at least 90 seconds of silence]
10:03:10  Carol  Has anyone seen the new homepage?
```

The first three messages form one episode. Carol's message starts another.

## Waiting for the conversation to end

An episode boundary controls what one review reads. It does not show that the
discussion is complete: 90 seconds of quiet is a pause, and the message and
duration limits are reached while people are still typing.

Mneme therefore holds the review of a closed episode until the channel is
quiet for `EPISODE_SETTLE_SECONDS` (10 minutes by default). The wait has two
purposes. A held review reads the later human messages in the same conversation,
so it sees the answer, correction, or fix that arrived after the boundary. And
Mneme does not interrupt a discussion that the team is still having.

If a channel stays busy, the review starts anyway after
`EPISODE_SETTLE_MAX_MINUTES`, so organizational memory is never blocked. Such a
review can record memory, but it cannot propose a message. The same check runs
again when the review finishes, because a channel can become active while the
model is thinking. A proposal about an active conversation is recorded and not
sent, and the subject can come back in a later review.

A direct question to Mneme is never delayed by this wait.

## Historical ordering and batches

A newest-first historical campaign selects up to
`HISTORICAL_MEMORY_BATCH_MESSAGES` candidate messages from one eligible
conversation, beginning at its newest unprocessed cursor. Mneme puts those
messages back into chronological order before splitting them into episodes. It
reviews the newest resulting episode first and rotates among eligible channels
so one busy channel does not monopolize the campaign.

The batch size controls database work; it is not the number of messages supplied
to one model run. One reviewed episode produces at most one episode-review run.
`HISTORICAL_MEMORY_MAX_PENDING_REVIEWS` limits how many campaign episodes may be
queued or reviewing at once.

## What the model initially receives

The initial review contains the complete episode transcript, not an automatic
`message ± N` window. Each included message carries:

- its message ID and chronological ordinal;
- author ID and display name;
- content and timestamp;
- reply target, when present;
- aggregate reactions; and
- a Discord source link.

The prompt asks the model to identify consequential decisions, assumptions,
predictions, facts, risks, commitments, experiments, disagreements, constraints,
and open questions. It must cite the minimum supporting message IDs for each
proposed memory.

## Optional context retrieval

During a review, the model can search existing memories and permitted messages.
When it needs context around a particular message, `get_message_context` returns
10 messages before and 10 after the anchor by default. A request may select up
to 20 on either side and may include a bounded direct reply chain.

This retrieval is optional rather than automatic. The review prompt directs the
model to retrieve older messages only when they could confirm, contradict, or
materially contextualize the episode. All retrieved material must pass the same
visibility policy as the episode and counts toward the run's tool-call and
retrieved-character limits.

## Context for explicit questions

A direct answer does not begin with only the text after `@Mneme`. The host supplies
the current question as structured message data, including its message ID, author,
timestamp, reply target, and canonical Discord link. It also supplies a chronological
window of at most ten immediately preceding permitted messages from the same channel.

When the question is a reply and its parent falls outside that window, the host adds the
exact parent if it is still permitted. It does not prefetch later messages, sibling
replies, or another channel. The question, preceding window, and optional reply parent
are untrusted conversation data. Every exposed message ID and its content-free SHA-256
exposure fingerprint are recorded while that initial prompt is rendered, before the model
runs. Tool-returned messages and memories are fingerprinted at their exact exposure
boundary too; only IDs and hashes, not duplicate bodies, enter provenance.

Channels whose names contain `mneme`, and threads below them, are deliberately
different: ordinary messages there are never activity evidence. Their automatic
preceding window is always empty, even if stale policy accidentally marks the test
surface ingestion-enabled. The exact explicit question is supplied separately as the
reply anchor.

Time-window catch-ups do not depend on keyword search. The direct-answer agent has a
direct-only `get_recent_activity_snapshot` operation and translates requests such as
"bring me up to speed on the last two days" into explicit timestamps anchored to the
question's creation time. One model-visible call collects the bounded window. The model
sees only sampled message rows and fixed instructions that coverage is host-owned; exact
totals, channel/time bounds, completeness, and truncation metadata remain private host
provenance. When a window is too large, deterministic sampling preserves cross-channel and
time coverage. A real zero-match result is valid; a nonempty match set that cannot expose
even one row is rejected and must be narrowed rather than presented as empty.

The same retrieval grant applies as everywhere else, so an org test console can summarize
org-visible channels but cannot see restricted channels. An unqualified catch-up leaves
the channel filter unset and therefore spans that full permitted scope; the channel where
Mneme was addressed is only the answer destination. Mneme narrows the snapshot
only when the user explicitly requests specific channels. The older
`list_recent_messages` operation remains a lossless paged browse for focused inspection
and MCP pagination, not the normal recap loop.

Direct answers reserve their final two model turns for finalization and the one permitted
correction. A nonempty catch-up without a snapshot citation is rejected inside that
finalization gate, allowing the correction turn to fix it. The model is instructed not to
author coverage statistics; only the host footer is authoritative, and any model-authored
line beginning with the reserved `Coverage:` label is rejected. Immediately before
enqueue, the host reruns the same time bounds and omitted-full-grant or exact
requested-channel subset under the current grant, then appends its authoritative complete
or partial footer for every valid snapshot, including `0/0`. Technical timeout, budget,
admission, or malformed-finalization failures do
not complete invisibly: when the current target and exact question anchor remain safe, the
host queues a fixed content-free fallback. Deliberate policy, deletion, rate, duplicate,
or target suppression remains a separately recorded no-send outcome. Failed fallback
storage remains an overdue-visible pending request and is repaired on startup or a later
redelivery rather than being mistaken for success.

The normal snapshot is capped at 200 messages and 50,000 rendered characters. This is a
per-answer context limit, not a 50-memory or 200-message database limit. For a broad
memory inventory, `list_memories` reports the exact permitted matching total separately
from the at-most-50 ranked page it returns. For a larger activity report, the admin-only
deep-recap workflow persists daily partitions and actual coverage, survives restarts,
and performs a final synthesis under explicit request and organization-day budgets.

Immediately before a primary or partial report is enqueued, Mneme re-fetches every
message exposed to the run and recomputes every exposed memory from current evidence. The
complete current ID-to-fingerprint maps must match the hashes captured at exposure. Those
hashes cover model-visible fields plus joined channel, parent, author, aggregate-reaction,
and memory-evidence relationship metadata, so deletion, policy tightening, test-surface
isolation, edits, or joined metadata changes produce the neutral fallback rather than a
stale paraphrase. The conservative run-start version boundary remains an additional check.

## Local triviality filter

Before paying for a model call, Mneme may skip an unmistakably trivial
episode. A skip occurs only when every condition below is true:

- it contains fewer than two human messages;
- it does not mention Mneme;
- it contains no decision-like phrase;
- it has no reaction burst of at least three reactions on one emoji;
- none of its messages already supports a memory; and
- its combined human text is shorter than 32 characters.

If any one condition fails, Mneme reviews the episode. This filter is
deliberately conservative because missing a consequential discussion is more
costly than reviewing an occasional unimportant one.

## Review result and status counters

The model proposes structured memories and evidence; the host validates and
stores them. Historical reviews never post an intervention into an old
conversation.

Campaign status uses these terms:

- `eligible`: total human messages in the campaign's configured scope and time
  window; it is not a remaining-work counter;
- `scanned`: messages passed by the descending campaign cursor;
- `episodes`: conversation groups constructed from scanned messages;
- `runs`: episodes that reached a model review;
- `memories`: validated memories created by those runs; and
- `pending`: campaign episodes currently queued or reviewing.
