# Phase 2 Wave 6 repair-r5 report — all integer readers reject `2^63`

**Status:** repaired locally; **not certified**. No commit/push.
**Baseline:** certified Wave 5 `81553fc` (uncommitted Wave 6 tree).
**Model:** `cursor-grok-4.5-high-fast`.
**Prior:** r1–r4 producer/oracle/budget fixes retained.

## Verifier reconciliation

| Source | Outcome | How used |
|---|---|---|
| Sol `20260725-040456-03703f` | Source FAIL on two readers; harness cleanup later aborted the write-up | Binding for the two missed sites |
| Copilot-Fable `20260725-040456-301c90` (`claude-fable-5` medium) | PASS overall | Retain uncontradicted producer/mutation evidence; **override** item-7 claim that all integer readers reject `2^63` |
| Orchestrator | Same patterns at `boundary.rs:34-37` and `mod.rs:534-537` | Confirming |

Snapshot and select already used an exclusive `2^63` bound; boundary and
prune/zone (`thread_view/mod.rs`) still accepted
`f <= i64::MAX as f64` then saturated via `f as i64`.

## Repair

Added private `src/thread_view/internal/exact_i64.rs` with
`f64_to_exact_i64` / `F64_I64_MAX_EXCLUSIVE` (`2^63`). Wired:

| Reader family | Call sites |
|---|---|
| snapshot | `require_exact_i64` / column maps |
| select | `map_required_i64` |
| boundary | `map_required_i64` → `read_boundary_position`, `visibility_zone_tokens` |
| prune/zone (`mod.rs`) | `map_required_i64` → `read_zone_tool_results`, `tokens_behind_boundary`, counts |

Not public/test-only. Each caller keeps its own panic wording
(`column X not integer` vs `label must be an integer`).

### Semantics (shared)

- Prefer `Value::Number::as_i64()` (exact JSON `i64::MIN`/`MAX`).
- Accept finite integral in-range SQLite reals with exact round-trip.
- Accept `i64::MIN` as real; reject `f >= 2^63`, below `i64::MIN`,
  fractions, non-finite, imprecise casts.
- String-integer parse unchanged.

## Disposable probes (removed; `/tmp/lhc-w6-r5-*` only)

| Path | `2^63` REAL | Integral real |
|---|---|---|
| `boundary::read_boundary_position` | REJECT `column position not integer` | OK |
| `boundary::visibility_zone_tokens` | REJECT `column zone not integer` | OK |
| public `prune` → `tokens_behind_boundary` (`mod.rs`) | REJECT `column total not integer` | OK |

### Mutations (cp restore; no git checkout)

| Revert rounded bound on | Broken | Repaired |
|---|---|---|
| `boundary.rs::map_required_i64` | ACCEPT (no panic) | REJECT |
| `mod.rs::map_required_i64` | ACCEPT saturate `tokens_behind_boundary = i64::MAX` | REJECT |

## Sweep

```text
rg 'f <= i64::MAX as f64|f >= i64::MIN as f64' src/thread_view
```

→ **0** hits. Explanatory comments may still mention `` `<= i64::MAX as f64` ``
in prose; executable code uses exclusive `F64_I64_MAX_EXCLUSIVE`.

## Amendment I oracle / gate

| Metric | Value |
|---|---|
| Fixture rows | 26 |
| SHA-256 | `abe4c924f3dc91789e75eab2567799c4ad17af6af1a82914b3c30c8de3c19068` |
| Double-regen | byte-identical |
| Counted consumer | GREEN |
| Gate | `169/312/0/15` · **GATE PASS** · classified 496 |

Unchanged vs r4 arithmetic.

## Cleanup

- Removed only `/tmp/lhc-w6-r5-*` (implementation scratch).
- Did **not** touch Sol scratch `/tmp/lhc-w6-confirm-r4-t1J6AaXE`.
- Profile-current comparison txts absent; four root `cc-lhc-*.txt` preserved.
- No commit/push. Wave 6 remains **not certified** pending changed-scope
  confirmation.
