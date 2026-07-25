# Phase 2 Wave 6 implementation — thread view

Resume the established Cursor implementor session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, from certified Wave 5 commit `81553fc`. This is
Wave 6 of 7, Phase 2 of 3, unit 14 of approximately 18—the largest remaining
library wave. Wave 7 and all Phase 3 integration still follow.

Read the onboarding, amended Phase 2 brief, ledger, certified Wave 5
diff/rulings, all matching TS sources/tests, and Python
`p2-{impl,verify,fix1}-wave6.md` for lessons. TS and Rust rulings govern.
Also read the earlier Rust Phase 1 Wave 6 repair record
`{fix1,fix2,fix3}-wave6.md` and its verification/confirmation sequence: it
inventories the missing private helpers, static diagnostic fragments, ordered/closed
representations, canonical exports, and dead-keepalive failures that the
behavioral implementation must not reintroduce. Its historical 101-case
arithmetic is superseded by Amendment C and the 102-case census below.

Do not commit/push or edit tests, assertions, cases, data, goldens, or oracles.
Goldens are especially immutable: never regenerate them. Direct fixture bodies
may be implemented faithfully. Preserve root `cc-lhc-*.txt`; own cleanup.
At start, remove the exact carried orchestrator check log
`/tmp/lhc-wave5-r2-clippy.log` and confirm it is absent; do not general-clean
`/tmp`.

**Binding Amendment I:** independent Copilot-Fable
`20260725-020940-6c4d05` and Sol `20260725-021347-3389b2` both ruled
`FRACTIONAL AMENDMENT I`. The old Phase 1 `i64` carve-out was a factual
mis-inference from integral fixtures: TypeScript accepts, computes with,
persists, and serves fractional `lowerBound` and profile percentages. Apply
the complete correction below and record phase-gate addendum I. The only
sanctioned test/oracle changes are mechanical integer-literal widening needed
to compile canonical `f64` fields, a production-path extension of one existing
counted Wave 6 test, and the Node generator/fixture named below. Do not change
assertion meaning, add a test/ignore/allowlist entry, or touch goldens.

## Scope

Implement all behavior in `src/thread_view/mod.rs` and:

- `internal/assemble.rs`
- `internal/boundary.rs`
- `internal/compact_compute.rs`
- `internal/materialize.rs`
- `internal/profiles.rs`
- `internal/render.rs`
- `internal/seam.rs`
- `internal/select.rs`
- `internal/session_view.rs`
- `internal/snapshot.rs`

Implement directly required `tests/fixtures/{lifecycle,view_boundary,
view_seam,view_thread}.rs` bodies against their TS fixtures. SDK construction
remains Wave 7 unless an existing host-agnostic helper is the exact direct
dependency; no test-shaped routing to manufacture greens.

The eleven owning view suites total 102 tests (100 active + 2 TS-mirroring
ignores):
`view_boundary_turn_end` 2, `view_boundary` 8 (7 active + 1 ignore),
`view_compact_full_boundary` 9,
`view_compact_preview` 13, `view_compact` 17, `view_fixture` 13,
`view_llm_request_context` 15 (14 active + 1 ignore), `view_prune` 8,
`view_render_targets` 5, `view_select_golden` 4,
`view_session_thread_view` 8. Preserve the two TS-mirroring ignores. Re-run
lifecycle (7), chunk recovery, messages read, mutations, and all newly
reachable prior-wave suites.

The ledger's Wave 6 overview still says 101 and its suite-table
`view_boundary` note still says “7 tests (1 ignore)”; correct both to 102
total and 8 total / 7 active / 1 ignored respectively. This is the already
approved Amendment C unfolded case and does not change the 496 denominator.

Orchestrator preflight at the Wave 5 tree collected the same 102: the two
allowlisted `view_fixture` seam tests pass, 98 active cases stop at honest
view/fixture/SDK `todo!("phase 2")` boundaries, and 2 are ignored. Do not
claim a +98 gate delta unless each case genuinely clears its first boundary;
SDK-built cases may remain Wave 7-blocked even after all Wave 6 production
bodies are real.

## Fidelity

- Selection bands full/smooth/detailed/brief: exact profile percentages,
  visibility budgets (`f64` where ruled), JS rounding, token estimates,
  stable order, corruption errors, empty collections, and map structure.
- Apply Amendment I without a truncating boundary:
  - `shared_tech/view.rs`: `ViewProfilePercentages` leaves,
    `PartialViewProfilePercentages` leaves, `ViewProfile.lower_bound`,
    `ViewProfileOverride.lower_bound`, `ViewCompactParams.lower_bound`,
    `StoredViewConfig` lower-bound/percentage values, and all five
    `CompactReceiptConfig` values become `f64` / `Option<f64>`;
  - `shared_tech/inspect.rs::ViewContentsMetaConfig` lower-bound/percentage
    values become `f64`;
  - `select::SelectionConfig.lower_bound`, `budget` operands, and
    `straddling_turn_stays_in_full`'s full-side token operand are fractional;
    token estimates, event orders, compact points, entry counts, and stored
    token counts remain integer domains;
  - profiles, compact resolution, snapshot write/read, receipt, describe, and
    inspect propagation preserve fractions verbatim. Remove incompatible
    `Eq` only from widened test mirrors; add no wrappers, float keys, aliases,
    or parallel integer types.
  Node v24.18.0 accepted and preserved `lowerBound:12.5` with
  `full:12.5,smooth:47.5,detailed:20,brief:20`; budgets are
  `1.5625,5.9375,2.5,2.5`. Diagnostics must match JS interpolation including
  `-0 → 0`, `NaN`, `Infinity`, integral floats without `.0`, and fractions,
  reusing the certified shared number lane rather than adding a formatter.
