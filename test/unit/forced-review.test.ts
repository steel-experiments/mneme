import { describe, it, expect } from 'vitest';
import {
  evaluateForcedReview,
  STRONG_EVIDENCE_THRESHOLD,
  type ForcedReviewInput,
} from '../../src/agent/policy.js';
import { discordFormat } from '../../src/platform/discord/format.js';

/**
 * Forced secure-review classification (Section 24.3).
 *
 * Acceptance: every Section 24.3 forced-review case bypasses autonomous delivery
 * even when score and limits otherwise pass. The classifier is independent of
 * score/limits — it reads only proposal characteristics the host computes.
 */

function base(over: Partial<ForcedReviewInput> = {}): ForcedReviewInput {
  return {
    message: 'A reasonable, neutral intervention message.',
    format: discordFormat,
    reason: 'routine reminder',
    urgency: 'normal',
    evidenceStrength: 0.8,
    distinctRestrictedChannelCount: 0,
    uncertain: false,
    ...over,
  };
}

function rules(input: ForcedReviewInput): string[] {
  return evaluateForcedReview(input).rules.map((r) => r.rule);
}

describe('evaluateForcedReview — clean proposal', () => {
  it('forces nothing for a clean, well-evidenced proposal', () => {
    const r = evaluateForcedReview(base());
    expect(r.forceReview).toBe(false);
    expect(r.rules).toEqual([]);
  });

  it('score-independence: a high-evidence critical proposal with strong evidence is not forced on that rule', () => {
    const r = evaluateForcedReview(
      base({ urgency: 'critical_review', evidenceStrength: STRONG_EVIDENCE_THRESHOLD }),
    );
    expect(r.rules.some((x) => x === 'critical_without_strong_evidence')).toBe(false);
  });
});

describe('evaluateForcedReview — mixed restricted scopes', () => {
  it('forces review when the run touched two or more restricted channels', () => {
    expect(rules(base({ distinctRestrictedChannelCount: 2 }))).toContain('mixed_restricted_scopes');
  });

  it('does not force on a single restricted channel', () => {
    expect(rules(base({ distinctRestrictedChannelCount: 1 }))).not.toContain('mixed_restricted_scopes');
  });
});

describe('evaluateForcedReview — validation uncertainty', () => {
  it('forces review on any host validation uncertainty', () => {
    expect(rules(base({ uncertain: true }))).toContain('validation_uncertainty');
  });
});

describe('evaluateForcedReview — critical urgency without strong evidence', () => {
  it('forces review when critical urgency lacks strong evidence', () => {
    expect(
      rules(base({ urgency: 'critical_review', evidenceStrength: 0.4 })),
    ).toContain('critical_without_strong_evidence');
  });

  it('does not force for non-critical urgency regardless of evidence', () => {
    expect(
      rules(base({ urgency: 'time_sensitive', evidenceStrength: 0.1 })),
    ).not.toContain('critical_without_strong_evidence');
  });
});

describe('evaluateForcedReview — sensitive domains', () => {
  it.each([
    ['legal', 'we may face a lawsuit over this'],
    ['security', 'this looks like a data breach'],
    ['privacy', 'that posted a home address and salary'],
    ['personnel', 'there may be layoffs next week'],
    ['disciplinary', 'this is a code of conduct matter'],
  ])('forces review for the %s domain', (domain, message) => {
    const r = evaluateForcedReview(base({ message }));
    expect(r.rules.some((x) => x.rule === 'sensitive_domain' && x.detail === domain)).toBe(true);
  });

  it('scans the model reason too, not just the message', () => {
    const r = evaluateForcedReview(base({ message: 'heads up', reason: 'possible litigation' }));
    expect(r.rules.some((x) => x.rule === 'sensitive_domain')).toBe(true);
  });

  it('does not false-fire on substring lookalikes (issue ≠ sue, canada ≠ nda)', () => {
    expect(rules(base({ message: 'this is an issue with canada routing' }))).not.toContain(
      'sensitive_domain',
    );
  });
});

describe('evaluateForcedReview — naming an individual negatively', () => {
  it('forces review when a mention token and a negative term both appear', () => {
    const r = rules(base({ message: '<@111111111111111111> failed the deploy' }));
    expect(r).toContain('names_individual_negatively');
  });

  it('forces review for a resolved individual name in a negative context', () => {
    const r = rules(
      base({
        message: 'Priya dropped the ball on the release',
        referencedIndividualNames: ['Priya'],
      }),
    );
    expect(r).toContain('names_individual_negatively');
  });

  it('does not force when an individual is named without a negative context', () => {
    const r = rules(
      base({ message: 'Priya is leading the rollout', referencedIndividualNames: ['Priya'] }),
    );
    expect(r).not.toContain('names_individual_negatively');
  });

  it('does not force on a negative term with no individual reference', () => {
    const r = rules(base({ message: 'the deploy failed again' }));
    expect(r).not.toContain('names_individual_negatively');
  });
});

describe('evaluateForcedReview — composition and redaction', () => {
  it('records every rule that fires together', () => {
    const r = evaluateForcedReview(
      base({
        distinctRestrictedChannelCount: 2,
        uncertain: true,
        urgency: 'critical_review',
        evidenceStrength: 0.3,
        message: 'this is a lawsuit',
      }),
    );
    expect(r.forceReview).toBe(true);
    expect(r.rules.length).toBeGreaterThanOrEqual(3);
    expect(new Set(r.rules.map((x) => x.rule)).size).toBe(r.rules.length); // no duplicates of the same rule
  });

  it('never echoes message content in rule details', () => {
    const secret = 'SUPERSECRET-CONTENT';
    const r = evaluateForcedReview(base({ message: `${secret} lawsuit`, uncertain: true }));
    for (const rule of r.rules) {
      expect(rule.detail).not.toContain(secret);
    }
  });

  it('never echoes a referenced individual name in details', () => {
    const name = 'WhistleblowerName';
    const r = evaluateForcedReview(
      base({ message: `${name} failed`, referencedIndividualNames: [name] }),
    );
    for (const rule of r.rules) {
      expect(rule.detail).not.toContain(name);
      expect(rule.detail).not.toContain(name.toLowerCase());
    }
  });
});
