import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBasicChannelPolicy } from '../../src/policy/channel-policy-bootstrap.js';
import { loadInitialSnapshot } from '../../src/config-reload.js';
import { resolveChannel, ChannelPolicyError } from '../../src/policy/channel-policy.js';
import { makeTempDir } from '../helpers/db.js';

/**
 * Basic channel configuration.
 *
 * The bootstrap translates the basic selection variables into the validated
 * ChannelPolicy. It is not a second visibility engine: every rule it builds
 * must resolve through the existing resolveChannel path, threads included.
 *
 * Module surface pinned by this suite:
 * - buildBasicChannelPolicy(env) reads ORG_VISIBLE_CHANNEL_IDS,
 *   RESTRICTED_CHANNEL_IDS, MNEME_REVIEW_CHANNEL_ID and
 *   MNEME_REVIEW_CHANNEL_SECURE from the given env object. An unset or
 *   blank value behaves as absent. It throws ChannelPolicyError.
 * - loadInitialSnapshot(paths, now) is the production startup path. The
 *   source 'file' rejects non-empty basic lists first, then reads
 *   paths.channelPolicyPath. The source 'basic' builds the policy from
 *   paths.env, serializes it to YAML, and feeds that text to the same
 *   parseChannelPolicy that file mode uses. It never reads the policy file.
 *
 * Error strings below are pinned by the design contract. Tests assert them
 * verbatim; change them only together with the contract.
 */

const ORG_ID = '111111111111111111';
const ORG_ID_2 = '222222222222222222';
const RESTRICTED_ID = '333333333333333333';
const REVIEW_ID = '555555555555555555';
const UNSELECTED_PARENT_ID = '888888888888888888';
const THREAD_ID = '999999999999999999';

const ORG_RULE = { ingest: true, visibility: 'org', allow_interventions: false };
const RESTRICTED_RULE = { ingest: true, visibility: 'restricted', allow_interventions: false };
const DEFAULT_RULE = { ingest: false, visibility: 'restricted', allow_interventions: false };

