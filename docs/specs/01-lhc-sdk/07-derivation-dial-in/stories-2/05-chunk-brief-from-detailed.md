# Story 5: Chunk Brief from Detailed Material

### Summary
<!-- Jira: Summary field -->

Change `chunk_summary_brief` to consume `chunk_summary_detailed` text instead of raw member projections, replace the prompt with the tested brief-compression prompt, and add target token guidance with `sizeDisposition`.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `initLhc`.

**Objective:** Produce compact past-tense historical memory notes from already-compressed detailed chunk material instead of raw smooth-turn text. The detailed material has already removed thinking/tool/result noise through per-turn compression, so the brief model receives fewer tokens and cleaner context. The result should be a historical memory note — not a transcript, not compressed dialogue, not live-status instructions.

**Scope In:** Brief input source change (detailed text, not member projections), `summarizeChunkBrief` signature change, prompt replacement with tested brief-compression prompt (including examples), target token guidance, `sizeDisposition` metadata, dependency handling (brief waits on detailed).

**Scope Out:** No changes to `chunk_summary_detailed` (Story 4). No changes to chunk close/placement. No changes to the work queue, retry, or completion-transaction mechanics. No thread-view band policy changes.

**Dependencies:** Story 4 (detailed is ready and produces the new marker-separated format). Story 3 (compression targets pattern on `ResolvedSdkConfig`).

**Architecture Constraints:** `turns` owns chunk summaries. The brief handler reads the stored `chunk_summary_detailed` derivation row for the same chunk, not member `smooth_turn_compression` rows. Thread-view consumes the stored brief artifact but does not derive or repair it directly.

**Current State:**
- `chunk_summary_brief` is inference-backed. The handler calls `summarizeChunkBrief({ memberProjections, memberOutcomes })`.
- The handler reads member `smooth_turn_compression` projections directly — it does NOT read `chunk_summary_detailed`.
- `summarizeChunkBrief` signature: `{ memberProjections: string[]; memberOutcomes?: ToolOutcome[][] }`.
- The current prompt `chunk-brief-v1` expects `memberProjections` array and renders numbered member texts with a trailing outcomes section.
- The handler shares `chunkSummaryHandler` with detailed, iterating over `readMemberProjections` to collect member content. After Story 4, the detailed branch uses a floor fallback for failed members — Story 5 will split brief away from the member loop and make it depend on the stored detailed derivation.
- Detailed and brief are queued as independent work items at chunk close (in `enqueueChunkSummaries`). Brief can legitimately run before detailed is ready and must handle that case.
- No `sizeDisposition` metadata is written for brief.
- Default target ratios for `chunk_summary_brief` are `targetMinRatio: 0.08`, `targetMaxRatio: 0.20`, `targetAimRatio: 0.12`.

**Derivation Testing Reference:**
A tested brief-compression prompt with good/bad examples exists at `derivation-testing/chunk_summary_brief/brief-prompt.md`. The prompt produces past-tense historical memory notes, not transcripts. Key quality signals: converts dialogue to narration, preserves durable decisions/corrections/outcomes, drops local process, lands near target size.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-5.1:** `chunk_summary_brief` consumes the stored `chunk_summary_detailed` text as its input, not raw member `smooth_turn_compression` texts.

- **TC-5.1a:** Input is detailed text
  - Given: a chunk with ready `chunk_summary_detailed`
  - When: `chunk_summary_brief` derives
  - Then: the model call receives the detailed text as input, not the member projection texts
- **TC-5.1b:** Model spy does not receive member projections
  - Given: a chunk with distinct detailed text and distinct member projection texts
  - When: `chunk_summary_brief` derives
  - Then: the model call input contains the detailed text and does NOT contain the individual member projection strings

**AC-5.2:** When `chunk_summary_detailed` is not ready, brief defers behind detailed work without consuming retry budget. When detailed is `blocked` or `failed`, brief lands accordingly.

