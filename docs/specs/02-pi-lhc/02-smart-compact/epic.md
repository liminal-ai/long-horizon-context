# Epic 2: LHC Smart Compact

**Status:** Draft v2 — synthesized from two reviewed drafts.
**PRD:** `../00-prd.md` — Feature 3
**Domain model:** `../../onboard/01-core-concepts.md`, `../../onboard/02-domain-design.md`
**Design notes:** `../02-ongoing-design-notes.md`

---

## Onboarding Context

LHC (Long Horizon Context) is a host-neutral SDK that records the full message history of a conversation as a durable record, and from that record builds shorter views a harness loads and works from. `pi-lhc` is a PI extension that connects PI (the agent harness) to LHC.

Relevant terms:

- **Thread** — the durable, append-only record of one conversation. SQLite file under `~/.lhc/threads/`.
- **Turn** — the LHC unit of work. A populated turn normally begins with a user prompt and closes at agent end; closing a populated turn immediately opens the next empty turn, so LHC always has exactly one open turn. An empty open turn is compact-ready (no captured activity to lose).
- **Compact** — a context-shaping event that reduces recorded history into bands and resets the tail start. The only reducer of LHC's view.
- **Band** — a compressed representation of older turns in a thread-view. Band types: full, smooth, detailed, brief. A thread-view holds a sequence of bands covering older history, followed by a tail of recent, uncompressed turns.
- **Tail** — the recent turns after the compact point, rendered verbatim (full content).
- **Compact point** — the record-order position separating banded history from the tail. Set by compact; reset on each compact. May be zero if all history fits the full-tail budget (a no-op compact).
- **Derivation** — a background-computed material derived from recorded content. Relevant derivations for compact: `smoothed_prompt`, `smooth_turn_compression`, `tool_result_summary`, `chunk_summary_detailed`, `chunk_summary_brief`, `turn_rendering`. States: pending, ready, retrying, failed, blocked.
- **Profile** — a named budget configuration for compact: a lower-bound token target plus percentage allocations across band types. Built-in profiles: `continuation`, `conversation`, `coding`.
- **Receipt** — the result of a compact: per-band entry counts and token counts, compact point, tail tokens, total tokens, degraded entries, gaps, warnings.
- **PI session** — PI's in-memory conversation state, seeded from LHC on startup and resume. PI keeps its own native session transcript at runtime.
- **`session_before_compact`** — a PI extension hook that fires before PI compacts. Carries a `reason` (`manual | threshold | overflow`) and `willRetry`. The extension can return a compaction result that replaces PI's native summary-based compaction, or cancel it.

**PI compact timing (verified in PI source):** PI fires `session_before_compact` after an agent run completes — never mid-turn during the agent loop. For threshold and overflow compacts, this is the post-agent-run compaction check. For manual `/compact`, PI calls `abort()` + `waitForIdle()` first, which completes the current agent run (including `agent_end`), then fires the hook. In both cases, pi-lhc closes the LHC turn at `agent_end` (flushing capture and recording `turn_end`), so the LHC turn is closed and compact-eligible when the hook fires. No manufactured turn boundary is needed. AC-5.5 provides a defensive check in case the turn-close path fails.

---

## User Profile

**Primary User:** The operator — a developer running `pi-lhc` in the PI TUI on long-horizon agentic coding sessions where context fills. Dogfooding LHC compact on real threads.
**Context:** The operator works in sessions that exceed single-turn context windows. LHC is the source of truth for recorded history and for the served context view. PI is the harness that runs the model.
**Mental Model:** Compact reduces older closed history into bands and keeps recent history verbatim. It runs when PI decides context is full — by the operator's command, by the model's configured threshold, or after a context-overflow error. Because PI fires compact after the agent run ends, the work just completed is already part of closed history and gets compressed along with everything older. The operator expects compact to happen at a predictable point and to invalidate as little of the prefix cache as possible.
**Key Constraint:** No split-brain between LHC and PI. After compact, the session the model sees is consistent with what LHC recorded. Compact is deterministic (no inference at compact time) and fast (derivations are pre-computed; selection is a budget calculation).

---

## Feature Overview

When PI decides to compact — because the operator ran `/compact`, because context crossed the model's configured threshold, or because the model returned a context-overflow error — the `session_before_compact` hook in pi-lhc runs LHC's compact engine instead of PI's native summary-based compaction. LHC selects which closed turns go into which band types given the profile's budget, renders the band text, and replaces the thread's view snapshot in one transaction. pi-lhc maps the result into PI's compaction shape and hands it back (or cancels if there is nothing to compact or the compact fails). PI appends a compaction entry, rebuilds its in-memory messages, and shows its native compact feedback line.

