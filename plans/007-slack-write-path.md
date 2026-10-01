# Plan 007: Add the Slack write path: send, outbox recovery, cards, commands

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cc84413..HEAD -- src/discord/sender.ts src/outbox/recovery.ts src/discord/review-message.ts src/discord/channel-policy-review-message.ts src/discord/interactions.ts src/discord/command-dispatcher.ts src/discord/commands.ts src/discord/message-safety.ts src/memory/scheduled-feedback.ts src/agent/policy.ts src/production-runtime.ts src/config.ts`
> Plans 004–006 change most of these files on purpose. Before you start, read
> the merged plans 004, 005, and 006 and map every name in "Current state" to
> its name after those plans (for example `discordMessageId` →
> `platformMessageId`, `DiscordWiring` → `ChatPlatform`). If a seam that this
> plan assumes (listed under "Assumptions") does not exist, treat it as a STOP
> condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH (outbound safety: pings, leaks, duplicate posts)
- **Depends on**: 006 (Slack read path), and through it 004 and 005
- **Category**: feature
- **Planned at**: commit `cc84413`, 2026-10-01

## Why this matters

After plan 006, a Slack deployment can read and remember, and it can run in
`observe` mode. It cannot speak, show review cards, or accept admin commands.
This plan adds every outbound path for Slack: outbox delivery, crash recovery,
proposal and channel-policy review cards, button handling, the `/mneme` slash
command, and backup notices. When this plan is done, a Slack deployment can run
in `review` mode with the same safety rules as Discord.

## Assumptions

This plan was written in parallel with plans 005 and 006 and checked against
their drafts. It assumes the following results from them. Confirm each one
before Step 1.

1. A `ChatPlatform` interface (plan 005) with `sender`, `cards`, `sendDirect`,
   `onCommand`, `onAction`, `resolveActor`, `reviewSecret`, and format members.
   The Discord adapter implements it. The core verifies the HMAC in
   `ActionInvocation.actionId` with `reviewSecret`.
2. The command routes receive a `CommandInvocation`
   `{ path, options, actor, channelId }` instead of a
   `ChatInputCommandInteraction` (plan 005). Today the routes read options from
   discord.js directly, for example `i.options.getString('query', true)` at
   `src/discord/command-dispatcher.ts:323`. `Actor` is
   `{ userId, isAdmin }`; `null` means fail closed.
3. A Slack adapter module, for example `src/slack/`, with a Bolt `App` in
   Socket Mode, a `WebClient`, the workspace id, the bot user id, and the team
   domain from `auth.test` (plan 006).
4. The Slack id helpers from plan 006: `parseThreadChannelId('C…-T<ts>')` →
   `{ channel, threadTs }` and `parseMessageId('C…-<ts>')` → `{ channel, ts }`
   (decisions 3 and 4).
5. The Slack normalizer (plan 006, Step 5) does not set `replyToMessageId` in
   the draft that this plan was checked against. Step 6 of this plan adds it:
   a thread reply gets `replyToMessageId = <channelId>-<thread_ts>`, the
   message id of the thread root. That change is in scope.
6. Column and field names from plan 004: `platform_message_id`,
   `platformMessageId`, `workspace_id`.

## Current state

- `src/discord/sender.ts:13-30` — the outbound port. The input has a channel,
  content, an optional reply anchor, and a dedupe marker. The result returns
  the created message id:

  ```ts
  export interface SendOutboxMessageInput {
    channelId: string;
    content: string;
    /** Reply anchor in the target channel, when one was validated upstream. */
    replyToMessageId?: string | null;
    /** Stable Discord nonce used only for crash reconciliation. */
    dedupeMarker?: string | null;
  }
  ```

- `src/discord/sender.ts:43-63` — the Discord sender disables all mentions
  (`allowedMentions: { parse: [] }`), puts the dedupe marker in the message
  nonce, and sends a Discord reply when an anchor is present. Slack has no
  `allowed_mentions`, no nonce, and no reply reference.
- `src/agent/policy.ts:421-436` — check 7. A reply anchor must exist, must not
  be deleted, and must be in the target channel:

  ```ts
  if (reply.channelId !== input.target.channelId) {
    rejectReasons.push(
      `reply anchor "${input.replyToMessageId}" is in channel "${reply.channelId}", not the target channel`,
    );
  }
  ```

- `src/outbox/recovery.ts:27-39` — `RecentSentMessage` carries the created
  message id, content, time, and dedupe marker. `RecentSentMessageLookup` reads
  recent own messages for one channel.
- `src/outbox/recovery.ts:187-225` — the Discord lookup pages back through
  history, keeps messages whose author is the bot, and reads the nonce as the
  dedupe marker.
- `src/discord/review-message.ts:66-118` — `signReviewComponent` builds
  `cass:rv:<action>:<proposalId>:<sig>` with an HMAC; `parseReviewComponent`
  verifies it in constant time. These functions do not depend on Discord.
- `src/discord/review-message.ts:120-189` — `buildReviewMessage` builds a
  discord.js embed and button row. `src/discord/review-message.ts:191-210` — the
  `ReviewChannel` port and its Discord sender.
- `src/discord/channel-policy-review-message.ts:26-50` — signed channel-policy
  action ids with actions `org`, `restricted`, and `excluded`.
- `src/discord/channel-policy-review-message.ts:99-134` — the
  `ChannelPolicyReviewDiscordPort` with `send`, `findByMarker` (matches the
  embed footer text), and `resolve` (edits the card to a label and removes the
  buttons).
- `src/discord/interactions.ts:51` and `:148` — the proposal button handler and
  the Discord review resolver.
- `src/production-runtime.ts:1397` derives the review secret from
  `ctx.config.discord.token`. `:1690-1694` sends the backup notice as a
  Discord DM with Discord-specific text. `:1764-1769` routes discord.js button
  interactions. `:1771` runs outbox recovery with the Discord lookup.
- `src/discord/commands.ts:28-49` — the declarative command spec types
  (`CommandOptionKind = 'string' | 'channel' | 'user' | 'integer'`, optional
  `choices`). `MNEME_SUBCOMMANDS` starts at `:62` and `MNEME_SUBCOMMAND_GROUPS`
  at `:129`. This spec is the one source for the Slack parser.
- `src/discord/command-dispatcher.ts:39-47` — replies are capped at 1,950
  characters and are ephemeral. `:342-360` — `dispatch` checks the guild id,
  builds the actor, and picks the route by group then subcommand.
- `src/discord/commands/deletion.ts:34-36` — deletion commands work only in the
  secure review channel. `:43-46` — replies contain `<@id>` mentions and
  `<t:…:F>` Discord timestamps.
- `src/discord/message-safety.ts:27` (`MAX_MESSAGE_CHARS = 1800`), `:94-98`
  (Discord mention regexes with `\d{17,20}`), `:36-37`
  (`SCHEDULED_NOTIFICATION_FOOTER` says "Reply to this message").
- `src/memory/scheduled-feedback.ts:69-90` — a human reply updates a scheduled
  record only if the reply's `channel_id` equals the outbox `channel_id` and
  its `reply_to_message_id` equals the outbox created-message id. On Slack, a
  human reply to Mneme's message is a thread reply. Decision 3 stores it in the
  thread row `C…-T<ts>`, not in `C…`, so this check fails for every Slack reply.
- `src/config.ts:815-825` — `MNEME_ADMIN_ROLE_IDS` and
  `MNEME_DELETION_APPROVER_USER_IDS` are parsed as snowflake lists.
- Tests: `test/integration/outbox-send.test.ts`,
  `test/integration/outbox-crash-recovery.test.ts`,
  `test/integration/review-message.test.ts`,
  `test/integration/channel-policy-review.test.ts`,
  `test/integration/command-dispatcher.test.ts`, `test/unit/commands.test.ts`,
  and `test/unit/message-safety.test.ts` show the patterns to follow.

## Decisions in this plan

These decisions follow `plans/002-add-slack-support.md`. They add detail that
plan 002 does not give.

- **A reply becomes a thread reply.** When an outbox row has a reply anchor,
  the Slack sender posts with `thread_ts` set to the anchor's thread root. If
  the anchor is a top-level message, the root is the anchor itself. If the
  anchor is in a thread, the root is that thread's root. Mneme never sets
  `reply_broadcast`. Check 7 still holds without change: the anchor's
  `channel_id` must equal the target `channel_id`. A top-level anchor is in
  `C…`, and the target is `C…`. A thread anchor is in `C…-T<root>`, and the
  target is the same thread row.
- **A target thread row posts into the thread.** When the target channel id is
  a thread row `C…-T<root>`, the sender posts to `C…` with `thread_ts=<root>`.
- **Mentions never ping.** The sender never sends `link_names`. Every outbound
  string goes through the mrkdwn converter, which escapes `&`, `<`, and `>` in
  all text that the host did not build. The converter then adds only the link
  syntax `<url|label>` for host-built links. A Slack user, channel, group, or
  special mention cannot survive conversion.
- **Dedupe marker.** The default carrier is message metadata
  (`metadata: { event_type: 'mneme_outbox', event_payload: { marker } }`), as
  decision 13 says. Step 1 is a spike that confirms the scope needed to read
  it. If metadata needs a scope that the app cannot have, use the fallback: a
  `block_id` of `mneme:<marker>` on the one section block of the message. Record
  the result in this plan before Step 4.
- **Card marker.** Channel-policy cards carry their marker as the `block_id` of
  the context block. `findByMarker` matches on it. Blocks come back in
  `conversations.history` with no extra scope.
- **Slash command grammar.** `/mneme <subcommand> [args]` or
  `/mneme <group> <subcommand> [args]`. Arguments are positional, in the order
  of the declared options. Double quotes group words; `\"` inside quotes is a
  literal quote. The last declared `string` option takes the rest of the line
  when it is not quoted. User options accept `<@U…|name>` or `<@U…>`; channel
  options accept `<#C…|name>` or `<#C…>`. The app manifest (plan 010) must set
  `should_escape: true` so Slack sends these forms. `/mneme help` and
  `/mneme help <name>` print usage generated from the spec. `help` is handled
  in the parser and is not a route.
