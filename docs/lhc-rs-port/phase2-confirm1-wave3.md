# Phase 2 Wave 3 repair-r1 changed-scope confirmation

Independent **read-only** verification in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Do not edit, commit,
push, or delete shared files. Use a uniquely named external scratch directory
for any probes and remove only your own artifacts.

Read the onboarding, Phase 2 brief, full `PORT_STATUS.md`, Wave 3
implementation/full-verification briefs, and
`docs/lhc-rs-port/phase2-fix1-wave3.md`. Inspect the actual current diff
against certified Wave 2 commit `f1326d7`, but focus confirmation on the
repair-r1 changed scope and its interaction with the full Wave 3 behavior.
Do not rely on the implementor's report as proof.

This is Wave 3 of 7, Phase 2 of 3, unit 11 of approximately 18. Final binding
gate remains `481 passed / 0 notimpl / 15 ignored = 496`; repair-r1 expects
`145 / 336 / 15 = 496`.

## Confirm or reject each repair

1. **Amendment E:** only the unfaithful
   `assert_eq!(detail.len(), 1)` was deleted from the named work-execution
   test. TS/live runtime require two items; all `[0]` field/status/expiry
   assertions remain; test now reaches the honest Wave 7 `init_lhc` todo.
   No count/arithmetic change.
2. **Amendment F:** `TempStore` allocation has TS `mkdtempSync` semantics at
   the correctness boundary—exclusive atomic create, retry on collision,
   never adopt existing. Its proof is deterministic and cleanup cannot delete
   another live store. No inventory change.
3. **Reentrant intake hook:** no `RefCell` borrow is held across callback
   execution. Independently exercise self-clear, self-replacement, and nested
   intake, and confirm transaction/callback ordering remains TS-faithful.
4. **WAL-aware validation:** valid live-WAL and closed-WAL candidates are
   recognized, without weakening immutable `peek_thread_id`. Audit the private
   copy/open strategy adversarially:
   - consistency while a WAL connection is live;
   - main/WAL/SHM/journal copy completeness and SQLite recovery behavior;
   - concurrent validations and temporary-name collisions;
   - cleanup on every copy/open/query/close panic/error;
   - special paths, malformed/foreign files, read-only files/directories;
   - zero original byte/size/mtime/mode/directory-entry mutation.
   Compare against TS `DatabaseSync(path,{readOnly:true})`, and flag any
   behaviorally material false acceptance/rejection or race.
5. **Deferred error mapping/close:** failures at open, schema-version query,
   sqlite_master query, metadata query, and close have exact TS
   caller/storage taxonomy. `"not a database"` deferred to query maps to
   thread-not-found; close never masks the primary result; no panic escapes.
6. **Allowlist:** all 62 Wave 3 greens are exact names, no Wave 3 suite globs
   remain in the executable allowlist or governing ledger claim. An invented
   same-suite name must not match. Arithmetic is truly +62 from Wave 2.
7. **Closed enum:** `EventKind` dispatch is exhaustive with no wildcard and
   all kinds retain exact materialization behavior.
8. **Adjudications:** no Node errno-string emulator is appropriate because
   each runtime propagates platform-native detail; the below-SDK TLS
   poke/touch issue is explicitly carried to Wave 7 and has not been silently
   expanded now.

Pay special attention to whether the validation-copy implementation itself
introduces a new collision/race or observably changes error taxonomy. Mutation
probe every producer/path behind a broad invariant; do not accept tests that
only exercise one happy path.

Run fmt/check, the affected direct suites, fixture proof, thread migration,
JS-JSON/prompt checks as relevant, and the full gate. Raw later-wave `todo!`
panics are expected only at their recorded first boundary; reconcile via the
gate. Audit immutable tests/fixtures/oracles: only approved E/F changes are
allowed.

Return a strict **PASS** or **FAIL**. Number every material finding with
file:line, TS/runtime evidence, reproduction, and consequence. Report exact
gate output, mutation evidence, files reviewed line-by-line versus skimmed,
assertion/fixture/oracle audit, and scratch cleanup. PASS requires no material
Wave 3 repair defect.
