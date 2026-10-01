// ABOUTME: Discord text conventions for the core: mention parsing (Section 24.5).
// ABOUTME: The core reads mention syntax only through this format object.
import { parseMentions } from '../../outbound/message-safety.js';
import type { PlatformFormat } from '../types.js';

/** Mention syntax that names an individual, independent of model claims (Section 7.4 check 8 token form). */
const INDIVIDUAL_MENTION = /<@!?\d{17,20}>/;

export const discordFormat: PlatformFormat = {
  parseMentions,
  hasIndividualMention: (content) => INDIVIDUAL_MENTION.test(content),
};
