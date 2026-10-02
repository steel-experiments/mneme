// ABOUTME: Test doubles for the Slack Web API boundary and a Slack workspace seed.
// ABOUTME: Tests replay recorded or hand-built responses; nothing opens a network connection.
import type { DatabaseSync } from 'node:sqlite';
import type { SlackApi, SlackObject, SlackPage } from '../../src/platform/slack/api.js';

export const TEAM = 'T0000000001';
export const BOT_USER = 'U0000000002';

export function seedSlackWorkspace(db: DatabaseSync, teamId = TEAM): void {
  db.prepare('INSERT INTO workspaces (id,name,owner_id,joined_at_ms,discovered_at_ms,updated_at_ms,raw_json) VALUES (?,?,?,?,?,?,NULL)')
    .run(teamId, 'Team', null, 1, 1, 1);
}

export function conversation(id: string, over: SlackObject = {}): SlackObject {
  return { id, name: `ch-${id.toLowerCase()}`, is_channel: true, is_private: false, is_member: true,
    is_archived: false, is_ext_shared: false, is_pending_ext_shared: false, topic: { value: '' }, ...over };
}

export interface FakeSlackApi extends SlackApi {
  conversations: Map<string, SlackObject>;
  /** Messages per channel, newest first, as conversations.history returns them. */
  channelMessages: Map<string, SlackObject[]>;
  /** Replies per `<channel>:<thread_ts>`, oldest first and with the root, as conversations.replies returns them. */
  threadMessages: Map<string, SlackObject[]>;
  calls: Array<{ method: string; input: unknown }>;
  /** Errors to throw before answering, in order, per method. */
  failures: Map<string, unknown[]>;
}

function slice(messages: SlackObject[], input: { latest?: string; oldest?: string; inclusive?: boolean }): SlackObject[] {
  return messages.filter((m) => {
    const ts = String(m.ts);
    if (input.latest !== undefined && (input.inclusive ? ts > input.latest : ts >= input.latest)) return false;
    if (input.oldest !== undefined && (input.inclusive ? ts < input.oldest : ts <= input.oldest)) return false;
    return true;
  });
}

export function fakeSlackApi(): FakeSlackApi {
  const api: FakeSlackApi = {
    conversations: new Map(),
    channelMessages: new Map(),
    threadMessages: new Map(),
    calls: [],
    failures: new Map(),
    async authTest() {
      return { teamId: TEAM, userId: BOT_USER, url: 'https://acme.slack.com/' };
    },
    async listConversations(cursor) {
      api.calls.push({ method: 'listConversations', input: cursor });
      return { channels: [...api.conversations.values()], nextCursor: null };
    },
    async conversationInfo(channel) {
      api.calls.push({ method: 'conversationInfo', input: channel });
      return api.conversations.get(channel) ?? null;
    },
    async history(input): Promise<SlackPage> {
      api.calls.push({ method: 'history', input });
      const failure = api.failures.get('history')?.shift();
      if (failure) throw failure;
      const all = slice(api.channelMessages.get(input.channel) ?? [], input);
      const start = input.cursor ? Number(input.cursor) : 0;
      const page = all.slice(start, start + input.limit);
      const more = start + input.limit < all.length;
      return { messages: page, hasMore: more, nextCursor: more ? String(start + input.limit) : null };
    },
    async replies(input): Promise<SlackPage> {
      api.calls.push({ method: 'replies', input });
      const failure = api.failures.get('replies')?.shift();
      if (failure) throw failure;
      const all = (api.threadMessages.get(`${input.channel}:${input.ts}`) ?? [])
        .filter((m, i) => i === 0 || slice([m], input).length === 1);
      const start = input.cursor ? Number(input.cursor) : 0;
      const page = all.slice(start, start + input.limit);
      const more = start + input.limit < all.length;
      return { messages: page, hasMore: more, nextCursor: more ? String(start + input.limit) : null };
    },
  };
  return api;
}
