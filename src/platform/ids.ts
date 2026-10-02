// ABOUTME: Validates platform ids (channel, user, role, message, and attachment ids).
// ABOUTME: Every id-format check in the host goes through these functions.

/** A Discord id is a snowflake: 17–20 decimal digits. */
export function isDiscordId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

/**
 * A raw Slack id: a conversation (C, G, D), user (U, W), team (T), bot (B), or
 * file (F) id. Slack ids are upper-case letters and digits after the prefix.
 */
export function isSlackId(value: unknown): value is string {
  return typeof value === 'string' && /^[CGDUWTBF][A-Z0-9]{8,}$/.test(value);
}

/**
 * A raw platform id for any supported platform. One deployment holds data from
 * one platform only (plan 002 decision 1), so the union cannot mix platforms.
 */
export function isPlatformId(value: unknown): value is string {
  return isDiscordId(value) || isSlackId(value);
}
