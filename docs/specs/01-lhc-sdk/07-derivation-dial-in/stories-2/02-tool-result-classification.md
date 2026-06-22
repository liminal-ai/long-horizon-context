# Story 2: Tool-Result Classification and Prompt-Mode Routing

### Summary
<!-- Jira: Summary field -->

Add a deterministic classifier that parses mechanical facts from tool results before inference, route to prompt modes based on classification, and remove the large-result inference skip.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `initLhc`.

**Objective:** The model should not infer mechanical facts (exit code, path, byte count, match count, failure type, system error). Parse those facts deterministically first, pass them as authoritative to the prompt, and let the model write a concise receipt from facts plus an excerpt of the raw output. Route to different prompt modes based on the tool result's operation class and response shape.

**Scope In:** Deterministic classifier/parser, prompt-mode routing, extended `summarizeToolResult` input, replacement prompt template, removal of large-result inference skip, `guards.toolResultSummary.timeoutMs` wiring.

**Scope Out:** No changes to `smoothed_prompt`, `smooth_turn_compression`, or chunk derivations. No changes to the visibility boundary's deterministic truncation of tool results in the tail (that is a separate concern from `tool_result_summary`). No deterministic-only summary templates for receipt-shaped results (future optimization noted in the derivation testing, not this story).

**Dependencies:** Story 1 (guard config on `ResolvedSdkConfig.guards`).

**Architecture Constraints:** This is message-derivation behavior owned by `messages`. The classifier is a pure function with no inference calls. It lives in `messages/internal/` because it is tool-result-derivation logic, not shared-tech.

**Current State:**
- Small tool results (≤ `smallTierTokens` = 1000 tokens): stored as-is, no model call.
- Large tool results (> `largeTierTokens` = 5000 tokens): `truncateForFallback(content)` deterministically, no model call. **This skips inference entirely.**
- Mid tool results: call `summarizeToolResult` with generic `toolResultGuidance` based on tool name string matching.
- `toolResultGuidance` has three heuristic buckets (read/fetch, search/grep, exec/shell) plus a generic fallback — no parsed facts, no classification.
- `summarizeToolResult` signature: `{ toolName, content, outcome, targetTokens, guidance }`.
- The adapter already bounds input via `maxInputChars` (default 200,000) on all inference calls.
- `guards.toolResultSummary.timeoutMs` exists on `ResolvedSdkConfig.guards` (default 60,000ms) but the handler does not read it — timeout is global via the adapter's `safeCall`.
- The recovery path in `turns/internal/derive.ts` duplicates the same three-tier logic (small/large/mid).
- Current prompt template `tool-result-v1` is generic and untuned.

**Derivation Testing Reference:**
A reference classifier, prompt shape, and fixture sets exist in `derivation-testing/tool_result_summary/`. The classifier covers 9 operation classes, 11 response shapes, and 10 prompt modes. The prompt shape includes authoritative parsed facts, mode-specific guidance, and standing instructions that prevent model leakage of parser labels and unsupported diagnosis. The reference implementation is in JavaScript (`.mjs`); this story ports the classifier into TypeScript within `messages/internal/`.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-2.1:** A deterministic classifier produces an operation class, response shape, prompt mode, and parsed facts for every tool result before any model call.

- **TC-2.1a:** Classifier runs before inference
  - Given: a tool result message
  - When: the handler processes it
  - Then: the classifier runs first; the model call (if any) receives the classification and parsed facts as input
- **TC-2.1b:** Operation classes cover the tested categories
  - Given: tool results from read, write, edit, bash (with grep/vitest/git diff variants), and multi_tool_use.parallel
  - When: classified
  - Then: each produces the expected operation class (read, mutation_write, mutation_edit, search_or_listing, verification, vcs_inspection, command, multi_tool, etc.)
- **TC-2.1c:** Parsed facts are deterministic
  - Given: the same tool result content
  - When: classified twice
  - Then: identical facts are produced

