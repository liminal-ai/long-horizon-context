# Story Lead Base Prompt

## Role Charter
You are the story lead for `01-pull-and-status` on durable story run `01-pull-and-status-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/stories/01-pull-and-status.md
Bytes: 9173

# Story 1: Pull and Status on the Record

### Summary
<!-- Jira: Summary field -->
The pull path for never-compacted threads — tail assembly, message-array shape, delete filtering, determinism — and the status read.

### Description
<!-- Jira: Description field -->

**User Profile (from epic):** the agentic harness (PI extension first), calling through the SDK on every model call; and the agent/operator running compacts and checking thread health through the CLI.

**Objective:** prove the hot path before any view machinery exists. The array shape pinned here is the contract Stories 2–5 render into.

**Scope in:**
- `thread-view` surface skeleton (structured-result stubs per tech design §Interface Definitions) with `pull` and `status` implemented
- Pull on never-compacted threads: whole record as tail from event 1, tail message-kind rendering per the tech design mapping table, deleted-read filtering, boundary-position rendering (short at-or-behind / full ahead) with the boundary at its seeded default
- Status read, full shape: tail tokens vs threshold, compact recommendation, derivation counts by state (pending/retrying/failed/blocked), view health `null` pre-compact, visibility zone sum vs max

**Scope out:** band content (no compact exists yet — Story 2); boundary movement (Story 4); materialization (Story 5); CLI commands (Story 5 carries the process suite; SDK surface only here).

**Dependencies:** Story 0 (fixture, migration, profiles).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-1.1**: Pulling the active view performs local reads and deterministic assembly only — no inference, no network, no queue interaction, no writes.
  - **TC-1.2** (AC-1.1, AC-1.7): Pull twice with nothing between → byte-identical results; assert no work rows created, no provider double calls recorded (provider fake observes zero calls).
- **AC-1.2**: The pull reflects all intake committed before it: tail messages from every committed batch appear, in record order.
  - **TC-1.1** (AC-1.3, AC-1.2): Intake a short conversation on a fresh thread, never compact, pull → message array carries the full conversation in order; second batch of intake, pull again → new messages appended.
- **AC-1.3**: A never-compacted thread pulls successfully: the view is the full tail from the thread's start, with no band content and no error.
- **AC-1.5** *(default-boundary leg; boundary-active leg lands in Story 4)*: Tail tool results render by boundary position: at-or-behind the boundary renders the short form, ahead of it renders full content. All non-tool-result content in the tail renders full, always.
  - **TC-1.4** (AC-1.5) *(owned here; boundary seeded below-SDK via the sanctioned `test/fixtures/` helper — boundary mechanics owned by Story 4's TC-4.x)*: With the boundary mid-tail, pull → tool results behind it are short-form, ahead of it full, prompts and assistant text full everywhere.
- **AC-1.7**: Two pulls with no intervening intake, boundary advance, or compact return byte-identical output.
- **AC-2.8**: The status read returns: tail size against the configured trigger threshold and a compact recommendation; derivation counts by state (pending, retrying, failed, blocked); the active view's degraded-entry and gap counts; and the visibility zone's token sum against its max — reads only, callable any time, no side effects.
  - **TC-2.5** (AC-2.1, AC-2.8) *(pre-compact legs owned here: status fields, reads-only assertion, no uninvoked compact; view-health legs complete in Story 2)*: Status read on a heavy thread with a degraded active view and a blocked form → tail tokens, threshold, `compactRecommended: true`, derivation counts by state including blocked, view degraded/gap counts, zone sum against max; assert reads only (no work rows, no state change); intake more, status again → tail grew; no compact occurred without invocation.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

First story on the surface: `thread-view/index.ts` is born here with all five operations as structured-result stubs, two of which (`pull`, `status`) go real. The pull this story builds is the *tail-only* path — no view row exists yet, so `snapshot.ts` reads return absent and the whole record renders as tail from event 1. The array shape and tail mapping pinned here are load-bearing for every later story: Story 2 prepends band messages to this exact shape, Story 4 changes which results render short, Story 5 maps it to JSONL.

#### Build Strategy

Types first (`shared/view.ts` landed in Story 0 — consume, don't redefine), then the surface skeleton with all five stubs (Red asserts each returns `{ ok: false, reason: "not implemented: <op>" }`), then Green: `render.ts` tail formatting kind-by-kind against the mapping table, then `pull` assembly, then `status`. The mapping table is seven rows — implement and test them as seven legs, not one blob assertion, so a single kind's drift fails one named test.

#### Implementation Targets

| Target | Work |
|--------|------|
| `src/domains/thread-view/index.ts` | surface skeleton (5 ops, structured-result stubs); `pull` + `status` real |
| `src/domains/thread-view/internal/render.ts` | tail formatting: the 7-kind mapping table, short/full tool-result selection by boundary position, short-form ladder (summary → deterministic truncation) |
| `src/domains/thread-view/internal/snapshot.ts` | read path only: view header + bands, absent ⇒ tail-only signal |
| `src/domains/thread-view/internal/boundary.ts` | position read only (advance is Story 4) |
| `src/sdk.ts` | `threadView` namespace exposing the five ops |

#### Design References

| Topic | Where |
|-------|-------|
| Surface signatures, stub contract | tech-design.md L342–352 |
| `PullResult` / `ViewMessage` / `ViewMeta` / `ViewStatus` | tech-design.md L309–324 |
| Tail message-kind mapping + worked example | tech-design.md L202–229 |
| Pull flow + sequence diagram | tech-design.md L233–249 |
| Short-form ladder (tail tool result row) | tech-design.md L198 |
| Status fields and threshold default | tech-design.md L319–324, L360 |

#### Test Mapping

| TC | Test file | Asserts |
|----|-----------|---------|
| TC-1.1 | `test/view-pull.test.ts` | fresh thread, two intake rounds: full conversation in order, second pull appends; `meta.compactPoint` null |
| TC-1.2 | `view-pull.test.ts` | two pulls, nothing between: byte-identical; zero work rows; provider fake count unchanged |
| TC-1.4 | `view-pull.test.ts` | boundary seeded mid-tail (Story 0 helper): short behind, full ahead, prompts/text full everywhere |
| TC-2.5 (pre-compact legs) | `view-pull.test.ts` | status: tailTokens, threshold, compactRecommended, derivation counts incl. blocked (fixture states), `view: null`, zone sum; reads-only assert; no uninvoked compact |

#### Architecture-Risk Tests

Zero-provider assertion starts here (pull + status legs of the suite-wide assert; completes as later ops land). Supplemental: **mapping legs (×7)** in `view-pull.test.ts` — one leg per message kind matching the table's role + content shape, incl. thinking fencing and tool-call arg rendering (not a TC; the kind-mapping contract every later story renders through). None else owned — but the array shape this story pins is what the restart-snapshot and parity risks later test against.

#### Technical Notes

`status` computes the visibility zone sum with the same deleted-filtered indexed SUM the Story 4 advance will use — build it once in `boundary.ts` now, parameterized by position, so Story 4 consumes it rather than re-deriving it (the design requires the two sums equal; sharing the query makes that structural). `compactRecommended` is `tailTokens > threshold`, nothing smarter — the caller owns policy. Derivation counts come from the owners' report surfaces, not direct `derived_form` reads (must-not-own).

#### Anti-Shim Requirements

The tail-only path must be the real pull code path with snapshot-absent, not a separate "no view yet" branch that Story 2 replaces — if Story 2 has to rewrite Story 1's pull, the shape contract was fiction. TC-1.2's byte-identical assertion must hash the full serialized result, not spot-check fields.

#### Production Path Proof

All reads through the real SDK surface (`createSdk().threadView.pull/status`) against real temp thread files from the Story 0 fixture. No internal-function shortcuts in TC tests (golden/unit tests of `render.ts` legs may call internals; the TC rows go through the surface).

#### Verification

`pnpm verify`; ~9 tests in the default suite.

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-1.1, TC-1.2, TC-1.4 green; TC-2.5 pre-compact legs green; per-kind mapping legs green
- [ ] Zero-provider assertion in place for pull and status (architecture-risk table row 1, partial — completes as later ops land)
- [ ] Array shape documented in `shared/view.ts` comments matching the mapping table exactly
- [ ] `verify` green; no behavior-test weakening (immutability rule)


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
- planner_turn_index: 3
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-verify completed with outcome revise and status ok.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/004-verify.json
- older_response_count: 1
- caller_input_artifact_count: 0
- prior_self_note_count: 2
- latest_self_note: "Acceptance can only be recommended after verifier pass confirms required Story 1 evidence and no open findings remain."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/004-verify.json
bytes: 8356
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "2f42f5aa-9d84-472d-b58f-40b94de35749"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eb730-2e44-7b20-a847-2cdb4d408bc5"
    continuation:
      provider: "codex"
      sessionId: "019eb730-2e44-7b20-a847-2cdb4d408bc5"
      storyId: "01-pull-and-status"
    mode: "initial"
    story:
      id: "01-pull-and-status"
      title: "Story 1: Pull and Status on the Record"
    artifactsRead:
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/stories/01-pull-and-status.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/tech-design.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/test-plan.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/team-impl-log.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/003-implementor.json"
      - "packages/lhc/package.json"
      - "packages/lhc/src/domains/thread-view/index.ts"
      - "packages/lhc/src/domains/thread-view/internal/render.ts"
      - "packages/lhc/src/domains/thread-view/internal/snapshot.ts"
      - "packages/lhc/src/domains/thread-view/internal/boundary.ts"
      - "packages/lhc/src/domains/thread-view/internal/profiles.ts"
      - "packages/lhc/src/shared/view.ts"
      - "packages/lhc/src/shared/context.ts"
      - "packages/lhc/src/shared/errors.ts"
      - "packages/lhc/src/shared/storage.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/src/scheduler.ts"
      - "packages/lhc/src/domains/threads/internal/create.ts"
      - "packages/lhc/src/domains/messages/index.ts"
      - "packages/lhc/src/domains/turns/index.ts"
      - "packages/lhc/test/view-pull.test.ts"
      - "packages/lhc/test/fixtures/view-thread.ts"
      - "packages/lhc/test/fixtures/view-seam.ts"
      - "packages/lhc/test/fixtures/provider-double.ts"
    reviewScopeSummary: "Initial verification for Story 1 covered the story AC/TC text, tech design, test plan, implementor receipt, thread-view source, SDK seam behavior, read/storage paths, and story tests. Configured gates passed, but focused production-path probes found a blocking read-only/no-provider violation in background SDK mode."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "SV-01-PULL-STATUS-001"
        severity: "major"
        title: "Background SDK pull/status can trigger provider-backed drain work"
        evidence: "AC-1.1 requires pull to do local reads and deterministic assembly only with no inference, network, queue interaction, or writes; AC-2.8 requires status to be reads-only with no side effects. `threadView.pull` and `status` call `openThreadDatabase` at `src/domains/thread-view/index.ts:81` and `src/domains/thread-view/index.ts:170`. `openThreadDatabase` always calls `fireThreadTouch` at `src/domains/threads/internal/create.ts:206-209`. In a background SDK, `createSdk` wires that touch to `scheduler.touch` at `src/sdk.ts:339-344`, and `scheduler.touch` schedules a drain when live work exists at `src/scheduler.ts:383-394`. Focused probes confirmed the production effect: after manual intake left 4 work rows, a background `threadView.pull` followed by `drainSettled` changed work rows 4→0 and the provider double captured 5 calls (`smoothPrompt`, `summarizeToolCall`, `summarizeToolResult`, `composeTurnRendering`, `projectLowerBand`). The same happened for background `threadView.status`. A boundary-seeded two-pull probe also returned `equal:false`: first pull rendered raw fallback text and the second rendered the provider-produced summary after the pull-triggered drain. Existing TC-1.2/TC-2.5 tests exercise manual SDK paths only (`test/view-pull.test.ts:34-39`; fixture SDK is manual at `test/fixtures/view-thread.ts:133-139`)."
        affectedFiles:
          - "packages/lhc/src/domains/thread-view/index.ts"
          - "packages/lhc/src/domains/threads/internal/create.ts"
          - "packages/lhc/src/sdk.ts"
          - "packages/lhc/src/scheduler.ts"
          - "packages/lhc/test/view-pull.test.ts"
          - "packages/lhc/test/fixtures/view-thread.ts"
        requirementIds:
          - "AC-1.1"
          - "AC-1.7"
          - "AC-2.8"
          - "TC-1.2"
          - "TC-2.5"
          - "Production Path Audit"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    openFindings:
      -
        id: "SV-01-PULL-STATUS-001"
        severity: "major"
        title: "Background SDK pull/status can trigger provider-backed drain work"
        evidence: "AC-1.1 requires pull to do local reads and deterministic assembly only with no inference, network, queue interaction, or writes; AC-2.8 requires status to be reads-only with no side effects. `threadView.pull` and `status` call `openThreadDatabase` at `src/domains/thread-view/index.ts:81` and `src/domains/thread-view/index.ts:170`. `openThreadDatabase` always calls `fireThreadTouch` at `src/domains/threads/internal/create.ts:206-209`. In a background SDK, `createSdk` wires that touch to `scheduler.touch` at `src/sdk.ts:339-344`, and `scheduler.touch` schedules a drain when live work exists at `src/scheduler.ts:383-394`. Focused probes confirmed the production effect: after manual intake left 4 work rows, a background `threadView.pull` followed by `drainSettled` changed work rows 4→0 and the provider double captured 5 calls (`smoothPrompt`, `summarizeToolCall`, `summarizeToolResult`, `composeTurnRendering`, `projectLowerBand`). The same happened for background `threadView.status`. A boundary-seeded two-pull probe also returned `equal:false`: first pull rendered raw fallback text and the second rendered the provider-produced summary after the pull-triggered drain. Existing TC-1.2/TC-2.5 tests exercise manual SDK paths only (`test/view-pull.test.ts:34-39`; fixture SDK is manual at `test/fixtures/view-thread.ts:133-139`)."
        affectedFiles:
          - "packages/lhc/src/domains/thread-view/index.ts"
          - "packages/lhc/src/domains/threads/internal/create.ts"
          - "packages/lhc/src/sdk.ts"
          - "packages/lhc/src/scheduler.ts"
          - "packages/lhc/test/view-pull.test.ts"
          - "packages/lhc/test/fixtures/view-thread.ts"
        requirementIds:
          - "AC-1.1"
          - "AC-1.7"
          - "AC-2.8"
          - "TC-1.2"
          - "TC-2.5"
          - "Production Path Audit"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    requirementCoverage:
      verified:
        - "AC-1.2 / TC-1.1: story test verifies never-compacted pulls include committed intake in record order and append later intake."
        - "AC-1.3 / TC-1.1: story test verifies tail-only meta with no band content and no error for never-compacted threads."
        - "AC-1.5 / TC-1.4: story tests verify boundary short/full rendering, ready-summary fallback, truncation fallback, and non-tool content full rendering."
        - "Surface skeleton: compact, sweep, and materialize return structured `not_implemented` OpResult errors."
        - "Definition of Done: shared `ViewMessage` comments document band-then-tail array shape and the seven-row tail mapping."
      unverified:
        - "AC-1.1 / TC-1.2: background SDK production path violates no-provider/no-queue/read-only behavior."
        - "AC-1.7 / TC-1.2: background boundary-seeded two-pull focused probe was not byte-identical after the first pull triggered drain work."
        - "AC-2.8 / TC-2.5: background SDK status violates reads-only/no-side-effects behavior."
    gatesRun:
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
      -
        command: "focused background pull side-effect probe via pnpm exec tsx -e"
        result: "fail"
      -
        command: "focused background status side-effect probe via pnpm exec tsx -e"
        result: "fail"
      -
        command: "focused background two-pull determinism probe via pnpm exec tsx -e"
        result: "fail"
    productionPathFindings:
      - "Blocking: background SDK `threadView.pull` and `threadView.status` can trigger scheduler first-touch drains through `openThreadDatabase`/`fireThreadTouch`, causing provider calls and work-row mutations in the real SDK path."
    recommendedNextStep: "revise"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "Configured story and epic gates passed; the blocking issue is a missing production-path scenario in the current tests, not a configured-gate failure."
      - "No material fake adapter, shim, placeholder, or fallback branch was found in the thread-view production code path; the blocker is real side-effect behavior in the SDK read path."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/004-verify.json"
  startedAt: "2026-06-11T14:57:28.474Z"
  finishedAt: "2026-06-11T15:02:55.331Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/003-implementor.json
bytes: 6913
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "b6255c08-b201-49c7-8584-d43447666bd5"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "28aec8fc-3297-4f03-8488-65ebfbadd697"
    continuation:
      provider: "claude-code"
      sessionId: "28aec8fc-3297-4f03-8488-65ebfbadd697"
      storyId: "01-pull-and-status"
    outcome: "ready-for-verification"
    story:
      id: "01-pull-and-status"
      title: "Story 1: Pull and Status on the Record"
    planSummary: "Landed the thread-view surface skeleton with pull and status real. pull is the tail-only hot path built as the production code path with snapshot-absent (band prepend + tail render share one path, no never-compacted branch): snapshot.ts reads the view header/bands (absent ⇒ null) plus the deleted-filtered tail messages, boundary.ts reads the seeded position and owns the parameterized deleted-filtered zone SUM Story 4's advance will consume, and render.ts implements the seven-kind tail mapping table as pure functions with the short-form ladder (ready tool_result_summary → Epic 01 deterministic truncation) selected by boundary position. status reads tail tokens vs threshold (compactRecommended = tailTokens > threshold, nothing smarter), derivation counts bucketed from the owners' report surfaces (must-not-own respected — no direct derived_form reads for counts), view health null pre-compact, and the live zone sum vs max. Config reaches the domain through the per-instance seam (InstanceSeam.view, Flow 4's pattern) with below-SDK calls falling back to resolveViewConfig() defaults. compact/sweep/materialize return structured not-implemented results under a new not_implemented ErrorCode. sdk.ts exposes the threadView namespace (five ops) scoped to the instance seam."
    changedFiles:
      -
        path: "packages/lhc/src/domains/thread-view/index.ts"
        reason: "Surface skeleton: pull and status implemented; compact/sweep/materialize structured-result stubs; Story 0 profile re-exports retained"
      -
        path: "packages/lhc/src/domains/thread-view/internal/render.ts"
        reason: "New: seven-kind tail mapping table, short/full tool-result selection by boundary position, short-form ladder, band-message rendering; pure functions"
      -
        path: "packages/lhc/src/domains/thread-view/internal/snapshot.ts"
        reason: "New: read path — view header + bands (absent ⇒ tail-only signal), tail message/block reads, tail token sum, ready tool_result_summary reads"
      -
        path: "packages/lhc/src/domains/thread-view/internal/boundary.ts"
        reason: "New: boundary position read; visibilityZoneTokens parameterized by position so Story 4's advance consumes the same query (structural sum-equality per Technical Notes)"
      -
        path: "packages/lhc/src/sdk.ts"
        reason: "threadView namespace (ThreadViewSurface, five ops) on Lhc, scoped to the instance seam; seam now carries the resolved view config; threadView domain namespace export"
      -
        path: "packages/lhc/src/shared/context.ts"
        reason: "InstanceSeam gains optional view (ResolvedViewConfig) and resolveInstanceViewConfig() — Flow 4's budgets-resolve-like-the-poke pattern, needed now for status's threshold/max"
      -
        path: "packages/lhc/src/shared/errors.ts"
        reason: "New ErrorCode not_implemented for the surface-skeleton stub contract (system_error class per tech design)"
      -
        path: "packages/lhc/src/shared/view.ts"
        reason: "DoD: array shape documented on ViewMessage — band-then-tail ordering and the full seven-row mapping table"
      -
        path: "packages/lhc/test/view-pull.test.ts"
        reason: "New: TC-1.1, TC-1.2, TC-1.4 (both ladder rungs), TC-2.5 pre-compact legs, seven named mapping legs, stub-contract test, zero-provider pull/status legs"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "Recorded view-pull.test.ts hash for the test-immutability gate"
    tests:
      added:
        - "test/view-pull.test.ts :: surface skeleton: compact/sweep/materialize return structured not-implemented"
        - "test/view-pull.test.ts :: TC-1.1 full conversation in order, second intake appends, tail-only meta"
        - "test/view-pull.test.ts :: TC-1.2 byte-identical pulls (full-result hash), zero work rows, zero provider calls"
        - "test/view-pull.test.ts :: mapping leg user_prompt"
        - "test/view-pull.test.ts :: mapping leg assistant_thinking (fenced)"
        - "test/view-pull.test.ts :: mapping leg tool_call (deterministic args)"
        - "test/view-pull.test.ts :: mapping leg tool_result ahead (full)"
        - "test/view-pull.test.ts :: mapping leg runtime_note"
        - "test/view-pull.test.ts :: mapping leg assistant_text"
        - "test/view-pull.test.ts :: mapping leg tool_result at-or-behind (abridged short form)"
        - "test/view-pull.test.ts :: TC-1.4 ready summary behind / full ahead / non-tool full everywhere"
        - "test/view-pull.test.ts :: TC-1.4 truncation rung with exact dropped-count marker"
        - "test/view-pull.test.ts :: TC-2.5 status fields on heavy thread, reads-only state snapshot, zero provider calls"
        - "test/view-pull.test.ts :: TC-2.5 blocked counts via owner's report (sacrificial sibling)"
        - "test/view-pull.test.ts :: TC-2.5 intake more → tail grew, no uninvoked compact"
      modified:
[]
      removed:
[]
      totalAfterStory: 243
      deltaFromPriorBaseline: 15
    gatesRun:
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
    selfReview:
      passesRun: 0
      findingsFixed:
[]
      findingsSurfaced:
        - "deterministicTruncation in render.ts restates turns/internal/compose.ts's truncateForFallback byte-for-byte: cross-domain internals may not be imported and the turns domain is frozen this epic (tech design: no changes to messages/turns). Worth consolidating into shared/ in a later epic when turns is mutable."
        - "The tech design's stub sketch ({ ok: false, errorClass, reason }) was realized through the codebase's binding OpResult contract as { ok: false, error: { errorClass, code: 'not_implemented', reason } } — a new ErrorCode was added rather than reusing storage_failure so the contract stays machine-readable."
        - "Band-message header format pinned here as '[context · <band>]\\n<snapshot bytes>' ahead of Story 2's band content; render-local and revisitable per open question Q1."
        - "Short-form rendering appends ' [full content in record §<messageId>]' per the tech design's worked example; AC-4.2's marking requirement is satisfied structurally, Story 4 owns the full boundary-active assertions."
    openQuestions:
[]
    specDeviations:
[]
    recommendedNextStep: "Run story verification; Story 2 (compact) can build on the pinned array shape — band prepend point, snapshot read path, and boundary reset seam are all in place."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/003-implementor.json"
  startedAt: "2026-06-11T14:36:50.023Z"
  finishedAt: "2026-06-11T14:57:16.589Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/story-lead/001-current.json
Bytes: 2218

```yaml
storyRunId: "01-pull-and-status-story-run-001"
storyId: "01-pull-and-status"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome revise and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/004-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "28aec8fc-3297-4f03-8488-65ebfbadd697"
    storyId: "01-pull-and-status"
  storyVerifier:
    provider: "codex"
    sessionId: "019eb730-2e44-7b20-a847-2cdb4d408bc5"
    storyId: "01-pull-and-status"
