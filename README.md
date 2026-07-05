# Liminal Context (LHC)

Long Horizon Context is a durable context-management system for AI coding agents. It solves the problem that long-running agent sessions produce conversation threads exceeding LLM context windows. LHC records every event in a session to SQLite, derives compressed and summarized forms through an inference pipeline, and serves **smart compact** views — intelligently compressed conversation histories that fit within token budgets while preserving what the agent needs to keep working effectively.

The system is designed as an SDK consumed by host harnesses. The primary integration is with [PI](https://github.com/anthropics/pi), Earendil Works' coding agent, via the `pi-lhc` connector extension.

## Packages

```
packages/
├── lhc/       Core SDK — event storage, derivation pipeline, smart compact, thread views
├── pi-lhc/    PI extension — captures PI events into LHC, bridges compact, serves context
└── cc-lhc/    Claude Code wrapper (POC) — PTY passthrough, rollout capture into LHC intake,
               /lhc command interception, claude -p inference lane, prune/compact via
               rollout rebuild + --resume restart. State in ~/.cc-lhc/
```

### `lhc` — The Core SDK

A Node.js library with no CLI. The public API is a single `initLhc(config)` function that returns an `Lhc` object with domain namespaces: `threads`, `intakeStream`, `messages`, `turns`, `threadView`, `inspect`, `logging`, and `work`.

All state is persisted to a per-thread SQLite file (WAL mode, `node:sqlite`). The SDK never touches a network; inference calls are delegated to the host through a `ModelCall` callback.

### `pi-lhc` — The PI Connector

A PI extension that hooks into PI's session lifecycle. It captures PI events into an LHC thread, intercepts PI's compaction requests to run LHC smart compact instead, and seeds PI sessions from LHC thread views so agents start with full context history. It also provides the `pi-lhc` binary for launcher-owned startup.

`pi-lhc` depends on `lhc` (workspace dependency) and on PI's packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`) via local file references.

---

## Core Concepts

### Threads and Events

A **thread** is one durable conversation, stored as a SQLite file and tracked in a central registry (`~/.lhc/registry.sqlite`). Every piece of content entering LHC is an **event** — a typed, immutable record with an idempotency key:

| Event Kind | Source |
|---|---|
| `user_prompt` | User message |
| `assistant_text` | Model response text |
| `assistant_thinking` | Chain-of-thought |
| `tool_call` | Tool invocation |
| `tool_result` | Tool output |
| `turn_end` | Turn boundary marker |
| `runtime_note` | System annotations |
| `model_change` | Model switch |
| `thinking_level_change` | Thinking level switch |

Events are recorded through `intakeStream.messageEvents()` in atomic batches. Idempotency keys make crash-replay safe — re-delivering the same event is a no-op skip.

### Messages

Each event (except `turn_end`) is projected into a **message** with typed blocks and a token estimate. Messages are the unit of content the rest of the system works with.

### Turns

A **turn** is one user↔agent exchange. The turn state machine enforces exactly one open turn at all times:

- A `user_prompt` arriving when the open turn has members closes the current turn and opens a new one.
- A `turn_end` event arriving when the open turn has members closes it and opens a new one.
- Closing a turn queues derivation work for it.

In the PI connector, one LHC turn spans an entire agent run (all steps). PI's per-step `turn_end` is explicitly not used as an LHC boundary — only `agent_end` closes the LHC turn.

### Derivations

A **derivation** is a compressed or summarized form of source content, produced either deterministically or through LLM inference. Derivations are the core of how LHC reduces context size while preserving information.

There are seven derivation kinds, organized in a dependency hierarchy:

```
Events → Messages
           ├── smoothed_prompt        (inference)  Cleaned user prompts
           └── tool_result_summary    (inference)  Condensed tool outputs
                    ↓
              Turns
           ├── turn_rendering          (deterministic)  Structured turn text with tool-run grouping
           ├── pre_detailed_assembly   (deterministic)  Dialogue-register (prompts + responses only)
           └── detailed_turn_compression (inference)    Compressed turn dialogue
                    ↓
              Chunks
           ├── chunk_summary_detailed  (deterministic)  Concatenated member compressions
           └── chunk_summary_brief     (inference)      Historical memory note
```

Each derivation has a state (`pending` → `ready` | `failed` | `blocked`) and a `source_version` used for optimistic concurrency. When a message is edited or deleted, the full derivation chain is invalidated and re-queued at the next source version.

### Chunks

**Chunks** group consecutive closed turns by accumulated token count. When a turn is placed into a chunk and the chunk's token total crosses a configurable target (~2200 tokens), the chunk closes and its summary derivations are queued. Chunks are the unit of historical context compression.

### The Durable Work Queue

Derivation work is processed through a SQLite-backed work queue with:

- **Claim/lease mechanics** — Items are claimed with a time-limited lease. An expired lease is reclaimable by another process.
- **Epoch fencing** — Every claim increments a `claim_epoch`. Completion writes check `WHERE claim_epoch = ?`, so a stale claimant's write harmlessly misses after a reclaim.
- **Source-version checking** — Completion UPDATEs match `WHERE source_version = ?`. If a mutation cascade bumped the version, the stale completion is discarded.
- **Exponential backoff** — Failed retryable items go back to `queued` with an `eligible_at` pushed out by `min(base × 2^attempts, cap)`.
- **FIFO, no skip-ahead** — Only the oldest live item can be claimed. A backing-off or in-flight head gates everything behind it.

In **background mode**, the scheduler runs a per-thread single-flight drain loop with pending-flag coalescing. Enqueues poke the scheduler; a wake timer handles retry backoff and expired leases. In **manual mode**, the queue is only drained by explicit `work.drain()` calls.

### Smart Compact and Thread Views

A **thread view** is the assembled context window served to the LLM. It has two layers:

1. **Bands** (compacted history) — Stored snapshot of compressed historical content, produced by smart compact.
2. **Tail** (recent content) — Live messages after the compact point, rendered at full fidelity.

**Smart compact** runs a pure selection algorithm over the thread's turns and chunks:

1. **Compact point** — Walk messages newest-first until the token sum fills the `full` band budget. Snap to a turn boundary.
2. **Smooth band** — Banded closed turns, newest-first, using `detailed_turn_compression` content (or fallbacks).
3. **Detailed band** — Closed chunks older than smooth coverage, using `chunk_summary_detailed`.
4. **Brief band** — Remaining older chunks, using `chunk_summary_brief`.

Three built-in view profiles control the budget allocation:

| Profile | Full | Smooth | Detailed | Brief |
|---|---|---|---|---|
| `continuation` | 30% | 30% | 20% | 20% |
| `conversation` | 12% | 48% | 20% | 20% |
| `coding` | 25% | 35% | 20% | 20% |

A **visibility boundary** controls tool-result rendering: results behind the boundary render short, saving tokens while the canonical record retains full content.

### Inference Adapter

LHC never calls an LLM directly. The host provides a `ModelCall` function that LHC's inference adapter wraps with:

- **Prompt templates** — A name-keyed registry of versioned prompt templates (e.g., `smoothing-v1`, `tool-result-v2`). Each template renders input into `{ role, content }[]` messages.
- **Per-kind routing** — Each derivation kind can use a different provider/model/prompt combination via `ModelAssignment` config.
- **Input bounding** — Large tool results are truncated to head+tail before prompt rendering.
- **Failure classification** — Host failures are classified as retryable (`rate_limit`, `timeout`, `network`, `empty_output`) or terminal (`auth`, `invalid_request`).
- **Safe call** — try/catch + timeout race around the host function, so host behavior can never crash a drain.

### Inspect and Diagnostics

The `inspect` domain is a pure read-only consumer of all other domains. It provides:

- **Overview** — Thread identity, event/message/turn/chunk counts, derivation states, view summary.
- **Health** — Derivation state bucketing, failure detail, repair preview, capture gap detection.
- **View** — Stored snapshot contents with serving-cost measurement.

---

## How PI-LHC Works

### Capture Flow

```
PI message_end hook
  → mapMessage (fan-out: thinking → text → tool_call per call)
  → TurnAccumulator tracks open turn
  → capture() → intakeStream.messageEvents()
  → Events, messages, turns written atomically in one SQLite transaction
  → Work items enqueued for derivation
  → Background scheduler drains the queue
```

PI's `agent_end` hook emits the `turn_end` that closes the LHC turn. Capture failures record durable gaps (queryable `runtime_note` events) rather than throwing into PI hooks.

### Context Serving

Context is served by **session seeding**, not PI's context hook:

1. **Launcher startup** — The `pi-lhc` binary resolves the LHC thread, reads `getSessionThreadView()`, and appends the entries to an in-memory PI `SessionManager` before PI starts.
2. **Rehydrate** — The `/lhc-rehydrate` command creates a fresh PI session seeded from the latest LHC thread view.
3. **Compact** — PI's `session_before_compact` is intercepted; LHC runs smart compact and returns the result to PI.

### Compact Bridge

When PI requests compaction, the connector:

1. Flushes pending capture.
2. Checks the serving-context token count is above a 50k floor.
3. Runs `threadView.previewCompact` / `threadView.compact` with LHC's profile.
4. Maps LHC's `firstKeptMessageId` back to a PI session entry id (via live idempotency key parsing or the seed-entry-map).
5. Returns a `CompactionResult` with rendered band text as the summary.

---

## Building and Testing

### Prerequisites

- **Node.js** ≥ 24.17.0, < 25 (uses `node:sqlite` built-in)
- **pnpm** 11.8.0+

### Setup

```bash
pnpm install
```

### Build

```bash
pnpm build           # Build all packages
```

`lhc` compiles TypeScript to `dist/` via `tsc`. `pi-lhc` depends on the built `lhc` output.

### Test

```bash
# Fast tests (no real LLM calls)
pnpm --filter lhc test         # 50 test files, ~440 tests
pnpm --filter pi-lhc test      # 39 test files, ~250 tests

# Integration tests (requires OPENROUTER_API_KEY)
pnpm --filter lhc test:integration

# Everything
pnpm --filter lhc test:all
```

### Verify (lint + typecheck + test)

```bash
pnpm --filter lhc verify       # Format check, Biome lint, typecheck, fast tests
pnpm --filter pi-lhc verify
pnpm --filter lhc verify:all   # Above + integration tests
```

### Format and Lint

```bash
pnpm format          # Auto-fix formatting (Biome)
pnpm lint            # Biome check
```

### Key Test Patterns

- **Deterministic inference callbacks** — Tests use `createDeterministicInferenceCallbacks()` which produces stable `marker(fnv1a-digest:prefix)` text from input, so derivation content is predictable without real LLM calls.
- **Temp thread files** — Tests create temporary SQLite files via `tmp.fileSync()` and clean up after.
- **Golden tests** — Smart compact selection has golden JSON files (`test/goldens/`) pinning exact arrangement output.
- **Real inference tests** — Gated behind `LHC_RUN_INTEGRATION=1` and `OPENROUTER_API_KEY`, these run all seven derivation kinds against a live model (default: `openai/gpt-4o-mini` via OpenRouter).

---

## Project Structure

```
packages/lhc/src/
├── sdk.ts                    initLhc() and the Lhc public surface
├── threads/                  Thread creation, registry, resolution
│   └── internal/
│       ├── create.ts         SQLite schema (15 tables), file creation, migration
│       └── registry.ts       ~/.lhc/registry.sqlite CRUD
├── intake-stream/            Event recording pipeline
│   └── internal/
│       ├── pipeline.ts       Batch transaction: validate → record → project → queue
│       └── validate.ts       Three-layer closed validation (Effect Schema)
├── messages/                 Message projection, derivation, mutation
│   └── internal/
│       ├── handlers.ts       prompt_smoothing + tool_result_summary work handlers
│       ├── cascade.ts        Edit/delete derivation chain invalidation
│       ├── classify-tool-result.ts  Rule-based tool output classification
│       ├── smoothing.ts      Deterministic prompt cleanup (code-fence-aware)
│       └── derive.ts         Synchronous + durable message derivation
├── turns/                    Turn state machine, composition, chunks
│   └── internal/
│       ├── derive.ts         4 work handlers: turn assembly, compression, chunk summaries
│       ├── compose.ts        Rendering composition with tool-run grouping
│       ├── chunks.ts         Chunk placement and close policy
│       └── derivations.ts    Turn/chunk derivation reads and reports
├── thread-view/              View assembly and smart compact
│   └── internal/
│       ├── select.ts         Pure selection walk (the compact algorithm)
│       ├── compact-compute.ts  Compact arrangement computation
│       ├── snapshot.ts       Stored view CRUD (atomic replace)
│       ├── session-view.ts   PI session format builder
│       ├── profiles.ts       Built-in profiles and validation
│       └── render.ts         Band and tail message rendering
├── inspect/                  Read-only diagnostic reports (overview, health, view)
└── shared-tech/              Technical infrastructure
    ├── work-queue/           Durable FIFO queue with claim/epoch/version fencing
    ├── durable-work/         Derivation completion mechanics
    ├── scheduler.ts          Background per-thread drain loop
    ├── inference-adapter.ts  ModelCall → InferenceCallbacks adapter
    ├── prompts/              Versioned prompt templates (7 templates)
    ├── persist.ts            Read/write transaction helpers
    ├── context.ts            AsyncLocalStorage-based per-SDK instance scoping
    ├── logging/              Operational + derivation audit logs
    └── token-counting/       js-tiktoken o200k_base estimator

packages/pi-lhc/src/
├── index.ts                  Extension entry, hook rail, connector factory
├── capture/                  PI event → LHC event conversion
│   ├── map-message.ts        Message fan-out mapping
│   ├── converter.ts          Isolated flush with gap recording
│   ├── idempotency.ts        4-tier stable event key construction
│   ├── turn-accumulator.ts   LHC turn boundary tracking
│   └── runtime-changes.ts    Model/thinking-level change mapping
├── compact/                  Smart compact bridge
│   ├── handler.ts            session_before_compact handler
│   ├── result-mapping.ts     LHC message id → PI entry id mapping
│   ├── seed-entry-map.ts     Cross-session compact continuity
│   └── profile.ts            Compact profile + floor config
├── inference/                PI-backed inference wiring
│   ├── model-call.ts         createModelCall via PI registry + pi-ai
│   ├── assignments.ts        Operator assignment config loading
│   └── startup-validation.ts Model registry reachability probes
├── launcher/                 pi-lhc binary and startup
│   ├── run.ts                Launcher entry point
│   ├── startup.ts            Thread resolve → session seed → PI runtime
│   └── seed-session.ts       LHC thread-view → PI SessionManager
├── lifecycle/                Session state and thread management
│   ├── instance.ts           initInstance / disposeInstance
│   ├── state.ts              Plain-data SessionState
│   ├── thread-resolution.ts  Launch flag → thread resolution
│   ├── picker.ts             --lhc-resume CWD-scoped picker
│   ├── fork.ts               Fork detection and event replay
│   ├── rehydrate.ts          /lhc-rehydrate command
│   └── thread-entry.ts       Durable pi-lhc.thread PI session entry
├── serving/                  Context serving
│   └── context.ts            SessionThreadView → PI SessionManager mapping
└── pi/
    └── types.ts              Local PI type declarations
```

## License

Private — not published.
