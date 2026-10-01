import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { insertProposal, getProposal } from '../../src/db/repositories/proposals.js';
import { buildReviewMessage, signReviewComponent, parseReviewComponent, createDiscordReviewChannel, deliverProposalReview, type ReviewMessagePayload, type ReviewChannel } from '../../src/platform/discord/review-message.js';
import type { ReviewProposalInput } from '../../src/platform/types.js';
import type { Client } from 'discord.js';
import { createDiscordReviewResolver } from '../../src/platform/discord/interactions.js';

/**
 * Secure-channel review proposal message (Section 25).
 *
 * Acceptance: review mode produces one auditable review message containing only
 * content accepted by the secure-channel scope, with signed Approve/Dismiss
 * controls and the review Discord id recorded on the proposal.
 */

const GUILD = '100000000000000001';
const REVIEW_CHANNEL = '100000000000000009';
const NOW = 1_700_000_001_000;
const SECRET = 'review-component-secret';

const PROPOSAL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function basicInput(over: Partial<ReviewProposalInput> = {}): ReviewProposalInput {
  return {
    proposalId: PROPOSAL_ID,
    targetLabel: '#product',
    score: 0.84,
    reason: 'Current plan appears to supersede an active onboarding decision.',
    proposedMessage: 'Heads up: the onboarding trial was superseded.',
    sources: ['https://discord.com/channels/g/c/m1', 'https://discord.com/channels/g/c/m2'],
    ...over,
  };
}

