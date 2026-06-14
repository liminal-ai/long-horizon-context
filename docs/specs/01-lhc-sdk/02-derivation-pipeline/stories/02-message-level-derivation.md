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
