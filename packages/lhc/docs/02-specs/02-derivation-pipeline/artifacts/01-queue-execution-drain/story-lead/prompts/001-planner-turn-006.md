# Story Lead Base Prompt

## Role Charter
You are the story lead for `01-queue-execution-drain` on durable story run `01-queue-execution-drain-story-run-001`.
Select exactly one bounded next action for this `resume` turn.
This is planner turn 6.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/stories/01-queue-execution-drain.md
Bytes: 17740

# Story 1: Queue Execution and Drain

### Summary
<!-- Jira: Summary field -->

The drain runs queued work: head-first claim under durable lease, dispatch by kind, retry with backoff, terminal dispositions, crash recovery, and both host modes — the executable queue everything else dispatches through.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The harness integrator's SDK construction picks the host mode; the agent and user feel this story as "queued work runs without being asked" (background) or as the `lhc work drain` command (manual).

**Objective:** Epic 01's durable work rows become a running pipeline. A drain claims the oldest live item under a durable lease, dispatches it to the registered handler, records its disposition, and repeats; failures retry per policy; crashes recover; two drains never interleave on one thread; and in background mode, the act of queueing is sufficient to cause processing.

**Scope — in:**
- `claimNext` head-first selection: the claim decision is made against the oldest live row only — never skips ahead past a live-leased or backing-off head (tech design §Mechanics)
- Durable claim/lease: claim survives process exit; expired lease reclaimable with attempts incremented; live lease blocks a second drain (reports in-flight)
- Dispatch through the Story 0 handler map; unknown kind lands `failed_terminal` with stable reason, drain continues
- Retry policy: per-kind budget, backoff via eligibility, retryable-vs-terminal from the provider's structured failure; exhaustion lands the artifact `failed` with final reason
- Drain report: every item run with disposition (`done` | `failed_terminal` | `stale_discarded` — `superseded` is reported by mutations, never by a drain), stop reason (`empty` | `in_flight` | `waiting` | `max_items`), remaining count; terminal items are deleted with their outcome reported in-memory (DD-1)
- Background mode: enqueue-poke-on-commit scheduling, per-thread single-flight with pending-flag coalescing, catch-up drain on first touch of a thread with leftover work
- Manual mode: rows accumulate durably; `lhc work drain --file-path` runs them; CLI parity for the drain operation

**Scope — out:** Real derivation handlers (Stories 2–3) — this story drains against registered test handlers and the double. Report/re-queue surfaces (Story 4). The `stale_discarded` disposition is mechanically present but only exercised for real by Story 5's cascade; `superseded` belongs to the mutation result (Story 5), not the drain.

**Dependencies:** Story 0 (handler map, migrated queue fields, double, fixtures).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-1.1**: A drain processes a thread's queued items one at a time, in queue order, and returns a report naming each item run and its disposition.
  - **TC-1.1** (AC-1.1): Queue three items across both owners, drain → report names all three in queue order with dispositions; artifacts exist in that order.
- **AC-1.2**: Items queued during an in-flight drain are processed before the drain cycle ends; bursts coalesce into at most one further pass rather than one pass per queueing.
  - **TC-1.2** (AC-1.2): Start a drain on a slow item (double with latency), queue two more mid-flight → all three processed; scheduling shows one coalesced follow-up pass.
- **AC-1.3**: Queued and claimed work survives process exit: after a kill mid-drain, a later drain runs every unfinished item to completion with no item lost and no item run's effects duplicated in the record.
  - **TC-1.3** (AC-1.3): Kill the process mid-drain (after item 1 of 3 lands), reopen, drain → items 2 and 3 run; item 1's artifact unchanged; no duplicates.
- **AC-1.4**: Two drains cannot process the same thread concurrently: a drain finding the head item under a live claim stops and reports the queue as in-flight; it never skips ahead.
  - **TC-1.4** (AC-1.4): Hold a live claim on the head item from one handle, invoke drain from another → second drain reports in-flight, processes nothing.
- **AC-1.5**: In background mode, queueing a work item is sufficient to cause its processing; no caller action beyond the operation that queued it.
- **AC-1.6**: In background mode, the first touch of a thread with leftover queued work schedules a catch-up drain.
  - **TC-1.5** (AC-1.5, AC-1.6): Background-mode SDK: send an intake batch, wait on the drain's completion signal, no explicit drain call → artifacts exist. Reopen a thread with pre-loaded queued rows → catch-up runs them.
- **AC-1.7**: In manual mode, queued work accumulates durably and does not run until the drain operation is invoked.
  - **TC-1.6** (AC-1.7): Manual-mode SDK: send the same batch → rows sit queued; invoke drain → artifacts land.
- **AC-1.8**: A work item whose kind has no registered handler lands as failed with a stable reason code; it is never silently skipped and never crashes the drain.
  - **TC-1.7** (AC-1.8): Insert a row with an unregistered kind ahead of a valid item → unknown-kind item fails with its code; valid item still runs.
- **AC-1.9**: A handler failure is retried per policy; an item that exhausts its retry budget lands its artifact as failed with the final reason, and the drain continues to the next item.
  - **TC-1.8** (AC-1.9): Double fails an item twice then succeeds → artifact ready; double fails past the budget → artifact failed with final reason, next item ran.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This is the epic's long pole — the tech design names Chunk 1's process-suite fixtures as the hardest in the epic and designs them first. Three components: the **queue util's claim mechanics** (`claimNext`/`complete`/`failAttempt`/`supersedeQueued` — pure SQL, domain-blind, all under `BEGIN IMMEDIATE`; `complete` and at-budget `failAttempt` delete the row — DD-1), the **drain loop** (claim → dispatch via handler map with *no open transaction* during the handler → complete in a second short transaction), and the **scheduler** (DD-4: per-thread single-flight flag, pending-coalesce, post-commit pokes, first-touch catch-up, `drainSettled`).

