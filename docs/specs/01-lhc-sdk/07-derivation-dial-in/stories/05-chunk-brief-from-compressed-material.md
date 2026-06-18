# Story 5: Chunk Brief from Compressed Material

### Summary
<!-- Jira: Summary field -->

Make `chunk_summary_brief` consume `chunk_summary_detailed` and use the tuned brief prompt with examples.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `createSdk`.

**Objective:** Produce compact historical memory notes from detailed compressed material instead of raw smooth turn text.

**Scope In:** Flow 3 AC-3.1 through AC-3.5.

**Scope Out:** No detailed chunk production changes and no thread-view band policy changes.

**Dependencies:** Story 4; `chunk_summary_detailed` is available as deterministic compressed-turn material.

**Architecture Constraints:** `turns` owns chunk summaries. Thread-view consumes the stored artifacts but does not derive or repair them directly.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-3.1:** `chunk_summary_brief` consumes the `chunk_summary_detailed` text as its input, not raw smooth turn text.

- **TC-3.1a:** Input is detailed text
  - Given: a chunk with ready `chunk_summary_detailed`
  - When: `chunk_summary_brief` derives
  - Then: the model receives the detailed text as input, not the raw smooth turn material

**AC-3.2:** The brief prompt includes the input token count, a target output range, and instructs the model to verify output length before returning.

- **TC-3.2a:** Prompt includes targets
  - Given: a chunk detailed text of ~2000 tokens
  - When: the brief prompt is rendered
  - Then: the model request includes the input token count, min/max target range, and mid-range aim

**AC-3.3:** The brief output is a past-tense historical memory note, not a transcript, not compressed dialogue, not live-status instructions.

- **TC-3.3a:** Historical narration
  - Given: chunk detailed material containing user/agent back-and-forth
  - When: brief compression produces the output
  - Then: the output reads as past-tense narration ("The user decided…", "They agreed that…"), not as a transcript with speaker markers

**AC-3.4:** The brief prompt includes concrete examples of good and bad brief outputs with commentary explaining the quality distinction.

- **TC-3.4a:** Examples in prompt
  - Given: the brief prompt template
  - When: it is rendered
  - Then: the model request includes at least one good example, one bad-too-verbose example, and one bad-too-terse example, each with commentary

**AC-3.5:** When `chunk_summary_detailed` is not ready, `chunk_summary_brief` follows Epic 06's chunk recovery behavior: background derivation requeues and waits for the detailed input; compact-time recovery falls back to deterministic stored-member concatenation.

- **TC-3.5a:** Brief requeues when detailed not ready
  - Given: `chunk_summary_brief` derives while `chunk_summary_detailed` is `pending`
  - When: background derivation runs
  - Then: the brief work requeues rather than failing or using raw smooth input

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `turns` because `chunk_summary_brief` is a chunk derivation. The handler consumes `chunk_summary_detailed` text, not raw member projections, and sends that detailed compressed material to the brief prompt.

The prompt is intentionally example-heavy. It includes good and bad examples with commentary so the model produces a past-tense historical memory note rather than a transcript or live status.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The main implementation hazard is subtle input drift: using old raw/member material can still produce plausible summaries. Tests must assert the serialized provider input and the not-ready dependency behavior.

Risk Reminders:
- Brief waits on detailed; it must not silently fall back to raw smooth input in background derivation.
- Out-of-target but usable output is accepted as `ready` with `sizeDisposition`.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Brief derivation handler | `src/turns/internal/derive.ts` |
| Brief prompt | `src/shared-tech/prompts/chunk-brief-v1.ts`, `src/shared-tech/prompts/index.ts` |
| Inference adapter | `src/shared-tech/inference-adapter.ts` |
| Tests | `chunk-brief-from-detailed.test.ts` |

#### Design References

- [tech-design.md §TDQ-6: Target validation behavior](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:101), lines 101-105
- [tech-design.md §Flow 3: Chunk Brief from Compressed Material](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:502), lines 502-554
- [tech-design.md §Default Assignment Table](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:718), lines 718-733
- [tech-design.md §DerivationProvider](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:737), lines 737-773
- [test-plan.md §Flow 3: Chunk Brief from Compressed Material](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:56), lines 56-64
- [test-plan.md §Manual Scenario Verification](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:207), lines 207-220

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-3.1a | `chunk-brief-from-detailed.test.ts` | Provider spy messages contain detailed derivation text and not raw member projection text. |
| TC-3.2a | `chunk-brief-from-detailed.test.ts` | Provider messages include target token variables computed from detailed text size. |
| TC-3.3a | `chunk-brief-from-detailed.test.ts` | Stored derivation equals a canned past-tense historical narration response. |
| TC-3.4a | `chunk-brief-from-detailed.test.ts` | Rendered prompt includes good and bad example blocks with commentary. |
| TC-3.5a | `chunk-brief-from-detailed.test.ts` | Pending detailed input requeues with dependency-not-ready. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Handler uses stale raw/member material | `chunk-brief-from-detailed.test.ts` | Seed distinct detailed text and raw member text; assert only detailed text reaches provider. | A canned brief output can pass while the wrong input source is used. |
| Detailed dependency is bypassed | `chunk-brief-from-detailed.test.ts` | Detailed derivation pending causes requeue, not fallback to raw smooth input. | Recovery behavior belongs to the sequential pipeline and is easy to shortcut. |

#### Technical Notes

- Default target range is 8% to 20%, aim 12%.
- Default Codex model is `gpt-5.4-mini`; alternate lanes may use stronger brief models.
- The prompt uses XML-tagged examples and commentary per the tech design.

#### Anti-Shim Requirements

- Assert serialized provider prompt content, not only that a helper was called.
- Keep example/commentary assertions on the rendered prompt template.
- Assert pending detailed input requeues through work-queue behavior.

#### Production Path Proof

- Entrypoint: queued `chunk_summary_brief` derivation handled by `turns/internal/derive.ts`.
- Registration/default path: detailed chunk readiness enables brief work; the handler invokes `summarizeChunkBrief`.
- Evidence: `chunk-brief-from-detailed.test.ts` uses real handler and provider spy.

#### Source/Derived State Risk

- Source truth is the chunk and its detailed derivation text.
- Derived state is the brief memory note plus provenance and `sizeDisposition`.
- Background failure remains `failed`; blocked detailed input blocks the brief derivation.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Brief model input is detailed text, not raw smooth turn text.
- Prompt includes input count, target range, and output-length verification instruction.
- Prompt includes one good example, one bad-too-verbose example, and one bad-too-terse example with commentary.
- Output fixture reads as past-tense historical memory, not transcript or live instructions.
- Pending detailed input requeues instead of failing or using raw smooth input.
