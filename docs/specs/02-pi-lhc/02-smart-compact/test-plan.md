# Test Plan: LHC Smart Compact

**Tech design:** `tech-design.md`
**Epic:** `epic.md`
**Config:** A — paired with `tech-design.md`.

## Purpose

Maps every TC from Epic 2 to a test, defines architecture-risk tests, and organizes tests into chunks matching the work breakdown.

---

## Verification Tiers

| Tier | Command | Coverage |
|------|---------|----------|
| format | `pnpm run format:check` | biome format |
| lint | `pnpm run lint` | biome check |
| typecheck | `pnpm run typecheck` | lhc build + `tsc --noEmit` (src + test) |
| test | `pnpm run test` | lhc + pi-lhc vitest, excludes real-inference |
| **verify** (standard gate) | `pnpm run verify` | format + lint + typecheck + test |
| verify:all | `pnpm run verify:all` | verify + lhc real-inference (`test:integration`) |
| red phase | `pnpm run typecheck && pnpm run lint && pnpm run format:check` | compile + style only |
| green phase | `pnpm run verify` | full behavior |
| per-package | `pnpm --filter lhc verify` / `pnpm --filter pi-lhc verify` | single-package gate |

**No red-verify / green-verify scripts exist** — stated explicitly so no implementer assumes one. Red/Green use the explicit command chains above.

**Real-model integration runs under `verify:all`.** The real-inference leg (`test:integration`) is included in `verify:all`; when provider auth is absent the test's module-load guard prints exactly one NOT-RAN line and runs an accounting assertion that records the not-ran state, so absence can never produce a silent pass. Live compact dogfooding beyond the gate is manual.

---

## Test Files

```
packages/lhc/test/
  view-compact-preview.test.ts            NEW  previewCompact surface + readiness outcome (Chunk 0)
  view-session-thread-view.test.ts        EXT  sourceMessages identity assertions (Chunk 0)

packages/pi-lhc/test/
  compact/handler.test.ts                 NEW  session_before_compact handler (Chunk 1)
  compact/result-mapping.test.ts          NEW  three-tier mapper + assembleCompactionResult, TDQ-1/2/3 (Chunk 1)
  compact/preview-preflight.test.ts       NEW  no-op preflight + map-before-compact ordering (Chunk 1)
  compact/seed-entry-map.test.ts          NEW  seed-entry-map written at hydrate, used by mapper (Chunk 1)
  compact/resume-parity.test.ts           NEW  Flow 4, resume after compact (Chunk 1)
  compact/config.test.ts                  NEW  modelOverrides example validation (Chunk 2)
```

---

## TC → Test Mapping

### Flow 1: Manual Compact (AC-1.1 through AC-1.5)

| TC | Test File | Test Description | Status |
|----|-----------|------------------|--------|
| TC-1.1a | `compact/handler.test.ts` | handler calls `threadView.compact` for `reason: "manual"`, result summary carries LHC band text (not PI native summary) | Planned |
| TC-1.2a | `compact/handler.test.ts` | after compact, `thread_view` has compactPoint > 0 with bands stored | Planned |
| TC-1.3a | `compact/result-mapping.test.ts` | mapped `firstKeptEntryId` + summary + tokensBefore produce correct PI messages when applied via `appendCompaction` | Planned |
| TC-1.4a | `compact/handler.test.ts` | handler returns compaction result (not cancel); PI shows compact feedback (asserted via mock `ctx.ui`) | Planned |
| TC-1.5a | `compact/handler.test.ts` | open turn with members → `{ cancel: true }`, code `open_turn`, no `compact` call | Planned |
| TC-1.5b | `compact/handler.test.ts` | open turn empty → proceeds | Planned |
| TC-1.5c | `compact/handler.test.ts` | closed turn → proceeds | Planned |

### Flow 2: Automatic Threshold Compact (AC-2.1 through AC-2.4)

