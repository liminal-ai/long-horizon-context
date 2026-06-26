# Tech Design: LHC Smart Compact (pi-lhc)

**Epic:** `02-pi-lhc/02-smart-compact/epic.md`
**Status:** Draft for review.
**Config:** A — `tech-design.md` + `test-plan.md`.

---

## Spec Validation

Every Tech Design Question from the epic is answered here. The design derives from those answers; if any were wrong the design would not stand.

| TDQ | Resolution | Status |
|-----|-----------|--------|
| 1. compact-point → `firstKeptEntryId` mapping | Identity-based, three-tier: live (idempotency_key → current-session entryId), seeded (seed-entry-map), else fail-closed cancel. No content matching. | Resolved — see §TDQ-1 |
| 2. Band-to-summary assembly | Concatenate stored band rendered text in `brief → detailed → smooth` order, each prefixed with a band header line. | Resolved — see §TDQ-2 |
| 3. Profile configuration | pi-lhc passes explicit `params` (the `coding` values), not a profile name, so it owns its default. | Resolved — see §TDQ-3 |
| 4. In-session view after compact | Acceptable for v1. PI's `CompactionSummaryMessage(summary)` + kept PI entries is content-equivalent to LHC's bands + tail. No immediate rehydrate. | Resolved — see §TDQ-4 |
| 5. Tail regrouping fidelity | Acceptable for v1. The kept PI entries are the recent live messages, which are the same content LHC regroups into the tail on resume. | Resolved — see §TDQ-5 |
| 6. Preflight no-op surface | New `threadView.previewCompact(ref, opts)` — a read-only carve-out of `compact()` that runs `readSelectionInputs` + `selectArrangement` and returns the would-be compactPoint + wouldProduceBands + first-tail-message identity, without resolving chunk materials or writing. | Resolved — see §TDQ-6 |
| 7. Operator-visible cancel reason | v1: pi-lhc retains the diagnostic code internally and writes a warning log line. Operator-visible TUI surfacing is deferred (PI has no reason field). | Resolved — see §TDQ-7 |
| 8. Abort signal forwarding | Yes. Forward `event.signal` to both `previewCompact` and `compact` so a mid-compact abort cancels the snapshot write. | Resolved — see §TDQ-8 |

Two epic terms are tightened, not contradicted:

- **Epic "preflight predicts compact point exactly"** — the preview runs the *same* `selectArrangement` the real compact runs, so compactPoint prediction is exact by construction. Band counts/tokens are not predicted (they require chunk materials); only compactPoint and wouldProduceBands (boolean). Resolved — clarified.
- **Epic "no LHC snapshot write on no-op cancel"** — the preview never opens the write path, so a no-op cancel provably leaves the snapshot unchanged. Resolved — clarified.

Two LHC surface additions are required (not schema changes; data already read at build time):

- `SessionThreadViewMessage` exposes `messageId` + `idempotencyKey` for tail messages. Internally these are already read from the DB (snapshot.ts:136-170) but stripped before returning.
- `compact`/`previewCompact` receipts return `firstKeptMessageId` — the messageId of the first message past the compact point. Derivable from existing `SelectionMessage` (carries `messageId` + `order`), trivially computed as `messages.find(m => m.order > compactPoint)`.

And one pi-lhc addition: a `CustomEntry` seed-entry-map written at every hydrate (startup + rehydrate), correlating LHC messageId to the generated PI entry id.

No Issues Found require a deviation flag. All eight TDQs are answered from source; none loop back to the BA.

---

## Context

A compact event is a single interception in PI's compaction flow. The narrative matters more than the interface list, because the load-bearing risk is in the *coordinate translation* between two systems that keep parallel records of the same conversation.

PI is the harness. It runs the agent loop, appends entries to its own `SessionManager` as messages arrive, and — after each agent run — checks whether context is over budget. When it is, PI emits `session_before_compact` to extensions and waits. The extension can hand back a replacement compaction result; PI appends it as a `compaction` entry, rebuilds `agent.state.messages`, and continues. PI's `appendCompaction` does not delete anything: `buildSessionContext` walks the entry tree, finds the latest `compaction`, emits its `summary` first, then the entries from `firstKeptEntryId` up to the compaction, then anything after. The pre-compaction entries remain in the tree, just not surfaced.

LHC is the source of truth for the durable record. pi-lhc captures PI's activity into an LHC thread as ordered events, and seeds PI's in-memory session from `threadView.getSessionThreadView` on startup and resume. So at compact time there are two records of the same conversation: PI's `SessionManager` entry tree (the live session), and LHC's thread (the durable record). They hold the same content in the same order, but use different coordinate systems — PI speaks in entry ids, LHC speaks in event-order positions and message ids.

