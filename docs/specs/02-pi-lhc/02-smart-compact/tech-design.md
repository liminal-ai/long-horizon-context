# Tech Design: LHC Smart Compact

**Epic:** `epic.md`
**Test Plan:** `test-plan.md`
**Config:** A — two docs.

---

## Spec Validation

Every TDQ from the epic is answered here. The design derives from those answers.

| TDQ | Resolution | Status |
|-----|-----------|--------|
| 1. compact-point → `firstKeptEntryId` | Three-tier identity mapper: live (idempotency_key → current-session entryId), seeded (seed-entry-map), else fail-closed cancel. No content matching. | Resolved — §TDQ-1 |
| 2. Band-to-summary assembly | Concatenate `renderedBands` (now on `CompactReceipt`) in brief → detailed → smooth order, each prefixed `[context · <band>]`. | Resolved — §TDQ-2 |
| 3. Profile configuration | pi-lhc passes explicit `params` (`default-initial` values); receipt `profile` is `null` (explicit params override). | Resolved — §TDQ-3 |
| 4. In-session view after compact | v1 accepts the difference. PI's `CompactionSummaryMessage(summary)` + kept entries is content-equivalent to LHC's bands + tail. No immediate rehydrate. | Resolved — §TDQ-4 |
| 5. Tail regrouping fidelity | v1 accepts. Kept PI entries are the recent live messages — same content LHC regroups into the tail on resume. | Resolved — §TDQ-5 |
| 6. Preflight no-op surface | New `threadView.previewCompact` — read-only carve-out of `compact()`'s read-and-select path. Returns compactPoint + wouldProduceBands + firstKeptMessageId, no write. | Resolved — §Preflight Surface, §TDQ-6 |
| 7. Operator-visible cancel reason | v1: pi-lhc retains the diagnostic code in a per-session buffer + warning log; PI's `SessionBeforeCompactResult` has no reason field. Surfacing via `ctx.ui.notify` is a small follow-up. | Resolved — §TDQ-7 |
| 8. Abort signal forwarding | Yes. Forward `event.signal` to both `previewCompact` and `compact`. | Resolved — §TDQ-8 |

**Epic assumptions validated:**

| Assumption | Resolution |
|-----------|-----------|
| PI fires the hook after `agent_end` for all three reasons | Validated — PI source: `_checkCompaction` only post-run / pre-prompt |
| pi-lhc closes the LHC turn at `agent_end` | Validated — pi-lhc `onAgentEnd` |
| `appendCompaction` works on in-memory `SessionManager` | Validated — `SessionManager.inMemory` + `appendCompaction` |
| PI rebuilds `agent.state.messages = buildSessionContext().messages` after `appendCompaction` | Validated — agent-session.js ~1326 |

**Two epic clarifications (not contradictions):**

- **"Preflight predicts compact point exactly"** — preview runs the same `selectArrangement` as compact, so compactPoint prediction is exact by construction. Band counts/tokens are not predicted (chunk materials not resolved); only `compactPoint`, `wouldProduceBands`, `firstKeptMessageId` are authoritative. Resolved — clarified.
- **"No LHC snapshot write on no-op cancel"** — preview never opens the write path, so no-op cancel provably leaves `thread_view` unchanged. Resolved — clarified.

**Issue noted (out of epic scope):** orphaned `buildContextServePreview` / `ContextServeMessagePreview` / `CONTEXT_SERVE_PREVIEW_*` in `pi-lhc/src/serving/context.ts` and its test are dead code from the removed context hook. Cleanup pass, not blocking.

No Issues Found require a deviation flag.

---

## Context

A compact event is a single interception in PI's compaction flow. The narrative matters more than the interface list, because the load-bearing risk is in the **coordinate translation** between two systems that keep parallel records of the same conversation.

PI is the harness. It runs the agent loop, appends entries to its `SessionManager` as messages arrive, and — after each agent run — checks whether context is over budget. When it is, PI emits `session_before_compact` and waits. The extension returns either a replacement compaction result or a cancel. PI's `appendCompaction` does not delete anything: `buildSessionContext` walks the entry tree, finds the latest `compaction`, emits its `summary` first, then entries from `firstKeptEntryId` up to the compaction, then anything after. Pre-compaction entries remain in the tree, just not surfaced.

LHC is the source of truth for the durable record. pi-lhc captures PI activity into an LHC thread as ordered events, and seeds PI's in-memory session from `threadView.getSessionThreadView` on startup and resume. At compact time there are two records of the same conversation in different coordinate systems — PI speaks in entry ids, LHC speaks in event-order positions and message ids.

The compact interception has one job: when PI asks for a compaction, run LHC's compact engine, then translate the result into PI's compaction shape so PI rebuilds a session that is content-equivalent to LHC's compacted view. The hard parts are (a) predicting whether a compact is a no-op without writing a snapshot, (b) translating LHC's compact point into a PI entry id, and (c) closing the identity gap between PI's session-scoped entry ids and LHC's durable message ids.

The identity gap is the subtle one and the decisive design question. PI regenerates entry ids on every hydrate. The seed path (`serving/context.ts:121`) calls `appendMessage` which returns a new PI entry id, but pi-lhc never writes that id back. So a live-run's captured identity (the idempotency key, `pi:<piSessionId>:entry:<entryId>...`) only covers entries captured in the *current* session — entries seeded from LHC at startup carry the *prior* session's id in their key, which matches nothing in the current `branchEntries`. Any mapping design that relies on the idempotency key alone fails on the common case: resume a thread, run a turn, compact fires, the first kept tail message is seeded → no identity → mapping fails → no compaction. This is why the design adds a seed-entry-map (TDQ-1).

