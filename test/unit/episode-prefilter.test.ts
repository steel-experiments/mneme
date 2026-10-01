import { describe, it, expect } from 'vitest';
import {
  evaluateEpisodePrefilter,
  evaluateEpisodePrefilterNormalized,
  messageMentionsMneme,
  DEFAULT_REACTION_BURST_THRESHOLD,
  DEFAULT_MIN_INFORMATION_CHARS,
  type PrefilterMessage,
} from '../../src/episodes/prefilter.js';
import type { NormalizedMessage } from '../../src/discord/normalize.js';

/**
 * Conservative local episode pre-filter (Sections 11.4, 45).
 *
 * Acceptance: the filter skips only episodes satisfying every Section 11.4
 * condition and never skips a direct mention.
 */

const CASS = '999000000000000001';

function msg(partial: Partial<PrefilterMessage> & { id: string }): PrefilterMessage {
  return {
    content: '',
    author: { id: 'u-human', isBot: false },
    mentions: [],
    reactionCounts: [],
    ...partial,
  };
}

/** A fully-formed NormalizedMessage with defaults, for the compatibility test. */
function nmsg(over: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    channelId: 'c1',
    guildId: 'g1',
    content: '',
    createdAtMs: 1,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: null,
    pinned: false,
    mentionEveryone: false,
    mentions: [],
    embeds: [],
    components: [],
    poll: null,
    attachments: [],
    reactionCounts: [],
    author: { id: 'u-human', username: null, globalName: null, isBot: false },
    ...over,
  } as NormalizedMessage;
}

describe('evaluateEpisodePrefilter — skips only trivial episodes', () => {
  it('skips a lone short human message with no signals (all conditions hold)', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'ok' })],
    });
    expect(e.skip).toBe(true);
    expect(e.blockers).toEqual([]);
    expect(e.humanMessageCount).toBe(1);
    expect(e.conditions).toEqual({
      fewHumanMessages: true,
      noMnemeMention: true,
      noDecisionPhrase: true,
      noReactionBurst: true,
      noMemoryLink: true,
      belowInformationThreshold: true,
    });
  });

  it('skips an empty episode (nothing to review)', () => {
    const e = evaluateEpisodePrefilter({ mnemeId: CASS, messages: [] });
    expect(e.skip).toBe(true);
    expect(e.humanMessageCount).toBe(0);
  });

  it('skips bot-only chatter with no human content and no signals', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [
        msg({ id: 'b1', content: 'beep', author: { id: 'bot1', isBot: true } }),
        msg({ id: 'b2', content: 'boop', author: { id: 'bot2', isBot: true } }),
      ],
    });
    expect(e.skip).toBe(true);
    expect(e.humanMessageCount).toBe(0);
  });
});

describe('evaluateEpisodePrefilter — never skips a direct mention', () => {
  it('does not skip when the mentions array names Mneme', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'ok', mentions: [{ id: CASS }] })],
    });
    expect(e.skip).toBe(false);
    expect(e.blockers).toContain('mneme_mention');
  });

  it('does not skip when the content carries the raw ping <@id>', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: `<@${CASS}> hi` })],
    });
    expect(e.skip).toBe(false);
    expect(e.blockers).toContain('mneme_mention');
  });

  it('does not skip when the content carries the nickname ping <@!id>', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: `<@!${CASS}>` })],
    });
    expect(e.skip).toBe(false);
  });

  it('a mention by a bot still prevents a skip (mention is mention)', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'b1', content: 'ok', author: { id: 'bot1', isBot: true }, mentions: [{ id: CASS }] })],
    });
    expect(e.skip).toBe(false);
    expect(e.blockers).toContain('mneme_mention');
  });

  it('messageMentionsMneme is exact: a different id does not match', () => {
    expect(messageMentionsMneme(msg({ id: 'm1', mentions: [{ id: '111111111111111111' }] }), CASS)).toBe(false);
    expect(messageMentionsMneme(msg({ id: 'm1', content: `<@${CASS}>` }), CASS)).toBe(true);
  });
});

