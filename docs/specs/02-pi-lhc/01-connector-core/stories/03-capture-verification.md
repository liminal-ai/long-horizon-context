# Story 3: Capture Verification

### Summary
<!-- Jira: Summary field -->

Verify capture by replaying recorded PI corpora through the converter and matching deterministic thread read-back and inspect surfaces.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** Prove capture correctness from recorded corpora without serving context to a model.

**Scope In:**

- Corpus replay through the Story 2 converter.
- Read-back comparison for events, messages, and turns.
- Deterministic re-replay assertions for IDs and ordering.
- Inspect overview and health assertions for counts, last recorded position, gaps, and failed derivations.

**Scope Out:**

- Creating M0 corpora. This story consumes M0 corpora as fixtures.
- Context serving; Epic 1 remains observe-only.
- Derivation quality tuning.

**Dependencies:** Story 2. M0 corpora are fixture inputs.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-6.1:** Replaying a recorded PI corpus through the converter produces a thread whose read-back — events, messages, and turns — matches the fixture's expectation, including the chatty, tool-heavy, parallel-tool, error-result, and aborted-turn corpora.

**TC-6.1** — Each corpus (chatty, tool-heavy, parallel-tool, error-result, aborted-turn) replays to a thread whose read-back matches the fixture.

**AC-6.2:** Replay is deterministic: the same corpus replayed twice produces identical thread read-back. The deterministic-ID property holds through the converter, so a re-replay does not perturb IDs or ordering.

**TC-6.2** — The same corpus replayed twice yields identical read-back (IDs and order stable).

**AC-6.3:** inspect surfaces (overview, health) reflect the captured session: event and message counts, the last recorded event position, and any capture gaps or failed derivations are visible rather than hidden.

**TC-6.3** — inspect overview/health report event/message counts, last event position, and any gaps or failed derivations.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 3 is the proof layer for capture. It replays recorded PI corpora through the real converter and LHC intake path, then compares the thread read-back without serving context to a model.

The story also verifies inspect overview and health surfaces used by Epic 1 verification. Operator commands and self-inspection tools remain outside this story.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The implementation is narrow, but fixture fidelity and deterministic replay are easy to fake with shallow comparisons.
- Red should pin exact read-back comparison and deterministic replay before Green implements the replay harness.

Risk Reminders:
- M0 corpora breadth determines final fixture coverage; the replay machinery should widen as corpora arrive.
- Replay must use the real converter and intake path, not a parallel expected-event builder.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Replay harness | `packages/pi-lhc/src/verify/replay.ts` |
| Corpus fixtures | `packages/pi-lhc/test/fixtures/corpus.ts` |
| Temp threads | `packages/pi-lhc/test/fixtures/thread.ts` |
| Verification tests | `packages/pi-lhc/test/verify/replay.test.ts`, `packages/pi-lhc/test/fixtures/corpus.test.ts` |
| Inspect reads | LHC `inspect` overview/health APIs consumed by `verify/replay.ts` |

#### Design References

- [epic.md §Flow 6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:227), lines 227-235
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:196), lines 196-198
- [tech-design.md §Flow 6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:405), lines 405-413
- [tech-design.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:535), lines 535-549
- [tech-design.md §Fixture Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:555), lines 555-563
- [tech-design.md §Chunk 3](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:658), lines 658-660
- [test-plan.md §Replay Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:120), lines 120-132
- [test-plan.md §Chunk 3](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:161), lines 161-166

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-6.1 | `test/verify/replay.test.ts` | Each available recorded corpus replays through the converter to a thread whose events, messages, and turns match fixture expectation. |
| TC-6.2 | `test/verify/replay.test.ts` | Replaying the same corpus twice yields identical read-back, including deterministic IDs and order. |
| TC-6.3 | `test/verify/replay.test.ts` | Inspect overview/health report event/message counts, last recorded position, gaps, and failed derivations. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Fixture validity | `test/fixtures/corpus.test.ts` | Corpus loader yields valid `MessageEventInput` shapes and lifecycle-coherent sequences. | Replay tests can pass against bad fixtures unless the fixture substrate is checked independently. |

#### Technical Notes

- `replayCorpus(corpus, threadRef)` should return a structured compare result with a readable diff.
- Run replay against a real temp SQLite thread through the converter and intake path.
- Inspect checks consume overview/health only; do not introduce operator surfaces here.

#### Anti-Shim Requirements

- Do not compare only counts for replay equality; compare events, messages, turns, IDs, and order.
- Do not bypass Story 2's converter by writing expected events directly to the thread.

#### Production Path Proof

- Entrypoint: `packages/pi-lhc/src/verify/replay.ts`.
- Registration/default path: tests feed recorded corpora into the same converter/intake path used by live capture.
- Evidence: replay tests assert read-back equality, deterministic re-replay, and inspect health/overview visibility.

#### Verification

- Targeted: `pnpm --filter pi-lhc verify -- test/verify/replay.test.ts test/fixtures/corpus.test.ts`
- Story gate: `pnpm --filter pi-lhc green-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All Flow 6 ACs and TCs pass.
- Fixture replay compares events, messages, and turns for all available M0 corpora.
- Re-replay is deterministic.
- Inspect overview and health expose the required capture state.
- Verification does not serve any context to a model.
