# How Mneme decides whether to speak

Mneme continuously builds organizational memory from permitted Discord
conversations. Building memory and sending a message are separate decisions:
Mneme may create or update memories while remaining completely silent.

This page explains proactive interventions. A direct answer to an explicit
Discord mention follows a separate path described below.

## The short version

Mneme first decides whether a proactive message is useful and adequately
supported. Host code then validates its evidence, visibility, target, content,
and routing policy. Only a proposal that passes those checks is eligible.

Proactive speech also requires **current work**. Mneme proposes an
unsolicited message only when a meaningful human message about the subject was
written within the last seven days — a new commitment, a changed decision, a
reopened question, a specific outcome, or a contradiction of a stored decision —
or when an explicit human-stated deadline on a subject becomes due. Each such
human development earns at most one speaking opportunity, no matter how the
attempt ended. An old promise with no new human development stays silent, and
silence never deletes or invalidates the memory: it remains searchable, and an
explicit question about it still gets a direct answer.

The configured operating mode determines what happens next:

| Mode | Eligible proactive proposal |
| --- | --- |
| `observe` | Store it as `observed`; send nothing. |
| `review` | Send it to the secure review channel for approval, even when Mneme is confident. |
| `autonomous` | Send it to the target channel unless a sensitive or uncertain condition forces human review. |

Review mode is therefore not an uncertainty detector. It is a deployment policy:
**every eligible proactive intervention requires approval in review mode**.

## Confidence, score, and review are different

Confidence is the model's bounded self-assessment that its proposed conclusion is
supported. It is neither an independently verified fact nor a calibrated probability of
correctness. Evidence strength is another model-supplied dimension describing the cited
Discord evidence. Both must clear configured eligibility floors, after which host code
still verifies the exact citations, current scope, and delivery policy.

The intervention score estimates whether speaking is worth the interruption. It
combines impact, evidence strength, contradiction strength, urgency, novelty, and
interruption cost. A score such as `0.84` is not an 84% probability that the
message is correct, and it is not a safety guarantee.

Review is a routing decision. In review mode it applies to every eligible
proposal. In autonomous mode it applies only when policy forces review, such as
for sensitive subject matter, mixed restricted scopes, or unresolved validation
uncertainty.

There are also two kinds of uncertainty. If the model is not confident that an
intervention is worthwhile or supported, it should not recommend one and the
proposal remains `observed`. If host validation cannot safely resolve scope or
provenance, Mneme routes the otherwise eligible proposal to secure review or
suppresses it. A definite violation is never converted into a reviewable proposal.

Scheduled-memory review cards use the categorical assessment `Recommended
scheduled review` instead of a synthetic `Score: 1.00`.

## Decision outcomes

| Situation | Result |
| --- | --- |
| Useful, supported proposal in `observe` mode | Stored as `observed`; no review card and no target message. |
| Useful, supported proposal in `review` mode | Sent to the secure review channel for approval, including high-confidence proposals. |
| Useful, supported, ordinary proposal in `autonomous` mode | Queued for target delivery after all host checks pass. |
| Sensitive proposal or validation uncertainty in `autonomous` mode | Forced to the secure review channel. |
| No recent human trigger or verified due deadline, or the revision's opportunity is already used | Suppressed in every mode, including review and forced-review cards, and stored as `observed`. |
| An explicit human deadline becomes due on an unused subject | Eligible once inside the deadline window. |
| Low score, low confidence, weak evidence, or no recommendation | Suppressed in every mode and stored as `observed`. |
| Cooldown or recent duplicate during autonomous routing | Suppressed and stored as `observed`. |
| Cooldown or recent duplicate discovered at approval time | Approval is blocked; a non-terminal block leaves the proposal pending for retry. |
| Definite target, provenance, evidence, or visibility violation | Rejected from outbound routing and stored as `observed`; human approval cannot override it. |
| Explicit direct question | Answered without proposal approval when enabled, but still subject to scope, evidence, mention-safety, and rate checks. |
| Subject revision eligible for scheduled review | Proposed in the secure review channel in both `review` and `autonomous` modes; never sent autonomously. |

`observed` means "stored but not sent," not necessarily "Mneme saw a message."
It is intentionally broad so suppressed decisions remain auditable.

## What approval does

