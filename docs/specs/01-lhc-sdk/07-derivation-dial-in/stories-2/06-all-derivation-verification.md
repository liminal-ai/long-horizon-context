# Story 6: All-Derivation Verification

### Summary
<!-- Jira: Summary field -->

Close the integration test gaps from the Epic 7 pipeline changes, align prompt templates with their tested references, clean up the `InferenceCallbacks` interface, and verify the fully assembled derivation pipeline works end-to-end.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator verifying LHC derivation behavior, and the host process running the full pipeline through a real model provider.

**Objective:** Three categories of work remain before the epic is complete:

1. **Prompt alignment.** Three prompt templates were implemented without faithfully porting the tested references from `derivation-testing/`. The `chunk-brief-v2` prompt is the worst — a 42-line generic prompt replaced a 230-line tested reference with 3 worked examples (AC-3.4 not met). The `smooth-turn-compression-v1` prompt is close but omits key instructions from its tested reference. The `tool-result-v2` prompt is faithful except for a missing search-result line truncation from its reference.

2. **Interface cleanup.** The tech design specifies that `composeTurnRendering` and `summarizeChunkDetailed` should be removed from the `InferenceCallbacks` interface since they are deterministic and never called through inference. They are still present as unused seams.

3. **Integration test gaps.** Stories 3 and 5 specified integration tests but their coders did not add them. The lifecycle capstone does not assert the new pipeline behaviors.

**Scope In:** Prompt template alignment with tested references. Removal of unused deterministic methods from `InferenceCallbacks`. Real-inference integration tests for smooth turn compression (Story 3) and brief-from-detailed (Story 5). Updated lifecycle capstone assertions for new prompt names, `sizeDisposition` metadata, and the detailed marker format.

**Scope Out:** No new derivation behavior. No changes to handler logic, guard wiring, or work queue mechanics. Per-handler timeout wiring for `guards.toolResultSummary.timeoutMs` (AC-5.4 from the original epic) was explicitly deferred in Story 2 — the global `inference.timeoutMs` covers all calls; per-call timeout is an adapter-level concern for a future story.

**Dependencies:** Stories 1-5 all implemented.

**Architecture Constraints:** Verification must preserve domain ownership. No provider calls during intake or context-serving. Real-inference tests use the host-provided `ModelCall` path through `createOpenRouterCall`, the same adapter path the PI extension uses.

**Current State:**

Prompt alignment:
- **`chunk-brief-v2.ts`** — already ported from the tested reference by the Story 5 coder's remediation. Contains all three worked examples with full input/output/commentary, the historical-memory framing, preserve/compress lists, historical-framing rules, self-check, and anti-pattern instructions. Verify the golden snapshot pins the full reference content.
- **`smooth-turn-compression-v1.ts`** — close to the reference at `derivation-testing/chunk_summary_detailed/prompt-turn-compress-v1.md` but still missing two instructions: "Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do." and the two-pass self-check ("If it is too short, expand... If it is too long, contract..."). This is the one prompt that still needs a code change.
- **`tool-result-v2.ts`** — already has the search-result line truncation (60-line cap with omission note) and already receives `responseShape`. Landed in the Story 5 coder's remediation. However, no test exercises the search-result truncation path — the code could break silently.

Interface gap:
- `InferenceCallbacks` in `shared-tech/derivation.ts` still contains `composeTurnRendering` and `summarizeChunkDetailed`. These are deterministic operations that are never called through inference. The tech design explicitly says to remove them. They exist as unused seams with test doubles and deterministic callback implementations that carry dead code.

Integration test gaps:
- The real-inference suite (`inference-real.test.ts`) has three test groups:
  1. **Six-kind round-trip** via `assertRoutingThroughSdk`: exercises all 6 derivation types, asserts `ready` + real provenance + non-marker content. Already checks `chunk-brief-v2` prompt name and `sizeDisposition` on brief. Uses `tinyTurnTokens: 1` to force compression.
  2. **Epic 07 guard/classifier seams**: Story 1 (over-cap/under-cap prompt) + Story 2 (bash failure + large tool result). These are done and correct.
  3. **Lifecycle capstone** via `runLifecycle`: 12 turns, 4 tool-heavy, full create→intake→drain→compact→context→inspect→edit→rebuild→drain→compact→materialize sequence. Asserts all kinds ready, no deterministic markers, real provenance, mutation regeneration, coherent health checkpoints.