**AC-2.2:** Parsed facts are authoritative and passed to the model. The model does not infer exit codes, paths, byte counts, match counts, failure types, or system errors.

- **TC-2.2a:** Facts appear in prompt input
  - Given: a bash tool result with exit code 127 and "command not found"
  - When: the model call is made
  - Then: the prompt input includes parsed facts with `exitCode: 127`, `failureType: "command_not_found"`, `missingCommand: "<name>"`, and `retryGuidance`
- **TC-2.2b:** Standing instructions present
  - Given: any classified tool result sent to inference
  - When: the prompt is rendered
  - Then: the prompt includes instructions to use parsed field values without mentioning field labels, and to avoid diagnostic conclusions beyond what facts support

**AC-2.3:** The prompt mode changes based on the response shape, selecting mode-specific guidance for the model.

- **TC-2.3a:** Receipt-shaped result uses receipt mode
  - Given: a write tool result "Successfully wrote 1234 bytes to path/file.ts"
  - When: classified
  - Then: prompt mode is `receipt` and the model call receives receipt-specific guidance
- **TC-2.3b:** Test output uses test_summary mode
  - Given: a bash verification result with pass/fail counts and assertion errors
  - When: classified
  - Then: prompt mode is `test_summary` and the model call receives test-specific guidance

**AC-2.4:** Large tool results flow through to inference instead of being skipped. The adapter's existing `maxInputChars` bounding handles the input size. The `largeTierTokens` threshold no longer skips inference; it may influence target token calculation but does not gate whether the model is called.

- **TC-2.4a:** Large result reaches inference
  - Given: a tool result above `largeTierTokens` (5000 tokens)
  - When: the handler processes it
  - Then: a model call is made (the adapter bounds the input); the result is not deterministically truncated and stored without inference
- **TC-2.4b:** Adapter bounding applies
  - Given: a very large tool result (200,000+ characters)
  - When: the model call is made
  - Then: the adapter's `maxInputChars` truncates the raw content before the prompt is rendered

**AC-2.5:** The `summarizeToolResult` callback signature is extended to include the classification output.

- **TC-2.5a:** Extended signature
  - Given: the updated `InferenceCallbacks.summarizeToolResult`
  - When: a classified tool result is passed to inference
  - Then: the input includes `operationClass`, `responseShape`, `promptMode`, and `facts` alongside the existing `toolName`, `content`, `outcome`, `targetTokens`
- **TC-2.5b:** `guidance` field retired
  - Given: the updated signature
  - When: the model call is made
  - Then: `guidance` is no longer a separate field; prompt-mode-specific guidance is rendered by the prompt template from `promptMode`

**AC-2.6:** The prompt template `tool-result-v1` is replaced with a classification-aware template that renders mode-specific guidance from the prompt mode and includes parsed facts and standing instructions.

- **TC-2.6a:** New prompt renders facts and mode guidance
  - Given: a classified tool result with prompt mode `failure` and parsed facts
  - When: the prompt template renders
  - Then: the rendered prompt includes the parsed facts as authoritative, mode-specific guidance for failures, and standing instructions

**AC-2.7:** The recovery path in `turns/internal/derive.ts` uses the same classifier and extended signature.

- **TC-2.7a:** Recovery path classifies
  - Given: a closed turn with a tool result whose `tool_result_summary` is pending
  - When: the recovery path runs during turn derivation
  - Then: the tool result is classified before inference, and the model call receives the classification

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `messages` because `tool_result_summary` is a message-level derivation. The classifier is a pure function — no model calls, no database access, no side effects. It takes a tool name, tool input (if available), outcome, and raw output, and returns classification + parsed facts.

The reference implementation exists in `derivation-testing/tool_result_summary/lib/classify.mjs`. This story ports it to TypeScript in `messages/internal/classify-tool-result.ts`, adapting it to the LHC types. The port should preserve the classifier's logic and coverage, adapting only for TypeScript types and the LHC `ToolOutcome` type.

