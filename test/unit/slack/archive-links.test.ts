// ABOUTME: Tests that Slack renders only the host-built links of the verified platform archive (plan 011 step 7).
// ABOUTME: Other Discord links stay escaped plain text, and archive text can never produce a ping.
import { describe, it, expect, afterEach } from 'vitest';
import { toSlackMrkdwn } from '../../../src/platform/slack/mrkdwn.js';
import { buildSlackProposalCard } from '../../../src/platform/slack/cards.js';
import { createSlackResponder } from '../../../src/platform/slack/respond.js';
import { isHostBuiltArchiveLink, useArchiveLinkTarget } from '../../../src/platform/links.js';
import { archiveSourceLink } from '../../../src/outbound/message-safety.js';

const ARCHIVE_GUILD = '300000000000000001';
const OTHER_GUILD = '300000000000000099';
const CHANNEL = '300000000000000010';
const MESSAGE = '300000000000000110';
const ARCHIVE_URL = `https://discord.com/channels/${ARCHIVE_GUILD}/${CHANNEL}/${MESSAGE}`;

afterEach(() => useArchiveLinkTarget(null));

describe('archive links on Slack', () => {
  it('renders a host-built archive link as a Slack link when the archive is verified', () => {
    useArchiveLinkTarget({ platform: 'discord', workspaceId: ARCHIVE_GUILD });
    const link = archiveSourceLink({
      archiveId: `archive:${MESSAGE}`, channelId: CHANNEL, channelName: 'general', createdAtMs: 1_780_000_000_000, url: ARCHIVE_URL,
    });
    const out = toSlackMrkdwn(`Decided earlier ${link.masked}.`, { teamDomain: 'acme', archiveLinks: true });
    expect(out).toContain(`<${ARCHIVE_URL}|archive · #general · 2026-05-28>`);
  });

  it('keeps an archive-shaped link as plain text when no archive is verified', () => {
    const out = toSlackMrkdwn(`[old](${ARCHIVE_URL})`, { teamDomain: 'acme' });
    expect(out).not.toContain(`<${ARCHIVE_URL}|`);
    expect(out).toContain(`old (${ARCHIVE_URL})`);
  });

  it('keeps a link to another Discord workspace or a lookalike host as plain text', () => {
    useArchiveLinkTarget({ platform: 'discord', workspaceId: ARCHIVE_GUILD });
    for (const url of [
      `https://discord.com/channels/${OTHER_GUILD}/${CHANNEL}/${MESSAGE}`,
      `https://discord.com.evil.example/channels/${ARCHIVE_GUILD}/${CHANNEL}/${MESSAGE}`,
      `http://discord.com/channels/${ARCHIVE_GUILD}/${CHANNEL}/${MESSAGE}`,
      `${ARCHIVE_URL}?x=1`,
      `${ARCHIVE_URL}|<!here>`,
    ]) {
      expect(isHostBuiltArchiveLink(url)).toBe(false);
      expect(toSlackMrkdwn(`[x](${url})`, { teamDomain: 'acme', archiveLinks: true })).not.toMatch(/<https:\/\/discord/u);
    }
  });

  it('never lets an archive channel name or answer text produce a ping', () => {
    useArchiveLinkTarget({ platform: 'discord', workspaceId: ARCHIVE_GUILD });
    const link = archiveSourceLink({
      archiveId: `archive:${MESSAGE}`, channelId: CHANNEL, channelName: '<!here>|<@U012345678>', createdAtMs: 0, url: ARCHIVE_URL,
    });
    const out = toSlackMrkdwn(`Old note <!channel> ${link.masked}`, { teamDomain: 'acme', archiveLinks: true });
    expect(out).not.toMatch(/<!(?:here|channel|everyone)/u);
    expect(out).not.toMatch(/<@U/u);
    expect(out).toContain(`<${ARCHIVE_URL}|`);
  });

  it('keeps an archive link as plain text unless the caller opts in', () => {
    useArchiveLinkTarget({ platform: 'discord', workspaceId: ARCHIVE_GUILD });
    const out = toSlackMrkdwn(`[Approve here](${ARCHIVE_URL})`, { teamDomain: 'acme' });
    expect(out).not.toContain(`<${ARCHIVE_URL}|`);
    expect(out).toContain(`Approve here (${ARCHIVE_URL})`);
  });

  it('keeps an archive link in a review card reason as plain text', () => {
    useArchiveLinkTarget({ platform: 'discord', workspaceId: ARCHIVE_GUILD });
    const card = buildSlackProposalCard({
      proposalId: 'proposal-archive-link', targetLabel: '#general', score: 0.9,
      reason: `[Approve here](${ARCHIVE_URL})`, recommendationReason: `[See](${ARCHIVE_URL})`,
      proposedMessage: 'A message.', sources: [`[Source](${ARCHIVE_URL})`],
    }, 'secret', 'acme');
    expect(JSON.stringify(card)).not.toContain(`<${ARCHIVE_URL}|`);
  });

  it('keeps an archive link in a command reply as plain text', async () => {
    useArchiveLinkTarget({ platform: 'discord', workspaceId: ARCHIVE_GUILD });
    const bodies: string[] = [];
    const respond = createSlackResponder(() => 'acme', (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch);
    await respond('https://hooks.slack.com/commands/T0/1/x', `[Approve here](${ARCHIVE_URL})`);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(`<${ARCHIVE_URL}|`);
  });
});
