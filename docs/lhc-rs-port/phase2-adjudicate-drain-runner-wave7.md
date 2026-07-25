# Wave 7 focused adjudication — is drain-runner actually delivered?

READ-ONLY. Do not edit/commit/push. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, on the current
uncommitted Wave 7 tree. Use Copilot Fable 5 medium.

Your original full Wave 7 verdict was PASS and accepted disposable same-module
probes for `tests/fixtures/drain_runner.rs`. Sol independently returned FAIL
with this single finding:

- `process_main()` is private and never called by any committed Rust target;
- `cargo metadata` exposes no drain-runner binary/example/executable target;
- `cargo run --bin drain_runner -- '{}'` reports no such target;
- no committed Rust test invokes `process_main`, `DRAIN_DONE`, or the outer
  protocol;
- TS `test/fixtures/drain-runner.ts` is a top-level executable module and
  actually invokes `main().catch(...)`.

Adjudicate this narrow disagreement from source and runtime evidence, not by
defending the prior verdict.

Read:

- TS/Rust drain-runner files in full;
- Phase 1/2 briefs and the fixture ledger row;
- `tests/work_execution.rs` and TS `work-execution.test.ts` comments about the
  unported cross-process legs;
- Cargo metadata/targets and all committed call sites.

Answer:

1. Is the current Rust artifact a faithful delivered counterpart of the TS
   spawnable fixture, or merely dead compiled module code?
2. Does Phase 2's frozen scope require a genuinely runnable target even though
   the cross-process parent suite is not in the 496-test inventory?
3. If repair is required, is a Cargo auto-discovered example wrapper the
   narrow faithful Rust-native solution—e.g. an `examples/drain_runner.rs`
   entry that path-includes only the required fixture modules and calls a
   non-library-visible `pub(crate)`/`pub(super)` runner entry—or would that
   invent unsupported packaging? State the exact preferred shape.
4. Prove whether that target can be built/spawned without changing the
   481/15/496 denominator, library exports, or fixture barrel.

You may use an isolated disposable copy to test the narrow wrapper shape, but
must clean it. Do not alter the shared repository.

Return exactly one of:

- `FORCED REPAIR` with the exact evidence and narrow target shape; or
- `SOL FINDING OVERRIDDEN` with the governing text/runtime evidence proving a
  non-executable private function is the intended completed artifact.

Also state whether your original PASS changes. Phase 3 remains out of scope.
