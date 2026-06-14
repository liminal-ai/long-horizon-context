# Story Lead Base Prompt

## Role Charter
You are the story lead for `01-session-lifecycle-and-thread-resolution` on durable story run `01-session-lifecycle-and-thread-resolution-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 1.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/stories/01-session-lifecycle-and-thread-resolution.md
Bytes: 11055

# Story 1: Session Lifecycle and Thread Resolution

### Summary
<!-- Jira: Summary field -->

Resolve the recording thread from launch input, initialize and dispose one LHC instance per run, reconstruct after reload, and preserve plain-data-only extension state.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** The right LHC thread is selected from the operator's launch choice and found again across reload and restart, with no PI-session-to-thread mapping record to drift.

**Scope In:**

- `initLhc` initialization in background scheduler mode.
- `session_shutdown` flush and cleanup.
- Launch-driven thread resolution through the registry: new thread, `--session <id>` full/partial id, `--continue` / `-c`, and `--resume` / `-r` cwd-scoped picker.
- A-8 LHC registry additions required for this story: `cwd`, cwd-filtered `listThreads`, partial-id `resolve`, and `title`.
- Reload reconstruction from durable resolved thread id.
- Plain-data-only state across hooks.

**Scope Out:**

- Event capture and turn derivation.
- Fork seeding.
- Context serving; PI's native context handling remains unchanged.

**Dependencies:** Story 0.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-1.1:** On `session_start` with no thread-selecting launch flag, the extension creates a new LHC thread (registering it in the catalog with its cwd), initializes one LHC instance in background scheduler mode against it, and does not drive the derivation queue itself.

**TC-1.1** — Fresh `session_start` with no thread-selecting launch flag: one LHC instance initialized in background mode, one new registry thread created with cwd/title metadata, and no PI-session-to-thread mapping record created.

**AC-1.2:** On `session_start` that resolves to an existing thread (via `--continue`, `--session`, or a picker selection), the extension initializes against that thread by resolving it through the registry. No second thread is created for an already-resolved thread.

**TC-1.2** — `session_start` with launch input resolving an existing registry thread: initializes against that same thread and creates no second thread.

**AC-1.3:** Across all hooks, the extension holds only plain data (thread reference, file path, told-the-user flags) between events. It retains no PI context or session-manager object across hook boundaries; each handler uses the fresh context PI provides. A session replacement (new/resume/fork) that invalidates prior context objects does not break capture.

**TC-1.3** — A session replacement invalidates the prior context object; the extension, holding only plain data, continues capture using the fresh context.

**AC-1.4:** On `session_shutdown`, the extension disposes the LHC instance with flush and cleanup. A subsequent run that resolves the same thread finds it complete through the last event recorded before shutdown — no trailing loss.

**TC-1.4** — `session_shutdown` disposes with flush; reattach finds the thread complete through the last pre-shutdown event.

**AC-1.5:** On reload (extension torn down and re-initialized while the same session continues), the extension reconstructs the thread reference from durable state (the resolved thread id), not from retained in-memory objects, and capture continues on the same thread.

**TC-1.5** — Reload re-initializes the extension; thread reference reconstructed from the resolved thread id; capture continues on the same thread.

**AC-1.6:** Launch resolves the thread by mode: no flag creates a new thread; `--session <id>` resolves a named thread by full or partial id; `--continue`/`-c` resolves the most recently created thread; an ambiguous or unresolvable id fails with an actionable message rather than silently creating a new thread.

**TC-1.6** — Launch by mode resolves correctly: no flag creates a new thread; `--session` resolves by full and by partial id; `--continue` resolves the most recent; an ambiguous/unresolvable id fails with an actionable message and creates no thread.

**AC-1.7:** `--resume`/`-r` lists threads scoped to the current working directory, each shown with its title and creation time, and resolves the operator's selection. With no threads for the cwd, the picker reports an empty list rather than failing.

**TC-1.7** — `--resume` lists cwd-scoped threads with title and creation time and resolves a selection; an empty cwd lists nothing rather than failing.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story owns the session lifecycle surface for Epic 1. The LHC thread is resolved from launch input through the registry, then one LHC instance is initialized in background mode against that resolved thread.

PI still runs normally in this observe-only epic; LHC records alongside it. The connector stores only plain data between hooks and rebuilds from the resolved thread id on reload.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- Launch modes, registry additions, reload behavior, and shutdown flushing all share the thread identity invariant.
- A-8 registry work is implementation scope for this story and must land before the launch-mode checks can pass.

Risk Reminders:
- The registry is the catalog: no separate PI-thread mapping record is introduced.
- `--session` ambiguity or miss returns an actionable error and creates no new thread.
- `--resume` must be cwd-scoped and titled; an unscoped picker does not satisfy the story.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| LHC registry support | `packages/lhc/src/**` registry/thread catalog modules for `cwd`, `title`, partial-id resolve, and cwd-filtered listing |
| Instance lifecycle | `packages/pi-lhc/src/lifecycle/instance.ts` |
| Thread resolution | `packages/pi-lhc/src/lifecycle/thread-resolution.ts` |
| Resume picker | `packages/pi-lhc/src/lifecycle/picker.ts` |
| Plain state | `packages/pi-lhc/src/lifecycle/state.ts` |
| Hook routing | `packages/pi-lhc/src/index.ts` |
| Tests | `packages/pi-lhc/test/lifecycle/instance.test.ts`, `packages/pi-lhc/test/lifecycle/thread-resolution.test.ts` |

#### Design References

- [epic.md §Onboarding Context](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:13), lines 13-18
- [epic.md §Assumptions](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:87), lines 87-99
- [epic.md §Flow 1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:103), lines 103-141
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:180), lines 180-186
- [tech-design.md §Flow 1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:229), lines 229-270
- [tech-design.md §Chunk 1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:650), lines 650-652
- [test-plan.md §Lifecycle Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:32), lines 32-47
- [test-plan.md §Chunk 1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:147), lines 147-152

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-1.1 | `test/lifecycle/instance.test.ts` | Fresh launch creates one cwd/titled registry thread and one background LHC instance; connector does not drive the queue. |
| TC-1.2 | `test/lifecycle/thread-resolution.test.ts` | Existing launch resolves through registry and creates no second thread. |
| TC-1.3 | `test/lifecycle/thread-resolution.test.ts` | Fresh PI context objects across hooks do not break capture; retained holder contains no prior context object. |
| TC-1.4 | `test/lifecycle/instance.test.ts` | Shutdown flushes; re-resolving the thread sees every pre-shutdown event. |
| TC-1.5 | `test/lifecycle/thread-resolution.test.ts` | Reload discards in-memory holder, resolves the same thread id from registry, and continues on that thread. |
| TC-1.6 | `test/lifecycle/thread-resolution.test.ts` | No flag, full id, partial id, continue, and bad id resolve exactly as specified; bad id creates no thread. |
| TC-1.7 | `test/lifecycle/thread-resolution.test.ts` | Resume picker lists only current-cwd threads with title and creation time; empty cwd returns an empty selection state. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Persistence / Restart | `test/lifecycle/thread-resolution.test.ts` | Discard the in-memory holder, re-resolve the same thread by id from the registry, then capture continues on it. | The AC says reload reconstructs; this proves it survives process loss without retained PI objects. |

#### Technical Notes

- Use `threads.newThread`, `threads.resolve`, `threads.listThreads`, and `threads.resolveThreadRef`; `registryPath` is a per-operation argument, not an `initLhc` config field.
- Initialize LHC in background mode and never call `drainSettled` as part of normal session startup.
- Store only thread reference, file path/resolved id, health, and told-the-user flags between hook invocations.

#### Anti-Shim Requirements

- Do not synthesize cwd scoping in the picker by filtering display-only data after an unscoped registry list; the registry operation must support the cwd filter.
- Do not silently create a new thread for an unresolvable or ambiguous named id.

#### Production Path Proof

- Entrypoint: `session_start`, `session_shutdown`, and reload handling through `packages/pi-lhc/src/index.ts`.
- Registration/default path: launch flags route to `thread-resolution.ts` / `picker.ts`; resolved thread initializes `instance.ts` in background mode.
- Evidence: lifecycle tests assert registry rows, resolved thread id, no second thread, flush after shutdown, and reload after holder discard.

#### Verification

- Targeted: `pnpm --filter pi-lhc verify -- test/lifecycle/instance.test.ts test/lifecycle/thread-resolution.test.ts`
- Story gate: `pnpm --filter pi-lhc green-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All Flow 1 ACs and TCs pass.
- LHC registry supports the A-8 fields and operations needed by AC-1.6 and AC-1.7.
- Launch modes create or resolve the correct registry thread.
- Reload reconstructs from resolved thread id.
- Shutdown flushes and disposes the LHC instance.
- Tests prove no retained PI context object is required across session replacement.


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
- planner_turn_index: 1
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-orchestrate-run
- current_child_operation: none
- current_summary: Story orchestration started and durable state has been initialized.
- latest_response_kind: none
- latest_response_path: none
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 0
- latest_self_note: "none"

## Response Trail
<current_response>
No prior bounded child response is recorded yet.
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-current.json
Bytes: 1013

```yaml
storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
storyId: "01-session-lifecycle-and-thread-resolution"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/001-story-validate.json"
    provenance: "prior-run"
latestContinuationHandles:
{}
latestEventSequence: 1
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "orient-from-disk"
  summary: "Orient from 1 existing story artifact(s)."
replayBoundary: null
updatedAt: "2026-06-14T04:03:06.167Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-events.jsonl
Bytes: 242

```yaml
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 1
  timestamp: "2026-06-14T04:03:06.166Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
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
