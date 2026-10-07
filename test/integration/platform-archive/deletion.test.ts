// ABOUTME: Tests deletion requests for archive targets (plan 011 step 9): the existing request, approval, and grace flow.
// ABOUTME: Execution writes one archive redaction and no live rows; the target then disappears from every archive read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../../helpers/db.js';
import { handleForgetUserCommand } from '../../../src/commands/forget-user.js';
import { handleForgetMessageCommand } from '../../../src/commands/forget-message.js';
import { handleArchiveCommand } from '../../../src/commands/archive.js';
import { handleDeletionCommand, type DeletionCommandDeps, type DeletionCommandInput } from '../../../src/commands/deletion.js';
import { DELETION_GRACE_MS, type DeletionRequest } from '../../../src/memory/deletion-requests.js';
import { createExecuteDeletionHandler } from '../../../src/jobs/handlers/execute-deletion.js';
import { claimNextJob, completeJob, failJob, getJob } from '../../../src/jobs/queue.js';
import { openArchiveDatabase, verifyArchive } from '../../../src/platform-archive/database.js';
import {
  createArchiveReader,
  getArchiveMemoryEvidence,
  getArchiveMessage,
  getArchiveMessageContext,
  searchArchiveMemories,
  searchArchiveMessages,
  searchArchiveUsers,
  type ArchiveReader,
} from '../../../src/platform-archive/read.js';
import { mcpToolCall } from '../../../src/mcp/tools.js';
import {
  ARCHIVE_AUTHOR,
  ARCHIVE_GUILD,
  ARCHIVE_MEMORIES,
  ARCHIVE_MESSAGES,
  createArchiveFixture,
  type ArchiveFixture,
} from '../../helpers/archive.js';

const NOW = 1_790_000_000_000;
const ROLE = '900000000000000001';
const OWNER = '900000000000000002';
const LIVE_MESSAGE = '800000000000000001';

let live: TestDb;
let identity: ReturnType<typeof seedIdentity>;
let fixture: ArchiveFixture;
let archiveDb: DatabaseSync;
let reader: ArchiveReader;
let base: DeletionCommandInput;
let deps: DeletionCommandDeps;

beforeEach(() => {
  live = createTestDb();
  identity = seedIdentity(live.db);
  live.db.prepare(`INSERT INTO messages (id,workspace_id,channel_id,author_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms)
    VALUES (?,?,?,?,?,'live secret',?,?,?)`).run(LIVE_MESSAGE, identity.guildId, identity.channelId, identity.userId, 'Niko', NOW, NOW, NOW);
  fixture = createArchiveFixture();
  archiveDb = openArchiveDatabase(fixture.path);
  const summary = verifyArchive(archiveDb, fixture.path, { platform: 'discord', newestSchemaVersion: 1_000 });
  reader = createArchiveReader({ db: archiveDb, liveDb: live.db, summary });
  base = { actorUserId: identity.userId, guildId: identity.guildId, memberRoleIds: [ROLE], invocationChannelId: identity.channelId };
  deps = { db: live.db, nowMs: NOW, adminRoleIds: [ROLE], deletionApproverUserIds: [OWNER], reviewChannelId: identity.channelId, archive: reader };
});

afterEach(() => {
  try { archiveDb.close(); } catch { /* already closed */ }
  fixture.cleanup();
  live.cleanup();
});

function latest(): DeletionRequest {
  return live.db.prepare('SELECT * FROM deletion_requests ORDER BY created_at_ms DESC LIMIT 1').get() as unknown as DeletionRequest;
}
function approve(row: DeletionRequest): string {
  return handleDeletionCommand({ ...base, actorUserId: OWNER, subcommand: 'approve', requestId: row.id, confirmation: 'DELETE' }, deps);
}
function redactionCount(): number {
  return Number(live.db.prepare('SELECT count(*) AS n FROM archive_redactions').get()?.n ?? 0);
}
function liveSnapshot(): unknown {
  return {
    messages: live.db.prepare('SELECT id, content, deleted_at_ms FROM messages ORDER BY id').all(),
    tombstones: live.db.prepare('SELECT count(*) AS n FROM message_tombstones').get(),
  };
}
async function execute(archive: { workspaceId: string; sha256: string } | null = reader.summary,
  now = NOW + DELETION_GRACE_MS): Promise<string> {
  const job = claimNextJob(live.db, { type: 'execute_deletion', now, owner: 'worker', leaseMs: 60_000 });
  expect(job).toBeDefined();
  try {
    await createExecuteDeletionHandler({ db: live.db, guildId: identity.guildId, deletionApproverUserIds: [OWNER], now: () => now, archive: archive ?? undefined })
      (JSON.parse(job!.payload_json) as { requestId: string }, job!);
    completeJob(live.db, job!.id, now);
    return 'completed';
  } catch (err) {
    failJob(live.db, { id: job!.id, error: err, now, jitterMs: 0 });
    return 'failed';
  }
}

