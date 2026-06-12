# Epic 04: Inspection

**Status:** Validated — ready for story publishing and tech design
**PRD:** `../00-prd.md` Feature 4
**Tech Arch:** `../01-tech-arch.md`
**Depends on:** Epic 01 (record and read-back), Epic 02 (report/requeue surfaces, mutation cascade), Epic 03 (view storage, status, pull — in build; consumed as spec'd)
**Counts:** 23 ACs / 17 TCs across 5 flows

## Onboarding Context

Read first: `../../01-onboard/02-domain-design.md` §Inspect (the domain's charter: read-only, reads through other domains' surfaces, never writes, repairs, or derives), §Messages (read ownership), §Thread view (the view state this epic reports on). The Epic 02 spec pack defines the report surfaces this epic composes (`messages.report`, `turns.report`, queue detail). The Epic 03 spec pack defines the view storage and status shapes the view-contents report reads.

This is the last epic of the v1 PRD. It adds no tables, no migration, no derivations, and no provider use. It completes the read side of the product and closes with a full-surface lifecycle exercise — the first time every epic's surface runs in one sequence.

## User Profile

**Primary user:** the operator (Lee, mentees later) auditing threads from the CLI; secondarily, agents inside a harness using the same reads mid-task, and — for Flow 5 only — the future PI extension, whose call order the lifecycle exercise rehearses.

**Context:** the operator arrives with a question — what does this thread hold, what did the agent actually see, did the rebuild land, why is this view degraded — and acts on the answer with Feature 2's mutation and requeue operations. Inspect tells them where to point those.

**Mental model:** "inspect describes; it never changes. Every report reads the same state the serving surfaces read, so a report never disagrees with what the agent was actually served. When a report names a subject, I can drill to it — view entry → chunk → turn → message → blocks."

**Key constraint:** read-only, structurally — no inspect operation writes rows, transitions state, or moves the boundary; and no operation in this epic invokes a provider. Reports compose the owning domains' surfaces; inspect owns no rows and reads no other domain's tables directly.

## Feature Overview

Inspection answers questions about a thread without changing it. Four reads: a thread overview (size, composition, derivation state at a glance), a view-contents report (what the active view holds, entry by entry, and what loading it costs), message listing and viewing (the drill-down target every other report points into), and a derivation health report (counts by state, failures with reasons, what repair would touch). Plus the lifecycle exercise: the whole SDK surface driven end-to-end in PI-extension call order.

Everything here reads through the owning domains' surfaces. Inspect owns no rows. The one surface addition outside the inspect domain: `thread-view` gains a read-only `describe` operation exposing the stored view row (arrangement, gaps, config, provenance), because inspect may not read `thread_view` tables directly and no existing operation exposes them.

### Flow Summary

| Flow | Name | Surface |
|------|------|---------|
| 1 | Thread overview | `inspect.overview` |
| 2 | View contents and load cost | `inspect.view` (+ `threadView.describe`) |
| 3 | Message listing and viewing | `messages.list` / `messages.show` |
| 4 | Derivation health and rebuild visibility | `inspect.health` |
| 5 | Full-surface lifecycle exercise | test-only; no new surface |

## Scope

### In Scope

- `inspect` domain surface: `overview`, `view`, `health` — read-only composition over owning domains' reports
- `threadView.describe`: read-only exposure of the stored active view (arrangement entries, gaps, config, source-state provenance)
- Message read completion on the `messages` surface: listing options (bounds, include-deleted) and single-message view with blocks and derivation form states
- CLI: `lhc inspect overview|view|health`, `lhc messages list` (extended), `lhc messages show` — JSON, SDK-parity, process-suite legs
- The lifecycle exercise: create → intake → drain → status → compact → pull → inspect → mutate → rebuild → compact → pull → materialize, through the real SDK, deterministic provider, with replay-equality and instance-teardown legs

### Out of Scope

- **Message search — deferred post-v1.** No search ships in v1. The shape (substring vs FTS, ranking, result granularity) gets decided from real usage after LHC and the PI extension are integrated. The PRD and tech arch carry this deferral (Feature 4 scope, Future Directions, tech-arch deferred list) — backfilled with this epic, so tech design inherits no contradiction.
- Mutations and repair execution (Feature 2 owns; inspect reports on them and previews repair, never executes)
- Any new derivation, any provider call, any real inference (next PRD cycle owns the inference feature)
- The PI extension itself (next PRD)
- Watch/follow modes, streaming output, UI rendering — CLI is JSON one-shots
- Cross-thread reports (single thread scope, same as every epic)

### Assumptions

- Epic 03 is in build. This epic consumes its surfaces as spec'd (`status`, `pull`, view storage shapes). **Handoff gate:** before this epic's tech design freezes, the tech design must check Epic 02's and Epic 03's final deviation tables and update every consumed contract this epic references; the tech design records that check's outcome in its Spec Validation table.
- Epic 03's Story 0 fixture (deterministic provider, ~12 turns, 4 chunks, tool-heavy middle, manufactured failure states) is reusable here and extends with mutation-in-flight states; no new fixture family.
- Schema is terminal at v6 for this PRD: this epic ships **no migration**. If tech design finds a needed index, that is a v7 migration decision to surface, not assume.
- The deleted-message contract is Epic 02's, inherited: deleted messages drop from reads, source events retain the originals. This epic adds the audit option to see them, not a new policy.
- M3/M4 milestone gates close mechanically only: view *quality* cannot be reviewed while bands render deterministic-provider output. The quality halves of those gates transfer to the inference feature's epic. Closeout records this explicitly.

## Flow 1: Thread Overview

One call answers "what is this thread": identity, record size, composition, derivation state, view state, visibility state. The numbers an operator scans before deciding to compact, repair, or drill in.

#### Acceptance Criteria

- **AC-1.1**: `inspect.overview` returns, in one read-only call: thread identity and metadata; event count and order span; message counts (total visible, by kind, deleted counted separately) with visible token sum; turn counts (open, closed); chunk count and closed-but-unchunked turn count; derivation counts by state (pending, retrying, failed, blocked, ready); active-view summary (viewId, createdAt, compactPoint, coveredFrom) or null when never compacted; visibility boundary position and current zone token sum.
- **AC-1.2**: Counts honor the deleted contract: deleted messages appear only in the deleted count — excluded from visible counts, kind breakdowns, and token sums; event counts are unaffected (the record retains everything).
- **AC-1.3**: Every thread shape reports cleanly: fresh-empty, mid-first-turn, never-compacted, compacted, mid-rebuild. Absent pieces report as zeros or null — never omitted fields, never shape errors.
- **AC-1.4**: The overview is a pure read: no work items created, no state changed, repeated calls with no intervening writes return identical results.

#### Test Conditions

- **TC-1.1** (AC-1.1, AC-1.3): Overview shape variants: fresh-empty, mid-first-turn, never-compacted-with-record, compacted, and mid-rebuild all return the full shape with absent pieces as zeros/nulls. The compacted tool-heavy fixture asserts exact expected counts (messages by kind, turns, chunks, derivation states, view summary, boundary).
- **TC-1.2** (AC-1.2): Delete one message; overview → visible count and token sum drop, deleted count = 1, kind breakdown excludes it, event count unchanged.
- **TC-1.3** (AC-1.4): Overview twice with no writes between → deep-equal results; no `work_item` rows created; zero provider calls.

## Flow 2: View Contents and Load Cost

What the agent actually sees, and what it costs. The report reads the stored active view (via `threadView.describe`) and the live tail, entry by entry, with the cost a pull would incur right now.

#### Acceptance Criteria

- **AC-2.1**: The report names the active view — viewId, createdAt, profile name and resolved config, compactPoint, coveredFrom — and lists every band entry in served order (brief → detailed → smooth): subject kind and id, form used, degraded flag; plus every gap with its reason; plus per-band stored token counts. All of it from the stored snapshot, not recomputed.
- **AC-2.2**: The tail section reports message count and token cost *as currently served*: tool results at-or-behind the visibility boundary are costed at their short form, everything else full.
- **AC-2.3**: `loadCost` totals what `pull` serves now — bands plus tail — and a test asserts equality against an actual pull's measured content. The report never disagrees with the surface it describes.
- **AC-2.4**: A never-compacted thread reports view: null with a tail-only loadCost under the same equality contract (the whole record served as tail).
- **AC-2.5**: The report carries the view's recorded source-state provenance (what the compact saw: max event order, form counts) and is a pure read under AC-1.4's contract.

#### Test Conditions

- **TC-2.1** (AC-2.1, AC-2.5): On a compacted fixture with one degraded entry and one gap → report matches the stored arrangement exactly: subjects, forms used, degraded flags, gap reasons, band token counts, config, provenance.
- **TC-2.2** (AC-2.2, AC-2.3): On a boundary-advanced fixture → tail cost counts short forms short; `loadCost.total` equals the token measure of an actual `pull`'s messages using the same estimator.
- **TC-2.3** (AC-2.4): Never-compacted thread → view null, tail spans the record, cost-parity assertion holds.

## Flow 3: Message Listing and Viewing

The drill-down floor. Every report names subjects; this flow is where an operator or agent reads the actual record. Epic 01 shipped `listMessages` bare; this flow completes it and adds the single-message view.

#### Acceptance Criteria

- **AC-3.1**: Listing returns messages in record order with kind, block summary, token estimate, turn membership, and deleted status, with bounded-listing options (range/limit) so large threads list without loading everything.
- **AC-3.2**: `messages.show` returns one message in full: every block with complete content (the record — full tool results, not view-shortened forms), token estimate, turn membership, and the message's derivation forms with their states and metadata (joined from the owner's report, including tool-outcome metadata where present).
- **AC-3.3**: Deleted messages are excluded by default and listable with an explicit include-deleted option, marked deleted — never silently mixed in. `show` on a deleted message returns the record marked deleted (audit is the point), never a not-found.
- **AC-3.4**: CLI parity: `lhc messages list` and `lhc messages show` mirror the SDK operations — same options, same result JSON.

