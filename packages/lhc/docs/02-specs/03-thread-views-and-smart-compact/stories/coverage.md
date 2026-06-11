# Epic 03 Story Coverage

Proof of complete AC/TC assignment and sharding judgment for the six-story pack. Source: `../epic.md` (38 ACs, 27 TCs after two review rounds). Stories follow the epic's Story Breakdown one-to-one; design chunks map 1:1 to stories.

## Coverage Gate

Every AC appears at least once; every TC has exactly one primary owner. Cross-story completion legs (TC-2.5, TC-3.3, AC-1.5) are noted in both story files as debts, never double-owned.

| AC | TC(s) | Primary Owner |
|----|-------|---------------|
| AC-1.1 | TC-1.2 | Story 1 |
| AC-1.2 | TC-1.1 | Story 1 |
| AC-1.3 | TC-1.1 | Story 1 |
| AC-1.4 | TC-1.3 | Story 2 |
| AC-1.5 | TC-1.4 (default/seeded leg) | Story 1 (boundary-active completion: Story 4 via TC-4.1/4.2) |
| AC-1.6 | TC-1.5 | Story 2 |
| AC-1.7 | TC-1.2 | Story 1 |
| AC-2.1 | TC-2.5 | AC primary: Story 2 (compact implementation preserves invoke-only). TC primary: Story 1 (status / no-uninvoked-compact leg) |
| AC-2.2 | TC-2.1 | Story 2 |
| AC-2.3 | TC-2.1 | Story 2 |
| AC-2.4 | TC-2.2 | Story 2 |
| AC-2.5 | TC-2.3, TC-2.7 | Story 2 |
| AC-2.6 | TC-2.4 | Story 2 |
| AC-2.7 | TC-2.1, TC-2.3, TC-3.4 | Story 2 (TC-3.4 leg: Story 3) |
| AC-2.8 | TC-2.5 | Story 1 |
| AC-2.9 | TC-2.2 | Story 2 |
| AC-2.10 | TC-2.6 | Story 2 |
| AC-3.1 | TC-3.1 | Story 3 |
| AC-3.2 | TC-3.1 | Story 3 |
| AC-3.3 | TC-3.1 | Story 3 |
| AC-3.4 | TC-3.2 | Story 3 |
| AC-3.5 | TC-3.3 | Story 3 |
| AC-3.6 | TC-3.4 | Story 3 |
| AC-3.7 | TC-3.3 | Story 3 (CLI execution leg: Story 5 process suite) |
| AC-4.1 | TC-4.2 | Story 4 |
| AC-4.2 | TC-4.2 | Story 4 |
| AC-4.3 | TC-4.1 | Story 4 |
| AC-4.4 | TC-4.5 | Story 4 |
| AC-4.5 | TC-4.3 | Story 4 |
| AC-4.6 | TC-4.4 | Story 4 |
| AC-4.7 | TC-4.4 | Story 4 |
| AC-4.8 | TC-4.5 | Story 4 |
| AC-4.9 | TC-4.6 | Story 4 |
| AC-5.1 | TC-5.1 | Story 5 |
| AC-5.2 | TC-5.2 | Story 5 |
| AC-5.3 | TC-5.2, TC-5.5 | Story 5 |
| AC-5.4 | TC-5.3 | Story 5 |
| AC-5.5 | TC-5.4 | Story 5 |

TC ownership count: Story 1 owns TC-1.1, TC-1.2, TC-1.4, TC-2.5 (4); Story 2 owns TC-1.3, TC-1.5, TC-2.1, TC-2.2, TC-2.3, TC-2.4, TC-2.6, TC-2.7 (8); Story 3 owns TC-3.1–TC-3.4 (4); Story 4 owns TC-4.1–TC-4.6 (6); Story 5 owns TC-5.1–TC-5.5 (5). Total 27/27. Story 0 owns FC-0.1–0.6 only.

## Cross-Story Debts

