# Epic: LHC Compact — pi-lhc Operator Surface

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

**PI compact timing (verified in PI source):** PI fires `session_before_compact` only after an agent run completes (`agent_end`) or before a new prompt is submitted — never mid-turn during the agent loop. pi-lhc closes the LHC turn at `agent_end` (flushing capture and recording `turn_end`). Therefore, for threshold and overflow compacts, the LHC turn is already closed and compact-eligible when the hook fires. No manufactured turn boundary is needed: the turn was closed by the normal `agent_end` path before compact runs.

## User Profile

- **Primary User:** The operator — a developer running `pi-lhc` in the PI TUI on long-horizon agentic coding sessions where context fills. Dogfooding LHC compact on real threads.
- **Context:** The operator works in sessions that exceed single-turn context windows. LHC is the source of truth for recorded history and for the served context view. PI is the harness that runs the model.
- **Mental Model:** Compact reduces older closed history into bands and keeps recent history verbatim. It runs when PI decides context is full — by the operator's command, by the model's configured threshold, or after a context-overflow error. Because PI fires compact after the agent run ends, the work just completed is already part of closed history and gets compressed along with everything older. The operator expects compact to happen at a predictable point and to invalidate as little of the prefix cache as possible.
- **Key Constraint:** No split-brain between LHC and PI. After compact, the session the model sees is consistent with what LHC recorded. Compact is deterministic (no inference at compact time) and fast (derivations are pre-computed; selection is a budget calculation).

## Feature Overview

When PI decides to compact — because the operator ran `/compact`, because context crossed the model's configured window, or because the model returned a context-overflow error — the `session_before_compact` hook in pi-lhc runs LHC's compact engine instead of PI's native summary-based compaction. LHC selects which closed turns go into which band types given the profile's budget, renders the band text, and replaces the thread's view snapshot in one transaction. pi-lhc maps the result into PI's compaction shape and hands it back (or cancels if there is nothing to compact or the compact fails). PI appends a compaction entry, rebuilds its in-memory messages, and shows its native compact feedback line with brief numbers.

Because PI fires compact after the agent run ends, and pi-lhc closes the LHC turn at agent end, the hook runs against closed history that already includes the turn just completed. No manufactured turn boundary, checkpoint, or continuation prompt is needed: PI continues or retries the agent natively after compact, and the next activity flows into the turn already opened at agent end.

Compact triggers when PI's own threshold logic fires. For models with large context windows where compacting at the native window is too late, the operator caps the model's `contextWindow` via PI's `models.json` `modelOverrides`. PI then fires the threshold compact at the reduced window.

**Flow Summary:**
- Flow 1: Manual compact
- Flow 2: Automatic threshold compact
- Flow 3: Overflow recovery
- Flow 4: Resume after compact

## Scope

| In | Out | Assumptions |
|----|-----|-------------|
| `session_before_compact` hook handler for all three reasons (manual, threshold, overflow) | Status / health-check slash command (debugging is direct SDK inspection; not an operator-facing command) | LHC compact engine (`threadView.compact`, `selectArrangement`, receipt) is complete and correct |
| Mapping LHC compact result into PI's compaction result shape | Manufactured turn boundary / checkpoint before compact (the LHC turn is already closed at agent end; no checkpoint needed) | Capture + derivation pipeline is wired and running in background mode |
| Hardcoded compact profile (based on `coding` preset values) | Continuation prompt after compact (PI continues/retries natively; no synthetic prompt needed) | `session_before_compact` fires after `agent_end` for threshold and overflow, and pi-lhc closes the LHC turn at `agent_end` (both verified in source) |
| Trigger configuration via `modelOverrides` (docs + sample `models.json`) | Context hook re-introduction (per-turn wire-context replacement) | `appendCompaction` works on in-memory `SessionManager` (verified in PI source) |
| No-op compact detection (cancel when selection produces no bands / compact point zero) | Atomic checkpoint-and-compact transaction (moot; no checkpoint) | Derivations may not be ready at compact time; LHC's deterministic degraded/fallback representations are acceptable |
| | Profile auto-selection by model | Auto-compact stays enabled; threshold is whatever PI computes from the configured window |
| | `runtime_note` / `bashExecution` fidelity restoration in session-view | |
| | Renaming LHC built-in profiles (pi-lhc passes its own config values) | |
| | Operator-facing profile override at compact time (hardcoded for v1) | |
| | Receipt rendering UI (PI provides native compact line feedback) | |

## Flows & Requirements

All three flows share one hook handler. The handler resolves the active thread, runs compact, and maps the result (or cancels). The flows differ only in how PI fires the hook and what PI does with the result.

