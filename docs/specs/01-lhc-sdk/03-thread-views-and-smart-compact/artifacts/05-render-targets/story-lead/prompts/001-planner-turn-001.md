# Story Lead Base Prompt

## Role Charter
You are the story lead for `05-render-targets` on durable story run `05-render-targets-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/stories/05-render-targets.md
Bytes: 10354

# Story 5: Render Targets

### Summary
<!-- Jira: Summary field -->
PI session-file materialization with format fixture and array/file parity, plus the full CLI surface (`lhc view *`) proven through the spawned-process suite.

### Description
<!-- Jira: Description field -->

**User Profile (from epic):** the agentic harness (PI extension first), calling through the SDK on every model call; and the agent/operator running compacts and checking thread health through the CLI.

**Objective:** one view, two shapes — the message array for harnesses with hooks, the PI session file for everything else — and the CLI grammar shipped and proven at the process boundary.

**Scope in:**
- `materialize(ref, { path, format? })` per tech design §Flow 5: runs pull internally, maps to PI session JSONL (header from view metadata, parentId chain, generated fields from view metadata never write-time clocks), writes file, returns path
- Format fixture: structure-trimmed real PI session file in `test/fixtures/`; conformance checks (header line, entry shape, parentId chain)
- `cli/view.ts`: the full grammar from tech design §External Contracts — pull, status, compact, sweep, materialize with all flags
- Process-suite parity legs for all five commands (closes the claimed-vs-proven CLI gap), the profile-violation exit-nonzero leg, and the CLI-intake-advances-boundary architecture-risk leg (Story 4's named debt)

**Scope out:** non-PI formats (`--format` accepts `pi-session` only; unknown → caller error); any view or state mutation from materialize or any CLI read path.

**Dependencies:** Stories 0–2 (a compacted view to render); Story 4 (boundary-affected tail proves parity in both targets); Story 3 (sweep must exist for the sweep CLI parity leg and TC-3.3's CLI receipt leg — if Story 3 slipped past Story 4 under the coverage gate-slip contingency, this story waits for it).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-5.1**: The pull returns the view as an ordered message array: band content as labeled context messages in band order (brief → detailed → smoothed), then tail messages in record order, each with role and content. The mapping is deterministic.
  - **TC-5.1** (AC-5.1): Pull a compacted thread → array opens with band context messages in gradient order, tail follows in record order; roles and labels per the pinned mapping; deterministic across repeated pulls.
- **AC-5.2**: Materialize writes the active view as a PI-format session file at a caller-supplied path; the write changes no thread state; any generated fields in the file derive from active-view metadata, never from write-time clocks, so repeating it after no thread changes produces a byte-identical file.
- **AC-5.3**: The materialized file and the message-array pull of the same view carry the same content: every band entry and tail message in the array appears in the file, same order, same rendered text, in the target format's encoding.
  - **TC-5.2** (AC-5.2, AC-5.3): Materialize, pull, compare → content parity item-for-item; materialize again with no changes → byte-identical file; thread state hash unchanged by materialization.
  - **TC-5.5** (AC-5.3): Format conformance: materialized file validates against a fixture derived from a real PI session file (structure-level: line shape, required fields, message encoding).
- **AC-5.4**: Materializing a never-compacted thread works: the file carries the tail-only view.
  - **TC-5.3** (AC-5.4): Materialize a never-compacted thread → valid file, tail-only content, loadable against the format fixture.
- **AC-5.5**: Pull and materialize are exposed through SDK and CLI; the CLI materialize prints the written path and the CLI pull emits the message array as JSON.
  - **TC-5.4** (AC-5.5): Spawned CLI: pull → JSON message array on stdout; materialize → path printed, file exists, parses; both exit 0; failure case (no such thread file) exits nonzero with a structured error. *(Same file carries the parity legs for status, compact, sweep — architecture-risk rows — and TC-3.3's CLI leg.)*

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The capstone: the view crosses two boundaries — file format and process — and must arrive unchanged at both. `materialize.ts` never reads the record: it renders `pull`'s output, which makes AC-5.3's parity structural rather than tested-into-existence. `cli/view.ts` is the last surface piece, and the process suite here is where three other stories' deferred legs land (Story 3's TC-3.3 CLI leg, Story 4's CLI-advance leg, the all-five parity rows).

#### Build Strategy

Format fixture first — capture a real PI session file, trim to structure, commit with provenance note — because TC-5.5 is unwritable without it and it may surface format surprises that reshape `materialize.ts`. Then materialize over pull output (pure mapping + file write), then `cli/view.ts` command-by-command, then the process suite. Red: `materialize` stub; CLI commands exit nonzero with structured not-implemented.

#### Implementation Targets

| Target | Work |
|--------|------|
| `src/domains/thread-view/internal/materialize.ts` | pull → JSONL mapping: header from view metadata (`id` from thread id + view createdAt, never `Date.now()`), parentId chain, band + tail messages in pull order; file write; `{ writtenPath }` |
| `src/cli/view.ts` | five commands per the pinned grammar (file-path/thread-id refs, profile + band-override flags, `--no-sweep`, `--json`, `--out`, `--format`); structured errors; exit codes |
| `test/fixtures/pi-session-structure.jsonl` | structure-trimmed real PI session + provenance note (PI version) |
| `test/cli-process-view.test.ts` | TC-5.4 + all deferred process legs |

#### Design References

| Topic | Where |
|-------|-------|
| PI session format pin (header, entry, parentId, metadata-derived fields) | tech-design.md L61 |
| CLI grammar, flag semantics | tech-design.md L67–79 |
| Materialize flow + parity-by-construction | tech-design.md L291–293, L133 (must-not-own) |
| Band-message order in the array (brief → detailed → smooth → tail) | tech-design.md L235, L309 |
| Process-suite legs | test-plan.md L64–65 (CLI parity + CLI-advance rows), L47 |

#### Test Mapping

| TC | Test file | Asserts |
|----|-----------|---------|
| TC-5.1 | `test/view-render-targets.test.ts` | band context messages in gradient order, tail in record order, roles/labels per mapping; deterministic across pulls |
| TC-5.2 | `view-render-targets.test.ts` | item-for-item parity materialize↔pull; repeat → byte-identical file; thread state hash unchanged |
| TC-5.3 | `view-render-targets.test.ts` | never-compacted → valid tail-only file, loads against fixture |
| TC-5.5 | `view-render-targets.test.ts` | header line shape, entry fields, parentId chain vs structure fixture |
| TC-5.4 | `test/cli-process-view.test.ts` | spawned: pull JSON on stdout; materialize prints path, file parses; missing thread → nonzero + structured error |

#### Cross-Story Debt

Process-suite legs this story closes for other owners — all in `cli-process-view.test.ts`, all named in coverage.md's debts table:

| Leg | Owner | Asserts |
|-----|-------|---------|
| TC-3.3 CLI leg | Story 3 | spawned sweep receipt = SDK schema (closes Story 3 deferral) |
| CLI-advance leg | Story 4 | spawned CLI intake over max → pull shows flips, status zone ≤ target (closes Story 4 debt) |
| parity legs (all five ops) | epic-level NFR | compact/status/sweep receipts JSON = SDK shapes; profile violation → nonzero naming constraint |

#### Architecture-Risk Tests

The two process-suite rows above are this story's architecture-risk load: claimed-vs-proven CLI surface, and the seam-install class (a createSdk-only advance install passes every in-process test and fails the spawned leg). Zero-provider now asserted on CLI paths too — view commands run with **no provider configured at all** (the design's prerequisite line), which is itself the proof that no view operation needs one.

#### Technical Notes

Deterministic `id`s: the header id derives from thread id + view createdAt; message entry ids from message ids; a never-compacted thread's header uses the thread's created-at (viewId null — `ViewMeta` carries both nullables). Byte-identical repeats are the test for any sneaky `Date.now()`/random — hash the whole file. CLI band-override flags merge field-wise over the profile *before* validation, so `--full 40` on a 30/30/20/20 profile fails the sum check with the named violation — that's correct behavior, not a bug to smooth over. The `--format` flag accepts only `pi-session`; unknown → `caller_error` naming accepted values.

#### Anti-Shim Requirements

The format fixture must come from a *real* PI session file with its provenance recorded — not hand-authored from the design's description (the design pinned the format from PI source, but the fixture's job is to catch the design being wrong about PI, which a design-derived fixture cannot). Materialize must not grow a record-reading path for any reason — if pull's output is insufficient for the file, fix pull's output.

#### Production Path Proof

The entire process suite spawns `dist/cli.js` — built artifact, real argv, real exit codes, no provider env. In-process render-target tests go through `createSdk().threadView.materialize` against fixture threads.

#### Verification

`pnpm verify` for the default suite; `LHC_PROCESS_SUITE=1 pnpm verify-all` for story completion — this story is where the epic's process suite goes from absent to `ran`, closing the suite-accounting row.

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-5.1–5.5 green; all five CLI commands proven at the process boundary; profile-violation and missing-thread failure legs green
- [ ] CLI-intake-advances-boundary leg green (closes Story 4's debt comment)
- [ ] TC-3.3's CLI receipt-shape leg green (closes Story 3's deferred leg)
- [ ] Format fixture committed with provenance note (which PI version produced the source session)
- [ ] Zero-provider assertion spans all five operations including CLI paths
- [ ] `verify-all` green including process suite (`LHC_PROCESS_SUITE=1`)


### Test Plan
### test-plan
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/test-plan.md
Bytes: 10179

# Epic 03: Thread Views and Smart Compact — Test Plan

Companion to `tech-design.md`. Maps all 27 TCs to test files, names the architecture-risk tests with their rationale, and pins the golden cases for the two deterministic algorithms. Suites follow Epic 02's segmentation: in-process vitest suites by default; spawned-process CLI suites under `LHC_PROCESS_SUITE=1`.

## Test Files

| File | Suite | Covers |
|------|-------|--------|
| `test/view-fixture.test.ts` | default | FC-0.x fixture invariants |
| `test/view-pull.test.ts` | default | TC-1.1–1.5 |
| `test/view-compact.test.ts` | default | TC-2.1–2.7 |
| `test/view-select-golden.test.ts` | default | Selection/boundary golden cases (architecture-risk) |
| `test/view-sweep.test.ts` | default | TC-3.1–3.4 |
| `test/view-boundary.test.ts` | default | TC-4.1–4.6 |
| `test/view-render-targets.test.ts` | default | TC-5.1–5.3, 5.5 |
| `test/cli-process-view.test.ts` | process | TC-5.4; CLI parity for all five commands (pull, status, compact, sweep, materialize) |

## TC → Test Mapping

| TC | ACs | Test file | Test (user-visible outcome) | Notes |
|----|-----|-----------|------------------------------|-------|
| TC-1.1 | 1.2, 1.3 | view-pull | never-compacted thread pulls full conversation in order; later intake appends | fresh temp thread, two intake rounds |
| TC-1.2 | 1.1, 1.7 | view-pull | two pulls with nothing between are byte-identical and create no work or provider calls | provider fake call-count assert |
| TC-1.3 | 1.4 | view-pull | band bytes unchanged after edit + drain of a banded subject | compact first via fixture; hash band messages |
| TC-1.4 | 1.5 | view-pull | boundary mid-tail: short behind, full ahead, non-tool always full | boundary row seeded below-SDK via a sanctioned `test/fixtures/` helper (same sanctioning as the corruption fixture); boundary mechanics owned by TC-4.x |
| TC-1.5 | 1.6 | view-pull | tail delete vanishes from next pull; banded-subject delete leaves snapshot until compact | uses messages.delete + turns.delete |
| TC-2.1 | 2.2, 2.3, 2.7 | view-compact | profile compact succeeds with config in receipt; 105% sum and unknown profile reject with named violations, thread unchanged | read-back equality after rejections |
| TC-2.2 | 2.4, 2.9 | view-compact | full-coverage compact targets the bound: receipt actuals near band shares, every deviation attributable to a whole-entry rule; zero provider calls; record untouched | record hash before/after |
| TC-2.3 | 2.5, 2.7 | view-compact | failed + pending forms degrade per ladder, receipt lists both, every subject represented | fixture's failed-transient/pending subjects |
| TC-2.4 | 2.6 | view-compact | crash injected between sweep and write: prior view serves; rerun lands clean | Story-0 injection seam |
| TC-2.5 | 2.1, 2.8 | view-pull + view-compact | status on degraded thread reports all fields; reads only; nothing compacts uninvoked | split: pre-compact legs in Story 1, view-health legs Story 2 |
| TC-2.6 | 2.10 | view-compact | band text carries §chunk/§turn keys | regex over rendered bands |
| TC-2.7 | 2.5 | view-compact | canonical corruption → `state_corruption` naming damage, prior view serves; derived-only damage → compacts with gaps | corruption fixture variant; control leg |
| TC-3.1 | 3.1–3.3 | view-sweep | sweep classifies the five seeded states correctly, requeues only transient, returns without waiting, zero provider calls | elapsed-time + provider-count asserts |
| TC-3.2 | 3.4 | view-sweep | second sweep without drain: requeued form reported in-flight, no second work row | work_item count by key |
| TC-3.3 | 3.5, 3.7 | view-sweep | standalone SDK and CLI sweep return same receipt shape and counts | CLI leg lives in process suite, asserted by shape here via shared schema |
| TC-3.4 | 3.6, 2.7 | view-sweep | default compact embeds sweep receipt; skip records skip + zero requeues; post-drain compact includes healed form | drain via background drainSettled |
| TC-4.1 | 4.3 | view-boundary | under-max batches never move boundary (byte-identical pulls); crossing batch moves once to target, oldest-first | |
| TC-4.2 | 4.1, 4.2 | view-boundary | flipped: usable summary renders summary; failed renders truncation + marker; interleaved assistant text full | |
| TC-4.3 | 4.5 | view-boundary | monster turn: advance enters open turn but the whole-message protected set stays full (newest results joined to ≥ floor; oversized-newest protected alone); turn's text messages all full | architecture-risk: floor arithmetic |
| TC-4.4 | 4.6, 4.7 | view-boundary | no backward motion across small batches; compact resets to compact point; fresh tail full | |
| TC-4.5 | 4.4, 4.8 | view-boundary + select-golden | replay equality: same record + budgets ⇒ same trajectory; max<target rejected naming constraint | golden trajectory case |
| TC-4.6 | 4.9 | view-boundary | injected advance failure: intake succeeds, boundary unmoved, status shows over-max; next batch heals | injection seam; also asserts poke still fired (drain ran) |
| TC-5.1 | 5.1 | view-render-targets | array opens with bands in gradient order then tail in record order; deterministic | |
| TC-5.2 | 5.2, 5.3 | view-render-targets | materialize/pull parity item-for-item; repeat byte-identical; thread state hash unchanged | |
| TC-5.3 | 5.4 | view-render-targets | never-compacted materialize: valid tail-only file loadable against fixture | |
| TC-5.4 | 5.5 | cli-process-view | spawned pull emits JSON array; materialize prints path, file parses; missing thread exits nonzero structured | process suite; the same file carries parity legs for the other three commands (below) |
| TC-5.5 | 5.3 | view-render-targets | materialized file validates against real-PI-session structure fixture | header line, entry shape, parentId chain |

Every TC mapped; no orphans. FC-0.x fixture invariants (each manufactured state proven by read-back; states reached through production drains) live in `view-fixture.test.ts` and run before everything in CI order.

## Architecture-Risk Tests

Beyond TC mapping — each exists because the architecture creates a hazard the ACs don't name:

| Test | File | Hazard it guards |
|------|------|------------------|
| zero-provider sweep across all five ops | view-sweep | The provider fake is in scope for fixtures; nothing stops an internal "helpful" derivation call except this assert. The epic's no-inference rule needs teeth. |
| selection replay goldens (3 cases below) | view-select-golden | AC-2.9 says deterministic; only exact-arrangement goldens catch tie-breaker drift (≤ vs <, newest-first ordering) that replay-on-same-engine misses. |
| boundary trajectory golden | view-select-golden | Same: floor/target arithmetic off-by-one survives property tests, not goldens. |
| advance/poke seam isolation | view-boundary | TC-4.6's sibling: a *throwing* advance must not eat the queue poke (drain still runs), and a failing poke must not block the advance. Ordering pinned in design Flow 4. |
| restart serves snapshot | view-compact | Snapshot durability: compact, close SDK, reopen thread file fresh, pull → identical bytes. Real-file restart, not same-process reread. |
| coverage edge accounting | view-compact | When brief budget excludes old chunks: `covered_from` correct, receipt reports exclusion, no silent omission *and* no phantom gap entries for out-of-window chunks. |
| CLI parity: compact/status/sweep | cli-process-view | Scope promises five CLI commands; spawned legs: `view compact --profile` (receipt JSON = SDK shape), `view status` (status JSON = SDK shape), `view sweep` (receipt JSON = SDK shape), plus profile-violation exit-nonzero leg. Closes the gap between claimed CLI surface and proven CLI surface. |
| CLI intake advances boundary | cli-process-view | The design's both-modes advance rule proven at the process boundary: spawned CLI intake on an over-max thread → subsequent `view pull` shows flipped results, `view status` shows zone ≤ target. Guards the seam-install class (a createSdk-only install would pass every in-process test and fail this one). |

## Golden Cases

**Selection G1 — proportions:** fixture thread, `conversation` profile (120k/12/48/20/20 scaled down by fixture factor): exact expected arrangement (subject ids per band, compact point, covered_from) checked against committed JSON golden.
**Selection G2 — budget-edge inclusion:** a turn whose rendering exactly fills the smooth remainder → included (≤ rule); one token over → excluded and band stops.
**Selection G3 — oversized loner:** single turn larger than the whole smooth budget on an otherwise-empty band → included alone (empty-band exception).
**Selection G4 — turnless straggler:** fixture variant with a runtime note between `turn_end` and the next prompt, compacted so the note's neighborhood lands in a band → note rides the following turn's band entry (rule 6: `[inter-turn note]` marker before the entry, its tokens counted in that turn's fill cost); trailing-straggler leg: a note after the last turn → tail.
**Boundary G1 — trajectory:** scripted intake sequence (sums crossing max twice, one monster turn) → committed expected positions after each batch. Floor legs (whole-message rule): protected set = newest tool results joined until the set's sum first reaches/exceeds floor; an oversized newest result is protected alone and the zone legally sits above target (or max) that batch; boundary never lands inside the protected set; at least the newest result is full whenever any exists.

## Chunk Red/Green Detail

Per-chunk TDD tables follow Epic 02's pattern; estimates: Chunk 0 ≈ 6, 1 ≈ 9, 2 ≈ 16 (incl. goldens + restart), 3 ≈ 10, 4 ≈ 13, 5 ≈ 11 — ~65 total. Red exits on the project `red-verify` (no behavior tests); structured-result stubs make Red failures assertion-shaped on the surface ops. Green exits on `green-verify` with test immutability. The process suite runs at story completion (`verify-all`), not in Red/Green loops.

Suite labels for `verify-all` accounting: default suites `ran`; process suite `ran` under flag; no absent/skipped suites in this epic.


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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/05-render-targets/story-lead/001-current.json
Bytes: 960

```yaml
storyRunId: "05-render-targets-story-run-001"
storyId: "05-render-targets"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration started and durable state has been initialized."
currentPhase: "story-orchestrate-run"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/05-render-targets/001-story-validate.json"
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
updatedAt: "2026-06-11T17:50:28.815Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
No prior runtime self-notes are recorded yet.

## Seeded Self-Note Example
Seeded first-turn instruction (not a prior runtime self-note): include `selfNote` when you want to leave a durable reminder for a later planner turn, for example `Track whether the next verifier pass still needs the ruling evidence.`

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/05-render-targets/story-lead/001-events.jsonl
Bytes: 217

```yaml
-
  storyRunId: "05-render-targets-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T17:50:28.814Z"
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
Bytes: 223

```yaml
storyGate: "pnpm run green-verify"
epicGate: "pnpm run verify-all"
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
