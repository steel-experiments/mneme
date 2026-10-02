import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { openDatabase } from '../../src/db/database.js';
import {
  applyMigrations,
  discoverMigrations,
  listAppliedMigrations,
  MigrationError,
} from '../../src/db/migrations.js';
import {
  createTestDb,
  copyMigrationsToTemp,
  writeMigration,
  makeTempDir,
} from '../helpers/db.js';
import { enqueue, claimNextJob } from '../../src/jobs/queue.js';
import { getDeadlineDecision } from '../../src/memory/deadline-decisions.js';

/** Seed guild, channel, and user rows in a schema older than migration 041. */
function seedLegacyIdentity(db: ReturnType<typeof openDatabase>): { guildId: string; channelId: string; userId: string } {
  const guildId = '100000000000000001';
  const channelId = '100000000000000002';
  const userId = '100000000000000003';
  db.prepare("INSERT INTO guilds (id,name,discovered_at_ms,updated_at_ms) VALUES (?,'Guild',1,1)").run(guildId);
  db.prepare(`INSERT INTO channels (id,guild_id,type,name,visibility_class,discovered_at_ms,updated_at_ms)
    VALUES (?,?,0,'general','restricted',1,1)`).run(channelId, guildId);
  db.prepare("INSERT INTO users (id,username,global_name,is_bot,first_seen_at_ms,last_seen_at_ms) VALUES (?,'alice','Alice',0,1,1)").run(userId);
  return { guildId, channelId, userId };
}