| TC | Test File | Test Description | Status |
|----|-----------|------------------|--------|
| TC-2.1a | `compact/handler.test.ts` | handler runs the same compact path for `reason: "threshold"` | Planned |
| TC-2.2a | `compact/handler.test.ts` | threshold compact produces same `thread_view` effect as manual | Planned |
| TC-2.3a | `compact/handler.test.ts` | turn closed at `agent_end` is eligible for compact selection (not excluded as open) | Planned |
| TC-2.4a | (PI behavior — not testable in pi-lhc) | Below threshold, PI sends full context; `modelOverrides` only changes the trigger. Verified by dogfooding — `shouldCompact` is PI's code. | N/A — PI behavior |

### Flow 3: Overflow Recovery (AC-3.1 through AC-3.3)

| TC | Test File | Test Description | Status |
|----|-----------|------------------|--------|
| TC-3.1a | `compact/handler.test.ts` | handler runs compact path for `reason: "overflow"`, `willRetry: true` | Planned |
| TC-3.2a | (PI behavior — not testable in pi-lhc) | PI retries after compact. Verified by dogfooding. | N/A — PI behavior |
| TC-3.3a | (PI behavior — not testable in pi-lhc) | PI surfaces recovery-failed on insufficient reduction (`_overflowRecoveryAttempted`). Verified by dogfooding. | N/A — PI behavior |

### Flow 4: Resume After Compact (AC-4.1 through AC-4.2)

| TC | Test File | Test Description | Status |
|----|-----------|------------------|--------|
| TC-4.1a | `view-session-thread-view.test.ts` (lhc) | after compact, `getSessionThreadView` returns banded history + full tail | Planned |
| TC-4.1b | `compact/resume-parity.test.ts` | resumed session seeded from LHC thread-view, not PI native compaction | Planned |
| TC-4.2a | `compact/resume-parity.test.ts` | after compact, all events recorded before/at compact point present and unchanged | Planned |

### Cross-Flow: No-op, Failure, Degraded, Capture Readiness (AC-5.1 through AC-5.6)

| TC | Test File | Test Description | Status |
|----|-----------|------------------|--------|
| TC-5.1a | `compact/handler.test.ts` | preflight detects no-op (small history fits full budget) → `{ cancel: true }`, code `no_op`, no `compact` call | Planned |
| TC-5.1b | `compact/handler.test.ts` | no-op cancel leaves `thread_view` unchanged | Planned |
| TC-5.1c | `view-compact-preview.test.ts` (lhc) | preview shares `selectArrangement` with compact; compactPoint agrees exactly on the same thread state | Planned |
| TC-5.2a | `compact/handler.test.ts` | LHC compact error → `{ cancel: true }`, code `compact_error`, `thread_view` unchanged | Planned |
| TC-5.2b | `compact/handler.test.ts` | compact failure records diagnostic in buffer + warning log | Planned |
| TC-5.3a | `compact/handler.test.ts` | handler always returns `compaction` or `cancel`, never undefined (exhaustive reason + error sweep) | Planned |
| TC-5.4a | `view-compact.test.ts` (lhc, existing) | compact with missing derivations uses fallback and succeeds | Planned |
| TC-5.4b | `view-compact.test.ts` (lhc, existing) | receipt lists degraded entries with chunk and derivation type | Planned |
| TC-5.4c | `view-compact.test.ts` (lhc, existing) | canonical data damage → compact fails with `state_corruption` error | Planned |
| TC-5.5a | `compact/handler.test.ts` | handler flushes pending capture before compact | Planned |
| TC-5.5b | `compact/handler.test.ts` | open turn with activity after failed `agent_end` capture → cancel with `open_turn` | Planned |
| TC-5.6a | `view-compact.test.ts` (lhc, existing) | first compact on thread with enough history produces banded view | Planned |
| TC-5.6b | `view-compact.test.ts` (lhc, existing) | subsequent compact rebuilds from full record; compact point never moves backward | Planned |

---

## TDQ Unit Tests (result-mapping + seed-entry-map)

