# Story Lead Base Prompt

## Role Charter
You are the story lead for `00-foundation` on durable story run `00-foundation-story-run-001`.
Select exactly one bounded next action for this `run` turn.
This is planner turn 2.
Do not invent tools, bypass the bounded action protocol, or rely on hidden provider session memory.

## Authority Boundary
Impl-lead stays outside this loop and owns final story acceptance, receipts, commits, cleanup dispatch, and epic progression.
You may recommend acceptance, request a ruling, or block the story, but you do not accept the story on behalf of impl-lead.

## Requirements Source
Treat the story file and test plan below as the story-local requirements source for this turn.
Do not pull in epic, tech design, git status, git diff, or workspace summaries unless they are already present in the durable record below.

### Story Requirements
### story-file
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/stories/00-foundation.md
Bytes: 9271

# Story 0: Foundation

### Summary
<!-- Jira: Summary field -->
Migration v6 (view, band, boundary tables), profile config parsing and validation, the advance-seam injection point, and the derived-thread fixture every later story compacts against.

### Description
<!-- Jira: Description field -->

**User Profile (from epic):** the agentic harness (PI extension first), calling through the SDK on every model call; and the agent/operator running compacts and checking thread health through the CLI.

**Objective:** establish the storage, config, and test substrate for the thread-view domain so Stories 1–5 build operations, not plumbing.