#### Classifier Shape

The classifier produces:

```
{
  operationClass: string,   // read, mutation_write, mutation_edit, command, search_or_listing,
                             // verification, vcs_inspection, filesystem_mutation, multi_tool, unknown
  responseShape: string,     // structured_receipt, simple_failure, no_output, search_result,
                             // test_result, file_content, large_file_content, diff_output,
                             // large_log, multi_tool_result, unknown_content
  promptMode: string,        // receipt, failure, no_output, search_summary, test_summary,
                             // content_summary, diff_summary, large_log, multi_tool_summary,
                             // generic_summary
  facts: Record<string, unknown>  // deterministic parsed facts: exitCode, targetPath, byteCount,
                                   // matchCount, failedField, missingCommand, systemError,
                                   // testSummary, searchMatches, retryGuidance, etc.
}
```

The classifier input needs the tool name, the raw tool output, the outcome (`succeeded` / `failed` / `unknown`), and optionally the tool input (for bash command parsing). The tool input is available from the paired tool_call message's block content.

#### Large-Result Policy Change

Current behavior: tool results above `largeTierTokens` are deterministically truncated and stored as ready with no model call.

New behavior: all tool results flow through the classifier. The classifier's response shape (e.g. `large_file_content`, `large_log`) informs the prompt mode, but does not skip inference. The adapter's existing `maxInputChars` bounding truncates the raw content before the prompt is rendered. The small-result passthrough (≤ target tokens) remains — small results are already concise and don't need summarization.

#### Prompt Template Replacement

The current `tool-result-v1` template is generic. The new template (e.g. `tool-result-v2`) renders from the classification:

- Parsed facts as an authoritative JSON block in the system message
- Mode-specific guidance selected by `promptMode`
- Standing instructions:
  - Use parsed field values, but do not mention parsed field labels
  - Preserve paths, commands, identifiers, counts, and exit codes verbatim
  - Do not quote or label the raw response
  - Do not add diagnostic conclusions, root-cause analysis, or recommended code changes beyond what parsed fields or raw response directly support
- Raw tool output (bounded by the adapter)

Fields excluded from the prompt to prevent leakage into summaries: `operationClass`, `responseShape`, `outputChars`, `outputWords`.

#### Recovery Path

The recovery path in `turns/internal/derive.ts` (`recoverMessageDerivations`) has its own inline tool-result handling that duplicates the three-tier logic. This story extracts the classify-and-call pattern into a shared function (following the `deriveSmoothedPrompt` pattern from Story 1) so both sites use the same classifier and signature.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The classifier is a pure function with extensive testable scenarios. Tests should cover each operation class, response shape, and fact extraction path independently. The prompt wiring and large-result policy change are handler-level tests.

Risk Reminders:
- The classifier must handle missing/malformed tool output gracefully — empty strings, unexpected formats, extremely long outputs.
- Fact extraction must not throw on any input. Unparseable fields return null, not errors.
- The prompt must not include `operationClass`, `responseShape`, `outputChars`, or `outputWords` — these caused model leakage in testing.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Classifier | `src/messages/internal/classify-tool-result.ts` — new file, ported from `derivation-testing/tool_result_summary/lib/classify.mjs` |
| Tool-result handler | `src/messages/internal/handlers.ts` — replace three-tier logic with classify → call, remove `toolResultGuidance`, remove large-result inference skip |
| Recovery bridge | `src/messages/recovery.ts` — export the shared classify-and-call function for turns recovery |
| Turn recovery path | `src/turns/internal/derive.ts` — use the shared classify-and-call function instead of inline three-tier logic |
| Callback signature | `src/shared-tech/derivation.ts` — extend `summarizeToolResult` input with `operationClass`, `responseShape`, `promptMode`, `facts`; remove `guidance` |
| Prompt template | `src/shared-tech/prompts/tool-result-v2.ts` — new template rendering from classification; update `index.ts` to register it and update default prompt name |
| Old prompt | `src/shared-tech/prompts/tool-result-v1.ts` — keep the file (historical), but the default assignment no longer points to it |
| Adapter | `src/shared-tech/inference-adapter.ts` — ensure the adapter passes through the new fields to the prompt template |
| Tests | `test/tool-result-classification.test.ts` — classifier unit tests; `test/tool-result-summary.test.ts` — handler integration tests |

