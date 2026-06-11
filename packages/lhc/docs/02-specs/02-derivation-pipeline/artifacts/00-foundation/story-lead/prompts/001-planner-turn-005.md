# Story Lead Base Prompt

## Role Charter
You are the story lead for `00-foundation` on durable story run `00-foundation-story-run-001`.
Select exactly one bounded next action for this `resume` turn.
This is planner turn 5.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/stories/00-foundation.md
Bytes: 15570

# Story 0: Foundation

### Summary
<!-- Jira: Summary field -->

Provider seam and deterministic double, derivation state vocabulary as shared types, work-kind registry extension, handler-map assembly, queue mechanical fields migration, multi-state fixtures — the substrate Stories 1–6 stand on.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): Primary user at this stage is the implementing team itself — every later story consumes these contracts; harness integrators and agents feel this story only through the stories built on it.

**Objective:** The shared surfaces exist and are proven inert-correct before any behavior uses them: the `DerivationProvider` interface with a deterministic test double, the four-state derived-form vocabulary as types, the extended work-kind registry with handler-map assembly at SDK construction, the Epic 01 `work_item` table migrated with the queue's mechanical fields, and the fixture builders for multi-state threads.

**Scope — in:**
- `DerivationProvider` interface: all seven semantic operations (`smoothPrompt`, `summarizeToolCall`, `summarizeToolResult`, `composeTurnRendering`, `projectLowerBand`, `summarizeChunkDetailed`, `summarizeChunkBrief`), structured result carrying content or retryable-or-not failure
- Deterministic double implementing all seven with marked, input-derived output; per-test failure injection (fail-N-then-succeed, fail-always with retryable/terminal flag, latency)
- Derived-form state vocabulary as shared types: `pending` | `ready` | `failed` | `blocked`, the `DerivedForm` read shape (form, state, content?, reason?, derivedAt?, gaps?, metadata with mechanically-stamped outcome for tool-activity forms)
- Work-kind registry extension: `tool_call_summary`, `chunk_summary_detailed`, `chunk_summary_brief` added to the Epic 01 kind set; handler-map assembly at SDK construction from per-domain contributions; unknown-kind lookup reports the miss explicitly
- Schema migration on the Epic 01 `work_item` table adding the queue's mechanical fields (claim, attempts, eligibility — exact fields per tech design §Storage; no disposition column — terminal rows are deleted, outcomes reported in-memory per DD-1) **plus the F-02 backfill**: pending `derived_form` rows for any live queued items existing at upgrade (tech design §Storage); Epic 01's full suite green after migration
- Fixture builders: multi-state thread (forms in every state), damaged-source fixture (per Epic 01 corruption definitions), twin SDK/CLI fixtures for parity tests

**Scope — out:** Any drain or scheduling behavior (Story 1). Real handlers (Stories 2–3). Report and re-queue surfaces (Story 4). Mutations (Stories 5–6). The host-mode construction option lands with the scheduling behavior it selects (Story 1), not as an inert flag here.

**Dependencies:** Epic 01 complete (intake, projection, turn state machine, work-item queueing, read-back, error classes, verification gates).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

Story 0 owns no epic ACs. Its acceptance is foundation criteria, proven by focused invariant tests:

- **FC-0.1**: The `DerivationProvider` interface exists with all seven semantic operations; the deterministic double implements every operation with marked output derived purely from input.
- **FC-0.2**: Double determinism is proven: identical input to the same operation yields identical output across double instances; different operations are distinguishable in their marked output; failure injection drives fail-N-then-succeed, terminal failure, and latency per test configuration.
- **FC-0.3**: The derived-form state vocabulary and `DerivedForm` read shape exist as shared types consumed by both owning domains; tool-activity outcome lives in machine-readable metadata, never inside provider-authored content.
- **FC-0.4**: The work-kind registry covers all six kinds with owner and sourceRef semantics per the epic's Work Item contract; handler maps assemble at SDK construction from domain contributions; looking up an unregistered kind reports the miss explicitly rather than throwing or returning silence.
- **FC-0.5**: The `work_item` migration applies to an Epic 01 thread file in place; Epic 01's full test suite runs green against the migrated schema.
- **FC-0.6**: Fixture builders produce the multi-state thread, the damaged-source thread, and twin SDK/CLI threads, each verified by reading back the states they claim to set up.
- **FC-0.7**: The Epic 01 verification rail (`red-verify` / `verify` / `green-verify` / `verify-all`) runs against this story's tests; gates green.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 0 is the tech design's Chunk 0: the substrate every later story dispatches through. Three seams land inert-correct here. The **provider seam** (DD-7) is dependency injection at SDK construction — the deterministic double implements the same `DerivationProvider` interface production adapters will, so tests exercise the production seam, not a mock of internals. The **handler map** (DD-6) is the only join between the queue's opaque kinds and domain code; it assembles at `createSdk` from per-domain `workHandlers` tables. The **enqueue wrapper** (DD-5) makes "queueing is what schedules processing" structural: `enqueue` writes the work row *and* creates-or-resets the form's `pending` state row in the ambient transaction (enqueue is the only place form rows are created — completion is UPDATE-only), and registers the scheduler poke on `ctx.onCommit` — row, state, and poke all commit or all vanish together.

