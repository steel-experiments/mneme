# Security model

Mneme stores workplace conversations and sends selected excerpts to a model
provider. Its security model assumes that chat content (Discord or Slack) and
model output are both untrusted.

## Trust boundaries

Chat messages can contain prompt injection, false claims, malicious links,
or text that resembles commands. Mneme passes message content as marked
conversation data, not as host instructions.

The model can retrieve only through a host-built grant. Its tools are read-only
and bounded. The model cannot send messages, change the database, access a shell,
read arbitrary files, browse the web, or make general network requests.

Structured model output is a proposal. Host code validates and acts on it.

## Scope is checked more than once

Channel visibility is resolved during discovery, retrieval, memory access, and
outbound validation. These checks use current state rather than trusting cached
scope alone.

The system fails closed when:

- a channel is unknown, deleted, excluded, or lacks required platform access
- a thread's required parent/scope anchor cannot be resolved safely
- cited evidence does not exist or is no longer visible
- retrieval provenance is broader than the target permits
- a proposal tries to change the host-pinned target
- approval-time policy is uncertain or has changed

Reply targets and evidence sources use different current-state checks. The exact
question stored for an explicit mention in a Mneme test console may anchor the reply
in that console. It does not make the console or threads below it searchable: every other
exposed source must still be an undeleted message in an ingestion-enabled channel with an
available thread parent. At initial prompt render and each tool exposure, Mneme stores
the exact exposed ID and a content-free SHA-256 fingerprint rather than duplicating the
message or memory body in provenance. The fingerprint covers every model-visible durable
field plus joined channel, parent, author, aggregate-reaction, and memory-evidence
relationship metadata. Immediately before send, Mneme re-fetches every exposed
message—not only citations—recomputes every exposed memory from current evidence, and
requires the complete ID-to-fingerprint maps to match. If any source disappears, changes,
or tightens while a model run is in flight, final validation suppresses the output. Secure
review can receive all known visibility classes, but never bypasses missing or
unresolvable source state.

Review-only information is never available to MCP tokens. A secure review grant
is tied to the exact configured review channel, not any channel with a similar
name or visibility label.

Scheduled delivery never reuses that broad grant for a working-channel post. The host
partitions due memories by deterministic origin before model exposure, pins each run to its
exact delivery audience, and rechecks the route at approval and immediately before send.
Ambiguity expires or suppresses the message; it never selects `#general` or a thread parent.

Memory scope is also recomputed from current evidence at read time. If an evidence
message is missing or deleted, its channel is missing, deleted, or ingestion-disabled,
or its thread parent is no longer available, Mneme quarantines the entire memory as
review-only. Org and MCP readers cannot see the memory statement. An administrator in
the exact secure review channel may inspect the quarantined statement, but evidence
retrieval does not return the inaccessible source content. A stale Mneme-named test
channel, or a child thread below one, is also unavailable evidence regardless of its
persisted visibility flag.

Thread policy is resolved and stored on each thread. Read-time checks use that resolved
thread class—including explicit overrides—while requiring a live parent and using the
parent ID only as the restricted-scope anchor.

Test-surface isolation is a parent-aware boundary, not a retrieval-only name filter. The
same predicate excludes a Mneme-named channel and its child threads from live
ingestion, history and reconciliation, historical construction, startup repair, review,
retrieval, and sync status. Review checks both before a provider call and before applying
its result, so a rename skips queued work or discards an in-flight result before it can
create memory or an intervention.

That quarantine preserves the record for safe remediation; it is distinct from
`/mneme forget-message`. Both forget commands first create an auditable request
for a fixed set of messages. A different admin explicitly allowlisted as a deletion
approver must confirm it; a 24-hour cancellation window follows. Only then does the
worker tombstone and purge source content, remove its evidence links, and invalidate
or narrow dependent memories from what remains. There is no post-purge undo.

## Outbound controls

Before an unsolicited message reaches the outbox, the host checks:

- operating mode and target-channel permission
- model recommendation and host-computed score
- confidence, evidence strength, and distinct evidence count
- citation existence and visibility
- complete run provenance
- maximum content length and mention safety
- channel cooldown and org-day post limit
- recent exact or near duplicates
- forced-review conditions

Approval does not bypass these controls. It repeats the evidence, visibility,
cooldown, and duplicate checks with current data.

## Slack channel boundaries

- **The invite is the consent.** The Slack app has no `channels:join` scope.
  Mneme reads a channel only after a person invites the bot, and it stops when
  the bot is removed.
- **Slack Connect channels are always excluded.** A channel that is shared with
  another organization, or that waits for such a share, is excluded. A message
  from another team in any event or history page is also proof of a share.
  Mneme excludes the channel and its threads at once, before any network call,
  and discards the page.
