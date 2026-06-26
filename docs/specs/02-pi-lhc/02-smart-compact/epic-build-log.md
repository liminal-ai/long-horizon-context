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
