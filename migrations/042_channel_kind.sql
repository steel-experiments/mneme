-- ABOUTME: Replaces the Discord numeric channel type with a platform-neutral channel kind.
-- ABOUTME: The mapping matches channelKindOf in the Discord adapter (plan 002 decision 17).

ALTER TABLE channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';

UPDATE channels SET kind = CASE type
  WHEN 0 THEN 'text'
  WHEN 5 THEN 'announcement'
  WHEN 15 THEN 'forum'
  WHEN 16 THEN 'media'
  WHEN 4 THEN 'category'
  WHEN 10 THEN 'thread'
  WHEN 11 THEN 'thread'
  WHEN 12 THEN 'thread'
  ELSE 'other'
END;

ALTER TABLE channels DROP COLUMN type;
