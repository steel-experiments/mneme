// ABOUTME: The one SQL definition of archive content that Mneme may serve (plan 011, spec §5.4): org content only.
// ABOUTME: Every archive count and read uses these predicates; there is no grant parameter and no exception.

/**
 * An org channel or thread that Mneme can serve from the archive, with the
 * given table aliases for the channel and its parent. Org class, ingested, not
 * deleted, no platform boundary, not a Mneme test surface, and never a Discord
 * private thread (one stored as org before private threads defaulted to
 * restricted stays hidden). A thread also needs a live, ingested parent
 * without a platform boundary.
 */
export function servableOrgChannel(c: string, p: string): string {
  return `(
    ${c}.visibility_class = 'org'
    AND ${c}.ingest_enabled = 1
    AND ${c}.deleted_at_ms IS NULL
    AND ${c}.platform_boundary IS NULL
    AND ${c}.is_private_thread = 0
    AND INSTR(LOWER(COALESCE(${c}.name, '')), 'mneme') = 0
    AND (${c}.is_thread = 0 OR (
      ${p}.id IS NOT NULL
      AND ${p}.deleted_at_ms IS NULL
      AND ${p}.ingest_enabled = 1
      AND ${p}.platform_boundary IS NULL
      AND INSTR(LOWER(COALESCE(${p}.name, '')), 'mneme') = 0
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
