import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  formatDeepRecapReply,
  handleDeepRecapCommand,
  type DeepRecapCommandInput,
} from '../../src/commands/deep-recap.js';
import {
  getDeepRecap,
  recordDeepRecapSynthesisCostOnce,
  reserveDeepRecapModelCall,
  settleDeepRecapModelCallCost,
} from '../../src/deep-recap/repository.js';

const NOW = 1_700_000_000_000;

describe('bounded deep recap admin command', () => {
  let env: TestDb;
  let ids: ReturnType<typeof seedIdentity>;
  beforeEach(() => { env = createTestDb(); ids = seedIdentity(env.db); });
  afterEach(() => env.cleanup());

  const input = (overrides: Partial<DeepRecapCommandInput> = {}): DeepRecapCommandInput => ({
    subcommand: 'start',
    actorUserId: ids.userId,
    guildId: ids.guildId,
    memberRoleIds: ['admin'],
    invocationChannelId: ids.channelId,
    ...overrides,
  });
  const deps = () => ({
    db: env.db,
    adminRoleIds: ['admin'],
    nowMs: NOW,
    maxWindowDays: 30,
    maxBudgetUsd: 20,
    enabled: true,
    isTargetAllowed: (id: string) => id === ids.channelId,
    isSourceAllowed: (id: string) => id === ids.channelId,
  });
  const recordChunkCost = (requestId: string, costUsd: number, atMs: number): void => {
    const runId = `test-chunk:${requestId}`;
    expect(reserveDeepRecapModelCall(env.db, {
      requestId,
      runId,
      phase: 'chunk',
      chunkOrdinal: 0,
      startedAtMs: atMs,
      now: atMs,
    })).toBe(true);
    expect(settleDeepRecapModelCallCost(env.db, { runId, costUsd, now: atMs })).toBe(true);
  };

  it('creates one durable request and one idempotent background job', () => {
    const result = handleDeepRecapCommand(input({ days: 14, budgetUsd: 5, topic: 'infrastructure' }), deps());
    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.request).toMatchObject({
      status: 'queued',
      topic: 'infrastructure',
      budget_usd: 5,
      after_at_ms: NOW - 14 * 86_400_000,
      before_at_ms: NOW,
    });
    expect(env.db.prepare("SELECT type,status,unique_key FROM jobs WHERE type='deep_recap'").get())
      .toEqual({ type: 'deep_recap', status: 'queued', unique_key: `deep-recap:${result.request.id}` });
    expect(formatDeepRecapReply(result)).toContain('The final report will be posted in this channel');
  });

  it('enforces admin, scope, window, budget, singleton, status, and cancellation bounds', () => {
    expect(handleDeepRecapCommand(input({ memberRoleIds: [] }), deps()).kind).toBe('not_authorized');
    expect(handleDeepRecapCommand(input({ days: 31 }), deps())).toMatchObject({ kind: 'invalid' });
    expect(handleDeepRecapCommand(input({ budgetUsd: 21 }), deps())).toMatchObject({ kind: 'invalid' });
    expect(handleDeepRecapCommand(input({ channelId: 'hidden' }), deps())).toMatchObject({ kind: 'invalid' });

    const started = handleDeepRecapCommand(input(), deps());
    expect(started.kind).toBe('started');
    expect(handleDeepRecapCommand(input(), deps())).toMatchObject({ kind: 'invalid' });
    const listed = handleDeepRecapCommand(input({ subcommand: 'status' }), deps());
    expect(listed.kind).toBe('listed');
    if (started.kind !== 'started') return;
    const cancelled = handleDeepRecapCommand(input({
      subcommand: 'cancel', recapId: started.request.id.slice(0, 8),
    }), deps());
    expect(cancelled).toMatchObject({ kind: 'cancelled', request: { status: 'cancelled' } });
    expect(env.db.prepare("SELECT status FROM jobs WHERE type='deep_recap'").get()).toEqual({ status: 'cancelled' });
  });

  it('reports durable worker ownership instead of repeating a stale request phase', () => {
    const started = handleDeepRecapCommand(input(), deps());
    if (started.kind !== 'started') throw new Error('expected started');
    env.db.prepare(`UPDATE deep_recap_requests
      SET status='synthesizing',planned_chunks=7,completed_chunks=7,
          total_matching_messages=646,included_messages=540,spent_usd=.2,updated_at_ms=?
      WHERE id=?`).run(NOW - 2 * 60 * 60_000, started.request.id);
    env.db.prepare(`UPDATE jobs SET status='failed',last_error='raw provider detail',
      completed_at_ms=?,updated_at_ms=? WHERE type='deep_recap'`).run(NOW - 60_000, NOW - 60_000);

    let listed = handleDeepRecapCommand(input({ subcommand: 'status' }), deps());
    if (listed.kind !== 'listed') throw new Error('expected listed');
    let text = formatDeepRecapReply(listed);
    expect(text).toContain(`${started.request.id.slice(0, 8)} · recovery needed`);
    expect(text).not.toContain('raw provider detail');

    const retryAt = NOW + 60_000;
    env.db.prepare(`INSERT INTO jobs
      (id,type,unique_key,payload_json,status,priority,run_after_ms,attempts,max_attempts,created_at_ms,updated_at_ms)
      VALUES ('recap-retry-job','deep_recap',?,?,'queued',30,?,1,3,?,?)`)
      .run(`deep-recap:${started.request.id}`, JSON.stringify({ recapId: started.request.id }), retryAt, NOW, NOW);
    listed = handleDeepRecapCommand(input({ subcommand: 'status' }), deps());
    if (listed.kind !== 'listed') throw new Error('expected listed');
    text = formatDeepRecapReply(listed);
    expect(text).toContain(`retrying <t:${Math.floor(retryAt / 1_000)}:R>`);

    env.db.prepare("UPDATE jobs SET status='running',updated_at_ms=? WHERE id='recap-retry-job'").run(NOW + 1);
    listed = handleDeepRecapCommand(input({ subcommand: 'status' }), deps());
    if (listed.kind !== 'listed') throw new Error('expected listed');
    expect(formatDeepRecapReply(listed)).toContain(`${started.request.id.slice(0, 8)} · synthesizing`);
  });

  it('creates a new synthesis-only request without double-counting copied chunk cost', () => {
    const started = handleDeepRecapCommand(input({ budgetUsd: 5, topic: 'infrastructure' }), deps());
    if (started.kind !== 'started') throw new Error('expected started');
    env.db.prepare(`UPDATE jobs SET status='failed',completed_at_ms=?,updated_at_ms=?
      WHERE type='deep_recap'`).run(NOW - 1, NOW - 1);
    env.db.prepare(`INSERT INTO outbox
      (id,channel_id,content,dedupe_key,status,next_attempt_at_ms,created_at_ms,updated_at_ms)
      VALUES ('old-failure-notice',?,'fixed failure notice','old-recap-intent','sent',?,?,?)`)
      .run(ids.channelId, NOW - 1, NOW - 1, NOW - 1);
    env.db.prepare(`INSERT INTO deep_recap_chunks
      (request_id,ordinal,after_at_ms,before_at_ms,status,matching_messages,
       included_messages,coverage_complete,summary,cited_message_ids_json,
       source_message_ids_json,source_fingerprints_json,cost_usd,created_at_ms,updated_at_ms)
      VALUES (?,0,?,?,'completed',10,8,0,'stored bounded summary','["source-1"]',
              '["source-1"]','[{"messageId":"source-1","fingerprint":"abc"}]',0,?,?)`)
      .run(started.request.id, started.request.after_at_ms, started.request.before_at_ms, NOW - 2, NOW - 2);
    recordChunkCost(started.request.id, 0.25, NOW - 2);
    env.db.prepare(`UPDATE deep_recap_requests
      SET status='failed',spent_usd=.25,planned_chunks=1,completed_chunks=1,
          total_matching_messages=10,included_messages=8,coverage_complete=0,
          outbox_id='old-failure-notice',last_error_category='DEEP_RECAP_REPORT_TOO_LONG',
          completed_at_ms=?,updated_at_ms=? WHERE id=?`)
      .run(NOW - 1, NOW - 1, started.request.id);

    const result = handleDeepRecapCommand(input({
      subcommand: 'retry', recapId: started.request.id.slice(0, 8),
    }), deps());
    expect(result.kind).toBe('retried');
    if (result.kind !== 'retried') return;
    expect(result.request.id).not.toBe(started.request.id);
    expect(result.request).toMatchObject({
      status: 'synthesizing',
      topic: 'infrastructure',
      spent_usd: 0.25,
      synthesis_cost_usd: 0,
      planned_chunks: 1,
      completed_chunks: 1,
      outbox_id: null,
      completed_at_ms: null,
    });
    expect(env.db.prepare(`SELECT status,summary,cost_usd,cited_message_ids_json,
      source_fingerprints_json FROM deep_recap_chunks WHERE request_id=?`).get(result.request.id))
      .toEqual({
        status: 'completed',
        summary: 'stored bounded summary',
        cost_usd: 0,
        cited_message_ids_json: '["source-1"]',
        source_fingerprints_json: '[{"messageId":"source-1","fingerprint":"abc"}]',
      });
    expect(env.db.prepare(`SELECT status,unique_key,payload_json FROM jobs
      WHERE type='deep_recap' AND status='queued'`).get()).toEqual({
      status: 'queued',
      unique_key: `deep-recap:${result.request.id}`,
      payload_json: JSON.stringify({ recapId: result.request.id }),
    });
    expect(formatDeepRecapReply(result)).toContain('message history will not be analyzed again');
    expect(getDeepRecap(env.db, started.request.id)).toMatchObject({
      status: 'failed', outbox_id: 'old-failure-notice', spent_usd: 0.25,
    });
  });

  it('rejects synthesis-only retry when chunks, budget, or failure category are unsafe', () => {
    const started = handleDeepRecapCommand(input(), deps());
    if (started.kind !== 'started') throw new Error('expected started');
    env.db.prepare("UPDATE jobs SET status='failed',completed_at_ms=?,updated_at_ms=? WHERE type='deep_recap'")
      .run(NOW, NOW);
    env.db.prepare(`UPDATE deep_recap_requests
      SET status='failed',planned_chunks=2,completed_chunks=1,spent_usd=.25,
          last_error_category='processing_error',completed_at_ms=?,updated_at_ms=? WHERE id=?`)
      .run(NOW, NOW, started.request.id);

    let result = handleDeepRecapCommand(input({
      subcommand: 'retry', recapId: started.request.id,
    }), deps());
    expect(result).toMatchObject({ kind: 'invalid' });
    if (result.kind === 'invalid') expect(result.reason).toContain('every planned chunk');

    env.db.prepare(`UPDATE deep_recap_requests SET completed_chunks=planned_chunks
      WHERE id=?`).run(started.request.id);
    expect(recordDeepRecapSynthesisCostOnce(env.db, {
      id: started.request.id,
      expectedSynthesisCostUsd: 0,
      costUsd: started.request.budget_usd,
      now: NOW + 1,
    })).toBe(true);
    result = handleDeepRecapCommand(input({ subcommand: 'retry', recapId: started.request.id }), deps());
    if (result.kind === 'invalid') expect(result.reason).toContain('no request budget');
    else throw new Error('expected invalid');

    env.db.prepare(`UPDATE deep_recap_requests SET spent_usd=.25,
      last_error_category='DEEP_RECAP_SOURCE_CHANGED' WHERE id=?`).run(started.request.id);
    result = handleDeepRecapCommand(input({ subcommand: 'retry', recapId: started.request.id }), deps());
    if (result.kind === 'invalid') expect(result.reason).toContain('cannot be retried safely');
    else throw new Error('expected invalid');
  });

  it('keeps retries on one latest-leaf lineage with one immutable budget', () => {
    const started = handleDeepRecapCommand(input({ budgetUsd: 1 }), deps());
    if (started.kind !== 'started') throw new Error('expected started');
    env.db.prepare(`UPDATE jobs SET status='failed',completed_at_ms=?,updated_at_ms=?
      WHERE type='deep_recap'`).run(NOW - 10, NOW - 10);
    env.db.prepare(`INSERT INTO deep_recap_chunks
      (request_id,ordinal,after_at_ms,before_at_ms,status,matching_messages,
       included_messages,coverage_complete,summary,cost_usd,created_at_ms,updated_at_ms)
      VALUES (?,0,?,?,'completed',10,10,1,'root summary',0,?,?)`)
      .run(started.request.id, started.request.after_at_ms, started.request.before_at_ms, NOW - 10, NOW - 10);
    recordChunkCost(started.request.id, 0.25, NOW - 10);
    env.db.prepare(`UPDATE deep_recap_requests
      SET status='failed',spent_usd=.25,planned_chunks=1,completed_chunks=1,
          total_matching_messages=10,included_messages=10,
          last_error_category='processing_error',completed_at_ms=?,updated_at_ms=?
      WHERE id=?`).run(NOW - 10, NOW - 10, started.request.id);

    const first = handleDeepRecapCommand(input({
      subcommand: 'retry', recapId: started.request.id,
    }), deps());
    if (first.kind !== 'retried') throw new Error('expected first retry');
    expect(first.request).toMatchObject({
      retry_of_request_id: started.request.id,
      retry_root_request_id: started.request.id,
      spent_usd: 0.25,
      budget_usd: 1,
    });

    // The root stops being retryable as soon as its child exists, including while
    // that child still owns active synthesis work.
    let ancestorRetry = handleDeepRecapCommand(input({
      subcommand: 'retry', recapId: started.request.id,
    }), deps());
    expect(ancestorRetry).toMatchObject({ kind: 'invalid' });
    if (ancestorRetry.kind === 'invalid') {
      expect(ancestorRetry.reason).toContain('newer synthesis retry already exists');
    }
    expect(env.db.prepare('SELECT COUNT(*) AS count FROM deep_recap_requests').get())
      .toEqual({ count: 2 });

    expect(recordDeepRecapSynthesisCostOnce(env.db, {
      id: first.request.id, expectedSynthesisCostUsd: 0, costUsd: 0.30, now: NOW + 1,
    })).toBe(true);
    env.db.prepare(`UPDATE deep_recap_requests
      SET status='failed',last_error_category='processing_error',completed_at_ms=?,updated_at_ms=?
      WHERE id=?`).run(NOW + 2, NOW + 2, first.request.id);
    env.db.prepare(`UPDATE jobs SET status='failed',completed_at_ms=?,updated_at_ms=?
      WHERE type='deep_recap' AND json_extract(payload_json,'$.recapId')=?`)
      .run(NOW + 2, NOW + 2, first.request.id);

    // A failed child remains the only retryable leaf; its immutable ancestor cannot
    // branch even after the child has terminalized.
    ancestorRetry = handleDeepRecapCommand(input({
      subcommand: 'retry', recapId: started.request.id,
    }), deps());
    expect(ancestorRetry).toMatchObject({ kind: 'invalid' });
    if (ancestorRetry.kind === 'invalid') {
      expect(ancestorRetry.reason).toContain('newer synthesis retry already exists');
    }

    const second = handleDeepRecapCommand(input({
      subcommand: 'retry', recapId: first.request.id,
    }), deps());
    if (second.kind !== 'retried') throw new Error('expected second retry');
    expect(second.request.retry_of_request_id).toBe(first.request.id);
    expect(second.request.retry_root_request_id).toBe(started.request.id);
    expect(second.request.spent_usd).toBeCloseTo(0.55);
    expect(recordDeepRecapSynthesisCostOnce(env.db, {
      id: second.request.id, expectedSynthesisCostUsd: 0, costUsd: 0.50, now: NOW + 3,
    })).toBe(true);
    env.db.prepare(`UPDATE deep_recap_requests
      SET status='failed',last_error_category='processing_error',completed_at_ms=?,updated_at_ms=?
      WHERE id=?`).run(NOW + 4, NOW + 4, second.request.id);
    env.db.prepare(`UPDATE jobs SET status='failed',completed_at_ms=?,updated_at_ms=?
      WHERE type='deep_recap' AND json_extract(payload_json,'$.recapId')=?`)
      .run(NOW + 4, NOW + 4, second.request.id);

    const rootRetry = handleDeepRecapCommand(input({
      subcommand: 'retry', recapId: started.request.id,
    }), deps());
    expect(rootRetry).toMatchObject({ kind: 'invalid' });
    if (rootRetry.kind === 'invalid') {
      expect(rootRetry.reason).toContain('newer synthesis retry already exists');
    }
    const descendantRetry = handleDeepRecapCommand(input({
      subcommand: 'retry', recapId: first.request.id,
    }), deps());
    expect(descendantRetry).toMatchObject({ kind: 'invalid' });
    if (descendantRetry.kind === 'invalid') {
      expect(descendantRetry.reason).toContain('newer synthesis retry already exists');
    }
    const leafRetry = handleDeepRecapCommand(input({
      subcommand: 'retry', recapId: second.request.id,
    }), deps());
    expect(leafRetry).toMatchObject({ kind: 'invalid' });
    if (leafRetry.kind === 'invalid') {
      expect(leafRetry.reason).toContain('no request budget');
    }
  });

  it.each(['completed', 'partial'] as const)(
    'closes every failed ancestor after a %s lineage result',
    (resultStatus) => {
      const started = handleDeepRecapCommand(input({ budgetUsd: 5 }), deps());
      if (started.kind !== 'started') throw new Error('expected started');
      env.db.prepare(`UPDATE jobs SET status='failed',completed_at_ms=?,updated_at_ms=?
        WHERE type='deep_recap'`).run(NOW - 10, NOW - 10);
      env.db.prepare(`INSERT INTO deep_recap_chunks
        (request_id,ordinal,after_at_ms,before_at_ms,status,matching_messages,
         included_messages,coverage_complete,summary,cost_usd,created_at_ms,updated_at_ms)
        VALUES (?,0,?,?,'completed',10,10,1,'root summary',0,?,?)`)
        .run(started.request.id, started.request.after_at_ms, started.request.before_at_ms, NOW - 10, NOW - 10);
      recordChunkCost(started.request.id, 0.25, NOW - 10);
      env.db.prepare(`UPDATE deep_recap_requests
        SET status='failed',spent_usd=.25,planned_chunks=1,completed_chunks=1,
            total_matching_messages=10,included_messages=10,
            last_error_category='processing_error',completed_at_ms=?,updated_at_ms=?
        WHERE id=?`).run(NOW - 10, NOW - 10, started.request.id);

      const first = handleDeepRecapCommand(input({
        subcommand: 'retry', recapId: started.request.id,
      }), deps());
      if (first.kind !== 'retried') throw new Error('expected first retry');
      env.db.prepare(`UPDATE deep_recap_requests
        SET status='failed',last_error_category='processing_error',completed_at_ms=?,updated_at_ms=?
        WHERE id=?`).run(NOW + 1, NOW + 1, first.request.id);
      env.db.prepare(`UPDATE jobs SET status='failed',completed_at_ms=?,updated_at_ms=?
        WHERE type='deep_recap' AND json_extract(payload_json,'$.recapId')=?`)
        .run(NOW + 1, NOW + 1, first.request.id);

      const second = handleDeepRecapCommand(input({
        subcommand: 'retry', recapId: first.request.id,
      }), deps());
      if (second.kind !== 'retried') throw new Error('expected second retry');
      env.db.prepare(`UPDATE deep_recap_requests
        SET status=?,completed_at_ms=?,updated_at_ms=? WHERE id=?`)
        .run(resultStatus, NOW + 2, NOW + 2, second.request.id);
      env.db.prepare(`UPDATE jobs SET status='succeeded',completed_at_ms=?,updated_at_ms=?
        WHERE type='deep_recap' AND json_extract(payload_json,'$.recapId')=?`)
        .run(NOW + 2, NOW + 2, second.request.id);

      for (const ancestorId of [started.request.id, first.request.id]) {
        const retry = handleDeepRecapCommand(input({
          subcommand: 'retry', recapId: ancestorId,
        }), deps());
        expect(retry).toMatchObject({ kind: 'invalid' });
        if (retry.kind === 'invalid') {
          expect(retry.reason).toContain('already produced a completed or partial report');
        }
      }
      expect(env.db.prepare('SELECT COUNT(*) AS count FROM deep_recap_requests').get())
        .toEqual({ count: 3 });
    },
  );

  it('records completed synthesis call costs cumulatively and only once per CAS value', () => {
    const started = handleDeepRecapCommand(input({ budgetUsd: 5 }), deps());
    if (started.kind !== 'started') throw new Error('expected started');
    expect(recordDeepRecapSynthesisCostOnce(env.db, {
      id: started.request.id, expectedSynthesisCostUsd: 0, costUsd: 0.12, now: NOW + 1,
    })).toBe(true);
    expect(recordDeepRecapSynthesisCostOnce(env.db, {
      id: started.request.id, expectedSynthesisCostUsd: 0, costUsd: 0.12, now: NOW + 2,
    })).toBe(false);
    expect(recordDeepRecapSynthesisCostOnce(env.db, {
      id: started.request.id, expectedSynthesisCostUsd: 0.12, costUsd: 0.03, now: NOW + 3,
    })).toBe(true);
    const request = getDeepRecap(env.db, started.request.id)!;
    expect(request.synthesis_cost_usd).toBeCloseTo(0.15);
    expect(request.spent_usd).toBeCloseTo(0.15);
  });
});
