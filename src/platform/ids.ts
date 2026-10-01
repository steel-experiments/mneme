// ABOUTME: Validates platform ids (channel, user, role, message, and attachment ids).
// ABOUTME: Every id-format check in the host goes through this one function.

/** A platform id. Discord ids are snowflakes: 17–20 decimal digits. */
export function isPlatformId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}
