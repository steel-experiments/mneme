// ABOUTME: One target-scoped scheduled cohort: validates the pinned attention
// ABOUTME: revision before and after the model, then delegates to the runner.
import type { DatabaseSync } from '../../db/database.js';
import { getChannel } from '../../db/repositories/channels.js';
import { fingerprintExposedMemory } from '../../agent/run-context.js';
import type { DueMemoryCandidate } from '../../memory/due.js';
import { getMemory } from '../../memory/repository.js';
import { revisionHasUnconsumedEvent, validateRevisionEvidence } from '../../memory/attention-repository.js';
import { recomputeMemoryScopes } from '../../memory/search.js';
import {
  resolveScheduledMemoryRoute,
  resolveScheduledSubjectRoute,
  type ScheduledRouteOptions,
} from '../../memory/scheduled-routing.js';
import type { ScheduledSubjectSnapshot } from '../../memory/scheduled-notifications.js';
import type { JobHandler } from '../worker.js';
import type { JobRow, JobTypePayloadMap } from '../types.js';
import {
  createReviewDueMemoriesHandler,
  type ReviewDueMemoriesHandlerDeps,
  type ReviewScope,
  type ScheduledReviewOutcome,
} from './review-due-memories.js';

export interface ReviewDueMemoryCohortDeps extends ScheduledRouteOptions {
  db: DatabaseSync;
  base: Omit<ReviewDueMemoriesHandlerDeps, 'db' | 'guildId' | 'resolveReviewScope'
    | 'selectDue' | 'validateSnapshot' | 'validateNotificationSubjects' | 'sessionId'>;
  resolveWorkingScope: (targetChannelId: string) => ReviewScope;
  resolveSecureScope: () => ReviewScope;
  currentRouteOptions?: () => ScheduledRouteOptions;
  onPendingProposal?: (outcome: Extract<ScheduledReviewOutcome, { kind: 'reviewed' }>) => Promise<void>;
}

function currentCandidates(
  db: DatabaseSync,
  subjects: readonly ScheduledSubjectSnapshot[],
  now: number,
): DueMemoryCandidate[] {
  const scopes = recomputeMemoryScopes(db, subjects.map((subject) => subject.memoryId));
  const countEvidence = db.prepare('SELECT COUNT(*) AS count FROM memory_evidence WHERE memory_id = ?');
  const out: DueMemoryCandidate[] = [];
  for (const subject of subjects) {
    const memory = getMemory(db, subject.memoryId);
    // Attention admission is independent of `review_after_ms`: a memory with
    // no model review date can still have a current human development.
    if (!memory || memory.status !== 'active') continue;
    void now;
    const scope = scopes.get(memory.id);
    const count = countEvidence.get(memory.id) as { count: number } | undefined;
    out.push({
      memoryId: memory.id,
      type: memory.type,
      statement: memory.statement,
      status: memory.status,
      confidence: memory.confidence,
      importance: memory.importance,
      reviewAfterMs: memory.review_after_ms ?? memory.created_at_ms,
      lastConfirmedAtMs: memory.last_confirmed_at_ms,
      evidenceCount: Number(count?.count ?? 0),
      scopeType: scope?.scopeType ?? 'review_only',
      scopeKey: scope?.scopeKey ?? null,
    });
  }
  return out;
}

