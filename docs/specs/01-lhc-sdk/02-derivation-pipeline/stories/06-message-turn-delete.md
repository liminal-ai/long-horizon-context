# Story 6: Message and Turn Delete

### Summary
<!-- Jira: Summary field -->

`messages.delete` and `turns.delete` as public SDK + CLI operations: projection-level removal with the event log intact, the prompt-protection rule routing whole-exchange deletes to the turn surface, and shrink-only membership.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The same daily itch, other half: "that exchange was a dead end — kill it." Message delete drops one message from the readable record; turn delete kills the exchange unit. Both leave the event log auditable.

**Objective:** The record's removal mutations ship on the cascade machinery Story 5 proved. Message delete drops the message from reads and membership (source event retained), cascades like an edit minus the message's own forms (dropped, not rebuilt). Deleting a turn's initiating prompt is refused with a pointed error naming the turn — `turns.delete` is the operation for that intent, removing the turn and its messages from reads, dropping its forms, shrinking its chunk. Membership only ever shrinks; boundaries never re-cut.

**Scope — in:**
- `messages.delete` (SDK + CLI): closed-turn non-initiating messages; message drops from reads and turn membership; source event remains in event read-back; the message's own forms drop (no rebuild of deleted content); upward cascade re-queues turn + chunk forms (minus-one composition)
- Prompt protection: deleting a turn's initiating user prompt is refused with an error naming the turn and the right operation (`turns.delete`)
- `turns.delete` (SDK + CLI): removes the turn and all its messages from reads, drops all their forms, removes the turn from its chunk, re-queues the chunk's summaries; events all retained
- Chunk-empties-out edge: deleting every turn in a chunk leaves an empty chunk contributing nothing to reads; summary forms dropped, not failed
- Deleted-read filters everywhere reads exist (tech design §Mechanics): messages, turns, membership, composition inputs all exclude deleted records; event read-back is the one surface that still shows source events
- Refusals: open-turn targets, unknown ids, double-delete — stable errors, no changes
- Shrink-only membership: delete never moves a turn between chunks, never re-cuts boundaries — the sanctioned exception to frozen membership shrinks containers in place

**Scope — out:** Restore/undelete (no requirement; the event log is the recovery substrate if ever needed). Block-level delete within a message (v1 boundary: whole message plus its blocks). Open-turn mutations (refused, as in Story 5).

**Dependencies:** Story 5 (cascade machinery + source-version check — delete reuses both; the check covers in-flight stragglers against deleted sources too). Deletes never touch a generated thread-view — visibility arrives at the next compact/rebuild (DD-12).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-6.1**: A deleted message no longer appears in message reads or its turn's membership; its source events remain in the event log, readable through the Epic 01 event read-back.
  - **TC-6.1** (AC-6.1): Delete a tool-result message → message reads and turn membership exclude it; event read-back still returns its events.
- **AC-6.2**: A deleted message's own derived forms drop with it; its turn's rendering and projection clear and re-queue; the containing chunk's summaries clear and re-queue; nothing else changes.
  - **TC-6.2** (AC-6.2): Delete a message in a two-chunk thread → its forms gone; turn forms and chunk-1 summaries `pending` and queued; chunk 2 untouched.
- **AC-6.3**: Deleting a message that initiates a turn is refused with an error naming the turn and the turn-delete path; nothing changes.
  - **TC-6.3** (AC-6.3): Delete a turn-initiating prompt → refused; error names the turn id and turns-delete; full read-back unchanged.
- **AC-6.4**: Deleting a turn through `turns` drops the turn and all its messages from the readable record and from chunk membership; source events remain.
  - **TC-6.4** (AC-6.4): Delete a three-message turn via `turns` → turn and messages gone from reads and chunk membership; events all present.
- **AC-6.5**: A deleted turn's chunk re-derives its summaries from the remaining turns; chunk boundaries do not move; no other chunk's membership or derivations change.
  - **TC-6.5** (AC-6.5): Two-chunk thread, delete a turn from chunk 1, drain → chunk 1 summaries rebuilt from remaining turns (double input proves source set); chunk 2 forms untouched; boundaries identical.
- **AC-6.6**: Deleting every turn in a chunk leaves an empty chunk that contributes nothing to reads; its summary forms are dropped, not failed.
  - **TC-6.6** (AC-6.6): Delete both turns of a chunk → chunk empty, summary forms absent, reads skip it without error.
