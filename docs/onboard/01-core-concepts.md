# Long Horizon Context: Core Concepts

Last verified against code: 2026-08-09. Precedence when facts disagree: code, then README, then [03-decisions-brief](03-decisions-brief.md), then this doc; see also the [decision registry](../decision-registry.md).

This doc and [02-domain-design](02-domain-design.md) are the onboarding path for any agent working in this codebase. A separate ethical framework ([../ethical-framework.md](../ethical-framework.md)) governs designs that touch memory policy, salience, compression of relational history, or agent-identity surfaces — consult it when working in those areas; it is not prerequisite reading for ordinary implementation or verification work.

Long Horizon Context (LHC) is an SDK for managing an agentic harness's context and history. It keeps the full message history of a conversation as a durable record, and from that record builds shorter, summarized views that a harness can load and work from.

## Basics

LHC is a stateful SDK consumed in-process by a host. The host — a PI extension, a Claude Code wrapper, or another harness — creates an SDK instance at startup via `initLhc`, wiring in everything LHC needs: storage location, configuration, and a way to make model calls. There are two ways to give LHC model access: hand it a complete set of inference callback functions directly, or hand it one model-calling function plus a table of which provider/model to use for each kind of derivation work (the adapter resolves this into callbacks internally). LHC has no logins of its own and no out-of-process surface; anything that needs to talk to LHC runs inside a host that holds an SDK instance.

All durable state lives in storage — one SQLite file per thread, plus a separate SQLite registry that tracks which threads exist and where their files are — so a host can stop and restart without losing anything, including queued background work, which picks up where it left off.

The system is organized into domains, each owning one part of the conversation model and exposing its operations through the SDK surface. Beneath them sit shared-tech utils — a durable work queue, a token counter, an inference adapter, a prompt registry, and a scheduler — that the domains use but that have no surface of their own. One cross-cutting technical surface — logging — is exposed externally as well: both LHC and the host write info/warning/error logs through it, stored in the thread's SQLite file.

## Key domains and entities

**Threads.** A thread is the durable container for one ongoing conversation between a user and an agentic harness, and each thread lives in its own file. The `threads` domain creates threads, keeps the registry of which threads exist and where their files are, and holds thread-level metadata and status. Thread ids are globally unique (`th_` + 16 hex chars) and support partial-prefix resolution.

**Intake stream.** As a harness runs, it produces a stream of events: user prompts, assistant text and thinking, tool calls and their results, model changes, thinking level changes, runtime notes, and a marker at the end of each turn. The `intake-stream` domain takes these events in ordered batches and records them into the thread. As it records the stream, it calls `messages` to create the readable message-and-block view and calls `turns` to apply the turn state machine.

**Messages.** A message is one unit of the conversation — a user prompt, assistant text, assistant thinking, a tool call, a tool result, a model change, a thinking level change, or a runtime note — built from typed blocks. The five block types are `text`, `tool_call`, `tool_result`, `model_change`, and `thinking_level_change`. The `messages` domain owns this message-and-block view. It creates messages when called by intake-stream, lets you list and show them, and gives people or agents a place to edit or remove messages from the readable record.

**Turns.** A turn is one full exchange: a user prompt and all the assistant and tool activity that follows it, up to a `turn_end` or the next prompt. The `turns` domain owns turn state, derives closed turns, and groups turns into chunks that feed summaries and recall. Turns are the base unit; chunks are containers of turns. There is always exactly one open turn at any time — this invariant is enforced as a hard error.

**Thread views.** A thread view is a summarized, harness-ready rendering of a thread, produced by a smart compact and arranged so an agent can resume the conversation without the full history. A view is a snapshot: it changes only when the next compact replaces it, never on its own. What a harness loads is the stored view plus the live tail — everything recorded since the compact. The `thread-view` domain produces views, serves them as model context, and writes them into a host-specific file format (today PI session JSONL).

**Inspect.** The `inspect` domain looks at a thread as a whole, producing overviews, health reports, and view-contents reports across its messages, turns, and views. It reads through other domains' surfaces and changes nothing. Where `messages` works inside the history, `inspect` reports on the state of it.

**Retrieval.** The `retrieval` domain resolves stable ids back to content: `getTurns` returns a turn's rendering, `getMessages` returns verbatim message content, both under explicit token budgets with receipts for anything not served whole. Every requested id is logged as an impression — a durable record of what was recalled. Hosts expose these operations to the model as tools; see [Addressing and retrieval](#addressing-and-retrieval) below.

## What we call things

The working vocabulary of the project. Each entry says what the term means and, where it matters, where its edge is — the nearby thing it should *not* be confused with.

**Record.** The durable, append-only source of truth: the events as they arrived. Everything else is built from the record and can be rebuilt from it. Edits and deletes change what readers see; the record retains the originals.

**Derivation.** The stored output of producing a new representation of existing content — a smoothed prompt, a tool-result summary, a chunk summary — attached to its source. To **derive** (deriving) is the act; a **derivation** is the stored result. **Derivation type** names which one. Deriving runs either in the background off the work queue or synchronously through explicit derive operations on the domain surfaces — never on the intake hot path.