describe('migrations runner', () => {
  it('applies all migrations on first run', () => {
    const t = createTestDb();
    const applied = listAppliedMigrations(t.db);
    expect(applied.map((m) => m.version)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    t.cleanup();
  });

  it('is idempotent on repeated runs (applies nothing new)', () => {
    const t = createTestDb();
    const result = applyMigrations(t.db, copyMigrationsToTemp());
    expect(result.applied).toHaveLength(0);
    expect(listAppliedMigrations(t.db).map((m) => m.version)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    t.cleanup();
  });

  it('upgrades an existing version 5 database through all new migrations', () => {
    const oldDir = copyMigrationsToTemp();
    for (const name of [
      '006_message_tombstones.sql',
      '007_outbox_repair.sql',
      '008_attachment_file_purges.sql',
      '009_reaction_baselines.sql',
      '010_reconcile_cursor.sql',
      '011_historical_episodes.sql',
      '012_historical_campaigns.sql',
      '013_oauth_login_sessions.sql',
      '014_oauth_authorization_codes.sql',
      '015_oauth_access_tokens.sql',
      '016_direct_answer_requests.sql',
      '017_proposal_review_reason.sql',
      '018_deep_recaps.sql',
      '019_deep_recap_retry_lineage.sql',
      '020_deep_recap_model_calls.sql',
      '021_deep_recap_adaptive_delivery.sql',
      '022_channel_policy_reviews.sql',
      '023_inspector.sql',
      '024_inspector_indexes.sql',
      '025_inspector_sort_indexes.sql',
      '026_direct_answer_job_index.sql',
      '027_scheduled_review_subjects.sql',
      '028_inspector_channel_pagination.sql',
      '029_inspector_archive_pagination.sql',
      '030_inspector_memory_recent_sort.sql',
      '031_scheduled_review_routing.sql',
      '032_proposal_review_message_index.sql',
      '033_inspector_run_observability.sql',
      '034_agent_run_usage_breakdown.sql',
      '035_episode_reasoning_shadow.sql',
      '036_agent_run_execution_start.sql',
      '037_ingestion_recovery.sql',
      '038_proactive_attention.sql',
      '039_deadline_decisions.sql',
      '040_deletion_requests.sql',
      '041_platform_neutral_names.sql',
      '042_channel_kind.sql',
      '043_channel_platform_boundary.sql',
      '044_permanent_platform_boundary.sql',
      '045_channel_private_thread.sql',
    ]) rmSync(`${oldDir}/${name}`);
    const dbPath = `${oldDir}/upgrade.sqlite`;
    const db = openDatabase(dbPath);
    applyMigrations(db, oldDir);
    expect(listAppliedMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    db.prepare("INSERT INTO guilds (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-upgrade','G',1,1)").run();
    db.prepare("INSERT INTO channels (id,guild_id,type,discovered_at_ms,updated_at_ms) VALUES ('c-upgrade','g-upgrade',0,1,1)").run();
    db.prepare("INSERT INTO agent_runs (id,guild_id,run_type,prompt_version,provider,model,status,started_at_ms) VALUES ('run-upgrade','g-upgrade','episode','p','p','m','completed',1)").run();
    db.prepare("INSERT INTO proposals (id,run_id,target_channel_id,status,computed_score,reason,evidence_message_ids_json,created_at_ms,updated_at_ms) VALUES ('proposal-upgrade','run-upgrade','c-upgrade','observed',0,'legacy','[]',1,1)").run();

    applyMigrations(db, copyMigrationsToTemp());
    expect(listAppliedMigrations(db).map((m) => m.version)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='message_tombstones'").get()).toBeDefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='attachment_file_purges'").get()).toBeDefined();
    const syncColumns = db.prepare('PRAGMA table_info(sync_cursors)').all() as Array<{ name: string }>;
    expect(syncColumns.some((column) => column.name === 'reconcile_before_message_id')).toBe(true);
    const proposalColumns = db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>;
    expect(proposalColumns.some((column) => column.name === 'review_reason')).toBe(true);
    expect(proposalColumns.some((column) => column.name === 'topic_key')).toBe(true);
    expect(proposalColumns.some((column) => column.name === 'policy_decision_json')).toBe(true);
    const run = db.prepare(`SELECT model_turns_json,uncached_input_tokens,
      cache_read_tokens,cache_write_tokens,cache_write_1h_tokens,reasoning_tokens,
      provider_total_tokens,uncached_input_cost_usd,output_cost_usd,
      cache_read_cost_usd,cache_write_cost_usd,thinking_level
      FROM agent_runs WHERE id='run-upgrade'`).get() as Record<string, unknown>;
    expect(run.model_turns_json).toBe('[]');
    for (const [key, value] of Object.entries(run)) {
      if (key !== 'model_turns_json') expect(value).toBeNull();
    }
    expect((db.prepare("SELECT policy_decision_json FROM proposals WHERE id='proposal-upgrade'").get() as { policy_decision_json: string | null }).policy_decision_json).toBeNull();
    expect((db.prepare("SELECT shadow_of_run_id,shadow_comparison_json FROM agent_runs WHERE id='run-upgrade'").get() as Record<string, unknown>))
      .toEqual({ shadow_of_run_id: null, shadow_comparison_json: null });
    expect((db.prepare("SELECT execution_started_at_ms FROM agent_runs WHERE id='run-upgrade'").get() as { execution_started_at_ms: number | null }).execution_started_at_ms)
      .toBeNull();
    expect(() => db.prepare("INSERT INTO agent_runs (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms,model_turns_json) VALUES ('bad-run','missing','episode','p','p','m','running',1,'{}')").run()).toThrow();
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_proposal_subjects'",
    ).get()).toBeDefined();
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'scheduled_proposal_subjects_memory_idx'",
    ).get()).toBeDefined();
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_review_dispatch_state'",
    ).get()).toBeDefined();
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_review_cohort_subject_leases'",
    ).get()).toBeDefined();
    db.close();
  });

  it('enforces migration 034 usage constraints', () => {
    const t = createTestDb();
    t.db.prepare("INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-usage','G',1,1)").run();
    t.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
      VALUES ('run-usage','g-usage','episode','p','faux','faux','completed',1)`).run();

    for (const column of [
      'uncached_input_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'cache_write_1h_tokens',
      'reasoning_tokens',
      'provider_total_tokens',
      'uncached_input_cost_usd',
      'output_cost_usd',
      'cache_read_cost_usd',
      'cache_write_cost_usd',
    ]) {
      expect(() => t.db.prepare(`UPDATE agent_runs SET ${column} = -1 WHERE id = ?`).run('run-usage'))
        .toThrow();
    }

    for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      t.db.prepare('UPDATE agent_runs SET thinking_level = ? WHERE id = ?').run(level, 'run-usage');
    }
    t.db.prepare('UPDATE agent_runs SET thinking_level = NULL WHERE id = ?').run('run-usage');
    expect(() => t.db.prepare('UPDATE agent_runs SET thinking_level = ? WHERE id = ?')
      .run('off', 'run-usage')).toThrow();
    t.cleanup();
  });

  it('enforces migration 035 shadow linkage and comparison constraints', () => {
    const t = createTestDb();
    t.db.prepare("INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-shadow','G',1,1)").run();
    const insert = t.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms,shadow_of_run_id)
      VALUES (?,?,?,?,?,?,?, ?,?)`);
    insert.run('authoritative', 'g-shadow', 'episode', 'p', 'faux', 'faux', 'completed', 1, null);
    insert.run('shadow', 'g-shadow', 'episode', 'p', 'faux', 'faux', 'completed', 2, 'authoritative');
    expect(() => insert.run(
      'duplicate-shadow', 'g-shadow', 'episode', 'p', 'faux', 'faux', 'completed', 3, 'authoritative',
    )).toThrow();
    expect(() => t.db.prepare('UPDATE agent_runs SET shadow_comparison_json=? WHERE id=?')
      .run('[]', 'shadow')).toThrow();
    t.db.prepare('UPDATE agent_runs SET shadow_comparison_json=? WHERE id=?')
      .run('{"version":1}', 'shadow');
    expect(() => insert.run(
      'missing-parent', 'g-shadow', 'episode', 'p', 'faux', 'faux', 'completed', 4, 'absent',
    )).toThrow();
    t.cleanup();
  });

  it('keeps migration 036 execution timing nullable for legacy runs and non-negative', () => {
    const t = createTestDb();
    t.db.prepare("INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-time','G',1,1)").run();
    t.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
      VALUES ('legacy-time','g-time','episode','p','faux','faux','completed',1)`).run();
    expect(t.db.prepare('SELECT execution_started_at_ms FROM agent_runs WHERE id=?')
      .get('legacy-time')).toEqual({ execution_started_at_ms: null });
    expect(() => t.db.prepare('UPDATE agent_runs SET execution_started_at_ms=-1 WHERE id=?')
      .run('legacy-time')).toThrow();
    t.db.prepare('UPDATE agent_runs SET execution_started_at_ms=2 WHERE id=?').run('legacy-time');
    expect(t.db.prepare('SELECT execution_started_at_ms FROM agent_runs WHERE id=?')
      .get('legacy-time')).toEqual({ execution_started_at_ms: 2 });
    t.cleanup();
  });

  it('enforces migration 038 proactive-attention constraints', () => {
    const t = createTestDb();
    const g = "INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-att','G',1,1)";
    t.db.prepare(g).run();
    t.db.prepare(`INSERT INTO channels
      (id,workspace_id,kind,visibility_class,discovered_at_ms,updated_at_ms)
      VALUES ('c-att','g-att','text','org',1,1)`).run();
    t.db.prepare(`INSERT INTO agent_runs
      (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms)
      VALUES ('run-att','g-att','episode','p','faux','faux','completed',1)`).run();
    t.db.prepare(`INSERT INTO proposals
      (id,run_id,target_channel_id,status,computed_score,reason,evidence_message_ids_json,created_at_ms,updated_at_ms)
      VALUES ('p-att','run-att','c-att','pending_review',1,'r','[]',1,1)`).run();
    t.db.prepare(`INSERT INTO users (id,is_bot,first_seen_at_ms,last_seen_at_ms)
      VALUES ('u-att',0,1,1)`).run();
    t.db.prepare(`INSERT INTO messages
      (id,workspace_id,channel_id,author_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms)
      VALUES ('m-att','g-att','c-att','u-att','A','body',1,1,1)`).run();
    t.db.prepare(`INSERT INTO memories
      (id,workspace_id,scope_type,type,statement,confidence,importance,
       first_seen_at_ms,last_confirmed_at_ms,created_at_ms,updated_at_ms)
      VALUES ('mem-att','g-att','org','decision','We ship weekly.',0.9,0.8,1,1,1,1)`).run();

    t.db.prepare(`INSERT INTO attention_subjects (id,workspace_id,registration_state,created_at_ms)
      VALUES ('s-att','g-att','pending',1)`).run();
    expect(() => t.db.prepare(`INSERT INTO attention_subjects (id,workspace_id,registration_state,created_at_ms)
      VALUES ('s-bad','g-att','unknown',1)`).run()).toThrow();
    t.db.prepare(`INSERT INTO attention_subject_members (memory_id,subject_id,created_at_ms)
      VALUES ('mem-att','s-att',1)`).run();
    // One memory belongs to at most one subject: the member PK blocks a second.
    t.db.prepare(`INSERT INTO attention_subjects (id,workspace_id,registration_state,created_at_ms)
      VALUES ('s-two','g-att','pending',1)`).run();
    expect(() => t.db.prepare(`INSERT INTO attention_subject_members (memory_id,subject_id,created_at_ms)
      VALUES ('mem-att','s-two',1)`).run()).toThrow();
    // The shared subject id is not unique on the members table, so it cannot
    // parent another table's foreign key; revisions reference the subject row.
    t.db.prepare(`INSERT INTO attention_revisions
      (id,subject_id,revision_key,human_event_at_ms,state,created_at_ms)
      VALUES ('r-att','s-att','key-a',10,'current',1)`).run();
    expect(() => t.db.prepare(`INSERT INTO attention_revisions
      (id,subject_id,revision_key,human_event_at_ms,state,created_at_ms)
      VALUES ('r-dup','s-att','key-a',20,'current',1)`).run()).toThrow();
    expect(() => t.db.prepare(`INSERT INTO attention_revisions
      (id,subject_id,revision_key,human_event_at_ms,state,created_at_ms)
      VALUES ('r-bad','s-att','key-b',10,'retired',1)`).run()).toThrow();
    t.db.prepare(`INSERT INTO attention_revision_evidence
      (revision_id,message_id,role,source_content_digest,quote_start,quote_end)
      VALUES ('r-att','m-att','material_trigger','digest',0,4)`).run();
    expect(() => t.db.prepare(`INSERT INTO attention_revision_evidence
      (revision_id,message_id,role,source_content_digest,quote_start,quote_end)
      VALUES ('r-att','m-att','origin','digest',0,4)`).run()).toThrow();
    expect(() => t.db.prepare(`INSERT INTO attention_revision_evidence
      (revision_id,message_id,role,source_content_digest,quote_start,quote_end)
      VALUES ('r-att','m-att','material_trigger','digest',5,4)`).run()).toThrow();
    t.db.prepare(`INSERT INTO proposal_attention_claims
      (revision_id,proposal_id,consumed_at_ms,eligible_from_ms,eligible_until_ms)
      VALUES ('r-att','p-att',30,10,40)`).run();
    // One revision, one claim: the PK blocks a second claim even with no proposal.
    expect(() => t.db.prepare(`INSERT INTO proposal_attention_claims
      (revision_id,proposal_id,consumed_at_ms,eligible_from_ms,eligible_until_ms)
      VALUES ('r-att',NULL,31,10,40)`).run()).toThrow();
    // A proposal owns at most one revision.
    t.db.prepare(`INSERT INTO attention_revisions
      (id,subject_id,revision_key,human_event_at_ms,state,created_at_ms)
      VALUES ('r-dup2','s-two','key-c',10,'current',1)`).run();
    expect(() => t.db.prepare(`INSERT INTO proposal_attention_claims
      (revision_id,proposal_id,consumed_at_ms,eligible_from_ms,eligible_until_ms)
      VALUES ('r-dup2','p-att',31,10,40)`).run()).toThrow();
    // Deleting the owning proposal must never make the revision reusable.
    t.db.prepare('DELETE FROM proposals WHERE id = ?').run('p-att');
    expect(t.db.prepare('SELECT revision_id, proposal_id FROM proposal_attention_claims')
      .get()).toEqual({ revision_id: 'r-att', proposal_id: null });
    t.cleanup();
  });

  it('upgrades version 38 deadline snapshots without reparsing or restoring cleared authority', () => {
    const oldDir = copyMigrationsToTemp();
    const newDir = copyMigrationsToTemp();
    rmSync(`${oldDir}/039_deadline_decisions.sql`);
    rmSync(`${oldDir}/040_deletion_requests.sql`);
    rmSync(`${oldDir}/041_platform_neutral_names.sql`);
    rmSync(`${oldDir}/042_channel_kind.sql`);
    rmSync(`${oldDir}/043_channel_platform_boundary.sql`);
    rmSync(`${oldDir}/044_permanent_platform_boundary.sql`);
    rmSync(`${oldDir}/045_channel_private_thread.sql`);
    const db = openDatabase(`${oldDir}/deadline-upgrade.sqlite`);
    try {
      applyMigrations(db, oldDir);
      const { guildId, channelId, userId } = seedLegacyIdentity(db);
      for (const id of ['set-subject', 'clear-subject', 'ordinary-subject']) {
        db.prepare(`INSERT INTO attention_subjects (id,guild_id,registration_state,created_at_ms)
          VALUES (?,?,'complete',1)`).run(id, guildId);
      }
      const due = Date.parse('2026-09-18T21:59:59.999Z');
      for (const [id, subject, sourceAt, deadline, recordedAt] of [
        ['old', 'set-subject', 10, due - 86_400_000, 200],
        ['new', 'set-subject', 20, due, 100],
        ['cleared', 'clear-subject', 30, null, 300],
        ['ordinary', 'ordinary-subject', 40, null, 400],
      ] as const) {
        db.prepare(`INSERT INTO messages
          (id,guild_id,channel_id,author_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms)
          VALUES (?,?,?,?,?,'The report is due Friday.',?,?,?)`)
          .run(id, guildId, channelId, userId, 'Alice', sourceAt, recordedAt, recordedAt);
        db.prepare(`INSERT INTO attention_revisions
          (id,subject_id,revision_key,human_event_at_ms,state,explicit_deadline_at_ms,
           deadline_timezone,deadline_parser_version,created_at_ms)
          VALUES (?,?,?,?,'current',?,?,?,?)`)
          .run(id, subject, `key-${id}`, sourceAt, deadline,
            deadline === null ? null : 'Europe/Zagreb', deadline === null ? null : 'deadline-v1', recordedAt);
        db.prepare(`INSERT INTO attention_revision_evidence
          (revision_id,message_id,role,source_content_digest,quote_start,quote_end)
          VALUES (?,?,'material_trigger','source-digest',0,25)`).run(id, id);
        if (id !== 'ordinary') db.prepare(`INSERT INTO attention_revision_evidence
          (revision_id,message_id,role,source_content_digest,quote_start,quote_end)
          VALUES (?,?,'explicit_deadline','source-digest',0,25)`).run(id, id);
      }
      db.prepare(`INSERT INTO proposal_attention_claims
        (revision_id,proposal_id,consumed_at_ms,eligible_from_ms,eligible_until_ms)
        VALUES ('cleared',NULL,31,30,40)`).run();

      expect(applyMigrations(db, newDir).applied.map((m) => m.version)).toEqual([39, 40, 41, 42, 43, 44, 45]);
      expect(getDeadlineDecision(db, 'set-subject')).toEqual({
        subjectId: 'set-subject', sourceMessageId: 'new', sourceCreatedAtMs: 20,
        sourceContentDigest: 'source-digest', quoteStart: 0, quoteEnd: 25,
        recordedAtMs: 100, action: 'set', revisionId: 'new', deadlineAtMs: due,
        timezone: 'Europe/Zagreb', parserVersion: 'deadline-v1', basis: 'legacy', expressionDigest: null,
      });
      expect(db.prepare(`SELECT explicit_deadline_at_ms,deadline_timezone,deadline_parser_version
        FROM attention_revisions WHERE id='new'`).get()).toEqual({
        explicit_deadline_at_ms: due, deadline_timezone: 'Europe/Zagreb', deadline_parser_version: 'deadline-v1',
      });
      expect(getDeadlineDecision(db, 'clear-subject')).toBeNull();
      expect(db.prepare("SELECT state FROM attention_revisions WHERE id='cleared'").get())
        .toEqual({ state: 'invalidated' });
      expect(db.prepare("SELECT role FROM attention_revision_evidence WHERE revision_id='cleared'").all())
        .toEqual([{ role: 'material_trigger' }]);
      expect(db.prepare("SELECT revision_id FROM proposal_attention_claims WHERE revision_id='cleared'").get())
        .toEqual({ revision_id: 'cleared' });
      expect(db.prepare("SELECT state FROM attention_revisions WHERE id='ordinary'").get())
        .toEqual({ state: 'current' });
      expect(() => db.prepare("UPDATE attention_deadline_decisions SET deadline_basis=NULL").run()).toThrow();
      expect(() => db.prepare("UPDATE attention_deadline_decisions SET action='clear'").run()).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(applyMigrations(db, newDir).applied).toEqual([]);
    } finally {
      db.close();
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  });

  it('upgrades version 18 recap rows into explicit retry lineages', () => {
    const v18Dir = copyMigrationsToTemp();
    rmSync(`${v18Dir}/019_deep_recap_retry_lineage.sql`);
    rmSync(`${v18Dir}/020_deep_recap_model_calls.sql`);
    rmSync(`${v18Dir}/021_deep_recap_adaptive_delivery.sql`);
    rmSync(`${v18Dir}/022_channel_policy_reviews.sql`);
    rmSync(`${v18Dir}/023_inspector.sql`);
    rmSync(`${v18Dir}/024_inspector_indexes.sql`);
    rmSync(`${v18Dir}/025_inspector_sort_indexes.sql`);
    rmSync(`${v18Dir}/026_direct_answer_job_index.sql`);
    rmSync(`${v18Dir}/027_scheduled_review_subjects.sql`);
    rmSync(`${v18Dir}/028_inspector_channel_pagination.sql`);
    rmSync(`${v18Dir}/029_inspector_archive_pagination.sql`);
    rmSync(`${v18Dir}/030_inspector_memory_recent_sort.sql`);
    rmSync(`${v18Dir}/031_scheduled_review_routing.sql`);
    rmSync(`${v18Dir}/032_proposal_review_message_index.sql`);
    rmSync(`${v18Dir}/033_inspector_run_observability.sql`);
    rmSync(`${v18Dir}/034_agent_run_usage_breakdown.sql`);
    rmSync(`${v18Dir}/035_episode_reasoning_shadow.sql`);
    rmSync(`${v18Dir}/036_agent_run_execution_start.sql`);
    rmSync(`${v18Dir}/037_ingestion_recovery.sql`);
    rmSync(`${v18Dir}/038_proactive_attention.sql`);
    rmSync(`${v18Dir}/039_deadline_decisions.sql`);
    rmSync(`${v18Dir}/040_deletion_requests.sql`);
    rmSync(`${v18Dir}/041_platform_neutral_names.sql`);
    rmSync(`${v18Dir}/042_channel_kind.sql`);
    rmSync(`${v18Dir}/043_channel_platform_boundary.sql`);
    rmSync(`${v18Dir}/044_permanent_platform_boundary.sql`);
    rmSync(`${v18Dir}/045_channel_private_thread.sql`);
    const db = openDatabase(`${v18Dir}/lineage-upgrade.sqlite`);
    applyMigrations(db, v18Dir);
    db.prepare("INSERT INTO guilds (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-lineage','G',1,1)").run();
    db.prepare(`INSERT INTO channels
      (id,guild_id,type,visibility_class,discovered_at_ms,updated_at_ms)
      VALUES ('c-lineage','g-lineage',0,'org',1,1)`).run();
    db.prepare(`INSERT INTO deep_recap_requests
      (id,guild_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
       budget_usd,created_at_ms,updated_at_ms)
      VALUES ('recap-lineage','g-lineage','c-lineage','u',1,2,5,1,1)`).run();

    applyMigrations(db, copyMigrationsToTemp());

    expect(db.prepare(`SELECT retry_of_request_id,retry_root_request_id
      FROM deep_recap_requests WHERE id='recap-lineage'`).get()).toEqual({
      retry_of_request_id: null,
      retry_root_request_id: 'recap-lineage',
    });
    expect(() => db.prepare(`UPDATE deep_recap_requests
      SET retry_of_request_id='missing' WHERE id='recap-lineage'`).run()).toThrow();
    expect(() => db.prepare(`UPDATE deep_recap_requests
      SET retry_root_request_id='missing' WHERE id='recap-lineage'`).run()).toThrow();
    db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,retry_of_request_id,
       retry_root_request_id,after_at_ms,before_at_ms,budget_usd,status,
       planned_chunks,completed_chunks,last_error_category,created_at_ms,updated_at_ms,
       completed_at_ms)
      VALUES ('retry-one','g-lineage','c-lineage','u','recap-lineage',
              'recap-lineage',1,2,5,'failed',1,1,'processing_error',2,2,2)`).run();
    expect(() => db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,retry_of_request_id,
       retry_root_request_id,after_at_ms,before_at_ms,budget_usd,status,
       planned_chunks,completed_chunks,last_error_category,created_at_ms,updated_at_ms,
       completed_at_ms)
      VALUES ('retry-branch','g-lineage','c-lineage','u','recap-lineage',
              'recap-lineage',1,2,5,'failed',1,1,'processing_error',3,3,3)`).run())
      .toThrow(/UNIQUE constraint failed/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='deep_recap_retry_root_idx'").get())
      .toBeDefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='deep_recap_retry_one_child_idx'").get())
      .toBeDefined();
    db.close();
  });

  it('upgrades version 19 recap spend into timestamped model-call rows', () => {
    const v19Dir = copyMigrationsToTemp();
    rmSync(`${v19Dir}/020_deep_recap_model_calls.sql`);
    rmSync(`${v19Dir}/021_deep_recap_adaptive_delivery.sql`);
    rmSync(`${v19Dir}/022_channel_policy_reviews.sql`);
    rmSync(`${v19Dir}/023_inspector.sql`);
    rmSync(`${v19Dir}/024_inspector_indexes.sql`);
    rmSync(`${v19Dir}/025_inspector_sort_indexes.sql`);
    rmSync(`${v19Dir}/026_direct_answer_job_index.sql`);
    rmSync(`${v19Dir}/027_scheduled_review_subjects.sql`);
    rmSync(`${v19Dir}/028_inspector_channel_pagination.sql`);
    rmSync(`${v19Dir}/029_inspector_archive_pagination.sql`);
    rmSync(`${v19Dir}/030_inspector_memory_recent_sort.sql`);
    rmSync(`${v19Dir}/031_scheduled_review_routing.sql`);
    rmSync(`${v19Dir}/032_proposal_review_message_index.sql`);
    rmSync(`${v19Dir}/033_inspector_run_observability.sql`);
    rmSync(`${v19Dir}/034_agent_run_usage_breakdown.sql`);
    rmSync(`${v19Dir}/035_episode_reasoning_shadow.sql`);
    rmSync(`${v19Dir}/036_agent_run_execution_start.sql`);
    rmSync(`${v19Dir}/037_ingestion_recovery.sql`);
    rmSync(`${v19Dir}/038_proactive_attention.sql`);
    rmSync(`${v19Dir}/039_deadline_decisions.sql`);
    rmSync(`${v19Dir}/040_deletion_requests.sql`);
    rmSync(`${v19Dir}/041_platform_neutral_names.sql`);
    rmSync(`${v19Dir}/042_channel_kind.sql`);
    rmSync(`${v19Dir}/043_channel_platform_boundary.sql`);
    rmSync(`${v19Dir}/044_permanent_platform_boundary.sql`);
    rmSync(`${v19Dir}/045_channel_private_thread.sql`);
    const db = openDatabase(`${v19Dir}/cost-upgrade.sqlite`);
    applyMigrations(db, v19Dir);
    db.prepare("INSERT INTO guilds (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-cost','G',1,1)").run();
    db.prepare(`INSERT INTO channels
      (id,guild_id,type,visibility_class,discovered_at_ms,updated_at_ms)
      VALUES ('c-cost','g-cost',0,'org',1,1)`).run();
    db.prepare(`INSERT INTO agent_runs
      (id,guild_id,run_type,prompt_version,provider,model,status,started_at_ms,
       ended_at_ms,cost_usd)
      VALUES ('run-cost','g-cost','direct_answer','p','faux','faux','completed',10,11,.20)`).run();
    db.prepare(`INSERT INTO deep_recap_requests
      (id,guild_id,target_channel_id,requested_by_user_id,retry_root_request_id,
       after_at_ms,before_at_ms,budget_usd,spent_usd,synthesis_cost_usd,status,
       planned_chunks,completed_chunks,created_at_ms,updated_at_ms,completed_at_ms)
      VALUES ('recap-cost','g-cost','c-cost','u','recap-cost',1,20,5,.30,.10,
              'completed',1,1,1,20,20)`).run();
    db.prepare(`INSERT INTO deep_recap_chunks
      (request_id,ordinal,after_at_ms,before_at_ms,status,run_id,cost_usd,
       created_at_ms,updated_at_ms)
      VALUES ('recap-cost',0,1,20,'completed','run-cost',.20,1,11)`).run();

    applyMigrations(db, copyMigrationsToTemp());

    expect(db.prepare(`SELECT run_id,phase,chunk_ordinal,started_at_ms,cost_usd
      FROM deep_recap_model_calls ORDER BY phase`).all()).toEqual([
      { run_id: 'run-cost', phase: 'chunk', chunk_ordinal: 0, started_at_ms: 10, cost_usd: 0.2 },
      { run_id: null, phase: 'synthesis', chunk_ordinal: null, started_at_ms: 20, cost_usd: 0.1 },
    ]);
    expect(() => db.prepare(`INSERT INTO deep_recap_model_calls
      (id,request_id,run_id,phase,chunk_ordinal,started_at_ms,created_at_ms,updated_at_ms)
      VALUES ('duplicate-run','recap-cost','run-cost','synthesis',NULL,30,30,30)`).run())
      .toThrow(/UNIQUE constraint failed/);
    // A pre-call reservation must be legal before its agent_runs row exists.
    db.prepare(`INSERT INTO deep_recap_model_calls
      (id,request_id,run_id,phase,chunk_ordinal,started_at_ms,created_at_ms,updated_at_ms)
      VALUES ('reserved','recap-cost','future-run','synthesis',NULL,30,30,30)`).run();
    db.close();
  });

  it('cancels unapproved legacy deletion jobs on upgrade without touching messages', () => {
    const oldDir = copyMigrationsToTemp();
    const newDir = copyMigrationsToTemp();
    rmSync(`${oldDir}/040_deletion_requests.sql`);
    rmSync(`${oldDir}/041_platform_neutral_names.sql`);
    rmSync(`${oldDir}/042_channel_kind.sql`);
    rmSync(`${oldDir}/043_channel_platform_boundary.sql`);
    rmSync(`${oldDir}/044_permanent_platform_boundary.sql`);
    rmSync(`${oldDir}/045_channel_private_thread.sql`);
    const db = openDatabase(`${oldDir}/deletion-upgrade.sqlite`);
    try {
      applyMigrations(db, oldDir);
      const { guildId, channelId, userId } = seedLegacyIdentity(db);
      db.prepare(`INSERT INTO messages (id,guild_id,channel_id,author_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms)
        VALUES ('m',?,?,?,'name','retained',1,1,1)`).run(guildId, channelId, userId);
      enqueue(db, { type: 'forget_user', payload: { userId }, now: 1 });
      claimNextJob(db, { type: 'forget_user', now: 1, owner: 'old-worker', leaseMs: 100 });
      enqueue(db, { type: 'forget_user', payload: { userId }, now: 1 });
      expect(applyMigrations(db, newDir).applied.map((m) => m.version)).toEqual([40, 41, 42, 43, 44, 45]);
      expect(db.prepare("SELECT count(*) n FROM jobs WHERE type='forget_user' AND status='cancelled'").get()?.n).toBe(2);
      expect(db.prepare("SELECT content FROM messages WHERE id='m'").get()?.content).toBe('retained');
      expect(db.prepare("SELECT count(*) n FROM admin_events WHERE action='deletion_legacy_job_cancelled'").get()?.n).toBe(2);
      expect(applyMigrations(db, newDir).applied).toEqual([]);
    } finally {
      db.close();
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  });

  it('renames guild tables, columns, and indexes to workspace names in migration 041', () => {
    const oldDir = copyMigrationsToTemp();
    const newDir = copyMigrationsToTemp();
    rmSync(`${oldDir}/041_platform_neutral_names.sql`);
    rmSync(`${oldDir}/042_channel_kind.sql`);
    rmSync(`${oldDir}/043_channel_platform_boundary.sql`);
    rmSync(`${oldDir}/044_permanent_platform_boundary.sql`);
    rmSync(`${oldDir}/045_channel_private_thread.sql`);
    const db = openDatabase(`${oldDir}/workspace-rename.sqlite`);
    try {
      applyMigrations(db, oldDir);
      const { guildId: g, channelId: c, userId: u } = seedLegacyIdentity(db);
      const seed = [
        "INSERT INTO guild_members (guild_id,user_id,updated_at_ms) VALUES (?,?,1)",
        "INSERT INTO messages (id,guild_id,channel_id,author_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms) VALUES ('m1',?,?,?,'Alice','renamed workspace text',1,1,1)",
        "INSERT INTO episodes (id,guild_id,conversation_channel_id,status,started_at_ms,last_activity_at_ms,created_at_ms,updated_at_ms) VALUES ('e1',?,?,'open',1,1,1,1)",
        "INSERT INTO memories (id,guild_id,scope_type,type,statement,confidence,importance,first_seen_at_ms,last_confirmed_at_ms,created_at_ms,updated_at_ms) VALUES ('mem1',?,'org','decision','s',0.5,0.5,1,1,1,1)",
        "INSERT INTO agent_runs (id,guild_id,run_type,prompt_version,provider,model,status,started_at_ms) VALUES ('r1',?,'episode','p','p','m','completed',1)",
        "INSERT INTO admin_events (id,guild_id,actor_user_id,action,created_at_ms) VALUES ('a1',?,?,'test',1)",
        "INSERT INTO message_tombstones (message_id,guild_id,deleted_at_ms,created_at_ms) VALUES ('gone',?,1,1)",
        "INSERT INTO attention_subjects (id,guild_id,registration_state,created_at_ms) VALUES ('s1',?,'complete',1)",
        "INSERT INTO historical_memory_campaigns (id,guild_id,from_at_ms,to_at_ms,provider,model,thinking_level,channel_ids_json,daily_budget_usd,total_budget_usd,created_at_ms,updated_at_ms) VALUES ('hc1',?,1,2,'p','m','low','[]',0,1,1,1)",
        "INSERT INTO direct_answer_requests (source_message_id,guild_id,target_channel_id,question_created_at_ms,deadline_at_ms,response_intent_key,created_at_ms,updated_at_ms) VALUES ('d1',?,?,1,2,'k',1,1)",
        "INSERT INTO deep_recap_requests (id,guild_id,target_channel_id,requested_by_user_id,retry_root_request_id,after_at_ms,before_at_ms,budget_usd,created_at_ms,updated_at_ms) VALUES ('dr1',?,?,?,'dr1',1,2,1,1,1)",
        "INSERT INTO channel_policy_reviews (id,guild_id,channel_id,created_at_ms,updated_at_ms) VALUES ('cp1',?,?,1,1)",
        "INSERT INTO ingestion_recovery_requests (id,guild_id,channel_id,message_id,reason,status,first_observed_at_ms,last_observed_at_ms) VALUES ('ir1',?,?,'m2','missing_message','pending',1,1)",
        "INSERT INTO deletion_requests (id,guild_id,target_kind,target_id,requester_user_id,status,created_at_ms) VALUES ('del1',?,'message','m1',?,'pending',1)",
        "INSERT INTO outbox (id,channel_id,content,dedupe_key,next_attempt_at_ms,created_at_ms,updated_at_ms,discord_message_id) VALUES ('o1',?,'x','k1',1,1,1,'sent-1')",
      ];
      for (const sql of seed) {
        const params = sql.includes("guild_members") ? [g, u]
          : sql.includes("INTO messages") ? [g, c, u]
          : sql.includes("INTO episodes") || sql.includes("direct_answer") || sql.includes("channel_policy") || sql.includes("ingestion_recovery") ? [g, c]
          : sql.includes("admin_events") || sql.includes("deletion_requests") ? [g, u]
          : sql.includes("deep_recap") ? [g, c, u]
          : sql.includes("INTO outbox") ? [c]
          : [g];
        db.prepare(sql).run(...params);
      }

      expect(applyMigrations(db, newDir).applied.map((m) => m.version)).toEqual([41, 42, 43, 44, 45]);

      const renamed = ['channels', 'workspace_members', 'messages', 'episodes', 'memories', 'agent_runs',
        'admin_events', 'message_tombstones', 'historical_memory_campaigns', 'direct_answer_requests',
        'deep_recap_requests', 'channel_policy_reviews', 'ingestion_recovery_requests', 'attention_subjects',
        'deletion_requests'];
      for (const table of renamed) {
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name);
        expect(columns, table).toContain('workspace_id');
        expect(columns, table).not.toContain('guild_id');
        expect(db.prepare(`SELECT count(*) n FROM ${table} WHERE workspace_id = ?`).get(g)?.n, table).toBe(1);
      }
      const outboxColumns = (db.prepare('PRAGMA table_info(outbox)').all() as Array<{ name: string }>).map((col) => col.name);
      expect(outboxColumns).toContain('platform_message_id');
      expect(outboxColumns).not.toContain('discord_message_id');
      expect(db.prepare("SELECT platform_message_id FROM outbox WHERE id='o1'").get()).toEqual({ platform_message_id: 'sent-1' });
      expect(db.prepare("SELECT id FROM workspaces").all()).toEqual([{ id: g }]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('guilds','guild_members')").all()).toEqual([]);

      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const channelKeys = db.prepare('PRAGMA foreign_key_list(channels)').all() as Array<{ table: string; from: string }>;
      expect(channelKeys).toContainEqual(expect.objectContaining({ table: 'workspaces', from: 'workspace_id' }));

      db.prepare(`INSERT INTO messages (id,workspace_id,channel_id,author_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms)
        VALUES ('m3',?,?,?,'Alice','zebracrossing',2,2,2)`).run(g, c, u);
      expect(db.prepare("SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'zebracrossing'").get()?.n).toBe(1);

      const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((row) => row.name);
      for (const name of ['channels_workspace_idx', 'channel_policy_reviews_workspace_status_idx',
        'attention_subjects_workspace_idx', 'outbox_platform_message_idx']) expect(indexNames).toContain(name);
      for (const name of ['channels_guild_idx', 'channel_policy_reviews_guild_status_idx',
        'attention_subjects_guild_idx', 'outbox_discord_message_idx']) expect(indexNames).not.toContain(name);
    } finally {
      db.close();
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  });

  it('replaces the numeric channel type with a neutral kind in migration 042', () => {
    const oldDir = copyMigrationsToTemp();
    const newDir = copyMigrationsToTemp();
    rmSync(`${oldDir}/042_channel_kind.sql`);
    rmSync(`${oldDir}/043_channel_platform_boundary.sql`);
    rmSync(`${oldDir}/044_permanent_platform_boundary.sql`);
    rmSync(`${oldDir}/045_channel_private_thread.sql`);
    const db = openDatabase(`${oldDir}/channel-kind.sqlite`);
    try {
      applyMigrations(db, oldDir);
      db.prepare("INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-kind','G',1,1)").run();
      const expected: Record<number, string> = {
        0: 'text', 2: 'other', 4: 'category', 5: 'announcement', 10: 'thread', 11: 'thread',
        12: 'thread', 13: 'other', 15: 'forum', 16: 'media',
      };
      for (const type of Object.keys(expected)) {
        db.prepare(`INSERT INTO channels (id,workspace_id,type,visibility_class,discovered_at_ms,updated_at_ms)
          VALUES (?,'g-kind',?,'restricted',1,1)`).run(`c-${type}`, Number(type));
      }

      expect(applyMigrations(db, newDir).applied.map((m) => m.version)).toEqual([42, 43, 44, 45]);

      const columns = (db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toContain('kind');
      expect(columns).not.toContain('type');
      for (const [type, kind] of Object.entries(expected)) {
        expect(db.prepare('SELECT kind FROM channels WHERE id = ?').get(`c-${type}`)).toEqual({ kind });
      }
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  });

  it('rolls back a failed migration while keeping prior ones', () => {
    const dir = copyMigrationsToTemp();
    writeMigration(dir, '046_bad.sql', 'CREATE TABLE definitely valid syntax NOT;');
    const db = openDatabase(`${dir}/db.sqlite`);
    expect(() => applyMigrations(db, dir)).toThrow();
    expect(listAppliedMigrations(db).map((m) => m.version)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    db.close();
  });

  it('rejects a modified already-applied migration (checksum drift)', () => {
    const dir = copyMigrationsToTemp();
    const db = openDatabase(`${dir}/db.sqlite`);
    applyMigrations(db, dir);
    writeMigration(dir, '001_core.sql', '-- tampered\n' + '-- changed content\n');
    expect(() => applyMigrations(db, dir)).toThrow(MigrationError);
    db.close();
  });

  it('rejects duplicate migration versions', () => {
    const dir = makeTempDir();
    writeMigration(dir, '001_a.sql', 'SELECT 1;');
    writeMigration(dir, '001_b.sql', 'SELECT 1;');
    expect(() => discoverMigrations(dir)).toThrow(MigrationError);
  });

  it('rejects a gap in migration versions', () => {
    const dir = makeTempDir();
    writeMigration(dir, '001_a.sql', 'SELECT 1;');
    writeMigration(dir, '003_b.sql', 'SELECT 1;');
    expect(() => discoverMigrations(dir)).toThrow(MigrationError);
  });

  it('rejects an applied version whose file is missing', () => {
    const dir = copyMigrationsToTemp();
    const db = openDatabase(`${dir}/db.sqlite`);
    applyMigrations(db, dir);
    // Re-open a fresh DB but point at a dir that only has 001-003 (drop 004).
    rmSync(`${dir}/004_fts.sql`);
    expect(() => applyMigrations(db, dir)).toThrow(MigrationError);
    db.close();
  });
});

describe('core storage migration integrity', () => {
  it('uses the live global time index for org-wide recent activity scans', () => {
    const t = createTestDb();
    const plan = t.db.prepare(`EXPLAIN QUERY PLAN
      SELECT m.id
        FROM messages m
        JOIN channels c ON c.id = m.channel_id
       WHERE m.deleted_at_ms IS NULL
         AND m.created_at_ms >= ? AND m.created_at_ms < ?
         AND c.deleted_at_ms IS NULL
         AND c.ingest_enabled = 1
         AND c.visibility_class = 'org'
       ORDER BY m.created_at_ms ASC, m.id ASC`).all(1, 2) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('messages_recent_live_idx'))).toBe(true);
    t.cleanup();
  });

  it('rejects invalid visibility_class enum values', () => {
    const t = createTestDb();
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO channels (id, workspace_id, kind, visibility_class, discovered_at_ms, updated_at_ms)
           VALUES ('c1','100000000000000001','text','public',1,1)`,
        )
        .run(),
    ).toThrow();
    t.cleanup();
  });

  it('rejects boolean values outside the checked domain', () => {
    const t = createTestDb();
    expect(() =>
      t.db
        .prepare(
          `INSERT INTO channels (id, workspace_id, kind, is_thread, visibility_class, discovered_at_ms, updated_at_ms)
           VALUES ('c1','100000000000000001','text',2,'restricted',1,1)`,
        )
        .run(),
    ).toThrow();
    t.cleanup();
  });
});

