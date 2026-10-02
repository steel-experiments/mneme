// ABOUTME: Builds the platform-neutral live ingestion hooks that every chat-platform adapter calls.
// ABOUTME: Holds the policy, episode, direct-mention, and recovery logic for live events (Section 9.3).
import type { BootstrapContext } from '../bootstrap.js';
import type { DatabaseSync } from '../db/database.js';
import { getChannel, type ChannelUpsertInput } from '../db/repositories/channels.js';
import { requestIngestionRecovery } from '../db/repositories/ingestion-recovery.js';
import { ingestEpisodeActivity } from '../episodes/builder.js';
import { enqueue } from '../jobs/queue.js';
import type { Logger } from '../logger.js';
import { createIngestionObserver, type IngestionObserver } from '../observability.js';
import type { NormalizedMessage } from '../platform/types.js';
import { reconcileStoredChannelPolicyReview, resolveObservedChannelPolicy } from '../policy/channel-policy-review-service.js';
import type { IngestOptions } from './ingest.js';
import { enqueueDirectAnswerForMention, mentionsMneme } from './mentions.js';
import { isMnemeTestSurface } from './test-channels.js';

/** Hooks a platform adapter calls while it persists live events. */
export interface LiveIngestionDeps {
  db: DatabaseSync;
  /** Event-time options. A factory avoids freezing observation timestamps at startup. */
  opts: IngestOptions | (() => IngestOptions);
  /** Fail-closed policy hook evaluated before a new message is persisted. */
  shouldIngestMessage?: (channelId: string, message: NormalizedMessage) => boolean;
  /** Called only after a new message was successfully persisted. */
  onMessageCreate?: (message: NormalizedMessage) => void;
  /** Apply the channel policy to adapter-built channel metadata before it is stored. */
  applyChannelPolicy?: (input: ChannelUpsertInput) => ChannelUpsertInput;
  /** Called after a channel/thread mutation has committed; must not perform inline network I/O. */
  onChannelChange?: (event: 'create' | 'update' | 'delete', channelId: string) => void;
  /** Queue an id-only recovery after a known-workspace dependency arrives out of order. */
  onMissingDependency?: (input: { reason: 'missing_channel' | 'missing_message'; channelId: string; messageId: string }) =>
    { recoveryId: string; generation: number } | void;
  /** Content-free outcome counter owner. */
  observer?: IngestionObserver;
  /** Optional logger for handler errors. */
  logger?: Pick<Logger, 'debug' | 'info' | 'warn'>;
}