- Commit `scripts/gen-profile-number-fixtures.mjs` →
  `fixtures/profile-number-cases.jsonl`, generated through actual TS
  resolution/selection/compact paths. Cover integral/new/partial fractional
  profiles, valid and invalid sums/non-finite values with exact diagnostics,
  a selection changed by truncation, budget values, raw SQLite `config_json`,
  receipt config, describe config, and inspect meta config bytes. Extend one
  existing counted Wave 6 test to consume every row through production
  producers. Double-regenerate byte-identically. Record the fixture hash and
  Amendment I in `PORT_STATUS.md` and the Wave 6 commit body.
- Render/assemble/snapshot output byte-for-byte: every label, separator,
  newline, marker, diagnostic, excerpt, block, and band. Use UTF-16 helpers
  for JS length/slice. Golden files stay untouched; probe non-golden degraded,
  empty, Unicode/astral, corrupt, and boundary shapes against TS.
- Re-inventory every static TS diagnostic fragment in profiles/render/select/
  compact/boundary/snapshot/surface; use exact punctuation and spacing. Keep
  `PI_MAPPABLE_KIND_SET` insertion-ordered from its canonical array, and keep
  chunk-material derivation choice as the recorded closed two-variant type.
- Compact compute: thresholds, preview versus actual, abort checked live at
  every TS-equivalent point through `CompactAbortSignal`, write boundaries,
  inference/drain interaction, and no partial state on abort/failure.
- Boundary selection includes turn-end and full-boundary semantics exactly.
- Seam callbacks clone under lock and fire outside; crash hooks cause exact
  rollback/cleanup. Mutation-test every synchronous/background producer.
- Prune validates integer/f64 boundaries, target tokens, ordering, and
  transactional deletes/cascade effects.
- Session view/materialize produce exact PI session v3 bytes, source-message
  mappings, ordering, path/result shapes, and explicit file/DB cleanup.
- PI-session malformed arrays follow JavaScript
  `Object.keys(array).sort()` lexical index ordering (`0,1,10,2,...`) in
  diagnostics; propagate underlying filesystem/JSON failures without invented
  wrapper wording.
- Persist `sourceState.derivationCounts` as the TS runtime's nested
  derivation-type → state → count map verbatim; never flatten/sum it. This was
  a shipped Python Wave 6 defect found by both verifiers. Stored/view JSON must
  use `shared_tech::js_json` so integral floats, small exponents (`1e-6` /
  `1e-7` boundary), and non-finite leaves follow the committed Node contract.
- Materialize output paths use lexical absolute resolution like
  `node:path.resolve`; do not canonicalize/dereference symlinks.
- Surface `status`, `describe`, `compact`, `preview_compact`, `prune`,
  `get_llm_request_context`, `get_session_thread_view`, and `materialize`
  preserve result/error shapes and supply Wave 7 inspect without prebuilding
  inspect composition.
- Audit JS `??`, min/max on empty arrays, modulo sign, stable sort, JSON bytes,
  ISO-ms, UTF-16, and rounding. No hardcoded golden fragments or test-shaped
  branches.
- Preserve the Phase 1 export rulings: canonical `ViewContentsReport` only,
  no invented aggregate `MaterializeResult`/fixture exports, no dead
  keepalives. Re-audit the deferred `DrainOpts: Default` decision in Wave 7,
  not by widening this wave.

## Evidence

Use unique disposable scratch and clean:

- byte-compare all committed goldens without changing them;
- live TS probes for non-golden degraded bands, empty turns, astral text,
  threshold edges, boundary/end cases, PI-session bytes;
- abort flips through a live getter at each stage, preview no-write proofs,
  seam failure injection and transactional rollback;
- concurrent compact/prune/status/materialize and callback reentrancy;
- raw SQLite/view snapshot before/after/corruption matrices;
- mutation every producer/path behind broad claims.
- Amendment I mutations must independently kill merge truncation, integer
  selection operands, stored-config writer truncation, reader coercion,
  receipt/describe/inspect coercion, and bypass of `shared_tech::js_json`.

Run fmt/check/clippy, all owning/prior-unlocked suites, lifecycle, prompts,
JS-JSON, prompt bytes, golden byte checks, and full gate. Inventory 496; the
**Phase 2** final target is `481/0/15`, not a license to bypass honest Wave 7
SDK blockers in this wave. The certified Wave 5 gate at launch is the
no-regression baseline. Require reconciled 496, `wrong=0`, `suspicious=0`.

Ledger exact files/behavior, green names/arithmetic, Wave 7 blockers, abort and
golden evidence, immutable audit, warnings, cleanup, no commit/push. Keep Wave
6 **not certified** pending Sol and Copilot-Fable.
