import type { DatabaseSync } from '../../db/database.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';
import { rescopeMemories, type RescopeResult } from '../../memory/maintenance.js';

/**
 * `rescope_memories` job handler: rewrite cached memory scopes to the current channel
 * policy (Sections 7.2, 27). Queued by `/mneme reload-policy`. The handler
 * rescopes every memory (a policy reload may have changed any channel) using a
 * system actor; each material change is audited in `admin_events`. Read-time
 * recomputation remains the enforcement boundary, so this job only converges the
 * cache.
 */

export interface RescopeMemoriesHandlerDeps {
  db: DatabaseSync;
  guildId: string;
  /** System/admin actor recorded on the audit events. */
  actorUserId: string;
  /** Inject a clock for deterministic tests (default Date.now). */
  now?: () => number;
}

export interface RescopeMemoriesHandlerResult {
  result: RescopeResult;
}

/**
 * Build a `rescope_memories` job handler that performs a full memory re-scope and
 * resolves with a summary of the changes.
 */
export function createRescopeMemoriesHandler(
  deps: RescopeMemoriesHandlerDeps,
): JobHandler<'rescope_memories'> & {
  /** Run the handler and resolve with the rescope summary (for tests/callers). */
  runRescope(): Promise<RescopeMemoriesHandlerResult>;
} {
  const handler = async (_payload: Record<string, never>, _job: JobRow): Promise<void> => {
    rescopeMemories(deps.db, {
      affectedChannelIds: null,
      actorUserId: deps.actorUserId,
      guildId: deps.guildId,
      now: deps.now?.() ?? Date.now(),
    });
  };

  return Object.assign(handler, {
    async runRescope(): Promise<RescopeMemoriesHandlerResult> {
      const result = rescopeMemories(deps.db, {
        affectedChannelIds: null,
        actorUserId: deps.actorUserId,
        guildId: deps.guildId,
        now: deps.now?.() ?? Date.now(),
      });
      return { result };
    },
  });
}
