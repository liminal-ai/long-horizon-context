# Story Lead Base Prompt

## Role Charter
You are the story lead for `03-readiness-sweep` on durable story run `03-readiness-sweep-story-run-001`.
Select exactly one bounded next action for this `resume` turn.
This is planner turn 5.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/stories/03-readiness-sweep.md
Bytes: 9979

# Story 3: Readiness Sweep

### Summary
<!-- Jira: Summary field -->
The sweep: walk derivation state through owning-domain reports, requeue transient failures through owning-domain requeue, return a receipt; standalone and embedded default-on in compact.

### Description
<!-- Jira: Description field -->

**User Profile (from epic):** the agentic harness (PI extension first), calling through the SDK on every model call; and the agent/operator running compacts and checking thread health through the CLI.

**Objective:** every compact leaves the thread healthier than it found it, and no failed form sits failed forever for lack of a remembered call.

**Scope in:**
- `sweep(ref)` per tech design §Flow 3: `messages.report` + `turns.report` → bucket (ready / pending→in-flight / blocked / failed) → classify failed by the reason-code table (transient / permanent / **unclassified ⇒ permanent**) → requeue transient through owners' `requeue` → `SweepReceipt`
- The reason-code classification table (tech design §Spec Validation row 1) as data, not branching logic
- Compact integration: sweep runs first by default, `sweep: false` skips, receipt embeds `SweepReceipt | { skipped: true }` — replaces Story 2's `absent`
- Once-per-invocation requeue dedupe (structural: owner requeue's `already_queued` noop counts as in-flight)

**Scope out:** any direct `work_item` or `derived_form` writes (owners' surfaces only — must-not-own matrix); any waiting on queued work; CLI command (Story 5's process suite carries the CLI parity leg; SDK surface lands here).

**Dependencies:** Stories 0–2. **Hard gate, verify before story start (extended per design):** (1) Epic 02's requeue patch landed — live-work-only queue rows, no terminal-row collision; (2) the terminal-failure write path verified against landed code — exhausted forms persist a classifiable reason class (FC-0.4 proved the fixture side; this gate proves the production side). If the persisted reason is opaque, the named Epic 02 patch is: stamp the provider's `retryable` flag onto the failed form at exhaustion.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-3.1**: The sweep reads derivation state exclusively through owning-domain report surfaces and requeues exclusively through owning-domain requeue surfaces. It performs no derivation, no model calls, and no direct writes to any derived form.
- **AC-3.2**: The sweep returns without waiting on any queued or requeued work.
- **AC-3.3**: Failed forms with transient-class reason codes are requeued; failed forms with non-transient reasons and blocked forms are reported and not requeued; pending/queued forms are left alone and reported as in-flight.
  - **TC-3.1** (AC-3.1, AC-3.2, AC-3.3): Seed a thread with ready, pending, transiently-failed, non-transiently-failed, and blocked forms (fixture-manufactured states); sweep → returns immediately; transient failure requeued (work row exists, form pending), non-transient and blocked untouched and reported, pending untouched; provider fake observes zero calls from the sweep itself.
- **AC-3.4**: A given form is requeued at most once per sweep invocation.
  - **TC-3.2** (AC-3.4): Sweep the same thread twice without draining → second sweep reports the requeued form as in-flight, does not requeue again; exactly one work row exists for it.
- **AC-3.5**: The receipt lists, by owner and kind: ready, in-flight, requeued, blocked, and non-transient-failed forms, with reasons for the failed and blocked.
- **AC-3.7**: The sweep is callable standalone through SDK and CLI with the same receipt shape.
  - **TC-3.3** (AC-3.5, AC-3.7): Standalone sweep via SDK and via spawned CLI → same receipt shape; counts and reasons match the seeded states. *(CLI leg executes in Story 5's process suite; the shared receipt schema assertion lands here.)*
- **AC-3.6**: Compact runs the sweep first by default; a skip option suppresses it; the receipt records whether the sweep ran.
  - **TC-3.4** (AC-3.6, AC-2.7): Compact with default options → receipt includes sweep section; compact with skip → receipt records the skip and no requeues occurred; drain after the default compact → requeued form heals; next compact's view includes the healed form. *(The drain leg exercises Epic 02 machinery through the provider fake — the one sanctioned test-setup use of inference machinery; no Epic 03 operation touches it.)*

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The sweep is thread-view's only *writing* interaction with other domains, and it writes nothing itself — every mutation goes through `messages.requeue`/`turns.requeue`. It is the repair half of the degrade-don't-block posture: compact degrades around missing material; the sweep is why the same material isn't missing at the *next* compact. This story also completes the compact receipt: Story 2's `absent` placeholder becomes `SweepReceipt | { skipped: true }`.

#### Build Strategy

Gate first — both legs verified and recorded in the story log before any code (requeue patch landed; reason-class persistence verified against landed Epic 02 code, with FC-0.4 as the fixture-side proof). Then the classification table as data with its own unit legs, then the walk/bucket/receipt as a pure function over report outputs, then the requeue calls, then the compact embed + skip flag. Red: `sweep` stub + compact receipt still `absent`.

#### Implementation Targets

| Target | Work |
|--------|------|
| `src/domains/thread-view/internal/sweep.ts` | report walk (both owners), bucket (ready / in-flight / blocked / failed×classify), transient requeue, receipt assembly |
| classification table (in `sweep.ts`, exported for tests) | reason-class → transient \| permanent; **unclassified ⇒ permanent**; single source, data not branching |
| `src/domains/thread-view/index.ts` | `sweep` real; `compact` gains the default-on sweep step + `sweep: false` skip; receipt flip |

#### Design References

| Topic | Where |
|-------|-------|
| Classification basis, unclassified default, gate trigger | tech-design.md L25 (Spec Validation row 1) |
| Flow: bucket rules, `already_queued` ⇒ in-flight, no waiting | tech-design.md L283 |
| `SweepReceipt` shape | tech-design.md L334–339 |
| Must-not-own (no direct `work_item`/`derived_form` touches) | tech-design.md L133 |
| Extended gate text | tech-design.md L383 |
| Epic 02 report/requeue surfaces (the consumed contract) | ../02-derivation-pipeline/tech-design.md L255 (report join + requeue semantics), L356–368 (signatures) |

#### Test Mapping

| TC | Test file | Asserts |
|----|-----------|---------|
| TC-3.1 | `test/view-sweep.test.ts` | five seeded states bucket correctly; only transient requeued (work row exists, form pending); returns without waiting (elapsed bound); zero provider calls from sweep itself |
| TC-3.2 | `view-sweep.test.ts` | second sweep without drain: in-flight report, no second row (count by key) |
| TC-3.3 (schema leg) | `view-sweep.test.ts` | SDK receipt validates against the shared receipt schema; counts/reasons match seeds (CLI execution leg → Story 5) |
| TC-3.4 | `view-sweep.test.ts` | default compact embeds receipt; skip records skip + zero requeues; drainSettled → next compact includes healed form |

#### Architecture-Risk Tests

Supplemental: **classification edges** in `view-sweep.test.ts` — unclassified code → reported `permanentFailed`, never requeued; blocked → never requeued (not a TC; pins the conservative default the classification table mandates).

Zero-provider assertion completes here across all five ops (the fake is in fixture scope all around the sweep — this assert is what keeps it out of the operation). Once-per-invocation dedupe is structural (owner noop) but asserted anyway — if Epic 02's requeue ever stops nooping, this is the test that notices.

#### Technical Notes

Buckets come from the *owners' report joins*, not raw form states: "retrying" is a report-level distinction (pending + queue detail), and the sweep must not re-derive it from `derived_form` reads. The receipt's `requeued` carries subject ids so TC-3.4 can follow specific forms through heal. The classification table starts minimal (the design's named classes); unknown codes landing in `permanentFailed` with their literal reason is the receipt's visibility mechanism — expanding the table is config-tier work later, not a redesign.

#### Anti-Shim Requirements

No waiting means *no waiting*: any `drainSettled`/polling inside `sweep.ts` is a contract violation even if tests pass — TC-3.1's elapsed-time bound is the tripwire. The gate is a stop condition, not a soft check: if FC-0.4's distinguishable-reason-classes proof fails against production writes, the story halts and the named Epic 02 patch (stamp `retryable` at exhaustion) is surfaced — do not classify on string-matching `lastError` prose as a workaround.

#### Production Path Proof

Sweep through `createSdk().threadView.sweep` and through `compact`'s embedded step; requeues drain through the real background scheduler (`drainSettled`) in TC-3.4's heal leg — the one sanctioned test-setup use of inference machinery, and it exercises Epic 02's production drain, not a shortcut.

#### Verification

`pnpm verify`; ~10 tests default suite. Gate verification recorded in the story log before first commit.

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] Gate verified and recorded in the story log before first commit (both legs: requeue patch, reason-class persistence)
- [ ] TC-3.1–3.4 green; unclassified-code leg green; zero-provider assertion now spans pull, status, compact, sweep
- [ ] Story 2's `absent` receipt replaced; Story 2's debt comment closed
- [ ] Classification table is data (single source), with the unclassified default tested
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
- planner_turn_index: 5
- mode: resume
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-orchestrate-resume
- current_child_operation: story-implement
- current_summary: Story orchestration resume requested and durable state has been reopened.
- latest_response_kind: verifier-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/003-verify.json
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 3
- latest_self_note: "After implementor result, run verifier continuation using storyVerifier with the implementation artifact; do not accept unless final verifier outcome is pass with no open findings and story gate evidence is present."

## Response Trail
<current_response>
```yaml
kind: verifier-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/003-verify.json
bytes: 8079
payload:
  command: "story-verify"
  version: 1
  status: "ok"
  outcome: "revise"
  result:
    resultId: "3796666f-1037-487a-b1ca-8619618534c8"
    role: "story_verifier"
    provider: "codex"
    model: "gpt-5.5"
    sessionId: "019eb786-e7ae-7d92-84c3-8daefeb333c6"
    continuation:
      provider: "codex"
      sessionId: "019eb786-e7ae-7d92-84c3-8daefeb333c6"
      storyId: "03-readiness-sweep"
    mode: "initial"
    story:
      id: "03-readiness-sweep"
      title: "Story 3: Readiness Sweep"
    artifactsRead:
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/stories/03-readiness-sweep.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/tech-design.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/test-plan.md"
      - "packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/team-impl-log.md"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/001-story-validate.json"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/002-story-orchestrate-run.json"
      - "packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/003-verify.json"
      - "packages/lhc/src/domains/thread-view/index.ts"
      - "packages/lhc/src/shared/view.ts"
      - "packages/lhc/src/cli/index.ts"
      - "packages/lhc/src/domains/messages/index.ts"
      - "packages/lhc/src/domains/turns/index.ts"
      - "packages/lhc/src/tech-utils/work-queue/index.ts"
      - "packages/lhc/src/sdk.ts"
      - "packages/lhc/test/view-pull.test.ts"
      - "packages/lhc/test/view-compact.test.ts"
      - "packages/lhc/test/view-fixture.test.ts"
      - "packages/lhc/package.json"
    reviewScopeSummary: "Initial verification for Story 3 read the story, Epic 03 tech design, test plan, Epic 02 report/requeue contract, current story artifacts/logs, and the relevant thread-view SDK, shared receipt, CLI, owner requeue, work-queue, and existing view tests. The codebase is still in Story 2 state for sweep: no sweep implementation file, SDK sweep returns not_implemented, compact records sweep as absent, and Story 3 tests are missing."
    priorFindingStatuses:
[]
    newFindings:
      -
        id: "SV-03-001"
        severity: "critical"
        title: "Sweep production path is still the Story 2 placeholder"
        evidence: "packages/lhc/src/domains/thread-view/index.ts lines 461-463 implement threadView.sweep by returning notImplemented(\"sweep\"). The compact path still documents the sweep step as absent at lines 274-278 and returns sweep: \"absent\" at lines 434-436. packages/lhc/src/shared/view.ts lines 122-126 still allow the Story 2 \"absent\" receipt literal instead of the Story 3 shape SweepReceipt | { skipped: true }. The internal thread-view directory contains no internal/sweep.ts implementation. This leaves AC-3.1 through AC-3.6 unmet in the real SDK path."
        affectedFiles:
          - "packages/lhc/src/domains/thread-view/index.ts"
          - "packages/lhc/src/shared/view.ts"
          - "packages/lhc/src/domains/thread-view/internal/sweep.ts"
        requirementIds:
          - "AC-3.1"
          - "AC-3.2"
          - "AC-3.3"
          - "AC-3.4"
          - "AC-3.5"
          - "AC-3.6"
          - "TC-3.1"
          - "TC-3.2"
          - "TC-3.4"
        recommendedFixScope: "same-session-implementor"
        blocking: true
      -
        id: "SV-03-002"
        severity: "major"
        title: "Required Story 3 test coverage is absent and existing tests assert old placeholder behavior"
        evidence: "packages/lhc/test/view-sweep.test.ts does not exist. Existing coverage still expects the placeholder behavior: packages/lhc/test/view-pull.test.ts lines 98-108 asserts sweep returns ok:false not_implemented, and packages/lhc/test/view-compact.test.ts lines 196-198 asserts compact receipt sweep is \"absent\". The configured gates passed, but they did not exercise TC-3.1 through TC-3.4 or the shared SweepReceipt schema leg for TC-3.3."
        affectedFiles:
          - "packages/lhc/test/view-sweep.test.ts"
          - "packages/lhc/test/view-pull.test.ts"
          - "packages/lhc/test/view-compact.test.ts"
        requirementIds:
          - "TC-3.1"
          - "TC-3.2"
          - "TC-3.3"
          - "TC-3.4"
          - "AC-3.5"
          - "AC-3.7"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    openFindings:
      -
        id: "SV-03-001"
        severity: "critical"
        title: "Sweep production path is still the Story 2 placeholder"
        evidence: "packages/lhc/src/domains/thread-view/index.ts lines 461-463 implement threadView.sweep by returning notImplemented(\"sweep\"). The compact path still documents the sweep step as absent at lines 274-278 and returns sweep: \"absent\" at lines 434-436. packages/lhc/src/shared/view.ts lines 122-126 still allow the Story 2 \"absent\" receipt literal instead of the Story 3 shape SweepReceipt | { skipped: true }. The internal thread-view directory contains no internal/sweep.ts implementation. This leaves AC-3.1 through AC-3.6 unmet in the real SDK path."
        affectedFiles:
          - "packages/lhc/src/domains/thread-view/index.ts"
          - "packages/lhc/src/shared/view.ts"
          - "packages/lhc/src/domains/thread-view/internal/sweep.ts"
        requirementIds:
          - "AC-3.1"
          - "AC-3.2"
          - "AC-3.3"
          - "AC-3.4"
          - "AC-3.5"
          - "AC-3.6"
          - "TC-3.1"
          - "TC-3.2"
          - "TC-3.4"
        recommendedFixScope: "same-session-implementor"
        blocking: true
      -
        id: "SV-03-002"
        severity: "major"
        title: "Required Story 3 test coverage is absent and existing tests assert old placeholder behavior"
        evidence: "packages/lhc/test/view-sweep.test.ts does not exist. Existing coverage still expects the placeholder behavior: packages/lhc/test/view-pull.test.ts lines 98-108 asserts sweep returns ok:false not_implemented, and packages/lhc/test/view-compact.test.ts lines 196-198 asserts compact receipt sweep is \"absent\". The configured gates passed, but they did not exercise TC-3.1 through TC-3.4 or the shared SweepReceipt schema leg for TC-3.3."
        affectedFiles:
          - "packages/lhc/test/view-sweep.test.ts"
          - "packages/lhc/test/view-pull.test.ts"
          - "packages/lhc/test/view-compact.test.ts"
        requirementIds:
          - "TC-3.1"
          - "TC-3.2"
          - "TC-3.3"
          - "TC-3.4"
          - "AC-3.5"
          - "AC-3.7"
        recommendedFixScope: "same-session-implementor"
        blocking: true
    requirementCoverage:
      verified:
        - "Story 3 hard gate evidence is present: messages.requeue and turns.requeue expose already_queued noops through owner surfaces, work-queue failAttempt/failTerminal persists final reason plus attempts metadata, FC-0.4 asserts rate_limit/content_refusal reason classes, and green-verify passed."
      unverified:
        - "AC-3.1, AC-3.2, AC-3.3, TC-3.1: no sweep report walk, classification, owner requeue behavior, no-wait behavior, or zero-provider sweep assertion exists because sweep is a stub."
        - "AC-3.4, TC-3.2: no once-per-invocation requeue dedupe implementation or test exists."
        - "AC-3.5, AC-3.7, TC-3.3 schema leg: no standalone SDK SweepReceipt can be produced; view-sweep.test.ts is absent."
        - "AC-3.6, TC-3.4: compact still returns sweep: \"absent\" and does not implement default-on sweep or sweep:false skip behavior."
    gatesRun:
      -
        command: "pnpm run green-verify"
        result: "pass"
      -
        command: "pnpm run verify-all"
        result: "pass"
    productionPathFindings:
      - "threadView.sweep is a runtime not_implemented placeholder in packages/lhc/src/domains/thread-view/index.ts lines 461-463."
      - "threadView.compact ignores the Story 3 sweep integration and returns the Story 2 placeholder sweep: \"absent\" in packages/lhc/src/domains/thread-view/index.ts lines 434-436."
      - "CompactReceipt still admits the obsolete \"absent\" literal in packages/lhc/src/shared/view.ts lines 122-126."
    recommendedNextStep: "revise"
    recommendedFixScope: "same-session-implementor"
    openQuestions:
[]
    additionalObservations:
      - "The Story 3 CLI execution leg is explicitly deferred to Story 5 by the story/test-plan text, so this review did not treat missing lhc view sweep process coverage as a separate Story 3 blocker."
      - "The epic gate currently passes because no Story 3 behavior tests are present; gate success is not readiness evidence for this story until the required coverage is added."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/003-verify.json"
  startedAt: "2026-06-11T16:32:12.051Z"
  finishedAt: "2026-06-11T16:34:58.864Z"
```
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/001-current.json
Bytes: 1911

```yaml
storyRunId: "03-readiness-sweep-story-run-001"
storyId: "03-readiness-sweep"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "Story orchestration resume requested and durable state has been reopened."
currentPhase: "story-orchestrate-resume"
currentChildOperation:
  command: "story-implement"
  artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/006-implementor.json"
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "verifier-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/003-verify.json"
    provenance: "current-run"
  -
    kind: "final-package"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/001-final-package.json"
    provenance: "current-run"
latestContinuationHandles:
  storyVerifier:
    provider: "codex"
    sessionId: "019eb786-e7ae-7d92-84c3-8daefeb333c6"
    storyId: "03-readiness-sweep"
latestEventSequence: 21
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "resume-attempt"
  summary: "Continue the existing durable story-lead attempt from its latest checkpoint."
replayBoundary: null
updatedAt: "2026-06-11T17:01:33.789Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: After implementor result, run verifier continuation using storyVerifier with the implementation artifact; do not accept unless final verifier outcome is pass with no open findings and story gate evidence is present.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-11T16:32:12.016Z; note="Await hard-gate verifier result before selecting implementation; Story 3 code must not start until both gate legs are recorded."
- sequence=8; actionSequence=7; createdAt=2026-06-11T16:35:09.030Z; note="After implementor result, run verifier continuation against the implementation artifact; do not accept unless final verifier outcome is pass with no open findings and story gate evidence is present."
- sequence=14; actionSequence=13; createdAt=2026-06-11T16:52:21.727Z; note="After implementor result, run verifier continuation using storyVerifier with the implementation artifact; do not accept unless final verifier outcome is pass with no open findings and story gate evidence is present."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/001-events.jsonl
Bytes: 12351

```yaml
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T16:31:56.564Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 2
  timestamp: "2026-06-11T16:32:11.995Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb786-ab16-7780-bcb2-571ebbb30576"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 3
  timestamp: "2026-06-11T16:32:12.015Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-verify."
  data:
    actionType: "run-verify"
    turn: 1
    selfNote: "Await hard-gate verifier result before selecting implementation; Story 3 code must not start until both gate legs are recorded."
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 4
  timestamp: "2026-06-11T16:32:12.016Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "Await hard-gate verifier result before selecting implementation; Story 3 code must not start until both gate legs are recorded."
    actionSequence: 3
    actionType: "run-verify"
    turn: 1
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 5
  timestamp: "2026-06-11T16:34:58.875Z"
  type: "child-operation-completed"
  summary: "story-verify completed with outcome revise and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/003-verify.json"
  data:
    actionType: "run-verify"
    command: "story-verify"
    outcome: "revise"
    status: "ok"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 6
  timestamp: "2026-06-11T16:35:09.009Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/prompts/001-planner-turn-002.md"
    sessionId: "019eb789-735f-7101-b913-3b22885de9c7"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 7
  timestamp: "2026-06-11T16:35:09.030Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 2
    selfNote: "After implementor result, run verifier continuation against the implementation artifact; do not accept unless final verifier outcome is pass with no open findings and story gate evidence is present."
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 8
  timestamp: "2026-06-11T16:35:09.030Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementor result, run verifier continuation against the implementation artifact; do not accept unless final verifier outcome is pass with no open findings and story gate evidence is present."
    actionSequence: 7
    actionType: "run-implement"
    turn: 2
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 9
  timestamp: "2026-06-11T16:50:20.338Z"
  type: "child-process-stopped"
  summary: "Stopped stale story-implement provider process 21179 after interruption handling."
  data:
    storyId: "03-readiness-sweep"
    storyRunId: "03-readiness-sweep-story-run-001"
    command: "story-implement"
    artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/004-implementor.json"
    statusArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/progress/004-implementor.status.json"
    cleanedUpAt: "2026-06-11T16:50:20.338Z"
    provider: "claude-code"
    pid: 21179
    streamPaths:
      stdoutPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/streams/004-implementor.stdout.log"
      stderrPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/streams/004-implementor.stderr.log"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 10
  timestamp: "2026-06-11T16:50:20.351Z"
  type: "child-operation-failed"
  summary: "story-implement returned a failed runtime envelope before producing a recoverable child result."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-current-attempt"
      reasoning: "The attempt was interrupted and recorded a terminal recovery package, so the safest replay point is the current durable story-run snapshot."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/001-story-validate.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/003-verify.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: false
    command: "story-implement"
    outcome: "blocked"
    status: "blocked"
    errors:
      -
        code: "PROVIDER_UNAVAILABLE"
        message: "Provider execution failed for claude-code."
    artifactPaths:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/004-implementor.json"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 11
  timestamp: "2026-06-11T16:52:05.911Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 12
  timestamp: "2026-06-11T16:52:21.705Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/prompts/001-planner-turn-003.md"
    sessionId: "019eb799-1f1f-76f1-ad34-456c0fffeb82"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 13
  timestamp: "2026-06-11T16:52:21.726Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "After implementor result, run verifier continuation using storyVerifier with the implementation artifact; do not accept unless final verifier outcome is pass with no open findings and story gate evidence is present."
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 14
  timestamp: "2026-06-11T16:52:21.727Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "After implementor result, run verifier continuation using storyVerifier with the implementation artifact; do not accept unless final verifier outcome is pass with no open findings and story gate evidence is present."
    actionSequence: 13
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 15
  timestamp: "2026-06-11T16:55:50.423Z"
  type: "child-process-stopped"
  summary: "Stopped stale story-implement provider process 43016 after interruption handling."
  data:
    storyId: "03-readiness-sweep"
    storyRunId: "03-readiness-sweep-story-run-001"
    command: "story-implement"
    artifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/006-implementor.json"
    statusArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/progress/006-implementor.status.json"
    cleanedUpAt: "2026-06-11T16:55:50.423Z"
    provider: "claude-code"
    pid: 43016
    streamPaths:
      stdoutPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/streams/006-implementor.stdout.log"
      stderrPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/streams/006-implementor.stderr.log"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 16
  timestamp: "2026-06-11T16:55:50.433Z"
  type: "child-operation-failed"
  summary: "story-implement returned a failed runtime envelope before producing a recoverable child result."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/001-final-package.json"
  data:
    terminalDecision: "interrupted"
    recoveryBoundary:
      smallestSafeStep: "resume-current-attempt"
      reasoning: "The attempt was interrupted and recorded a terminal recovery package, so the safest replay point is the current durable story-run snapshot."
      validArtifactPaths:
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/001-story-validate.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/003-verify.json"
        - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/001-final-package.json"
      requiresFreshStoryLeadSession: false
      requiresFreshChildProviderSession: false
    command: "story-implement"
    outcome: "blocked"
    status: "blocked"
    errors:
      -
        code: "PROVIDER_UNAVAILABLE"
        message: "Provider execution failed for claude-code."
    artifactPaths:
      - "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/006-implementor.json"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 17
  timestamp: "2026-06-11T17:00:31.495Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 18
  timestamp: "2026-06-11T17:00:48.120Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/prompts/001-planner-turn-004.md"
    sessionId: "019eb7a0-d747-7822-899c-14d611d5f03a"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 19
  timestamp: "2026-06-11T17:00:48.142Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected block-story."
  data:
    actionType: "block-story"
    turn: 1
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 20
  timestamp: "2026-06-11T17:00:48.175Z"
  type: "blocked"
  summary: "Story-lead finalized 03-readiness-sweep-story-run-001 with outcome blocked."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/03-readiness-sweep/story-lead/001-final-package.json"
  data:
    terminalDecision: "block"
-
  storyRunId: "03-readiness-sweep-story-run-001"
  sequence: 21
  timestamp: "2026-06-11T17:01:33.788Z"
  type: "story-run-resumed"
  summary: "Story orchestration resume started."
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
