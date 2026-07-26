# Phase 4 / Chunk 2 — confirmation round 2 (resumed session)

You are resuming your own Chunk 2 verification session. **Narrow round.**
Do not re-audit the chunk. Check the six fix items below, plus regressions
in changed files only.

Fix brief: `phase4-fix-chunk2-r1.md` (this directory), items F1–F6, written
from your and the other lane's findings.

## What changed since your last report

- **F1** (your B1 / prior #8 — body re-ingested into the archive): coverage
  is now keyed on host `ResponseItemId` ↔ archive idempotency key, with a
  multiset digest fallback for items lacking stable ids. LHC-derived content
  digests are recorded on `CompactMarker.derived_content_digests`, reloaded
  from archive markers, and excluded from import candidacy unconditionally.
  Import now only receives genuine native resume/fork gaps; residual gap →
  refuse.
- **F2** (law 2 vacuous): law 2 rewritten at band scale (~80 long turns,
  100k+ tokens) asserting `active_context_tokens` strictly decreases via
  `context_window_token_status`. R1 and R6 tests also re-cut to be
  mutation-sensitive.
- **F3** (zero-reduction shadowed the native ladder): a non-reducing compact
  now returns `Unavailable { NoReduction }` at `warn` and falls through to
  the native arms.
- **F4**: timeout now detaches (`drop(join)`) instead of awaiting the join,
  so the caller is genuinely bounded.
- **F5**: `marker_key` now includes the archive tip and a body fingerprint,
  so distinct compacts mint distinct keys while retries still collapse.
- **F6**: vacuous disjunctions and self-equality assertions removed; auto
  ladder tests no longer reach `api.openai.com`; tripwire vendor layer now
  fails on `git status`/`git log` error rather than only on an empty pin.

## Already verified by the orchestrator — do not re-derive

I ran these myself, on the canonical tree:

- Tripwire ALL GREEN, 35/35 sentinels, including clippy and the vendor pin.
- **F1 mutation:** disabling the derived-digest exclusion
  (`if false && derived.contains(...)`) →
  `three_compacts_do_not_reingest_body` fails:
  `round 1: source events must stay at 8, got 16 (total 18)`. Restored, green.
- **F2 mutation:** your exact pass-through
  (`new_history = host_items.clone()`) → `law2_token_count_drops_...` **and**
  `law1_installed_items_equal_lhc_body_structurally` both FAIL. Restored,
  green (core 9 passed, host 10 passed).

Spend your effort elsewhere. Confirm or refute, but do not repeat these two.

## Targeted probe — new, from my mutation run

While running the F2 pass-through mutation I observed:

```
thread 'compact_lhc::tests::production_manual_ladder_invokes_lhc_arm'
  has overflowed its stack
fatal runtime error: stack overflow, aborting
```

This happened only under mutation, so it is not a baseline failure. But
**F3 makes fail-open-to-native a common production path** — every
sub-threshold compact now takes it. If the native fallback can recurse or
loop when reached from inside the LHC arm, that is a real production hang,
not a test artefact.

**Determine whether the fail-open-to-native path terminates.** Reach it in a
real session (sub-threshold compact → `Unavailable { NoReduction }` → native
ladder) and show it completes. If it recurses, that is a BLOCKER and I want
the trace.

## Your task

1. For each of F1–F6: resolved / partially / not resolved, one line, with
   what you ran. F1 and F2 are pre-verified above — audit the *design*, not
   the mutation (e.g. can a derived item still be mis-keyed as native? does
   the multiset fallback lose occurrences the way the old `HashSet` did?).
2. The targeted probe above.
3. Regressions in changed files only. Pre-existing issues elsewhere are not
   in scope — one trailing line if you must.

## Acceptance bar (unchanged)

Body produced by LHC's compaction; law 1 equality on a non-trivial body;
law 2 as the next-turn property with real reduction; both ladders
hook-removal-sensitive; resume/fork import-or-refuse; inference gate fails
closed; fail-open bounded against the context window; tripwire green on a
clean rebuild; patches apply to a clean checkout.

**Not blocking, not grounds for another round:** documentation wording,
naming, inventory rows, module length, change-set size, warnings,
test-metadata. Report as a trailing list only.

If the bridge is now functionally sound, **say so plainly.** That is the
expected outcome of a converging round, not a failure to find something.

## Rules

Your own tree. Mutate freely, restore exactly, verify the tree matches its
pre-check state. Do not commit or push. You never see the other lane's
report.

Your tree now has `.git` (the isolation script previously excluded it, which
is why your last run could not check the vendor pin or run the clean-checkout
patch drill). Both are available to you this round.

## Report

Short. (1) F1–F6 status; (2) the fail-open termination probe result;
(3) regressions in changed scope with `file:line` + failure scenario +
severity; (4) mutation outputs; (5) plain verdict; (6) trailing non-blocking
list; (7) coverage note.
