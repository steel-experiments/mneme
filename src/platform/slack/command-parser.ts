// ABOUTME: Parses `/mneme` slash command text into the neutral invocation (spec Section 27).
// ABOUTME: Derived from the shared command spec; arguments are positional or `name:value`, and quotes group words.
import type { CommandOptionsReader } from '../../commands/dispatcher.js';
import type { CommandOptionSpec, SubcommandGroupSpec, SubcommandSpec } from '../../commands/spec.js';
import { isSlackChannelId, isSlackUserId } from './ids.js';

export interface CommandSpecSet {
  subcommands: readonly SubcommandSpec[];
  groups: readonly SubcommandGroupSpec[];
}

export type ParsedSlackCommand =
  | { ok: true; group: string | null; subcommand: string; options: ReadonlyMap<string, string | number> }
  | { ok: false; help: true; text: string }
  | { ok: false; help: false; error: string };

interface Token {
  text: string;
  quoted: boolean;
}

/** Slack escapes `&`, `<`, and `>` in command text (`should_escape: true`). */
function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Split on spaces. Double quotes group words; `\"` inside quotes is a literal quote. */
export function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let current = '';
  let quoted = false;
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes && ch === '\\' && text[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      quoted = true;
      started = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (started) tokens.push({ text: current, quoted });
      current = '';
      quoted = false;
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (inQuotes) return null;
  if (started) tokens.push({ text: current, quoted });
  return tokens;
}

function optionUsage(o: CommandOptionSpec): string {
  return o.required ? `<${o.name}>` : `[${o.name}]`;
}

function usageFor(path: string, sub: SubcommandSpec): string {
  return [`/mneme ${path}`, ...sub.options.map(optionUsage)].join(' ');
}

/** Usage lines for every command, or for one command or group. */
export function slackCommandHelp(spec: CommandSpecSet, name?: string): string {
  const lines: string[] = [];
  for (const sub of spec.subcommands) {
    if (!name || name === sub.name) lines.push(`${usageFor(sub.name, sub)} — ${sub.description}`);
  }
  for (const group of spec.groups) {
    for (const sub of group.subcommands) {
      if (!name || name === group.name) lines.push(`${usageFor(`${group.name} ${sub.name}`, sub)} — ${sub.description}`);
    }
  }
  if (lines.length === 0) return `Unknown Mneme command "${name}". Use \`/mneme help\` for the list.`;
  return [
    ...lines,
    '',
    'Give arguments in order, or as `name:value`. Use double quotes for a value with spaces.',
  ].join('\n');
}

function parseValue(o: CommandOptionSpec, raw: string): { ok: true; value: string | number } | { ok: false; error: string } {
  const value = unescapeSlack(raw);
  switch (o.kind) {
    case 'integer':
      return /^-?\d{1,15}$/.test(value) ? { ok: true, value: Number(value) } : { ok: false, error: `${o.name} must be a whole number` };
    case 'channel': {
      const m = /^<#([CG][A-Z0-9]{8,})(?:\|[^>]*)?>$/.exec(value);
      const id = m ? m[1]! : value;
      return isSlackChannelId(id) ? { ok: true, value: id } : { ok: false, error: `${o.name} must be a channel, for example #general` };
    }
    case 'user': {
      const m = /^<@([UW][A-Z0-9]{8,})(?:\|[^>]*)?>$/.exec(value);
      const id = m ? m[1]! : value;
      return isSlackUserId(id) ? { ok: true, value: id } : { ok: false, error: `${o.name} must be a user, for example @name` };
    }
    case 'string':
      if (o.choices && !o.choices.some((c) => c.value === value)) {
        return { ok: false, error: `${o.name} must be one of: ${o.choices.map((c) => c.value).join(', ')}` };
      }
      return { ok: true, value };
  }
}