| Debt | Created | Closed | Mechanism |
|------|---------|--------|-----------|
| TC-2.5 view-health legs | Story 1 (pre-compact legs only) | Story 2 | status gains live view fields |
| AC-2.7 sweep section (`absent`) | Story 2 | Story 3 | receipt flips to `SweepReceipt \| { skipped: true }`; Epic 01 Story 4→5 queue-seam pattern, stated in both files |
| AC-1.5 boundary-active leg | Story 1 (seeded boundary) | Story 4 | TC-4.1/4.2 rendering assertions through real advances |
| TC-3.3 CLI execution leg | Story 3 (schema assertion) | Story 5 | process suite |
| CLI-intake-advances-boundary architecture-risk | Story 4 (in-process both-modes proof) | Story 5 | spawned CLI leg |

## Integration Path Trace

**Path A — harness serves a model call (pull):** intake commits → boundary check (seam) → pull assembles snapshot + tail → harness sends.

| Segment | Owner | TC |
|---------|-------|-----|
| intake commit → advance check fires (both modes) | Story 4 | TC-4.1, TC-4.6 |
| advance decision (sum, flip, floor) | Story 4 | TC-4.1, TC-4.3 |
| pull: snapshot bands verbatim | Story 2 | TC-1.3 |
| pull: tail render, kinds + short forms | Story 1 / Story 4 | TC-1.1, TC-1.4, TC-4.2 |
| pull: determinism / no side effects | Story 1 | TC-1.2 |

**Path B — operator compacts (the maintenance loop):** status → sweep → drain heals → compact → pull serves new view.

| Segment | Owner | TC |
|---------|-------|-----|
| status reads (threshold, derivation counts, view health, zone) | Story 1 / Story 2 | TC-2.5 |
| sweep classify + requeue | Story 3 | TC-3.1, TC-3.2 |
| background heal between sweeps | Story 3 (via Epic 02) | TC-3.4 |
| compact: validate, select, render, atomic replace, reset | Story 2 | TC-2.1–2.4 |
| compact: corruption refusal | Story 2 | TC-2.7 |
| post-compact pull | Story 2 | TC-2.6, TC-5.1 |

**Path C — closed-harness export:** compact → materialize → external load.

| Segment | Owner | TC |
|---------|-------|-----|
| materialize from pull output | Story 5 | TC-5.2 |
| format conformance | Story 5 | TC-5.5 |
| never-compacted export | Story 5 | TC-5.3 |
| CLI process boundary (all five commands) | Story 5 | TC-5.4 + parity legs |

No unowned segments.

## Story Shape Review

| Story | Type | Governing Idea | Overload Flags | Risk Flags | Split Decision |
|-------|------|----------------|----------------|------------|----------------|
| 0 | fixture/test + migration foundation | One fixture with production-manufactured derivation states underwrites every later story's tests | None | fixture fidelity | Keep |
| 1 | foundation/invariant (read path) | The pull's array shape is the contract every later story renders into | None | none beyond shape lock-in | Keep |
| 2 | orchestration/convergence | One atomic operation turns stored artifacts into the served snapshot | selection + rendering + persistence + receipts in one story | transition-state atomicity; fixture fidelity (goldens) | Keep: all four faces are one transaction's anatomy; splitting selection from rendering would put the arrangement contract and its consumer in different stories |
| 3 | repair/recovery | Failed derivations get exactly one sanctioned, classified path back to the queue | None | cross-epic gate (requeue patch + reason-class persistence) | Keep |
| 4 | semantic rule | One budget rule (log rotation) governs every visibility change in the tail | None | concurrency seam (advance/poke), source+derived coordinate consistency | Keep |
| 5 | adapter/mapping + capstone | The same view crosses two boundaries (file format, process) unchanged | capstone legs from Stories 3–4 land here | format fidelity; process-boundary debts | Keep: the debts are test legs, not behavior; the story stays one mapping idea |

## Sequencing Note

The published order follows the epic's breakdown and the design's chunk table: 0 → 1 → 2 → {3, 4} → 5. Stories 3 and 4 are mutually independent; either may build first once Story 2 lands. Story 3 additionally waits on its cross-epic gate (Epic 02 requeue patch + reason-class verification) — if the gate is unmet when Story 2 closes, Story 4 proceeds and Story 3 slots after.
