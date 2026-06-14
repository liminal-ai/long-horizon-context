# Story Lead Base Prompt

## Role Charter
You are the story lead for `01-session-lifecycle-and-thread-resolution` on durable story run `01-session-lifecycle-and-thread-resolution-story-run-001`.
Select exactly one bounded next action for this `resume` turn.
This is planner turn 10.
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
- planner_turn_index: 10
- mode: resume
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-orchestrate-resume
- current_child_operation: none
- current_summary: Story orchestration resume requested and durable state has been reopened.
- latest_response_kind: implementor-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/013-continue.json
- older_response_count: 4
- caller_input_artifact_count: 2
- prior_self_note_count: 7
- latest_self_note: "After revised implementation returns, run verifier against the new implementor artifact; accept only on verifier pass with no open findings and story gate evidence."

## Response Trail
<current_response>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/013-continue.json
bytes: 11679
payload:
  command: "story-continue"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "7c262b39-11f7-4587-b0a8-ed3911efd99a"
    provider: "claude-code"
    model: "claude-opus-4-8"
    role: "story_implementor"
    sessionId: "fc8b0d70-702e-4abc-9faa-dda18cc81eaf"
    continuation:
      provider: "claude-code"
      sessionId: "fc8b0d70-702e-4abc-9faa-dda18cc81eaf"
      storyId: "01-session-lifecycle-and-thread-resolution"
    outcome: "ready-for-verification"
    story:
      id: "01-session-lifecycle-and-thread-resolution"
      title: "Story 1: Session Lifecycle and Thread Resolution"
    planSummary: "Addressed verifier 011 findings SV-001 and SV-002 only, preserving the resolved SV-003 title work, production activate path, fail-closed observeOnlyProvider, and A-8 registry changes. SV-001 (reload used in-process memory): removed the module-scope rememberedSessionThreadId entirely — along with resetSessionThreadMemory, threadIdOf, and launchFor — and made reload re-resolve the thread from DURABLE registry state via a new resolveReloadThread in thread-resolution.ts. On reload, --session/--continue re-resolve by their durable launch input (idempotent, never creating), and a no-flag or --resume session reattaches to the cwd's most-recently-created thread read from the registry (listThreads({cwd}).at(-1)); it never creates a duplicate and never re-prompts. The connector now holds no module-level or durable handoff state; reattach is keyed on the session_start reason (reload vs not), and onDispose no longer keeps/clears any reload memory. This makes the durable reload source the LHC registry (the catalog), not a PI-session->thread mapping or recovery sidecar (epic I-1), answering the verifier's open question. SV-002 (production --resume bypassed operator selection): defaultSelectThread now PRESENTS the cwd-scoped titled candidate list (title + creation time + id, via a renderResumeCandidates helper) through ctx.ui.notify when ctx.hasUI, then resolves to the most-recently-created thread as the best available explicit default — PI v0.79.2 exposes only ui.notify, no interactive input surface — while picker.ts stays cwd-scoped, titled, and selection-injectable (pickThread's select seam). Tests: the reload describe block now proves a fresh connector with an empty closure reattaches purely from the registry (no module handoff, no duplicate), plus a --session reload re-resolve test and a reason-driven 'new always creates' test; the architecture-risk resolve-by-durable-id-after-discard primitive remains. The production --resume tests now assert the operator-visible presentation (cwd-scoped, titled, with creation time, via ctx.ui.notify) and a headless-safe path (no notify when hasUI:false, still resolves). resetSessionThreadMemory was removed from instance.test.ts, thread-resolution.test.ts, and the smoke test; the red-manifest was re-recorded for the two verifier-directed frozen lifecycle files. All pi-lhc gates (verify, green-verify incl. immutability, verify-all) and lhc verify pass."
    changedFiles:
      -
        path: "packages/pi-lhc/src/lifecycle/thread-resolution.ts"
        reason: "Add resolveReloadThread: reload reconstruction from durable registry state (--session/--continue re-resolve by durable launch input; no-flag/--resume reattach to the cwd's most-recently-created thread via listThreads({cwd})), never creating and never re-prompting; returns null when the cwd has no thread to reattach."
      -
        path: "packages/pi-lhc/src/index.ts"
        reason: "SV-001: remove module-scope rememberedSessionThreadId, resetSessionThreadMemory, threadIdOf, and launchFor; route reload session_start through resolveReloadFor (registry-based reattach) keyed on event.reason, add buildResolveDeps, simplify onDispose (no handoff state). SV-002: defaultSelectThread now presents the cwd-scoped titled candidates via ctx.ui.notify when ctx.hasUI (new renderResumeCandidates helper) and resolves to most-recent as the best available default. Update the activate() doc accordingly."
      -
        path: "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        reason: "Remove resetSessionThreadMemory; rewrite the reload describe block to prove durable registry-based reattach with a fresh empty-closure connector, plus a --session reload re-resolve test and a reason-driven 'new always creates' test; rewrite the production --resume tests to assert the operator-visible ctx.ui.notify presentation (cwd-scoped, titled, with creation time) and a headless-safe path."
      -
        path: "packages/pi-lhc/test/lifecycle/instance.test.ts"
        reason: "Remove the now-deleted resetSessionThreadMemory import and beforeEach call (no module-level connector state remains to reset)."
      -
        path: "packages/pi-lhc/test/smoke/extension-load.test.ts"
        reason: "Remove the now-deleted resetSessionThreadMemory import and beforeEach call."
      -
        path: "packages/pi-lhc/test/red-manifest.json"
        reason: "Re-record sha256 hashes for the two verifier-directed frozen lifecycle test files (instance.test.ts, thread-resolution.test.ts) so check-test-immutability matches their updated, strengthened content."
    tests:
      added:
        - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts: 'TC-1.7 production --resume is headless-safe' (no notify when hasUI:false, still resolves)"
        - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts: 'reload reattaches by re-resolving --session from the registry' (durable id evidence, creates nothing)"
      modified:
        - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts: reload describe block rewritten (fresh-connector durable registry reattach; 'new always creates' replaces the old memory-clearing test); production --resume test rewritten to assert the ctx.ui.notify operator-visible presentation; resetSessionThreadMemory removed"
        - "packages/pi-lhc/test/lifecycle/instance.test.ts: resetSessionThreadMemory import + beforeEach call removed (case count unchanged)"
        - "packages/pi-lhc/test/smoke/extension-load.test.ts: resetSessionThreadMemory import + beforeEach call removed (case count unchanged)"
      removed:
[]
      totalAfterStory: 384
      deltaFromPriorBaseline: 3
    gatesRun:
      -
        command: "pnpm --filter pi-lhc verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc green-verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify-all"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc exec vitest run test/lifecycle/instance.test.ts test/lifecycle/thread-resolution.test.ts"
        result: "pass"
      -
        command: "pnpm --filter lhc verify"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "SV-001: removed module-scope rememberedSessionThreadId (and resetSessionThreadMemory/threadIdOf/launchFor); reload now re-resolves from the durable LHC registry via resolveReloadThread — --session/--continue by durable launch input, no-flag/--resume reattach to the cwd's most-recently-created registry row — never creating a duplicate or re-prompting; the connector keeps no module-level handoff and reattach is keyed on session_start reason. TC-1.5 rewritten so a fresh connector with an empty closure reattaches purely from the registry; added a --session reload test and a reason-driven 'new always creates' test; the resolve-by-durable-id-after-discard architecture-risk primitive remains."
        - "SV-002: production --resume presents the cwd-scoped titled candidate list (title + creation time + id) through ctx.ui.notify when ctx.hasUI, then resolves to the most-recent as the best available explicit default (PI v0.79.2 has no interactive input surface); picker.ts stays cwd-scoped, titled, and selection-injectable. Tests assert the operator-visible presentation and a headless-safe path."
      findingsSurfaced:
        - "The durable reload source is the LHC registry (the catalog), NOT a PI-session->thread mapping or recovery sidecar — honoring epic I-1 and answering the verifier's open question."
        - "Reload reattach for no-flag/--resume uses the cwd's most-recently-created thread; within a single Story-1 session that is this session's thread. A concurrent session creating a newer thread in the same cwd could be reattached instead — an Epic-1 limitation; the permanent home for reload/fork lineage is LHC thread metadata (Feature 2+)."
        - "Reattach is reload-only, keyed on the session_start reason (reload vs not), not on any retained memory; a reason:new no-flag session always creates a new thread."
        - "Re-recording the red-manifest was required because the verifier directed the test updates; the rewritten frozen tests strengthen coverage (durable-registry reattach + operator-visible picker), they do not weaken it."
    openQuestions:
      - "Concurrent same-cwd sessions: a no-flag/--resume reload resolves the cwd's most-recent thread, which could be a sibling session's newer thread. A precise per-session durable thread identity (LHC thread metadata, Feature 2+) or a PI-provided stable session key would remove this edge."
      - "Which PI selection surface enables a TRUE interactive --resume operator picker? PI v0.79.2 exposes only ctx.ui.notify; confirm against the real @earendil-works/pi-coding-agent dependency when it becomes a build dep, then replace the notify-list + most-recent default."
      - "(carried) Exact PI launch-flag spelling for --session (recon notes --session-id); title derivation strategy beyond the cwd-leaf interim (TDQ Q4)."
    specDeviations:
      - "Production --resume operator selection: PI v0.79.2 exposes ctx.ui.notify but NO interactive input/selection surface (wiring research). The production picker therefore PRESENTS the cwd-scoped titled candidate list (title + creation time + id) via ctx.ui.notify when ctx.hasUI and resolves to the most-recently-created thread as the best available explicit default; resuming a SPECIFIC thread is done with --session <id> (full or partial). The picker stays cwd-scoped, titled, and selection-injectable (pickThread's select seam, exercised by tests); a true interactive picker is deferred to a PI input surface."
      - "Reload reconstruction source: reload re-resolves the thread from the durable LHC registry (the catalog), not from a PI-session->thread mapping record or recovery sidecar (epic I-1). For no-flag/--resume reload the reattach target is the cwd's most-recently-created thread; for --session/--continue it is the launch input re-resolved by id. An Epic-1 convenience with a known cross-process-same-cwd limitation; the permanent home for reload lineage is LHC thread metadata (Feature 2+)."
      - "(inherited, preserved) Local PI extension types in src/pi/types.ts (Story 0 accepted-risk); initLhc thin wrapper over createSdk (A-4); resolveThread/pickThread injected-deps signatures vs the interface sketch; Story-1 production inference is the fail-closed observeOnlyProvider placeholder (real PI-auth-backed inference is Stories 5/6); new threads created with cwd + a default title equal to the cwd leaf; A-8 LHC additions (ambiguous_thread_id, registry v2 cwd migration) land in this story's scope."
    recommendedNextStep: "Proceed to Story 2 (Event Capture and Turn Derivation) on the lifecycle/instance seam. Separately, when @earendil-works/pi-coding-agent becomes a build dependency, confirm the launch-flag spelling and whether a richer PI selection surface enables a true interactive --resume picker (replacing the notify-list + most-recent default), and revisit reload thread-identity precision via LHC thread metadata (Feature 2+) to close the concurrent-same-cwd edge."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/013-continue.json"
  startedAt: "2026-06-14T05:48:04.803Z"
  finishedAt: "2026-06-14T06:03:46.600Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/003-implementor.json