Because PI fires compact after the agent run ends, and pi-lhc closes the LHC turn at agent end, the hook runs against closed history that already includes the turn just completed. No manufactured turn boundary, checkpoint, or continuation prompt is needed: PI continues or retries the agent natively after compact, and the next activity flows into the turn already opened at agent end.

Compact triggers when PI's own threshold logic fires. For models with large context windows where compacting at the native window is too late, the operator caps the model's `contextWindow` via PI's `models.json` `modelOverrides`. PI then fires the threshold compact at the reduced window.

The compact profile — which controls the lower bound token target and how budget is split across bands — uses a `default-initial` profile with the values from the current `coding` built-in (25% full, 35% smooth, 20% detailed, 20% brief, 120k lower bound). Whether registered as an LHC built-in, passed via `initLhc` config, or hardcoded in the extension is a tech design decision. Profile selection by model or session state is deferred.

### Flow Summary

- Flow 1: Manual compact — AC: 1.1–1.5
- Flow 2: Automatic threshold compact — AC: 2.1–2.4
- Flow 3: Overflow recovery — AC: 3.1–3.3
- Flow 4: Resume after compact — AC: 4.1–4.2
- Cross-flow: no-op, failure, degraded, and capture readiness — AC: 5.1–5.6

---

## Scope

### In Scope

- `session_before_compact` hook handler for all three reasons (manual, threshold, overflow)
- Mapping LHC compact result into PI's compaction result shape
- Hardcoded compact profile (based on `coding` preset values)
- Trigger configuration via `modelOverrides` (docs + sample `models.json`)
- No-op compact detection (cancel when selection produces no bands / compact point zero)
- Pre-compact capture flush and turn-state verification

### Out of Scope

- Status / health-check slash command (debugging is direct SDK inspection; not an operator-facing command)
- Manufactured turn boundary / checkpoint before compact (the LHC turn is already closed at agent end; no checkpoint needed)
- Continuation prompt after compact (PI continues/retries natively; no synthetic prompt needed)
- Context hook re-introduction (per-turn wire-context replacement)
- Profile auto-selection by model
- `runtime_note` / `bashExecution` fidelity restoration in session-view
- Renaming LHC built-in profiles (pi-lhc passes its own config values)
- Operator-facing profile override at compact time (hardcoded for v1)
- Receipt rendering UI (PI provides native compact line feedback)
- Pressure checkpoint / mid-turn overflow handling (see Appendix A)

### Assumptions

| ID | Assumption | Status | Owner | Notes |
|----|------------|--------|-------|-------|
| A1 | PI's `session_before_compact` hook fires for all three reasons (manual, threshold, overflow) | Validated | Lee | Confirmed in PI agent-core source — both auto and manual paths emit the hook |
| A2 | The extension can return a replacement compaction result that PI applies without modification | Validated | Lee | PI checks `hookResult?.compaction` and uses it directly if present |
| A3 | PI's `modelOverrides` in `models.json` can override `contextWindow` on built-in models | Validated | Lee | Confirmed in PI model-registry source — `ModelOverrideSchema` includes optional `contextWindow` |
| A4 | LHC derivations may or may not be ready when compact runs; compact uses deterministic fallback/degraded representations where available, with warnings and degraded entries in the receipt, rather than depending on derivation readiness | Validated | Lee | Confirmed in LHC compact source: missing derivations use fallback assembly; only canonical data damage (`kind: "blocked"`) refuses the compact. |
| A5 | PI rebuilds the in-memory session from the compaction result without requiring extension intervention | Validated | Lee | Confirmed in PI agent-session source: `appendCompaction` followed by `buildSessionContext()` → `agent.state.messages = sessionContext.messages`. The extension does not need a separate rehydrate for PI's in-session view. Whether that rebuilt shape matches LHC's resume shape is a separate question (Tech Design Question 4). |
| A6 | PI fires `agent_end` to extensions before checking auto-compaction | Validated | Lee | Confirmed in PI agent-session source: `_emitExtensionEvent(agent_end)` runs before `_handlePostAgentRun` → `_checkCompaction`. See Appendix A for implications. |
| A7 | `session_before_compact` fires after `agent_end` for threshold and overflow, and pi-lhc closes the LHC turn at `agent_end` | Validated | Lee | Both verified in source. The LHC turn is closed and compact-eligible when the hook fires for these reasons. |
| A8 | LHC compact engine (`threadView.compact`, `selectArrangement`, receipt) is complete and correct | Validated | Lee | Compact behavior is covered by the LHC test suite; compact is explicit, no-inference, writes snapshot in one transaction |
| A9 | Auto-compact stays enabled; threshold is whatever PI computes from the configured window | Design decision | Lee | PI's default `reserveTokens` is 16384; compact fires at `contextWindow − reserve` |

