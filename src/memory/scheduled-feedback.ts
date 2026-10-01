import type { DatabaseSync } from '../db/database.js';
import { getChannel, resolveRetrievableChannelScope } from '../db/repositories/channels.js';
import type { RetrievalGrant } from '../db/repositories/message-search.js';
import { isMnemeTestSurface } from '../ingestion/test-channels.js';
import { evaluateProvenanceGate, resolveProvenanceScopes } from '../agent/policy.js';
import type { RetrievalProvenance } from '../agent/run-context.js';
import { getMemory } from './repository.js';
import { recomputeMemoryScopes, scopePermitted } from './search.js';
import { getScheduledProposalSubjects } from './scheduled-notifications.js';

export interface ScheduledFeedbackSubject {
  memoryId: string;
  statement: string;
  type: string;
  status: string;
  reviewAfterMs: number | null;
  scopeType: string;
  scopeKey: string | null;
}

export interface ScheduledFeedbackAssociation {
  replyMessageId: string;
  proposalId: string;
  outboxId: string;
  notificationMessageId: string;
  notificationText: string;
  subjects: ScheduledFeedbackSubject[];
  provenanceScopes: RetrievalProvenance['memoryScopes'];
  provenanceChannels: RetrievalProvenance['channels'];
  provenanceMemories: Array<{ memoryId: string; scopeType: string; scopeKey: string | null }>;
}

function targetGrant(db: DatabaseSync, channelId: string): RetrievalGrant | undefined {
  const scope = resolveRetrievableChannelScope(db, channelId);
  if (!scope) return undefined;
  if (scope.visibility === 'org') {
    return { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };
  }
  if (scope.visibility === 'restricted') {
    return { includeOrgMessages: false, includeOrgMemories: true, includeReviewOnly: false, channelIds: [scope.scopeChannelId] };
  }
  return undefined;
}

