// ABOUTME: Composes the Slack adapter into one ChatPlatform (spec Sections 5.3 and 6.7).
// ABOUTME: The read path only: Slack runs in observe mode, and every send fails closed until the write path exists.
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
import { createSlackRecentSentLookup } from './recent-sent.js';
import { createSlackSender } from './sender.js';
import { slackMessageLink } from './links.js';

/** Raised by every send while the Slack write path is not available. */
export class SlackWritePathUnavailableError extends Error {
  constructor() {
    super('Slack supports observe mode only; sending to Slack is not available');
    this.name = 'SlackWritePathUnavailableError';
  }
}

/** Startup checks for the read path. Each one fails startup with a clear message. */
export function assertSlackReadPathConfig(config: AppConfig): void {
  if (config.mode !== 'observe') {
    throw new Error('Slack supports observe mode until the write path is available; set MNEME_MODE=observe');
  }
  if (config.directAnswerEnabled) {
    throw new Error('Slack cannot answer mentions until the write path is available; set DIRECT_ANSWER_ENABLED=false');
  }
}

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
  assertSlackReadPathConfig(config);
  const workspaceId = config.workspaceId;
  const api = seams.api ?? createSlackApi(slack.botToken);
  let identity: SlackIdentity | undefined;
  let db: DatabaseSync | undefined;
  let liveDeps: LiveIngestionDeps | undefined;
  const connected = (): { identity: SlackIdentity; db: DatabaseSync; deps: LiveIngestionDeps } => {
    if (!identity || !db || !liveDeps) throw new Error('the Slack platform is not connected');
    return { identity, db, deps: liveDeps };
  };
  const unavailable = async (): Promise<never> => {
    throw new SlackWritePathUnavailableError();
  };
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
    registerCommandDispatch() {},
    registerReviewControls() {},

    listChannels: async () => listSlackChannels(api, connected().db, workspaceId),
    threadDiscovery: { mode: 'complete_snapshot', rediscoveryIntervalMs: SLACK_REDISCOVERY_INTERVAL_MS },
    history,
    recentSent: createSlackRecentSentLookup(api, () => connected().identity.selfUserId),

    sender: createSlackSender({ api, db: () => connected().db, teamDomain: () => connected().identity.teamDomain }),
    sendDirect: unavailable,
    deliverProposalReview: unavailable,
    reviewResolver: () => unavailable,
    createChannelPolicyReviewDeliveryHandler: () => unavailable,

    oauthIdentity: { identify: async () => ({ ok: false, reason: 'membership_unavailable' }) },
    format: slackFormat,
  };
}