---

## Flows & Requirements

All three compact flows share one hook handler. The handler resolves the active thread, ensures capture is flushed and the turn state is compact-ready, runs compact, and maps the result (or cancels). The flows differ only in how PI fires the hook and what PI does with the result.

### Flow 1: Manual compact

The operator runs `/compact` during a session. PI fires `session_before_compact` with `reason: "manual"`. The handler runs the shared compact path and returns the result. PI appends a compaction entry, rebuilds its in-memory messages, and shows its native compact feedback line.

1. Operator types `/compact` in the PI TUI.
2. PI emits `session_before_compact` with `reason: "manual"`.
3. pi-lhc resolves the active LHC thread from session state.
4. pi-lhc flushes pending capture (AC-5.5), then verifies the LHC turn is compact-ready (AC-1.5). If the turn is open with captured activity, cancel with diagnostic reason `open_turn` and stop.
5. pi-lhc runs a read-only no-op preflight (AC-5.1): if all closed history fits the full-tail budget, cancel without writing a snapshot and stop.
6. pi-lhc calls `threadView.compact(ref, { profile })` with the hardcoded profile.
7. LHC runs `selectArrangement` against the profile budget, renders band text, replaces the view snapshot in one transaction (sets compact point, resets boundary), and returns a receipt.
8. pi-lhc maps the receipt into PI's compaction result shape (Tech Design), or cancels if the compact fails.
9. PI runs `appendCompaction(...)` and rebuilds `agent.state.messages`.
10. PI shows its native compact feedback line.

#### Acceptance Criteria

**AC-1.1:** Running `/compact` produces an LHC compact, not PI's native summary compaction.

- **TC-1.1a:** Given a session with closed turns exceeding the full-tail budget and an active LHC thread, when the operator runs `/compact`, then `threadView.compact` is called and the returned compaction result carries LHC band content (not a PI-native LLM summary).

**AC-1.2:** After manual compact, the LHC view snapshot is replaced.

- **TC-1.2a:** Given a thread with closed history that exceeds the full-tail budget, when `/compact` runs, then the thread's view snapshot has a compact point greater than zero, the boundary is reset to the compact point, and bands are stored.

**AC-1.3:** After manual compact, PI's in-memory messages are rebuilt from the compaction result.

- **TC-1.3a:** Given a completed compact, when PI rebuilds messages, then `agent.state.messages` reflects the compacted history (banded summary) followed by the kept tail.

**AC-1.4:** The operator sees PI's native compact feedback line.

- **TC-1.4a:** Given a completed compact, when PI renders feedback, then the operator sees a compact line with brief token numbers (tokens before, estimated after).

**AC-1.5:** Manual compact only runs when the LHC turn is compact-ready. PI's manual `compact()` calls `abort()` + `waitForIdle()` before emitting `session_before_compact`, which normally completes the agent run and emits `agent_end` — closing the LHC turn. However, if the abort/agent_end/capture path fails (e.g., capture error swallowed by the guard), the LHC turn may still be open with captured activity. In that case pi-lhc cancels and does not run compact. If the turn is open but has no captured activity, compact proceeds (an empty open turn is compact-ready). PI's `SessionBeforeCompactResult` carries only `{ cancel?, compaction? }` with no reason field, so pi-lhc records the reason `open_turn` in its own diagnostic; operator-visible surfacing of that reason is Tech Design (see Tech Design Question 7).

- **TC-1.5a:** Given the LHC turn is open with captured activity when `session_before_compact` fires (e.g., turn-close failed silently during abort), when the handler checks turn readiness, then pi-lhc returns `{ cancel: true }`, records a diagnostic reason `open_turn`, and no `threadView.compact` call is made.
- **TC-1.5b:** Given the operator runs `/compact` while the LHC turn is open but empty (no captured activity), when the hook fires, then pi-lhc runs the compact path (not cancelled).
- **TC-1.5c:** Given the operator runs `/compact` after an agent run has ended (turn closed), when the hook fires, then pi-lhc runs the compact path (not cancelled).

