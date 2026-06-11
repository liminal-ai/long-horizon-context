# Story Lead Base Prompt

## Role Charter
You are the story lead for `02-message-level-derivation` on durable story run `02-message-level-derivation-story-run-001`.
Select exactly one bounded next action for this `run` turn.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/stories/02-message-level-derivation.md
Bytes: 18371

# Story 2: Message-Level Derivation

### Summary
<!-- Jira: Summary field -->

The three message-level handlers: prompt smoothing, tool-call summaries, tool-result summaries — with mechanically stamped outcomes, the intake extension that queues `tool_call_summary`, and late-result re-queue.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The agent reading a thread sees smoothed prompts and tool-activity summaries it can trust — outcomes stamped from the record, never from a model's prose.

**Objective:** Messages get their derived forms. The `messages` domain registers handlers for its three kinds; each reads the message (a tool call joins its paired result by call id), calls the provider's semantic operation, and lands the form with state. Outcomes on tool-activity summaries come from `isError` and result presence — code, not inference. Intake queues `tool_call_summary` additively, and a result arriving after its call's summary landed `unknown` re-queues that summary.

**Scope — in:**
- `prompt_smoothing` handler: smoothed form for user prompts, `ready` with content
- `tool_call_summary` handler: names the tool, describes arguments, joins paired result by call id when present; outcome stamped mechanically (result + `isError: false` → succeeded; `isError: true` → failed; no result → unknown); outcome lives in form metadata, never parsed from provider text
- `tool_result_summary` handler: summarized abbreviation; full result content untouched in the record
- Intake extension: `tool_call` events queue `tool_call_summary` the same way Epic 01 queues the other kinds — deterministic, local, in the batch transaction
- Late-result re-queue: a `tool_result` landing at intake does one indexed lookup by call id; a paired summary with outcome `unknown` re-queues in the same transaction (AC-2.8)
- Input discipline: message-level derivation reads the message and its call-id pair only — no turn or chunk context
- Failure path: provider exhaustion lands the form `failed` with reason; message read-back unaffected

**Scope — out:** Turn composition consuming these forms (Story 3). Report/re-queue surfaces (Story 4) — this story's forms are read back directly. Edit/delete cascades that clear these forms (Stories 5–6).

**Dependencies:** Story 1 (drain executes the queued work). Story 0 (double, state types, `tool_call_summary` kind registered).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-2.1**: A user prompt message's smoothing work, when run, lands a smoothed form in `ready` state, readable alongside the message.
  - **TC-2.1** (AC-2.1): Intake a prompt, drain → smoothed form `ready`, content is the double's deterministic output for that input.
- **AC-2.2**: A tool-call message's summary work lands a summary naming the tool and describing its arguments, with an outcome field; a `tool_call` event in an intake batch queues a `tool_call_summary` work item the same way Epic 01 queues the other message-level kinds — an additive extension of the Epic 01 intake path that stays deterministic and local.
  - **TC-2.2** (AC-2.2): Intake a `tool_call` event → batch result reports a `tool_call_summary` work item queued, intake result returned before any handler ran; drain → summary `ready`, names the tool, describes the arguments.
- **AC-2.3**: A tool-result message's summary work lands a summarized abbreviation in `ready` state; the full result content remains untouched in the record.
  - **TC-2.3** (AC-2.3): Intake a tool call and large result, drain → result summary `ready`; full content reads back byte-identical to intake.
- **AC-2.4**: A tool-activity summary's outcome is stamped from the record: result present with `isError: false` → succeeded; `isError: true` → failed; no paired result → unknown. The provider's text never determines the outcome field.
  - **TC-2.4** (AC-2.4): Three intake variants — result ok, result `isError`, call with no result → outcomes succeeded, failed, unknown; double's text identical across all three, proving text doesn't drive outcome.
- **AC-2.5**: Message-level derivation reads only the message and its call-id-paired counterpart; no turn or chunk context is an input.
  - **TC-2.5** (AC-2.5): Double records its inputs → tool-call summary input contains the call and paired result only; no turn data.
- **AC-2.6**: A provider failure on a message-level item follows Flow 1 retry policy; exhaustion lands the form `failed` with the provider's reason, and the message itself remains fully readable.
  - **TC-2.6** (AC-2.6): Double exhausts retries on smoothing → form `failed` with reason; message read-back unaffected.
- **AC-2.7**: Message kinds with no derivable form (assistant text, thinking, runtime notes) queue no message-level work and carry no derivation state rows.
  - **TC-2.7** (AC-2.7): Intake assistant text and a runtime note, drain → no work items for them, no derivation state rows on read-back.
- **AC-2.8**: A tool result arriving after its call's summary already landed with outcome `unknown` re-queues that summary at intake: the pair is the summary's source, and a source completing follows clear-and-regenerate like any source change. The check is deterministic and local (one indexed lookup by call id); the common case — call and result in one batch — never triggers it, because the summary runs after both landed.
  - **TC-2.8** (AC-2.8): Intake a `tool_call` alone, drain (summary lands `unknown`), then intake its `tool_result` in a later batch → summary work re-queued at intake; drain → outcome now `succeeded`, one summary form, no duplicates. Control: call and result in one batch → no re-queue ever fires.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

