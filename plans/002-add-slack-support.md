# Plan 002: Add Slack support (umbrella)

> **Executor instructions**: This is an umbrella plan. It records the decisions
> and the order of work. Do not implement from this file. Execute the child
> plans 003–010 in order. Each child plan is self-contained and has its own
> verification and STOP conditions. If a child plan conflicts with a decision
> in this file, stop and report.
>
> **Drift check (run first)**: `git diff --stat cc84413..HEAD -- src migrations MNEME_IMPLEMENTATION_SPEC.md`
> If the seam or thread model changed since this plan was written, re-validate
> the decisions below before you start a child plan.

## Status

- **Priority**: P1
- **Effort**: XL (8 child plans)
- **Risk**: HIGH (visibility boundaries move to a second platform)
- **Depends on**: rename to Mneme (`cc84413`)
- **Category**: feature
- **Planned at**: commit `cc84413`, 2026-10-01

## Why this matters

Mneme supports only Discord. Many teams keep their decisions in Slack. The core
(ingestion policy, episodes, memory, agent, review, MCP) does not need Discord.
Only the edges need it: the connection, discovery, history pagination, outbound
send, cards, commands, identity, links, and formatting. This plan puts those
edges behind one adapter interface and adds a Slack adapter. One deployment
serves one platform.

## Research summary

Sources: official Slack docs at `docs.slack.dev` and the Slack API Terms,
checked on 2026-10-01. Items marked UNVERIFIED must be tested before the plan
that depends on them is marked done.

- **Rate limits.** Since 2025-05-29, `conversations.history` and
  `conversations.replies` allow 1 request per minute and 15 messages per page
  for commercially distributed apps that are not in the Marketplace. Internal
  customer-built apps keep Tier 3 (50+ requests per minute, up to 999 messages
  per page). Mneme is self-hosted and each team creates its own Slack app, so it
  is an internal app. A paid hosted Mneme would be commercial distribution and
  is out of scope.
- **API Terms (2025-10-10).** The Data Access API and the Real-Time Search API
  forbid long-term stores. Mneme must read with `conversations.history` and
  `conversations.replies` only. The terms for apps "offered for use outside your
  organization" forbid LLM training and cross-organization use. Mneme does
  neither.
- **Socket Mode** is supported. It needs an app-level `xapp-` token with
  `connections:write`. Socket Mode apps cannot be listed in the Marketplace.
  This is acceptable. `@slack/bolt` 5.x supports Socket Mode on Node 20+.
- **Visibility.** The bot sees only the channels where it is a member. Private
  channel lists contain only channels that the bot shares. `is_private`
  identifies private channels; `is_channel` is not reliable. `is_ext_shared`
  and `is_pending_ext_shared` identify Slack Connect channels.
- **Threads.** A reply has `thread_ts != ts`. `conversations.history` does not
  return replies. Backfill must call `conversations.replies` once for each
  parent message that has `reply_count > 0`. No API lists threads
  (UNVERIFIED that none exists). Whether edits and deletes of replies emit
  `message_changed` and `message_deleted` is UNVERIFIED.
- **IDs.** `ts` is unique only in one channel. An edit keeps `ts`. History
  returns newest first.
- **Mentions.** Slack has no `allowed_mentions`. Mneme must escape `&`, `<`,
  and `>`, must never send `link_names`, and must remove `<@…>`, `<!…>`, and
  `<!subteam^…>` from content that it did not build.
- **Permalinks.** `chat.getPermalink` is documented. A URL that Mneme builds
  itself (`https://<domain>.slack.com/archives/<C>/p<ts without dot>`) is not
  documented (UNVERIFIED that it keeps working).
- **Sign in with Slack** (OpenID Connect) returns `https://slack.com/user_id`
  and `https://slack.com/team_id` claims.
- **Slash commands** must be acknowledged in 3,000 ms. They cannot be used in
  threads.

## Decisions

Each child plan must follow these decisions. Change a decision only through
this file.

1. **One platform per deployment.** `MNEME_PLATFORM=discord|slack` selects the
   adapter at startup. There is no default; a missing value fails startup. One
   database holds data from one platform. There is no `platform` column.
2. **No backward compatibility.** Rename columns, env vars, and types where it
   makes the code clearer. Migrations may rename columns. Existing deployments
   restore from a fresh database or apply migrations in order.
