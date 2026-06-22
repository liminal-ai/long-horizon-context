# Long Horizon Context: Core Concepts

Long Horizon Context (LHC) is an SDK for managing an agentic harness's context and history. It keeps the full message history of a conversation as a durable record, and from that record builds shorter, summarized views that a harness can load and work from.

## Basics

LHC is a stateful SDK consumed in-process by a host. The host — a PI extension today; a web or desktop app server later — creates an SDK instance at startup via `initLhc`, wiring in everything LHC needs: storage location, configuration, and a way to make model calls. There are two ways to give LHC model access: hand it a complete set of inference callback functions directly, or hand it one model-calling function plus a table of which provider/model to use for each kind of derivation work (the adapter resolves this into callbacks internally). LHC has no logins of its own and no out-of-process surface; anything that needs to talk to LHC runs inside a host that holds an SDK instance.

All durable state lives in storage — one SQLite file per thread, plus a separate SQLite registry that tracks which threads exist and where their files are — so a host can stop and restart without losing anything, including queued background work, which picks up where it left off.

The system is organized into domains, each owning one part of the conversation model and exposing its operations through the SDK surface. Beneath them sit shared-tech utils — a durable work queue, a token counter, an inference adapter, a prompt registry, and a scheduler — that the domains use but that have no surface of their own. One cross-cutting technical surface — logging — is exposed externally as well: both LHC and the host write info/warning/error logs through it, stored in the thread's SQLite file.

## Key domains and entities

**Threads.** A thread is the durable container for one ongoing conversation between a user and an agentic harness, and each thread lives in its own file. The `threads` domain creates threads, keeps the registry of which threads exist and where their files are, and holds thread-level metadata and status. Thread ids are globally unique (`th_` + 16 hex chars) and support partial-prefix resolution.

**Intake stream.** As a harness runs, it produces a stream of events: user prompts, assistant text and thinking, tool calls and their results, model changes, thinking level changes, runtime notes, and a marker at the end of each turn. The `intake-stream` domain takes these events in ordered batches and records them into the thread. As it records the stream, it calls `messages` to create the readable message-and-block view and calls `turns` to apply the turn state machine.

**Messages.** A message is one unit of the conversation — a user prompt, assistant text, assistant thinking, a tool call, a tool result, a model change, a thinking level change, or a runtime note — built from typed blocks. The five block types are `text`, `tool_call`, `tool_result`, `model_change`, and `thinking_level_change`. The `messages` domain owns this message-and-block view. It creates messages when called by intake-stream, lets you list and show them, and gives people or agents a place to edit or remove messages from the readable record.

**Turns.** A turn is one full exchange: a user prompt and all the assistant and tool activity that follows it, up to a `turn_end` or the next prompt. The `turns` domain owns turn state, derives closed turns, and groups turns into chunks that feed summaries and recall. Turns are the base unit; chunks are containers of turns. There is always exactly one open turn at any time — this invariant is enforced as a hard error.

**Thread views.** A thread view is a summarized, harness-ready rendering of a thread, produced by a smart compact and arranged so an agent can resume the conversation without the full history. A view is a snapshot: it changes only when the next compact replaces it, never on its own. What a harness loads is the stored view plus the live tail — everything recorded since the compact. The `thread-view` domain produces views, serves them as model context, and writes them into a host-specific file format (today PI session JSONL).

**Inspect.** The `inspect` domain looks at a thread as a whole, producing overviews, health reports, and view-contents reports across its messages, turns, and views. It reads through other domains' surfaces and changes nothing. Where `messages` works inside the history, `inspect` reports on the state of it.

## What we call things

The working vocabulary of the project. Each entry says what the term means and, where it matters, where its edge is — the nearby thing it should *not* be confused with.

**Record.** The durable, append-only source of truth: the events as they arrived. Everything else is built from the record and can be rebuilt from it. Edits and deletes change what readers see; the record retains the originals.

**Derivation.** The stored output of producing a new representation of existing content — a smoothed prompt, a tool-result summary, a chunk summary — attached to its source. To **derive** (deriving) is the act; a **derivation** is the stored result. **Derivation type** names which one. Deriving runs either in the background off the work queue or synchronously through explicit derive operations on the domain surfaces — never on the intake hot path.

**Derivation types.** The system has six derivation types, each owned by one domain. Four are produced by calling a model; two are assembled deterministically from other material:

- `smoothed_prompt` — cleans up a user prompt; inference-backed (owned by messages)
- `tool_result_summary` — summarizes a tool result; inference-backed (owned by messages)
- `turn_rendering` — composes a turn's activity into one account from its message-level derivations; deterministic (owned by turns)
- `smooth_turn_compression` — compresses a turn rendering for the smooth band; inference-backed (owned by turns)
- `chunk_summary_detailed` — assembles a chunk summary from member turn compressions and tool-activity receipts; deterministic (owned by turns)
- `chunk_summary_brief` — summarizes a chunk, keeping outcomes only; inference-backed (owned by turns)

