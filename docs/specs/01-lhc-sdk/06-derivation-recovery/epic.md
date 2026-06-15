# Epic 06: Derivation Recovery and Observability

**Status:** Draft for review
**PRD:** `../00-prd.md` — Feature 6 (backfill pending)
**Tech Arch:** `../01-tech-arch.md`
**Domain model:** `../../onboard/01-core-concepts.md`, `../../onboard/02-domain-design.md`
**Source notes:** `../notes/derivation-cascade-decisions.md`

---

## Onboarding Context

LHC keeps the full history of an agentic conversation as a durable record and builds summarized working views from it. Epics 01–05 built the record, the work queue, the derivation pipeline, thread views and smart compact, inspection, and real inference. This epic reworks how derivation behaves when things are not ready or go wrong. It adds no new pipeline; it makes the existing one robust, recoverable, and observable.

**Vocabulary (this epic settles it).** A **derivation** is the stored result of producing a representation of existing content — a smoothed prompt, a tool-result summary, a turn rendering, a chunk summary. To **derive** is the act. A **derivation type** names which one. A derivation carries a **state**. The code's current `form` / `derived_form` / `FormKind` / `DerivedFormState` names are retired in favor of `derivation` / derivation type / state; the rename is in scope here (Story 0). "Form" does not appear in new work.

**The six derivation types** (after this epic):

| Derivation type | Level | Produced by | Feeds |
|---|---|---|---|
| `smoothed_prompt` | message | inference + deterministic floor | turn rendering, smooth/lower bands |
| `tool_result_summary` | message | inference | smooth-band tool rendering |
| `turn_rendering` | turn | composition | smooth band |
| `lower_band_projection` | turn | composition | detailed-chunk input; fallback under turn rendering |
| `chunk_summary_detailed` | chunk | inference | detailed band |
| `chunk_summary_brief` | chunk | inference | brief band |

`tool_call_summary` is **removed** (see Scope). Tool-call arguments render as-is; only tool *results* are summarized.

**The four states.** `pending` (expected; queued or in flight), `ready` (usable), `failed` (the async attempt gave up), `blocked` (the source itself is damaged; retrying cannot help). At a consumption point, `pending` and `failed` are handled identically: the field is treated as not-usable and recovery runs.

**The floor-and-recovery contract (the spine of this epic).** Every derivation has a **deterministic floor** — a representation producible with no model call. At each point a derivation is consumed (turn construction, smart compact), a not-ready derivation triggers an in-place recovery cascade:

> attempt the real derivation → fall to its deterministic floor → fall to the original source.
> A tool result never falls below its truncation floor. The result always lands usable; the consuming operation never blocks and never omits a span. Every fallback **event** is **logged**. Only damage to the canonical **source** blocks; a missing or failed derivation degrades and continues.

Two things stay clean, one thing stays honest. The **canonical subject** (the message/turn/chunk content) carries no degraded/fallback marker. A **recovered `ready` output** carries no marker either — how it got there (full, floored, or original) is not a distinction the consumer branches on, and there is no "degraded" state. But the **derivation record itself keeps its real state and reason**: a `failed` or `blocked` derivation stays `failed`/`blocked` with its failure reason, inspectable through health (Epic 04). Fallback *events* are log-only; derivation *state* is not — the two are different channels. There is no extra field on the subject or the ready output.

---

## User Profile

**Primary User:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Context:** Derivations run asynchronously behind the conversation. By the time a turn closes or a smart compact runs, some derivations may be pending, failed, or built from damaged inputs. Today that produces holes, stalls, or silently wrong views.

**Mental Model:** "My thread always renders something usable. If a summary isn't ready, the system falls back to a cruder-but-honest rendering and tells me it did — it never blocks my work or quietly drops history. Only real source corruption stops me, and it says so."

**Key Constraint:** Three rules. **Intake and context-serving** (recording events, the context hook returning the active view) make **no provider calls at all** — they read or assemble already-derived material. **Smart compact** makes **no provider calls either** — it assembles stored artifacts, falling back to deterministic stored-member concatenation when a summary is not ready; healing happens through the separate readiness sweep and background drain. Only **turn-close recovery** may make a bounded provider call to re-derive a not-ready component — and never inside a DB write transaction, with deterministic floors always available so recovery never depends on a provider succeeding.

---

## Feature Overview

After this epic, every derivation has a deterministic floor and a uniform recovery cascade, so a not-ready or failed derivation degrades to an honest cruder rendering instead of blocking the operation or leaving a hole. Smart compact and turn construction always produce a usable result; only canonical source corruption stops them. Every fallback is recorded through a new logging surface so operators can see, query, and act on derivation health without runtime noise. Prompt smoothing gains a deterministic cleaning floor and a length gate; tool results split cleanly into deterministic full-band truncation and inference smooth-band summaries with per-tool guidance; the dead `tool_call_summary` type is removed; and runtime model/effort changes are recorded as typed blocks instead of opaque notes. The codebase is renamed from `form` to `derivation` throughout.

