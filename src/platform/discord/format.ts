// ABOUTME: Discord text conventions for the core: mention parsing (Section 24.5).
// ABOUTME: The core reads mention syntax only through this format object.
import type { ParsedMention, PlatformFormat } from '../types.js';

// Discord snowflake mention tokens. `<@id>` and `<@!id>` are user mentions (the
// `!` is the legacy nickname-ping prefix); `<@&id>` is a role mention. Channel
// (`<#id>`), emoji, and slash-command tokens are not pings and are ignored.
const USER_MENTION = /<@!?(\d{17,20})>/g;
const ROLE_MENTION = /<@&(\d{17,20})>/g;
// `@everyone` / `@here`, but not when embedded in an email-style or doubled
// token (`@@everyone`, `x@everyone`) — those are not Discord pings.
const MASS_MENTION = /(?<![@\w])@(everyone|here)\b/g;

/** Mention syntax that names an individual, independent of model claims (Section 7.4 check 8 token form). */
const INDIVIDUAL_MENTION = /<@!?\d{17,20}>/;

/**
 * Parse Discord mention syntax directly from the text, with no reliance on
 * model-supplied metadata. Returns every user / role / mass mention found, in
 * order. Channel, emoji, and slash-command tokens are intentionally not parsed
 * (they are not pings).
 */
export function parseMentions(content: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  for (const m of content.matchAll(USER_MENTION)) {
    out.push({ raw: m[0], kind: 'user', id: m[1] });
  }
  for (const m of content.matchAll(ROLE_MENTION)) {
    out.push({ raw: m[0], kind: 'role', id: m[1] });
  }
  for (const m of content.matchAll(MASS_MENTION)) {
    out.push({ raw: m[0], kind: m[1] === 'everyone' ? 'everyone' : 'here' });
  }
  return out;
}

export const discordFormat: PlatformFormat = {
  parseMentions,
  hasIndividualMention: (content) => INDIVIDUAL_MENTION.test(content),
};
