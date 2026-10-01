import type { DatabaseSync } from '../db/database.js';
import { getProposal } from '../db/repositories/proposals.js';
import { getMessage } from '../db/repositories/messages.js';
import { getChannel, resolveRetrievableChannelScope } from '../db/repositories/channels.js';
import { fingerprintExposedMemory } from '../agent/run-context.js';
import {
  buildSourceLinks,
  renderInlineCitations,
  SCHEDULED_NOTIFICATION_FOOTER,
  type MessageLink,
  type SourceLinkContext,
} from '../discord/message-safety.js';
import { isMnemeTestSurface } from '../discord/test-channels.js';
import { getMemory } from './repository.js';
import { getScheduledProposalSubjects } from './scheduled-notifications.js';
import { resolveScheduledMemoryRoute, type ScheduledRouteOptions } from './scheduled-routing.js';

/** Discord hard cap for one plain message; the assembled delivery must fit it. */
export const SCHEDULED_DELIVERY_MAX_CHARS = 2000;

export interface ScheduledDeliveryCheck {
  scheduled: boolean;
  allow: boolean;
  reasons: string[];
  memoryIds: string[];
  /** The exact assembled text to deliver, when rendering succeeded. */
  deliveryContent?: string;
}

export type ScheduledDeliveryRender =
  | { outcome: 'allow'; content: string }
  | { outcome: 'reject'; reasons: string[] };

/** Exact message ids that the originating scheduled run exposed to the model. */
export function scheduledRunMessageIds(db: DatabaseSync, runId: string): Set<string> {
  const run = db.prepare(
    'SELECT run_type, retrieval_provenance_json FROM agent_runs WHERE id = ?',
  ).get(runId) as { run_type: string; retrieval_provenance_json: string } | undefined;
  if (!run || run.run_type !== 'scheduled_review') return new Set();
  try {
    const parsed = JSON.parse(run.retrieval_provenance_json) as { messageIds?: unknown };
    if (!Array.isArray(parsed.messageIds)) return new Set();
    return new Set(parsed.messageIds.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

/** Trusted link construction context for scheduled citations (Section 30.3). */
export function scheduledSourceLinkContext(db: DatabaseSync, guildId: string): SourceLinkContext {
  return {
    resolveChannelId: (messageId) => {
      const message = getMessage(db, messageId);
      if (
        !message
        || message.guild_id !== guildId
        || message.deleted_at_ms !== null
        || isMnemeTestSurface(db, message.channel_id)
      ) return undefined;
      return resolveRetrievableChannelScope(db, message.channel_id)
        ? message.channel_id
        : undefined;
    },
    resolveLabel: (messageId) => {
      const message = getMessage(db, messageId);
      if (!message) return undefined;
      const channel = getChannel(db, message.channel_id);
      const channelLabel = channel?.name ? `#${channel.name}` : 'Discord';
      return `${channelLabel} · ${new Date(message.created_at_ms).toISOString().slice(0, 10)}`;
    },
  };
}

/**
 * Assemble the deliverable scheduled notification from durable marker text and
 * host-built links (Section 24.5). Inline `[[cite:<id>]]` markers become masked
 * links, validated links no marker consumed become one trailing `Sources:` line,
 * and the host identity footer closes the message. Pure; rejects on an invalid
 * marker or when the assembled text cannot fit one Discord message.
 */
export function assembleScheduledDelivery(
  content: string,
  links: readonly MessageLink[],
): ScheduledDeliveryRender {
  const inline = renderInlineCitations(content, links);
  if (inline.outcome === 'reject') return { outcome: 'reject', reasons: inline.reasons };
  const parts = [inline.content];
  if (inline.unusedLinks.length > 0) {
    parts.push(`Sources: ${inline.unusedLinks.map((link) => link.masked).join(' · ')}`);
  }
  parts.push(SCHEDULED_NOTIFICATION_FOOTER);
  const assembled = parts.join('\n\n');
  if (assembled.length > SCHEDULED_DELIVERY_MAX_CHARS) {
    return {
      outcome: 'reject',
      reasons: ['notification leaves insufficient room for validated source links and the footer'],
    };
  }
  return { outcome: 'allow', content: assembled };
}

/**
 * Render the deliverable text for a stored scheduled proposal from durable
 * state: run-exposed citations intersected with stored evidence become
 * host-built links substituted into the durable marker text. Used by the
 * approval card and by approval delivery so the reviewer sees the exact text
 * that ships.
 */
export function renderScheduledNotificationDelivery(
  db: DatabaseSync,
  guildId: string,
  proposal: { runId: string; message: string | null; evidenceMessageIds: readonly string[] },
): ScheduledDeliveryRender {
  if (typeof proposal.message !== 'string' || proposal.message.trim().length === 0) {
    return { outcome: 'reject', reasons: ['proposal has no sendable message text'] };
  }
  const exposedIds = scheduledRunMessageIds(db, proposal.runId);
  const evidenceIds = [...new Set(proposal.evidenceMessageIds)]
    .filter((messageId) => exposedIds.has(messageId));
  const links = buildSourceLinks(guildId, evidenceIds, scheduledSourceLinkContext(db, guildId));
  return assembleScheduledDelivery(proposal.message, links);
}

/** Current fingerprint, due-state, and exact-route authority for an unsent proposal. */
export function validateScheduledProposalDelivery(
  db: DatabaseSync,
  proposalId: string,
  options: ScheduledRouteOptions,
  _now: number,
): ScheduledDeliveryCheck {
  const proposal = getProposal(db, proposalId);
  if (!proposal) return { scheduled: false, allow: false, reasons: ['proposal not found'], memoryIds: [] };
  const run = db.prepare('SELECT run_type FROM agent_runs WHERE id = ?').get(proposal.runId) as
    | { run_type: string }
    | undefined;
  if (run?.run_type !== 'scheduled_review') {
    return { scheduled: false, allow: true, reasons: [], memoryIds: [] };
  }
  const subjects = getScheduledProposalSubjects(db, proposalId);
  const reasons: string[] = [];
  if (subjects.length === 0) reasons.push('scheduled proposal has no durable subjects');
  if (proposal.targetChannelId === options.reviewChannelId) {
    reasons.push('legacy scheduled proposal targets the approval inbox');
  }
  for (const subject of subjects) {
    const memory = getMemory(db, subject.memoryId);
    // Admission no longer depends on `review_after_ms` (Section 12.7): the
    // attention claim owns the window; the subject must merely stay active.
    if (!memory || memory.status !== 'active') {
      reasons.push('scheduled subject is no longer due');
      continue;
    }
    if (fingerprintExposedMemory(db, subject.memoryId) !== subject.memoryFingerprint) {
      reasons.push('scheduled subject changed after proposal creation');
      continue;
    }
    const route = resolveScheduledMemoryRoute(db, subject.memoryId, options);
    if (route.kind !== 'working' || route.targetChannelId !== proposal.targetChannelId) {
      reasons.push('scheduled subject no longer resolves to the proposal target');
    }
  }
  return {
    scheduled: true,
    allow: reasons.length === 0,
    reasons: [...new Set(reasons)],
    memoryIds: subjects.map((subject) => subject.memoryId),
  };
}
