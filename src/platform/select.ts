// ABOUTME: Selects the chat-platform adapter for this deployment from MNEME_PLATFORM.
// ABOUTME: The only core module that imports a platform adapter.
import type { AppConfig, PlatformId } from '../config.js';
import type { Logger } from '../logger.js';
import { discordFormat } from './discord/format.js';
import { createDiscordPlatform } from './discord/platform.js';
import { slackFormat } from './slack/format.js';
import { createSlackPlatform } from './slack/platform.js';
import type { ChatPlatform, PlatformFormat } from './types.js';

export function createPlatform(config: AppConfig, logger: Logger, clock: () => number): ChatPlatform {
  switch (config.platform) {
    case 'discord':
      return createDiscordPlatform(config, logger, clock);
    case 'slack':
      return createSlackPlatform(config, logger, clock);
  }
}

/** Text conventions of a platform; the same object the platform exposes as `format`. */
export function platformFormat(id: PlatformId): PlatformFormat {
  switch (id) {
    case 'discord':
      return discordFormat;
    case 'slack':
      return slackFormat;
  }
}