### Flow 1: Manual compact

The operator runs `/compact` during a session. PI fires `session_before_compact` with `reason: "manual"`. The handler runs the shared compact path and returns the result. PI appends a compaction entry, rebuilds its in-memory messages, and shows its native compact feedback line.

1. Operator types `/compact` in the PI TUI.
2. PI emits `session_before_compact` with `reason: "manual"`.
3. pi-lhc resolves the active LHC thread from session state.
4. pi-lhc checks turn readiness (AC-1.5): if the turn is open with captured activity, cancel with reason `open_turn` and stop.
5. pi-lhc runs a read-only no-op preflight (AC-4.1): if all closed history fits the full-tail budget, cancel without writing a snapshot and stop.
6. pi-lhc calls `threadView.compact(ref, { profile })` with the hardcoded profile.
7. LHC runs `selectArrangement` against the profile budget, renders band text, replaces the view snapshot in one transaction (sets compact point, resets boundary), and returns a receipt.
8. pi-lhc maps the receipt into PI's compaction result shape (Tech Design), or cancels if the compact fails.
9. PI runs `appendCompaction(...)` and rebuilds `agent.state.messages`.
10. PI shows its native compact feedback line with brief numbers.

**AC-1.1** Running `/compact` produces an LHC compact, not PI's native summary compaction.
- TC-1.1a — Given a session with closed turns and an active LHC thread, when the operator runs `/compact`, then `threadView.compact` is called and the returned compaction result carries LHC band content (not a PI-native LLM summary).

**AC-1.2** After manual compact, the LHC view snapshot is replaced.
- TC-1.2a — Given a thread with closed history that exceeds the full-tail budget, when `/compact` runs, then the thread's view snapshot has a compact point greater than zero, the boundary is reset to the compact point, and bands are stored.

**AC-1.3** After manual compact, PI's in-memory messages are rebuilt from the compaction result.
- TC-1.3a — Given a completed compact, when PI rebuilds messages, then `agent.state.messages` reflects the compacted history (banded summary) followed by the kept tail.

**AC-1.4** The operator sees PI's native compact feedback line.
- TC-1.4a — Given a completed compact, when PI renders feedback, then the operator sees a compact line with brief token numbers (tokens before, estimated after).

**AC-1.5** Manual compact only runs when the LHC turn is compact-ready. PI's manual `compact()` aborts the current operation without emitting `agent_end`, so the hook can fire while the LHC turn is still open with captured activity. In that case pi-lhc cancels and does not run compact; the operator can retry after the agent run ends. If the turn is open but has no captured activity, compact proceeds (an empty open turn is compact-ready). PI's `SessionBeforeCompactResult` carries only `{ cancel?, compaction? }` with no reason field, so pi-lhc records the reason `open_turn` in its own diagnostic; operator-visible surfacing of that reason is Tech Design (see Tech Design Question 8).
- TC-1.5a — Given the operator runs `/compact` while an agent run is in progress with captured activity in the open LHC turn, when the hook fires, then pi-lhc returns `{ cancel: true }`, records a diagnostic reason `open_turn`, and no `threadView.compact` call is made.
- TC-1.5b — Given the operator runs `/compact` while the LHC turn is open but empty (no captured activity), when the hook fires, then pi-lhc runs the compact path (not cancelled).
- TC-1.5c — Given the operator runs `/compact` after an agent run has ended (turn closed), when the hook fires, then pi-lhc runs the compact path (not cancelled).

### Flow 2: Automatic threshold compact

During a session, after an agent run ends, PI checks whether context tokens exceed the model's configured window minus reserve tokens. If so, PI fires `session_before_compact` with `reason: "threshold"`. The handler runs the same compact path as manual compact. Because pi-lhc closed the LHC turn at agent end, the threshold compact compresses the turn just completed along with older closed history.

1. The agent run ends (`agent_end`); pi-lhc flushes capture and records `turn_end`, closing the LHC turn.
2. PI runs its compaction check; `shouldCompact` returns true because context tokens exceed `contextWindow − reserveTokens`.
3. PI emits `session_before_compact` with `reason: "threshold"`.
4. pi-lhc runs the shared compact path from Flow 1.
5. PI appends compaction, rebuilds messages, continues the agent.

**AC-2.1** When context tokens exceed the configured window minus reserve, LHC compact runs.
- TC-2.1a — Given a session whose context crosses the threshold after agent end, when PI runs its compaction check, then `session_before_compact` fires with `reason: "threshold"` and LHC compact runs.

