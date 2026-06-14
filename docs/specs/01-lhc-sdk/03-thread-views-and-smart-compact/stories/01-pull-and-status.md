# Story 1: Pull and Status on the Record

### Summary
<!-- Jira: Summary field -->
The pull path for never-compacted threads — tail assembly, message-array shape, delete filtering, determinism — and the status read.

### Description
<!-- Jira: Description field -->

**User Profile (from epic):** the agentic harness (PI extension first), calling through the SDK on every model call; and the agent/operator running compacts and checking thread health through the CLI.

**Objective:** prove the hot path before any view machinery exists. The array shape pinned here is the contract Stories 2–5 render into.

**Scope in:**
- `thread-view` surface skeleton (structured-result stubs per tech design §Interface Definitions) with `pull` and `status` implemented
- Pull on never-compacted threads: whole record as tail from event 1, tail message-kind rendering per the tech design mapping table, deleted-read filtering, boundary-position rendering (short at-or-behind / full ahead) with the boundary at its seeded default
- Status read, full shape: tail tokens vs threshold, compact recommendation, derivation counts by state (pending/retrying/failed/blocked), view health `null` pre-compact, visibility zone sum vs max

**Scope out:** band content (no compact exists yet — Story 2); boundary movement (Story 4); materialization (Story 5); CLI commands (Story 5 carries the process suite; SDK surface only here).

**Dependencies:** Story 0 (fixture, migration, profiles).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-1.1**: Pulling the active view performs local reads and deterministic assembly only — no inference, no network, no queue interaction, no writes.
  - **TC-1.2** (AC-1.1, AC-1.7): Pull twice with nothing between → byte-identical results; assert no work rows created, no provider double calls recorded (provider fake observes zero calls).
- **AC-1.2**: The pull reflects all intake committed before it: tail messages from every committed batch appear, in record order.
  - **TC-1.1** (AC-1.3, AC-1.2): Intake a short conversation on a fresh thread, never compact, pull → message array carries the full conversation in order; second batch of intake, pull again → new messages appended.