| Assertion | Test File |
|-----------|-----------|
| TDQ-1 **live tier**: `firstKeptMessageId` → idempotencyKey parses with current piSessionId → entryId in branchEntries | `compact/result-mapping.test.ts` |
| TDQ-1 **seed tier**: idempotencyKey absent or prior-session → lookup in seed-entry-map → piEntryId in branchEntries | `compact/result-mapping.test.ts` |
| TDQ-1 **fail-closed**: neither tier resolves → `{ mappingFailed: true }` | `compact/result-mapping.test.ts` |
| TDQ-1 **no content matching**: two entries with identical content map by identity, not content | `compact/result-mapping.test.ts` |
| TDQ-1 **stale branch**: live entryId parsed but not in branchEntries → cancel `mapping_failed` | `compact/result-mapping.test.ts` |
| TDQ-1 **non-entry identity**: `{ toolCallId }`, `{ responseId }`, fingerprint key → fail-closed | `compact/result-mapping.test.ts` |
| TDQ-1 **runtime_note first-tail**: mapper advances to next mappable message (no fail-closed) | `compact/result-mapping.test.ts` |
| TDQ-1 **map-before-compact**: mapping runs against preview; cancel before `compact` leaves `thread_view` unchanged | `compact/preview-preflight.test.ts` |
| TDQ-2 band assembly order: brief → detailed → smooth, each with `[context · band]` header, empty bands omitted | `compact/result-mapping.test.ts` |
| TDQ-2 summary format parity with `getSessionThreadView` band format | `compact/result-mapping.test.ts` |
| TDQ-3 `tokensBefore`: comes from `event.preparation.tokensBefore`, not `receipt.totalTokens` | `compact/result-mapping.test.ts` |
| TDQ-2 `details`: carries the full `CompactReceipt` (incl. `renderedBands`, `firstKeptMessageId`) | `compact/result-mapping.test.ts` |
| mapper returns a real message/model/thinking entry id, never the seed-map custom entry id | `compact/result-mapping.test.ts` |
| **TDQ-1 assistant grouping**: a 3-part assistant entry (thinking + text + tool_call, messages m10/m11/m12) seeded as one PI entry produces THREE seed-map rows, all pointing at that PI entry id | `compact/seed-entry-map.test.ts` |
| **TDQ-1 assistant-grouped anchor**: compact point lands on m12 (the tool_call part) → mapper resolves via the m12 seed-map row → correct PI entry id | `compact/result-mapping.test.ts` |
| **TDQ-1 seeded idempotencyKey not null**: a seeded entry carries its prior-session idempotencyKey (not null); null means genuinely unavailable only | `compact/seed-entry-map.test.ts` |
| seed-map written at startup hydrate (one row per represented LHC message; assistant entries contribute N rows) | `compact/seed-entry-map.test.ts` |
| seed-map written at rehydrate | `compact/seed-entry-map.test.ts` |
| seed-map superseded on re-hydrate (newest authoritative) | `compact/seed-entry-map.test.ts` |
| seed-map remains valid across a compact within the session (kept seeded entry still resolves; multi-message assistant entry all rows still resolve) | `compact/seed-entry-map.test.ts` |

---

## Architecture-Risk Tests

Scanned the 9-category checklist; 6 apply, 3 omitted.

