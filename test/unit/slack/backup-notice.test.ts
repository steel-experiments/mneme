// ABOUTME: Tests the backup-completed DM wording per platform and its Slack delivery.
// ABOUTME: Discord keeps its text; Slack names Slack and carries no mention token.
import { describe, it, expect } from 'vitest';
import { backupCompletedNotice } from '../../../src/production-runtime.js';
import { createSlackPlatform } from '../../../src/platform/slack/platform.js';
import { createLogger } from '../../../src/logger.js';
import { createTestDb } from '../../helpers/db.js';
import { fakeSlackApi, slackTestConfig } from '../../helpers/slack.js';
import { discordMessageLink, useMessageLinkBuilder } from '../../../src/platform/links.js';
import type { LiveIngestionDeps } from '../../../src/ingestion/live.js';

describe('backup completed notice', () => {
  it('keeps the Discord wording', () => {
    expect(backupCompletedNotice('discord', 'mneme-1.sqlite', 10)).toBe(
      "Mneme backup completed: mneme-1.sqlite (10 bytes), integrity_check: ok.\n\n"
      + "Mneme doesn't answer questions in DMs. Ask me in the Discord server by mentioning @Mneme in a channel I can access.",
    );
  });

  it('names Slack on Slack', () => {
    const text = backupCompletedNotice('slack', 'mneme-1.sqlite', 10);
    expect(text).toContain('Ask me in a Slack channel');
    expect(text).not.toContain('Discord');
  });

  it('sends the notice as an escaped DM to the user id', async () => {
    const api = fakeSlackApi();
    const socket = { on: () => undefined, start: async () => undefined, disconnect: async () => undefined };
    const platform = createSlackPlatform(slackTestConfig(), createLogger({ level: 'silent' }), () => 1, { api, socket });
    const t = createTestDb();
    try {
      const connection = await platform.connect({ db: t.db, opts: {} as LiveIngestionDeps['opts'] });
      await platform.sendDirect('U0000000001', `${backupCompletedNotice('slack', 'f.sqlite', 1)} <!here>`);
      expect(api.posted[0]?.channel).toBe('U0000000001');
      expect(api.posted[0]?.text).not.toMatch(/<[!@#]/);
      await connection.destroy();
    } finally {
      useMessageLinkBuilder(discordMessageLink);
      t.cleanup();
    }
  });
});