The load-bearing rule is **head-first, never skip-ahead** (§Mechanics): the claim decision is made against the oldest live row only. A live-leased head stops the drain with `in_flight`; a backing-off head stops it with `waiting` — and gates everything behind it. That head-of-line cost is accepted design, not a bug to optimize away. Cross-process safety comes from the durable lease alone (in-memory single-flight is advisory); crash recovery is reclaim-on-expired-lease with `attempts` incremented so operators see the crash in the report.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- Concurrency (cross-process claim exclusion), durable-state recovery (kill mid-drain), lease/backoff timing, and scheduler in-memory state all land together; every one of them is the kind of behavior that passes happy-path tests while broken.

Risk Reminders:
- TC-1.3's kill must be SIGKILL between claim and complete (marker-line protocol per the test plan) — a graceful exit tests nothing.
- TC-1.4 must prove the queued item *behind* the live head was not claimed — exclusion without the skip-ahead proof is half the test.
- The backoff leg (TC-1.8) asserts `waiting` + `waitingUntil` + head-gates-queue with non-zero backoff — zero-backoff config would silently skip the eligibility gate.
- Dispositions `superseded`/`stale_discarded` ship mechanically here but are only exercisable in Story 5 (coverage debt) — don't manufacture fake coverage for them now.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Claim mechanics | `src/tech-utils/work-queue/index.ts` (claimNext, complete, failAttempt, supersedeQueued, queueDetail) |
| Drain loop + report | `src/scheduler.ts` (claim→dispatch→complete loop, `DrainReport` assembly — per tech design §Placement, the scheduler owns the drain) |
| Scheduler state | `src/scheduler.ts` (single-flight flags, pending-coalesce, catch-up Set, drainSettled) |
| SDK surface | `src/sdk.ts` (`work.drain` delegation, `drainSettled`, mode wiring) |
| CLI | `src/cli/work.ts` (NEW: `lhc work drain --file-path [--max-items]`) |
| Tests | `test/work-execution.test.ts` (NEW), `test/cli-process-work.test.ts` (NEW), kill-runner script under `test/fixtures/` |

#### Design References

- [tech-design.md DD-1 (lifecycle + truth table)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:61), lines 61–73
- [tech-design.md DD-4 (scheduler placement) + DD-10 (catch-up)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:79), lines 79–91
- [tech-design.md §Flow 1 (sequence + lease/retry prose)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:193), lines 193–223
- [tech-design.md §Mechanics (claimNext SQL, complete/failAttempt rules)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:387), lines 387–408
- [tech-design.md §Interfaces (Lhc/drainSettled, WorkSurface, DrainReport)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:301), lines 301–321
- [tech-design.md §Issues 1 & 3 (supersede; drainSettled API)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:97), lines 97–99
- [test-plan.md §work-execution suite (incl. storage-contract assertions)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:15), lines 15–30
- [test-plan.md §cli-process-work suite](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:32), lines 32–38
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:100), lines 100–107

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-1.1 | `test/work-execution.test.ts` | 3 items across owners, in order; dispositions `done` on the report; work rows deleted (raw zero-row read); derivedAt monotone |
| TC-1.2 | `test/work-execution.test.ts` | mid-drain batches coalesce; scheduler test-hook shows exactly 2 passes |
| TC-1.3 | `test/cli-process-work.test.ts` | SIGKILL after item 1's marker; reopen; items 2–3 run; item 1 byte-unchanged; reclaim attempts visible |
| TC-1.4 | `test/cli-process-work.test.ts` | process B against A's live claim: `in_flight`, `ran: []`, queued item behind head unclaimed |
| TC-1.5 | `test/work-execution.test.ts` | background: intake → drainSettled → forms ready, no drain call; reopen-with-leftovers → catch-up runs |
| TC-1.6 | `test/work-execution.test.ts` | manual: rows sit queued until `work.drain` |
| TC-1.7 | `test/work-execution.test.ts` | bogus kind → `failed_terminal`/`unknown_work_kind`; next item ran; no throw |
| TC-1.8 | `test/work-execution.test.ts` | fail-twice-then-succeed → ready, attempts=2; fail-past-budget → form `failed`, drain continued; backoff leg: `waiting` + head gates queue |

Supplemental (non-TC) checks: drain CLI parity — `test/cli-process-work.test.ts` asserts report JSON = SDK shape and exit codes 0/0/1; evidence cited under Production Path Proof.

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Restart survival | `test/cli-process-work.test.ts` (TC-1.3) | kill lands *between claim and complete* — the reclaim window, not a clean boundary | An in-process "simulated crash" exercises none of the actual durability |
| Claim exclusion cross-process | `test/cli-process-work.test.ts` (TC-1.4) | the lease is the only cross-process coordination; in-memory flags can't help | In-process tests share the scheduler; only spawned processes prove the SQL lease |
| Head gates queue under backoff | `test/work-execution.test.ts` (TC-1.8 leg) | queued item behind a backing-off head is not claimed | Per-item TCs pass with a skip-ahead claimNext; ordering is a queue-level property |
| Coalescing exactness | `test/work-execution.test.ts` (TC-1.2) | exactly 2 passes for a 3-burst — not 3, not 1 | "All forms ready" passes with per-poke drains; the cost model is the assertion |

#### Technical Notes

**Work Item mechanical contract** (epic Data Contracts, as patched by DD-1): `status` is the lifecycle of *live* work (`queued` → `claimed`); terminal transitions delete the row in the same transaction that records the outcome. Dispositions (`done` | `failed_terminal` | `stale_discarded`; `superseded` on mutation results) are reported by the operation that produced them, not stored. Mechanical detail (attempts, last error, eligibility) lives on the live queue row, never as artifact state — a retrying item's artifact stays `pending` (Flow 4); a `failed` form carries final attempts/last-error copied at exhaustion.

