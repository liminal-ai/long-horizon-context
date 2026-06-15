# Story Lead Base Prompt

## Role Charter
You are the story lead for `05-runtime-change-typing` on durable story run `05-runtime-change-typing-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/stories/05-runtime-change-typing.md
Bytes: 7110

# Story 5: Runtime-Change Typing

### Summary
<!-- Jira: Summary field -->

Record model and thinking-level changes as typed blocks and place them verbatim in constructed turns.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** preserve runtime-change structure instead of flattening model and thinking-level changes into `runtime_note` text.

**Scope In:**
- `model_change` blocks with previous and new model.
- `thinking_level_change` blocks with previous and new level.
- Verbatim placement in constructed turns in stream order.

**Scope Out:**
- pi-lhc consumption of typed runtime blocks for thread restoration.

**Dependencies:** Story 0.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-6.1:** A model change is recorded and projected as a typed `model_change` block with structured fields (previous and new model).

- **TC-6.1a:** Typed model change
  - Given: a model-change runtime event at intake
  - When: it is projected
  - Then: a typed `model_change` block carries the previous and new model values

**AC-6.2:** A thinking-level change is recorded and projected as a typed `thinking_level_change` block with structured fields (previous and new level).

- **TC-6.2a:** Typed thinking change
  - Given: a thinking-level-change runtime event at intake
  - When: it is projected
  - Then: a typed `thinking_level_change` block carries the previous and new level values

**AC-6.3:** Typed runtime-change blocks are placed verbatim in constructed turns, in stream order, like other non-derived components.

- **TC-6.3a:** Placed verbatim and ordered
  - Given: a turn containing a model change followed by a thinking change
  - When: the turn is constructed
  - Then: both typed blocks appear unchanged and in order

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 5 extends the public intake event contract and message projection for runtime changes. `MessageEventInput` accepts `model_change` and `thinking_level_change`, validation enforces their structured fields, and message projection stores typed blocks instead of flattened `runtime_note` text.

Turn construction treats these blocks as non-derived components and places them verbatim in stream order. Host restoration behavior remains out of scope.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- The implementation is a narrow public event/validation/projection change.
- The main risk is compatibility: the public input union and projection must agree.

Risk Reminders:
- Intake/projection compatibility: validation and projection must accept the same structured shapes.
- Runtime blocks are non-derived and must not enter derivation/recovery paths.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Public event union | `packages/lhc/src/domains/intake-stream/index.ts` |
| Intake validation | `packages/lhc/src/domains/intake-stream/internal/validate.ts` |
| Message projection | `packages/lhc/src/domains/messages/internal/project.ts` |
| Turn placement dependency | `packages/lhc/src/domains/turns/internal/compose.ts` |
| Story tests | `packages/lhc/test/runtime-change-typing.test.ts` (planned) |

#### Design References

- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:61), lines 61-81
- [tech-design.md §Typed runtime-change blocks](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:238), lines 238-249
- [tech-design.md §Deferred / Out of Scope](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:347), lines 347-352
- [test-plan.md §Flow 6](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:111), lines 111-117
- [test-plan.md §Per-Chunk Red/Green Exit Criteria](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:139), lines 139-148

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-6.1a | `packages/lhc/test/runtime-change-typing.test.ts` | Model-change intake event projects to typed `model_change` block with previous and new model. |
| TC-6.2a | `packages/lhc/test/runtime-change-typing.test.ts` | Thinking-level-change intake event projects to typed `thinking_level_change` block with previous and new level. |
| TC-6.3a | `packages/lhc/test/runtime-change-typing.test.ts` | Turn containing model change followed by thinking change renders both blocks unchanged and in order. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Public input compatibility | `packages/lhc/test/runtime-change-typing.test.ts` | Construct events through public `MessageEventInput` and validation before projection. | Projection-only tests can pass while public intake rejects the event. |
| Non-derived placement | `packages/lhc/test/runtime-change-typing.test.ts` | Runtime-change blocks render verbatim through turn composition without derivation work. | Typed block projection alone does not prove constructed turns preserve order. |

#### Technical Notes

- Public `MessageEventInput` gains `model_change` and `thinking_level_change`.
- Validation must require previous/new fields for each event.
- Projection emits typed message blocks; it does not flatten to `runtime_note`.
- pi-lhc thread restoration consumption remains out of scope.

#### Anti-Shim Requirements

- Do not encode runtime changes as text notes with parseable prefixes.
- Do not add derivation work items for runtime-change blocks.
- Do not implement host restoration behavior in this story.

#### Production Path Proof

- Entrypoint: public intake event through `domains/intake-stream`.
- Registration/default path: intake validation accepts the event and message projection emits typed blocks consumed by turn composition.
- Evidence: `packages/lhc/test/runtime-change-typing.test.ts` exercises public input, validation, projection, and turn placement.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/runtime-change-typing.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- AC-6.1 through AC-6.3 pass with their listed TCs.
- `model_change` and `thinking_level_change` blocks carry structured fields.
- Constructed turns place typed runtime-change blocks verbatim in stream order.
- No pi-lhc restoration behavior is added.


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md
Bytes: 11477

# Epic 06: Derivation Recovery and Observability — Test Plan

**Companion to:** `tech-design.md` · **Epic:** `epic.md`
**Counts:** 39 ACs / 59 TCs across 6 flows, mapped to test files below.

## Testing Architecture

- **Real storage.** Every test uses a real temp SQLite thread DB (the persistence/atomicity/idempotency contracts are the point — never mock the store).
- **One mock boundary.** `DerivationProvider`, via the existing `createDeterministicProvider()` for happy paths and two new doubles for failure paths:
  - `failingProvider(opts)` — returns `{ ok:false, retryable }` for a named op, to drive retryable and terminal-failure paths.
  - `probingProvider(fn)` — while its call is pending, runs `fn` which attempts a competing SQLite write (`BEGIN IMMEDIATE` on the same thread DB) and records whether it acquired the lock. Used to prove no write transaction is held across a provider call (stronger than a bare delay).
  - `spyProvider()` — records every call; used to assert **zero** provider calls in compact paths.
- **Verification tiers** are the existing `red-verify` / `verify` / `green-verify` / `verify-all`; no new scripts.
- **First-pass config defaults** used by tests (dial-in values, not architecture):
  - `smoothing.maxInferenceTokens = 4000`
  - `toolResult.tiers = { small: 1000 → 0.10–0.20, mid: 5000 → 0.02–0.05, large: >5000 → truncate }`

## Config defaults under test

| Setting | First-pass value | Tuned in |
|---|---|---|
| smoothing length cap | 4000 tokens | next epic |
| tool-result large-tier threshold | 5000 tokens | next epic |
| tool-result tier targets | 10–20% / 2–5% / truncate | next epic |

---

## TC → Test Mapping

### Flow 1 — Prompt Smoothing → `test/smoothing-recovery.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-1.1a | 1.1 | prompt with irregular whitespace, deterministic provider spy | cleaned whitespace; provider not called for the deterministic stage |
| TC-1.1b | 1.1 | over-cap prompt | deterministic cleaning still applied |
| TC-1.2a | 1.2 | under-cap prompt | `smoothPrompt` invoked; its output stored |
| TC-1.2b | 1.2 | over-cap prompt, provider spy | `smoothPrompt` NOT invoked; deterministic result stored |
| TC-1.3a | 1.3 | prompt with fenced code + typo-laden prose, real-ish passthrough | fenced block byte-identical; prose changed |
| TC-1.4a | 1.4 | over-cap prompt | derivation state `ready` (not "skipped"/"degraded") |
| TC-1.4b | 1.4 | under-cap, inference ok | state `ready` |
| TC-1.5a | 1.5 | `failingProvider({ smoothPrompt: retryable })` | state `pending`, item requeued |
| TC-1.5b | 1.5 | smoothing `pending`, consume via compose | deterministic floor used, no block |
| TC-1.6a | 1.6 | intake a prompt, provider spy | no provider call during intake; smoothing item queued |
| TC-1.7a | 1.7 | `failingProvider` exhausts budget | state `failed` with reason; not `ready` |
| TC-1.7b | 1.7 | `failed` smoothing, consume via compose | deterministic floor used via cascade |

