// ABOUTME: Checks the Slack bot identity from `auth.test` at startup (spec Section 6.7.1).
// ABOUTME: A token for another workspace stops startup: it fails closed.
import { teamDomainFromUrl } from './links.js';

export class SlackIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackIdentityError';
  }
}

export interface SlackIdentity {
  selfUserId: string;
  teamDomain: string;
}

/** Validate an `auth.test` result against the configured team. */
export function checkSlackIdentity(
  auth: { teamId: string; userId: string; url: string },
  expectedTeamId: string,
): SlackIdentity {
  if (auth.teamId !== expectedTeamId) {
    throw new SlackIdentityError('the Slack bot token belongs to a different workspace than SLACK_TEAM_ID');
  }
  if (!auth.userId) throw new SlackIdentityError('auth.test returned no bot user id');
  const teamDomain = teamDomainFromUrl(auth.url);
  if (!teamDomain) throw new SlackIdentityError('auth.test returned no workspace url');
  return { selfUserId: auth.userId, teamDomain };
}
