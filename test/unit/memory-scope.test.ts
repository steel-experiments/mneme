import { describe, it, expect } from 'vitest';
import { computeEffectiveScope, type VisibilityLookup } from '../../src/memory/scope.js';

interface Chan {
  id: string;
  visibility: 'org' | 'restricted' | 'review_only' | 'excluded';
  parent?: string | null;
  isThread?: boolean;
}

function lookup(chans: Chan[]): VisibilityLookup {
  const byId = new Map(chans.map((c) => [c.id, c]));
  return {
    visibilityClass: (id) => byId.get(id)?.visibility,
    parentChannelId: (id) => byId.get(id)?.parent ?? null,
  };
}

function ev(channelId: string, isThread = false) {
  return { channelId, isThread };
}

describe('computeEffectiveScope', () => {
  it('returns org when all evidence is org-scoped', () => {
    const l = lookup([
      { id: 'c1', visibility: 'org' },
      { id: 'c2', visibility: 'org' },
    ]);
    expect(computeEffectiveScope([ev('c1'), ev('c2')], l)).toEqual({
      scopeType: 'org',
      scopeKey: null,
    });
  });

  it('scopes to the single restricted channel', () => {
    const l = lookup([
      { id: 'c1', visibility: 'org' },
      { id: 'c2', visibility: 'restricted' },
    ]);
    expect(computeEffectiveScope([ev('c1'), ev('c2')], l)).toEqual({
      scopeType: 'channel',
      scopeKey: 'c2',
    });
  });

  it('collapses review_only when evidence spans multiple restricted channels', () => {
    const l = lookup([
      { id: 'c1', visibility: 'restricted' },
      { id: 'c2', visibility: 'restricted' },
    ]);
    expect(computeEffectiveScope([ev('c1'), ev('c2')], l)).toEqual({
      scopeType: 'review_only',
      scopeKey: null,
    });
  });

  it('collapses review_only when any evidence is review_only', () => {
    const l = lookup([
      { id: 'c1', visibility: 'org' },
      { id: 'c2', visibility: 'review_only' },
    ]);
    expect(computeEffectiveScope([ev('c1'), ev('c2')], l)).toEqual({
      scopeType: 'review_only',
      scopeKey: null,
    });
  });

  it('normalizes a restricted thread onto its parent scope anchor', () => {
    const l = lookup([
      { id: 'parent', visibility: 'restricted' },
      { id: 'thread', visibility: 'restricted', parent: 'parent', isThread: true },
      { id: 'c2', visibility: 'org' },
    ]);
    // Thread evidence resolves to parent → single restricted anchor → channel scope.
    expect(computeEffectiveScope([ev('thread', true), ev('c2')], l)).toEqual({
      scopeType: 'channel',
      scopeKey: 'parent',
    });
  });

  it('uses the thread\'s resolved visibility and its own anchor below an org parent', () => {
    const l = lookup([
      { id: 'org-parent', visibility: 'org' },
      { id: 'restricted-thread', visibility: 'restricted', parent: 'org-parent', isThread: true },
      { id: 'restricted-parent', visibility: 'restricted' },
      { id: 'org-thread', visibility: 'org', parent: 'restricted-parent', isThread: true },
    ]);
    // A restricted thread below an org parent anchors on itself (Section 7.2).
    expect(computeEffectiveScope([ev('restricted-thread', true)], l)).toEqual({
      scopeType: 'channel',
      scopeKey: 'restricted-thread',
    });
    expect(computeEffectiveScope([ev('org-thread', true)], l)).toEqual({
      scopeType: 'org',
      scopeKey: null,
    });
  });

  it('treats two threads under the same restricted parent as one channel scope', () => {
    const l = lookup([
      { id: 'parent', visibility: 'restricted' },
      { id: 't1', visibility: 'restricted', parent: 'parent', isThread: true },
      { id: 't2', visibility: 'restricted', parent: 'parent', isThread: true },
    ]);
    expect(computeEffectiveScope([ev('t1', true), ev('t2', true)], l)).toEqual({
      scopeType: 'channel',
      scopeKey: 'parent',
    });
  });

  it('fail-closes on excluded evidence', () => {
    const l = lookup([
      { id: 'c1', visibility: 'org' },
      { id: 'c2', visibility: 'excluded' },
    ]);
    expect(computeEffectiveScope([ev('c1'), ev('c2')], l)).toEqual({
      scopeType: 'review_only',
      scopeKey: null,
    });
  });

  it('treats unknown channels as restricted (fail closed) and scopes to them when alone', () => {
    const l = lookup([{ id: 'c1', visibility: 'org' }]);
    expect(computeEffectiveScope([ev('unknown')], l)).toEqual({
      scopeType: 'channel',
      scopeKey: 'unknown',
    });
  });

  it('returns review_only for ambiguous evidence mixing unknown with another restricted channel', () => {
    const l = lookup([
      { id: 'c1', visibility: 'restricted' },
      { id: 'c2', visibility: 'org' },
    ]);
    expect(computeEffectiveScope([ev('c1'), ev('unknown')], l)).toEqual({
      scopeType: 'review_only',
      scopeKey: null,
    });
  });

  it('returns review_only for empty evidence (no provenance)', () => {
    const l = lookup([]);
    expect(computeEffectiveScope([], l)).toEqual({
      scopeType: 'review_only',
      scopeKey: null,
    });
  });
});
