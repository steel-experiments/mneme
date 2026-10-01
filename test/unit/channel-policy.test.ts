import { describe, it, expect } from 'vitest';
import { parseChannelPolicy, resolveChannel, ChannelPolicyError } from '../../src/policy/channel-policy.js';

const POLICY_YAML = `
version: 1
default:
  ingest: true
  visibility: restricted
  allow_interventions: false
categories:
  "111111111111111111":
    ingest: true
    visibility: org
    allow_interventions: true
  "222222222222222222":
    ingest: false
    visibility: excluded
    allow_interventions: false
channels:
  "333333333333333333":
    ingest: true
    visibility: org
    allow_interventions: true
  "444444444444444444":
    ingest: true
    visibility: restricted
    allow_interventions: true
  "555555555555555555":
    ingest: false
    visibility: excluded
    allow_interventions: false
review_channel:
  id: "666666666666666666"
  secure: true
  accepts_scopes:
    - org
    - restricted
    - review_only
`;

describe('channel-policy', () => {
  const policy = parseChannelPolicy(POLICY_YAML);

  it('uses the explicit channel rule (level 1)', () => {
    const r = resolveChannel(policy, '333333333333333333', { isThread: false });
    expect(r.source).toBe('channel');
    expect(r.rule.visibility).toBe('org');
  });

  it('threads inherit their parent channel class (level 2)', () => {
    // Parent 333... is explicitly org; a thread in it inherits org.
    const r = resolveChannel(policy, '999999999999999999', {
      isThread: true,
      parentId: '333333333333333333',
    });
    expect(r.source).toBe('thread_parent');
    expect(r.rule.visibility).toBe('org');
  });

  it('an explicit thread rule overrides its parent (level 1)', () => {
    const r = resolveChannel(policy, '444444444444444444', {
      isThread: true,
      parentId: '333333333333333333',
      categoryId: '111111111111111111',
    });
    expect(r.source).toBe('channel');
    expect(r.rule.visibility).toBe('restricted');
  });

  it('uses the parent category rule (level 3)', () => {
    // Channel with no explicit rule but in an org category.
    const r = resolveChannel(policy, '777777777777777777', {
      isThread: false,
      categoryId: '111111111111111111',
    });
    expect(r.source).toBe('category');
    expect(r.rule.visibility).toBe('org');
  });

  it('falls back to the restricted default (level 4)', () => {
    const r = resolveChannel(policy, '888888888888888888', { isThread: false });
    expect(r.source).toBe('default');
    expect(r.rule.visibility).toBe('restricted');
    expect(r.rule.allow_interventions).toBe(false);
  });

  it('excluded channels are not ingested', () => {
    const r = resolveChannel(policy, '555555555555555555', { isThread: false });
    expect(r.rule.ingest).toBe(false);
    expect(r.rule.visibility).toBe('excluded');
  });

  it('rejects an invalid visibility enum', () => {
    expect(() => parseChannelPolicy(`version: 1\ndefault:\n  ingest: true\n  visibility: public\n  allow_interventions: false\n`)).toThrow(
      ChannelPolicyError,
    );
  });

  it('rejects an invalid review_channel accepts_scopes entry', () => {
    const bad = POLICY_YAML.replace('- review_only', '- public_scope');
    expect(() => parseChannelPolicy(bad)).toThrow(ChannelPolicyError);
  });

  it('rejects a non-snowflake channel key', () => {
    expect(() =>
      parseChannelPolicy(
        `version: 1\ndefault:\n  ingest: true\n  visibility: restricted\n  allow_interventions: false\nchannels:\n  "not-an-id":\n    ingest: true\n    visibility: org\n    allow_interventions: true\n`,
      ),
    ).toThrow(ChannelPolicyError);
  });
});
