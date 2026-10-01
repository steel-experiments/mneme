// ABOUTME: Selects the chat-platform adapter for this deployment from MNEME_PLATFORM.
// ABOUTME: The only core module that imports a platform adapter.
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { createDiscordPlatform } from './discord/platform.js';
import type { ChatPlatform } from './types.js';

export function createPlatform(config: AppConfig, logger: Logger, clock: () => number): ChatPlatform {
  switch (config.platform) {
    case 'discord':
      return createDiscordPlatform(config, logger, clock);
  }
}
