# Story Lead Base Prompt

## Role Charter
You are the story lead for `04-lifecycle-exercise` on durable story run `04-lifecycle-exercise-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 3.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/stories/04-lifecycle-exercise.md
Bytes: 8780

# Story 4: Lifecycle Exercise

### Summary
<!-- Jira: Summary field -->
Add the full-surface lifecycle exercise in PI-extension call order across SDK, replay, teardown, and CLI parity legs.

### Description
<!-- Jira: Description field -->
**User Profile:** The future PI extension calls the SDK surfaces in the sequence this exercise rehearses; the operator uses CLI reads at checkpoints.

**Objective:** Exercise every built v1 surface through one deterministic sequence and verify contract coherence across epics.

**Scope In:** Scripted sequence: create thread → intake multi-turn tool-heavy batches → background drain settles → status → compact (profile) → pull → inspect (overview, view, health) → edit + delete → rebuild drains → health confirms → second compact → pull → materialize.

**Scope Out:** This story does not prove real-inference readiness. No real network or real-provider call is allowed. Quality review of deterministic-provider output remains outside this epic.

**Dependencies:** Stories 1-3 complete; Epic 03 complete.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->
- **AC-5.1**: The full sequence completes through one real SDK configuration with the deterministic provider: every operation returns ok, zero network, zero real-provider calls.

- **AC-5.2**: Checkpoint coherence: post-compact pull serves bands + tail; post-mutation health shows the cleared set pending; post-drain health shows it ready; the second compact's view reflects post-edit content; the second compact receipt's sweep section agrees with the health report taken immediately before it.

- **TC-5.1** (AC-5.1, AC-5.2): Scripted lifecycle with checkpoint assertions at each named step; receipt-vs-health cross-check exact.

- **AC-5.3**: End-to-end determinism: the whole sequence replayed on a fresh thread produces byte-identical pull outputs and materialized files.

- **TC-5.2** (AC-5.3): Replay on a fresh thread → hash equality on every pull output and the materialized file.

- **AC-5.4**: No in-memory dependency: tearing down the SDK instance between phases and continuing on a fresh `createSdk` yields the same end state as the uninterrupted run.

- **TC-5.3** (AC-5.4): Teardown and recreate the SDK between intake/compact/mutation phases → final pull, health, and materialized file identical to TC-5.1's.

- **AC-5.5**: Operator parity: inspect and view reads driven through the spawned CLI at checkpoints return the same JSON as the in-process SDK calls at those checkpoints.

- **TC-5.4** (AC-5.5): Process-suite leg: spawned CLI inspect/view/messages reads at three checkpoints equal the in-process results.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->
#### Architecture Context

This story adds the shared lifecycle fixture and the full-surface verification legs. It introduces no production surface; it proves the built SDK and CLI surfaces work in PI-extension call order with deterministic provider setup only.

The lifecycle script names phases and returns results to tests. Assertions stay in tests so replay, teardown, and process legs drive the same sequence without re-describing it.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The story coordinates all prior surfaces, persistence reopen behavior, deterministic replay, materialization, and spawned CLI checkpoints.

Risk Reminders:
- This is a seam proof, not a real-inference gate.
- Teardown must create a fresh SDK between phase groups.
- Process suite must report `ran`; missing auth or process prerequisites must not silently skip.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Lifecycle helper | `test/fixtures/lifecycle.ts` |
| Default lifecycle tests | `test/lifecycle.test.ts` |
| Process checkpoint tests | `test/cli-process-inspect.test.ts` |
| Consumed SDK/CLI surfaces | `src/sdk.ts`, `src/cli/inspect.ts`, `src/cli/messages-read.ts` |

#### Design References

- [tech-design.md §Context](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:6), lines 6-10
- [tech-design.md §Flow 5: Lifecycle Exercise](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:147), lines 147-149
- [tech-design.md §Testing Strategy](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:215), lines 215-217
- [tech-design.md §Work Breakdown](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:219), lines 219-230
- [test-plan.md §Test Files](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:6), lines 6-18
- [test-plan.md §TC → Test Mapping](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:20), lines 20-40
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:42), lines 42-50
- [test-plan.md §Suite Accounting](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:52), lines 52-54
- [test-plan.md §Verification](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:66), lines 66-68

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-5.1 | `test/lifecycle.test.ts :: full sequence + checkpoints` | Every phase returns ok; pull/health/compact/materialize checkpoints agree field-for-field where required. |
| TC-5.2 | `test/lifecycle.test.ts :: replay determinism` | Fresh-thread replay produces hash-equal pull outputs and materialized file. |
| TC-5.3 | `test/lifecycle.test.ts :: teardown continuity` | Fresh SDK between phase groups yields final pull, health, and materialized file equal to uninterrupted run. |
| TC-5.4 | `test/cli-process-inspect.test.ts :: checkpoint parity` | Spawned CLI overview/view/list reads at checkpoints deep-equal in-process SDK results. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Cross-epic lifecycle order drift | `test/lifecycle.test.ts` named-phase checkpoints | Run create, intake, drain, status, compact, pull, inspect, mutate, rebuild, compact, pull, materialize in order. | Individual story tests cannot catch ordering mismatches between surfaces. |
| Persistence relies on memory | `test/lifecycle.test.ts` fresh-SDK hook | Recreate SDK between phase groups and compare final outputs. | In-process success can hide state stored only in runtime memory. |
| CLI production path drift | `test/cli-process-inspect.test.ts` process checkpoint leg | Spawn real commands and compare JSON to SDK checkpoints. | SDK tests do not prove command registration, stdout, or argv mapping. |

#### Technical Notes

- `test/fixtures/lifecycle.ts` owns the sequence and phase names; tests own assertions.
- The receipt-vs-health check compares the second compact receipt sweep section with the health snapshot taken immediately before compact.
- Quality review of deterministic-provider text remains outside this epic.

#### Anti-Shim Requirements

- Use the real SDK configuration with deterministic provider and zero network/real-provider calls.
- Use real fresh SDK construction for teardown continuity.
- Use spawned CLI commands for checkpoint parity; do not call CLI handlers directly.

#### Production Path Proof

- Entrypoint: SDK surfaces from Epics 01-04 and spawned `lhc` commands.
- Registration/default path: the helper drives public SDK operations; process leg drives registered CLI commands.
- Evidence: lifecycle default tests, teardown continuity, replay determinism, and process checkpoint parity.

#### Verification

- Targeted: `pnpm verify`
- Story gate: `pnpm verify`
- Epic/process gate: `LHC_PROCESS_SUITE=1 pnpm verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->
- The scripted lifecycle runs through one SDK configuration with deterministic provider only.
- Checkpoint assertions cover pull, health, compact receipt, rebuild, and materialized output.
- Replay on a fresh thread produces byte-identical pull outputs and materialized files.
- SDK teardown between phases produces the same final state as uninterrupted execution.
- Spawned CLI checkpoint reads match in-process SDK JSON.
- TC-5.1 through TC-5.4 pass with one primary owner in this story.


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md
Bytes: 7662

