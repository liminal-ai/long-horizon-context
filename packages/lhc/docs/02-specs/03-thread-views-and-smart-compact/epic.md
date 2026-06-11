# Epic 03: Thread Views and Smart Compact

**Status:** Draft — pending review

This epic defines the complete requirements for thread views: the assembled working context a harness actually loads. It covers pulling the active view, smart compact, the readiness sweep, tool-result visibility in the live tail, and the two render targets. It serves as the source of truth for the Tech Lead's design work.

Upstream artifacts: `../00-prd.md` (Feature 3), `../01-tech-arch.md`, `../../01-onboard/02-domain-design.md`. Epic 02 (`../02-derivation-pipeline/epic.md`) supplies the derived artifacts views assemble from and the report/requeue surfaces the sweep drives.

---

## Onboarding Context

Epics 01 and 02 built the thread record and its derivation pipeline. Events stream in and project to messages and turns; derivation work runs in the background and lands summarized forms: smoothed prompts, tool-call and tool-result summaries, composed turn renderings, lower-band projections, and chunk summaries in two fidelities. All of that is material. None of it is what a model sees.

This epic builds the consumer: the thread view. A view arranges the thread's history as a fidelity gradient — oldest history as brief chunk summaries, then detailed chunk summaries, then smoothed turns, then the recent tail at full fidelity — sized to a configured budget. The harness pulls the view before each model call and sends it as the prompt. A smart compact is the operation that builds a new view; between compacts the view's banded portion is a stored snapshot that does not change, and the tail grows live from the record.

Two cost realities shape everything here. First, the pull sits on the hot path between a user's action and a model call, so it must be reads and deterministic assembly only — derivation already happened, in Epic 02, off this path. Second, harnesses cache the prompt prefix; every byte that changes above the newest content costs real money. The MVP's per-turn tool-result truncation churned the cache every turn. This design changes the prompt only in planned, batched steps: a compact (rare, explicit), or a tool-result visibility advance (only under budget pressure).

## User Profile

**Primary user:** the agentic harness (PI extension first), calling through the SDK on every model call; and the agent/operator running compacts and checking thread health through the CLI.

**Context:** the harness pulls the view between a user's action and the model call — latency budget is tight and the call must never surprise the caller with inference, network, or a prompt reset. The operator compacts when the thread feels heavy, today by hand with band percentages, and wants named profiles instead of five flags.

**Mental model:** "the record is the truth; the view is what the model sees. A compact rebuilds the view from materials that already exist. Between compacts the view is stable: my edits and repairs land in the record now and show up in the view at the next compact. Nothing changes my prompt behind my back except old tool results aging out in batches."

**Key constraint:** no inference anywhere in this epic. Views assemble stored artifacts; they never create them. When material is missing, the view degrades visibly and reports the gap — it never blocks, never silently omits a span, and never fabricates.

## Feature Overview

Five flows, one surface (`thread-view`):

1. **Pull the active view** — assemble snapshot bands plus live tail into a message array; hot-path safe.
2. **Smart compact** — explicit operation; selects the band arrangement from stored artifacts, renders it, stores it as the active view's snapshot; named profiles; degrades on gaps, never fails on them.
3. **Readiness sweep** — reads derivation states through owning-domain reports, requeues transient failures through owning-domain requeue, returns a receipt; never waits; runs first inside every compact and standalone on demand.
4. **Tool-result visibility** — one boundary marker per thread; tool results behind it render short, ahead of it render full; advances in batches under budget pressure only; never moves backward.
5. **Render targets** — the message array (primary) and a materialized PI-format session file (fallback); same content, two shapes.

### Flow Summary

| Flow | Name | What it proves |
|------|------|----------------|
| 1 | Pull the Active View | Hot-path assembly: snapshot + tail, deterministic, current through last intake |
| 2 | Smart Compact | Explicit rebuild from stored artifacts; profiles; atomic replace; degrade-and-report on gaps |
| 3 | Readiness Sweep | Health walk through domain surfaces; transient requeue; receipt; never waits |
| 4 | Tool-Result Visibility | Batched aging of old tool results; budget-triggered, floor-protected, never backward |
| 5 | Render Targets | Message array and PI session file carry the same view |