**Scope in:**
- Migration v6: `thread_view` (singleton row, CHECK-enforced), `thread_view_band`, `view_boundary` (singleton, seeded to position 0) — per tech design §Storage
- Profile config: built-ins (`continuation`, `conversation`, `coding`), user profiles merged by name, band-sum and budget validation (`max > target ≥ floor`) with caller errors naming the violation
- The test injection facility — one mechanism, two named points: the post-commit advance (TC-4.6's failure injection) and compact's write path between sweep and view write (TC-2.4's crash injection); production code carries the points as no-ops unless a test installs a hook
- The derived-thread fixture: a recorded conversation (~12 turns, 4 chunks, tool-heavy middle) drained through real Epic 02 machinery into known form states — ready, failed-transient, failed-permanent, blocked — plus a canonical-corruption variant (Epic 01 fixture pattern) and a turnless-straggler variant (selection rule 6 / golden G4)
- Sanctioned below-SDK fixture helpers in `test/fixtures/` (boundary-row seeding for TC-1.4; same sanctioning as the corruption fixture)

**Scope out:** any thread-view operation; any rendering.

**Dependencies:** Epic 02 schema (v5) as the migration baseline.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

Foundation criteria (owns no epic ACs):

- **FC-0.1**: Migration v6 applies cleanly to an Epic-02 thread file; all three tables exist with their CHECK constraints; `view_boundary` is seeded with position 0; re-applying is a no-op.
- **FC-0.2**: Invalid profile configs are rejected at SDK construction with errors naming the violation (band sum ≠ 100, `max ≤ target`, `target < floor`, non-positive lower bound, unknown built-in override target).
- **FC-0.3**: Each fixture state (ready, failed-transient, failed-permanent, blocked) is proven by read-back through the owning domain's report surface before any downstream story consumes it; states are reached through production drains against the deterministic provider, never hand-written rows.
- **FC-0.4**: The fixture's failed-transient and failed-permanent forms carry distinguishable reason classes on read-back (the Story 3 classification dependency, proven here).
- **FC-0.5**: The corruption-variant fixture refuses canonical reads with `state_corruption`; the turnless-straggler variant carries a `turnId = null` message between two turns and one after the last turn.
- **FC-0.6**: The injection facility exists with both named points — post-commit advance and compact write path — reachable from tests without touching production code paths; uninstalled, both points are no-ops.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Thread-view is a consumer at the top of the existing stack: it reads the record and Epic 02's derived forms, owns three new tables in the same thread file, and derives nothing. This story builds the substrate — storage, config, injection facility, fixture — so Stories 1–5 build operations. Nothing here is reachable from the SDK surface yet.

#### Build Strategy

Migration first (it gates everything), then profiles (pure functions, no IO), then the injection facility, then the fixture — the fixture is the long pole and consumes everything before it (it drains real Epic 02 work against the deterministic provider and must read states back through `messages.report`/`turns.report`). Red phase: FC checks written against the unmigrated/unconfigured package fail on missing tables and missing exports, not on import errors.

#### Implementation Targets

| Target | Work |
|--------|------|
| `src/shared/migrations.ts` (existing chain) | v6: `thread_view`, `thread_view_band`, `view_boundary` + seed boundary row at position 0 |
| `src/domains/thread-view/internal/profiles.ts` | built-ins (`continuation` 120k/30/30/20/20, `conversation` 120k/12/48/20/20, `coding` 120k/25/35/20/20), merge-by-name, validation errors naming violations |
| `src/shared/view.ts` | the vocabulary types (`ViewProfile`, `VisibilityBudgets`, `SdkViewConfig`, receipts — copy-paste from design §Interface Definitions) |
| `src/sdk.ts` | `SdkConfig.view` accepted + validated at construction (throws on nonsense, Epic 02 rule); defaults 32000/24000/8000, threshold 160000 |
| test injection facility | two named points: post-commit advance, compact write path; no-op unless a test installs a hook; lives with the seam utilities, pattern from Epic 02's crash-injection seam |
| `test/fixtures/` | derived-thread fixture builder + boundary-seed helper (sanctioned below-SDK, marker comment) + corruption variant + turnless-straggler variant |

#### Design References

| Topic | Where |
|-------|-------|
| Storage DDL, singleton CHECKs, seeding, provenance rationale | tech-design.md L135–168 |
| Profile/budget shapes and defaults | tech-design.md L302–307 (`ViewProfile`, `VisibilityBudgets`), L354–364 (`SdkViewConfig`, built-ins) |
| Boundary-rules addition + sanctioned cycle (check-boundaries) | tech-design.md L115 |
| Fixture composition, production-path state manufacture | tech-design.md L366–372; test-plan.md L5–16 |
| Turnless-straggler variant purpose (G4) | tech-design.md L183; test-plan.md L72 |

#### Test Mapping

| Check | Test file | Asserts |
|-------|-----------|---------|
| FC-0.1 | `test/view-fixture.test.ts` + `thread-migration.test.ts` | v6 applies to an Epic-02 file; tables + CHECKs exist; boundary seeded 0; re-apply no-op |
| FC-0.2 | `view-fixture.test.ts` | each invalid config rejected at construction with the named violation (sum≠100, max≤target, target<floor, bound≤0, unknown override) |
| FC-0.3 | `view-fixture.test.ts` | each state (ready/failed-transient/failed-permanent/blocked) read back through the owning report surface |
| FC-0.4 | `view-fixture.test.ts` | transient vs permanent forms carry distinguishable reason classes on read-back |
| FC-0.5 | `view-fixture.test.ts` | corruption variant refuses canonical reads with `state_corruption`; straggler variant has `turnId=null` between turns and trailing |
| FC-0.6 | `view-fixture.test.ts` | both injection points reachable from tests; uninstalled ⇒ no-ops |

#### Architecture-Risk Tests

None owned; this story *creates* the fixture-fidelity guarantee every later architecture-risk test stands on (states via production drains, never hand-written rows — FC-0.3 is the enforcement).

#### Technical Notes

The fixture conversation shape is pinned in the design (~12 turns, 4 chunks, tool-heavy middle): the tool-heavy middle is what gives Story 4 a realistic over-max zone, and the 4 chunks give Story 2's coverage edge something to exclude. Scripted provider failures manufacture the failed states (retryable-fail-exhaust for transient; non-retryable for permanent); blocked comes from source damage on a sacrificial sibling fixture, not the main one. FC-0.4 is the Story 3 gate's fixture-side proof — if it can't pass because Epic 02's persisted reason is opaque, stop and surface it immediately; that's the named Epic 02 patch trigger, not something to work around.

#### Anti-Shim Requirements

Fixture states must be reached through real `intake → drain` paths against the deterministic provider. Hand-writing `derived_form` rows to fake a state is the exact fiction FC-0.3 exists to prevent — a hand-written row can encode a state shape the production writer never produces, and every downstream test would then prove compatibility with fiction. The boundary-seed helper is the one sanctioned below-SDK write, and only because boundary *mechanics* are Story 4's to prove.

#### Production Path Proof

Migration runs through the real chain (`thread-migration.test.ts` extension, same as v1–v5). Profile validation runs through real `createSdk` construction, not a standalone validator call.

#### Verification

`pnpm verify` (lint + typecheck + default suites). New tests land in the default suite; no process-suite involvement this story.

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] FC-0.1–FC-0.6 green in `test/view-fixture.test.ts` (~6 checks)
- [ ] Migration registered in the chain after v5; `thread-migration.test.ts` extended for v6
- [ ] check-boundaries script gains thread-view's allowed-import lines and intake-stream's thread-view-surface line with the sanctioned-cycle annotation (tech design §Module Boundaries)
- [ ] Fixture helpers live in `test/fixtures/` with the sanctioned below-SDK marker comment
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
- planner_turn_index: 2
- mode: run
- current_status: running
- lifecycle_state: awaiting_story_lead_action
- current_phase: story-lead-awaiting-action
- current_child_operation: none
- current_summary: story-implement completed with outcome ready-for-verification and status ok.
- latest_response_kind: implementor-result
- latest_response_path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/003-implementor.json
- older_response_count: 0
- caller_input_artifact_count: 0
- prior_self_note_count: 1
- latest_self_note: "First child operation should establish implementation evidence and story-gate status before any self-review or acceptance decision."

## Response Trail
<current_response>
```yaml
kind: implementor-result
path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/003-implementor.json
bytes: 8328
payload:
  command: "story-implement"
  version: 1
  status: "ok"
  outcome: "ready-for-verification"
  result:
    resultId: "276f44cd-7871-4fa9-affb-941f88fdfa11"
    provider: "claude-code"
    model: "claude-fable-5"
    role: "story_implementor"
    sessionId: "9b79ae20-893f-4407-8201-b760b8487b13"
    continuation:
      provider: "claude-code"
      sessionId: "9b79ae20-893f-4407-8201-b760b8487b13"
      storyId: "00-foundation"
    outcome: "ready-for-verification"
    story:
      id: "00-foundation"
      title: "Story 0: Foundation"
    planSummary: "Built Story 0's substrate in build-strategy order: (1) migration v6 (thread_view, thread_view_band, view_boundary with singleton CHECKs, boundary seeded at position 0) as MIGRATION_V6_STATEMENTS in shared/storage.ts, registered after v5 in the thread migration chain; (2) view vocabulary types in src/shared/view.ts copied from tech-design §Interface Definitions; (3) profile config in thread-view/internal/profiles.ts — built-ins (continuation/conversation/coding at 120k), merge-by-name with field-wise built-in overrides, validation throwing at createSdk construction naming each violation (sum≠100, max≤target, target<floor, bound≤0, unknown built-in override target), defaults 32000/24000/8000 and threshold 160000 on ResolvedSdkConfig.view; (4) the two-point injection facility (post-commit-advance, compact-write) in thread-view/internal/seam.ts on Epic 02's walk-hook pattern, re-exported through test/fixtures/view-seam.ts alongside the sanctioned boundary-seed helper; (5) the derived-thread fixture (12 turns, 4 chunks via pinned chunk policy 90/4400, tool-heavy middle turns 5–8) drained per-turn through real intake→enqueue→drain machinery against the provider double — failed-transient via scripted retryable-exhaust (rate_limit class, attempts 3), failed-permanent via scripted non-retryable (content_refusal class, attempts 1), blocked via real two-open-turns damage on a sacrificial sibling, plus corruption and turnless-straggler variants; (6) check-boundaries gains rule 3, a pinned domain-surface edge set including thread-view's allowed imports and intake-stream→thread-view with the sanctioned-cycle annotation."
    changedFiles:
      -
        path: "src/shared/storage.ts"
        reason: "MIGRATION_V6_STATEMENTS: the three view tables with CHECK constraints and the position-0 boundary seed"
      -
        path: "src/domains/threads/internal/create.ts"
        reason: "Register migration v6 in the thread-file migration chain after v5"
      -
        path: "src/shared/view.ts"
        reason: "New: Epic 03 view vocabulary (ViewProfile, VisibilityBudgets, SdkViewConfig, ResolvedViewConfig, pull/status/receipt shapes) per tech-design §Interface Definitions"
      -
        path: "src/shared/derivation.ts"
        reason: "SdkConfig gains view?: SdkViewConfig; ResolvedSdkConfig gains resolved view config"
      -
        path: "src/domains/thread-view/internal/profiles.ts"
        reason: "New: built-in profiles, merge-by-name resolution, band-sum/budget/threshold validation throwing with named violations"
      -
        path: "src/domains/thread-view/internal/seam.ts"
        reason: "New: two-named-point injection facility (post-commit-advance, compact-write), no-op unless a test installs a hook"
      -
        path: "src/domains/thread-view/index.ts"
        reason: "New: thread-view surface exporting config resolution (operations arrive Stories 1–5)"
      -
        path: "src/sdk.ts"
        reason: "createSdk validates config.view via resolveViewConfig at construction (throws per Epic 02 rule); exports view types and built-ins"
      -
        path: "scripts/check-boundaries.mjs"
        reason: "Rule 3: pinned domain-surface edge allowlist with thread-view's edges and intake-stream→thread-view under the sanctioned-cycle annotation"
      -
        path: "test/fixtures/legacy.ts"
        reason: "legacyEpic02ThreadFile: real v5-shape file (Epic 01 layout + production v5 statements) for the v6 upgrade test"
      -
        path: "test/fixtures/view-thread.ts"
        reason: "New: derived-thread fixture builder (12 turns, 4 chunks, tool-heavy middle) with production-drain failure manufacture, plus straggler, corruption, and blocked-sibling variants"
      -
        path: "test/fixtures/view-seam.ts"
        reason: "New: fixtures re-export of the injection seam plus the sanctioned below-SDK view_boundary seed helper (TC-1.4)"
      -
        path: "test/fixtures/index.ts"
        reason: "Export the new view fixtures and legacyEpic02ThreadFile"
      -
        path: "test/view-fixture.test.ts"
        reason: "New: FC-0.1–FC-0.6 foundation checks"
      -
        path: "test/thread-migration.test.ts"
        reason: "Extended for v6: migration over a populated Epic 02 file, CHECKs, boundary seed, re-apply no-op; existing version assertions moved 5→6"
      -
        path: "test/red-manifest.json"
        reason: "Re-recorded thread-migration.test.ts hash and recorded view-fixture.test.ts"
    tests:
      added:
        - "test/view-fixture.test.ts (14 tests: FC-0.1 storage/CHECKs/seed, FC-0.2 five rejection legs + defaults/merge, FC-0.3 ready/failed×2/blocked read-back via report surfaces, FC-0.4 reason-class distinguishability, FC-0.5 corruption refusal + straggler positions, FC-0.6 injection points)"
        - "test/thread-migration.test.ts: 'FC-0.1 (Epic 03): migration v6 over a populated Epic 02 thread file'"
      modified:
        - "test/thread-migration.test.ts (three schema-version assertions updated 5→6 — the lazy open now lands at v6)"
      removed:
[]
      totalAfterStory: 255
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
        - "exactOptionalPropertyTypes violations in the fixture builder (string|undefined assigned to optional ids) — replaced with guarded assignments that throw on a missing projection"
        - "messages.report called with options merged into ThreadRef — corrected to the two-argument surface signature"
        - "thread_view_band CHECK asserted via DDL text instead of a violating insert, since FK enforcement order would make the behavioral assertion ambiguous; the two singleton CHECKs are asserted behaviorally (failed inserts, nothing mutated)"
      findingsSurfaced:
        - "The injection facility exists with both named points reachable from tests and proven no-op/installed/throw/uninstall, but the production call sites cannot exist until the advance (Story 4) and compact (Story 2) land — those stories must wire fireViewInjection at the pinned points; flagged so the wiring is not forgotten"
        - "FC-0.4 confirmation for the Story 3 gate: Epic 02's failTerminal already persists the final provider failure's reason verbatim plus metadata.attempts/lastError, so transient (rate_limit:…, attempts 3) and permanent (content_refusal:…, attempts 1) forms are distinguishable by reason class on read-back — no Epic 02 patch trigger fired"
        - "FIXTURE_CHUNK_POLICY is pinned (90/4400) against the deterministic provider's near-constant projection sizes (26–31 tokens/turn, 3-turn chunk sums 80–87); the builder throws a named re-pin error if the substrate ever drifts, so drift surfaces as a fixture invariant failure, not a downstream mystery"
    openQuestions:
[]
    specDeviations:
      - "SdkViewConfig.profiles is typed ViewProfileOverride[] (name + optional lowerBound/partial percentages) rather than the design sketch's ViewProfile[]: a complete ViewProfile remains assignable, and the widening is what makes FC-0.2's 'unknown built-in override target' violation expressible — a partial entry merges field-wise over the built-in it names, and a partial entry naming no built-in is rejected at construction"
      - "view_boundary's migration seed stamps updated_at with SQLite strftime at migration time (migration statements are static SQL); deterministic-clock concerns do not apply to the one-time seed, and the production advance/reset writers (Stories 2/4) use the injected clock"
    recommendedNextStep: "Proceed to Story 1 (pull + status): the migration, config, fixture, and injection substrate are in place; Story 1 should consume derivedThreadFixture for tail-only pulls and add the thread-view surface stubs as structured not-implemented results per the design's stub contract."
  errors:
[]
  warnings:
[]
  artifacts:
    -
      kind: "result-envelope"
      path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/003-implementor.json"
  startedAt: "2026-06-11T14:02:00.783Z"
  finishedAt: "2026-06-11T14:25:17.592Z"
```
</current_response>

<history_responses>
No older response entries are recorded yet.
</history_responses>

## Current Snapshot
### current-snapshot
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/story-lead/001-current.json
Bytes: 1811

```yaml
storyRunId: "00-foundation-story-run-001"
storyId: "00-foundation"
attempt: 1
status: "running"
lifecycleState: "awaiting_story_lead_action"
currentSummary: "story-implement completed with outcome ready-for-verification and status ok."
currentPhase: "story-lead-awaiting-action"
currentChildOperation: null
latestArtifacts:
  -
    kind: "validation-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/001-story-validate.json"
    provenance: "prior-run"
  -
    kind: "implementor-result"
    path: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/003-implementor.json"
    provenance: "current-run"
latestContinuationHandles:
  storyImplementor:
    provider: "claude-code"
    sessionId: "9b79ae20-893f-4407-8201-b760b8487b13"
    storyId: "00-foundation"
latestEventSequence: 5
callerInputHistory:
  reviewRequests:
[]
  rulings:
[]
nextIntent:
  actionType: "await-story-lead-action"
  summary: "No bounded child response exists yet, and the durable snapshot indicates the next intent is to orient from the existing validation artifact before doing story work. The smallest safe action is to start implementation against the story-local requirements and current durable artifact."
  artifactRef: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/003-implementor.json"
replayBoundary: null
updatedAt: "2026-06-11T14:25:17.600Z"
```

## Caller Input Artifacts
None.

## Prior Self Notes
Latest note highlight: First child operation should establish implementation evidence and story-gate status before any self-review or acceptance decision.

All prior runtime self-notes:
- sequence=4; actionSequence=3; createdAt=2026-06-11T14:02:00.746Z; note="First child operation should establish implementation evidence and story-gate status before any self-review or acceptance decision."

## Event History
### event-history
Path: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/story-lead/001-events.jsonl
Bytes: 2059

```yaml
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 1
  timestamp: "2026-06-11T14:00:55.983Z"
  type: "story-run-started"
  summary: "Story orchestration run started after orienting from 1 existing artifact(s)."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 2
  timestamp: "2026-06-11T14:02:00.711Z"
  type: "story-lead-provider-started"
  summary: "Fresh story-lead provider turn executed without planner session resume."
  data:
    provider: "codex"
    model: "gpt-5.5"
    reasoningEffort: "high"
    promptArtifactPath: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/story-lead/prompts/001-planner-turn-001.md"
    sessionId: "019eb6fc-6ea0-7bb3-8d65-2983e7c175ab"
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 3
  timestamp: "2026-06-11T14:02:00.745Z"
  type: "story-lead-action-selected"
  summary: "Story-lead selected run-implement."
  data:
    actionType: "run-implement"
    turn: 1
    selfNote: "First child operation should establish implementation evidence and story-gate status before any self-review or acceptance decision."
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 4
  timestamp: "2026-06-11T14:02:00.746Z"
  type: "story-lead-self-note-recorded"
  summary: "Story-lead recorded a durable self-note for a future planner turn."
  data:
    note: "First child operation should establish implementation evidence and story-gate status before any self-review or acceptance decision."
    actionSequence: 3
    actionType: "run-implement"
    turn: 1
-
  storyRunId: "00-foundation-story-run-001"
  sequence: 5
  timestamp: "2026-06-11T14:25:17.600Z"
  type: "child-operation-completed"
  summary: "story-implement completed with outcome ready-for-verification and status ok."
  artifact: "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/03-thread-views-and-smart-compact/artifacts/00-foundation/003-implementor.json"
  data:
    actionType: "run-implement"
    command: "story-implement"
    outcome: "ready-for-verification"
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