- **TC-5.2a:** Brief defers when detailed is pending
  - Given: `chunk_summary_brief` derives while `chunk_summary_detailed` is `pending`
  - When: background derivation runs
  - Then: the claimed brief item is replaced by queued detailed work followed by fresh brief work, and the brief derivation row remains `pending` without incrementing retry attempts
- **TC-5.2b:** Brief blocks when detailed is blocked
  - Given: `chunk_summary_detailed` is `blocked`
  - When: `chunk_summary_brief` derives
  - Then: brief lands with `sourceDamaged`
- **TC-5.2c:** Brief fails when detailed is failed
  - Given: `chunk_summary_detailed` is `failed` (set directly — this is rare; requires floor-unavailable per Story 4)
  - When: `chunk_summary_brief` derives
  - Then: brief lands with `sourceDamaged` (the detailed material it needs is terminal)
- **TC-5.2d:** Brief schedules detailed before fresh brief when detailed has no live work
  - Given: both `chunk_summary_detailed` and `chunk_summary_brief` are pending with no live work (simulating a sweep-repair scenario where brief is scheduled first)
  - When: brief's handler runs and finds detailed not ready with no live detailed work
  - Then: the handler enqueues detailed work before a fresh brief item. After draining, both detailed and brief land `ready`. Brief does not consume a retry attempt waiting on absent detailed work.

**AC-5.3:** The brief prompt includes the input token count, a target output range (from assignment ratios), and concrete examples of good and bad brief output.

- **TC-5.3a:** Prompt includes token targets
  - Given: detailed text of ~2000 tokens with default brief ratios (0.08/0.12/0.20)
  - When: the brief prompt is rendered
  - Then: the model request includes input token count (~2000), target min (~160), target aim (~240), target max (~400)
- **TC-5.3b:** Prompt includes examples
  - Given: the brief prompt template
  - When: it renders
  - Then: the rendered prompt includes at least one good example and one bad example with commentary explaining the quality distinction
- **TC-5.3c:** Prompt includes historical-narration instruction
  - Given: the brief prompt template
  - When: it renders
  - Then: the prompt instructs the model to produce past-tense historical narration, not transcript or live instructions

**AC-5.4:** The `summarizeChunkBrief` callback signature changes to accept the detailed text and target token fields.

- **TC-5.4a:** New signature
  - Given: the updated `InferenceCallbacks.summarizeChunkBrief`
  - When: brief derives
  - Then: the callback receives `{ text: string; inputTokens: number; targetMinTokens: number; targetAimTokens: number; targetMaxTokens: number }` — not `{ memberProjections, memberOutcomes }`

**AC-5.5:** The compressed output's size disposition is recorded in derivation metadata as `sizeDisposition`.

- **TC-5.5a:** Size disposition persisted
  - Given: brief inference returns output within/outside the target range
  - When: the derivation lands
  - Then: metadata contains `sizeDisposition: "in_range"` / `"under_min"` / `"over_max"`, state is `ready` regardless

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `turns` because `chunk_summary_brief` is a chunk derivation. The handler changes its input source from member `smooth_turn_compression` rows to the single `chunk_summary_detailed` derivation row for the same chunk. This creates a sequential dependency in the derivation pipeline: `smooth_turn_compression` → `chunk_summary_detailed` → `chunk_summary_brief`.

The current `chunkSummaryHandler` shares a member-reading loop between detailed and brief. After this story, the brief branch no longer needs to iterate over member projections — it reads a single derivation row. The handler will need to split: detailed uses `readMemberProjections`, brief reads the detailed derivation directly.

#### Handler Split

The shared `chunkSummaryHandler` currently iterates `readMemberProjections` for both kinds. After this story:
- **Detailed** continues using `readMemberProjections` (with floor fallback from Story 4)
- **Brief** reads the `chunk_summary_detailed` derivation row for the same chunk

Options:
1. Split into two separate handler functions (`chunkDetailedHandler`, `chunkBriefHandler`)
2. Keep the shared function but branch early based on kind — detailed iterates members, brief reads the detailed row

Option 1 (split) is preferred — brief no longer needs the member loop at all, and splitting makes the two paths independently readable. But the behavioral contract is what matters; either option satisfies the ACs.

