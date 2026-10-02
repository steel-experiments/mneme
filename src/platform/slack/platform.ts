// ABOUTME: Composes the Slack adapter into one ChatPlatform (spec Sections 5.3 and 6.7).
// ABOUTME: Read and write paths: ingestion, outbox delivery, review cards, the /mneme command, and DMs.
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import type { DatabaseSync } from '../../db/database.js';
import { upsertGuild } from '../../db/repositories/workspaces.js';
import type { LiveIngestionDeps } from '../../ingestion/live.js';
import type { Logger } from '../../logger.js';
import { useMessageLinkBuilder } from '../links.js';
import type { ChatPlatform, PlatformConnection } from '../types.js';
import { createSlackApi, type SlackApi } from './api.js';
import { checkSlackIdentity, type SlackIdentity } from './auth.js';
import { attachSocket, createSlackSocket, SlackHealthTracker, type SlackSocket } from './connection.js';
import { listSlackChannels, SLACK_REDISCOVERY_INTERVAL_MS } from './discovery.js';
import { handleSlackEnvelope, type SlackLiveContext } from './events.js';
import { slackFormat } from './format.js';
import { createSlackHistory } from './history.js';
import { handleSlackAction, type SlackActionDeps } from './actions.js';
import { handleSlackCommand, type SlackCommandDeps } from './commands.js';
import {
  buildSlackChannelPolicyCard,
  createSlackChannelPolicyPort,
  createSlackReviewResolver,
  deliverSlackProposalReview,
  type SlackCardDeps,
} from './cards.js';
import { createChannelPolicyReviewDeliveryHandler } from '../../review/controls.js';
import { createSlackResponder } from './respond.js';
import { createSlackRecentSentLookup } from './recent-sent.js';
import { escapeSlackText } from './mrkdwn.js';
import { createSlackSender } from './sender.js';
import { slackMessageLink } from './links.js';

/** Review-card HMAC secret derived from the bot token, as on Discord. */
export function slackReviewSecret(botToken: string): string {
  return createHash('sha256').update(botToken).update(':review-components').digest('hex');
}

export interface SlackPlatformSeams {
  api?: SlackApi;
  socket?: SlackSocket;
}

