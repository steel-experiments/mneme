import type { Api, Model, ThinkingLevel } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { type DatabaseSync } from '../../db/database.js';
import { prepareCached } from '../../db/repositories/util.js';
import { getMessage } from '../../db/repositories/messages.js';
import { getUser } from '../../db/repositories/users.js';
import { getReactionCountsForMessage } from '../../db/repositories/reactions.js';
import { discordMessageLink } from '../../db/repositories/message-search.js';
import type { RetrievalGrant } from '../../db/repositories/message-search.js';
import {
  getEpisode,
  listEpisodeMessages,
  markReviewing,
  requeueReviewing,
  markReviewed,
  markSkipped,
  markError,
  type EpisodeRow,
} from '../../episodes/repository.js';
import {
  evaluateEpisodePrefilter,
  type PrefilterEvaluation,
} from '../../episodes/prefilter.js';
import {
  evaluateSettle,
  lastHumanMessageAtMs,
  DEFAULT_SETTLE_CONFIG,
  type SettleConfig,
} from '../../episodes/settle.js';
import type { PromptCompiler } from '../../agent/prompts.js';
import {
  executeAgentRun,
  type AgentRunResult,
  type AgentRunUsage,
  type ExecuteAgentRunDeps,
  type RunLimits,
} from '../../agent/runtime.js';
import { emptyAgentRunUsage } from '../../agent/usage.js';
import {
  compareEpisodeProposals,
  type EpisodeShadowComparison,
} from '../../agent/episode-comparison.js';
import type { Logger } from '../../logger.js';
import { computeInterventionScore, type InterventionDimensions } from '../../agent/policy.js';
import {
  applyMemoryProposals,
  type AgentMemoryProposal,
  type ApplyMemoryProposalsResult,
} from '../../agent/memory-policy.js';
import { insertProposal } from '../../db/repositories/proposals.js';
import { unavailablePolicyDecision } from '../../agent/policy-audit.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';
import { DeferJobError, TransientJobError } from '../errors.js';
import { isMnemeTestSurface } from '../../discord/test-channels.js';
import {
  resolveScheduledFeedback,
  type ScheduledFeedbackAssociation,
} from '../../memory/scheduled-feedback.js';

/**
 * `review_episode` job handler (Sections 11, 18, 21.4).
 *
 * One queued episode becomes one bounded agent review. The handler loads the
 * ordered transcript (messages, reactions, runtime counters, generated links)
 * and the host-computed target scope, runs the conservative local pre-filter
 * (Section 11.4) to skip unmistakably trivial episodes without a
 * model call, renders the episode-review prompt, and executes exactly one
 * {@link executeAgentRun} **outside any transaction** (Section 10: handlers run
 * after the claim transaction commits). It then persists the review outcome and
 * stops — it never posts, enqueues an outbox item, or otherwise sends. Silence
 * is a valid outcome (Section 1.4).
 *
 * Episode state transitions are closed and terminal for every path:
 *   - skip (pre-filter)        → `skipped`
 *   - finalized proposal        → `reviewed` (summary, consequential, score)
 *   - every other run outcome   → `error`
 * The handler returns rather than throws on every path, so a failed review
 * records itself on the episode and completes the job; ingestion is untouched.
 */

/** Agent runtime inputs; required unless {@link ReviewEpisodeHandlerDeps.executeRun} overrides the run. */
export interface AgentRuntimeInputs {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  streamFn: StreamFn;
  providerId: string;
  modelId: string;
}

/** Per-channel scope resolved by the host: the retrieval ceiling and prompt target metadata. */
export interface ChannelScope {
  grant: RetrievalGrant;
  target: { label: string; visibility: string };
}

/** Recent Mneme post counts fed to the prompt's runtime context (Section 23). */
export interface EpisodeReviewRuntimeCounters {
  recentChannelPosts: number;
  globalPostsToday: number;
}

export interface EpisodeShadowOptions {
  enabled: boolean;
  /** Fully resolved candidate runtime. Omitted only by tests that reuse the authoritative model. */
  agent?: AgentRuntimeInputs;
  thinkingLevel: ThinkingLevel;
  maxRuns: number;
}

