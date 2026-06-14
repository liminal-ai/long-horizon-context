# Story Lead Base Prompt

## Role Charter
You are the story lead for `06-message-turn-delete` on durable story run `06-message-turn-delete-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/stories/06-message-turn-delete.md
Bytes: 15336

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


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md
Bytes: 15071

# Epic 02: Derivation Pipeline — Test Plan

Companion to `tech-design.md`. Maps all 46 TCs to test files with setup and assertion. Conventions carried from Epic 01: real SQLite (temp dirs, no mocks of internal modules), TC ids in test titles, the deterministic provider double injected at the same seam production uses, process-spawned CLI tests under `LHC_PROCESS_SUITE=1`.

## Test Substrate

**Provider double** (`test/fixtures/provider-double.ts`): implements all seven `DerivationProvider` operations as marked input-derived output — `smoothed(…)`, `toolcall(…)`, `toolresult(…)`, `rendering(…)`, `projection(…)`, `detailed(…)`, `brief(…)` wrapping a deterministic digest of the input. Scripting API per test: `failNext(n, { retryable })`, `failKind(kind, n)`, `delayKind(kind, ms)`, `captureInputs()`. Determinism of the double itself is asserted in `fixtures.test.ts` (same input → same output, twice).

**Thread builders** (`test/fixtures/threads.ts`, extended): `threadWithClosedTurns(n, opts)`, `threadWithToolRun(opts)` (call+result pairs, error variants, missing-result variant), `threadWithChunks(policyOverride)` — all built through real intake, then drained with the double as needed. Multi-state fixture: builds a thread, scripts the double to fail selected kinds past budget, drains, yielding every form state in one file.

**SDK construction in tests:** `createSdk({ provider: double, mode: "manual", retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 }, lease: { durationMs: 200 } })` unless a test says otherwise. Background-mode tests construct with `mode: "background"` and await `drainSettled`. Spawned CLI process tests set `LHC_PROVIDER` to the deterministic provider registered through the same named-provider registry production uses; no spawned test injects a provider through a test-only path.

## Suites

### `work-execution.test.ts` — Flow 1 (in-process)

Storage-contract assertions (the ambiguities pinned in design round 1) ride the TCs in this suite:

- **Terminal dispositions** (DD-1, reported-then-deleted): TC-1.1 asserts the drain report's `disposition='done'` entries **and that the work rows are gone** (raw read: zero rows for the drained ids); TC-1.8's exhaustion leg asserts the report's `failed_terminal` plus the form `failed` carrying reason + final attempts, row deleted; TC-5.4 (mutations suite) asserts the stale item reports `stale_discarded`, row deleted, rebuilt form untouched; the supersede path is asserted in TC-5.3 on the **MutationResult** (`superseded` ids listed; raw read confirms rows deleted — a drain never sees them); TC-4.6 asserts the blocked-source item reports `failed_terminal` with the form `blocked`, row deleted.
- **Reclaim attempts**: TC-1.3's reclaim assertion is now exact — the killed item's `attempts` incremented by the reclaim CASE, visible in the report as the crash signal.
- **Backoff eligibility**: TC-1.8's retry leg uses non-zero `backoffBaseMs` (50ms) for one assertion: after first failure, item has `eligible_at > now` and the drain stops with `stoppedBecause: "waiting"` and `waitingUntil` set — and a queued item behind the backing-off head is not claimed (head-first rule) — until the injected clock passes the gate, proving eligibility gates the head and the head gates the queue |

| TC | Setup | Assertion |
|---|---|---|
| TC-1.1 | Thread with 3 queued items across owners (intake-built); manual drain | Report `ran` lists 3 in queue order with dispositions `done`; `derived_form` rows ready in that order (derivedAt monotone with injected clock) |
| TC-1.2 | Background mode; `delayKind(prompt_smoothing, 50)`; intake batch A; during drain, intake batches B, C | `drainSettled` resolves; all forms ready; scheduler test-hook records exactly 2 passes (initial + one coalesced) |
| TC-1.5 | Background mode; intake one prompt; no drain call | `drainSettled` → smoothed form ready. Second leg: build thread manual-mode, leave 2 queued rows, reopen SDK background-mode, touch thread with a read → catch-up runs them |
| TC-1.6 | Manual mode; intake prompt; assert no form change after 100ms; then `work.drain` | Rows sit `queued` until drain; ready after |
| TC-1.7 | Insert raw `work_item` row with kind `bogus_kind` ahead of a valid item; drain | Bogus item disposition `failed_terminal` reason `unknown_work_kind`; valid item `done`; drain did not throw |
| TC-1.8 | `failNext(2, { retryable: true })` on smoothing; drain | Form ready, item attempts=2 (report). Second leg: `failKind(prompt_smoothing, 99)`; drain → item `failed_terminal`, form `failed` with provider reason; next item still ran |

### `cli-process-work.test.ts` — Flow 1 (spawned processes, `LHC_PROCESS_SUITE=1`)

| TC | Setup | Assertion |
|---|---|---|
| TC-1.3 | Spawn a runner script that drains a 3-item thread with `delayKind(*, 5000)`; SIGKILL after item 1's complete lands (runner prints a marker line per completion; kill on first marker); reopen in-process; drain | Items 2, 3 run to done; item 1's form content unchanged (byte-compare against pre-kill read); no duplicate form rows; attempts on item 2 reflect the reclaim |
| TC-1.4 | Process A claims head item and holds (runner sleeps mid-handler, lease 10s); queued item sits behind it; process B (CLI `lhc work drain`) | B's report JSON: `stoppedBecause: "in_flight"`, `ran: []`, `remaining: 2`; the queued item behind the live head was not claimed (skip-ahead proof); B exit 0; A finishes normally |
| CLI parity | `lhc work drain --file-path` on a queued thread | Report JSON matches SDK shape; exit codes: 0 with work, 0 empty, 1 on missing thread |

### `derivation-messages.test.ts` — Flow 2

| TC | Setup | Assertion |
|---|---|---|
| TC-2.1 | Intake prompt; drain | `smoothed_prompt` ready; content === double's deterministic output for the prompt text |
| TC-2.2 | Intake `tool_call` event | Batch result lists `tool_call_summary` item; intake return precedes any handler run (double's capture log empty at return); after drain: summary ready, contains tool name + args digest |
| TC-2.3 | `threadWithToolRun` (300KB result); drain | `tool_result_summary` ready; full result content byte-identical via Epic 01 read-back |
| TC-2.4 | Three variants: result ok / result isError / call without result; identical double text for all three | Outcomes `succeeded` / `failed` / `unknown` respectively, read from `derived_form.metadata` — not parsed from `content` — proving outcome is record-derived, text-independent, and machine-readable apart from provider prose |
| TC-2.5 | `captureInputs()`; drain a tool-call summary | Captured input contains call + paired result only; no turn fields |
| TC-2.6 | `failKind(prompt_smoothing, 99)`; drain | Form `failed` + reason; message read-back unaffected |
| TC-2.7 | Intake assistant_text + runtime_note; drain | No work items for them; no `derived_form` rows |
| TC-2.8 | Intake `tool_call` alone; drain (summary lands, `metadata.outcome = "unknown"`); intake paired `tool_result` in a later batch; drain | Summary re-queued by the result's intake (batch result shows the item); after drain: one summary form, outcome `succeeded`, source version advanced, no duplicate rows. Control leg: call+result in one batch → capture log shows summary ran once, no re-queue |

### `derivation-turns.test.ts` — Flow 3

| TC | Setup | Assertion |
|---|---|---|
| TC-3.1 | Closed turn, all message forms ready; drain | `turn_rendering` + `lower_band_projection` ready, independent rows |
| TC-3.2 | Fail one prompt's smoothing past budget; close turn; drain | Rendering ready; contains raw prompt text; gap recorded `{message, smoothed_prompt}` |
| TC-3.3 | From TC-3.2 state: requeue + drain the smoothing (now healthy) | Rendering unchanged, gap still present in report; then requeue rendering → rebuilt, gap empty, source version incremented |
| TC-3.4 | `threadWithToolRun`: 3-call edit run, one isError | Rendering part for the run carries outcome; failed call's outcome `failed` present in the account |
| TC-3.5 | Drain a closed turn | Turn read-back shows chunkId + memberIdx |
| TC-3.6 | Policy override target=100; turns projecting ~40 each | Third turn's placement closes chunk at 2 members; third opens chunk 2 |
| TC-3.7 | One turn projecting 250 (max=200) | Own chunk, closed immediately |
| TC-3.8 | Close a chunk; drain | Both summaries ready, `detailed(…)`/`brief(…)` marked distinct; then `failKind(chunk_summary_brief, 99)` on a second chunk → detailed ready, brief failed, requeue brief alone succeeds |
| TC-3.9 | Replay identical event stream into fresh thread, same policy | Identical chunk membership and boundaries (deep-compare chunk/chunk_member) |

### `report-repair.test.ts` — Flow 4

| TC | Setup | Assertion |
|---|---|---|
| TC-4.1 | Multi-state fixture (ready/failed/pending/blocked) | Report returns each with exact state; failed carries stable reason code |
| TC-4.2 | `failNext(1, { retryable: true })`, drain with budget 3, inspect mid-retry (backoff 0 → use captured report between attempts via maxItems=1) | Entry: state `pending`, queue `{ attempts: 1, lastError }` |
| TC-4.3 | Mixed fixture | Owner reports list own forms only; `notReady: true` returns exactly failed+pending+blocked set |
| TC-4.4 | Failed smoothing; `messages.requeue`; drain healthy | Form ready; reason cleared; source version incremented; requeue inserted the deterministic id for the current source version without collision (the failed item's row was deleted at exhaustion — DD-1) |
| TC-4.5 | Requeue same form twice before drain | First `{workItemId}`, second `{noop: "already_queued"}`; one live item in queue read |
| TC-4.6 | Fixture with manufactured turn corruption under a queued `turn_derivation` (Epic 01's two-open-turns fixture pattern) | Form `blocked` reason `source_damaged`; drain continued; requeue refused with that reason |
| TC-4.7 | Thread with every non-ready state | All message/turn reads return records + states; zero errors |

### `mutations.test.ts` — Flows 5 & 6

| TC | Setup | Assertion |
|---|---|---|
| TC-5.1 | Edit prompt in closed turn | Content + blocks + token estimate updated synchronously; result names cleared forms and queued items |
| TC-5.2 | Two-chunk thread; edit message in chunk 1 | Cleared set exactly: message forms + turn's 2 forms + chunk 1's 2 summaries; chunk 2 forms untouched (state + source version unchanged) |
| TC-5.3 | All forms ready; edit | Immediately post-return: dependent forms `pending`, queue holds replacement items at new source version; replacement item ids include that source version; superseded queued ids on the MutationResult, rows deleted |
| TC-5.4 | `delayKind(prompt_smoothing, 200)`; background drain claims old-content item; edit during the delay; `drainSettled` | Final form content derives from post-edit text; old claimed item and replacement item coexist because ids include source version; stale completion discarded (source-version mismatch); exactly one ready row |
| TC-5.5 | Edit open-turn prompt → `turn_open`; edit bogus id → `message_not_found` | Both refused; full read-back unchanged after each |
| TC-5.6 | Same edit via SDK and spawned CLI on twin fixtures | Identical result JSON, cascade, and read-back |
| TC-6.1 | Delete a tool-result message | Message reads and turn membership exclude it; event read-back returns its events |
| TC-6.2 | Two-chunk thread; delete message in chunk 1 | Its forms dropped (rows gone); turn + chunk-1 forms pending and queued; chunk 2 untouched |
| TC-6.3 | Delete turn-initiating prompt | Refused `message_initiates_turn`; error names turn id and turns-delete path; nothing changed |
| TC-6.4 | Delete 3-message turn via `turns.deleteTurn` | Turn + messages gone from reads and chunk membership; events present |
| TC-6.5 | Two-chunk thread; delete a turn from chunk 1; drain | Chunk-1 summaries rebuilt; `captureInputs` proves member projections exclude deleted turn; chunk 2 untouched; boundaries identical |
| TC-6.6 | Delete both turns of a chunk | Chunk empty; summary form rows dropped; reads skip it without error |
| TC-6.7 | Delete open-turn message / bogus id / same id twice | Three refusals: `turn_open`, `message_not_found`, `message_not_found`; record identical after each |
| TC-6.8 | Message delete + turn delete via SDK and CLI twins | Identical results and read-back |

CLI parity legs of TC-5.6/TC-6.8 live in `cli-process-work.test.ts` alongside the other spawned tests.

## Sanctioned Epic 01 Test Amendments (F-03 patch)

Two Epic 02 changes touch Epic 01's exact assertions. Both amendments are **sanctioned in advance** — the red-manifest immutability gate requires regenerating `test/red-manifest.json` as an explicit step of the story that makes each change, recorded in its deviation notes:

**Story 0 — versioned work-item ids (DD-1/DD-3).** Ids gain the source-version suffix: `w-t1-turn_derivation` → `w-t1-turn_derivation-v1`. Every exact-id assertion in Epic 01 suites updates accordingly — known sites: `test/work-queue.test.ts` (~8 `workItemId:` literals), `test/cli-process-work-queue.test.ts` (2). Sweep `"w-` literals during Story 0 red phase and list each in the deviation table.

