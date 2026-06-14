# Story Lead Base Prompt

## Role Charter
You are the story lead for `02-event-recording-validation-idempotency` on durable story run `02-event-recording-validation-idempotency-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/stories/02-event-recording-validation-idempotency.md
Bytes: 15360

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


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/test-plan.md
Bytes: 11854

# Epic 01: Thread Record and Intake — Test Plan

**Companion to:** `02-tech-design.md` · TCs from `01-epic.md`

## Testing Strategy

The system under test is the lhc package entered through its two real entry points: SDK operations and CLI commands. Internal modules — pipeline, projection, stores, registry — are exercised through those entries, never tested in isolation against mocked neighbors. Two deliberate exceptions get supplemental pure-function suites because they are genuinely pure logic with contractual behavior: the turn state machine (golden cases mirroring the epic's rule table) and token estimation (golden counts). Everything else earns its coverage through entry-point behavior.

**What gets mocked: nothing.** This epic has no network, no inference provider, no clock-sensitive contract beyond injected `clock`, and its filesystem behavior *is* the product (durability, atomicity, restart survival). Every test runs against real SQLite files in a per-test temp directory. The injected clock is fixed per test for deterministic `recordedAt`/`queuedAt`/`createdAt`; the tokenizer runs real because golden-counting real output is stronger than stubbing it.

**Test layers:**

| Layer | Runner | Enters through | In `verify` |
|-------|--------|----------------|-------------|
| SDK behavior | vitest | SDK operations on temp stores | yes |
| CLI in-process | vitest | command router with argv + stdin injection | yes |
| CLI process boundary | vitest, spawns `dist/cli.js` | real argv/stdin/exit codes | `verify-all` only (labeled skip otherwise) |
| Pure supplemental | vitest | state machine, tokenizer directly | yes |

CLI in-process tests cover command logic cheaply (parsing, SDK call, rendering); the process suite proves the executable boundary (shebang, stdin wiring, exit codes, JSON on stdout) for a representative subset, not every TC.

**Naming convention:** test titles carry their TC ids (`"TC-3.2: second prompt closes open turn"`), so traceability is greppable from the suite itself.

## Fixture Contracts

From `fixtures/` (test-only; exempt from boundary check):

| Builder | Produces | Default state |
|---------|----------|---------------|
| `tempStore()` | temp dir with registry path + thread path factory | empty, valid |
| `validEvent(kind, overrides?)` | one event input | valid per Flow 4 schemas; unique idempotency key; returns the discriminated `MessageEventInput` member for its kind, so kind-payload mismatches in test code are compile errors — building an invalid pairing requires an explicit cast at the call site |
| `eventBatch(kinds[])` | ordered event array | valid; keys unique within batch |
| `conversationTurn()` | `[user_prompt, assistant_text, tool_call, tool_result, turn_end]` | one complete turn |
| `threadWith(events)` | created thread + recorded batch via real SDK | post-Chunk-2: real pipeline output |
| `corruptTwoOpenTurns(path)` | below-SDK direct insert of second open turn row | the one sanctioned invalid-state fixture |
| `openRaw(path)` | direct `node:sqlite` handle for assertions | read-only use by convention |

Builder validity is itself tested (Chunk 0 smoke): defaults decode clean against the Flow 4 schemas. Invalid states are never builder defaults — tests construct invalidity explicitly via `overrides` (e.g. `validEvent("user_prompt", { payload: { wrong: true } })`), so a reader always sees the invalidity at the call site.

## TC → Test Mapping

File paths under `packages/lhc/test/`. Setup column shows the distinguishing arrangement; assertions are the TC's, restated only where the design sharpened them.

### Flow 1 — `threads.test.ts`

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-1.1 | create happy path | `tempStore()` | ok result; file exists; `openRaw` reads metadata row (threadId, createdAt, token_estimator); registry row matches |
| TC-1.2 | occupied path | pre-write a file at target | `path_exists`, `caller_error`; file bytes unchanged; registry row count unchanged |
| TC-1.3 | resolve known/unknown | one created thread | known: ok with path+metadata; unknown: `thread_not_found` |
| TC-1.4 | id/path equivalence | two identical threads, batch to one by id, one by path | identical BatchResults (modulo threadId); identical full read-back — *lives in `intake.test.ts`, owned by Chunk 2* |
| TC-1.5 | listing | three threads; also: list against absent registry | three rows, fields complete; absent registry → ok, empty array, no file created |
| TC-1.6 | compensation | `registryPath` whose parent is an existing regular file (deterministic cross-platform failure; read-only dirs are not — root and CI sandboxes ignore permission bits) | error result; thread file deleted; no registry |

### Flow 2 — `intake.test.ts` (recording), `projection.test.ts` (messages)

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-2.1 | order continuity | two 3-event batches | read-back: 6 events, orders 1–6, array order preserved |
| TC-2.2 | per-kind projection | `eventBatch` with all seven kinds | 6 messages (no turn_end); block types per design's mapping table; content verbatim |
| TC-2.3 | estimate determinism | same content, two threads | identical estimates; estimate present on all messages |
| TC-2.4 | tool-result fidelity | 300KB content string | read-back content byte-identical via SDK; repeated through spawned CLI in process suite |
| TC-2.5 | actor/harness carry | distinct values per event | values on event and message rows unchanged |
| TC-2.6 | result completeness | mixed batch (new, duplicate, prompt, turn_end) | per-event outcomes in order; messageIds; transitions; queuedWork; threadPosition |
| TC-2.7 | message work queued | prompt + tool_result batch | two items: `w-m1-prompt_smoothing`, `w-m2-tool_result_summary`; owner messages; status queued |
| TC-2.8 | empty batch | `[]` | `empty_batch`, `caller_error`; read-back unchanged |
| TC-2.9 | non-qualifying kinds | text/thinking/note batch | zero work items |

### Flow 3 — `turns.test.ts` + `state-machine.test.ts` (pure)

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-3.1 | open + stamp | prompt, text, tool_call, tool_result | one open turn; all four messages stamped to it |
| TC-3.2 | implicit close | prompt A activity, then prompt B | turn 1 closed, members frozen; turn 2 open, only prompt B |
| TC-3.3 | explicit close + work | prompt, text, turn_end | turn closed; `w-t1-turn_derivation` queued (work assertion owned by Chunk 5) |
| TC-3.4 | orphan turn_end | turn_end as first event | event recorded order 1; zero turns; zero work; next prompt opens t1 |
| TC-3.5 | frozen + gap | turn_end, then text, then prompt | text message turnId null; closed turn members unchanged; new turn holds only prompt |
| TC-3.6 | implicit close work parity | TC-3.2 setup | same work-item contract as explicit path (Chunk 5) |
| TC-3.7 | corruption | `corruptTwoOpenTurns`, then any batch | `turn_state_corrupt`, `state_corruption`; read-back unchanged |
| TC-3.8 | multi-turn batch | one batch: prompt, text, prompt, text, turn_end | two closed turns; correct membership; two turn work items |
| — | golden transitions | pure function | every rule-table row: (state, kind) → expected effect |

### Flow 4 — `validation.test.ts`

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-4.1 | four invalidity categories | four batches: unknown kind; missing idempotencyKey; caller-supplied eventOrder; turn_end with payload | each rejected whole; `invalid_event`; reason names the specific violation (server-field denial named as such) |
| TC-4.2 | first-failure index | valid, valid, invalid at index 2 | `eventIndex: 2`; events 0–1 not recorded |
| TC-4.3 | no trace | baseline thread, then rejected batch | full read-back (events, messages, turns, work) logically equal to baseline |
| TC-4.4 | class separation | one validation failure, one corruption (corrupt fixture), one storage failure (file-as-parent registryPath) | three distinct errorClasses, stable codes; same shapes via CLI in-process |
| TC-4.5 | valid-prefix rejection | new events + duplicates + one invalid | rejected whole; duplicates' originals unchanged; new events absent |
| — | unknown-field strictness | extra field at envelope, event, and payload levels | each rejected; three levels each named in reason |
| — | empty actor/harness | `validEvent` with `actor: ""` | rejected as missing required field |

### Flow 5 — `idempotency.test.ts`

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-5.1 | full resend | record 5, resend same 5 | zero recorded; five skips with `duplicate_idempotency_key`; read-back unchanged |
| TC-5.2 | partial resend | 3 recorded + 2 new | three skips, two recorded; orders continue dense (no gaps from skips) |
| TC-5.3 | cross-thread keys | same key, two threads | both record |
| TC-5.4 | skips inert | resend recorded prompt + turn_end mid-conversation | turn count/states unchanged; no transitions in result; work-item count unchanged; no duplicate message |
| TC-5.5 | key wins | key K with payload A recorded; resend K with valid payload B | skipped; read-back returns A; B nowhere in any table (`openRaw` scan) |

### CLI process suite — `cli-process.test.ts` (verify-all only)

Representative boundary proofs, not full TC repetition: `new-thread` → `resolve` round-trip; `message-events` via real stdin (including the 300KB tool result); TTY/empty stdin → `empty_stdin`, exit 1; one validation failure → JSON error shape, exit 1; `--help` and unknown command exit codes.

## Architecture-Risk Tests (non-TC)

Behaviors no TC names but the design promises; each exists because AC/TC mapping alone would miss it.

| Risk | Test | Why TCs miss it |
|------|------|-----------------|
| Atomicity under mid-walk failure | induced failure inside the transaction (test seam closes handle) → read-back equals baseline | TC-4.3 covers validation rejection; this covers in-transaction failure |
| Restart survival | record batch, close handle, reopen → identical read-back including work items | NFR, no TC; the durability claim itself |
| Rejected batch takes no lock | concurrent open succeeds while rejection-path runs | design promise (pure validation before transaction), invisible to single-connection TCs |
| system_error rollback parity | storage failure mid-batch → rollback whole, `system_error` class | AC-4.6 is class-independent; TCs only exercise caller-error rejection |
| Fixture validity | builder defaults decode against real schemas | test substrate correctness, not product behavior |
| Boundary-check self-test | sabotage import fails the script | guards the guard |
| Verification gates fail correctly | failing test fails `verify`; edited Red file fails `green-verify` | proves the gates once (Chunk 0), then trusted |
| Registry lazy-init non-creation | reads against absent registry create no file | easy to get accidentally wrong with open-or-create storage helpers |

## Coverage Summary

| Flow | TCs | Supplemental | Est. tests |
|------|-----|--------------|-----------|
| 1 | 6 | lazy-init | 9 |
| 2 | 9 | — | 12 |
| 3 | 8 | golden suite | 14 |
| 4 | 5 | strictness, empty-fields | 10 |
| 5 | 5 | — | 7 |
| CLI process | — | boundary proofs | 6 |
| Architecture-risk | — | 8 risks | 9 |
| Chunk 0 smoke | — | rail, fixtures, tokenizer, gates | 5 |
| **Total** | **33** | | **~72** |

Within the epic's 60–72 estimate, at the top because architecture-risk tests are enumerated rather than folded in. Every TC from the epic appears exactly once as an owned row; the two cross-chunk deferrals (TC-1.4 → Chunk 2; TC-3.3/3.6 work halves → Chunk 5) are marked at their rows and owed by their receiving chunks.


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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/02-event-recording-validation-idempotency/story-lead/001-current.json
Bytes: 1026

```yaml
storyRunId: "02-event-recording-validation-idempotency-story-run-001"
storyId: "02-event-recording-validation-idempotency"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/02-event-recording-validation-idempotency/001-story-validate.json"
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
updatedAt: "2026-06-10T13:12:27.633Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/02-event-recording-validation-idempotency/story-lead/001-events.jsonl
Bytes: 241

```yaml
-
  storyRunId: "02-event-recording-validation-idempotency-story-run-001"
  sequence: 1
  timestamp: "2026-06-10T13:12:27.632Z"
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
Bytes: 367

```yaml
storyGate: "pnpm --dir /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc run green-verify"
epicGate: "pnpm --dir /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc run verify-all"
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
