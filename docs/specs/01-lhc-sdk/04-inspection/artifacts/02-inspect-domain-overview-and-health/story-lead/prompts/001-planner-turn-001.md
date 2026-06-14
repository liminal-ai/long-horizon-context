# Story Lead Base Prompt

## Role Charter
You are the story lead for `02-inspect-domain-overview-and-health` on durable story run `02-inspect-domain-overview-and-health-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 1.
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
- planner_turn_index: 1
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-orchestrate-run
- current_child_operation: none
- current_summary: Story orchestration started and durable state has been initialized.
- latest_response_kind: none
- latest_response_path: none
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 0
- latest_self_note: "none"

## Response Trail
<current_response>
No prior bounded child response is recorded yet.
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/story-lead/001-current.json
Bytes: 1000

```yaml
storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
storyId: "02-inspect-domain-overview-and-health"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/001-story-validate.json"
    provenance: "prior-run"
latestContinuationHandles:
{}
latestEventSequence: 1
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "orient-from-disk"
  summary: "Orient from 1 existing story artifact(s)."
replayBoundary: null
updatedAt: "2026-06-12T14:12:05.513Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/artifacts/02-inspect-domain-overview-and-health/story-lead/001-events.jsonl
Bytes: 237

```yaml
-
  storyRunId: "02-inspect-domain-overview-and-health-story-run-001"
  sequence: 1
  timestamp: "2026-06-12T14:12:05.512Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
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
