# Story 0: Foundation — Types, Preview Surface, Identity, Profile

### Summary
<!-- Jira: Summary field -->

LHC surface additions (`previewCompact`, `CompactReceipt` extensions, `sourceMessages` identity on session-view entries), PI hook type declarations, `computeArrangement` extraction, and the `DEFAULT_COMPACT_PROFILE` constant.

### Description
<!-- Jira: Description field -->

**Primary User:** The operator — a developer running `pi-lhc` in the PI TUI on long-horizon coding sessions.

**Objective:** Establish the shared foundation that the compact handler (Story 1) depends on. After this story, LHC can preview whether a compact would produce bands, return the first kept message's identity, expose `sourceMessages` on session-view entries, and return `renderedBands` + `firstKeptMessageId` on the compact receipt. pi-lhc has the types it needs to register the `session_before_compact` hook and the profile constant for the compact call.

**Scope:**

In:
- Extract `computeArrangement` from `compact()` into `internal/compact-compute.ts` (shared by preview + compact)
- `previewCompact` method on `ThreadViewSurface` — read-only selection preview with readiness check folded in (returns `PreviewCompactOutcome`: ok / turn_not_ready / error)
- `CompactReceipt` extended with `renderedBands` and `firstKeptMessageId`
- `sourceMessages` identity metadata on `SessionThreadViewEntry` (one `SessionThreadViewEntrySource` per represented LHC message, preserving identity through assistant grouping)
- PI type declarations for `SessionBeforeCompactEvent` and `SessionBeforeCompactResult` in pi-lhc
- `DEFAULT_COMPACT_PROFILE` constant in pi-lhc

Out:
- The hook handler itself (Story 1)
- The three-tier mapper and seed-entry-map (Story 1)
- Trigger configuration (Story 2)

**Dependencies:** None. LHC compact engine and thread resolution exist.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-5.1 (partial — preflight surface):** No-op compacts are detected as a read-only preflight before LHC writes a snapshot.

- **TC-5.1c:** Given the preflight must predict `selectArrangement`'s compact point exactly, the preflight surface shares the deterministic selection path with compact and agrees on compact point exactly (verified by running both on the same thread state).

**AC-5.6 (partial — compact correctness via preview):** Compact works correctly on first and subsequent compacts.

- Exercised through the preview/compact agreement tests — preview predicts the same compact point that compact produces.

**Technical acceptance (foundation story — no user-facing ACs, validated by type compilation and architecture-risk tests):**

- `PreviewCompactOutcome` type compiles and is callable through `ThreadViewSurface.previewCompact`
- `CompactReceipt` includes `renderedBands` and `firstKeptMessageId`; existing compact tests pass unchanged after extraction
- `SessionThreadViewEntry` carries `sourceMessages` with one `SessionThreadViewEntrySource` per represented LHC message (verified by identity assertion tests on assistant-grouped entries)
- `SessionBeforeCompactEvent` and `SessionBeforeCompactResult` types compile in pi-lhc
- `DEFAULT_COMPACT_PROFILE` validates (percentages sum to 100, lowerBound positive)

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story extracts the read-and-select body of `compact()` into a shared `computeArrangement` function and builds two consumers: `previewCompact` (read-only, returns the selection result without writing) and the existing `compact` (continues with chunk-fallback, snapshot write, and receipt assembly). The extraction is a refactor of existing tested code — `compact`'s behavior must not change.

The session-view identity addition threads `messageId` and `idempotencyKey` through the tail build (the data is already read from the DB in `snapshot.ts:136-170` but currently stripped before returning). Because assistant entries group multiple LHC messages into one entry with parts, the identity must be per-source-message (`sourceMessages` array), not a single top-level field. This preserves the three-tier mapper's ability to resolve any `firstKeptMessageId` — even one buried inside an assistant entry's grouped parts.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The `computeArrangement` extraction touches the load-bearing compact path — regression risk is real
- `previewCompact` must agree with `compact` on `compactPoint` exactly — the exactness golden cases are the strongest correctness guarantee in the design
- `sourceMessages` identity threading through assistant grouping is subtle (one `SessionThreadViewEntrySource` per represented LHC message, not per entry)

Risk Reminders:
- Verify `compact` behavior is unchanged after extraction (regression)
- Verify `previewCompact` never writes to `thread_view` (read-only contract)
- Verify `sourceMessages` preserves identity through assistant grouping (3-part assistant → 3 source rows)

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| LHC extraction | `packages/lhc/src/thread-view/internal/compact-compute.ts` (NEW) |
| LHC preview | `packages/lhc/src/thread-view/index.ts` (MODIFIED — add `previewCompact`) |
| LHC receipt | `packages/lhc/src/thread-view/index.ts` (MODIFIED — `compact` returns `renderedBands` + `firstKeptMessageId`) |
| LHC types | `packages/lhc/src/shared-tech/view.ts` (MODIFIED — `PreviewCompactResult`, `PreviewCompactOutcome`, `SessionThreadViewEntrySource`, `renderedBands`/`firstKeptMessageId` on `CompactReceipt`) |
| LHC SDK surface | `packages/lhc/src/sdk.ts` (MODIFIED — add `previewCompact` to `ThreadViewSurface`) |
| LHC session-view | `packages/lhc/src/thread-view/internal/session-view.ts` (MODIFIED — thread `sourceMessages` through `assistantPartOf` and `tailEntriesOf`) |
| PI types | `packages/pi-lhc/src/pi/types.ts` (MODIFIED — `SessionBeforeCompactEvent`, `SessionBeforeCompactResult`) |
| Profile | `packages/pi-lhc/src/compact/profile.ts` (NEW) |

