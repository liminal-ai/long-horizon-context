# LHC — Long Horizon Context SDK

The core event-sourced context management library. All state is persisted per-thread to SQLite (`node:sqlite`). The SDK has no CLI — the public API is a single `initLhc` function.

## Initialization

```typescript
import { initLhc } from "lhc";

const sdk = initLhc({
  // Exactly one of inferenceCallbacks or inference is required.
  inference: {
    call: myModelCallFunction,       // (input: ModelCallInput) => Promise<ModelCallResult>
    assignments: { /* per-kind overrides */ },
    timeoutMs: 60_000,               // default 60s
    maxInputChars: 200_000,          // default 200k
  },
  mode: "background",               // "background" | "manual"
  // All below are optional with documented defaults:
  clock: () => new Date(),
  retry: { budget: 3, backoffBaseMs: 5000, backoffCapMs: 60000 },
  guards: { /* derivation guards */ },
  toolResult: { smallTierTokens: 1000, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
  lease: { durationMs: 120000 },
  chunkPolicy: { targetProjectedTokens: 2200, maxProjectedTokens: 4400 },
  view: { /* profiles, visibility, compactThreshold */ },
});
```

Config mistakes are programmer errors at construction and **throw**. Operating failures after construction return `OpResult` values.

### Inference Configuration

Exactly one of two paths:

**`inference`** — Provide a `ModelCall` function and optional per-kind assignments. The SDK builds an adapter internally:

```typescript
inference: {
  call: async (input) => {
    // input: { provider, model, messages, thinking? }
    // Return { ok: true, text: "..." } or { ok: false, kind: "rate_limit", message: "..." }
    return { ok: true, text: await myProvider.complete(input) };
  },
  assignments: {
    smoothed_prompt:          { provider: "openai", model: "gpt-4o-mini", prompt: "smoothing-v1" },
    tool_result_summary:      { provider: "openai", model: "gpt-4o-mini", prompt: "tool-result-v2" },
    detailed_turn_compression: { provider: "openai", model: "gpt-4o-mini", prompt: "detailed-turn-compression-v2",
                                 targetMinRatio: 0.35, targetAimRatio: 0.5, targetMaxRatio: 0.65 },
    chunk_summary_brief:      { provider: "openai", model: "gpt-4o-mini", prompt: "chunk-brief-v2",
                                 targetMinRatio: 0.08, targetAimRatio: 0.12, targetMaxRatio: 0.2 },
  },
}
```

Omitted assignment keys use defaults (provider `codex`, model `gpt-5.4-mini`). Unknown keys are rejected. Every `prompt` must name a registered template.

**`inferenceCallbacks`** — Provide the four callbacks directly (used for test doubles and pre-built adapters):

```typescript
inferenceCallbacks: {
  smoothPrompt:        (input) => Promise<InferenceResult>,
  summarizeToolResult: (input) => Promise<InferenceResult>,
  compressDetailedTurn:(input) => Promise<InferenceResult>,
  summarizeChunkBrief: (input) => Promise<InferenceResult>,
}
```

`InferenceResult` is `{ ok: true, text, provenance? }` or `{ ok: false, retryable, reason }`.

For testing, `createDeterministicInferenceCallbacks()` produces stable, input-derived output with no LLM calls.

### Registered Prompt Templates

| Name | Default for | Purpose |
|---|---|---|
| `smoothing-v1` | `smoothed_prompt` | Near-verbatim user prompt cleanup |
| `tool-result-v1` | — | Tool output summary (v1, superseded) |
| `tool-result-v2` | `tool_result_summary` | Tool output summary with classification-guided mode |
| `detailed-turn-compression-v1` | — | Turn dialogue compression (v1, superseded) |
| `detailed-turn-compression-v2` | `detailed_turn_compression` | Turn dialogue compression with target ratios |
| `chunk-brief-v1` | — | Historical memory note (v1, superseded) |
| `chunk-brief-v2` | `chunk_summary_brief` | Historical memory note with worked examples |

---

## The Lhc Object

`initLhc` returns:

