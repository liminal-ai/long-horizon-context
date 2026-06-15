# Story Lead Base Prompt

## Role Charter
You are the story lead for `04-chunk-derivation-compact-recovery` on durable story run `04-chunk-derivation-compact-recovery-story-run-001`.
Select exactly one bounded next action for this `resume` turn.
This is planner turn 6.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/stories/04-chunk-derivation-compact-recovery.md
Bytes: 13919

# Story 4: Chunk Derivation and Compact Recovery

### Summary
<!-- Jira: Summary field -->

Derive independent chunk summaries and make smart compact fall back to deterministic stored-member concatenation without provider calls.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** instantiate recovery at chunk and compact level so compact produces usable band material with warnings and blocks only on canonical source corruption.

**Scope In:**
- Independent `chunk_summary_detailed` and `chunk_summary_brief` work items and states.
- Smart compact recovery through `turns.compactChunkMaterial`.
- Deterministic stored-member concatenation fallback with no model call.
- Compact warnings and stoppability.
- Compact fallback logging.
- Background chunk-summary requeue/wait behavior for not-ready member `lower_band_projection`.
- Thread-view calls turns surface, never turns internals.

**Scope Out:**
- pi-lhc rendering mechanics for warning buffers.
- Provider calls during smart compact.

**Dependencies:** Story 3.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-4.1:** A closed chunk's detailed and brief summaries are derived as two independent work items with independent states.

- **TC-4.1a:** Two independent items
  - Given: a chunk closes
  - When: its summaries are queued
  - Then: detailed and brief are separate work items
- **TC-4.1b:** Independent states
  - Given: detailed succeeds and brief fails
  - When: states are read
  - Then: detailed is `ready` and brief is `failed`, independently

**AC-4.2:** At compact, a chunk summary that is not ready (`pending` or `failed`) resolves through `turns.compactChunkMaterial` to a deterministic stored-member concatenation; compact makes no provider call and does not re-derive the summary.

- **TC-4.2a:** Compact uses concat, no provider call
  - Given: a compact needs a `failed` detailed summary, with a provider spy installed
  - When: compact runs
  - Then: the band entry is the deterministic stored-member concat and zero provider calls occur

**AC-4.3:** When a chunk summary still cannot be made ready, compact falls back to a deterministic concatenation of the chunk's member content (uncompressed) rather than leaving a gap.

- **TC-4.3a:** Concat fallback, no gap
  - Given: a chunk summary that is not ready at compact time
  - When: compact assembles the band
  - Then: the band entry is the deterministic concatenation of member content, and no span is missing

**AC-4.4:** Compact surfaces a visible warning for each fallback it performs; the user can see the cleanup/derivation work is delaying the compact and can stop it.

- **TC-4.4a:** Warning surfaced
  - Given: a compact performs a chunk-summary fallback
  - When: it runs
  - Then: a warning is emitted (visible channel) naming what fell back
- **TC-4.4b:** Stoppable
  - Given: a compact is performing its fallback assembly
  - When: the user requests stop
  - Then: compact halts without corrupting the thread

**AC-4.5:** A smart compact never fails because a derivation is missing or failed; it fails only when canonical source state needed for the compacted span is corrupt or unreadable.

- **TC-4.5a:** Missing derivation degrades
  - Given: multiple missing/failed chunk summaries
  - When: compact runs
  - Then: it completes with fallbacks, not a failure
- **TC-4.5b:** Source corruption blocks
  - Given: canonical source for a chunk's turns is corrupt
  - When: compact runs
  - Then: compact refuses with a corruption error rather than fabricating content

**AC-4.6:** Smart compact performs no provider calls at all; background chunk derivation performs no provider work inside a DB write transaction.

- **TC-4.6a:** Compact makes zero provider calls
  - Given: a compact over a thread with not-ready chunk summaries, provider spy installed
  - When: it runs
  - Then: zero provider calls occur during the entire compact

**AC-4.7:** Every compact-time fallback is logged with derivation type, subject id, reason, and the fallback used.

- **TC-4.7a:** Compact fallback logged
  - Given: a compact falls back to concatenation for a chunk
  - When: it completes
  - Then: a log entry records the chunk, derivation type, reason, and fallback

**AC-4.8:** Background chunk-summary derivation behaves differently from compact-time recovery when a member `lower_band_projection` is not ready: because no consumer is waiting, it **requeues and waits** for the input rather than concatenating or failing. It blocks (no progress) only on source corruption of a member; a not-ready member input degrades to a requeue, never a hole or a terminal failure.

