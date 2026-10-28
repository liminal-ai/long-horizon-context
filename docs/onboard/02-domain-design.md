# Long Horizon Context: Domain Design

Last verified against code: 2026-10-27. Precedence when facts disagree: code, then README, then this doc.

This document describes each domain in more depth: what it stores, the operations it provides, and the other domains it calls. It builds on the vocabulary in 01-core-concepts.md.

## Domain surfaces

A domain is both a vocabulary area and a service surface. The operations a domain exposes are the same operations everywhere they are reached: the host calls them as SDK functions in-process, and other domains call them in-process when they need work the domain owns. When one domain needs something from another, it calls that domain's surface. It does not reach into the other domain's storage or internal modules. (Thread-view still has direct reads against derivation and event-aggregate tables as its own selection inputs; message, turn, and chunk material comes from the owner domains. The remaining direct reads are known cleanup debt, not a design choice.) One domain can coordinate a flow that spans several, the way `intake-stream` records a batch and calls `messages` and `turns` along the way, but the called domains keep ownership of their own work.

The SDK object returned by `initLhc` carries the domain namespaces `threads`, `intakeStream`, `messages`, `turns`, `retrieval`, `threadView`, `compactContinuation`, and `inspect`. It also carries the `logging` and `work` surfaces, the resolved `config`, the `scheduler`, and `drainSettled(ref)`, which resolves when no drain is running or pending for the thread.

## Shared-tech utils

Beneath the domains sit a small number of **shared-tech utils**: shared machinery that domains use but that owns no part of the conversation model. A tech util is not a domain. It has no domain surface and no vocabulary of its own in the product. It is internal plumbing. The logging surface is the one util exposed externally, but it owns no part of the conversation model. The dependency runs one way: domains use tech utils, and a util never calls a domain or contains domain logic. Shared-tech can carry domain-shaped identifiers and work-kind names as mechanism data, but the meaning of a turn, a chunk, or a summary stays the owning domain's business.

The **durable work queue** records background work as durable items in the thread's SQLite file. An item commits in the same transaction as the change that caused it, so queued work survives crashes. Items are processed one at a time per thread, head first (`ORDER BY rowid`). The drain loop claims the head item under BEGIN IMMEDIATE, runs the owning domain's handler with no open transaction, and completes in a second short transaction that writes the derivation and deletes the item. The handler may call inference or assemble deterministically depending on the derivation type. A claim is a lease (120,000 ms by default) fenced by claim attempt, so a stale holder's completion can never stamp a derivation that has moved on. An expired claim can be claimed once more. A second expiry fails the item.

Queue work is one shot. There is no retry budget and no backoff. A handler that fails, throws, or names an unregistered kind lands its derivations `failed` with the final reason, and the work item is deleted. Recovery is an explicit re-derive by the caller, never an automatic second attempt. Two properties carry the design: pending work is recorded durably, not held in memory, so a restart loses nothing; and a thread's queued work is ordered, so work queued by an edit lands after work already in flight on the old content.

Each kind of queued work has exactly one owning domain. The six kinds are `prompt_smoothing` and `tool_result_summary` (owned by messages), and `turn_derivation`, `detailed_turn_compression`, `chunk_summary_detailed`, and `chunk_summary_brief` (owned by turns). A domain queues its own work. It never queues work into another domain, and no domain watches for another domain's items. When a flow crosses domains, the crossing is a surface call, and the called domain queues whatever work its part needs. The queue owns the mechanics of an item: recorded, claimed, finished. What the work means belongs entirely to the owning domain.

Derivations carry state. The four states are one shared vocabulary across domains: `pending`, `ready`, `failed`, `blocked`. What a state means for a particular derivation stays the owning domain's call. State belongs to the derivation itself, never to its subject. Whether work for a derivation is still queued is the work queue's business, not a property the derivation duplicates. A domain's derivation report joins the two, so a caller asking "is this still coming?" gets the answer without reading queue mechanics.

The **inference adapter** bridges the host's model access into LHC's derivation handlers. Each derivation type that needs inference has a model assignment (provider, model, prompt template name). The adapter bounds large input before rendering, renders the prompt from the registry into a single-turn request, calls the host's function, and returns shaped text with config-known provenance. Empty or whitespace-only model output is rejected as `empty_output`. Host exceptions and timeouts are contained in `safeCall` (`shared-tech/classify.ts`): a throw becomes a failed result, and a slow host loses a timeout race. Failure reasons lead with a stable kind (`provider_failure`, `auth`, `invalid_request`) so callers switch on the kind, never on message text. Derivation types whose handlers assemble deterministically never reach the adapter.

The **prompt registry** is the name-keyed set of prompt templates (`shared-tech/prompts/`). Model assignments select templates by name. Versioning is in the name. The current defaults are `smoothing-v1`, `tool-result-v2`, `detailed-turn-compression-v3`, and `chunk-brief-v3`. Older versions stay in the registry for hosts that pin them. Adding or replacing a template for an existing derivation type is a module addition; no handler or adapter changes are needed. A new derivation type would require handler, config, and adapter work.

Two built-in model-call lanes ship in shared-tech for hosts that want them: a `claude -p` lane (`shared-tech/inference-claude-cli.ts`, with the default derivation assignments) and the summary-worker request shaping (`shared-tech/summary-worker.ts`) that keeps derivation calls free of the host's tools and settings. Hosts can also supply their own `ModelCall` or the four callbacks directly. `createDeterministicInferenceCallbacks()` supplies model-free callbacks for tests and no-inference hosts.