latestEventSequence: 9
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Implementation reports ready-for-verification, but acceptance requires an independent verifier pass. Verify the implementor artifact against Story 1 acceptance criteria, required TC coverage, zero-provider assertions, and the configured gates before recommending acceptance."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/004-verify.json"
replayBoundary: null
updatedAt: "2026-06-11T15:02:55.341Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: Acceptance can only be recommended after verifier pass confirms required Story 1 evidence and no open findings remain.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-11T14:36:49.985Z; note="After implementation returns, verify evidence must include green-verify results plus TC-1.1, TC-1.2, TC-1.4, TC-2.5 pre-compact legs, mapping legs, and zero-provider assertions before acceptance can be recommended."
- sequence=8; actionSequence=7; createdAt=2026-06-11T14:57:28.439Z; note="Acceptance can only be recommended after verifier pass confirms required Story 1 evidence and no open findings remain."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/story-lead/001-events.jsonl
Bytes: 4055

```yaml
-
  storyRunId: "01-pull-and-status-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T14:36:24.646Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "01-pull-and-status-story-run-001"
  sequence: 2
  timestamp: "2026-06-11T14:36:49.961Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb71c-e544-7903-9fe1-5878dda390f4"
-
  storyRunId: "01-pull-and-status-story-run-001"
  sequence: 3
  timestamp: "2026-06-11T14:36:49.985Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementation returns, verify evidence must include green-verify results plus TC-1.1, TC-1.2, TC-1.4, TC-2.5 pre-compact legs, mapping legs, and zero-provider assertions before acceptance can be recommended."
-
  storyRunId: "01-pull-and-status-story-run-001"
  sequence: 4
  timestamp: "2026-06-11T14:36:49.985Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementation returns, verify evidence must include green-verify results plus TC-1.1, TC-1.2, TC-1.4, TC-2.5 pre-compact legs, mapping legs, and zero-provider assertions before acceptance can be recommended."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "01-pull-and-status-story-run-001"
  sequence: 5
  timestamp: "2026-06-11T14:57:16.600Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "01-pull-and-status-story-run-001"
  sequence: 6
  timestamp: "2026-06-11T14:57:28.417Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019eb72f-ffea-7fd1-923e-d123e77d5ca3"
-
  storyRunId: "01-pull-and-status-story-run-001"
  sequence: 7
  timestamp: "2026-06-11T14:57:28.438Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
    selfNote: "Acceptance can only be recommended after verifier pass confirms required Story 1 evidence and no open findings remain."
-
  storyRunId: "01-pull-and-status-story-run-001"
  sequence: 8
  timestamp: "2026-06-11T14:57:28.439Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "Acceptance can only be recommended after verifier pass confirms required Story 1 evidence and no open findings remain."
    actionSequence: 7
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "01-pull-and-status-story-run-001"
  sequence: 9
  timestamp: "2026-06-11T15:02:55.341Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/01-pull-and-status/004-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
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
