# Plan 006: Add the Slack read path (connection, discovery, visibility, ingestion, backfill)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cc84413..HEAD -- src/discord src/bootstrap.ts src/production-runtime.ts src/config.ts migrations MNEME_IMPLEMENTATION_SPEC.md`
> This plan was written before plans 004 and 005 existed. It cites current
> code by the paths at `cc84413`. Plan 005 moves the platform-neutral modules
> out of `src/discord/` and defines the `ChatPlatform` interface. Before you
> start, read the finished plans 004 and 005 and map each cited path to its new
> location. If a cited function no longer exists, or if the `ChatPlatform`
> interface does not have the members named in "Current state", treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (two commits: Part A and Part B)
- **Risk**: HIGH (a second platform crosses the visibility boundary)
- **Depends on**: 005 (the `ChatPlatform` seam), 004 (neutral ids and links)
- **Category**: feature
- **Planned at**: commit `cc84413`, 2026-10-01

## Why this matters

After plan 005, Mneme talks to Discord only through the `ChatPlatform`
adapter. This plan adds the first Slack code: a Slack adapter that connects,
discovers channels, applies the Slack visibility rules, stores live messages,
and imports history. At the end, a Slack deployment can run in `observe` mode.
It reads and remembers, but it does not send. Plan 007 adds the write path.

Read `plans/002-add-slack-support.md` first. This plan implements decisions 1,
3, 4, 5, 6, 9, and 10 of plan 002.

## Current state

- **Thread model.** A thread is a `channels` row with `is_thread = 1` and
  `parent_id` (`migrations/001_core.sql:23-45`). Messages have only
  `channel_id`; there is no thread column (`migrations/001_core.sql:72-94`).
  The episode conversation key is the channel id
  (`src/episodes/repository.ts:70-72`). Plan 002 decision 3 keeps this model:
  a Slack thread becomes a synthetic channel row `<channelId>-T<thread_ts>`.
- **Discovery** persists one row for each descriptor and applies policy in one
  transaction (`src/discord/discovery.ts:201-240`). The descriptor shape is at
  `src/discord/discovery.ts:67-78`. Channel kinds are Discord numeric types
  (`src/discord/discovery.ts:36-59`). Plan 005 is expected to replace `type`
  with a platform-neutral kind.
- **Missing rows fail closed.** After the snapshot, every known row that is not
  in the snapshot is set to `excluded` (`src/discord/discovery.ts:406-458`).
  For a thread row this depends on `missingThreadMode`; the default is
  `quarantine`, which also excludes the row. Slack has no API that lists
  threads. If the Slack adapter sends only channels, every known Slack thread
  row is excluded on every discovery run. Step 4 solves this.
- **Policy resolution.** `resolveChannel` applies explicit rule, then thread
  parent, then category, then default (`src/discord/channel-policy.ts:148-169`).
  `resolveEffectiveChannelPolicy` adds review decisions on top
  (`src/discord/channel-policy-review.ts:34-58`). Discovery calls it through
  `resolveObservedChannelPolicy` (`src/discord/channel-policy-review-service.ts:54-73`)
  with an `ObservedChannelIdentity` (`src/discord/channel-policy-review-service.ts:19-28`).
  There is no place for a platform rule that wins over every policy. Step 3
  adds one.
- **Ingestion eligibility** already requires an eligible, live parent for a
  thread (`src/discord/ingestion-eligibility.ts:20-35`).
- **Test surface.** `isMnemeTestSurface` checks the channel name and then the
  parent name (`src/discord/test-channels.ts:13-19`). A Slack thread row has no
  name, so it follows its parent. No change is necessary.
- **Backfill** pages newest first with a `before` message id cursor
  (`src/discord/backfill.ts:27-36`, `:76-95`). `sortNewestFirst` sorts by id
  length, then lexically (`src/discord/backfill.ts:67-75`). Slack message ids
  `<channelId>-<ts>` in one channel have the same length and sort correctly.
- **Reconcile** re-reads a recent window per channel cursor
  (`src/discord/reconcile.ts:19-30`).
- **Startup sync** stores live events first, then discovers, then queues
  backfill (`src/discord/sync.ts:119-160`).
