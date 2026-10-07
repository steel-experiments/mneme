-- ABOUTME: Records deletions that apply to a read-only platform archive (plan 011 step 4, spec §5.4).
-- ABOUTME: Rows match on the archive workspace id; archive_sha256 is for audit only and never filters.

CREATE TABLE archive_redactions (
  id TEXT PRIMARY KEY,
  archive_workspace_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('user', 'message')),
  target_id TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  deletion_request_id TEXT REFERENCES deletion_requests(id),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (archive_workspace_id, target_kind, target_id)
);
