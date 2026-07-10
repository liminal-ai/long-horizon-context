# Decision Registry

Current-state decisions in force across `lhc` and `pi-lhc`, compiled from a two-model excavation (Fable, gpt-5.5) + adversarial cross-review + convergence round (2026-07-02). Entries not yet reviewed by Lee are **candidates, not rulings** — the ratification pass may correct any of them.

Maintenance: update entries in place; a superseded decision gets one line in its domain's Graveyard. Statuses: **firm** (design rule) / **interim** (accepted placement with a named successor) / **tunable-config** (a value, never a rule — rules whose thresholds are knobs stay firm with the knob noted). `[rationale: inferred]` means the why was deduced from code shape, not found written down; `why: unknown` is a valid state.

## RECORD

### RECORD-1: Event-sourced append-only record as source of truth
- Decision: The durable record is the ordered event stream as received; messages, turns, derivations, and views are built from it and can be rebuilt. Edits/deletes change what readers see; the record retains the originals.
- Why: durable long-horizon history must survive any downstream representation change. [rationale: documented]
- Rejected: treating messages as the only canonical record.
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Record"; packages/lhc/src/messages/internal/store.ts:87-92; commit 7c8623d
- Confidence: high

### RECORD-2: One SQLite file per thread; registry is lookup, file is authority
- Decision: Each thread's full record lives in its own SQLite file, which stores its own identity once as metadata ("the file is the thread"); records inside carry no thread id. A separate registry DB maps thread ids to file paths as a convenience lookup, never the authority.
- Why: file-is-the-thread simplifies portability and makes per-thread locking/ordering natural. [rationale: documented]
- Rejected: one shared DB for all threads; per-record threadId columns; registry as source of truth.
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Threads; packages/lhc/src/threads/index.ts:186-210; packages/lhc/src/threads/internal/registry.ts:13
- Confidence: high

### RECORD-3: Thread creation is file-first then registry row, with compensation
- Decision: newThread creates the thread file (including the seeded first open turn), then the registry row; on registry failure it deletes the file. The invariant "no registry row without its file" is absolute; an orphan file from a crash between the writes is documented harmless.
- Why: two databases cannot share a transaction, so pick the order whose crash artifact is benign. [rationale: documented]
- Rejected: registry-first creation; attempting a cross-database transaction.
- Status: firm
- Evidence: packages/lhc/src/threads/index.ts:94-140 ("design decision 2" comment); docs/onboard/02-domain-design.md §Creating a thread
- Confidence: high

### RECORD-4: Random thread ids; positional ids for everything inside a thread
- Decision: Thread ids are random `th_` + 16 hex for global uniqueness across files/registries. In-file entities derive ids from order: turns `t<n>`, messages `m<n>`, chunks `c<n>`.
- Why: thread uniqueness must span files and registries; in-file identity can and should be deterministic from local order (project-wide deterministic-id stance). [rationale: documented]
- Rejected: positional thread ids; random ids for in-file records.
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md; packages/lhc/src/threads/internal/create.ts:15; packages/lhc/src/messages/index.ts:97; CLAUDE.md deterministic-ID preference
- Confidence: high

### RECORD-5: Thread id prefix resolution — exact wins, ambiguity fails loud, never auto-create
- Decision: Resolution accepts full or prefix ids; an exact id wins outright even when it prefixes a longer id; an ambiguous prefix returns a caller_error naming the collision; registry queries escape wildcard characters so prefixes stay literal; nothing auto-creates a thread on resolve.
- Why: silent arbitrary pick on ambiguity would be quietly wrong; loud failure forces disambiguation. [rationale: documented]
- Rejected: silent first-match resolution; resolve-or-create upsert (project bans upserts).
- Status: firm
- Evidence: packages/lhc/src/threads/index.ts:61-73,143-168; packages/lhc/src/threads/internal/registry.ts:110; commit 6a7d95b
- Confidence: high

### RECORD-6: ThreadRef is a union with a single interpreter; blank paths refused
- Decision: Domains take a ThreadRef (`{threadId} | {filePath}`), not a raw id or path; only threads.resolveThreadRef interprets it. `{filePath}` passes through untouched; blank paths are refused (node:sqlite would otherwise open a vanishing temp DB).
- Why: one interpreter prevents scattered resolution logic; the blank-path guard closes a silent-data-loss hole. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/threads/index.ts:22,82-88,212-227; docs/onboard/bad-code-log.md ThreadRef naming entry
- Confidence: high

### RECORD-7: Intake is the only harness content-entry path; the harness owns stream coherence
- Decision: intake-stream is the sole way harness content enters. The domain records what it is given in the order given and fails loudly on impossible states; it never reconstructs order or membership from a malformed stream.
- Why: "a thread is single-threaded by definition: one conversation, one stream" — position in the ordered stream is the basis for boundary decisions. [rationale: documented]
- Rejected: reconstructing/reordering malformed streams inside LHC.
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §The stream contract
- Confidence: high

### RECORD-8: Batch is all-or-nothing; validation precedes idempotency; rejection costs no lock
- Decision: Pure three-layer closed validation runs before any DB touch — a rejected batch never opens the file or takes the write lock. A duplicate key on a malformed event is a rejection, not a skip. An invalid batch rolls back whole with first-failure eventIndex.
- Why: validation-before-idempotency keeps semantics unambiguous; no-lock-on-rejection keeps bad callers cheap; recorded-events-without-messages is the stranded state the single transaction prevents. [rationale: documented]
- Rejected: best-effort per-event commits; duplicate keys masking invalid shapes.
- Status: firm
- Evidence: packages/lhc/src/intake-stream/internal/pipeline.ts:72-78; packages/lhc/test/intake.test.ts; commit 7c8623d
- Confidence: high