#### Test Conditions

- **TC-3.1** (AC-3.1): List on the fixture → record order, kinds, token estimates, turn ids correct; range and limit options honored exactly.
- **TC-3.2** (AC-3.2): Show on a drained tool-result message → full original content present, forms listed with states, outcome metadata present.
- **TC-3.3** (AC-3.3): Delete one message → default list excludes it; include-deleted lists it marked; show on its id → record with deleted flag.
- **TC-3.4** (AC-3.4): Spawned-CLI list and show on a fixture thread → JSON equals the in-process SDK results (process suite).

## Flow 4: Derivation Health and Rebuild Visibility

The state of every derived form, aggregated to act on. This is also where a mutation's rebuild is watched: cleared forms show pending with queued work, then land ready.

#### Acceptance Criteria

- **AC-4.1**: `inspect.health` aggregates across owners — counts by owner, form kind, and state (ready, pending, retrying, failed, blocked) — assembled entirely from the owners' report surfaces, never from direct `derived_form` or `work_item` reads.
- **AC-4.2**: Failures carry actionable detail: subject id, form kind, reason, attempts, last error — enough to decide and target a requeue without raw SQL.
- **AC-4.3**: The report previews repair: which forms a requeue pass would touch (failed and not blocked), reported and never executed.
- **AC-4.4**: Rebuild visibility: after an edit or delete, health shows the cascade-cleared forms as pending with their queued work visible; after the queue drains, the same forms report ready. Two reads bracket a rebuild.
- **AC-4.5**: Live queue visibility: queued and claimed work counts from the owners' queue detail, consistent with the state counts in the same report.

