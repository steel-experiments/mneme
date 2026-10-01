# Architecture

This is the map for contributors: what lives where, and how the pieces connect.
The operator-level explanation is
[docs/explanation/architecture.md](../docs/explanation/architecture.md). The
normative depth is `MNEME_IMPLEMENTATION_SPEC.md`; every section below names
its spec area.

## One process

Mneme is one long-running Node.js process with three external boundaries:
the Discord gateway, a model provider, and one HTTP server. There is no queue
service, no cache, no sidecar, and no second writer. Recovery comes from durable
state and reconciliation, not from replicas. A deployment runs exactly one
process against one database (`src/bootstrap.ts`, `src/main.ts`).

Startup is ordered to avoid message gaps: open SQLite and migrate, start the
HTTP server, compile prompts and validate policy, register Discord handlers,
connect the gateway, register commands, discover channels and threads, queue
backfill, then start job workers. If startup fails after a resource is
acquired, bootstrap unwinds in reverse.

## Storage: node:sqlite plus FTS5

One SQLite database in WAL mode. STRICT tables, prepared statements, foreign
keys on, extension loading off (`src/db/database.ts`). Full-text search uses the
bundled FTS5 module, with deleted content kept out of the index
(`src/db/fts-query.ts`, migration `004_fts.sql`).

Schema changes live in `migrations/` as numbered, immutable, forward-only SQL
files. The runner records a SHA-256 checksum per applied file and refuses to
start on drift (`src/db/migrations.ts`). See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the rules.

Queries live in `src/db/repositories/`, one module per table family. Domain
code goes through repositories, not raw SQL.

## The pipeline: ingest to episode to memory

1. **Ingest.** Gateway events are normalized and written synchronously to
   SQLite — there is no queue between the gateway and the database
   (`src/discord/ingest.ts`, `normalize.ts`). Upserts are idempotent, so a
   re-delivered event writes nothing. Backfill walks history newest-to-oldest
   with a durable cursor (`src/discord/backfill.ts`). Reconciliation fills gaps
   found after a restart (`src/discord/reconcile.ts`), and ingestion recovery
   covers gateway outages (`src/db/repositories/ingestion-recovery.ts`).
2. **Episodes.** Each channel or thread holds one open episode. Quiet time,
   message count, or elapsed time closes it (`src/episodes/builder.ts`) and
   queues the close-episode job.
3. **Memory.** The review-episode job runs the agent over a closed episode. The
   model returns structured proposals with cited evidence. The host validates
   the schema and the evidence, computes the memory scope from its evidence
   channels, and writes memory rows (`src/agent/`, `src/memory/`). Evidence
   that spans restricted channels collapses to `review_only`
   (`src/memory/scope.ts`).

## The job queue

Durable jobs in SQLite with leases, claimed by one worker loop
(`src/jobs/queue.ts`, `worker.ts`). A scheduler queues periodic work;
`startup-repair.ts` recovers stranded owners after a crash. Handlers live in
`src/jobs/handlers/`: backfill, reconcile, recover-message, close-episode,
review-episode, review-due-memories, rescope-memories, direct-answer,
deep-recap, backup-database, maintenance, forget-user, attachment archive and
purge, expire-proposals, and historical episode builds.

Discord delivery is separate: approved proposals go to an outbox first, and the
outbox worker sends them (`src/outbox/`). Crash recovery reconciles the
`sending` state so a crash cannot duplicate a message.

## Policy and visibility

`src/discord/channel-policy.ts` resolves every channel to a rule. Resolution
order, most specific first:

1. an explicit channel rule;
2. the thread parent's resolved class — a thread inherits its parent;
3. the parent category rule;
4. `default`, which is fail-closed: not ingested, restricted, no interventions.