export interface ReviewEpisodeHandlerDeps {
  db: DatabaseSync;
  guildId: string;
  /** Mneme's own Discord user id (so its own messages are not counted as human). */
  mnemeId: string;
  promptCompiler: PromptCompiler | (() => PromptCompiler);
  /** `channel-policy.yml` source, included in the prompt version when present. */
  channelPolicyYml?: string | (() => string);
  /** `mneme.yml` source, included in the prompt version when present. */
  mnemeYml?: string;
  /** Rendered system prompt, or a renderer using this run's complete context. */
  systemPrompt: string | ((context: Record<string, unknown>) => string);
  /** Resolve the retrieval grant and target metadata for the episode's conversation channel. */
  resolveChannelScope: (channelId: string) => ChannelScope;
  /** Recent Mneme post counts for the prompt's runtime context. */
  runtimeCounters: (channelId: string, now: number) => EpisodeReviewRuntimeCounters;
  /** Deployment mode label rendered into the prompt (e.g. "passive"). */
  mode: string | (() => string);
  /** Intervention threshold from policy (Section 23). */
  interventionThreshold: number;
  /** Agent runtime inputs; required unless `executeRun` overrides the run. */
  agent?: AgentRuntimeInputs;
  /** Override the agent-run executor (tests). Defaults to {@link executeAgentRun}. */
  executeRun?: (deps: ExecuteAgentRunDeps) => Promise<AgentRunResult>;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  /** Per-run host-enforced limits (Section 21.2). */
  limits?: Partial<RunLimits>;
  /** Bounded non-acting comparison against finalized live episode reviews. */
  episodeShadow?: EpisodeShadowOptions;
  memoryMinimumConfidence?: number;
  memoryMinimumImportance?: number;
  /** Proactive attention window (Section 12.7; default seven days). */
  attentionWindowMs?: number;
  /** Organization timezone captured with accepted deadline authority. */
  attentionTimezone?: string;
  /** Bounded same-conversation look-ahead for asynchronous follow-ups. */
  memoryFollowupHorizonDays?: number;
  memoryFollowupMaxMessages?: number;
  /** Conversation settle gate (Section 11.8; default ten minutes, one-hour bound). */
  settle?: SettleConfig;
  /** Route the validated intervention. Omission fails closed to an observed row. */
  routeIntervention?: (input: {
    proposal: EpisodeReviewProposalShape;
    result: AgentRunResult;
    episode: EpisodeRow;
    scope: ChannelScope;
    now: number;
    /** Resolved memory-mutation outcomes, including the index-to-memoryId mapping. */
    memoryOutcome: ApplyMemoryProposalsResult;
    /** Message IDs of the episode payload and its bounded follow-ups only. */
    episodeMessageIds: ReadonlySet<string>;
  }) => string | undefined | Promise<string | undefined>;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/** Why the handler did not run a model review. */
export type ReviewEpisodeMissReason = 'missing' | 'not_queued';

export interface ReviewEpisodeReviewed {
  kind: 'reviewed';
  episodeId: string;
  runId: string;
  summary: string;
  consequential: boolean;
  interventionScore: number;
  usage: AgentRunUsage;
  outcome: 'finalized';
}

export interface ReviewEpisodeSkipped {
  kind: 'skipped';
  episodeId: string;
  reason: 'prefilter';
  evaluation: PrefilterEvaluation;
}

export interface ReviewEpisodeTestSurfaceSkipped {
  kind: 'skipped';
  episodeId: string;
  reason: 'test_surface';
}

export interface ReviewEpisodeErrored {
  kind: 'error';
  episodeId: string;
  runId: string;
  /** The run's terminal failure outcome. */
  outcome: Exclude<AgentRunResult['outcome'], 'finalized'>;
  failureReason: string | null;
  usage: AgentRunUsage;
}

export interface ReviewEpisodeMiss {
  kind: ReviewEpisodeMissReason;
  episodeId: string;
  status?: EpisodeRow['status'];
}

/** The conversation was still live, so the review was held (Section 11.8). */
export interface ReviewEpisodeDeferred {
  kind: 'deferred';
  episodeId: string;
  /** Epoch ms this review should be retried at. */
  retryAtMs: number;
  /** Quiet milliseconds observed when the gate ran. */
  idleMs: number | null;
}

export type ReviewEpisodeOutcome =
  | ReviewEpisodeReviewed
  | ReviewEpisodeSkipped
  | ReviewEpisodeTestSurfaceSkipped
  | ReviewEpisodeErrored
  | ReviewEpisodeMiss
  | ReviewEpisodeDeferred;

/**
 * Fully rendered, side-effect-free input for one episode review.
 *
 * Local evaluation tools may use this against a copied database without
 * changing episode state or applying memories/proposals. It composes the same
 * transcript, look-ahead, feedback, scope, and rendering helpers as production;
 * the production handler retains its prefilter-before-render ordering.
 */
export interface PreparedEpisodeReviewContext {
  transcript: EpisodeTranscript;
  scheduledFeedback: ScheduledFeedbackAssociation[];
  followups: EpisodeMessagePayload[];
  prefilter: PrefilterEvaluation;
  scope: ChannelScope;
  context: Record<string, unknown>;
  systemPrompt: string;
  promptText: string;
  promptVersion: string;
}

export function prepareEpisodeReviewContext(
  deps: ReviewEpisodeHandlerDeps,
  episode: EpisodeRow,
  now: number,
): PreparedEpisodeReviewContext {
  const transcript = loadEpisodeTranscript(deps.db, episode, deps.mnemeId);
  const scheduledFeedback = resolveScheduledFeedback(deps.db, {
    guildId: deps.guildId,
    channelId: episode.conversation_channel_id,
    messageIds: transcript.payloadMessages.map((message) => message.id),
    mnemeId: deps.mnemeId,
  });
  const followups = loadAsynchronousFollowups(
    deps.db,
    episode,
    transcript,
    deps.mnemeId,
    now,
    {
      horizonDays: deps.memoryFollowupHorizonDays ?? 14,
      maxMessages: deps.memoryFollowupMaxMessages ?? 20,
    },
  );
  const prefilter = evaluateEpisodePrefilter({
    mnemeId: deps.mnemeId,
    messages: transcript.prefilterMessages,
    options: {
      memoryLinkedMessageIds: new Set([
        ...transcript.memoryLinkedMessageIds,
        ...scheduledFeedback.map((feedback) => feedback.replyMessageId),
      ]),
    },
  });
  const scope = deps.resolveChannelScope(episode.conversation_channel_id);
  const counters = deps.runtimeCounters(episode.conversation_channel_id, now);
  const context = buildRenderContext(
    episode,
    transcript,
    followups,
    scheduledFeedback,
    scope,
    deps,
    counters,
    now,
  );
  const compiler = typeof deps.promptCompiler === 'function' ? deps.promptCompiler() : deps.promptCompiler;
  const promptText = compiler.render('episode-review', context);
  const promptVersion = compiler.versionFor('episode-review', {
    mnemeYml: deps.mnemeYml,
    channelPolicyYml:
      typeof deps.channelPolicyYml === 'function' ? deps.channelPolicyYml() : deps.channelPolicyYml,
  });
  const systemPrompt =
    typeof deps.systemPrompt === 'function' ? deps.systemPrompt(context) : deps.systemPrompt;
  return {
    transcript,
    scheduledFeedback,
    followups,
    prefilter,
    scope,
    context,
    systemPrompt,
    promptText,
    promptVersion,
  };
}

/** Build a `review_episode` handler. `runReview(episodeId)` exposes the work for callers/tests. */
export function createReviewEpisodeHandler(
  deps: ReviewEpisodeHandlerDeps,
): JobHandler<'review_episode'> & {
  runReview(episodeId: string): Promise<ReviewEpisodeOutcome>;
} {
  if (!deps.agent && !deps.executeRun) {
    throw new Error('createReviewEpisodeHandler: either `agent` or `executeRun` must be provided');
  }
  const executeRun = deps.executeRun ?? executeAgentRun;
  // Mneme is one Node process, so serializing the count-and-run section is
  // sufficient to make the cumulative cap exact even when episode workers run
  // concurrently. Authoritative reviews remain concurrent; only shadows queue.
  let shadowQueue: Promise<void> = Promise.resolve();

  const persistShadowComparison = (
    shadowRunId: string,
    authoritativeRunId: string,
    comparison: EpisodeShadowComparison,
  ): void => {
    deps.db.prepare(`UPDATE agent_runs
      SET shadow_comparison_json=?
      WHERE id=? AND shadow_of_run_id=?`).run(
      JSON.stringify(comparison),
      shadowRunId,
      authoritativeRunId,
    );
  };

  const runShadow = async (
    episode: EpisodeRow,
    authoritative: AgentRunResult,
    proposal: EpisodeReviewProposalShape,
    runDeps: ExecuteAgentRunDeps,
  ): Promise<void> => {
    const shadow = deps.episodeShadow;
    if (!shadow?.enabled || episode.origin !== 'live') return;
    if (deps.agent?.thinkingLevel !== 'medium') {
      deps.logger?.warn(
        { episodeId: episode.id, authoritativeRunId: authoritative.runId },
        'episode shadow skipped because the authoritative reasoning level is not medium',
      );
      return;
    }
    const candidateAgent = shadow.agent ?? {
      ...deps.agent,
      thinkingLevel: shadow.thinkingLevel,
    };
    const count = deps.db.prepare(
      `SELECT COUNT(*) AS n FROM agent_runs
        WHERE shadow_of_run_id IS NOT NULL AND model=? AND thinking_level=?`,
    ).get(candidateAgent.modelId, candidateAgent.thinkingLevel) as { n: number };
    if (Number(count.n) >= shadow.maxRuns) return;

    try {
      const shadowResult = await executeRun({
        ...runDeps,
        ...candidateAgent,
        sessionId: `mneme:episode-shadow:${episode.id}:${authoritative.runId}`,
        shadowOfRunId: authoritative.runId,
      });
      const shadowProposal = shadowResult.outcome === 'finalized' && shadowResult.finalProposal
        ? shadowResult.finalProposal.proposal as EpisodeReviewProposalShape
        : null;
      const comparison = compareEpisodeProposals(proposal, shadowProposal);
      persistShadowComparison(shadowResult.runId, authoritative.runId, comparison);
      deps.logger?.info({
        episodeId: episode.id,
        authoritativeRunId: authoritative.runId,
        shadowRunId: shadowResult.runId,
        authoritativeCategory: comparison.authoritative.category,
        shadowCategory: comparison.shadow?.category ?? null,
        categoryMatch: comparison.categoryMatch,
        shadowOutcome: shadowResult.outcome,
        shadowModel: candidateAgent.modelId,
        shadowThinkingLevel: candidateAgent.thinkingLevel,
        shadowCostUsd: shadowResult.usage.costUsd,
      }, 'episode candidate shadow completed without applying model effects');
    } catch (err) {
      const row = deps.db.prepare(`SELECT id,final_proposal_json
        FROM agent_runs WHERE shadow_of_run_id=?`).get(authoritative.runId) as
        | { id: string; final_proposal_json: string | null }
        | undefined;
      if (row) {
        let shadowProposal: EpisodeReviewProposalShape | null = null;
        try {
          shadowProposal = row.final_proposal_json
            ? JSON.parse(row.final_proposal_json) as EpisodeReviewProposalShape
            : null;
        } catch {
          shadowProposal = null;
        }
        persistShadowComparison(
          row.id,
          authoritative.runId,
          compareEpisodeProposals(proposal, shadowProposal),
        );
      }
      deps.logger?.warn({
        episodeId: episode.id,
        authoritativeRunId: authoritative.runId,
        shadowRunPersisted: Boolean(row),
        errorCategory: err instanceof Error ? err.name : 'unknown',
      }, 'episode candidate shadow failed without affecting the authoritative review');
    }
  };

  const maybeRunShadow = (
    episode: EpisodeRow,
    authoritative: AgentRunResult,
    proposal: EpisodeReviewProposalShape,
    runDeps: ExecuteAgentRunDeps,
  ): Promise<void> => {
    const queued = shadowQueue
      .then(() => runShadow(episode, authoritative, proposal, runDeps))
      .catch((err: unknown) => {
        deps.logger?.warn({
          episodeId: episode.id,
          authoritativeRunId: authoritative.runId,
          errorCategory: err instanceof Error ? err.name : 'unknown',
        }, 'episode candidate shadow infrastructure failed without affecting the authoritative review');
      });
    shadowQueue = queued;
    return queued;
  };

  const runReview = async (episodeId: string): Promise<ReviewEpisodeOutcome> => {
    const now = deps.now?.() ?? Date.now();
    const db = deps.db;

    const episode = getEpisode(db, episodeId);
    if (!episode) return { kind: 'missing', episodeId };

    // Only a `queued` episode may enter review. Any other status (already
    // reviewed/skipped/errored, or still open) is a no-op: a duplicate or stale
    // review job must never re-open a closed episode.
    if (episode.status !== 'queued') {
      return { kind: 'not_queued', episodeId, status: episode.status };
    }

    // A queued episode can outlive channel discovery or a rename. Re-resolve
    // the complete Mneme test surface immediately before any transcript is
    // loaded or sent to the provider so a normally named child thread cannot
    // become memory evidence after its parent becomes a test console.
    if (isMnemeTestSurface(db, episode.conversation_channel_id)) {
      markSkipped(db, episodeId, now);
      deps.logger?.info({ episodeId }, 'review_episode: skipped Mneme test surface');
      return { kind: 'skipped', episodeId, reason: 'test_surface' };
    }

    // Conversation settle gate (Section 11.8). A closed episode does not mean a
    // finished discussion: the quiet close fires after a short pause and the
    // caps fire mid-conversation. Hold the review while the channel is live so
    // the review sees the later human messages (Section 11.6 look-ahead) and so
    // nothing is proposed over people who are still talking. The hold runs
    // before the episode is leased, so the episode stays `queued` and the job
    // defers without consuming a retry attempt.
    const settle = evaluateSettle({
      lastHumanAtMs: lastHumanMessageAtMs(db, episode.conversation_channel_id, deps.mnemeId),
      episodeClosedAtMs: episode.ended_at_ms ?? episode.last_activity_at_ms,
      now,
      config: deps.settle ?? DEFAULT_SETTLE_CONFIG,
    });
    if (!settle.proceed) {
      deps.logger?.info(
        { episodeId, retryAtMs: settle.retryAtMs, idleMs: settle.idleMs },
        'review_episode: conversation still live; review held',
      );
      return { kind: 'deferred', episodeId, retryAtMs: settle.retryAtMs, idleMs: settle.idleMs };
    }
    if (settle.forced) {
      deps.logger?.info(
        { episodeId, idleMs: settle.idleMs },
        'review_episode: hold bound reached; reviewing a live conversation without speaking',
      );
    }

    // Lease the episode (queued → reviewing) before any model work so a
    // concurrent review job cannot double-review. Returns false on a race.
    if (!markReviewing(db, episodeId, now)) {
      return { kind: 'not_queued', episodeId, status: 'reviewing' };
    }

    const transcript = loadEpisodeTranscript(db, episode, deps.mnemeId);
    const scheduledFeedback = resolveScheduledFeedback(db, {
      guildId: deps.guildId,
      channelId: episode.conversation_channel_id,
      messageIds: transcript.payloadMessages.map((message) => message.id),
      mnemeId: deps.mnemeId,
    });
    const followups = loadAsynchronousFollowups(db, episode, transcript, deps.mnemeId, now, {
      horizonDays: deps.memoryFollowupHorizonDays ?? 14,
      maxMessages: deps.memoryFollowupMaxMessages ?? 20,
    });

    // Conservative local pre-filter (Section 11.4): skip only unmistakably
    // trivial episodes. A skip is terminal and records no model usage.
    const evaluation = evaluateEpisodePrefilter({
      mnemeId: deps.mnemeId,
      messages: transcript.prefilterMessages,
      options: {
        memoryLinkedMessageIds: new Set([
          ...transcript.memoryLinkedMessageIds,
          ...scheduledFeedback.map((feedback) => feedback.replyMessageId),
        ]),
      },
    });
    if (evaluation.skip) {
      markSkipped(db, episodeId, now);
      deps.logger?.info({ episodeId, blockers: evaluation.blockers }, 'review_episode: skipped by pre-filter');
      return { kind: 'skipped', episodeId, reason: 'prefilter', evaluation };
    }

    const scope = deps.resolveChannelScope(episode.conversation_channel_id);
    const counters = deps.runtimeCounters(episode.conversation_channel_id, now);
    const context = buildRenderContext(
      episode,
      transcript,
      followups,
      scheduledFeedback,
      scope,
      deps,
      counters,
      now,
    );
    const compiler = typeof deps.promptCompiler === 'function' ? deps.promptCompiler() : deps.promptCompiler;
    const promptText = compiler.render('episode-review', context);
    const promptVersion = compiler.versionFor('episode-review', {
      mnemeYml: deps.mnemeYml,
      channelPolicyYml: typeof deps.channelPolicyYml === 'function' ? deps.channelPolicyYml() : deps.channelPolicyYml,
    });

    // The agent run executes OUTSIDE any transaction. executeAgentRun writes its
    // own `agent_runs` row (running → completed/failed) with prompt version,
    // provenance, usage, and the accepted proposal. It never sends anything.
    //
    // When an `executeRun` override is injected (tests), the agent runtime
    // inputs are unused by the stub; the constructor guard guarantees a real
    // `agent` is present whenever the default executor runs, so the placeholder
    // reads below are only reached by an overriding executor that ignores them.
    const a = deps.agent;
    const runDeps: ExecuteAgentRunDeps = {
      db,
      grant: scope.grant,
      systemPrompt: typeof deps.systemPrompt === 'function' ? deps.systemPrompt(context) : deps.systemPrompt,
      model: a?.model ?? (undefined as unknown as ExecuteAgentRunDeps['model']),
      thinkingLevel: a?.thinkingLevel ?? 'minimal',
      streamFn: a?.streamFn ?? (undefined as unknown as ExecuteAgentRunDeps['streamFn']),
      sessionId: `mneme:episode:${episodeId}`,
      cacheProfile: 'episode',
      promptText,
      promptVersion,
      runType: 'episode',
      guildId: deps.guildId,
      episodeId,
      pinnedTargetChannelId: episode.conversation_channel_id,
      initialProvenanceChannelIds: [...new Set([
        episode.conversation_channel_id,
        ...scheduledFeedback.flatMap((feedback) =>
          feedback.provenanceChannels.map((channel) => channel.channelId)),
      ])],
      initialProvenanceMemoryScopes: [
        ...scheduledFeedback.flatMap((feedback) => feedback.provenanceMemories),
        ...scheduledFeedback.flatMap((feedback) => feedback.subjects.map((subject) => ({
          memoryId: subject.memoryId,
          scopeType: subject.scopeType,
          scopeKey: subject.scopeKey,
        }))),
      ],
      initialProvenanceMessages: [...transcript.payloadMessages, ...followups].map((message) => ({
        messageId: message.id,
        channelId: episode.conversation_channel_id,
      })),
      providerId: a?.providerId ?? '',
      modelId: a?.modelId ?? '',
      now,
      limits: deps.limits,
    };

    let result: AgentRunResult;
    try {
      result = await executeRun(runDeps);
    } catch (err) {
      if (err instanceof DeferJobError) {
        requeueReviewing(db, episodeId, deps.now?.() ?? Date.now());
        throw err;
      }
      if (err instanceof TransientJobError) {
        requeueReviewing(db, episodeId, deps.now?.() ?? Date.now());
        throw err;
      }
      // The run itself failed to produce a result record (e.g. an injected
      // executor threw before persisting). Fail the episode closed; never throw,
      // so ingestion and the job queue are unaffected.
      markError(db, episodeId, now);
      deps.logger?.warn(
        { episodeId, err: err instanceof Error ? err.message : String(err) },
        'review_episode: run executor threw; episode marked error',
      );
      return {
        kind: 'error',
        episodeId,
        runId: 'unknown',
        outcome: 'error',
        failureReason: err instanceof Error ? err.message : String(err),
        usage: emptyAgentRunUsage(),
      };
    }

    // Discovery can rename the channel or its parent while the provider is in
    // flight. The content was eligible when the run began, but a newly current
    // Mneme test surface must never produce memories or interventions.
    if (isMnemeTestSurface(db, episode.conversation_channel_id)) {
      markSkipped(db, episodeId, deps.now?.() ?? Date.now());
      deps.logger?.info(
        { episodeId, runId: result.runId },
        'review_episode: discarded result after channel became a Mneme test surface',
      );
      return { kind: 'skipped', episodeId, reason: 'test_surface' };
    }

    if (result.outcome === 'finalized' && result.finalProposal) {
      const proposal = result.finalProposal.proposal as EpisodeReviewProposalShape;
      await maybeRunShadow(episode, result, proposal, runDeps);
      if (isMnemeTestSurface(db, episode.conversation_channel_id)) {
        markSkipped(db, episodeId, deps.now?.() ?? Date.now());
        deps.logger?.info(
          { episodeId, runId: result.runId },
          'review_episode: discarded result after channel became a Mneme test surface during shadow evaluation',
        );
        return { kind: 'skipped', episodeId, reason: 'test_surface' };
      }
      const summary = proposal.episodeSummary ?? '';
      const consequential = proposal.consequential === true;
      const interventionScore = proposal.intervention?.dimensions
        ? computeInterventionScore(proposal.intervention.dimensions)
        : 0;
      let memory: ReturnType<typeof applyMemoryProposals>;
      let interventionProposalId: string | undefined;
      try {
        const exposedChannelIds = new Set(result.provenance.channels.map((c) => c.channelId));
        exposedChannelIds.add(episode.conversation_channel_id);
        const exposedMemoryIds = new Set(result.provenance.memoryIds ?? []);
        const exposedMessageIds = new Set([
          ...transcript.payloadMessages.map((message) => message.id),
          ...followups.map((message) => message.id),
          ...(result.provenance.messageIds ?? []),
        ]);
        memory = applyMemoryProposals({
          db,
          grant: scope.grant,
          guildId: deps.guildId,
          runId: result.runId,
          now,
          exposedChannelIds,
          exposedMessageIds,
          exposedMemoryIds,
          minimumConfidence: deps.memoryMinimumConfidence,
          minimumImportance: deps.memoryMinimumImportance,
          attentionWindowMs: deps.attentionWindowMs,
          attentionTimezone: deps.attentionTimezone,
          mnemeId: deps.mnemeId,
          logger: deps.logger,
        }, Array.isArray(proposal.memoryProposals) ? proposal.memoryProposals : []);
        interventionProposalId = await deps.routeIntervention?.({
          proposal,
          result,
          episode,
          scope,
          now,
          memoryOutcome: memory,
          episodeMessageIds: new Set([
            ...transcript.payloadMessages.map((message) => message.id),
            ...followups.map((message) => message.id),
          ]),
        });
        const runPersisted = Boolean(db.prepare('SELECT 1 FROM agent_runs WHERE id = ?').get(result.runId));
        if (!interventionProposalId && proposal.intervention && runPersisted) {
          interventionProposalId = insertProposal(db, {
            runId: result.runId,
            episodeId,
            targetChannelId: proposal.intervention.targetChannelId ?? episode.conversation_channel_id,
            status: 'observed',
            computedScore: interventionScore,
            reason: ['intervention routing unavailable; stored fail-closed'],
            policyDecision: unavailablePolicyDecision('intervention routing unavailable'),
            message: proposal.intervention.message ?? null,
            evidenceMessageIds: proposal.intervention.evidenceMessageIds ?? [],
            now,
          });
        }
      } catch (err) {
        // Never stamp the episode reviewed when its host-side effects failed.
        // The model result remains auditable in agent_runs and any outbound path
        // remains closed; operators can safely inspect/requeue the terminal error.
        markError(db, episodeId, now);
        const failureReason = err instanceof Error ? err.message : String(err);
        deps.logger?.warn({ episodeId, runId: result.runId, err: failureReason },
          'review_episode: host-side finalization failed; episode marked error');
        return { kind: 'error', episodeId, runId: result.runId, outcome: 'error', failureReason, usage: result.usage };
      }
      markReviewed(db, episodeId, { summary, consequential, interventionScore }, now);
      deps.logger?.info(
        { episodeId, runId: result.runId, consequential, interventionScore, memoryApplied: memory.applied.length,
          memoryRejected: memory.rejected.length, interventionProposalId },
        'review_episode: finalized',
      );
      return {
        kind: 'reviewed',
        episodeId,
        runId: result.runId,
        summary,
        consequential,
        interventionScore,
        usage: result.usage,
        outcome: 'finalized',
      };
    }

    // Every non-finalized outcome (aborted/timeout, budget_exceeded, blocked,
    // error/provider, no_finalization/validation rejection) is a closed failure:
    // the episode is marked error and nothing is sent.
    markError(db, episodeId, now);
    deps.logger?.warn(
      { episodeId, runId: result.runId, outcome: result.outcome, failureReason: result.failureReason },
      'review_episode: run did not finalize; episode marked error',
    );
    return {
      kind: 'error',
      episodeId,
      runId: result.runId,
      // `finalized` with a null proposal is treated as a closed failure here;
      // the runtime guarantees a finalized run carries an accepted proposal.
      outcome:
        result.outcome === 'finalized' ? 'no_finalization' : result.outcome,
      failureReason: result.failureReason,
      usage: result.usage,
    };
  };

  const handler = async (payload: { episodeId: string }, _job: JobRow): Promise<void> => {
    const outcome = await runReview(payload.episodeId);
    if (outcome.kind === 'deferred') {
      const now = deps.now?.() ?? Date.now();
      throw new DeferJobError(
        'conversation has not settled',
        Math.max(1, outcome.retryAtMs - now),
      );
    }
  };

  return Object.assign(handler, { runReview });
}

// ---- Transcript loading -----------------------------------------------------

interface EpisodeTranscript {
  /** Ordered, non-deleted messages rendered into the prompt. */
  payloadMessages: EpisodeMessagePayload[];
  /** Structural slices for the local pre-filter. */
  prefilterMessages: readonly PrefilterMessageSlice[];
  /** Message ids in the episode that already link to a memory. */
  memoryLinkedMessageIds: ReadonlySet<string>;
}

interface PrefilterMessageSlice {
  id: string;
  content: string;
  author: { id: string; isBot: boolean };
  mentions: ReadonlyArray<{ id: string }>;
  reactionCounts: ReadonlyArray<{ count: number }>;
}

interface EpisodeMessagePayload {
  ordinal: number;
  id: string;
  author: { id: string | null; displayName: string; isBot: boolean };
  content: string;
  createdAtIso: string;
  replyTo: string | null;
  reactions: ReadonlyArray<{ emoji: string; count: number }>;
  link: string;
}

/** Structural read of the accepted episode-review proposal (host-validated). */
export interface EpisodeReviewProposalShape {
  episodeSummary?: string;
  consequential?: boolean;
  memoryProposals?: AgentMemoryProposal[];
  intervention?: {
    recommend?: boolean;
    reason?: string;
    dimensions?: InterventionDimensions;
    confidence?: number;
    urgency?: 'normal' | 'time_sensitive' | 'critical_review';
    targetChannelId?: string;
    replyToMessageId?: string;
    evidenceMessageIds?: string[];
    message?: string;
    subject?: {
      kind?: string;
      memoryId?: string;
      proposalIndex?: number;
    };
    trigger?: {
      kind?: string;
      evidence?: Array<{ messageId?: string; quote?: string }>;
      relation?: string;
      materialChange?: string;
      revisionId?: string;
    };
  };
}

/**
 * Load the ordered, non-deleted transcript for an episode plus the supporting
 * slices the pre-filter and prompt need. Per-message reactions are read from the
 * aggregate table (no per-user data), and the message ids already cited as
 * memory evidence are gathered so a memory link is never skipped (Section 11.4).
 */
function loadEpisodeTranscript(
  db: DatabaseSync,
  episode: EpisodeRow,
  mnemeId: string,
): EpisodeTranscript {
  const rows = listEpisodeMessages(db, episode.id);

  const payloadMessages: EpisodeMessagePayload[] = [];
  const prefilterMessages: PrefilterMessageSlice[] = [];
  const messageIds: string[] = [];

  for (const row of rows) {
    const m = getMessage(db, row.message_id);
    if (!m || m.deleted_at_ms !== null) continue; // deleted messages are not reviewed
    messageIds.push(m.id);

    const mentions = parseMentions(m.mentions_json);
    const isBot = m.author_id === null ? false : getUser(db, m.author_id)?.is_bot === 1;
    const reactions = getReactionCountsForMessage(db, m.id).map((r) => ({
      emoji: r.emojiKey,
      count: r.count,
    }));

    payloadMessages.push({
      ordinal: row.ordinal,
      id: m.id,
      author: {
        id: m.author_id,
        displayName: m.author_display_name,
        isBot: m.author_id === mnemeId ? true : isBot,
      },
      content: m.content,
      createdAtIso: new Date(m.created_at_ms).toISOString(),
      replyTo: m.reply_to_message_id,
      reactions,
      link: discordMessageLink(episode.workspace_id, m.channel_id, m.id),
    });

    prefilterMessages.push({
      id: m.id,
      content: m.content,
      author: { id: m.author_id ?? '', isBot: m.author_id === mnemeId ? true : isBot },
      mentions,
      reactionCounts: reactions,
    });
  }

  const memoryLinkedMessageIds = messageIdsLinkedToMemory(db, messageIds);

  return { payloadMessages, prefilterMessages, memoryLinkedMessageIds };
}

interface FollowupOptions {
  horizonDays: number;
  maxMessages: number;
}

/**
 * Load a small, time-bounded look-ahead in the same conversation. Discord work
 * is asynchronous: an answer, completion, or correction can arrive hours or
 * days after the 90-second episode boundary. Historical campaign reviews are
 * additionally capped at the campaign's immutable end time to prevent scope
 * drift when a campaign resumes later.
 */
function loadAsynchronousFollowups(
  db: DatabaseSync,
  episode: EpisodeRow,
  transcript: EpisodeTranscript,
  mnemeId: string,
  now: number,
  options: FollowupOptions,
): EpisodeMessagePayload[] {
  if (episode.ended_at_ms === null || options.maxMessages <= 0 || options.horizonDays <= 0) return [];
  const campaign = db.prepare(`
    SELECT c.to_at_ms
      FROM episodes e
      LEFT JOIN historical_memory_campaigns c ON c.id=e.historical_campaign_id
     WHERE e.id=?
  `).get(episode.id) as { to_at_ms: number | null } | undefined;
  const horizonEnd = episode.ended_at_ms + options.horizonDays * 86_400_000;
  const upperBound = Math.min(now, horizonEnd, campaign?.to_at_ms ?? Number.POSITIVE_INFINITY);
  if (upperBound <= episode.ended_at_ms) return [];

  const rows = db.prepare(`
    SELECT m.id,m.content,m.reply_to_message_id,m.created_at_ms
      FROM messages m
      LEFT JOIN users u ON u.id=m.author_id
     WHERE m.channel_id=? AND m.created_at_ms>? AND m.created_at_ms<=?
       AND m.deleted_at_ms IS NULL AND trim(m.content)<>''
       AND (m.author_id IS NULL OR (m.author_id<>? AND COALESCE(u.is_bot,0)=0))
     ORDER BY m.created_at_ms ASC, m.id ASC
     LIMIT ?
  `).all(
    episode.conversation_channel_id,
    episode.ended_at_ms,
    upperBound,
    mnemeId,
    500,
  ) as Array<{ id: string; content: string; reply_to_message_id: string | null; created_at_ms: number }>;

  const episodeIds = new Set(transcript.payloadMessages.map((message) => message.id));
  const episodeTerms = contentTerms(transcript.payloadMessages.map((message) => message.content).join(' '));
  const selected = rows
    .map((row, index) => ({ row, index, score: asynchronousFollowupScore(row, episodeIds, episodeTerms, episode.ended_at_ms!) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.min(100, Math.max(1, options.maxMessages)))
    .sort((a, b) => a.row.created_at_ms - b.row.created_at_ms || a.row.id.localeCompare(b.row.id))
    .map(({ row }) => row);

  return selected.flatMap((row, index) => {
    const message = getMessage(db, row.id);
    if (!message || message.deleted_at_ms !== null) return [];
    const author = message.author_id === null ? undefined : getUser(db, message.author_id);
    return [{
      ordinal: index + 1,
      id: message.id,
      author: {
        id: message.author_id,
        displayName: message.author_display_name,
        isBot: author?.is_bot === 1,
      },
      content: message.content,
      createdAtIso: new Date(message.created_at_ms).toISOString(),
      replyTo: message.reply_to_message_id,
      reactions: getReactionCountsForMessage(db, message.id).map((reaction) => ({
        emoji: reaction.emojiKey,
        count: reaction.count,
      })),
      link: discordMessageLink(episode.workspace_id, message.channel_id, message.id),
    }];
  });
}

const FOLLOWUP_CLOSURE_TERMS = /\b(done|fixed|resolved|completed|shipped|deployed|approved|updated|answered|closed|cancelled|canceled|unblocked)\b/i;
const FOLLOWUP_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'could', 'from', 'have',
  'into', 'just', 'should', 'that', 'their', 'there', 'these', 'they', 'this', 'those',
  'with', 'would', 'your', 'someone', 'please',
]);

function contentTerms(content: string): Set<string> {
  return new Set(content.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)
    ?.filter((term) => !FOLLOWUP_STOP_WORDS.has(term)) ?? []);
}

