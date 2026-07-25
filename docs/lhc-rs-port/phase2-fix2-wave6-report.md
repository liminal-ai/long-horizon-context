# Phase 2 Wave 6 repair-r2 report — producer-path audit

**Status:** repaired locally; **not certified**. No commit/push.
**Baseline:** certified Wave 5 `81553fc`.
**Model:** `cursor-grok-4.5-high-fast`.
**Prior:** repair-r1 `20260725-025527-b4d1d6` gate `169/312/0/15`.

## Gate (post-repair-r2)

```text
exact-todo: tokens=83 bodies=83 covered=83
classified=496 cargo-reported=496 (binaries: 58)
passed=169 suspicious=0 notimpl=312 wrong=0 ignored=15
GATE PASS
```

vs `81553fc`: **+7 passed / −7 notimpl**. Inventory **496**. Goldens: 0 drift.

## Item outcomes

### 1. Actual compact producer; no oracle-only public API

- Counted test `uninstalled_the_point_is_a_no_op` is async and drives
  persisted/receipt/describe/inspect-shared rows through public
  `thread_view::compact` + `describe` on a disposable seeded thread DB.
- Nested `source_state_json` comes from compact after seeding multi-type ×
  multi-state derivation rows (via `read_selection_inputs` → compact write).
- Restored private: `stored_view_config_json`, `compact_receipt_config`,
  `budget`, `lexical_path_resolve`. `path_resolve` is `pub(crate)` only.
- Node generator: seed derivation rows (+ clear `work_item` so migrate does
  not re-add forms), then real compact → SQLite; removed hand-built
  `replaceViewSnapshot` source-state row. Stored-config rows (incl. `1e21`)
  also go through real compact → SQLite.

### 2. Large-exponent lane via real producer

- Valid `lowerBound: 1e21` stored row asserted through compact/raw
  SQLite/describe. Large-exponent `Display` bypass mutation → RED.
- Ledger keeps Amendment I supersession of `|x|≥1e21` vs integer-over-2^53.

### 3. Reject `2^63` f64 alias

- `f64_to_exact_i64` rejects `f >= 2^63` (exact f64); accepts exact in-range
  integral reals and `as_i64()` JSON integers including `i64::MIN`/`MAX`.
- Disposable probe: `maxEventOrder: 9223372036854775808.0` rejected; with
  the old `<= i64::MAX as f64` bound it accepted/saturated to `i64::MAX`.

### 4. cwd failure propagation

- `path_resolve` panics with the underlying `current_dir` error; never maps
  failure to `/`. Lexical `.`/`..`/separator/root-saturation/empty/symlink
  behavior retained (no canonicalize).

## Fixture

| Metric | Value |
|---|---|
| Rows | 26 |
| SHA-256 | `b96f40519d9c247f1e855a6638191b5df389fcbbaf2ce35c6da95baa41edaf0d` |
| Double-regen | byte-identical |
| Generator | `(cd packages/lhc && npm run build) && node scripts/gen-profile-number-fixtures.mjs` |

Sample compact `source_state_json`:
`{"maxEventOrder":3,"derivationCounts":{"detailed_turn_compression":{"failed":1,"ready":1},"smoothed_prompt":{"pending":1,"ready":2}}}`

### Production calls per kind

| Kind | Producer |
|---|---|
| resolve_profile | `resolve_view_config` |
| profile_violation | `profile_violation` |
| budgets / selection | `select_arrangement` (private nested `budget`) — *r2 selection input lacked chunks; see repair-r3* |
| stored_config_json | `compact` → raw SQLite `config_json` |
| describe_config_json | `compact` → `describe` → `StoredView.config` |
| receipt_config_json | `compact` → `CompactReceipt.config` |
| inspect_meta_config_json | `describe` `StoredView.config` (Wave 7: `compose_view_report`) |
| source_state_json | seed derivations → `compact` → raw SQLite / `describe` |

## Mutation matrix (counted consumer)

| Mutation | Result |
|---|---|
| merge truncation | RED |
| selection/`budget` i64 cast | RED *(historical claim; repair-r3 corrected — only full-budget call site was load-bearing; smooth/detailed/brief stayed GREEN under separate `0.0` mutations)* |
| compact config writer trunc | RED |
| compact source-state empty map | RED |
| snapshot reader trunc | RED |
| receipt trunc | RED |
| NaN spelling → `"null"` | RED |
| large-exponent `Display` | RED |
| `2^63` reject (disposable) | rejects; mutated bound accepts |

## Cleanup

Assigned scratch removed; `/tmp/lhc-ts-profiles-current.txt` and
`/tmp/lhc-rs-profiles-current.txt` absent; four root `cc-lhc-*.txt` preserved.