- **AC-1.3**: A never-compacted thread pulls successfully: the view is the full tail from the thread's start, with no band content and no error.
- **AC-1.5** *(default-boundary leg; boundary-active leg lands in Story 4)*: Tail tool results render by boundary position: at-or-behind the boundary renders the short form, ahead of it renders full content. All non-tool-result content in the tail renders full, always.
  - **TC-1.4** (AC-1.5) *(owned here; boundary seeded below-SDK via the sanctioned `test/fixtures/` helper — boundary mechanics owned by Story 4's TC-4.x)*: With the boundary mid-tail, pull → tool results behind it are short-form, ahead of it full, prompts and assistant text full everywhere.
- **AC-1.7**: Two pulls with no intervening intake, boundary advance, or compact return byte-identical output.
- **AC-2.8**: The status read returns: tail size against the configured trigger threshold and a compact recommendation; derivation counts by state (pending, retrying, failed, blocked); the active view's degraded-entry and gap counts; and the visibility zone's token sum against its max — reads only, callable any time, no side effects.
  - **TC-2.5** (AC-2.1, AC-2.8) *(pre-compact legs owned here: status fields, reads-only assertion, no uninvoked compact; view-health legs complete in Story 2)*: Status read on a heavy thread with a degraded active view and a blocked form → tail tokens, threshold, `compactRecommended: true`, derivation counts by state including blocked, view degraded/gap counts, zone sum against max; assert reads only (no work rows, no state change); intake more, status again → tail grew; no compact occurred without invocation.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

First story on the surface: `thread-view/index.ts` is born here with all five operations as structured-result stubs, two of which (`pull`, `status`) go real. The pull this story builds is the *tail-only* path — no view row exists yet, so `snapshot.ts` reads return absent and the whole record renders as tail from event 1. The array shape and tail mapping pinned here are load-bearing for every later story: Story 2 prepends band messages to this exact shape, Story 4 changes which results render short, Story 5 maps it to JSONL.

#### Build Strategy

Types first (`shared/view.ts` landed in Story 0 — consume, don't redefine), then the surface skeleton with all five stubs (Red asserts each returns `{ ok: false, reason: "not implemented: <op>" }`), then Green: `render.ts` tail formatting kind-by-kind against the mapping table, then `pull` assembly, then `status`. The mapping table is seven rows — implement and test them as seven legs, not one blob assertion, so a single kind's drift fails one named test.

#### Implementation Targets

| Target | Work |
|--------|------|
| `src/domains/thread-view/index.ts` | surface skeleton (5 ops, structured-result stubs); `pull` + `status` real |
| `src/domains/thread-view/internal/render.ts` | tail formatting: the 7-kind mapping table, short/full tool-result selection by boundary position, short-form ladder (summary → deterministic truncation) |
| `src/domains/thread-view/internal/snapshot.ts` | read path only: view header + bands, absent ⇒ tail-only signal |
| `src/domains/thread-view/internal/boundary.ts` | position read only (advance is Story 4) |
| `src/sdk.ts` | `threadView` namespace exposing the five ops |

#### Design References

| Topic | Where |
|-------|-------|
| Surface signatures, stub contract | tech-design.md L342–352 |
| `PullResult` / `ViewMessage` / `ViewMeta` / `ViewStatus` | tech-design.md L309–324 |
| Tail message-kind mapping + worked example | tech-design.md L202–229 |
| Pull flow + sequence diagram | tech-design.md L233–249 |
| Short-form ladder (tail tool result row) | tech-design.md L198 |
| Status fields and threshold default | tech-design.md L319–324, L360 |

#### Test Mapping

| TC | Test file | Asserts |
|----|-----------|---------|
| TC-1.1 | `test/view-pull.test.ts` | fresh thread, two intake rounds: full conversation in order, second pull appends; `meta.compactPoint` null |
| TC-1.2 | `view-pull.test.ts` | two pulls, nothing between: byte-identical; zero work rows; provider fake count unchanged |
| TC-1.4 | `view-pull.test.ts` | boundary seeded mid-tail (Story 0 helper): short behind, full ahead, prompts/text full everywhere |
| TC-2.5 (pre-compact legs) | `view-pull.test.ts` | status: tailTokens, threshold, compactRecommended, derivation counts incl. blocked (fixture states), `view: null`, zone sum; reads-only assert; no uninvoked compact |

#### Architecture-Risk Tests

Zero-provider assertion starts here (pull + status legs of the suite-wide assert; completes as later ops land). Supplemental: **mapping legs (×7)** in `view-pull.test.ts` — one leg per message kind matching the table's role + content shape, incl. thinking fencing and tool-call arg rendering (not a TC; the kind-mapping contract every later story renders through). None else owned — but the array shape this story pins is what the restart-snapshot and parity risks later test against.

#### Technical Notes

`status` computes the visibility zone sum with the same deleted-filtered indexed SUM the Story 4 advance will use — build it once in `boundary.ts` now, parameterized by position, so Story 4 consumes it rather than re-deriving it (the design requires the two sums equal; sharing the query makes that structural). `compactRecommended` is `tailTokens > threshold`, nothing smarter — the caller owns policy. Derivation counts come from the owners' report surfaces, not direct `derived_form` reads (must-not-own).

#### Anti-Shim Requirements

The tail-only path must be the real pull code path with snapshot-absent, not a separate "no view yet" branch that Story 2 replaces — if Story 2 has to rewrite Story 1's pull, the shape contract was fiction. TC-1.2's byte-identical assertion must hash the full serialized result, not spot-check fields.

#### Production Path Proof

All reads through the real SDK surface (`createSdk().threadView.pull/status`) against real temp thread files from the Story 0 fixture. No internal-function shortcuts in TC tests (golden/unit tests of `render.ts` legs may call internals; the TC rows go through the surface).

#### Verification

`pnpm verify`; ~9 tests in the default suite.

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-1.1, TC-1.2, TC-1.4 green; TC-2.5 pre-compact legs green; per-kind mapping legs green
- [ ] Zero-provider assertion in place for pull and status (architecture-risk table row 1, partial — completes as later ops land)
- [ ] Array shape documented in `shared/view.ts` comments matching the mapping table exactly
- [ ] `verify` green; no behavior-test weakening (immutability rule)
