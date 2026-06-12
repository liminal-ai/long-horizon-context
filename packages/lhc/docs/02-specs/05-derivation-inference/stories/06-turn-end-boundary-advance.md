# Story 6: Turn-End Boundary Advance

### Summary
<!-- Jira: Summary field -->

Patch the Epic 03 visibility boundary to advance only at turn close, evict whole turns, and retire floor-token config.

### Description
<!-- Jira: Description field -->

**User Profile:** The operator needs stable reads during an open turn and predictable boundary movement after the turn closes.

**Objective:** Move boundary advance from after every intake commit to turn close while preserving Epic 03's remaining visibility contracts.

**Scope In:** Turn-end trigger gate, whole-turn eviction, peek-ahead stop, newest-closed-turn protection, two-field visibility config, Epic 03 test amendment ledger, and red-manifest regeneration.

**Scope Out:** Mid-turn safety ceiling and any inference behavior.

**Dependencies:** Independent of Stories 2-5. Uses POC commits `1cf2dc45`, `6a9aa7a4`, and `f12a850d` as reference implementation.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-5.1**: The advance check runs only when an intake batch commits a `turn_end`. Mid-turn batches never move the boundary regardless of zone size, and rendered bytes do not change between turn closes.
- **AC-5.2**: Eviction is whole-turn, oldest-first: an advance flips every tool result in each evicted turn together; no turn is ever partially flipped.
- **AC-5.3**: The peek-ahead stop: a turn is evicted only if the zone's sum after evicting it remains ≥ target. The advance lands in [target, target + one turn). The newest closed turn is never evicted.
- **AC-5.4**: Config is max and target with defaults 64k/32k; max > target validated with a caller error; the floor token budget is retired from the config surface.
- **AC-5.5**: All other Epic 03 boundary contracts hold under the new trigger: forward-only, summary-else-truncation short form, compact reset, deterministic replay, post-commit seam with non-blocking failure visible in status.

**Test Conditions**

- **TC-5.1** (AC-5.1, AC-5.2): `view-boundary-turn-end.test.ts`
  - mid-turn batches accumulate tool results past max; boundary remains unmoved
  - consecutive pulls during the open turn are byte-identical
  - the batch closing the turn commits; exactly one advance runs
  - flipped set is whole oldest turns, with every tool result in each evicted turn flipped together
  - no turn is partially flipped
  - a small next turn closes under max and causes no movement
  - turnless tool result evicts as a singleton group
- **TC-5.2** (AC-5.3, AC-5.4): `view-boundary-turn-end.test.ts`
  - golden G2: 30k/25k/20k/15k turns with 64k/32k budgets advances boundary after the 25k group and lands zone at 35k
  - landing always falls in [target, target + one turn)
  - exact-target variant advances through a turn when remaining sum is exactly target
  - newest closed turn remains intact even when it alone exceeds target
  - `maxTokens <= targetTokens` returns a caller `TypeError` naming the constraint
  - defaults resolve to 64k/32k
- **TC-5.3** (AC-5.5): amended `view-boundary.test.ts` plus new turn-end file
  - flipped results stay flipped across later turn closes
  - short form remains summary-when-ready else truncation
  - compact resets boundary to the compact point with a fresh full tail
  - same record plus same budgets replays to identical boundary trajectory
  - injected `post-commit-advance` failure leaves intake unaffected, boundary unchanged, and status showing over-budget zone
  - the next turn close heals the failed advance

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story patches Epic 03's visibility-boundary contract. The advance registration stays on the existing post-commit seam but is gated to batches that commit a `turn_end`; the decision function changes from message-grained eviction plus floor config to whole-turn groups plus peek-ahead target landing.

The storage shape does not migrate. `view_boundary` remains the stored boundary; `VisibilityBudgets` loses `floorTokens`, and the newest closed turn plus open-turn trigger rule replaces the old floor behavior.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- This changes a persisted read boundary, replay determinism, config validation, and an existing Epic 03 test surface.
- The amendment ledger must be applied precisely so superseded tests are rewritten, not discarded.

Risk Reminders:
- Keep post-commit ordering and throw isolation unchanged.
- Use whole-turn grouping by `turn_id`; turnless results become singleton groups.
- Regenerate the red-manifest artifact after ledger amendments.

#### Implementation Targets

| Area | Files / Modules |
|---|---|
| Intake post-commit gate | `src/domains/intake-stream/internal/pipeline.ts` |
| Boundary decision | `src/domains/thread-view/internal/boundary.ts` |
| Visibility config | `src/shared/view.ts`, config resolution code |
| Boundary fixtures | `test/fixtures/` boundary helpers including `seedTurnedToolResults(...)` |
| Story-owned tests | `test/view-boundary-turn-end.test.ts`, amended `test/view-boundary.test.ts` |
| Red-manifest artifact | project red-manifest artifact used by the house Red/Green flow |

#### Design References

