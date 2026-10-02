import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Redaction paths for the structured logger (Section 33, 43.4, 44).
 *
 * The logger must never emit message content, prompt bodies, API keys, Discord
 * tokens, authorization headers, or other environment-held secrets. Pino's
 * built-in redaction covers the realistic shapes we log (top-level keys and one
 * level of nesting). The complement is discipline: never pass raw content or
 * secrets into log calls in the first place.
 */
export const REDACT_PATHS = [
  // Credentials and authorization material.
  'token',
  'authorization',
  'Authorization',
  'apiKey',
  'api_key',
  'password',
  'secret',
  'cookie',
  'credentials',
  'botToken',
  'appToken',
  'clientSecret',
  'accessToken',
  'access_token',
  'oauthProviderClientSecret',
  '*.token',
  '*.authorization',
  '*.Authorization',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.cookie',
  '*.credentials',
  '*.botToken',
  '*.appToken',
  '*.clientSecret',
  '*.accessToken',
  '*.access_token',
  '*.oauthProviderClientSecret',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  // Known environment-held secrets (env objects, config dumps).
  'DISCORD_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'HTTP_ADMIN_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'DISCORD_OAUTH_CLIENT_SECRET',
  'SLACK_OAUTH_CLIENT_SECRET',
  '*.DISCORD_TOKEN',
  '*.OPENAI_API_KEY',
  '*.ANTHROPIC_API_KEY',
  '*.GOOGLE_API_KEY',
  '*.HTTP_ADMIN_TOKEN',
  '*.SLACK_BOT_TOKEN',
  '*.SLACK_APP_TOKEN',
  '*.DISCORD_OAUTH_CLIENT_SECRET',
  '*.SLACK_OAUTH_CLIENT_SECRET',
  // Content that must never be logged.
  'content',
  'prompt',
  'prompts',
  'message',
  'messages',
  'body',
  'statement',
  '*.content',
  '*.prompt',
  '*.prompts',
  '*.message',
  '*.messages',
  '*.body',
  '*.statement',
  'embeds',
  '*.embeds',
  'raw_json',
  '*.raw_json',
] as const;

export const REDACT_CENSOR = '[REDACTED]';

export interface CreateLoggerOptions {
  /** Minimum log level (default: LOG_LEVEL env, then "info"). */
  level?: string;
  /** Output stream; defaults to stdout (fd 1). */
  stream?: NodeJS.WritableStream;
  /** Logger name included on every record. */
  name?: string;
  /** Base fields merged onto every record. */
  base?: Record<string, unknown>;
}

/**
 * Build a Pino JSON logger with mandatory redaction configured.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const config: LoggerOptions = {
    name: options.name ?? 'mneme',
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACT_CENSOR,
      remove: false,
    },
    formatters: {
      // Keep Pino's numeric filtering internally while making the wire field
      // unambiguous to log platforms and humans.
      level: (label) => ({ level: label }),
    },
  };
  if (options.base !== undefined) {
    config.base = options.base;
  }
  return pino(config, options.stream ?? pino.destination(1));
}

export type { Logger } from 'pino';
