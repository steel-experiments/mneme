# VM requirements

Mneme is a single, stateful Node.js service. It does not run a model on the
VM, so it needs no GPU. Model inference happens through the configured provider
API.

The project has no benchmark-backed minimum CPU, memory, or disk size. The
figures below are starting points, not enforced limits.

## Required platform

- one 64-bit Linux VM
- Docker Engine with the Docker Compose plugin, or Node.js 24 or newer
- one Mneme process or container for the guild and database
- persistent local storage mounted at `/app/data`
- outbound DNS, HTTPS, and secure WebSocket access
- enough shutdown time for Mneme to drain work and checkpoint SQLite
- separate off-host storage for backups

The supplied image is based on `node:24.21-bookworm-slim`. The tag pins the Node minor version, so a rebuild on another day gets the same `node:sqlite` behavior. The upstream Node image
supports AMD64 and ARM64, among other Linux architectures.

Use SSD-backed storage for `/app/data`. Mneme uses SQLite in WAL mode and
performs FTS indexing, so slow or unreliable network filesystems are a poor fit.
Never mount the same database volume into two active Mneme containers.

## Network access

Mneme connects to the selected model provider and to one chat platform:

- **Discord**: an outbound Gateway WebSocket and Discord's HTTPS API.
  Attachment archival needs outbound access to the attachment URLs supplied by
  Discord.
- **Slack**: an outbound Socket Mode WebSocket and the Slack Web API
  (`slack.com` and its subdomains). Attachment archival downloads only from
  `files.slack.com`, and follows redirects only to other `slack.com` or
  `slack-edge.com` hosts.

No public inbound port is needed for chat events or slash commands. Discord
delivers both through the Gateway connection, and Slack through Socket Mode.

The application listens on port 3000 inside the container. Publish or proxy it
only when an external system needs one of these interfaces:

- `/livez` or `/readyz` for health checks
- bearer-protected `/status`
- bearer-protected MCP, when enabled

Keep administrative endpoints on a private network or behind a TLS reverse
proxy. The base Compose file exposes port 3000 only to sibling containers.

## Suggested VM sizes

| Workload | vCPU | Memory |
| --- | ---: | ---: |
| Small server after backfill | 1 | 1 to 2 GB |
| General production starting point | 2 | 4 GB |
| Large backfill or busy server | 4 | 8 GB |

Start with 2 vCPU and 4 GB of memory unless server history or message volume
suggests otherwise. Local Docker builds need more memory than steady-state
operation. A small VM can avoid that peak by pulling an image built in CI.

The fixture-mode verification used about 97 MB of resident memory in one local
run. That test has no live platform cache, sustained history backfill, or normal
job concurrency, so it does not establish a production minimum.

## Disk planning

Disk use depends on the server's message history and these settings:

- `FULL_HISTORY`
- `STORE_RAW_JSON`
- `RETAIN_EDIT_HISTORY`
- `RETAIN_DELETED_CONTENT`
- `ATTACHMENT_MODE`

The reviewed runtime image is about 500 MB. The VM also needs room for the host
OS, Docker layers and build cache, the SQLite database and WAL, local backups,
and temporary maintenance headroom.

| Starting allocation | Suitable for |
| --- | --- |
| 20 GB total disk | A small server using metadata-only attachments, with Docker cache monitored closely. |
| 40 to 50 GB total disk | A safer default for a general deployment. |
| Dedicated data volume sized from observed use | Attachment archival or extensive message history. |

The `/app/data` volume must accommodate the live database, WAL growth, and at
least one complete local backup. Scheduled backups default to a seven-day local
retention window, so peak use can be several times the live database size.
Copy completed backups off the VM.

## Shutdown and time

`SHUTDOWN_TIMEOUT_SECONDS` defaults to 30 seconds. The supplied Compose file
allows 45 seconds before the container is killed. If you increase the drain
timeout, increase the platform stop grace period as well.

Keep the VM clock synchronized. Mneme uses timestamps for job leases,
cooldowns, daily budgets, retention, token expiry, and audit records.

## Recommended baseline

For an ordinary deployment, use:

- Debian 12 or a supported Ubuntu LTS release
- 2 vCPU
- 4 GB memory
- 40 GB SSD storage
- one Mneme container
- persistent `/app/data`
- daily off-host backups
- synchronized system time

Review disk growth and memory use during the first full-history import, then
resize from observed data rather than relying on the starting estimate.

## Related documentation

- [Deploy Mneme](../how-to/deploy.md)
- [Configuration reference](configuration.md)
- [Back up and restore SQLite](../how-to/backup-and-restore.md)
- [Docker Compose installation](https://docs.docker.com/compose/install/linux/)
- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)
- [Official Node Docker image architectures](https://github.com/docker-library/official-images/blob/master/library/node)
