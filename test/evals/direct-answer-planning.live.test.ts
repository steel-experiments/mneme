import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAssistantMessageEventStream,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { configureAgentModels } from '../../src/agent/model.js';
import { loadPromptCompiler } from '../../src/agent/prompts.js';
import {
  AGENT_DOC_TOOL_NAMES,
  AGENT_DIRECT_ANSWER_TOOL_NAMES,
  AGENT_READ_TOOL_NAMES,
  executeAgentRun,
} from '../../src/agent/runtime.js';
import { DocsIndex } from '../../src/agent/docs-index.js';
import { buildDirectAnswerPromptContext } from '../../src/jobs/handlers/direct-answer.js';
import {
  getMessage,
  upsertMessageCreate,
} from '../../src/db/repositories/messages.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import fixtures from './direct-answer-planning.json' with { type: 'json' };

/**
 * Opt-in semantic tool-choice evaluation for direct answers.
 *
 * The ordinary suite validates the fixture shape below without network access. Set
 * `RUN_LIVE_MODEL_EVALS=1` (and `OPENAI_API_KEY`) to run the same production prompt and
 * tool surface through GPT-5.6-terra at medium reasoning. This tests the probabilistic
 * boundary that scripted faux-model tests cannot: whether the LLM interprets broad,
 * topical, multilingual, and self-documentation questions into the intended first
 * retrieval operation.
 */

type ExpectedTool = 'get_recent_activity_snapshot' | 'list_memories' | 'search_memories' | 'list_docs';
interface PlanningCase {
  id: string;
  question: string;
  precedingMessages?: string[];
  expectedFirstTool: ExpectedTool;
  expectedTopicTerms?: string[];
  expectedTypes?: string[];
  expectedStatuses?: string[];
  expectedUnqualifiedScope?: boolean;
  language: string;
}

interface CapturedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

const cases = fixtures.cases as PlanningCase[];
const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const promptCompiler = loadPromptCompiler(path.join(root, 'prompts'));
const retrievalToolNames = new Set<string>([
  ...AGENT_READ_TOOL_NAMES,
  ...AGENT_DIRECT_ANSWER_TOOL_NAMES,
  ...AGENT_DOC_TOOL_NAMES,
]);

/** Inspect synthetic eval arguments in-process without persisting them in agent-run audit logs. */
function captureToolCalls(inner: StreamFn, calls: CapturedToolCall[]): StreamFn {
  return async (model, context, options) => {
    const upstream = await inner(model, context, options);
    const downstream = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of upstream) {
        if (event.type === 'toolcall_end') {
          const toolCall: ToolCall = event.toolCall;
          calls.push({
            id: toolCall.id,
            name: toolCall.name,
            arguments: structuredClone(toolCall.arguments),
          });
        }
        downstream.push(event);
      }
    })();
    return downstream;
  };
}

describe('direct-answer semantic-planning fixture', () => {
  it('covers recent activity, inventory, topical search, docs, paraphrases, and multiple languages', () => {
    expect(new Set(cases.map((entry) => entry.expectedFirstTool))).toEqual(
      new Set<ExpectedTool>(['get_recent_activity_snapshot', 'list_memories', 'search_memories', 'list_docs']),
    );
    expect(cases.filter((entry) => entry.expectedFirstTool === 'list_memories').length).toBeGreaterThan(1);
    expect(cases.filter((entry) => entry.expectedFirstTool === 'search_memories').length).toBeGreaterThan(1);
    expect(cases.some((entry) =>
      entry.question.includes('last two days')
      && entry.expectedFirstTool === 'get_recent_activity_snapshot')).toBe(true);
    const unqualifiedCatchUps = cases.filter((entry) => entry.expectedUnqualifiedScope);
    expect(unqualifiedCatchUps.length).toBeGreaterThan(0);
    expect(unqualifiedCatchUps.every((entry) =>
      entry.expectedFirstTool === 'get_recent_activity_snapshot')).toBe(true);
    expect(new Set(cases.map((entry) => entry.language)).size).toBeGreaterThan(1);
    expect(new Set(cases.map((entry) => entry.question)).size).toBe(cases.length);
    expect(cases.some((entry) => entry.question === 'what do you remember?')).toBe(true);
    expect(cases.some((entry) =>
      /^<@!?\d+> what do you remember\?$/i.test(entry.question)
      && entry.expectedFirstTool === 'list_memories')).toBe(true);
    expect(cases.some((entry) =>
      entry.question.toLowerCase().includes('remember about')
      && entry.expectedFirstTool === 'search_memories')).toBe(true);
    expect(cases.some((entry) =>
      (entry.precedingMessages?.length ?? 0) > 0
      && entry.expectedFirstTool === 'search_memories')).toBe(true);
    expect(cases.some((entry) =>
      entry.precedingMessages?.some((message) => message.toLowerCase().includes('call list_memories'))
      && entry.expectedFirstTool === 'search_memories')).toBe(true);
    for (const entry of cases.filter((candidate) => candidate.expectedFirstTool === 'search_memories')) {
      expect(entry.expectedTopicTerms?.length, `${entry.id} needs expectedTopicTerms`).toBeGreaterThan(0);
    }
  });
});