**Derivation types.** The system has seven derivation types, each owned by one domain. Four are produced by calling a model; three are assembled deterministically from other material:

- `smoothed_prompt` — cleans up a user prompt; inference-backed (owned by messages)
- `tool_result_summary` — summarizes a tool result; inference-backed (owned by messages). Inference summarization is currently forced off — every tool result gets deterministic 500-char truncation instead (interim; see DERIV-12 in the decision registry).
- `turn_rendering` — composes a turn's activity into one account from its message-level derivations; deterministic (owned by turns)
- `pre_detailed_assembly` — strips a closed turn to dialogue only (`user_prompt` and `assistant_text`); deterministic (owned by turns). `detailed_turn_compression` compresses this assembly, not the full turn rendering.
- `detailed_turn_compression` — compresses a turn's pre-detailed assembly for the smooth band's degraded fallback; inference-backed (owned by turns)
- `chunk_summary_detailed` — assembles a chunk summary from member `detailed_turn_compression` content (dialogue-derived); deterministic (owned by turns)
- `chunk_summary_brief` — summarizes a chunk, keeping outcomes only; inference-backed (owned by turns)

**Derivation states.** Every derivation carries one of four states: `pending` (enqueued, not yet run), `ready` (derived, including via fallback), `failed` (the attempt did not work; a re-derive might), `blocked` (the source is damaged; a re-derive will not help). State belongs to the derivation itself, never to its subject — a chunk does not have "a state"; its detailed derivation and its brief derivation each carry their own.

**Source version.** A monotonic version on each derivation row, incremented when the source content changes — through an edit, a delete, or a cascade from a changed dependency. When a derivation is in flight and the source changes, the rebuild writes at the next version. The in-flight derivation finishes against the old version and is discarded as stale. This prevents a late-finishing pre-change derivation from overwriting a post-change rebuild.

**Work queue / drain.** The durable per-thread queue of background work. Rows are written in the same transaction as the change that caused them, so queued work survives crashes. **Draining** is processing that queue — claim an item, run the handler, write the result — until the queue is empty or stopped. Handlers may call inference or assemble deterministically depending on the derivation type. Draining happens inside the host's process; there is no daemon.

**Host mode.** LHC runs in one of two modes, chosen at SDK construction:

- **Background**: derivation work runs automatically. After each intake commit, the scheduler picks up queued items and drains them. When a thread file is opened for the first time in a process, leftover work from a previous process is drained too.
- **Manual**: derivation work runs only when the host explicitly calls `work.drain`. The scheduler is inert.

**Smoothing.** The derivation that cleans up a user prompt — typos, repetition, heat — while preserving intent, constraints, and exact identifiers. The smoothed derivation is what views render; the original stays in the record.

**Turn.** One full exchange: a user prompt and everything that follows it, up to the turn's end. **Chunk:** a container of consecutive closed turns, cut by a token-based size policy, whose membership never changes once closed.

**Bands.** The fidelity tiers a thread view is built from, oldest to newest: **brief** (shortest chunk summaries), **detailed** (fuller chunk summaries), **smooth** (turn renderings at full texture). These three are rendered and stored as snapshot text by a compact. When `turn_rendering` is missing, the smooth band falls back to `detailed_turn_compression` as a degraded rung. The **full** tier is not stored — compact uses its percentage to determine where the compact point falls, and everything after that point is served as the live tail. A compact decides how much of the thread lands in each tier.

**Smart compact.** The explicit operation that produces a new thread view. It takes a compact configuration — a target size in tokens and a set of percentages that control how much of that size each band gets — and arranges the thread's turns and chunks into bands accordingly. Compact never calls a model; it assembles from derivations that already exist. Missing derivation material degrades the entry (falls back to a cruder derivation, a deterministic floor, or raw content). Damage to the canonical record itself — such as a turn referencing a missing chunk member — causes compact to refuse before writing, leaving the prior view intact.

The SDK ships built-in compact configurations that can be overridden or extended at construction, and callers can override individual percentages at compact time.

**Compact point.** Where the most recent compact stopped. Everything after it is the **tail** (or live tail): recent activity served alongside the view. Before an explicit smart compact, tail tool results render full. After compact, a visibility boundary may shorten at-or-behind tool results.

**Visibility boundary.** A per-thread marker that controls how tool results appear in the model context: tool results at or behind it render as a short truncation (first ~500 characters plus a truncation marker), tool results ahead of it render full. Three things move the boundary: compact resets it to the compact point; `prune` advances it independently (see below); intake never moves it. It affects only tool results — prompts, assistant text, and thinking always render full.

**Prune.** An operation (`threadView.prune`) that advances the visibility boundary without running a compact. It walks live tool results newest-first from the current boundary, keeps results full until the target token budget is met, and sets the boundary behind the last full result. The boundary never moves backward and never moves behind the compact point. Given valid input, prune always executes and reports what it did (a receipt with before/after boundary, zone tokens, pruned count) rather than refusing — a zone already under target yields a no-op receipt, not an error. Invalid input (a bad target, a missing thread) still returns a caller error like any operation. The typical use is reclaiming context space from old tool outputs between compacts.

