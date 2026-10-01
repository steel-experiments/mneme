import { type DatabaseSync, transaction } from '../db/database.js';
import { setProposalStatus } from '../db/repositories/proposals.js';
import {
  claimOutboxForSending,
  markOutboxSent,
  markOutboxRetry,
  markOutboxFailed,
  markOutboxCancelled,
} from './repository.js';
import { classifyError, PermanentJobError, TransientJobError } from '../jobs/errors.js';
import { computeRetryDelay } from '../jobs/queue.js';
import type { OutboxSender } from '../discord/sender.js';
import type { Logger } from '../logger.js';
import type { JobHandler } from '../jobs/worker.js';
import type { JobRow } from '../jobs/types.js';
import {
  enqueueProposalDeliverySync,
  reportProposalDeliverySafely,
  type ProposalDeliveryReporter,
} from './proposal-delivery.js';

export type { ProposalDeliveryReport, ProposalDeliveryReporter } from './proposal-delivery.js';

/**
 * `send_outbox` job handler (Sections 9.1, 10.1, 24.5).
 *
 * Delivers one outbox row to Discord. The claim (queued → sending) commits in a
 * short transaction BEFORE any network call; the Discord send runs outside the
 * transaction (Section 9.1); then a second short transaction records the outcome.
 * A crash between claim and outcome leaves the row `sending`, which startup
 * recovery reconciles — it never produces a duplicate post.
 *
 * Outcomes:
 *   - success                  → row `sent` (+ `platform_message_id`), proposal `sent`.
 *   - transient failure        → row back to `queued` with backoff + audit error,
 *                                handler throws `TransientJobError` so the job
 *                                queue re-drives it with capped backoff.
 *   - permanent failure OR
 *     attempts exhausted       → row `failed` (terminal, audit error retained),
 *                                proposal `failed`, handler throws
 *                                `PermanentJobError` so the job goes terminal too.
 *
 * The attempt count is owned by the claim (`attempts + 1`) and aligns with the
 * job's own count, so the outbox goes terminal on the same try the job gives up.
 */

export interface SendOutboxHandlerDeps {
  db: DatabaseSync;
  sender: OutboxSender;
  /** Backoff (ms) for the outbox `next_attempt_at_ms` audit field. Defaults to
   * the job queue's capped exponential backoff. */
  retryDelayMs?: (attempts: number) => number;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  /**
   * Optional presentation port for proposal-backed sends. It runs only after the
   * outbox row and proposal have reached the matching durable terminal state.
   * Reporter failures never change delivery or retry semantics.
   */
  reportProposalDelivery?: ProposalDeliveryReporter;
  /** Final current-state authority check after claim and before Discord I/O. */
  validateProposalSend?: (proposalId: string, now: number) => { allow: boolean; reasons: string[] };
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/** Build a `send_outbox` job handler. */
export function createSendOutboxHandler(
  deps: SendOutboxHandlerDeps,
): JobHandler<'send_outbox'> {
  const retryDelayMs = deps.retryDelayMs ?? ((attempts: number) => computeRetryDelay(attempts));

  const handler = async (payload: { outboxId: string }, job: JobRow): Promise<void> => {
    const now = deps.now?.() ?? Date.now();
    const db = deps.db;

    // Claim outside the handler's own control flow: a duplicate or stale send
    // job (row already sending/sent/failed, or missing) is a no-op.
    const row = claimOutboxForSending(db, payload.outboxId, now);
    if (!row) {
      deps.logger?.info({ outboxId: payload.outboxId }, 'send_outbox: not queued, no-op');
      return;
    }

    if (row.proposalId && deps.validateProposalSend) {
      const guard = deps.validateProposalSend(row.proposalId, now);
      if (!guard.allow) {
        const reason = guard.reasons[0] ?? 'proposal delivery authority changed';
        transaction(db, () => {
          markOutboxCancelled(db, row.id, reason, now);
          setProposalStatus(db, row.proposalId!, 'expired', now);
          enqueueProposalDeliverySync(db, row.proposalId!, now);
        });
        await reportProposalDeliverySafely(deps.reportProposalDelivery, deps.logger, {
          status: 'cancelled',
          proposalId: row.proposalId,
          outboxId: row.id,
        });
        deps.logger?.warn(
          { outboxId: row.id, proposalId: row.proposalId, reason },
          'send_outbox: cancelled before Discord I/O',
        );
        return;
      }
    }

    let platformMessageId: string;
    try {
      const result = await deps.sender.send({
        channelId: row.channelId,
        content: row.content,
        replyToMessageId: row.replyToMessageId,
        dedupeMarker: row.dedupeMarker,
      });
      platformMessageId = result.platformMessageId;
    } catch (err) {
      const classification = classifyError(err);
      const exhausted = row.attempts >= job.max_attempts;
      const terminal = classification.permanent || exhausted;

      if (terminal) {
        transaction(db, () => {
          markOutboxFailed(db, row.id, classification.message, now);
          if (row.proposalId) {
            setProposalStatus(db, row.proposalId, 'failed', now);
            enqueueProposalDeliverySync(db, row.proposalId, now);
          }
        });
        if (row.proposalId) {
          await reportProposalDeliverySafely(deps.reportProposalDelivery, deps.logger, {
            status: 'failed',
            proposalId: row.proposalId,
            outboxId: row.id,
          });
        }
        deps.logger?.warn(
          {
            outboxId: row.id,
            proposalId: row.proposalId,
            attempt: row.attempts,
            permanent: classification.permanent,
            exhausted,
            err: classification.message,
          },
          'send_outbox: terminal failure',
        );
        // Throwing PermanentJobError makes failJob mark the job terminal too;
        // a transient error that exhausted retries is terminal by policy.
        throw new PermanentJobError(`outbox send failed terminally: ${classification.message}`, {
          cause: err,
        });
      }

      markOutboxRetry(db, row.id, classification.message, now + retryDelayMs(row.attempts), now);
      deps.logger?.warn(
        { outboxId: row.id, attempt: row.attempts, err: classification.message },
        'send_outbox: transient failure, will retry',
      );
      throw new TransientJobError(classification.message, { cause: err });
    }

    // Success: record the Discord id, mark sent, and mirror the outcome onto the
    // originating proposal.
    transaction(db, () => {
      markOutboxSent(db, row.id, platformMessageId, now);
      if (row.proposalId) {
        setProposalStatus(db, row.proposalId, 'sent', now);
        enqueueProposalDeliverySync(db, row.proposalId, now);
      }
    });
    if (row.proposalId) {
      await reportProposalDeliverySafely(deps.reportProposalDelivery, deps.logger, {
        status: 'sent',
        proposalId: row.proposalId,
        outboxId: row.id,
        platformMessageId,
      });
    }
    deps.logger?.info(
      { outboxId: row.id, platformMessageId, proposalId: row.proposalId },
      'send_outbox: sent',
    );
  };

  return handler;
}
