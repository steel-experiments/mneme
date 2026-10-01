import { type DatabaseSync } from '../db/database.js';
import { authorizeAdmin, type AuthorizationReason } from '../policy/authorization.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import {
  ConfigStore,
  reloadConfig,
  type ConfigCandidateSources,
  type ReloadResult,
} from '../config-reload.js';

/**
 * `/mneme reload-policy` handler (Sections 7.2, 8, 15, 27).
 *
 * Thin command layer over {@link reloadConfig}: authorize the caller (fail
 * closed, audited on denial), then validate and atomically activate the
 * candidate channel-policy YAML and prompt files. On a validation failure the
 * previous policy stays live and the reply reports the rejection; on success
 * the reply reports the new hashes and whether cache maintenance was queued.
 * Neither path echoes message content or secrets — only short hash prefixes and
 * change counts. Reading the candidate files from disk (or receiving them from
 * the dispatcher) is the caller's job; this module stays free of discord.js
 * types so it is trivially testable.
 */

export const RELOAD_POLICY_SUBCOMMAND = 'reload-policy';

export interface HandleReloadPolicyInput {
  actorUserId: string;
  guildId: string;
  /** The caller's role ids, or null when unresolved (fail-closed). */
  memberRoleIds: readonly string[] | null;
}

export interface HandleReloadPolicyDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  /** The live config store whose active snapshot is swapped on success. */
  store: ConfigStore;
  nowMs: number;
  /** Candidate YAML + prompt sources, already read from disk. */
  candidate: ConfigCandidateSources;
  /** Enqueue the maintenance re-scope job when policy changes. */
  enqueueMaintenance?: () => { id: string; enqueued: boolean };
}

export type ReloadPolicyOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'done'; result: ReloadResult };

/**
 * Run the reload-policy command. Authorization is checked first and recorded on
 * denial; on success the reload runs (which records its own auditable event with
 * the hashes and changed channels).
 */
export function handleReloadPolicyCommand(
  input: HandleReloadPolicyInput,
  deps: HandleReloadPolicyDeps,
): ReloadPolicyOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!outcome.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'reload_policy',
      details: { authorized: false, reason: outcome.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: outcome.reason };
  }

  const result = reloadConfig({
    db: deps.db,
    store: deps.store,
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    nowMs: deps.nowMs,
    channelPolicyYml: deps.candidate.channelPolicyYml,
    promptFiles: deps.candidate.promptFiles,
    enqueueMaintenance: deps.enqueueMaintenance,
  });
  return { kind: 'done', result };
}

/** Format an ephemeral reply. Contains no content or secrets — only hash prefixes and counts. */
export function formatReloadPolicyReply(outcome: ReloadPolicyOutcome): string {
  if (outcome.kind === 'not_authorized') {
    return 'You are not authorized to reload policy.';
  }
  const r = outcome.result;
  if (!r.ok) {
    return `Reload rejected — previous policy remains active: ${r.error}`;
  }
  const parts = ['Policy and prompts reloaded.'];
  parts.push(`prompt ${r.promptVersion.slice(0, 12)}…`);
  parts.push(`policy ${r.channelPolicySha256.slice(0, 12)}…`);
  if (r.defaultChanged) parts.push('default rule changed');
  if (r.changedChannelIds.length > 0) parts.push(`${r.changedChannelIds.length} channel(s) changed`);
  parts.push(r.rescopeEnqueued ? 'memory re-scope queued' : 'no cache work needed');
  return parts.join(' ');
}
