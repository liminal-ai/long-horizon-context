# Story 3: Message Projection and Token Estimates

### Summary
<!-- Jira: Summary field -->

Messages and blocks projected from recorded events inside the batch transaction; token estimates stamped at creation; message read-back.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): Everything recorded becomes readable — this is the layer operators will audit and later epics derive from. The integrator sees `messageId` appear in batch results.

**Objective:** Everything recorded becomes readable, with its size known. Each message-producing event yields exactly one message with kind-appropriate typed blocks, verbatim content, the actor/harness carry, and a deterministic base-unit token estimate — written in the same walk iteration that records the event, so projection can never drift from its source.

**Scope — in:**
- `messages.createFromEvent` wired into the walk after each recorded event
- Per-kind block projection: text kinds → one text block; `tool_call` → one block (`toolCallId`, `toolName`, `arguments`); `tool_result` → one block (`toolCallId`, full `content`, `isError`); `turn_end` → no message
- Full tool-result preservation — no code path that can shorten content
- Token stamping via `estimateTokens` in the same insert; deterministic `m<eventOrder>` ids
- `messageId` in batch result entries; `listMessages` read-back; CLI `messages list`
- Projection failure rejects the batch (extends the transaction's all-or-nothing to projection)

**Scope — out:** Turn membership stamping (Story 4 — `turnId` stays null here). Message-level work queueing (Story 5). Editing and search (Epic 04).

**Dependencies:** Story 2 (real recorded events in a real pipeline).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-2.2**: Each message-producing event yields exactly one message carrying that event's content verbatim, structured as one or more typed blocks.
  - **TC-2.2** (AC-2.2, 2.3): A batch with one of each event kind → six messages with kind-appropriate blocks and verbatim content; `turn_end` present in events, absent from messages.
- **AC-2.3**: A `turn_end` event is recorded in the event order but produces no message.
  - Verified by TC-2.2.
- **AC-2.4**: Every message is stamped at creation with a deterministic local token estimate in the system's base unit; the same content always yields the same estimate.
  - **TC-2.3** (AC-2.4): Two identical-content events in different threads → identical token estimates; estimate present on every message.
- **AC-2.5**: A `tool_result` payload is recorded and read back in full, regardless of size; intake never truncates or summarizes record content.
  - **TC-2.4** (AC-2.5): A tool result with content far past any rendering threshold (hundreds of KB) → read-back returns it byte-identical — via SDK, and repeated through the spawned CLI (stdin → read-back) in the process suite.
- **AC-2.6**: Each event's actor and harness identifiers are recorded as given and carried onto its message.
  - **TC-2.5** (AC-2.6): Events with distinct actor/harness values → values read back unchanged on event and message.
- **AC-5.4** (message clause): A skipped event creates no duplicate message.
  - TC-5.4's no-duplicate-message assertion re-run now that messages exist.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story adds projection to Story 2's walk: each recorded message-producing event yields its message, blocks, and token estimate in the same iteration that recorded it, inside the same transaction — projection cannot drift from its source because they are never separated. The risk profile is fidelity, not logic: kind-correct block shapes, verbatim content, and the absence of any code path that could shorten a tool result. `messages.createFromEvent` is the first cross-domain surface call through the operation context, establishing the pattern `turns.applyEvent` follows in Story 4.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- Per-kind mapping against fixed contracts with obvious red targets; the walk and transaction already exist.

Risk Reminders:
- Verbatim means verbatim: no trimming, normalizing, or summarizing anywhere in the projection path (AC-2.5 is the absence of such code).
- A projection failure must reject the whole batch — recorded events without messages is the stranded state the transaction exists to prevent.
- `turnId` stays null in this story; resist wiring it early.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Projection | `src/domains/messages/internal/project.ts` (event → message + blocks per kind) |
| Storage | `src/domains/messages/internal/store.ts` (message/block rows) |
| Surface | `src/domains/messages/index.ts` (createFromEvent, listMessages) |
| Pipeline wiring | `src/domains/intake-stream/internal/pipeline.ts` (walk step added) |
| CLI | `messages list` |
| Tests | `test/projection.test.ts` |

#### Design References

- [02-tech-design.md §Flow 2 (projection details + block mapping)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:288), lines 288–303
- [02-tech-design.md §Design Decision 3: Tokenizer pinning](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:153), lines 153–156
- [02-tech-design.md §Design Decision 8: Operation context](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:198), lines 198–209
- [02-tech-design.md §Interfaces: messages surface](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:487), lines 487–513
- [03-test-plan.md §Flow 2 mapping](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/03-test-plan.md:55), lines 55–68

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.2 | `test/projection.test.ts` | all seven kinds → six messages, kind-correct blocks, verbatim; turn_end absent |
| TC-2.3 | `test/projection.test.ts` | identical content, two threads → identical estimates; estimate on every message |
| TC-2.4 | `test/projection.test.ts` + process suite | 300KB tool result → byte-identical read-back, SDK and spawned CLI |
| TC-2.5 | `test/projection.test.ts` | actor/harness carried unchanged onto messages |

TC-5.4's no-duplicate-message clause is re-asserted here now that messages exist (clause ladder per `coverage.md`). The rollback ladder gains its projection rung: an induced projection failure rejects the whole batch.

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Projection failure strands nothing | `test/projection.test.ts` | induced projection failure → whole batch rejected, no event rows without messages | TCs exercise happy projection; the stranded-state hazard only appears on the failure path |

#### Technical Notes

- Message read-back: `{ messageId, sourceEventOrder, kind, blocks[], tokenEstimate, actor, harness, turnId? }` — `turnId` null until Story 4.
- Block shapes: text kinds → one text block; `tool_call` → `{ toolCallId, toolName, arguments }`; `tool_result` → `{ toolCallId, content, isError }`.
- Token estimates: tool calls count serialized `arguments`; tool results count the full `content` string; same insert as the message row; the util is called directly (no seam — golden counts beat stubs).
- `m<eventOrder>` ids are per-thread scoped and goldenable.

#### Anti-Shim Requirements

- TC-2.4 asserts byte-identical content through real read-back — SDK and spawned-CLI legs both — not content length or a checksum shortcut.
- Block-shape assertions check full structure per kind, not just block count.
- The projection-failure test induces failure through a real mechanism, and the assertion is read-back state, not the error result alone.

#### Production Path Proof

- Entrypoint: `lhc messages list` via `dist/cli.js`; `messageId` visible in `message-events` results.
- Registration/default path: CLI router to the real messages surface; projection runs inside the production intake pipeline, not a separate path.
- Evidence: TC-2.4's spawned-CLI leg exercises stdin → pipeline → projection → read-back end to end.

#### Verification

- Targeted: `pnpm test -- test/projection.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-2.2, TC-2.3, TC-2.4, TC-2.5 green via SDK; TC-2.4 repeated through spawned CLI
- [ ] TC-5.4 no-duplicate-message clause green
- [ ] Batch results carry `messageId` for recorded message-producing events
- [ ] `listMessages` ordered and deterministic; CLI `messages list` live
- [ ] Projection failure rejects the whole batch (supplemental test, induced via test seam)
- [ ] `green-verify` passes; `verify-all` green