### Flow 2 — Tool-Result Rendering → `test/tool-result-rendering.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-2.1a | 2.1 | large tool result past visibility boundary | deterministic truncation, no provider call, identical input → identical output |
| TC-2.2a | 2.2 | tool result in smooth-band turn | summary produced by queued inference item, not hot path |
| TC-2.3a | 2.3 | result < 1000 tokens | small-tier target applied |
| TC-2.3b | 2.3 | result 1000–5000 tokens | mid-tier target applied |
| TC-2.3c | 2.3 | result > 5000 tokens | truncated, not inference-summarized |
| TC-2.4a | 2.4 | results from two tools | per-tool guidance keyed in prompt; outcome preserved both |
| TC-2.4b | 2.4 | failed tool result | summary states failure outcome |
| TC-2.5a | 2.5 | turn with a tool call | no `tool_call_summary` derivation exists or is queued |
| TC-2.5b | 2.5 | tool call in rendered turn | call args present as recorded, no summary step |
| TC-2.6a | 2.6 | result truncated (full band) + summarized (smooth) | original full result intact in record |
| TC-2.7a | 2.7 | result > 5000 tokens | `tool_result_summary` is the truncation, state `ready`, no inference item created |
| TC-2.8a | 2.8 | in-threshold result, `failingProvider` exhausts | state `failed` with reason; truncation floor used by consumers |

