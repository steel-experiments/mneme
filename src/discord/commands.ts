import {
  SlashCommandBuilder,
  Routes,
  type SlashCommandSubcommandBuilder,
} from 'discord.js';

/**
 * Guild-scoped admin command registry (Sections 6.6, 27, 32.5.2).
 *
 * Every Mneme command lives under one `/mneme` application command as a
 * subcommand (or a subcommand of the `mcp-token` group). The declarative spec
 * below is the single source of truth for the command surface; the SlashCommandBuilder
 * and the REST registration payload are both derived from it, so the registered
 * guild commands always match Section 27.
 *
 * Section 6.6 limits guild-scoped Mneme commands to the configured role IDs in
 * `MNEME_ADMIN_ROLE_IDS`, and the commands that disclose restricted content,
 * modify channel policy, delete data, approve an intervention, or force a sync must
 * always require an admin role. Because every Section 27 command is Admin, access is
 * enforced at interaction time through `isAuthorizedAdmin` (fail-closed when no admin
 * roles are configured) rather than pinned to Discord permission bits.
 */

export const MNEME_COMMAND_NAME = 'mneme';
export const MNEME_ROOT_DESCRIPTION =
  'Mneme organizational memory and admin commands.';

/** Discord option kinds we declare on subcommands. */
export type CommandOptionKind = 'string' | 'channel' | 'user' | 'integer';

export interface CommandOptionSpec {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly kind: CommandOptionKind;
  readonly choices?: readonly { readonly name: string; readonly value: string }[];
}

export interface SubcommandSpec {
  readonly name: string;
  readonly description: string;
  readonly options: readonly CommandOptionSpec[];
}

export interface SubcommandGroupSpec {
  readonly name: string;
  readonly description: string;
  readonly subcommands: readonly SubcommandSpec[];
}

const idOption = (description: string): CommandOptionSpec => ({
  name: 'id',
  description,
  required: true,
  kind: 'string',
});

/**
 * The Section 27 flat subcommands. All are Admin-only (Section 27 "Access" column).
 * Descriptions are trimmed from the Section 27 "Purpose" column (Discord caps at 100).
 */
export const MNEME_SUBCOMMANDS: readonly SubcommandSpec[] = [
  { name: 'status', description: 'Gateway, DB, sync, queue, model, and mode status.', options: [] },
  {
    name: 'mode',
    description: 'Change runtime mode or return control to environment configuration.',
    options: [
      {
        name: 'value',
        description: 'Effective mode; configured clears the durable override.',
        required: true,
        kind: 'string',
        choices: [
          { name: 'configured (environment)', value: 'configured' },
          { name: 'observe', value: 'observe' },
          { name: 'review', value: 'review' },
          { name: 'autonomous', value: 'autonomous' },
        ],
      },
      {
        name: 'confirmation',
        description: 'Required for autonomous mode: enter AUTONOMOUS.',
        required: false,
        kind: 'string',
      },
    ],
  },
  { name: 'channels', description: 'Visible channels, policy class, history state, permission warnings.', options: [] },
  {
    name: 'sync',
    description: 'Queue reconciliation or full backfill for a channel.',
    options: [
      { name: 'channel', description: 'Channel to reconcile or backfill. Omit for all.', required: false, kind: 'channel' },
    ],
  },
  { name: 'pause', description: 'Pause reviews and outbound sends; ingestion continues.', options: [] },
  { name: 'resume', description: 'Resume workers.', options: [] },
  { name: 'proposals', description: 'List pending review proposals.', options: [] },
  { name: 'approve', description: 'Approve a proposal.', options: [idOption('Proposal id to approve.')] },
  { name: 'dismiss', description: 'Dismiss a proposal.', options: [idOption('Proposal id to dismiss.')] },
  {
    name: 'memory-search',
    description: 'Search organizational memory.',
    options: [{ name: 'query', description: 'Search terms.', required: true, kind: 'string' }],
  },
  {
    name: 'memory-get',
    description: 'Read one complete memory with permitted Discord source links.',
    options: [idOption('Full memory id returned by memory-search.')],
  },
  {
    name: 'forget-message',
    description: 'Request message deletion; independent approval and a 24-hour cancellation window are required.',
    options: [idOption('Message id to forget.')],
  },
  {
    name: 'forget-user',
    description: 'Request user-history deletion; independent approval and a 24-hour cancellation window are required.',
    options: [{ name: 'user', description: 'Discord user whose stored messages to delete.', required: true, kind: 'user' }],
  },
  { name: 'reload-policy', description: 'Validate and reload YAML/templates.', options: [] },
  { name: 'backup', description: 'Create an online SQLite backup.', options: [] },
  { name: 'integrity-check', description: 'Run database integrity checks.', options: [] },
];

