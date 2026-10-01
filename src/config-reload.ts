import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type DatabaseSync, transactionImmediate } from './db/database.js';
import { recordAdminEvent } from './db/repositories/admin-events.js';
import type { ChannelPolicySource } from './config.js';
import {
  parseChannelPolicy,
  resolveChannel,
  type ChannelPolicy,
  type ChannelRule,
  type ReviewChannel,
} from './policy/channel-policy.js';
import {
  assertNoBasicSelectionInFileMode,
  basicChannelPolicySourceText,
} from './policy/channel-policy-bootstrap.js';
import {
  reconcileObservedChannelPolicyReviewInTransaction,
  resolveObservedChannelPolicy,
} from './policy/channel-policy-review-service.js';
import {
  PromptCompiler,
  loadPromptFiles,
  validatePromptStructure,
  type PromptFiles,
} from './agent/prompts.js';

/**
 * Atomic policy and prompt reload (Sections 7.2, 8, 15, 27).
 *
 * Mneme's retrieval boundary is computed at read time from the *currently
 * active* channel policy, so reloading that policy tightens (or loosens)
 * retrieval immediately for every subsequent run. To make a reload safe, a
 * candidate snapshot — parsed channel policy plus compiled prompt surface — is
 * built and fully validated *without touching live state*; only a valid
 * candidate is swapped into the {@link ConfigStore}. Any validation failure
 * leaves the previous snapshot active (Section 8: never serve a half-broken
 * policy). On a successful activation the new hashes and the set of changed
 * channels are audited, and a cache-maintenance re-scope is queued so the
 * cached `scope_*` columns converge to the new policy (read-time recomputation
 * stays authoritative either way).
 *
 * The initial policy comes from one of two sources (CHANNEL_POLICY_SOURCE):
 * 'file' loads channel-policy.yml and supports the live reload described above;
 * 'basic' (the default) translates the environment selection lists through
 * src/policy/channel-policy-bootstrap.ts and never reads the YAML file. A
 * basic-mode snapshot is marked as such and reload attempts are denied with an
 * operator-facing restart notice — in both modes, changes take effect after a
 * restart.
 */

/** Raised when a candidate snapshot cannot be built or is internally inconsistent. */
export class ConfigReloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigReloadError';
  }
}

/**
 * Immutable in-memory snapshot of every configuration that influences a run: the
 * resolved channel policy, its source text and hash, and the compiled prompt
 * surface with its version. Replacing the single active reference is the atomic
 * activation primitive — a reader either sees the whole previous snapshot or the
 * whole new one, never a mix.
 */
export interface ConfigSnapshot {
  channelPolicy: ChannelPolicy;
  /**
   * Source this snapshot was built from. Snapshots built by
   * {@link buildConfigSnapshot} without an explicit source are 'file'; a
   * 'basic' snapshot makes every live reload attempt fail politely.
   */
  channelPolicySource: ChannelPolicySource;
  channelPolicyYml: string;
  channelPolicySha256: string;
  promptCompiler: PromptCompiler;
  /** Prompt version for the `system` task, representative of the whole surface. */
  promptVersion: string;
  loadedAtMs: number;
}

/**
 * Holds the single active {@link ConfigSnapshot}. {@link get} returns the live
 * reference; {@link swap} replaces it atomically and returns the previous one so
 * callers can diff old vs new. Concurrent readers that captured the reference
 * before a swap keep using the old snapshot for the rest of their request, which
 * is exactly the all-or-nothing visibility the spec requires.
 */
export class ConfigStore {
  private active: ConfigSnapshot;

  constructor(initial: ConfigSnapshot) {
    this.active = initial;
  }

  get(): ConfigSnapshot {
    return this.active;
  }

  swap(next: ConfigSnapshot): ConfigSnapshot {
    const prev = this.active;
    this.active = next;
    return prev;
  }
}