- **Missing:** No real-inference test for smooth turn compression with target ratios, sizeDisposition, or the new `smooth-turn-compression-v1` prompt. No test for tiny-turn passthrough behavior under real inference. No test for brief consuming detailed text (vs member projections) with the new `chunk-brief-v2` prompt and `sizeDisposition`.
- **Lifecycle capstone gaps:** Does not assert `sizeDisposition` on `smooth_turn_compression` derivations. Does not assert new prompt names (`smooth-turn-compression-v1`, `tool-result-v2`). Does not assert `[turn` markers in `chunk_summary_detailed` content.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-6.P1:** The `chunk-brief-v2` prompt template (already ported from the tested reference) is verified via golden snapshot to pin the full reference content.

- **TC-6.P1a:** Golden pins the full reference
  - Given: the current `chunk-brief-v2.ts` (already ported by the Story 5 coder)
  - When: the golden prompt test renders it
  - Then: the golden snapshot contains the historical-memory-note framing, the target-as-guide instruction, the preserve/compress lists, the historical-framing conversion rules, all three worked examples from the reference (good-example-1, bad-example-1, bad-example-2) with their full input/output/commentary, the self-check checklist, and the anti-pattern instructions. A future edit that silently drops tested material fails the golden comparison.

**AC-6.P2:** The `smooth-turn-compression-v1` prompt template is updated to faithfully port the tested reference at `derivation-testing/chunk_summary_detailed/prompt-turn-compress-v1.md`.

- **TC-6.P2a:** Missing instructions restored
  - Given: the updated `smooth-turn-compression-v1.ts`
  - When: the prompt is rendered
  - Then: the rendered output contains: "Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do." and the two-pass self-check ("If it is too short, expand it by restoring missing substance. If it is too long, contract it by removing lower-value detail and repeated explanation.")

**AC-6.P3:** The existing search-result line truncation in `tool-result-v2` (already implemented) has test coverage pinning the behavior.

- **TC-6.P3a:** Search-result truncation test
  - Given: the existing `rawOutputForPrompt` with a `search_result` response shape and >60 lines of output
  - When: the function processes it
  - Then: the output is truncated to 60 lines with the `[omitted N additional search-result lines; use parsed searchMatchCount/searchMatches as authoritative]` note. This test pins the existing behavior that currently has no coverage.

**AC-6.C1:** The `composeTurnRendering` and `summarizeChunkDetailed` methods are removed from the `InferenceCallbacks` interface. They are deterministic operations that never call inference and should not be on the inference boundary.

- **TC-6.C1a:** Interface cleaned
  - Given: the updated `InferenceCallbacks` in `shared-tech/derivation.ts`
  - When: the interface is inspected
  - Then: it contains only the four inference-backed operations: `smoothPrompt`, `summarizeToolResult`, `compressSmoothTurn`, `summarizeChunkBrief`
- **TC-6.C1b:** All consumers updated
  - Given: the removal
  - When: `pnpm run verify` runs
  - Then: all test doubles, deterministic callbacks, and any code referencing the removed methods is updated or removed. No compile errors.

**AC-6.1:** The real-inference suite covers the smooth turn compression pipeline path with target ratios, `sizeDisposition`, and the new prompt.

- **TC-6.1a:** Real compression with target ratios
  - Given: a multi-message turn above the tiny-turn threshold (prompt + assistant + tool call + tool result + turn_end) processed through a real model provider
  - When: derivations are read after drain
  - Then: `smooth_turn_compression` is `ready` with non-empty real content, provenance prompt is `smooth-turn-compression-v1`, `sizeDisposition` is present in metadata
- **TC-6.1b:** Tiny-turn passthrough under real inference
  - Given: a minimal turn (short prompt + short response + turn_end) under the default tiny-turn threshold, processed through a real model provider
  - When: derivations are read after drain
  - Then: `smooth_turn_compression` is `ready`, content equals the structured rendering text (not model-generated), no `sizeDisposition` metadata, zero `compressSmoothTurn` model calls for this turn (other message-level calls may still occur)

**AC-6.2:** The real-inference suite covers the brief-from-detailed pipeline path.

