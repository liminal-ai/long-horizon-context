# Story 2: Event Recording, Validation, Idempotency

### Summary
<!-- Jira: Summary field -->

`intake-stream message-events` recording events durably in order; strict all-or-nothing batch validation; idempotency-keyed resend safety; event read-back.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The harness integrator's mental model is the contract here — "LHC records each batch whole or rejects it with a reason; if I'm unsure what landed, I resend and it sorts itself out." This story is where both halves of that sentence become true.

**Objective:** The event stream lands exactly once, in order, whole-or-not-at-all. The strict boundary (three-layer closed validation) and the transaction skeleton (the per-event walk) land together here — the epic's two highest-risk seams, deliberately before projection complicates the walk. No messages, turns, or work items yet: this story records and reads back events only.

**Scope — in:**
- The batch pipeline skeleton: pure whole-batch validation → `BEGIN IMMEDIATE` → per-event walk (dedup-check → record) → walk-time result assembly → commit
- Three-layer closed validation (envelope, event, payload): unknown fields rejected at every level, server-generated fields denied by name, non-empty `actor`/`harness`, per-kind payload shapes, `turn_end` empty-payload rule, first-failure `eventIndex`
- All-or-nothing rejection: validation failures reject before the transaction opens; in-transaction failures roll back whole
- Idempotency: skip set from recorded keys, validation-before-skip precedence, `skipReason: duplicate_idempotency_key`, skips consume no order numbers, key-wins-over-content
- Event ordering: `MAX(event_order)` counter, dense sequence across batches and skips
- `listEvents` read-back; `empty_batch`; CLI `message-events` (stdin JSON array, `empty_stdin` on TTY/empty) and `list-events`
- Closes Story 1's deferral: TC-1.4 id/path equivalence under intake

**Scope — out:** Message projection (Story 3), turn transitions (Story 4), work items (Story 5). The walk's result reports event outcomes and `threadPosition` only at this stage; `turnTransitions` and `queuedWork` are empty arrays with their population deferred to Stories 4–5.

**Dependencies:** Story 1 (real threads to record into).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-2.1**: A batch of valid events is recorded in array order, with event order continuing from the thread's last recorded event; a following batch continues the same sequence.
  - **TC-2.1** (AC-2.1): Send two batches of three events → read-back shows six events in send order with contiguous ordering.
- **AC-2.9**: An empty batch is a caller error; nothing is recorded.
  - **TC-2.8** (AC-2.9): An empty events array → caller error naming the problem; thread read-back unchanged.
- **AC-4.1**: A batch containing an event with an unrecognized kind is rejected whole.
- **AC-4.2**: A batch containing an event missing a required field is rejected whole.
- **AC-4.3**: A batch containing an event that carries a server-generated field is rejected whole.
- **AC-4.4**: A batch containing an event whose payload does not match its kind is rejected whole.
  - **TC-4.1** (AC-4.1–4.4): Four batches, each invalid one way (unknown kind; missing idempotency key; caller-supplied event order; `turn_end` with payload) → all rejected; per-batch error names index and reason.
- **AC-4.5**: A rejection error names the index of the first failing event and a structured reason for it.
  - **TC-4.2** (AC-4.5): A batch with a valid first event and invalid third → error names index 2; read-back confirms the valid first event did not land.
- **AC-4.6**: After any rejection, the thread is unchanged: event order, messages, turn state, and queued work all read back exactly as before the attempt.
  - **TC-4.3** (AC-4.6): Record a healthy baseline, attempt a rejected batch, diff full read-back → logically identical to the baseline. Written here over events; Stories 3–5 extend the rollback ladder to their added records, and Story 5 runs the complete-surface version (see `coverage.md`).
  - **TC-4.5** (AC-4.1, 4.6): A batch mixing valid new events, valid duplicates, and one invalid event → rejected whole; the duplicates' original records unchanged; the new events absent.
- **AC-4.7** (caller-error half): Every failed operation carries an error class distinguishing caller error, state corruption, and system error.
  - **TC-4.4** (AC-4.7): Partial here — validation failure (`caller_error`) and storage failure (`system_error`, file-as-parent registryPath) legs run in this story; the corruption leg (`state_corruption`) lands with Story 4's fixture. Story 4 completes this TC.
