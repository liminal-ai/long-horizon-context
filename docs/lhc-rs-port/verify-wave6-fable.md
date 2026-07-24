You are the INDEPENDENT FABLE VERIFIER for Wave 6 of the lhc-rs Phase 1
port — thread-view, the largest Phase 1 wave. VERIFICATION ONLY: do not edit,
commit, push, or delete repository files. Repo
`/srv/work/long-horizon-context`, branch `lhc-rs-port`; audit all uncommitted
changes against baseline commit `c083f4d`.

Read `docs/lhc-rs-port-phase1-brief.md`,
`docs/lhc-rs-port/impl-wave6.md`, the binding Rust ledger, the complete TS
source/tests, and `docs/lhc-py-port/fix1-wave6.md`. TS is authoritative.
The Python findings are a checklist of already-known traps, not permission to
copy Python approximations.

Audit the full changed scope, not just compilation:

1. Source inventory: `thread_view/mod.rs` has the complete `index.ts`
   surface and all ten internal modules contain every export/private helper
   with exact Rust-native signatures. Every behavior body is exactly
   `todo!("phase 2")`; types/constants/profile tables are real. Detect
   invented APIs, widened strings, invented defaults/`Default`, duplicate
   lookalike types, integer narrowing of TS numbers, non-exhaustive closed
   mappings, wrong serde tags/renames/optional omission, and plain serde JSON
   serialization.
2. Constant/persisted fidelity: compare profiles, SQL, hook/format strings,
   render labels, regexes, and discriminants byte-for-byte/order-for-order
   with TS. Confirm `MaterializeResult` is canonical and abort semantics are
   honestly described, not overclaimed.
3. Fixture/asset completeness: compare the entire TS surfaces of
   pi-session-format, view-boundary, view-seam, and view-thread, including
   private helpers/constants. Byte-compare both pi-session files, README, and
   all four `g*.json` goldens to TS; goldens must not be regenerated.
4. Test fidelity: 11 suites must map exactly 101 semantic TS tests
   (2+7+9+13+17+13+15+8+5+4+8). Walk every assertion in the four densest
   suites (`view_compact`, `view_compact_preview`,
   `view_llm_request_context`, `view_fixture`) and every assertion in both
   golden/target suites (`view_select_golden`, `view_render_targets`);
   compare the other suites structurally and sample at least three assertions
   each. Audit exact-vs-partial equality, array order/full lengths, negative
   assertions, null/optional semantics, regex-vs-substring errors,
   concurrency, throw placement, `??`, JSON/SQL bytes, and panic-safe hook
   reset/cleanup.
5. Ledger/gate honesty: no unrelated files; no unexplained dependency
   changes; no broad allowlist; every row/count/status accurate. Run
   `cargo fmt --check`, `cargo check --tests`, and
   `python3 scripts/check_gate.py`; reconcile exact todo/collected/classified
   counts against baseline and the 101-test delta.
6. Adversarial evidence: for any claimed real serde/profile/asset invariant,
   use isolated temporary mutation copies or tiny probes to demonstrate that
   the relevant test/check would go red if tag, key omission, order, or bytes
   drifted. Never mutate the working tree. You own cleanup of only the exact
   temporary paths you create; list them.

Pay special attention to what a compile-oriented review misses: weakened
assertions in long tests, fixture helpers omitted because they are not yet
called, map/JSON stand-ins for declared shapes, false exact-equality claims,
golden tests whose expected data is duplicated instead of read, global hook
state that survives a panic, and required TS fields made optional merely to
ease Rust construction.

Report `VERDICT: PASS` or `VERDICT: FAIL`; numbered findings with severity,
Rust file:line, TS file:line, and exact expected fix; gate output verbatim;
test-count and asset-byte results; mutation evidence; an honest coverage note
listing fully walked vs sampled files; and exact temporary cleanup. Do not pad
with speculative findings.
