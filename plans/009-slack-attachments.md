# Plan 009: Archive Slack attachments

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cc84413..HEAD -- src/discord/attachments.ts src/ingestion/attachments.ts src/jobs/handlers/archive-attachment.ts src/jobs/handlers/purge-attachment-file.ts src/db/repositories/attachments.ts src/production-runtime.ts test/integration/attachments.test.ts MNEME_IMPLEMENTATION_SPEC.md`
> Plan 005 moves `src/discord/attachments.ts` to `src/ingestion/attachments.ts`
> and adds `ChatPlatform.fetchBytes`. Plan 006 adds the Slack normalizer. The
> excerpts below show the code at `cc84413`. Find each one at its new location.
> A change in behavior, not only in location, is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MED (a bot token goes into an outbound HTTP request)
- **Depends on**: 006 (the Slack normalizer stores attachment metadata)
- **Category**: feature
- **Planned at**: commit `cc84413`, 2026-10-01

## Why this matters

With `ATTACHMENT_MODE=archive` or `selective`, Mneme downloads small, allowed
files (text, Markdown, JSON, CSV, small PDFs) so it can read them later.
Discord attachment URLs are public CDN links, so the download sends no
credential. Slack file URLs (`url_private`) need the bot token in an
`Authorization: Bearer` header and the `files:read` scope. Without this plan,
every Slack download fails or, worse, stores Slack's HTML sign-in page as the
file. The token must never go to a host that is not Slack's file host.

## Current state

- `src/discord/attachments.ts:33` defines the seam:

  ```ts
  /** Fetch the raw bytes for a URL. Injectable so tests never hit the network. */
  export type FetchBytes = (url: string, maxBytes?: number) => Promise<Uint8Array>;
  ```

  `defaultFetchBytes` (lines 36–62) calls `fetch(url)` with no headers. It
  follows redirects (the `fetch` default). It enforces `maxBytes` from the
  `content-length` header and again while it streams.

- `src/discord/attachments.ts:84` — `const SNOWFLAKE_RE = /^\d{17,20}$/;`.
  `resolveArchivePath` (lines 165–182) throws
  `attachment id is not a snowflake` for any other id, then builds
  `<dataDir>/attachments/<id><safe extension>` and checks containment.

- `archiveAttachment` (lines 198–241) checks eligibility, picks
  `attachment.proxyUrl ?? attachment.sourceUrl` (line 208), calls
  `resolveArchivePath`, downloads with the injected fetcher, re-checks the
  size, hashes, writes, and checks containment of the real path.

- `src/jobs/handlers/archive-attachment.ts:8-35` takes an optional
  `fetcher?: FetchBytes`. `src/production-runtime.ts:1449-1454` registers the
  handler without a fetcher, so production uses `defaultFetchBytes`.

- `src/db/repositories/attachments.ts:46-80` upserts on `attachments.id`
  (`ON CONFLICT(id) DO UPDATE`). The update does not change `message_id`. The
  `id` is the primary key (`migrations/001_core.sql:116`).

- `src/discord/ingest.ts:186-210` stores attachment metadata in the ingest
  transaction and queues one `archive_attachment` job for each eligible file,
  with the unique key `attachment:archive:<id>`.

- `src/jobs/handlers/purge-attachment-file.ts` removes a file by its stored
  `local_path`. It does not depend on the platform.

- `test/integration/attachments.test.ts:140-158` tests `resolveArchivePath`.
  Line 155–157 expect a throw that matches `/snowflake/`.

- Plans 005 and 006 (confirm before you start):
  - Plan 005 puts `fetchBytes: FetchBytes` and
    `isValidId(kind, id)` (with an `'attachment'` kind) on `ChatPlatform`.
    The Discord adapter sets `fetchBytes` to `defaultFetchBytes`.
  - Plan 006 (Step 5, "Attachments") maps Slack `files[]` to attachment
    metadata with the Slack file id as the attachment id and `url_private` as
    the source URL. It does not download.

- Slack facts (plan 002 research summary, official docs, 2026-10-01):
  `url_private` and `url_private_download` need `Authorization: Bearer
  <bot token>` and the `files:read` scope. A Slack file id (`F…`) is unique
  in the workspace, but one file can be shared into more than one message
  and channel. A file can be external (`is_external: true`, for example a
  Google Drive link), and its URL can then point to a host that is not Slack.
  A deleted file stays in the message with `mode: "tombstone"`.

## Decision: a Slack attachment id is `<messageId>-<fileId>`

Plan 006 uses the bare file id. That is not safe with the current schema.
When one Slack file is shared into two messages, the second upsert finds the
same `attachments.id` and does not change `message_id`. The second message
then has no attachment row. If the first message is deleted, Mneme purges
the archived file that the second message still shows. Use the message id
(plan 002 decision 4: `<channelId>-<ts>`) as a prefix. The id becomes
`C0123ABCD-1712345678.000100-F0123ABCD`. It is unique for each message, and
it matches the id character rule `^[A-Za-z0-9.-]+$` (plan 002 decision 5). A
file shared twice is downloaded twice. This is acceptable.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Slack fetcher tests | `npx vitest run test/unit/slack/fetch-bytes.test.ts` | exit 0; all tests pass |
| Attachment tests | `npx vitest run test/integration/attachments.test.ts` | exit 0; all tests pass |
| Slack normalizer tests | `npx vitest run test/unit/slack` | exit 0; all tests pass |
| Documentation checks | `npm run docs:check-public && npm run docs:check-links` | exit 0; no errors |
| Full verification | `npm run verify` | exit 0; SQLite check, lint, both typechecks, tests, and build all pass |

## Scope

**In scope**:

- The attachments module (`src/ingestion/attachments.ts` after plan 005)
- `src/jobs/handlers/archive-attachment.ts`
- `src/production-runtime.ts` (the `archive_attachment` registration only)
- The Slack adapter: a new `fetch-bytes.ts`, the attachment mapping in the
  Slack normalizer, the Slack `isValidId('attachment', …)` rule, and the line
  that sets `fetchBytes`
- `test/integration/attachments.test.ts`
- `test/unit/slack/fetch-bytes.test.ts` (new) and the Slack normalizer tests
- `MNEME_IMPLEMENTATION_SPEC.md` Section 9.10
- `docs/reference/configuration.md` (the attachment rows only)
- `plans/README.md` (status update only)

**Out of scope** (do not touch):

- Eligibility rules (MIME allowlist, byte limit, executable block). They stay
  the same on both platforms.
- The purge job and the delete path. They use `local_path` and work as they
  are.
- Removing an archived file when a message edit removes the file. This is an
  existing gap on Discord too. Record it in Maintenance notes; do not fix it
  here.
- Downloading external files (`is_external: true`). Mneme stores their
  metadata and skips the download.
- OCR or text extraction.

## Git workflow

- Branch: `advisor/009-slack-attachments`
- Commit as one logical change, for example:
  `feat(slack): archive Slack attachments with the bot token`
- Do not push or open a PR unless the operator instructs you.

## Steps

### Step 1: Spike — record how Slack serves a private file

Use a test workspace and a test app with the scopes from plan 006. Do not use
a production workspace. Upload a small `.txt` file to a channel where the bot
is a member. With a short script outside `src/` (do not commit it), record:

1. The host of `url_private` and of `url_private_download`.
2. The response to a GET with `redirect: 'manual'` and the bearer token:
   status, `content-type`, and, for a 3xx, the `location` host.
3. The response with no `Authorization` header (expected: HTML sign-in page
   or a redirect to it).
4. The response with a token that does not have `files:read` (remove the
   scope and reinstall).

Add a "Spike results" section at the end of this plan with the answers.

**Verify**: the "Spike results" section answers all four items.

### Step 2: Give the archive path a platform id validator

In the attachments module:

- Remove `SNOWFLAKE_RE`.
- Add `isValidAttachmentId: (id: string) => boolean` to
  `AttachmentArchiveConfig`.
- In `resolveArchivePath`, throw `attachment id is not valid for this
  platform: <id>` when the validator returns false. Also throw when the id
  does not match `^[A-Za-z0-9.-]+$`, starts with `.`, or contains `..`. This
  second check is a belt under the platform validator: it keeps the path safe
  even if a platform validator is wrong. Keep the containment checks as they
  are.
- Update the comment at the top of the module: the path comes from the
  validated platform attachment id, not from a snowflake.

In `src/production-runtime.ts`, pass
`isValidAttachmentId: (id) => platform.isValidId('attachment', id)` in the
`archive_attachment` config. Pass the same config to the ingest options if
plan 005 shares one object between them.

Update `test/integration/attachments.test.ts`:

- The helper `cfg()` passes a Discord-like validator (`/^\d{17,20}$/`).
- Change the expected message in lines 155–157 from `/snowflake/` to
  `/not valid for this platform/`.
- Add cases with a Slack-like validator: a valid Slack attachment id builds
  `<dir>/C0123ABCD-1712345678.000100-F0123ABCD.txt`; `..`, `.hidden`,
  `a/b`, and `a\b` throw even when the validator returns true.

**Verify**: `npx vitest run test/integration/attachments.test.ts` → exit 0.

### Step 3: Use a per-message attachment id in the Slack normalizer

In the Slack normalizer from plan 006, set each attachment id to
`<messageId>-<file.id>`. Set `sourceUrl` to `url_private_download` if present,
else `url_private`. Set `proxyUrl` to `null`. Skip a file (store no
attachment row) when `mode` is `tombstone` or `hidden_by_limit`, or when the
file has no id. For an external file (`is_external: true`), store the
metadata with `sourceUrl: null`, so `archiveAttachment` skips it with
`no source url`.

Set the Slack `isValidId('attachment', id)` rule to
`^[CG][A-Z0-9]{8,}-\d{10}\.\d{6}-F[A-Z0-9]{8,}$`. Reuse the channel and `ts`
patterns that plan 006 defined. Do not copy them.

Update the Slack normalizer tests: a message with one file, a message with
two files, the same file id in two messages (two different attachment ids), a
tombstoned file, and an external file.

**Verify**: `npx vitest run test/unit/slack` → exit 0.

### Step 4: Add the Slack fetcher

Create `fetch-bytes.ts` in the Slack adapter directory (start with two
`ABOUTME:` lines). Export
`createSlackFetchBytes(botToken: string, fetchImpl: typeof fetch = fetch): FetchBytes`.

Rules:

1. **Token host.** Send `Authorization: Bearer <botToken>` only when the URL
   is `https:` and its host is exactly `files.slack.com`. If the first URL is
   any other host or is not `https:`, throw `attachment url is not a Slack
   file url` and send no request.
2. **Redirects.** Call `fetchImpl` with `redirect: 'manual'`. For a 3xx,
   read `location`, resolve it against the current URL, and follow it only
   if it is `https:` and its host is `files.slack.com`, or the host ends in
   `.slack.com` or `.slack-edge.com`. Send the `Authorization` header only to
   `files.slack.com`. Drop it for every other host. Follow at most three
   redirects. Throw on a fourth, on a missing `location`, and on a host that
   is not allowed. Adjust the host list only if the Step 1 spike shows a
   different Slack file host, and record the reason in the spike section.
3. **Sign-in page.** If the final response has `content-type` that starts
   with `text/html`, throw `slack returned an HTML page; check the files:read
   scope`. Allowed archive MIME types do not include HTML, so this never
   rejects a real file.
4. **Size and errors.** Keep the `maxBytes` checks of `defaultFetchBytes`.
   Move the stream reader into a shared helper in the attachments module, and
   call it from both fetchers. Do not copy it.
5. **No token in errors.** Error messages contain the status and the host,
   never the full URL query and never the token.

Set the Slack adapter `fetchBytes` to `createSlackFetchBytes(SLACK_BOT_TOKEN)`.
In `src/production-runtime.ts`, pass `fetcher: platform.fetchBytes` to
`createArchiveAttachmentHandler`. The Discord adapter keeps
`defaultFetchBytes`, so Discord behavior does not change.

Create `test/unit/slack/fetch-bytes.test.ts` with a stubbed `fetchImpl` that
records each request's URL and headers:

- A `files.slack.com` URL gets the bearer header and returns the bytes.
- A URL on another host (`https://example.com/f`) throws before any request.
- An `http:` URL on `files.slack.com` throws before any request.
- A redirect from `files.slack.com` to `https://files-edge.slack-edge.com/…`
  is followed, and the second request has no `Authorization` header.