- **TC-6.2a:** Real brief from detailed
  - Given: enough turns to close a chunk, processed through a real model provider
  - When: derivations are read after drain
  - Then: `chunk_summary_detailed` is `ready` (deterministic), `chunk_summary_brief` is `ready` with non-empty real content, provenance prompt is `chunk-brief-v2`, `sizeDisposition` is present in metadata

**AC-6.3:** The lifecycle capstone assertions are tightened to cover Epic 7 pipeline behaviors.

- **TC-6.3a:** New prompt names in provenance
  - Given: the lifecycle capstone runs under the real adapter
  - When: ready inference-backed derivations are inspected
  - Then: `smooth_turn_compression` provenance prompt is `smooth-turn-compression-v1`, `tool_result_summary` provenance prompt is `tool-result-v2`, `chunk_summary_brief` provenance prompt is `chunk-brief-v2`
- **TC-6.3b:** `sizeDisposition` on inference-backed turn/chunk derivations
  - Given: the lifecycle capstone runs under the real adapter
  - When: `smooth_turn_compression` and `chunk_summary_brief` derivations are inspected
  - Then: each has `sizeDisposition` in metadata (value is one of `in_range`, `under_min`, `over_max`)
- **TC-6.3c:** Detailed marker format
  - Given: the lifecycle capstone runs under the real adapter
  - When: `chunk_summary_detailed` content is inspected
  - Then: it contains `[turn ` markers (confirming the Story 4 format landed in the full pipeline)
- **TC-6.3d:** Zero model calls for deterministic derivations in full pipeline
  - Given: the lifecycle capstone completes with a recording wrapper around the model call
  - When: model call log is inspected
  - Then: after the interface cleanup (AC-6.C1), `composeTurnRendering` and `summarizeChunkDetailed` are no longer on `InferenceCallbacks` and cannot route through the adapter. The model call count matches the expected number of inference-backed derivations only — no extra calls from deterministic paths.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story has three parts: prompt alignment (production code changes to prompt templates), interface cleanup (removing unused methods from `InferenceCallbacks`), and integration test coverage. The prompt and interface changes must land before the integration tests can meaningfully verify the pipeline — the tests assert provenance prompt names and interface shape that depend on the fixes.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- This story is a capstone check over implemented behavior, not a new behavior slice. The main risk is false confidence from silently skipped real-inference tests.

