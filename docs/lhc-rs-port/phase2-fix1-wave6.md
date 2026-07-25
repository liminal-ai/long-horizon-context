# Phase 2 Wave 6 repair round 1 — Amendment I contract fidelity

Resume the established Cursor implementation session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, from the uncommitted Wave 6 implementation based on certified
Wave 5 commit `81553fc`. This is Wave 6 of 7, Phase 2 of 3, unit 14 of
approximately 18. Do not commit or push. Preserve the four root
`cc-lhc-*.txt` files and clean only your artifacts.

Read the binding Amendment I ruling, implementation brief, both verifier
reports when supplied, and this orchestrator adjudication. Fix every item
below without adding a test/ignore/allowlist name, changing assertion meaning,
touching goldens, or changing the 496 denominator. Test-side edits are limited
to the approved existing-counted-test production-path extension, mechanical
`f64` mirror widening, and exact fixture-body implementation already in scope.
Update the Wave 6 report and `PORT_STATUS.md` so claims describe evidence
actually present.

Initial full-scope Sol verification `20260725-023658-adae38`: **FAIL**.
Its isolated mutation table and path probe are binding evidence incorporated
below. Independent Copilot-Fable verification
`20260725-023658-bedeab`, session
`f102b356-860a-4856-93ad-3fe259e3d870`, verified
`claude-fable-5` at medium effort: **FAIL**. Its findings agree with Sol on
the weak producer oracle, lifecycle mirror, closed matches, and inaccurate
ledger, and identify additional local number helpers incorporated below.
Treat the union of both reports as binding; this is not a vote.

## 1. Use one shared JavaScript number-string implementation

`src/thread_view/internal/profiles.rs` currently defines a private
`js_spell_number`; `src/thread_view/mod.rs` independently defines
`js_string_of_f64` and `js_number_value`; and
`src/thread_view/internal/render.rs` duplicates
`chunk_recovery::js_string_nullish`. These directly violate Amendment I's
requirement to share the certified number lane and the
implementation/verification briefs' explicit rejection of local formatters.

- Move the JavaScript `String(number)` behavior into the shared numeric/JSON
  implementation and call it from profiles, prune diagnostics, stored-config
  writing, and every other numeric interpolation/value producer. Share the
  nullish JavaScript string conversion as well; leave no second implementation
  in `thread_view`.
- It must spell `-0` as `0`, finite integrals without `.0`, fractions with
  Node-compatible shortest spelling, `NaN`, `Infinity`, and `-Infinity`.
  Amendment I makes profile numbers an open finite `number` domain, so the
  old shared-JSON note that `|x| >= 1e21` is unreachable is no longer true:
  cover Node's `1e+21` / `-1e+21` exponent spelling both in diagnostics and
  in an actual valid stored `lowerBound` config. Remove or narrow that stale
  divergence rather than retaining a formatter that disagrees on reachable
  inputs.
- Do not obtain non-finite spelling by constructing
  `serde_json::Value::from(f64)`: serde maps those values to JSON `null`.
- Preserve and rerun the committed JS-number oracle, including its
  small-exponent boundary cases. Add Amendment I diagnostic rows to the
  sanctioned profile-number fixture rather than adding a test or changing
  the denominator. The current 22 rows omit the ruling's required
  `-Infinity` diagnostic and a genuine floating sum-artifact spelling case;
  add both, plus reachable positive/negative large-exponent spelling and a
  valid large-exponent persisted lower bound (alongside the existing `-0`,
  `NaN`, positive `Infinity`, integral, and fractional rows).
- Remove the ledger's current inaccurate statement that a private helper is
  shared merely because its finite branch calls `js_json_stringify`.

## 2. Make the Node oracle exercise actual TypeScript producers

