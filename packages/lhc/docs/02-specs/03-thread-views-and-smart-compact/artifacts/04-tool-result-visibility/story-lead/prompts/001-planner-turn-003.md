# Story Lead Base Prompt

## Role Charter
You are the story lead for `04-tool-result-visibility` on durable story run `04-tool-result-visibility-story-run-001`.
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
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/stories/04-tool-result-visibility.md
Bytes: 11959

# Story 4: Tool-Result Visibility

### Summary
<!-- Jira: Summary field -->
The visibility boundary: post-commit advance through the SDK seam in both host modes, whole-message floor protection, never-backward, compact reset, short-form rendering.

### Description
<!-- Jira: Description field -->

**User Profile (from epic):** the agentic harness (PI extension first), calling through the SDK on every model call; and the agent/operator running compacts and checking thread health through the CLI.

**Objective:** the tail self-regulates. Old tool results age to short form in batches when a budget breaks — log rotation, not per-turn churn.

**Scope in:**
- `boundary.ts` advance per tech design §Deterministic Algorithms: post-commit indexed sum (deleted-filtered) → over max ⇒ advance oldest-first to target, stopping at the whole-message protected set (newest results joined to ≥ floor; oversized-newest protected alone) → write position
- Wiring per the Flow 4 DD: intake-stream registers the advance on `ctx.onCommit` (advance first, poke second, throw-isolated both directions); runs in **both host modes**; budgets resolve through the per-instance seam with defaults below SDK
- Advance-failure semantics: intake unaffected, boundary unchanged, condition visible in status (computed live), next batch heals
- Compact reset proven end-to-end (the reset transaction itself landed in Story 2)
- Boundary trajectory golden (test plan Boundary G1, whole-message floor legs)
- Completes AC-1.5: boundary-active rendering in pulls

**Scope out:** any change to band rendering; any host-called advance surface (no public advance operation exists — the seam is the only writer besides compact reset).

**Dependencies:** Stories 0–2 (compact reset interaction); Story 1's pull. Independent of Story 3.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-4.1**: Each thread carries one visibility boundary. Tail tool results at-or-behind it render the short form; ahead of it, full. Non-tool-result content is never affected by the boundary.
- **AC-4.2**: The short form is the result's summarized abbreviation when that form is usable, else deterministic truncation. Short-form rendering marks that fuller content exists in the record.
  - **TC-4.2** (AC-4.1, AC-4.2): With flipped results: one with a usable summary renders the summary; one with a failed summary renders deterministic truncation with the marker; an interleaved assistant message renders full.
- **AC-4.3**: The boundary advances only when, after an intake batch commits, the full-zone tool-result token sum exceeds the max budget; the advance moves oldest-first until the sum is at-or-under the target. Below max, the boundary does not move and rendered bytes do not change.
  - **TC-4.1** (AC-4.3): Intake tool results totaling under max → boundary unmoved; pulls byte-identical across batches. Cross max with one more batch → boundary advances once to target; exactly one batch of results flipped, oldest-first; next under-max batch → no movement.
- **AC-4.4**: The advance is deterministic and mechanical: token sums from stored per-message estimates, no inference, no provider calls.
- **AC-4.5**: The boundary never advances into the protected set: the newest whole tool-result messages, joined newest-backward until their combined tokens first reach or exceed the floor, render full — even when the open turn alone exceeds the max, and even when the newest single result exceeds the floor by itself (it is protected alone; the zone may legally sit above target until later batches or a compact create room).
  - **TC-4.3** (AC-4.5): Single monster turn: tool results exceeding max within one open turn → boundary advances into the turn but stops at the protected set; the newest whole results (combined tokens ≥ floor) render full; oversized-newest leg: a single result larger than the floor is protected alone; the turn's own text messages all render full.
- **AC-4.6**: The boundary never moves backward. A result that has rendered short never renders full in a later pull (within the same compact window, and its banded representation thereafter).
- **AC-4.7**: Compact resets the boundary to the compact point.
  - **TC-4.4** (AC-4.6, AC-4.7): After an advance, intake small batches → flipped results stay flipped (no backward motion); compact → boundary equals compact point; fresh tail renders full.
- **AC-4.8**: Max, target, and floor are configuration with defaults; max > target ≥ floor is validated with a caller error.
  - **TC-4.5** (AC-4.4, AC-4.8): Advance on a seeded thread is reproducible: same record, same budgets → same boundary trajectory (replay equality); configure max < target → caller error naming the constraint.