Everything else wraps existing, tested LHC operations.

---

## System View

### System Context

```
PI Agent Harness
├── Agent loop (model calls, tool execution)
├── Session Manager (in-memory entry tree, branch persistence)
├── Compaction check (_checkCompaction after agent_end / before prompt)
└── Extension hook: session_before_compact { reason, willRetry, branchEntries, signal, preparation }
          │
          ▼
pi-lhc Extension
├── Compact handler (new — wires session_before_compact)
├── Capture pipeline (existing — records PI → LHC)
├── Turn accumulator (existing — closes LHC turn at agent_end)
├── Session seeding (existing — hydrates PI from LHC; now also writes seed-entry-map)
└── Seed-entry-map (new — correlates LHC messageId → PI entry id at every hydrate)
          │
          ▼
LHC SDK
├── threadView.previewCompact() (new — read-only selection preview)
├── threadView.compact() (existing — selection + snapshot write; now returns renderedBands)
├── threadView.getSessionThreadView() (existing — bands + tail for resume; now exposes sourceMessages identity metadata)
└── threadView.status() (existing — tail tokens, derivation health)
```

### Data Flow: Compact

```
PI fires session_before_compact { reason, willRetry, branchEntries, signal, preparation }
    │
    ▼
pi-lhc compact handler
    ├── 1. resolve active LHC thread
    ├── 2. flushPendingCapture()
    ├── 3. previewCompact(ref, { params, signal })
    │         → turn_not_ready? cancel (open_turn)
    │         → error? cancel (compact_error)
    │         → wouldProduceBands false? cancel (no_op)
    │         → firstKeptMessageId null? cancel (mapping_failed)
    ├── 4. mapFirstKeptToEntryId(preview.firstKeptMessageId, sessionView, seedEntryMap, branchEntries, currentPiSessionId)
    │         → mapping_failed? cancel BEFORE compact writes
    ├── 5. threadView.compact(ref, { params, signal })   ← snapshot write only happens here
    ├── 6. assembleCompactionResult(receipt, firstKeptEntryId, event.preparation.tokensBefore)
    │         summary = receipt.renderedBands concatenated brief → detailed → smooth
    │         firstKeptEntryId = from step 4
    │         tokensBefore = event.preparation.tokensBefore   ← NOT receipt.totalTokens
    │         details = receipt
    └── return { compaction }
    │
PI: appendCompaction → buildSessionContext → agent.state.messages rebuilt
PI: show compact feedback line
```

**External contracts** are those in the epic's Data Contracts. The new internal contracts this design introduces (`CompactPreview`, `CompactReceipt` additions, the seed-entry-map, the handler return) are defined in §Interface Definitions.

---

## Module Boundaries

### Top-Tier Surfaces

| Surface | Source | This Epic's Role |
|---------|--------|-----------------|
| pi-lhc connector | Inherited (Epic 1) | Adds compact hook handler, seed-entry-map writing |
| LHC thread-view | Inherited (LHC SDK) | Adds `previewCompact` (incl. readiness); extends `CompactReceipt` and `SessionThreadViewEntry` |

### Module Architecture

```
packages/lhc/src/
├── thread-view/
│   ├── index.ts                 MODIFIED  previewCompact(); extend compact() to return renderedBands + firstKeptMessageId; fold readiness into preview
│   └── internal/
│       ├── compact-compute.ts   NEW       extracted readSelectionInputs + selectArrangement (shared by preview + compact)
│       ├── select.ts            UNCHANGED readSelectionInputs, selectArrangement
│       └── snapshot.ts          UNCHANGED replaceViewSnapshot
└── shared-tech/
    └── view.ts                  MODIFIED  PreviewCompactResult + PreviewCompactOutcome, renderedBands + firstKeptMessageId on CompactReceipt, sourceMessages on SessionThreadViewEntry

packages/pi-lhc/src/
├── compact/                     NEW
│   ├── handler.ts               NEW       session_before_compact handler: readiness → preview → map → compact → assemble
│   ├── result-mapping.ts        NEW       mapFirstKeptToEntryId (three-tier) + assembleCompactionResult
│   └── profile.ts               NEW       DEFAULT_COMPACT_PROFILE constant
├── capture/
│   └── idempotency.ts           UNCHANGED parseEventKeySource (used by mapper)
├── serving/
│   └── context.ts               MODIFIED  applySessionThreadViewToSessionManager collects + writes seed-entry-map CustomEntry
└── index.ts                     MODIFIED  register session_before_compact + session_compact handlers
```

### Module Responsibility Matrix

