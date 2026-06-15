# Story Lead Base Prompt

## Role Charter
You are the story lead for `01-prompt-smoothing` on durable story run `01-prompt-smoothing-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 5.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/stories/01-prompt-smoothing.md
Bytes: 11928

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


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md
Bytes: 11477

# Epic 06: Derivation Recovery and Observability — Test Plan

**Companion to:** `tech-design.md` · **Epic:** `epic.md`
**Counts:** 39 ACs / 59 TCs across 6 flows, mapped to test files below.

## Testing Architecture

- **Real storage.** Every test uses a real temp SQLite thread DB (the persistence/atomicity/idempotency contracts are the point — never mock the store).
- **One mock boundary.** `DerivationProvider`, via the existing `createDeterministicProvider()` for happy paths and two new doubles for failure paths:
  - `failingProvider(opts)` — returns `{ ok:false, retryable }` for a named op, to drive retryable and terminal-failure paths.
  - `probingProvider(fn)` — while its call is pending, runs `fn` which attempts a competing SQLite write (`BEGIN IMMEDIATE` on the same thread DB) and records whether it acquired the lock. Used to prove no write transaction is held across a provider call (stronger than a bare delay).
  - `spyProvider()` — records every call; used to assert **zero** provider calls in compact paths.
- **Verification tiers** are the existing `red-verify` / `verify` / `green-verify` / `verify-all`; no new scripts.
- **First-pass config defaults** used by tests (dial-in values, not architecture):
  - `smoothing.maxInferenceTokens = 4000`
  - `toolResult.tiers = { small: 1000 → 0.10–0.20, mid: 5000 → 0.02–0.05, large: >5000 → truncate }`

## Config defaults under test

| Setting | First-pass value | Tuned in |
|---|---|---|
| smoothing length cap | 4000 tokens | next epic |
| tool-result large-tier threshold | 5000 tokens | next epic |
| tool-result tier targets | 10–20% / 2–5% / truncate | next epic |

---

## TC → Test Mapping

### Flow 1 — Prompt Smoothing → `test/smoothing-recovery.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-1.1a | 1.1 | prompt with irregular whitespace, deterministic provider spy | cleaned whitespace; provider not called for the deterministic stage |
| TC-1.1b | 1.1 | over-cap prompt | deterministic cleaning still applied |
| TC-1.2a | 1.2 | under-cap prompt | `smoothPrompt` invoked; its output stored |
| TC-1.2b | 1.2 | over-cap prompt, provider spy | `smoothPrompt` NOT invoked; deterministic result stored |
| TC-1.3a | 1.3 | prompt with fenced code + typo-laden prose, real-ish passthrough | fenced block byte-identical; prose changed |
| TC-1.4a | 1.4 | over-cap prompt | derivation state `ready` (not "skipped"/"degraded") |
| TC-1.4b | 1.4 | under-cap, inference ok | state `ready` |
| TC-1.5a | 1.5 | `failingProvider({ smoothPrompt: retryable })` | state `pending`, item requeued |
| TC-1.5b | 1.5 | smoothing `pending`, consume via compose | deterministic floor used, no block |
| TC-1.6a | 1.6 | intake a prompt, provider spy | no provider call during intake; smoothing item queued |
| TC-1.7a | 1.7 | `failingProvider` exhausts budget | state `failed` with reason; not `ready` |
| TC-1.7b | 1.7 | `failed` smoothing, consume via compose | deterministic floor used via cascade |

### Flow 2 — Tool-Result Rendering → `test/tool-result-rendering.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-2.1a | 2.1 | large tool result past visibility boundary | deterministic truncation, no provider call, identical input → identical output |
| TC-2.2a | 2.2 | tool result in smooth-band turn | summary produced by queued inference item, not hot path |
| TC-2.3a | 2.3 | result < 1000 tokens | small-tier target applied |
| TC-2.3b | 2.3 | result 1000–5000 tokens | mid-tier target applied |
| TC-2.3c | 2.3 | result > 5000 tokens | truncated, not inference-summarized |
| TC-2.4a | 2.4 | results from two tools | per-tool guidance keyed in prompt; outcome preserved both |
| TC-2.4b | 2.4 | failed tool result | summary states failure outcome |
| TC-2.5a | 2.5 | turn with a tool call | no `tool_call_summary` derivation exists or is queued |
| TC-2.5b | 2.5 | tool call in rendered turn | call args present as recorded, no summary step |
| TC-2.6a | 2.6 | result truncated (full band) + summarized (smooth) | original full result intact in record |
| TC-2.7a | 2.7 | result > 5000 tokens | `tool_result_summary` is the truncation, state `ready`, no inference item created |
| TC-2.8a | 2.8 | in-threshold result, `failingProvider` exhausts | state `failed` with reason; truncation floor used by consumers |

