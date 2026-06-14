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
