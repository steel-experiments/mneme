import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { getOpenEpisode } from '../../src/episodes/repository.js';
import type { NormalizedMessage } from '../../src/platform/types.js';
import {
  classifyEpisodeTrigger,
  applyEpisodeTrigger,
  ingestEpisodeActivity,
  defaultIsIgnoredCommand,
  defaultIsKnownNoise,
  mentionsMneme,
  type EpisodeBuilderConfig,
} from '../../src/episodes/builder.js';

/**
 * Human-message episode opening and extension (Sections 9.3, 11.2).
 *
 * Acceptance: fixtures prove only qualifying human activity changes episode timers
 * and counters — bot, self, ignored-command, and noise messages never do.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded by seedIdentity
const HUMAN = '100000000000000003'; // seeded user (alice)
const MNEME = '100000000000000010';
const BOT = '100000000000000020';
const ALLOWED_BOT = '100000000000000021';
const NOW = 1_700_000_001_000;

/** Build a NormalizedMessage with sane defaults; override anything per case. */
function nm(over: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    channelId: CHANNEL,
    guildId: GUILD,
    author: { id: HUMAN, username: 'alice', globalName: 'Alice', isBot: false },
    content: 'We decided to adopt Postgres for the new service.',
    createdAtMs: NOW,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentions: [],
    embeds: [],
    components: [],
    poll: null,
    attachments: [],
    reactionCounts: [],
    raw: null,
    ...over,
  };
}

const config: EpisodeBuilderConfig = {
  mnemeId: MNEME,
  allowlistedBotIds: new Set([ALLOWED_BOT]),
};

let env: TestDb;
let db: DatabaseSync;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  seedIdentity(db);
  // Seed the bot authors so messages.author_id satisfies its FK.
  for (const [id, name] of [
    [MNEME, 'Mneme'],
    [BOT, 'groovy'],
    [ALLOWED_BOT, 'Deploy'],
  ] as const) {
    db.prepare(
      'INSERT INTO users (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms, raw_json) VALUES (?,?,?,1,?,?,NULL)',
    ).run(id, name.toLowerCase(), name, NOW, NOW);
  }
});
afterEach(() => env.cleanup());

/** Persist a message row so episode_messages.message_id satisfies its FK. */
function persist(msg: NormalizedMessage): void {
  upsertMessageCreate(db, {
    id: msg.id,
    guildId: msg.guildId ?? GUILD,
    channelId: msg.channelId,
    authorId: msg.author.id,
    authorDisplayName: msg.author.globalName ?? msg.author.username ?? 'user',
    content: msg.content,
    createdAtMs: msg.createdAtMs,
    editedAtMs: msg.editedAtMs,
    replyToMessageId: msg.replyToMessageId,
    messageType: msg.messageType,
    flags: msg.flags,
    pinned: msg.pinned,
    mentionEveryone: msg.mentionEveryone,
    mentionsJson: JSON.stringify(msg.mentions),
    embedsJson: JSON.stringify(msg.embeds),
    componentsJson: JSON.stringify(msg.components),
    pollJson: msg.poll == null ? null : JSON.stringify(msg.poll),
    rawJson: null,
    ingestedAtMs: NOW,
    updatedAtMs: NOW,
  });
}

