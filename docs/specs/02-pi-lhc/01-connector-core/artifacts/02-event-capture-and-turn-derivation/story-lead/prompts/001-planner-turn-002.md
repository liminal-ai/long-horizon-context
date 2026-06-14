# Story Lead Base Prompt

## Role Charter
You are the story lead for `02-event-capture-and-turn-derivation` on durable story run `02-event-capture-and-turn-derivation-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/stories/02-event-capture-and-turn-derivation.md
Bytes: 12943

# Story 2: Event Capture and Turn Derivation

### Summary
<!-- Jira: Summary field -->

Map finalized PI traffic into ordered, duplicate-safe LHC intake events and derive one LHC turn per user exchange.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** Every finalized PI message lands as ordered LHC intake events exactly once, runtime changes are recorded in order, and LHC turns are derived from PI traffic rather than PI's per-step turn markers.

**Scope In:**

- Productionized converter from PI `message_end` and runtime-selection hooks to LHC `MessageEventInput` events.
- Assistant content-part fan-out in thinking, text, tool-call order.
- Parallel tool-call correlation by `toolCallId`.
- Error-result capture and graceful-interrupt capture.
- LHC turn derivation from user prompt through agent run completion.
- Idempotency-keyed dedup for reload and replay.
- Capture failure isolation: durable gaps when writable, diagnostics when the store is unavailable.

**Scope Out:**

- Corpus replay verification and inspect assertions, owned by Story 3.
- Fork seeding, owned by Story 4.
- Derivation routing and assignment validation, owned by Stories 5 and 6.
- Context serving; PI's native context handling remains unchanged.

**Dependencies:** Story 1.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-2.1:** Every PI message finalized through `message_end` — user, assistant, tool result — is mapped to LHC intake events and recorded in source order. An assistant message fans out to per-content-part events in thinking → text → tool-call order: `assistant_thinking`, `assistant_text`, and one `tool_call` per call.

**TC-2.1** — A user/assistant/toolResult sequence records ordered events; an assistant `[thinking, text, toolCall]` fans out in that order.

**AC-2.2:** LHC turn boundaries are derived from PI traffic, not from PI's per-agent-step `turn_end`. One LHC turn spans a user prompt and all subsequent agent activity until the next user prompt or the end of the agent run. The converter emits exactly one LHC `turn_end` event per LHC turn, at the agent run's completion — never one per PI `turn_end`, and never keyed off PI's per-agent-run `turnIndex` as a session counter.

**TC-2.2** — A one-prompt-two-tools-then-answer corpus (the worked example) yields exactly one LHC turn with one `turn_end` at agent-run completion; PI's per-step `turn_end`s produce none.

**TC-2.3** — Session order derives from converter source-event order, not `turnIndex`; two agent runs each starting at `turnIndex 0` order correctly.

**AC-2.3:** Parallel tool calls are captured with correct correlation: when one assistant message carries multiple `tool_call` parts and their results complete out of arrival order, each `tool_result` event is matched to its call by `toolCallId`, not by arrival order.

**TC-2.4** — Parallel tool calls with out-of-order completion correlate each result to its call by `toolCallId`.

**AC-2.4:** A tool result carrying an error is captured as a `tool_result` event with its error content and an error flag set. No event is dropped because a tool failed.

**TC-2.5** — A tool result with `isError` is captured as a `tool_result` with the error flag and content; nothing dropped.

**AC-2.5:** A graceful interrupt — a complete turn PI marks aborted, with partial assistant content preserved — is captured whole: the partial content is recorded and the aborted disposition is carried through. The interrupted content is not discarded.

**TC-2.6** — A graceful-interrupt corpus records the partial assistant content with the aborted disposition; the turn closes complete-but-aborted.

**AC-2.6:** Capture is duplicate-safe. Re-delivered events (reload, crash-replay) are recognized by idempotency key and skipped rather than recorded twice. On normal resume PI re-delivers no historical events, so duplication only arises on the reload and replay paths.

**TC-2.7** — A re-delivered event (reload/replay) is skipped by idempotency key; a normal resume re-delivers no historical events.

**AC-2.7:** A capture failure does not break the PI session, and does not vanish silently. When the thread is writable, a malformed or unmappable event records a durable, queryable gap that surfaces in thread health. When the thread store itself is unavailable, the failure surfaces as an extension diagnostic / health signal rather than a durable gap (the record cannot be written), and no exception propagates into the PI hook. Either way the session continues, and capture adds no perceptible latency to interactive use.

**TC-2.8** — A malformed/unmappable event on a writable thread records a durable, queryable gap surfaced in health; an unavailable thread store surfaces an extension diagnostic / health signal with no durable gap. Both continue the session with no exception reaching the hook.

**AC-2.8:** Runtime changes that PI fires only in-stream — model selection (`model_select`) and thinking-level selection (`thinking_level_select`) — are captured in order as `runtime_note` events carrying the change (the new model or level, and the previous one). These are recorded at the moment they fire because no durable record holds them otherwise; nothing in this epic consumes them, and their presence in the thread is what lets later epics attribute a turn to the model that produced it.

**TC-2.9** — A `model_select` and a `thinking_level_select` each record an ordered `runtime_note` event carrying the new and previous values; ordering relative to surrounding messages is preserved.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 2 owns the converter and the LHC turn derivation rule. Finalized PI traffic becomes ordered LHC intake events, while PI's per-step `turn_end` events are input signals only and never become one LHC turn boundary per step.

The source of order is the converter's source-event order. This story also owns runtime-change capture, idempotency keys, and capture failure isolation.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- Turn derivation, dedup, and failure isolation are load-bearing mechanics.
- The implementation must be proven with red goldens before Green because wrong ordering can look superficially plausible.

Risk Reminders:
- Flow 2 order derives from converter source-event order, not parent id or `turnIndex`.
- `model_select` and `thinking_level_select` are captured when they fire; no later durable source exists.
- Unsupported image/file-reference parts must record an omission until M0 settles the final payload shape.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Converter orchestration | `packages/pi-lhc/src/capture/converter.ts` |
| Message mapping | `packages/pi-lhc/src/capture/map-message.ts` |
| Turn derivation | `packages/pi-lhc/src/capture/turn-accumulator.ts` |
| Idempotency | `packages/pi-lhc/src/capture/idempotency.ts` |
| Runtime changes | `packages/pi-lhc/src/capture/runtime-changes.ts` |
| State diagnostics | `packages/pi-lhc/src/lifecycle/state.ts` |
| Tests | `packages/pi-lhc/test/capture/converter.test.ts`, `packages/pi-lhc/test/capture/turn-derivation.test.ts`, `packages/pi-lhc/test/capture/parallel-and-errors.test.ts`, `packages/pi-lhc/test/capture/abort.test.ts`, `packages/pi-lhc/test/capture/idempotency.test.ts` |

#### Design References

- [epic.md §Flow 2](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:145), lines 145-179
- [epic.md §PI Event Mapping](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:272), lines 272-330
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:188), lines 188-192
- [tech-design.md §Flow 2](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:272), lines 272-329
- [tech-design.md §Deterministic Algorithm Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:573), lines 573-580
- [tech-design.md §Chunk 2](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:654), lines 654-656
- [test-plan.md §Capture Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:49), lines 49-78
- [test-plan.md §Chunk 2](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:154), lines 154-159

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.1 | `test/capture/converter.test.ts` | User, assistant, and tool-result sequence records in source order; assistant fan-out is thinking, text, then tool calls. |
| TC-2.2 | `test/capture/turn-derivation.test.ts` | Worked example produces exactly one LHC turn and one `turn_end` at `agent_end`; PI per-step `turn_end`s emit none. |
| TC-2.3 | `test/capture/turn-derivation.test.ts` | Two agent runs with repeated `turnIndex` values order by converter source-event order without collision. |
| TC-2.4 | `test/capture/parallel-and-errors.test.ts` | Out-of-order parallel tool results correlate to calls by `toolCallId`. |
| TC-2.5 | `test/capture/parallel-and-errors.test.ts` | Error tool result records error flag and content; no failed tool output is dropped. |
| TC-2.6 | `test/capture/abort.test.ts` | Graceful interrupt records partial assistant content, carries aborted disposition, and closes complete-but-aborted. |
| TC-2.7 | `test/capture/parallel-and-errors.test.ts` | Re-delivered event is skipped by idempotency key; normal resume does not replay historical messages. |
| TC-2.8 | `test/capture/converter.test.ts` | Writable malformed event records durable gap; unavailable store records state health signal with no hook exception. |
| TC-2.9 | `test/capture/converter.test.ts` | Model and thinking-level changes become ordered `runtime_note` events with new and previous values. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Idempotency / Retry | `test/capture/idempotency.test.ts` | Replaying the same corpus twice produces no duplicate events; re-delivered keys return `skipped`. | Single-event dedup does not prove reload/replay safety across a corpus. |
| Atomicity / Isolation | `test/capture/converter.test.ts` | Mid-batch failure records a gap and continues; store-unavailable produces a health signal, not a thread gap. | The product AC says the thread continues; this proves no exception reaches PI's hook and the two failure shapes stay distinct. |

#### Technical Notes

- `map-message.ts` is pure and performs no I/O.
- `turn-accumulator.ts` owns open-turn state and emits `[turn_end]` only when a turn is open.
- Idempotency precedence is PI entry id, provider response id or tool-call id, then content fingerprint.
- Capture uses `intakeStream.messageEvents(threadRef, events)` and relies on SDK duplicate-key behavior.

#### Anti-Shim Requirements

- Do not key turn order from `turnIndex`, parent id, or arrival-order assumptions for parallel tool results.
- Do not swallow malformed events; writable failures must become durable gaps, and unavailable-store failures must become extension health diagnostics.
- Do not add new intake event kinds for runtime model/thinking changes in this story; use `runtime_note`.

#### Production Path Proof

- Entrypoint: PI `message_end`, `turn_end`, `agent_end`, `model_select`, and `thinking_level_select` hooks routed through `index.ts`.
- Registration/default path: hook events call converter/map/runtime-change modules, then batch into `intakeStream.messageEvents`.
- Evidence: capture tests assert stored events, duplicate skips, no hook exception, and exact turn boundaries through the real LHC intake path.

#### Verification

- Targeted: `pnpm --filter pi-lhc verify -- test/capture`
- Story gate: `pnpm --filter pi-lhc green-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All Flow 2 ACs and TCs pass.
- Converter maps all in-scope PI message and runtime-selection events to LHC intake events.
- One LHC turn is emitted per user exchange, not per PI agent step.
- Idempotency handles reload and replay without duplicate records.
- Capture failures are visible and do not break the PI session.
- No context serving is introduced.


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
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/003-implementor.json
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "Next planner turn should evaluate the implementor artifact against TC-2.1 through TC-2.9 plus idempotency and atomicity risk tests before choosing review or verify."

