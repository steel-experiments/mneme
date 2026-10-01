import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  listCommandDispatcherRouteNames,
  registerCommandDispatcher,
  type CommandDispatcherDeps,
} from '../../src/discord/command-dispatcher.js';
import {
  MNEME_SUBCOMMANDS,
  MNEME_SUBCOMMAND_GROUPS,
} from '../../src/discord/commands.js';
import { handleChannelsCommand, formatChannelsReply } from '../../src/discord/commands/channels.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import type { BootstrapContext } from '../../src/bootstrap.js';

/**
 * Routing coverage for the `/mneme` command dispatcher (the route-table
 * rewrite of the former switch dispatcher).
 *
 * The handlers themselves have their own suites; this one proves the glue:
 * registration/dispatcher parity, the wrong-guild guard, a command route, a
 * real grouped/top-level name collision, representative option forwarding,
 * asynchronous routing, prototype-key rejection, and the unknown-command
 * reply. Handler suites retain detailed command-level behavior coverage.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002';
const ADMIN = '100000000000000010';
const ADMIN_ROLE = '900000000000000001';
const ADMIN_ROLES: readonly string[] = [ADMIN_ROLE];
const NOW = 1_700_000_001_000;

interface FakeOptions {
  subcommand: string;
  group: string | null;
  strings?: Readonly<Record<string, string | null>>;
  integers?: Readonly<Record<string, number | null>>;
  channels?: Readonly<Record<string, string | null>>;
  users?: Readonly<Record<string, string | null>>;
}

function fakeInteraction(opts: FakeOptions): Record<string, unknown> {
  const replies: string[] = [];
  const state = { deferred: false, replied: false };
  return {
    commandName: 'mneme',
    guildId: GUILD,
    channelId: CHANNEL,
    user: { id: ADMIN },
    member: { roles: [...ADMIN_ROLES] },
    get deferred() { return state.deferred; },
    get replied() { return state.replied; },
    isChatInputCommand: () => true,
    deferReply: async () => { state.deferred = true; },
    reply: async (payload: { content: string }) => { state.replied = true; replies.push(payload.content); },
    editReply: async (payload: { content: string }) => { replies.push(payload.content); },
    options: {
      getSubcommand: () => opts.subcommand,
      getSubcommandGroup: () => opts.group,
      getString: (name: string, required = false) => {
        const value = opts.strings?.[name] ?? null;
        if (required && value === null) throw new Error(`required string option ${name} is missing`);
        return value;
      },
      getInteger: (name: string, required = false) => {
        const value = opts.integers?.[name] ?? null;
        if (required && value === null) throw new Error(`required integer option ${name} is missing`);
        return value;
      },
      getUser: (name: string) => ({ id: opts.users?.[name] ?? '' }),
      getChannel: (name: string, required = false) => {
        const id = opts.channels?.[name] ?? null;
        if (required && id === null) throw new Error(`required channel option ${name} is missing`);
        return id === null ? null : { id };
      },
    },
    __replies: replies,
  };
}

function makeDeps(db: DatabaseSync, ctxOverrides: Record<string, unknown> = {}): {
  deps: CommandDispatcherDeps;
  handler: (raw: unknown) => Promise<void>;
} {
  let handler: ((raw: unknown) => Promise<void>) | undefined;
  const client = { on: (_event: string, cb: (raw: unknown) => Promise<void>) => { handler = cb; } };
  const ctx = {
    now: () => NOW,
    db,
    config: {
      workspaceId: GUILD,
      adminRoleIds: ADMIN_ROLES,
      deletionApproverUserIds: [ADMIN],
      mcp: { enabled: false },
      inspector: { enabled: false },
      historicalMemory: { campaignId: undefined },
      deepRecap: { enabled: true, maxWindowDays: 30, maxBudgetUsd: 20 },
      reviewChannelId: null,
      mode: 'observe',
    },
    configuredMode: 'observe',
    snapshot: { channelPolicy: { review_channel: null } },
    logger: { warn: () => undefined },
    ...ctxOverrides,
  } as unknown as BootstrapContext;
  const deps: CommandDispatcherDeps = {
    ctx,
    discord: { client },
    buildApprovalRecheck: () => { throw new Error('not used by these routes'); },
  };
  registerCommandDispatcher(deps);
  if (!handler) throw new Error('handler was not registered');
  return { deps, handler: handler as (raw: unknown) => Promise<void> };
}

/** Run one command through the real dispatcher seam and capture the reply text. */
async function runCommand(
  db: DatabaseSync,
  opts: FakeOptions,
  ctxOverrides: Record<string, unknown> = {},
): Promise<string[]> {
  const { handler } = makeDeps(db, ctxOverrides);
  const interaction = fakeInteraction(opts);
  await handler(interaction);
  const replies = (interaction.__replies as string[]);
  if (replies.length === 0) throw new Error('dispatcher produced no reply');
  return replies;
}