- **TC-4.8a:** Background summary requeues on not-ready input
  - Given: a chunk summary derives in the background while a member `lower_band_projection` is `pending`
  - When: the worker runs
  - Then: the chunk summary work requeues (waits) rather than concatenating or landing `failed`
- **TC-4.8b:** Member source corruption surfaces
  - Given: a member turn's canonical source is corrupt
  - When: the background chunk summary attempts to derive
  - Then: it surfaces the source problem (does not silently loop or fabricate)

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 4 owns the chunk and compact recovery boundary. Background chunk-summary derivation waits for member `lower_band_projection` inputs because no consumer is waiting. Compact is a consumer path and never calls a provider; it asks the turns surface for ready summary material or deterministic stored-member concatenation.

Thread-view calls `turns.compactChunkMaterial(...)` and never imports `domains/turns/internal/*`. Compact logs and warns on fallback, can stop cleanly, and blocks only when canonical source material is corrupt.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The story spans background worker wait behavior, thread-view compact assembly, public turns surface, source-corruption blocking, warning/stop behavior, and fallback logging.
- The compact no-provider invariant must be proven through the production compact path, not a helper.

Risk Reminders:
- Thread-view/turns boundary: thread-view must use the turns surface only.
- Degraded-state scoping: missing summaries degrade to concat; source corruption blocks.
- Active path/source path selection: compact must read stored member content for the compacted span.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Background chunk summary | `packages/lhc/src/domains/turns/internal/chunks.ts` |
| Turns public surface | `packages/lhc/src/domains/turns/index.ts` |
| Chunk fallback assembly | `packages/lhc/src/domains/turns/internal/chunk-recovery.ts` (NEW per tech design) |
| Compact snapshot | `packages/lhc/src/domains/thread-view/internal/snapshot.ts` |
| Readiness sweep dependency | `packages/lhc/src/domains/thread-view/internal/sweep.ts` |
| Boundary checks | `packages/lhc/scripts/check-boundaries.mjs` |
| Story tests | `packages/lhc/test/chunk-compact-recovery.test.ts` (planned) |

#### Design References

- [tech-design.md §Context](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:10), lines 10-27
- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:61), lines 61-81
- [tech-design.md §DD-6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:131), lines 131-138
- [tech-design.md §DD-7](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:140), lines 140-144
- [tech-design.md §Compact chunk material interface](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:226), lines 226-236
- [tech-design.md §Compact chunk material mechanics](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:283), lines 283-295
- [test-plan.md §Flow 4](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:83), lines 83-98
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:121), lines 121-135

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-4.1a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Chunk close queues detailed and brief summaries as separate work items. |
| TC-4.1b | `packages/lhc/test/chunk-compact-recovery.test.ts` | Detailed and brief summary states can diverge independently. |
| TC-4.2a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Failed detailed summary at compact returns stored-member concat through `compactChunkMaterial` and zero provider calls. |
| TC-4.3a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Unready summary yields deterministic concat band entry with no missing span. |
| TC-4.4a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Compact fallback emits visible warning naming what fell back. |
| TC-4.4b | `packages/lhc/test/chunk-compact-recovery.test.ts` | Stop request during fallback assembly halts without corrupting thread. |
| TC-4.5a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Multiple missing/failed summaries complete compact with concat fallbacks. |
| TC-4.5b | `packages/lhc/test/chunk-compact-recovery.test.ts` | Corrupt canonical source makes `compactChunkMaterial` return blocked and compact refuse with `state_corruption`. |
| TC-4.6a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Compact over not-ready summaries records zero provider calls for the entire compact. |
| TC-4.7a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Compact concat fallback writes log entry with chunk, derivation type, reason, and fallback. |
| TC-4.8a | `packages/lhc/test/chunk-compact-recovery.test.ts` | Background chunk summary requeues with `member_projection_not_ready`, not concat/failed/provider failure. |
| TC-4.8b | `packages/lhc/test/chunk-compact-recovery.test.ts` | Member turn source corruption surfaces instead of looping or fabricating. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Compact makes no provider call | `packages/lhc/test/chunk-compact-recovery.test.ts` | `spyProvider` observes zero calls through full compact path with not-ready summaries. | Helper-level concat tests would not prove compact avoids provider work. |
| Thread-view boundary | `cd packages/lhc && pnpm run boundaries` | Boundary check fails if thread-view imports `domains/turns/internal/*`. | Functional tests can pass while the module boundary is violated. |
| Dependency-wait classification | `packages/lhc/test/chunk-compact-recovery.test.ts` | Not-ready member projection requeues with `member_projection_not_ready`. | A generic retry test can misclassify normal dependency waiting as provider failure. |
| Idempotent background wait | `packages/lhc/test/chunk-compact-recovery.test.ts` | Requeue-and-wait does not duplicate work items across retries. | Single-run checks do not prove retry stability. |
| Corruption blocks | `packages/lhc/test/chunk-compact-recovery.test.ts` | Canonical source corruption blocks compact while missing derivations degrade. | Fallback tests alone can accidentally fabricate corrupt source content. |

