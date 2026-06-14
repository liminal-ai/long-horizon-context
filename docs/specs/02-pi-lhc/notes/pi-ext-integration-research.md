# PI Extension Integration Research

**Status:** Research notes (June 12, 2026). Grounded in the current PI extension docs (`repo-ref/pi/packages/coding-agent/docs/extensions.md`, pulled today), the POC extension (`src/context-steward/pi/pi-extension.ts` + `pi-message-mapper.ts` + `parallel-event-intake.ts`), and the landed LHC SDK surface (`packages/lhc/src/sdk.ts`, Epic 05 tech design). Companion to `pi-ext-prd-notes.md` (the decisions capture doc); this is the wiring map.

---

## 1. What PI gives us (the hook surface)

The extension API covers everything the integration needs — no gaps requiring PI changes found.

**Events we consume:**

| PI event | What it carries | LHC use |
|---|---|---|
| `session_start` | `reason: "startup"\|"reload"\|"new"\|"resume"\|"fork"`, `previousSessionFile` | Resolve/create thread, hydrate state, startup validation surfacing |
| `message_end` | finalized `user` / `assistant` / `toolResult` message | Map → intake event batch → `sdk.intakeStream.messageEvents` |
| `turn_end` | `turnIndex`, `message`, `toolResults` | Emit `turn_end` intake event (closes LHC turn, triggers boundary advance + derivations) |
| `context` | deep copy of `messages`, return `{ messages }` to replace | Serve the thread view: `sdk.threadView.pull()` → map to `AgentMessage[]` |
| `session_before_compact` | preparation, can `{ cancel: true }` or supply custom compaction | Intercept PI's own compaction — LHC owns context now |
| `session_shutdown` | `reason`, `targetSessionFile` | Flush/cleanup |
| `session_before_switch` / `session_before_fork` | switch/fork interception | Thread mapping across session replacement; branching question (§6) |
| `model_select` | model changed | Optional: status display only |

**APIs we use:**
- `pi.registerCommand(name, …)` — operator commands (compact, status, health, sweep)
- `pi.registerTool({...})` — agent self-inspection tools (replaces the retired CLI); supports `promptSnippet`/`promptGuidelines`; can be registered at any time
- `pi.appendEntry(customType, data)` — persist extension state in the session file (does NOT enter LLM context); restore by scanning `ctx.sessionManager.getEntries()` on `session_start`
- `ctx.modelRegistry` — `find(provider, modelId)`, auth resolution via `getApiKeyAndHeaders` (verified in `src/core/model-registry.ts:406,707,757`)
- `pi-ai`'s `complete()` — single-turn completion (`packages/ai/src/stream.ts:49`)
- `ctx.ui.notify` / widgets / footer — status surfacing (guard with `ctx.hasUI`; extension must work in `rpc`/`json`/`print` modes too)

**Extension loading:** `~/.pi/agent/extensions/` (global), `.pi/extensions/` (project), or npm package via `settings.json` `packages` array — that's the publish-under-its-own-name path. Hot reload via `/reload` re-fires `session_shutdown` → `session_start{reason:"reload"}`.

**Footguns documented by PI (must design around):**
- Session replacement (`/new`, `/resume`, `/fork`): old extension instance is torn down; captured `ctx`/`sessionManager` objects go stale and throw. The POC is littered with `isStalePiContextError` fallback handling because it captures contexts — the new extension should hold *only* plain data (thread id, file path) across events and let each handler use its own fresh `ctx`.
- `message_end` handlers may replace the message; other extensions' mutations are visible — extension ordering matters if anything else mutates context.
- Parallel tool mode: `tool_execution_*` events interleave, but final `toolResult` `message_end` events still arrive in assistant source order — intake ordering is safe if we drive everything off `message_end`.

## 2. What the POC does (and what carries forward vs. dies)

The POC (`pi-extension.ts`, ~2,900 lines) wires: `session_start` (snapshot ctx, reconcile rollout, hydrate truncation state), `message_end` (capture → side-channel tool-result restore → schedule smoothing → buffer truncation observation), `tool_result` (stash original content before PI/extension truncation), `turn_end` (finalize turn, parallel intake, observe/refresh projection, schedule background maintenance), `agent_end` (refresh projection), `context` (apply prompt-visible truncation), plus ~12 `lh-*` commands.

