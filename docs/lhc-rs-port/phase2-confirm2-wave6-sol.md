# Phase 2 Wave 6 repair-r5 changed-scope confirmation — Sol

Independent read-only confirmation in `/srv/work/long-horizon-context`,
branch `lhc-rs-port`. Do not edit, commit, or push. This is Wave 6 of 7,
Phase 2 of 3, unit 14 of ~18; Wave 7 and all Phase 3 remain.

Read `phase2-fix5-wave6.md`, its completed report, the r4 confirmation prompt,
current diff from certified Wave 5 `81553fc`, exact TS authority, and the
Wave 6 ledger. This is a changed-scope confirmation of the two integer-reader
repairs plus regression checks; do not repeat the entire r4 producer audit.

Prior evidence:

- Copilot-Fable r4 `20260725-040456-301c90` (`claude-fable-5` medium) PASS
  remains accepted for unmodified producer/oracle/selection/abort paths, but
  its claim that every integer reader rejected `2^63` was overridden.
- Your prior Sol run `20260725-040456-03703f` independently found executable
  rounded bounds in `internal/boundary.rs` and `thread_view/mod.rs`, then
  ended when a forbidden `rm -rf` scratch command was rejected. The source
  finding governed repair-r5.

## Required confirmation

1. Audit the private shared exact conversion and all four call families:
   snapshot, select, boundary, and prune/zone. No public/test-only helper,
   diagnostic drift, saturating/truncating cast, or duplicate rounded-bound
   implementation.
2. Directly probe:
   - REAL `2^63` and exact integral real boundaries through
     `read_boundary_position`;
   - REAL `2^63` and an in-range integral real through
     `visibility_zone_tokens`;
   - REAL `2^63` `token_estimate` through public prune/zone so
     `thread_view/mod.rs::map_required_i64` is reached;
   - exact JSON `i64::MIN`/`i64::MAX`, fractions, non-finite/out-of-range
     values as applicable.
3. In isolated copies, revert boundary and mod.rs separately to
   `f <= i64::MAX as f64; f as i64`. Each exact production probe must turn
   red by accepting/saturating `2^63`; restore baseline and prove green.
4. Run:

   ```text
   rg 'f <= i64::MAX as f64|f >= i64::MIN as f64' src/thread_view
   ```

   No executable hit may remain. Then run fmt/check/clippy, the 26-row counted
   Amendment I consumer, fixture regeneration/hash
   `abe4c924f3dc91789e75eab2567799c4ad17af6af1a82914b3c30c8de3c19068`,
   affected suites, and full gate `169/312/0/15 = 496`.
5. Audit the r5 ledger/report reconciliation and unchanged public/test/golden
   scope. Confirm the four root `cc-lhc-*.txt` files remain untouched.

## Exact cleanup ownership

Your failed prior Sol audit owns
`/tmp/lhc-w6-confirm-r4-t1J6AaXE` (about 4.1 GB). Before new probes, remove
that exact directory with the permitted form:

```text
test -d /tmp/lhc-w6-confirm-r4-t1J6AaXE &&
  find /tmp/lhc-w6-confirm-r4-t1J6AaXE -depth -delete
test ! -e /tmp/lhc-w6-confirm-r4-t1J6AaXE
```

Do not use `rm`/`rm -rf`, wildcards, or touch any other scratch. Use a unique
new directory for this confirmation and clean it by the same exact
`find -depth -delete` method.

Return PASS/FAIL with numbered file:line findings, direct and mutation probe
outcomes, gate/hash, scope, and cleanup. A clean gate without all three
runtime paths is insufficient.