- **Admins.** On Slack, `MNEME_ADMIN_USER_IDS` lists Slack user ids
  (decision 10). The actor is `{ userId, isAdmin }`. Every command and every
  button checks it and fails closed.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Converter tests | `npx vitest run test/unit/slack-mrkdwn.test.ts` | exit 0; all tests pass |
| Sender and recovery tests | `npx vitest run test/integration/slack-outbox.test.ts test/integration/outbox-send.test.ts test/integration/outbox-crash-recovery.test.ts` | exit 0; all tests pass |
| Card tests | `npx vitest run test/integration/slack-cards.test.ts test/integration/review-message.test.ts test/integration/channel-policy-review.test.ts` | exit 0; all tests pass |
| Command tests | `npx vitest run test/unit/slack-command-parser.test.ts test/integration/slack-commands.test.ts test/integration/command-dispatcher.test.ts test/unit/commands.test.ts` | exit 0; all tests pass |
| Feedback tests | `npx vitest run test/integration/scheduled-review.test.ts` | exit 0; all tests pass |
| Documentation checks | `npm run docs:check-public && npm run docs:check-links` | exit 0; no errors |
| Full verification | `npm run verify` | exit 0; SQLite check, lint, both typechecks, tests, and build all pass |

## Scope

**In scope**:

- New files under the Slack adapter directory from plan 006 (for example
  `src/slack/sender.ts`, `src/slack/mrkdwn.ts`, `src/slack/recovery.ts`,
  `src/slack/cards.ts`, `src/slack/actions.ts`, `src/slack/command-parser.ts`,
  `src/slack/commands.ts`, `src/slack/notices.ts`).
- The Slack adapter's `ChatPlatform` implementation and its composition (from
  plan 006).
- `src/memory/scheduled-feedback.ts` (Step 6 only).
- The Slack normalizer from plan 006 and its tests (Step 6 only: set
  `replyToMessageId` of thread replies).
- `src/production-runtime.ts` and `src/config.ts` only where plan 005 left a
  platform branch for the write path (review secret, backup notice,
  `MNEME_ADMIN_USER_IDS`).
- New tests: `test/unit/slack-mrkdwn.test.ts`,
  `test/unit/slack-command-parser.test.ts`,
  `test/integration/slack-outbox.test.ts`,
  `test/integration/slack-cards.test.ts`,
  `test/integration/slack-commands.test.ts`. Extend
  `test/integration/scheduled-review.test.ts` for Step 6.
- `MNEME_IMPLEMENTATION_SPEC.md` Sections 6.6, 10.1, 10.2, 24.5, 25, 26, and 27
  — Slack additions only.
