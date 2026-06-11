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
