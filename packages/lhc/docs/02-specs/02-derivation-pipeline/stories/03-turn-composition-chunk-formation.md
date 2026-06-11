# Story 3: Turn Composition and Chunk Formation

### Summary
<!-- Jira: Summary field -->

The `turns` derivation layer: turn rendering composed from message-level forms with recorded fallback gaps, lower-band projection, deterministic chunk close policy, and the two chunk summaries.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The agent's future thread-views stand on these artifacts — turn renderings, projections, and chunk summaries are the bands' raw material; gap records are the freshness debt the report surfaces.

**Objective:** Closed turns become composed artifacts and chunks form deterministically. The `turn_derivation` handler composes the turn's rendering from its messages' derived forms — falling back to raw or truncated source where a form isn't `ready`, recording each fallback as a gap; tool activity composes into outcome-explicit run accounts — then projects the rendering to the lower band. Chunk placement and close run by accumulated projected size; closing queues the two summary kinds with independent lifecycles.

**Scope — in:**
- `turn_derivation` handler: compose rendering from message forms in message order (smoothed prompt or raw prompt; tool summaries or deterministic truncation), record a gap per fallback naming the source record and missing form, land rendering `ready`, then project lower band from the rendering
- Tool-run composition: tool activity appears as composed accounts of runs, each stating its outcome; a run containing a state-changing call never loses its outcome in composition (AC-3.4)
- Gap semantics: a gapped artifact is `ready` and usable — freshness debt, not defect; a later-repaired dependency does not auto-cascade (AC-3.3); gaps clear only when the artifact is explicitly rebuilt
- Chunk placement at turn derivation: a turn whose projection succeeded joins the open chunk, placement recorded with the turn; when accumulated projected size plus the incoming turn's would cross the close target, the chunk closes *without* the incoming turn, which starts the next chunk (AC-3.6); a single turn whose projection alone meets the max forms its own chunk immediately (AC-3.7)
- Chunk close queues `chunk_summary_detailed` and `chunk_summary_brief` as two work items with independent retry, states, and re-queue; detailed preserves tool-activity receipts, brief preserves outcomes only
- Determinism: replaying the same record through the same policy values produces identical chunk membership — no inference in placement or close

**Scope — out:** Report surface that exposes gaps (Story 4). The public re-queue operation with refusal/idempotency semantics (Story 4) — TC-3.3's re-queues drive the queue util directly. Mutations that shrink membership (Story 6 — the one sanctioned exception, and it shrinks, never re-cuts).

