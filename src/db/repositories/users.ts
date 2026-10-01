import { type DatabaseSync } from '../database.js';
import { prepareCached, toInt } from './util.js';

/**
 * Idempotent user and guild-member persistence (Section 9.1, 29.1).
 *
 * `first_seen_at_ms` is set once. `last_seen_at_ms` advances on every upsert so
 * activity tracking reflects the most recent observation. Identity fields
 * (username, global_name, is_bot) update only when they differ.
 */

export interface UserUpsertInput {
  id: string;
  username: string | null;
  globalName: string | null;
  isBot: boolean;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  rawJson: string | null;
}

export interface UserRow {
  id: string;
  username: string | null;
  global_name: string | null;
  is_bot: 0 | 1;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
}

// Identity fields bump updated_at only when they differ; last_seen advances on
// every observation. raw_json is preserved when the new value is null.
const USER_UPSERT_SQL = `
  INSERT INTO users (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms, raw_json)
  VALUES (@id, @username, @global_name, @is_bot, @first_seen_at_ms, @last_seen_at_ms, @raw_json)
  ON CONFLICT(id) DO UPDATE SET
    username = excluded.username,
    global_name = excluded.global_name,
    is_bot = excluded.is_bot,
    last_seen_at_ms = excluded.last_seen_at_ms,
    raw_json = CASE WHEN excluded.raw_json IS NULL THEN users.raw_json ELSE excluded.raw_json END,
    first_seen_at_ms = users.first_seen_at_ms
  WHERE excluded.username IS NOT users.username
     OR excluded.global_name IS NOT users.global_name
     OR excluded.is_bot IS NOT users.is_bot
     OR excluded.last_seen_at_ms IS NOT users.last_seen_at_ms
     OR excluded.raw_json IS NOT users.raw_json
`;

/** Upsert a user. Returns rows changed (0 for a no-op). */
export function upsertUser(db: DatabaseSync, input: UserUpsertInput): number {
  const stmt = prepareCached(db, 'users.upsert', USER_UPSERT_SQL);
  const result = stmt.run({
    id: input.id,
    username: input.username,
    global_name: input.globalName,
    is_bot: toInt(input.isBot),
    first_seen_at_ms: input.firstSeenAtMs,
    last_seen_at_ms: input.lastSeenAtMs,
    raw_json: input.rawJson,
  });
  return Number(result.changes);
}

export function getUser(db: DatabaseSync, id: string): UserRow | undefined {
  return prepareCached(db, 'users.get', 'SELECT * FROM users WHERE id = ?').get(id) as
    | UserRow
    | undefined;
}

export interface ObservedUserInput {
  id: string;
  observedAtMs: number;
}

/**
 * Record an observation that identifies a user without supplying an authoritative
 * profile. A reaction event has this shape: it can establish that a user exists
 * and advance the latest observation, but it cannot establish a name or bot
 * classification. Existing profile fields therefore remain untouched.
 */
export function ensureObservedUser(db: DatabaseSync, input: ObservedUserInput): number {
  const result = prepareCached(db, 'users.ensure_observed', `
    INSERT INTO users (id, first_seen_at_ms, last_seen_at_ms)
    VALUES (@id, @observedAtMs, @observedAtMs)
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at_ms = max(users.last_seen_at_ms, excluded.last_seen_at_ms)
    WHERE excluded.last_seen_at_ms > users.last_seen_at_ms
  `).run({ id: input.id, observedAtMs: input.observedAtMs });
  return Number(result.changes);
}

export interface MemberUpsertInput {
  guildId: string;
  userId: string;
  displayName: string | null;
  roleIdsJson: string;
  updatedAtMs: number;
}

const MEMBER_UPSERT_SQL = `
  INSERT INTO workspace_members (workspace_id, user_id, display_name, role_ids_json, updated_at_ms)
  VALUES (@workspace_id, @user_id, @display_name, @role_ids_json, @updated_at_ms)
  ON CONFLICT(workspace_id, user_id) DO UPDATE SET
    display_name = excluded.display_name,
    role_ids_json = excluded.role_ids_json,
    updated_at_ms = CASE
      WHEN excluded.display_name IS NOT workspace_members.display_name
        OR excluded.role_ids_json IS NOT workspace_members.role_ids_json
      THEN excluded.updated_at_ms
      ELSE workspace_members.updated_at_ms
    END
  WHERE excluded.display_name IS NOT workspace_members.display_name
     OR excluded.role_ids_json IS NOT workspace_members.role_ids_json
`;

/** Upsert a guild member. Returns rows changed (0 for a no-op). */
export function upsertGuildMember(db: DatabaseSync, input: MemberUpsertInput): number {
  const stmt = prepareCached(db, 'members.upsert', MEMBER_UPSERT_SQL);
  const result = stmt.run({
    workspace_id: input.guildId,
    user_id: input.userId,
    display_name: input.displayName,
    role_ids_json: input.roleIdsJson,
    updated_at_ms: input.updatedAtMs,
  });
  return Number(result.changes);
}

export interface ObservedGuildMemberInput {
  guildId: string;
  userId: string;
  observedAtMs: number;
}

/**
 * Ensure a membership row exists for an observation that carries no member
 * profile. Existing display names, roles, and their authoritative update time
 * are preserved because the observation has no replacement values.
 */
export function ensureObservedGuildMember(
  db: DatabaseSync,
  input: ObservedGuildMemberInput,
): number {
  const result = prepareCached(db, 'members.ensure_observed', `
    INSERT INTO workspace_members (workspace_id, user_id, updated_at_ms)
    VALUES (@guildId, @userId, @observedAtMs)
    ON CONFLICT(workspace_id, user_id) DO NOTHING
  `).run({
    guildId: input.guildId,
    userId: input.userId,
    observedAtMs: input.observedAtMs,
  });
  return Number(result.changes);
}