First real handlers through Story 1's drain — and the proof that the handler-map seam carries domain behavior. All three live in `messages/internal/handlers.ts`, follow one shape (read source → call one provider op → land form via `forms.ts` UPDATE-only write with source-version check — the pending row exists from enqueue), and stay message-local: the tool-call handler's only reach is the paired result by `tool_call_id`, through `outcome.ts`, which derives `succeeded | failed | unknown` from `isError`/presence — mechanically, never from provider text (AC-2.4 is this epic's receipts principle in code).

The story touches intake twice, both deterministic and local (NFR: no inference on the hot path): `MESSAGE_WORK_KINDS` gains `tool_call: "tool_call_summary"`, and projecting a `tool_result` does one indexed lookup — paired call's summary with `metadata.outcome = "unknown"` → requeue in the batch transaction (AC-2.8). The requeue rides Story 1's enqueue (dedupe makes it idempotent); the common single-batch case never fires it because the summary hasn't run yet when the result lands.

#### Build Strategy

Strategy: tdd-lite

Reason:
- Handler logic is straightforward, but two behaviors invite shortcuts: outcome could silently come from text patterns (passes TC-2.1–2.3, violates the design's core rule), and the late-result requeue could be approximated with a re-derive-on-read hack. Red tests for TC-2.4 and TC-2.8 pin both before implementation.

Risk Reminders:
- TC-2.4's three variants use *identical double text* — that's what proves text-independence; don't weaken the fixture.
- TC-2.8's control leg (call+result same batch → no re-queue) is half the AC; the capture log proves the summary ran once.
- Intake-return-before-handler (TC-2.2) asserts the double's capture log is empty at intake return — the no-inference-on-hot-path NFR made testable.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Handlers | `src/domains/messages/internal/handlers.ts` (NEW: three handlers, registered in `messages.workHandlers`) |
| Outcome | `src/domains/messages/internal/outcome.ts` (NEW: mechanical derivation, pure function) |
| Form storage | `src/domains/messages/internal/forms.ts` (NEW: UPDATE-only writes with source-version check; read joins) |
| Intake touch 1 | `src/domains/intake-stream/internal/pipeline.ts` (`MESSAGE_WORK_KINDS` + tool_call) |
| Intake touch 2 | same file, tool_result projection step (unknown-outcome lookup → requeue) |
| Surface | `src/domains/messages/index.ts` (workHandlers export; form read-back on message reads) |
| Tests | `test/derivation-messages.test.ts` (NEW) |

#### Design References

- [tech-design.md §Flow 2 (handler mechanics, both intake touches)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:225), lines 225–226
- [tech-design.md DD-2 (derived_form table), DD-3 (source-version stale-result check)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:75), lines 75–77
- [tech-design.md §Storage (derived_form table, metadata column)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:155), lines 155–167
- [tech-design.md §Interfaces (DerivedForm, ToolOutcome, provider ops 1–3)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:240), lines 240–282
- [tech-design.md §Issue 2 (late-result decision trail)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:98), line 98
- [test-plan.md §derivation-messages suite](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:40), lines 40–51

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.1 | `test/derivation-messages.test.ts` | smoothed form ready; content = double's output for the prompt |
| TC-2.2 | `test/derivation-messages.test.ts` | batch reports the queued item; capture log empty at intake return; summary names tool + args |
| TC-2.3 | `test/derivation-messages.test.ts` | 300KB result summarized; full content byte-identical via Epic 01 read-back |
| TC-2.4 | `test/derivation-messages.test.ts` | three variants, identical text → outcomes from `metadata` only |
| TC-2.5 | `test/derivation-messages.test.ts` | captured input = call + paired result, nothing else |
| TC-2.6 | `test/derivation-messages.test.ts` | exhaustion → form `failed` + reason; message read-back unaffected |
| TC-2.7 | `test/derivation-messages.test.ts` | assistant text + runtime note: no items, no state rows |
| TC-2.8 | `test/derivation-messages.test.ts` | split-batch repair: re-queued at result intake, outcome → succeeded, source version advanced, no duplicates; control leg ran-once |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Outcome never from text | TC-2.4 (identical-text fixture) | outcome differs while text is constant | A text-parsing implementation passes every other TC in the flow |
| Hot path stays inference-free | TC-2.2 (capture-log-empty-at-return) | intake returns before any provider call | Artifact-presence assertions can't see *when* the handler ran |
| Repair is intake-time, not read-time | TC-2.8 (source version advanced + queue row visible in batch result) | the fix is a real re-derivation through the queue | A read-time outcome join would show `succeeded` without ever repairing the artifact |

#### Technical Notes

**Tool-activity summary payload** (epic Data Contracts): summary content (provider-authored text) plus metadata `{ outcome: "succeeded" | "failed" | "unknown" }` — outcome machine-readable apart from the text, stamped by the handler from the record. Storage: `derived_form.metadata` JSON (tech design §Storage).

**Outcome truth table**: paired result present, `isError: false` → `succeeded`; paired result present, `isError: true` → `failed`; no paired result at derivation time → `unknown` (repairable via AC-2.8 when the result lands).

**Intake touches** (both additive to Epic 01's path, both in the batch transaction, both deterministic):
1. `tool_call` event → queue `tool_call_summary` (sourceRef: messageId)
2. `tool_result` event → indexed lookup by call id; paired summary with outcome `unknown` → re-queue (idempotent against the queue per AC-4.5 semantics)

**Provider operations used**: `smoothPrompt`, `summarizeToolCall`, `summarizeToolResult` — each handler calls exactly one.

**Form write discipline**: every land goes through `forms.ts` as an UPDATE-only write with the source-version check — the stale-result rule is Story 5's headline but the check is in force from the first form written; a stale write here discards exactly as it will there. Never upsert a final form: a write that finds no matching pending row discards.

**Cross-story debt** (coverage.md): TC-2.8's no-duplicates assertion is the early canary for the queue's dedupe — if it finds duplicates, the fix is Story 1's util, not this handler.

#### Anti-Shim Requirements

- `outcome.ts` is a pure function of `(pairedResult | undefined, isError | undefined)` — no provider text parameter in its signature (make the violation unrepresentable).
- The late-result lookup is one indexed query in the projection step — not a scan, not a drain-time sweep, not a read-time join.
- No re-derivation on read: message reads return stored forms; TC-2.8's source-version assertion proves the repair was a real queue round-trip.
- Exhaustion lands `failed` with the provider's reason — never an empty-content `ready`.

#### Production Path Proof

- Entrypoint: the same intake CLI/SDK calls Epic 01 ships (`lhc intake message-events`); no new commands.
- Registration/default path: handlers enter the map via `messages.workHandlers` at `createSdk`; intake's kind map queues them with no caller opt-in.
- Evidence: TC-2.2 drives the full production chain (CLI-shaped intake → queue → scheduler → drain → handler → form) with the double at the production provider seam.

#### Verification

- Targeted: `pnpm vitest run test/derivation-messages.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

| Date | Deviation | Disposition |
|---|---|---|
| 2026-06-10 | Sanctioned Epic 01 test amendments (F-03 patch, test plan §Sanctioned Amendments): `tool_call` now queues `tool_call_summary`, so `test/work-queue.test.ts` exact-count assertions go 3→4 work rows (`messageWork` 2→3); red manifest regenerated as an explicit story step. No other Epic 01 edits sanctioned | Planned amendment; record actual edits here during implementation |
| 2026-06-11 | Actual sanctioned-amendment edits (the planned tool_call sweep): `test/work-queue.test.ts` restart-survival rows 3→4 (`messageWork` 2→3, list gains `w-m2-tool_call_summary-v1`) + TC-2.9 kind-gate comment; `test/work-execution.test.ts` TC-1.1 (4 items, 5 forms) and maxItems leg (remaining 2→3); `test/cli-process-work.test.ts` TC-1.3 (4 seeded items, 3-row after-kill detail, 5 final forms) — the latter two are Epic 02 Story 0/1 files caught by the same sweep rule. Red manifest regenerated for all three plus the new suite | Implemented; behavior-preserving count/id updates only |
| 2026-06-11 | `test/work-queue.test.ts` handler-map assembly test (Story 0) amended: `expect(sdk.workHandlers).toEqual({})` cannot survive Story 2 registering the real messages table — now asserts exactly the three message kinds and probes the miss with `turn_derivation` (unregistered until Story 3) | Necessary consequence of the story's registration step, not in the pre-listed sweep; flagged for verifier attention |
| 2026-06-11 | Intake touch sites live in `src/domains/messages/index.ts`, not `intake-stream/internal/pipeline.ts` as the design table says: Epic 01 placed `MESSAGE_WORK_KINDS` and the per-message queue step in the messages domain (pipeline already calls `queueMessageWork` per recorded event). Both touches (kind-map addition; late-result lookup keyed by the projected `toolCallId`) ride the same batch transaction the design requires; `pipeline.ts` needed no edit | Same semantics, owning-domain placement |
| 2026-06-11 | Call-id pairing index `idx_message_block_tool_call_id` added to `MIGRATION_V5_STATEMENTS` in place (anti-shim: the AC-2.8 lookup and the handlers' paired reads must be one indexed query, never a scan). v5 is amended rather than a v6 appended because the tech design pins "one migration for the epic" and `thread-migration.test.ts` asserts version 5; a file already migrated to v5 before this story keeps working (queries fall back to a scan, correctness unaffected) — a non-issue pre-release | Schema addition inside the epic's single migration |
| 2026-06-11 | `tool_result_summary` forms also carry `metadata.outcome` (stamped from the result's own `isError` via `outcome.ts`) — the epic's tool-activity outcome contract and the Story 0 multi-state fixture already claim this shape; the story text names only the call summary | Additive, consistent with AC-2.4's mechanism |
| 2026-06-11 | "Form read-back on message reads" (Implementation Targets, Surface row) initially deferred to Story 4; verifier finding 02F-001 ruled it in-scope. Implemented: `listMessages` attaches each message's stored `derived_form` rows as `MessageRecord.forms` (one grouped query, stored state verbatim — no read-time derivation; messages with no rows carry no key, preserving AC-2.7). TC-2.1 amended to prove readability through this production path; red manifest regenerated for the suite | Resolved per 02F-001 |

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-2.1 through TC-2.8 green
- [ ] Architecture-risk tests green: mechanical outcome stamping (TC-2.4 — outcome never from text), late-result re-queue with control case (TC-2.8)
- [ ] Intake latency NFR holds: batch result returns before any handler runs (asserted in TC-2.2)
- [ ] Full tool-result content byte-identical after summarization (TC-2.3)
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
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-verify completed with outcome pass and status ok.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/006-verify.json
- older_response_count: 3
- caller_input_artifact_count: 0
- prior_self_note_count: 2
- latest_self_note: "After continuation returns, verify 02F-001 specifically: production messages.listMessages/read path exposes stored derived forms alongside messages and TC-2.1 proves it through that surface."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/006-verify.json
bytes: 3707
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "39bd4c5e-dc32-496f-804b-658548653487"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eb4f3-ecff-7fa1-8d86-8c923cb0cafd"
    continuation:
      provider: "codex"
      sessionId: "019eb4f3-ecff-7fa1-8d86-8c923cb0cafd"
      storyId: "02-message-level-derivation"
    mode: "followup"
    story:
      id: "02-message-level-derivation"
      title: "Story 2: Message-Level Derivation"
    artifactsRead:
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/stories/02-message-level-derivation.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/005-continue.json"
      - "packages/lhc/src/domains/messages/index.ts"
      - "packages/lhc/src/domains/messages/internal/forms.ts"
      - "packages/lhc/test/derivation-messages.test.ts"
    reviewScopeSummary: "Follow-up verification focused on prior finding 02F-001 and the directly touched message read-back surface. The production listMessages path now exposes stored derived forms alongside messages, TC-2.1 proves that path, and focused/story/epic gates passed."
    priorFindingStatuses:
      -
        id: "02F-001"
        status: "resolved"
        rationale: "Resolved by production code and test evidence. MessageRecord now carries optional `forms` (`packages/lhc/src/domains/messages/index.ts:30`), listMessages attaches forms from `readMessageForms` before returning records (`packages/lhc/src/domains/messages/index.ts:198`), and readMessageForms maps stored message-owned derived_form rows verbatim (`packages/lhc/src/domains/messages/internal/forms.ts:66`). TC-2.1 now asserts the ready smoothed form through `sdk.messages.listMessages` on `message.forms` (`packages/lhc/test/derivation-messages.test.ts:104`) and keeps a raw-row agreement check (`packages/lhc/test/derivation-messages.test.ts:125`)."
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "AC-2.1/TC-2.1: smoothed_prompt ready/content is verified through the production message read surface via MessageRecord.forms"
        - "AC-2.2/TC-2.2: tool_call queues tool_call_summary, intake returns before provider calls, drained summary names tool and args"
        - "AC-2.3/TC-2.3: tool_result_summary ready and full result content remains byte-identical"
        - "AC-2.4/TC-2.4: tool outcomes are metadata stamped from record state, independent of provider text"
        - "AC-2.5/TC-2.5: tool-call summary input contains only call plus paired result"
        - "AC-2.6/TC-2.6: provider exhaustion lands failed form with reason and message read-back remains intact"
        - "AC-2.7/TC-2.7: non-derivable message kinds queue no work and carry no derived state rows"
        - "AC-2.8/TC-2.8: late result re-queues unknown call summary; same-batch control does not re-queue"
      unverified:
[]
    gatesRun:
      -
        command: "pnpm vitest run test/derivation-messages.test.ts"
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
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "No new material fake adapter, shim, placeholder, or read-time derivation path was found in the touched production read-back code; readMessageForms returns stored rows."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/006-verify.json"
  startedAt: "2026-06-11T04:40:25.994Z"
  finishedAt: "2026-06-11T04:41:47.014Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/003-implementor.json
bytes: 8876
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "790e04ff-c46c-49b6-81fa-435fe6fb7f80"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "c424e248-7c12-49e6-8ca7-162e1fb88490"
    continuation:
      provider: "claude-code"
      sessionId: "c424e248-7c12-49e6-8ca7-162e1fb88490"
      storyId: "02-message-level-derivation"
    outcome: "ready-for-verification"
    story:
      id: "02-message-level-derivation"
      title: "Story 2: Message-Level Derivation"
    planSummary: "Implemented Flow 2: three production message handlers (prompt smoothing, tool-call summary, tool-result summary) in messages/internal/handlers.ts, registered via messages.workHandlers into the SDK dispatch map; mechanical outcome stamping in outcome.ts as a pure function of paired-result presence/isError with no text parameter; pairing and repair reads in messages/internal/forms.ts backed by a new expression index on message_block call ids (added inside the epic's single v5 migration); intake touch 1 (tool_call → tool_call_summary in MESSAGE_WORK_KINDS) and touch 2 (tool_result projection runs one indexed unknown-outcome lookup and re-queues the paired summary at source version+1 in the batch transaction). Completion writes ride Story 1's version-checked UPDATE-only complete(). New suite test/derivation-messages.test.ts covers TC-2.1–2.8 including the identical-text outcome proof and the late-result control leg; sanctioned tool_call-sweep amendments applied to three existing suites and the red manifest regenerated as the explicit story step."
    changedFiles:
      -
        path: "packages/lhc/src/domains/messages/internal/handlers.ts"
        reason: "NEW: the three message-level handlers — read source, one provider op each, forms handed back through HandlerOutcome for the version-checked completion write"
      -
        path: "packages/lhc/src/domains/messages/internal/outcome.ts"
        reason: "NEW: mechanical ToolOutcome derivation; pure function of (pairedResult|undefined).isError, no provider-text parameter (anti-shim)"
      -
        path: "packages/lhc/src/domains/messages/internal/forms.ts"
        reason: "NEW: message-source read, call-id paired-block reads, and the AC-2.8 unknown-outcome summary lookup (one indexed query)"
      -
        path: "packages/lhc/src/domains/messages/index.ts"
        reason: "Both intake touches: MESSAGE_WORK_KINDS gains tool_call; MessageCreated carries toolCallId; queueMessageWork runs the late-result re-queue in the batch transaction; workHandlers exports the real table"
      -
        path: "packages/lhc/src/shared/storage.ts"
        reason: "idx_message_block_tool_call_id expression index added to MIGRATION_V5_STATEMENTS so pairing and repair lookups are indexed, never scans"
      -
        path: "packages/lhc/test/derivation-messages.test.ts"
        reason: "NEW: TC-2.1 through TC-2.8 (9 tests) including the identical-text architecture-risk fixture, capture-log-empty-at-intake-return, and the split-batch repair plus its control leg"
      -
        path: "packages/lhc/test/work-queue.test.ts"
        reason: "Sanctioned amendment: restart-survival 3→4 rows / messageWork 2→3; TC-2.9 comment; handler-map assembly test updated from empty-map to the three registered message kinds (miss probed with turn_derivation)"
      -
        path: "packages/lhc/test/work-execution.test.ts"
        reason: "Sanctioned-sweep amendment: TC-1.1 batch with tool_call now 4 items / 5 forms; maxItems leg remaining 2→3"
      -
        path: "packages/lhc/test/cli-process-work.test.ts"
        reason: "Sanctioned-sweep amendment: TC-1.3 seeded count 4, after-kill detail gains the claimed tool_call_summary row, final forms 5; stale parity comment updated"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "Regenerated for the three amended suites plus the new suite — the explicit story step the sanction requires"
      -
        path: "packages/lhc/docs/02-specs/02-derivation-pipeline/stories/02-message-level-derivation.md"
        reason: "Spec Deviations table updated with every actual amendment and placement/schema deviation"
    tests:
      added:
        - "test/derivation-messages.test.ts: TC-2.1 smoothed form ready with the double's deterministic output"
        - "test/derivation-messages.test.ts: TC-2.2 batch reports the queued tool_call_summary item; capture log empty at intake return; summary names tool and args"
        - "test/derivation-messages.test.ts: TC-2.3 300KB result summarized bounded; full content byte-identical via Epic 01 read-back"
        - "test/derivation-messages.test.ts: TC-2.4 three variants with identical provider text land succeeded/failed/unknown from metadata alone"
        - "test/derivation-messages.test.ts: TC-2.5 captured summarizeToolCall input is exactly call + paired result"
        - "test/derivation-messages.test.ts: TC-2.6 exhaustion lands form failed with provider reason; message read-back unaffected"
        - "test/derivation-messages.test.ts: TC-2.7 assistant text + runtime note queue nothing, no state rows"
        - "test/derivation-messages.test.ts: TC-2.8 split-batch repair — re-queued at result intake, pending at v2 pre-drain, outcome succeeded, source version advanced, one form, queue empty"
        - "test/derivation-messages.test.ts: TC-2.8 control — call+result in one batch, summary ran exactly once (capture log), no re-queue, version stays 1"
      modified:
        - "test/work-queue.test.ts (restart-survival counts/ids; handler-map assembly assertions; TC-2.9 comment)"
        - "test/work-execution.test.ts (TC-1.1 and maxItems counts/ids for the tool_call batch)"
        - "test/cli-process-work.test.ts (TC-1.3 counts/ids; parity comment)"
      removed:
[]
      totalAfterStory: 182
      deltaFromPriorBaseline: 9
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
        - "Removed an unused ProviderDouble type import from the new suite before lint"
        - "queueMessageWork restructured so the tool_result path both queues its own summary and runs the repair lookup without double-enqueueing or changing the no-work kinds' early return"
      findingsSurfaced:
        - "TC-2.4's identical-text requirement cannot be met by the input-digesting double (pairedResult changes the digest), so the test injects a constant-output provider at the same production seam for summarizeToolCall only — strictly stronger than the double for this proof; the double still drives every other suite"
        - "Story 0's handler-map test asserting an empty sdk.workHandlers had to change once real handlers registered — outside the pre-listed tool_call sweep, recorded in the deviation table for verifier attention"
        - "Story 3 will need the same assembly-test amendment again when turns.workHandlers populates"
        - "The v5 migration was amended in place to add the call-id index (design pins one migration per epic; thread-migration tests assert version 5); any thread file already migrated to v5 before this commit would lack the index but remain correct — acceptable pre-release, recorded in deviations"
        - "registerTestWorkHandlers now overwrites the real message handlers in Story 1 suites by design (Object.assign); behavior there is unchanged but the fixture silently shadows production handlers — worth a comment or guard in a later story"
    openQuestions:
[]
    specDeviations:
      - "Intake touches implemented in src/domains/messages/index.ts rather than intake-stream/internal/pipeline.ts — Epic 01 placed the kind map and per-message queue step in the messages domain; semantics (deterministic, local, in the batch transaction) unchanged and pipeline.ts needed no edit"
      - "Call-id expression index added to MIGRATION_V5_STATEMENTS in place instead of a new v6 (tech design: one migration for the epic; thread-migration tests pin version 5)"
      - "tool_result_summary forms also carry metadata.outcome stamped from the result's own isError — matches the Story 0 multi-state fixture contract (FC-0.3) though the story text names only the call summary"
      - "Form read-back on message reads (Implementation Targets, Surface row) deferred: no Story 2 TC consumes it and the per-owner report join is Story 4's deliverable; this story's forms are read back directly per the test plan"
      - "Sanctioned-amendment sweep extended to Epic 02 Story 0/1 files (work-execution.test.ts, cli-process-work.test.ts, the handler-map assembly test) — same mechanical class as the listed work-queue.test.ts edits; each recorded in the story deviation table and the red manifest regenerated"
    recommendedNextStep: "Run story verification, then proceed to Story 3 (turn composition and chunks) — its turns.workHandlers registration will need the same one-line assembly-test amendment recorded here"
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/003-implementor.json"
  startedAt: "2026-06-11T04:14:24.546Z"
  finishedAt: "2026-06-11T04:32:17.176Z"
```
</history_entry>

<history_entry>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/004-verify.json
bytes: 6681
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "c9959945-2328-4b3b-90d1-48bacd7a2c68"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eb4f3-ecff-7fa1-8d86-8c923cb0cafd"
    continuation:
      provider: "codex"
      sessionId: "019eb4f3-ecff-7fa1-8d86-8c923cb0cafd"
      storyId: "02-message-level-derivation"
    mode: "initial"
    story:
      id: "02-message-level-derivation"
      title: "Story 2: Message-Level Derivation"
    artifactsRead:
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/stories/02-message-level-derivation.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/003-implementor.json"
      - "packages/lhc/src/domains/messages/index.ts"
      - "packages/lhc/src/domains/messages/internal/handlers.ts"
      - "packages/lhc/src/domains/messages/internal/forms.ts"
      - "packages/lhc/src/domains/messages/internal/outcome.ts"
      - "packages/lhc/src/domains/messages/internal/store.ts"
      - "packages/lhc/src/shared/storage.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/src/scheduler.ts"
      - "packages/lhc/test/derivation-messages.test.ts"
      - "packages/lhc/test/fixtures/provider-double.ts"
      - "packages/lhc/test/fixtures/threads.ts"
    reviewScopeSummary: "Initial verification of Story 2 against AC-2.1 through AC-2.8, Flow 2 tech design, production message handlers/intake touches/form storage, focused tests, and configured gates. One blocking gap remains on the production message read-back surface."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "02F-001"
        severity: "major"
        title: "Production message reads do not expose derived forms alongside messages"
        evidence: "Story AC-2.1 requires the smoothed form to be readable alongside the message, and the story implementation target names `src/domains/messages/index.ts` for `form read-back on message reads` (story lines 31 and 78). The production `MessageRecord` shape contains only canonical message fields and blocks (`packages/lhc/src/domains/messages/index.ts:29`), while `listMessages` returns `readMessages(db)` directly (`packages/lhc/src/domains/messages/index.ts:176`) and `readMessages` selects only `message` and `message_block` rows with no `derived_form` join (`packages/lhc/src/domains/messages/internal/store.ts:61`). TC-2.1 currently proves the form by reading raw derived_form rows through the test fixture (`packages/lhc/test/derivation-messages.test.ts:82`) and calls `listMessages` only to check the original text remains (`packages/lhc/test/derivation-messages.test.ts:110`), so there is no production-path proof that forms are readable alongside messages."
        affectedFiles:
          - "packages/lhc/src/domains/messages/index.ts"
          - "packages/lhc/src/domains/messages/internal/store.ts"
          - "packages/lhc/test/derivation-messages.test.ts"
        requirementIds:
          - "AC-2.1"
          - "TC-2.1"
          - "Implementation Targets: Surface"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    openFindings:
      -
        id: "02F-001"
        severity: "major"
        title: "Production message reads do not expose derived forms alongside messages"
        evidence: "Story AC-2.1 requires the smoothed form to be readable alongside the message, and the story implementation target names `src/domains/messages/index.ts` for `form read-back on message reads` (story lines 31 and 78). The production `MessageRecord` shape contains only canonical message fields and blocks (`packages/lhc/src/domains/messages/index.ts:29`), while `listMessages` returns `readMessages(db)` directly (`packages/lhc/src/domains/messages/index.ts:176`) and `readMessages` selects only `message` and `message_block` rows with no `derived_form` join (`packages/lhc/src/domains/messages/internal/store.ts:61`). TC-2.1 currently proves the form by reading raw derived_form rows through the test fixture (`packages/lhc/test/derivation-messages.test.ts:82`) and calls `listMessages` only to check the original text remains (`packages/lhc/test/derivation-messages.test.ts:110`), so there is no production-path proof that forms are readable alongside messages."
        affectedFiles:
          - "packages/lhc/src/domains/messages/index.ts"
          - "packages/lhc/src/domains/messages/internal/store.ts"
          - "packages/lhc/test/derivation-messages.test.ts"
        requirementIds:
          - "AC-2.1"
          - "TC-2.1"
          - "Implementation Targets: Surface"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    requirementCoverage:
      verified:
        - "TC-2.1 ready/content portion: focused test passes for smoothed_prompt ready with deterministic provider output"
        - "AC-2.2/TC-2.2: tool_call queues tool_call_summary at intake, provider capture log is empty at intake return, drained summary names tool and args"
        - "AC-2.3/TC-2.3: tool_result_summary lands ready and full result content reads back byte-identical"
        - "AC-2.4/TC-2.4: identical provider text still yields succeeded/failed/unknown metadata outcomes from record state"
        - "AC-2.5/TC-2.5: captured summarizeToolCall input is exactly tool call plus paired result, with no turn/chunk fields"
        - "AC-2.6/TC-2.6: smoothing retry exhaustion lands failed form with provider reason and message read-back remains intact"
        - "AC-2.7/TC-2.7: assistant text and runtime note queue no message work and create no derived_form rows"
        - "AC-2.8/TC-2.8: split-batch late result re-queues the unknown call summary and repairs outcome; same-batch control runs summary once"
      unverified:
        - "AC-2.1: derived form readable alongside the message through the production message read surface"
        - "Implementation Targets: Surface form read-back on message reads"
    gatesRun:
      -
        command: "pnpm vitest run test/derivation-messages.test.ts"
        result: "pass"
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
    productionPathFindings:
      - "02F-001: production `messages.listMessages` does not expose stored derived forms; TC-2.1 uses raw test fixture reads for the form state/content proof."
    recommendedNextStep: "revise"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "Production path audit found the constant-output provider confined to TC-2.4 test code, not runtime code."
      - "Configured gates passed despite the production-surface coverage gap: focused suite 9/9, green-verify 163/163, verify-all 182/182."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/004-verify.json"
  startedAt: "2026-06-11T04:32:25.188Z"
  finishedAt: "2026-06-11T04:36:27.577Z"
```
</history_entry>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/005-continue.json
bytes: 4386
payload:
  command: "story-continue"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "3efcee2a-d9b6-47b8-b41f-90f961b63e41"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "c424e248-7c12-49e6-8ca7-162e1fb88490"
    continuation:
      provider: "claude-code"
      sessionId: "c424e248-7c12-49e6-8ca7-162e1fb88490"
      storyId: "02-message-level-derivation"
    outcome: "ready-for-verification"
    story:
      id: "02-message-level-derivation"
      title: "Story 2: Message-Level Derivation"
    planSummary: "Fix for verifier finding 02F-001 only: production form read-back on message reads. Added readMessageForms to messages/internal/forms.ts (one grouped query over message-owned derived_form rows, returned exactly as stored — no read-time derivation); listMessages now attaches each message's stored forms as MessageRecord.forms, with the key absent for messages that have no rows so AC-2.7's no-state-rows contract stays visible on the read surface. The CLI's list-messages inherits the field through the same surface. TC-2.1 amended so the AC-2.1 proof reads the ready smoothed form through sdk.messages.listMessages (the production path) with the raw fixture read retained only as a stored-state cross-check; red manifest regenerated for the suite. No other surfaces, handlers, or intake paths touched."
    changedFiles:
      -
        path: "packages/lhc/src/domains/messages/internal/forms.ts"
        reason: "NEW readMessageForms: message-owned derived_form rows grouped by message id for the listMessages join, stored state verbatim"
      -
        path: "packages/lhc/src/domains/messages/index.ts"
        reason: "MessageRecord gains optional forms: DerivedForm[]; listMessages attaches stored forms per message — the AC-2.1 'readable alongside the message' production path"
      -
        path: "packages/lhc/test/derivation-messages.test.ts"
        reason: "TC-2.1 now proves the smoothed form through sdk.messages.listMessages (message.forms carries state/content/sourceVersion), raw derived_form read kept as agreement check"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "Regenerated for the amended suite (explicit gate step)"
      -
        path: "packages/lhc/docs/02-specs/02-derivation-pipeline/stories/02-message-level-derivation.md"
        reason: "Deviation row for the deferred Surface target replaced with the 02F-001 resolution"
    tests:
      added:
[]
      modified:
        - "test/derivation-messages.test.ts: TC-2.1 — smoothed form asserted through the production message read path (listMessages → MessageRecord.forms), not only the raw fixture reader"
      removed:
[]
      totalAfterStory: 182
      deltaFromPriorBaseline: 9
    gatesRun:
      -
        command: "pnpm vitest run test/derivation-messages.test.ts"
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
        - "02F-001: stored derived forms are now readable alongside messages through messages.listMessages, and TC-2.1's proof uses that production path"
      findingsSurfaced:
        - "forms is attached only when rows exist (no empty-array key), so kinds with no derivable form read back without a forms field — deliberate, mirroring AC-2.7; flag if the verifier expects an always-present array"
        - "Swept all listMessages consumers before changing the shape: no whole-record toEqual assertions exist (field-mapped and symmetric twin comparisons only), confirmed by the full 182-test pass with no further amendments needed"
        - "Pending rows surface too (a prompt read before drain shows its smoothed_prompt pending) — consistent with 'stored state returned as stored' and with Story 4's report semantics"
    openQuestions:
[]
    specDeviations:
      - "The previously recorded deferral of the Surface implementation target is withdrawn: form read-back on message reads is implemented per 02F-001, and the story's deviation table row was updated to record the resolution"
    recommendedNextStep: "Re-run story verification for 02F-001 closure; Story 3 can then consume message forms during turn composition through the same internal readers"
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/005-continue.json"
  startedAt: "2026-06-11T04:36:37.950Z"
  finishedAt: "2026-06-11T04:40:16.383Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/story-lead/001-current.json
Bytes: 2651

```yaml
storyRunId: "02-message-level-derivation-story-run-001"
storyId: "02-message-level-derivation"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome pass and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/004-verify.json"
    provenance: "current-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/005-continue.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/006-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "c424e248-7c12-49e6-8ca7-162e1fb88490"
    storyId: "02-message-level-derivation"
  storyVerifier:
    provider: "codex"
    sessionId: "019eb4f3-ecff-7fa1-8d86-8c923cb0cafd"
    storyId: "02-message-level-derivation"
latestEventSequence: 15
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Implementor returned ready-for-verification after addressing the sole blocking finding 02F-001. A verifier pass is required before story-lead can recommend acceptance."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/006-verify.json"
replayBoundary: null
updatedAt: "2026-06-11T04:41:47.023Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After continuation returns, verify 02F-001 specifically: production messages.listMessages/read path exposes stored derived forms alongside messages and TC-2.1 proves it through that surface.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-11T04:14:24.510Z; note="After implementation returns, verify evidence covers TC-2.4 identical-text outcome stamping and TC-2.8 split-batch plus same-batch control before choosing review or verify."
- sequence=11; actionSequence=10; createdAt=2026-06-11T04:36:37.914Z; note="After continuation returns, verify 02F-001 specifically: production messages.listMessages/read path exposes stored derived forms alongside messages and TC-2.1 proves it through that surface."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/story-lead/001-events.jsonl
Bytes: 6787

```yaml
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T04:14:11.272Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 2
  timestamp: "2026-06-11T04:14:24.484Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb4e3-3bcb-7183-8b76-bb7a1ecd8bdf"
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 3
  timestamp: "2026-06-11T04:14:24.509Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, verify evidence covers TC-2.4 identical-text outcome stamping and TC-2.8 split-batch plus same-batch control before choosing review or verify."
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 4
  timestamp: "2026-06-11T04:14:24.510Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, verify evidence covers TC-2.4 identical-text outcome stamping and TC-2.8 split-batch plus same-batch control before choosing review or verify."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 5
  timestamp: "2026-06-11T04:32:17.185Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 6
  timestamp: "2026-06-11T04:32:25.130Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019eb4f3-cda4-7962-8edb-623c3a685e1f"
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 7
  timestamp: "2026-06-11T04:32:25.151Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 8
  timestamp: "2026-06-11T04:36:27.586Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
    status: "ok"
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 9
  timestamp: "2026-06-11T04:36:37.886Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019eb4f7-9fd1-7d80-8963-2f6367644865"
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 10
  timestamp: "2026-06-11T04:36:37.913Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-continue."
  data:
    actionType: "run-continue"
    turn: 3
    selfNote: "After continuation returns, verify 02F-001 specifically: production messages.listMessages/read path exposes stored derived forms alongside messages and TC-2.1 proves it through that surface."
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 11
  timestamp: "2026-06-11T04:36:37.914Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After continuation returns, verify 02F-001 specifically: production messages.listMessages/read path exposes stored derived forms alongside messages and TC-2.1 proves it through that surface."
    actionSequence: 10
    actionType: "run-continue"
    turn: 3
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 12
  timestamp: "2026-06-11T04:40:16.392Z"
  type: "child-operation-completed"
  summary: "story-continue completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/005-continue.json"
  data:
    actionType: "run-continue"
    command: "story-continue"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 13
  timestamp: "2026-06-11T04:40:25.927Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/story-lead/prompts/001-planner-turn-004.md"
    sessionId: "019eb4fb-1da4-7fd2-906f-d6e5e0aab543"
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 14
  timestamp: "2026-06-11T04:40:25.952Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 4
-
  storyRunId: "02-message-level-derivation-story-run-001"
  sequence: 15
  timestamp: "2026-06-11T04:41:47.023Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/artifacts/02-message-level-derivation/006-verify.json"
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
