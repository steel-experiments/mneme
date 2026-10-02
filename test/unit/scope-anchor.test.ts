// ABOUTME: Proves the TypeScript and SQL forms of the restricted-scope anchor agree on every topology.
// ABOUTME: A thread anchors on its parent only when the parent is restricted (spec Section 7.2).
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  getChannel,
  resolveCurrentChannelScope,
  resolveRetrievableChannelScope,
  upsertChannel,
  type VisibilityClass,
} from '../../src/db/repositories/channels.js';
import { scopeAnchorId, scopeAnchorSql } from '../../src/policy/scope-anchor.js';

let env: TestDb | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function seed(id: string, visibility: VisibilityClass, parentId: string | null, isThread: boolean, guildId: string): void {
  upsertChannel(env!.db, {
    id, guildId, parentId, kind: isThread ? 'thread' : 'text', name: id, topic: null, position: 0, isThread,
    isArchived: false, isLocked: false, ingestEnabled: true, visibilityClass: visibility, allowInterventions: false,
    permissionFingerprint: null, lastMessageId: null, discoveredAtMs: 1, updatedAtMs: 1, rawJson: null,
  });
}

function sqlAnchor(id: string): string {
  return (env!.db.prepare(`SELECT ${scopeAnchorSql('c')} AS anchor FROM channels c WHERE c.id = ?`).get(id) as { anchor: string }).anchor;
}

function tsAnchor(id: string): string {
  const row = getChannel(env!.db, id)!;
  const parent = row.is_thread === 1 && row.parent_id ? getChannel(env!.db, row.parent_id) : undefined;
  return scopeAnchorId({ id: row.id, isThread: row.is_thread === 1, parentId: row.parent_id }, parent?.visibility_class);
}

describe('restricted-scope anchor', () => {
  it.each([
    { name: 'top-level restricted channel', id: 'top-restricted', expected: 'top-restricted' },
    { name: 'top-level channel below a restricted category', id: 'in-category', expected: 'in-category' },
    { name: 'thread below a restricted parent', id: 'thread-r', expected: 'parent-r' },
    { name: 'restricted thread below an org parent', id: 'thread-ro', expected: 'thread-ro' },
    { name: 'org thread below an org parent', id: 'thread-oo', expected: 'thread-oo' },
    { name: 'thread whose parent is missing', id: 'thread-orphan', expected: 'thread-orphan' },
    { name: 'Slack thread row below an org channel', id: 'C0SLACK001-T1790000000.000100', expected: 'C0SLACK001-T1790000000.000100' },
    { name: 'Slack thread row below a restricted channel', id: 'C0SLACK002-T1790000000.000200', expected: 'C0SLACK002' },
  ])('agrees in TypeScript and SQL: $name', ({ id, expected }) => {
    env = createTestDb();
    const { guildId } = seedIdentity(env.db);
    seed('category-r', 'restricted', null, false, guildId);
    seed('top-restricted', 'restricted', null, false, guildId);
    seed('in-category', 'restricted', 'category-r', false, guildId);
    seed('parent-r', 'restricted', null, false, guildId);
    seed('thread-r', 'restricted', 'parent-r', true, guildId);
    seed('parent-o', 'org', null, false, guildId);
    seed('thread-ro', 'restricted', 'parent-o', true, guildId);
    seed('thread-oo', 'org', 'parent-o', true, guildId);
    seed('thread-orphan', 'restricted', 'missing-parent', true, guildId);
    seed('C0SLACK001', 'org', null, false, guildId);
    seed('C0SLACK001-T1790000000.000100', 'restricted', 'C0SLACK001', true, guildId);
    seed('C0SLACK002', 'restricted', null, false, guildId);
    seed('C0SLACK002-T1790000000.000200', 'restricted', 'C0SLACK002', true, guildId);

    expect(tsAnchor(id)).toBe(expected);
    expect(sqlAnchor(id)).toBe(expected);
  });

  it('fails closed in both scope resolvers when a thread parent is missing or deleted', () => {
    env = createTestDb();
    const { guildId } = seedIdentity(env.db);
    seed('thread-orphan', 'restricted', 'missing-parent', true, guildId);
    seed('parent-gone', 'restricted', null, false, guildId);
    seed('thread-gone', 'restricted', 'parent-gone', true, guildId);
    env.db.prepare('UPDATE channels SET deleted_at_ms = 5 WHERE id = ?').run('parent-gone');
    for (const id of ['thread-orphan', 'thread-gone']) {
      expect(resolveCurrentChannelScope(env.db, id)).toBeUndefined();
      expect(resolveRetrievableChannelScope(env.db, id)).toBeUndefined();
    }
  });
});
