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