## Response Trail
<current_response>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/003-implementor.json
bytes: 10915
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "36cce81e-e4a4-45f6-afb7-d61717980bd0"
    provider: "claude-code"
    model: "claude-opus-4-8"
    role: "story_implementor"
    sessionId: "4562dd99-e915-4997-a6b6-c06f59211979"
    continuation:
      provider: "claude-code"
      sessionId: "4562dd99-e915-4997-a6b6-c06f59211979"
      storyId: "02-event-capture-and-turn-derivation"
    outcome: "ready-for-verification"
    story:
      id: "02-event-capture-and-turn-derivation"
      title: "Story 2: Event Capture and Turn Derivation"
    planSummary: "Implemented Story 2 (Event Capture and Turn Derivation) — Chunk 2 — TDD Red→Green. Red: wrote 5 capture test files driving the production hook→converter→real-LHC-intake path plus direct unit calls, confirmed all 21 fail for the right reason against the fail-closed skeletons (never asserting on NotImplementedError), and froze them in red-manifest.json. Green: implemented idempotency.eventKey (precedence entryId→toolCallId→responseId→content-fingerprint), the pure map-message (assistant fan-out thinking→text→tool_call, tool_result correlation by toolCallId with error flag, unsupported parts and empty messages degrade to runtime_note, graceful-interrupt disposition carried on a trailing runtime_note), the TurnAccumulator (open-turn tracking; exactly one turn_end at agent_end; replay-stable turn keys; hard-kill leaves the turn open), runtime-changes (model_select/thinking_level_select → ordered runtime_notes carrying new+previous), and converter.capture (failure isolation: invalid_event on a writable thread records a durable gap runtime_note; store-unavailable surfaces as a structured error, never a throw). Wired index.ts message_end/model_select/thinking_level_select/agent_end to the converter with per-session capture state (open-turn accumulator + monotonic source-event index) and mapped failures into SessionState.health; PI per-step turn_end stays a no-op (ignored as an LHC boundary)."
    changedFiles:
      -
        path: "packages/pi-lhc/src/capture/idempotency.ts"
        reason: "Implemented eventKey with the POC precedence (PI entry id → tool-call/response id → content fingerprint), blockIndex+kind disambiguating one message's fan-out; added a fingerprint helper; widened optional fields to `?: T | undefined` so callers thread possibly-absent ids under exactOptionalPropertyTypes."
      -
        path: "packages/pi-lhc/src/capture/map-message.ts"
        reason: "Implemented the pure mapper: user→user_prompt, assistant fan-out (thinking→text→tool_call), tool_result correlated by toolCallId with an always-set isError flag, unsupported parts and wholly-empty messages → runtime_note (never a silent drop), and the aborted-disposition runtime_note; exported ABORTED_DISPOSITION_TEXT for fixture lock-step."
      -
        path: "packages/pi-lhc/src/capture/turn-accumulator.ts"
        reason: "Implemented the open-turn state machine: opens on user_prompt, emits exactly one turn_end at agent_end (with a replay-stable per-turn key), idempotent/no-op when no turn is open (hard-kill/reattach tolerance); added a constructor carrying piSessionId/actor/harness."
      -
        path: "packages/pi-lhc/src/capture/runtime-changes.ts"
        reason: "Implemented mapModelSelect/mapThinkingLevelSelect → runtime_note carrying new+previous values; exported the formatters."
      -
        path: "packages/pi-lhc/src/capture/converter.ts"
        reason: "Implemented capture() with total failure isolation: writable-thread invalid_event records a durable gap runtime_note then surfaces the failure; store-unavailable returns a structured error; messageEvents is wrapped so even a throw becomes an OpResult."
      -
        path: "packages/pi-lhc/src/index.ts"
        reason: "Wired the capture hook rail (message_end/model_select/thinking_level_select/agent_end) through map→accumulate→converter into real LHC intake; added per-session capture state (accumulator + source-event index) in the closure; mapped capture failures into SessionState.health (recordedGap true on invalid_event, false on store-unavailable); turn_end remains a no-op."
      -
        path: "packages/pi-lhc/test/capture/converter.test.ts"
        reason: "NEW — TC-2.1 ordered fan-out, TC-2.9 runtime-change capture, TC-2.8 atomicity/isolation (malformed→durable gap, unavailable→health signal, no throw)."
      -
        path: "packages/pi-lhc/test/capture/turn-derivation.test.ts"
        reason: "NEW — TC-2.2 worked example (one turn_end at agent_end), TC-2.3 source-order-not-turnIndex, accumulator state-machine goldens, hard-kill golden."
      -
        path: "packages/pi-lhc/test/capture/parallel-and-errors.test.ts"
        reason: "NEW — TC-2.4 parallel correlation by toolCallId, TC-2.5 error-result capture, TC-2.7 idempotent re-delivery (skipped by key, no duplicates)."
      -
        path: "packages/pi-lhc/test/capture/abort.test.ts"
        reason: "NEW — TC-2.6 graceful interrupt: partial content preserved, aborted disposition carried, turn closes complete-but-aborted."
      -
        path: "packages/pi-lhc/test/capture/idempotency.test.ts"
        reason: "NEW — deterministic eventKey precedence goldens + the idempotency architecture-risk corpus double-replay (no duplicate events; re-delivered keys skipped)."
      -
        path: "packages/pi-lhc/test/capture/support.ts"
        reason: "NEW — assertion-free scaffolding driving the production connector path (createConnector → hooks → real temp SQLite thread) and reading the durable event log back."
      -
        path: "packages/pi-lhc/test/fixtures/corpus.ts"
        reason: "Updated the aborted-turn corpus expected to include the abort runtime_note so the Story-0 stand-in reflects the converter's real output (imports ABORTED_DISPOSITION_TEXT); corpus-validity test still passes."
      -
        path: "packages/pi-lhc/test/red-manifest.json"
        reason: "Recorded sha256 hashes of the 5 Red-phase capture test files so the Green-exit immutability guard protects them."
    tests:
      added:
        - "test/capture/converter.test.ts"
        - "test/capture/turn-derivation.test.ts"
        - "test/capture/parallel-and-errors.test.ts"
        - "test/capture/abort.test.ts"
        - "test/capture/idempotency.test.ts"
        - "test/capture/support.ts (assertion-free scaffolding)"
      modified:
        - "test/fixtures/corpus.ts (aborted-turn expected now includes the abort runtime_note)"
        - "test/red-manifest.json (recorded the 5 capture test files)"
      removed:
[]
      totalAfterStory: 54
      deltaFromPriorBaseline: 21
    gatesRun:
      -
        command: "pnpm --filter pi-lhc verify -- test/capture"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc green-verify"
        result: "pass"
      -
        command: "pnpm --filter pi-lhc verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Abort disposition vehicle: research §5b says the mapper carries stopReason through, but the seven intake kinds have no disposition field and turn_end's payload must be empty — resolved by carrying it on a trailing runtime_note (no new kind, per Anti-Shim) and updating the aborted corpus expected so the converter and the Story-3 fixture stay consistent."
        - "turn_end key collisions: empty turn_end payloads would collide under a content fingerprint, dropping the second turn_end in multi-turn corpora (e.g. chatty) — resolved by keying turn_end off a per-session closed-turn counter in the accumulator."
        - "Failure-bucket mapping respects the closed ErrorCode union and the capture→lifecycle boundary rule: the converter returns a structured OpResult and index.ts (composition root) derives recordedGap from the code (invalid_event → gap recorded; otherwise health signal), since the capture surface may not import lifecycle/state."
        - "Confirmed PI per-step turn_end and agent_end carry content redundant with message_end, so the converter maps only message_end content and treats turn_end/agent_end as signals — avoiding double-capture."
        - "exactOptionalPropertyTypes: widened eventKey optionals and used conditional assignment for SessionState.health.lastCaptureFailure.eventKey."
      findingsSurfaced:
        - "The declared MessageEndEvent slice does not surface a real PI entry id, so the converter synthesizes a per-session monotonic source-event index as the entry id. This is replay-stable when a reload/replay re-runs from the start (the AC-2.6 paths), but a reload that re-delivers only a suffix of history would misalign the synthesized index; the content-fingerprint last-resort tier collides only on identical content at the same block. Both are documented limitations until PI's real entry/response ids are wired into the higher key tiers."
        - "Unknown top-level message roles (outside the declared PI union) are not given an explicit gap path; they fall through to the hook guard (session continues, diagnostic recorded) rather than a durable gap. Acceptable for the declared contract but worth a defensive gap if PI's surface widens."
    openQuestions:
      - "When PI's real entry id / provider response id are exposed on the message_end hook, they should replace the converter's synthesized source-event index in the idempotency key (they slot into the existing higher-precedence tiers). Until then the synthesized index is the entry id."
      - "M0 image/file-reference intake payload shape (tech-design Q1) is still pending; the converter degrades unsupported content parts to runtime_note as the interim contract — it gains real kinds if/when M0 extends the intake schema."
    specDeviations:
      - "Story spec listed 'None', but these refinements were recorded: (1) the aborted-turn corpus fixture (Story-0 stand-in) was updated to include the abort runtime_note so it matches the converter's real output;"
      - "(2) the map→accumulate orchestration lives in the index.ts composition root which calls converter.capture() for the batch+isolate step — forced by the check-boundaries rule that the capture surface may not import lifecycle (the accumulator and source-event counter are per-session state held in the connector closure); converter.capture()'s spec'd signature is unchanged;"
      - "(3) TurnAccumulator gained a constructor (piSessionId/actor/harness) so it can own turn_end key construction;"
      - "(4) eventKey's optional fields were widened to '?: T | undefined' to thread possibly-absent ids under exactOptionalPropertyTypes;"
      - "(5) the converter synthesizes a per-session entry index as the idempotency entry id because PI's real entry id is not in the declared hook slice yet."
    recommendedNextStep: "Proceed to Story 3 (Capture Verification): implement verify/replay.ts to replay the M0 corpora through this converter into a temp thread and compare read-back (events/messages/turns) to each fixture's expectation, with deterministic re-replay equality — it consumes this converter through the same real LHC intake path."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/003-implementor.json"
  startedAt: "2026-06-14T07:04:54.833Z"
  finishedAt: "2026-06-14T07:45:05.648Z"
