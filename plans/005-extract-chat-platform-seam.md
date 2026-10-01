# Plan 005: Extract the `ChatPlatform` adapter seam (Discord only)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: This plan was written at `cc84413`, before
> plan 004. Plan 004 must be merged first. Plan 004 renames `guild_id` to
> `workspace_id`, `discord_message_id` to `platform_message_id`, and
> `discordLink` to `link`, and it puts the message-link builders and the
> snowflake id checks behind one function each. Line numbers below are from
> `cc84413` and can move by some lines after plan 004. Run
> `git diff --stat cc84413..HEAD -- src/bootstrap.ts src/production-runtime.ts src/outbox/recovery.ts src/config.ts src/discord src/mcp/oauth`
> and compare the "Current state" excerpts with the live code. If an excerpt
> has a different *meaning* (not only different names or line numbers), treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (two PRs: Part A and Part B)
- **Risk**: MED (wide file moves; no behavior change)
- **Depends on**: plan 004
- **Category**: refactor
- **Planned at**: commit `cc84413`, 2026-10-01

## Why this matters

Plan 002 adds Slack as a second platform (one platform per deployment). The
core does not need Discord, but today the Discord code and the neutral code
sit together in `src/discord/`. The composition code also uses a discord.js
client directly. This plan puts every Discord-specific part behind one
`ChatPlatform` interface and moves the neutral code into core directories.
Discord behavior must not change. The full test suite is the proof. After this
plan, plan 006 adds a Slack adapter that implements the same interface.

## Current state

- `src/discord/` holds 28 files plus 16 command handlers. Only 9 files import
  `discord.js`: `channel-policy-review-interactions.ts`,
  `channel-policy-review-message.ts`, `client.ts`, `command-dispatcher.ts`,
  `commands.ts`, `interactions.ts`, `production-adapters.ts`,
  `review-message.ts`, and `sender.ts`. No file in `src/discord/commands/`
  imports `discord.js`; each handler takes an actor and returns text.
- Some files do not import `discord.js` but still parse Discord payloads:
  - `src/discord/normalize.ts:134` `snowflakeToMs` and `:227`
    `normalizeMessage(raw)` read Discord REST shapes.
  - `src/discord/ingest.ts:460-533` `GatewayEventType`, `channelInputFromRaw`
    and `:625` `handleGatewayEvent` use Discord event names and numeric
    thread types (`:502` `const THREAD_TYPES = new Set([10, 11, 12]);`).
  - `src/discord/discovery.ts:38-59` defines Discord numeric channel types.
    `DiscoveredChannelDescriptor` (`:67-78`) has `type: number`.
  - `src/discord/authorization.ts:70-105` `MemberWithRoles` and
    `extractMemberRoleIds` read a discord.js member.
  - `src/discord/ingest.ts:377-382` takes a raw Discord emoji object, and
    `ingestReactionAdd` / `ingestReactionRemove` (`:409`, `:429`) derive the
    key with the Discord-shaped `emojiKeyOf`:

    ```ts
    export interface ReactionEventInput {
      messageId: string;
      userId: string;
      /** Raw Discord emoji object ({ name, id? }). */
      emoji: unknown;
    }
    ```

- Discovery treats a missing thread with a `missingThreadMode`
  (`src/discord/discovery.ts:80-99`, applied at `:406-458`). The default is
  `quarantine`. The callers choose the mode from Discord archive-scan coverage:
  `src/discord/sync.ts:134` (`deps.archiveSource ? 'preserve' : 'quarantine'`),
  `:193`, `:218` (`archivedCoverageComplete ? 'close' : 'quarantine'`), and
  `src/discord/threads.ts:218`, `:256`. A platform that cannot list threads
  (Slack, plan 002 decision 9) needs a way to say "this snapshot is complete;
  use `close`". There is no such way now.
- The numeric channel type reaches core logic only in
  `src/discord/discovery.ts:180,217,221`, `src/discord/threads.ts:31-35,99-105,162,204`,
  and `src/discord/sync.ts:170`. The database stores it in
  `channels.type INTEGER NOT NULL` (`migrations/001_core.sql:27`) through
  `src/db/repositories/channels.ts:20,41,60-111`. No index uses this column.