**Terminal-disposition table** (tech design §Mechanics, DD-1): normal success → `done`; stale source-version discard → `stale_discarded`; retry exhaustion or unknown kind → `failed_terminal` (form `failed` carries reason + attempts); source damage → `failed_terminal` (form `blocked`); cascade supersede → deleted + reported on MutationResult. In every terminal case the row is gone afterward — tests assert via report + raw zero-row reads.

**Head-first claim rule** (tech design §Mechanics): inspect the oldest live row only — queued-and-eligible → claim; claimed-and-expired → reclaim (attempts +1); claimed-and-live → report in-flight; queued-but-backing-off → report waiting. A backing-off head gates everything behind it: strict ordering, never reorder.

**Drain report shape**: ran[] (workItemId, kind, sourceRef, disposition, attempts, reason?), stoppedBecause (`empty` | `in_flight` | `waiting` | `max_items`), waitingUntil?, remaining.

**NFRs binding here**: background scheduling adds no observable intake latency (intake returns before any handler runs); a killed drain leaves no partial artifact visible as `ready`; drain writes are short transactions per item; provider calls never inside a transaction.

**Config and test values**: lease 120s default / 200ms in tests; retry budget 3; backoff `min(backoffBase × 2^attempts, cap)` — 5s/60s defaults, 0 in tests except TC-1.8's backoff leg (50ms). `maxItems` stops with `stoppedBecause: "max_items"` + `remaining`.

**Scheduler test-hook** (TC-1.2): pass-count observability is test-only — name it as such in the scheduler module; it must not become API.

**Reclaim semantics**: the CASE in claimNext increments `attempts` only when reclaiming an expired `claimed` row; normal claims never touch it — failed runs count themselves via failAttempt. Double-run after reclaim is harmless: the first run's write either landed (completing the item) or lands stale and discards against the source-version check.

**supersedeQueued ships here** (issue 1) as util mechanics; its only caller is Story 5's cascade. Same for `stale_discarded` — the truth-table row exists, TC-5.4 cashes it.

#### Anti-Shim Requirements

- The queue is the rows: no in-memory queue mirror; a fresh handle must see identical drain behavior.
- `claimNext` is one atomic statement under `BEGIN IMMEDIATE` — no read-then-write split (the race window is the bug class).
- The drain must not catch a handler error and record success; failAttempt/terminal paths are the only exits.
- Unknown-kind handling must route through the normal completion transaction (`failed_terminal` + reason), not a try/catch skip.
- TC-1.3's runner must verify item 1's form content by byte-compare against a pre-kill read — not by "still ready".

#### Production Path Proof

- Entrypoint: `lhc work drain --file-path` (manual); `createSdk({ mode: "background" })` scheduling (background).
- Registration/default path: every queue site reaches processing through `enqueue → onCommit poke → scheduler → drain` (DD-5) — no caller-side nudges anywhere.
- Evidence: TC-1.5 proves the no-explicit-call path end to end; the CLI parity row proves `dist/cli.js` through a spawned process, not an in-process import.

#### Verification