```typescript
interface Lhc {
  threads:      ThreadsSurface;
  intakeStream: IntakeStreamSurface;
  messages:     MessagesSurface;
  turns:        TurnsSurface;
  threadView:   ThreadViewSurface;
  inspect:      InspectSurface;
  logging:      LoggingSurface;
  work:         WorkSurface;
  config:       ResolvedSdkConfig;
  scheduler:    Scheduler;
  drainSettled(ref: ThreadRef): Promise<void>;
}
```

Every operation takes a `ThreadRef` — either `{ threadId: string; registryPath?: string }` (resolved through the registry) or `{ filePath: string }` (direct file access).

---

## Domain Surfaces

### `threads` — Thread Creation and Registry

| Operation | Signature | Description |
|---|---|---|
| `newThread` | `(input: NewThreadInput) → OpResult<{ threadId, filePath }>` | Create a thread file + registry row. File-then-row with compensation. |
| `resolve` | `({ threadId, registryPath? }) → OpResult<ThreadInfo>` | Full or partial (prefix) id lookup. Ambiguous prefixes fail as `ambiguous_thread_id`. |
| `listThreads` | `({ cwd?, registryPath? }?) → OpResult<ThreadInfo[]>` | All threads, optionally CWD-filtered. |
| `resolveThreadRef` | `(ref: ThreadRef) → OpResult<{ filePath }>` | The single interpreter: `{ threadId }` → registry lookup, `{ filePath }` → pass-through. |
| `info` | `(ref: ThreadRef) → OpResult<ThreadFileInfo>` | Read the thread file's own identity (threadId, createdAt). |

### `intakeStream` — Event Recording

| Operation | Signature | Description |
|---|---|---|
| `messageEvents` | `(ref, events: MessageEventInput[]) → OpResult<BatchResult>` | Record a batch of events atomically. All-or-nothing: a rejected batch changes nothing. |
| `listEvents` | `(ref) → OpResult<EventRecord[]>` | Read all recorded events in order. |

**Event kinds:** `user_prompt`, `assistant_text`, `assistant_thinking`, `runtime_note`, `model_change`, `thinking_level_change`, `tool_call`, `tool_result`, `turn_end`.

`BatchResult` reports per-event `recorded | skipped` outcomes, turn transitions, queued work items, and the thread position (`lastEventOrder`).

Idempotency: each event carries an `idempotencyKey`. Re-delivering an event with an existing key is a no-op skip. Key-wins-over-content — content differences don't matter once a key is recorded.

### `messages` — Message Projection, Derivation, Mutation

| Operation | Signature | Description |
|---|---|---|
| `list` | `(ref, filter?: MessageListOptions) → OpResult<MessageRecord[]>` | Bounded listing. Options: `from`, `to` (event-order bounds), `limit`, `includeDeleted`. |
| `show` | `(ref, messageId) → OpResult<MessageDetail>` | Single message with derivation report. Deleted messages return flagged, never not-found. |
| `report` | `(ref, opts?) → OpResult<DerivationReportEntry[]>` | Message-owned derivation states joined with live queue detail. |
| `derive` | `(ref, messageIds) → OpResult<MessageDeriveResult[]>` | Synchronous derivation. Requires an initialized SDK inference seam. |
| `edit` | `(ref, { messageId, content }) → OpResult<MutationResult>` | Edit content in a closed-turn message. Cascades derivation invalidation. |
| `remove` | `(ref, { messageId }) → OpResult<MutationResult>` | Delete via tombstone. Refuses turn-initiating prompts. Cascades upward. |

`MutationResult` reports `changed` (ids), `cleared` (derivations reset to pending), `dropped` (derivation rows deleted), `queued` (replacement work), `superseded` (old queued items deleted).

### `turns` — Turn State Machine, Chunks, Turn-Owned Derivations

| Operation | Signature | Description |
|---|---|---|
| `listTurns` | `(ref) → OpResult<TurnRecord[]>` | All turns with membership and chunk placement. |
| `listChunks` | `(ref) → OpResult<ChunkRecord[]>` | All chunks with membership. |
| `report` | `(ref, opts?) → OpResult<DerivationReportEntry[]>` | Turn- and chunk-owned derivation states. |
| `deriveTurn` | `(ref, turnId) → OpResult<TurnDeriveResult>` | Synchronous: assembly + compression for one turn. |
| `deriveDetailedChunk` | `(ref, chunkId) → OpResult<ChunkDeriveResult>` | Synchronous chunk_summary_detailed. |
| `deriveBriefChunk` | `(ref, chunkId) → OpResult<ChunkDeriveResult>` | Synchronous chunk_summary_brief. |

