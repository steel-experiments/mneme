# Memory quality and asynchronous conversations

Mneme deliberately closes episodes quickly: after 90 seconds of quiet, 40
messages, or 10 minutes by default. Those boundaries control model cost and keep each
review coherent, but they are not treated as proof that the conversation is finished.
Chat work is asynchronous. A request can be answered after a meeting, a sleep cycle,
or another time zone starts work.

## Identity observations

Reaction events on Discord and Slack identify a user but do not include an authoritative profile or
membership record. Mneme may create an ID-only placeholder so the reaction remains
referentially valid. A later reaction never erases a known username, bot classification,
display name, or role set. Full profile and membership events remain the source
for changes to those fields.

## Delayed follow-ups

Before reviewing an episode, the host scans a bounded window of later human messages in
the same channel or thread. Direct replies, completion terms such as `done`, `fixed`,
and `resolved`, lexical overlap with the episode, and temporal proximity rank highest.
The scan examines no more than 500 messages and exposes no more than
`MEMORY_FOLLOWUP_MAX_MESSAGES` (20 by default) from
`MEMORY_FOLLOWUP_HORIZON_DAYS` (14 days by default). Bot messages are excluded.
Historical campaigns cannot look beyond their frozen campaign end time.

The later messages appear in the prompt as a separate untrusted follow-up section. They
can resolve an open question, complete or cancel a commitment, correct a fact, or
supersede a decision. They are not silently merged into the original episode.

## Host-enforced evidence

The model proposes memories, but the host decides whether they are persisted. For each
proposal, the host requires:

- exact message IDs that were exposed during this run, not merely messages from an
  exposed channel;
- a short verbatim quote from every cited message, verified against stored content;
- a `project` or `organizational` durability classification and a concrete reason;
- confidence and importance at or above configured thresholds for new durable records.

This does not make the model infallible, but it prevents guessed evidence IDs and makes
unsupported material clauses fail closed.

## Canonical records

One discussion should normally produce one canonical memory. Two create/supersede
proposals sharing evidence are treated as overlapping unless the later proposal gives a
specific `independentReason`. An exact same-type duplicate confirms the existing active
memory and adds evidence instead of creating another row. Across separate runs, a
same-type proposal with substantially overlapping evidence and strong lexical containment
also confirms the existing active record. Ambiguous semantic neighbors without that
shared-evidence signal are still left for explicit model or human review.

Transient status, casual fragments, and context-poor measurements are not durable
memory. `MEMORY_MINIMUM_IMPORTANCE` provides an additional deterministic persistence
floor.
