# Long Horizon Context: Core Concepts

Long Horizon Context (LHC) is an SDK for managing an agentic harness's context and history. It keeps the full message history of a conversation as a durable record, and from that record builds shorter, summarized views that a harness can load and work from.

## Basics

LHC is a stateful SDK consumed in-process by a host. The host — a PI extension today; a web or desktop app server later — creates an SDK instance at startup, wiring in everything LHC needs: storage location, configuration, and one injected function LHC uses to make model calls through the host's providers and logins. LHC has no logins of its own and no out-of-process surface; anything that needs to talk to LHC runs inside a host that holds an SDK instance. All durable state lives in storage (one SQLite file per thread), so a host can stop and restart without losing anything — including queued background work, which picks up where it left off.

The system is organized into domains, each owning one part of the conversation model and exposing its operations through the SDK surface. Beneath them sit a few shared tech utils, such as a durable work queue for background deriving and a token counter, that the domains use but that have no surface of their own. One cross-cutting technical surface — logging — is exposed externally as well: both LHC and the host write info/warning/error logs through it, stored in the thread's SQLite file.

## Key domains and entities

**Threads.** A thread is the durable container for one ongoing conversation between a user and an agentic harness, and each thread lives in its own file. The `threads` domain creates threads, keeps a catalog of which threads exist and where their files are, and holds thread-level metadata and status.

**Intake stream.** As a harness runs, it produces a stream of events: user prompts, assistant text and thinking, tool calls and their results, runtime notes, and a marker at the end of each turn. The `intake-stream` domain takes these events in ordered batches and records them into the thread. As it records the stream, it calls `messages` to create the readable message-and-block view and calls `turns` to open or close turn state.

**Messages.** A message is one unit of the conversation, such as a user prompt, an assistant response, or a tool result, built from blocks of text, thinking, tool calls, tool results, images, or files. The `messages` domain owns this message-and-block view. It creates messages when called by intake-stream, lets you read, list, and search them, and gives people or agents a place to edit or prune the message history directly.

**Turns.** A turn is one full exchange: a user prompt and all the assistant and tool activity that follows it, up to a `turn_end` or the next prompt. The `turns` domain owns turn state, derives closed turns, and groups turns into chunks that feed summaries and recall. Turns are the base unit; chunks are containers of turns.

**Thread views.** A thread view is a summarized, harness-ready rendering of a thread, produced by a smart compact and arranged so an agent can resume the conversation without the full history. A view is a snapshot: it changes only when the next compact replaces it, never on its own. What a harness loads is the stored view plus the live tail — everything recorded since the compact. The `thread-view` domain produces views, serves them, and writes them into a provider's file format.

**Inspect.** The `inspect` domain looks at a thread as a whole, producing overviews, statistics, and reports across its messages, turns, and views. It reads and explains; it does not change the record. Where `messages` works inside the history, `inspect` reports on the state of it.

## What we call things

**Draft — partially ratified.** Some terms are explicitly agreed and current: the **derivation** family (derive/deriving, derivation, derivation type, state) was settled in the derivation-cascade work, along with thread-view scope and the band names. Others accumulated in spec documents without ever being put in front of Lee as naming decisions (host; render/materialize/`LlmRequestContext`; visibility boundary; compact point; record) and are still pending review.

The working vocabulary of the project. Each entry says what the term means and, where it matters, where its edge is — the nearby thing it should *not* be confused with.

**Record.** The durable, append-only source of truth: the events as they arrived. Everything else is built from the record and can be rebuilt from it. Edits and deletes change what readers see; the record retains the originals.

**Projection.** The deterministic transformation steps that turn one form of data into the next: events project into messages, messages into turns, turns into chunks. "Projection" names these transforms only — it is *not* a name for the banded output artifact. That is a thread view.

**Derivation.** The stored output of producing a new representation of existing content — a smoothed prompt, a tool-result summary, a chunk summary — attached to its source. To **derive** (deriving) is the act; a **derivation** is the stored result. **Derivation type** names which one. Deriving runs in the background off the work queue, never on the intake hot path. ("Derived form" / "form" is retired — one vague word smeared across the stored thing, its type, and its state.)

**Derivation states.** Every derivation carries one of four states: `pending` (expected or in flight), `ready` (usable), `failed` (terminal, with a reason), `blocked` (source damage; retry won't help). Retry-in-progress is not a state — a derivation stays `pending` while attempts remain. Mechanical retry detail (attempt counts, backoff) lives on the queue row, not the derivation. State belongs to the derivation itself, never to its subject — a chunk does not have "a state"; its detailed derivation and its brief derivation each carry their own.

**Work queue / drain.** The durable per-thread queue of background work. Rows are written in the same transaction as the change that caused them, so queued work survives crashes. **Draining** is processing that queue until empty; it happens inside the host's process — there is no daemon.

**Smoothing.** The derivation that cleans up a user prompt — typos, repetition, heat — while preserving intent, constraints, and exact identifiers. The smoothed derivation is what views render; the original stays in the record.

**Turn.** One full exchange: a user prompt and everything that follows it, up to the turn's end. **Chunk:** a container of consecutive closed turns, cut by size, whose membership never changes once closed.

**Bands.** The fidelity ladder a thread view is built from, oldest to newest: **brief** (shortest summaries, the map), **detailed** (fuller chunk summaries), **smooth** (cleaned-up turns), **full** (verbatim recent activity). A compact decides how much of the thread lands in each band.

**Smart compact.** The explicit operation that produces a new thread view: it picks the band arrangement, renders from stored derivations, and stores the result as the active view. Compact never calls a model; it assembles what deriving already produced. Missing material degrades the entry — it never blocks the compact.

**Compact point.** Where the most recent compact stopped. Everything after it is the **tail** (or live tail): recent activity served verbatim alongside the view.

**Visibility boundary.** A per-thread marker in the tail that controls how tool results render: tool results behind it render short (their summary, or a truncation), tool results ahead of it render full. It advances in batches as tool output accumulates, never moves backward, and resets at compact. It affects only tool results — prompts, assistant text, and thinking always render full.

**Logging surface.** A cross-cutting technical surface, exposed externally from LHC, that both LHC and the host call to write info/warning/error logs into the thread's SQLite file. It carries diagnostics (such as a derivation falling back to a floor) that are collected for troubleshooting, not control flow. Distinct from the record: logs say what went wrong, the record stays what is usable.

**Degraded / gap.** What a view shows when a needed derivation is missing: a **degraded** entry renders the best available fallback (a cruder derivation, a deterministic floor, or raw content); a **gap** is an explicit placeholder where nothing usable exists. The fallback goes into the view (more content, not less) and the failure goes to the log; the record stays clean. Nothing is silently omitted.

**Render / materialize / LlmRequestContext.** Three ways view content leaves LHC: **render** is producing the output form of an entry; **materialize** is writing the view to a file in a provider's format; **LlmRequestContext** is the host-facing model context returned by `threadView.getLlmRequestContext`.

**Host.** The process that owns an SDK instance and everything LHC needs from the outside world: storage location, configuration, model access. PI extension now; app server later; possibly a wrapper CLI around another harness someday. One login — the host's — covers everything LHC does.