#### Test Conditions

- **TC-4.1** (AC-4.1, AC-4.5): Fixture with manufactured mixed states (ready, failed-transient, failed-permanent, blocked, pending) → exact counts per owner, kind, and state; queue section consistent with pending counts.
- **TC-4.2** (AC-4.2, AC-4.3): Failed and blocked forms present → failure detail exact (subject, form, reason, attempts); repair preview lists exactly the failed-not-blocked set.
- **TC-4.3** (AC-4.4): Edit a mid-thread message → health shows the cascade's cleared set pending with queued work (exact subjects per the cascade contract); `drainSettled` → same set ready; nothing outside the cascade changed state.

## Flow 5: Full-Surface Lifecycle Exercise

Not a capstone — nothing here proves integration readiness, because no real inference exists yet (that gate belongs to the inference epic). This is the cross-epic seam proof: the first sequence that drives every surface the PI extension will call, in its call order, against one SDK instance. What it catches: contract drift between the three built epics' surfaces, lifecycle ordering bugs, state leaks between operations.

The sequence (PI-extension call order): create thread → intake multi-turn tool-heavy batches → background drain settles → status → compact (profile) → pull → inspect (overview, view, health) → edit + delete → rebuild drains → health confirms → second compact → pull → materialize.

#### Acceptance Criteria

