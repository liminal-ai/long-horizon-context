You are the IMPLEMENTOR for Wave 6 repair round 2 of the lhc-rs Phase 1
port. Resume Cursor session `69ec5846-0977-405e-9d43-066a29883440` in
explicit fast mode. Repo `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, baseline `c083f4d`. Do not commit or push. Work only in
`packages/lhc-rs/` and the Wave 6 ledger entries. Do not touch the four
untracked root `cc-lhc-*.txt` files.

Read `docs/lhc-rs-port/fix1-wave6.md`, both repair-r1 verification reports
if available through their session output, and the complete TS counterparts.
Both Sol and Fable returned FAIL after repair-r1. Their accepted residuals are
consolidated below. Keep all round-1 repairs and binding adjudications intact.

## 1. Complete the diagnostic literal inventory

The repair-r1 instruction said **every** static render/diagnostic fragment
inside Phase 2 todo bodies must be preserved as real private constant data.
Complete that inventory byte-for-byte from TypeScript, including punctuation
and spacing. Dynamic inserted values remain function inputs; hoist the static
prefix/middle/suffix pieces.

At minimum audit and complete:

- `internal/profiles.rs`: all profile, visibility, unknown-budget, and
  compact-threshold validation diagnostic fragments from `profiles.ts:40-163`;
- `internal/render.rs`: all three complete fallback-reason templates from
  `render.ts:208-214,246-252,284-290`;
- `internal/select.rs`: canonical-corruption and coverage-gap diagnostic
  fragments from `select.ts:125-168,302-305,507-515`;
- `thread_view/mod.rs`: operation/storage, prune validation/boundary,
  unknown-profile, compact-stop, and materialize diagnostics from
  `index.ts:64-76,105-117,189-190,232-251,378-379,424-449,543-544,
  612-613,691-692,740-746`;
- `internal/compact_compute.rs`, `boundary.rs`, and `snapshot.rs`: every
  diagnostic fragment in the TS counterparts, including
  `"thread_metadata singleton row missing (creation writes it)"`.

Re-inventory all Wave 6 source/fixture files rather than treating this list as
exhaustive. Do not author new wording.

## 2. Closed/ordered representations

1. Replace `PI_MAPPABLE_KIND_SET: HashSet` with an insertion-ordered
   `IndexSet<&'static str>` collected directly from
   `PI_MAPPABLE_MESSAGE_KINDS`. TS `Set` preserves declared insertion order.
2. Replace `select::chunk_material`'s widened `&str` derivation type with a
   private two-variant closed enum for `chunk_summary_detailed` and
   `chunk_summary_brief`, with exhaustive exact `as_str()`.

## 3. Remove invented aggregate exports and dead keepalives

1. Remove `MaterializeResult` from `sdk.rs` aggregate re-exports. Keep the
   single canonical type and its `thread_view` owner/re-export; sdk.ts's
   materialize method uses an anonymous return shape and does not export the
   named type.
2. Remove from `tests/fixtures/mod.rs` aggregate exports:
   - `ParsedSession`;
   - `BlockedSiblingResult`;
   - `CorruptedVariantResult`.
   Keep required public Rust return-shape types addressable at their owning
   module paths.
3. Remove Wave 6's dead `const _` keepalive declarations, `_default_*`
   keepalive helper, and imports used solely by them throughout:
   `thread_view/mod.rs`, all ten internals, Wave 6 fixtures, and Wave 6 tests.
   The helper/type/constant declarations themselves remain. Do not replace
   the keepalives with other artificial references.
4. Specifically remove `view_compact.rs`'s unused
   `LlmRequestContextRole` import and final keepalive const.

## 4. Residual test/fixture fidelity

1. `view_render_targets.rs`: replace the two `unwrap_or("")` snapshot-field
   fallbacks with `expect(...)`; TS directly requires both selected fields.
2. `view_boundary.rs`: suite-local `tokens(n)` must return empty for zero and
   panic for negative input, matching JS `Array(n)`/the repaired fixture.
3. `view_render_targets.rs`: remove the added `marker_lines > 0`
   anti-vacuous assertion; preserve assertion-for-assertion TS fidelity.
4. `pi_session_format.rs`:
   - mirror JS `typeof [] === "object"` diagnostic flow for malformed arrays
     so they reach the later role/key-set failure instead of inventing an
     earlier “an object” error;
   - fold a non-object reference fixture message into TS's
     `"pi-session-structure fixture message has no content blocks"` path;
   - avoid invented JSON-parse wrapper wording where a direct serde parse
     error can be propagated/panicked without a Rust-authored diagnostic.
5. Re-export canonical `ViewContentsReport` from `sdk.rs`, since sdk.ts does.
   This is a canonical existing type, not a duplicate. Record that broader
   non-view SDK/root completion still belongs to Wave 7.
6. Leave the pre-baseline `DrainOpts: Default` decision for the Wave 7 full
   SDK audit; note the deferral in the ledger rather than reshaping unrelated
   committed scope during Wave 6.

## 5. Ledger

Revise the Wave 6 round notes honestly:

- both repair-r1 re-verifiers returned FAIL;
- record repair-r2 decisions above;
- do not claim full surface/literal completion until the changes exist;
- retain exact `367 -> 465 -> 472` todo history and report any justified
  repair-r2 delta;
- keep Wave 6 **not certified**.

## Verification

Run:

```text
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
```

Also reconcile the exact 101 tests/two ignored bodies, byte-compare all seven
immutable assets, run both seam tests repeatedly under default parallelism,
and use isolated probes for:

- ordered `PI_MAPPABLE_KIND_SET`;
- strict golden unknown-field rejection;
- fractional visibility values;
- negative suite-local tokens panic.

You own cleanup of only exact temporary paths you create. Report every path
created/removed. Do not perform general cleanup or delete anything else.

Final response: per-finding disposition, changed files, exact gate output,
test/asset/probe evidence, remaining Phase 2 limitations, and cleanup. No
commit or push.
