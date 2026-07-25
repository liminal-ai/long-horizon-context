# Phase 2 Wave 6 repair-r1 report — Amendment I contract fidelity

**Status:** repaired locally; **not certified**. No commit/push.
**Baseline:** certified Wave 5 `81553fc`.
**Model:** `cursor-grok-4.5-high-fast`.

Initial verifiers (binding union): Sol `20260725-023658-adae38` FAIL;
Copilot-Fable `20260725-023658-bedeab` FAIL.

## Gate (post-repair)

```text
exact-todo: tokens=83 bodies=83 covered=83
classified=496 cargo-reported=496 (binaries: 58)
passed=169 suspicious=0 notimpl=312 wrong=0 ignored=15
GATE PASS
```

vs `81553fc` (`162/319/0/15`): **+7 passed / −7 notimpl**. Inventory unchanged
at **496**. Goldens: 15 files, **0** SHA drift vs `81553fc`.

## Item outcomes

1. **Shared JS number lane** — `js_string_of_number` / `js_number_value` /
   `js_string_nullish` live in `shared_tech/js_json.rs`. All
   `thread_view` locals (`js_spell_number`, `js_string_of_f64`, render nullish
   duplicate) removed. Spells `-0→0`, integrals, fractions, `NaN`,
   `±Infinity`, small-exponent, and `|x|≥1e21` as `1e+21` (Node). Non-finite
   spelling does not use `Value::from(f64)`.
2. **TS oracle** — `(cd packages/lhc && npm run build) && node
   scripts/gen-profile-number-fixtures.mjs`. Double-regen **byte-identical**.
   **26** rows, SHA-256
   `d1cd6d63af580c80ad16a4ede49ae6c1b915746d1421194df8fcb1490151c4e1`.
   Real resolve / violation / selection; real compact → SQLite `config_json`,
   receipt, describe, `inspect.view` meta.config; nested derivationCounts via
   `replaceViewSnapshot`.
3. **Rust consumer** — same counted test
   `view_fixture::uninstalled_the_point_is_a_no_op` drives resolve, violation,
   `select::budget` / `select_arrangement`, config writer →
   `replace_view_snapshot` → raw SQLite → `read_stored_view` / describe /
   receipt / shared inspect producer (`StoredView.config`). Final
   `compose_view_report` remains Wave 7.
4. **Lifecycle mirror** — percentages + `lower_bound` are `f64`; `Eq` removed.
5. **Closed matches** — band/budget direct fields; `RenderingPartKind`
   exhaustive. Open JSON/`&str` defaults retained (TS `""` /
   `unknown_tool` / excerpt text).
6. **Clippy** — `select` uses `rfind`; no new Wave 6 `filter().next_back`.
7. **Lexical `path.resolve`** — disposable Node parity for relative/absolute
   `.`/`..`, separators, root saturation, empty, symlink-containing paths
   (no canonicalize).
8. **Integer domains** — `require_exact_i64` rejects fractional `1.5`,
   non-finite, out-of-range; integral reals accepted.
9. **Nested source state + abort** — non-empty multi-type×multi-state
   fixture row; EMPTY/FLATTEN/JSON-lane mutations RED. Live
   `CompactAbortSignal` re-read probes at pre-compute / chunk-material /
   pre-write; SDK abort suites stay Wave 7.

## Fable mutation matrix reconciliation

| Producer mutation | Pre-repair | Post-repair |
|---|---|---|
| merge truncation | RED | RED |
| selection truncation | RED | RED |
| non-finite diagnostic spelling | RED | RED |
| shared JS-JSON bypass | RED | RED |
| stored-config writer trunc | GREEN | RED |
| snapshot reader coerce | GREEN | RED |
| receipt coerce | GREEN | RED |
| nested derivationCounts empty/flatten | GREEN | RED |

Additional large-exponent `Display` bypass → RED (`-1e+21` diagnostic).

## Cleanup

Removed `/tmp/lhc-ts-profiles-current.txt`, `/tmp/lhc-rs-profiles-current.txt`,
and repair scratch under `/tmp/lhc-w6-r1-*` / `/tmp/profile-number-pass1.jsonl`.
Named paths confirmed absent. Root `cc-lhc-*.txt` preserved.
