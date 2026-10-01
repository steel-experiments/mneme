# Plan 004: Make names, ids, and links platform-neutral (Discord only)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cc84413..HEAD -- migrations src/config.ts src/db src/discord/sender.ts src/discord/message-safety.ts src/discord/attachments.ts src/discord/channel-policy.ts src/discord/channel-policy-bootstrap.ts src/discord/client.ts src/discord/commands/deletion.ts src/outbox src/agent/prompts.ts src/http/inspector src/mcp/tools.ts src/memory/search.ts src/jobs/handlers MNEME_IMPLEMENTATION_SPEC.md test/unit/migrations.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. A new migration numbered `041` that
> another change added is always a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (mechanical, but it touches about 60 source files and 40 test files)
- **Risk**: MED (a wrong rename in a raw Discord payload breaks ingestion)
- **Depends on**: plan 003
- **Category**: refactor
- **Planned at**: commit `cc84413`, 2026-10-01

## Why this matters

Plan 002 decision 16 renames Discord words in the shared schema and core types,
so a Slack deployment does not store a Slack team id in a column named
`guild_id`. Decisions 5 and 8 put the id check and the message-link builder in
one place each, so plan 005 can move each one behind the adapter in one edit.
This plan changes names and moves code. It does not change behavior: the id
rule stays "17–20 digits", the links stay `discord.com` links, and every error
message stays the same. The full test suite is the proof.

## Current state

### Schema

