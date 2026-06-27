# Smart Compact Epic Build Log

## Story 0: Foundation

- Started from a clean git worktree.
- Orchestration note: implementation will run through Cursor Composer 2.5. Verification will run separately with a built-in subagent on GPT 5.5 high after implementation returns.
- Process requirement carried into prompts: implementor should use package scripts while working, especially `pnpm run verify`, and must run `pnpm run verify:all` before declaring the story done. Verifier must perform a full code review against the story, specs, project patterns, and `bad-code-log.md`.

### Implementation notes

- Extracted `computeArrangement` to `packages/lhc/src/thread-view/internal/compact-compute.ts`. Both `previewCompact` and `compact` call it; preview sets `includeChunkMaterials: false`, compact sets `true`.
- `previewCompact` folds open-turn readiness (`turn_not_ready` when open turn has members). Canonical corruption returns `{ kind: "error", reason }` inside the outcome, not an `OpResult` error.
- `firstKeptMessageId` / `firstPiMappableMessagePast` skips `runtime_note`; uses live `message_id` from the message table.
- `sourceMessages` threaded through session-view tail build; assistant grouping accumulates one `SessionThreadViewEntrySource` per part. Band context lines use `sourceMessages: []`.
- `TailMessageRow` now carries `idempotencyKey` from the joined event row.
- `CompactReceipt` extended with `renderedBands` (stored band text, no `[context · band]` prefix — that prefix is session-view / PI summary assembly only) and `firstKeptMessageId`.
- pi-lhc: `SessionBeforeCompactEvent`, `SessionBeforeCompactResult`, `CompactionPreparation`, `CompactionResult`, hook map entries; `DEFAULT_COMPACT_PROFILE` at `packages/pi-lhc/src/compact/profile.ts` (`{ full: 25, smooth: 35, detailed: 20, brief: 20 }`, `lowerBound: 120_000`).

### Tests added

- `packages/lhc/test/view-compact-preview.test.ts` — preview/compact agreement, read-only contract, readiness outcomes, receipt fields.
- `packages/lhc/test/view-session-thread-view.test.ts` — `sourceMessages` on simple and grouped assistant entries.
- `packages/pi-lhc/test/compact/profile.test.ts` — profile constant validation.

### Verification

```bash
pnpm run verify      # pass (428 lhc + 191 pi-lhc tests)
pnpm run verify:all  # pass (includes lhc real-inference: openai/gpt-5.4-mini, 20 tests)
```

### Friction

- `exactOptionalPropertyTypes` required `signal?: … | undefined` on `computeArrangement` opts.
- `renderedBands` text is raw stored band assembly text, not session-view's `[context · band]` wrapper — test initially assumed the wrapper.

### Verifier feedback (Story 0 acceptance)

**P1 — `session_before_compact` hook types incomplete**

- Finding: `SessionBeforeCompactEvent` omitted `reason` and `willRetry`; `PiHookHandler` returned only `void`, so Story 1 handlers could not return `{ cancel: true }` or `{ compaction }` without casts.
- Fix: added `SessionCompactReason`, `reason` + `willRetry` on `SessionBeforeCompactEvent`; conditional `PiHookHandler<"session_before_compact">` returns `SessionBeforeCompactResult | undefined | Promise<…>`; dedicated `ExtensionAPI.on("session_before_compact", …)` overload; `PiVoidHookHandler` for void hooks (avoids union-distribution breakage in connector `Record<Epic1Hook, …>`).
- Tests: `packages/pi-lhc/test/pi/types-compact-hook.test.ts` — compile-time assertions for cancel/compaction/void returns.

**P2 — preview golden tests lacked fixed expected compactPoint**

- Finding: `view-compact-preview.test.ts` only asserted `preview.compactPoint === compact.compactPoint`; shared selection logic could regress to the same wrong value and still pass.
- Fix: added `describe("preview exactness golden cases")` with fixed expectations:
  - all-fits (3 closed turns, huge budget): `compactPoint === 0`, `wouldProduceBands === false`
  - derived fixture + TARGET_PARAMS: `compactPoint === 48` (turn t8 `closed_at_event_order`)
  - near-no-op (4 brief turns, tight budget): `compactPoint === 9` (turn t3 close), `wouldProduceBands === true`, `firstKeptMessageId === "m10"`
- Agreement tests retained alongside golden assertions.

### Verification (post-fix)

```bash
pnpm run verify      # pass (431 lhc + 194 pi-lhc tests)
pnpm run verify:all  # pass (includes lhc real-inference)
```

## Story 1: Compact Handler + Three-Tier Mapper + Seed-Entry-Map

