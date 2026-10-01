import { describe, it, expect } from 'vitest';
import {
  detectDuplicate,
  normalizeForDuplicate,
  DEFAULT_NEAR_DUPLICATE_THRESHOLD,
  type RecentMnemeMessage,
} from '../../src/agent/duplicate-policy.js';

/**
 * Recent-message duplicate detection (Sections 7.4 check 9, 24.2).
 *
 * Acceptance: exact and minor-format duplicates are suppressed while
 * substantively different interventions remain eligible.
 */

const NOW = 1_700_000_001_000;
const DAY = 24 * 60 * 60 * 1000;

function recent(content: string, ageMs: number, source: 'outbox' | 'observed' = 'outbox'): RecentMnemeMessage {
  return { content, sentAtMs: NOW - ageMs, source };
}

describe('normalizeForDuplicate', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeForDuplicate('  Hello   World  ')).toBe('hello world');
  });
  it('strips markdown emphasis and code markers', () => {
    expect(normalizeForDuplicate('**bold** and _under_ and `code`')).toBe('bold and under and code');
  });
  it('keeps link labels but drops link urls', () => {
    expect(normalizeForDuplicate('see [the thread](https://discord.com/channels/x/y/z)')).toBe(
      'see the thread',
    );
  });
  it('treats an image as its alt text', () => {
    expect(normalizeForDuplicate('![diagram](https://x/y.png)')).toBe('diagram');
  });
});

describe('detectDuplicate — exact duplicates', () => {
  it('suppresses an exact repeat', () => {
    const r = detectDuplicate({
      content: 'The deploy is blocked on the migration.',
      recentMessages: [recent('The deploy is blocked on the migration.', 60_000)],
      now: NOW,
    });
    expect(r).toMatchObject({ matched: true, kind: 'exact', similarity: 1 });
  });

  it('treats minor-format differences (case, spacing, bold) as exact', () => {
    const r = detectDuplicate({
      content: 'The **Deploy**   is blocked.',
      recentMessages: [recent('the deploy is blocked', 60_000)],
      now: NOW,
    });
    expect(r).toMatchObject({ matched: true, kind: 'exact' });
  });

  it('reports which source matched (outbox vs observed)', () => {
    const r = detectDuplicate({
      content: 'same',
      recentMessages: [recent('same', 1_000, 'observed')],
      now: NOW,
    });
    expect(r).toMatchObject({ matched: true, source: 'observed' });
  });
});

describe('detectDuplicate — near duplicates', () => {
  it('suppresses a minor rephrasing above the threshold', () => {
    const r = detectDuplicate({
      content: 'The migration is blocked.',
      recentMessages: [recent('The migrations is blocked.', 60_000)],
      now: NOW,
    });
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect(r.kind).toBe('near');
    expect(r.similarity).toBeGreaterThanOrEqual(DEFAULT_NEAR_DUPLICATE_THRESHOLD);
  });

  it('keeps a substantively different intervention eligible', () => {
    const r = detectDuplicate({
      content: 'Onboarding owner changed to Priya — please update the runbook.',
      recentMessages: [recent('The deploy is blocked on the migration.', 60_000)],
      now: NOW,
    });
    expect(r.matched).toBe(false);
  });

  it('a higher threshold rejects a near-duplicate a lower one catches', () => {
    const content = 'The migration is blocked.';
    const recents = [recent('The migrations is blocked.', 60_000)];
    expect(detectDuplicate({ content, recentMessages: recents, now: NOW, threshold: 0.99 }).matched).toBe(
      false,
    );
    expect(detectDuplicate({ content, recentMessages: recents, now: NOW, threshold: 0.9 }).matched).toBe(
      true,
    );
  });
});

describe('detectDuplicate — recency window', () => {
  it('ignores an exact repeat older than the recent window', () => {
    const r = detectDuplicate({
      content: 'same',
      recentMessages: [recent('same', DAY + 1)],
      now: NOW,
    });
    expect(r.matched).toBe(false);
  });

  it('honours a custom window', () => {
    const r = detectDuplicate({
      content: 'same',
      recentMessages: [recent('same', 3 * 60 * 60 * 1000)],
      now: NOW,
      windowMs: 60 * 60 * 1000, // 1h: the 3h-old message is out of window
    });
    expect(r.matched).toBe(false);
  });

  it('returns no match when there are no recent messages', () => {
    expect(detectDuplicate({ content: 'anything', recentMessages: [], now: NOW }).matched).toBe(false);
  });
});

describe('detectDuplicate — selection', () => {
  it('prefers an exact match over a near match among several recents', () => {
    const r = detectDuplicate({
      content: 'The deploy is blocked on the migration.',
      recentMessages: [
        recent('The deploy is blocked on the db migration.', 60_000), // near
        recent('The deploy is blocked on the migration.', 30_000), // exact
      ],
      now: NOW,
    });
    expect(r).toMatchObject({ matched: true, kind: 'exact' });
  });

  it('returns a bounded preview rather than the full content', () => {
    const long = 'x'.repeat(200);
    const r = detectDuplicate({ content: long, recentMessages: [recent(long, 1_000)], now: NOW });
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect(r.matchedPreview.length).toBeLessThan(long.length);
    expect(r.matchedPreview.endsWith('…')).toBe(true);
  });
});
