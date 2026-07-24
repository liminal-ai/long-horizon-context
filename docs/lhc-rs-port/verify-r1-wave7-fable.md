# Wave 7 repair-r1 targeted verification — Fable

READ-ONLY. Do not edit, format, delete, clean, commit, or push. Repo
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Verify the current tree
after `docs/lhc-rs-port/fix1-wave7.md`, against TS authority under
`packages/lhc`. Read that repair report and both original verifier findings.

Re-review every file changed by repair-r1, not the already-clean Wave 7 test
body scope. Confirm every original Sol and Fable finding is actually closed:

1. All new SDK runtime behavior is exact `todo!("phase 2")`; only carrier
   construction, immutable constant data, and the recorded Wave 2 REAL wiring
   remain real. Reject invented helpers (specifically adjudicate whether
   `require_positive_i64` is necessary Rust-native shape or an invented
   duplicate). `merge_assignment` is absent.
2. `Lhc` carries stable private per-instance registration identity—no address
   key—and namespace carriers remain opaque/shared. Forwarding methods do not
   bypass the seam because they are exact todos.
3. Root/API closure is exact: 132 named TS SDK exports plus seven namespace
   values = 139. Carrier implementation types and inline argument bags are not
   root exports. Only canonical `work_kind_registry` maps TS
   `WORK_KIND_REGISTRY`. Explicitly adjudicate the `logging` namespace mapping:
   prove current Wave 0 module-tree representation supplies the TS root
   namespace, or report the precise missing root alias. Re-prove shared-tech
   126 names.
4. Fully diff `tests/fixtures/work_handlers.rs` against all 260 lines of TS,
   including private nested closures/types and exact signatures; confirm the
   fixtures barrel exports exactly `registerTestWorkHandlers`,
   `TestHandlerHooks`, and `testWorkHandlers`, not the non-barrel dispatcher.
5. Confirm `MultiStateClaim`, private thread helpers, static failure
   vocabulary, closed/total `InferenceDerivationType` assignment container,
   conversions at production validation boundaries, and the complete
   seam-conformance signatures. Review every repair-induced change in the
   earlier inference tests for assertion/ignored-body fidelity.
6. Confirm report-repair helper clock/return signatures and all 10 semantic
   tests remain faithful.
7. Confirm the view-report diagnostic is byte-exact and ledger current-state
   wording is honest.
8. Re-run fmt/check/gate/prompt/js-json. Expected exact-todo 513,
   classified/cargo 493, passed 40, notimpl 438, ignored 15,
   wrong/suspicious 0; no dependency or unrelated drift.
9. Confirm agent-owned `/tmp` cleanup is complete and root `cc-lhc-*.txt`
   remain untouched.

Report findings with severity and Rust/TS file:line. State reviewed-vs-skimmed
coverage. End with exactly `PASS` or `FAIL`.