/**
 * The Section 27 `mcp-token` subcommand group: create / list / revoke (Section 32.5.2).
 */
export const MNEME_SUBCOMMAND_GROUPS: readonly SubcommandGroupSpec[] = [
  {
    name: 'deletion',
    description: 'Review, approve, or cancel deletion requests in the secure review channel.',
    subcommands: [
      { name: 'status', description: 'Show deletion requests and purge progress.',
        options: [{ ...idOption('Full request ID; omit for the latest requests.'), required: false }] },
      { name: 'approve', description: 'Approve another admin’s request; starts a 24-hour cancellation window.',
        options: [idOption('Full deletion request ID.'),
          { name: 'confirmation', description: 'Enter DELETE after reviewing the target and message count.', required: false, kind: 'string' }] },
      { name: 'cancel', description: 'Cancel your request or, as a deletion approver, any request before purge starts.',
        options: [idOption('Full deletion request ID.')] },
      { name: 'retry', description: 'Original approver: retry a failed purge of the remaining approved messages.',
        options: [idOption('Full deletion request ID.')] },
    ],
  },
  {
    name: 'recap',
    description: 'Run, inspect, retry, or cancel a durable budgeted deep recap.',
    subcommands: [
      {
        name: 'start',
        description: 'Analyze a bounded history window and post a sourced report here.',
        options: [
          { name: 'days', description: 'Days to analyze (default 14).', required: false, kind: 'integer' },
          { name: 'topic', description: 'Optional focus for the final synthesis.', required: false, kind: 'string' },
          { name: 'channel', description: 'Optional single source channel; omit for permitted org scope.', required: false, kind: 'channel' },
          { name: 'budget-usd', description: 'Whole-dollar maximum spend for this report.', required: false, kind: 'integer' },
        ],
      },
      { name: 'status', description: 'Show recent deep recap progress and spend.', options: [] },
      {
        name: 'retry',
        description: 'Retry synthesis from a failed recap’s completed chunks.',
        options: [idOption('Failed deep recap id or unique prefix.')],
      },
      { name: 'cancel', description: 'Cancel an active deep recap.', options: [idOption('Deep recap id or unique prefix.')] },
    ],
  },
  {
    name: 'historical',
    description: 'Inspect, pause, and resume the bounded historical-memory campaign.',
    subcommands: [
      { name: 'status', description: 'Show campaign scope, model, window, and budget.', options: [] },
      { name: 'pause', description: 'Pause historical reconstruction and reviews only.', options: [] },
      { name: 'resume', description: 'Resume a paused campaign when budget remains.', options: [] },
    ],
  },
  {
    name: 'mcp-token',
    description: 'Issue, list, and revoke scoped MCP bearer tokens.',
    subcommands: [
      {
        name: 'create',
        description: 'Issue a scoped MCP bearer token; the value is shown once.',
        options: [
          { name: 'name', description: 'Human-readable token name.', required: true, kind: 'string' },
          {
            name: 'channels',
            description: 'Optional comma-separated restricted channel names to grant.',
            required: false,
            kind: 'string',
          },
          {
            name: 'expires-days',
            description: 'Days until the token expires (1-365; default 90).',
            required: false,
            kind: 'integer',
          },
        ],
      },
      { name: 'list', description: 'List MCP tokens with scope, expiry, and last use.', options: [] },
      { name: 'revoke', description: 'Revoke an MCP token immediately.', options: [idOption('Token id to revoke.')] },
    ],
  },
  {
    name: 'inspector-token',
    description: 'Issue, list, and revoke tokens for the read-only inspector web surface.',
    subcommands: [
      {
        name: 'create',
        description: 'Issue an inspector bearer token; the value is shown once.',
        options: [
          { name: 'name', description: 'Human-readable token name.', required: true, kind: 'string' },
          {
            name: 'expires-days',
            description: 'Days until the token expires (1-365; default 30).',
            required: false,
            kind: 'integer',
          },
        ],
      },
      { name: 'list', description: 'List inspector tokens with expiry and last use.', options: [] },
      { name: 'revoke', description: 'Revoke an inspector token immediately.', options: [idOption('Token id to revoke.')] },
    ],
  },
];