- `docs/reference/configuration.md` (`MNEME_ADMIN_USER_IDS`).
- `plans/README.md` (status update only).

**Out of scope** (do not touch):

- The Discord adapter's behavior. Discord tests must pass with no edits.
- Command handler logic in `src/discord/commands/*` (or its plan 005 location).
  The Slack parser feeds the same handlers.
- Sign in with Slack (plan 008), attachments (plan 009), the app manifest and
  setup docs (plan 010).
- Slack modals, App Home views, shortcuts, and scheduled messages.
- Any change that lets model-authored text create a Slack link, mention, or
  block.
- Auto-join of channels.

## Git workflow

- Branch: `advisor/007-slack-write-path`
- Commit each step as one logical change in conventional style, for example
  `feat(slack): convert outbound markdown to mrkdwn`,
  `feat(slack): deliver outbox messages`, `feat(slack): add review cards`,
  `feat(slack): parse the mneme slash command`,
  `fix(feedback): accept thread replies to scheduled notices`.
- Do not push or open a PR unless the operator instructs you.

## Steps

### Step 1: Spike — confirm metadata, thread, and DM behavior

Use a test workspace and a test app with the scopes from plan 006 plus
`chat:write`, `commands`, and `im:write`. Do not use a production workspace.
Write a short script outside `src/` (do not commit it), and record the answers
in a new "Spike results" section at the end of this plan:

1. Post with `chat.postMessage` and `metadata`. Read it back with
   `conversations.history` and `include_all_metadata=true`. Record whether the
   metadata comes back with only the plan 006 scopes, or which extra scope is
   needed (Slack docs name `metadata.message:read`; confirm).
2. Post a message with one section block whose `block_id` is
   `mneme:test-marker`. Read it back. Record that `block_id` is returned.
3. Post a thread reply with `thread_ts`. Confirm that the reply appears in
   `conversations.replies` and not in `conversations.history`.
4. Post a message containing `<@USERID>`, `<!here>`, and `<!subteam^ID>` after
   escaping `<` and `>`. Confirm that nobody is notified and the text shows
   literally.
5. With the App Home Messages tab on and "Allow users to send Slash commands
   and messages from the messages tab" off, post to a user id with
   `chat.postMessage`. Confirm that the user sees the message. Repeat with the
   Messages tab off and record the result. (Plan 002 decision 14 says the tab
   is off. If the user cannot see messages with the tab off, record this; the
   operator must amend decision 14 before Step 7.)

**Verify**: the "Spike results" section exists and answers all five items. If
item 1 needs a scope that the app cannot request, choose the `block_id`
fallback for the dedupe marker and say so in the section.

### Step 2: Convert the neutral Markdown subset to mrkdwn

Create `src/slack/mrkdwn.ts` with one pure function,
`toSlackMrkdwn(content: string, links: readonly MessageLink[]): string`, and a
small helper for plain text, `escapeSlackText(text: string): string`.

Rules:

1. Escape `&` to `&amp;`, `<` to `&lt;`, and `>` to `&gt;` in all text first.
   Escape `&` first.
2. Convert only these constructs from the escaped text: `**bold**` → `*bold*`;
   `*italic*` and `_italic_` → `_italic_`; a line that starts with `> ` stays a
   quote (after escaping, `&gt; ` at the start of a line becomes `> ` again);
   inline code and fenced code stay as they are, and no conversion happens
   inside them.