/** Run exactly one target-scoped scheduled cohort and release its durable ownership on success. */
export function createReviewDueMemoryCohortHandler(
  deps: ReviewDueMemoryCohortDeps,
): JobHandler<'review_due_memory_cohort'> {
  return async (payload: JobTypePayloadMap['review_due_memory_cohort'], job: JobRow) => {
    const routeOptions = (): ScheduledRouteOptions => deps.currentRouteOptions?.() ?? deps;
    const releaseLeases = () => {
      deps.db.prepare('DELETE FROM scheduled_review_cohort_subject_leases WHERE job_id = ?').run(job.id);
    };
    // A legacy payload without an explicit mode carries no revision identity
    // and is not permission for registration: it fails closed.
    if (payload.mode !== 'attention_review' && payload.mode !== 'attention_registration') {
      releaseLeases();
      return;
    }
    const subjectIsCurrent = (subject: ScheduledSubjectSnapshot & { attentionRevisionId?: string }): boolean => {
      const memory = getMemory(deps.db, subject.memoryId);
      if (!memory || memory.status !== 'active') return false;
      if (fingerprintExposedMemory(deps.db, subject.memoryId) !== subject.memoryFingerprint) return false;
      const route = resolveScheduledMemoryRoute(deps.db, subject.memoryId, routeOptions());
      if (route.kind !== payload.routeKind || route.targetChannelId !== payload.targetChannelId) return false;
      if (payload.mode === 'attention_review') {
        // The pinned revision must still be current and unconsumed with a
        // live trigger; window containment is rechecked by the runner's gate.
        const pinned = subject.attentionRevisionId;
        if (typeof pinned !== 'string' || pinned.length === 0) return false;
        if (!validateRevisionEvidence(deps.db, pinned, deps.base.now?.() ?? Date.now())
          || !revisionHasUnconsumedEvent(deps.db, pinned)) return false;
      }
      return true;
    };
    // A stale member has not influenced the model yet, so it may be dropped at
    // this boundary. After exposure the guard below is deliberately all-or-none.
    const snapshots = payload.subjects.filter((subject) =>
      subjectIsCurrent(subject as ScheduledSubjectSnapshot & { attentionRevisionId?: string }));
    const snapshotValid = (): boolean => payload.subjects.every((subject) =>
      subjectIsCurrent(subject as ScheduledSubjectSnapshot & { attentionRevisionId?: string }));
    if (snapshots.length === 0) {
      releaseLeases();
      return;
    }
    if (!snapshotValid()) {
      releaseLeases();
      return;
    }

    const baseResolvedScope = payload.routeKind === 'working'
      ? deps.resolveWorkingScope(payload.targetChannelId)
      : deps.resolveSecureScope();
    // A registration pass may persist validated revisions but never posts:
    // its notification flag is always false.
    const resolvedScope: ReviewScope = payload.mode === 'attention_registration'
      ? { ...baseResolvedScope, notificationsAllowed: false }
      : baseResolvedScope;
    const target = getChannel(deps.db, payload.targetChannelId);
    if (!target || resolvedScope.targetChannelId !== payload.targetChannelId) {
      releaseLeases();
      return;
    }

    const attentionRevisions = new Map<string, { revisionId: string; windowFromMs: number; windowUntilMs: number }>();
    if (payload.mode === 'attention_review') {
      for (const subject of payload.subjects) {
        const pinned = subject as { attentionRevisionId?: string; attentionWindowFromMs?: number; attentionWindowUntilMs?: number };
        if (typeof pinned.attentionRevisionId === 'string') {
          attentionRevisions.set(subject.memoryId, {
            revisionId: pinned.attentionRevisionId,
            windowFromMs: pinned.attentionWindowFromMs ?? 0,
            windowUntilMs: pinned.attentionWindowUntilMs ?? 0,
          });
        }
      }
    }

    const runner = createReviewDueMemoriesHandler({
      ...deps.base,
      db: deps.db,
      guildId: deps.guildId,
      resolveReviewScope: () => resolvedScope,
      selectDue: (now) => currentCandidates(deps.db, snapshots, now),
      validateSnapshot: snapshotValid,
      attentionMode: payload.mode,
      attentionRevisions,
      validateNotificationSubjects: (subjects) => {
        if (payload.mode !== 'attention_review' || payload.routeKind !== 'working' || subjects.length === 0) return false;
        const route = resolveScheduledSubjectRoute(
          deps.db,
          subjects.map((subject) => subject.memoryId),
          routeOptions(),
        );
        return route?.kind === 'working' && route.targetChannelId === payload.targetChannelId;
      },
      sessionId: `mneme:scheduled-review:${job.id}`,
    });
    const outcome = await runner.runScheduledReview();
    if (outcome.kind === 'reviewed' && outcome.notification.routing.state === 'pending_review') {
      await deps.onPendingProposal?.(outcome);
    }
    releaseLeases();
  };
}