### Flow 3 — Turn Construction and Recovery Cascade → `test/turn-cascade.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-3.1a | 3.1 | turn with smoothed prompt `ready` | smoothed prompt used as-is |
| TC-3.2a | 3.2 | smoothed prompt `pending`, no re-derive | deterministic-cleaned prompt used; turn constructs |
| TC-3.2b | 3.2 | smoothed prompt `failed` | same cascade as pending; usable component |
| TC-3.2c | 3.2 | floor unproducible | original source used |
| TC-3.3a | 3.3 | `tool_result_summary` not ready | truncation used, never raw full result |
| TC-3.4a | 3.4 | turn with assistant text, thinking, runtime-change block | verbatim, in order |
| TC-3.5a | 3.5 | turn with multiple not-ready derivations | construction completes; every component present |
| TC-3.6a | 3.6 | smoothed prompt floored | log entry: derivation type, subject id, reason, floor |
| TC-3.6b | 3.6 | all derivations ready | no fallback log entries |
| TC-3.7a | 3.7 | re-derivation of a not-ready component, `probingProvider` | the competing write acquires its lock while the provider call is pending → no write transaction held across the call |
| TC-3.8a | 3.8 | `failed` component (no live work item) re-derived successfully | `recoverDerivation` persists; row now `ready` with re-derived content |
| TC-3.8b | 3.8 | `pending` component (no live item) resolved to floor | row `ready` with floored content via `recoverDerivation`, no degraded marker, fallback logged |
| TC-3.8c | 3.8 | tool-result summary unready, unrecoverable | floor written back is truncation, never raw |
| TC-3.8d | 3.8 | race: `failed`/`pending` component **with a claimed work item present** (DD-4) | `recoverDerivation` returns `persisted:false`; row left untouched; the turn rendering still used the floor; a later worker completion writes the real `ready` and is not clobbered |

### Flow 4 — Chunk Derivation and Compact Recovery → `test/chunk-compact-recovery.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-4.1a | 4.1 | chunk closes | detailed + brief = two separate work items |
| TC-4.1b | 4.1 | detailed ok, brief fails | states independent (`ready` / `failed`) |
| TC-4.2a | 4.2 | compact needs a `failed` detailed summary, `spyProvider` | `compactChunkMaterial` returns stored-member concat; **zero provider calls** (compact never models) |
| TC-4.3a | 4.3 | summary unrecoverable at compact | band entry = deterministic concat of stored members; no missing span |
| TC-4.4a | 4.4 | compact performs a fallback | visible warning naming what fell back |
| TC-4.4b | 4.4 | compact mid-assembly, stop requested | halts without corrupting thread |
| TC-4.5a | 4.5 | multiple missing/failed summaries | compact completes with concat fallbacks, not failure |
| TC-4.5b | 4.5 | corrupt canonical source for a span | `compactChunkMaterial` returns `blocked`; compact refuses with `state_corruption` |
| TC-4.6a | 4.6 | compact over not-ready summaries, `spyProvider` | **zero** provider calls during the entire compact |
| TC-4.7a | 4.7 | compact falls back to concat | log entry: chunk, derivation type, reason, fallback |
| TC-4.8a | 4.8 | background chunk summary, member `lower_band_projection` `pending` | summary work requeues (waits) with reason `member_projection_not_ready` — not concat, not `failed`, not a provider-failure reason |
| TC-4.8b | 4.8 | member turn source corrupt | background summary surfaces source problem |