## Scope

### In Scope

- The `thread-view` domain surface: pull, compact, sweep, status, materialize — SDK operations with CLI parity
- The active view record: band arrangement, rendered band snapshot, compact point, config used, recorded gaps
- Smart compact with named profiles and explicit-parameter override; band-sum validation with a clear error
- Band rendering from stored Epic 02 artifacts, with per-band degrade ladders and visible gap entries
- The readiness sweep: report-driven, transient-only requeue, receipt; embedded in compact (skippable) and standalone
- The tool-result visibility boundary: position marker, max/target budgets, protected floor, compact reset
- Status read: tail size against threshold, compact recommendation, pending/failed derivation counts
- Message-array render and PI session-file materialization with content parity
- Pull on never-compacted threads (tail-only view from thread start)

### Out of Scope

- Derivation of any artifact (Epic 02 owns all derivation; this epic only reads its outputs)
- Message read/search and thread reports beyond the view status read (Feature 4)
- PI extension wiring: who calls pull/compact/status and when (future PRD; this epic ships the operations)
- Auto-compact policy — any automated trigger lives in the harness; core never compacts on its own
- Refreshing or patching a live view in place (cut by design: edit, then compact again)
- View history, named saved views, draft views — one active view per thread, replaced at compact
- Render formats beyond the message array and PI session file (Codex and others are future renderers)
- Aging old full-fidelity material out of the thread file (future direction)
- Retrieval operations on chunk keys (pull-chunk tool is a future direction; this epic only keeps keys visible)

### Assumptions