- **AC-5.1**: The full sequence completes through one real SDK configuration with the deterministic provider: every operation returns ok, zero network, zero real-provider calls.
- **AC-5.2**: Checkpoint coherence: post-compact pull serves bands + tail; post-mutation health shows the cleared set pending; post-drain health shows it ready; the second compact's view reflects post-edit content; the second compact receipt's sweep section agrees with the health report taken immediately before it.
- **AC-5.3**: End-to-end determinism: the whole sequence replayed on a fresh thread produces byte-identical pull outputs and materialized files.
- **AC-5.4**: No in-memory dependency: tearing down the SDK instance between phases and continuing on a fresh `createSdk` yields the same end state as the uninterrupted run.
- **AC-5.5**: Operator parity: inspect and view reads driven through the spawned CLI at checkpoints return the same JSON as the in-process SDK calls at those checkpoints.

#### Test Conditions

- **TC-5.1** (AC-5.1, AC-5.2): Scripted lifecycle with checkpoint assertions at each named step; receipt-vs-health cross-check exact.
- **TC-5.2** (AC-5.3): Replay on a fresh thread → hash equality on every pull output and the materialized file.
- **TC-5.3** (AC-5.4): Teardown and recreate the SDK between intake/compact/mutation phases → final pull, health, and materialized file identical to TC-5.1's.
- **TC-5.4** (AC-5.5): Process-suite leg: spawned CLI inspect/view/messages reads at three checkpoints equal the in-process results.

## Data Contracts

Contract-level shapes; field mechanics are tech design's. All operations `Promise<OpResult<...>>` taking `ThreadRef`; all read-only.

**`InspectOverview`**: thread (id, createdAt, metadata); events (count, span); messages (visible count, byKind, deletedCount, visibleTokens); turns (open, closed); chunks (count, unchunkedTurns); derivation (counts by state); view (summary | null); visibility (boundaryPosition, zoneTokens).

**`ViewContentsReport`**: meta (viewId, createdAt, profile, config, compactPoint, coveredFrom) | null; bands — ordered entries (subjectKind, subjectId, formUsed, degraded) and stored tokens per band; gaps (band, subjectId, reason); tail (messageCount, tokens as served); loadCost (bandTokens, tailTokens, total — equals what pull serves); sourceState (provenance as stored).

**`threadView.describe`**: the stored active view row exposed read-only — arrangement, gaps, config, source state, identity/timestamps. Absent view → ok with null (not an error). This is the one surface addition outside inspect; it exists so inspect never touches `thread_view` tables.

**`HealthReport`**: owners[] (owner, kind, counts by state); failures[] (owner, subjectKind, subjectId, form, reason, attempts, lastError?); repairPreview[] (owner, subjectKind, subjectId, form); queue (queued, claimed).

**`MessageDetail`** (show): the full `MessageRecord` (all blocks, full content, token estimate, turnId, deleted flag) plus forms: the owner's report entries for this message.

**List options**: bounded listing (range/limit) and includeDeleted; exact option names are tech design's, the *existence* of bounds and the deleted default are contract.

**CLI**: `lhc inspect overview|view|health`, `lhc messages list [--include-deleted] [bounds]`, `lhc messages show --message-id <id>` — JSON to stdout, SDK-parity, same error classes as every epic (`caller_error`, `state_corruption`, `system_error`).

## Non-Functional Requirements

- **Read-only, structurally**: no inspect operation writes — no work rows, no state transitions, no boundary movement. Asserted, not assumed.
- **No inference in this epic**: no Epic 04 operation invokes a provider; tests may use Epic 02 deterministic-provider setup (draining queued work through the fake) to prepare the derived states under test.
- **Local and fast**: reports compose domain-surface reads over one thread file; no network, no scans proportional to anything but the thread.
- **Consistency with served reality**: where a report describes another surface's output (loadCost vs pull), equality is contractual and tested, not aspirational.

## Tech Design Questions

1. `messages.show` shape: new operation vs `listMessages` option — and whether the forms join reuses `messages.report(messageId)` internally or a shared internal read.
2. `threadView.describe` mapping: stored row → report shape, and whether `describe` and `inspect.view` share assembly code with `status` (they read overlapping state).
3. `loadCost` mechanism: measure by internally invoking `pull` vs summing the same sources pull reads — equality is the contract either way; pick for cost and locality.
4. Health assembly: per-owner report calls composed in inspect vs a shared internal join — must stay on surfaces either way.
5. Lifecycle exercise placement: which legs run in the default suite (TC-5.1 likely) vs the process suite (TC-5.2/5.3/5.4), and where the scripted sequence lives so both legs share it.
6. Listing bounds: offset/limit vs event-order range — pick from CLI ergonomics; both bounded.

## Story Breakdown