### Flow 5 — Derivation Logging → `test/logging-surface.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-5.1a | 5.1 | write at info/warning/error | all three persisted with level |
| TC-5.2a | 5.2 | write from internal + external caller | both land via same method/store |
| TC-5.3a | 5.3 | derivation fell back | subject + rendering carry no degraded flag; fallback event only in log |
| TC-5.3b | 5.3 | derivation terminally failed | derivation record shows `failed` + reason, independent of log |
| TC-5.4a | 5.4 | mixed entries | query by level + derivation type returns only matches |
| TC-5.5a | 5.5 | logging store write fails during turn construction | construction completes; logging failure contained |

### Flow 6 — Runtime-Change Typing → `test/runtime-change-typing.test.ts`

| TC | AC | Setup | Assertion |
|---|---|---|---|
| TC-6.1a | 6.1 | model-change runtime event at intake | typed `model_change` block with previous + new model |
| TC-6.2a | 6.2 | thinking-level-change event at intake | typed `thinking_level_change` block with previous + new level |
| TC-6.3a | 6.3 | turn with model change then thinking change | both typed blocks verbatim, in order |

---

## Architecture-Risk Tests (named)

| Risk | TC(s) | What it proves |
|---|---|---|
| Source-truth preserved | TC-2.6a | full tool result intact under truncation + summary |
| No-txn-across-provider (turn recovery) | TC-3.7a | competing write acquires lock during provider call |
| Compact makes no provider call | TC-4.2a, TC-4.6a | `spyProvider` observes zero calls |
| Recovery write-back defers to live work | TC-3.8d | claimed item present → floor does not persist; worker wins |
| Stale recovery discarded | TC-3.8a (+ version-bump variant) | `recoverDerivation` is version-checked; stale discards |
| Dependency-wait classified correctly | TC-4.8a | reason `member_projection_not_ready`, not provider failure |
| Log never rolls back work | TC-5.5a | logging failure contained, turn still completes |
| Idempotent background wait | TC-4.8a | requeue-and-wait does not duplicate work |
| Tier/cap boundaries | TC-2.3c/2.7a, TC-1.2b | threshold edges behave |
| Rename safety | Story 0 gate | rename is behavior-preserving (`verify-all` green under renamed vocabulary); `tool_call_summary` removal is a separate behavior change with its own red/green |
| Corruption blocks | TC-4.5b | only canonical source corruption stops a compact |

---

## Per-Chunk Red/Green Exit Criteria

| Chunk | Red exit | Green exit |
|---|---|---|
| 0 — rename + logging | renamed tree compiles; logging skeleton present; existing tests reference new names and fail only on logging-not-implemented | suite green under renamed vocabulary; TC-5.1a–5.5a pass. (`tool_call_summary` is renamed-but-retained here; its removal is Chunk 2.) |
| 1 — smoothing floor | smoothing tests red on missing deterministic stage/gate | TC-1.1a–1.7b pass |
| 2 — tool-result tiers + `tool_call_summary` removal | tier-gate + removal tests red (`tool_call_summary` still present) | TC-2.1a–2.8a pass; `tool_call_summary` gone from kind set/registry/`PART_PLANS`/provider |
| 3 — cascade + logging | write-back + fallback-log tests red | TC-3.1a–3.8c pass |
| 4 — chunk/compact recovery | background-wait + compact stored-member concat fallback (no model) tests red | TC-4.1a–4.8b pass |
| 5 — runtime typing | typed-block projection tests red | TC-6.1a–6.3a pass |

## Coverage Confirmation

- 39 ACs, 59 TCs, every TC mapped to a test file and assertion above.
- Every AC has ≥1 TC (verified against `epic.md`).
- Mock boundary: `DerivationProvider` only; all storage real.


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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/05-runtime-change-typing/story-lead/001-current.json
Bytes: 965

```yaml
storyRunId: "05-runtime-change-typing-story-run-001"
storyId: "05-runtime-change-typing"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/05-runtime-change-typing/001-story-validate.json"
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
updatedAt: "2026-06-15T07:23:18.744Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/artifacts/05-runtime-change-typing/story-lead/001-events.jsonl
Bytes: 224

```yaml
-
  storyRunId: "05-runtime-change-typing-story-run-001"
  sequence: 1
  timestamp: "2026-06-15T07:23:18.743Z"
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
Bytes: 255

```yaml
storyGate: "cd packages/lhc && pnpm run verify"
epicGate: "cd packages/lhc && pnpm run verify-all"
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
