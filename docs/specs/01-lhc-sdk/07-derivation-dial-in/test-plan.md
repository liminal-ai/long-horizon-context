# Test Plan: Epic 07 — Derivation Dial-In

**Epic:** `./epic.md`
**Tech Design:** `./tech-design.md`
**Status:** Draft

---

## Purpose

This document maps every Test Condition (TC) from the epic to a concrete test file, test name, setup, action, and assertion. It also lists architecture-risk tests that go beyond AC/TC mapping, and the golden cases for deterministic algorithms.

The test design decisions (mock boundary, test pyramid, real-inference layer) live in `./tech-design.md` §Testing Strategy. This document holds the per-TC detail.

---

## TC → Test Traceability

### Flow 0: Foundation

| TC | Test File | Test Description | Coverage Notes |
|----|-----------|------------------|----------------|
| TC-0.1a | `restructure-boundaries.test.ts` | asserts `src/intake-stream/`, `src/messages/`, `src/turns/`, `src/threads/`, `src/thread-view/`, `src/inspect/` all exist as top-level folders | filesystem check |
| TC-0.2a | `restructure-boundaries.test.ts` | asserts `src/shared-tech/` exists and contains derivation.ts, inference-adapter.ts, prompts/, work-queue/, etc. | filesystem check |
| TC-0.3a | `assignment-config.test.ts` | asserts `DERIVATION_TYPES` is not exported and `DerivationType` is not a named type | compile-time / type-level check |
| TC-0.3b | `assignment-config.test.ts` | asserts construction accepts assignments with only inference types (no `turn_rendering`, no `chunk_summary_detailed`) | partial assignment accepted |
| TC-0.4a | `restructure-boundaries.test.ts` | asserts schema DDL uses `smooth_turn_compression`; asserts no code references `lower_band_projection` as a derivation type | grep across src |
| TC-0.5a | (verify-all run) | `pnpm run verify-all` exits green | story completion gate |
| TC-0.6a | `restructure-boundaries.test.ts` | asserts no file under `src/shared-tech/` imports from any domain folder | boundary checker output |
| TC-0.6b | `restructure-boundaries.test.ts` | asserts no domain imports another domain's `internal/` modules | boundary checker output |

### Flow 1: Smooth Turn Compression

| TC | Test File | Test Description | Coverage Notes |
|----|-----------|------------------|----------------|
| TC-1.1a | `smooth-turn-compression.test.ts` | turn-close with above-threshold smooth text → provider spy records one `compressSmoothTurn` call with the smooth text | routing + input material |
| TC-1.2a | `smooth-turn-compression.test.ts` | the messages passed to the provider include `inputTokens`, `targetMinTokens`, `targetMidTokens`, `targetMaxTokens` with values computed from input size | prompt shape |
| TC-1.3a | `smooth-turn-compression.test.ts` | turn-close with smooth text ≤ 80 tokens → provider spy records zero calls; derivation lands `ready` with the smooth text verbatim | tiny-turn passthrough |
| TC-1.4a | `smooth-turn-compression.test.ts` | given a fixture with known smooth text and a canned compressed response, the stored derivation content equals the canned response | substance preserved (loose — content is canned) |
| TC-1.5a | `smooth-turn-compression.test.ts` | given a canned response, verify the handler does not append raw thinking/tool blocks to the stored content | noise removed |
| TC-1.6a | `smooth-turn-compression.test.ts` | turn-close with `smoothed_prompt` in `pending` → handler re-attempts the smoothed_prompt before compression; if recovery succeeds, compression uses recovered content | message-level recovery |
| TC-1.6b | `smooth-turn-compression.test.ts` | turn-close with `tool_result_summary` in `pending` → handler re-attempts before compression; if recovery fails, floor is used and logged | message-level recovery |
| TC-1.7a | `smooth-turn-compression.test.ts` | compression inference fails in background → derivation lands `failed` with provider reason (not `ready`) | honest failure state |
| TC-1.7b | `smooth-turn-compression.test.ts` | when a consumer (chunk close) needs compression that is `failed`, recovery writes a `ready` derivation with `floorUsed: "smooth_text"` and logs the fallback | consumer recovery |

### Flow 2: Chunk Detailed Deterministic