The **scheduler** manages per-thread drain scheduling in background mode. Post-commit pokes trigger drains. First-touch catch-up drains process leftover work from previous process lifetimes. Scheduling is per-thread single-flight with pending-flag coalescing: at most one drain runs per thread, with at most one pending pass queued behind it. One wake timer per thread covers claim expiry. In manual mode the scheduler is inert. The host must call `work.drain` explicitly to process queued work. Background scheduling is gated on a non-empty handler map, fail-closed: with no handlers a drain could only turn queued rows into terminal failures, so pokes and catch-up stay inert until a handler table is populated.

The **instance seam** isolates multiple SDK instances in the same process. Every SDK operation runs inside its instance's async-context scope, so enqueue pokes and thread-file touches reach that instance's scheduler, not another's. A manual SDK's operations deliver pokes to a no-op seam, so a background SDK in the same process can never auto-drain the manual SDK's work. The seam also carries the instance's resolved view config and token estimator.

Local **token counting** stamps `o200k_base` estimates on messages when they are created and on derivations when they land (`shared-tech/token-counting/`). The stored count is the unweighted o200k count. Budgets, band math, and receipts use billed-token estimates: the stored count times the text weight of the instance's tokenizer family. The family is named in the SDK config (`tokenFamily`, a slug such as `o200k`), and hosts can overlay their own family table. The count is stored once and is stable and reproducible: the same text under the same family always yields the same number.

**Logging** is a cross-cutting technical surface that, unlike the other utils, is exposed externally from LHC. Both LHC and the host write info, warning, and error logs through it, stored in the thread's SQLite file. A separate derivation log (`queryDerivationLog`) keeps one append-only row per derivation attempt, with the full request and response. Writes are fail-soft: a failure never propagates and never shares the caller's transaction. The record stays what is usable. The log says what went wrong.

Database handles open fresh per operation. There are no pools or cached connections. Pure reads run touch-suppressed, so a read never triggers background work in a background-mode instance. Every open sets the same pragmas: WAL journal, foreign keys on, `busy_timeout` 5000, synchronous NORMAL.

## Threads

A thread is the durable container for one ongoing conversation. The `threads` domain creates threads, tracks where they live, and gives the rest of the system a way to find a thread by id or by host alias. Two SQLite databases sit behind it:

- A listing of all threads is stored in a **thread registry** database (current registry schema v2), with one row per thread holding its id, file path, optional title, optional cwd, and creation timestamp. The registry also holds the alias map: host-qualified session ids (`claude-code:<uuid>`, `t3code-lhc:<uuid>`) bound to threads, with one current alias per thread.
- Each thread's own database holds that thread's full record: its events, messages, turns, chunks, views, blobs, and impressions. Reading or changing a thread's contents means opening its file.

The thread file is authoritative for its own identity. It stores its thread id once, as identity metadata. The records inside it (events, messages, turns) do not each carry the thread id, because the file is the thread. The thread registry is a convenience lookup over the thread files, not the authority.

Thread files are schema-versioned (current version 13) and migrate forward on open, so a file written by an older build is brought current the first time a newer build touches it. An unsupported version is refused before use. An old thread file is not stranded when the schema moves.

### Creating a thread

`newThread` creates a thread at a given file path, sets up the empty thread inside it (including seeding one open turn), and adds a row to the thread registry. It generates a thread id (`th_` plus 16 hex chars) and records the id-to-path mapping. If a file already exists at the path, the operation fails with `path_exists` instead of touching it. Creation spans two databases that cannot share a transaction. The order is file-then-row, so the invariant "no registry row without its file" is absolute. An orphan file from a crash between the writes is harmless.

```mermaid
sequenceDiagram
  participant C as user or harness
  participant T as threads
  participant F as thread file
  participant R as thread registry
  C->>T: newThread (file path)
  T->>F: create thread file (schema + metadata + open turn)
  T->>R: add row (id, file path)
  T-->>C: thread id
```

### Finding a thread by id or alias

A thread id is the primary, stable key a caller holds. It survives the thread file moving, which a file path does not. Other domains work with thread references (`ThreadRef`), which can be `{ threadId }` or `{ filePath }`. When a domain needs to act on a thread, it asks the threads domain to resolve the reference to a file path, then opens it. Resolution from a thread id accepts a full or partial (prefix) id: an exact match wins outright; a unique prefix resolves; an ambiguous prefix fails naming the collision. Nothing auto-creates a thread on a failed lookup.

Hosts find threads by alias instead. `registerAlias` and `registerCurrentAlias` bind a host session id to a thread. `resolveAlias` returns the thread a session belongs to. `currentAlias` returns the thread's current session alias. A thread accumulates many native session ids over its life. The alias map is how a later launch through any older alias lands on the thread's current session.

```mermaid
sequenceDiagram
  participant D as a domain with a ThreadRef
  participant T as threads
  participant R as thread registry
  participant F as thread file
  D->>T: resolve ThreadRef to file path
  T->>R: look up id (exact or prefix)
  R-->>T: file path
  T-->>D: file path
  D->>F: open and act on the thread
```

### Browsing threads

A user who wants to see their threads starts at the threads domain. `listThreads` lists threads from the registry, optionally filtered by cwd. `resolve` looks up a thread by id. `info` reads the thread file's own identity metadata (thread id, creation timestamp, schema version). From a list, a user picks a thread and drills into its messages, turns, or views through the other domains.

### Copying, forking, and repairing threads