- Only two files outside `src/discord/` import `discord.js`:
  - `src/production-runtime.ts:111`:

    ```ts
    import { Events, type Interaction } from 'discord.js';
    ```

    It is used at `:1764-1769`:

    ```ts
    client.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (interaction.isButton()) {
        void reviewButtons(interaction);
        if (channelPolicyReviewButtons) void channelPolicyReviewButtons(interaction);
      }
    });
    ```

  - `src/outbox/recovery.ts:1` imports `Client`.
    `createDiscordRecentSentLookup(client, mnemeId)` (`:188-218`) pages
    `channel.messages.fetch` and reads `m.nonce` as the dedupe marker.
- `src/bootstrap.ts:80-87` is the closest thing to an adapter boundary today:

  ```ts
  export interface DiscordWiring {
    /** The discord.js client, when a real one was created. */
    client?: any;
    /** The health tracker, when one is in use. */
    tracker?: any;
    /** Disconnect the Gateway (shutdown step 7). */
    destroy(): Promise<void> | void;
  }
  ```

  `BootstrapSeams` (`:118-135`) has `connectDiscord`, `beginIngestion`,
  `registerCommands`, `discoverAndBackfill`, and `startJobRuntime`, and each
  takes a `DiscordWiring`. `BootstrapContext.discordToken` is at `:114`. The
  default connect (`:543-582`) lazily imports `./discord/client.js`, registers
  ingestion handlers before login, and calls `client.login`. Bootstrap tests
  override these seams; follow that pattern.
- `src/production-runtime.ts:1107-1112` `createProductionJobRuntime(ctx, discord)`
  reads `discord.client` and throws when it is missing. It builds every Discord
  adapter in one place: the sender, fetcher, review channel, resolvers,
  channel-policy port, and recent-sent lookup. It reads
  `ctx.config.discord.guildId` and `ctx.config.discord.applicationId` at
  about 40 sites (`:728-1771`).
- `src/production-runtime.ts:1397` derives the review secret from the Discord
  token:

  ```ts
  const reviewSecret = createHash('sha256').update(ctx.config.discord.token).update(':review-components').digest('hex');
  ```

- Small ports already exist and can stay as they are: `OutboxSender`
  (`src/discord/sender.ts:28`), `RecentSentMessageLookup`
  (`src/outbox/recovery.ts:37`), `ReviewChannel`
  (`src/discord/review-message.ts:191`), `ChannelPolicyReviewDiscordPort`
  (`src/discord/channel-policy-review-message.ts:99`), `BackfillMessageFetcher`
  (`src/discord/backfill.ts:27`), `ThreadArchiveSource`
  (`src/discord/threads.ts:45`), `FetchBytes`
  (`src/discord/attachments.ts:33`), and `DiscordIdentityClient`
  (`src/mcp/oauth/discord.ts:58`).
- `src/config.ts:62-66` `DiscordConfig {token, applicationId, guildId}` is
  required. It is loaded at `:771-774`. `AppConfig.discord` is at `:321`.
  There is no platform setting.
- 45 test files import from `src/discord/`. The most-imported modules are
  `normalize.js` (14), `ingest.js` (9), and `channel-policy.js` (7).
- `.oxlintrc.json` has only a complexity rule. There is no import guard.

## Target layout

