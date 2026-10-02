// ABOUTME: The declarative `/mneme` command surface (spec Section 27), shared by every platform.
// ABOUTME: Discord registers it as slash subcommands; the Slack parser reads the same spec.

export const MNEME_COMMAND_NAME = 'mneme';
export const MNEME_ROOT_DESCRIPTION =
  'Mneme organizational memory and admin commands.';

/** Option kinds declared on subcommands. */
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