The compact interception has one job: when PI asks for a compaction, run LHC's compact engine against the thread, then translate the result into PI's compaction shape so PI rebuilds a session that is content-equivalent to LHC's compacted view. The hard parts are (a) predicting whether a compact is a no-op without writing a snapshot, (b) translating LHC's compact point into a PI entry id, and (c) closing the identity gap between PI's session-scoped entry ids and LHC's durable message ids. The identity gap is the subtle one: PI regenerates entry ids on every hydrate, so the live-run's captured identity (idempotency key) only covers entries captured in the current session — entries seeded from LHC at startup need their own identity recording. Everything else wraps existing, tested LHC operations.

---

## System View

```
            session_before_compact { reason, willRetry, branchEntries, signal }
  PI ─────────────────────────────────────────────────────────────────────────► pi-lhc
                                                                                  │
   { cancel }  or  { compaction: { summary, firstKeptEntryId, tokensBefore } } ◄──┤
                                                                                  │
                          ┌───────────────────────────────────────────────────────┘
                          ▼
        ┌─────────────────────────────────────┐   ┌──────────────────────────────┐
        │ previewCompact(ref, {params, signal})│   │ compact(ref, {params, signal})│
        │  read-only: readSelectionInputs +    │   │  preview path + write path:  │
        │  chunk materials + selectArrangement │   │  replaceViewSnapshot +       │
        │  → CompactPreview (no write)         │   │  CompactReceipt              │
        └─────────────────────────────────────┘   └──────────────────────────────┘
                          │ LHC thread-view surface (new + existing)
                          ▼
                  LHC SQLite thread (~/.lhc/threads/<id>.sqlite)
```

**External contracts** are those in the epic's Data Contracts section and are not restated here. The two new internal contracts this design introduces are `CompactPreview` (LHC) and the `session_before_compact` handler return shape (pi-lhc), both defined in §Interface Definitions.

**Runtime prerequisites** (carried from epic assumptions, all Validated): PI fires the hook after `agent_end` for all three reasons; pi-lhc closes the LHC turn at `agent_end`; `appendCompaction` works on the in-memory `SessionManager`; PI rebuilds `agent.state.messages = buildSessionContext().messages` after `appendCompaction` without extension help.

**Verification commands** (this repo, as configured):

| Tier | Command | What it runs | Status |
|------|---------|--------------|--------|
| format | `pnpm run format:check` | biome format check | exists |
| lint | `pnpm run lint` | biome check | exists |
| typecheck | `pnpm run typecheck` | builds lhc, then `tsc --noEmit` across packages | exists |
| test | `pnpm run test` | lhc + pi-lhc vitest (excludes real-inference) | exists |
| **verify** | `pnpm run verify` | format:check + lint + typecheck + test | **standard gate** |
| verify:all | `pnpm run verify:all` | verify + lhc `test:integration` (real model calls) | exists; missing auth reports NOT-RAN loudly via the test's accounting path, never silent pass |
| red-verify | — | none | **does not exist** |
| green-verify | — | none | **does not exist** |

Red/Green phases use `pnpm run typecheck && pnpm run lint && pnpm run format:check` for red (compile + style), and `pnpm run verify` for green (full behavior). There is no separate red-verify script; this is stated explicitly so no implementer assumes one. The real-inference leg (`test:integration`) is included in `verify:all`; when provider auth is absent the test's module-load guard prints exactly one NOT-RAN line and runs an accounting assertion that records the not-ran state, so absence can never produce a silent pass.

---

## Module Boundaries

Two modules carry new code; everything else is wiring.

```
packages/lhc/src/thread-view/
  index.ts                  + previewCompact (new export)
  internal/
    compact-compute.ts      NEW — extracted: readSelectionInputs + chunk materials + selectArrangement
    select.ts               (unchanged: readSelectionInputs, selectArrangement)
    snapshot.ts             (unchanged: replaceViewSnapshot)

packages/pi-lhc/src/
  compact/
    handler.ts              NEW — session_before_compact handler: readiness → preflight → compact → map/cancel
    result-mapping.ts       NEW — CompactReceipt → SessionBeforeCompactResult; compactPoint → firstKeptEntryId
    preview-preflight.ts    NEW — wraps threadView.previewCompact, decides no-op cancel
  index.ts                  + register session_before_compact + session_compact handlers
```

**Responsibility matrix:**

| Concern | Owner | Why |
|---------|-------|-----|
| Predict the no-op read-only | LHC `previewCompact` | Must run the same `selectArrangement` the write runs; only LHC owns that function |
| Decide no-op cancel vs proceed | pi-lhc `preview-preflight` | PI flow concern; LHC should not know about PI's cancel |
| Run the snapshot write | LHC `compact` (existing) | Owned, tested, transactional |
| Translate compact point → PI entry id | pi-lhc `result-mapping` | Cross-system; LHC does not know PI entry ids |
| Assemble band text → summary | pi-lhc `result-mapping` | The summary is a PI contract (one string); assembly order is a PI-facing decision |
| Track compact diagnostic codes | pi-lhc `handler` | PI has no reason field; pi-lhc owns its diagnostics |

