# Phase 2 Wave 6 repair-r4 report — fractional selection arithmetic

**Status:** repaired locally; **not certified**. No commit/push.
**Baseline:** certified Wave 5 `81553fc` (uncommitted Wave 6 tree).
**Model:** `cursor-grok-4.5-high-fast`.
**Prior:** repair-r3 proved four band `budget` call sites load-bearing with
an integral profile; shared `.trunc()` mutation stayed GREEN.

## Defect corrected

Orchestrator mutation of production `budget`:

```rust
fn budget(lower_bound: f64, share: f64) -> f64 {
    (lower_bound.trunc() * share.trunc()) / 100.0
}
```

left `uninstalled_the_point_is_a_no_op` GREEN under r3's integral-only
selection row (`lowerBound=200`, shares 30/25/25/20).

## Repair

1. Kept `selection_all_band_budgets_load_bearing` (r3 four call-site proof).
2. Added Node-generated `selection_fractional_vs_truncated_operands`:
   - inputs: 2 closed turns, 10 unit-token messages, empty chunks;
   - fractional `{ lowerBound: 60, percentages: 12.5/47.5/20/20 }`;
   - truncated `{ full: 12, smooth: 48, detailed: 20, brief: 20 }`;
   - expected dual projections from live `selectArrangement` (not a local
     `(lb*share)/100` object).
3. Rust consumer runs real `select_arrangement` twice and asserts both
   Node projections (`fractional` / `truncated`).

## Fixture

| Metric | Value |
|---|---|
| Rows | 26 |
| SHA-256 | `abe4c924f3dc91789e75eab2567799c4ad17af6af1a82914b3c30c8de3c19068` |
| Double-regen | byte-identical |
| Generator | `(cd packages/lhc && npm run build) && node scripts/gen-profile-number-fixtures.mjs` |

## Complementary mutation matrices

### r3 — band load-bearing (integral profile; four separate `0.0` sites)

| Site | Result |
|---|---|
| full → 0.0 | RED (`compact_point`) |
| smooth → 0.0 | RED (`entries[4].band`) |
| detailed → 0.0 | RED (`entries[2].band`) |
| brief → 0.0 | RED (`covered_from`) |

### r4 — Amendment I fractional arithmetic (shared helper)

| Mutation | Result | Failing assertion |
|---|---|---|
| `(lb.trunc() * share.trunc()) / 100.0` | RED | `selection_fractional_vs_truncated_operands/fractional: compact_point` left **5** right **0** |

Not 1e21 overflow / config bytes. Integral load-bearing row may stay green
under this mutation (expected). `select.rs` restored; post-restore counted
test GREEN.

## Gate

```text
exact-todo: tokens=83 bodies=83 covered=83
classified=496 cargo-reported=496 (binaries: 58)
passed=169 suspicious=0 notimpl=312 wrong=0 ignored=15
GATE PASS
```

## Immutable scope

- 496-test denominator, test name, ignore arithmetic, production semantics,
  public API, goldens: unchanged.
- Wave 6 remains **not certified** pending dual independent confirmation.

## Cleanup

Assigned scratch removed; `/tmp/lhc-ts-profiles-current.txt` and
`/tmp/lhc-rs-profiles-current.txt` confirmed absent; four root `cc-lhc-*.txt`
preserved. No commit/push.
