import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import * as attentionRepository from '../../src/memory/attention-repository.js';
import { resolveScheduledMemoryRoute } from '../../src/memory/scheduled-routing.js';
import { createReviewDueMemoryDispatcherHandler } from '../../src/jobs/handlers/review-due-memory-dispatcher.js';

const NOW = 1_700_000_000_000;
const GUILD = '100000000000000001';
const USER = '100000000000000003';
const REVIEW = '100000000000000009';
const WORKING = '100000000000000010';
let env: TestDb;

function channel(id: string, name: string, visibility = 'org', allow = 1, parent: string | null = null) {
  env.db.prepare(`INSERT INTO channels
    (id,workspace_id,parent_id,type,name,is_thread,is_archived,is_locked,ingest_enabled,
     visibility_class,allow_interventions,discovered_at_ms,updated_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, GUILD, parent, parent ? 11 : 0, name, parent ? 1 : 0, 0, 0, 1,
      visibility, allow, NOW, NOW,
    );
}

function message(id: string, channelId: string) {
  env.db.prepare(`INSERT INTO messages
    (id,workspace_id,channel_id,author_id,author_display_name,content,created_at_ms,
     ingested_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, GUILD, channelId, USER, 'User', `evidence ${id}`, NOW, NOW, NOW);
}

function memory(id: string, scopeType: 'org' | 'channel', scopeKey: string | null, originIds: string[], parent?: string) {
  env.db.prepare(`INSERT INTO memories
    (id,workspace_id,scope_type,scope_key,type,statement,status,confidence,importance,
     review_after_ms,first_seen_at_ms,last_confirmed_at_ms,supersedes_memory_id,
     created_at_ms,updated_at_ms)
    VALUES (?,?,?,?,?,'A durable statement','active',.9,.9,?,?,?,?,?,?)`).run(
      id, GUILD, scopeType, scopeKey, 'decision', NOW - 1, NOW, NOW, parent ?? null, NOW, NOW,
    );
  for (const origin of originIds) {
    env.db.prepare(`INSERT INTO memory_evidence
      (memory_id,message_id,stance,weight,created_at_ms) VALUES (?,?,'origin',1,?)`)
      .run(id, origin, NOW);
  }
}

const options = {
  guildId: GUILD,
  reviewChannelId: REVIEW,
  reviewAcceptedScopes: ['org', 'restricted', 'review_only'] as const,
};

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
  channel(REVIEW, 'mneme-review', 'review_only', 0);
  channel(WORKING, 'growth', 'org', 1);
});
afterEach(() => env.cleanup());