The split is deliberate: LHC stays host-neutral (knows nothing about PI entry ids or the `summary` string format), and pi-lhc owns the translation. This keeps drift in the extension, consistent with the project's harness-agnostic SDK stance.

---

## Flow-by-Flow Design

All three compact reasons share one handler. The handler is a sequence of decisions, each of which can short-circuit to a cancel. The flows differ only in what PI does after the handler returns.

### The shared handler sequence

```
session_before_compact(event) {
  thread ← resolveActiveThread(event)
  if thread = none: return { cancel } (code: no_thread)

  flushPendingCapture()                                    // AC-5.5a
  if !turnIsCompactReady(thread):                          // AC-1.5, AC-5.5b
    return { cancel } (code: open_turn)

  preview ← threadView.previewCompact(thread, { params, signal: event.signal })   // AC-5.1c
  if preview.error: return { cancel } (code: compact_error)                       // AC-5.2
  if !preview.wouldProduceBands: return { cancel } (code: no_op)                // AC-5.1

  result ← mapFirstTailToEntryId(preview, thread, event.branchEntries)    // TDQ-1
  if result.mappingFailed: return { cancel } (code: mapping_failed)        // AC-5.2 — cancel BEFORE compact writes

  receipt ← threadView.compact(thread, { params, signal: event.signal })    // AC-5.4, AC-5.6
  if !receipt.ok: return { cancel } (code: compact_error)                  // AC-5.2

  compaction ← assembleCompactionResult(receipt, result.firstKeptEntryId, event.preparation.tokensBefore)   // TDQ-2, TDQ-3
  return { compaction }                                                   // AC-5.3 — never falls through
}
```

The handler **always** returns either `{ compaction }` or `{ cancel }`. There is no code path that returns `undefined`, which is what would let PI proceed with its native summary compaction (AC-5.3). The diagnostic `code` is retained in a per-session compact-diagnostics buffer and written to the warning log; it is not returned to PI because PI's `SessionBeforeCompactResult` has no reason field (TDQ-7).

**Readiness check (AC-1.5 / AC-5.5b).** `turnIsCompactReady` reads the LHC turn state. An open turn with no captured members is compact-ready (there is nothing to lose). An open turn with members is not — this is the defensive case where the abort/`agent_end`/capture path failed silently. In the normal path the turn is already closed by `agent_end`, so the check passes and proceeds. The same runtime check serves AC-1.5 (manual) and AC-5.5b (silent capture failure): the open-turn-with-activity state has two causes, one check.

### Per-flow deltas

**Flow 1 — manual.** PI calls `abort()` + `waitForIdle()`, which completes the current agent run (including `agent_end`), then emits `session_before_compact` with `reason: "manual"`. The turn is closed before the hook fires; the handler proceeds normally. After the handler returns a compaction result, PI appends it, rebuilds messages, and renders its native compact feedback line (AC-1.4). The operator sees token numbers; pi-lhc renders nothing.

**Flow 2 — threshold.** After `agent_end`, PI's `_checkCompaction` computes context tokens and, if `shouldCompact` is true, emits `session_before_compact` with `reason: "threshold"`. The turn the just-completed run populated is already closed, so it is compact-eligible (AC-2.3) — the selection may place it in a band or keep it in the full tail based on budget. PI continues the agent after compact.

**Flow 3 — overflow.** The model returns a context-overflow error; the run ends (`agent_end`); pi-lhc closes the turn. PI removes the error assistant message from agent state and emits `session_before_compact` with `reason: "overflow"`, `willRetry: true`. The handler runs the same path. PI retries once. The `_overflowRecoveryAttempted` flag in PI guarantees at most one retry: if the retry overflows again, PI emits `compaction_end` with an overflow-recovery-failed message and does not loop (AC-3.3). pi-lhc does not need to enforce the retry limit — PI already does, in `_checkCompaction`.

### Flow 4 — Resume after compact

No new code in the compact handler. Resume uses the existing `seedPiSessionFromLhc` → `getSessionThreadView` path, now also writing the seed-entry-map (TDQ-1). Because compact replaced the view snapshot (bands + compact point) and never touched recorded events, resume hydrates PI from LHC's compacted view (AC-4.1) and the durable history is intact (AC-4.2). The seed-entry-map written at resume correlates the new PI entry ids for the next compact's mapper.

---

## Interface Definitions

### LHC: `threadView.previewCompact` (new)

