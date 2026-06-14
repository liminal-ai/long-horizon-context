# Story 2: Smart Compact

### Summary
<!-- Jira: Summary field -->
The compact operation: profiles and validation, band arrangement from stored artifacts, degrade ladders and gaps, atomic snapshot replace with boundary reset, receipts; pull serves snapshot + tail.

### Description
<!-- Jira: Description field -->

**User Profile (from epic):** the agentic harness (PI extension first), calling through the SDK on every model call; and the agent/operator running compacts and checking thread health through the CLI.

**Objective:** the view exists. Compact selects, renders, and atomically installs the band snapshot; pull serves it verbatim between compacts.

**Scope in:**
- `compact(ref, { profile?, params?, sweep? })` per tech design §Flow 2: validate → (sweep step **absent this story** — see scope out) → read record + forms → selection walk (§Deterministic Algorithms, rules 1–6 including turnless stragglers) → band rendering (degrade ladders, gap entries, subject keys, `[inter-turn note]` markers) → one `BEGIN IMMEDIATE` transaction (delete view row cascade, insert header + bands, boundary ← compact point) → `CompactReceipt`
- Canonical-corruption refusal (`state_corruption`, pre-transaction, prior view untouched)
- Coverage edge: `covered_from`, receipt reports out-of-window history
- Pull upgraded: snapshot bands verbatim + tail; `ViewMeta` populated
- Status upgraded: view-health fields live (degraded count, gap count, built-at)
- Selection + boundary golden cases G1–G4 (committed JSON goldens)

**Scope out:** the sweep — compact ships with the sweep step absent; the receipt's sweep section reports `absent`. Story 3 adds the embedded sweep and flips the receipt to `SweepReceipt | { skipped: true }`. Same pattern as Epic 01's Story 4→5 queue seam: the gap is a stated cross-story debt, not a shim — nothing fakes a sweep, nothing stubs one.

**Dependencies:** Stories 0–1.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-2.1**: Compact runs only when invoked through the surface (SDK or CLI). No code path in core invokes it internally.
- **AC-2.2**: The operation accepts a named profile or explicit parameters; explicit parameters override profile values; built-in profiles exist and user-defined profiles are configurable.
- **AC-2.3**: Invalid configuration (band percentages not summing to 100, unknown profile, non-positive bound) is rejected with a caller error naming the violation; thread state is unchanged.
  - **TC-2.1** (AC-2.2, AC-2.3, AC-2.7): Compact with a built-in profile → succeeds with that profile's bound and mix recorded in the receipt; compact with percentages summing to 105 → caller error naming the sum; unknown profile → caller error naming it; thread unchanged after both rejections.
