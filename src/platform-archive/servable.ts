// ABOUTME: The one SQL definition of archive content that Mneme may serve (plan 011, spec §5.4): org content only.
// ABOUTME: Every archive count and read uses these predicates; there is no grant parameter and no exception.

/**
 * When migration 045 started to record Discord private threads, in the
 * archive's own source database. NULL when the archive has no such record.
 */
const PRIVATE_FLAG_SINCE = '(SELECT applied_at_ms FROM schema_migrations WHERE version = 45)';

/**
 * True when the private-thread flag of thread row `c` is known to be correct:
 * the row was created after migration 045, or discovery observed it again
 * after 045 (every discovery observation writes an access audit). Migration
 * 045 gave every older row the flag 0, and a frozen archive is never observed
 * again, so an older row that is a Discord private thread looks like a public
 * one. Such a row fails this test and stays hidden. When the archive has no
 * record of 045, every comparison is NULL and every thread stays hidden.
 */
export function privateFlagObserved(c: string): string {
  return `(
    ${c}.discovered_at_ms >= ${PRIVATE_FLAG_SINCE}
    OR EXISTS (SELECT 1 FROM channel_access_audits aud
                WHERE aud.channel_id = ${c}.id AND aud.checked_at_ms >= ${PRIVATE_FLAG_SINCE})
  )`;
}

/**
 * True when channel `c` is named like a Mneme test channel. The archive also
 * matches "cassandra": before v2.0.0 the product was named Cassandra, and its
 * test channels were named "cassandra-*". The live rule matches only "mneme".
 */
export function archiveTestSurfaceName(c: string): string {
  return `(INSTR(LOWER(COALESCE(${c}.name, '')), 'mneme') > 0
    OR INSTR(LOWER(COALESCE(${c}.name, '')), 'cassandra') > 0)`;
}

/**
 * An org channel or thread that Mneme can serve from the archive, with the
 * given table aliases for the channel and its parent. Org class, ingested, not
 * deleted, no platform boundary, not a test surface under either product name
 * ({@link archiveTestSurfaceName}), and never a Discord
 * private thread. A thread is served only when its private flag is known to be
 * correct ({@link privateFlagObserved}); a thread last seen before migration
 * 045 stays hidden. A thread also needs a live, ingested parent without a
 * platform boundary.
 */
export function servableOrgChannel(c: string, p: string): string {
  return `(
    ${c}.visibility_class = 'org'
    AND ${c}.ingest_enabled = 1
    AND ${c}.deleted_at_ms IS NULL
    AND ${c}.platform_boundary IS NULL
    AND ${c}.is_private_thread = 0
    AND NOT ${archiveTestSurfaceName(c)}
    AND (${c}.is_thread = 0 OR (
      ${privateFlagObserved(c)}
      AND ${p}.id IS NOT NULL
      AND ${p}.deleted_at_ms IS NULL
      AND ${p}.ingest_enabled = 1
      AND ${p}.platform_boundary IS NULL
      AND NOT ${archiveTestSurfaceName(p)}
    ))
  )`;
}

/**
 * A message that Mneme can serve: not deleted, no tombstone, in a servable org
 * channel, and not redacted by id or by author. The redaction lists are the
 * named JSON array parameters `:redacted_messages` and `:redacted_users`.
 */
export function servableMessage(m: string, c: string, p: string): string {
  return `(
    ${m}.id IS NOT NULL
    AND ${m}.deleted_at_ms IS NULL
    AND NOT EXISTS (SELECT 1 FROM message_tombstones tomb WHERE tomb.message_id = ${m}.id)
    AND ${servableOrgChannel(c, p)}
    AND ${m}.id NOT IN (SELECT value FROM json_each(:redacted_messages))
    AND ${m}.author_id NOT IN (SELECT value FROM json_each(:redacted_users))
  )`;
}

/**
 * An active org-scoped memory with at least one evidence message, all of whose
 * evidence messages are servable. A memory with any hidden, missing, or
 * redacted evidence is hidden, so its statement cannot carry hidden facts.
 */
export function servableMemory(mem: string): string {
  return `(
    ${mem}.scope_type = 'org'
    AND ${mem}.status = 'active'
    AND EXISTS (SELECT 1 FROM memory_evidence ev WHERE ev.memory_id = ${mem}.id)
    AND NOT EXISTS (
      SELECT 1 FROM memory_evidence ev
        LEFT JOIN messages em ON em.id = ev.message_id
        LEFT JOIN channels ec ON ec.id = em.channel_id
        LEFT JOIN channels ep ON ep.id = ec.parent_id
       WHERE ev.memory_id = ${mem}.id
         AND COALESCE(${servableMessage('em', 'ec', 'ep')}, 0) = 0
    )
  )`;
}

/** Parameters for a query without redactions, for startup counts. */
export const NO_REDACTIONS = Object.freeze({ redacted_messages: '[]', redacted_users: '[]' });
