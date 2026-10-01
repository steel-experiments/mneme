import { describe, it, expect } from 'vitest';
import {
  sanitizeOutboundMessage,
  buildSourceLinks,
  renderInlineCitations,
  MAX_MESSAGE_CHARS,
  MAX_SOURCE_LINKS,
  type SourceLinkContext,
} from '../../src/outbound/message-safety.js';
import { messageLink } from '../../src/platform/links.js';
import { discordFormat, parseMentions } from '../../src/platform/discord/format.js';

/**
 * Mention and message-content sanitization (Sections 7.4 check 8, 24.5, 30.3,
 * 44).
 *
 * Acceptance: mention injection fixtures cannot ping any user or role, and
 * oversized or over-cited content is rejected.
 */

const GUILD = '999000000000000000';

function ctx(map: Record<string, string> = {}): SourceLinkContext {
  return { resolveChannelId: (id) => map[id] };
}

describe('parseMentions — independent syntax parsing', () => {
  it('parses a plain user mention <@id>', () => {
    expect(parseMentions('hi <@123456789012345678>')).toEqual([
      { raw: '<@123456789012345678>', kind: 'user', id: '123456789012345678' },
    ]);
  });

  it('parses the legacy nickname-ping form <@!id> as a user mention', () => {
    expect(parseMentions('<@!123456789012345678>')[0]).toMatchObject({ kind: 'user' });
  });

  it('parses a role mention <@&id>', () => {
    expect(parseMentions('ping <@&223456789012345678> now')).toEqual([
      { raw: '<@&223456789012345678>', kind: 'role', id: '223456789012345678' },
    ]);
  });

  it('parses @everyone and @here mass mentions', () => {
    const m = parseMentions('hey @everyone and @here please');
    expect(m.map((x) => x.kind)).toEqual(['everyone', 'here']);
  });

  it('does not flag a textual @Mneme (prose, not mention syntax)', () => {
    expect(parseMentions('I asked @Mneme about it')).toEqual([]);
  });

  it('ignores channel, emoji, and slash-command tokens (not pings)', () => {
    expect(parseMentions('see <#323456789012345678> :smile: <:emoji:423456789012345678> </cmd:523456789012345678>')).toEqual([]);
  });

  it('does not treat email-style or doubled tokens as mass mentions', () => {
    expect(parseMentions('reach team@everyone.com or @@everyone')).toEqual([]);
  });

  it('collects every mention kind present', () => {
    const m = parseMentions('<@111111111111111111> @everyone <@&222222222222222222>');
    expect(new Set(m.map((x) => x.kind))).toEqual(new Set(['user', 'everyone', 'role']));
    expect(m.length).toBe(3);
  });
});

describe('sanitizeOutboundMessage — happy path', () => {
  it('allows clean prose and returns safe send options', () => {
    const res = sanitizeOutboundMessage({ format: discordFormat, content: 'Heads up: the API changed.', guildId: GUILD });
    expect(res.outcome).toBe('allow');
    if (res.outcome !== 'allow') return;
    expect(res.content).toBe('Heads up: the API changed.');
    expect(res.sendOptions.allowedMentions.parse).toEqual([]);
    expect(res.sendOptions.allowedMentions.repliedUser).toBe(false);
    expect(res.sourceLinks).toEqual([]);
  });

  it('allows a message at exactly the 1800-character limit', () => {
    const res = sanitizeOutboundMessage({ format: discordFormat, content: 'x'.repeat(MAX_MESSAGE_CHARS), guildId: GUILD });
    expect(res.outcome).toBe('allow');
  });

  it('builds up to three trusted masked source links from cited ids', () => {
    const res = sanitizeOutboundMessage(
      { format: discordFormat, content: 'see the thread', guildId: GUILD, sourceLinkMessageIds: ['m1', 'm2', 'm3'] },
      ctx({ m1: 'c1', m2: 'c2', m3: 'c3' }),
    );
    expect(res.outcome).toBe('allow');
    if (res.outcome !== 'allow') return;
    expect(res.sourceLinks.map((l) => l.url)).toEqual([
      messageLink(GUILD, 'c1', 'm1'),
      messageLink(GUILD, 'c2', 'm2'),
      messageLink(GUILD, 'c3', 'm3'),
    ]);
    expect(res.sourceLinks[0]!.masked).toBe(`[source](${messageLink(GUILD, 'c1', 'm1')})`);
  });
});