bytes: 12006
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "a1a1a49f-d7eb-4647-8cff-6ed07b33c9f6"
    provider: "claude-code"
    model: "claude-opus-4-8"
    role: "story_implementor"
    sessionId: "3bd99b80-3187-4d52-9c3e-b6b2c0cfc11e"
    continuation:
      provider: "claude-code"
      sessionId: "3bd99b80-3187-4d52-9c3e-b6b2c0cfc11e"
      storyId: "01-session-lifecycle-and-thread-resolution"
    outcome: "ready-for-verification"
    story:
      id: "01-session-lifecycle-and-thread-resolution"
      title: "Story 1: Session Lifecycle and Thread Resolution"
    planSummary: "Implemented Flow 1 (session lifecycle + launch-driven thread resolution) for pi-lhc Epic 1 Story 1, plus the A-8 LHC registry additions it depends on. LHC side (packages/lhc): added a `cwd` column (registry migration v2 + migrate-on-read so a pre-cwd v1 registry upgrades on first read), partial-id (prefix) matching to `threads.resolve` with a new `ambiguous_thread_id` caller error (exact match wins; ambiguous/absent fail loud), a cwd filter on `listThreads` enforced as the SQL query (anti-shim), and deterministic most-recent ordering (ORDER BY created_at, rowid). Connector side (packages/pi-lhc): `initInstance` builds one SDK in forced background mode after validating the thread, with a flush-on-dispose seam (drainSettled); `resolveThread` handles no-flag/new, `--session` full+partial, and `--continue` most-recent (unresolvable/ambiguous return the registry error, never a silent new thread); `pickThread` lists cwd-scoped threads with title+created and resolves an injected selection (empty cwd → null, never a failure); `parseLaunchFlags` derives the launch mode from process.argv; index.ts wires session_start→resolve→init, session_before_switch/shutdown→dispose(flush), and reload→reattach-by-remembered-durable-id, retaining only plain-data SessionState (the live LhcInstance is held separately and excluded from the snapshot). Tests prove every AC against a real temp registry/thread with a deterministic-provider SDK config. lhc gained 11 direct A-8 tests; pi-lhc gained 8 lifecycle tests (TC-1.1–1.7 + restart-risk + a connector reload-wiring test). All pi-lhc gates green; lhc verify green (388 tests)."
    changedFiles:
      -
        path: "packages/lhc/src/shared/errors.ts"
        reason: "Add `ambiguous_thread_id` caller-error code for A-8 partial-id resolve ambiguity."
      -
        path: "packages/lhc/src/domains/threads/internal/registry.ts"
        reason: "A-8: `cwd` column via registry migration v2; migrate-on-read in openRegistryForRead so a pre-cwd registry upgrades on read; cwd in row type/insert/selects; selectThreadRowsByPrefix (LIKE-metachar-escaped) for partial-id; cwd-filter param on selectAllThreadRows; deterministic ORDER BY created_at, rowid for most-recent."
      -
        path: "packages/lhc/src/domains/threads/index.ts"
        reason: "A-8: NewThreadInput.cwd + ThreadInfo.cwd stored/returned; partial-id resolve (exact-then-prefix, ambiguous_thread_id on >1, thread_not_found on 0, never creates); cwd filter on listThreads."
      -
        path: "packages/lhc/test/threads-a8.test.ts"
        reason: "NEW: 11 tests proving the A-8 registry operations directly (cwd round-trip, unique/ambiguous/absent partial-id, LIKE-metachar literal match, cwd-scoped list, most-recent ordering, v1→v2 migrate-on-read)."
      -
        path: "packages/pi-lhc/src/lifecycle/instance.ts"
        reason: "Implement initInstance (validate thread, force background mode, wrap with flush-on-dispose) and disposeInstance (null-safe); dispose flushes via sdk.drainSettled (AC-1.1, AC-1.4, AC-1.5)."
      -
        path: "packages/pi-lhc/src/lifecycle/thread-resolution.ts"
        reason: "Implement resolveThread (new / --session full+partial / --continue most-recent; unresolvable+ambiguous fail loud, no silent new thread), parseLaunchFlags(argv), and threadRefById/registryArg helpers (AC-1.2, AC-1.5, AC-1.6)."
      -
        path: "packages/pi-lhc/src/lifecycle/picker.ts"
        reason: "Implement pickThread: cwd-scoped listThreads → title+created choices → injected selection → resolve; empty cwd and cancellation return null without failing (AC-1.7)."
      -
        path: "packages/pi-lhc/src/index.ts"
        reason: "Connector wiring: injectable ConnectorDeps (buildSdkConfig/registryPath/newThreadFilePath/parseLaunch/selectThread); session_start→resolve→init, session_before_switch+session_shutdown→dispose(flush), reload→reattach via remembered durable id; plain-data snapshot + getInstance test seam; activate fails closed until the inference host lands (AC-1.1–1.5)."
      -
        path: "packages/pi-lhc/test/lifecycle/instance.test.ts"
        reason: "NEW: TC-1.1 (no-flag launch → one cwd-registered thread + one background instance) and TC-1.4 (shutdown flush + reattach reads every pre-shutdown event)."
      -
        path: "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        reason: "NEW: TC-1.2 (resolve existing, no second thread), TC-1.6 (all launch modes; bad/ambiguous fail loud, no thread created), TC-1.7 (cwd-scoped titled picker, empty-safe), TC-1.5 restart-risk (reattach from durable id after holder discard) + connector reload-wiring, TC-1.3 (plain-data holder across ctx replacement)."
      -
        path: "packages/pi-lhc/test/smoke/extension-load.test.ts"
        reason: "Update the Story 0 init/dispose stub block (which asserted not_implemented) to the now-real fail-closed behavior: init on a missing thread returns thread_not_found (no throw), dispose(null) is a successful no-op."
      -
        path: "packages/pi-lhc/test/red-manifest.json"
        reason: "NEW: freeze the two Story 1 Red-phase lifecycle test files for green-verify's check-test-immutability."
    tests:
      added:
        - "packages/pi-lhc/test/lifecycle/instance.test.ts: TC-1.1, TC-1.4 (2)"
        - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts: TC-1.2, TC-1.3, TC-1.5 (restart-risk), TC-1.5 (reload wiring), TC-1.6, TC-1.7 (6)"
        - "packages/lhc/test/threads-a8.test.ts: A-8 registry cwd/partial-id/ambiguous/cwd-filter/most-recent/migrate-on-read (11)"
      modified:
        - "packages/pi-lhc/test/smoke/extension-load.test.ts: init/dispose stub block rewritten to assert real fail-closed behavior (test count unchanged)"
      removed:
[]
      totalAfterStory: 27
      deltaFromPriorBaseline: 8
    gatesRun:
      -
        command: "pnpm --filter pi-lhc verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc green-verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify-all"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc exec vitest run test/lifecycle/"
        result: "pass"
      -
        command: "pnpm --filter lhc verify"
        result: "pass"
      -
        command: "pnpm --filter lhc green-verify"
        result: "fail"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "exactOptionalPropertyTypes rejected passing registryPath:undefined to LHC threads calls — added a registryArg() helper that omits the key when unset (thread-resolution.ts/picker.ts)."
        - "Partial-id prefix match would have mis-matched because thread ids contain '_' (a LIKE wildcard) — escaped LIKE metacharacters with ESCAPE '\\' and added a regression test (th% / _ must match literally)."
        - "--continue 'most recent' was non-deterministic under same-millisecond creation — changed registry ORDER BY to created_at, rowid (insertion-order tie-break) and tested last-listed == last-created."
        - "A pre-cwd (v1) registry would crash on read once selects reference cwd — made openRegistryForRead run migrations on the existing file (non-creation preserved by the existence gate) and added a v1→v2 migrate-on-read test."
        - "Story 0 smoke test asserted initInstance/disposeInstance return not_implemented, which Story 1 makes false — updated that block to assert the real fail-closed seam instead of weakening it."
      findingsSurfaced:
        - "Anti-shim verified structurally: cwd scoping is a `WHERE cwd = ?` registry query (not a post-filter over an unscoped list), and the --session path returns the registry's thread_not_found/ambiguous_thread_id without ever falling through to newThread."
        - "Plain-data rule verified: SessionState holds only {threadRef, flags, health}; the live LhcInstance is kept in the connector closure and excluded from snapshot(), so structuredClone(snapshot) succeeds even though ctx/instance carry methods."
        - "drainSettled is only ever called from instance dispose (the flush), never from session_start — the connector does not drive the queue (AC-1.1)."
    openQuestions:
      - "Exact PI launch-flag spelling for the named-session mode (parseLaunchFlags handles --session/--session=, but recon notes mention --session-id) — confirm against the real @earendil-works/pi-coding-agent dependency once it is a build dependency (pi/types.ts is currently a local declaration)."
      - "Production reload durable-id source for a no-flag session if PI fully re-creates the connector on /reload rather than preserving it: the connector-closure remembered id covers the preserved-connector case and re-derivation from process.argv covers --session/--continue/--resume; the permanent home for reload lineage is LHC thread metadata (Feature 2+). The tested reconstruction primitive (resolve-by-durable-id → reattach) is proven independent of this."
      - "Title at thread creation (epic TDQ Q4): new threads are registered with their cwd but no title yet; the picker surfaces title when present (TC-1.7 uses directly-titled threads). Title derivation (first prompt / derived / operator-set) is unresolved and deferred."
      - "Pre-existing lhc green-verify failure: packages/lhc/test/retirement.test.ts is byte-unchanged vs HEAD but its committed content already mismatches lhc/test/red-manifest.json (drift from the Epic 05 closeout), so `pnpm --filter lhc green-verify` fails at the immutability step independent of this story. lhc `verify` (build/typecheck/lint/boundaries + 388 tests) passes; I did not re-baseline another epic's frozen-test manifest."
    specDeviations:
      - "resolveThread signature: tech-design sketch `resolveThread(launch, pi: ExtensionAPI)` finalized to `resolveThread(launch, deps: {cwd, registryPath?, newThreadFilePath})` — ExtensionAPI carries neither cwd, the per-operation registryPath, nor a new-thread file path, so resolution takes injected deps (testable against a temp registry, default ~/.lhc in production)."
      - "pickThread signature: sketch `pickThread(cwd)` finalized to `pickThread(cwd, deps: {registryPath?, select})` — the bare signature could not reach a registry or an injectable/headless-safe selection; added a select callback returning the chosen id or null."
      - "--resume is routed in index.ts to picker.pickThread while resolveThread owns new/--session/--continue (clean UI-vs-registry separation), rather than resolveThread handling all four modes."
      - "Connector construction takes an injected buildSdkConfig(ctx) => OpResult<SdkConfig> (the inference seam). activate()'s default fails closed because the PI-model-registry-backed ModelCall + assignments are Stories 5/6; a live session therefore resolves nothing and records a diagnostic rather than faking, while the full lifecycle is exercised in tests with a deterministic-provider config."
      - "A-8 LHC additions land in this story's scope: `ambiguous_thread_id` added to lhc ErrorCode, and a registry v2 migration adds the cwd column with migrate-on-read for existing registries."
      - "New threads are created with cwd but without a title (title derivation deferred — TDQ Q4)."
    recommendedNextStep: "Proceed to Story 2 (Event Capture and Turn Derivation): build the converter (map-message fan-out, turn-accumulator deriving one LHC turn_end at agent_end, idempotency keys, batch flush with capture-failure isolation) on the lifecycle/instance seam landed here. Separately, when the real @earendil-works/pi-coding-agent dependency is added, confirm the launch-flag spelling and reload semantics against live PI."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/003-implementor.json"
  startedAt: "2026-06-14T04:03:16.956Z"
  finishedAt: "2026-06-14T04:43:27.516Z"
