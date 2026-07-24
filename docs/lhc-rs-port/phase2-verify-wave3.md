# Phase 2 Wave 3 full verification — threads and intake

Independent read-only audit in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Do not edit, commit, or push. Read the onboarding, Phase 2
brief, full ledger, Wave 3 implementation brief/report, the complete diff from
the certified Wave 2 commit, and every matching TypeScript source/test.

This is Wave 3 of 7, Phase 2 of 3, unit 11 of approximately 18. Audit every
changed line and all behavior newly reachable through the Wave 3 dependencies.

## Forced-amendment question — explicit ruling required

The implementation gate is currently `145 passed / 335 notimpl / 1 wrong /
15 ignored = 496`. The sole WRONG is
`work_execution::first_touch_catch_up_fails_an_expired_claimed_head_and_drains_the_item_behind_it`
at `tests/work_execution.rs:875`: after intake of `user_prompt` + `turn_end`,
Rust asserts `live_detail.len() == 1`.

The authoritative TS test at `packages/lhc/test/work-execution.test.ts:431-442`
does **not** assert length; it indexes `[0]` and checks only the claimed
message item. Its immediately preceding sibling test explicitly expects
`liveCount(filePath) == 2` after the same two-event intake. Live Node and Rust
both produce:

1. `w-m1-prompt_smoothing-v1` (then manually claimed);
2. `w-t1-turn_derivation-v1` (still queued).

Independently reproduce this. Return an explicit ruling whether deleting only
the extra Rust `assert_eq!(detail.len(), 1)` is a uniquely forced correction
to an unfaithful frozen-test assertion. Keep the `[0]` field/status/expiry
checks. This changes neither test count nor certification arithmetic; after
the correction the test should honestly reach its later Wave 7 `init_lhc`
boundary. Do not edit it yourself.

## Required audit

1. **Scope and immutable tests.** Test bodies, assertions, cases, test data,
   goldens, and oracles must be unchanged. Fixture changes require exact TS
   justification. Flag later-wave implementation, compatibility shims, widened
   public shapes, or test-shaped branches.
2. **Thread creation and cleanup.** Compare schema/SQL/metadata/timestamps/
   tokenizer/version bytes and transaction ordering side-by-side. Mutation
   probe failure at each file/schema/metadata/registry stage; confirm no
   orphan, partial registry entry, mutation of pre-existing caller files, or
   leaked handle.
3. **Read-only identity validation.** Probe foreign, malformed, missing,
   read-only, and WAL-mode candidates. Validation before writable open must
   create no WAL/SHM/journal/schema/pragma/byte/mtime side effect. Check path
   URI encoding and exact failure taxonomy.
4. **Registry and resolution.** Exercise default/explicit registry, thread-id
   and file-path refs, normalization, duplicate/upsert, ordering, missing
   registry/row/file, invalid closed refs, and storage errors. Compare exact
   `OpResult` class/code/reason and no truthiness substitution.
5. **Open and migration.** Version validation/migration/rollback and scheduler
   touch occur at TS-equivalent points. Re-run all five `thread_migrate`
   tests plus malformed ordered-payload probes from Wave 2; no regression in
   borrowed DB ownership or sidecar-free peek.
6. **Validation.** Probe every reachable envelope, event, and kind-payload
   branch against live Node/TS outputs. Exact `firstIssue` paths/messages,
   unknown/excess fields, server-generated fields, missing/null/array values,
   closed thread-ref alternatives, event index, and `turn_end` empty payload
   rule are material.
7. **Intake transaction.** Validate before write locking; process input order
   atomically; preserve dense event order, IDs/timestamps/version, results,
   thread position, message/turn materialization, idempotency skip behavior,
   work enqueue order, and JS-JSON persisted bytes. Inject failure after each
   mutation stage and prove complete rollback.
8. **Concurrency/hooks.** Reentrant walk/clock/scheduler callbacks must not
   deadlock or run under inappropriate locks. Poke/touch are post-commit and
   exact-count; rejected/rolled-back batches do not schedule work. Parallel
   tests remain isolated by the sanctioned guards and inline clears.
9. **Unlocked behavior.** Inspect every newly green exact test in direct Wave
   3 suites and previously blocked Wave 2 suites. A later-wave notimpl is
   acceptable only at its first real boundary; no catch/reroute may manufacture
   the classification.
10. **Direct cross-domain dependencies.** Audit every messages/turns body
    landed early to support intake materialization or newly reachable
    dispatch. It must be the exact TS body needed by Wave 3, not a broader
    Wave 4/5 implementation. In particular: no compatibility traits or dual
    access shapes; no test-name/kind-shaped `todo!` routing; remaining todos
    sit at the first real later-wave function; derivation metadata retains
    nested provenance on both message and turn reads; message dispatch derives
    behavior from the stored kind and distinguishes source-damaged /
    not-derivable / unsupported deferred outcomes; turn dispatch uses the
    shared handler path and canonical ISO-millisecond timestamps; bound-error
    reasons include the rejected value exactly as TS.
11. **Ledger and frozen contracts.** Counts, exact names, blocker ownership,
    disposable probe evidence, fixture status, shape addenda, `.changes`
    consumers, ordered bytes, no production `SELECT changes()`, and
    rusqlite-only-in-storage claims must all be true.

Use a uniquely named scratch directory containing your backend/session
identity for disposable adversarial/mutation probes; never mutate the shared
source tree. Remove only your own artifacts. For every broad invariant, mutate
every producer/path named by the claim.

Run fmt/check/clippy, all direct Wave 3 suites (`threads`, `threads_a8`,
`intake`, `intake_message_materialization`, `validation`),
`runtime_change_typing`, `lifecycle`, every newly unlocked Wave 2 suite,
prompt bytes, JS-JSON conformance, and the full gate. Reconcile against the
certified Wave 2 baseline `83 passed / 398 notimpl / 15 ignored = 496`:
`classified=cargo-reported=496`, `wrong=0`, `suspicious=0`, no regression,
and the exact newly green arithmetic recorded by the implementor. Final
Phase 2 target remains `481 passed / 0 notimpl / 15 ignored = 496`.

Return PASS/FAIL with numbered file:line findings, TS/Node evidence, mutation
evidence, exact suite/gate output, assertion/fixture/oracle audit, honest
line-by-line versus skimmed coverage, and cleanup. PASS requires no material
Wave 3 defect.