/** Build the production live-ingestion hooks for one deployment. */
export function createLiveIngestionDeps(ctx: BootstrapContext, self: string | (() => string)): LiveIngestionDeps {
  const ing = ctx.config.ingestion;
  // An adapter can learn its own bot id only while it connects, so the id is read at event time.
  const selfId = typeof self === 'function' ? self : () => self;
  return {
    db: ctx.db,
    opts: () => ({
      guildId: ctx.config.workspaceId,
      storeRawJson: ing.storeRawJson,
      retainEditHistory: ing.retainEditHistory,
      retainDeletedContent: ing.retainDeletedContent,
      attachmentMode: ing.attachmentMode,
      attachmentArchive: ing.attachmentMode === 'archive' || ing.attachmentMode === 'selective' ? {
        mode: ing.attachmentMode,
        maxBytes: ing.attachmentMaxBytes,
        mimeAllowlist: ing.attachmentMimeAllowlist,
        dataDir: ctx.config.dataDir,
      } : undefined,
      now: ctx.now(),
    }),
    shouldIngestMessage: (channelId, message) => {
      const isDirectMention = mentionsMneme(message.mentions, selfId());
      const channel = getChannel(ctx.db, channelId);
      if (channel) {
        if (isMnemeTestSurface(ctx.db, channelId)) {
          if (isDirectMention) {
            ctx.logger.info({ event: 'discord.direct_mention_received', channelId, testOnly: true }, 'direct mention accepted in test-only channel');
          }
          return isDirectMention;
        }
        if (isDirectMention) {
          ctx.logger.info({ event: 'discord.direct_mention_received', channelId, testOnly: false }, 'direct mention accepted');
        }
        return channel.ingest_enabled === 1 && channel.visibility_class !== 'excluded';
      }
      const policy = ctx.configStore?.get().channelPolicy ?? ctx.snapshot?.channelPolicy;
      const explicit = policy?.channels.get(channelId);
      const rule = explicit ?? policy?.default;
      return rule ? rule.ingest && rule.visibility !== 'excluded' : false;
    },
    onMissingDependency: ({ reason, channelId, messageId }) => {
      const now = ctx.now();
      const recovery = requestIngestionRecovery(ctx.db, {
        guildId: ctx.config.workspaceId, channelId, messageId, reason, now,
      });
      enqueue(ctx.db, {
        type: 'recover_message', payload: { recoveryId: recovery.id, generation: recovery.generation },
        uniqueKey: `recover-message:${recovery.id}`, priority: 20, now,
      });
      return { recoveryId: recovery.id, generation: recovery.generation };
    },
    observer: createIngestionObserver(ctx.counters),
    onMessageCreate: (message) => {
      const observedAt = ctx.now();
      if (!isMnemeTestSurface(ctx.db, message.channelId)) {
        ingestEpisodeActivity(
          message,
          { mnemeId: selfId() },
          {
            db: ctx.db,
            guildId: ctx.config.workspaceId,
            now: observedAt,
            timing: {
              quietSeconds: ctx.config.episodes.quietSeconds,
              maxMessages: ctx.config.episodes.maxMessages,
              maxMinutes: ctx.config.episodes.maxMinutes,
            },
          },
        );
      }
      const direct = enqueueDirectAnswerForMention(message, {
        db: ctx.db,
        mnemeId: selfId(),
        enabled: ctx.config.directAnswerEnabled,
        now: observedAt,
      });
      if (direct.mention) {
        ctx.logger.info({ event: 'discord.direct_answer_queued', channelId: message.channelId,
          messageId: message.id, enqueued: direct.enqueued }, 'direct-answer scheduling evaluated');
      }
    },
    applyChannelPolicy: (input) => {
      const policy = ctx.configStore?.get().channelPolicy ?? ctx.snapshot?.channelPolicy;
      if (!policy) return { ...input, ingestEnabled: false, visibilityClass: 'excluded', allowInterventions: false };
      const resolved = resolveObservedChannelPolicy(ctx.db, policy, {
        id: input.id,
        guildId: input.guildId,
        parentId: input.parentId,
        isThread: input.isThread,
        kind: input.kind,
        platformBoundary: input.platformBoundary,
        isPrivateThread: input.isPrivateThread,
      }, { channelPolicySource: ctx.config.channelPolicySource });
      const existing = getChannel(ctx.db, input.id);
      return {
        ...input,
        ingestEnabled: resolved.rule.ingest,
        visibilityClass: resolved.rule.visibility,
        allowInterventions: resolved.rule.allow_interventions,
        permissionFingerprint: existing?.permission_fingerprint ?? null,
      };
    },
    onChannelChange: (event, channelId) => {
      const config = ctx.configStore?.get();
      const policy = config?.channelPolicy ?? ctx.snapshot?.channelPolicy;
      if (!policy) return;
      const result = reconcileStoredChannelPolicyReview(
        ctx.db,
        policy,
        channelId,
        ctx.now(),
        {
          ...(event === 'delete' ? { deleted: true } : event === 'create' ? { forceReview: true } : {}),
          channelPolicySource: config?.channelPolicySource,
        },
      );
      if (result.created || result.superseded || result.enqueued) {
        ctx.logger.info({
          event: 'channel_policy_review.reconciled',
          channelId,
          created: result.created,
          superseded: result.superseded,
          enqueued: result.enqueued,
        }, 'channel policy review reconciled');
      }
    },
    logger: ctx.logger,
  };
}