### Flow 3 — Turn Construction and Recovery Cascade → `test/turn-cascade.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-3.1a | 3.1 | turn with smoothed prompt `ready` | smoothed prompt used as-is |
| TC-3.2a | 3.2 | smoothed prompt `pending`, no re-derive | deterministic-cleaned prompt used; turn constructs |
| TC-3.2b | 3.2 | smoothed prompt `failed` | same cascade as pending; usable component |
| TC-3.2c | 3.2 | floor unproducible | original source used |
| TC-3.3a | 3.3 | `tool_result_summary` not ready | truncation used, never raw full result |
| TC-3.4a | 3.4 | turn with assistant text, thinking, runtime-change block | verbatim, in order |
| TC-3.5a | 3.5 | turn with multiple not-ready derivations | construction completes; every component present |
| TC-3.6a | 3.6 | smoothed prompt floored | log entry: derivation type, subject id, reason, floor |
| TC-3.6b | 3.6 | all derivations ready | no fallback log entries |
| TC-3.7a | 3.7 | re-derivation of a not-ready component, `probingProvider` | the competing write acquires its lock while the provider call is pending → no write transaction held across the call |
| TC-3.8a | 3.8 | `failed` component (no live work item) re-derived successfully | `recoverDerivation` persists; row now `ready` with re-derived content |
| TC-3.8b | 3.8 | `pending` component (no live item) resolved to floor | row `ready` with floored content via `recoverDerivation`, no degraded marker, fallback logged |
| TC-3.8c | 3.8 | tool-result summary unready, unrecoverable | floor written back is truncation, never raw |
| TC-3.8d | 3.8 | race: `failed`/`pending` component **with a claimed work item present** (DD-4) | `recoverDerivation` returns `persisted:false`; row left untouched; the turn rendering still used the floor; a later worker completion writes the real `ready` and is not clobbered |

### Flow 4 — Chunk Derivation and Compact Recovery → `test/chunk-compact-recovery.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-4.1a | 4.1 | chunk closes | detailed + brief = two separate work items |
| TC-4.1b | 4.1 | detailed ok, brief fails | states independent (`ready` / `failed`) |
| TC-4.2a | 4.2 | compact needs a `failed` detailed summary, `spyProvider` | `compactChunkMaterial` returns stored-member concat; **zero provider calls** (compact never models) |
| TC-4.3a | 4.3 | summary unrecoverable at compact | band entry = deterministic concat of stored members; no missing span |
| TC-4.4a | 4.4 | compact performs a fallback | visible warning naming what fell back |
| TC-4.4b | 4.4 | compact mid-assembly, stop requested | halts without corrupting thread |
| TC-4.5a | 4.5 | multiple missing/failed summaries | compact completes with concat fallbacks, not failure |
| TC-4.5b | 4.5 | corrupt canonical source for a span | `compactChunkMaterial` returns `blocked`; compact refuses with `state_corruption` |
| TC-4.6a | 4.6 | compact over not-ready summaries, `spyProvider` | **zero** provider calls during the entire compact |
| TC-4.7a | 4.7 | compact falls back to concat | log entry: chunk, derivation type, reason, fallback |
| TC-4.8a | 4.8 | background chunk summary, member `lower_band_projection` `pending` | summary work requeues (waits) with reason `member_projection_not_ready` — not concat, not `failed`, not a provider-failure reason |
| TC-4.8b | 4.8 | member turn source corrupt | background summary surfaces source problem |

### Flow 5 — Derivation Logging → `test/logging-surface.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-5.1a | 5.1 | write at info/warning/error | all three persisted with level |
| TC-5.2a | 5.2 | write from internal + external caller | both land via same method/store |
| TC-5.3a | 5.3 | derivation fell back | subject + rendering carry no degraded flag; fallback event only in log |
| TC-5.3b | 5.3 | derivation terminally failed | derivation record shows `failed` + reason, independent of log |
| TC-5.4a | 5.4 | mixed entries | query by level + derivation type returns only matches |
| TC-5.5a | 5.5 | logging store write fails during turn construction | construction completes; logging failure contained |

### Flow 6 — Runtime-Change Typing → `test/runtime-change-typing.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-6.1a | 6.1 | model-change runtime event at intake | typed `model_change` block with previous + new model |
| TC-6.2a | 6.2 | thinking-level-change event at intake | typed `thinking_level_change` block with previous + new level |
| TC-6.3a | 6.3 | turn with model change then thinking change | both typed blocks verbatim, in order |

---

## Architecture-Risk Tests (named)

