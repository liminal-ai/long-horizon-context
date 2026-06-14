# Epic 02 Story Coverage

Proof artifact for the story sharding. Source of truth: `../epic.md` (47 ACs / 46 TCs across six flows). Stories 0–6 in this folder.

## Coverage Gate

Every epic AC and TC lands in exactly one story. Extraction is mechanical (bold-marked AC/TC ownership per story file).

| Story | ACs owned | TCs owned | Count |
|-------|-----------|-----------|-------|
| 0 — Foundation | none (FC-0.1–0.7, story-local) | none | 0 / 0 |
| 1 — Queue Execution and Drain | AC-1.1–1.9 | TC-1.1–1.8 | 9 / 8 |
| 2 — Message-Level Derivation | AC-2.1–2.8 | TC-2.1–2.8 | 8 / 8 |
| 3 — Turn Composition and Chunk Formation | AC-3.1–3.9 | TC-3.1–3.9 | 9 / 9 |
| 4 — Derivation State, Report, and Repair | AC-4.1–4.7 | TC-4.1–4.7 | 7 / 7 |
| 5 — Message Edit and Cascade | AC-5.1–5.6 | TC-5.1–5.6 | 6 / 6 |
| 6 — Message and Turn Delete | AC-6.1–6.8 | TC-6.1–6.8 | 8 / 8 |
| **Total** | **47** | **46** | matches epic |

Missing ACs: 0. Extra ACs: 0. Double-owned: 0. TC→AC pairings preserved verbatim from the epic, including the two-AC TC (TC-1.5 covers AC-1.5 + AC-1.6).

## Cross-Story Debts

Explicit obligations one story leaves for another. Each is recorded in both stories' text.

- **Story 0 fixtures are golden-shaped until consumed.** The multi-state fixture asserts states that only exist for real once Stories 2–4 produce them; the damaged-source fixture is validated against Story 4's blocked path (TC-4.6). Debt: Stories 2/4 confirm the fixtures' claims; Story 0 proves only read-back of what the builders wrote.
- **Story 1 ships two dispositions it cannot exercise.** `superseded` and `stale_discarded` are mechanically present from Story 1, but no Story-1 TC can produce them — the cascade and source-version check that cause them arrive in Story 5. TC-5.4 is the test that cashes `stale_discarded` (drain report); cascade supersede-delete produces `superseded` (MutationResult). Until Story 5, those paths are dead code with a contract.
- **Story 2's late-result re-queue (AC-2.8) leans on queue dedupe.** The idempotent-enqueue semantics are stated as AC-4.5 (Story 4) but must hold mechanically from Story 1's enqueue path onward; TC-2.8's no-duplicates assertion is the early canary. If TC-2.8 finds duplicates, the fix is in Story 1's util, not Story 2's handler.
- **TC-3.3's re-queues run on Story 1's raw queue util; Story 4 ships the public operation.** Story 3 proves gap-no-auto-cascade by re-queueing a repaired dependency before the supported surface exists — its story note records the substitution. When Story 4's `requeue` lands, its refusal/idempotency semantics (AC-4.4–4.6) are the contract; TC-3.3's direct-enqueue usage stays a test-internal device, never a public path.
- **Story 5's source-version check covers Story 6.** Delete's in-flight-straggler safety is the same check TC-5.4 proves; Story 6 writes no version-check test of its own. If Story 6's cascades misbehave under in-flight work, the regression lands in TC-5.4's machinery.
- **Story 2 carries the sanctioned Epic 01 amendments** (F-03 patch): `tool_call` queueing changes exact work-row counts in `test/work-queue.test.ts` (3→4); the red manifest regenerates as a Story 2 step. Named in the test plan's Sanctioned Amendments section and Story 2's deviation table.
- **Deleted-read filters (Story 6) touch every prior story's read paths.** Message reads (Epic 01), report rows (Story 4), composition inputs (Story 3) all gain the filter. Story 6's DoD includes the no-unfiltered-path sweep; earlier stories need no change but their tests must still pass after the filter lands — Story 6 runs the full suite as its own regression gate.

