// ABOUTME: Tests the Slack `/mneme` text parser against the shared command spec.
// ABOUTME: Every spec entry must parse; quoting, named arguments, tokens, and refusals are covered.
import { describe, it, expect } from 'vitest';
import { parseSlackCommand, slackCommandHelp, slackOptionsReader, tokenize } from '../../../src/platform/slack/command-parser.js';
import { MNEME_SUBCOMMAND_GROUPS, MNEME_SUBCOMMANDS, type CommandOptionSpec, type SubcommandSpec } from '../../../src/commands/spec.js';

const SPEC = { subcommands: MNEME_SUBCOMMANDS, groups: MNEME_SUBCOMMAND_GROUPS };
const parse = (text: string) => parseSlackCommand(text, SPEC);

function sample(o: CommandOptionSpec): string {
  switch (o.kind) {
    case 'integer': return '7';
    case 'channel': return '<#C0000000001|general>';
    case 'user': return '<@U0000000001|niko>';
    case 'string': return o.choices ? o.choices[0]!.value : '"some value"';
  }
}
const allArgs = (sub: SubcommandSpec): string => sub.options.map(sample).join(' ');

const paths: Array<[string, SubcommandSpec]> = [
  ...MNEME_SUBCOMMANDS.map((s) => [s.name, s] as [string, SubcommandSpec]),
  ...MNEME_SUBCOMMAND_GROUPS.flatMap((g) => g.subcommands.map((s) => [`${g.name} ${s.name}`, s] as [string, SubcommandSpec])),
];

describe('parseSlackCommand covers the whole spec', () => {
  it.each(paths)('parses %s with every option', (path, sub) => {
    const parsed = parse(`${path} ${allArgs(sub)}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([parsed.group, parsed.subcommand].filter(Boolean).join(' ')).toBe(path);
    for (const o of sub.options) expect(parsed.options.has(o.name)).toBe(true);
  });

  it.each(paths)('parses %s with required options only', (path, sub) => {
    const required = sub.options.filter((o) => o.required).map(sample).join(' ');
    expect(parse(`${path} ${required}`).ok).toBe(true);
  });

  it('lists every command in help', () => {
    const help = slackCommandHelp(SPEC);
    for (const [path] of paths) expect(help).toContain(`/mneme ${path}`);
  });
});

describe('parseSlackCommand grammar', () => {
  it('gives help for empty text and for help', () => {
    expect(parse('')).toMatchObject({ ok: false, help: true });
    expect(parse('help')).toMatchObject({ ok: false, help: true });
    const one = parse('help deletion');
    expect(one.ok === false && one.help && one.text).toContain('/mneme deletion approve <id>');
  });

  it('takes the rest of the line for a final string option', () => {
    const parsed = parse('memory-search launch date for beta');
    expect(parsed.ok && parsed.options.get('query')).toBe('launch date for beta');
  });

  it('groups words in double quotes and keeps an escaped quote', () => {
    expect(tokenize('a "b c" "say \\"hi\\""')?.map((t) => t.text)).toEqual(['a', 'b c', 'say "hi"']);
    const parsed = parse('mcp-token create "ci bot" ops 30');
    expect(parsed.ok && Object.fromEntries(parsed.options)).toEqual({ name: 'ci bot', channels: 'ops', 'expires-days': 30 });
  });

  it('accepts name:value arguments in any order', () => {
    const parsed = parse('deletion approve confirmation:DELETE id:abc-123');
    expect(parsed.ok && Object.fromEntries(parsed.options)).toEqual({ id: 'abc-123', confirmation: 'DELETE' });
  });

  it('reads channel and user tokens with and without a name', () => {
    for (const token of ['<#C0000000001|general>', '<#C0000000001>', 'C0000000001']) {
      const parsed = parse(`sync ${token}`);
      expect(parsed.ok && parsed.options.get('channel')).toBe('C0000000001');
    }
    for (const token of ['<@U0000000001|niko>', '<@U0000000001>']) {
      const parsed = parse(`forget-user ${token}`);
      expect(parsed.ok && parsed.options.get('user')).toBe('U0000000001');
    }
  });

  it('decodes the characters that Slack escapes', () => {
    const parsed = parse('memory-search R&amp;D &lt;launch&gt;');
    expect(parsed.ok && parsed.options.get('query')).toBe('R&D <launch>');
  });

  it.each([
    ['an invalid choice', 'mode loud', /value must be one of/],
    ['an invalid integer', 'recap start lots', /days must be a whole number/],
    ['an invalid channel', 'sync #general', /channel must be a channel/],
    ['an invalid user', 'forget-user niko', /user must be a user/],
    ['an unknown command', 'launch', /Unknown Mneme command "launch"/],
    ['an unknown group command', 'deletion purge', /Unknown deletion command/],
    ['a missing required option', 'approve', /id is required/],
    ['extra arguments', 'status now please', /Too many arguments/],
    ['an open quote', 'memory-search "launch', /not closed/],
    ['a repeated named option', 'approve id:a id:b', /given twice/],
  ])('refuses %s', (_name, text, error) => {
    const parsed = parse(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && !parsed.help && parsed.error).toMatch(error);
  });
});

describe('slackOptionsReader', () => {
  it('reads parsed options like the Discord options resolver', () => {
    const parsed = parse('recap start 14 "pricing" <#C0000000001|eng> 20');
    if (!parsed.ok) throw new Error('parse failed');
    const reader = slackOptionsReader(parsed);
    expect(reader.getSubcommandGroup(false)).toBe('recap');
    expect(reader.getSubcommand()).toBe('start');
    expect(reader.getInteger('days')).toBe(14);
    expect(reader.getString('topic')).toBe('pricing');
    expect(reader.getChannel('channel')).toEqual({ id: 'C0000000001' });
    expect(reader.getInteger('budget-usd')).toBe(20);
    expect(reader.getString('missing')).toBeNull();
    expect(() => reader.getString('missing', true)).toThrow();
  });
});