**AC-2.2** Threshold compact produces the same LHC view effect as manual compact.
- TC-2.2a — Given a threshold compact with closed history exceeding the full-tail budget, when it completes, then the LHC view snapshot is replaced identically to a manual compact (compact point set, boundary reset, bands rendered).

**AC-2.3** Threshold compact can compress the turn just completed, because agent end closed it first; the selection algorithm may place it in bands or in the full tail based on budget.
- TC-2.3a — Given an agent run that produced a turn large enough to trigger the threshold, when the threshold compact fires, then that turn is part of closed history and is eligible for compact selection (not excluded because it was still open at trigger time).

### Flow 3: Overflow recovery

The model returns a context-overflow error. The agent run ends; PI removes the error message from agent state and fires `session_before_compact` with `reason: "overflow"` and `willRetry: true`. The handler runs the shared compact path. PI retries the aborted turn with the compacted context. If compact runs but does not reduce enough, PI's one-retry limit surfaces a recovery-failed error rather than looping.

1. The model returns a context-overflow error; the agent run ends (`agent_end`); pi-lhc closes the LHC turn.
2. PI detects overflow and removes the error message from agent state.
3. PI emits `session_before_compact` with `reason: "overflow"`, `willRetry: true`.
4. pi-lhc runs the shared compact path from Flow 1.
5. PI retries the aborted turn with the compacted context.

**AC-3.1** On context overflow, LHC compact runs (not PI native).
- TC-3.1a — Given a context-overflow error, when PI fires `session_before_compact` with `reason: "overflow"`, then the handler runs the compact path and the returned result carries LHC band content.

**AC-3.2** PI retries the aborted turn with compacted context.
- TC-3.2a — Given a successful overflow compact, when PI retries, then the retried turn sees the compacted history (banded summary + kept tail).

**AC-3.3** If compact runs but does not relieve enough pressure, PI surfaces a recovery-failed error rather than looping.
- TC-3.3a — Given an overflow where compacting does not reduce context below the window, when PI retries once and overflows again, then PI emits a recovery-failed error and does not loop.

### Flow 4: Resume after compact

The operator runs a compact, then quits and resumes the LHC thread later. On resume, PI's session is hydrated from LHC's compacted thread-view, not from PI's native compaction summary. The durable history in LHC remains complete — compact only replaced the view snapshot, not the recorded events. The resumed session shows the compacted history (bands) followed by the kept tail, with LHC as the source of truth.

1. A compact completes (any flow). LHC's view snapshot reflects the compacted bands and the kept tail.
2. The operator quits PI.
3. The operator resumes the LHC thread (`--lhc-resume` / `--lhc-continue` / `--lhc-thread`).
4. pi-lhc seeds PI's in-memory session from `threadView.getSessionThreadView`.
5. PI runs from the compacted thread-view.

**AC-4.0** After a successful compact, resuming the LHC thread hydrates PI from LHC's compacted thread-view, not from PI's native compaction summary.
- TC-4.0a — Given a thread that has been compacted, when the operator resumes it, then `getSessionThreadView` returns the banded history followed by the kept tail, and PI's session is seeded from that.

**AC-4.0b (durable integrity)** A compact replaces only the view snapshot; it never deletes or rewrites recorded events. After a compact and resume, the full recorded history remains intact in LHC.
- TC-4.0b — Given a thread after compact, when the recorded events are read directly, then all events captured before and at the compact point are present and unchanged.

### Cross-flow: no-op and failure handling

These apply to all three flows.

**AC-4.1** No-op compacts are detected as a read-only preflight before LHC writes a snapshot: if all closed history fits the full-tail budget (compact point would be zero, no bands), the handler cancels without calling `threadView.compact`, so no LHC snapshot write occurs and PI does not append a compaction entry.
- TC-4.1a — Given closed history small enough to fit the full-tail budget, when compact is considered, then pi-lhc runs a read-only preflight and detects the no-op, and returns `{ cancel: true }` without invoking `threadView.compact`.
- TC-4.1b — Given a no-op compact, when the handler cancels preflight, then the LHC view snapshot is unchanged (no new snapshot written) and PI shows no compaction feedback.
- TC-4.1c — Given the preflight must predict `selectArrangement`'s compact point exactly, the preflight surface exposes per-message token estimates and turn boundaries sufficient to compute whether any content would land in bands — not just a tail-token sum.

**AC-4.2** If LHC compact fails, the handler cancels PI compaction.
- TC-4.2a — Given an LHC compact that returns an error, when the handler runs, then it returns `{ cancel: true }` and the LHC view snapshot is unchanged.