### Flow 2: Automatic threshold compact

During a session, after an agent run ends, PI checks whether context tokens exceed the model's configured window minus reserve tokens. If so, PI fires `session_before_compact` with `reason: "threshold"`. The handler runs the same compact path as manual compact. Because pi-lhc closed the LHC turn at agent end, the threshold compact compresses the turn just completed along with older closed history.

1. The agent run ends (`agent_end`); pi-lhc flushes capture and records `turn_end`, closing the LHC turn.
2. PI runs its compaction check; `shouldCompact` returns true because context tokens exceed `contextWindow − reserveTokens`.
3. PI emits `session_before_compact` with `reason: "threshold"`.
4. pi-lhc runs the shared compact path from Flow 1.
5. PI appends compaction, rebuilds messages, continues the agent.

#### Acceptance Criteria

**AC-2.1:** When context tokens exceed the configured window minus reserve, LHC compact runs.

- **TC-2.1a:** Given a session whose context crosses the threshold after agent end, when PI runs its compaction check, then `session_before_compact` fires with `reason: "threshold"` and LHC compact runs.

**AC-2.2:** Threshold compact produces the same LHC view effect as manual compact.

- **TC-2.2a:** Given a threshold compact with closed history exceeding the full-tail budget, when it completes, then the LHC view snapshot is replaced identically to a manual compact (compact point set, boundary reset, bands rendered).

**AC-2.3:** Threshold compact can compress the turn just completed, because agent end closed it first; the selection algorithm may place it in bands or in the full tail based on budget.

- **TC-2.3a:** Given an agent run that produced a turn large enough to trigger the threshold, when the threshold compact fires, then that turn is part of closed history and is eligible for compact selection (not excluded because it was still open at trigger time).

**AC-2.4:** Below the effective threshold, PI sends the current full session context to the model normally; the modelOverrides cap changes only the compact trigger calculation, not what is sent.

- **TC-2.4a:** Given a model overridden to 250k context window with session context at 200k (below the threshold), when the model receives a request, then PI sends the full 200k session context — the override does not truncate or filter what the model sees.

### Flow 3: Overflow recovery

The model returns a context-overflow error. The agent run ends; PI removes the error message from agent state and fires `session_before_compact` with `reason: "overflow"` and `willRetry: true`. The handler runs the shared compact path. PI retries the aborted turn with the compacted context. If compact runs but does not reduce enough, PI's one-retry limit surfaces a recovery-failed error rather than looping.

1. The model returns a context-overflow error; the agent run ends (`agent_end`); pi-lhc closes the LHC turn.
2. PI detects overflow and removes the error message from agent state.
3. PI emits `session_before_compact` with `reason: "overflow"`, `willRetry: true`.
4. pi-lhc runs the shared compact path from Flow 1.
5. PI retries the aborted turn with the compacted context.

#### Acceptance Criteria

**AC-3.1:** On context overflow, LHC compact runs (not PI native).

- **TC-3.1a:** Given a context-overflow error, when PI fires `session_before_compact` with `reason: "overflow"`, then the handler runs the compact path and the returned result carries LHC band content.

**AC-3.2:** PI retries the aborted turn with compacted context.

- **TC-3.2a:** Given a successful overflow compact, when PI retries, then the retried turn sees the compacted history (banded summary + kept tail).

**AC-3.3:** If compact runs but does not relieve enough pressure, PI surfaces a recovery-failed error rather than looping.

- **TC-3.3a:** Given an overflow where compacting does not reduce context below the window, when PI retries once and overflows again, then PI emits a recovery-failed error and does not loop.

### Flow 4: Resume after compact

The operator runs a compact, then quits and resumes the LHC thread later. On resume, PI's session is hydrated from LHC's compacted thread-view, not from PI's native compaction summary. The durable history in LHC remains complete — compact only replaced the view snapshot, not the recorded events. The resumed session shows the compacted history (bands) followed by the kept tail, with LHC as the source of truth.

1. A compact completes (any flow). LHC's view snapshot reflects the compacted bands and the kept tail.
2. The operator quits PI.
3. The operator resumes the LHC thread (`--lhc-resume` / `--lhc-continue` / `--lhc-thread`).
4. pi-lhc seeds PI's in-memory session from `threadView.getSessionThreadView`.
5. PI runs from the compacted thread-view.

#### Acceptance Criteria