### `threadView` — Model Context and Smart Compact

| Operation | Signature | Description |
|---|---|---|
| `getLlmRequestContext` | `(ref) → OpResult<LlmRequestContext>` | Assembled context for LLM consumption (bands + tail as `{ role, content }[]` messages). |
| `getSessionThreadView` | `(ref) → OpResult<SessionThreadView>` | PI-session-native format (user/assistant/toolResult entries). |
| `status` | `(ref) → OpResult<ViewStatus>` | Tail tokens, compact recommendation, derivation counts, visibility zone. |
| `describe` | `(ref) → OpResult<StoredView \| null>` | Stored snapshot read-only. `null` = never compacted. |
| `previewCompact` | `(ref, opts) → OpResult<PreviewCompactOutcome>` | Read-only compact preflight. |
| `compact` | `(ref, opts) → OpResult<CompactReceipt>` | Run smart compact: select, render bands, atomically replace the stored snapshot. |
| `materialize` | `(ref, { path, format? }) → OpResult<{ writtenPath }>` | Write a PI session JSONL file from the assembled view. |

### `inspect` — Diagnostic Reports (read-only)

| Operation | Signature | Description |
|---|---|---|
| `overview` | `(ref) → OpResult<InspectOverview>` | Thread identity, event/message/turn/chunk counts, derivation states, view summary. |
| `health` | `(ref) → OpResult<HealthReport>` | Derivation state bucketing, failure detail, repair preview, capture gap detection. |
| `view` | `(ref) → OpResult<ViewContentsReport>` | Stored snapshot contents with serving-cost measurement. |

### `logging` — Operational and Derivation Logs

| Operation | Signature | Description |
|---|---|---|
| `write` | `(ref, entry: LogEntry) → OpResult<void>` | Write a log entry. Fail-soft. |
| `query` | `(ref, query: LogQuery) → OpResult<StoredLogEntry[]>` | Query by level, derivationType, subjectId, reason. |
| `queryDerivationLog` | `(ref, query) → OpResult<StoredDerivationLogEntry[]>` | Derivation execution history (inference_succeeded, inference_failed, fallback_applied, etc.). |

### `work` — Queue Operations

| Operation | Signature | Description |
|---|---|---|
| `drain` | `(ref, opts?) → OpResult<DrainReport>` | Process queued work items. `maxItems` caps the count. |

---

## Derivation Pipeline

### Overview

Every recorded event becomes a message. Certain message kinds queue derivation work. Derivations produce compressed or summarized content at progressively higher levels of abstraction.

### The Seven Derivation Types

#### Message-level (owned by `messages`)

| Type | Trigger | Method | Input | Output |
|---|---|---|---|---|
| `smoothed_prompt` | `user_prompt` recorded | Inference | Raw user text (cleaned) | Near-verbatim cleanup: typo fixes, whitespace normalization, profanity softening |
| `tool_result_summary` | `tool_result` recorded | Inference (currently fallback-only) | Tool output + paired call + classification | Condensed tool result with outcome facts |

**Smoothed prompt guards:**
- Prompts > 700 tokens (default) skip inference and use the deterministic `cleanPrompt` floor.
- Inference output < 15% of input tokens is discarded as suspicious (the cleaned floor is used instead).

**Tool result classification:** Every tool result is classified before summarization with:
- `operationClass`: read, mutation_write, mutation_edit, command, search_or_listing, verification, vcs_inspection, etc.
- `responseShape`: structured_receipt, simple_failure, search_result, test_result, diff_output, large_log, etc.
- `promptMode`: receipt, failure, search_summary, test_summary, etc.
- Parsed `facts`: exitCode, targetPath, matchCount, testSummary, searchMatches, etc.

#### Turn-level (owned by `turns`)

