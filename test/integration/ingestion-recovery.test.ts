import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { AUTHOR, CHANNEL, GUILD, NOW, opts } from '../helpers/messages.js';
import { requestIngestionRecovery, getIngestionRecovery } from '../../src/db/repositories/ingestion-recovery.js';
import { createRecoverMessageHandler } from '../../src/jobs/handlers/recover-message.js';
import { getMessage } from '../../src/db/repositories/messages.js';
import { createCounters, createIngestionObserver, COUNTER_NAMES } from '../../src/observability.js';
import { DeferJobError } from '../../src/jobs/errors.js';
import { normalizeMessage } from '../../src/platform/discord/normalize.js';

const MESSAGE = '100000000000000099';
function raw(): Record<string, unknown> {
  return { id: MESSAGE, channel_id: CHANNEL, guild_id: GUILD,
    author: { id: AUTHOR, username: 'alice', global_name: 'Alice', bot: false },
    content: 'recovered', timestamp: '2024-05-01T12:00:00.000+00:00', edited_timestamp: null,
    type: 0, flags: 0, pinned: false, mention_everyone: false, mentions: [], embeds: [], components: [], attachments: [] };
}
describe('durable ingestion recovery', () => {
  let env: TestDb; let db: DatabaseSync;
  beforeEach(() => { env = createTestDb(); db = env.db; seedIdentity(db); });
  afterEach(() => env.cleanup());
  it('persists an exact, scope-matching message and terminalizes its request', async () => {
    const request = requestIngestionRecovery(db, { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE, reason: 'missing_message', now: NOW });
    const handler = createRecoverMessageHandler({ db, now: () => NOW + 1,
      makeIngestOptions: (now) => opts({ now }), fetcher: { normalize: normalizeMessage, async fetchMessages() { return []; }, async fetchMessage() { return raw(); } } });
    await handler({ recoveryId: request.id, generation: request.generation }, {} as never);
    expect(getMessage(db, MESSAGE)?.content).toBe('recovered');
    expect(getIngestionRecovery(db, request.id)?.status).toBe('succeeded');
  });
  it('does not persist a response whose identity differs from the request', async () => {
    const request = requestIngestionRecovery(db, { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE, reason: 'missing_message', now: NOW });
    const handler = createRecoverMessageHandler({ db, now: () => NOW + 1,
      makeIngestOptions: (now) => opts({ now }), fetcher: { normalize: normalizeMessage, async fetchMessages() { return []; }, async fetchMessage() { return { ...raw(), id: '100000000000000098' }; } } });
    await handler({ recoveryId: request.id, generation: request.generation }, {} as never);
    expect(getMessage(db, MESSAGE)).toBeUndefined();
    expect(getIngestionRecovery(db, request.id)?.status).toBe('unavailable');
  });
  it('counts one terminal recovery transition even when a completed job is claimed again', async () => {
    const counters = createCounters();
    const request = requestIngestionRecovery(db, { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE, reason: 'missing_message', now: NOW });
    const handler = createRecoverMessageHandler({ db, now: () => NOW + 1, observer: createIngestionObserver(counters),
      makeIngestOptions: (now) => opts({ now }), fetcher: { normalize: normalizeMessage, async fetchMessages() { return []; }, async fetchMessage() { return null; } } });
    await handler({ recoveryId: request.id, generation: request.generation }, {} as never);
    await handler({ recoveryId: request.id, generation: request.generation }, {} as never);
    expect(counters.get(COUNTER_NAMES.ingestionRecovery, { outcome: 'unavailable', reason: 'unavailable_source' })).toBe(1);
  });
  it('records a missing-parent recovery as deferred without terminalizing it', async () => {
    const counters = createCounters();
    const request = requestIngestionRecovery(db, { guildId: GUILD, channelId: '100000000000000077', messageId: MESSAGE, reason: 'missing_channel', now: NOW });
    const handler = createRecoverMessageHandler({ db, now: () => NOW + 1, observer: createIngestionObserver(counters),
      makeIngestOptions: (now) => opts({ now }), fetcher: { normalize: normalizeMessage, async fetchMessages() { return []; } } });
    await expect(handler({ recoveryId: request.id, generation: request.generation }, {} as never)).rejects.toBeInstanceOf(DeferJobError);
    expect(counters.get(COUNTER_NAMES.ingestionRecovery, { outcome: 'deferred', reason: 'missing_channel' })).toBe(1);
    expect(getIngestionRecovery(db, request.id)?.status).toBe('pending');
  });
  it('uses the current generation when an active collapsed job has an older payload', async () => {
    const first = requestIngestionRecovery(db, { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE, reason: 'missing_message', now: NOW });
    const second = requestIngestionRecovery(db, { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE, reason: 'missing_message', now: NOW + 1 });
    const handler = createRecoverMessageHandler({ db, now: () => NOW + 2,
      makeIngestOptions: (now) => opts({ now }), fetcher: { normalize: normalizeMessage, async fetchMessages() { return []; }, async fetchMessage() { return raw(); } } });
    await handler({ recoveryId: first.id, generation: first.generation }, {} as never);
    expect(second.generation).toBe(first.generation + 1);
    expect(getIngestionRecovery(db, first.id)?.status).toBe('succeeded');
  });
});
