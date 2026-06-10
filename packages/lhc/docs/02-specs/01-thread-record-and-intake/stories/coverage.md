# Epic 01 Story Coverage

**Gate artifact for:** `../01-epic.md` → `stories/00–05` · Tech design: `../02-tech-design.md` · Test plan: `../03-test-plan.md`

## Coverage Gate

Every epic AC and TC has exactly one owning story (the story whose tests prove it complete). Contributing stories prove partial aspects; ownership is where completion is claimed.

| AC | Owner | TCs | Contributors |
|----|-------|-----|--------------|
| AC-1.1 | Story 1 | TC-1.1 | — |
| AC-1.2 | Story 1 | TC-1.2, TC-1.6 | — |
| AC-1.3 | Story 1 | TC-1.1 | — |
| AC-1.4 | Story 1 | TC-1.1 | — |
| AC-1.5 | Story 1 | TC-1.3 | — |
| AC-1.6 | **Story 2** | TC-1.4 | Story 1 (read-path half; forbidden from claiming completion) |
| AC-1.7 | Story 1 | TC-1.5 | — |
| AC-2.1 | Story 2 | TC-2.1 | — |
| AC-2.2 | Story 3 | TC-2.2 | — |
| AC-2.3 | Story 3 | TC-2.2 | — |
| AC-2.4 | Story 3 | TC-2.3 | — |
| AC-2.5 | Story 3 | TC-2.4 | CLI process leg same story |
| AC-2.6 | Story 3 | TC-2.5 | — |
| AC-2.7 | Story 5 | TC-2.6 | Stories 2–4 populate the result incrementally |
| AC-2.8 | Story 5 | TC-2.7, TC-2.9 | — |
| AC-2.9 | Story 2 | TC-2.8 | — |
| AC-3.1 | Story 4 | TC-3.1 | — |
| AC-3.2 | Story 4 | TC-3.1 | — |
| AC-3.3 | Story 4 | TC-3.2, TC-3.8 | TC-3.8's work-item count is Story 5's |
| AC-3.4 | Story 4 | TC-3.3 (transition half) | — |
| AC-3.5 | Story 4 | TC-3.4 | — |
| AC-3.6 | **Story 5** | TC-3.3, TC-3.6 (work halves) | Story 4 (close paths work; queueing absent by design) |
| AC-3.7 | Story 4 | TC-3.5 | — |
| AC-3.8 | Story 4 | TC-3.5 | — |
| AC-3.9 | Story 4 | TC-3.7 | — |
| AC-4.1 | Story 2 | TC-4.1, TC-4.5 | — |
| AC-4.2 | Story 2 | TC-4.1 | — |
| AC-4.3 | Story 2 | TC-4.1 | — |
| AC-4.4 | Story 2 | TC-4.1 | — |
| AC-4.5 | Story 2 | TC-4.2 | — |
| AC-4.6 | Story 2 | TC-4.3, TC-4.5 | Rollback ladder: Stories 3–5 (below) |
| AC-4.7 | **Story 4** | TC-4.4 (all three legs together) | Story 2 (caller_error + system_error legs) |
| AC-5.1 | Story 2 | TC-5.1 | — |
| AC-5.2 | Story 2 | TC-5.2 | — |
| AC-5.3 | Story 2 | TC-5.3 | — |
| AC-5.4 | Story 2 | TC-5.4 | Clause ladder: Stories 3–5 (below) |
| AC-5.5 | Story 2 | TC-5.5 | — |

37/37 ACs owned · 33/33 TCs owned · 0 unassigned. Story 0 owns no epic ACs; its acceptance is FC-0.1 through FC-0.7 (foundation criteria, numbered in its file).

## Cross-Story Debts

Every split AC/TC, recorded in both the owing and paying story:

| Debt | Owed by | Paid by | What transfers |
|------|---------|---------|----------------|
| TC-1.4 | Story 1 | Story 2 | AC-1.6 id/path equivalence under intake (needs `message-events`) |
| TC-4.4 corruption leg | Story 2 | Story 4 | AC-4.7 completion: third error class joins caller/system legs (needs the corrupt fixture to be meaningful) |
| TC-3.3 / TC-3.6 work halves | Story 4 | Story 5 | AC-3.6: close paths queue `turn_derivation` (Story 4 ships working closes with no queueing; Story 5 adds the call) |
| TC-3.8 work-item count | Story 4 | Story 5 | Two `turn_derivation` items from the multi-turn batch |

**TC-5.4 clause ladder** (skipped events cause no side effects — each clause asserted when its record kind exists):

| Clause | Story |
|--------|-------|
| No duplicate event row, no order consumption | 2 |
| No duplicate message | 3 |
| No turn transition; turn count/states unchanged | 4 |
| No work item | 5 |

**AC-4.6 rollback ladder** (rejection leaves the thread unchanged — re-proven as the record surface grows):

| Coverage | Story |
|----------|-------|
| TC-4.3 baseline read-back diff (events); TC-4.5 mixed batch | 2 |
| Projection failure rejects whole batch (supplemental) | 3 |
| Corrupt-fixture batch failure leaves baseline unchanged | 4 |
| Rejected/skipped batch queues nothing; final full-surface regression — rejected batch leaves events, messages, turns, and work items at baseline (complete-surface TC-4.3) | 5 |

## Integration Path Trace

All five stories extend one operation. The walk after Story 5, annotated with the story that landed each step:

```text
messageEvents(threadRef, events[])
  resolveThreadRef ............................ S1
  validate batch (3-layer, closed) ............ S2
  BEGIN IMMEDIATE; load turn state ............ S2 (corruption check: S4)
  per event in array order:
    dedup-check (skip set, key-only) .......... S2
    record event row (dense order) ............ S2
    project message + blocks + estimate ....... S3
    turn transition + membership stamp ........ S4
    queue work (message-level / turn-close) ... S5
  assemble result during walk ................. S2 (messageIds S3, transitions S4, queuedWork S5)
  COMMIT
read-back: listEvents S2 · listMessages S3 · listTurns S4 · listQueuedWork S5
```

End-to-end integration test exists from Story 2 onward (create → batch → read-back) and gains assertions each story; Story 5's DoD requires the full epic TC table green, which is the integration gate.

## Story Shape Review

- **1:1 with tech-design chunks.** Stories 0–5 map to Chunks 0–5 exactly; the chunk exit criteria are the stories' technical gates. No re-derivation between artifacts.
- **Strictly linear dependencies.** No parallel tracks. Each story consumes the previous story's real artifacts (substrate maturity), so sequencing is forced, not chosen.
- **Story 2 is deliberately the heaviest** (15–17 tests, both high-risk seams). Defensible because validation, idempotency, and recording share one transaction skeleton — splitting them would mean one story ships a walk the next story rewrites. If it proves too large in execution, the natural split is validation+idempotency vs. transaction+recording; prefer not to.
- **Story 3 is the lightest** — per-kind mapping against fixed contracts. Correct: its risk is fidelity, not logic.
- **Story 0 owns no behavior** and proves the gates themselves (FC-numbered). Its fixture builders are golden-shaped until Story 2's schemas exist, then validated against them — recorded in both stories.
- **Future-boundary notes:** the work-queue util gains no public SDK surface (read-back through owning domains only — Epic 02 consumes the seam, doesn't widen it). Read-back operations here are the deliberate embryo of Epic 04's inspection, minimal and ordered, no search. Registry cached stats deferred to a later epic. The `WorkItemRecord` shape review against the epic's contract table is Story 5's named exit step because Epic 02 builds on it.
