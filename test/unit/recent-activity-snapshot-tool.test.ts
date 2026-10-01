import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { RunRetrievalState, type AgentRunContext } from '../../src/agent/run-context.js';
import {
  createGetRecentActivitySnapshotTool,
  RECENT_ACTIVITY_SNAPSHOT_MAX_CHARACTERS,
} from '../../src/agent/tools/get-recent-activity-snapshot.js';
import { GetRecentActivitySnapshotToolInput, validate } from '../../src/agent/schemas.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const START = 1_780_000_000_000;
const QUESTION_AT = START + 100_000;
const ORG_GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [],
};

let env: TestDb;

function seedChannel(id: string): void {
  upsertChannel(env.db, {
    id,
    guildId: GUILD,
    parentId: null,
    kind: 'text',
    name: id,
    topic: null,
    position: null,
    isThread: false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: 'org',
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: START,
    updatedAtMs: START,
    rawJson: null,
  });
}

function seedMessage(id: string, channelId: string, at: number, content = `Update ${id}`): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId,
    authorId: USER,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: at,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: at,
    updatedAtMs: at,
  });
}

function context(budget = 60_000): AgentRunContext {
  return {
    db: env.db,
    grant: ORG_GRANT,
    retrieval: new RunRetrievalState(budget, QUESTION_AT, env.db),
    requestCreatedAtMs: QUESTION_AT,
  };
}

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
});

afterEach(() => env.cleanup());

