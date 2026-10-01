# Acceptance checklist

This checklist turns every Section 48 acceptance criterion into a check you can run.
No criterion is closed by assertion alone: each row names a test file and a test
title that must pass. Run the checks, then record what you ran.

Every citation has two parts: a test file path in backticks and a test title in
double quotes. The guard test `test/unit/acceptance-citations.test.ts` parses this
document, checks that each cited file exists, and checks that each cited title
matches a test in that file. A citation that drifts fails `npm test`. Most titles
below are the full test title. The guard accepts a cited title that matches the
start of the test title.

Spec reference: Section 48 of `MNEME_IMPLEMENTATION_SPEC.md`.

## Baseline commands

Run these before you claim any criterion passes.

| Check | Command | Must pass |
| --- | --- | --- |
| Full verify | `npm run verify` | every stage passes (SQLite checks, lint, both typechecks, tests, build) |
| Typecheck | `npm run check` | exits 0 |
| Automated tests | `npm test` | every test passes; this command is the authoritative count |
| Compose config | `docker compose -f docker-compose.yml config` | validates and shows one service that reads `.env` through the `env_file` long syntax and pins only the container-fixed overrides |
| Compose with override | `docker compose -f docker-compose.yml -f docker-compose.override.example.yml config` | publishes `127.0.0.1:3000:3000`, loopback only |
| Railway config | compare `railway.json` against the schema at `https://railway.com/railway.schema.json` | validates |
| Image build | `docker build -t mneme-acceptance .` | build exits 0 |

Use Node 24 or later. The compose checks need Docker Compose v2.24 or later,
because the service block uses the `env_file` long syntax. To re-run the tests
cited on one row: `npx vitest run <file>`.

## How to record a pass

When you verify a change against this checklist, record these facts in your pull
request:

- Date of the run.
- Commit hash you tested.
- Environment: operating system, Node version, Docker version.
- Commands you ran, and their results.
- For each failed check: the failing output, and a link to the issue that tracks it.

Do not add dated results to this document. It stays a reusable template. The
record of a run belongs in the pull request or issue that prompted it.

## Ingestion

| Section 48 criterion | Tests that must pass |
| --- | --- |
| Bot connects with required intents | `test/unit/discord-client.test.ts` — "requests exactly the five required intents and no presence/full-member intents"; "constructs the discord.js client with only those intents" |
| Every accessible configured channel is listed | `test/integration/channel-discovery.test.ts` — "lists every accessible configured channel with effective policy"; "records inaccessible channels without persisting metadata"; "fails closed and disables ingestion when Read Message History is lost" |
| Active and archived threads are discovered per permissions | `test/integration/thread-discovery.test.ts` — "identifies thread-capable parents and extracts active threads"; "paginates public then private until hasMore is false"; "skips private archived and flags coverage when Manage Threads is absent"; `test/integration/gateway-events.test.ts` — "THREAD_LIST_SYNC applies the supplied policy resolver to every thread" |
| Historical backfill finishes and marks per-channel completion | `test/integration/backfill.test.ts` — "pages newest-to-oldest and marks history_complete only at the true end"; "marks an empty channel complete on the first empty page"; "resumes from the durable cursor without gaps or duplicates" |
| New messages reach SQLite within normal Gateway latency | `test/integration/gateway-events.test.ts` — "MESSAGE_CREATE persists the message and indexes it for search"; `test/integration/message-ingest.test.ts` — "persists a message" (synchronous idempotent ingest; no queue sits between gateway and database) |
| Duplicate events do not duplicate rows | `test/integration/message-ingest.test.ts` — "is a no-op on an identical re-delivery (no updated_at bump, no FTS churn)"; `test/integration/backfill.test.ts` — "re-ingesting identical history creates no duplicate rows" |
| Restart reconciliation fills message gaps | `test/integration/reconciliation.test.ts` — "fills a short gap (within one page) up to the overlap"; "recovers a gap longer than one page by walking backward to the overlap"; "never tombstones messages absent from the fetched pages" |

## Storage