/** Structural slice of {@link AppConfig} naming the on-disk config sources. */
export interface ConfigSourcePaths {
  channelPolicyPath: string;
  promptDir: string;
  /** CHANNEL_POLICY_SOURCE as the config loader resolved it (unset means 'basic'). */
  channelPolicySource: ChannelPolicySource;
  /** Environment carrying the basic selection lists; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** The candidate sources a reload validates: YAML text plus loaded prompt files. */
export interface ConfigCandidateSources {
  channelPolicyYml: string;
  promptFiles: PromptFiles;
}

/**
 * Read the candidate policy source and the prompt surface. File mode reads
 * channel-policy.yml from disk; basic mode translates the current environment
 * selection. CHANNEL_POLICY_PATH is never read in basic mode. The reload path
 * denies basic mode before these sources activate, so in basic mode the text
 * only feeds validation and hashing.
 */
export function readConfigCandidate(paths: ConfigSourcePaths): ConfigCandidateSources {
  const promptFiles = loadPromptFiles(paths.promptDir);
  if (paths.channelPolicySource === 'basic') {
    return { channelPolicyYml: basicChannelPolicySourceText(paths.env ?? process.env), promptFiles };
  }
  const channelPolicyYml = readFileSync(paths.channelPolicyPath, 'utf8');
  return { channelPolicyYml, promptFiles };
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function ruleEqual(a: ChannelRule, b: ChannelRule): boolean {
  return (
    a.ingest === b.ingest && a.visibility === b.visibility && a.allow_interventions === b.allow_interventions
  );
}

function reviewEqual(a: ReviewChannel | undefined, b: ReviewChannel | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id || a.secure !== b.secure || a.accepts_scopes.length !== b.accepts_scopes.length) return false;
  const as = new Set(a.accepts_scopes);
  return b.accepts_scopes.every((s) => as.has(s));
}

/** Ids whose explicit rule (channel or category) differs between two policies. */
function changedRuleIds(
  old: Map<string, ChannelRule>,
  next: Map<string, ChannelRule>,
): string[] {
  const out: string[] = [];
  for (const id of new Set<string>([...old.keys(), ...next.keys()])) {
    const a = old.get(id);
    const b = next.get(id);
    if (!a || !b || !ruleEqual(a, b)) out.push(id);
  }
  return out;
}

export interface PolicyDiff {
  /** True when any rule (default, category, channel) or the review channel changed. */
  policyChanged: boolean;
  defaultChanged: boolean;
  /** Explicit channel and category ids whose rule changed (informational). */
  changedChannelIds: string[];
}

/** Compare two policies and report what a reload would have to converge. */
export function diffChannelPolicy(old: ChannelPolicy, next: ChannelPolicy): PolicyDiff {
  const defaultChanged = !ruleEqual(old.default, next.default);
  const changedChannels = changedRuleIds(old.channels, next.channels);
  const changedCategories = changedRuleIds(old.categories, next.categories);
  const reviewChanged = !reviewEqual(old.review_channel, next.review_channel);
  const changedChannelIds = [...changedChannels, ...changedCategories];
  const policyChanged = defaultChanged || changedChannelIds.length > 0 || reviewChanged;
  return { policyChanged, defaultChanged, changedChannelIds };
}

/**
 * Build a fully validated candidate snapshot without touching any live state.
 * Throws {@link ConfigReloadError} on any YAML, prompt-compile, or review-channel
 * inconsistency so the caller can reject the reload and keep the previous policy.
 */
export function buildConfigSnapshot(input: {
  channelPolicyYml: string;
  promptFiles: PromptFiles;
  now: number;
  /** Source the snapshot was built from; omitted means 'file'. */
  channelPolicySource?: ChannelPolicySource;
}): ConfigSnapshot {
  let channelPolicy: ChannelPolicy;
  try {
    // The basic mode supplies generated YAML, so both sources share this one
    // validated parser: the translator never becomes a second policy engine.
    channelPolicy = parseChannelPolicy(input.channelPolicyYml);
  } catch (err) {
    throw new ConfigReloadError(`channel-policy: ${(err as Error).message}`);
  }

  let promptCompiler: PromptCompiler;
  try {
    promptCompiler = new PromptCompiler(input.promptFiles);
    // Structural validation: dry-render every template and partial so a broken
    // surface is rejected here, before the snapshot can be swapped live.
    validatePromptStructure(input.promptFiles);
  } catch (err) {
    throw new ConfigReloadError(`prompts: ${(err as Error).message}`);
  }

  const channelPolicySha256 = sha256(input.channelPolicyYml);
  const promptVersion = promptCompiler.versionFor('system', { channelPolicyYml: input.channelPolicyYml });
  return {
    channelPolicy,
    channelPolicySource: input.channelPolicySource ?? 'file',
    channelPolicyYml: input.channelPolicyYml,
    channelPolicySha256,
    promptCompiler,
    promptVersion,
    loadedAtMs: input.now,
  };
}

/**
 * Reject a review channel that is internally inconsistent: a configured review
 * channel must be `secure` and accept at least one scope, otherwise routed
 * memories would have nowhere safe to land. No review channel is allowed (the
 * deployment may run in observe-only mode).
 */
export function validateReviewChannel(policy: ChannelPolicy): void {
  const rc = policy.review_channel;
  if (!rc) return;
  if (!rc.secure) {
    throw new ConfigReloadError(`review_channel ${rc.id} must be secure (secure: true)`);
  }
  if (rc.accepts_scopes.length === 0) {
    throw new ConfigReloadError(`review_channel ${rc.id} must accept at least one scope`);
  }
}

export interface ReloadConfigDeps {
  db: DatabaseSync;
  store: ConfigStore;
  guildId: string;
  /** System/admin actor recorded on the audit event. */
  actorUserId: string;
  nowMs: number;
  /** Candidate sources, already read from disk (or injected for tests). */
  channelPolicyYml: string;
  promptFiles: PromptFiles;
  /**
   * Enqueue the cache-maintenance (memory re-scope) job when the policy changed.
   * Injected so tests can observe the enqueue without a live worker.
   */
  enqueueMaintenance?: () => { id: string; enqueued: boolean };
}

interface StoredPolicyChannel {
  id: string;
  parent_id: string | null;
  is_thread: number;
  type: number;
}

/** Persist the candidate policy for every known channel before it becomes live. */
function reconcileStoredChannels(
  db: DatabaseSync,
  guildId: string,
  policy: ChannelPolicy,
  nowMs: number,
  previousPolicy?: ChannelPolicy,
): void {
  const rows = db.prepare(
    `SELECT id, parent_id, is_thread, type
       FROM channels
      WHERE workspace_id = ? AND deleted_at_ms IS NULL`,
  ).all(guildId) as unknown as StoredPolicyChannel[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const update = db.prepare(
    `UPDATE channels
        SET ingest_enabled = @ingest,
            visibility_class = @visibility,
            allow_interventions = @allowInterventions,
            updated_at_ms = @now
      WHERE id = @id`,
  );

  for (const row of rows) {
    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    const categoryId = row.is_thread === 1 ? parent?.parent_id ?? undefined : row.parent_id ?? undefined;
    const identity = {
      id: row.id,
      guildId,
      parentId: row.parent_id,
      isThread: row.is_thread === 1,
      type: row.type,
      categoryId,
    };
    const resolutionContext = {
      isThread: row.is_thread === 1,
      parentId: row.is_thread === 1 ? row.parent_id ?? undefined : undefined,
      categoryId,
    };
    const staticResolved = resolveChannel(policy, row.id, resolutionContext);
    const previousStatic = previousPolicy
      ? resolveChannel(previousPolicy, row.id, resolutionContext)
      : undefined;
    const resolved = resolveObservedChannelPolicy(db, policy, identity);
    const enabled = resolved.rule.ingest && resolved.rule.visibility !== 'excluded';
    update.run({
      id: row.id,
      ingest: enabled ? 1 : 0,
      visibility: enabled ? resolved.rule.visibility : 'excluded',
      allowInterventions: enabled && resolved.rule.allow_interventions ? 1 : 0,
      now: nowMs,
    });
    db.prepare(`UPDATE sync_cursors SET
      state = CASE WHEN ?=0 THEN 'excluded'
                   WHEN state='excluded' AND history_complete=1 THEN 'live'
                   WHEN state='excluded' THEN 'pending'
                   ELSE state END,
      updated_at_ms=? WHERE channel_id=?`).run(enabled ? 1 : 0, nowMs, row.id);
    reconcileObservedChannelPolicyReviewInTransaction(db, policy, identity, nowMs, {
      forceReview: previousStatic?.source !== 'default' && staticResolved.source === 'default',
    });
  }
}

export type ReloadResult =
  | {
      ok: true;
      promptVersion: string;
      channelPolicySha256: string;
      defaultChanged: boolean;
      changedChannelIds: string[];
      reviewChannelId?: string;
      rescopeEnqueued: boolean;
      auditEventId: string;
    }
  | { ok: false; error: string; auditEventId: string };

/**
 * Validate a candidate snapshot, and only on full success atomically activate
 * it, audit the new hashes and changed channels, and queue cache maintenance.
 * Any validation failure records the attempt and returns `{ ok: false }` with
 * the previous snapshot still active (Section 8: invalid reload changes nothing).
 */
export function reloadConfig(deps: ReloadConfigDeps): ReloadResult {
  // Basic mode is driven by environment variables, so a live swap would bypass
  // the operator's restart. Deny politely, keep the previous snapshot active,
  // and record the attempt on the same audit trail as every other reload.
  if (deps.store.get().channelPolicySource === 'basic') {
    const error =
      'channel policy reload requires CHANNEL_POLICY_SOURCE=file; the basic policy comes from environment variables and changes take effect after restart';
    const auditEventId = recordAdminEvent(deps.db, {
      guildId: deps.guildId,
      actorUserId: deps.actorUserId,
      action: 'reload_policy',
      details: { success: false, error },
      createdAtMs: deps.nowMs,
    });
    return { ok: false, error, auditEventId };
  }

  let candidate: ConfigSnapshot;
  try {
    candidate = buildConfigSnapshot({
      channelPolicyYml: deps.channelPolicyYml,
      promptFiles: deps.promptFiles,
      now: deps.nowMs,
    });
    validateReviewChannel(candidate.channelPolicy);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const auditEventId = recordAdminEvent(deps.db, {
      guildId: deps.guildId,
      actorUserId: deps.actorUserId,
      action: 'reload_policy',
      details: { success: false, error },
      createdAtMs: deps.nowMs,
    });
    return { ok: false, error, auditEventId };
  }

  const prev = deps.store.get();
  const diff = diffChannelPolicy(prev.channelPolicy, candidate.channelPolicy);

  const previousReviewId = prev.channelPolicy.review_channel?.id;
  const candidateReviewId = candidate.channelPolicy.review_channel?.id;
  if (previousReviewId !== candidateReviewId) {
    const error = 'review_channel.id cannot change during reload; restart with matching configuration';
    const auditEventId = recordAdminEvent(deps.db, {
      guildId: deps.guildId, actorUserId: deps.actorUserId, action: 'reload_policy',
      details: { success: false, error }, createdAtMs: deps.nowMs,
    });
    return { ok: false, error, auditEventId };
  }

  let auditEventId = '';
  let rescopeEnqueued = false;
  try {
    transactionImmediate(deps.db, () => {
      reconcileStoredChannels(
        deps.db,
        deps.guildId,
        candidate.channelPolicy,
        deps.nowMs,
        prev.channelPolicy,
      );
      auditEventId = recordAdminEvent(deps.db, {
        guildId: deps.guildId,
        actorUserId: deps.actorUserId,
        action: 'reload_policy',
        details: {
          success: true,
          promptVersion: candidate.promptVersion,
          channelPolicySha256: candidate.channelPolicySha256,
          defaultChanged: diff.defaultChanged,
          changedChannels: diff.changedChannelIds,
          reviewChannelId: candidateReviewId,
        },
        createdAtMs: deps.nowMs,
      });
      if (diff.policyChanged && deps.enqueueMaintenance) {
        rescopeEnqueued = deps.enqueueMaintenance().enqueued;
      }
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failureAuditId = recordAdminEvent(deps.db, {
      guildId: deps.guildId, actorUserId: deps.actorUserId, action: 'reload_policy',
      details: { success: false, error }, createdAtMs: deps.nowMs,
    });
    return { ok: false, error, auditEventId: failureAuditId };
  }

  deps.store.swap(candidate);

  return {
    ok: true,
    promptVersion: candidate.promptVersion,
    channelPolicySha256: candidate.channelPolicySha256,
    defaultChanged: diff.defaultChanged,
    changedChannelIds: diff.changedChannelIds,
    reviewChannelId: candidate.channelPolicy.review_channel?.id,
    rescopeEnqueued,
    auditEventId,
  };
}

/**
 * Build the initial snapshot at startup (fail-fast: a boot with an invalid
 * channel policy or prompt surface throws rather than serving a broken config).
 * Wired into the process bootstrap by the startup task.
 */
export function loadInitialSnapshot(paths: ConfigSourcePaths, now: number): ConfigSnapshot {
  const source = paths.channelPolicySource;
  if (source === 'file') {
    // Reject the mixed setup before the file is read: a file-mode deployment
    // must not also carry basic selection lists.
    assertNoBasicSelectionInFileMode(paths.env ?? process.env);
  }
  const { channelPolicyYml, promptFiles } = readConfigCandidate(paths);
  const candidate = buildConfigSnapshot({ channelPolicyYml, promptFiles, now, channelPolicySource: source });
  validateReviewChannel(candidate.channelPolicy);
  return candidate;
}
