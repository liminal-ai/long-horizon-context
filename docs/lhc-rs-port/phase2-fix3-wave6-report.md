# Phase 2 Wave 6 repair-r3 report — load-bearing selection budgets

**Status:** repaired locally; **not certified**. No commit/push.
**Baseline:** certified Wave 5 `81553fc` (uncommitted Wave 6 tree).
**Model:** `cursor-grok-4.5-high-fast`.
**Prior:** repair-r2 overstated selection/`budget` coverage (only full share
was load-bearing).

## Defect corrected

Repair-r2's counted selection consumer used a 2-turn / 0-chunk input and
asserted only fractional vs truncated `compactPoint` plus locally recomputed
`(lb*share)/100` budget leaves. Mutating production
`budget(...smooth|detailed|brief)` → `0.0` left the counted test GREEN.

## Repair

1. Generator (`scripts/gen-profile-number-fixtures.mjs`): removed
   `budgets_fractional_12_5`; replaced weak selection row with
   `selection_all_band_budgets_load_bearing` — Node
   `selectArrangement` over 14 closed turns, 4 closed chunks, ready
   turn_rendering / chunk_summary_* derivations; expected projection
   serialized from the live result (`compactPoint`, `coveredFrom`, ordered
   entries without text/tokens).
2. Consumer (`tests/view_fixture.rs`): removed `assert_budget_leaves`,
   `amendment_i_selection_inputs`, and the `"budgets"` kind arm. `"selection"`
   parses `input.selectionInputs` into `SelectionInputs`, calls
   `select_arrangement`, asserts the Node projection field-by-field.
3. No `budget` import; no local `(lb*share)/100` proof.

## Fixture

| Metric | Value |
|---|---|
| Rows | 25 |
| SHA-256 | `0426ed67246b8be929f6ca21b2be0c9d57dae1f636b4bd5258f1512950e9c497` |
| Double-regen | byte-identical |
| Baseline seq | compactPoint=120, coveredFrom=10, entries: brief:c1, brief:c2, detailed:c3, detailed:c4, smooth:t9, smooth:t10, smooth:t11, smooth:t12 |

## Four call-site mutations (cp backup/restore; no git checkout)

Counted test:
`cargo test --test view_fixture uninstalled_the_point_is_a_no_op -- --exact --nocapture`

| Site | Mutation | Result | Failing assertion |
|---|---|---|---|
| full | `full_budget = 0.0` | RED | `selection_all_band_budgets_load_bearing: compact_point` left 130 right 120 |
| smooth | `fill_band(..., 0.0, ...)` | RED | `...: entries[4].band` left `"detailed"` right `"smooth"` |
| detailed | `fill_band(..., 0.0, ...)` | RED | `...: entries[2].band` left `"brief"` right `"detailed"` |
| brief | `fill_band(..., 0.0, ...)` | RED | `...: covered_from` left 30 right 10 |

`select.rs` restored after each mutation; post-restore counted test GREEN.

## Gate

```text
exact-todo: tokens=83 bodies=83 covered=83
classified=496 cargo-reported=496 (binaries: 58)
passed=169 suspicious=0 notimpl=312 wrong=0 ignored=15
GATE PASS
```

`cargo fmt --check` clean; `cargo clippy --tests` exit 0 (carried warnings only).

## Immutable scope

- 496-test denominator, active/ignored arithmetic, test name, ignore state,
  production semantics, frozen public API: unchanged.
- Goldens / root `cc-lhc-*.txt`: preserved.
- Wave 6 remains **not certified** pending independent dual confirmation.

## Cleanup

Assigned scratch removed; `/tmp/lhc-ts-profiles-current.txt` and
`/tmp/lhc-rs-profiles-current.txt` confirmed absent; four root `cc-lhc-*.txt`
preserved. No commit/push.

## Residual (closed in repair-r4)

The load-bearing profile is entirely integral
(`lowerBound=200`, shares 30/25/25/20). Mutating
`budget` to `(lower_bound.trunc() * share.trunc()) / 100.0` left the
counted consumer GREEN under r3 alone — Amendment I fractional selection
arithmetic was not proved. Repair-r4 adds
`selection_fractional_vs_truncated_operands` for that invariant; see
`phase2-fix4-wave6-report.md`.