**Carries forward as design knowledge:**
- The event-to-record mapper (`pi-message-mapper.ts`) is a complete worked example of PI message → canonical mapping: role→kind mapping, content-part fan-out (text/thinking/toolCall/image/fileRef/unknown), idempotency key construction (`pi:<session>:entry:<entryId>`, responseId/toolCallId fallbacks, content fingerprint last resort), token telemetry extraction from assistant `usage`. The new converter reimplements this against `MessageEventInput` (which is far simpler — 7 event kinds, text-only payloads).
- The `context` hook as the serving path — POC proved it works and is cheap enough.
- `turn_end` as the maintenance seam.
- Side-channel capture of original tool results before truncation (`tool_result` event fires before `message_end`).

**Dies with the POC:**
- Rollout-file reconciliation / `switchSession` machinery (`reconcileCurrentSession`) — the generated-session-file-then-reload flow was the jankiest part; the context hook replaces it.
- Captured-context snapshots + stale-context fallbacks — replaced by plain-data state.
- The in-extension truncation projection (`prompt-visible-tool-result-projection`) — LHC's visibility boundary (Epic 03/05) owns this now; the extension just serves `pull()` output.
- In-extension smoothing scheduling + PI-coupled providers (`pi-codex-user-prompt-smoothing-provider.ts` imports `pi-ai`/`AuthStorage` directly) — replaced by the Epic 05 `ModelCall` injection.
- Status-area error spew (the actionable-only rule).

## 3. The wiring, end to end

```
PI events                          extension (thin)                LHC SDK (one instance)
─────────                          ────────────────                ──────────────────────
session_start ──────────────────► resolve thread mapping ───────► threads.resolve / newThread
                                   validate inference config       createSdk({ inference, mode: "background", view })
                                   surface bad pins loudly
message_end ────────────────────► map message → event batch ────► intakeStream.messageEvents(ref, events)
                                   (1 PI msg → 1..n LHC events)        └─ background scheduler auto-drains
turn_end ───────────────────────► turn_end event ───────────────► intakeStream.messageEvents(ref, [turn_end])
                                                                       └─ boundary advance + turn derivations
context ────────────────────────► pull + map ───────────────────► threadView.pull(ref) → ViewMessage[] → AgentMessage[]
session_before_compact ─────────► { cancel: true } (LHC owns context; PI compaction off)
/lh-compact (command) ──────────► threadView.compact(ref, { profile })
/lh-status, /lh-health ─────────► threadView.status / inspect.health
agent tools (registerTool) ─────► inspect.overview / health / view, messages.list/show
ModelCall (injected fn) ◄──────── inference adapter calls it ◄──── derivation handlers
  └─ ctx.modelRegistry.find(provider, model) → complete() → text
```

**Construction:** one `createSdk` per session, `mode: "background"` (the scheduler auto-drains on enqueue pokes — the extension never calls `drain`). Built on `session_start`, torn down on `session_shutdown`. SDK instance + thread ref are the only module state.

