import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { resolveScheduledFeedback } from '../../src/memory/scheduled-feedback.js';

const NOW = 1_700_000_000_000;
const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002';
const HUMAN = '100000000000000003';
const BOT = '100000000000000004';
let env: TestDb;

function seed() {
  env.db.prepare('UPDATE channels SET visibility_class=\'org\',allow_interventions=1 WHERE id=?').run(CHANNEL);
  env.db.prepare(`INSERT INTO users
    (id,username,global_name,is_bot,first_seen_at_ms,last_seen_at_ms)
    VALUES (?,?,?,1,?,?)`).run(BOT, 'mneme', 'Mneme', NOW, NOW);
  env.db.prepare(`INSERT INTO messages
    (id,workspace_id,channel_id,author_id,author_display_name,content,created_at_ms,ingested_at_ms,updated_at_ms)
    VALUES ('origin',?,?,?,?,?,?,?,?)`).run(GUILD, CHANNEL, HUMAN, 'Human', 'Original decision', NOW - 10, NOW, NOW);
  env.db.prepare(`INSERT INTO memories
    (id,workspace_id,scope_type,type,statement,status,confidence,importance,review_after_ms,
     first_seen_at_ms,last_confirmed_at_ms,created_at_ms,updated_at_ms)
    VALUES ('memory',?,'org','decision','Original decision','active',.9,.9,?,?,?,?,?)`)
    .run(GUILD, NOW - 1, NOW - 10, NOW - 10, NOW - 10, NOW - 10);
  env.db.prepare(`INSERT INTO memory_evidence
    (memory_id,message_id,stance,weight,created_at_ms) VALUES ('memory','origin','origin',1,?)`).run(NOW);
  const provenance = JSON.stringify({
    channels: [{ channelId: CHANNEL, source: 'initial' }],
    memoryScopes: [{ scopeType: 'org', scopeKey: null, source: 'initial' }],
    messageIds: ['origin'],
    memoryIds: ['memory'],
  });
  env.db.prepare(`INSERT INTO agent_runs
    (id,workspace_id,run_type,prompt_version,provider,model,status,started_at_ms,retrieval_provenance_json)
    VALUES ('run',?,'scheduled_review','v','test','test','completed',?,?)`).run(GUILD, NOW, provenance);
  env.db.prepare(`INSERT INTO proposals
    (id,run_id,target_channel_id,status,computed_score,reason,message,evidence_message_ids_json,
     created_at_ms,updated_at_ms)
    VALUES ('proposal','run',?,'sent',1,'[]','Please confirm status.','["origin"]',?,?)`)
    .run(CHANNEL, NOW, NOW);
  env.db.prepare(`INSERT INTO scheduled_proposal_subjects
    (proposal_id,memory_id,memory_fingerprint,created_at_ms) VALUES ('proposal','memory','snapshot',?)`).run(NOW);
  env.db.prepare(`INSERT INTO outbox
    (id,proposal_id,channel_id,content,dedupe_key,status,platform_message_id,attempts,
     next_attempt_at_ms,created_at_ms,sent_at_ms,updated_at_ms)
    VALUES ('outbox','proposal',?,'Please confirm status.','proposal:proposal','sent','notification',1,?,?,?,?)`)
    .run(CHANNEL, NOW, NOW, NOW, NOW);
}

function reply(id = 'reply', channelId = CHANNEL, parent = 'notification') {
  env.db.prepare(`INSERT INTO messages
    (id,workspace_id,channel_id,author_id,author_display_name,content,created_at_ms,
     reply_to_message_id,ingested_at_ms,updated_at_ms)
    VALUES (?,?,?,?,?,'Moved to 28 August.',?,?,?,?)`)
    .run(id, GUILD, channelId, HUMAN, 'Human', NOW + 1, parent, NOW + 1, NOW + 1);
}

beforeEach(() => { env = createTestDb(); seedIdentity(env.db); seed(); });
afterEach(() => env.cleanup());