| Risk | TC(s) | What it proves |
|---|---|---|
| Source-truth preserved | TC-2.6a | full tool result intact under truncation + summary |
| No-txn-across-provider (turn recovery) | TC-3.7a | competing write acquires lock during provider call |
| Compact makes no provider call | TC-4.2a, TC-4.6a | `spyProvider` observes zero calls |
| Recovery write-back defers to live work | TC-3.8d | claimed item present → floor does not persist; worker wins |
| Stale recovery discarded | TC-3.8a (+ version-bump variant) | `recoverDerivation` is version-checked; stale discards |
| Dependency-wait classified correctly | TC-4.8a | reason `member_projection_not_ready`, not provider failure |
| Log never rolls back work | TC-5.5a | logging failure contained, turn still completes |
| Idempotent background wait | TC-4.8a | requeue-and-wait does not duplicate work |
| Tier/cap boundaries | TC-2.3c/2.7a, TC-1.2b | threshold edges behave |
| Rename safety | Story 0 gate | rename is behavior-preserving (`verify-all` green under renamed vocabulary); `tool_call_summary` removal is a separate behavior change with its own red/green |
| Corruption blocks | TC-4.5b | only canonical source corruption stops a compact |

---

## Per-Chunk Red/Green Exit Criteria

| Chunk | Red exit | Green exit |
|---|---|---|
| 0 — rename + logging | renamed tree compiles; logging skeleton present; existing tests reference new names and fail only on logging-not-implemented | suite green under renamed vocabulary; TC-5.1a–5.5a pass. (`tool_call_summary` is renamed-but-retained here; its removal is Chunk 2.) |
| 1 — smoothing floor | smoothing tests red on missing deterministic stage/gate | TC-1.1a–1.7b pass |
| 2 — tool-result tiers + `tool_call_summary` removal | tier-gate + removal tests red (`tool_call_summary` still present) | TC-2.1a–2.8a pass; `tool_call_summary` gone from kind set/registry/`PART_PLANS`/provider |
| 3 — cascade + logging | write-back + fallback-log tests red | TC-3.1a–3.8c pass |
| 4 — chunk/compact recovery | background-wait + compact stored-member concat fallback (no model) tests red | TC-4.1a–4.8b pass |
| 5 — runtime typing | typed-block projection tests red | TC-6.1a–6.3a pass |

## Coverage Confirmation

- 39 ACs, 59 TCs, every TC mapped to a test file and assertion above.
- Every AC has ≥1 TC (verified against `epic.md`).
- Mock boundary: `DerivationProvider` only; all storage real.


## Current Run Index
- planner_turn_index: 5
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-verify completed with outcome pass and status ok.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/006-verify.json
- older_response_count: 3
- caller_input_artifact_count: 0
- prior_self_note_count: 4
- latest_self_note: "After verifier returns, accept only if outcome is pass, SV-01-001 is fixed, no open findings remain, and the story gate passed."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/006-verify.json
bytes: 3747
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "823f52db-371d-4b45-8d3e-2decaf16caa6"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ec9bb-8dfb-76a0-815b-137a14133bc0"
    continuation:
      provider: "codex"
      sessionId: "019ec9bb-8dfb-76a0-815b-137a14133bc0"
      storyId: "01-prompt-smoothing"
    mode: "followup"
    story:
      id: "01-prompt-smoothing"
      title: "Story 1: Prompt Smoothing"
    artifactsRead:
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/stories/01-prompt-smoothing.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/005-continue.json"
      - "packages/lhc/src/domains/messages/internal/smoothing.ts"
      - "packages/lhc/src/domains/messages/internal/handlers.ts"
      - "packages/lhc/src/domains/turns/internal/compose.ts"
      - "packages/lhc/test/smoothing-recovery.test.ts"
    reviewScopeSummary: "Follow-up verification focused on SV-01-001 and directly touched smoothing surfaces. The fenced-code mutation is fixed on the production path; targeted, story, and epic gates passed."
    priorFindingStatuses:
      -
        id: "SV-01-001"
        status: "resolved"
        rationale: "`cleanPrompt` now cleans prose through `cleanProse` while preserving fenced spans with `parts.push(text.slice(cursor, fenceEnd))` in `packages/lhc/src/domains/messages/internal/smoothing.ts:31`-`58`. `smoothPromptHandler` still sends the cleaned value to inference and stores it for over-cap prompts (`packages/lhc/src/domains/messages/internal/handlers.ts:83`-`104`), and the cleaned value now preserves fenced code byte-identically. Repro now returns `\"fix this\\n```ts\\nconst  i = 1;\\n\\n\\treturn  i;\\n```\\nthanks\"`. TC-1.3a was strengthened with double spaces, tab indentation, blank line, and lowercase `i`, and asserts both provider input and stored output preserve the fence (`packages/lhc/test/smoothing-recovery.test.ts:170`-`199`)."
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "AC-1.1 / TC-1.1a, TC-1.1b: deterministic prose cleaning remains covered for under-cap and over-cap prompts."
        - "AC-1.2 / TC-1.2a, TC-1.2b: handler still invokes `smoothPrompt` only at or under the cap and skips provider calls over cap."
        - "AC-1.3 / TC-1.3a: fenced code is preserved byte-identically before provider input and in stored inference output, with strengthened test coverage."
        - "AC-1.4 / TC-1.4a, TC-1.4b: deterministic-only and inference-success smoothing land `ready`."
        - "AC-1.5 / TC-1.5a, TC-1.5b: retryable smoothing failure remains pending/requeued and turn composition consumes the deterministic floor."
        - "AC-1.6 / TC-1.6a: intake remains provider-free and only queues smoothing work."
        - "AC-1.7 / TC-1.7a, TC-1.7b: terminal smoothing failure lands `failed` with reason and composition consumes the floor."
      unverified:
[]
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/smoothing-recovery.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
    productionPathFindings:
[]
    recommendedNextStep: "pass"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "No new directly touched regression or material fake-adapter/shim/placeholder production path was found in the follow-up scope."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/006-verify.json"
  startedAt: "2026-06-15T05:28:05.500Z"
  finishedAt: "2026-06-15T05:30:00.451Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/003-implementor.json
bytes: 3225
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "8c2c17b0-eaf0-4281-9e3d-01eca7dde544"
    provider: "codex"
    model: "gpt-5.5"
    role: "story_implementor"
    sessionId: "019ec9b6-7481-7490-b4fa-e5b05e9a8287"
    continuation:
      provider: "codex"
      sessionId: "019ec9b6-7481-7490-b4fa-e5b05e9a8287"
      storyId: "01-prompt-smoothing"
    outcome: "ready-for-verification"
    story:
      id: "01-prompt-smoothing"
      title: "Story 1: Prompt Smoothing"
    planSummary: "Implemented Story 1 prompt smoothing: deterministic prompt cleaning, smoothing token cap, over-cap ready floors, under-cap provider input cleaning, fenced-code prompt instruction, and pending/failed floor consumption through turn composition."
    changedFiles:
      -
        path: "packages/lhc/src/domains/messages/internal/smoothing.ts"
        reason: "Added pure deterministic cleanPrompt floor."
      -
        path: "packages/lhc/src/domains/messages/internal/handlers.ts"
        reason: "Applied deterministic cleaning before smoothing, added token-cap gate, and stored deterministic ready output when over cap."
      -
        path: "packages/lhc/src/domains/messages/index.ts"
        reason: "Exposed cleanPrompt through the messages surface for allowed cross-domain recovery use."
      -
        path: "packages/lhc/src/domains/turns/internal/compose.ts"
        reason: "Used deterministic prompt floor for not-ready smoothed_prompt consumption."
      -
        path: "packages/lhc/src/shared/derivation.ts"
        reason: "Added smoothing.maxInferenceTokens to SDK config types."
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "Added default and validation for smoothing.maxInferenceTokens."
      -
        path: "packages/lhc/src/inference/prompts/smoothing-v1.ts"
        reason: "Added fenced-code preservation instruction to smoothing prompt."
      -
        path: "packages/lhc/test/goldens/prompts/smoothing-v1.golden.json"
        reason: "Updated prompt golden for fenced-code preservation instruction."
      -
        path: "packages/lhc/test/smoothing-recovery.test.ts"
        reason: "Added Flow 1 coverage for cleaning, cap gate, provider boundary, ready states, retryable pending, terminal failure, and floor consumption."
    tests:
      added:
        - "packages/lhc/test/smoothing-recovery.test.ts"
      modified:
        - "packages/lhc/test/goldens/prompts/smoothing-v1.golden.json"
      removed:
[]
      totalAfterStory: 415
      deltaFromPriorBaseline: 10
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/smoothing-recovery.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Fixed malformed smoothing prompt string introduced during edit before verification."
        - "Adjusted turn-composition recovery assertions to check the prompt part while preserving the assistant part."
      findingsSurfaced:
[]
    openQuestions:
[]
    specDeviations:
[]
    recommendedNextStep: "Run verifier review for Story 1."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/003-implementor.json"
  startedAt: "2026-06-15T05:17:18.196Z"
  finishedAt: "2026-06-15T05:22:44.737Z"