| TC | Test File | Test Description | Coverage Notes |
|----|-----------|------------------|----------------|
| TC-2.1a | `chunk-detailed-deterministic.test.ts` | chunk close with all members ready → provider spy records zero calls for `chunk_summary_detailed`; derivation lands `ready` | deterministic, no call |
| TC-2.2a | `chunk-detailed-deterministic.test.ts` | chunk close with one member `pending` → handler requeues with `dependency_not_ready`; derivation stays `pending` | requeue on pending |
| TC-2.2b | `chunk-detailed-deterministic.test.ts` | chunk close with one member `failed` → handler reads smooth-text floor for that member, concatenates, logs fallback per-member; derivation lands `ready` | floor for failed |
| TC-2.3a | `chunk-detailed-deterministic.test.ts` | stored detailed content contains `[turn NNNN]` markers for each member, zero-padded to four digits | turn boundaries |
| TC-2.4a | `chunk-detailed-deterministic.test.ts` | two runs of `concatenateDetailedChunk` with the same member array produce byte-identical output | determinism |

### Flow 3: Chunk Brief from Compressed Material

| TC | Test File | Test Description | Coverage Notes |
|----|-----------|------------------|----------------|
| TC-3.1a | `chunk-brief-from-detailed.test.ts` | brief handler reads the `chunk_summary_detailed` derivation text as input (not member projections); provider spy's messages contain the detailed text | input is detailed text |
| TC-3.2a | `chunk-brief-from-detailed.test.ts` | the messages passed to the provider include target token variables computed from the detailed text size | prompt includes targets |
| TC-3.3a | `chunk-brief-from-detailed.test.ts` | given a canned response in past-tense narration style, the stored derivation content equals the canned response | historical narration (loose — content is canned) |
| TC-3.4a | `chunk-brief-from-detailed.test.ts` | the rendered prompt template contains the good-example and bad-example blocks with commentary | examples in prompt |
| TC-3.5a | `chunk-brief-from-detailed.test.ts` | brief picked when detailed is `pending` → handler requeues with `dependency_not_ready` | dependency wait |

### Flow 4: Smoothed-Prompt Guards

| TC | Test File | Test Description | Coverage Notes |
|----|-----------|------------------|----------------|
| TC-4.1a | `smoothed-prompt-guards.test.ts` | message_end with user_prompt over 700 tokens → provider spy records zero smoothing calls; derivation lands `ready` with deterministic floor | over-cap skip |
| TC-4.2a | `smoothed-prompt-guards.test.ts` | construction with `guards.smoothedPrompt.maxInferenceTokens = 500` → over-cap boundary shifts to 500 | cap configurable |
| TC-4.2b | `smoothed-prompt-guards.test.ts` | construction with no guard config → default cap of 700 applies | default applied |
| TC-4.3a | `smoothed-prompt-guards.test.ts` | provider returns output with token count < 15% of input → output discarded, floor stored, `discardReason: "suspicious_output_ratio"` in derivation metadata, warning logged | suspicious output |
| TC-4.4a | `smoothed-prompt-guards.test.ts` | both over-cap skip and suspicious-output discard land derivation `ready` (not a new state); no retry queued | land ready |

### Flow 5: Tool-Result Classification

| TC | Test File | Test Description | Coverage Notes |
|----|-----------|------------------|----------------|
| TC-5.1a | `tool-result-classifier.test.ts` | `classifyToolResult` with bash exit-code-1 result → `parsedFacts` contains exitCode, `outcome: "failed"` | facts extracted |
| TC-5.1b | `tool-result-classifier.test.ts` | `classifyToolResult` with "Successfully wrote 12345 bytes to src/foo.ts" → `parsedFacts` contains byteCount=12345, targetPath, `outcome: "succeeded"` | success receipt parsed |
| TC-5.2a | `tool-result-classifier.test.ts` | structured-receipt input → `promptMode: "receipt"`; large-log input → `promptMode: "large_log"`; same input always maps to same mode | mode selection |
| TC-5.3a | `tool-result-summary.test.ts` | tool result over `maxInputChars` → provider spy's messages contain head+tail excerpt with `[... truncated ...]` marker, not the full content | large response excerpted |
| TC-5.4a | `tool-result-summary.test.ts` | provider spy configured to never resolve → `AbortController` fires at `timeoutMs`; derivation lands `failed` with timeout reason, no unhandled exception | timeout classified |
| TC-5.5a | `tool-result-summary.test.ts` | provider spy's messages contain the `classification.parsedFacts` values; prompt template uses them as authoritative input | parsed outcome authoritative |

