// ABOUTME: Bot scopes and events that the Slack adapter needs (spec Section 6.7).
// ABOUTME: config/slack-app-manifest.yml must request exactly these; a unit test keeps them equal.

/** Every bot scope that the Slack adapter uses, sorted. */
export const SLACK_BOT_SCOPES = [
  'channels:history',
  'channels:read',
  'chat:write',
  'commands',
  'files:read',
  'groups:history',
  'groups:read',
  'im:write',
  'reactions:read',
  'users:read',
] as const;

/** Every bot event that the Slack adapter handles, sorted. */
export const SLACK_BOT_EVENTS = [
  'channel_archive',
  'channel_created',
  'channel_deleted',
  'channel_left',
  'channel_rename',
  'channel_shared',
  'channel_unarchive',
  'channel_unshared',
  'group_archive',
  'group_deleted',
  'group_left',
  'group_rename',
  'group_unarchive',
  'member_joined_channel',
  'member_left_channel',
  'message.channels',
  'message.groups',
  'reaction_added',
  'reaction_removed',
] as const;