`scripts/gen-profile-number-fixtures.mjs` currently calls the real TS
`resolveViewConfig` and `selectArrangement`, but manually implements
`budgets`, `storedConfigJson`, `receiptConfigJson`, and
`inspectMetaConfigJson`. Those helper reconstructions are not the binding
brief's required actual resolution/selection/compact producer chain.

- Generate the persisted config and compact receipt through the real TS
  compact path, backed by a disposable thread database.
- Read the raw persisted `config_json` from SQLite.
- Obtain receipt config from the real compact return.
- Obtain describe config from the real `describe`/stored-snapshot path.
- Obtain inspect meta config from the real inspect/view producer available at
  this wave boundary; if the final inspect composition is genuinely Wave 7
  blocked, use the lowest real shared producer and state the precise boundary
  instead of synthesizing the object.
- Preserve the real TS resolution, partial-merge, validation-diagnostic, and
  truncation-sensitive selection rows.
- Build the TS package as required before generation, or otherwise import the
  authoritative current TS sources in a reproducible way; do not silently
  consume an unspecified stale `dist` tree.
- Double-regenerate byte-identically and record the new row count and SHA-256.

## 3. Make the existing Rust test consume real Rust producers

The extension inside
`view_fixture::uninstalled_the_point_is_a_no_op` currently directly
constructs `StoredViewConfig`, `CompactReceiptConfig`, and
`ViewContentsMetaConfig`, and manually recomputes budgets. This does not prove
the writer, reader, receipt, describe, or inspect propagation paths named by
the ruling.

Fable's isolated mutations independently confirmed that truncating the
stored-config writer, coercing the snapshot reader, coercing the receipt, or
flattening/summing `derivationCounts` all survive the current consumer.

- Drive the fixture rows through actual production resolution/selection,
  compact snapshot writer, raw SQLite read, snapshot reader/describe, compact
  receipt, and the lowest real inspect producer available at the Wave 6
  boundary.
- Assertions must fail independently when merge, selection operands, config
  writer, config reader, receipt/describe/inspect propagation, or the shared
  JavaScript number lane is mutated.
- Keep this inside the same already-counted test. Add no `#[test]`, ignore,
  allowlist name, or denominator change.

## 4. Widen the remaining Amendment I test mirror

`tests/fixtures/lifecycle.rs` still defines
`LifecycleProfilePercentages::{full,smooth,detailed,brief}` and
`LifecycleProfile.lower_bound` as `i64`, with `Eq` derives. This is the
remaining integer boundary found by the full source/test census.

- Widen those five fields and literals to `f64`.
- Remove only the now-invalid `Eq` derives; retain the other lawful derives.
- Do not implement the Wave 7 lifecycle SDK bodies early.

## 5. Remove closed-vocabulary wildcard matches

The governing Rust convention bans `_ =>` arms on closed vocabularies.
`profiles.rs` currently routes the closed `BAND_KEYS` and `BUDGET_KEYS`
through `&str` matches with wildcard `unreachable!` arms. The changed Wave 6
modules also need a complete census of enum/closed-kind matches (including
the `RenderingPartKind` matches in session/render paths).

- Replace closed string dispatch with typed/direct field access where
  appropriate.
- Spell every variant explicitly when matching a closed enum, including
  variants that intentionally share the TypeScript default behavior.
- Keep wildcard/default behavior only for genuinely open runtime JSON/string
  input, and cite the matching TypeScript default in the report.

## 6. Remove Wave 6's new Clippy residue

The orchestrator's post-implementation `cargo clippy --tests` found a new
Wave 6 warning at `src/thread_view/internal/select.rs` for
`filter(..).next_back()`. Use the equivalent `rfind(..)` form without changing
selection order or behavior. Do not expand this into cleanup of carried
warnings outside the Wave 6 diff.

## 7. Implement lexical Node `path.resolve` normalization

`src/thread_view/internal/materialize.rs::path_resolve` uses
`std::path::absolute`, which makes a path absolute but does not lexically
collapse `.` / `..`. Sol's isolated probe demonstrated:

