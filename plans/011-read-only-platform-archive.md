# Plan 011: Read another platform's data as a frozen, read-only archive

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 034c5b0..HEAD -- src/db src/memory/search.ts src/memory/scope.ts src/agent src/mcp/tools.ts src/commands/deletion.ts src/jobs/handlers/execute-deletion.ts src/platform/links.ts src/outbound/message-safety.ts src/commands/status.ts src/http/inspector src/config.ts migrations MNEME_IMPLEMENTATION_SPEC.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. A new migration numbered `046` that
> another change added is always a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (5 pull requests)
- **Risk**: HIGH (a second database enters every retrieval path; deletion must reach it)
- **Depends on**: plans 002–010 (Slack support), v3.1.0 scope anchors
- **Category**: feature
- **Planned at**: commit `034c5b0`, 2026-10-07

## Why this matters

Steel moved from Discord to Slack. The Discord server is now read-only. The
Discord deployment holds about 73,000 messages and 485 memories that the team
still needs. One deployment serves one platform, and one database holds data
from one platform (spec §5.3). This plan keeps that rule for live data and adds
one defined exception: a deployment can read a **frozen, read-only archive** of
another deployment's database.

The archive is a verified Mneme backup file. Its data never changes, because
its source platform is read-only. The live deployment never migrates it and
never writes to it. Only `org` content from the archive is visible, because the
live platform's users do not map to the archive platform's channel members.
Deletion requests still reach archive content through a redaction overlay in
the live database.

## Decisions

These decisions are part of this plan. Change them only with the operator.

1. **One archive, set by two variables.** `MNEME_ARCHIVE_PATH` is the file path
   on the volume. `MNEME_ARCHIVE_PLATFORM` is `discord` or `slack`. Both are
   optional; set one without the other and startup stops. The archive has no
   platform column (decision 1 of plan 002), so the platform is explicit. The
   host checks that the archive's workspace id matches that platform's id
   format and stops on a mismatch. Alternative considered: infer the platform
   from the id format. Rejected: an explicit value fails closed when the file
   is the wrong one.
2. **Org-only, with no exception.** The archive grant is a constant:
   `{ includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] }`.
   The host recomputes effective scope from the archive's own channel rows on
   every read, with the existing SQL. Restricted, review-only, excluded, and
   channel-scoped content is never served — not to the secure review channel,
   not to an admin, not through MCP. Every archive query also requires
   `c.platform_boundary IS NULL`.
3. **Namespaced ids.** Every archive message and memory id that the host shows
   to the model or a client has the prefix `archive:` (for example
   `archive:1537480561600503948`). The prefix keeps archive ids apart from live
   ids in citations, exposure tracking, and deletion requests. The existing
   citation marker pattern (`[A-Za-z0-9._:-]{1,64}`) already accepts it.
4. **Archive evidence supports answers, not durable memory (v1).** A direct
   answer and an MCP client can read and cite the archive. A new live memory
   cannot cite archive evidence, and an archive memory can never be updated,
   superseded, or confirmed. Episode reviews and scheduled reviews can read the
   archive for context but cannot cite it in a proposal. Alternative
   considered: allow org memories with archive evidence. Rejected for v1: live
   memory evidence has foreign keys to live messages, and an archive redaction
   would then have to reach live memories too.
5. **Host-built archive links.** Archive links come from the archive platform's
   link builder and the archive's own workspace id (for Discord:
   `https://discord.com/channels/<guild>/<channel>/<message>`). The model never
   writes an archive URL. Outbound validation keeps rejecting model-authored
   Discord and Slack URLs; host-built archive links are added after that check,
   as host-built live links are today.
6. **Deletion through an overlay.** The archive file is read-only, so a
   deletion request for archive content adds rows to a live table
   `archive_redactions`. Every archive read filters them out in SQL. An offline
   command rewrites the archive file without the redacted rows when the
   operator wants the bytes gone. If the overlay cannot be read, archive reads
   fail closed (return nothing and log an error).