Risk Reminders:
- Missing auth/fixture must produce a NOT-RAN line with reason, not pass-shaped output.
- Deterministic derivations must record zero provider calls even in the full pipeline.
- New tests must be gated on the same `describe.runIf(keyed)` pattern as existing Epic 07 tests.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Chunk brief prompt verification | `test/inference-prompts.test.ts` + `test/goldens/prompts/` — verify the golden snapshot for `chunk-brief-v2` pins the full ported reference content including all three examples. No code change to `chunk-brief-v2.ts` unless the golden reveals drift from the tested reference. |
| Smooth compression prompt | `src/shared-tech/prompts/smooth-turn-compression-v1.ts` — add the two missing instructions from `derivation-testing/chunk_summary_detailed/prompt-turn-compress-v1.md`: "Do not say only that a tool ran or a file was read. Say what it showed, changed, proved, or failed to do." and the two-pass self-check: "If it is too short, expand it by restoring missing substance. If it is too long, contract it by removing lower-value detail and repeated explanation." |
| Tool result search truncation test | `test/tool-result-summary.test.ts` or `test/inference-prompts.test.ts` — add a test exercising the existing `rawOutputForPrompt` search-result truncation (>60 lines, `search_result` responseShape → truncated to 60 lines with omission note). No code change to `tool-result-v2.ts` — the truncation already exists but is untested. |
| Interface cleanup | `src/shared-tech/derivation.ts` — remove `composeTurnRendering` and `summarizeChunkDetailed` from `InferenceCallbacks`. Remove from `INFERENCE_CALLBACK_OPERATIONS`. |
| Interface cleanup consumers | `src/shared-tech/deterministic.ts`, `src/shared-tech/inference-adapter.ts`, `test/fixtures/inference-callbacks-double.ts` — remove the two dead methods from all implementations and doubles. |
| Prompt golden tests | `test/inference-prompts.test.ts` and `test/goldens/prompts/` — update golden snapshots for all three changed prompts. |
| Smooth compression integration | `test/inference-real.test.ts` — new test within the Epic 07 `describe.runIf(keyed)` block: multi-message turn above threshold + tiny turn below threshold |
| Brief from detailed integration | `test/inference-real.test.ts` — new test within the Epic 07 block: enough turns to close a chunk, assert brief reads detailed |
| Lifecycle capstone assertions | `test/inference-real.test.ts` — tighten the existing capstone `it` blocks to assert new prompt names, `sizeDisposition`, and detailed marker format |

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-6.P1a | `inference-prompts.test.ts` + golden | Golden snapshot for `chunk-brief-v2` pins the full ported reference: all three examples, framing, preserve/compress lists, historical-framing rules, self-check. Future drift fails the comparison. |
| TC-6.P2a | `inference-prompts.test.ts` + golden | Rendered `smooth-turn-compression-v1` prompt contains "Do not say only that a tool ran" instruction and the two-pass self-check. |
| TC-6.P3a | `tool-result-summary.test.ts` or `inference-prompts.test.ts` | Search-result with >60 lines: existing `rawOutputForPrompt` truncates to 60 lines with the authoritative-fields note. Pins existing untested behavior. |
| TC-6.C1a | Code inspection / typecheck | `InferenceCallbacks` contains only 4 methods: `smoothPrompt`, `summarizeToolResult`, `compressSmoothTurn`, `summarizeChunkBrief`. |
| TC-6.C1b | `pnpm run verify` | All consumers compile and pass after removal. |
| TC-6.1a | `inference-real.test.ts` | Multi-message turn: `smooth_turn_compression` ready, real provenance with `smooth-turn-compression-v1`, `sizeDisposition` present. |
| TC-6.1b | `inference-real.test.ts` | Tiny turn: `smooth_turn_compression` ready, content matches rendering text, no `sizeDisposition`, zero `compressSmoothTurn` calls for this turn. |
| TC-6.2a | `inference-real.test.ts` | Chunk closes: `chunk_summary_detailed` ready (deterministic), `chunk_summary_brief` ready with real provenance (`chunk-brief-v2`) and `sizeDisposition`. |
| TC-6.3a | `inference-real.test.ts` (capstone) | Provenance prompt names on inference-backed derivations match the new defaults. |
| TC-6.3b | `inference-real.test.ts` (capstone) | `smooth_turn_compression` and `chunk_summary_brief` derivations have `sizeDisposition`. |
| TC-6.3c | `inference-real.test.ts` (capstone) | `chunk_summary_detailed` content contains `[turn ` markers. |
| TC-6.3d | `inference-real.test.ts` (capstone) | Model call log contains no routing for `turn_rendering` or `chunk_summary_detailed`. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Real-inference suite silently passes without auth | `inference-real.test.ts` | With no `OPENROUTER_API_KEY`, emit exactly one NOT-RAN line with reason and no pass-shaped result. | Already exists and should remain unchanged. |
| Deterministic derivations call providers in full pipeline | `inference-real.test.ts` (capstone, TC-6.3d) | Model call log under lifecycle carries no `turn_rendering` or `chunk_summary_detailed` routing. | Unit tests pass while full-pipeline routing drifts. |
| `sizeDisposition` only observed in unit tests, not in full pipeline | `inference-real.test.ts` (capstone, TC-6.3b) | Lifecycle derivations carry `sizeDisposition` on inference-backed types. | Unit tests pass handler return values but metadata could be lost in the full completion transaction path. |
| Brief consumes wrong input in full pipeline | `inference-real.test.ts` (TC-6.2a) | Brief lands ready after detailed — structural evidence that the dependency works end-to-end. | Unit tests mock the dependency; the full pipeline exercises the actual enqueue ordering and retry behavior. |
| Prompt templates drift from tested references | `inference-prompts.test.ts` + golden snapshots | The rendered prompt golden snapshots pin the full content including examples and instructions. A future edit that removes or shortens the tested examples will fail the golden comparison. | Stories 3 and 5 coders wrote generic prompts instead of porting tested references — golden snapshots prevent this from recurring silently. |
| Unused interface methods accumulate dead code | `pnpm run verify` (TC-6.C1b) | After removal, compile and test pass with no references to the removed methods. | Dead interface methods accumulate test doubles and deterministic implementations that look maintained but are never exercised in production. |

#### Technical Notes

