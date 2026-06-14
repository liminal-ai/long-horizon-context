# Story Lead Base Prompt

## Role Charter
You are the story lead for `03-capture-verification` on durable story run `03-capture-verification-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/stories/03-capture-verification.md
Bytes: 7301

# Story 3: Capture Verification

### Summary
<!-- Jira: Summary field -->

Verify capture by replaying recorded PI corpora through the converter and matching deterministic thread read-back and inspect surfaces.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** Prove capture correctness from recorded corpora without serving context to a model.

**Scope In:**

- Corpus replay through the Story 2 converter.
- Read-back comparison for events, messages, and turns.
- Deterministic re-replay assertions for IDs and ordering.
- Inspect overview and health assertions for counts, last recorded position, gaps, and failed derivations.

**Scope Out:**

- Creating M0 corpora. This story consumes M0 corpora as fixtures.
- Context serving; Epic 1 remains observe-only.
- Derivation quality tuning.

**Dependencies:** Story 2. M0 corpora are fixture inputs.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-6.1:** Replaying a recorded PI corpus through the converter produces a thread whose read-back — events, messages, and turns — matches the fixture's expectation, including the chatty, tool-heavy, parallel-tool, error-result, and aborted-turn corpora.

**TC-6.1** — Each corpus (chatty, tool-heavy, parallel-tool, error-result, aborted-turn) replays to a thread whose read-back matches the fixture.

**AC-6.2:** Replay is deterministic: the same corpus replayed twice produces identical thread read-back. The deterministic-ID property holds through the converter, so a re-replay does not perturb IDs or ordering.

**TC-6.2** — The same corpus replayed twice yields identical read-back (IDs and order stable).

**AC-6.3:** inspect surfaces (overview, health) reflect the captured session: event and message counts, the last recorded event position, and any capture gaps or failed derivations are visible rather than hidden.

**TC-6.3** — inspect overview/health report event/message counts, last event position, and any gaps or failed derivations.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 3 is the proof layer for capture. It replays recorded PI corpora through the real converter and LHC intake path, then compares the thread read-back without serving context to a model.

The story also verifies inspect overview and health surfaces used by Epic 1 verification. Operator commands and self-inspection tools remain outside this story.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The implementation is narrow, but fixture fidelity and deterministic replay are easy to fake with shallow comparisons.
- Red should pin exact read-back comparison and deterministic replay before Green implements the replay harness.

Risk Reminders:
- M0 corpora breadth determines final fixture coverage; the replay machinery should widen as corpora arrive.
- Replay must use the real converter and intake path, not a parallel expected-event builder.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Replay harness | `packages/pi-lhc/src/verify/replay.ts` |
| Corpus fixtures | `packages/pi-lhc/test/fixtures/corpus.ts` |
| Temp threads | `packages/pi-lhc/test/fixtures/thread.ts` |
| Verification tests | `packages/pi-lhc/test/verify/replay.test.ts`, `packages/pi-lhc/test/fixtures/corpus.test.ts` |
| Inspect reads | LHC `inspect` overview/health APIs consumed by `verify/replay.ts` |

#### Design References

- [epic.md §Flow 6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:227), lines 227-235
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:196), lines 196-198
- [tech-design.md §Flow 6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:405), lines 405-413
- [tech-design.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:535), lines 535-549
- [tech-design.md §Fixture Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:555), lines 555-563
- [tech-design.md §Chunk 3](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:658), lines 658-660
- [test-plan.md §Replay Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:120), lines 120-132
- [test-plan.md §Chunk 3](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:161), lines 161-166

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-6.1 | `test/verify/replay.test.ts` | Each available recorded corpus replays through the converter to a thread whose events, messages, and turns match fixture expectation. |
| TC-6.2 | `test/verify/replay.test.ts` | Replaying the same corpus twice yields identical read-back, including deterministic IDs and order. |
| TC-6.3 | `test/verify/replay.test.ts` | Inspect overview/health report event/message counts, last recorded position, gaps, and failed derivations. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Fixture validity | `test/fixtures/corpus.test.ts` | Corpus loader yields valid `MessageEventInput` shapes and lifecycle-coherent sequences. | Replay tests can pass against bad fixtures unless the fixture substrate is checked independently. |

#### Technical Notes

- `replayCorpus(corpus, threadRef)` should return a structured compare result with a readable diff.
- Run replay against a real temp SQLite thread through the converter and intake path.
- Inspect checks consume overview/health only; do not introduce operator surfaces here.

#### Anti-Shim Requirements

- Do not compare only counts for replay equality; compare events, messages, turns, IDs, and order.
- Do not bypass Story 2's converter by writing expected events directly to the thread.

#### Production Path Proof

- Entrypoint: `packages/pi-lhc/src/verify/replay.ts`.
- Registration/default path: tests feed recorded corpora into the same converter/intake path used by live capture.
- Evidence: replay tests assert read-back equality, deterministic re-replay, and inspect health/overview visibility.

#### Verification

- Targeted: `pnpm --filter pi-lhc verify -- test/verify/replay.test.ts test/fixtures/corpus.test.ts`
- Story gate: `pnpm --filter pi-lhc green-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All Flow 6 ACs and TCs pass.
- Fixture replay compares events, messages, and turns for all available M0 corpora.
- Re-replay is deterministic.
- Inspect overview and health expose the required capture state.
- Verification does not serve any context to a model.


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
- planner_turn_index: 2
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-implement completed with outcome ready-for-verification and status ok.
- latest_response_kind: implementor-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/003-implementor.json
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementation returns, verify evidence before considering acceptance; do not accept without a passing verifier result and story gate evidence."

