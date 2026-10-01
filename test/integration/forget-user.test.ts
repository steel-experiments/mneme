import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { pruneTerminalJobs } from '../../src/db/maintenance.js';
import { openDatabase } from '../../src/db/database.js';
import { handleForgetUserCommand } from '../../src/discord/commands/forget-user.js';
import { handleForgetMessageCommand } from '../../src/discord/commands/forget-message.js';
import { handleDeletionCommand, type DeletionCommandDeps, type DeletionCommandInput } from '../../src/discord/commands/deletion.js';
import { DELETION_GRACE_MS, getDeletionRequest, type DeletionRequest } from '../../src/memory/deletion-requests.js';
import { createExecuteDeletionHandler } from '../../src/jobs/handlers/execute-deletion.js';
import { createForgetUserHandler } from '../../src/jobs/handlers/forget-user.js';
import { claimNextJob, completeJob, enqueue, failJob, getJob, reclaimExpiredLeases } from '../../src/jobs/queue.js';

const NOW = 1_700_000_000_000;
const ROLE = '900000000000000001';
const OWNER = '900000000000000002';
const MSG = '800000000000000001';
let t: TestDb;
let identity: ReturnType<typeof seedIdentity>;
let base: DeletionCommandInput;
let deps: DeletionCommandDeps;
beforeEach(() => {
  t = createTestDb();
  identity = seedIdentity(t.db);
  base = { actorUserId: identity.userId, guildId: identity.guildId, memberRoleIds: [ROLE], invocationChannelId: identity.channelId };
  deps = { db: t.db, nowMs: NOW, adminRoleIds: [ROLE], deletionApproverUserIds: [OWNER], reviewChannelId: identity.channelId };
  message(MSG);
});
afterEach(() => t.cleanup());
function message(id: string, time = NOW): void {
  t.db.prepare(`INSERT INTO messages (id,workspace_id,channel_id,author_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms)
    VALUES (?,?,?,?,?,'uniquesecret',?,?,?)`).run(id, identity.guildId, identity.channelId, identity.userId, 'Niko', time, time, time);
}
function request(): DeletionRequest {
  handleForgetUserCommand({ ...base, userId: identity.userId }, deps);
  return t.db.prepare('SELECT * FROM deletion_requests ORDER BY created_at_ms DESC LIMIT 1').get() as unknown as DeletionRequest;
}
function approve(row: DeletionRequest): string {
  return handleDeletionCommand({ ...base, actorUserId: OWNER, subcommand: 'approve', requestId: row.id, confirmation: 'DELETE' }, deps);
}
function read(row: DeletionRequest): DeletionRequest { return getDeletionRequest(t.db, row.id, identity.guildId)!; }
function content(): unknown { return t.db.prepare('SELECT content FROM messages WHERE id = ?').get(MSG)?.content; }
async function batch(now = NOW + DELETION_GRACE_MS, batchSize = 100): Promise<void> {
  const job = claimNextJob(t.db, { type: 'execute_deletion', now, owner: 'worker', leaseMs: 60_000 });
  expect(job).toBeDefined();
  await createExecuteDeletionHandler({ db: t.db, guildId: identity.guildId, deletionApproverUserIds: deps.deletionApproverUserIds, now: () => now, batchSize })
    (JSON.parse(job!.payload_json) as { requestId: string }, job!);
  completeJob(t.db, job!.id, now);
}

