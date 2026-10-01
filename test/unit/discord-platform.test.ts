// ABOUTME: Tests the Discord ChatPlatform composition without a live Gateway connection.
// ABOUTME: Covers the review secret, platform selection, normalization, and the connect guard.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPlatform } from '../../src/platform/select.js';
import { createDiscordPlatform, discordReviewSecret } from '../../src/platform/discord/platform.js';
import { normalizeMessage } from '../../src/platform/discord/normalize.js';
import { rawMessage } from '../helpers/messages.js';

const TOKEN = 'a-real-discord-token-value';

function config() {
  return loadConfig({
    yamlText: '',
    env: {
      MNEME_PLATFORM: 'discord',
      DISCORD_TOKEN: TOKEN,
      DISCORD_APPLICATION_ID: '123456789012345678',
      DISCORD_GUILD_ID: '234567890123456789',
      OPENAI_API_KEY: 'sk-test-key-value',
      ORG_NAME: 'Test Org',
      ORG_TIMEZONE: 'UTC',
      FULL_HISTORY: 'true',
    },
  });
}

const logger = createLogger({ level: 'silent' });

describe('Discord ChatPlatform', () => {
  it('keeps the review-card secret derivation unchanged', () => {
    const expected = createHash('sha256').update(TOKEN).update(':review-components').digest('hex');
    expect(discordReviewSecret(TOKEN)).toBe(expected);
    expect(createDiscordPlatform(config(), logger, () => 0).reviewSecret).toBe(expected);
  });

  it('is the platform that MNEME_PLATFORM=discord selects', () => {
    const platform = createPlatform(config(), logger, () => 0);
    expect(platform.id).toBe('discord');
    expect(platform.workspaceId).toBe('234567890123456789');
    expect(platform.selfUserId).toBe('123456789012345678');
    expect(platform.hasCredentials).toBe(true);
    expect(platform.threadDiscovery.mode).toBe('archive_scan');
  });

  it('normalizes history pages with the Discord normalizer', () => {
    const platform = createDiscordPlatform(config(), logger, () => 0);
    const raw = rawMessage();
    expect(platform.history.normalize(raw)).toEqual(normalizeMessage(raw));
  });

  it('refuses platform calls before connect', async () => {
    const platform = createDiscordPlatform(config(), logger, () => 0);
    await expect(platform.listChannels()).rejects.toThrow('the Discord platform is not connected');
    await expect(platform.sender.send({ channelId: '1', content: 'x' })).rejects.toThrow('the Discord platform is not connected');
    await expect(platform.registerCommands()).resolves.toEqual({
      ok: false, message: 'Discord client has no REST adapter; commands cannot be registered',
    });
  });
});
