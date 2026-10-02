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
 * A synthetic Slack id (plan 002 decisions 3 and 4): a message `<channel>-<ts>`
 * or a thread row `<channel>-T<thread_ts>`.
 */
export function isSlackSyntheticId(value: unknown): value is string {
  return typeof value === 'string' && /^[CG][A-Z0-9]{8,}-T?\d{10}\.\d{6}$/.test(value);
}

/**
 * A platform id for any supported platform. One deployment holds data from one
 * platform only (plan 002 decision 1), so the union cannot mix platforms.
 */
export function isPlatformId(value: unknown): value is string {
  return isDiscordId(value) || isSlackId(value) || isSlackSyntheticId(value);
}