7. **Naming.** The code uses "platform archive" (`src/platform-archive/`)
   because "archive" already names archived memories (`listMemoryArchivePage`,
   `src/memory/search.ts:478`) and attachment archives.

## Current state

- `src/db/database.ts:15-23` — `CANONICAL_PRAGMAS` includes
  `'PRAGMA journal_mode = WAL'`. `openDatabase` (`:34-54`) runs every pragma,
  also when `readOnly` is true. On a read-only connection to a file in
  `DELETE` journal mode this throws `attempt to write a readonly database`
  (checked with Node 24 `node:sqlite` while writing this plan). Backups are
  written in `DELETE` mode (`src/db/backup.ts:157`). So the archive needs its
  own opener.
- `src/db/repositories/util.ts:4-28` — `prepareCached` keys its statement
  cache with a `WeakMap` on the connection. A second connection gets its own
  cache, so the existing repository functions can take the archive handle.
- `src/db/repositories/message-search.ts:24-33` — `RetrievalGrant` has
  `includeOrgMessages`, `includeOrgMemories`, `includeReviewOnly`, and
  `channelIds`. `channelVisibilityPredicate` (`:104-147`) builds the scope
  SQL from the channel rows; it does not check `platform_boundary`.
  `searchMessages(db, grant, input)` (`:216-220`) and `listRecentMessages`
  (`:311`) take the database handle as a parameter. Both build the link with
  the global `messageLink` (`:11`, `:298`, `:394`).
- `src/db/repositories/message-context.ts:8,73,85` — `getMessageContext` also
  uses the global `messageLink`.
- `src/platform/links.ts:5-21` — one module-level `active` builder, set by the
  adapter (`useMessageLinkBuilder`; Slack sets it at
  `src/platform/slack/platform.ts:99`). `discordMessageLink` is exported.
- `src/memory/search.ts:18` imports the global `messageLink`. The effective
  scope CTE (`:129-180`) recomputes scope from evidence channels;
  `effectiveScopeGrantPredicate` (`:183-195`) admits `eff.scope_type = 'org'`
  only when `grant.includeOrgMemories`. `searchMemories(db, grant, input)`
  (`:304-308`) takes the handle and an optional `statuses` filter.
- `src/agent/runtime.ts:278-288` — every run gets the same read-only tool list
  (`search_messages`, `list_recent_messages`, `get_message_context`,
  `search_memories`, `list_memories`, `get_memory_evidence`) plus run-specific
  tools and the terminal tool.
- `src/agent/memory-policy.ts:397` — a memory proposal's evidence id must be in
  `deps.exposedMessageIds`; this is the hook that must reject `archive:` ids.
- `src/outbound/message-safety.ts:69` — citation marker
  `/\[\[cite:([A-Za-z0-9._:-]{1,64})\]\]/gu`. `buildSourceLinks` (`:421-440`)
  builds every source link with the global `messageLink(guildId, …)`.
  `discordHost` (`:164-170`) and `containsSlackLink` (`:404-411`) reject
  model-authored platform URLs.
- `src/mcp/tools.ts:152-211` — MCP tools `search_messages`,
  `list_recent_messages`, `get_message_context`, `search_memories`,
  `list_memories`, `get_memory`, `get_memory_evidence`, `list_channels`.
- `migrations/040_deletion_requests.sql:5-6` — `target_kind` is
  `CHECK (target_kind IN ('user', 'message'))`; `target_id` is free text.
  `src/commands/deletion.ts:52-61` rejects a target that fails `isPlatformId`.
  Execution is `src/jobs/handlers/execute-deletion.ts`.
- `src/commands/status.ts:229` (`collectStatusReport`) and `:336`
  (`**Storage & scope**`); inspector pages are in `src/http/inspector/`.
