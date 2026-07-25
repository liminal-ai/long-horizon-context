# Phase 2 Wave 6 repair round 3 — make every production budget load-bearing

Resume the established Cursor implementation session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, from the uncommitted Wave 6 tree based on certified Wave 5
`81553fc`. Do not commit or push. Preserve the four root `cc-lhc-*.txt` files
and clean only your artifacts.

Read the governing Amendment I ruling, both initial verifier reports,
repair-r1/r2 briefs and reports, and this independent orchestrator mutation
result. Repair the false selection-budget proof before dual confirmation. Do
not change the 496 test denominator, active/ignored arithmetic, test name,
ignore state, production semantics, or frozen public API.

## Independently reproduced defect

Repair-r2 correctly moved config/source-state/receipt/describe rows through
real `compact`, removed oracle-only public helpers, rejected the `2^63` f64
alias, propagated cwd failure, and regenerated the 26-row fixture at
`b96f40519d9c247f1e855a6638191b5df389fcbbaf2ce35c6da95baa41edaf0d`.
The orchestrator independently reproduced fmt/check, the counted consumer,
double regeneration/hash, normal clippy, and gate
`169/312/0/15 = 496`.

But repair-r2's report and ledger overstate:

> selection/`budget` i64 cast — RED

The counted consumer's selection input has no chunks. It asserts only the
fractional/truncated `compact_point`, discards the arrangement returned by the
`budgets` row, and locally recalculates expected budget leaves. Consequently
only the full-budget call is load-bearing. In an isolated copy, the exact
counted test stayed green after each separate production mutation:

```text
budget(config.lower_bound, config.percentages.smooth)   -> 0.0  GREEN
budget(config.lower_bound, config.percentages.detailed) -> 0.0  GREEN
budget(config.lower_bound, config.percentages.brief)    -> 0.0  GREEN
```

Command shape:

```text
cargo test --test view_fixture uninstalled_the_point_is_a_no_op -- --exact --nocapture
```

Each mutation passed `1/1`; isolated scratch
`/tmp/lhc-w6-budget-mutations-34791` was deleted afterward. This violates the
repair-r2 brief's requirement that every selection band budget turn the
counted consumer red. A locally computed `{full,smooth,detailed,brief}` object
is not production proof.

## Required repair

1. Replace the synthetic/local budget proof with Node-generated observable
   outputs from actual `selectArrangement`. Build one or more nontrivial
   selection inputs with enough closed turns, chunks, derivations/material,
   and token distribution that **full, smooth, detailed, and brief** budget
   shares each affect an asserted result.
2. The existing counted Rust consumer must call actual
   `select_arrangement` on the mirrored inputs and assert the complete
   load-bearing observable projection needed for parity: at minimum
   `compact_point` plus ordered selected entries/bands/subject ids (and any
   other field required to distinguish allocation). Do not expose `budget`,
   add a parallel formatter/formula helper as proof, or assert values computed
   locally from the same Rust inputs.
3. Isolated-mutate each of the four production call sites separately—not one
   shared helper cast:

   ```text
   full share     -> 0.0 (or truncation)
   smooth share   -> 0.0 (or truncation)
   detailed share -> 0.0 (or truncation)
   brief share    -> 0.0 (or truncation)
   ```

   Every mutation must make the same counted consumer red for the relevant
   Node fixture row. Report the failing row/assertion for each.
4. Remove or reshape the `budgets_fractional_12_5` row if it remains merely a
   hand-built formula. Fixture row count may change because this is the
   already-sanctioned Amendment I oracle, not the 496-test denominator; record
   the final row count/hash and double-regenerate byte-identically.
5. Correct both `phase2-fix2-wave6-report.md` and `PORT_STATUS.md`: preserve
   repair-r2's historical false claim as explicitly corrected history or
   replace it with accurate r3 evidence. Do not leave an unqualified
   “all RED” r2 budget claim. Update Amendment I's fixture row count/hash and
   exact producer description if the fixture changes.

Keep all repair-r2 production fixes. Run fmt/check/clippy, the counted
consumer, profile oracle double regeneration, exact owning checks, and the
full gate. Append `phase2-fix3-wave6-report.md` with exact four-call-site
mutation results, rows/hash, gate, immutable scope, cleanup, and no
commit/push. Wave 6 remains not certified pending independent dual
confirmation.