describe('archive deletion requests', () => {
  it('fails cleanly when no archive is configured', () => {
    const reply = handleForgetMessageCommand({ ...base, messageId: `archive:${ARCHIVE_MESSAGES.org}` }, { ...deps, archive: undefined });
    expect(reply).toContain('No platform archive is configured');
    expect(live.db.prepare('SELECT count(*) AS n FROM deletion_requests').get()?.n).toBe(0);
  });

  it('rejects an archive id that does not match the archive platform', () => {
    expect(handleForgetMessageCommand({ ...base, messageId: 'archive:not-an-id' }, deps)).toContain('Invalid archive target');
    expect(handleForgetUserCommand({ ...base, userId: 'archive:U123' }, deps)).toContain('Invalid archive target');
    expect(live.db.prepare('SELECT count(*) AS n FROM deletion_requests').get()?.n).toBe(0);
  });

  it('keeps the admin and secure review channel checks', () => {
    const target = `archive:${ARCHIVE_MESSAGES.org}`;
    expect(handleForgetMessageCommand({ ...base, messageId: target, memberRoleIds: [] }, deps)).toContain('not authorized');
    expect(handleForgetMessageCommand({ ...base, messageId: target, invocationChannelId: 'elsewhere' }, deps)).toContain('secure review');
  });

  it('reports nothing to do when no archive message matches', () => {
    expect(handleForgetMessageCommand({ ...base, messageId: 'archive:300000000000000999' }, deps)).toContain('No archive messages match');
    expect(live.db.prepare('SELECT count(*) AS n FROM deletion_requests').get()?.n).toBe(0);
  });

  it('runs an archive message through request, independent approval, grace, and one redaction', async () => {
    const before = liveSnapshot();
    const reply = handleForgetMessageCommand({ ...base, messageId: `archive:${ARCHIVE_MESSAGES.org}` }, deps);
    expect(reply).toContain('archive message');
    expect(reply).toContain('Nothing has been deleted');
    const row = latest();
    expect(row).toMatchObject({ target_kind: 'message', target_id: `archive:${ARCHIVE_MESSAGES.org}`, status: 'pending', message_count: 1 });
    expect(getArchiveMessage(reader, `archive:${ARCHIVE_MESSAGES.org}`)).not.toBeNull();

    expect(handleDeletionCommand({ ...base, subcommand: 'approve', requestId: row.id, confirmation: 'DELETE' }, { ...deps, deletionApproverUserIds: [identity.userId] }))
      .toContain('cannot approve your own');
    expect(approve(row)).toContain('Scheduled for deletion');
    expect(redactionCount()).toBe(0);

    // The purge job cannot even be claimed before the grace period ends.
    expect(claimNextJob(live.db, { type: 'execute_deletion', now: NOW + 1, owner: 'worker', leaseMs: 60_000 })).toBeUndefined();
    expect(redactionCount()).toBe(0);
    expect(getArchiveMessage(reader, `archive:${ARCHIVE_MESSAGES.org}`)).not.toBeNull();

    expect(await execute()).toBe('completed');
    expect(live.db.prepare('SELECT archive_workspace_id, target_kind, target_id, archive_sha256, deletion_request_id FROM archive_redactions').all())
      .toEqual([{ archive_workspace_id: ARCHIVE_GUILD, target_kind: 'message', target_id: ARCHIVE_MESSAGES.org,
        archive_sha256: reader.summary.sha256, deletion_request_id: row.id }]);
    expect(live.db.prepare('SELECT status, processed_count FROM deletion_requests WHERE id = ?').get(row.id))
      .toEqual({ status: 'completed', processed_count: 1 });
    expect(liveSnapshot()).toEqual(before);

    expect(getArchiveMessage(reader, `archive:${ARCHIVE_MESSAGES.org}`)).toBeNull();
    expect(getArchiveMessageContext(reader, `archive:${ARCHIVE_MESSAGES.org}`)).toBeNull();
    expect(searchArchiveMessages(reader, { query: 'billing decision', limit: 50 }).map((m) => m.messageId)).not.toContain(ARCHIVE_MESSAGES.org);
    expect(getArchiveMemoryEvidence(reader, `archive:${ARCHIVE_MEMORIES.org}`)).toBeNull();
    expect(searchArchiveMemories(reader, {}).map((m) => m.memoryId)).not.toContain(ARCHIVE_MEMORIES.org);
    const mcp = await mcpToolCall({ name: 'get_archive_message_context', arguments: { id: `archive:${ARCHIVE_MESSAGES.org}` } }, {
      grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] },
      db: live.db, nowMs: NOW, tokenScopeType: 'org', archive: reader,
    });
    expect(JSON.stringify(mcp)).not.toContain('archived org billing decision');
  });

  it('runs an archive user through the same flow and hides the user from every read and the lookup', async () => {
    expect(searchArchiveUsers(reader, { name: 'archive', limit: 10 }))
      .toEqual([{ id: `archive:${ARCHIVE_AUTHOR}`, userId: ARCHIVE_AUTHOR, displayName: 'Archive Author', orgMessageCount: 2 }]);
    const reply = handleForgetUserCommand({ ...base, userId: `archive:${ARCHIVE_AUTHOR}` }, deps);
    expect(reply).toContain('archive user');
    expect(reply).toContain('does not remove');
    const row = latest();
    // Only the servable org messages count: restricted, review-only, and excluded ones are never confirmed.
    expect(row).toMatchObject({ target_kind: 'user', target_id: `archive:${ARCHIVE_AUTHOR}`, message_count: 2 });
    approve(row);
    expect(await execute()).toBe('completed');
    expect(live.db.prepare('SELECT target_kind, target_id FROM archive_redactions').all()).toEqual([{ target_kind: 'user', target_id: ARCHIVE_AUTHOR }]);
    expect(searchArchiveMessages(reader, { query: 'billing decision', limit: 50 })).toEqual([]);
    expect(searchArchiveMemories(reader, {})).toEqual([]);
    expect(searchArchiveUsers(reader, { name: 'archive', limit: 10 })).toEqual([]);
  });

  it('never writes a redaction for a live target, even with an archive configured', async () => {
    handleForgetMessageCommand({ ...base, messageId: LIVE_MESSAGE }, deps);
    approve(latest());
    expect(await execute()).toBe('completed');
    expect(redactionCount()).toBe(0);
    expect(live.db.prepare('SELECT content FROM messages WHERE id = ?').get(LIVE_MESSAGE)?.content).toBe('');
  });

  it('writes no redaction when the request is cancelled during the grace period', async () => {
    handleForgetMessageCommand({ ...base, messageId: `archive:${ARCHIVE_MESSAGES.org}` }, deps);
    const row = latest();
    approve(row);
    expect(handleDeletionCommand({ ...base, actorUserId: OWNER, subcommand: 'cancel', requestId: row.id }, deps)).toContain('cancelled');
    expect(redactionCount()).toBe(0);
    expect(getArchiveMessage(reader, `archive:${ARCHIVE_MESSAGES.org}`)).not.toBeNull();
  });

  it('fails the purge job without a redaction when the archive is gone at execution', async () => {
    handleForgetMessageCommand({ ...base, messageId: `archive:${ARCHIVE_MESSAGES.org}` }, deps);
    const row = latest();
    approve(row);
    expect(await execute(null)).toBe('failed');
    expect(redactionCount()).toBe(0);
    expect(live.db.prepare('SELECT status FROM deletion_requests WHERE id = ?').get(row.id)?.status).toBe('scheduled');
    expect(getJob(live.db, latest().job_id!)?.status).not.toBe('succeeded');
  });

  it('does not confirm or count archive messages that the archive never serves', () => {
    for (const id of [ARCHIVE_MESSAGES.restricted, ARCHIVE_MESSAGES.reviewOnly, ARCHIVE_MESSAGES.excluded, ARCHIVE_MESSAGES.restrictedThread]) {
      expect(handleForgetMessageCommand({ ...base, messageId: `archive:${id}` }, deps)).toContain('No archive messages match');
    }
    expect(live.db.prepare('SELECT count(*) AS n FROM deletion_requests').get()?.n).toBe(0);
    // ARCHIVE_AUTHOR wrote one message in every channel role; only the org
    // channel message and the org thread message are servable.
    handleForgetUserCommand({ ...base, userId: `archive:${ARCHIVE_AUTHOR}` }, deps);
    expect(latest().message_count).toBe(2);
  });

  it('stores the archive workspace and refuses to execute against a different archive', async () => {
    handleForgetMessageCommand({ ...base, messageId: `archive:${ARCHIVE_MESSAGES.org}` }, deps);
    const row = latest();
    expect(row.archive_workspace_id).toBe(reader.summary.workspaceId);
    approve(row);
    // The operator pointed MNEME_ARCHIVE_PATH at another workspace's archive during the grace period.
    expect(await execute({ workspaceId: '900000000000000999', sha256: 'other-archive' })).toBe('failed');
    expect(redactionCount()).toBe(0);
    expect(live.db.prepare('SELECT status FROM deletion_requests WHERE id = ?').get(row.id)?.status).toBe('scheduled');
    expect(String(getJob(live.db, latest().job_id!)?.last_error)).toMatch(/different archive/);
    expect(getArchiveMessage(reader, `archive:${ARCHIVE_MESSAGES.org}`)).not.toBeNull();
  });

  it('refuses a second request for a target that is already hidden', async () => {
    handleForgetMessageCommand({ ...base, messageId: `archive:${ARCHIVE_MESSAGES.org}` }, deps);
    approve(latest());
    await execute();
    expect(handleForgetMessageCommand({ ...base, messageId: `archive:${ARCHIVE_MESSAGES.org}` }, deps)).toContain('already hidden');
  });

  it('names archive targets in deletion status', () => {
    handleForgetUserCommand({ ...base, userId: `archive:${ARCHIVE_AUTHOR}` }, deps);
    const status = handleDeletionCommand({ ...base, subcommand: 'status' }, deps);
    expect(status).toContain(`archive user \`${ARCHIVE_AUTHOR}\``);
    expect(status).not.toContain(`<@archive:`);
  });
});