```ts
export interface CompactPreview {
  /** Would-be compact point; 0 means selection produced no bands (no-op). */
  compactPoint: number;
  /** Whether any arrangement entry landed in a band. False ⟺ no-op. */
  wouldProduceBands: boolean;
  /** Tokens in the would-be tail. */
  tailTokens: number;
  /** messageId of the first message past the compact point; used by the mapper. */
  firstKeptMessageId: string;
}

export function previewCompact(
  ref: ThreadRef,
  opts: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
): Promise<OpResult<CompactPreview>>;
```

`previewCompact` runs `readSelectionInputs` + `selectArrangement` (the compactPoint path, which needs no chunk materials) and returns the preview fields without writing. A canonical-corruption error returns `{ ok: false, error: { errorClass: "state_corruption", ... } }` exactly as `compact` does. Because it runs the same compactPoint computation as `compact`, its `compactPoint` is byte-identical to the subsequent `compact`'s — prediction is exact by construction (AC-5.1c).

The implementation is a refactor, not a duplication: extract `compact()`'s read-and-select body (lines roughly 295–343 of `thread-view/index.ts`) into `internal/compact-compute.ts` as `computeArrangement(db, merged, signal): OpResult<{ selection, inputs, viewId, firstKeptMessageId }>`. `compact` continues from there (chunk fallback + write + receipt); `previewCompact` returns the preview.

### LHC: `turns.turnIsCompactReady` (new, small)

```ts
export function turnIsCompactReady(db: DatabaseSync): { ready: boolean; openTurnHasMembers: boolean };
```

A read-only check used by the pi-lhc readiness gate. LHC maintains exactly one open turn as an invariant. `ready` is true when the open turn has zero members; `ready` is false when the open turn has members. This is one `SELECT` against the turn/member tables; the logic already exists implicitly inside `readSelectionInputs`'s corruption check. Placed in LHC (host-neutral) because "thread is in a state where compact won't drop open-turn activity" is a host-neutral question.

### pi-lhc: `mapFirstTailToEntryId`

```ts
export interface FirstTailMapping {
  firstKeptEntryId: string;   // a real branchEntry id
  origin: "live" | "seeded";  // for diagnostics
}

export function mapFirstTailToEntryId(
  firstKeptMessageId: string,
  sessionView: SessionThreadView,   // exposes idempotencyKey + messageId on tail entries
  seedEntryMap: LhcSeedEntryMap | null,
  branchEntries: readonly SessionEntry[],
  currentPiSessionId: string,
): { mappingFailed: true } | FirstTailMapping;
```

Resolves per the three-tier rule in TDQ-1. Never content-matches; fails closed if neither the live key nor the seed map resolves.

### pi-lhc: `assembleCompactionResult`

```ts
export interface PiCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;   // from event.preparation.tokensBefore
  details: unknown;       // the CompactReceipt
}

export function assembleCompactionResult(
  receipt: CompactReceipt,
  firstKeptEntryId: string,
  tokensBefore: number,    // from event.preparation.tokensBefore
): { summary: string; tokensBefore: number; details: CompactReceipt };
```

`summary` is the band text assembled per TDQ-2. `tokensBefore` comes from PI's preparation, not the receipt. `details` carries the full receipt for provenance.

### pi-lhc: seed-entry-map (CustomEntry)

Written at every hydrate by `applySessionThreadViewToSessionManager`. Correlates LHC `messageId` → generated PI entry id. Rebuilt (superseded) on every hydrate. Used by `mapFirstTailToEntryId` for the seeded tier.

### pi-lhc: handler registration

```ts
pi.on("session_before_compact", onBeforeCompact);
pi.on("session_compact", onAfterCompact);  // logging only
```

`onAfterCompact` records that the compact landed (for diagnostics); it performs no session mutation.

---

## TDQ Answers in Depth

The two deep sections are TDQ-1 and TDQ-6; the rest are stated compactly because they resolve without architectural risk.

### TDQ-1: compact-point → firstKeptEntryId mapping

**The problem.** LHC's `compactPoint` is an event-order position snapped to a turn boundary. PI's `firstKeptEntryId` is a PI `SessionManager` entry id. For the model's view to be coherent, the kept PI entries must be the recent messages — i.e., LHC's tail.