- **AC-2.4**: A compacted view targets the configured lower bound: band shares are computed from its percentages, each band fills by whole entries against its share, and the receipt reports actual per-band and total token counts. The total may land below the bound (insufficient stored material, or the next whole entry would exceed a band's share) or above it (an indivisible turn/chunk/message included by the selection rules). Assembly is entirely from stored artifacts — no provider calls during compact (sweep requeues background work; the compact itself never waits on or invokes inference).
  - **TC-2.2** (AC-2.4, AC-2.9): On a thread with full derivation coverage, compact → view targets the bound (receipt's actual counts within whole-entry tolerance of band shares, deviations attributable to whole-entry inclusion rules), provider fake observes zero calls during the compact; read the record after → identical to before.
- **AC-2.5**: Missing or unusable band material degrades: the entry renders the best available stored form for its subject and is marked degraded, or renders as an explicit gap entry when nothing usable exists. The compact records every degraded entry and gap on the view and reports them in the receipt. A compact never fails because derived material is missing or failed; it refuses only when canonical source state needed to identify or read the compacted span is corrupt or unreadable, with a structured `state_corruption` error naming the damage, leaving the prior view and the record unchanged.
  - **TC-2.3** (AC-2.5, AC-2.7): On a thread with one failed chunk summary and one pending turn rendering, compact → completes; degraded entries render fallbacks and are marked; receipt lists both with reasons and reports per-band counts; no span silently absent (every turn/chunk in the compacted range accounted for in some form).
  - **TC-2.7** (AC-2.5): On a fixture thread with manufactured canonical corruption (damaged below the SDK, per the Epic 01 corruption-fixture pattern), compact → refuses with `state_corruption` naming the damage; the prior active view still serves; record unchanged. Control: the same thread with only derived-material damage (failed summaries) compacts successfully with gaps.
- **AC-2.6**: The compact replaces the active view atomically: band arrangement, rendered snapshot, compact point, config used, and gaps land in one transaction; the visibility boundary resets to the compact point in the same transaction. A crash mid-compact leaves the previous view intact and serving.
  - **TC-2.4** (AC-2.6): Crash injection between sweep and view write (test seam) → previous view still serves; rerun compact → new view lands; no partial state.
- **AC-2.7**: The receipt reports what was built: per-band entry counts and rendered sizes, degraded entries and gaps with reasons, sweep results (or that the sweep was skipped), and the config used. *(Sweep section reports `absent` until Story 3 — cross-story debt, stated.)*
- **AC-2.9**: Compacting destroys nothing canonical: every prior view's content remains derivable from the record, and the record is untouched by compaction.
- **AC-2.10**: Band entries carry their subject keys visibly in rendered text (chunk ids for chunk bands, turn ids for the smoothed band).
  - **TC-2.6** (AC-2.10): Compact, pull, inspect band text → chunk keys present for brief/detailed entries, turn keys for smoothed entries.
- **AC-1.4**: Between compacts, band content is served byte-identical across pulls. Record edits, deletes, and repair landings after the snapshot do not alter it.
  - **TC-1.3** (AC-1.4): Compact, pull, then edit a message whose chunk summary landed in a band; pull again → band bytes unchanged; drain; pull again → still unchanged (rebuilt summary lands in record only).
- **AC-1.6**: A message deleted in the tail region is absent from subsequent pulls. A deletion whose derived content sits in the band snapshot leaves the snapshot unchanged until the next compact.
  - **TC-1.5** (AC-1.6): Delete a tail message, pull → message absent. Delete a message banded in the snapshot, pull → band unchanged; status read shows the record changed (next-compact visibility).
- *(debt closure, primary owner Story 1)*: TC-2.5's view-health legs complete here — status reports degraded/gap counts and built-at after a degraded compact.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The view comes into existence here. Compact is the only writer of the snapshot (`thread_view` + `thread_view_band`, singleton, delete-then-insert in one transaction) and one of exactly two writers of the boundary (reset; the other writer is Story 4's advance). Pull — Story 1's code, unmodified in shape — starts serving snapshot + tail the moment a view row exists. The sweep step is **absent** this story: the receipt's `sweep` field reports a literal `absent` placeholder, and Story 3 replaces it with `SweepReceipt | { skipped: true }`.

#### Build Strategy

Inside-out, pure-to-stateful: (1) `select.ts` as a pure function against fixture data, driven by goldens G1–G4 — this is most of the story's risk and none of its IO; (2) `render.ts` band rendering with ladders/gaps/keys, driven by TC-2.3 and TC-2.6; (3) `snapshot.ts` atomic replace + boundary reset; (4) `index.ts` compact assembly with validation and corruption abort; (5) receipts. Goldens are committed JSON — write the expected arrangements by hand from the design's rules *before* implementing, so the goldens test the rules rather than memorialize the implementation.

#### Implementation Targets

| Target | Work |
|--------|------|
| `src/domains/thread-view/internal/select.ts` | the six-rule walk + tie-breakers; corruption detection (unreadable canonical rows → abort signal); coverage edge (`covered_from`) |
| `src/domains/thread-view/internal/render.ts` | band text: ladders (smooth/detailed/brief rows), gap entries, `§` subject keys, `[degraded: …]` and `[inter-turn note]` markers |
| `src/domains/thread-view/internal/snapshot.ts` | atomic replace: `BEGIN IMMEDIATE`, delete singleton (cascade bands), insert header + bands, boundary ← compact point, COMMIT |
| `src/domains/thread-view/index.ts` | `compact` real: validate → [sweep absent] → read → select → render → replace → receipt |
| `test/view-select-golden.test.ts` | G1–G4 committed goldens |

#### Design References

| Topic | Where |
|-------|-------|
| Selection walk, rules 1–6, tie-breakers | tech-design.md L174–185 |
| Degrade ladders + gap entries + keys | tech-design.md L191–200 |
| Compact flow + sequence diagram + corruption/crash semantics | tech-design.md L251–279 |
| Storage, singleton, provenance (`source_state_json`) | tech-design.md L135–168 |
| `view_id` reuse note (do not "fix") | tech-design.md L395 |
| `CompactReceipt` shape | tech-design.md L326–333 |
| Goldens G1–G4 | test-plan.md L69–72 |
| Lower bound = target, not cap | epic.md L229; tech-design.md L179 |

#### Test Mapping

| TC | Test file | Asserts |
|----|-----------|---------|
| TC-2.1 | `test/view-compact.test.ts` | profile compact: receipt config matches; 105% sum → named error; unknown profile → named error; thread unchanged after rejections (read-back equality) |
| TC-2.2 | `view-compact.test.ts` | actuals near shares, every deviation attributable to a whole-entry rule; zero provider calls; record hash unchanged |
| TC-2.3 | `view-compact.test.ts` | failed chunk summary + pending rendering → ladder fallbacks marked degraded; receipt lists both with reasons + per-band counts; every subject represented |
| TC-2.4 | `view-compact.test.ts` | crash at compact-write injection point → prior view serves; rerun lands; no partial rows |
| TC-2.6 | `view-compact.test.ts` | `§c…` keys in brief/detailed text, `§t…` in smooth |
| TC-2.7 | `view-compact.test.ts` | corruption variant → `state_corruption` naming subject, prior view intact; control: derived-only damage compacts with gaps |
| TC-1.3 | `view-compact.test.ts` | edit banded subject + drain → band bytes hash-identical across pulls |
| TC-1.5 | `view-compact.test.ts` | tail delete vanishes; banded delete leaves snapshot; status reflects record change |

#### Architecture-Risk Tests

| Test | Hazard |
|------|--------|
| restart serves snapshot | compact, close SDK, reopen file fresh, pull → identical bytes — real-file durability, not same-process reread |
| coverage edge accounting | old chunks beyond brief budget: `covered_from` correct, receipt reports exclusion, no silent omission, **no phantom gap entries** for out-of-window chunks |
| selection replay goldens | tie-breaker drift (≤ vs <, ordering) that same-engine replay can't catch |
| selection goldens G1–G4 (`view-select-golden.test.ts`) | exact arrangements vs committed JSON: proportions; ≤-edge; oversized loner; turnless straggler + trailing leg |

#### Cross-Story Debt

**TC-2.5 completion leg** (primary owner Story 1): post-degraded-compact status shows degraded/gap counts + `builtAt` live — `view-compact.test.ts`. This story closes the view-health half Story 1 couldn't assert without a compacted view; coverage.md records the split.

#### Technical Notes

The corruption check lives in `select.ts`'s reads, *before* the transaction opens — nothing written means prior view trivially intact; don't move it inside the transaction and rely on rollback. The receipt's `source_state_json` is written at select time (maxEventOrder + form counts seen) — it's the provenance answer to "why does this view say that." `view_id` reuse after intake-free recompacts is by design (L395): do not add a uniqueness scheme. Band order in the pull is brief → detailed → smooth (oldest representation first), then tail.

#### Anti-Shim Requirements

The sweep-absent receipt must be the honest literal (`sweep: "absent"` placeholder shape per Story 3's flip note) — not a fake empty `SweepReceipt`, which would make TC-3.4's Story 3 diff invisible. Goldens are immutable once committed: an implementation that disagrees with a golden is wrong until the *design rule* is shown wrong (deviation process, not golden edit). Degrade ladders must consume real fixture states — no test may flip a form's state by writing `derived_form` directly.

#### Production Path Proof

Compact through `createSdk().threadView.compact` with real profiles resolved from real `SdkConfig.view`; crash injection through the Story 0 facility's named compact-write point, not a monkeypatch.

#### Verification

`pnpm verify`; ~16 tests default suite (goldens included).

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] All TCs above green, including both architecture-risk tests (restart snapshot via real file close/reopen; coverage edge with no phantom gaps)
- [ ] Goldens G1–G4 committed as JSON fixtures with regeneration instructions
- [ ] Receipt sweep section reports `absent` (Story 3 debt stated in code comment referencing this story file)
- [ ] Zero provider calls asserted across compact paths
- [ ] `verify` green; goldens immutable once committed
