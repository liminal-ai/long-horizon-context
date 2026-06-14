# Story 1: Session Lifecycle and Thread Resolution

### Summary
<!-- Jira: Summary field -->

Resolve the recording thread from launch input, initialize and dispose one LHC instance per run, reconstruct after reload, and preserve plain-data-only extension state.

### Description
<!-- Jira: Description field -->

**User Profile:** A developer using PI as their daily coding agent, with the `pi-lhc` extension loaded.

**Objective:** The right LHC thread is selected from the operator's launch choice and found again across reload and restart, with no PI-session-to-thread mapping record to drift.

**Scope In:**

- `initLhc` initialization in background scheduler mode.
- `session_shutdown` flush and cleanup.
- Launch-driven thread resolution through the registry: new thread, `--session <id>` full/partial id, `--continue` / `-c`, and `--resume` / `-r` cwd-scoped picker.
- A-8 LHC registry additions required for this story: `cwd`, cwd-filtered `listThreads`, partial-id `resolve`, and `title`.
- Reload reconstruction from durable resolved thread id.
- Plain-data-only state across hooks.

**Scope Out:**

- Event capture and turn derivation.
- Fork seeding.
- Context serving; PI's native context handling remains unchanged.

**Dependencies:** Story 0.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-1.1:** On `session_start` with no thread-selecting launch flag, the extension creates a new LHC thread (registering it in the catalog with its cwd), initializes one LHC instance in background scheduler mode against it, and does not drive the derivation queue itself.

**TC-1.1** — Fresh `session_start` with no thread-selecting launch flag: one LHC instance initialized in background mode, one new registry thread created with cwd/title metadata, and no PI-session-to-thread mapping record created.

**AC-1.2:** On `session_start` that resolves to an existing thread (via `--continue`, `--session`, or a picker selection), the extension initializes against that thread by resolving it through the registry. No second thread is created for an already-resolved thread.

**TC-1.2** — `session_start` with launch input resolving an existing registry thread: initializes against that same thread and creates no second thread.

**AC-1.3:** Across all hooks, the extension holds only plain data (thread reference, file path, told-the-user flags) between events. It retains no PI context or session-manager object across hook boundaries; each handler uses the fresh context PI provides. A session replacement (new/resume/fork) that invalidates prior context objects does not break capture.

**TC-1.3** — A session replacement invalidates the prior context object; the extension, holding only plain data, continues capture using the fresh context.

**AC-1.4:** On `session_shutdown`, the extension disposes the LHC instance with flush and cleanup. A subsequent run that resolves the same thread finds it complete through the last event recorded before shutdown — no trailing loss.

**TC-1.4** — `session_shutdown` disposes with flush; reattach finds the thread complete through the last pre-shutdown event.

**AC-1.5:** On reload (extension torn down and re-initialized while the same session continues), the extension reconstructs the thread reference from durable state (the resolved thread id), not from retained in-memory objects, and capture continues on the same thread.

**TC-1.5** — Reload re-initializes the extension; thread reference reconstructed from the resolved thread id; capture continues on the same thread.

**AC-1.6:** Launch resolves the thread by mode: no flag creates a new thread; `--session <id>` resolves a named thread by full or partial id; `--continue`/`-c` resolves the most recently created thread; an ambiguous or unresolvable id fails with an actionable message rather than silently creating a new thread.

**TC-1.6** — Launch by mode resolves correctly: no flag creates a new thread; `--session` resolves by full and by partial id; `--continue` resolves the most recent; an ambiguous/unresolvable id fails with an actionable message and creates no thread.

**AC-1.7:** `--resume`/`-r` lists threads scoped to the current working directory, each shown with its title and creation time, and resolves the operator's selection. With no threads for the cwd, the picker reports an empty list rather than failing.

**TC-1.7** — `--resume` lists cwd-scoped threads with title and creation time and resolves a selection; an empty cwd lists nothing rather than failing.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story owns the session lifecycle surface for Epic 1. The LHC thread is resolved from launch input through the registry, then one LHC instance is initialized in background mode against that resolved thread.

PI still runs normally in this observe-only epic; LHC records alongside it. The connector stores only plain data between hooks and rebuilds from the resolved thread id on reload.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- Launch modes, registry additions, reload behavior, and shutdown flushing all share the thread identity invariant.
- A-8 registry work is implementation scope for this story and must land before the launch-mode checks can pass.