describe('buildReviewMessage — embed content and controls', () => {
  it('renders target, score, reason, proposed text, and sources in one embed', () => {
    const { embeds, components } = buildReviewMessage(basicInput(), SECRET);
    expect(embeds).toHaveLength(1);
    const embed = embeds[0]!.data;
    expect(embed.title).toBe(`Mneme proposal ${PROPOSAL_ID.slice(0, 8)}`);
    expect(embed.description).toContain('Proposed message:');
    expect(embed.description).toContain('Heads up: the onboarding trial was superseded.');
    expect(embed.description).toContain('Sources:');
    expect(embed.description).toContain('discord.com/channels/g/c/m1');

    const fields = embed.fields ?? [];
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    expect(byName['Target']).toBe('#product');
    expect(byName['Score']).toBe('0.84');
    expect(byName['Reason']).toContain('supersede');

    // One row with Approve + Dismiss.
    expect(components).toHaveLength(1);
    const buttons = components[0]!.components;
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.data.label).toBe('Approve');
    expect(buttons[1]!.data.label).toBe('Dismiss');
  });

  it('caps sources at three (Section 24.5)', () => {
    const { embeds } = buildReviewMessage(
      basicInput({ sources: ['a', 'b', 'c', 'd', 'e'] }),
      SECRET,
    );
    const desc = embeds[0]!.data.description ?? '';
    expect(desc.match(/^- /gm)?.length).toBe(3);
  });

  it('includes the expiry footer when provided', () => {
    const { embeds } = buildReviewMessage(basicInput({ expiresAtMs: NOW + 72 * 3600_000 }), SECRET);
    expect(embeds[0]!.data.footer?.text).toContain('Expires');
  });

  it('shows a categorical assessment instead of a synthetic score for scheduled reviews', () => {
    const { embeds } = buildReviewMessage(
      basicInput({
        assessment: 'Recommended scheduled review',
        recommendationReason: 'The checkpoint remains material.',
        reason: 'recommended; routed to secure review',
        score: 1,
      }),
      SECRET,
    );
    const fields = embeds[0]!.data.fields ?? [];
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    expect(byName['Assessment']).toBe('Recommended scheduled review');
    expect(byName['Score']).toBeUndefined();
    expect(byName['Recommendation']).toBe('The checkpoint remains material.');
    expect(byName['Routing']).toBe('recommended; routed to secure review');
    expect(byName['Reason']).toBeUndefined();
  });

  it('bounds a long review reason to Discord embed field limits', () => {
    const { embeds } = buildReviewMessage(basicInput({ reason: 'r'.repeat(1200) }), SECRET);
    const reason = embeds[0]!.data.fields?.find((field) => field.name === 'Reason')?.value ?? '';
    expect(reason).toHaveLength(1024);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('bounds a long scheduled recommendation without hiding host routing', () => {
    const { embeds } = buildReviewMessage(
      basicInput({
        assessment: 'Recommended scheduled review',
        recommendationReason: 'r'.repeat(1200),
        reason: 'recommended; routed to secure review',
      }),
      SECRET,
    );
    const fields = embeds[0]!.data.fields ?? [];
    const recommendation = fields.find((field) => field.name === 'Recommendation')?.value ?? '';
    const routing = fields.find((field) => field.name === 'Routing')?.value;
    expect(recommendation).toHaveLength(1024);
    expect(recommendation.endsWith('…')).toBe(true);
    expect(routing).toBe('recommended; routed to secure review');
  });

  it('quotes every proposed-message line so model text cannot mimic card sections', () => {
    const { embeds } = buildReviewMessage(
      basicInput({ proposedMessage: 'First line\nSources:\n- fake source' }),
      SECRET,
    );
    expect(embeds[0]!.data.description).toContain(
      'Proposed message:\n> First line\n> Sources:\n> - fake source',
    );
  });

  it('keeps a maximally newline-heavy proposed message within Discord description limits', () => {
    const { embeds } = buildReviewMessage(
      basicInput({ proposedMessage: '\n'.repeat(1799) }),
      SECRET,
    );
    expect(embeds[0]!.data.description!.length).toBeLessThanOrEqual(4096);
  });

  it('omits the footer when no expiry is provided', () => {
    const { embeds } = buildReviewMessage(basicInput(), SECRET);
    expect(embeds[0]!.data.footer).toBeUndefined();
  });

  it('uses a custom short id in the title when provided', () => {
    const { embeds } = buildReviewMessage(basicInput({ shortId: 'cass-42' }), SECRET);
    expect(embeds[0]!.data.title).toBe('Mneme proposal cass-42');
  });
});

describe('signReviewComponent / parseReviewComponent — signed controls', () => {
  it('round-trips approve and dismiss custom ids', () => {
    for (const action of ['approve', 'dismiss'] as const) {
      const id = signReviewComponent(action, PROPOSAL_ID, SECRET);
      expect(parseReviewComponent(id, SECRET)).toEqual({ action, proposalId: PROPOSAL_ID });
    }
  });

  it('keeps the custom id under Discord’s 100-character limit', () => {
    const id = signReviewComponent('approve', PROPOSAL_ID, SECRET);
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it('rejects a signature verified with the wrong secret', () => {
    const id = signReviewComponent('approve', PROPOSAL_ID, SECRET);
    expect(parseReviewComponent(id, 'different-secret')).toBeUndefined();
  });

  it('rejects a tampered proposal id (signature no longer matches)', () => {
    const id = signReviewComponent('approve', PROPOSAL_ID, SECRET);
    const tampered = id.replace(PROPOSAL_ID, '00000000-0000-0000-0000-000000000000');
    expect(parseReviewComponent(tampered, SECRET)).toBeUndefined();
  });

  it('rejects malformed ids and unknown actions', () => {
    expect(parseReviewComponent('not-a-review-id', SECRET)).toBeUndefined();
    expect(parseReviewComponent('cass:rv:delete:p:sig', SECRET)).toBeUndefined();
    expect(parseReviewComponent('other:rv:approve:p:sig', SECRET)).toBeUndefined();
  });

  it('buttons in the built message carry valid signatures', () => {
    const { components } = buildReviewMessage(basicInput(), SECRET);
    const [approve, dismiss] = components[0]!.components;
    expect(parseReviewComponent(approve!.data.custom_id!, SECRET)?.action).toBe('approve');
    expect(parseReviewComponent(dismiss!.data.custom_id!, SECRET)?.action).toBe('dismiss');
  });
});

describe('createDiscordReviewChannel — delivery', () => {
  function fakeClient(channel: unknown): Client {
    return { channels: { fetch: async () => channel } } as unknown as Client;
  }

  it('sends the embeds and components to the channel and returns its id', async () => {
    let captured: { embeds: unknown[]; components: unknown[] } | undefined;
    const channel = {
      isSendable: () => true,
      send: async (opts: { embeds: unknown[]; components: unknown[] }) => {
        captured = opts;
        return { id: 'review-msg-9' };
      },
    };
    const payload = buildReviewMessage(basicInput(), SECRET);
    const res = await createDiscordReviewChannel(fakeClient(channel)).send(REVIEW_CHANNEL, payload);
    expect(res.platformMessageId).toBe('review-msg-9');
    expect(captured!.embeds).toHaveLength(1);
    expect(captured!.components).toHaveLength(1);
  });

  it('throws when the review channel is not sendable', async () => {
    await expect(
      createDiscordReviewChannel(fakeClient({ isSendable: () => false })).send(
        REVIEW_CHANNEL,
        buildReviewMessage(basicInput(), SECRET),
      ),
    ).rejects.toThrow(/not sendable/);
  });
});

describe('createDiscordReviewResolver — actionable blocked state', () => {
  function resolverClient(patches: unknown[]): Client {
    return {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({ edit: async (patch: unknown) => { patches.push(patch); } }),
          },
        }),
      },
    } as unknown as Client;
  }

  it('keeps controls when an approval is blocked but the proposal remains pending', async () => {
    const patches: Array<{ components?: unknown[] }> = [];
    await createDiscordReviewResolver(resolverClient(patches), REVIEW_CHANNEL)({
      reviewMessageId: 'review-msg-1',
      label: '⛔ Not sent: policy check failed',
      removeControls: false,
    });
    expect(patches[0]).not.toHaveProperty('components');
  });

  it('removes controls after a terminal resolution', async () => {
    const patches: Array<{ components?: unknown[] }> = [];
    await createDiscordReviewResolver(resolverClient(patches), REVIEW_CHANNEL)({
      reviewMessageId: 'review-msg-1',
      label: '✅ Approved — delivery queued',
      removeControls: true,
    });
    expect(patches[0]?.components).toEqual([]);
  });
});