3. Convert `[label](url)` to `<url|label>` only when `url` is the URL of one of
   the host-built `links`. Any other Markdown link becomes the plain text
   `label (url)` with both parts escaped. A `|` or `>` in a label is removed.
4. Convert Discord-only tokens that the core emits in admin replies:
   `<t:N:F>` → `<!date^N^{date_long} {time}|fallback>`, where the fallback is
   the ISO time in UTC. Convert `<@id>` to `<@id>` only in ephemeral command
   replies (a flag on the function). In channel posts, `<@id>` becomes the
   plain id in code format. Check whether plan 004 already moved these tokens
   behind the format object; if it did, use that and skip this rule.
5. The output never contains `<!`, `<@`, `<#`, or `<!subteam^`, except the
   date form from rule 4 and user mentions in ephemeral replies.

Write `test/unit/slack-mrkdwn.test.ts` with a table of cases. Cover each
construct, nesting (bold inside a quote, a link inside bold), code that
contains `*` and `<`, the scheduled notification footer, a direct-answer
message with three inline citations, and an episode intervention with a
`Sources:` line. Add hostile cases: `<@U123>`, `<!channel>`, `<!here>`,
`<!everyone>`, `<!subteam^S1>`, `<#C123>`, `&lt;!here&gt;` typed by a user,
`<https://evil.example|https://good.example>`, a Markdown link to an
unvalidated URL, a label that contains `|` or `>`, unbalanced `**` and
backticks, a zero-width space inside `<!here>`, and 10,000 `*` characters
(must finish in less than 100 ms). For each hostile case, assert that the
output contains no mention token and no link that is not host-built.

**Verify**: `npx vitest run test/unit/slack-mrkdwn.test.ts` → exit 0.

### Step 3: Deliver outbox messages to Slack

Create `src/slack/sender.ts`, which implements the platform send member with
the same contract as `createDiscordSender` (`src/discord/sender.ts:43-63`):

1. Resolve the target: a thread row id gives `{ channel, threadTs }`; a plain
   channel id gives `{ channel }`.
2. If `replyToMessageId` is set, parse it into `{ channel, ts }`. Look up the
   stored anchor row. Set `thread_ts` to the anchor's thread root (the anchor's
   own `ts` when the anchor is top-level). If the anchor channel from the id is
   not the target's Slack channel, throw. Check 7 should already prevent this,
   so this is a second guard.
3. Call `chat.postMessage` with `channel`, `text` from `toSlackMrkdwn`,
   optional `thread_ts`, `unfurl_links: false`, `unfurl_media: false`, and the
   dedupe marker carrier chosen in Step 1. Never set `link_names`,
   `reply_broadcast`, `username`, or `icon_*`.
4. Return `{ platformMessageId: '<channel>-<ts>' }` from the response.
5. Map errors so the existing classifier works: `ratelimited` and HTTP 429 and
   5xx are transient; `channel_not_found`, `not_in_channel`, `is_archived`,
   `invalid_auth`, `account_inactive`, and `missing_scope` are permanent. Look
   at how the outbox worker classifies discord.js errors and give the Slack
   errors the same `status` shape, or extend the classifier in the adapter.

Keep the core cap of 2,000 characters for interventions. Slack accepts longer
text, but the cap is a product limit. Do not raise it.

Write `test/integration/slack-outbox.test.ts` with a fake `WebClient` at the
external boundary. Cover: a top-level post; a post to a thread row; a reply to
a top-level anchor (posts with `thread_ts` = anchor `ts`); a reply to an
anchor in a thread (posts with `thread_ts` = root); an anchor in another
channel (throws, and nothing is posted); the dedupe marker is present; no
forbidden parameter is sent; and error mapping for each error code above.

**Verify**: `npx vitest run test/integration/slack-outbox.test.ts test/integration/outbox-send.test.ts` → exit 0.

### Step 4: Recover in-flight outbox rows on Slack