- The last migration is `045_channel_private_thread.sql`.
- Spec: §5.3 "Platform adapters" (`MNEME_IMPLEMENTATION_SPEC.md:359`, the
  one-database rule at `:369-371`), §7 (`:552`), §22 agent tools (`:2900`),
  §30.3 message links (`:5056`), §32.5 MCP (`:5175`), §35 environment
  (`:5666`), §43 privacy (`:6612`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `npx vitest run test/unit/platform-archive test/integration/platform-archive` | exit 0 |
| Full verification | `npm run verify` | exit 0; no stray output |
| Documentation checks | `npm run docs:check-public && npm run docs:check-links` | exit 0 |
| Whitespace | `git diff --check` | exit 0, no output |

## Scope

**In scope**: `src/platform-archive/` (new), `src/config.ts`,
`src/db/repositories/message-search.ts`, `src/db/repositories/message-context.ts`,
`src/memory/search.ts`, `src/agent/runtime.ts`, `src/agent/run-context.ts`,
`src/agent/tools/` (new archive tools), `src/agent/memory-policy.ts`,
`src/outbound/message-safety.ts`, the direct-answer finalize path,
`src/mcp/tools.ts`, `src/commands/deletion.ts`,
`src/jobs/handlers/execute-deletion.ts`, `src/commands/status.ts`,
`src/http/inspector/`, `src/cli/commands.ts`, `prompts/` (archive labeling),
`migrations/046_archive_redactions.sql` (new), tests, the spec, `docs/`,
`.env.example`, `config/advanced.env.example`, `CHANGELOG.md`,
`plans/README.md`.

**Out of scope**:
- More than one archive, or an archive from the same platform as the live one
  (allowed by the design, not tested in v1 — reject it at startup).
- Writing to, migrating, or vacuuming the archive file in place.
- Archive evidence in durable memories, episode interventions, or scheduled
  notifications (decision 4).
- Mapping archive users to live users.
- Restricted archive content for anybody (decision 2).

## Git workflow

- One branch and one pull request for each part below (Parts A–E).
- Branch names: `advisor/011a-archive-open`, `advisor/011b-archive-read`,
  `advisor/011c-archive-cite-mcp`, `advisor/011d-archive-deletion`,
  `advisor/011e-archive-docs`.
- Conventional commits. Do not push or merge unless the operator says so.
- Each part ends with an independent security review before merge.

## Steps

### Part A — open and verify the archive

#### Step 1: Configuration

Add to `src/config.ts`: `MNEME_ARCHIVE_PATH` (absolute path, checked with
`rejectUnsafePath`) and `MNEME_ARCHIVE_PLATFORM` (`discord` | `slack`). Both
unset means no archive. One set without the other is a `ConfigError`. Reject
`MNEME_ARCHIVE_PLATFORM` equal to `MNEME_PLATFORM` (out of scope for v1).
Reject an archive path that equals `DATABASE_PATH` or sits in `BACKUP_DIR`
(retention could delete it). Add both to `.env.example` (commented),
`config/advanced.env.example`, and `docs/reference/configuration.md`.

**Verify**: config unit tests for each rule → pass.

#### Step 2: Archive opener and startup check

Create `src/platform-archive/database.ts`:

- `openArchiveDatabase(path)`: `new DatabaseSync(path, { readOnly: true,
  allowExtension: false })`, then only `PRAGMA query_only = ON`,
  `PRAGMA trusted_schema = OFF`, `PRAGMA foreign_keys = ON`. Do not call
  `openDatabase` (Current state: the WAL pragma throws).
- `verifyArchive(db, platform)` returns `{ platform, workspaceId, schemaVersion,
  sizeBytes, sha256, orgMessages, orgMemories }` or throws a clear error:
  `PRAGMA integrity_check` must be `ok`; `MAX(version)` from
  `schema_migrations` must be ≥ 45 and ≤ the newest migration this build knows;
  `workspaces` must have exactly one row; its id must match the platform's id
  format (`isDiscordId` for Discord, a Slack team id for Slack); the
  `journal_mode` must not be `wal` with a missing `-wal` file (refuse a hot
  copy; tell the operator to use a backup file).
- Compute `sha256` of the file once at startup (it identifies the archive in
  redaction rows and status).
- Bootstrap: when configured, open and verify after the live migrations and
  before the platform connects. A failure stops startup with the error text.
  Keep the handle on the bootstrap context (`ctx.platformArchive`).

Tests (`test/unit/platform-archive/database.test.ts`), using a seeded live
database written with `VACUUM INTO`: every write (`INSERT`, `UPDATE`,
`DELETE`, `CREATE TEMP TABLE`, `PRAGMA user_version = 1`) throws; schema 44
and schema "newest + 1" fail; zero or two workspace rows fail; a Slack id
with `MNEME_ARCHIVE_PLATFORM=discord` fails; a corrupt file fails.

**Verify**: `npx vitest run test/unit/platform-archive` → pass.

#### Step 3: Status and inspector

Add one status line under **Storage & scope**
(`src/commands/status.ts:336`): `Archive: discord · 287MB · schema 45 ·
73,264 messages (org n) · memories (org n) · sha256 first 12`. Add the same
facts to the inspector overview. No archive → `Archive: none`.

**Verify**: status tests with and without an archive → pass. Then the full
gate and an independent review of Part A.

### Part B — read the archive

#### Step 4: Redaction overlay (live database)

Add `migrations/046_archive_redactions.sql`:

```sql
CREATE TABLE archive_redactions (
  id TEXT PRIMARY KEY,
  archive_sha256 TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('user', 'message')),
  target_id TEXT NOT NULL,
  deletion_request_id TEXT REFERENCES deletion_requests(id),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (archive_sha256, target_kind, target_id)
);
```

Add `src/platform-archive/redactions.ts`: `loadRedactions(liveDb, sha256)`
returns `{ messageIds: string[], userIds: string[] }`. Archive queries pass
them as JSON parameters and filter with
`m.id NOT IN (SELECT value FROM json_each(?))` and
`m.author_id NOT IN (SELECT value FROM json_each(?))` (checked: `json_each`
works on a read-only connection). If loading throws, the read returns no rows
and logs `platform_archive.redactions_unavailable`.

**Verify**: repository tests → pass.

#### Step 5: Archive read functions

Give `searchMessages`, `listRecentMessages`, `getMessageContext`, and the
memory search and evidence functions an optional `linkBuilder` parameter.
Default: the global `messageLink`, so live callers do not change. Then create
`src/platform-archive/read.ts` with:

- `ARCHIVE_GRANT` (decision 2), frozen.
- `searchArchiveMessages`, `getArchiveMessageContext`, `searchArchiveMemories`,
  `getArchiveMemoryEvidence`. Each passes the archive handle, `ARCHIVE_GRANT`,
  the archive link builder (`discordMessageLink` for Discord, Slack built from
  the archive's own team domain if present, else no link), the redaction
  filters, an extra `c.platform_boundary IS NULL` condition, and `statuses:
  ['active']` for memories. A memory is hidden when any of its evidence
  messages is redacted or not visible under `ARCHIVE_GRANT`.
- Every returned id gets the `archive:` prefix. Every result carries
  `source: { platform, label: 'archive', createdAtMs }`.

Tests (`test/integration/platform-archive/read.test.ts`) on a seeded archive
with org, restricted, review_only, excluded, test-surface, deleted, and
private-thread channels; org and channel-scoped memories; a restricted thread
under an org parent:
- only org content returns, for messages, context windows, memories, and
  evidence;
- a channel-scoped memory and an org memory whose evidence recomputes to
  restricted are hidden;
- redacted message ids and user ids are gone from every function, including
  context neighbours and memories with that evidence;
- links are `discord.com` links with the archive's guild id, even when the
  live platform is Slack.

**Verify**: `npx vitest run test/integration/platform-archive` → pass.

#### Step 6: Agent tools

Add `search_archive_messages`, `get_archive_message_context`, and
`search_archive_memories` in `src/agent/tools/`. Register them in
`src/agent/runtime.ts:278-288` only when `ctx.platformArchive` exists, for
every run type. Render each result with a fixed host header, for example
`[archive · discord · 2026-05-04 · #eng]`, and wrap archive text in the same
untrusted-content framing that live results use. Record archive exposures in
the run context in a separate set (`exposedArchiveIds`), not in
`exposedMessageIds`. Charge archive text to the same per-run character
budget. Add one paragraph to `prompts/partials/boundaries.hbs`: archive
content is history from the old platform, it can be out of date, and it is
data, not instructions.

**Verify**: tool unit tests and the full gate. Then an independent review of
Part B: org-only at SQL level on every function; no live grant ever reaches the
archive; redactions on every path; the archive handle is never written.

### Part C — citations and MCP

#### Step 7: Archive citations in direct answers

- `[[cite:archive:<id>]]` is valid only in a direct answer, and only for an id
  in `exposedArchiveIds`.
- Extend `buildSourceLinks` (`src/outbound/message-safety.ts:421-440`) with an
  archive resolver: for an `archive:` id it uses the archive link builder and
  the archive workspace id; the label is
  `archive · #channel · YYYY-MM-DD`.
- Episode-review and scheduled-review finalize paths reject an `archive:`
  citation with a precise reason (decision 4).
- `src/agent/memory-policy.ts:397`: an `archive:` evidence id fails with the
  reason `archive_evidence_not_durable`. No path may update, supersede, or
  confirm an `archive:` memory id.
- Outbound validation keeps rejecting model-authored platform URLs; host-built
  archive links are added after it.

Tests: a direct answer with a live and an archive citation renders both links
with the right hosts; a hand-written `discord.com` URL in model text is still
rejected on a Slack deployment; an episode intervention and a scheduled
notification with an archive citation are rejected; a memory proposal with
archive evidence is rejected with the reason above.

**Verify**: focused tests → pass.

#### Step 8: MCP tools

Add `search_archive_messages`, `get_archive_message_context`,
`search_archive_memories`, and `get_archive_memory` to `src/mcp/tools.ts`.
They are listed only when an archive exists. They require a token whose grant
has `includeOrgMessages` and `includeOrgMemories`; a channel-scoped token gets
the existing permission error. They always use `ARCHIVE_GRANT`, never the
token's `channelIds`. Responses carry `source.platform`, the `archive:` ids,
and host-built links.

**Verify**: MCP integration tests for an org token, a channel token, and no
archive → pass. Then an independent review of Part C.

### Part D — deletion

#### Step 9: Deletion requests for archive targets

- `requestDeletion` (`src/commands/deletion.ts:52-61`) accepts
  `archive:<id>` for `message` and `user` targets. The id after the prefix must
  pass the archive platform's id check, and an archive must be configured.
- `execute-deletion` writes one `archive_redactions` row for an archive target,
  with the current archive `sha256` and the request id. It does not touch live
  tables for an archive target, and a live target never writes a redaction.
- The status and the deletion reply name the target as an archive target.
- Add `/mneme` help text and `docs/reference/commands.md` wording.

Tests: an archive message and an archive user disappear from every archive
read function and MCP tool right after execution; the cancellable grace period
and independent approval rules apply unchanged; a request for an archive target
fails cleanly when no archive is configured.

**Verify**: focused tests → pass.

#### Step 10: Offline archive rewrite

Add CLI `node dist/cli/commands.js archive-rewrite --out <path>`:

1. Copy the archive with `VACUUM INTO <out>.tmp` from a read-only handle.
2. On the copy, delete the redacted messages and their revisions, reactions,
   attachments rows, tombstones, memory evidence, and memories left without
   evidence; rebuild FTS; `VACUUM`; `PRAGMA integrity_check`.
3. Rename to `<out>` and print the new `sha256`.

The operator then points `MNEME_ARCHIVE_PATH` at the new file and restarts.
On startup, redaction rows whose `archive_sha256` differs from the current
archive are kept but ignored; document that the operator rewrites only after
every pending archive deletion has executed.

**Verify**: CLI test: rewrite, reopen, confirm the redacted rows are absent and
`verifyArchive` passes. Then an independent review of Part D.

### Part E — spec, docs, and the migration guide

#### Step 11: Spec

- §5.3: keep "one database holds data from one platform" for live data; add a
  reference to the new section.
- New section after §7 (for example §7.5 "Read-only platform archive"):
  decisions 1–6 as rules.
- §22: the three archive agent tools; §30.3: archive links; §32.5: the four
  MCP tools; §35: the two variables; §43: archive deletion and the rewrite
  command; §29: `archive_redactions`.

#### Step 12: Documentation

- New `docs/how-to/move-to-slack-with-archive.md`:
  1. Stop new work on the old deployment: set `MNEME_MODE=observe`.
  2. Run `/mneme backup` and wait for `integrity_check: ok`.
  3. Copy that backup file to the new deployment's volume (for Railway: a
     one-off `railway ssh` copy through a temporary file, or a storage bucket;
     give exact commands checked against the Railway CLI help).
  4. Set `MNEME_ARCHIVE_PATH` and `MNEME_ARCHIVE_PLATFORM=discord` on the Slack
     deployment and restart. Check the `Archive:` status line.
  5. Shut down the old deployment. Keep its last backup offline as well.
- `docs/reference/configuration.md`, `docs/explanation/security-model.md`
  (org-only archive, redaction overlay), `docs/reference/http-and-mcp.md`,
  `docs/reference/commands.md`, `CHANGELOG.md` (Unreleased, Added).

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0.

#### Step 13: Gate

**Verify**:
- `npm run verify` → exit 0, no stray output.
- `git diff --check` → no output.
- Update this plan's row in `plans/README.md` to `DONE`.

## Test plan

- Read-only: every write form throws on the archive handle (Step 2).
- Visibility: only org content, at SQL level, for messages, context, memories,
  evidence, agent tools, and MCP (Steps 5, 6, 8).
- Fail closed: unknown schema, wrong platform, two workspaces, corrupt file,
  hot WAL copy, unreadable redaction overlay (Steps 2, 4).
- Redaction: message and user targets vanish from every archive path, and the
  rewrite removes the bytes (Steps 9, 10).
- Citations: archive links only host-built, only in direct answers, never as
  durable memory evidence (Step 7).
- Regression: with no archive configured, every existing test passes unchanged.

## Done criteria

- [ ] A Slack deployment with `MNEME_ARCHIVE_PATH` set starts, reports the
      archive in status, and answers from archive org content with
      `discord.com` links.
- [ ] No restricted, review-only, excluded, channel-scoped, test-surface,
      deleted, or redacted archive content reaches any tool, MCP client, or
      outbound message.
- [ ] The archive file's bytes and `sha256` do not change while Mneme runs.
- [ ] Archive deletion requests work through the existing approval flow; the
      rewrite command removes redacted rows from a new file.
- [ ] Spec, docs, and the migration guide match.
- [ ] Each part passed an independent security review.
- [ ] `npm run verify` exits 0.

## STOP conditions

Stop and report back without improvising if:

- A repository function needed in Step 5 cannot take a second database handle
  without changing live behavior.
- The archive's effective-scope recomputation needs a table or column that
  schema 45 does not have.
- An archive read path needs a live grant, a live channel id, or the live
  `messageLink` to work.
- The deletion approval flow cannot carry an `archive:` target without
  changing `migrations/040_deletion_requests.sql` behavior for live targets.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- A later schema change that renames a table or column used by archive reads
  must keep reading schema 45 archives, or raise the minimum archive schema
  and document the upgrade path (restore the archive into an old build, apply
  migrations, back it up again).
- When decision 4 changes (archive evidence in durable memory), the redaction
  overlay must also reach live memories that cite archive evidence.
- Reviewers should check every new query on the archive handle for
  `ARCHIVE_GRANT`, the redaction filters, and `platform_boundary IS NULL`.
- Open questions for the operator: should episode and scheduled reviews cite
  the archive later (v2)? Should admins get an archive user lookup to find a
  Discord user id for a deletion request from Slack?
