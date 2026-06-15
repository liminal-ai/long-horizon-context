# Story 5: Runtime-Change Typing

### Summary
<!-- Jira: Summary field -->

Record model and thinking-level changes as typed blocks and place them verbatim in constructed turns.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** preserve runtime-change structure instead of flattening model and thinking-level changes into `runtime_note` text.

**Scope In:**
- `model_change` blocks with previous and new model.
- `thinking_level_change` blocks with previous and new level.
- Verbatim placement in constructed turns in stream order.

**Scope Out:**
- pi-lhc consumption of typed runtime blocks for thread restoration.

**Dependencies:** Story 0.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-6.1:** A model change is recorded and projected as a typed `model_change` block with structured fields (previous and new model).

- **TC-6.1a:** Typed model change
  - Given: a model-change runtime event at intake
  - When: it is projected
  - Then: a typed `model_change` block carries the previous and new model values

**AC-6.2:** A thinking-level change is recorded and projected as a typed `thinking_level_change` block with structured fields (previous and new level).

- **TC-6.2a:** Typed thinking change
  - Given: a thinking-level-change runtime event at intake
  - When: it is projected
  - Then: a typed `thinking_level_change` block carries the previous and new level values

**AC-6.3:** Typed runtime-change blocks are placed verbatim in constructed turns, in stream order, like other non-derived components.

- **TC-6.3a:** Placed verbatim and ordered
  - Given: a turn containing a model change followed by a thinking change
  - When: the turn is constructed
  - Then: both typed blocks appear unchanged and in order

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 5 extends the public intake event contract and message projection for runtime changes. `MessageEventInput` accepts `model_change` and `thinking_level_change`, validation enforces their structured fields, and message projection stores typed blocks instead of flattened `runtime_note` text.

Turn construction treats these blocks as non-derived components and places them verbatim in stream order. Host restoration behavior remains out of scope.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- The implementation is a narrow public event/validation/projection change.
- The main risk is compatibility: the public input union and projection must agree.

Risk Reminders:
- Intake/projection compatibility: validation and projection must accept the same structured shapes.
- Runtime blocks are non-derived and must not enter derivation/recovery paths.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Public event union | `packages/lhc/src/domains/intake-stream/index.ts` |
| Intake validation | `packages/lhc/src/domains/intake-stream/internal/validate.ts` |
| Message projection | `packages/lhc/src/domains/messages/internal/project.ts` |
| Turn placement dependency | `packages/lhc/src/domains/turns/internal/compose.ts` |
| Story tests | `packages/lhc/test/runtime-change-typing.test.ts` (planned) |

#### Design References

- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:61), lines 61-81
- [tech-design.md §Typed runtime-change blocks](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:238), lines 238-249
- [tech-design.md §Deferred / Out of Scope](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:347), lines 347-352
- [test-plan.md §Flow 6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:111), lines 111-117
- [test-plan.md §Per-Chunk Red/Green Exit Criteria](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:139), lines 139-148

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-6.1a | `packages/lhc/test/runtime-change-typing.test.ts` | Model-change intake event projects to typed `model_change` block with previous and new model. |
| TC-6.2a | `packages/lhc/test/runtime-change-typing.test.ts` | Thinking-level-change intake event projects to typed `thinking_level_change` block with previous and new level. |
| TC-6.3a | `packages/lhc/test/runtime-change-typing.test.ts` | Turn containing model change followed by thinking change renders both blocks unchanged and in order. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Public input compatibility | `packages/lhc/test/runtime-change-typing.test.ts` | Construct events through public `MessageEventInput` and validation before projection. | Projection-only tests can pass while public intake rejects the event. |
| Non-derived placement | `packages/lhc/test/runtime-change-typing.test.ts` | Runtime-change blocks render verbatim through turn composition without derivation work. | Typed block projection alone does not prove constructed turns preserve order. |

#### Technical Notes

- Public `MessageEventInput` gains `model_change` and `thinking_level_change`.
- Validation must require previous/new fields for each event.
- Projection emits typed message blocks; it does not flatten to `runtime_note`.
- pi-lhc thread restoration consumption remains out of scope.

#### Anti-Shim Requirements

- Do not encode runtime changes as text notes with parseable prefixes.
- Do not add derivation work items for runtime-change blocks.
- Do not implement host restoration behavior in this story.

#### Production Path Proof

- Entrypoint: public intake event through `domains/intake-stream`.
- Registration/default path: intake validation accepts the event and message projection emits typed blocks consumed by turn composition.
- Evidence: `packages/lhc/test/runtime-change-typing.test.ts` exercises public input, validation, projection, and turn placement.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/runtime-change-typing.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- AC-6.1 through AC-6.3 pass with their listed TCs.
- `model_change` and `thinking_level_change` blocks carry structured fields.
- Constructed turns place typed runtime-change blocks verbatim in stream order.
- No pi-lhc restoration behavior is added.
