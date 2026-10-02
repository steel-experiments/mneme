-- ABOUTME: Stores the platform boundary on a channel row (spec Section 7.1, plan 002 decision 9).
-- ABOUTME: 'excluded' marks a Slack Connect channel; no policy source can override it.

ALTER TABLE channels ADD COLUMN platform_boundary TEXT
  CHECK (platform_boundary IS NULL OR platform_boundary = 'excluded');