**AC-4.3** The handler either returns an LHC compaction result or cancels; it never silently falls through to PI native compaction.
- TC-4.3a — Given compact handling for any reason, when the hook returns, then the result is either a compaction result with LHC band content or `{ cancel: true }` — never a return that lets PI proceed with its native summary compaction.

## Data Contracts

**LHC compact receipt (what pi-lhc reads from `threadView.compact`):**

The fields pi-lhc must use:

| Field | Type | Notes |
|-------|------|-------|
| `viewId` | `string` | Deterministic id of the new view snapshot |
| `profile` | `string \| null` | Profile used for selection (v1 hardcodes a profile; null mirrors the actual `CompactReceipt` shape when none resolves) |
| `config` | `ViewProfile["percentages"] & { lowerBound }` | The resolved budget configuration |
| `compactPoint` | `number` | Record-order position of the new tail start; zero if no bands |
| `coveredFrom` | `number` | Record-order start of the banded region |
| `bands` | `Record<Band, { entries, tokens }>` | Per-band entry count and token count (not rendered text) |
| `tailTokens` | `number` | Tokens in the tail |
| `totalTokens` | `number` | Band tokens + tail tokens |
| `degraded` | `Array<{ band, subjectId, usedDerivation }>` | Entries where a derivation was missing and fallback was used |
| `gaps` | `Array<{ band, subjectId, reason }>` | Coverage gaps |
| `warnings` | `Array<{ band, subjectId, derivationType, reason }>` | Fallback warnings |

**PI compaction result shape (what pi-lhc returns to PI):**

The exact mapping from the LHC receipt to PI's `{ summary, firstKeptEntryId, tokensBefore, details }` is a Tech Design decision (see Tech Design Questions). The epic-level contract is operator-visible: compact succeeded or was cancelled; if succeeded, the session shows compacted (banded) history followed by the kept tail, and PI's feedback line reports token counts.

## Dependencies

- LHC `threadView.compact(ref, opts)` — exists, tested.
- LHC no-op preflight surface — **required new capability.** `threadView.status` exposes a tail-token sum, derivation counts, and view health, but not the per-message token estimates and turn boundaries that `selectArrangement` walks to compute `compactPoint`. So status cannot predict a no-op exactly. Story 0 must add a read-only compact-preview / dry-run surface (e.g. expose `selectArrangement` in a read-only mode, or a dedicated `previewCompact` that returns the would-be compact point and band counts without writing).
- LHC `selectArrangement` — exists, tested; can return compact point zero (no-op) when history fits the full-tail budget (verified in source).
- PI `session_before_compact` hook with `reason` and `willRetry` fields — verified in PI source.
- PI fires `session_before_compact` after `agent_end` / before a new prompt, never mid-loop — verified (`shouldCompact` only called from post-run / pre-prompt sites).
- PI `appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook)` on `SessionManager` (including in-memory) — verified in PI source.
- pi-lhc closes the LHC turn at `agent_end` via `turn_end` — verified in pi-lhc source.
- pi-lhc active-thread resolution from session state — exists.

## NFRs

- **Determinism:** Compact must not perform inference. Band selection is a budget calculation over pre-computed derivations. Where a derivation is missing, LHC uses a deterministic degraded/fallback representation (stored member concat, message excerpt, or an available derivation fallback) rather than waiting for or generating one.
- **Performance:** Compact should complete in seconds, not minutes. Derivations are pre-computed in background mode; selection and rendering are local computation against the SQLite thread.
- **Cache-friendliness:** The compact window (upper bound → lower bound) should be tuned so compact fires infrequently. Each compact invalidates the prefix cache from the compact point forward. A larger window means less frequent compacts and less cache churn.
- **No partial view writes:** LHC's compact writes the view snapshot in a single transaction. A cancelled or failed compact leaves the view snapshot unchanged.

## Tech Design Questions