| Section 48 criterion | Tests that must pass |
| --- | --- |
| Database runs in WAL mode | `test/unit/database.test.ts` — "applies the canonical pragmas (Section 28)", which asserts `journal_mode` is `wal` |
| FTS returns permitted messages and memories | `test/integration/fts.test.ts` — "indexes live messages and keeps tombstones out"; `test/integration/scoped-message-search.test.ts` — "an org grant returns only org messages"; `test/integration/scoped-memory-search.test.ts` — "hides a channel-scoped memory from a grant that cannot see that channel" |
| Migrations are repeatable | `test/unit/migrations.test.ts` — "is idempotent on repeated runs (applies nothing new)"; "rejects a modified already-applied migration (checksum drift)" |
| Online backup and restore are tested | `test/integration/backup.test.ts` — "creates a standalone backup that opens independently"; "remains consistent when the same connection writes during the copy"; `test/chaos/backup-migration.test.ts` — "Section 46.5 — restore from backup (case 7)"; "restores a standalone snapshot: integrity ok, schema matches, migrations no-op, FTS intact" |
| Deletions follow the configured policy | `test/integration/deletion.test.ts` — "delete tombstones and removes content from FTS; blanking depends on retention"; `test/integration/forget-message.test.ts` — "invalidates a memory whose only evidence was the forgotten message" |

## Agent