/** Resolve bounded exact replies to sent scheduled proposal-backed outbox messages. */
export function resolveScheduledFeedback(
  db: DatabaseSync,
  input: {
    guildId: string;
    channelId: string;
    messageIds: readonly string[];
    mnemeId: string;
    maxAssociations?: number;
    maxSubjects?: number;
  },
): ScheduledFeedbackAssociation[] {
  if (isMnemeTestSurface(db, input.channelId)) return [];
  const currentTarget = resolveRetrievableChannelScope(db, input.channelId);
  const grant = targetGrant(db, input.channelId);
  const targetChannel = getChannel(db, input.channelId);
  if (!currentTarget || !grant || !targetChannel || targetChannel.workspace_id !== input.guildId) return [];

  const maxAssociations = Math.min(input.maxAssociations ?? 10, 10);
  const maxSubjects = Math.min(input.maxSubjects ?? 20, 20);
  const uniqueSubjects = new Set<string>();
  const associations: ScheduledFeedbackAssociation[] = [];
  for (const messageId of [...new Set(input.messageIds)].sort()) {
    if (associations.length >= maxAssociations) break;
    const reply = db.prepare(
      `SELECT m.id,m.channel_id,m.reply_to_message_id,m.author_id,u.is_bot
         FROM messages m LEFT JOIN users u ON u.id=m.author_id
        WHERE m.id=? AND m.workspace_id=? AND m.deleted_at_ms IS NULL`,
    ).get(messageId, input.guildId) as {
      id: string; channel_id: string; reply_to_message_id: string | null;
      author_id: string | null; is_bot: number | null;
    } | undefined;
    if (!reply?.reply_to_message_id || reply.channel_id !== input.channelId
      || reply.author_id === input.mnemeId || reply.is_bot !== 0) continue;

    const matches = db.prepare(
      `SELECT o.id AS outbox_id,o.channel_id,o.content,o.status,o.platform_message_id,
              p.id AS proposal_id,p.target_channel_id,p.message,p.status AS proposal_status,
              ar.retrieval_provenance_json
         FROM outbox o
         JOIN proposals p ON p.id=o.proposal_id
         JOIN agent_runs ar ON ar.id=p.run_id AND ar.run_type='scheduled_review'
        WHERE o.platform_message_id=?`,
    ).all(reply.reply_to_message_id) as Array<{
      outbox_id: string; channel_id: string; content: string; status: string;
      platform_message_id: string; proposal_id: string; target_channel_id: string;
      message: string | null; proposal_status: string; retrieval_provenance_json: string;
    }>;
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    if (match.channel_id !== input.channelId || match.target_channel_id !== input.channelId
      || match.status !== 'sent' || match.proposal_status !== 'sent'
      || match.message === null || match.content !== match.message) continue;

    let provenance: RetrievalProvenance;
    try {
      provenance = JSON.parse(match.retrieval_provenance_json) as RetrievalProvenance;
      if (!Array.isArray(provenance.channels) || !Array.isArray(provenance.memoryScopes)
        || !Array.isArray(provenance.memoryIds)) continue;
    } catch { continue; }
    const entries = resolveProvenanceScopes(provenance, {
      channelVisibility: (id) => resolveRetrievableChannelScope(db, id)?.visibility,
      channelScopeId: (id) => resolveRetrievableChannelScope(db, id)?.scopeChannelId,
    });
    const gate = evaluateProvenanceGate({
      pinnedTargetChannelId: input.channelId,
      proposedTargetChannelId: input.channelId,
      target: {
        channelId: input.channelId,
        scopeChannelId: currentTarget.scopeChannelId,
        visibility: currentTarget.visibility,
        isSecureReview: false,
      },
      provenance: entries,
    });
    if (gate.outcome !== 'allow') continue;

    const provenanceMemoryIds = Array.isArray(provenance.memoryIds)
      ? [...new Set(provenance.memoryIds.filter((id): id is string => typeof id === 'string'))]
      : [];
    const currentProvenanceScopes = recomputeMemoryScopes(db, provenanceMemoryIds);
    const provenanceMemories: Array<{ memoryId: string; scopeType: string; scopeKey: string | null }> = [];
    let staleProvenanceMemory = false;
    for (const memoryId of provenanceMemoryIds) {
      const scope = currentProvenanceScopes.get(memoryId);
      if (!scope || !scopePermitted(db, grant, scope)) { staleProvenanceMemory = true; break; }
      provenanceMemories.push({ memoryId, scopeType: scope.scopeType, scopeKey: scope.scopeKey });
    }
    if (staleProvenanceMemory) continue;

    const snapshots = getScheduledProposalSubjects(db, match.proposal_id);
    if (snapshots.length === 0) continue;
    if (snapshots.some((snapshot) => !provenanceMemoryIds.includes(snapshot.memoryId))) continue;
    const scopes = recomputeMemoryScopes(db, snapshots.map((subject) => subject.memoryId));
    const subjects: ScheduledFeedbackSubject[] = [];
    let invalid = false;
    for (const snapshot of snapshots) {
      const memory = getMemory(db, snapshot.memoryId);
      const scope = scopes.get(snapshot.memoryId);
      if (!memory || !scope || !scopePermitted(db, grant, scope)) { invalid = true; break; }
      subjects.push({
        memoryId: memory.id,
        statement: memory.statement,
        type: memory.type,
        status: memory.status,
        reviewAfterMs: memory.review_after_ms,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
      });
    }
    if (invalid || subjects.some((subject) =>
      !uniqueSubjects.has(subject.memoryId) && uniqueSubjects.size >= maxSubjects)) continue;
    subjects.forEach((subject) => uniqueSubjects.add(subject.memoryId));
    associations.push({
      replyMessageId: reply.id,
      proposalId: match.proposal_id,
      outboxId: match.outbox_id,
      notificationMessageId: match.platform_message_id,
      notificationText: match.message,
      subjects,
      provenanceScopes: provenance.memoryScopes,
      provenanceChannels: provenance.channels,
      provenanceMemories,
    });
  }
  return associations;
}