- **AC-4.9**: The advance check runs after intake commit, outside the intake transaction, triggered through the SDK's post-commit seam — never by a separate host call. Intake's outcome never depends on it. A failed advance leaves the boundary unchanged with the over-budget condition visible in the status read; the next successful check re-evaluates and advances.
  - **TC-4.6** (AC-4.9): Inject a failure at the advance seam (test seam from Story 0); intake a batch that crosses max → intake reports success and all messages committed; boundary unchanged; status read shows the zone sum over max. Clear the injection; intake another batch → the advance lands at target.
- *(completes AC-1.5 boundary-active leg, primary owner Story 1)* via TC-4.1/TC-4.2 rendering assertions (TC-1.4's seeded-row version was Story 1's).

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The boundary is the view's one self-acting piece — everything else changes by explicit call. Its writers are exactly two: this story's post-commit advance and Story 2's compact reset (already landed; this story proves the reset end-to-end). The advance rides the same `ctx.onCommit` seam as Epic 02's queue poke, registered by intake-stream — which makes this the story that introduces the sanctioned intake→thread-view surface import and the domain graph's first cycle (both pre-cleared in the design and the check-boundaries script per Story 0's DoD).

#### Build Strategy

Pure decision first: `advanceDecision(zone summary, budgets) → new position | none` as a pure function, driven by Boundary G1's trajectory golden including the floor legs — all the arithmetic risk, no IO. Then the write path (own short transaction), then the seam wiring (registration order, throw isolation), then the rendering integration (short forms in pulls — `render.ts` already selects by position from Story 1; this story makes positions *move*). Red: decision function throws `NotImplementedError`; seam registered but no-op.

#### Implementation Targets

| Target | Work |
|--------|------|
| `src/domains/thread-view/internal/boundary.ts` | `advanceDecision` (pure); advance executor (sum → decide → write, own transaction); the shared deleted-filtered SUM (built in Story 1, consumed here) |
| `src/domains/intake-stream/index.ts` | the one registration: advance first, poke second, advance wrapped (catch + diagnose, never throw into flush, never eat the poke) |
| budget resolution | instance seam (`SdkViewConfig.visibility`) with defaults below SDK — same mechanism as the poke's instance resolution, no new channel |

#### Design References

| Topic | Where |
|-------|-------|
| Advance algorithm, whole-message floor, coordinate system, failure semantics | tech-design.md L187–189 |
| Wiring DD: registration order, throw isolation, both-modes, budget resolution | tech-design.md L285–289 |
| Budgets shape + defaults | tech-design.md L307, L357–361 |
| Short-form ladder + `abridged` marker | tech-design.md L198, L202–229 |
| Boundary G1 trajectory + floor legs | test-plan.md L73 |
| Seam-isolation hazard | test-plan.md L61 |
| Epic 02's onCommit/instance-seam mechanics (the consumed pattern) | ../02-derivation-pipeline/tech-design.md L81 (DD-5 onCommit), L124 (context.ts flush/drop) |

#### Test Mapping

| TC | Test file | Asserts |
|----|-----------|---------|
| TC-4.1 | `test/view-boundary.test.ts` | under-max: position unchanged, pulls byte-identical; crossing batch: one move to target, oldest-first flips; next under-max: no move |
| TC-4.2 | `view-boundary.test.ts` | flipped renders: usable summary → summary; failed summary → deterministic truncation + marker; interleaved assistant text untouched |
| TC-4.3 | `view-boundary.test.ts` | monster turn: advance enters open turn, stops at protected set (≥ floor by whole messages); oversized-newest protected alone; text messages all full |
| TC-4.4 | `view-boundary.test.ts` | no backward motion across small batches; compact → position = compact point; fresh tail full |
| TC-4.5 | `view-boundary.test.ts` + golden | replay equality on seeded thread; max<target → named caller error |
| TC-4.6 | `view-boundary.test.ts` | injected advance failure: intake succeeds + messages committed; position unchanged; status zone > max; **poke still fired (drain ran)**; cleared → next batch lands at target |

#### Architecture-Risk Tests