| Section 48 criterion | Tests that must pass |
| --- | --- |
| Pi Agent Core runs with no shell or generic network tools | `test/integration/agent-runtime.test.ts` — "exposed tool surface — no forbidden tools"; "exposes only the six episode-run retrieval tools plus the terminal tool"; "blocks a shell tool and terminates the run (fail closed)" |
| Direct answers use distinct inventory and topical-search tools | `test/integration/scoped-memory-search.test.ts` — "keeps exact and surrounding-whitespace * as a filtered inventory compatibility alias"; `test/integration/mcp-memory-tools.test.ts` — "supports a bounded wildcard inventory without broadening token scope"; "rejects query input so topical retrieval stays in search_memories" |
| Catch-ups use one bounded, query-free, scope-bound activity snapshot | `test/integration/recent-activity-snapshot.test.ts` — "returns all 165 permitted messages across 11 org channels and excludes every unsafe row"; "uses exact inclusive-after/exclusive-before bounds"; "water-fills unused quotas and samples busy channels across time deterministically"; `test/unit/recent-activity-snapshot-tool.test.ts` — "requires explicit strict bounds and rejects unknown pagination inputs"; "clamps before to the immutable question time and records exact included provenance"; "allows only one successful snapshot and a second call changes no host state"; `test/integration/agent-runtime.test.ts` — "exposes the activity snapshot only to direct-answer runs" |
| Direct answers place host-built citations beside supported claims and report sampled coverage plainly | `test/unit/message-safety.test.ts` — "builds up to three trusted masked source links from cited ids"; `test/integration/direct-answer.test.ts` — "appends host-built masked source links for citations visible in the target"; "records partial snapshot coverage, requires a snapshot citation, and appends a footer"; `test/unit/prompt-templates.test.ts` — "direct-answer uses self-documentation and only host-built public links" |
| A broad memory inventory separates the exact permitted total from its bounded page | `test/unit/agent-tools.test.ts` — "browses top active permitted memories with the reserved wildcard query"; `test/integration/mcp-memory-tools.test.ts` — "lists visible memories with source links and never exposes review_only"; `test/integration/scoped-memory-search.test.ts` — "caps results at the hard limit" |
| Admin-requested deep recaps are durable, scoped, restart-safe, and budget-visible | `test/integration/deep-recap-command.test.ts` — "enforces admin, scope, window, budget, singleton, status, and cancellation bounds"; "keeps retries on one latest-leaf lineage with one immutable budget"; `test/integration/deep-recap.test.ts` — "chunks, synthesizes, cites inline, and records actual bounded coverage and spend"; "authorizes synthesis citations only from chunk-cited IDs rendered in its prompt"; "runs a safe retry from completed summaries without repeating chunk model calls"; `test/integration/startup-repair.test.ts` — "resets a stranded deep-recap chunk and restores one active owner idempotently"; "collapses duplicate deep-recap owners to one without resetting its running chunk"; `test/integration/admin-status.test.ts` — "counts only durably owned recap work as active and exposes recovery-needed requests"; `test/unit/migrations.test.ts` — "upgrades version 18 recap rows into explicit retry lineages"; "upgrades version 19 recap spend into timestamped model-call rows" |
| Direct questions never complete as a silent technical success | `test/integration/direct-answer.test.ts` — "turns prompt-preparation failures into a neutral fallback instead of silent job success"; "turns model-admission timeout into one neutral, source-anchored fallback"; "enqueues a neutral fallback when the run does not finalize"; "throws and leaves the request pending when fallback enqueue fails"; `test/integration/startup-repair.test.ts` — "recreates one active owner for a stranded pending direct request"; `test/unit/outbox.test.ts` — "uses a host response intent across runs and content variants"; `test/integration/admin-status.test.ts` — "reports rolling direct-answer outcomes, delivery state, and ingestion-to-send latency" |
| Direct-answer work preserves synthesis turns and interactive model access | `test/integration/agent-runtime.test.ts` — "returns a non-terminal finalize-now result at the direct-answer read boundary"; `test/unit/run-limits.test.ts` — "maps validated environment values to the exact RunLimits property names"; `test/unit/model-admission.test.ts` — "does not preempt an active background call and prefers direct answer at handoff"; "bounds direct-answer slot waiting with a content-free category"; `test/integration/job-worker.test.ts` — "claims a new direct answer while a campaign handler and background waiter are blocked"; "does not reclaim a locally active job after lease expiry but recovers another expired job"; `test/unit/production-runtime.test.ts` — "covers direct-answer admission plus model execution and completion bookkeeping" |
| Every memory proposal contains valid evidence | `test/unit/agent-schemas.test.ts` — "rejects a memory proposal missing evidence"; "rejects out-of-range scores"; "rejects an invalid enum value" |
| The host rejects invented, stale, or invisible evidence | `test/unit/outbound-evidence.test.ts` — "rejects an invented (non-existent) cited source"; `test/unit/provenance-gate.test.ts` — "pins the episode conversation channel for episode reviews"; `test/unit/message-safety.test.ts` — "rejects a model-authored Discord jump URL so only host-built links are sent"; "rejects Discord jump URLs after browser URL normalization"; `test/integration/direct-answer.test.ts` — "rejects a visible citation that was never exposed to the run"; "suppresses when a normal org source becomes ingestion-disabled during the run"; "suppresses when an org thread parent becomes ingestion-disabled during the run" |
| Prompt version is stored for every run | `test/unit/prompt-version.test.ts` — "produces a 64-character hex SHA-256"; `test/integration/episode-review.test.ts` — "a completed run stores prompt version, provenance, usage, proposal, and episode summary"; `test/integration/agent-runtime.test.ts` — "finalizes a successful run: completed status, accepted proposal, full audit, persisted row" |
| Provider or model failure never blocks ingestion | `test/integration/model-outage.test.ts` — "ModelBudgetGate end-to-end — outage fixture"; `test/integration/message-ingest.test.ts` — "persists a message" (message ingest has no model coupling) |

### Live model evaluation (optional, manual)

The routing of direct questions is also checked against a live model. This check
costs money and needs an OpenAI key. Run it before you change prompt routing:

```bash
RUN_LIVE_MODEL_EVALS=1 npx vitest run test/evals/direct-answer-planning.live.test.ts
```

Must pass: every semantic routing case in the file. Record: model name, reasoning
effort, date, and commit hash. Use the model and reasoning effort named in
`AGENTS.md`.

## Privacy

