# Prompt evaluation harness

This harness compares prompt versions against a labeled fixture set. It is the
quality gate described in Sections 46.4 and 47 of the implementation spec. A
candidate must have no privacy violations and must meet the configured
intervention-precision threshold.

The harness never calls a live model. Each fixture in `episodes.json` contains
the recorded response for every prompt version under comparison. The harness
applies Mneme's host rules for visibility, deployment mode, evidence, and
intervention thresholds, then aggregates the Section 46.4 metrics.

## Files

| File | Purpose |
| --- | --- |
| `episodes.json` | Versioned fixture dataset. It contains no production content; conversations are reduced to counts and synthetic IDs. |
| `harness.ts` | Harness implementation: routing, metrics, version reports, comparison, roll-forward gate. |
| `harness.test.ts` | Tests: label coverage, routing, metrics, comparison, validation. |
| `direct-answer-planning.json` | Synthetic recent-activity, broad, topical, multilingual, and self-documentation questions labeled with the expected first retrieval tool. |
| `direct-answer-planning.live.test.ts` | Opt-in GPT-5.6-terra evaluation of semantic tool choice using the production prompt and closed tool surface. |

## Fixture shape

Each episode is labeled with one of six outcomes:

| Label | Meaning |
| --- | --- |
| `silent` | Nothing to say; no memory extracted, no intervention. |
| `memory_only` | A memory was extracted but no intervention proposed. |
| `lifecycle_update` | A memory that supersedes an earlier one. |
| `review` | An intervention proposed for human review. |
| `autonomous` | A confident, autonomous-mode intervention the host posts directly. |
| `visibility_refusal` | Restricted evidence the host must not surface broadly. |

Each episode carries a recorded response per prompt version: extracted memories, an
optional notification (recommend/confidence/target-visibility/evidence), a
duplicate flag, cost, and response length. The `$schema` pointer references the
checked-in `schema.json` file for editor and fixture validation.

## Host routing (deterministic)

`evaluateFixture` derives the outcome from a mock response without consulting a
model:

1. No recommendation proposed and no memories: `silent`.
2. No recommendation but a memory with a `supersededId`: `lifecycle_update`;
   otherwise, `memory_only`.
3. Restricted evidence proposed to an `org` scope: `visibility_refusal`.
4. Autonomous mode, confidence at or above `interventionConfidence`, and
   non-restricted evidence: `autonomous`.
5. Otherwise: `review`.

A `visibility_refusal` scenario is considered correctly handled either when the
host refuses a leaky proposal or when the model proposes nothing at all. Both
outcomes are privacy-safe, so `silent` is an acceptable resolution there.

## Metrics (Section 46.4)

`computeMetrics` aggregates, per version:

- `interventionPrecision`: fraction of proposed interventions that were correct.
- `unnecessaryInterruptionRate`: interruptions on `silent` scenarios divided by all interruptions.
- `validEvidenceRate`: proposals with cited, sufficiently strong evidence divided by all proposals.
- `memoryDuplicationRate`: duplicate memories divided by memory-extracting episodes.
- `privacyViolations`: proposals that would leak restricted evidence to `org`.
- `humanApprovalRate`: approved proposals divided by human-ruled proposals.
- `dismissalReasons`: count by dismissal reason.
- `averageResponseLength`: mean response length in characters.
- `costPerReviewedEpisode`: mean model cost over episodes that produced output.

## Roll-forward gate

A version may roll forward to autonomous rollout only when:

```js
privacyViolations === 0 && interventionPrecision >= thresholds.minPrecision
```

`compareVersions(baseline, candidate)` reports which metrics improved or
regressed and each version's readiness, so a candidate is promoted only when it
is at least as good everywhere and clears the gate.

## Running

```bash
npm test                 # full suite, includes these tests
npx vitest run test/evals/ # this harness only
```