Seam isolation, both directions (a throwing advance never eats the poke — TC-4.6 carries the assert; a failing poke never blocks the advance — separate leg). Both-modes proof in-process: manual-mode SDK intake advances, background-mode SDK intake advances. The process-boundary CLI leg is Story 5's (named debt in DoD). Supplemental golden: **Boundary G1 trajectory** in `view-select-golden.test.ts` — committed positions after each scripted batch, floor legs included (not a TC; hand-derived expectations per the goldens discipline).

#### Technical Notes

The advance's sum and `status`'s zone sum are the same query by construction (Story 1 note) — if they ever diverge, TC-4.6's status assertion is the canary. "Visible in status" is structural, not stored: no failure flag row exists; status recomputes the sum live. The advance writes in its own short transaction *after* intake's commit — never inside intake's transaction (AC-4.9's isolation is the point). Flip granularity is whole messages, oldest-first by `source_event_order`; the protected-set walk is newest-backward. Budgets resolve per-instance: a CLI invocation and a background extension on the same thread may briefly hold different budgets — the boundary only moves forward, so the worst case is an earlier flip than the larger config would choose, which is benign and not worth a coordination mechanism.

#### Anti-Shim Requirements

No host-called advance surface may exist — if a test needs an advance, it intakes a batch (the seam is the only trigger; a test-only `advance()` export would be the forgettable-nudge pattern reborn). The G1 golden's expected positions are hand-derived from the design rules before implementation, same discipline as Story 2's goldens. TC-4.6's injection uses the Story 0 facility's named post-commit point — not a mock of `boundary.ts`.

#### Production Path Proof

Advances fire through real `intake.messageEvents` commits on both host modes; rendering proven through real `pull` calls. The seam registration is the production registration — no test-only wiring.

#### Verification

`pnpm verify`; ~13 tests default suite. Story 5 closes the CLI-process leg.

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-4.1–4.6 green; seam-isolation tests green both directions; G1 trajectory golden committed
- [ ] Both-modes rule proven in-process (manual-mode SDK intake advances; background-mode SDK intake advances) — process-boundary CLI leg deferred to Story 5 with a named debt comment
- [ ] Status zone sum verified equal to advance-decision sum on the same state (deleted-filter consistency)
- [ ] `verify` green


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
- current_summary: story-verify completed with outcome pass and status ok.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/004-verify.json
- older_response_count: 1
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "After implementor returns, check for required evidence: TC-4.1-4.6, seam isolation both directions, both host modes, G1 golden, status sum consistency, and green-verify output before deciding verify or quick-fix."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/004-verify.json
bytes: 5843
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "pass"
  result:
    resultId: "d9d0303f-8262-41a7-a750-2ea9345b1a59"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eb7ca-5bdc-7001-8bde-225e63cfa400"
    continuation:
      provider: "codex"
      sessionId: "019eb7ca-5bdc-7001-8bde-225e63cfa400"
      storyId: "04-tool-result-visibility"
    mode: "initial"
    story:
      id: "04-tool-result-visibility"
      title: "Story 4: Tool-Result Visibility"
    artifactsRead:
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/stories/04-tool-result-visibility.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/tech-design.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/test-plan.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/003-implementor.json"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/preflight/006-preflight.json"
      - "packages/lhc/src/domains/thread-view/internal/boundary.ts"
      - "packages/lhc/src/domains/thread-view/index.ts"
      - "packages/lhc/src/domains/intake-stream/internal/pipeline.ts"
      - "packages/lhc/src/domains/thread-view/internal/render.ts"
      - "packages/lhc/src/domains/thread-view/internal/snapshot.ts"
      - "packages/lhc/src/domains/thread-view/internal/profiles.ts"
      - "packages/lhc/src/shared/context.ts"
      - "packages/lhc/src/shared/storage.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/src/shared/view.ts"
      - "packages/lhc/test/view-boundary.test.ts"
      - "packages/lhc/test/view-select-golden.test.ts"
      - "packages/lhc/test/goldens/boundary-g1-trajectory.json"
      - "packages/lhc/test/goldens/README.md"
      - "packages/lhc/test/red-manifest.json"
      - "packages/lhc/package.json"
    reviewScopeSummary: "Initial verification for Story 4 covered the story AC/TC mapping, tech design, test plan, implementation diff, focused boundary tests, Boundary G1 golden, budget/config wiring, compact reset path, and gate evidence. No blocking findings found."
    priorFindingStatuses:
[]
    newFindings:
[]
    openFindings:
[]
    requirementCoverage:
      verified:
        - "AC-4.1 / TC-4.2: view_boundary singleton exists from migration; renderToolResult switches only tool_result rows at-or-behind boundary, while renderTailMessage leaves user_prompt, assistant_text, assistant_thinking, tool_call, and runtime_note on full render paths. view-boundary.test asserts summary/truncation plus interleaved assistant text full."
        - "AC-4.2 / TC-4.2: render.ts uses ready tool_result_summary or deterministicTruncation and appends '[full content in record §...]'; test lines 173-237 assert ready summary, failed-summary truncation, abridged marker, and full-content marker."
        - "AC-4.3 / TC-4.1: boundary.ts sums deleted-filtered tool results ahead of boundary and compact point, returns null under max, and advances oldest-first to target; test lines 113-170 assert under-max no movement, byte-stable prefix, crossing advance, oldest-first flips, and next under-max no movement."
        - "AC-4.4 / TC-4.5: advanceDecision is pure over stored sourceEventOrder/tokenEstimate rows with no provider path; Boundary G1 golden replay in view-select-golden.test lines 185-282 verifies deterministic trajectory equality."
        - "AC-4.5 / TC-4.3: advanceDecision builds the protected set newest-backward until floor is reached and never flips into it; tests lines 240-314 assert monster-turn whole-message floor and oversized-newest protected-alone legs."
        - "AC-4.6 / TC-4.4: executeBoundaryAdvance has a position-forward UPDATE guard, and test lines 317-363 assert flipped results stay flipped across later small batches."
        - "AC-4.7 / TC-4.4: replaceViewSnapshot updates view_boundary.position to compactPoint in the compact transaction; test lines 340-363 proves compact reset and fresh tail full rendering end-to-end."
        - "AC-4.8 / TC-4.5: resolveVisibility applies defaults and validates max > target >= floor with named TypeError messages; test lines 366-378 assert both ordering violations."
        - "AC-4.9 / TC-4.6: intake pipeline registers boundary advance on ctx.onCommit before queue pokes, wraps failures, and flushes after COMMIT; test lines 380-432 asserts intake success, messages committed, boundary unchanged, status over max, poke still fired, and next batch heals."
        - "Architecture-risk seam isolation: test lines 435-456 asserts a failing poke does not block the already-registered advance; tests lines 495-505 prove manual and background SDK intake both advance in-process."
        - "DoD coverage: TC-4.1-4.6 are covered in packages/lhc/test/view-boundary.test.ts; Boundary G1 golden is committed in packages/lhc/test/goldens/boundary-g1-trajectory.json; status-sum/delete-filter consistency is tested at lines 459-492; green-verify and verify-all passed from packages/lhc."
      unverified:
[]
    gatesRun:
      -
        command: "cd packages/lhc && pnpm run green-verify"
        result: "pass"
      -
        command: "cd packages/lhc && pnpm run verify-all"
        result: "pass"
    productionPathFindings:
[]
    recommendedNextStep: "pass"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "Root package.json does not define green-verify/verify-all; the gate scripts are defined in packages/lhc/package.json and were run from packages/lhc."
      - "The Story 0 test injection seam remains in real code but is explicitly required by this story's TC-4.6 and is inert unless tests install a hook."
      - "The process-boundary CLI intake advance proof is explicitly deferred to Story 5 in the story DoD and test plan; Story 4's required both-host-modes proof is covered in-process."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/004-verify.json"
  startedAt: "2026-06-11T17:45:52.698Z"
  finishedAt: "2026-06-11T17:48:58.643Z"
