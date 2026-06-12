# Story 3: View-Contents Report

### Summary
<!-- Jira: Summary field -->
Expose the stored active view through `threadView.describe` and report view contents with load-cost parity to `pull`.

### Description
<!-- Jira: Description field -->
**User Profile:** The operator audits what the agent actually saw; agents inside a harness use the same read mid-task.

**Objective:** Report stored view bands, gaps, provenance, tail cost, and total load cost without recomputing the view.

**Scope In:** `threadView.describe`, `inspect.view`, `lhc inspect view`, stored snapshot reporting, tail cost as served, load-cost equality with `pull`.

**Scope Out:** No view derivation, repair, mutation, provider invocation, or direct inspect-domain reads of `thread_view` tables.

**Dependencies:** Epic 03 Stories 0-2 landed for view storage and `pull`; Story 2 inspect surface conventions available.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->
- **AC-2.1**: The report names the active view — viewId, createdAt, profile name and resolved config, compactPoint, coveredFrom — and lists every band entry in served order (brief → detailed → smooth): subject kind and id, form used, degraded flag; plus every gap with its reason; plus per-band stored token counts. All of it from the stored snapshot, not recomputed.

- **AC-2.2**: The tail section reports message count and token cost *as currently served*: tool results at-or-behind the visibility boundary are costed at their short form, everything else full.

- **AC-2.3**: `loadCost` totals what `pull` serves now — bands plus tail — and a test asserts equality against an actual pull's measured content. The report never disagrees with the surface it describes.

- **AC-2.4**: A never-compacted thread reports view: null with a tail-only loadCost under the same equality contract (the whole record served as tail).

- **AC-2.5**: The report carries the view's recorded source-state provenance (what the compact saw: max event order, form counts) and is a pure read under AC-1.4's contract.

- **TC-2.1** (AC-2.1, AC-2.5): On a compacted fixture with one degraded entry and one gap → report matches the stored arrangement exactly: subjects, forms used, degraded flags, gap reasons, band token counts, config, provenance.

- **TC-2.2** (AC-2.2, AC-2.3): On a boundary-advanced fixture → tail cost counts short forms short; `loadCost.total` equals the token measure of an actual `pull`'s messages using the same estimator.

- **TC-2.3** (AC-2.4): Never-compacted thread → view null, tail spans the record, cost-parity assertion holds.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->
#### Architecture Context

This story adds the single thread-view surface Epic 04 needs: `threadView.describe`. It exposes the stored active view row from the owning domain so inspect never reads thread-view tables directly.

`inspect.view` combines `describe` and `pull`. The stored arrangement, gaps, config, stored band tokens, and source-state provenance come from `describe`; tail cost comes from measured pull output, making load-cost parity structural.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The story has one governing contract, but `loadCost` can drift if implementers reimplement pull selection or boundary-aware shortening.

Risk Reminders:
- `describe` must return the stored snapshot, not recompute it.
- Never-compacted threads return `meta: null`, empty bands, and tail-only cost.
- `inspect.view` inherits served tail behavior from `pull`.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Thread-view surface | `src/domains/thread-view/index.ts` |
| Inspect internals | `src/domains/inspect/internal/view-report.ts` |
| Inspect surface | `src/domains/inspect/index.ts` |
| Shared shapes | `src/shared/inspect.ts` |
| CLI/SDK | `src/cli/inspect.ts`, `src/sdk.ts` |
| Tests | `test/inspect-view.test.ts` |

#### Design References

- [tech-design.md §Spec Validation](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:12), lines 12-22
- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:54), lines 54-98
- [tech-design.md §Storage](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:100), lines 100-102
- [tech-design.md §Flow 2: View Contents Report](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:125), lines 125-137
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:151), lines 151-213
- [test-plan.md §TC → Test Mapping](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:20), lines 20-40
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:42), lines 42-50
- [test-plan.md §Chunk Red/Green Detail](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:56), lines 56-64

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.1 | `test/inspect-view.test.ts :: arrangement fidelity` | Report entries, forms, degraded flags, gap reasons, config, and provenance equal `describe` output and stored row. |
| TC-2.2 | `test/inspect-view.test.ts :: loadCost parity on boundary-advanced fixture` | Tail costs short forms short and total equals estimator over an independent pull. |
| TC-2.3 | `test/inspect-view.test.ts :: never-compacted` | `meta: null`, empty bands, tail spans the record, and cost parity holds. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Load cost drifts from served reality | `test/inspect-view.test.ts` independent-pull leg | Measure report total against a second pull's served messages. | A report can look plausible while disagreeing with what agents actually receive. |
| Inspect reads thread-view storage directly | `check-boundaries` plus source check | Inspect must consume `threadView.describe` and `threadView.pull`. | Direct table reads could pass fixture assertions while violating ownership. |
| Describe mutates or recomputes | `test/inspect-view.test.ts` describe legs and read-only delta helper | Null/shape behavior and before/after state equality are asserted. | Stored snapshot fidelity requires source and side-effect checks, not just output fields. |

#### Technical Notes

- `threadView.describe` returns ok/null for absent views.
- `inspect.view` should not recompute arrangement, form choice, gaps, or source-state provenance.
- `loadCost.bandTokens` sums stored band counts; tail tokens are measured from pull's served tail.

#### Anti-Shim Requirements

- Compare report content to stored row data and to independent pull output.
- Do not fake parity by sharing a helper that bypasses `pull`.
- Do not create new storage or migration to support this read.

#### Production Path Proof

- Entrypoint: `threadView.describe`, `inspect.view`, `lhc inspect view`.
- Registration/default path: `src/sdk.ts` exposes `threadView.describe` and inspect view; `src/cli/inspect.ts` routes `view` to SDK.
- Evidence: default-suite inspect-view tests plus process checkpoint parity in the lifecycle story.

#### Verification

- Targeted: `pnpm verify`
- Story gate: `pnpm verify`
- Epic/process gate: `LHC_PROCESS_SUITE=1 pnpm verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->
- `threadView.describe` exposes the stored active view row read-only and returns null when absent.
- `inspect.view` reports stored bands, gaps, config, provenance, tail, and loadCost.
- `loadCost.total` equals measured `pull` content for compacted and never-compacted threads.
- `lhc inspect view` returns SDK-parity JSON.
- TC-2.1 through TC-2.3 pass with one primary owner in this story.
