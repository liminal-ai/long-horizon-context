# Phase 2 Wave 6 repair round 2 — orchestrator producer-path audit

Resume the established Cursor implementation session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, from the uncommitted Wave 6 tree based on certified Wave 5
`81553fc`. Do not commit or push. Preserve the four root `cc-lhc-*.txt` files
and clean only your artifacts.

Read Amendment I, both initial verifier reports, repair-r1 brief/report, and
this independent orchestrator source audit. Repair every item below before
confirmation. No test/ignore/allowlist name, assertion meaning, golden, or
496-denominator change.

Repair-r1 run `20260725-025527-b4d1d6`, session
`0080ea30-39bd-48b7-a3e4-99738b18037e`, used the required
`Cursor Grok 4.5 High Fast` model and reported a clean `169/312/0/15` gate.
The orchestrator independently reproduced fmt/check, the counted consumer,
clippy, and the same full gate. This round addresses evidence/API defects the
clean gate cannot detect.

## 1. Drive the actual compact producer; remove oracle-only public surfaces

The repair-r1 tree still proves a parallel helper graph rather than the actual
Rust compact chain:

- the counted test calls newly public `budget`, `stored_view_config_json`, and
  `compact_receipt_config`;
- it directly builds `ViewReplaceInput` and calls `replace_view_snapshot`;
- nested `sourceState` is manually assembled with `js_number_value` and
  `js_json_stringify`;
- `path_resolve` / `lexical_path_resolve` were made public for probes.

This lets a mutation in `compact`'s real `source_state_json` construction
survive and invents Rust API solely for test access.

- Exercise the public `thread_view::compact` operation from an existing
  counted async test (or make the existing counted test async without changing
  its name/count), using a disposable real thread database and explicit
  fractional params/profile configuration.
- Seed non-empty multi-type/multi-state derivation rows, then let
  `read_selection_inputs` and `compact` produce the stored source state.
- Read raw SQLite, call public `describe`, and inspect the real compact receipt.
  Keep final inspect composition honestly Wave 7-bound.
- Restore all TS-private helpers to their frozen/private visibility. Do not
  expose `budget`, config/receipt writer helpers, or lexical path helpers to
  integration tests. Remove helpers that exist only to route tests around
  `compact`.
- Mutation of the actual config writer, source-state writer, snapshot reader,
  receipt, selection, or nested-map shape must turn the counted consumer red.

The Node generator has the same issue for its nested source-state row: it
calls `replaceViewSnapshot` with hand-built JSON. Seed real rows and obtain
that row from the real `initLhc → compact → SQLite/describe/inspect.view`
chain. Do not claim a manually replaced row is compact output.

## 2. Retain the corrected large-exponent lane through the real producer

Repair-r1 correctly superseded the old `|x| >= 1e21` “unreachable”
divergence and added shared Node `1e+21` / `-1e+21` spelling plus fixture
rows. Preserve that correction. The remaining problem is that the valid
large-bound stored row is still asserted through the extracted config helper,
not the actual compact producer.

- Drive the existing valid `lowerBound: 1e21` row through actual compact/raw
  SQLite/describe/receipt as applicable.
- Retain mutation proof that replacing the large-exponent branch with Rust
  `Display` turns the counted consumer red.
- Keep the existing Amendment I superseding ledger sentence and accurate
  distinction from integer-over-2^53 behavior.

## 3. Reject the `2^63` f64 upper-bound alias

`require_exact_i64` currently checks
`f <= i64::MAX as f64`. On this target `i64::MAX as f64` rounds to `2^63`, so
the out-of-range value `9223372036854775808.0` passes and the cast saturates to
`i64::MAX`.

- Use a conversion/range check that rejects `2^63` and every larger/non-finite
  value while accepting `i64::MIN`, `i64::MAX` when represented as an integer
  value, and exact in-range integral SQLite reals.
- Probe both boundaries, adjacent out-of-range values, fractions, and
  non-finite values. No saturating cast.

## 4. Do not invent a root cwd when resolution fails

`path_resolve` currently maps `current_dir()` failure to `/`. Node does not
silently reinterpret a relative output path from the filesystem root. Preserve
the governing failure propagation/wrapping; never fabricate `/`.

Retain lexical `.`, `..`, separator, root-saturation, empty-input, and symlink
parity without canonicalization.

## Required evidence

Run fmt/check/clippy, the exact owning suites, lifecycle collection, all
number/date/prompt oracles, prompt bytes, immutable hashes, and the full gate.
Double-regenerate the Node fixture. Report its row count/hash and the exact
production calls behind every row.

Run isolated mutations for merge, all selection band budgets, config writer,
source-state writer/nested-map shape, snapshot reader, receipt, shared number
lane, large exponent, and `2^63` rejection. Each named applicable mutation
must go red. Correct the ledger/report, remove only assigned scratch, and
confirm no new public/test-only surface, commit, or push.