describe('classifyEpisodeTrigger — pure classification', () => {
  it('flags Mneme self-messages as non-triggering', () => {
    const d = classifyEpisodeTrigger(nm({ id: 'm1', author: { id: MNEME, username: 'mneme', globalName: 'Mneme', isBot: true } }), config);
    expect(d.messageClass).toBe('mneme');
    expect(d.opensEpisode).toBe(false);
    expect(d.extendsEpisode).toBe(false);
    expect(d.isHuman).toBe(false);
  });

  it('flags other bots as non-triggering', () => {
    const d = classifyEpisodeTrigger(nm({ id: 'm2', author: { id: BOT, username: 'groovy', globalName: null, isBot: true } }), config);
    expect(d.messageClass).toBe('other_bot');
    expect(d.opensEpisode).toBe(false);
    expect(d.extendsEpisode).toBe(false);
    expect(d.isHuman).toBe(false);
  });

  it('lets an allowlisted bot extend but never open or count as human', () => {
    const d = classifyEpisodeTrigger(nm({ id: 'm3', author: { id: ALLOWED_BOT, username: 'deploy', globalName: 'Deploy', isBot: true } }), config);
    expect(d.messageClass).toBe('allowlisted_bot');
    expect(d.opensEpisode).toBe(false);
    expect(d.extendsEpisode).toBe(true);
    expect(d.isHuman).toBe(false);
  });

  it('opens and extends for a substantive human message, counting as human', () => {
    const d = classifyEpisodeTrigger(nm({ id: 'm4' }), config);
    expect(d.messageClass).toBe('human');
    expect(d.opensEpisode).toBe(true);
    expect(d.extendsEpisode).toBe(true);
    expect(d.isHuman).toBe(true);
    expect(d.reason).toBe('human');
    expect(d.mentionsMneme).toBe(false);
  });

  it('classifies a purely ignored command as non-triggering', () => {
    const d = classifyEpisodeTrigger(nm({ id: 'm5', content: '!kick @spammer' }), config);
    expect(d.messageClass).toBe('command');
    expect(d.opensEpisode).toBe(false);
    expect(d.extendsEpisode).toBe(false);
  });

  it('classifies known noise as non-triggering', () => {
    const d = classifyEpisodeTrigger(nm({ id: 'm6', content: '' }), config); // empty, no attachments
    expect(d.messageClass).toBe('noise');
    expect(d.opensEpisode).toBe(false);
    expect(d.extendsEpisode).toBe(false);
  });

  it('treats a direct Mneme mention as substantive even when content is otherwise noise', () => {
    const msg = nm({ id: 'm7', content: '', mentions: [{ id: MNEME, username: 'mneme', globalName: 'Mneme' }] });
    const d = classifyEpisodeTrigger(msg, config);
    expect(d.messageClass).toBe('human');
    expect(d.opensEpisode).toBe(true);
    expect(d.mentionsMneme).toBe(true);
    expect(d.reason).toBe('human_mention');
  });

  it('treats a Mneme mention as substantive even when it looks like a command', () => {
    const msg = nm({ id: 'm8', content: '!summarize', mentions: [{ id: MNEME, username: 'mneme', globalName: 'Mneme' }] });
    const d = classifyEpisodeTrigger(msg, config);
    expect(d.messageClass).toBe('human');
    expect(d.opensEpisode).toBe(true);
  });

  it('honors injected command and noise detectors', () => {
    const cfg: EpisodeBuilderConfig = {
      mnemeId: MNEME,
      isIgnoredCommand: (c) => c.trim() === 'deploy',
      isKnownNoise: (c) => c.trim() === 'ack',
    };
    expect(classifyEpisodeTrigger(nm({ id: 'm9', content: 'deploy' }), cfg).messageClass).toBe('command');
    expect(classifyEpisodeTrigger(nm({ id: 'm10', content: 'ack' }), cfg).messageClass).toBe('noise');
    expect(classifyEpisodeTrigger(nm({ id: 'm11', content: 'deploy succeeded' }), cfg).messageClass).toBe('human');
  });
});

describe('default detectors', () => {
  it('defaultIsIgnoredCommand matches prefix commands and rejects prose', () => {
    expect(defaultIsIgnoredCommand('!kick @x')).toBe(true);
    expect(defaultIsIgnoredCommand('.play song')).toBe(true);
    expect(defaultIsIgnoredCommand('/help')).toBe(true);
    expect(defaultIsIgnoredCommand('Check this out!')).toBe(false);
    expect(defaultIsIgnoredCommand('  ?ping')).toBe(true);
    expect(defaultIsIgnoredCommand('We decided to ship.')).toBe(false);
  });

  it('defaultIsKnownNoise flags only empty content with no attachment or embed', () => {
    expect(defaultIsKnownNoise('', nm({ id: 'n1' }))).toBe(true);
    expect(defaultIsKnownNoise('   ', nm({ id: 'n2' }))).toBe(true);
    expect(defaultIsKnownNoise('', nm({ id: 'n3', attachments: [{ id: 'a1', filename: 'f.png', mimeType: 'image/png', sizeBytes: 1, width: 1, height: 1, sourceUrl: null, proxyUrl: null }] }))).toBe(false);
    expect(defaultIsKnownNoise('', nm({ id: 'n4', embeds: [{}] }))).toBe(false);
    expect(defaultIsKnownNoise('ok', nm({ id: 'n5' }))).toBe(false);
  });

  it('mentionsMneme detects by id only', () => {
    expect(mentionsMneme(nm({ id: 'x', mentions: [{ id: MNEME, username: 'c', globalName: 'C' }] }), MNEME)).toBe(true);
    expect(mentionsMneme(nm({ id: 'x', mentions: [{ id: HUMAN, username: 'a', globalName: 'A' }] }), MNEME)).toBe(false);
    expect(mentionsMneme(nm({ id: 'x' }), MNEME)).toBe(false);
  });
});