| Section 48 criterion | Tests that must pass |
| --- | --- |
| Restricted content cannot reach an org channel, including by paraphrase | `test/integration/privacy-matrix.test.ts` — "46.3 case 1 — a restricted fact is not returned to an org-scoped run"; "an org grant returns only org messages and never the restricted canary"; `test/integration/scoped-message-search.test.ts` — "honors explicit thread visibility overrides while anchoring restricted scope to the parent"; `test/integration/scoped-memory-search.test.ts` — "honors explicit thread visibility overrides and keeps the parent as restricted anchor"; `test/unit/provenance-gate.test.ts` — "pins the episode conversation channel for episode reviews" |
| Cross-restricted evidence becomes review-only | `test/unit/memory-scope.test.ts` — "collapses review_only when evidence spans multiple restricted channels"; `test/integration/privacy-matrix.test.ts` — "46.3 case 2 — cross-restricted evidence collapses to review_only" |
| Reclassifying a channel tightens dependent memory scopes on the next read | `test/integration/memory-rescope.test.ts` — "tightens a cached scope when its evidence channel is reclassified org→restricted"; `test/integration/scoped-memory-search.test.ts` — "CHANNEL RECLASSIFICATION tightens results immediately (no maintenance job)"; "quarantines thread evidence when its parent is disabled"; `test/integration/mcp-memory-tools.test.ts` — "hides a known memory id after its evidence channel is disabled" |
| Mention parsing is disabled | `test/unit/direct-mention.test.ts` — "never matches a textual lookalike when no mention entity is present" (entity-based only; textual parsing is off) |
| Logs contain no message text by default | `test/unit/logger.test.ts` — "redacts credentials, content, prompts, and nested secrets", which asserts that a private message body and system prompt contents stay out of logs |
| Admin actions are audited | `test/integration/admin-proposals.test.ts` — "denies an unauthorized approver and audits the denial (learns nothing)"; "audits the authorized read too" |

## Intervention

| Section 48 criterion | Tests that must pass |
| --- | --- |
| Current-work attention requires a validated subject and human trigger before routing | `test/integration/proactive-attention.test.ts` — "suppresses a recommendation without a subject or trigger, whatever its score"; "rejects a trigger that is not episode or follow-up material" |
| One material revision earns at most one actionable proposal, including across memory aliases | `test/integration/proactive-attention.test.ts` — "cannot propose twice from one revision"; "creates only one card when two subjects registered the same human event before either claimed it"; "admits a materially newer human development after an earlier card" |
| Explicit deadlines use verified source dates, preserve cancellations, and can become due once | `test/unit/deadline-evidence.test.ts` — "requires the selected date inside the quoted commitment"; "rejects conflicting dates in the same quote"; `test/integration/attention-deadlines.test.ts` — "keeps a cancellation barrier when an old set is re-extracted"; `test/integration/proactive-attention.test.ts` — "delivers a deadline-due revision through the full dispatch path" |
| Attention is rechecked at approval and delivery without denying an already-proven send | `test/integration/proactive-attention.test.ts` — "lets the owner approve and send inside the attention window"; "cancels an approved send before Discord I/O when the window ended"; "records an already-sent marker even when the attention window later ended" |
| Startup cutover prevents legacy replay and is safe to repeat | `test/integration/attention-cutover.test.ts` — "baselines surfaced legacy evidence as consumed so it cannot return as fresh"; "expires pending legacy proposals, cancels queued deliveries, and preserves sent rows"; "is a no-op on the second run" |
| Observe mode sends no unsolicited interventions | `test/integration/proposal-routing.test.ts` — "observe mode stores an eligible proposal without sending (observed)"; `test/integration/scheduled-review.test.ts` — "observe mode stores the notification observed" |
| Review mode requires authorized approval | `test/integration/proposal-routing.test.ts` — "review mode routes an eligible proposal to secure review (pending_review)"; `test/integration/proposal-approval.test.ts` — "recheckApprovalPolicy — current-state gate"; "blocks on an active cooldown" |
| Autonomous mode obeys score, confidence, evidence, cooldown, daily limit, visibility | `test/integration/proposal-routing.test.ts` — "autonomous mode approves an eligible proposal after every check passes"; `test/unit/intervention-score.test.ts` — "produces the Section 24.1 score for known fixtures"; `test/unit/cooldowns.test.ts` — "buckets two sends into the same org-day"; `test/integration/proposal-approval.test.ts` — "blocks on a definite evidence violation"; "blocks on a matched duplicate" |
| Outbox dedupe plus `sending`-state recovery prevents duplicate Discord messages after a crash | `test/integration/outbox-crash-recovery.test.ts` — "reconcileOutboxSending — confirms a sent match"; "reconcileOutboxSending — requeues only after a clean no-match"; `test/unit/outbound-duplicate.test.ts` — "normalizeForDuplicate" |
| Episode interventions place validated citations inline beside claims, quote one exact assembled text on cards, persistence, and delivery, and fail closed on an invalid marker or overflow | `test/integration/episode-review.test.ts` — "renders two validated episode citations inline beside their claims"; "keeps a markerless episode intervention on one compact Sources line"; "fails closed when an inline citation marker is unknown"; "fails closed when an inline citation marker is malformed"; "fails closed when a message uses more than three inline citation markers"; "fails closed when inserted source links push the assembled intervention past one Discord message"; "quotes the exact assembled deliverable on the pending-review card"; "autonomously enqueues the exact assembled text stored on the proposal" |

