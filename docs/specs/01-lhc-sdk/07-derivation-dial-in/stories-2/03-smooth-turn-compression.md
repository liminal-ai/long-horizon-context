# Story 3: Smooth Turn Compression

### Summary
<!-- Jira: Summary field -->

Wire the tiny-turn guard, improve the turn rendering input, replace the compression prompt, and add target ratio guidance to the compression path.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `initLhc`.

**Objective:** Tune the `smooth_turn_compression` inference path: skip tiny turns, improve the rendering text the model compresses from, replace the untuned prompt with one that consumes target ratios and preserves substance, and validate that the full path from message recovery through compression lands quality output.

**Scope In:** Tiny-turn guard wiring, turn rendering text improvement, prompt replacement with target ratio consumption, `sizeDisposition` metadata, target-ratio config plumbing to handler.

**Scope Out:** No changes to `smoothed_prompt` or `tool_result_summary` (Stories 1-2). No changes to chunk summary derivations (Stories 4-5). No changes to the work queue, retry, or completion-transaction mechanics. No changes to consumer-time recovery (compact fallback ladders). No changes to chunk placement — placement already uses the stored `smooth_turn_compression` token estimate.

**Dependencies:** Stories 1 and 2 enrich message-level derivations that this story's turn handler resolves before compression. Guard config on `ResolvedSdkConfig.guards` from Story 1.

**Architecture Constraints:** `turns` owns turn-shaped derivations and queues its own work when a turn closes. The handler composes the turn rendering deterministically, then either stores it directly (tiny turn) or calls `compressSmoothTurn`. Message-level recovery before composition is already implemented.

**Current State:**
- `smooth_turn_compression` is already inference-backed. The handler at `derive.ts:298` calls `run.inferenceCallbacks.compressSmoothTurn({ rendering: renderingText })`.
- `turn_rendering` is deterministic. `composeTurnRenderingText` at `derive.ts:72-74` joins parts with `" | "` — crude, loses part boundaries and message-kind structure.
- The handler always calls inference regardless of turn size. `guards.smoothTurnCompression.tinyTurnTokens` (default 80) exists on `ResolvedSdkConfig.guards` but is not read by the handler.
- The current prompt `lower-band-v1` is untuned: "80 words maximum" with no target ratios, no input token count, no explicit substance-preservation instructions.
- The `compressSmoothTurn` callback signature takes `{ rendering: string }` — no explicit target token fields. The adapter injects target ratios via `withTargetRatios` (default 0.35/0.50/0.65 from the assignment), but the prompt template doesn't consume them.
- **Target ratios are not visible to the handler.** They live in `inference.assignments` / `DEFAULT_INFERENCE_ASSIGNMENTS`. `ResolvedSdkConfig` does not expose them. The handler has `run.config: ResolvedSdkConfig` and cannot compute concrete target tokens or `sizeDisposition`. Direct-callback hosts bypass the adapter entirely and have no assignments at all.
- Message-level recovery before composition (`recoverMessageDerivations`) is already implemented and was updated in Stories 1-2 to use `deriveSmoothedPrompt` and `deriveToolResultSummary`.
- No `sizeDisposition` metadata is written.
- The handler produces two derivations in one return: `turn_rendering` (deterministic) and `smooth_turn_compression` (inference-backed), both on the same handler outcome.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-3.1:** Turns below the tiny-turn threshold have their rendering text stored as `smooth_turn_compression` without inference, landing `ready`.

- **TC-3.1a:** Tiny turn skips inference
  - Given: a turn whose rendering text is under the configured `tinyTurnTokens` threshold (default 80)
  - When: `smooth_turn_compression` derives
  - Then: the rendering text is stored directly as `smooth_turn_compression`, no `compressSmoothTurn` call is made, and state is `ready`. Other message-level derivations (smoothed_prompt, tool_result_summary) may still call inference for their own work.
- **TC-3.1b:** Custom threshold respected
  - Given: a config with `guards.smoothTurnCompression.tinyTurnTokens` set to 200
  - When: a 150-token turn derives
  - Then: inference is skipped

**AC-3.2:** The turn rendering text provides meaningful structure for the compression model, not a flat `" | "` join.

- **TC-3.2a:** Rendering includes message-kind markers
  - Given: a turn with a user prompt, assistant text, tool calls, and tool results
  - When: the rendering text is composed
  - Then: the text includes markers or separators that distinguish message kinds (prompt, response, tool activity) so the compression model can identify what to preserve vs what to compress
