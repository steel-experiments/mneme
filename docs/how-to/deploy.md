# Deploy Mneme

Mneme supports any host that can run its container image with one
persistent volume. The release contract is that every tagged release
publishes a versioned image, so a source checkout is not needed to deploy;
start with [Install with the released image](#install-with-the-released-image).
The repository also includes source-build configuration for Docker Compose,
Coolify, and Railway.

> **Release status: v1.0.0 published 2026-09-16.** The release workflow
> verified the image on both architectures before the push, published it with
> its digest in the release notes, and the same image runs live on Railway.
> The released-image sections below describe the intended release contract.
> Until the first tag exists, use
> [Deploy with Docker Compose from source](#deploy-with-docker-compose-from-source).

See [VM requirements](../reference/vm-requirements.md) for host sizing, disk
planning, and network access.

## Deployment rules

- Run exactly one replica.
- Mount persistent storage at `/app/data`.
- Do not mount one database volume into two active containers.
- Use stop-and-start deployment, not overlapping rolling replacement.
- Let the application run migrations at startup.
- Copy completed online backups off the application host.

SQLite is the reason for the singleton rule. Mneme uses WAL mode and durable
jobs, but it is not a distributed database.

## Prepare the deployment

1. Complete [Install Mneme](../tutorials/getting-started.md).
2. Set all required values from the
   [configuration reference](../reference/configuration.md) in the platform's
   secret and environment settings.
3. Keep `MNEME_MODE=observe` for the first deployment.
4. A synthetic sample policy ships at `config/channel-policy.yml`. With the
   default `CHANNEL_POLICY_SOURCE=basic`, skip the files and set the selection
   lists in the environment. With `CHANNEL_POLICY_SOURCE=file`, mount your
   reviewed `config/channel-policy.yml` and `config/mneme.yml` over the
   sample. Configuration comes from the environment or from mounted files; a
   rebuilt image is not a supported way to change configuration.
5. Post the completed [privacy notice](publish-privacy-notice.md).

The image starts as root so it can repair ownership on a mounted volume, then
executes Mneme as the `node` user through `gosu`.

## Install with the released image

The release contract is that every tagged release publishes a versioned image
at `ghcr.io/steel-experiments/mneme`. This is the standard operator
install: you pull a fixed version and run it. No source checkout is needed.
Contributors who change Mneme can use the source-build path in
[Deploy with Docker Compose from source](#deploy-with-docker-compose-from-source)
instead.

> **Not yet published.** No tag has been released, so the pull commands below
> do not resolve yet. They show the contract that the first release fulfils.

Pull the version you selected:

```bash
docker pull ghcr.io/steel-experiments/mneme:vX.Y.Z
```

A release tag names one build. Branch tips and the floating `latest` tag are
not version publications.

### Pin the image by digest

Resolve the digest that the tag points to, and record it:

```bash
docker images --digests ghcr.io/steel-experiments/mneme
docker inspect --format='{{index .RepoDigests 0}}' \
  ghcr.io/steel-experiments/mneme:vX.Y.Z
```

Then pull and run the image by digest, for example
`ghcr.io/steel-experiments/mneme@sha256:<digest>`. A digest
reference is immutable: the same string always runs the same image bytes. The
release notes record the digest of every published tag.

### Run the service without a source checkout

`docker-compose.image.example.yml` in the repository is a complete service
definition for the released image. It carries the same contract as the
repository Compose file: the same container-fixed environment set, the same
`mneme_data` volume at `/app/data`, the same health check, and the same
hardening. Port 3000 is exposed to sibling containers only; the file comments
explain how to publish it on loopback for local checks.

Save the file from the repository
(https://github.com/steel-experiments/mneme) into one directory
next to your `.env` file. Set the `image:` line to the version tag or digest
you pinned. Then validate and start:

```bash
docker compose -f docker-compose.image.example.yml config --quiet
docker compose -f docker-compose.image.example.yml up -d
docker compose -f docker-compose.image.example.yml logs -f mneme
```

Configuration lives outside the image. All settings flow from `.env` or the
platform environment settings, and all state lives in the data volume. No
documented setting needs a rebuilt image, so an image replacement changes no
configuration and no stored data.

### Do not run unattended latest upgrades

Mneme is a stateful application with one SQLite database. Migrations are
forward-only and run at startup, and an image that lacks an applied migration
refuses to start against the current database (see
[Migration compatibility](#migration-compatibility)). An unattended
auto-puller that follows `latest` starts upgrades without an operator
decision.

Make each upgrade a deliberate action: read the release notes, confirm a
completed backup when the release adds a migration, then change the tag or
digest and restart the service. This is also why the example file pins a
version instead of `latest`.

### Processor architectures

Each release builds images for AMD64 and ARM64 and runs the container smoke
test on both architectures before the image is published. The v1.0.0 release
exercised the full path on 2026-09-16. Docker selects the
matching architecture for the host automatically, and the digest you record
pins the multi-architecture manifest, so the same pinned reference works on
both.

## Deploy with Docker Compose from source

This path builds the image from a source checkout. Use it when you change
Mneme, or when no released image is available.

You need Docker Compose v2.24 or later. The service block uses the `env_file`
long syntax (`path` with a `required` flag), which that release introduced.

The base Compose file creates one service and a named `mneme_data` volume.
It exposes port 3000 to sibling containers but does not publish it to the host.

The service reads the repository `.env` file through
`env_file: [{path: .env, required: false}]`. When the file is absent, Compose
still starts the service, and Mneme reports every missing value with its
own configuration error. Compose performs no required-variable checks of its
own; the application is the single source of truth for validation messages.

The `environment:` block pins only the values that must differ inside the
container:

- `NODE_ENV=production`
- `HOME=/tmp`
- `DATA_DIR=/app/data`
- `DATABASE_PATH=/app/data/mneme.sqlite`
- `PROMPT_DIR=/app/prompts`
- `DOCS_DIR=/app/docs`
- `MNEME_CONFIG_PATH=/app/config/mneme.yml`
- `CHANNEL_POLICY_PATH=/app/config/channel-policy.yml`

These container-fixed values win over the env file. They exist because the
native defaults are relative to the working directory, while a container must
point at the absolute `/app` paths baked into the image. Every other setting,
including `PORT`, flows from `.env` unchanged; `PORT` defaults to 3000 in the
application when the file does not set it.

Configuration and data survive an image replacement. `.env` is a host file
that Compose reads at each start, the database lives in the `mneme_data`
volume, and the pinned `/app` paths are the same in every image. Replacing the
image therefore changes none of your configuration or stored data.

Validate the resolved configuration:

```bash
docker compose config --quiet
```

For local operation, publish the HTTP port with the example override:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up --build -d
docker compose logs -f mneme
```

The example override binds `127.0.0.1:3000:3000`, so the published port is
reachable from the host loopback interface only and not from other machines.

For a server deployment, publish or proxy the HTTP port only if an external
health checker, `/status` client, or MCP client needs it.

## Deploy with Coolify

1. Create an application from the repository.
2. Select the Docker Compose build pack.
3. Add the required environment variables in Coolify.
4. Confirm the `mneme_data` volume is mounted at `/app/data`.
5. Keep the service at one replica. Coolify does not use rolling updates for
   Docker Compose deployments, which matches Mneme's singleton requirement.
6. Deploy and watch the application logs.

Treat the Compose file as the source of truth for service settings, storage,
and health checks. Review the resolved Compose configuration before each
production change.

Coolify does not automatically turn an application volume into a tested
off-host SQLite backup. Schedule a copy of completed files from
`/app/data/backups` or use a host-level snapshot system.

## Deploy with Railway

This path deploys from a source repository through `railway.json`. To
provision from the released image with the Railway template instead, see
[Deploy on Railway](railway.md).

1. Create a service from the repository.
2. Railway reads `railway.json` and builds the root Dockerfile.
3. Add a Railway volume mounted at `/app/data`.
4. Add the required environment variables.
5. Keep the service at one replica.
6. Do not add a pre-deploy migration command. Railway does not mount the volume
   during that phase; Mneme migrates after the container starts.
7. `railway.json` pins `deploy.drainingSeconds` to 45, so the old deployment
   has time to finish Mneme's default 30-second shutdown drain. You do not
   set the drain by hand.
8. Deploy and wait for Railway's `/readyz` health check.

Railway supplies `PORT`; Mneme uses it automatically.

### Migration compatibility

Applied migration files are immutable. A starting image must contain every migration
already recorded by the persistent database, with the same checksum. Mneme refuses
to start when an image is older than the database or an applied migration changed.

Before deploying a release that adds a migration, verify a completed backup. A queued
backup is not enough. Prefer a forward correction after a migration has committed. Use
an older image only after confirming it contains every recorded migration; otherwise
stop the service and restore a verified backup from before the missing migration.

## Verify a deployment

Check liveness and readiness from a network location that can reach the service:

```bash
curl --fail http://mneme.example.internal/livez
curl --fail http://mneme.example.internal/readyz
```

If `HTTP_ADMIN_TOKEN` is set, inspect status:

```bash
curl --fail \
  -H "Authorization: Bearer $HTTP_ADMIN_TOKEN" \
  http://mneme.example.internal/status
```

In Discord, run:

```text
/mneme status
/mneme channels
```

Confirm:

- the guild ID is correct
- excluded channels have ingestion disabled
- permission warnings match the role you granted
- backfill is progressing when `FULL_HISTORY=true`
- the service is still in observe mode
- the persistent database survives a normal redeploy

## Shut down safely

Send `SIGTERM` and allow at least `SHUTDOWN_TIMEOUT_SECONDS` plus a small platform
margin. The supplied Compose file uses a 45-second stop grace period for the
default 30-second drain deadline.

Shutdown marks readiness down, stops timers and job claims, waits for active
work, disconnects Discord, closes HTTP, checkpoints WAL, and closes SQLite.
Leased jobs and uncertain outbox sends remain recoverable after restart.

## Roll back or recover a failed deployment

Railway and Docker Compose do not roll back a failed release automatically. A
redeploy only selects another image; it never reverts the database volume. The
durable recovery path is a restore from a verified backup. Startup migrations
run against the persistent database, so an older application image may not be
safe after a newer migration has committed.

1. Record the attempted source revision and platform deployment identifier.
2. Inspect deployment and build logs without printing environment variables.
3. If the process is healthy but behavior is unsafe, switch Mneme to
   `observe` with the Discord mode command.
4. Determine whether the failed release applied a migration and confirm a usable
   backup before selecting older code.
5. Prefer a forward corrective release. Use an older image only after verifying that it
   contains every migration
   recorded in the database. A previous-image redeploy does not revert the volume schema.
6. Repeat `/livez`, `/readyz`, `bootstrap.complete`, and `/mneme status`
   verification after recovery.

## Platform documentation

- [Coolify Docker Compose deployments](https://coolify.io/docs/knowledge-base/docker/compose)
- [Coolify persistent storage](https://coolify.io/docs/knowledge-base/persistent-storage)
- [Coolify rolling updates](https://coolify.io/docs/knowledge-base/rolling-updates)
- [Railway configuration as code](https://docs.railway.com/config-as-code)
- [Railway pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command)