describe('evaluateEpisodePrefilter — each condition independently forces a review', () => {
  it('two human messages force a review even if both are tiny', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'ok' }), msg({ id: 'm2', content: 'ya' })],
    });
    expect(e.skip).toBe(false);
    expect(e.blockers).toContain('multiple_human_messages');
    expect(e.humanMessageCount).toBe(2);
  });

  it('a decision-like phrase forces a review', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'we decided' })],
    });
    expect(e.skip).toBe(false);
    expect(e.blockers).toContain('decision_phrase');
  });

  it('a reaction burst forces a review', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'ok', reactionCounts: [{ count: 3 }] })],
    });
    expect(e.skip).toBe(false);
    expect(e.blockers).toContain('reaction_burst');
  });

  it('a link to an existing memory forces a review', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'ok' })],
      options: { memoryLinkedMessageIds: new Set(['m1']) },
    });
    expect(e.skip).toBe(false);
    expect(e.blockers).toContain('memory_link');
  });

  it('a single long human message is above the information threshold and is reviewed', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'x'.repeat(DEFAULT_MIN_INFORMATION_CHARS + 1) })],
    });
    expect(e.skip).toBe(false);
    expect(e.blockers).toContain('above_information_threshold');
  });
});

describe('evaluateEpisodePrefilter — borderline boundaries', () => {
  it('reaction burst threshold: count = threshold-1 is not a burst, = threshold is', () => {
    const below = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'ok', reactionCounts: [{ count: DEFAULT_REACTION_BURST_THRESHOLD - 1 }] })],
    });
    expect(below.conditions.noReactionBurst).toBe(true);
    const at = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'ok', reactionCounts: [{ count: DEFAULT_REACTION_BURST_THRESHOLD }] })],
    });
    expect(at.conditions.noReactionBurst).toBe(false);
  });

  it('information threshold: chars = min-1 is below, = min is above', () => {
    const min = 5;
    const below = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'abcd' })], // 4 < 5
      options: { minInformationChars: min },
    });
    expect(below.conditions.belowInformationThreshold).toBe(true);
    expect(below.skip).toBe(true);
    const at = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'abcde' })], // 5 == min
      options: { minInformationChars: min },
    });
    expect(at.conditions.belowInformationThreshold).toBe(false);
    expect(at.skip).toBe(false);
  });

  it('information threshold counts only human text (trimmed), ignoring bots', () => {
    const min = 5;
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [
        msg({ id: 'm1', content: 'ab' }), // human, 2 chars
        msg({ id: 'b1', content: 'yyyyyyyyyy', author: { id: 'bot', isBot: true } }), // bot, ignored
      ],
      options: { minInformationChars: min },
    });
    expect(e.conditions.belowInformationThreshold).toBe(true); // only 2 human chars
  });

  it('a custom decisionPhrases list overrides the default', () => {
    // 'decided' is in the default list but not in the override; 'ship it' is.
    const withDefault = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'we decided' })],
    });
    expect(withDefault.conditions.noDecisionPhrase).toBe(false);
    const overridden = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'we decided' })],
      options: { decisionPhrases: ['ship it'] },
    });
    expect(overridden.conditions.noDecisionPhrase).toBe(true); // 'decided' no longer matches
    const overriddenHit = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [msg({ id: 'm1', content: 'lets ship it now' })],
      options: { decisionPhrases: ['ship it'] },
    });
    expect(overriddenHit.conditions.noDecisionPhrase).toBe(false);
  });

  it('collects multiple blockers in a stable order', () => {
    const e = evaluateEpisodePrefilter({
      mnemeId: CASS,
      messages: [
        msg({ id: 'm1', content: 'we agreed', mentions: [{ id: CASS }] }),
        msg({ id: 'm2', content: 'second human message' }),
      ],
    });
    expect(e.skip).toBe(false);
    expect(e.blockers).toEqual(['multiple_human_messages', 'mneme_mention', 'decision_phrase']);
  });
});

describe('evaluateEpisodePrefilterNormalized — accepts NormalizedMessage', () => {
  it('treats a NormalizedMessage the same as the structural slice', () => {
    const e = evaluateEpisodePrefilterNormalized(
      [nmsg({ id: 'm1', content: 'ok', mentions: [{ id: CASS, username: null, globalName: null }] })],
      CASS,
    );
    expect(e.skip).toBe(false);
    expect(e.blockers).toContain('mneme_mention');
  });
});
