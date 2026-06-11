# Story Lead Base Prompt

## Role Charter
You are the story lead for `05-message-edit-cascade` on durable story run `05-message-edit-cascade-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/stories/05-message-edit-cascade.md
Bytes: 15476

# Story 5: Message Edit and Cascade

### Summary
<!-- Jira: Summary field -->

`messages.edit` as a public SDK + CLI operation: canonical content change plus full dependent-form cascade in one transaction, with the source-version check proving in-flight pre-edit work can never overwrite post-edit rebuilds.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The user who is bothered at least once a day that they can't fix a bad message. `lhc messages edit --file-path ./t.lhc --message m42 --content "..."` — and the forms built on m42 clear and rebuild behind it.

**Objective:** The record's first sanctioned mutation ships whole. Edit changes a closed-turn message's content and blocks, re-stamps the token estimate, and in the same transaction walks the derivation chain upward — the message's own forms, its turn's rendering and projection, the containing chunk's summaries — clearing each to `pending` and re-queueing. The event log keeps the original (projection-level mutation; Epic 01's events remain immutable). The ordering guarantee makes the cascade safe: an in-flight pre-edit item that completes after the edit discards against the source-version check; the post-edit artifact wins regardless of completion order. Edit never touches a generated thread-view — visibility arrives at the next compact/rebuild (DD-12).

**Scope — in:**
- `messages.edit` (SDK + CLI): validates target (closed turn, message exists, not deleted), updates content and blocks, re-stamps the token estimate, cascades, returns the `MutationResult` (changed / cleared / queued / superseded)
- Cascade scope, walking the chain upward in one transaction: the edited message's own forms → its turn's rendering + projection → the containing chunk's detailed + brief summaries; cleared to `pending`, re-queued (dedupe applies); nothing outside the chain touched
- Post-edit invariant: when edit returns, no derivation built from pre-edit content is `ready` — every cleared form is `pending` with replacement work queued in the edit's transaction (AC-5.3)
- Source-version check: each clear bumps the form's `source_version`; a completing work item carrying a stale version discards (reported `stale_discarded`) rather than landing content; still-queued old items are supersede-deleted in the cascade transaction and reported on the MutationResult
- Edit refusals: open-turn target, unknown message id, deleted message — stable errors, nothing changes
- Mutation NFR: edit is synchronous and local — record update and cascade commit together before the operation returns

**Scope — out:** Delete (Story 6 — same cascade machinery, removal semantics on top). Open-turn mutations (refused; v1 boundary per the epic). Rebuild execution itself (the drain — Stories 1–3 machinery — runs the re-queued work; this story proves the queueing and the version check). Any generated thread-view refresh (none in this epic; DD-12).

**Dependencies:** Logically Story 3 (the full chain — message forms through chunk summaries — must exist to cascade through). Recommended after Story 4 for test visibility: the cascade TCs assert form states, and the report surface makes those assertions direct — the epic's breakdown orders it this way for that reason.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-5.1**: An edit to a message in a closed turn updates content and blocks and re-stamps the token estimate in one synchronous transaction; the edit result reports the content change, cleared forms, and queued work.
  - **TC-5.1** (AC-5.1): Edit a prompt in a closed turn → content and estimate updated synchronously; result names cleared forms and queued items.
- **AC-5.2**: The cascade clears exactly the dependent set: the message's own forms, its turn's rendering and projection, and the containing chunk's summaries; forms of other messages, other turns, and other chunks are untouched.
  - **TC-5.2** (AC-5.2): Thread with two chunks, edit a message in chunk 1 → cleared set is exactly that message's forms + its turn's two forms + chunk 1's two summaries; chunk 2's forms still `ready`.
- **AC-5.3**: After an edit returns, no derivation built from pre-edit content is in `ready` state; every cleared form is `pending` with replacement work queued in the edit's transaction.
  - **TC-5.3** (AC-5.3): Edit while forms are `ready` → immediately after return, all dependent forms `pending`, queue holds their work.
- **AC-5.4**: An in-flight derivation started against pre-edit content cannot land over a post-edit rebuild: the post-edit artifact wins regardless of completion order.
  - **TC-5.4** (AC-5.4): Slow double processing old-content smoothing; edit mid-flight; let both complete → final form is post-edit content's smoothing.
- **AC-5.5**: An edit against a message in the open turn is refused with a stable error; an edit against a missing message is refused; refusal changes nothing.
  - **TC-5.5** (AC-5.5): Edit the open turn's prompt → refused, stable code; edit a missing id → refused; read-back unchanged after both.
- **AC-5.6**: Edit is available on the SDK and as a CLI command with parity: same validation, same result shape, same cascade.
  - **TC-5.6** (AC-5.6): Same edit via SDK and CLI on twin fixtures → identical result shape, identical cascade, identical read-back.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The first sanctioned mutation, and the test of everything underneath it. `messages.edit` runs one transaction (DD-8): validate against the deleted-filtered read (`turn_open` / `message_not_found` refusals), apply content + blocks + token re-stamp, then the cascade from `messages/internal/cascade.ts` — bump source version and set `pending` on every dependent form (the message's own, the turn's two, the chunk's two), supersede-delete still-queued old-version items (issue 1's tidy-up, ids reported on the result), enqueue replacements at the new source version, register the poke. Claimed old-version items may still finish; their results are discarded by the source-version check. One commit carries all of it; the operation returns `MutationResult`.

The **source-version check** is the story's architectural heart and TC-5.4 is the epic's named architecture-risk test: a pre-edit item that completes after the edit writes through `forms.ts`'s version check, mismatches, and discards as `stale_discarded` (row deleted, outcome reported) — the post-edit rebuild stands regardless of completion order (AC-5.4). The rule in one line: a background result must not overwrite a derived form if the source changed since the job was queued. The check was built in Story 0, enforced from Story 2's first form write; this story is where it's finally *provoked*. Same machinery serves Story 6's deletes — the cascade module has two callers by design.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The cascade's exactness (everything in the chain, nothing outside it), transactional atomicity, and the version check's race resolution are all properties that fail silently under a weaker build discipline; TC-5.4 specifically requires orchestrating a mid-flight overlap.

Risk Reminders:
- TC-5.2's untouched-set assertion is as load-bearing as the cleared-set: chunk 2's forms must show *unchanged state and source version* — cascade over-reach is the symmetric failure.
- TC-5.4 needs the delayed double (`delayKind`) + background drain + `drainSettled` — the deterministic recipe is in the test plan; don't substitute sleeps.
- Edit re-stamps the token estimate synchronously (Epic 01's estimator) — forgetting it leaves placement arithmetic stale after edits.
- The refusal reads through the *deleted-filtered* view — a deleted message edits as `message_not_found`, not as a new error code.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Edit operation | `src/domains/messages/index.ts` (`edit`) + internal validate/apply |
| Cascade module | `src/domains/messages/internal/cascade.ts` (NEW: walk-and-clear, both mutation kinds parameterized) |
| Supersede | work-queue `supersedeQueued` (Story 1 util, first real caller) |
| Version-check enforcement | `forms.ts` version-checked UPDATE-only write (existing; provoked here) + drain completion discard path |
| CLI | `src/cli/messages-mutate.ts` (NEW per §Placement: `lhc messages edit --file-path --message --content`) |
| Tests | `test/mutations.test.ts` (NEW, Flow 5 half), parity legs in `test/cli-process-work.test.ts` |

#### Design References

- [tech-design.md §Flows 5/6 (transaction walk, refusals)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:233), line 233
- [tech-design.md DD-8 (cascade module, one transaction, two callers)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:87), line 87
- [tech-design.md §Mechanics (source-version truth table; cascade algorithm)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:410), lines 410–424
- [tech-design.md §Interfaces (MutationResult, edit signature, error codes)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:334), lines 334–377
- [tech-design.md §Issue 1 (supersede decision trail)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:97), line 97
- [test-plan.md §mutations suite (TC-5.x rows)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:79), lines 79–88

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-5.1 | `test/mutations.test.ts` | content + blocks + estimate synchronous; result names cleared + queued |
| TC-5.2 | `test/mutations.test.ts` | cleared set exact (5 forms); chunk 2 state *and source version* unchanged |
| TC-5.3 | `test/mutations.test.ts` | post-return: dependents `pending`, replacements queued at new source version; replacement ids include source version; superseded queued ids on the MutationResult, rows deleted |
| TC-5.4 | `test/mutations.test.ts` | delayed old-content item discards on version mismatch; exactly one ready row from post-edit content |
| TC-5.5 | `test/mutations.test.ts` | `turn_open` + `message_not_found` refusals; read-back unchanged after each |
| TC-5.6 | `test/cli-process-work.test.ts` | SDK/CLI twins: identical result JSON, cascade, read-back |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Version check beats the straggler | TC-5.4 | stale completion discards; `stale_discarded` reported by the drain; one ready row | The race window only opens under orchestrated overlap; every sequential test passes without the check existing |
| Cascade reach exactness | TC-5.2 both directions | five cleared, rest byte-stable | A clears-everything cascade passes the cleared-set half; only the untouched-set assertion catches over-reach |
| Atomicity | TC-5.1 + induced failure | a failing cascade step rolls back the content change too | Post-hoc state checks can't distinguish two transactions that both happened to commit |

#### Technical Notes

**Cascade table** (epic Data Contracts — edit of message m in turn t, chunk c):

| Level | Cleared and re-queued |
|-------|----------------------|
| message | m's own forms (smoothing or tool summaries as applicable) |
| turn | t's rendering, t's projection |
| chunk | c's detailed summary, c's brief summary |

Nothing past c: chunk summaries derive from their own members only — the cascade's reach is structural, not configured.

**Source-version mechanics** (tech design §Mechanics): `derived_form.source_version` increments on every clear; work items carry the version at queue time; completion writes content only when versions match, else discards as `stale_discarded`. The check makes AC-5.4 a mechanical truth-table row, not a race.

**Edit result shape** (tech design §Interfaces): `MutationResult` — `changed` (messageIds/turnIds), `cleared` (subject + form per clear), `dropped` (delete only; empty for edit), `queued` (workItemId + kind), `superseded` (old item ids the cascade tidied).

**Refusal codes** (tech design error table): `turn_open`, `message_not_found` — stable constants per Epic 01's error-code pattern; deleted targets read as `message_not_found` through the filtered view.

**Cross-story debts cashed here** (coverage.md): `superseded` and `stale_discarded` — the two dispositions Story 1 shipped dead — get their first real producers (cascade supersede-delete on the MutationResult; version-check discard on the drain report). TC-5.4 is the test the coverage artifact names as cashing the `stale_discarded` row.

#### Anti-Shim Requirements

- The cascade derives its clear-set from the record's structure (message → turn → chunk walk) — never from a hardcoded form list that would silently miss future forms.
- The version check lives in the *single* form-write path — no second write path that skips it.
- Stale discard is a normal completion (`done`/`stale_discarded`), not an error or a retry — the straggler must not requeue itself.
- No version-check shortcuts: TC-5.4 must hold a real claimed old-version item across the edit (delayed double), enqueue the replacement at the new source version, and prove the old result is discarded rather than simulating the mismatch by poking source versions directly.

#### Production Path Proof

- Entrypoint: `lhc messages edit` and `messages.edit` — the user-facing operation the epic's User Profile names (the daily itch).
- Registration/default path: cascade enqueues ride the standard path; in background mode the rebuilds run with no further call — edit-and-walk-away is the product behavior.
- Evidence: TC-5.6's spawned-CLI twin proves the full production surface; TC-5.4 proves the race the production scheduler actually creates.

#### Verification

- Targeted: `pnpm vitest run test/mutations.test.ts`; `LHC_PROCESS_SUITE=1 pnpm vitest run test/cli-process-work.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

| Date | Deviation | Disposition |
|---|---|---|
| 2026-06-10 | Pre-implementation patch: source-version / stale-result wording clarified (mechanics unchanged); supersede = delete + MutationResult report; edits never touch generated thread-views (DD-12) | Spec updated before implementation; build to current text |

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-5.1 through TC-5.6 green
- [ ] TC-5.4 green — the epic's named architecture-risk test (version check beats the straggler)
- [ ] Cascade precision proven both directions: everything in the chain cleared, nothing outside it touched (TC-5.2)
- [ ] Synchronous mutation proven: content, estimate, and full cascade commit in the edit's transaction before return (TC-5.1, TC-5.3)
- [ ] CLI parity and burst coalescing (TC-5.6)
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/05-message-edit-cascade/story-lead/001-current.json
Bytes: 967

```yaml
storyRunId: "05-message-edit-cascade-story-run-001"
storyId: "05-message-edit-cascade"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/05-message-edit-cascade/001-story-validate.json"
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
updatedAt: "2026-06-11T05:57:10.259Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/05-message-edit-cascade/story-lead/001-events.jsonl
Bytes: 223

```yaml
-
  storyRunId: "05-message-edit-cascade-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T05:57:10.258Z"
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
