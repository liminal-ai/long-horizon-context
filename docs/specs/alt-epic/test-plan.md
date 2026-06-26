# Test Plan: LHC Smart Compact (pi-lhc)

**Tech design:** `./tech-design.md`
**Epic:** `../02-pi-lhc/02-smart-compact/epic.md`
**Config:** A — paired with `tech-design.md`.

---

## Verification Tiers

| Tier | Command | Coverage |
|------|---------|----------|
| format | `pnpm run format:check` | biome format |
| lint | `pnpm run lint` | biome check |
| typecheck | `pnpm run typecheck` | lhc build + tsc --noEmit (src + test) |
| test | `pnpm run test` | lhc + pi-lhc vitest, excludes real-inference |
| **verify** (standard gate) | `pnpm run verify` | format + lint + typecheck + test |
| verify:all | `pnpm run verify:all` | verify + lhc real-inference (`test:integration`, `LHC_RUN_INTEGRATION=1`) |
| red phase | `pnpm run typecheck && pnpm run lint && pnpm run format:check` | compile + style only |
| green phase | `pnpm run verify` | full behavior |

**No red-verify / green-verify scripts exist** — stated explicitly so no implementer assumes one. Red/Green use the explicit command chains above.

**Real-model integration runs under `verify:all`.** The real-inference leg (`test:integration`) is included in `verify:all`; when provider auth is absent the test's module-load guard prints exactly one NOT-RAN line and runs an accounting assertion that records the not-ran state, so absence can never produce a silent pass. Live compact dogfooding beyond the gate is manual.

---

## Test Files

```
packages/lhc/test/
  view-compact-preview.test.ts        NEW — previewCompact surface (Chunk 0)
  turns-compact-ready.test.ts         NEW — turnIsCompactReady (Chunk 0)

packages/pi-lhc/test/
  compact/handler.test.ts             NEW — session_before_compact handler (Chunk 1)
  compact/result-mapping.test.ts      NEW — CompactReceipt → PiCompactionResult, TDQ-1/2 (Chunk 1)
  compact/preview-preflight.test.ts   NEW — no-op preflight cancel (Chunk 1)
  compact/resume-parity.test.ts       NEW — Flow 4, resume after compact (Chunk 1)
  compact/config.test.ts              NEW — modelOverrides example validation (Chunk 2)
```

---

## TC → Test Traceability

### Chunk 0 (LHC previewCompact + readiness)

| TC | Test | File |
|----|------|------|
| AC-5.1c (preflight exact) | preview `compactPoint` and `wouldProduceBands` equal real compact's, across corpus sizes (small/no-op, mid, multi-turn) | `view-compact-preview.test.ts` |
| AC-5.1c (preflight exact) | preview runs the same `selectArrangement`; prediction is byte-identical | `view-compact-preview.test.ts` |
| AC-5.1 (preview writes nothing) | preview on a no-op thread leaves `thread_view` table unchanged (no new row) | `view-compact-preview.test.ts` |
| AC-5.1 (no-op detection) | preview returns `wouldProduceBands === false` iff `compactPoint === 0` | `view-compact-preview.test.ts` |
| AC-5.1 (near-no-op not cancelled) | a one-small-brief-entry arrangement returns `wouldProduceBands === true` | `view-compact-preview.test.ts` |
| AC-5.4c (corruption refusal) | preview on a source-damaged thread returns `state_corruption` error, no write | `view-compact-preview.test.ts` |
| AC-1.5 (readiness empty open turn) | open turn with 0 members → `ready: true` | `turns-compact-ready.test.ts` |
| AC-1.5 (readiness open with members) | open turn with members → `ready: false` | `turns-compact-ready.test.ts` |
| AC-1.5 (readiness closed invariant) | LHC maintains exactly one open turn; empty open turn → `ready: true` | `turns-compact-ready.test.ts` |
| AC-5.4c (compact unchanged by refactor) | existing `view-compact.test.ts` still passes (regression) | existing |

### Chunk 1 (pi-lhc handler + mapping)

