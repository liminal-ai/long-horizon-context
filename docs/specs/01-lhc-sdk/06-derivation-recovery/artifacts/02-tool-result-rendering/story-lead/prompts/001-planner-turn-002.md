# Story Lead Base Prompt

## Role Charter
You are the story lead for `02-tool-result-rendering` on durable story run `02-tool-result-rendering-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 2.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/stories/02-tool-result-rendering.md
Bytes: 12678

# Story 2: Tool-Result Rendering

### Summary
<!-- Jira: Summary field -->

Split tool-result rendering into deterministic full-band truncation and smooth-band summaries with tiers and per-tool guidance.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** render tool results at the right fidelity per band while retaining full source results and removing `tool_call_summary`.

**Scope In:**
- Full-band deterministic truncation using the Epic 03 visibility-boundary floor.
- Smooth-band `tool_result_summary` produced off the hot path for in-threshold results.
- First-pass tier targets and pass-through behavior.
- Per-tool summary guidance.
- Removal of `tool_call_summary`; tool-call arguments render as-is.

**Scope Out:**
- Tuning summary prompts, model choices, tier values, or per-tool guidance against real corpora.
- Rebuilding the full-band truncation floor if the Epic 03 floor already exists.

**Dependencies:** Story 1.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-2.1:** Full-band tool-result shortening uses deterministic truncation with no model call (the Epic 03 visibility-boundary floor).

- **TC-2.1a:** Truncation is deterministic
  - Given: a large tool result aged past the visibility boundary
  - When: the full band renders it
  - Then: it is truncated deterministically with no provider call, and identical input yields identical output

**AC-2.2:** Smooth-band tool-result rendering uses an inference `tool_result_summary`, produced off the hot path.

- **TC-2.2a:** Summary is inference, off hot path
  - Given: a tool result in a turn assigned to the smooth band
  - When: its summary derives
  - Then: it is produced by a queued inference work item, not on the hot path

**AC-2.3:** The summary targets a size tiered by the result's token count (first-pass tiers; tunable in the next epic), and passes a result through unchanged when it is already under target.

- **TC-2.3a:** Small result tier
  - Given: a tool result under ~1000 tokens
  - When: it is summarized
  - Then: the target compression follows the small-result tier
- **TC-2.3b:** Mid result tier
  - Given: a tool result between ~1000 and ~5000 tokens
  - When: it is summarized
  - Then: the target follows the mid tier
- **TC-2.3c:** Large result → truncate
  - Given: a tool result beyond ~5000 tokens
  - When: it is rendered for the smooth band
  - Then: it is truncated rather than inference-summarized

**AC-2.4:** Summary generation applies per-tool guidance keyed on the tool, preserving the outcome/status and the elements that matter for that tool type.

- **TC-2.4a:** Per-tool guidance applied
  - Given: tool results from two different tools
  - When: each is summarized
  - Then: the prompt includes guidance keyed to each tool, and outcome/status is preserved in both
- **TC-2.4b:** Outcome preserved
  - Given: a failed tool result
  - When: it is summarized
  - Then: the summary states the failure outcome

**AC-2.5:** The `tool_call_summary` derivation type is removed; tool-call arguments render as-is wherever a tool call appears.

- **TC-2.5a:** No tool_call_summary derivation
  - Given: a turn containing a tool call
  - When: derivations are enumerated
  - Then: no `tool_call_summary` derivation exists or is queued
- **TC-2.5b:** Call args render as-is
  - Given: a tool call in a rendered turn
  - When: the turn is composed
  - Then: the call's arguments are present as recorded (no summarization step)

**AC-2.6:** The full tool result is always retained in the record regardless of how it is rendered in any band.

- **TC-2.6a:** Full result preserved
  - Given: a tool result that is truncated in the full band and summarized in the smooth band
  - When: the record is read directly
  - Then: the original full tool result is intact

**AC-2.7:** A tool result beyond the large-tier threshold satisfies its `tool_result_summary` by deterministic truncation and lands `ready` without inference (no inference work item is created for it).

- **TC-2.7a:** Large result ready via truncation, no inference
  - Given: a tool result beyond ~5000 tokens
  - When: its smooth-band rendering is produced
  - Then: the `tool_result_summary` is the deterministic truncation, state is `ready`, and no inference work item was created

**AC-2.8:** When the background worker's in-threshold tool-result inference terminally fails, the derivation lands `failed` with its reason — the worker records the honest failure rather than flooring it. Consumers recover to the truncation floor and resolve it to `ready` at construction (Flow 3).

- **TC-2.8a:** Terminal summary failure lands failed
  - Given: tool-result inference exhausts its retry budget for an in-threshold result
  - When: the worker gives up
  - Then: state is `failed` with a reason; the truncation floor is used by consumers via the cascade

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 2 separates tool-result rendering by band. Full-band shortening uses the existing deterministic truncation floor. Smooth-band rendering uses `tool_result_summary` for in-threshold results and deterministic truncation for large results, which lands `ready` without creating inference work.

Tool calls are not summarized. Removing `tool_call_summary` must reach the derivation kind set, work-queue registry, compose part plans, provider interface, deterministic provider, and prompt surface. Full source tool results remain canonical and intact.

#### Build Strategy

Strategy: tdd-lite

Reason:
- Tier gates and removal of `tool_call_summary` are easy to partially implement.
- Tests must prove source preservation and absence of queued tool-call summaries, not just rendered output shape.

Risk Reminders:
- Fixture fidelity: tool-call arguments and full tool results must remain as recorded.
- Cross-story contract change: removed derivation type affects work queue, provider interface, prompts, and compose plans.
- Runtime adapter: in-threshold summaries still use queued provider work, never hot path.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Derivation kinds | `packages/lhc/src/shared/derivation.ts` |
| Work queue registry | `packages/lhc/src/tech-utils/work-queue/index.ts` |
| Message handlers | `packages/lhc/src/domains/messages/internal/handlers.ts` |
| Turn composition | `packages/lhc/src/domains/turns/internal/compose.ts` |
| Tool-result prompt | `packages/lhc/src/inference/prompts/tool-result-v1.ts` |
| Removed prompt/provider op | `packages/lhc/src/inference/prompts/tool-call-v1.ts`, `packages/lhc/src/providers/deterministic.ts` |
| Story tests | `packages/lhc/test/tool-result-rendering.test.ts` (planned) |

#### Design References

- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:61), lines 61-81
- [tech-design.md §DD-1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:87), lines 87-89
- [tech-design.md §DD-3](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:104), lines 104-111
- [tech-design.md §Renamed vocabulary](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:150), lines 150-178
- [tech-design.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:299), lines 299-309
- [test-plan.md §Config defaults under test](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:18), lines 18-24
- [test-plan.md §Flow 2](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:47), lines 47-62
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:121), lines 121-135

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.1a | `packages/lhc/test/tool-result-rendering.test.ts` | Aged large tool result renders through deterministic truncation with no provider call and stable output. |
| TC-2.2a | `packages/lhc/test/tool-result-rendering.test.ts` | Smooth-band summary is produced by queued inference work, not hot path. |
| TC-2.3a | `packages/lhc/test/tool-result-rendering.test.ts` | Result below 1000 tokens uses small-result target. |
| TC-2.3b | `packages/lhc/test/tool-result-rendering.test.ts` | Result from 1000 to 5000 tokens uses mid-result target. |
| TC-2.3c | `packages/lhc/test/tool-result-rendering.test.ts` | Result above 5000 tokens truncates instead of inference summarizing. |
| TC-2.4a | `packages/lhc/test/tool-result-rendering.test.ts` | Different tool results receive keyed prompt guidance and preserve outcome/status. |
| TC-2.4b | `packages/lhc/test/tool-result-rendering.test.ts` | Failed tool result summary states the failure outcome. |
| TC-2.5a | `packages/lhc/test/tool-result-rendering.test.ts` | No `tool_call_summary` derivation exists or is queued for a tool call. |
| TC-2.5b | `packages/lhc/test/tool-result-rendering.test.ts` | Tool-call arguments render as recorded with no summary step. |
| TC-2.6a | `packages/lhc/test/tool-result-rendering.test.ts` | Full source tool result remains intact after truncation and summary renderings. |
| TC-2.7a | `packages/lhc/test/tool-result-rendering.test.ts` | Large smooth-band result writes truncation as ready and creates no inference item. |
| TC-2.8a | `packages/lhc/test/tool-result-rendering.test.ts` | Exhausted in-threshold summary lands `failed` with reason and consumers use truncation floor. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Source-truth preserved | `packages/lhc/test/tool-result-rendering.test.ts` | Read canonical record after full-band truncation and smooth-band summary. | Rendering tests can pass while source content is accidentally overwritten. |
| Tier boundary | `packages/lhc/test/tool-result-rendering.test.ts` | Exercise around 1000-token and 5000-token thresholds. | Representative small/mid/large cases can miss edge behavior. |
| Type removal completeness | `cd packages/lhc && pnpm run typecheck && pnpm run test -- test/tool-result-rendering.test.ts` | References to `tool_call_summary` fail until kind set, registry, compose, provider, and prompt surfaces are cleaned up. | A single derivation enumeration test may not cover provider or work-queue leftovers. |

#### Technical Notes

- Full-band truncation reuses `truncateForFallback`; do not rebuild the Epic 03 visibility-boundary floor.
- First-pass tiers are test defaults, not permanent design constants.
- In-threshold terminal inference failure records `failed`; consumption-time recovery is owned by Story 3.

#### Anti-Shim Requirements

- Do not delete the full tool result to make truncation tests pass.
- Do not keep `tool_call_summary` as a hidden legacy kind or no-op provider method.
- Do not create inference work for large-tier tool results.

#### Production Path Proof

- Entrypoint: recorded tool result reaches message/turn derivation through existing work-queue drain and turn composition.
- Registration/default path: derivation kind registry and compose part plans select `tool_result_summary`; no production path selects `tool_call_summary`.
- Evidence: `packages/lhc/test/tool-result-rendering.test.ts` asserts queue/registry/rendering behavior and `cd packages/lhc && pnpm run verify` catches removed type references.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/tool-result-rendering.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- AC-2.1 through AC-2.8 pass with their listed TCs.
- Full source tool results remain intact.
- Large smooth-band tool results land `ready` via truncation without inference work.
- `tool_call_summary` is removed and tool-call arguments render as recorded.


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
- planner_turn_index: 2
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-implement completed with outcome ready-for-verification and status ok.
- latest_response_kind: implementor-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/003-implementor.json
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementation returns, check whether the response includes targeted test evidence for all TC-2.1a through TC-2.8a before choosing review or verify."

## Response Trail
<current_response>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/003-implementor.json
bytes: 8648
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "a357da54-f8ee-4fd7-bb65-a150773dcbd4"
    provider: "codex"
    model: "gpt-5.5"
    role: "story_implementor"
    sessionId: "019ec9c3-6fe6-70b1-9f3d-70ac5c9ed450"
    continuation:
      provider: "codex"
      sessionId: "019ec9c3-6fe6-70b1-9f3d-70ac5c9ed450"
      storyId: "02-tool-result-rendering"
    outcome: "ready-for-verification"
    story:
      id: "02-tool-result-rendering"
      title: "Story 2: Tool-Result Rendering"
    planSummary: "Implemented Story 2 by removing the tool_call_summary derivation/provider/prompt path, rendering tool-call args as recorded, splitting tool-result rendering into queued in-threshold summaries versus deterministic large-result truncation, adding tier/guidance prompt inputs, preserving full source results, and adding focused Story 2 coverage. Story and epic gates pass."
    changedFiles:
      -
        path: "packages/lhc/src/shared/derivation.ts"
        reason: "Removed tool_call_summary from derivation/provider operation contracts and added tool-result tier config."
      -
        path: "packages/lhc/src/shared/tool-result-rendering.ts"
        reason: "Added shared deterministic tool-result truncation floor."
      -
        path: "packages/lhc/src/shared/context.ts"
        reason: "Carried resolved tool-result config through the SDK seam for intake-time large-result handling."
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "Added default/validated toolResult config and passed it through the SDK seam."
      -
        path: "packages/lhc/src/shared/storage.ts"
        reason: "Added v8 cleanup migration for removed tool_call_summary work/derivation rows."
      -
        path: "packages/lhc/src/domains/threads/internal/create.ts"
        reason: "Registered the v8 migration."
      -
        path: "packages/lhc/src/tech-utils/work-queue/index.ts"
        reason: "Removed tool_call_summary from work kind registry."
      -
        path: "packages/lhc/src/domains/intake-stream/internal/pipeline.ts"
        reason: "Passed resolved tool-result config into message work queueing."
      -
        path: "packages/lhc/src/domains/messages/index.ts"
        reason: "Stopped queueing tool-call summaries and satisfied large tool-result summaries by ready truncation without work items."
      -
        path: "packages/lhc/src/domains/messages/internal/handlers.ts"
        reason: "Removed tool-call handler and added tiered tool-result summary input, guidance, outcome preservation, pass-through, and large truncation behavior."
      -
        path: "packages/lhc/src/domains/messages/internal/cascade.ts"
        reason: "Removed tool_call_summary rebuild mapping."
      -
        path: "packages/lhc/src/domains/messages/internal/forms.ts"
        reason: "Removed stale paired-call summary lookup."
      -
        path: "packages/lhc/src/domains/turns/internal/compose.ts"
        reason: "Rendered tool-call arguments directly and used the shared truncation floor for tool results."
      -
        path: "packages/lhc/src/domains/thread-view/internal/render.ts"
        reason: "Reused the shared deterministic truncation floor."
      -
        path: "packages/lhc/src/inference/adapter.ts"
        reason: "Removed summarizeToolCall routing and forwarded tool-result outcome, target, and guidance to prompts."
      -
        path: "packages/lhc/src/inference/prompts/index.ts"
        reason: "Removed tool-call prompt registration/default assignment."
      -
        path: "packages/lhc/src/inference/prompts/tool-call-v1.ts"
        reason: "Deleted removed prompt surface."
      -
        path: "packages/lhc/src/inference/prompts/tool-result-v1.ts"
        reason: "Added outcome, target token, and per-tool guidance prompt content."
      -
        path: "packages/lhc/src/providers/deterministic.ts"
        reason: "Removed summarizeToolCall and updated tool-result input shape."
      -
        path: "packages/lhc/test/tool-result-rendering.test.ts"
        reason: "Added Story 2 tests for large truncation, queued summaries, tier/guidance inputs, no tool_call_summary, source preservation, and terminal failure."
      -
        path: "packages/lhc/test/fixtures/provider-double.ts"
        reason: "Updated provider double operation set and tool-result input shape."
      -
        path: "packages/lhc/test/fixtures/work-handlers.ts"
        reason: "Removed test handler for removed work kind."
      -
        path: "packages/lhc/test/derivation-messages.test.ts"
        reason: "Updated legacy message derivation expectations for removed tool-call summaries and large-result truncation."
      -
        path: "packages/lhc/test/derivation-turns.test.ts"
        reason: "Updated tool-run composition assertions to use recorded call args."
      -
        path: "packages/lhc/test/epic-fix-02.test.ts"
        reason: "Updated cascade/straggler tests for removed tool-call summaries."
      -
        path: "packages/lhc/test/fixtures.test.ts"
        reason: "Updated deterministic provider operation-count expectations."
      -
        path: "packages/lhc/test/inference-adapter.test.ts"
        reason: "Updated adapter outcome test for tool-result-only summaries."
      -
        path: "packages/lhc/test/inference-prompts.test.ts"
        reason: "Updated prompt registry/golden tests for six derivation prompts and new tool-result prompt input."
      -
        path: "packages/lhc/test/inference-routing.test.ts"
        reason: "Removed routing expectations for removed derivation kind."
      -
        path: "packages/lhc/test/inspect-health.test.ts"
        reason: "Updated health counts after removing tool-call summary rows."
      -
        path: "packages/lhc/test/inspect-overview.test.ts"
        reason: "Updated overview counts after removing tool-call summary rows."
      -
        path: "packages/lhc/test/inspect-overview.test.ts"
        reason: "Removed removed provider operation from refusal double."
      -
        path: "packages/lhc/test/inspect-view.test.ts"
        reason: "Removed removed provider operation from refusal double."
      -
        path: "packages/lhc/test/mutations-delete.test.ts"
        reason: "Updated delete cascade expectations for removed tool-call summaries."
      -
        path: "packages/lhc/test/work-execution.test.ts"
        reason: "Updated queue/drain counts after removing tool-call summary work."
      -
        path: "packages/lhc/test/work-queue.test.ts"
        reason: "Updated work registry and durability expectations after removing tool-call summary work."
      -
        path: "packages/lhc/test/thread-migration.test.ts"
        reason: "Updated expected current schema version to v8."
      -
        path: "packages/lhc/test/view-fixture.test.ts"
        reason: "Updated expected current schema version to v8."
      -
        path: "packages/lhc/test/goldens/prompts/tool-result-v1.golden.json"
        reason: "Updated committed prompt golden for outcome/target/guidance prompt."
      -
        path: "packages/lhc/test/goldens/g2-edge-exclusion.json"
        reason: "Updated view-selection golden after token-budget shift from removing tool-call summaries."
    tests:
      added:
        - "packages/lhc/test/tool-result-rendering.test.ts"
      modified:
        - "packages/lhc/test/derivation-messages.test.ts"
        - "packages/lhc/test/derivation-turns.test.ts"
        - "packages/lhc/test/epic-fix-02.test.ts"
        - "packages/lhc/test/fixtures.test.ts"
        - "packages/lhc/test/fixtures/provider-double.ts"
        - "packages/lhc/test/fixtures/work-handlers.ts"
        - "packages/lhc/test/inference-adapter.test.ts"
        - "packages/lhc/test/inference-prompts.test.ts"
        - "packages/lhc/test/inference-routing.test.ts"
        - "packages/lhc/test/inspect-health.test.ts"
        - "packages/lhc/test/inspect-overview.test.ts"
        - "packages/lhc/test/inspect-view.test.ts"
        - "packages/lhc/test/mutations-delete.test.ts"
        - "packages/lhc/test/thread-migration.test.ts"
        - "packages/lhc/test/view-fixture.test.ts"
        - "packages/lhc/test/work-execution.test.ts"
        - "packages/lhc/test/work-queue.test.ts"
        - "packages/lhc/test/goldens/prompts/tool-result-v1.golden.json"
        - "packages/lhc/test/goldens/g2-edge-exclusion.json"
      removed:
[]
      totalAfterStory: 406
      deltaFromPriorBaseline: 4
    gatesRun:
      -
        command: "cd packages/lhc && pnpm run typecheck"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm exec vitest run test/tool-result-rendering.test.ts"
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
        - "Large-result enqueue-time threshold now uses resolved SDK toolResult config instead of a hard-coded-only path."
        - "Thread-view and turn/message rendering now share the same deterministic truncation helper."
        - "Removed remaining production references to summarizeToolCall/tool-call prompt registration."
        - "Updated stale legacy tests and goldens to the removed tool-call summary contract."
      findingsSurfaced:
[]
    openQuestions:
[]
    specDeviations:
[]
    recommendedNextStep: "Hand to verification for Story 2 acceptance review."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/003-implementor.json"
  startedAt: "2026-06-15T05:31:28.984Z"
  finishedAt: "2026-06-15T05:48:58.237Z"
```
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/story-lead/001-current.json
Bytes: 1740