- **AC-5.1**: Resending a fully recorded batch records nothing, skips every event, and reports each skip with its idempotency key.
  - **TC-5.1** (AC-5.1): Record five, resend identically → zero recorded, five skips each carrying `skipReason: duplicate_idempotency_key`; read-back unchanged.
- **AC-5.2**: Resending a batch where some events are recorded and some are new skips the recorded ones and records the new ones in batch order.
  - **TC-5.2** (AC-5.2): Three old plus two new → three skips, two recorded continuing the order densely.
- **AC-5.3**: Idempotency keys are scoped to the thread: the same key in two different threads records in both.
  - **TC-5.3** (AC-5.3): Same key, two threads → both record.
- **AC-5.4** (event level): A skipped event causes no side effects.
  - **TC-5.4** (AC-5.4): At this stage asserts no duplicate event rows and no order-number consumption; the no-message / no-transition / no-work-item clauses are re-asserted by Stories 3–5 as those records exist.
- **AC-5.5**: A valid event reusing a recorded key with different content is skipped; the original record is unchanged and the new content is not stored anywhere.
  - **TC-5.5** (AC-5.5): Key K with payload A recorded; resend K with valid payload B → skipped, read-back returns A, B nowhere (`openRaw` scan).
- **AC-1.6** (completion): **TC-1.4** — same batch to one thread by id and an identical thread by path → identical results and read-back. Closes Story 1's deferral.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story lands the epic's two highest-risk seams together, by design: the strict three-layer validation boundary and the batch transaction skeleton. The pipeline order is load-bearing: **validate → begin immediate → per event in array order [dedup-check → record] → result → commit.** Validation is pure and runs before the transaction, so a rejected batch never takes the write lock; validation precedes idempotency, so a duplicate key on a malformed event is a rejection, not a skip. The walk this story builds is the spine Stories 3–5 extend — projection, turn transitions, and work queueing each become one more step inside the same per-event iteration, which is why getting the skeleton right here is worth a heavy story.

Strictness falls out of schema construction, not remembered rules: every level (envelope, event, payload) is a closed Effect Schema struct, so unknown-field rejection is a property of the definitions. Server-generated fields are denied by name with their own reason string — the old MVP's silent-root-field-drop bug class gets named when it appears, not just rejected.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- Transaction atomicity, idempotency semantics, validation precedence, and a persistence skeleton all land at once; this is the epic's riskiest story and the one most exposed to reward-hacking shortcuts (validation that "mostly" rejects, rollback that "usually" cleans up).

Risk Reminders:
- The four architecture-risk tests (mid-walk rollback, restart survival, no-lock-on-rejection, system_error rollback parity) are not optional polish — they are the story's actual point.
- Skips must not consume order numbers; the dense-sequence property is asserted, not assumed.
- `BEGIN IMMEDIATE` (not deferred) — the write lock is taken up front so single-writer violations fail loudly at a defined point.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Validation | `src/domains/intake-stream/internal/validate.ts` (three-layer closed schemas) |
| Pipeline | `src/domains/intake-stream/internal/pipeline.ts` (transaction, walk, result assembly) |
| Surface | `src/domains/intake-stream/index.ts` (messageEvents, listEvents) |
| Event storage | thread-file `event` table via schema v1 migration |
| CLI | `message-events` (stdin), `list-events` |
| Tests | `test/validation.test.ts`, `test/idempotency.test.ts`, `test/intake.test.ts` |

#### Design References

