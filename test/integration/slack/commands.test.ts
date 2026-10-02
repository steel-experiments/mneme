// ABOUTME: Tests the Slack `/mneme` handler: refusals, admin checks, parity with the shared routes, and replies.
// ABOUTME: Uses the recorded slash-command fixture for the payload shape and a fake responder at the boundary.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { conversation, fakeSlackApi, seedSlackWorkspace, TEAM } from '../../helpers/slack.js';
import { parseChannelPolicy } from '../../../src/policy/channel-policy.js';
import { runStartupSync } from '../../../src/ingestion/sync.js';
import { listSlackChannels } from '../../../src/platform/slack/discovery.js';
import { excludeSharedChannel } from '../../../src/platform/slack/channels.js';
import { handleSlackCommand, SLACK_COMMAND_FAILED, type SlackCommandDeps } from '../../../src/platform/slack/commands.js';
import { attachSocket, SlackHealthTracker, type SlackEnvelope } from '../../../src/platform/slack/connection.js';
import { handleChannelsCommand, formatChannelsReply } from '../../../src/commands/channels.js';
import type { BootstrapContext } from '../../../src/bootstrap.js';

const CHANNEL = 'C0000000001';
const REVIEW = 'C0000000009';
const ADMIN = 'U0000000001';
const NOW = 1_790_934_200_000;
const FIXTURES = fileURLToPath(new URL('../../fixtures/slack/events/', import.meta.url));
const POLICY = parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: org
  allow_interventions: false