**AC-4.1:** After a successful compact, resuming the LHC thread hydrates PI from LHC's compacted thread-view, not from PI's native compaction summary.

- **TC-4.1a:** Given a thread that has been compacted, when the operator resumes it, then `getSessionThreadView` returns the banded history followed by the kept tail, and PI's session is seeded from that.
- **TC-4.1b:** Given a compacted thread resumed via pi-lhc, when the session loads, then context comes from LHC's thread-view, not from PI's native compaction entry in its session file.

**AC-4.2:** A compact replaces only the view snapshot; it never deletes or rewrites recorded events. After a compact and resume, the full recorded history remains intact in LHC.

- **TC-4.2a:** Given a thread after compact, when the recorded events are read directly, then all events captured before and at the compact point are present and unchanged.

### Cross-flow: no-op, failure, degraded, and capture readiness

These apply to all three compact flows.

**AC-5.1:** No-op compacts are detected as a read-only preflight before LHC writes a snapshot: if all closed history fits the full-tail budget (compact point would be zero, no bands), the handler cancels without calling `threadView.compact`, so no LHC snapshot write occurs and PI does not append a compaction entry.

- **TC-5.1a:** Given closed history small enough to fit the full-tail budget, when compact is considered, then pi-lhc runs a read-only preflight and detects the no-op, and returns `{ cancel: true }` without invoking `threadView.compact`.
- **TC-5.1b:** Given a no-op compact, when the handler cancels preflight, then the LHC view snapshot is unchanged (no new snapshot written) and PI shows no compaction feedback.
- **TC-5.1c:** Given the preflight must predict `selectArrangement`'s compact point exactly, the preflight surface exposes per-message token estimates and turn boundaries sufficient to compute whether any content would land in bands — not just a tail-token sum.

**AC-5.2:** If LHC compact fails, the handler cancels PI compaction and the session is unchanged.

- **TC-5.2a:** Given an LHC compact that returns an error (state corruption, thread not found), when the handler runs, then it returns `{ cancel: true }` and the LHC view snapshot is unchanged.
- **TC-5.2b:** Given a compact failure, when the operator views the result, then pi-lhc records the failure reason in its diagnostics.

**AC-5.3:** The handler either returns an LHC compaction result or cancels; it never silently falls through to PI native compaction.

- **TC-5.3a:** Given compact handling for any reason, when the hook returns, then the result is either a compaction result with LHC band content or `{ cancel: true }` — never a return that lets PI proceed with its native summary compaction.

**AC-5.4:** Missing derivations do not block compact; only canonical data damage does.

- **TC-5.4a:** Given a thread where some chunk derivations (summaries) have not completed, when compact runs, then compact assembles the bands using deterministic fallback/degraded representations for chunks with missing derivations, and completes successfully.
- **TC-5.4b:** Given compact used fallback for one or more chunks, when the compact receipt is produced, then each degraded entry is listed with the chunk it applies to and the derivation that was unavailable.
- **TC-5.4c:** Given a thread where a required source record is damaged or missing (not a derivation — the canonical event data itself), when compact runs, then compact fails with a state corruption error; the session and thread-view remain unchanged.

**AC-5.5:** Before running compact, pi-lhc ensures pending capture is flushed and the LHC turn state is compact-ready. Note: the same runtime check catches compact attempts where the LHC turn is still open with captured activity. In normal manual, threshold, and overflow paths, `agent_end` closes the turn first; this AC covers defensive failure cases where capture or turn close did not complete.

- **TC-5.5a:** Given a pi-lhc session where `session_before_compact` fires, when the extension handles the hook, then any pending capture events are flushed to the LHC thread before compact runs.
- **TC-5.5b:** Given the `agent_end` capture (turn_end event) failed silently (recorded as a diagnostic, not thrown), when `session_before_compact` fires and the extension detects the LHC turn is still open with activity, then the extension cancels the compact (returns `{ cancel: true }` to PI) and records the failure reason.

**AC-5.6:** Compact works correctly on first and subsequent compacts.

- **TC-5.6a:** Given a thread that has never been compacted and has closed turns exceeding the full-share budget, when compact runs, then eligible closed history is arranged into bands according to the profile; the tail starts after the compact point.
- **TC-5.6b:** Given a thread that was previously compacted and has accumulated new turns since, when compact runs again, then the compact rebuilds from the full durable record; the compact point never moves backward, and advances only when the selection warrants it.

---

## Data Contracts