describe('archive user lookup', () => {
  it('lists org authors by name with their archive id, and needs admin rights in the secure review channel', () => {
    const reply = handleArchiveCommand({ ...base, subcommand: 'user', name: 'Archive' }, deps);
    expect(reply).toContain(`archive:${ARCHIVE_AUTHOR}`);
    expect(reply).toContain('Archive Author');
    expect(reply).toContain('2 org messages');
    expect(handleArchiveCommand({ ...base, subcommand: 'user', name: 'Archive', memberRoleIds: [] }, deps)).toContain('not authorized');
    expect(handleArchiveCommand({ ...base, subcommand: 'user', name: 'Archive', invocationChannelId: 'elsewhere' }, deps)).toContain('secure review');
    expect(handleArchiveCommand({ ...base, subcommand: 'user', name: 'Archive' }, { ...deps, archive: undefined })).toContain('No platform archive is configured');
  });

  it('files an archive user request from the archive group', () => {
    const reply = handleArchiveCommand({ ...base, subcommand: 'forget-user', id: ARCHIVE_AUTHOR }, deps);
    expect(reply).toContain('Nothing has been deleted');
    expect(latest()).toMatchObject({ target_kind: 'user', target_id: `archive:${ARCHIVE_AUTHOR}` });
  });

  it('treats LIKE wildcards in the name as plain text', () => {
    expect(searchArchiveUsers(reader, { name: '%', limit: 10 })).toEqual([]);
    expect(searchArchiveUsers(reader, { name: '_', limit: 10 })).toEqual([]);
  });
});