export function createSlackPlatform(
  config: AppConfig,
  logger: Logger,
  clock: () => number,
  seams: SlackPlatformSeams = {},
): ChatPlatform {
  const slack = config.slack;
  if (!slack) throw new Error('MNEME_PLATFORM=slack requires the Slack settings');
  const workspaceId = config.workspaceId;
  const api = seams.api ?? createSlackApi(slack.botToken);
  let identity: SlackIdentity | undefined;
  let db: DatabaseSync | undefined;
  let liveDeps: LiveIngestionDeps | undefined;
  const connected = (): { identity: SlackIdentity; db: DatabaseSync; deps: LiveIngestionDeps } => {
    if (!identity || !db || !liveDeps) throw new Error('the Slack platform is not connected');
    return { identity, db, deps: liveDeps };
  };
  const cardDeps: SlackCardDeps = {
    api,
    db: () => connected().db,
    teamDomain: () => connected().identity.teamDomain,
    selfUserId: () => connected().identity.selfUserId,
  };
  const respond = createSlackResponder(() => connected().identity.teamDomain, fetch, (err) => {
    logger.warn({ event: 'slack.respond_failed', err: err instanceof Error ? err.message : String(err) }, 'slack reply failed');
  });
  let actionDeps: SlackActionDeps | undefined;
  let commandDeps: SlackCommandDeps | undefined;
  let healthTracker: SlackHealthTracker | undefined;
  const history = createSlackHistory({
    api,
    workspaceId,
    selfUserId: () => connected().identity.selfUserId,
    db: () => connected().db,
    applyChannelPolicy: () => connected().deps.applyChannelPolicy,
    enqueueHistory: config.ingestion.fullHistory,
    now: clock,
    logger,
  });

  return {
    id: 'slack',
    workspaceId,
    get selfUserId(): string {
      return connected().identity.selfUserId;
    },
    reviewSecret: slackReviewSecret(slack.botToken),
    hasCredentials: true,

    async connect(ingestion): Promise<PlatformConnection> {
      identity = checkSlackIdentity(await api.authTest(), workspaceId);
      const teamDomain = identity.teamDomain;
      useMessageLinkBuilder((_workspace, channelId, messageId) => slackMessageLink(teamDomain, channelId, messageId));
      db = ingestion.db;
      liveDeps = ingestion;
      // Seed the workspace row before events arrive so message foreign keys hold.
      const now = clock();
      upsertGuild(ingestion.db, {
        id: workspaceId, name: config.organization.name, ownerId: null, joinedAtMs: null,
        discoveredAtMs: now, updatedAtMs: now, rawJson: null,
      });
      const tracker = new SlackHealthTracker(clock);
      healthTracker = tracker;
      const socket = seams.socket ?? createSlackSocket(slack.appToken);
      const ctx: SlackLiveContext = {
        workspaceId,
        selfUserId: identity.selfUserId,
        api,
        deps: ingestion,
        enqueueHistory: config.ingestion.fullHistory,
        seenSubtypes: new Set(),
      };
      attachSocket(socket, tracker, async (envelope) => {
        if (envelope.type === 'interactive') {
          if (actionDeps) await handleSlackAction(actionDeps, envelope);
          return;
        }
        if (envelope.type === 'slash_commands') {
          if (commandDeps) await handleSlackCommand(commandDeps, envelope);
          return;
        }
        await handleSlackEnvelope(ctx, envelope);
      }, (err) => {
        logger.warn({ event: 'slack.event_failed', err: err instanceof Error ? err.message : String(err) }, 'slack event failed');
      });
      await socket.start();
      return {
        tracker,
        destroy: async () => {
          try {
            await socket.disconnect();
          } catch (err) {
            logger.warn({ event: 'slack.destroy_failed', err: (err as Error).message }, 'slack disconnect failed');
          }
        },
      };
    },

    async registerCommands() {
      return { ok: true };
    },
    registerCommandDispatch(deps) {
      commandDeps = {
        workspaceId,
        routes: {
          ctx: deps.ctx,
          buildApprovalRecheck: deps.buildApprovalRecheck,
          tracker: { snapshot: () => healthTracker?.snapshot() ?? {} },
          resolveReview: deps.ctx.config.reviewChannelId ? createSlackReviewResolver(api) : undefined,
        },
        adminUserIds: slack.adminUserIds,
        respond,
        logger,
      };
    },
    registerReviewControls(deps) {
      actionDeps = {
        db: deps.db,
        workspaceId: deps.workspaceId,
        secret: deps.secret,
        adminUserIds: slack.adminUserIds,
        reviewChannelId: deps.reviewChannelId,
        buildRecheck: deps.buildRecheck,
        policy: deps.policy,
        channelPolicySource: deps.channelPolicySource,
        resolveReview: deps.reviewChannelId ? createSlackReviewResolver(api) : undefined,
        channelPolicyPort: deps.reviewChannelId ? createSlackChannelPolicyPort(cardDeps) : undefined,
        respond,
        now: deps.now,
      };
    },

    listChannels: async () => listSlackChannels(api, connected().db, workspaceId),
    threadDiscovery: { mode: 'complete_snapshot', rediscoveryIntervalMs: SLACK_REDISCOVERY_INTERVAL_MS },
    history,
    recentSent: createSlackRecentSentLookup(api, () => connected().identity.selfUserId, () => connected().db),

    sender: createSlackSender({ api, db: () => connected().db, teamDomain: () => connected().identity.teamDomain }),
    async sendDirect(userId, text) {
      // A post to a user id opens the bot's DM with that user (`im:write`).
      await api.postMessage({ channel: userId, text: escapeSlackText(text) });
    },
    deliverProposalReview: async (input, deps) => deliverSlackProposalReview(input, deps, cardDeps),
    reviewResolver: () => createSlackReviewResolver(api),
    createChannelPolicyReviewDeliveryHandler: (deps) => createChannelPolicyReviewDeliveryHandler({
      ...deps,
      port: createSlackChannelPolicyPort(cardDeps),
      build: buildSlackChannelPolicyCard,
    }),

    oauthIdentity: { identify: async () => ({ ok: false, reason: 'membership_unavailable' }) },
    format: slackFormat,
  };
}