# Epic 04: Inspection — Test Plan

**Epic:** `epic.md` (23 ACs / 17 TCs) · **Tech design:** `tech-design.md`
Inherits Epic 01–03 test architecture: real temp SQLite per test, deterministic provider for fixture prep only, default suite (`pnpm verify`) + process suite (`LHC_PROCESS_SUITE=1 pnpm verify-all`), suite-accounting row, red manifest discipline.

## Test Files

| File | Suite | Covers |
|------|-------|--------|
| `test/messages-read.test.ts` | default | TC-3.1–3.3 + list/show read-only legs |
| `test/inspect-overview.test.ts` | default | TC-1.1–1.3 |
| `test/inspect-view.test.ts` | default | TC-2.1–2.3 + describe legs |
| `test/inspect-health.test.ts` | default | TC-4.1–4.3 |
| `test/lifecycle.test.ts` | default | TC-5.1–5.3 |
| `test/cli-process-inspect.test.ts` | process | TC-3.4, TC-5.4 |
| `test/fixtures/lifecycle.ts` | (helper) | the scripted sequence both suites drive |

Fixture: Epic 03's tool-heavy fixture reused; extended in place (Story 2) with a mutation-in-flight variant — one edit applied, drain *not* settled, so cleared-pending states are real production states, not hand-written rows (FC-fidelity rule carried from Epic 03 Story 0: states reached through intake → mutate → partial drain, never direct `derived_form` writes).