| Module | Status | Responsibility | ACs Covered |
|--------|--------|----------------|-------------|
| `compact/handler.ts` | NEW | Hook handler: flush → readiness → preview → map → compact → assemble → return/cancel | AC-1.1–1.5, 2.1–2.4, 3.1–3.3, 5.1–5.6 |
| `compact/result-mapping.ts` | NEW | Three-tier `mapFirstKeptToEntryId` + `assembleCompactionResult` | AC-1.2, 1.3; TDQ-1, TDQ-2, TDQ-3 |
| `compact/profile.ts` | NEW | `DEFAULT_COMPACT_PROFILE` constant | supports all compact ACs |
| `serving/context.ts` | MODIFIED | Writes one seed-entry-map CustomEntry after seeding loop | TDQ-1 seed tier |
| `index.ts` (connector) | MODIFIED | Registers `session_before_compact` + `session_compact` | AC-1.1 |
| `thread-view/index.ts` | MODIFIED | `previewCompact` (incl. readiness); `compact` returns renderedBands + firstKeptMessageId | AC-5.1, AC-5.6, AC-1.5 |
| `shared-tech/view.ts` | MODIFIED | `PreviewCompactResult` + `PreviewCompactOutcome`; `renderedBands` + `firstKeptMessageId` on `CompactReceipt`; `sourceMessages` on `SessionThreadViewEntry` | type foundation |

**Deliberate split:** LHC stays host-neutral — it knows nothing about PI entry ids, the `summary` string format, or the seed-entry-map. pi-lhc owns the translation. This keeps drift in the extension, consistent with the project's harness-agnostic SDK stance.

---

## Preflight Surface

AC-5.1 requires that no-op compacts are detected before LHC writes a snapshot. `threadView.status()` returns `tailTokens` and `compactRecommended` — a coarse threshold signal — and cannot predict whether `selectArrangement` would produce `compactPoint > 0` (it lacks per-message token estimates and turn boundaries).

### Interface

```typescript
// shared-tech/view.ts
export interface PreviewCompactResult {
  /** Would-be compact point; 0 ⟺ selection produced no bands. */
  compactPoint: number;
  /** Whether any arrangement entry landed in a band. false ⟺ no-op. */
  wouldProduceBands: boolean;
  /** Tokens in the would-be tail. */
  tailTokens: number;
  /** messageId of the first PI-mappable kept entry past the compact point.
   *  Present iff wouldProduceBands === true AND a mappable entry exists.
   *  Null on no-op, or on a non-no-op where no kept entry has a PI representation
   *  (degenerate; handler cancels mapping_failed). */
  firstKeptMessageId: string | null;
}

// sdk.ts ThreadViewSurface — readiness is folded INTO previewCompact,
// not a separate turns-turnIsCompactReady surface, so pi-lhc never imports
// internals or opens an LHC DB handle.
export type PreviewCompactOutcome =
  | { kind: "ok"; preview: PreviewCompactResult }
  | { kind: "turn_not_ready"; openTurnHasMembers: boolean }
  | { kind: "error"; reason: string };

previewCompact(
  ref: ThreadRef,
  opts: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
): Promise<OpResult<PreviewCompactOutcome>>;
```

Readiness is part of the preview call, not a separate SDK method. pi-lhc passes a `ThreadRef` (which it already has) and receives either a preview, a `turn_not_ready` outcome, or an error — no `DatabaseSync` handle exposed and no internal import. The readiness check itself (open turn has zero members → ready) is the same logic, just owned behind the `previewCompact` boundary. A separate `turns.turnIsCompactReady(db)` surface is unnecessary — pi-lhc would need to import LHC internals or hold a DB handle, neither of which is acceptable.

### Implementation

`previewCompact` follows the same read-and-select path as `compact()` through `readSelectionInputs` and `selectArrangement`, but skips chunk-material resolution and the snapshot write. It runs the compactPoint computation only (which needs no chunk materials), and returns the preview fields.

```
previewCompact(ref, opts):
  1. resolve ref, open DB (same as compact)
  2. validate profile/params (same as compact)
  3. check open-turn readiness:
       if open turn has members → close DB, return { kind: "turn_not_ready", openTurnHasMembers: true }
  4. readSelectionInputs(db)                ← read-only; no chunk materials
       if canonical corruption → close DB, return { kind: "error", reason }
  5. selection ← selectArrangement(inputs, merged)
  6. close DB
  7. return { kind: "ok", preview: {
       compactPoint: selection.compactPoint,
       wouldProduceBands: selection.compactPoint > 0,
       tailTokens: tailTokenSum(db, selection.compactPoint),
       firstKeptMessageId: firstPiMappableMessagePast(db, selection.compactPoint),
     }}
```

The implementation is a refactor, not duplication: extract `compact()`'s read-and-select body into `internal/compact-compute.ts` as `computeArrangement(db, merged, signal): OpResult<{ selection, inputs, viewId, firstKeptMessageId }>`. `compact` continues with chunk-fallback logging, `replaceViewSnapshot`, and receipt assembly; `previewCompact` returns the preview.

### Exactness and what preview does NOT return

Because `previewCompact` and `compact` share `computeArrangement`, their `compactPoint` is byte-identical — prediction is exact by construction. Preview does **not** return band counts/tokens or rendered band text (those require chunk materials, which belong to `compact`). `wouldProduceBands` is `compactPoint > 0`, which holds without materials. The cancel boundary is strictly `wouldProduceBands === false`; a near-no-op (one small brief entry) is **not** cancelled.

---

## Flow-by-Flow Design

All three compact reasons share one handler. The handler is a sequence of decisions, each able to short-circuit to a cancel. The flows differ only in what PI does after the handler returns.

### The shared handler sequence

