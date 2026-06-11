# Epic 02: Derivation Pipeline

**Status:** Validated — two review rounds complete, patches landed; published to stories

This epic defines the complete requirements for the derivation pipeline: the asynchronous half of the thread record, plus the record's sanctioned mutations. It serves as the source of truth for the Tech Lead's design work.

Upstream artifacts: `../00-prd.md` (Feature 2), `../01-tech-arch.md`, `../../01-onboard/02-domain-design.md`. Epic 01 (`../01-thread-record-and-intake/01-epic.md`) built the synchronous half this epic consumes: intake records events, projects messages, stamps turn membership, and queues work items it never runs.

---

## Onboarding Context

Terms this epic uses that Epic 01 established: **event** (ordered source record), **message** (readable projection of an event, holding blocks), **turn** (one exchange: a user prompt and what came back for it, membership stamped at intake and frozen at close), **work item** (a durably queued unit of derivation work: owner, kind, sourceRef, queued in the same transaction as the record that needs it).

New to this epic: a **derived form** is content built from the record by inference — a smoothed prompt, a tool-call or tool-result summary, a turn's composed rendering, a chunk summary. Every derived form carries a **derivation state**. A **chunk** is a container of consecutive closed turns, cut by size policy, summarized for a thread view's lower bands. The **drain** is the operation that runs queued work. A **cascade** is what a mutation does to the derived layer: clear dependent forms, re-queue them.

---

## User Profile

**Primary user:** Agent or developer working inside a thread whose record is accumulating derived forms behind the conversation.
**Context:** Conversation runs through intake (Epic 01); derivation work queues as records land; this epic makes that work run, land as stateful artifacts, and stay repairable — and lets the user fix the record itself when it has something wrong in it.
**Mental model:** "Work I queue runs on its own and lands behind my conversation. Every derived thing tells me whether it exists, succeeded, or failed and why. When the record has a bad message or a dead-end exchange, I edit or delete it, and the forms built from it clear and rebuild behind me. A repaired input never silently rewrites what already landed; rebuilding a gapped artifact is my explicit call."
**Key constraint:** Inference is slow, non-deterministic, and can fail; the conversation never waits on it. Derived gaps degrade reads; they never block them. Only damage to the source record stops anything.

**Harness integrators** get background derivation without integration work: queueing work is what schedules it; no second call exists to forget.

**Operators** (inspection is Epic 04) audit everything this epic lands: every artifact state, failure reason, and queue disposition recorded here must be readable and explainable.

## Feature Overview

After this epic, the work items Epic 01 queues actually run. A worker drains each thread's queue in order, surviving restarts, calling inference through a provider seam, and landing every derived form with an explicit state. Messages get smoothed prompts and tool-activity summaries; closed turns get composed renderings and lower-band projections; closed chunks get detailed and brief summaries. Failed work is visible with a reason and can be re-queued through the owning domain's surface. Users can edit a message, delete a message, or delete a turn; each mutation updates the record synchronously and rebuilds the derived layer behind it.

### Flow Summary

