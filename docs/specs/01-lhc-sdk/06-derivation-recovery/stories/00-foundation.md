# Story 0: Foundation

### Summary
<!-- Jira: Summary field -->

Rename derivation vocabulary and add the durable logging write/query surface.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** establish the shared derivation vocabulary and diagnostic channel before recovery flows write fallback events.

**Scope In:**
- Rename `form` / `derived_form` / `FormKind` / `DerivedFormState` to `derivation` / derivation type / state across code and schema.
- Add durable log storage with levels, actionable fields, write containment, and query by actionable fields.
- Expose one externally callable write method used by LHC internals and the host extension.

**Scope Out:**
- Runtime surfacing mechanics in pi-lhc.
- Treating fallback events as derivation state.

**Dependencies:** none.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-5.1:** The logging capability records entries at info, warning, and error levels to durable storage.

- **TC-5.1a:** Levels stored
  - Given: entries written at each level
  - When: storage is read
  - Then: all three are persisted with their level

**AC-5.2:** A single write method is exposed externally so both LHC internals and the host extension write through the same surface.

- **TC-5.2a:** Shared write surface
  - Given: a write from an LHC internal caller and a write from an external caller
  - When: both are issued
  - Then: both land through the same method into the same store

**AC-5.3:** A fallback *event* is recorded only in the log. The canonical subject (message/turn/chunk content) and any `ready` derivation output carry no degraded/fallback marker. This does not erase derivation state: a `failed` or `blocked` derivation keeps its state and reason on its own record (inspectable per Epic 04) — that is the derivation's state channel, distinct from the fallback-event log channel.

- **TC-5.3a:** Subject and ready output stay clean
  - Given: a derivation fell back during construction
  - When: the canonical subject and the produced rendering are read
  - Then: neither carries a degraded flag; the fallback *event* exists only in the log
- **TC-5.3b:** Failed state still on the derivation record
  - Given: a derivation terminally failed
  - When: its derivation record is read (not the subject)
  - Then: it shows `failed` with a reason, independent of any log entry

**AC-5.4:** Log entries are queryable by the fields that make them actionable (level, derivation type, subject id, reason).

- **TC-5.4a:** Query by fields
  - Given: a store with mixed entries
  - When: queried by level and derivation type
  - Then: only matching entries are returned

**AC-5.5:** A logging write never blocks or fails the operation that produced it; a logging failure is contained.

- **TC-5.5a:** Logging failure contained
  - Given: the logging store write fails
  - When: it happens during a turn construction
  - Then: the construction still completes and the logging failure does not propagate

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 0 establishes the shared vocabulary and logging surface that later recovery stories depend on. The rename is a v7 persisted-schema migration from form naming to derivation naming; the behavior gate is the existing suite staying green under the renamed vocabulary.

The logging capability is a domain-blind tech-util with public SDK exposure. LHC internals and the host both use `lhc.logging.write(...)`; operators and host code query through `lhc.logging.query(...)`. The log stores fallback events and diagnostics only. Derivation state and reason stay on derivation rows.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The rename touches schema, public types, work-queue vocabulary, and existing tests.
- The logging surface adds durable storage, public SDK export, write containment, and query behavior.

Risk Reminders:
- Migration/compatibility: v7 renames table/column and type names once.
- Persistence/restart: log entries must persist in the thread DB and be queryable after reopen.
- Cross-story contract change: Story 0 provides the log surface but does not own recovery fallback behavior.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Derivation vocabulary | `packages/lhc/src/shared/derivation.ts`, `packages/lhc/src/shared/storage.ts` |
| Logging tech-util | `packages/lhc/src/tech-utils/logging/index.ts` (NEW per tech design) |
| Public SDK export | `packages/lhc/src/sdk.ts` |
| Existing work-queue references | `packages/lhc/src/tech-utils/work-queue/index.ts` |
| Logging tests | `packages/lhc/test/logging-surface.test.ts` (planned) |
| Rename safety tests | Existing `packages/lhc/test/*.test.ts` suite |

#### Design References

- [tech-design.md §Context](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:10), lines 10-27
- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:61), lines 61-81
- [tech-design.md §DD-1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:87), lines 87-89
- [tech-design.md §DD-5](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:127), lines 127-129
- [tech-design.md §Log surface](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:189), lines 189-212
- [test-plan.md §Flow 5](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:100), lines 100-109
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:121), lines 121-135
- [test-plan.md §Per-Chunk Red/Green Exit Criteria](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:139), lines 139-148

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-5.1a | `packages/lhc/test/logging-surface.test.ts` | Writing info, warning, and error entries persists all three levels. |
| TC-5.2a | `packages/lhc/test/logging-surface.test.ts` | Internal caller and external SDK caller write through the same `lhc.logging.write` surface into the same store. |
| TC-5.3a | `packages/lhc/test/logging-surface.test.ts` | A fallback event is present only in the log; canonical subject and ready rendering have no degraded flag. |
| TC-5.3b | `packages/lhc/test/logging-surface.test.ts` | Terminal failed derivation still reads as `failed` with reason on the derivation row, independent of log entries. |
| TC-5.4a | `packages/lhc/test/logging-surface.test.ts` | Query by level and derivation type returns only matching log entries. |
| TC-5.5a | `packages/lhc/test/logging-surface.test.ts` | Logging write failure during turn construction is contained and does not fail construction. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Rename safety | `cd packages/lhc && pnpm run verify-all` | Existing suite passes under renamed vocabulary and v7 migration. | Logging TCs do not prove the mechanical rename preserved prior behavior. |
| Log never rolls back work | `packages/lhc/test/logging-surface.test.ts` | Inject logging-store failure and assert the producing operation still completes. | A simple write/read test would not prove failure containment. |
| Public surface registration | `packages/lhc/test/logging-surface.test.ts` | Import SDK and call `lhc.logging.write/query` instead of private helpers. | Private-module tests can pass while production SDK export is missing. |

#### Technical Notes

- `tech-utils/logging/` is domain-blind. It stores levels and fields; it never interprets derivation meaning and never reads or writes derivation rows.
- `writeLog` is fail-soft and must not share the caller's transaction.
- Rename work must preserve behavior. The rename **renames but retains** `tool_call_summary` in the kind set (so the existing suite stays green); its **removal is Story 2's** (AC-2.5). Do not drop `tool_call_summary` in this story.

#### Anti-Shim Requirements

- Do not satisfy logging through an in-memory array or process-local singleton.
- Do not expose only private `writeLog/queryLog` helpers; verify the public `lhc.logging.write/query` path.
- Do not add degraded/fallback markers to canonical subjects or ready derivation outputs.

#### Production Path Proof

- Entrypoint: `packages/lhc/src/sdk.ts` exporting `logging`.
- Registration/default path: package consumers import the SDK and call `lhc.logging.write(...)` / `lhc.logging.query(...)`.
- Evidence: `packages/lhc/test/logging-surface.test.ts` exercises SDK-level logging calls and `cd packages/lhc && pnpm run verify-all` passes after the rename.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/logging-surface.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Derivation vocabulary rename is complete across schema, types, work-queue kinds, and tests.
- AC-5.1 through AC-5.5 pass with their listed TCs.
- Logging write failure is contained.
- Log entries are queryable by actionable fields.
- No fallback marker is added to canonical subjects or `ready` derivation outputs.