The threads domain also carries the cross-home operations (`threads/fork.ts`). `copyThread` copies a thread file into another home and registry, optionally under a new id. `bindHost` binds the copy to a session id on the target host. `writeIdentityNote` records where the copy came from. `repairDerivations` re-derives failed derivations under a named token family. `exportHistory` returns the thread's history in a portable shape. The `lhc thread` command line (`copy`, `bind`, `note`, `health`, `repair`, `export`, `fork`) composes these operations. A fork between hosts on different providers compacts the copy under the `handoff` profile, so no closed turn survives raw and the target host never renders the source host's tool blocks.

## Intake stream

As a harness runs it produces a stream of events. An event is one recorded thing that happened in the thread. The closed vocabulary (`EVENT_KINDS` in `intake-stream/internal/validate.ts`) has ten kinds:

- `user_prompt`: a prompt from the user, or an automated prompt that stands in for one
- `assistant_text`: assistant output text
- `assistant_thinking`: assistant reasoning
- `tool_call`: a tool invocation
- `tool_result`: the result of a tool invocation
- `model_change`: a switch from one model to another
- `thinking_level_change`: a change in the thinking level
- `runtime_note`: a note from the harness or runtime
- `compact_continuation_marker`: the durable boundary a mid-turn compact writes before the turn continues over the rebuilt view
- `turn_end`: a marker that the current turn is complete

The `intake-stream` domain takes these events in and writes them into the thread in the order they happened. It is the only way thread content enters the system from a harness.

These flows are about how data moves, not about a user interface. As it records the stream, `intake-stream` calls `messages` to create the readable message-and-block view and calls `turns` to apply the turn state machine. Those calls are in-process calls to the domain surfaces, not separate service hops.

A thread is single-threaded by definition: one conversation, one stream. The design model is one ordered time series per thread, which lets boundary decisions be made from position in that stream.

### The stream contract

The harness owns sending a coherent stream. The domain does not reconstruct order or membership from a malformed stream. It records what it is given, in the order given, and fails loudly when the stream implies an impossible state.

The contract:

- send events in the order they happened
- send a `turn_end` when a turn is complete
- there is always exactly one open turn at any time

Validation is closed and runs before any write. Every payload layer is a closed schema decoded with excess-property errors, so unknown fields are rejected structurally. Server-generated field names (`eventOrder`, `recordedAt`, `threadEventId`, `schemaVersion`) are denied by name with their own reason. A rejected batch costs no write lock.

### Taking in events

A harness sends a batch of one or more events for a thread. The thread reference rides outside the batch, since every event in a batch belongs to the same thread. The host calls the SDK operation with typed event objects directly (`intakeStream.messageEvents(threadRef, events)`).

The domain resolves the thread reference to its file through the threads domain, then writes the batch to the thread's database in one coherent write flow. For each event it assigns the next position in the thread's order and records the source event. For events that produce readable conversation activity, it calls the `messages` surface to create messages and blocks. For events that affect turn state, it calls the `turns` surface to apply the turn state machine. It returns a result describing what happened to each event.

Events can carry Messages API content blocks verbatim (`blocks` on `user_prompt` and `tool_result`, `block` on `assistant_thinking` and `tool_call`). Binary payloads in those blocks — base64 image and document bytes, redacted-thinking data, encrypted search content — are extracted into the thread's blob table at intake, keyed by content hash (`intake-stream/internal/blobs.ts`). The stored block keeps the API shape with a `{ $blob, bytes }` reference in place of the string. Text paths never carry base64.

Three capture-fidelity details ride the event payloads. `assistant_thinking` carries an optional opaque provider **signature** alongside its text: captured verbatim, never interpreted. Empty-but-signed thinking is a real event and is recorded. Assistant events carry the **model identity** (provider, model, API) that produced them, supplied by the host from the request it actually prepared, never re-derived from mutable session state. Signed reasoning can then be replayed on resume strictly under an exact identity match. `assistant_text` can carry host-observed provider usage, and step-bearing kinds can carry a host-supplied **step index**. LHC records both verbatim and never infers either. Step indices are what mid-turn compact splits on.

```mermaid
sequenceDiagram
  participant H as harness
  participant I as intake-stream
  participant T as threads
  participant M as messages
  participant U as turns
  participant F as thread file
  H->>I: messageEvents (ThreadRef, events)
  I->>T: resolve ref to file path
  T-->>I: file path
  I->>F: record source events
  I->>U: apply turn state machine
  I->>M: create messages and blocks
  I-->>H: per-event result
```

Events carry an idempotency key from the harness. Idempotency is thread-scoped, and the key wins over content: if an event with the same key was already recorded for the thread, the resend is skipped rather than written twice, and the skip consumes no order number. A harness that resends a batch after a failure does not produce duplicates.

### Turn boundaries are decided here, synchronously

Turn boundaries are decided in the hot path, as events land, while intake is the thing watching the ordered stream. `intake-stream` calls the `turns` surface to apply the turn state machine and get the turn membership for message-producing events. This keeps membership correct: a message is attached to its turn when it is recorded, not inferred later against a stream that has moved on.

The deterministic work is synchronous: recording events, calling `messages` to create messages and blocks, calling `turns` to apply the state machine, attaching messages to the current turn, and assigning token estimates. Smoothed prompts and tool-result summaries are queued as durable work when each message lands. Turn derivation is queued when the turn closes. `detailed_turn_compression` is enqueued in the turn-derivation handler's completion transaction. Chunk summaries are enqueued when chunk placement closes a chunk in that same transaction. Closing a turn settles its membership immediately. The derivation work that follows operates on a turn whose contents are already frozen.

