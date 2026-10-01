import type { Client } from 'discord.js';
import { type DatabaseSync, transaction } from '../db/database.js';
import { listOutboxSending, markOutboxSent, markOutboxRetry, markOutboxCancelled } from './repository.js';
import { setProposalStatus } from '../db/repositories/proposals.js';
import { DEFAULT_RECENT_WINDOW_MS } from '../agent/duplicate-policy.js';
import type { Logger } from '../logger.js';
import {
  enqueueProposalDeliverySync,
  reportProposalDeliverySafely,
  type ProposalDeliveryReporter,
} from './proposal-delivery.js';

/**
 * Outbox sending-state crash recovery (Sections 10.1, 46.2, 46.5).
 *
 * Discord message creation has no idempotency key, so a crash between the Discord
 * send and the database `sent` update leaves an outbox row in `sending` with the
 * message possibly already posted. At startup, each such row is reconciled: fetch
 * Mneme's own recent messages in the pinned target channel and match against
 * the row's content. A match records the existing Discord id and marks the row
 * `sent` (no duplicate post). Only a *completed* lookup that finds no match may
 * return the row to `queued` for another attempt — a lookup that errors leaves
 * the row `sending`, because requeuing without proof of absence risks a double
 * post. Network lookups run outside any transaction (Section 9.1).
 */

/** A Mneme message recently present in a target channel (for matching). */
export interface RecentSentMessage {
  platformMessageId: string;
  content: string;
  /** When Discord says the message was created (epoch ms), if known. */
  sentAtMs?: number;
  dedupeMarker?: string | null;
}

/** Port for fetching Mneme's recent own messages in a channel. */
export interface RecentSentMessageLookup {
  fetch(channelId: string, sinceMs: number): Promise<readonly RecentSentMessage[]>;
}