- Migrations are immutable. `CONTRIBUTING.md` ("Database migrations are
  immutable"): add a new numbered file; never edit an applied file. The runner
  (`src/db/migrations.ts:148-153`) runs each file in one transaction and stores a
  SHA-256 checksum. The last migration is `040_deletion_requests.sql`.
- `node:sqlite` bundles SQLite 3.53.3 (checked with
  `node -e "…sqlite_version()"`). `ALTER TABLE … RENAME COLUMN` (3.25+) rewrites
  indexes, triggers, and views that name the column. `ALTER TABLE … RENAME TO`
  (3.26+, with `legacy_alter_table` off, the default) rewrites `REFERENCES`
  clauses in other tables. `src/db/database.ts:16` sets `PRAGMA foreign_keys = ON`.
- The FTS5 tables and triggers (`migrations/004_fts.sql:5-70`) do not name
  `guild_id` or `discord_message_id`.
- Tables and columns to rename:

  | Migration:line | Table | Column |
  |---|---|---|
  | `001_core.sql:13` | `guilds` (table) | — |
  | `001_core.sql:25` | `channels` | `guild_id` |
  | `001_core.sql:63-69` | `guild_members` (table) | `guild_id` (in the primary key) |
  | `001_core.sql:74` | `messages` | `guild_id` |
  | `002_memory.sql:7` | `episodes` | `guild_id` |
  | `002_memory.sql:38` | `memories` | `guild_id` |
  | `003_operations.sql:6` | `agent_runs` | `guild_id` |
  | `003_operations.sql:60` | `outbox` | `discord_message_id` |
  | `003_operations.sql:114` | `admin_events` | `guild_id` |
  | `006_message_tombstones.sql:6` | `message_tombstones` | `guild_id` (nullable, no FK) |
  | `012_historical_campaigns.sql:10` | `historical_memory_campaigns` | `guild_id` |
  | `016_direct_answer_requests.sql:12` | `direct_answer_requests` | `guild_id` |
  | `018_deep_recaps.sql:3` | `deep_recap_requests` | `guild_id` |
  | `022_channel_policy_reviews.sql:3` | `channel_policy_reviews` | `guild_id` |
  | `037_ingestion_recovery.sql:9` | `ingestion_recovery_requests` | `guild_id` (no FK) |
  | `038_proactive_attention.sql:8` | `attention_subjects` | `guild_id` |
  | `040_deletion_requests.sql:4` | `deletion_requests` | `guild_id` |

- Index names that contain the old words: `channels_guild_idx`
  (`001_core.sql:47`), `channel_policy_reviews_guild_status_idx`
  (`022_channel_policy_reviews.sql:36`),
  `attention_subjects_guild_idx` (`038_proactive_attention.sql:14`),
  `outbox_discord_message_idx` (`031_scheduled_review_routing.sql:32-34`). No
  code uses these names in `INDEXED BY` (checked with
  `git grep -n "INDEXED BY" src test`).
- `test/unit/migrations.test.ts` lists every migration file (line 74) and has
  upgrade tests that copy the migrations, delete the newest files, and then
  apply the full set (for example lines 268–276 delete `039` and `040`). With a
  new `041`, these tests run the rename; any assertion that reads `guild_id`
  after the full set must change.

### Code that uses the old names

- `guild_id`: 353 occurrences in `src` and `test`, in 46 `src` files. Most are
  SQL text and DB row properties (`row.guild_id`).
- **Raw Discord payloads also use `guild_id`. They must not change.** These
  build or read the Discord REST shape that `normalizeMessage` accepts:
  `src/discord/client.ts:501, 540, 574, 581, 610, 742, 750, 783` (and the
  `r.guild_id` reads at `:761-776` of the reaction payload), `src/discord/normalize.ts`
  (reads of the raw payload), and `test/fixtures/messages/create.json`.
  discord.js object properties such as `message.guildId`, `interaction.guildId`,
  and `channel.guildId` (for example `src/discord/client.ts:72, 693`,
  `src/discord/channel-policy-review-interactions.ts:200`) also stay.
- `guildId` (TypeScript): 466 occurrences in `src` (281 outside `src/discord/`)
  and 749 in `test`. This plan does **not** rename the `guildId` TypeScript
  identifiers, except the config field below. Plan 005 introduces the core
  types and `workspaceId` from the adapter; it renames them there.
- `src/config.ts:62-66`:

  ```ts
  export interface DiscordConfig {
    token: string;
    applicationId: string;
    guildId: string;
  }
  ```

  Loaded at `src/config.ts:774`:
  `const guildId = parseSnowflake(env(e, 'DISCORD_GUILD_ID'), 'DISCORD_GUILD_ID');`.
  `config.discord.guildId` has 39 uses in 4 files
  (`git grep -c "discord.guildId" src`).
- `discord_message_id` / `discordMessageId`: 38 uses in `src`, in
  `src/db/repositories/channel-policy-reviews.ts`, `src/discord/review-message.ts`,
  `src/discord/sender.ts`, `src/memory/scheduled-feedback.ts`,
  `src/outbox/proposal-delivery.ts`, `src/outbox/recovery.ts`,
  `src/outbox/repository.ts`, `src/outbox/worker.ts`, `src/production-runtime.ts`.
  `src/discord/sender.ts:22-25`:

  ```ts
  export interface SendResult {
    /** The Discord snowflake of the created message. */
    discordMessageId: string;
  }
  ```

- `discordLink`: declared in `src/db/repositories/message-search.ts:77, 90`,
  `src/db/repositories/message-context.ts:44`, `src/memory/search.ts:639`,
  `src/jobs/handlers/direct-answer.ts:131`, `src/http/inspector/queries.ts:547, 895`.
  Read in `src/agent/tools/{get-memory-evidence.ts:36, list-recent-messages.ts:32, search-messages.ts:38}`,
  `src/mcp/tools.ts:404, 413, 458, 600, 627, 669`,
  `src/discord/commands/memory-search.ts:209`, and
  `src/http/inspector/pages.ts:323, 425, 612`. `src/jobs/handlers/review-episode.ts:796`
  already uses the name `link`. The agent tools and the direct-answer payload
  send this key to the model (spec line 2310 names `discordLink`).

### The five `discord.com` link builders

- `src/db/repositories/message-search.ts:93-100` — `discordMessageLink(guildId, channelId, messageId)`.
  Callers: `message-context.ts:73`, `message-search.ts:304, 400`,
  `memory/search.ts:726`, `jobs/handlers/direct-answer.ts:220`,
  `jobs/handlers/review-episode.ts:870, 963`, `http/inspector/pages.ts:983`.
- `src/discord/message-safety.ts:432-435` — `sourceLinkUrl(guildId, channelId, messageId)`.
  Callers: `message-safety.ts:459`, `src/production-runtime.ts:1615`.
- `src/agent/prompts.ts:67-76` — `messageLinkHelper`, the Handlebars
  `messageLink` helper. It returns `''` unless all three ids are non-empty
  strings, then builds the URL.
- `src/http/inspector/queries.ts:608` and `:939` — two inline template strings.
- `src/discord/message-safety.ts:115, 180-183` check model-authored URLs against
  the `discord.com` host. They are not link builders; plan 005 moves them into
  the adapter format object. Do not change them here.

### The `/^\d{17,20}$/` id checks

- `src/config.ts:44` `SNOWFLAKE_RE`, used by `parseSnowflake` (`:517-524`, error
  text `expected a Discord snowflake (17–20 digits)`) and `parseSnowflakeList`
  (`:549-561`, error text `list contains a non-snowflake value`).
- `src/discord/attachments.ts:84` `SNOWFLAKE_RE`, used at `:170` for the archive path.
- `src/discord/channel-policy-bootstrap.ts:34` `SNOWFLAKE_RE`, used at `:67, :76`.
- `src/discord/channel-policy.ts:92` and `:123` (inline).
- `src/discord/client.ts:658` (`validId`, inline).
- `src/discord/commands/deletion.ts:57` (inline).
- **Not id checks — leave them**: the mention patterns
  `src/agent/policy.ts:530` (`INDIVIDUAL_MENTION`) and
  `src/discord/message-safety.ts:94-95` (`USER_MENTION`, `ROLE_MENTION`). They
  are Discord mention syntax; plan 005 moves them into the format object.
- `src/discord/normalize.ts:134-141` `snowflakeToMs` already lives in Discord
  code. Its only caller is `normalize.ts:240` (and `test/unit/normalize.test.ts`).
  It needs no change.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Migration tests | `npx vitest run test/unit/migrations.test.ts` | exit 0 |
| Outbox tests | `npx vitest run test/unit/outbox.test.ts test/integration/outbox-send.test.ts test/integration/outbox-crash-recovery.test.ts` | exit 0 |
| Link and prompt tests | `npx vitest run test/unit/message-safety.test.ts test/unit/prompts.test.ts test/integration/scoped-message-search.test.ts test/integration/message-context.test.ts` | exit 0 |
| Leftover names | `git grep -n "guild_id\|discord_message_id\|discordLink\|discordMessageId" src test` | only the protected raw-payload sites listed above |
| Leftover builders | `git grep -n "discord.com/channels" src` | one hit, in `src/platform/links.ts` |
| Leftover id checks | `git grep -n -F '\d{17,20}' src` | hits only in `src/platform/ids.ts` and the three mention patterns |
| Typecheck | `npm run check && npm run check:test` | exit 0 |
| Full verification | `npm run verify` | exit 0 |

## Scope

**In scope**:

- `migrations/041_platform_neutral_names.sql` (new)
- New `src/platform/links.ts` and `src/platform/ids.ts`
- Every `src/` file that uses the schema names, `discordMessageId`,
  `discordLink`, `config.discord.guildId`, a link builder, or an id check listed
  in "Current state"
- The matching tests in `test/` (including `test/fixtures/discord/synthetic-adapter.ts`
  for `discordMessageId`)
- `MNEME_IMPLEMENTATION_SPEC.md` (§10.1 line 1188, line 1267, line 2310, §29
  schema, §30.3, §32.5, and the remaining `guild_id` lines found by
  `grep -n "guild_id" MNEME_IMPLEMENTATION_SPEC.md`)
- `plans/README.md` (status update only)

**Out of scope** (do not touch):

- Applied migration files `001`–`040`.
- Raw Discord payload fields and discord.js properties listed under "Raw Discord
  payloads also use `guild_id`".
- TypeScript `guildId` identifiers other than `config.discord.guildId`
  (plan 005).
- Env var names. `DISCORD_GUILD_ID` stays until plan 005/006 adds platform
  selection.
- The mention patterns, the `discord.com` host allowlist, and every
  user-visible text such as "Open in Discord" (plan 005).
- `docs/` (plan 010).

## Git workflow

- Branch: `advisor/004-platform-neutral-names-ids-links`
- One commit for each step, conventional style, for example
  `refactor(db): rename guild columns to workspace`,
  `refactor(outbox): rename discord_message_id to platform_message_id`,
  `refactor: build message links in one place`,
  `refactor: validate platform ids in one place`.
- Do not push or open a PR unless the operator instructs you.

## Steps

Do not use a repository-wide search-and-replace. Edit file by file. For each
file, check every hit against the protected list before you change it.

### Step 1: Add migration 041

Create `migrations/041_platform_neutral_names.sql`. The top comment states what
it does and cites spec §29 and plan 002 decision 16. Content:

1. `ALTER TABLE guilds RENAME TO workspaces;`
2. `ALTER TABLE guild_members RENAME TO workspace_members;`
3. `ALTER TABLE <table> RENAME COLUMN guild_id TO workspace_id;` for each of the
   15 tables in the table above (including `workspace_members`).
4. `ALTER TABLE outbox RENAME COLUMN discord_message_id TO platform_message_id;`
5. Rename the four indexes: for each, `DROP INDEX` and `CREATE INDEX` with the
   new name and the same definition, read from the live schema after steps 3–4
   (`SELECT sql FROM sqlite_master WHERE name = '<old>'`). New names:
   `channels_workspace_idx`, `channel_policy_reviews_workspace_status_idx`,
   `attention_subjects_workspace_idx`, `outbox_platform_message_idx`.

Add `'041_platform_neutral_names.sql'` to the list at
`test/unit/migrations.test.ts:74`. Add one test in that file that applies all
migrations to a database seeded at version 40 with one row in each renamed
table, then asserts:

- `PRAGMA table_info(<table>)` shows `workspace_id` and no `guild_id`;
- `PRAGMA foreign_key_check` returns no rows;
- the foreign keys of `channels` point at `workspaces`
  (`PRAGMA foreign_key_list(channels)`);
- an insert into `messages` still updates `messages_fts` (the FTS triggers work);
- the four new index names exist and the old ones do not.

Fix the existing upgrade tests that read `guild_id` after the full set.

**Verify**: `npx vitest run test/unit/migrations.test.ts` → exit 0.

### Step 2: Update SQL text and DB row properties

In every `src/` file that `git grep -l "guild_id\|FROM guilds\|INTO guilds\|guild_members" src`
lists, change SQL text and DB row types from `guild_id` to `workspace_id`,
`guilds` to `workspaces`, and `guild_members` to `workspace_members`. This
includes `src/db/repositories/guilds.ts:32, 71`, `src/fixture-mode.ts:88`, and
`src/http/inspector/queries.ts:263`. Rename `src/db/repositories/guilds.ts` to
`workspaces.ts` and update its imports. Skip the protected raw-payload sites.
Then update tests and fixtures that insert rows with SQL.

**Verify**: `npm run check && npm run check:test` → exit 0;
`npx vitest run test/unit test/integration` → exit 0.

### Step 3: Rename `discord_message_id` and `discordMessageId`

In the nine `src` files listed in "Current state" and their tests, change
`discord_message_id` to `platform_message_id` and `discordMessageId` to
`platformMessageId`. Change the `SendResult` comment to "The platform id of the
created message." Keep the outbox row semantics the same.

**Verify**: the "Outbox tests" command → exit 0.

### Step 4: Rename `discordLink` to `link`

Change the property name at every declaration and read listed in "Current
state". In `src/http/inspector/pages.ts`, a local function is named `link`;
`row.link` does not conflict with it, but read each edited line again. Change
spec line 2310 (`discordLink` → `link`) and §32.5 if it names the field. Run the
prompt and eval tests, because the model now sees the key `link`.

**Verify**: `npx vitest run test/unit/prompts.test.ts test/unit/prompt-templates.test.ts test/integration/message-context.test.ts test/integration/scoped-message-search.test.ts` → exit 0.

### Step 5: Move the workspace id out of `DiscordConfig`

Remove `guildId` from `DiscordConfig` (`src/config.ts:62-66`). Add
`workspaceId: string` to the top-level config type, loaded from
`DISCORD_GUILD_ID` with the same `parseSnowflake` call and the same error text.
Change the 39 uses of `config.discord.guildId` to `config.workspaceId`. Discord
code that calls discord.js (for example `client.guilds.fetch(...)`) now passes
`config.workspaceId`.

**Verify**: `npm run check && npm run check:test` → exit 0;
`npx vitest run test/unit/config.test.ts` → exit 0.

### Step 6: Build message links in one place

Create `src/platform/links.ts` with ABOUTME header lines:

```ts
/** Canonical message link (Section 30.3). Host-generated, never trusted. */
export function messageLink(workspaceId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${workspaceId}/${channelId}/${messageId}`;
}
```

Then:

- Delete `discordMessageLink` and change its eight callers to `messageLink`.
- Delete `sourceLinkUrl` and change its two callers to `messageLink`.
- Keep `messageLinkHelper` and its empty-string checks; make its last line call
  `messageLink`.
- Replace the two inline strings in `src/http/inspector/queries.ts:608, 939`
  with `messageLink(...)`.
- Update `test/unit/message-safety.test.ts`, `test/unit/prompts.test.ts`, and
  `test/integration/scoped-message-search.test.ts` imports.

**Verify**: the "Leftover builders" command → one hit; the "Link and prompt
tests" command → exit 0.

### Step 7: Validate platform ids in one place

Create `src/platform/ids.ts` with ABOUTME header lines:

```ts
/** A platform id. Discord ids are snowflakes: 17–20 decimal digits. */
export function isPlatformId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}
```

Replace each id check listed in "Current state" with `isPlatformId`. Remove the
three `SNOWFLAKE_RE` constants. Keep every error message and log text exactly
as it is (tests assert some of them). Do not change the mention patterns or
`snowflakeToMs`.

**Verify**: the "Leftover id checks" command → only the expected hits;
`npx vitest run` → exit 0.

### Step 8: Amend the spec

In `MNEME_IMPLEMENTATION_SPEC.md`:

- §29: change the `CREATE TABLE` text for the renamed tables, columns, and
  indexes so it matches the schema after migration 041. Add one in-place note:
  `(Amendment (plan 004): migration 041 renames guild tables and columns to
  workspace names and discord_message_id to platform_message_id.)`
- Lines 1188 and 1267: `discord_message_id` → `platform_message_id`.
- Line 2310: `discordLink` → `link`.
- §30.3: `{guild_id}` → `{workspace_id}`; state that `src/platform/links.ts`
  builds every link.
- Every other `guild_id` that `grep -n "guild_id" MNEME_IMPLEMENTATION_SPEC.md`
  finds, except text that describes the raw Discord payload.

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0.

### Step 9: Run the repository gate and inspect scope

**Verify**:

- `npm run verify` → exit 0, with clean output.
- The "Leftover names" command → only the protected raw-payload sites.
- `git diff --check` → exit 0 with no output.
- `git status --short` → only in-scope files changed.
- Update this plan's row in `plans/README.md` to `DONE`.

## Test plan

- Migration: the new test in `test/unit/migrations.test.ts` (columns, foreign
  keys, FTS triggers, index names) and the updated upgrade tests.
- Behavior parity: the full existing suite passes without changes to assertions
  other than renamed names. No snapshot or expected text changes except the
  `discordLink` → `link` key.
- Links: the existing link tests in `test/unit/message-safety.test.ts` and
  `test/unit/prompts.test.ts` pass against `messageLink`.
- Ids: config, channel-policy, attachment, and deletion tests pass with the
  same error texts.

## Done criteria

- [ ] Migration 041 renames 2 tables, 15 `guild_id` columns, 1 outbox column, and 4 indexes.
- [ ] `PRAGMA foreign_key_check` is clean after migration in the new test.
- [ ] No `guild_id`, `discord_message_id`, `discordMessageId`, or `discordLink` remains in `src` or `test`, except the protected raw-payload sites.
- [ ] `config.workspaceId` replaces `config.discord.guildId`.
- [ ] One `messageLink` function builds every message link.
- [ ] One `isPlatformId` function performs every id check; mention patterns are unchanged.
- [ ] `snowflakeToMs` is unchanged and used only by Discord normalization.
- [ ] The spec matches the schema and names.
- [ ] `npm run verify` exits 0; `git diff --check` is clean.
- [ ] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back without improvising if:

- Any `ALTER TABLE … RENAME` fails, or `PRAGMA foreign_key_check` reports rows
  after the migration.
- A test assertion other than a renamed identifier must change to pass.
- An edit would change a raw Discord payload field or a discord.js property.
- Renaming `config.discord.guildId` requires renaming other `guildId`
  identifiers to compile. Report the count; do not widen the scope.
- Another change has already added a migration `041`.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- The private repository (`~/dev/cassandra`) imports public commits with
  `git cherry-pick -x`. Its production database needs migration 041 at deploy.
  Check that the private repository has no other `041` before the import.
- Plan 005 makes `messageLink` and `isPlatformId` adapter methods and renames
  the remaining `guildId` identifiers to `workspaceId`. Keep both functions
  small so that move stays mechanical.
- Reviewers must check the protected raw-payload sites in
  `src/discord/client.ts` and `src/discord/normalize.ts` line by line.
