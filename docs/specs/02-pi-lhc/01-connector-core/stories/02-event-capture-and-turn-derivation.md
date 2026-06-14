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
