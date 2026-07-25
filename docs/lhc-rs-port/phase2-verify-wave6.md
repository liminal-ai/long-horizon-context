# Phase 2 Wave 6 full verification — thread view

Independent read-only audit in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Read governing docs, ledger, Wave 6 report, full diff from
certified Wave 5, every matching TS source/test, and the earlier Rust Phase 1
`{fix1,fix2,fix3}-wave6.md` repair record plus verification/confirmation
sequence. Treat its
surface/diagnostic/closed-type findings as regression targets, while
Amendment C supersedes its historical 101-case arithmetic. Do not
edit/commit/push. Wave 6 of 7, Phase 2 of 3, unit 14 of ~18.

1. Tests/data/goldens/oracles immutable; fixture changes exact TS-owned. Hash
   every golden before/after. Flag public reshapes, compatibility traits,
   later Wave 7 work, wildcard closed matches, hardcoded golden text, and
   test-shaped routing.
2. Fully audit selection math/order/bands, profiles, visibility budgets,
   token estimates, corruption, empty maps/arrays, JS rounding/min/max/modulo.
   Confirm binding Amendment I (Copilot-Fable `20260725-020940-6c4d05`, Sol
   `20260725-021347-3389b2`) across the complete `f64` chain: public/shared
   profiles and overrides, compact params, selection operands and
   full-side-token comparisons, stored config, receipt, describe, and inspect.
   Include `lowerBound:12.5` / `12.5,47.5,20,20`, budgets
   `1.5625,5.9375,2.5,2.5`, and JS diagnostics for `-0`, non-finite,
   integral, fractional, and sum-artifact values. No integer coercion,
   compatibility type, float map key, or unrelated integer-domain widening.
   Verify diagnostic interpolation shares the certified numeric spelling
   implementation: `serde_json::Value::from(NaN/Infinity)` becoming JSON
   `null` is not `String(number)` parity, and a profiles-local duplicate
   formatter is also rejected.
   Confirm phase-gate addendum I and the unchanged 496 denominator.
3. Regenerate `scripts/gen-profile-number-fixtures.mjs` →
   `fixtures/profile-number-cases.jsonl` byte-identically and verify its
   existing-counted-test consumer exercises actual producers for integral and
   fractional resolution/merge, validation diagnostics, selection changes,
   raw SQLite config, receipt, describe, and inspect bytes. Independently
   mutate merge, selection, writer, reader, receipt/describe/inspect
   propagation, and the shared JS-JSON lane; every mutation must turn the
   oracle red.
4. Byte-compare render/assemble/snapshot against all goldens and live TS
   non-golden probes: degraded bands, empty turns, Unicode/astral, excerpts,
   diagnostics, block kinds, malformed state, exact separators/newlines.
   Escape-aware inventory every static diagnostic fragment; confirm ordered
   `PI_MAPPABLE_KIND_SET` and the closed two-variant chunk-material choice.
5. Mutation-probe compact thresholds, preview no-write, actual writes, live
   abort getter re-reads at every stage, inference/drain interaction, and
   rollback/cleanup on abort/throw/storage error.
6. Audit turn-end/full boundary selection and every sync/background producer.
7. Probe seam callback lock freedom, reentrancy, crash rollback, exact call
   counts, teardown, and parallel isolation.
8. Verify prune numeric boundaries/order/cascade/rollback and no collateral
   deletion.
9. Verify session/materialize PI v3 bytes, source mappings, path/result/error
   shapes, lexical absolute path resolution without symlink dereference,
   filesystem atomicity, malformed-array `Object.keys(array).sort()` lexical
   index diagnostics (`0,1,10,2,...`), bare underlying filesystem/JSON
   failures, and cleanup.
10. Verify every public view surface plus status/describe counts consumed later
   by inspect, without implementing Wave 7 composition.
11. Inspect all new greens and remaining real Wave 7 boundaries; audit ledger,
    Amendments A–D, persisted bytes, counts, warnings, and cleanup.

Recheck the Phase 1 surface decisions: canonical `ViewContentsReport`, no
invented aggregate materialize/fixture exports or dead keepalives, and no
premature `DrainOpts: Default` reshape.

Explicitly mutation-probe the Python-port Wave 6 lessons: stored
`sourceState.derivationCounts` remains the nested derivation-type → state →
count map (no flatten/sum), and every served/stored JSON number is routed
through the committed Node-compatible `js_json` lane. Re-run its `1e-6`,
immediately-below-boundary, `1e-7`, signed/non-unit small-exponent, and minimum
subnormal oracle cases.

Use unique backend/session scratch and isolated temporary copies for
mutations. Never create a probe suite or mutate source in the shared
repository; clean only your artifacts. Mutation-proof every named
producer/path.

Run fmt/check/clippy, all eleven owning suites (102 collected: 100 active + 2
TS-mirroring ignores), lifecycle and newly unlocked suites, prompts, JS-JSON,
prompt bytes, golden hashes, and full gate. Reconcile against certified Wave 5
baseline `81553fc`: total 496, `wrong=0`, `suspicious=0`, exact green
arithmetic; final target `481/0/15 = 496`.

Wave 5 preflight for those 102 was 2 already-allowlisted seam passes, 98
active notimpl cases, and 2 ignores. Inspect every new green, but accept honest
Wave 7 SDK first blockers rather than test-shaped routing.

Return PASS/FAIL with numbered file:line findings, TS probes/mutations,
golden/abort evidence, exact suites/gate, immutable audit, coverage, cleanup.