### Flow 6: Assignment Config and Defaults

| TC | Test File | Test Description | Coverage Notes |
|----|-----------|------------------|----------------|
| TC-6.1a | `assignment-config.test.ts` | construction with `targetMinRatio`/`targetMaxRatio`/`targetAimRatio` on an assignment → accepted; stored assignment carries the ratios | target range accepted |
| TC-6.2a | `assignment-config.test.ts` | construction with no guard config → default guards filled (cap 700, suspicious 0.15, tiny-turn 80, timeout 60s) | defaults applied |
| TC-6.3a | `assignment-config.test.ts` | construction with no assignment for `turn_rendering` or `chunk_summary_detailed` → accepted; those types are never routed to a provider | deterministic not invoked |
| TC-6.4a | `assignment-config.test.ts` | construction with no explicit overrides → each inference derivation type resolves to a default provider-lane and model (documented defaults) | default lane and model |

---

## Architecture-Risk Tests

These tests cover hazards that AC/TC mapping alone would miss. Each row explains why the TC mapping is insufficient.

| Risk | Test File | Test | Why AC/TC Mapping Alone Would Miss It |
|------|-----------|------|---------------------------------------|
| Old work-queue items with `lower_band_projection` kind crash on first open after rename | `restructure-boundaries.test.ts` | open a thread DB seeded with a queued `lower_band_projection` work item → first-open migration deletes the row and logs a warning; no crash | No TC covers the rename's interaction with the work queue. Without this, a dogfooded thread could crash on next open. |
| Stale work-queue item overwrites a floor-written `ready` derivation after rename | `smooth-turn-compression.test.ts` | seed a work item + a consumer-recovered `ready` row; drain the queue → the stale item does not overwrite the `ready` row | Race between background drain and consumer recovery. ACs cover each path independently but not the conflict. |
| `shared-tech/` accumulates domain imports over time (junk-drawer drift) | `restructure-boundaries.test.ts` | boundary checker fails on any `shared-tech/**` file importing a domain | AC-0.6 names the rule but the test makes it enforceable on every CI run, not just at Story 0. |
| Deterministic `concatenateDetailedChunk` drifts if member ordering changes | `chunk-detailed-deterministic.test.ts` | golden case: members in non-sorted insertion order → output is sorted by `turnOrder` ascending | AC-2.4 says "deterministic" but does not pin the ordering rule. Golden case pins it. |
| Tool-result classifier leaks a clock or randomness source | `tool-result-classifier.test.ts` | call `classifyToolResult` twice with the same input → deep-equal output; run under a mocked advancing clock → output unchanged | AC-5.2 says "deterministic" but a future refactor could introduce `Date.now()` or `Math.random()`. |
| Suspicious-output discard reason is only in logs, not queryable | `smoothed-prompt-guards.test.ts` | after a suspicious-output discard, the derivation row's metadata contains `discardReason: "suspicious_output_ratio"` (asserted via inspect/report read) | AC-4.3 names the discard but the queryability requirement (reportable via inspect, not just transient log) needs an explicit assertion. |
| Real-inference suite silently passes when no auth is configured | `inference-real.test.ts` | with no host `ModelCall` fixture available, the suite emits exactly one NOT-RAN line with reason; no test reports a pass-shaped result | No AC covers the test-harness accounting itself. Silent passes hide real regressions. |

---

## Golden Cases for Deterministic Algorithms

### `concatenateDetailedChunk`

**Input:**
```typescript
[
  { turnOrder: 42, content: "The user asked to restructure the module layout." },
  { turnOrder: 43, content: "The user corrected the import path convention." },
  { turnOrder: 44, content: "The agent moved six domain folders to src/." }
]
```

**Expected output (exact string):**
```text
[turn 0042]
The user asked to restructure the module layout.

[turn 0043]
The user corrected the import path convention.

[turn 0044]
The agent moved six domain folders to src/.
```

**Assertions:** byte-identical on repeat; markers zero-padded to four digits; blank line between members; no trailing blank line.

### `classifyToolResult`

