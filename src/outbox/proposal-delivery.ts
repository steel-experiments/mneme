import type { Logger } from '../logger.js';
import type { DatabaseSync } from '../db/database.js';
import { enqueue } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/worker.js';
import { PermanentJobError } from '../jobs/errors.js';
import { getProposal } from '../db/repositories/proposals.js';

/** Durable proposal-delivery outcome exposed to presentation adapters. */
export type ProposalDeliveryReport =
  | {
      status: 'sent';
      proposalId: string;
      outboxId: string;
      platformMessageId: string;
    }
  | {
      status: 'failed';
      proposalId: string;
      outboxId: string;
    }
  | {
      status: 'cancelled';
      proposalId: string;
      outboxId: string | null;
    };

/** Best-effort port used to reflect durable delivery state in external review UI. */
export type ProposalDeliveryReporter = (
  report: ProposalDeliveryReport,
) => Promise<void> | void;

/** Queue a retryable review-card convergence job in the caller's transaction. */
export function enqueueProposalDeliverySync(
  db: DatabaseSync,
  proposalId: string,
  now: number,
): boolean {
  return enqueue(db, {
    type: 'sync_proposal_review',
    payload: { proposalId },
    uniqueKey: `proposal-review-status:${proposalId}`,
    priority: 20,
    now,
  }).enqueued;
}

/** Build the retryable job that converges a review card to durable outbox state. */
export function createProposalDeliverySyncHandler(deps: {
  db: DatabaseSync;
  reporter: ProposalDeliveryReporter;
}): JobHandler<'sync_proposal_review'> {
  return async ({ proposalId }) => {
    const proposal = getProposal(deps.db, proposalId);
    if (!proposal?.reviewMessageId) return;
    const outbox = deps.db.prepare(
      `SELECT id, status, platform_message_id
         FROM outbox
        WHERE proposal_id = ? AND status IN ('sent', 'failed', 'cancelled')
        ORDER BY updated_at_ms DESC, id DESC
        LIMIT 1`,
    ).get(proposalId) as {
      id: string;
      status: 'sent' | 'failed' | 'cancelled';
      platform_message_id: string | null;
    } | undefined;
    if (!outbox && proposal.status === 'expired') {
      await deps.reporter({ status: 'cancelled', proposalId, outboxId: null });
      return;
    }
    if (!outbox) {
      throw new PermanentJobError('terminal proposal has no terminal outbox row');
    }
    if (outbox.status === 'cancelled') {
      await deps.reporter({ status: 'cancelled', proposalId, outboxId: outbox.id });
      return;
    }
    if (outbox.status === 'sent') {
      if (!outbox.platform_message_id) {
        throw new PermanentJobError('sent proposal outbox has no Discord message id');
      }
      await deps.reporter({
        status: 'sent',
        proposalId,
        outboxId: outbox.id,
        platformMessageId: outbox.platform_message_id,
      });
      return;
    }
    await deps.reporter({ status: 'failed', proposalId, outboxId: outbox.id });
  };
}

/**
 * Reflect a durable proposal-delivery outcome without changing delivery or
 * recovery semantics when the presentation adapter is unavailable.
 */
export async function reportProposalDeliverySafely(
  reporter: ProposalDeliveryReporter | undefined,
  logger: Pick<Logger, 'warn'> | undefined,
  report: ProposalDeliveryReport,
): Promise<void> {
  if (!reporter) return;
  try {
    await reporter(report);
  } catch (err) {
    logger?.warn(
      {
        event: 'proposal.delivery_report_failed',
        proposalId: report.proposalId,
        outboxId: report.outboxId,
        status: report.status,
        err: err instanceof Error ? err.message : String(err),
      },
      'proposal delivery state could not be reflected in presentation',
    );
  }
}
