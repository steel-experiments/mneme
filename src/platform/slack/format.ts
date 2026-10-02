// ABOUTME: Slack text conventions for mention parsing (spec Section 24.5).
// ABOUTME: Slack mentions are `<@U…>`, `<!subteam^S…>`, `<!channel>`, `<!everyone>`, and `<!here>`.
import type { ParsedMention, PlatformFormat } from '../types.js';

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>|<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>|<!(channel|everyone|here)(?:\|[^>]*)?>/g;
const INDIVIDUAL = /<@[UW][A-Z0-9]+(?:\|[^>]*)?>/;

export const slackFormat: PlatformFormat = {
  parseMentions(content: string): ParsedMention[] {
    const out: ParsedMention[] = [];
    for (const m of content.matchAll(MENTION)) {
      if (m[1]) out.push({ raw: m[0], kind: 'user', id: m[1] });
      else if (m[2]) out.push({ raw: m[0], kind: 'role', id: m[2] });
      else out.push({ raw: m[0], kind: m[3] === 'here' ? 'here' : 'everyone' });
    }
    return out;
  },
  hasIndividualMention(content: string): boolean {
    return INDIVIDUAL.test(content);
  },
};