## Response Trail
<current_response>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/003-implementor.json
bytes: 7562
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "96fa76dd-cebc-4c34-aebd-483f55e62137"
    provider: "claude-code"
    model: "claude-opus-4-8"
    role: "story_implementor"
    sessionId: "8d6d1f63-412d-4ec0-a1d3-5b6b004b453c"
    continuation:
      provider: "claude-code"
      sessionId: "8d6d1f63-412d-4ec0-a1d3-5b6b004b453c"
      storyId: "03-capture-verification"
    outcome: "ready-for-verification"
    story:
      id: "03-capture-verification"
      title: "Story 3: Capture Verification"
    planSummary: "Story 3 (Capture Verification) implements verify/replay.ts plus its tests; net-new code only (src/verify/replay.ts impl + test/verify/replay.test.ts new). replayCorpus(corpus, threadRef) builds a real background LhcInstance via lhc.createSdk with a local observe-only fail-closed provider (verify has no pinned boundary edge to lifecycle, so it cannot import initInstance), then drives each corpus's source AgentMessages through the REAL Story-2 converter (mapMessage -> TurnAccumulator -> capture), reconstructing the PI hook stream: each message is a message_end, and an agent_end closes the LHC turn at every agent-run boundary (before a fresh user prompt, and once at end-of-stream) so PI's 'new prompt = new run' yields exactly one turn_end per run. It drains settled, reads the durable thread back via intakeStream.listEvents + inspect.overview, and compares events (kind+payload, in source order), messages (visible + byKind), and turns (closed/open) to the fixture with a readable diff — never writing the fixture's expected events to the thread, never comparing counts alone (anti-shim). A deterministic corpus-derived piSessionId ('replay:<name>') plus a per-message entryId make the converter's idempotency keys identical across replays, so the same corpus replayed into two fresh threads is byte-identical (AC-6.2). The pinned ReplayResult {matches, diff} and the (corpus, threadRef) signature are kept exactly; Corpus is unchanged. Run story gate `pnpm --filter pi-lhc verify` and epic gate `verify-all` both pass (15 test files / 79 tests). Verification serves nothing to a model."
    changedFiles:
      -
        path: "packages/pi-lhc/src/verify/replay.ts"
        reason: "Replaced the foundation fail-closed stub with the real replayCorpus harness: build a background observe-only LhcInstance, drive corpus.source through the Story-2 converter into a real temp thread, synthesize agent-run (agent_end) boundaries, drain, read the durable thread back (listEvents + inspect.overview), and compare events/messages/turns to the fixture with a readable diff. Kept the pinned ReplayResult {matches, diff} and the (corpus, threadRef) signature."
      -
        path: "packages/pi-lhc/test/verify/replay.test.ts"
        reason: "New Story-3 tests. TC-6.1: describe.each over all five corpora (chatty/tool-heavy/parallel-tool/error-result/aborted-turn) replays to a read-back matching the fixture. TC-6.2: same corpus into two fresh threads yields byte-identical read-back incl. real, stable idempotency keys, and re-replay into the same thread is a dedup no-op. TC-6.3: inspect overview/health report event/message counts, last recorded position, an induced capture gap, and failed derivations."
    tests:
      added:
        - "test/verify/replay.test.ts :: TC-6.1 corpus replay read-back matches fixture — chatty, tool-heavy, parallel-tool, error-result, aborted-turn (5 cases via describe.each)"
        - "test/verify/replay.test.ts :: TC-6.2 same corpus into two fresh threads -> identical read-back, real/stable idempotency keys"
        - "test/verify/replay.test.ts :: TC-6.2 re-replay into the same thread does not perturb read-back (deterministic keys dedup)"
        - "test/verify/replay.test.ts :: TC-6.3 inspect overview/health report counts, last recorded position, capture gap, and failed derivations"
      modified:
[]
      removed:
[]
      totalAfterStory: 79
      deltaFromPriorBaseline: 8
    gatesRun:
      -
        command: "pnpm --filter pi-lhc exec vitest run test/verify/replay.test.ts test/fixtures/corpus.test.ts (targeted)"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify (story gate)"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify-all (epic gate)"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc green-verify"
        result: "fail"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Determinism (AC-6.2): derive piSessionId from the corpus name (not the random temp-thread path) and stamp a deterministic per-message entryId, so the converter's Tier-1 idempotency keys are identical across replays — verified by comparing two fresh threads byte-for-byte."
        - "Anti-shim: replay drives the real converter (mapMessage + TurnAccumulator + capture) and compares events + messages + turns in order, never writing corpus.expected to the thread and never comparing counts alone."
        - "Boundary rule 3: verify/replay.ts constructs its SDK via lhc.createSdk + a local observe-only provider instead of importing lifecycle/instance (verify has no pinned edge to lifecycle); the boundaries check passes."
        - "Capture-failure parity: an unmappable source message degrades to a durable, queryable capture gap (captureGap) rather than throwing out of replay, mirroring index.ts's isolation."
      findingsSurfaced:
        - "green-verify FAILS, but only on PRE-EXISTING Story-2 test-immutability drift: check-test-immutability flags test/capture/{converter,parallel-and-errors,idempotency,reattach-idempotency}.test.ts as 'modified since Red phase'. These are committed Story-2 files I did not touch (confirmed unmodified vs HEAD); their hashes diverged from red-manifest.json during Story-2's accepted codex quick-fixes. No Story-3 file is flagged. The run's story gate is `verify` (passes) precisely to avoid this guard — per the impl-log rationale."
        - "replay derives agent-run (agent_end) boundaries from the source message stream (a new user prompt closes the prior run) because Corpus.source is a flat AgentMessage[] with no explicit run markers. This reconstruction is validated against every fixture's expected turn_end (the compare fails loudly if wrong). If M0 recordings encode explicit run/agent_end boundaries, driveCorpus should consume those instead of inferring them."
    openQuestions:
      - "M0 corpora breadth: the five synthetic corpora stand in until M0 delivers real PI recordings; the replay machinery is real and widens automatically as named corpora arrive (CORPUS_LOADERS / loadAllCorpora)."
      - "If green-verify becomes the enforced gate, red-manifest.json needs re-recording to absorb Story-2's already-accepted test edits (and the new Story-3 tests); that is orchestration bookkeeping spanning prior stories, not a Story-3 code change."
    specDeviations:
[]
    recommendedNextStep: "Verify and accept Story 3. It passes the run story gate `pnpm --filter pi-lhc verify` and epic gate `verify-all` (15 test files / 79 tests; +8 over Story 2's 71). Only src/verify/replay.ts (impl) and test/verify/replay.test.ts (new) changed — no packages/lhc changes, so no separate `pnpm --filter lhc verify` is needed. For the receipt: workspace test-file baseline +1 (replay.test.ts), no regression. Disregard green-verify's failure — it is pre-existing Story-2 red-manifest drift on four untouched files, not a Story-3 defect. Commit with scoped pathspecs, keeping the staged lhc-docs reorg out."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/003-implementor.json"
  startedAt: "2026-06-14T10:44:38.705Z"
  finishedAt: "2026-06-14T11:06:34.556Z"
```
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/story-lead/001-current.json
Bytes: 1768

```yaml
storyRunId: "03-capture-verification-story-run-001"
storyId: "03-capture-verification"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-implement completed with outcome ready-for-verification and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/003-implementor.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "8d6d1f63-412d-4ec0-a1d3-5b6b004b453c"
    storyId: "03-capture-verification"
latestEventSequence: 5
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "No bounded child operation has run yet, and the durable record contains only the story requirements plus a prior validation artifact. The smallest safe next action is to implement Story 3 against the story-local acceptance criteria and test plan."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/003-implementor.json"
replayBoundary: null
updatedAt: "2026-06-14T11:06:34.565Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation returns, verify evidence before considering acceptance; do not accept without a passing verifier result and story gate evidence.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-14T10:44:38.668Z; note="After implementation returns, verify evidence before considering acceptance; do not accept without a passing verifier result and story gate evidence."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/story-lead/001-events.jsonl
Bytes: 2121

```yaml
-
  storyRunId: "03-capture-verification-story-run-001"
  sequence: 1
  timestamp: "2026-06-14T10:44:28.622Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "03-capture-verification-story-run-001"
  sequence: 2
  timestamp: "2026-06-14T10:44:38.647Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ec5bb-a1d9-7051-af30-4bb83c58465c"
-
  storyRunId: "03-capture-verification-story-run-001"
  sequence: 3
  timestamp: "2026-06-14T10:44:38.667Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, verify evidence before considering acceptance; do not accept without a passing verifier result and story gate evidence."
-
  storyRunId: "03-capture-verification-story-run-001"
  sequence: 4
  timestamp: "2026-06-14T10:44:38.668Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, verify evidence before considering acceptance; do not accept without a passing verifier result and story gate evidence."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "03-capture-verification-story-run-001"
  sequence: 5
  timestamp: "2026-06-14T11:06:34.565Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/03-capture-verification/003-implementor.json"
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
