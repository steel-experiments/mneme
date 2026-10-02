// ABOUTME: Tests the Slack platform startup checks and connection identity (plan 006 steps 2 and 6).
// ABOUTME: Slack starts only in observe mode with direct answers off; a foreign team token stops startup.
import { describe, it, expect } from 'vitest';
import { createSlackPlatform, SlackWritePathUnavailableError } from '../../../src/platform/slack/platform.js';
import { SLACK_REDISCOVERY_INTERVAL_MS } from '../../../src/platform/slack/discovery.js';
import { createLogger } from '../../../src/logger.js';
import { createTestDb } from '../../helpers/db.js';
import { fakeSlackApi, slackTestConfig } from '../../helpers/slack.js';
import { messageLink, useMessageLinkBuilder, discordMessageLink } from '../../../src/platform/links.js';
import type { LiveIngestionDeps } from '../../../src/ingestion/live.js';

const logger = createLogger({ level: 'silent' });
const socket = { on: () => undefined, start: async () => undefined, disconnect: async () => undefined };

describe('Slack platform', () => {
  it('refuses a mode other than observe', () => {
    expect(() => createSlackPlatform(slackTestConfig({ MNEME_MODE: 'review', MNEME_REVIEW_CHANNEL_ID: 'C0000000009' }), logger, () => 1))
      .toThrow(/observe mode/);
  });

  it('refuses direct answers until the write path exists', () => {
    expect(() => createSlackPlatform(slackTestConfig({ DIRECT_ANSWER_ENABLED: 'true' }), logger, () => 1))
      .toThrow(/DIRECT_ANSWER_ENABLED=false/);
  });

  it('stops startup for a token from another workspace', async () => {
    const api = fakeSlackApi();
    api.authTest = async () => ({ teamId: 'T0000000099', userId: 'U0000000002', url: 'https://other.slack.com/' });
    const platform = createSlackPlatform(slackTestConfig(), logger, () => 1, { api, socket });
    const t = createTestDb();
    try {
      await expect(platform.connect({ db: t.db, opts: {} as LiveIngestionDeps['opts'] })).rejects.toThrow(/different workspace/);
      expect(() => platform.selfUserId).toThrow(/not connected/);
    } finally {
      t.cleanup();
    }
  });

  it('connects, learns its bot id, selects Slack links, and fails every send closed', async () => {
    const platform = createSlackPlatform(slackTestConfig(), logger, () => 1, { api: fakeSlackApi(), socket });
    const t = createTestDb();
    try {
      const connection = await platform.connect({ db: t.db, opts: {} as LiveIngestionDeps['opts'] });
      expect(platform.selfUserId).toBe('U0000000002');
      expect(messageLink('T0000000001', 'C0000000001', 'C0000000001-1790933741.610379'))
        .toBe('https://acme.slack.com/archives/C0000000001/p1790933741610379');
      await expect(platform.sender.send({ channelId: 'C0000000001', content: 'x' })).rejects.toBeInstanceOf(SlackWritePathUnavailableError);
      expect(platform.threadDiscovery).toEqual({ mode: 'complete_snapshot', rediscoveryIntervalMs: SLACK_REDISCOVERY_INTERVAL_MS });
      expect(SLACK_REDISCOVERY_INTERVAL_MS).toBe(15 * 60_000);
      await connection.destroy();
    } finally {
      useMessageLinkBuilder(discordMessageLink);
      t.cleanup();
    }
  });
});
