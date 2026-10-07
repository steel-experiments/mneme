// ABOUTME: Tests the Markdown-to-mrkdwn converter, a trust boundary for every outbound Slack string.
// ABOUTME: Hostile input must never produce a mention token or a link that the host did not build.
import { describe, it, expect } from 'vitest';
import { escapeSlackText, isHostBuiltSlackLink, toSlackMrkdwn } from '../../../src/platform/slack/mrkdwn.js';
import { SCHEDULED_NOTIFICATION_FOOTER } from '../../../src/outbound/message-safety.js';

const DOMAIN = 'acme';
const LINK = 'https://acme.slack.com/archives/C0123ABCD/p1712345678000100';
const REPLY_LINK = 'https://acme.slack.com/archives/C0123ABCD/p1712345679000200?thread_ts=1712345678.000100&cid=C0123ABCD';
const convert = (text: string): string => toSlackMrkdwn(text, { teamDomain: DOMAIN });

/** Any Slack control token other than the allowed date form. */
const MENTION_TOKEN = /<[!@#](?!date\^)/;
/** Every Slack link in the output. */
const linksIn = (out: string): string[] => [...out.matchAll(/<(https?:[^|>]+)\|[^>]*>/g)].map((m) => m[1]!);

describe('toSlackMrkdwn constructs', () => {
  it.each([
    ['plain text', 'Decision recorded.', 'Decision recorded.'],
    ['bold', 'This is **important**.', 'This is *important*.'],
    ['star italic', 'This is *soft*.', 'This is _soft_.'],
    ['underscore italic', 'This is _soft_.', 'This is _soft_.'],
    ['quote', '> quoted line\nnext', '> quoted line\nnext'],
    ['empty quote line', '>\n> text', '>\n> text'],
    ['bold inside a quote', '> **bold** in quote', '> *bold* in quote'],
    ['inline code keeps stars', 'Run `a*b*c` now', 'Run `a*b*c` now'],
    ['inline code escapes angle brackets', 'Use `<@U0123ABCDE>` here', 'Use `&lt;@U0123ABCDE&gt;` here'],
    ['fenced code', '```\n**x** <y>\n```', '```\n**x** &lt;y&gt;\n```'],
    ['ampersand', 'R&D', 'R&amp;D'],
  ])('%s', (_name, input, expected) => {
    expect(convert(input)).toBe(expected);
  });

  it('turns a host-built link into a Slack link', () => {
    expect(convert(`See [#product · 2026-10-01](${LINK}).`)).toBe(`See <${LINK}|#product · 2026-10-01>.`);
  });

  it('keeps a host-built thread reply link', () => {
    expect(convert(`[reply](${REPLY_LINK})`)).toBe(`<${REPLY_LINK}|reply>`);
  });

  it('converts a link inside bold', () => {
    expect(convert(`**see [src](${LINK})**`)).toBe(`*see <${LINK}|src>*`);
  });

  it('renders a direct answer with three inline citations', () => {
    const answer = `We chose Postgres [a](${LINK}), then SQLite [b](${REPLY_LINK}), and kept it [c](${LINK}).`;
    const out = convert(answer);
    expect(linksIn(out)).toEqual([LINK, REPLY_LINK, LINK]);
    expect(out).not.toMatch(MENTION_TOKEN);
  });

  it('renders an intervention with a Sources line', () => {
    const out = convert(`The launch date moved.\n\nSources: [#eng · 2026-09-30](${LINK}) · [#eng · 2026-10-01](${REPLY_LINK})`);
    expect(out).toBe(`The launch date moved.\n\nSources: <${LINK}|#eng · 2026-09-30> · <${REPLY_LINK}|#eng · 2026-10-01>`);
  });

  it('renders the scheduled notification footer as italic', () => {
    const out = convert(`Reminder.\n\n${SCHEDULED_NOTIFICATION_FOOTER}`);
    expect(out.endsWith('_Mneme tracks decisions and open commitments in this server. Reply to this message to update the record._')).toBe(true);
  });

  it('converts a Discord timestamp token to a Slack date', () => {
    expect(convert('Expires <t:1712345678:F>')).toBe('Expires <!date^1712345678^{date_long} {time}|2024-04-05T19:34:38.000Z>');
  });

  it('never keeps a user token live', () => {
    expect(convert('Requested by <@U0123ABCDE>')).toBe('Requested by `U0123ABCDE`');
  });

  it('neutralizes mention syntax from memory text and echoed command arguments', () => {
    const memory = 'm-1  [decision]  (Ship on Friday, says <@U0999ZZZZZ> to <!subteam^S0123ABCDE> in <#C0123ABCDE>)';
    const echoed = 'Unknown option `scope` value: <!here> <@W0123ABCDE|boss>';
    for (const text of [memory, echoed]) {
      const out = convert(text);
      expect(out).not.toMatch(/<[@!#]/);
    }
    expect(convert(memory)).toContain('`U0999ZZZZZ`');
  });
});

describe('toSlackMrkdwn hostile input', () => {
  const hostile: readonly string[] = [
    '<@U0123ABCDE>',
    '<@W0123ABCDE|name>',
    '<!channel>',
    '<!here>',
    '<!everyone>',
    '<!here|here>',
    '<!subteam^S0123ABCD>',
    '<!subteam^S0123ABCD|@team>',
    '<#C0123ABCD>',
    '<#C0123ABCD|general>',
    '&lt;!here&gt;',
    '&amp;lt;!channel&amp;gt;',
    '<!\u200Bhere>',
    '<\u200B!here>',
    '<https://evil.example|https://good.example>',
    '[click](https://evil.example/x)',
    '[click](javascript:alert(1))',
    `[spoof](${LINK}.evil.example)`,
    '[spoof](https://acme.slack.com.evil.example/archives/C0123ABCD/p1712345678000100)',
    '[spoof](https://evil.slack.com/archives/C0123ABCD/p1712345678000100)',
    `[a|<!here>](${LINK})`,
    `[x>y](${LINK})`,
    '**<!here>**',
    '> <!channel>',
    '`<!here>` outside <!here>',
    '**unbalanced',
    '`unbalanced backtick <!here>',
    '\uE000' + '0' + '\uE000',
    `\uE0000\uE000 [a](${LINK})`,
    '<t:1712345678:F><!here>',
    '<@U0123ABCDE><!everyone>',
  ];

  it.each(hostile)('produces no mention token for %j', (input) => {
    expect(convert(input)).not.toMatch(MENTION_TOKEN);
  });

  it.each(hostile)('produces only host-built links for %j', (input) => {
    for (const url of linksIn(convert(input))) expect(isHostBuiltSlackLink(url, DOMAIN)).toBe(true);
  });

  it('keeps a typed entity literal', () => {
    expect(convert('&lt;!here&gt;')).toBe('&amp;lt;!here&amp;gt;');
  });

  it('shows a non-host link as plain text', () => {
    expect(convert('[click](https://evil.example/x)')).toBe('click (https://evil.example/x)');
  });

  it('removes link-ending characters from a host-built link label', () => {
    expect(convert(`[a|b>c](${LINK})`)).toBe(`<${LINK}|abc>`);
  });

  it('does not let input forge a placeholder', () => {
    const out = convert(`\uE0000\uE000 and [a](${LINK})`);
    expect(out).toBe(`0 and <${LINK}|a>`);
  });

  it('converts adversarial input in linear time', () => {
    // Compare the fastest of several runs at n and 8n characters. Linear work
    // grows about 8 times; quadratic work grows about 64 times. A ratio bound
    // does not depend on how busy the machine is, unlike a wall-clock bound.
    const adversarial = (n: number): string[] => [
      '*'.repeat(n),
      '**a'.repeat(n / 2),
      '['.repeat(n / 2) + ']('.repeat(n / 2),
    ];
    const fastestMs = (inputs: string[]): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        for (const input of inputs) convert(input);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    fastestMs(adversarial(2_000));
    const small = Math.max(fastestMs(adversarial(5_000)), 0.5);
    const large = fastestMs(adversarial(40_000));
    expect(large / small).toBeLessThan(30);
  });
});

describe('escapeSlackText', () => {
  it('escapes control characters and removes private-use characters', () => {
    expect(escapeSlackText('a & <b> \uE000c')).toBe('a &amp; &lt;b&gt; c');
  });
});

describe('isHostBuiltSlackLink', () => {
  it.each([
    [LINK, true],
    [REPLY_LINK, true],
    ['https://acme.slack.com/archives/C0123ABCD/p1712345678000100?x=1', false],
    ['http://acme.slack.com/archives/C0123ABCD/p1712345678000100', false],
    ['https://other.slack.com/archives/C0123ABCD/p1712345678000100', false],
    ['https://acme.slack.com/archives/C0123ABCD/p17123456780001', false],
  ])('%s → %s', (url, expected) => {
    expect(isHostBuiltSlackLink(url, DOMAIN)).toBe(expected);
  });
});