The normal suite validates the direct-answer planning dataset but does not spend model
budget. To evaluate actual semantic tool choice with the configured OpenAI key:

```bash
RUN_LIVE_MODEL_EVALS=1 \
  npx vitest run test/evals/direct-answer-planning.live.test.ts
```

The live evaluation defaults to `gpt-5.6-terra` with medium reasoning. Override only the
model with `DIRECT_ANSWER_EVAL_MODEL`. Synthetic tool arguments are inspected only
in-process for assertions; Mneme's persisted run audit retains names and argument
sizes, not generated search text or retrieved content.

To add a new prompt version: add its id to `promptVersions`, add a `responses`
entry for that version on every episode, and re-run. To add a new scenario: add
an episode with one of the six labels and a response for every version.

## Disposable episode model experiment

`experiment:episodes` provides a deliberately local, opt-in directional check before
building production A/B or triage routing. It selects a roughly balanced sample of
stored completed Terra episode runs, reuses their saved result as the medium-reasoning
baseline, runs a full Terra-low candidate, and asks Luna-low for a short conservative
triage decision.

Use a copy of a **completed online backup**, never the open production database or its
raw SQLite file. The copied filename must contain `experiment` or `replay`:

```bash
npm run experiment:episodes -- \
  --database /absolute/path/mneme-experiment.sqlite
```

That command is a dry run: it applies current migrations only to the copy, selects up to
30 baselines, prints category counts and stored baseline cost, and makes no model calls.

After inspecting the sample plan, explicitly enable paid calls:

```bash
OPENAI_API_KEY=... \
DISCORD_APPLICATION_ID=... \
npm run experiment:episodes -- \
  --database /absolute/path/mneme-experiment.sqlite \
  --live \
  --confirm-copy
```

The live command caps `--limit` at 100. Terra candidate runs are written only to the
supplied copy so the normal runtime can validate evidence and account for complete usage;
the experiment never invokes the review handler and therefore never applies memories,
creates routed proposals, writes outbox work, or sends Discord messages. Luna failures,
invalid JSON, low confidence, Mneme mentions, memory links, scheduled feedback, and
non-org visibility all resolve to `escalate`.

Results are written with owner-only permissions under `.experiment/` by default. The
JSONL contains baseline and candidate organizational text for blinded review, is ignored
by Git, and should be deleted after evaluation. A baseline whose stored prompt version
differs from the current reconstructed prompt is marked
`currentPromptVersionMatch: false`; this is a directional replay, not an exact historical
reproduction because old rendered prompts and exact tool results were not persisted.

## Bounded live episode candidate shadow

For a production-parity Terra-medium versus Luna-high comparison, keep
`AGENT_THINKING_LEVEL=medium` and set:

```dotenv
EPISODE_SHADOW_ENABLED=true
EPISODE_SHADOW_MODEL=gpt-5.6-luna
EPISODE_SHADOW_THINKING_LEVEL=high
EPISODE_SHADOW_MAX_RUNS=50
```

Each eligible live episode is reviewed authoritatively by Terra-medium, then once by the
candidate with the same rendered prompts, retrieval grant, provenance, tools, limits, and
semantic clock. Only Terra can create memories or route an intervention. The inspector
links every pair, exposes a bounded proposal view for blinded human review, and groups
category agreement, important recall, silence retention, memory counts, tokens, latency,
and spend by candidate model/reasoning pair. The cumulative cap is exact per pair within
Mneme's single process even when multiple episode workers are enabled; an earlier
Terra-low cohort therefore does not consume the Luna-high cap.

After 50 pairs, manually review every category disagreement, every important baseline,
and a balanced sample of silent agreements. Consider Luna only if it misses no important
episode, keeps at least 95% category agreement, does not materially inflate memories or
interventions, and preserves valid evidence and calibrated claims. Compare the cohort's
mean cost and execution time only after these quality gates pass. Disable the flag after
review; persisted pair and usage records remain auditable.