**LHC compact receipt (what pi-lhc reads from `threadView.compact`):**

| Field | Type | Notes |
|-------|------|-------|
| `viewId` | `string` | Deterministic id of the new view snapshot |
| `profile` | `string \| null` | Named profile used for selection; v1 expects a string because it passes a hardcoded profile; null mirrors the SDK shape when explicit params override |
| `config` | `ViewProfile["percentages"] & { lowerBound }` | The resolved budget configuration |
| `compactPoint` | `number` | Record-order position of the new tail start; zero if no bands |
| `coveredFrom` | `number` | Record-order start of the banded region |
| `bands` | `Record<Band, { entries, tokens }>` | Per-band entry count and token count (not rendered text) |
| `tailTokens` | `number` | Tokens in the tail |
| `totalTokens` | `number` | Band tokens + tail tokens |
| `degraded` | `Array<{ band, subjectId, usedDerivation }>` | Entries where a derivation was missing and fallback was used |
| `gaps` | `Array<{ band, subjectId, reason }>` | Coverage gaps |
| `warnings` | `Array<{ band, subjectId, derivationType, reason }>` (optional) | Fallback warnings; absent when no fallbacks were used |

**PI compaction result shape (what pi-lhc returns to PI):**

The exact mapping from the LHC receipt to PI's `{ summary, firstKeptEntryId, tokensBefore, details }` is a Tech Design decision (see Tech Design Questions). The epic-level contract is operator-visible: compact succeeded or was cancelled; if succeeded, the session shows compacted (banded) history followed by the kept tail, and PI's feedback line reports token counts.

**Compact failure (what pi-lhc records in its own diagnostics):**

| Field | Type | Description |
|-------|------|-------------|
| reason | string | Human-readable explanation of why compact failed or was cancelled |
| code | string | Category: `open_turn`, `no_op`, `compact_error`, `capture_incomplete` |

---

## Dependencies

- LHC `threadView.compact(ref, opts)` — exists, tested.
- LHC no-op preflight surface — **required new capability.** `threadView.status` exposes a tail-token sum, derivation counts, and view health, but not the per-message token estimates and turn boundaries that `selectArrangement` walks to compute `compactPoint`. So status cannot predict a no-op exactly. Story 0 must add a read-only compact-preview / dry-run surface (e.g. expose `selectArrangement` in a read-only mode, or a dedicated `previewCompact` that returns the would-be compact point and band counts without writing).
- LHC `selectArrangement` — exists, tested; can return compact point zero (no-op) when history fits the full-tail budget (verified in source).
- PI `session_before_compact` hook with `reason` and `willRetry` fields — verified in PI source.
- PI fires `session_before_compact` after `agent_end` / before a new prompt, never mid-loop — verified (`shouldCompact` only called from post-run / pre-prompt sites).
- PI `appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook)` on `SessionManager` (including in-memory) — verified in PI source.
- pi-lhc closes the LHC turn at `agent_end` via `turn_end` — verified in pi-lhc source.
- pi-lhc active-thread resolution from session state — exists.

---

## Non-Functional Requirements

- **Determinism:** Compact must not perform inference. Band selection is a budget calculation over pre-computed derivations.
- **Performance:** Compact should complete in seconds, not minutes. Derivations are pre-computed in background mode; selection and rendering are local computation against the SQLite thread.
- **Cache-friendliness:** The compact window (upper bound → lower bound) should be tuned so compact fires infrequently. Each compact invalidates the prefix cache from the compact point forward. A larger window means less frequent compacts and less cache churn.
- **No partial view writes:** LHC's compact writes the view snapshot in a single transaction. A cancelled or failed compact leaves the view snapshot unchanged.

---

## Tech Design Questions

