# Story 5: Message Edit and Cascade

### Summary
<!-- Jira: Summary field -->

`messages.edit` as a public SDK + CLI operation: canonical content change plus full dependent-form cascade in one transaction, with the source-version check proving in-flight pre-edit work can never overwrite post-edit rebuilds.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The user who is bothered at least once a day that they can't fix a bad message. `lhc messages edit --file-path ./t.lhc --message m42 --content "..."` — and the forms built on m42 clear and rebuild behind it.

**Objective:** The record's first sanctioned mutation ships whole. Edit changes a closed-turn message's content and blocks, re-stamps the token estimate, and in the same transaction walks the derivation chain upward — the message's own forms, its turn's rendering and projection, the containing chunk's summaries — clearing each to `pending` and re-queueing. The event log keeps the original (projection-level mutation; Epic 01's events remain immutable). The ordering guarantee makes the cascade safe: an in-flight pre-edit item that completes after the edit discards against the source-version check; the post-edit artifact wins regardless of completion order. Edit never touches a generated thread-view — visibility arrives at the next compact/rebuild (DD-12).

**Scope — in:**
- `messages.edit` (SDK + CLI): validates target (closed turn, message exists, not deleted), updates content and blocks, re-stamps the token estimate, cascades, returns the `MutationResult` (changed / cleared / queued / superseded)
- Cascade scope, walking the chain upward in one transaction: the edited message's own forms → its turn's rendering + projection → the containing chunk's detailed + brief summaries; cleared to `pending`, re-queued (dedupe applies); nothing outside the chain touched
- Post-edit invariant: when edit returns, no derivation built from pre-edit content is `ready` — every cleared form is `pending` with replacement work queued in the edit's transaction (AC-5.3)
- Source-version check: each clear bumps the form's `source_version`; a completing work item carrying a stale version discards (reported `stale_discarded`) rather than landing content; still-queued old items are supersede-deleted in the cascade transaction and reported on the MutationResult
- Edit refusals: open-turn target, unknown message id, deleted message — stable errors, nothing changes
- Mutation NFR: edit is synchronous and local — record update and cascade commit together before the operation returns

**Scope — out:** Delete (Story 6 — same cascade machinery, removal semantics on top). Open-turn mutations (refused; v1 boundary per the epic). Rebuild execution itself (the drain — Stories 1–3 machinery — runs the re-queued work; this story proves the queueing and the version check). Any generated thread-view refresh (none in this epic; DD-12).

**Dependencies:** Logically Story 3 (the full chain — message forms through chunk summaries — must exist to cascade through). Recommended after Story 4 for test visibility: the cascade TCs assert form states, and the report surface makes those assertions direct — the epic's breakdown orders it this way for that reason.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-5.1**: An edit to a message in a closed turn updates content and blocks and re-stamps the token estimate in one synchronous transaction; the edit result reports the content change, cleared forms, and queued work.
  - **TC-5.1** (AC-5.1): Edit a prompt in a closed turn → content and estimate updated synchronously; result names cleared forms and queued items.
- **AC-5.2**: The cascade clears exactly the dependent set: the message's own forms, its turn's rendering and projection, and the containing chunk's summaries; forms of other messages, other turns, and other chunks are untouched.
  - **TC-5.2** (AC-5.2): Thread with two chunks, edit a message in chunk 1 → cleared set is exactly that message's forms + its turn's two forms + chunk 1's two summaries; chunk 2's forms still `ready`.
- **AC-5.3**: After an edit returns, no derivation built from pre-edit content is in `ready` state; every cleared form is `pending` with replacement work queued in the edit's transaction.
  - **TC-5.3** (AC-5.3): Edit while forms are `ready` → immediately after return, all dependent forms `pending`, queue holds their work.
- **AC-5.4**: An in-flight derivation started against pre-edit content cannot land over a post-edit rebuild: the post-edit artifact wins regardless of completion order.
  - **TC-5.4** (AC-5.4): Slow double processing old-content smoothing; edit mid-flight; let both complete → final form is post-edit content's smoothing.