- **Live event names** are Discord Gateway names (`src/discord/ingest.ts:460-489`).
  Plan 005 is expected to give the core a neutral event union
  (`message_create`, `message_update`, `message_delete`, `reaction_add`,
  `reaction_remove`, `channel_create`, `channel_update`, `channel_delete`).
- **Reactions** take a raw Discord emoji object (`src/discord/ingest.ts:377-382`).
- **Normalized message** shape: `src/discord/normalize.ts:62-85`.
- `@slack/bolt` is not a dependency yet (`package.json:36` lists only
  `discord.js`).
- Tests use Vitest with recorded fixture payloads under `test/fixtures/`. The
  existing Discord fixtures are in `test/fixtures/messages/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused Slack tests | `npx vitest run test/unit/slack test/integration/slack` | exit 0; all tests pass |
| Discord regression | `npx vitest run test/integration/discovery.test.ts test/integration/backfill.test.ts` (use the real file names) | exit 0; all tests pass |
| Typecheck | `npm run check && npm run check:test` | exit 0; no errors |
| Documentation checks | `npm run docs:check-public && npm run docs:check-links` | exit 0; no errors |
| Full verification | `npm run verify` | exit 0; SQLite check, lint, both typechecks, tests, and build all pass |

## Scope

**In scope:**

- A new adapter directory `src/platform/slack/` (use the directory that plan
  005 created for the Discord adapter, for example `src/platform/discord/`).
- The platform selection in the config loader and the composition root that
  plan 005 created, only to add the `slack` case.
- The policy resolver (`resolveEffectiveChannelPolicy` and its input type) for
  the platform boundary rule in Step 3.
- Discovery input for synthetic thread descriptors (Step 4), if the change
  cannot stay inside the adapter.
- `package.json` and `package-lock.json` for `@slack/bolt`.
- New tests under `test/unit/slack/` and `test/integration/slack/`, and new
  fixtures under `test/fixtures/slack/`.
- `MNEME_IMPLEMENTATION_SPEC.md` sections that plan 003 added for Slack
  (connection, visibility, ingestion), only to align them with the result.
- `.env.example` (Slack keys).
- `plans/README.md` (status update only).

**Out of scope:**

- Sending messages, cards, slash commands, and outbox recovery (plan 007).
- Sign in with Slack (plan 008).
- Downloading attachments (plan 009). Store attachment metadata only.
- The operator setup guide and the app manifest (plan 010).
- Any change to Discord behavior. The Discord tests must pass unchanged.
- A `thread_root_id` column or any other change to the thread model.
- Auto-join of channels (`conversations.join`).
- Reading DMs or group DMs.

## Git workflow

- Branch: `advisor/006-slack-read-path`
- Commit Part A (Steps 1–6) as one commit, for example
  `feat(slack): connect, discover channels, and store live messages`.
- Commit Part B (Steps 7–9) as a second commit, for example
  `feat(slack): backfill and reconcile channel and thread history`.
- Do not push or open a PR unless the operator instructs you.

## Steps

### Part A — connection, discovery, visibility, live events

### Step 1: Spike — find out whether reply edits and deletes emit events

This step decides the reconcile design in Step 8. Do it before you write
adapter code.

Create a throwaway Slack app in a test workspace with Socket Mode and the
scopes from Step 2. Invite it to one public and one private channel. Record
the raw Socket Mode envelopes for these actions:

1. Post a top-level message, edit it, delete it.
2. Start a thread, post a reply, edit the reply, delete the reply.
3. Post a reply with "Also send to #channel" (`thread_broadcast`), edit it,
   delete it.
4. Add and remove a reaction on a reply.
5. Upload a file in a reply.
6. Rename the channel. Archive and unarchive it. Remove the bot from the
   channel. Invite it again.
7. If the workspace can do so, share the channel with a second workspace
   (Slack Connect), then stop the share.

Remove tokens, user names, and message text from the envelopes. Keep the
structure, ids, `ts`, `thread_ts`, `subtype`, and flags. Save them as JSON
fixtures under `test/fixtures/slack/events/`. Write a short table of results
in `test/fixtures/slack/README.md`: action, event type, subtype, and whether
`thread_ts` is present.

**Verify**: The fixtures exist for actions 1–6 and the README table has one
row for each action. If action 2 produces no `message_changed` or no
`message_deleted` event for a reply, write that in the table; Step 8 then uses
the thread re-read. If you cannot get a test workspace, STOP.

### Step 2: Add the Slack configuration and the Bolt connection

Add `@slack/bolt` (latest 5.x) as an exact-version dependency, like
`discord.js` in `package.json`.

Add the Slack configuration to the config loader. It applies only when
`MNEME_PLATFORM=slack`:

| Key | Rule |
|---|---|
| `SLACK_BOT_TOKEN` | required; starts with `xoxb-` |
| `SLACK_APP_TOKEN` | required; starts with `xapp-` |
| `SLACK_TEAM_ID` | required; matches `^T[A-Z0-9]{8,}$` |
| `MNEME_ADMIN_USER_IDS` | required, at least one; each matches `^[UW][A-Z0-9]{8,}$` |

Every rule fails startup with a clear message. Do not log token values. Put
the Slack id validators (channel `^[CG][A-Z0-9]{8,}$`, user, team, and
`ts` `^\d{10}\.\d{6}$`) on the adapter id validator that plan 004 defined.

In the adapter, create the Bolt `App` with `socketMode: true`, the bot token,
and the app token. Disable Bolt's built-in receiver logging of payloads. At
connect:

1. Call `auth.test`. Fail closed (startup error) if `team_id` is not
   `SLACK_TEAM_ID`. Keep `user_id` as `selfUserId` and the host part of `url`
   as the team domain for the link builder (plan 002 decision 8).
2. Implement `health()` from the Socket Mode client events (connected,
   disconnected, reconnecting). Count reconnects. Record the time of the last
   received envelope.

Implement `messageLink(channelId, messageId)` for Slack as plan 002 decision 8
describes. For a message in a thread row, use the parent channel id in the
path and add `?thread_ts=<root>&cid=<parent>`.

Required bot scopes for this plan (record them in a constant; plan 010 puts
them in the manifest): `channels:read`, `groups:read`, `channels:history`,
`groups:history`, `reactions:read`, `users:read`, `files:read`.

**Verify**: `npx vitest run test/unit/slack/config.test.ts test/unit/slack/links.test.ts`
→ exit 0. Tests cover each invalid key, a team mismatch from a recorded
`auth.test` response, and links for a top-level message and a reply.

### Step 3: Add the platform boundary rule to policy resolution

Add an optional `platformBoundary?: 'excluded'` field to the effective-policy
input (`src/discord/channel-policy-review.ts:34`) and to
`ObservedChannelIdentity` (`src/discord/channel-policy-review-service.ts:19`).
When it is present, `resolveEffectiveChannelPolicy` returns the excluded rule
(`ingest: false`, `visibility: 'excluded'`, `allow_interventions: false`) with
a new source value `platform_boundary` before it looks at static policy or
review decisions. An explicit channel rule, a thread override, a category
rule, and a review decision cannot win over it. The rule must not create a
channel-policy review card.

The Slack adapter sets `platformBoundary: 'excluded'` for a channel when
`is_ext_shared` or `is_pending_ext_shared` is true. It sets the same value on
every thread row of that channel. The Discord adapter never sets it.

Add `platform_boundary` wherever the code lists policy sources (status output,
inspector), with the plain label "Slack Connect channel: always excluded".

**Verify**: `npx vitest run test/unit/channel-policy-review.test.ts` (use the
real file name) → exit 0, with new cases: an explicit `org` rule, a thread
override, and an `org` review decision each lose to the boundary rule.

### Step 4: Discover Slack channels and keep known thread rows

Implement `listChannels()` for Slack:

1. Call `conversations.list` with `types=public_channel,private_channel`,
   `exclude_archived=false`, and `limit=200`. Page with `next_cursor` until it
   is empty.
2. Keep only rows with `is_member === true`. The bot does not join channels
   (plan 002 decision 9). A channel without the bot is not in the snapshot, so
   the existing missing-row logic excludes it.
3. Map each row to a descriptor: id, `parentId: null`, kind (public or private
   channel), name, topic, archived (`is_archived`), `isPrivate` (from
   `is_private`, never from `is_channel`), and the boundary flag from Step 3.
   Capabilities: `canView` and `canReadHistory` are true for a member. Set
   `canSend` to false in this plan; plan 007 sets it.
4. Add one descriptor for each known, not deleted thread row whose parent is
   in the snapshot. Read these rows from the database. A thread descriptor
   copies the parent's capabilities and boundary flag. A thread row whose
   parent is not in the snapshot gets no descriptor, so the existing logic
   excludes it.

Run discovery with `missingThreadMode: 'close'` for Slack. Step 4.4 makes the
snapshot complete for threads, because a Slack thread exists only while its
parent exists. Put this choice in the adapter, not in the shared discovery
code. If the shared code cannot take the derived descriptors without a change,
make the smallest change and add a Discord regression test.

**Verify**: `npx vitest run test/integration/slack/discovery.test.ts` → exit 0.
Cases: a member channel is stored; a non-member channel is not; a channel the
bot left is excluded on the next run; a known thread stays retrievable while
its parent is a member channel; a thread is excluded when its parent leaves
the snapshot; an `is_ext_shared` channel and its threads are excluded with
source `platform_boundary`; a channel that becomes shared between two runs is
excluded on the second run.

### Step 5: Normalize Slack messages

Write `normalizeSlackMessage(raw, channelId)` in the adapter. It returns the
neutral normalized message that plan 005 defined, or `null` for a message that
Mneme does not store.

- **Ids.** `id = <channelId>-<ts>` for every message (plan 002 decision 4).
  If `thread_ts` is present and `thread_ts !== ts`, `channelId` is the thread
  row id `<channelId>-T<thread_ts>`; otherwise it is the channel id.
  A `thread_broadcast` message maps to the thread row, so the copy in channel
  history and the copy in the thread are the same row.
- **Time.** `createdAtMs = Math.floor(Number(ts) * 1000)`.
  `editedAtMs` comes from `edited.ts` in the same way.
- **Author.** `user` for human messages. For `bot_message`, use `bot_id` and
  set `isBot: true`. A message from `selfUserId` is stored with `isBot: true`.
- **Content.** Store `text` as the content. Do not convert mrkdwn in this
  plan; the episode prompt reads plain text. Keep `blocks` in `raw`.
- **Mentions.** Parse `<@U…>` and `<@W…>` into mentions. Set
  `mentionEveryone` for `<!channel>`, `<!here>`, and `<!everyone>`.
- **Reactions.** Map `reactions[].name` and `count` to reaction counts. Use
  `name` as the emoji key.
- **Attachments.** Map `files[]` to attachment metadata: id, name, mimetype,
  size, and `url_private` as the source URL. Do not download. The attachment
  id is `<messageId>-<fileId>`, not the bare Slack file id: one file can be
  shared into more than one message, and the attachment upsert
  (`src/db/repositories/attachments.ts:55`) never changes `message_id`
  (decision 18, plan 009).
- **Subtypes.** Store messages with no subtype, `bot_message`, `file_share`,
  `thread_broadcast`, and `me_message`. Return `null` for `channel_join`,
  `channel_leave`, `channel_topic`, `channel_purpose`, `channel_name`,
  `channel_archive`, `channel_unarchive`, `group_*` equivalents, `pinned_item`,
  `unpinned_item`, and every unknown subtype. Log an unknown subtype once at
  `debug` level with the subtype only, never the text.

Add `normalizeSlackMessageUpdate` for `message_changed` (use `message`, keep
the original `ts`) and a delete mapping for `message_deleted` (use
`deleted_ts`).

**Verify**: `npx vitest run test/unit/slack/normalize.test.ts` → exit 0, with
one case for each stored subtype, each ignored subtype, a reply, a broadcast
reply that maps to the same id from both sources, an edit, and a delete. Use
the Step 1 fixtures.

### Step 6: Map live Slack events to the neutral event union

Register Bolt listeners and map them to the neutral events from plan 005:

| Slack event | Neutral event |
|---|---|
| `message` (no subtype or stored subtype) | `message_create` |
| `message` / `message_changed` | `message_update` |
| `message` / `message_deleted` | `message_delete` |
| `reaction_added` / `reaction_removed` with `item.type === 'message'` | `reaction_add` / `reaction_remove` |
| `channel_created`, `channel_rename`, `channel_archive`, `channel_unarchive`, `group_rename`, `group_archive`, `group_unarchive` | `channel_update` (re-read the channel with `conversations.info`) |
| `channel_deleted`, `group_deleted` | `channel_delete` |
| `member_joined_channel` with the bot as `user` | `channel_create` (re-read with `conversations.info`) |
| `channel_left`, `group_left`, `member_left_channel` with the bot as `user` | `channel_delete` for the bot's view (the row becomes unavailable) |
| `channel_shared`, `channel_unshared` | `channel_update` (re-read; Step 3 applies the boundary) |

Rules:

- Drop every event whose `team` or `team_id` is present and is not
  `SLACK_TEAM_ID`.
- Drop every event for a channel that is not a known member channel, except
  the bot-join event.
- The first reply in a new thread creates the thread row before the message
  is stored. The row has `parent_id = <channelId>`, no name, and the parent's
  policy result. Use the same upsert path as discovery.
- A reaction carries `item.channel` and `item.ts`. Compute the message id
  `<channel>-<ts>`; the stored row already knows its thread. Map the emoji
  name to the reaction input that plan 005 defined.
- Acknowledge every envelope at once. Do the work after the acknowledgement,
  through the same queue that Discord events use.

Wire the Slack adapter into the platform selection so `MNEME_PLATFORM=slack`
starts it. Start in `observe` mode only: if the configured mode is not
`observe`, fail startup with "Slack supports observe mode until the write path
is available". Plan 007 removes this check.

**Verify**: `npx vitest run test/integration/slack/live-events.test.ts` → exit
0. Feed the Step 1 fixtures through the listeners with a fake Bolt receiver
(test double at the network edge only). Assert the stored rows, the new thread
row, the boundary exclusion after `channel_shared`, and that the bot leaving
makes the channel and its threads unavailable. Then run `npm run verify`
→ exit 0. Commit Part A.

### Part B — history

### Step 7: Backfill channels and threads

Implement the history member of the adapter for Slack:

- For a channel row: call `conversations.history` with `channel`,
  `limit` (default 200, maximum 999), and `latest = <ts of before>` when the
  core gives a `before` message id. Use `inclusive=false`. Return messages
  newest first.
- For each returned parent with `reply_count > 0`, upsert the thread row
  (Step 6 rules) and queue a `backfill_channel` job for the thread row id.
  Use the existing job and its unique key, so a thread is queued once.
- For a thread row: split the id into `channel` and `thread_ts`. Call
  `conversations.replies` with `ts = thread_ts`, the same `limit`, and
  `latest` for paging. Drop the message whose `ts` equals `thread_ts`; the
  root belongs to the parent channel (plan 002 decision 4).
- Normalize every message with Step 5.

Rate limits: use the Bolt `WebClient` retry settings so a `429` waits for
`Retry-After` and retries. Set a maximum of 5 retries for one request. After
that, let the job fail and use the existing job retry. Never retry faster than
`Retry-After`.

**Verify**: `npx vitest run test/integration/slack/backfill.test.ts` → exit 0.
Use recorded `conversations.history` and `conversations.replies` pages with a
fake `WebClient`. Cases: two pages of channel history; a parent with replies
queues one thread job; the thread job stores replies without the root; a
broadcast reply is stored once; a `429` with `Retry-After: 2` waits and then
succeeds (use fake timers); a cursor resumes after a crash between pages.

### Step 8: Reconcile channels and recent threads

Reuse the core reconcile (`src/discord/reconcile.ts`) for channel rows and for
thread rows. It pages through the adapter history member, so channel and
thread rows both work after Step 7.

Add one Slack rule for threads. If Step 1 showed that reply edits or deletes
emit no events, reconcile must also re-read threads. During a channel
reconcile, for each parent in the window whose `latest_reply` is newer than
the newest stored reply of that thread, queue a `reconcile_channel` job for
the thread row. If Step 1 showed that the events arrive, still apply this rule
for threads that changed while Mneme was offline; that is the purpose of
reconcile.

**Verify**: `npx vitest run test/integration/slack/reconcile.test.ts` → exit 0.
Cases: a reply edited during downtime is updated; a reply deleted during
downtime is tombstoned; a thread with no new replies is not re-read.

### Step 9: Align the spec and run the full gate

Update the Slack sections that plan 003 added to `MNEME_IMPLEMENTATION_SPEC.md`
so they state what this plan built: the scopes, the member-only discovery, the
derived thread snapshot, the `platform_boundary` source, the stored and
ignored subtypes, the `observe`-only startup check, and the thread re-read
rule. Add the Slack keys to `.env.example` with one comment line each.

**Verify**:

- `npm run docs:check-public && npm run docs:check-links` → exit 0.
- `npm run verify` → exit 0.
- `git diff --check` → exit 0 with no output.
- `git status --short` → only in-scope files are changed.
- Update this plan's row in `plans/README.md` to `DONE`. Commit Part B.

## Test plan

- Configuration: each Slack key fails closed; tokens are never logged.
- Connection: team mismatch from `auth.test` stops startup; health counts
  reconnects.
- Visibility: member-only discovery; bot removal excludes the channel and its
  threads; Slack Connect excludes with no override, including a change from
  not shared to shared; thread rows survive discovery only while the parent is
  present.
- Normalization: synthetic ids; reply and broadcast mapping; stored and
  ignored subtypes; edits keep the id; deletes use `deleted_ts`.
- Live events: foreign team dropped; non-member channel dropped; first reply
  creates the thread row; reactions resolve to the stored message.
- History: paging with `latest`; root dropped from replies; one job per
  thread; `Retry-After` obeyed; crash-safe cursor.
- Reconcile: downtime edits and deletes in threads are applied.
- Regression: all Discord tests pass unchanged.

## Done criteria

- [ ] Step 1 fixtures and the results table exist.
- [ ] `MNEME_PLATFORM=slack` starts the Slack adapter in `observe` mode and refuses other modes.
- [ ] Slack configuration fails closed for each key.
- [ ] Discovery stores only member channels and keeps thread rows only while the parent is present.
- [ ] A Slack Connect channel and its threads are always excluded, with source `platform_boundary`.
- [ ] Live messages, edits, deletes, reactions, and channel changes are stored through the neutral event union.
- [ ] Backfill imports channel history and every thread, without duplicates.
- [ ] Reconcile applies thread changes made during downtime.
- [ ] `npm run verify` exits 0, and the Discord tests are unchanged.
- [ ] Documentation checks exit 0.
- [ ] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back without improvising if:

- Plan 005 did not create a `ChatPlatform` interface with discovery, history,
  live events, id validation, and link members, or the descriptor still uses
  Discord numeric types with no neutral kind.
- You cannot get a Slack test workspace for Step 1.
- Step 1 shows that `thread_ts` is missing from reply events, or that a reply
  edit event has no way to find the thread.
- Synthetic thread descriptors (Step 4) need a change to the shared discovery
  code that changes a Discord test result.
- The boundary rule (Step 3) cannot win over a review decision without a
  change to stored review rows.
- `conversations.history` or `conversations.replies` returns the 15-message,
  1-request-per-minute limit for the test app. That means Slack treats the app
  as commercially distributed; plan 002 then needs a new decision.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- The synthetic ids are permanent. Do not change their format after a
  deployment stores data; plan 002 decision 2 allows a fresh database, but
  operators lose memory.
- Reviewers should scrutinize Step 3 and Step 4 first. They are the
  visibility boundary. A mistake there leaks content from Slack Connect
  channels or from channels the bot left.
- `missingThreadMode: 'close'` is correct for Slack only because Step 4.4
  derives the thread snapshot from the parent. If a later change removes the
  derived descriptors, every Slack thread row is excluded.
- The thread re-read in Step 8 costs one `conversations.replies` call for each
  changed thread. If the cost is too high on a large workspace, limit it to the
  reconcile window; do not remove it.