```
</history_entry>

<history_entry>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json
bytes: 11382
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "c891bb48-266b-4d91-b3d2-34803361f9ac"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ec471-43a6-7b53-a456-ef344035011d"
    continuation:
      provider: "codex"
      sessionId: "019ec471-43a6-7b53-a456-ef344035011d"
      storyId: "01-session-lifecycle-and-thread-resolution"
    mode: "initial"
    story:
      id: "01-session-lifecycle-and-thread-resolution"
      title: "Story 1: Session Lifecycle and Thread Resolution"
    artifactsRead:
      - "docs/specs/02-pi-lhc/01-connector-core/stories/01-session-lifecycle-and-thread-resolution.md"
      - "docs/specs/02-pi-lhc/01-connector-core/tech-design.md"
      - "docs/specs/02-pi-lhc/01-connector-core/test-plan.md"
      - "docs/specs/02-pi-lhc/01-connector-core/epic.md"
      - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/003-implementor.json"
      - "packages/pi-lhc/src/index.ts"
      - "packages/pi-lhc/src/lifecycle/instance.ts"
      - "packages/pi-lhc/src/lifecycle/thread-resolution.ts"
      - "packages/pi-lhc/src/lifecycle/picker.ts"
      - "packages/pi-lhc/src/lifecycle/state.ts"
      - "packages/pi-lhc/test/lifecycle/instance.test.ts"
      - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
      - "packages/pi-lhc/test/smoke/extension-load.test.ts"
      - "packages/lhc/src/domains/threads/index.ts"
      - "packages/lhc/src/domains/threads/internal/registry.ts"
      - "packages/lhc/src/shared/errors.ts"
      - "packages/lhc/test/threads-a8.test.ts"
    reviewScopeSummary: "Verified Story 1 AC-1.1 through AC-1.7 against the story, tech design, test plan, implementation, focused tests, and configured gates. The module-level lifecycle and registry tests pass, but the production entry path and reload/title requirements are not ready for handoff."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "SV-001"
        severity: "major"
        title: "Production activate path is still a placeholder lifecycle path"
        evidence: "The production entrypoint calls createConnector() with no deps at packages/pi-lhc/src/index.ts:282-283. Default buildSdkConfig is inferenceNotConfigured at lines 96-107 and wired at line 137, so session_start returns at lines 184-188 before resolving/creating any thread or initializing LHC. The default --resume selector at lines 140-141 always returns null, so production --resume cannot resolve an operator selection. Tests cover real lifecycle only by injecting buildSdkConfig/selectThread in packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:215-220 and 246-250. This leaves real app/runtime code on non-real fail-closed branches for Story 1 lifecycle behavior."
        affectedFiles:
          - "packages/pi-lhc/src/index.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.1"
          - "AC-1.2"
          - "AC-1.7"
          - "TC-1.1"
          - "TC-1.2"
          - "TC-1.7"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
      -
        id: "SV-002"
        severity: "major"
        title: "Reload reconstruction uses retained memory, not durable state after teardown"
        evidence: "AC-1.5 requires reload after extension teardown/re-initialization to reconstruct from durable resolved thread id. The implementation stores rememberedThreadId only in the createConnector closure at packages/pi-lhc/src/index.ts:132-155, then sets it at line 205. activate() creates a fresh connector on load at lines 282-283, with no durable id source. The reload test uses the same connector instance across shutdown and session_start reload at packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:246-262, so it does not prove teardown/re-initialization. With a fresh connector and no launch flag, launchFor falls back to parseLaunch at line 157 and would not know the prior thread id."
        affectedFiles:
          - "packages/pi-lhc/src/index.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.5"
          - "TC-1.5"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
      -
        id: "SV-003"
        severity: "major"
        title: "Fresh thread creation omits required title metadata"
        evidence: "Story scope requires A-8 title support and TC-1.1 requires a new registry thread with cwd/title metadata. The no-flag creation path in packages/pi-lhc/src/lifecycle/thread-resolution.ts:82-86 passes filePath and cwd to threads.newThread but no title. The lifecycle test only asserts cwd at packages/pi-lhc/test/lifecycle/instance.test.ts:48-56. The thread-resolution test comment at packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:43-45 explicitly states connector-created new threads carry no title, while direct test setup supplies titles only for picker fixtures."
        affectedFiles:
          - "packages/pi-lhc/src/lifecycle/thread-resolution.ts"
          - "packages/pi-lhc/test/lifecycle/instance.test.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.1"
          - "TC-1.1"
          - "A-8"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
    openFindings:
      -
        id: "SV-001"
        severity: "major"
        title: "Production activate path is still a placeholder lifecycle path"
        evidence: "The production entrypoint calls createConnector() with no deps at packages/pi-lhc/src/index.ts:282-283. Default buildSdkConfig is inferenceNotConfigured at lines 96-107 and wired at line 137, so session_start returns at lines 184-188 before resolving/creating any thread or initializing LHC. The default --resume selector at lines 140-141 always returns null, so production --resume cannot resolve an operator selection. Tests cover real lifecycle only by injecting buildSdkConfig/selectThread in packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:215-220 and 246-250. This leaves real app/runtime code on non-real fail-closed branches for Story 1 lifecycle behavior."
        affectedFiles:
          - "packages/pi-lhc/src/index.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.1"
          - "AC-1.2"
          - "AC-1.7"
          - "TC-1.1"
          - "TC-1.2"
          - "TC-1.7"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
      -
        id: "SV-002"
        severity: "major"
        title: "Reload reconstruction uses retained memory, not durable state after teardown"
        evidence: "AC-1.5 requires reload after extension teardown/re-initialization to reconstruct from durable resolved thread id. The implementation stores rememberedThreadId only in the createConnector closure at packages/pi-lhc/src/index.ts:132-155, then sets it at line 205. activate() creates a fresh connector on load at lines 282-283, with no durable id source. The reload test uses the same connector instance across shutdown and session_start reload at packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:246-262, so it does not prove teardown/re-initialization. With a fresh connector and no launch flag, launchFor falls back to parseLaunch at line 157 and would not know the prior thread id."
        affectedFiles:
          - "packages/pi-lhc/src/index.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.5"
          - "TC-1.5"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
      -
        id: "SV-003"
        severity: "major"
        title: "Fresh thread creation omits required title metadata"
        evidence: "Story scope requires A-8 title support and TC-1.1 requires a new registry thread with cwd/title metadata. The no-flag creation path in packages/pi-lhc/src/lifecycle/thread-resolution.ts:82-86 passes filePath and cwd to threads.newThread but no title. The lifecycle test only asserts cwd at packages/pi-lhc/test/lifecycle/instance.test.ts:48-56. The thread-resolution test comment at packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:43-45 explicitly states connector-created new threads carry no title, while direct test setup supplies titles only for picker fixtures."
        affectedFiles:
          - "packages/pi-lhc/src/lifecycle/thread-resolution.ts"
          - "packages/pi-lhc/test/lifecycle/instance.test.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.1"
          - "TC-1.1"
          - "A-8"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
    requirementCoverage:
      verified:
        - "TC-1.2 resolver-level existing-thread resolution creates no second thread: packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:81-90."
        - "TC-1.3 plain-data holder across fresh ctx objects: packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:213-239 and state shape in packages/pi-lhc/src/lifecycle/state.ts:23-42."
        - "TC-1.4 shutdown flush and reattach read-back at module level: packages/pi-lhc/test/lifecycle/instance.test.ts:73-108; dispose calls drainSettled in packages/pi-lhc/src/lifecycle/instance.ts:29-43."
        - "TC-1.6 resolver launch modes: no flag, full id, partial id, continue, bad id, ambiguous id in packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:92-130."
        - "A-8 registry cwd, partial-id resolve, ambiguous-id failure, cwd-filtered listThreads, and migration behavior: packages/lhc/test/threads-a8.test.ts:32-189."
        - "TC-1.7 picker module lists cwd-scoped titled fixture threads and empty cwd returns null: packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:132-170."
      unverified:
        - "AC-1.1/TC-1.1 production session_start creates one cwd/title thread and one background instance: blocked by SV-001 and SV-003."
        - "AC-1.2 production session_start initializes against an existing resolved thread: blocked by SV-001."
        - "AC-1.5/TC-1.5 reload after extension teardown/re-initialization reconstructs from durable resolved thread id: blocked by SV-002."
        - "AC-1.7 production --resume operator selection through activate(): blocked by SV-001."
    gatesRun:
      -
        command: "pnpm --filter pi-lhc exec vitest run test/lifecycle/instance.test.ts test/lifecycle/thread-resolution.test.ts"
        result: "pass"
      -
        command: "pnpm --filter lhc exec vitest run test/threads-a8.test.ts"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify-all"
        result: "pass"
      -
        command: "pnpm --filter lhc verify"
        result: "pass"
    productionPathFindings:
      - "packages/pi-lhc/src/index.ts production activate() uses default inferenceNotConfigured, so session_start does not create/resolve a thread or initialize LHC without test-only dependency injection."
      - "packages/pi-lhc/src/index.ts production --resume default selector returns null, so picker selection is not real in the activate path."
      - "packages/pi-lhc/src/index.ts reload reconstruction depends on closure memory rememberedThreadId, not a durable id available after extension teardown/re-initialization."
      - "packages/pi-lhc/src/lifecycle/thread-resolution.ts new-thread creation omits title metadata required by TC-1.1/A-8."
    recommendedNextStep: "revise"
    recommendedFixScope: "fresh-fix-path"
    openQuestions:
      - "Title derivation is named in the epic as a design question, but the current story and TC-1.1 require title metadata. If the implementor cannot choose an accepted creation-time title from existing design, this needs a human ruling before fixing SV-003."
    additionalObservations:
      - "Configured story and epic gates passed despite the blockers because the tests exercise injected lifecycle paths rather than the production activate defaults."
      - "No PI-session-to-thread mapping record was found in the inspected implementation; resolution uses the LHC registry."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
  startedAt: "2026-06-14T04:43:37.619Z"
  finishedAt: "2026-06-14T04:47:43.575Z"
```
</history_entry>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/010-implementor.json
bytes: 14491
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "641da93d-439c-483a-a286-4926884c92e6"
    provider: "claude-code"
    model: "claude-opus-4-8"
    role: "story_implementor"
    sessionId: "fc8b0d70-702e-4abc-9faa-dda18cc81eaf"
    continuation:
      provider: "claude-code"
      sessionId: "fc8b0d70-702e-4abc-9faa-dda18cc81eaf"
      storyId: "01-session-lifecycle-and-thread-resolution"
    outcome: "ready-for-verification"
    story:
      id: "01-session-lifecycle-and-thread-resolution"
      title: "Story 1: Session Lifecycle and Thread Resolution"
    planSummary: "Fresh consolidating implement for Story 1 (session lifecycle + launch-driven thread resolution) on the recovered on-disk code, resolving verifier findings SV-001/002/003 and the A-8 LHC registry additions the launch modes depend on. SV-001 (production placeholder): activate() now resolves/creates the thread and initializes one real background LHC instance on session_start; the --resume default selector resolves the most-recent cwd thread (not null); production-path tests (TC-1.1/1.2/1.7) drive the real defaults with only environment overrides, not an injected SDK config/selector. As the completion of SV-001 I replaced the deterministic provider in the production default config — which the LHC SDK documents as 'selectable only by explicit name — never a production default' — with a fail-closed observeOnlyProvider whose seven ops each return a non-retryable failure; it satisfies construction without fabricating derived forms, is never invoked in Story 1 (no capture and no work handlers means no derivation work is queued), and is replaced by the real PI-auth-backed inference config in Stories 5/6. SV-002 (reload durability): the resolved thread id is held at module scope so it survives the extension teardown a reload performs; the reload test now discards connector A entirely and reconstructs with a FRESH connector B from that durable id with no launch flag and no duplicate thread, a complementary test proves a non-reload teardown clears the memory (so the next no-flag session is a new thread), and the restart-risk resolver test reconstructs purely by resolving the durable id from the registry after discarding all in-memory state. SV-003 (missing title): new threads are registered with cwd plus defaultThreadTitle(cwd) (the cwd leaf), asserted in TC-1.1, a dedicated resolver test, and the reload test. A-8 LHC registry work (packages/lhc): a cwd column via registry migration v2 with migrate-on-read so a pre-cwd v1 registry upgrades lazily; partial-id (prefix) resolve with exact-match-wins, ambiguous_thread_id on >1 and thread_not_found on 0 (never creates); LIKE-metacharacter escaping so '_'/'%' in ids match literally; a cwd filter enforced as the SQL WHERE clause (anti-shim, not a post-filter); and deterministic ORDER BY created_at, rowid for most-recent. The connector retains only plain-data SessionState plus the live LhcInstance (held in the closure, excluded from the snapshot); drainSettled is called only from dispose (the flush), never from session_start, so the connector never drives the queue."
    changedFiles:
      -
        path: "packages/lhc/src/shared/errors.ts"
        reason: "Add the ambiguous_thread_id caller-error code for A-8 partial-id resolve ambiguity."
      -
        path: "packages/lhc/src/domains/threads/internal/registry.ts"
        reason: "A-8: cwd column via registry migration v2; migrate-on-read in openRegistryForRead so a pre-cwd v1 registry upgrades on open; cwd in the row type/insert/selects; selectThreadRowsByPrefix (LIKE-metachar-escaped, ESCAPE '\\\\') for partial-id; cwd-filter parameter on selectAllThreadRows enforced as a WHERE clause; deterministic ORDER BY created_at, rowid."
      -
        path: "packages/lhc/src/domains/threads/index.ts"
        reason: "A-8: NewThreadInput.cwd + ThreadInfo.cwd stored/returned; resolve does exact-then-prefix matching (ambiguous_thread_id on >1, thread_not_found on 0, never creates); cwd filter on listThreads."
      -
        path: "packages/lhc/test/threads-a8.test.ts"
        reason: "NEW: 11 registry-boundary tests for A-8 (cwd round-trip, no-cwd undefined, unique/ambiguous/absent partial-id, LIKE-metachar literal match, cwd-scoped list, empty cwd, most-recent ordering, v1->v2 migrate-on-read)."
      -
        path: "packages/pi-lhc/src/lifecycle/instance.ts"
        reason: "Implement initInstance (validate the thread via threads.info, force mode:background, wrap with a flush-on-dispose seam) and disposeInstance (null-safe no-op); dispose flushes via sdk.drainSettled (AC-1.1, AC-1.4, AC-1.5)."
      -
        path: "packages/pi-lhc/src/lifecycle/thread-resolution.ts"
        reason: "Implement resolveThread (no-flag new with cwd+defaultThreadTitle title [SV-003], --session full+partial, --continue most-recent; unresolvable/ambiguous return the registry error, never a silent new thread), defaultThreadTitle, parseLaunchFlags(argv), and threadRefById/registryArg helpers (AC-1.2, AC-1.5, AC-1.6)."
      -
        path: "packages/pi-lhc/src/lifecycle/picker.ts"
        reason: "Implement pickThread: cwd-scoped listThreads (the scope is the registry query, anti-shim) -> title+created choices -> injected selection -> resolve; empty cwd and cancellation return null without failing (AC-1.7)."
      -
        path: "packages/pi-lhc/src/index.ts"
        reason: "Connector wiring: session_start -> resolveForLaunch -> initInstance (real production defaults); session_before_switch/session_shutdown -> dispose(flush); reload reconstructs from the module-scope durable thread id (survives connector teardown), cleared on non-reload teardown. Replaced the deterministic provider in the production default config with a fail-closed observeOnlyProvider (SV-001 completion); --resume default selector resolves most-recent; plain-data snapshot + getInstance test seam."
      -
        path: "packages/pi-lhc/test/lifecycle/instance.test.ts"
        reason: "NEW: TC-1.1 (no-flag session_start with production defaults creates one cwd/title thread + one background instance, queue not driven) and TC-1.4 (shutdown flush + reattach reads every pre-shutdown event)."
      -
        path: "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        reason: "NEW: TC-1.6 (all launch modes; bad/ambiguous fail loud, no thread created), parseLaunchFlags mapping, no-flag title, TC-1.7 picker (cwd-scoped/titled/empty-safe), TC-1.5 restart-risk (resolve-by-durable-id after full discard), TC-1.2/1.7 production connector path, TC-1.3 plain-data across ctx replacement, and the reload-after-teardown pair (fresh connector reconstructs; non-reload teardown clears memory)."
      -
        path: "packages/pi-lhc/test/smoke/extension-load.test.ts"
        reason: "Update the Story 0 init/dispose stub block to the now-real fail-closed seam: init on a missing thread returns thread_not_found (no throw); dispose(null) is a successful no-op. Plain-data and hook-rail smoke unchanged."
      -
        path: "packages/pi-lhc/test/red-manifest.json"
        reason: "NEW: freeze the two Story 1 Red-phase lifecycle test files for green-verify's check-test-immutability."
    tests:
      added:
        - "packages/pi-lhc/test/lifecycle/instance.test.ts: TC-1.1, TC-1.4 (2 cases)"
        - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts: TC-1.6, parseLaunchFlags, no-flag-title, TC-1.7 (picker), TC-1.5 (restart-risk), TC-1.2, TC-1.7 (production), TC-1.3, TC-1.5 (reload fresh-connector), non-reload-clears (10 cases)"
        - "packages/lhc/test/threads-a8.test.ts: A-8 cwd/partial-id/ambiguity/LIKE-escaping/cwd-scoped-list/most-recent/migrate-on-read (11 cases)"
      modified:
        - "packages/pi-lhc/test/smoke/extension-load.test.ts: init/dispose stub block rewritten to assert the real fail-closed seam (case count unchanged)"
      removed:
[]
      totalAfterStory: 384
      deltaFromPriorBaseline: 3
    gatesRun:
      -
        command: "pnpm --filter pi-lhc verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc green-verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify-all"
        result: "pass"
      -
        command: "pnpm --filter lhc verify"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "SV-001 (production path placeholder): activate()'s production default is a real construction-valid SDK config and session_start resolves/creates the thread and initializes a real background instance; the --resume default selector resolves the most-recent cwd thread instead of null; TC-1.1/1.2/1.7 exercise the real defaults with only environment overrides, not an injected SDK config or selector."
        - "SV-001 completion: replaced createDeterministicProvider() in the production default — which lhc documents as 'never a production default' — with a fail-closed observeOnlyProvider (seven ops each return {ok:false, retryable:false}); it satisfies construction without fabricating derived forms and is never invoked in Story 1 (no capture and an empty work-handler map mean no derivation work is queued)."
        - "SV-002 (reload durability): the resolved thread id is held at module scope so it survives the connector teardown a reload performs; the reload test now discards connector A and reconstructs with a FRESH connector B (no flag, no duplicate); a complementary test proves a non-reload teardown clears the memory; the restart-risk resolver test reconstructs purely by resolving the durable id from the registry after discarding all in-memory state."
        - "SV-003 (missing title): new threads are registered with cwd plus defaultThreadTitle(cwd) (the cwd leaf), asserted in TC-1.1, a dedicated resolver test, and the reload test."
      findingsSurfaced:
        - "Anti-shim verified structurally: cwd scoping is a registry WHERE cwd = ? query (not a post-filter over an unscoped list), and the --session path returns the registry's thread_not_found/ambiguous_thread_id rather than ever falling through to newThread."
        - "Plain-data rule verified: SessionState holds only { threadRef, flags, health }; the live LhcInstance is held in the connector closure and excluded from snapshot(), so structuredClone(snapshot()) succeeds even though ctx/instance carry methods."
        - "observe-only preserved: with the fail-closed provider, no work handlers, and no capture in Story 1, the provider is never invoked, so no fabricated derivations can land; if a future change queued work before Stories 5/6 the provider fails closed rather than fabricating."
        - "drainSettled is called only from instance dispose (the flush), never from session_start, so the connector never drives the derivation queue (AC-1.1)."
    openQuestions:
      - "Exact PI launch-flag spelling for the named-session mode: parseLaunchFlags handles --session/--session=, but recon notes mention --session-id; confirm against the real @earendil-works/pi-coding-agent dependency when it becomes a build dep (pi/types.ts is currently a local declaration)."
      - "Production reload durable-id source: the module-scope id covers in-process reload (extension torn down, same process); --session/--continue/--resume re-resolve from the launch across process death; a no-flag session that suffers true process death relies on the launch re-resolving (most-recent is not guaranteed identical). The permanent home for reload lineage is LHC thread metadata (Feature 2+)."
      - "Title derivation strategy (TDQ Q4): new threads use the cwd leaf as an interim, real, non-empty title; prompt-derived or operator-set titles are deferred."
      - "Interactive --resume operator picker awaits a PI input surface beyond ui.notify (verified v0.79.2 exposes only notify); the production default auto-resumes the most-recent cwd thread, and tests drive an explicit selection through the injected selector."
    specDeviations:
      - "Local PI extension types in src/pi/types.ts (Story 0 accepted-risk, inherited): @earendil-works/pi-coding-agent and pi-ai are not yet build dependencies, so the connector declares the slice of the v0.79.2 contract it touches; reversible to the real imports when the dependency lands."
      - "initLhc is a thin wrapper over LHC's createSdk (Story 0 accepted, spec-anticipated by tech-arch A-4 / tech-design Q2; mechanical)."
      - "resolveThread/pickThread signatures finalized to take injected deps ({ cwd, registryPath?, newThreadFilePath, newThreadTitle? } / { registryPath?, select }) rather than the interface sketch's (launch, pi: ExtensionAPI) / (cwd): ExtensionAPI carries neither cwd, the per-operation registryPath, a new-thread file path, nor a selection surface, so resolution takes injected deps (testable against a temp registry, defaulting to ~/.lhc in production)."
      - "--resume is routed in index.ts to picker.pickThread while resolveThread owns new/--session/--continue (a UI-vs-registry separation), rather than resolveThread handling all four modes as the sketch implied."
      - "Story-1 production inference is a fail-closed observeOnlyProvider placeholder — NOT the deterministic provider (lhc: 'never a production default') and NOT the real inference config. The real PI-model-registry-backed inference (ModelCall + the seven assignments) is Stories 5/6, and @earendil-works/pi-ai is not yet a build dependency."
      - "New threads are created with cwd plus a default title equal to the cwd leaf directory name; prompt-derived/operator-set title derivation is deferred (TDQ Q4)."
      - "A-8 LHC additions land in this story's scope (spec-anticipated by the story's Scope In and tech-design): ambiguous_thread_id added to the lhc ErrorCode set, and a registry v2 migration adds the cwd column with migrate-on-read for existing registries."
      - "The production --resume selector auto-resumes the most-recent cwd thread rather than presenting an interactive operator picker, because the locally-typed PI UI surface exposes only ui.notify; the picker machinery (cwd-scoped, titled, empty-safe, selection-resolving) is real and tested via an injected selection."
    recommendedNextStep: "Proceed to Story 2 (Event Capture and Turn Derivation): build the converter (map-message fan-out, turn-accumulator deriving one LHC turn_end at agent_end, idempotency keys, batch flush with capture-failure isolation) on the lifecycle/instance seam landed here. Separately, when @earendil-works/pi-coding-agent + pi-ai become build dependencies, confirm the launch-flag spelling and reload semantics against live PI and replace the observeOnlyProvider placeholder with the real inference config in Stories 5/6."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/010-implementor.json"
  startedAt: "2026-06-14T05:23:10.925Z"
  finishedAt: "2026-06-14T05:37:40.607Z"