describe('sanitizeOutboundMessage — mention injection', () => {
  it('rejects a user mention injection', () => {
    const res = sanitizeOutboundMessage({ format: discordFormat, content: 'hey <@123456789012345678>!', guildId: GUILD });
    expect(res.outcome).toBe('reject');
    if (res.outcome !== 'reject') return;
    expect(res.reasons.some((r) => r.includes('user'))).toBe(true);
  });

  it('rejects a role mention injection', () => {
    const res = sanitizeOutboundMessage({ format: discordFormat, content: '<@&223456789012345678> assemble', guildId: GUILD });
    expect(res.outcome).toBe('reject');
    if (res.outcome !== 'reject') return;
    expect(res.reasons.some((r) => r.includes('role'))).toBe(true);
  });

  it('rejects an @everyone injection', () => {
    const res = sanitizeOutboundMessage({ format: discordFormat, content: '@everyone read this', guildId: GUILD });
    expect(res.outcome).toBe('reject');
    expect((res as { reasons: string[] }).reasons.some((r) => r.includes('everyone'))).toBe(true);
  });

  it('rejects an @here injection', () => {
    const res = sanitizeOutboundMessage({ format: discordFormat, content: 'ping @here', guildId: GUILD });
    expect(res.outcome).toBe('reject');
  });

  it('never returns send options for an injected message (no ping path)', () => {
    const res = sanitizeOutboundMessage({ format: discordFormat, content: '<@123456789012345678>', guildId: GUILD });
    expect(res.outcome).toBe('reject');
    expect((res as { sendOptions?: unknown }).sendOptions).toBeUndefined();
  });
});