## Integration Path Trace

Three end-to-end paths, traced story by story. Each step names the story that owns it.

**Path 1 — The pipeline (intake to report):** Epic 01 intake queues message work → Story 1 drain claims and dispatches → Story 2 handlers land message forms with stamped outcomes → Epic 01 turn close queues `turn_derivation` → Story 3 composes rendering + projection, places into chunk, close queues summaries → Story 3 summary handlers land both → Story 4 report shows every form `ready`. No gap: every arrow is an owned AC (AC-1.1/1.5, AC-2.1–2.4, AC-3.1/3.5–3.7, AC-4.2).

**Path 2 — Edit and rebuild:** Story 5 edit updates content + clears chain + re-queues (AC-5.1/5.2) → Story 1 drain runs rebuilds (AC-1.1) → Stories 2–3 handlers re-derive from new content (AC-5.3) → in-flight pre-edit straggler discarded by the source-version check (AC-5.4, disposition reported per Story 1's mechanics) → Story 4 report confirms post-edit states. Covered end to end; the source-version check is the single point both mutation stories depend on.

**Path 3 — Failure, degrade, repair:** Story 2 handler exhausts retries, form `failed` (AC-2.6, mechanics AC-1.9) → Story 3 composition falls back and records a gap, rendering `ready` (AC-3.2/3.3) → Story 4 report shows the failed form and the gap debt (AC-4.2/4.3) → explicit re-queue heals the failed form (AC-4.4) → the gapped composition rebuilds only on its own explicit re-queue, consuming the now-ready dependency (AC-3.3's no-silent-rebuild rule, exercised in TC-3.3). The degrade-don't-block thread runs through four stories and is the epic's core product behavior.

## Story Shape Review

- **1:1 flow-to-story mapping plus foundation.** Stories 1–6 own Flows 1–6 exactly as the epic's Recommended Story Breakdown cut them; no AC moved between flows during sharding. Story 0 owns the cross-cutting substrate (provider seam, state types, kinds, migration, fixtures) that the epic's breakdown lists as story 0.
- **Strictly linear dependencies.** 0→1→2→3→(4, 5)→6. Story 4 and Story 5 both stand on Story 3; they are order-flexible relative to each other (Story 5 consumes none of Story 4's surfaces — noted in Story 5), but the numbered order is recommended: the report makes cascade-test assertions cheaper to write.
- **Story 3 is the heaviest** (9 ACs / 9 TCs, two seams: composition and chunk formation). Kept whole deliberately: one governing invariant — *turn close deterministically produces composed artifacts and chunk placement* — and the seams share the projection artifact (placement consumes what composition produces) inside one handler's flow. Splitting would ship a handler whose second half lands a story later. Overload-reviewed; kept.
- **Story 4 combines report and repair** — visibility and recovery are one surface by design: the report's five distinctions exist precisely so re-queue decisions can be made from it, and TC-4.1's lifecycle walk needs both halves in one test. Overload-reviewed; kept.
- **Stories 5 and 6 are the deliberate split** of one mutation feature: edit proves the cascade machinery and the source-version check; delete adds removal semantics, the turns surface, and the read filters on top. The epic's breakdown explains the split; the version-check debt (above) is its cost, recorded.
- **Story 0 owns no behavior** and proves the gates (FC-numbered, same pattern as Epic 01's Story 0). Its largest real risk is the migration (FC-0.5: Epic 01 suite green on the migrated schema) — that gate is the story's point.
- **Future-boundary notes:** the report operation is the seam Epic 03's sweep consumes — it gains no scheduling or auto-repair here. The drain's host modes are the seam the PI extension (later epic) selects at construction. `DerivationProvider` doubles as the seam for Epic 03+ band work (chunk summaries are the bands' raw material). None of these widen in this epic.