## TC → Test Mapping

| TC | Test (file :: name) | Assertion spine |
|----|--------------------|-----------------|
| TC-1.1 | inspect-overview :: full shape variants | fresh-empty, mid-first-turn, never-compacted-with-record, compacted, and mid-rebuild all return the full shape with absent pieces as zeros/nulls; compacted fixture exact counts per section vs fixture ground truth |
| TC-1.2 | inspect-overview :: deleted accounting | delete one → visible−1, deleted=1, kind map excludes, tokens drop by its estimate, event count unchanged |
| TC-1.3 | inspect-overview :: purity | two calls, no writes between → deep-equal; read-only delta assert green; zero provider calls |
| TC-2.1 | inspect-view :: arrangement fidelity | entries/forms/degraded/gap reasons/config/provenance equal `describe` output equal stored row (degraded + gap fixture) |
| TC-2.2 | inspect-view :: loadCost parity on boundary-advanced fixture | tail costs short forms short; `total` = estimator over an independent `pull`'s messages |
| TC-2.3 | inspect-view :: never-compacted | `meta: null`, bands `[]`, tail spans record, parity holds |
| TC-3.1 | messages-read :: order, fields, bounds | record order; kind/tokens/turnId present; `from`/`to`/`limit` exact windows; `from > to` → `caller_error` |
| TC-3.2 | messages-read :: show full record + forms | drained tool-result: full content (not shortened), forms with states, outcome metadata present |
| TC-3.3 | messages-read :: deleted handling | default list excludes; `includeDeleted` marks; show on deleted → ok + flag; show on missing id → `message_not_found` |
| TC-3.4 | cli-process-inspect :: list/show parity | spawned `lhc messages list/show` JSON deep-equals in-process SDK results |
| TC-4.1 | inspect-health :: counts + queue consistency | mixed-state fixture: exact counts per owner/kind/state; queue section equals live-item counts from the same reports |
| TC-4.2 | inspect-health :: failure detail + preview | failed: reason/attempts/lastError exact; blocked excluded from preview; preview = failed∧¬blocked set exactly |
| TC-4.3 | inspect-health :: rebuild bracket | edit → health: cascade set pending with queued work visible (exact subjects per cascade contract); `drainSettled` → same set ready; disjoint forms untouched |
| TC-5.1 | lifecycle :: full sequence + checkpoints | every phase ok; post-compact pull = bands+tail; mutate → pending; drain → ready; compact2 reflects edit; receipt sweep section field-equals pre-compact health snapshot |
| TC-5.2 | lifecycle :: replay determinism | fresh thread, same script → hash-equal pull outputs and materialized file |
| TC-5.3 | lifecycle :: teardown continuity | `freshSdk` between phase groups → final pull/health/file identical to TC-5.1 run |
| TC-5.4 | cli-process-inspect :: checkpoint parity | spawned CLI overview/view/list at three checkpoints deep-equal in-process results at same checkpoints |

## Architecture-Risk Tests