One ownership decision this story carries: **migration v5 is the epic's single migration** (tech design §Storage), so the chunk tables and `deleted_at` columns land here even though their behavior arrives in Stories 3 and 6. The schema ships whole; behavior arrives story by story.

#### Build Strategy

Strategy: tdd-lite

Reason:
- Foundation contracts are easy to shortcut (a double returning canned constants, a migration that passes by skipping Epic 01's suite, an enqueue that writes the form row outside the transaction). Red tests pin each contract before implementation.

Risk Reminders:
- FC-0.5 is the hard gate: Epic 01's full suite green against the migrated schema — run it migrated, not fresh.
- Enqueue atomicity: row + `pending` form + poke must all drop on rollback (Chunk 0's named risk).
- Double determinism is asserted (same input → same output, twice), never assumed.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Shared types | `src/shared/derivation.ts` (NEW: FormKind, DerivedFormState, DerivedForm, DependencyGap, ToolOutcome) |
| Context hook | `src/shared/context.ts` (gains `onCommit`; `runInTransaction` owns flush/drop) |
| Error codes | `src/shared/errors.ts` (+7 codes per tech design §Interfaces) |
| Queue util | `src/tech-utils/work-queue/index.ts` (gains `enqueue` = recordItem + pending form + poke) |
| Migration v5 | `src/shared/storage.ts` (work_item columns, derived_form, chunk, chunk_member, deleted_at) |
| SDK assembly | `src/sdk.ts` (`createSdk(config)`: provider, mode, clock, retry/lease/chunk policy defaults) |
| Scheduler skeleton | `src/scheduler.ts` (NEW: manual mode complete — onCommit fires, poke no-ops; background flag present) |
| Provider double | `test/fixtures/provider-double.ts` (NEW: seven ops, failNext/failKind/delayKind/captureInputs) |
| Fixture builders | `test/fixtures/threads.ts` (extended: closed turns, tool runs, multi-state, damaged-source) |
| Tests | `test/fixtures.test.ts`, `test/thread-migration.test.ts` (migration leg) |

#### Design References

- [tech-design.md §Placement](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:106), lines 106–140
- [tech-design.md §Storage (migration v5)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:142), lines 142–189
- [tech-design.md DD-5/DD-6/DD-7](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:81), lines 81–85
- [tech-design.md §Interfaces (types, provider seam, SDK assembly)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:240), lines 240–308
- [tech-design.md §Interfaces (error codes)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:369), lines 369–377
- [tech-design.md §Work Breakdown (Chunk 0 row)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:449), line 449
- [test-plan.md §Test Substrate](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:5), lines 5–11

#### Test Mapping

| FC | Test File / Check | Test Description |
|----|-------------------|------------------|
| FC-0.1 | `test/fixtures.test.ts` | double implements all seven ops with marked input-derived output |
| FC-0.2 | `test/fixtures.test.ts` | same input twice → identical output across instances; failNext/failKind/delayKind scripting drives each behavior |
| FC-0.3 | typecheck + `test/fixtures.test.ts` | shared types consumed from `shared/derivation.ts`; outcome lives in `metadata`, never content |
| FC-0.4 | `test/work-queue.test.ts` | six kinds registered with owner/sourceRef; map assembles from domain tables; unregistered-kind lookup reports the miss |
| FC-0.5 | `test/thread-migration.test.ts` + full suite | v5 applies to an Epic 01 file in place; Epic 01's 118 tests green against migrated schema |
| FC-0.6 | `test/fixtures.test.ts` | each builder's claimed states verified by read-back |
| FC-0.7 | gates | `red-verify` → `green-verify` → `verify-all` green |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Enqueue atomicity | `test/work-queue.test.ts` | induced rollback after `enqueue` → no work row, no `pending` form row, no poke fired | Story 0 owns no epic TCs; this invariant underlies every later queue site |
| Migration on live data | `test/thread-migration.test.ts` | v5 over a populated Epic 01 thread file — existing rows intact, new columns defaulted | A fresh-file migration test would pass while breaking real threads |
| Double scripting isolation | `test/fixtures.test.ts` | failNext consumed by exactly N calls; capture log per instance | Scripting state leaking across tests would corrupt later stories' assertions silently |

#### Technical Notes

**Provider Seam** (epic Data Contracts): semantic interface, one operation per derivation kind, injected at SDK construction.

| Operation | Input | Output |
|-----------|-------|--------|
| smoothPrompt | prompt text | smoothed text |
| summarizeToolCall | tool name, arguments, paired result content and error flag (when present) | descriptive text (outcome stamped by caller) |
| summarizeToolResult | result content, tool name | summarized abbreviation |
| composeTurnRendering | ordered message forms (or raw fallbacks), turn frame | rendering text |
| projectLowerBand | rendering text | projection text |
| summarizeChunkDetailed | member turn projections | detailed summary |
| summarizeChunkBrief | member turn projections | brief summary |

Every operation returns content or a structured failure carrying retryable-or-not.

**Work Item kinds** (epic Data Contracts, extended from Epic 01):

| Kind | Owner | sourceRef | Queued by |
|------|-------|-----------|-----------|
| `prompt_smoothing` | `messages` | messageId | intake (Epic 01), edit cascade, repair |
| `tool_call_summary` | `messages` | messageId | intake (this epic), edit cascade, repair |
| `tool_result_summary` | `messages` | messageId | intake (Epic 01), edit cascade, repair |
| `turn_derivation` | `turns` | turnId | turn close (Epic 01), mutation cascade, repair |
| `chunk_summary_detailed` | `turns` | chunkId | chunk close, mutation cascade, repair |
| `chunk_summary_brief` | `turns` | chunkId | chunk close, mutation cascade, repair |

**Derived Form State** (epic Data Contracts): state is one of `pending` | `ready` | `failed` | `blocked`; the read shape carries form, state, content?, reason?, derivedAt?, gaps? — gaps name the source record and form that fell back during composition.

**Scheduler skeleton boundary:** manual mode is complete in this story (onCommit fires; scheduler poke is a no-op); background mode's single-flight/coalesce/catch-up behavior is Story 1's — the flag exists here so `createSdk` validates its config shape from day one.

**Cross-story debt** (coverage.md): the multi-state and damaged-source fixtures are golden-shaped until consumed — Story 0 proves read-back of what the builders wrote; Stories 2/4 confirm the states arise for real.

#### Anti-Shim Requirements

- The double derives output from input (digest/prefix marking) — no canned constants; FC-0.2's cross-instance assertion is the guard.
- Stubs fail closed per the Epic 01 rule: `{ ok: false, error: storageFailure("not implemented") }` — never fake success.
- `enqueue` writes the form's `pending` row in the *ambient* transaction — no separate connection, no post-commit write.
- The migration must not be conditional on suite detection; FC-0.5 runs the real Epic 01 suite against the migrated file.

#### Production Path Proof

- Entrypoint: `createSdk(config)` — the only assembly path; provider, mode, and policy enter here.
- Registration/default path: handler maps merge from `messages.workHandlers` + `turns.workHandlers` at construction (tables empty until Stories 2–3; assembly mechanics proven now).
- Evidence: `test/fixtures.test.ts` constructs the SDK through `createSdk` with the double at the production seam; `pnpm run boundaries` proves the scheduler imports domain surfaces only through `domains/*/index.ts`.

#### Verification

- Targeted: `pnpm vitest run test/fixtures.test.ts test/thread-migration.test.ts test/work-queue.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

| Date | Deviation | Disposition |
|---|---|---|
| 2026-06-10 | Pre-implementation patch (tech-lead reviewed): queue rows are live-work-only, no `disposition` column, terminal rows deleted (DD-1); `generation` renamed `source_version` (DD-3); v5 gains the pending-row backfill; CLI provider resolution added (DD-11) | Spec updated before implementation; build to current text |
| 2026-06-10 | Work-item ids gain the version suffix (`w-<sourceId>-<kind>-v<sourceVersion>`), changing Epic 01 exact-id assertions — sanctioned amendment, see test plan §Sanctioned Amendments (Story 0 entry); red manifest regenerates as a story step | Planned amendment; record actual edits here during implementation |

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] FC-0.1 through FC-0.7 each proven by a named test
- [ ] Epic 01 suite green against the migrated schema (FC-0.5 is a hard gate)
- [ ] Double determinism and failure injection demonstrated in tests Stories 1–6 will reuse
- [ ] Fixture builders consumed by at least one invariant test each
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
- planner_turn_index: 5
- mode: resume
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-verify completed with outcome pass and status ok.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/007-verify.json
- older_response_count: 2
- caller_input_artifact_count: 1
- prior_self_note_count: 2
- latest_self_note: "After verifier returns, accept only on pass with no unresolved findings; if the only unresolved issue is the schema-version assertion amendment boundary, request a ruling rather than accepting."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/007-verify.json
bytes: 3335
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "01bd5efa-1f68-4410-bbdf-435e28a96b6c"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eb4b4-d60f-7210-87b8-5f15f3678327"
    continuation:
      provider: "codex"
      sessionId: "019eb4b4-d60f-7210-87b8-5f15f3678327"
      storyId: "00-foundation"
    mode: "followup"
    story:
      id: "00-foundation"
      title: "Story 0: Foundation"
    artifactsRead:
      - "implementor response: 00-foundation-story-run-001-ruling-012"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/team-impl-log.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/stories/00-foundation.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md"
      - "packages/lhc/test/thread-migration.test.ts"
    reviewScopeSummary: "Follow-up convergence review for prior finding 00F-001. Applied the impl-lead ruling ratifying the thread-migration schema-version assertion edits, verified the ruling is recorded in team-impl-log.md, and reran the story and epic gates. No new touched-surface regression was found."
    priorFindingStatuses:
      -
        id: "00F-001"
        status: "resolved"
        rationale: "Resolved by impl-lead ruling 00-foundation-story-run-001-ruling-012. The response explicitly ratifies the schemaVersionOf 4→5 assertion edits as a mechanical consequence of FC-0.5 migration v5, and team-impl-log.md:53-54 records the needs-ruling event and ratification."
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "FC-0.1: retained from initial verification; DerivationProvider and deterministic double evidence was already verified."
        - "FC-0.2: retained from initial verification; double determinism and failure scripting evidence was already verified."
        - "FC-0.3: retained from initial verification; derived-form vocabulary and metadata outcome evidence was already verified."
        - "FC-0.4: retained from initial verification; six-kind registry, handler-map assembly, and unknown-kind miss evidence was already verified."
        - "FC-0.5: verified; migration v5 assertion amendment is now ratified by impl-lead ruling 00-foundation-story-run-001-ruling-012, and migration-on-live-data evidence remains in thread-migration.test.ts."
        - "FC-0.6: retained from initial verification; fixture builder read-back evidence was already verified."
        - "FC-0.7: verified again; pnpm run green-verify and pnpm run verify-all both passed in this follow-up."
      unverified:
[]
    gatesRun:
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
    productionPathFindings:
[]
    recommendedNextStep: "pass"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "green-verify passed: build, typecheck, lint, boundaries, 12 test files, 141 tests, and test immutability."
      - "verify-all passed: build, typecheck, lint, boundaries, process suite enabled, 18 test files, 155 tests."
      - "No new findings were added because this follow-up only addressed the prior ruling blocker and directly touched convergence surface."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/007-verify.json"
  startedAt: "2026-06-11T03:28:26.324Z"
  finishedAt: "2026-06-11T03:29:21.593Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/003-implementor.json
bytes: 12656
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "e56de724-1f1f-43d3-b45c-619de6700f52"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "7698513f-2c28-4ac5-bcaf-f544bbac5176"
    continuation:
      provider: "claude-code"
      sessionId: "7698513f-2c28-4ac5-bcaf-f544bbac5176"
      storyId: "00-foundation"
    outcome: "ready-for-verification"
    story:
      id: "00-foundation"
      title: "Story 0: Foundation"
    planSummary: "Landed Epic 02's substrate: shared/derivation.ts with the four-state DerivedForm vocabulary, DerivationProvider seam (seven ops, ProviderResult), handler contract, and SdkConfig; OperationContext gained onCommit with createCommitHooks/runInTransaction owning flush-on-commit/drop-on-rollback, plus the setSchedulerPoke seam (placed in shared/context.ts so the queue util never imports scheduler.ts, which will import domains from Story 1); 7 new error codes; work-queue gained the six-kind WORK_KIND_REGISTRY, chunkId sourceRefs, version-suffixed ids (w-<src>-<kind>-v<n>, payload carries sourceVersion), and enqueue (recordItem + create-or-reset pending derived_form rows from caller-named form targets + onCommit poke); both Epic 01 queue sites (queueMessageWork, closeTurnAndQueueWork) now go through enqueue; migration v5 (statements in shared/storage.ts, assembled in threads/internal/create.ts) adds queue mechanical columns, derived_form, chunk tables, deleted_at stamps, and the F-02 pending-row backfill; createSdk(config) in sdk.ts validates mode/provider/policies, resolves defaults centrally (3/5000/60000, 120000, 2200/4400), and assembles the handler map from messages.workHandlers + turns.workHandlers with lookupWorkHandler reporting unknown_work_kind as structured state_corruption; scheduler.ts skeleton (manual mode complete, background flag validated). Test substrate: deterministic ProviderDouble (marked digest+prefix output, failNext/failKind/delayKind/captureInputs, kind aliases per test-plan vocabulary) and thread builders (closed turns, tool runs with error/missing variants, multi-state, damaged-source, twin SDK/CLI) plus a populated legacy Epic 01 v4 file fixture for the migration-on-live-data proof."
    changedFiles:
      -
        path: "packages/lhc/src/shared/derivation.ts"
        reason: "NEW: FormKind, DerivedFormState, DerivedForm, DependencyGap, ToolOutcome, ProviderResult, DerivationProvider, RenderingPart, SdkConfig/ResolvedSdkConfig, WorkHandler contract (FC-0.1/FC-0.3)"
      -
        path: "packages/lhc/src/shared/context.ts"
        reason: "OperationContext gains onCommit; createCommitHooks + runInTransaction own flush/drop; setSchedulerPoke/fireSchedulerPoke seam (DD-5)"
      -
        path: "packages/lhc/src/shared/errors.ts"
        reason: "+7 codes: turn_open, message_initiates_turn, message_not_found, turn_not_found, unknown_work_kind, provider_failure, source_damaged"
      -
        path: "packages/lhc/src/shared/storage.ts"
        reason: "MIGRATION_V5_STATEMENTS: work_item mechanical columns + index, derived_form, chunk/chunk_member, deleted_at stamps, F-02 backfill INSERTs"
      -
        path: "packages/lhc/src/domains/threads/internal/create.ts"
        reason: "appends migration v5 to the thread-file migration history"
      -
        path: "packages/lhc/src/tech-utils/work-queue/index.ts"
        reason: "six-kind WorkKind + chunkId sourceRef, WORK_KIND_REGISTRY, versioned deterministic ids with payload, enqueue = recordItem + pending form rows + onCommit poke (DD-5)"
      -
        path: "packages/lhc/src/scheduler.ts"
        reason: "NEW skeleton: SchedulerMode, createScheduler — manual mode complete (poke no-op), background flag present for Story 1"
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "createSdk(config) assembly: config validation + central defaults, handler-map merge from domain tables, lookupWorkHandler explicit-miss; re-exports new shared surface (FC-0.4)"
      -
        path: "packages/lhc/src/domains/messages/index.ts"
        reason: "queueMessageWork now enqueues with form targets (smoothed_prompt / tool_result_summary); exports empty workHandlers table"
      -
        path: "packages/lhc/src/domains/turns/index.ts"
        reason: "closeTurnAndQueueWork now enqueues turn_derivation with turn_rendering + lower_band_projection form targets; exports empty workHandlers table"
      -
        path: "packages/lhc/src/domains/intake-stream/internal/pipeline.ts"
        reason: "batch transaction builds commit hooks into ctx and flushes them only after COMMIT (rollback drops pokes)"
      -
        path: "packages/lhc/test/fixtures/provider-double.ts"
        reason: "NEW deterministic double: seven ops with marked input-derived output, failNext/failKind/delayKind/captureInputs, per-instance scripting"
      -
        path: "packages/lhc/test/fixtures/threads.ts"
        reason: "NEW builders: threadWithClosedTurns, threadWithToolRun (error/missing variants), multiStateThread, damagedSourceThread, twinThreads, readDerivedForms, sanctioned setFormState writer"
      -
        path: "packages/lhc/test/fixtures/legacy.ts"
        reason: "legacyEpic01ThreadFile: populated v4 file with unversioned queued items for the FC-0.5 live-data migration proof"
      -
        path: "packages/lhc/test/fixtures/index.ts"
        reason: "re-export the new double and builders"
      -
        path: "packages/lhc/test/fixtures.test.ts"
        reason: "FC-0.1/FC-0.2 double determinism + scripting isolation, FC-0.1 createSdk production-seam/config tests, FC-0.3 metadata-outcome proof, FC-0.6 builder read-back"
      -
        path: "packages/lhc/test/work-queue.test.ts"
        reason: "sanctioned -v1 id amendments (17 literals); FC-0.4 registry/handler-map tests; enqueue-atomicity architecture-risk tests (intake rollback + runInTransaction legs, versioned re-enqueue)"
      -
        path: "packages/lhc/test/cli-process-work-queue.test.ts"
        reason: "sanctioned -v1 id amendments (2 literals)"
      -
        path: "packages/lhc/test/thread-migration.test.ts"
        reason: "FC-0.5 v5-over-populated-Epic-01-file test with backfill assertions; schema-version assertions 4→5 (consequence of v5, see openQuestions)"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "regenerated for the four amended/extended red-phase files (sanctioned story step)"
    tests:
      added:
        - "fixtures.test.ts: FC-0.1 double implements all seven ops with marked input-derived output"
        - "fixtures.test.ts: FC-0.2 identical input → identical output across instances; seven distinguishable markers"
        - "fixtures.test.ts: FC-0.2 failNext fail-N-then-succeed with scripted retryability"
        - "fixtures.test.ts: FC-0.2 failKind terminal failure per kind alias without touching other kinds"
        - "fixtures.test.ts: FC-0.2 delayKind latency injection"
        - "fixtures.test.ts: scripting and capture state are per-instance (double scripting isolation)"
        - "fixtures.test.ts: createSdk resolves defaults centrally, carries provider and mode"
        - "fixtures.test.ts: background mode validated at construction (behavior Story 1)"
        - "fixtures.test.ts: createSdk rejects bad mode / incomplete provider / bad policy values"
        - "fixtures.test.ts: threadWithClosedTurns read-back"
        - "fixtures.test.ts: threadWithToolRun pair, error, and missing-result variants"
        - "fixtures.test.ts: FC-0.6 multi-state thread reads back all four states with state-shape contract"
        - "fixtures.test.ts: FC-0.3 tool outcome in metadata, never in content"
        - "fixtures.test.ts: FC-0.6 damaged-source thread reads back the Epic 01 corruption live"
        - "fixtures.test.ts: FC-0.6 twin SDK/CLI threads identical through every read surface"
        - "work-queue.test.ts: FC-0.4 registry covers all six kinds with owner/sourceRef semantics"
        - "work-queue.test.ts: FC-0.4 createSdk assembles handler map; unregistered kind reports the miss explicitly"
        - "work-queue.test.ts: FC-0.4 assembly merges domain tables; doubly-claimed kind refused"
        - "work-queue.test.ts: committed intake writes rows + pending forms, pokes once per enqueue after commit"
        - "work-queue.test.ts: induced rollback drops work row, pending form row, and poke"
        - "work-queue.test.ts: enqueue via runInTransaction — rollback drops all three effects, commit lands then pokes"
        - "work-queue.test.ts: re-enqueue at later source version resets form row to pending at that version"
        - "thread-migration.test.ts: FC-0.5 v5 over a populated Epic 01 file — records intact, columns defaulted, F-02 backfill present, post-migration intake works"
      modified:
        - "work-queue.test.ts: 17 work-item id literals gained -v1 (sanctioned Story 0 amendment)"
        - "cli-process-work-queue.test.ts: 2 work-item id literals gained -v1 (sanctioned Story 0 amendment)"
        - "thread-migration.test.ts: 2 schemaVersionOf assertions 4→5 (mechanical consequence of migration v5 landing)"
      removed:
[]
      totalAfterStory: 155
      deltaFromPriorBaseline: 23
    gatesRun:
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Tech design's idx_work_item_queue named rowid as an index column; SQLite rejects rowid in index definitions — index now covers (status, eligible_at), claimNext keeps ORDER BY rowid at query time"
        - "damagedSourceThread originally corrupted a fully-closed thread, yielding one open turn (not corrupt); builder now leaves a turn open through real intake before the corruption write so two open turns exist"
        - "Initial Lhc construction stubbed the threads/intakeStream namespaces incorrectly; fixed to wire the real domain namespaces"
      findingsSurfaced:
        - "The scheduler poke seam (setSchedulerPoke/fireSchedulerPoke) lives in shared/context.ts rather than scheduler.ts: scheduler.ts will import domain handler tables from Story 1, and a work-queue→scheduler import would then cycle through domains→tech-utils. Story 1 should install the real scheduler into this seam at createSdk"
        - "createSdk does not yet install its scheduler into the poke seam (manual mode's poke is a no-op by contract and background drain doesn't exist); background-mode wiring is explicitly Story 1's per the story boundary"
        - "enqueue takes caller-supplied form targets to keep the queue util domain-blind; the kind→form mapping lives in the owning domains (MESSAGE_WORK_FORMS includes tool_call_summary ready for Story 2, though intake's kind gate still excludes tool_call as required)"
        - "multi-state/damaged-source fixtures use the sanctioned below-SDK setFormState writer (UPDATE-only, mirroring the production completion contract) since ready/failed/blocked are unreachable until Stories 1–3 — the known cross-story golden-shaped debt from coverage.md"
        - "WorkHandler's item parameter is typed structurally in shared/derivation.ts (not as the util's WorkItemRecord) to keep shared→tech-utils dependency one-directional; Story 1 may want to tighten this when the drain dispatches for real"
    openQuestions:
      - "thread-migration.test.ts's two schemaVersionOf(...).toBe(4) assertions necessarily became toBe(5) when migration v5 landed. The test plan's sanctioned-amendment list names only the work-item id literals, and says further Epic 01 edits are a ruling, not an edit. I treated the version-number bump as a mechanical consequence of the story's own deliverable (the file is also a named Story 0 implementation target) and made the edit; please ratify or rule."
    specDeviations:
      - "idx_work_item_queue created as (status, eligible_at) instead of the tech design's (status, eligible_at, rowid): SQLite forbids rowid inside an index definition; head selection still orders by rowid at query time"
      - "Sanctioned id amendment executed: 17 'w-…' literals in test/work-queue.test.ts and 2 in test/cli-process-work-queue.test.ts gained the -v1 suffix; red manifest regenerated for both files plus thread-migration.test.ts and fixtures.test.ts"
      - "thread-migration.test.ts schema-version assertions updated 4→5 (see openQuestions)"
      - "Scheduler poke seam placed in shared/context.ts rather than inside scheduler.ts to avoid a future import cycle (work-queue→scheduler→domains→tech-utils); DD-5 semantics (poke registered on ctx.onCommit by enqueue, transactional by construction) are unchanged"
      - "CLI provider resolution (DD-11) not landed in this story: no CLI command needs a provider until drain (Story 1); the named-provider registry ships with it"
    recommendedNextStep: "Verify Story 0, ratify the schema-version assertion amendment, then proceed to Story 1 (queue execution): claimNext/complete/failAttempt SQL, drain, lease/reclaim, background scheduling installing the real scheduler into the shared poke seam, and the DD-11 CLI provider registry."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/003-implementor.json"
  startedAt: "2026-06-11T03:01:39.040Z"
  finishedAt: "2026-06-11T03:23:15.126Z"
```
</history_entry>

<history_entry>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/004-verify.json
bytes: 7140
payload:
  command: "story-verify"
  version: 1
  status: "needs-user-decision"
  outcome: "needs-human-ruling"
  result:
    resultId: "015c84d9-8706-4bf5-9bb0-c585cec35a8e"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eb4b4-d60f-7210-87b8-5f15f3678327"
    continuation:
      provider: "codex"
      sessionId: "019eb4b4-d60f-7210-87b8-5f15f3678327"
      storyId: "00-foundation"
    mode: "initial"
    story:
      id: "00-foundation"
      title: "Story 0: Foundation"
    artifactsRead:
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/stories/00-foundation.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/003-implementor.json"
      - "packages/lhc/src/shared/derivation.ts"
      - "packages/lhc/src/shared/context.ts"
      - "packages/lhc/src/shared/errors.ts"
      - "packages/lhc/src/shared/storage.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/src/scheduler.ts"
      - "packages/lhc/src/domains/messages/index.ts"
      - "packages/lhc/src/domains/turns/index.ts"
      - "packages/lhc/src/domains/intake-stream/internal/pipeline.ts"
      - "packages/lhc/src/domains/threads/internal/create.ts"
      - "packages/lhc/test/fixtures/provider-double.ts"
      - "packages/lhc/test/fixtures/threads.ts"
      - "packages/lhc/test/fixtures/index.ts"
      - "packages/lhc/test/fixtures/legacy.ts"
      - "packages/lhc/test/fixtures.test.ts"
      - "packages/lhc/test/thread-migration.test.ts"
      - "packages/lhc/test/work-queue.test.ts"
      - "packages/lhc/test/cli-process-work-queue.test.ts"
      - "packages/lhc/test/red-manifest.json"
    reviewScopeSummary: "Initial verification for Story 0 foundation. Reviewed story, full tech design, test plan, implementation artifact, production code, fixtures, and Story 0 tests; ran focused tests, story gate, and epic gate. Functional FC evidence is present and gates pass, but readiness is blocked by an explicit unratified test-scope amendment."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "00F-001"
        severity: "major"
        title: "Unratified Epic 01 test assertion amendment remains open"
        evidence: "test-plan.md:100-112 sanctions Story 0 exact-id assertion edits only and states that other Epic 01 test changes need a ruling. The current diff changes existing thread-migration schema-version assertions in test/thread-migration.test.ts:62 and test/thread-migration.test.ts:103 from the prior expected current schema version to 5. The implementor artifact also lists this as an open question requiring ratification. This is not a code failure, but it is an unresolved human-ruling requirement under the test-plan governance text."
        affectedFiles:
          - "packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md"
          - "packages/lhc/test/thread-migration.test.ts"
          - "packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/003-implementor.json"
        requirementIds:
          - "FC-0.5"
          - "FC-0.7"
          - "Test Plan §Sanctioned Epic 01 Test Amendments"
        recommendedFixScope: "human-ruling"
        blocking: true
    openFindings:
      -
        id: "00F-001"
        severity: "major"
        title: "Unratified Epic 01 test assertion amendment remains open"
        evidence: "test-plan.md:100-112 sanctions Story 0 exact-id assertion edits only and states that other Epic 01 test changes need a ruling. The current diff changes existing thread-migration schema-version assertions in test/thread-migration.test.ts:62 and test/thread-migration.test.ts:103 from the prior expected current schema version to 5. The implementor artifact also lists this as an open question requiring ratification. This is not a code failure, but it is an unresolved human-ruling requirement under the test-plan governance text."
        affectedFiles:
          - "packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md"
          - "packages/lhc/test/thread-migration.test.ts"
          - "packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/003-implementor.json"
        requirementIds:
          - "FC-0.5"
          - "FC-0.7"
          - "Test Plan §Sanctioned Epic 01 Test Amendments"
        recommendedFixScope: "human-ruling"
        blocking: true
    requirementCoverage:
      verified:
        - "FC-0.1: shared DerivationProvider has seven operations in src/shared/derivation.ts:73-84; provider double implements all seven in test/fixtures/provider-double.ts:145-174; fixtures.test.ts:168-183 verifies marked input-derived output."
        - "FC-0.2: fixtures.test.ts:185-243 verifies cross-instance determinism, distinct operation markers, fail-N-then-succeed, terminal failure, latency, and per-instance capture isolation."
        - "FC-0.3: shared DerivedForm vocabulary is in src/shared/derivation.ts:10-44; messages and turns consume shared derivation types in src/domains/messages/index.ts:3 and src/domains/turns/index.ts:3; fixtures.test.ts:373-383 verifies tool outcome in metadata and not content."
        - "FC-0.4: WORK_KIND_REGISTRY covers six kinds in src/tech-utils/work-queue/index.ts:16-37; SDK handler map assembly and unknown-kind structured miss are in src/sdk.ts:84-119 and tested in test/work-queue.test.ts:428-470."
        - "FC-0.5: migration v5 is in src/shared/storage.ts:22-78 and wired in src/domains/threads/internal/create.ts:113-119; test/thread-migration.test.ts:227-325 verifies populated Epic 01 upgrade, mechanical columns, v5 tables, F-02 backfill, and post-migration write path."
        - "FC-0.6: fixture builders exist in test/fixtures/threads.ts and are read-back verified in test/fixtures.test.ts:305-439 for closed turns, tool-run variants, multi-state, damaged-source, and SDK/CLI twins."
        - "FC-0.7: focused tests passed, pnpm run green-verify passed, and pnpm run verify-all passed."
      unverified:
        - "Human ratification for the non-listed thread-migration schema-version assertion amendment required by test-plan.md:100-112."
    gatesRun:
      -
        command: "pnpm vitest run test/fixtures.test.ts test/thread-migration.test.ts test/work-queue.test.ts"
        result: "pass"
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
    productionPathFindings:
[]
    recommendedNextStep: "needs-human-ruling"
    recommendedFixScope: "human-ruling"
    openQuestions:
      - "Does the story authority ratify the thread-migration schema-version assertion edits as a mechanical consequence of migration v5 landing?"
    additionalObservations:
      - "Focused tests passed: 3 files, 47 tests. green-verify passed: 12 files, 141 tests plus build, typecheck, lint, boundaries, and test immutability. verify-all passed: 18 files, 155 tests."
      - "Production-path audit found no material fake adapter, mock path, or placeholder behavior in Story 0 runtime scope; the deterministic provider double is confined to tests."
      - "The migration index differs from the design sketch by omitting rowid from the index definition because SQLite rejects rowid in CREATE INDEX; the behavior-relevant queue ordering remains query-time rowid ordering and gates passed."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/004-verify.json"
  startedAt: "2026-06-11T03:23:30.556Z"
  finishedAt: "2026-06-11T03:27:03.086Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/001-current.json
Bytes: 3590

```yaml
storyRunId: "00-foundation-story-run-001"
storyId: "00-foundation"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome pass and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/004-verify.json"
    provenance: "current-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/001-final-package.json"
    provenance: "current-run"
  -
    kind: "ruling-response"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/001-ruling-response-001.json"
    provenance: "caller-input"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/007-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "7698513f-2c28-4ac5-bcaf-f544bbac5176"
    storyId: "00-foundation"
  storyVerifier:
    provider: "codex"
    sessionId: "019eb4b4-d60f-7210-87b8-5f15f3678327"
    storyId: "00-foundation"
latestEventSequence: 17
callerInputHistory:
  reviewRequests:
[]
  rulings:
    -
      rulingRequestId: "00-foundation-story-run-001-ruling-012"
      decision: "ratify-schema-version-assertion-edits"
      rationale: "Migration v5 is an explicit Story 0 deliverable (FC-0.5, tech-design §Storage names v5 as the epic's single migration). Updating thread-migration.test.ts schemaVersionOf assertions from 4 to 5 is the mechanical consequence of that deliverable, in the same spirit as the sanctioned versioned-id amendments. Verifier reports FC-0.1–0.7 evidence present and gates green (focused tests, green-verify, verify-all). Ratified by impl-lead under standing overnight authorization; recorded in team-impl-log.md story receipt and Story 0 deviation notes."
      source: "impl-lead"
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Impl-lead ratified the only verifier-blocking human-ruling item. The smallest safe next action is to resume verifier finalization with the ruling response so 00F-001 can be marked resolved before story-lead acceptance."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/007-verify.json"
replayBoundary: null
updatedAt: "2026-06-11T03:29:21.601Z"
```

## Caller Input Artifacts

### ruling-response
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/001-ruling-response-001.json
Bytes: 711

```yaml
rulingRequestId: "00-foundation-story-run-001-ruling-012"
decision: "ratify-schema-version-assertion-edits"
rationale: "Migration v5 is an explicit Story 0 deliverable (FC-0.5, tech-design §Storage names v5 as the epic's single migration). Updating thread-migration.test.ts schemaVersionOf assertions from 4 to 5 is the mechanical consequence of that deliverable, in the same spirit as the sanctioned versioned-id amendments. Verifier reports FC-0.1–0.7 evidence present and gates green (focused tests, green-verify, verify-all). Ratified by impl-lead under standing overnight authorization; recorded in team-impl-log.md story receipt and Story 0 deviation notes."
source: "impl-lead"
```

## Prior Self Notes
Latest note highlight: After verifier returns, accept only on pass with no unresolved findings; if the only unresolved issue is the schema-version assertion amendment boundary, request a ruling rather than accepting.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-11T03:01:39.005Z; note="After implementation returns, verify evidence for FC-0.1 through FC-0.6 first, then run the configured story gate before considering acceptance."
- sequence=8; actionSequence=7; createdAt=2026-06-11T03:23:30.520Z; note="After verifier returns, accept only on pass with no unresolved findings; if the only unresolved issue is the schema-version assertion amendment boundary, request a ruling rather than accepting."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/001-events.jsonl
Bytes: 7104

```yaml
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T03:01:28.003Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 2
  timestamp: "2026-06-11T03:01:38.981Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb4a0-a7f2-71e3-a547-cb895421c1f5"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 3
  timestamp: "2026-06-11T03:01:39.004Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, verify evidence for FC-0.1 through FC-0.6 first, then run the configured story gate before considering acceptance."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 4
  timestamp: "2026-06-11T03:01:39.005Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, verify evidence for FC-0.1 through FC-0.6 first, then run the configured story gate before considering acceptance."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 5
  timestamp: "2026-06-11T03:23:15.136Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 6
  timestamp: "2026-06-11T03:23:30.496Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019eb4b4-99d8-7df2-a3d2-867a840c208a"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 7
  timestamp: "2026-06-11T03:23:30.520Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
    selfNote: "After verifier returns, accept only on pass with no unresolved findings; if the only unresolved issue is the schema-version assertion amendment boundary, request a ruling rather than accepting."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 8
  timestamp: "2026-06-11T03:23:30.520Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After verifier returns, accept only on pass with no unresolved findings; if the only unresolved issue is the schema-version assertion amendment boundary, request a ruling rather than accepting."
    actionSequence: 7
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 9
  timestamp: "2026-06-11T03:27:03.095Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome needs-human-ruling and status needs-user-decision."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "needs-human-ruling"
    status: "needs-user-decision"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 10
  timestamp: "2026-06-11T03:27:11.394Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019eb4b8-144a-7501-bfdb-fd5eadfac01f"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 11
  timestamp: "2026-06-11T03:27:11.415Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected request-ruling."
  data:
    actionType: "request-ruling"
    turn: 3
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 12
  timestamp: "2026-06-11T03:27:11.446Z"
  type: "needs-ruling"
  summary: "Story-lead finalized 00-foundation-story-run-001 with outcome needs-ruling."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/001-final-package.json"
  data:
    terminalDecision: "request-ruling"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 13
  timestamp: "2026-06-11T03:28:14.363Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 14
  timestamp: "2026-06-11T03:28:14.387Z"
  type: "ruling-received"
  summary: "Caller ruling received for 00-foundation-story-run-001-ruling-012."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/001-ruling-response-001.json"
  data:
    rulingRequestId: "00-foundation-story-run-001-ruling-012"
    decision: "ratify-schema-version-assertion-edits"
    source: "impl-lead"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 15
  timestamp: "2026-06-11T03:28:26.262Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/story-lead/prompts/001-planner-turn-004.md"
    sessionId: "019eb4b9-2aba-7343-8808-fe78303a0d42"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 16
  timestamp: "2026-06-11T03:28:26.288Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 1
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 17
  timestamp: "2026-06-11T03:29:21.601Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/00-foundation/007-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "pass"
    status: "ok"
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
