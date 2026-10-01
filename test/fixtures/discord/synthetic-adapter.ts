import type { BackfillMessageFetcher } from '../../../src/ingestion/backfill.js';
import type { ThreadArchiveSource, ArchivedThreadPage } from '../../../src/ingestion/threads.js';
import type { OutboxSender, SendOutboxMessageInput, SendResult } from '../../../src/platform/discord/sender.js';
import type {
  RecentSentMessageLookup,
  RecentSentMessage,
} from '../../../src/outbox/recovery.js';
import type { GatewayEventType } from '../../../src/platform/discord/gateway-events.js';

/**
 * Recorded synthetic Discord adapter (Section 46.2, task T119).
 *
 * One controllable stand-in for the Discord surface, consolidating the inline
 * fakes that were previously re-implemented in each integration test. It exposes
 * the same dependency-injection seams the production code is built around:
 *
 *   - {@link backfillFetcher}     — paginated historical message fetch (newest-first)
 *   - {@link archiveSource}       — archived-thread pagination (public + private)
 *   - {@link sender}              — outbox delivery with scripted errors
 *   - {@link recentSentLookup}    — the "did it actually send?" lookup for crash recovery
 *   - {@link events} / replay     — recorded Gateway events fed to the dispatcher
 *   - {@link clock}               — a deterministic, advanceable clock
 *
 * Nothing here touches the network. Errors are scripted per call index so a test
 * can say "fail the first send with a 429, then succeed" deterministically.
 */

/** A Discord-shaped error to script on a seam. `status`/`code` are duck-typed by classifyError. */
export interface ScriptedError {
  status?: number;
  code?: number;
  message: string;
}

/**
 * An Error that carries an optional numeric `status` and `code`, mirroring how
 * discord.js surfaces REST errors. The jobs error classifier reads these via
 * duck-typing, so no discord.js import is needed here.
 */
export class SyntheticDiscordError extends Error {
  readonly status?: number;
  readonly code?: number;
  constructor(s: ScriptedError) {
    super(s.message);
    this.name = 'SyntheticDiscordError';
    this.status = s.status;
    this.code = s.code;
  }
}

export interface ControllableClock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

export interface RecordedEvent {
  type: GatewayEventType;
  payload: unknown;
}

export interface SyntheticDiscord {
  readonly clock: ControllableClock;

  // ---- backfill pagination -------------------------------------------------
  /** Seed raw (snake_case) message payloads for a channel; later seeds append. */
  seedChannelMessages(channelId: string, raws: readonly unknown[]): void;
  /** Script a fetch error on a given 0-indexed fetch call for a channel. */
  scriptFetchError(channelId: string, error: ScriptedError, onCall?: number): void;
  readonly backfillFetcher: BackfillMessageFetcher;
  /** Every fetch call, in order: { channelId, before, limit, page }. */
  readonly fetchCalls: ReadonlyArray<{ channelId: string; before: string | undefined; limit: number }>;

  // ---- archived-thread pagination -----------------------------------------
  seedArchivedThreads(
    parentId: string,
    threads: readonly unknown[],
    opts?: { hasMore?: boolean; privateThreads?: readonly unknown[]; privateHasMore?: boolean },
  ): void;
  readonly archiveSource: ThreadArchiveSource;

  // ---- outbox sender -------------------------------------------------------
  /** Script a send error on a given 0-indexed send call (succeeds otherwise). */
  scriptSendError(error: ScriptedError, onCall?: number): void;
  readonly sender: OutboxSender;
  /** Every successful send, in order. */
  readonly sentMessages: ReadonlyArray<SendOutboxMessageInput>;

  // ---- crash-recovery lookup ----------------------------------------------
  seedRecentSent(channelId: string, messages: readonly RecentSentMessage[]): void;
  readonly recentSentLookup: RecentSentMessageLookup;

  // ---- recorded gateway events --------------------------------------------
  recordEvent(type: GatewayEventType, payload: unknown): void;
  readonly events: ReadonlyArray<RecordedEvent>;
}

export interface SyntheticDiscordOptions {
  /** Starting clock value (default 1_700_000_001_000). */
  now?: number;
}

