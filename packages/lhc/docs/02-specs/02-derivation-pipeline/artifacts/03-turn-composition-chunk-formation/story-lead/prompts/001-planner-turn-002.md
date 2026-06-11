# Story Lead Base Prompt

## Role Charter
You are the story lead for `03-turn-composition-chunk-formation` on durable story run `03-turn-composition-chunk-formation-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 2.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/stories/03-turn-composition-chunk-formation.md
Bytes: 16877

# Story 3: Turn Composition and Chunk Formation

### Summary
<!-- Jira: Summary field -->

The `turns` derivation layer: turn rendering composed from message-level forms with recorded fallback gaps, lower-band projection, deterministic chunk close policy, and the two chunk summaries.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The agent's future thread-views stand on these artifacts — turn renderings, projections, and chunk summaries are the bands' raw material; gap records are the freshness debt the report surfaces.

**Objective:** Closed turns become composed artifacts and chunks form deterministically. The `turn_derivation` handler composes the turn's rendering from its messages' derived forms — falling back to raw or truncated source where a form isn't `ready`, recording each fallback as a gap; tool activity composes into outcome-explicit run accounts — then projects the rendering to the lower band. Chunk placement and close run by accumulated projected size; closing queues the two summary kinds with independent lifecycles.

**Scope — in:**
- `turn_derivation` handler: compose rendering from message forms in message order (smoothed prompt or raw prompt; tool summaries or deterministic truncation), record a gap per fallback naming the source record and missing form, land rendering `ready`, then project lower band from the rendering
- Tool-run composition: tool activity appears as composed accounts of runs, each stating its outcome; a run containing a state-changing call never loses its outcome in composition (AC-3.4)
- Gap semantics: a gapped artifact is `ready` and usable — freshness debt, not defect; a later-repaired dependency does not auto-cascade (AC-3.3); gaps clear only when the artifact is explicitly rebuilt
- Chunk placement at turn derivation: a turn whose projection succeeded joins the open chunk, placement recorded with the turn; when accumulated projected size plus the incoming turn's would cross the close target, the chunk closes *without* the incoming turn, which starts the next chunk (AC-3.6); a single turn whose projection alone meets the max forms its own chunk immediately (AC-3.7)
- Chunk close queues `chunk_summary_detailed` and `chunk_summary_brief` as two work items with independent retry, states, and re-queue; detailed preserves tool-activity receipts, brief preserves outcomes only
- Determinism: replaying the same record through the same policy values produces identical chunk membership — no inference in placement or close

**Scope — out:** Report surface that exposes gaps (Story 4). The public re-queue operation with refusal/idempotency semantics (Story 4) — TC-3.3's re-queues drive the queue util directly. Mutations that shrink membership (Story 6 — the one sanctioned exception, and it shrinks, never re-cuts).

**Dependencies:** Story 2 (message forms to compose from). Story 1 (drain). Story 0 (double's compose/project/summarize operations, chunk kinds registered).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-3.1**: A closed turn's derivation work lands a smoothed rendering and a lower-band projection, each carrying its own state.
  - **TC-3.1** (AC-3.1): Close a turn with all message forms ready, drain → rendering and projection `ready`, independent state rows.
- **AC-3.2**: The rendering composes message-level forms where they are `ready`; where a form is `pending` or `failed`, the rendering uses the message's raw or truncated content and still lands `ready`, recording each fallback as a dependency gap on the artifact — message-form gaps degrade the rendering's inputs, they do not fail the turn.
  - **TC-3.2** (AC-3.2): Close a turn where one prompt's smoothing failed → rendering `ready`, contains that message's raw content, other forms composed, gap recorded naming the message and form.
- **AC-3.3**: A dependency later becoming `ready` does not silently change artifacts that landed with a gap: they stay `ready`, their gap records stand, and the report surfaces them; rebuilding a gapped artifact is an explicit re-queue through its owning surface (Flow 4), never an automatic cascade.
  - **TC-3.3** (AC-3.3): Repair the failed smoothing to `ready` after the rendering landed → rendering unchanged, gap still reported; re-queue the rendering through `turns` → rebuilt without the gap, gap record cleared. *Story note: the re-queues in this TC use the work-queue enqueue directly (Story 1's util); the public re-queue operation with refusal and idempotency semantics is Story 4's (AC-4.4–4.6).*
- **AC-3.4**: Tool activity in a rendering appears as composed accounts of runs, each stating its outcome; a run containing a state-changing call never loses its outcome in composition.
  - **TC-3.4** (AC-3.4): Turn with a three-call edit run (one `isError`) → rendering's account states the run's outcome; failed call's outcome present.
- **AC-3.5**: A turn whose lower-band projection succeeded joins the open chunk; placement is recorded with the turn and readable through `turns`.
  - **TC-3.5** (AC-3.5): Drain a closed turn → turn read-back shows chunk placement.
- **AC-3.6**: A chunk closes when the accumulated projected size of its turns plus the incoming turn's crosses the close target; the incoming turn starts the next chunk when placement would cross it, per the policy's accumulation rule.
  - **TC-3.6** (AC-3.6): Turns sized so the third crosses the target → chunk closes holding two; third opens the next chunk.
- **AC-3.7**: A single turn whose projection alone meets or exceeds the close maximum forms its own chunk immediately.
  - **TC-3.7** (AC-3.7): One turn whose projection exceeds the max → own chunk, closed immediately.
- **AC-3.8**: Chunk close queues detailed and brief summary work as two work items with independent retry; both land as chunk-level derived forms with independent states. The detailed summary preserves tool-activity receipts (what changed, outcome); the brief summary preserves outcomes only.
  - **TC-3.8** (AC-3.8): Close a chunk, drain → detailed and brief summaries `ready`; double-marked content distinguishes them; detailed carries the run receipts fixture content, brief carries outcomes. Fail the brief item past budget with detailed succeeding → detailed `ready`, brief `failed`, independently re-queueable.
- **AC-3.9**: Chunk boundaries are deterministic: replaying the same record through the same policy values produces identical chunk membership.
  - **TC-3.9** (AC-3.9): Replay an identical event stream into a fresh thread → identical chunk membership and boundaries.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The `turns` derivation layer, and the epic's biggest single handler: `turn_derivation` composes the rendering from message-level forms (`compose.ts`: ready forms verbatim; non-ready fall back to raw/truncated content, one gap recorded per fallback; consecutive tool activity grouped into outcome-explicit run accounts), sends it through `composeTurnRendering` then `projectLowerBand`, lands both as turn forms — then placement runs *in the completion transaction*: append to the open chunk, close on the accumulated policy (DD-9), and closing enqueues both summary kinds as separate items with independent lifecycles.

Two invariants govern: **gaps are recorded facts, not live links** (AC-3.3 — a repaired dependency changes nothing until the dependent is explicitly rebuilt; this is the no-auto-cascade rule the epic's reviewers converged on), and **placement is pure arithmetic** (DD-9 — close decisions from stored projected token counts only, so identical streams re-chunk identically, AC-3.9). The close rule: when accumulated + incoming would cross the target, the chunk closes *without* the incoming turn, which opens the next chunk; a single projection ≥ max forms its own chunk. This is the v1 bug's fix — the MVP checked only the incoming turn's size, so small turns accumulated forever.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- Composition fallbacks, gap recording, deterministic placement arithmetic, and the close→enqueue chain all interact inside one handler's flow; the close policy has golden-case boundary semantics (crossing turn excluded) that a plausible-looking implementation gets wrong exactly the way v1 did.

Risk Reminders:
- The close decision *excludes* the incoming turn (it opens the next chunk) — TC-3.6's "closes at 2 members, third opens chunk 2" is the boundary-exactness assertion; off-by-one here recreates the v1 bug inverted.
- Gap recording must name `{subjectKind, subjectId, form}` per fallback — TC-3.3's later rebuild (Story 4's TC-4.4 consumes it) depends on gap precision.
- Placement runs in the completion transaction — a separate placement transaction would let a crash strand a derived-but-unplaced turn.
- TC-3.3's re-queues drive the queue util directly (story note in the AC section); don't reach for Story 4's surface early.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Turn handler | `src/domains/turns/internal/derive.ts` (NEW: orchestrates compose → provider → forms → placement) |
| Composition | `src/domains/turns/internal/compose.ts` (NEW: pure — forms+fallbacks → composition input + gaps) |
| Chunk mechanics | `src/domains/turns/internal/chunks.ts` (NEW: open-chunk append, close policy, member ordering) |
| Summary handlers | `src/domains/turns/internal/derive.ts` (chunk_summary_detailed / brief, member projections in turn order) |
| Turn forms | turn + chunk rows in `derived_form` via the same `forms.ts` UPDATE-only write pattern (subjectKind discriminates) |
| Surface | `src/domains/turns/index.ts` (workHandlers export; chunkId/memberIdx on turn read-back) |
| Tests | `test/derivation-turns.test.ts` (NEW) |

#### Design References

- [tech-design.md §Flow 3 (handler walk, placement, gap semantics)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:227), lines 227–229
- [tech-design.md DD-9 (close policy + golden cases)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:89), line 89
- [tech-design.md §Storage (chunk, chunk_member, derived_form subjects)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:155), lines 155–181
- [tech-design.md §Interfaces (DependencyGap, provider ops 4–7, chunk policy config)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:248), lines 248–300
- [tech-design.md §Mechanics (deleted-read filter — compose reads are filtered)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:426), line 426
- [test-plan.md §derivation-turns suite](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:53), lines 53–65

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-3.1 | `test/derivation-turns.test.ts` | rendering + projection ready as independent rows |
| TC-3.2 | `test/derivation-turns.test.ts` | failed smoothing → rendering ready w/ raw text; gap `{message, smoothed_prompt}` |
| TC-3.3 | `test/derivation-turns.test.ts` | repaired dependency → rendering unchanged, gap persists; explicit rebuild → gap clears, source version++ |
| TC-3.4 | `test/derivation-turns.test.ts` | 3-call run with one isError → account carries per-call outcomes |
| TC-3.5 | `test/derivation-turns.test.ts` | turn read-back shows chunkId + memberIdx |
| TC-3.6 | `test/derivation-turns.test.ts` | target=100, ~40 each: third turn closes chunk at 2, opens chunk 2 |
| TC-3.7 | `test/derivation-turns.test.ts` | projection 250 ≥ max 200 → own chunk, closed immediately |
| TC-3.8 | `test/derivation-turns.test.ts` | both summaries ready, distinct; brief fails alone, requeues alone |
| TC-3.9 | `test/derivation-turns.test.ts` | replay → deep-equal chunk/chunk_member |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Gap no-auto-cascade | TC-3.3 first leg | repair lands, dependent *unchanged*, no work queued | The tempting implementation (live join to dependency state) passes TC-3.2 and silently rebuilds |
| Boundary exactness | TC-3.6 + TC-3.7 | crossing turn excluded; max self-chunks | "Chunks form" passes with the v1 single-turn check; only exact member counts catch it |
| Determinism under replay | TC-3.9 | byte-equal membership across runs | Any hidden clock/inference input to placement breaks replay invisibly |

#### Technical Notes

**Dependency Gap contract** (epic Data Contracts): recorded on the composed artifact at derivation time; names the source record (messageId or turnId) and the form that fell back; the artifact is `ready` and usable. Lifecycle: created with the composition, persists through dependency repair (no auto-cascade — AC-3.3's no-silent-rebuild rule), cleared only by explicit rebuild of the gapped artifact (Flow 4 re-queue or mutation cascade).

**Chunk close policy** (epic Flow 3, tech design golden cases): accumulated projected tokens, config-with-defaults target and max. Accumulation rule: when `open chunk's accumulated + incoming turn's projection` would cross the target, the chunk closes holding its current members and the incoming turn opens the next chunk (TC-3.6: third turn crosses → chunk closes holding two, third opens chunk 2). Max rule: a single projection ≥ max forms its own chunk immediately. Size-only, reproducible from the record; exact threshold inclusivity per the tech design's golden table.

**Composition input shapes**: `composeTurnRendering` receives ordered per-message entries (form content or fallback content, flagged which); `projectLowerBand` receives the rendering; chunk summaries receive member projections in turn order. Exact interface shapes in tech design §Interfaces.

**Fallback rules**: prompt → raw content; tool call/result → deterministic truncation (Epic 01's truncation util); assistant text → raw (never had a form).

**Chunk policy config** (DD-9, config-with-defaults): target 2200 projected tokens, max 8000; tests override (TC-3.6 uses 100/200-scale values). Values are tuning knobs, not architecture — the *rule* (accumulation, crossing-turn-excluded, max-self-chunk) is the contract.

**Cross-story debt** (coverage.md): TC-3.2's gapped-rendering state is the input TC-4.4 consumes; build it via the fixture builder so Story 4 reuses it.

#### Anti-Shim Requirements

- `compose.ts` is pure: `(messages, forms) → { input, gaps }` — no DB handle, no provider, no clock in its signature; determinism is structural.
- Placement arithmetic reads stored projected token counts — never re-counts, never estimates at placement time.
- The close→enqueue chain runs in the completion transaction; both summary enqueues ride the same commit (a crash leaves either a closed chunk with two queued summaries or an open chunk — nothing between).
- Tool-run accounts group by *consecutive* tool activity — no cross-message reordering to make accounts tidier.

#### Production Path Proof

- Entrypoint: turn close (Epic 01's state machine) queues `turn_derivation`; no new commands — the pipeline reaches this story's code through normal conversation flow.
- Registration/default path: `turns.workHandlers` joins the map at `createSdk`; placement runs inside the handler's completion, not as a separate scheduled step.
- Evidence: TC-3.1/3.5 drive intake → turn close → drain → rendering + placement through the production chain; TC-3.9's replay proves no hidden inputs joined along the way.

#### Verification

- Targeted: `pnpm vitest run test/derivation-turns.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-3.1 through TC-3.9 green
- [ ] Architecture-risk tests green: gap-no-auto-cascade (TC-3.3), independent detailed/brief summary retry (TC-3.8), deterministic chunk membership and boundaries (TC-3.9)
- [ ] Chunk close golden cases from the tech design all asserted (target crossing with the incoming turn starting the next chunk, max self-chunk, threshold exactness)
- [ ] Double input recording proves composition consumed forms, not raw re-derivation (TC-3.4)
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
- planner_turn_index: 2
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-implement completed with outcome ready-for-verification and status ok.
- latest_response_kind: implementor-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/003-implementor.json
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementation returns, verify TC coverage, chunk close boundary evidence, gap no-auto-cascade evidence, independent summary retry evidence, and whether pnpm vitest run test/derivation-turns.test.ts plus the story gate passed."