3. **Slack thread = synthetic channel row.** The core models a thread as a
   `channels` row with `is_thread = 1` and `parent_id`. The Slack adapter keeps
   this model. A Slack thread gets the id `<channelId>-T<thread_ts>` (example
   `C0123ABCD-T1712345678.000100`) and `parent_id = <channelId>`. The adapter
   splits the id into `channel` and `thread_ts` when it calls Slack. The
   conversation key, scope anchoring, test-surface rule, sync cursors, and
   outbound check 7 (`src/agent/policy.ts:430`) then work without change.
4. **Slack message id = `<channelId>-<ts>`.** It is unique in the
   `messages.id` primary key. A thread reply uses the parent channel id in its
   message id and the thread row id in `channel_id`. The thread root message
   stays in the parent channel, as a Discord thread-starter message does.
   A `thread_broadcast` reply is stored once, in the thread.
5. **Characters in ids.** Platform ids match `^[A-Za-z0-9.-]+$`. Each adapter
   gives an id validator. The `/^\d{17,20}$/` checks move behind it.
6. **Ordering.** The core orders messages by `created_at_ms` with the id as a
   tie-break. Slack `ts` values have a fixed width until the year 2286, so a
   lexical tie-break is correct. The adapter computes `createdAtMs` from `ts`.
   `snowflakeToMs` stays in the Discord adapter.
7. **Neutral text format.** The core keeps producing the Markdown subset that
   it produces now: `**bold**`, `*italic*`, `[label](url)`, `> quote`, and
   inline code. The Slack adapter converts this subset to mrkdwn and escapes
   everything else. Mention parsing and stripping move behind the adapter
   format object.
8. **Links.** One `messageLink(channelId, messageId)` function on the adapter
   replaces the five hard-coded `discord.com` builders. The Slack adapter builds
   `https://<team_domain>.slack.com/archives/<C>/p<ts without dot>` and adds
   `?thread_ts=<root>&cid=<C>` for replies. It reads the domain from `auth.test`
   at startup. Plan 006 must test that these links open the correct message.
9. **Visibility on Slack.** The bot does not join channels itself. An admin
   invites it (`/invite @Mneme`); the invite is the consent. Every new channel
   is `restricted`, as on Discord. A Slack Connect channel (`is_ext_shared` or
   `is_pending_ext_shared` is true) is always `excluded`. Policy cannot
   override this, and a channel that becomes shared later is excluded at once.
   A channel that the bot leaves becomes unavailable and fails closed.
   The policy resolver gets a `platform_boundary` source that the adapter
   supplies. It wins over every other source, including explicit thread rules
   and review decisions (`resolveEffectiveChannelPolicy`,
   `src/discord/channel-policy-review.ts:34-58`, has no such source now).
   Slack cannot list threads, so the adapter builds thread descriptors from
   stored thread rows whose parent is present, and discovery runs with the
   `close` missing-thread mode, not `quarantine`
   (`src/discord/discovery.ts:406-458`).
10. **Admins on Slack.** Slack has no roles. `MNEME_ADMIN_USER_IDS` lists Slack
    user ids. The adapter resolves an actor to `{ userId, isAdmin }`. The core
    authorizes from that result and fails closed when the result is missing.
11. **Commands on Slack.** One `/mneme` slash command. The adapter parses the
    text (`/mneme recap status 42`) into the same subcommand path and options
    that the Discord dispatcher gives the handlers in `src/discord/commands/*`.
    Replies are ephemeral.
12. **Cards on Slack.** Block Kit messages with buttons. The HMAC action ids
    stay as they are. The review secret is derived from the active platform
    bot token.
13. **Outbox dedupe on Slack.** Slack has no message nonce. The Slack sender
    attaches message metadata (`event_type: mneme_outbox`, payload with the
    dedupe marker). Outbox recovery reads recent bot messages with
    `include_all_metadata=true` (UNVERIFIED: confirm the scope that reading
    metadata needs). If metadata cannot be read, the sender puts the marker in
    a Block Kit `block_id`, which needs no extra scope.
    Slack has no reply reference. A reply anchor becomes a thread reply under
    the anchor's thread root. Scheduled feedback must find replies in the
    thread row, not only in the outbox channel
    (`src/memory/scheduled-feedback.ts:77`); plan 007 step 6 does this.
