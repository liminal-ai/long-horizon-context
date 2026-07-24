You are the INDEPENDENT SOL RE-VERIFIER for Wave 6 repair round 1 of the
lhc-rs Phase 1 port. VERIFICATION ONLY: do not edit, commit, push, or delete
repository files. Repo `/srv/work/long-horizon-context`, branch
`lhc-rs-port`; audit all Wave 6 changes against baseline `c083f4d`.

Read:

- `docs/lhc-rs-port-phase1-brief.md`
- `docs/lhc-rs-port/impl-wave6.md`
- `docs/lhc-rs-port/fix1-wave6.md`
- `packages/lhc-rs/PORT_STATUS.md`
- the complete TypeScript sources/tests

The repair brief contains the orchestrator's binding adjudications. In
particular, do not reopen Wave 1's `i64` ruling for `lowerBound`/profile
percentages or Wave 5's by-value Phase 1 abort-snapshot ruling. Verify that
their limitations are honestly recorded. Everything else remains adversarial.

Audit the complete repaired scope:

1. SDK has the complete canonical view vocabulary required by `sdk.ts`,
   without duplicates; Wave 7's broader root-export pass remains separate.
2. All ten internals and `thread_view/mod.rs` contain every TS export and
   private helper/closure with faithful Rust-native signatures. Check the
   previously omitted select closures, `flushAssistant`, `entriesByBand`,
   `PI_MAPPABLE_KIND_SET`, transaction constants/`RawViewRow`, and every
   render/diagnostic literal byte-for-byte. Search for additional omissions.
3. Visibility `maxTokens`/`targetTokens`, `compactThreshold`, and their
   directly derived status/prune chain are fractional-capable without
   truncation. Explicit prune input still rejects non-integers. Confirm
   `lowerBound`/profile percentages were not reshaped.
4. Error-only constructors are generic and closed where appropriate.
   `select_arrangement` preserves `CanonicalCorruptionError` and the public
   computation maps it as TS does. One canonical abort-signal type is used.
5. Invented `MaterializeFormat`, internal aggregate re-exports, public
   TS-private fixture constants, `DerivedThreadOptions: Default`, and the
   invented fixture shape helper are gone. Find any other invented API,
   default, widened string, duplicate type, or dead keepalive.
6. Test fidelity: exact dangling-command bytes; full assistant-part equality;
   strict unknown-field rejection for golden/session shapes; panic-safe
   serialization of every process-global hook user in both affected test
   binaries; corrected boundary/PI/golden/snapshot/cleanup assertions.
   Confirm exactly 101 tests and two matching ignored bodies.
7. Ledger is honest about both initial FAILs, repair decisions, overrides,
   gate deltas, and remaining Phase 2 limitations; it must not call Wave 6
   certified before this review.
8. Run `cargo fmt --check`, `cargo check --tests`, and
   `python3 scripts/check_gate.py`. Reconcile all counts and inspect every
   allowlisted pass. Byte-compare all seven immutable asset pairs.
9. Use isolated temporary mutation/probes to prove strict unexpected-key
   rejection, one fractional visibility/threshold representation path, and
   hook serialization where practical. Never mutate the working tree. You
   own cleanup of only the exact temporary paths you create; list and verify
   them.
10. Confirm `/tmp/w6-ts-surface.txt` and `/tmp/w6-rs-surface.txt` are absent,
    but do not delete them yourself if they are not.

Report `VERDICT: PASS` or `VERDICT: FAIL`; numbered findings with severity,
Rust file:line, TS file:line, and exact fix; verbatim gate output; test and
asset reconciliation; mutation evidence; fully walked vs sampled coverage;
and exact temporary cleanup. Do not pad with speculative findings.
