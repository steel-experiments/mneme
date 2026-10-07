-- ABOUTME: Records which platform archive an archive deletion request targets (plan 011, PR #19 review).
-- ABOUTME: Execution refuses to write a redaction when the configured archive is a different one.

ALTER TABLE deletion_requests ADD COLUMN archive_workspace_id TEXT;