- Targeted: `pnpm vitest run test/work-execution.test.ts`; `LHC_PROCESS_SUITE=1 pnpm vitest run test/cli-process-work.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

| Date | Deviation | Disposition |
|---|---|---|
| 2026-06-10 | Pre-implementation patch: terminal rows deleted not retained (DD-1); `superseded` moved off the drain report onto MutationResult; `drainSettled` takes `ThreadRef` | Spec updated before implementation; build to current text |

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-1.1 through TC-1.8 green, including the spawned-process kill test (TC-1.3)
- [ ] Architecture-risk set green: crash recovery (TC-1.3), no-skip-ahead under live claim (TC-1.4), coalesced burst (TC-1.2)
- [ ] Both host modes proven in tests; manual mode has CLI parity for drain
- [ ] No artifact visible as `ready` from a killed drain (NFR walk in TC-1.3)
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
- planner_turn_index: 6
- mode: resume
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: ruling-received
- current_child_operation: none
- current_summary: Caller ruling recorded and story-lead finalization is resuming.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/006-verify.json
- older_response_count: 3
- caller_input_artifact_count: 1
- prior_self_note_count: 2
- latest_self_note: "After the implementor fix for 01F-001, require a verifier continuation/pass before any acceptance recommendation; green-verify remains required evidence."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/006-verify.json
bytes: 3284
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "1b9a054f-da07-49f0-b1a7-50dcfcf474b9"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eb4d6-3996-71f3-9029-a0c7a13e47b4"
    continuation:
      provider: "codex"
      sessionId: "019eb4d6-3996-71f3-9029-a0c7a13e47b4"
      storyId: "01-queue-execution-drain"
    mode: "followup"
    story:
      id: "01-queue-execution-drain"
      title: "Story 1: Queue Execution and Drain"
    artifactsRead:
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/stories/01-queue-execution-drain.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/005-continue.json"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/test/work-execution-legacy.test.ts"
      - "packages/lhc/test/red-manifest.json"
    reviewScopeSummary: "Follow-up verification focused on prior finding 01F-001 and directly touched surfaces. The queue util now reconstructs legacy NULL-payload form targets from the v5 backfill mapping, and new regression tests cover terminal failure on upgraded Epic 01 rows. Focused tests and configured gates passed."
    priorFindingStatuses:
      -
        id: "01F-001"
        status: "resolved"
        rationale: "Resolved. packages/lhc/src/tech-utils/work-queue/index.ts now maps NULL-payload pre-v5 rows to sourceVersion 1 form targets for prompt_smoothing, tool_result_summary, and turn_derivation before failTerminal iterates item.forms. packages/lhc/test/work-execution-legacy.test.ts verifies retry exhaustion on a legacy single-form row and non-retryable terminal failure on a legacy two-form turn_derivation row, asserting failed forms with reason/attempts and zero live rows. Focused tests, green-verify, and verify-all passed."
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "AC-1.1 through AC-1.8 remain verified by the previously reviewed Story 1 tests and passing gates."
        - "AC-1.9/TC-1.8 is now verified for both fresh v5 rows and upgraded Epic 01 queued rows. New legacy coverage asserts failed terminal forms are stamped before row deletion for NULL-payload migrated rows."
        - "DD-1/F-02 terminal-row deletion plus durable failed-form outcome is verified for migrated rows by test/work-execution-legacy.test.ts."
      unverified:
[]
    gatesRun:
      -
        command: "pnpm vitest run test/work-execution-legacy.test.ts test/work-execution.test.ts test/thread-migration.test.ts"
        result: "pass"
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
    productionPathFindings:
[]
    recommendedNextStep: "pass"
    recommendedFixScope: "quick-fix"
    openQuestions:
[]
    additionalObservations:
      - "green-verify passed with 154 tests across 14 files and test immutability OK for 19 red-phase files."
      - "verify-all passed with 173 tests across 21 files, including the process suite."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/006-verify.json"
  startedAt: "2026-06-11T04:10:13.070Z"
  finishedAt: "2026-06-11T04:11:25.328Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/003-implementor.json
bytes: 10326
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "3a08c39a-caeb-4198-80a5-72a8b22ec9a5"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "b93e566a-c98e-4b05-8100-3f1a70ca0688"
    continuation:
      provider: "claude-code"
      sessionId: "b93e566a-c98e-4b05-8100-3f1a70ca0688"
      storyId: "01-queue-execution-drain"
    outcome: "ready-for-verification"
    story:
      id: "01-queue-execution-drain"
      title: "Story 1: Queue Execution and Drain"
    planSummary: "Implemented Story 1 queue execution and drain: claim mechanics in tech-utils/work-queue (claimNext as one atomic head-first UPDATE under BEGIN IMMEDIATE with expired-lease reclaim incrementing attempts; complete doing version-checked UPDATE-only form writes plus item-row deletion in one short txn returning done/stale_discarded; failAttempt with backoff eligibility and terminal exhaustion copying attempts/last-error onto the failed form; failTerminal for blocked/unknown-kind; supersedeQueued and queueDetail shipped as mechanics). Drain loop and DrainReport live in scheduler.ts per tech-design placement, dispatching through the SDK handler map with no open transaction around handlers; unknown kinds land failed_terminal/unknown_work_kind and the drain continues. Background mode: per-thread single-flight with pending-flag coalescing, post-commit pokes via the existing DD-5 seam, a new thread-touch seam fired by openThreadDatabase for DD-10 first-touch catch-up, and drainSettled(ref). Manual mode: sdk.work.drain plus CLI parity via new `lhc work drain` with DD-11 named-provider resolution (--provider / LHC_PROVIDER, deterministic provider registered in src/providers). Tests: work-execution.test.ts (TC-1.1/1.2/1.5/1.6/1.7/1.8 incl. backoff head-gates-queue leg, non-retryable terminal, max_items) and cli-process-work.test.ts (TC-1.3 SIGKILL in the claim-complete window via a spawned tsx drain runner with marker protocol and byte-compare; TC-1.4 cross-process claim exclusion with spawned CLI and skip-ahead proof; CLI parity and provider-resolution legs)."
    changedFiles:
      -
        path: "packages/lhc/src/tech-utils/work-queue/index.ts"
        reason: "claimNext/complete/failAttempt/failTerminal/supersedeQueued/queueDetail/countLiveItems; enqueue payload now carries sourceVersion + form targets for domain-blind terminal paths"
      -
        path: "packages/lhc/src/scheduler.ts"
        reason: "drain loop + DrainReport assembly (claim→dispatch→complete), runDrain entry, background scheduler (single-flight, pending coalesce, catch-up Set, drainSettled, test-only pass counter), peekThreadId"
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "work.drain surface, drainSettled(ref), scheduler wired with drain deps, background-mode seam installation, new exports (DrainReport, providers, queue mechanics, setThreadTouch)"
      -
        path: "packages/lhc/src/shared/context.ts"
        reason: "thread-touch seam (setThreadTouch/fireThreadTouch) for DD-10 first-touch catch-up, parallel to the DD-5 poke slot"
      -
        path: "packages/lhc/src/shared/derivation.ts"
        reason: "HandlerFormWrite type, HandlerOutcome success arm gains optional forms[], DerivedFormMetadata extended with attempts/lastError for exhaustion copy (DD-1)"
      -
        path: "packages/lhc/src/shared/errors.ts"
        reason: "provider_not_configured caller_error code (DD-11)"
      -
        path: "packages/lhc/src/domains/threads/internal/create.ts"
        reason: "openThreadDatabase fires the thread-touch seam after migration, before any caller transaction"
      -
        path: "packages/lhc/src/providers/deterministic.ts"
        reason: "NEW: deterministic provider + shared digest/marker helpers backing the registry entry and the test double (byte-identical output)"
      -
        path: "packages/lhc/src/providers/registry.ts"
        reason: "NEW: named-provider registry for CLI resolution (DD-11); deterministic registered, never a default"
      -
        path: "packages/lhc/src/cli/work.ts"
        reason: "NEW: lhc work drain — provider resolution (--provider/LHC_PROVIDER → registry → provider_not_configured) and drain through the same createSdk assembly production hosts use"
      -
        path: "packages/lhc/src/cli/index.ts"
        reason: "work drain command wiring, --max-items/--provider flags, help text"
      -
        path: "packages/lhc/test/fixtures/work-handlers.ts"
        reason: "NEW: registered test handlers per work kind calling the provider seam, with onHandlerStart hook for the runner marker/hold protocol"
      -
        path: "packages/lhc/test/fixtures/drain-runner.ts"
        reason: "NEW: spawnable drain runner for TC-1.3 (kill in reclaim window) and TC-1.4 (hold live claim)"
      -
        path: "packages/lhc/test/fixtures/provider-double.ts"
        reason: "double now reuses src deterministic helpers so in-process and spawned artifacts are byte-identical; behavior unchanged (pinned fixtures.test green)"
      -
        path: "packages/lhc/test/fixtures/index.ts"
        reason: "export new work-handler fixtures"
      -
        path: "packages/lhc/vitest.config.ts"
        reason: "gate cli-process-work.test.ts behind LHC_PROCESS_SUITE=1 like the other process suites"
      -
        path: "packages/lhc/test/work-execution.test.ts"
        reason: "NEW: TC-1.1, TC-1.2, TC-1.5, TC-1.6, TC-1.7, TC-1.8 (+ non-retryable and max_items legs) with DD-1 raw zero-row assertions"
      -
        path: "packages/lhc/test/cli-process-work.test.ts"
        reason: "NEW: TC-1.3 SIGKILL restart survival, TC-1.4 cross-process claim exclusion with skip-ahead proof, CLI parity + DD-11 provider-resolution legs"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "recorded the two new red-phase test files (sanctioned story step)"
    tests:
      added:
        - "test/work-execution.test.ts (11 tests)"
        - "test/cli-process-work.test.ts (5 tests)"
      modified:
[]
      removed:
[]
      totalAfterStory: 171
      deltaFromPriorBaseline: 16
    gatesRun:
      -
        command: "pnpm vitest run test/work-execution.test.ts"
        result: "pass"
      -
        command: "LHC_PROCESS_SUITE=1 pnpm vitest run test/cli-process-work.test.ts"
        result: "pass"
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "Background-SDK construction installing process-global seams would have let the pinned fixtures.test.ts background SDK (empty handler map) catch-up-drain later fixture threads in the same file, destroying their pending states — fixed by gating background pokes/catch-up on a non-empty handler map (fail-closed: a drain with no handlers can only destroy queue rows)"
        - "Removed a leftover placeholder hasHandlers closure in scheduler.ts; the gate now lives on DrainDeps.hasAnyHandler"
        - "cli-process-work.test.ts initially missing from the vitest process-suite exclude list — added so plain `verify` does not spawn dist-dependent tests"
      findingsSurfaced:
        - "TC-1.2's pass-count assertion has mild timing sensitivity: if batches B/C take longer than item A's 100ms scripted handler delay, a third pass could occur; mitigated by the synchronous running-flag (pokes coalesce from the moment the first poke lands) and observed stable across runs"
        - "The poke/touch seam slots are process-global with last-background-SDK-wins semantics; a displaced background scheduler goes inert (its in-memory state is advisory; rows remain durable). Acceptable for the SDK's one-host model but worth a verifier look"
        - "Background drains stopping on a backing-off head ('waiting') are not timer-rescheduled; the head runs on the next poke or touch. No AC/TC requires timer wakeups; noted as designed behavior"
    openQuestions:
      - "Story 3's turn-derivation completion must add chunk placement/close and summary enqueues inside the completion transaction; the HandlerOutcome.forms-as-data shape implemented here may need a transactional-hook extension at that point (flagged for the Story 3 implementor)"
      - "DrainReport.ran reports kind as WorkKind but an unregistered raw row carries an arbitrary string (TC-1.7's bogus_kind) — typed as WorkKind via cast; acceptable or worth a widened type?"
    specDeviations:
      - "HandlerOutcome success arm extended with optional forms?: HandlerFormWrite[] (additive): handlers hand form content back as data and the queue util's complete() performs the version-checked UPDATE + row deletion in one transaction, keeping the DD-3 truth table and done/stale_discarded disposition in one place. Spec's interface block showed bare { ok: true } with the write attributed ambiguously to handler vs completion txn"
      - "Background scheduling (pokes and first-touch catch-up) is gated on a non-empty handler map, fail-closed — with zero registered handlers a background drain could only convert queued rows to failed_terminal. Protects pinned Story-0 fixtures.test.ts, which constructs a background SDK before fixture-builder tests in the same file"
      - "provider_not_configured added to shared/errors.ts ErrorCode — named by DD-11 but absent from the tech design §Interfaces code list"
      - "Deterministic provider implemented in src/providers/deterministic.ts (not only as a test double) so the DD-11 registry is reachable from dist/cli.js; the test double keeps its scripting in test/fixtures and reuses the src output helpers for byte-identical artifacts"
      - "work_item.payload carries { sourceVersion, forms } (form targets), extending the migration comment's { sourceVersion?, form? } sketch, so the domain-blind terminal paths can land failed/blocked form states without consulting domains"
      - "derived_form has no attempts/last_error columns; DD-1's 'final attempts/last-error copied onto the form row' lands in the metadata JSON (DerivedFormMetadata.attempts/lastError)"
      - "test/red-manifest.json regenerated to add the two new red-phase files (sanctioned red-phase step)"
    recommendedNextStep: "Hand to the story verifier: all TC-1.x and the architecture-risk set are green through both gates (green-verify 152, verify-all 171, +16 over the 155 baseline). Verifier should specifically eyeball the two judgment calls flagged in specDeviations (HandlerOutcome.forms shape and the empty-handler-map background gate) before Story 2 builds on the handler contract."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/003-implementor.json"
  startedAt: "2026-06-11T03:32:38.912Z"
  finishedAt: "2026-06-11T03:59:46.237Z"
```
</history_entry>

