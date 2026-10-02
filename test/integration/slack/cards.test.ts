// ABOUTME: Tests Slack review cards and button handling: blocks, markers, resolution, and every refusal path.
// ABOUTME: Approvals run the same workflow as Discord; a wrong team, channel, signature, or actor changes nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/db.js';
import { BOT_USER, conversation, fakeSlackApi, seedSlackWorkspace, TEAM } from '../../helpers/slack.js';
import { parseChannelPolicy } from '../../../src/policy/channel-policy.js';
import { runStartupSync } from '../../../src/ingestion/sync.js';
import { listSlackChannels } from '../../../src/platform/slack/discovery.js';
import { excludeSharedChannel } from '../../../src/platform/slack/channels.js';
import {
  buildSlackChannelPolicyCard,
  buildSlackProposalCard,
  channelPolicyMarkerBlockId,
  createSlackChannelPolicyPort,
  createSlackReviewResolver,
  deliverSlackProposalReview,
  SECTION_TEXT_MAX_CHARS,
  truncateMrkdwn,
  type SlackCardDeps,
} from '../../../src/platform/slack/cards.js';
import { handleSlackAction, type SlackActionDeps } from '../../../src/platform/slack/actions.js';
import { attachSocket, SlackHealthTracker, type SlackEnvelope } from '../../../src/platform/slack/connection.js';
import {
  channelPolicyReviewMarker,
  parseReviewComponent,
  signChannelPolicyReviewComponent,
  signReviewComponent,
} from '../../../src/review/controls.js';
import { getProposal, insertProposal } from '../../../src/db/repositories/proposals.js';
import type { ReviewProposalInput } from '../../../src/platform/types.js';
import type { ApprovalPolicyRecheck } from '../../../src/review/workflow.js';
import type { SlackObject } from '../../../src/platform/slack/api.js';

const REVIEW = 'C0000000009';
const TARGET = 'C0000000001';
const ADMIN = 'U0000000001';
const SECRET = 'test-secret';
const NOW = 1_790_934_200_000;
const POLICY = parseChannelPolicy(`
version: 1
default:
  ingest: true
  visibility: org
  allow_interventions: true
channels: {}
`);
const ALLOW: ApprovalPolicyRecheck = {
  provenance: { outcome: 'allow', reasons: [] },
  outboundEvidence: { outcome: 'allow', reasons: [] },
  cooldown: { allowed: true, blocks: [], retryAfterMs: null },
  duplicate: { matched: false },
};
const LINK = 'https://acme.slack.com/archives/C0000000001/p1790933741610379';

const proposalInput = (over: Partial<ReviewProposalInput> = {}): ReviewProposalInput => ({
  proposalId: '11111111-2222-3333-4444-555555555555', targetLabel: '#product', score: 0.84,
  reason: 'contradiction', proposedMessage: `We decided on SQLite [#eng · 2026-10-01](${LINK}) <!here>`, sources: [], ...over,
});