- **AC-6.7**: Deletes against the open turn, missing ids, or already-deleted targets are refused with stable errors; refusal changes nothing; delete of the same id twice is a refusal, not a silent success.
  - **TC-6.7** (AC-6.7): Delete open-turn message; delete a bogus id; delete the same message twice → three refusals with stable codes; record identical after each.
- **AC-6.8**: Message delete and turn delete are available on the SDK and as CLI commands with parity.
  - **TC-6.8** (AC-6.8): Same delete via SDK and CLI on twin fixtures → identical results and read-back.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The second caller of Story 5's cascade module, plus the one discipline that touches every read path in the package: the **deleted-read filter**. Deletion stamps `deleted_at` on the projection row (the source event is never touched — record-never-destroyed); from that commit, message reads, turn reads, membership walks, composition input assembly, and report rows all exclude the record, while Epic 01's event read-back deliberately does not — it's the audit surface. The tech design's §Mechanics names each read site; the filter is one WHERE discipline applied everywhere, and the story's "no unfiltered read path" DoD item is the implementer's checklist.

Delete's cascade differs from edit's in one rule: the deleted subject's own forms **drop** (state rows removed — nothing to rebuild from a deleted source) while everything upward re-queues for minus-one composition. The prompt-protection refusal (`message_initiates_turn`, naming the turn and the turns-delete path) routes whole-exchange intent to `turns.deleteTurn` — a turn is a prompt and what came back for it; no prompt, no turn. Membership only ever shrinks; boundaries never re-cut (the sanctioned exception to Epic 01's frozen membership, and it shrinks in place).

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The filter's coverage is a global property (one missed read site is invisible until something composes a deleted message into a rendering), and the empty-chunk and double-delete edges are classic silent-wrongness shapes. The cascade itself is inherited and lower-risk.