<history_entry>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/004-verify.json
bytes: 6718
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "83b99f22-596a-44e2-b78b-e44c771e0692"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eb4d6-3996-71f3-9029-a0c7a13e47b4"
    continuation:
      provider: "codex"
      sessionId: "019eb4d6-3996-71f3-9029-a0c7a13e47b4"
      storyId: "01-queue-execution-drain"
    mode: "initial"
    story:
      id: "01-queue-execution-drain"
      title: "Story 1: Queue Execution and Drain"
    artifactsRead:
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/stories/01-queue-execution-drain.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/003-implementor.json"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/team-impl-log.md"
      - "packages/lhc/src/shared/storage.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/src/scheduler.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/src/shared/context.ts"
      - "packages/lhc/src/cli/work.ts"
      - "packages/lhc/src/cli/index.ts"
      - "packages/lhc/src/domains/messages/index.ts"
      - "packages/lhc/src/domains/turns/index.ts"
      - "packages/lhc/src/domains/intake-stream/internal/pipeline.ts"
      - "packages/lhc/src/domains/threads/internal/create.ts"
      - "packages/lhc/test/work-execution.test.ts"
      - "packages/lhc/test/cli-process-work.test.ts"
      - "packages/lhc/test/thread-migration.test.ts"
      - "packages/lhc/test/fixtures/legacy.ts"
      - "packages/lhc/test/fixtures/work-handlers.ts"
      - "packages/lhc/test/fixtures/drain-runner.ts"
      - "focused legacy pre-v5 terminal-failure probe output: failed_terminal report for w-m1-prompt_smoothing, but m1/smoothed_prompt remained pending"
    reviewScopeSummary: "Verified Story 1 against the story ACs, tech design, test plan, implementation paths for queue mechanics, scheduler, SDK and CLI, plus the Story 1 test suites and gates. Configured gates pass, but one blocking production-path issue remains in the migrated Epic 01 queued-row terminal failure path."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "01F-001"
        severity: "major"
        title: "Migrated queued rows delete on terminal failure without marking the artifact failed"
        evidence: "Migration v5 backfills derived_form rows for pre-v5 queued work but leaves work_item.payload NULL; thread-migration.test.ts currently asserts payload is null. toClaimedItem maps NULL payload to forms: [], and failTerminal only updates derived_form by iterating item.forms before deleting the work row. A focused probe using legacyEpic01ThreadFile, budget=1, and failKind('prompt_smoothing') produced a failed_terminal report for w-m1-prompt_smoothing, deleted that row, and left m1/smoothed_prompt as state='pending' instead of failed with the final reason. This violates AC-1.9/DD-1 for upgraded Epic 01 rows."
        affectedFiles:
          - "packages/lhc/src/shared/storage.ts"
          - "packages/lhc/src/tech-utils/work-queue/index.ts"
          - "packages/lhc/test/thread-migration.test.ts"
        requirementIds:
          - "AC-1.9"
          - "TC-1.8"
          - "DD-1"
          - "F-02"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    openFindings:
      -
        id: "01F-001"
        severity: "major"
        title: "Migrated queued rows delete on terminal failure without marking the artifact failed"
        evidence: "Migration v5 backfills derived_form rows for pre-v5 queued work but leaves work_item.payload NULL; thread-migration.test.ts currently asserts payload is null. toClaimedItem maps NULL payload to forms: [], and failTerminal only updates derived_form by iterating item.forms before deleting the work row. A focused probe using legacyEpic01ThreadFile, budget=1, and failKind('prompt_smoothing') produced a failed_terminal report for w-m1-prompt_smoothing, deleted that row, and left m1/smoothed_prompt as state='pending' instead of failed with the final reason. This violates AC-1.9/DD-1 for upgraded Epic 01 rows."
        affectedFiles:
          - "packages/lhc/src/shared/storage.ts"
          - "packages/lhc/src/tech-utils/work-queue/index.ts"
          - "packages/lhc/test/thread-migration.test.ts"
        requirementIds:
          - "AC-1.9"
          - "TC-1.8"
          - "DD-1"
          - "F-02"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    requirementCoverage:
      verified:
        - "AC-1.1/TC-1.1: fresh v5 rows drain in queue order across owners, report done dispositions, delete terminal rows, and ready derived forms in packages/lhc/test/work-execution.test.ts."
        - "AC-1.2/TC-1.2: background mid-drain enqueue burst processes all items and records exactly two passes in packages/lhc/test/work-execution.test.ts."
        - "AC-1.3/TC-1.3: spawned SIGKILL reclaim test verifies unfinished items drain later, ready artifact byte-compare holds, and no duplicate form rows in packages/lhc/test/cli-process-work.test.ts."
        - "AC-1.4/TC-1.4: spawned second drain reports in_flight, ran=[], remaining=2, and the queued item behind the live head stays unclaimed in packages/lhc/test/cli-process-work.test.ts."
        - "AC-1.5/AC-1.6/TC-1.5: background queueing and first-touch catch-up are covered in packages/lhc/test/work-execution.test.ts."
        - "AC-1.7/TC-1.6: isolated manual-mode SDK leaves rows queued until work.drain in packages/lhc/test/work-execution.test.ts."
        - "AC-1.8/TC-1.7: unregistered kind reports failed_terminal/unknown_work_kind and the following valid item runs in packages/lhc/test/work-execution.test.ts."
        - "AC-1.9/TC-1.8 for fresh v5 rows: retry-to-success, exhaustion-to-failed, non-retryable terminal, and backoff head gating are covered in packages/lhc/test/work-execution.test.ts."
        - "CLI drain parity and DD-11 provider resolution are covered in packages/lhc/test/cli-process-work.test.ts."
      unverified:
        - "AC-1.9/TC-1.8/DD-1 for migrated Epic 01 queued rows is unmet: terminal failure leaves the backfilled form pending after deleting the work row."
    gatesRun:
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
      -
        command: "focused legacy pre-v5 terminal-failure probe (pnpm exec tsx -e ...)"
        result: "fail"
    productionPathFindings:
      - "01F-001: pre-v5 queued rows migrated by the production v5 migration can terminal-fail without updating derived_form because payload/form targets are absent."
    recommendedNextStep: "revise"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "Configured story and epic gates passed: green-verify reported 152 tests passing; verify-all reported 171 tests passing."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/004-verify.json"
  startedAt: "2026-06-11T03:59:58.722Z"
  finishedAt: "2026-06-11T04:06:38.018Z"
