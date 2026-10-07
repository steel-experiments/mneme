import { createHash } from 'node:crypto';
import { type DatabaseSync } from '../db/database.js';
import { getMessage } from '../db/repositories/messages.js';
import { prepareCached } from '../db/repositories/util.js';
import { getMemory } from '../memory/repository.js';
import type { RetrievalGrant } from '../db/repositories/message-search.js';
import type { ArchiveReader } from '../platform-archive/read.js';
import type { DocsIndex } from './docs-index.js';

/**
 * Per-run retrieval accounting shared by the agent tools (Sections 7.3, 21.2).
 *
 * The host — never the model — owns scope and budget. Each retrieval tool records
 * the channels and memory scopes it actually exposes and reserves characters
 * against the per-run retrieved-character cap before returning anything to the
 * model, so a run can never exceed its retrieval budget no matter how many tools
 * the model calls. The accumulated provenance is stored on the agent run and is
 * an input to outbound validation (Section 7.4).
 */

export const DEFAULT_RUN_CHAR_BUDGET = 60_000;

export type RetrievalSource =
  | 'initial_payload'
  | 'message_search'
  | 'message_list'
  | 'activity_snapshot'
  | 'message_context'
  | 'memory_search'
  | 'memory_list'
  | 'memory_evidence';

export type RecentActivitySnapshotTruncationReason =
  | 'none'
  | 'message_cap'
  | 'character_cap'
  | 'message_and_character_cap';

/**
 * Content-free host metadata for the latest direct-answer activity snapshot.
 * The direct-answer delivery path consumes this from {@link RetrievalProvenance}
 * to enforce citations and append a deterministic partial-coverage footer.
 */
export interface RecentActivitySnapshotCoverage {
  /** Effective inclusive lower bound. */
  afterMs: number;
  /** Effective exclusive upper bound, clamped to the immutable question time. */
  beforeMs: number;
  /** Null means the full permitted scope; otherwise the exact requested subset. */
  requestedChannelIds: string[] | null;
  totalMatching: number;
  included: number;
  matchingChannelCount: number;
  includedChannelCount: number;
  /** Every channel contributing to aggregate coverage; handler revalidates these. */
  matchedChannelIds: string[];
  oldestMatchedAtMs: number | null;
  newestMatchedAtMs: number | null;
  oldestIncludedAtMs: number | null;
  newestIncludedAtMs: number | null;
  complete: boolean;
  omitted: number;
  truncationReason: RecentActivitySnapshotTruncationReason;
  /** Exact snapshot rows exposed to the model; no omitted row is listed. */
  exposedMessageIds: string[];
}

export interface ExposedChannel {
  channelId: string;
  source: RetrievalSource;
}

export interface ExposedMemoryScope {
  scopeType: string;
  scopeKey: string | null;
  source: RetrievalSource;
}

export interface RetrievalProvenance {
  channels: ExposedChannel[];
  /** Exact message rows exposed to the model. */
  messageIds: string[];
  /** Content-free versions captured at the exact exposure boundary. */
  messageFingerprints: ExposedMessageFingerprint[];
  memoryScopes: ExposedMemoryScope[];
  /** Exact memory rows exposed to the model. */
  memoryIds: string[];
  /** Content-free versions captured at the exact exposure boundary. */
  memoryFingerprints: ExposedMemoryFingerprint[];
  charsExposed: number;
  charBudget: number;
  /** Present only after `get_recent_activity_snapshot` executes successfully. */
  recentActivitySnapshot?: RecentActivitySnapshotCoverage;
  /** `archive:` ids of platform-archive rows exposed to the model; present only when non-empty (plan 011). */
  archiveIds?: string[];
}

export interface ExposedMessageFingerprint {
  messageId: string;
  fingerprint: string;
}

export interface ExposedMemoryFingerprint {
  memoryId: string;
  fingerprint: string;
}

const CONFLICTING_EXPOSURE_FINGERPRINT = 'conflicting-exposure';
const UNAVAILABLE_EXPOSURE_FINGERPRINT = 'unavailable-at-exposure';

