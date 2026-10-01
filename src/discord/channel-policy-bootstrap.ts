// ABOUTME: Translates the basic environment channel selection into a validated ChannelPolicy.
// ABOUTME: Startup-only translator; live policy reload stays limited to file mode.

import { stringify as stringifyYaml } from 'yaml';
import {
  ChannelPolicyError,
  REVIEW_ACCEPT_SCOPES,
  type ChannelPolicy,
  type ChannelRule,
} from './channel-policy.js';

/**
 * Basic first-run channel configuration (the small-install path).
 *
 * `CHANNEL_POLICY_SOURCE=basic` (the default) builds the channel policy from
 * environment variables instead of channel-policy.yml:
 *
 * - `ORG_VISIBLE_CHANNEL_IDS` and `RESTRICTED_CHANNEL_IDS` hold comma-separated
 *   snowflakes. Each id names a channel or a category. Every id is entered in
 *   both the channel map and the category map with the same rule, because a
 *   snowflake names exactly one resource kind: the matching entry applies and
 *   the other is inert.
 * - `MNEME_REVIEW_CHANNEL_ID` plus `MNEME_REVIEW_CHANNEL_SECURE=true`
 *   configures the review channel.
 *
 * The default rule is fail-closed. A channel that no selection list names is
 * not ingested, stays restricted, and receives no interventions. Both lists
 * empty is a startup error: such a policy ingests nothing, and an operator who
 * has a channel-policy.yml must select file mode explicitly.
 * `CHANNEL_POLICY_PATH` is not read in basic mode. Selection changes in either
 * mode take effect after a restart.
 */

const SNOWFLAKE_RE = /^\d{17,20}$/;

const ORG_VISIBLE_VAR = 'ORG_VISIBLE_CHANNEL_IDS';
const RESTRICTED_VAR = 'RESTRICTED_CHANNEL_IDS';
const REVIEW_ID_VAR = 'MNEME_REVIEW_CHANNEL_ID';
const REVIEW_SECURE_VAR = 'MNEME_REVIEW_CHANNEL_SECURE';

/** Fail-closed rule for channels that no selection list names. */
const UNSELECTED_RULE: ChannelRule = {
  ingest: false,
  visibility: 'restricted',
  allow_interventions: false,
};

/** Read one env value; undefined and empty string both mean "not set". */
function rawValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

/**
 * Parse a comma-separated snowflake selection list. Entries are trimmed and
 * empty entries are skipped, matching the `parseSnowflakeList` semantics of the
 * config loader.
 */
function parseSelectionList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = rawValue(env, key);
  if (raw === undefined) return [];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const part of parts) {
    if (!SNOWFLAKE_RE.test(part)) {
      throw new ChannelPolicyError(`channel policy: "${part}" in ${key} is not a Discord snowflake`);
    }
  }
  return parts;
}

/** Validate the review-channel id with the shared snowflake rule. */
function parseReviewId(raw: string): string {
  if (!SNOWFLAKE_RE.test(raw)) {
    throw new ChannelPolicyError(`channel policy: "${raw}" in ${REVIEW_ID_VAR} is not a Discord snowflake`);
  }
  return raw;
}

/**
 * Build the basic-mode policy from the environment. Throws a
 * {@link ChannelPolicyError} on any invalid or conflicting selection, so a bad
 * configuration stops the process at startup.
 */
