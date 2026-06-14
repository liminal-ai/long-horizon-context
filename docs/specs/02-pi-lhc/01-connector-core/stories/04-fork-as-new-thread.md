# Story 4: Fork as New Thread

### Summary
<!-- Jira: Summary field -->

Create a new LHC thread for a fork, seed it by replaying the source to the fork point, and leave the source thread unchanged.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** A fork becomes a new thread whose read-back matches the source through the fork point, while the source thread receives no writes.

**Scope In:**

- Fork detection using `session_before_fork` when present, with PI's session tree as Epic 1 fallback evidence.
- New thread creation for the fork.
- Replay seeding from the source thread through the fork point.
- Source-thread immutability checks.
- Derived-form reuse when provenance identity proves reuse safe, with requeue when it cannot.

**Scope Out:**

- Permanent fork lineage metadata in LHC thread metadata; that belongs to Feature 2+.
- Treating PI's fork reason code as authoritative; recon found print-mode `--fork` can report `startup`.
- Context serving.

**Dependencies:** Story 2 for replayable capture; Story 1 for new thread creation and thread resolution.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-3.1:** Forking a PI session creates a new LHC thread. The source thread receives no writes — it is unchanged by the fork.

**TC-3.1** — Fork creates a new thread; the source thread receives no writes — its logical read-back (events, messages, turns) is unchanged. Detection resolves the fork point from the `session_before_fork` hook, with PI's session tree as available fallback evidence in Epic 1, not from a fork reason code.

**AC-3.2:** The new thread is seeded by replaying the source thread's recorded events up to the fork point. The seeded thread's read-back (events, messages, turns) matches the source's read-back through that point.

**TC-3.2** — Fork replay seeds the new thread; read-back matches the source through the fork point.

**AC-3.3:** Derived forms may be reused from the source thread when provenance identity proves the reuse safe; when safety cannot be proven, the affected derivations requeue on the new thread. The forked thread's read-back is correct under either path.

**TC-3.3** — Fork with safe provenance reuses derived forms; fork with unprovable provenance requeues them; both yield a correct thread.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Fork is the one Epic 1 path where a new LHC thread is created during a run instead of being selected at launch. The fork target is seeded by replaying source-thread events through the normal intake path up to the fork point.

The source thread is read-only during fork seeding. For v1, derived forms are not copied; the forked thread requeues derivations because provenance-safe reuse is deferred.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- Fork combines detection, new thread creation, replay seeding, source immutability, and derivation queue behavior.
- The source-vs-target authority boundary needs explicit red coverage before implementation.

Risk Reminders:
- Do not trust `session_start.reason` as the fork signal; print-mode fork can report `startup`.
- Source immutability is logical read-back equality, not SQLite byte equality.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Fork detection/seeding | `packages/pi-lhc/src/lifecycle/fork.ts` |
| Thread creation | `packages/pi-lhc/src/lifecycle/thread-resolution.ts`, LHC `threads` operations |
| Replay intake | `packages/pi-lhc/src/capture/converter.ts`, `packages/pi-lhc/src/verify/replay.ts` as reusable harness where appropriate |
| Tests | `packages/pi-lhc/test/lifecycle/fork.test.ts` |

#### Design References

- [epic.md §Flow 3](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:183), lines 183-191
- [tech-design.md §Issues Found](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:18), lines 18-31
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:187), line 187
- [tech-design.md §Flow 3](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:331), lines 331-355
- [tech-design.md §Derived-State Provenance](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:565), lines 565-568
- [tech-design.md §Chunk 4](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:662), lines 662-664
- [test-plan.md §Fork Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:80), lines 80-86
- [test-plan.md §Chunk 4](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:168), lines 168-173

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-3.1 | `test/lifecycle/fork.test.ts` | Fork creates a new thread, resolves the fork point from hook data with Epic 1 fallback evidence, and leaves source logical read-back unchanged. |
| TC-3.2 | `test/lifecycle/fork.test.ts` | Fork target is seeded by replay and read-back matches the source through the fork point. |
| TC-3.3 | `test/lifecycle/fork.test.ts` | V1 requeues forms on the fork target and does not copy source derived forms; the target read-back remains correct. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Source vs Derived Truth | `test/lifecycle/fork.test.ts` | After fork, source thread read-back is unchanged and target forms requeue. | A fork can appear correct while seeding mutates source or copies derived state with wrong provenance. |

#### Technical Notes

- Prefer `session_before_fork` `entryId` / `position` for fork point detection.
- PI's own thread tree is Epic 1 fallback evidence only; long-term fork lineage belongs in LHC thread metadata.
- Replay seeding should use the same intake path normal capture uses.

#### Anti-Shim Requirements

- Do not seed by copying SQLite files or persisted rows directly.
- Do not copy derived forms in v1; requeue them on the fork target.
- Do not prove source immutability with file byte equality; use logical read-back.

#### Production Path Proof

- Entrypoint: `session_before_fork` and fork-related lifecycle routing through `index.ts`.
- Registration/default path: fork detection creates a new thread and replays source events to the fork point through LHC intake.
- Evidence: fork tests assert new target thread, unchanged source read-back, target read-back through fork point, and derived-form requeue.

#### Verification

- Targeted: `pnpm --filter pi-lhc verify -- test/lifecycle/fork.test.ts`
- Story gate: `pnpm --filter pi-lhc green-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

- The epic permits derived-form reuse when provenance identity proves it safe. The tech design narrows v1 to always requeue because the provenance-identity safety check does not exist yet.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All Flow 3 ACs and TCs pass.
- Fork creates a new thread and never writes the source thread.
- Replay seeding matches source read-back through the fork point.
- Derived forms are reused only when provenance proves safe; otherwise they requeue.
- Behavior does not depend on fork reason code.