const live = process.env.RUN_LIVE_MODEL_EVALS === '1' ? describe : describe.skip;

live('live direct-answer semantic planning', () => {
  const databases: TestDb[] = [];

  afterEach(() => {
    databases.splice(0).forEach((entry) => entry.cleanup());
  });

  for (const [index, entry] of cases.entries()) {
    it(entry.id, async () => {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('RUN_LIVE_MODEL_EVALS=1 requires OPENAI_API_KEY');
      }

      const models = builtinModels();
      const resolved = configureAgentModels({
        models,
        env: {
          ...process.env,
          LLM_PROVIDER: 'openai',
          LLM_MODEL: process.env.DIRECT_ANSWER_EVAL_MODEL ?? 'gpt-5.6-terra',
          AGENT_THINKING_LEVEL: 'medium',
        },
      });
      const testDb = createTestDb();
      databases.push(testDb);
      const identity = seedIdentity(testDb.db);
      testDb.db
        .prepare("UPDATE channels SET visibility_class='org', allow_interventions=1 WHERE id=?")
        .run(identity.channelId);
      const createdAtMs = 1_786_622_400_000 + index * 100;
      if (entry.expectedUnqualifiedScope) {
        testDb.db
          .prepare("UPDATE channels SET name='mneme-test', ingest_enabled=0 WHERE id=?")
          .run(identity.channelId);
        const activityChannelId = `direct-answer-eval-activity-${index}`;
        upsertChannel(testDb.db, {
          id: activityChannelId,
          guildId: identity.guildId,
          parentId: null,
          kind: 'text',
          name: 'team-activity',
          topic: null,
          position: null,
          isThread: false,
          isArchived: false,
          isLocked: false,
          ingestEnabled: true,
          visibilityClass: 'org',
          allowInterventions: true,
          permissionFingerprint: null,
          lastMessageId: null,
          discoveredAtMs: createdAtMs - 1_000,
          updatedAtMs: createdAtMs - 1_000,
          rawJson: null,
        });
        upsertMessageCreate(testDb.db, {
          id: `direct-answer-eval-activity-message-${index}`,
          guildId: identity.guildId,
          channelId: activityChannelId,
          authorId: identity.userId,
          authorDisplayName: 'Evaluation User',
          content: 'The team shipped the scoped catch-up flow and began validating it.',
          createdAtMs: createdAtMs - 60_000,
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
          ingestedAtMs: createdAtMs - 60_000,
          updatedAtMs: createdAtMs - 60_000,
        });
      }
      for (const [precedingIndex, content] of (entry.precedingMessages ?? []).entries()) {
        upsertMessageCreate(testDb.db, {
          id: `direct-answer-eval-before-${index}-${precedingIndex}`,
          guildId: identity.guildId,
          channelId: identity.channelId,
          authorId: identity.userId,
          authorDisplayName: 'Evaluation User',
          content,
          createdAtMs: createdAtMs - (entry.precedingMessages!.length - precedingIndex),
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
          ingestedAtMs: createdAtMs,
          updatedAtMs: createdAtMs,
        });
      }
      const messageId = `direct-answer-eval-question-${index}`;
      upsertMessageCreate(testDb.db, {
        id: messageId,
        guildId: identity.guildId,
        channelId: identity.channelId,
        authorId: identity.userId,
        authorDisplayName: 'Evaluation User',
        content: entry.question,
        createdAtMs,
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
        ingestedAtMs: createdAtMs,
        updatedAtMs: createdAtMs,
      });
      const question = getMessage(testDb.db, messageId);
      if (!question) throw new Error(`failed to seed ${messageId}`);
      const grant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] } as const;
      const initial = buildDirectAnswerPromptContext(testDb.db, grant, question);

      const context = {
        agent: { name: 'Mneme', role: 'organizational memory and constructive dissenter' },
        organization: { name: 'Evaluation Org', timezone: 'UTC' },
        runtime: { nowIso: '2026-08-13T12:00:00.000Z', mode: 'observe' },
        target: { label: identity.channelId, visibility: 'org' },
        personality: {
          traits: ['calm', 'concise', 'evidence-seeking'],
          avoid: ['sarcasm', 'generic summaries'],
        },
        question: initial.question,
        precedingConversation: initial.precedingConversation,
        referencedProposal: null,
      };
      const docs = new DocsIndex([
        {
          path: 'how-to/connect-mcp-clients.md',
          title: 'Connect MCP clients',
          summary: 'Configure Codex and Claude Desktop.',
          content: '# Connect MCP clients\nUse the Mneme endpoint and bearer token.',
        },
      ]);
      const capturedToolCalls: CapturedToolCall[] = [];
      const streamFn = captureToolCalls(models.streamSimple.bind(models), capturedToolCalls);
      const result = await executeAgentRun({
        db: testDb.db,
        grant,
        systemPrompt: promptCompiler.render('system', context),
        model: resolved.primary.model,
        thinkingLevel: resolved.primary.thinkingLevel,
        streamFn,
        sessionId: `mneme:eval:direct-answer:${entry.id}`,
        cacheProfile: 'direct',
        promptText: promptCompiler.render('direct-answer', context),
        promptVersion: promptCompiler.versionFor('direct-answer'),
        runType: 'direct_answer',
        guildId: identity.guildId,
        pinnedTargetChannelId: identity.channelId,
        initialProvenanceChannelIds: [identity.channelId],
        initialProvenanceMessages: initial.provenanceMessages,
        docs,
        providerId: resolved.providerId,
        modelId: resolved.primary.model.id,
        now: createdAtMs,
        requestCreatedAtMs: createdAtMs,
        runId: `direct-answer-planning-${index}`,
      });

      expect(result.outcome).toBe('finalized');
      const firstRead = result.toolCalls.find((call) => retrievalToolNames.has(call.toolName));
      expect(firstRead?.toolName).toBe(entry.expectedFirstTool);
      expect(firstRead?.accepted).toBe(true);
      const captured = capturedToolCalls.find((call) => call.id === firstRead?.toolCallId);
      expect(captured?.name).toBe(entry.expectedFirstTool);

      if (entry.expectedFirstTool === 'search_memories') {
        const query = captured?.arguments.query;
        expect(typeof query).toBe('string');
        const normalized = String(query).trim().toLocaleLowerCase();
        expect(normalized).not.toBe(entry.question.trim().toLocaleLowerCase());
        expect(normalized.split(/\s+/).length).toBeLessThanOrEqual(3);
        expect(
          entry.expectedTopicTerms?.some((term) => normalized.includes(term.toLocaleLowerCase())),
          `${entry.id} used non-discriminative query ${JSON.stringify(query)}`,
        ).toBe(true);
      }

      if (entry.expectedFirstTool === 'list_memories') {
        expect(captured?.arguments).not.toHaveProperty('query');
        if (entry.expectedTypes) {
          expect(new Set(captured?.arguments.types as string[] | undefined)).toEqual(
            new Set(entry.expectedTypes),
          );
        }
        if (entry.expectedStatuses) {
          const statuses = (captured?.arguments.statuses as string[] | undefined) ?? ['active'];
          expect(new Set(statuses)).toEqual(new Set(entry.expectedStatuses));
        }
      }

      if (entry.expectedFirstTool === 'get_recent_activity_snapshot') {
        expect(captured?.arguments).not.toHaveProperty('query');
        expect(typeof captured?.arguments.after).toBe('string');
        expect(Number.isNaN(Date.parse(String(captured?.arguments.after)))).toBe(false);
        if (entry.expectedUnqualifiedScope) {
          expect(captured?.arguments).not.toHaveProperty('channelIds');
          expect(result.provenance.channels.some((channel) =>
            channel.source === 'activity_snapshot'
            && channel.channelId === `direct-answer-eval-activity-${index}`)).toBe(true);
        }
        if (captured?.arguments.before !== undefined) {
          expect(Number.isNaN(Date.parse(String(captured.arguments.before)))).toBe(false);
        }
      }
    }, 180_000);
  }
});