There is always exactly one open turn. Thread creation seeds the first open turn. A `turn_end` with members closes the current turn, queues its derivation work, and immediately opens a new empty turn. A `user_prompt` arriving when the current open turn already has members does the same: closes the current turn, opens a new one, and the prompt becomes the new turn's first member. A `turn_end` with no members is a no-op — the empty open turn stays open. A `user_prompt` arriving into an empty open turn simply becomes its first member. No close happens.

| Event | Current open turn | Action |
| --- | --- | --- |
| `user_prompt` | has no members | prompt becomes first member of current turn |
| `user_prompt` | has members | close current turn (+ queue work), open new turn, prompt is first member |
| `turn_end` | has members | close current turn (+ queue work), open new empty turn |
| `turn_end` | has no members | no-op |
| any other event | — | add to current turn |

More than one open turn is a hard error during this phase. An invalid thread is caught and triaged instead of producing quietly wrong turns later.

### What the result reports

The result reports, per event, whether it was recorded or skipped as a duplicate. An invalid batch returns an `OpResult` error and rolls back the entire transaction, so a batch either lands cleanly or not at all. The result also reports turn transitions that the batch opened or closed, and queued work items.

## Messages

A message is the readable form of activity in a thread. The `messages` domain owns the message-and-block view of the conversation. It creates that view from source events, lets callers read it, and provides the place where later message-level edits and deletes happen.

Events and messages are different records. Events are the ordered source stream received from a harness. Messages are the normalized view created from those events so the rest of the system can read, list, edit, group, and assemble thread history. A `turn_end` changes turn state but does not produce a message. Every other kind does, including `compact_continuation_marker`.

### Creating messages

`intake-stream` calls the `messages` surface as it records incoming events. The message operation creates a message for events that should appear in the readable conversation and creates the blocks that belong to that message. It also stores the token estimate for the message's original content. Message ids are deterministic: `m` followed by the event's order number. Projection copies source payloads verbatim. Compression is decided later, never at intake.

```mermaid
sequenceDiagram
  participant I as intake-stream
  participant M as messages
  participant F as thread file
  I->>M: create message from recorded event
  M->>F: write message and blocks
  M-->>I: message id and token estimate
```

### Messages and blocks

A message represents one meaningful piece of conversation activity: a user prompt, assistant text, assistant thinking, a tool call, a tool result, a model change, a thinking level change, a runtime note, or a compact-continuation marker. Each message contains one or more typed blocks. Block 0 is always the projected block, one of `text`, `tool_call`, `tool_result`, `model_change`, `thinking_level_change`, or `compact_continuation_marker`. Most message kinds — user prompts, assistant text, assistant thinking, runtime notes — project to a `text` block. Tool calls, tool results, model changes, and thinking level changes each project to their own block type. When the source event carried Messages API content blocks, they follow as blocks 1..n under their API type names (17 types, listed in `shared-tech/content-blocks.ts`), with binary payloads held as blob references.

### Message-level derivations

Some derivations belong to a single message and need nothing beyond it, so `messages` owns them and queues their work the moment the message lands, without waiting for a turn to close. Only user prompts and tool results enqueue message-owned work at landing.

A user prompt gets a `smoothed_prompt` derivation: cleaned and attenuated with its content preserved, queued when the prompt lands. The deterministic cleaning runs first. If the cleaned text exceeds the configured token threshold (`guards.smoothedPrompt.maxInferenceTokens`, default 700), or the whole prompt is one short bracketed harness marker, the cleaned text itself becomes the derivation without calling inference. Smoothing also carries a safety floor. If the inference output shrinks below a configured ratio of the cleaned input (`suspiciousOutputRatio`, default 0.15), the model output is discarded and the deterministic cleaned text is stored instead, with a warning log. Smoothing can attenuate a prompt but never eat it.

A tool result gets a `tool_result_summary` derivation. The full output is stored when its message is created and is never discarded. Inference summarization is currently forced off (`FORCE_TOOL_RESULT_SUMMARY_FALLBACK` in `messages/internal/handlers.ts`): every tool result gets deterministic 500-char truncation instead (`FALLBACK_TRUNCATION_LIMIT` in `shared-tech/tool-result-rendering.ts`). The dormant inference path is tiered by size: a result at or below the `smallTierTokens` threshold (default 1000) is stored verbatim with no summary pass, and a larger result is classified (operation class, response shape, prompt mode) and queued for inference. Every tool-result summary states its outcome mechanically — succeeded, failed, or unknown — stamped from the record, never authored by model text.

Tool calls are kept as-is, not summarized. Call arguments are usually short, so no separate derivation pass is needed.

### Token estimates

Each message is stamped with a token estimate of its original content when it is created, in the same synchronous step that writes the message. Stamping on creation means every message carries a size the moment it lands, with no later counting pass. A turn's size is the sum of its messages' estimates as soon as the turn closes. The stored estimate is the unweighted `o200k_base` count. Readers that work in budgets weigh it by the instance's tokenizer family.

### Reading messages

The messages domain lists and shows messages for a thread. It is the lowest-level human-readable view of the conversation.

- `list` returns messages in record order, with optional bounds (from/to event order), a limit, an opt-in to include deleted records, and `forUserChat: true`, which hides typed compact-continuation markers. Hosts rendering ordinary user chat must pass `forUserChat`: markers stay in the record and in model views, but they are not chat.
- `show` returns a single message with its complete blocks, full content, and its derivation report entries with queue-joined state.
- `report` returns derivation state for a set of messages without their content.