describe('inspector migration integrity', () => {
  it('backs every inspector cursor listing with an index, not a temp sort', () => {
    const t = createTestDb();
    const episodePlan = t.db.prepare(`EXPLAIN QUERY PLAN
      SELECT id FROM episodes ORDER BY last_activity_at_ms DESC, id DESC LIMIT 21`)
      .all() as Array<{ detail: string }>;
    expect(episodePlan.some((row) => row.detail.includes('episodes_last_activity_idx'))).toBe(true);
    expect(episodePlan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);

    const runPlan = t.db.prepare(`EXPLAIN QUERY PLAN
      SELECT id FROM agent_runs ORDER BY started_at_ms DESC, id DESC LIMIT 21`)
      .all() as Array<{ detail: string }>;
    expect(runPlan.some((row) => row.detail.includes('agent_runs_started_idx'))).toBe(true);
    expect(runPlan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);

    const channelPlan = t.db.prepare(`EXPLAIN QUERY PLAN
      SELECT id FROM channels WHERE is_thread = 0
      ORDER BY (deleted_at_ms IS NOT NULL), LOWER(COALESCE(name, id)), id LIMIT 21`)
      .all() as Array<{ detail: string }>;
    expect(channelPlan.some((row) => row.detail.includes('channels_inspector_kind_name_idx'))).toBe(true);
    expect(channelPlan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);

    const plans: Array<{ sql: string; params?: SQLInputValue[]; index: string }> = [
      {
        sql: `WITH effective AS (SELECT id FROM memories)
          SELECT mem.id FROM memories mem INDEXED BY memories_inspector_archive_idx
          CROSS JOIN effective eff ON eff.id = mem.id
          ORDER BY mem.importance DESC, mem.last_confirmed_at_ms DESC, mem.id DESC LIMIT 21`,
        index: 'memories_inspector_archive_idx',
      },
      {
        sql: `WITH effective AS (SELECT id FROM memories)
          SELECT mem.id FROM memories mem INDEXED BY memories_inspector_recent_idx
          CROSS JOIN effective eff ON eff.id = mem.id
          ORDER BY mem.last_confirmed_at_ms DESC, mem.id DESC LIMIT 21`,
        index: 'memories_inspector_recent_idx',
      },
      {
        sql: `SELECT me.message_id FROM memory_evidence me INDEXED BY memory_evidence_inspector_archive_idx
          CROSS JOIN messages m ON m.id = me.message_id
          CROSS JOIN channels c ON c.id = m.channel_id
          WHERE me.memory_id = ? ORDER BY me.created_at_ms, me.message_id, me.stance LIMIT 21`,
        params: ['mem'],
        index: 'memory_evidence_inspector_archive_idx',
      },
      {
        sql: `SELECT p.id FROM proposals p INDEXED BY proposals_inspector_archive_idx
          CROSS JOIN channels c ON c.id = p.target_channel_id
          ORDER BY p.created_at_ms DESC, p.id DESC LIMIT 21`,
        index: 'proposals_inspector_archive_idx',
      },
      {
        sql: `SELECT o.id FROM outbox o INDEXED BY outbox_inspector_archive_idx
          CROSS JOIN channels c ON c.id = o.channel_id
          ORDER BY o.created_at_ms DESC, o.id DESC LIMIT 21`,
        index: 'outbox_inspector_archive_idx',
      },
      {
        sql: `SELECT id FROM jobs INDEXED BY jobs_inspector_archive_idx
          ORDER BY created_at_ms DESC, id DESC LIMIT 21`,
        index: 'jobs_inspector_archive_idx',
      },
      {
        sql: `SELECT id FROM admin_events INDEXED BY admin_events_inspector_archive_idx
          ORDER BY created_at_ms DESC, id DESC LIMIT 21`,
        index: 'admin_events_inspector_archive_idx',
      },
    ];
    for (const item of plans) {
      const plan = t.db.prepare(`EXPLAIN QUERY PLAN ${item.sql}`).all(...(item.params ?? [])) as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes(item.index)), item.index).toBe(true);
      expect(plan.some((row) => row.detail.includes('TEMP B-TREE')), item.index).toBe(false);
    }
    t.cleanup();
  });
});

