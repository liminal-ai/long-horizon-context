# Story Lead Base Prompt

## Role Charter
You are the story lead for `04-turn-state-machine` on durable story run `04-turn-state-machine-story-run-001`.
Select exactly one bounded next action for this `resume` turn.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/stories/04-turn-state-machine.md
Bytes: 12646

# Story 4: Turn State Machine

### Summary
<!-- Jira: Summary field -->

Turn open/close per the fixed rule set, membership stamping at intake, frozen closed turns, corruption detection, turn read-back.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The integrator's harness drives turn boundaries implicitly (prompts) and explicitly (`turn_end`); everything downstream — derivation, chunks, views — stands on the membership this story stamps.

**Objective:** Turn membership is settled the moment an event lands, never later. The pure transition function implements the epic's rule table exactly; the surface operation interprets effects against storage; stamping order (transition first, then stamp) makes prompts belong to the turn they open. Closed turns are frozen by construction — no code path writes to them again.

**Scope — in:**
- `turns/internal/state-machine.ts`: pure `transition(state, eventKind) → effect` with golden cases for every rule-table row
- `turns.applyEvent` against storage: `open` (insert `t<order>`, status open), `close` (status + closed-at), `close_then_open`
- Membership stamping in the walk: prompts stamp post-transition to the new turn; other kinds stamp to current-or-null; gap messages (post-close, pre-prompt) stay null forever
- Corruption check at state load (after `BEGIN IMMEDIATE`, before any event): more than one open turn fails the batch with `turn_state_corrupt`
- `listTurns` with membership-by-query (`memberMessageIds` from messages' `turn_id`, ordered); turn transitions in batch results; CLI `turns list`
- Completes TC-4.4: the corruption leg joins Story 2's caller/system legs

**Scope — out:** Turn-close work queueing. This story implements turn close and membership completely — closes succeed and are fully usable. It does not invoke or fake any work-queue behavior: the close path simply does not call the queue yet. Story 5 adds queueing to these already-working close paths inside the same batch transaction. TC-3.3/TC-3.6's work-item assertions are Story 5's named debt; nothing in this story stubs, fakes, or fails on their behalf.

**Dependencies:** Story 3 (stamping needs real message rows).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-3.1**: A `user_prompt` arriving with no open turn opens a turn, and the prompt's message is stamped to it.
  - **TC-3.1** (AC-3.1, 3.2): Prompt, then assistant text and a tool call/result → one open turn; all four messages stamped to it.
- **AC-3.2**: Message-producing events arriving while a turn is open are stamped to that turn.
  - Verified by TC-3.1.
- **AC-3.3**: A `user_prompt` arriving with a turn open closes the open turn and opens a new one in the same operation; the prompt's message belongs to the new turn.
  - **TC-3.2** (AC-3.3): Second prompt while first turn open → first turn closed with members frozen; second turn open holding only the new prompt.
  - **TC-3.8** (AC-3.3): A single batch `prompt, text, prompt, text, turn_end` → two closed turns, correct membership in each. (Two turn-derivation work items: asserted in Story 5.)
- **AC-3.4**: A `turn_end` arriving with a turn open closes it.
  - **TC-3.3** (AC-3.4, 3.6): Prompt, activity, `turn_end` → turn closed. (The `turns`-owned work item assertion is Story 5's.)
- **AC-3.5**: A `turn_end` arriving with no open turn has no turn effect and is still recorded as an event.
  - **TC-3.4** (AC-3.5): `turn_end` as a thread's first event → recorded, no turn exists, no work queued, subsequent prompt opens turn 1 normally.
- **AC-3.7**: A closed turn's membership is frozen: no later event joins it, and read-back of a closed turn always returns the same member messages.
  - **TC-3.5** (AC-3.7, 3.8): After a `turn_end`, send assistant text, then a new prompt → the text message has no membership; the closed turn's member list is unchanged; the new turn contains only the prompt.
- **AC-3.8**: Message-producing events arriving after a close and before the next `user_prompt` create messages with no turn membership, and those messages never join any turn afterward.
  - Verified by TC-3.5.
- **AC-3.9**: A thread found with more than one open turn fails the operation with a corruption-class error; the batch records nothing.
  - **TC-3.7** (AC-3.9): Manufacture two open turns via the fixture → any batch fails `turn_state_corrupt`; read-back confirms nothing recorded.
- **AC-4.7** (completion): the corruption leg of **TC-4.4** runs here, joining Story 2's legs — three distinct error classes asserted together.
- **AC-3.6** is **not claimed by this story**. This story proves the close-path transition and membership behavior only. It does not invoke, stub, or fake queueing — the queue call simply does not exist in the close paths yet. Story 5 adds the turn-derivation work item to these already-working close paths and owns AC-3.6 and the work-item halves of TC-3.3/TC-3.6.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story adds the turn step to the walk: a pure transition function (`turns/internal/state-machine.ts`) decides effects, and the surface operation `turns.applyEvent` interprets them against storage. The ordering inside the walk is the integration risk: prompts transition *first*, then stamp — that order is what makes a prompt belong to the turn it opens (AC-3.1) and to the *new* turn on implicit close (AC-3.3). Membership is stored on the message (`turn_id` column), not as a list on the turn — one source of truth, so frozenness (AC-3.7) is the absence of any writer rather than an enforced guard.

Turn close works completely in this story and queues nothing — the queue call simply does not exist yet; Story 5 adds it to these working paths inside the same transaction. Nothing is stubbed or faked at that seam.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The pure function has exact golden targets (every rule-table row); the storage interpretation and stamping order have clear TC targets. Risk is concentrated in walk-ordering, which red tests catch directly.

Risk Reminders:
- Transition-then-stamp order for prompts; current-or-null stamping for everything else — get the order wrong and TC-3.1/TC-3.2 fail in confusing ways.
- The corruption check runs once at state load (after `BEGIN IMMEDIATE`, before any event), not per event.
- Gap messages (post-close, pre-prompt) stay null forever — no later adoption.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| State machine | `src/domains/turns/internal/state-machine.ts` (pure transition function) |
| Storage | `src/domains/turns/internal/store.ts` (turn rows, membership query) |
| Surface | `src/domains/turns/index.ts` (applyEvent, listTurns) |
| Pipeline wiring | `src/domains/intake-stream/internal/pipeline.ts` (corruption check at load; turn step in walk) |
| Corrupt fixture | `test/fixtures/corrupt.ts` (now meaningful) |
| CLI | `turns list` |
| Tests | `test/state-machine.test.ts` (golden), `test/turns.test.ts` (behavior) |

#### Design References

- [02-tech-design.md §Flow 3: Turn Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:304), lines 304–335
- [02-tech-design.md §Design Decision 5: The two-open-turns fixture](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:177), lines 177–180
- [02-tech-design.md §Interfaces: turns surface](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:514), lines 514–531
- [02-tech-design.md §Chunk 4: Turn State Machine](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:623), lines 623–630
- [03-test-plan.md §Flow 3 mapping](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/03-test-plan.md:69), lines 69–82

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| golden | `test/state-machine.test.ts` | every rule-table row: (state, kind) → expected effect |
| TC-3.1 | `test/turns.test.ts` | prompt + activity → one open turn, four members |
| TC-3.2 | `test/turns.test.ts` | second prompt → turn 1 closed/frozen, turn 2 holds only new prompt |
| TC-3.3 | `test/turns.test.ts` | explicit close: transition + membership half (work half: Story 5) |
| TC-3.4 | `test/turns.test.ts` | orphan turn_end inert, recorded, next prompt opens t1 |
| TC-3.5 | `test/turns.test.ts` | gap message null forever; closed members unchanged |
| TC-3.6 | `test/turns.test.ts` | implicit close parity: transition half (work half: Story 5) |
| TC-3.7 | `test/turns.test.ts` | corrupt fixture → `turn_state_corrupt`, nothing recorded |
| TC-3.8 | `test/turns.test.ts` | multi-turn batch → two closed turns, correct membership |
| TC-4.4 | `test/turns.test.ts` | corruption leg joins S2's legs — three classes asserted distinct |

TC-5.4's no-transition clause is re-asserted here now that turns exist (clause ladder per `coverage.md`). The rollback ladder gains its corruption rung: a corrupt-fixture batch failure leaves baseline read-back unchanged.

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Corruption check fires before any write | `test/turns.test.ts` | corrupt fixture + batch → failure with baseline unchanged | TC-3.7 asserts the error; this asserts the *timing* — no partial walk preceded detection |

#### Technical Notes

- Rule table (golden contract): 0+prompt→open; 1+prompt→close_then_open; 1+turn_end→close; 0+turn_end→none (event still recorded); other kinds→none (stamp only); >1 open→`turn_state_corrupt` before the walk.
- Pure shape: `transition({ openTurnId }, eventKind) → none | open | close | close_then_open`. The corruption check lives in the pipeline, not the function — only the pipeline writes turn state, so a violation means external interference; once under the held lock is sufficient.
- Turn read-back: `{ turnId, status, memberMessageIds[], openedAtEventOrder, closedAtEventOrder? }`; `memberMessageIds` is a query over messages' `turn_id`, ordered by event order.
- `t<turnOrder>` ids, 1-based, per-thread.
- The corrupt fixture is the one sanctioned below-SDK write — direct insert of a second open-turn row, possible only because the contract makes the state unreachable through any operation.

#### Anti-Shim Requirements

- Golden cases enumerate the full table — a passing subset is not coverage of the contract.
- Frozenness is proven by read-back after subsequent activity (TC-3.5), not by asserting a guard exists — the design has no guard; the proof is behavioral.
- TC-3.7's "nothing recorded" is a full read-back diff against pre-batch baseline, not just the error code.
- TC-4.4's three-way assertion runs all three legs in one test so the classes are compared against each other, not pattern-matched individually.

#### Production Path Proof

- Entrypoint: `lhc turns list` via `dist/cli.js`; `turnTransitions` visible in `message-events` results.
- Registration/default path: turn step runs inside the production walk; the corrupt-fixture path proves the corruption branch reaches the CLI error rendering.
- Evidence: process-suite leg for `turns list` output shape.

#### Verification

- Targeted: `pnpm test -- test/state-machine.test.ts test/turns.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] Golden suite covers every rule-table row
- [ ] TC-3.1, TC-3.2, TC-3.4, TC-3.5, TC-3.7, TC-3.8 green; TC-3.3/TC-3.6 transition-and-membership halves green with work-item halves recorded as Story 5's debt
- [ ] TC-4.4 complete: three error classes asserted distinct
- [ ] Corruption check fires at state load — baseline read-back unchanged after a corrupt-fixture batch failure
- [ ] Batch results carry `turnTransitions` in occurrence order; `listTurns` and CLI live
- [ ] Turn close fully working with no queue invocation — no stub called, no fake item, no failure injected; queueing arrives in Story 5
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
- planner_turn_index: 2
- mode: resume
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-orchestrate-resume
- current_child_operation: story-implement
- current_summary: Story orchestration resume requested and durable state has been reopened.
- latest_response_kind: none
- latest_response_path: none
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementation, require verifier evidence and the configured story gate before considering acceptance."

## Response Trail
<current_response>
No prior bounded child response is recorded yet.
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/story-lead/001-current.json
Bytes: 1495

```yaml
storyRunId: "04-turn-state-machine-story-run-001"
storyId: "04-turn-state-machine"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration resume requested and durable state has been reopened."
currentPhase: "story-orchestrate-resume"
currentChildOperation:
  command: "story-implement"
  artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/003-implementor.json"
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/story-lead/001-final-package.json"
    provenance: "current-run"
latestContinuationHandles:
{}
latestEventSequence: 7
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "resume-attempt"
  summary: "Continue the existing durable story-lead attempt from its latest checkpoint."
replayBoundary: null
updatedAt: "2026-06-10T14:29:56.511Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation, require verifier evidence and the configured story gate before considering acceptance.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-10T14:19:51.232Z; note="After implementation, require verifier evidence and the configured story gate before considering acceptance."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/story-lead/001-events.jsonl
Bytes: 4231

```yaml
-
  storyRunId: "04-turn-state-machine-story-run-001"
  sequence: 1
  timestamp: "2026-06-10T14:19:37.911Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "04-turn-state-machine-story-run-001"
  sequence: 2
  timestamp: "2026-06-10T14:19:51.212Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb1e7-2cf4-78c3-bde7-bf8997827d9c"
-
  storyRunId: "04-turn-state-machine-story-run-001"
  sequence: 3
  timestamp: "2026-06-10T14:19:51.231Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation, require verifier evidence and the configured story gate before considering acceptance."
-
  storyRunId: "04-turn-state-machine-story-run-001"
  sequence: 4
  timestamp: "2026-06-10T14:19:51.232Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation, require verifier evidence and the configured story gate before considering acceptance."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "04-turn-state-machine-story-run-001"
  sequence: 5
  timestamp: "2026-06-10T14:24:09.003Z"
  type: "child-process-stopped"
  summary: "Stopped stale story-implement provider process 44539 after interruption handling."
  data:
    storyId: "04-turn-state-machine"
    storyRunId: "04-turn-state-machine-story-run-001"
    command: "story-implement"
    artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/003-implementor.json"
    statusArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/progress/003-implementor.status.json"
    cleanedUpAt: "2026-06-10T14:24:09.003Z"
    provider: "claude-code"
    pid: 44539
    streamPaths:
      stdoutPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/streams/003-implementor.stdout.log"
      stderrPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/streams/003-implementor.stderr.log"
-
  storyRunId: "04-turn-state-machine-story-run-001"
  sequence: 6
  timestamp: "2026-06-10T14:24:09.015Z"
  type: "child-operation-failed"
  summary: "story-implement returned a failed runtime envelope before producing a recoverable child result."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-current-attempt"
      reasoning: "The attempt was interrupted and recorded a terminal recovery package, so the safest replay point is the current durable story-run snapshot."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/001-story-validate.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: false
    command: "story-implement"
    outcome: "blocked"
    status: "blocked"
    errors:
      -
        code: "PROVIDER_UNAVAILABLE"
        message: "Provider execution failed for claude-code."
    artifactPaths:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/04-turn-state-machine/003-implementor.json"
-
  storyRunId: "04-turn-state-machine-story-run-001"
  sequence: 7
  timestamp: "2026-06-10T14:29:56.511Z"
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
