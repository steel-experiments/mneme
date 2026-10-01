import { describe, it, expect } from 'vitest';
import {
  computePromptVersion,
  PromptCompiler,
  PARTIAL_NAMES,
  type PromptFiles,
  type PromptVersionParts,
} from '../../src/agent/prompts.js';

/**
 * Complete prompt-version hashing (Sections 15.2, 48).
 *
 * Acceptance: the hash is stable for identical files and changes when any prompt,
 * partial, personality, or channel-policy input changes — with no boundary collision.
 */

const base: PromptVersionParts = {
  system: 'system-v1',
  taskTemplate: 'review-v1',
  partials: ['personality-v1', 'boundaries-v1', 'memory-taxonomy-v1'],
  mnemeYml: 'mneme: v1',
  channelPolicyYml: 'default: restricted',
};

describe('computePromptVersion — stability', () => {
  it('is identical for identical inputs (including an equal partials copy)', () => {
    expect(computePromptVersion(base)).toBe(computePromptVersion({ ...base, partials: [...base.partials] }));
  });

  it('produces a 64-character hex SHA-256', () => {
    expect(computePromptVersion(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computePromptVersion — changes on any single input', () => {
  const v = computePromptVersion(base);

  it.each([
    ['system', { system: 'system-v2' }],
    ['taskTemplate', { taskTemplate: 'review-v2' }],
    ['mnemeYml', { mnemeYml: 'mneme: v2' }],
    ['channelPolicyYml', { channelPolicyYml: 'default: org' }],
  ] as const)('changes when %s changes', (_name, over) => {
    expect(computePromptVersion({ ...base, ...over })).not.toBe(v);
  });

  it('changes when any individual partial changes', () => {
    for (let i = 0; i < base.partials.length; i += 1) {
      const partials = [...base.partials];
      partials[i] = `${partials[i]}-changed`;
      expect(computePromptVersion({ ...base, partials })).not.toBe(v);
    }
  });

  it('changes when partial order changes', () => {
    const reversed = [...base.partials].reverse();
    expect(computePromptVersion({ ...base, partials: reversed })).not.toBe(v);
  });

  it('changes when the partial count changes', () => {
    expect(computePromptVersion({ ...base, partials: base.partials.slice(0, 2) })).not.toBe(v);
  });
});

describe('computePromptVersion — boundary collisions', () => {
  it('distinguishes inputs whose naive concatenation would be identical (delimiter in content)', () => {
    // A plain space/newline join would make these equal: "a b" + "c" == "a" + "b c".
    const a = computePromptVersion({ system: 'a b', taskTemplate: 'c', partials: [] });
    const b = computePromptVersion({ system: 'a', taskTemplate: 'b c', partials: [] });
    expect(a).not.toBe(b);
  });

  it('distinguishes inputs that differ only by section boundary placement', () => {
    const a = computePromptVersion({ system: 'ab', taskTemplate: 'c', partials: [] });
    const b = computePromptVersion({ system: 'a', taskTemplate: 'bc', partials: [] });
    expect(a).not.toBe(b);
  });

  it('distinguishes a partial containing a delimiter from a boundary shift', () => {
    // "p1\np2" as one partial vs "p1" + "p2" as two partials must not collide.
    const one = computePromptVersion({ system: 's', taskTemplate: 't', partials: ['p1\np2'] });
    const two = computePromptVersion({ system: 's', taskTemplate: 't', partials: ['p1', 'p2'] });
    expect(one).not.toBe(two);
  });

  it('treats an absent YAML the same as an empty YAML (normalized)', () => {
    const absent = computePromptVersion({ system: 's', taskTemplate: 't', partials: [] });
    const empty = computePromptVersion({
      system: 's',
      taskTemplate: 't',
      partials: [],
      mnemeYml: '',
      channelPolicyYml: '',
    });
    expect(absent).toBe(empty);
  });
});

describe('PromptCompiler.versionFor', () => {
  function files(over: Partial<PromptFiles> = {}): PromptFiles {
    return {
      system: 'SYS',
      'episode-review': 'EP',
      'direct-answer': 'DA',
      'scheduled-review': 'SR',
      partials: { personality: 'P', boundaries: 'B', 'memory-taxonomy': 'M' },
      ...over,
    } as PromptFiles;
  }

  it('changes when the selected task template changes', () => {
    const c = new PromptCompiler(files());
    expect(c.versionFor('episode-review')).not.toBe(c.versionFor('direct-answer'));
    expect(c.versionFor('direct-answer')).not.toBe(c.versionFor('scheduled-review'));
  });

  it('changes when any partial changes', () => {
    const base = new PromptCompiler(files());
    const p2 = new PromptCompiler(files({ partials: { personality: 'P2', boundaries: 'B', 'memory-taxonomy': 'M' } }));
    const b2 = new PromptCompiler(files({ partials: { personality: 'P', boundaries: 'B2', 'memory-taxonomy': 'M' } }));
    const m2 = new PromptCompiler(files({ partials: { personality: 'P', boundaries: 'B', 'memory-taxonomy': 'M2' } }));
    for (const t of ['episode-review', 'direct-answer', 'scheduled-review'] as const) {
      expect(p2.versionFor(t)).not.toBe(base.versionFor(t));
      expect(b2.versionFor(t)).not.toBe(base.versionFor(t));
      expect(m2.versionFor(t)).not.toBe(base.versionFor(t));
    }
  });

  it('changes when the system template changes', () => {
    const c1 = new PromptCompiler(files());
    const c2 = new PromptCompiler(files({ system: 'SYS2' }));
    expect(c1.versionFor('episode-review')).not.toBe(c2.versionFor('episode-review'));
  });

  it('integrates mnemeYml and channelPolicyYml into the version', () => {
    const c = new PromptCompiler(files());
    const v = c.versionFor('episode-review');
    expect(c.versionFor('episode-review', { mnemeYml: 'C' })).not.toBe(v);
    expect(c.versionFor('episode-review', { channelPolicyYml: 'CP' })).not.toBe(v);
    expect(c.versionFor('episode-review', { mnemeYml: 'C', channelPolicyYml: 'CP' })).not.toBe(v);
  });

  it('is stable across compiler instances built from the same files, for every task', () => {
    const c1 = new PromptCompiler(files());
    const c2 = new PromptCompiler(files());
    for (const t of ['system', 'episode-review', 'direct-answer', 'scheduled-review'] as const) {
      expect(c1.versionFor(t)).toBe(c2.versionFor(t));
    }
  });

  it('reads partials in the canonical PARTIAL_NAMES order', () => {
    expect(PARTIAL_NAMES).toEqual(['personality', 'boundaries', 'memory-taxonomy']);
  });
});