- **AC-5.5**: An edit against a message in the open turn is refused with a stable error; an edit against a missing message is refused; refusal changes nothing.
  - **TC-5.5** (AC-5.5): Edit the open turn's prompt → refused, stable code; edit a missing id → refused; read-back unchanged after both.
- **AC-5.6**: Edit is available on the SDK and as a CLI command with parity: same validation, same result shape, same cascade.
  - **TC-5.6** (AC-5.6): Same edit via SDK and CLI on twin fixtures → identical result shape, identical cascade, identical read-back.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The first sanctioned mutation, and the test of everything underneath it. `messages.edit` runs one transaction (DD-8): validate against the deleted-filtered read (`turn_open` / `message_not_found` refusals), apply content + blocks + token re-stamp, then the cascade from `messages/internal/cascade.ts` — bump source version and set `pending` on every dependent form (the message's own, the turn's two, the chunk's two), supersede-delete still-queued old-version items (issue 1's tidy-up, ids reported on the result), enqueue replacements at the new source version, register the poke. Claimed old-version items may still finish; their results are discarded by the source-version check. One commit carries all of it; the operation returns `MutationResult`.

The **source-version check** is the story's architectural heart and TC-5.4 is the epic's named architecture-risk test: a pre-edit item that completes after the edit writes through `forms.ts`'s version check, mismatches, and discards as `stale_discarded` (row deleted, outcome reported) — the post-edit rebuild stands regardless of completion order (AC-5.4). The rule in one line: a background result must not overwrite a derived form if the source changed since the job was queued. The check was built in Story 0, enforced from Story 2's first form write; this story is where it's finally *provoked*. Same machinery serves Story 6's deletes — the cascade module has two callers by design.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The cascade's exactness (everything in the chain, nothing outside it), transactional atomicity, and the version check's race resolution are all properties that fail silently under a weaker build discipline; TC-5.4 specifically requires orchestrating a mid-flight overlap.