No Story 0, decided not defaulted: Story-0s exist to land shared substrate that multiple stories would otherwise each half-build — migrations, new tables, config plumbing, fixture families (Epics 01–03 each had at least one of these). This epic has none. The foundation work that does exist is single-consumer and lands with its consumer: the `inspect` surface skeleton and report shapes belong to Story 2 (shapes live in `shared/` per house pattern, so Story 3 consumes without redefining), `threadView.describe` belongs to Story 3 (its only caller is `inspect.view`), and the fixture extension for mutation-in-flight states belongs to Story 2 (its first consumer). A foundation story here would own no checkable behavior of its own. Four stories.

### Story 1: Message Read Surface

Completes Flow 3: listing options, `show` with forms join, deleted-audit option, CLI extension + parity. Depends only on built code (Epics 01–02). ACs: 3.1–3.4. TCs: 3.1–3.4. ~7 tests.

### Story 2: Inspect Domain — Overview and Health

The `inspect` domain is born: surface skeleton, `overview` and `health` composed from owners' reports, CLI commands, fixture extension for mutation-in-flight states. Flows 1 and 4. ACs: 1.1–1.4, 4.1–4.5. TCs: 1.1–1.3, 4.1–4.3. ~9 tests.

### Story 3: View-Contents Report

`threadView.describe` (read-only surface addition) + `inspect.view` with the loadCost-equals-pull contract. Flow 2. Depends on Epic 03 Stories 0–2 landed (view storage exists). ACs: 2.1–2.5. TCs: 2.1–2.3. ~6 tests.

### Story 4: Lifecycle Exercise

The scripted full-surface sequence with checkpoint, replay, teardown, and CLI-parity legs. Flow 5. Depends on Stories 1–3 here plus Epic 03 complete. ACs: 5.1–5.5. TCs: 5.1–5.4. ~6 tests.

**Sequencing**: Story 1 can start immediately (no Epic 03 dependency). Story 2 next (fixture states; health consumes built reports). Story 3 waits on Epic 03's view storage stories. Story 4 last. If Epic 03's build slips, Stories 1–2 proceed; 3–4 wait.

## Traceability

| PRD | This epic |
|-----|-----------|
| AC-4.1 (view contents and cost) | Flow 2 |
| AC-4.2 (messages listable/viewable) | Flow 3 |
| PRD AC-4.3 (search) | **Deferred post-v1** — Out of Scope; PRD and tech arch already backfilled |
| AC-4.4 (rebuild visibility) | Flow 4 (AC-4.4) |
| AC-4.5 (derivation health) | Flow 4 (AC-4.1–4.3, 4.5) |
| Feature 4 scope: "thread size and composition, turn and chunk counts" | Flow 1 |
| M4 "SDK exercised end-to-end at its integration points" | Flow 5 (mechanical half; quality half transfers to the inference epic) |

### AC → TC Table

| AC | TCs |
|----|-----|
| AC-1.1 | TC-1.1 |
| AC-1.2 | TC-1.2 |
| AC-1.3 | TC-1.1 |
| AC-1.4 | TC-1.3 |
| AC-2.1 | TC-2.1 |
| AC-2.2 | TC-2.2 |
| AC-2.3 | TC-2.2 |
| AC-2.4 | TC-2.3 |
| AC-2.5 | TC-2.1 |
| AC-3.1 | TC-3.1 |
| AC-3.2 | TC-3.2 |
| AC-3.3 | TC-3.3 |
| AC-3.4 | TC-3.4 |
| AC-4.1 | TC-4.1 |
| AC-4.2 | TC-4.2 |
| AC-4.3 | TC-4.2 |
| AC-4.4 | TC-4.3 |
| AC-4.5 | TC-4.1 |
| AC-5.1 | TC-5.1 |
| AC-5.2 | TC-5.1 |
| AC-5.3 | TC-5.2 |
| AC-5.4 | TC-5.3 |
| AC-5.5 | TC-5.4 |

## Completeness Self-Check

- [ ] Every PRD Feature 4 AC mapped or explicitly deferred (PRD AC-4.3 search deferred, named, with PRD/tech-arch deferral recorded)
- [ ] Every flow has ACs and TCs; every AC covered by at least one TC (23/23 per table)
- [ ] No TC references an undefined AC
- [ ] Read-only contract stated per flow and as NFR
- [ ] No new storage, no migration — stated as assumption
- [ ] Epic 03 in-build dependency named with deviation-table check before tech design freeze
- [ ] Lifecycle exercise scoped as seam proof, not integration gate; M3/M4 quality-half transfer recorded
- [ ] No Epic 04 operation invokes inference; provider use only in Epic 02 test setup wording carried