Create the Slack `RecentSentMessageLookup` (contract at
`src/outbox/recovery.ts:27-39`). For one channel id (plain or thread row), read
`conversations.history` (or `conversations.replies` for a thread row) back to
`sinceMs`, with `include_all_metadata=true` if the metadata carrier is used.
Keep only messages whose `user` or `bot_id` is Mneme's. Return the
`platformMessageId`, the text, `sentAtMs` from `ts`, and the marker. Use the
same page limit as the Discord lookup (`src/outbox/recovery.ts:197`) and throw
when the limit is reached. A missing channel returns an empty list.

Wire it in the place where plan 005 moved the call at
`src/production-runtime.ts:1771`.

Extend `test/integration/slack-outbox.test.ts`: a row in `sending` state whose
marker is found becomes `sent` with the found id; a row whose marker is not
found follows the existing retry path; a message from another bot with the
same marker is ignored.

**Verify**: `npx vitest run test/integration/slack-outbox.test.ts test/integration/outbox-crash-recovery.test.ts` → exit 0.

### Step 5: Post and resolve review cards, and handle buttons

Create `src/slack/cards.ts` with pure Block Kit builders. They take the same
input types as the Discord builders (`ReviewProposalInput` and the
channel-policy card input):

- Proposal card: a header block, section blocks for target, score, reason, and
  the quoted proposed message (converted with `toSlackMrkdwn`; section text is
  at most 3,000 characters, so truncate with the same rule that
  `src/discord/review-message.ts` uses for embed fields), and an actions block
  with Approve and Dismiss buttons. Each button's `action_id` is the signed id
  from `signReviewComponent`. Set `value` to the same string.
- Channel-policy card: the same shape, with buttons from the signed
  channel-policy ids and a context block whose `block_id` is the marker.

Create the Slack card port members: `postProposalReview`,
`postChannelPolicyReview`, `findByMarker` (pages the review channel history and
matches the context `block_id`), and `resolve` (`chat.update` with the label as
the only section and no actions block).

Create `src/slack/actions.ts`. Register one Bolt action listener for ids that
start with `cass:`. In the listener:

1. Call `ack()` first, before any database or network work.
2. Check that the payload `team.id` equals the workspace id and that the
   channel is the configured review channel. Otherwise answer with an
   ephemeral refusal.
3. Resolve the actor; refuse when the actor is not an admin.
4. Pass the action id to the existing parse and handler functions
   (`parseReviewComponent`, `parseChannelPolicyReviewComponent`, and the
   handlers from `src/discord/interactions.ts:51` and the channel-policy
   handler, or their plan 005 locations).
5. Send the handler's text with `respond({ response_type: 'ephemeral' })`.

Derive the review secret from the active platform bot token (decision 12).
If plan 005 already did this, change nothing.

Write `test/integration/slack-cards.test.ts`: card blocks for a normal
proposal and a long one; the marker `block_id`; `findByMarker` hit and miss;
`resolve` removes the buttons; a bad signature, a wrong team, a wrong channel,
and a non-admin each produce no state change; an approve runs the same
transition that `test/integration/review-message.test.ts` asserts for Discord;
`ack` is called before the handler (assert call order on the fake).

**Verify**: `npx vitest run test/integration/slack-cards.test.ts test/integration/review-message.test.ts test/integration/channel-policy-review.test.ts` → exit 0.

### Step 6: Accept thread replies to scheduled notices

On Slack, a human reply to a scheduled notice is a thread reply. Change
`src/memory/scheduled-feedback.ts:69-90` so a reply also matches when the
reply's channel is a thread row whose `parent_id` equals the outbox
`channel_id`, and the reply's `reply_to_message_id` (the thread root) equals the
outbox created-message id. Keep every other check. Do not accept a thread
under a different parent. Discord behavior does not change, because a Discord
reply to Mneme stays in the same channel row.

In the Slack normalizer from plan 006, set `replyToMessageId` of a thread
reply to the thread root message id `<channelId>-<thread_ts>` (Assumption 5).
Add a normalizer test for it.

Extend `test/integration/scheduled-review.test.ts`: a Slack-shaped thread reply
to the notice updates the record; a thread reply under another parent does
not; a top-level message in the channel does not.

