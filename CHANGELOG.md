# Changelog

All notable changes to Cassandra for Discord are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at the launch baseline. Changes before that point are
not recorded.

## [Unreleased]

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