**Why this is genuinely cross-system.** At compact time PI provides `event.branchEntries` (the PI entry tree, with ids) and `event.preparation.tokensBefore`. pi-lhc also has the LHC compact result. The two records were built differently: PI entries from the **seed** (loaded from LHC at startup, with PI-generated ids pi-lhc does not currently store) and from the **live run** (PI's own appends, captured into LHC with idempotency keys that encode the PI entry id).

**The identity gap.** Verified: PI regenerates entry ids on every hydrate, and the seed path (`serving/context.ts:121`) calls `appendMessage` which returns a new PI entry id, but pi-lhc never writes that id back. So an LHC message can be in the PI branch under an id the LHC record has no record of. This is the core gap any mapping must close.

**The three-tier mapper.** Compact/preview return `firstKeptMessageId` — the messageId of the first message past the compact point. The session-view entries now expose `idempotencyKey` alongside `messageId` (a surface addition — the data is already read at build time, snapshot.ts:136-170). The mapper resolves as follows:

```
firstKeptMessageId → look up idempotencyKey on the matching session-view entry
  │
  ├── key present and parses with the CURRENT session's piSessionId → LIVE
  │     parseEventKeySource(key) → entryId, used directly (it is in branchEntries)
  │
  ├── key absent, or parses with a PRIOR session's piSessionId → SEEDED
  │     look up messageId in the seed-entry-map (see below)
  │     if piEntryId present in branchEntries → use it
  │     else → cancel mapping_failed
  │
  └── neither resolves → cancel mapping_failed
```

Identity-based at every tier. No content matching. Fail-closed if neither resolves.

**The seed-entry-map.** Written **once**, after all seeded messages have been appended at a hydrate (startup + rehydrate), as a single `CustomEntry` of type `pi-lhc.seed-entry-map`, correlating LHC `messageId` → generated PI entry id for every seeded message. The map is built by collecting `(lhcMessageId, piEntryId)` as `applySessionThreadViewToSessionManager` appends each seeded message, then writing one custom entry with the full array after the loop completes. It is NOT appended per-message, so it never interleaves between content.

`appendCustomEntry` advances the PI branch leaf (verified: `_appendEntry` sets `leafId = entry.id` on every append, session-manager.js:671). So the custom entry is part of the branch path, not passive metadata. Two constraints make this safe: (a) exactly one map entry, appended after the seeded content, advances the leaf once at the hydration boundary; (b) the mapper never returns the custom entry's id — `firstKeptEntryId` is always a real message/model/thinking entry id being kept. The map is rebuilt (a new entry supersedes) on every hydrate; the newest is authoritative.

```ts
type LhcSeedEntryMap = {
  customType: "pi-lhc.seed-entry-map";
  threadId: string;
  entries: Array<{
    lhcMessageId: string;
    piEntryId: string;
  }>;
};
```

**The ordering invariant (no LHC write on mapping failure).** The handler runs `previewCompact` (read-only), then `mapFirstTailToEntryId` against the preview's `firstKeptMessageId`, then cancels BEFORE calling `compact` if mapping fails. Only after a successful mapping does `compact` write the snapshot. So a mapping failure provably leaves the LHC snapshot unchanged. The `firstKeptMessageId` from preview and compact are byte-identical (same `selectArrangement`), so mapping against the preview is sound.

**Why no content matching.** Content collision is a real failure mode (repeated user prompts, templated assistant replies) and produces silent false-positive matches — the worst outcome at a compaction boundary. Identity-based with fail-closed is safer: the only fail case is a genuinely missing marker, which indicates a capture bug, not a content coincidence. Fail-closed is rare in practice (markers are written at every hydrate; live keys cover the current run).

### TDQ-6: previewCompact surface

**The problem.** `threadView.status` returns a tail-token *sum*, derivation counts, and view health — but not the per-message token estimates and turn boundaries that `selectArrangement` walks to compute `compactPoint`. So `status` cannot predict a no-op. AC-5.1c requires exact prediction of the compact point.

**The decision.** `previewCompact` runs the read-and-select path of `compact`, minus the chunk-material resolution and the write. The architecture already supports this cleanly: `readSelectionInputs(db)` is a pure read function (SELECTs only, no transaction), and `selectArrangement(inputs, opts)` is a pure function over those inputs — "no DB handle, no clock, no inference: same inputs, same arrangement." The write lives in `replaceViewSnapshot`; the chunk-material resolution lives in the `compactChunkMaterials` loop. `previewCompact` calls neither.

**Why compactPoint prediction is exact.** The compactPoint computation (select.ts Rule 1) walks message tokens and turn boundaries — neither depends on chunk materials. Because `previewCompact` and `compact` share the same `readSelectionInputs` + `selectArrangement` calls, their `compactPoint` values are byte-identical. Prediction is exact by construction.

**What preview returns (and does not).** Authoritative fields: `compactPoint`, `wouldProduceBands` (boolean — whether any arrangement entry landed in a band), `tailTokens`, and `firstKeptMessageId` (the messageId of the first message past the compact point, used by the TDQ-1 mapper). It does NOT return band counts/tokens or rendered band text — those require chunk materials, which belong to `compact`'s rendering. The no-op signal is `wouldProduceBands === false` (equivalently `compactPoint === 0`), which holds without materials.

**Near-no-op.** A compact that produces a tiny band region (one small entry in `brief`) is **not** a no-op and is **not** cancelled — it writes a real, small compaction. Cancelling near-no-ops would discard legitimately-selected content. The cancel boundary is strictly `wouldProduceBands === false`.

**Refactor shape.** Extract `compact()`'s body from `openThreadDatabase` through `selectArrangement` into `computeArrangement(db, merged, signal)`, returning `{ selection, inputs, viewId, firstKeptMessageId }` or an `OpResult` error. `compact` continues with chunk-fallback logging, `replaceViewSnapshot`, and receipt assembly. `previewCompact` stops after `computeArrangement` and returns `CompactPreview`. The corruption-refusal semantics are identical (pre-write refusal, nothing written).

### TDQ-2: band-to-summary assembly

Bands are assembled in `brief → detailed → smooth` order (oldest-most-compressed first, building toward the tail). Each band's stored rendered text is prefixed with a header line: `## Context (band: <type>)`. The bands are joined with a blank line separator. The full assembly is a single string passed as PI's `summary`, which PI wraps in a `CompactionSummaryMessage`. Band-type labels are included so the model can distinguish summary strata from live content. This is a PI-facing presentation decision and lives in pi-lhc.

### TDQ-3: profile configuration

pi-lhc passes explicit `params` — `{ lowerBound: 120000, percentages: { full: 0.25, smooth: 0.35, detailed: 0.20, brief: 0.20 } }` (the `coding` values) — to both `previewCompact` and `compact`. It does **not** pass a profile name. This means the extension owns its default without depending on or renaming an LHC built-in, and the receipt's `profile` field will be `null` (explicit params override), which the contract already permits.

`tokensBefore` for the PI result comes from `event.preparation.tokensBefore` — PI's pre-compaction context token count — NOT from the LHC receipt. The receipt's `totalTokens` is LHC's assembled-view total, a different number. Verified in PI source (compaction.d.ts:105, computed as `estimateContextTokens(buildSessionContext(pathEntries).messages)`).

### TDQ-4: in-session view after compact

After the handler returns a compaction result, PI appends a `compaction` entry and rebuilds `agent.state.messages` as `[CompactionSummaryMessage(summary)] + [entries from firstKeptEntryId]`. The summary is LHC's band text; the kept entries are the recent live messages. On resume, PI rebuilds from LHC's `getSessionThreadView`, which renders bands as user-context lines plus the tail. The two shapes differ in presentation (a single summary message vs. structured band lines) but are content-equivalent. v1 accepts this difference. An immediate rehydrate after compact (via `session_compact`) would make the shapes identical but requires tearing down and rebuilding the session mid-loop while the agent holds references — risky inside the compact flow. Deferred.

### TDQ-5: tail regrouping fidelity

The kept PI entries (recent live messages) are the same content LHC regroups into the tail on resume. PI's native message structure (assistant message with ordered text/thinking/tool-call parts; tool results as tool-result entries) and LHC's regrouped session-view (user / assistant-with-parts / toolResult) describe the same activity. There is no content shift across resume. v1 accepts the structural difference.

### TDQ-7: operator-visible cancel reason

PI's `SessionBeforeCompactResult` is `{ cancel?: boolean; compaction?: CompactionResult }` — no reason field. Verified in source. pi-lhc retains each cancel's diagnostic `code` (`open_turn`, `no_op`, `compact_error`, `no_thread`, `mapping_failed`) in a per-session buffer and writes a `warning`-level log line. No TUI surfacing in v1. The `session_compact` event confirms a successful compact landed (used to clear the buffer). Surfacing the code to the operator is a future TUI feature and is not gated by anything in this design.

### TDQ-8: abort signal forwarding

The hook event carries `signal` (an `AbortController` signal from PI's `_autoCompactionAbortController`). Both `previewCompact` and `compact` accept a `signal` parameter that short-circuits their loops (`compactStopped(opts.signal)` checks). The handler forwards `event.signal` to both. A mid-compact abort cancels before the snapshot write (`compact` checks `compactStopped` at the assembly points and before `replaceViewSnapshot`). The preview is read-only so an abort there is a no-op read cancel.

---

## Functional-to-Technical Traceability

| Epic AC | Implemented by | Notes |
|---------|----------------|-------|
| AC-1.1 (manual runs LHC compact) | handler runs `compact` on `reason: "manual"` | TC-1.1a |
| AC-1.2 (snapshot replaced) | `compact` → `replaceViewSnapshot` | TC-1.2a |
| AC-1.3 (PI messages rebuilt) | PI native `buildSessionContext` after `appendCompaction` | TC-1.3a |
| AC-1.4 (operator sees compact line) | PI native feedback; pi-lhc renders nothing | TC-1.4a |
| AC-1.5 (open-turn cancel) | `turnIsCompactReady` gate | TC-1.5a/b/c |
| AC-2.1 (threshold triggers LHC compact) | handler on `reason: "threshold"` | TC-2.1a |
| AC-2.2 (threshold == manual effect) | shared handler | TC-2.2a |
| AC-2.3 (closed turn is eligible) | turn closed at `agent_end` before hook | TC-2.3a |
| AC-2.4 (below threshold sends full context) | PI native; `modelOverrides` only changes trigger | TC-2.4a |
| AC-3.1 (overflow runs LHC compact) | handler on `reason: "overflow"` | TC-3.1a |
| AC-3.2 (PI retries compacted) | PI native `willRetry` path | TC-3.2a |
| AC-3.3 (no loop on insufficient reduction) | PI native `_overflowRecoveryAttempted` | TC-3.3a |
| AC-4.1 (resume hydrates compacted view) | existing `seedPiSessionFromLhc` + seed-entry-map | TC-4.1a/b |
| AC-4.2 (durable history intact) | `compact` writes snapshot only | TC-4.2a |
| AC-5.1 (no-op preflight cancel) | `previewCompact` + cancel | TC-5.1a/b/c |
| AC-5.2 (compact-failure cancel) | error → cancel | TC-5.2a/b |
| AC-5.3 (never native fallback) | handler always returns `compaction` or `cancel` | TC-5.3a |
| AC-5.4 (degraded derivations proceed) | `compact` fallback path | TC-5.4a/b/c |
| AC-5.5 (capture flush + readiness) | `flushPendingCapture` + `turnIsCompactReady` | TC-5.5a/b |
| AC-5.6 (first and subsequent compacts) | `compact` rebuilds from durable record | TC-5.6a/b |

Full TC → test-file mapping is in `test-plan.md`.

---

## Testing Strategy

**Pyramid:** unit (pure functions: mapper, preview-wouldProduceBands, band assembly) at the base; integration (handler against a real temp SQLite thread + a fake PI hook context) in the middle; no end-to-end real-model layer in the standard gate.

**Mock rule — mock at the boundary, never between own modules.** The boundary is the PI hook surface (`session_before_compact` entry, `branchEntries`, `signal`) on the input side and the LHC SDK surface (`previewCompact`, `compact`, `turnIsCompactReady`) on the dependency side. The handler, the preflight wrapper, `mapFirstTailToEntryId`, and `assembleCompactionResult` are exercised against real temp SQLite threads and real (extracted) LHC functions — they are not mocked internally. A test that mocks `selectArrangement` separately from `previewCompact` is forbidden: it would hide the exactness guarantee that is the whole point of TDQ-6. The mapper's three-tier resolution is tested with real `branchEntries`, real `sessionView` entries (carrying the new identity fields), and real seed-entry-map construction.

**Filesystem is the product contract — use real temp storage.** The atomicity, no-op-unchanged-snapshot, and resume-durability tests assert on real SQLite state, not mocked storage. pi-lhc already has `makeTempThread` / `tempStore` fixtures; the LHC side has its view-boundary fixtures. These are reused.

**Verification scripts** are the table in §System View. Red phase = `typecheck && lint && format:check`. Green phase = `pnpm run verify`. The standard gate is `verify`. The real-inference leg runs under `verify:all`; missing auth surfaces as a loud NOT-RAN, never a silent pass.

**Architecture-risk tests** (full list in `test-plan.md`): atomicity/rollback (no-op and failure leave snapshot unchanged), concurrency/lost-update (capture flush ordering), threshold/budget (preview matches compact — the exactness golden), source-vs-derived (resume parity, durable integrity), idempotency/retry (overflow one-retry), persistence/restart (resume after compact). Fixture validity, migration/compatibility, and event ordering are scanned and omitted as not applying.

---

## Work Breakdown

### Chunk 0 — LHC previewCompact + readiness + session-view identity

**Governing idea:** extract `computeArrangement` from `compact`, expose `previewCompact`, `turnIsCompactReady`, and `messageId`/`idempotencyKey` on `SessionThreadViewMessage`. This is the foundation: pi-lhc Chunk 1 cannot implement AC-5.1, AC-1.5, or TDQ-1 without them.

- **Skeleton:** add `internal/compact-compute.ts` with `computeArrangement` (returns `firstKeptMessageId`); refactor `compact` to call it; add `previewCompact` and `turnIsCompactReady` exports; expose `messageId` + `idempotencyKey` on `SessionThreadViewMessage`.
- **Red:** `pnpm run typecheck && pnpm run lint && pnpm run format:check` passes after refactor (no behavior change to `compact`).
- **Green:** `pnpm run verify` passes including new tests: preview compactPoint == compact compactPoint (exactness golden, multiple corpus sizes), no-op detection (`wouldProduceBands === false`), preview writes no snapshot, near-no-op not cancelled, `turnIsCompactReady` member/empty cases, session-view entries carry `messageId` + `idempotencyKey`.
- **ACs supported:** AC-5.1c, AC-1.5, AC-5.5b.
- **Tests:** ~12.

### Chunk 1 — pi-lhc handler, preflight, mapper, seed-entry-map

**Governing idea:** the `session_before_compact` handler implementing the shared sequence, with `preview-preflight` (no-op cancel), `mapFirstTailToEntryId` (TDQ-1 three-tier), `assembleCompactionResult` (TDQ-2/3), and the seed-entry-map written at every hydrate.

- **Skeleton:** add `compact/handler.ts`, `compact/preview-preflight.ts`, `compact/result-mapping.ts`, `compact/seed-entry-map.ts`; register handlers in `index.ts`; write seed-entry-map in `seed-session.ts` and `rehydrate.ts`.
- **Red:** typecheck/lint/format pass; handler stubs return `{ cancel }` with the diagnostic codes.
- **Green:** `pnpm run verify` passes including: manual/threshold/overflow each run LHC compact (AC-1.1/2.1/3.1); no-op cancel leaves snapshot unchanged (AC-5.1b); compact-failure cancel (AC-5.2); open-turn cancel (AC-1.5a); mapping success for live entry (idempotency-key tier) and seeded entry (seed-map tier); mapping-failed cancel leaves no snapshot write; band assembly order (TDQ-2); `tokensBefore` from `event.preparation.tokensBefore` (TDQ-3); seed-entry-map written at startup and rehydrate; resume parity after compact (AC-4.1/4.2); overflow one-retry (AC-3.3).
- **ACs supported:** AC-1.1–1.5, AC-2.1–2.3, AC-3.1–3.3, AC-4.1–4.2, AC-5.1–5.6.
- **Tests:** ~22.

### Chunk 2 — trigger configuration

**Governing idea:** sample `models.json` with `modelOverrides` capping `contextWindow`; documentation. No runtime code.

- **Skeleton:** add `docs/specs/02-pi-lhc/02-smart-compact/models.example.json` and a short README section.
- **Red/Green:** `pnpm run verify` (config is not code; verification is a schema-validation test that the override shape is accepted and does not touch unrelated fields).
- **ACs supported:** AC-2.1 (threshold depends on configured window), AC-2.4.
- **Tests:** ~2.

---

## Open Questions

1. **Seed-map retention across compacts.** The seed-entry-map is rebuilt on every hydrate and used for the next compact. After a compact within a session (no hydrate), the live-run entries captured since the compact are identity-covered, but the post-compact tail entries in PI (PI's native kept entries) may not be — though the next compact's `firstKeptMessageId` will typically resolve via the live idempotency-key tier. Confirm this holds for the compact-after-compact-without-hydrate case; if not, the map may need extension to cover PI's kept entries.
2. **`session_compact` buffer clearing.** The per-session compact-diagnostics buffer (TDQ-7) is cleared on `session_compact`. If a compact is cancelled, the buffer holds the code until the next successful compact or session end. Confirm this retention window is acceptable or shorten it.
3. **`modelOverrides` per-profile.** The epic defers profile auto-selection by model. Chunk 2 ships one override. Whether a 1M-context model needs a different `contextWindow` cap than a 200k model is a dogfooding finding, not a design question.
4. **`runtime_note` first-tail message (live only).** A live `runtime_note` (captured from PI runtime state without a PI entry) has no PI entry to map, so the mapper fails closed (`mapping_failed`). A *seeded* `runtime_note` — if `applySessionThreadViewToSessionManager` maps it to a PI entry at hydrate time — carries a seed-entry-map record and resolves via the seed tier. Confirm whether `runtime_note` is seeded as a real PI entry (then it resolves) or skipped (then a live `runtime_note` first-tail cancels). v1 should either seed it as a PI message or skip to the next message with a PI equivalent.

---

## Deferred Items

- **Pressure checkpoint / mid-turn compact** (epic Appendix A). Out of scope; this design responds only to PI-fired compacts. The long-single-run scenario is caught reactively by overflow recovery.
- **Context hook re-introduction.** Out of scope; serving is SessionManager-seeding.
- **`/lhc-status` command.** Out of scope; debugging is direct SDK inspection.
- **`runtime_note` / `bashExecution` PI-session mapping fidelity.** Out of scope for the *mapper*'s live path — a live `runtime_note` (captured without a PI entry) cannot map and fails closed. A seeded `runtime_note` resolves via the seed-entry-map if hydration maps it to a PI entry. `runtime_note` remains fully in the durable record and LHC tail regardless. `bashExecution` fidelity is similarly out of scope.
- **Operator-visible cancel reason in the TUI.** Deferred (TDQ-7).
- **Identity-based turn marker for mapping.** Resolved as part of TDQ-1 — the seed-entry-map provides identity for seeded entries; live entries use idempotency keys. No longer deferred.