- Epic 02's surfaces exist as specced: per-owner `report` and `requeue` operations, `DerivedForm` with state/gaps/metadata, the seven form kinds, `drainSettled`. Epic 02 is in build; its deviation table must be checked before this epic's tech design freezes.
- The Epic 02 patch round in flight (requeue without collision with finished queue rows; update-only completion) lands as directed. The sweep's requeue calls depend on the first.
- Failure reason codes on `DerivedForm` are classifiable as transient or not (Epic 02 stamps stable reason codes; the classification table is this epic's tech design work).
- Per-message token estimates exist on every message (Epic 01), making the boundary's budget sums cheap indexed reads.
- One writing process per thread file (tech arch); the boundary advance and compact both write under that assumption.
- Chunk and turn records carry stable keys (Epic 01/02) that band renders can print.

## Flow 1: Pull the Active View

The harness asks for the current context. The pull reads the active view's stored band snapshot (if a compact has run), reads the tail — messages after the compact point — applies the visibility boundary to tail tool results, and returns the assembled message array. Reads and deterministic formatting only. The pull writes nothing and decides nothing; every judgment call (band membership, visibility, gap handling) was made earlier by a compact, a boundary advance, or Epic 02's derivations.

On a thread that has never compacted, there is no snapshot and no compact point: the entire thread is tail, rendered at full fidelity subject to the boundary. A new thread works from its first event; compacting is an optimization, never a prerequisite.

The snapshot is served byte-identical between compacts. Record mutations (edit, delete) and repairs land in the record immediately but do not touch the stored snapshot; they become visible at the next compact. The one asymmetry is deliberate and contractual: a message deleted *in the tail region* disappears from the next pull (the tail reads the live record, and deleted messages drop from reads), while a message whose content is *inside a band snapshot* keeps its snapshot form until the next compact.

#### Acceptance Criteria

- **AC-1.1**: Pulling the active view performs local reads and deterministic assembly only — no inference, no network, no queue interaction, no writes.
- **AC-1.2**: The pull reflects all intake committed before it: tail messages from every committed batch appear, in record order.
- **AC-1.3**: A never-compacted thread pulls successfully: the view is the full tail from the thread's start, with no band content and no error.
- **AC-1.4**: Between compacts, band content is served byte-identical across pulls. Record edits, deletes, and repair landings after the snapshot do not alter it.
- **AC-1.5**: Tail tool results render by boundary position: at-or-behind the boundary renders the short form, ahead of it renders full content. All non-tool-result content in the tail renders full, always.
- **AC-1.6**: A message deleted in the tail region is absent from subsequent pulls. A deletion whose derived content sits in the band snapshot leaves the snapshot unchanged until the next compact.
- **AC-1.7**: Two pulls with no intervening intake, boundary advance, or compact return byte-identical output.

#### Test Conditions

- **TC-1.1** (AC-1.3, AC-1.2): Intake a short conversation on a fresh thread, never compact, pull → message array carries the full conversation in order; second batch of intake, pull again → new messages appended.
- **TC-1.2** (AC-1.7, AC-1.1): Pull twice with nothing between → byte-identical results; assert no work rows created, no provider double calls recorded (provider fake observes zero calls).
- **TC-1.3** (AC-1.4): Compact, pull, then edit a message whose chunk summary landed in a band; pull again → band bytes unchanged; drain; pull again → still unchanged (rebuilt summary lands in record only).
- **TC-1.4** (AC-1.5): With the boundary mid-tail, pull → tool results behind it are short-form, ahead of it full, prompts and assistant text full everywhere.
- **TC-1.5** (AC-1.6): Delete a tail message, pull → message absent. Delete a message banded in the snapshot, pull → band unchanged; status read shows the record changed (next-compact visibility).

## Flow 2: Smart Compact

Compact is an explicit operation on the thread-view surface. Nothing in core triggers it: the harness, the operator, or a future monitor calls it, and the status read gives any caller the numbers to decide with. The operation takes a named profile or explicit parameters — lower bound and band percentages — validates them, and builds the new view: select which chunks and turns fall into which band (recency gradient: brief for the oldest, then detailed, then smoothed turns, then the full tail), render each band from stored artifacts, and atomically replace the active view — arrangement, rendered snapshot, compact point, config used, and gaps in one transaction. The visibility boundary resets to the compact point. By default the compact runs the readiness sweep (Flow 3) first.

Compact never calls a model. The artifacts either exist (Epic 02 derived them) or they don't — a missing or unusable form renders as the best available stored fallback for that subject, marked degraded, or as an explicit gap entry when nothing usable exists. Gaps are recorded on the view and reported in the receipt; they never fail the compact and never silently omit a span. Band entries print their subject keys (chunk and turn ids) so an agent reading the view can navigate to the record.

#### Acceptance Criteria

- **AC-2.1**: Compact runs only when invoked through the surface (SDK or CLI). No code path in core invokes it internally.
- **AC-2.2**: The operation accepts a named profile or explicit parameters; explicit parameters override profile values; built-in profiles exist and user-defined profiles are configurable.
- **AC-2.3**: Invalid configuration (band percentages not summing to 100, unknown profile, non-positive bound) is rejected with a caller error naming the violation; thread state is unchanged.
- **AC-2.4**: A compacted view lands within the configured size bound with bands proportioned per the configuration, assembled entirely from stored artifacts — no provider calls during compact (sweep requeues background work; the compact itself never waits on or invokes inference).
- **AC-2.5**: Missing or unusable band material degrades: the entry renders the best available stored form for its subject and is marked degraded, or renders as an explicit gap entry when nothing usable exists. The compact records every degraded entry and gap on the view and reports them in the receipt. A compact never fails because material is missing.
- **AC-2.6**: The compact replaces the active view atomically: band arrangement, rendered snapshot, compact point, config used, and gaps land in one transaction; the visibility boundary resets to the compact point in the same transaction. A crash mid-compact leaves the previous view intact and serving.
- **AC-2.7**: The receipt reports what was built: per-band entry counts and rendered sizes, degraded entries and gaps with reasons, sweep results (or that the sweep was skipped), and the config used.
- **AC-2.8**: The status read returns tail size against the configured threshold, a compact recommendation, and pending/failed derivation counts — reads only, callable any time, no side effects.
- **AC-2.9**: Compacting destroys nothing canonical: every prior view's content remains derivable from the record, and the record is untouched by compaction.
- **AC-2.10**: Band entries carry their subject keys visibly in rendered text (chunk ids for chunk bands, turn ids for the smoothed band).

#### Test Conditions

- **TC-2.1** (AC-2.2, AC-2.3, AC-2.7): Compact with a built-in profile → succeeds with that profile's bound and mix recorded in the receipt; compact with percentages summing to 105 → caller error naming the sum; unknown profile → caller error naming it; thread unchanged after both rejections.
- **TC-2.2** (AC-2.4, AC-2.9): On a thread with full derivation coverage, compact → view within bound, band proportions per config, provider fake observes zero calls during the compact; read the record after → identical to before.
- **TC-2.3** (AC-2.5, AC-2.7): On a thread with one failed chunk summary and one pending turn rendering, compact → completes; degraded entries render fallbacks and are marked; receipt lists both with reasons and reports per-band counts; no span silently absent (every turn/chunk in the compacted range accounted for in some form).
- **TC-2.4** (AC-2.6): Crash injection between sweep and view write (test seam) → previous view still serves; rerun compact → new view lands; no partial state.
- **TC-2.5** (AC-2.1, AC-2.8): Status read on a heavy thread → tail tokens, threshold, `compactRecommended: true`, pending/failed counts; assert reads only (no work rows, no state change); intake more, status again → tail grew; no compact occurred without invocation.
- **TC-2.6** (AC-2.10): Compact, pull, inspect band text → chunk keys present for brief/detailed entries, turn keys for smoothed entries.

## Flow 3: Readiness Sweep

The sweep answers "is the material the next compact wants actually ready?" and drives repair without doing any of it. It walks the thread's derived forms through each owning domain's report surface, classifies what it finds, requeues failures whose reason codes classify as transient through each owner's requeue surface, and returns a receipt. It never waits on queued work, never calls a model, and never writes a derived form — thread-view derives nothing.

Failed forms whose reasons classify as non-transient (content-shaped failures that would fail again) and blocked forms (damaged source) are reported, not requeued — the sweep must not become a money-burning retry loop against permanent failures. Pending and queued work is left alone; the queue already owns it. Within one invocation the sweep requeues a given form at most once.

The compact runs the sweep first by default so every compact leaves the thread healthier than it found it; the requeued work heals in the background and the *next* compact picks it up. The sweep is also callable standalone — sweep, drain settled, then compact clean — and skippable inside compact for zero-spend compacts.

#### Acceptance Criteria

- **AC-3.1**: The sweep reads derivation state exclusively through owning-domain report surfaces and requeues exclusively through owning-domain requeue surfaces. It performs no derivation, no model calls, and no direct writes to any derived form.
- **AC-3.2**: The sweep returns without waiting on any queued or requeued work.
- **AC-3.3**: Failed forms with transient-class reason codes are requeued; failed forms with non-transient reasons and blocked forms are reported and not requeued; pending/queued forms are left alone and reported as in-flight.
- **AC-3.4**: A given form is requeued at most once per sweep invocation.
- **AC-3.5**: The receipt lists, by owner and kind: ready, in-flight, requeued, blocked, and non-transient-failed forms, with reasons for the failed and blocked.
- **AC-3.6**: Compact runs the sweep first by default; a skip option suppresses it; the receipt records whether the sweep ran.
- **AC-3.7**: The sweep is callable standalone through SDK and CLI with the same receipt shape.

#### Test Conditions

- **TC-3.1** (AC-3.1, AC-3.2, AC-3.3): Seed a thread with ready, pending, transiently-failed, non-transiently-failed, and blocked forms (fixture-manufactured states); sweep → returns immediately; transient failure requeued (work row exists, form pending), non-transient and blocked untouched and reported, pending untouched; provider fake observes zero calls from the sweep itself.
- **TC-3.2** (AC-3.4): Sweep the same thread twice without draining → second sweep reports the requeued form as in-flight, does not requeue again; exactly one work row exists for it.
- **TC-3.3** (AC-3.5, AC-3.7): Standalone sweep via SDK and via spawned CLI → same receipt shape; counts and reasons match the seeded states.
- **TC-3.4** (AC-3.6, AC-2.7): Compact with default options → receipt includes sweep section; compact with skip → receipt records the skip and no requeues occurred; drain after the default compact → requeued form heals; next compact's view includes the healed form.

## Flow 4: Tool-Result Visibility

Old tool results are the tail's bloat: one agentic turn can dump a hundred thousand tokens of file reads and build output. The MVP re-decided every result's visibility on every message, churning the prompt cache every turn. This design replaces that with one marker per thread and a log-rotation policy: nothing happens until the full-visibility zone outgrows its budget, then one batched advance, then quiet again.

The rule set, complete: tool results at-or-behind the boundary render short (Epic 02's summary when usable, deterministic truncation otherwise); tool results ahead of it render full; nothing else is ever affected — prompts, assistant text, and thinking always render full. After an intake batch commits, one indexed sum measures the full-zone tool tokens; if it exceeds the max budget, the boundary advances oldest-first until the zone is at-or-under the target budget; otherwise nothing happens. The boundary never advances into the protected floor — the most recent stretch of tool output stays full even mid-monster-turn — and never moves backward: a flipped result stays flipped. A compact resets the boundary to the compact point, because the old tail just became bands.

Because the advance is oldest-first, closed turns age out before the open turn's work; the boundary only eats into the open turn when that turn alone exceeds the budget, and even then the floor protects its most recent reads. Budgets — max, target, floor — are configuration with defaults, not architecture.

#### Acceptance Criteria

- **AC-4.1**: Each thread carries one visibility boundary. Tail tool results at-or-behind it render the short form; ahead of it, full. Non-tool-result content is never affected by the boundary.
- **AC-4.2**: The short form is the result's summarized abbreviation when that form is usable, else deterministic truncation. Short-form rendering marks that fuller content exists in the record.
- **AC-4.3**: The boundary advances only when, after an intake batch commits, the full-zone tool-result token sum exceeds the max budget; the advance moves oldest-first until the sum is at-or-under the target. Below max, the boundary does not move and rendered bytes do not change.
- **AC-4.4**: The advance is deterministic and mechanical: token sums from stored per-message estimates, no inference, no provider calls.
- **AC-4.5**: The boundary never advances past the protected floor: the most recent floor's-worth of tool output renders full even when the open turn alone exceeds the max.
- **AC-4.6**: The boundary never moves backward. A result that has rendered short never renders full in a later pull (within the same compact window, and its banded representation thereafter).
- **AC-4.7**: Compact resets the boundary to the compact point.
- **AC-4.8**: Max, target, and floor are configuration with defaults; max > target ≥ floor is validated with a caller error.

#### Test Conditions

- **TC-4.1** (AC-4.3): Intake tool results totaling under max → boundary unmoved; pulls byte-identical across batches. Cross max with one more batch → boundary advances once to target; exactly one batch of results flipped, oldest-first; next under-max batch → no movement.
- **TC-4.2** (AC-4.1, AC-4.2): With flipped results: one with a usable summary renders the summary; one with a failed summary renders deterministic truncation with the marker; an interleaved assistant message renders full.
- **TC-4.3** (AC-4.5): Single monster turn: tool results exceeding max within one open turn → boundary advances into the turn but stops at the floor; newest floor-tokens of tool output render full; the turn's own text messages all render full.
- **TC-4.4** (AC-4.6, AC-4.7): After an advance, intake small batches → flipped results stay flipped (no backward motion); compact → boundary equals compact point; fresh tail renders full.
- **TC-4.5** (AC-4.4, AC-4.8): Advance on a seeded thread is reproducible: same record, same budgets → same boundary trajectory (replay equality); configure max < target → caller error naming the constraint.

## Flow 5: Render Targets

One view, two shapes. The message array is the primary render: ordered role-and-content messages — band content rendered as labeled context messages, then the tail's messages in record order — returned in memory for the harness to hand its model. The materialized file is the fallback for closed harnesses and inspection: the same view written as a PI-format session file. The file is a rendering, not a second source of truth: writing it changes no thread state, and it can be re-materialized from the same view at any time. Format fidelity to PI's actual session format is verified against a real PI session fixture, with the exact format pinned in tech design from PI's source.

#### Acceptance Criteria

- **AC-5.1**: The pull returns the view as an ordered message array: band content as labeled context messages in band order (brief → detailed → smoothed), then tail messages in record order, each with role and content. The mapping is deterministic.
- **AC-5.2**: Materialize writes the active view as a PI-format session file at a caller-supplied path; the write changes no thread state, and repeating it after no thread changes produces an identical file.
- **AC-5.3**: The materialized file and the message-array pull of the same view carry the same content: every band entry and tail message in the array appears in the file, same order, same rendered text, in the target format's encoding.
- **AC-5.4**: Materializing a never-compacted thread works: the file carries the tail-only view.
- **AC-5.5**: Pull and materialize are exposed through SDK and CLI; the CLI materialize prints the written path and the CLI pull emits the message array as JSON.

#### Test Conditions

- **TC-5.1** (AC-5.1): Pull a compacted thread → array opens with band context messages in gradient order, tail follows in record order; roles and labels per the pinned mapping; deterministic across repeated pulls.
- **TC-5.2** (AC-5.2, AC-5.3): Materialize, pull, compare → content parity item-for-item; materialize again with no changes → byte-identical file; thread state hash unchanged by materialization.
- **TC-5.3** (AC-5.4): Materialize a never-compacted thread → valid file, tail-only content, loadable against the format fixture.
- **TC-5.4** (AC-5.5): Spawned CLI: pull → JSON message array on stdout; materialize → path printed, file exists, parses; both exit 0; failure case (no such thread file) exits nonzero with a structured error.
- **TC-5.5** (AC-5.3): Format conformance: materialized file validates against a fixture derived from a real PI session file (structure-level: line shape, required fields, message encoding).

## Data Contracts

Shapes the flows above commit to. Field-level detail beyond this is tech design.

**Active view record** (one per thread, replaced at compact):
- band arrangement: ordered entries per band — subject ref (chunk id or turn id), form kind used, degraded flag
- rendered snapshot: the band text served between compacts
- compact point: the event order where the tail begins
- config used: profile name (if any) and resolved parameters
- gaps: every degraded entry and missing-material gap, with reason codes
- created-at and the record state it was built from

**Visibility boundary** (one per thread): position in the message sequence; budgets (max, target, floor) resolved from config.

**Compact profile**: name, lower bound, band percentages (full/smooth/detailed/brief summing to 100). Built-ins ship; user profiles configurable; explicit params override.

**Compact receipt**: per-band entry counts and token sizes; degraded entries and gaps with reasons; sweep section (receipt or skipped); config used.

**Sweep receipt**: per owner and kind — ready, in-flight, requeued, blocked, non-transient-failed; reasons attached to failures; counts and ids.

**Status read**: tail tokens, configured threshold, compact recommendation, pending and failed derivation counts.

**Pull result**: ordered messages (role, content) plus view metadata (compact point, gaps present, boundary position).

**Materialize request/result**: target path, format (`pi-session` only in this epic), written path.

## Non-Functional Requirements

- **Hot path:** pull and status are local reads with deterministic assembly — no inference, no network, no queue writes. The boundary check after intake is one indexed sum and at most one update.
- **Cache stability:** band snapshot bytes are stable between compacts, unconditionally. Tail changes are append-only except boundary advances, which are batched and budget-triggered. No per-turn churn path exists.
- **No inference in this epic:** compact, sweep, pull, materialize — none invoke a provider. The provider seam appears in tests only to observe that zero calls happen.
- **Durability:** view replacement is atomic; a crash mid-compact serves the previous view. The boundary is durable; restart preserves it.
- **Determinism:** same record, same config → same view, same boundary trajectory, same rendered bytes.
- **Concurrency:** one writing process per thread file (inherited); compact and boundary advance both write under that regime; pulls are read-only and safe alongside.

## Tech Design Questions

1. Boundary advance seam: inside the intake transaction or a post-commit hook (Epic 02's onCommit pattern)? Either preserves the contract; pick for locality.
2. Per-band degrade ladders: exact fallback order per band kind (e.g. brief entry falls back to detailed summary? smoothed turn falls back to raw-composed rendering?). The epic pins degrade-visibly-never-omit; the ladder is design.
3. Profile storage and resolution: SDK config object, config file, or both; precedence rules.
4. PI session file format: pin from PI source; define the fixture for TC-5.5.
5. Band-to-message mapping: roles and labeling for band context messages in the array render.
6. Sweep requeue history: is a cross-invocation cap or backoff needed for forms that fail transiently again and again, or is receipt visibility enough for v1?
7. View snapshot storage: one row or per-band rows; where rendered text lives relative to arrangement entries.
8. Status threshold source: global config default, last-used profile's bound, or explicit config; and the exact "compact recommended" rule.
9. Transient/non-transient classification table for Epic 02's failure reason codes.

## Story Breakdown

Six stories cut on the flow seams. Foundation first; read path before the operations that feed it; the boundary and renders last because both refine what pull serves.

**Story 0 — Foundation.** Migration for view and boundary tables; profile config parsing and validation; the derived-thread fixture (a recorded thread with Epic 02 artifacts in known states — ready, failed-transient, failed-permanent, blocked — to compact against). Foundation criteria FC-0.x; owns no epic ACs.

**Story 1 — Pull and Status on the Record.** The pull path for never-compacted threads: tail assembly, message-array shape, delete filtering, determinism; the status read. Proves the hot path before any view exists. Flow 1 (AC-1.1–1.3, 1.5 partial — boundary at default, 1.7) and AC-2.8.

**Story 2 — Smart Compact.** Profiles and validation, band arrangement from stored artifacts, snapshot render, gaps and degrade ladder, atomic replace, receipt; pull serves snapshot + tail. Flow 2 (less AC-2.8) and AC-1.4, AC-1.6.

**Story 3 — Readiness Sweep.** Standalone and embedded; transient classification; requeue through domain surfaces; receipts. Flow 3. Depends on Epic 02's requeue patch having landed.

**Story 4 — Tool-Result Visibility.** Boundary marker, budget check at intake commit, advance mechanics, floor, reset at compact, short-form rendering in pulls. Flow 4 and the rest of AC-1.5.

**Story 5 — Render Targets.** PI session-file materialization, format fixture, array/file parity, CLI surfaces. Flow 5.

Integration path: Story 1 proves pull on raw threads → Story 2 makes pull serve compacted views → Story 3 makes compacts self-healing → Story 4 makes the tail self-regulating → Story 5 ships the second render. Each story's output is consumed by the next; the fixture from Story 0 carries all of them.

## Traceability

PRD Feature 3 ACs map: AC-3.1 → Flow 1 (AC-1.1, 1.2); AC-3.2 → AC-1.4, AC-1.7 plus the cache NFR; AC-3.3 → AC-2.4; AC-3.4 → AC-2.5; AC-3.5 → AC-4.3 (eligibility is positional — older than where the boundary will land; activation is the batched advance); AC-3.6 → AC-4.2; AC-3.7 → AC-5.3; AC-3.8 → Flow 3 (AC-3.1, 3.3, 3.5).

Epic totals: 37 ACs (7 + 10 + 7 + 8 + 5), 25 TCs (5 + 6 + 4 + 5 + 5). Every AC is covered by at least one TC; every TC names its ACs inline.

## Completeness Self-Check

- [x] Every PRD Feature 3 AC decomposes into epic ACs (mapping above)
- [x] Every flow has ACs and TCs; every AC binary-testable; every TC names its ACs
- [x] Data contracts cover every shape the flows commit to
- [x] Story breakdown covers all ACs (AC-1.1–1.7, 2.1–2.10, 3.1–3.7, 4.1–4.8, 5.1–5.5) with Story 0 owning foundation criteria only
- [x] Out-of-scope names the adjacent features this epic does not build
- [x] Settled design decisions from the planning conversation are encoded: snapshot views (no live mutation visibility), no force-refresh, explicit-call compact with profiles, sweep-never-waits with transient-only requeue, log-rotation boundary, two render targets
- [x] No inference anywhere; provider appears in tests only as an observer