This epic builds the **mechanism and first-pass prompts only**. Tuning prompts and model selection against real corpora is the next epic.

### Flow Summary

- [Prompt Smoothing](#1-prompt-smoothing) — deterministic floor + length-gated inference. AC: 1.1–1.7
- [Tool-Result Rendering](#2-tool-result-rendering) — full-band truncation vs smooth-band summary, tiered, per-tool. AC: 2.1–2.8
- [Turn Construction and the Recovery Cascade](#3-turn-construction-and-the-recovery-cascade) — compose a turn, recover each component. AC: 3.1–3.8
- [Chunk Derivation and Compact Recovery](#4-chunk-derivation-and-compact-recovery) — chunk summaries; stored-member concat fallback at compact (no model); corruption blocks. AC: 4.1–4.8
- [Derivation Logging](#5-derivation-logging) — the surface, two-channel principle, actionable-only. AC: 5.1–5.5
- [Runtime-Change Typing](#6-runtime-change-typing) — typed model/effort change blocks. AC: 6.1–6.3

---

## Scope

### In Scope

This epic hardens and reorganizes derivation behavior that Epics 02/03/05 already built:

- Rename `form` / `derived_form` / `FormKind` / `DerivedFormState` to `derivation` / derivation type / state across code and schema.
- A deterministic floor for every derivation, and a uniform recovery cascade applied at the two consumption points (turn construction, smart compact).
- Prompt smoothing as a two-stage operation: always-on deterministic cleaning plus length-gated inference; fenced-code preserved by prompt instruction.
- Tool-result rendering split: deterministic truncation for the full band (hot-path), inference summary for the smooth band (cold-path), with tiered targets and per-tool guidance scaffolding.
- Removal of the `tool_call_summary` derivation type.
- A logging surface (new cross-cutting technical capability): info/warning/error, durably stored, one externally exposed write method, two-channel separation of record vs diagnostics.
- Typed runtime-change blocks (`model_change`, `thinking_level_change`) replacing flattened `runtime_note` text for those events.

### Out of Scope

- **Tuning** prompts, model selection, thinking settings, tiered numbers, or per-tool guidance against real corpora — that is the next (interactive) epic. This epic ships working mechanism with first-pass prompts and defaults.
- Wire-API band representation changes, smooth-band user/assistant message pairs, Claude post-compact cost optimization (the "subsequent passes" set — see notes).
- Tool-harness dial-in and the permissive tool-call repair layer.
- pi-lhc consumption of typed runtime blocks for session restoration (the consumer side lives in the pi-lhc PRD; this epic only records and projects them).
- Buffer-surfacing UX mechanics in the harness (this epic pins the LHC logging boundary; how the extension renders log entries to a user buffer is pi-lhc).

### Assumptions

| ID | Assumption | Status | Owner | Notes |
|----|------------|--------|-------|-------|
| A1 | Epics 02/03/05 derivation pipeline, states, work queue, and deterministic provider are green and stable | Validated | this session | Confirmed against current `lhc` |
| A2 | A deterministic cleaning floor (whitespace, trivial casing) is achievable as a pure no-model function | Unvalidated | Tech Lead | Confirm by tech design |
| A3 | `lower_band_projection` already exists as turn-derivation's second output and the chunk-detailed input | Unvalidated | Tech Lead | Confirm-and-document pass; likely no new work |
| A4 | The full-band truncation behavior from Epic 03 (visibility boundary) is the tool-result deterministic floor and needs no reimplementation | Unvalidated | Tech Lead | Reuse, don't rebuild |
| A5 | The single-worker-per-thread ordering from Epic 02 holds, so recovery and derivation cannot race on one thread | Validated | Epic 02 | Cascade leans on it |

---

## Flows & Requirements

### 1. Prompt Smoothing

A user prompt is smoothed into a cleaner, attenuated rendering for the compressed bands while its original stays in the record. Smoothing has two stages: a deterministic cleaning pass that always runs with no model call, and an inference pass that runs only when the prompt is small enough to be worth the tokens. The deterministic stage is a real stage in the normal path, not only a fallback — it is also the floor the recovery cascade uses.

1. A user prompt lands and its smoothing derivation is queued
2. The worker applies deterministic cleaning (whitespace, trivial casing) with no model call
3. If the prompt is under the length cap, the worker applies inference smoothing on top
4. The derivation lands `ready` with whichever result was produced

#### Acceptance Criteria

**AC-1.1:** Deterministic cleaning is applied to every user prompt regardless of length, using no model call (whitespace normalization, trivial casing).

- **TC-1.1a:** Cleaning applied, no provider call
  - Given: a user prompt with irregular whitespace
  - When: smoothing derives
  - Then: the result has normalized whitespace and the provider was not invoked for the deterministic stage
- **TC-1.1b:** Over-cap prompt still cleaned
  - Given: a prompt above the length cap
  - When: smoothing derives
  - Then: deterministic cleaning is still applied (length only gates inference, not cleaning)

**AC-1.2:** Inference smoothing is applied only when the prompt is under the configured length cap; over the cap, the deterministic result is the smoothed derivation.

- **TC-1.2a:** Under cap → inference runs
  - Given: a prompt under the cap
  - When: smoothing derives
  - Then: inference is invoked and its output is stored
- **TC-1.2b:** Over cap → inference skipped
  - Given: a prompt over the cap
  - When: smoothing derives
  - Then: inference is not invoked and the deterministic result is stored

**AC-1.3:** Fenced code in a prompt is preserved verbatim through inference smoothing (governed by prompt instruction, not by segmenting or regex protection).

- **TC-1.3a:** Fenced code unchanged
  - Given: a prompt containing a fenced code block and surrounding prose with typos
  - When: inference smoothing runs
  - Then: the fenced block is unchanged and the prose is cleaned

**AC-1.4:** A smoothed prompt is `ready` and usable whether produced by deterministic-only (over cap) or deterministic+inference (under cap). No separate "skipped" state exists.

- **TC-1.4a:** Deterministic-only lands ready
  - Given: an over-cap prompt
  - When: smoothing completes
  - Then: state is `ready` (not "skipped" or "degraded")
- **TC-1.4b:** Full smoothing lands ready
  - Given: an under-cap prompt, inference succeeds
  - When: smoothing completes
  - Then: state is `ready`

**AC-1.5:** A retryable inference failure leaves the derivation `pending` and requeued; the deterministic floor remains available to consumers in the interim.

- **TC-1.5a:** Retryable failure stays pending
  - Given: inference returns a retryable error within budget
  - When: the worker handles it
  - Then: state is `pending` and the item is requeued
- **TC-1.5b:** Floor available while pending
  - Given: a smoothing derivation is `pending`
  - When: a consumer needs the smoothed prompt
  - Then: the deterministic floor (or original) is used via the cascade (Flow 3), not a block

**AC-1.6:** Smoothing never invokes a provider on the hot path; it runs only as queued work off the hot path.

- **TC-1.6a:** No provider call during intake
  - Given: a user prompt is intaken
  - When: intake completes
  - Then: no provider call occurred during intake; only a smoothing work item was queued

**AC-1.7:** When the background worker's under-cap inference terminally fails (retry budget exhausted, non-retryable error), the derivation lands `failed` with its reason — the worker records the honest failure, it does not floor-and-mark-ready (flooring is a consumption-time act, AC-3.8). The deterministic floor is still available to consumers in the interim, and construction later resolves the `failed` derivation to `ready` per Flow 3.

- **TC-1.7a:** Terminal failure lands failed with reason
  - Given: under-cap inference exhausts its retry budget
  - When: the worker gives up
  - Then: state is `failed` with a reason recorded on the derivation (not `ready`, not silently floored)
- **TC-1.7b:** Floor still consumable
  - Given: a `failed` smoothing derivation
  - When: a consumer needs the smoothed prompt
  - Then: the deterministic floor is used via the cascade (Flow 3), not a block

### 2. Tool-Result Rendering

A tool result is preserved in full in the record and rendered in shorter renderings for the views. The full-fidelity band shortens aged tool results by **deterministic truncation** (hot-path safe, no model). The smooth band uses an **inference summary** (`tool_result_summary`, cold-path). The summary targets a size tiered by the result's token count. Per-tool guidance shapes the summary because tool outputs differ in shape and in which parts matter. Tool *calls* (arguments) render as-is; they are not summarized.

#### Acceptance Criteria

**AC-2.1:** Full-band tool-result shortening uses deterministic truncation with no model call (the Epic 03 visibility-boundary floor).

- **TC-2.1a:** Truncation is deterministic
  - Given: a large tool result aged past the visibility boundary
  - When: the full band renders it
  - Then: it is truncated deterministically with no provider call, and identical input yields identical output

**AC-2.2:** Smooth-band tool-result rendering uses an inference `tool_result_summary`, produced off the hot path.

- **TC-2.2a:** Summary is inference, off hot path
  - Given: a tool result in a turn assigned to the smooth band
  - When: its summary derives
  - Then: it is produced by a queued inference work item, not on the hot path

**AC-2.3:** The summary targets a size tiered by the result's token count (first-pass tiers; tunable in the next epic), and passes a result through unchanged when it is already under target.

- **TC-2.3a:** Small result tier
  - Given: a tool result under ~1000 tokens
  - When: it is summarized
  - Then: the target compression follows the small-result tier
- **TC-2.3b:** Mid result tier
  - Given: a tool result between ~1000 and ~5000 tokens
  - When: it is summarized
  - Then: the target follows the mid tier
- **TC-2.3c:** Large result → truncate
  - Given: a tool result beyond ~5000 tokens
  - When: it is rendered for the smooth band
  - Then: it is truncated rather than inference-summarized

**AC-2.4:** Summary generation applies per-tool guidance keyed on the tool, preserving the outcome/status and the elements that matter for that tool type.

- **TC-2.4a:** Per-tool guidance applied
  - Given: tool results from two different tools
  - When: each is summarized
  - Then: the prompt includes guidance keyed to each tool, and outcome/status is preserved in both
- **TC-2.4b:** Outcome preserved
  - Given: a failed tool result
  - When: it is summarized
  - Then: the summary states the failure outcome

**AC-2.5:** The `tool_call_summary` derivation type is removed; tool-call arguments render as-is wherever a tool call appears.

- **TC-2.5a:** No tool_call_summary derivation
  - Given: a turn containing a tool call
  - When: derivations are enumerated
  - Then: no `tool_call_summary` derivation exists or is queued
- **TC-2.5b:** Call args render as-is
  - Given: a tool call in a rendered turn
  - When: the turn is composed
  - Then: the call's arguments are present as recorded (no summarization step)

**AC-2.6:** The full tool result is always retained in the record regardless of how it is rendered in any band.

- **TC-2.6a:** Full result preserved
  - Given: a tool result that is truncated in the full band and summarized in the smooth band
  - When: the record is read directly
  - Then: the original full tool result is intact

**AC-2.7:** A tool result beyond the large-tier threshold satisfies its `tool_result_summary` by deterministic truncation and lands `ready` without inference (no inference work item is created for it).

- **TC-2.7a:** Large result ready via truncation, no inference
  - Given: a tool result beyond ~5000 tokens
  - When: its smooth-band rendering is produced
  - Then: the `tool_result_summary` is the deterministic truncation, state is `ready`, and no inference work item was created

**AC-2.8:** When the background worker's in-threshold tool-result inference terminally fails, the derivation lands `failed` with its reason — the worker records the honest failure rather than flooring it. Consumers recover to the truncation floor and resolve it to `ready` at construction (Flow 3).

- **TC-2.8a:** Terminal summary failure lands failed
  - Given: tool-result inference exhausts its retry budget for an in-threshold result
  - When: the worker gives up
  - Then: state is `failed` with a reason; the truncation floor is used by consumers via the cascade

### 3. Turn Construction and the Recovery Cascade

A turn is constructed by composing its components into the turn renderings. Each derived component resolves through the recovery cascade: if its derivation is `ready`, use it; if not (`pending` or `failed`, handled the same), attempt recovery, fall to the deterministic floor, then to the original. The construction never blocks and never omits a span. Components that are not derived — assistant text, thinking, runtime-change blocks — are placed verbatim. Every fallback is logged (Flow 5). This is the contract from Onboarding Context, instantiated at the turn level.

1. A turn closes and its construction runs (off the hot path)
2. For each component, resolve the derivation through the cascade
3. Compose the rendered turn from resolved components
4. Log any component that fell back

#### Acceptance Criteria

**AC-3.1:** When a component's derivation is `ready`, turn construction uses it directly.

- **TC-3.1a:** Ready component used
  - Given: a turn whose smoothed prompt is `ready`
  - When: the turn is constructed
  - Then: the smoothed prompt is used as-is

**AC-3.2:** When a component's derivation is not ready (`pending` or `failed`, treated identically), construction attempts recovery and then falls through deterministic floor → original, always landing a usable component.

- **TC-3.2a:** Pending recovers to floor
  - Given: a turn whose smoothed prompt is `pending` and re-derivation does not complete
  - When: the turn is constructed
  - Then: the deterministic-cleaned prompt is used and the turn still constructs
- **TC-3.2b:** Failed handled like pending
  - Given: a turn whose smoothed prompt is `failed`
  - When: the turn is constructed
  - Then: the same cascade runs (no separate failed handling) and a usable component results
- **TC-3.2c:** Floor unavailable → original
  - Given: a component whose deterministic floor cannot be produced
  - When: the turn is constructed
  - Then: the original source content is used

**AC-3.3:** A tool-result component never falls below its truncation floor during construction; it is never inserted raw/full as a fallback.

- **TC-3.3a:** Tool result floored to truncation
  - Given: a turn whose `tool_result_summary` is not ready
  - When: the turn is constructed
  - Then: the deterministic truncation is used, not the full raw result

**AC-3.4:** Non-derived components (assistant text, assistant thinking, runtime-change blocks) are placed verbatim in the constructed turn.

- **TC-3.4a:** Verbatim placement
  - Given: a turn with assistant text, thinking, and a runtime-change block
  - When: the turn is constructed
  - Then: those components appear unchanged and in order

**AC-3.5:** Turn construction never blocks on a derivation and never omits a component span; a not-ready derivation degrades, it does not stall or hole the turn.

- **TC-3.5a:** No block, no hole
  - Given: a turn with multiple not-ready derivations
  - When: the turn is constructed
  - Then: construction completes and every component is present as some rendering

**AC-3.6:** Every component that fell back during construction is logged with enough detail to act on it: derivation type, subject id, why it floored (not-ready vs failed-floor), and which floor was used.

- **TC-3.6a:** Fallback logged with detail
  - Given: a turn construction where a smoothed prompt fell to its deterministic floor
  - When: construction completes
  - Then: a log entry records the derivation type, subject id, reason, and floor used
- **TC-3.6b:** No fallback → no fallback log
  - Given: a turn where all derivations are ready
  - When: construction completes
  - Then: no fallback log entries are written for it

**AC-3.7:** Turn construction performs no provider work inside a DB write transaction.

- **TC-3.7a:** Provider work outside transaction
  - Given: turn construction attempts re-derivation of a not-ready component
  - When: it runs
  - Then: any provider call happens outside the write transaction that persists the turn

**AC-3.8:** When turn-construction recovery resolves a not-ready component — by re-derivation, deterministic floor, or original-source floor — the resolved content is written back to the component's derivation record as `ready`, **except when a work item is still claimed or pending for that derivation**, in which case the record is left untouched (the floor is used in the rendering, but the in-flight worker is allowed to produce the real result). Persisted recovery outcomes land plain `ready`; there is no "degraded" state and no floor-used marker (no upgrade process consumes such a marker). The fallback *event* is logged; the canonical subject and any `ready` output carry no marker. A tool result's floor is deterministic truncation, never the raw full result.

- **TC-3.8a:** Re-derivation lands ready
  - Given: a `failed` component that recovery re-derives successfully
  - When: construction completes
  - Then: the derivation record is `ready` with the re-derived content
- **TC-3.8b:** Floor recovery also lands ready
  - Given: a `pending` component that recovery cannot re-derive, resolved at its deterministic floor
  - When: construction completes
  - Then: the derivation record is `ready` with the floored content, carries no degraded marker, and the fallback event is logged
- **TC-3.8c:** Tool-result floor is truncation, never raw
  - Given: a tool-result component whose summary is not ready and cannot be re-derived
  - When: construction resolves it
  - Then: the floor written back is deterministic truncation, never the raw full result
- **TC-3.8d:** Write-back defers to live work
  - Given: a not-ready component that still has a claimed or pending work item
  - When: construction resolves it at the floor
  - Then: the floor is used in the rendering but the derivation record is left untouched (not overwritten), so the in-flight worker still produces the real `ready` result

### 4. Chunk Derivation and Compact Recovery

A closed chunk derives two independent summaries — `chunk_summary_detailed` and `chunk_summary_brief` — each with its own state, from the chunk's member turns (via `lower_band_projection`). Smart compact assembles a view from band materials and **never calls a model**. When a needed chunk summary is not ready at compact time, compact does not re-derive it; it falls back to a **deterministic concatenation** of the member content uncompressed — more detail, never a hole. Healing of the summary itself happens out-of-band: the readiness sweep (which runs before compact) requeues transient failures, the background drain produces the real summary, and the next compact uses it. Compact surfaces warnings the user can see and can stop. Only canonical source corruption blocks a compact; missing derivations degrade.

1. A chunk closes; detailed and brief summaries are queued as independent work items
2. Smart compact assembles bands from chunk summaries and turn renderings
3. For each not-ready summary needed, compact uses deterministic stored-member concatenation (no model call) and warns
5. Source corruption (not missing derivation) is the only thing that blocks

#### Acceptance Criteria

**AC-4.1:** A closed chunk's detailed and brief summaries are derived as two independent work items with independent states.

- **TC-4.1a:** Two independent items
  - Given: a chunk closes
  - When: its summaries are queued
  - Then: detailed and brief are separate work items
- **TC-4.1b:** Independent states
  - Given: detailed succeeds and brief fails
  - When: states are read
  - Then: detailed is `ready` and brief is `failed`, independently

**AC-4.2:** At compact, a chunk summary that is not ready (`pending` or `failed`) resolves through `turns.compactChunkMaterial` to a deterministic stored-member concatenation; compact makes no provider call and does not re-derive the summary.

- **TC-4.2a:** Compact uses concat, no provider call
  - Given: a compact needs a `failed` detailed summary, with a provider spy installed
  - When: compact runs
  - Then: the band entry is the deterministic stored-member concat and zero provider calls occur

**AC-4.3:** When a chunk summary still cannot be made ready, compact falls back to a deterministic concatenation of the chunk's member content (uncompressed) rather than leaving a gap.

- **TC-4.3a:** Concat fallback, no gap
  - Given: a chunk summary that is not ready at compact time
  - When: compact assembles the band
  - Then: the band entry is the deterministic concatenation of member content, and no span is missing

**AC-4.4:** Compact surfaces a visible warning for each fallback it performs; the user can see the cleanup/derivation work is delaying the compact and can stop it.

- **TC-4.4a:** Warning surfaced
  - Given: a compact performs a chunk-summary fallback
  - When: it runs
  - Then: a warning is emitted (visible channel) naming what fell back
- **TC-4.4b:** Stoppable
  - Given: a compact is performing its fallback assembly
  - When: the user requests stop
  - Then: compact halts without corrupting the thread

**AC-4.5:** A smart compact never fails because a derivation is missing or failed; it fails only when canonical source state needed for the compacted span is corrupt or unreadable.

- **TC-4.5a:** Missing derivation degrades
  - Given: multiple missing/failed chunk summaries
  - When: compact runs
  - Then: it completes with fallbacks, not a failure
- **TC-4.5b:** Source corruption blocks
  - Given: canonical source for a chunk's turns is corrupt
  - When: compact runs
  - Then: compact refuses with a corruption error rather than fabricating content

**AC-4.6:** Smart compact performs no provider calls at all; background chunk derivation performs no provider work inside a DB write transaction.

- **TC-4.6a:** Compact makes zero provider calls
  - Given: a compact over a thread with not-ready chunk summaries, provider spy installed
  - When: it runs
  - Then: zero provider calls occur during the entire compact

**AC-4.7:** Every compact-time fallback is logged with derivation type, subject id, reason, and the fallback used.

- **TC-4.7a:** Compact fallback logged
  - Given: a compact falls back to concatenation for a chunk
  - When: it completes
  - Then: a log entry records the chunk, derivation type, reason, and fallback

**AC-4.8:** Background chunk-summary derivation behaves differently from compact-time recovery when a member `lower_band_projection` is not ready: because no consumer is waiting, it **requeues and waits** for the input rather than concatenating or failing. It blocks (no progress) only on source corruption of a member; a not-ready member input degrades to a requeue, never a hole or a terminal failure.

- **TC-4.8a:** Background summary requeues on not-ready input
  - Given: a chunk summary derives in the background while a member `lower_band_projection` is `pending`
  - When: the worker runs
  - Then: the chunk summary work requeues (waits) rather than concatenating or landing `failed`
- **TC-4.8b:** Member source corruption surfaces
  - Given: a member turn's canonical source is corrupt
  - When: the background chunk summary attempts to derive
  - Then: it surfaces the source problem (does not silently loop or fabricate)

### 5. Derivation Logging

A cross-cutting logging capability records what the system does and what goes wrong, separate from the canonical subject content. It carries three levels — info, warning, error — and is durably stored so entries can be queried, sliced, and surfaced. It exposes one externally callable write method so both LHC internals and the host extension write to the same place. The principle is channel separation: the **canonical subject** holds usable content and carries no fallback marker; **fallback events** go to the log; and a derivation's own **state and reason** (`failed`/`blocked`) stay on its derivation record, inspectable through health. The log is for fallback events and diagnostics, not for derivation state, and is not surfaced at runtime unless actionable.

#### Acceptance Criteria

**AC-5.1:** The logging capability records entries at info, warning, and error levels to durable storage.

- **TC-5.1a:** Levels stored
  - Given: entries written at each level
  - When: storage is read
  - Then: all three are persisted with their level

**AC-5.2:** A single write method is exposed externally so both LHC internals and the host extension write through the same surface.

- **TC-5.2a:** Shared write surface
  - Given: a write from an LHC internal caller and a write from an external caller
  - When: both are issued
  - Then: both land through the same method into the same store

**AC-5.3:** A fallback *event* is recorded only in the log. The canonical subject (message/turn/chunk content) and any `ready` derivation output carry no degraded/fallback marker. This does not erase derivation state: a `failed` or `blocked` derivation keeps its state and reason on its own record (inspectable per Epic 04) — that is the derivation's state channel, distinct from the fallback-event log channel.

- **TC-5.3a:** Subject and ready output stay clean
  - Given: a derivation fell back during construction
  - When: the canonical subject and the produced rendering are read
  - Then: neither carries a degraded flag; the fallback *event* exists only in the log
- **TC-5.3b:** Failed state still on the derivation record
  - Given: a derivation terminally failed
  - When: its derivation record is read (not the subject)
  - Then: it shows `failed` with a reason, independent of any log entry

**AC-5.4:** Log entries are queryable by the fields that make them actionable (level, derivation type, subject id, reason).

- **TC-5.4a:** Query by fields
  - Given: a store with mixed entries
  - When: queried by level and derivation type
  - Then: only matching entries are returned

**AC-5.5:** A logging write never blocks or fails the operation that produced it; a logging failure is contained.

- **TC-5.5a:** Logging failure contained
  - Given: the logging store write fails
  - When: it happens during a turn construction
  - Then: the construction still completes and the logging failure does not propagate

### 6. Runtime-Change Typing

Runtime changes that occur mid-thread — model switches and thinking-level switches — are recorded as typed blocks (`model_change`, `thinking_level_change`) carrying structured fields, instead of being flattened into opaque `runtime_note` text. They are recorded at intake and projected as typed blocks; they are placed verbatim in constructed turns (Flow 3). Consumption of these blocks for host session restoration is out of scope (pi-lhc).

#### Acceptance Criteria

**AC-6.1:** A model change is recorded and projected as a typed `model_change` block with structured fields (previous and new model).

- **TC-6.1a:** Typed model change
  - Given: a model-change runtime event at intake
  - When: it is projected
  - Then: a typed `model_change` block carries the previous and new model values

**AC-6.2:** A thinking-level change is recorded and projected as a typed `thinking_level_change` block with structured fields (previous and new level).

- **TC-6.2a:** Typed thinking change
  - Given: a thinking-level-change runtime event at intake
  - When: it is projected
  - Then: a typed `thinking_level_change` block carries the previous and new level values

**AC-6.3:** Typed runtime-change blocks are placed verbatim in constructed turns, in stream order, like other non-derived components.

- **TC-6.3a:** Placed verbatim and ordered
  - Given: a turn containing a model change followed by a thinking change
  - When: the turn is constructed
  - Then: both typed blocks appear unchanged and in order

---

## Data Contracts

These are the contracts at the surfaces this epic touches. Stack-neutral; implementation types belong in tech design.

### Derivation State

| State | Meaning | At a consumption point |
|---|---|---|
| `pending` | Expected; queued or in flight | Treated as not-usable; cascade recovers |
| `ready` | Usable | Used directly |
| `failed` | The async attempt gave up | Treated identically to `pending`; cascade recovers |
| `blocked` | Source is damaged; retry cannot help | Surfaces as source problem; only this blocks a consumer |

No `degraded` state. How a `ready` derivation was produced (full / floored / original) is not represented in state. `failed` and `blocked` live on the **derivation record** with a reason and are inspectable (Epic 04); they are not erased by the fallback-event log. Fallback *events* go to the log; derivation *state* stays on the record.

### Tool-Result Summary Tiers (first pass — tunable next epic)

| Result size | Smooth-band target |
|---|---|
| up to ~1000 tokens | summarize to ~10–20% |
| ~1000–5000 tokens | summarize to ~2–5% |
| beyond ~5000 tokens | truncate (no inference summary) |
| already under target | pass through unchanged |

### Logging Write Surface

One externally exposed operation, callable by LHC internals and the host extension.

| Operation | Inputs | Behavior |
|---|---|---|
| write log entry | level (`info`/`warning`/`error`), message, optional derivation type, optional subject id, optional reason | Persists durably; never blocks or fails the caller |

### Log Entry

| Field | Type | Required | Description |
|---|---|---|---|
| level | enum (`info`/`warning`/`error`) | yes | Severity |
| message | string | yes | Human-readable description |
| derivationType | string | no | Which derivation, when relevant |
| subjectId | string | no | The subject (message/turn/chunk) id, when relevant |
| reason | string | no | Why (e.g. not-ready vs failed-floor) |
| floorUsed | string | no | Which fallback was used, for fallback entries |
| recordedAt | timestamp (ISO 8601 UTC) | yes | When |

### Typed Runtime-Change Blocks

| Block type | Fields | Description |
|---|---|---|
| `model_change` | previousModel, newModel | Model switched mid-thread |
| `thinking_level_change` | previousLevel, newLevel | Thinking level switched mid-thread |

---

## Non-Functional Requirements

### Hot-path determinism
- No provider/model calls during intake, context-serving, or smart compact. Turn-construction recovery may make a bounded provider call, but **never** inside a DB write transaction. Smart compact makes no provider call at all.
- Deterministic floors (cleaning, truncation, concatenation) are pure functions — no DB handle, no model — so they can run inline during composition.

### Reproducibility
- Deterministic floor output is identical for identical input (no clock, no randomness, no model), so recovered renderings are stable across runs.

### Observability isolation
- The log is the only channel for fallback *events*; the canonical subject and any `ready` output carry no degraded marker. Derivation *state* (`failed`/`blocked` + reason) still lives on the derivation record — that is a separate channel from the fallback-event log.
- A logging write failure is contained and never propagates to the operation that logged.

### Concurrency
- Recovery relies on the single-worker-per-thread ordering (Epic 02); recovery and background derivation do not race on one thread.

---

## Tech Design Questions

1. **Turn-summarization-at-close parity:** does the worker run `composeTurnRendering` / `projectLowerBand` as provider operations at turn close, or assemble the turn deterministically from already-derived components? This affects whether Flow 3 recovery ever calls a provider at all. Resolve against current code.
2. **Deterministic-then-inference single field:** exact state-write mechanics for one derivation field written first by the deterministic stage and then by inference, without introducing a second field or a "skipped" state. Where does the deterministic stage run — at intake (cheap, raises the floor immediately) or in the worker?
3. **Background chunk-summary requeue mechanics:** AC-4.8 decides the behavior (requeue/wait on a not-ready member input; block only on member source corruption). Tech design settles the mechanics: requeue backoff, how member source corruption is detected, and how a waiting chunk summary is re-triggered when its member input lands ready.
4. **`lower_band_projection` standalone:** confirm and document it as turn-derivation's second output and the chunk-detailed input; likely no new work, needs a confirm pass.
5. **Logging storage shape:** SQLite table design, retention, and whether stdio is piped into it; entry indexing for the actionable query fields.
6. **Buffer-surfacing boundary:** the LHC log boundary is in scope; the harness rendering of warnings/errors to a user-visible, collapsed, not-in-history buffer is pi-lhc — pin exactly what LHC exposes for the extension to consume.
7. **Length cap value** for smoothing inference (dial-in concern; needs a default to build against).
8. **Rename mechanics:** scope of the `form`→`derivation` rename across schema, types, work-queue kinds, and tests; whether any persisted schema identifiers change.

---

## Recommended Story Breakdown

### Story 0: Foundation (rename, vocabulary, logging surface)

**Delivers:** the renamed codebase and the logging capability everything else writes to.
**Governing idea:** establish the shared vocabulary and the diagnostic channel before the cascade work depends on them.
**Boundary / risk notes:** wide mechanical rename (`form`→`derivation`, `FormKind`→derivation type, `DerivedFormState`→state) touching schema, types, work-queue kinds, and tests; plus the new logging table and write method. Needs focused tests for the logging surface (levels stored, shared write, query, contained failure) and a green typecheck/test pass proving the rename did not change behavior.
**Flows/ACs covered:**
- Flow 5: AC-5.1–5.5 (logging surface)
- Rename (Scope, not an AC) — verified by existing suite staying green

**Estimated test count:** ~6

### Story 1: Prompt smoothing — deterministic floor + length gate

**Delivers:** smoothing as a two-stage operation with an always-on deterministic floor and length-gated inference.
**Governing idea:** a smoothed prompt is always usable, produced by deterministic-only or deterministic+inference, with one state and no "skipped".
**Prerequisite:** Story 0
**Boundary / risk notes:** establishes the deterministic-floor concept the cascade reuses; fenced-code handling is prompt-instruction only (no segmentation).
**Flows/ACs covered:**
- Flow 1: AC-1.1–1.7

**Estimated test count:** ~11

### Story 2: Tool-result rendering — truncation vs summary, tiers, per-tool

**Delivers:** the full-band truncation / smooth-band summary split with tiered targets and per-tool guidance; removal of `tool_call_summary`.
**Governing idea:** tool results render at the right fidelity per band, deterministically where it must be hot-path, by inference where it can be cold-path; calls render as-is.
**Prerequisite:** Story 1
**Boundary / risk notes:** first-pass tiers and prompts only — tuning is the next epic; reuses the Epic 03 visibility-boundary truncation as the floor (do not rebuild).
**Flows/ACs covered:**
- Flow 2: AC-2.1–2.8

**Estimated test count:** ~12

### Story 3: Turn construction and the recovery cascade

**Delivers:** turn construction that resolves every component through the cascade, never blocking or holing, logging every fallback.
**Governing idea:** the floor-and-recovery contract instantiated at the turn level.
**Prerequisite:** Stories 1, 2 (component floors exist)
**Boundary / risk notes:** depends on the turn-summarization-at-close parity question (TD Q1); tool results never fall below truncation; pending and failed handled identically.
**Flows/ACs covered:**
- Flow 3: AC-3.1–3.8

**Estimated test count:** ~12

### Story 4: Chunk derivation and compact recovery

**Delivers:** independent detailed/brief chunk summaries and a smart compact that regenerates-or-concatenates, warns, is stoppable, and blocks only on source corruption.
**Governing idea:** the cascade instantiated at the chunk/compact level — more detail on fallback, never a hole, corruption is the only stop.
**Prerequisite:** Story 3
**Boundary / risk notes:** the background chunk-summary requeue behavior is decided (AC-4.8); its mechanics (backoff, re-trigger on member ready, source-corruption detection) are settled in tech design (TD Q3). User-visible warning + stop straddles the LHC/pi-lhc boundary (Flow 5 / TD Q6).
**Flows/ACs covered:**
- Flow 4: AC-4.1–4.8

**Estimated test count:** ~12

### Story 5: Runtime-change typing

**Delivers:** typed `model_change` / `thinking_level_change` blocks recorded at intake and placed verbatim in turns.
**Governing idea:** preserve runtime-change structure instead of flattening to opaque text.
**Prerequisite:** Story 0
**Boundary / risk notes:** intake/projection work, not derivation; consumer-side restoration is pi-lhc and out of scope; can land independently of Stories 1–4.
**Flows/ACs covered:**
- Flow 6: AC-6.1–6.3

**Estimated test count:** ~3

---

## Validation Checklist

- [x] User Profile has all four fields + Feature Overview
- [x] Onboarding context is brief and necessary (vocabulary + the contract + "reworks built behavior")
- [x] Flow summary entries match actual flow headings and AC ranges
- [x] Flows cover production, consumption/recovery, observability, and parity paths
- [x] Every AC is testable
- [x] Every AC has at least one TC
- [x] TCs cover happy path, not-ready/failed, source-corruption, and no-provider-in-transaction
- [x] Data contracts specified for states, tiers, logging surface, log entry, typed blocks
- [x] Scope boundaries explicit (rename in; tuning out; pi-lhc consumption out)
- [x] Story breakdown covers all ACs (5.x in Story 0; 1.1–1.7/2.1–2.8/3.1–3.8/4.1–4.8/6.x in Stories 1–5)
- [x] Stories sequence logically (foundation → production floors → turn cascade → chunk/compact cascade → parity)
- [ ] Tech Lead review (downstream consumer validation)
- [ ] Validation rounds complete
