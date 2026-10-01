import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeMessage,
  normalizeMessageUpdate,
  snowflakeToMs,
} from '../../src/platform/discord/normalize.js';
import { emojiKeyOf } from '../../src/platform/discord/normalize.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/messages/create.json', import.meta.url));

describe('normalizeMessage (full)', () => {
  it('maps every field from a full create payload', () => {
    const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const m = normalizeMessage(raw);

    expect(m.id).toBe('12345678901234567890');
    expect(m.channelId).toBe('999999999999999999');
    expect(m.guildId).toBe('888888888888888888');
    expect(m.author.id).toBe('777777777777777777');
    expect(m.author.globalName).toBe('Alice');
    expect(m.author.isBot).toBe(false);
    expect(m.content).toBe('We decided to ship the onboarding trial next week.');
    expect(m.createdAtMs).toBe(Date.parse('2024-05-01T12:00:00.000+00:00'));
    expect(m.replyToMessageId).toBe('444444444444444444');
    expect(m.mentions).toHaveLength(1);
    expect(m.mentions[0].id).toBe('666666666666666666');
    expect(m.attachments[0].filename).toBe('plan.txt');
    expect(m.attachments[0].mimeType).toBe('text/plain');
    expect(m.attachments[0].sizeBytes).toBe(1234);
    expect(m.embeds).toHaveLength(1);
  });

  it('extracts REST reaction counts with stable emoji keys', () => {
    const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    raw.reactions = [
      { count: 3, me: false, emoji: { id: null, name: '👍' } },
      { count: 1, me: true, emoji: { id: '999', name: 'goldstar' } },
    ];
    const m = normalizeMessage(raw);
    expect(m.reactionCounts).toEqual([
      { emojiKey: '👍', count: 3 },
      { emojiKey: 'goldstar:999', count: 1 },
    ]);
  });

  it('emojiKeyOf maps unicode and custom emoji consistently', () => {
    expect(emojiKeyOf({ name: '🎉', id: null })).toBe('🎉');
    expect(emojiKeyOf({ name: 'gg', id: '12' })).toBe('gg:12');
    expect(emojiKeyOf({ name: null, id: '12' })).toBe('12:12'); // name falls back to id
    expect(emojiKeyOf(null)).toBeNull();
  });

  it('preserves snowflake precision beyond 2^53 without numeric coercion', () => {
    const m = normalizeMessage({ id: '12345678901234567890', channel_id: '1', author: { id: '1' }, content: '' });
    expect(m.id).toBe('12345678901234567890');
    expect(m.author.id).toBe('1'); // no coercion
  });

  it('derives timestamp from the snowflake when timestamp is absent', () => {
    const m = normalizeMessage({ id: '12345678901234567890', channel_id: '1', author: { id: '1' } });
    expect(m.createdAtMs).toBe(snowflakeToMs('12345678901234567890'));
    expect(m.content).toBe(''); // absent content is '', never null
  });

  it('throws on a payload missing required ids', () => {
    expect(() => normalizeMessage({ channel_id: '1', author: { id: '1' } })).toThrow();
    expect(() => normalizeMessage({ id: '1', author: { id: '1' } })).toThrow();
    expect(() => normalizeMessage({ id: '1', channel_id: '1' })).toThrow();
  });
});

describe('normalizeMessageUpdate (partial)', () => {
  it('treats omitted content as absent (keep), never an empty overwrite', () => {
    const patch = normalizeMessageUpdate({ id: '1', channel_id: 'c', edited_timestamp: '2024-05-01T12:00:00.000+00:00' });
    expect(patch.content).toBeUndefined();
    expect(patch.editedAtMs).toBe(Date.parse('2024-05-01T12:00:00.000+00:00'));
  });

  it('honors an explicit empty content edit', () => {
    const patch = normalizeMessageUpdate({ id: '1', channel_id: 'c', content: '' });
    expect(patch.content).toBe('');
  });

  it('honors a present content value', () => {
    const patch = normalizeMessageUpdate({ id: '1', channel_id: 'c', content: 'new text' });
    expect(patch.content).toBe('new text');
  });

  it('distinguishes null (clear) from absent (keep) for edited_timestamp', () => {
    expect(normalizeMessageUpdate({ id: '1', channel_id: 'c', edited_timestamp: null }).editedAtMs).toBeNull();
    expect(normalizeMessageUpdate({ id: '1', channel_id: 'c' }).editedAtMs).toBeUndefined();
  });

  it('only carries fields that were present in the source', () => {
    const patch = normalizeMessageUpdate({ id: '1', channel_id: 'c', pinned: true });
    expect(patch.pinned).toBe(true);
    expect(patch.content).toBeUndefined();
    expect(patch.mentions).toBeUndefined();
    expect(patch.embeds).toBeUndefined();
    expect(patch.author).toBeUndefined();
  });
});
