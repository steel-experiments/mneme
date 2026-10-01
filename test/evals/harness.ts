/**
 * Versioned prompt evaluation harness (Sections 46.4, 47; task T117).
 *
 * The harness is fully deterministic and never calls a live model. Each fixture
 * in {@link episodes.json} carries the model's *response* for every prompt
 * version being compared; the harness applies Mneme's deterministic host
 * rules (visibility, deployment mode, evidence, intervention threshold) to derive
 * the outcome, then aggregates the Section 46.4 quality metrics per version.
 *
 * Tracked metrics: intervention precision, unnecessary-interruption rate,
 * valid-evidence rate, memory-duplication rate, privacy violations, human
 * approval rate, dismissal reasons, average response length, and cost per
 * reviewed episode. A version may roll forward to autonomous rollout only once
 * privacy violations are zero and precision clears the configured bar.
 */

export type EvalLabel =
  | 'silent'
  | 'memory_only'
  | 'review'
  | 'autonomous'
  | 'lifecycle_update'
  | 'visibility_refusal';

/** The six mandatory Section 46.4 labels. */
export const REQUIRED_LABELS: readonly EvalLabel[] = [
  'silent',
  'memory_only',
  'review',
  'autonomous',
  'lifecycle_update',
  'visibility_refusal',
];

/**
 * Outcomes the host considers correct for a given scenario label. A restricted
 * scenario (visibility_refusal) is correctly handled either by the host refusing
 * a leaky model proposal, or by the model proposing nothing at all — both are
 * privacy-safe, so `silent` is an acceptable resolution there too.
 */
const ACCEPTABLE_OUTCOMES: Record<EvalLabel, readonly EvalOutcome[]> = {
  silent: ['silent'],
  memory_only: ['memory_only'],
  review: ['review'],
  autonomous: ['autonomous'],
  lifecycle_update: ['lifecycle_update'],
  visibility_refusal: ['visibility_refusal', 'silent'],
};

export type VisibilityClass = 'org' | 'restricted' | 'review_only' | 'excluded';
export type AutonomyMode = 'observe' | 'review' | 'autonomous';

export interface EvalThresholds {
  interventionConfidence: number;
  minEvidenceStrength: number;
  minPrecision: number;
}

export interface EvalMemory {
  id: string;
  text: string;
  /** When set, this memory supersedes an earlier one (lifecycle update). */
  supersededId?: string;
}

export interface EvalNotification {
  recommend: boolean;
  confidence: number;
  targetVisibility: VisibilityClass;
  /** True when the cited evidence originates from a restricted source. */
  evidenceRestricted: boolean;
  evidenceStrength: number;
  evidenceMessageIds: string[];
  /** Human verdict on a review proposal, when known. */
  verdict?: 'approved' | 'dismissed';
  dismissalReason?: string;
}

export interface EvalMockResponse {
  memories: EvalMemory[];
  notification: EvalNotification | null;
  /** Marked when the memory duplicates an existing stored memory. */
  duplicate?: boolean;
  costUsd: number;
  responseLengthChars: number;
}

export interface EvalFixture {
  id: string;
  label: EvalLabel;
  visibility: VisibilityClass;
  mode: AutonomyMode;
  conversationMessageCount: number;
  /** Marker on the fixture itself, mirroring a duplicate flag in the response. */
  duplicateMemory?: boolean;
  responses: Record<string, EvalMockResponse>;
}

export interface EvalSet {
  version: string;
  description?: string;
  promptVersions: string[];
  thresholds: EvalThresholds;
  episodes: EvalFixture[];
}

/** The deterministic host-derived outcome for one fixture under one version. */
export type EvalOutcome = EvalLabel;

export interface EpisodeEvaluation {
  fixtureId: string;
  label: EvalLabel;
  outcome: EvalOutcome;
  correct: boolean;
  interrupted: boolean;
  proposedIntervention: boolean;
  correctIntervention: boolean;
  validEvidence: boolean;
  duplicateMemory: boolean;
  privacyViolation: boolean;
  approved?: boolean;
  dismissed?: boolean;
  dismissalReason?: string;
  costUsd: number;
  responseLengthChars: number;
  reviewed: boolean;
}

export interface Metrics {
  episodeCount: number;
  interventionPrecision: number;
  unnecessaryInterruptionRate: number;
  validEvidenceRate: number;
  memoryDuplicationRate: number;
  privacyViolations: number;
  humanApprovalRate: number;
  dismissalReasons: Record<string, number>;
  averageResponseLength: number;
  costPerReviewedEpisode: number;
  labelAccuracy: number;
}