Reads surface stored state. They never repair, derive, or block on missing work.

```mermaid
sequenceDiagram
  participant C as host UI or agent
  participant M as messages
  participant T as threads
  participant F as thread file
  C->>M: list or show
  M->>T: resolve ref to file path
  T-->>M: file path
  M->>F: read messages and blocks
  F-->>M: message records
  M-->>C: messages
```

### Editing and deleting messages

Manual cleanup goes through messages, not `intake-stream`. Intake-stream records new activity from a harness. Messages is where a person or agent can later correct or prune the readable conversation record. Two operations do this: `edit` changes a message's content, and `remove` removes a message from the readable record. Both target closed turns only. The open turn is the live exchange and stays out of reach. Closed turns are otherwise immutable: no writer changes their membership.

`remove` is a soft delete. The message drops from reads and from its turn's membership, but the source events it was created from stay in the event log. The record underneath is never destroyed. An audit read with the deleted opt-in still surfaces the message, marked deleted. Removing a message that initiates a turn (the prompt) is refused. The `remove` surface handles individual non-initiating messages only.

An edit runs the same way creation does. The deterministic work happens synchronously: the message and its blocks are updated and the token estimate is re-stamped. Derivations built from the old content are cleared and their work is queued again by the domains that own them, each at the next source version, so a late-finishing pre-edit derivation is discarded as stale. An edit never leaves an old derivation in place to be judged against new content later.

A remove cascades the same way, with one difference: the removed message's own derivations drop rather than re-queue, because their source is gone, while everything composed above it rebuilds. The cascade is a structural walk, not a hardcoded list, and it joins tool call/result counterparts. The cascade is bounded by structure: a message affects its turn's composed rendering, and that turn's containing chunk re-derives its detailed and brief summaries. Neighboring chunks never re-derive, and chunk boundaries never move. A chunk shrinks in place, never re-cut.

### Synchronous derivation

In addition to the background queue path, the messages surface exposes `derive`: a synchronous operation that runs derivation work inline for a list of message ids. It shares the queue machinery — claim the work item, run the handler, write the result — and returns immediately if equivalent work is already in flight. This is available for callers that need a derivation now rather than waiting for the background drain.

## Turns

A turn is one exchange in a thread. In the normal harness stream it starts with a `user_prompt`, or an automated prompt that stands in for one, and includes the assistant text, assistant thinking, tool calls, tool results, model changes, thinking level changes, and runtime notes that follow. A compact-continuation marker can also land inside it. A turn closes when a `turn_end` arrives with members, or when the next `user_prompt` arrives and the current turn has members.

The `turns` domain owns turn state, turn records, and turn-based containers such as chunks. It exposes the operations that apply the turn state machine during intake, and it derives closed turns into the representations that later feed bands and thread views.

### The turn state machine

