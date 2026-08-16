# pi-lhc — PI ↔ LHC Connector Extension

A PI extension that bridges the [PI](https://github.com/earendil-works/pi) coding agent with the LHC context management SDK. It captures every PI session event into a durable LHC thread, intercepts PI's compaction to run LHC smart compact, and seeds PI sessions from LHC thread views so agents start with full long-horizon context.

The connector holds only plain data (`SessionState`) and a live `LhcInstance` between hooks — never a PI `ctx` or session object, which PI replaces on new/resume/fork.

## Current status (2026-07-06)

Stable daily driver — this is the harness LHC is developed inside:

- **Capture, serving, and compact bridge** all in production use. Smart compact replaces PI's native compaction via `session_before_compact`.
- **Resume fidelity verified byte-exact**: a resumed session's rendered context matched the live session character-for-character on a ~150k-token real session (77 messages, 35 tool calls). Rendered identifiers were stripped from served text to make this hold.
- **Runs on vendored stock PI** (`vendor/pi` submodule, currently v0.84.x): pure upstream pin — no local patches (the thinking-signature fix is upstream via #6457). See the root README's "Vendored PI" section.
- **Commands**: `/lhc-rehydrate`, `/lhc-tool-prune [targetTokens]`, `/lhc-export-threadview`, `/lhc-export-pi-session`.

Known open items:

- **Token accounting understates real context for some payloads**: image payloads are still represented cheaply in the record. Thinking signatures are now captured and counted when present (fable/Anthropic resume path).
- **Tool-result summaries are truncation-only** (`FORCE_TOOL_RESULT_SUMMARY_FALLBACK = true`); inference-backed summaries are wired but gated off.

Recently closed:

- **Thinking-signature capture**: PI `thinkingSignature` is stored opaquely on `assistant_thinking.payload.signature` and round-tripped on session-view resume as `thinkingSignature`. Empty unsigned thinking husks are skipped at serve time (`bu9`).

## Launcher

The `pi-lhc` binary provides launcher-owned startup: it resolves the LHC thread and seeds the PI session from the thread view **before** PI creates its session. This means the agent starts with full context history from the first message.

**Home:** all host state lives under `~/.pi-lhc` (override `PI_LHC_HOME`) — `registry.sqlite`, `threads/`, and `pi/agent/` (PI's full config dir via `PI_CODING_AGENT_DIR`; a pre-set non-empty value of that env var takes precedence over the home). Plain `pi` keeps a separate `~/.pi`. Fresh install: [`.setup/pi-lhc-standalone.md`](../../.setup/pi-lhc-standalone.md). Existing `~/.lhc` / `~/.pi/agent` state: `scripts/migrate-to-pi-lhc.mjs`.

```
pi-lhc [LHC flags] [PI runtime flags] [--print message]
```

### LHC Thread Flags

| Flag | Behavior |
|---|---|
| (none) | Create a new thread in `~/.pi-lhc/threads/` (override `PI_LHC_HOME`), registered under the current working directory. |
| `--lhc-thread <id>` | Attach to an existing thread by full or partial id. Ambiguous prefixes fail. |
| `--lhc-resume` | CWD-scoped picker: lists threads registered under this directory with title and creation time. One candidate auto-selects; multiple candidates present an interactive picker. |
| `--lhc-continue` | Attach to the most recently created thread (any CWD). |
| `--lhc-band-percentages <f,s,d,b>` | Set this session's full/smooth/detailed/brief compact allocation. Default: `25,25,25,25`. Values must sum to 100. |
| `--lhc-help` | Show launcher help and exit. |

The three thread-selection flags are mutually exclusive. Setting more than one produces `conflicting_lhc_launch_flags`. Band allocation can also be supplied as `PI_LHC_BAND_PERCENTAGES`; the session flag takes precedence.

### Blocked PI Session Flags

The launcher owns thread resolution, so PI's own session management flags are blocked:

`--session`, `--session-id`, `--session-dir`, `--continue` / `-c`, `--resume` / `-r`, `--fork`

### Supported PI Flags

All PI runtime/config flags pass through: `--provider`, `--model`, `--api-key`, `--thinking`, `--tools` / `-t`, `--extension` / `-e`, `--system-prompt`, `--append-system-prompt`, `--verbose`, `--offline`, `--print` / `-p`, `--mode json`, `--list-models`, `--name`, `--skill`, `--prompt-template`, `--theme`, and their `--no-*` counterparts.

### App Modes

| Mode | Behavior |
|---|---|
| Interactive (default, TTY) | Full interactive PI session with LHC context. Thread id printed to stderr on exit. |
| `--print <message>` / `-p <message>` | Single-shot: thread id to stdout, then agent response text. |
| `--mode json <message>` | Single-shot: JSON event stream. Thread id printed to stderr on exit. |

### Launcher Startup Sequence

1. Parse argv → separate LHC flags from PI flags.
2. Resolve LHC thread (create / resolve / pick).
3. Init a temporary LHC instance.
4. Read `threadView.getSessionThreadView(threadRef)`.
5. Create an in-memory PI `SessionManager`.
6. Append each LHC view entry as a PI session message (user, assistant, toolResult, model_change, thinking_level_change).
7. Write a `pi-lhc.seed-entry-map` custom entry mapping LHC message ids to the PI entry ids just created (used later for compact's firstKeptEntryId mapping).
8. Write a `pi-lhc.thread` custom entry recording the thread id.
9. Dispose the temporary instance.
10. Hand the seeded `SessionManager` + thread ref to PI's `createAgentSessionRuntime`.
11. Set `LauncherOwnedStartup` (one-shot handoff consumed by the connector on `session_start`).

---

## Extension Entry and Hook Rail

PI calls `activate(pi)`, which creates a connector and registers:
- 9 Epic 1 hooks (capture and lifecycle)
- 2 compact hooks
- 4 commands (`/lhc-rehydrate`, `/lhc-tool-prune`, `/lhc-export-threadview`, `/lhc-export-pi-session`)
- 4 extension flags (`--lhc-thread`, `--lhc-resume`, `--lhc-continue`, `--lhc-band-percentages`)

### Registered Hooks

| Hook | Handler | Returns |
|---|---|---|
| `session_start` | Resolve thread, init SDK instance, set up capture session, run startup validation | void |
| `message_end` | Queue the PI message for deferred capture (PI entry id not yet available) | void |
| `turn_end` | No-op. PI's per-step turn_end is explicitly ignored as an LHC boundary. | void |
| `agent_end` | Flush pending messages, emit `turn_end` to close the LHC turn | void |
| `agent_settled` | Evaluate the per-model auto-compact trigger — after PI's own retry/compaction machinery has finished | void |
| `model_select` | Flush pending, capture a `model_change` event | void |
| `thinking_level_select` | Flush pending, capture a `thinking_level_change` event | void |
| `session_before_fork` | Flush pending, record the fork point (source thread + entry id) for the next `session_start` | void |
| `session_before_switch` | Flush pending, dispose instance (await drain settled) | void |
| `session_shutdown` | Flush pending, dispose instance (skip settle on headless quit) | void |
| `session_before_compact` | Run LHC smart compact preflight chain, return compaction result or cancel | `SessionBeforeCompactResult` |
| `session_compact` | Clear compact diagnostics buffer; arm a one-settle skip of the auto-compact trigger (post-compact usage can be stale) | void |

Every Epic 1 hook is wrapped in a `guard` that catches all exceptions and converts them to a plain-data diagnostic. **No throw ever reaches PI.**

### Capture Flow

PI `message_end` → queue as pending → next hook flushes:

1. **Deferred entry id resolution.** PI appends the `SessionEntry` *after* `message_end` handlers return. The connector queues the message and flushes it on the next hook call, when `ctx.sessionManager.getEntries()` contains the persisted entry id.

2. **Entry id discovery.** `findPersistedEntryId` diffs the current entries against a snapshot taken at queue time. It finds the new entry whose deep-equal message matches the queued one, claims its id (so two same-content messages don't collide), and uses it as the idempotency key's Tier 1 source.

3. **Message mapping.** `mapMessage` fans out the PI `AgentMessage` into ordered LHC events:
   - User: `user_prompt` (text) + `runtime_note` (unsupported parts like images/fileRefs)
   - Assistant: `assistant_thinking` → `assistant_text` → `tool_call` (per call), in PI's confirmed part order. Aborted messages get a trailing `runtime_note`.
   - Tool result: `tool_result` correlated by `toolCallId`, carrying `isError`.
   - Empty messages: `runtime_note` ("message omitted: no mappable content parts").
   - Nothing is silently dropped.

4. **Turn tracking.** The `TurnAccumulator` notes when a `user_prompt` opens a turn. At `agent_end`, it emits exactly one `turn_end` to close the LHC turn. PI's per-step `turn_end` / `turnIndex` is never used as an LHC boundary — one LHC turn spans the entire agent run.

5. **Durable capture.** `capture(events, instance)` flushes through `intakeStream.messageEvents`. On `invalid_event` (malformed batch on a writable thread), a durable gap is recorded as a `runtime_note` with a fingerprinted idempotency key. On store unavailable, the failure is surfaced as an in-memory health diagnostic.

### Idempotency Key Construction

4-tier precedence for stable, crash-replay-safe keys:

| Tier | Source | When used |
|---|---|---|
| 1 | PI session entry id | Normal finalized messages (most common) |
| 2 | `toolCallId` | Tool calls/results (stable across re-delivery) |
| 3 | Provider `responseId` | Per-assistant-response discriminator |
| 4 | Content SHA-256 fingerprint | Last resort (no ids available) |

Every tier is disambiguated by `blockIndex` (fan-out position) and `kind` (event type), so multiple events from one PI message produce distinct keys.

---

## Compact Bridging

### Preflight Chain

When PI fires `session_before_compact`, the handler runs 8 sequential checks:

| Step | Check | Cancel code on failure |
|---|---|---|
| 1 | `state` and `instance` are non-null | `no_thread` |
| 2 | Flush all pending capture | — |
| 3 | `state.health.lastCaptureFailure` is clear | `capture_incomplete` |
| 4 | `getLlmRequestContext` succeeds and serving tokens ≥ 50k floor | `no_op` or `compact_error` |
| 5 | `previewCompact` succeeds (`wouldProduceBands` is informational only — an explicit compact always proceeds) | `compact_error` |
| 6 | `firstKeptMessageId` is present, **or** compactPoint > 0 with a true empty mappable tail | `mapping_failed` |
| 7 | Present firstKept maps via live/seed tiers. Empty mappable tail uses host sentinel `pi-lhc:summary-only` (Pi keeps summary only) | `mapping_failed` |
| 8 | `compact` succeeds and `renderedBands` is present | `compact_error` or `invalid_compact_result` |

Any failure at any step returns `{ cancel: true }` to PI. The cancel is logged to LHC's log table, buffered in `compactDiagnostics`, and notified via `ctx.ui.notify`.

### First-Kept Entry Mapping

PI's compaction protocol requires a `firstKeptEntryId` — the PI session entry that begins the kept (non-summarized) content. LHC's compact produces a `firstKeptMessageId` (an LHC message id like `m42`). The bridge resolves this in two tiers:

1. **Live tier.** Find the message's source in the `SessionThreadView`, parse its idempotency key to extract the PI entry id (Tier 1 key → decode the `entry:` segment), verify the id exists in PI's compact branch entries.

2. **Seed tier.** Check the `pi-lhc.seed-entry-map` custom entry (written when the session was seeded from an LHC view) for a direct `lhcMessageId → piEntryId` row. Verify the mapped id exists in PI's compact branch entries.

If neither tier resolves, compact cancels with `mapping_failed`.

A `compact_continuation_marker` is PI-mappable: it can be `firstKeptMessageId` and uses the same live/seed map. A true empty mappable tail after selector eviction (`firstKeptMessageId === null` and `compactPoint > 0`) is host-specific: the handler returns the band summary with `firstKeptEntryId = "pi-lhc:summary-only"`. That id is not on the Pi branch, so Pi's `buildContextEntries` keeps the compaction summary and no pre-compaction raw entries. Do not reuse Pi's `preparation.firstKeptEntryId` — that would retain the evicted oversized turn.

### Compact Profile

```
lowerBound: 120,000 tokens
full: 25%, smooth: 35%, detailed: 20%, brief: 20%
Compact floor: 50,000 serving-context tokens
```

The floor prevents compacting tiny threads where there's nothing meaningful to reclaim. The profile is passed as explicit `ViewCompactParams` to both `previewCompact` and `compact`.

### Result Assembly

On success, the connector assembles PI's `CompactionResult`:
- `summary`: Rendered band texts joined with `[context · brief/detailed/smooth]` headers.
- `firstKeptEntryId`: The resolved PI entry id.
- `tokensBefore`: From PI's preparation.
- `details`: The full LHC `CompactReceipt`.

After a successful `session_compact`, the compact diagnostics buffer is cleared.

---

## Commands

### `/lhc-rehydrate`

Replace the live PI session with a fresh in-memory session hydrated from the latest LHC thread view. Used when the PI session has grown stale or after manual changes to the LHC thread.

Sequence:
1. Wait for the agent to be idle (`ctx.waitForIdle`).
2. Flush all pending capture.
3. Capture current model and thinking-level preferences.
4. Call `ctx.newSession` with a `setup` callback that:
   - Creates a temporary LHC instance.
   - Reads `getSessionThreadView`.
   - Appends all entries to the new PI `SessionManager`.
   - Writes a `pi-lhc.thread` entry and `pi-lhc.seed-entry-map`.
   - Disposes the temporary instance.
5. On the new session's `session_start`, restore model/thinking-level preferences.

If the setup throws or the session is cancelled, pending rehydrate state is cleaned up. The temporary instance is always disposed in `finally`.

### `/lhc-tool-prune [targetTokens]`

Advance the visibility boundary over older tool results: walks live tool results newest-first from the current boundary, keeps full results until the target budget (default 32k tokens), then moves the boundary so everything older serves truncated. One write transaction; prints a receipt with before/after boundary and zone tokens. Never moves behind the compact point; reports honestly when already under target (`no-op`).

### `/lhc-export-threadview`

Write the canonical LHC thread view to a timestamped text file in the working directory. Deterministic serialization — used with `/lhc-export-pi-session` to diff LHC's rendering against live PI state.

### `/lhc-export-pi-session`

Write the live PI session's messages to a timestamped text file using the same serializer. Byte-identical output across a resume is the fidelity contract; these two commands are the verification harness for it.

---

## Inference Bridging

### Model Call

`createModelCall(ctx)` returns the `ModelCall` function LHC's inference adapter consumes:

1. **Registry resolution.** `ctx.modelRegistry.find(provider, model)` resolves the provider/model strings to a PI `ModelHandle`. Unknown models → `invalid_request` (terminal).

2. **Auth check.** `ctx.modelRegistry.hasConfiguredAuth(handle)` verifies credentials exist. No auth → `auth` (terminal).

3. **Request auth.** `ctx.modelRegistry.getApiKeyAndHeaders(handle)` resolves per-request credentials (API key, headers, env).

4. **Completion.** `@earendil-works/pi-ai.complete(handle, { messages }, options)` runs the LLM call. The pi-ai package is loaded dynamically at runtime (`new Function("specifier", "return import(specifier)")`) so pi-lhc has no build-time dependency on it. If pi-ai is not available, the call throws → classified as `other` (retryable).

5. **Failure classification.** Thrown errors are pattern-matched against code/type/message strings:
   - auth/unauthorized/401 → `auth` (terminal)
   - invalid/400/bad → `invalid_request` (terminal)
   - rate/429 → `rate_limit` (retryable)
   - timeout/408 → `timeout` (retryable)
   - network/connection/econnrefused → `network` (retryable)
   - everything else → `other` (retryable)

6. **Text extraction.** The response's `content[type="text"]` parts are joined. Empty text is accepted here; `empty_output` classification is LHC's adapter's job.

### Default Assignments

All four inference derivation kinds default to `openai-codex/gpt-5.4-mini` with `thinking: "none"`:

| Kind | Default prompt |
|---|---|
| `smoothed_prompt` | `smoothing-v1` |
| `tool_result_summary` | `tool-result-v2` |
| `detailed_turn_compression` | `detailed-turn-compression-v1` |
| `chunk_summary_brief` | `chunk-brief-v1` |

Operator config can override provider, model, and prompt per kind. Overrides are validated: incomplete assignments, placeholder values (`your-provider`), and unknown prompt names all fail loud at load.

### Startup Validation

On `session_start`, after thread resolution, every assignment is probed against PI's model registry:
- Is the provider/model in the registry? → `unknown_model` if not.
- Is auth configured? → `auth_not_configured` if not.

Unreachable lanes are reported via `ctx.ui.notify` (when available) and persisted to `state.health.startupValidation`. **Validation failures do not stop capture** — the affected derivations will fail retryably when the drain runs, surfaced through `inspect.health`.

---

## Fork Handling

### Detection

Fork detection has two tiers:

1. **Hook-based.** PI fires `session_before_fork` with the fork entry id. The connector stores `pendingFork = { sourceThreadRef, forkEntryId }`. On the next `session_start`, the pending fork drives the create-and-seed path.

2. **Session-tree fallback.** If `session_before_fork` didn't fire but `event.previousSessionFile` is present, `detectForkFromSessionTree` reads the previous session's JSONL file, builds a set of its entry ids, and looks for shared entry ids or parent-link relationships in the current session. If found, the fork point is inferred.

### Seeding

`seedFork(source, target, forkEntryId, instance)`:

1. Read all events from the source thread.
2. Find events whose idempotency keys reference the fork entry id (parsed via `parseEventKeySource`, not substring search).
3. Use the max event order among fork-point events as the initial cutoff.
4. Include the first `turn_end` after that cutoff (connector-generated turn_end events don't carry entry ids in their keys).
5. Replay all events up to the cutoff through `intakeStream.messageEvents` on the target thread.
6. Same idempotency keys → target's read-back matches source's through the fork point.

The source thread receives **no writes**. Derivations are not copied — they re-queue on the target thread through normal intake processing.

If seeding fails, the instance is disposed, state is cleared, and the diagnostic is recorded. No half-seeded thread is left operational.

---

## Session Lifecycle Summary

### Thread Resolution Priority (on `session_start`)

| Priority | Source | Behavior |
|---|---|---|
| 1 | `pendingFork` from `session_before_fork` | Create new thread, seed from source |
| 2 | Session-tree fork detection | Create new thread, seed from source |
| 3 | Launcher-owned startup (`setLauncherOwnedStartup`) | Use pre-resolved thread |
| 4 | Pre-attached `pi-lhc.thread` entry in PI session | Re-resolve that threadId |
| 5 | Normal launch flags (`--lhc-thread`/`--lhc-resume`/`--lhc-continue`/none) | Resolve or create |
| 5 (reload) | Durable threadId from PI session entries | Re-resolve exact prior id |

### Reload Behavior

On PI `/reload`, the connector's closure is reconstructed from scratch (no module-level handoff state). Thread reattachment works because:
1. PI durably stores the `pi-lhc.thread` entry in the session file.
2. The connector reads this entry on `session_start(reason: "reload")` and resolves the threadId through the LHC registry.
3. A new `LhcInstance` is constructed against the same thread.
4. Capture resumes. The TurnAccumulator starts fresh (no open turn), which is correct because a reload happens between agent runs.

### Dispose Behavior

On `session_before_switch` and `session_shutdown`:
1. Flush all pending messages.
2. `disposeInstance(instance, { settle })`:
   - `settle = true` (default): await `sdk.drainSettled(threadRef)` — wait for background derivation work to complete.
   - `settle = false`: headless quit (`ctx.hasUI === false`) skips settling so print/json commands return promptly. Intake is already durable at this point.

---

## Fail-Closed Design

### The Three Guard Layers

1. **Hook guard.** Every Epic 1 hook handler is wrapped in try/catch. A caught error becomes a `CaptureFailureDiagnostic` with `code: "hook_handler_error"`. Nothing propagates to PI.

2. **Capture isolation.** `flushIsolated` wraps `intakeStream.messageEvents` in try/catch. Even a genuine throw from a broken SQLite handle returns a structured `OpResult`. On `invalid_event`, a durable gap note is written to the event table (fingerprinted key, deduplicated on re-delivery).

3. **Outcome recording.** `recordCaptureOutcome` classifies every capture result. Success clears the health flag. `invalid_event` marks `recordedGap: true`. Store unavailable marks `recordedGap: false` (in-memory only, lost on restart).

### Compact Guard

The compact handler has its own outer try/catch that catches any exception the preflight chain might throw and returns `{ cancel: true }` with a diagnostic. Every cancel path writes a warning to LHC's log table and notifies via `ctx.ui.notify`.

The `capture_incomplete` gate is the critical safety: if the last capture failed, the thread may be missing recent content. Compacting on incomplete data would produce a view that drops what was just said. The connector refuses compact until capture is healthy.

### Diagnostic Destinations

| Diagnostic | Storage | Surfacing |
|---|---|---|
| Hook guard error | `lastDiagnostic` (closure) | `connector.snapshot()` |
| Capture `invalid_event` | Gap in `event` table + `state.health.lastCaptureFailure` | `inspect.health` (capture_gap), `connector.snapshot()` |
| Capture store unavailable | `state.health.lastCaptureFailure` only | `connector.snapshot()` (not durable) |
| Mapping failure | Gap in `event` table via `recordMappingFailure` | `inspect.health` |
| Session-start failure | `lastDiagnostic` (closure) | `connector.snapshot()` |
| Compact cancel | `compactDiagnostics` buffer + LHC log table + UI notify | `connector.getCompactDiagnostics()`, `inspect.health` |
| Startup validation | `state.health.startupValidation` + UI notify | `connector.getState().health` |

---

## Known Limitations

- **PI types are declared locally.** The connector mirrors the PI extension API surface from verified wiring research rather than importing from `@earendil-works/pi-coding-agent` types directly. The types in `src/pi/types.ts` are kept in sync manually.

- **pi-ai is loaded dynamically.** `@earendil-works/pi-ai` is imported at runtime via `new Function("specifier", "return import(specifier)")` to avoid a build-time dependency. If the host runtime doesn't provide pi-ai, inference calls fail as retryable `other` errors.

- **No context hook.** Context is served via session seeding and rehydration, not PI's `context` hook. This means the context is a snapshot from session creation time (or the last `/lhc-rehydrate`), not continuously updated.

- **Tool result summaries use truncation fallback.** `FORCE_TOOL_RESULT_SUMMARY_FALLBACK = true` in the LHC handlers means tool result summaries currently use deterministic truncation rather than inference. Inference-backed summaries are wired but gated off.

- **One LHC turn per agent run.** The connector closes the LHC turn only at `agent_end`, ignoring PI's per-step `turn_end` / `turnIndex`. A multi-step agent run with many tool calls and prompts produces one long LHC turn. This is a deliberate design choice: LHC turns represent user exchanges, not model steps.

- **Deferred entry id resolution.** Because PI appends the `SessionEntry` after `message_end` handlers return, the connector must queue messages and flush them on the next hook call. This means the very last message before `agent_end` is flushed inside the `agent_end` handler. If the process hard-kills between `message_end` and `agent_end`, the last message's capture uses a fallback idempotency key rather than the stable PI entry id.

- **Fork detection fallback.** When `session_before_fork` is not available (older PI versions), fork detection relies on reading the previous session's JSONL file and matching entry ids. This heuristic may miss forks if the session file is unavailable or the entry id structure has changed.

- **Compact floor is a hardcode.** The 50,000-token compact floor (`COMPACT_FLOOR_TOKENS`) is an interim constant. A future named compact settings system would make this configurable per profile.

- **Default inference lane.** The shipped default (`openai-codex/gpt-5.4-mini`) requires the host to have PI configured with access to that lane. Startup validation surfaces misconfiguration but does not block capture.