#### Derivation Testing References

The following files in `derivation-testing/tool_result_summary/` inform this story:

- `tool-result-summary-writeup.md` — design conclusions, prompt lessons, classifier shape, model comparisons
- `lib/classify.mjs` — reference classifier implementation (9 operation classes, 11 response shapes, 10 prompt modes, ~20 parsed fact fields)
- `lib/prompt.mjs` — reference prompt rendering with mode-specific guidance and standing instructions
- `classifier-coverage-notes.md` — coverage gaps and remaining scenarios
- `set-a.jsonl` through `set-g-stress.jsonl` — fixture sets covering receipts, failures, searches, tests, diffs, large logs, multi-tool results

Key prompt lessons from testing (must be preserved in the new template):
- Use semantic fact names, not parser-shaped names — parser labels like `fullTarget` leaked into model output
- Do not pass diagnostic-only metrics (`outputChars`, `outputWords`) into the prompt — models include them in summaries
- Standing instruction "do not add diagnostic conclusions" prevents models from adding root-cause analysis
- The instruction "use parsed field values, but do not mention parsed field labels" is essential for Qwen and helpful for all models

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.1a | `tool-result-summary.test.ts` | Handler classifies before model call; model spy receives classification in input. |
| TC-2.1b | `tool-result-classification.test.ts` | Each operation class maps correctly from tool name / command patterns. |
| TC-2.1c | `tool-result-classification.test.ts` | Same input produces identical classification on repeated calls. |
| TC-2.2a | `tool-result-summary.test.ts` | Bash exit-127 result: model spy input includes `exitCode: 127`, `failureType: "command_not_found"`. |
| TC-2.2b | `tool-result-summary.test.ts` | Rendered prompt includes standing instructions (no field labels, no diagnostic conclusions). |
| TC-2.3a | `tool-result-classification.test.ts` | Write success receipt classifies as `receipt` prompt mode. |
| TC-2.3b | `tool-result-classification.test.ts` | Bash verification output classifies as `test_summary` prompt mode. |
| TC-2.4a | `tool-result-summary.test.ts` | Tool result above `largeTierTokens`: model call is made, not deterministically truncated. |
| TC-2.4b | `tool-result-summary.test.ts` | Very large tool result: adapter bounds input; prompt template receives bounded content. |
| TC-2.5a | `tool-result-summary.test.ts` | Model spy call includes `operationClass`, `responseShape`, `promptMode`, `facts` in input. |
| TC-2.5b | `tool-result-summary.test.ts` | Model spy call does not include `guidance` as a separate field. |
| TC-2.6a | `tool-result-summary.test.ts` | Rendered prompt for a `failure` mode includes parsed facts and failure-specific guidance. |
| TC-2.7a | `tool-result-summary.test.ts` | Recovery path: closed turn with pending tool_result_summary, `turns.deriveTurn` classifies and sends classification to model. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Classifier throws on malformed input | `tool-result-classification.test.ts` | Empty string, null-ish fields, extremely long output: classifier returns valid classification, never throws. | ACs test happy paths; a throw in the classifier would crash the handler. |
| Prompt leaks parser field names | `tool-result-summary.test.ts` | Rendered prompt does not contain `operationClass`, `responseShape`, `outputChars`, `outputWords` in the user-visible content. | The AC says facts are authoritative; it doesn't check that diagnostic fields are excluded from the prompt. |
| Recovery path still uses old three-tier logic | `tool-result-summary.test.ts` | Recovery path for a large tool result calls inference (not truncateForFallback). | The handler could be correct while the recovery path still skips inference for large results. |