- A redirect to `https://evil.example/…` throws, and no request goes to it.
- Four redirects in a row throw.
- A `text/html` 200 response throws with the scope hint.
- A `content-length` above `maxBytes` throws. A stream that passes `maxBytes`
  throws.
- No thrown message contains the token.

**Verify**: `npx vitest run test/unit/slack/fetch-bytes.test.ts test/integration/attachments.test.ts` → exit 0.

### Step 5: Amend the spec and the documentation

`MNEME_IMPLEMENTATION_SPEC.md` Section 9.10: add a "Platform download" part.

- Discord downloads with no credential.
- Slack downloads with the bot token, only from `files.slack.com`, follows
  only Slack redirects, sends the token to no other host, rejects an HTML
  page, needs `files:read`, and skips external files.
- A Slack attachment id is `<messageId>-<fileId>`, and the reason.
- The archive path uses the platform attachment id validator.

`docs/reference/configuration.md`: in the attachment rows, say that on Slack
archive modes need the `files:read` scope, and that external files keep
metadata only.

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0.

### Step 6: Run the repository gate and inspect scope

**Verify**:

- `npm run verify` → exit 0.
- `git diff --check` → exit 0 with no output.
- `git status --short` → only files in the **In scope** list changed.
- `grep -rn "SNOWFLAKE_RE" src/ingestion/attachments.ts` → no output.
- Update this plan's row in `plans/README.md` to `DONE`.