### RECORD-9: Closed schemas; unknown fields rejected structurally; server-generated fields denied by name
- Decision: Every validation layer is a closed Effect Schema struct decoded under onExcessProperty:"error", so unknown-field rejection is a property of the definitions, not a remembered rule. Caller-supplied eventOrder/recordedAt/threadEventId/schemaVersion are denied by name with their own reason string.
- Why: "the old MVP's silent-root-field-drop bug class gets named when it appears". [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/intake-stream/internal/validate.ts:1-25,131-145
- Confidence: high

### RECORD-10: Idempotency is key-wins-over-content, thread-scoped; skips consume no order numbers
- Decision: An event whose idempotency key already exists in the thread is skipped without comparing content (the absence of a content comparison is deliberate). Only recorded events increment event order (MAX+1), so the sequence stays dense; skips do no side effects and queue no work.
- Why: resend-after-failure must be safe; dense ordering keeps deterministic ids stable. [rationale: documented]
- Rejected: content-hash comparison on duplicate keys; global cross-thread idempotency; preserving resend positions as order gaps.
- Status: firm
- Evidence: packages/lhc/src/intake-stream/internal/pipeline.ts:44-58,88-90; packages/lhc/test/idempotency.test.ts
- Confidence: high

### RECORD-11: Turn boundaries are decided synchronously in the intake hot path
- Decision: intake calls the turns state machine per event as it lands, and the message is attached to its turn at record time — never inferred later against a stream that has moved on. All deterministic work (record, message create, turn transitions, token stamping, work queueing) is synchronous in the batch transaction.
- Why: membership attached at record time cannot drift. [rationale: documented]
- Rejected: post-hoc turn inference over the recorded stream; reconstructing membership on read.
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Turn boundaries; packages/lhc/src/intake-stream/internal/pipeline.ts:100-137
- Confidence: high

### RECORD-12: Exactly one open turn, enforced as a hard error
- Decision: There is always exactly one open turn; thread creation seeds the first; zero or multiple open turns throws TurnStateCorruptionError surfacing as a state_corruption OpResult — the thread is triaged, not quietly patched.
- Why: an invalid thread caught early beats quietly wrong turns later. [rationale: documented]
- Rejected: recovering by choosing the latest open turn.
- Status: firm
- Evidence: docs/onboard/02-domain-design.md turn-state table; packages/lhc/src/intake-stream/internal/pipeline.ts:159-168; commit a4985d0
- Confidence: high

### RECORD-13: Turn state machine rules (prompt-close; empty turn_end no-op)
- Decision: turn_end with members closes the turn and opens a new empty one; user_prompt into a turn with members closes it and starts the new turn as first member; user_prompt into an empty turn just joins it; turn_end on an empty turn is a no-op (no empty closed turns); all other events join the current turn.
- Why: this is the domain ruling for what a turn is — one prompt plus everything that follows. [rationale: documented]
- Rejected: requiring explicit turn_end for every boundary; zero-message closed turns.
- Status: firm
- Evidence: docs/onboard/02-domain-design.md state table; packages/lhc/src/turns/index.ts:108-121; commit 2097fa3
- Confidence: high

### RECORD-14: Events and messages are separate records; turn_end produces no message
- Decision: Messages are a normalized readable view created from events with deterministic `m<eventOrder>` ids; turn_end is recorded in the stream and drives turn state but creates no message or block.
- Why: replay/read-back determinism; turn_end marks state completion, not readable content. [rationale: documented]
- Rejected: messages-as-the-record; rendering turn-end markers as messages.
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Creating messages; packages/lhc/src/messages/internal/project.ts:13
- Confidence: high

### RECORD-15: Message projection copies source payloads verbatim
- Decision: Event-to-message projection copies payload fields into typed blocks without trimming, normalizing, splitting, or summarizing. Compression is decided later by derivations and views, never at intake.
- Why: the file header states verbatim projection is load-bearing. [rationale: documented]
- Rejected: cleanup or shortening in the projection step.
- Status: firm
- Evidence: packages/lhc/src/messages/internal/project.ts:1-4,65
- Confidence: high

### RECORD-16: Token estimates stamped at message creation from the local o200k tokenizer
- Decision: Every message gets a token estimate the moment it lands, in the same synchronous write, from a shared local tokenizer — no provider call, no failure mode, same text same number. Edits re-stamp from the same estimator.
- Why: sizes must exist without a later counting pass so turn/chunk arithmetic works at close time. [rationale: documented]
- Rejected: provider-side token counting; lazy counting passes.
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Token estimates; packages/lhc/src/messages/internal/store.ts:94-138
- Confidence: high

### RECORD-17: recorded_at from the source event is the one time anchor
- Decision: Message read surfaces and materialized tail/session entries use the producing event's recorded_at, never a separate message-created or write-time timestamp.
- Why: the record event is the stable time anchor for all derived readable/materialized forms; materialization stays replayable. [rationale: documented]
- Rejected: independent timestamps per projection or materialization pass.
- Status: firm
- Evidence: packages/lhc/src/messages/internal/store.ts:150-172; packages/lhc/src/thread-view/internal/materialize.ts:23
- Confidence: high

### RECORD-18: Message removal is a soft delete; source events are never destroyed
- Decision: remove drops the message from reads and turn membership via deleted_at; source events remain. Default reads filter deleted; `show` by id is deliberately unfiltered (audit read, never not-found); event read-back is the unfiltered audit surface.
- Why: the record underneath is never destroyed; audit needs an honest path to deleted content. [rationale: documented]
- Rejected: hard delete.
- Status: firm
- Evidence: packages/lhc/src/messages/internal/store.ts:87-92,196-199,244-249; commit 64539ed
- Confidence: high

### RECORD-19: Edits/deletes target closed turns only; turn-initiating message removal refused
- Decision: edit and remove refuse open-turn messages (the open turn is the live exchange, outside manual mutation) and refuse removing the message that initiates a turn. A deleted target refuses as message_not_found via the filtered view.
- Why: the live exchange stays out of reach; a turn without its prompt is structurally meaningless. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Editing and deleting; packages/lhc/src/messages/internal/store.ts:37-51
- Confidence: high

### RECORD-20: Manual cleanup goes through messages, not intake-stream
- Decision: intake-stream records new harness activity; messages is where a person/agent corrects or prunes the readable record. Two write paths, split by audience and semantics.
- Why: separates harness stream semantics (append, idempotent) from curation semantics (edit/remove with cascade). [rationale: documented]
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Editing and deleting messages
- Confidence: high

### RECORD-21: Closed turns are structurally immutable — no writer exists
- Decision: A closed turn has no writer anywhere in the turns store: membership and boundaries are stable because no UPDATE touches closed rows; closeTurn's UPDATE guards on status='open'. Deletes shrink visible membership without touching turn rows.
- Why: downstream derivation and banding arithmetic depend on closed-turn stability. [rationale: documented]
- Rejected: re-cutting or moving turn boundaries after deletes.
- Status: firm
- Evidence: packages/lhc/src/turns/internal/store.ts:1-4,31-45
- Confidence: high

### RECORD-22: Reads surface stored state — they never repair, derive, or block
- Decision: Message and turn reads return stored records plus stored derivation states as they exist; they never recompute readiness, trigger derivation, or block on pending work.
- Why: reads stay cheap, deterministic, and side-effect-free. [rationale: documented]
- Rejected: lazy derivation on read.
- Status: firm
- Evidence: packages/lhc/src/messages/index.ts:54,265; packages/lhc/src/turns/index.ts:42,205
- Confidence: high

### RECORD-23: Bounded message reads never load out-of-window block content
- Decision: list resolves its window from the message table first (bounds in source-event-order coordinates), then loads blocks only for windowed messages; a test corrupts an out-of-window block to prove it is never parsed.
- Why: bounded reads must be cheap on long threads. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/messages/internal/store.ts:180-242; commit 225b6d9
- Confidence: high

### RECORD-24: turn_end must carry an empty payload, checked by name
- Decision: turn_end events are pure markers; any payload field is rejected by a dedicated check (a closed Struct({}) would admit any object, so the rule is explicit).
- Why: keeps the marker semantics unambiguous. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/intake-stream/internal/validate.ts:50-51,152-158
- Confidence: high

### RECORD-25: Nine event kinds form a closed intake vocabulary
- Decision: user_prompt, assistant_text, assistant_thinking, runtime_note, model_change, thinking_level_change, tool_call, tool_result, turn_end — a closed enum; unknown kinds rejected by name.
- Why: a closed vocabulary keeps the record interpretable; "summary"/"unknown" message types were explicitly avoided in v1. [rationale: documented]
- Rejected: extensible/unknown event kinds.
- Status: firm
- Evidence: packages/lhc/src/intake-stream/internal/validate.ts:9-19; CLAUDE.md naming section
- Confidence: high

### RECORD-26: SQLite open pragmas are fixed: WAL, foreign_keys ON, busy_timeout 5000, synchronous NORMAL
- Decision: Every thread DB opens with these pragmas; schema version tracked via PRAGMA user_version (currently 3).
- Why: unknown — the code proves the settings, not the deliberation; plausible WAL-for-concurrent-readers reasoning is unverified. [rationale: inferred; why effectively unknown]
- Status: firm (mechanism); the specific values have no recorded rationale
- Evidence: packages/lhc/src/shared-tech/storage.ts:3-15
- Confidence: medium

### RECORD-27: Schema gate at thread open; unsupported versions refused before use
- Decision: Opening a thread through the threads domain validates the schema marker, migrates supported older versions, and refuses schemaVersion 0 ("not a thread file") or unsupported versions before any domain operates on the file.
- Why: domains must never operate on unknown storage. [rationale: documented]
- Rejected: lazy per-domain compatibility checks.
- Status: firm
- Evidence: packages/lhc/src/threads/internal/create.ts:180-187; packages/lhc/src/shared-tech/thread-migrate.ts
- Confidence: high

### RECORD-28: DB handles open fresh per operation; reads run touch-suppressed
- Decision: createDbRead/WriteTransaction resolve the ref, open the file, run one transaction, close the handle — no cached connections or pool. Reads use BEGIN (WAL concurrent), writes BEGIN IMMEDIATE; read transactions run under thread-touch suppression so a pure read can never trigger background catch-up drains.
- Why: per-thread files with no pool keep lifecycle trivial and cross-instance behavior identical; reads must be side-effect-free. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/persist.ts:136-221; packages/lhc/src/threads/index.ts:186-189
- Confidence: high

### RECORD-29: Intake test seams are real-mechanism hooks, not mocked transactions
- Decision: The intake pipeline exposes a walk hook (per-event, inside the transaction) so atomicity is tested by closing the real handle mid-walk, plus an injectable clock for read-back equivalence proofs.
- Why: induce failure through a real mechanism rather than a mocked transaction object. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/intake-stream/internal/pipeline.ts:19-38
- Confidence: medium

### RECORD-30: The SDK is in-process only; initLhc is the sole initializer
- Decision: LHC has no CLI, no daemon, no logins — anything talking to LHC runs inside a host holding an instance. Domains are surfaces on the instance (messages, turns, threadView, inspect, intakeStream, work) with an explicit public-surface boundary.
- Why: "one login — the host's — covers everything LHC does"; the CLI was retired to prove the SDK-only public API. [rationale: documented]
- Rejected: CLI surface with its own provider/env resolution (deleted); daemon process.
- Status: firm
- Evidence: packages/lhc/src/sdk.ts:488; commits d7ba08a, 8dd623e; docs/onboard/01-core-concepts.md "Basics"
- Confidence: high

### Graveyard
- was isolated pure turn-state permutation test surface → replaced by intake-driven verification through intakeStream.messageEvents (docs/onboard/bad-code-log.md; commit 866aba1)

## DERIV

### DERIV-1: Derivations are durable stored rows, never recomputed implicitly
- Decision: A derivation is a stored row attached to its subject (message/turn/chunk), keyed by subject kind/id/type. Read-back returns rows as stored, never re-derived on read; views assemble from what exists.
- Why: compute once, serve many times; reads stay cheap and deterministic. [rationale: documented]
- Rejected: derive-on-read / caching semantics.
- Status: firm
- Evidence: packages/lhc/src/messages/internal/derivations.ts:1-6,56-64; docs/onboard/01-core-concepts.md "Derivation"
- Confidence: high

### DERIV-2: Seven derivation types, split deterministic vs inference
- Decision: Inference-backed: smoothed_prompt, tool_result_summary, detailed_turn_compression, chunk_summary_brief. Deterministic assemblies: turn_rendering, pre_detailed_assembly, chunk_summary_detailed. Deterministic derivations never cross the inference boundary.
- Why: reserve model calls for genuine compression leverage; deterministic composition is fast, free, reproducible. [rationale: documented]
- Status: firm (note: onboarding docs list six — they predate pre_detailed_assembly)
- Evidence: packages/lhc/src/turns/internal/derive.ts:663-668; packages/lhc/src/messages/internal/handlers.ts:296-299; fixes-feature-log Done: Slices A/B/C
- Confidence: high

### DERIV-3: Four derivation states; retry progress is queue business, not a state
- Decision: pending / ready / failed / blocked. A derivation stays pending while attempts remain; attempt counts/backoff live on the work-item row; a domain's derivation report joins the two. State belongs to the derivation, never to its subject.
- Why: keeps the durable record's vocabulary about usability, mechanics about scheduling. [rationale: documented]
- Rejected: a `retrying` derivation state; "chunk is failed" subject-state shorthand.
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Derivation states"; packages/lhc/src/shared-tech/derivation.ts:11,71-83
- Confidence: high

### DERIV-4: `blocked` means source damage — retry won't help
- Decision: A handler that cannot read its source coherently returns blocked (terminal) with reason — never a retry loop against a record that cannot improve. A deleted source never reaches this path (its derivation row is gone), so a miss is genuine corruption.
- Why: transient failure and structural damage need different treatment; damage needs triage. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/messages/internal/handlers.ts:26-33; packages/lhc/src/turns/internal/derive.ts:53-55
- Confidence: high

### DERIV-5: Source-version fencing discards stale in-flight derivations
- Decision: Each derivation row carries a monotonic sourceVersion incremented on edit/delete/cascade. In-flight work finishes against the old version and its completion is discarded as stale (done/stale_discarded dispositions live in one place — the queue util's completion transaction, which handlers never open themselves).
- Why: a late-finishing pre-change derivation must never overwrite a post-change rebuild. [rationale: documented]
- Rejected: cancelling in-flight work; last-write-wins.
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Source version"; packages/lhc/src/shared-tech/derivation.ts:264-276; commit da58dd5
- Confidence: high

### DERIV-6: Mutation cascade is a structural walk, not a hardcoded derivation list
- Decision: The clear-set is derived from record structure (message → its turn via membership stamp → its chunk via placement row), so future derivations on subjects in the chain cascade without the module changing. Edit clears the whole chain pending at next version; delete drops the deleted subject's own derivations and clears everything upward for minus-one composition.
- Why: cascade correctness must survive derivation-type additions. [rationale: documented]
- Rejected: per-derivation invalidation calls sprinkled through mutation code.
- Status: firm
- Evidence: packages/lhc/src/messages/internal/cascade.ts:1-14,86-103
- Confidence: high

### DERIV-7: Tool call/result counterparts join the cascade clear-set
- Decision: A tool summary derives from its message and its call-id pair, so mutating one half clears and re-queues the counterpart's summary too (only the counterpart message — not its turn/chunk). A deleted result reverts the call summary's outcome to `unknown` because rebuilds read the live record only.
- Why: the pair is a real source dependency; ignoring it left stale outcomes (shipped bug, fixed as "counterpart cascade" in Epic 02 fix batches). [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/messages/internal/cascade.ts:105-137,251-258; commits 9349b3f, 40facf7
- Confidence: high

### DERIV-8: Cascade rebuilds enqueue in fixed dependency order; supersede-deletes land first
- Decision: Re-enqueues sort by REBUILD_KIND_ORDER (smoothing → tool summary → turn_derivation → detailed_turn_compression → chunk detailed → chunk brief); still-queued old-version items are supersede-deleted before replacement enqueues so ids cannot collide; claimed items are left to the version check.
- Why: consumers must land after their inputs; per-thread queue order is the dependency mechanism. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/messages/internal/cascade.ts:26-52,155-232
- Confidence: high

### DERIV-9: Only user prompts and tool results enqueue message-owned work at landing
- Decision: Message-level derivations queue immediately when their source message lands; other message kinds create no message-owned work.
- Why: message-level derivations need only their own source message, so they do not wait for turn close. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/02-domain-design.md; packages/lhc/src/messages/internal/work.ts:4-9
- Confidence: high

### DERIV-10: Smoothing has a deterministic floor and an oversize bypass
- Decision: cleanPrompt (whitespace/newline normalization, code fences preserved verbatim) is the pure deterministic floor. If the cleaned prompt exceeds guards.smoothedPrompt.maxInferenceTokens, the cleaned text itself becomes the derivation without a model call.
- Why: giant prompts are not worth a model call; the floor must be pure (no DB, clock, inference). [rationale: documented]
- Status: firm (guard value tunable-config: 700 default)
- Evidence: packages/lhc/src/messages/internal/smoothing.ts:1-2; packages/lhc/src/messages/internal/handlers.ts:62-79
- Confidence: high

### DERIV-11: Suspicious-output guard discards smoothing results that shrink too much
- Decision: If smoothed output is below suspiciousOutputRatio × input tokens, the model output is discarded, the deterministic floor is stored instead with discardReason metadata, and a warning is logged; the derivation still lands ready.
- Why: smoothing must preserve content; a drastic shrink signals the model summarized instead of cleaning (the Haiku-collapse lesson from derivation testing). [rationale: documented]
- Status: firm (ratio tunable-config: 0.15 default)
- Evidence: packages/lhc/src/messages/internal/handlers.ts:84-103; commit 3591c9f
- Confidence: high

### DERIV-12: Tool-result summaries are currently forced to deterministic truncation
- Decision: FORCE_TOOL_RESULT_SUMMARY_FALLBACK = true routes every tool_result_summary to 500-char truncation instead of inference. The inference path (tiered ratios, classifier-driven prompt routing) remains in code but dormant.
- Why: the last inference attempt clogged the durable work queue at intake-rate bursts; truncation holds the line until a high-speed provider proves it drains at intake speed. [rationale: documented]
- Status: interim (successor: fixes-feature-log items 11 + 22)
- Evidence: packages/lhc/src/messages/internal/handlers.ts:24,175-186; fixes-feature-log items 11, 22, Slice A
- Confidence: high

### DERIV-13: Tool outcomes are mechanically stamped from the record, never model-authored
- Decision: succeeded/failed/unknown comes from the paired result's isError flag (or absence → unknown), stamped into derivation metadata separately from content. Provenance likewise comes only from config-known assignment strings stamped by the adapter.
- Why: facts about what happened must not depend on model prose. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/derivation.ts:13-15,88-95; packages/lhc/src/messages/internal/handlers.ts:243-251
- Confidence: high

### DERIV-14: Tool calls have no derivation of their own
- Decision: Tool calls keep recorded arguments (truncated at 500 chars in composed representations); no separate derivation pass exists for them.
- Why: "call arguments are usually short, so no separate derivation pass is needed". [rationale: documented]
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Message-level derivations; packages/lhc/src/turns/internal/compose.ts:129-135
- Confidence: high

### DERIV-15: Turn close queues one deterministic item producing rendering + assembly; compression splits to its own async item
- Decision: turn_derivation composes turn_rendering and pre_detailed_assembly and writes both in one completion transaction (no inference); detailed_turn_compression is enqueued from that completion as a separate async item consuming the stored assembly.
- Why: split fast deterministic work from slow inference so a compression failure never holds the rendering hostage; the assembly is the durable inference input. [rationale: documented]
- Rejected: the prior single-item design that ran composition then inference together.
- Status: firm
- Evidence: packages/lhc/src/turns/internal/derive.ts:1-5,249-304; fixes-feature-log Done: Slice C
- Confidence: high

### DERIV-16: pre_detailed_assembly is dialog-only
- Decision: The compression input strips tool activity, thinking, and runtime notes entirely — only user_prompt (smoothed where ready) and assistant_text in record order.
- Why: pre-stripping noise deterministically means inference pays only for semantic condensation of the dialogue. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/compose.ts:159,352-379; fixes-feature-log item 14
- Confidence: high

### DERIV-17: Turn rendering groups consecutive tool activity into maximal runs
- Decision: Consecutive tool calls/results compose into one run-level rendering part — a header naming the tools, call count, and mechanical outcome tally, followed by per-call lines with truncated arguments and outcomes. Prompts/assistant text break runs; thinking/notes are transparent. Runs are never reordered. Tool activity appears only in this rendering (the smooth band's material); it does not flow into chunk summaries (see DERIV-30).
- Why: run grouping compresses structure deterministically for the full-texture tier. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/compose.ts; commit 40facf7
- Confidence: high

### DERIV-18: Composition fallback ladder per message kind; fallbacks are floors, never omissions
- Decision: prompt → cleanPrompt floor; tool result → deterministic truncation; tool call → recorded args truncated; text/thinking/notes → raw. A fallback records a per-message DependencyGap plus a recovery receipt, and the floor is written back as the stored message derivation (floor promotion) with a warning log.
- Why: "more content, not less" — the view gets the best available; the failure goes to the log; nothing is silently dropped. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/compose.ts:119-143; packages/lhc/src/turns/internal/derive.ts:216-237
- Confidence: high

### DERIV-19: Tiny turns skip compression inference; exhausted compression floors to the assembly, landing ready
- Decision: Input below guards.detailedTurnCompression.tinyTurnTokens passes the assembly through verbatim (no model call). When inference exhausts retries or fails non-retryably, the handler lands the assembly text as the compression content with fallbackUsed/fallbackFloor metadata — ready-with-floor, not failed.
- Why: compressing a tiny turn costs more than it saves; a turn must always end with usable compression material so chunks and views never starve. [rationale: documented]
- Status: firm (tinyTurnTokens value tunable-config: 80 default)
- Evidence: packages/lhc/src/turns/internal/derive.ts:324-333,335-393; commit f271a3a
- Confidence: high

### DERIV-20: chunk_summary_detailed is deterministic concatenation, not inference
- Decision: Detailed chunk summaries concatenate member turn compressions with per-turn headers — nothing else (see DERIV-30). A failed member floors to its assembly text (warning-logged); a blocked member blocks the chunk summary; a not-ready member requeues.
- Why: the texture is already in the member compressions; a second model pass adds cost without information. [rationale: inferred — the prior inference callback existed and was removed]
- Rejected: inference-backed detailed chunk summary (callback + chunk-detailed-v1 prompt existed, since deleted).
- Status: firm
- Evidence: packages/lhc/src/turns/internal/derive.ts:452-500; docs/onboard/bad-code-log.md summarizeChunkDetailed entry; commit f9262b4
- Confidence: high

### DERIV-21: chunk_summary_brief consumes the stored detailed summary; outcomes age out last
- Decision: Brief is inference over the chunk's stored detailed content (not raw members) — "what ages out first is the activity's texture, never its result." If detailed is missing/pending, the brief handler defers: deletes its claimed item and re-enqueues detailed (if no live item) then brief behind it.
- Why: layered derivation chain — each band feeds the next; deferral instead of failure keeps eventual consistency. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/derive.ts:452-454,540-607; docs/onboard/02-domain-design.md §Chunks
- Confidence: high

### DERIV-22: Compression targets are ratio-derived min/aim/max; size disposition is recorded, not enforced
- Decision: Inference compressions receive inputTokens plus targetMin/Aim/Max computed by the owning handler from configured ratios; output is measured and stamped sizeDisposition in_range/under_min/over_max — observability only; out-of-band outputs still land ready.
- Why: bands need predictable sizes but hard enforcement would burn retries on a stochastic property; measurement feeds tuning. [rationale: inferred]
- Status: firm (mechanism); ratios tunable-config (compression 0.35/0.5/0.65; brief 0.08/0.12/0.2)
- Evidence: packages/lhc/src/turns/internal/derive.ts:118-142,389; packages/lhc/src/shared-tech/derivation.ts:234-243
- Confidence: medium
- Open: whether under_min/over_max should ever gate (retry/floor) — current evidence says no (quality is judged by reading outputs; see INFER-15: these ranges are steering, not tolerances, so a stale-looking disposition stamp is not a defect). Ruled direction: per-model stated-target bias belongs in assignment config, not prompt text (nine-model sweep evidence; items 19/21).

### DERIV-23: Handlers never hold a DB transaction across inference
- Decision: HandlerRunContext.openDb() gives short-transaction access never held across inference calls; handlers return derivation content as data and the queue util performs the completion write.
- Why: a model call can take seconds — holding SQLite's write lock across it would block intake. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/derivation.ts:255-268
- Confidence: high

### DERIV-24: derivation_log is append-only per-attempt execution history carrying full request/response
- Decision: derivation_log captures per-attempt events (inference_succeeded/failed, retry_scheduled, fallback_applied, terminal_failed) with freeform JSON payloads; inference attempt events additionally persist `requestMessages` (the exact rendered messages the adapter sent) and `rawResponse` (the untrimmed model text, success only). The adapter returns these on its result (optional fields; absent on pre-render failures); handlers write them at the existing log sites. The derivation row remains the durable current state; durable outcome detail (attempts, lastError) is copied into derivation metadata before the queue row is deleted.
- Why: troubleshooting needs attempt history but queue rows are deleted on completion; and reconstruction of what was sent was proven able to lie (the system-prompt-drop bug shipped invisibly behind correct-looking provenance) — only captured payloads count. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/logging/derivation-log.ts; packages/lhc/src/shared-tech/inference-adapter.ts; fixes-feature-log item 13 (Done 2026-07-03)
- Confidence: high

### DERIV-25: Synchronous derive shares the queue machinery (claim-or-refuse)
- Decision: messages.derive / turns.deriveTurn run inline by creating-or-claiming a real work item with lease and epoch; if equivalent work is live, the call refuses with derivation_work_in_flight rather than racing it. Sync and async land through the same version-checked completion.
- Why: one completion discipline — sync must not become a second, unfenced write path. [rationale: documented]
- Rejected: bypassing the queue for sync derivation.
- Status: firm
- Evidence: packages/lhc/src/turns/internal/derive.ts:736-876; docs/onboard/02-domain-design.md §Synchronous derivation
- Confidence: high

### DERIV-26: Completion writes must exactly match queued derivation targets
- Decision: assertExactDerivationWrites compares handler writes against the item's queued targets; a mismatch throws DerivationCompletionError (state_corruption) rather than landing partial output; partial version-hits likewise throw.
- Why: a handler drifting from its declared targets is corruption, not tolerable variance. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/durable-work/index.ts:50-57; packages/lhc/src/shared-tech/work-queue/index.ts:507,527-539
- Confidence: high

### DERIV-27: Deterministic inference callbacks are explicit test construction only
- Decision: The deterministic callback set produces marked, input-digest-derived output so in-process and spawned test runs yield byte-identical artifacts; selectable only by explicit construction — never a production default.
- Why: golden/fixture determinism without real inference; guards against silently fake production inference. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/deterministic.ts:1-5,65
- Confidence: high

### DERIV-28: A dormant tool-result classifier taxonomy exists for prompt-mode routing
- Decision: A deterministic classifier maps toolName/toolInput/rawOutput/outcome to {operationClass (10 values), responseShape (11), promptMode (10), facts} forwarded into the tool-result prompt render. Built for per-content-kind routing; currently unreached because summaries are forced to truncation.
- Why: one generic summarize prompt underperforms across receipt/failure/search/test/diff shapes. [rationale: documented]
- Status: interim (dormant; successor: fixes-feature-log item 11 revives it)
- Evidence: packages/lhc/src/messages/internal/classify-tool-result.ts; packages/lhc/src/shared-tech/derivation.ts:151-195; commit d1c1fd5
- Confidence: high

### DERIV-29: 500-char truncation is a single shared floor constant; the record and read surfaces stay full
- Decision: FALLBACK_TRUNCATION_LIMIT=500 with a fixed `… [truncated N chars]` marker applies to composed/derived representations of tool calls and results only; the record, live tail (ahead of the boundary), session-view materialization, and the messages read surface keep full content. The truncator is pure and restated byte-identically in thread-view because cross-domain internals may not be imported.
- Why: derived views may abbreviate; canonical reads may not; the restatement rule is the enforcement mechanism of the domain-boundary rule. [rationale: documented]
- Status: firm (limit value tunable in principle)
- Evidence: packages/lhc/src/shared-tech/tool-result-rendering.ts; packages/lhc/src/thread-view/internal/render.ts:22-29; fixes-feature-log Done: Slice A
- Confidence: high

### DERIV-30: Detailed and brief bands carry no tool calls or tool-activity summaries — dialog narrative only
- Decision: A chunk's detailed summary is the concatenation of member turn compressions (which derive from the dialog-only assembly), and brief compresses that — so nothing tool-shaped survives below the smooth band. Tool activity lives in the record (full), the live tail (full), and the smooth band's renderings (truncated runs); below that, what tools did survives only as the assistant's own narrated account of it.
- Why: explicit ruling (2026-07-02/03, second/third occurrence — earlier attempts to strip tool calls from detailed kept getting partially undone). The bands are memory, and mechanical tool traces are texture, not outcomes: the dialog narrative already carries what the tools accomplished in the assistant's words, and the record holds the mechanical truth one query away. Generic tool-outcome lines are summarization without editorial intent. Any future tool-outcome representation in these bands (e.g. failure-only receipts) gets designed deliberately against a demonstrated need. [rationale: documented — by ruling]
- Rejected: per-run outcome receipt lines appended to chunk assemblies (shipped unratified, removed); always-on tool summaries at any compression tier.
- Status: firm
- Evidence: packages/lhc/src/turns/internal/compose.ts; packages/lhc/src/turns/internal/derive.ts; fixes-feature-log Done: "Receipts removed" (2026-07-03)
- Confidence: high

### Graveyard
- was ToolRunReceipt outcome lines riding turn_rendering metadata into chunk detailed assemblies → removed entirely; detailed/brief bands are dialog narrative only (DERIV-30; fixes-feature-log Done 2026-07-03)
- was `smooth_turn_compression` (compression of the full-texture turn rendering) → replaced by `detailed_turn_compression` over `pre_detailed_assembly`, with v2→v3 thread migration (fixes-feature-log Done: Slices B/C)
- was inference-backed chunk detailed summary (summarizeChunkDetailed callback + chunk-detailed-v1 prompt) → replaced by deterministic concatenation (bad-code-log; commit f9262b4)
- was inference-backed tool-result summaries in the live path → replaced by forced 500-char truncation after queue clogging (fixes-feature-log Slice A, item 11)
- was seven-kind inference callback seam (Epic 05) → contracted to four-operation InferenceCallbacks (commits b84ebcd → a465803; 6f3fb67)
- was automatic tool-result trimming at intake → disabled (commit 7aad42d)

## CHUNK

### CHUNK-1: Chunks are containers of consecutive whole closed turns
- Decision: A chunk groups whole consecutive closed turns; turns never split across chunks; the turn is the atomic unit of banding and eviction.
- Why: turn = one exchange is the natural semantic unit; splitting mid-turn breaks exchange coherence. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Turn/Chunk"; packages/lhc/src/turns/internal/chunks.ts
- Confidence: high

### CHUNK-2: Chunk close is pure arithmetic over stored projected tokens
- Decision: Placement weighs the open chunk's durable accumulated count plus the incoming turn's projected count against targetProjectedTokens/maxProjectedTokens — no clock, no inference, no re-estimation. Identical streams produce identical chunk boundaries across restarts.
- Why: deterministic boundaries are replayable and testable; boundary decisions must not depend on when derivations finish. [rationale: documented]
- Rejected: semantic/inference-driven boundaries; wall-clock chunking.
- Status: firm (threshold values tunable-config: 2200/4400 defaults — see CHUNK-13)
- Evidence: packages/lhc/src/turns/internal/chunks.ts:1-7,58-121; docs/onboard/02-domain-design.md
- Confidence: high

### CHUNK-3: Crossing-the-target closes without the incoming turn; max-rule closes with it; a chunk never closes empty
- Decision: If accumulated + incoming ≥ target (equality included), the open chunk closes holding its current members and the incoming turn opens the next chunk. A single turn ≥ maxProjectedTokens closes its own chunk immediately. An empty open chunk always accepts the incoming turn.
- Why: keeps chunks near target without overshoot; the oversized-loner rule bounds worst-case chunk size (golden g3 encodes it). [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/chunks.ts:58-121; packages/lhc/test/goldens/g3-oversized-loner.json
- Confidence: high

### CHUNK-4: An oversized turn behind a non-empty open chunk closes two chunks
- Decision: The accumulation rule and the max rule compose: the previous chunk closes without the oversized turn, then the oversized turn's own chunk closes immediately.
- Why: both rules are structural; their composition is deliberate (PlacementResult models both closes). [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/chunks.ts:20-27; packages/lhc/test/derivation-turns.test.ts oversized-behind-open case
- Confidence: high

### CHUNK-5: Chunk membership is immutable once placed; chunks shrink in place, never re-cut
- Decision: A placed turn keeps its placement (alreadyPlaced short-circuit); delete cascades rebuild summaries from surviving members without changing membership; neighboring chunks never re-derive and boundaries never move.
- Why: stable membership bounds the cascade and keeps band accounting stable; re-cutting would ripple derivation work across the whole thread. [rationale: documented]
- Rejected: re-chunking after deletes.
- Status: firm
- Evidence: packages/lhc/src/turns/internal/chunks.ts:24-27,69-79; docs/onboard/02-domain-design.md §Editing and deleting
- Confidence: high

### CHUNK-6: Placement happens inside the turn-derivation completion transaction
- Decision: Assigning a turn to a chunk (and any close's summary enqueues) rides the completion transaction of the turn_derivation work item — a crash leaves either a placed turn with its enqueued summaries or nothing. A stale completion must not place a turn.
- Why: placement depends on the projected token count computed by that derivation; atomicity closes the crash window. [rationale: documented]
- Rejected: placing at turn close in intake (the projected count does not exist yet).
- Status: firm
- Evidence: packages/lhc/src/shared-tech/derivation.ts:280-288; packages/lhc/src/turns/internal/derive.ts:286-299
- Confidence: high

### CHUNK-7: Projected vs landed token accounting split
- Decision: Chunk placement uses projected (pre-compression) tokens — the estimate of the pre_detailed_assembly text — while band sizing at compact uses landed (post-compression) counts of the stored derivations.
- Why: placement must be decidable at turn-derivation time, before inference lands; band budgets must reflect what will actually be served. [rationale: documented]
- Status: firm
- Evidence: fixes-feature-log Done: Slice C; packages/lhc/src/turns/internal/derive.ts:239-241
- Confidence: high

### CHUNK-8: Deterministic chunk ids and explicit member indexes
- Decision: Chunk ids derive from chunk order (c1, c2, …); membership carries an explicit member_idx.
- Why: deterministic IDs from order (project stance); replay produces identical structure. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/chunks.ts:45-56
- Confidence: high

### CHUNK-9: Chunk close queues detailed and brief as two independent work items
- Decision: Closing a chunk enqueues chunk_summary_detailed and chunk_summary_brief separately; brief defers itself behind detailed when it runs early (delete-and-re-enqueue), rather than encoding queue insertion order as the only dependency mechanism.
- Why: different dependencies and failure modes; independence lets brief re-drive detailed via the deferral path. [rationale: inferred]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/chunks.ts:123-134; packages/lhc/src/turns/internal/derive.ts:549-597; packages/lhc/test/chunk-brief-from-detailed.test.ts
- Confidence: medium

### CHUNK-10: Chunk-structure reads return raw membership for corruption checks
- Decision: readChunkStructure returns member references as stored so the consumer distinguishes damage (member pointing at no turn row → refuse) from a tombstoned turn (fine). It deliberately does not reuse the live-turn-join read that would hide both cases.
- Why: compact's canonical-damage check needs raw references. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/chunks.ts:136-146
- Confidence: high

### CHUNK-11: User-facing chunk listings use live-turn membership
- Decision: listChunks returns chunk rows with member turn ids through a live-turn join — the complementary reader to CHUNK-10's raw structure read; the two-reader split is itself the decision.
- Why: public inspection reflects readable membership; corruption-aware consumers use the raw structure API. [rationale: inferred]
- Status: firm
- Evidence: packages/lhc/src/turns/index.ts:162; packages/lhc/src/turns/internal/derivations.ts:250
- Confidence: medium

### CHUNK-12: Chunk fallback material is stored-member concatenation, rebuilt from live rows; unreadable canonical records refuse
- Decision: When a chunk summary is not ready/failed at compact time, the fallback renders each live member turn's live messages (with 500-char tool truncation) as per-turn sections. Unreadable members (open/missing/no closed order) or empty live membership make the material blocked — corrupt, not degradable.
- Why: fallback must come from the canonical record, and record damage must refuse rather than degrade. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/turns/internal/chunk-recovery.ts:37-118
- Confidence: high

### CHUNK-13: Chunk policy thresholds are knobs
- Decision: targetProjectedTokens and maxProjectedTokens are resolved SDK config (defaults 2200/4400), not architectural constants.
- Why: chunk sizing is calibration, not design; tests override to manufacture golden boundaries. [rationale: documented]
- Status: tunable-config
- Evidence: packages/lhc/src/shared-tech/derivation.ts:223; packages/lhc/test/derivation-turns.test.ts
- Confidence: high
- Open: thresholds were calibrated against full-texture projections; dialog-basis projection (Slice C) makes turns project smaller — retune during dogfood (fixes-feature-log item 14 context)

### Graveyard
- was chunk close driven by smooth-turn-compression token cost → replaced by projected tokens of pre_detailed_assembly (Slice C)

## VIEW

### VIEW-1: A view is a stored snapshot that changes only when the next compact replaces it
- Decision: The three lower bands (brief/detailed/smooth) are rendered and stored as snapshot text at compact time; serving = stored snapshot + live tail. Band content does not update as derivations repair between compacts.
- Why: serving must be cheap deterministic reads; an agent-facing view must not shift under the agent between compacts. [rationale: documented]
- Rejected: recomputing bands at serve time; continuously updating band content.
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Thread views"; packages/lhc/src/thread-view/internal/snapshot.ts
- Confidence: high

### VIEW-2: Compact never calls a model — assembly, not summarization
- Decision: Smart compact selects and arranges already-derived artifacts; it never calls providers, schedules repair work, or re-queues failed derivations. Missing material degrades or gaps; it is never derived inline.
- Why: compact must be fast, predictable, and side-effect free on the derivation pipeline. [rationale: documented]
- Rejected: compact-time inference / repair.
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Generating a view; packages/lhc/src/thread-view/internal/select.ts
- Confidence: high

### VIEW-3: Compact is explicit, never automatic; status only recommends
- Decision: Nothing triggers compact on a timer or after turn closes. threadView.status recommends compact when tail tokens exceed compactThreshold; the host decides.
- Why: compact changes what the agent sees; that change should be host/user-initiated. [rationale: documented]
- Status: firm (compactThreshold tunable-config: 160k default)
- Evidence: docs/onboard/02-domain-design.md ("nothing triggers compact automatically"); packages/lhc/src/thread-view/index.ts:147,212; commit 30d472c
- Confidence: high

### VIEW-4: Four bands as a fidelity gradient, aging in steps
- Decision: full (live tail) → smooth (turn renderings) → detailed (chunk summaries) → brief (outcome-only summaries). "The bands are a gradient, not a cliff": as a turn ages it moves down a band instead of dropping out.
- Why: the recent end stays sharp for work in progress; the old end stays cheap while carrying the shape of what came before. [rationale: documented]
- Rejected: single-summary compaction (the cliff — stock harness behavior).
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Bands
- Confidence: high

### VIEW-5: Compact config = lowerBound + per-band percentages summing to exactly 100
- Decision: Profiles carry lowerBound tokens and four shares that must sum to exactly 100. Built-in profiles (continuation/conversation/coding, all 120k) are "defaults and knobs, not architecture"; user profiles merge field-wise over built-ins by name; a new-name profile must be complete; the default profile is `continuation` (matches the PI continuation harness); explicit per-call params override field-wise and clear the stored profile name.
- Why: budget arithmetic must be closed; the config/design boundary is explicit — percentages are tunable, the band mechanism is not. [rationale: documented]
- Status: firm (profile values tunable-config)
- Evidence: packages/lhc/src/thread-view/internal/profiles.ts:1-64; packages/lhc/src/thread-view/index.ts:244-265
- Confidence: high

### VIEW-6: Selection splits impure reads (with corruption check) from a pure walk
- Decision: readSelectionInputs does all record/derivation reads with canonical-corruption detection before any transaction opens ("a refusal here means nothing was written, so the prior view is trivially intact"); selectArrangement is a pure function — no DB, clock, or inference.
- Why: refusal-before-write makes compact fail-safe; purity makes selection golden-testable. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/select.ts:1-15
- Confidence: high

### VIEW-7: Canonical damage refuses compact; derived damage degrades
- Decision: Damage to the canonical record (two open turns, closed turn without close boundary, references to missing turns, unreadable chunk fallback sources) throws CanonicalCorruptionError and compact refuses, leaving the prior view intact. Derived-material damage never refuses — it walks the degrade ladders.
- Why: a view built over a broken record would be quietly wrong; missing derivations are an expected operational state. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/select.ts:31-41,122-176; packages/lhc/src/thread-view/internal/compact-compute.ts:125
- Confidence: high

### VIEW-8: Compact point walks newest-first and snaps forward to a turn boundary
- Decision: The full-budget walk runs newest-first over message token estimates; when the crossing lands mid-turn, the point snaps FORWARD to the next turn start (the partially covered turn falls whole to the bands). Open-turn messages are always tail regardless of budget.
- Why: the tail must never begin mid-turn — exchanges are atomic units of fidelity. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/select.ts:246-293
- Confidence: high

### VIEW-9: The full tier is never stored
- Decision: The full percentage only determines where the compact point falls; only brief/detailed/smooth bands are rendered and stored.
- Why: full is recent activity served live from the record, not snapshot text. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/02-domain-design.md; packages/lhc/src/thread-view/internal/snapshot.ts:18
- Confidence: high

### VIEW-10: One shared fill rule for all bands
- Decision: Every band fills newest-first with whole entries; an entry exactly filling the budget is included (<=); the first crossing entry stops the band and is included only when the band was still empty. Entry cost is the tokens of the rendered entry text, priced by the same renderer that stores it — "one renderer, no drift".
- Why: pinned tie-breakers make arrangement deterministic and golden-testable (g2-edge goldens encode the <= edge). [rationale: documented]
- Rejected: splitting entries to meet budget exactly.
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/select.ts:346-371; packages/lhc/test/goldens/g2-edge-*.json; packages/lhc/src/thread-view/internal/render.ts:6-10
- Confidence: high

### VIEW-11: Bands are defined by representation, not strict time strata; chunk candidacy by newest member
- Decision: A closed-but-unchunked turn behind the compact point is a smooth candidate like any other. A chunk's band eligibility is decided by its NEWEST live member turn, which must sit behind the compact point and be older than the smooth band's oldest included turn. Fully tombstoned chunks are excluded.
- Why: representation-driven banding handles the open-chunk boundary shape without special cases. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/select.ts:12,294-299,382-396
- Confidence: high

### VIEW-12: Coverage invariant — every closed turn behind the compact point is represented or explicitly gapped
- Decision: After band fill, any banded turn newer than the oldest selected turn that no entry covers gets a coverage entry in the detailed band: detailed_turn_compression preferred, pre_detailed_assembly as degraded fallback, gap only when neither exists. The view never silently drops a span of the thread.
- Why: silent dropping was a real shipped bug (older closed turns in a still-open chunk vanished); fixed to render real content. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/select.ts:406-494; commit 062ee71
- Confidence: high

### VIEW-13: Degrade ladders per band, gap as last rung, degradation visibly marked
- Decision: smooth: turn_rendering → detailed_turn_compression → deterministic message excerpt → gap. detailed: chunk_summary_detailed → stored-member concat → gap. brief: chunk_summary_brief → stored-member concat → gap. Fallback rungs render a [degraded: …] marker; gaps render as a per-id unavailable line with reason; all recorded in receipt and stored metadata.
- Why: degrading must be visible by obligation to the reading agent, and auditable. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/render.ts:179-292,319-333; commit e08e695
- Confidence: high

### VIEW-14: The smooth band deliberately prefers turn_rendering over the compression
- Decision: Smooth entries render the full deterministic turn_rendering first; detailed_turn_compression is only a degraded fallback. The compression exists to feed the detailed band and chunk assembly, not to be the smooth band's primary.
- Why: explicit ruling by Lee during the compact-coverage fix — a subagent proposed swapping the ladder and was corrected; the smooth band is the full-texture tier. [rationale: documented — by ruling, session record]
- Rejected: compression as the primary smooth representation.
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/render.ts:179-195; session ruling (compact-coverage fix handoff)
- Confidence: high

### VIEW-15: Compact writes via one atomic singleton replace; boundary reset rides the same transaction
- Decision: One BEGIN IMMEDIATE deletes the singleton view row (FK cascades bands), inserts the new header+bands, and resets the visibility boundary to the compact point; a crash rolls the whole replace back. One current view per thread — no view history.
- Why: serving must never observe a half-written view. [rationale: documented]
- Rejected: versioned view history.
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/snapshot.ts:205-260
- Confidence: high

### VIEW-16: A never-compacted thread serves the whole record as tail through the same assembly path
- Decision: readViewSnapshot null = never compacted; the whole record renders as tail from event 1 through the same serving assembly — snapshot-absent rather than a separate branch.
- Why: one serving path; no special pre-compact code to drift. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/snapshot.ts:33-36; packages/lhc/src/thread-view/internal/assemble.ts:16
- Confidence: high

### VIEW-17: Serving reads are read-only and touch-suppressed
- Decision: getLlmRequestContext, session view, status/describe, and materialize reads assemble local state without inference, queue interaction, writes, or scheduler first-touch drain.
- Why: hot-path reads are local deterministic assembly; a background SDK's reads must not schedule catch-up drains. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/index.ts:1,82,530
- Confidence: high

### VIEW-18: The visibility boundary shortens only tool results, only at-or-behind; intake never advances it
- Decision: A per-thread singleton position (seeded 0): tool results at-or-behind render as deterministic truncation with a pointer back to the record; ahead render full. Prompts, assistant text, thinking always render full. Intake does not advance it; compact resets it to the compact point.
- Why: pre-compact resume/session-view must stay faithful to the record; tool output is the reclaimable bulk. [rationale: documented]
- Rejected: automatic boundary advance at turn-end (built in Epic 05, since retired — see Graveyard).
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/boundary.ts; packages/lhc/src/thread-view/internal/render.ts:77-99; docs/onboard/01-core-concepts.md "Visibility boundary"
- Confidence: high

### VIEW-19: Tail renders full fidelity with an explicit per-kind mapping; bands serve as labeled user messages
- Decision: The tail mapping table renders every record message kind explicitly, thinking included as tagged blocks. Each non-empty band becomes one user-role message headed `[context · band]` because inference APIs reject unknown roles; tool results/notes/changes also map to user role.
- Why: role vocabulary is constrained by consuming APIs; band text is context, not dialogue; per-kind arms make drift fail a named test leg. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/render.ts:101-140; packages/lhc/src/thread-view/internal/assemble.ts:27
- Confidence: high

### VIEW-20: Materialize and LlmRequestContext come from one serving assembly; a written file is never a second source of truth
- Decision: render/materialize/LlmRequestContext are the three exits; materialized files (today PI session JSONL) are renderings of the view — the thread file remains authoritative; materialize timestamps derive from record times, never write-time clocks.
- Why: two sources of truth would fork; record-time output keeps materialization replayable. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Render / materialize / LlmRequestContext"; packages/lhc/src/thread-view/internal/snapshot.ts:120-128; packages/lhc/src/thread-view/index.ts:530
- Confidence: high

### VIEW-21: Compact always writes what it computed — no monotonicity refusal (supersedes the compact_unchanged guard, removed 2026-07-10)
- Decision: Compact writes the computed arrangement unconditionally — forward, equal, or backward compact points all succeed. The former strictly-lower refusal (`compact_unchanged`) was removed: after band rounding (VIEW-era change, commit e194df5) a backward-moving point is a legitimate correct outcome, and the guard blocked it. previewCompact still reports wouldProduceBands when the recomputed arrangement differs from the stored snapshot.
- Why: Lee's ruling (2026-07-10, consistent with the earlier "blocking me from recompacting is dumb" rulings): compact is cheap; guards that refuse work because "nothing would change" add branches without benefit. The old guard's concurrency-fence role is covered by hosts serializing compact against intake; a stale snapshot corrupts nothing and the next compact replaces it.
- Status: firm
- Evidence: commit f4f9601 (guard removal); packages/lhc/src/thread-view/index.ts (unconditional snapshot write); packages/lhc/test/view-compact-full-boundary.test.ts (backward-point compact succeeds)
- Confidence: high

### VIEW-22: Preview and compact share one arrangement computation
- Decision: previewCompact uses the same computeArrangement path as compact, so the predicted compact point and band possibility are exact by construction.
- Why: a separate preview implementation would drift. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/compact-compute.ts:1; packages/lhc/src/thread-view/index.ts:329,390-397
- Confidence: high

### VIEW-23: The stored arrangement records provenance of degradation and gaps
- Decision: Compact persists arrangement entries with band, subject, derivationUsed, degraded flag, gaps, source-state counts, and per-band token counts; describe reads snapshot provenance verbatim without recomputing.
- Why: the view must be auditable after the fact. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/index.ts:456; packages/lhc/src/thread-view/internal/snapshot.ts:71
- Confidence: high

### VIEW-24: thread-view carries acknowledged direct-read debt
- Decision: Selection inputs come from turnsDomain.readTurnChunkStructure and messagesDomain.readLiveMessages, but thread-view still reads derivation/event tables directly for tail assembly and boundary decisions — recorded as known cleanup debt, not a design choice.
- Why: domain-boundary rule (call surfaces, not tables) vs. pragmatic selection reads. [rationale: documented]
- Status: interim (successor: unnamed boundary cleanup; bad-code-log domain-boundary-leakage entry)
- Evidence: docs/onboard/02-domain-design.md §Domain surfaces; packages/lhc/src/thread-view/internal/select.ts:100-106
- Confidence: high

### VIEW-25: Budget-excluded-but-usable turns are currently labeled `gap`
- Decision: Coverage entries falling to the last rung use derivationUsed:"gap" even when the exclusion is budgetary; ruled wrong — "gap" should mean nothing usable exists; a distinct term for budget-excluded-with-content is pending.
- Why: an agent reading the view must distinguish "history is thinner than it should be" from "history was deliberately excluded". [rationale: documented]
- Status: interim (successor: fixes-feature-log item 6)
- Evidence: fixes-feature-log item 6; packages/lhc/src/thread-view/internal/select.ts:463
- Confidence: high

### VIEW-26: Inspect's view report measures serving cost by running the serving path
- Decision: inspect.view reports load cost by calling threadView.getLlmRequestContext and counting output with the shared estimator — structurally identical to what an agent would receive — not by summing stored counts.
- Why: reported cost must be the real cost. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/02-domain-design.md §Inspect; packages/lhc/src/inspect/internal/view-report.ts:2; commit ba91d83
- Confidence: high

### Graveyard
- was automatic visibility-boundary advance at turn_end with 64k/32k budgets and whole-turn oldest-first eviction (Epic 05 Story 6, commit 3c1b0c7) → replaced by no automatic trimming; boundary moves only on compact reset (commit 7aad42d)
- was openTurnHasMembers gate blocking compact preview → removed (commit 062ee71); the dead turn_not_ready branch it fed was removed in pi-lhc (fixes-feature-log item 2)
- was `wouldProduceBandsPreview` dead helper carrying the old strict-advance logic → deleted (fixes-feature-log item 1 riders; commit b6ceefb)

## QUEUE

### QUEUE-1: Work items commit in the same transaction as the change that caused them
- Decision: Enqueue writes on the caller's handle inside the ambient transaction — the work row, the derivation's pending row, and the scheduler poke commit together or vanish together. Queued work is durable rows, never in-memory state; a restart loses nothing.
- Why: crash-safety without a daemon — pending work is recorded durably, not held in memory. [rationale: documented]
- Rejected: in-memory work queues; external job daemon.
- Status: firm
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:1-6,139-159; docs/onboard/02-domain-design.md
- Confidence: high

### QUEUE-2: Queue mechanics are domain-blind; each work kind has exactly one owning domain
- Decision: The util owns mechanics (rows, claims, retries); domains own meaning. WORK_KIND_REGISTRY maps six kinds to owners; SDK construction merges domain handler tables and refuses duplicate kind claims; derivation targets ride the payload so terminal paths can land failed/blocked without asking a domain what a kind means. Domains never queue into or watch another domain's items.
- Why: ownership boundaries keep queue mechanics out of domain vocabulary and vice versa. [rationale: documented]
- Rejected: domain surfaces exporting workHandlers (bad-code-log: construction wiring on runtime surfaces).
- Status: firm
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:13-51,37; docs/onboard/bad-code-log.md workHandlers entries
- Confidence: high

### QUEUE-3: One item at a time per thread, head-first, never skip-ahead
- Decision: The claim decision is made against the oldest live row only; a later eligible row is never considered while an older live row exists (backoff or a live lease on the head gates the whole queue). Thread order is the dependency mechanism.
- Why: dependencies between items aren't knowable in general; strict order makes them irrelevant. [rationale: documented]
- Rejected: eligible-first scheduling; general parallel drain.
- Status: firm
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:426-482; fixes-feature-log item 22
- Confidence: high
- Open: item 22 plans parallelism for message-level derivations (independent by construction) and concurrent chunk brief+detailed, when tool-activity inference returns

### QUEUE-4: Claims are leases fenced by a monotonic epoch
- Decision: Claiming increments claim_epoch; every completion/retry/delete is guarded by workItemId AND claim_epoch, so a stale holder's writes miss ("lost_lease"). Claim is one atomic UPDATE under BEGIN IMMEDIATE — no read-then-write split. Expired leases (default 120s) are reclaimable; reclaim increments attempts to make the crash visible and count it against the budget.
- Why: a restarted process must not double-execute work claimed by its dead predecessor; a hung handler must not stamp a derivation that moved on. [rationale: documented]
- Rejected: lock files / PID liveness checks.
- Status: firm (lease duration tunable-config)
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:426-455,500-506; commits 89bbcd9, e38ee2f
- Confidence: high

### QUEUE-5: Deterministic work-item ids scoped to source version
- Decision: workItemId = `w-<sourceId>-<kind>-v<sourceVersion>`: re-queueing the same kind/source/version is the same id; a post-mutation replacement at the next version never collides with older in-flight work.
- Why: id stability gives idempotent re-queue and collision-free supersede. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:91-96
- Confidence: high

### QUEUE-6: Enqueue is the only creator of derivation rows; completion is UPDATE-only
- Decision: Enqueue INSERTs/resets the pending derivation row; complete() UPDATEs only, WHERE-clauses on source_version — zero hits means stale_discarded, partial hits throw as corruption. failTerminal is likewise version-checked.
- Why: the create/update split is what makes the version fence airtight (and matches the no-upsert stance for semantics-bearing writes). [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:139-143,484-553,567-571
- Confidence: high

### QUEUE-7: Drain shape — claim txn, handler with no open transaction, completion txn
- Decision: Claim, complete, and the terminal half of failAttempt each own one short BEGIN IMMEDIATE; the handler runs between them with no open transaction. onApplied hooks run inside the completion transaction (for follow-on placement/enqueues); onCommit registrations flush after COMMIT and drop on rollback. Completion writes and item deletion are atomic.
- Why: never hold the write lock across inference; follow-on work must be atomic with completion. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:317-320,484-553; packages/lhc/src/shared-tech/scheduler.ts:1-8
- Confidence: high

### QUEUE-8: Retries — exponential backoff with cap, bounded budget; terminal failures land visibly with metadata copied
- Decision: Under budget and retryable, the row returns to queued with eligible_at pushed out (min(base×2^attempts, cap)); at budget or non-retryable, the derivation lands failed (or blocked for source damage) with attempts/lastError copied to derivation metadata and the item row deleted. Retryable-vs-terminal classification is the adapter/handler's duty.
- Why: bounded retries with visible exhaustion; the queue stays mechanics-only. [rationale: documented]
- Rejected: keeping poison work items forever; immediate tight retry loops.
- Status: firm (budget/backoff values tunable-config: 3 / 5000ms / 60000ms)
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:632-667; commit d6617e0
- Confidence: high

### QUEUE-9: Supersede deletes queued items only; claimed items are left to the version fence
- Decision: The cascade supersede-deletes still-queued old-version items (reported on the mutation result); claimed items are deliberately untouched — their stale completions discard at the version check.
- Why: two fencing mechanisms, each where it's cheap: delete what hasn't started, fence what has. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:669-689; packages/lhc/src/messages/internal/cascade.ts:7
- Confidence: high

### QUEUE-10: Two host modes — background (scheduler-driven) and manual (inert)
- Decision: Chosen at SDK construction. Background: post-commit pokes trigger drains; first-touch catch-up drains leftovers from previous process lifetimes; wake timers fire on retry eligibility and claim expiry. Manual: the host calls work.drain; the scheduler is inert.
- Why: an interactive host wants automatic progress; tests and controlled hosts need determinism. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Host mode"; packages/lhc/src/shared-tech/scheduler.ts; commit d1be3ab
- Confidence: high

### QUEUE-11: Per-thread single-flight with pending-flag coalescing; in-memory scheduler state is advisory only
- Decision: At most one drain runs per thread with at most one pending pass queued behind it; bursts of pokes coalesce. Cross-process safety comes from the durable lease alone — a fresh handle sees identical drain behavior because the queue is the rows.
- Why: memory state can't be trusted across processes; coalescing bounds drain concurrency without locks. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/scheduler.ts:1-8,474
- Confidence: high

### QUEUE-12: Background scheduling fail-closes on an empty handler map
- Decision: Pokes and catch-up stay inert until a handler table is populated explicitly — with an empty map a background drain could only turn queued rows into failed_terminal.
- Why: an unwired background SDK must not destroy queued work. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/scheduler.ts:62-69
- Confidence: high

### QUEUE-13: The instance seam isolates multiple SDKs in one process
- Decision: Every SDK operation runs inside its instance's async-context; pokes and thread-file touches reach that instance's scheduler only. A manual SDK's operations deliver to a no-op seam so a background SDK in the same process can never auto-drain the manual SDK's work.
- Why: mode isolation was a real bug class ("mode-isolated scheduler seams" fix). [rationale: documented]
- Rejected: shared module-level scheduler slots.
- Status: firm
- Evidence: packages/lhc/src/shared-tech/context.ts:6; commit 9349b3f
- Confidence: high

### QUEUE-14: Unregistered kinds are still claimable so they can land failed_terminal
- Decision: ClaimedWorkItem.kind is a plain string — a raw row with an unregistered kind must still be claimable so the drain can land it failed_terminal instead of skipping it.
- Why: poison rows must drain out visibly, not wedge the head-first queue forever. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/work-queue/index.ts:322-326
- Confidence: high

### QUEUE-15: Schema migrations run at thread-file open (current: v3)
- Decision: Opening a thread through the threads domain guarantees the schema is current. v2→v3 (the rename migration) used JSON-key-anchored provenance rewrites that can only match provenance keys — never content or metadata prose, queue-item normalization covering queued AND claimed leftovers, and seed-first + transaction for crash-window safety.
- Why: per-thread files can be arbitrarily old; migration must be crash-safe and must not corrupt user-visible text. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/thread-migrate.ts; fixes-feature-log Done: Slice B
- Confidence: high

### QUEUE-16: Handler deferral is delete-and-re-enqueue, not retry-in-place
- Decision: A handler can return deferred with an onDeferred hook: its claimed item is deleted (epoch-checked) and the hook re-enqueues prerequisites plus itself behind them, in one transaction. Used by chunk_summary_brief waiting on detailed.
- Why: head-first ordering means an item waiting on later work would deadlock the queue; re-enqueue moves it behind its dependency. [rationale: inferred]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/derivation.ts:290-294; packages/lhc/src/turns/internal/derive.ts:670-697
- Confidence: medium

### QUEUE-17: Wake timers cover retry eligibility and claim expiry; drainSettled spans them
- Decision: If a drain stops on backoff or an in-flight claim, a single unref'd timer re-enters scheduling at the next check time; drainSettled counts a pending backoff/expiry wake as unsettled and waits for it.
- Why: a stopped head with no future poke would otherwise strand work; settle semantics must cover scheduled futures. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/scheduler.ts:420-461,508-513; commit d1be3ab
- Confidence: high

### QUEUE-18: Sync-vs-async dispatch routes by a stored operation intent
- Decision: Work items carry a DurableWorkOperation intent (messages.derive / turns.deriveTurn / turns.deriveDetailedTurnCompression / turns.deriveDetailedChunk / turns.deriveBriefChunk); the drain looks up a dispatcher by operation with kind as fallback, so the same row drains identically whether queued by intake, cascade, or a synchronous derive that fell back to queueing.
- Why: one durable row format serving both entry modes keeps recovery uniform. [rationale: inferred]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/durable-work/index.ts:14-47,95-113; commit a200ec1
- Confidence: medium

### QUEUE-19: Message-level parallelism is deferred, by explicit plan
- Decision: The queue drains strictly serially today; parallel execution of message-level derivations (independent by construction) plus concurrent chunk brief+detailed is the planned pressure-relief valve for when high-frequency inference returns.
- Why: not needed while tool activity is truncation-only; becomes necessary at item-11 inference volume. [rationale: documented]
- Status: interim (successor: fixes-feature-log item 22)
- Evidence: fixes-feature-log item 22; packages/lhc/src/shared-tech/scheduler.ts:109
- Confidence: high

### Graveyard
- was unfenced claim completion → replaced by epoch-fenced claims (commit 89bbcd9)
- was no backoff wake timer → replaced by scheduler wake for retry eligibility / claim expiry (commit d1be3ab)

## INFER

### INFER-1: Model access arrives exactly one way — inferenceCallbacks XOR inference config
- Decision: initLhc requires exactly one of direct callback injection or `inference` (one host ModelCall plus per-kind assignments the adapter resolves into callbacks). Both or neither is a construction TypeError, validated before anything downstream.
- Why: one seam, no ambient fallback. [rationale: documented]
- Rejected: provider registry with env/flag resolution (deleted with the CLI); silent default provider.
- Status: firm
- Evidence: packages/lhc/src/sdk.ts:489-524; commits b84ebcd, 93d5a16, d7ba08a
- Confidence: high

### INFER-2: The four-operation InferenceCallbacks interface is the entire inference boundary
- Decision: smoothPrompt, summarizeToolResult, compressDetailedTurn, summarizeChunkBrief — every model call LHC makes crosses this interface; deterministic derivations never reach it. Each operation returns text or a structured failure carrying retryability.
- Why: a narrow named boundary keeps host model access substitutable and testable. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/derivation.ts:123-149,197-204; docs/onboard/01-core-concepts.md "Inference callbacks"
- Confidence: high
- Open: fixes-feature-log item 17 makes LHC-owned native HTTP inference the default lane; the callback interface survives as the substitution point for constrained environments (convergence ruling: boundary firm, default lane interim)

### INFER-3: ModelCall is single-turn; provider/model strings are host routing keys
- Decision: The one host function takes {provider, model, messages(system|user), thinking?} and returns text or a classified failure. No multi-turn, no streaming, no tool protocol. LHC treats provider/model strings as routing keys the host's ModelCall alone interprets.
- Why: derivations are one-shot transforms; provider semantics belong to the host. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/inference-types.ts:1-16; fixes-feature-log item 21 (single-turn scope)
- Confidence: high
- Open: under item 17/21 the native provider layer will interpret its own provider enum; the routing-key rule then applies only to the callback substitution path

### INFER-4: Per-kind ModelAssignment routes each inference derivation independently
- Decision: Each inference type gets an assignment (provider + model + prompt name + target ratios + thinking level); host-omitted types fill from defaults; unknown assignment keys and unknown prompt names are construction errors; deterministic types are not assignable.
- Why: per-kind routing lets each derivation use the cheapest adequate model; closed keys catch config typos at construction. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/sdk.ts:413-478; packages/lhc/src/shared-tech/inference-types.ts:70-79
- Confidence: high

### INFER-5: Default inference lane is codex / gpt-5.4-mini / thinking none — an interim placement, layered
- Decision: All four inference kinds default to provider "codex", model gpt-5.4-mini, thinking none, with tuned ratios and the v3 compression/brief prompts (SDK layer, sdk.ts). The pi-lhc connector overlays its own default table using PI's provider key "openai-codex" (model-call.ts) — the connector's table overrides the SDK's, and the two layers use different routing keys for the same lane. Both tables must be read together to know what actually runs.
- Why: the currently-dialed control lane from prompt-lab tuning — mini graded zero fidelity errors across the v3 sweeps. Successor candidates from the nine-model sweep (2026-07-02, single-run evidence in prompt-lab results): gpt-5.3-codex-spark (mini-grade quality, ~3× speed, plan-covered — pending item 21's CLI-harness provider) and oss-120b-low on Cerebras (~1,100 tok/s, tier-3 fidelity) for the high-volume lanes. The two-layer shape is a consequence of host-interpreted routing keys. [rationale: documented]
- Status: interim (successors: fixes-feature-log items 17 native lane + 19 model exploration; per-model stated-target bias ruled toward assignment config)
- Evidence: packages/lhc/src/sdk.ts; packages/pi-lhc/src/inference/model-call.ts:272-276; prompt-lab results (runs.jsonl)
- Confidence: high

### INFER-6: Prompt registry is name-keyed modules; versioning lives in the name
- Decision: PROMPT_REGISTRY maps names (smoothing-v1, detailed-turn-compression-v3, chunk-brief-v3, …) to {name, render} modules; superseded versions stay registered for provenance. Dial-in = add a module + edit config; no handler/adapter/host changes. PROMPT_NAMES exports valid names; DEFAULT_PROMPT_NAMES records per-kind defaults (compression and brief default to their v3 modules).
- Why: prompt tuning must not touch pipeline code. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/prompts/index.ts; commit e2a5d4c
- Confidence: high

### INFER-7: One adapter pipeline for every kind — bound, render, safeCall, classify, reject-empty, stamp provenance
- Decision: Input bounding (head+tail around a truncation marker, hard cap maxInputChars) happens before rendering so the dropped middle never crosses the boundary. safeCall contains host exceptions (classified `other`) and hung calls (timeout race). Whitespace-only output is a retryable empty_output failure, never a ready derivation. The adapter never parses model text for outcomes, receipts, or mechanical facts.
- Why: a pathological tool result must not blow a small-context model; host bugs must not crash the drain; empty text is not a derivation; facts come from the record. [rationale: documented]
- Status: firm (maxInputChars 200k and timeout 60s values tunable-config)
- Evidence: packages/lhc/src/shared-tech/inference-adapter.ts:1-33,88-122; commit b7139e1
- Confidence: high

### INFER-8: Failure classification is a fixed retryability table with machine-readable reasons
- Decision: rate_limit/timeout/network/empty_output/other are retryable; auth/invalid_request are terminal. Reason strings follow the code-before-first-colon convention; retryable failures lead with provider_failure. The queue consumes `retryable` unchanged.
- Why: uniform failure semantics across kinds and hosts; queue machinery stays untouched. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/classify.ts:8-16; packages/lhc/src/shared-tech/inference-adapter.ts:35-48; commit d6617e0
- Confidence: high

### INFER-9: Guards are per-kind operational limits with centralized defaults
- Decision: DerivationGuards (smoothing max tokens + suspicious ratio, tool-result timeout, tiny-turn threshold) resolve through one pure function so no defaults drift between construction and the values tests pin.
- Why: operational limits are config, not scattered constants. [rationale: documented]
- Status: firm (mechanism); values tunable-config
- Evidence: packages/lhc/src/shared-tech/inference-types.ts:43-117; packages/lhc/src/sdk.ts:504
- Confidence: high

### INFER-10: Assignment ratios merge into the prompt render input; handlers own token arithmetic; v3 templates own their stated figures
- Decision: An assignment's targetMin/Aim/MaxRatio merge into the render input, and concrete token targets are computed by the owning handler from actual input size — that plumbing stands. The v3 templates, however, deliberately ignore the passed acceptance-derived targets and compute their *stated* token figures internally from inputTokens × their own stated ratios (see INFER-13); the handler-computed targets remain what sizeDisposition measures against.
- Why: the handler owns acceptance arithmetic; the template owns what the model is told — two different numbers by doctrine. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/inference-adapter.ts:50-73; packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v3.ts; packages/lhc/src/turns/internal/derive.ts
- Confidence: high

### INFER-11: Prompt templates are golden-pinned; the registry is type-pinned read-only
- Decision: Every registry template has a golden file pinning rendered output (drift visible in review before any model call); PromptTemplate<never> pins the registry read-only at the type level — rendering goes only through the adapter, which owns the kind→input pairing. The tool-result v2 template deliberately hides diagnostic routing fields (operationClass/responseShape) from the rendered prompt.
- Why: prompt drift is an architecture risk; nothing else may render templates; routing metadata is not prompt content. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/prompts/index.ts:19-22; packages/lhc/test/goldens/prompts/; packages/lhc/test/inference-prompts.test.ts
- Confidence: high

### INFER-12: Native LHC-owned inference is the planned default lane
- Decision: Ruled direction: LHC ships its own direct HTTP inference client (OpenAI chat-completions shape, single-turn) as the default derivation lane, with a deliberately scoped provider/model-selection layer; host callbacks demote to the substitution point for constrained environments (e.g., a Claude Code subprocess provider at work).
- Why: every mystery of the tuning round lived below the callback boundary (the system-prompt drop shipped invisibly); direct calls are wire-observable and behave identically across hosts. [rationale: documented]
- Status: planned (fixes-feature-log items 17 + 21; sequencing: OpenRouter first, high-speed provider before any high-frequency inference)
- Evidence: fixes-feature-log items 17, 21
- Confidence: high

### INFER-13: Stated targets and acceptance windows are deliberately different numbers
- Decision: A compression template *states* a target chosen to steer the model (turn v3: 20–30%; brief v3: 5–10%), while the assignment's ratios define the *acceptance* window sizeDisposition measures against (35–65 / 8–20). The stated bias lives in the template (which computes its stated token figures from inputTokens, magnitude-rounded: nearest-100 when the figure ≥1000, else nearest-10); acceptance lives in assignment config. Both sites carry a comment marking the divergence as deliberate.
- Why: models don't land on what you say — GPT-family lands 1.5–2× above the stated ask (measured across the v3 sweeps), so you state low to land in-window. The stated range is a steering input, not the requirement. [rationale: documented — by ruling]
- Rejected: stating the acceptance band verbatim (the v2 failure — GPT rode its top and beyond).
- Status: firm (doctrine); stated/acceptance values tunable-config
- Evidence: packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v3.ts; chunk-brief-v3.ts; packages/lhc/src/sdk.ts (assignment comment); fixes-feature-log Done: item 14
- Confidence: high
- Open: per-model stated-target bias in assignment config (Opus/gemma undershoot ~0.5×, GPT overshoots — one prompt can't serve both; items 19/21)

### INFER-14: Derivation prompts are minimal, single user message, narrative register, no examples
- Decision: The v3 prompt doctrine, applying to compression templates and to future prompt work: (a) one user message, no system message — nothing for a host lane to drop or rewrap (the item-12 failure class eliminated by construction); (b) minimal trust-the-model instructions in Lee's voice — task, size, voice, judgment delegation; enumerated keep/drop rules and guardrail sentences are added only against that lane's *measured* failures (+55 tokens of untargeted guardrails measurably cost 20–30 ratio points on dense inputs); (c) output register is third-person past-tense narrative — a transformation that cannot be satisfied by copying, which is what broke the echo failure mode; (d) no embedded examples — and if examples ever return, never harvested from this project's own content (v2 brief's examples about this codebase bled into production output the moment input topics overlapped).
- Why: measured head-to-head — the 253-token minimal prompt beat the engineered alternative on every axis, and each prohibition traces to a specific production defect. [rationale: documented — by ruling, with lab evidence]
- Rejected: system-message prompts (droppable); example galleries in production prompts (contamination + token cost); dialogue-register output (satisfiable by transcription).
- Status: firm
- Evidence: packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v3.ts; chunk-brief-v3.ts (header comment records the contamination lesson); fixes-feature-log Done: item 14, chunk-brief-v3
- Confidence: high

### INFER-15: Compression size targets — in prompts and in config — are steering guidelines, never specs
- Decision: The token ranges and percentages stated in compression prompts, and the target ratios in assignment config, are ballparks that get the model into the zone we need. They are tested guidelines, not decided specifications with tolerances. Outputs landing outside a stated or configured range are not defects; whether output is right is judged by reading it. Adjust these numbers freely without a design ruling.
- Why: repeated ruling — models treat any stated range as a bias, not a bound, and we sometimes state ranges we know a model won't stay in just to push it in a direction. Treating these numbers as locked specs keeps producing manufactured "recalibration decisions" about mismatches that have no consequence. [rationale: documented — by ruling, 2026-07-03]
- Status: firm (rule); every value involved is tunable-config
- Evidence: packages/lhc/src/sdk.ts (comment at the assignment ratios); packages/lhc/src/shared-tech/prompts/detailed-turn-compression-v3.ts
- Confidence: high

### Graveyard
- was CLI surface + provider registry + env/flag resolution → deleted; SDK-only public API (commit d7ba08a)
- was "DerivationProvider" seam naming → renamed to inference callbacks (commits a465803, cd28af1)
- was seven-kind assignment validation (Epic 05) → four inference kinds after deterministic realignment (commit 6f3fb67) and the Slice B/C rename
- was tool-call-v1 prompt in active defaults → tool calls not summarized; template survives only as a golden
- was PI/codex-lane bridge dropping system messages → replaced by partitionSystemPrompt into context.systemPrompt (fixes-feature-log item 12)

## PILHC

### PILHC-1: The connector is an observe-only hook rail holding plain data plus its own LhcInstance
- Decision: activate(pi) registers fail-closed handlers over a fixed hook set (session_start, message_end, turn_end, agent_end, model_select, thinking_level_select, fork/switch/shutdown, the two compact hooks). The connector never retains a PI ctx or session object (PI replaces them on new/resume/fork); retained state is structuredClone-able plain data; the live SDK instance is engine state rebuilt per session.
- Why: PI object lifetimes are PI's; holding them across boundaries is the bug class the plain-data rule prevents. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/index.ts:1-5,170-213; commit 16f8e48
- Confidence: high

### PILHC-2: Capture failures isolate; compact refuses over a hole
- Decision: A capture failure lands as a plain-data diagnostic on connector health rather than throwing into PI; the session continues. But session_before_compact cancels with capture_incomplete while lastCaptureFailure is set — a compact must not be built over incomplete capture.
- Why: capture is best-effort observation of a live session, but a view built from incomplete capture would be silently wrong. [rationale: documented]
- Status: firm
- Evidence: commit 345033a; packages/pi-lhc/src/compact/handler.ts:68-71
- Confidence: high

### PILHC-3: Malformed-but-writable capture records a durable runtime_note gap
- Decision: If LHC rejects a mapped batch as invalid_event, the connector records a synthetic runtime_note capture gap with a deterministic fingerprint-deduped idempotency key — a durable, queryable trace riding an existing event kind (deliberately no new kind).
- Why: nothing is silently dropped; the gap is in the record, not just in-memory health. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/capture/converter.ts:5-57
- Confidence: high

### PILHC-4: Idempotency keys are a four-tier precedence, scoped by session identity
- Decision: PI entry id > toolCallId > provider responseId > content fingerprint; pure/deterministic, scoped by piSessionId, with blockIndex and kind riding every tier so one message's fan-out stays distinct. Content alone is never sufficient — the fingerprint tier requires a caller-supplied fallbackId discriminator.
- Why: re-delivery dedup and crash-replay safety require identical keys for the same logical event, distinct keys for different events. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/capture/idempotency.ts:1-59
- Confidence: high

### PILHC-5: Thread identity is the LHC thread id, carried as a durable custom entry in the PI session
- Decision: The connector writes an LHC_THREAD_ENTRY_TYPE custom entry carrying the threadId into the PI session; reload reconstructs by reading the newest such entry and resolving through the registry — a fresh connector with an empty closure reattaches correctly. PI session id/path is never thread identity; no module-level state; no cwd-most-recent fallback on reload.
- Why: durable records over hidden session memory; PI sessions and connector processes both restart. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/index.ts:238-254,328-339; packages/pi-lhc/src/lifecycle/thread-resolution.ts:41-64
- Confidence: high

### PILHC-6: Launch modes — explicit fails loud, continue picks most recent, no flag creates new
- Decision: --lhc-thread <id> attaches explicitly and fails rather than falling back when unresolvable; --lhc-resume lists cwd-scoped candidates (one auto-resumes, multiple use the interactive picker; headless with multiple candidates fails closed and directs to --lhc-thread); no flag creates a new thread.
- Why: no input surface means no safe guess; explicit beats arbitrary. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/lifecycle/thread-resolution.ts:56; packages/pi-lhc/src/index.ts:276-316
- Confidence: high

### PILHC-7: New connector threads are titled from the cwd leaf
- Decision: With no title override, a new thread uses the cwd basename — session_start has no first prompt yet, and the leaf is a real project label for the picker. Prompt-derived titles are explicitly deferred.
- Why: better than untitled; the real solution is deferred with a name. [rationale: documented]
- Status: interim (successor: deferred prompt-derived titles, "TDQ Q4")
- Evidence: packages/pi-lhc/src/lifecycle/thread-resolution.ts:31-39
- Confidence: high

### PILHC-8: Default thread files live at ~/.lhc/threads/<uuid>.sqlite; the file name is just a handle
- Decision: The registry-generated thread id is the identity; the uuid file name is a unique handle only; the directory is ensured up front because DatabaseSync does not create parents.
- Why: identity belongs to the registry/file metadata, not the path. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/index.ts:318-326
- Confidence: high

### PILHC-9: The connector forces SDK background mode
- Decision: initInstance validates the thread then constructs LHC with mode:"background" regardless of caller config.
- Why: the connector must never accidentally drive the queue manually from hook code. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/lifecycle/instance.ts:37-42
- Confidence: high

### PILHC-10: Disposal awaits drainSettled; null disposal is a successful no-op
- Decision: Shutdown/switch disposal lets background work settle by default and returns an OpResult; captured intake is already durable, so flush is about settling, not saving.
- Why: durable capture makes shutdown ordering forgiving; settling avoids orphaned in-flight work. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/lifecycle/instance.ts:14,57
- Confidence: high

### PILHC-11: Context serving is launcher-owned SessionManager hydration, not the context hook
- Decision: pi-lhc ships its own bin/launcher that starts PI with the connector registered and performs launcher-owned startup: resolve thread, read getSessionThreadView, seed an in-memory PI SessionManager in record order, append the durable thread entry, dispose the read instance. The PI context hook is deliberately not used. Extension flags conflicting with PI session flags are rejected.
- Why: hydrating gives PI a real session (resume, display, compaction anchors) instead of ephemeral per-request context; serving-by-hydration requires control before PI's session starts. [rationale: inferred from hook comment + launcher design]
- Status: firm
- Evidence: packages/pi-lhc/src/index.ts:140; packages/pi-lhc/src/launcher/startup.ts:48; packages/pi-lhc/src/launcher/seed-session.ts:6; commit abc1b27
- Confidence: medium

### PILHC-12: Seeding writes a seed-entry map bridging LHC message ids to PI entry ids
- Decision: A custom seed-entry-map entry records lhcMessageId→piEntryId rows at hydration time so later compacts can map the first-kept message to a PI branch entry id.
- Why: compact splicing needs the translation; reconstructing it from text would be unreliable. [rationale: inferred]
- Status: firm
- Evidence: packages/pi-lhc/src/serving/context.ts:70-120; packages/pi-lhc/src/compact/handler.ts:111
- Confidence: high

### PILHC-13: Served assistant entries carry synthetic provenance
- Decision: Rehydrated assistant entries are stamped provider "lhc", model "thread-view", zeroed usage/cost — honest markers that the entries came from the view, not a billed completion.
- Why: PI requires the fields; fabricating a real provider/model would misattribute. [rationale: inferred]
- Status: firm
- Evidence: packages/pi-lhc/src/serving/context.ts:38-67
- Confidence: medium

### PILHC-14: The compact bridge is a fixed ladder that cancels on real failure — never on second-guessing
- Decision: session_before_compact runs: flush pending capture → refuse on capture failure → floor-gate on measured serving tokens → previewCompact → map firstKeptMessageId via the seed-entry map (cancel if unmappable) → compact → require receipt.renderedBands → assemble PI's compaction result from rendered bands + first-kept entry id. Every failure path cancels PI's compact with a coded diagnostic rather than letting PI's own compaction run over LHC's view. There is deliberately NO "nothing new to compact" gate: an explicit compact command executes, period — the only cancels are the floor gate and real errors. (Same-point rewrites re-render bands from current derivation content, which is what the re-derive tuning loop depends on.)
- Why: LHC replaces PI's compaction; a half-working bridge must cancel loudly, not corrupt the session. The no-second-guessing rule is a repeated ruling — skeleton-comparison gates blocked legitimate re-compacts twice (they cannot see content changes, and even a new tail turn doesn't move the arrangement); the ruling is recorded at the deletion site in the handler. [rationale: documented — by ruling]
- Rejected: unchanged-view no_op cancel (shipped twice in different forms, removed both times).
- Status: firm
- Evidence: packages/pi-lhc/src/compact/handler.ts; fixes-feature-log Done: "Explicit compact always proceeds" (2026-07-02)
- Confidence: high

### PILHC-15: The compact floor gate measures the real serving context
- Decision: Below COMPACT_FLOOR_TOKENS (50k) measured via getLlmRequestContext + estimateTokens (same as inspect's load cost), compact cancels with actual token counts. Deliberately kept under the profile lowerBound so snapshot repair is never gated.
- Why: compacting a small thread reclaims nothing; measurement must match what the agent actually loads. [rationale: documented]
- Status: interim (successor: named compact settings — fixes-feature-log item 18a)
- Evidence: packages/pi-lhc/src/compact/handler.ts:77-83; fixes-feature-log items 1 (Done), 18
- Confidence: high

### PILHC-16: The bridge passes explicit compact params, not a named LHC profile
- Decision: DEFAULT_COMPACT_PROFILE (120k lowerBound, 25/35/20/20) is passed as explicit params to preview and compact.
- Why: predates named-settings work; acknowledged placement. [rationale: documented]
- Status: interim (successor: fixes-feature-log item 18 named compact settings)
- Evidence: packages/pi-lhc/src/compact/profile.ts:3-12
- Confidence: high

### PILHC-17: The inference bridge resolves through PI's registry, partitions system prompts, and never fabricates
- Decision: createModelCall validates (provider,model) via ctx.modelRegistry.find, resolves per-request auth, completes through pi-ai; a runtime without pi-ai returns a classified failure — never fabricated text. partitionSystemPrompt extracts system-role messages into context.systemPrompt because pi-ai's converters silently drop unknown roles (the bug that sent every derivation prompt as "You are a helpful assistant"). Empty model text returns ok:true — the LHC adapter owns empty_output classification.
- Why: the system-message partition closed a silent instruction-drop bug caught only by wire capture; empty-text layering keeps classification in one place. [rationale: documented]
- Status: interim (successor: fixes-feature-log item 18c — re-plumb onto LHC's native lane; PI's registry returns to serving only the agent)
- Evidence: packages/pi-lhc/src/inference/model-call.ts:1-13,95-111,235; fixes-feature-log item 12 (Done)
- Confidence: high

### PILHC-18: Startup inference validation is diagnostic, never fatal to capture
- Decision: At session start the connector validates that assignment-referenced provider/models resolve in PI's registry, reporting through an injectable StartupValidationReporter seam; unreachable lanes surface to UI/health and capture keeps working.
- Why: fail at startup, not first derivation — but derivation lanes being down must not stop recording; the reporter seam replaced scattered test workarounds. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/inference/startup-validation.ts:1,103; docs/onboard/bad-code-log.md reporter entry; commit 1aed814
- Confidence: high

### PILHC-19: Operator assignment config merges over shipped defaults
- Decision: ConnectorDeps.assignmentConfig lets an operator override provider/model/prompt per derivation kind, merged over the connector's defaults via loadAssignments.
- Why: operators tune lanes without forking connector code. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/index.ts:149-168,256-274; packages/pi-lhc/src/inference/assignments.ts; commit 45e41dd
- Confidence: high

### PILHC-20: Rehydrate hands setup/model prefs through module-level one-shot slots
- Decision: Rehydration stores pending thread/sdk setup and model preferences in module-level slots consumed once by the replacement session's startup — in tension with the connector's stated no-module-level-state rule.
- Why: PI command-triggered session replacement gives the new session no live objects to receive state through. [rationale: inferred]
- Status: interim (unnamed successor; candidate for the item-18 rework)
- Evidence: packages/pi-lhc/src/lifecycle/rehydrate.ts:20,50; packages/pi-lhc/src/index.ts:333
- Confidence: medium

### PILHC-21: Forks create and seed a new thread from the fork point; fork state crosses as plain data
- Decision: session_before_fork captures {sourceThreadRef, forkEntryId} as plain data; the next session_start{fork} creates the forked thread and seeds it — no PI objects retained across the boundary.
- Why: forks are new threads, not shared history; same plain-data rule. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/index.ts:223-229; packages/pi-lhc/src/lifecycle/fork.ts
- Confidence: medium

### PILHC-22: Capture verification is replay-based
- Decision: The verify module replays a corpus of PI sessions through capture and compares LHC read-back field-for-field, rather than asserting on mocks.
- Why: capture correctness is a data-fidelity property; replay against fixtures proves it end to end. [rationale: documented]
- Status: firm
- Evidence: packages/pi-lhc/src/verify/replay.ts; commit bacc61d
- Confidence: high

### PILHC-23: pi-lhc is acknowledged tech-debt-heavy, pending a one-pass rework
- Decision: Ruled: the connector carries significantly more debt than lhc; the rework bundles named compact settings, connector cleanup, and the inference re-plumb in one pass. The connector onboarding doc (item 7) is deliberately deferred until after, to avoid documenting the pre-rework mess.
- Why: batching avoids double-documentation and repeated churn. [rationale: documented]
- Status: interim (successor: fixes-feature-log items 18 then 7)
- Evidence: fixes-feature-log items 18, 7
- Confidence: high

### Graveyard
- was turn_not_ready compact cancel branch → removed after openTurnHasMembers left previewCompact (fixes-feature-log item 2, Done)
- was the bridge passing system prompts only in messages → replaced by partitionSystemPrompt (fixes-feature-log item 12, Done)
- was the unchanged-view "no_op" compact cancel (skeleton comparison via wouldProduceBands) → removed; explicit compact always proceeds past preview (PILHC-14; fixes-feature-log Done 2026-07-02)

## VOCAB

### VOCAB-1: "Thread", never "session", for LHC's own container
- Decision: LHC has threads; "session" is reserved for the host's (PI's) construct. The connector maps PI sessions onto LHC threads.
- Why: two lifetimes must not share a name — PI replaces sessions on new/resume/fork while the thread persists. [rationale: documented]
- Status: firm
- Evidence: CLAUDE.md naming section; docs/onboard/01-core-concepts.md
- Confidence: high

### VOCAB-2: "thread-view", never "projection"; no "compiler" for assembly; no branded umbrella names
- Decision: The banded serving artifact is a thread-view; "projection" is banned (the strongest naming ruling, 0.95); "Projection Compiler" → thread-view-builder; "compiler" is banned for simple data building; branded umbrellas ("Context Steward", "Context Steward Core") are banned in favor of concrete module names.
- Why: projection/compiler import CQRS/compiler baggage that misdescribes assembly of stored derivations; brands are less precise than module responsibilities. [rationale: inferred — CLAUDE.md records the rulings; reasons partly unrecorded]
- Status: firm
- Evidence: CLAUDE.md naming section; docs/onboard/bad-code-log.md stale-wording entry
- Confidence: high

### VOCAB-3: "Derivation" replaced "form" as the stored-output noun
- Decision: The act is deriving; the stored result is a derivation; "form" is retired vocabulary (only a formState field name survives internally).
- Why: "form" was too generic to carry the domain meaning. [rationale: inferred]
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Derivation"; docs/onboard/bad-code-log.md; commit series cd28af1
- Confidence: high

### VOCAB-4: Derivation state belongs to derivation rows, never subjects
- Decision: Say "the derivation is pending/ready/failed/blocked", never "the chunk is failed" — subjects have no state.
- Why: the state model is per-derivation by design (see DERIV-3); the vocabulary enforces it. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Derivation states"
- Confidence: high

### VOCAB-5: "Source version" names the stale-result fence
- Decision: The monotonic version on derivation sources is the source version; late writes are "stale/discarded" against it — not "revision" or "generation".
- Why: one term for one mechanism. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Source version"
- Confidence: high

### VOCAB-6: Queue mechanics stay out of domain vocabulary
- Decision: Work rows are queue/drain mechanics; domain surfaces expose derivation status or repair operations, never raw queue vocabulary (workItemId/owner/kind as message behavior is the logged bad example).
- Why: mechanics and meaning separate (see QUEUE-2); the vocabulary enforces the boundary. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/bad-code-log.md listQueuedWork entry
- Confidence: high

### VOCAB-7: "Host mode" background/manual; there is no daemon
- Decision: Automatic vs explicit draining is host mode with background/manual values; draining happens inside the host process.
- Why: daemon/worker language would misdescribe the architecture. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Host mode"
- Confidence: high

### VOCAB-8: "Inference callbacks", not "provider seam" / DerivationProvider
- Decision: The model-access boundary is named for what it does (inference), not who supplies it (provider); a commit series renamed the seam and swept internals.
- Why: "provider" was already claimed by host routing keys; one word, one meaning. [rationale: inferred from the rename sweep]
- Status: firm
- Evidence: commits a465803, cd28af1, aba91a8
- Confidence: high

### VOCAB-9: detailed_turn_compression supersedes smooth_turn_compression
- Decision: The turn-compression derivation is named for the band it feeds (detailed), with callback compressDetailedTurn, renamed prompts/guards/config, and a v2→v3 migration rewriting stored rows.
- Why: the old name misdescribed the destination and misled every fresh reader (the recorded misnomer half of fixes-feature-log item 6). [rationale: documented]
- Status: firm
- Evidence: fixes-feature-log Done: Slice B, item 6; packages/lhc/src/shared-tech/thread-migrate.ts:8-11
- Confidence: high

### VOCAB-10: The deterministic dialogue strip is named pre_detailed_assembly
- Decision: The dialog-only input to detailed compression is a stored, named derivation — not an unnamed intermediate.
- Why: it is durable, consumed downstream, and needed a name in the taxonomy. [rationale: documented]
- Status: firm
- Evidence: fixes-feature-log Done: Slice C; packages/lhc/src/shared-tech/derivation.ts
- Confidence: high

### VOCAB-11: "Gap" is reserved for material absence; "degraded" means fallback content is shown
- Decision: gap = nothing usable exists (last rung); degraded = a lower rung's real content is rendered with a visible marker. Budget-excluded turns with ready derivations must not be called gaps (ruling made; code pending — see VIEW-25).
- Why: an agent reading the view must distinguish thin history from deliberately excluded history; degraded is not missing. [rationale: documented]
- Status: firm (ruling); the gap-relabel is interim (successor: fixes-feature-log item 6)
- Evidence: docs/onboard/01-core-concepts.md "Degraded / gap"; fixes-feature-log item 6
- Confidence: high

### VOCAB-12: render / materialize / LlmRequestContext name the three exits
- Decision: Render produces entry output; materialize writes host-specific files; LlmRequestContext is the in-memory model context. Never collapsed into generic export/write terms.
- Why: three different consumers, three defined edges. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "Render / materialize / LlmRequestContext"
- Confidence: high

### VOCAB-13: threadRef names references; "threadId-map", not "runtime aliases"
- Decision: Parameters that may be {threadId}|{filePath} are threadRefs (commit-swept); the PI-session↔thread mapping is a threadId-map; "original PI session" phrasing is replaced by source-of-truth threadId.
- Why: a ThreadRef may be a filePath — calling it a thread or id is inaccurate. [rationale: documented]
- Status: firm
- Evidence: commit 6c1132b; docs/onboard/bad-code-log.md; packages/lhc/src/threads/index.ts:22; CLAUDE.md
- Confidence: high

### VOCAB-14: Names must expose leaks, not soften them; no generic wrapper nouns
- Decision: A leaky surface gets an explicit procedural name (registerWorkQHandlers) rather than a vague noun bucket (workHandlers); generic parameter names (input, opts, request, target) are rejected on domain surfaces in favor of role names; a user-chosen precise name must not be softened.
- Why: a name that names the mess keeps it visible for cleanup; generic wrappers create wiggle room before need exists. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/bad-code-log.md naming entries (commit 0ed3749 era)
- Confidence: high

### VOCAB-15: Standing banned terms
- Decision: Banned: "opaque"; "heartbeat"; "agent presence"/"agents_runs"; bare "blocks" as a standalone name; "summary"/"unknown" message types (v1); "Context Steward" branding; "integration test" as a category ("there is no such thing" — the split is fast vs full). Preferred: "async-thread-view" for the PI extension serving path, not "production path"/"hot path".
- Why: recorded as rulings; individual reasons mostly unrecorded. [rationale: documented as rulings; whys largely unknown]
- Status: firm
- Evidence: CLAUDE.md Naming/Terminology sections
- Confidence: high
- Open: the rationale behind several bans exists only in Lee's head — candidates for capture during the ratification pass

### VOCAB-16: Band names and working language
- Decision: The fidelity tiers are full/smooth/detailed/brief, named by character rather than mechanism or age; "the record" names the durable stream; "drain" names queue processing; "materialize" names writing a view to a host file. The onboarding vocabulary section is maintained as the project's working language with edges defined.
- Why: one working vocabulary, deliberately maintained. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/01-core-concepts.md "What we call things"
- Confidence: high

### Graveyard
- was projection / lower-band projection / Projection Compiler → thread-view, rendering, builder/materialize (CLAUDE.md; bad-code-log)
- was `form` as the stored-output noun → derivation (commit sweep cd28af1)
- was generic workHandlers naming accepted as harmless → logged as leaky construction wiring (bad-code-log)

## MODEL

### MODEL-1: Per-model optimization via config plus discrete extensions; the record stays model-neutral
- Decision: Customizing/optimizing the harness per agent model is done through model config plus an array of discrete extensions flipped on and off based on the loaded model. Extensions can contribute both tools and system-prompt sections. The durable record stays model-neutral forever; the served rendering becomes a function of (thread, model-profile). Profile key is model-tier, not model-name (Fable/Opus cluster together; GPT variants cluster; avoids per-point-release proliferation). Prompt contributions compose deterministically (fixed order, stable text per extension version) and are captured into the render, so reload/clone fidelity holds; a model swap on a live thread is a context-rebuild boundary.
- Why: different models need different support to run well in the same harness — first concrete case is the memory-maintenance protocol block: Claude models (Opus/Fable) have RL'd memory write-side reflexes and need only a pointer; models without that training (GPT, GLM 5.1) need the full protocol spelled out and possibly active nudges at rebuild boundaries. Model-specific behavior belongs in config/extensions, never in shared prompt text (same doctrine as per-model drift bias in derivation assignments). [rationale: documented]
- Rejected: model-conditional text baked into shared prompts; a model-neutral single served rendering for all agent models.
- Status: firm (ratified by Lee 2026-07-04, not excavated)
- Evidence: fixes-feature-log item 20 (per-model dimension, 2026-07-04); item 28 (memory-index injection rulings); exa-search extension config-gating precedent (2026-07-03)
- Confidence: high

## PROC

### PROC-1: Expected failures return OpResult with three error classes; throws are programmer bugs
- Decision: Every fallible operation returns {ok:true,value}|{ok:false,error} where error carries a machine-readable code (closed enum), human reason, and errorClass ∈ caller_error | state_corruption | system_error. Machine logic switches on code, never reason. Infrastructure failures are expected outcomes wrapped as storage_failure.
- Why: callers need a stable, classifiable failure surface; throw-vs-return ambiguity is eliminated by rule. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/shared-tech/errors.ts:1-61; docs/onboard/01-core-concepts.md "OpResult"
- Confidence: high

### PROC-2: Construction mistakes throw; invocation mistakes return results — one rule set, two rejection surfaces
- Decision: Bad SDK/profile config at construction is a programmer error that throws; the same validation rules reject compact-time profile/param mistakes as caller_error OpResults.
- Why: the caller class differs, the rules must not. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/src/thread-view/internal/profiles.ts:1; packages/lhc/src/shared-tech/errors.ts:28
- Confidence: high

### PROC-3: Golden files are immutable without a granted deviation
- Decision: Selection goldens pin exact arrangements hand-derived from design rules. An implementation that disagrees with a golden is wrong until the design rule is shown wrong; regeneration (GOLDEN_DUMP=1) is allowed only with a granted deviation, hand-verified and recorded.
- Why: goldens encode ratified rules, not current behavior; editing them to match code inverts the authority. [rationale: documented]
- Status: firm
- Evidence: packages/lhc/test/goldens/README.md
- Confidence: high
- Open: Lee has noted the ceremony around this may be inherited process rather than his ruling; the lightweight core (no silent regeneration) is confirmed

### PROC-4: No silent auth-based test skips; the real-inference suite reports NOT-RAN explicitly
- Decision: Tests must not silently skip when keys are absent. The real-inference suite implements this: unkeyed runs produce an explicit NOT-RAN accounting line with a green accounting leg asserting the not-ran record; keyed legs report as skipped, never as passes.
- Why: silent skips create failures that hide issues; the accounting design exists to satisfy the ruling. [rationale: documented]
- Status: firm
- Evidence: CLAUDE.md Testing Preferences; packages/lhc/test/inference-real.test.ts:6-16 header
- Confidence: high

### PROC-5: Existing it.skip tests are acknowledged debt
- Decision: Skipped tests (old inference/tool-result paths) mark unfinished or deferred behavior and are not green coverage.
- Why: visible debt beats deleted-or-faked coverage. [rationale: inferred]
- Status: interim (no single successor; the remaining skips are tied to fixes-feature-log item 11 — item 4's share was resolved 2026-07-03)
- Evidence: packages/lhc/test/inference-adapter.test.ts; packages/lhc/test/tool-result-rendering.test.ts
- Confidence: medium

### PROC-6: Two-tier verification; biome at root; Node pinned
- Decision: `verify` = biome format check + lint + typecheck + fast tests; `verify:all` adds keyed/slow suites. Biome config lives at the root and format/lint must run from the repo root (package-local verify breaks). Node is pinned >=24.17.0 <25, with the runtime-first-in-PATH failure logged.
- Why: fast gate for iteration, full gate for landings; one formatter config, one invocation point; ambient-PATH mismatches caused real confusion. [rationale: documented]
- Status: firm
- Evidence: root package.json scripts/engines; commits 980688f, 14ad907; docs/onboard/bad-code-log.md PATH entry
- Confidence: high

### PROC-7: No regression-tombstone tests
- Decision: Tests whose only purpose is proving a deleted/renamed symbol stays gone are banned ("fear artifacts"), except where absence is a real contract (migration boundary, compatibility rejection, security rule, explicit deprecation).
- Why: they bloat the suite and test nothing live; a recurring LLM failure mode. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/bad-code-log.md regression-tombstones entry
- Confidence: high

### PROC-8: No premature compatibility shims
- Decision: Fallback names, dual pathways, and back-compat layers are refused unless due diligence identifies a real client, persisted artifact, released API, or migration boundary. Real boundaries get real machinery (the v2→v3 thread migration).
- Why: shims hide bugs, preserve stale concepts, and add debt exactly where the refactor simplifies. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/bad-code-log.md premature-shims entry; commit cb24def
- Confidence: high

### PROC-9: Tests drive real entry points and assert durable outcomes; seams stay close to technical modules
- Decision: The ruled test shape drives real surfaces (intakeStream.messageEvents, enqueue/drain, domain derive*) and asserts transitions, read-backs, and queued work — not exported pure state machines as rule tables, and not fixtures injecting handler maps through runtime API fields. Unavoidable helpers live near the technical module, off product surfaces.
- Why: permutation tables inflate coverage while bypassing durable side effects; runtime seams teach the product API test concerns. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/bad-code-log.md testing entries; commit 866aba1
- Confidence: high

### PROC-10: Spec scaffolding is disposable; git history is the record
- Decision: The spec-driven epics' artifact trails (spec packs, story runs, rulings, amendment ledgers) were deleted in one cleanup to remove search noise; narrated commit messages remain the record; targeted recovery from git is the sanctioned pattern (a deleted fixture was recovered byte-identical).
- Why: specs served the build; keeping them polluted search and reading paths. [rationale: documented]
- Status: firm
- Evidence: commit 431bbbe; fixes-feature-log item 8 (Done)
- Confidence: high

### PROC-11: The numbered deviation/ruling process was epic-era; fixes-log items are the current mechanism
- Decision: During spec-driven work, implementor deviations surfaced as needs-ruling and were ratified by numbered lead rulings with amendment ledgers. Current work tracks decisions and deviations through fixes-feature-log items and this registry instead.
- Why: the heavyweight process served the epic builds; lighter durable logs serve the current stage. [rationale: documented]
- Status: firm (historical scope marked; goldens deviation process remains live via PROC-3)
- Evidence: test/goldens/README.md (ruling-013); commits e2a5d4c, 3c1b0c7
- Confidence: medium

### PROC-12: Prompt tuning happens in a lab against real specimens; promotion only when proven
- Decision: Prompts are tuned in test/prompt-lab with self-contained case files harvested from real threads (measured ratios, finish_reason capture, model/effort sweeps); deterministic input normalization is tried test-file-first and promoted to the composer only when the promoted artifact byte-matches what the runs validated. Ruled principles: stated target biases off the acceptance band per model (INFER-13); targets in percentages AND absolute tokens; less-is-more — additions to a prompt must trace to that lane's measured failures (INFER-14), and production prompts carry no examples. Iteration against live threads uses the per-chunk/per-turn re-derive surfaces, not re-fills.
- Why: shipped v2 prompts lost previously-validated learnings; the lab makes learnings durable and testable. [rationale: documented]
- Status: firm
- Evidence: fixes-feature-log items 14 (Done), 15; packages/lhc/test/prompt-lab/
- Confidence: high

### PROC-13: Wire-truth capture and adversarial verification are the norm for risky changes
- Decision: What actually reaches the model is verified by wire capture (prompt-lab/bin/wire-capture.mjs), not template-level reconstruction — reconstruction was proven able to lie (the system-prompt drop). Risky slices get adversarial fork-verification rounds (the A/B/C stack caught three queue-poison paths that way). Full request/response logging per attempt (item 13) is the planned permanent form.
- Why: the bridge bug shipped precisely because reconstruction looked correct; only wire truth counts. [rationale: documented]
- Status: firm
- Evidence: fixes-feature-log items 12 (Done), 13; Done: Slices A/B/C
- Confidence: high

### PROC-14: Comments state the current invariant, not implementation history
- Decision: A dedicated commit series stripped epic/story archaeology from production comments; surviving comments protect transactions, ordering, and invariants; long acceptance-criteria prose is a logged smell.
- Why: history in comments makes code read like an archaeological record. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/bad-code-log.md comment entries; commit series 9ed43d8…4dde316
- Confidence: high

### PROC-16: Append-only working logs are the between-sessions memory
- Decision: bad-code-log.md (append-only failure patterns with citations) and fixes-feature-log.md (numbered items, moved to Done with outcomes) are the durable knowledge capture; onboarding docs update only after behavior stops moving. This registry joins them as the compiled current-state decision view.
- Why: durable records over hidden session memory (project rule). [rationale: documented]
- Status: firm
- Evidence: docs/onboard/bad-code-log.md header; fixes-feature-log structure, item 5
- Confidence: high

### PROC-17: Test-visible external behavior gets an injectable seam, not scattered workarounds
- Decision: When tests must suppress or observe UI/headless logging behavior, an injectable reporter seam is the pattern (startup validation reporter is the logged good correction).
- Why: scattered local suppression was the logged failure. [rationale: documented]
- Status: firm
- Evidence: docs/onboard/bad-code-log.md reporter entry; packages/pi-lhc/src/inference/startup-validation.ts:1
- Confidence: high

### Graveyard
- was isolated turns.transition rule-table testing → intake-driven durable behavior tests (bad-code-log; commit 866aba1)
- was SDK-exposed work handler dispatch for fixtures → helpers near the technical machinery (bad-code-log)
- was casual golden regeneration → deviation process with hand verification (goldens README)