#### Technical Notes

- The classifier needs access to the paired tool_call's `toolInput` (specifically the `command` field for bash classification). The handler already reads the paired tool call via `findPairedToolCall`. The classifier receives `toolInput` as an optional field.
- The `toolResultGuidance` function in `handlers.ts` is retired — prompt-mode-specific guidance moves into the prompt template.
- The `toolResultTargetTokens` function stays — it computes the target token count from the tier config, which the prompt still needs.
- Small-result passthrough stays: tool results whose token count ≤ target tokens are stored as-is with no model call. The classifier still runs (the classification could be useful for metadata), but no inference is called.
- `tool-result-v1.ts` stays in the prompts directory as a historical file but is no longer the default assignment. The default prompt name for `tool_result_summary` changes to `tool-result-v2` in `DEFAULT_PROMPT_NAMES` and `DEFAULT_INFERENCE_ASSIGNMENTS`.

#### Anti-Shim Requirements

- Assert the model spy receives classification fields in the input, not just that the handler returns the right content.
- Assert no `guidance` field in the model call input.
- Assert large results reach inference (model spy called), not deterministically truncated.
- Assert the prompt does not contain excluded diagnostic fields.
- The classifier must not import from shared-tech or other domains — it is a pure `messages/internal/` module.

#### Production Path Proof

- Entrypoint: message-level `tool_result_summary` derivation work handled by `messages/internal/handlers.ts`.
- Classifier path: handler calls `classifyToolResult` → receives classification → passes to `summarizeToolResult` callback → adapter renders prompt from `tool-result-v2` template with classification fields.
- Recovery path: `turns/internal/derive.ts` recovery calls the same shared function exported through `messages/recovery.ts`.
- Evidence: `tool-result-classification.test.ts` (pure classifier), `tool-result-summary.test.ts` (handler + recovery integration with model spy and real temp SQLite).

#### Source/Derived State Risk

- Source truth remains the message content (the raw tool result).
- Derived state is the summary text plus metadata (outcome, classification).
- The classifier's parsed facts are not stored as derivation content — they are input to the model call. The model's output is what gets stored.
- Classification metadata (operation class, prompt mode) could optionally be stored in `DerivationMetadata` for observability, but this is not required by the ACs.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run verify`
- Epic gate: `pnpm run verify:all`

#### Spec Deviations

- **Numbering:** ACs renumbered from 5.x to 2.x. This is Story 2 in the updated sequence.
- **Large-result policy:** The original spec described excerpting as a new mechanism. The implementation relies on the adapter's existing `maxInputChars` bounding — no new excerpt mechanism is needed.
- **Timeout:** `guards.toolResultSummary.timeoutMs` exists but the current adapter applies a global timeout via `safeCall`. Per-handler timeout override is not implemented in this story unless the adapter already supports per-call timeout. If it doesn't, the guard value serves as documentation of the intended per-handler timeout and can be wired when the adapter supports it.
- **Design references:** The old stories referenced tech-design.md line numbers. That document is stale after the refactor. This story references the derivation testing findings directly.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Deterministic classifier produces operation class, response shape, prompt mode, and parsed facts for every tool result.
- Classifier is a pure function in `messages/internal/` — no inference, no database, no throws on any input.
- Parsed facts are passed to the model as authoritative input.
- Prompt renders mode-specific guidance based on `promptMode`.
- Prompt excludes `operationClass`, `responseShape`, `outputChars`, `outputWords` from model-visible content.
- Standing instructions (no field labels, no diagnostic conclusions) are in the prompt template.
- Large tool results flow through to inference instead of being deterministically truncated and skipped.
- `summarizeToolResult` signature includes classification fields; `guidance` is removed.
- Default prompt name for `tool_result_summary` points to `tool-result-v2`.
- Recovery path uses the same classifier and extended signature.
- `pnpm run verify` passes.