```
</history_entry>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/005-continue.json
bytes: 4574
payload:
  command: "story-continue"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "0e0e56ba-279b-420e-85b0-6bc50a4a28ac"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "b93e566a-c98e-4b05-8100-3f1a70ca0688"
    continuation:
      provider: "claude-code"
      sessionId: "b93e566a-c98e-4b05-8100-3f1a70ca0688"
      storyId: "01-queue-execution-drain"
    outcome: "ready-for-verification"
    story:
      id: "01-queue-execution-drain"
      title: "Story 1: Queue Execution and Drain"
    planSummary: "Fixed verifier finding 01F-001: pre-v5 migrated work_item rows carry payload NULL, so toClaimedItem resolved forms: [] and the terminal paths (failAttempt exhaustion, non-retryable failure, failTerminal) deleted the work row while leaving the F-02 backfilled derived_form stranded as pending. Fix is in the queue util's row materialization: when payload is NULL, form targets are reconstructed from the same kind→form mapping the migration v5 backfill uses (prompt_smoothing → message/smoothed_prompt; tool_result_summary → message/tool_result_summary; turn_derivation → turn/turn_rendering + turn/lower_band_projection) at source version 1, matching the backfilled rows exactly. Every terminal path now finds and stamps the backfilled form failed with final reason and attempts before deleting the row (AC-1.9/DD-1 for upgraded Epic 01 threads). Unknown raw kinds (TC-1.7's bogus_kind) still resolve to no forms, preserving that behavior. Added focused coverage in a new test file (red-phase files are immutable) draining a true Epic 01 v4 legacy file through the production upgrade path: one test for retry exhaustion on a legacy single-form item, one for non-retryable terminal failure on the legacy two-form turn_derivation item, both asserting failed forms with reason/attempts, source version 1, zero stranded pending forms, and zero live rows."
    changedFiles:
      -
        path: "packages/lhc/src/tech-utils/work-queue/index.ts"
        reason: "toClaimedItem reconstructs form targets for NULL-payload (pre-v5) rows via LEGACY_KIND_FORMS — the F-02 backfill's own kind→form mapping at source version 1 — so terminal failure writes find the backfilled pending forms"
      -
        path: "packages/lhc/test/work-execution-legacy.test.ts"
        reason: "NEW: 01F-001 regression coverage — legacy Epic 01 file drained through the upgrade path with exhaustion and non-retryable terminal legs; forms failed with reason/attempts, never stranded pending"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "recorded the new test file in the immutability manifest"
    tests:
      added:
        - "test/work-execution-legacy.test.ts (2 tests)"
      modified:
[]
      removed:
[]
      totalAfterStory: 173
      deltaFromPriorBaseline: 2
    gatesRun:
      -
        command: "pnpm vitest run test/work-execution-legacy.test.ts test/work-execution.test.ts test/thread-migration.test.ts"
        result: "pass"
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "First draft of the non-retryable leg scripted the double by work kind (turn_derivation), which the double's alias table does not know — caught by the failing run and rescripted on the handler's first provider op (turn_rendering)"
      findingsSurfaced:
        - "The legacy kind→form mapping now exists in two places: the migration v5 backfill SQL (shared/storage.ts) and LEGACY_KIND_FORMS in the queue util. They must stay in step; both sites carry comments naming each other. A shared constant would require shared/storage to import derivation types — left as-is to keep the fix minimal, worth a verifier opinion"
        - "LEGACY_KIND_FORMS deliberately omits tool_call_summary and the chunk kinds: no pre-v5 row can carry them (Epic 01 queued only the three mapped kinds), and an unknown raw kind still resolves to no forms, preserving TC-1.7's bogus-kind behavior"
    openQuestions:
[]
    specDeviations:
      - "test/red-manifest.json regenerated to add the new 01F-001 regression test file (same sanctioned mechanism as the story's red-phase recording)"
    recommendedNextStep: "Re-verify 01F-001 against the new coverage: gates green (green-verify 154 in-process, verify-all 173 including the process suite; +2 over the story's 171)."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/005-continue.json"
  startedAt: "2026-06-11T04:06:51.764Z"
  finishedAt: "2026-06-11T04:10:04.807Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-current.json
Bytes: 4267

```yaml
storyRunId: "01-queue-execution-drain-story-run-001"
storyId: "01-queue-execution-drain"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Caller ruling recorded and story-lead finalization is resuming."
currentPhase: "ruling-received"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/004-verify.json"
    provenance: "current-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/005-continue.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/006-verify.json"
    provenance: "current-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-final-package.json"
    provenance: "current-run"
  -
    kind: "ruling-response"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-ruling-response-001.json"
    provenance: "caller-input"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "b93e566a-c98e-4b05-8100-3f1a70ca0688"
    storyId: "01-queue-execution-drain"
  storyVerifier:
    provider: "codex"
    sessionId: "019eb4d6-3996-71f3-9029-a0c7a13e47b4"
    storyId: "01-queue-execution-drain"