**Event mapping (the converter contract):** PI `message_end` fans out to `MessageEventInput`s:
- `user` message → `user_prompt` (text parts joined; images/fileRefs: open question §6)
- `assistant` message → ordered fan-out per content part: `assistant_thinking`, `assistant_text`, `tool_call` (×N)
- `toolResult` message → `tool_result` (content text, `isError`)
- PI `turn_end` event → `turn_end`
- idempotency keys from session entry id (the POC's `targetEventKey` scheme, simplified)

**Context serving (the mapping back):** `ViewMessage { role: "user"|"assistant", content }` → PI `AgentMessage`. Band messages are plain user-role text blocks; tail messages are pre-rendered text (tool calls/results already formatted by LHC's mapping table in `shared/view.ts:60-77`). Two things to verify in the dial-in/recording period: whether serving tool calls as flattened text (vs. native `toolCall` content parts) affects model behavior, and what PI requires of the first/last message roles.

**Inference wiring (already specced as Epic 05's host side):** the ~15-line `ModelCall` — `ctx.modelRegistry.find(provider, model)` → missing ⇒ `{ ok: false, kind: "auth"|"invalid_request" }` → `complete(model, { messages })` → map errors to `ModelCallFailureKind`. Assignments (the seven `kind → { provider, model, prompt }`) come from the extension's config section; `createSdk` throws on incomplete/unknown assignments, and the extension surfaces that `TypeError` at load as a visible, actionable startup error — exactly the startup-validation requirement from the notes doc.

## 4. Functional scope (what the extension must do)

1. **Thread lifecycle** — PI session ↔ LHC thread mapping (persisted via `appendEntry` in the session file, or a registry sidecar like the POC's `threadId-map.json` — decision needed); create on first event; reattach on resume/reload; handle fork (§6).
2. **Intake** — message/turn event capture, mapped and batched, ordering preserved, idempotent across replays (PI resume re-fires nothing, but reload/fork paths need the keys).
3. **Context serving** — the `context` hook returns the LHC view; PI's own compaction disabled/intercepted; materialize-to-session-file kept as manual fallback command only.
4. **Inference host duties** — `ModelCall` + assignments config + startup validation surfacing.
5. **Operator commands** — compact (with profiles), status, health, sweep, materialize, attach/detach. Far fewer than the POC's 12; the inspect surfaces do the work.
6. **Agent self-inspection tools** — `registerTool` wrappers over `inspect.*`/`messages.*` reads, same SDK instance. The CLI-replacement decision.
7. **Status UX** — actionable-only; everything else queryable via health. Footer/widget for passive state (thread id, tail %, compact recommended) is candidate polish.
8. **Packaging** — npm package under its own name; `packages` setting; works in TUI and headless modes.

## 5. What LHC still needs (host-side gaps, all small)

- **A "since" / incremental read for nothing** — actually no: `pull()` returns the full view each call; PI wants full message arrays anyway. No gap.
- **`turn_end` with no open turn is contractual no-op** — already specced (Epic 01). Good for PI's pre-first-prompt events.
- **Thread registry by external key** — `threads.resolve` exists; need to confirm it supports lookup by the extension's mapping key or whether the extension owns the map entirely (POC owned it; probably still right).
- **Nothing else found.** The SDK surface (`intakeStream`, `threadView`, `inspect`, `messages`, `work`) covers every arrow in the diagram. This is the payoff of the SDK-only consolidation.

## 5a. Observed PI event behavior (headless recon, June 12 2026)

Drove published PI 0.79.2 headlessly (`pi --print --mode json -e log-ext.ts`) against gpt-5.4 with a log-every-hook extension, across chatty / tool-heavy / error / resume scenarios. This answers the behavioral questions static types couldn't, and de-risks most of Epic 1's capture contract before M0. Scratch rig: `scratch-pi-recon/`.

**Event lifecycle (verified order):**
```
session_start{reason} → before_agent_start{prompt,images} → agent_start
  → turn_start{turnIndex}
     → message_start/message_end (user [text])
     → message_start/message_end (assistant [thinking?, text?, toolCall×N])
     → (per tool) tool_execution_start{toolCallId,toolName,args} → tool_call → tool_result → tool_execution_end
     → message_start/message_end (toolResult [text]) ×N
     → turn_end{turnIndex, message, toolResults[]}
  → turn_start{turnIndex+1} ... (a new turn per agent step until no tool calls)
  → agent_end{messages[]} → session_shutdown
```

**Answers to the prior unknowns:**
- **Turn granularity.** PI fires one `turn_start`/`turn_end` *per agent step*, not per user prompt. A single user prompt that triggers tools produced turn 0 (prompt + tool calls + results) then turn 1 (final assistant answer). So PI's "turn" ≠ LHC's turn (one user prompt + all the agent did). **The mapper must not map PI turn_end → LHC turn_end 1:1.** LHC's turn-close is the agent_end (or the next user prompt), not each PI turn_end. This is the single most important finding — it would have been mapped wrong from assumption.
- **Parallel tool calls.** All N calls arrive in *one* assistant `message_end` (content = `[toolCall, toolCall, toolCall]`), each `{type,id,name,arguments}`. `tool_execution_start` events interleave and `tool_result`s complete out of order, but each `toolResult` `message_end` carries its `toolCallId`, so ordering is recoverable by ID, not arrival. Fan-out to LHC `tool_call` events is per-content-part, exactly as the mapper assumed.
- **Error results.** `toolResult` message carries `isError: true` and the error text as normal `content: [{type:text}]`. Maps cleanly to LHC `tool_result {content, isError}`. No special error event.
- **toolCallId shape.** Composite: `call_<providerId>|fc_<internalId>`. Stable across `tool_execution_start` → `tool_result` → the `toolResult` message. Usable as the correlation key and as part of the idempotency key.
- **Resume/dedup — the big one.** Reopening an existing session (`--session-id` of a prior session) does **NOT** re-fire historical `message_end` events. Only the new turn's events fire (verified: 4 message events, not 10). PI loads prior history internally and exposes it through the **`context` hook** (first context on resume already held all 7 prior messages). **Consequence: LHC intake never sees duplicate historical events on resume — the dedup concern is far smaller than feared.** Idempotency keys still matter for `/reload` and crash-replay, but normal resume is clean by construction.
- **Assistant message composition.** Confirmed `[thinking, text]`, `[thinking, toolCall]`, `[toolCall×N]` all occur; thinking carries an encrypted `thinkingSignature` (provider reasoning token — opaque, store-or-drop is an LHC call). The fan-out order in one message is thinking → text → toolCalls.
- **session_start reason.** `"startup"` on fresh and on resume alike in print mode; `previousSessionFile` was absent. The reason-code taxonomy (`new/resume/reload/fork`) from the docs may surface differently in interactive vs print mode — worth confirming interactively, but not blocking.

**Fork (`--fork`), captured solo:** forking a session creates a **new** session file (UUID-named); the original is untouched. The fork inherited all prior history via the `context` hook (11 messages present). In print mode `session_start` still reported `reason=startup` and carried no fork lineage in the payload — the lineage lives in the session file's `parentId` chain (below), not the event. `session_before_fork` did not fire in print-mode `--fork` (likely an interactive-command hook). **Fork-as-new-thread (the PRD decision) matches PI's own behavior — PI already makes a new file.**

**Hard-kill abort, captured solo:** `kill -9` mid-stream left the log at `session_start → before_agent_start → agent_start → turn_start → message_end(user)` — **no assistant `message_end`, no `turn_end`, no `agent_end`, no `session_shutdown`.** The incomplete-turn shape: user prompt captured, no agent response, turn never closed. LHC reattach after a crash finds an open turn with a trailing user prompt; intake must tolerate it. This is the crash-safety shape AC-1.4 needs.

**PI session file format, read directly** (`sessions/*.jsonl`, the materialize/import target for Feature 2):
- First line: `{type:"session", version:3, id, timestamp, cwd}`.
- Control entries: `model_change {provider, modelId}`, `thinking_level_change {thinkingLevel}`.
- Message entries: `{type:"message", id, parentId, timestamp, message:{role, content, ...}}`.
- **Every entry carries `id` + `parentId`** — the session is a *tree*, and fork/branch/`/tree` navigate it. This is the on-disk shape `materialize` (AC-2.6) emits and the structure the fork question (§6 Q1) is really about. Version `3`; pin the minimum.

## 5b. Interactive recon (Procedures A/B/D, June 12 2026)

Drove real interactive PI with Lee at the keyboard, log extension attached. Cleared the lifecycle/abort/compaction unknowns headless mode couldn't reach.

**Abort — two distinct shapes, handled differently:**
- **Graceful interrupt (Esc):** the partial assistant message gets a normal `message_end` with content preserved (`[thinking, text]`, ~120 lines kept) and **`stopReason: "aborted"`**; `turn_end` fires, also `stopReason: "aborted"`; `agent_end` fires. A graceful abort is a *complete, well-formed turn marked aborted* — partial content is real and worth keeping. The session continues normally on the next prompt (verified: follow-up ran `stopReason: "stop"`, no recovery path).
- **Hard-kill (`kill -9`, §5a):** nothing closes — user `message_end` only, no assistant close, no `turn_end`. Dangling open turn.
- Mapper carries `stopReason` through; LHC distinguishes "aborted-but-complete" from "crashed-open."

**`turnIndex` is per-agent-run, not session-monotonic.** Each prompt's agent run resets `turn_start turn=0` and `agent_end` reports only that run's messages. The mapper cannot use PI `turnIndex` as a session-wide counter; session order comes from the session file's `parentId` chain. (Reinforces the §5a finding that PI turns ≠ LHC turns.)

**Session lifecycle taxonomy (the codes print mode hid behind `startup`):**
| Transition | Sequence | `session_start.reason` | `previousSessionFile` |
|---|---|---|---|
| `/reload` | `session_shutdown{reload}` → ext re-init → `session_start{reload}` | `reload` | empty |
| `/new` | `session_before_switch{new}` → `session_shutdown{new}` → re-init → `session_start{new}` | `new` | populated (left session) |
| `/resume` | `session_before_switch{resume}` → `session_shutdown{resume}` → re-init → `session_start{resume}` | `resume` | populated (left session) |
- **`session_before_switch`** is the pre-transition hook (fires for new/resume, not reload) — where the extension disposes the old LHC instance and flushes before the swap.
- **Reload wipes extension in-memory state** (`_loaded` re-fires) but continues the same session — so the thread mapping must reconstruct from the session file, not closures (confirms the PRD extension-state-discipline decision with evidence). `reason: "reload"` lets Lifecycle detect-and-reattach rather than create.
- **Resume re-fires zero `message_end` events** (confirmed interactively, matching §5a) — history served via `context` only. Dedup is needed for `/reload` + crash-replay, not normal resume.

**Compaction intercept — PRD assumption A7, intercept half proven:**
- `session_before_compact` fires *before* the work with: a **`signal`** (cancellation handle — the `{cancel:true}` path), and **`preparation`** = `{firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, fileOps, settings:{enabled, reserveTokens, keepRecentTokens}}`, plus `branchEntries`.
- `session_compact` carries **`fromExtension`** (`false` for native) and the `compactionEntry` summary.
- **The intercept half of A7 holds:** the hook fires pre-work, exposes a cancel signal, and hands full preparation detail — the extension can cancel native compaction and redirect to smart compact. `preparation.settings.enabled` even exposes whether native compaction is on. `fromExtension` gives a clean path for the future *redirect* option (Future Directions) vs. pure cancel.
- Auto-trigger-starvation (the other half of A7) remains the Feature 2 proof target: serving a bounded LHC view must prevent PI's native auto-compact trigger. Not testable until serving exists. The load-bearing intercept capability is confirmed present here.

**Still needs M0 / interactive (small, named):**
- **Images/file-refs** — `@file.png` in print mode stayed literal text (§5a); interactive paste shape uncaptured. Procedure C, only if images are v1 scope.
- **Fork's interactive `session_before_fork`** — print `--fork` didn't fire it; low priority (fork-as-new-thread is settled and matches PI behavior).
- **Real corpus breadth** and **dial-in** — Lee's sessions + judgment, not a harness gap.

## 6. Open design questions (for the PRD, some answered by the recording period)

1. **Branching/forks.** PI `/fork`/`/tree` create divergent session branches; the LHC record is append-only and linear. Options: new thread per fork (copy-on-fork via session import), record-and-ignore (known dead-residue gap, manual delete as cleanup — consistent with the Epic 03 decision), or refuse. Needs a real decision; likeliest v1 answer is new-thread-per-fork with the old thread left intact.
2. **PI compaction interception.** Cancel always? Or let `session_before_compact` trigger an LHC smart compact and return a summary entry so PI's session file stays self-consistent? The second is more coherent but couples the flows.
3. **Images/file refs in prompts.** `MessageEventInput` payloads are text-only. Placeholder text in v1 (`[image]`), or payload extension? POC mapped them to `image_ref`/`file_ref` parts — LHC's current schema deliberately doesn't.
4. **Tool calls as text vs. native parts in served context.** Affects model tool-use quality; recording period + dial-in answers this empirically.
5. **What resume actually replays.** ANSWERED (§5a): resume does not re-fire history; PI serves prior context through the `context` hook. Aborts and the context-hook mid-turn view still need the recording period.
6. **Mapping persistence** — `appendEntry` (travels with session file) vs. sidecar registry (survives session file deletion). Lean: `appendEntry` primary, registry as index.

## 7. Sizing

The work splits into three epics of distinct character, under one extension PRD (plus the already-decided paired work that precedes it):

**Pre-PRD paired period (already decided, not spec-pack work):** recording extension + scenario capture + converter + harness corpora + derivation dial-in. The recording extension and converter are the reconnaissance that answers §6 Q4/Q5 and de-risks Epic A's mapper. This comes first and feeds the PRD.

**Epic A — Connector core (intake + lifecycle + inference host):** ~5–6 stories. SDK construction/teardown on session lifecycle, thread mapping + resume/reload/fork handling, message/turn event mapper (converter productionized), `ModelCall` + assignments config + startup validation, ordering/idempotency proof against recorded corpora.

**Epic B — Context serving:** ~4–5 stories. The `context` hook path (pull → AgentMessage mapping), PI compaction interception, materialize fallback command, mid-turn/abort edge behavior, cache-stability verification (the whole point — byte-stable prefixes between compacts).

**Epic C — Surface & ship:** ~4–5 stories. Operator commands, agent self-inspection tools, status/footer UX under the actionable-only rule, packaging/publish + headless-mode conformance, dogfood bring-up checklist.

Total: **~14–16 stories across 3 epics**, with Epic A blocking B, and C mostly parallel after A. Roughly the shape of Epics 2+3 combined in effort — but with materially lower design risk than those had, because the recording period converts the unknowns (PI's actual event behavior) into fixtures before specs are written.
