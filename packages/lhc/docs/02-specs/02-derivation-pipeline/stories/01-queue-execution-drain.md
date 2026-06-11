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