**Story 2 — `tool_call` queues `tool_call_summary`:**

- `test/work-queue.test.ts` — restart-survival test: raw `work_item` count for a `prompt + tool_call + tool_result + turn_end` batch goes **3 → 4 rows** (`messageWork` 2 → 3); any `toEqual` on the queued-work array gains the `tool_call_summary` entry.
- `test/work-queue.test.ts` — TC-2.9 kind-gate test: unchanged (text/thinking/note still queue nothing), but its comment naming the exact gate should note `tool_call` now queues.
- Any other Epic 01 assertion enumerating queued work for batches containing `tool_call` (sweep `queuedWork`/`rawWorkItemCount` usages during Story 2 red phase and list each amendment in the story's deviation table).

No other Epic 01 test changes are sanctioned; anything further found necessary is a ruling, not an edit.

## Architecture-Risk Tests

The four that guard this epic's load-bearing properties, called out per the tech-design skill:

1. **TC-1.3 (restart survival)** — durable queue + reclaim is the epic's core promise (AC-1.3). Process-spawn fixture with completion markers; the kill lands between claim and complete.
2. **TC-1.4 (claim exclusion)** — serial-per-thread across processes; the lease is the only cross-process coordination.
3. **TC-5.4 (stale-result check)** — the source-version check is what makes clear-and-regenerate safe under concurrency; this is the fingerprint lesson's inverse, proven mechanically.
4. **TC-3.9 (chunk determinism)** — replay-identical boundaries guard against the v1 single-turn-threshold regression and any hidden nondeterminism in placement.

## Coverage

46 TCs across 6 suites + fixture validity tests. Every AC traced in the epic's tables; every TC above names file, setup, assertion. Estimated new tests ≈ 60–70 including parity legs and fixture assertions, on top of Epic 01's 118.


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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/06-message-turn-delete/story-lead/001-current.json
Bytes: 964

```yaml
storyRunId: "06-message-turn-delete-story-run-001"
storyId: "06-message-turn-delete"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/06-message-turn-delete/001-story-validate.json"
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
updatedAt: "2026-06-11T06:40:04.207Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/06-message-turn-delete/story-lead/001-events.jsonl
Bytes: 222

```yaml
-
  storyRunId: "06-message-turn-delete-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T06:40:04.206Z"
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
Bytes: 223

```yaml
storyGate: "pnpm run green-verify"
epicGate: "pnpm run verify-all"
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
