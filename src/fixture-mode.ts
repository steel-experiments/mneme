/**
 * Phase 0 fixture-mode entry point (Section 47 Phase 0; task T123).
 *
 * Runs the full review path **with no Discord connection** against synthetic
 * data, validating schema, prompts, the review pipeline, privacy scoping, and
 * online backup. It is the offline baseline before any production login.
 *
 * Hard safety guard: fixture mode must never use production Discord credentials.
 * This module never imports `discord.js` or the gateway, so it is structurally
 * incapable of reaching Discord; additionally the CLI entry point refuses to
 * start when `DISCORD_TOKEN` is set, so it cannot be run by accident in a
 * production environment.
 *
 * Run: `node src/fixture-mode.ts` (Node 24 type-strips the source). Emits a JSON
 * report on stdout and exits 0 only if every check passes.
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase, type DatabaseSync } from './db/database.js';
import { applyMigrations } from './db/migrations.js';
import { upsertMessageCreate } from './db/repositories/messages.js';
import { upsertUser } from './db/repositories/users.js';
import { searchMessages, type RetrievalGrant } from './db/repositories/message-search.js';
import { openEpisode, extendEpisode, closeEpisode } from './episodes/repository.js';
import { loadPromptCompiler, type PromptCompiler } from './agent/prompts.js';
import { fauxProvider, createModels, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import {
  createReviewEpisodeHandler,
  type ReviewEpisodeHandlerDeps,
  type ReviewEpisodeOutcome,
  type AgentRuntimeInputs,
} from './jobs/handlers/review-episode.js';
import { createBackup, integrityCheck } from './db/backup.js';

const REPO_MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const REPO_PROMPTS = fileURLToPath(new URL('../prompts/', import.meta.url));

/** Synthetic fixture identities (all clearly non-production snowflakes). */
const GUILD = '900000000000000001';
const ORG_CHANNEL = '900000000000000002'; // visibility: org
const RESTRICTED_CHANNEL = '900000000000000003'; // visibility: restricted
const HUMAN = '900000000000000010';
const CASS = '900000000000000099';
/** Distinctive single-token canary that FTS5/unicode61 indexes as one token. */
const CANARY = 'deltarestrictedcanary';

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };

export interface FixtureReport {
  ok: boolean;
  mode: 'fixture';
  guildId: string;
  episodeId: string;
  review: { kind: ReviewEpisodeOutcome['kind'] };
  promptVersion: string | null;
  schemaVersion: number | null;
  privacy: {
    /** The restricted canary must NOT surface to an org-scoped retrieval. */
    canaryLeakedToOrg: boolean;
    /** Org conversation content must be visible to an org-scoped retrieval. */
    orgContentVisible: boolean;
    /** The canary is stored (proves scoping, not absence, enforces privacy). */
    canaryStored: boolean;
  };
  backup: { integrity: string; sha256: string; bytes: number };
}

export interface FixtureModeOptions {
  /** Override the migrations directory (default: the repo migrations). */
  migrationsDir?: string;
  /** Override the prompts directory (default: the repo prompts). */
  promptDir?: string;
  /** Injectable clock for deterministic output (default: a fixed timestamp). */
  now?: () => number;
  /** Application version recorded in the backup manifest. */
  appVersion?: string;
}

/**
 * Seed the synthetic guild: one org channel, one restricted channel, a human,
 * and Mneme. Mirrors the FK-safe scaffolding the repository tests use.
 */
function seedFixture(db: DatabaseSync, now: number): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, owner_id, joined_at_ms, discovered_at_ms, updated_at_ms, raw_json) VALUES (?,?,?,?,?,?,NULL)',
  ).run(GUILD, 'Fixture Guild', null, now, now, now);

  const channelSql = `INSERT INTO channels (id, workspace_id, parent_id, kind, name, topic, position, is_thread, is_archived, is_locked,
      ingest_enabled, visibility_class, allow_interventions, permission_fingerprint, last_message_id,
      discovered_at_ms, updated_at_ms, deleted_at_ms, raw_json)
    VALUES (?, ?, NULL, 'text', ?, NULL, NULL, 0, 0, 0, 1, ?, 1, NULL, NULL, ?, ?, NULL, NULL)`;
  db.prepare(channelSql).run(ORG_CHANNEL, GUILD, 'general', 'org', now, now);
  db.prepare(channelSql).run(RESTRICTED_CHANNEL, GUILD, 'confidential', 'restricted', now, now);

  upsertUser(db, {
    id: HUMAN,
    username: 'alice',
    globalName: 'Alice',
    isBot: false,
    firstSeenAtMs: now,
    lastSeenAtMs: now,
    rawJson: null,
  });
  upsertUser(db, {
    id: CASS,
    username: 'mneme',
    globalName: 'Mneme',
    isBot: true,
    firstSeenAtMs: now,
    lastSeenAtMs: now,
    rawJson: null,
  });
}