export interface VersionReport {
  promptVersion: string;
  metrics: Metrics;
  evaluations: EpisodeEvaluation[];
}

export interface VersionComparison {
  baseline: string;
  candidate: string;
  better: string[];
  worse: string[];
  baselineReady: boolean;
  candidateReady: boolean;
}

const DEFAULT_THRESHOLDS: EvalThresholds = {
  interventionConfidence: 0.78,
  minEvidenceStrength: 0.65,
  minPrecision: 0.8,
};

/** Parse and lightly validate a fixture set. Throws on a missing required label. */
export function loadEvalSet(input: unknown): EvalSet {
  const set = input as EvalSet;
  if (!set || typeof set !== 'object') throw new Error('eval set must be an object');
  if (!Array.isArray(set.episodes)) throw new Error('eval set.episodes must be an array');
  if (!Array.isArray(set.promptVersions) || set.promptVersions.length === 0) {
    throw new Error('eval set.promptVersions must be a non-empty array');
  }
  const labels = new Set(set.episodes.map((e) => e.label));
  const missing = REQUIRED_LABELS.filter((l) => !labels.has(l));
  if (missing.length > 0) {
    throw new Error(`eval set is missing required labels: ${missing.join(', ')}`);
  }
  set.thresholds = { ...DEFAULT_THRESHOLDS, ...set.thresholds };
  return set;
}

/**
 * Apply Mneme's deterministic host rules to a mock response and return the
 * derived outcome plus the per-episode metric inputs. This mirrors (without
 * importing) the deployment-mode routing and visibility refusal logic so the
 * harness stays self-contained and mockable.
 */
export function evaluateFixture(fixture: EvalFixture, mock: EvalMockResponse, thresholds: EvalThresholds): EpisodeEvaluation {
  const outcome = deriveOutcome(fixture, mock, thresholds);
  const interrupted = outcome === 'review' || outcome === 'autonomous';
  const proposedIntervention = mock.notification !== null && mock.notification.recommend;
  const correctIntervention =
    proposedIntervention && (fixture.label === 'review' || fixture.label === 'autonomous') && outcome === fixture.label;
  const validEvidence =
    mock.notification !== null &&
    mock.notification.evidenceMessageIds.length > 0 &&
    mock.notification.evidenceStrength >= thresholds.minEvidenceStrength;
  // Whether this response duplicated an existing memory is a per-version model
  // property (mock.duplicate); the fixture's duplicateMemory marker is only a
  // dataset annotation and must not force every version to look duplicative.
  const duplicateMemory = mock.duplicate === true;
  // A privacy violation is a model proposal that would expose restricted evidence
  // to a broader (org) scope — whether or not the host correctly refused it.
  const privacyViolation =
    mock.notification !== null && mock.notification.evidenceRestricted && mock.notification.targetVisibility === 'org';
  const reviewed = mock.memories.length > 0 || mock.notification !== null;

  return {
    fixtureId: fixture.id,
    label: fixture.label,
    outcome,
    correct: ACCEPTABLE_OUTCOMES[fixture.label].includes(outcome),
    interrupted,
    proposedIntervention,
    correctIntervention,
    validEvidence,
    duplicateMemory,
    privacyViolation,
    approved: mock.notification?.verdict === 'approved' ? true : undefined,
    dismissed: mock.notification?.verdict === 'dismissed' ? true : undefined,
    dismissalReason: mock.notification?.dismissalReason,
    costUsd: mock.costUsd,
    responseLengthChars: mock.responseLengthChars,
    reviewed,
  };
}

/** Derive the deterministic outcome from a mock response (the host rules). */
function deriveOutcome(fixture: EvalFixture, mock: EvalMockResponse, thresholds: EvalThresholds): EvalOutcome {
  const notification = mock.notification;
  if (!notification || !notification.recommend) {
    if (mock.memories.length === 0) return 'silent';
    return mock.memories.some((m) => m.supersededId !== undefined) ? 'lifecycle_update' : 'memory_only';
  }
  // Restricted evidence must never be proposed to a broader (org) scope.
  if (notification.evidenceRestricted && notification.targetVisibility === 'org') {
    return 'visibility_refusal';
  }
  if (
    fixture.mode === 'autonomous' &&
    notification.confidence >= thresholds.interventionConfidence &&
    !notification.evidenceRestricted
  ) {
    return 'autonomous';
  }
  return 'review';
}