channels: {}
`);

function slashFixture(): SlackEnvelope {
  const name = readdirSync(FIXTURES).find((f) => f.startsWith('25-'))!;
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as SlackEnvelope;
}

describe('Slack /mneme handler', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  async function setup() {
    t = createTestDb();
    const db = t.db;
    seedSlackWorkspace(db);
    const api = fakeSlackApi();
    api.conversations.set(CHANNEL, conversation(CHANNEL));
    api.conversations.set(REVIEW, conversation(REVIEW, { is_private: true }));
    await runStartupSync({ db, guildId: TEAM, policy: POLICY, now: NOW, completeThreadSnapshot: true,
      channels: await listSlackChannels(api, db, TEAM), enqueueHistoricalBackfill: false });
    const ctx = {
      now: () => NOW, db,
      config: {
        workspaceId: TEAM, adminRoleIds: [], deletionApproverUserIds: [ADMIN], mcp: { enabled: false },
        inspector: { enabled: false }, historicalMemory: { campaignId: undefined },
        deepRecap: { enabled: true, maxWindowDays: 30, maxBudgetUsd: 20 }, reviewChannelId: REVIEW, mode: 'observe',
      },
      configuredMode: 'observe', snapshot: { channelPolicy: POLICY }, logger: { warn: () => undefined },
    } as unknown as BootstrapContext;
    const replies: string[] = [];
    const warnings: unknown[] = [];
    const deps: SlackCommandDeps = {
      workspaceId: TEAM, adminUserIds: [ADMIN],
      routes: { ctx, buildApprovalRecheck: () => { throw new Error('not used'); } },
      respond: async (url, text) => {
        expect(url).toBe('https://hooks.slack.com/commands/T0/1/x');
        replies.push(text);
      },
      logger: { warn: (...args: unknown[]) => { warnings.push(args); } },
    };
    const command = (text: string, over: Record<string, unknown> = {}): SlackEnvelope => {
      const fixture = slashFixture();
      return { type: fixture.type, body: { ...fixture.body, command: '/mneme', team_id: TEAM, channel_id: CHANNEL,
        channel_name: 'general', user_id: ADMIN, response_url: 'https://hooks.slack.com/commands/T0/1/x', text, ...over } };
    };
    return { db, ctx, deps, replies, warnings, command };
  }

  it('uses the recorded slash command payload shape', () => {
    // The fixture scrubber removed `response_url` and `trigger_id`; the README records them.
    const body = slashFixture().body;
    for (const key of ['command', 'channel_id', 'user_id', 'team_id', 'text']) expect(body).toHaveProperty(key);
    expect(body).not.toHaveProperty('thread_ts');
  });

  it('answers channels with the same text as the shared route', async () => {
    const { db, deps, replies, command } = await setup();
    expect(await handleSlackCommand(deps, command('channels'))).toBe('handled');
    const expected = formatChannelsReply(handleChannelsCommand(
      { actorUserId: ADMIN, guildId: TEAM, memberRoleIds: [ADMIN] },
      { db, adminRoleIds: [ADMIN], nowMs: NOW },
    ));
    expect(replies).toEqual([expected]);
  });

  it('refuses a non-admin through the shared fail-closed check', async () => {
    const { deps, replies, command } = await setup();
    await handleSlackCommand(deps, command('channels', { user_id: 'U0000000055' }));
    expect(replies[0]).toMatch(/not authorized/i);
  });

  it('refuses another workspace', async () => {
    const { deps, replies, command } = await setup();
    expect(await handleSlackCommand(deps, command('channels', { team_id: 'T0000000099' }))).toBe('refused');
    expect(replies).toEqual(['This command only works in the configured workspace.']);
  });

  it.each([
    ['a DM', { channel_id: 'D0000000001', channel_name: 'directmessage' }],
    ['a group DM', { channel_id: 'C0000000005', channel_name: 'mpdm-a--b-1' }],
  ])('refuses %s', async (_name, over) => {
    const { deps, replies, command } = await setup();
    expect(await handleSlackCommand(deps, command('channels', over))).toBe('refused');
    expect(replies).toEqual(['Use /mneme in a workspace channel.']);
  });

  it('refuses a channel shared with another organization', async () => {
    const { db, deps, replies, command } = await setup();
    excludeSharedChannel(db, CHANNEL, NOW + 1);
    expect(await handleSlackCommand(deps, command('channels'))).toBe('refused');
    expect(replies[0]).toMatch(/not shared with another organization/);
  });

  it('applies the deletion review-channel rule unchanged', async () => {
    const { deps, replies, command } = await setup();
    await handleSlackCommand(deps, command('deletion status'));
    expect(replies[0]).toMatch(/review channel/i);
  });

  it('answers a parse error and help with usage', async () => {
    const { deps, replies, command } = await setup();
    expect(await handleSlackCommand(deps, command(''))).toBe('help');
    expect(await handleSlackCommand(deps, command('approve'))).toBe('help');
    expect(replies[0]).toContain('/mneme status');
    expect(replies[1]).toMatch(/id is required/);
  });

  it('logs only the command name when a route fails', async () => {
    const { deps, replies, warnings, command } = await setup();
    const failingClock = (): number => { throw new Error('clock failed'); };
    const broken = { ...deps, routes: { ...deps.routes, ctx: { ...deps.routes.ctx, now: failingClock } as unknown as BootstrapContext } };
    expect(await handleSlackCommand(broken, command('channels'))).toBe('failed');
    expect(replies).toEqual([SLACK_COMMAND_FAILED]);
    expect(JSON.stringify(warnings)).toContain('"command":"channels"');
  });

  it('acknowledges the envelope before the command runs', async () => {
    const order: string[] = [];
    const listeners = new Map<string, (...args: any[]) => void>();
    const socket = { on: (e: string, l: (...args: any[]) => void) => listeners.set(e, l), start: async () => undefined, disconnect: async () => undefined };
    let done!: () => void;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    attachSocket(socket, new SlackHealthTracker(() => 1), async () => { order.push('command'); done(); }, () => undefined);
    listeners.get('slack_event')!({ ack: async () => { order.push('ack'); }, type: 'slash_commands', body: {} });
    await finished;
    expect(order).toEqual(['ack', 'command']);
  });
});
