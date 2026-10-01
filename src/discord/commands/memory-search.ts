import { type DatabaseSync } from '../../db/database.js';
import type { RetrievalGrant } from '../../db/repositories/message-search.js';
import {
  searchMemories,
  getMemoryDetails,
  getMemoryEvidence,
  DEFAULT_MEMORY_LIMIT,
  MAX_MEMORY_LIMIT,
  type MemorySearchResult,
  type MemoryDetails,
  type MemoryEvidenceResult,
} from '../../memory/search.js';
import { authorizeAndAuditAdminAction } from '../authorization.js';

/**
 * `/mneme memory-search <query>` (Sections 7.3, 27).
 *
 * An admin search over organizational memory. Visibility is computed by the
 * host, never the model: the command builds a {@link RetrievalGrant} from WHERE
 * it was invoked, and {@link searchMemories} recomputes each candidate memory's
 * effective scope at read time and keeps only what the grant permits.
 *
 * The single privacy decision is the grant:
 *
 * - Invoked **outside** the configured secure review channel, the grant is org
 *   only (`includeReviewOnly = false`, no restricted `channelIds`). Every
 *   `review_only` memory and every restricted-channel-scoped memory is filtered
 *   out by `scopePermitted`, so no broader restricted or review-only memory is
 *   ever disclosed — regardless of what the admin types.
 *
 * - Invoked **in** the secure review channel, the grant widens to include
 *   review-only memory and every restricted channel, so a reviewer can see all
 *   scopes (Section 7.3).
 *
 * The handler is free of discord.js types; a dispatcher extracts the actor,
 * roles, the `query` option, and the channel id the interaction came from, then
 * replies with {@link formatMemorySearchReply}.
 */

const DEFAULT_LIST_LIMIT = DEFAULT_MEMORY_LIMIT;

/** The channel id where the interaction originated, or null if unavailable (DM). */
export interface HandleMemorySearchInput {
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
  query: string;
  /** Channel id the command was invoked in (null in a DM / when unavailable). */
  invocationChannelId?: string | null;
}

export interface HandleMemorySearchDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  /** The configured secure review channel id (`config.reviewChannelId`). */
  reviewChannelId?: string | null;
  /** Result cap (default 10, clamped to the search ceiling of 50). */
  limit?: number;
}

/** How broadly the command disclosed, for the audit row and the reply header. */
export type MemorySearchScope = 'secure_review' | 'org_only';

export type MemorySearchOutcome =
  | { kind: 'not_authorized' }
  | { kind: 'done'; results: readonly MemorySearchResult[]; scope: MemorySearchScope };

export type MemoryGetOutcome =
  | { kind: 'not_authorized' }
  | { kind: 'not_visible' }
  | {
      kind: 'done';
      memory: MemoryDetails;
      evidence: readonly MemoryEvidenceResult[];
      scope: MemorySearchScope;
    };

/**
 * Decide the disclosure scope from the invocation channel. Anything other than
 * the configured secure review channel — including a DM, an org channel, or a
 * restricted channel — collapses to org-only disclosure. The grant is then built
 * by {@link buildMemorySearchGrant} to match.
 */
export function resolveMemorySearchScope(
  invocationChannelId: string | null | undefined,
  reviewChannelId: string | null | undefined,
): MemorySearchScope {
  const secure =
    reviewChannelId !== undefined &&
    reviewChannelId !== null &&
    reviewChannelId !== '' &&
    invocationChannelId === reviewChannelId;
  return secure ? 'secure_review' : 'org_only';
}

/**
 * Build the retrieval grant for a memory search. Org only outside the secure
 * review channel; every scope inside it. This is the chokepoint — there is no
 * other code path to memory rows.
 */
