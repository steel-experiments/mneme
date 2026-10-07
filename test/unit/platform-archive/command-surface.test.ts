// ABOUTME: Tests that the `/mneme archive` group exists only when a platform archive is configured (plan 011 step 9).
// ABOUTME: Without MNEME_ARCHIVE_PATH the Discord registration payload and the Slack parser are unchanged.
import { describe, it, expect } from 'vitest';
import { ApplicationCommandOptionType } from 'discord.js';
import { MNEME_COMMANDS, buildMnemeCommand } from '../../../src/platform/discord/commands.js';
import { MNEME_SUBCOMMANDS, mnemeSubcommandGroups } from '../../../src/commands/spec.js';
import { parseSlackCommand } from '../../../src/platform/slack/command-parser.js';

type Option = { name: string; type: number; options?: Option[] };

function rootOptions(json: { options?: unknown }): Option[] {
  return (json.options ?? []) as Option[];
}

describe('archive command group', () => {
  it('is absent from the default registration payload', () => {
    const names = rootOptions(MNEME_COMMANDS[0]!).map((o) => o.name);
    expect(names).not.toContain('archive');
    expect(buildMnemeCommand().toJSON()).toEqual(MNEME_COMMANDS[0]);
    expect(buildMnemeCommand({ archive: false }).toJSON()).toEqual(MNEME_COMMANDS[0]);
  });

  it('is registered with three subcommands when an archive is configured, within the Discord option limit', () => {
    const options = rootOptions(buildMnemeCommand({ archive: true }).toJSON());
    const group = options.find((o) => o.name === 'archive');
    expect(group?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(group?.options?.map((o) => o.name)).toEqual(['user', 'forget-user', 'forget-message']);
    expect(options.length).toBeLessThanOrEqual(25);
  });

  it('parses on Slack only when an archive is configured', () => {
    const withArchive = parseSlackCommand('archive user name:Niko', { subcommands: MNEME_SUBCOMMANDS, groups: mnemeSubcommandGroups({ archive: true }) });
    expect(withArchive).toMatchObject({ ok: true, group: 'archive', subcommand: 'user' });
    const without = parseSlackCommand('archive user name:Niko', { subcommands: MNEME_SUBCOMMANDS, groups: mnemeSubcommandGroups({ archive: false }) });
    expect(without.ok).toBe(false);
  });
});