| TC | Test | File |
|----|------|------|
| TC-1.1a | manual `session_before_compact` → `threadView.compact` called, result summary carries LHC band text | `handler.test.ts` |
| TC-1.2a | after manual compact, snapshot has compactPoint > 0, boundary reset, bands stored | `handler.test.ts` |
| TC-1.3a | returned `compaction.firstKeptEntryId` is a real branchEntry id; kept tail matches LHC tail | `handler.test.ts` |
| TC-1.5a | open turn with members → `{ cancel: true }`, code `open_turn`, no `compact` call | `handler.test.ts` |
| TC-1.5b | open turn empty → proceeds, not cancelled | `handler.test.ts` |
| TC-1.5c | closed turn → proceeds, not cancelled | `handler.test.ts` |
| TC-2.1a | `reason: "threshold"` → handler runs compact path | `handler.test.ts` |
| TC-2.2a | threshold compact produces same snapshot effect as manual | `handler.test.ts` |
| TC-2.3a | the just-closed turn is in closed history at compact time (eligible) | `handler.test.ts` |
| TC-3.1a | `reason: "overflow"`, `willRetry: true` → handler runs compact path | `handler.test.ts` |
| TC-3.3a | after one overflow-retry-overflow, PI surfaces recovery-failed (simulated: second compact does not loop) | `handler.test.ts` |
| TC-4.1a | resume a compacted thread → `getSessionThreadView` returns bands + tail, seeded into PI | `resume-parity.test.ts` |
| TC-4.1b | resumed PI context source is LHC thread-view, not a PI compaction entry | `resume-parity.test.ts` |
| TC-4.2a | after compact, all recorded events pre- and at-compact-point present and unchanged | `resume-parity.test.ts` |
| TC-5.1a | closed history fits full-tail budget → `{ cancel: true }`, code `no_op`, no `compact` call | `preview-preflight.test.ts` |
| TC-5.1b | no-op cancel leaves snapshot unchanged (real SQLite, no new row) | `preview-preflight.test.ts` |
| TC-5.2a | LHC compact returns error → `{ cancel: true }`, code `compact_error`, snapshot unchanged | `handler.test.ts` |
| TC-5.2b | compact failure reason recorded in diagnostics buffer + warning log | `handler.test.ts` |
| TC-5.3a | handler never returns `undefined`/void for any reason (exhaustive reason sweep) | `handler.test.ts` |
| TC-5.4a | compact with missing chunk derivations → proceeds with fallback, succeeds | `handler.test.ts` |
| TC-5.4b | each degraded chunk listed in receipt.degraded with subjectId + derivation | `result-mapping.test.ts` |
| TC-5.5a | pending capture events flushed before compact runs | `handler.test.ts` |
| TC-5.6a | first compact on uncompacted thread → bands arranged by profile | `handler.test.ts` |
| TC-5.6b | re-compact → compact point never moves backward | `handler.test.ts` |

### TDQ-1 / TDQ-2 unit tests (result-mapping)

| Assertion | Test | File |
|-----------|------|------|
| TDQ-1 live tier: `firstKeptMessageId` → idempotencyKey parses with current piSessionId → entryId in branchEntries | `result-mapping.test.ts` |
| TDQ-1 seed tier: idempotencyKey absent or prior-session → lookup in seed-entry-map → piEntryId in branchEntries | `result-mapping.test.ts` |
| TDQ-1 fail-closed: neither tier resolves → `{ mappingFailed: true }` | `result-mapping.test.ts` |
| TDQ-1: degenerate fallback does not write LHC snapshot (cancel before compact) | `preview-preflight.test.ts` |
| TDQ-2: band assembly order is brief → detailed → smooth, each with header | `result-mapping.test.ts` |
| TDQ-2 `tokensBefore`: comes from `event.preparation.tokensBefore`, not `receipt.totalTokens` | `result-mapping.test.ts` |
| TDQ-2: `details` carries the full CompactReceipt | `result-mapping.test.ts` |

### Chunk 2 (config)

| TC | Test | File |
|----|------|------|
| TC-2.4a | sample models.json `modelOverrides` accepted by the schema; only `contextWindow` overridden | `config.test.ts` |
| TC-2.1 support | override sets contextWindow; unrelated fields (auth, baseUrl) unchanged | `config.test.ts` |

---

## Architecture-Risk Tests

Scanned the 9-category checklist; 6 apply, 3 omitted.

### 1. Atomicity / Rollback (applies)

| Risk | Test |
|------|------|
| No-op cancel leaves snapshot unchanged | `preview-preflight.test.ts`: real SQLite, assert no new `thread_view` row, compactPoint/boundary unchanged |
| Compact-failure cancel leaves snapshot unchanged | `handler.test.ts`: inject a source-damaged thread, assert snapshot row unchanged |
| Mapping-failure cancel leaves snapshot unchanged (TDQ-1 ordering) | `preview-preflight.test.ts`: preview → map → cancel-before-compact; assert no snapshot write |
| Compact writes snapshot in one transaction | covered by existing `view-compact.test.ts` (the `fireViewInjection("compact-write")` seam) |

### 2. Concurrency / Lost Update (applies — narrowly)

| Risk | Test |
|------|------|
| Pending capture flushed before compact reads record | `handler.test.ts`: enqueue intake events, assert compact sees them (compactPoint set past them) |
| Capture does not interleave with compact's read | by construction — compact opens its own read; pi-lhc flushes synchronously before calling compact. Test asserts flush-then-compact ordering. |

Full multi-writer concurrency is out of scope: the pi-lhc session is single-threaded per thread (background scheduler is the only other writer, and it runs derivations, not events).

