import { describe, it, expect, afterEach } from 'vitest';
import { type DatabaseSync } from '../../src/db/database.js';
import { createTestDb, seedIdentity } from '../helpers/db.js';
import {
  ConfigStore,
  buildConfigSnapshot,
  diffChannelPolicy,
  reloadConfig,
  ConfigReloadError,
  type ConfigCandidateSources,
} from '../../src/config-reload.js';
import type { PromptFiles } from '../../src/agent/prompts.js';
import type { ChannelPolicy } from '../../src/discord/channel-policy.js';
import {
  decideChannelPolicyReview,
  getActiveChannelPolicyReview,
} from '../../src/db/repositories/channel-policy-reviews.js';
import { reconcileStoredChannelPolicyReview } from '../../src/discord/channel-policy-review-service.js';
import { basicChannelPolicySourceText } from '../../src/discord/channel-policy-bootstrap.js';
import {
  handleReloadPolicyCommand,
  formatReloadPolicyReply,
} from '../../src/discord/commands/reload-policy.js';

/**
 * Atomic policy + prompt reload (Sections 7.2, 8, 15, 27).
 *
 * Acceptance: an invalid reload leaves the previous policy active; a valid
 * reload tightens retrieval immediately and queues cache maintenance.
 */

const NOW = 1_700_000_000_000;
const ADMIN_ROLE = '900000000000000001';
const REVIEW_CHANNEL = '900000000000000002';
const SEEDED_CHANNEL = '100000000000000002';

let setup: ReturnType<typeof createTestDb> | null = null;
function freshDb(): DatabaseSync {
  setup = createTestDb();
  return setup.db;
}
afterEach(() => {
  setup?.cleanup();
  setup = null;
});

/** Minimal, valid prompt surface (no partial references) that compiles cleanly. */
function promptFiles(overrides: Partial<PromptFiles> = {}): PromptFiles {
  return {
    system: 'Mneme system prompt.',
    'episode-review': 'Review episode {{json id}}.',
    'direct-answer': 'Answer: {{json question}}.',
    'scheduled-review': 'Scheduled review.',
    partials: {
      personality: 'quiet',
      boundaries: 'strict',
      'memory-taxonomy': 'taxonomy',
    },
    ...overrides,
  } as PromptFiles;
}

const DEFAULT_POLICY = `version: 1
default:
  ingest: true
  visibility: restricted
  allow_interventions: false
`;

function policyWith(extra: string): string {
  return `${DEFAULT_POLICY}${extra}`;
}

function reviewPolicy(extra = ''): string {
  return `${DEFAULT_POLICY}${extra}review_channel:
  id: "${REVIEW_CHANNEL}"
  secure: true
  accepts_scopes: [org, restricted, review_only]
`;
}

function makeStore(yml = DEFAULT_POLICY): ConfigStore {
  const snap = buildConfigSnapshot({ channelPolicyYml: yml, promptFiles: promptFiles(), now: NOW });
  return new ConfigStore(snap);
}

function reloadEvent(db: DatabaseSync): { details: Record<string, unknown> } {
  const row = db
    .prepare("SELECT details_json AS d FROM admin_events WHERE action = 'reload_policy' ORDER BY created_at_ms DESC LIMIT 1")
    .get() as { d: string } | undefined;
  return { details: row ? (JSON.parse(row.d) as Record<string, unknown>) : {} };
}

describe('buildConfigSnapshot — validation fails closed', () => {
  it('rejects invalid channel-policy YAML with a typed error', () => {
    const bad = policyWith('channels:\n  "600000000000000001":\n    ingest: true\n    visibility: BOGUS\n    allow_interventions: false\n');
    expect(() => buildConfigSnapshot({ channelPolicyYml: bad, promptFiles: promptFiles(), now: NOW })).toThrow(
      ConfigReloadError,
    );
  });

  it('rejects a prompt template that does not compile or dry-render', () => {
    // Unclosed block — structural breakage the dry-render catches.
    const broken = promptFiles({ system: 'Mneme. {{#each items}}{{name}}' });
    expect(() => buildConfigSnapshot({ channelPolicyYml: DEFAULT_POLICY, promptFiles: broken, now: NOW })).toThrow(
      ConfigReloadError,
    );
  });

  it('eagerly rejects a broken partial (fails before activation, not at render)', () => {
    const broken = {
      ...promptFiles(),
      partials: { personality: '{{#each items}}', boundaries: 'strict', 'memory-taxonomy': 'taxonomy' },
    };
    expect(() => buildConfigSnapshot({ channelPolicyYml: DEFAULT_POLICY, promptFiles: broken, now: NOW })).toThrow(
      /partial:personality/,
    );
  });

  it('rejects a template referencing a partial outside the fixed set', () => {
    const broken = promptFiles({ system: 'Mneme. {{> notARealPartial}}' });
    expect(() => buildConfigSnapshot({ channelPolicyYml: DEFAULT_POLICY, promptFiles: broken, now: NOW })).toThrow(
      ConfigReloadError,
    );
  });
});