function addOptions(sub: SlashCommandSubcommandBuilder, options: readonly CommandOptionSpec[]): void {
  for (const o of options) {
    if (o.kind === 'string') {
      sub.addStringOption((b) => {
        b.setName(o.name).setDescription(o.description).setRequired(o.required);
        if (o.choices) b.addChoices(...o.choices);
        return b;
      });
    } else if (o.kind === 'channel') {
      sub.addChannelOption((b) => b.setName(o.name).setDescription(o.description).setRequired(o.required));
    } else if (o.kind === 'user') {
      sub.addUserOption((b) => b.setName(o.name).setDescription(o.description).setRequired(o.required));
    } else {
      sub.addIntegerOption((b) => b.setName(o.name).setDescription(o.description).setRequired(o.required));
    }
  }
}

/**
 * Build the `/mneme` application command from the declarative spec. Deterministic:
 * the same spec always yields the same command, so registration is convergent.
 */
export function buildMnemeCommand(): SlashCommandBuilder {
  const root = new SlashCommandBuilder()
    .setName(MNEME_COMMAND_NAME)
    .setDescription(MNEME_ROOT_DESCRIPTION);

  for (const s of MNEME_SUBCOMMANDS) {
    root.addSubcommand((sub) => {
      sub.setName(s.name).setDescription(s.description);
      addOptions(sub, s.options);
      return sub;
    });
  }
  for (const g of MNEME_SUBCOMMAND_GROUPS) {
    root.addSubcommandGroup((group) => {
      group.setName(g.name).setDescription(g.description);
      for (const s of g.subcommands) {
        group.addSubcommand((sub) => {
          sub.setName(s.name).setDescription(s.description);
          addOptions(sub, s.options);
          return sub;
        });
      }
      return group;
    });
  }
  return root;
}

/** The REST payload registered for the guild: one root command with all subcommands. */
export const MNEME_COMMANDS: ReturnType<SlashCommandBuilder['toJSON']>[] = [
  buildMnemeCommand().toJSON(),
];

/**
 * Flatten the command surface into endpoint labels (`status`, ..., `mcp-token create`).
 * Used to assert the registered surface matches Section 27 and for diagnostics.
 */
export function listCommandEndpoints(): string[] {
  const flat: string[] = MNEME_SUBCOMMANDS.map((s) => s.name);
  for (const g of MNEME_SUBCOMMAND_GROUPS) {
    for (const s of g.subcommands) flat.push(`${g.name} ${s.name}`);
  }
  return flat;
}

export interface CommandRegistrationRest {
  put(route: string, options: { body: unknown }): Promise<unknown>;
}

export interface RegisterGuildCommandsDeps {
  rest: CommandRegistrationRest;
  applicationId: string;
  guildId: string;
  /** Override the registered payload (defaults to the canonical Section 27 surface). */
  commands?: readonly unknown[];
}

export type RegisterGuildCommandsResult = { ok: true } | { ok: false; error: string };

/**
 * Idempotently register Mneme's guild commands. A `PUT` to the guild commands
 * route replaces the whole guild command set with `commands`, so repeated calls
 * converge on the canonical surface without accumulating duplicates. Any registration
 * failure returns `{ ok: false }` so the caller keeps readiness false (Section 27
 * acceptance) rather than marking the bot ready with a partial command surface.
 */
export async function registerGuildCommands(
  deps: RegisterGuildCommandsDeps,
): Promise<RegisterGuildCommandsResult> {
  const body = deps.commands ?? MNEME_COMMANDS;
  try {
    await deps.rest.put(Routes.applicationGuildCommands(deps.applicationId, deps.guildId), {
      body,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fail-closed admin-role check (Section 6.6). A member is authorized only when one of
 * their roles appears in the configured admin role IDs. When no admin roles are
 * configured, nobody is authorized — restricted commands stay unusable rather than
 * open. Commands that disclose restricted content, modify channel policy, delete data,
 * approve an intervention, or force a sync must pass this check before acting.
 */
export function isAuthorizedAdmin(
  memberRoleIds: readonly string[],
  adminRoleIds: readonly string[],
): boolean {
  if (adminRoleIds.length === 0) return false;
  const admin = new Set(adminRoleIds);
  return memberRoleIds.some((id) => admin.has(id));
}