| Directory | Holds |
|---|---|
| `src/platform/` | The `ChatPlatform` interface, neutral message and channel types, `ChannelKind`, `Actor`, normalized events, and `createPlatform(config)`. |
| `src/platform/discord/` | Every file that imports `discord.js` or parses a Discord payload: `client.ts`, `production-adapters.ts`, `sender.ts`, `review-message.ts` (card rendering), the channel-policy card rendering, `commands.ts` (builders and registration), `command-dispatcher.ts` (option extraction, defer, reply), `interactions.ts`, Discord `normalize`, `snowflakeToMs`, Gateway event mapping, Discord channel type constants, `extractMemberRoleIds`, the recent-sent lookup, and `src/mcp/oauth/discord.ts`. |
| `src/ingestion/` | `ingest.ts` (without Gateway mapping), `backfill.ts`, `reconcile.ts`, `sync.ts`, `discovery.ts` (without Discord constants), `threads.ts`, `ingestion-eligibility.ts`, `test-channels.ts`, `attachments.ts`, and `mentions.ts`. |
| `src/policy/` | `channel-policy.ts`, `channel-policy-bootstrap.ts`, `channel-policy-review.ts`, `channel-policy-review-service.ts`, the neutral parts of the channel-policy review interactions, and the pure parts of `authorization.ts`. |
| `src/commands/` | All handlers from `src/discord/commands/`. |
| `src/outbound/` | `message-safety.ts`. Mention parsing goes behind `platform.format` (Step 7). |

`src/discord/` must not exist at the end of this plan.

## The interface

Put this in `src/platform/types.ts`. Trim a member if no core caller needs it
after Part B. Do not add members that no caller uses.

```ts
export type PlatformId = 'discord';   // plan 006 adds 'slack'

export type ChannelKind = 'text' | 'announcement' | 'forum' | 'media' | 'category' | 'thread';

export interface Actor { userId: string; isAdmin: boolean }

export type PlatformEvent =
  | { type: 'message_create'; message: NormalizedMessage }
  | { type: 'message_update'; patch: NormalizedMessagePatch }
  | { type: 'message_delete'; channelId: string; messageIds: string[] }
  | { type: 'reaction_add' | 'reaction_remove'; channelId: string; messageId: string; userId: string;
      emojiKey: string; emojiName: string | null }
  | { type: 'reaction_remove_all'; channelId: string; messageId: string }
  | { type: 'channel_upsert'; channel: DiscoveredChannelDescriptor }
  | { type: 'channel_delete'; channelId: string }
  | { type: 'direct_message'; userId: string };

export interface ChatPlatform {
  id: PlatformId;
  workspaceId: string;        // was config.discord.guildId
  selfUserId: string;         // was config.discord.applicationId
  reviewSecret: string;       // sha256(bot token + ':review-components')

  connect(onEvent: (event: PlatformEvent) => void): Promise<void>;
  destroy(): Promise<void>;
  health(): PlatformHealth;   // same fields the tracker reports today

  listChannels(): Promise<DiscoveredChannelDescriptor[]>;
  /**
   * How the core learns about threads.
   * `archive_scan`: listChannels gives active threads only; the core pages the
   *   archive and keeps today's preserve/close/quarantine logic (Discord).
   * `complete_snapshot`: listChannels already gives every known thread; the
   *   core skips the archive scan and runs discovery with `close` (Slack).
   */
  threadDiscovery:
    | { mode: 'archive_scan'; archive: ThreadArchiveSource }
    | { mode: 'complete_snapshot' };

  history: {
    /** Newest first. `cursor` is opaque to the core. */
    fetchPage(channelId: string, cursor: string | undefined, limit: number): Promise<NormalizedMessage[]>;
    fetchOne(channelId: string, messageId: string): Promise<NormalizedMessage | null>;
  };
  recentSent: RecentSentMessageLookup;

  sender: OutboxSender;
  sendDirect(userId: string, text: string): Promise<void>;
  fetchBytes: FetchBytes;

  cards: {
    review: ReviewChannel;
    resolveReview: ReviewResolver;
    channelPolicy: ChannelPolicyReviewPort;
  };
  registerCommands(spec: CommandSpec): Promise<void>;
  onCommand(handler: (cmd: CommandInvocation) => Promise<string>): void;
  onAction(handler: (action: ActionInvocation) => Promise<string | null>): void;

  resolveActor(userId: string, context: unknown): Actor | null;   // null = fail closed
  oauthIdentity?: OAuthIdentityClient;

  isValidId(kind: 'channel' | 'user' | 'message' | 'attachment' | 'role', id: string): boolean;
  messageLink(channelId: string, messageId: string): string;
  format: PlatformFormat;
}

export interface PlatformFormat {
  /** Convert the core Markdown subset to platform text. Discord: identity. */
  render(markdown: string): string;
  parseMentions(text: string): ParsedMention[];
  stripMentions(text: string): string;
  channelRef(channelId: string, name: string | null): string;
  userRef(userId: string): string;
  maxMessageChars: number;
}
```