/** Ingest one message into `channel`. */
function ingestMessage(
  db: DatabaseSync,
  id: string,
  channelId: string,
  content: string,
  now: number,
): void {
  upsertMessageCreate(db, {
    id,
    guildId: GUILD,
    channelId,
    authorId: HUMAN,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: now,
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
    ingestedAtMs: now,
    updatedAtMs: now,
  });
}

/**
 * A no-network faux model that drives the **real** agent runtime (Section 21).
 * It scripts a one-call retrieval (`search_messages`) followed by a
 * `finalize_episode_review` whose proposal cites seeded org-visible evidence and
 * targets the pinned org channel. This exercises the genuine review path —
 * prompt render, scoped retrieval, evidence validation, and run persistence —
 * without any Discord or model-provider network call.
 */
function buildFauxAgent(): { agent: AgentRuntimeInputs; prime: () => void } {
  const handle = fauxProvider({ models: [{ id: 'faux-1' }] });
  const models = createModels();
  models.setProvider(handle.provider);
  const proposal = {
    episodeSummary: 'We decided to adopt the onboarding trial.',
    consequential: true,
    memoryProposals: [
      {
        action: 'create',
        type: 'decision',
        statement: 'Adopt the onboarding trial.',
        confidence: 0.8,
        importance: 0.7,
        evidenceMessageIds: ['m1'],
        evidenceQuotes: [{ messageId: 'm1', quote: 'onboarding trial' }],
        durability: 'project',
        durabilityReason: 'This changes future onboarding work.',
      },
    ],
    intervention: {
      recommend: false,
      reason: 'nothing urgent',
      dimensions: {
        impact: 0.5,
        evidenceStrength: 0.5,
        contradictionStrength: 0.5,
        urgency: 0.5,
        novelty: 0.5,
        interruptionCost: 0.5,
      },
      confidence: 0.5,
      urgency: 'normal',
      targetChannelId: ORG_CHANNEL,
      evidenceMessageIds: ['m1'],
    },
    unresolvedQuestions: [],
  };
  const prime = () =>
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('search_messages', { query: 'onboarding' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('finalize_episode_review', proposal)], {
        stopReason: 'toolUse',
      }),
    ]);
  return {
    agent: {
      model: handle.getModel(),
      thinkingLevel: 'minimal',
      streamFn: models.streamSimple.bind(models),
      providerId: 'faux',
      modelId: 'faux-1',
    },
    prime,
  };
}

/**
 * Run Phase 0 fixture mode against a fresh temp database. Returns the report;
 * never reaches Discord. Caller decides the exit code from `report.ok`.
 */
