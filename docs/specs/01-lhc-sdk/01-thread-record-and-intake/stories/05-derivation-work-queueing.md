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