**Dependencies:** Story 2 (message forms to compose from). Story 1 (drain). Story 0 (double's compose/project/summarize operations, chunk kinds registered).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-3.1**: A closed turn's derivation work lands a smoothed rendering and a lower-band projection, each carrying its own state.
  - **TC-3.1** (AC-3.1): Close a turn with all message forms ready, drain → rendering and projection `ready`, independent state rows.
- **AC-3.2**: The rendering composes message-level forms where they are `ready`; where a form is `pending` or `failed`, the rendering uses the message's raw or truncated content and still lands `ready`, recording each fallback as a dependency gap on the artifact — message-form gaps degrade the rendering's inputs, they do not fail the turn.
  - **TC-3.2** (AC-3.2): Close a turn where one prompt's smoothing failed → rendering `ready`, contains that message's raw content, other forms composed, gap recorded naming the message and form.
- **AC-3.3**: A dependency later becoming `ready` does not silently change artifacts that landed with a gap: they stay `ready`, their gap records stand, and the report surfaces them; rebuilding a gapped artifact is an explicit re-queue through its owning surface (Flow 4), never an automatic cascade.
  - **TC-3.3** (AC-3.3): Repair the failed smoothing to `ready` after the rendering landed → rendering unchanged, gap still reported; re-queue the rendering through `turns` → rebuilt without the gap, gap record cleared. *Story note: the re-queues in this TC use the work-queue enqueue directly (Story 1's util); the public re-queue operation with refusal and idempotency semantics is Story 4's (AC-4.4–4.6).*
- **AC-3.4**: Tool activity in a rendering appears as composed accounts of runs, each stating its outcome; a run containing a state-changing call never loses its outcome in composition.
  - **TC-3.4** (AC-3.4): Turn with a three-call edit run (one `isError`) → rendering's account states the run's outcome; failed call's outcome present.
- **AC-3.5**: A turn whose lower-band projection succeeded joins the open chunk; placement is recorded with the turn and readable through `turns`.
  - **TC-3.5** (AC-3.5): Drain a closed turn → turn read-back shows chunk placement.
- **AC-3.6**: A chunk closes when the accumulated projected size of its turns plus the incoming turn's crosses the close target; the incoming turn starts the next chunk when placement would cross it, per the policy's accumulation rule.
  - **TC-3.6** (AC-3.6): Turns sized so the third crosses the target → chunk closes holding two; third opens the next chunk.
- **AC-3.7**: A single turn whose projection alone meets or exceeds the close maximum forms its own chunk immediately.
  - **TC-3.7** (AC-3.7): One turn whose projection exceeds the max → own chunk, closed immediately.
- **AC-3.8**: Chunk close queues detailed and brief summary work as two work items with independent retry; both land as chunk-level derived forms with independent states. The detailed summary preserves tool-activity receipts (what changed, outcome); the brief summary preserves outcomes only.
  - **TC-3.8** (AC-3.8): Close a chunk, drain → detailed and brief summaries `ready`; double-marked content distinguishes them; detailed carries the run receipts fixture content, brief carries outcomes. Fail the brief item past budget with detailed succeeding → detailed `ready`, brief `failed`, independently re-queueable.
- **AC-3.9**: Chunk boundaries are deterministic: replaying the same record through the same policy values produces identical chunk membership.
  - **TC-3.9** (AC-3.9): Replay an identical event stream into a fresh thread → identical chunk membership and boundaries.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The `turns` derivation layer, and the epic's biggest single handler: `turn_derivation` composes the rendering from message-level forms (`compose.ts`: ready forms verbatim; non-ready fall back to raw/truncated content, one gap recorded per fallback; consecutive tool activity grouped into outcome-explicit run accounts), sends it through `composeTurnRendering` then `projectLowerBand`, lands both as turn forms — then placement runs *in the completion transaction*: append to the open chunk, close on the accumulated policy (DD-9), and closing enqueues both summary kinds as separate items with independent lifecycles.

Two invariants govern: **gaps are recorded facts, not live links** (AC-3.3 — a repaired dependency changes nothing until the dependent is explicitly rebuilt; this is the no-auto-cascade rule the epic's reviewers converged on), and **placement is pure arithmetic** (DD-9 — close decisions from stored projected token counts only, so identical streams re-chunk identically, AC-3.9). The close rule: when accumulated + incoming would cross the target, the chunk closes *without* the incoming turn, which opens the next chunk; a single projection ≥ max forms its own chunk. This is the v1 bug's fix — the MVP checked only the incoming turn's size, so small turns accumulated forever.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- Composition fallbacks, gap recording, deterministic placement arithmetic, and the close→enqueue chain all interact inside one handler's flow; the close policy has golden-case boundary semantics (crossing turn excluded) that a plausible-looking implementation gets wrong exactly the way v1 did.

Risk Reminders:
- The close decision *excludes* the incoming turn (it opens the next chunk) — TC-3.6's "closes at 2 members, third opens chunk 2" is the boundary-exactness assertion; off-by-one here recreates the v1 bug inverted.
- Gap recording must name `{subjectKind, subjectId, form}` per fallback — TC-3.3's later rebuild (Story 4's TC-4.4 consumes it) depends on gap precision.
- Placement runs in the completion transaction — a separate placement transaction would let a crash strand a derived-but-unplaced turn.
- TC-3.3's re-queues drive the queue util directly (story note in the AC section); don't reach for Story 4's surface early.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Turn handler | `src/domains/turns/internal/derive.ts` (NEW: orchestrates compose → provider → forms → placement) |
| Composition | `src/domains/turns/internal/compose.ts` (NEW: pure — forms+fallbacks → composition input + gaps) |
| Chunk mechanics | `src/domains/turns/internal/chunks.ts` (NEW: open-chunk append, close policy, member ordering) |
| Summary handlers | `src/domains/turns/internal/derive.ts` (chunk_summary_detailed / brief, member projections in turn order) |
| Turn forms | turn + chunk rows in `derived_form` via the same `forms.ts` UPDATE-only write pattern (subjectKind discriminates) |
| Surface | `src/domains/turns/index.ts` (workHandlers export; chunkId/memberIdx on turn read-back) |
| Tests | `test/derivation-turns.test.ts` (NEW) |

#### Design References

- [tech-design.md §Flow 3 (handler walk, placement, gap semantics)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:227), lines 227–229
- [tech-design.md DD-9 (close policy + golden cases)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:89), line 89
- [tech-design.md §Storage (chunk, chunk_member, derived_form subjects)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:155), lines 155–181
- [tech-design.md §Interfaces (DependencyGap, provider ops 4–7, chunk policy config)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:248), lines 248–300
- [tech-design.md §Mechanics (deleted-read filter — compose reads are filtered)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:426), line 426
- [test-plan.md §derivation-turns suite](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:53), lines 53–65

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-3.1 | `test/derivation-turns.test.ts` | rendering + projection ready as independent rows |
| TC-3.2 | `test/derivation-turns.test.ts` | failed smoothing → rendering ready w/ raw text; gap `{message, smoothed_prompt}` |
| TC-3.3 | `test/derivation-turns.test.ts` | repaired dependency → rendering unchanged, gap persists; explicit rebuild → gap clears, source version++ |
| TC-3.4 | `test/derivation-turns.test.ts` | 3-call run with one isError → account carries per-call outcomes |
| TC-3.5 | `test/derivation-turns.test.ts` | turn read-back shows chunkId + memberIdx |
| TC-3.6 | `test/derivation-turns.test.ts` | target=100, ~40 each: third turn closes chunk at 2, opens chunk 2 |
| TC-3.7 | `test/derivation-turns.test.ts` | projection 250 ≥ max 200 → own chunk, closed immediately |
| TC-3.8 | `test/derivation-turns.test.ts` | both summaries ready, distinct; brief fails alone, requeues alone |
| TC-3.9 | `test/derivation-turns.test.ts` | replay → deep-equal chunk/chunk_member |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Gap no-auto-cascade | TC-3.3 first leg | repair lands, dependent *unchanged*, no work queued | The tempting implementation (live join to dependency state) passes TC-3.2 and silently rebuilds |
| Boundary exactness | TC-3.6 + TC-3.7 | crossing turn excluded; max self-chunks | "Chunks form" passes with the v1 single-turn check; only exact member counts catch it |
| Determinism under replay | TC-3.9 | byte-equal membership across runs | Any hidden clock/inference input to placement breaks replay invisibly |

#### Technical Notes

**Dependency Gap contract** (epic Data Contracts): recorded on the composed artifact at derivation time; names the source record (messageId or turnId) and the form that fell back; the artifact is `ready` and usable. Lifecycle: created with the composition, persists through dependency repair (no auto-cascade — AC-3.3's no-silent-rebuild rule), cleared only by explicit rebuild of the gapped artifact (Flow 4 re-queue or mutation cascade).

**Chunk close policy** (epic Flow 3, tech design golden cases): accumulated projected tokens, config-with-defaults target and max. Accumulation rule: when `open chunk's accumulated + incoming turn's projection` would cross the target, the chunk closes holding its current members and the incoming turn opens the next chunk (TC-3.6: third turn crosses → chunk closes holding two, third opens chunk 2). Max rule: a single projection ≥ max forms its own chunk immediately. Size-only, reproducible from the record; exact threshold inclusivity per the tech design's golden table.

**Composition input shapes**: `composeTurnRendering` receives ordered per-message entries (form content or fallback content, flagged which); `projectLowerBand` receives the rendering; chunk summaries receive member projections in turn order. Exact interface shapes in tech design §Interfaces.

**Fallback rules**: prompt → raw content; tool call/result → deterministic truncation (Epic 01's truncation util); assistant text → raw (never had a form).

**Chunk policy config** (DD-9, config-with-defaults): target 2200 projected tokens, max 8000; tests override (TC-3.6 uses 100/200-scale values). Values are tuning knobs, not architecture — the *rule* (accumulation, crossing-turn-excluded, max-self-chunk) is the contract.

**Cross-story debt** (coverage.md): TC-3.2's gapped-rendering state is the input TC-4.4 consumes; build it via the fixture builder so Story 4 reuses it.

#### Anti-Shim Requirements

- `compose.ts` is pure: `(messages, forms) → { input, gaps }` — no DB handle, no provider, no clock in its signature; determinism is structural.
- Placement arithmetic reads stored projected token counts — never re-counts, never estimates at placement time.
- The close→enqueue chain runs in the completion transaction; both summary enqueues ride the same commit (a crash leaves either a closed chunk with two queued summaries or an open chunk — nothing between).
- Tool-run accounts group by *consecutive* tool activity — no cross-message reordering to make accounts tidier.

#### Production Path Proof

- Entrypoint: turn close (Epic 01's state machine) queues `turn_derivation`; no new commands — the pipeline reaches this story's code through normal conversation flow.
- Registration/default path: `turns.workHandlers` joins the map at `createSdk`; placement runs inside the handler's completion, not as a separate scheduled step.
- Evidence: TC-3.1/3.5 drive intake → turn close → drain → rendering + placement through the production chain; TC-3.9's replay proves no hidden inputs joined along the way.

#### Verification

- Targeted: `pnpm vitest run test/derivation-turns.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-3.1 through TC-3.9 green
- [ ] Architecture-risk tests green: gap-no-auto-cascade (TC-3.3), independent detailed/brief summary retry (TC-3.8), deterministic chunk membership and boundaries (TC-3.9)
- [ ] Chunk close golden cases from the tech design all asserted (target crossing with the incoming turn starting the next chunk, max self-chunk, threshold exactness)
- [ ] Double input recording proves composition consumed forms, not raw re-derivation (TC-3.4)
- [ ] Verification gates green