describe('memory migration integrity', () => {
  it('enforces unique episode-message ordinals', () => {
    const t = createTestDb();
    t.db
      .prepare(
        "INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g1','G',1,1)",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO channels (id,workspace_id,kind,visibility_class,discovered_at_ms,updated_at_ms) VALUES ('ch','g1','text','org',1,1)",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO messages (id,workspace_id,channel_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms) VALUES ('m','g1','ch','a','',1,1,1)",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO episodes (id,workspace_id,conversation_channel_id,status,started_at_ms,last_activity_at_ms,created_at_ms,updated_at_ms) VALUES ('e1','g1','ch','open',1,1,1,1)",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO episode_messages (episode_id,message_id,ordinal) VALUES ('e1','m',1)",
      )
      .run();
    expect(() =>
      t.db
        .prepare(
          "INSERT INTO episode_messages (episode_id,message_id,ordinal) VALUES ('e1','m',1)",
        )
        .run(),
    ).toThrow();
    t.cleanup();
  });

  it('cascades memory evidence deletion when a memory is removed', () => {
    const t = createTestDb();
    t.db
      .prepare("INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g1','G',1,1)")
      .run();
    t.db
      .prepare(
        "INSERT INTO channels (id,workspace_id,kind,visibility_class,discovered_at_ms,updated_at_ms) VALUES ('ch','g1','text','org',1,1)",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO messages (id,workspace_id,channel_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms) VALUES ('m','g1','ch','a','x',1,1,1)",
      )
      .run();
    t.db
      .prepare(
        `INSERT INTO memories (id,workspace_id,scope_type,type,statement,confidence,importance,first_seen_at_ms,last_confirmed_at_ms,created_at_ms,updated_at_ms)
         VALUES ('mem1','g1','org','decision','decide',0.8,0.5,1,1,1,1)`,
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO memory_evidence (memory_id,message_id,stance,created_at_ms) VALUES ('mem1','m','origin',1)",
      )
      .run();
    t.db.prepare("DELETE FROM memories WHERE id = 'mem1'").run();
    const ev = t.db.prepare('SELECT count(*) AS n FROM memory_evidence WHERE memory_id = ?').get('mem1') as { n: number };
    expect(ev.n).toBe(0);
    t.cleanup();
  });
});