/** Assert that the call fails with the exact operator-facing message. */
function expectPolicyError(fn: () => unknown, message: string): void {
  try {
    fn();
    throw new Error('expected the bootstrap to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(ChannelPolicyError);
    expect((err as Error).message).toBe(message);
  }
}

const EMPTY_SELECTION_ERROR =
  'channel policy: CHANNEL_POLICY_SOURCE=basic needs at least one id in ORG_VISIBLE_CHANNEL_IDS '
  + 'or RESTRICTED_CHANNEL_IDS; an existing channel-policy.yml needs CHANNEL_POLICY_SOURCE=file';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const PROMPT_DIR = path.join(REPO_ROOT, 'prompts');

const FILE_POLICY_YML = `version: 1
default:
  ingest: true
  visibility: org
  allow_interventions: true
`;

describe('buildBasicChannelPolicy', () => {
  it('rejects an empty selection: a policy that ingests nothing is never a useful deployment', () => {
    // The default source is basic, so an operator who upgrades with only a
    // channel-policy.yml would otherwise start a process that ingests nothing.
    for (const env of [
      {},
      { ORG_VISIBLE_CHANNEL_IDS: '', RESTRICTED_CHANNEL_IDS: '' },
      { ORG_VISIBLE_CHANNEL_IDS: ' , ' },
      { MNEME_REVIEW_CHANNEL_ID: REVIEW_ID, MNEME_REVIEW_CHANNEL_SECURE: 'true' },
    ]) {
      expectPolicyError(() => buildBasicChannelPolicy(env), EMPTY_SELECTION_ERROR);
    }
  });

  it('a single selected id is enough; the policy has no review channel by default', () => {
    for (const env of [
      { ORG_VISIBLE_CHANNEL_IDS: ORG_ID },
      { RESTRICTED_CHANNEL_IDS: RESTRICTED_ID },
    ]) {
      const policy = buildBasicChannelPolicy(env);
      expect(policy.version).toBe(1);
      expect(policy.default).toEqual(DEFAULT_RULE);
      expect(policy.channels.size).toBe(1);
      expect(policy.categories.size).toBe(1);
      expect(policy.review_channel).toBeUndefined();
    }
  });

  it('resolves an unselected channel to the fail-closed default rule', () => {
    const policy = buildBasicChannelPolicy({ ORG_VISIBLE_CHANNEL_IDS: ORG_ID });
    const resolved = resolveChannel(policy, UNSELECTED_PARENT_ID, { isThread: false });
    expect(resolved.source).toBe('default');
    expect(resolved.rule).toEqual(DEFAULT_RULE);
  });

  it('enters each selected id in both the channel and the category map', () => {
    const policy = buildBasicChannelPolicy({
      ORG_VISIBLE_CHANNEL_IDS: `${ORG_ID},${ORG_ID_2}`,
      RESTRICTED_CHANNEL_IDS: RESTRICTED_ID,
    });
    for (const id of [ORG_ID, ORG_ID_2]) {
      expect(policy.channels.get(id)).toEqual(ORG_RULE);
      expect(policy.categories.get(id)).toEqual(ORG_RULE);
    }
    expect(policy.channels.get(RESTRICTED_ID)).toEqual(RESTRICTED_RULE);
    expect(policy.categories.get(RESTRICTED_ID)).toEqual(RESTRICTED_RULE);
    expect(policy.channels.size).toBe(3);
    expect(policy.categories.size).toBe(3);
    // The fail-closed default stays in place for everything unselected.
    expect(policy.default).toEqual(DEFAULT_RULE);
  });

  it('trims ids and drops empty list entries like parseSnowflakeList does', () => {
    const policy = buildBasicChannelPolicy({
      ORG_VISIBLE_CHANNEL_IDS: `  ${ORG_ID} ,, ${ORG_ID_2} `,
    });
    expect(policy.channels.get(ORG_ID)).toEqual(ORG_RULE);
    expect(policy.channels.get(ORG_ID_2)).toEqual(ORG_RULE);
    expect(policy.channels.size).toBe(2);
  });

  describe('review channel matrix', () => {
    it('rejects a review channel id without SECURE exactly true', () => {
      const pinned =
        'channel policy: MNEME_REVIEW_CHANNEL_ID requires MNEME_REVIEW_CHANNEL_SECURE=true '
        + '(verify the channel audience before enabling)';
      expectPolicyError(
        () => buildBasicChannelPolicy({
          ORG_VISIBLE_CHANNEL_IDS: ORG_ID,
          MNEME_REVIEW_CHANNEL_ID: REVIEW_ID,
        }),
        pinned,
      );
      expectPolicyError(
        () => buildBasicChannelPolicy({
          ORG_VISIBLE_CHANNEL_IDS: ORG_ID,
          MNEME_REVIEW_CHANNEL_ID: REVIEW_ID,
          MNEME_REVIEW_CHANNEL_SECURE: 'false',
        }),
        pinned,
      );
      expectPolicyError(
        () => buildBasicChannelPolicy({
          ORG_VISIBLE_CHANNEL_IDS: ORG_ID,
          MNEME_REVIEW_CHANNEL_ID: REVIEW_ID,
          // Not exactly 'true': the check is case sensitive on purpose.
          MNEME_REVIEW_CHANNEL_SECURE: 'True',
        }),
        pinned,
      );
    });

    it('rejects SECURE=true without a review channel id', () => {
      expectPolicyError(
        () => buildBasicChannelPolicy({
          ORG_VISIBLE_CHANNEL_IDS: ORG_ID,
          MNEME_REVIEW_CHANNEL_SECURE: 'true',
        }),
        'channel policy: MNEME_REVIEW_CHANNEL_SECURE=true requires MNEME_REVIEW_CHANNEL_ID',
      );
    });

    it('registers the review channel when both variables are set', () => {
      const policy = buildBasicChannelPolicy({
        ORG_VISIBLE_CHANNEL_IDS: ORG_ID,
        MNEME_REVIEW_CHANNEL_ID: REVIEW_ID,
        MNEME_REVIEW_CHANNEL_SECURE: 'true',
      });
      // Both modes accept the same scope set as the file-mode sample, so a
      // review_only proposal stays cardable in basic mode too.
      expect(policy.review_channel).toEqual({
        id: REVIEW_ID,
        secure: true,
        accepts_scopes: ['org', 'restricted', 'review_only'],
      });
    });

    it('leaves the review channel unset when neither variable is set', () => {
      const policy = buildBasicChannelPolicy({
        ORG_VISIBLE_CHANNEL_IDS: ORG_ID,
        MNEME_REVIEW_CHANNEL_ID: '',
        MNEME_REVIEW_CHANNEL_SECURE: '',
      });
      expect(policy.review_channel).toBeUndefined();
    });
  });

  it('rejects a review channel id that appears in a selection list', () => {
    const pinned =
      `channel policy: review channel ${REVIEW_ID} must not appear in the selection lists`;
    expectPolicyError(
      () => buildBasicChannelPolicy({
        ORG_VISIBLE_CHANNEL_IDS: REVIEW_ID,
        MNEME_REVIEW_CHANNEL_ID: REVIEW_ID,
        MNEME_REVIEW_CHANNEL_SECURE: 'true',
      }),
      pinned,
    );
    expectPolicyError(
      () => buildBasicChannelPolicy({
        RESTRICTED_CHANNEL_IDS: REVIEW_ID,
        MNEME_REVIEW_CHANNEL_ID: REVIEW_ID,
        MNEME_REVIEW_CHANNEL_SECURE: 'true',
      }),
      pinned,
    );
  });

  it('rejects an id that appears in both selection lists', () => {
    expectPolicyError(
      () => buildBasicChannelPolicy({
        ORG_VISIBLE_CHANNEL_IDS: ORG_ID,
        RESTRICTED_CHANNEL_IDS: ORG_ID,
      }),
      'channel policy: id 111111111111111111 appears in both ORG_VISIBLE_CHANNEL_IDS '
      + 'and RESTRICTED_CHANNEL_IDS',
    );
    expectPolicyError(
      () => buildBasicChannelPolicy({
        ORG_VISIBLE_CHANNEL_IDS: `${ORG_ID_2},${ORG_ID}`,
        RESTRICTED_CHANNEL_IDS: ORG_ID,
      }),
      `channel policy: id ${ORG_ID} appears in both ORG_VISIBLE_CHANNEL_IDS and RESTRICTED_CHANNEL_IDS`,
    );
  });

  it('rejects a value that is not a 17-20 digit snowflake after trim', () => {
    expectPolicyError(
      () => buildBasicChannelPolicy({ ORG_VISIBLE_CHANNEL_IDS: 'not-an-id' }),
      'channel policy: "not-an-id" in ORG_VISIBLE_CHANNEL_IDS is not a Discord snowflake',
    );
    expectPolicyError(
      () => buildBasicChannelPolicy({ RESTRICTED_CHANNEL_IDS: '123' }),
      'channel policy: "123" in RESTRICTED_CHANNEL_IDS is not a Discord snowflake',
    );
    expectPolicyError(
      () => buildBasicChannelPolicy({ ORG_VISIBLE_CHANNEL_IDS: '123456789012345678901' }),
      'channel policy: "123456789012345678901" in ORG_VISIBLE_CHANNEL_IDS is not a Discord snowflake',
    );
  });
});

describe('resolveChannel with a basic-built policy', () => {
  it('a thread of a selected parent inherits the selected rule', () => {
    const policy = buildBasicChannelPolicy({ ORG_VISIBLE_CHANNEL_IDS: ORG_ID });
    const resolved = resolveChannel(policy, THREAD_ID, {
      isThread: true,
      parentId: ORG_ID,
    });
    expect(resolved.source).toBe('thread_parent');
    expect(resolved.rule).toEqual(ORG_RULE);
  });

  it('a thread of an unselected parent stays unselected', () => {
    const policy = buildBasicChannelPolicy({ ORG_VISIBLE_CHANNEL_IDS: ORG_ID });
    const resolved = resolveChannel(policy, THREAD_ID, {
      isThread: true,
      parentId: UNSELECTED_PARENT_ID,
    });
    expect(resolved.source).toBe('default');
    expect(resolved.rule).toEqual(DEFAULT_RULE);
  });

  it('a channel inside a selected category resolves through the category rule', () => {
    // A selected id names either one channel or one category. The matching
    // entry applies; the other is inert but must still resolve correctly.
    const policy = buildBasicChannelPolicy({ ORG_VISIBLE_CHANNEL_IDS: ORG_ID });
    const resolved = resolveChannel(policy, THREAD_ID, {
      isThread: false,
      categoryId: ORG_ID,
    });
    expect(resolved.source).toBe('category');
    expect(resolved.rule).toEqual(ORG_RULE);
  });
});

describe('loadInitialSnapshot (source precedence)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A real channel-policy.yml on disk, or a path that must never be read. */
  function policyFile(text: string | null): string {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const file = path.join(dir, 'channel-policy.yml');
    if (text !== null) writeFileSync(file, text, 'utf8');
    return file;
  }

  it('basic mode builds from env through the shared parser and never reads the policy file', () => {
    const snapshot = loadInitialSnapshot({
      channelPolicyPath: policyFile(null),
      promptDir: PROMPT_DIR,
      channelPolicySource: 'basic',
      env: { CHANNEL_POLICY_SOURCE: 'basic', ORG_VISIBLE_CHANNEL_IDS: ORG_ID },
    }, 1_700_000_000_000);
    expect(snapshot.channelPolicySource).toBe('basic');
    expect(snapshot.channelPolicy.channels.get(ORG_ID)).toEqual(ORG_RULE);
    expect(snapshot.channelPolicy.categories.get(ORG_ID)).toEqual(ORG_RULE);
    expect(snapshot.channelPolicy.default).toEqual(DEFAULT_RULE);
    // The snapshot text is the YAML form of the built policy, so the hash and
    // audit trail describe the same policy the parser validated.
    expect(snapshot.channelPolicyYml).toContain(`"${ORG_ID}":`);
    expect(snapshot.channelPolicySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('basic mode fails startup on an empty selection', () => {
    expectPolicyError(
      () => loadInitialSnapshot({
        channelPolicyPath: policyFile(FILE_POLICY_YML),
        promptDir: PROMPT_DIR,
        channelPolicySource: 'basic',
        env: {},
      }, 1_700_000_000_000),
      EMPTY_SELECTION_ERROR,
    );
  });

  it('file mode loads the policy file', () => {
    const snapshot = loadInitialSnapshot({
      channelPolicyPath: policyFile(FILE_POLICY_YML),
      promptDir: PROMPT_DIR,
      channelPolicySource: 'file',
      env: { CHANNEL_POLICY_SOURCE: 'file' },
    }, 1_700_000_000_000);
    expect(snapshot.channelPolicySource).toBe('file');
    expect(snapshot.channelPolicy.default).toEqual({ ingest: true, visibility: 'org', allow_interventions: true });
  });

  it('file mode accepts blank selection lists', () => {
    const snapshot = loadInitialSnapshot({
      channelPolicyPath: policyFile(FILE_POLICY_YML),
      promptDir: PROMPT_DIR,
      channelPolicySource: 'file',
      env: { CHANNEL_POLICY_SOURCE: 'file', ORG_VISIBLE_CHANNEL_IDS: '', RESTRICTED_CHANNEL_IDS: '' },
    }, 1_700_000_000_000);
    expect(snapshot.channelPolicy.default.visibility).toBe('org');
  });

  it('file mode rejects a non-empty selection list before reading the file', () => {
    const pinned =
      'channel policy: CHANNEL_POLICY_SOURCE=file ignores basic lists; unset ORG_VISIBLE_CHANNEL_IDS '
      + 'and RESTRICTED_CHANNEL_IDS or set CHANNEL_POLICY_SOURCE=basic';
    for (const env of [
      { CHANNEL_POLICY_SOURCE: 'file', ORG_VISIBLE_CHANNEL_IDS: ORG_ID },
      { CHANNEL_POLICY_SOURCE: 'file', RESTRICTED_CHANNEL_IDS: RESTRICTED_ID },
    ]) {
      expectPolicyError(
        // A missing file proves the order: the list check throws first.
        () => loadInitialSnapshot({
          channelPolicyPath: policyFile(null),
          promptDir: PROMPT_DIR,
          channelPolicySource: 'file',
          env,
        }, 1_700_000_000_000),
        pinned,
      );
    }
  });
});
