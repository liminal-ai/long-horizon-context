# Story 4: Derivation State, Report, and Repair

### Summary
<!-- Jira: Summary field -->

The visibility and recovery surfaces: the per-thread derivation report joining artifact states with queue detail and gaps, explicit re-queue for failed and gapped forms, blocked-source handling, and the full state lifecycle proven end to end.

### Description
<!-- Jira: Description field -->

**User Profile** (from epic): The user typing `lhc messages report --file-path ./thread.lhc --not-ready` (or `lhc turns report …`) and reading, per form: state, reason, gaps, queue detail. The agent deciding from the same report whether to re-queue. Epic 03's sweep consumes the same surfaces.

**Objective:** Derivation state becomes inspectable and failure becomes recoverable. Each owner's report operation walks its derived forms and joins artifact state with queue mechanical detail — the operational situations (not attempted, retrying, ready, terminal, blocked) distinguishable without the caller touching queue internals. Explicit re-queue returns failed forms to the pipeline through the owning surface; blocked forms refuse requeue with the damage reason; reads degrade, never block.

**Scope — in:**
- Per-owner report operations (`messages.report`, `turns.report`; CLI mirrors): per derived form — form, state, reason, gaps, queue detail (status, attempts, last error, eligibility) for items the queue still holds; filterable to not-ready; the report is where mechanical and semantic state join
- The four-state lifecycle proven: state row exists from queueing (`pending`), failed attempts pre-exhaustion update queue detail only, exit only to `ready` / `failed` / `blocked`
- Explicit re-queue (`messages` and `turns` surfaces): a `failed` form re-queues, runs, and lands `ready` with the failure cleared; this is the public, supported surface for the rebuild act TC-3.3 drove through the raw queue util
- Re-queue idempotency: re-queue of a form with work already queued or in flight is a no-op against the queue (dedupe by owner + kind + sourceRef)
- Blocked semantics: a handler reading damaged source (per Epic 01's corruption definitions) lands the form `blocked` with a reason naming the damage; the drain continues past it; re-queue requests for a `blocked` form are refused with that reason
- Work-item terminal shape for blocked: `failed_terminal`/`failed_terminal` with the form `blocked` distinguishing it from exhaustion (tech design truth table)

**Scope — out:** Automatic repair or sweep scheduling (Epic 03 — this epic ships the mechanism, never invokes it unasked). Mutation-driven clears (Stories 5–6, which are *implicit* re-queues through cascade).

**Dependencies:** Stories 2–3 (real forms in every state to report and repair). Story 0 (damaged-source fixture).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-4.1**: Every derived form this epic lands is readable with exactly one of: `pending`, `ready`, `failed`, `blocked`; failed forms carry a stable reason code.
  - **TC-4.1** (AC-4.1): Land one form per state (ready, failed via exhaustion, pending via unprocessed queue, blocked via damaged fixture) → read-back shows each, failed carries code.
- **AC-4.2**: A form whose work the queue is still retrying reports `pending`; the report joins queue detail (attempts, last error) so retrying-vs-first-wait is distinguishable without a second artifact state.
  - **TC-4.2** (AC-4.2): Double fails first attempt; report mid-retry → `pending` with attempts=1 and last error in queue detail.
- **AC-4.3**: `messages` and `turns` each expose a report operation listing their forms' states, filterable to not-ready, covering message forms, turn forms, and chunk summaries under their owners.
  - **TC-4.3** (AC-4.3): Mixed-state thread → each owner's report lists its forms; not-ready filter returns exactly the failed and pending set.
- **AC-4.4**: Re-queueing a failed form through the owning surface creates a work item that runs and, on success, lands the form `ready` with the failure cleared.
  - **TC-4.4** (AC-4.4): Fail a smoothing past budget, re-queue through `messages`, drain with healthy double → `ready`, no failure residue.
- **AC-4.5**: Re-queueing is idempotent against the queue: asking for work already queued or in flight for the same form is a no-op, not a duplicate item.
  - **TC-4.5** (AC-4.5): Re-queue the same form twice before draining → one work item; batch result and queue read-back show no duplicate.
- **AC-4.6**: A derivation whose handler finds source damage (per Epic 01's corruption definitions) lands `blocked` with a reason naming the damage; drain continues past it; re-queue requests for a `blocked` form are refused with that reason.
  - **TC-4.6** (AC-4.6): Fixture with damaged turn membership under a queued turn derivation → form lands `blocked` naming the damage; drain continued; re-queue refused with same reason.
- **AC-4.7**: Reads degrade, never block: reading a message, turn, or chunk whose forms are not `ready` returns the record with form states; no read operation in this epic errors because derivation is incomplete.
  - **TC-4.7** (AC-4.7): Read messages and turns across a thread with every non-ready state present → full record returned, states attached, no errors.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The pipeline's eyes and hands, and deliberately thin: `report` is **one query** — `derived_form` LEFT JOIN live `work_item` rows for the owner's subjects — and `requeue` is a refusal check plus Story 1's enqueue. No new machinery; the story's value is contract precision. The report is where the mechanical/semantic split (DD-1/DD-2) pays off for callers: artifact state and queue detail join in one row, so retrying-vs-first-wait reads from `pending` + attempts without any queue API. The blocked path completes Flow 1's truth table: a handler returning `{ blocked: true }` lands the form `blocked`/`source_damaged`, the item `failed_terminal` — and `requeue` refuses it with the blocking reason until the source reads clean.

This story also turns TC-3.3's raw-util substitution into supported surface: `requeue` is the public rebuild act, with the no-op-if-live rule (one EXISTS check) making repair sweeps idempotent by construction — Epic 03's sweep calls this exact operation in a loop.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- Both operations are thin compositions over existing substrate (one query; one check + enqueue); the tests are direct read-backs. The hazards are contract-shaped, not structural.

Risk Reminders:
- TC-4.2 inspects *mid-retry* — use `maxItems: 1` to stop between attempts; backoff 0 makes the window deterministic.
- TC-4.6 manufactures corruption below the SDK (Epic 01's two-open-turns fixture pattern) — the SDK must never be able to produce the damage it detects.
- `notReady` filter is exact set equality (failed+pending+blocked), not "contains".
- Owner scoping: `messages.report` must not return turn/chunk forms and vice versa — cross-owner leakage passes single-owner tests silently.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Report queries | `src/domains/messages/internal/forms.ts` + `src/domains/turns/internal/…` (report join per owner) |
| Requeue | owning-surface ops calling work-queue enqueue with EXISTS guard |
| Blocked path | handler outcome `{ blocked }` → form `blocked` write + item row deleted (drain-side, small extension of Story 1's completion) |
| Surfaces | `src/domains/messages/index.ts`, `src/domains/turns/index.ts` (report/requeue exports) |
| CLI | `src/cli/work.ts` (`lhc messages|turns report`, `requeue` — per tech design §Placement, work.ts owns drain/report/requeue commands) |
| Tests | `test/report-repair.test.ts` (NEW) |

#### Design References

- [tech-design.md §Flow 4 (report query, five distinctions, requeue rules)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:231), line 231
- [tech-design.md §Interfaces (FormReportEntry, surfaces, requeue result)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:323), lines 323–346
- [tech-design.md §Interfaces (HandlerOutcome blocked variant, error codes)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:355), lines 355–377
- [tech-design.md DD-1 final-row truth table (blocked row)](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/tech-design.md:63), lines 63–73
- [test-plan.md §report-repair suite](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/02-derivation-pipeline/test-plan.md:67), lines 67–77

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-4.1 | `test/report-repair.test.ts` | multi-state fixture → exact state per row; failed carries stable code |
| TC-4.2 | `test/report-repair.test.ts` | mid-retry row: `pending` + `queue { attempts: 1, lastError }` |
| TC-4.3 | `test/report-repair.test.ts` | owner scoping exact; notReady = exact non-ready set |
| TC-4.4 | `test/report-repair.test.ts` | requeue failed form → ready, reason cleared, source version++; deterministic item id for the current source version inserts without collision (failed row was deleted at exhaustion, DD-1) |
| TC-4.5 | `test/report-repair.test.ts` | double requeue → `{workItemId}` then `{noop}`; one live item |
| TC-4.6 | `test/report-repair.test.ts` | corrupted source → `blocked`/`source_damaged`; drain continued; requeue refused with reason |
| TC-4.7 | `test/report-repair.test.ts` | every non-ready state present → all reads return records+states, zero errors |

Supplemental (non-TC) checks: report/requeue CLI parity — `test/cli-process-work.test.ts` asserts JSON output = SDK shapes; evidence cited under Production Path Proof.

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Degrade-don't-block reads | TC-4.7 | reads return records + states with *every* non-ready state present | Per-state TCs test one state at a time; the all-at-once read is where a join error throws |
| Blocked is not failed | TC-4.6 | requeue refused for blocked but allowed for failed | A single `failed`-style handling passes TC-4.4 and silently retries against damage |
| Report needs no queue API | TC-4.2 | queue detail arrives in the report row itself | An implementation exposing queue internals to callers would pass a weaker assertion |

#### Technical Notes

**Report row shape** (tech design §Interfaces): `FormReportEntry extends DerivedForm` with `queue?: { status: "queued" | "claimed", attempts, lastError?, eligibleAt? }` — `queue` present only while the queue holds a live item. How the situations read: never-attempted (`pending`, no queue detail), retrying (`pending` + queue detail — AC-4.2's distinguishability), ready (`ready`), terminal (`failed` + reason), blocked (`blocked` + reason).

**Re-queue semantics**: clears state to `pending` and enqueues through the owning domain's surface — the same enqueue path intake uses (poke-on-commit included, so background mode processes repairs without further action). Dedupe key: owner + kind + sourceRef + source version against live queue rows. Result is the work item id, or an explicit `already_queued` no-op.

**Blocked truth table row** (tech design §Mechanics): handler found source damage → work item `failed_terminal`/`failed_terminal`, form `blocked` with damage reason. Terminal by necessity — blocked forms refuse requeue, so a live item could only retry pointlessly against damage. Source repair is Epic 01's territory; this epic's contract stops at the refusal.

**Rebuild rule** (consumed from Flow 3): a rebuilt composition composes fresh — former gaps whose dependencies are now `ready` consume the forms and clear; dependencies still not `ready` fall back again and re-record.

**Cross-story debt** (coverage.md): TC-4.4 consumes TC-3.2's gapped-rendering state through the shared fixture builder — don't rebuild the scenario by hand.

#### Anti-Shim Requirements

- `report` is one query — no N+1 per-form lookups, no in-memory state assembly that could drift from rows.
- `requeue`'s no-op check and enqueue commit in one transaction — a check-then-enqueue split reintroduces the duplicate-work race.
- The blocked refusal carries the *form's stored reason* — not a generic "blocked" string.
- TC-4.6's corruption is manufactured by the fixture below the SDK; any SDK pathway that could create it is a bug, not a test convenience.

#### Production Path Proof

- Entrypoint: `lhc messages report|requeue`, `lhc turns report|requeue`; same ops on the SDK surfaces.
- Registration/default path: requeue rides the standard enqueue (poke-on-commit included) — background mode processes repairs with no further call; Epic 03's sweep is a loop over exactly these two surfaces.
- Evidence: CLI parity rows in the process suite; TC-4.4's post-requeue drain in background mode proves the poke fired.

#### Verification

- Targeted: `pnpm vitest run test/report-repair.test.ts`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

| Date | Deviation | Disposition |
|---|---|---|
| 2026-06-10 | Pre-implementation patch: requeue-after-failure relies on DD-1 row deletion (no id collision); report joins *live* items only; failed forms carry final attempts/last-error copied at exhaustion | Spec updated before implementation; build to current text |

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-4.1 through TC-4.7 green
- [ ] Architecture-risk tests green: every-state read-back (TC-4.1), blocked-with-refusal (TC-4.6), degrade-don't-block reads (TC-4.7)
- [ ] Retrying-vs-first-wait distinguishable from the report without a second artifact state (TC-4.2)
- [ ] Both owners' reports cover their full form sets; not-ready filter exact (TC-4.3)
- [ ] CLI mirrors for report and requeue ship with the SDK surfaces (tech design CLI parity rule)
- [ ] Verification gates green