```
</history_entry>

<history_entry>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json
bytes: 9195
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "06499a80-e6d8-4ac6-885e-4687e5680206"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ec4a2-e6a9-7261-a8a1-c863991dc47a"
    continuation:
      provider: "codex"
      sessionId: "019ec4a2-e6a9-7261-a8a1-c863991dc47a"
      storyId: "01-session-lifecycle-and-thread-resolution"
    mode: "initial"
    story:
      id: "01-session-lifecycle-and-thread-resolution"
      title: "Story 1: Session Lifecycle and Thread Resolution"
    artifactsRead:
      - "docs/specs/02-pi-lhc/01-connector-core/stories/01-session-lifecycle-and-thread-resolution.md"
      - "docs/specs/02-pi-lhc/01-connector-core/tech-design.md"
      - "docs/specs/02-pi-lhc/01-connector-core/test-plan.md"
      - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/010-implementor.json"
      - "packages/pi-lhc/src/index.ts"
      - "packages/pi-lhc/src/lifecycle/instance.ts"
      - "packages/pi-lhc/src/lifecycle/thread-resolution.ts"
      - "packages/pi-lhc/src/lifecycle/picker.ts"
      - "packages/pi-lhc/src/lifecycle/state.ts"
      - "packages/pi-lhc/src/pi/types.ts"
      - "packages/pi-lhc/test/lifecycle/instance.test.ts"
      - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
      - "packages/pi-lhc/package.json"
      - "packages/lhc/src/domains/threads/index.ts"
      - "packages/lhc/src/domains/threads/internal/registry.ts"
      - "packages/lhc/test/threads-a8.test.ts"
    reviewScopeSummary: "Verified Story 1 AC/TC coverage against the story, tech design, test plan, pi-lhc lifecycle implementation, LHC A-8 registry changes, lifecycle tests, A-8 registry tests, and configured gates. The gates pass, but two blocking production-path requirements remain unmet."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "SV-001"
        severity: "major"
        title: "Reload reconstruction uses module memory instead of durable state"
        evidence: "AC-1.5 requires reload reconstruction from durable state, not retained in-memory objects (story lines 51-53). The implementation stores the current thread id in module scope at packages/pi-lhc/src/index.ts:165-173, sets it on session_start at index.ts:260-262, keeps it across reload at index.ts:270-275, and reconstructs only if that variable is still populated at index.ts:210-214. The comments explicitly state it is in-process only and not a durable file at index.ts:169-171. The reload test at packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:300-330 creates a fresh connector but keeps the same module instance, so it does not prove durable reload reconstruction after module re-import or loss of module memory."
        affectedFiles:
          - "packages/pi-lhc/src/index.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.5"
          - "TC-1.5"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
      -
        id: "SV-002"
        severity: "major"
        title: "Production --resume bypasses operator selection"
        evidence: "AC-1.7 requires --resume/-r to list cwd-scoped threads with title and creation time and resolve the operator's selection (story lines 59-61; tech design lines 231 and 251-253). The production default selector at packages/pi-lhc/src/index.ts:140-148 automatically returns the most recent choice and the comment says an interactive picker awaits a PI input surface. The production connector test at packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:254-267 asserts this most-recent behavior rather than an operator-visible selection. The lower-level pickThread path supports an injected selector, but activate()/default production behavior does not satisfy the operator picker requirement."
        affectedFiles:
          - "packages/pi-lhc/src/index.ts"
          - "packages/pi-lhc/src/lifecycle/picker.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.7"
          - "TC-1.7"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
    openFindings:
      -
        id: "SV-001"
        severity: "major"
        title: "Reload reconstruction uses module memory instead of durable state"
        evidence: "AC-1.5 requires reload reconstruction from durable state, not retained in-memory objects (story lines 51-53). The implementation stores the current thread id in module scope at packages/pi-lhc/src/index.ts:165-173, sets it on session_start at index.ts:260-262, keeps it across reload at index.ts:270-275, and reconstructs only if that variable is still populated at index.ts:210-214. The comments explicitly state it is in-process only and not a durable file at index.ts:169-171. The reload test at packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:300-330 creates a fresh connector but keeps the same module instance, so it does not prove durable reload reconstruction after module re-import or loss of module memory."
        affectedFiles:
          - "packages/pi-lhc/src/index.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.5"
          - "TC-1.5"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
      -
        id: "SV-002"
        severity: "major"
        title: "Production --resume bypasses operator selection"
        evidence: "AC-1.7 requires --resume/-r to list cwd-scoped threads with title and creation time and resolve the operator's selection (story lines 59-61; tech design lines 231 and 251-253). The production default selector at packages/pi-lhc/src/index.ts:140-148 automatically returns the most recent choice and the comment says an interactive picker awaits a PI input surface. The production connector test at packages/pi-lhc/test/lifecycle/thread-resolution.test.ts:254-267 asserts this most-recent behavior rather than an operator-visible selection. The lower-level pickThread path supports an injected selector, but activate()/default production behavior does not satisfy the operator picker requirement."
        affectedFiles:
          - "packages/pi-lhc/src/index.ts"
          - "packages/pi-lhc/src/lifecycle/picker.ts"
          - "packages/pi-lhc/test/lifecycle/thread-resolution.test.ts"
        requirementIds:
          - "AC-1.7"
          - "TC-1.7"
        recommendedFixScope: "fresh-fix-path"
        blocking: true
    requirementCoverage:
      verified:
        - "AC-1.1 / TC-1.1: no-flag session_start creates one cwd/title registry thread and one background LHC instance; verified by packages/pi-lhc/test/lifecycle/instance.test.ts and pi-lhc verify."
        - "AC-1.2 / TC-1.2: existing --session launch attaches to the existing thread and creates no second thread; verified by packages/pi-lhc/test/lifecycle/thread-resolution.test.ts."
        - "AC-1.3 / TC-1.3 plain-data rule: SessionState contains threadRef/flags/health only and connector snapshot structuredClone succeeds across fresh ctx objects; verified by source and test."
        - "AC-1.4 / TC-1.4: shutdown dispose flush preserves all pre-shutdown intake events across re-resolve; verified by packages/pi-lhc/test/lifecycle/instance.test.ts."
        - "AC-1.6 / TC-1.6: no flag, full id, partial id, continue, bad id, and ambiguous id resolve/fail as specified with no silent creation; verified by packages/pi-lhc/test/lifecycle/thread-resolution.test.ts."
        - "A-8 registry scope: cwd, title, partial-id resolve, cwd-filtered listThreads, most-recent ordering, and lazy migration are implemented in packages/lhc/src/domains/threads and verified by packages/lhc/test/threads-a8.test.ts."
      unverified:
        - "AC-1.5 / TC-1.5 production reload durable-state reconstruction: current proof depends on module-scope memory, not durable state."
        - "AC-1.7 / TC-1.7 production operator picker: current production path auto-selects the most recent cwd thread instead of resolving an operator selection."
    gatesRun:
      -
        command: "pnpm --filter pi-lhc verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify-all"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc exec vitest run test/lifecycle/instance.test.ts test/lifecycle/thread-resolution.test.ts"
        result: "pass"
      -
        command: "pnpm --filter lhc exec vitest run test/threads-a8.test.ts"
        result: "pass"
    productionPathFindings:
      - "packages/pi-lhc/src/index.ts uses module-scope rememberedSessionThreadId as the reload handoff; this is retained in-process state, not durable state."
      - "packages/pi-lhc/src/index.ts production --resume default selector automatically resumes the most recent cwd thread; it does not present the cwd-scoped title/created list for operator selection."
    recommendedNextStep: "revise"
    recommendedFixScope: "fresh-fix-path"
    openQuestions:
      - "Which durable reload handoff source should replace module memory while still avoiding a PI-session-to-thread mapping record?"
      - "Which PI selection surface should production --resume use for the operator picker, since the local ExtensionUI type currently exposes only notify?"
    additionalObservations:
      - "The configured story and epic gates passed; the revise decision is based on unmet AC evidence, not gate failure."
      - "The fail-closed observeOnlyProvider in packages/pi-lhc/src/index.ts:100-137 was reviewed during the production-path audit; I did not file it as a Story 1 blocker because Story 1 production hooks do not queue derivation work."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
  startedAt: "2026-06-14T05:37:50.618Z"
  finishedAt: "2026-06-14T05:42:29.123Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-current.json
Bytes: 10137

```yaml
storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
storyId: "01-session-lifecycle-and-thread-resolution"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration resume requested and durable state has been reopened."
currentPhase: "story-orchestrate-resume"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
    provenance: "current-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-final-package.json"
    provenance: "current-run"
  -
    kind: "review-request"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-review-request-001.json"
    provenance: "caller-input"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/010-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
    provenance: "current-run"
  -
    kind: "review-request"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-review-request-002.json"
    provenance: "caller-input"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/013-continue.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "fc8b0d70-702e-4abc-9faa-dda18cc81eaf"
    storyId: "01-session-lifecycle-and-thread-resolution"
  storyVerifier:
    provider: "codex"
    sessionId: "019ec4a2-e6a9-7261-a8a1-c863991dc47a"
    storyId: "01-session-lifecycle-and-thread-resolution"
