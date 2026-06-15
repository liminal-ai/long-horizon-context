# Story 1: Prompt Smoothing

### Summary
<!-- Jira: Summary field -->

Implement deterministic prompt cleaning, length-gated inference smoothing, and failed/pending recovery inputs.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** make `smoothed_prompt` always have a deterministic floor and one usable `ready` state whether produced by deterministic-only or deterministic+inference.

**Scope In:**
- Deterministic cleaning for every user prompt with no model call.
- Length-gated inference smoothing.
- Fenced-code preservation by prompt instruction.
- Pending/retry and terminal failed states with deterministic floor available to consumers.

**Scope Out:**
- Prompt tuning and length-cap tuning against real corpora.
- Recovery write-back at consumption time, owned by Story 3.

**Dependencies:** Story 0.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-1.1:** Deterministic cleaning is applied to every user prompt regardless of length, using no model call (whitespace normalization, trivial casing).

- **TC-1.1a:** Cleaning applied, no provider call
  - Given: a user prompt with irregular whitespace
  - When: smoothing derives
  - Then: the result has normalized whitespace and the provider was not invoked for the deterministic stage
- **TC-1.1b:** Over-cap prompt still cleaned
  - Given: a prompt above the length cap
  - When: smoothing derives
  - Then: deterministic cleaning is still applied (length only gates inference, not cleaning)

**AC-1.2:** Inference smoothing is applied only when the prompt is under the configured length cap; over the cap, the deterministic result is the smoothed derivation.

- **TC-1.2a:** Under cap → inference runs
  - Given: a prompt under the cap
  - When: smoothing derives
  - Then: inference is invoked and its output is stored
- **TC-1.2b:** Over cap → inference skipped
  - Given: a prompt over the cap
  - When: smoothing derives
  - Then: inference is not invoked and the deterministic result is stored

**AC-1.3:** Fenced code in a prompt is preserved verbatim through inference smoothing (governed by prompt instruction, not by segmenting or regex protection).

- **TC-1.3a:** Fenced code unchanged
  - Given: a prompt containing a fenced code block and surrounding prose with typos
  - When: inference smoothing runs
  - Then: the fenced block is unchanged and the prose is cleaned

**AC-1.4:** A smoothed prompt is `ready` and usable whether produced by deterministic-only (over cap) or deterministic+inference (under cap). No separate "skipped" state exists.

- **TC-1.4a:** Deterministic-only lands ready
  - Given: an over-cap prompt
  - When: smoothing completes
  - Then: state is `ready` (not "skipped" or "degraded")
- **TC-1.4b:** Full smoothing lands ready
  - Given: an under-cap prompt, inference succeeds
  - When: smoothing completes
  - Then: state is `ready`

**AC-1.5:** A retryable inference failure leaves the derivation `pending` and requeued; the deterministic floor remains available to consumers in the interim.

- **TC-1.5a:** Retryable failure stays pending
  - Given: inference returns a retryable error within budget
  - When: the worker handles it
  - Then: state is `pending` and the item is requeued
- **TC-1.5b:** Floor available while pending
  - Given: a smoothing derivation is `pending`
  - When: a consumer needs the smoothed prompt
  - Then: the deterministic floor (or original) is used via the cascade (Flow 3), not a block

**AC-1.6:** Smoothing never invokes a provider on the hot path; it runs only as queued work off the hot path.

- **TC-1.6a:** No provider call during intake
  - Given: a user prompt is intaken
  - When: intake completes
  - Then: no provider call occurred during intake; only a smoothing work item was queued

**AC-1.7:** When the background worker's under-cap inference terminally fails (retry budget exhausted, non-retryable error), the derivation lands `failed` with its reason — the worker records the honest failure, it does not floor-and-mark-ready (flooring is a consumption-time act, AC-3.8). The deterministic floor is still available to consumers in the interim, and construction later resolves the `failed` derivation to `ready` per Flow 3.

- **TC-1.7a:** Terminal failure lands failed with reason
  - Given: under-cap inference exhausts its retry budget
  - When: the worker gives up
  - Then: state is `failed` with a reason recorded on the derivation (not `ready`, not silently floored)
- **TC-1.7b:** Floor still consumable
  - Given: a `failed` smoothing derivation
  - When: a consumer needs the smoothed prompt
  - Then: the deterministic floor is used via the cascade (Flow 3), not a block

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 1 changes the message smoothing worker path. Intake remains provider-free and only queues smoothing work; the handler loads the prompt, computes a pure deterministic floor, then runs inference only under the configured cap.

The deterministic result is both the over-cap ready output and the floor used later by turn construction. Retryable inference failures stay `pending`; terminal inference failures land `failed` with reason. Consumption-time recovery and write-back remain Story 3 work.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The deterministic floor and length gate are easy to shortcut with provider-only behavior.
- Boundary tests need to prove no intake provider call and no over-cap inference call.