describe('Slack review cards', () => {
  let t: TestDb | undefined;
  afterEach(() => t?.cleanup());

  async function setup() {
    t = createTestDb();
    const db = t.db;
    seedSlackWorkspace(db);
    const api = fakeSlackApi();
    api.conversations.set(TARGET, conversation(TARGET));
    api.conversations.set(REVIEW, conversation(REVIEW, { is_private: true }));
    await runStartupSync({ db, guildId: TEAM, policy: POLICY, now: NOW, completeThreadSnapshot: true,
      channels: await listSlackChannels(api, db, TEAM), enqueueHistoricalBackfill: false });
    db.prepare(`INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
      VALUES ('run-1', ?, NULL, 'episode', 'pv', 'faux', 'faux-1', 'completed', ?)`).run(TEAM, NOW);
    const cardDeps: SlackCardDeps = { api, db: () => db, teamDomain: () => 'acme', selfUserId: () => BOT_USER };
    const responses: string[] = [];
    const actionDeps: SlackActionDeps = {
      db, workspaceId: TEAM, secret: SECRET, adminUserIds: [ADMIN], reviewChannelId: REVIEW,
      buildRecheck: () => ALLOW, policy: () => POLICY, channelPolicySource: 'file',
      resolveReview: createSlackReviewResolver(api), channelPolicyPort: createSlackChannelPolicyPort(cardDeps),
      respond: async (_url, text) => { responses.push(text); }, now: () => NOW,
    };
    const seedProposal = (): string => insertProposal(db, {
      runId: 'run-1', targetChannelId: TARGET, status: 'pending_review', computedScore: 0.84,
      reason: ['routed to review'], evidenceMessageIds: [], message: 'safe outbound text', expiresAtMs: null, now: NOW,
    });
    return { db, api, cardDeps, actionDeps, responses, seedProposal };
  }

  const click = (actionId: string, over: { team?: string; channel?: string; user?: string; ts?: string } = {}): SlackEnvelope => ({
    type: 'interactive',
    body: {
      type: 'block_actions', team: { id: over.team ?? TEAM }, channel: { id: over.channel ?? REVIEW },
      user: { id: over.user ?? ADMIN }, message: { ts: over.ts ?? '1790940000.000001' },
      response_url: 'https://hooks.slack.com/actions/T0/1/x', actions: [{ action_id: actionId, value: actionId }],
    },
  });

  it('builds a proposal card with signed buttons and a converted, ping-free message', () => {
    const card = buildSlackProposalCard(proposalInput({ expiresAtMs: NOW }), SECRET, 'acme');
    const actions = card.blocks.find((b) => b.type === 'actions') as { elements: SlackObject[] };
    const ids = actions.elements.map((e) => String(e.action_id));
    expect(ids.map((id) => parseReviewComponent(id, SECRET)?.action)).toEqual(['approve', 'dismiss']);
    const json = JSON.stringify(card.blocks);
    expect(json).not.toMatch(/<[!@#](?!date\^)/);
    expect(json).toContain(`<${LINK}|#eng · 2026-10-01>`);
    expect(json).toContain('Expires ');
  });

  it('keeps every section of a long proposal within the Slack limit without a broken link', () => {
    const long = `${'word & '.repeat(900)}[x](${LINK}) end`;
    const card = buildSlackProposalCard(proposalInput({ proposedMessage: long }), SECRET, 'acme');
    for (const block of card.blocks) {
      const text = (block.text as { text?: string } | undefined)?.text;
      if (text) {
        expect(text.length).toBeLessThanOrEqual(SECTION_TEXT_MAX_CHARS);
        expect(text).not.toMatch(/<[^>]*$/);
        expect(text).not.toMatch(/&[a-z]{0,4}…$/);
      }
    }
  });

  it('never cuts a Slack token or an entity in half', () => {
    expect(truncateMrkdwn(`abc <${LINK}|label> def`, 10)).toBe('abc …');
    expect(truncateMrkdwn('abcd &amp; efgh', 7)).toBe('abcd …');
  });

  it('posts a proposal card to the review channel and records it', async () => {
    const { db, api, seedProposal } = await setup();
    const id = seedProposal();
    const result = await deliverSlackProposalReview(proposalInput({ proposalId: id }),
      { db, reviewChannelId: REVIEW, secret: SECRET, now: NOW }, { api, db: () => db, teamDomain: () => 'acme', selfUserId: () => BOT_USER });
    expect(api.posted[0]?.channel).toBe(REVIEW);
    expect(getProposal(db, id)?.reviewMessageId).toBe(result.platformMessageId);
  });

  it('refuses to post a card into a Slack Connect review channel', async () => {
    const { db, api, seedProposal } = await setup();
    excludeSharedChannel(db, REVIEW, NOW + 1);
    await expect(deliverSlackProposalReview(proposalInput({ proposalId: seedProposal() }),
      { db, reviewChannelId: REVIEW, secret: SECRET, now: NOW }, { api, db: () => db, teamDomain: () => 'acme', selfUserId: () => BOT_USER }))
      .rejects.toThrow(/Slack Connect/);
    expect(api.posted).toHaveLength(0);
  });

  it('marks a channel-policy card and finds it again after a crash', async () => {
    const { api, cardDeps } = await setup();
    const card = buildSlackChannelPolicyCard({ reviewId: 'r-1', channelId: TARGET, channelName: 'product', channelKind: 'text',
      parentId: null, parentName: null }, SECRET);
    const marker = channelPolicyReviewMarker('r-1');
    expect(card.blocks.some((b) => b.block_id === channelPolicyMarkerBlockId(marker))).toBe(true);
    const port = createSlackChannelPolicyPort(cardDeps);
    expect(await port.findByMarker(REVIEW, marker)).toBeUndefined();
    api.channelMessages.set(REVIEW, [
      { ts: '1790940000.000009', user: 'U0000000077', blocks: card.blocks },
      { ts: '1790940000.000008', user: BOT_USER, blocks: card.blocks },
    ]);
    expect(await port.findByMarker(REVIEW, marker)).toEqual({ id: `${REVIEW}-1790940000.000008` });
  });

  it('finds a channel-policy card that is older than the first page of history', async () => {
    const { api, cardDeps } = await setup();
    const card = buildSlackChannelPolicyCard({ reviewId: 'r-2', channelId: TARGET, channelName: 'product', channelKind: 'text',
      parentId: null, parentName: null }, SECRET);
    const marker = channelPolicyReviewMarker('r-2');
    const newer = Array.from({ length: 150 }, (_, i) => ({
      ts: `1790940100.${String(200 - i).padStart(6, '0')}`, user: 'U0000000001', text: 'chat',
    }));
    api.channelMessages.set(REVIEW, [...newer, { ts: '1790940000.000008', user: BOT_USER, blocks: card.blocks }]);
    expect(await createSlackChannelPolicyPort(cardDeps).findByMarker(REVIEW, marker))
      .toEqual({ id: `${REVIEW}-1790940000.000008` });
  });

  it('stops looking for a channel-policy card after a bounded number of pages', async () => {
    const { api, cardDeps } = await setup();
    const marker = channelPolicyReviewMarker('r-3');
    api.channelMessages.set(REVIEW, Array.from({ length: 1000 }, (_, i) => ({
      ts: `1790940100.${String(2000 - i).padStart(6, '0')}`, user: 'U0000000001', text: 'chat',
    })));
    expect(await createSlackChannelPolicyPort(cardDeps).findByMarker(REVIEW, marker)).toBeUndefined();
    expect(api.calls.filter((c) => c.method === 'history')).toHaveLength(5);
  });

  it('resolves a card by replacing its buttons with the label', async () => {
    const { api } = await setup();
    await createSlackReviewResolver(api)({ reviewMessageId: `${REVIEW}-1790940000.000001`, label: 'Approved by <@U1>', removeControls: true });
    expect(api.updated[0]).toEqual({ channel: REVIEW, ts: '1790940000.000001', text: 'Approved by &lt;@U1&gt;' });
  });

  it('approves through the shared workflow for an admin', async () => {
    const { db, actionDeps, responses, seedProposal } = await setup();
    const id = seedProposal();
    const outcome = await handleSlackAction(actionDeps, click(signReviewComponent('approve', id, SECRET)));
    expect(outcome).toBe('handled');
    expect(getProposal(db, id)).toMatchObject({ status: 'approved', reviewedByUserId: ADMIN });
    expect(responses).toEqual(['Approved — the message is queued for delivery.']);
  });

  it.each([
    ['a bad signature', true, {}, 'ignored'],
    ['a wrong team', false, { team: 'T0000000099' }, 'refused'],
    ['a wrong channel', false, { channel: TARGET }, 'refused'],
  ] as const)('changes nothing for %s', async (_name, forged, over, expected) => {
    const { db, actionDeps, seedProposal } = await setup();
    const id = seedProposal();
    const actionId = forged ? `cass:rv:approve:${id}:0000000000000000` : signReviewComponent('approve', id, SECRET);
    expect(await handleSlackAction(actionDeps, click(actionId, over))).toBe(expected);
    expect(getProposal(db, id)?.status).toBe('pending_review');
  });

  it('changes nothing for a click after the review channel was shared with another organization', async () => {
    const { db, actionDeps, responses, seedProposal } = await setup();
    const id = seedProposal();
    excludeSharedChannel(db, REVIEW, NOW + 1);
    expect(await handleSlackAction(actionDeps, click(signReviewComponent('approve', id, SECRET)))).toBe('refused');
    expect(getProposal(db, id)?.status).toBe('pending_review');
    expect(responses[0]).toMatch(/shared with another organization/);
  });

  it('refuses a non-admin through the shared fail-closed check', async () => {
    const { db, actionDeps, responses, seedProposal } = await setup();
    const id = seedProposal();
    await handleSlackAction(actionDeps, click(signReviewComponent('approve', id, SECRET), { user: 'U0000000055' }));
    expect(getProposal(db, id)?.status).toBe('pending_review');
    expect(responses).toEqual(['You are not authorized to approve Mneme proposals.']);
  });

  it('acknowledges the envelope before the handler runs', async () => {
    const order: string[] = [];
    const listeners = new Map<string, (...args: any[]) => void>();
    const socket = { on: (e: string, l: (...args: any[]) => void) => listeners.set(e, l), start: async () => undefined, disconnect: async () => undefined };
    let done!: () => void;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    attachSocket(socket, new SlackHealthTracker(() => 1), async () => { order.push('handle'); done(); }, () => undefined);
    listeners.get('slack_event')!({ ack: async () => { order.push('ack'); }, type: 'interactive', body: {} });
    await finished;
    expect(order).toEqual(['ack', 'handle']);
  });

  it('records a click on a channel-policy card through the shared decision', async () => {
    const { api, actionDeps } = await setup();
    // An unknown review id is a missing review; the shared decision answers it.
    const outcome = await handleSlackAction(actionDeps, click(signChannelPolicyReviewComponent('org', 'missing', SECRET)));
    expect(outcome).toBe('handled');
    expect(api.updated).toHaveLength(0);
  });
});

