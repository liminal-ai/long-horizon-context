# Story Lead Base Prompt

## Role Charter
You are the story lead for `00-foundation` on durable story run `00-foundation-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 1.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/stories/00-foundation.md
Bytes: 13686

# Story 0: Foundation — Restructure, Rename, and Config

### Summary
<!-- Jira: Summary field -->

Restructure SDK module boundaries, rename `lower_band_projection` to `smooth_turn_compression`, remove typed derivation enumeration, and install extended assignment defaults.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `createSdk`.

**Objective:** Put every later derivation change on the correct domain-surface architecture: domain surfaces are top-level, shared technical machinery lives in `shared-tech/`, derivation kinds are string discriminators, and assignment config supports targets, caps, thinking settings, and defaults.

**Scope In:** Flow 0 foundation and Flow 6 model assignment defaults and target config.

**Scope Out:** No model-call function contract change, no recovery cascade change, no work queue change, no thread-view policy change, and no behavioral derivation method changes beyond rename/config cleanup.

**Dependencies:** Epics 05 and 06 are available. This story must land before Stories 1–5.

**Architecture Constraints:** Domain surfaces are service boundaries. Cross-domain calls go through public surfaces. `shared-tech/` owns no conversation-domain logic and may not import domains. Domains may not import another domain's internals.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-0.1:** Domain surfaces are top-level folders in `src/`. No `domains/` wrapper folder exists. The six domains — `intake-stream`, `messages`, `turns`, `threads`, `thread-view`, `inspect` — are direct children of `src/`.

- **TC-0.1a:** Domain folders at top level
  - Given: the restructured codebase
  - When: `src/` is listed
  - Then: the six domain folders are direct children; no `domains/` folder exists

**AC-0.2:** All cross-domain technical infrastructure lives under one `shared-tech/` folder in `src/`. No `inference/`, `providers/`, `shared/`, or `tech-utils/` folders exist at the `src/` top level.

- **TC-0.2a:** Single shared-tech area
  - Given: the restructured codebase
  - When: `src/` is listed
  - Then: `shared-tech/` exists; `inference/`, `providers/`, `shared/`, and `tech-utils/` do not

**AC-0.3:** The `DERIVATION_TYPES` typed array and `DerivationType` union type are removed. Derivation types are plain string discriminators. Construction does not require all derivation types to be present in the assignment config.

- **TC-0.3a:** No typed derivation enumeration
  - Given: the updated codebase
  - When: a search for `DERIVATION_TYPES` or `DerivationType` is run
  - Then: neither exists as a runtime array or union type
- **TC-0.3b:** Partial assignments accepted
  - Given: a config that supplies assignments for only inference derivation types
  - When: the SDK constructs
  - Then: construction succeeds without requiring entries for deterministic types

**AC-0.4:** The derivation type `lower_band_projection` is renamed to `smooth_turn_compression` in code, schema, and prompts.

- **TC-0.4a:** Rename complete
  - Given: the updated codebase
  - When: a search for `lower_band_projection` is run
  - Then: no references exist except historical documentation

**AC-0.5:** Existing behavior not intentionally changed by Flow 0 remains green. Sanctioned expectation changes are limited to the derivation-type rename and assignment-validation cleanup.

- **TC-0.5a:** Verify-all green
  - Given: the restructured codebase
  - When: `pnpm run verify-all` runs
  - Then: all tests pass (with expected updates for the rename and validation changes), lint passes, typecheck passes, boundary checks pass

**AC-0.6:** `shared-tech/` may not import domain modules. Domains may not import other domains' internal modules. These import-boundary rules are enforced by the existing boundary check.

- **TC-0.6a:** Shared-tech does not import domains
  - Given: the restructured codebase
  - When: the boundary check runs
  - Then: no `shared-tech/` file imports from a domain folder
- **TC-0.6b:** Domains do not cross into other domains' internals
  - Given: the restructured codebase
  - When: the boundary check runs
  - Then: no domain imports another domain's `internal/` modules; cross-domain calls go through the domain's public surface

**AC-6.1:** The model assignment config accepts optional per-derivation target range fields (min ratio, mid ratio, max ratio) and an optional input-size cap alongside provider/model/prompt.

- **TC-6.1a:** Target range accepted
  - Given: an assignment with target ratios 0.35/0.50/0.65
  - When: the configuration is accepted
  - Then: the assignment is valid and the target range is available for prompt rendering and output validation

**AC-6.2:** Defaults are installed for every derivation type; the defaults are used when the host does not supply explicit values.

- **TC-6.2a:** Defaults applied
  - Given: a config that supplies provider/model/prompt but no target range for `smooth_turn_compression`
  - When: the adapter renders the compression prompt
  - Then: the default target range is used

**AC-6.3:** Deterministic derivation types (`chunk_summary_detailed`, `turn_rendering`) carry an assignment entry with provider and model optional; if present, they are not invoked during derivation.

- **TC-6.3a:** Deterministic assignment not invoked
  - Given: a config with assignments for all types including `chunk_summary_detailed`
  - When: `chunk_summary_detailed` derives
  - Then: no model call is made for it

**AC-6.4:** Inference derivation types carry a documented default provider lane and model; both are configurable and overridable by the host.

- **TC-6.4a:** Default lane and model documented
  - Given: a fresh SDK construction with no explicit overrides
  - When: the default assignments are inspected
  - Then: each inference derivation type names a default provider lane and model

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is the structural foundation for Epic 07. It removes the `domains/` wrapper, consolidates non-domain infrastructure into `src/shared-tech/`, and keeps the domain-surface rule enforceable: `shared-tech/` may not import domains, and domains may only call other domains through public surfaces.

It also owns the rename and config contract that later stories depend on. `lower_band_projection` becomes `smooth_turn_compression`, `DERIVATION_TYPES` and `DerivationType` are removed, construction validation becomes per-key, and defaults/guards are filled at SDK construction.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- This is a broad mechanical restructure plus migration/config work. The risk is not one algorithm; it is stale imports, old queued work, and construction defaults drifting from the new production paths.

Risk Reminders:
- No compatibility facades for old import paths.
- Old `lower_band_projection` work-queue rows must be deleted by a thread-file migration, not left to crash a worker.
- Boundary enforcement must live in the checker, not only in docs.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Domain folders | `src/intake-stream/`, `src/messages/`, `src/turns/`, `src/threads/`, `src/thread-view/`, `src/inspect/` |
| Shared technical area | `src/shared-tech/derivation.ts`, `src/shared-tech/inference-types.ts`, `src/shared-tech/inference-adapter.ts`, `src/shared-tech/prompts/index.ts`, `src/shared-tech/storage.ts`, `src/shared-tech/scheduler.ts` |
| SDK construction | `src/sdk.ts` |
| Downstream rename consumers | `src/turns/internal/derive.ts`, `src/turns/internal/derivations.ts`, `src/turns/internal/chunks.ts`, `src/thread-view/internal/select.ts` |
| Architecture docs | `docs/specs/01-lhc-sdk/01-tech-arch.md` |
| Tests | `restructure-boundaries.test.ts`, `assignment-config.test.ts` |

#### Design References

- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:183), lines 183-230
- [tech-design.md §Target Layout](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:232), lines 232-272
- [tech-design.md §Rename Migration](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:274), lines 274-299
- [tech-design.md §Typed Enumeration Removal](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:301), lines 301-305
- [tech-design.md §Import Boundary Rules](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:314), lines 314-320
- [tech-design.md §Flow 6: Assignment Config and Defaults](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:693), lines 693-733
- [test-plan.md §Flow 0: Foundation](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:19), lines 19-30
- [test-plan.md §Flow 6: Assignment Config and Defaults](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:87), lines 87-94

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-0.1a | `restructure-boundaries.test.ts` | Assert the six domain folders exist directly under `src/`. |
| TC-0.2a | `restructure-boundaries.test.ts` | Assert `src/shared-tech/` exists and old top-level technical folders do not. |
| TC-0.3a | `assignment-config.test.ts` | Assert `DERIVATION_TYPES` is not exported and `DerivationType` is not a named type. |
| TC-0.3b | `assignment-config.test.ts` | Construct with only inference assignments and no deterministic entries. |
| TC-0.4a | `restructure-boundaries.test.ts` | Assert schema/source use `smooth_turn_compression` and no source derivation type references remain under the old name. |
| TC-0.5a | `pnpm run verify-all` | Full story completion gate. |
| TC-0.6a | `restructure-boundaries.test.ts` | Boundary checker fails if `shared-tech/**` imports a domain. |
| TC-0.6b | `restructure-boundaries.test.ts` | Boundary checker fails if a domain imports another domain's `internal/` modules. |
| TC-6.1a | `assignment-config.test.ts` | Assignment with target ratios is accepted and retained. |
| TC-6.2a | `assignment-config.test.ts` | Missing guard config fills defaults: cap 700, suspicious 0.15, tiny-turn 80, timeout 60s. |
| TC-6.3a | `assignment-config.test.ts` | Missing deterministic assignments are accepted and deterministic types are never routed to a provider. |
| TC-6.4a | `assignment-config.test.ts` | Default assignments resolve provider lane and model for each inference derivation type. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Old queued work with the renamed kind crashes after first open | `restructure-boundaries.test.ts` | Seed a thread DB with old queued work, open it, assert migration deletes the row and logs a warning. | Rename ACs cover source/schema strings but not persisted queued work. |
| `shared-tech/` becomes a domain import sink | `restructure-boundaries.test.ts` | Boundary checker fails on any `shared-tech/**` import from a domain folder. | A one-time restructure could pass while later imports regress. |

#### Technical Notes

- `DerivationGuards` is separate from `ModelAssignment`; target ratios and thinking stay on assignments, operational limits stay under `guards`.
- The valid assignment-key authority is the union of prompt registry keys and known deterministic handler names.
- `shared-tech/scheduler.ts` must receive `openThreadDatabase` by SDK wiring injection, because importing `threads` would violate the boundary rule.

#### Anti-Shim Requirements

- Do not leave old top-level folders as compatibility facades.
- Do not implement boundary compliance by excluding files from the checker.
- Do not silently ignore unknown assignment keys.

#### Production Path Proof

- Entrypoint: `createSdk` construction and thread-file open/migration.
- Registration/default path: SDK construction fills defaults and wires the scheduler with injected thread DB opening.
- Evidence: `assignment-config.test.ts`, `restructure-boundaries.test.ts`, and `pnpm run boundaries`.

#### Transition-State Risk

- Existing old derivation rows are left in place and become unread by current queries.
- Existing old queued work rows are deleted by a recorded thread-file migration with a warning.
- New repair/rebuild/recovery writes the current derivation kind.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- `src/` domain and `shared-tech/` layout matches AC-0.1 through AC-0.2.
- Boundary check enforces shared-tech and domain-surface import rules.
- `lower_band_projection` rename is complete outside historical documentation.
- `DERIVATION_TYPES` runtime array and `DerivationType` union are gone.
- Partial assignment configs construct successfully.
- Default assignment metadata and guard defaults are installed and documented.
- `pnpm run verify-all` passes with only expected rename/config expectation updates.


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md
Bytes: 17017

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


## Current Run Index
- planner_turn_index: 1
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-orchestrate-run
- current_child_operation: none
- current_summary: Story orchestration started and durable state has been initialized.
- latest_response_kind: none
- latest_response_path: none
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 0
- latest_self_note: "none"

## Response Trail
<current_response>
No prior bounded child response is recorded yet.
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/artifacts/00-foundation/story-lead/001-current.json
Bytes: 931

```yaml
storyRunId: "00-foundation-story-run-001"
storyId: "00-foundation"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/artifacts/00-foundation/001-story-validate.json"
    provenance: "prior-run"
latestContinuationHandles:
{}
latestEventSequence: 1
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "orient-from-disk"
  summary: "Orient from 1 existing story artifact(s)."
replayBoundary: null
updatedAt: "2026-06-18T15:30:11.021Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/artifacts/00-foundation/story-lead/001-events.jsonl
Bytes: 213

```yaml
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 1
  timestamp: "2026-06-18T15:30:11.020Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
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
Bytes: 217

```yaml
storyGate: "pnpm run verify"
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