1. **Compact-point to firstKeptEntryId mapping.** LHC's compact point is a record-order position; PI's `firstKeptEntryId` is a PI session entry id. How is the coordinate translation computed, and what guarantees that the first tail entry in LHC corresponds to a real PI entry id in the current session?
2. **Band-to-summary assembly.** How is the set of bands assembled into the single `summary` string PI expects? Concatenation order, separators, and whether band-type labels are included. (The receipt reports band counts/tokens; rendered band text lives in thread-view storage, not the receipt.)
3. **Profile configuration.** Does pi-lhc pass `profile: "coding"` to `threadView.compact`, or pass explicit `params` (lowerBound + band percentages) with the coding values? The extension should own its default without requiring an LHC built-in profile rename.
4. **In-session view after compact.** After compact returns, PI shows its native `compactionSummary` message (containing LHC band text as the summary) plus kept tail entries. On next resume, LHC rebuilds its structured banded view from its DB. Is the in-session vs resume presentation difference acceptable for v1, or should compact trigger an immediate rehydrate to LHC's banded shape?
5. **Tail regrouping fidelity.** PI's `appendCompaction` keeps entries from `firstKeptEntryId` as-is. LHC's tail is regrouped into session-view messages on resume. Does the in-session kept-tail shape match the resume tail shape closely enough that the model does not see a content shift after resume?
6. **Preflight no-op surface.** AC-5.1 requires a read-only preflight that predicts `selectArrangement`'s compact point exactly. `threadView.status` does not expose enough (it returns a tail-token sum, not per-message estimates). Confirm whether the new surface is a read-only `selectArrangement` exposure, a dedicated `previewCompact`, or another read — and whether near-no-op (tiny band region) should also cancel.
7. **Operator-visible cancel reason surfacing.** PI's `SessionBeforeCompactResult` has no reason field. pi-lhc retains the `open_turn` and other cancel diagnostics internally; how (or whether) to surface them to the operator in the TUI is Tech Design.
8. **Abort signal forwarding.** Should the abort signal from PI's `session_before_compact` event be forwarded to LHC's compact as its `signal` parameter?

---

## Recommended Story Breakdown

### Story 0: Compact hook handler + result mapping

**Governing idea:** Wire `session_before_compact` so that whenever PI fires compact — manual, threshold, or overflow — pi-lhc runs LHC's compact engine and maps the result into PI's compaction shape, or cancels on no-op/failure/open-turn. One handler serves all three reasons; they differ only in PI's trigger and PI's post-compact action (manual shows feedback, threshold continues the agent, overflow retries).
**Prerequisite:** None. The LHC engine and thread resolution exist.
**Boundary / risk notes:** The compact-point to `firstKeptEntryId` mapping is the load-bearing technical detail (Tech Design Question 1). Story 0 must add a read-only compact-preview surface to LHC so the preflight no-op check (AC-5.1) can predict `selectArrangement` exactly — `threadView.status` does not expose enough. Overflow has a known limitation: if compact runs but does not reduce enough, PI's one-retry limit surfaces a recovery-failed error (AC-3.3). The handler must never silently fall through to PI native compaction (AC-5.3). No-op compacts are cancelled, not applied (AC-5.1).
**ACs covered:** Flow 1 (AC-1.1–1.5), Flow 2 (AC-2.1–2.4), Flow 3 (AC-3.1–3.3), Flow 4 (AC-4.1–4.2), Cross-flow (AC-5.1–5.6).
**Estimated test count:** ~24 tests.

### Story 1: Trigger configuration

**Governing idea:** Document and ship a sample `models.json` with `modelOverrides` capping `contextWindow` on large-context models so PI fires threshold compact at the desired point. Pure configuration plus documentation; no runtime code beyond what Story 0 already handles.
**Prerequisite:** Story 0 (so the threshold hook is wired).
**Boundary / risk notes:** The override changes only `contextWindow`; auth, baseUrl, cost, and reasoning stay on the built-in entry. The reserve tokens (default 16384) mean compact fires at `contextWindow − reserve`. The operator picks the cap per model.
**ACs covered:** Supports AC-2.1 (the threshold trigger depends on the configured window).
**Estimated test count:** 2 tests (sample config validates; override does not touch other model fields).

---

## Validation Checklist

- [x] User Profile names the operator and the constraint (no split-brain, cache-friendly)
- [x] Every flow has at least one AC; every AC has at least one TC
- [x] Non-goals are actively identified (status command, context hook, checkpoint/continuation, profile auto-selection, receipt UI, fidelity restoration)
- [x] The three compact reasons (manual, threshold, overflow) each have dedicated ACs
- [x] Manual compact open-turn case has a functional rule (cancel with reason `open_turn`), not a Tech Design question
- [x] Resume-after-compact has ACs (LHC as source of truth on resume, durable history intact)
- [x] No-op compact is detected as a preflight before LHC writes a snapshot
- [x] PI compact timing (fires after agent_end) is stated and verified; the turn-is-already-closed consequence drives the design
- [x] No split-brain: the handler returns an LHC result or cancels, never silently native (AC-5.3)
- [x] Data contracts match the actual CompactReceipt shape (band counts/tokens, not rendered text)
- [x] Degraded derivation handling has dedicated ACs (proceed with fallback, report, refuse on canonical damage)
- [x] Capture flush and turn-state verification has a dedicated AC
- [x] Tech design questions separate from functional ACs
- [x] Assumption table tracks validation status
- [ ] All validator issues addressed
- [ ] Validation rounds complete
- [ ] Self-review complete