describe('deliverProposalReview — records the review message', () => {
  let env: TestDb;

  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    env.db
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
         VALUES (?,?,NULL,'episode','pv','faux','faux-1','completed',?)`,
      )
      .run('run-1', GUILD, NOW);
  });
  afterEach(() => env.cleanup());

  function seedPendingProposal(): string {
    return insertProposal(env.db, {
      runId: 'run-1',
      targetChannelId: '100000000000000002',
      status: 'pending_review',
      computedScore: 0.84,
      reason: ['routed to review'],
      evidenceMessageIds: ['m1'],
      now: NOW,
    });
  }

  function fakeReviewChannel(discordId = 'review-msg-1'): {
    channel: ReviewChannel;
    captured: ReviewMessagePayload[];
    sentTo: string[];
  } {
    const captured: ReviewMessagePayload[] = [];
    const sentTo: string[] = [];
    const channel: ReviewChannel = {
      async send(channelId, payload) {
        sentTo.push(channelId);
        captured.push(payload);
        return { platformMessageId: discordId };
      },
    };
    return { channel, captured, sentTo };
  }

  it('posts to the review channel and stores the review message id on the proposal', async () => {
    const proposalId = seedPendingProposal();
    const { channel, sentTo } = fakeReviewChannel('review-msg-7');

    const res = await deliverProposalReview(
      { ...basicInput(), proposalId },
      { db: env.db, reviewChannelId: REVIEW_CHANNEL, channel, secret: SECRET, now: NOW },
    );

    expect(res.platformMessageId).toBe('review-msg-7');
    expect(sentTo).toEqual([REVIEW_CHANNEL]);
    const proposal = getProposal(env.db, proposalId)!;
    expect(proposal.reviewMessageId).toBe('review-msg-7');
    expect(proposal.updatedAtMs).toBe(NOW);
    // Status is unchanged — approval/dismissal sets the reviewed_* fields.
    expect(proposal.status).toBe('pending_review');
    expect(proposal.reviewedAtMs).toBeNull();
  });

  it('delivers only the scope-cleared proposed text and permitted sources (no hidden content)', async () => {
    const proposalId = seedPendingProposal();
    const { channel, captured } = fakeReviewChannel();

    await deliverProposalReview(
      {
        proposalId,
        targetLabel: '#product',
        score: 0.9,
        reason: 'routed to review',
        proposedMessage: 'safe proposed text only',
        sources: ['link-1'],
      },
      { db: env.db, reviewChannelId: REVIEW_CHANNEL, channel, secret: SECRET, now: NOW },
    );

    const desc = captured[0]!.embeds[0]!.data.description ?? '';
    expect(desc).toContain('safe proposed text only');
    expect(desc).toContain('link-1');
  });
});