function sha256(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Hash every message field that can affect a model-visible retrieval result,
 * plus the joined channel/user metadata used by activity snapshots. The hash
 * is persisted as provenance; message content itself is never duplicated.
 */
export function fingerprintExposedMessage(
  db: DatabaseSync,
  messageId: string,
): string | undefined {
  const message = getMessage(db, messageId);
  if (!message) return undefined;
  const metadata = prepareCached(db, 'retrieval_fingerprint.message_metadata', `
    SELECT c.name AS channel_name,
           c.parent_id,
           c.is_thread,
           c.visibility_class,
           c.ingest_enabled,
           c.deleted_at_ms AS channel_deleted_at_ms,
           p.name AS parent_name,
           p.visibility_class AS parent_visibility_class,
           p.ingest_enabled AS parent_ingest_enabled,
           p.deleted_at_ms AS parent_deleted_at_ms,
           u.is_bot AS author_is_bot,
           COALESCE((
             SELECT SUM(rc.count) FROM reaction_counts rc WHERE rc.message_id = ?
           ), 0) AS reaction_total
      FROM channels c
      LEFT JOIN channels p ON p.id = c.parent_id
      LEFT JOIN users u ON u.id = ?
     WHERE c.id = ?
  `).get(message.id, message.author_id, message.channel_id) as Record<string, unknown> | undefined;
  const evidence = prepareCached(db, 'retrieval_fingerprint.message_evidence', `
    SELECT memory_id, stance, weight, note, created_at_ms
      FROM memory_evidence
     WHERE message_id = ?
     ORDER BY memory_id ASC, stance ASC
  `).all(message.id).map((row) => {
    const value = row as Record<string, unknown>;
    return [
      String(value.memory_id),
      String(value.stance),
      Number(value.weight),
      value.note === null ? null : String(value.note),
      Number(value.created_at_ms),
    ];
  });
  return sha256([
    message.id,
    message.workspace_id,
    message.channel_id,
    message.author_id,
    message.author_display_name,
    message.content,
    message.created_at_ms,
    message.edited_at_ms,
    message.deleted_at_ms,
    message.reply_to_message_id,
    message.message_type,
    message.flags,
    message.pinned,
    message.mention_everyone,
    message.mentions_json,
    message.embeds_json,
    message.components_json,
    message.poll_json,
    metadata?.channel_name ?? null,
    metadata?.parent_id ?? null,
    metadata?.is_thread ?? null,
    metadata?.visibility_class ?? null,
    metadata?.ingest_enabled ?? null,
    metadata?.channel_deleted_at_ms ?? null,
    metadata?.parent_name ?? null,
    metadata?.parent_visibility_class ?? null,
    metadata?.parent_ingest_enabled ?? null,
    metadata?.parent_deleted_at_ms ?? null,
    metadata?.author_is_bot ?? null,
    Number(metadata?.reaction_total ?? 0),
    evidence,
  ]);
}

/** Hash every durable memory field the retrieval tools can expose. */
export function fingerprintExposedMemory(
  db: DatabaseSync,
  memoryId: string,
): string | undefined {
  const memory = getMemory(db, memoryId);
  if (!memory) return undefined;
  const evidence = prepareCached(db, 'retrieval_fingerprint.memory_evidence', `
    SELECT message_id, stance, weight, note, created_at_ms
      FROM memory_evidence
     WHERE memory_id = ?
     ORDER BY message_id ASC, stance ASC
  `).all(memoryId).map((row) => {
    const value = row as Record<string, unknown>;
    return [
      String(value.message_id),
      String(value.stance),
      Number(value.weight),
      value.note === null ? null : String(value.note),
      Number(value.created_at_ms),
      // A durable statement is only as current as its evidence. Bind the
      // memory exposure to the exact evidence-message versions so an in-place
      // redaction cannot leave a stale statement eligible for delivery.
      fingerprintExposedMessage(db, String(value.message_id))
        ?? UNAVAILABLE_EXPOSURE_FINGERPRINT,
    ];
  });
  return sha256([
    memory.id,
    memory.workspace_id,
    memory.scope_type,
    memory.scope_key,
    memory.type,
    memory.statement,
    memory.normalized_key,
    memory.status,
    memory.confidence,
    memory.importance,
    memory.owner_user_id,
    memory.valid_from_ms,
    memory.review_after_ms,
    memory.resolved_at_ms,
    memory.first_seen_at_ms,
    memory.last_confirmed_at_ms,
    memory.created_by_run_id,
    memory.supersedes_memory_id,
    memory.metadata_json,
    memory.created_at_ms,
    memory.updated_at_ms,
    evidence,
  ]);
}

function memoryScopeKey(scopeType: string, scopeKey: string | null): string {
  return `${scopeType}:${scopeKey ?? ''}`;
}

/**
 * Mutable, run-scoped accumulator for retrieval provenance and the character
 * budget. Tools call {@link tryReserve} before exposing content and the record
 * helpers as they surface channels/scopes.
 */
export class RunRetrievalState {
  private readonly channels = new Map<string, ExposedChannel>();
  private readonly messageIds = new Set<string>();
  private readonly messageFingerprints = new Map<string, string>();
  private readonly scopes = new Map<string, ExposedMemoryScope>();
  private readonly memoryIds = new Set<string>();
  private readonly memoryFingerprints = new Map<string, string>();
  private recentActivitySnapshot: RecentActivitySnapshotCoverage | undefined;
  private readonly archiveIds = new Set<string>();
  private chars = 0;

  constructor(
    private readonly charBudget: number,
    private readonly now: number,
    private readonly db: DatabaseSync,
  ) {}

  get nowMs(): number {
    return this.now;
  }

  get charsExposed(): number {
    return this.chars;
  }

  get remainingChars(): number {
    return Math.max(0, this.charBudget - this.chars);
  }

  get hasRecentActivitySnapshot(): boolean {
    return this.recentActivitySnapshot !== undefined;
  }

  /** Record one platform-archive row exposed to the model. Archive rows never
   *  enter the live message, channel, or memory provenance (plan 011). */
  recordArchive(archiveId: string): void {
    this.archiveIds.add(archiveId);
  }

  /** Reserve `chars` against the budget. Returns false without mutating if it
   *  would exceed the cap. */
  tryReserve(chars: number): boolean {
    if (chars < 0) return false;
    if (this.chars + chars > this.charBudget) return false;
    this.chars += chars;
    return true;
  }

  /** Release previously reserved characters (e.g. when a result is dropped). */
  release(chars: number): void {
    this.chars = Math.max(0, this.chars - Math.min(chars, this.chars));
  }

  recordChannel(channelId: string, source: RetrievalSource): void {
    if (!this.channels.has(channelId)) {
      this.channels.set(channelId, { channelId, source });
    }
  }

  recordMessage(
    messageId: string,
    channelId: string,
    source: RetrievalSource,
    capturedFingerprint?: string,
  ): void {
    this.messageIds.add(messageId);
    this.recordFingerprint(
      this.messageFingerprints,
      messageId,
      capturedFingerprint ?? fingerprintExposedMessage(this.db, messageId),
    );
    this.recordChannel(channelId, source);
  }

  recordMemoryScope(
    scopeType: string,
    scopeKey: string | null,
    source: RetrievalSource,
  ): void {
    const key = memoryScopeKey(scopeType, scopeKey);
    if (!this.scopes.has(key)) {
      this.scopes.set(key, { scopeType, scopeKey, source });
    }
  }

  recordMemory(memoryId: string): void {
    this.memoryIds.add(memoryId);
    this.recordFingerprint(
      this.memoryFingerprints,
      memoryId,
      fingerprintExposedMemory(this.db, memoryId),
    );
  }

  private recordFingerprint(
    fingerprints: Map<string, string>,
    id: string,
    current: string | undefined,
  ): void {
    const captured = current ?? UNAVAILABLE_EXPOSURE_FINGERPRINT;
    const previous = fingerprints.get(id);
    if (previous === undefined) {
      fingerprints.set(id, captured);
    } else if (previous !== captured) {
      // The model saw two versions during one run. No single current version
      // can prove which one its answer used, so outbound validation must fail.
      fingerprints.set(id, CONFLICTING_EXPOSURE_FINGERPRINT);
    }
  }

  /**
   * Store the run's sole snapshot coverage. Returns false without mutation once
   * a successful snapshot already exists, making the one-shot rule host-owned.
   */
  recordRecentActivitySnapshot(coverage: RecentActivitySnapshotCoverage): boolean {
    if (this.recentActivitySnapshot !== undefined) return false;
    this.recentActivitySnapshot = {
      ...coverage,
      requestedChannelIds: coverage.requestedChannelIds === null
        ? null
        : [...coverage.requestedChannelIds],
      matchedChannelIds: [...coverage.matchedChannelIds],
      exposedMessageIds: [...coverage.exposedMessageIds],
    };
    return true;
  }

  provenance(): RetrievalProvenance {
    const provenance: RetrievalProvenance = {
      channels: [...this.channels.values()],
      messageIds: [...this.messageIds],
      messageFingerprints: [...this.messageFingerprints].map(([messageId, fingerprint]) => ({
        messageId,
        fingerprint,
      })),
      memoryScopes: [...this.scopes.values()],
      memoryIds: [...this.memoryIds],
      memoryFingerprints: [...this.memoryFingerprints].map(([memoryId, fingerprint]) => ({
        memoryId,
        fingerprint,
      })),
      charsExposed: this.chars,
      charBudget: this.charBudget,
    };
    if (this.archiveIds.size > 0) provenance.archiveIds = [...this.archiveIds];
    if (this.recentActivitySnapshot) {
      provenance.recentActivitySnapshot = {
        ...this.recentActivitySnapshot,
        requestedChannelIds: this.recentActivitySnapshot.requestedChannelIds === null
          ? null
          : [...this.recentActivitySnapshot.requestedChannelIds],
        matchedChannelIds: [...this.recentActivitySnapshot.matchedChannelIds],
        exposedMessageIds: [...this.recentActivitySnapshot.exposedMessageIds],
      };
    }
    return provenance;
  }
}

/**
 * Greedily fit `items` into the remaining per-run character budget. Each item is
 * rendered to a line; items are included in order until one would exceed the
 * budget, at which point the rest are dropped and `truncated` reports how many.
 * A truncation notice (when something is dropped) is only added if it fits.
 *
 * Returns the included items, their rendered lines, and the dropped count. The
 * caller joins the lines and records provenance for the included items.
 */
export function fitItemsToBudget<T>(
  retrieval: RunRetrievalState,
  items: readonly T[],
  render: (item: T) => string,
  truncationNote: (dropped: number) => string,
): { lines: string[]; included: T[]; truncated: number } {
  const included: T[] = [];
  const lines: string[] = [];
  for (const item of items) {
    const line = render(item);
    // +1 accounts for the newline that will join lines together.
    if (!retrieval.tryReserve(line.length + 1)) break;
    lines.push(line);
    included.push(item);
  }
  const truncated = items.length - included.length;
  if (truncated > 0) {
    const note = truncationNote(truncated);
    if (retrieval.tryReserve(note.length + 1)) lines.push(note);
  }
  return { lines, included, truncated };
}

/** Everything a run-scoped tool needs: the database, the injected scope ceiling,
 *  and the shared retrieval accumulator. */
export interface AgentRunContext {
  db: DatabaseSync;
  grant: RetrievalGrant;
  retrieval: RunRetrievalState;
  /** Immutable direct-question creation time; snapshot `before` cannot exceed it. */
  requestCreatedAtMs?: number;
  /** Mneme's own documentation, for direct-answer runs (Section 22.7). */
  docs?: DocsIndex;
  /** The read-only platform archive, when one is configured (plan 011). */
  archive?: ArchiveReader;
}