```
</history_entry>

<history_entry>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/004-verify.json
bytes: 6534
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "80c52304-67cc-4bf4-b343-967dd56a0a70"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ec9bb-8dfb-76a0-815b-137a14133bc0"
    continuation:
      provider: "codex"
      sessionId: "019ec9bb-8dfb-76a0-815b-137a14133bc0"
      storyId: "01-prompt-smoothing"
    mode: "initial"
    story:
      id: "01-prompt-smoothing"
      title: "Story 1: Prompt Smoothing"
    artifactsRead:
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/stories/01-prompt-smoothing.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/003-implementor.json"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/001-story-validate.json"
      - "packages/lhc/src/domains/messages/internal/handlers.ts"
      - "packages/lhc/src/domains/messages/internal/smoothing.ts"
      - "packages/lhc/src/inference/prompts/smoothing-v1.ts"
      - "packages/lhc/src/domains/turns/internal/compose.ts"
      - "packages/lhc/src/domains/turns/internal/derive.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/src/scheduler.ts"
      - "packages/lhc/src/shared/derivation.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/test/smoothing-recovery.test.ts"
      - "packages/lhc/test/fixtures/provider-double.ts"
      - "packages/lhc/src/providers/deterministic.ts"
    reviewScopeSummary: "Verified Story 1 against AC/TC mapping, tech design, implementor artifact, smoothing handler/floor/prompt code, turn composition recovery floor path, retry/terminal queue behavior, and configured gates. One blocking AC-1.3 production-path issue remains."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "SV-01-001"
        severity: "major"
        title: "Deterministic cleaning mutates fenced code before inference"
        evidence: "AC-1.3/TC-1.3a requires fenced code to remain unchanged through inference smoothing. `smoothPromptHandler` computes `cleaned = cleanPrompt(text)` and sends that value to `provider.smoothPrompt` (`packages/lhc/src/domains/messages/internal/handlers.ts:83`, `packages/lhc/src/domains/messages/internal/handlers.ts:104`). `cleanPrompt` applies whitespace and casing replacements to the whole prompt (`packages/lhc/src/domains/messages/internal/smoothing.ts:3`-`10`). Direct repro: `cleanPrompt(\"fix this\\n```ts\\nconst  i = 1;\\n\\n\\treturn  i;\\n```\\nthanks\")` returned `\"fix this\\n```ts\\nconst I = 1;\\n\\nreturn I;\\n```\\nthanks\"`, changing spaces, tab indentation, and `i` inside the fenced block. The existing fenced test uses `const value = 1;` and a provider stub that returns a fixed preserved block (`packages/lhc/test/smoothing-recovery.test.ts:168`-`193`), so it does not prove byte-identical preservation for fenced content affected by deterministic cleaning."
        affectedFiles:
          - "packages/lhc/src/domains/messages/internal/smoothing.ts"
          - "packages/lhc/src/domains/messages/internal/handlers.ts"
          - "packages/lhc/test/smoothing-recovery.test.ts"
        requirementIds:
          - "AC-1.3"
          - "TC-1.3a"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    openFindings:
      -
        id: "SV-01-001"
        severity: "major"
        title: "Deterministic cleaning mutates fenced code before inference"
        evidence: "AC-1.3/TC-1.3a requires fenced code to remain unchanged through inference smoothing. `smoothPromptHandler` computes `cleaned = cleanPrompt(text)` and sends that value to `provider.smoothPrompt` (`packages/lhc/src/domains/messages/internal/handlers.ts:83`, `packages/lhc/src/domains/messages/internal/handlers.ts:104`). `cleanPrompt` applies whitespace and casing replacements to the whole prompt (`packages/lhc/src/domains/messages/internal/smoothing.ts:3`-`10`). Direct repro: `cleanPrompt(\"fix this\\n```ts\\nconst  i = 1;\\n\\n\\treturn  i;\\n```\\nthanks\")` returned `\"fix this\\n```ts\\nconst I = 1;\\n\\nreturn I;\\n```\\nthanks\"`, changing spaces, tab indentation, and `i` inside the fenced block. The existing fenced test uses `const value = 1;` and a provider stub that returns a fixed preserved block (`packages/lhc/test/smoothing-recovery.test.ts:168`-`193`), so it does not prove byte-identical preservation for fenced content affected by deterministic cleaning."
        affectedFiles:
          - "packages/lhc/src/domains/messages/internal/smoothing.ts"
          - "packages/lhc/src/domains/messages/internal/handlers.ts"
          - "packages/lhc/test/smoothing-recovery.test.ts"
        requirementIds:
          - "AC-1.3"
          - "TC-1.3a"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    requirementCoverage:
      verified:
        - "AC-1.1 / TC-1.1a, TC-1.1b: deterministic cleaning runs before provider work and over-cap prompts still store cleaned output."
        - "AC-1.2 / TC-1.2a, TC-1.2b: under-cap smoothing invokes `smoothPrompt`; over-cap smoothing stores deterministic output with no provider call."
        - "AC-1.4 / TC-1.4a, TC-1.4b: deterministic-only and inference-success smoothing land `ready`; no skipped/degraded state was found."
        - "AC-1.5 / TC-1.5a, TC-1.5b: retryable provider failure leaves `smoothed_prompt` pending and queued; turn composition consumes deterministic floor."
        - "AC-1.6 / TC-1.6a: intake queues `prompt_smoothing` and provider capture remains empty during intake."
        - "AC-1.7 / TC-1.7a, TC-1.7b: exhausted smoothing failure lands `failed` with reason; turn composition consumes deterministic floor."
      unverified:
        - "AC-1.3 / TC-1.3a: fenced-code byte preservation is contradicted by `cleanPrompt` mutating fenced content before inference."
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/smoothing-recovery.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
    productionPathFindings:
      - "`smoothPromptHandler` sends globally cleaned text to the provider, so under-cap production smoothing can mutate fenced code before the `smoothing-v1` prompt instruction has any chance to preserve it."
    recommendedNextStep: "revise"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "No material fake-adapter, shim, placeholder, or fallback workaround was found beyond the fenced-code production-path mismatch above."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/004-verify.json"
  startedAt: "2026-06-15T05:22:52.397Z"
  finishedAt: "2026-06-15T05:25:51.777Z"
```
</history_entry>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/005-continue.json
bytes: 2214
payload:
  command: "story-continue"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "3fec7f06-99e5-48bf-bcc8-9f3e751f97c6"
    provider: "codex"
    model: "gpt-5.5"
    role: "story_implementor"
    sessionId: "019ec9b6-7481-7490-b4fa-e5b05e9a8287"
    continuation:
      provider: "codex"
      sessionId: "019ec9b6-7481-7490-b4fa-e5b05e9a8287"
      storyId: "01-prompt-smoothing"
    outcome: "ready-for-verification"
    story:
      id: "01-prompt-smoothing"
      title: "Story 1: Prompt Smoothing"
    planSummary: "Addressed SV-01-001 by making deterministic prompt cleaning preserve fenced code blocks byte-identically before provider.smoothPrompt and over-cap deterministic storage, while still cleaning surrounding prose and preserving the smoothing length gate."
    changedFiles:
      -
        path: "packages/lhc/src/domains/messages/internal/smoothing.ts"
        reason: "Updated cleanPrompt to clean prose segments while preserving fenced code blocks exactly, including indentation, blank lines, spacing, casing, and line endings inside the fence."
      -
        path: "packages/lhc/test/smoothing-recovery.test.ts"
        reason: "Strengthened TC-1.3a and over-cap coverage with fenced code containing affected spacing, tab indentation, blank lines, and lowercase i casing."
    tests:
      added:
        - "packages/lhc/test/smoothing-recovery.test.ts"
      modified:
[]
      removed:
[]
      totalAfterStory: 415
      deltaFromPriorBaseline: 10
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/smoothing-recovery.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "SV-01-001: cleanPrompt no longer mutates fenced code before inference smoothing can preserve it."
      findingsSurfaced:
[]
    openQuestions:
[]
    specDeviations:
[]
    recommendedNextStep: "Return to verifier for SV-01-001 confirmation."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/005-continue.json"
  startedAt: "2026-06-15T05:26:03.328Z"
  finishedAt: "2026-06-15T05:27:54.910Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/story-lead/001-current.json
Bytes: 2600

```yaml
storyRunId: "01-prompt-smoothing-story-run-001"
storyId: "01-prompt-smoothing"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome pass and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/004-verify.json"
    provenance: "current-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/005-continue.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/006-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "codex"
    sessionId: "019ec9b6-7481-7490-b4fa-e5b05e9a8287"
    storyId: "01-prompt-smoothing"
  storyVerifier:
    provider: "codex"
    sessionId: "019ec9bb-8dfb-76a0-815b-137a14133bc0"
    storyId: "01-prompt-smoothing"
latestEventSequence: 17
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Latest implementor response reports SV-01-001 fixed and all gates passing, but acceptance requires a latest verifier pass with no open findings. Re-run verifier against the continuation artifact before any acceptance recommendation."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/006-verify.json"
replayBoundary: null
updatedAt: "2026-06-15T05:30:00.459Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After verifier returns, accept only if outcome is pass, SV-01-001 is fixed, no open findings remain, and the story gate passed.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-15T05:17:18.162Z; note="After implementation returns, verify Story 1 with the targeted story gate before considering acceptance."
- sequence=8; actionSequence=7; createdAt=2026-06-15T05:22:52.362Z; note="After verifier returns, accept only if verifier outcome is pass, no open findings remain, and story gate evidence is present."
- sequence=12; actionSequence=11; createdAt=2026-06-15T05:26:03.290Z; note="After implementor returns, run verifier again and accept only if verifier outcome is pass, SV-01-001 is fixed, no open findings remain, and story gate evidence is present."
- sequence=16; actionSequence=15; createdAt=2026-06-15T05:28:05.466Z; note="After verifier returns, accept only if outcome is pass, SV-01-001 is fixed, no open findings remain, and the story gate passed."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/story-lead/001-events.jsonl
Bytes: 7512

```yaml
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 1
  timestamp: "2026-06-15T05:17:07.092Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 2
  timestamp: "2026-06-15T05:17:18.139Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ec9b6-491e-7e72-8fba-6d1d2783ef5f"
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 3
  timestamp: "2026-06-15T05:17:18.161Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, verify Story 1 with the targeted story gate before considering acceptance."
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 4
  timestamp: "2026-06-15T05:17:18.162Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, verify Story 1 with the targeted story gate before considering acceptance."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 5
  timestamp: "2026-06-15T05:22:44.746Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 6
  timestamp: "2026-06-15T05:22:52.341Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ec9bb-7012-7632-9c69-b6c2b0684a6e"
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 7
  timestamp: "2026-06-15T05:22:52.361Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
    selfNote: "After verifier returns, accept only if verifier outcome is pass, no open findings remain, and story gate evidence is present."
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 8
  timestamp: "2026-06-15T05:22:52.362Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After verifier returns, accept only if verifier outcome is pass, no open findings remain, and story gate evidence is present."
    actionSequence: 7
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 9
  timestamp: "2026-06-15T05:25:51.785Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
    status: "ok"
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 10
  timestamp: "2026-06-15T05:26:03.268Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019ec9be-4aba-73e0-a552-aa5c7cbcbe47"
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 11
  timestamp: "2026-06-15T05:26:03.289Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-continue."
  data:
    actionType: "run-continue"
    turn: 3
    selfNote: "After implementor returns, run verifier again and accept only if verifier outcome is pass, SV-01-001 is fixed, no open findings remain, and story gate evidence is present."
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 12
  timestamp: "2026-06-15T05:26:03.290Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementor returns, run verifier again and accept only if verifier outcome is pass, SV-01-001 is fixed, no open findings remain, and story gate evidence is present."
    actionSequence: 11
    actionType: "run-continue"
    turn: 3
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 13
  timestamp: "2026-06-15T05:27:54.917Z"
  type: "child-operation-completed"
  summary: "story-continue completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/005-continue.json"
  data:
    actionType: "run-continue"
    command: "story-continue"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 14
  timestamp: "2026-06-15T05:28:05.442Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/story-lead/prompts/001-planner-turn-004.md"
    sessionId: "019ec9c0-2bb2-7391-a03e-a48a715d8e5e"
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 15
  timestamp: "2026-06-15T05:28:05.465Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 4
    selfNote: "After verifier returns, accept only if outcome is pass, SV-01-001 is fixed, no open findings remain, and the story gate passed."
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 16
  timestamp: "2026-06-15T05:28:05.466Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After verifier returns, accept only if outcome is pass, SV-01-001 is fixed, no open findings remain, and the story gate passed."
    actionSequence: 15
    actionType: "run-verify"
    turn: 4
-
  storyRunId: "01-prompt-smoothing-story-run-001"
  sequence: 17
  timestamp: "2026-06-15T05:30:00.458Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/01-prompt-smoothing/006-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "pass"
    status: "ok"
```

## State Rules
### state-rules
Bytes: 2986

Requirements source for story-local acceptance: the story file and test plan below.
Current lifecycle state: awaiting_story_lead_action

Lifecycle rules:
State: initialized
Public status: running
Allowed actions: none
Meaning: Runtime scaffolding exists, but no planner turn or child operation has started yet.
Caller implication: Treat this as startup bookkeeping only; wait for the first planner transition before routing work.

State: awaiting_story_lead_action
Public status: running
Allowed actions: run-implement, run-continue, run-self-review, run-verify, run-quick-fix, accept-story, request-ruling, block-story, fail-story
Meaning: The durable record is ready and the next fresh story-lead turn may choose one bounded action.
Caller implication: Planner output is the next source of truth; the run is waiting for a valid bounded action selection.

State: running_child_operation
Public status: running
Allowed actions: none
Meaning: The runtime is executing one bounded child operation selected by the story lead.
Caller implication: Poll runtime artifacts instead of rerouting; the current child operation is still in flight.

State: recording_result
Public status: running
Allowed actions: none
Meaning: The child result or terminal decision is being written to durable artifacts before the next transition.
Caller implication: Do not treat the run as advanced until evidence and ledger updates are durably recorded.

State: terminal
Public status: terminal-only
Allowed actions: none
Meaning: A terminal public outcome has been recorded separately from lifecycleState and the story-lead loop will not continue automatically.
Caller implication: Read the public status and final package to decide impl-lead follow-up such as accept, reopen, or ruling.

Terminal outcome rules:
Outcome: accepted
Meaning: Story-lead evidence is complete enough to recommend acceptance for impl-lead review.
Caller implication: Impl-lead still owes receipt completion, verification gates, and the story commit before accepting the story.

Outcome: needs-ruling
Meaning: The run reached a boundary that requires an explicit caller or maintainer decision.
Caller implication: Surface the ruling request instead of guessing or downgrading the decision into cleanup debt.

Outcome: blocked
Meaning: A named blocker prevents safe forward progress with the current inputs or runtime state.
Caller implication: Resolve the blocker or change the plan before resuming; do not pretend the story is ready to continue.

Outcome: failed
Meaning: An unrecoverable runtime or planner failure ended the current story-lead attempt.
Caller implication: Inspect the failure details and durable artifacts before deciding whether to replay or open a new attempt.

Outcome: interrupted
Meaning: The run stopped before a planned transition finished, usually because the caller or runtime interrupted it.
Caller implication: Use status or resume against the durable artifacts to continue from the last safe checkpoint.

## Runtime Settings
### runtime-settings
Bytes: 255

```yaml
storyGate: "cd packages/lhc && pnpm run verify"
epicGate: "cd packages/lhc && pnpm run verify-all"
plannerTimeoutMs: 600000
wholeRunTimeoutMs: 7200000
providerStartupTimeoutMs: 300000
providerActiveSilenceTimeoutMs: 600000
```

## Action Protocol
Return exactly one JSON object matching `StoryLeadAction`.

Examples:
{"action":"run-implement","rationale":"...","inputs":{"promptAddendum":"optional"},"selfNote":"optional durable reminder"}
{"action":"run-continue","rationale":"...","inputs":{"continuationRef":"storyImplementor","promptAddendum":"..."}}
{"action":"run-self-review","rationale":"...","inputs":{"artifactRefs":["/abs/path.json"],"focus":"optional","continuationRef":"storyImplementor","passes":1}}
{"action":"run-verify","rationale":"...","inputs":{"artifactRefs":["/abs/path.json"],"focus":"optional","provider":"codex"}}
{"action":"run-verify","rationale":"...","inputs":{"artifactRefs":["/abs/path.json"],"verifierContinuationRef":"storyVerifier","responseArtifactRef":"/abs/path.json"}}
{"action":"run-quick-fix","rationale":"...","inputs":{"findingRefs":["finding-001"],"remediationGoal":"...","workingDirectory":"optional"}}
{"action":"request-ruling","rationale":"...","inputs":{"decisionType":"...","question":"...","defaultRecommendation":"...","evidence":["..."],"allowedResponses":["..."]}}
{"action":"accept-story","rationale":"...","inputs":{"summary":"...","acceptanceCheckRefs":["..."],"acceptanceChecks":[{"name":"...","status":"pass","evidence":["..."],"reasoning":"..."}],"recommendedImplLeadAction":"accept"},"verification":{"finalVerifierOutcome":"pass","findings":[{"id":"...","status":"fixed","evidence":["..."]}]}}
{"action":"block-story","rationale":"...","inputs":{"reason":"...","detail":"optional","evidence":["..."]},"verification":{"finalVerifierOutcome":"block","findings":[{"id":"...","status":"unresolved","evidence":["..."]}]}}
{"action":"fail-story","rationale":"...","inputs":{"reason":"...","detail":"optional","evidence":["..."]}}

Rules:
- Choose exactly one bounded next action.
- Use only the durable story-run record in this prompt. Do not assume hidden retained planner memory exists.
- Treat `<current_response>` as the latest bounded child response and `<history_responses>` as older response history.
- If the story file and test plan are insufficient for a safe next step, request a ruling instead of asking for epic, tech design, git status, or git diff by default.
- Include `selfNote` only when you want to leave a durable reminder for a later planner turn.

## Acceptance Rubric
Choose the smallest safe bounded action that advances the story using the durable evidence already present.
Prefer continuing from valid child-operation evidence over repeating work, and keep unresolved authority-boundary questions explicit.

## Acceptance Decision Standard
Choose `accept-story` only when the latest verifier result is `pass`, no open findings remain, required proof is present, and the configured story gate passed.
If readiness is promising but gate truth is failed, unavailable, or uncertain, do not accept. Choose the smallest safe next action: verify, quick-fix, block, or request a ruling.

## Ruling Boundaries
Request a ruling when story-local requirements are insufficient, when a blocker needs a caller decision, or when the evidence conflicts in a way that the durable record cannot resolve safely.