An approval is permission to attempt delivery; it is not permission to bypass
safety controls. Mneme verifies the administrator's role and rechecks the
current target, evidence, visibility, cooldown, global limit, duplicate state, and
attention ownership — the proposal must still own its subject revision and be inside
its attention window. It then atomically records the approval and reviewer and queues
the outbox item plus
its send job. The outbox worker publishes later, so `approved` means durably queued,
not already visible in Discord. An approved proposal whose attention window closes
before the outbox runs is cancelled without sending; a send already proven delivered
is recorded, never repeated or denied.

The conversation may have changed since the card was created. A proposal remains
`pending_review` until it is approved, dismissed, or expired. If a temporary or
non-terminal policy check blocks approval, it remains pending and its controls remain
available for a later retry. A successful approval or dismissal interaction removes the
controls. An approval click that detects expiry also resolves that card. Startup repair
expires past-deadline rows in bounded, idempotent batches before interactions start, and
periodic maintenance repeats the sweep as defense in depth. Expiry does not promise to edit
an old Discord message; any stale button cannot enqueue delivery. Proposals expire after
72 hours by default, or sooner if their attention window closes.

A definite privacy, evidence, or target violation cannot be overridden by an
administrator. The proposal must be corrected or regenerated from permitted
evidence.

For episode and scheduled-review proposals, every cited message ID must have been
exposed during the originating model run. Mneme verifies those IDs and their current
scope when creating the proposal and again when approval is attempted. Exact
ID-to-fingerprint revalidation of every exposed row is the automatic direct-answer path's
stronger freshness mechanism; a human-reviewed proposal instead relies on its persisted
run-exposed citations, current evidence checks, and the administrator's explicit decision.

Proposal cards quote the exact text that approval will send. Episode interventions
place each validated citation inline, beside the claim it supports, as a
descriptive `#channel · date` link built by the host. The model only writes a
`[[cite:MESSAGE_ID]]` marker and never authors a link. An older proposal whose
citations carry no markers keeps its evidence on one compact `Sources:` line at
the end of the quoted message, not on one link per line. A card posted before
this change keeps the layout it was posted with until its proposal resolves.

## Scheduled-memory reviews

A scheduled-memory review asks whether an existing memory received new human
attention that is worth raising. It is intentionally reviewed by a human even in
autonomous mode.
Its card identifies the resolved channel, shows the recommendation reason, and
includes up to three current host-generated evidence links.

A scheduled review runs only when the subject has an eligible, unused attention
revision — a recent material human development, or an explicit deadline that has
become due. The review date on a memory is semantic bookkeeping; it never makes the
memory eligible for a reminder by itself, and a reminder can never repeat without a
new human development.

The secure review channel is the approval inbox only. Mneme derives one exact working
channel from the memory's current origin evidence before the model runs. Approval queues
the exact reviewed text to that channel, which must allow interventions. `#general` is not
a fallback, and a thread is never replaced by its parent. If no unique safe target exists,
Mneme performs silent secure maintenance or suppresses the notification.

Use Discord's Reply action on the delivered working-channel message to provide an update.
An exact reply can update or resolve the reviewed memory. Nearby text and ordinary messages
in the review channel are not treated as feedback.

## Upgrading from reminder-based releases

An upgrade containing migrations `038_proactive_attention` and
`039_deadline_decisions` changes which old work can resurface. First verify a
completed [backup](../how-to/backup-and-restore.md); these are forward-only schema
changes, so an older image cannot run against the upgraded database without a restore.
Follow the [migration compatibility rules](../how-to/deploy.md#migration-compatibility).

Before workers and interactions start, Mneme records previously surfaced legacy
evidence as consumed, expires legacy pending proposals, cancels their queued deliveries,
and retires old scheduled-review jobs. Uncertain sends are reconciled with Discord
instead of being blindly resent. The cutover itself performs no Discord or model calls
and is safe to repeat after a restart. It does not erase memory or reactivate memories
already expired by an older version.

The old reminder interval and memory-age settings remain parseable but no longer
control proactive admission or expire memories. The new attention window defaults to
seven days; see [Intervention and memory settings](../reference/configuration.md#intervention-and-memory-settings).

## A useful mental model

Mneme remembers automatically when evidence validates. She proposes speaking
only when the expected value exceeds the interruption cost. The operating mode
decides whether an eligible proposal needs approval, while privacy, evidence, and
visibility checks always remain mandatory.

For the exact normative rules, see Sections 24 and 25 of the
the repository's normative implementation specification. For the public behavior
contract, see [Architecture](architecture.md) and [Safety and assurance](safety-and-assurance.md).
For the security boundaries behind them, see the
[security model](security-model.md).