Risk Reminders:
- TC-5.2's untouched-set assertion is as load-bearing as the cleared-set: chunk 2's forms must show *unchanged state and source version* — cascade over-reach is the symmetric failure.
- TC-5.4 needs the delayed double (`delayKind`) + background drain + `drainSettled` — the deterministic recipe is in the test plan; don't substitute sleeps.
- Edit re-stamps the token estimate synchronously (Epic 01's estimator) — forgetting it leaves placement arithmetic stale after edits.
- The refusal reads through the *deleted-filtered* view — a deleted message edits as `message_not_found`, not as a new error code.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Edit operation | `src/domains/messages/index.ts` (`edit`) + internal validate/apply |
| Cascade module | `src/domains/messages/internal/cascade.ts` (NEW: walk-and-clear, both mutation kinds parameterized) |
| Supersede | work-queue `supersedeQueued` (Story 1 util, first real caller) |
| Version-check enforcement | `forms.ts` version-checked UPDATE-only write (existing; provoked here) + drain completion discard path |
| CLI | `src/cli/messages-mutate.ts` (NEW per §Placement: `lhc messages edit --file-path --message --content`) |
| Tests | `test/mutations.test.ts` (NEW, Flow 5 half), parity legs in `test/cli-process-work.test.ts` |

#### Design References

- [tech-design.md §Flows 5/6 (transaction walk, refusals)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:233), line 233
- [tech-design.md DD-8 (cascade module, one transaction, two callers)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:87), line 87
- [tech-design.md §Mechanics (source-version truth table; cascade algorithm)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:410), lines 410–424
- [tech-design.md §Interfaces (MutationResult, edit signature, error codes)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:334), lines 334–377
- [tech-design.md §Issue 1 (supersede decision trail)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:97), line 97
- [test-plan.md §mutations suite (TC-5.x rows)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:79), lines 79–88

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-5.1 | `test/mutations.test.ts` | content + blocks + estimate synchronous; result names cleared + queued |
| TC-5.2 | `test/mutations.test.ts` | cleared set exact (5 forms); chunk 2 state *and source version* unchanged |
| TC-5.3 | `test/mutations.test.ts` | post-return: dependents `pending`, replacements queued at new source version; replacement ids include source version; superseded queued ids on the MutationResult, rows deleted |
| TC-5.4 | `test/mutations.test.ts` | delayed old-content item discards on version mismatch; exactly one ready row from post-edit content |
| TC-5.5 | `test/mutations.test.ts` | `turn_open` + `message_not_found` refusals; read-back unchanged after each |
| TC-5.6 | `test/cli-process-work.test.ts` | SDK/CLI twins: identical result JSON, cascade, read-back |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Version check beats the straggler | TC-5.4 | stale completion discards; `stale_discarded` reported by the drain; one ready row | The race window only opens under orchestrated overlap; every sequential test passes without the check existing |
| Cascade reach exactness | TC-5.2 both directions | five cleared, rest byte-stable | A clears-everything cascade passes the cleared-set half; only the untouched-set assertion catches over-reach |
| Atomicity | TC-5.1 + induced failure | a failing cascade step rolls back the content change too | Post-hoc state checks can't distinguish two transactions that both happened to commit |

#### Technical Notes

**Cascade table** (epic Data Contracts — edit of message m in turn t, chunk c):

| Level | Cleared and re-queued |
|-------|----------------------|
| message | m's own forms (smoothing or tool summaries as applicable) |
| turn | t's rendering, t's projection |
| chunk | c's detailed summary, c's brief summary |

Nothing past c: chunk summaries derive from their own members only — the cascade's reach is structural, not configured.

**Source-version mechanics** (tech design §Mechanics): `derived_form.source_version` increments on every clear; work items carry the version at queue time; completion writes content only when versions match, else discards as `stale_discarded`. The check makes AC-5.4 a mechanical truth-table row, not a race.

**Edit result shape** (tech design §Interfaces): `MutationResult` — `changed` (messageIds/turnIds), `cleared` (subject + form per clear), `dropped` (delete only; empty for edit), `queued` (workItemId + kind), `superseded` (old item ids the cascade tidied).

**Refusal codes** (tech design error table): `turn_open`, `message_not_found` — stable constants per Epic 01's error-code pattern; deleted targets read as `message_not_found` through the filtered view.

**Cross-story debts cashed here** (coverage.md): `superseded` and `stale_discarded` — the two dispositions Story 1 shipped dead — get their first real producers (cascade supersede-delete on the MutationResult; version-check discard on the drain report). TC-5.4 is the test the coverage artifact names as cashing the `stale_discarded` row.

#### Anti-Shim Requirements

- The cascade derives its clear-set from the record's structure (message → turn → chunk walk) — never from a hardcoded form list that would silently miss future forms.
- The version check lives in the *single* form-write path — no second write path that skips it.
- Stale discard is a normal completion (`done`/`stale_discarded`), not an error or a retry — the straggler must not requeue itself.
- No version-check shortcuts: TC-5.4 must hold a real claimed old-version item across the edit (delayed double), enqueue the replacement at the new source version, and prove the old result is discarded rather than simulating the mismatch by poking source versions directly.

#### Production Path Proof

- Entrypoint: `lhc messages edit` and `messages.edit` — the user-facing operation the epic's User Profile names (the daily itch).
- Registration/default path: cascade enqueues ride the standard path; in background mode the rebuilds run with no further call — edit-and-walk-away is the product behavior.
- Evidence: TC-5.6's spawned-CLI twin proves the full production surface; TC-5.4 proves the race the production scheduler actually creates.

#### Verification

- Targeted: `pnpm vitest run test/mutations.test.ts`; `LHC_PROCESS_SUITE=1 pnpm vitest run test/cli-process-work.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

| Date | Deviation | Disposition |
|---|---|---|
| 2026-06-10 | Pre-implementation patch: source-version / stale-result wording clarified (mechanics unchanged); supersede = delete + MutationResult report; edits never touch generated thread-views (DD-12) | Spec updated before implementation; build to current text |

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-5.1 through TC-5.6 green
- [ ] TC-5.4 green — the epic's named architecture-risk test (version check beats the straggler)
- [ ] Cascade precision proven both directions: everything in the chain cleared, nothing outside it touched (TC-5.2)
- [ ] Synchronous mutation proven: content, estimate, and full cascade commit in the edit's transaction before return (TC-5.1, TC-5.3)
- [ ] CLI parity and burst coalescing (TC-5.6)
- [ ] Verification gates green