describe('ingestEpisodeActivity / applyEpisodeTrigger — DB effects', () => {
  it('opens a new episode on the first human message and counts it', () => {
    const msg = nm({ id: 'h1' });
    persist(msg);
    const res = ingestEpisodeActivity(msg, config, { db, guildId: GUILD, now: NOW });

    expect(res.opened).toBe(true);
    expect(res.linked).toBe(true);
    expect(res.ordinal).toBe(1);
    const ep = getOpenEpisode(db, CHANNEL)!;
    expect(ep.human_message_count).toBe(1);
    expect(ep.total_message_count).toBe(1);
    expect(ep.last_activity_at_ms).toBe(NOW);
    expect(ep.trigger_reason).toBe('human');
  });

  it('extends the open episode on the second human message without reopening', () => {
    const first = nm({ id: 'h1' });
    const second = nm({ id: 'h2', content: 'Agreed, Postgres it is.' });
    persist(first); persist(second);
    ingestEpisodeActivity(first, config, { db, guildId: GUILD, now: NOW });
    const res = ingestEpisodeActivity(second, config, { db, guildId: GUILD, now: NOW + 5000 });

    expect(res.opened).toBe(false);
    expect(res.linked).toBe(true);
    expect(res.ordinal).toBe(2);
    const ep = getOpenEpisode(db, CHANNEL)!;
    expect(ep.human_message_count).toBe(2);
    expect(ep.total_message_count).toBe(2);
    expect(ep.last_activity_at_ms).toBe(NOW + 5000); // timer advanced
  });

  it('an allowlisted bot extends an open episode but does not count as human', () => {
    const human = nm({ id: 'h1' });
    const botMsg = nm({ id: 'b1', author: { id: ALLOWED_BOT, username: 'deploy', globalName: 'Deploy', isBot: true }, content: 'Deployed v1.2.3.' });
    persist(human); persist(botMsg);
    ingestEpisodeActivity(human, config, { db, guildId: GUILD, now: NOW });
    const res = ingestEpisodeActivity(botMsg, config, { db, guildId: GUILD, now: NOW + 1000 });

    expect(res.linked).toBe(true);
    expect(res.opened).toBe(false);
    const ep = getOpenEpisode(db, CHANNEL)!;
    expect(ep.human_message_count).toBe(1); // bot did not add to human count
    expect(ep.total_message_count).toBe(2); // but did add to total
  });

  it('an allowlisted bot does not open an episode when none is open', () => {
    const botMsg = nm({ id: 'b1', author: { id: ALLOWED_BOT, username: 'deploy', globalName: 'Deploy', isBot: true }, content: 'Deployed v1.2.3.' });
    persist(botMsg);
    const res = ingestEpisodeActivity(botMsg, config, { db, guildId: GUILD, now: NOW });
    expect(res.linked).toBe(false);
    expect(res.opened).toBe(false);
    expect(getOpenEpisode(db, CHANNEL)).toBeUndefined();
  });

  it('never lets a Mneme self-message open or extend an episode', () => {
    const self = nm({ id: 'c1', author: { id: MNEME, username: 'mneme', globalName: 'Mneme', isBot: true }, content: 'Noted.' });
    persist(self);
    const res = ingestEpisodeActivity(self, config, { db, guildId: GUILD, now: NOW });
    expect(res.linked).toBe(false);
    expect(getOpenEpisode(db, CHANNEL)).toBeUndefined();
  });

  it('never lets an other-bot, ignored-command, or noise message change counters', () => {
    const cases = [
      nm({ id: 'o1', author: { id: BOT, username: 'groovy', globalName: null, isBot: true } }),
      nm({ id: 'o2', content: '!skip' }),
      nm({ id: 'o3', content: '' }),
    ];
    for (const msg of cases) {
      persist(msg);
      const res = ingestEpisodeActivity(msg, config, { db, guildId: GUILD, now: NOW });
      expect(res.linked).toBe(false);
    }
    expect(getOpenEpisode(db, CHANNEL)).toBeUndefined();
  });

  it('keeps separate conversations in separate episodes', () => {
    const a = nm({ id: 'a1', channelId: CHANNEL });
    const otherChannel = '999000000000000099';
    // Seed the other channel row for the episodes FK.
    db.prepare(
      `INSERT INTO channels (id, workspace_id, parent_id, type, name, is_thread, is_archived, is_locked,
         ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
       VALUES (?, ?, NULL, 0, 'other', 0, 0, 0, 1, 'restricted', 0, ?, ?)`,
    ).run(otherChannel, GUILD, NOW, NOW);
    const b = nm({ id: 'b1', channelId: otherChannel });
    persist(a); persist(b);
    ingestEpisodeActivity(a, config, { db, guildId: GUILD, now: NOW });
    ingestEpisodeActivity(b, config, { db, guildId: GUILD, now: NOW });

    expect(getOpenEpisode(db, CHANNEL)).toBeDefined();
    expect(getOpenEpisode(db, otherChannel)).toBeDefined();
  });

  it('is idempotent on message id: re-extending does not advance counts', () => {
    const msg = nm({ id: 'h1' });
    persist(msg);
    ingestEpisodeActivity(msg, config, { db, guildId: GUILD, now: NOW });
    const second = applyEpisodeTrigger({
      db,
      msg,
      decision: classifyEpisodeTrigger(msg, config),
      guildId: GUILD,
      now: NOW + 9999,
    });
    expect(second.linked).toBe(false);
    const ep = getOpenEpisode(db, CHANNEL)!;
    expect(ep.human_message_count).toBe(1);
    expect(ep.total_message_count).toBe(1);
    expect(ep.last_activity_at_ms).toBe(NOW); // not bumped by the duplicate
  });

  it('records a Mneme mention as a substantive opener with the mention reason', () => {
    const msg = nm({ id: 'h1', content: '', mentions: [{ id: MNEME, username: 'mneme', globalName: 'Mneme' }] });
    persist(msg);
    ingestEpisodeActivity(msg, config, { db, guildId: GUILD, now: NOW });
    const ep = getOpenEpisode(db, CHANNEL)!;
    expect(ep.trigger_reason).toBe('human_mention');
    expect(ep.human_message_count).toBe(1);
  });
});
