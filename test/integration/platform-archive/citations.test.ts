// ABOUTME: Tests archive citations in direct answers (plan 011 step 7): only exposed, still servable archive ids get host-built links.
// ABOUTME: Archive links come from the archive platform's builder; model-authored platform URLs stay rejected.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createTestDb, seedIdentity, type TestDb } from '../../helpers/db.js';
import { upsertChannel, type VisibilityClass } from '../../../src/db/repositories/channels.js';
import { upsertMessageCreate } from '../../../src/db/repositories/messages.js';
import {
  createDirectAnswerHandler,
  type DirectAnswerChannelScope,
  type DirectAnswerProposal,
} from '../../../src/jobs/handlers/direct-answer.js';
import type { AgentRunResult, ExecuteAgentRunDeps } from '../../../src/agent/runtime.js';
import type { PromptCompiler } from '../../../src/agent/prompts.js';
import { fingerprintExposedMessage } from '../../../src/agent/run-context.js';
import { emptyAgentRunUsage } from '../../../src/agent/usage.js';
import { discordFormat } from '../../../src/platform/discord/format.js';
import { slackFormat } from '../../../src/platform/slack/format.js';
import { openArchiveDatabase, verifyArchive } from '../../../src/platform-archive/database.js';
import { createArchiveReader, type ArchiveReader } from '../../../src/platform-archive/read.js';
import type { PlatformFormat } from '../../../src/platform/types.js';
import {
  ARCHIVE_CHANNELS,
  ARCHIVE_GUILD,
  ARCHIVE_MESSAGES,
  createArchiveFixture,
  type ArchiveFixture,
} from '../../helpers/archive.js';

const NOW = 1_700_000_001_000;
const ORG_CHANNEL = '100000000000000010';
const ARCHIVE_ORG = `archive:${ARCHIVE_MESSAGES.org}`;
const ARCHIVE_RESTRICTED = `archive:${ARCHIVE_MESSAGES.restricted}`;
const ARCHIVE_URL = `https://discord.com/channels/${ARCHIVE_GUILD}/${ARCHIVE_CHANNELS.org}/${ARCHIVE_MESSAGES.org}`;

type Env = TestDb & { guildId: string; userId: string };
let env: Env;
let fixture: ArchiveFixture | undefined;
let archiveDb: DatabaseSync | undefined;
let reader: ArchiveReader;

beforeEach(() => {
  const base = createTestDb();
  env = { ...base, ...seedIdentity(base.db) };
  upsertChannel(env.db, {
    id: ORG_CHANNEL, guildId: env.guildId, parentId: null, kind: 'text', name: 'general', topic: null,
    position: 0, isThread: false, isArchived: false, isLocked: false, ingestEnabled: true,
    visibilityClass: 'org', allowInterventions: true, permissionFingerprint: null, lastMessageId: null,
    discoveredAtMs: NOW, updatedAtMs: NOW, rawJson: null,
  });
  fixture = createArchiveFixture();
  archiveDb = openArchiveDatabase(fixture.path);
  const summary = verifyArchive(archiveDb, fixture.path, { platform: 'discord', newestSchemaVersion: 1_000 });
  reader = createArchiveReader({ db: archiveDb, liveDb: env.db, summary });
});

afterEach(() => {
  try { archiveDb?.close(); } catch { /* already closed */ }
  fixture?.cleanup();
  env.cleanup();
});

function seedMessage(id: string, content: string): string {
  upsertMessageCreate(env.db, {
    id, guildId: env.guildId, channelId: ORG_CHANNEL, authorId: env.userId, authorDisplayName: 'Alice', content,
    createdAtMs: NOW, editedAtMs: null, replyToMessageId: null, messageType: 0, flags: null, pinned: false,
    mentionEveryone: false, mentionsJson: '[]', embedsJson: '[]', componentsJson: '[]', pollJson: null,
    rawJson: null, ingestedAtMs: NOW, updatedAtMs: NOW,
  });
  return id;
}

function redactArchiveMessage(messageId: string): void {
  env.db.prepare(
    `INSERT INTO archive_redactions (id, archive_workspace_id, target_kind, target_id, archive_sha256, created_at_ms)
     VALUES (?, ?, 'message', ?, 'sha', ?)`,
  ).run(`redaction-${messageId}`, ARCHIVE_GUILD, messageId, NOW);
}

/** A run that exposes the question, the given live messages, and the given archive ids. */
function fakeRun(proposal: DirectAnswerProposal, exposed: { live?: string[]; archive?: string[] }) {
  return async (deps: ExecuteAgentRunDeps): Promise<AgentRunResult> => {
    deps.db.prepare(
      `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
       VALUES ('run-archive', ?, NULL, 'direct_answer', 'pv', 'faux', 'faux-1', 'completed', ?)`,
    ).run(deps.guildId, NOW);
    const messageIds = [...new Set([...(deps.initialProvenanceMessages ?? []).map((m) => m.messageId), ...(exposed.live ?? [])])];
    return {
      runId: 'run-archive', status: 'completed', outcome: 'finalized', failureReason: null, turns: 1,
      modelTurns: [], toolCalls: [], usage: emptyAgentRunUsage(),
      provenance: {
        channels: [{ channelId: ORG_CHANNEL, source: 'initial_payload' as const }],
        messageIds,
        messageFingerprints: messageIds.flatMap((messageId) => {
          const fingerprint = deps.initialProvenanceMessages?.find((m) => m.messageId === messageId)?.fingerprint
            ?? fingerprintExposedMessage(deps.db, messageId);
          return fingerprint ? [{ messageId, fingerprint }] : [];
        }),
        memoryScopes: [], memoryIds: [], memoryFingerprints: [], charsExposed: 0, charBudget: 0,
        ...(exposed.archive?.length ? { archiveIds: exposed.archive } : {}),
      },
      finalProposal: { kind: 'direct_answer', proposal },
      startedAtMs: NOW, endedAtMs: NOW,
    };
  };
}

