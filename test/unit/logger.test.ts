import { describe, it, expect } from 'vitest';
import { createLogger, REDACT_CENSOR } from '../../src/logger.js';

function capture(): { chunks: string[]; stream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  const stream = {
    write(s: string) {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { chunks, stream };
}

describe('logger', () => {
  it('redacts credentials, content, prompts, and nested secrets', () => {
    const { chunks, stream } = capture();
    const log = createLogger({ stream, level: 'info' });

    log.info(
      {
        event: 'discord.message_ingested',
        token: 'super-secret-discord-token',
        authorization: 'Bearer abc123',
        content: 'a private message body',
        prompt: 'system prompt contents',
        OPENAI_API_KEY: 'sk-leaked-key',
        nested: { apiKey: 'sk-nested', body: 'secret body' },
      },
      'event',
    );

    const out = chunks.join('');
    const parsed = JSON.parse(out);

    expect(parsed.event).toBe('discord.message_ingested');
    expect(parsed.level).toBe('info');
    expect(parsed.token).toBe(REDACT_CENSOR);
    expect(parsed.authorization).toBe(REDACT_CENSOR);
    expect(parsed.content).toBe(REDACT_CENSOR);
    expect(parsed.prompt).toBe(REDACT_CENSOR);
    expect(parsed.OPENAI_API_KEY).toBe(REDACT_CENSOR);
    expect(parsed.nested.apiKey).toBe(REDACT_CENSOR);
    expect(parsed.nested.body).toBe(REDACT_CENSOR);

    // The sensitive values never appear anywhere in the serialized output.
    expect(out).not.toContain('super-secret-discord-token');
    expect(out).not.toContain('Bearer abc123');
    expect(out).not.toContain('a private message body');
    expect(out).not.toContain('system prompt contents');
    expect(out).not.toContain('sk-leaked-key');
    expect(out).not.toContain('sk-nested');
  });

  it('redacts Slack tokens in env objects and config dumps', () => {
    const { chunks, stream } = capture();
    const log = createLogger({ stream, level: 'info' });
    log.info({
      event: 'config.loaded',
      SLACK_BOT_TOKEN: 'xoxb-leaked-bot',
      SLACK_APP_TOKEN: 'xapp-leaked-app',
      env: { SLACK_BOT_TOKEN: 'xoxb-nested-bot', SLACK_APP_TOKEN: 'xapp-nested-app' },
      slack: { botToken: 'xoxb-config-bot', appToken: 'xapp-config-app' },
    }, 'event');
    const out = chunks.join('');
    for (const leaked of ['xoxb-leaked-bot', 'xapp-leaked-app', 'xoxb-nested-bot', 'xapp-nested-app', 'xoxb-config-bot', 'xapp-config-app']) {
      expect(out).not.toContain(leaked);
    }
  });

  it('redacts the OAuth provider secret in a full config dump', () => {
    const { chunks, stream } = capture();
    const log = createLogger({ stream, level: 'info' });
    log.info({ event: 'config.loaded', config: { mcp: { oauthProviderClientSecret: 'leaked-provider-secret' } } }, 'event');
    expect(chunks.join('')).not.toContain('leaked-provider-secret');
  });

  it('redacts MCP OAuth provider secrets and access tokens', () => {
    const { chunks, stream } = capture();
    const log = createLogger({ stream, level: 'info' });
    log.info({
      event: 'config.loaded',
      DISCORD_OAUTH_CLIENT_SECRET: 'discord-oauth-leaked',
      SLACK_OAUTH_CLIENT_SECRET: 'slack-oauth-leaked',
      env: { DISCORD_OAUTH_CLIENT_SECRET: 'discord-oauth-nested', SLACK_OAUTH_CLIENT_SECRET: 'slack-oauth-nested' },
      mcp: { oauthProviderClientSecret: 'provider-secret-config' },
      identity: { clientSecret: 'client-secret-config', accessToken: 'access-token-camel', access_token: 'access-token-snake' },
    }, 'event');
    const out = chunks.join('');
    for (const leaked of ['discord-oauth-leaked', 'slack-oauth-leaked', 'discord-oauth-nested', 'slack-oauth-nested',
      'provider-secret-config', 'client-secret-config', 'access-token-camel', 'access-token-snake']) {
      expect(out).not.toContain(leaked);
    }
  });

  it('retains ids, counts, statuses, durations, and error categories', () => {
    const { chunks, stream } = capture();
    const log = createLogger({ stream, level: 'info' });
    log.info(
      {
        event: 'job.completed',
        guildId: '123',
        channelId: '456',
        jobId: 'j-1',
        count: 42,
        status: 'succeeded',
        latencyMs: 12,
        errorCategory: 'timeout',
      },
      'done',
    );
    const parsed = JSON.parse(chunks.join(''));
    expect(parsed.guildId).toBe('123');
    expect(parsed.count).toBe(42);
    expect(parsed.latencyMs).toBe(12);
    expect(parsed.errorCategory).toBe('timeout');
  });

  it('respects the configured level', () => {
    const { chunks, stream } = capture();
    const log = createLogger({ stream, level: 'warn' });
    log.info({ event: 'should.be.skipped' }, 'nope');
    log.warn({ event: 'should.appear' }, 'yes');
    expect(chunks.join('')).not.toContain('should.be.skipped');
    expect(chunks.join('')).toContain('should.appear');
  });

  it('serializes warn and error levels as strings for log platforms', () => {
    const { chunks, stream } = capture();
    const log = createLogger({ stream, level: 'debug' });
    log.warn({ event: 'warn-case' }, 'warn');
    log.error({ event: 'error-case' }, 'error');
    const records = chunks.map((chunk) => JSON.parse(chunk) as { level: string; event: string });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'warn-case', level: 'warn' }),
      expect.objectContaining({ event: 'error-case', level: 'error' }),
    ]));
  });
});
