# Plan 001: Render episode intervention citations inline with descriptive labels

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0065618..HEAD -- prompts/episode-review.hbs src/production-runtime.ts test/unit/prompt-templates.test.ts test/integration/episode-review.test.ts MNEME_IMPLEMENTATION_SPEC.md contributor-docs/acceptance-checklist.md docs/explanation/speaking-and-review.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0065618`, 2026-09-17

## Why this matters

Episode intervention cards currently put each citation on its own line after the proposed message and label every link `source`. Two citations therefore add several visually empty lines and do not tell a reviewer which record supports which claim. Mneme already has a safe inline-citation renderer for direct answers and scheduled notifications; episode interventions should use the same host-built links, show the exact deliverable text in the approval card, and keep one compact fallback line for a markerless legacy proposal.

## Current state

- `prompts/episode-review.hbs` — tells the model to draft an intervention, but does not tell it how to place citations. At lines 52–57:

  ```hbs
  7. Evaluate whether an intervention would create more value than interruption.
     Recommend one only with a current trigger: without a valid subject and trigger
     the host stores the proposal silently, whatever its score.
  8. If intervention is warranted, draft one concise message suitable for the target
     channel. It must stand on permitted evidence and include no unsupported accusations.
  9. Finish by calling `finalize_episode_review` exactly once.
  ```

- `src/production-runtime.ts` — `routeEpisodeIntervention` sanitizes evidence IDs into trusted links, but supplies no `resolveLabel`; `safeSourceLabel` therefore falls back to `source`. At lines 874–877:

  ```ts
  const sanitized = sanitizeOutboundMessage({ content: message, sourceLinkMessageIds: evidenceIds,
    guildId: ctx.config.discord.guildId }, {
    resolveChannelId: (id) => resolveCurrentEvidenceMessage(id)?.stored.channel_id,
  });
  ```

- The same function appends all links as a separate newline block and gives the review renderer the unassembled message plus a separate source list. At lines 942–944 and 1010–1013:

  ```ts
  const assembled = sanitized.outcome === 'allow'
    ? [sanitized.content, sanitized.sourceLinks.length ? sanitized.sourceLinks.map((l) => l.masked).join('\n') : ''].filter(Boolean).join('\n\n')
    : null;
  ```

  ```ts
  await deliverProposalReview({ proposalId, targetLabel: targetRow?.name ? `#${targetRow.name}` : target.channelId,
    score: routing.score, reason: routing.reasons.join('; '), proposedMessage: sanitized.outcome === 'allow' ? sanitized.content : assembled,
    sources: sanitized.outcome === 'allow' ? sanitized.sourceLinks.map((l) => l.masked) : [], expiresAtMs },
  ```

- `src/discord/message-safety.ts:445-503` already provides the required trust boundary. `buildSourceLinks` constructs at most three Discord jump URLs from host-resolved guild, channel, and message IDs. `renderInlineCitations` replaces only validated `[[cite:MESSAGE_ID]]` markers, rejects unknown or malformed markers, and returns validated links that were not consumed by markers. Do not let model-authored URLs or labels bypass these functions.
- `src/memory/scheduled-delivery.ts:64-99` is the formatting exemplar. Its source-link context labels links as `#channel · YYYY-MM-DD`; `assembleScheduledDelivery` places validated unused links on one line, separated with ` · `:

  ```ts
  const inline = renderInlineCitations(content, links);
  if (inline.outcome === 'reject') return { outcome: 'reject', reasons: inline.reasons };
  const parts = [inline.content];
  if (inline.unusedLinks.length > 0) {
    parts.push(`Sources: ${inline.unusedLinks.map((link) => link.masked).join(' · ')}`);
  }
  ```

- `src/production-runtime.ts:664-687` is the review-card consistency exemplar. `buildScheduledReviewPresentation` passes the fully rendered delivery in `proposedMessage` and passes `sources: []`, so the card quotes exactly what approval will queue.
- `MNEME_IMPLEMENTATION_SPEC.md:3149-3157` currently promises inline links only for direct answers and scheduled notifications. Section 25 at lines 3163–3178 illustrates a separate multi-line `Sources:` block. The normative spec and implementation must change together, per `AGENTS.md` and `CONTRIBUTING.md`.
- Tests use Vitest. `test/unit/message-safety.test.ts:368-384` demonstrates the expected inline substitution and descriptive label. `test/integration/scheduled-review.test.ts:533-546` demonstrates the single-line fallback form. `test/integration/episode-review.test.ts` already calls `routeEpisodeIntervention` directly with seeded messages and proposals; extend that harness rather than creating a second routing fixture.
- This repository uses TypeScript ESM, Node 24, two-space indentation, single quotes, and conventional commit messages. Recent examples include `fix(...)`, `feat(attention): ...`, and `docs: ...`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused prompt tests | `npx vitest run test/unit/prompt-templates.test.ts` | exit 0; all tests pass |
| Focused routing tests | `npx vitest run test/integration/episode-review.test.ts` | exit 0; all tests pass |
| Focused safety regression | `npx vitest run test/unit/message-safety.test.ts test/integration/scheduled-review.test.ts` | exit 0; all tests pass |
| Documentation checks | `npm run docs:check-public && npm run docs:check-links` | exit 0; no errors |
| Full verification | `npm run verify` | exit 0; SQLite check, lint, both typechecks, tests, and build all pass |

## Scope

**In scope** (the only source, test, and documentation files you should modify):

- `prompts/episode-review.hbs`
- `src/production-runtime.ts`
- `test/unit/prompt-templates.test.ts`
- `test/integration/episode-review.test.ts`
- `MNEME_IMPLEMENTATION_SPEC.md`
- `contributor-docs/acceptance-checklist.md`
- `docs/explanation/speaking-and-review.md`
- `plans/README.md` (status update only)

**Out of scope** (do not touch):

- `src/discord/review-message.ts` and `test/integration/review-message.test.ts` — the generic review-card `sources` API remains valid for other callers; episode routing should pass an exact assembled message and an empty source list, like scheduled reviews.
- `src/memory/scheduled-delivery.ts`, direct-answer handling, and their prompts — they already implement inline citations and are regression exemplars only.
- Approval/dismissal status wording and Discord ephemeral notifications — separate product concern.
- Database migrations or schema changes — the proposal already stores assembled episode text and evidence IDs.
- Changes that permit model-authored Discord URLs, labels, or unvalidated citation IDs.

## Git workflow

- Branch: `advisor/001-inline-episode-intervention-citations`
- Commit the prompt/runtime/tests/spec/docs as one logical fix, using conventional style, for example: `fix(interventions): render evidence links inline`
- Do not push or open a PR unless the operator instructs you.

## Steps

### Step 1: Teach episode review to place citation markers beside claims

In `prompts/episode-review.hbs`, expand instruction 8 so `intervention.message` places `[[cite:MESSAGE_ID]]` immediately after each supported claim, uses one to three markers drawn from `evidenceMessageIds`, and never authors a Discord jump URL. State that the host validates the IDs and replaces valid markers with descriptive links. Match the marker language in `prompts/scheduled-review.hbs:44-47`; do not copy the notification structure from lines 40-43 (bold title line first, "What the records show") — that shape fits scheduled summaries, not interventions. Do not change the intervention decision criteria or terminal-tool instruction.

Add an assertion to the existing episode-review case in `test/unit/prompt-templates.test.ts` that the rendered prompt includes the marker syntax, the requirement to place it beside supported claims, and the prohibition on authoring jump URLs.

**Verify**: `npx vitest run test/unit/prompt-templates.test.ts` → exit 0; all prompt-template tests pass.

### Step 2: Assemble episode text with validated inline citations

In `src/production-runtime.ts`, import and use `renderInlineCitations` from `src/discord/message-safety.ts` in `routeEpisodeIntervention` after `sanitizeOutboundMessage` succeeds.

Make the episode source-link context supply both resolvers:

- `resolveChannelId` continues to use `resolveCurrentEvidenceMessage` so excluded, deleted, foreign-guild, and Mneme test-surface messages cannot produce links.
- `resolveLabel` uses the resolved stored message, `getChannel`, and `created_at_ms` to return `#channel · YYYY-MM-DD`; if a channel has no name, use `Discord · YYYY-MM-DD`. Match the date and label behavior in `src/memory/scheduled-delivery.ts:64-70`. The label remains host-owned.

Create one local, pure assembly helper in `src/production-runtime.ts` (export it only if a focused test needs direct access). Its contract must be explicit:

1. Accept sanitized content and its host-built `MessageLink[]`.
2. Call `renderInlineCitations`.
3. Return the renderer's precise rejection reasons for an unknown or malformed marker.
4. Start the deliverable with the rendered content.
5. If validated links remain unused because a legacy/markerless proposal cited them, append exactly one paragraph: `Sources: <link> · <link>`. Do not put each link on its own line.
6. Reject the fully assembled content if it exceeds Discord's 2,000-character limit. Define a named constant for this cap in `src/production-runtime.ts`; do not reuse `MAX_MESSAGE_CHARS` (`src/discord/message-safety.ts:27`, value 1,800) — that limit gates raw content before markers become masked links and before the `Sources:` line is appended, so reusing it would tighten this gate below the limit the spec text names. No shared 2,000 constant exists today; `SCHEDULED_DELIVERY_MAX_CHARS` and `DISCORD_MESSAGE_MAX` belong to other delivery paths. The rejection reason should say that the intervention leaves insufficient room for validated source links.

Treat an assembly rejection as an outbound safety rejection throughout the existing routing flow: no review card and no outbox row may be created, the proposal must be stored as non-actionable/observed, and `buildEpisodePolicyDecision` must receive the actual citation or length rejection reasons. The current `ProposalRoutingInput.eligibility.hasDisallowedMention` is the route's general outbound-safety stop despite its narrow name; use it for this combined sanitizer/assembly failure in this focused fix rather than renaming the policy interface across the repository. Preserve all provenance, evidence, attention, cooldown, and duplicate gates.

Use the successful assembled string as the sole episode message for persistence and delivery in both review and autonomous modes.

**Verify**: `npm run check && npm run check:test` → both commands exit 0 with no TypeScript errors.

### Step 3: Make the approval card quote the exact deliverable

Still in `routeEpisodeIntervention`, change the pending-review call to `deliverProposalReview` so `proposedMessage` is the successful assembled text and `sources` is always `[]`. This mirrors `buildScheduledReviewPresentation`: the reviewer sees inline links and the one-line fallback exactly where they will appear, and approval queues that same persisted string.

Do not remove the generic `Sources:` rendering from `src/discord/review-message.ts`; this change is specific to the episode caller.

**Verify**: `npx vitest run test/integration/review-message.test.ts test/integration/episode-review.test.ts` → exit 0; all tests pass.

### Step 4: Add episode routing regressions for the reported UI defect

Extend `test/integration/episode-review.test.ts` using its existing database setup, seeded channel/message helpers, `interventionRuntimeContext`, and direct `routeEpisodeIntervention` calls. Add cases that prove:

1. A two-claim episode message with two valid markers persists descriptive `#channel · YYYY-MM-DD` links immediately beside the matching claims. The stored text has no `[[cite:` marker, no `[source]` label, and no trailing multi-line link block.
2. A valid markerless intervention with two evidence IDs remains compatible and persists one `Sources:` line whose links are separated by ` · `; it does not persist two standalone link lines.
3. An unknown marker and a malformed marker each fail closed: the row is non-actionable/observed, and neither a pending review card nor an outbox delivery is created. Assert that the stored policy-decision safety reasons retain the specific renderer reason rather than only the generic route message.
4. A message that fits the model limit but exceeds 2,000 characters after host-built links are inserted also becomes non-actionable and creates no card/outbox row.
5. The pending-review input uses the same assembled string that was persisted and supplies `sources: []`. The harness has no fake Discord client — `interventionRuntimeContext()` passes an empty object as the client and leaves `reviewChannelId` undefined, so the card send is gated off, and the card embed quotes each message line with `> `. Assert through a small exported pure presentation helper in `src/production-runtime.ts` that returns the exact `proposedMessage` and `sources` values `routeEpisodeIntervention` passes to `deliverProposalReview`; the test proves the helper output equals the persisted assembled string with `sources: []`. If even the helper requires production-only branching or edits outside scope, STOP instead of weakening this assertion.
6. An autonomous eligible intervention enqueues exactly the same assembled string stored on the proposal. The default harness context hardcodes `mode: 'review'`, in which routing always returns `pending_review`; override the runtime config to `mode: 'autonomous'` and seed a case that avoids `force_review`. Fetch the outbox row with `getOutboxByDedupeKey('proposal:<id>')` and assert its `content` equals the stored proposal message.

Keep existing source-link unit tests intact. They already verify host ownership of URLs and label sanitization; do not duplicate those implementation-level cases in the integration suite.

**Verify**: `npx vitest run test/integration/episode-review.test.ts test/unit/message-safety.test.ts test/integration/scheduled-review.test.ts` → exit 0; all tests pass, including the new episode cases and existing direct renderer consumers.

### Step 5: Align the normative spec and operator documentation

Update `MNEME_IMPLEMENTATION_SPEC.md` in the same change:

- Section 24.5 must include episode interventions among messages that place validated host-built links inline beside supported claims.
- Section 25's review-card example must show a proposed message with an inline descriptive source link. State that the card quotes the exact assembled outbound text; markerless validated citations use one compact `Sources:` line for compatibility. Remove the example that presents each generic context link as a separate bullet.
- State that unknown/malformed markers and an assembled message over 2,000 characters fail closed.

Update `docs/explanation/speaking-and-review.md` near the episode/scheduled citation discussion: explain in reader-facing terms that proposal cards show the exact text approval will send, citations appear beside claims as descriptive channel/date links, and older markerless output gets a single compact fallback line.

Add one intervention acceptance row to `contributor-docs/acceptance-checklist.md` naming the new `test/integration/episode-review.test.ts` cases for inline episode citations, exact preview/delivery text, compact fallback, and invalid-marker rejection. Use the final test names verbatim.

**Verify**: `npm run docs:check-public && npm run docs:check-links` → exit 0; both documentation checks pass.

### Step 6: Run the repository gate and inspect scope

Run the complete required verification suite, then confirm the diff contains only the scoped files and the plan status change.

**Verify**:

- `npm run verify` → exit 0; all checks and tests pass.
- `git diff --check` → exit 0 with no output.
- `git status --short` → only the files listed under **In scope** are modified.
- Update this plan's row in `plans/README.md` from `TODO` to `DONE`, then re-run `git status --short`.

## Test plan

- Prompt contract: episode-review instructs valid inline marker syntax and forbids authored jump URLs.
- Inline happy path: two claims map to two current, validated, descriptive links at their claim positions.
- Compatibility path: evidence without markers renders one compact `Sources:` line.
- Review consistency: card preview, persisted proposal, approval delivery, and autonomous outbox use the same assembled text for their applicable paths.
- Safety paths: unknown marker, malformed marker, unresolvable evidence, and post-assembly overflow do not produce actionable proposals or outbound rows.
- Regression: existing direct-answer and scheduled-notification citation tests still pass.
- Structural patterns: follow `test/unit/message-safety.test.ts:368-384`, `test/integration/scheduled-review.test.ts:533-546`, and the direct `routeEpisodeIntervention` setup in `test/integration/episode-review.test.ts:754-809`.

## Done criteria

- [ ] The episode prompt requires `[[cite:MESSAGE_ID]]` beside supported claims and prohibits model-authored jump URLs.
- [ ] Episode intervention links use host-generated `#channel · YYYY-MM-DD` labels.
- [ ] Valid markers become inline links; no literal marker or anonymous `[source]` label reaches a card, proposal, or outbox row.
- [ ] Markerless validated citations use exactly one `Sources:` line with ` · ` separators.
- [ ] Review cards quote the exact persisted/deliverable message and receive `sources: []` from the episode caller.
- [ ] Invalid markers and assembled messages over 2,000 characters create no card or outbox delivery and retain precise audit reasons.
- [ ] `npx vitest run test/unit/prompt-templates.test.ts test/unit/message-safety.test.ts test/integration/episode-review.test.ts test/integration/scheduled-review.test.ts` exits 0.
- [ ] `npm run docs:check-public && npm run docs:check-links` exits 0.
- [ ] `npm run verify` exits 0.
- [ ] `git diff --check` exits 0 with no output.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back without improvising if:

- Any current-state excerpt no longer matches after the drift check, especially if episode routing already has a separate delivery renderer.
- Producing descriptive labels would require trusting model-authored labels or bypassing `resolveCurrentEvidenceMessage`.
- Review preview and delivery cannot share the same assembled string without changing the database schema or approval transaction design.
- Capturing the review payload requires edits outside the in-scope files or production-only test branches; use the permitted pure-helper option first, then stop if it still cannot prove exact-text consistency.
- The fix would require changing the generic review-card source API or scheduled/direct-answer behavior.
- A verification command fails twice after one reasonable correction.

## Maintenance notes

- Keep `[[cite:MESSAGE_ID]]` as the only model-authored citation syntax. URLs and visible labels must remain host-generated from currently resolvable stored messages.
- Reviewers should scrutinize the order of operations: sanitize and validate evidence, render citations, enforce final length, then persist one assembled value used by both preview and delivery.
- The compatibility fallback is intentional for older/model-degraded output. Do not remove it until durable proposals and all supported model versions are guaranteed to emit markers.
- A future cleanup may extract the duplicated channel/date label resolver and cited-message assembly shared by episode, scheduled, and direct-answer paths. That refactor is deferred because this plan fixes one visible defect without changing working consumers.

## Adversarial review round (2026-09-17)

Six findings were confirmed against the finished implementation. Dispositions:

- The card-preview proof was tautological (an identity helper tested against its own input). Fixed: the pending-review test now seeds a stub Discord client and a review channel, captures the real embed, and asserts the exact assembled text is quoted with no separate per-link block.
- The `hasDisallowedMention` eligibility flag made the stored routing reason misreport marker and overflow failures as a mention. Fixed: the specific outbound-safety reasons are appended to the stored reason list; the policy-decision audit keeps them as before.
- The one-to-three marker prompt contract was not host-enforced, so repeated markers could multiply rendered links. Fixed: `assembleEpisodeIntervention` rejects more than three markers, with a regression test.
- Spec and operator docs said links are "never" listed per line; a proposal assembled before this format and still pending delivers its stored per-line layout until it resolves. The wording now states that bounded transition.
- Left as-is (cosmetic, parity with the scheduled-delivery exemplar): the 64-character label cap can truncate a citation label built from a very long channel name, and a `review-message.ts` comment still cites a 1,800-character maximum premise. The embed-description invariant was verified to still hold at the new 2,000-character assembly cap.

