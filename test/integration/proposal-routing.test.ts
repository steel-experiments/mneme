import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import {
  routeProposal,
  type AttentionRoutingInput,
  type LivenessRoutingInput,
  type ProposalRoutingInput,
  type ProposalThresholds,
  type ProposalEligibilityInputs,
  type ProvenanceGateResult,
  type OutboundEvidenceResult,
  type ForcedReviewResult,
} from '../../src/agent/policy.js';
import type { CooldownDecision } from '../../src/agent/cooldowns.js';
import type { DuplicateResult } from '../../src/agent/duplicate-policy.js';
import { insertProposal, getProposal } from '../../src/db/repositories/proposals.js';

/**
 * Deployment-mode proposal routing (Sections 24.2, 24.3, 24.4).
 *
 * Acceptance: observe sends nothing, review sends only to secure review, and
 * autonomous queues target output only after every deterministic check passes.
 * `routeProposal` is a pure composition over precomputed sub-results, so the
 * routing tests pass hand-built gate outcomes; one group exercises persistence
 * of the routed state through the proposals repository.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded restricted channel
const NOW = 1_700_000_001_000;

const THRESHOLDS: ProposalThresholds = {
  score: 0.5,
  confidence: 0.6,
  evidenceStrength: 0.65,
  maxContentLength: 1800,
};

/** Eligible defaults: all-positive dimensions with no interruption cost (score 0.8). */
const ELIGIBLE: ProposalEligibilityInputs = {
  recommend: true,
  dimensions: {
    impact: 0.8,
    evidenceStrength: 0.8,
    contradictionStrength: 0.8,
    urgency: 0.8,
    novelty: 0.8,
    interruptionCost: 0,
  },
  confidence: 0.9,
  evidenceStrength: 0.8,
  evidenceCount: 2,
  contentLength: 200,
  hasDisallowedMention: false,
};

const ALLOW_PROVENANCE: ProvenanceGateResult = { outcome: 'allow', reasons: [] };
const ALLOW_OUTBOUND: OutboundEvidenceResult = { outcome: 'allow', reasons: [] };
const NO_FORCED: ForcedReviewResult = { forceReview: false, rules: [] };
/** An admitted attention revision (Section 12.7). */
const ADMITTED_ATTENTION: AttentionRoutingInput = {
  required: true,
  eligible: true,
  revisionId: 'rev-1',
  windowFromMs: NOW - 1000,
  windowUntilMs: NOW + 7 * 86_400_000,
};
const ALLOWED_COOLDOWN: CooldownDecision = { allowed: true, blocks: [], retryAfterMs: null };
const NO_DUPLICATE: DuplicateResult = { matched: false };

const REJECT_PROVENANCE: ProvenanceGateResult = {
  outcome: 'reject',
  reasons: ['proposed target does not match the host-pinned target'],
};
const FORCE_REVIEW_PROVENANCE: ProvenanceGateResult = {
  outcome: 'force_review',
  reasons: ['retrieved restricted scope not permitted in target'],
};
const FORCED_REVIEW: ForcedReviewResult = {
  forceReview: true,
  rules: [{ rule: 'sensitive_domain', detail: 'legal' }],
};
const BLOCKED_COOLDOWN: CooldownDecision = {
  allowed: false,
  blocks: [
    { rule: 'channel_cooldown', retryAfterMs: NOW + 60_000, detail: 'channel on cooldown' },
  ],
  retryAfterMs: NOW + 60_000,
};
const DUPLICATE: DuplicateResult = {
  matched: true,
  kind: 'near',
  similarity: 0.93,
  matchedPreview: 'we decided to ship',
  matchedSentAtMs: NOW,
  source: 'outbox',
};

const SETTLED: LivenessRoutingInput = { settled: true, idleMs: 30 * 60_000 };
const LIVE: LivenessRoutingInput = { settled: false, idleMs: 45_000 };

function routingInput(over: Partial<ProposalRoutingInput> = {}): ProposalRoutingInput {
  return {
    mode: 'autonomous',
    thresholds: THRESHOLDS,
    eligibility: ELIGIBLE,
    provenanceGate: ALLOW_PROVENANCE,
    outboundEvidence: ALLOW_OUTBOUND,
    forcedReview: NO_FORCED,
    cooldown: ALLOWED_COOLDOWN,
    duplicate: NO_DUPLICATE,
    attention: ADMITTED_ATTENTION,
    liveness: SETTLED,
    ...over,
  };
}

describe('routeProposal — mode behavior', () => {
  it('observe mode stores an eligible proposal without sending (observed)', () => {
    const out = routeProposal(routingInput({ mode: 'observe' }));
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('observe mode'))).toBe(true);
    expect(out.score).toBeCloseTo(0.8, 3);
  });

  it('review mode routes an eligible proposal to secure review (pending_review)', () => {
    const out = routeProposal(routingInput({ mode: 'review' }));
    expect(out.state).toBe('pending_review');
  });

  it('autonomous mode approves an eligible proposal after every check passes', () => {
    const out = routeProposal(routingInput({ mode: 'autonomous' }));
    expect(out.state).toBe('approved');
    expect(out.reasons).toEqual(['all deterministic checks passed']);
  });
});

