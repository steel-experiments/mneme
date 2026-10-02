// ABOUTME: Bot scopes and events that the Slack adapter needs (spec Section 6.7).
// ABOUTME: The app manifest must request exactly these.

/** Bot scopes that the read path uses. */
export const SLACK_READ_SCOPES = [
  'channels:read',
  'groups:read',
  'channels:history',
  'groups:history',
  'reactions:read',
  'users:read',
  'files:read',
] as const;

/** Bot events that the read path handles. */
export const SLACK_READ_EVENTS = [
  'message.channels',
  'message.groups',
  'reaction_added',
  'reaction_removed',
  'channel_created',
  'channel_rename',
  'channel_deleted',
  'channel_archive',
  'channel_unarchive',
  'channel_left',
  'group_rename',
  'group_deleted',
  'group_archive',
  'group_unarchive',
  'group_left',
  'member_joined_channel',
  'member_left_channel',
  'channel_shared',
  'channel_unshared',
] as const;
