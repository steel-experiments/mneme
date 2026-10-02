-- ABOUTME: Stores whether a channel row is a Discord private thread (spec Section 7.1).
-- ABOUTME: A private thread defaults to restricted, so policy reloads must know the flag.

ALTER TABLE channels ADD COLUMN is_private_thread INTEGER NOT NULL DEFAULT 0
  CHECK (is_private_thread IN (0, 1));
