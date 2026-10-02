# Back up and restore

Mneme keeps all mutable state in `DATA_DIR`. With the container defaults,
the database is `/app/data/mneme.sqlite` and backups are written to
`/app/data/backups`.

The export and restore commands below cover the two supported install kinds:
Docker Compose (including the released image) and Railway. Run every restore
against a disposable volume first. A backup that was never restored is an
untested backup.

## Create an online backup

With the admin command:

```text
/mneme backup
```

The command queues a durable backup job, replies immediately with a short job
ID, and sends the requesting admin a best-effort DM after the backup passes
integrity verification. The notification states that the DM inbox is not a
conversational surface and directs questions to an explicit `@Mneme`
mention in the server. `/mneme status` shows the latest backup age and the
durable job's queued, retrying, running, succeeded, or failed state. Railway
and Coolify logs also contain structured `backup.started`,
`backup.succeeded`, and `backup.failed` events.

From a built source checkout:

```bash
npm run backup
```

The CLI needs `DATABASE_PATH`, `DATA_DIR`, and optionally `BACKUP_DIR`. It
does not need platform (Discord or Slack) or model credentials.

Each successful backup creates:

- `mneme-YYYYMMDD-HHMMSS.sqlite`
- `mneme-YYYYMMDD-HHMMSS.sqlite.manifest.json`

The manifest records the application version, schema version, source path,
timestamp, SHA-256 digest, file size, and integrity result.

Mneme uses SQLite's online backup API. Do not copy only the live
`.sqlite` file while WAL mode is active; committed pages may still be in the
WAL.

## Export a backup off the host

A backup file under `/app/data/backups` is still on the application volume.
Copy both the `.sqlite` file and its matching `.manifest.json` to separate
storage, then verify the copy with the recorded digest.

### From Docker Compose

List the completed backups and copy one out with the service name from your
Compose file (`mneme` in the repository files):

```bash
docker compose exec mneme ls -1 /app/data/backups

docker compose cp \
  mneme:/app/data/backups/mneme-YYYYMMDD-HHMMSS.sqlite .
docker compose cp \
  mneme:/app/data/backups/mneme-YYYYMMDD-HHMMSS.sqlite.manifest.json .
```

Verify the copy against the manifest:

```bash
jq -r .sha256 mneme-YYYYMMDD-HHMMSS.sqlite.manifest.json
shasum -a 256 mneme-YYYYMMDD-HHMMSS.sqlite
```

The two values must match character for character. When they differ, delete
the copy and export again.

### From Railway

> The export drill ran against a live Railway service on 2026-09-16: the
> online backup, the manifest checksum, the off-platform copy, and the decoded
> file all matched. Run it on a disposable service when you rehearse a
> restore.

Install the Railway CLI and log in. Run the checksum and the copy through
`railway ssh` against your service. The `railway ssh -- <command>` form may
mangle quotes and pipes. Prefer to open the session with
`railway ssh --service <service-name>` and run each command interactively
inside it, or wrap the command in `sh -c '...'`:

```bash
# Digest of the backup on the volume.
railway ssh --service <service-name> -- \
  "sha256sum /app/data/backups/mneme-YYYYMMDD-HHMMSS.sqlite"

# Copy the file out as base64, decode it locally.
railway ssh --service <service-name> -- \
  "base64 /app/data/backups/mneme-YYYYMMDD-HHMMSS.sqlite" \
  | tr -d '\r' | base64 -d > mneme-YYYYMMDD-HHMMSS.sqlite
```

Then verify the export:

```bash
shasum -a 256 mneme-YYYYMMDD-HHMMSS.sqlite
jq -r .sha256 mneme-YYYYMMDD-HHMMSS.sqlite.manifest.json
```

The `railway ssh` session prints session text around the command output. The
digest comparison is the authority: when the local digest does not match the
manifest, the transfer was damaged. Delete the file and export again. Fetch
the manifest with the same `base64` method when you do not have it locally.

Keep the exported pairs in your off-host backup system. `BACKUP_RETENTION_DAYS`
controls local rotation on the volume only. It does not remove off-host
copies. Set off-host retention separately and document it in the member
privacy notice.

Reasonable starting objectives are a 24-hour recovery point and a two-hour
manual recovery time. Adjust `BACKUP_INTERVAL_HOURS` and off-host copy
frequency if those targets are too loose.