```
</current_response>

<history_responses>

<history_entry>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/003-implementor.json
bytes: 6874
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "6d65c327-9aad-4a18-a6cf-9fcf0f21a486"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "a19a2d2c-079f-4c8b-a6d9-08d7c8df8763"
    continuation:
      provider: "claude-code"
      sessionId: "a19a2d2c-079f-4c8b-a6d9-08d7c8df8763"
      storyId: "04-tool-result-visibility"
    outcome: "ready-for-verification"
    story:
      id: "04-tool-result-visibility"
      title: "Story 4: Tool-Result Visibility"
    planSummary: "Built the visibility boundary's advance: a pure `advanceDecision` (over-max trigger, oldest-first flips to target, whole-message floor join with oversized-newest protected alone) plus an executor that consumes Story 1's shared deleted-filtered zone SUM and writes the new position in its own short post-commit transaction with a position-forward guard. Wired it through the sanctioned intake→thread-view surface import: intake's pipeline registers `runPostCommitBoundaryAdvance` on ctx.onCommit FIRST (before the walk's enqueue pokes, so flush order is advance-then-poke), wrapped so a throwing advance is diagnosed to stderr and never eats the poke or reaches intake's caller. The advance runs in both host modes; budgets resolve through the per-instance seam (SdkViewConfig.visibility) with the 32000/24000/8000 defaults for direct domain calls. No host-called advance surface exists — the SDK ThreadViewSurface still carries only the five operations, and every test advance fires through a real intake commit. Boundary G1 trajectory golden committed with hand-derived positions ([0,0,9,9,27], zone sums [40,80,60,70,80] from exact-token 'tok'-word contents); it matched on first run, as did all 12 new boundary tests."
    changedFiles:
      -
        path: "packages/lhc/src/domains/thread-view/internal/boundary.ts"
        reason: "advanceDecision (pure), readZoneToolResults (same WHERE as visibilityZoneTokens so the advance/status sums cannot diverge), readCompactPoint, executeBoundaryAdvance (own short transaction, never-backward UPDATE guard)"
      -
        path: "packages/lhc/src/domains/thread-view/index.ts"
        reason: "runPostCommitBoundaryAdvance: fires the Story-0 injection point, resolves instance budgets via the seam (defaults below SDK), delegates to the executor; documented as seam-only, not a host operation"
      -
        path: "packages/lhc/src/domains/intake-stream/internal/pipeline.ts"
        reason: "the one registration: advance registered first on ctx.onCommit (pokes register later during the walk, so flush runs advance-then-poke), catch+stderr-diagnose wrapper, sanctioned thread-view surface import with the cycle note"
      -
        path: "packages/lhc/test/view-boundary.test.ts"
        reason: "TC-4.1 through TC-4.6, seam isolation both directions, both-host-modes proof, deleted-filter consistency leg, budget-validation legs (new file)"
      -
        path: "packages/lhc/test/view-select-golden.test.ts"
        reason: "sanctioned amendment: Boundary G1 trajectory golden case plus TC-4.5 replay-equality leg (second fresh thread, same script, same trajectory)"
      -
        path: "packages/lhc/test/goldens/boundary-g1-trajectory.json"
        reason: "committed trajectory golden: budgets 100/60/30, five scripted batches, hand-derived expected positions and zone sums including both floor legs (new file)"
      -
        path: "packages/lhc/test/goldens/README.md"
        reason: "golden table row for boundary-g1-trajectory.json"
      -
        path: "packages/lhc/test/red-manifest.json"
        reason: "recorded hashes for the new test file, the amended golden suite, and the new golden JSON"
    tests:
      added:
        - "test/view-boundary.test.ts (12 tests: TC-4.1, TC-4.2, TC-4.3 ×2 legs, TC-4.4, TC-4.5 ×2 validation legs, TC-4.6, poke-failure isolation, deleted-filter consistency, both-modes ×2)"
        - "test/goldens/boundary-g1-trajectory.json"
      modified:
        - "test/view-select-golden.test.ts (added Boundary G1 trajectory + replay-equality test)"
        - "test/goldens/README.md"
        - "test/red-manifest.json"
      removed:
[]
      totalAfterStory: 286
      deltaFromPriorBaseline: 13
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
        - "console.error in src/ violated the project lint rule (no console in src/; CLI output flows through render) — switched the advance-failure diagnostic to process.stderr.write"
        - "TC-4.2 originally reached the provider double through sdk.config.provider with a cast — restructured to hold the double directly at construction"
        - "DoD's deleted-filter consistency line had no direct test — added a leg that deletes a zone result and proves both the live status sum and the next advance decide over the filtered population"
      findingsSurfaced:
        - "The registration lives in src/domains/intake-stream/internal/pipeline.ts (where the operation context and commit hooks are built), not literally in src/domains/intake-stream/index.ts as the story's Implementation Targets table names; the tech design's requirement is that intake-stream registers it, which pipeline.ts is — index.ts is a thin delegation layer with no ctx in scope. Registration is placed before the event walk because enqueue registers pokes during the walk; registration order is flush order, which is what pins advance-first-poke-second."
        - "sdk.ts's `export * as threadView` re-exports the whole domain surface, so runPostCommitBoundaryAdvance is technically importable by a host (same as messages.createFromEvent and every other cross-domain surface function under the established pattern). The SDK's ThreadViewSurface and CLI expose only the five operations, satisfying the anti-shim rule's intent; no test calls it."
        - "A throwing fallback poke after a successful commit still turns intake's reported result into a storage_failure (pre-existing Epic 02 flush behavior, observable in the poke-isolation test which therefore asserts only the advance and the committed events). Not this story's scope; noting for the record."
        - "Compact reset can legally move the boundary backward to the compact point (new window per AC-4.6's 'within the same compact window' qualifier) — the never-backward UPDATE guard applies only to the advance's write path, matching the design."
    openQuestions:
[]
    specDeviations:
[]
    recommendedNextStep: "Proceed to verification, then Story 5 (render targets), which closes the named debt this story carries: the process-boundary CLI leg of the both-modes advance proof (spawned CLI intake on an over-max thread → flipped pulls, zone ≤ target) in cli-process-view.test.ts."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/003-implementor.json"
  startedAt: "2026-06-11T17:28:45.770Z"
  finishedAt: "2026-06-11T17:45:43.057Z"
```
</history_entry>