**Derivation states.** Every derivation carries one of four states: `pending` (expected or in flight), `ready` (usable), `failed` (terminal, with a reason), `blocked` (source damage; retry won't help). Retry-in-progress is not a state — a derivation stays `pending` while attempts remain. Mechanical retry detail (attempt counts, backoff) lives on the queue row, not the derivation. State belongs to the derivation itself, never to its subject — a chunk does not have "a state"; its detailed derivation and its brief derivation each carry their own.

**Source version.** A monotonic version on each derivation row, incremented when the source content changes — through an edit, a delete, or a cascade from a changed dependency. When a derivation is in flight and the source changes, the rebuild writes at the next version. The in-flight derivation finishes against the old version and is discarded as stale. This prevents a late-finishing pre-change derivation from overwriting a post-change rebuild.

**Work queue / drain.** The durable per-thread queue of background work. Rows are written in the same transaction as the change that caused them, so queued work survives crashes. **Draining** is processing that queue — claim an item, run the handler, write the result — until the queue is empty or stopped. Handlers may call inference or assemble deterministically depending on the derivation type. Draining happens inside the host's process; there is no daemon.

**Host mode.** LHC runs in one of two modes, chosen at SDK construction:

- **Background**: derivation work runs automatically. After each intake commit, the scheduler picks up queued items and drains them. When a thread file is opened for the first time in a process, leftover work from a previous process is drained too.
- **Manual**: derivation work runs only when the host explicitly calls `work.drain`. The scheduler is inert.

**Smoothing.** The derivation that cleans up a user prompt — typos, repetition, heat — while preserving intent, constraints, and exact identifiers. The smoothed derivation is what views render; the original stays in the record.

**Turn.** One full exchange: a user prompt and everything that follows it, up to the turn's end. **Chunk:** a container of consecutive closed turns, cut by a token-based size policy, whose membership never changes once closed.

**Bands.** The fidelity tiers a thread view is built from, oldest to newest: **brief** (shortest chunk summaries), **detailed** (fuller chunk summaries), **smooth** (compressed turn renderings). These three are rendered and stored as snapshot text by a compact. The **full** tier is not stored — compact uses its percentage to determine where the compact point falls, and everything after that point is served as the live tail. A compact decides how much of the thread lands in each tier.

**Smart compact.** The explicit operation that produces a new thread view. It takes a compact configuration — a target size in tokens and a set of percentages that control how much of that size each band gets — and arranges the thread's turns and chunks into bands accordingly. Compact never calls a model; it assembles from derivations that already exist. Missing derivation material degrades the entry (falls back to a cruder derivation, a deterministic floor, or raw content). Damage to the canonical record itself — such as a turn referencing a missing chunk member — causes compact to refuse before writing, leaving the prior view intact.

The SDK ships built-in compact configurations that can be overridden or extended at construction, and callers can override individual percentages at compact time.

**Compact point.** Where the most recent compact stopped. Everything after it is the **tail** (or live tail): recent activity served alongside the view. Most tail content renders directly, but tool results may be shortened by the visibility boundary.

**Visibility boundary.** A per-thread marker that controls how tool results appear in the model context: tool results at or behind it render as a deterministic truncation with a pointer back to the full record, tool results ahead of it render full. The boundary advances when a turn closes and the total tokens of full-rendered tool results exceed a configured maximum. It evicts whole turns at a time, oldest first, stopping when the remaining total is at or above a configured target. The newest closed turn is never evicted. The boundary resets at compact. It affects only tool results — prompts, assistant text, and thinking always render full.

**Readiness sweep.** The operation that walks all message and turn derivation reports, and re-queues the ones that failed transiently. Runs inside compact by default (before the assembly step), and can be run standalone. It reads the derivation states through each owning domain's report surface and asks those domains to re-queue their own failed work. The sweep itself never calls a model and never writes derivations — it only schedules repair work.

**Inference callbacks.** The six-operation interface that sits at the boundary between LHC and the host's model access: `smoothPrompt`, `summarizeToolResult`, `composeTurnRendering`, `compressSmoothTurn`, `summarizeChunkDetailed`, `summarizeChunkBrief`. Any model call LHC makes goes through this interface. In practice, four of the six are inference-backed in production (`smoothPrompt`, `summarizeToolResult`, `compressSmoothTurn`, `summarizeChunkBrief`); the other two (`composeTurnRendering`, `summarizeChunkDetailed`) exist as overridable seams but their production handlers assemble deterministically without calling them.

**OpResult.** The error contract. Every operation that can fail returns either `{ ok: true, value }` or `{ ok: false, error }`. The error carries a machine-readable `code`, a human-readable `reason`, and an `errorClass` (`caller_error`, `state_corruption`, or `system_error`). Expected failures are always returned this way, never thrown. Programmer bugs inside LHC may still throw, but callers are not expected to handle throws as contract outcomes.

**Logging surface.** A cross-cutting technical surface, exposed externally from LHC, that both LHC and the host call to write info/warning/error logs into the thread's SQLite file. Writes are fail-soft — a logging failure never propagates to the caller and never shares the caller's transaction. It carries diagnostics (such as a derivation falling back to a floor) collected for troubleshooting, not control flow. Distinct from the record: logs say what went wrong, the record stays what is usable.

**Degraded / gap.** What a view shows when a needed derivation is missing: a **degraded** entry renders the best available fallback (a cruder derivation, a deterministic floor, or raw content); a **gap** is an explicit placeholder where nothing usable exists. The fallback goes into the view (more content, not less) and the failure goes to the log; the record stays clean. Nothing is silently omitted.

**Render / materialize / LlmRequestContext.** Three ways view content leaves LHC: **render** is producing the output form of an entry; **materialize** is writing the view to a file in a host-specific format (today PI session JSONL); **LlmRequestContext** is the host-facing model context returned by `threadView.getLlmRequestContext`. Both materialized and in-memory forms come from the same serving assembly; only the output shape differs.

**Host.** The process that owns an SDK instance and everything LHC needs from the outside world: storage location, configuration, model access. PI extension now; app server later; possibly a wrapper around another harness someday. One login — the host's — covers everything LHC does.
