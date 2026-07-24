You are Fable 5, independent verifier for Wave 4 of the lhc-rs Phase 1 port.
READ ONLY: do not edit/delete/clean/stage/commit/push. Worktree
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, base `3868bef`.
Do not read Sol's report.

Read the binding brief, full ledger/rulings, `impl-wave4.md`, exact TS/Python
sources, and the complete diff/untracked Wave 4 files. Audit line-by-line:

1. Full messages public surface and all nine owning internals (store, project,
   handlers, cascade, derive, derivations, outcome, smoothing, work), plus
   module wiring. Confirm every export/private helper/signature/visibility,
   asyncness, required/optional field, closed vocabulary, serde spelling,
   canonical ownership, SQL/regex/map literal, and no invented surface.
2. Phase 1 exact-todo compliance for every behavior body/fixture, crate-wide
   scanner reconciliation, and no real behavior hidden in constants/type glue.
   Check allowed REAL constants/maps are exact and insertion ordered where TS
   observes order.
3. Every assertion and branch in all eight suites against TS:
   messages-read, mutations, mutations-delete, derivation-messages,
   smoothed-prompt-guards, smoothing-recovery,
   tool-result-summary-inference, turn-cascade. Verify counts, skipped full
   bodies/`#[ignore]`, strict structural equality, failure producers, SQL,
   and no silent-return/accessor weakening.
4. All fixture portions imported by these suites. Pure builders may be real;
   SDK-driving helpers must be exact todo. Check TempStore/seam cleanup remains
   panic-safe.
5. Later-wave thread_view/turns/SDK partials are minimal, faithful, required
   for collection, canonically owned, and honestly ledgered.
6. Gate/allowlist/ledger honesty: no new pass unless justified by exact name;
   every test outcome reconciles.

Run fmt, cargo check --tests, gate, prompt checker, git diff --check, and scope
status with Python `-B`. The four root `cc-lhc-*.txt` files are pre-existing
and must remain untouched.

For every meaningful coverage/invariant claim, mutate each named producer/path
in an isolated copy and show the relevant check fails. Never mutate the shared
worktree. If a property is inspection-only, narrow the claim explicitly.

Return numbered findings first with severity, file:line, TS evidence, and exact
correction. End with `VERDICT: PASS` or `VERDICT: FAIL`, verbatim checks,
expanded suite counts, mutation evidence, and fully-reviewed vs skimmed files.