```
handleSessionBeforeCompact(event):
  thread ← resolveActiveThread(event)
  if thread = none: return { cancel } (code: no_thread)

  flushPendingCapture()                                  // AC-5.5a

  outcome ← threadView.previewCompact(thread, { params: DEFAULT_COMPACT_PROFILE, signal: event.signal })
  if !outcome.ok: return { cancel } (code: compact_error)               // AC-5.2
  switch outcome.value.kind:
    case "turn_not_ready": return { cancel } (code: open_turn)         // AC-1.5, AC-5.5b
    case "error":          return { cancel } (code: compact_error)     // AC-5.2
    case "ok":
      preview ← outcome.value.preview
      if !preview.wouldProduceBands: return { cancel } (code: no_op)   // AC-5.1
      if preview.firstKeptMessageId == null: return { cancel } (code: mapping_failed)  // degenerate

  mapping ← mapFirstKeptToEntryId(preview.firstKeptMessageId, sessionView, seedEntryMap,
                                   event.branchEntries, currentPiSessionId)
  if mapping.mappingFailed: return { cancel } (code: mapping_failed)    // BEFORE compact writes — AC-5.2

  receipt ← threadView.compact(thread, { params: DEFAULT_COMPACT_PROFILE, signal: event.signal })
  if !receipt.ok: return { cancel } (code: compact_error)               // AC-5.2

  compaction ← assembleCompactionResult(receipt.value, mapping.firstKeptEntryId, event.preparation.tokensBefore)
  return { compaction }                                                // AC-5.3 — never falls through
```