## Test a backup

Run restore drills on another machine or an isolated volume. At minimum:

1. verify the manifest digest
2. open the database with Node.js 24
3. run `npm run integrity-check` against the restored path
4. start Mneme in observe mode
5. confirm schema migration and scoped search behavior

Record the date and result of each restore drill. A successful backup job
does not prove that the full restore procedure works.

## Restore a backup

Use this sequence on every install kind:

1. Set `MNEME_MODE=observe` in the deployment environment.
2. Stop Mneme and confirm no process holds the database open.
3. Preserve the entire damaged data directory. Do not overwrite your only copy.
4. Copy the chosen standalone backup to the configured `DATABASE_PATH`.
5. Reconcile completed deletions and cancelled requests against the preserved ledger
   as described below, before starting Mneme. Make sure stale `-wal` and `-shm` files from the damaged database are not
   placed beside the restored file.
6. Verify the digest before the first start (see below).
7. Start Mneme. Startup applies any migrations newer than the backup.
8. Wait for reconciliation and durable jobs to settle.
9. Compare `/mneme channels` with the current policy.
10. Verify completed deletions and pending requests against the preserved audit ledger.
11. Move to review or autonomous mode only after the restored state is
    checked.

### Restore on Docker Compose

Stop the service first, then move the file into the volume:

```bash
docker compose stop mneme

# Remove stale write-ahead files from the damaged database, if any remain.
docker run --rm -v <project>_mneme_data:/data alpine \
  sh -c 'rm -f /data/mneme.sqlite-wal /data/mneme.sqlite-shm'

docker compose cp ./mneme-YYYYMMDD-HHMMSS.sqlite \
  mneme:/app/data/mneme.sqlite

docker compose start mneme
```

Find the exact volume name with `docker volume ls`. The default Compose
project prefix is the directory name of your Compose file.

### Restore on Railway

> Rehearse a restore on a disposable service before you depend on it. The
> `railway ssh -- <command>` form may mangle quotes and pipes; run the
> commands interactively inside the ssh session, or wrap them in `sh -c
> '...'`.

The service must be stopped, but the volume must stay mounted. Point the
service start command at a long sleep, so the container runs without
Mneme:

1. In the Railway service settings, set the start command to
   `sleep infinity` and deploy.
2. Copy the backup in as base64, decode it on the volume, and verify:

   ```bash
   base64 mneme-YYYYMMDD-HHMMSS.sqlite | \
     railway ssh --service <service-name> -- \
       "base64 -d > /app/data/mneme.sqlite && \
        rm -f /app/data/mneme.sqlite-wal /app/data/mneme.sqlite-shm && \
        sha256sum /app/data/mneme.sqlite"
   ```

   Compare the printed digest with the manifest. When they differ, stop and
   export again; do not start Mneme on a damaged restore.
3. Remove the start-command override in the service settings.
4. Deploy again. Mneme starts against the restored file.

### Verify the restore

After the first start from a restored database:

```bash
curl --fail http://mneme.example.internal/readyz
```

Then, inside the container or a built checkout:

```bash
node dist/cli/commands.js integrity-check
```

Finish with `/mneme status` and `/mneme channels`, and one
scoped search question in the test console. Only then move out of observe
mode.

## Handle deletion requests after restore

A backup contains the deletion state that existed when it was created. It
cannot contain a request made later. Restoring an older backup can therefore
bring back content that was deleted after that backup.

Keep a deletion ledger outside the Mneme database if reliable replay is required.
Before starting Mneme on a restored database, reconcile the preserved audit
ledger and tombstones for **completed** purges, including committed batches of
partially executed requests. Do this offline so restored forgotten content is never
available to retrieval or model processing. This is an operator recovery procedure,
not an undo feature. Do not blindly reissue every historical request: pending or
cancelled requests do not authorize deletion, and the new commands require separate
approval plus a 24-hour grace period.

Reconcile cancellations too: an older backup may contain a scheduled request that
was subsequently cancelled. Cancel that restored request before starting workers.
A restored approved request whose deadline has passed can otherwise run immediately.
The readable preserved database and content-free admin events help reconstruct
these states; they should not be the only copy of the ledger. The normal new-request
flow is documented in [command reference](../reference/commands.md#memory-and-deletion).

Older backups may retain content until both local and off-host retention
remove them. State that delay plainly in the privacy notice.
