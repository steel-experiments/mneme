import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  repairDeepRecapOwnership,
  repairDurableWork,
} from '../../src/jobs/startup-repair.js';
import {
  DIRECT_ANSWER_PRIORITY,
  directAnswerJobKey,
} from '../../src/jobs/direct-answer-identity.js';
import { getDirectAnswerRequest } from '../../src/db/repositories/direct-answers.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { claimNextJob, failJob } from '../../src/jobs/queue.js';

const NOW = 1_700_000_000_000;

describe('durable startup repair', () => {
  let env: TestDb;
  let ids: ReturnType<typeof seedIdentity>;
  beforeEach(() => { env = createTestDb(); ids = seedIdentity(env.db); });
  afterEach(() => env.cleanup());

  it('repairs stranded episode, backfill, proposal, and file work idempotently', () => {
    env.db.prepare(`INSERT INTO episodes
      (id,workspace_id,conversation_channel_id,status,started_at_ms,last_activity_at_ms,created_at_ms,updated_at_ms)
      VALUES ('reviewing',?,?,'reviewing',?,?,?,?),('open',?,?,'open',?,?,?,?)`)
      .run(ids.guildId, ids.channelId, NOW, NOW, NOW, NOW,
        ids.guildId, ids.channelId, NOW, NOW, NOW, NOW);
    env.db.prepare(`INSERT INTO sync_cursors (channel_id,state,history_complete,retry_count,updated_at_ms)
      VALUES (?,'backfilling',0,0,?)`).run(ids.channelId, NOW);
    env.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
      VALUES ('run-repair',?,'episode','p','x','x','completed',?)`).run(ids.guildId, NOW);
    env.db.prepare(`INSERT INTO proposals
      (id,run_id,target_channel_id,status,computed_score,reason,message,evidence_message_ids_json,created_at_ms,updated_at_ms)
      VALUES ('proposal-repair','run-repair',?,'approved',1,'ok','send me','[]',?,?)`)
      .run(ids.channelId, NOW, NOW);
    env.db.prepare(`INSERT INTO attachment_file_purges
      (id,local_path,status,attempts,created_at_ms,updated_at_ms)
      VALUES ('purge-repair','/tmp/mneme-repair-test','queued',0,?,?)`).run(NOW, NOW);

    const first = repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });
    expect(first.reviewsReset).toBe(1);
    expect(first.reviewJobs).toBe(1);
    expect(first.closeJobs).toBe(1);
    expect(first.backfillJobs).toBe(1);
    expect(first.approvedOutboxes).toBe(1);
    expect(first.purgeJobs).toBe(1);
    expect((env.db.prepare("SELECT status FROM episodes WHERE id='reviewing'").get() as { status: string }).status).toBe('queued');

    const second = repairDurableWork(env.db, { now: NOW + 2, quietSeconds: 90 });
    expect(second).toEqual({ proposalsExpired: 0, scheduledReviewCardsFailed: 0,
      reviewsReset: 0, reviewJobs: 0, closeJobs: 0,
      backfillJobs: 0, approvedOutboxes: 0, purgeJobs: 0, directAnswerJobs: 0, ingestionRecoveryJobs: 0,
      proposalReviewSyncJobs: 0,
      channelPolicyReviewJobs: 0,
      deepRecapJobs: 0, deepRecapRunningJobsRecovered: 0,
      deepRecapDuplicateJobsCancelled: 0, deepRecapChunksReset: 0 });
  });

  it('restores channel-policy card delivery while preserving sending recovery state', () => {
    env.db.prepare(`INSERT INTO channel_policy_reviews
      (id,workspace_id,channel_id,status,delivery_state,created_at_ms,updated_at_ms)
      VALUES ('channel-review',?,?,'pending','sending',?,?)`)
      .run(ids.guildId, ids.channelId, NOW, NOW);
    env.db.prepare(`INSERT INTO jobs
      (id,type,unique_key,payload_json,status,priority,run_after_ms,lease_owner,
       lease_until_ms,attempts,max_attempts,created_at_ms,updated_at_ms)
      VALUES ('channel-review-job','deliver_channel_policy_review',
       'channel-policy-review:channel-review','{"reviewId":"channel-review"}',
       'running',40,?,'old-process',?,1,10,?,?)`)
      .run(NOW, NOW + 60_000, NOW, NOW);

    repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });

    expect(env.db.prepare("SELECT status,lease_owner FROM jobs WHERE id='channel-review-job'").get())
      .toEqual({ status: 'queued', lease_owner: null });
    expect(env.db.prepare("SELECT delivery_state FROM channel_policy_reviews WHERE id='channel-review'").get())
      .toEqual({ delivery_state: 'sending' });
  });

  it('restores one durable status-sync job for a terminal proposal card', () => {
    env.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
      VALUES ('run-card-sync',?,'scheduled_review','p','x','x','completed',?)`)
      .run(ids.guildId, NOW);
    env.db.prepare(`INSERT INTO proposals
      (id,run_id,target_channel_id,status,computed_score,reason,message,
       evidence_message_ids_json,review_message_id,created_at_ms,updated_at_ms)
      VALUES ('proposal-card-sync','run-card-sync',?,'sent',1,'ok','sent text','[]',
              'review-card-message',?,?)`)
      .run(ids.channelId, NOW, NOW);
    env.db.prepare(`INSERT INTO outbox
      (id,proposal_id,channel_id,content,dedupe_key,status,platform_message_id,
       attempts,next_attempt_at_ms,created_at_ms,sent_at_ms,updated_at_ms)
      VALUES ('outbox-card-sync','proposal-card-sync',?,'sent text','proposal:proposal-card-sync',
              'sent','delivered-message',1,?,?,?,?)`)
      .run(ids.channelId, NOW, NOW, NOW, NOW);

    const first = repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });
    expect(first.proposalReviewSyncJobs).toBe(1);
    expect(env.db.prepare(`SELECT type,unique_key,payload_json,status FROM jobs
      WHERE type='sync_proposal_review'`).get()).toEqual({
      type: 'sync_proposal_review',
      unique_key: 'proposal-review-status:proposal-card-sync',
      payload_json: '{"proposalId":"proposal-card-sync"}',
      status: 'queued',
    });
    expect(repairDurableWork(env.db, { now: NOW + 2, quietSeconds: 90 }).proposalReviewSyncJobs)
      .toBe(0);
  });

  it('fails a stranded scheduled-review proposal with no delivered card', () => {
    env.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
      VALUES ('run-scheduled-orphan',?,'scheduled_review','p','x','x','completed',?),
             ('run-episode-orphan',?,'episode','p','x','x','completed',?)`)
      .run(ids.guildId, NOW, ids.guildId, NOW);
    const insert = env.db.prepare(`INSERT INTO proposals
      (id,run_id,target_channel_id,status,computed_score,reason,message,
       evidence_message_ids_json,expires_at_ms,created_at_ms,updated_at_ms)
      VALUES (?,?,?,'pending_review',1,'review','safe','[]',?,?,?)`);
    insert.run('scheduled-orphan', 'run-scheduled-orphan', ids.channelId, NOW + 60_000, NOW, NOW);
    insert.run('episode-orphan', 'run-episode-orphan', ids.channelId, NOW + 60_000, NOW, NOW);

    const report = repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });
    expect(report.scheduledReviewCardsFailed).toBe(1);
    expect(env.db.prepare('SELECT id,status FROM proposals ORDER BY id').all()).toEqual([
      { id: 'episode-orphan', status: 'pending_review' },
      { id: 'scheduled-orphan', status: 'failed' },
    ]);
  });

  it('expires a legacy pending scheduled proposal aimed at the approval inbox', () => {
    const reviewChannelId = '100000000000000099';
    upsertChannel(env.db, {
      id: reviewChannelId, guildId: ids.guildId, parentId: null, kind: 'text',
      name: 'mneme-review', topic: null, position: null, isThread: false,
      isArchived: false, isLocked: false, ingestEnabled: true,
      visibilityClass: 'review_only', allowInterventions: false,
      permissionFingerprint: null, lastMessageId: null, discoveredAtMs: NOW,
      updatedAtMs: NOW, rawJson: null,
    });
    env.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
      VALUES ('legacy-scheduled-run',?,'scheduled_review','p','x','x','completed',?)`)
      .run(ids.guildId, NOW);
    env.db.prepare(`INSERT INTO proposals
      (id,run_id,target_channel_id,status,computed_score,reason,message,
       evidence_message_ids_json,review_message_id,expires_at_ms,created_at_ms,updated_at_ms)
      VALUES ('legacy-scheduled','legacy-scheduled-run',?,'pending_review',1,'review','safe',
              '[]','legacy-card',?,?,?)`)
      .run(reviewChannelId, NOW + 60_000, NOW, NOW);

    const report = repairDurableWork(env.db, {
      now: NOW + 1,
      quietSeconds: 90,
      scheduledRouteOptions: {
        guildId: ids.guildId,
        reviewChannelId,
        reviewAcceptedScopes: ['org', 'restricted', 'review_only'],
      },
    });

    expect(report.proposalsExpired).toBe(1);
    expect(env.db.prepare("SELECT status FROM proposals WHERE id='legacy-scheduled'").get())
      .toEqual({ status: 'expired' });
    expect(env.db.prepare(`SELECT type,payload_json FROM jobs
      WHERE type='sync_proposal_review'`).get()).toEqual({
      type: 'sync_proposal_review',
      payload_json: '{"proposalId":"legacy-scheduled"}',
    });
  });

  it('converges past proposal deadlines before startup and remains restart-idempotent', () => {
    env.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
      VALUES ('run-expiry',?,'episode','p','x','x','completed',?)`)
      .run(ids.guildId, NOW);
    const insert = env.db.prepare(`INSERT INTO proposals
      (id,run_id,target_channel_id,status,computed_score,reason,message,
       evidence_message_ids_json,expires_at_ms,created_at_ms,updated_at_ms)
      VALUES (?,'run-expiry',? ,?,1,'review','safe','[]',?,?,?)`);
    insert.run('past', ids.channelId, 'pending_review', NOW - 1, NOW, NOW);
    insert.run('boundary', ids.channelId, 'pending_review', NOW, NOW, NOW);
    insert.run('future', ids.channelId, 'pending_review', NOW + 1, NOW, NOW);
    insert.run('no-deadline', ids.channelId, 'pending_review', null, NOW, NOW);
    insert.run('dismissed-past', ids.channelId, 'dismissed', NOW - 1, NOW, NOW);

    const first = repairDurableWork(env.db, { now: NOW, quietSeconds: 90 });
    expect(first.proposalsExpired).toBe(1);
    expect(env.db.prepare('SELECT id,status FROM proposals ORDER BY id').all()).toEqual([
      { id: 'boundary', status: 'pending_review' },
      { id: 'dismissed-past', status: 'dismissed' },
      { id: 'future', status: 'pending_review' },
      { id: 'no-deadline', status: 'pending_review' },
      { id: 'past', status: 'expired' },
    ]);

    const restarted = repairDurableWork(env.db, { now: NOW, quietSeconds: 90 });
    expect(restarted.proposalsExpired).toBe(0);

    const afterBoundary = repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });
    expect(afterBoundary.proposalsExpired).toBe(1);
    expect(env.db.prepare("SELECT status FROM proposals WHERE id='boundary'").get())
      .toEqual({ status: 'expired' });
  });

  it('recreates one active owner for a stranded pending direct request', () => {
    env.db.prepare(`INSERT INTO jobs (
      id, type, unique_key, payload_json, status, priority, run_after_ms,
      attempts, max_attempts, created_at_ms, updated_at_ms, completed_at_ms
    ) VALUES (
      'failed-direct','direct_answer',?,?,'failed',?, ?,2,2,?,?,?
    )`).run(
      directAnswerJobKey('pending-message'),
      JSON.stringify({ messageId: 'pending-message', channelId: ids.channelId }),
      DIRECT_ANSWER_PRIORITY,
      NOW,
      NOW,
      NOW,
      NOW,
    );
    env.db.prepare(`INSERT INTO direct_answer_requests (
      source_message_id, job_id, workspace_id, target_channel_id, question_created_at_ms,
      deadline_at_ms, response_intent_key, created_at_ms, started_at_ms, updated_at_ms
    ) VALUES ('pending-message','failed-direct',?,?,?,?,'pending-intent',?,?,?)`)
      .run(ids.guildId, ids.channelId, NOW, NOW + 120_000, NOW, NOW, NOW);

    const first = repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });
    expect(first.directAnswerJobs).toBe(1);
    const repaired = env.db.prepare(`SELECT id, status, priority, attempts, max_attempts
      FROM jobs WHERE type='direct_answer' AND status='queued'`).get() as {
        id: string; status: string; priority: number; attempts: number; max_attempts: number;
      };
    expect(repaired).toMatchObject({
      status: 'queued',
      priority: DIRECT_ANSWER_PRIORITY,
      attempts: 0,
      max_attempts: 2,
    });
    expect(getDirectAnswerRequest(env.db, 'pending-message')?.jobId).toBe(repaired.id);

    const second = repairDurableWork(env.db, { now: NOW + 2, quietSeconds: 90 });
    expect(second.directAnswerJobs).toBe(0);
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM jobs
      WHERE type='direct_answer' AND status='queued'`).get()).toEqual({ n: 1 });
  });

  it('resets a stranded deep-recap chunk and restores one active owner idempotently', () => {
    env.db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
       budget_usd,status,planned_chunks,created_at_ms,updated_at_ms)
      VALUES ('recap-repair',?,?,?, ?,?,5,'running',1,?,?)`)
      .run(ids.guildId, ids.channelId, ids.userId, NOW - 1_000, NOW, NOW, NOW);
    env.db.prepare(`INSERT INTO deep_recap_chunks
      (request_id,ordinal,after_at_ms,before_at_ms,status,created_at_ms,updated_at_ms)
      VALUES ('recap-repair',0,?,?,'running',?,?)`)
      .run(NOW - 1_000, NOW, NOW, NOW);

    const first = repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });
    expect(first.deepRecapJobs).toBe(1);
    expect(env.db.prepare("SELECT status FROM deep_recap_chunks WHERE request_id='recap-repair'").get())
      .toEqual({ status: 'pending' });
    expect(repairDurableWork(env.db, { now: NOW + 2, quietSeconds: 90 }).deepRecapJobs).toBe(0);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='deep_recap' AND status='queued'").get())
      .toEqual({ n: 1 });
  });

  it('repairs a synthesizing recap with completed chunks after its prior job failed', () => {
    const recapId = 'recap-synthesis-repair';
    const dayMs = 86_400_000;
    const afterAtMs = NOW - 7 * dayMs;
    env.db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
       budget_usd,spent_usd,status,total_matching_messages,included_messages,
       planned_chunks,completed_chunks,coverage_complete,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,1,0.1981875,'synthesizing',646,540,7,7,0,?,?)`)
      .run(recapId, ids.guildId, ids.channelId, ids.userId, afterAtMs, NOW, NOW, NOW);
    const insertChunk = env.db.prepare(`INSERT INTO deep_recap_chunks
      (request_id,ordinal,after_at_ms,before_at_ms,status,matching_messages,
       included_messages,coverage_complete,summary,cost_usd,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?, 'completed',?,?,?,?,?,?,?)`);
    for (let ordinal = 0; ordinal < 7; ordinal += 1) {
      const chunkAfter = afterAtMs + ordinal * dayMs;
      insertChunk.run(
        recapId,
        ordinal,
        chunkAfter,
        chunkAfter + dayMs,
        ordinal === 6 ? 100 : 91,
        ordinal === 6 ? 60 : 80,
        0,
        `completed summary ${ordinal}`,
        ordinal === 6 ? 0.0301875 : 0.028,
        NOW,
        NOW,
      );
    }
    env.db.prepare(`INSERT INTO jobs
      (id,type,unique_key,payload_json,status,priority,run_after_ms,attempts,max_attempts,
       last_error,created_at_ms,updated_at_ms,completed_at_ms)
      VALUES ('failed-synthesis','deep_recap',?,?,'failed',30,?,2,3,
              'DEEP_RECAP_REPORT_TOO_LONG',?,?,?)`)
      .run(`deep-recap:${recapId}`, JSON.stringify({ recapId }), NOW, NOW, NOW, NOW);

    const first = repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });
    expect(first.deepRecapJobs).toBe(1);
    expect(env.db.prepare(`SELECT status,planned_chunks,completed_chunks,outbox_id
      FROM deep_recap_requests WHERE id=?`).get(recapId)).toEqual({
      status: 'synthesizing', planned_chunks: 7, completed_chunks: 7, outbox_id: null,
    });
    expect(env.db.prepare(`SELECT status,COUNT(*) AS n FROM deep_recap_chunks
      WHERE request_id=? GROUP BY status`).get(recapId)).toEqual({ status: 'completed', n: 7 });
    const repaired = env.db.prepare(`SELECT id,status,attempts,max_attempts,unique_key,payload_json
      FROM jobs WHERE type='deep_recap' AND status IN ('queued','running')`).get() as {
        id: string; status: string; attempts: number; max_attempts: number;
        unique_key: string; payload_json: string;
      };
    expect(repaired).toMatchObject({
      status: 'queued', attempts: 0, max_attempts: 3, unique_key: `deep-recap:${recapId}`,
    });
    expect(JSON.parse(repaired.payload_json)).toEqual({ recapId });

    const second = repairDurableWork(env.db, { now: NOW + 2, quietSeconds: 90 });
    expect(second.deepRecapJobs).toBe(0);
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM jobs
      WHERE type='deep_recap' AND status IN ('queued','running')`).get()).toEqual({ n: 1 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='deep_recap'").get())
      .toEqual({ n: 2 });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
  });

  it.each(['queued', 'running'] as const)(
    'leaves a %s deep-recap owner and its running chunk untouched during periodic repair',
    (jobStatus) => {
      const recapId = `recap-active-${jobStatus}`;
      env.db.prepare(`INSERT INTO deep_recap_requests
        (id,workspace_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
         budget_usd,status,planned_chunks,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,5,'running',1,?,?)`)
        .run(recapId, ids.guildId, ids.channelId, ids.userId, NOW - 1_000, NOW, NOW, NOW);
      env.db.prepare(`INSERT INTO deep_recap_chunks
        (request_id,ordinal,after_at_ms,before_at_ms,status,created_at_ms,updated_at_ms)
        VALUES (?,0,?,?,'running',?,?)`)
        .run(recapId, NOW - 1_000, NOW, NOW, NOW);
      // Continuation jobs can have no unique key, so repair must match ownership
      // using the durable payload rather than `jobs_active_unique_idx`.
      env.db.prepare(`INSERT INTO jobs
        (id,type,unique_key,payload_json,status,priority,run_after_ms,attempts,max_attempts,
         lease_owner,lease_until_ms,created_at_ms,updated_at_ms)
        VALUES (?,'deep_recap',NULL,?,?,30,?,1,3,?,?,?,?)`)
        .run(
          `active-${jobStatus}`,
          JSON.stringify({ recapId }),
          jobStatus,
          NOW,
          jobStatus === 'running' ? 'live-worker' : null,
          jobStatus === 'running' ? NOW + 60_000 : null,
          NOW,
          NOW,
        );

      expect(repairDeepRecapOwnership(env.db, { now: NOW + 1 })).toEqual({
        jobsEnqueued: 0,
        chunksReset: 0,
        duplicateJobsCancelled: 0,
        runningJobsRecovered: 0,
      });
      expect(env.db.prepare('SELECT status,updated_at_ms FROM deep_recap_chunks WHERE request_id=?')
        .get(recapId)).toEqual({ status: 'running', updated_at_ms: NOW });
      expect(env.db.prepare(`SELECT COUNT(*) AS n FROM jobs
        WHERE type='deep_recap' AND status IN ('queued','running')`).get()).toEqual({ n: 1 });
      expect(env.db.prepare(`SELECT unique_key FROM jobs
        WHERE type='deep_recap' AND status IN ('queued','running')`).get())
        .toEqual({ unique_key: `deep-recap:${recapId}` });
    },
  );

  it('collapses duplicate deep-recap owners to one without resetting its running chunk', () => {
    const recapId = 'recap-duplicate-owners';
    env.db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
       budget_usd,status,planned_chunks,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,5,'running',1,?,?)`)
      .run(recapId, ids.guildId, ids.channelId, ids.userId, NOW - 1_000, NOW, NOW, NOW);
    env.db.prepare(`INSERT INTO deep_recap_chunks
      (request_id,ordinal,after_at_ms,before_at_ms,status,created_at_ms,updated_at_ms)
      VALUES (?,0,?,?,'running',?,?)`)
      .run(recapId, NOW - 1_000, NOW, NOW, NOW);
    const insertOwner = env.db.prepare(`INSERT INTO jobs
      (id,type,unique_key,payload_json,status,priority,run_after_ms,attempts,max_attempts,
       lease_owner,lease_until_ms,created_at_ms,updated_at_ms)
      VALUES (?,'deep_recap',?,?,?,30,?,1,3,?,?,?,?)`);
    insertOwner.run(
      'duplicate-running',
      `deep-recap:${recapId}`,
      JSON.stringify({ recapId }),
      'running',
      NOW,
      'live-worker',
      NOW + 60_000,
      NOW,
      NOW + 1,
    );
    insertOwner.run(
      'duplicate-queued',
      null,
      JSON.stringify({ recapId }),
      'queued',
      NOW,
      null,
      null,
      NOW,
      NOW,
    );

    expect(repairDeepRecapOwnership(env.db, { now: NOW + 2 })).toEqual({
      jobsEnqueued: 0,
      chunksReset: 0,
      duplicateJobsCancelled: 1,
      runningJobsRecovered: 0,
    });
    expect(env.db.prepare(`SELECT id,status FROM jobs
      WHERE type='deep_recap' ORDER BY id`).all()).toEqual([
      { id: 'duplicate-queued', status: 'cancelled' },
      { id: 'duplicate-running', status: 'running' },
    ]);
    expect(env.db.prepare('SELECT status,updated_at_ms FROM deep_recap_chunks WHERE request_id=?')
      .get(recapId)).toEqual({ status: 'running', updated_at_ms: NOW });
    expect(repairDeepRecapOwnership(env.db, { now: NOW + 3 })).toEqual({
      jobsEnqueued: 0,
      chunksReset: 0,
      duplicateJobsCancelled: 0,
      runningJobsRecovered: 0,
    });
  });

  it('periodically recovers a NULL-lease running owner and resets only its stranded chunk', () => {
    const recapId = 'recap-null-lease-owner';
    env.db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
       budget_usd,status,planned_chunks,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,5,'running',1,?,?)`)
      .run(recapId, ids.guildId, ids.channelId, ids.userId, NOW - 1_000, NOW, NOW, NOW);
    env.db.prepare(`INSERT INTO deep_recap_chunks
      (request_id,ordinal,after_at_ms,before_at_ms,status,created_at_ms,updated_at_ms)
      VALUES (?,0,?,?,'running',?,?)`)
      .run(recapId, NOW - 1_000, NOW, NOW, NOW);
    env.db.prepare(`INSERT INTO jobs
      (id,type,unique_key,payload_json,status,priority,run_after_ms,attempts,max_attempts,
       lease_owner,lease_until_ms,created_at_ms,updated_at_ms)
      VALUES ('null-lease-owner','deep_recap',NULL,?,'running',30,?,1,3,
              NULL,NULL,?,?)`)
      .run(JSON.stringify({ recapId }), NOW, NOW, NOW);

    expect(repairDeepRecapOwnership(env.db, { now: NOW + 1 })).toEqual({
      jobsEnqueued: 0,
      chunksReset: 1,
      duplicateJobsCancelled: 0,
      runningJobsRecovered: 1,
    });
    expect(env.db.prepare(`SELECT status,attempts,unique_key,lease_owner,lease_until_ms
      FROM jobs WHERE id='null-lease-owner'`).get()).toEqual({
      status: 'queued',
      attempts: 1,
      unique_key: `deep-recap:${recapId}`,
      lease_owner: null,
      lease_until_ms: null,
    });
    expect(env.db.prepare('SELECT status FROM deep_recap_chunks WHERE request_id=?')
      .get(recapId)).toEqual({ status: 'pending' });
  });

  it('startup requeues the prior process owner after a chunk-commit crash without duplicating work', () => {
    const recapId = 'recap-crash-after-chunk';
    env.db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
       budget_usd,status,planned_chunks,completed_chunks,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,5,'running',1,1,?,?)`)
      .run(recapId, ids.guildId, ids.channelId, ids.userId, NOW - 1_000, NOW, NOW, NOW);
    env.db.prepare(`INSERT INTO deep_recap_chunks
      (request_id,ordinal,after_at_ms,before_at_ms,status,summary,created_at_ms,updated_at_ms)
      VALUES (?,0,?,?,'completed','durable summary',?,?)`)
      .run(recapId, NOW - 1_000, NOW, NOW, NOW);
    env.db.prepare(`INSERT INTO jobs
      (id,type,unique_key,payload_json,status,priority,run_after_ms,attempts,max_attempts,
       lease_owner,lease_until_ms,created_at_ms,updated_at_ms)
      VALUES ('prior-process-owner','deep_recap',NULL,?,'running',30,?,3,3,
              'dead-process',?, ?,?)`)
      .run(JSON.stringify({ recapId }), NOW, NOW + 60_000, NOW, NOW);

    const report = repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });
    expect(report).toMatchObject({
      deepRecapJobs: 0,
      deepRecapRunningJobsRecovered: 1,
      deepRecapDuplicateJobsCancelled: 0,
      deepRecapChunksReset: 0,
    });
    expect(env.db.prepare(`SELECT id,status,attempts,unique_key FROM jobs
      WHERE type='deep_recap'`).all()).toEqual([{
      id: 'prior-process-owner',
      status: 'queued',
      attempts: 0,
      unique_key: `deep-recap:${recapId}`,
    }]);
    expect(env.db.prepare(`SELECT status,summary FROM deep_recap_chunks
      WHERE request_id=?`).get(recapId)).toEqual({
      status: 'completed',
      summary: 'durable summary',
    });

    const nextPhase = claimNextJob(env.db, {
      owner: 'replacement-process',
      now: NOW + 2,
      leaseMs: 60_000,
      type: 'deep_recap',
    });
    expect(nextPhase).toMatchObject({ id: 'prior-process-owner', attempts: 1 });
    expect(failJob(env.db, {
      id: nextPhase!.id,
      error: new Error('first transient failure in the next phase'),
      now: NOW + 3,
      jitterMs: 0,
    })).toBe('requeued');
    expect(env.db.prepare(`SELECT status,attempts FROM jobs
      WHERE id='prior-process-owner'`).get()).toEqual({ status: 'queued', attempts: 1 });
    expect(env.db.prepare(`SELECT status FROM deep_recap_requests WHERE id=?`)
      .get(recapId)).toEqual({ status: 'running' });
  });

  it('fails closed instead of cancelling one of multiple plausibly running owners', () => {
    const recapId = 'recap-multiple-running';
    env.db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
       budget_usd,status,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,5,'synthesizing',?,?)`)
      .run(recapId, ids.guildId, ids.channelId, ids.userId, NOW - 1_000, NOW, NOW, NOW);
    const insertOwner = env.db.prepare(`INSERT INTO jobs
      (id,type,unique_key,payload_json,status,priority,run_after_ms,attempts,max_attempts,
       lease_owner,lease_until_ms,created_at_ms,updated_at_ms)
      VALUES (?,'deep_recap',NULL,?,'running',30,?,1,3,?,?,?,?)`);
    insertOwner.run('running-owner-a', JSON.stringify({ recapId }), NOW,
      'worker-a', NOW + 60_000, NOW, NOW);
    insertOwner.run('running-owner-b', JSON.stringify({ recapId }), NOW,
      'worker-b', NOW + 60_000, NOW, NOW + 1);

    expect(() => repairDeepRecapOwnership(env.db, { now: NOW + 2 }))
      .toThrow('multiple running deep recap owners');
    expect(env.db.prepare(`SELECT id,status FROM jobs WHERE type='deep_recap'
      ORDER BY id`).all()).toEqual([
      { id: 'running-owner-a', status: 'running' },
      { id: 'running-owner-b', status: 'running' },
    ]);
  });

  it('does not repair reviews or backfills for a thread below a Mneme test parent', () => {
    const parentId = '100000000000000020';
    const threadId = '100000000000000021';
    const channel = (id: string, name: string, parentIdValue: string | null, isThread: boolean) => ({
      id,
      guildId: ids.guildId,
      parentId: parentIdValue,
      kind: isThread ? 'thread' as const : 'text' as const,
      name,
      topic: null,
      position: null,
      isThread,
      isArchived: false,
      isLocked: false,
      ingestEnabled: true,
      visibilityClass: 'org' as const,
      allowInterventions: false,
      permissionFingerprint: null,
      lastMessageId: null,
      discoveredAtMs: NOW,
      updatedAtMs: NOW,
      rawJson: null,
    });
    upsertChannel(env.db, channel(parentId, 'mneme-repair-tests', null, false));
    upsertChannel(env.db, channel(threadId, 'release-planning', parentId, true));
    env.db.prepare(`INSERT INTO episodes
      (id,workspace_id,conversation_channel_id,status,started_at_ms,last_activity_at_ms,created_at_ms,updated_at_ms)
      VALUES ('test-reviewing',?,?,'reviewing',?,?,?,?),
             ('test-queued',?,?,'queued',?,?,?,?),
             ('test-open',?,?,'open',?,?,?,?)`)
      .run(
        ids.guildId, threadId, NOW, NOW, NOW, NOW,
        ids.guildId, threadId, NOW, NOW, NOW, NOW,
        ids.guildId, threadId, NOW, NOW, NOW, NOW,
      );
    env.db.prepare(`INSERT INTO sync_cursors
      (channel_id,state,history_complete,retry_count,updated_at_ms)
      VALUES (?,'backfilling',0,0,?)`).run(threadId, NOW);

    const report = repairDurableWork(env.db, { now: NOW + 1, quietSeconds: 90 });

    expect(report.reviewsReset).toBe(0);
    expect(report.reviewJobs).toBe(0);
    expect(report.closeJobs).toBe(0);
    expect(report.backfillJobs).toBe(0);
    expect(env.db.prepare(`SELECT id,status FROM episodes
      WHERE id IN ('test-reviewing','test-queued','test-open') ORDER BY id`).all()).toEqual([
      { id: 'test-open', status: 'skipped' },
      { id: 'test-queued', status: 'skipped' },
      { id: 'test-reviewing', status: 'skipped' },
    ]);
    expect(env.db.prepare(`SELECT COUNT(*) AS n FROM jobs
      WHERE type IN ('review_episode','backfill_channel')`).get()).toEqual({ n: 0 });
  });
});