- [epic.md §Flow 5](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:151), lines 151-171
- [epic.md §Data Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:238), line 238
- [tech-design.md §Design Decisions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:28), lines 28-30
- [tech-design.md §Top-Tier Surfaces](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:41), lines 41-42
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:95), lines 95-97
- [tech-design.md §Flow 5](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:175), lines 175-197
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:272), lines 272-275
- [test-plan.md §Boundary fixtures](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:38), line 38
- [test-plan.md §TC-5.1 / TC-5.2 / TC-5.3](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:106), lines 106-125
- [test-plan.md §Epic 03 Test Amendment Ledger](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:138), lines 138-150
- [test-plan.md §Red/Green per Chunk](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:164), line 164
- [coverage.md §Story Shape Review](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md:77), line 77

#### Test Mapping

| TC | Test File / Check | Test Description |
|---|---|---|
| TC-5.1 | `test/view-boundary-turn-end.test.ts` | mid-turn batches do not move boundary; turn close advances once; whole oldest turns flip; turnless singleton leg |
| TC-5.2 | `test/view-boundary-turn-end.test.ts` | G2 peek-ahead landing, exact-target leg, newest-turn protection, `maxTokens > targetTokens`, 64k/32k defaults |
| TC-5.3 | amended `test/view-boundary.test.ts` plus new turn-end file | monotonicity, short form, compact reset, deterministic replay, failure injection, next-close heal |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|---|---|---|---|
| Boundary decision and status sum diverge | amended boundary tests | Status `zoneTokens` and advance decision use the same population after advances and failures | ACs state behavior; this proves two readers do not drift |
| Superseded Epic 03 tests deleted wholesale | amendment ledger plus red-manifest regeneration | Each named old leg is inverted, replaced, re-cut, or kept | Green tests alone would not prove the sanctioned test-change path was followed |
| Partial-turn eviction | `test/view-boundary-turn-end.test.ts` per-turn all-or-nothing assertions | Every tool result in an evicted turn flips together | Boundary position could appear correct while a turn is split internally |

#### Technical Notes

Relevant contracts:

```ts
export interface VisibilityBudgets {
  maxTokens: number;
  targetTokens: number;
}

// defaults: { maxTokens: 64_000, targetTokens: 32_000 }
// validation: maxTokens > targetTokens
```

Boundary decision:

```text
advanceDecision(groups, { maxTokens, targetTokens }):
  total <= maxTokens -> no movement
  walk groups oldest-first, excluding newest group always
  evict group only if (remaining - group.tokenSum) >= targetTokens
  boundary position = highest source_event_order in last evicted group
```

Grouping rules:

| Case | Grouping |
|---|---|
| normal turned tool results | group by `turn_id`, oldest first by lowest `source_event_order` |
| `turn_id IS NULL` | singleton group |
| newest closed turn | never candidate for eviction |
| open turn | structurally untouchable because checks only run on turn close |

Epic 03 test amendment ledger:

| Existing test area | Change | Reason |
|---|---|---|
| floor-protection legs | superseded and replaced by newest-turn-protection legs in TC-5.2 | `floorTokens` retired |
| per-intake-advance legs | inverted into TC-5.1 mid-turn-never-moves assertions | trigger moved to turn close |
| message-grained eviction goldens | re-cut for turn grouping | eviction granularity is whole turn |
| construction tests passing `floorTokens` | update to two-field budgets; add new rejected-unknown-config test for `floorTokens` | config surface change |
| status `zoneTokens` legs | unchanged | shared-query invariant holds |

Lifecycle/capstone deterministic legs from Epic 04 are untouched. Red-manifest regeneration is required after applying the amendment ledger.

#### Transition-State Risk

- Mid-turn state may exceed max and remain full until the turn closes.
- The open turn is untouchable because no check runs mid-turn.
- The newest closed turn is never evicted, even when oversized.
- A failed post-commit advance must leave intake committed and status visibly over budget until the next turn close heals it.

#### Anti-Shim Requirements

- Do not keep a hidden `floorTokens` fallback.
- Do not move the advance seam; gate the existing post-commit registration.
- Do not evict individual messages from a turned group.
- Do not delete Epic 03 tests without applying the ledger and regenerating the red-manifest artifact.

#### Production Path Proof

- Entrypoint: intake-stream commit pipeline.
- Registration/default path: existing post-commit advance registration, gated by committed `turn_end`.
- Evidence: turn-end boundary tests assert no mid-turn movement, one advance at close, deterministic replay, and non-blocking failure visibility.

#### Verification

- Targeted: `cd packages/lhc && pnpm exec vitest run test/view-boundary.test.ts test/view-boundary-turn-end.test.ts`
- Story gate: `cd packages/lhc && pnpm run red-verify && pnpm exec vitest run test/view-boundary.test.ts test/view-boundary-turn-end.test.ts`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Advance registration runs only for batches that committed `turn_end`.
- Boundary eviction groups tool results by turn and flips whole groups oldest-first.
- Peek-ahead stop and newest-closed-turn protection match TC-5.2.
- `floorTokens` is removed from the visibility config surface; defaults and `maxTokens > targetTokens` validation are updated.
- Epic 03 amended tests are changed according to the ledger, not deleted wholesale.
- Red manifest is regenerated after the test amendments.
- TC-5.1, TC-5.2, and TC-5.3 are green.