| Risk | Test | Why it bites |
|------|------|--------------|
| Inspect quietly writes (work rows, boundary nudge, view touch) | **read-only delta assert**: shared helper snapshots observable state (queued work via owners, boundary/zone via status, view identity via describe, event/message counts) before/after *every* new operation; deep-equal after. Runs inside each TC file via wrapper | A single forgotten side effect makes "inspect describes, never changes" fiction; absence-of-delta is checkable, absence-of-write-code is not |
| Zero-provider on all new ops | suite-wide assert extended: overview/view/health/describe/show/list under a throwing provider config → all ok | The no-inference NFR stays structural through the last epic |
| `loadCost` drifts from served reality | TC-2.2's independent-pull leg + lifecycle TC-5.1 checkpoint (report at compact1 vs pull1) | Parity by construction can still break at the estimator seam; two independent measurements pin it |
| Health re-derives instead of composing | health tests assert composition through owner surfaces only: `check-boundaries` forbids cross-domain internal imports, an Epic 04 source check rejects raw SQL references to other domains' tables from `domains/inspect/**`, and the read-only delta assert separately catches writes | The must-not-own rule is the domain's entire contract |
| Lifecycle order bugs only visible cross-epic | TC-5.1's named-phase checkpoints; receipt-vs-health field equality | First sequence ever to run all surfaces in PI-extension order; seam drift between three separately-built epics surfaces here or in production |

## Suite Accounting

Default suite grows ~26 tests across 5 files. Process suite grows TC-3.4 + TC-5.4 (2 spawned scenarios, ~6 assertions); accounting row carried: process suite `ran | not-ran` recorded per verify-all invocation, never silently skipped.

## Chunk Red/Green Detail

**Chunk 1 — message reads (S1).** Red: `show` absent from surface (structured not-implemented per house stub rule); list opts ignored — bounds test fails on full-list return. Green: opts → WHERE/LIMIT; show + report join; `cli/messages-read.ts`; TC-3.1–3.3 + read-only legs. ~8 tests.

**Chunk 2 — inspect domain (S2).** Red: `inspect.*` stubs return not-implemented; fixture lacks mutation-variant (TC-4.3 unwritable → fixture work first). Green: `shared/inspect.ts` shapes; overview composition; health composition; `cli/inspect.ts`; delta-assert helper lands here and wraps Chunk 1's ops retroactively. TC-1.1–1.3, TC-4.1–4.3. ~11 tests.

**Chunk 3 — view report (S3).** Red: `describe` absent; `inspect.view` stub. Green: `describe` (row → `StoredView`), `view-report.ts` (describe + pull → report), TC-2.1–2.3 + describe null/shape legs. ~6 tests.

**Chunk 4 — lifecycle (S4).** Red: `lifecycle.ts` helper absent; all four TC files reference it. Green: script with named phases + `freshSdk` hook; TC-5.1–5.3 default; TC-5.4 process. ~7 tests (4 scenarios, multi-checkpoint).

## Verification

Per-story: `pnpm verify` (lint, typecheck, default suites). Story 4 and epic close: `LHC_PROCESS_SUITE=1 pnpm verify-all` — process suite must report `ran`. Red manifests regenerated per chunk per house discipline; no Epic 01–03 test amendments expected (additive surfaces only — list-opts default behavior is unchanged, existing `listMessages` callers see identical results).


