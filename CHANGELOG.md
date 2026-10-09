# Changelog

All notable changes to Mneme are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at the launch baseline. Changes before that point are
not recorded.

## [Unreleased]

### Added

- **`archive-rewrite --all-org`.** Marks every stored channel `org` in the
  archive copy, so the archive serves all stored history. Test channels,
  shared channels, and unproven threads stay hidden.

### Changed

- **Move from Discord to Slack.** The guide now covers the traps found in a
  real switch: file ownership in the container, settings that stop a Slack
  start, a configuration check before the deploy, recovery from a failed
  start, and a backup from the container shell.

### Fixed

- **Attachment download race.** If a channel is excluded or stops being
  ingested while an attachment downloads, Mneme now deletes the file and keeps
  only the metadata.
- **Slack thread names.** `list_channels` names a Slack reply thread after its
  parent channel and the date it started, not its internal id. The label never
  holds message text, and it names the parent only when that channel is org.
- **MCP `GET`.** An enabled MCP endpoint answers `GET` with `405` and
  `Allow: POST`. A disabled endpoint still answers `404`.
- **History campaign on Slack.** `HISTORICAL_MEMORY_CHANNEL_IDS` accepts Slack
  channel ids. Ids of the other platform stop startup: remove a Discord
  campaign before you switch a deployment to Slack.

## [3.2.0] - 2026-10-07

### Added

- **Read-only platform archive.** A deployment can read the database of its
  former deployment on the other platform as a frozen archive
  (`MNEME_ARCHIVE_PATH`, `MNEME_ARCHIVE_PLATFORM`). The archive serves only
  org content, with no exception. Direct answers can cite archive messages,
  and MCP clients with an `org` token get four archive tools. Admins hide
  archive content with `/mneme archive forget-user` and `forget-message`, and
  `archive-rewrite` writes a minimized copy. Migrations 046 and 047 add
  `archive_redactions` and `deletion_requests.archive_workspace_id`. See
  [Move from Discord to Slack](docs/how-to/move-from-discord-to-slack.md).

### Changed

- **Dependencies.** Update `@earendil-works/pi-ai` and
  `@earendil-works/pi-agent-core` to 1.0.0.

### Removed

- **Railway template.** The Railway template is retired. To run Mneme on
  Railway, deploy the released image by hand, as
  [Deploy on Railway](docs/how-to/railway.md) describes.

## [3.1.0] - 2026-10-02

### Security

- **Restricted threads keep their own scope.** A restricted thread under a
  channel that is not restricted now uses its own scope. Before, two such
  threads under the same parent could see each other's messages and
  memories, and a citation from one thread could carry facts from the other
  into memory. A thread still shares its parent's scope when the parent is
  restricted.
- **Restricted channels in a Discord category.** Scheduled reviews and the
  secure review channel now read the restricted channel itself. Before, they
  used the category id and found nothing.

### Changed

- **Discord private threads are restricted by default.** A private thread
  resolves to `restricted` unless a channel-policy rule for that thread says
  otherwise. Slack has no private threads and does not change.

### Upgrade notes

- This release adds migration 045 (`channels.is_private_thread`). Make a
  backup and verify it before you upgrade. A private thread that Mneme stored
  as `org` before this release becomes `restricted` when discovery sees it
  again. An archived private thread that Mneme cannot list again keeps its
  old class; classify it with a channel-policy rule.

## [3.0.0] - 2026-10-02

### Added

- **Slack support.** Set `MNEME_PLATFORM=slack` to run Mneme in one Slack
  workspace. Create the app from `config/slack-app-manifest.yml` in your own
  workspace and do not distribute it. Mneme connects through Socket Mode,
  reads only the channels that the bot was invited to, stores reply threads
  below their channel, answers mentions in the thread, posts Block Kit review
  cards, and accepts `/mneme` commands as text. A channel that is or was shared
  with another organization (Slack Connect) is always excluded. Outbound text
  never notifies people. MCP clients can sign in with Slack, and attachments
  download only from `files.slack.com`. See
  [Install Mneme](docs/tutorials/getting-started.md).

