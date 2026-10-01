-- ABOUTME: Renames Discord-specific schema names to platform-neutral names (spec Section 29).
-- ABOUTME: Guild tables and columns become workspace names; outbox discord_message_id becomes platform_message_id (plan 002 decision 16).

ALTER TABLE guilds RENAME TO workspaces;
ALTER TABLE guild_members RENAME TO workspace_members;

ALTER TABLE channels RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE workspace_members RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE messages RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE episodes RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE memories RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE agent_runs RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE admin_events RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE message_tombstones RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE historical_memory_campaigns RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE direct_answer_requests RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE deep_recap_requests RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE channel_policy_reviews RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE ingestion_recovery_requests RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE attention_subjects RENAME COLUMN guild_id TO workspace_id;
ALTER TABLE deletion_requests RENAME COLUMN guild_id TO workspace_id;

ALTER TABLE outbox RENAME COLUMN discord_message_id TO platform_message_id;

DROP INDEX channels_guild_idx;
CREATE INDEX channels_workspace_idx
  ON channels(workspace_id, deleted_at_ms);

DROP INDEX channel_policy_reviews_guild_status_idx;
CREATE INDEX channel_policy_reviews_workspace_status_idx
  ON channel_policy_reviews(workspace_id, status, updated_at_ms);

DROP INDEX attention_subjects_guild_idx;
CREATE INDEX attention_subjects_workspace_idx
  ON attention_subjects(workspace_id, created_at_ms);

DROP INDEX outbox_discord_message_idx;
CREATE INDEX outbox_platform_message_idx
  ON outbox(platform_message_id)
  WHERE platform_message_id IS NOT NULL;