</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/story-lead/001-current.json
Bytes: 2245

```yaml
storyRunId: "04-tool-result-visibility-story-run-001"
storyId: "04-tool-result-visibility"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-verify completed with outcome pass and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/003-implementor.json"
    provenance: "current-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/004-verify.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "a19a2d2c-079f-4c8b-a6d9-08d7c8df8763"
    storyId: "04-tool-result-visibility"
  storyVerifier:
    provider: "codex"
    sessionId: "019eb7ca-5bdc-7001-8bde-225e63cfa400"
    storyId: "04-tool-result-visibility"
latestEventSequence: 8
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "Implementation reports ready-for-verification with green-verify and verify-all passing, but there is no verifier result yet. The smallest safe next action is an independent verification pass against the story requirements and implementor artifact."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/004-verify.json"
replayBoundary: null
updatedAt: "2026-06-11T17:48:58.652Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementor returns, check for required evidence: TC-4.1-4.6, seam isolation both directions, both host modes, G1 golden, status sum consistency, and green-verify output before deciding verify or quick-fix.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-11T17:28:45.733Z; note="After implementor returns, check for required evidence: TC-4.1-4.6, seam isolation both directions, both host modes, G1 golden, status sum consistency, and green-verify output before deciding verify or quick-fix."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/story-lead/001-events.jsonl
Bytes: 3588

```yaml
-
  storyRunId: "04-tool-result-visibility-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T17:28:34.992Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "04-tool-result-visibility-story-run-001"
  sequence: 2
  timestamp: "2026-06-11T17:28:45.713Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb7ba-863e-7233-a9f8-eaf2812f4408"
-
  storyRunId: "04-tool-result-visibility-story-run-001"
  sequence: 3
  timestamp: "2026-06-11T17:28:45.732Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementor returns, check for required evidence: TC-4.1-4.6, seam isolation both directions, both host modes, G1 golden, status sum consistency, and green-verify output before deciding verify or quick-fix."
-
  storyRunId: "04-tool-result-visibility-story-run-001"
  sequence: 4
  timestamp: "2026-06-11T17:28:45.733Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementor returns, check for required evidence: TC-4.1-4.6, seam isolation both directions, both host modes, G1 golden, status sum consistency, and green-verify output before deciding verify or quick-fix."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "04-tool-result-visibility-story-run-001"
  sequence: 5
  timestamp: "2026-06-11T17:45:43.066Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
    status: "ok"
-
  storyRunId: "04-tool-result-visibility-story-run-001"
  sequence: 6
  timestamp: "2026-06-11T17:45:52.628Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019eb7ca-3630-7b60-b165-46c24cd838de"
-
  storyRunId: "04-tool-result-visibility-story-run-001"
  sequence: 7
  timestamp: "2026-06-11T17:45:52.661Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 2
-
  storyRunId: "04-tool-result-visibility-story-run-001"
  sequence: 8
  timestamp: "2026-06-11T17:48:58.652Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome pass and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/04-tool-result-visibility/004-verify.json"
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