/** Parse the text after `/mneme`. Empty text and `help` give usage. */
export function parseSlackCommand(text: string, spec: CommandSpecSet): ParsedSlackCommand {
  const tokens = tokenize(text.trim());
  if (tokens === null) return { ok: false, help: false, error: 'A double quote is not closed.' };
  if (tokens.length === 0) return { ok: false, help: true, text: slackCommandHelp(spec) };
  const first = tokens[0]!.text;
  if (first === 'help') {
    return { ok: false, help: true, text: slackCommandHelp(spec, tokens[1]?.text) };
  }
  let group: string | null = null;
  let sub: SubcommandSpec | undefined;
  let rest: Token[];
  const groupSpec = spec.groups.find((g) => g.name === first);
  if (groupSpec) {
    group = groupSpec.name;
    sub = groupSpec.subcommands.find((s) => s.name === tokens[1]?.text);
    if (!sub) return { ok: false, help: false, error: `Unknown ${group} command.\n${slackCommandHelp(spec, group)}` };
    rest = tokens.slice(2);
  } else {
    sub = spec.subcommands.find((s) => s.name === first);
    if (!sub) return { ok: false, help: false, error: `Unknown Mneme command "${first}". Use \`/mneme help\` for the list.` };
    rest = tokens.slice(1);
  }
  const path = group ? `${group} ${sub.name}` : sub.name;
  const usage = `Usage: ${usageFor(path, sub)}`;
  const options = new Map<string, string | number>();
  const positional: Token[] = [];
  for (const token of rest) {
    const named = /^([a-z][a-z-]*):([\s\S]*)$/.exec(token.text);
    const option = named ? sub.options.find((o) => o.name === named[1]) : undefined;
    if (named && option) {
      if (options.has(option.name)) return { ok: false, help: false, error: `${option.name} is given twice.\n${usage}` };
      const parsed = parseValue(option, named[2]!);
      if (!parsed.ok) return { ok: false, help: false, error: `${parsed.error}.\n${usage}` };
      options.set(option.name, parsed.value);
    } else {
      positional.push(token);
    }
  }
  const open = sub.options.filter((o) => !options.has(o.name));
  for (let i = 0; i < open.length && positional.length > 0; i++) {
    const option = open[i]!;
    const lastOverall = option === sub.options[sub.options.length - 1] && i === open.length - 1;
    // The last option, when it is a string, takes the rest of the line.
    const raw = lastOverall && option.kind === 'string' && !positional[0]!.quoted
      ? positional.splice(0).map((t) => t.text).join(' ')
      : positional.shift()!.text;
    const parsed = parseValue(option, raw);
    if (!parsed.ok) return { ok: false, help: false, error: `${parsed.error}.\n${usage}` };
    options.set(option.name, parsed.value);
  }
  if (positional.length > 0) return { ok: false, help: false, error: `Too many arguments.\n${usage}` };
  const missing = sub.options.find((o) => o.required && !options.has(o.name));
  if (missing) return { ok: false, help: false, error: `${missing.name} is required.\n${usage}` };
  return { ok: true, group, subcommand: sub.name, options };
}

/** The neutral options reader for a parsed command. */
export function slackOptionsReader(parsed: Extract<ParsedSlackCommand, { ok: true }>): CommandOptionsReader {
  const get = (name: string): string | number | undefined => parsed.options.get(name);
  const required = (name: string): never => {
    throw new Error(`required option ${name} is missing`);
  };
  return {
    getSubcommand: () => parsed.subcommand,
    getSubcommandGroup: () => parsed.group,
    getString: ((name: string, isRequired?: boolean) => {
      const v = get(name);
      if (typeof v === 'string') return v;
      return isRequired ? required(name) : null;
    }) as CommandOptionsReader['getString'],
    getInteger: (name, isRequired) => {
      const v = get(name);
      if (typeof v === 'number') return v;
      return isRequired ? required(name) : null;
    },
    getChannel: (name) => {
      const v = get(name);
      return typeof v === 'string' ? { id: v } : null;
    },
    getUser: (name) => {
      const v = get(name);
      return typeof v === 'string' ? { id: v } : required(name);
    },
  };
}
