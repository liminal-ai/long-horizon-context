# Story 4: Lifecycle Exercise

### Summary
<!-- Jira: Summary field -->
Add the full-surface lifecycle exercise in PI-extension call order across SDK, replay, teardown, and CLI parity legs.

### Description
<!-- Jira: Description field -->
**User Profile:** The future PI extension calls the SDK surfaces in the sequence this exercise rehearses; the operator uses CLI reads at checkpoints.

**Objective:** Exercise every built v1 surface through one deterministic sequence and verify contract coherence across epics.

**Scope In:** Scripted sequence: create thread → intake multi-turn tool-heavy batches → background drain settles → status → compact (profile) → pull → inspect (overview, view, health) → edit + delete → rebuild drains → health confirms → second compact → pull → materialize.

**Scope Out:** This story does not prove real-inference readiness. No real network or real-provider call is allowed. Quality review of deterministic-provider output remains outside this epic.

**Dependencies:** Stories 1-3 complete; Epic 03 complete.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->
- **AC-5.1**: The full sequence completes through one real SDK configuration with the deterministic provider: every operation returns ok, zero network, zero real-provider calls.

- **AC-5.2**: Checkpoint coherence: post-compact pull serves bands + tail; post-mutation health shows the cleared set pending; post-drain health shows it ready; the second compact's view reflects post-edit content; the second compact receipt's sweep section agrees with the health report taken immediately before it.

- **TC-5.1** (AC-5.1, AC-5.2): Scripted lifecycle with checkpoint assertions at each named step; receipt-vs-health cross-check exact.

- **AC-5.3**: End-to-end determinism: the whole sequence replayed on a fresh thread produces byte-identical pull outputs, and a materialized file that is byte-identical after normalizing only the intentionally random thread id (threads design decision 7) — the two runs' thread ids must differ and every other byte must be exact. Pull outputs carry no thread id, so their equality stays literal with no normalization. (See Spec Deviations: ruling-011.)

- **TC-5.2** (AC-5.3): Replay on a fresh thread → literal hash equality on every pull output; materialized-file hash equality after substituting only the random thread id, asserting the two thread ids differ and every other byte is exact.

- **AC-5.4**: No in-memory dependency: tearing down the SDK instance between phases and continuing on a fresh `createSdk` yields the same end state as the uninterrupted run — final pull byte-identical and health deep-equal; the materialized file byte-identical after normalizing only the random thread id (the teardown run is itself a fresh thread, so its id differs and every other byte must be exact). (See Spec Deviations: ruling-011.)

- **TC-5.3** (AC-5.4): Teardown and recreate the SDK between intake/compact/mutation phases → final pull and health identical to TC-5.1's, and the materialized file hash-equal after substituting only the random thread id (every other byte exact).

- **AC-5.5**: Operator parity: inspect and view reads driven through the spawned CLI at checkpoints return the same JSON as the in-process SDK calls at those checkpoints.

- **TC-5.4** (AC-5.5): Process-suite leg: spawned CLI inspect/view/messages reads at three checkpoints equal the in-process results.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->
#### Architecture Context

This story adds the shared lifecycle fixture and the full-surface verification legs. It introduces no production surface; it proves the built SDK and CLI surfaces work in PI-extension call order with deterministic provider setup only.

The lifecycle script names phases and returns results to tests. Assertions stay in tests so replay, teardown, and process legs drive the same sequence without re-describing it.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The story coordinates all prior surfaces, persistence reopen behavior, deterministic replay, materialization, and spawned CLI checkpoints.

Risk Reminders:
- This is a seam proof, not a real-inference gate.
- Teardown must create a fresh SDK between phase groups.
- Process suite must report `ran`; missing auth or process prerequisites must not silently skip.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Lifecycle helper | `test/fixtures/lifecycle.ts` |
| Default lifecycle tests | `test/lifecycle.test.ts` |
| Process checkpoint tests | `test/cli-process-inspect.test.ts` |
| Consumed SDK/CLI surfaces | `src/sdk.ts`, `src/cli/inspect.ts`, `src/cli/messages-read.ts` |

#### Design References