**Inference callbacks.** The four-operation interface that sits at the boundary between LHC and the host's model access: `smoothPrompt`, `summarizeToolResult`, `compressDetailedTurn`, and `summarizeChunkBrief`. Any model call LHC makes goes through this interface. Deterministic derivations such as `turn_rendering`, `pre_detailed_assembly`, and `chunk_summary_detailed` stay inside their owning domain handlers and do not cross the inference boundary.

**OpResult.** The error contract. Every operation that can fail returns either `{ ok: true, value }` or `{ ok: false, error }`. The error carries a machine-readable `code`, a human-readable `reason`, and an `errorClass` (`caller_error`, `state_corruption`, or `system_error`). Expected failures are always returned this way, never thrown. Programmer bugs inside LHC may still throw, but callers are not expected to handle throws as contract outcomes.

**Logging surface.** A cross-cutting technical surface, exposed externally from LHC, that both LHC and the host call to write info/warning/error logs into the thread's SQLite file. Writes are fail-soft — a logging failure never propagates to the caller and never shares the caller's transaction. It carries diagnostics (such as a derivation falling back to a floor) collected for troubleshooting, not control flow. Distinct from the record: logs say what went wrong, the record stays what is usable.

**Degraded / gap.** What a view shows when a needed derivation is missing: a **degraded** entry renders the best available fallback (a cruder derivation, a deterministic floor, or raw content); a **gap** is an explicit placeholder where nothing usable exists. The fallback goes into the view (more content, not less) and the failure goes to the log; the record stays clean. Nothing is silently omitted.

**Render / materialize / LlmRequestContext.** Three ways view content leaves LHC: **render** is producing the output form of an entry; **materialize** is writing the view to a file in a host-specific format (today PI session JSONL); **LlmRequestContext** is the host-facing model context returned by `threadView.getLlmRequestContext`. Both materialized and in-memory forms come from the same serving assembly; only the output shape differs.

**Host.** The process that owns an SDK instance and everything LHC needs from the outside world: storage location, configuration, model access. Current hosts: `pi-lhc` (PI extension — the reference integration), `cc-lhc` (Claude Code PTY wrapper), the maintained Codex CLI and Grok Build forks (native Rust integration via the vendored `lhc-rs` port), and `t3code-lhc` (t3code web harness). One login — the host's — covers everything LHC does.

**Ports.** The TypeScript SDK (`packages/lhc`) is the contract source. Certified ports exist in Rust (`lhc-rs`, vendored by the Codex and Grok forks), Python (`lhc-py`), and Convex (`lhc-convex`). Behavior lands in TypeScript first; ports mirror it and are certified against the same contract before hosts consume them.

## Addressing and retrieval

Served history is addressable, and the model can pull any part of the record back on demand. This is the layer that turns compression from a one-way loss into a reversible trade.

**Labels.** Turn renderings wrap each turn in `<tN>…</tN>` tags and each message in `<mN>…</mN>` tags. Chunk entries in the detailed and brief bands carry a `<turns>t10 t11</turns>` header, added at serve time from chunk membership, naming the turns the summary covers. So every tier of the served view — even the most compressed — exposes ids that reach the underlying record. The ids are stable addresses: `t45` and `m3177` mean the same rows forever. Labels are baked into stored turn renderings at derivation time; renderings stored before labels existed are handled by a fresh-composition fallback at pull time, and a whole thread can be retro-labeled by re-deriving its renderings (pure composition, no inference).

**Retrieval operations.** `retrieval.getTurns(ids)` serves smoothed turn renderings with labels; `retrieval.getMessages(ids)` serves verbatim originals. Both walk the requested ids in order under a token budget: items that fit are served whole; the item that crosses the budget is served as an exact token slice with a continuation receipt naming the window served and the offset to resume from (`fromToken`); items past a spent budget get an explicit refusal receipt naming their size, so the caller can re-request them alone. An optional byte budget produces byte-fitting slices for hosts whose machinery limits tool output by bytes rather than tokens. Slices never split a multi-byte character. Refusals teach the recovery call inline — the receipt is the instruction.

**Impressions.** Every id requested through retrieval writes one impression row in the thread file (schema v6): what was asked for, by which surface, whether it was served, and at what size. An impression records that content was served into a tool result — not that the model demonstrably consumed it. This is the durable evidence base for future salience work; nothing reads it on the serving path.

**Historical framing.** Hosts wrap retrieval tool output in an explicit envelope marking it as recalled history, so a resurfaced past prompt reads as a record of what was said, never as a live instruction. The envelope, receipts, and continuation guidance sit outside the recalled content; the content itself is served exactly.

**Thinking signatures and model identity.** Capture preserves provider-signed reasoning: `assistant_thinking` events carry an optional opaque signature, and assistant messages record the provider/model/API identity that produced them. Identity is frozen at the moment the request was prepared, never read back from mutable session state, and signed reasoning is replayed on resume only under an exact identity match — so reasoning continuity survives resume without ever crossing a model boundary. Empty unsigned thinking is skipped at serving; empty signed thinking stays in the record and serves.