describe('routeProposal — ineligibility suppresses in every mode', () => {
  it('suppresses when the model did not recommend', () => {
    const out = routeProposal(
      routingInput({ mode: 'autonomous', eligibility: { ...ELIGIBLE, recommend: false } }),
    );
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('did not recommend'))).toBe(true);
  });

  it('suppresses when the computed score is below threshold', () => {
    const out = routeProposal(
      routingInput({ thresholds: { ...THRESHOLDS, score: 0.95 } }),
    );
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('below threshold'))).toBe(true);
  });

  it('suppresses when evidence strength is below the minimum', () => {
    const out = routeProposal(
      routingInput({ eligibility: { ...ELIGIBLE, evidenceStrength: 0.4 } }),
    );
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('evidence strength'))).toBe(true);
  });

  it('suppresses when there is no valid evidence', () => {
    const out = routeProposal(
      routingInput({ eligibility: { ...ELIGIBLE, evidenceCount: 0 } }),
    );
    expect(out.state).toBe('observed');
  });

  it('suppresses when the content length exceeds the maximum', () => {
    const out = routeProposal(
      routingInput({ eligibility: { ...ELIGIBLE, contentLength: 5000 } }),
    );
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('content length'))).toBe(true);
  });
});

describe('routeProposal — scope gates', () => {
  it('a rejected provenance gate suppresses even in review mode', () => {
    const out = routeProposal(routingInput({ mode: 'review', provenanceGate: REJECT_PROVENANCE }));
    expect(out.state).toBe('observed');
    expect(out.reasons).toEqual(REJECT_PROVENANCE.reasons);
  });

  it('an uncertain provenance gate forces secure review in autonomous mode', () => {
    const out = routeProposal(
      routingInput({ mode: 'autonomous', provenanceGate: FORCE_REVIEW_PROVENANCE }),
    );
    expect(out.state).toBe('pending_review');
    expect(out.reasons).toContain(FORCE_REVIEW_PROVENANCE.reasons[0]);
  });

  it('a forced-review classification diverts an autonomous proposal to review', () => {
    const out = routeProposal(routingInput({ mode: 'autonomous', forcedReview: FORCED_REVIEW }));
    expect(out.state).toBe('pending_review');
    expect(out.reasons.some((r) => r.includes('forced review (sensitive_domain)'))).toBe(true);
  });

  it('forced review takes precedence over an otherwise-eligible autonomous send', () => {
    // Same proposal would be approved; the sensitive-domain rule still diverts it.
    const approved = routeProposal(routingInput({ mode: 'autonomous' }));
    expect(approved.state).toBe('approved');
    const diverted = routeProposal(
      routingInput({ mode: 'autonomous', forcedReview: FORCED_REVIEW }),
    );
    expect(diverted.state).toBe('pending_review');
  });
});

