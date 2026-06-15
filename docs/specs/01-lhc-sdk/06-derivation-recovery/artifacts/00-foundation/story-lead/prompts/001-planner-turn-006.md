# Story Lead Base Prompt

## Role Charter
You are the story lead for `00-foundation` on durable story run `00-foundation-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/stories/00-foundation.md
Bytes: 10020

# Story 0: Foundation

### Summary
<!-- Jira: Summary field -->

Rename derivation vocabulary and add the durable logging write/query surface.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** establish the shared derivation vocabulary and diagnostic channel before recovery flows write fallback events.

**Scope In:**
- Rename `form` / `derived_form` / `FormKind` / `DerivedFormState` to `derivation` / derivation type / state across code and schema.
- Add durable log storage with levels, actionable fields, write containment, and query by actionable fields.
- Expose one externally callable write method used by LHC internals and the host extension.

**Scope Out:**
- Runtime surfacing mechanics in pi-lhc.
- Treating fallback events as derivation state.

**Dependencies:** none.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-5.1:** The logging capability records entries at info, warning, and error levels to durable storage.

- **TC-5.1a:** Levels stored
  - Given: entries written at each level
  - When: storage is read
  - Then: all three are persisted with their level

**AC-5.2:** A single write method is exposed externally so both LHC internals and the host extension write through the same surface.

- **TC-5.2a:** Shared write surface
  - Given: a write from an LHC internal caller and a write from an external caller
  - When: both are issued
  - Then: both land through the same method into the same store

**AC-5.3:** A fallback *event* is recorded only in the log. The canonical subject (message/turn/chunk content) and any `ready` derivation output carry no degraded/fallback marker. This does not erase derivation state: a `failed` or `blocked` derivation keeps its state and reason on its own record (inspectable per Epic 04) — that is the derivation's state channel, distinct from the fallback-event log channel.

- **TC-5.3a:** Subject and ready output stay clean
  - Given: a derivation fell back during construction
  - When: the canonical subject and the produced rendering are read
  - Then: neither carries a degraded flag; the fallback *event* exists only in the log
- **TC-5.3b:** Failed state still on the derivation record
  - Given: a derivation terminally failed
  - When: its derivation record is read (not the subject)
  - Then: it shows `failed` with a reason, independent of any log entry

**AC-5.4:** Log entries are queryable by the fields that make them actionable (level, derivation type, subject id, reason).

- **TC-5.4a:** Query by fields
  - Given: a store with mixed entries
  - When: queried by level and derivation type
  - Then: only matching entries are returned

**AC-5.5:** A logging write never blocks or fails the operation that produced it; a logging failure is contained.

- **TC-5.5a:** Logging failure contained
  - Given: the logging store write fails
  - When: it happens during a turn construction
  - Then: the construction still completes and the logging failure does not propagate

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 0 establishes the shared vocabulary and logging surface that later recovery stories depend on. The rename is a v7 persisted-schema migration from form naming to derivation naming; the behavior gate is the existing suite staying green under the renamed vocabulary.

The logging capability is a domain-blind tech-util with public SDK exposure. LHC internals and the host both use `lhc.logging.write(...)`; operators and host code query through `lhc.logging.query(...)`. The log stores fallback events and diagnostics only. Derivation state and reason stay on derivation rows.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The rename touches schema, public types, work-queue vocabulary, and existing tests.
- The logging surface adds durable storage, public SDK export, write containment, and query behavior.

Risk Reminders:
- Migration/compatibility: v7 renames table/column and type names once.
- Persistence/restart: log entries must persist in the thread DB and be queryable after reopen.
- Cross-story contract change: Story 0 provides the log surface but does not own recovery fallback behavior.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Derivation vocabulary | `packages/lhc/src/shared/derivation.ts`, `packages/lhc/src/shared/storage.ts` |
| Logging tech-util | `packages/lhc/src/tech-utils/logging/index.ts` (NEW per tech design) |
| Public SDK export | `packages/lhc/src/sdk.ts` |
| Existing work-queue references | `packages/lhc/src/tech-utils/work-queue/index.ts` |
| Logging tests | `packages/lhc/test/logging-surface.test.ts` (planned) |
| Rename safety tests | Existing `packages/lhc/test/*.test.ts` suite |

#### Design References

- [tech-design.md §Context](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:10), lines 10-27
- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:61), lines 61-81
- [tech-design.md §DD-1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:87), lines 87-89
- [tech-design.md §DD-5](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:127), lines 127-129
- [tech-design.md §Log surface](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:189), lines 189-212
- [test-plan.md §Flow 5](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:100), lines 100-109
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:121), lines 121-135
- [test-plan.md §Per-Chunk Red/Green Exit Criteria](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:139), lines 139-148

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-5.1a | `packages/lhc/test/logging-surface.test.ts` | Writing info, warning, and error entries persists all three levels. |
| TC-5.2a | `packages/lhc/test/logging-surface.test.ts` | Internal caller and external SDK caller write through the same `lhc.logging.write` surface into the same store. |
| TC-5.3a | `packages/lhc/test/logging-surface.test.ts` | A fallback event is present only in the log; canonical subject and ready rendering have no degraded flag. |
| TC-5.3b | `packages/lhc/test/logging-surface.test.ts` | Terminal failed derivation still reads as `failed` with reason on the derivation row, independent of log entries. |
| TC-5.4a | `packages/lhc/test/logging-surface.test.ts` | Query by level and derivation type returns only matching log entries. |
| TC-5.5a | `packages/lhc/test/logging-surface.test.ts` | Logging write failure during turn construction is contained and does not fail construction. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Rename safety | `cd packages/lhc && pnpm run verify-all` | Existing suite passes under renamed vocabulary and v7 migration. | Logging TCs do not prove the mechanical rename preserved prior behavior. |
| Log never rolls back work | `packages/lhc/test/logging-surface.test.ts` | Inject logging-store failure and assert the producing operation still completes. | A simple write/read test would not prove failure containment. |
| Public surface registration | `packages/lhc/test/logging-surface.test.ts` | Import SDK and call `lhc.logging.write/query` instead of private helpers. | Private-module tests can pass while production SDK export is missing. |

#### Technical Notes

- `tech-utils/logging/` is domain-blind. It stores levels and fields; it never interprets derivation meaning and never reads or writes derivation rows.
- `writeLog` is fail-soft and must not share the caller's transaction.
- Rename work must preserve behavior. The rename **renames but retains** `tool_call_summary` in the kind set (so the existing suite stays green); its **removal is Story 2's** (AC-2.5). Do not drop `tool_call_summary` in this story.

#### Anti-Shim Requirements

- Do not satisfy logging through an in-memory array or process-local singleton.
- Do not expose only private `writeLog/queryLog` helpers; verify the public `lhc.logging.write/query` path.
- Do not add degraded/fallback markers to canonical subjects or ready derivation outputs.

#### Production Path Proof

- Entrypoint: `packages/lhc/src/sdk.ts` exporting `logging`.
- Registration/default path: package consumers import the SDK and call `lhc.logging.write(...)` / `lhc.logging.query(...)`.
- Evidence: `packages/lhc/test/logging-surface.test.ts` exercises SDK-level logging calls and `cd packages/lhc && pnpm run verify-all` passes after the rename.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/logging-surface.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Derivation vocabulary rename is complete across schema, types, work-queue kinds, and tests.
- AC-5.1 through AC-5.5 pass with their listed TCs.
- Logging write failure is contained.
- Log entries are queryable by actionable fields.
- No fallback marker is added to canonical subjects or `ready` derivation outputs.


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
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/009-verify.json
- older_response_count: 3
- caller_input_artifact_count: 0
- prior_self_note_count: 5
- latest_self_note: "If verifier returns pass with no open findings and story gate evidence remains present, recommend accept-story for impl-lead review."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/009-verify.json
bytes: 4823
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "045a428b-ecde-4cd2-8c43-ddf36b45a0eb"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ec99b-0038-7f80-b3ec-637abc75b0ae"
    continuation:
      provider: "codex"
      sessionId: "019ec99b-0038-7f80-b3ec-637abc75b0ae"
      storyId: "00-foundation"
    mode: "followup"
    story:
      id: "00-foundation"
      title: "Story 0: Foundation"
    artifactsRead:
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/stories/00-foundation.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/008-continue.json"
      - "packages/lhc/src/domains/turns/internal/derive.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/src/tech-utils/logging/index.ts"
      - "packages/lhc/src/shared/storage.ts"
      - "packages/lhc/src/shared/view.ts"
      - "packages/lhc/src/shared/inspect.ts"
      - "packages/lhc/src/domains/thread-view/index.ts"
      - "packages/lhc/src/domains/thread-view/internal/render.ts"
      - "packages/lhc/src/domains/thread-view/internal/select.ts"
      - "packages/lhc/test/logging-surface.test.ts"
      - "packages/lhc/test/derivation-turns.test.ts"
      - "packages/lhc/test/fixtures/index.ts"
    reviewScopeSummary: "Follow-up convergence review for prior blockers S0-F1, S0-F2, and S0-F3, plus directly touched logging, derivation, work-queue, storage, public view, inspect, and thread-view surfaces. Confirmed TC-5.1a through TC-5.5a coverage and reran the targeted logging test, story gate, and epic gate."
    priorFindingStatuses:
      -
        id: "S0-F1"
        status: "resolved"
        rationale: "Production fallback paths now write log events from derive.ts via logFallback and writeLog, while ready derivation completion clears persisted gaps in work-queue complete. The ready turn and chunk writes in derive.ts no longer attach gaps to successful derivation rows. TC-5.3a now exercises a real fallback derivation path and asserts the ready row has gaps null while the fallback event is queryable from log."
      -
        id: "S0-F2"
        status: "resolved"
        rationale: "writeLog no longer inserts through the caller db handle. It resolves the tracked database path, opens a separate database connection, inserts the log row fail-soft, and closes that connection. storage.ts tracks paths for openDatabase handles, fixtures route raw test handles through that opener, and logging-surface includes real-store rollback containment coverage."
      -
        id: "S0-F3"
        status: "resolved"
        rationale: "Current public/shared and thread-view shapes now expose derivationUsed, derivationCounts, and usedDerivation. thread_view JSON persistence writes the renamed keys, storage v7 migrates old persisted JSON keys, and rg found no live formUsed, formCounts, FormSnapshot, or FormLookup references outside migration compatibility strings."
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "AC-5.1 / TC-5.1a: logging-surface.test.ts persists info, warning, and error log entries."
        - "AC-5.2 / TC-5.2a: internal writeLog and sdk.logging.write both write to the same durable log table."
        - "AC-5.3 / TC-5.3a: production fallback derivation logs reason not_ready and leaves ready derivation rows without fallback markers."
        - "AC-5.3 / TC-5.3b: failed derivation state still records failure reason on the derivation row."
        - "AC-5.4 / TC-5.4a: log queries filter by level, derivationType, subjectId, and reason."
        - "AC-5.5 / TC-5.5a: log write failures are contained and do not abort caller work."
        - "DD-5 transaction rule: writeLog uses a separate database connection rather than the caller transaction."
        - "Story 0 derivation vocabulary DoD: current public/shared view, inspect, thread-view rendering, and persisted thread_view JSON use derivation vocabulary."
        - "Story gate passed: cd packages/lhc && pnpm run verify."
        - "Epic gate passed: cd packages/lhc && pnpm run verify-all."
      unverified:
[]
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/logging-surface.test.ts"
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
      - "verify and verify-all both reported 42 test files passed, 396 tests passed, and 9 real-inference tests skipped because LHC_OPENROUTER_KEY is unset; the configured gates exited successfully."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/009-verify.json"
  startedAt: "2026-06-15T04:59:27.153Z"
  finishedAt: "2026-06-15T05:01:34.891Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/006-implementor.json
bytes: 6198
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "b11e6d55-0925-442e-a2a0-7b19c41a7a0b"
    provider: "codex"
    model: "gpt-5.5"
    role: "story_implementor"
    sessionId: "019ec98f-cd11-75c2-b9ad-2025e18e2136"
    continuation:
      provider: "codex"
      sessionId: "019ec98f-cd11-75c2-b9ad-2025e18e2136"
      storyId: "00-foundation"
    outcome: "ready-for-verification"
    story:
      id: "00-foundation"
      title: "Story 0: Foundation"
    planSummary: "Implemented Story 0 foundation: completed the form-to-derivation vocabulary rename across runtime schema/types/surfaces/tests, added v7 migration and durable log storage, exposed SDK logging write/query, and added Flow 5 logging coverage."
    changedFiles:
      -
        path: "packages/lhc/src/shared/derivation.ts"
        reason: "Renamed shared vocabulary to derivation types/states/records and updated handler write contract."
      -
        path: "packages/lhc/src/shared/storage.ts"
        reason: "Added v7 derivation rename and durable log table migration with query indexes."
      -
        path: "packages/lhc/src/domains/threads/internal/create.ts"
        reason: "Registered v7 in thread-file migration history."
      -
        path: "packages/lhc/src/tech-utils/logging/index.ts"
        reason: "Added durable fail-soft logging write/query surface."
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "Exported logging namespace and SDK-bound logging write/query methods."
      -
        path: "packages/lhc/src/tech-utils/work-queue/index.ts"
        reason: "Updated queue derivation targets and completion/failure writes for derivation_type schema."
      -
        path: "packages/lhc/src/domains/messages/index.ts"
        reason: "Renamed message read/report/requeue surfaces to derivation vocabulary."
      -
        path: "packages/lhc/src/domains/messages/internal/forms.ts"
        reason: "Updated message derivation row reads/reports to v7 schema."
      -
        path: "packages/lhc/src/domains/messages/internal/handlers.ts"
        reason: "Updated handler outputs to derivation write contract."
      -
        path: "packages/lhc/src/domains/messages/internal/cascade.ts"
        reason: "Updated cascade cleared/dropped targets to derivationType vocabulary."
      -
        path: "packages/lhc/src/domains/messages/internal/outcome.ts"
        reason: "Updated derivation metadata terminology."
      -
        path: "packages/lhc/src/domains/turns/index.ts"
        reason: "Renamed turn/chunk read and requeue surfaces to derivations."
      -
        path: "packages/lhc/src/domains/turns/internal/compose.ts"
        reason: "Renamed dependency gaps to derivationType."
      -
        path: "packages/lhc/src/domains/turns/internal/derive.ts"
        reason: "Updated turn/chunk handler outputs to derivation write contract."
      -
        path: "packages/lhc/src/domains/turns/internal/forms.ts"
        reason: "Updated turn/chunk derivation row reads/reports to v7 schema."
      -
        path: "packages/lhc/src/domains/turns/internal/chunks.ts"
        reason: "Updated chunk summary enqueue targets to derivationType."
      -
        path: "packages/lhc/src/domains/thread-view/index.ts"
        reason: "Updated thread-view report/sweep/materialize vocabulary to derivation naming."
      -
        path: "packages/lhc/src/domains/thread-view/internal/select.ts"
        reason: "Updated thread-view derivation row reads and counts to v7 schema."
      -
        path: "packages/lhc/src/domains/thread-view/internal/snapshot.ts"
        reason: "Updated ready summary lookup to derivation_type schema."
      -
        path: "packages/lhc/src/domains/thread-view/internal/sweep.ts"
        reason: "Updated sweep requeue routing to derivationType."
      -
        path: "packages/lhc/src/domains/thread-view/internal/render.ts"
        reason: "Updated derivation terminology in render lookup types/comments."
      -
        path: "packages/lhc/src/domains/inspect/internal/health.ts"
        reason: "Updated health failure/preview fields to derivationType."
      -
        path: "packages/lhc/src/domains/inspect/internal/overview.ts"
        reason: "Updated inspect counts to derivation naming."
      -
        path: "packages/lhc/src/shared/report.ts"
        reason: "Updated report row mapper for derivation_type schema."
      -
        path: "packages/lhc/src/shared/inspect.ts"
        reason: "Updated inspect report fields to derivationType."
      -
        path: "packages/lhc/src/inference/adapter.ts"
        reason: "Renamed inference assignment vocabulary to derivation types."
      -
        path: "packages/lhc/src/inference/prompts/index.ts"
        reason: "Renamed prompt registry vocabulary to derivation types."
      -
        path: "packages/lhc/src/inference/types.ts"
        reason: "Renamed model assignment map vocabulary to derivation types."
      -
        path: "packages/lhc/src/scheduler.ts"
        reason: "Updated scheduler completion path to consume derivation writes."
      -
        path: "packages/lhc/test/logging-surface.test.ts"
        reason: "Added TC-5.1a through TC-5.5a logging surface tests."
      -
        path: "packages/lhc/test/**/*.ts"
        reason: "Updated existing tests and fixtures for derivation vocabulary, v7 schema, and logging export expectations."
    tests:
      added:
        - "packages/lhc/test/logging-surface.test.ts"
      modified:
        - "packages/lhc/test/**/*.ts"
      removed:
[]
      totalAfterStory: 404
      deltaFromPriorBaseline: 6
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/logging-surface.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm exec vitest run test/derivation-messages.test.ts test/derivation-turns.test.ts"
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
        - "Restored v5 as the old derived_form schema so v7 performs the intended rename migration."
        - "Added v7 to thread creation/open migration history."
        - "Fixed missed runtime surfaces still returning forms/form keys after the type rename."
        - "Added reason filtering to log queries to satisfy actionable-field querying."
        - "Updated public export snapshot and migration-version assertions to v7."
      findingsSurfaced:
[]
    openQuestions:
[]
    specDeviations:
[]
    recommendedNextStep: "Verifier can review Story 0 with both story and epic gates green."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/006-implementor.json"
  startedAt: "2026-06-15T04:35:04.965Z"
  finishedAt: "2026-06-15T04:47:09.633Z"
```
</history_entry>

<history_entry>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/007-verify.json
bytes: 11698
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "68a7de8d-5b7d-41e0-bddb-17183021e476"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ec99b-0038-7f80-b3ec-637abc75b0ae"
    continuation:
      provider: "codex"
      sessionId: "019ec99b-0038-7f80-b3ec-637abc75b0ae"
      storyId: "00-foundation"
    mode: "initial"
    story:
      id: "00-foundation"
      title: "Story 0: Foundation"
    artifactsRead:
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/stories/00-foundation.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md"
      - "docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/006-implementor.json"
      - "packages/lhc/src/shared/derivation.ts"
      - "packages/lhc/src/shared/storage.ts"
      - "packages/lhc/src/shared/context.ts"
      - "packages/lhc/src/domains/threads/internal/create.ts"
      - "packages/lhc/src/tech-utils/logging/index.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/test/logging-surface.test.ts"
      - "packages/lhc/src/domains/turns/internal/derive.ts"
      - "packages/lhc/src/domains/turns/internal/compose.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/src/shared/view.ts"
      - "packages/lhc/src/shared/inspect.ts"
      - "packages/lhc/src/domains/thread-view/index.ts"
      - "packages/lhc/src/domains/thread-view/internal/render.ts"
      - "packages/lhc/src/domains/thread-view/internal/select.ts"
      - "packages/lhc/test/thread-migration.test.ts"
      - "packages/lhc/test/fixtures/threads.ts"
    reviewScopeSummary: "Initial verification of Story 0 against AC-5.1 through AC-5.5, the derivation vocabulary rename DoD, v7 migration, public SDK logging surface, logging tests, and production fallback/logging paths."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "S0-F1"
        severity: "major"
        title: "Ready derivation rows still persist fallback markers instead of logging fallback events only"
        evidence: "AC-5.3 requires a fallback event to exist only in the log and says ready derivation output must carry no degraded/fallback marker (00-foundation.md:43-48). Production turn derivation still collects fallback gaps and attaches them to ready turn_rendering writes (packages/lhc/src/domains/turns/internal/derive.ts:83,95,106-115). Chunk summaries do the same (packages/lhc/src/domains/turns/internal/derive.ts:164-175,192-200). The queue completion path persists those gaps on ready derivation rows (packages/lhc/src/tech-utils/work-queue/index.ts:304-312). `rg writeLog` found no production fallback call sites outside the SDK wrapper and logging tests, and TC-5.3a only manually inserts a clean derivation row before writing a log (packages/lhc/test/logging-surface.test.ts:93-143)."
        affectedFiles:
          - "packages/lhc/src/domains/turns/internal/derive.ts"
          - "packages/lhc/src/tech-utils/work-queue/index.ts"
          - "packages/lhc/test/logging-surface.test.ts"
          - "packages/lhc/test/derivation-turns.test.ts"
        requirementIds:
          - "AC-5.3"
          - "TC-5.3a"
          - "DD-5"
          - "Story 0 DoD: no fallback marker on ready derivation outputs"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
      -
        id: "S0-F2"
        severity: "major"
        title: "writeLog participates in the caller transaction"
        evidence: "The story technical notes require `writeLog` to be fail-soft and not share the caller transaction (00-foundation.md:133-134), and DD-5 says it must not share the caller's transaction (tech-design.md:127-129). The implementation inserts through `ctx.db` directly (packages/lhc/src/tech-utils/logging/index.ts:43-59). A focused rollback probe wrote a log inside `BEGIN IMMEDIATE`, rolled back the caller transaction, and observed `{\"n\":0}` log rows; an independent log transaction would have left one row. TC-5.5a only injects a fake throwing prepare function, so it does not prove real-store transaction isolation (packages/lhc/test/logging-surface.test.ts:220-235)."
        affectedFiles:
          - "packages/lhc/src/tech-utils/logging/index.ts"
          - "packages/lhc/test/logging-surface.test.ts"
        requirementIds:
          - "AC-5.5"
          - "TC-5.5a"
          - "DD-5"
        recommendedFixScope: "quick-fix"
        blocking: true
      -
        id: "S0-F3"
        severity: "major"
        title: "Derivation vocabulary rename is not complete across current production/public shapes"
        evidence: "Story 0 scope and DoD require the form vocabulary to be renamed across code and schema (00-foundation.md:15-18,162), and DD-1 says every reference changes from form to derivation vocabulary (tech-design.md:87-89). Current shared/public view and inspect shapes still expose `formUsed` and `formCounts` (packages/lhc/src/shared/view.ts:116-125,152; packages/lhc/src/shared/inspect.ts:57,74). The compact production path persists those names into thread_view JSON (packages/lhc/src/domains/thread-view/index.ts:458-479,508-514), and thread-view internals still define `FormSnapshot`/`FormLookup` for derivation state rows (packages/lhc/src/domains/thread-view/internal/render.ts:131-145)."
        affectedFiles:
          - "packages/lhc/src/shared/view.ts"
          - "packages/lhc/src/shared/inspect.ts"
          - "packages/lhc/src/domains/thread-view/index.ts"
          - "packages/lhc/src/domains/thread-view/internal/render.ts"
          - "packages/lhc/src/domains/thread-view/internal/select.ts"
        requirementIds:
          - "Story 0 Scope In: derivation vocabulary rename"
          - "DD-1"
          - "Story 0 DoD: rename complete across schema, types, work-queue kinds, and tests"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
    openFindings:
      -
        id: "S0-F1"
        severity: "major"
        title: "Ready derivation rows still persist fallback markers instead of logging fallback events only"
        evidence: "AC-5.3 requires a fallback event to exist only in the log and says ready derivation output must carry no degraded/fallback marker (00-foundation.md:43-48). Production turn derivation still collects fallback gaps and attaches them to ready turn_rendering writes (packages/lhc/src/domains/turns/internal/derive.ts:83,95,106-115). Chunk summaries do the same (packages/lhc/src/domains/turns/internal/derive.ts:164-175,192-200). The queue completion path persists those gaps on ready derivation rows (packages/lhc/src/tech-utils/work-queue/index.ts:304-312). `rg writeLog` found no production fallback call sites outside the SDK wrapper and logging tests, and TC-5.3a only manually inserts a clean derivation row before writing a log (packages/lhc/test/logging-surface.test.ts:93-143)."
        affectedFiles:
          - "packages/lhc/src/domains/turns/internal/derive.ts"
          - "packages/lhc/src/tech-utils/work-queue/index.ts"
          - "packages/lhc/test/logging-surface.test.ts"
          - "packages/lhc/test/derivation-turns.test.ts"
        requirementIds:
          - "AC-5.3"
          - "TC-5.3a"
          - "DD-5"
          - "Story 0 DoD: no fallback marker on ready derivation outputs"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
      -
        id: "S0-F2"
        severity: "major"
        title: "writeLog participates in the caller transaction"
        evidence: "The story technical notes require `writeLog` to be fail-soft and not share the caller transaction (00-foundation.md:133-134), and DD-5 says it must not share the caller's transaction (tech-design.md:127-129). The implementation inserts through `ctx.db` directly (packages/lhc/src/tech-utils/logging/index.ts:43-59). A focused rollback probe wrote a log inside `BEGIN IMMEDIATE`, rolled back the caller transaction, and observed `{\"n\":0}` log rows; an independent log transaction would have left one row. TC-5.5a only injects a fake throwing prepare function, so it does not prove real-store transaction isolation (packages/lhc/test/logging-surface.test.ts:220-235)."
        affectedFiles:
          - "packages/lhc/src/tech-utils/logging/index.ts"
          - "packages/lhc/test/logging-surface.test.ts"
        requirementIds:
          - "AC-5.5"
          - "TC-5.5a"
          - "DD-5"
        recommendedFixScope: "quick-fix"
        blocking: true
      -
        id: "S0-F3"
        severity: "major"
        title: "Derivation vocabulary rename is not complete across current production/public shapes"
        evidence: "Story 0 scope and DoD require the form vocabulary to be renamed across code and schema (00-foundation.md:15-18,162), and DD-1 says every reference changes from form to derivation vocabulary (tech-design.md:87-89). Current shared/public view and inspect shapes still expose `formUsed` and `formCounts` (packages/lhc/src/shared/view.ts:116-125,152; packages/lhc/src/shared/inspect.ts:57,74). The compact production path persists those names into thread_view JSON (packages/lhc/src/domains/thread-view/index.ts:458-479,508-514), and thread-view internals still define `FormSnapshot`/`FormLookup` for derivation state rows (packages/lhc/src/domains/thread-view/internal/render.ts:131-145)."
        affectedFiles:
          - "packages/lhc/src/shared/view.ts"
          - "packages/lhc/src/shared/inspect.ts"
          - "packages/lhc/src/domains/thread-view/index.ts"
          - "packages/lhc/src/domains/thread-view/internal/render.ts"
          - "packages/lhc/src/domains/thread-view/internal/select.ts"
        requirementIds:
          - "Story 0 Scope In: derivation vocabulary rename"
          - "DD-1"
          - "Story 0 DoD: rename complete across schema, types, work-queue kinds, and tests"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
    requirementCoverage:
      verified:
        - "AC-5.1 / TC-5.1a: info, warning, and error log levels are persisted by the SDK logging path and covered by logging-surface.test.ts."
        - "AC-5.2 / TC-5.2a: internal writeLog and SDK instance logging.write write to the same durable log table in logging-surface.test.ts."
        - "AC-5.3 / TC-5.3b: failed derivation state and reason remain on the derivation row independent of log entries in logging-surface.test.ts."
        - "AC-5.4 / TC-5.4a: queryLog supports level, derivationType, subjectId, and reason filters; logging-surface.test.ts covers mixed-field filtering."
        - "V7 schema migration is registered and story/epic gates pass under user_version 7."
      unverified:
        - "AC-5.3 / TC-5.3a production path: actual fallback during derivation construction still writes gaps to ready derivation rows and has no production log call site."
        - "AC-5.5 / TC-5.5a transaction containment: writeLog catches write failures, but a real log write shares and rolls back with the caller transaction."
        - "Story 0 derivation vocabulary rename DoD: public/shared thread-view shapes and persisted JSON still use formUsed/formCounts/FormSnapshot vocabulary."
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/logging-surface.test.ts"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm exec tsx -e '<writeLog inside BEGIN IMMEDIATE, then ROLLBACK; assert log count === 1>'"
        result: "fail"
    productionPathFindings:
      - "Ready derivation completion still persists fallback `gaps` on derivation rows, so fallback markers remain in the derivation state/output channel instead of only the log."
      - "writeLog uses the caller's DatabaseSync handle and participates in the caller transaction; rollback proof observed zero persisted log rows after caller rollback."
      - "Thread-view compact still persists form vocabulary in arrangement/source-state JSON (`formUsed`, `formCounts`) and exposes it through shared view/inspect surfaces."
    recommendedNextStep: "revise"
    recommendedFixScope: "fresh-fix-path"
    openQuestions:
[]
    additionalObservations:
      - "The configured story and epic gates passed, but they do not cover the rollback isolation proof or production fallback-channel behavior."
      - "`verify` and `verify-all` reported 9 skipped real-inference tests because LHC_OPENROUTER_KEY was unset; I did not use those skipped tests as Story 0 evidence."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/007-verify.json"
  startedAt: "2026-06-15T04:47:18.964Z"
  finishedAt: "2026-06-15T04:51:50.742Z"
```
</history_entry>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/008-continue.json
bytes: 5342
payload:
  command: "story-continue"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "cdb61881-5844-4161-957a-7bdef0e07ac0"
    provider: "codex"
    model: "gpt-5.5"
    role: "story_implementor"
    sessionId: "019ec98f-cd11-75c2-b9ad-2025e18e2136"
    continuation:
      provider: "codex"
      sessionId: "019ec98f-cd11-75c2-b9ad-2025e18e2136"
      storyId: "00-foundation"
    outcome: "ready-for-verification"
    story:
      id: "00-foundation"
      title: "Story 0: Foundation"
    planSummary: "Implemented the verifier follow-up for Story 0: ready derivation rows no longer persist fallback gap markers; production fallback paths write durable log entries; writeLog now uses a separate fail-soft store connection; real-store rollback containment coverage was added; public/shared thread-view and inspect shapes now use derivation vocabulary including persisted thread_view JSON."
    changedFiles:
      -
        path: "packages/lhc/src/shared/storage.ts"
        reason: "Tracked database file paths for isolated log writes, added v7 persisted thread_view JSON key migration, and retained derivation/log schema setup."
      -
        path: "packages/lhc/src/tech-utils/logging/index.ts"
        reason: "Made writeLog fail-soft through a separate database connection instead of the caller transaction."
      -
        path: "packages/lhc/src/tech-utils/work-queue/index.ts"
        reason: "Stopped persisting gaps on ready derivation completion rows while preserving failed derivation state and reason paths."
      -
        path: "packages/lhc/src/domains/turns/internal/derive.ts"
        reason: "Moved fallback recording from ready derivation gaps to durable log events in production turn and chunk derivation paths."
      -
        path: "packages/lhc/src/domains/thread-view/index.ts"
        reason: "Persisted derivationUsed and derivationCounts in thread_view JSON and renamed degraded receipt vocabulary."
      -
        path: "packages/lhc/src/domains/thread-view/internal/render.ts"
        reason: "Renamed FormSnapshot/FormLookup/formUsed vocabulary to derivation vocabulary."
      -
        path: "packages/lhc/src/domains/thread-view/internal/select.ts"
        reason: "Renamed selection inputs, arrangement entries, and source-state counts to derivation vocabulary."
      -
        path: "packages/lhc/src/domains/inspect/internal/view-report.ts"
        reason: "Returned derivationUsed from inspect view reports."
      -
        path: "packages/lhc/src/shared/view.ts"
        reason: "Updated public StoredView and CompactReceipt shapes to derivation vocabulary."
      -
        path: "packages/lhc/src/shared/inspect.ts"
        reason: "Updated public inspect report shapes to derivation vocabulary."
      -
        path: "packages/lhc/test/logging-surface.test.ts"
        reason: "Added production fallback logging coverage and real-store rollback containment coverage."
      -
        path: "packages/lhc/test/derivation-turns.test.ts"
        reason: "Updated fallback assertions to expect clean ready rows and durable log entries."
      -
        path: "packages/lhc/test/report-repair.test.ts"
        reason: "Updated repair assertions for fallback-composed rows without persisted gaps."
      -
        path: "packages/lhc/test/fixtures/index.ts"
        reason: "Routed raw test database handles through the normal opener so isolated logging can resolve the file path."
      -
        path: "packages/lhc/test/fixtures/threads.ts"
        reason: "Updated shared fallback-rendering fixture invariants for clean ready derivation rows."
      -
        path: "packages/lhc/test/goldens/*.json"
        reason: "Updated stored arrangement golden keys from formUsed to derivationUsed."
      -
        path: "packages/lhc/src/domains/messages/*"
        reason: "Completed Story 0 derivation vocabulary rename across message derivation surfaces."
      -
        path: "packages/lhc/src/domains/turns/*"
        reason: "Completed Story 0 derivation vocabulary rename across turn derivation surfaces."
      -
        path: "packages/lhc/test/**/*.ts"
        reason: "Updated affected tests and fixtures for derivation vocabulary and clean fallback-row behavior."
    tests:
      added:
        - "packages/lhc/test/logging-surface.test.ts"
      modified:
        - "packages/lhc/test/logging-surface.test.ts"
        - "packages/lhc/test/derivation-turns.test.ts"
        - "packages/lhc/test/report-repair.test.ts"
        - "packages/lhc/test/fixtures/index.ts"
        - "packages/lhc/test/fixtures/threads.ts"
        - "packages/lhc/test/goldens/*.json"
      removed:
[]
      totalAfterStory: 405
      deltaFromPriorBaseline: 7
    gatesRun:
      -
        command: "cd packages/lhc && pnpm exec vitest run test/logging-surface.test.ts"
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
        - "S0-F1: ready derivation rows no longer persist fallback/gap markers; production fallback paths record fallback events in the durable log."
        - "S0-F2: writeLog is fail-soft and uses a separate database connection; real-store rollback containment coverage was added."
        - "S0-F3: public/shared thread-view and inspect shapes plus persisted thread_view JSON now use derivation vocabulary."
      findingsSurfaced:
[]
    openQuestions:
[]
    specDeviations:
[]
    recommendedNextStep: "Run verifier artifact generation for Story 0 against the updated implementation."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/008-continue.json"
  startedAt: "2026-06-15T04:52:11.210Z"
  finishedAt: "2026-06-15T04:59:15.149Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/story-lead/001-current.json
Bytes: 2738

```yaml
storyRunId: "00-foundation-story-run-001"
storyId: "00-foundation"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome pass and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/story-lead/001-final-package.json"
    provenance: "current-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/006-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/007-verify.json"
    provenance: "current-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/008-continue.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/009-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "codex"
    sessionId: "019ec98f-cd11-75c2-b9ad-2025e18e2136"
    storyId: "00-foundation"
  storyVerifier:
    provider: "codex"
    sessionId: "019ec99b-0038-7f80-b3ec-637abc75b0ae"
    storyId: "00-foundation"
latestEventSequence: 23
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Latest implementor result is ready-for-verification after addressing S0-F1, S0-F2, and S0-F3. Acceptance requires a fresh verifier pass before story-lead can recommend acceptance."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/009-verify.json"
replayBoundary: null
updatedAt: "2026-06-15T05:01:34.898Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: If verifier returns pass with no open findings and story gate evidence remains present, recommend accept-story for impl-lead review.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-15T04:19:00.342Z; note="After implementation, verify evidence covers TC-5.1a through TC-5.5a plus the story gate before considering acceptance."
- sequence=10; actionSequence=9; createdAt=2026-06-15T04:35:04.929Z; note="After implementation returns, require evidence for TC-5.1a through TC-5.5a plus the story gate before considering acceptance."
- sequence=14; actionSequence=13; createdAt=2026-06-15T04:47:18.930Z; note="If verifier returns pass with no open findings and story gate evidence remains present, recommend accept-story for impl-lead review."
- sequence=18; actionSequence=17; createdAt=2026-06-15T04:52:11.165Z; note="After revised implementation returns, verify specifically that S0-F1, S0-F2, and S0-F3 are fixed and that targeted logging, story gate, and epic gate evidence is present."
- sequence=22; actionSequence=21; createdAt=2026-06-15T04:59:27.119Z; note="If verifier returns pass with no open findings and story gate evidence remains present, recommend accept-story for impl-lead review."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/story-lead/001-events.jsonl
Bytes: 11257

```yaml
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 1
  timestamp: "2026-06-15T04:18:49.649Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 2
  timestamp: "2026-06-15T04:19:00.320Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ec980-eb63-7fc1-9b20-8d1160a99a4e"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 3
  timestamp: "2026-06-15T04:19:00.342Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, verify evidence covers TC-5.1a through TC-5.5a plus the story gate before considering acceptance."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 4
  timestamp: "2026-06-15T04:19:00.342Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, verify evidence covers TC-5.1a through TC-5.5a plus the story gate before considering acceptance."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 5
  timestamp: "2026-06-15T04:34:02.225Z"
  type: "child-process-stopped"
  summary: "Stopped stale story-implement provider process 18748 after interruption handling."
  data:
    storyId: "00-foundation"
    storyRunId: "00-foundation-story-run-001"
    command: "story-implement"
    artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/003-implementor.json"
    statusArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/progress/003-implementor.status.json"
    cleanedUpAt: "2026-06-15T04:34:02.225Z"
    provider: "claude-code"
    pid: 18748
    streamPaths:
      stdoutPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/streams/003-implementor.stdout.log"
      stderrPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/streams/003-implementor.stderr.log"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 6
  timestamp: "2026-06-15T04:34:02.237Z"
  type: "child-operation-failed"
  summary: "story-implement returned a failed runtime envelope before producing a recoverable child result."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-current-attempt"
      reasoning: "The attempt was interrupted and recorded a terminal recovery package, so the safest replay point is the current durable story-run snapshot."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/001-story-validate.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: false
    command: "story-implement"
    outcome: "blocked"
    status: "blocked"
    errors:
      -
        code: "PROVIDER_UNAVAILABLE"
        message: "Provider execution failed for claude-code."
    artifactPaths:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/003-implementor.json"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 7
  timestamp: "2026-06-15T04:34:50.921Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 8
  timestamp: "2026-06-15T04:35:04.908Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ec98f-9636-70c0-a881-caaedc44420d"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 9
  timestamp: "2026-06-15T04:35:04.929Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, require evidence for TC-5.1a through TC-5.5a plus the story gate before considering acceptance."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 10
  timestamp: "2026-06-15T04:35:04.929Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, require evidence for TC-5.1a through TC-5.5a plus the story gate before considering acceptance."
    actionSequence: 9
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 11
  timestamp: "2026-06-15T04:47:09.643Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/006-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 12
  timestamp: "2026-06-15T04:47:18.905Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019ec99a-dbe5-71e1-987c-02a744a64f4b"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 13
  timestamp: "2026-06-15T04:47:18.930Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
    selfNote: "If verifier returns pass with no open findings and story gate evidence remains present, recommend accept-story for impl-lead review."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 14
  timestamp: "2026-06-15T04:47:18.930Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "If verifier returns pass with no open findings and story gate evidence remains present, recommend accept-story for impl-lead review."
    actionSequence: 13
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 15
  timestamp: "2026-06-15T04:51:50.753Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/007-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
    status: "ok"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 16
  timestamp: "2026-06-15T04:52:11.128Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/story-lead/prompts/001-planner-turn-004.md"
    sessionId: "019ec99f-2615-7930-a9de-65696da20a6a"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 17
  timestamp: "2026-06-15T04:52:11.163Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-continue."
  data:
    actionType: "run-continue"
    turn: 3
    selfNote: "After revised implementation returns, verify specifically that S0-F1, S0-F2, and S0-F3 are fixed and that targeted logging, story gate, and epic gate evidence is present."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 18
  timestamp: "2026-06-15T04:52:11.165Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After revised implementation returns, verify specifically that S0-F1, S0-F2, and S0-F3 are fixed and that targeted logging, story gate, and epic gate evidence is present."
    actionSequence: 17
    actionType: "run-continue"
    turn: 3
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 19
  timestamp: "2026-06-15T04:59:15.158Z"
  type: "child-operation-completed"
  summary: "story-continue completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/008-continue.json"
  data:
    actionType: "run-continue"
    command: "story-continue"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 20
  timestamp: "2026-06-15T04:59:27.093Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/story-lead/prompts/001-planner-turn-005.md"
    sessionId: "019ec9a5-edec-7f60-bd57-ad131314ac57"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 21
  timestamp: "2026-06-15T04:59:27.118Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 4
    selfNote: "If verifier returns pass with no open findings and story gate evidence remains present, recommend accept-story for impl-lead review."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 22
  timestamp: "2026-06-15T04:59:27.119Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "If verifier returns pass with no open findings and story gate evidence remains present, recommend accept-story for impl-lead review."
    actionSequence: 21
    actionType: "run-verify"
    turn: 4
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 23
  timestamp: "2026-06-15T05:01:34.898Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/00-foundation/009-verify.json"
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