#### Reading Detailed for Brief

The brief handler needs to read `chunk_summary_detailed` for the same chunk. This is a derivation row read: `SELECT state, content FROM derivation WHERE subject_kind = 'chunk' AND subject_id = ? AND derivation_type = 'chunk_summary_detailed'`.

States:
- `ready` with content → use as brief input
- `pending` or missing → defer the claimed brief work behind detailed work, preserving source version
- `blocked` → brief lands `sourceDamaged` (the input it needs is terminal)
- `failed` → brief lands `sourceDamaged` (the detailed material is terminal; brief cannot produce a useful summary from nothing)

#### Callback Signature Change

Current: `summarizeChunkBrief(i: { memberProjections: string[]; memberOutcomes?: ToolOutcome[][] })`

New: `summarizeChunkBrief(i: { text: string; inputTokens: number; targetMinTokens: number; targetAimTokens: number; targetMaxTokens: number })`

The `text` field is the `chunk_summary_detailed` content. Target tokens are computed from `estimateTokens(text) × ratio` using the brief assignment's target ratios (0.08/0.12/0.20 from `DEFAULT_INFERENCE_ASSIGNMENTS.chunk_summary_brief`).

The handler computes concrete targets the same way Story 3's compression handler does — from `run.config` or from resolved brief-specific ratios.

#### Brief Target Ratios on Config

