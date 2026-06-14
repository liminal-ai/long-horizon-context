# Story Lead Base Prompt

## Role Charter
You are the story lead for `00-foundation` on durable story run `00-foundation-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/stories/00-foundation.md
Bytes: 7103

# Story 0: Extension Foundation

### Summary
<!-- Jira: Summary field -->

Build the walking skeleton for the pi-lhc extension: package scaffold, PI hook registration rail, plain-data-only state holder, stubbed LHC init/dispose seam, corpus fixture loader, and typed fail-closed stubs.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** Establish the loadable extension structure every later story builds on, with no stale PI context retained across hook boundaries and no stub that can fake successful capture.

**Scope In:**

- PI extension entry point and hook registration rail.
- Plain-data-only extension state holder for thread reference, file path, and told-the-user flags.
- Stubbed `initLhc` / dispose seam that later stories replace with real lifecycle behavior.
- Test fixture and corpus-loading harness that can load recorded PI corpora and expected intake-event shapes.
- Typed fail-closed stubs for unimplemented capture, inference, validation, and fork behavior.

**Scope Out:**

- No acceptance criteria from Epic 1 are completed by this story.
- No real thread resolution, event capture, derivation routing, startup validation, fork seeding, or inspect verification behavior.
- No context serving; Epic 1 remains observe-only and registers no `context` hook behavior.

**Dependencies:** None.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

No Epic 1 ACs are owned by Story 0.

**Smoke Test Conditions**

- Extension package loads and registers the PI hook rail.
- Hook handlers can receive fresh PI context objects without retaining them across handler boundaries.
- Stubbed init/dispose seam can be invoked and returns typed fail-closed results for unimplemented behavior.
- Fixture loader reads recorded corpus fixtures and produces structurally valid intake-event expectations.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 0 creates the package rail that later stories fill in. It must load as a PI extension, register the Epic 1 hook handlers, expose typed module boundaries, and keep state as plain data only.

No Epic 1 product AC is completed here. The story proves that the extension can be loaded, that future handlers have fail-closed seams, and that fixture/test utilities exist before behavior stories depend on them.

#### Build Strategy

Strategy: tdd-lite

Reason:
- This is foundation work with no AC owner, but later stories can be reward-hacked if stubs fake success.
- Red should prove fixture invariants, package gates, and load/registration smoke before Green fills the scaffold.

Risk Reminders:
- Stubs must fail closed with typed results and must not return success for unimplemented capture, inference, validation, or fork behavior.
- The state holder shape must make retaining PI context objects impossible in normal use.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Package scaffold | `packages/pi-lhc/package.json`, `packages/pi-lhc/tsconfig*.json`, verification scripts |
| Extension entry | `packages/pi-lhc/src/index.ts` |
| Lifecycle rail | `packages/pi-lhc/src/lifecycle/instance.ts`, `packages/pi-lhc/src/lifecycle/state.ts` |
| Capture/inference/fork stubs | `packages/pi-lhc/src/capture/*`, `packages/pi-lhc/src/inference/*`, `packages/pi-lhc/src/lifecycle/fork.ts` |
| Fixtures | `packages/pi-lhc/test/fixtures/corpus.ts`, `packages/pi-lhc/test/fixtures/synthetic.ts`, `packages/pi-lhc/test/fixtures/model-call.ts`, `packages/pi-lhc/test/fixtures/thread.ts` |

#### Design References

- [tech-design.md §Context](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:35), lines 35-45
- [tech-design.md §Module Architecture](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:143), lines 143-174
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:417), lines 417-531
- [tech-design.md §Fixture Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:555), lines 555-563
- [tech-design.md §Chunk 0](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:635), lines 635-648
- [test-plan.md §Chunk 0](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:140), lines 140-145

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| None | `test/fixtures/corpus.test.ts`, extension-load smoke, package script checks | Foundation has no story-owned TC; smoke checks prove load, hook rail, fail-closed stubs, fixture validity, and verification-script availability. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Fixture validity | `test/fixtures/corpus.test.ts` | Corpus loader yields valid `MessageEventInput` shapes and lifecycle-coherent sequences; named invalid builders produce intended malformed shapes. | Story 0 owns no AC/TC, but later capture tests depend on trustworthy fixtures. |

#### Technical Notes

- Register only the Epic 1 observe-only hook rail; do not add `context` serving behavior.
- Define the interfaces from the tech design as imports from the LHC package where applicable, not local redefinitions.
- Keep `state.ts` complete rather than stubbed: it is the shape that prevents stale PI context retention later.

#### Anti-Shim Requirements

- No stub may report successful capture, derivation, validation, fork seeding, or replay before the owning story implements it.
- Fixture loaders must parse and validate shape; do not hardcode passing fixture counts.

#### Production Path Proof

- Entrypoint: `packages/pi-lhc/src/index.ts` PI extension registration.
- Registration/default path: package load registers the Epic 1 hooks and routes them to fail-closed handlers.
- Evidence: extension-load smoke plus package `red-verify` prove the production entry exports and hook rail compile.

#### Verification

- Targeted: `pnpm --filter pi-lhc red-verify`
- Story gate: `pnpm --filter pi-lhc red-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Extension scaffold loads in PI's extension environment.
- Hook registration rail exists for every PI hook consumed in Epic 1.
- State holder shape stores only plain data.
- Stubbed LHC init/dispose seam is callable and fail-closed.
- Fixture loader can load corpus files and expected intake-event shapes.
- Smoke tests cover load, hook registration, plain-data state, init/dispose seam, and fixture loading.


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md
Bytes: 14855

# Epic 1: Connector Core — Test Plan

**Status:** Draft for review
**Tech design:** `tech-design.md`
**Epic:** `epic.md`

This plan maps every TC to one or more tests, assigns each to a chunk, and lays out the Red/Green sequence per chunk. The mock boundary is fixed by the tech design: the PI hook surface (fed by synthetic events and recorded corpora) and the `ModelCall` (a deterministic fake) are the only external edges; everything LHC runs real against a temp SQLite thread. Connector modules are exercised through their entry points, never mocked against each other.

---

## Test Count Reconciliation

| Chunk | Story | TCs covered | TC tests | Architecture-risk tests | Fixture/foundation tests | Chunk total |
|-------|-------|-------------|----------|-------------------------|--------------------------|-------------|
| 0 | Foundation | — | 0 | 0 | 7 | 7 |
| 1 | Lifecycle | TC-1.1…1.7 | 7 | 1 (restart) | 0 | 8 |
| 2 | Capture | TC-2.1…2.9 | 9 | 2 (idempotency, atomicity) | 0 | 11 |
| 3 | Verification | TC-6.1…6.3 | 3 | 1 (fixture validity) | 0 | 4 |
| 4 | Fork | TC-3.1…3.3 | 3 | 1 (source vs derived) | 0 | 4 |
| 5 | Inference | TC-4.1…4.5 | 5 | 2 (adapter boundary, concurrency) | 0 | 7 |
| 6 | Validation | TC-5.1…5.6 | 6 | 0 | 0 | 6 |
| **Total** | | **33 TCs** | **33** | **7** | **7** | **47** |

Cross-checks: 33 TC tests = the 33 TCs in the epic traceability table (one test minimum per TC). 7 architecture-risk tests = the 7 rows in the tech design's Architecture-Risk table. 7 foundation tests = Chunk 0's fixture/smoke/gate invariants, including package verification-script availability. Per-chunk totals sum to 47; the epic's story estimate range (59–74) is wider because it counts finer-grained sub-cases the implementer adds at Green — this plan counts the floor (one test per TC + named risk/foundation tests), not the ceiling.

---

## TC → Test Mapping

Grouped by test file, since each row becomes a Red-phase test. All paths under `packages/pi-lhc/`.

### `test/lifecycle/instance.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-1.1 | New launch (no flag) creates one background instance + registered thread | `launch={}`, temp registry+dir | one thread file exists; registry row carries cwd; `resolve` returns it; instance in background mode; queue not driven by connector |
| TC-1.4 | Shutdown disposes with flush; re-resolved thread complete | capture N events, then `session_shutdown` | re-resolving the thread reads all N events through last pre-shutdown event; no trailing loss |

### `test/lifecycle/thread-resolution.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-1.2 | Resolved launch attaches existing thread; no second thread | a registered thread; `launch={session:id}` | `threads.resolve` returns the same threadId; thread count unchanged |
| TC-1.3 | Plain-data holder survives context replacement | fire two hooks with different `ctx` objects | capture continues using fresh ctx; holder never references a prior ctx (asserted by shape) |
| TC-1.5 *(risk: restart)* | Reload re-resolves the thread by id after holder discarded | create, **discard in-memory holder**, fire `session_start{reload}` | thread reference rebuilt by resolving the id from the registry; capture continues on same thread |
| TC-1.6 | Launch modes resolve correctly | `launch` = `{}` / `{session:fullId}` / `{session:partialId}` / `{continue:true}` / `{session:badId}` | new creates; full+partial id resolve the right thread; continue resolves most-recent; bad id returns an actionable error and creates **no** thread |
| TC-1.7 | `--resume` picker lists cwd-scoped, resolves selection, empty-safe | threads in two cwds; `launch={resume:true}` | list shows only current-cwd threads with title+created; selection resolves; empty cwd returns null, no failure |

### `test/capture/converter.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-2.1 | User/assistant/toolResult record ordered; assistant fans out thinking→text→toolCall | synthetic sequence | events recorded in source order; assistant fan-out order exact |
| TC-2.8 *(risk: atomicity)* | Malformed→gap vs store-unavailable→health signal | (a) malformed on writable thread; (b) unavailable store | (a) durable queryable gap; (b) extension health signal in `SessionState.health`, no gap, no hook exception |
| TC-2.9 | Model/thinking changes captured as ordered runtime_notes | fire `model_select` then `thinking_level_select` mid-sequence | each records one `runtime_note` carrying new+previous value; order preserved relative to surrounding messages |

### `test/capture/turn-derivation.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-2.2 | One-prompt-two-tools-then-answer → exactly one LHC turn, `turn_end` at agent_end | the Flow 2 worked-example corpus | exactly one `turn_end`; emitted at `agent_end`; per-step PI `turn_end`s produce none |
| TC-2.3 | Session order from converter source-event order, not turnIndex | two agent runs each starting turnIndex 0 | turns ordered by source-event order through the converter; no collision from repeated turnIndex 0 |

### `test/capture/parallel-and-errors.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-2.4 | Parallel tool calls, out-of-order completion, correlate by id | assistant with toolCalls a,b; results arrive b,a | each `tool_result` correlated to its call by `toolCallId`, not arrival order |
| TC-2.5 | Error tool result captured with flag + content | toolResult `isError:true` | `tool_result` event with error flag and content; nothing dropped |
| TC-2.7 *(risk: idempotency)* | Re-delivered event dedups; normal resume re-fires nothing | replay same event twice; separately, resume | re-delivery returns `skipped`/`duplicate_idempotency_key`; resume produces no historical re-fire |

### `test/capture/abort.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-2.6 | Graceful interrupt: partial content + aborted disposition; turn closes complete-but-aborted | aborted-turn corpus (`stopReason:aborted`, agent_end fires) | partial assistant content recorded; aborted disposition carried; turn closed at agent_end |

> Hard-kill (no `agent_end`) is covered as a deterministic-boundary golden in `turn-derivation.test.ts`: open turn left open, tolerated as a no-op on reattach (no duplication of the recorded prefix).

### `test/lifecycle/fork.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-3.1 *(risk: source-vs-derived)* | Fork creates new thread; source receives no writes | capture a thread, fork it | new thread created; source **logical read-back** (events/messages/turns) unchanged; fork point resolved from `session_before_fork` hook (PI session tree as Epic-1 fallback) |
| TC-3.2 | Fork seeded by replay; read-back matches source through fork point | fork at a known entry | seeded thread read-back equals source read-back through the fork point |
| TC-3.3 | Forms requeue on fork (v1: no copy) | fork a thread with ready forms | target's forms requeue and drain; not copied from source |

### `test/inference/model-call.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-4.1 | Function resolves (provider,model) via registry, returns text | fake registry + complete returning text | returns `{ok:true,text}` for a single-turn message list |
| TC-4.2 | Two kinds → different (provider,model) both route in one session | two assignments, two fakes | each call routes by its keys; both succeed |
| TC-4.3 *(risk: adapter boundary)* | Failure shapes map to exact kinds | inject auth, invalid-request, rate-limit, timeout, network, thrown | terminal: auth, invalid_request; retryable: rate_limit, timeout, network; thrown → other |
| TC-4.4 | Resolved-but-no-output → `empty_output` by adapter (not host fn) | complete returns empty content | LHC adapter yields `empty_output`; host fn returns text-or-transport-failure only |

### `test/inference/closed-loop.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-4.5 | Captured thread's queued derivation invokes fn + persists outcome | captured thread; fakes (one text, one failure); `drainSettled` | at least one ready derived form + one classified failure, both queryable via inspect/health |
| *(risk: concurrency)* | Stale background result does not clobber newer state | force a stale derivation result against advanced state | newer state wins; stale result discarded |

### `test/inference/startup-validation.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-5.1 | All seven assignments validated against registry before first use | seven assignments, registry | validation runs at session start, before any derivation |
| TC-5.2 | Unreachable lane reported with kind+pair+fix; appears headless | two assignments: (a) `modelRegistry.find(provider, model)` fails; (b) model exists but `hasConfiguredAuth(model)`/`getAvailable()` says auth is absent; headless mode (`hasUI:false`) | report names kind, (provider,model), reason, and distinct fix (`fix assignment` vs `run login/configure auth`); emitted via headless channel and stored in `SessionState.health`, not only TUI |
| TC-5.3 | Validation failure leaves capture running | an unreachable lane | capture continues; affected lane's derivations fail classified + queryable |

### `test/inference/assignments.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-5.4 | Seven kinds load (provider,model,prompt) with shipped defaults; prompt registered | default config | all seven resolve; each prompt names a registered prompt |
| TC-5.5 | Override takes effect next start, no code change | config override one kind | next `session_start` uses the override |
| TC-5.6 | Incomplete/unknown assignment fails loud at init | missing kind / unknown prompt / placeholder | construction throws actionable error; no placeholder masks it |

### `test/verify/replay.test.ts`

| TC | Test | Setup | Assert |
|----|------|-------|--------|
| TC-6.1 | Each corpus replays to a thread whose read-back matches the fixture | chatty, tool-heavy, parallel, error, aborted corpora | read-back (events/messages/turns) matches fixture expectation per corpus |
| TC-6.2 | Same corpus replayed twice → identical read-back | one corpus, two replays | byte-identical read-back; IDs and order stable |
| TC-6.3 | inspect overview/health reflect captured session | a captured thread with a gap + a failed form | counts, last position, gaps, failed derivations all visible |

### `test/fixtures/corpus.test.ts` *(risk: fixture validity)*

| Test | Assert |
|------|--------|
| Corpus loader yields valid MessageEventInput shapes + lifecycle-coherent sequences | every loaded corpus parses to well-formed events; named invalid builder produces the intended malformed shape |

---

## Per-Chunk Red/Green Sequence

Each chunk: write skeletons (structured-result stubs for services/adapters/handlers; `NotImplementedError` for pure algorithms) → Red (tests written, failing for the right reason — never asserting on `NotImplementedError`) → Green (implement to pass). Exit each chunk on `green-verify`.

### Chunk 0: Foundation

- **Skeleton:** all interface exports (`tech-design.md` → Interface Definitions); `index.ts` hook registration with stubbed handlers; `state.ts` complete (plain data, no stub).
- **Red:** fixture-invariant tests (corpus shapes, synthetic coherence, temp-thread create+reopen); extension-loads smoke; package verification scripts/config present.
- **Green:** fixtures + loaders + temp-thread factory implemented; extension registers hooks; `red-verify`/`verify`/`green-verify`/`verify-all` scripts run.
- **Exit:** `red-verify` green; 7 foundation tests pass.

### Chunk 1: Lifecycle

- **Skeleton:** `instance.ts`, `thread-resolution.ts`, `picker.ts` as structured-result stubs.
- **Red:** TC-1.1–1.7 + restart risk test, failing.
- **Green:** construct/dispose, launch resolution (new / `--session` partial-id / `--continue` / `--resume` picker), reload re-resolution, plain-data enforcement.
- **Exit:** `green-verify`; 8 tests pass.

### Chunk 2: Capture

- **Skeleton:** `map-message.ts`, `turn-accumulator.ts`, `idempotency.ts` (`NotImplementedError`); `converter.ts` (structured result).
- **Red:** TC-2.1–2.9 + idempotency + atomicity risk tests, failing. Turn-derivation goldens (worked example, abort, hard-kill) written here.
- **Green:** mapping fan-out, turn accumulation, runtime-change capture (model/thinking → runtime_note), key construction, batch flush with failure isolation.
- **Exit:** `green-verify`; 11 tests pass. Highest-risk chunk — turn derivation and dedup are the load-bearing mechanics.

### Chunk 3: Verification

- **Skeleton:** `verify/replay.ts` (structured compare).
- **Red:** TC-6.1–6.3 + fixture-validity risk test, failing.
- **Green:** replay through the real converter+intake path; read-back compare; inspect surfacing.
- **Exit:** `green-verify`; 4 tests pass. Consumes M0 corpora; widens as they arrive.

### Chunk 4: Fork

- **Skeleton:** `fork.ts` (detect + seed, structured result).
- **Red:** TC-3.1–3.3 + source-vs-derived risk test, failing.
- **Green:** fork-point detection (`session_before_fork` hook; PI session tree as Epic-1 fallback), replay-seed, requeue, source read-only.
- **Exit:** `green-verify`; 4 tests pass.

### Chunk 5: Inference

- **Skeleton:** `model-call.ts` (`createModelCall`, `classifyFailure`).
- **Red:** TC-4.1–4.5 + adapter-boundary + concurrency risk tests, failing. TC-4.5 uses captured content from Chunk 2 + real scheduler + `drainSettled`.
- **Green:** registry resolve + complete, classification, multi-lane, closed-loop wiring.
- **Exit:** `green-verify`; 7 tests pass.

### Chunk 6: Validation

- **Skeleton:** `assignments.ts`, `startup-validation.ts`.
- **Red:** TC-5.1–5.6, failing.
- **Green:** shape validation (LHC-enforced at construction) + reachability probe through `modelRegistry.find` plus configured-auth check + `ctx.ui`/headless reporting + override.
- **Exit:** `green-verify`; 6 tests pass.

---

## Suite Accounting

| Suite | Status | Note |
|-------|--------|------|
| `vitest run` (unit + entry-point) | ran | the 44 tests above |
| `red-verify` (build/typecheck/lint/boundaries) | ran | per chunk |
| `check-test-immutability` | ran | Green exit |
| integration / e2e | **absent** | no separate suite this epic; `verify-all` == `verify` |
| Manual: load into real PI, run a session, inspect | manual | the wide pass; not automated, recorded in tech-design Testing Strategy |

No suite is skipped on auth availability — the closed-loop test (TC-4.5) uses a deterministic `ModelCall` fake, not a live provider, so it always runs.


## Current Run Index
- planner_turn_index: 3
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-verify completed with outcome revise and status ok.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/004-verify.json
- older_response_count: 1
- caller_input_artifact_count: 0
- prior_self_note_count: 2
- latest_self_note: "After verifier result, accept only if verifier passes with no open findings and story gate evidence is present; otherwise route quick-fix or ruling based on concrete findings."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/004-verify.json
bytes: 8681
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "9bfa4be1-81bb-4e1e-b437-f9ef9492c1b3"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ec436-5dff-7ec1-a099-fca4b5b8d01c"
    continuation:
      provider: "codex"
      sessionId: "019ec436-5dff-7ec1-a099-fca4b5b8d01c"
      storyId: "00-foundation"
    mode: "initial"
    story:
      id: "00-foundation"
      title: "Story 0: Extension Foundation"
    artifactsRead:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/stories/00-foundation.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/003-implementor.json"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/package.json"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/index.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/lifecycle/state.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/lifecycle/instance.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/shared/instance.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/shared/not-implemented.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/capture/converter.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/capture/map-message.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/capture/turn-accumulator.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/capture/idempotency.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/capture/runtime-changes.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/lifecycle/thread-resolution.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/lifecycle/picker.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/lifecycle/fork.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/inference/model-call.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/inference/assignments.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/inference/startup-validation.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/src/verify/replay.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/smoke/extension-load.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/smoke/verification-config.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/fixtures/corpus.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/fixtures/corpus.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/fixtures/synthetic.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/fixtures/synthetic.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/fixtures/model-call.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/fixtures/model-call.test.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/fixtures/thread.ts"
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/test/fixtures/thread.test.ts"
    reviewScopeSummary: "Verified Story 0 foundation scope against the story, full connector-core tech design, test plan, implementor artifact, pi-lhc source, fixture tests, smoke tests, package scripts, and fresh gates. Most foundation evidence is present, but the required callable dispose half of the stubbed init/dispose seam is not implemented or tested."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "S0-001"
        severity: "major"
        title: "Dispose side of the init/dispose seam is not callable or proven fail-closed"
        evidence: "Story 0 requires the stubbed init/dispose seam to be callable and return typed fail-closed results. In `packages/pi-lhc/src/lifecycle/instance.ts:12-24`, only `initLhc` and fail-closed `initInstance` are exported. `packages/pi-lhc/src/shared/instance.ts:12-15` declares an eventual `dispose()` method on `LhcInstance`, but `initInstance` currently returns `ok:false`, so no runtime instance exists whose dispose method can be invoked. The smoke test in `packages/pi-lhc/test/smoke/extension-load.test.ts:86-92` only invokes `initInstance` and asserts `not_implemented`; it does not invoke or prove a dispose seam."
        affectedFiles:
          - "packages/pi-lhc/src/lifecycle/instance.ts"
          - "packages/pi-lhc/src/shared/instance.ts"
          - "packages/pi-lhc/test/smoke/extension-load.test.ts"
        requirementIds:
          - "S0-SMOKE-INIT-DISPOSE"
          - "S0-DOD-INIT-DISPOSE"
        recommendedFixScope: "quick-fix"
        blocking: true
    openFindings:
      -
        id: "S0-001"
        severity: "major"
        title: "Dispose side of the init/dispose seam is not callable or proven fail-closed"
        evidence: "Story 0 requires the stubbed init/dispose seam to be callable and return typed fail-closed results. In `packages/pi-lhc/src/lifecycle/instance.ts:12-24`, only `initLhc` and fail-closed `initInstance` are exported. `packages/pi-lhc/src/shared/instance.ts:12-15` declares an eventual `dispose()` method on `LhcInstance`, but `initInstance` currently returns `ok:false`, so no runtime instance exists whose dispose method can be invoked. The smoke test in `packages/pi-lhc/test/smoke/extension-load.test.ts:86-92` only invokes `initInstance` and asserts `not_implemented`; it does not invoke or prove a dispose seam."
        affectedFiles:
          - "packages/pi-lhc/src/lifecycle/instance.ts"
          - "packages/pi-lhc/src/shared/instance.ts"
          - "packages/pi-lhc/test/smoke/extension-load.test.ts"
        requirementIds:
          - "S0-SMOKE-INIT-DISPOSE"
          - "S0-DOD-INIT-DISPOSE"
        recommendedFixScope: "quick-fix"
        blocking: true
    requirementCoverage:
      verified:
        - "S0-NO-EPIC-AC: Story 0 owns no Epic 1 product ACs; verification checked smoke/foundation evidence only."
        - "S0-PACKAGE-HOOK-RAIL: `activate` registers the nine Epic 1 observe-only hooks and does not register `context`; covered by `extension-load.test.ts` and passing gate output."
        - "S0-FRESH-CONTEXT-PLAIN-DATA: guarded handlers accept distinct fresh PI context objects and retained connector state is structured-cloneable; covered by `extension-load.test.ts`."
        - "S0-STATE-HOLDER: `SessionState` stores `threadRef`, flags, and health diagnostics only; covered by `state.ts` and structuredClone smoke coverage."
        - "S0-FAIL-CLOSED-STUBS: capture, thread resolution, picker, fork seeding, model call, assignment validation, startup validation, pure capture helpers, and replay do not report production success before their owning stories; `rg` found no `ok:true` production result path in `src`."
        - "S0-FIXTURE-HARNESS: corpus, synthetic, model-call, and temp-thread fixtures exist; corpus validation rejects malformed fixtures; temp-thread tests create and reopen real SQLite-backed LHC threads."
        - "S0-PACKAGE-GATES: package scripts exist and fresh `verify` and `verify-all` gates passed."
      unverified:
        - "S0-SMOKE-INIT-DISPOSE: dispose side of the stubbed lifecycle seam is not callable or tested as fail-closed."
    gatesRun:
      -
        command: "pnpm --filter pi-lhc verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify-all"
        result: "pass"
    productionPathFindings:
      - "S0-001: lifecycle production surface exposes a callable fail-closed init path but no callable fail-closed dispose path."
    recommendedNextStep: "revise"
    recommendedFixScope: "quick-fix"
    openQuestions:
[]
    additionalObservations:
      - "`packages/pi-lhc/test/fixtures/corpus.ts` currently builds synthetic stand-ins for the named corpora. I treated that as non-blocking for Story 0 because `team-impl-log.md` records M0 real recorded corpus breadth as Story 3 fixture scope."
      - "PI surface types are local declarations in `src/pi/types.ts` because the PI packages are not installed; LHC types are imported from `lhc` throughout the production source."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/004-verify.json"
  startedAt: "2026-06-14T03:39:17.736Z"
  finishedAt: "2026-06-14T03:44:29.228Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/003-implementor.json
bytes: 13834
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "6dc53f8d-d4a2-48e5-9b47-11f8656f7b5b"
    provider: "claude-code"
    model: "claude-opus-4-8"
    role: "story_implementor"
    sessionId: "814546fe-4436-4e4f-8c69-071884ddc90c"
    continuation:
      provider: "claude-code"
      sessionId: "814546fe-4436-4e4f-8c69-071884ddc90c"
      storyId: "00-foundation"
    outcome: "ready-for-verification"
    story:
      id: "00-foundation"
      title: "Story 0: Extension Foundation"
    planSummary: "Built the pi-lhc walking skeleton (Epic 1 Chunk 0, tdd-lite, observe-only). Scaffolded the package (package.json with lhc workspace dep + verification-tier scripts, tsconfig/tsconfig.test mirroring lhc, vitest config, and zero-dep lint/boundaries/immutability scripts incl. a new connector-specific check-boundaries.mjs enforcing pinned cross-surface import edges for lifecycle/capture/inference/verify with no cycle). Declared the PI v0.79.2 extension surface locally in src/pi/types.ts (the @earendil-works PI packages are not installed in this workspace) from the verified wiring research. src/index.ts registers exactly the 9-hook Epic 1 observe-only rail (NOT context) via activate(pi)/createConnector(), with guarded handlers that never throw into PI and retain only plain data. lifecycle/state.ts is complete plain-data SessionState (the anti-stale-ctx shape) + createSessionState; every other module is a typed fail-closed stub per the tech-design Interface Definitions — pure algorithms (mapMessage, eventKey, TurnAccumulator, classifyFailure, detectFork, validateReachable, report, loadAssignments) throw NotImplementedError, services (initInstance, resolveThread, pickThread, capture, seedFork) return an LHC not_implemented OpResult, createModelCall returns a fail-closed 'other' failure, and replayCorpus returns matches:false — no stub reports success. initLhc is provided as the createSdk rename (A-4). Test fixtures: corpus loader (5 named lifecycles) with a real validateCorpus shape/coherence checker + makeTruncatedCorpus, synthetic PI/intake builders, deterministic ModelCall fakes, and a real temp-SQLite-thread factory. 6 foundation test files / 19 tests cover corpus validity (+ invalid builder rejected), synthetic coherence, ModelCall fakes, temp-thread create+reopen, hook-rail registration + fail-closed/plain-data handlers + init/dispose seam, and verification-config presence."
    changedFiles:
      -
        path: "packages/pi-lhc/package.json"
        reason: "Scaffold: name/type/exports, lhc workspace dependency, and verification-tier scripts (red-verify/verify/green-verify/verify-all + build/typecheck/lint/boundaries/test)."
      -
        path: "packages/pi-lhc/tsconfig.json"
        reason: "TS build config mirroring lhc (NodeNext, strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess; src-only emit)."
      -
        path: "packages/pi-lhc/tsconfig.test.json"
        reason: "Test typecheck config (includes src + test + vitest.config, noEmit)."
      -
        path: "packages/pi-lhc/vitest.config.ts"
        reason: "Vitest config: single default tier, no network, passWithNoTests."
      -
        path: "packages/pi-lhc/README.md"
        reason: "Package overview, module layout, gate composition, and the PI-types-local-declaration note (referenced by package.json files)."
      -
        path: "packages/pi-lhc/scripts/lint.mjs"
        reason: "Zero-dep lint gate (no var/any/console-in-src), carried from lhc."
      -
        path: "packages/pi-lhc/scripts/check-boundaries.mjs"
        reason: "New connector boundary check: surfaces lifecycle/capture/inference/verify with pinned cross-surface edges (acyclic), pi/shared leaves may not import surfaces, index is the composition root."
      -
        path: "packages/pi-lhc/scripts/check-test-immutability.mjs"
        reason: "Green-phase test-immutability guard (no red-manifest present → no-op), carried from lhc."
      -
        path: "packages/pi-lhc/scripts/record-red-manifest.mjs"
        reason: "Helper to record Red-phase test hashes, carried from lhc."
      -
        path: "packages/pi-lhc/src/index.ts"
        reason: "Extension entry: EPIC_1_HOOKS rail, createConnector() with guarded fail-closed plain-data handlers (never throws into PI, retains no ctx), activate()/default export."
      -
        path: "packages/pi-lhc/src/pi/types.ts"
        reason: "Local declarations of the PI v0.79.2 extension surface (ExtensionAPI/Context, ModelRegistry, hook events, AgentMessage + parts) — the PI packages are not installed in this workspace."
      -
        path: "packages/pi-lhc/src/shared/not-implemented.ts"
        reason: "Fail-closed primitives: NotImplementedError (pure-algo stubs) + notImplemented OpResult using LHC's not_implemented code (service stubs)."
      -
        path: "packages/pi-lhc/src/shared/instance.ts"
        reason: "LhcInstance type (sdk + threadRef + dispose); placed in shared to avoid a lifecycle↔capture import cycle."
      -
        path: "packages/pi-lhc/src/shared/diagnostics.ts"
        reason: "ValidationReport type; placed in shared so SessionState can reference it without a lifecycle→inference edge (re-exported from startup-validation)."
      -
        path: "packages/pi-lhc/src/lifecycle/state.ts"
        reason: "COMPLETE (not stubbed) plain-data SessionState + createSessionState + CaptureFailureDiagnostic — the shape that makes PI-context retention impossible (AC-1.3/2.7)."
      -
        path: "packages/pi-lhc/src/lifecycle/instance.ts"
        reason: "initLhc (the createSdk rename, A-4) + fail-closed initInstance lifecycle seam."
      -
        path: "packages/pi-lhc/src/lifecycle/thread-resolution.ts"
        reason: "LaunchFlags interface + fail-closed resolveThread stub."
      -
        path: "packages/pi-lhc/src/lifecycle/picker.ts"
        reason: "Fail-closed pickThread stub (--resume picker)."
      -
        path: "packages/pi-lhc/src/lifecycle/fork.ts"
        reason: "ForkInfo type + detectFork (throws, no silent 'no fork') + fail-closed seedFork."
      -
        path: "packages/pi-lhc/src/capture/map-message.ts"
        reason: "MapCtx interface + mapMessage pure stub (throws NotImplementedError)."
      -
        path: "packages/pi-lhc/src/capture/runtime-changes.ts"
        reason: "mapModelSelect/mapThinkingLevelSelect pure stubs (throw)."
      -
        path: "packages/pi-lhc/src/capture/turn-accumulator.ts"
        reason: "TurnAccumulator pure state-machine stub (throws)."
      -
        path: "packages/pi-lhc/src/capture/idempotency.ts"
        reason: "eventKey pure stub (throws)."
      -
        path: "packages/pi-lhc/src/capture/converter.ts"
        reason: "Fail-closed capture() orchestrator stub."
      -
        path: "packages/pi-lhc/src/inference/model-call.ts"
        reason: "createModelCall returns a fail-closed 'other'-failure function (never success); classifyFailure pure stub (throws)."
      -
        path: "packages/pi-lhc/src/inference/assignments.ts"
        reason: "loadAssignments stub (throws; never returns a placeholder map)."
      -
        path: "packages/pi-lhc/src/inference/startup-validation.ts"
        reason: "ValidationReport re-export (spec'd home) + validateReachable/report stubs (throw)."
      -
        path: "packages/pi-lhc/src/verify/replay.ts"
        reason: "Corpus + ReplayResult types + fail-closed replayCorpus (matches:false)."
      -
        path: "packages/pi-lhc/test/fixtures/synthetic.ts"
        reason: "Synthetic PI message/event builders (user/assistant/toolResult, session_start/agent_end) + typed validEvent intake builder."
      -
        path: "packages/pi-lhc/test/fixtures/corpus.ts"
        reason: "Corpus loaders (chatty/tool-heavy/parallel-tool/error-result/aborted-turn) + validateCorpus (real shape/correlation/coherence checks, no hardcoded counts) + makeTruncatedCorpus."
      -
        path: "packages/pi-lhc/test/fixtures/model-call.ts"
        reason: "Deterministic ModelCall fakes: fakeModelCallText/fakeModelCallFailure/fakeModelCallRouter."
      -
        path: "packages/pi-lhc/test/fixtures/thread.ts"
        reason: "Real temp SQLite thread factory (tempStore + makeTempThread) mirroring lhc's pattern."
      -
        path: "packages/pi-lhc/test/fixtures/corpus.test.ts"
        reason: "Fixture-validity architecture-risk test: all corpora valid + lifecycle-coherent; invalid builder rejected with named defects."
      -
        path: "packages/pi-lhc/test/fixtures/synthetic.test.ts"
        reason: "Synthetic builder coherence (content-part order, exactOptional omission, unique keys, event payloads)."
      -
        path: "packages/pi-lhc/test/fixtures/model-call.test.ts"
        reason: "ModelCall fakes well-formed: text, each failure kind, router routing + fail-closed on unrouted key."
      -
        path: "packages/pi-lhc/test/fixtures/thread.test.ts"
        reason: "Temp-thread create + reopen from both registry (resolve) and file (info); per-store isolation."
      -
        path: "packages/pi-lhc/test/smoke/extension-load.test.ts"
        reason: "Registers exactly the 9-hook rail (not context); handlers don't throw + retain only plain data; SessionState structuredClone-able; init/dispose seam returns not_implemented."
      -
        path: "packages/pi-lhc/test/smoke/verification-config.test.ts"
        reason: "Verification-tier scripts present + correctly composed; gate script files exist; lhc dependency declared."
      -
        path: "pnpm-lock.yaml"
        reason: "Updated by pnpm install to link pi-lhc's lhc (workspace) / typescript / vitest dependencies."
    tests:
      added:
        - "packages/pi-lhc/test/fixtures/corpus.test.ts"
        - "packages/pi-lhc/test/fixtures/synthetic.test.ts"
        - "packages/pi-lhc/test/fixtures/model-call.test.ts"
        - "packages/pi-lhc/test/fixtures/thread.test.ts"
        - "packages/pi-lhc/test/smoke/extension-load.test.ts"
        - "packages/pi-lhc/test/smoke/verification-config.test.ts"
      modified:
[]
      removed:
[]
      totalAfterStory: 381
      deltaFromPriorBaseline: 6
    gatesRun:
      -
        command: "pnpm --filter pi-lhc red-verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Resolved a lifecycle↔inference type cycle (SessionState references ValidationReport; startup-validation.report takes SessionState) by relocating ValidationReport to src/shared/diagnostics.ts and re-exporting it from startup-validation.ts — keeps the surface-boundary graph acyclic and the boundary check clean."
        - "Avoided a lifecycle↔capture cycle by defining LhcInstance in src/shared/instance.ts (both lifecycle/instance and capture/converter reference it)."
        - "Fixed a TS mapped-type write error in index.ts by typing the handler table as Record<Epic1Hook, PiHookHandler<Epic1Hook>> (contravariantly sound) instead of a generic per-key write."
        - "Held the anti-shim line on the two factory/result stubs that are easy to fake: createModelCall returns a fail-closed 'other' failure (never ok:true) and replayCorpus returns matches:false — neither reports success."
        - "Made validateCorpus inspect real shape/correlation/turn-closure and derive valid from the problems list (no hardcoded passing fixture count), and proved it with makeTruncatedCorpus, per the Anti-Shim requirement."
      findingsSurfaced:
        - "The 'no ctx retention' guarantee is currently enforced structurally (SessionState has no ctx slot) plus a structuredClone snapshot check; it only gains runtime teeth once Story 1 populates state. A dedicated retention regression test belongs with Story 1."
        - "pi-lhc's gate assumes the lhc package is already built (it imports the built 'lhc' dist for both typecheck and the temp-thread runtime). True in this active workspace; a cold checkout would need `pnpm --filter lhc build` first. Standard workspace-consumer assumption, flagged for awareness."
        - "EPIC_1_HOOKS and the PI hook-event payload shapes in src/pi/types.ts are modeled from the wiring research, not the real PI package; the exact registerHook signature and event field names should be reconciled when @earendil-works/pi-coding-agent is added as a dependency."
    openQuestions:
      - "Q2 (tech design): when the lhc-side createSdk→initLhc rename lands, collapse the connector's initLhc wrapper. Mechanical; no blocker now."
      - "Q3 (tech design): M0 recorded-corpora breadth — the corpus loaders build synthetic stand-ins for the 5 named lifecycles and the machinery widens as real recordings arrive (Story 3)."
      - "Q1/A-7 (tech design): image/file-reference intake handling is an M0 decision; the safe interim is degrade-to-runtime_note, which the converter implements in Story 2."
    specDeviations:
      - "PI extension types are declared locally in src/pi/types.ts (mirroring @earendil-works/pi-coding-agent v0.79.2 from docs/specs/02-pi-lhc/notes/pi-ext-integration-research.md) rather than imported, because the PI packages (@earendil-works/pi-coding-agent, @earendil-works/pi-ai) are not installed in this workspace and importing them would fail typecheck. The story's tech-notes rule to 'import interfaces from the LHC package, not redefine' is honored for all LHC types (imported from \"lhc\"); only the absent PI surface is declared locally and is intended to swap to real imports when the dependency lands. The story's Spec Deviations section says 'None'; this is an environmental necessity, not a design change."
      - "initLhc is provided in lifecycle/instance.ts as a thin wrapper over LHC's createSdk (the A-4 rename has not yet landed in the lhc package); the tech design anticipates this as mechanical (Open Question Q2)."
    recommendedNextStep: "Proceed to Story 1 (Session Lifecycle and Launch-Driven Thread Resolution): implement the fail-closed lifecycle seams (initInstance/dispose in background mode, resolveThread for new/--session partial-id/--continue, the --resume picker, and reload re-resolution) and populate SessionState via createSessionState. Note the gating dependency: AC-1.6/1.7 require the lhc-side registry additions (cwd column, partial-id resolve, cwd-filtered listThreads, title — A-8), which are Story 1 scope touching packages/lhc/ and must land before the picker/partial-id tests can pass without degrading."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/003-implementor.json"
  startedAt: "2026-06-14T03:03:00.479Z"
  finishedAt: "2026-06-14T03:39:07.267Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/story-lead/001-current.json
Bytes: 1965

```yaml
storyRunId: "00-foundation-story-run-001"
storyId: "00-foundation"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome revise and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/004-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "814546fe-4436-4e4f-8c69-071884ddc90c"
    storyId: "00-foundation"
  storyVerifier:
    provider: "codex"
    sessionId: "019ec436-5dff-7ec1-a099-fca4b5b8d01c"
    storyId: "00-foundation"
latestEventSequence: 9
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Implementation reports ready-for-verification with story, epic, and smoke gates passing, but acceptance requires independent verifier evidence first."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/004-verify.json"
replayBoundary: null
updatedAt: "2026-06-14T03:44:29.238Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After verifier result, accept only if verifier passes with no open findings and story gate evidence is present; otherwise route quick-fix or ruling based on concrete findings.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-14T03:03:00.443Z; note="After implementation, require verifier evidence for the story gate and foundation smoke checks before recommending acceptance."
- sequence=8; actionSequence=7; createdAt=2026-06-14T03:39:17.699Z; note="After verifier result, accept only if verifier passes with no open findings and story gate evidence is present; otherwise route quick-fix or ruling based on concrete findings."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/story-lead/001-events.jsonl
Bytes: 3840

```yaml
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 1
  timestamp: "2026-06-14T03:02:50.840Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 2
  timestamp: "2026-06-14T03:03:00.419Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ec414-ff5a-7a81-b8ae-d209882b2825"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 3
  timestamp: "2026-06-14T03:03:00.442Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, require verifier evidence for the story gate and foundation smoke checks before recommending acceptance."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 4
  timestamp: "2026-06-14T03:03:00.443Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, require verifier evidence for the story gate and foundation smoke checks before recommending acceptance."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 5
  timestamp: "2026-06-14T03:39:07.276Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 6
  timestamp: "2026-06-14T03:39:17.672Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ec436-3528-7253-af5f-8ec5a0fd49de"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 7
  timestamp: "2026-06-14T03:39:17.698Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
    selfNote: "After verifier result, accept only if verifier passes with no open findings and story gate evidence is present; otherwise route quick-fix or ruling based on concrete findings."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 8
  timestamp: "2026-06-14T03:39:17.699Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After verifier result, accept only if verifier passes with no open findings and story gate evidence is present; otherwise route quick-fix or ruling based on concrete findings."
    actionSequence: 7
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 9
  timestamp: "2026-06-14T03:44:29.238Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/00-foundation/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
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
Bytes: 241

```yaml
storyGate: "pnpm --filter pi-lhc verify"
epicGate: "pnpm --filter pi-lhc verify-all"
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