describe('operations migration integrity', () => {
  it('enforces direct-request identity and terminal outcome invariants', () => {
    const t = createTestDb();
    t.db.prepare(
      "INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-direct','G',1,1)",
    ).run();
    t.db.prepare(`INSERT INTO direct_answer_requests (
      source_message_id, workspace_id, target_channel_id, question_created_at_ms,
      deadline_at_ms, response_intent_key, created_at_ms, updated_at_ms
    ) VALUES ('m-direct-1','g-direct','c-direct',1,121000,'intent-direct-1',1,1)`).run();

    expect(() => t.db.prepare(`INSERT INTO direct_answer_requests (
      source_message_id, workspace_id, target_channel_id, question_created_at_ms,
      deadline_at_ms, response_intent_key, created_at_ms, updated_at_ms
    ) VALUES ('m-direct-2','g-direct','c-direct',2,121001,'intent-direct-1',2,2)`).run())
      .toThrow();
    expect(() => t.db.prepare(`UPDATE direct_answer_requests
      SET outcome_kind='fallback', reason_category='model_error', completed_at_ms=2
      WHERE source_message_id='m-direct-1'`).run()).toThrow();
    expect(() => t.db.prepare(`UPDATE direct_answer_requests
      SET outcome_kind='partial', reason_category='none', run_id=NULL,
          coverage_complete=1, completed_at_ms=2
      WHERE source_message_id='m-direct-1'`).run()).toThrow();

    t.db.prepare(`INSERT INTO channels (
      id, workspace_id, kind, visibility_class, discovered_at_ms, updated_at_ms
    ) VALUES ('c-direct','g-direct','text','org',1,1)`).run();
    t.db.prepare(`INSERT INTO agent_runs (
      id, workspace_id, run_type, prompt_version, provider, model, status, started_at_ms
    ) VALUES ('run-direct','g-direct','direct_answer','pv','faux','faux','completed',1)`).run();
    t.db.prepare(`INSERT INTO outbox (
      id, channel_id, content, dedupe_key, next_attempt_at_ms, created_at_ms, updated_at_ms
    ) VALUES ('out-direct','c-direct','reply','direct-intent',1,1,1)`).run();
    t.db.prepare(`INSERT INTO direct_answer_requests (
      source_message_id, run_id, outbox_id, workspace_id, target_channel_id,
      question_created_at_ms, deadline_at_ms, response_intent_key, outcome_kind,
      reason_category, created_at_ms, completed_at_ms, updated_at_ms
    ) VALUES (
      'm-direct-terminal','run-direct','out-direct','g-direct','c-direct',
      1,121000,'intent-direct-terminal','primary','none',1,2,2
    )`).run();
    expect(() => t.db.prepare("DELETE FROM outbox WHERE id='out-direct'").run()).toThrow();
    expect(() => t.db.prepare("DELETE FROM agent_runs WHERE id='run-direct'").run()).toThrow();
    t.cleanup();
  });

  it('enforces deep-recap bounds, terminal state, and one active request per target', () => {
    const t = createTestDb();
    t.db.prepare("INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g-recap','G',1,1)").run();
    t.db.prepare(`INSERT INTO channels
      (id,workspace_id,kind,visibility_class,discovered_at_ms,updated_at_ms)
      VALUES ('c-recap','g-recap','text','org',1,1)`).run();
    const insert = t.db.prepare(`INSERT INTO deep_recap_requests
      (id,workspace_id,target_channel_id,requested_by_user_id,after_at_ms,before_at_ms,
       budget_usd,created_at_ms,updated_at_ms)
      VALUES (?,'g-recap','c-recap','u',1,2,1,1,1)`);
    insert.run('recap-1');
    expect(() => insert.run('recap-2')).toThrow();
    expect(() => t.db.prepare("UPDATE deep_recap_requests SET status='completed' WHERE id='recap-1'").run())
      .toThrow();
    expect(() => t.db.prepare(`INSERT INTO deep_recap_chunks
      (request_id,ordinal,after_at_ms,before_at_ms,created_at_ms,updated_at_ms)
      VALUES ('recap-1',0,2,1,1,1)`).run()).toThrow();
    t.cleanup();
  });

  it('enforces active-job uniqueness on (type, unique_key)', () => {
    const t = createTestDb();
    const insert = t.db.prepare(
      "INSERT INTO jobs (id,type,unique_key,payload_json,run_after_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,1,1,1)",
    );
    insert.run('j1', 'episode_review', 'uk-1', '{}');
    expect(() => insert.run('j2', 'episode_review', 'uk-1', '{}')).toThrow();
    // A different unique_key, or a terminal status, is allowed.
    insert.run('j3', 'episode_review', 'uk-2', '{}');
    t.cleanup();
  });

  it('enforces outbox dedupe_key uniqueness', () => {
    const t = createTestDb();
    t.db
      .prepare(
        "INSERT INTO workspaces (id,name,discovered_at_ms,updated_at_ms) VALUES ('g1','G',1,1)",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO channels (id,workspace_id,kind,visibility_class,discovered_at_ms,updated_at_ms) VALUES ('ch','g1','text','org',1,1)",
      )
      .run();
    const insert = t.db.prepare(
      "INSERT INTO outbox (id,channel_id,content,dedupe_key,next_attempt_at_ms,created_at_ms,updated_at_ms) VALUES ('ch',?,'c',?,1,1,1)",
    );
    insert.run('ch', 'dk-1');
    expect(() => insert.run('ch', 'dk-1')).toThrow();
    t.cleanup();
  });
});