| Type | Trigger | Method | Input | Output |
|---|---|---|---|---|
| `turn_rendering` | Turn closed | Deterministic | Member messages + their derivations | Structured part-by-part text with tool-run grouping and receipts |
| `pre_detailed_assembly` | Turn closed | Deterministic | Member messages + their derivations | Dialogue-register: user prompts (smoothed) + assistant text only |
| `detailed_turn_compression` | `turn_rendering` + `pre_detailed_assembly` complete | Inference | `pre_detailed_assembly` text | Compressed dialogue at 35–65% of input (aim 50%) |

**Tiny turn guard:** Turns < 80 tokens (default) skip compression inference and use `pre_detailed_assembly` verbatim.

**Exhaustion fallback:** After exhausting retry budget on compression, `pre_detailed_assembly` content is used as the floor. The derivation is marked `ready` with `fallbackUsed: true` metadata.

#### Chunk-level (owned by `turns`)

| Type | Trigger | Method | Input | Output |
|---|---|---|---|---|
| `chunk_summary_detailed` | Chunk closed | Deterministic | Member turns' `detailed_turn_compression` content + tool-run receipts | Concatenated member sections with turn headers |
| `chunk_summary_brief` | Chunk closed | Inference | `chunk_summary_detailed` text | Historical memory note at 8–20% of input (aim 12%) |

**Brief dependency protection:** If `chunk_summary_detailed` is not ready when the brief handler runs, the handler defers: it enqueues the detailed work first, then re-enqueues itself.

### Derivation States

| State | Meaning |
|---|---|
| `pending` | Queued for processing. Created by `enqueue`, the only place derivation rows are created. |
| `ready` | Content available. Set by version-checked completion UPDATE. |
| `failed` | Terminal failure after retry exhaustion. Carries `attempts` and `lastError` in metadata. |
| `blocked` | Source damage (corrupt/missing source record). Terminal, never retried. |

### Derivation Data Flow

```
                           ┌─────────────────────┐
                           │   intakeStream       │
                           │   .messageEvents()   │
                           └─────────┬───────────┘
                                     │ atomic batch transaction
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              record event    messages.create    turns.create
                              (project + queue)  (state machine)
                                     │                │
                    ┌────────────────┘                │
                    ▼                                 ▼ (on turn close)
          queue prompt_smoothing              queue turn_derivation
          queue tool_result_summary                   │
                    │                                 │
                    ▼                                 ▼
           ┌───────────────┐              ┌──────────────────────┐
           │  smoothPrompt │              │  turn_rendering +    │
           │  or           │              │  pre_detailed_assembly│
           │  summarize    │              │  (deterministic)     │
           │  ToolResult   │              └──────────┬───────────┘
           └───────────────┘                         │ onApplied:
                                                     ├─ place turn in chunk
                                                     ├─ queue detailed_turn_compression
                                                     └─ if chunk closed: queue chunk summaries
                                                              │
                                          ┌──────────────────┘
                                          ▼
                                ┌───────────────────┐
                                │ compressDetailed   │
                                │ Turn (inference)   │
                                └───────────────────┘
                                          │
                                          ▼
                                ┌───────────────────┐
                                │ chunk_summary_     │
                                │ detailed (determ.) │
                                └────────┬──────────┘
                                         │
                                         ▼
                                ┌───────────────────┐
                                │ chunk_summary_     │
                                │ brief (inference)  │
                                └───────────────────┘
```

### Mutation Cascade

When a message is edited or deleted, the cascade walks upward:

```
edited message → its turn → its chunk (if placed)
```

For each subject in the chain:
- **Edit**: All derivation rows reset to `pending` at `sourceVersion + 1`. Replacement work enqueued. Old queued items superseded.
- **Delete**: The deleted message's own derivations are dropped (rows deleted). Upward subjects (turn, chunk) are cleared and re-queued for minus-one composition. The paired tool counterpart (call↔result) is also cleared.

### Chunks

Turns are grouped into chunks by accumulated projected token count. Chunk policy defaults:

| Setting | Default | Meaning |
|---|---|---|
| `targetProjectedTokens` | 2200 | Close the open chunk and start a new one when accumulated + incoming ≥ this |
| `maxProjectedTokens` | 4400 | A single turn ≥ this closes its chunk immediately |

---

## Work Queue and Host Modes

### Background Mode

