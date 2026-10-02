// ABOUTME: Tests that the outbound sanitizer rejects model-authored Slack links and mentions on Slack.
// ABOUTME: Discord behavior is unchanged: the Slack link rule runs only with the Slack format.
import { describe, it, expect } from 'vitest';
import { containsSlackLink, sanitizeOutboundMessage } from '../../../src/outbound/message-safety.js';
import { slackFormat } from '../../../src/platform/slack/format.js';
import { discordFormat } from '../../../src/platform/discord/format.js';

const sanitize = (content: string, format = slackFormat) => sanitizeOutboundMessage({ content, guildId: 'T0000000001', format });

describe('Slack outbound sanitizer', () => {
  it.each([
    'See https://acme.slack.com/archives/C0123ABCD/p1712345678000100',
    'See [here](https://acme.slack.com/archives/C0123ABCD/p1712345678000100)',
    'See //app.slack.com/client/T0000000001',
    'Open slack://channel?team=T1&id=C1',
    'See https://acme&period;slack&period;com/archives/C1/p1',
    'See https://acme.slack%2ecom/archives/C1/p1',
    'See https://files.slack-edge.com/x',
    'See HTTPS://ACME.SLACK.COM/archives/C1/p1',
  ])('rejects a model-authored Slack link: %s', (content) => {
    expect(containsSlackLink(content)).toBe(true);
    expect(sanitize(content).outcome).toBe('reject');
  });

  it.each([
    'We use Slack for chat.',
    'Read https://example.com/slack.comments',
    'slackware.com is not Slack',
  ])('allows ordinary text: %s', (content) => {
    expect(containsSlackLink(content)).toBe(false);
    expect(sanitize(content).outcome).toBe('allow');
  });

  it.each(['<@U0123ABCDE> look', '<!here> update', '<!channel>', '<!everyone>', '<!subteam^S0123ABCD>'])(
    'rejects Slack mention syntax: %s',
    (content) => {
      expect(sanitize(content).outcome).toBe('reject');
    },
  );

  it('does not apply the Slack link rule on Discord', () => {
    expect(sanitize('See https://acme.slack.com/archives/C0123ABCD/p1712345678000100', discordFormat).outcome).toBe('allow');
  });
});