describe('safe deletion requests', () => {
  it('rejects literal names and unknown IDs instead of reporting a queued purge', () => {
    expect(handleForgetUserCommand({ ...base, userId: 'niko' }, deps)).toContain('Invalid target');
    expect(handleForgetUserCommand({ ...base, userId: '700000000000000001' }, deps)).toContain('No stored');
    expect(t.db.prepare('SELECT count(*) n FROM deletion_requests').get()?.n).toBe(0);
    expect(t.db.prepare('SELECT count(*) n FROM jobs').get()?.n).toBe(0);
    expect(content()).toBe('uniquesecret');
  });
  it('requires admin access and the secure review channel before revealing any count', () => {
    expect(handleForgetUserCommand({ ...base, userId: identity.userId, memberRoleIds: [] }, deps)).toContain('not authorized');
    expect(handleForgetUserCommand({ ...base, userId: identity.userId, invocationChannelId: 'elsewhere' }, deps)).toContain('secure review');
    expect(handleForgetUserCommand({ ...base, userId: identity.userId }, { ...deps, reviewChannelId: undefined })).toContain('secure review');
    expect(t.db.prepare('SELECT count(*) n FROM deletion_requests').get()?.n).toBe(0);
  });
  it('defaults to disabled when no deletion approver is configured', () => {
    expect(handleForgetUserCommand({ ...base, userId: identity.userId }, { ...deps, deletionApproverUserIds: [] })).toContain('disabled');
  });
  it('freezes a preview without deleting, retains content for cancellation, and deduplicates requests', () => {
    const row = request();
    expect(row).toMatchObject({ status: 'pending', message_count: 1, job_id: null });
    expect(content()).toBe('uniquesecret');
    const reply = handleForgetUserCommand({ ...base, userId: identity.userId }, deps);
    expect(reply).toContain(row.id);
    expect(reply).not.toContain('uniquesecret');
    expect(t.db.prepare('SELECT count(*) n FROM deletion_requests').get()?.n).toBe(1);
  });
  it('gives forget-message the same request-only semantics', () => {
    expect(handleForgetMessageCommand({ ...base, messageId: MSG }, deps)).toContain('Nothing has been deleted');
    expect(content()).toBe('uniquesecret');
    expect(t.db.prepare('SELECT target_kind,message_count FROM deletion_requests').get()).toEqual({ target_kind: 'message', message_count: 1 });
  });
  it('requires a separate allowlisted admin and explicit confirmation', () => {
    const row = request();
    expect(handleDeletionCommand({ ...base, actorUserId: '900000000000000003', subcommand: 'approve', requestId: row.id, confirmation: 'DELETE' }, deps)).toContain('admin role alone');
    expect(handleDeletionCommand({ ...base, subcommand: 'approve', requestId: row.id, confirmation: 'DELETE' }, { ...deps, deletionApproverUserIds: [base.actorUserId] })).toContain('cannot approve your own');
    expect(handleDeletionCommand({ ...base, actorUserId: OWNER, memberRoleIds: null, subcommand: 'approve', requestId: row.id, confirmation: 'DELETE' }, deps)).toContain('not authorized');
    expect(handleDeletionCommand({ ...base, actorUserId: OWNER, subcommand: 'approve', requestId: row.id }, deps)).toContain('confirmation:DELETE');
    expect(read(row).status).toBe('pending');
    expect(approve(row)).toContain('Scheduled for deletion');
    expect(read(row)).toMatchObject({ status: 'scheduled', execute_after_ms: NOW + DELETION_GRACE_MS });
    expect(approve(row)).toContain('already scheduled');
    expect(t.db.prepare("SELECT count(*) n FROM jobs WHERE type='execute_deletion'").get()?.n).toBe(1);
  });
  it('never deletes before the deadline even if the job is made runnable early', async () => {
    const row = request(); approve(row);
    expect(claimNextJob(t.db, { type: 'execute_deletion', now: NOW, owner: 'worker', leaseMs: 60_000 })).toBeUndefined();
    t.db.prepare("UPDATE jobs SET run_after_ms = ? WHERE type='execute_deletion'").run(NOW);
    await batch(NOW);
    expect(content()).toBe('uniquesecret');
    expect(getJob(t.db, read(row).job_id!)?.run_after_ms).toBe(NOW + DELETION_GRACE_MS);
    expect(read(row).status).toBe('scheduled');
  });
  it.each(['pending', 'scheduled'] as const)('requester can cancel %s without losing any data', async (state) => {
    const row = request(); if (state === 'scheduled') approve(row);
    const jobId = read(row).job_id;
    expect(handleDeletionCommand({ ...base, subcommand: 'cancel', requestId: row.id }, deps)).toContain('No messages were deleted');
    expect(read(row).status).toBe('cancelled');
    if (jobId) expect(getJob(t.db, jobId)?.status).toBe('cancelled');
    expect(t.db.prepare('SELECT count(*) n FROM deletion_request_messages').get()?.n).toBe(0);
    expect(content()).toBe('uniquesecret');
    expect(approve(row)).toContain('already cancelled');
  });
  it('allows owner cancellation but not an unrelated administrator', () => {
    const row = request(); approve(row);
    expect(handleDeletionCommand({ ...base, actorUserId: '700000000000000002', subcommand: 'cancel', requestId: row.id }, deps)).toContain('Only the requester');
    expect(handleDeletionCommand({ ...base, actorUserId: OWNER, subcommand: 'cancel', requestId: row.id }, deps)).toContain('cancelled');
  });
  it('cancellation wins even after a job is leased but before purge starts', async () => {
    const row = request(); approve(row);
    const now = NOW + DELETION_GRACE_MS;
    const job = claimNextJob(t.db, { type: 'execute_deletion', now, owner: 'worker', leaseMs: 60_000 })!;
    handleDeletionCommand({ ...base, subcommand: 'cancel', requestId: row.id }, { ...deps, nowMs: now });
    await createExecuteDeletionHandler({ db: t.db, guildId: identity.guildId, deletionApproverUserIds: [OWNER], now: () => now })({ requestId: row.id }, job);
    expect(content()).toBe('uniquesecret');
    expect(read(row).status).toBe('cancelled');
  });
  it('purges content, FTS, evidence, memory support, and durably queues attachment removal', async () => {
    t.db.prepare(`INSERT INTO memories (id,workspace_id,scope_type,type,statement,status,confidence,importance,
      first_seen_at_ms,last_confirmed_at_ms,created_at_ms,updated_at_ms)
      VALUES ('memory',?,'org','decision','derived statement','active',0.8,0.7,?,?,?,?)`).run(identity.guildId, NOW, NOW, NOW, NOW);
    t.db.prepare("INSERT INTO memory_evidence (memory_id,message_id,stance,weight,created_at_ms) VALUES ('memory',?,'origin',1,?)").run(MSG, NOW);
    t.db.prepare(`INSERT INTO attachments (id,message_id,filename,size_bytes,source_url,archive_status,local_path,created_at_ms,updated_at_ms)
      VALUES ('att',?,'file',1,'https://example.com','stored','/archive/file',?,?)`).run(MSG, NOW, NOW);
    const row = request(); approve(row); await batch();
    expect(content()).toBe('');
    expect(t.db.prepare('SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH ?').get('uniquesecret')?.n).toBe(0);
    expect(t.db.prepare('SELECT count(*) n FROM memory_evidence').get()?.n).toBe(0);
    expect(t.db.prepare("SELECT status FROM memories WHERE id='memory'").get()?.status).toBe('invalidated');
    expect(t.db.prepare("SELECT count(*) n FROM jobs WHERE type='purge_attachment_file'").get()?.n).toBe(1);
    expect(read(row)).toMatchObject({ status: 'completed', processed_count: 1 });
    expect(t.db.prepare('SELECT message_id FROM message_tombstones').get()?.message_id).toBe(MSG);
    expect(JSON.stringify(t.db.prepare('SELECT details_json FROM admin_events').all())).not.toContain('uniquesecret');
  });
  it('never adds new messages or late backfilled history to the approved manifest', async () => {
    const row = request();
    message('800000000000000002', NOW + 1);
    message('800000000000000003', NOW - 100_000);
    approve(row); await batch();
    expect(t.db.prepare('SELECT count(*) n FROM messages WHERE deleted_at_ms IS NULL').get()?.n).toBe(2);
    expect(content()).toBe('');
  });
  it('continues bounded batches after reopen and denies undo once any purge has started', async () => {
    message('800000000000000002');
    const row = request(); approve(row); await batch(NOW + DELETION_GRACE_MS, 1);
    expect(read(row)).toMatchObject({ status: 'executing', processed_count: 1 });
    expect(handleDeletionCommand({ ...base, subcommand: 'cancel', requestId: row.id }, deps)).toContain('before the purge starts');
    t.db.close(); t.db = openDatabase(t.path); deps.db = t.db;
    await batch(NOW + DELETION_GRACE_MS + 1, 1);
    expect(read(row)).toMatchObject({ status: 'completed', processed_count: 2 });
    expect(handleDeletionCommand({ ...base, subcommand: 'cancel', requestId: row.id }, deps)).toContain('cannot be undone');
  });
  it('does not delete after the approver allowlist is revoked', async () => {
    const row = request(); approve(row); deps.deletionApproverUserIds = [];
    await batch();
    expect(content()).toBe('uniquesecret');
    expect(read(row).status).toBe('cancelled');
    expect(t.db.prepare("SELECT action FROM admin_events WHERE action='deletion_authority_revoked'").get()).toBeDefined();
  });
  it('reclaims crashed leases and only lets the original approver retry terminal job failures', async () => {
    const row = request(); approve(row);
    const now = NOW + DELETION_GRACE_MS;
    const oldJob = claimNextJob(t.db, { type: 'execute_deletion', now, owner: 'crashed', leaseMs: 1 })!;
    expect(reclaimExpiredLeases(t.db, now + 2)).toBe(1);
    const job = claimNextJob(t.db, { type: 'execute_deletion', now: now + 2, owner: 'worker', leaseMs: 60_000 })!;
    expect(job.id).toBe(oldJob.id);
    t.db.prepare('UPDATE jobs SET max_attempts = 1 WHERE id = ?').run(job.id);
    failJob(t.db, { id: job.id, error: new Error('failure'), now: now + 2 });
    expect(handleDeletionCommand({ ...base, subcommand: 'status', requestId: row.id }, deps)).toContain('Worker failed');
    expect(handleDeletionCommand({ ...base, subcommand: 'retry', requestId: row.id }, deps)).toContain('Only a configured');
    expect(handleDeletionCommand({ ...base, actorUserId: OWNER, subcommand: 'retry', requestId: row.id }, { ...deps, nowMs: now + 2 })).toContain('retry queued');
    await batch(now + 3);
    expect(read(row).status).toBe('completed');
  });
  it('ignores stale or forged job ownership and isolates request lookups by guild', async () => {
    const row = request(); approve(row);
    const now = NOW + DELETION_GRACE_MS;
    const job = claimNextJob(t.db, { type: 'execute_deletion', now, owner: 'worker', leaseMs: 60_000 })!;
    const handler = createExecuteDeletionHandler({ db: t.db, guildId: identity.guildId, deletionApproverUserIds: [OWNER], now: () => now });
    await handler({ requestId: row.id }, { ...job, id: 'different' });
    await handler({ requestId: row.id }, { ...job, lease_owner: 'stale' });
    expect(content()).toBe('uniquesecret');
    expect(getDeletionRequest(t.db, row.id, 'different-guild')).toBeUndefined();
  });
  it('rolls back a partially attempted batch and its evidence/tombstone changes on failure', async () => {
    message('800000000000000002');
    const row = request(); approve(row);
    t.db.exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON messages WHEN NEW.id = '800000000000000002'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    await expect(batch()).rejects.toThrow('injected failure');
    expect(content()).toBe('uniquesecret');
    expect(read(row)).toMatchObject({ status: 'scheduled', processed_count: 0 });
    expect(t.db.prepare('SELECT count(*) n FROM message_tombstones').get()?.n).toBe(0);
  });
  it('requeues an expired lease instead of stranding a scheduled request as succeeded', async () => {
    const row = request(); approve(row);
    const now = NOW + DELETION_GRACE_MS;
    const job = claimNextJob(t.db, { type: 'execute_deletion', now, owner: 'worker', leaseMs: 1 })!;
    await createExecuteDeletionHandler({ db: t.db, guildId: identity.guildId, deletionApproverUserIds: [OWNER], now: () => now + 2 })({ requestId: row.id }, job);
    completeJob(t.db, job.id, now + 2);
    expect(getJob(t.db, job.id)?.status).toBe('queued');
    expect(content()).toBe('uniquesecret');
    await batch(now + 3);
    expect(read(row).status).toBe('completed');
  });
  it('retains a failed job while its request needs recovery, then prunes it after cancellation', () => {
    const row = request(); approve(row);
    const now = NOW + DELETION_GRACE_MS;
    const job = claimNextJob(t.db, { type: 'execute_deletion', now, owner: 'worker', leaseMs: 60_000 })!;
    t.db.prepare('UPDATE jobs SET max_attempts = 1 WHERE id = ?').run(job.id);
    failJob(t.db, { id: job.id, error: new Error('failure'), now });
    const later = now + 40 * DELETION_GRACE_MS;
    expect(pruneTerminalJobs(t.db, { nowMs: later, retentionDays: 30 }).deleted).toBe(0);
    expect(handleDeletionCommand({ ...base, subcommand: 'status', requestId: row.id }, deps)).toContain('Worker failed');
    handleDeletionCommand({ ...base, subcommand: 'cancel', requestId: row.id }, deps);
    expect(pruneTerminalJobs(t.db, { nowMs: later, retentionDays: 30 }).deleted).toBe(1);
  });
  it('legacy forget-user jobs can never bypass approval', async () => {
    enqueue(t.db, { type: 'forget_user', payload: { userId: identity.userId }, now: NOW });
    const job = claimNextJob(t.db, { type: 'forget_user', owner: 'worker', now: NOW, leaseMs: 60_000 })!;
    await expect(createForgetUserHandler()({ userId: identity.userId }, job)).rejects.toThrow('Legacy deletion disabled');
    expect(content()).toBe('uniquesecret');
  });
});