Change `SCHEDULED_NOTIFICATION_FOOTER` only if plan 004 made the footer
platform-specific. "Reply to this message" is correct on Slack, because a
reply starts a thread.

**Verify**: `npx vitest run test/integration/scheduled-review.test.ts` → exit 0.

### Step 7: Parse and dispatch the `/mneme` slash command

Create `src/slack/command-parser.ts` with one pure function:
`parseSlackCommand(text, spec) → { ok: true, path, options } | { ok: false, error }`,
where `spec` is `MNEME_SUBCOMMANDS` and `MNEME_SUBCOMMAND_GROUPS`
(`src/discord/commands.ts:62`, `:129`). Follow the grammar under "Decisions in
this plan". Validate `choices` and `integer` options. Reject unknown
subcommands, missing required options, and extra arguments with an error that
names the expected usage.

Create `src/slack/commands.ts`. Register a Bolt `command('/mneme')` listener:

1. Call `ack()` at once with no text.
2. Refuse when `team_id` is not the workspace id, or when `channel_id` starts
   with `D` or `G` and is a DM or group DM (`channel_name` is
   `directmessage` or `mpdm-…`): "Use /mneme in a workspace channel."
3. Parse the text. On a parse error or `help`, reply with usage.
4. Build the neutral invocation and call the same route table that the Discord
   dispatcher uses (plan 005). The invocation channel is `channel_id`, so the
   deletion commands' review-channel rule
   (`src/discord/commands/deletion.ts:34-36`) works without change.
5. Reply with `respond({ response_type: 'ephemeral', text })`. Convert the text
   with `toSlackMrkdwn` in ephemeral mode. Cap it at 3,900 characters with the
   same truncation suffix as `src/discord/command-dispatcher.ts:39-41`.
6. On an exception, log the subcommand name only (no content) and reply with
   the same failure text as the Discord dispatcher.

Add a test that fails when a subcommand in the spec has no parse path, the same
way `listCommandDispatcherRouteNames` keeps Discord aligned.

Write `test/unit/slack-command-parser.test.ts`: every flat subcommand and every
group subcommand from the spec parses with valid input; quotes and `\"`;
rest-of-line strings; user and channel tokens with and without `|name`;
invalid choices and integers; unknown names; extra arguments; empty text gives
help. Write `test/integration/slack-commands.test.ts`: a non-admin is refused;
a wrong team is refused; a DM is refused; `deletion status` outside the review
channel is refused by the existing rule; `status` returns the same text as the
Discord route for the same database; `ack` is called before the route.

**Verify**: `npx vitest run test/unit/slack-command-parser.test.ts test/integration/slack-commands.test.ts test/integration/command-dispatcher.test.ts test/unit/commands.test.ts` → exit 0.

### Step 8: Admins, approvers, and backup notices

1. Plan 006 reads `MNEME_ADMIN_USER_IDS` (required, at least one id) with the
   Slack id validator. Do not add a second reader. Make
   `MNEME_DELETION_APPROVER_USER_IDS` use the Slack validator when
   `MNEME_PLATFORM=slack`.