latestEventSequence: 41
callerInputHistory:
  reviewRequests:
    -
      source: "impl-lead (Claude Code orchestrator) — maintainer recovery"
      decision: "reopen"
      summary: "The retained implementor session (claude-code 3bd99b80-3187-4d52-9c3e-b6b2c0cfc11e) is broken: two consecutive story-continue attempts on it failed — first a >10min silence-timeout stall (process killed), then PROVIDER_OUTPUT_INVALID from a truncated stream when the stale session was stopped mid-output. Resuming that session is not recoverable. DIRECTIVE: do NOT run-continue / do NOT resume that implementor session. Start a FRESH implementor pass (run-implement, new session) that re-hydrates from the spec pack and the on-disk Story 1 code — which is already substantial and compiling (packages/pi-lhc/src/lifecycle/instance.ts, thread-resolution.ts, picker.ts; index.ts hook wiring; and the A-8 LHC registry changes in packages/lhc/src/domains/threads/{index.ts,internal/registry.ts}). Build on that on-disk code, do not discard it, and resolve the three open verifier findings below. Implementor silence timeout has been raised to 20 minutes."
      items:
        -
          id: "RECOVERY-FRESH-SESSION"
          severity: "blocker"
          concern: "Retained implementor session 3bd99b80 cannot be resumed (2 failed continues: silence stall + PROVIDER_OUTPUT_INVALID)."
          requiredResponse: "Begin a fresh implementor pass (run-implement, new session) instead of run-continue; re-hydrate from the spec pack and on-disk code rather than resuming the dead session."
          evidence:
            - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/007-continue.json"
        -
          id: "SV-001"
          severity: "major"
          concern: "Production activate path is still a placeholder lifecycle path."
          requiredResponse: "Wire the real production activate()/hook-registration lifecycle so the production entrypoint exercises instance init/dispose and capture, not only tests."
          evidence:
            - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
        -
          id: "SV-002"
          severity: "major"
          concern: "Reload reconstruction uses retained in-memory state, not durable state after teardown (violates AC-1.5)."
          requiredResponse: "On reload, reconstruct the thread reference from the durable resolved thread id via the registry, not from retained in-memory objects, per AC-1.5 / AC-1.3."
          evidence:
            - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
        -
          id: "SV-003"
          severity: "major"
          concern: "Fresh thread creation omits required title metadata."
          requiredResponse: "Populate the registry title on newThread at fresh-thread creation, per AC-1.1 and the cwd-scoped titled picker (AC-1.7)."
          evidence:
            - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
      evidence:
        - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
    -
      source: "impl-lead (Claude Code orchestrator)"
      decision: "revise"
      summary: "Two open verifier revise findings remain in packages/pi-lhc/src/index.ts (verifier 011-verify.json). Address them via a story-continue on the CURRENT HEALTHY implementor session (claude-code fc8b0d70-702e-4abc-9faa-dda18cc81eaf) — do NOT resume the old broken session 3bd99b80. SV-003 (title metadata) and the prior placeholder-activate path are already resolved; do not regress them. The A-8 LHC registry changes and lhc threads-a8 test pass — keep them."
      items:
        -
          id: "SV-001"
          severity: "major"
          concern: "Reload reconstruction uses module-scope rememberedSessionThreadId (retained in-process state), not durable state — violates AC-1.5 and fails the tech-design architecture-risk test."
          requiredResponse: "Make reload reconstruct the thread by RE-RESOLVING from the durable registry, not from in-process module memory. Satisfy the architecture-risk test: after discarding the in-memory holder, the same thread is re-resolved by its id from the registry (re-applying launch resolution / most-recent-cwd) and capture continues on it. Remove reliance on module-scope memory for the reload handoff."
          evidence:
            - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
        -
          id: "SV-002"
          severity: "major"
          concern: "Production --resume auto-resumes the most-recent cwd thread instead of presenting the cwd-scoped titled list for operator selection (AC-1.7)."
          requiredResponse: "Wire index.ts --resume to picker.pickThread so the cwd-scoped, title+created candidate list is presented and the operator's selection is resolved. IMPORTANT CONSTRAINT: the verified wiring research (notes/pi-ext-integration-research.md) found PI v0.79.2 exposes ctx.ui.notify (output) but NO interactive input/selection surface. If a true interactive selection surface is genuinely unavailable, do NOT silently bypass AC-1.7: present the cwd-scoped titled candidate list via ctx.ui.notify (guarded on ctx.hasUI), resolve selection through the best available mechanism, AND record this precisely as an explicit spec-deviation (parallel to the approved local-PI-types deviation) stating exactly which interactive capability PI lacks and the chosen Epic-1 behavior — so it is a declared, ruleable deviation, never a silent AC violation. Keep picker.ts cwd-scoped/titled/selection-injectable."
          evidence:
            - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
            - "docs/specs/02-pi-lhc/notes/pi-ext-integration-research.md"
      evidence:
        - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
  rulings:
[]
nextIntent:
  actionType: "resume-attempt"
  summary: "Continue the existing durable story-lead attempt from its latest checkpoint."
replayBoundary: null
updatedAt: "2026-06-14T06:05:33.902Z"
```

## Caller Input Artifacts

### review-request
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-review-request-001.json
Bytes: 3216

```yaml
source: "impl-lead (Claude Code orchestrator) — maintainer recovery"
decision: "reopen"
summary: "The retained implementor session (claude-code 3bd99b80-3187-4d52-9c3e-b6b2c0cfc11e) is broken: two consecutive story-continue attempts on it failed — first a >10min silence-timeout stall (process killed), then PROVIDER_OUTPUT_INVALID from a truncated stream when the stale session was stopped mid-output. Resuming that session is not recoverable. DIRECTIVE: do NOT run-continue / do NOT resume that implementor session. Start a FRESH implementor pass (run-implement, new session) that re-hydrates from the spec pack and the on-disk Story 1 code — which is already substantial and compiling (packages/pi-lhc/src/lifecycle/instance.ts, thread-resolution.ts, picker.ts; index.ts hook wiring; and the A-8 LHC registry changes in packages/lhc/src/domains/threads/{index.ts,internal/registry.ts}). Build on that on-disk code, do not discard it, and resolve the three open verifier findings below. Implementor silence timeout has been raised to 20 minutes."
items:
  -
    id: "RECOVERY-FRESH-SESSION"
    severity: "blocker"
    concern: "Retained implementor session 3bd99b80 cannot be resumed (2 failed continues: silence stall + PROVIDER_OUTPUT_INVALID)."
    requiredResponse: "Begin a fresh implementor pass (run-implement, new session) instead of run-continue; re-hydrate from the spec pack and on-disk code rather than resuming the dead session."
    evidence:
      - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/007-continue.json"
  -
    id: "SV-001"
    severity: "major"
    concern: "Production activate path is still a placeholder lifecycle path."
    requiredResponse: "Wire the real production activate()/hook-registration lifecycle so the production entrypoint exercises instance init/dispose and capture, not only tests."
    evidence:
      - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
  -
    id: "SV-002"
    severity: "major"
    concern: "Reload reconstruction uses retained in-memory state, not durable state after teardown (violates AC-1.5)."
    requiredResponse: "On reload, reconstruct the thread reference from the durable resolved thread id via the registry, not from retained in-memory objects, per AC-1.5 / AC-1.3."
    evidence:
      - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
  -
    id: "SV-003"
    severity: "major"
    concern: "Fresh thread creation omits required title metadata."
    requiredResponse: "Populate the registry title on newThread at fresh-thread creation, per AC-1.1 and the cwd-scoped titled picker (AC-1.7)."
    evidence:
      - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