**Prompt alignment:**
- The `chunk-brief-v2` prompt was already ported from the tested reference by the Story 5 coder. No code change needed — verify the golden snapshot pins the full content. If the golden doesn't exist yet or is stale, regenerate it.
- The `smooth-turn-compression-v1` prompt is a targeted update, not a rewrite. The existing structure (system message with substance/noise lists + user message with rendering text) is correct. Add the two missing instructions from the reference at `derivation-testing/chunk_summary_detailed/prompt-turn-compress-v1.md` (note: the directory name `chunk_summary_detailed` is counterintuitive for a compression prompt — the derivation-testing folder structure evolved, but the file is confirmed to contain the right content). Do not restructure the prompt.
- The `tool-result-v2` search-result truncation code already exists and already receives `responseShape`. No code change needed — add a test exercising the >60-line search-result path, which currently has zero coverage.
- After updating the smooth-compression prompt, regenerate its golden snapshot. Verify all three prompt goldens are current.

**Interface cleanup:**
- `composeTurnRendering` and `summarizeChunkDetailed` are on `InferenceCallbacks` (lines 138 and 152-155 of `derivation.ts`), on `INFERENCE_CALLBACK_OPERATIONS`, on the deterministic callbacks in `deterministic.ts`, on the inference adapter in `inference-adapter.ts`, and on the test double in `test/fixtures/inference-callbacks-double.ts`. All references must be removed. The adapter's `renderAndCall` dispatch and the double's recording logic may reference these by name — verify all call sites.
- After removal, `INFERENCE_CALLBACK_OPERATIONS` should contain 4 entries, not 6. Tests that iterate over this array (e.g. conformance tests, routing tests) will automatically cover fewer operations, which is correct.

**Integration tests:**
- The smooth-compression test (TC-6.1a/b) needs two turns in the same thread: one above threshold and one below. The above-threshold turn should be multi-message (prompt + assistant + tool call + tool result + turn_end) to produce a rendering large enough for meaningful compression. The below-threshold turn should be minimal (short prompt + short response + turn_end).
- For TC-6.1b (tiny-turn passthrough), the test must verify that the `smooth_turn_compression` content equals the `turn_rendering` content for the same turn — confirming the passthrough stored the rendering text, not model output. Read both derivation rows and compare.
- For TC-6.1b, "zero `compressSmoothTurn` calls for this turn" means the recording model call log should have no entries matching the `smooth_turn_compression` assignment's provider/model for the second turn's time window. Since both turns drain together, the simplest approach is to assert the total `compressSmoothTurn` call count equals 1 (only the above-threshold turn).
- The brief-from-detailed test (TC-6.2a) needs enough turns to close a chunk. Use a low `chunkPolicy.targetProjectedTokens` (e.g. 5) so a single turn closes a chunk. Then detailed is deterministic (fast) and brief follows. Assert both land `ready`.
- The lifecycle capstone already runs `tinyTurnTokens: 1` (forcing compression for all turns) — all lifecycle turns produce real `smooth_turn_compression` via inference. The new assertions layer onto the existing `it` blocks, not into new `it` blocks — keeping the capstone's "one long run, many assertions" structure.
- TC-6.3d: the model call log from the lifecycle capstone is not currently exposed. The capstone uses `createOpenRouterCall` directly without a recording wrapper. Either wrap it with `recordRealCall` (adds the logging layer) or add a new `it` block that inspects the call log. The recording wrapper is already used in the Epic 07 guard/classifier tests and adds negligible overhead.
- New tests must use the same timeout pattern as existing Epic 07 tests: `300_000` ms per test.

#### Anti-Shim Requirements

- Do not mark real-inference checks as passed when prerequisites are missing.
- Do not test only private helpers — exercise the full derivation pipeline through SDK surface calls (intake → drain → read).
- Assert provenance from the derivation row, not from handler return values.
- Assert `sizeDisposition` from the derivation row, not from handler return values.
- The tiny-turn rendering-equals-compression assertion must compare actual stored content, not just check non-empty.
- Do not invent prompt examples. Do not shorten or paraphrase the reference examples. The examples in the tested references were tested against real models and the wording matters.
- Do not leave `composeTurnRendering` or `summarizeChunkDetailed` on any interface, double, or implementation after this story. Grep for both names across `src/` and `test/` and confirm zero references remain (except historical prompt files and documentation).
- After removal, `INFERENCE_CALLBACK_OPERATIONS` has 4 entries. Verify no test has a hardcoded `length === 6` assertion that would break — tests iterating over the array should work with the reduced count.