#### Design References

- [tech-design.md §Preflight Surface](../tech-design.md:169), lines 169-235
- [tech-design.md §LHC CompactReceipt additions](../tech-design.md:295), lines 295-313
- [tech-design.md §SessionThreadViewEntry identity](../tech-design.md:311), lines 311-338
- [tech-design.md §Deterministic Algorithm Boundaries](../tech-design.md:495), lines 495-518
- [tech-design.md §Chunk 0](../tech-design.md:563), lines 563-577
- [test-plan.md §Chunk 0 TC mapping](../test-plan.md:51), lines 51-107
- [test-plan.md §Architecture-Risk Tests](../test-plan.md:137), lines 137-161

#### Test Mapping

| TC | Test File | Test Description |
|----|-----------|------------------|
| TC-5.1c | `packages/lhc/test/view-compact-preview.test.ts` | preview shares `selectArrangement` with compact; compactPoint agrees exactly on the same thread state |

#### Architecture-Risk Tests

| Risk | Test File | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-----------|------------------|---------------------------------------|
| Threshold/Budget | `packages/lhc/test/view-compact-preview.test.ts` | preview and compact produce identical compactPoint across corpus sizes (no-op, small, multi-turn) | AC-5.1 requires exact prediction; this tests the `computeArrangement` sharing guarantee |
| Threshold/Budget | `packages/lhc/test/view-compact-preview.test.ts` | golden cases: 3 turns under budget → compactPoint 0; 5+ turns over budget → compactPoint at expected turn boundary | AC-5.1 says "predict exactly"; golden cases prove it with fixed inputs |
| Threshold/Budget | `packages/lhc/test/view-compact-preview.test.ts` | near-no-op (one small brief entry) returns `wouldProduceBands: true` — not cancelled | AC-5.1 cancel boundary is strict `wouldProduceBands === false` |
| Atomicity/Rollback | `packages/lhc/test/view-compact-preview.test.ts` | preview never writes a `thread_view` row (read-only contract) | Epic says "no snapshot write on no-op" — preview must be provably read-only |
| Source vs Derived | `packages/lhc/test/view-session-thread-view.test.ts` | `sourceMessages` on assistant entries carries one `SessionThreadViewEntrySource` per grouped LHC message | Identity threading through grouping is an implementation hazard |

#### Technical Notes

- `DEFAULT_COMPACT_PROFILE` uses integer percentages (`{ full: 25, smooth: 35, detailed: 20, brief: 20 }`), not decimals. LHC's `profileViolation` validates they sum to 100.
- `previewCompact` folds readiness into the outcome — returns `{ kind: "turn_not_ready" }` when the open turn has members. No separate `turnIsCompactReady` surface is needed.
- `firstKeptMessageId` on the preview is the messageId of the first PI-mappable content message past the compact point (excludes `turn_end` and `runtime_note`).

#### Anti-Shim Requirements

- `computeArrangement` must be the same function called by both `previewCompact` and `compact` — not a copy. The exactness guarantee depends on shared code, not behavioral equivalence of separate implementations.
- `sourceMessages` must carry real `messageId` and `idempotencyKey` from the DB, not synthesized or placeholder values.
- Existing `compact` tests must continue passing unchanged after the extraction.

#### Production Path Proof

- Entrypoint: `threadView.previewCompact(ref, opts)` via the SDK surface
- Registration: exported from `sdk.ts` → `ThreadViewSurface`; called by the compact handler (Story 1)
- Evidence: preview/compact agreement test proves `previewCompact` runs the same selection path as `compact`

#### Verification

- Targeted: `pnpm --filter lhc test`
- Story gate: `pnpm verify`
- Epic gate: `pnpm verify:all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] `computeArrangement` extracted; existing `compact` tests pass unchanged
- [ ] `previewCompact` method exists on `ThreadViewSurface` and returns `PreviewCompactOutcome`
- [ ] `compact()` returns `renderedBands` and `firstKeptMessageId` on the receipt
- [ ] `sourceMessages` identity threaded through session-view entries (including assistant grouping)
- [ ] `SessionBeforeCompactEvent` and `SessionBeforeCompactResult` types compile in pi-lhc
- [ ] `DEFAULT_COMPACT_PROFILE` constant exists and validates
- [ ] Preview/compact agreement tests pass (exactness golden cases)
- [ ] `pnpm verify` passes (both packages)