---

## Appendix

### A. Compact Timing, Turn Boundaries, and the Mid-Turn Problem

**The concern:** LHC always has exactly one open turn. PI's auto-compact fires based on token thresholds, not turn boundaries. If compact fires while the LHC turn is open, what happens to the open turn's content?

**Why it should not arise in the normal threshold/manual path:** PI's auto-compaction check runs in `_handlePostAgentRun`, which executes after PI emits `agent_end` to extensions. The pi-lhc extension closes the LHC turn on `agent_end` (via the turn accumulator). So by the time PI's `session_before_compact` hook fires, the LHC turn that contained the agent's work is already closed and compact-eligible. Manual `/compact` calls `abort()` + `waitForIdle()`, which completes the current agent run (including `agent_end`) before emitting the hook. Both paths arrive at `session_before_compact` with the LHC turn closed.

This is a structural property of PI's current event ordering, not a coincidence. PI checks compaction after the agent loop completes — it would be incorrect for PI to compact mid-agent-step because the agent might need to continue with tool results. The extension's `agent_end` → `turn_end` mapping aligns with this naturally.

For manual `/compact`, PI calls `abort()` + `waitForIdle()` before emitting `session_before_compact`. The abort completes the current agent run (including `agent_end` with `stopReason: "aborted"`), so pi-lhc closes the LHC turn through the normal `onAgentEnd` path. The turn is closed by the time the hook fires. AC-1.5 provides a defensive check in case the abort/agent_end/capture path fails, leaving the turn open.

**Where it does arise — and what it means for the future:**

The mid-turn compact problem becomes real in two scenarios:

1. **Extremely long single agent runs.** If an agent runs for many steps without finishing (never reaching `agent_end`), context can grow past the threshold without compact firing. PI checks compaction after agent runs complete, not between individual tool-use steps within a single run. With a capped context window (e.g., 250k), a long tool-heavy agent run could approach or exceed the effective window before the first agent_end.

2. **Overflow recovery.** PI has a separate overflow path that fires when a model call fails due to context exceeding the actual model limit. This path also goes through `session_before_compact`, so the extension intercepts it — but by this point context has already exceeded the limit and the model call has failed.

Both scenarios point toward the same solution: a mechanism to compact during a live agent run, before `agent_end`. This is the pressure checkpoint concept — the harness detects context pressure, forces an LHC turn boundary, runs compact, and continues the agent with a new turn. The key design elements:

- **Turn checkpoint.** Close the current LHC turn with a checkpoint reason (not a user prompt, not a fake message). Open a new turn. The closed turn becomes compact-eligible.
- **Continuation semantics.** The new turn starts without a user prompt. This requires a turn origin that is not `user_prompt` — something like `harness_checkpoint` or `context_pressure`. The continuation instruction to the model is ephemeral (runtime glue, not stored as a user message in the durable record).
- **Atomicity.** If compact fails after the turn checkpoint, the question is whether the turn boundary remains. For v1, atomic checkpoint+compact (failure rolls back the boundary) is simpler to reason about.
- **Detection trigger.** Either pi-lhc monitors token estimates between agent steps (via `message_end` or `turn_end` hooks), or PI's own overflow recovery triggers the checkpoint. The former is proactive; the latter is reactive and means one failed model call before recovery.

This epic explicitly defers the pressure checkpoint. The v1 integration relies on the fact that PI's compact timing naturally aligns with LHC's closed-turn state. Dogfooding will reveal how often the long-single-run scenario actually causes problems, which determines whether pressure checkpoint is urgent or can wait.

**A simpler intermediate option** — without full pressure-checkpoint semantics — would be for the extension to force a `turn_end` + immediate `user_prompt` (a synthetic continuation message) in the `session_before_compact` handler itself, before running compact. This makes the just-closed turn compact-eligible without requiring new turn-origin types or continuation semantics. The synthetic message would be visible in the durable record as a real user prompt. This is coarser than a proper harness checkpoint (it pretends the user said something) but would handle the overflow case pragmatically if it turns out to be common before the checkpoint design is ready. This intermediate option is not part of this epic unless explicitly promoted by a later design decision.