Two sources build the policy. `CHANNEL_POLICY_SOURCE=basic` (the default)
translates the two selection lists, `ORG_VISIBLE_CHANNEL_IDS` and
`RESTRICTED_CHANNEL_IDS`, into a policy at startup
(`src/discord/channel-policy-bootstrap.ts`). `file` loads the full YAML at
`CHANNEL_POLICY_PATH`, which supports explicit thread overrides in both
directions. Basic mode needs at least one id in the two lists and fails at
startup when both are empty; it never consults stored review decisions. In
file mode, `/mneme reload-policy` applies changes live. In basic mode,
changes take effect after a restart. The host recomputes memory
scopes from live policy on every read, so a reclassification tightens results
immediately, without a maintenance job.

## The agent runtime

The model proposes; the host validates and acts. The runtime
(`src/agent/runtime.ts`) runs Pi Agent Core with nine read-only retrieval
tools plus the terminal proposal tool. The nine are `search_messages`,
`list_recent_messages`, `get_message_context`, `list_memories`,
`search_memories`, `get_memory_evidence`, `get_recent_activity_snapshot`,
`list_docs`, and `read_doc`. Episode and scheduled runs see the first six;
direct-answer runs also see the activity snapshot and the two documentation
tools. No shell, no browser, no filesystem, no general network client. A
forbidden tool fails the whole run: fail closed.

Model admission (`src/agent/model-admission.ts`) splits work into `direct_answer`
and `background` classes and bounds how long an interactive request may wait
for a provider slot. The budget gate (`src/agent/budget.ts`) enforces the daily
USD admission limit and a provider outage window. Discord ingestion never
depends on the provider: an outage or an exhausted budget pauses model work
only, and recovery is automatic.

## HTTP surfaces

One `node:http` server on `0.0.0.0:$PORT` (`src/http/server.ts`). Disabled
surfaces return the same 404 body as an unknown route, so their existence is
not discoverable.

| Surface | Auth | Module |
| --- | --- | --- |
| `/livez`, `/readyz` | none, minimal output | `src/http/health.ts` |
| `/status` | admin bearer token (`HTTP_ADMIN_TOKEN`); 404 while unset | `src/http/status.ts` |
| `/mcp` | scoped MCP bearer token, hashed at rest, rate-limited | `src/mcp/` |
| OAuth discovery, `/authorize`, `/token` | RFC 9728/8414 metadata, Discord sign-in, PKCE | `src/mcp/oauth/` |
| Inspector | its own hashed bearer token, read-only pages | `src/http/inspector/` |

## Failure posture

- **Fail closed.** When a check cannot run, the answer is the restricted
  default, not the open one. Unknown channels, lost permissions, and failed
  validations all land closed.
- **Silence is success.** Most episodes produce no message. A no-send outcome
  is recorded, not treated as an error.
- **Forward-only migrations.** No down path. State moves one direction, so an
  upgrade is a deliberate operator action.
- **One writer.** The singleton rule is load-bearing: one Discord client, one
  job runtime, one HTTP server, one SQLite writer.

## Source map

| Directory | Role |
| --- | --- |
| `src/agent/` | agent runtime, tools, admission, budgets, prompts, schemas |
| `src/cli/` | `migrate`, `backup`, `integrity-check` commands |
| `src/db/` | database, migrations, FTS, backup, repositories |
| `src/deep-recap/`, `src/historical/` | durable recap and historical episode work |
| `src/discord/` | client, policy, ingest, backfill, reconcile, commands, review UI |
| `src/episodes/` | episode build, prefilter, repository |
| `src/http/`, `src/mcp/` | HTTP server, health, status, Inspector, MCP, OAuth |
| `src/jobs/` | durable queue, worker, scheduler, startup repair, handlers |
| `src/memory/` | memory repository, scope, search, maintenance, scheduled delivery |
| `src/outbox/` | proposal delivery with crash recovery |
| `src/review/` | review workflow |
| `src/fixture-mode.ts` | offline synthetic run used by CI and the release smoke test |

For the normative detail behind any row, start from the spec's table of
contents, then the module header comment — each module cites the sections it
implements.