| # | Risk | Test File | Test Description | Why TC mapping alone would miss it |
|---|------|-----------|------------------|------------------------------------|
| 1 | Atomicity/Rollback | `compact/preview-preflight.test.ts` | no-op cancel leaves `thread_view` unchanged (real SQLite, no new row) | AC-5.1 states the rule; this tests the snapshot-side guarantee |
| 1 | Atomicity/Rollback | `compact/handler.test.ts` | compact-failure cancel leaves `thread_view` unchanged | AC-5.2; tests the transaction rollback path |
| 1 | Atomicity/Rollback | `compact/preview-preflight.test.ts` | **map-before-compact: mapping-failure cancel leaves `thread_view` unchanged** | AC-5.2 — the load-bearing ordering; without it, a stale-branch mapping failure would write a snapshot then leave PI un-compacted |
| 1 | Atomicity/Rollback | `view-compact.test.ts` (lhc, existing) | compact write failure (injected via test seam) leaves prior snapshot intact | AC-5.2 mechanism, not behavior |
| 2 | Concurrency/Lost Update | `compact/handler.test.ts` | pending capture flushed before compact reads record (compactPoint set past them) | the one ordering assertion that matters; full multi-writer concurrency is out of scope (background scheduler writes derivations, not events) |
| 3 | Threshold/Budget | `view-compact-preview.test.ts` (lhc) | **exactness golden**: for corpus sizes {no-op, 1-turn, 3-turn, 8-turn, mixed-chunk}, `preview.compactPoint === compact.compactPoint` and `wouldProduceBands === (compact wrote bands)` | AC-5.1 says predict exactly; this proves it with fixed inputs and shared `computeArrangement` |
| 3 | Threshold/Budget | `view-compact-preview.test.ts` (lhc) | golden cases table (all-fits, two-turns-banded, single-large-turn) — exact expected compactPoint | fixed-input determinism |
| 4 | Source vs Derived | `compact/result-mapping.test.ts` | **three-tier mapper produces correct PI entryId across live, seeded, and fail-closed cases** | TC-1.3a tests the happy path; this covers the seed-region gap (resume-then-compact), the load-bearing correctness property |
| 4 | Source vs Derived | `compact/result-mapping.test.ts` | assembled summary matches `getSessionThreadView` band format exactly | AC-1.2 checks content, not format parity between in-session and resume views |
| 4 | Source vs Derived | `compact/seed-entry-map.test.ts` | seed-map remains valid across compacts within a session | AC-4.1 covers resume parity; this covers the seed-map durability that *enables* the next compact after a compact |
| 5 | Idempotency/Retry | `compact/handler.test.ts` | re-compact: second compact point ≥ first; identity still resolves | AC-5.6b states the rule; this confirms the seed-map + live-key tiers cover the post-compact branch |
| 6 | Persistence/Restart | `compact/resume-parity.test.ts` | after compact + close + reopen thread DB, `readViewSnapshot` returns the compact's snapshot; resume hydrates compacted view | TC-4.2a checks events survive; this checks the snapshot survives reopen (AC-4.1) |

**Omitted categories (with rationale):**
- **Fixture validity** — fixtures are deterministic scripted threads; no external sources to validate.
- **Migration/compatibility** — no schema migration in this design; `previewCompact` and the `CustomEntry` seed-map add no DB tables.
- **Event ordering** — the compact timing is fixed by PI (`session_before_compact` after `agent_end`); the only ordering surface is flush-before-compact, covered in row 2.

---

## Test Count Reconciliation

| Chunk | TC Tests | Architecture-Risk Tests | Total |
|-------|----------|------------------------|-------|
| Chunk 0 (LHC preview + readiness + identity + receipt) | 1 (TC-5.1c) | 5 (exactness golden, golden cases ×2, preview readiness outcome ×2, regression) | ~12 |
| Chunk 1 (pi-lhc handler + three-tier mapper + seed-map) | 17 (TC-1.1a–5.5b excluding PI-behavior and LHC-side) + 17 TDQ/identity unit tests | 8 (atomicity ×3 incl. map-before-compact, concurrency, three-tier source-truth, seed-map validity, summary parity, persistence) | ~30 |
| Chunk 2 (config) | 2 | 0 | 2 |
| **Total** | **~37** (incl. TDQ units) | **~13** | **~44** |

TC-2.4a, TC-3.2a, TC-3.3a are PI behavior — verified by dogfooding, not pi-lhc unit tests. TC-5.4a/b/c and TC-5.6a/b extend the existing LHC compact test suite (counted in Chunk 0 LHC tests).

Epic Story 0 estimated ~24 tests; this plan's Chunk 0 + Chunk 1 = ~42, reflecting the three-tier mapper, the seed-entry-map suite, and the exactness golden added during design. The epic estimate was a pre-design guess; this plan supersedes it.

---

## Mock Strategy

### pi-lhc handler tests (`compact/handler.test.ts`)

