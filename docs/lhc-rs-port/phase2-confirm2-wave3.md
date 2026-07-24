# Phase 2 Wave 3 repair-r2 focused confirmation

Independent read-only audit in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Do not edit, commit, push, or delete shared files. Use and
remove only a uniquely named external scratch directory.

Read the onboarding, Phase 2 brief, ledger, Wave 3 repair-r1/r2 briefs and
reports, and matching TS/SQLite behavior. Focus line-by-line on
`src/shared_tech/storage.rs::open_database_for_thread_validation`, its
`validate_thread_file` consumer, and cleanup/error taxonomy. Confirm the
repair against both prior failures:

- Copilot-Fable `20260724-221744-2866bc`: timestamp temp-root collision;
- Sol `20260724-221837-e6fe2b`: checkpoint between main and WAL copy causing
  false `thread_not_found` / missing schema.

The implementation now claims:

- PID + process-local atomic sequence, exclusive create, retry
  `AlreadyExists`;
- main/WAL/journal content-hash+length fingerprint before and after the copy,
  retrying a changed epoch up to 128 times;
- SHM deliberately omitted and rebuilt privately;
- exhaustion is storage failure, never thread-not-found;
- immutable `peek_thread_id` opener unchanged;
- zero source mutation and zero leaked temp roots.

Adversarially verify rather than accepting those claims:

1. Reproduce deterministic pre-existing-name collision and high-concurrency
   validation. No valid call may fail or share/delete another root.
2. Reproduce checkpoint-during-copy with the repair-r1 ordering forced to
   fail, then the repaired algorithm succeeding. Cover checkpoint before,
   during, after; WAL append/reset/truncate; stable live and closed WAL.
3. Analyze and probe whether sequential before/after fingerprints actually
   guarantee a coherent copied epoch, including file appearance/disappearance,
   ABA-like changes, copy while append, partial WAL tail, rollback journal,
   and continuous churn. Distinguish theoretical hash collision from a
   behaviorally reproducible SQLite race. Flag any false accept/reject.
4. Confirm 128-retry exhaustion taxonomy and cleanup. Judge whether its
   contention behavior is a material divergence from direct TS read-only open.
5. Confirm omitting SHM is correct for a writable private directory opened
   `mode=ro`, and no stale SHM can be consumed.
6. Check every source/copy/open/query/close failure path for exact cleanup and
   caller-vs-storage classification. Inspect `clear_dir_files` error
   suppression for stale-file risk.
7. Confirm special-character and read-only paths, source bytes/size/mtime/mode/
   directory entries unchanged, and no leaked `lhc-thread-validate-*` roots.
8. Audit test-only seam/artifact hygiene. A retained cfg(test) seam with no
   owning committed test must be justified as required infrastructure or
   removed; do not accept disposable probe residue.

Run fmt/check, focused suites, and full gate. Expected:

```text
classified=496 cargo-reported=496
passed=145 suspicious=0 notimpl=336 wrong=0 ignored=15
GATE PASS
```

Return strict PASS/FAIL with numbered material findings, file:line,
reproduction and TS/SQLite consequence, exact gate, mutation/probe evidence,
review coverage, immutable assertion/fixture/oracle audit, and cleanup.
PASS requires no material validation race or cleanup residue.