```text
Rust a/../b    -> /srv/work/long-horizon-context/a/../b
Node a/../b    -> /srv/work/long-horizon-context/b
Rust /x/../y   -> /x/../y
Node /x/../y   -> /y
```

Implement Node-compatible lexical resolution for Rust's supported host
platform without filesystem canonicalization or symlink dereference. Cover
relative and absolute `.`, `..`, repeated separators, root saturation, empty
input, and symlink-containing paths in disposable probes against live Node.
Preserve bare underlying filesystem failures.

## 8. Reject fractional corruption in integer domains

`src/thread_view/internal/snapshot.rs` currently accepts `f64` database/JSON
values and casts them to `i64` in `map_required_i64`,
`sourceState.maxEventOrder`, and nested derivation counts. A corrupt `1.5`
silently becomes `1`. Amendment I explicitly keeps these as integer domains;
it does not authorize truncation.

- Accept exact integer representations only.
- Reject fractional, non-finite, and out-of-range values as corruption with
  the governing bare/typed failure behavior; never coerce by `as i64`.
- Audit every Wave 6 integer reader for the same pattern without widening the
  domain to `f64`.
- Probe exact integers, integral SQLite reals if the TS runtime accepts them,
  fractions, boundaries, and malformed JSON against the TypeScript behavior.

## 9. Mutation-prove nested source state and live abort reads

Sol's isolated mutations found:

- replacing persisted nested `derivationCounts` with an empty map left the
  counted oracle test green because its selection input uses an empty map;
- forcing `compact_stopped` false left the only active host-agnostic test
  green, while SDK-driven abort tests remained honest Wave 7 blockers.

Repair the evidence without changing the denominator or implementing Wave 7:

- Make the sanctioned production-chain fixture use a non-empty multi-type,
  multi-state derivation-count map and prove writer/readback bytes and shape.
  Mutations that flatten, sum, empty, reorder incompatibly, or bypass the
  shared JSON lane must turn the counted consumer red.
- Use isolated disposable probes to exercise `CompactAbortSignal` re-reads at
  pre-compute, chunk-material, pre-write, preview, and failure/rollback stages.
  Mutating `compact_stopped` or snapshotting the signal must turn those probes
  red. Do not commit a new test, alter an existing assertion's meaning, or
  implement `init_lhc` early.
- Keep the pre-existing Wave 7 abort imports/bodies intact; do not delete them
  merely to silence carried unused-import warnings.

## Required evidence

Run fmt/check/clippy, the owning eleven Wave 6 suites, lifecycle collection,
JS-JSON tests, prompt/date/oracle tests, immutable golden hashes, and the full
gate. Report exact arithmetic against `81553fc`. Include the generator command,
double-regeneration hash, raw SQLite bytes, receipt/describe/inspect evidence,
lexical path parity, fractional-corruption rejection, live-abort stages, and
independent mutation results for every producer named above. Correct every
overstated Amendment I / production-producer / lexical-path claim in
`PORT_STATUS.md` and the Wave 6 report. Real inspect composition remains an
honest Wave 7 boundary in `inspect/internal/view_report.rs`; state that
boundary instead of claiming coverage that cannot yet exist. The target
remains 496 classified, `wrong=0`, `suspicious=0`; no commit/push.

The final report must explicitly reconcile Fable's mutation matrix: merge
truncation, selection truncation, non-finite diagnostic spelling, and the
shared JS-JSON mutation already turned the consumer red, while stored writer,
snapshot reader, receipt, and nested derivation-count mutations survived
before this repair. Re-run all eight after repair and report each outcome.

Exact cleanup assignment: remove the orchestrator comparison artifacts
`/tmp/lhc-ts-profiles-current.txt` and
`/tmp/lhc-rs-profiles-current.txt`, plus only scratch created by this repair;
confirm each named path is absent. Do not general-clean `/tmp`.