`CommandInvocation` is `{ path: string[]; options: Record<string, string | number | boolean | null>; actor: Actor | null; channelId: string }`.
`ActionInvocation` is `{ actionId: string; actor: Actor | null; channelId: string; messageId: string }`.
The core verifies the HMAC in `actionId` with `reviewSecret`, as it does now.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run check && npm run check:test` | exit 0; no TypeScript errors |
| Lint | `npm run lint` | exit 0; no warnings |
| Boundary test | `npx vitest run test/unit/platform-boundary.test.ts` | exit 0; all tests pass |
| Full verification | `npm run verify` | exit 0; SQLite check, lint, both typechecks, tests, and build all pass |
| Docs checks | `npm run docs:check-public && npm run docs:check-links` | exit 0; no errors |
| Find stale paths | `git grep -n "src/discord/\|'\./discord/\|\.\./discord/"` | no output at the end of Part A |

## Scope

**In scope**:

- Everything under `src/discord/` (moved; then the directory is removed).
- `src/platform/**` (new).
- `src/ingestion/**`, `src/policy/**`, `src/commands/**`, `src/outbound/**` (new; filled by moves).
- `src/bootstrap.ts`, `src/production-runtime.ts`, `src/main.ts`, `src/config.ts`, `src/config-reload.ts`.
- `src/outbox/recovery.ts`, `src/outbox/worker.ts`.
- `src/mcp/oauth/discord.ts` (moved), `src/mcp/oauth/callback.ts`, `src/review/workflow.ts`, `src/http/status.ts`.
- Every core file whose only change is an import path or a call to a platform member.
- A new migration `migrations/041_channel_kind.sql` (use the next free number).
- `src/db/repositories/channels.ts`.
- Test files: import paths, and the new `test/unit/platform-boundary.test.ts`.
- `.env.example`, `config/advanced.env.example`, `docs/reference/configuration.md` (the `MNEME_PLATFORM` row only).
- `MNEME_IMPLEMENTATION_SPEC.md` (the platform-adapter section from plan 003 and the configuration table).
- `contributor-docs/` pages that name `src/discord/` paths.
- `plans/README.md` (status update only).

**Out of scope** (do not touch):

- Any Slack code or the `@slack/bolt` dependency. Plan 006 adds them.
- Behavior changes: the text Discord users see, command names and options,
  card layout, HMAC format (`cass:rv:…`), job types, unique keys, or the
  startup order in `src/bootstrap.ts`.
- `src/fixture-mode.ts` beyond import paths. It is an offline smoke test, not
  an adapter.
- Renames that plan 004 owns (`workspace_id`, `platform_message_id`, `link`).
- Splitting `src/production-runtime.ts` into smaller files.

## Git workflow

- Part A branch: `advisor/005a-move-neutral-modules`. Commit:
  `refactor(platform): move platform-neutral modules out of src/discord`.
- Part B branch: `advisor/005b-chat-platform-seam` (from Part A). Commit:
  `refactor(platform): put Discord behind the ChatPlatform interface`.
- Open Part B only after Part A is merged. Do not push or open a PR unless the
  operator tells you to.

## Steps

### Part A: Move files, change no logic

Part A only moves files and changes import paths. If a move needs a logic
change, do it in Part B.

### Step 1: Add the boundary test (it must fail first)

Create `test/unit/platform-boundary.test.ts`. It reads every `.ts` file under
`src/` with `node:fs` and asserts:

1. No file outside `src/platform/discord/` contains `from 'discord.js'` or
   `import('discord.js')`.
2. No file outside `src/platform/discord/` imports from a path that contains
   `platform/discord/`, except `src/platform/select.ts` (Part B creates it).
3. `src/discord/` does not exist.

Mark assertions 2 and 3 with `it.todo` in Part A if they cannot pass until
Part B. Assertion 1 must fail now: report the failure output in the PR.

**Verify**: `npx vitest run test/unit/platform-boundary.test.ts` → assertion 1
fails and lists `src/production-runtime.ts` and `src/outbox/recovery.ts`, plus
the files still in `src/discord/`.

### Step 2: Move the neutral modules

Use `git mv` so history follows each file. Move by the target layout table:

- `ingest.ts`, `backfill.ts`, `reconcile.ts`, `sync.ts`, `discovery.ts`,
  `threads.ts`, `ingestion-eligibility.ts`, `test-channels.ts`,
  `attachments.ts`, `mentions.ts` → `src/ingestion/`.
- `channel-policy.ts`, `channel-policy-bootstrap.ts`, `channel-policy-review.ts`,
  `channel-policy-review-service.ts`, `authorization.ts` → `src/policy/`.
- `src/discord/commands/*` → `src/commands/`.
- `message-safety.ts` → `src/outbound/`.
- The 9 files that import `discord.js`, plus `normalize.ts` →
  `src/platform/discord/`.
- `src/mcp/oauth/discord.ts` → `src/platform/discord/oauth-identity.ts`.

Update every import in `src/` and `test/`. Do not edit any line other than an
import line.

**Verify**:

- `npm run check && npm run check:test` → exit 0.
- `git diff -M --stat` → every moved file shows as a rename.
- `git diff -M -- src | grep '^[-+]' | grep -v '^[-+]\(import\|export .* from\|} from\|  [A-Za-z_, ]*,\?$\)' | grep -v '^\(+++\|---\)'` → no output (only import lines changed). Review any line it prints.

### Step 3: Split the Discord-only parts out of the moved neutral files

Each item below moves code from a neutral file into `src/platform/discord/`.
Do not change the code you move.

1. Move the neutral types out of `normalize.ts`: `NormalizedAuthor`,
   `NormalizedMention`, `NormalizedAttachment`, `NormalizedReactionCount`,
   `NormalizedMessage`, and `NormalizedMessagePatch` go to
   `src/platform/types.ts`. `normalizeMessage`, `normalizeMessageUpdate`,
   `snowflakeToMs`, and `emojiKeyOf` stay in `src/platform/discord/normalize.ts`.
2. Move `GatewayEventType`, `GATEWAY_EVENT_TYPES`, `GatewayEventResult`,
   `channelInputFromRaw`, the local `THREAD_TYPES`, and `handleGatewayEvent`
   from `src/ingestion/ingest.ts` to `src/platform/discord/gateway-events.ts`.
3. Move `MemberWithRoles` and `extractMemberRoleIds` from
   `src/policy/authorization.ts` to `src/platform/discord/authorization.ts`.
4. Move `descriptorsFromJsChannels` and `JsChannelDescriptorSource`
   (`discovery.ts:531-564`) to `src/platform/discord/`.
5. Make reaction input neutral. Change `ReactionEventInput` in
   `src/ingestion/ingest.ts` to
   `{ messageId: string; userId: string; emojiKey: string; emojiName: string | null }`.
   Remove the `emojiKeyOf` calls at `:409` and `:429`; keep the
   empty-key drop (`emojiKey === ''` returns `{ changed: false, dropped: true }`).
   The Discord Gateway mapping (`gateway-events.ts`) calls `emojiKeyOf`, and
   drops the event there when the key is `null`, with the same result type.
   This is the one logic move that Part A permits, because the moved file
   must not import Discord-shaped helpers. Add a unit test that a
   `MESSAGE_REACTION_ADD` payload with an emoji that has no key is still
   dropped.

**Verify**: `npm run verify` → exit 0. Then
`git grep -n "from 'discord.js'" -- src ':!src/platform/discord'` → only
`src/production-runtime.ts` and `src/outbox/recovery.ts`.

### Step 4: Fix the docs that name old paths

Update `src/discord/…` paths in `contributor-docs/`, `MNEME_IMPLEMENTATION_SPEC.md`,
and `AGENTS.md`, if they name paths. Do not change any other text.

**Verify**: `git grep -n "src/discord" -- ':!plans'` → no output.
`npm run docs:check-public && npm run docs:check-links` → exit 0.
`npm run verify` → exit 0. Commit Part A.

### Part B: Put Discord behind the interface

### Step 5: Add `ChannelKind` and stop using numeric channel types in core

1. Add `ChannelKind` to `src/platform/types.ts`. Replace
   `DiscoveredChannelDescriptor.type: number` with `kind: ChannelKind`.
2. In `src/platform/discord/channel-types.ts`, keep the numeric constants from
   `discovery.ts:38-59` and add `channelKindOf(type: number): ChannelKind | null`
   (`null` for an unsupported type). The Discord adapter computes `kind` when
   it builds a descriptor (`production-adapters.ts`, `gateway-events.ts`).
3. In `src/ingestion/discovery.ts`, `threads.ts`, and `sync.ts`, replace the
   numeric checks with kind checks:
   - `SUPPORTED_CHANNEL_TYPES.has(d.type)` becomes "`kind` is not `category`".
   - `THREAD_TYPES.has(d.type)` becomes `kind === 'thread'`.
   - `type === GUILD_CATEGORY` becomes `kind === 'category'`.
   - `isThreadCapableParent(type)` becomes a kind set: `text`,
     `announcement`, `forum`, `media`. Confirm this against
     `THREAD_CAPABLE_PARENT_TYPES` (`threads.ts:31-35`) before you change it.
4. Add the migration. It adds `kind TEXT NOT NULL DEFAULT 'text'`, fills it
   from `type` with a `CASE` that matches `channelKindOf`, and drops `type`.
   Update `src/db/repositories/channels.ts` to read and write `kind`.

**Verify**: `npx vitest run test/unit test/integration -t "discover|thread|sync|channel"`
→ exit 0. Then `npm run verify` → exit 0. Add a unit test for the migration
that seeds one row for each Discord type and asserts the `kind`.

### Step 6: Add `MNEME_PLATFORM` and the platform config

1. In `src/config.ts`, read `MNEME_PLATFORM`. The only valid value is
   `discord`. A missing or other value throws
   `ConfigError('required setting is missing', 'MNEME_PLATFORM')` or the
   existing invalid-value error. Keep `DiscordConfig` and load it only when the
   platform is `discord`.
2. Add `platform: 'discord'` to `AppConfig`.
3. Add `MNEME_PLATFORM=discord` to `.env.example`,
   `config/advanced.env.example`, every test config helper, the Docker and
   Railway examples, and the CI fixture environment in
   `.github/workflows/ci.yml`. Add the row to
   `docs/reference/configuration.md` and the spec configuration table.

**Verify**: `npx vitest run test/unit/config.test.ts` → exit 0, with new cases
for missing, invalid, and `discord`. `npm run verify` → exit 0.

### Step 7: Build the Discord `ChatPlatform`

Create `src/platform/types.ts` (the interface above) and
`src/platform/discord/platform.ts` with `createDiscordPlatform(config, logger, clock)`.
It composes the adapters that exist now. Do not write new Discord logic:

- `connect` uses `createDiscordClient`, registers the Gateway handlers, and
  maps each Gateway event to a `PlatformEvent` with the code from
  `gateway-events.ts`. Keep the rule that handlers are registered before
  `client.login`.
- `history` and `listChannels` wrap `createDiscordMessageFetcher` and
  `fetchDiscoveryDescriptors`. `threadDiscovery` is
  `{ mode: 'archive_scan', archive: createDiscordThreadArchiveSource(client) }`. `fetchPage` returns normalized messages, so
  move the `normalizeMessage` call from the core callers into the adapter.
- `recentSent` is `createDiscordRecentSentLookup`. Move it from
  `src/outbox/recovery.ts` into `src/platform/discord/`. Keep the
  `RecentSentMessage` and `RecentSentMessageLookup` types in
  `src/outbox/recovery.ts`.
- `sender`, `cards`, `sendDirect`, `registerCommands`, `onCommand`, and
  `onAction` wrap the current sender, card, command, and button code.
  `onAction` replaces the `client.on(Events.InteractionCreate, …)` block at
  `src/production-runtime.ts:1764-1769`.
- `resolveActor` uses `extractMemberRoleIds` and `authorizeAdmin` with
  `MNEME_ADMIN_ROLE_IDS`, and returns `null` when roles cannot be read.
- `reviewSecret` uses the exact expression from
  `src/production-runtime.ts:1397` so existing cards stay valid.
- `isValidId`, `messageLink`, and `format` call the functions that plan 004
  created. `format.render` returns its input unchanged on Discord.
- `fetchBytes` is `defaultFetchBytes`.
- `oauthIdentity` wraps `createDiscordIdentityClient`.

Add `src/platform/select.ts` with `createPlatform(config, logger, clock)`.
It switches on `config.platform`, and it is the only core file that imports
from `src/platform/discord/`.

**Verify**: `npm run check` → exit 0. Add
`test/unit/discord-platform.test.ts`. Use a stub client to assert that
`reviewSecret` matches the old expression, that `resolveActor` returns `null`
for a member without readable roles, and that a `MESSAGE_CREATE` payload maps
to one `message_create` event with the same `NormalizedMessage` as
`normalizeMessage`.

### Step 8: Wire bootstrap and the production runtime to the platform

1. In `src/bootstrap.ts`, replace `DiscordWiring` with
   `{ platform: ChatPlatform; destroy(): Promise<void> | void }`. Rename the
   seam `connectDiscord` to `connectPlatform`, and `discordToken` in
   `BootstrapContext` to nothing (the platform holds its token). Keep the
   step order and step numbers in the comments.
2. Move the platform-neutral ingestion callbacks in the default
   `beginIngestion` (`shouldIngestMessage`, `onMessageCreate`,
   `resolveChannelInput`, `onChannelChange`, `onMissingDependency`) into
   `src/ingestion/live.ts` as one `handlePlatformEvent(event, deps)`
   function. The default `connectPlatform` calls `platform.connect(handlePlatformEvent)`.
3. In `src/production-runtime.ts`, change `createProductionJobRuntime(ctx, discord)`
   to take the platform. Replace each `discord.client` use with the
   matching platform member. Replace `ctx.config.discord.guildId` with
   `platform.workspaceId` and `ctx.config.discord.applicationId` with
   `platform.selfUserId`. Remove the `discord.js` import at `:111`.
4. In `src/outbox/recovery.ts`, remove the `Client` import. The caller
   passes `platform.recentSent`.
5. In `src/bootstrap.ts:306`, take the OAuth identity client from
   `platform.oauthIdentity`.
6. Update the bootstrap tests that override `connectDiscord` to override
   `connectPlatform` with a stub platform.

**Verify**: `npx vitest run test/unit/platform-boundary.test.ts` → all
assertions pass. Remove the `it.todo` markers from Step 1.
`npm run verify` → exit 0.

### Step 8a: Let the platform choose thread discovery

In `src/ingestion/sync.ts`, read `platform.threadDiscovery`:

- `archive_scan`: keep the current code exactly. The archive source comes
  from `threadDiscovery.archive`, so `deps.archiveSource` is always present on
  Discord and `:134` keeps choosing `preserve` for the first phase.
- `complete_snapshot`: run one discovery pass with
  `missingThreadMode: 'close'`, and do not call `discoverThreads` or
  `fetchArchivedThreads`. Do not change `discoverChannels`; only the caller
  chooses the mode.

The `discover_threads` job (`src/ingestion/threads.ts:192`) does nothing and
returns an empty result in `complete_snapshot` mode. Log one debug line.

**Verify**: add cases to the sync tests with a stub platform in
`complete_snapshot` mode. Assert that a stored thread that is not in the
snapshot is closed (not quarantined), and that no archive call is made.
`npm run verify` → exit 0, and the Discord sync tests pass with no assertion
changes.

### Step 8b: Route mention parsing through `platform.format`

`sanitizeOutboundMessage` (`src/outbound/message-safety.ts`) and the
`INDIVIDUAL_MENTION` check in `src/agent/policy.ts` parse Discord mention
syntax. Give both a `format: PlatformFormat` parameter, and use
`format.parseMentions` and `format.stripMentions`. Move the Discord regexes
into `src/platform/discord/format.ts`. Do not change the regexes.

**Verify**: `npx vitest run test/unit/message-safety.test.ts test/unit/policy.test.ts`
→ exit 0 with no assertion changes other than the added parameter.
`npm run verify` → exit 0.

### Step 9: Run the gate and check scope

**Verify**:

- `npm run verify` → exit 0.
- `npm run docs:check-public && npm run docs:check-links` → exit 0.
- `git diff --check` → exit 0 with no output.
- `test -d src/discord && echo FAIL || echo ok` → `ok`.
- `git grep -n "from 'discord.js'" -- src ':!src/platform/discord'` → no output.
- Start the process with the fixture configuration
  (`MNEME_PLATFORM=discord`) in the same way as the CI fixture job, and
  confirm that the first-run report matches the report from before this plan.
- Update this plan's row in `plans/README.md` to `DONE`.

## Test plan

- Boundary: `test/unit/platform-boundary.test.ts` (Step 1) prevents
  `discord.js` imports outside `src/platform/discord/`.
- Migration: one row for each Discord channel type maps to the correct `kind`.
- Config: `MNEME_PLATFORM` missing, invalid, and `discord`.
- Thread discovery: `complete_snapshot` mode closes a missing stored thread and makes no archive call.
- Reactions: an emoji without a key is still dropped after the key moves into the Discord adapter.
- Discord adapter: review secret is unchanged, actor resolution fails closed,
  and Gateway events map to the same normalized messages.
- Regression: the full suite passes with no assertion changes, except import
  paths, the `type` to `kind` field, the `connectPlatform` seam name, and the
  `format` parameter.
- Pattern: model the stub platform on the bootstrap tests that override seams
  today. Do not build a fake Discord client in production code.

## Done criteria

- [ ] `src/discord/` does not exist.
- [ ] Only `src/platform/discord/` imports `discord.js`; the boundary test proves it.
- [ ] Only `src/platform/select.ts` imports from `src/platform/discord/` in core.
- [ ] `DiscoveredChannelDescriptor` has `kind`, not `type`; the `channels` table has `kind`.
- [ ] `MNEME_PLATFORM` is required, and `discord` is the only valid value.
- [ ] `ReactionEventInput` carries `emojiKey` and `emojiName`, not a raw Discord emoji.
- [ ] `platform.threadDiscovery` selects `archive_scan` (Discord) or `complete_snapshot`; Discord behavior is unchanged.
- [ ] The review secret, HMAC action ids, commands, cards, and job keys are unchanged.
- [ ] `npm run verify` exits 0 after Part A and after Part B.
- [ ] Docs checks exit 0.
- [ ] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back without improvising if:

- Plan 004 is not merged, or an excerpt has a different meaning after the drift check.
- A move in Part A needs a change to a line that is not an import.
- An existing test needs an assertion change that is not in the list in "Test plan".
- A neutral module needs a discord.js type that you cannot replace with a
  type from `src/platform/types.ts` without changing behavior.
- The bootstrap step order must change to make the platform seam work.
- `channels.type` is used by a query that this plan did not list.
- The review secret, HMAC custom ids, or command registration payload must change.
- A verification command fails two times after one reasonable correction.

## Maintenance notes

- Reviewers: check Part A with `git diff -M` and confirm that every file is a
  rename with only import changes. Check Part B for behavior drift in
  `src/production-runtime.ts` (about 40 call sites change from config to
  platform members).
- The interface is the contract for plan 006. If plan 006 needs a member that
  is not here, add it in plan 006 together with its Discord implementation.
- `PlatformFormat.render` is the identity on Discord. Plan 006 gives it its
  first real implementation (Markdown subset to Slack mrkdwn).
- Plan 002 decision 9 adds a `platform_boundary` policy source (Slack Connect is always `excluded`). This plan does not add it, because Discord has no such boundary. Plan 006 adds it to the policy resolver and a matching optional field to `DiscoveredChannelDescriptor`.
- `ChannelKind` has no Slack-only kinds. Slack channels map to `text`, and
  synthetic thread rows map to `thread` (plan 002, decision 3).