evidence:
  - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
```

### review-request
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-review-request-002.json
Bytes: 2895

```yaml
source: "impl-lead (Claude Code orchestrator)"
decision: "revise"
summary: "Two open verifier revise findings remain in packages/pi-lhc/src/index.ts (verifier 011-verify.json). Address them via a story-continue on the CURRENT HEALTHY implementor session (claude-code fc8b0d70-702e-4abc-9faa-dda18cc81eaf) — do NOT resume the old broken session 3bd99b80. SV-003 (title metadata) and the prior placeholder-activate path are already resolved; do not regress them. The A-8 LHC registry changes and lhc threads-a8 test pass — keep them."
items:
  -
    id: "SV-001"
    severity: "major"
    concern: "Reload reconstruction uses module-scope rememberedSessionThreadId (retained in-process state), not durable state — violates AC-1.5 and fails the tech-design architecture-risk test."
    requiredResponse: "Make reload reconstruct the thread by RE-RESOLVING from the durable registry, not from in-process module memory. Satisfy the architecture-risk test: after discarding the in-memory holder, the same thread is re-resolved by its id from the registry (re-applying launch resolution / most-recent-cwd) and capture continues on it. Remove reliance on module-scope memory for the reload handoff."
    evidence:
      - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
  -
    id: "SV-002"
    severity: "major"
    concern: "Production --resume auto-resumes the most-recent cwd thread instead of presenting the cwd-scoped titled list for operator selection (AC-1.7)."
    requiredResponse: "Wire index.ts --resume to picker.pickThread so the cwd-scoped, title+created candidate list is presented and the operator's selection is resolved. IMPORTANT CONSTRAINT: the verified wiring research (notes/pi-ext-integration-research.md) found PI v0.79.2 exposes ctx.ui.notify (output) but NO interactive input/selection surface. If a true interactive selection surface is genuinely unavailable, do NOT silently bypass AC-1.7: present the cwd-scoped titled candidate list via ctx.ui.notify (guarded on ctx.hasUI), resolve selection through the best available mechanism, AND record this precisely as an explicit spec-deviation (parallel to the approved local-PI-types deviation) stating exactly which interactive capability PI lacks and the chosen Epic-1 behavior — so it is a declared, ruleable deviation, never a silent AC violation. Keep picker.ts cwd-scoped/titled/selection-injectable."
    evidence:
      - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
      - "docs/specs/02-pi-lhc/notes/pi-ext-integration-research.md"
evidence:
  - "docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
