# Phase 2 Wave 7 full verification — final behavior wave

Independent read-only completion audit in `/srv/work/long-horizon-context`,
branch `lhc-rs-port`. Read all governing docs/rulings, ledger, Wave 7 report,
full diff from certified Wave 6, TS authority, and the earlier Rust Phase 1
`fix1-wave7.md` / `verify-r1-wave7-{sol,fable}.md` record. Re-test its
export, carrier-visibility, fixture-shape, diagnostic, and instance-isolation
findings without inheriting its obsolete Phase 1 arithmetic. Also read Python
`fix1-wave7.md` / `confirm-wave7.md` for the parallel export/protocol/privacy
failures. Do not edit/commit/push. Wave 7 of 7, Phase 2 of 3, unit 15 of ~18;
Phase 3 still remains.

1. Immutable tests/data/goldens/oracles; fixture edits exact TS-owned. Flag
   public reshapes, compatibility traits, hardcoding, test-shaped branches,
   Phase 3 code, wildcard vocab, or broadened finish line.
2. Audit full `init_lhc`/SDK construction and every namespace carrier:
   per-instance seams/registration, no identity collision/global bleed,
   manual/background scheduling, drains, settled waits, cancellation, close,
   errors, concurrency, callback lock freedom, panic containment.
   Specifically force polling-time callback/SQL/close panics through all three
   `LoggingSurface` operations and require structured `storage_failure` with
   exact TS prefixes (`log write failed:`, `log query failed:`,
   `derivation log query failed:`), while ordinary `OpResult` errors pass
   through unchanged.
   Re-run the Phase 1 132-named-export + seven namespace mapping census; reject
   root carrier leaks, `WORK_KIND_REGISTRY`, or invented `Default` impls.
   Re-prove the 126 shared-tech names and the canonical logging namespace
   mapping; fixture barrel still exposes only its exact TS counterparts.
   Reject a public sync-seam decomposition helper or public `Scheduler: Clone`;
   crate-private handle sharing is allowed.
3. Fully audit inspect health/overview/view report against TS and live
   nontrivial threads: exact grouping/counts/thresholds/reasons/text/repair
   suggestions/view bands and degraded/corrupt/queued/failed states.
4. Probe report-repair, epic flows, and lifecycle sequence/rollback/cleanup,
   frozen clock, exact persisted rows/bytes, and failure at every stage.
5. Sweep JS semantics and cross-wave carryover: JSON/order/numbers, ISO-ms,
   `??`, rounding, UTF-16, stable sort, empty min/max, provenance, abort,
   `.changes`, borrowed DB, sidecar-free reads. Re-probe the committed number
   oracle at `1e-6`, immediately below it, `1e-7`, signed/non-unit small
   exponents, the minimum subnormal, and reachable `±1e21` exponent spelling.
   Re-run Amendment I's fractional
   profile-number oracle end-to-end through SDK resolution, selection, stored
   config, receipt, describe, and inspect; reject any reintroduced coercion or
   local number formatter. Mutation-prove each producer independently.
   Re-probe lexical Node `path.resolve` parity and strict integer-domain
   corruption rejection at the final SDK boundary. Separately verify
   `classify_tool_result` inferred `summary.total` remains a JS `number` at
   `2^63` and other large/fractional/non-finite sums—never an `i64` saturation;
   TS assigns the `Number(...) + Number(...)` result directly. Also probe
   309+ digit explicit total/passed/failed and command-exit captures plus huge
   search line numbers: nested non-finite JS Numbers must remain ordered
   `null` fields, not disappear or become zero, and non-finite operands must
   propagate to an inferred `total: null`.
   Verify drain-runner output uses the runtime order
   `ran,stoppedBecause,remaining[,claimExpiresAt]` and that its outer failure
   protocol emits `drain-runner failed: <detail>` on stderr with exit 1.
6. Confirm zero production or fixture-body `todo!("phase 2")`, no disguised
   panic/reroute, no serialization/rusqlite/SQL tripwire violation, and every
   public method/SDK-driving fixture reaches real behavior.
7. Audit all 15 ignores one-for-one against TS `it.skip`, the 481 active test
   denominator, and final gate logic. At zero real Phase-2 todos the gate must
   require every non-ignored test to pass with exact `481/0/15`, while retaining
   all serialization/storage/todo/reconciliation tripwires; the transitional
   allowlist file must be absent, not merely ignored in final mode. Reintroduce
   a nonempty allowlist only in an isolated copy and require final mode to
   reject it; retain and mutation-prove exact duplicate parsing.
8. Hash prompts, JSON/date oracles, and all goldens; verify ledger/README
   truthfully say Wave 7 behavior is locally complete but NOT CERTIFIED until
   this dual review and the orchestrator audit finish. They must still say
   Phase 3 Grok Build integration is the user-facing work remaining.
   Confirm crate-wide `#![allow(dead_code)]` and stale crate-level “Phase 1
   skeleton” text are gone without a replacement broad suppression.

Use unique backend/session scratch and isolated temporary copies for
mutations. Never create a probe suite or mutate source in the shared
repository; clean only your artifacts and mutation-proof every named
producer/path.

The six directly owned suites collect 45 cases: `epic_fix_02` 6
(5 active + 1 ignored), `epic_fix` 9, health 5, overview 9, view 6, and
report-repair 10. Reconcile them, but do not mistake that subtotal for the
many prior-wave cases that `init_lhc` must unlock.

Run full tests/gate under default parallelism and `RUST_TEST_THREADS=1`, plus
fmt/check/clippy, prompt/date/JS-JSON/golden checks. Required twice:

```text
classified=496 cargo-reported=496
passed=481 notimpl=0 ignored=15
wrong=0 suspicious=0
GATE PASS
```

Return PASS/FAIL with numbered file:line findings, runtime/mutation evidence,
both gates, zero-todo and skip audits, hashes, immutable scope, honest
coverage, cleanup. PASS requires the Phase 2 done-definition in full.