describe('scheduled memory routing', () => {
  it('routes one current org origin to its exact working channel', () => {
    message('m-origin', WORKING);
    memory('memory-1', 'org', null, ['m-origin']);
    expect(resolveScheduledMemoryRoute(env.db, 'memory-1', options)).toEqual({
      kind: 'working', targetChannelId: WORKING, scopeChannelId: WORKING, visibility: 'org',
    });
  });

  it('keeps ambiguous origins in secure maintenance without choosing a fallback', () => {
    channel('100000000000000011', 'product', 'org', 1);
    message('m-a', WORKING);
    message('m-b', '100000000000000011');
    memory('memory-2', 'org', null, ['m-a', 'm-b']);
    expect(resolveScheduledMemoryRoute(env.db, 'memory-2', options)).toEqual({
      kind: 'secure_maintenance', targetChannelId: REVIEW, reason: 'multiple_origins',
    });
  });

  it('inherits the nearest origin through supersede lineage', () => {
    message('m-parent', WORKING);
    message('m-child-update', WORKING);
    memory('memory-parent', 'org', null, ['m-parent']);
    memory('memory-child', 'org', null, [], 'memory-parent');
    env.db.prepare(`INSERT INTO memory_evidence
      (memory_id,message_id,stance,weight,created_at_ms)
      VALUES ('memory-child','m-child-update','updates',1,?)`).run(NOW);
    expect(resolveScheduledMemoryRoute(env.db, 'memory-child', options)).toMatchObject({
      kind: 'working', targetChannelId: WORKING,
    });
  });

  it('does not route to an intervention-disabled or Mneme control target', () => {
    message('m-disabled', WORKING);
    memory('memory-disabled', 'org', null, ['m-disabled']);
    env.db.prepare('UPDATE channels SET allow_interventions=0 WHERE id=?').run(WORKING);
    expect(resolveScheduledMemoryRoute(env.db, 'memory-disabled', options)).toMatchObject({
      kind: 'secure_maintenance', reason: 'interventions_disabled',
    });
    env.db.prepare("UPDATE channels SET allow_interventions=1,name='mneme-sandbox' WHERE id=?").run(WORKING);
    expect(resolveScheduledMemoryRoute(env.db, 'memory-disabled', options)).toMatchObject({
      kind: 'secure_maintenance', reason: 'control_surface',
    });
  });

  it('suppresses when the review audience cannot receive the memory scope', () => {
    message('m-private', WORKING);
    env.db.prepare("UPDATE channels SET visibility_class='restricted' WHERE id=?").run(WORKING);
    memory('memory-private', 'channel', WORKING, ['m-private']);
    expect(resolveScheduledMemoryRoute(env.db, 'memory-private', {
      ...options, reviewAcceptedScopes: ['org'],
    })).toEqual({ kind: 'suppress', targetChannelId: null, reason: 'review_audience_mismatch' });
  });

  it('dispatches a bounded target cohort with durable subject ownership', () => {
    message('m-dispatch', WORKING);
    memory('memory-dispatch', 'org', null, ['m-dispatch']);
    // With no revision yet, the uncovered in-window evidence queues a scoped
    // registration cohort that can never post (Section 12.7).
    const first = createReviewDueMemoryDispatcherHandler({ db: env.db, ...options, now: () => NOW }).dispatch();
    expect(first).toEqual({
      considered: 0, enqueued: 0, suppressed: 0,
      registrationCandidates: 1, registrationEnqueued: 1,
    });
    let job = env.db.prepare("SELECT payload_json FROM jobs WHERE type='review_due_memory_cohort'").get() as
      | { payload_json: string }
      | undefined;
    expect(JSON.parse(job!.payload_json)).toMatchObject({
      routeKind: 'working', targetChannelId: WORKING, mode: 'attention_registration',
      subjects: [{ memoryId: 'memory-dispatch' }],
    });
    expect(env.db.prepare('SELECT memory_id FROM scheduled_review_cohort_subject_leases').get())
      .toEqual({ memory_id: 'memory-dispatch' });

    // An eligible revision dispatches an attention_review cohort that pins it.
    const { ensureSubjectForMember, registerRevision, validateTriggerEvidence } = attentionRepository;
    const subjectId = ensureSubjectForMember(env.db, { guildId: GUILD, memoryId: 'memory-dispatch', now: NOW });
    const records = validateTriggerEvidence(env.db, {
      guildId: GUILD, mnemeId: 'mneme-app',
      evidence: [{ messageId: 'm-dispatch', quote: 'evidence m-dispatch' }],
      now: NOW, windowMs: 7 * 86_400_000,
    });
    if (!records.ok) throw new Error('expected valid trigger evidence');
    const { revisionId } = registerRevision(env.db, { subjectId, triggers: records.records, now: NOW });

    env.db.prepare('DELETE FROM jobs').run();
    env.db.prepare('DELETE FROM scheduled_review_cohort_subject_leases').run();
    const second = createReviewDueMemoryDispatcherHandler({ db: env.db, ...options, now: () => NOW + 1 }).dispatch();
    expect(second).toMatchObject({ considered: 1, enqueued: 1, suppressed: 0 });
    job = env.db.prepare("SELECT payload_json FROM jobs WHERE type='review_due_memory_cohort'").get() as
      | { payload_json: string }
      | undefined;
    expect(JSON.parse(job!.payload_json)).toMatchObject({
      routeKind: 'working', targetChannelId: WORKING, mode: 'attention_review',
      subjects: [{ memoryId: 'memory-dispatch', attentionRevisionId: revisionId }],
    });
    expect(env.db.prepare('SELECT memory_id FROM scheduled_review_cohort_subject_leases').get())
      .toEqual({ memory_id: 'memory-dispatch' });
  });
});