const orgScope: DirectAnswerChannelScope = {
  grant: { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [ORG_CHANNEL] },
  target: { channelId: ORG_CHANNEL, visibility: 'org' as VisibilityClass, isSecureReview: false },
};

async function answer(
  proposal: Omit<DirectAnswerProposal, 'targetChannelId'>,
  exposed: { live?: string[]; archive?: string[] },
  options: { archive?: ArchiveReader | null; format?: PlatformFormat } = {},
): Promise<{ kind: string; content: string | null; reasons: string[] }> {
  const question = seedMessage('msg-question', '<@mneme> what did we decide about billing?');
  const reasons: string[] = [];
  const handler = createDirectAnswerHandler({
    format: options.format ?? discordFormat,
    db: env.db,
    guildId: env.guildId,
    promptCompiler: { render: () => '', versionFor: () => 'pv' } as unknown as PromptCompiler,
    systemPrompt: '',
    mode: 'autonomous',
    resolveChannelScope: () => orgScope,
    rateChecks: () => ({ cooldown: { allowed: true, blocks: [], retryAfterMs: null }, duplicate: { matched: false } }),
    executeRun: fakeRun({ targetChannelId: ORG_CHANNEL, ...proposal }, exposed),
    now: () => NOW,
    ...(options.archive === null ? {} : { archive: options.archive ?? reader }),
    logger: {
      info: (fields: unknown) => {
        const r = (fields as { reasons?: unknown }).reasons;
        if (Array.isArray(r)) reasons.push(...r.map(String));
      },
      warn: () => undefined,
    },
  });
  const res = await handler.runDirectAnswer(question, ORG_CHANNEL);
  const row = env.db.prepare("SELECT content FROM outbox WHERE content NOT LIKE '%could not%'").get() as
    | { content: string } | undefined;
  return { kind: res.kind, content: res.kind === 'answered' ? row?.content ?? null : null, reasons };
}

describe('archive citations in direct answers', () => {
  it('renders a live and an archive citation with the right hosts and an archive label', async () => {
    const live = seedMessage('msg-live-billing', 'billing moved to Postgres this week');
    const res = await answer({
      message: `Billing moved to Postgres [[cite:${live}]], as decided earlier [[cite:${ARCHIVE_ORG}]].`,
      citedMessageIds: [live, ARCHIVE_ORG],
    }, { live: [live], archive: [ARCHIVE_ORG] });
    expect(res.kind).toBe('answered');
    expect(res.content).toContain(`https://discord.com/channels/${env.guildId}/${ORG_CHANNEL}/${live}`);
    expect(res.content).toContain(`(${ARCHIVE_URL})`);
    expect(res.content).toMatch(/\[archive · #general · \d{4}-\d{2}-\d{2}\]\(/u);
    expect(res.content).not.toContain('[[cite:');
  });

  it('rejects an archive id that this run did not receive from an archive tool', async () => {
    const res = await answer({
      message: `As decided earlier [[cite:${ARCHIVE_ORG}]].`,
      citedMessageIds: [ARCHIVE_ORG],
    }, { archive: [] });
    expect(res.kind).not.toBe('answered');
    expect(res.reasons.join('\n')).toContain(`cited archive message "${ARCHIVE_ORG}" was not exposed to this run`);
  });

  it('rejects an exposed archive id that was redacted before the answer was sent', async () => {
    redactArchiveMessage(ARCHIVE_MESSAGES.org);
    const res = await answer({
      message: `As decided earlier [[cite:${ARCHIVE_ORG}]].`,
      citedMessageIds: [ARCHIVE_ORG],
    }, { archive: [ARCHIVE_ORG] });
    expect(res.kind).not.toBe('answered');
    expect(res.reasons.join('\n')).toContain(`cited archive message "${ARCHIVE_ORG}" is no longer servable`);
  });

  it('rejects an archive id for content that is not org, even when the provenance names it', async () => {
    const res = await answer({
      message: `Leadership said so [[cite:${ARCHIVE_RESTRICTED}]].`,
      citedMessageIds: [ARCHIVE_RESTRICTED],
    }, { archive: [ARCHIVE_RESTRICTED] });
    expect(res.kind).not.toBe('answered');
    expect(res.reasons.join('\n')).toContain('is no longer servable');
    expect(res.content).toBeNull();
  });

  it('rejects an archive citation when the deployment has no archive', async () => {
    const res = await answer({
      message: `As decided earlier [[cite:${ARCHIVE_ORG}]].`,
      citedMessageIds: [ARCHIVE_ORG],
    }, { archive: [ARCHIVE_ORG] }, { archive: null });
    expect(res.kind).not.toBe('answered');
    expect(res.reasons.join('\n')).toContain('archive citations are not allowed in this message');
  });

  it('still rejects a model-authored discord.com link on a Slack deployment', async () => {
    const res = await answer({
      message: `See ${ARCHIVE_URL} for the decision.`,
      citedMessageIds: [],
    }, { archive: [ARCHIVE_ORG] }, { format: slackFormat });
    expect(res.kind).not.toBe('answered');
    expect(res.reasons.join('\n')).toContain('untrusted Discord source link');
  });
});
