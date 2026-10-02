// ABOUTME: Tests Slack message links and the auth.test identity check (plan 006 step 2).
// ABOUTME: Links use the parent channel in the path and thread_ts plus cid for a reply.
import { describe, it, expect } from 'vitest';
import { slackMessageLink, teamDomainFromUrl } from '../../../src/platform/slack/links.js';
import { checkSlackIdentity, SlackIdentityError } from '../../../src/platform/slack/auth.js';

describe('Slack message links', () => {
  it('links a top-level message', () => {
    expect(slackMessageLink('acme', 'C0000000001', 'C0000000001-1790933741.610379'))
      .toBe('https://acme.slack.com/archives/C0000000001/p1790933741610379');
  });

  it('links a reply into its thread', () => {
    expect(slackMessageLink('acme', 'C0000000001-T1790933759.217369', 'C0000000001-1790933763.089139'))
      .toBe('https://acme.slack.com/archives/C0000000001/p1790933763089139?thread_ts=1790933759.217369&cid=C0000000001');
  });

  it('reads the team domain from the auth.test url', () => {
    expect(teamDomainFromUrl('https://acme-dev.slack.com/')).toBe('acme-dev');
    expect(teamDomainFromUrl('https://evil.example.com/')).toBeNull();
  });
});

describe('Slack identity check', () => {
  // Recorded auth.test shape, with ids replaced.
  const auth = { teamId: 'T0000000001', userId: 'U0000000002', url: 'https://acme.slack.com/' };

  it('accepts the configured team', () => {
    expect(checkSlackIdentity(auth, 'T0000000001')).toEqual({ selfUserId: 'U0000000002', teamDomain: 'acme' });
  });

  it('stops startup for a token from another workspace', () => {
    expect(() => checkSlackIdentity(auth, 'T0000000009')).toThrow(SlackIdentityError);
  });
});