- [02-tech-design.md §Flow Designs intro (pipeline order)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:216), lines 216–221
- [02-tech-design.md §Flow 2: Event Batch Intake](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:262), lines 262–303
- [02-tech-design.md §Flow 4: Batch Validation and Rejection](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:336), lines 336–351
- [02-tech-design.md §Flow 5: Idempotent Resend](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:352), lines 352–367
- [02-tech-design.md §Interfaces: intake-stream surface](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:436), lines 436–486
- [03-test-plan.md §Flow 4 + Flow 5 mappings](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/03-test-plan.md:83), lines 83–104
- [03-test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/03-test-plan.md:109), lines 109–123

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.1 | `test/intake.test.ts` | two batches, six events, dense contiguous order |
| TC-2.8 | `test/intake.test.ts` | empty array → `empty_batch`, nothing recorded |
| TC-4.1 | `test/validation.test.ts` | four invalidity categories, each rejected whole with named reason |
| TC-4.2 | `test/validation.test.ts` | first-failure `eventIndex: 2`; valid first event did not land |
| TC-4.3 | `test/validation.test.ts` | baseline diff after rejection — logically identical (events level; ladder continues S3–S5) |
| TC-4.5 | `test/validation.test.ts` | valid-prefix batch rejected whole; duplicates' originals unchanged |
| TC-5.1 | `test/idempotency.test.ts` | full resend: five skips with `skipReason`, read-back unchanged |
| TC-5.2 | `test/idempotency.test.ts` | partial resend: three skips, two recorded, dense order |
| TC-5.3 | `test/idempotency.test.ts` | same key two threads → both record |
| TC-5.4 | `test/idempotency.test.ts` | skips inert at event level (clause ladder continues S3–S5) |
| TC-5.5 | `test/idempotency.test.ts` | key K payload B resend → skipped, A intact, B nowhere (`openRaw` scan) |
| TC-1.4 | `test/intake.test.ts` | id-form and path-form batches → identical results and read-back (closes Story 1's deferral) |

TC-4.4: this story owns the `caller_error` and `system_error` legs; the corruption leg and the three-way assertion land with the Story 4 fixture (per `coverage.md`).

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Atomicity under mid-walk failure | `test/intake.test.ts` | induced failure inside the transaction → read-back at baseline | TC-4.3 covers validation rejection; in-transaction failure is a different code path |
| Restart survival | `test/intake.test.ts` | write, close handle, reopen → identical read-back | NFR with no TC; the durability claim itself |
| Rejected batch takes no lock | `test/intake.test.ts` | concurrent open succeeds during a rejection | invisible to single-connection TCs |
| system_error rollback parity | `test/intake.test.ts` | storage failure mid-batch → whole rollback, `system_error` | AC-4.6 is class-independent; TCs only exercise caller-error rejection |

#### Technical Notes

- Batch result at this stage: `events[]` entries `{ idempotencyKey, outcome, skipReason? }` — no `messageId` until Story 3; `turnTransitions: []`, `queuedWork: []` until Stories 4–5; `threadPosition.lastEventOrder` live now.
- Event read-back: `{ eventOrder, eventKind, idempotencyKey, actor, harness, payload, recordedAt }`; `recordedAt` from the injected clock.
- The skip set is one `SELECT … WHERE idempotency_key IN (…)` at transaction start; the dedup decision reads only the key column (key-wins-over-content is the absence of a content comparison).
- Order counter initializes from `MAX(event_order)` at transaction start; only recorded events increment it.

#### Anti-Shim Requirements

- TC-4.3/TC-5.5 assert via full read-back and `openRaw` scans — not via the operation's own error result claiming nothing happened.
- The mid-walk failure must be induced through a real mechanism (test seam closing the handle), and the assertion is post-reopen read-back — not a mocked transaction object reporting rollback.
- Unknown-field strictness is proven at all three levels with three distinct probes — a single envelope-level probe does not cover payload-level closure.
- CLI `message-events` stdin handling is proven through the spawned binary with real stdin, including the TTY/empty → `empty_stdin` legs.

#### Production Path Proof

- Entrypoint: `lhc intake-stream message-events` (stdin JSON array) and `list-events` via `dist/cli.js`; SDK `messageEvents`/`listEvents`.
- Registration/default path: CLI router routes to the real surface, replacing Story 0 stubs; SDK exports the operation.
- Evidence: process-suite stdin leg (real pipe, real exit codes); `empty_stdin` distinct from SDK-level `empty_batch`.

#### Verification

- Targeted: `pnpm test -- test/validation.test.ts test/idempotency.test.ts test/intake.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-2.1, TC-2.8, TC-4.1, TC-4.2, TC-4.3, TC-4.5, TC-5.1–5.5 green via SDK; TC-4.4 caller/system legs green with corruption leg recorded as Story 4's debt
- [ ] TC-1.4 green — Story 1's deferral closed and noted closed
- [ ] Unknown-field strictness supplemental green at all three levels; empty actor/harness rejected
- [ ] Architecture-risk suite green: mid-walk rollback, restart survival, no-lock-on-rejection, system_error rollback parity
- [ ] CLI: `message-events` via stdin including `empty_stdin` paths; `list-events`; process-suite stdin leg
- [ ] `green-verify` passes; `verify-all` green