export function buildBasicChannelPolicy(env: NodeJS.ProcessEnv): ChannelPolicy {
  const orgIds = parseSelectionList(env, ORG_VISIBLE_VAR);
  const restrictedIds = parseSelectionList(env, RESTRICTED_VAR);
  if (orgIds.length === 0 && restrictedIds.length === 0) {
    throw new ChannelPolicyError(
      'channel policy: CHANNEL_POLICY_SOURCE=basic needs at least one id in ORG_VISIBLE_CHANNEL_IDS or RESTRICTED_CHANNEL_IDS; an existing channel-policy.yml needs CHANNEL_POLICY_SOURCE=file',
    );
  }

  const restrictedSet = new Set(restrictedIds);
  for (const id of orgIds) {
    if (restrictedSet.has(id)) {
      throw new ChannelPolicyError(
        `channel policy: id ${id} appears in both ORG_VISIBLE_CHANNEL_IDS and RESTRICTED_CHANNEL_IDS`,
      );
    }
  }

  const reviewIdRaw = rawValue(env, REVIEW_ID_VAR);
  const reviewSecureRaw = rawValue(env, REVIEW_SECURE_VAR);
  const reviewId = reviewIdRaw === undefined ? undefined : parseReviewId(reviewIdRaw);

  if (reviewId !== undefined && reviewSecureRaw !== 'true') {
    throw new ChannelPolicyError(
      'channel policy: MNEME_REVIEW_CHANNEL_ID requires MNEME_REVIEW_CHANNEL_SECURE=true (verify the channel audience before enabling)',
    );
  }
  if (reviewId === undefined && reviewSecureRaw === 'true') {
    throw new ChannelPolicyError(
      'channel policy: MNEME_REVIEW_CHANNEL_SECURE=true requires MNEME_REVIEW_CHANNEL_ID',
    );
  }
  if (reviewId !== undefined && (orgIds.includes(reviewId) || restrictedSet.has(reviewId))) {
    throw new ChannelPolicyError(
      `channel policy: review channel ${reviewId} must not appear in the selection lists`,
    );
  }

  const policy: ChannelPolicy = {
    version: 1,
    default: { ...UNSELECTED_RULE },
    categories: new Map<string, ChannelRule>(),
    channels: new Map<string, ChannelRule>(),
    review_channel: reviewId === undefined
      ? undefined
      // Both modes accept the same scope set (Section 8.2): a review_only
      // proposal must stay cardable whichever source built the policy.
      : { id: reviewId, secure: true, accepts_scopes: [...REVIEW_ACCEPT_SCOPES] },
  };
  for (const id of orgIds) {
    const rule: ChannelRule = { ingest: true, visibility: 'org', allow_interventions: false };
    policy.channels.set(id, rule);
    policy.categories.set(id, rule);
  }
  for (const id of restrictedIds) {
    const rule: ChannelRule = { ingest: true, visibility: 'restricted', allow_interventions: false };
    policy.channels.set(id, rule);
    policy.categories.set(id, rule);
  }
  return policy;
}

/**
 * File mode must not carry basic selection lists: two sources would fight over
 * one policy. Called before the YAML file is read, so the operator sees the
 * conflict first.
 */
export function assertNoBasicSelectionInFileMode(env: NodeJS.ProcessEnv): void {
  const carriesBasicList = [ORG_VISIBLE_VAR, RESTRICTED_VAR].some(
    (key) => env[key] !== undefined && env[key]!.trim() !== '',
  );
  if (carriesBasicList) {
    throw new ChannelPolicyError(
      'channel policy: CHANNEL_POLICY_SOURCE=file ignores basic lists; unset ORG_VISIBLE_CHANNEL_IDS and RESTRICTED_CHANNEL_IDS or set CHANNEL_POLICY_SOURCE=basic',
    );
  }
}

/**
 * Serialize a basic-built policy into the channel-policy.yml format. The text
 * feeds hashing, audit, and the standard parser, so basic mode never keeps a
 * second, private policy representation.
 */
export function basicChannelPolicyYml(policy: ChannelPolicy): string {
  // Each rule is copied per map entry: the same rule object in both maps would
  // otherwise serialize as a YAML anchor/alias pair.
  const toEntries = (rules: Map<string, ChannelRule>) =>
    [...rules].map(([id, rule]) => [id, { ...rule }]);
  return stringifyYaml({
    version: policy.version,
    default: { ...policy.default },
    categories: Object.fromEntries(toEntries(policy.categories)),
    channels: Object.fromEntries(toEntries(policy.channels)),
    ...(policy.review_channel !== undefined ? { review_channel: { ...policy.review_channel } } : {}),
  });
}

/** Build the basic policy from the environment and return its YAML form. */
export function basicChannelPolicySourceText(env: NodeJS.ProcessEnv): string {
  return basicChannelPolicyYml(buildBasicChannelPolicy(env));
}