describe('get_recent_activity_snapshot agent tool', () => {
  it('requires explicit strict bounds and rejects unknown pagination inputs', () => {
    expect(validate(GetRecentActivitySnapshotToolInput, {
      after: new Date(START).toISOString(),
      before: new Date(QUESTION_AT).toISOString(),
    }).ok).toBe(true);
    expect(validate(GetRecentActivitySnapshotToolInput, {
      after: new Date(START).toISOString(),
    }).ok).toBe(false);
    expect(validate(GetRecentActivitySnapshotToolInput, {
      after: new Date(START).toISOString(),
      before: new Date(QUESTION_AT).toISOString(),
      beforeMessageId: 'pagination-is-not-supported',
    }).ok).toBe(false);
    expect(validate(GetRecentActivitySnapshotToolInput, {
      after: new Date(START).toISOString(),
      before: new Date(QUESTION_AT).toISOString(),
      channelIds: [],
    }).ok).toBe(false);
  });

  it('clamps before to the immutable question time and records exact included provenance', async () => {
    seedChannel('org-a');
    seedMessage('past-a', 'org-a', QUESTION_AT - 2_000);
    seedMessage('past-b', 'org-a', QUESTION_AT - 1_000);
    seedMessage('future', 'org-a', QUESTION_AT + 1);
    const ctx = context();
    const tool = createGetRecentActivitySnapshotTool(ctx);

    const result = await tool.execute('snapshot-1', {
      after: new Date(START).toISOString(),
      before: new Date(QUESTION_AT + 86_400_000).toISOString(),
    });

    expect(result.details.accepted).toBe(true);
    expect(result.details.coverage).toMatchObject({
      afterMs: START,
      beforeMs: QUESTION_AT,
      totalMatching: 2,
      included: 2,
      matchingChannelCount: 1,
      includedChannelCount: 1,
      matchedChannelIds: ['org-a'],
      complete: true,
      omitted: 0,
      truncationReason: 'none',
      exposedMessageIds: ['past-a', 'past-b'],
    });
    const modelText = (result.content[0] as { text: string }).text;
    expect(modelText).toContain('host-bounded activity sample');
    expect(modelText).not.toContain('Host-computed coverage');
    expect(modelText).not.toContain('totalMatching');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('past-a');
    expect(text).toContain('past-b');
    expect(text).not.toContain('future');
    expect(text).not.toContain('https://discord.com/');
    expect(ctx.retrieval.provenance().messageIds).toEqual(['past-a', 'past-b']);
    expect(ctx.retrieval.provenance().channels).toEqual([
      { channelId: 'org-a', source: 'activity_snapshot' },
    ]);
    expect(ctx.retrieval.provenance().recentActivitySnapshot).toEqual(result.details.coverage);
  });

  it('fits the current 165 short messages from 11 org channels in one complete call', async () => {
    const channels = Array.from({ length: 11 }, (_, index) => `current-${String(index).padStart(2, '0')}`);
    for (const [channelIndex, channel] of channels.entries()) {
      seedChannel(channel);
      for (let messageIndex = 0; messageIndex < 15; messageIndex += 1) {
        seedMessage(
          `${channel}-m-${String(messageIndex).padStart(2, '0')}`,
          channel,
          START + 1_000 + messageIndex * 20 + channelIndex,
          `Short team update ${channelIndex + 1}.${messageIndex + 1}`,
        );
      }
    }

    const ctx = context();
    const result = await createGetRecentActivitySnapshotTool(ctx).execute('snapshot-current', {
      after: new Date(START).toISOString(),
      before: new Date(QUESTION_AT).toISOString(),
    });

    expect(result.details.coverage).toMatchObject({
      totalMatching: 165,
      included: 165,
      matchingChannelCount: 11,
      includedChannelCount: 11,
      complete: true,
      omitted: 0,
      truncationReason: 'none',
    });
    expect(result.details.coverage?.exposedMessageIds).toHaveLength(165);
    expect(ctx.retrieval.provenance().messageIds).toHaveLength(165);
    expect(ctx.retrieval.charsExposed).toBeLessThanOrEqual(
      RECENT_ACTIVITY_SNAPSHOT_MAX_CHARACTERS,
    );
  });

  it('character truncation remains deterministic across channels and time', async () => {
    const channels = ['org-a', 'org-b', 'org-c', 'org-d'];
    for (const channel of channels) seedChannel(channel);
    for (let index = 0; index < 120; index += 1) {
      const channel = channels[index % channels.length]!;
      seedMessage(
        `long-${String(index).padStart(3, '0')}`,
        channel,
        START + 1_000 + index,
        `${channel} ${String(index).padStart(3, '0')} ${'x'.repeat(1_750)}`,
      );
    }

    const ctx = context();
    const result = await createGetRecentActivitySnapshotTool(ctx).execute('snapshot-long', {
      after: new Date(START).toISOString(),
      before: new Date(QUESTION_AT).toISOString(),
    });
    const coverage = result.details.coverage!;

    expect(coverage.totalMatching).toBe(120);
    expect(coverage.included).toBeGreaterThan(4);
    expect(coverage.included).toBeLessThan(120);
    expect(coverage.includedChannelCount).toBe(4);
    expect(coverage.complete).toBe(false);
    expect(coverage.omitted).toBe(120 - coverage.included);
    expect(coverage.truncationReason).toBe('character_cap');
    expect(coverage.oldestIncludedAtMs).toBeLessThan(START + 1_040);
    expect(coverage.newestIncludedAtMs).toBeGreaterThan(START + 1_080);
    expect(ctx.retrieval.charsExposed).toBeLessThanOrEqual(
      RECENT_ACTIVITY_SNAPSHOT_MAX_CHARACTERS,
    );
    expect(new Set(ctx.retrieval.provenance().messageIds)).toEqual(
      new Set(coverage.exposedMessageIds),
    );
  });

  it('records a fail-closed attempt marker when a nonempty window cannot fit one row', async () => {
    seedChannel('org-no-room');
    seedMessage('no-room-message', 'org-no-room', START + 1, 'x'.repeat(1_000));
    const ctx = context(1);

    await expect(createGetRecentActivitySnapshotTool(ctx).execute('snapshot-no-room', {
      after: new Date(START).toISOString(),
      before: new Date(QUESTION_AT).toISOString(),
    })).rejects.toThrow(/retrieval character budget|fit a message row/i);

    expect(ctx.retrieval.provenance().recentActivitySnapshot).toMatchObject({
      totalMatching: 1,
      included: 0,
      exposedMessageIds: [],
    });
  });

  it('allows only one successful snapshot and a second call changes no host state', async () => {
    seedChannel('org-once');
    seedMessage('once-message', 'org-once', START + 1);
    const ctx = context();
    const tool = createGetRecentActivitySnapshotTool(ctx);
    const params = {
      after: new Date(START).toISOString(),
      before: new Date(QUESTION_AT).toISOString(),
    };

    const first = await tool.execute('snapshot-first', params);
    const provenanceAfterFirst = ctx.retrieval.provenance();
    const second = await tool.execute('snapshot-second', params);

    expect(first.details.accepted).toBe(true);
    expect(second.details).toMatchObject({ accepted: false, coverage: null });
    expect((second.content[0] as { text: string }).text).toBe(
      'A recent activity snapshot was already retrieved for this direct answer. ' +
      'Use that snapshot and finish the answer; do not call this tool again.',
    );
    expect(ctx.retrieval.provenance()).toEqual(provenanceAfterFirst);
  });

  it('fails closed when the host omits the immutable request timestamp', async () => {
    seedChannel('org-no-bound');
    const ctx: AgentRunContext = {
      db: env.db,
      grant: ORG_GRANT,
      retrieval: new RunRetrievalState(60_000, QUESTION_AT, env.db),
    };
    await expect(createGetRecentActivitySnapshotTool(ctx).execute('snapshot-no-bound', {
      after: new Date(START).toISOString(),
      before: new Date(QUESTION_AT).toISOString(),
    })).rejects.toThrow(/immutable direct-question timestamp/);
    expect(ctx.retrieval.provenance().recentActivitySnapshot).toBeUndefined();
  });
});