- Started from a clean git worktree after Story 0 commit `9238d90`.
- Orchestration note: implementation will run through Cursor Composer 2.5 in a captured session. Verification will run separately with a built-in GPT 5.5 high subagent and route feedback back to the same implementor session until convergence.
- Process requirement carried into prompts: implementor should use package scripts while working, especially `pnpm run verify`, and must run `pnpm run verify:all` before declaring the story done. Verifier must perform a full code review against Story 1, the smart compact specs, project patterns, and `bad-code-log.md`.

## Story 2: Trigger Configuration

- Started from a clean git worktree after Story 1 commit `7e005ef`.
- Orchestration note: implementation will run through Cursor Composer 2.5 in a captured session. Verification will run separately with a built-in GPT 5.5 high subagent and route feedback back to the same implementor session until convergence.
- Process requirement carried into prompts: this story should stay config/documentation/test-only unless the existing code proves otherwise. Implementor should use `pnpm run verify` while working and must run `pnpm run verify:all` before declaring the story done.

## Epic Review Fix Pass

- Started from a clean git worktree after Story 2 commit `30d472c`.
- Epic-level review used two independent reviewers: built-in GPT-5.5 xhigh and Cursor Opus 4.8 xhigh. The deduped accepted findings are being handled as one implementation pass.
- Orchestration note: fresh Cursor Composer 2.5 implementor session will receive the inline epic-review-fix story. Fresh built-in GPT-5.5 xhigh verifier will review against the epic/tech design/test plan plus the accepted findings.

## Final Epic Polish Pass

- Started from a clean git worktree after epic review fix commit `84dc603`.
- Scope: compact-point monotonicity for subsequent compacts and a real-capture live identity-chain test. `runtime_note` was checked and rejected as a stale verifier claim because current `PI_MAPPABLE_MESSAGE_KINDS` already excludes it.
- Orchestration note: fresh Cursor Composer 2.5 implementor session will receive this focused pass; fresh built-in GPT-5.5 xhigh verifier will review the result.

### Implementation notes (final polish)

1. **Compact-point monotonicity** — `readStoredCompactPoint`, `compactWouldWriteSnapshot`, and `wouldProduceBandsPreview` in `compact-compute.ts`. `compact()` refuses snapshot write when selection compact point is strictly lower than stored (`compact_unchanged`). `previewCompact` sets `wouldProduceBands` only when selection advances the stored point (or first compact with bands), so pi-lhc preflight cancels backward/no-advance attempts as `no_op` without calling `compact`. Equal compact point still allows direct `compact()` refresh (e.g. lifecycle compact2 after edits).
2. **Identity-chain test** — `packages/pi-lhc/test/compact/identity-chain.test.ts` drives real capture (12 turns, explicit PI entry ids via `appendPiMessage`), compacts through LHC, and asserts live-tier `mapFirstKeptToEntryId` from real `firstKeptMessageId` / `sourceMessages` / captured idempotency keys.

### Tests added/updated

- `packages/lhc/test/view-compact-preview.test.ts` — TC-5.6b backward re-compact regression; re-compact golden expectations updated.
- `packages/lhc/test/view-compact.test.ts` — isolated fixtures for crash/restart tests (shared fixture pollution after monotonicity).
- `packages/pi-lhc/test/compact/identity-chain.test.ts` — live identity chain through capture + compact + mapper.
- `packages/lhc/src/shared-tech/errors.ts` — `compact_unchanged` error code.

### Verification (final polish)

```bash
pnpm run verify      # pass (434 lhc + 244 pi-lhc tests)
pnpm run verify:all  # pass (includes lhc real-inference: openai/gpt-5.4-mini, 20 tests)
```

### Friction (final polish)

- Shared `fixture` in `view-compact.test.ts` left later tests attempting backward compacts after earlier tests advanced the compact point; fixed by per-test `derivedThreadFixture` where needed.

### Story 2 implementation notes

- `docs/specs/02-pi-lhc/02-smart-compact/models.example.json` — `modelOverrides` for `openai-codex/gpt-5.4` with `contextWindow: 250000` (native catalog window is 272000 in PI v0.80.x; effective threshold ~233616 at default `reserveTokens` 16384).
- `docs/specs/02-pi-lhc/02-smart-compact/trigger-config.md` — operator doc: override semantics, install steps, tuning tradeoffs, effective trigger formula.
- `packages/pi-lhc/test/compact/config.test.ts` — sample accepted via `ModelRegistry` load path; JSON asserts only `contextWindow` key; merged model differs only in `contextWindow` vs built-in.
- No runtime pi-lhc changes.