```yaml
storyRunId: "02-tool-result-rendering-story-run-001"
storyId: "02-tool-result-rendering"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-implement completed with outcome ready-for-verification and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/003-implementor.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "codex"
    sessionId: "019ec9c3-6fe6-70b1-9f3d-70ac5c9ed450"
    storyId: "02-tool-result-rendering"
latestEventSequence: 5
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "No prior bounded child response is recorded, and the durable state is awaiting a story-lead action. The smallest safe next action is to implement Story 2 against the provided story file and test plan."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/003-implementor.json"
replayBoundary: null
updatedAt: "2026-06-15T05:48:58.247Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation returns, check whether the response includes targeted test evidence for all TC-2.1a through TC-2.8a before choosing review or verify.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-15T05:31:28.948Z; note="After implementation returns, check whether the response includes targeted test evidence for all TC-2.1a through TC-2.8a before choosing review or verify."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/story-lead/001-events.jsonl
Bytes: 2150

```yaml
-
  storyRunId: "02-tool-result-rendering-story-run-001"
  sequence: 1
  timestamp: "2026-06-15T05:31:16.565Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "02-tool-result-rendering-story-run-001"
  sequence: 2
  timestamp: "2026-06-15T05:31:28.929Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ec9c3-3f61-7750-b881-affc9edcd51a"
-
  storyRunId: "02-tool-result-rendering-story-run-001"
  sequence: 3
  timestamp: "2026-06-15T05:31:28.947Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, check whether the response includes targeted test evidence for all TC-2.1a through TC-2.8a before choosing review or verify."
-
  storyRunId: "02-tool-result-rendering-story-run-001"
  sequence: 4
  timestamp: "2026-06-15T05:31:28.948Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, check whether the response includes targeted test evidence for all TC-2.1a through TC-2.8a before choosing review or verify."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "02-tool-result-rendering-story-run-001"
  sequence: 5
  timestamp: "2026-06-15T05:48:58.247Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/02-tool-result-rendering/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
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