Risk Reminders:
- TC-6.5's `captureInputs` assertion is the filter's sharpest test: the rebuilt summary's member projections must exclude the deleted turn — composition is the read path most likely to be missed.
- Empty chunk drops its summary forms (rows removed), never `failed` — and queues no rebuild (TC-6.6); a `failed`-state implementation poisons Epic 03's sweep with phantom repair work.
- Double-delete reads as `message_not_found` *because of the filter* — no tombstone-aware error branch; the filtered view is the validation view.
- Turn delete drops the turn's forms *and* all member messages' forms — the drop-set walk goes down as well as the re-queue walk goes up.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Delete operations | `src/domains/messages/index.ts` (`deleteMessage`), `src/domains/turns/index.ts` (`deleteTurn`) |
| Cascade reuse | `messages/internal/cascade.ts` (drop-vs-clear parameterization; turn-level entry) |
| Deleted filter | every read site per tech design §Mechanics: message reads, turn reads, membership, compose input loads, report queries |
| Storage | `deleted_at` columns (landed in Story 0's migration; first writes here) |
| CLI | `src/cli/messages-mutate.ts` (`lhc messages delete`), `src/cli/turns-mutate.ts` (NEW per §Placement: `lhc turns delete`) |
| Tests | `test/mutations.test.ts` (Flow 6 half), parity legs in `test/cli-process-work.test.ts`, full-suite regression run |

#### Design References

- [tech-design.md §Flows 5/6 (validation, drop semantics, refusal codes)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:233), line 233
- [tech-design.md §Mechanics (deleted-read filter rule — the site list)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:426), line 426
- [tech-design.md §Storage (deleted_at columns + rationale)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:182), lines 182–187
- [tech-design.md §Interfaces (deleteMessage/deleteTurn, MutationResult.dropped)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:336), lines 336–353
- [tech-design.md DD-8 (one cascade, two callers)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:87), line 87
- [test-plan.md §mutations suite (TC-6.x rows)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:89), lines 89–98

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-6.1 | `test/mutations.test.ts` | message gone from reads + membership; events present in read-back |
| TC-6.2 | `test/mutations.test.ts` | own forms dropped (rows gone); turn + chunk-1 forms pending/queued; chunk 2 untouched |
| TC-6.3 | `test/mutations.test.ts` | prompt delete refused `message_initiates_turn`, names turn + turns-delete path |
| TC-6.4 | `test/mutations.test.ts` | turn + messages gone; all forms dropped; membership shrinks; events present |
| TC-6.5 | `test/mutations.test.ts` | summaries rebuilt; captured inputs exclude deleted turn; chunk 2 + boundaries identical |
| TC-6.6 | `test/mutations.test.ts` | empty chunk: reads skip, forms dropped not failed, no rebuild queued |
| TC-6.7 | `test/mutations.test.ts` | three refusals incl. double-delete → `message_not_found`; state identical after each |
| TC-6.8 | `test/cli-process-work.test.ts` | both deletes via SDK/CLI twins: identical results + read-back |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Filter coverage at composition | TC-6.5 capture assertion | rebuild inputs exclude the deleted turn | Read-API tests pass with an unfiltered compose path; only input capture sees it |
| Cascade stops at the chunk | TC-6.5 chunk-2 + boundary assertion | neighboring chunk byte-stable, boundaries identical | "Summaries rebuilt" passes even if delete re-cut boundaries |
| Dropped ≠ failed | TC-6.6 | empty chunk's forms are *absent*, no rebuild queued | A failed-state implementation passes presence-style checks and corrupts the repair surface |
| Full-suite regression | `pnpm run verify-all` post-filter | Epic 01 + Stories 1–5 suites green with the filter live | The filter touches every read path; only the whole suite proves nothing else broke |

#### Technical Notes

**Delete cascade vs edit cascade** (epic Data Contracts): same walk, one difference — the deleted record's own forms *drop* (deleted-source forms have nothing to rebuild) while everything upward re-queues for minus-one composition:

| Operation | Target's own forms | Upward |
|-----------|--------------------|--------|
| edit m | cleared + re-queued | turn + chunk re-queued |
| delete m | dropped | turn + chunk re-queued |
| delete t | dropped (turn's and all members') | chunk re-queued |

**Deleted-read filter rule** (tech design §Mechanics): one filter discipline across every read path — message reads, turn reads, membership walks, composition input assembly, report rows. Event read-back deliberately unfiltered: the audit surface. The tech design names each read site; the implementation must not leave one unfiltered composition path.

**Tombstone semantics**: deletion marks the projection row; the source event is never touched (record-never-destroyed). Empty chunk: membership zero, summaries dropped, read assembly skips it.

**Prompt-protection rationale** (epic Flow 6): a turn is "a prompt and what came back for it" — assistant output with no anchoring prompt is incoherent at the record level and broken at provider-format level. No prompt, no turn.

**Cross-story debt** (coverage.md): the in-flight-straggler safety for deletes is Story 5's source-version check — this story writes no version-check test of its own; a regression surfaces in TC-5.4.

#### Anti-Shim Requirements

- One filter discipline, not per-site ad-hoc WHERE clauses — a shared filtered-read helper (or equivalent single point) so a new read path can't silently skip it.
- Drop means rows removed — not a `deleted` state value, not `failed`; the report must not show ghost rows for dropped forms.
- The source event row is never written to — deletes touch projection tables only; event read-back byte-stable across every delete variant.
- `turns.deleteTurn` validates through the same filtered view — deleting a turn whose messages were individually deleted first still works (membership walk on live rows).

#### Production Path Proof

- Entrypoint: `lhc messages delete`, `lhc turns delete`; SDK `deleteMessage`/`deleteTurn` — the "kill the dead-end exchange" operation from the epic's User Profile.
- Registration/default path: rebuild enqueues ride the standard path (background mode rebuilds unprompted); the filter is in force for every consumer from the same commit.
- Evidence: TC-6.8's spawned-CLI twins; TC-6.5's capture log proving the production compose path reads filtered.

#### Verification

- Targeted: `pnpm vitest run test/mutations.test.ts`; `LHC_PROCESS_SUITE=1 pnpm vitest run test/cli-process-work.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all` (this story's own DoD requires the full-suite regression)

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-6.1 through TC-6.8 green
- [ ] Architecture-risk tests green: cascade-stops-at-chunk (TC-6.5), empty-chunk dropped-not-failed (TC-6.6), prompt protection (TC-6.3)
- [ ] Event read-back shows all source events after every delete variant (audit surface intact)
- [ ] No unfiltered read path: deleted records absent from messages, turns, membership, composition inputs, and report
- [ ] CLI parity for both operations (TC-6.8)
- [ ] Verification gates green