## Test plan

- Path safety: the platform validator and the character belt both reject
  traversal ids. The containment checks still run.
- Token safety: the token goes only to `files.slack.com` over HTTPS. No
  redirect carries it to another host.
- Failure modes: HTML sign-in page, too many redirects, size limits, and
  transport errors.
- Normalizer: per-message attachment ids, tombstoned files, and external
  files.
- Regression: every Discord attachment test passes with the Discord
  validator.

## Done criteria

- [ ] `resolveArchivePath` uses the platform attachment id validator and the
      character belt. No snowflake check is left in the attachments module.
- [ ] Slack attachment ids are `<messageId>-<fileId>`.
- [ ] The Slack fetcher sends the bot token only to `files.slack.com` over
      HTTPS and never on a redirect to another host.
- [ ] An HTML response is rejected with a hint about `files:read`.
- [ ] External and tombstoned Slack files are never downloaded.
- [ ] Production passes `platform.fetchBytes` to the archive handler. Discord
      still uses `defaultFetchBytes`.
- [ ] Spec Section 9.10 and the configuration reference describe Slack
      downloads.
- [ ] `npm run verify` exits 0.
- [ ] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back without improvising if:

- Plan 005 did not add `ChatPlatform.fetchBytes` or an `'attachment'` id kind.
- The Step 1 spike shows that Slack serves private files from a host that is
  not under `slack.com` or `slack-edge.com`, or that a download needs the
  token on a host other than `files.slack.com`.
- Plan 006 stored Slack attachments with bare file ids and real data already
  exists in a deployment. Changing the id then needs a migration, which is
  out of scope.
- A step needs a change to the eligibility rules or the purge path.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- Reviewers should read the redirect loop with care. The rule is simple: the
  token goes to one exact host, and nothing else gets it.
- A message edit that removes a file does not purge the archived copy, on
  Discord or on Slack. Fixing it needs a change to the update path in ingest
  and is a separate plan.
- If Slack moves files to a new host, update the host list and the spike
  section together.