describe('sanitizeOutboundMessage — size and citation limits', () => {
  it('rejects a message over the 1800-character limit', () => {
    const res = sanitizeOutboundMessage({ format: discordFormat, content: 'x'.repeat(MAX_MESSAGE_CHARS + 1), guildId: GUILD });
    expect(res.outcome).toBe('reject');
    if (res.outcome !== 'reject') return;
    expect(res.reasons.some((r) => r.includes('1800'))).toBe(true);
  });

  it('rejects over-cited content (more than three source links)', () => {
    const res = sanitizeOutboundMessage(
      { format: discordFormat, content: 'ok', guildId: GUILD, sourceLinkMessageIds: ['a', 'b', 'c', 'd'] },
      ctx({ a: 'ca', b: 'cb', c: 'cc', d: 'cd' }),
    );
    expect(res.outcome).toBe('reject');
    if (res.outcome !== 'reject') return;
    expect(res.reasons.some((r) => r.includes('4') && r.includes('source links'))).toBe(true);
  });

  it('rejects a model-authored Discord jump URL so only host-built links are sent', () => {
    for (const host of [
      'discord.com',
      'canary.discord.com',
      'ptb.discordapp.com',
      'discord.com:443',
      'canary.discord.com:8443',
      'discord.com.:443',
      'viewer@discord.com',
      'viewer:secret@canary.discord.com:443',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat,
        content: `See https://${host}/channels/1/2/3 for the source.`,
        guildId: GUILD,
        sourceLinkMessageIds: ['3'],
      }, ctx({ '3': '2' }));
      expect(res.outcome, host).toBe('reject');
      if (res.outcome !== 'reject') continue;
      expect(res.reasons, host).toContain(
        'message contains an untrusted Discord source link; cite message ids instead',
      );
    }
  });

  it('rejects Discord jump URLs after browser URL normalization', () => {
    for (const candidate of [
      'https://a@b@discord.com/channels/1/2/3',
      String.raw`https://discord.com\channels\1\2\3`,
      String.raw`https:\discord.com\channels\1\2\3`,
      'https://discord.com/%63hannels/1/2/3',
      'https://discord.com/channels%2F1%2F2%2F3',
      'https://discord.com//channels/1/2/3',
      'https://discord.com/%5Cchannels/1/2/3',
      'https://discord.com/%252e%252e/channels/1/2/3',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat,
        content: `[source](${candidate})`,
        guildId: GUILD,
      });
      expect(res.outcome, candidate).toBe('reject');
      if (res.outcome !== 'reject') continue;
      expect(res.reasons, candidate).toContain(
        'message contains an untrusted Discord source link; cite message ids instead',
      );
    }
  });

  it('rejects protocol-relative Discord jump destinations', () => {
    for (const content of [
      '//discord.com/channels/1/2/3',
      '[source](//canary.discord.com/channels/1/2/3)',
      '[source](//discordapp.com/%63hannels/1/2/3)',
      '[source](//&dscr;&iscr;&sscr;&cscr;&oscr;&rscr;&dscr;.com/channels/1/2/3)',
      '[source](//discord.com/&cscr;hannels/1/2/3)',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat, content, guildId: GUILD });
      expect(res.outcome, content).toBe('reject');
      if (res.outcome !== 'reject') continue;
      expect(res.reasons, content).toContain(
        'message contains an untrusted Discord source link; cite message ids instead',
      );
    }
  });

  it('rejects Discord-relative jump destinations, including Markdown destinations', () => {
    for (const content of [
      '/channels/1/2/3',
      '[source](/channels/1/2/3)',
      '[source](</%63hannels/1/2/3>)',
      '[source](&sol;channels&sol;1&sol;2&sol;3)',
      '[source]:/channels/1/2/3\n\n[source]',
      '[source]:\n/channels/1/2/3\n\n[source]',
      '[source]:/channels\n\n[source]',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat, content, guildId: GUILD });
      expect(res.outcome, content).toBe('reject');
      if (res.outcome !== 'reject') continue;
      expect(res.reasons, content).toContain(
        'message contains an untrusted Discord source link; cite message ids instead',
      );
    }
  });

  it('rejects native Discord jump destinations', () => {
    for (const content of [
      'discord://-/channels/1/2/3',
      '[source](DISCORD://-/channels/1/2/3)',
      '[source](discord://-/%63hannels/1/2/3)',
      '[source](discord:///channels/1/2/3)',
      '[source](discord:/channels/1/2/3)',
      '[source](discord:channels/1/2/3)',
      '[source](discord://%2D/channels/1/2/3)',
      '[source](discord://-//channels/1/2/3)',
      '[source](discord:////-/channels/1/2/3)',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat, content, guildId: GUILD });
      expect(res.outcome, content).toBe('reject');
      if (res.outcome !== 'reject') continue;
      expect(res.reasons, content).toContain(
        'message contains an untrusted Discord source link; cite message ids instead',
      );
    }
  });

  it('checks every adjacent URL candidate instead of letting an earlier URL hide it', () => {
    for (const content of [
      '[safe](https://example.com)[source](https://discord.com/channels/1/2/3)',
      'https://example.com,https://discord.com/channels/1/2/3',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat, content, guildId: GUILD });
      expect(res.outcome, content).toBe('reject');
      if (res.outcome !== 'reject') continue;
      expect(res.reasons, content).toContain(
        'message contains an untrusted Discord source link; cite message ids instead',
      );
    }
  });

  it('rejects Discord links after CommonMark destination normalization', () => {
    for (const content of [
      String.raw`[source](https://discord\.com/channels/1/2/3)`,
      String.raw`[source](https://discord.com\/channels\/1\/2\/3)`,
      '[source](https://discord&#46;com/channels/1/2/3)',
      '[source](https://discord&period;com&sol;channels&sol;1&sol;2&sol;3)',
      '[source](https&#58;//discord.com/channels/1/2/3)',
      '[source](https://&#100;&#105;&#115;&#99;&#111;&#114;&#100;.com/channels/1/2/3)',
      '[source](https://discord&#9;.com/channels/1/2/3)',
      '[source](https://discord&#10;.com/channels/1/2/3)',
      '[source](https://discord&#13;.com/channels/1/2/3)',
      '[source](https://discord&Tab;.com/channels/1/2/3)',
      '[source](https://discord&NewLine;.com/channels/1/2/3)',
      '[source](https://&dscr;&iscr;&sscr;&cscr;&oscr;&rscr;&dscr;.com/channels/1/2/3)',
      '[source](https://discord.com/&cscr;hannels/1/2/3)',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat, content, guildId: GUILD });
      expect(res.outcome, content).toBe('reject');
      if (res.outcome !== 'reject') continue;
      expect(res.reasons, content).toContain(
        'message contains an untrusted Discord source link; cite message ids instead',
      );
    }
  });

  it('does not mistake a deceptive non-Discord host for a Discord jump URL', () => {
    for (const content of [
      'See https://discord.com.evil.example/channels/1/2/3 for unrelated material.',
      'See //discord.com.evil.example/channels/1/2/3 for unrelated material.',
      'See discord://example.com/channels/1/2/3 for unrelated material.',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat, content, guildId: GUILD });
      expect(res.outcome, content).toBe('allow');
    }
  });

  it('allows ordinary relative links', () => {
    for (const content of [
      '[docs](/docs/channels/overview)',
      '[local](./docs/channels/overview)',
      '[parent](../docs/channels/overview)',
      '[query](?next=/channels/1/2/3)',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat, content, guildId: GUILD });
      expect(res.outcome, content).toBe('allow');
    }
  });

  it('rejects dot-relative paths that can resolve to Discord channels', () => {
    for (const content of [
      '[source](channels/1/2/3)',
      '[source](./channels/1/2/3)',
      '[source](../channels/1/2/3)',
      '[source](../../../../../../channels/1/2/3)',
      '[source](%2e%2e/%2e%2e/%2e%2e/channels/1/2/3)',
      '[source](.%2e/.%2e/channels/1/2/3)',
      '[source](docs/../../../channels/1/2/3)',
      '[source](a/%2e%2e/%2e%2e/%2e%2e/channels/1/2/3)',
      '[source](&period;&period;&sol;&period;&period;&sol;channels&sol;1&sol;2&sol;3)',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat, content, guildId: GUILD });
      expect(res.outcome, content).toBe('reject');
    }
  });

  it('allows named entities confined to non-jump paths, queries, and ordinary prose', () => {
    for (const content of [
      '[safe](https://example.com/?copyright=&copy;)',
      '[safe](https://example.com/path/&hearts;)',
      '[safe](https://example.com/?next:/channels/1/2/3)',
      'https://example.com/foo:/channels/1/2/3',
      '[safe](https://discord.com/docs/&copy;)',
      '[safe](//discord.com/docs/&hearts;)',
      '[safe](docs/../docs/channels/overview)',
      '[safe](%2e%2e/docs/channels/overview)',
      '[safe](/docs/&copy;)',
      '[safe](../docs/&copy;)',
      'channels are synchronized and ready',
      'Read the channels/overview section in the guide',
      'The update is complete (channels are synchronized).',
      'Use the docs section (docs/channels/overview) for details.',
    ]) {
      const res = sanitizeOutboundMessage({ format: discordFormat, content, guildId: GUILD });
      expect(res.outcome, content).toBe('allow');
    }
  });

  it('collects multiple violations into one reject', () => {
    const res = sanitizeOutboundMessage({ format: discordFormat,
      content: `<@111111111111111111> ${'x'.repeat(MAX_MESSAGE_CHARS + 1)}`,
      guildId: GUILD,
      sourceLinkMessageIds: ['a', 'b', 'c', 'd'],
    });
    expect(res.outcome).toBe('reject');
    if (res.outcome !== 'reject') return;
    expect(res.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('sanitizeOutboundMessage — source link construction', () => {
  it('uses safe descriptive labels and replaces inline citation markers', () => {
    const res = sanitizeOutboundMessage(
      { format: discordFormat, content: 'The deploy is green. [[cite:m1]]', guildId: GUILD, sourceLinkMessageIds: ['m1'] },
      {
        ...ctx({ m1: 'c1' }),
        resolveLabel: () => '#general · 2026-08-24',
      },
    );
    expect(res.outcome).toBe('allow');
    if (res.outcome !== 'allow') return;
    expect(renderInlineCitations(res.content, res.sourceLinks)).toEqual({
      outcome: 'allow',
      content: `The deploy is green. [#general · 2026-08-24](${messageLink(GUILD, 'c1', 'm1')})`,
      unusedLinks: [],
      markerCount: 1,
    });
  });

  it('drops a cited id that cannot be resolved to a channel (no link, still allowed)', () => {
    const res = sanitizeOutboundMessage(
      { format: discordFormat, content: 'ok', guildId: GUILD, sourceLinkMessageIds: ['known', 'ghost'] },
      ctx({ known: 'ck' }),
    );
    expect(res.outcome).toBe('allow');
    if (res.outcome !== 'allow') return;
    expect(res.sourceLinks.map((l) => l.messageId)).toEqual(['known']);
  });

  it('builds no guild-scoped links when the run has no guild (DM context)', () => {
    const res = sanitizeOutboundMessage(
      { format: discordFormat, content: 'ok', guildId: null, sourceLinkMessageIds: ['m1'] },
      ctx({ m1: 'c1' }),
    );
    expect(res.outcome).toBe('allow');
    if (res.outcome !== 'allow') return;
    expect(res.sourceLinks).toEqual([]);
  });

  it('messageLink produces the Section 30.3 host-generated form', () => {
    expect(messageLink(GUILD, 'c1', 'm1')).toBe(
      `https://discord.com/channels/${GUILD}/c1/m1`,
    );
  });

  it('buildSourceLinks never returns more than MAX_SOURCE_LINKS', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const links = buildSourceLinks(
      GUILD,
      ids,
      ctx({ a: '1', b: '2', c: '3', d: '4', e: '5' }),
    );
    expect(links.length).toBe(MAX_SOURCE_LINKS);
  });
});

describe('sanitizeOutboundMessage — redaction', () => {
  it('never echoes message content in rejection reasons', () => {
    const secret = 'SUPERSECRET-CONTENT';
    const res = sanitizeOutboundMessage({ format: discordFormat, content: `<@123456789012345678> ${secret}`, guildId: GUILD });
    if (res.outcome !== 'reject') throw new Error('expected reject');
    for (const r of res.reasons) {
      expect(r).not.toContain(secret);
    }
  });
});