```

## Prior Self Notes
Latest note highlight: After revised implementation returns, run verifier against the new implementor artifact; accept only on verifier pass with no open findings and story gate evidence.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-14T04:03:16.919Z; note="After implementation returns, verify evidence must include targeted lifecycle tests and whether the story gate still needs a separate run."
- sequence=8; actionSequence=7; createdAt=2026-06-14T04:43:37.581Z; note="After verifier returns, accept only if verifier outcome is pass, no open findings remain, and Story 1 required gate evidence is complete."
- sequence=12; actionSequence=11; createdAt=2026-06-14T04:47:54.598Z; note="After revised implementation returns, run verifier again against the new implementor artifact and accept only on pass with no open findings."
- sequence=18; actionSequence=17; createdAt=2026-06-14T05:12:55.120Z; note="After revised implementation returns, run verifier against the new implementor artifact and accept only on pass with no open findings."
- sequence=25; actionSequence=24; createdAt=2026-06-14T05:23:10.890Z; note="After the fresh implementor result returns, run verifier against the new implementor artifact and accept only on pass with no open findings."
- sequence=29; actionSequence=28; createdAt=2026-06-14T05:37:50.583Z; note="After verifier returns, accept only on pass with no open findings and sufficient story gate evidence; otherwise route the smallest concrete follow-up."
- sequence=38; actionSequence=37; createdAt=2026-06-14T05:48:04.766Z; note="After revised implementation returns, run verifier against the new implementor artifact; accept only on verifier pass with no open findings and story gate evidence."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-events.jsonl
Bytes: 30158

```yaml
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 1
  timestamp: "2026-06-14T04:03:06.166Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 2
  timestamp: "2026-06-14T04:03:16.898Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ec44c-29c0-79c0-be68-7dbbec44835f"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 3
  timestamp: "2026-06-14T04:03:16.918Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, verify evidence must include targeted lifecycle tests and whether the story gate still needs a separate run."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 4
  timestamp: "2026-06-14T04:03:16.919Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, verify evidence must include targeted lifecycle tests and whether the story gate still needs a separate run."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 5
  timestamp: "2026-06-14T04:43:27.526Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 6
  timestamp: "2026-06-14T04:43:37.554Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ec471-1c36-7b02-8ae0-04c682e27186"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 7
  timestamp: "2026-06-14T04:43:37.580Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
    selfNote: "After verifier returns, accept only if verifier outcome is pass, no open findings remain, and Story 1 required gate evidence is complete."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 8
  timestamp: "2026-06-14T04:43:37.581Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After verifier returns, accept only if verifier outcome is pass, no open findings remain, and Story 1 required gate evidence is complete."
    actionSequence: 7
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 9
  timestamp: "2026-06-14T04:47:43.584Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
    status: "ok"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 10
  timestamp: "2026-06-14T04:47:54.576Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019ec475-047f-7930-87a3-9d051795bf5a"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 11
  timestamp: "2026-06-14T04:47:54.598Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-continue."
  data:
    actionType: "run-continue"
    turn: 3
    selfNote: "After revised implementation returns, run verifier again against the new implementor artifact and accept only on pass with no open findings."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 12
  timestamp: "2026-06-14T04:47:54.598Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After revised implementation returns, run verifier again against the new implementor artifact and accept only on pass with no open findings."
    actionSequence: 11
    actionType: "run-continue"
    turn: 3
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 13
  timestamp: "2026-06-14T05:10:39.662Z"
  type: "child-process-stopped"
  summary: "Stopped stale story-continue provider process 56708 after interruption handling."
  data:
    storyId: "01-session-lifecycle-and-thread-resolution"
    storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
    command: "story-continue"
    artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/005-continue.json"
    statusArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/progress/005-continue.status.json"
    cleanedUpAt: "2026-06-14T05:10:39.661Z"
    provider: "claude-code"
    pid: 56708
    streamPaths:
      stdoutPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/streams/005-continue.stdout.log"
      stderrPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/streams/005-continue.stderr.log"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 14
  timestamp: "2026-06-14T05:10:39.672Z"
  type: "child-operation-failed"
  summary: "story-continue returned a failed runtime envelope before producing a recoverable child result."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-current-attempt"
      reasoning: "The attempt was interrupted and recorded a terminal recovery package, so the safest replay point is the current durable story-run snapshot."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/001-story-validate.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/003-implementor.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: false
    command: "story-continue"
    outcome: "blocked"
    status: "blocked"
    errors:
      -
        code: "PROVIDER_OUTPUT_INVALID"
        message: "Provider output was invalid for claude-code."
        detail: "Provider stdout was not exact JSON.; raw stdout bytes=1700504; raw stdout preview=\"{\\\"type\\\":\\\"system\\\",\\\"subtype\\\":\\\"init\\\",\\\"cwd\\\":\\\"/Users/leemoore/code/pi-long-horizon/liminal-context\\\",\\\"session_id\\\":\\\"3bd99b80-3187-4d52-9c3e-b6b2c0cfc11e\\\",\\\"tools\\\":[\\\"Task\\\",\\\"AskUserQuestion\\\",\\\"Bash\\\",\\\"CronCreate\\\",\\\"CronDelete\\\",\\\"CronList\\\",\\\"DesignSync\\\",\\\"Edit\\\",\\\"EnterPlanMode\\\",\\\"EnterWorktree\\\",\\\"ExitPlanMode\\\",\\\"ExitWorktree\\\",\\\"Monitor\\\",\\\"NotebookEdit\\\",\\\"PushNotification\\\",\\\"Read\\\",\\\"RemoteTrigger\\\",\\\"ScheduleWakeup\\\",\\\"Skill\\\",\\\"TaskCreate\\\",\\\"TaskGet\\\",\\\"TaskList\\\",\\\"TaskOutput\\\",\\\"TaskStop\\\",\\\"TaskUpdate\\\",\\\"ToolSearch\\\",\\\"WebFetch\\\",\\\"WebSe...[truncated]\"; stdout log=/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/streams/005-continue.stdout.log; stderr log=/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/streams/005-continue.stderr.log"
    artifactPaths:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/005-continue.json"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 15
  timestamp: "2026-06-14T05:12:44.319Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 16
  timestamp: "2026-06-14T05:12:55.093Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/prompts/001-planner-turn-004.md"
    sessionId: "019ec48b-eabe-7de3-85c5-2641efaaf648"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 17
  timestamp: "2026-06-14T05:12:55.119Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-continue."
  data:
    actionType: "run-continue"
    turn: 1
    selfNote: "After revised implementation returns, run verifier against the new implementor artifact and accept only on pass with no open findings."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 18
  timestamp: "2026-06-14T05:12:55.120Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After revised implementation returns, run verifier against the new implementor artifact and accept only on pass with no open findings."
    actionSequence: 17
    actionType: "run-continue"
    turn: 1
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 19
  timestamp: "2026-06-14T05:15:12.500Z"
  type: "child-process-stopped"
  summary: "Stopped stale story-continue provider process 86261 after interruption handling."
  data:
    storyId: "01-session-lifecycle-and-thread-resolution"
    storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
    command: "story-continue"
    artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/007-continue.json"
    statusArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/progress/007-continue.status.json"
    cleanedUpAt: "2026-06-14T05:15:12.500Z"
    provider: "claude-code"
    pid: 86261
    streamPaths:
      stdoutPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/streams/007-continue.stdout.log"
      stderrPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/streams/007-continue.stderr.log"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 20
  timestamp: "2026-06-14T05:15:12.509Z"
  type: "child-operation-failed"
  summary: "story-continue returned a failed runtime envelope before producing a recoverable child result."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-current-attempt"
      reasoning: "The attempt was interrupted and recorded a terminal recovery package, so the safest replay point is the current durable story-run snapshot."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/001-story-validate.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/003-implementor.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-final-package.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: false
    command: "story-continue"
    outcome: "blocked"
    status: "blocked"
    errors:
      -
        code: "PROVIDER_OUTPUT_INVALID"
        message: "Provider output was invalid for claude-code."
        detail: "Provider stdout was not exact JSON.; raw stdout bytes=156292; raw stdout preview=\"{\\\"type\\\":\\\"system\\\",\\\"subtype\\\":\\\"init\\\",\\\"cwd\\\":\\\"/Users/leemoore/code/pi-long-horizon/liminal-context\\\",\\\"session_id\\\":\\\"3bd99b80-3187-4d52-9c3e-b6b2c0cfc11e\\\",\\\"tools\\\":[\\\"Task\\\",\\\"AskUserQuestion\\\",\\\"Bash\\\",\\\"CronCreate\\\",\\\"CronDelete\\\",\\\"CronList\\\",\\\"DesignSync\\\",\\\"Edit\\\",\\\"EnterPlanMode\\\",\\\"EnterWorktree\\\",\\\"ExitPlanMode\\\",\\\"ExitWorktree\\\",\\\"Monitor\\\",\\\"NotebookEdit\\\",\\\"PushNotification\\\",\\\"Read\\\",\\\"RemoteTrigger\\\",\\\"ScheduleWakeup\\\",\\\"Skill\\\",\\\"TaskCreate\\\",\\\"TaskGet\\\",\\\"TaskList\\\",\\\"TaskOutput\\\",\\\"TaskStop\\\",\\\"TaskUpdate\\\",\\\"ToolSearch\\\",\\\"WebFetch\\\",\\\"WebSe...[truncated]\"; stdout log=/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/streams/007-continue.stdout.log; stderr log=/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/streams/007-continue.stderr.log"
    artifactPaths:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/007-continue.json"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 21
  timestamp: "2026-06-14T05:22:58.084Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 22
  timestamp: "2026-06-14T05:22:58.108Z"
  type: "review-request-received"
  summary: "Impl-lead review request received: The retained implementor session (claude-code 3bd99b80-3187-4d52-9c3e-b6b2c0cfc11e) is broken: two consecutive story-continue attempts on it failed — first a >10min silence-timeout stall (process killed), then PROVIDER_OUTPUT_INVALID from a truncated stream when the stale session was stopped mid-output. Resuming that session is not recoverable. DIRECTIVE: do NOT run-continue / do NOT resume that implementor session. Start a FRESH implementor pass (run-implement, new session) that re-hydrates from the spec pack and the on-disk Story 1 code — which is already substantial and compiling (packages/pi-lhc/src/lifecycle/instance.ts, thread-resolution.ts, picker.ts; index.ts hook wiring; and the A-8 LHC registry changes in packages/lhc/src/domains/threads/{index.ts,internal/registry.ts}). Build on that on-disk code, do not discard it, and resolve the three open verifier findings below. Implementor silence timeout has been raised to 20 minutes."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-review-request-001.json"
  data:
    source: "impl-lead (Claude Code orchestrator) — maintainer recovery"
    decision: "reopen"
    itemIds:
      - "RECOVERY-FRESH-SESSION"
      - "SV-001"
      - "SV-002"
      - "SV-003"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 23
  timestamp: "2026-06-14T05:23:10.866Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/prompts/001-planner-turn-005.md"
    sessionId: "019ec495-48e8-74b3-bcd4-5cfbf5cf4e7c"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 24
  timestamp: "2026-06-14T05:23:10.889Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After the fresh implementor result returns, run verifier against the new implementor artifact and accept only on pass with no open findings."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 25
  timestamp: "2026-06-14T05:23:10.890Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After the fresh implementor result returns, run verifier against the new implementor artifact and accept only on pass with no open findings."
    actionSequence: 24
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 26
  timestamp: "2026-06-14T05:37:40.617Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/010-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 27
  timestamp: "2026-06-14T05:37:50.559Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/prompts/001-planner-turn-006.md"
    sessionId: "019ec4a2-bf99-7a73-b2a6-a207f50702e6"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 28
  timestamp: "2026-06-14T05:37:50.582Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
    selfNote: "After verifier returns, accept only on pass with no open findings and sufficient story gate evidence; otherwise route the smallest concrete follow-up."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 29
  timestamp: "2026-06-14T05:37:50.583Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After verifier returns, accept only on pass with no open findings and sufficient story gate evidence; otherwise route the smallest concrete follow-up."
    actionSequence: 28
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 30
  timestamp: "2026-06-14T05:42:29.133Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
    status: "ok"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 31
  timestamp: "2026-06-14T05:42:44.842Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/prompts/001-planner-turn-007.md"
    sessionId: "019ec4a7-269a-7a70-9ea0-b25573c29659"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 32
  timestamp: "2026-06-14T05:42:44.867Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected request-ruling."
  data:
    actionType: "request-ruling"
    turn: 3
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 33
  timestamp: "2026-06-14T05:42:44.897Z"
  type: "needs-ruling"
  summary: "Story-lead finalized 01-session-lifecycle-and-thread-resolution-story-run-001 with outcome needs-ruling."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-final-package.json"
  data:
    terminalDecision: "request-ruling"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 34
  timestamp: "2026-06-14T05:47:52.554Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 35
  timestamp: "2026-06-14T05:47:52.579Z"
  type: "review-request-received"
  summary: "Impl-lead review request received: Two open verifier revise findings remain in packages/pi-lhc/src/index.ts (verifier 011-verify.json). Address them via a story-continue on the CURRENT HEALTHY implementor session (claude-code fc8b0d70-702e-4abc-9faa-dda18cc81eaf) — do NOT resume the old broken session 3bd99b80. SV-003 (title metadata) and the prior placeholder-activate path are already resolved; do not regress them. The A-8 LHC registry changes and lhc threads-a8 test pass — keep them."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-review-request-002.json"
  data:
    source: "impl-lead (Claude Code orchestrator)"
    decision: "revise"
    itemIds:
      - "SV-001"
      - "SV-002"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 36
  timestamp: "2026-06-14T05:48:04.743Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/prompts/001-planner-turn-008.md"
    sessionId: "019ec4ac-1813-7792-bd89-d564999ce9a1"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 37
  timestamp: "2026-06-14T05:48:04.765Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-continue."
  data:
    actionType: "run-continue"
    turn: 1
    selfNote: "After revised implementation returns, run verifier against the new implementor artifact; accept only on verifier pass with no open findings and story gate evidence."
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 38
  timestamp: "2026-06-14T05:48:04.766Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After revised implementation returns, run verifier against the new implementor artifact; accept only on verifier pass with no open findings and story gate evidence."
    actionSequence: 37
    actionType: "run-continue"
    turn: 1
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 39
  timestamp: "2026-06-14T06:03:46.609Z"
  type: "child-operation-completed"
  summary: "story-continue completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/013-continue.json"
  data:
    actionType: "run-continue"
    command: "story-continue"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 40
  timestamp: "2026-06-14T06:03:56.130Z"
  type: "provider-output-invalid"
  summary: "Provider output did not match the expected JSON payload. root keys: action, rationale, inputs, selfNote; direct payload: inputs.artifactRefs: Invalid input: expected array, received undefined; raw stdout bytes=1262; raw stdout preview=\"{\\\"type\\\":\\\"thread.started\\\",\\\"thread_id\\\":\\\"019ec4ba-a4ba-7a03-a539-5a5147bb3de5\\\"}\\n{\\\"type\\\":\\\"turn.started\\\"}\\n{\\\"type\\\":\\\"item.completed\\\",\\\"item\\\":{\\\"id\\\":\\\"item_0\\\",\\\"type\\\":\\\"agent_message\\\",\\\"text\\\":\\\"{\\\\\\\"action\\\\\\\":\\\\\\\"run-verify\\\\\\\",\\\\\\\"rationale\\\\\\\":\\\\\\\"Latest implementor artifact 013 reports ready-for-verification after addressing the two open verifier findings; acceptance requires a fresh verifier pass with no open findings and gate evidence.\\\\\\\",\\\\\\\"inputs\\\\\\\":{\\\\\\\"verifierContinuationRef\\\\\\\":\\\\\\\"storyVerifier\\\\\\\",\\\\\\\"responseArtifactRef\\\\\\\"...[truncated]\"; raw stderr bytes=38; raw stderr preview=\"Reading additional input from stdin...\"; stdout log=/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/streams/001-story-lead.stdout.log; stderr log=/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/streams/001-story-lead.stderr.log; Reading additional input from stdin..."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-from-last-valid-artifact"
      reasoning: "Provider output became invalid after durable artifacts were written, so replay should resume from the last valid artifact boundary."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/001-story-validate.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/003-implementor.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/004-verify.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-final-package.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-review-request-001.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/010-implementor.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/011-verify.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/001-review-request-002.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/013-continue.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: true
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/01-session-lifecycle-and-thread-resolution/story-lead/prompts/001-planner-turn-009.md"
-
  storyRunId: "01-session-lifecycle-and-thread-resolution-story-run-001"
  sequence: 41
  timestamp: "2026-06-14T06:05:33.901Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
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
Bytes: 242

```yaml
storyGate: "pnpm --filter pi-lhc verify"
epicGate: "pnpm --filter pi-lhc verify-all"
plannerTimeoutMs: 600000
wholeRunTimeoutMs: 7200000
providerStartupTimeoutMs: 300000
providerActiveSilenceTimeoutMs: 1200000
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