export async function runFixtureMode(options: FixtureModeOptions = {}): Promise<FixtureReport> {
  const nowFn = options.now ?? (() => 1_700_000_001_000);
  const now = nowFn();
  const dir = mkdtempSync(join(tmpdir(), 'mneme-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  const backupsDir = join(dir, 'backups');
  mkdirSync(backupsDir, { recursive: true });

  let db: DatabaseSync | undefined;
  try {
    // Schema: open + migrate a real file DB (WAL and backup require a file).
    db = openDatabase(dbPath);
    applyMigrations(db, options.migrationsDir ?? REPO_MIGRATIONS);

    // Prompts + policy: compile the real prompt set (validates templates).
    const compiler: PromptCompiler = loadPromptCompiler(options.promptDir ?? REPO_PROMPTS);

    seedFixture(db, now);

    // Replay a synthetic org conversation and a restricted canary. The
    // conversation ends well before the review so it is settled under the
    // Section 11.8 gate, exactly as a real review sees it.
    const spokeAt = now - 30 * 60_000;
    ingestMessage(db, 'm1', ORG_CHANNEL, 'we decided to adopt the onboarding trial', spokeAt);
    ingestMessage(db, 'm2', ORG_CHANNEL, 'agreed, ship it on friday', spokeAt + 1);
    ingestMessage(db, 'mr', RESTRICTED_CHANNEL, `the ${CANARY} merger is confidential`, spokeAt + 2);

    const { episode } = openEpisode(db, {
      guildId: GUILD,
      conversationChannelId: ORG_CHANNEL,
      now: spokeAt,
    });
    extendEpisode(db, episode.id, 'm1', true, spokeAt);
    extendEpisode(db, episode.id, 'm2', true, spokeAt + 1);
    const episodeId = closeEpisode(db, ORG_CHANNEL, spokeAt + 2);
    if (!episodeId) throw new Error('fixture-mode: closeEpisode produced no episode');

    // Full review path, offline: pre-filter → transcript → prompt → real agent
    // runtime driven by a scripted faux model (no network) → persist.
    const { agent, prime } = buildFauxAgent();
    prime();
    const deps: ReviewEpisodeHandlerDeps = {
      db,
      guildId: GUILD,
      mnemeId: CASS,
      promptCompiler: compiler,
      systemPrompt: 'Mneme system prompt (fixture mode).',
      resolveChannelScope: () => ({
        grant: ORG_GRANT,
        target: { label: '#general', visibility: 'org' },
      }),
      runtimeCounters: () => ({ recentChannelPosts: 0, globalPostsToday: 0 }),
      mode: 'passive',
      interventionThreshold: 0.6,
      now: () => now,
      agent,
    };
    const handler = createReviewEpisodeHandler(deps);
    const review = await handler.runReview(episodeId);

    // Prompt version is stored on the run row (Section 48: per-run version).
    const runRow = db
      .prepare('SELECT prompt_version AS v FROM agent_runs WHERE episode_id = ? ORDER BY started_at_ms')
      .get(episodeId) as { v: string | null } | undefined;
    const promptVersion = runRow?.v ?? null;

    // Privacy: scoped retrieval must keep the restricted canary out of org scope.
    const orgCanary = searchMessages(db, ORG_GRANT, { query: CANARY, now });
    const orgContent = searchMessages(db, ORG_GRANT, { query: 'onboarding', now });
    const restrictedGrant: RetrievalGrant = {
      includeOrgMessages: false, includeOrgMemories: false,
      includeReviewOnly: false,
      channelIds: [RESTRICTED_CHANNEL],
    };
    const restrictedCanary = searchMessages(db, restrictedGrant, { query: CANARY, now });

    // Backup: online snapshot + restore-time integrity check (Section 42).
    const backup = await createBackup({
      db,
      backupsDir,
      sourceDatabasePath: dbPath,
      appVersion: options.appVersion ?? 'fixture-mode',
      now,
    });
    const backupIntegrity = integrityCheck(backup.backupPath);

    const canaryLeakedToOrg = orgCanary.length > 0;
    const orgContentVisible = orgContent.length > 0;
    const canaryStored = restrictedCanary.length > 0;
    const reviewOk = review.kind === 'reviewed';

    return {
      ok: reviewOk && !canaryLeakedToOrg && orgContentVisible && canaryStored && backupIntegrity === 'ok',
      mode: 'fixture',
      guildId: GUILD,
      episodeId,
      review: { kind: review.kind },
      promptVersion,
      schemaVersion: backup.manifest.schemaVersion,
      privacy: { canaryLeakedToOrg, orgContentVisible, canaryStored },
      backup: { integrity: backupIntegrity, sha256: backup.manifest.sha256, bytes: backup.manifest.bytes },
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** True when this module is the entry point (not imported by a test). */
function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(argv1).href);
  } catch {
    return false;
  }
}

/** Platform credentials that fixture mode refuses to run with. */
const PLATFORM_CREDENTIALS = [
  { name: 'DISCORD_TOKEN', platform: 'Discord' },
  { name: 'SLACK_BOT_TOKEN', platform: 'Slack' },
  { name: 'SLACK_APP_TOKEN', platform: 'Slack' },
] as const;

/**
 * Hard guard: fixture mode must never run where production Discord or Slack
 * credentials are present. Throws (rather than exiting) so the check is
 * unit-testable; {@link main} turns the throw into a stderr message and a
 * non-zero exit.
 */
export function assertFixtureModeSafe(env: NodeJS.ProcessEnv = process.env): void {
  for (const { name, platform } of PLATFORM_CREDENTIALS) {
    const value = env[name];
    if (value && value.trim() !== '') {
      throw new Error(
        `fixture-mode: refusing to start because ${name} is set. ` +
          'Fixture mode replays synthetic data offline and must not run with ' +
          `production ${platform} credentials.`,
      );
    }
  }
}

async function main(): Promise<void> {
  try {
    assertFixtureModeSafe();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const report = await runFixtureMode();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

void (isMain() ? main() : Promise.resolve());