## Response Trail
<current_response>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/003-implementor.json
bytes: 10435
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "22ecb0bc-4c68-4127-840a-bd93140c0de9"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "ba70f466-14e7-455b-b784-68aa93368849"
    continuation:
      provider: "claude-code"
      sessionId: "ba70f466-14e7-455b-b784-68aa93368849"
      storyId: "03-turn-composition-chunk-formation"
    outcome: "ready-for-verification"
    story:
      id: "03-turn-composition-chunk-formation"
      title: "Story 3: Turn Composition and Chunk Formation"
    planSummary: "Implemented the turns derivation layer (Story 3, TC-3.1–3.9). Added a completion-transaction hook to the work-queue util (complete() gains an optional onApplied callback invoked inside the completion's BEGIN IMMEDIATE, only when the version-checked form writes hit, with onCommit registrations flushed post-commit) so chunk placement and the close→summary enqueues ride the same commit as the rendering/projection writes — the story's placement-atomicity requirement — while the util stays domain-blind. New turns-internal modules: compose.ts (pure (messages, forms) → {parts, gaps}: ready forms verbatim, non-ready fall back to raw/truncated content with one DependencyGap per fallback, tool parts carry mechanically derived outcomes in message order so a run's outcome structurally cannot be lost), chunks.ts (placeTurn with the DD-9 accumulated close policy — close when accumulated + incoming ≥ target excluding the incoming turn, single projection ≥ max self-chunks immediately, empty chunks never close, already-placed turns keep their placement on rebuild — plus enqueueChunkSummaries and placement read-back), forms.ts (deleted-filtered turn/member/form/projection reads), derive.ts (turn_derivation handler: compose → composeTurnRendering → projectLowerBand → two form writes + placement hook with estimateTokens computed exactly once at landing; chunk_summary_detailed/brief handlers reading member projections in member_idx order). Registered turns.workHandlers; turn read-back now carries chunkId/memberIdx. Gaps are recorded facts: repair of a dependency changes nothing (TC-3.3 byte-equal assertion); explicit re-queues in tests drive the queue util directly per the story note."
    changedFiles:
      -
        path: "packages/lhc/src/domains/turns/internal/compose.ts"
        reason: "NEW: pure rendering composition — fallback rules, gap recording, outcome-explicit tool parts (AC-3.2–3.4)"
      -
        path: "packages/lhc/src/domains/turns/internal/chunks.ts"
        reason: "NEW: open-chunk append, accumulated close policy with golden-case exactness, summary enqueues, placement read-back (AC-3.5–3.9)"
      -
        path: "packages/lhc/src/domains/turns/internal/derive.ts"
        reason: "NEW: turn_derivation handler (compose → provider → forms → placement-in-completion) and the two chunk-summary handlers (AC-3.1, AC-3.8)"
      -
        path: "packages/lhc/src/domains/turns/internal/forms.ts"
        reason: "NEW: turn-domain derivation reads — turn source, deleted-filtered member messages, message-form rows for composition, member projections in turn order"
      -
        path: "packages/lhc/src/domains/turns/index.ts"
        reason: "Register turnWorkHandlers into the domain table; TurnRecord gains chunkId/memberIdx (AC-3.5)"
      -
        path: "packages/lhc/src/domains/turns/internal/store.ts"
        reason: "readTurns joins stored chunk placement onto the turn read-back"
      -
        path: "packages/lhc/src/shared/derivation.ts"
        reason: "CompletionTx type and HandlerOutcome.onApplied — the completion-transaction hook seam"
      -
        path: "packages/lhc/src/tech-utils/work-queue/index.ts"
        reason: "complete() accepts the onApplied hook: runs inside the completion transaction after non-stale form writes; commit hooks flush after COMMIT, drop on rollback"
      -
        path: "packages/lhc/src/scheduler.ts"
        reason: "drain passes outcome.onApplied through to complete()"
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "Export enqueue, EnqueueInput/EnqueueFormTarget, CompletionTx (TC-3.3/TC-3.8 drive the queue util directly per the story note)"
      -
        path: "packages/lhc/test/fixtures/threads.ts"
        reason: "readChunks fixture: raw chunk/chunk_member snapshot for boundary and replay assertions"
      -
        path: "packages/lhc/test/fixtures/index.ts"
        reason: "Export readChunks/ChunkSnapshot"
      -
        path: "packages/lhc/test/work-queue.test.ts"
        reason: "Story-anticipated amendment (the test's own comment: 'the turn-owned kinds arrive in Story 3'): handler-map assertion extended to all six kinds; unknown-kind probe switched from turn_derivation to bogus_kind"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "Regenerated for the work-queue.test.ts amendment and the new derivation-turns suite, per the F-03 sanctioned procedure"
      -
        path: "packages/lhc/test/derivation-turns.test.ts"
        reason: "NEW: TC-3.1 through TC-3.9 plus threshold-exactness and max-behind-open-chunk golden-case legs"
    tests:
      added:
        - "test/derivation-turns.test.ts: TC-3.1 rendering + projection ready as independent rows, content proven composed from forms via deterministicText reconstruction"
        - "test/derivation-turns.test.ts: TC-3.2 failed smoothing → rendering ready with raw text, gap {message, m1, smoothed_prompt}"
        - "test/derivation-turns.test.ts: TC-3.3 repair leaves the gapped rendering byte-identical and queues nothing; explicit turn_derivation re-queue at v2 rebuilds without the gap, placement unchanged"
        - "test/derivation-turns.test.ts: TC-3.4 three-call edit run with one isError → captured composition input carries per-call outcomes; every tool part's text equals its stored summary form content"
        - "test/derivation-turns.test.ts: TC-3.5 turn read-back shows chunkId c1 / memberIdx 0"
        - "test/derivation-turns.test.ts: TC-3.6 target=2·per+1, three ~per turns → chunk closes holding two, third opens chunk 2, c1 summaries drained"
        - "test/derivation-turns.test.ts: TC-3.6 threshold exactness — accumulated + incoming == target closes (inclusive)"
        - "test/derivation-turns.test.ts: TC-3.7 projection ≥ max → own chunk closed immediately with both summaries"
        - "test/derivation-turns.test.ts: TC-3.7 oversized turn behind an open chunk closes both chunks"
        - "test/derivation-turns.test.ts: TC-3.8 both summaries ready and double-marked distinct"
        - "test/derivation-turns.test.ts: TC-3.8 brief fails past budget alone → detailed ready, brief failed, brief re-queued alone succeeds with detailed byte-unchanged"
        - "test/derivation-turns.test.ts: TC-3.9 replay of an identical stream → deep-equal chunk/chunk_member snapshots and byte-identical summary artifacts, >1 chunk"
      modified:
        - "test/work-queue.test.ts: handler-map assembly assertion extended from three message kinds to all six; unknown-kind dispatch probe now uses bogus_kind"
      removed:
[]
      totalAfterStory: 369
      deltaFromPriorBaseline: 12
    gatesRun:
      -
        command: "pnpm vitest run test/derivation-turns.test.ts"
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
        - "TC-3.7 second leg initially configured chunkPolicy target > max, which createSdk rejects; reworked to target = max = big, which produces the same close-both golden case"
        - "exactOptionalPropertyTypes violation in turns/internal/forms.ts metadata parse — cast tightened to NonNullable"
      findingsSurfaced:
        - "Tool-run accounts are realized as outcome-carrying per-message RenderingParts in message order (the tech design's own §Interfaces shape) rather than merged account objects; the outcome rides each tool part so it structurally cannot be lost in composition (AC-3.4), and no cross-message reordering exists. Flagging in case the verifier expected an explicit account-aggregation structure."
        - "Story Technical Notes say chunk policy default max 8000, but DD-9 and the Story 0 createSdk default both say 4400; existing code follows DD-9 and was left untouched. Values are declared tuning knobs, not architecture."
        - "Chunk-summary handlers record a DependencyGap for a member whose lower_band_projection is not ready (empty-string fallback) — an additive extension of the gap rule beyond the ACs, mirroring the rendering's fallback semantics; harmless today since summaries only queue after the closing turn's projection landed."
        - "A rebuilt turn (TC-3.3 leg 2) keeps its original chunk placement and the chunk's accumulated_projected_tokens is not re-stamped from the rebuilt projection — placement arithmetic stays a fact of the original placement, consistent with 'membership shrinks, never re-cuts' (Story 6)."
        - "An onApplied hook throwing inside the completion transaction rolls the whole completion back and surfaces as a drain storage failure; the claimed item is recovered by lease expiry. Bug-class behavior consistent with the error contract."
    openQuestions:
[]
    specDeviations:
      - "Story Technical Notes reference 'Epic 01's truncation util' for tool-activity fallbacks, but no such util exists in src (only the tech-arch's prose mentions truncation-as-fallback). Implemented truncateForFallback as a pure, deterministic helper in turns/internal/compose.ts (200-char prefix + exact tail marker)."
      - "test/work-queue.test.ts amended and red-manifest regenerated: the handler-map assertion was written to be amended each story as domain tables populate (its comment names Story 3 explicitly, and Story 2 amended it the same way); the unknown-kind probe moved to bogus_kind because turn_derivation is now registered. Recorded here per the F-03 regenerate-and-note procedure."
      - "Tech design's module placement sketch puts turn handlers in turns/internal/handlers.ts; the story's Implementation Targets table places them in derive.ts (compose → provider → forms → placement orchestration plus the summary handlers). Followed the story table."
    recommendedNextStep: "Run story verification. Story 4 can then build the report/requeue surface on the gap and form state this story lands (TC-3.2's gapped-rendering state is reproducible via the failKind(prompt_smoothing, 3) + sendTurn pattern used in derivation-turns.test.ts for TC-4.4 reuse)."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/003-implementor.json"
  startedAt: "2026-06-11T04:43:44.199Z"
  finishedAt: "2026-06-11T05:01:06.818Z"