The scheduler runs a per-thread single-flight drain loop:
- **Poke**: Post-commit nudge from `enqueue`. If a drain is running, sets `pending = true` (at most one further pass). If not, starts the loop.
- **Drain loop**: Claim → dispatch handler → complete/retry/terminal, repeated until the queue is empty, in-flight, or waiting.
- **Wake timer**: Armed when a drain stops on retry backoff (`eligible_at`) or an unexpired claim (`claim_expires_at`). Fires once to re-enter the drain.
- **First-touch catch-up**: On the first `openThreadDatabase` for a thread this process lifetime, schedule a drain if leftover live work exists.
- **`drainSettled(ref)`**: Returns a Promise that resolves when no drain is running, pending, or wake-timer-armed for the thread.

### Manual Mode

Poke and touch are no-ops. Work is only processed via explicit `sdk.work.drain(ref, { maxItems? })` calls. `drainSettled` resolves immediately.

### Queue Mechanics

- **Deterministic IDs**: `w-<sourceId>-<kind>-v<sourceVersion>`. Same source + kind + version = same ID (dedup). Post-mutation replacements at a bumped version never collide.
- **FIFO, head-first**: Only the oldest live row is considered for claiming. A backing-off or in-flight head gates everything behind it.
- **Claim/epoch fencing**: `claim_epoch` increments on every claim. Completion writes check `WHERE claim_epoch = ?`. A stale claimant (whose lease expired and was reclaimed) harmlessly misses.
- **Source-version check**: Completion UPDATEs match `WHERE source_version = ?`. Stale completions (source was mutated since enqueue) are discarded.
- **Retry**: Exponential backoff: `min(baseMs × 2^attempts, capMs)`. At budget or non-retryable → terminal failure.

### Failure Classification

| ModelCall failure kind | Retryable | Meaning |
|---|---|---|
| `rate_limit` | ✓ | Provider rate-limited the request |
| `timeout` | ✓ | Adapter-owned timeout race |
| `network` | ✓ | Connection/DNS failure |
| `empty_output` | ✓ | Model returned empty/whitespace-only text |
| `other` | ✓ | Unclassified exception from the host function |
| `auth` | ✗ | Authentication failure |
| `invalid_request` | ✗ | Bad request (unknown model, malformed input) |

---

## Smart Compact and View Profiles

### How Compact Works

1. **Compact point**: Walk messages newest-first, summing tokens until the `full` budget is reached. Snap to a turn boundary (never split a turn between tail and bands).
2. **Smooth band**: Banded closed turns newest-first, filled against the smooth budget. Uses `detailed_turn_compression` content (degrades through fallback ladders).
3. **Detailed band**: Closed chunks entirely older than smooth, newest-first against the detailed budget. Uses `chunk_summary_detailed`.
4. **Brief band**: Remaining chunks against the brief budget. Uses `chunk_summary_brief`.
5. **Coverage check**: Any banded turn not represented by selected entries or chunk membership gets a coverage entry in the detailed band.
6. **Atomic snapshot replace**: Band text rendered, stored in `thread_view` + `thread_view_band` rows, visibility boundary reset to compact point — all in one `BEGIN IMMEDIATE` transaction.

### Selection Execution Plan

Selection reads turn/message metadata aggregates and hydrates only what the walk visits: raw message blocks for the tail and for the specific candidates that need an excerpt, and a chunk's stored-member fallback material only when its summary derivation is unusable. A historical candidate the walk passes over is never read.

The prior eager plan — which loaded every live message with its blocks, and resolved detailed and brief fallback material for every closed chunk, before selecting — is still selectable:

| Variable | Accepted value | Effect |
|---|---|---|
| `LHC_COMPACT_ALGORITHM` | `legacy` | Runs the eager plan. Any other value, and unset, run the bounded plan. |

Both plans run the same band walk and produce the same arrangement. The legacy plan announces itself once per process as a Node `LhcCompactAlgorithmWarning` on stderr; it exists as an escape hatch, not a supported mode.

### Built-in Profiles

| Profile | Full | Smooth | Detailed | Brief | Lower Bound |
|---|---|---|---|---|---|
| `continuation` | 30% | 30% | 20% | 20% | 120,000 |
| `conversation` | 12% | 48% | 20% | 20% | 120,000 |
| `coding` | 25% | 35% | 20% | 20% | 120,000 |

