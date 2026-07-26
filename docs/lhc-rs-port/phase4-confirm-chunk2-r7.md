# Phase 4 / Chunk 2 — confirmation of round 7 (resumed session)

Resume your own session. **Narrow. Acceptance round.**

Your finding was correct and it was the most important of the chunk:
**LHC derivation was never triggered** — `drain_settled` waits for idle, it
does not run work, and neither `work.drain` nor any `derive*` appeared in the
adapter. Every band was a degraded excerpt and the whole inference path was
dead code.

Round 7 fixed L1/L2/L3. The implementor's lane then died mid-report (billing
exhaustion), so I verified the landed work myself.

## Verified by the orchestrator — do NOT re-derive

- **L1 wiring:** `compact_bridge.rs:710` now calls
  `session.lhc.work.drain(thread_ref, None)` before `compact()`, with
  `OpResult::Err` → `LhcCompactUnavailable::DerivationFailed`.
- **L1 mutation (mine):** changed the drain to `max_items: Some(0)` so it
  performs no work → `l1_derivation_runs_callbacks_and_bands_are_not_degraded`
  **fails**, and so does `produce_uses_lhc_compact_receipt_not_heuristic`.
  Restored; green.
- **L2:** `DerivationFailed` variant exists and is returned at four sites
  (`:719, :752, :808, :848`), with "failing open (no degraded install)".
- **L3:** `install.rs:73` documents current-body ids/digests as pinned and
  exempt from the cap; a test override for the cap exists.
- Baseline: host `compact_bridge` **14 passed**, core `compact_lhc`
  **18 passed**.
- Patch 0007 regenerated; tripwire **13 layers ALL GREEN** including
  `patch-repro` and `upstream-schema`.

## Where I want your attention

1. **Does derivation now genuinely run, and are bands genuinely
   model-derived?** My mutation shows the test is sensitive to drain doing
   work. Confirm end-to-end that a real compact produces non-degraded bands
   and that callbacks are actually invoked — count them.
2. **L2's completeness.** Four `DerivationFailed` sites exist. Is every
   derivation-failure path covered, including a failure *inside* `compact()`
   after drain succeeded? Can any path still install a degraded body?
3. **L3's pinning.** Confirm current-body provenance genuinely cannot be
   evicted, and that reseeding is no longer skipped when the cache is
   non-empty. Mutate the cap small and prove no re-ingest.
4. **Cost shape.** Derivation now hits the API in production. Is the number
   of model calls per compact bounded and sane, or does it scale with history
   in a way that would surprise someone? Report the shape, do not spend
   real quota to measure it.

## Acceptance bar

Unchanged. **This is the acceptance round.** If the bridge is sound, say so
plainly. Only something product-wrong justifies another round.

**Not blocking:** documentation, naming, inventory rows, module length,
change-set size, warnings, test metadata. Trailing list only.

## Rules

Your own tree (refreshed in place). Mutate freely, restore exactly, verify
the tree matches pre-check. **Do not run workspace-level `cargo fmt`.**
Do not commit or push. You never see the other lane's report.

**Do not spend real API quota.** Use test callbacks. If a check would require
live model calls, say so and stop — that is my call to make, not yours.

## Report

Short. (1) L1/L2/L3 status; (2) the four attention items; (3) regressions
with `file:line` + scenario + severity; (4) mutation outputs; (5) plain
verdict; (6) trailing non-blocking; (7) coverage.