## Current Run Index
- planner_turn_index: 3
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-verify completed with outcome block and status blocked.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/004-verify.json
- older_response_count: 1
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementation, verify story gate pnpm verify and ensure process suite evidence with LHC_PROCESS_SUITE=1 pnpm verify-all reports ran before recommending acceptance."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/004-verify.json
bytes: 6392
payload:
  command: "story-verify"
  version: 1
  status: "blocked"
  outcome: "block"
  result:
    resultId: "6cdbe22b-c2d4-4167-b31a-2609df607b6e"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ebc73-5c2d-74a0-94cd-5b41b354bafe"
    continuation:
      provider: "codex"
      sessionId: "019ebc73-5c2d-74a0-94cd-5b41b354bafe"
      storyId: "04-lifecycle-exercise"
    mode: "initial"
    story:
      id: "04-lifecycle-exercise"
      title: "Story 4: Lifecycle Exercise"
    artifactsRead:
      - "packages/lhc/docs/02-specs/04-inspection/stories/04-lifecycle-exercise.md"
      - "packages/lhc/docs/02-specs/04-inspection/tech-design.md"
      - "packages/lhc/docs/02-specs/04-inspection/test-plan.md"
      - "packages/lhc/docs/02-specs/04-inspection/team-impl-log.md"
      - "packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/003-implementor.json"
      - "packages/lhc/test/fixtures/lifecycle.ts"
      - "packages/lhc/test/lifecycle.test.ts"
      - "packages/lhc/test/cli-process-inspect.test.ts"
      - "packages/lhc/test/fixtures/index.ts"
      - "packages/lhc/test/red-manifest.json"
      - "packages/lhc/package.json"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/src/cli/inspect.ts"
      - "packages/lhc/src/cli/messages-read.ts"
      - "packages/lhc/src/providers/deterministic.ts"
      - "packages/lhc/src/providers/registry.ts"
      - "packages/lhc/src/domains/thread-view/index.ts"
      - "packages/lhc/src/domains/thread-view/internal/materialize.ts"
      - "packages/lhc/src/domains/threads/internal/create.ts"
    reviewScopeSummary: "Initial verification of Story 4 against the story, tech design, test plan, implementation artifact, touched lifecycle tests/fixtures, CLI/SDK/materialize production paths, and configured gates. The gates pass, but exact materialized-file byte identity is not proven because the lifecycle assertions normalize random thread IDs before comparison."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "SV-04-001"
        severity: "major"
        title: "Materialized-file determinism is normalized instead of byte-identical"
        evidence: "AC-5.3/TC-5.2 require fresh-thread replay to produce byte-identical materialized files, and TC-5.3 requires the teardown materialized file to be identical to the uninterrupted run. The test helper replaces every run's threadId with \"<thread-id>\" before hashing (`packages/lhc/test/lifecycle.test.ts:97-103`), the replay test asserts the IDs differ and then hashes `comparableSessionFile(...)` instead of raw file bytes (`packages/lhc/test/lifecycle.test.ts:282-285`), and the teardown leg uses the same normalized comparison (`packages/lhc/test/lifecycle.test.ts:296-302`). Production materialization writes the thread ID into the session header as `id: ${input.threadId}:${input.headerTimestamp}` (`packages/lhc/src/domains/thread-view/internal/materialize.ts:44-52`), while thread IDs are generated with `randomBytes` (`packages/lhc/src/domains/threads/internal/create.ts:16-19`). The implementor artifact also records this as a spec deviation, but the Story 4 spec says `Spec Deviations: None`."
        affectedFiles:
          - "packages/lhc/test/lifecycle.test.ts"
          - "packages/lhc/src/domains/thread-view/internal/materialize.ts"
          - "packages/lhc/src/domains/threads/internal/create.ts"
        requirementIds:
          - "AC-5.3"
          - "TC-5.2"
          - "AC-5.4"
          - "TC-5.3"
        recommendedFixScope: "human-ruling"
        blocking: true
    openFindings:
      -
        id: "SV-04-001"
        severity: "major"
        title: "Materialized-file determinism is normalized instead of byte-identical"
        evidence: "AC-5.3/TC-5.2 require fresh-thread replay to produce byte-identical materialized files, and TC-5.3 requires the teardown materialized file to be identical to the uninterrupted run. The test helper replaces every run's threadId with \"<thread-id>\" before hashing (`packages/lhc/test/lifecycle.test.ts:97-103`), the replay test asserts the IDs differ and then hashes `comparableSessionFile(...)` instead of raw file bytes (`packages/lhc/test/lifecycle.test.ts:282-285`), and the teardown leg uses the same normalized comparison (`packages/lhc/test/lifecycle.test.ts:296-302`). Production materialization writes the thread ID into the session header as `id: ${input.threadId}:${input.headerTimestamp}` (`packages/lhc/src/domains/thread-view/internal/materialize.ts:44-52`), while thread IDs are generated with `randomBytes` (`packages/lhc/src/domains/threads/internal/create.ts:16-19`). The implementor artifact also records this as a spec deviation, but the Story 4 spec says `Spec Deviations: None`."
        affectedFiles:
          - "packages/lhc/test/lifecycle.test.ts"
          - "packages/lhc/src/domains/thread-view/internal/materialize.ts"
          - "packages/lhc/src/domains/threads/internal/create.ts"
        requirementIds:
          - "AC-5.3"
          - "TC-5.2"
          - "AC-5.4"
          - "TC-5.3"
        recommendedFixScope: "human-ruling"
        blocking: true
    requirementCoverage:
      verified:
        - "AC-5.1 / TC-5.1 phase operations return ok through deterministic SDK configuration"
        - "AC-5.2 / TC-5.1 checkpoint coherence for bands+tail, pending cleared set, post-drain ready state, edited/deleted content, and receipt-vs-health sweep agreement"
        - "AC-5.5 / TC-5.4 spawned CLI overview/view/messages-list parity at inspect1, health2, and materialize checkpoints"
        - "TC-5.2 pull-output hash equality"
        - "TC-5.3 final pull and health equality"
      unverified:
        - "AC-5.3 / TC-5.2 exact byte-identical materialized files on fresh-thread replay"
        - "AC-5.4 / TC-5.3 exact byte-identical materialized file versus uninterrupted run"
    gatesRun:
      -
        command: "pnpm verify"
        result: "pass"
      -
        command: "pnpm verify-all"
        result: "pass"
    productionPathFindings:
[]
    recommendedNextStep: "block"
    recommendedFixScope: "human-ruling"
    openQuestions:
      - "Should AC-5.3/TC-5.2 and TC-5.3 accept threadId-normalized materialized-file equality, or should the production thread/materialize contract change so fresh-thread files are literally byte-identical?"
    additionalObservations:
      - "`pnpm verify` passed: 328 tests across 32 files."
      - "`pnpm verify-all` passed: 366 tests across 44 files, with the process suite running."
      - "No material production-path fake adapter, shim, or placeholder was found in the audited SDK/CLI/provider/materialize paths; the blocking issue is a test/spec contract gap, not a runtime fake path."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/004-verify.json"
  startedAt: "2026-06-12T15:28:57.211Z"
  finishedAt: "2026-06-12T15:32:50.202Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/003-implementor.json
bytes: 7637
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "cda18cea-481b-4d6f-a165-a97f9746d9c7"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "77c6c733-044c-452a-abeb-bd7584806be0"
    continuation:
      provider: "claude-code"
      sessionId: "77c6c733-044c-452a-abeb-bd7584806be0"
      storyId: "04-lifecycle-exercise"
    outcome: "ready-for-verification"
    story:
      id: "04-lifecycle-exercise"
      title: "Story 4: Lifecycle Exercise"
    planSummary: "Built the shared lifecycle script (test/fixtures/lifecycle.ts) that drives every v1 surface in PI-extension call order — create → multi-turn tool-heavy intake → background drainSettled → status → compact(profile 'lifecycle') → pull → inspect overview/view/health → edit+delete → rebuild drainSettled → health → compact2 → pull2 → materialize — against one real SDK configuration (registry deterministic provider, background mode, pinned chunk policy, named lifecycle profile, low compact threshold). The script owns sequence and phase names and returns raw OpResults per phase; all assertions live in the driving tests (DD-8). Background mode is honored deterministically: every SDK operation is synchronous SQLite chained through microtasks while a scheduler drain pass always starts on a macrotask, so the post-mutation pending snapshot is captured before the poked drain's first claim (documented in the fixture header). test/lifecycle.test.ts freezes Date only (vi.useFakeTimers({toFake:['Date']})) so pull outputs replay byte-identical with zero normalization; TC-5.1 covers all-phases-ok, status-recommends-compact, bands+tail with loadCost priced against the independent pull, cleared-set-pending == cascade-cleared-union with queue consistency, post-drain all-ready, pull2 serving the edited prompt verbatim and the deleted text absent, and compact2's sweep receipt field-equal to a projection of the health2 snapshot taken immediately before it. TC-5.2 replays on a fresh thread (hash-equal pulls, byte-identical file modulo the one random thread id); TC-5.3 reruns with fresh createSdk between the four phase groups and matches final pull/health/file. TC-5.4 (process suite) drives the same script with spawned dist/cli.js inspect overview/view and messages list probes at the three read checkpoints, deep-equal against in-process results, with checkpoint-fired accounting so the leg can never silently skip."
    changedFiles:
      -
        path: "packages/lhc/test/fixtures/lifecycle.ts"
        reason: "New shared lifecycle script: phase sequence, one SDK configuration factory, deterministic event generation, freshSdk-between-groups hook (TC-5.3), checkpoint callback (TC-5.4), mutation target constants."
      -
        path: "packages/lhc/test/lifecycle.test.ts"
        reason: "New default-suite TC-5.1/5.2/5.3 legs: checkpoint assertions, receipt-vs-health cross-check, replay determinism, teardown continuity; Date-only fake timers as the determinism control."
      -
        path: "packages/lhc/test/cli-process-inspect.test.ts"
        reason: "TC-5.4 checkpoint parity leg appended (planned in Story 1's file header): spawned CLI overview/view/list at three lifecycle checkpoints deep-equal in-process SDK reads; checkpoint-visited accounting."
      -
        path: "packages/lhc/test/fixtures/index.ts"
        reason: "Re-export the lifecycle fixture surface per the fixtures-index house pattern."
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "Recorded hashes for lifecycle.test.ts and the extended cli-process-inspect.test.ts per red-manifest discipline (SV-01-004 precedent)."
    tests:
      added:
        - "test/lifecycle.test.ts :: TC-5.1 every phase operation returns ok with the deterministic provider only"
        - "test/lifecycle.test.ts :: TC-5.1 status recommends the compact the sequence performs next, with derivation settled"
        - "test/lifecycle.test.ts :: TC-5.1 post-compact pull serves bands + tail, and the view report's loadCost prices that pull"
        - "test/lifecycle.test.ts :: TC-5.1 post-mutation health shows exactly the cleared set pending; post-drain health shows it ready"
        - "test/lifecycle.test.ts :: TC-5.1 the second compact's view reflects post-edit content"
        - "test/lifecycle.test.ts :: TC-5.1 the second compact receipt's sweep section agrees with the health report taken immediately before it"
        - "test/lifecycle.test.ts :: TC-5.2 replay produces hash-equal pull outputs and a byte-identical materialized file (modulo the one random thread id)"
        - "test/lifecycle.test.ts :: TC-5.3 teardown continuity yields final pull, health, and materialized file identical to the uninterrupted run's"
        - "test/cli-process-inspect.test.ts :: TC-5.4 spawned overview/view/list reads at three lifecycle checkpoints deep-equal the in-process results"
      modified:
[]
      removed:
[]
      totalAfterStory: 328
      deltaFromPriorBaseline: 8
    gatesRun:
      -
        command: "pnpm verify"
        result: "pass"
      -
        command: "pnpm verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Initial queue assertion misread HealthReport.queue as per-work-item counts; AC-4.5 pins it per report entry (consistent-by-construction with pending counts) — assertion corrected to queued == cleared-set size and the run re-verified green."
      findingsSurfaced:
        - "The post-mutation pending checkpoint relies on Node's microtask-before-macrotask ordering: all SDK operations are synchronous SQLite, and a background drain pass always defers through setImmediate, so the edit → delete → health cascade completes before the drain's first claim. This is deterministic per event-loop semantics and documented in the fixture header, but a future surface adding real async IO inside a mutation or health read would need the comment revisited."
        - "Replay byte-identity requires freezing Date in-process (compact stamps view created_at and mutations stamp timestamps from the wall clock; there is no SDK-level clock seam reaching those paths). vi.useFakeTimers({toFake:['Date']}) leaves the scheduler's real setImmediate/setTimeout untouched. If a clock seam is ever plumbed through thread-view/mutations, the freeze can be dropped."
        - "verify-all total is 366 (prior 357, +9): the process suite's TC-5.4 test counts only under the epic gate; the default-suite delta is +8."
        - "Pre-existing working-tree modifications to AGENTS.md, 00-prd.md, 01-tech-arch.md, and team-impl-log.md belong to the run setup, not this story; they were left untouched."
    openQuestions:
[]
    specDeviations:
      - "AC-5.3/AC-5.4 materialized-file equality is asserted byte-identical after substituting each run's own thread id with a fixed placeholder (every other byte exact, and the test asserts the two ids actually differ). The thread id is the design's one random value (threads design decision 7) and the PI session header embeds it as `id: \"<threadId>:<timestamp>\"`; two real threads cannot share an id through the public surface, so literal whole-file byte-identity across fresh threads is structurally unattainable without shimming thread identity below the SDK (anti-shim). Pull outputs are compared hash-exact with no normalization."
    recommendedNextStep: "Story verification (TC-5.1–5.4 all green under both gates; process suite reported ran with 44 files / 366 tests), then epic close-out per the run plan: epic review pass and final `LHC_PROCESS_SUITE=1 pnpm verify-all` gate."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/003-implementor.json"
  startedAt: "2026-06-12T15:07:22.100Z"
  finishedAt: "2026-06-12T15:28:43.966Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/story-lead/001-current.json
Bytes: 2135

```yaml
storyRunId: "04-lifecycle-exercise-story-run-001"
storyId: "04-lifecycle-exercise"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome block and status blocked."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/004-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "77c6c733-044c-452a-abeb-bd7584806be0"
    storyId: "04-lifecycle-exercise"
  storyVerifier:
    provider: "codex"
    sessionId: "019ebc73-5c2d-74a0-94cd-5b41b354bafe"
    storyId: "04-lifecycle-exercise"
latestEventSequence: 8
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Implementation reports ready-for-verification, but there is no verifier pass yet. The next bounded action is to verify the story gate, process-suite evidence, and the reported materialized-file equality deviation against AC-5.1 through AC-5.5."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/004-verify.json"
replayBoundary: null
updatedAt: "2026-06-12T15:32:50.212Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation, verify story gate pnpm verify and ensure process suite evidence with LHC_PROCESS_SUITE=1 pnpm verify-all reports ran before recommending acceptance.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-12T15:07:22.066Z; note="After implementation, verify story gate pnpm verify and ensure process suite evidence with LHC_PROCESS_SUITE=1 pnpm verify-all reports ran before recommending acceptance."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/story-lead/001-events.jsonl
Bytes: 3388

```yaml
-
  storyRunId: "04-lifecycle-exercise-story-run-001"
  sequence: 1
  timestamp: "2026-06-12T15:07:09.397Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "04-lifecycle-exercise-story-run-001"
  sequence: 2
  timestamp: "2026-06-12T15:07:22.048Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ebc5f-6762-7e12-b2ab-aa53614c9642"
-
  storyRunId: "04-lifecycle-exercise-story-run-001"
  sequence: 3
  timestamp: "2026-06-12T15:07:22.066Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, verify story gate pnpm verify and ensure process suite evidence with LHC_PROCESS_SUITE=1 pnpm verify-all reports ran before recommending acceptance."
-
  storyRunId: "04-lifecycle-exercise-story-run-001"
  sequence: 4
  timestamp: "2026-06-12T15:07:22.066Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, verify story gate pnpm verify and ensure process suite evidence with LHC_PROCESS_SUITE=1 pnpm verify-all reports ran before recommending acceptance."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "04-lifecycle-exercise-story-run-001"
  sequence: 5
  timestamp: "2026-06-12T15:28:43.976Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "04-lifecycle-exercise-story-run-001"
  sequence: 6
  timestamp: "2026-06-12T15:28:57.151Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ebc73-29c0-7782-b1d0-d00f49695136"
-
  storyRunId: "04-lifecycle-exercise-story-run-001"
  sequence: 7
  timestamp: "2026-06-12T15:28:57.174Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "04-lifecycle-exercise-story-run-001"
  sequence: 8
  timestamp: "2026-06-12T15:32:50.212Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome block and status blocked."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/04-lifecycle-exercise/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "block"
    status: "blocked"
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
Bytes: 209

```yaml
storyGate: "pnpm verify"
epicGate: "pnpm verify-all"
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
