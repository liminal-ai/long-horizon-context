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