**Case A — write success:**
```typescript
input: { toolName: "write", toolResult: "Successfully wrote 12345 bytes to src/foo.ts", isError: false }
expected: {
  toolName: "write",
  outcome: "succeeded",
  operationClass: "mutation_write",
  responseShape: "structured_receipt",
  promptMode: "receipt",
  parsedFacts: { byteCount: 12345, targetPath: "src/foo.ts" }
}
```

**Case B — edit failure:**
```typescript
input: { toolName: "edit", toolResult: "Found 2 occurrences of edits[0] in src/bar.ts. Each oldText must be unique.", isError: true }
expected: {
  toolName: "edit",
  outcome: "failed",
  operationClass: "mutation_edit",
  responseShape: "simple_failure",
  promptMode: "failure",
  parsedFacts: { matchCount: 2, targetPath: "src/bar.ts", failureType: "non_unique_old_text" }
}
```

**Case C — bash failure with exit code:**
```typescript
input: { toolName: "bash", toolResult: "Command exited with code 1: npm ERR missing dep", isError: true }
expected: {
  toolName: "bash",
  outcome: "failed",
  operationClass: "command",
  responseShape: "simple_failure",
  promptMode: "failure",
  parsedFacts: { exitCode: 1 }
}
```

**Determinism assertion:** each case, run twice, produces deep-equal output. Run under a mocked advancing clock, output unchanged.

---

## Test Count Reconciliation

Per-file estimates, summed against the TC table above:

| File | Estimated Tests | TCs Covered |
|------|----------------|-------------|
| `restructure-boundaries.test.ts` | 8 | TC-0.1a, TC-0.2a, TC-0.4a, TC-0.6a, TC-0.6b + architecture-risk (old work items, shared-tech junk-drawer) |
| `assignment-config.test.ts` | 7 | TC-0.3a, TC-0.3b, TC-6.1a, TC-6.2a, TC-6.3a, TC-6.4a + default guard fill |
| `smooth-turn-compression.test.ts` | 11 | TC-1.1a through TC-1.7b + stale-item-overwrite architecture-risk |
| `chunk-detailed-deterministic.test.ts` | 6 | TC-2.1a through TC-2.4a + golden case + ordering |
| `chunk-brief-from-detailed.test.ts` | 6 | TC-3.1a through TC-3.5a + prompt-examples assertion |
| `smoothed-prompt-guards.test.ts` | 7 | TC-4.1a through TC-4.4a + discard-reason-queryable architecture-risk |
| `tool-result-classifier.test.ts` | 8 | TC-5.1a, TC-5.1b, TC-5.2a + golden cases A/B/C + determinism |
| `tool-result-summary.test.ts` | 4 | TC-5.3a, TC-5.4a, TC-5.5a + timeout architecture-risk |
| `inference-real.test.ts` | 5 | real-inference round-trip per derivation type + NOT-RAN accounting |
| **Total** | **62** | **42 TCs + 20 architecture-risk/golden/extra** |

All 42 TCs from the epic map to at least one test. The 20 extra tests cover architecture risks, golden cases, and the real-inference accounting that no TC names but the skill requires.

---

## Manual Scenario Verification

After TDD Green across all stories, verify manually with real models:

1. [ ] Run `pnpm run verify-all` with a host `ModelCall` fixture available
2. [ ] Intake a real multi-turn conversation; drain the queue
3. [ ] Inspect: every `smooth_turn_compression` derivation is `ready` with non-empty content
4. [ ] Inspect: `chunk_summary_detailed` is `ready`, contains `[turn NNNN]` markers, no provider call recorded
5. [ ] Inspect: `chunk_summary_brief` is `ready`, reads as historical narration
6. [ ] Inspect: a large user prompt (>700 tokens) produces a `ready` smoothed_prompt with floor content, no provider call
7. [ ] Inspect: a tool result produces a `ready` tool_result_summary whose prompt included classification fields
8. [ ] Verify no `lower_band_projection` references remain in source or schema
9. [ ] Verify `src/` top-level directories are exactly the six domain folders plus `shared-tech/`; package entry files like `sdk.ts` / `index.ts` are allowed
10. [ ] Verify `shared-tech/` imports no domain module

---

## Related Documentation

- Epic: `./epic.md`
- Tech Design: `./tech-design.md`
- Derivation testing notes: `../../../../derivation-testing/`