describe('routeProposal — rate controls bind autonomous delivery only', () => {
  it('a channel cooldown suppresses an autonomous proposal to observed', () => {
    const out = routeProposal(routingInput({ mode: 'autonomous', cooldown: BLOCKED_COOLDOWN }));
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('rate-limited (channel_cooldown)'))).toBe(true);
  });

  it('a near-duplicate suppresses an autonomous proposal to observed', () => {
    const out = routeProposal(routingInput({ mode: 'autonomous', duplicate: DUPLICATE }));
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('duplicate'))).toBe(true);
  });

  it('review mode is not rate-gated: a blocked cooldown still routes to review', () => {
    const out = routeProposal(routingInput({ mode: 'review', cooldown: BLOCKED_COOLDOWN }));
    expect(out.state).toBe('pending_review');
  });

  it('forced review still diverts to review even when a cooldown is also active', () => {
    const out = routeProposal(
      routingInput({ mode: 'autonomous', forcedReview: FORCED_REVIEW, cooldown: BLOCKED_COOLDOWN }),
    );
    expect(out.state).toBe('pending_review');
  });

  // Section 11.8: a conversation that is still in progress does not need
  // Mneme, and a review card is gated exactly like a target send.
  it('a live conversation suppresses an autonomous proposal to observed', () => {
    const out = routeProposal(routingInput({ mode: 'autonomous', liveness: LIVE }));
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('conversation_live'))).toBe(true);
  });

  it('a live conversation suppresses a review card too', () => {
    const out = routeProposal(routingInput({ mode: 'review', liveness: LIVE }));
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('conversation_live'))).toBe(true);
  });

  it('a live conversation suppresses a forced-review proposal', () => {
    const out = routeProposal(
      routingInput({ mode: 'autonomous', forcedReview: FORCED_REVIEW, liveness: LIVE }),
    );
    expect(out.state).toBe('observed');
    expect(out.reasons.some((r) => r.includes('conversation_live'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Persistence: the routed state is stored as a proposals row.
// ---------------------------------------------------------------------------

let env: TestDb;

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db);
});
afterEach(() => env.cleanup());

function seedRun(id = 'run-1'): string {
  env.db
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, episode_id, run_type, prompt_version, provider, model, status, started_at_ms)
       VALUES (?,?,NULL,'episode','pv','faux','faux-1','completed',?)`,
    )
    .run(id, GUILD, NOW);
  return id;
}

describe('insertProposal / getProposal — persists the routed state', () => {
  it('stores and reads back an approved proposal with mapped fields', () => {
    seedRun('run-approved');
    const id = insertProposal(env.db, {
      runId: 'run-approved',
      targetChannelId: CHANNEL,
      status: 'approved',
      computedScore: 0.812,
      reason: ['all deterministic checks passed'],
      message: 'Heads up: this supersedes the onboarding decision.',
      evidenceMessageIds: ['m1', 'm2'],
      now: NOW,
    });
    const row = getProposal(env.db, id);
    expect(row).toBeDefined();
    const p = row!;
    expect(p.status).toBe('approved');
    expect(p.runId).toBe('run-approved');
    expect(p.targetChannelId).toBe(CHANNEL);
    expect(p.episodeId).toBeNull();
    expect(p.computedScore).toBeCloseTo(0.812, 3);
    expect(p.reason).toBe('all deterministic checks passed');
    expect(p.evidenceMessageIds).toEqual(['m1', 'm2']);
    expect(p.message).toContain('supersedes');
    expect(p.createdAtMs).toBe(NOW);
    expect(p.updatedAtMs).toBe(NOW);
  });

  it('accepts every routed state the CHECK constraint permits', () => {
    seedRun('run-states');
    for (const status of ['observed', 'pending_review', 'approved'] as const) {
      const id = insertProposal(env.db, {
        runId: 'run-states',
        targetChannelId: CHANNEL,
        status,
        computedScore: 0.5,
        reason: `state ${status}`,
        evidenceMessageIds: [],
        now: NOW,
      });
      expect(getProposal(env.db, id)!.status).toBe(status);
    }
  });

  it('persists the routing result of a real routeProposal call', () => {
    seedRun('run-routed');
    const routed = routeProposal(routingInput({ mode: 'autonomous' }));
    expect(routed.state).toBe('approved');

    const id = insertProposal(env.db, {
      runId: 'run-routed',
      targetChannelId: CHANNEL,
      status: routed.state,
      computedScore: routed.score,
      reason: routed.reasons,
      message: null, // approved; the outbox enqueue supplies content
      evidenceMessageIds: ['m1', 'm2'],
      now: NOW,
    });
    const stored = getProposal(env.db, id)!;
    expect(stored.status).toBe('approved');
    expect(stored.computedScore).toBeCloseTo(routed.score, 3);
    expect(stored.reason).toBe('all deterministic checks passed');
  });

  it('persists an observe-mode proposal as observed with its suppression reasons', () => {
    seedRun('run-observe');
    const routed = routeProposal(
      routingInput({ mode: 'observe', eligibility: { ...ELIGIBLE, recommend: false } }),
    );
    expect(routed.state).toBe('observed');
    const id = insertProposal(env.db, {
      runId: 'run-observe',
      targetChannelId: CHANNEL,
      status: routed.state,
      computedScore: routed.score,
      reason: routed.reasons,
      evidenceMessageIds: [],
      now: NOW,
    });
    const stored = getProposal(env.db, id)!;
    expect(stored.status).toBe('observed');
    expect(stored.reason).toContain('did not recommend');
    expect(stored.message).toBeNull();
  });
});

describe('routeProposal — proactive attention gate — Section 12.7', () => {
  const DENIED: AttentionRoutingInput = {
    required: true,
    eligible: false,
    reason: 'no_recent_human_trigger',
  };

  it('suppresses an ineligible recommendation to observed in review mode', () => {
    const result = routeProposal(routingInput({ mode: 'review', attention: DENIED }));
    expect(result.state).toBe('observed');
    expect(result.reasons.some((r) => r.includes('attention gate (no_recent_human_trigger)'))).toBe(true);
  });

  it('suppresses an ineligible recommendation before forced-review routing', () => {
    const result = routeProposal(routingInput({
      forcedReview: FORCED_REVIEW,
      attention: DENIED,
    }));
    expect(result.state).toBe('observed');
    expect(result.reasons.some((r) => r.includes('attention gate'))).toBe(true);
  });

  it('suppresses an ineligible recommendation despite an allowed cooldown and no duplicate', () => {
    const result = routeProposal(routingInput({ attention: DENIED }));
    expect(result.state).toBe('observed');
  });

  it('does not gate proposals that carry no attention requirement', () => {
    const result = routeProposal(routingInput({
      attention: { required: false, eligible: true },
    }));
    expect(result.state).toBe('approved');
  });

  it('a consumed revision is suppressed with its own reason code', () => {
    const result = routeProposal(routingInput({
      attention: { required: true, eligible: false, reason: 'revision_consumed' },
    }));
    expect(result.state).toBe('observed');
    expect(result.reasons.some((r) => r.includes('revision_consumed'))).toBe(true);
  });
});
