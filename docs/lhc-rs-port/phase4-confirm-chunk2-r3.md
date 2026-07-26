# Phase 4 / Chunk 2 — confirmation round 3 (resumed session)

Resume your own session. **Narrow, and intended to be the last round.**

Fix brief: `phase4-fix-chunk2-r2.md`, items G1–G4, written from both lanes'
findings. Your previous verdict was "sound except [G2/G3-class items]" or
"not sound because [G1 ordering + stale patch]". Those four are now fixed.

## Already verified by the orchestrator — do NOT re-derive

Run by me on the canonical tree, restored and re-verified green after each:

- **G1 mutation** — restore content-first ordering →
  `coverage_stable_id_wins_over_derived_content` FAILS:
  "new stable id must be reported missing even when text matches
  derived/archive content; content-first exclusion would return []".
- **G3 mutation** — ignore `session_derived` →
  `session_derived_without_marker_blocks_reingest` FAILS: archive events
  8 → 16, exactly the doubling predicted.
- **G2** — patch 0007 now carries 4 `NoReduction` (was 0); new tripwire
  layer `patch-repro` applies 0007 on detached HEAD and diffs every file
  against the live tree. Tripwire ALL GREEN including that layer.
- Baseline: host `compact_bridge` 12 passed, core `compact_lhc` 9 passed.

Do not repeat these three. Audit the **design**, and hunt what they cannot
see.

## What changed

- **G1**: `host_items_missing_from_archive_with_derived` — stable-id path is
  identity-only; derived-digest exclusion applies **only** to the anon
  (`id: None`) path; ambiguous anon gap is reported missing (refuse over
  silent skip).
- **G3**: derived digests are marked on `LhcCaptureSlot.mark_derived_digests`
  at write-back, **before** the marker commit, on the same critical path as
  the body install. A failed marker commit now returns `Unavailable`, not
  `Installed`.
- **G2**: patch regenerated + `patch-repro` tripwire layer.
- **G4**: auto-ladder comment corrected; inert client now
  `http://127.0.0.1:9/v1`; `DERIVED_MARKER_CAP = 8` bounds digest growth;
  `three_compacts_do_not_reingest_body` now uses the production shape
  (`id: None`).

## Where I want your attention

1. **G3's new critical path.** Marking derived digests on the slot *before*
   the marker commit is new code on the write-back path. Can it fail, race
   the capture worker, or leave the slot and archive disagreeing? What
   happens across a process restart — is the session-level set lost, and does
   that matter now that a failed marker commit fails open?
2. **`DERIVED_MARKER_CAP = 8`.** A cap is a silent truncation. What happens
   on compact number 9? Can a digest that still matters fall off the end?
3. **G1's anon path.** Body items are `id: None` in production. With the
   stable-id path now identity-only, is every real protection on the anon
   path — and is the multiset decrement still correct under repeats?
4. Regressions in changed files only.

## Acceptance bar (unchanged)

Body from LHC's compaction; law 1 equality on a non-trivial body; law 2 as
real reduction; both ladders hook-removal-sensitive; resume/fork
import-or-refuse by identity; gate fails closed; fail-open bounded in size
and time; tripwire green on clean rebuild; patches apply **and reproduce**.

**Not blocking:** documentation, naming, inventory rows, module length,
change-set size, warnings, test metadata. Trailing list only.

**This is intended to be the final round.** If the bridge is sound, say so
plainly — that is the expected outcome of convergence. Only something
**product-wrong** justifies another round. If your only findings are in the
trailing list, that is an accept.

## Rules

Your own tree (refreshed in place; your session and `.git` are intact).
Mutate freely, restore exactly, verify the tree matches pre-check. Do not
commit or push. You never see the other lane's report.

## Report

Short. (1) G1–G4 status; (2) the four attention items above; (3) regressions
with `file:line` + failure scenario + severity; (4) mutation outputs;
(5) plain verdict — sound or not; (6) trailing non-blocking; (7) coverage.
