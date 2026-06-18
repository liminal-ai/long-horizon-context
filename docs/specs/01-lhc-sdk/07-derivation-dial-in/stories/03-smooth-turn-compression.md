# Story 3: Smooth Turn Compression

### Summary
<!-- Jira: Summary field -->

Produce `smooth_turn_compression` as per-turn inference compression of smooth turn text.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `createSdk`.

**Objective:** Replace deterministic lower-band composition with per-turn compression over resolved smooth turn text, preserving Epic 06 recovery behavior and floors.

**Scope In:** Flow 1 AC-1.1 through AC-1.7.

**Scope Out:** No model-call contract change, no recovery cascade mechanism change, no thread-view rendering policy change.

**Dependencies:** Story 0 for rename/config. Stories 1 and 2 enrich message-level derivations that this story resolves before compression.

**Architecture Constraints:** `turns` owns turn-shaped derivations and queues its own work when a turn closes. Message-level derivations remain owned by `messages`; cross-domain repair/retry goes through public surfaces.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-1.1:** `smooth_turn_compression` is produced by inference compression of the turn's smooth text, not by deterministic composition.

- **TC-1.1a:** Provider called for smooth_turn_compression
  - Given: a turn closes with smooth text above the tiny-turn threshold
  - When: `smooth_turn_compression` derives
  - Then: the assigned model-call function is invoked with the compression prompt and smooth text

**AC-1.2:** The compression prompt includes the input token count and a target output range, and instructs the model to verify its output length before returning.

- **TC-1.2a:** Prompt includes targets
  - Given: a smooth turn of ~1800 tokens
  - When: the compression prompt is rendered
  - Then: the model request includes the input token count, a min/max target range, and a mid-range aim

**AC-1.3:** Turns below the tiny-turn threshold have their smooth text stored as `smooth_turn_compression` without inference, landing `ready`.

- **TC-1.3a:** Tiny turn skips inference
  - Given: a turn with smooth text under the tiny-turn threshold
  - When: `smooth_turn_compression` derives
  - Then: the smooth text is stored directly, no model call occurs, and state is `ready`

**AC-1.4:** The compressed output preserves the substance of the user/agent exchange: requests, corrections, decisions, commitments, tool outcomes, concrete references (files, paths, commands, model names, numbers, errors, test results), and unresolved questions.

- **TC-1.4a:** Substance preserved
  - Given: a turn containing a user correction, an agent action, a tool outcome, and a file path
  - When: compression produces the output
  - Then: the correction, action, outcome, and file path are present in the compressed text

**AC-1.5:** The compressed output removes raw thinking text, raw tool output, repeated acknowledgements, apologies, status chatter, and local filler.

- **TC-1.5a:** Noise removed
  - Given: a turn containing raw thinking blocks, raw tool output, and repeated acknowledgements
  - When: compression produces the output
  - Then: those elements are absent or substantially reduced in the compressed text

**AC-1.6:** Before per-turn compression, message-level derivations that are not `ready` are re-attempted. If re-attempt fails, the deterministic floor is used and the fallback is logged. Per-turn compression then operates on the best available content.

- **TC-1.6a:** Not-ready smoothed_prompt recovered before compression
  - Given: a turn closes with a `smoothed_prompt` in `pending` state
  - When: per-turn compression runs
  - Then: `smoothed_prompt` is re-attempted; if successful, the recovered content is used in the smooth turn text; if not, the deterministic floor (cleaned prompt) is used and the fallback is logged
- **TC-1.6b:** Not-ready tool_result_summary recovered before compression
  - Given: a turn closes with a `tool_result_summary` in `pending` state
  - When: per-turn compression runs
  - Then: `tool_result_summary` is re-attempted; if successful, the recovered content is used; if not, the deterministic floor (truncated tool output) is used and the fallback is logged

**AC-1.7:** When per-turn compression inference itself fails, background failure records the honest `failed` state on the derivation. Consumer-time recovery uses the smooth-text floor per Epic 06 recovery rules. Both failure and any floor use are logged.

- **TC-1.7a:** Failed compression records failed state
  - Given: per-turn compression inference fails terminally in the background
  - When: the derivation handler completes
  - Then: the derivation state is `failed` with a reason, and the failure is logged
- **TC-1.7b:** Consumer recovers with smooth-text floor
  - Given: a `smooth_turn_compression` derivation is in `failed` state
  - When: a consumer needs the compressed turn text
  - Then: the smooth text is available as the floor per Epic 06 recovery rules

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `turns` because `smooth_turn_compression` is a turn-shaped derivation created after turn close. The handler builds smooth turn text from resolved message-level material, then either passes tiny turns through or calls the inference adapter's `compressSmoothTurn`.