- [tech-design.md §Context](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:6), lines 6-10
- [tech-design.md §Flow 5: Lifecycle Exercise](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:147), lines 147-149
- [tech-design.md §Testing Strategy](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:215), lines 215-217
- [tech-design.md §Work Breakdown](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:219), lines 219-230
- [test-plan.md §Test Files](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:6), lines 6-18
- [test-plan.md §TC → Test Mapping](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:20), lines 20-40
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:42), lines 42-50
- [test-plan.md §Suite Accounting](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:52), lines 52-54
- [test-plan.md §Verification](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:66), lines 66-68

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-5.1 | `test/lifecycle.test.ts :: full sequence + checkpoints` | Every phase returns ok; pull/health/compact/materialize checkpoints agree field-for-field where required. |
| TC-5.2 | `test/lifecycle.test.ts :: replay determinism` | Fresh-thread replay: literal hash-equal pull outputs; materialized file hash-equal after normalizing only the random thread id (ids asserted to differ, every other byte exact). |
| TC-5.3 | `test/lifecycle.test.ts :: teardown continuity` | Fresh SDK between phase groups: final pull and health equal to the uninterrupted run; materialized file hash-equal after normalizing only the random thread id. |
| TC-5.4 | `test/cli-process-inspect.test.ts :: checkpoint parity` | Spawned CLI overview/view/list reads at checkpoints deep-equal in-process SDK results. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Cross-epic lifecycle order drift | `test/lifecycle.test.ts` named-phase checkpoints | Run create, intake, drain, status, compact, pull, inspect, mutate, rebuild, compact, pull, materialize in order. | Individual story tests cannot catch ordering mismatches between surfaces. |
| Persistence relies on memory | `test/lifecycle.test.ts` fresh-SDK hook | Recreate SDK between phase groups and compare final outputs. | In-process success can hide state stored only in runtime memory. |
| CLI production path drift | `test/cli-process-inspect.test.ts` process checkpoint leg | Spawn real commands and compare JSON to SDK checkpoints. | SDK tests do not prove command registration, stdout, or argv mapping. |

#### Technical Notes

- `test/fixtures/lifecycle.ts` owns the sequence and phase names; tests own assertions.
- The receipt-vs-health check compares the second compact receipt sweep section with the health snapshot taken immediately before compact.
- Quality review of deterministic-provider text remains outside this epic.

#### Anti-Shim Requirements

- Use the real SDK configuration with deterministic provider and zero network/real-provider calls.
- Use real fresh SDK construction for teardown continuity.
- Use spawned CLI commands for checkpoint parity; do not call CLI handlers directly.

#### Production Path Proof

- Entrypoint: SDK surfaces from Epics 01-04 and spawned `lhc` commands.
- Registration/default path: the helper drives public SDK operations; process leg drives registered CLI commands.
- Evidence: lifecycle default tests, teardown continuity, replay determinism, and process checkpoint parity.

#### Verification

- Targeted: `pnpm verify`
- Story gate: `pnpm verify`
- Epic/process gate: `LHC_PROCESS_SUITE=1 pnpm verify-all`

#### Spec Deviations

**Ruling-011** (`04-lifecycle-exercise-story-run-001-ruling-011`) — decision: *accept threadId-normalized materialized-file equality and update story spec*. Refines the materialized-**file** half of AC-5.3 and AC-5.4; pull-output equality is unaffected.

- **Context.** A thread's id is the design's one intentionally random value (threads design decision 7), and the PI session header embeds it (`id: "<threadId>:<timestamp>"`). Two real threads created through the public surface can never share an id, so a fresh-thread materialized file can never be *literally* byte-identical without injecting a test-only id seam into production thread creation — exactly the shim the anti-shim rules forbid.
- **Accepted contract (TC-5.2 replay, TC-5.3 teardown).** Compare the two materialized files after substituting **only** the random thread id with a fixed placeholder; assert the two thread ids actually differ; require every other byte identical. Nothing else is normalized.
- **Pull outputs stay literal.** Pull payloads carry no thread id, so their hash equality is asserted with zero normalization — the unweakened end-to-end determinism proof.
- **Not a weakening.** The single sanctioned substitution plus "ids differ" and "every other byte exact" is strictly stronger than an unguarded file compare; it preserves AC-5.3's intent (determinism of all derived content) while respecting the one designed source of randomness. The lifecycle assertions in `test/lifecycle.test.ts` are unchanged in strength.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->
- The scripted lifecycle runs through one SDK configuration with deterministic provider only.
- Checkpoint assertions cover pull, health, compact receipt, rebuild, and materialized output.
- Replay on a fresh thread produces byte-identical pull outputs and a materialized file byte-identical after normalizing only the intentionally random thread id (ruling-011).
- SDK teardown between phases produces the same final state as uninterrupted execution.
- Spawned CLI checkpoint reads match in-process SDK JSON.
- TC-5.1 through TC-5.4 pass with one primary owner in this story.