### Changed

- **Platform selection.** `MNEME_PLATFORM` is required and has no default.
  Set `MNEME_PLATFORM=discord` before you upgrade; startup stops without it.
- **Platform-neutral schema.** Migration 041 renames `guild_id` columns to
  `workspace_id`, the guild tables to workspace tables, and
  `outbox.discord_message_id` to `platform_message_id`. Migration 042 replaces
  the numeric `channels.type` with a text `channels.kind`. The MCP result field
  `discordLink` is now `link`.

### Upgrade notes

- This release adds migrations 041 to 044. Make a backup and verify it before
  you upgrade. Older releases cannot run on a database after migrations 041
  and 042. To go back, restore the backup from before the upgrade.

### Fixed

- **Dependencies.** Update transitive dependencies with known advisories
  (`fast-uri`, `hono`, `ip-address`, `qs`).

## [2.0.0] - 2026-10-01

### Changed

- **Project name.** The project is now Mneme, named after the Greek muse of
  memory. The repository, package, container image
  (`ghcr.io/steel-experiments/mneme`), environment variables (`MNEME_*`),
  configuration file (`config/mneme.yml`), slash command (`/mneme`), and the
  test-surface rule for channel names that contain `mneme` use the new name.
  Old names are not supported.

## [1.0.0] - 2026-09-16

First public release. The container image is published at
`ghcr.io/steel-experiments/cassandra-discord` and the Railway template at
<https://railway.com/template/cassandra-for-discord>.

### Added

- **Organizational memory extraction.** Cassandra ingests permitted Discord
  channel history into SQLite, groups messages into episodes, and extracts
  durable memories: decisions, assumptions, predictions, and risks. Each memory
  is tied to its evidence and scope.
- **Scoped visibility.** Channels are classed `org`, `restricted`,
  `review_only`, or `excluded`. The default class is fail-closed. Threads
  inherit their parent's class. Reclassifying a channel tightens dependent
  memory scopes on the next read.
- **Review workflow.** Three operating modes: `observe` (default, sends
  nothing on its own), `review` (a human approves each proposal in a secure
  review channel), and `autonomous` (bounded by evidence checks, scores,
  cooldowns, and daily limits). Admin actions are audited.
- **MCP and OAuth surfaces.** Stateless MCP over HTTP, per spec 2026-07-28,
  with scoped bearer tokens that are hashed at rest, rate-limited, revocable,
  and expirable. OAuth 2.0 sign-in through Discord with PKCE lets MCP clients
  obtain tokens without a shared secret.
- **Inspector.** An optional, read-only admin surface: memories, episodes,
  agent runs and their context ledger, the speech trail, channel policy, the
  job queue, and the audit log. It is observability, not operation.
- **Backups.** Online SQLite backup that stays consistent while the process
  writes, a restore procedure, and an integrity-check command for the database
  file.
- **Health checks.** `/livez` and `/readyz` endpoints, a container healthcheck,
  and graceful SIGTERM shutdown that drains work and leaves unfinished jobs
  recoverable.
- **Container deployment.** One multi-arch image (linux/amd64 and
  linux/arm64), built and smoke-tested locally on both architectures. State
  lives in one `/app/data` volume. Upgrades are stop-and-start, never
  overlapping. The release workflow, GitHub-hosted runners, and the Railway
  template install are not yet exercised.
- **Compose env_file contract.** The base Compose file builds from source; the
  image example file runs the published image. Both read settings through
  `env_file`, pin only the container-fixed override set, and never publish the
  HTTP port to the host. A loopback-only override covers local checks. Released
  images are pinned by version tag or digest, never by `latest`.
- **Basic and file policy sources.** `CHANNEL_POLICY_SOURCE=basic` builds the
  channel policy from two selection lists in the environment; at least one
  list must name an id. `file` loads a full YAML policy with per-channel,
  per-category, and per-thread rules, and supports live reload.

[1.0.0]: https://github.com/steel-experiments/cassandra-discord/releases/tag/v1.0.0
