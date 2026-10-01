# Section 46.5 chaos suite

Fault-injection tests for the eight chaos cases in [Section 46.5](../../MNEME_IMPLEMENTATION_SPEC.md)
of the implementation spec. Every case documents a recovery verdict: the
state the system is left in, whether it is recoverable, and confirmation that
there is no privacy leak and no silent corruption.

Faults are simulated at module boundaries. The suite uses no real process
kills, network drops, or disk fills. The suite drives the same
dependency-injection seams the production code is built around (`transaction`,
`classifyError`, the outbox sender, the job lease, the online backup API), so
the recovery behavior under test is the real recovery behavior.

## Cases and verdicts

| # | Case | Verdict | Owner |
| --- | --- | --- | --- |
| 1 | kill during a page insert | The page transaction rolls back atomically — no partial episode, no orphaned messages. Re-running the page after restart is idempotent (no loss, no duplicates). | `crash-recovery.test.ts` |
| 2 | kill during a model call | A model/provider failure closes the episode as `error` and returns; it never throws, so ingestion and the job queue are unaffected. | `integration/episode-review.test.ts` |
| 3 | kill after send, before outbox update | The outbox row is left `sending`; startup recovery checks recent Discord messages for the already-posted normalized content before deciding whether to requeue it. | `integration/outbox-crash-recovery.test.ts` |
| 4 | disconnect the network | A raw connection failure (no HTTP status, `ECONNREFUSED`/`ENOTFOUND`) classifies as **transient**, schedules a bounded exponential retry, and the next attempt sends exactly once. It is never misclassified as permanent. | `infrastructure-faults.test.ts` |
| 5 | corrupt a job lease | An expired lease is reclaimed and the job re-runs **once** (single claimant, no double execution); a persistently-failing job terminates at `max_attempts` rather than looping forever. A lease whose deadline was corrupted to NULL is **not** silently reclaimed — it stays `running` so it can never be double-run; it needs operator attention. | `infrastructure-faults.test.ts` |
| 6 | fill disk | There is no bespoke ENOSPC path; every write is inside a `transaction()`, so a mid-transaction write failure (modelled as `SQLITE_FULL`) rolls the transaction back and rethrows. No partial state commits; prior data is intact. | `crash-recovery.test.ts` |
| 7 | restore from backup | The online backup opens standalone after restore: it passes `integrity_check`, its schema version matches the source, re-running migrations is a no-op, and the FTS index still resolves backed-up phrases. It is a point-in-time snapshot (rows committed after the backup are absent) and carries the same visibility classes — no scope leak. | `backup-migration.test.ts` |
| 8 | deploy a migration, roll back app code | The migration runner is idempotent (re-applying on the current schema is a no-op, so restarting — even with older application code — corrupts nothing) and drift-checked (an applied migration edited on disk is refused rather than silently re-applied). | `unit/migrations.test.ts` |

## Coverage registry

`section-46.5-coverage.test.ts` maps each case to the test file that owns its
verdict and a verbatim needle that must appear there. It fails if any case loses
its backing test, so the eight cases cannot silently drift.

## Boundary simulation

A real `SIGKILL` during a write, a severed socket, or a full disk is difficult to
reproduce across CI environments. Those failures also prove only that the fault
happened, not that recovery worked. The production code isolates these faults
behind small dependency-injection seams. Simulating a fault at its seam exercises
the rollback, retry, reclaim, or restore path deterministically.