Risk Reminders:
- The registry is the catalog: no separate PI-thread mapping record is introduced.
- `--session` ambiguity or miss returns an actionable error and creates no new thread.
- `--resume` must be cwd-scoped and titled; an unscoped picker does not satisfy the story.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| LHC registry support | `packages/lhc/src/**` registry/thread catalog modules for `cwd`, `title`, partial-id resolve, and cwd-filtered listing |
| Instance lifecycle | `packages/pi-lhc/src/lifecycle/instance.ts` |
| Thread resolution | `packages/pi-lhc/src/lifecycle/thread-resolution.ts` |
| Resume picker | `packages/pi-lhc/src/lifecycle/picker.ts` |
| Plain state | `packages/pi-lhc/src/lifecycle/state.ts` |
| Hook routing | `packages/pi-lhc/src/index.ts` |
| Tests | `packages/pi-lhc/test/lifecycle/instance.test.ts`, `packages/pi-lhc/test/lifecycle/thread-resolution.test.ts` |

#### Design References

- [epic.md §Onboarding Context](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:13), lines 13-18
- [epic.md §Assumptions](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:87), lines 87-99
- [epic.md §Flow 1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/epic.md:103), lines 103-141
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:180), lines 180-186
- [tech-design.md §Flow 1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:229), lines 229-270
- [tech-design.md §Chunk 1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/tech-design.md:650), lines 650-652
- [test-plan.md §Lifecycle Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:32), lines 32-47
- [test-plan.md §Chunk 1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core/test-plan.md:147), lines 147-152

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-1.1 | `test/lifecycle/instance.test.ts` | Fresh launch creates one cwd/titled registry thread and one background LHC instance; connector does not drive the queue. |
| TC-1.2 | `test/lifecycle/thread-resolution.test.ts` | Existing launch resolves through registry and creates no second thread. |
| TC-1.3 | `test/lifecycle/thread-resolution.test.ts` | Fresh PI context objects across hooks do not break capture; retained holder contains no prior context object. |
| TC-1.4 | `test/lifecycle/instance.test.ts` | Shutdown flushes; re-resolving the thread sees every pre-shutdown event. |
| TC-1.5 | `test/lifecycle/thread-resolution.test.ts` | Reload discards in-memory holder, resolves the same thread id from registry, and continues on that thread. |
| TC-1.6 | `test/lifecycle/thread-resolution.test.ts` | No flag, full id, partial id, continue, and bad id resolve exactly as specified; bad id creates no thread. |
| TC-1.7 | `test/lifecycle/thread-resolution.test.ts` | Resume picker lists only current-cwd threads with title and creation time; empty cwd returns an empty selection state. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Persistence / Restart | `test/lifecycle/thread-resolution.test.ts` | Discard the in-memory holder, re-resolve the same thread by id from the registry, then capture continues on it. | The AC says reload reconstructs; this proves it survives process loss without retained PI objects. |

#### Technical Notes

- Use `threads.newThread`, `threads.resolve`, `threads.listThreads`, and `threads.resolveThreadRef`; `registryPath` is a per-operation argument, not an `initLhc` config field.
- Initialize LHC in background mode and never call `drainSettled` as part of normal session startup.
- Store only thread reference, file path/resolved id, health, and told-the-user flags between hook invocations.

#### Anti-Shim Requirements

- Do not synthesize cwd scoping in the picker by filtering display-only data after an unscoped registry list; the registry operation must support the cwd filter.
- Do not silently create a new thread for an unresolvable or ambiguous named id.

#### Production Path Proof

- Entrypoint: `session_start`, `session_shutdown`, and reload handling through `packages/pi-lhc/src/index.ts`.
- Registration/default path: launch flags route to `thread-resolution.ts` / `picker.ts`; resolved thread initializes `instance.ts` in background mode.
- Evidence: lifecycle tests assert registry rows, resolved thread id, no second thread, flush after shutdown, and reload after holder discard.

#### Verification

- Targeted: `pnpm --filter pi-lhc verify -- test/lifecycle/instance.test.ts test/lifecycle/thread-resolution.test.ts`
- Story gate: `pnpm --filter pi-lhc green-verify`
- Epic gate: `pnpm --filter pi-lhc verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All Flow 1 ACs and TCs pass.
- LHC registry supports the A-8 fields and operations needed by AC-1.6 and AC-1.7.
- Launch modes create or resolve the correct registry thread.
- Reload reconstructs from resolved thread id.
- Shutdown flushes and disposes the LHC instance.
- Tests prove no retained PI context object is required across session replacement.
