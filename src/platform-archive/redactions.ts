// ABOUTME: Loads the deletions that apply to a read-only platform archive (plan 011 step 4).
// ABOUTME: Redactions live in the live database and match on the archive workspace id, so every copy of the archive obeys them.
import type { DatabaseSync } from 'node:sqlite';

/** Archive message ids and author ids that no archive read may return. */
export interface ArchiveRedactions {
  messageIds: string[];
  userIds: string[];
}

/**
 * Load every redaction for `archiveWorkspaceId`. The archive file hash is not
 * a filter: a redaction also applies to an older copy that was not rewritten.
 */
export function loadRedactions(liveDb: DatabaseSync, archiveWorkspaceId: string): ArchiveRedactions {
  const rows = liveDb.prepare(
    `SELECT target_kind, target_id FROM archive_redactions
      WHERE archive_workspace_id = ?
      ORDER BY target_kind, target_id`,
  ).all(archiveWorkspaceId) as Array<{ target_kind: string; target_id: string }>;
  const redactions: ArchiveRedactions = { messageIds: [], userIds: [] };
  for (const row of rows) {
    if (row.target_kind === 'message') redactions.messageIds.push(row.target_id);
    else if (row.target_kind === 'user') redactions.userIds.push(row.target_id);
  }
  return redactions;
}