describe('reloadConfig — invalid reload leaves previous policy active', () => {
  it('keeps the previous snapshot on invalid YAML', () => {
    const d = freshDb();
    const { guildId, userId } = seedIdentity(d);
    const store = makeStore();
    const before = store.get();
    let enqueued = 0;
    const res = reloadConfig({
      db: d,
      store,
      guildId,
      actorUserId: userId,
      nowMs: NOW,
      channelPolicyYml: 'version: 1\ndefault: { ingest: true, visibility: NOPE, allow_interventions: false }\n',
      promptFiles: promptFiles(),
      enqueueMaintenance: () => {
        enqueued += 1;
        return { id: 'm1', enqueued: true };
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeTruthy();
    expect(store.get()).toBe(before); // same reference — nothing swapped
    expect(enqueued).toBe(0); // no maintenance queued
    const { details } = reloadEvent(d);
    expect(details.success).toBe(false);
  });

  it('keeps the previous snapshot on an inconsistent review channel', () => {
    const d = freshDb();
    const { guildId, userId } = seedIdentity(d);
    const store = makeStore();
    const before = store.get();
    const insecure = policyWith(`review_channel:
  id: "500000000000000001"
  secure: false
  accepts_scopes: [org]
`);
    const res = reloadConfig({
      db: d,
      store,
      guildId,
      actorUserId: userId,
      nowMs: NOW,
      channelPolicyYml: insecure,
      promptFiles: promptFiles(),
    });
    expect(res.ok).toBe(false);
    expect(store.get()).toBe(before);
  });

  it('rejects a review channel that accepts no scopes', () => {
    const d = freshDb();
    const { guildId, userId } = seedIdentity(d);
    const store = makeStore();
    const noScopes = policyWith(`review_channel:
  id: "500000000000000002"
  secure: true
  accepts_scopes: []
`);
    const res = reloadConfig({
      db: d,
      store,
      guildId,
      actorUserId: userId,
      nowMs: NOW,
      channelPolicyYml: noScopes,
      promptFiles: promptFiles(),
    });
    expect(res.ok).toBe(false);
  });
});

describe('reloadConfig — basic mode denies every live reload', () => {
  it('keeps the basic snapshot active, names the restart, and audits the attempt', () => {
    const d = freshDb();
    const { guildId, userId } = seedIdentity(d);
    const basicSnapshot = buildConfigSnapshot({
      channelPolicyYml: basicChannelPolicySourceText({ ORG_VISIBLE_CHANNEL_IDS: SEEDED_CHANNEL }),
      promptFiles: promptFiles(),
      now: NOW,
      channelPolicySource: 'basic',
    });
    const store = new ConfigStore(basicSnapshot);
    let enqueued = 0;
    const res = reloadConfig({
      db: d,
      store,
      guildId,
      actorUserId: userId,
      nowMs: NOW,
      // A valid file candidate must still be denied: the source, not the text, decides.
      channelPolicyYml: DEFAULT_POLICY,
      promptFiles: promptFiles(),
      enqueueMaintenance: () => {
        enqueued += 1;
        return { id: 'm1', enqueued: true };
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe(
      'channel policy reload requires CHANNEL_POLICY_SOURCE=file; the basic policy comes from '
      + 'environment variables and changes take effect after restart',
    );
    expect(store.get()).toBe(basicSnapshot);
    expect(enqueued).toBe(0);
    const { details } = reloadEvent(d);
    expect(details).toMatchObject({ success: false, error: res.error });
    expect(res.auditEventId).toBeTruthy();
  });
});

describe('reloadConfig — valid reload activates and queues maintenance', () => {
  it('atomically activates a changed policy, audits hashes, and queues re-scope', () => {
    const d = freshDb();
    const { guildId, userId } = seedIdentity(d);
    const store = makeStore();
    const prevHash = store.get().channelPolicySha256;
    const changed = policyWith(`channels:
  "600000000000000001":
    ingest: true
    visibility: org
    allow_interventions: true
`);
    let enqueued = 0;
    const res = reloadConfig({
      db: d,
      store,
      guildId,
      actorUserId: userId,
      nowMs: NOW,
      channelPolicyYml: changed,
      promptFiles: promptFiles(),
      enqueueMaintenance: () => {
        enqueued += 1;
        return { id: 'maint-1', enqueued: true };
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changedChannelIds).toContain('600000000000000001');
    expect(res.rescopeEnqueued).toBe(true);
    expect(enqueued).toBe(1);
    // Retrieval tightens immediately: the active snapshot is the new one.
    const active = store.get();
    expect(active.channelPolicySha256).not.toBe(prevHash);
    expect(active.channelPolicy.channels.get('600000000000000001')?.visibility).toBe('org');
    // Audit carries the new hashes and the changed channel.
    const { details } = reloadEvent(d);
    expect(details.success).toBe(true);
    expect(details.promptVersion).toBe(res.promptVersion);
    expect(details.channelPolicySha256).toBe(res.channelPolicySha256);
    expect(details.changedChannels).toEqual(['600000000000000001']);
  });

  it('does not queue maintenance when nothing changed', () => {
    const d = freshDb();
    const { guildId, userId } = seedIdentity(d);
    const store = makeStore();
    let enqueued = 0;
    const res = reloadConfig({
      db: d,
      store,
      guildId,
      actorUserId: userId,
      nowMs: NOW,
      channelPolicyYml: DEFAULT_POLICY, // identical
      promptFiles: promptFiles(),
      enqueueMaintenance: () => {
        enqueued += 1;
        return { id: 'm', enqueued: true };
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changedChannelIds).toEqual([]);
    expect(res.rescopeEnqueued).toBe(false);
    expect(enqueued).toBe(0);
  });

  it('queues maintenance when only the default rule changes', () => {
    const d = freshDb();
    const { guildId, userId } = seedIdentity(d);
    const store = makeStore();
    const tighterDefault = `version: 1
default:
  ingest: true
  visibility: excluded
  allow_interventions: false
`;
    let enqueued = 0;
    const res = reloadConfig({
      db: d,
      store,
      guildId,
      actorUserId: userId,
      nowMs: NOW,
      channelPolicyYml: tighterDefault,
      promptFiles: promptFiles(),
      enqueueMaintenance: () => {
        enqueued += 1;
        return { id: 'm', enqueued: true };
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.defaultChanged).toBe(true);
    expect(res.rescopeEnqueued).toBe(true);
    expect(enqueued).toBe(1);
    const channel = d.prepare('SELECT ingest_enabled,visibility_class,allow_interventions FROM channels LIMIT 1')
      .get() as { ingest_enabled: number; visibility_class: string; allow_interventions: number };
    expect(channel).toEqual({ ingest_enabled: 0, visibility_class: 'excluded', allow_interventions: 0 });
  });

  it('lets a new explicit rule supersede a reviewed runtime decision', () => {
    const d = freshDb();
    const { guildId, userId } = seedIdentity(d);
    const initialYml = reviewPolicy();
    const store = makeStore(initialYml);
    const initial = reconcileStoredChannelPolicyReview(
      d, store.get().channelPolicy, SEEDED_CHANNEL, NOW, { forceReview: true },
    );
    decideChannelPolicyReview(d, {
      reviewId: initial.reviewId!, decision: 'org', actorUserId: userId, now: NOW,
    });
    d.prepare("UPDATE channels SET visibility_class='org' WHERE id=?").run(SEEDED_CHANNEL);
    const explicit = reviewPolicy(`channels:
  "${SEEDED_CHANNEL}":
    ingest: true
    visibility: restricted
    allow_interventions: false
`);

    const result = reloadConfig({
      db: d, store, guildId, actorUserId: userId, nowMs: NOW + 1,
      channelPolicyYml: explicit, promptFiles: promptFiles(),
    });

    expect(result.ok).toBe(true);
    expect(getActiveChannelPolicyReview(d, SEEDED_CHANNEL)).toBeUndefined();
    expect(d.prepare('SELECT visibility_class FROM channels WHERE id=?').get(SEEDED_CHANNEL))
      .toEqual({ visibility_class: 'restricted' });
  });

  it('creates a pending restricted review when an explicit rule is removed', () => {
    const d = freshDb();
    const { guildId, userId } = seedIdentity(d);
    const explicit = reviewPolicy(`channels:
  "${SEEDED_CHANNEL}":
    ingest: true
    visibility: org
    allow_interventions: true
`);
    const store = makeStore(explicit);

    const result = reloadConfig({
      db: d, store, guildId, actorUserId: userId, nowMs: NOW + 1,
      channelPolicyYml: reviewPolicy(), promptFiles: promptFiles(),
    });

    expect(result.ok).toBe(true);
    expect(getActiveChannelPolicyReview(d, SEEDED_CHANNEL)).toMatchObject({ status: 'pending' });
    expect(d.prepare('SELECT visibility_class,allow_interventions FROM channels WHERE id=?')
      .get(SEEDED_CHANNEL)).toEqual({ visibility_class: 'restricted', allow_interventions: 0 });
  });
});

describe('diffChannelPolicy', () => {
  const base = (): ChannelPolicy => buildConfigSnapshot({ channelPolicyYml: DEFAULT_POLICY, promptFiles: promptFiles(), now: NOW }).channelPolicy;

  it('reports default, channel, category, and review changes', () => {
    const a = base();
    const withChannel = buildConfigSnapshot({
      channelPolicyYml: policyWith(`channels:\n  "700000000000000001":\n    ingest: true\n    visibility: org\n    allow_interventions: true\n`),
      promptFiles: promptFiles(),
      now: NOW,
    }).channelPolicy;
    expect(diffChannelPolicy(a, withChannel).changedChannelIds).toContain('700000000000000001');

    const withCategory = buildConfigSnapshot({
      channelPolicyYml: policyWith(`categories:\n  "710000000000000001":\n    ingest: true\n    visibility: org\n    allow_interventions: false\n`),
      promptFiles: promptFiles(),
      now: NOW,
    }).channelPolicy;
    expect(diffChannelPolicy(a, withCategory).changedChannelIds).toContain('710000000000000001');

    const withReview = buildConfigSnapshot({
      channelPolicyYml: policyWith(`review_channel:\n  id: "720000000000000001"\n  secure: true\n  accepts_scopes: [org]\n`),
      promptFiles: promptFiles(),
      now: NOW,
    }).channelPolicy;
    expect(diffChannelPolicy(a, withReview).policyChanged).toBe(true);

    expect(diffChannelPolicy(a, a).policyChanged).toBe(false);
  });
});

describe('handleReloadPolicyCommand — authorization and dispatch', () => {
  function makeCommandDeps(db: DatabaseSync, store: ConfigStore, candidate: ConfigCandidateSources, memberRoleIds: readonly string[] | null) {
    return {
      input: { actorUserId: '100000000000000003', guildId: '100000000000000001', memberRoleIds },
      deps: {
        db,
        adminRoleIds: [ADMIN_ROLE],
        store,
        nowMs: NOW,
        candidate,
        enqueueMaintenance: () => ({ id: 'm', enqueued: true }),
      },
    };
  }

  it('denies fail-closed and audits when unauthorized', () => {
    const d = freshDb();
    seedIdentity(d);
    const store = makeStore();
    const { input, deps } = makeCommandDeps(d, store, { channelPolicyYml: DEFAULT_POLICY, promptFiles: promptFiles() }, ['000000000000000009']);
    const out = handleReloadPolicyCommand(input, deps);
    expect(out.kind).toBe('not_authorized');
    const { details } = reloadEvent(d);
    expect(details.authorized).toBe(false);
    expect(details.reason).toBe('not_authorized');
  });

  it('authorized + invalid candidate returns done/!ok and leaves previous active', () => {
    const d = freshDb();
    seedIdentity(d);
    const store = makeStore();
    const before = store.get();
    const { input, deps } = makeCommandDeps(d, store, { channelPolicyYml: 'not: valid: policy', promptFiles: promptFiles() }, [ADMIN_ROLE]);
    const out = handleReloadPolicyCommand(input, deps);
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    expect(out.result.ok).toBe(false);
    expect(store.get()).toBe(before);
  });

  it('authorized + valid candidate activates the new snapshot', () => {
    const d = freshDb();
    seedIdentity(d);
    const store = makeStore();
    const changed = policyWith(`channels:\n  "600000000000000001":\n    ingest: true\n    visibility: org\n    allow_interventions: true\n`);
    const { input, deps } = makeCommandDeps(d, store, { channelPolicyYml: changed, promptFiles: promptFiles() }, [ADMIN_ROLE]);
    const out = handleReloadPolicyCommand(input, deps);
    expect(out.kind).toBe('done');
    if (out.kind !== 'done' || !out.result.ok) return;
    expect(store.get().channelPolicy.channels.get('600000000000000001')?.visibility).toBe('org');
  });

  it('reply never echoes message content and reports hashes on success', () => {
    const ok = formatReloadPolicyReply({
      kind: 'done',
      result: {
        ok: true,
        promptVersion: 'a'.repeat(64),
        channelPolicySha256: 'b'.repeat(64),
        defaultChanged: false,
        changedChannelIds: ['600000000000000001'],
        rescopeEnqueued: true,
        auditEventId: 'ae-1',
      },
    });
    expect(ok).toContain('reloaded');
    expect(ok).toContain('aaaaaaaaaaaa'); // 12-char prompt hash prefix
    expect(ok).toContain('queued');
    const bad = formatReloadPolicyReply({
      kind: 'done',
      result: { ok: false, error: 'channel-policy: default: visibility must be one of org|restricted|review_only|excluded', auditEventId: 'ae-2' },
    });
    expect(bad).toContain('rejected');
    expect(bad).toContain('remains active');
    expect(formatReloadPolicyReply({ kind: 'not_authorized', reason: 'not_authorized' })).toContain('not authorized');
  });
});