/** Build a controllable synthetic Discord surface. */
export function createSyntheticDiscord(opts: SyntheticDiscordOptions = {}): SyntheticDiscord {
  const clockMs = { value: opts.now ?? 1_700_000_001_000 };
  const clock: ControllableClock = {
    now: () => clockMs.value,
    set: (ms) => {
      clockMs.value = ms;
    },
    advance: (ms) => {
      clockMs.value += ms;
    },
  };

  // ---- backfill state ----
  const channelMessages = new Map<string, unknown[]>();
  const fetchErrors = new Map<string, Map<number, ScriptedError>>();
  const fetchCalls: { channelId: string; before: string | undefined; limit: number }[] = [];
  const fetchCallCount = new Map<string, number>();

  const backfillFetcher: BackfillMessageFetcher = {
    async fetchMessages(channelId, before, limit): Promise<unknown[]> {
      const callIdx = fetchCallCount.get(channelId) ?? 0;
      fetchCallCount.set(channelId, callIdx + 1);
      fetchCalls.push({ channelId, before, limit });

      const scripted = fetchErrors.get(channelId)?.get(callIdx);
      if (scripted) throw new SyntheticDiscordError(scripted);

      const all = (channelMessages.get(channelId) ?? []).slice();
      // Sort newest-first by id (snowflides sort lexicographically).
      all.sort((a, b) => {
        const ai = (a as { id?: string })?.id ?? '';
        const bi = (b as { id?: string })?.id ?? '';
        if (ai.length !== bi.length) return bi.length - ai.length;
        return bi < ai ? -1 : bi > ai ? 1 : 0;
      });
      const startIdx = before ? all.findIndex((m) => ((m as { id?: string }).id ?? '') < before) : 0;
      if (startIdx === -1) return [];
      return all.slice(startIdx, startIdx + limit);
    },
  };

  // ---- archive state ----
  const archived = new Map<
    string,
    { publicThreads: unknown[]; publicHasMore: boolean; privateThreads: unknown[]; privateHasMore: boolean }
  >();
  const archiveSource: ThreadArchiveSource = {
    fetchPublicArchived(parentId): ArchivedThreadPage {
      const entry = archived.get(parentId) ?? { publicThreads: [], publicHasMore: false, privateThreads: [], privateHasMore: false };
      return { threads: entry.publicThreads as ArchivedThreadPage['threads'], hasMore: entry.publicHasMore };
    },
    fetchPrivateArchived(parentId): ArchivedThreadPage {
      const entry = archived.get(parentId) ?? { publicThreads: [], publicHasMore: false, privateThreads: [], privateHasMore: false };
      return { threads: entry.privateThreads as ArchivedThreadPage['threads'], hasMore: entry.privateHasMore };
    },
  };

  // ---- sender state ----
  const sendErrors = new Map<number, ScriptedError>();
  const sentMessages: SendOutboxMessageInput[] = [];
  let sendAttempts = 0; // counts every attempt, including ones that error
  let discordIdCounter = 1_000;
  const sender: OutboxSender = {
    async send(input): Promise<SendResult> {
      const callIdx = sendAttempts;
      sendAttempts += 1;
      const scripted = sendErrors.get(callIdx);
      if (scripted) throw new SyntheticDiscordError(scripted);
      sentMessages.push(input);
      discordIdCounter += 1;
      return { platformMessageId: String(discordIdCounter) };
    },
  };

  // ---- recent-sent lookup state ----
  const recentSent = new Map<string, RecentSentMessage[]>();
  const recentSentLookup: RecentSentMessageLookup = {
    async fetch(channelId, sinceMs): Promise<RecentSentMessage[]> {
      const all = recentSent.get(channelId) ?? [];
      return all.filter((m) => (m.sentAtMs ?? 0) >= sinceMs);
    },
  };

  // ---- events ----
  const events: RecordedEvent[] = [];

  return {
    clock,
    seedChannelMessages: (channelId, raws) => {
      const list = channelMessages.get(channelId) ?? [];
      list.push(...raws);
      channelMessages.set(channelId, list);
    },
    scriptFetchError: (channelId, error, onCall = 0) => {
      const m = fetchErrors.get(channelId) ?? new Map<number, ScriptedError>();
      m.set(onCall, error);
      fetchErrors.set(channelId, m);
    },
    backfillFetcher,
    fetchCalls,
    seedArchivedThreads: (parentId, threads, o = {}) => {
      archived.set(parentId, {
        publicThreads: [...threads],
        publicHasMore: o.hasMore ?? false,
        privateThreads: o.privateThreads ? [...o.privateThreads] : [],
        privateHasMore: o.privateHasMore ?? false,
      });
    },
    archiveSource,
    scriptSendError: (error, onCall = 0) => {
      sendErrors.set(onCall, error);
    },
    sender,
    sentMessages,
    seedRecentSent: (channelId, messages) => {
      recentSent.set(channelId, [...messages]);
    },
    recentSentLookup,
    recordEvent: (type, payload) => {
      events.push({ type, payload });
    },
    events,
  };
}
