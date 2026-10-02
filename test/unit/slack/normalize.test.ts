// ABOUTME: Tests Slack message normalization against the spike fixtures (plan 006 step 5).
// ABOUTME: Covers synthetic ids, replies, broadcast replies, stored and ignored subtypes, edits, and deletes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeSlackMessage,
  normalizeSlackMessageUpdate,
  slackDeletedMessage,
} from '../../../src/platform/slack/normalize.js';
import { isSlackAttachmentId } from '../../../src/platform/slack/ids.js';

const TEAM = 'T0000000001';
const BOT = 'U0000000002';
const C = 'C0000000001';
const ROOT = '1790933759.217369';

function event(name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`../../fixtures/slack/events/${name}`, import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { body: { event: Record<string, unknown> } }).body.event;
}

describe('normalizeSlackMessage', () => {
  it('maps a top-level message to the channel with a synthetic id', () => {
    const msg = normalizeSlackMessage(event('08-message.json'), C, TEAM, BOT)!;
    expect(msg).toMatchObject({ id: `${C}-1790933741.610379`, channelId: C, guildId: TEAM,
      createdAtMs: 1790933741610, editedAtMs: null, author: { id: 'U0000000001', isBot: false } });
  });

  it('maps a reply to its thread row', () => {
    const msg = normalizeSlackMessage(event('12-message-reply.json'), C, TEAM, BOT)!;
    expect(msg.id).toBe(`${C}-1790933763.089139`);
    expect(msg.channelId).toBe(`${C}-T${ROOT}`);
  });

  it('anchors a reply to its thread root, and a top-level message to nothing', () => {
    expect(normalizeSlackMessage(event('12-message-reply.json'), C, TEAM, BOT)!.replyToMessageId).toBe(`${C}-${ROOT}`);
    expect(normalizeSlackMessage(event('11-message.json'), C, TEAM, BOT)!.replyToMessageId).toBeNull();
  });

  it('maps a broadcast reply to the same thread row and id from channel history and from the thread', () => {
    const live = event('40-message-thread_broadcast.json');
    const fromThread = normalizeSlackMessage(live, C, TEAM, BOT)!;
    const fromHistory = normalizeSlackMessage({ ...live, root: undefined }, C, TEAM, BOT)!;
    expect(fromThread.channelId).toBe(`${C}-T1790934079.184319`);
    expect(fromHistory.id).toBe(fromThread.id);
    expect(fromHistory.channelId).toBe(fromThread.channelId);
  });

  it('stores a file share with a message-scoped attachment id', () => {
    const msg = normalizeSlackMessage(event('24-message-file_share.json'), C, TEAM, BOT)!;
    expect(msg.channelId).toBe(`${C}-T${ROOT}`);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toMatchObject({ id: `${msg.id}-F0000000001`, mimeType: 'image/jpeg', sizeBytes: 1219994 });
  });

  describe('attachments', () => {
    const file = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id, name: `${id}.txt`, mimetype: 'text/plain', size: 12,
      url_private: `https://files.slack.com/files-pri/${TEAM}-${id}/x.txt`,
      url_private_download: `https://files.slack.com/files-pri/${TEAM}-${id}/download/x.txt`, ...over,
    });
    const msg = (ts: string, files: unknown[]) => normalizeSlackMessage(
      { type: 'message', subtype: 'file_share', user: 'U0000000001', ts, text: '', files }, C, TEAM, BOT)!;

    it('gives each file in a message its own id and prefers the download url', () => {
      const m = msg('1790933741.000010', [file('F0000000001'), file('F0000000002')]);
      expect(m.attachments.map((a) => a.id)).toEqual([`${m.id}-F0000000001`, `${m.id}-F0000000002`]);
      expect(m.attachments[0]!.sourceUrl).toBe(`https://files.slack.com/files-pri/${TEAM}-F0000000001/download/x.txt`);
      expect(m.attachments[0]!.proxyUrl).toBeNull();
      for (const a of m.attachments) expect(isSlackAttachmentId(a.id)).toBe(true);
    });

    it('uses the private url when there is no download url', () => {
      const m = msg('1790933741.000011', [file('F0000000001', { url_private_download: undefined })]);
      expect(m.attachments[0]!.sourceUrl).toBe(`https://files.slack.com/files-pri/${TEAM}-F0000000001/x.txt`);
    });

    it('gives the same file in two messages two attachment ids', () => {
      const a = msg('1790933741.000012', [file('F0000000001')]).attachments[0]!.id;
      const b = msg('1790933741.000013', [file('F0000000001')]).attachments[0]!.id;
      expect(a).not.toBe(b);
    });

    it.each(['tombstone', 'hidden_by_limit'])('stores no attachment for a %s file', (mode) => {
      expect(msg('1790933741.000014', [file('F0000000001', { mode })]).attachments).toEqual([]);
    });

    it('keeps the metadata of an external file without a source url', () => {
      const m = msg('1790933741.000015', [file('F0000000001', { is_external: true, url_private: 'https://drive.example/x' })]);
      expect(m.attachments).toHaveLength(1);
      expect(m.attachments[0]!.sourceUrl).toBeNull();
    });

    it('accepts only message-scoped Slack attachment ids', () => {
      expect(isSlackAttachmentId('C0123ABCD-1712345678.000100-F0123ABCD')).toBe(true);
      expect(isSlackAttachmentId('F0123ABCD')).toBe(false);
      expect(isSlackAttachmentId('C0123ABCD-1712345678.000100')).toBe(false);
      expect(isSlackAttachmentId('C0123ABCD-1712345678.000100-F0123ABCD/..')).toBe(false);
      expect(isSlackAttachmentId('555000000000000001')).toBe(false);
    });
  });

  it('stores bot and me messages', () => {
    const bot = normalizeSlackMessage({ type: 'message', subtype: 'bot_message', bot_id: 'B0000000001', ts: '1790933741.000001', text: 'x' }, C, TEAM, BOT)!;
    expect(bot.author).toMatchObject({ id: 'B0000000001', isBot: true });
    expect(normalizeSlackMessage({ type: 'message', subtype: 'me_message', user: 'U0000000001', ts: '1790933741.000002', text: 'x' }, C, TEAM, BOT)).not.toBeNull();
    expect(normalizeSlackMessage({ type: 'message', user: BOT, ts: '1790933741.000003', text: 'x' }, C, TEAM, BOT)!.author.isBot).toBe(true);
  });

  it.each(['03-message-channel_join.json', '28-message-channel_name.json', '30-message-channel_archive.json', '34-message-channel_unarchive.json'])(
    'ignores %s', (name) => {
      expect(normalizeSlackMessage(event(name), C, TEAM, BOT)).toBeNull();
    });

  it('ignores unknown subtypes', () => {
    for (const subtype of ['channel_leave', 'channel_topic', 'channel_purpose', 'pinned_item', 'unpinned_item', 'group_join', 'brand_new_subtype']) {
      expect(normalizeSlackMessage({ type: 'message', subtype, user: 'U0000000001', ts: '1790933741.000004', text: 'x' }, C, TEAM, BOT)).toBeNull();
    }
  });

  it('parses user mentions and broadcast mentions', () => {
    const msg = normalizeSlackMessage({ type: 'message', user: 'U0000000001', ts: '1790933741.000005',
      text: 'hi <@U0000000002> and <!here>' }, C, TEAM, BOT)!;
    expect(msg.mentions.map((m) => m.id)).toEqual(['U0000000002']);
    expect(msg.mentionEveryone).toBe(true);
  });
});

describe('Slack edits and deletes', () => {
  it('maps a reply edit to the reply id and thread row, keeping the original ts', () => {
    const patch = normalizeSlackMessageUpdate(event('13-message-message_changed.json'), TEAM)!;
    expect(patch.id).toBe(`${C}-1790933763.089139`);
    expect(patch.channelId).toBe(`${C}-T${ROOT}`);
    expect(patch.editedAtMs).not.toBeNull();
  });

  it('maps a reply delete through deleted_ts and previous_message.thread_ts', () => {
    expect(slackDeletedMessage(event('14-message-message_deleted.json'))).toEqual({
      id: `${C}-1790933763.089139`, channelId: `${C}-T${ROOT}`,
    });
  });

  it('maps a top-level delete to the channel', () => {
    expect(slackDeletedMessage(event('10-message-message_deleted.json'))).toEqual({
      id: `${C}-1790933741.610379`, channelId: C,
    });
  });
});