- **TC-3.2b:** Rendering preserves part order
  - Given: a turn with messages in a specific order
  - When: the rendering text is composed
  - Then: the parts appear in the same order as the messages

**AC-3.3:** The compression prompt includes the input token count, a target output range (min/aim/max derived from the assignment's target ratios), and instructions for substance preservation.

- **TC-3.3a:** Callback input includes concrete token targets
  - Given: a rendering of ~1000 tokens with default target ratios (0.35/0.50/0.65)
  - When: `compressSmoothTurn` is called
  - Then: the callback input includes `inputTokens` (~1000), `targetMinTokens` (~350), `targetAimTokens` (~500), `targetMaxTokens` (~650), and the rendered prompt contains these concrete numbers
- **TC-3.3b:** Prompt includes substance-preservation instructions
  - Given: any above-threshold turn
  - When: the compression prompt is rendered
  - Then: the prompt names what to preserve (decisions, corrections, commitments, tool outcomes, concrete references, unresolved questions) and what to drop (filler, repeated acknowledgements, raw tool mechanics)

**AC-3.4:** The compressed output's size disposition relative to the target range is recorded in derivation metadata as `sizeDisposition`.

- **TC-3.4a:** In-range output
  - Given: compression output within the target range
  - When: the derivation lands
  - Then: metadata contains `sizeDisposition: "in_range"`
- **TC-3.4b:** Over/under output accepted
  - Given: compression output above or below the target range
  - When: the derivation lands
  - Then: state is still `ready` (not failed), metadata contains `sizeDisposition: "over_max"` or `"under_min"`

**AC-3.5:** The prompt template `lower-band-v1` is replaced with a tuned template as the default for `smooth_turn_compression`.

- **TC-3.5a:** New prompt is the default
  - Given: a default-config SDK
  - When: `smooth_turn_compression` derives
  - Then: the prompt name in the model call matches the new template, not `lower-band-v1`

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `turns` because `smooth_turn_compression` is a turn-shaped derivation created after turn close. The handler builds turn rendering text from resolved message-level material (already updated by Stories 1-2), then either passes tiny turns through or calls `compressSmoothTurn`.

The handler already produces two derivations (`turn_rendering` + `smooth_turn_compression`) in one outcome. This story changes the rendering text format and the compression path — the handler structure, message recovery, chunk placement, and completion-transaction mechanics stay the same.

#### Turn Rendering Improvement

Current `composeTurnRenderingText` is `parts.map(p => p.text).join(" | ")`. This loses all structure — the compression model can't distinguish a user prompt from a tool result from assistant thinking.

The replacement should produce a structured rendering where each part is labeled by kind. The exact format is an implementation decision, but it should:
- Label each part's message kind (user prompt, assistant response, tool activity, thinking, runtime note)
- Preserve part ordering
- Be readable by the compression model as structured input, not a flat run-on
- Be deterministic (same parts → same text)

The `RenderingPart` already carries `kind`, `text`, `fallback`, `outcome`, and `blocks`. The composition function has everything it needs.

#### Tiny-Turn Guard

The handler checks `estimateTokens(renderingText)` against `run.config.guards.smoothTurnCompression.tinyTurnTokens` (default 80). Below the threshold: store the rendering text as `smooth_turn_compression` directly with no `compressSmoothTurn` call. The `turn_rendering` derivation is still produced — only the compression is skipped.

#### Target Ratio Config Plumbing

The handler needs target ratios to compute concrete target tokens and `sizeDisposition`. Today, target ratios live in `inference.assignments` and are invisible to the handler — `ResolvedSdkConfig` doesn't expose them, and direct-callback hosts have no assignments at all.

Resolution (same pattern as Story 1's guard consolidation):

1. **Add resolved compression targets to `ResolvedSdkConfig`** — e.g. `compressionTargets: { minRatio: number; aimRatio: number; maxRatio: number }`. Populated from `DEFAULT_INFERENCE_ASSIGNMENTS.smooth_turn_compression` target ratios (0.35/0.50/0.65) at construction, overridable by `inference.assignments` if provided. Direct-callback hosts get the defaults.
2. **Handler reads `run.config.compressionTargets`**, computes concrete target tokens: `inputTokens × minRatio`, `inputTokens × aimRatio`, `inputTokens × maxRatio`.
3. **Handler passes concrete targets on the callback input** — both direct-callback hosts and the adapter receive the same numbers.
4. **Handler computes `sizeDisposition`** from the same concrete targets.

#### Callback Signature Extension

The `compressSmoothTurn` input extends from `{ rendering: string }` to:

```
{
  rendering: string;
  inputTokens: number;
  targetMinTokens: number;
  targetAimTokens: number;
  targetMaxTokens: number;
}
```

Both direct-callback hosts and the adapter see the same concrete token targets. The prompt template uses these concrete numbers directly — no ratio math in the template. The adapter's existing `withTargetRatios` still injects the raw ratios alongside (the prompt can use either), but the concrete targets are the primary contract.

#### Prompt Replacement

The current `lower-band-v1` prompt is untuned: "80 words maximum" with no target ratios. The replacement prompt (e.g. `smooth-turn-compression-v1`) should:

- Receive concrete target token numbers (`targetMinTokens`, `targetAimTokens`, `targetMaxTokens`) and `inputTokens`
- Name what to preserve: user decisions, corrections, preferences; agent actions, mistakes, commitments; useful thinking outcomes; useful tool outcomes; concrete paths, commands, errors, test results, commits; unresolved questions and blocked work
- Name what to drop: conversational filler, repeated acknowledgements, apologies, status chatter, raw thinking text, raw tool output noise, low-value mechanics
- Not prescribe a word count — use the concrete token targets

#### Size Disposition

After inference, the handler computes `estimateTokens(output)` (it already does this at line 304 for chunk placement). It compares against the target range and stamps `sizeDisposition` on the derivation metadata:
- `"in_range"` if within [min, max]
- `"under_min"` if below min
- `"over_max"` if above max

Out-of-range output is accepted and lands `ready` — it is not retried or discarded. The disposition is observability, not a gate.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The rendering format change is deterministic and testable with fixture turns. The guard and disposition are simple checks. The prompt change is structural (new template, new default), not behavioral.

Risk Reminders:
- The rendering format change affects every existing test that asserts on `turn_rendering` content (they currently expect `" | "` joins). Update them, don't suppress them.
- The tiny-turn guard must store the rendering text as `smooth_turn_compression`, not as `turn_rendering` — the two are different derivations.
- `sizeDisposition` must be persisted in derivation metadata, not only logged.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Target ratio config | `src/shared-tech/derivation.ts` — add `compressionTargets: { minRatio, aimRatio, maxRatio }` to `ResolvedSdkConfig`; add `sizeDisposition?: string` to `DerivationMetadata` (it does not exist today) |
| SDK construction | `src/sdk.ts` — resolve compression targets from assignment ratios onto `ResolvedSdkConfig.compressionTargets`; update `DEFAULT_PROMPT_NAMES` and `DEFAULT_INFERENCE_ASSIGNMENTS` for `smooth_turn_compression` |
| Turn rendering composition | `src/turns/internal/derive.ts` — replace `composeTurnRenderingText` with a structured format |
| Turn derivation handler | `src/turns/internal/derive.ts` — add tiny-turn guard, compute concrete target tokens from `run.config.compressionTargets`, add `sizeDisposition` metadata |
| Callback signature | `src/shared-tech/derivation.ts` — extend `compressSmoothTurn` input to `{ rendering, inputTokens, targetMinTokens, targetAimTokens, targetMaxTokens }` |
| Prompt template | `src/shared-tech/prompts/smooth-turn-compression-v1.ts` — new template consuming concrete target tokens and substance-preservation instructions |
| Prompt registry | `src/shared-tech/prompts/index.ts` — register new template, update default prompt name |
| Old prompt | `src/shared-tech/prompts/lower-band-v1.ts` — keep as historical |
| Deterministic callbacks | `src/shared-tech/deterministic.ts` — update `compressSmoothTurn` double to match new input |
| Test doubles | `test/fixtures/inference-callbacks-double.ts` — update to match new input |
| Tests | `test/smooth-turn-compression.test.ts` — guard, rendering format, prompt, disposition |
| Existing tests — rendering format | `test/turn-cascade.test.ts` — 7 assertions using `renderingContent().split(" | ")` (lines ~101, 126, 156, 184, 280, 307, 554) must update to the new structured format |
| Existing tests — segment labels | `test/runtime-change-typing.test.ts:111-116` — asserts on specific segment labels (`model_change X -> Y`, `thinking_level_change A -> B`) within the rendering; the new format must preserve these labels or the test must be rewritten to match |
| Existing tests — chunk-detailed content | `test/derivation-turns.test.ts:478,483` — asserts `chunk_summary_detailed` equals `memberProjections.join(" | ")` where `memberProjections` is `smooth_turn_compression` content. These break because `smooth_turn_compression` content changes (tiny turns store the new structured rendering; inference produces new compressed output). This is cross-story coupling — update these assertions to match the new content without mistaking them for Story 4 chunk-concat-format work |

#### Derivation Testing References

- `derivation-testing/lower_band_projection/prompt-baseline-v1.md` — the tested compression prompt text
- `derivation-testing/lower_band_projection/set-a.jsonl` through `set-c.jsonl` — fixture turns for compression testing

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-3.1a | `smooth-turn-compression.test.ts` | Turn under 80 tokens: zero `compressSmoothTurn` calls, rendering text stored as `smooth_turn_compression`, `ready`. |
| TC-3.1b | `smooth-turn-compression.test.ts` | Custom threshold 200, 150-token turn: inference skipped. |
| TC-3.2a | `smooth-turn-compression.test.ts` | Multi-message turn: rendering text contains message-kind markers. |
| TC-3.2b | `smooth-turn-compression.test.ts` | Parts appear in message order in the rendering text. |
| TC-3.3a | `smooth-turn-compression.test.ts` | 1000-token turn with default ratios: model spy input includes `inputTokens` and computed target min/aim/max. |
| TC-3.3b | `smooth-turn-compression.test.ts` | Rendered prompt includes substance-preservation and noise-removal instructions. |
| TC-3.4a | `smooth-turn-compression.test.ts` | Model returns within target range: `sizeDisposition: "in_range"` in persisted metadata. |
| TC-3.4b | `smooth-turn-compression.test.ts` | Model returns above max: `sizeDisposition: "over_max"` in persisted metadata, state still `ready`. |
| TC-3.5a | `smooth-turn-compression.test.ts` | Default-config SDK: model spy call uses the new prompt name, not `lower-band-v1`. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Tiny-turn guard stores on wrong derivation type | `smooth-turn-compression.test.ts` | Below-threshold turn: assert `smooth_turn_compression` has the rendering text AND `turn_rendering` also has it (both derivations produced). | A guard that skips inference but forgets to produce the rendering derivation would pass if only `smooth_turn_compression` is checked. |
| Rendering format change breaks existing turn_rendering tests | Existing test files | All tests asserting `turn_rendering` content should be updated to the new format, not suppressed. | A test that pins `" | "` would break silently if the rendering changes but the test is deleted instead of updated. |
| `sizeDisposition` only logged, not persisted | `smooth-turn-compression.test.ts` | Read derivation metadata through the domain surface and assert `sizeDisposition` is present. | A test checking handler return values could pass while the metadata is lost in the completion transaction. |

#### Technical Notes

- Default `tinyTurnTokens` is 80 (from `DEFAULT_GUARDS`).
- Default target ratios are `targetMinRatio: 0.35`, `targetAimRatio: 0.50`, `targetMaxRatio: 0.65` (from `DEFAULT_INFERENCE_ASSIGNMENTS.smooth_turn_compression`).
- The handler reads `run.config.compressionTargets` and computes concrete targets: `inputTokens × ratio`. These concrete targets go on the callback input and are used for `sizeDisposition`.
- The adapter's `withTargetRatios` still injects the raw ratios alongside the concrete targets — the prompt template should use the concrete numbers.
- The tiny-turn guard reads from `run.config.guards.smoothTurnCompression.tinyTurnTokens` — the same guard path Story 1 established.
- Tiny-turn passthrough writes no `sizeDisposition` — it is a passthrough, not a compression result. Tiny-turn `smooth_turn_compression` content is the structured rendering text (with message-kind markers), not prose. Consumers reading `smooth_turn_compression` for a tiny turn will see markers. This affects Story 4's chunk_summary_detailed, which concatenates `smooth_turn_compression` texts — a tiny turn in a chunk contributes structured-marker text. Story 4 should be aware of this.
- `composeTurnRenderingText` is the only function that needs to change for the rendering format. The `RenderingPart` type already carries `kind` and the handler already receives `parts` from `composeRenderingInput`. The change is contained.
- `lower-band-v1.ts` stays in the prompts directory as a historical file. The default prompt name for `smooth_turn_compression` changes in `DEFAULT_PROMPT_NAMES` and `DEFAULT_INFERENCE_ASSIGNMENTS`.
- The turn handler already computes `estimateTokens(projection.text)` at line 304 for chunk placement. The `sizeDisposition` computation reuses this value.

#### Anti-Shim Requirements

- Assert the model spy receives the rendering text with structure (not a flat `" | "` join) and target token information.
- Assert tiny-turn produces both `turn_rendering` and `smooth_turn_compression` derivations, not just one.
- Assert `sizeDisposition` is persisted in derivation metadata, not just in handler return values.
- Assert chunk placement token count is from the `smooth_turn_compression` output, not the rendering text (existing behavior, but verify it doesn't regress).

#### Production Path Proof

- Entrypoint: turn-close queued derivation handled by `turns/internal/derive.ts`.
- Guard path: rendering text below `tinyTurnTokens` stores directly as both derivations, no `compressSmoothTurn` call.
- Inference path: rendering text above threshold → `compressSmoothTurn` with target tokens → output stamped with `sizeDisposition` → placement uses output token count.
- Evidence: `smooth-turn-compression.test.ts` uses real handlers with model spy and real temp SQLite.

#### Source/Derived State Risk

- Source truth is the closed turn and its member messages (and their derivations, already updated by Stories 1-2).
- The rendering text is deterministic from the source material — same messages produce the same rendering.
- `smooth_turn_compression` is the inference output (or the rendering text for tiny turns). `sizeDisposition` is observability metadata.
- Chunk placement reads `smooth_turn_compression` token count. A rendering format change that affects token counts will shift chunk boundaries — this is expected and correct (the stored token count is from the compression output, not the rendering).

#### Integration Tests

Add to the real-inference suite in `inference-real.test.ts`:

- **Real compression with target ratios:** Send a multi-message turn above the tiny-turn threshold (prompt + assistant + tool call + tool result + turn_end). Assert `smooth_turn_compression` lands `ready` with non-empty real model content, real provenance, `sizeDisposition` metadata present, and provenance prompt name matching the new template.
- **Tiny-turn passthrough:** Send a minimal turn (short prompt + short response + turn_end) under the threshold. Assert `smooth_turn_compression` lands `ready` with no `compressSmoothTurn` model call (other message-level calls may still occur) and content equal to the rendering text. No `sizeDisposition` metadata.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run verify`
- Epic gate: `pnpm run verify:all`

#### Spec Deviations

- **Numbering:** ACs renumbered from 1.x to 3.x. This is Story 3 in the updated sequence.
- **Message recovery (AC-1.6 in original):** Already implemented and updated by Stories 1-2. Not re-specified here — the handler's `recoverMessageDerivations` call is unchanged.
- **Failed compression recovery (AC-1.7 in original):** Already implemented. The handler returns `inferenceFailed(projection)` which records `failed` state through the normal handler failure path. Consumer-time recovery is handled by the compact fallback ladders. Not re-specified.
- **Turn rendering improvement:** Not in the original story. Added because the crude `" | "` join produces low-quality input for a tuned compression prompt. GPT flagged this in the analysis as "the text quality is probably too poor for tuned compression."
- **Verification scripts:** Story gate is `pnpm run verify`. Epic gate is `pnpm run verify:all`.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- `ResolvedSdkConfig.compressionTargets` carries resolved target ratios, populated for both inference-config and direct-callback hosts.
- Tiny turns (below `tinyTurnTokens` threshold) skip `compressSmoothTurn` and land `ready` with rendering text as content. No `sizeDisposition` metadata for passthrough.
- Both `turn_rendering` and `smooth_turn_compression` are produced for tiny turns.
- Turn rendering text has structured message-kind markers, not a flat `" | "` join.
- `compressSmoothTurn` callback input carries `inputTokens`, `targetMinTokens`, `targetAimTokens`, `targetMaxTokens` as concrete numbers.
- Compression prompt includes concrete target token numbers and substance-preservation instructions.
- Default prompt for `smooth_turn_compression` points to the new template, not `lower-band-v1`.
- `sizeDisposition` is persisted in derivation metadata for all inference-backed compressions.
- Out-of-range output lands `ready` (accepted, not retried).
- Existing tests in `turn-cascade.test.ts`, `runtime-change-typing.test.ts`, and `derivation-turns.test.ts` updated to the new rendering format (not suppressed).
- Real-inference integration test covers compression with target ratios and tiny-turn passthrough.
- `pnpm run verify` passes.