- **The exclusion is permanent.** A channel that was shared once stays
  excluded, also after the share ends, because its history contains the other
  organization's messages. A database trigger rejects any change that would
  open it again, and no policy rule or review decision overrides it. Deletes
  still apply to content stored before the share.
- **Rediscovery.** Mneme repeats the Slack channel discovery every 15 minutes,
  so a share that a missed event did not report is found without a restart.
- **No DMs.** Mneme has no scope that reads direct messages, and the app's
  Messages tab is read-only.
- **Commands and buttons** are refused in a shared channel, from another
  workspace, or from a user who is not in `MNEME_ADMIN_USER_IDS`.

Outbound messages never notify people. Discord sends disable mention parsing.
Slack has no mention allow-list, so Mneme escapes `&`, `<`, and `>` in all text
that it did not build, turns every user, channel, and group mention from
content into plain text, and never sends `link_names`. For direct answers, the
model supplies source message IDs rather than URLs. The host rejects
model-authored Discord or Slack message links,
including destinations hidden behind Markdown escapes, character references, or browser
URL normalization. Ambiguous encoded HTTP destinations fail closed. The host then
validates the IDs and appends at most three canonical source links itself.

Activity snapshots expose sampled message rows to the model but keep exact counts,
completeness, channel/time coverage, and truncation metadata host-only. A nonempty match
set that cannot expose a row is invalid; a genuine empty `0/0` window is valid. Immediately
before enqueue, the host reruns the same time bounds and omitted-full-grant or exact
requested-channel subset under the current grant. It rejects any model-authored line
beginning with the reserved `Coverage:` label and appends its own authoritative complete
or partial footer for every valid snapshot, including an empty one.

A technical direct-answer failure never turns retrieved content into an improvised error
message. The fallback is fixed host text and passes a narrower fail-closed gate that
re-resolves only the live pinned target and exact source-question reply anchor, then
applies mention, length, rate, and duplicate checks. It contains no retrieved facts,
counts, names, citations, provider errors, or existence hints. Deliberate policy or target
suppression remains a recorded no-send outcome rather than bypassing the visibility gate.

## Secrets and logs

Discord and Slack tokens, provider API keys, the HTTP admin token, and MCP
bearer tokens belong in platform environment variables or a secret manager. They
do not belong in YAML, prompts, `.env` files committed to Git, or chat messages.

The Slack bot token is sent only to Slack. Attachment downloads send it only to
`https://files.slack.com`, and never on a redirect to another host.

The structured logger redacts credentials, authorization headers, environment
values, prompts, and message bodies. Operational logs use IDs, counts, states,
durations, and coarse error categories.

MCP bearer tokens are displayed once and stored only as SHA-256 hashes. The
authentication layer supports expiry and immediate revocation. A token expires
90 days after creation unless the create command's `expires-days` option sets a
different lifetime (1 to 365 days); the command cannot create a token that never
expires. Review button signatures use a secret
derived from the active platform's bot token without logging that token.

## HTTP exposure

`/livez` and `/readyz` are unauthenticated health endpoints. They contain only a
small status and safe error label.

`/status` is disabled unless `HTTP_ADMIN_TOKEN` is set. When enabled, it requires
a bearer token and returns operational metadata without message or proposal
content.

MCP is disabled by default. When enabled, each request requires a separate
scoped MCP token and is rate-limited before its body is read.

Production does not currently mount `/metrics`; it returns 404.

## Database and container

SQLite uses prepared statements, foreign keys, STRICT tables, WAL mode, and
disabled extension loading. Full-text indexes exclude deleted message content.

The production image installs from the committed lockfile with lifecycle scripts
disabled, compiles TypeScript, prunes development dependencies, and runs the
application as the non-root `node` user after volume ownership is repaired.

The container filesystem is read-only in the supplied Compose setup. Mutable
state is confined to `/app/data` and `/tmp`.

## Residual risks

No prompt or policy can guarantee that a model will reason correctly. Mneme
reduces the consequence of a bad result by constraining tools and validating
outputs, but operators still need to inspect memory quality and review proposed
interventions before enabling autonomy.

Backups are another boundary. A backup may retain data deleted later, and an old
backup cannot know about deletion requests made after its timestamp. Operators
need off-host retention controls and, where deletion replay matters, an external
request ledger.

Platform permissions can change between discovery passes. Live message ingestion
uses the last computed channel policy and fails closed for unknown channels, but
operators should keep periodic discovery enabled and act on access warnings.

## Verification commands

```bash
npm ci --ignore-scripts
npm audit --omit=dev
npm run verify:sqlite
npm run check
npm test
npm run build
docker build -t mneme:verify .
```

For the stable public contract and verification entry points, see
[Safety and assurance](safety-and-assurance.md). The criterion-to-test map ships in
the repository as `contributor-docs/acceptance-checklist.md`, and a unit test checks
that every cited test title resolves.