### Tests added (Story 2)

- `packages/pi-lhc/test/compact/config.test.ts` — schema acceptance + scoped override.

### Verification (Story 2)

```bash
pnpm run verify      # pass (431 lhc + 238 pi-lhc tests)
pnpm run verify:all  # pass (includes lhc real-inference: openai/gpt-5.4-mini, 20 tests)
```

### Friction (Story 2)

- PI's `ModelsConfigSchema` / `ModelOverrideSchema` are not exported from `@earendil-works/pi-coding-agent`; validation uses `ModelRegistry` constructor + `getError()` (same internal `validateModelsConfig` path PI uses at runtime).

### Implementation notes (Story 1 — misplaced under Story 2 header)

- `packages/pi-lhc/src/compact/handler.ts` — `handleSessionBeforeCompact`: flush → preview → map → compact → assemble; always returns `{ compaction }` or `{ cancel: true }`; cancel codes recorded via `recordCompactCancel` (buffer + LHC warning log + optional UI notify).
- `packages/pi-lhc/src/compact/result-mapping.ts` — three-tier `mapFirstKeptToEntryId` (live idempotency key → seed-entry-map → fail-closed) and `assembleCompactionResult` with `[context · band]` summary from `renderedBands`; `tokensBefore` from `event.preparation.tokensBefore`.
- `packages/pi-lhc/src/compact/seed-entry-map.ts` — `LhcSeedEntryMap` type + `findSeedEntryMapInSession` (newest wins).
- `packages/pi-lhc/src/compact/diagnostics.ts` — per-session diagnostics buffer, `writeCompactCancelLog` (`level: "warning"`), `recordCompactCancel`.
- `packages/pi-lhc/src/serving/context.ts` — `applySessionThreadViewToSessionManager` collects one seed-map row per `sourceMessages` entry and appends `pi-lhc.seed-entry-map` custom entry after seeded content (when `appendCustomEntry` exists).
- `packages/pi-lhc/src/index.ts` — registers `session_before_compact` + `session_compact`; exports compact surface; `compactHandlers` + `getCompactDiagnostics()` / `getLastCompactDiagnostic()` for tests.
- Map-before-compact: mapping failure returns `mapping_failed` before `threadView.compact` is called.
- Abort signal forwarded via getter wrapper on `event.signal`.

### Tests added

- `packages/pi-lhc/test/compact/handler.test.ts` — manual/threshold/overflow paths, cancel codes, flush ordering, abort signal, never-undefined sweep, hook registration.
- `packages/pi-lhc/test/compact/result-mapping.test.ts` — live/seed/fail-closed tiers, assistant grouping, summary assembly, tokensBefore.
- `packages/pi-lhc/test/compact/seed-entry-map.test.ts` — one row per represented LHC message, newest map lookup, seed-map valid across compact (architecture-risk).
- `packages/pi-lhc/test/compact/diagnostics.test.ts` — buffer push/clear/snapshot/last; `writeCompactCancelLog` fail-soft behavior.
- `packages/pi-lhc/test/compact/preview-preflight.test.ts` — no-op preflight + map-before-compact with real SQLite fixture.
- `packages/pi-lhc/test/compact/resume-parity.test.ts` — banded thread-view after compact, reseed + snapshot persistence.
- `packages/pi-lhc/test/compact/lhc-thread-fixture.ts` — local derived-thread builder (avoids cross-package test import typecheck issues).

### Verification

```bash
pnpm run verify      # pass (431 lhc + 226 pi-lhc tests)
pnpm run verify:all  # pass (includes lhc real-inference: openai/gpt-5.4-mini, 20 tests)
```

### Friction

- Cross-importing `lhc/test/fixtures` from pi-lhc broke `tsc` rootDir; replaced with `test/compact/lhc-thread-fixture.ts` using public `lhc` API only.
- `appendCustomEntry` is optional on test `SessionManager` mocks — seed-map write guarded with `typeof appendCustomEntry === "function"`.
- Accidentally dropped `initInstance`/`initLhc` re-exports during index.ts edit; restored.

### Verifier feedback (Story 1 acceptance)

**P2 — compact cancel diagnostics buffer + warning log missing**

