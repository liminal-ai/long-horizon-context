# Story 0: Extension Foundation

### Summary
<!-- Jira: Summary field -->

Build the walking skeleton for the pi-lhc extension: package scaffold, PI hook registration rail, plain-data-only state holder, stubbed LHC init/dispose seam, corpus fixture loader, and typed fail-closed stubs.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** Establish the loadable extension structure every later story builds on, with no stale PI context retained across hook boundaries and no stub that can fake successful capture.

**Scope In:**

- PI extension entry point and hook registration rail.
- Plain-data-only extension state holder for thread reference, file path, and told-the-user flags.
- Stubbed `initLhc` / dispose seam that later stories replace with real lifecycle behavior.
- Test fixture and corpus-loading harness that can load recorded PI corpora and expected intake-event shapes.
- Typed fail-closed stubs for unimplemented capture, inference, validation, and fork behavior.

**Scope Out:**

- No acceptance criteria from Epic 1 are completed by this story.
- No real thread resolution, event capture, derivation routing, startup validation, fork seeding, or inspect verification behavior.
- No context serving; Epic 1 remains observe-only and registers no `context` hook behavior.

**Dependencies:** None.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

No Epic 1 ACs are owned by Story 0.

**Smoke Test Conditions**

- Extension package loads and registers the PI hook rail.
- Hook handlers can receive fresh PI context objects without retaining them across handler boundaries.
- Stubbed init/dispose seam can be invoked and returns typed fail-closed results for unimplemented behavior.
- Fixture loader reads recorded corpus fixtures and produces structurally valid intake-event expectations.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 0 creates the package rail that later stories fill in. It must load as a PI extension, register the Epic 1 hook handlers, expose typed module boundaries, and keep state as plain data only.

No Epic 1 product AC is completed here. The story proves that the extension can be loaded, that future handlers have fail-closed seams, and that fixture/test utilities exist before behavior stories depend on them.

#### Build Strategy

Strategy: tdd-lite

Reason:
- This is foundation work with no AC owner, but later stories can be reward-hacked if stubs fake success.
- Red should prove fixture invariants, package gates, and load/registration smoke before Green fills the scaffold.

Risk Reminders:
- Stubs must fail closed with typed results and must not return success for unimplemented capture, inference, validation, or fork behavior.
- The state holder shape must make retaining PI context objects impossible in normal use.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Package scaffold | `packages/pi-lhc/package.json`, `packages/pi-lhc/tsconfig*.json`, verification scripts |
| Extension entry | `packages/pi-lhc/src/index.ts` |
| Lifecycle rail | `packages/pi-lhc/src/lifecycle/instance.ts`, `packages/pi-lhc/src/lifecycle/state.ts` |
| Capture/inference/fork stubs | `packages/pi-lhc/src/capture/*`, `packages/pi-lhc/src/inference/*`, `packages/pi-lhc/src/lifecycle/fork.ts` |
| Fixtures | `packages/pi-lhc/test/fixtures/corpus.ts`, `packages/pi-lhc/test/fixtures/synthetic.ts`, `packages/pi-lhc/test/fixtures/model-call.ts`, `packages/pi-lhc/test/fixtures/thread.ts` |

#### Design References

- [tech-design.md §Context](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:35), lines 35-45
- [tech-design.md §Module Architecture](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:143), lines 143-174
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:417), lines 417-531
- [tech-design.md §Fixture Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:555), lines 555-563
- [tech-design.md §Chunk 0](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:635), lines 635-648
- [test-plan.md §Chunk 0](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:140), lines 140-145

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| None | `test/fixtures/corpus.test.ts`, extension-load smoke, package script checks | Foundation has no story-owned TC; smoke checks prove load, hook rail, fail-closed stubs, fixture validity, and verification-script availability. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Fixture validity | `test/fixtures/corpus.test.ts` | Corpus loader yields valid `MessageEventInput` shapes and lifecycle-coherent sequences; named invalid builders produce intended malformed shapes. | Story 0 owns no AC/TC, but later capture tests depend on trustworthy fixtures. |

#### Technical Notes

- Register only the Epic 1 observe-only hook rail; do not add `context` serving behavior.
- Define the interfaces from the tech design as imports from the LHC package where applicable, not local redefinitions.
- Keep `state.ts` complete rather than stubbed: it is the shape that prevents stale PI context retention later.

#### Anti-Shim Requirements

- No stub may report successful capture, derivation, validation, fork seeding, or replay before the owning story implements it.
- Fixture loaders must parse and validate shape; do not hardcode passing fixture counts.

#### Production Path Proof

- Entrypoint: `packages/pi-lhc/src/index.ts` PI extension registration.
- Registration/default path: package load registers the Epic 1 hooks and routes them to fail-closed handlers.
- Evidence: extension-load smoke plus package `red-verify` prove the production entry exports and hook rail compile.

#### Verification

- Targeted: `pnpm --filter pi-lhc red-verify`
- Story gate: `pnpm --filter pi-lhc red-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Extension scaffold loads in PI's extension environment.
- Hook registration rail exists for every PI hook consumed in Epic 1.
- State holder shape stores only plain data.
- Stubbed LHC init/dispose seam is callable and fail-closed.
- Fixture loader can load corpus files and expected intake-event shapes.
- Smoke tests cover load, hook registration, plain-data state, init/dispose seam, and fixture loading.
