import { type DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';

/**
 * Idempotent guild identity persistence (Section 9.1, 29.1).
 *
 * `discovered_at_ms` is set on first insert and never overwritten. Other fields
 * update only when they actually differ, so repeated identical input is a no-op
 * and does not bump `updated_at_ms`.
 */

export interface GuildUpsertInput {
  id: string;
  name: string;
  ownerId: string | null;
  joinedAtMs: number | null;
  discoveredAtMs: number;
  updatedAtMs: number;
  rawJson: string | null;
}

export interface GuildRow {
  id: string;
  name: string;
  owner_id: string | null;
  joined_at_ms: number | null;
  discovered_at_ms: number;
  updated_at_ms: number;
}

const UPSERT_SQL = `
  INSERT INTO workspaces (id, name, owner_id, joined_at_ms, discovered_at_ms, updated_at_ms, raw_json)
  VALUES (@id, @name, @owner_id, @joined_at_ms, @discovered_at_ms, @updated_at_ms, @raw_json)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    owner_id = excluded.owner_id,
    joined_at_ms = excluded.joined_at_ms,
    raw_json = excluded.raw_json,
    updated_at_ms = CASE
      WHEN excluded.name IS NOT workspaces.name
        OR excluded.owner_id IS NOT workspaces.owner_id
        OR excluded.joined_at_ms IS NOT workspaces.joined_at_ms
        OR excluded.raw_json IS NOT workspaces.raw_json
      THEN excluded.updated_at_ms
      ELSE workspaces.updated_at_ms
    END
  WHERE excluded.name IS NOT workspaces.name
     OR excluded.owner_id IS NOT workspaces.owner_id
     OR excluded.joined_at_ms IS NOT workspaces.joined_at_ms
     OR excluded.raw_json IS NOT workspaces.raw_json
`;

/**
 * Upsert a guild. Returns the number of rows actually changed (0 for a no-op).
 */
export function upsertGuild(db: DatabaseSync, input: GuildUpsertInput): number {
  const stmt = prepareCached(db, 'workspaces.upsert', UPSERT_SQL);
  const result = stmt.run({
    id: input.id,
    name: input.name,
    owner_id: input.ownerId,
    joined_at_ms: input.joinedAtMs,
    discovered_at_ms: input.discoveredAtMs,
    updated_at_ms: input.updatedAtMs,
    raw_json: input.rawJson,
  });
  return Number(result.changes);
}

export function getGuild(db: DatabaseSync, id: string): GuildRow | undefined {
  return prepareCached(db, 'workspaces.get', 'SELECT * FROM workspaces WHERE id = ?').get(id) as
    | GuildRow
    | undefined;
}