export interface ReconcileOptions {
  now: number;
  /** How far back to look for a matching message (default 24h). */
  windowMs?: number;
  /** Backoff applied to rows requeued after a clean no-match lookup (default 60s). */
  requeueDelayMs?: number;
  /** Reflect confirmed durable delivery on a proposal's secure review card. */
  reportProposalDelivery?: ProposalDeliveryReporter;
  /** Current proposal authority check before an unsent row is requeued. */
  validateProposalSend?: (proposalId: string, now: number) => { allow: boolean; reasons: string[] };
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface RecoveryReport {
  /** Rows in `sending` examined. */
  examined: number;
  /** Rows confirmed already sent (matched a recent message). */
  confirmed: number;
  /** Rows returned to `queued` after a completed lookup found no match. */
  requeued: number;
  /** Unsent proposal rows cancelled after current authority failed. */
  cancelled: number;
  /** Rows whose lookup errored and were left `sending` for a later pass. */
  errored: number;
}

/** Find a recent Mneme message whose normalized content equals the row's. */
function findSentMatch(
  dedupeMarker: string,
  messages: readonly RecentSentMessage[],
): RecentSentMessage | undefined {
  for (const m of messages) {
    if (m.dedupeMarker === dedupeMarker) return m;
  }
  return undefined;
}

/**
 * Reconcile every outbox row left in `sending`. For each row, fetch the bot's
 * recent messages in its target channel and match by content. Returns a report;
 * never throws for a single row's lookup failure (the row is left `sending`).
 */
export async function reconcileOutboxSending(
  db: DatabaseSync,
  lookup: RecentSentMessageLookup,
  opts: ReconcileOptions,
): Promise<RecoveryReport> {
  const windowMs = opts.windowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const requeueDelayMs = opts.requeueDelayMs ?? 60_000;
  const sinceMs = opts.now - windowMs;

  const rows = listOutboxSending(db);
  let confirmed = 0;
  let requeued = 0;
  let cancelled = 0;
  let errored = 0;

  for (const row of rows) {
    let messages: readonly RecentSentMessage[];
    try {
      messages = await lookup.fetch(row.channelId, sinceMs);
    } catch (err) {
      // A failed lookup must not requeue — the message may actually have been
      // sent. Leave it `sending` for the next recovery pass.
      errored += 1;
      opts.logger?.warn(
        { outboxId: row.id, channelId: row.channelId, err: err instanceof Error ? err.message : String(err) },
        'outbox recovery: lookup failed; row left sending',
      );
      continue;
    }

    if (!row.dedupeMarker) {
      errored += 1;
      opts.logger?.warn({ outboxId: row.id }, 'outbox recovery: legacy row has no marker; operator review required');
      continue;
    }
    const match = findSentMatch(row.dedupeMarker, messages);
    if (match) {
      transaction(db, () => {
        markOutboxSent(
          db,
          row.id,
          match.platformMessageId,
          opts.now,
          match.sentAtMs ?? opts.now,
        );
        if (row.proposalId) {
          setProposalStatus(db, row.proposalId, 'sent', opts.now);
          enqueueProposalDeliverySync(db, row.proposalId, opts.now);
        }
      });
      confirmed += 1;
      if (row.proposalId) {
        await reportProposalDeliverySafely(opts.reportProposalDelivery, opts.logger, {
          status: 'sent',
          proposalId: row.proposalId,
          outboxId: row.id,
          platformMessageId: match.platformMessageId,
        });
      }
      opts.logger?.info(
        { outboxId: row.id, platformMessageId: match.platformMessageId },
        'outbox recovery: confirmed already sent',
      );
    } else {
      if (row.proposalId && opts.validateProposalSend) {
        const guard = opts.validateProposalSend(row.proposalId, opts.now);
        if (!guard.allow) {
          transaction(db, () => {
            markOutboxCancelled(db, row.id, guard.reasons[0] ?? 'proposal delivery authority changed', opts.now);
            setProposalStatus(db, row.proposalId!, 'expired', opts.now);
            enqueueProposalDeliverySync(db, row.proposalId!, opts.now);
          });
          await reportProposalDeliverySafely(opts.reportProposalDelivery, opts.logger, {
            status: 'cancelled', proposalId: row.proposalId, outboxId: row.id,
          });
          cancelled += 1;
          continue;
        }
      }
      // Completed lookup with no match → safe to retry. The row returns to
      // `queued` with the audit reason; the sender re-claims and re-sends.
      markOutboxRetry(
        db,
        row.id,
        'crash recovery: no matching message found in target',
        opts.now + requeueDelayMs,
        opts.now,
      );
      requeued += 1;
      opts.logger?.info(
        { outboxId: row.id, channelId: row.channelId },
        'outbox recovery: no match found, requeued',
      );
    }
  }

  return { examined: rows.length, confirmed, requeued, cancelled, errored };
}

/**
 * discord.js-backed recent-message lookup: fetches up to 50 recent messages in
 * the channel and keeps only Mneme's own, within the window. Returns an empty
 * list (not a throw) for a missing or non-text channel — absence is a legitimate
 * "no match" outcome, not a lookup failure.
 */
export function createDiscordRecentSentLookup(
  client: Client,
  mnemeId: string,
): RecentSentMessageLookup {
  return {
    async fetch(channelId, sinceMs) {
      const channel = await client.channels.fetch(channelId, { cache: false });
      if (!channel || !channel.isTextBased()) return [];
      const out: RecentSentMessage[] = [];
      let before: string | undefined;
      let complete = false;
      for (let page = 0; page < 100; page++) {
        const fetched = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (fetched.size === 0) {
          complete = true;
          break;
        }
        let reachedBoundary = false;
        for (const m of fetched.values()) {
          if (typeof m.createdTimestamp === 'number' && m.createdTimestamp < sinceMs) {
            reachedBoundary = true;
            continue;
          }
          if (m.author?.id !== mnemeId) continue;
          out.push({ platformMessageId: m.id, content: m.content, sentAtMs: m.createdTimestamp,
            dedupeMarker: m.nonce == null ? null : String(m.nonce) });
        }
        if (reachedBoundary || fetched.size < 100) {
          complete = true;
          break;
        }
        before = fetched.last()?.id;
        if (!before) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new Error('recent-message lookup exceeded its page limit');
      return out;
    },
  };
}
