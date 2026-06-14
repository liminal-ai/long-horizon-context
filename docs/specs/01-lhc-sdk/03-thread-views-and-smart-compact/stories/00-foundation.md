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