### 3. Threshold / Budget (applies — the exactness golden)

| Risk | Test |
|------|------|
| Preview predicts compact's compactPoint exactly | `view-compact-preview.test.ts`: for corpus sizes {no-op, 1-turn, 3-turn, 8-turn, mixed-chunk}, assert `preview.compactPoint === compact.compactPoint` and `preview.wouldProduceBands === (compact wrote bands)` |
| Preview wouldProduceBands ⟺ real compact writes bands | same file: `wouldProduceBands === false` ⟺ post-compact `thread_view` has compactPoint 0 |
| Budget boundary is `compactPoint === 0 && bands empty`, not near-no-op | `view-compact-preview.test.ts`: one-small-brief arrangement is not no-op |

This is the strongest correctness guarantee in the design and the most important architecture-risk test.

### 4. Source vs Derived Truth (applies)

| Risk | Test |
|------|------|
| Resume after compact hydrates from LHC, not PI compaction entry | `resume-parity.test.ts` (AC-4.1) |
| Durable record intact after compact | `resume-parity.test.ts` (AC-4.2): all events pre- and at-compact-point present |
| LHC is source of truth across the compact boundary | implied by the two above |

### 5. Idempotency / Retry (applies)

| Risk | Test |
|------|------|
| Overflow recovery does not loop | `handler.test.ts` (AC-3.3): simulate compact → retry → second overflow; assert PI's `_overflowRecoveryAttempted` semantics (one retry, then recovery-failed) |
| Re-compact is idempotent-ish | `handler.test.ts` (AC-5.6b): compact twice; second compact point ≥ first |

### 6. Persistence / Restart (applies)

| Risk | Test |
|------|------|
| Compact survives process restart | `resume-parity.test.ts`: compact in one SDK instance, reopen thread in a fresh instance, assert view snapshot present |
| Resume reconstructs the compacted view | `resume-parity.test.ts` (AC-4.1) |

### Omitted categories

- **Fixture validity** — fixtures are deterministic scripted threads; no external fixture sources to validate.
- **Migration / compatibility** — no schema migration in this design; `previewCompact` adds no tables.
- **Event ordering** — the compact timing is fixed by PI (`session_before_compact` after `agent_end`); there is no event-ordering surface for pi-lhc to get wrong. The one ordering assertion (flush before compact) is in §2 above.

---

## Test Count Reconciliation

| Chunk | Estimated tests | Files |
|-------|-----------------|-------|
| Chunk 0 (LHC preview + readiness + identity) | ~12 | 2 new + 1 extended + 1 regression |
| Chunk 1 (pi-lhc handler + mapper + seed-map) | ~24 | 6 new |
| Chunk 2 (config) | ~2 | 1 new |
| **Total** | **~38** | 9 new |

Epic Story 0 estimated ~24 tests; this plan's Chunk 0 + Chunk 1 = ~36, reflecting the identity-tier mapper, the seed-entry-map suite, and the exactness golden added in design. The epic estimate was a pre-design guess; this plan supersedes it.

---

## Mock and Storage Conventions

- **Mock at boundaries only:** PI hook surface (`session_before_compact` event shape, `branchEntries`, `signal`) and, where a test isolates a pure function, the LHC SDK call boundary. Never mock `selectArrangement` separately from `previewCompact`/`compact`.
- **Real temp SQLite for filesystem-contract tests:** atomicity, no-op-unchanged, resume-durability, and the exactness golden all use real temp threads (`makeTempThread` / `tempStore` in pi-lhc; existing view fixtures in lhc). No mocked storage for these.
- **Pure-function unit tests** (`result-mapping`, `preview-wouldProduceBands` logic, band assembly) take plain objects in and assert plain objects out — no DB.
- **PI behavior simulation:** PI's `_overflowRecoveryAttempted` one-retry semantics are simulated in `handler.test.ts` by driving the handler twice with `willRetry: true` and asserting the second is not re-compacted past the retry boundary. Real PI is not instantiated in the standard gate.

---

## Risks to Dogfooding (not gated by tests)

These are accepted by the design and surfaced here so dogfooding watches them:

1. **In-session vs resume shape difference** (TDQ-4/5): the model sees a `CompactionSummaryMessage` in-session and structured band lines on resume. Content-equivalent; presentation differs.
2. **`runtime_note` first-tail message (live)** (TDQ-1 limitation): a *live* `runtime_note` (captured without a PI entry) fails closed because it has nothing to map. A seeded `runtime_note` resolves via the seed-entry-map if hydration maps it to a PI entry. Confirm in dogfooding which case surfaces.
3. **Profile tuning**: the `coding` values (25/35/20/20, 120k) are the v1 default. Cache-friendliness and compact frequency depend on the `contextWindow` cap chosen in Chunk 2. This is a tuning finding, not a correctness one.