Percentages must sum to 100. Custom profiles can override built-ins by name or define new ones.

### View Config

```typescript
view: {
  profiles: [
    { name: "continuation", lowerBound: 150000 },           // override built-in
    { name: "custom", lowerBound: 100000,                    // new profile (must be complete)
      percentages: { full: 40, smooth: 30, detailed: 15, brief: 15 } },
  ],
  visibility: { maxTokens: 64000, targetTokens: 32000 },    // defaults shown
  compactThreshold: 160000,                                  // default: status recommends compact above this
}
```

### View Serving

`getLlmRequestContext` assembles the view for LLM consumption:
1. Read the stored snapshot (bands).
2. Read live messages after the compact point (tail), deleted-filtered.
3. Tool results at-or-behind the visibility boundary render short.
4. Return as `{ role: "user" | "assistant", content: [{ type: "text", text }] }[]` messages.

`getSessionThreadView` produces PI-session-native format: user/assistant (with thinking/text/toolCall parts)/toolResult entries, plus model_change and thinking_level_change entries.

A never-compacted thread serves its entire message history as tail from event 1. No special case — the same code path with compact point at 0.

---

## Error Contract

Every operation returns `OpResult<T>`:

```typescript
type OpResult<T> = { ok: true; value: T } | { ok: false; error: ErrorResult };

interface ErrorResult {
  errorClass: ErrorClass;
  code: ErrorCode;
  reason: string;
  eventIndex?: number;  // batch validation failures only
}
```

### Error Classes

| Class | Meaning | Caller action |
|---|---|---|
| `caller_error` | The caller did something wrong (bad input, missing thread, invalid config). | Fix the call. |
| `state_corruption` | The durable state is internally inconsistent (multiple open turns, missing references). | Investigate the thread file. |
| `system_error` | Infrastructure failure (SQLite, filesystem, exhausted retries). | Retry or check the environment. |

### Error Codes

| Code | Class | Trigger |
|---|---|---|
| `thread_not_found` | caller | Thread id not in registry, or file doesn't exist |
| `ambiguous_thread_id` | caller | Partial id matches multiple threads |
| `invalid_thread_ref` | caller | Empty/blank file path |
| `path_exists` | caller | File already exists at the new-thread path |
| `invalid_event` | caller | Event fails validation (missing fields, unknown kind, server-generated fields present) |
| `empty_batch` | caller | Empty events array |
| `message_not_found` | caller | Message doesn't exist or is deleted |
| `turn_not_found` | caller | Turn doesn't exist |
| `turn_open` | caller | Mutation against an open-turn message |
| `message_initiates_turn` | caller | Delete refused: message is the turn's initiating prompt |
| `inference_unavailable` | caller | Synchronous derive called outside an SDK inference seam |
| `derivation_work_in_flight` | caller | Synchronous derive refused: equivalent queued work is live |
| `unknown_profile` | caller | Named compact profile not configured |
| `invalid_view_config` | caller | Band sum ≠ 100, or other profile violation |
| `compact_stopped` | caller | Caller aborted compact before snapshot write |
| `invalid_bounds` | caller | Bad list bounds option |
| `unknown_format` | caller | Materialize format not `"pi-session"` |
| `turn_state_corrupt` | corruption | Multiple open turns or other turn invariant violation |
| `source_damaged` | corruption | Handler found corrupt source record; derivation blocked |
| `unknown_work_kind` | corruption | Unregistered work kind at dispatch |
| `derivation_completion_mismatch` | corruption | Handler writes don't match queued derivation targets |
| `storage_failure` | system | SQLite or filesystem error |
| `provider_failure` | system | Inference retry budget exhausted |
| `derivation_retry_scheduled` | system | Turn-owned synchronous derive failed retryably; requeued |

Config mistakes at `initLhc` construction time **throw** `TypeError` (not returned as `OpResult`). These are programmer errors, not operational failures.

---

## Token Counting

All token estimates use `js-tiktoken` with the `o200k_base` tokenizer (GPT-4o encoding). The estimator ID `"js-tiktoken:o200k_base"` is stored in every thread file's metadata so the estimate basis is always known.

Exported: `estimateTokens(text: string): number` and `TOKEN_ESTIMATOR_ID`.