Risk Reminders:
- Deterministic floor correctness: `cleanPrompt` is pure and stable.
- Provider boundary: deterministic stage and intake do not call `DerivationProvider`.
- Runtime adapter: under-cap inference still uses the existing provider path.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Smoothing handler | `packages/lhc/src/domains/messages/internal/handlers.ts` |
| Deterministic floor | `packages/lhc/src/domains/messages/internal/smoothing.ts` (NEW per tech design) |
| Smoothing prompt | `packages/lhc/src/inference/prompts/smoothing-v1.ts` |
| Token cap | `packages/lhc/src/tech-utils/token-counting/index.ts`, config surface used by handlers |
| Provider doubles | `packages/lhc/test/fixtures/provider-double.ts` |
| Story tests | `packages/lhc/test/smoothing-recovery.test.ts` (planned) |

#### Design References

- [tech-design.md §DD-2](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:91), lines 91-102
- [tech-design.md §Deterministic smoothing interface](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:180), lines 180-187
- [tech-design.md §Smoothing handler mechanics](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:253), lines 253-264
- [tech-design.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:299), lines 299-309
- [test-plan.md §Testing Architecture](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:6), lines 6-16
- [test-plan.md §Flow 1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:30), lines 30-45
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:121), lines 121-135

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-1.1a | `packages/lhc/test/smoothing-recovery.test.ts` | Irregular whitespace is cleaned and provider is not called for deterministic stage. |
| TC-1.1b | `packages/lhc/test/smoothing-recovery.test.ts` | Over-cap prompt is still deterministically cleaned. |
| TC-1.2a | `packages/lhc/test/smoothing-recovery.test.ts` | Under-cap prompt invokes `smoothPrompt` and stores provider output. |
| TC-1.2b | `packages/lhc/test/smoothing-recovery.test.ts` | Over-cap prompt skips `smoothPrompt` and stores deterministic output. |
| TC-1.3a | `packages/lhc/test/smoothing-recovery.test.ts` | Fenced code remains byte-identical while surrounding prose is cleaned by inference path. |
| TC-1.4a | `packages/lhc/test/smoothing-recovery.test.ts` | Over-cap deterministic-only smoothing lands `ready`, not skipped/degraded. |
| TC-1.4b | `packages/lhc/test/smoothing-recovery.test.ts` | Under-cap successful inference lands `ready`. |
| TC-1.5a | `packages/lhc/test/smoothing-recovery.test.ts` | Retryable provider error leaves derivation `pending` and requeues item. |
| TC-1.5b | `packages/lhc/test/smoothing-recovery.test.ts` | Pending smoothing consumed through compose uses deterministic floor and does not block. |
| TC-1.6a | `packages/lhc/test/smoothing-recovery.test.ts` | Intake queues smoothing item and performs no provider call. |
| TC-1.7a | `packages/lhc/test/smoothing-recovery.test.ts` | Exhausted under-cap inference lands `failed` with reason, not `ready`. |
| TC-1.7b | `packages/lhc/test/smoothing-recovery.test.ts` | Failed smoothing consumed through compose uses deterministic floor. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Cap boundary | `packages/lhc/test/smoothing-recovery.test.ts` | Exercise around `smoothing.maxInferenceTokens = 4000`. | Normal under/over examples can miss threshold-edge behavior. |
| Deterministic purity | `packages/lhc/test/smoothing-recovery.test.ts` | Same input produces same cleaned output without DB, clock, or provider. | Provider-spy checks alone do not prove output reproducibility. |
| Hot-path provider boundary | `packages/lhc/test/smoothing-recovery.test.ts` | Intake provider spy records zero calls while work item is queued. | Worker tests can pass while intake accidentally calls provider. |

#### Technical Notes

- `cleanPrompt(text)` performs whitespace normalization and trivial casing only. Typo correction belongs to inference.
- Fenced-code preservation is prompt-instruction behavior in `smoothing-v1`; do not add segmentation or regex protection.
- First-pass cap is `smoothing.maxInferenceTokens = 4000`; tuning remains out of scope.

#### Anti-Shim Requirements

- Do not fake over-cap behavior by marking a derivation ready without storing the cleaned content.
- Do not call provider from intake or deterministic cleaning tests.
- Do not add a second "deterministic output" field or a skipped/degraded state.

#### Production Path Proof

- Entrypoint: prompt intake through `domains/intake-stream` queues smoothing work; worker dispatch reaches `smoothPromptHandler`.
- Registration/default path: existing work-queue drain invokes message handlers for smoothing derivations.
- Evidence: `packages/lhc/test/smoothing-recovery.test.ts` covers intake queueing plus worker handler behavior using real storage and provider doubles.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/smoothing-recovery.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- AC-1.1 through AC-1.7 pass with their listed TCs.
- Intake queues smoothing work without provider calls.
- Deterministic cleaning runs for under-cap and over-cap prompts.
- Terminal inference failure lands `failed` with reason, not `ready`.
