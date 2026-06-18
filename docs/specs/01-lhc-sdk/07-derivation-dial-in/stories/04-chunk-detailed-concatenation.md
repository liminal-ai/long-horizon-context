# Story 4: Chunk Detailed as Deterministic Concatenation

### Summary
<!-- Jira: Summary field -->

Produce `chunk_summary_detailed` by deterministic concatenation of member `smooth_turn_compression` texts.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `createSdk`.

**Objective:** Remove inference from detailed chunk production and make the detailed chunk artifact an ordered, turn-delimited concatenation of compressed turns.

**Scope In:** Flow 2 AC-2.1 through AC-2.4.

**Scope Out:** No brief summary inference changes and no chunk boundary movement.

**Dependencies:** Story 3; member turns have `smooth_turn_compression`.

**Architecture Constraints:** `turns` owns chunks and chunk derivations. `chunk_summary_detailed` is a derivation state on the chunk, not a thread-view artifact. Recovery remains per Epic 06.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-2.1:** `chunk_summary_detailed` is produced by deterministic concatenation of member `smooth_turn_compression` texts in turn order, with no model call.

- **TC-2.1a:** Deterministic, no model call
  - Given: a chunk closes with all member `smooth_turn_compression` derivations ready
  - When: `chunk_summary_detailed` derives
  - Then: the result is the ordered concatenation of member texts and no model call is made

**AC-2.2:** When a member `smooth_turn_compression` is not ready at chunk-close time: if the member is `pending` (inference still in flight), background chunk detailed derivation requeues and waits. If the member is `failed`, background chunk detailed derivation consumes the Epic 06 floor (smooth text) for that member rather than requeueing indefinitely. Compact-time recovery uses stored-member concatenation.

- **TC-2.2a:** Background requeues on pending member
  - Given: a chunk closes while a member `smooth_turn_compression` is `pending`
  - When: background chunk detailed derivation runs
  - Then: the work requeues rather than concatenating incomplete material or landing `failed`
- **TC-2.2b:** Background uses floor for failed member
  - Given: a chunk closes while a member `smooth_turn_compression` is `failed`
  - When: background chunk detailed derivation runs
  - Then: the smooth-text floor for that member is used in concatenation and the fallback is logged

**AC-2.3:** The concatenated output preserves turn boundaries so that downstream consumers (brief compression, band rendering) can distinguish turns within the chunk.

- **TC-2.3a:** Turn boundaries present
  - Given: a chunk with three member turns
  - When: detailed concatenation produces the output
  - Then: the output contains markers that separate the three turns' content

**AC-2.4:** A chunk whose members are all ready produces identical detailed output for identical input (deterministic, no randomness, no clock dependency).

- **TC-2.4a:** Deterministic output
  - Given: a chunk with fixed member `smooth_turn_compression` texts
  - When: detailed concatenation runs twice
  - Then: both outputs contain the same ordered member material

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `turns` because chunks and chunk derivations live there. `chunk_summary_detailed` becomes a deterministic function over member `smooth_turn_compression` rows, ordered by turn order and separated with `[turn NNNN]` markers.

The handler never calls the inference adapter. Pending member compression requeues chunk detailed work; failed member compression uses the smooth-text floor and logs fallback; blocked member source blocks the detailed derivation.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The behavior is deterministic and narrow, but the not-ready member branches and zero-provider-call invariant need tests before implementation.

Risk Reminders:
- Turn ordering must be by `turnOrder` ascending, not insertion order.
- The marker format is settled: `[turn NNNN]`, zero-padded to four digits.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Chunk derivation handler | `src/turns/internal/chunks.ts`, `src/turns/internal/derive.ts` |
| Deterministic function | `src/turns/internal/chunks.ts` |
| Provider interface cleanup | `src/shared-tech/inference-adapter.ts`, `src/shared-tech/inference-types.ts` |
| Prompt registry cleanup | `src/shared-tech/prompts/index.ts` |
| Tests | `chunk-detailed-deterministic.test.ts` |

#### Design References

- [tech-design.md §TDQ-5: Turn-boundary markers](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:88), lines 88-99
- [tech-design.md §Flow 2: Chunk Detailed as Deterministic Concatenation](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:456), lines 456-498
- [tech-design.md §Deterministic Functions](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:776), lines 776-788
- [tech-design.md §Deterministic Algorithm Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:1102), lines 1102-1113
- [test-plan.md §Flow 2: Chunk Detailed Deterministic](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:46), lines 46-54
- [test-plan.md §Golden Cases for Deterministic Algorithms](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:114), lines 114-139

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.1a | `chunk-detailed-deterministic.test.ts` | All-ready chunk lands `ready` by concatenation and provider spy records zero calls. |
| TC-2.2a | `chunk-detailed-deterministic.test.ts` | Pending member compression requeues with dependency-not-ready and leaves derivation pending. |
| TC-2.2b | `chunk-detailed-deterministic.test.ts` | Failed member compression uses smooth-text floor, logs per-member fallback, and lands ready. |
| TC-2.3a | `chunk-detailed-deterministic.test.ts` | Stored detailed content contains zero-padded `[turn NNNN]` markers for each member. |
| TC-2.4a | `chunk-detailed-deterministic.test.ts` | Two runs with the same member array produce byte-identical output. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Member ordering drifts | `chunk-detailed-deterministic.test.ts` | Golden case with non-sorted insertion order outputs sorted `turnOrder` ascending. | Determinism ACs do not pin which order is canonical. |
| Inference path survives behind the deterministic handler | `chunk-detailed-deterministic.test.ts` | Provider spy records zero calls and provider interface has no detailed-summary operation. | A wrapper could pass output checks while still paying provider cost. |

#### Technical Notes

- No size cap applies; all member content is included.
- There is no prompt template for detailed chunks.
- `turn_rendering` and `chunk_summary_detailed` are deterministic domain functions, not provider operations.

#### Anti-Shim Requirements

- Test the public derivation path and the pure concatenation function.
- Assert exact golden output including blank lines and no trailing blank line.
- Assert provider-zero-call through the host `ModelCall` spy.

#### Production Path Proof

- Entrypoint: chunk close queued derivation handled by the `turns` chunk derivation path.
- Registration/default path: chunk close queues `chunk_summary_detailed`; the work queue invokes the deterministic handler.
- Evidence: `chunk-detailed-deterministic.test.ts` uses real handler wiring and provider spy.

#### Source/Derived State Risk

- Source truth is the chunk membership plus member compression rows.
- Derived state is the concatenated detailed chunk text.
- Failed-member floors are logged but not annotated into the concatenated text.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Ready-member chunks concatenate with no model call.
- Pending member input requeues.
- Failed member input uses smooth-text floor and logs fallback.
- Output includes turn-boundary markers.
- Identical ready input produces identical output.