## MCP

| Section 48 criterion | Tests that must pass |
| --- | --- |
| With `MCP_ENABLED=false`, the MCP path returns `404` | `test/integration/mcp-server.test.ts` — "returns the identical 404 body for a disabled endpoint" |
| Tokens are hashed at rest, revocable, expirable, scope-limited | `test/unit/mcp-auth.test.ts` — "hashes the exact presented string with SHA-256 (hex)"; "reports an expired token once expires_at_ms has passed"; "reports a revoked token after revokeMcpToken"; "creates an org-scoped token and resolves it back to the same grant"; `test/integration/mcp-token-command.test.ts` — "returns the plaintext in the create reply and stores only the hash"; "rejects a review_only channel grant before writing any row" |
| MCP results never include `review_only` or out-of-scope restricted content | `test/integration/mcp-memory-tools.test.ts` — "review_only memory never surfaces under any MCP token"; "an org token sees only org memories"; "a channel token additionally sees its granted restricted channel memory" |
| Endpoint is stateless per the 2026-07-28 MCP spec and answers `server/discover` | `test/integration/mcp-discovery.test.ts` — "answers the very first request with capabilities and server identity"; `test/integration/mcp-server.test.ts` — "returns one JSON-RPC success with the result and no Mcp-Session-Id" |

## Deployment

| Section 48 criterion | Tests that must pass |
| --- | --- |
| The same image runs locally, on Coolify, and on Railway | One `Dockerfile` built by all three: `docker-compose.yml` (`build.dockerfile: Dockerfile`) and `railway.json` (`builder: DOCKERFILE`, `dockerfilePath: Dockerfile`); `test/unit/railway.test.ts` — "builds the repository Dockerfile" (see [Security model](../docs/explanation/security-model.md)) |
| `/app/data` persists through redeploy | Named volume `mneme_data` mounted at `/app/data`: `test/integration/compose.test.ts` — "mounts the named volume at /app/data"; "declares the named volume at the top level" (see [Deploy Mneme](../docs/how-to/deploy.md)) |
| `/livez` and `/readyz` behave as specified | `test/integration/health.test.ts` — "returns 200 ok when SQLite SELECT 1 succeeds"; "fails liveness (503) when the database is unavailable"; "stays live regardless of Discord or model state"; `test/integration/readiness.test.ts` — "is not ready at construction and names migrations as the first pending milestone"; `test/integration/healthcheck.test.ts` — "exits 0 when /livez returns a success status"; "exits 1 when /livez returns a non-success status" |
| SIGTERM performs graceful shutdown | `test/integration/shutdown.test.ts` — "runs the coordinator and exits zero on SIGTERM"; "ShutdownCoordinator — full ordered sequence"; "ignores a repeated signal (idempotent coordinator)"; "leaves an unfinished job recoverable when the drain deadline elapses" |
| Only one replica is active | `test/integration/compose.test.ts` — "defines exactly one application service"; `test/unit/railway.test.ts` — "declares no replica count" |

## Standing evidence

This document makes no claim about the current state of any criterion. The
standing automated evidence is the test suite: it runs on every pull request, and
the citation guard keeps this document tied to real tests. Re-verification is one
command:

```bash
npm run check && npm test
```