- Finding: only `lastCompactDiagnostic` + optional `ctx.ui.notify`; no per-session buffer and no `instance.sdk.logging.write`.
- Fix: `compact/diagnostics.ts` with `createCompactDiagnosticsBuffer`, `recordCompactCancel`, `writeCompactCancelLog` (fail-soft `level: "warning"`, `reason: code`). Connector exposes `getCompactDiagnostics()` + `getLastCompactDiagnostic()`; buffer cleared on `session_compact`. `recordCancel` is async so handler awaits log write before returning cancel.
- Tests: `test/compact/diagnostics.test.ts`; handler connector tests for buffer accumulation/clear and LHC warning log on `open_turn` cancel; `seed-entry-map.test.ts` seed-map valid across compact.

### Verification (post-fix)

```bash
pnpm run verify      # pass (431 lhc + 233 pi-lhc tests)
pnpm run verify:all  # pass (includes lhc real-inference: openai/gpt-5.4-mini, 20 tests)
```

### Verifier feedback (session-scoped buffer)

**P2 — compact diagnostics buffer connector-scoped, not per-session**

- Finding: `compactDiagnostics` created once in `createConnector()`; only cleared on `session_compact`, so cancel diagnostics from one PI thread could leak into a later thread when no successful compact occurred between them.
- Fix: `compactDiagnostics.clear()` at start of `onSessionStart`, in `onDispose` (`session_before_switch`, `session_shutdown`), and retained on successful `session_compact`.
- Tests: `handler.test.ts` — clear on `session_before_switch`, `session_shutdown`, and next `session_start` without intervening successful compact.

### Verification (session-scoped buffer fix)

```bash
pnpm run verify      # pass (431 lhc + 236 pi-lhc tests)
pnpm run verify:all  # pass (includes lhc real-inference: openai/gpt-5.4-mini, 20 tests)
```

### Implementation notes (epic review fix pass)

1. **Resume stale-live → seed fallthrough** — `mapFirstKeptToEntryId` no longer fails when a current-session idempotency key parses but the entry id is absent from `branchEntries`; it falls through to seed-entry-map.
2. **Branch-local seed map** — compact handler calls `findSeedEntryMapInBranch(event.branchEntries, sessionView.threadId)` instead of scanning all session entries; `threadId` must match the active LHC thread.
3. **Read-only preview** — `previewCompact` runs inside `createDbReadTransaction` (touch-suppressed) instead of `openThreadDatabase` directly.
4. **Abort before write** — `compact` checks `compactStopped(signal)` immediately before `replaceViewSnapshot`.
5. **Capture diagnostics** — `flushPendingMessages` does not clear `lastCaptureFailure` on an empty flush; successful captures clear via `recordCaptureOutcome`, and a non-empty flush with no failures clears at flush end. `capture_incomplete` only fires when a failure survives into compact after flush.
6. **Dead code removed** — `buildContextServePreview`, `ContextServeMessagePreview`, `CONTEXT_SERVE_PREVIEW_*` and dedicated test deleted.

### Tests added/updated

- `packages/pi-lhc/test/compact/result-mapping.test.ts` — stale-live seed fallthrough, stale branch seed tier, no seed map fail-closed.
- `packages/pi-lhc/test/compact/seed-entry-map.test.ts` — `findSeedEntryMapInBranch` thread-id filter vs all-session newest.
- `packages/pi-lhc/test/compact/handler.test.ts` — stale `lastCaptureFailure` does not relabel `open_turn`; connector tests for agent_end failure → `capture_incomplete` and stale failure cleared by successful pending flush.
- `packages/lhc/test/view-compact-preview.test.ts` — background mode preview leaves pending queue and scheduler pass count unchanged.
- `packages/lhc/test/view-compact.test.ts` — abort at compact-write injection leaves prior snapshot unchanged.

### Verification (epic review fix pass)

```bash
pnpm run verify      # pass (433 lhc + 243 pi-lhc tests)
pnpm run verify:all  # pass (includes lhc real-inference: openai/gpt-5.4-mini, 20 tests)
```

### Friction (epic review fix pass)

- `exactOptionalPropertyTypes` required `delete state.health.lastCaptureFailure` instead of assigning `undefined`.
- Seed-map branch test needed seed `piEntryId` present in `branchEntries` — fallthrough only helps when the seed row resolves on the branch.

### Verifier feedback (capture diagnostics P1)

**P1 — empty flush cleared current agent_end capture failures**

- Finding: clearing `lastCaptureFailure` when `pendingMessages` was empty wiped failures recorded at `agent_end` turn-close (no pending messages left), so compact returned `open_turn` instead of `capture_incomplete`.
- Fix: remove empty-flush clear; clear on successful `recordCaptureOutcome` and after a non-empty flush with no failures.
- Tests: connector `handler.test.ts` — agent_end with dead store survives empty compact flush → `capture_incomplete`; stale mapping failure cleared by successful pending flush → `open_turn`.
