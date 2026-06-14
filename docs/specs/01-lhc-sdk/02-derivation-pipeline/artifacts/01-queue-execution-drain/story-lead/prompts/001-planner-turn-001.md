# Story Lead Base Prompt

## Role Charter
You are the story lead for `01-queue-execution-drain` on durable story run `01-queue-execution-drain-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-current.json
Bytes: 970

```yaml
storyRunId: "01-queue-execution-drain-story-run-001"
storyId: "01-queue-execution-drain"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/001-story-validate.json"
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
updatedAt: "2026-06-11T03:32:23.948Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/01-queue-execution-drain/story-lead/001-events.jsonl
Bytes: 224

```yaml
-
  storyRunId: "01-queue-execution-drain-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T03:32:23.947Z"
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