describe('command dispatcher routing', () => {
  let env: TestDb;
  let db: DatabaseSync;

  beforeEach(() => {
    env = createTestDb();
    db = env.db;
    seedIdentity(db, GUILD);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('routes the user picker to a request and grouped approval to the dedicated approver gate', async () => {
    const { deps, handler } = makeDeps(db);
    deps.ctx.config.reviewChannelId = CHANNEL;
    deps.ctx.snapshot!.channelPolicy.review_channel = { id: CHANNEL, secure: true, accepts_scopes: ['org', 'restricted', 'review_only'] };
    const userId = '100000000000000003';
    db.prepare(`INSERT INTO messages (id,workspace_id,channel_id,author_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms)
      VALUES ('800000000000000001',?,?,?,'Alice','keep me',?,?,?)`).run(GUILD, CHANNEL, userId, NOW, NOW, NOW);
    const interaction = fakeInteraction({ subcommand: 'forget-user', group: null, users: { user: userId } });
    await handler(interaction);
    const row = db.prepare('SELECT id,target_id,status FROM deletion_requests').get()!;
    expect(row).toMatchObject({ target_id: userId, status: 'pending' });
    expect(db.prepare('SELECT content FROM messages').get()?.content).toBe('keep me');
    const approval = fakeInteraction({ subcommand: 'approve', group: 'deletion', strings: { id: String(row.id), confirmation: 'DELETE' } });
    await handler(approval);
    expect(JSON.stringify(approval.__replies)).toContain('cannot approve your own');
    expect(deps.ctx.db.prepare('SELECT status FROM deletion_requests').get()?.status).toBe('pending');
  });

  it('covers every declarative command and group route', () => {
    expect(listCommandDispatcherRouteNames()).toEqual({
      commands: MNEME_SUBCOMMANDS.map((command) => command.name),
      groups: MNEME_SUBCOMMAND_GROUPS.map((group) => group.name),
    });
  });

  it('rejects interactions from another guild before any route runs', async () => {
    const replies = await runCommand(db, { subcommand: 'channels', group: null },
      { config: { workspaceId: '999999999999999999', adminRoleIds: ADMIN_ROLES, mcp: { enabled: false } } });
    expect(replies).toEqual(['This command only works in the configured server.']);
  });

  it('routes a plain subcommand through the command table', async () => {
    const base = { actorUserId: ADMIN, guildId: GUILD, memberRoleIds: ADMIN_ROLES };
    const expected = formatChannelsReply(
      handleChannelsCommand(base, { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW }));
    expect(await runCommand(db, { subcommand: 'channels', group: null })).toEqual([expected]);
  });

  it('gives a known group precedence when its subcommand name also exists at the top level', async () => {
    expect(await runCommand(db, { subcommand: 'status', group: 'historical' }))
      .toEqual(['No bounded historical campaign is configured.']);
  });

  it('falls through an unknown group to the command table', async () => {
    const base = { actorUserId: ADMIN, guildId: GUILD, memberRoleIds: ADMIN_ROLES };
    const expected = formatChannelsReply(
      handleChannelsCommand(base, { db, adminRoleIds: ADMIN_ROLES, nowMs: NOW }));
    expect(await runCommand(db, { subcommand: 'channels', group: 'not-a-group' })).toEqual([expected]);
  });

  it('replies with the unknown-command text for an unrecognized subcommand', async () => {
    expect(await runCommand(db, { subcommand: 'nonsense', group: null }))
      .toEqual(['Unknown Mneme command.']);
  });

  it('does not resolve inherited object-property names as routes', async () => {
    expect(await runCommand(db, { subcommand: 'constructor', group: null }))
      .toEqual(['Unknown Mneme command.']);
    expect(await runCommand(db, { subcommand: 'nonsense', group: 'constructor' }))
      .toEqual(['Unknown Mneme command.']);
  });

  it('forwards a required id through an asynchronous route', async () => {
    expect(await runCommand(db, {
      subcommand: 'dismiss',
      group: null,
      strings: { id: 'missing-proposal' },
    })).toEqual(['This proposal could not be found.']);
  });

  it('forwards the required mode value option', async () => {
    expect(await runCommand(db, {
      subcommand: 'mode',
      group: null,
      strings: { value: 'bogus-mode' },
    })).toEqual(['Unknown mode. Choose configured, observe, review, or autonomous.']);
  });

  it('forwards the required memory search query option', async () => {
    expect(await runCommand(db, {
      subcommand: 'memory-search',
      group: null,
      strings: { query: 'needle42' },
    })).toEqual([
      'No org memories matched. Restricted and review-only memory is only searchable from the secure review channel.',
    ]);

    const event = db.prepare(`
      SELECT details_json
        FROM admin_events
       WHERE action = 'memory_search'
       ORDER BY created_at_ms DESC, rowid DESC
       LIMIT 1
    `).get() as { details_json: string };
    expect(JSON.parse(event.details_json)).toMatchObject({ query: 'needle42' });
  });

  it('forwards string, integer, and channel options through a grouped route', async () => {
    const replies = await runCommand(db, {
      subcommand: 'start',
      group: 'recap',
      strings: { topic: 'delivery risks' },
      integers: { days: 3, 'budget-usd': 7 },
      channels: { channel: CHANNEL },
    });
    expect(replies[0]).toMatch(/^Deep recap [0-9a-f]{8} queued\./);

    const request = db.prepare(`
      SELECT target_channel_id, requested_by_user_id, topic, channel_ids_json,
             after_at_ms, before_at_ms, budget_usd
        FROM deep_recap_requests
    `).get() as {
      target_channel_id: string;
      requested_by_user_id: string;
      topic: string | null;
      channel_ids_json: string;
      after_at_ms: number;
      before_at_ms: number;
      budget_usd: number;
    };
    expect(request).toMatchObject({
      target_channel_id: CHANNEL,
      requested_by_user_id: ADMIN,
      topic: 'delivery risks',
      after_at_ms: NOW - 3 * 86_400_000,
      before_at_ms: NOW,
      budget_usd: 7,
    });
    expect(JSON.parse(request.channel_ids_json)).toEqual([CHANNEL]);
  });
});