`intake-stream` calls the `turns` surface as it processes incoming events (`turns.create` on the caller's transaction). The turn state machine maintains the invariant that exactly one open turn exists at all times. The result tells intake which turn a message-producing event belongs to.

```mermaid
sequenceDiagram
  participant I as intake-stream
  participant U as turns
  participant M as messages
  I->>U: apply turn state for event
  U-->>I: current turn membership
  I->>M: create message with turn membership
```

Closed turns are structurally immutable: no writer changes a closed turn's membership. Message edits and removes inside a closed turn rebuild its derivations, never its roster.

The domain also reads turn **steps**: the host-supplied step indices on a turn's events, grouped into complete step edges (`readTurnSteps`, `readActiveTurnSteps`). Mid-turn compact splits an open turn only at complete, host-recorded steps. A turn with no step edges cannot split.

### Deriving closed turns

Closing a turn makes its membership stable. The work that follows runs after the close and is queued durably in the same transaction:

- **`turn_derivation`** (one work item) deterministically produces **`turn_rendering`** and **`pre_detailed_assembly`** in one completion transaction. `turn_rendering` composes the turn's activity from its message-level derivations: smoothed prompts and tool-result summaries where ready, deterministic floors where they are not. Tool calls and results that form a consecutive stretch are composed into a single run-level account that names the tools, counts the calls, and tallies the mechanical outcomes. The rendering wraps the turn in its stable `<tN>` label with `<mN>` labels on each message, and truncated members carry their full stored token count in the truncation marker — the addresses and sizes the retrieval domain resolves. `pre_detailed_assembly` strips the same turn to dialogue only (`user_prompt` and `assistant_text`) for compression input; labels are stripped from compression input. Below the smooth band, tool activity survives only as the assistant's own narrated account.

- **`detailed_turn_compression`** (a separate work item, enqueued in that same completion transaction) is the inference-backed compression of the `pre_detailed_assembly`, not the turn rendering. This is the slow work. The rendering and assembly above are deterministic and fast. A turn whose assembly is below the tiny-turn threshold (`guards.detailedTurnCompression.tinyTurnTokens`, default 80) skips inference: the assembly text itself lands ready as the compression. A failed compression call also lands the assembly text ready, with the failure recorded in the derivation metadata and the derivation log. The band gets a floor, never nothing. The smooth band serves `turn_rendering` at full texture. `detailed_turn_compression` is only a degraded fallback when rendering is missing.

The `turns` surface exposes `report` (derivation state for a turn or chunk), `deriveTurn`, `deriveDetailedChunk`, and `deriveBriefChunk` (synchronous derivation through the same claim machinery), and `backfillRenderingLabels`, which recomposes stored legacy `turn_rendering` rows with `<tN>`/`<mN>` labels. Backfill performs no inference, changes no canonical events or source versions, queues no work, and reports missing or failed renderings instead of repairing them silently. There is no re-queue operation: a failed derivation is recovered by deriving again explicitly.

### Chunks

A chunk is a container of turns. Chunks let the system group multiple closed turns into larger units that can be summarized and placed into lower-fidelity bands. Turns are the base unit. Chunks are the next container above them. A turn never splits across chunks.

The `turns` domain owns chunk formation because chunking depends on turn order, turn size, and projected pre-compression token counts. Turn derivation, composition, and chunk recovery live in `turns/internal/derive.ts`, `turns/internal/compose.ts`, and `turns/internal/chunk-recovery.ts`. Closed turns accumulate into the current open chunk. The chunk close policy is a deterministic arithmetic check against configured thresholds (`targetProjectedTokens` / `maxProjectedTokens`, built-in defaults 2200 / 4400) over stored projected token counts, weighed by the instance's token family. Identical streams produce identical chunk boundaries across restarts. Chunk placement — assigning a turn to a chunk — happens inside the turn derivation handler's completion transaction, because the projected count does not exist earlier. A crash leaves either a placed turn with its enqueued summaries or nothing, never a derived-but-unplaced turn. Once placed, membership is immutable. Deletes shrink a chunk in place.

A closed chunk gets two derivations, queued in the completion transaction:

- **`chunk_summary_detailed`** is a deterministic assembly from member `detailed_turn_compression` content (dialogue-derived). It keeps the texture of what happened: what was changed and whether it succeeded.

- **`chunk_summary_brief`** is an inference-backed summary over the stored detailed summary. It keeps outcomes only. What ages out first is the activity's texture, never its result.

Both carry derivation state and can be checked through `turns.report`. `getChunkText` reads a chunk's stored detailed or brief content directly. Chunk summaries wait on their inputs: if a member's `detailed_turn_compression` (or the chunk's own detailed summary, for the brief) is not ready, the handler defers — the claimed item is deleted and re-enqueued behind its prerequisite. Deferral is dependency ordering, not failure retry. If the input is blocked, the chunk summary lands blocked.

### Reading turns and chunks

The turns domain lists turns and chunks for a thread (`listTurns`, `listChunks`). Agents and users use these operations to inspect the conversation at a higher level than individual messages. Thread-view uses them when it needs turn and chunk material for context assembly. Each record carries its derivation states alongside it.

```mermaid
sequenceDiagram
  participant C as host UI or agent
  participant U as turns
  participant T as threads
  participant F as thread file
  C->>U: list turns or chunks
  U->>T: resolve ref to file path
  T-->>U: file path
  U->>F: read turns and chunks
  F-->>U: turn and chunk records with derivation states
  U-->>C: turns and chunks
```

## Thread view

A thread view is a summarized, harness-ready rendering of a thread. It holds enough of the conversation for an agent to resume work without the full history: recent activity at high fidelity, older activity compressed into shorter representations. The `thread-view` domain stores compact snapshots and serves them with the live tail. Its SDK operations are `getLlmRequestContext`, `getSessionThreadView`, `status`, `describe`, `hostMetadata`, `prune`, `previewCompact`, `prepareCompact`, `installPreparedCompact`, `previewProtectedBoundary`, `midTurnCompact`, `compact`, and `materialize`. Internally the domain spreads across `thread-view/index.ts` and `thread-view/internal/` (`select.ts`, `compact-compute.ts`, `compact-algorithm.ts`, `assemble.ts`, `boundary.ts`, `protected-boundary.ts`, `session-view.ts`, `render.ts`, `snapshot.ts`, `materialize.ts`, `host-metadata.ts`, and `profiles.ts`, which holds the built-in compact profiles). A harness either loads a view that LHC has written to a file or asks LHC for the current `LlmRequestContext` directly.

A view is a rendering, not a second copy of the conversation. It is assembled from records the other domains already own: messages, turns, chunks, and the derivations derived from them. Producing a view never changes the canonical history. It selects and arranges what already exists.

### Bands

A thread view is arranged in bands of decreasing fidelity, from the most recent activity down to the oldest:

- **full**: recent turns and messages served live from the record (the tail)
- **smooth**: turn renderings at full texture (`detailed_turn_compression` is a degraded fallback when rendering is missing)
- **detailed**: detailed chunk summaries
- **brief**: brief chunk summaries — the compressed floor of the view

The bands are a gradient, not a cliff. As a turn ages it moves down a band, losing fidelity in steps instead of dropping out of the view all at once. The recent end stays sharp for the work in progress. The old end stays cheap while still carrying the shape of what came before. Bands serve as labeled user-role messages, because inference APIs constrain roles.

Of the four tiers, three — brief, detailed, and smooth — are rendered and stored as snapshot text by a compact. The full tier is not stored. Compact uses its percentage to determine where the compact point falls, and everything after that point is served live. The tail never begins mid-turn: the compact point snaps forward to a turn boundary. A profile also protects the newest closed turn: by default 0.6 of the lower bound is reserved so the most recent closed turn can stay near-full texture. The `handoff` profile sets that protection to 0.

### Generating a view

Generating a view — the operation a user or host invokes as a **smart compact** — sets the band arrangement for the whole thread: which turns and chunks fall into which band, rendered into a current view. It takes a profile (a lower bound in tokens and percentages per band; built-ins `continuation`, `conversation`, `coding`, `handoff`, each at a 120,000-token lower bound) and works by selecting artifacts the other domains have already derived, not by recomputing them. Compact never calls a model. It is assembly, not summarization.

Compact is an explicit operation, invoked by the host or caller. It does not run on a timer or automatically after turns close. The `threadView.status` operation reports whether a compact is recommended, based on the tail's token count against the configured threshold (default 160,000), but nothing triggers compact automatically. An explicit compact executes: no "nothing new" gate second-guesses the caller.

`compact` is prepare-and-install in one call. Hosts that need the seam can call `prepareCompact` and `installPreparedCompact` separately, and `previewCompact` to see the outcome without installing. Before assembly, compact reads record and derivation state as it stands. It does not call providers, schedule repair work, or re-queue failed derivations. It does not validate canonical coherence either: a record the walk cannot place — a message or a chunk member whose turn does not resolve — is skipped and named in the compact receipt's `skippedRecords`, and its raw row stays exactly as it is. Compact reads around the irregularity. It never repairs or removes it. Every closed turn behind the compact point is represented in the view or explicitly gapped. Silent dropping is the failure this invariant exists to prevent.

Installing a prepared compact is one transaction that both looks and writes. If the thread moved between prepare and install — new events, changed turn or chunk structure, derivations that finished, edited source content, a moved visibility boundary — the compact is reassembled against durable state under the same lock that installs it, and that fresh assembly is what lands. Drift never refuses the install and never installs the stale snapshot. The receipt and the stored view always describe the state the view was built from. A genuine failure still leaves the prior view serving.

When a band entry depends on a derivation that is not ready, compact does not stop. It walks a fallback ladder: the smooth band tries `turn_rendering`, then `detailed_turn_compression` (marked degraded), then a deterministic excerpt of the turn's messages, then a gap. The detailed and brief bands try their primary chunk summary, then a concatenation of stored member material, then a gap. A gap is always the last resort, never the first response to a missing derivation. Chunk stored-member fallbacks are warning-logged. All degraded entries and gaps are recorded in the compact receipt and the stored view metadata.

```mermaid
sequenceDiagram
  participant C as user, agent, or harness
  participant V as thread-view
  participant T as threads
  participant U as turns
  participant M as messages
  participant F as thread file
  C->>V: compact
  V->>T: resolve ref to file path
  T-->>V: file path
  V->>U: read turns, chunks, derivation states
  V->>M: read message material for selection
  V->>F: write the view snapshot
  V-->>C: compact receipt
```

`midTurnCompact` is the compact entry point that asserts the host's capture seam. It can split the open turn into parts at complete, host-recorded steps, so the already-settled part compacts and the live part continues. `hostMetadata` is the read a host uses to decide: the open turn's step facts (size, complete steps, whether it can split) composed with the installed view's transition turn. `previewProtectedBoundary` shows where a boundary would land for a set of protected tool calls. The staged cross-host runtime built on these operations is the compact-continuation domain, below.

### Assembling the active model context

The context a harness consumes is assembled from the stored view snapshot (brief, detailed, and smooth bands) plus the current tail of recent messages. A never-compacted thread is just the snapshot-absent case of the same path. Assembling the context is deterministic local work — reads and rendering — with no inference calls. An extensible harness can load `LlmRequestContext` without paying to re-derive anything.

Assembly selects already-derived artifacts. It does not create missing ones. If a band depends on a derivation that has not been derived yet, or that failed, the stored snapshot carries whatever the last compact wrote — degraded entries or gaps — and serves that.

Degrading is visible by obligation. A gap in band material renders as a marked gap in the view, so the agent reading it knows a stretch of history is thinner than it should be. The view never silently drops a span of the thread.

`getSessionThreadView` serves the same assembly in host-session shape: the entries a host needs to seed or rebuild its own session file, including signed thinking where identity allows replay. Empty unsigned thinking is skipped at both serving exits. Empty signed thinking serves.

```mermaid
sequenceDiagram
  participant H as harness
  participant V as thread-view
  participant F as thread file
  H->>V: getLlmRequestContext
  V->>F: read stored bands and tail messages
  F-->>V: band snapshot and recent messages
  V-->>H: model context
```

### Tool results in the model context

Before an explicit smart compact, tail tool results render in full so resume and session-view stay faithful to the record. Smart compact is the planned reduction point for older material, via bands.

The **visibility boundary** controls at-or-behind shortening when it is set: tool results at or behind it render as a short truncation (500 characters plus a truncation marker), tool results ahead of it render full. Three things move the boundary: compact resets it to the compact point; **prune** (`threadView.prune`) advances it independently; intake never moves it. The boundary shortens only tool results. Prompts, assistant text, and thinking always render full.

Prune walks live tool results newest-first from the current boundary, keeps results full until the target token budget is met, and sets the boundary behind the last full result. It never moves the boundary backward or behind the compact point. The typical use is reclaiming context space from old tool outputs between compacts without the cost of a full compact cycle.

### Rendering for a harness

The same assembled view renders in more than one form. An extensible harness that can take its context from LHC asks for `LlmRequestContext` as an in-memory message array. A closed harness that reads only its own session file gets the view written into a host-specific file format via `threadView.materialize` (today PI session JSONL, the only accepted format). A host can also build its own format from the served view, as cc-lhc does when it rebuilds Claude Code rollout files and claude-lhc does when it writes a native session file. Both come from the same serving assembly. Only the output shape differs. A written file is a materialized rendering of the view, not a second source of truth: the thread file remains authoritative.

## Compact continuation

The `compactContinuation` domain (`compact-continuation/`, contract machinery in `shared-tech/compact-continuation/`) is the staged runtime for compacting in the middle of an agentic turn. It exists for hosts that can replace the live model request: the turn keeps going over a rebuilt view instead of ending at a context cliff.

`runCompactContinuation` runs one attempt against thread state. The host supplies its trigger decision and host facts (`validateHostFacts` checks them). The runtime proves the pending tool pairs survive the boundary (`provePendingToolPair`, `proveProtectedToolPairSet`), writes a `compact_continuation_marker` event into the record through intake, installs the compacted view, and records a durable receipt. Attempts carry a stable operation identity. A completed attempt replayed with the same identity returns the stored receipt without mutating anything. The same attempt id with a different identity conflicts.

Crash recovery is part of the surface. A host that restarts reads the writer claim (`getCompactContinuationWriterClaim`), any pending boundary (`getPendingCompactContinuationBoundary`, status `pending`, `complete`, or `failed_repairable`), and the stored attempt intent (`getCompactContinuationAttemptIntent`), then re-enters with the same attempt id. Stage history is append-only (`listCompactContinuationStages`). The host reports its own validation back through `recordCompactContinuationHostValidation`. The full protocol is documented in the header of `compact-continuation/index.ts`. Read it before wiring a host.

Capability differs by host, by design. The Codex fork runs the full continuation state machine. Claude Code has no mid-turn request-replacement seam, so cc-lhc never calls this domain: it measures and classifies pressure, receipts open-turn crossings without mutating, and compacts at settled boundaries. Do not infer parity from shared fixtures. The cross-host capability matrix is [`docs/compact-continuation-certification.md`](../compact-continuation-certification.md).

## Retrieval

Retrieval resolves stable ids back to content, on demand, under explicit budgets. It is the read-side complement of compression: bands make history small; retrieval makes any part of it exact again. The domain owns two serving operations, one log read, and one table.

### The operations

`retrieval.getTurns(threadRef, ids)` serves turn renderings: the same labeled composition the smooth band serves, read from the stored derivation or freshly composed when the stored rendering predates labels. `retrieval.getMessages(threadRef, ids)` serves verbatim message content from the record. Both take ids in the caller's order and walk them under a token budget: items that fit are served whole; the item that crosses the budget is served as an exact token slice with a receipt naming the window (`[fromToken, toToken)` of the total) and the offset to continue from; items after the budget is spent get a refusal receipt naming their size, so the caller can re-request them alone. A `fromToken` option slices every requested item from that offset — the single-id continuation contract. An optional `byteBudget` additionally bounds served bytes, for hosts whose machinery truncates tool output by bytes; byte-bound slices are exempt from the minimum-slice floor, and no slice ever splits a multi-byte character. Requests are capped at 32 ids per call (`MAX_RETRIEVAL_IDS_PER_CALL`). Over-cap requests refuse whole with a receipt naming the cap.

Validation is strict and cheap: id shape is checked before any read, and invalid requests refuse before the SDK touches storage.

### Impressions

Every id requested through a retrieval operation writes one **impression** row in the thread file (the `retrieval_impression` table, arrived at thread schema v6; current schema v13): the id, the requesting surface, whether it was served, at what size, under which call. An impression means the SDK served the content into a result. It is an upper bound on model exposure, not a delivery receipt. Downstream signals (restatement, follow-up pulls) are the delivery-weighted evidence. Impressions are written in the retrieval transaction and nothing on the serving path reads them. `retrieval.listImpressions` reads the log back for analysis.

### What hosts add

The domain returns content and receipts. Hosts own the tool surface. A host registers `get_turns` / `get_messages` as model-callable tools, passes its own output limits through the budget options, wraps served content in an explicit historical envelope (so a recalled prompt reads as a record, never a live instruction), and keeps receipts and continuation guidance outside the envelope as live text. Tool calls and their results enter the record through normal capture like any other tool activity. Retrieval never appends conversation events of its own.

## Inspect

Inspect answers questions about a thread without changing it. The `inspect` domain produces three reports:

- **overview** — thread identity, event/message/turn/chunk counts, derivation state counts across both owners, the active view summary (or null if never compacted), and visibility boundary state. Deleted messages count separately. They are excluded from visible counts and token sums.

- **health** — derivation counts by owner, kind, and operational state; actionable failure detail (reason, attempts, last error) for failed and blocked derivations; a repair preview of currently failed (non-blocked) derivations that a re-derive would target; and live queue visibility (queued vs claimed items).

- **view** — the stored view snapshot from `threadView.describe` (arrangement, gaps, config, per-band stored token counts, source-state provenance) plus the serving cost measured by running `threadView.getLlmRequestContext` and counting its output with the shared estimator. This makes the reported cost structurally identical to what an agent would receive.

Inspect is read-only and reads through the other domains' surfaces. It never writes, repairs, derives, or schedules work. It reports on whatever a person or agent asks and changes nothing.

```mermaid
sequenceDiagram
  participant C as host UI or agent
  participant N as inspect
  participant D as messages, turns, thread-view
  participant F as thread file
  C->>N: overview, health, or view
  N->>D: read through domain surfaces
  D->>F: read records
  F-->>D: records
  D-->>N: domain data
  N-->>C: report
```