- [Queue Execution](#flow-1-queue-execution) — the drain: claiming, running, ordering, restart survival, scheduling. AC-1.1–1.9
- [Message-Level Derivation](#flow-2-message-level-derivation) — smoothed prompts, tool-call and tool-result summaries, outcome stamping, late-result outcome repair. AC-2.1–2.8
- [Turn Composition and Chunk Formation](#flow-3-turn-composition-and-chunk-formation) — turn renderings, lower-band projections, chunk placement and close, chunk summaries. AC-3.1–3.9
- [Derivation State and Repair](#flow-4-derivation-state-and-repair) — the state vocabulary, failure landing, report and re-queue surfaces. AC-4.1–4.7
- [Message Edit](#flow-5-message-edit) — synchronous record update, cascade clear and re-queue, in-flight ordering. AC-5.1–5.6
- [Message and Turn Delete](#flow-6-message-and-turn-delete) — projection-level removal, prompt-delete refusal, bounded cascade. AC-6.1–6.8

## Scope

### In Scope

- The drain operation: claims queued work one item at a time per thread, in order, runs the owning domain's handler, records the outcome; callable directly (SDK and CLI) and scheduled automatically when work is queued in a long-lived host
- Host lifetime declaration at SDK construction: background mode (queueing schedules processing; catch-up on first touch of a thread) and manual mode (work accumulates until drained explicitly). The drain is the same stateless operation in both modes; background mode means the SDK invokes it on the host's event loop after a queueing commit. Durable queue rows are the only source of truth — in-memory scheduling state is advisory, and a host dying loses nothing but the nudge, which the catch-up drain replaces
- Message-level derivations owned by `messages`: prompt smoothing, tool-call summaries, tool-result summaries, with mechanically stamped outcomes on tool-activity summaries
- Turn-level derivations owned by `turns`: smoothed turn rendering composed from message-level forms, lower-band projection; chunk placement at turn close, chunk close by accumulated-size policy, detailed and brief chunk summaries
- The derivation state vocabulary (`pending`, `ready`, `failed`, `blocked`) carried by every derived form, with stable failure reason codes
- The provider seam: a semantic inference interface injected at SDK construction, with a deterministic test double; provider calls never inside transactions
- Report and repair operations on `messages` and `turns`: list derivation states, re-queue missing or failed work
- Public mutations: `messages` edit, `messages` delete, `turns` delete — closed turns only, synchronous record update, cascade clear-and-regenerate of dependent forms
- Read-back extensions: derived forms and their states readable wherever the underlying record is readable

### Out of Scope

- View assembly and band selection that consume these artifacts (Epic 03)
- The health sweep that walks a whole thread's derivation coverage (Epic 03, thread-view's coverage role)
- Message read/search and inspect reports (Epic 04)
- Block-level delete (whole message plus its blocks is the deletion unit)
- Mutations against the open turn
- Real provider adapters (model choice, prompt text, API clients are adapter concerns; this epic ships the seam and the double)
- Cross-thread worker pooling and global inference budgets (server deployment concern; the queue contract is the seam it plugs into)
- Re-chunking: chunk boundaries never move after close, including under mutation

### Assumptions

| ID | Assumption | Status | Owner | Notes |
|----|------------|--------|-------|-------|
| A1 | Epic 01's work-item contract (owner, kind, sourceRef, status, queuedAt) is stable and extending `kind` is additive | Validated | Tech Lead | `WorkKind` union in `tech-utils/work-queue`; Epic 01 ships `prompt_smoothing`, `tool_result_summary`, `turn_derivation` |
| A2 | Serial-per-thread processing satisfies all ordering needs in this epic; per-artifact parallelism is deferred until a real workload demands it | Validated | Lee | Settled in design talk-through; revisit trigger is head-of-line pain at real scale |
| A3 | One long-lived host process per thread file in live use (PI extension); concurrent drains are possible only via CLI racing the host, handled by the durable claim | Validated | Lee | Server deployment changes the scheduler, not the queue contract |
| A4 | Smoothing and summary quality is an adapter/prompt concern; this epic's tests assert presence, state, and mechanical properties of derived forms, not prose quality | Validated | Lee | Provider double returns deterministic marked output |

---

## Flow 1: Queue Execution

The work items Epic 01 queues sit as durable rows in the thread file. This flow makes them run. A drain claims the oldest queued item, dispatches it to the owning domain's handler by kind, records the outcome, and repeats until the queue is empty. One drain runs per thread at a time; items run one at a time, in queue order. The drain is an ordinary stateless operation: tests and the CLI call it directly; a long-lived host gets it fired automatically by the act of queueing.

1. Work item lands in the queue (Epic 01 intake, or this epic's mutations and repair)
2. In background mode, the commit that landed the item schedules a drain for that thread; in manual mode, nothing runs until a caller invokes drain
3. Drain claims the oldest queued item under a durable claim
4. Drain dispatches the item by kind to the handler registered by the owning domain at SDK construction
5. Handler runs: reads source, calls the provider (outside any transaction), writes the derived form and its state in a short transaction
6. Drain records the item's disposition and claims the next item
7. Queue empty: drain reports what ran and ends; work queued mid-drain is picked up by one further pass

#### Acceptance Criteria

- **AC-1.1**: A drain processes a thread's queued items one at a time, in queue order, and returns a report naming each item run and its disposition.
- **AC-1.2**: Items queued during an in-flight drain are processed before the drain cycle ends; bursts coalesce into at most one further pass rather than one pass per queueing.
- **AC-1.3**: Queued and claimed work survives process exit: after a kill mid-drain, a later drain runs every unfinished item to completion with no item lost and no item run's effects duplicated in the record.
- **AC-1.4**: Two drains cannot process the same thread concurrently: a drain finding the head item under a live claim stops and reports the queue as in-flight; it never skips ahead.
- **AC-1.5**: In background mode, queueing a work item is sufficient to cause its processing; no caller action beyond the operation that queued it.
- **AC-1.6**: In background mode, the first touch of a thread with leftover queued work schedules a catch-up drain.
- **AC-1.7**: In manual mode, queued work accumulates durably and does not run until the drain operation is invoked.
- **AC-1.8**: A work item whose kind has no registered handler lands as failed with a stable reason code; it is never silently skipped and never crashes the drain.
- **AC-1.9**: A handler failure is retried per policy; an item that exhausts its retry budget lands its artifact as failed with the final reason, and the drain continues to the next item.

#### Test Conditions

- **TC-1.1** (AC-1.1): Queue three items across both owners, drain → report names all three in queue order with dispositions; artifacts exist in that order.
- **TC-1.2** (AC-1.2): Start a drain on a slow item (double with latency), queue two more mid-flight → all three processed; scheduling shows one coalesced follow-up pass.
- **TC-1.3** (AC-1.3): Kill the process mid-drain (after item 1 of 3 lands), reopen, drain → items 2 and 3 run; item 1's artifact unchanged; no duplicates.
- **TC-1.4** (AC-1.4): Hold a live claim on the head item from one handle, invoke drain from another → second drain reports in-flight, processes nothing.
- **TC-1.5** (AC-1.5, AC-1.6): Background-mode SDK: send an intake batch, wait on the drain's completion signal, no explicit drain call → artifacts exist. Reopen a thread with pre-loaded queued rows → catch-up runs them.
- **TC-1.6** (AC-1.7): Manual-mode SDK: send the same batch → rows sit queued; invoke drain → artifacts land.
- **TC-1.7** (AC-1.8): Insert a row with an unregistered kind ahead of a valid item → unknown-kind item fails with its code; valid item still runs.
- **TC-1.8** (AC-1.9): Double fails an item twice then succeeds → artifact ready; double fails past the budget → artifact failed with final reason, next item ran.

---

## Flow 2: Message-Level Derivation

Three derived forms build from a message alone, queued when the message lands (Epic 01 queues the first two kinds; this epic adds tool-call summaries and runs all three). A user prompt gets a smoothed form. A tool call gets a summary of what ran, on what, and how it ended. A tool result gets a summarized abbreviation of its content. Tool-activity summaries carry an outcome — succeeded, failed, or unknown — stamped mechanically from the record, never authored by inference.

1. Intake lands a message; `messages` queues the work its kind needs (Epic 01 behavior, extended with `tool_call_summary`)
2. Drain dispatches to the messages handler
3. Handler reads the message (for a tool call: joins its paired result by call id), calls the provider's semantic operation
4. Handler stamps the outcome on tool-activity summaries from `isError` and result presence
5. Smoothed form or summary lands `ready` with its content; provider failure past retry lands it `failed` with reason

#### Acceptance Criteria

- **AC-2.1**: A user prompt message's smoothing work, when run, lands a smoothed form in `ready` state, readable alongside the message.
- **AC-2.2**: A tool-call message's summary work lands a summary naming the tool and describing its arguments, with an outcome field; a `tool_call` event in an intake batch queues a `tool_call_summary` work item the same way Epic 01 queues the other message-level kinds — an additive extension of the Epic 01 intake path that stays deterministic and local.
- **AC-2.3**: A tool-result message's summary work lands a summarized abbreviation in `ready` state; the full result content remains untouched in the record.
- **AC-2.4**: A tool-activity summary's outcome is stamped from the record: result present with `isError: false` → succeeded; `isError: true` → failed; no paired result → unknown. The provider's text never determines the outcome field.
- **AC-2.5**: Message-level derivation reads only the message and its call-id-paired counterpart; no turn or chunk context is an input.
- **AC-2.6**: A provider failure on a message-level item follows Flow 1 retry policy; exhaustion lands the form `failed` with the provider's reason, and the message itself remains fully readable.
- **AC-2.7**: Message kinds with no derivable form (assistant text, thinking, runtime notes) queue no message-level work and carry no derivation state rows.
- **AC-2.8**: A tool result arriving after its call's summary already landed with outcome `unknown` re-queues that summary at intake: the pair is the summary's source, and a source completing follows clear-and-regenerate like any source change. The check is deterministic and local (one indexed lookup by call id); the common case — call and result in one batch — never triggers it, because the summary runs after both landed.

#### Test Conditions

- **TC-2.1** (AC-2.1): Intake a prompt, drain → smoothed form `ready`, content is the double's deterministic output for that input.
- **TC-2.2** (AC-2.2): Intake a `tool_call` event → batch result reports a `tool_call_summary` work item queued, intake result returned before any handler ran; drain → summary `ready`, names the tool, describes the arguments.
- **TC-2.3** (AC-2.3): Intake a tool call and large result, drain → result summary `ready`; full content reads back byte-identical to intake.
- **TC-2.4** (AC-2.4): Three intake variants — result ok, result `isError`, call with no result → outcomes succeeded, failed, unknown; double's text identical across all three, proving text doesn't drive outcome.
- **TC-2.5** (AC-2.5): Double records its inputs → tool-call summary input contains the call and paired result only; no turn data.
- **TC-2.6** (AC-2.6): Double exhausts retries on smoothing → form `failed` with reason; message read-back unaffected.
- **TC-2.7** (AC-2.7): Intake assistant text and a runtime note, drain → no work items for them, no derivation state rows on read-back.
- **TC-2.8** (AC-2.8): Intake a `tool_call` alone, drain (summary lands `unknown`), then intake its `tool_result` in a later batch → summary work re-queued at intake; drain → outcome now `succeeded`, one summary form, no duplicates. Control: call and result in one batch → no re-queue ever fires.

---

## Flow 3: Turn Composition and Chunk Formation

When a turn closes, Epic 01 queues its derivation work. This flow runs it: the turn gets a smoothed rendering composed from its messages' already-derived forms, and a lower-band projection built from that rendering. The turn's tool activity appears in the rendering as composed accounts of what each run of calls did and how it ended, not as separate call listings. The closed turn then joins the open chunk; when accumulated size crosses the close policy, the chunk closes and queues its own summaries.

1. Turn closes at intake (Epic 01); `turn_derivation` work queues
2. Drain dispatches to the turns handler
3. Handler composes the smoothed rendering from message-level forms, with tool runs composed into outcome-explicit accounts; where a form is `pending` or `failed`, the handler falls back to raw or truncated content and records the gap on the landed artifact
4. Handler builds the lower-band projection from the rendering
5. Turn joins the open chunk; if accumulated projected size crosses the close threshold, the chunk closes and queues detailed and brief summary work
6. Chunk summary work runs: detailed and brief summaries land with state

#### Acceptance Criteria

- **AC-3.1**: A closed turn's derivation work lands a smoothed rendering and a lower-band projection, each carrying its own state.
- **AC-3.2**: The rendering composes message-level forms where they are `ready`; where a form is `pending` or `failed`, the rendering uses the message's raw or truncated content and still lands `ready`, recording each fallback as a dependency gap on the artifact — message-form gaps degrade the rendering's inputs, they do not fail the turn.
- **AC-3.3**: A dependency later becoming `ready` does not silently change artifacts that landed with a gap: they stay `ready`, their gap records stand, and the report surfaces them; rebuilding a gapped artifact is an explicit re-queue through its owning surface (Flow 4), never an automatic cascade.
- **AC-3.4**: Tool activity in a rendering appears as composed accounts of runs, each stating its outcome; a run containing a state-changing call never loses its outcome in composition.
- **AC-3.5**: A turn whose lower-band projection succeeded joins the open chunk; placement is recorded with the turn and readable through `turns`.
- **AC-3.6**: A chunk closes when the accumulated projected size of its turns plus the incoming turn's crosses the close target; the incoming turn starts the next chunk when placement would cross it, per the policy's accumulation rule.
- **AC-3.7**: A single turn whose projection alone meets or exceeds the close maximum forms its own chunk immediately.
- **AC-3.8**: Chunk close queues detailed and brief summary work as two work items with independent retry; both land as chunk-level derived forms with independent states. The detailed summary preserves tool-activity receipts (what changed, outcome); the brief summary preserves outcomes only.
- **AC-3.9**: Chunk boundaries are deterministic: replaying the same record through the same policy values produces identical chunk membership.

#### Test Conditions

- **TC-3.1** (AC-3.1): Close a turn with all message forms ready, drain → rendering and projection `ready`, independent state rows.
- **TC-3.2** (AC-3.2): Close a turn where one prompt's smoothing failed → rendering `ready`, contains that message's raw content, other forms composed, gap recorded naming the message and form.
- **TC-3.3** (AC-3.3): Repair the failed smoothing to `ready` after the rendering landed → rendering unchanged, gap still reported; re-queue the rendering through `turns` → rebuilt without the gap, gap record cleared.
- **TC-3.4** (AC-3.4): Turn with a three-call edit run (one `isError`) → rendering's account states the run's outcome; failed call's outcome present.
- **TC-3.5** (AC-3.5): Drain a closed turn → turn read-back shows chunk placement.
- **TC-3.6** (AC-3.6): Turns sized so the third crosses the target → chunk closes holding two; third opens the next chunk.
- **TC-3.7** (AC-3.7): One turn whose projection exceeds the max → own chunk, closed immediately.
- **TC-3.8** (AC-3.8): Close a chunk, drain → detailed and brief summaries `ready`; double-marked content distinguishes them; detailed carries the run receipts fixture content, brief carries outcomes. Fail the brief item past budget with detailed succeeding → detailed `ready`, brief `failed`, independently re-queueable.
- **TC-3.9** (AC-3.9): Replay an identical event stream into a fresh thread → identical chunk membership and boundaries.

---

## Flow 4: Derivation State and Repair

Every derived form carries one of four states: `pending` (expected; queued or in flight), `ready` (usable), `failed` (terminal, with a stable reason code), `blocked` (source damaged; retry cannot help). Retry-in-progress is not a state — an item the queue is still retrying stays `pending`; queue detail is visible through the report operation. A form's state row exists from the moment its work is queued: it lands `pending` with the queueing, failed attempts before exhaustion update queue detail only (attempts, last error), and the state leaves `pending` only for `ready` on success, `failed` on exhaustion, or `blocked` on damaged source. Each owning domain's surface reports its forms' states and re-queues missing or failed work.

1. User or agent asks a domain surface for derivation states (per message, per turn, per chunk, or across the thread)
2. Report returns each form's state, failure reason where present, and queue disposition for pending items
3. User re-queues failed or missing work through the same surface
4. Re-queued work runs as Flow 1 work; success replaces `failed` with `ready`
5. A form whose source is damaged reports `blocked` and is not re-queueable until the source is repaired

#### Acceptance Criteria

- **AC-4.1**: Every derived form this epic lands is readable with exactly one of: `pending`, `ready`, `failed`, `blocked`; failed forms carry a stable reason code.
- **AC-4.2**: A form whose work the queue is still retrying reports `pending`; the report joins queue detail (attempts, last error) so retrying-vs-first-wait is distinguishable without a second artifact state.
- **AC-4.3**: `messages` and `turns` each expose a report operation listing their forms' states, filterable to not-ready, covering message forms, turn forms, and chunk summaries under their owners.
- **AC-4.4**: Re-queueing a failed form through the owning surface creates a work item that runs and, on success, lands the form `ready` with the failure cleared.
- **AC-4.5**: Re-queueing is idempotent against the queue: asking for work already queued or in flight for the same form is a no-op, not a duplicate item.
- **AC-4.6**: A derivation whose handler finds source damage (per Epic 01's corruption definitions) lands `blocked` with a reason naming the damage; drain continues past it; re-queue requests for a `blocked` form are refused with that reason.
- **AC-4.7**: Reads degrade, never block: reading a message, turn, or chunk whose forms are not `ready` returns the record with form states; no read operation in this epic errors because derivation is incomplete.

#### Test Conditions

- **TC-4.1** (AC-4.1): Land one form per state (ready, failed via exhaustion, pending via unprocessed queue, blocked via damaged fixture) → read-back shows each, failed carries code.
- **TC-4.2** (AC-4.2): Double fails first attempt; report mid-retry → `pending` with attempts=1 and last error in queue detail.
- **TC-4.3** (AC-4.3): Mixed-state thread → each owner's report lists its forms; not-ready filter returns exactly the failed and pending set.
- **TC-4.4** (AC-4.4): Fail a smoothing past budget, re-queue through `messages`, drain with healthy double → `ready`, no failure residue.
- **TC-4.5** (AC-4.5): Re-queue the same form twice before draining → one work item; batch result and queue read-back show no duplicate.
- **TC-4.6** (AC-4.6): Fixture with damaged turn membership under a queued turn derivation → form lands `blocked` naming the damage; drain continued; re-queue refused with same reason.
- **TC-4.7** (AC-4.7): Read messages and turns across a thread with every non-ready state present → full record returned, states attached, no errors.

---

## Flow 5: Message Edit

Editing fixes what the record got wrong. The edit targets a message in a closed turn, updates content and blocks synchronously, re-stamps the token estimate, and cascades: every derived form built from the old content clears to `pending` and re-queues in the same transaction. Per-thread ordering guarantees the rebuilt forms land after any in-flight work on the old content; a straggler can never overwrite a post-edit artifact.

1. User edits a message through `messages` (SDK or CLI), addressing it by id
2. Validation: message exists, its turn is closed, new content is shape-valid
3. Synchronous, one transaction: content and blocks updated, token estimate re-stamped, dependent forms cleared to `pending`, replacement work queued
4. Edit returns: what changed, what cleared, what queued
5. Background (Flow 1): re-queued work rebuilds the forms; in-flight old-content work cannot overwrite the rebuilt artifacts

Edit and delete touch canonical and derived state only. An existing generated thread-view is never mutated: the change becomes visible in active context at the next compact/rebuild. (An explicit refresh, if added later, writes a new view — it does not patch one in place.)

#### Acceptance Criteria

- **AC-5.1**: An edit to a message in a closed turn updates content and blocks and re-stamps the token estimate in one synchronous transaction; the edit result reports the content change, cleared forms, and queued work.
- **AC-5.2**: The cascade clears exactly the dependent set: the message's own forms, its turn's rendering and projection, and the containing chunk's summaries; forms of other messages, other turns, and other chunks are untouched.
- **AC-5.3**: After an edit returns, no derivation built from pre-edit content is in `ready` state; every cleared form is `pending` with replacement work queued in the edit's transaction.
- **AC-5.4**: An in-flight derivation started against pre-edit content cannot land over a post-edit rebuild: the post-edit artifact wins regardless of completion order.
- **AC-5.5**: An edit against a message in the open turn is refused with a stable error; an edit against a missing message is refused; refusal changes nothing.
- **AC-5.6**: Edit is available on the SDK and as a CLI command with parity: same validation, same result shape, same cascade.

#### Test Conditions

- **TC-5.1** (AC-5.1): Edit a prompt in a closed turn → content and estimate updated synchronously; result names cleared forms and queued items.
- **TC-5.2** (AC-5.2): Thread with two chunks, edit a message in chunk 1 → cleared set is exactly that message's forms + its turn's two forms + chunk 1's two summaries; chunk 2's forms still `ready`.
- **TC-5.3** (AC-5.3): Edit while forms are `ready` → immediately after return, all dependent forms `pending`, queue holds their work.
- **TC-5.4** (AC-5.4): Slow double processing old-content smoothing; edit mid-flight; let both complete → final form is post-edit content's smoothing.
- **TC-5.5** (AC-5.5): Edit the open turn's prompt → refused, stable code; edit a missing id → refused; read-back unchanged after both.
- **TC-5.6** (AC-5.6): Same edit via SDK and CLI on twin fixtures → identical result shape, identical cascade, identical read-back.

---

## Flow 6: Message and Turn Delete

Delete removes what should not be in the readable record. It is projection-level: the message (or turn) drops from reads and membership while the source events remain in the event log. This is the one sanctioned exception to Epic 01's frozen-membership rule, and an exception for the readable record only — source event membership stays auditable through event read-back, and membership is only ever shrunk, never re-cut. Deleting a message that initiates a turn is refused toward the turn delete: a turn is a prompt and what came back for it, so removing the prompt removes the turn, explicitly, through `turns`. Cascades are bounded by structure: one turn, one chunk; boundaries never move.

1. User deletes a message through `messages`, or a turn through `turns`, by id
2. Validation: target exists, turn closed; message delete additionally checks the target does not initiate a turn
3. Synchronous, one transaction: target dropped from readable record and membership; dependent forms cleared (deleted content's own forms drop with it); rebuild work queued for what remains
4. Result reports what was removed, what cleared, what queued
5. Background: the turn's rendering and projection rebuild without the deleted message (message delete); the chunk's summaries rebuild from remaining turns (both)

As with edit: deletes never mutate an existing generated thread-view — visibility arrives at the next compact/rebuild.

#### Acceptance Criteria

- **AC-6.1**: A deleted message no longer appears in message reads or its turn's membership; its source events remain in the event log, readable through the Epic 01 event read-back.
- **AC-6.2**: A deleted message's own derived forms drop with it; its turn's rendering and projection clear and re-queue; the containing chunk's summaries clear and re-queue; nothing else changes.
- **AC-6.3**: Deleting a message that initiates a turn is refused with an error naming the turn and the turn-delete path; nothing changes.
- **AC-6.4**: Deleting a turn through `turns` drops the turn and all its messages from the readable record and from chunk membership; source events remain.
- **AC-6.5**: A deleted turn's chunk re-derives its summaries from the remaining turns; chunk boundaries do not move; no other chunk's membership or derivations change.
- **AC-6.6**: Deleting every turn in a chunk leaves an empty chunk that contributes nothing to reads; its summary forms are dropped, not failed.
- **AC-6.7**: Deletes against the open turn, missing ids, or already-deleted targets are refused with stable errors; refusal changes nothing; delete of the same id twice is a refusal, not a silent success.
- **AC-6.8**: Message delete and turn delete are available on the SDK and as CLI commands with parity.

#### Test Conditions

- **TC-6.1** (AC-6.1): Delete a tool-result message → message reads and turn membership exclude it; event read-back still returns its events.
- **TC-6.2** (AC-6.2): Delete a message in a two-chunk thread → its forms gone; turn forms and chunk-1 summaries `pending` and queued; chunk 2 untouched.
- **TC-6.3** (AC-6.3): Delete a turn-initiating prompt → refused; error names the turn id and turns-delete; full read-back unchanged.
- **TC-6.4** (AC-6.4): Delete a three-message turn via `turns` → turn and messages gone from reads and chunk membership; events all present.
- **TC-6.5** (AC-6.5): Two-chunk thread, delete a turn from chunk 1, drain → chunk 1 summaries rebuilt from remaining turns (double input proves source set); chunk 2 forms untouched; boundaries identical.
- **TC-6.6** (AC-6.6): Delete both turns of a chunk → chunk empty, summary forms absent, reads skip it without error.
- **TC-6.7** (AC-6.7): Delete open-turn message; delete a bogus id; delete the same message twice → three refusals with stable codes; record identical after each.
- **TC-6.8** (AC-6.8): Same delete via SDK and CLI on twin fixtures → identical results and read-back.

---

## Data Contracts

### Work Item (extended from Epic 01)

Epic 01 ships `WorkItemRecord` with `kind: "prompt_smoothing" | "tool_result_summary" | "turn_derivation"`. This epic extends the kind set additively:

| Kind | Owner | sourceRef | Queued by |
|------|-------|-----------|-----------|
| `prompt_smoothing` | `messages` | messageId | intake (Epic 01), edit cascade, repair |
| `tool_call_summary` | `messages` | messageId | intake (this epic), edit cascade, repair |
| `tool_result_summary` | `messages` | messageId | intake (Epic 01), edit cascade, repair |
| `turn_derivation` | `turns` | turnId | turn close (Epic 01), mutation cascade, repair |
| `chunk_summary_detailed` | `turns` | chunkId | chunk close, mutation cascade, repair |
| `chunk_summary_brief` | `turns` | chunkId | chunk close, mutation cascade, repair |

The two chunk-summary kinds retry, fail, and re-queue independently; repair targets each form by its own kind.

Queue mechanics (this epic adds to the Epic 01 row): claim fields for the durable claim, attempt count, last failure. Exact mechanical fields are tech design; the contract here is that claimed work is visible as claimed, and attempts/last-error are readable through the report operations.

### Derived Form State

Every derived form is readable as:

| Field | Type | Description |
|-------|------|-------------|
| form | string | Which form: `smoothed_prompt`, `tool_call_summary`, `tool_result_summary`, `turn_rendering`, `lower_band_projection`, `chunk_summary_detailed`, `chunk_summary_brief` |
| state | string | `pending` \| `ready` \| `failed` \| `blocked` |
| content | string? | Present when `ready` |
| reason | string? | Stable code, present when `failed` or `blocked` |
| derivedAt | string? | Present when `ready` |
| gaps | list? | For composed forms (`turn_rendering`, projections, chunk summaries): the dependencies that were not `ready` at composition time, each naming the source record and form that fell back. Empty or absent when composition had full inputs. |

A gap is a freshness debt, not a defect: the artifact is `ready` and usable. Gaps make degraded composition visible to the report and to Epic 03's coverage sweep, and they clear when the artifact is explicitly rebuilt.

Lifecycle: the state row is created `pending` when the form's work is first queued, or re-created `pending` when a mutation clears it. Failed attempts before exhaustion update queue detail only. The state moves only to `ready` on success, `failed` on budget exhaustion with the final reason, or `blocked` on source damage.

### Tool-Activity Summary Outcome

| Field | Type | Description |
|-------|------|-------------|
| outcome | string | `succeeded` \| `failed` \| `unknown` — stamped mechanically; never provider-authored |
| text | string | Provider-authored description |

Outcome derivation: paired result with `isError: false` → `succeeded`; `isError: true` → `failed`; no paired result → `unknown`.

### Provider Seam

Semantic interface, one operation per derivation kind, injected at SDK construction:

| Operation | Input | Output |
|-----------|-------|--------|
| smoothPrompt | prompt text | smoothed text |
| summarizeToolCall | tool name, arguments, paired result content and error flag (when present) | descriptive text (outcome stamped by caller) |
| summarizeToolResult | result content, tool name | summarized abbreviation |
| composeTurnRendering | ordered message forms (or raw fallbacks), turn frame | rendering text |
| projectLowerBand | rendering text | projection text |
| summarizeChunkDetailed | member turn projections | detailed summary |
| summarizeChunkBrief | member turn projections | brief summary |

Every operation returns content or a structured failure carrying retryable-or-not. The deterministic test double implements all seven with marked, input-derived output and per-test failure injection.

### Mutation Operations

| Operation | Surface | Input | Validation | Result |
|-----------|---------|-------|------------|--------|
| edit message | `messages` SDK + CLI | message id, new content | exists; turn closed; shape-valid content | updated record summary, cleared forms, queued work |
| delete message | `messages` SDK + CLI | message id | exists; turn closed; not turn-initiating | removed id, cleared forms, queued work |
| delete turn | `turns` SDK + CLI | turn id | exists; closed | removed turn and message ids, cleared forms, queued work |

### Error Codes (added by this epic)

| Code | Class | Produced by |
|------|-------|-------------|
| `turn_open` | caller_error | mutation against the open turn |
| `message_initiates_turn` | caller_error | message delete targeting a turn-initiating prompt |
| `not_found` | caller_error | mutation or re-queue against a missing id (Epic 01 code reused where it exists) |
| `unknown_work_kind` | state_corruption | drain encountering an unregistered kind |
| `provider_failure` | system_error | provider failure surfaced as a form's failed reason |
| `source_damaged` | state_corruption | handler finding corrupt source; the form's blocked reason |

### Cascade Scope

| Mutation | Drops (source gone) | Clears and re-queues |
|----------|--------------------|--------------------|
| edit message | — | message's own forms; turn rendering + projection; containing chunk's detailed + brief |
| delete message | message's own forms | turn rendering + projection; containing chunk's detailed + brief |
| delete turn | turn's forms, rendering, projection; its messages' forms | containing chunk's detailed + brief |

Bounding rule: a turn lives in exactly one chunk; chunk summaries derive only from their own members; therefore no cascade crosses a chunk boundary, and boundaries never move.

---

## Dependencies

Technical:
- Epic 01 complete: intake, projection, turn state machine, work-item queueing, read-back surfaces
- Epic 01's `WorkItemRecord` contract and `tech-utils/work-queue` placement
- Epic 01's error result classes (`caller_error`, `state_corruption`, `system_error`) and code conventions

Process:
- Chunk close policy values (target, max) are config with defaults; tech design pins the defaults

---

## Non-Functional Requirements

- Provider calls never run inside a database transaction and never on the intake hot path.
- Mutations are synchronous and local: record update and cascade clear/queue commit in one transaction before the operation returns.
- A drain's writes happen in short transactions per item; a killed drain leaves no partial artifact visible as `ready`.
- Background scheduling adds no observable latency to intake: the intake result returns before any handler runs.
- All derivation behavior is testable without a network: the provider double is part of the shipped test surface.
- Read-back is ordered and deterministic everywhere new records are added.

---

## Tech Design Questions

1. Mechanical queue schema: claim/lease fields, lease duration, reclaim-after-crash detection, attempt budget, backoff shape.
2. Derived-form storage: columns on owning rows vs. a derivation-row table per domain; how form state reads join queue detail (AC-4.2).
3. The commit-hook mechanism for background scheduling: how enqueue registers the post-commit poke through the operation context, and its behavior under nested transactions.
4. Stale-result handling for AC-5.4: how a straggler handler's write is detected and discarded (resolved in tech design: per-form source version; a background result must not overwrite a derived form if the source changed since the job was queued).
5. Chunk close policy defaults: target and max values for accumulated projected tokens; placement-before-close vs. close-before-placement ordering at the threshold.
6. Drain report shape and the CLI rendering of dispositions.
7. Provider double injection ergonomics: per-test failure scripting without exposing test seams in production assembly.
8. Gap-record storage shape: where dependency gaps live (on the form row, a separate table) and how the report query joins them.

---

## Recommended Story Breakdown

Partitioning follows the pipeline's dependency order: queue execution first (everything stands on it), then derivations by layer (message → turn/chunk), then the state/repair surfaces, then mutations (which exercise everything). Each story lands testable behavior on the previous story's substrate. The mutation stories were considered as one and split: edit proves the cascade machinery; delete adds the projection-level removal semantics and the turns surface on top of a proven cascade.

### Story 0: Foundation
Provider seam interface and deterministic double; derivation state vocabulary as shared types; work-kind registry extension (`tool_call_summary`, `chunk_summary_detailed`, `chunk_summary_brief`); handler-map assembly at SDK construction; queue mechanical fields (claim, attempts) as schema migration on the Epic 01 table; fixtures for multi-state threads. Focused invariant tests on the double's determinism and the handler registry's unknown-kind behavior.

### Story 1: Queue Execution
**Delivers:** Queued work runs — drain operation, ordering, restart survival, both host modes, retry-to-failure.
**Governing idea:** The drain is the only execution path, and it is safe under every interruption.
**Prerequisite:** Story 0
**Boundary / risk notes:** Handlers in this story are minimal doubles landing marked artifacts; real derivation content arrives in Stories 2–3. Claim mechanics here are the cross-process safety Epic 1's seam promised.
**ACs covered:** AC-1.1–1.9

### Story 2: Message-Level Derivation
**Delivers:** Smoothed prompts, tool-call and tool-result summaries with mechanically stamped outcomes.
**Governing idea:** Message forms derive from the message alone, and outcome is record-derived, never model-authored.
**Prerequisite:** Story 1
**Boundary / risk notes:** Adds `tool_call_summary` queueing at intake — touches Epic 01's intake path additively (batch result already reports queued work). The late-result re-queue check (AC-2.8) is the second intake touch: one indexed lookup, deterministic, same transaction.
**ACs covered:** AC-2.1–2.8

### Story 3: Turn Composition and Chunk Formation
**Delivers:** Turn renderings composed from message forms, lower-band projections, chunk placement, size-policy close, chunk summaries.
**Governing idea:** Composition consumes message-level forms and degrades gracefully where they are missing; chunk boundaries are deterministic and final.
**Prerequisite:** Story 2
**Boundary / risk notes:** Replaces the v1 reference's single-turn threshold check with accumulated-size policy; AC-3.9 determinism is the regression guard.
**ACs covered:** AC-3.1–3.9

### Story 4: Derivation State and Repair
**Delivers:** Report operations on both owners, re-queue with idempotency, blocked-on-damage handling, degrade-don't-block reads.
**Governing idea:** Every form's state is visible and every recoverable failure is recoverable through the owning surface.
**Prerequisite:** Story 3 (needs all form kinds existing to report on)
**Boundary / risk notes:** Thread-view's health sweep (Epic 03) consumes these surfaces; this story fixes their shape.
**ACs covered:** AC-4.1–4.7

### Story 5: Message Edit
**Delivers:** The public edit operation with full cascade and in-flight ordering protection.
**Governing idea:** After an edit, derived state is current or pending — never stale; stragglers never win.
**Prerequisite:** Story 3 (the derivation chain to cascade through); Story 4 recommended first — cascade TCs assert form states, and the report surface makes those assertions direct
**Boundary / risk notes:** AC-5.4 stale-write fencing is this epic's architecture-risk centerpiece; the fingerprint lesson's inverse — ordering and clearing, never compare-and-block.
**ACs covered:** AC-5.1–5.6

### Story 6: Message and Turn Delete
**Delivers:** Projection-level delete for messages and turns, prompt-delete refusal, bounded cascade, empty-chunk handling.
**Governing idea:** Delete removes from the readable record what the event log keeps; cascades shrink containers, never re-cut them.
**Prerequisite:** Story 5 (cascade machinery proven by edit)
**Boundary / risk notes:** Event-log retention under delete is the record-never-destroyed invariant's test; deletion is the one sanctioned membership mutation.
**ACs covered:** AC-6.1–6.8

---

## Validation Checklist

- [x] User Profile has all four fields + Feature Overview
- [x] Onboarding context is brief and necessary
- [x] Flow summary entries match flow headings and AC ranges
- [x] Flows cover happy, alternate, and error paths
- [x] Every AC is testable
- [x] Every AC has at least one TC
- [x] TCs cover happy path, edge cases, and errors
- [x] Data contracts specified at system boundaries
- [x] Scope boundaries explicit (in/out/assumptions)
- [x] Story breakdown covers all ACs (AC-1.1–1.9, 2.1–2.8, 3.1–3.9, 4.1–4.7, 5.1–5.6, 6.1–6.8)
- [x] Stories sequence logically
- [x] Validator issues addressed (two epic review rounds; further epic patches landed during tech-design review, including AC-2.8/TC-2.8)
- [x] Validation rounds complete