```
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/story-lead/001-current.json
Bytes: 1894

```yaml
storyRunId: "03-turn-composition-chunk-formation-story-run-001"
storyId: "03-turn-composition-chunk-formation"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-implement completed with outcome ready-for-verification and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/003-implementor.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "ba70f466-14e7-455b-b784-68aa93368849"
    storyId: "03-turn-composition-chunk-formation"
latestEventSequence: 5
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "No bounded child operation has run yet, and the story-local requirements plus test plan are sufficient to start implementation. The smallest safe next action is to dispatch implementation for TC-3.1 through TC-3.9 against the specified files and verification targets."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/003-implementor.json"
replayBoundary: null
updatedAt: "2026-06-11T05:01:06.827Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation returns, verify TC coverage, chunk close boundary evidence, gap no-auto-cascade evidence, independent summary retry evidence, and whether pnpm vitest run test/derivation-turns.test.ts plus the story gate passed.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-11T04:43:44.164Z; note="After implementation returns, verify TC coverage, chunk close boundary evidence, gap no-auto-cascade evidence, independent summary retry evidence, and whether pnpm vitest run test/derivation-turns.test.ts plus the story gate passed."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/story-lead/001-events.jsonl
Bytes: 2393

```yaml
-
  storyRunId: "03-turn-composition-chunk-formation-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T04:43:35.047Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "03-turn-composition-chunk-formation-story-run-001"
  sequence: 2
  timestamp: "2026-06-11T04:43:44.138Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb4fe-258a-7dd1-b6ee-9eb7fcf6a2fb"
-
  storyRunId: "03-turn-composition-chunk-formation-story-run-001"
  sequence: 3
  timestamp: "2026-06-11T04:43:44.163Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, verify TC coverage, chunk close boundary evidence, gap no-auto-cascade evidence, independent summary retry evidence, and whether pnpm vitest run test/derivation-turns.test.ts plus the story gate passed."
-
  storyRunId: "03-turn-composition-chunk-formation-story-run-001"
  sequence: 4
  timestamp: "2026-06-11T04:43:44.164Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, verify TC coverage, chunk close boundary evidence, gap no-auto-cascade evidence, independent summary retry evidence, and whether pnpm vitest run test/derivation-turns.test.ts plus the story gate passed."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "03-turn-composition-chunk-formation-story-run-001"
  sequence: 5
  timestamp: "2026-06-11T05:01:06.827Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/03-turn-composition-chunk-formation/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
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
