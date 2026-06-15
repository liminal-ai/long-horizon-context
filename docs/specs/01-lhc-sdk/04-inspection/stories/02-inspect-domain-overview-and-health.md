# Story 2: Inspect Domain - Overview and Health

### Summary
<!-- Jira: Summary field -->
Create the inspect domain with read-only overview and derivation health reports.

### Description
<!-- Jira: Description field -->
**User Profile:** The operator audits threads from the CLI; agents inside a harness use the same reads mid-task.

**Objective:** Report thread composition, derivation state, repair preview, queue visibility, and rebuild visibility without changing state.

**Scope In:** `inspect.overview`, `inspect.health`, `lhc inspect overview`, `lhc inspect health`, owner-surface composition, fixture extension for mutation-in-flight states.

**Scope Out:** Repair execution and mutations remain Feature 2 behavior. Inspect reports and previews; it never repairs, requeues, writes rows, transitions state, moves boundaries, derives forms, or invokes a provider.

**Dependencies:** Built Epic 01 and Epic 02 surfaces. Epic 03 status/view shapes are consumed where overview reports active-view summary.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->
- **AC-1.1**: `inspect.overview` returns, in one read-only call: thread identity and metadata; event count and order span; message counts (total visible, by kind, deleted counted separately) with visible token sum; turn counts (open, closed); chunk count and closed-but-unchunked turn count; derivation counts by state (pending, retrying, failed, blocked, ready); active-view summary (viewId, createdAt, compactPoint, coveredFrom) or null when never compacted; visibility boundary position and current zone token sum.

- **AC-1.2**: Counts honor the deleted contract: deleted messages appear only in the deleted count — excluded from visible counts, kind breakdowns, and token sums; event counts are unaffected (the record retains everything).

- **AC-1.3**: Every thread shape reports cleanly: fresh-empty, mid-first-turn, never-compacted, compacted, mid-rebuild. Absent pieces report as zeros or null — never omitted fields, never shape errors.

- **TC-1.1** (AC-1.1, AC-1.3): Overview shape variants: fresh-empty, mid-first-turn, never-compacted-with-record, compacted, and mid-rebuild all return the full shape with absent pieces as zeros/nulls. The compacted tool-heavy fixture asserts exact expected counts (messages by kind, turns, chunks, derivation states, view summary, boundary).

- **TC-1.2** (AC-1.2): Delete one message; overview → visible count and token sum drop, deleted count = 1, kind breakdown excludes it, event count unchanged.

- **AC-1.4**: The overview is a pure read: no work items created, no state changed, repeated calls with no intervening writes return identical results.

- **TC-1.3** (AC-1.4): Overview twice with no writes between → deep-equal results; no `work_item` rows created; zero provider calls.

- **AC-4.1**: `inspect.health` aggregates across owners — counts by owner, form kind, and state (ready, pending, retrying, failed, blocked) — assembled entirely from the owners' report surfaces, never from direct `derived_form` or `work_item` reads.

- **AC-4.2**: Failures carry actionable detail: subject id, form kind, reason, attempts, last error — enough to decide and target a requeue without raw SQL.

- **AC-4.3**: The report previews repair: which forms a requeue pass would touch (failed and not blocked), reported and never executed.

- **AC-4.4**: Rebuild visibility: after an edit or delete, health shows the cascade-cleared forms as pending with their queued work visible; after the queue drains, the same forms report ready. Two reads bracket a rebuild.

- **AC-4.5**: Live queue visibility: queued and claimed work counts from the owners' queue detail, consistent with the state counts in the same report.

- **TC-4.1** (AC-4.1, AC-4.5): Fixture with manufactured mixed states (ready, failed-transient, failed-permanent, blocked, pending) → exact counts per owner, kind, and state; queue section consistent with pending counts.

- **TC-4.2** (AC-4.2, AC-4.3): Failed and blocked forms present → failure detail exact (subject, form, reason, attempts); repair preview lists exactly the failed-not-blocked set.

- **TC-4.3** (AC-4.4): Edit a mid-thread message → health shows the cascade's cleared set pending with queued work (exact subjects per the cascade contract); `drainSettled` → same set ready; nothing outside the cascade changed state.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->
#### Architecture Context

This story creates the inspect domain and its shared report shapes. `overview` composes list/status/describe reads into counts and summaries; `health` composes owner report surfaces into state counts, failure detail, repair preview, and per-form-entry queue visibility.

Inspect is a pure consumer. It imports owner surfaces, owns no tables, performs no provider work, and reports repair targets without executing repair.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The story spans multiple owner surfaces and establishes the read-only delta helper used by later chunks.

