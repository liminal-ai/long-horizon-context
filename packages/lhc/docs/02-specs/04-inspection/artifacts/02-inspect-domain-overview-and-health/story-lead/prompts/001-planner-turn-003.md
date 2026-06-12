# Story Lead Base Prompt

## Role Charter
You are the story lead for `02-inspect-domain-overview-and-health` on durable story run `02-inspect-domain-overview-and-health-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 3.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/stories/02-inspect-domain-overview-and-health.md
Bytes: 11154

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

This story creates the inspect domain and its shared report shapes. `overview` composes list/status/describe reads into counts and summaries; `health` composes owner report surfaces and queue detail into state counts, failure detail, and repair preview.

Inspect is a pure consumer. It imports owner surfaces, owns no tables, performs no provider work, and reports repair targets without executing repair.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The story spans multiple owner surfaces and establishes the read-only delta helper used by later chunks.

Risk Reminders:
- Count correctness comes from list reads, not direct table reads.
- Health must stay on owner report surfaces and queue detail.
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
- Health reads owner reports and queued-work detail; `repairPreview` reports failed-not-blocked forms only.
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

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->
- `inspect.overview` returns the full overview shape for fresh, mid-turn, never-compacted, compacted, and mid-rebuild threads.
- Overview count behavior honors the deleted-message contract and pure-read invariant.
- `inspect.health` composes owner report surfaces for counts, failures, repair preview, and queue visibility.
- Rebuild visibility is covered before and after drain.
- CLI overview/health JSON matches SDK results.
- TC-1.1 through TC-1.3 and TC-4.1 through TC-4.3 pass with one primary owner in this story.


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md
Bytes: 7662

# Epic 04: Inspection — Test Plan

**Epic:** `epic.md` (23 ACs / 17 TCs) · **Tech design:** `tech-design.md`
Inherits Epic 01–03 test architecture: real temp SQLite per test, deterministic provider for fixture prep only, default suite (`pnpm verify`) + process suite (`LHC_PROCESS_SUITE=1 pnpm verify-all`), suite-accounting row, red manifest discipline.

## Test Files

| File | Suite | Covers |
|------|-------|--------|
| `test/messages-read.test.ts` | default | TC-3.1–3.3 + list/show read-only legs |
| `test/inspect-overview.test.ts` | default | TC-1.1–1.3 |
| `test/inspect-view.test.ts` | default | TC-2.1–2.3 + describe legs |
| `test/inspect-health.test.ts` | default | TC-4.1–4.3 |
| `test/lifecycle.test.ts` | default | TC-5.1–5.3 |
| `test/cli-process-inspect.test.ts` | process | TC-3.4, TC-5.4 |
| `test/fixtures/lifecycle.ts` | (helper) | the scripted sequence both suites drive |

Fixture: Epic 03's tool-heavy fixture reused; extended in place (Story 2) with a mutation-in-flight variant — one edit applied, drain *not* settled, so cleared-pending states are real production states, not hand-written rows (FC-fidelity rule carried from Epic 03 Story 0: states reached through intake → mutate → partial drain, never direct `derived_form` writes).

## TC → Test Mapping

| TC | Test (file :: name) | Assertion spine |
|----|--------------------|-----------------|
| TC-1.1 | inspect-overview :: full shape variants | fresh-empty, mid-first-turn, never-compacted-with-record, compacted, and mid-rebuild all return the full shape with absent pieces as zeros/nulls; compacted fixture exact counts per section vs fixture ground truth |
| TC-1.2 | inspect-overview :: deleted accounting | delete one → visible−1, deleted=1, kind map excludes, tokens drop by its estimate, event count unchanged |
| TC-1.3 | inspect-overview :: purity | two calls, no writes between → deep-equal; read-only delta assert green; zero provider calls |
| TC-2.1 | inspect-view :: arrangement fidelity | entries/forms/degraded/gap reasons/config/provenance equal `describe` output equal stored row (degraded + gap fixture) |
| TC-2.2 | inspect-view :: loadCost parity on boundary-advanced fixture | tail costs short forms short; `total` = estimator over an independent `pull`'s messages |
| TC-2.3 | inspect-view :: never-compacted | `meta: null`, bands `[]`, tail spans record, parity holds |
| TC-3.1 | messages-read :: order, fields, bounds | record order; kind/tokens/turnId present; `from`/`to`/`limit` exact windows; `from > to` → `caller_error` |
| TC-3.2 | messages-read :: show full record + forms | drained tool-result: full content (not shortened), forms with states, outcome metadata present |
| TC-3.3 | messages-read :: deleted handling | default list excludes; `includeDeleted` marks; show on deleted → ok + flag; show on missing id → `message_not_found` |
| TC-3.4 | cli-process-inspect :: list/show parity | spawned `lhc messages list/show` JSON deep-equals in-process SDK results |
| TC-4.1 | inspect-health :: counts + queue consistency | mixed-state fixture: exact counts per owner/kind/state; queue section equals live-item counts from the same reports |
| TC-4.2 | inspect-health :: failure detail + preview | failed: reason/attempts/lastError exact; blocked excluded from preview; preview = failed∧¬blocked set exactly |
| TC-4.3 | inspect-health :: rebuild bracket | edit → health: cascade set pending with queued work visible (exact subjects per cascade contract); `drainSettled` → same set ready; disjoint forms untouched |
| TC-5.1 | lifecycle :: full sequence + checkpoints | every phase ok; post-compact pull = bands+tail; mutate → pending; drain → ready; compact2 reflects edit; receipt sweep section field-equals pre-compact health snapshot |
| TC-5.2 | lifecycle :: replay determinism | fresh thread, same script → hash-equal pull outputs and materialized file |
| TC-5.3 | lifecycle :: teardown continuity | `freshSdk` between phase groups → final pull/health/file identical to TC-5.1 run |
| TC-5.4 | cli-process-inspect :: checkpoint parity | spawned CLI overview/view/list at three checkpoints deep-equal in-process results at same checkpoints |

## Architecture-Risk Tests

| Risk | Test | Why it bites |
|------|------|--------------|
| Inspect quietly writes (work rows, boundary nudge, view touch) | **read-only delta assert**: shared helper snapshots observable state (queued work via owners, boundary/zone via status, view identity via describe, event/message counts) before/after *every* new operation; deep-equal after. Runs inside each TC file via wrapper | A single forgotten side effect makes "inspect describes, never changes" fiction; absence-of-delta is checkable, absence-of-write-code is not |
| Zero-provider on all new ops | suite-wide assert extended: overview/view/health/describe/show/list under a throwing provider config → all ok | The no-inference NFR stays structural through the last epic |
| `loadCost` drifts from served reality | TC-2.2's independent-pull leg + lifecycle TC-5.1 checkpoint (report at compact1 vs pull1) | Parity by construction can still break at the estimator seam; two independent measurements pin it |
| Health re-derives instead of composing | health tests assert composition through owner surfaces only: `check-boundaries` forbids cross-domain internal imports, an Epic 04 source check rejects raw SQL references to other domains' tables from `domains/inspect/**`, and the read-only delta assert separately catches writes | The must-not-own rule is the domain's entire contract |
| Lifecycle order bugs only visible cross-epic | TC-5.1's named-phase checkpoints; receipt-vs-health field equality | First sequence ever to run all surfaces in PI-extension order; seam drift between three separately-built epics surfaces here or in production |

## Suite Accounting

Default suite grows ~26 tests across 5 files. Process suite grows TC-3.4 + TC-5.4 (2 spawned scenarios, ~6 assertions); accounting row carried: process suite `ran | not-ran` recorded per verify-all invocation, never silently skipped.

## Chunk Red/Green Detail

**Chunk 1 — message reads (S1).** Red: `show` absent from surface (structured not-implemented per house stub rule); list opts ignored — bounds test fails on full-list return. Green: opts → WHERE/LIMIT; show + report join; `cli/messages-read.ts`; TC-3.1–3.3 + read-only legs. ~8 tests.

**Chunk 2 — inspect domain (S2).** Red: `inspect.*` stubs return not-implemented; fixture lacks mutation-variant (TC-4.3 unwritable → fixture work first). Green: `shared/inspect.ts` shapes; overview composition; health composition; `cli/inspect.ts`; delta-assert helper lands here and wraps Chunk 1's ops retroactively. TC-1.1–1.3, TC-4.1–4.3. ~11 tests.

**Chunk 3 — view report (S3).** Red: `describe` absent; `inspect.view` stub. Green: `describe` (row → `StoredView`), `view-report.ts` (describe + pull → report), TC-2.1–2.3 + describe null/shape legs. ~6 tests.

**Chunk 4 — lifecycle (S4).** Red: `lifecycle.ts` helper absent; all four TC files reference it. Green: script with named phases + `freshSdk` hook; TC-5.1–5.3 default; TC-5.4 process. ~7 tests (4 scenarios, multi-checkpoint).

## Verification

Per-story: `pnpm verify` (lint, typecheck, default suites). Story 4 and epic close: `LHC_PROCESS_SUITE=1 pnpm verify-all` — process suite must report `ran`. Red manifests regenerated per chunk per house discipline; no Epic 01–03 test amendments expected (additive surfaces only — list-opts default behavior is unchanged, existing `listMessages` callers see identical results).


## Current Run Index
- planner_turn_index: 3
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-verify completed with outcome pass and status ok.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/004-verify.json
- older_response_count: 1
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementation returns, verify evidence must include story gate result plus read-only/provider/boundary proof before acceptance can be recommended."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/004-verify.json
bytes: 5751
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "c3286bbd-ffc1-4576-8a73-f97502318981"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019ebc3e-a19c-7e72-9f6e-e71b210a1489"
    continuation:
      provider: "codex"
      sessionId: "019ebc3e-a19c-7e72-9f6e-e71b210a1489"
      storyId: "02-inspect-domain-overview-and-health"
    mode: "initial"
    story:
      id: "02-inspect-domain-overview-and-health"
      title: "Story 2: Inspect Domain - Overview and Health"
    artifactsRead:
      - "packages/lhc/docs/02-specs/04-inspection/stories/02-inspect-domain-overview-and-health.md"
      - "packages/lhc/docs/02-specs/04-inspection/tech-design.md"
      - "packages/lhc/docs/02-specs/04-inspection/test-plan.md"
      - "packages/lhc/docs/02-specs/04-inspection/epic.md"
      - "packages/lhc/docs/02-specs/04-inspection/team-impl-log.md"
      - "packages/lhc/docs/02-specs/04-inspection/stories/03-view-contents-report.md"
      - "packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/003-implementor.json"
      - "packages/lhc/package.json"
      - "packages/lhc/src/shared/inspect.ts"
      - "packages/lhc/src/shared/context.ts"
      - "packages/lhc/src/shared/errors.ts"
      - "packages/lhc/src/domains/inspect/index.ts"
      - "packages/lhc/src/domains/inspect/internal/overview.ts"
      - "packages/lhc/src/domains/inspect/internal/health.ts"
      - "packages/lhc/src/domains/threads/index.ts"
      - "packages/lhc/src/domains/messages/index.ts"
      - "packages/lhc/src/domains/turns/index.ts"
      - "packages/lhc/src/domains/thread-view/index.ts"
      - "packages/lhc/src/cli/index.ts"
      - "packages/lhc/src/cli/inspect.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/scripts/check-boundaries.mjs"
      - "packages/lhc/test/fixtures/read-only-delta.ts"
      - "packages/lhc/test/fixtures/view-thread.ts"
      - "packages/lhc/test/inspect-overview.test.ts"
      - "packages/lhc/test/inspect-health.test.ts"
      - "packages/lhc/test/cli-process-inspect.test.ts"
      - "packages/lhc/test/red-manifest.json"
    reviewScopeSummary: "Initial verification read the Story 2 AC/TCs, epic and tech-design context, implementor evidence, inspect implementation, owner surfaces, CLI/SDK wiring, fixture/test coverage, static boundary checks, and production read-path behavior. Story and epic gates passed, focused CLI parity and background read-only/no-provider probes passed, and no blocking findings remain."
    priorFindingStatuses:
[]
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "AC-1.1 / TC-1.1: inspect.overview returns identity, event/message/turn/chunk counts, derivation counts, view summary, and visibility; covered by composeOverview and inspect-overview tests for exact compacted fixture counts."
        - "AC-1.2 / TC-1.2: deleted messages are counted only in deleted and excluded from visible counts, kind breakdowns, and token sums; inspect-overview deleted-accounting test verifies event count unchanged."
        - "AC-1.3 / TC-1.1: fresh-empty, mid-first-turn, never-compacted, compacted, and mid-rebuild shapes return full zero/null-safe overview shapes."
        - "AC-1.4 / TC-1.3: overview is pure read; expectReadOnly snapshots observable state, repeated reads deep-equal, throwing-provider coverage passes, and a focused background-SDK probe confirmed no provider calls or queued-work changes."
        - "AC-4.1 / TC-4.1: health aggregates owner/kind/state counts from messages.report and turns.report; check-boundaries passed the inspect no-storage/no-raw-SQL source check."
        - "AC-4.2 / TC-4.2: health failures carry subject, form, reason, attempts, and lastError where present; inspect-health tests assert exact transient and permanent failure detail."
        - "AC-4.3 / TC-4.2: repairPreview reports exactly failed non-blocked forms and re-reading health shows the preview is not executed."
        - "AC-4.4 / TC-4.3: mutation-in-flight fixture reaches pending cascade state through real edit behavior; health before drain shows exact pending subjects and queued work, and after drain returns to ready counts."
        - "AC-4.5 / TC-4.1: queue visibility is counted from owner report queue joins and tested for consistency with pending/retrying state counts."
        - "Definition of Done: SDK exports inspect, CLI routes lhc inspect overview/health, and a focused dist CLI probe verified overview/health JSON equals SDK results."
        - "Production path audit: no material fake adapter, mock path, shim, fallback, or placeholder was found in inspect.overview or inspect.health runtime paths; the inspect.view not_implemented skeleton is explicitly Story 3 scope."
      unverified:
[]
    gatesRun:
      -
        command: "pnpm verify"
        result: "pass"
      -
        command: "pnpm verify-all"
        result: "pass"
      -
        command: "node scripts/check-test-immutability.mjs"
        result: "pass"
      -
        command: "node --input-type=module (dist inspect CLI overview/health parity probe)"
        result: "pass"
      -
        command: "node --input-type=module (background inspect overview/health no-provider/read-only probe)"
        result: "pass"
    productionPathFindings:
[]
    recommendedNextStep: "pass"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "Story 3 explicitly owns threadView.describe, inspect.view, and lhc inspect view; the current inspect.view structured not_implemented result matches the existing surface-skeleton convention and is outside Story 2 readiness."
      - "composeOverview currently obtains the active-view identity fields from threadView.pull().meta because threadView.describe lands in Story 3; compacted and mid-rebuild tests verify the reported fields against compact receipts."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/004-verify.json"
  startedAt: "2026-06-12T14:31:21.598Z"
  finishedAt: "2026-06-12T14:37:18.346Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/003-implementor.json
bytes: 9455
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "0b1d3f13-b9ce-45ef-b6b4-3fdb8bb4806f"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "129e29ba-fc2e-4a7e-aec1-ad68e0f0dc1b"
    continuation:
      provider: "claude-code"
      sessionId: "129e29ba-fc2e-4a7e-aec1-ad68e0f0dc1b"
      storyId: "02-inspect-domain-overview-and-health"
    outcome: "ready-for-verification"
    story:
      id: "02-inspect-domain-overview-and-health"
      title: "Story 2: Inspect Domain - Overview and Health"
    planSummary: "Created the inspect domain as a pure surface consumer: shared report shapes in src/shared/inspect.ts; overview composing threads.info + listEvents + listMessages({includeDeleted}) + listTurns/listChunks + both owners' reports + status/pull.meta into the full InspectOverview (absent pieces as zeros/nulls, one composition path, no shape branches); health composing messages.report + turns.report into owner/kind/state counts, failure detail (reason/attempts/lastError from form metadata or queue join), repairPreview (= failed-not-blocked, reported never executed), and queue counts from the same entries' live joins (consistent by construction with pending+retrying). inspect.view ships as the structured not_implemented stub (Story 3). CLI lhc inspect overview|health wired as thin argv-to-SDK wrappers; sdk.ts gains the seam-scoped inspect namespace and shared-type exports. check-boundaries gains inspect's pinned acyclic edge set plus the Epic 04 source check forbidding sqlite/raw-SQL in domains/inspect/**. Fixture extended in place with mutationInFlightVariant (compact + one production edit, drain not settled) and mixedStateVariantThread (ready/failed-transient/failed-permanent/blocked/pending all via intake + scripted provider failures + sanctioned corruption + partial drain). Shared read-only delta helper (observableState/expectReadOnly) lands in test/fixtures and wraps the new ops plus Story 1's list/show retroactively. Smoke-tested the CLI end to end on a fresh thread."
    changedFiles:
      -
        path: "packages/lhc/src/shared/inspect.ts"
        reason: "New: InspectOverview, ViewContentsReport, HealthReport load-bearing shapes (tech design §Interface Definitions)"
      -
        path: "packages/lhc/src/domains/inspect/index.ts"
        reason: "New inspect surface: overview/health real (touch-suppressed pure reads), view as structured not_implemented stub until Story 3"
      -
        path: "packages/lhc/src/domains/inspect/internal/overview.ts"
        reason: "Flow 1 composition from list/report/status/pull surfaces; deleted contract; zeros/nulls normalization; ready-inclusive derivation bucketing"
      -
        path: "packages/lhc/src/domains/inspect/internal/health.ts"
        reason: "Flow 4 composition from owners' report surfaces only: counts, failures, repairPreview, queue visibility per report entry"
      -
        path: "packages/lhc/src/domains/threads/index.ts"
        reason: "Added threads.info(ref): thread identity (threadId/createdAt) from the file's own thread_metadata header — threads-owned table — so overview reports identity for any resolvable ref without inspect reading tables (see specDeviations)"
      -
        path: "packages/lhc/src/cli/inspect.ts"
        reason: "New: lhc inspect overview|health|view thin wrappers, structural CLI/SDK parity"
      -
        path: "packages/lhc/src/cli/index.ts"
        reason: "Routing for inspect overview/health (+ view stub routed, kept out of help until Story 3); help text for the two landed commands"
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "inspect namespace exported and seam-scoped on Lhc (status inside overview resolves this SDK's view config); shared inspect types and ThreadFileInfo exported"
      -
        path: "packages/lhc/scripts/check-boundaries.mjs"
        reason: "inspect added to pinned surface edges (acyclic, no exceptions); Epic 04 source check rejects node:sqlite/DatabaseSync/.prepare(/raw SQL over domain tables in domains/inspect/**"
      -
        path: "packages/lhc/test/fixtures/view-thread.ts"
        reason: "Fixture extended in place: mutationInFlightVariant (compact + one edit, drain not settled) and mixedStateVariantThread (all five states via production intake/mutation/partial-drain; only sanctioned corruption writer)"
      -
        path: "packages/lhc/test/fixtures/read-only-delta.ts"
        reason: "New shared DD-6 helper: observableState snapshot (events, audit messages, both owners' queued work, status, pull.meta, raw derived forms) + expectReadOnly wrapper"
      -
        path: "packages/lhc/test/fixtures/index.ts"
        reason: "Exports for the delta helper and the two new fixture variants"
      -
        path: "packages/lhc/test/inspect-overview.test.ts"
        reason: "TC-1.1 (5 shape variants incl. exact compacted counts), TC-1.2 deleted accounting, TC-1.3 purity + throwing-provider + retroactive delta wrap of Story 1 list/show + not-found leg"
      -
        path: "packages/lhc/test/inspect-health.test.ts"
        reason: "TC-4.1 exact owner/kind/state counts + queue consistency, TC-4.2 failure detail + preview exactness + never-executed re-read, TC-4.3 rebuild bracket with cascade-exact pending subjects, throwing-provider leg"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "Recorded the two new test files per house red-manifest discipline (Story 1 SV-01-004 precedent); check-test-immutability OK (45 files)"
    tests:
      added:
        - "test/inspect-overview.test.ts :: TC-1.1 fresh-empty full shape"
        - "test/inspect-overview.test.ts :: TC-1.1 mid-first-turn full shape"
        - "test/inspect-overview.test.ts :: TC-1.1 never-compacted-with-record"
        - "test/inspect-overview.test.ts :: TC-1.1 compacted tool-heavy exact counts"
        - "test/inspect-overview.test.ts :: TC-1.1 mid-rebuild full shape"
        - "test/inspect-overview.test.ts :: TC-1.2 deleted accounting"
        - "test/inspect-overview.test.ts :: TC-1.3 purity (deep-equal, delta assert, zero provider)"
        - "test/inspect-overview.test.ts :: TC-1.3 throwing provider + retroactive Story 1 delta wrap"
        - "test/inspect-overview.test.ts :: TC-1.3 missing thread is thread_not_found"
        - "test/inspect-health.test.ts :: TC-4.1 counts + queue consistency"
        - "test/inspect-health.test.ts :: TC-4.2 failure detail + repair preview"
        - "test/inspect-health.test.ts :: TC-4.3 rebuild bracket"
        - "test/inspect-health.test.ts :: architecture risk: provider-free + read-only"
      modified:
[]
      removed:
[]
      totalAfterStory: 313
      deltaFromPriorBaseline: 13
    gatesRun:
      -
        command: "pnpm verify"
        result: "pass"
      -
        command: "pnpm verify-all"
        result: "pass"
      -
        command: "node scripts/check-test-immutability.mjs"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
        - "threads.info initially returned a state_corruption result under a new error-code semantic for the unreachable lost-metadata-row branch; changed to the existing storageFailure so the story adds no error codes (story contract: 'Error codes: no additions')"
        - "Compacted-overview test initially used default compact (sweep on), which would requeue the transiently-failed form and move the derivation counts; pinned to compact({ sweep: false }) so the two manufactured failed states stay failed and counts assert exactly"
      findingsSurfaced:
        - "Health queue counts are per report ENTRY (a turn_derivation item joins onto two form entries), which is exactly what makes queued+claimed == pending+retrying consistent by construction per tech design Flow 4; if the verifier reads AC-4.5 as distinct work-item counts instead, the composition point is health.ts's queue block"
        - "messages-read.test.ts is hash-pinned in the red manifest, so the 'wraps Chunk 1's ops retroactively' requirement was met by running list/show under the shared expectReadOnly helper in the new inspect-overview test rather than editing the Story 1 file"
        - "TC-4.2 asserts the two blocked entries in turns-report order (lower_band_projection before turn_rendering); deterministic today but coupled to the owner report's ORDER BY"
    openQuestions:
[]
    specDeviations:
      - "View summary and boundary position compose from threadView.pull().meta instead of threadView.describe (story Technical Notes / DD-5 name describe, but describe lands in Story 3 per the chunk sequencing — at Story 2 time pull.meta is the only surface exposing the stored viewId/createdAt/compactPoint/coveredFrom/boundary). Same stored fields verbatim; Story 3 can switch overview to describe with no shape change."
      - "Added a small threads surface read, threads.info(ref) -> { threadId, createdAt }, reading the thread file's own thread_metadata header (a threads-owned table written by threads/internal/create.ts). Needed because overview must report thread identity for a { filePath } ref (AC-1.1) while inspect may not read tables, and registry-based resolution cannot serve filePath refs against non-default registries. In-domain read, touch-suppressed, no new error codes; check-boundaries unaffected."
      - "inspect.view stub is routed in the CLI (returns the structured not_implemented result) but deliberately omitted from --help until Story 3 lands the real report."
    recommendedNextStep: "Run story verification; then Story 3 (view contents report) can land threadView.describe and switch overview's view-section source from pull.meta to describe, plus replace the inspect.view stub."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/003-implementor.json"
  startedAt: "2026-06-12T14:12:20.533Z"
  finishedAt: "2026-06-12T14:31:10.855Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/story-lead/001-current.json
Bytes: 2236

```yaml
storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
storyId: "02-inspect-domain-overview-and-health"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome pass and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/004-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "129e29ba-fc2e-4a7e-aec1-ad68e0f0dc1b"
    storyId: "02-inspect-domain-overview-and-health"
  storyVerifier:
    provider: "codex"
    sessionId: "019ebc3e-a19c-7e72-9f6e-e71b210a1489"
    storyId: "02-inspect-domain-overview-and-health"
latestEventSequence: 8
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Implementation reports ready-for-verification with pnpm verify passing, but acceptance requires an independent verifier pass and explicit proof for read-only behavior, provider-free reads, and inspect boundary constraints."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/004-verify.json"
replayBoundary: null
updatedAt: "2026-06-12T14:37:18.356Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementation returns, verify evidence must include story gate result plus read-only/provider/boundary proof before acceptance can be recommended.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-12T14:12:20.496Z; note="After implementation returns, verify evidence must include story gate result plus read-only/provider/boundary proof before acceptance can be recommended."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/story-lead/001-events.jsonl
Bytes: 3534

```yaml
-
  storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
  sequence: 1
  timestamp: "2026-06-12T14:12:05.512Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
  sequence: 2
  timestamp: "2026-06-12T14:12:20.472Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019ebc2c-fd94-7872-9d64-b1d991789a74"
-
  storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
  sequence: 3
  timestamp: "2026-06-12T14:12:20.496Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, verify evidence must include story gate result plus read-only/provider/boundary proof before acceptance can be recommended."
-
  storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
  sequence: 4
  timestamp: "2026-06-12T14:12:20.496Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, verify evidence must include story gate result plus read-only/provider/boundary proof before acceptance can be recommended."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
  sequence: 5
  timestamp: "2026-06-12T14:31:10.865Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
  sequence: 6
  timestamp: "2026-06-12T14:31:21.538Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019ebc3e-78f3-7931-8e85-65fa8400fd61"
-
  storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
  sequence: 7
  timestamp: "2026-06-12T14:31:21.560Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
  sequence: 8
  timestamp: "2026-06-12T14:37:18.356Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "pass"
    status: "ok"
```

## State Rules
### state-rules
Bytes: 2986

Requirements source for story-local acceptance: the story file and test plan below.
Current lifecycle state: awaiting_story_lead_action

Lifecycle rules:
State: initialized
Public status: running
Allowed actions: none
Meaning: Runtime scaffolding exists, but no planner turn or child operation has started yet.
Caller implication: Treat this as startup bookkeeping only; wait for the first planner transition before routing work.

State: awaiting_story_lead_action
Public status: running
Allowed actions: run-implement, run-continue, run-self-review, run-verify, run-quick-fix, accept-story, request-ruling, block-story, fail-story
Meaning: The durable record is ready and the next fresh story-lead turn may choose one bounded action.
Caller implication: Planner output is the next source of truth; the run is waiting for a valid bounded action selection.

State: running_child_operation
Public status: running
Allowed actions: none
Meaning: The runtime is executing one bounded child operation selected by the story lead.
Caller implication: Poll runtime artifacts instead of rerouting; the current child operation is still in flight.

State: recording_result
Public status: running
Allowed actions: none
Meaning: The child result or terminal decision is being written to durable artifacts before the next transition.
Caller implication: Do not treat the run as advanced until evidence and ledger updates are durably recorded.

State: terminal
Public status: terminal-only
Allowed actions: none
Meaning: A terminal public outcome has been recorded separately from lifecycleState and the story-lead loop will not continue automatically.
Caller implication: Read the public status and final package to decide impl-lead follow-up such as accept, reopen, or ruling.

Terminal outcome rules:
Outcome: accepted
Meaning: Story-lead evidence is complete enough to recommend acceptance for impl-lead review.
Caller implication: Impl-lead still owes receipt completion, verification gates, and the story commit before accepting the story.

Outcome: needs-ruling
Meaning: The run reached a boundary that requires an explicit caller or maintainer decision.
Caller implication: Surface the ruling request instead of guessing or downgrading the decision into cleanup debt.

Outcome: blocked
Meaning: A named blocker prevents safe forward progress with the current inputs or runtime state.
Caller implication: Resolve the blocker or change the plan before resuming; do not pretend the story is ready to continue.

Outcome: failed
Meaning: An unrecoverable runtime or planner failure ended the current story-lead attempt.
Caller implication: Inspect the failure details and durable artifacts before deciding whether to replay or open a new attempt.

Outcome: interrupted
Meaning: The run stopped before a planned transition finished, usually because the caller or runtime interrupted it.
Caller implication: Use status or resume against the durable artifacts to continue from the last safe checkpoint.

## Runtime Settings
### runtime-settings
Bytes: 209

```yaml
storyGate: "pnpm verify"
epicGate: "pnpm verify-all"
plannerTimeoutMs: 600000
wholeRunTimeoutMs: 7200000
providerStartupTimeoutMs: 300000
providerActiveSilenceTimeoutMs: 600000
```

## Action Protocol
Return exactly one JSON object matching `StoryLeadAction`.

Examples:
{"action":"run-implement","rationale":"...","inputs":{"promptAddendum":"optional"},"selfNote":"optional durable reminder"}
{"action":"run-continue","rationale":"...","inputs":{"continuationRef":"storyImplementor","promptAddendum":"..."}}
{"action":"run-self-review","rationale":"...","inputs":{"artifactRefs":["/abs/path.json"],"focus":"optional","continuationRef":"storyImplementor","passes":1}}
{"action":"run-verify","rationale":"...","inputs":{"artifactRefs":["/abs/path.json"],"focus":"optional","provider":"codex"}}
{"action":"run-verify","rationale":"...","inputs":{"artifactRefs":["/abs/path.json"],"verifierContinuationRef":"storyVerifier","responseArtifactRef":"/abs/path.json"}}
{"action":"run-quick-fix","rationale":"...","inputs":{"findingRefs":["finding-001"],"remediationGoal":"...","workingDirectory":"optional"}}
{"action":"request-ruling","rationale":"...","inputs":{"decisionType":"...","question":"...","defaultRecommendation":"...","evidence":["..."],"allowedResponses":["..."]}}
{"action":"accept-story","rationale":"...","inputs":{"summary":"...","acceptanceCheckRefs":["..."],"acceptanceChecks":[{"name":"...","status":"pass","evidence":["..."],"reasoning":"..."}],"recommendedImplLeadAction":"accept"},"verification":{"finalVerifierOutcome":"pass","findings":[{"id":"...","status":"fixed","evidence":["..."]}]}}
{"action":"block-story","rationale":"...","inputs":{"reason":"...","detail":"optional","evidence":["..."]},"verification":{"finalVerifierOutcome":"block","findings":[{"id":"...","status":"unresolved","evidence":["..."]}]}}
{"action":"fail-story","rationale":"...","inputs":{"reason":"...","detail":"optional","evidence":["..."]}}

Rules:
- Choose exactly one bounded next action.
- Use only the durable story-run record in this prompt. Do not assume hidden retained planner memory exists.
- Treat `<current_response>` as the latest bounded child response and `<history_responses>` as older response history.
- If the story file and test plan are insufficient for a safe next step, request a ruling instead of asking for epic, tech design, git status, or git diff by default.
- Include `selfNote` only when you want to leave a durable reminder for a later planner turn.

## Acceptance Rubric
Choose the smallest safe bounded action that advances the story using the durable evidence already present.
Prefer continuing from valid child-operation evidence over repeating work, and keep unresolved authority-boundary questions explicit.

## Acceptance Decision Standard
Choose `accept-story` only when the latest verifier result is `pass`, no open findings remain, required proof is present, and the configured story gate passed.
If readiness is promising but gate truth is failed, unavailable, or uncertain, do not accept. Choose the smallest safe next action: verify, quick-fix, block, or request a ruling.

## Ruling Boundaries
Request a ruling when story-local requirements are insufficient, when a blocker needs a caller decision, or when the evidence conflicts in a way that the durable record cannot resolve safely.