latestEventSequence: 20
callerInputHistory:
  reviewRequests:
[]
  rulings:
    -
      rulingRequestId: "01-queue-execution-drain-story-run-001-ruling-spec-deviation"
      decision: "approve"
      rationale: "All seven deviations approved: (1) HandlerOutcome.forms additive extension centralizes the version-checked UPDATE + row deletion in complete()'s single transaction — this strengthens the anti-shim 'one form-write path' rule rather than weakening it; (2) fail-closed background gating on an empty handler map protects pinned Story 0 tests and only defers scheduling that could do nothing useful; (3) provider_not_configured error code is named by DD-11, its absence from the interface list was a spec omission; (4) deterministic provider in src/providers/ is required for spawned CLI tests to reach the registry through dist/cli.js per the test plan's no-test-only-path rule; (5) payload { sourceVersion, forms } extension keeps terminal paths domain-blind; (6) attempts/lastError in DerivedFormMetadata JSON satisfies DD-1's copy-at-exhaustion without schema churn; (7) red-manifest regeneration for new red-phase files is the sanctioned mechanism. None alter epic contracts or AC semantics."
      source: "impl-lead"
nextIntent:
  actionType: "apply-ruling"
  summary: "01-queue-execution-drain-story-run-001-ruling-spec-deviation: approve"
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-ruling-response-001.json"
replayBoundary: null
updatedAt: "2026-06-11T04:12:25.790Z"
```

## Caller Input Artifacts

### ruling-response
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-ruling-response-001.json
Bytes: 1150

```yaml
rulingRequestId: "01-queue-execution-drain-story-run-001-ruling-spec-deviation"
decision: "approve"
rationale: "All seven deviations approved: (1) HandlerOutcome.forms additive extension centralizes the version-checked UPDATE + row deletion in complete()'s single transaction — this strengthens the anti-shim 'one form-write path' rule rather than weakening it; (2) fail-closed background gating on an empty handler map protects pinned Story 0 tests and only defers scheduling that could do nothing useful; (3) provider_not_configured error code is named by DD-11, its absence from the interface list was a spec omission; (4) deterministic provider in src/providers/ is required for spawned CLI tests to reach the registry through dist/cli.js per the test plan's no-test-only-path rule; (5) payload { sourceVersion, forms } extension keeps terminal paths domain-blind; (6) attempts/lastError in DerivedFormMetadata JSON satisfies DD-1's copy-at-exhaustion without schema churn; (7) red-manifest regeneration for new red-phase files is the sanctioned mechanism. None alter epic contracts or AC semantics."
source: "impl-lead"
```

## Prior Self Notes
Latest note highlight: After the implementor fix for 01F-001, require a verifier continuation/pass before any acceptance recommendation; green-verify remains required evidence.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-11T03:32:38.877Z; note="Before any acceptance recommendation, require verifier pass evidence plus the configured story gate `pnpm run green-verify`; spawned-process TC-1.3 and TC-1.4 evidence is load-bearing."
- sequence=11; actionSequence=10; createdAt=2026-06-11T04:06:51.729Z; note="After the implementor fix for 01F-001, require a verifier continuation/pass before any acceptance recommendation; green-verify remains required evidence."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-events.jsonl
Bytes: 8655

```yaml
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T03:32:23.947Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 2
  timestamp: "2026-06-11T03:32:38.858Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb4bc-f98b-70a2-999f-4d98f8ac773e"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 3
  timestamp: "2026-06-11T03:32:38.877Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "Before any acceptance recommendation, require verifier pass evidence plus the configured story gate `pnpm run green-verify`; spawned-process TC-1.3 and TC-1.4 evidence is load-bearing."
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 4
  timestamp: "2026-06-11T03:32:38.877Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "Before any acceptance recommendation, require verifier pass evidence plus the configured story gate `pnpm run green-verify`; spawned-process TC-1.3 and TC-1.4 evidence is load-bearing."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 5
  timestamp: "2026-06-11T03:59:46.246Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 6
  timestamp: "2026-06-11T03:59:58.655Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019eb4d6-08cd-7b70-ba8c-7a8a72c1cb10"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 7
  timestamp: "2026-06-11T03:59:58.679Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 8
  timestamp: "2026-06-11T04:06:38.028Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
    status: "ok"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 9
  timestamp: "2026-06-11T04:06:51.704Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019eb4dc-5160-7310-99bc-269ae7f545b8"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 10
  timestamp: "2026-06-11T04:06:51.729Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-continue."
  data:
    actionType: "run-continue"
    turn: 3
    selfNote: "After the implementor fix for 01F-001, require a verifier continuation/pass before any acceptance recommendation; green-verify remains required evidence."
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 11
  timestamp: "2026-06-11T04:06:51.729Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After the implementor fix for 01F-001, require a verifier continuation/pass before any acceptance recommendation; green-verify remains required evidence."
    actionSequence: 10
    actionType: "run-continue"
    turn: 3
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 12
  timestamp: "2026-06-11T04:10:04.815Z"
  type: "child-operation-completed"
  summary: "story-continue completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/005-continue.json"
  data:
    actionType: "run-continue"
    command: "story-continue"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 13
  timestamp: "2026-06-11T04:10:13.009Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/prompts/001-planner-turn-004.md"
    sessionId: "019eb4df-791a-7a30-937c-95f4038a04fa"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 14
  timestamp: "2026-06-11T04:10:13.033Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 4
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 15
  timestamp: "2026-06-11T04:11:25.337Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/006-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "pass"
    status: "ok"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 16
  timestamp: "2026-06-11T04:11:38.669Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/prompts/001-planner-turn-005.md"
    sessionId: "019eb4e0-b39d-7d10-9f07-3fc9b1eb48c0"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 17
  timestamp: "2026-06-11T04:11:38.690Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected accept-story."
  data:
    actionType: "accept-story"
    turn: 5
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 18
  timestamp: "2026-06-11T04:11:38.722Z"
  type: "needs-ruling"
  summary: "Story-lead finalized 01-queue-execution-drain-story-run-001 with outcome needs-ruling."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-final-package.json"
  data:
    terminalDecision: "accept"
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 19
  timestamp: "2026-06-11T04:12:25.764Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 20
  timestamp: "2026-06-11T04:12:25.789Z"
  type: "ruling-received"
  summary: "Caller ruling received for 01-queue-execution-drain-story-run-001-ruling-spec-deviation."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-ruling-response-001.json"
  data:
    rulingRequestId: "01-queue-execution-drain-story-run-001-ruling-spec-deviation"
    decision: "approve"
    source: "impl-lead"
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
