You are the GPT-5.6 Sol targeted re-verifier for Wave 3 repair round 1.
READ ONLY: do not edit/delete/clean/stage/commit/push. Worktree
`/srv/work/long-horizon-context`, base `5b8e5bd`. Do not read Fable's report.

Read the brief, ledger, `fix1-wave3.md`, current full diff, exact TS, and your
prior Wave 3 findings. Confirm every adjudicated repair, including collateral
changes to Wave 2 idempotency, fixture tests, and trybuild stderr:

1. All functions containing `todo!("phase 2")` have exact-only bodies;
   intake wrappers are exact todo. The new gate scanner is brace/string/comment
   aware, detects prelude/trailing/nested disguises, avoids false positives,
   scans all Rust sources, and has mutation-sensitive always-run self-tests.
2. Invented thread-internal and CascadeClear re-exports/anchor are gone;
   lifecycle private builders/constants are private and not index-re-exported.
3. EventRecord is a complete nine-variant closed tagged union with exact
   kind→payload coupling, required read fields, empty turn_end payload, no broad
   flatten escape. Accessors and all adjusted Wave 2/3 tests retain TS
   strictness. Mutation-test every variant family/closedness path in isolation.
4. Validation schema structs deny unknown fields and layer-2 missing payload
   preserves TS precedence; private stand-ins are exact-todo/type-only and
   ledgered.
5. LifecycleOptions contains the lifetime-coupled async checkpoint callback,
   optional fresh-sdk flag, exhaustive checkpoint mapping, inference/guards;
   fixed clock contract is exact and epoch-correct; TS-private symbols are not
   exposed; extra assertion removed; SHA comment corrected; both timeouts
   present.
6. TempStore Drop is panic-safe/idempotent; proof is non-vacuous and narrowly
   allowlisted. Confirm no historical `/tmp` cleanup occurred and no unrelated
   file was touched.
7. Intake count and ISO calendar assertions are no weaker than TS.
8. SDK/root exports include MutationResult plus EventRecord, ThreadFileInfo,
   token exports; ledger is honest.
9. Confirm the two explicit orchestrator adjudications are accurately ledgered
   and do not mask a defect: transactional DDL substitutes for consuming a
   borrowed `Db`, and Rust per-test lifecycle baselines preserve same-store
   replay/teardown semantics with fixed clock rather than Vitest beforeAll.
10. Recount five Wave 3 suites plus changed idempotency/fixtures/trybuild
    coverage; check all assertions touched and allowlist exactness.

Run fmt, cargo check --tests, gate, prompt checker, git diff --check, and scope
status. Use Python `-B`. Perform mutations only in an isolated copy; never the
shared worktree.

Return numbered findings with file:line if any. End with explicit
`VERDICT: PASS` or `VERDICT: FAIL`, verbatim checks/counts, mutation evidence,
and full-reviewed vs skimmed coverage note.