Story 3 added `compressionTargets` to `ResolvedSdkConfig` for `smooth_turn_compression`. Brief needs its own target ratios (0.08/0.12/0.20 — different from compression's 0.35/0.50/0.65). Options:
1. Add `briefTargets: { minRatio, aimRatio, maxRatio }` to `ResolvedSdkConfig` (parallel to `compressionTargets`)
2. Generalize to a per-kind targets map

Option 1 is simpler and mirrors the existing pattern. The handler reads `run.config.briefTargets` and computes concrete tokens.

#### Prompt Replacement

The current `chunk-brief-v1` renders numbered member projections with outcomes. The replacement prompt (e.g. `chunk-brief-v2`) is based on `derivation-testing/chunk_summary_brief/brief-prompt.md` and should:

- Receive the detailed chunk text, input token count, and concrete target min/aim/max tokens
- Include concrete examples of good and bad brief output with commentary
- Instruct the model to produce past-tense historical narration
- Name what to preserve: durable decisions, user corrections/preferences, unresolved questions, important outcomes, concrete anchors
- Name what to compress: back-and-forth dialogue, repeated corrections, local tool steps, procedural detail
- Instruct that old context must not sound like live instructions (convert "current state" / "next action" to historical framing)
- Include a self-check instruction before returning

#### Enqueue Ordering and Dependency Protection

Detailed and brief are currently queued as independent work items at chunk close. This story does NOT change the normal enqueue ordering — both are still queued in parallel. Brief handles the case where detailed isn't ready by deferring itself behind detailed work rather than burning a retry attempt.

The normal path (chunk close → drain) is safe: `enqueueChunkSummaries` enqueues detailed first (lower rowid), so detailed claims first, completes (deterministic, fast), and brief finds detailed ready on its claim.

The sweep/repair risk: `turns.report` orders by derivation type alphabetically, so `chunk_summary_brief` appears before `chunk_summary_detailed`. If sweep schedules both with no live work, brief could claim first and find detailed not ready. A naive retry would either consume a retry attempt or sit ahead of the detailed item in the strict FIFO queue. That would make correctness depend on retry budget or queue timing, which is the kind of implicit coupling the work queue hardening was meant to remove.

The fix is a deferred handler outcome on the turn-owned work path. When the brief handler finds detailed not ready, it returns a deferred outcome. The dispatcher handles that in one short transaction: delete the claimed brief item, enqueue `chunk_summary_detailed` if no live detailed work exists at the chosen source version, then enqueue a fresh `chunk_summary_brief` item behind it. If the detailed row is missing, the source version comes from the current brief derivation row; if both rows are missing, the handler treats the source as damaged instead of defaulting to version 1. This keeps the dependency explicit, preserves FIFO ordering, and avoids retry-budget consumption.

This keeps the dependency rule in the owning domain handler, doesn't require sweep/repair surface changes, and doesn't rely on retry-budget headroom for correctness.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The main risk is subtle input drift: the handler uses the wrong source and still produces plausible output. Tests must assert the exact model call input and the dependency behavior.

Risk Reminders:
- Brief must NOT fall back to raw member projections when detailed isn't ready — it must defer behind detailed work.
- The `summarizeChunkBrief` signature change breaks every test double and direct callback. All call sites must be updated.
- The prompt is example-heavy — keep the examples in the template, not in a separate file.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Brief handler | `src/turns/internal/derive.ts` — split the brief path to read `chunk_summary_detailed` row instead of iterating member projections. When detailed is not ready, return a deferred outcome that deletes the claimed brief work item and enqueues detailed work (if missing) before fresh brief work using the normal `enqueue(...)` path. When detailed row is missing, use the current brief row's source version; if both are missing, return `sourceDamaged`. Do not manually insert a `work_item` row or write detailed derivation content from the brief handler. |
| Deferred outcome contract | `src/shared-tech/derivation.ts`, `src/turns/internal/derive.ts`, `src/messages/internal/derive.ts` — add a narrow `HandlerOutcome` variant for turn-owned deferred work. The turns dispatcher owns deleting the claimed brief item and running the deferred enqueue transaction. Message-owned dispatchers reject deferred outcomes as unsupported. |
| Detailed row read | `src/turns/internal/derivations.ts` — add a function to read the detailed derivation row for a chunk (state + content) |
| Brief target ratios | `src/shared-tech/derivation.ts` — add `briefTargets: { minRatio, aimRatio, maxRatio }` to `ResolvedSdkConfig` |
| SDK construction | `src/sdk.ts` — resolve brief targets from `chunk_summary_brief` assignment ratios (0.08/0.12/0.20 defaults) |
| Callback signature | `src/shared-tech/derivation.ts` — change `summarizeChunkBrief` input from `{ memberProjections, memberOutcomes }` to `{ text, inputTokens, targetMinTokens, targetAimTokens, targetMaxTokens }` |
| Prompt template | `src/shared-tech/prompts/chunk-brief-v2.ts` — new template based on `derivation-testing/chunk_summary_brief/brief-prompt.md`, with examples and historical-narration instructions |
| Prompt registry | `src/shared-tech/prompts/index.ts` — register new template, update default prompt name |
| SDK defaults | `src/sdk.ts` — update `DEFAULT_PROMPT_NAMES` and `DEFAULT_INFERENCE_ASSIGNMENTS` for `chunk_summary_brief` |
| Old prompt | `src/shared-tech/prompts/chunk-brief-v1.ts` — keep as historical |
| Deterministic callbacks | `src/shared-tech/deterministic.ts` — update `summarizeChunkBrief` double to match new input |
| Test doubles | `test/fixtures/inference-callbacks-double.ts` — update to match new signature |
| Size disposition | Handler stamps `sizeDisposition` on brief metadata (same pattern as Story 3's compression) |
| Tests | `test/chunk-brief-from-detailed.test.ts` — input source, dependency behavior, prompt content, disposition |
| Existing tests | Update tests that assert on `summarizeChunkBrief` input shape (they currently pass `memberProjections`/`memberOutcomes`) |

#### Derivation Testing References

- `derivation-testing/chunk_summary_brief/brief-prompt.md` — the tested prompt with good/bad examples and historical-narration instructions. This is the authoritative source for the prompt template's content.
- `derivation-testing/chunk_summary_brief/chunk-summary-brief-notes.md` — design notes, pipeline rationale, quality criteria
- `derivation-testing/chunk_summary_brief/set-gpt54-five-turn-compressed-by-gpt54mini.jsonl` — the primary fixture for testing brief from detailed-compressed input

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-5.1a | `chunk-brief-from-detailed.test.ts` | Model spy receives detailed text as the `text` field, not member projection strings. |
| TC-5.1b | `chunk-brief-from-detailed.test.ts` | Model spy input does not contain individual member projection content strings. |
| TC-5.2a | `chunk-brief-from-detailed.test.ts` | Pending `chunk_summary_detailed`: brief defers, leaving detailed and brief pending and a fresh brief item queued with zero attempts. |
| TC-5.2b | `chunk-brief-from-detailed.test.ts` | Blocked `chunk_summary_detailed`: brief lands `sourceDamaged`. |
| TC-5.2c | `chunk-brief-from-detailed.test.ts` | Failed `chunk_summary_detailed` (set directly): brief lands `sourceDamaged`. |
| TC-5.2d | `chunk-brief-from-detailed.test.ts` | Brief pending, detailed pending/missing with no live detailed work: brief defers, enqueues detailed work before fresh brief work, and drain settles both to `ready`. Missing detailed uses the current brief source version. |
| TC-5.3a | `chunk-brief-from-detailed.test.ts` | 2000-token detailed text with default ratios: model input includes `inputTokens`, `targetMinTokens`, `targetAimTokens`, `targetMaxTokens`. |
| TC-5.3b | `chunk-brief-from-detailed.test.ts` | Rendered prompt contains good/bad example blocks. |
| TC-5.3c | `chunk-brief-from-detailed.test.ts` | Rendered prompt contains historical-narration instruction. |
| TC-5.4a | `chunk-brief-from-detailed.test.ts` | Model spy input shape is `{ text, inputTokens, targetMinTokens, targetAimTokens, targetMaxTokens }`. |
| TC-5.5a | `chunk-brief-from-detailed.test.ts` | Brief output lands `ready` with `sizeDisposition` in metadata. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Handler falls back to raw member projections | `chunk-brief-from-detailed.test.ts` | Seed distinct detailed text and distinct member compression texts. Assert only detailed text reaches the model, not member texts. | A canned output can pass while the wrong input source is silently used. |
| Brief bypasses detailed dependency | `chunk-brief-from-detailed.test.ts` | Detailed is pending/missing: brief defers through detailed work, not raw smooth input or direct detailed writes. | Recovery shortcuts are easy to introduce and hard to catch with happy-path tests. |
| Signature change breaks existing test doubles | Full test suite | `pnpm run verify` passes — all test doubles and deterministic callbacks compile and run with the new signature. | A compile error in an unused double would not surface in focused tests. |

#### Technical Notes

- The brief handler reads `chunk_summary_detailed` for the same chunk — this is a same-subject, different-derivation-type read. It's a simple derivation row query, not a cross-domain call.
- Default brief target ratios are `targetMinRatio: 0.08`, `targetAimRatio: 0.12`, `targetMaxRatio: 0.20` (from `DEFAULT_INFERENCE_ASSIGNMENTS.chunk_summary_brief`). These compress aggressively — a 2000-token detailed input targets 160-400 tokens of brief output.
- The prompt from `derivation-testing/chunk_summary_brief/brief-prompt.md` is example-heavy (~225 lines). The examples and commentary should be embedded in the template file directly, not loaded from external files at runtime.
- `sizeDisposition` uses the same computation as Story 3: compare `estimateTokens(output)` against the concrete target range.
- The normal chunk-close enqueue ordering doesn't change. The brief handler's dependency protection is the deferred outcome: delete the claimed brief item, ensure detailed work is queued, then queue fresh brief work behind it. See the Enqueue Ordering section for the full mechanism.
- `briefTargets` construction should validate: finite positive ratios, `min <= aim <= max`, same pattern as Story 3's `compressionTargets` validation. Direct-callback hosts get defaults.
- Target token rounding should use `Math.round` (same as Story 3's `compressionTargetTokens`).
- Thread-view compact fallback ladders remain unchanged — brief fallback still uses detailed material when brief is missing. This story does not alter the compact fallback behavior.
- `chunk-brief-v1.ts` stays in the prompts directory as a historical file.

#### Anti-Shim Requirements

- Assert the model spy receives the detailed text (not member projections) as the `text` field.
- Assert the model spy receives concrete target token numbers.
- Assert pending/blocked/failed detailed leads to deferred/sourceDamaged, never raw-input fallback or direct detailed writes from the brief handler.
- Assert `sizeDisposition` is persisted in derivation metadata.
- Assert the dependency-protection path schedules detailed through the owner-domain enqueue path and keeps source versions aligned, not by direct `work_item` insertion or direct derivation update.
- Assert the rendered prompt contains example blocks and historical-narration instruction.

#### Production Path Proof

- Entrypoint: queued `chunk_summary_brief` derivation handled by `turns/internal/derive.ts`.
- Dependency: handler reads `chunk_summary_detailed` for the same chunk. If ready, uses as input. If pending or missing, defers the current brief item behind detailed work using the turn-owned dispatcher.
- Inference: `summarizeChunkBrief({ text, inputTokens, targetMinTokens, targetAimTokens, targetMaxTokens })` → adapter → prompt template → model call.
- Evidence: `chunk-brief-from-detailed.test.ts` uses real handler wiring, real temp SQLite, and model call spy.

#### Source/Derived State Risk

- Source truth is the chunk's `chunk_summary_detailed` derivation (itself derived from member compressions).
- Derived state is the brief memory note plus provenance and `sizeDisposition`.
- A mutation that rebuilds the detailed chunk also clears the brief derivation through the existing cascade. The rebuilt brief reads the new detailed text.

#### Integration Tests

Add to the real-inference suite in `inference-real.test.ts`:

- **Real brief from detailed:** Send enough turns to close a chunk. Assert `chunk_summary_detailed` lands `ready` (deterministic). Assert `chunk_summary_brief` lands `ready` with non-empty real model content (not deterministic marker text), real provenance with prompt name `chunk-brief-v2`, and `sizeDisposition` metadata present. Prose-quality assertions (historical narration, no speaker markers) belong in local prompt tests, not the real-inference suite.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run verify`
- Epic gate: `pnpm run verify:all`

#### Spec Deviations

- **Numbering:** ACs renumbered from 3.x to 5.x. This is Story 5 in the updated sequence.
- **Dependency handling:** The original story mentioned compact-time recovery for pending detailed. That's already handled by the compact fallback ladders (existing behavior, unchanged by this story). This story specifies the background handler's behavior only.
- **Deferred dependency handling:** The original analysis identified enqueue ordering as "highest-risk." The implemented mechanism adds a narrow turn-owned deferred outcome so brief can delete its claimed item and enqueue detailed before fresh brief work. This changes the handler/dispatcher contract but keeps sweep and repair surfaces unchanged and avoids retry-budget dependency.
- **Brief target ratios on config:** Follows the Story 3 pattern (`compressionTargets`). Adds `briefTargets` in parallel.
- **Verification scripts:** Story gate is `pnpm run verify`. Epic gate is `pnpm run verify:all`.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Brief model input is `chunk_summary_detailed` text, not raw member `smooth_turn_compression` texts.
- `summarizeChunkBrief` signature changed to `{ text, inputTokens, targetMinTokens, targetAimTokens, targetMaxTokens }`.
- `ResolvedSdkConfig.briefTargets` carries resolved brief target ratios for both config paths. Construction validates positive ratios and `min <= aim <= max`.
- Prompt includes input count, target range, good/bad examples with commentary, and historical-narration instruction.
- Prompt is based on `derivation-testing/chunk_summary_brief/brief-prompt.md`.
- Pending/missing detailed defers behind detailed work. Blocked/failed detailed lands `sourceDamaged`.
- Brief does not fall back to raw member projections under any circumstance.
- Brief handler defers behind detailed work when detailed is pending or missing (TC-5.2a/5.2d) — dependency is explicit, FIFO-safe, and not retry-budget-dependent.
- `sizeDisposition` persisted in derivation metadata.
- Thread-view compact fallback ladders unchanged.
- All test doubles and deterministic callbacks updated to new signature.
- Real-inference integration test verifies brief from detailed with structural assertions (ready, provenance, disposition).
- `pnpm run verify` passes.