14. **Direct messages on Slack.** Mneme does not read DMs. The App Home
    Messages tab stays visible but does not accept user input, so no DM notice
    is necessary and admins still see backup notices (UNVERIFIED: plan 007
    step 1 tests this). Backup notices to admins
    use `chat.postMessage` to the user id (`im:write`).
15. **MCP OAuth.** The Slack adapter supplies Sign in with Slack. A user signs
    in only if `team_id` equals the configured workspace. Admin status comes
    from `MNEME_ADMIN_USER_IDS`. The grant stays org scope, as on Discord.
16. **Column names.** `guild_id` becomes `workspace_id`, `discord_message_id`
    becomes `platform_message_id`, and the MCP field `discordLink` becomes
    `link`. Plan 004 does this in one mechanical change.
17. **Channel kind.** `channels.type INTEGER NOT NULL`
    (`migrations/001_core.sql:27`) holds Discord channel type numbers. Plan 005
    replaces it with a `kind` text column (a platform-neutral enum). The
    Discord adapter maps its numeric types to `kind`.
18. **Slack attachment id = `<messageId>-<fileId>`.** One Slack file can be
    shared into more than one message. The attachment upsert
    (`src/db/repositories/attachments.ts:55`) never changes `message_id`, so a
    bare file id would lose the second row, and a delete of the first message
    would purge a file that the second message still shows.
19. **Adapter directory.** Platform adapters live in `src/platform/discord/`
    and `src/platform/slack/`. The interface lives in `src/platform/`.

## Child plans

| Plan | Title | Depends on |
|---|---|---|
| 003 | Amend the spec for platform adapters and Slack | — |
| 004 | Make names, ids, links, and text format platform-neutral (Discord only) | 003 |
| 005 | Extract the `ChatPlatform` adapter seam (Discord only) | 004 |
| 006 | Add the Slack read path: connection, discovery, visibility, ingestion, backfill | 005 |
| 007 | Add the Slack write path: send, outbox recovery, cards, commands | 006 |
| 008 | Add Sign in with Slack for MCP OAuth | 006 |
| 009 | Archive Slack attachments | 006 |
| 010 | Document Slack setup and ship the app manifest | 007, 008, 009 |

Plans 004 and 005 must not change Discord behavior. The full test suite is
the proof. Plan 006 is the first plan that adds Slack code. A Slack deployment
can run in `observe` mode after plan 006 and in `review` mode after plan 007.

## Risks

- **Leaks through Slack Connect.** A shared channel contains people from other
  organizations. Decision 9 makes it excluded with no override. Plan 006 must
  test the change from not shared to shared.
- **Thread discovery cost.** Backfill calls `conversations.replies` once for
  each parent that has replies. Large workspaces have many threads. Tier 3
  limits make this slow but possible. Backfill must obey `Retry-After`.
- **Thread replies without events.** If edits or deletes of replies emit no
  events, reconcile must re-read recent threads. Plan 006 must test this first.
- **Built permalinks.** If Slack stops resolving built links, use
  `chat.getPermalink` and cache the result on the message row.
- **Formatting gaps.** A conversion error can cause a ping or a broken link.
  The converter must have tests for every construct that the core emits and
  for hostile input.

## Out of scope

- One deployment that serves Discord and Slack at the same time.
- Slack Marketplace distribution or a hosted, multi-tenant Mneme.
- Enterprise Grid org-wide installs. Mneme installs in one workspace.
- Reading DMs or group DMs (`mpim`).
- Huddles, canvases, lists, and workflow steps.
- Auto-join of public channels.

## Findings considered and rejected

- **A separate `mneme-slack` repository.** Rejected: most fixes land in the
  shared core, so every fix would need a second port.
- **A `thread_root_id` column through messages, episodes, proposals, and
  outbox.** Rejected: decision 3 keeps the current thread model and changes
  only the adapter.
- **Auto-join every public channel.** Rejected: the invite is a clear consent
  signal and fails closed.
- **Caching `chat.getPermalink` for every message at ingest.** Deferred: it
  costs one call for each message during backfill. Use it only if built links
  fail (see Risks).
