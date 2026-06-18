# Story 2: Tool-Result Classification and Prompt-Mode Routing

### Summary
<!-- Jira: Summary field -->

Add deterministic classification, prompt-mode selection, excerpting, and timeout handling before `tool_result_summary` inference.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `createSdk`.

**Objective:** Shape tool-result summary inputs with parsed mechanical facts and response-specific prompt modes before the model call.

**Scope In:** Flow 5 AC-5.1 through AC-5.5.

**Scope Out:** No model-call function contract change, no per-tool exhaustive guidance, no state model change.

**Dependencies:** Story 0; timeout and excerpt threshold config are available.

**Architecture Constraints:** Tool-result classification is message-derivation behavior owned by `messages`. The classifier is deterministic: same input yields same classification, no model call, no randomness, no clock dependency.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-5.1:** Before model inference, the classifier deterministically extracts mechanical facts from the tool response: tool name, outcome, and available structured fields (exit code, target path, counts, failure type).

- **TC-5.1a:** Facts extracted
  - Given: an edit-failure tool response ("Found 2 occurrences of edits[0]...")
  - When: the classifier runs
  - Then: extracted facts include tool name, outcome=failed, target path, match count=2, and failure type
- **TC-5.1b:** Success receipt parsed
  - Given: a write-success response ("Successfully wrote 1234 bytes to path/file.ts")
  - When: the classifier runs
  - Then: extracted facts include tool name, outcome=succeeded, target path, and byte count

**AC-5.2:** The classifier selects a prompt mode based on the response shape; different response types receive different model instructions.

- **TC-5.2a:** Receipt vs content mode
  - Given: an edit-success receipt and a large file-read response
  - When: the classifier classifies each
  - Then: the receipt receives a receipt-mode prompt and the read receives a content-summary-mode prompt

**AC-5.3:** Large tool responses are excerpted before the model call to bound input size.

- **TC-5.3a:** Large response excerpted
  - Given: a tool response exceeding the configured excerpt threshold
  - When: the classifier prepares the model input
  - Then: the raw output is excerpted (not passed in full) and the excerpting is noted in the model input

**AC-5.4:** A hard timeout aborts model calls that exceed the configured limit; the timeout produces a classified failure, not an unhandled exception.

- **TC-5.4a:** Timeout classified
  - Given: a model call that would exceed the timeout
  - When: the timeout fires
  - Then: the call is aborted and the failure is classified as `timeout` (retryable)

**AC-5.5:** Parsed mechanical facts are authoritative in the model input; the model is instructed not to infer success/failure from prose when parsed outcome is available.

- **TC-5.5a:** Parsed outcome authoritative
  - Given: a tool response where the text says "error" but the parsed outcome is succeeded
  - When: the model receives the input
  - Then: the parsed outcome is presented as authoritative and the model is instructed to use it

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `messages` because `tool_result_summary` is a message-level derivation. The classifier is a pure deterministic function that runs before inference and produces authoritative facts plus a prompt mode for the model input.

Large raw outputs are still summarized by inference after excerpting. There is no large-result deterministic skip tier. Timeout handling wraps the model call and records a classified timeout failure instead of leaking an unhandled exception.

#### Build Strategy

Strategy: tdd-lite

Reason:
- Classifiers are easy to make pass a few examples while drifting later. Start with golden cases and handler-boundary tests that prove the classifier output reaches the serialized provider input.

Risk Reminders:
- The classifier must not use DB, model calls, clock, or randomness.
- Timeout must go through `AbortController` and land as a classified derivation failure.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Classifier | `src/messages/internal/classify-tool-result.ts` |
| Tool result handler | `src/messages/internal/handlers.ts` |
| Prompt rendering | `src/shared-tech/prompts/tool-result-v1.ts`, `src/shared-tech/inference-adapter.ts` |
| Config | `src/shared-tech/inference-types.ts`, `src/sdk.ts` |
| Tests | `tool-result-classifier.test.ts`, `tool-result-summary.test.ts` |

#### Design References

- [tech-design.md §TDQ-3: Tool-result classifier placement](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:78), lines 78-80
- [tech-design.md §TDQ-4: Excerpt strategy](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:82), lines 82-86
- [tech-design.md §Flow 5: Tool-Result Classification](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:589), lines 589-689
- [tech-design.md §Deterministic Algorithm Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:1114), lines 1114-1122
- [test-plan.md §Flow 5: Tool-Result Classification](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:76), lines 76-85
- [test-plan.md §Golden Cases for Deterministic Algorithms](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:141), lines 141-182

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-5.1a | `tool-result-classifier.test.ts` | Classify failure output and extract failed outcome, path/count facts, and failure type. |
| TC-5.1b | `tool-result-classifier.test.ts` | Classify write success and extract succeeded outcome, target path, and byte count. |
| TC-5.2a | `tool-result-classifier.test.ts` | Different response shapes choose different prompt modes and same input maps to same mode. |
| TC-5.3a | `tool-result-summary.test.ts` | Over-limit raw output is passed as a head/tail excerpt with marker, not full content. |
| TC-5.4a | `tool-result-summary.test.ts` | Non-resolving provider call aborts at timeout and records timeout failure without unhandled exception. |
| TC-5.5a | `tool-result-summary.test.ts` | Provider messages contain `classification.parsedFacts` and instruct the model to treat parsed outcome as authoritative. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Classifier leaks nondeterminism | `tool-result-classifier.test.ts` | Run the same input twice and under a mocked advancing clock; assert deep-equal output. | Prompt-mode ACs can pass while a future refactor adds time/randomness. |
| Timeout becomes an unhandled async failure | `tool-result-summary.test.ts` | Use a provider spy that never resolves; assert failed derivation reason and no unhandled exception. | Timeout behavior crosses handler, abort signal, and persistence. |

#### Technical Notes

- `ToolResultClassification` contains `toolName`, `outcome`, `operationClass`, `responseShape`, `promptMode`, and `parsedFacts`.
- `responseShape` priority is fixed in the tech design; first match wins.
- `boundContent` supplies head/tail excerpting with `[... truncated ...]`.

#### Anti-Shim Requirements

- Test the pure classifier directly and the handler serialization path separately.
- Assert against actual provider spy messages, not a mocked prompt helper result.
- Keep the classifier free of DB access and model calls.

#### Production Path Proof

- Entrypoint: `tool_result_summary` derivation handler in `messages/internal/handlers.ts`.
- Registration/default path: tool result messages queue the existing message-level summary derivation; the handler calls `classifyToolResult` before provider invocation.
- Evidence: `tool-result-summary.test.ts` runs real handler/adapter code against the host `ModelCall` spy.

#### Runtime Contract Assumptions

- The host still supplies the same `ModelCall` function. LHC passes provider/model/prompt routing metadata and does not interpret host auth.
- `AbortController` is the timeout mechanism for model calls.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Classifier extracts required facts for failure and success receipt examples.
- Prompt mode differs for receipt and content responses.
- Large responses are excerpted and the model input says so.
- Timeout becomes a classified retryable failure.
- Parsed outcome is presented as authoritative in model input.
