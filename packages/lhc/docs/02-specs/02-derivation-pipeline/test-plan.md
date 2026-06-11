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