`composeTurnRendering` remains deterministic inside `turns`; it is not a provider operation. If compression inference fails in the background, the derivation records `failed`. Later consumers recover using the smooth-text floor per Epic 06.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- This story coordinates turn state, message-level recovery, provider calls, target metadata, failure persistence, and consumer-time recovery. A happy-path provider-call test is not enough.

Risk Reminders:
- Background compression failure must land `failed`, not `ready` with floor.
- Consumer recovery must write floor metadata when it uses smooth text.
- The compressed input must be smooth text, not the old rendering/projection input.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Turn derivation handler | `src/turns/internal/derive.ts` |
| Turn composition input | `src/turns/internal/compose.ts` |
| Inference adapter/provider interface | `src/shared-tech/inference-adapter.ts`, `src/shared-tech/inference-types.ts` |
| Prompt | `src/shared-tech/prompts/smooth-turn-compression-v1.ts`, `src/shared-tech/prompts/index.ts` |
| Downstream consumer recovery | `src/turns/internal/chunks.ts`, `src/thread-view/internal/select.ts` |
| Tests | `smooth-turn-compression.test.ts` |

#### Design References

- [tech-design.md §TDQ-1: Tiny-turn threshold](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:64), lines 64-68
- [tech-design.md §TDQ-6: Target validation behavior](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:101), lines 101-105
- [tech-design.md §Flow 1: Smooth Turn Compression](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:338), lines 338-452
- [tech-design.md §DerivationProvider](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:737), lines 737-773
- [tech-design.md §Derived-State Provenance](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:1083), lines 1083-1098
- [test-plan.md §Flow 1: Smooth Turn Compression](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:32), lines 32-44
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:98), lines 98-110

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-1.1a | `smooth-turn-compression.test.ts` | Above-threshold turn invokes `compressSmoothTurn` with smooth text. |
| TC-1.2a | `smooth-turn-compression.test.ts` | Provider messages include input tokens and min/mid/max target values. |
| TC-1.3a | `smooth-turn-compression.test.ts` | Smooth text at or below 80 tokens passes through with zero provider calls and `ready` state. |
| TC-1.4a | `smooth-turn-compression.test.ts` | Stored compressed derivation equals the canned response for a substance-preservation fixture. |
| TC-1.5a | `smooth-turn-compression.test.ts` | Handler stores only provider response and does not append raw thinking/tool blocks. |
| TC-1.6a | `smooth-turn-compression.test.ts` | Pending prompt smoothing is re-attempted before compression and recovered content is used when successful. |
| TC-1.6b | `smooth-turn-compression.test.ts` | Pending tool result summary is re-attempted; failed recovery uses truncation floor and logs fallback. |
| TC-1.7a | `smooth-turn-compression.test.ts` | Background compression inference failure records `failed` with provider reason. |
| TC-1.7b | `smooth-turn-compression.test.ts` | Chunk-close consumer recovery writes `ready` with `floorUsed: "smooth_text"` and logs fallback. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Stale queued work overwrites consumer-recovered ready content | `smooth-turn-compression.test.ts` | Seed stale queued work plus a consumer-recovered ready row, drain, and assert ready floor content is not overwritten. | Background and consumer recovery paths can each pass independently while conflicting together. |
| Out-of-target output triggers retry or failure | `smooth-turn-compression.test.ts` | Provider returns outside target range; derivation lands `ready` with `sizeDisposition`. | Target ACs require prompt values, but the design decision is accept-and-log. |

#### Technical Notes

- Default tiny-turn threshold is 80 estimated tokens.
- Default target ratios are 35% minimum, 50% aim, 65% maximum.
- Out-of-range but usable output lands `ready` with `sizeDisposition`.

#### Anti-Shim Requirements

- Assert provider input contains smooth turn text assembled from real message derivation rows.
- Assert `composeTurnRendering` and deterministic paths produce zero provider calls.
- Assert failure and floor metadata on persisted derivation rows, not only returned handler values.

#### Production Path Proof

- Entrypoint: turn-close queued derivation handled by `turns/internal/derive.ts`.
- Registration/default path: intake closes a turn; `turns` queues its own derivation work; the work queue invokes the turn handler.
- Evidence: `smooth-turn-compression.test.ts` uses the real queue/handler path with real temp SQLite and host `ModelCall` spy.

#### Source/Derived State Risk

- Source truth is the closed turn and its member messages.
- Derived state is `smooth_turn_compression` with provenance, `sizeDisposition`, and optional `floorUsed`.
- Source-damaged cases remain `blocked`; inference failures remain `failed` until consumer recovery succeeds.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Above-threshold turns invoke the assigned model-call function.
- Prompt includes input count and min/mid/max target guidance.
- Tiny turns skip inference and land `ready`.
- Compression fixture preserves substance and removes specified noise.
- Not-ready message derivations are recovered or floored before compression.
- Failed compression records `failed`; consumer recovery exposes smooth-text floor and logs floor use.