The handler **always** returns `{ compaction }` or `{ cancel }` — never `undefined`, which is what would let PI proceed with its native summary compaction (AC-5.3). The diagnostic `code` is retained in a per-session compact-diagnostics buffer and written to a warning log; it is not returned to PI (PI's result shape has no reason field — TDQ-7).

**Readiness folded into preview (AC-1.5 / AC-5.5b).** LHC maintains exactly one open turn as an invariant. `previewCompact` returns `turn_not_ready` when the open turn has members (the defensive case where the abort/`agent_end`/capture path failed silently) and proceeds to the selection otherwise. One boundary call replaces two; pi-lhc never imports LHC internals. The same runtime check serves AC-1.5 (manual) and AC-5.5b (silent capture failure): the open-turn-with-activity state has two causes, one outcome.

**Map-before-compact ordering.** Mapping runs against `preview.firstKeptMessageId` and cancels **before** `compact` is called. Because `firstKeptMessageId` is byte-identical between preview and compact (shared `computeArrangement`), mapping against the preview is sound. A mapping failure provably leaves `thread_view` unchanged — `compact` never opens its write transaction.

### Per-flow deltas

**Flow 1 — manual.** PI calls `abort()` + `waitForIdle()`, which completes the current agent run (including `agent_end`), then emits `session_before_compact` with `reason: "manual"`. The turn is closed before the hook fires. After the handler returns a compaction result, PI appends it, rebuilds messages, renders its native compact feedback line (AC-1.4). pi-lhc renders nothing.

**Flow 2 — threshold.** After `agent_end`, PI's `_checkCompaction` computes context tokens and, if `shouldCompact` is true, emits `session_before_compact` with `reason: "threshold"`. The turn the just-completed run populated is already closed, so it is compact-eligible (AC-2.3) — selection may place it in a band or keep it in the full tail based on budget. PI continues the agent after compact. Below threshold, PI sends full context; `modelOverrides` only changes the trigger point (AC-2.4).

**Flow 3 — overflow.** The model returns a context-overflow error; the run ends (`agent_end`); pi-lhc closes the turn. PI removes the error assistant message from agent state and emits `session_before_compact` with `reason: "overflow"`, `willRetry: true`. The handler runs the same path. PI retries once. The `_overflowRecoveryAttempted` flag guarantees at most one retry: if the retry overflows again, PI emits `compaction_end` with an overflow-recovery-failed message and does not loop (AC-3.3). pi-lhc does not enforce the retry limit — PI already does.

**Flow 4 — Resume after compact.** No new compact-handler code. Resume uses the existing `seedPiSessionFromLhc` → `getSessionThreadView` path, now also writing the seed-entry-map (TDQ-1). Because compact replaced the view snapshot (bands + compact point) and never touched recorded events, resume hydrates PI from LHC's compacted view (AC-4.1) and the durable history is intact (AC-4.2). The seed-entry-map written at resume correlates the new PI entry ids for the next compact's mapper.

---

## Interface Definitions

### LHC: `threadView.previewCompact` (new)

See §Preflight Surface.

### LHC: `CompactReceipt` additions

```typescript
export interface CompactReceipt {
  // ... existing fields (viewId, profile, config, bands, tailTokens, totalTokens, coveredFrom, compactPoint, degraded, gaps, warnings) ...
  /** Rendered band text in gradient order (brief → detailed → smooth). Empty array for no-op. */
  renderedBands: Array<{ band: Band; text: string }>;
  /** messageId of the first PI-mappable kept entry past the compact point; null when compactPoint is 0 (no-op) or no mappable entry exists. */
  firstKeptMessageId: string | null;
}
```

`renderedBands` is the band text `compact` already assembles during write; returning it on the receipt gives the handler its source for PI's `summary` without a second DB read. The current `CompactReceipt` has neither field — both are added by this design. `firstKeptMessageId` is also on the receipt for diagnostics/parity; the handler maps from **preview's** `firstKeptMessageId` so mapping happens before the write.

`renderedBands` is a non-optional field. Compact always assembles the text (it writes `thread_view_band` rows); returning it costs nothing extra and removes the question of where the handler gets its `summary` source. Resolved Design Question 1 confirms this is decided (always return, not opt-in).

### LHC: `SessionThreadViewEntry` identity additions

**Why this is non-trivial: assistant grouping.** The session-view groups multiple LHC messages into one PI entry. `assistant_thinking` + `assistant_text` + `tool_call` (all from one assistant turn) collapse into a single assistant entry with `parts: [{thinking}, {text}, {toolCall}]` (session-view.ts:84–114). The current `assistantPartOf` drops the source `messageId` entirely — it emits only text/thinking/toolCallId. So a top-level `messageId` on the assistant entry cannot represent the source messages; identity would be destroyed. The seed-entry-map must therefore be keyed by **every represented LHC message id**, not one id per entry.

```typescript
// shared-tech/view.ts — identity per entry at the granularity the mapping needs.

// Identity carried on every session-view entry. For entries that map 1:1 to one LHC
// message (user, tool_result, model_change, thinking_level_change), `sourceMessages`
// has exactly one row. For assistant entries (which group thinking + text + tool_call),
// `sourceMessages` has one row per source LHC message, in part order.
export interface SessionThreadViewEntrySource {
  messageId: string;              // LHC message id
  idempotencyKey: string | null;  // live key, or null only when genuinely unavailable
}

// Added to: SessionUserMessage, SessionAssistantMessage, SessionToolResultMessage,
// SessionModelChangeEntry, SessionThinkingLevelChangeEntry.
// On SessionAssistantMessage the field is:
//   sourceMessages: SessionThreadViewEntrySource[]   // one per part
// On the 1:1 entry kinds it is a single-element array (or the same single object).
```

LHC already reads `messageId` and `idempotency_key` per source message during the tail build (snapshot.ts:136–170); the addition threads them through `assistantPartOf` (which currently strips them) and onto the entries. `idempotencyKey` is `null` only when genuinely unavailable (e.g., a recorded event with no key) — seeded entries still carry their **prior-session** key, not null.

### pi-lhc: `mapFirstKeptToEntryId` (new)

```typescript
export interface FirstKeptMapping {
  firstKeptEntryId: string;       // a real branchEntry id (never a custom-entry id)
  origin: "live" | "seeded";      // for diagnostics
}

export function mapFirstKeptToEntryId(
  firstKeptMessageId: string,
  sessionView: SessionThreadView,  // entries carry sourceMessages (1 per LHC message for assistants)
  seedEntryMap: LhcSeedEntryMap | null,
  branchEntries: readonly SessionEntry[],
  currentPiSessionId: string,
): { mappingFailed: true; reason: string } | FirstKeptMapping;
```

Three-tier resolution per TDQ-1. Never content-matches; fails closed if no tier resolves. Because assistant entries group multiple LHC messages, the mapper walks `entry.sourceMessages` (not a single top-level `messageId`) to find the matching one: locate the session-view entry whose `sourceMessages` includes `firstKeptMessageId`, then resolve by tier from that entry's identity.

### pi-lhc: `assembleCompactionResult` (new)

```typescript
export interface PiCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;   // from event.preparation.tokensBefore — NOT receipt.totalTokens
  details: CompactReceipt;
}

export function assembleCompactionResult(
  receipt: CompactReceipt,
  firstKeptEntryId: string,
  tokensBefore: number,
): { summary: string; tokensBefore: number; details: CompactReceipt };
```

`summary` assembled per TDQ-2. `details` carries the full receipt for provenance.

### pi-lhc: seed-entry-map (CustomEntry)

```typescript
type LhcSeedEntryMap = {
  customType: "pi-lhc.seed-entry-map";
  threadId: string;
  // ONE ROW PER REPRESENTED LHC MESSAGE, not per session-view entry.
  // An assistant entry that groups m10/m11/m12 produces three rows pointing at
  // the single PI entry id it was seeded as.
  entries: Array<{ lhcMessageId: string; piEntryId: string }>;
};
```

Written **once**, after all seeded messages have been appended at a hydrate (startup + rehydrate), as a single `CustomEntry`. Built by walking each session-view entry's `sourceMessages` and recording `(messageId, piEntryId)` for every row, where `piEntryId` is the id returned by the `appendMessage` / `appendModelChange` / `appendThinkingLevelChange` call that seeded that entry. A 3-part assistant entry contributes 3 rows. **Not** appended per-message, so it never interleaves between content.

`appendCustomEntry` advances the PI branch leaf (verified: `_appendEntry` sets `leafId = entry.id`, session-manager.js:671). So the custom entry is part of the branch path, not passive metadata. Two constraints make this safe: (a) exactly one map entry, appended after the seeded content, advances the leaf once at the hydration boundary; (b) the mapper never returns the custom entry's id — `firstKeptEntryId` is always a real message/model/thinking entry id being kept. The map is rebuilt on every hydrate; the newest is authoritative.

This per-source-message shape is what preserves the three-tier mapper across assistant grouping: any LHC `messageId` the compact point lands on — even one buried inside an assistant entry's parts — has a seed-map row pointing at the PI entry id it was hydrated into.

### pi-lhc: handler registration

```typescript
pi.on("session_before_compact", onBeforeCompact);
pi.on("session_compact", onAfterCompact);  // clears the compact-diagnostics buffer; logging only
```

---

## TDQ Answers in Depth

### TDQ-1: compact-point → firstKeptEntryId mapping

**The problem.** LHC's `compactPoint` is an event-order position snapped to a turn boundary. PI's `firstKeptEntryId` is a PI `SessionManager` entry id. For the model's view to be coherent, the kept PI entries must be the recent messages — i.e., LHC's tail.

**Why this is genuinely cross-system.** At compact time PI provides `event.branchEntries` (PI entry tree, with ids) and `event.preparation.tokensBefore`. The two records were built differently: PI entries from the **seed** (loaded from LHC at startup, with PI-generated ids pi-lhc does not currently store) and from the **live run** (PI's own appends, captured into LHC with idempotency keys that encode the PI entry id).

**The identity gap (the decisive point).** Verified: PI regenerates entry ids on every hydrate, and the seed path (`serving/context.ts:121`) calls `appendMessage` which returns a new PI entry id, but pi-lhc never writes that id back. So an LHC message can be in the PI branch under an id the LHC record has no record of. The live-run's idempotency key covers only current-session entries — seeded entries' keys reference the *prior* session. Any live-only mapping design fails on resume-then-compact.

**The live tier** uses a direct SQL read of the first **PI-mappable** content event's idempotency key past the compact point. Not every LHC message kind maps to a PI branch entry — `runtime_note` has no PI equivalent — so the walk skips it:

```sql
SELECT idempotency_key FROM event
WHERE event_order > :compactPoint
  AND event_kind IN ('user_prompt','assistant_text','assistant_thinking','tool_call','tool_result','model_change','thinking_level_change')
ORDER BY event_order LIMIT 1
```

If this returns no row (the only kept entries are `runtime_note`), preview returns `firstKeptMessageId: null` with `wouldProduceBands: true`, and the handler cancels `mapping_failed` (degenerate). In practice the kept region starts with a real message because the open turn was opened by a user prompt.

**The three-tier mapper.** `firstKeptMessageId` is PI-mappable by construction (preview skips non-mappable kinds). The session-view entries expose `sourceMessages` (identity per represented LHC message; see §SessionThreadViewEntry identity) — `idempotencyKey` lives on each source row, not a single top-level field, so assistant-grouped entries keep identity for every grouped message. The mapper resolves as follows:

```
firstKeptMessageId → locate the session-view entry whose `sourceMessages` array contains it
  → take that entry's identity row (the matching `sourceMessages[i]`)
  │
  ├── that row's idempotencyKey present and parses with the CURRENT session's piSessionId → LIVE
  │     parseEventKeySource(key) → entryId
  │     if entryId in branchEntries → use it
  │     else → cancel mapping_failed (stale branch)
  │
  ├── key absent, or parses with a PRIOR session's piSessionId → SEEDED
  │     look up firstKeptMessageId in seed-entry-map (one row per represented LHC message)
  │     if piEntryId present in branchEntries → use it
  │     else → cancel mapping_failed
  │
  └── neither resolves → cancel mapping_failed
```

Identity-based at every tier. No content matching. Fail-closed if neither resolves. The check `source?.entryId === undefined → cancel` covers non-entry identities (`{ toolCallId }`, `{ responseId }`, fingerprint key) — these cannot map to PI's `firstKeptEntryId` and fail fast.

**Why no content matching.** Content collision is a real failure mode (repeated user prompts, templated assistant replies) and produces silent false-positive matches — the worst outcome at a compaction boundary. Identity-based with fail-closed is safer: the only fail case is a genuinely missing marker, which indicates a capture bug, not a content coincidence.

**Seed-map validity across compacts within a session.** PI's `appendCompaction` keeps entries by id; a seeded entry kept through a compact retains its id and remains resolvable via the map. A compact that bands past all seeded entries means the first-kept message is no longer seeded, so the map is irrelevant for that compact. No extension needed across the session.

**`runtime_note` first-tail (decided).** A live `runtime_note` has no PI entry equivalent. If the first tail message is a `runtime_note`, the mapper advances `firstKeptMessageId` to the next message with a PI equivalent (excluded from the live-tier SQL above). This keeps compaction available rather than failing closed on a non-content boundary message. A seeded `runtime_note` resolves via the seed tier if hydration maps it to a PI entry; if not, it is similarly skipped.

### TDQ-6: previewCompact surface

See §Preflight Surface. The decisive design property: prediction is exact by construction because preview and compact share `computeArrangement`. `threadView.status` is explicitly insufficient (returns a tail-token sum, not per-message estimates), so the preview surface is a **required new capability**, not an optimization. Readiness is folded into the preview call (returns `turn_not_ready` when the open turn has members) rather than exposed as a separate `turns.turnIsCompactReady(db)` surface, so pi-lhc passes a `ThreadRef` and never imports LHC internals or opens a DB handle.

### TDQ-2: band-to-summary assembly

PI expects a single `summary` string. LHC stores rendered band text in `thread_view_band`; `compact()` now returns it on `receipt.renderedBands` in gradient order (brief → detailed → smooth). The handler assembles:

```
[context · brief]
{brief band text}

[context · detailed]
{detailed band text}

[context · smooth]
{smooth band text}
```

This matches the `[context · band]` prefix `getSessionThreadView` uses on resume, so the in-session and resume views carry equivalent content. Empty bands are omitted.

### TDQ-3: profile configuration + tokensBefore

pi-lhc passes explicit `params` (`DEFAULT_COMPACT_PROFILE` constant) — `{ lowerBound: 120000, percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 } }` (the `default-initial`/`coding` values) — to both `previewCompact` and `compact`. It does not pass a profile name. The receipt's `profile` field is `null` (explicit params override), which the contract permits. The extension owns its default without depending on or renaming an LHC built-in.

`tokensBefore` for the PI result comes from `event.preparation.tokensBefore` — PI's pre-compaction context token count — **not** from the receipt. `receipt.totalTokens` is LHC's assembled-view total, a different number. Verified in PI source (compaction.d.ts:105; computed as `estimateContextTokens(buildSessionContext(pathEntries).messages)`).

### TDQ-4: in-session view after compact

After the handler returns a compaction result, PI appends a `compaction` entry and rebuilds `agent.state.messages` as `[CompactionSummaryMessage(summary)] + [entries from firstKeptEntryId]`. The summary is LHC's band text; the kept entries are the recent live messages. On resume, PI rebuilds from `getSessionThreadView`, which renders bands as `[context · band]` user-context lines plus the tail. The two shapes differ in presentation (single summary message vs structured band lines) but are content-equivalent. v1 accepts this. An immediate rehydrate after compact would make the shapes identical but requires tearing down and rebuilding the session mid-loop while the agent holds references — risky inside the compact flow. Deferred.

### TDQ-5: tail regrouping fidelity

The kept PI entries (recent live messages) are the same content LHC regroups into the tail on resume. PI's native message structure (assistant message with ordered text/thinking/tool-call parts; tool results as tool-result entries) and LHC's regrouped session-view (user / assistant-with-parts / toolResult) describe the same activity. No content shift across resume. v1 accepts the structural difference.

### TDQ-7: operator-visible cancel reason

PI's `SessionBeforeCompactResult` is `{ cancel?: boolean; compaction?: CompactionResult }` — no reason field. Verified in source. v1: pi-lhc retains each cancel's diagnostic `code` (`open_turn`, `no_op`, `compact_error`, `no_thread`, `mapping_failed`) in a per-session buffer and writes a `warning`-level log line. `onAfterCompact` clears the buffer when a successful compact lands (else it holds until session end). A small follow-up surfaces the code via `ctx.ui.notify(message, "warning")` when `ctx.hasUI`; not gated by anything in this design.

### TDQ-8: abort signal forwarding

The hook event carries `signal` (an `AbortSignal` from PI's `_autoCompactionAbortController`). Both `previewCompact` and `compact` accept `signal: { aborted: boolean }`; the handler wraps the PI signal: `{ get aborted() { return event.signal.aborted; } }`. A mid-compact abort cancels before the snapshot write (`compact` checks `compactStopped` at assembly points and before `replaceViewSnapshot`).

---

## Deterministic Algorithm Boundaries

### selectArrangement compact-point prediction

The preflight must predict `selectArrangement`'s compact point exactly. Deterministic rules:

1. **Full-budget walk:** messages newest-first, summing `tokenEstimate`. When the sum first reaches `fullBudget = lowerBound * full / 100`, the crossing message is identified.
2. **Budget never reached:** sum never reaches budget → `compactPoint = 0` (no-op).
3. **Snap to turn boundary:** the crossing message's turn determines the snap. If the message is the turn's oldest → snap to previous turn's close. If mid-turn → snap to the turn's close (the partially-covered turn falls whole to bands).
4. **Open-turn messages:** always land in the tail regardless of budget.

**Golden cases (fixed inputs → exact expected outputs):**

| Case | Turns | Messages | Profile | Expected compactPoint | Expected wouldProduceBands |
|------|-------|----------|---------|----------------------|---------------------------|
| All fits | 3 closed, 1 open | 6 messages, 1000 tokens each | `default-initial` (fullBudget = 30000) | 0 | false |
| Two turns banded | 5 closed, 1 open | 12 messages, 5000 tokens each (60000 total) | `default-initial` (fullBudget = 30000) | turn 3's closedAt | true |
| Single large turn | 1 closed (50000 tokens), 1 open | 1 closed turn's messages | `default-initial` (fullBudget = 30000) | 0 | false (single turn fits full) |

The preview must reproduce these exactly, because it shares `computeArrangement` with `compact`.

---

## Functional-to-Technical Traceability

| Epic AC | Implemented by | TC |
|---------|----------------|----|
| AC-1.1 (manual runs LHC compact) | handler runs `compact` on `reason: "manual"` | TC-1.1a |
| AC-1.2 (snapshot replaced) | `compact` → `replaceViewSnapshot` | TC-1.2a |
| AC-1.3 (PI messages rebuilt) | PI native `buildSessionContext` after `appendCompaction` | TC-1.3a |
| AC-1.4 (operator sees compact line) | PI native feedback; pi-lhc renders nothing | TC-1.4a |
| AC-1.5 (open-turn cancel) | `previewCompact` readiness outcome (`turn_not_ready`) | TC-1.5a/b/c |
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
| AC-5.5 (capture flush + readiness) | `flushPendingCapture` + `previewCompact` readiness outcome | TC-5.5a/b |
| AC-5.6 (first and subsequent compacts) | `compact` rebuilds from durable record | TC-5.6a/b |

Full TC → test-file mapping in `test-plan.md`.

---

## Testing Strategy

**Pyramid:** unit (pure functions: three-tier mapper, preview-wouldProduceBands, band assembly, identity-key parsing) at the base; integration (handler against a real temp SQLite thread + a fake PI hook context) in the middle; no end-to-end real-model layer in the standard gate.

**Mock rule — mock at the boundary, never between own modules.** The boundary is the PI hook surface (`session_before_compact` entry, `branchEntries`, `signal`) on the input side and the LHC SDK surface (`previewCompact`, `compact`) on the dependency side. The handler, the preflight wrapper, `mapFirstKeptToEntryId`, and `assembleCompactionResult` are exercised against real temp SQLite threads and real (extracted) LHC functions — never mocked internally. A test that mocks `selectArrangement` separately from `previewCompact` is forbidden: it hides the exactness guarantee that is the whole point of TDQ-6. The mapper's three-tier resolution is tested with real `branchEntries`, real `sessionView` entries (carrying `sourceMessages`), and real seed-entry-map construction.

**Filesystem is the product contract — use real temp storage.** Atomicity, no-op-unchanged-snapshot, mapping-failure-no-write, and resume-durability tests assert on real SQLite state, not mocked storage. pi-lhc reuses `makeTempThread` / `tempStore`; LHC reuses its view-boundary fixtures.

**Verification scripts** are the table in `test-plan.md`. Red phase = `typecheck && lint && format:check`. Green phase = `pnpm run verify`. The standard gate is `verify`. The real-inference leg runs under `verify:all`; missing auth surfaces as a loud NOT-RAN, never a silent pass.

**Architecture-risk tests** (full list in `test-plan.md`): atomicity/rollback, concurrency/lost-update, threshold/budget (the exactness golden), source-vs-derived (resume parity, durable integrity, seed-map validity), idempotency/retry, persistence/restart. Fixture validity, migration/compatibility, and event ordering scanned and omitted.

---

## Work Breakdown

### Chunk 0 — LHC foundation: preview + readiness + identity + receipt

**Scope:** `computeArrangement` extraction, `previewCompact` (incl. readiness outcome), `renderedBands` + `firstKeptMessageId` on `CompactReceipt`, `sourceMessages` on `SessionThreadViewEntry`. Foundation for all pi-lhc work.

**ACs supported:** AC-5.1c, AC-1.5, AC-5.5b, TDQ-1/2/6 type foundation.

**Deliverables:** `internal/compact-compute.ts`, `previewCompact` export, `view.ts`/`sdk.ts` surface additions.

**Architecture-risk tests:** preview/compact compactPoint agreement (exactness golden); golden cases; no-op prediction; `previewCompact` `turn_not_ready` outcome for empty-open-turn vs open-turn-with-members.

**Test count:** ~12.

### Chunk 1 — pi-lhc handler + three-tier mapper + seed-entry-map

**Scope:** `session_before_compact` handler, `mapFirstKeptToEntryId`, `assembleCompactionResult`, `DEFAULT_COMPACT_PROFILE`, seed-entry-map writing (one row per represented LHC message) in `applySessionThreadViewToSessionManager`, hook registration.

**ACs supported:** AC-1.1–1.5, 2.1–2.4, 3.1–3.3, 4.1–4.2, 5.1–5.6.

**Architecture-risk tests:** three-tier identity (live/seed/fail-closed); summary format parity with `getSessionThreadView`; never-undefined; abort signal forwarding; map-before-compact no-write; seed-map validity across compact.

**Test count:** ~30. See test-plan.md Chunk 1 for detailed breakdown.

### Chunk 2 — trigger configuration

**Scope:** sample `models.json` with `modelOverrides` capping `contextWindow`; documentation. No runtime code.

**ACs supported:** AC-2.1, AC-2.4.

**Test count:** ~2.

**Total across all chunks:** ~44. See test-plan.md for reconciliation.

**Chunk dependencies:** 0 → 1 → 2.

---

## Resolved Design Questions

| # | Question | Decision |
|---|----------|----------|
| 1 | Should `renderedBands` be opt-in on `CompactReceipt`? | **Always return.** Compact is infrequent; the text is already assembled during write and would otherwise be discarded. |
| 2 | Should the handler fail-closed or skip when the first kept event key is a non-entry identity (`{ toolCallId }`, fingerprint)? | **Fail-closed** (`source?.entryId === undefined → cancel`). `runtime_note` first-tail is the one exception: advance to the next mappable message. |
| 3 | Seed-map retention across compacts within a session | **No extension needed.** PI keeps entries by id; kept seeded entries remain resolvable. Compacts that band past seeded entries make the map irrelevant for that compact. |
| 4 | Operator-visible cancel-reason surfacing | **v1: log + buffer.** `ctx.ui.notify` is a small follow-up, not gated. |

---

## Deferred Items

- **Pressure checkpoint / mid-turn compact** (epic Appendix A). Out of scope; this design responds only to PI-fired compacts. The long-single-run scenario is caught reactively by overflow recovery.
- **Context hook re-introduction.** Out of scope; serving is SessionManager-seeding.
- **`/lhc-status` command.** Out of scope; debugging is direct SDK inspection.
- **`bashExecution` PI-session mapping fidelity.** Out of scope; `runtime_note` is handled (skip-on-first-tail), `bashExecution` is not.
- **Post-compact rehydrate for in-session/resume shape parity** (TDQ-4/5). Deferred; v1 accepts content-equivalence.
- **`buildContextServePreview` dead-code cleanup.** Noted, not this epic.