#### Production Path Proof

- Entrypoint: full SDK construction plus queue drain over real thread files.
- Registration/default path: defaults route each inference derivation through configured provider/model metadata; deterministic derivations stay inside domain handlers.
- Evidence: `inference-real.test.ts` — the focused tests and the lifecycle capstone.

#### Fixture Fidelity

- Use real temp thread files and the same host fixture shape as the existing Epic 07 tests.
- Reuse `createOpenRouterCall`, `recordRealCall`, `tempStore`, `validEvent`, `findDerivation`, `drainRealWork`, `newRealThread` from the existing test file.
- Preserve provider/model provenance in assertions.
- Record NOT-RAN accounting explicitly when auth is unavailable — existing mechanism, no changes.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run verify`
- Epic gate: `pnpm run verify:all`

#### Spec Deviations

- **Prompt alignment is partially new scope for this story.** The original Story 6 was verification-only. The Story 5 coder's remediation already ported `chunk-brief-v2` and added the `tool-result-v2` search truncation. What remains: `smooth-turn-compression-v1` still needs two missing instructions from its tested reference, and the search-result truncation needs test coverage. The chunk-brief prompt is verify-only.
- **Interface cleanup is new scope for this story.** The tech design specified removing `composeTurnRendering` and `summarizeChunkDetailed` from `InferenceCallbacks` as part of the production-method changes. Stories 3-4 didn't do it. This story completes it.
- **AC-5.4 (per-handler timeout) remains deferred.** The epic specified a hard timeout for tool-result model calls via `guards.toolResultSummary.timeoutMs`. Story 2 deferred this as an adapter-level cross-cutting concern. The global `inference.timeoutMs` (default 60s) covers all calls. Per-call timeout is out of scope for this epic.
- **Lifecycle capstone recording wrapper.** The original capstone doesn't record model calls. This story adds a recording wrapper to enable TC-6.3d (zero deterministic routing assertion). This is a test-only change that doesn't affect the capstone's behavior.
- **Verification scripts:** `green-verify` and `verify-all` do not exist. Story gate is `pnpm run verify`. Epic gate is `pnpm run verify:all`.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

Prompt alignment:
- `chunk-brief-v2.ts` (already ported) verified via golden snapshot pinning the full reference content including all three examples.
- `smooth-turn-compression-v1.ts` updated with the "do not say only that a tool ran" instruction and the two-pass self-check from the tested reference.
- `tool-result-v2.ts` search-result truncation (already implemented) pinned by a new test exercising the >60-line path.
- Golden prompt snapshots current for all three prompts.

Interface cleanup:
- `composeTurnRendering` and `summarizeChunkDetailed` removed from `InferenceCallbacks`, `INFERENCE_CALLBACK_OPERATIONS`, all implementations, all test doubles.
- Zero references to the removed methods in `src/` or `test/` (except historical files and documentation).

Integration tests:
- Real-inference test covers smooth turn compression: above-threshold turn lands `ready` with `smooth-turn-compression-v1` provenance and `sizeDisposition`.
- Real-inference test covers tiny-turn passthrough: below-threshold turn stores rendering text as compression, no `sizeDisposition`, no `compressSmoothTurn` model call for that turn.
- Real-inference test covers brief-from-detailed: chunk closes, detailed lands `ready` (deterministic), brief lands `ready` with `chunk-brief-v2` provenance and `sizeDisposition`.
- Lifecycle capstone asserts new prompt names on inference-backed provenance (`smooth-turn-compression-v1`, `tool-result-v2`, `chunk-brief-v2`).
- Lifecycle capstone asserts `sizeDisposition` on `smooth_turn_compression` and `chunk_summary_brief` derivations.
- Lifecycle capstone asserts `[turn ` markers in `chunk_summary_detailed` content.
- Lifecycle capstone asserts zero model calls routed to `turn_rendering` or `chunk_summary_detailed`.
- All new tests gated on `describe.runIf(keyed)` — no pass-shaped output when prerequisites are missing.

Gates:
- `pnpm run verify` passes.
- `pnpm run verify:all` passes.
