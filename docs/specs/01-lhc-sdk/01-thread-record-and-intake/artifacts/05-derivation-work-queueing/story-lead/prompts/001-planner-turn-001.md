# Story Lead Base Prompt

## Role Charter
You are the story lead for `05-derivation-work-queueing` on durable story run `05-derivation-work-queueing-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/stories/05-derivation-work-queueing.md
Bytes: 10588

# Story 5: Derivation Work Queueing

### Summary
<!-- Jira: Summary field -->

Durable work items queued inside the batch transaction: message-level work as qualifying messages land, turn-level work at close; work-item read-back; the batch result complete.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The integrator sees `queuedWork` complete their batch results; Epic 02's derivation pipeline is the real consumer — this story fixes the seam it builds against.

**Objective:** All derivation work caused by an accepted batch is durably recorded by the time the batch's call returns. The work-queue util records items with deterministic ids inside the batch transaction; `messages` queues its own kinds, `turns` queues its own at close through the Story 4 seam; both domains read back their own queued work. A rejected batch queues nothing; a skipped event queues nothing.

**Scope — in:**
- `tech-utils/work-queue`: `recordItem`, `listItems` — mechanics only, no domain knowledge
- `messages.queueMessageWork`: kind gate (prompt → `prompt_smoothing`, tool_result → `tool_result_summary`, nothing else), owner `messages`
- Turn-close queueing added to Story 4's already-working close paths, inside the same batch transaction: one `turn_derivation` item per closed turn, owner `turns`
- Deterministic ids: `w-<sourceId>-<kind>`; items inside the batch transaction; `queuedAt` from injected clock
- `listQueuedWork` on both owning domains; `queuedWork` in batch results; CLI `messages list-queued-work`, `turns list-queued-work`
- Pays Story 4's debt: TC-3.3/TC-3.6 work-item halves, AC-3.6 claimed here
- Closes the epic: full TC table green, `verify-all` end to end

**Scope — out:** Running work, claim/lease, statuses beyond `queued`, repair (all Epic 02). The work-queue util gains no public SDK surface — read-back is through the owning domains.

**Dependencies:** Story 4 (working close paths to extend); Story 3 (real messages).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-2.7**: The batch result reports, per event: recorded or skipped, message id for recorded message-producing events, plus turn transitions and queued work items.
  - **TC-2.6** (AC-2.7): Result for a mixed batch names each event's outcome, message ids, transitions, and queued work — the result is now complete.
- **AC-2.8**: A `user_prompt` message durably queues prompt-smoothing work and a `tool_result` message durably queues tool-result-summary work, each owned by `messages`, in the same atomic operation that records the batch.
  - **TC-2.7** (AC-2.8): Prompt + tool result batch → `w-m1-prompt_smoothing` and `w-m2-tool_result_summary`, owner `messages`, status `queued`, correct sourceRefs.
  - **TC-2.9** (AC-2.8): Text/thinking/note batch → zero work items.
- **AC-3.6**: Closing a turn — by either close path — durably queues that turn's derivation work, owned by `turns`, before the intake call returns.
  - **TC-3.3** work half (AC-3.4, 3.6): explicit close → `w-t1-turn_derivation`, owner `turns`, status `queued`.
  - **TC-3.6** work half (AC-3.6): implicit close (new prompt) → same work-item contract as the explicit path.
  - TC-3.8's two-work-items assertion lands here as well.
- **AC-5.4** (work clause): A skipped event causes no work item.
  - TC-5.4's no-work-item assertion re-run now that work items exist.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story completes the epic by adding the last walk step: durable work items recorded inside the batch transaction. The work-queue util owns item mechanics and knows nothing of domains; `messages` queues its kinds as qualifying messages land, `turns` queues `turn_derivation` by adding the queue call to Story 4's already-working close paths. The queue step is gated on *recorded*, same as transitions — a skipped event queues nothing, a rejected batch queues nothing (rollback covers it).

This is the Epic 02 seam: shape fidelity matters more than logic. Deterministic ids (`w-<sourceId>-<kind>`) make re-queueing the same kind for the same source the same id — natural idempotency for Epic 02's repair path. The shape review against the epic's contract table is a named exit step because drift here is drift in the next epic's foundation.

#### Build Strategy

Strategy: tdd-lite

Reason:
- Clear contract targets and an existing walk to extend; the risk is shape drift and transaction membership, both directly red-testable.

Risk Reminders:
- Work items live in the thread file and commit with the batch — not a separate database, not a separate transaction.
- The util stays domain-blind: a function in `work-queue` that mentions a turn or a summary belongs in a domain (tech-arch capability rule).
- The kind gate is exact: prompt and tool_result queue; text, thinking, note, turn_end do not.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Work queue util | `src/tech-utils/work-queue/index.ts` (recordItem, listItems) |
| Message work | `src/domains/messages/index.ts` (queueMessageWork, listQueuedWork) |
| Turn work | `src/domains/turns/index.ts` (queue call in close paths, listQueuedWork) |
| Pipeline wiring | `src/domains/intake-stream/internal/pipeline.ts` (queue step; `queuedWork` in result) |
| CLI | `messages list-queued-work`, `turns list-queued-work` |
| Tests | `test/work-queue.test.ts` |

#### Design References

- [02-tech-design.md §Design Decision 1: Work-item granularity](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:143), lines 143–146
- [02-tech-design.md §Interfaces: Work queue util](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:532), lines 532–548
- [02-tech-design.md §Chunk 5: Work Queueing](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/02-tech-design.md:631), lines 631–638
- [03-test-plan.md §Flow 2 mapping (TC-2.6/2.7/2.9)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/03-test-plan.md:55), lines 55–68
- [03-test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/03-test-plan.md:109), lines 109–123
- [stories/coverage.md §Cross-Story Debts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/stories/coverage.md) — this story pays Story 4's debt and closes both ladders

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.6 | `test/work-queue.test.ts` | mixed batch → complete result: outcomes, messageIds, transitions, queuedWork |
| TC-2.7 | `test/work-queue.test.ts` | prompt + tool result → `w-m1-prompt_smoothing`, `w-m2-tool_result_summary`, owner messages |
| TC-2.9 | `test/work-queue.test.ts` | text/thinking/note → zero items |
| TC-3.3 (work half) | `test/work-queue.test.ts` | explicit close → `w-t1-turn_derivation`, owner turns — pays Story 4's debt |
| TC-3.6 (work half) | `test/work-queue.test.ts` | implicit close → same item contract — pays Story 4's debt |
| TC-3.8 (work count) | `test/work-queue.test.ts` | multi-turn batch → two `turn_derivation` items |

TC-5.4's no-work-item clause is the ladder's last rung. The AC-4.6 rollback ladder closes with the complete-surface regression below.

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Restart survival incl. work items | `test/work-queue.test.ts` | write, close, reopen → items intact, `queued` | Epic 02's worker must find items after any restart; no TC names durability |
| Complete-surface rollback | `test/work-queue.test.ts` | rejected batch → events, messages, turns, items all at baseline | TC-4.3 was written at the events level in S2; this is its final form over the full record surface |

#### Technical Notes

- Work item contract (Epic 02 seam): `workItemId` `w-<sourceId>-<kind>` unique per thread; `owner` `messages`|`turns`; `kind` `prompt_smoothing`|`tool_result_summary`|`turn_derivation`; `sourceRef` `{ messageId }`|`{ turnId }`; `status` always `queued` here; `queuedAt` from injected clock.
- Granularity is one item per derivation kind per source (Design Decision 1); Epic 02 fans out internally if it wants — the seam stays minimal.
- Read-back is through the owning domains only; the util has no public SDK surface and gains none.

#### Anti-Shim Requirements

- Work items are asserted via domain `listQueuedWork` read-back and `openRaw` — not via the batch result alone.
- The restart-survival test closes the real handle and reopens the real file — not an in-memory queue masquerading as durable.
- The shape review (exit step) compares the shipped `WorkItemRecord` against the epic's contract table field by field — a named checklist act, recorded in the story receipt, not a vibe.

#### Production Path Proof

- Entrypoint: `lhc messages list-queued-work`, `lhc turns list-queued-work` via `dist/cli.js`; `queuedWork` in `message-events` results.
- Registration/default path: queue step runs inside the production walk; both list commands route to real surfaces.
- Evidence: process-suite leg covering one list-queued-work command; full epic TC table green is this story's epic gate.

#### Verification

- Targeted: `pnpm test -- test/work-queue.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all` — full epic TC table green end to end

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-2.6, TC-2.7, TC-2.9 green; TC-3.3/TC-3.6 work halves green — Story 4's debt paid and noted paid; TC-3.8 work assertion green
- [ ] TC-5.4 no-work-item clause green
- [ ] Restart survival extended to work items; complete-surface rollback regression green (AC-4.6 ladder closed)
- [ ] `listQueuedWork` on both domains; CLI commands live; work-queue util has no public SDK surface
- [ ] `WorkItemRecord` shape reviewed against the epic's contract table (named exit step, not just tests)
- [ ] Full epic TC table green; `green-verify` passes; `verify-all` green end to end


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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/05-derivation-work-queueing/story-lead/001-current.json
Bytes: 984

```yaml
storyRunId: "05-derivation-work-queueing-story-run-001"
storyId: "05-derivation-work-queueing"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/05-derivation-work-queueing/001-story-validate.json"
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
updatedAt: "2026-06-10T14:49:55.414Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/01-thread-record-and-intake/artifacts/05-derivation-work-queueing/story-lead/001-events.jsonl
Bytes: 227

```yaml
-
  storyRunId: "05-derivation-work-queueing-story-run-001"
  sequence: 1
  timestamp: "2026-06-10T14:49:55.413Z"
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