function asynchronousFollowupScore(
  row: { content: string; reply_to_message_id: string | null; created_at_ms: number },
  episodeIds: ReadonlySet<string>,
  episodeTerms: ReadonlySet<string>,
  endedAtMs: number,
): number {
  const terms = contentTerms(row.content);
  const overlap = [...terms].filter((term) => episodeTerms.has(term)).length;
  const directReply = row.reply_to_message_id !== null && episodeIds.has(row.reply_to_message_id) ? 100 : 0;
  const closure = FOLLOWUP_CLOSURE_TERMS.test(row.content) ? 20 : 0;
  const proximity = Math.max(0, 5 - (row.created_at_ms - endedAtMs) / 86_400_000);
  return directReply + closure + overlap * 5 + proximity;
}

function parseMentions(mentionsJson: string | null | undefined): { id: string }[] {
  if (!mentionsJson) return [];
  try {
    const parsed = JSON.parse(mentionsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is { id: string } => !!e && typeof (e as { id?: unknown }).id === 'string')
      .map((e) => ({ id: (e as { id: string }).id }));
  } catch {
    return [];
  }
}

/** Message ids among `ids` that are already cited by at least one memory (Section 11.4). */
function messageIdsLinkedToMemory(db: DatabaseSync, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const stmt = prepareCached(
    db,
    'memory_evidence.message_ids',
    'SELECT DISTINCT message_id FROM memory_evidence WHERE message_id = ?',
  );
  for (const id of ids) {
    const row = stmt.get(id) as { message_id?: string } | undefined;
    if (row?.message_id) out.add(row.message_id);
  }
  return out;
}

