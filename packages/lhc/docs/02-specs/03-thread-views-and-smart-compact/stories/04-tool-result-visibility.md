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