describe('scheduled notification feedback', () => {
  it('associates one exact same-channel human reply with its subjects', () => {
    reply();
    const result = resolveScheduledFeedback(env.db, {
      guildId: GUILD, channelId: CHANNEL, messageIds: ['reply'], mnemeId: BOT,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      replyMessageId: 'reply', notificationMessageId: 'notification',
      notificationText: 'Please confirm status.',
      subjects: [{ memoryId: 'memory' }],
    });
  });

  it('does not associate a top-level or cross-channel reply', () => {
    reply('top', CHANNEL, 'ordinary');
    expect(resolveScheduledFeedback(env.db, {
      guildId: GUILD, channelId: CHANNEL, messageIds: ['top'], mnemeId: BOT,
    })).toEqual([]);
  });

  it('fails closed when the Discord message id is ambiguous', () => {
    env.db.prepare(`INSERT INTO outbox
      (id,proposal_id,channel_id,content,dedupe_key,status,platform_message_id,attempts,
       next_attempt_at_ms,created_at_ms,sent_at_ms,updated_at_ms)
      VALUES ('outbox-2','proposal',?,'Please confirm status.','ambiguous','sent','notification',1,?,?,?,?)`)
      .run(CHANNEL, NOW, NOW, NOW, NOW);
    reply();
    expect(resolveScheduledFeedback(env.db, {
      guildId: GUILD, channelId: CHANNEL, messageIds: ['reply'], mnemeId: BOT,
    })).toEqual([]);
  });

  it('rejects proposal/outbox text or terminal-state mismatch', () => {
    env.db.prepare("UPDATE outbox SET content='Different text' WHERE id='outbox'").run();
    reply();
    expect(resolveScheduledFeedback(env.db, {
      guildId: GUILD, channelId: CHANNEL, messageIds: ['reply'], mnemeId: BOT,
    })).toEqual([]);
  });

  it('rejects malformed run provenance that does not expose the subject', () => {
    env.db.prepare(`UPDATE agent_runs SET retrieval_provenance_json=? WHERE id='run'`)
      .run(JSON.stringify({ channels: [], memoryScopes: [], messageIds: [] }));
    reply();
    expect(resolveScheduledFeedback(env.db, {
      guildId: GUILD, channelId: CHANNEL, messageIds: ['reply'], mnemeId: BOT,
    })).toEqual([]);
  });
});

describe('scheduled notification feedback in a thread under the notice', () => {
  const NOTICE_TS = '1700000000.000100';
  const NOTICE = `${CHANNEL}-${NOTICE_TS}`;
  const THREAD = `${CHANNEL}-T${NOTICE_TS}`;

  function thread(id: string, parentId = CHANNEL) {
    env.db.prepare(`INSERT INTO channels
      (id,workspace_id,parent_id,kind,name,is_thread,ingest_enabled,visibility_class,allow_interventions,
       discovered_at_ms,updated_at_ms)
      VALUES (?,?,?,'thread',NULL,1,1,'org',1,?,?)`).run(id, GUILD, parentId, NOW, NOW);
  }

  beforeEach(() => {
    env.db.prepare("UPDATE outbox SET platform_message_id=? WHERE id='outbox'").run(NOTICE);
  });

  it('associates a thread reply whose root is the notice', () => {
    thread(THREAD);
    reply('thread-reply', THREAD, NOTICE);
    const result = resolveScheduledFeedback(env.db, {
      guildId: GUILD, channelId: THREAD, messageIds: ['thread-reply'], mnemeId: BOT,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ replyMessageId: 'thread-reply', notificationMessageId: NOTICE });
  });

  it('does not associate a thread under another parent', () => {
    env.db.prepare(`INSERT INTO channels
      (id,workspace_id,parent_id,kind,name,is_thread,ingest_enabled,visibility_class,allow_interventions,
       discovered_at_ms,updated_at_ms)
      VALUES ('100000000000000009',?,NULL,'text','other',0,1,'org',1,?,?)`).run(GUILD, NOW, NOW);
    const other = `100000000000000009-T${NOTICE_TS}`;
    thread(other, '100000000000000009');
    reply('other-reply', other, NOTICE);
    expect(resolveScheduledFeedback(env.db, {
      guildId: GUILD, channelId: other, messageIds: ['other-reply'], mnemeId: BOT,
    })).toEqual([]);
  });

  it('does not associate a thread whose root is another message', () => {
    const otherThread = `${CHANNEL}-T1700000000.000200`;
    thread(otherThread);
    reply('wrong-root', otherThread, NOTICE);
    expect(resolveScheduledFeedback(env.db, {
      guildId: GUILD, channelId: otherThread, messageIds: ['wrong-root'], mnemeId: BOT,
    })).toEqual([]);
  });

  it('does not associate a top-level message in the notice channel', () => {
    reply('top-level', CHANNEL, 'ordinary');
    expect(resolveScheduledFeedback(env.db, {
      guildId: GUILD, channelId: CHANNEL, messageIds: ['top-level'], mnemeId: BOT,
    })).toEqual([]);
  });
});
