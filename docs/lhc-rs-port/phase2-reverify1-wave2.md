# Phase 2 Wave 2 repair-r1 changed-scope re-verification

Resume independent Wave 2 verification read-only in
`/srv/work/long-horizon-context`. Do not edit, commit, or push. Read
`phase2-fix1-wave2.md`, the entire repair-r1 diff, TypeScript authority, and
the updated Phase-gate addendum. The three Lee/Fable amendments are binding:

1. read/write transaction bags borrow the controller-owned `Db`;
2. migration payload is ordered unvalidated JSON with typed accessors;
3. final target is 494 total / 479 active / 15 ignored.

Re-test the complete prior finding union, not merely compilation:

- prove no `ptr::read`, `mem::forget`, duplicate-owning `Db`, or unsafe alias;
  HRTB callback borrowing, rollback/close ownership, and completion enqueue
  remain correct on success and panic;
- object- and string-shaped migration operations, unknown keys, key positions,
  absent/present derivations, version migrations, crash rollback, idempotence;
- barrier-controlled scheduler poke in the old lost-wake epilogue window;
  settled waiters, pending/running state, and follow-up pass;
- reentrant clock/poke callbacks with no mutex held;
- timer cancellation at deadline and stale generation versus newer timer;
- synchronous handler construction panic, polling panic, metadata lookup panic;
- read-only peek against a filesystem-read-only DB, with no sidecars/mutation;
- invalid calendar dates, leap years, null/empty timestamps, exact expiry edge;
- restored intake inline hook clears and finally-close fixture cleanup;
- exhaustive failure-kind matching;
- direct statement `.changes`, no production `SELECT changes()`, and all
  previously verified Wave 2 queue/durable/inference behavior.

Audit every repair-induced test edit. Only approved hygiene or unavoidable
type-lifetime alignment may change tests; assertions, data, and cases must
remain faithful.

Use disposable adversarial/mutation probes outside tracked tests and remove
them. Run fmt/check/clippy, affected focused suites, prompt/JSON conformance,
and the full gate. Expected arithmetic:

```text
classified=494 cargo-reported=494
passed=81 notimpl=398 ignored=15
wrong=0 suspicious=0
```

Return PASS/FAIL with numbered file:line findings, TS evidence, mutation
evidence, exact gate output, coverage, scope, and cleanup. PASS requires no
material Wave 2 defect.