```
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/story-lead/001-current.json
Bytes: 1833

```yaml
storyRunId: "02-event-capture-and-turn-derivation-story-run-001"
storyId: "02-event-capture-and-turn-derivation"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-implement completed with outcome ready-for-verification and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/003-implementor.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "4562dd99-e915-4997-a6b6-c06f59211979"
    storyId: "02-event-capture-and-turn-derivation"
latestEventSequence: 5
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "No bounded child response exists yet, and the durable record is ready for the first story implementation pass. The story requirements and test plan define the Chunk 2 capture scope, so implementation is the smallest safe next action."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/003-implementor.json"
replayBoundary: null
updatedAt: "2026-06-14T07:45:05.656Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: Next planner turn should evaluate the implementor artifact against TC-2.1 through TC-2.9 plus idempotency and atomicity risk tests before choosing review or verify.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-14T07:04:54.795Z; note="Next planner turn should evaluate the implementor artifact against TC-2.1 through TC-2.9 plus idempotency and atomicity risk tests before choosing review or verify."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/story-lead/001-events.jsonl
Bytes: 2242

```yaml
-
  storyRunId: "02-event-capture-and-turn-derivation-story-run-001"
  sequence: 1
  timestamp: "2026-06-14T07:04:36.448Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "02-event-capture-and-turn-derivation-story-run-001"
  sequence: 2
  timestamp: "2026-06-14T07:04:54.774Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ec4f2-5674-7d71-9c34-37782888396e"
-
  storyRunId: "02-event-capture-and-turn-derivation-story-run-001"
  sequence: 3
  timestamp: "2026-06-14T07:04:54.795Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "Next planner turn should evaluate the implementor artifact against TC-2.1 through TC-2.9 plus idempotency and atomicity risk tests before choosing review or verify."
-
  storyRunId: "02-event-capture-and-turn-derivation-story-run-001"
  sequence: 4
  timestamp: "2026-06-14T07:04:54.795Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "Next planner turn should evaluate the implementor artifact against TC-2.1 through TC-2.9 plus idempotency and atomicity risk tests before choosing review or verify."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "02-event-capture-and-turn-derivation-story-run-001"
  sequence: 5
  timestamp: "2026-06-14T07:45:05.656Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/artifacts/02-event-capture-and-turn-derivation/003-implementor.json"
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