/** Aggregate the Section 46.4 metrics over a set of per-episode evaluations. */
export function computeMetrics(evaluations: EpisodeEvaluation[]): Metrics {
  const n = evaluations.length;
  const proposed = evaluations.filter((e) => e.proposedIntervention);
  const interruptions = evaluations.filter((e) => e.interrupted);
  const unnecessary = interruptions.filter((e) => e.label === 'silent');
  const valid = proposed.filter((e) => e.validEvidence);
  const memoryEpisodes = evaluations.filter((e) => e.outcome === 'memory_only' || e.outcome === 'lifecycle_update');
  const duplicates = memoryEpisodes.filter((e) => e.duplicateMemory);
  const reviewed = evaluations.filter((e) => e.reviewed);
  const verdicts = evaluations.filter((e) => e.approved || e.dismissed);
  const approved = verdicts.filter((e) => e.approved);

  const dismissalReasons: Record<string, number> = {};
  for (const e of evaluations) {
    if (e.dismissalReason) dismissalReasons[e.dismissalReason] = (dismissalReasons[e.dismissalReason] ?? 0) + 1;
  }

  const interventionPrecision = proposed.length > 0 ? evaluations.filter((e) => e.correctIntervention).length / proposed.length : 1;
  const labelAccuracy = n > 0 ? evaluations.filter((e) => e.correct).length / n : 0;

  return {
    episodeCount: n,
    interventionPrecision,
    unnecessaryInterruptionRate: interruptions.length > 0 ? unnecessary.length / interruptions.length : 0,
    validEvidenceRate: proposed.length > 0 ? valid.length / proposed.length : 1,
    memoryDuplicationRate: memoryEpisodes.length > 0 ? duplicates.length / memoryEpisodes.length : 0,
    privacyViolations: evaluations.filter((e) => e.privacyViolation).length,
    humanApprovalRate: verdicts.length > 0 ? approved.length / verdicts.length : 0,
    dismissalReasons,
    averageResponseLength: n > 0 ? evaluations.reduce((s, e) => s + e.responseLengthChars, 0) / n : 0,
    costPerReviewedEpisode: reviewed.length > 0 ? reviewed.reduce((s, e) => s + e.costUsd, 0) / reviewed.length : 0,
    labelAccuracy,
  };
}

/** Evaluate every episode under one prompt version and aggregate its metrics. */
export function runVersion(set: EvalSet, promptVersion: string): VersionReport {
  if (!set.promptVersions.includes(promptVersion)) {
    throw new Error(`unknown prompt version: ${promptVersion}`);
  }
  const evaluations = set.episodes.map((fixture) => {
    const mock = fixture.responses[promptVersion];
    if (!mock) throw new Error(`fixture ${fixture.id} has no response for version ${promptVersion}`);
    return evaluateFixture(fixture, mock, set.thresholds);
  });
  return { promptVersion, metrics: computeMetrics(evaluations), evaluations };
}

/** True when a version is cleared for autonomous rollout (Section 46.4). */
export function canRollForward(metrics: Metrics, thresholds: EvalThresholds = DEFAULT_THRESHOLDS): boolean {
  return metrics.privacyViolations === 0 && metrics.interventionPrecision >= thresholds.minPrecision;
}

/**
 * Compare two versions on the metrics that matter for rollout. Returns the
 * metric names that got better and worse, plus each version's rollout readiness.
 */
export function compareVersions(baseline: VersionReport, candidate: VersionReport): VersionComparison {
  const keys: Array<keyof Metrics> = [
    'interventionPrecision',
    'validEvidenceRate',
    'humanApprovalRate',
    'labelAccuracy',
    'averageResponseLength',
    'costPerReviewedEpisode',
    'unnecessaryInterruptionRate',
    'memoryDuplicationRate',
    'privacyViolations',
  ];
  // For the first four, higher is better; for the rest, lower is better.
  const higherIsBetter = new Set(['interventionPrecision', 'validEvidenceRate', 'humanApprovalRate', 'labelAccuracy']);
  const better: string[] = [];
  const worse: string[] = [];
  for (const key of keys) {
    const b = baseline.metrics[key];
    const c = candidate.metrics[key];
    if (b === c) continue;
    const improved = higherIsBetter.has(key) ? c > b : c < b;
    (improved ? better : worse).push(key);
  }
  return {
    baseline: baseline.promptVersion,
    candidate: candidate.promptVersion,
    better,
    worse,
    baselineReady: canRollForward(baseline.metrics),
    candidateReady: canRollForward(candidate.metrics),
  };
}