2. The Slack actor resolver returns `{ userId, isAdmin: adminUserIds.has(userId) }`.
3. Backup notice: replace the Discord DM at `src/production-runtime.ts:1690-1694`
   with the platform `sendDirect` member. The Slack implementation calls
   `chat.postMessage` with `channel` set to the user id and the text converted
   by `escapeSlackText`. The text must name the platform correctly ("Ask me in
   a Slack channel by mentioning @Mneme"). Use the spike result from Step 1,
   item 5.

Add tests for the config parse (valid, invalid, empty) and for the backup
notice text on Slack (no Discord wording, no mention token).

**Verify**: `npm run check && npm run check:test` → exit 0, and the new tests
pass.

### Step 9: Amend the spec and configuration docs

Update `MNEME_IMPLEMENTATION_SPEC.md`. Add Slack subsections, and do not
change the Discord rules:

- 6.6: admins on Slack are the user ids in `MNEME_ADMIN_USER_IDS`.
- 10.1: Slack outbox recovery uses the dedupe carrier from Step 1.
- 10.2: Slack channel-policy cards are found by the context `block_id` marker.
- 24.5: the mrkdwn conversion rules and the guarantee that no mention survives.
  A reply anchor becomes a thread reply.
- 25: Slack review cards use Block Kit buttons with the same signed ids, and
  the action is acknowledged before work starts.
- 26: a direct answer on Slack is a thread reply to the question.
- 27: the Slack command grammar, `help`, and the DM refusal.

Add `MNEME_ADMIN_USER_IDS` to `docs/reference/configuration.md`.

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0.

### Step 10: Run the repository gate and a manual review-mode test

**Verify**:

- `npm run verify` → exit 0.
- `git diff --check` → exit 0 with no output.
- `git status --short` → only in-scope files are changed.
- In the test workspace, with `MNEME_PLATFORM=slack` and mode `review`: a
  seeded contradiction produces a proposal card in the review channel; Approve
  posts the message in the target channel with inline links that open the
  correct messages; Dismiss removes the buttons; `/mneme status` answers
  ephemerally; a mention of Mneme with a question gets a thread reply. Record
  the result in the PR description.
- Update this plan's row in `plans/README.md` to `DONE`.

## Test plan

- Converter: every construct, nesting, code spans, hostile mention and link
  input, and a performance bound.
- Sender: targets, thread roots, the cross-channel guard, forbidden
  parameters, the dedupe carrier, and error classification.
- Recovery: marker match, no match, and another bot's message.
- Cards: block shape, truncation, marker lookup, resolve, signature checks,
  team and channel checks, admin checks, and `ack` order.
- Feedback: a thread reply to a scheduled notice updates the record; other
  replies do not.
- Commands: a parse path for every spec entry, the grammar, refusals, parity
  with the Discord routes, and `ack` order.
- Config: Slack id lists for admins and approvers.
- Regression: all Discord outbound, card, command, and recovery tests pass
  without edits.

## Done criteria

- [ ] The spike results are recorded, and the dedupe carrier is chosen.
- [ ] No outbound Slack string can contain a mention token or a link that is
  not host-built (converter tests prove it).
- [ ] Replies go to the anchor's thread root; check 7 is unchanged and holds.
- [ ] In-flight outbox rows recover on Slack without a duplicate post.
- [ ] Proposal and channel-policy cards work in Slack with signed ids, `ack`
  first, and admin checks.
- [ ] Thread replies to scheduled notices update the record.
- [ ] Every `/mneme` subcommand and group subcommand works on Slack, and a test
  fails if the spec and the parser drift.
- [ ] Backup notices reach the requester on Slack with correct wording.
- [ ] The spec and the configuration reference describe the Slack write path.
- [ ] `npm run verify` exits 0, and `git diff --check` is clean.
- [ ] A manual review-mode run in a test workspace passed.
- [ ] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back without improvising if:

- Any assumption in "Assumptions" is false and the fix needs edits outside the
  in-scope files.
- The spike shows that thread replies, metadata, or `block_id` behave
  differently from this plan, and no carrier for the dedupe marker works.
- The spike shows that users cannot see `chat.postMessage` DMs with the
  configuration from decision 14.
- The converter cannot guarantee that no mention survives without trusting
  model-authored text.
- The Discord route table cannot accept a neutral invocation without changes
  to handler logic.
- Check 7 would need a change to allow Slack replies. This means the thread
  model in plan 006 differs from decision 3.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- The converter is a trust boundary. Review every change to it as a security
  change. Add a hostile test case for each new construct.
- Keep the Slack parser derived from the command spec. Do not add Slack-only
  subcommands.
- Slack may add new mention or special-token forms. Escaping `<` and `>` in all
  non-host text keeps the converter safe, so do not add exceptions to that
  rule.
- If Slack stops returning metadata or `block_id` in history, outbox recovery
  can post duplicates after a crash. The spike test in Step 1 is the check;
  repeat it after Slack API changes.