Entry point: `handleSessionBeforeCompact(event, ctx, deps)`.

**Mocked (external boundaries):**
- `deps.instance.sdk.threadView.compact` — returns a fixture `CompactReceipt` (incl. `renderedBands`, `firstKeptMessageId`)
- `deps.instance.sdk.threadView.previewCompact` — returns a controllable `PreviewCompactOutcome` (ok / turn_not_ready / error)
- `deps.flushPendingCapture` — no-op or verifiable spy
- `ctx.sessionManager.getEntries()` — fixture PI session entries
- `ctx.ui.notify` — spy for cancel-reason notification assertions
- `event.branchEntries` — fixture PI branch entries
- `event.signal` — controllable `AbortSignal` via `AbortController`

**Not mocked:**
- `handleSessionBeforeCompact` itself — function under test
- `mapFirstKeptToEntryId`, `assembleCompactionResult` — exercised through the handler
- `parseEventKeySource` — exercised through the mapper

### pi-lhc mapping tests (`compact/result-mapping.test.ts`, `seed-entry-map.test.ts`)

Pure functions with fixture inputs — nothing mocked.

### LHC preview/compact tests (`view-compact-preview.test.ts`, existing `view-compact.test.ts`)

Real temp SQLite threads via `initLhc` + `threads.create` + `intakeStream.messageEvents`. No mocks.

---

## Fixture Strategy

### pi-lhc fixtures

```typescript
function makeCompactReceipt(overrides?: Partial<CompactReceipt>): CompactReceipt {
  return {
    viewId: "v42",
    profile: null,
    config: { full: 25, smooth: 35, detailed: 20, brief: 20, lowerBound: 120000 },
    bands: { brief: { entries: 2, tokens: 5000 }, detailed: { entries: 1, tokens: 8000 }, smooth: { entries: 3, tokens: 12000 }, full: { entries: 0, tokens: 0 } },
    tailTokens: 25000,
    totalTokens: 50000,
    coveredFrom: 1,
    compactPoint: 28,
    degraded: [],
    gaps: [],
    warnings: [],
    renderedBands: [
      { band: "brief", text: "[brief summary of turns 1-4]" },
      { band: "detailed", text: "[detailed summary of turns 5-8]" },
      { band: "smooth", text: "[smooth rendering of turns 9-12]" },
    ],
    firstKeptMessageId: "msg_014",
    ...overrides,
  };
}

function makeBranchEntries(messageCount: number): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (let i = 0; i < messageCount; i++) {
    entries.push({
      type: "message",
      id: `entry_${i}`,
      parentId: i === 0 ? null : `entry_${i - 1}`,
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` },
    });
  }
  return entries;
}

function makeSeedEntryMap(entries: Array<{ lhcMessageId: string; piEntryId: string }>): LhcSeedEntryMap {
  return { customType: "pi-lhc.seed-entry-map", threadId: "th_test", entries };
}
```

### LHC fixtures

Reuse `packages/lhc/test/fixtures/`: `validEvent()`, `eventBatch()`, `seedViewBoundary(...)`, and thread creation via `initLhc` + `threads.create` + `intakeStream.messageEvents`. For preview/compact golden cases, use `validEvent` with explicit `payload.text` of known lengths to produce predictable token estimates.

---

## Risks to Dogfooding (not gated by tests)

1. **In-session vs resume shape difference** (TDQ-4/5): the model sees a `CompactionSummaryMessage` in-session and structured band lines on resume. Content-equivalent; presentation differs. Watch for model confusion if it does not.
2. **`runtime_note` first-tail (live)**: the mapper advances past it; a long run of trailing `runtime_note`s could in theory push the kept boundary — confirm this never moves compactPoint materially.
3. **Profile tuning**: the `default-initial` values (25/35/20/20, 120k) are the v1 default. Compact frequency depends on the `contextWindow` cap chosen in Chunk 2. Tuning finding, not correctness.
4. **`bashExecution` fidelity**: not mapped (PI-native tool presentation). Confirm dogfooding does not regress tool-result fidelity after compact.