export function buildMemorySearchGrant(
  db: DatabaseSync,
  scope: MemorySearchScope,
): RetrievalGrant {
  if (scope === 'org_only') {
    return { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
  }
  // Secure review: disclose every scope. Restricted-channel-scoped memories are
  // gated by `channelVisibilityPredicate`, so enumerate restricted channel ids.
  const rows = db
    .prepare('SELECT id FROM channels WHERE visibility_class = ?')
    .all('restricted') as Array<{ id: string }> | undefined;
  const channelIds = (rows ?? []).map((r) => r.id);
  return { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: true, channelIds };
}

/**
 * Run `/mneme memory-search`. Authorize first (audited on both denial and
 * success with the disclosure scope), build the grant for the invocation
 * channel, then search — disclosing only what the grant permits.
 */
export function handleMemorySearchCommand(
  input: HandleMemorySearchInput,
  deps: HandleMemorySearchDeps,
): MemorySearchOutcome {
  const scope = resolveMemorySearchScope(input.invocationChannelId, deps.reviewChannelId);

  const outcome = authorizeAndAuditAdminAction(deps.db, {
    memberRoleIds: input.memberRoleIds,
    adminRoleIds: deps.adminRoleIds,
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'memory_search',
    target: input.invocationChannelId ?? null,
    details: { scope, query: input.query.slice(0, 200) },
    now: deps.nowMs,
  });
  if (!outcome.authorized) return { kind: 'not_authorized' };

  const grant = buildMemorySearchGrant(deps.db, scope);
  const limit = Math.min(MAX_MEMORY_LIMIT, Math.max(1, deps.limit ?? DEFAULT_LIST_LIMIT));
  const results = searchMemories(deps.db, grant, { query: input.query, limit, now: deps.nowMs });
  return { kind: 'done', results, scope };
}

/** Fetch one complete memory and its permitted evidence for Discord display. */
export function handleMemoryGetCommand(
  input: Omit<HandleMemorySearchInput, 'query'> & { memoryId: string },
  deps: HandleMemorySearchDeps,
): MemoryGetOutcome {
  const scope = resolveMemorySearchScope(input.invocationChannelId, deps.reviewChannelId);
  const outcome = authorizeAndAuditAdminAction(deps.db, {
    memberRoleIds: input.memberRoleIds,
    adminRoleIds: deps.adminRoleIds,
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    action: 'memory_get',
    target: input.memoryId,
    details: { scope },
    now: deps.nowMs,
  });
  if (!outcome.authorized) return { kind: 'not_authorized' };

  const grant = buildMemorySearchGrant(deps.db, scope);
  const memory = getMemoryDetails(deps.db, grant, input.memoryId);
  if (!memory) return { kind: 'not_visible' };
  const evidence = getMemoryEvidence(deps.db, grant, input.memoryId, 10);
  return { kind: 'done', memory, evidence, scope };
}

/** Format the search results as an ephemeral reply. No secrets; statement previews are bounded. */
export function formatMemorySearchReply(outcome: MemorySearchOutcome): string {
  if (outcome.kind === 'not_authorized') {
    return 'You are not authorized to search Mneme memory.';
  }
  if (outcome.results.length === 0) {
    return outcome.scope === 'secure_review'
      ? 'No memories matched (searched all scopes).'
      : 'No org memories matched. Restricted and review-only memory is only searchable from the secure review channel.';
  }
  const header =
    outcome.scope === 'secure_review'
      ? 'Memory matches (all scopes):'
      : 'Memory matches (org only — run in the secure review channel for restricted/review-only):';
  const lines = outcome.results.map((r) => {
    const preview = r.statement.length > 120 ? `${r.statement.slice(0, 119)}…` : r.statement;
    const sc = scopeLabel(r.scopeType, r.scopeKey);
    return `${r.memoryId}  [${r.type}${sc}]  (${preview})\n↳ /mneme memory-get id:${r.memoryId}`;
  });
  return [header, ...lines].join('\n');
}

/** Format a complete memory with canonical, visibility-checked source links. */
export function formatMemoryGetReply(outcome: MemoryGetOutcome): string {
  if (outcome.kind === 'not_authorized') return 'You are not authorized to read Mneme memory.';
  if (outcome.kind === 'not_visible') {
    return 'That memory does not exist or is not visible in this channel’s permitted scope.';
  }
  const m = outcome.memory;
  const lines = [
    `[${m.type}] ${m.statement}`,
    `id: ${m.memoryId}`,
    `status: ${m.status} · confidence: ${m.confidence.toFixed(2)} · importance: ${m.importance.toFixed(2)} · scope: ${scopeLabel(m.scopeType, m.scopeKey).replace(/^, /, '') || 'org'}`,
  ];
  if (outcome.evidence.length > 0) {
    lines.push('Sources:');
    for (const evidence of outcome.evidence) {
      lines.push(`- ${evidence.link} (${evidence.stance}, ${evidence.authorDisplayName})`);
    }
  } else {
    lines.push('No source messages are visible in this scope.');
  }
  return lines.join('\n');
}

/** Short, content-free scope tag for a result line. */
function scopeLabel(scopeType: string, scopeKey: string | null): string {
  if (scopeType === 'org') return '';
  if (scopeType === 'review_only') return ', review-only';
  if (scopeType === 'channel') return `, restricted:${scopeKey ?? '?'}`;
  return '';
}
