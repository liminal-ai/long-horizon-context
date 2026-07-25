# Phase 2 Wave 6 repair-r5 confirmation — Amendment I production contract

Independent read-only changed-scope confirmation in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Read the governing
Amendment I ruling, Wave 6 implementation/verification/repair briefs, both
initial verifier reports, the implementor repair report, the complete current
diff from certified Wave 5 `81553fc`, and exact TypeScript authority. Do not
edit, commit, or push. This is Wave 6 of 7, Phase 2 of 3, unit 14 of ~18;
Wave 7 and all Phase 3 integration remain.

Initial full verifiers both failed:

- Sol `20260725-023658-adae38`;
- Copilot-Fable `20260725-023658-bedeab`, session
  `f102b356-860a-4856-93ad-3fe259e3d870`, verified
  `claude-fable-5` medium.

Repair-r1 `20260725-025527-b4d1d6` closed the mechanical findings but the
orchestrator rejected its producer proof: the counted consumer called newly
public config/receipt/budget helpers and `replace_view_snapshot` rather than
the actual `thread_view::compact` chain. Repair-r2 must be judged against
`phase2-fix2-wave6.md`, not the repair-r1 report's overstated mutation table.
Repair-r2 `20260725-032731-7a270a` repaired the compact/config/source-state
paths, but the orchestrator independently proved its single selection-budget
mutation was incomplete: separate smooth, detailed, and brief call-site
mutations to `0.0` all left the counted consumer green. Judge the final tree
against `phase2-fix3-wave6.md` and `phase2-fix4-wave6.md`. Repair-r3 made the
four band call sites separately load-bearing, but replaced the fractional
selection row with an all-integral profile; the orchestrator then proved
`lower_bound.trunc() * share.trunc() / 100` left the counted consumer green.
Require both four separately red call-site mutations and a separately red
fractional-selection truncation mutation.

The r4 confirmation then disagreed on integer readers: Sol
`20260725-040456-03703f` and the orchestrator found executable rounded-bound
patterns in `internal/boundary.rs` and `thread_view/mod.rs`; Copilot-Fable
`20260725-040456-301c90` returned PASS after probing only the repaired
snapshot/select lane. Judge the final tree against `phase2-fix5-wave6.md`.
Directly probe boundary position, boundary aggregate, and prune/zone paths at
REAL `2^63`; reject a source grep or snapshot-only probe as proof.

Confirm the union was repaired, not merely the gate:

1. One shared Node-compatible JavaScript number lane serves profiles, prune,
   stored config, receipt, describe, render/nullish conversion, and all other
   numeric interpolation/value producers. No local formatter remains. Probe
   `-0`, integrals, fractions, `0.30000000000000004`, `NaN`, `±Infinity`,
   the `1e-6` boundary/below/min-subnormal cases, and reachable `±1e21`
   exponent spelling. Amendment I makes the old `|x| >= 1e21` “unreachable”
   divergence obsolete for profile config; confirm the ledger supersedes it.
2. Regenerate the profile-number fixture twice. Its Node generator must build
   the current TS package and drive actual resolution, selection, compact,
   raw SQLite config, receipt, describe, and the lowest real inspect/view
   producer available before Wave 7. Reject hand-built budgets/config/report
   objects. Report row count/hash and precise Wave 7 inspect boundary.
3. The existing counted Rust consumer must drive actual production
   resolution/selection, compact snapshot writer, raw SQLite read, snapshot
   reader/describe, receipt, and the lowest real inspect producer available.
   Reject direct `StoredViewConfig`, `CompactReceiptConfig`, or
   `ViewContentsMetaConfig` construction as proof of those paths.
4. Independently mutation-test merge, selection, stored writer, snapshot
   reader, receipt, describe/available inspect propagation, shared number
   spelling, and non-empty nested `derivationCounts`. Every applicable
   producer must make the counted consumer red; identify honest Wave 7-only
   paths rather than claiming them. Specifically mutate the source-state
   construction inside the actual `compact` body to empty/flatten/sum the map;
   mutating only `parse_stored_source_state` is reader coverage, not writer
   coverage. Mutate the full, smooth, detailed, and brief production budget
   call sites separately; each must turn a Node-generated observable
   `select_arrangement` assertion red. Also mutate the selection budget lane
   back to integer truncation/casts; an all-integral branch-coverage profile
   is insufficient for Amendment I unless a separate fractional selection row
   makes that truncation red. Reject local budget-formula objects.
5. Confirm lifecycle profile mirrors are `f64` with only invalid `Eq` removed;
   closed band/budget/`RenderingPartKind` matches are exhaustive; and the new
   Wave 6 Clippy residue is gone.
6. Probe lexical Node `path.resolve` parity for relative/absolute `.`, `..`,
   repeated separators, root saturation, empty input, and symlink-containing
   paths without canonicalization/dereference.
7. Corrupt all Wave 6 integer readers with integral SQLite reals, fractions,
   non-finite/out-of-range values, and malformed JSON. Exact integers alone
   may enter event-order/count/token integer domains; no truncating/saturating
   cast. Explicitly prove `2^63` is rejected rather than passing the rounded
   `i64::MAX as f64` check.
8. Exercise the live abort getter at every TS checkpoint and rollback/failure
   stage in disposable probes; mutation to a snapshotted/always-false signal
   must fail the evidence.
9. Audit ledger/report honesty, exact cleanup, immutable tests/goldens/oracles,
   the 102 owning census, and exact `169/312/0/15 = 496` arithmetic unless
   genuinely unlocked production behavior proves a different named delta.
   Confirm no oracle-only public helpers (`budget`, config/receipt builders,
   `path_resolve`/lexical probes) expanded the frozen Rust surface.

Run fmt/check/clippy, the eleven owning suites, lifecycle collection,
JS-JSON/profile/date/prompt oracles, prompt bytes, immutable hashes, and the
full gate. Use unique scratch, mutation only in isolated copies, and clean only
your artifacts. Return PASS/FAIL with numbered file:line findings, every
mutation outcome, exact commands/counts/hashes, coverage, and cleanup.