1. **Compact-point to firstKeptEntryId mapping.** LHC's compact point is a record-order position; PI's `firstKeptEntryId` is a PI session entry id. How is the coordinate translation computed, and what guarantees that the first tail entry in LHC corresponds to a real PI entry id in the current session?
2. **Band-to-summary assembly.** How is the set of bands assembled into the single `summary` string PI expects? Concatenation order, separators, and whether band-type labels are included. (The receipt reports band counts/tokens; rendered band text lives in thread-view storage, not the receipt.)
3. **Profile configuration.** Does pi-lhc pass `profile: "coding"` to `threadView.compact`, or pass explicit `params` (lowerBound + band percentages) with the coding values? The extension should own its default without requiring an LHC built-in profile rename.
4. **Derivation readiness at compact time.** Does the handler check derivation readiness and degrade, or always proceed with fallback? If a critical mass of derivations is pending/failed, should compact proceed or report degraded health?
5. **In-session view after compact.** After compact returns, PI shows its native `compactionSummary` message (containing LHC band text as the summary) plus kept tail entries. On next resume, LHC rebuilds its structured banded view from its DB. Is the in-session vs resume presentation difference acceptable for v1, or should compact trigger an immediate rehydrate to LHC's banded shape?
6. **Tail regrouping fidelity.** PI's `appendCompaction` keeps entries from `firstKeptEntryId` as-is. LHC's tail is regrouped into session-view messages on resume. Does the in-session kept-tail shape match the resume tail shape closely enough that the model does not see a content shift after resume?
7. **Preflight no-op surface.** AC-4.1 requires a read-only preflight that predicts `selectArrangement`'s compact point exactly. `threadView.status` does not expose enough (it returns a tail-token sum, not per-message estimates). Confirm whether the new surface is a read-only `selectArrangement` exposure, a dedicated `previewCompact`, or another read — and whether near-no-op (tiny band region) should also cancel.
8. **Operator-visible cancel reason surfacing.** PI's `SessionBeforeCompactResult` has no reason field. pi-lhc retains the `open_turn` diagnostic internally; how (or whether) to surface it to the operator in the TUI is Tech Design.

## Recommended Story Breakdown

### Story 0: Compact hook handler + result mapping

- **Governing idea:** Wire `session_before_compact` so that whenever PI fires compact — manual, threshold, or overflow — pi-lhc runs LHC's compact engine and maps the result into PI's compaction shape, or cancels on no-op/failure. One handler serves all three reasons; they differ only in PI's trigger and PI's post-compact action (manual shows feedback, threshold continues the agent, overflow retries).
- **Prerequisite:** None. The LHC engine and thread resolution exist.
- **Boundary / risk notes:** The compact-point to `firstKeptEntryId` mapping is the load-bearing technical detail (Tech Design Question 1). Story 0 must add a read-only compact-preview surface to LHC so the preflight no-op check (AC-4.1) can predict `selectArrangement` exactly — `threadView.status` does not expose enough. Overflow has a known limitation: if compact runs but does not reduce enough, PI's one-retry limit surfaces a recovery-failed error (AC-3.3). The handler must never silently fall through to PI native compaction (AC-4.3). No-op compacts are cancelled, not applied (AC-4.1).
- **Flows/ACs covered:** Flow 1 (AC-1.1 through AC-1.5), Flow 2 (AC-2.1 through AC-2.3), Flow 3 (AC-3.1 through AC-3.3), Flow 4 (AC-4.0, AC-4.0b), Cross-flow (AC-4.1 through AC-4.3).
- **Estimated test count:** ~19 tests (covers all flow + cross-flow ACs).

### Story 1: Trigger configuration

- **Governing idea:** Document and ship a sample `models.json` with `modelOverrides` capping `contextWindow` on large-context models so PI fires threshold compact at the desired point. Pure configuration plus documentation; no runtime code beyond what Story 0 already handles.
- **Prerequisite:** Story 0 (so the threshold hook is wired).
- **Boundary / risk notes:** The override changes only `contextWindow`; auth, baseUrl, cost, and reasoning stay on the built-in entry. The reserve tokens (default 16384) mean compact fires at `contextWindow − reserve`. The operator picks the cap per model.
- **Flows/ACs covered:** Supports AC-2.1 (the threshold trigger depends on the configured window).
- **Estimated test count:** 2 tests (sample config validates; override does not touch other model fields).

## Validation Checklist

- [ ] User Profile names the operator and the constraint (no split-brain, cache-friendly).
- [ ] Every flow has at least one AC; every AC has at least one TC.
- [ ] Non-goals are actively identified (status command, context hook, checkpoint/continuation, profile auto-selection, receipt UI, fidelity restoration).
- [ ] The three compact reasons (manual, threshold, overflow) each have dedicated ACs.
- [ ] Manual compact open-turn case has a functional rule (cancel with reason `open_turn`), not a Tech Design question.
- [ ] Resume-after-compact has an AC (LHC as source of truth on resume, durable history intact).
- [ ] No-op compact is detected as a preflight before LHC writes a snapshot.
- [ ] PI compact timing (fires after agent_end) is stated and verified; the turn-is-already-closed consequence drives the design.
- [ ] No split-brain: the handler returns an LHC result or cancels, never silently native (AC-4.3).
- [ ] Data contracts match the actual CompactReceipt shape (band counts/tokens, not rendered text).
- [ ] Tech design questions separate from functional ACs.
- [ ] No brochure language; every sentence describes behavior or placement.