Risk Reminders:
- Count correctness comes from list reads, not direct table reads.
- Health must stay on owner report surfaces; queue visibility is counted per form-report entry via each entry's live queue-item join, not by raw work-item rows.
- The mutation-in-flight fixture must reach states through production mutation/drain behavior, not hand-written derived rows.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Inspect surface | `src/domains/inspect/index.ts` |
| Inspect internals | `src/domains/inspect/internal/overview.ts`, `src/domains/inspect/internal/health.ts` |
| Shared shapes | `src/shared/inspect.ts` |
| CLI | `src/cli/inspect.ts` |
| SDK export | `src/sdk.ts` |
| Tests | `test/inspect-overview.test.ts`, `test/inspect-health.test.ts`, read-only delta helper in the test support area |

#### Design References

- [tech-design.md §Context](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:6), lines 6-22
- [tech-design.md §System View](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:24), lines 24-52
- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:54), lines 54-98
- [tech-design.md §Flow 1: Overview](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:104), lines 104-123
- [tech-design.md §Flow 4: Health](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:143), lines 143-146
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:151), lines 151-213
- [tech-design.md §Testing Strategy](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:215), lines 215-217
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:42), lines 42-50
- [test-plan.md §Chunk Red/Green Detail](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:56), lines 56-64

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-1.1 | `test/inspect-overview.test.ts :: full shape variants` | Fresh-empty, mid-first-turn, never-compacted-with-record, compacted, and mid-rebuild return full shape and exact fixture counts. |
| TC-1.2 | `test/inspect-overview.test.ts :: deleted accounting` | Deleting one message changes visible/deleted/kind/token counts while event count stays unchanged. |
| TC-1.3 | `test/inspect-overview.test.ts :: purity` | Repeated overview reads are deep-equal, read-only delta stays green, and provider calls remain zero. |
| TC-4.1 | `test/inspect-health.test.ts :: counts + queue consistency` | Mixed-state fixture returns exact counts per owner/kind/state and queue consistency. |
| TC-4.2 | `test/inspect-health.test.ts :: failure detail + preview` | Failed entries expose reason/attempts/last error and preview exactly failed-not-blocked forms. |
| TC-4.3 | `test/inspect-health.test.ts :: rebuild bracket` | Edit creates pending queued cascade set; after drain the same set is ready and disjoint forms are untouched. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Inspect writes while reporting | Shared read-only delta helper | Snapshot queued work, boundary/zone, view identity, and record counts before/after every new read. | Shape assertions do not prove absence of side effects. |
| Health reads owner tables directly | `check-boundaries` plus Epic 04 source check | Forbid cross-domain internals and raw SQL references to other domains from `domains/inspect/**`. | A direct SQL implementation could match output while violating inspect ownership. |
| Provider use leaks into reads | Suite-wide throwing-provider assertion | New read operations succeed under throwing provider config. | Fixture prep may use deterministic provider; report operations themselves must not. |

#### Technical Notes

- Overview reads `listEvents`, `listMessages({ includeDeleted: true })`, `listTurns`, `listChunks`, `status`, and `describe`, then normalizes absent sections to zero/null.
- Health reads owner reports; queue counts are per form-report entry so queued+claimed equals pending+retrying in the same report. `repairPreview` reports failed-not-blocked forms only.
- No migration, new table, or new index ships in this story.

#### Anti-Shim Requirements

- Mutation-in-flight fixture states must be reached through intake, mutation, and partial drain behavior.
- Do not add count-only surfaces or table reads for overview counts.
- Do not execute repair or requeue from `health`.

#### Production Path Proof

- Entrypoint: `inspect.overview`, `inspect.health`, `lhc inspect overview`, `lhc inspect health`.
- Registration/default path: `src/sdk.ts` exposes the inspect namespace; `src/cli/inspect.ts` routes commands to SDK calls.
- Evidence: default-suite overview/health tests plus read-only delta helper; CLI parity is covered in the lifecycle/process story.

#### Verification

- Targeted: `pnpm verify`
- Story gate: `pnpm verify`
- Epic/process gate: `LHC_PROCESS_SUITE=1 pnpm verify-all`

#### Spec Deviations

**EV-04-001 / fix-batch-001** — health queue counts follow the ratified per-form-entry contract. `health.queue` reports queued/claimed counts through each owner report entry's live queue-item join so `queued + claimed = pending + retrying` within the same report. It deliberately does not count raw work-item rows because one work item can back multiple form entries.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->
- `inspect.overview` returns the full overview shape for fresh, mid-turn, never-compacted, compacted, and mid-rebuild threads.
- Overview count behavior honors the deleted-message contract and pure-read invariant.
- `inspect.health` composes owner report surfaces for counts, failures, repair preview, and queue visibility.
- Rebuild visibility is covered before and after drain.
- CLI overview/health JSON matches SDK results.
- TC-1.1 through TC-1.3 and TC-4.1 through TC-4.3 pass with one primary owner in this story.