// ---- Prompt context ---------------------------------------------------------

function buildRenderContext(
  episode: EpisodeRow,
  transcript: EpisodeTranscript,
  followups: EpisodeMessagePayload[],
  scheduledFeedback: ScheduledFeedbackAssociation[],
  scope: ChannelScope,
  deps: ReviewEpisodeHandlerDeps,
  counters: EpisodeReviewRuntimeCounters,
  now: number,
): Record<string, unknown> {
  const episodePayload = {
    id: episode.id,
    channelId: episode.conversation_channel_id,
    startedAtIso: new Date(episode.started_at_ms).toISOString(),
    endedAtIso: episode.ended_at_ms === null ? null : new Date(episode.ended_at_ms).toISOString(),
    humanMessageCount: episode.human_message_count,
    totalMessageCount: episode.total_message_count,
    triggerReason: episode.trigger_reason,
    messages: transcript.payloadMessages,
  };
  return {
    episode: episodePayload,
    asynchronousFollowups: {
      horizonDays: deps.memoryFollowupHorizonDays ?? 14,
      maxMessages: deps.memoryFollowupMaxMessages ?? 20,
      messages: followups,
    },
    scheduledNotificationFeedback: scheduledFeedback,
    target: scope.target,
    runtime: {
      mode: typeof deps.mode === 'function' ? deps.mode() : deps.mode,
      recentChannelPosts: counters.recentChannelPosts,
      globalPostsToday: counters.globalPostsToday,
      nowIso: new Date(now).toISOString(),
    },
    policy: { interventionThreshold: deps.interventionThreshold },
  };
}
