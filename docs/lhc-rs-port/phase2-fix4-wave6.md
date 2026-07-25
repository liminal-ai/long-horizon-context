# Phase 2 Wave 6 repair round 4 — restore fractional selection proof

Resume the established Cursor implementation session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, from the uncommitted Wave 6 tree based on certified Wave 5
`81553fc`. Do not commit or push. Preserve the four root `cc-lhc-*.txt` files
and clean only your artifacts.

Read Amendment I, repair-r2/r3 briefs and reports, and the final confirmation
prompt. Keep repair-r3's real all-band selection projection and four red
call-site mutations. Close the distinct fractional-arithmetic hole below
without changing production semantics, public API, test denominator/name,
ignore arithmetic, or goldens.

## Independently reproduced residual

Repair-r3 replaced the only fractional selection row with
`selection_all_band_budgets_load_bearing`, whose profile is entirely integral:

```text
lowerBound=200; full=30; smooth=25; detailed=25; brief=20
```

That row correctly makes separate full/smooth/detailed/brief `→ 0.0`
call-site mutations red. It does **not** detect restoration of the pre-
Amendment-I integer arithmetic. The orchestrator isolated this production
mutation:

```rust
fn budget(lower_bound: f64, share: f64) -> f64 {
    (lower_bound.trunc() * share.trunc()) / 100.0
}
```

and ran:

```text
cargo test --test view_fixture uninstalled_the_point_is_a_no_op -- --exact --nocapture
```

Result: **GREEN, 1/1**. This mutation deliberately avoids the unrelated
overflow caused by casting valid `1e21` to `i64`; it removes fractional
selection semantics while leaving the large-exponent writer path intact.
Scratch `/tmp/lhc-w6-fractional-mutation-34791` was deleted afterward.

Thus r3 proves four branches are used, while Amendment I's selection
no-truncation invariant remains unproved.

## Required repair

1. Keep `selection_all_band_budgets_load_bearing` and its four separate red
   call-site mutations.
2. Add a second Node-generated selection row from actual `selectArrangement`
   with fractional `lowerBound` and/or percentage operands chosen so the
   observable result differs when those operands are truncated. The earlier
   2-turn fractional-vs-truncated case is suitable if represented by actual
   selection result projections rather than a locally computed budget object.
3. The counted Rust consumer must parse the row, call real
   `select_arrangement`, and assert the Node-generated observable projection.
   No private helper exposure and no locally recomputed `(lb*share)/100`
   expected object.
4. In an isolated copy, apply exactly the `.trunc()` mutation above. The
   counted consumer must turn RED on the fractional selection row for a
   selection projection assertion—not on `1e21` overflow, config bytes, or an
   unrelated path.
5. Double-regenerate the fixture. Record final row count/hash and actual Node
   producer calls. A fixture row-count change does not move the frozen
   496-test denominator.
6. Correct `phase2-fix3-wave6-report.md` and `PORT_STATUS.md` so the evidence
   is stated as two complementary matrices:
   - r3: four call-site `0.0` mutations prove every band branch load-bearing;
   - r4: shared fractional `.trunc()` mutation proves Amendment I arithmetic.

Run fmt/check/clippy, the counted consumer, profile fixture double
regeneration, owning checks, and the full gate. Append
`phase2-fix4-wave6-report.md` with exact mutation failure, rows/hash, gate,
immutable scope, cleanup, and no commit/push. Wave 6 remains not certified
pending dual independent confirmation.