#### Technical Notes

- Compact never calls a model/provider. Not-ready chunk summaries compact through `turns.compactChunkMaterial(...)` to stored-member concat; healing is sweep plus background drain plus next compact.
- Background summary waits on not-ready member `lower_band_projection` and returns retryable reason `member_projection_not_ready`.
- `compactChunkMaterial(...)` returns `ready`, `concat`, or `blocked`; thread-view handles warning/logging/refusal based on that result.

#### Anti-Shim Requirements

- Do not import `domains/turns/internal/*` from thread-view.
- Do not call provider from compact or hide a provider call behind the turns surface.
- Do not satisfy fallback with placeholder text; concat must use stored member content.
- Do not classify member-projection waiting as provider failure.

#### Production Path Proof

- Entrypoint: smart compact through `domains/thread-view/internal/snapshot.ts`.
- Registration/default path: snapshot calls public `domains/turns/index.ts` `compactChunkMaterial(...)` for not-ready chunk summaries.
- Evidence: `packages/lhc/test/chunk-compact-recovery.test.ts` runs compact with `spyProvider` and `cd packages/lhc && pnpm run boundaries` proves thread-view uses the turns surface, never internals.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/chunk-compact-recovery.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- AC-4.1 through AC-4.8 pass with their listed TCs.
- Smart compact makes zero provider calls.
- Compact uses `turns.compactChunkMaterial`; thread-view calls turns surface, never turns internals.
- Missing derivations degrade through stored-member concatenation; canonical source corruption blocks.
- Background chunk-summary derivation requeues on not-ready member `lower_band_projection`.


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
- planner_turn_index: 6
- mode: resume
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-verify completed with outcome pass and status ok.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/008-verify.json
- older_response_count: 3
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementation, require verifier evidence for zero provider calls through the full smart compact path, thread-view boundary proof, fallback logging, stoppability, and background requeue reason member_projection_not_ready before recommending acceptance."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/008-verify.json
bytes: 4931
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "e4f02f73-89e5-49b1-8466-f16a5d4e9796"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eca1a-5d0c-7ee1-87fe-f2ca34cd07ff"
    continuation:
      provider: "codex"
      sessionId: "019eca1a-5d0c-7ee1-87fe-f2ca34cd07ff"
      storyId: "04-chunk-derivation-compact-recovery"
    mode: "followup"
    story:
      id: "04-chunk-derivation-compact-recovery"
      title: "Story 4: Chunk Derivation and Compact Recovery"
    artifactsRead:
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/stories/04-chunk-derivation-compact-recovery.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/007-continue.json"
      - "packages/lhc/src/domains/turns/internal/forms.ts"
      - "packages/lhc/src/domains/turns/internal/derive.ts"
      - "packages/lhc/test/chunk-compact-recovery.test.ts"
      - "packages/lhc/src/domains/thread-view/index.ts"
      - "packages/lhc/src/domains/thread-view/internal/render.ts"
      - "packages/lhc/src/domains/thread-view/internal/select.ts"
      - "packages/lhc/src/domains/turns/index.ts"
      - "packages/lhc/src/domains/turns/internal/chunk-recovery.ts"
    reviewScopeSummary: "Follow-up verification focused on SV-04-001 and directly touched surfaces. The missing-member source corruption path now preserves corrupt chunk_member rows, blocks before provider summary calls, has TC-4.8b coverage for both chunk summary types, and passes the configured gates. Prior Story 4 proof for compact no-provider behavior, boundary, warnings/logging, stoppability, and member_projection_not_ready requeue remains intact."
    priorFindingStatuses:
      -
        id: "SV-04-001"
        status: "resolved"
        rationale: "Resolved by code and focused probe. readMemberProjections now LEFT JOINs turns and returns sourceCorruptionReason when a chunk member references a missing canonical turn at packages/lhc/src/domains/turns/internal/forms.ts:129-166. chunkSummaryHandler blocks immediately on that reason before provider calls at packages/lhc/src/domains/turns/internal/derive.ts:289-294. TC-4.8b now deletes t1 with foreign_keys disabled and asserts both chunk_summary_detailed and chunk_summary_brief land blocked at packages/lhc/test/chunk-compact-recovery.test.ts:305-324. The prior focused corruption probe now returns blocked with reason source_damaged: canonical record corrupt: chunk c1 member t1 references missing turn."
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "AC-4.1 / TC-4.1a-b: existing chunk-compact test still verifies independent detailed/brief summary work and divergent ready/failed states."
        - "AC-4.2 / TC-4.2a and AC-4.6 / TC-4.6a: compact no-provider proof remains covered by the full compact path with provider input capture equal to []."
        - "AC-4.3 / TC-4.3a: stored-member concat remains wired through turns.compactChunkMaterial into thread-view selection/rendering."
        - "AC-4.4 / TC-4.4a-b: fallback warnings and compact_stopped behavior remain covered in chunk-compact tests."
        - "AC-4.5 / TC-4.5b: compact canonical member-source corruption still refuses with state_corruption."
        - "AC-4.7 / TC-4.7a: compact fallback logging still records derivationType, subjectId, reason, and stored_member_concat fallback."
        - "AC-4.8 / TC-4.8a: not-ready lower_band_projection still requeues with member_projection_not_ready and remains queued after one attempt."
        - "AC-4.8 / TC-4.8b: canonical missing member turn now blocks both chunk summary derivations instead of fabricating ready output."
        - "Thread-view boundary: verify runs boundaries successfully, and focused rg found no thread-view import of domains/turns/internal/*."
      unverified:
[]
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/chunk-compact-recovery.test.ts test/mutations-delete.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm exec tsx <focused TC-4.8b missing-member corruption probe>"
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
      - "Production path audit found no material fake adapter, shim, placeholder, or non-real execution path in the directly touched Story 4 runtime code."
      - "verify and verify-all passed with 423 passed and 9 real-inference tests skipped because LHC_OPENROUTER_KEY is unset; both configured gate commands exited 0."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/008-verify.json"
  startedAt: "2026-06-15T07:15:13.010Z"
  finishedAt: "2026-06-15T07:16:52.792Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/003-implementor.json
bytes: 4625
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "40cbcc1b-6335-4452-a943-4ca3c163973f"
    provider: "codex"
    model: "gpt-5.5"
    role: "story_implementor"
    sessionId: "019ec9f6-24ea-72c3-bed0-3179062c9152"
    continuation:
      provider: "codex"
      sessionId: "019ec9f6-24ea-72c3-bed0-3179062c9152"
      storyId: "04-chunk-derivation-compact-recovery"
    outcome: "ready-for-verification"
    story:
      id: "04-chunk-derivation-compact-recovery"
      title: "Story 4: Chunk Derivation and Compact Recovery"
    planSummary: "Implemented Story 4 chunk recovery: background chunk summaries now wait/requeue on not-ready member lower-band projections, compact resolves not-ready chunk summaries through the public turns compactChunkMaterial surface to deterministic stored-member concat without provider calls, selected compact fallbacks emit warnings and logs, stop requests halt before writes, and source corruption blocks compact."
    changedFiles:
      -
        path: "packages/lhc/src/domains/turns/internal/chunk-recovery.ts"
        reason: "Added turns-owned stored-member concat recovery for compact-time chunk summary material, including blocked results for unreadable canonical source."
      -
        path: "packages/lhc/src/domains/turns/index.ts"
        reason: "Exposed compactChunkMaterial on the turns public surface for thread-view compact to call."
      -
        path: "packages/lhc/src/domains/turns/internal/derive.ts"
        reason: "Changed background chunk summary derivation to requeue with member_projection_not_ready for not-ready member lower_band_projection and block on damaged member projection state."
      -
        path: "packages/lhc/src/domains/thread-view/index.ts"
        reason: "Wired compact through turns.compactChunkMaterial, returned visible fallback warnings, logged compact fallbacks, honored stop signal, and blocked on source corruption."
      -
        path: "packages/lhc/src/domains/thread-view/internal/render.ts"
        reason: "Updated chunk band representations to use ready summary or stored-member concat fallback instead of old chunk summary ladder gaps."
      -
        path: "packages/lhc/src/domains/thread-view/internal/select.ts"
        reason: "Thread-view selection now consumes compact chunk material supplied through the turns surface."
      -
        path: "packages/lhc/src/shared/view.ts"
        reason: "Added compact fallback warnings to CompactReceipt."
      -
        path: "packages/lhc/src/shared/errors.ts"
        reason: "Added compact_stopped caller error code."
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "Allowed threadView.compact callers to pass a stop signal."
      -
        path: "packages/lhc/test/chunk-compact-recovery.test.ts"
        reason: "Added Story 4 coverage for independent chunk summary states, compact concat fallback, zero provider calls, warnings/logging, stoppability, corruption blocking, and background wait/block behavior."
      -
        path: "packages/lhc/test/view-compact.test.ts"
        reason: "Updated prior compact fallback expectations to the Story 4 stored-member concat contract."
      -
        path: "packages/lhc/test/inspect-view.test.ts"
        reason: "Updated stored view inspection expectations for no-gap chunk compact fallback."
    tests:
      added:
        - "packages/lhc/test/chunk-compact-recovery.test.ts"
      modified:
        - "packages/lhc/test/view-compact.test.ts"
        - "packages/lhc/test/inspect-view.test.ts"
      removed:
[]
      totalAfterStory: 401
      deltaFromPriorBaseline: 1
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/chunk-compact-recovery.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm exec vitest run test/view-compact.test.ts test/inspect-view.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm exec tsc --noEmit"
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
        - "Corrected background wait coverage to use nonzero backoff so retryable member_projection_not_ready remains queued instead of exhausting in a single drain."
        - "Updated older compact and inspect assertions that still expected the pre-Story-4 gap/detail-truncation fallback behavior."
        - "Confirmed thread-view has no imports from domains/turns/internal and boundaries pass."
      findingsSurfaced:
[]
    openQuestions:
[]
    specDeviations:
[]
    recommendedNextStep: "Run story verification review."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/003-implementor.json"
  startedAt: "2026-06-15T06:26:52.119Z"
  finishedAt: "2026-06-15T06:35:50.956Z"
```
</history_entry>

<history_entry>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/006-verify.json
bytes: 8223
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "0c24e190-0af9-4350-9126-10429b6bc715"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eca1a-5d0c-7ee1-87fe-f2ca34cd07ff"
    continuation:
      provider: "codex"
      sessionId: "019eca1a-5d0c-7ee1-87fe-f2ca34cd07ff"
      storyId: "04-chunk-derivation-compact-recovery"
    mode: "initial"
    story:
      id: "04-chunk-derivation-compact-recovery"
      title: "Story 4: Chunk Derivation and Compact Recovery"
    artifactsRead:
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/stories/04-chunk-derivation-compact-recovery.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/impl-run.config.json"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/team-impl-log.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/003-implementor.json"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/004-verify.json"
      - "packages/lhc/src/domains/turns/index.ts"
      - "packages/lhc/src/domains/turns/internal/chunks.ts"
      - "packages/lhc/src/domains/turns/internal/chunk-recovery.ts"
      - "packages/lhc/src/domains/turns/internal/derive.ts"
      - "packages/lhc/src/domains/turns/internal/forms.ts"
      - "packages/lhc/src/domains/thread-view/index.ts"
      - "packages/lhc/src/domains/thread-view/internal/select.ts"
      - "packages/lhc/src/domains/thread-view/internal/render.ts"
      - "packages/lhc/src/domains/thread-view/internal/snapshot.ts"
      - "packages/lhc/src/domains/thread-view/internal/sweep.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/src/scheduler.ts"
      - "packages/lhc/src/shared/derivation.ts"
      - "packages/lhc/src/shared/storage.ts"
      - "packages/lhc/test/chunk-compact-recovery.test.ts"
      - "packages/lhc/test/fixtures/provider-double.ts"
      - "packages/lhc/package.json"
    reviewScopeSummary: "Initial verification of Story 4 against AC-4.1 through AC-4.8 and TC-4.1a through TC-4.8b. Reviewed the turns background chunk-summary path, public compactChunkMaterial surface, thread-view compact path, story tests, implementation artifact, and configured gates. One blocking production-path issue remains in background canonical-source corruption handling."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "SV-04-001"
        severity: "major"
        title: "Background chunk summary can fabricate ready output after member source corruption"
        evidence: "TC-4.8b requires member canonical source corruption to surface rather than loop or fabricate. In packages/lhc/src/domains/turns/internal/forms.ts:125-136, readMemberProjections uses an inner JOIN to turns with t.deleted_at IS NULL, so a chunk_member row whose turn row is missing is silently removed from the member set. packages/lhc/src/domains/turns/internal/derive.ts:289-318 then treats the returned member list as complete and calls summarizeChunkDetailed/summarizeChunkBrief when the remaining rows are ready. The existing TC-4.8b test at packages/lhc/test/chunk-compact-recovery.test.ts:296-305 only sets the lower_band_projection derivation row to blocked; it does not corrupt the canonical member turn source. A focused corruption probe deleting turns.t1 with foreign_keys disabled, then draining w-c1-chunk_summary_detailed-vx, failed the expected blocked assertion with: expected blocked source corruption, got {\"state\":\"ready\",\"reason\":null,\"content\":\"detailed(689a2470:)\"}."
        affectedFiles:
          - "packages/lhc/src/domains/turns/internal/forms.ts"
          - "packages/lhc/src/domains/turns/internal/derive.ts"
          - "packages/lhc/test/chunk-compact-recovery.test.ts"
        requirementIds:
          - "AC-4.8"
          - "TC-4.8b"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    openFindings:
      -
        id: "SV-04-001"
        severity: "major"
        title: "Background chunk summary can fabricate ready output after member source corruption"
        evidence: "TC-4.8b requires member canonical source corruption to surface rather than loop or fabricate. In packages/lhc/src/domains/turns/internal/forms.ts:125-136, readMemberProjections uses an inner JOIN to turns with t.deleted_at IS NULL, so a chunk_member row whose turn row is missing is silently removed from the member set. packages/lhc/src/domains/turns/internal/derive.ts:289-318 then treats the returned member list as complete and calls summarizeChunkDetailed/summarizeChunkBrief when the remaining rows are ready. The existing TC-4.8b test at packages/lhc/test/chunk-compact-recovery.test.ts:296-305 only sets the lower_band_projection derivation row to blocked; it does not corrupt the canonical member turn source. A focused corruption probe deleting turns.t1 with foreign_keys disabled, then draining w-c1-chunk_summary_detailed-vx, failed the expected blocked assertion with: expected blocked source corruption, got {\"state\":\"ready\",\"reason\":null,\"content\":\"detailed(689a2470:)\"}."
        affectedFiles:
          - "packages/lhc/src/domains/turns/internal/forms.ts"
          - "packages/lhc/src/domains/turns/internal/derive.ts"
          - "packages/lhc/test/chunk-compact-recovery.test.ts"
        requirementIds:
          - "AC-4.8"
          - "TC-4.8b"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    requirementCoverage:
      verified:
        - "AC-4.1 / TC-4.1a-b: enqueueChunkSummaries queues chunk_summary_detailed and chunk_summary_brief as separate work items; story test verifies detailed ready while brief fails independently."
        - "AC-4.2 / TC-4.2a: thread-view compact calls turnsDomain.compactChunkMaterial and story test verifies stored-member concat with captured provider calls equal to []."
        - "AC-4.3 / TC-4.3a: compact selection/render use stored_member_concat material; story test pull contains member content and no unavailable gap text."
        - "AC-4.4 / TC-4.4a-b: compact receipt warnings and log emission are covered, and aborted signal returns compact_stopped before view write."
        - "AC-4.5 / TC-4.5a-b: compactChunkMaterialFromStoredMembers maps missing/failed summaries to concat and compact source-corruption test refuses with state_corruption."
        - "AC-4.6 / TC-4.6a: compact provider no-call invariant is covered by spy provider, and scheduler dispatch runs handlers outside claim/complete transactions."
        - "AC-4.7 / TC-4.7a: compact fallback writes log entries with derivationType, subjectId, reason, and floorUsed; story test queries the log."
        - "AC-4.8 / TC-4.8a: not-ready member lower_band_projection returns retryable member_projection_not_ready and story test verifies the item remains queued with attempts=1."
        - "Thread-view boundary: pnpm run boundaries passed and rg found no thread-view import of domains/turns/internal/*."
      unverified:
        - "AC-4.8 / TC-4.8b: actual canonical member-source corruption in background chunk summary is not surfaced; focused probe showed ready output after deleting a member turn row."
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/chunk-compact-recovery.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm exec tsx <focused TC-4.8b missing-member corruption probe>"
        result: "fail"
    productionPathFindings:
      - "Background chunk-summary derivation can complete with a ready summary after canonical chunk member corruption because readMemberProjections filters missing/deleted member turns before the handler checks inputs."
    recommendedNextStep: "revise"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "No material fake adapter, shim, placeholder, or non-real runtime path was found in the Story 4 production path; provider doubles are confined to tests."
      - "verify and verify-all passed with 423 passed and 9 real-inference tests skipped because LHC_OPENROUTER_KEY is unset; the Story 4 decision is revise due the failing focused TC-4.8b production-path probe."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/006-verify.json"
  startedAt: "2026-06-15T07:06:25.806Z"
  finishedAt: "2026-06-15T07:11:49.467Z"
```
</history_entry>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/007-continue.json
bytes: 3056
payload:
  command: "story-continue"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "a0efdbf3-8d89-4f1b-a538-ab72a206433b"
    provider: "codex"
    model: "gpt-5.5"
    role: "story_implementor"
    sessionId: "019ec9f6-24ea-72c3-bed0-3179062c9152"
    continuation:
      provider: "codex"
      sessionId: "019ec9f6-24ea-72c3-bed0-3179062c9152"
      storyId: "04-chunk-derivation-compact-recovery"
    outcome: "ready-for-verification"
    story:
      id: "04-chunk-derivation-compact-recovery"
      title: "Story 4: Chunk Derivation and Compact Recovery"
    planSummary: "Addressed SV-04-001 by making background chunk-summary input reads preserve chunk_member rows that reference missing canonical turn rows, surfacing them as source corruption before any provider summary call. The chunk summary handler now blocks both detailed and brief summaries on that corruption, while sanctioned SDK soft-deletes remain filtered so survivor-only chunk rebuilds still pass."
    changedFiles:
      -
        path: "packages/lhc/src/domains/turns/internal/forms.ts"
        reason: "Changed readMemberProjections to left-join canonical turns, report missing member turns as source corruption, and preserve sanctioned soft-delete filtering."
      -
        path: "packages/lhc/src/domains/turns/internal/derive.ts"
        reason: "Changed chunk_summary_detailed and chunk_summary_brief handlers to block immediately when member projection reads report canonical source corruption."
      -
        path: "packages/lhc/test/chunk-compact-recovery.test.ts"
        reason: "Updated TC-4.8b coverage to delete a member turn with foreign_keys disabled and assert both chunk summaries land blocked with source corruption."
    tests:
      added:
[]
      modified:
        - "packages/lhc/test/chunk-compact-recovery.test.ts"
      removed:
[]
      totalAfterStory: 401
      deltaFromPriorBaseline: 1
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/chunk-compact-recovery.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "fail"
      -
        command: "cd packages/lhc && pnpm exec vitest run test/chunk-compact-recovery.test.ts test/mutations-delete.test.ts"
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
        - "SV-04-001: missing canonical member turns no longer disappear from readMemberProjections and no longer allow ready fabricated chunk summaries."
        - "First story-gate rerun exposed a sanctioned soft-delete regression; fixed by treating missing turn rows as corruption while continuing to filter SDK soft-deleted survivor rebuilds."
      findingsSurfaced:
[]
    openQuestions:
[]
    specDeviations:
[]
    recommendedNextStep: "Run story verification review again."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/007-continue.json"
  startedAt: "2026-06-15T07:12:00.348Z"
  finishedAt: "2026-06-15T07:15:02.567Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/story-lead/001-current.json
Bytes: 2939

```yaml
storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
storyId: "04-chunk-derivation-compact-recovery"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome pass and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/003-implementor.json"
    provenance: "current-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/story-lead/001-final-package.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/006-verify.json"
    provenance: "current-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/007-continue.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/008-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "codex"
    sessionId: "019ec9f6-24ea-72c3-bed0-3179062c9152"
    storyId: "04-chunk-derivation-compact-recovery"
  storyVerifier:
    provider: "codex"
    sessionId: "019eca1a-5d0c-7ee1-87fe-f2ca34cd07ff"
    storyId: "04-chunk-derivation-compact-recovery"
latestEventSequence: 19
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "The implementor reports SV-04-001 fixed and all gates passing; acceptance requires a fresh verifier pass with no open findings."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/008-verify.json"
replayBoundary: null
updatedAt: "2026-06-15T07:16:52.800Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation, require verifier evidence for zero provider calls through the full smart compact path, thread-view boundary proof, fallback logging, stoppability, and background requeue reason member_projection_not_ready before recommending acceptance.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-15T06:26:52.084Z; note="After implementation, require verifier evidence for zero provider calls through the full smart compact path, thread-view boundary proof, fallback logging, stoppability, and background requeue reason member_projection_not_ready before recommending acceptance."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/story-lead/001-events.jsonl
Bytes: 10164

```yaml
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 1
  timestamp: "2026-06-15T06:26:41.567Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 2
  timestamp: "2026-06-15T06:26:52.061Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ec9f5-fba4-7761-8a43-5ed9e8eb09f1"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 3
  timestamp: "2026-06-15T06:26:52.083Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, require verifier evidence for zero provider calls through the full smart compact path, thread-view boundary proof, fallback logging, stoppability, and background requeue reason member_projection_not_ready before recommending acceptance."
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 4
  timestamp: "2026-06-15T06:26:52.084Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, require verifier evidence for zero provider calls through the full smart compact path, thread-view boundary proof, fallback logging, stoppability, and background requeue reason member_projection_not_ready before recommending acceptance."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 5
  timestamp: "2026-06-15T06:35:50.965Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 6
  timestamp: "2026-06-15T06:36:00.388Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ec9fe-5dcb-7ad3-9060-0f53112ba2d6"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 7
  timestamp: "2026-06-15T06:36:00.407Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 8
  timestamp: "2026-06-15T07:06:01.033Z"
  type: "child-process-stopped"
  summary: "Stopped stale story-verify provider process 10535 after interruption handling."
  data:
    storyId: "04-chunk-derivation-compact-recovery"
    storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
    command: "story-verify"
    artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/004-verify.json"
    statusArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/progress/004-verify.status.json"
    cleanedUpAt: "2026-06-15T07:06:01.033Z"
    provider: "codex"
    pid: 10535
    streamPaths:
      stdoutPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/streams/004-verify.stdout.log"
      stderrPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/streams/004-verify.stderr.log"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 9
  timestamp: "2026-06-15T07:06:01.045Z"
  type: "child-operation-failed"
  summary: "story-verify returned a failed runtime envelope before producing a recoverable child result."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-current-attempt"
      reasoning: "The attempt was interrupted and recorded a terminal recovery package, so the safest replay point is the current durable story-run snapshot."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/001-story-validate.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/003-implementor.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: false
    command: "story-verify"
    outcome: "block"
    status: "blocked"
    errors:
      -
        code: "PROVIDER_OUTPUT_INVALID"
        message: "Provider output was invalid for codex."
    artifactPaths:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/004-verify.json"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 10
  timestamp: "2026-06-15T07:06:12.751Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 11
  timestamp: "2026-06-15T07:06:25.750Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019eca1a-2a15-73a2-9738-bb2291697faf"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 12
  timestamp: "2026-06-15T07:06:25.768Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 1
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 13
  timestamp: "2026-06-15T07:11:49.476Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/006-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
    status: "ok"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 14
  timestamp: "2026-06-15T07:12:00.288Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/story-lead/prompts/001-planner-turn-004.md"
    sessionId: "019eca1f-4d79-7480-ae2b-01bae7a7f315"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 15
  timestamp: "2026-06-15T07:12:00.310Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-continue."
  data:
    actionType: "run-continue"
    turn: 2
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 16
  timestamp: "2026-06-15T07:15:02.575Z"
  type: "child-operation-completed"
  summary: "story-continue completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/007-continue.json"
  data:
    actionType: "run-continue"
    command: "story-continue"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 17
  timestamp: "2026-06-15T07:15:12.952Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/story-lead/prompts/001-planner-turn-005.md"
    sessionId: "019eca22-3fc3-7442-a08c-f7f18895658d"
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 18
  timestamp: "2026-06-15T07:15:12.976Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 3
-
  storyRunId: "04-chunk-derivation-compact-recovery-story-run-001"
  sequence: 19
  timestamp: "2026-06-15T07:16:52.800Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/04-chunk-derivation-compact-recovery/008-verify.json"
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
