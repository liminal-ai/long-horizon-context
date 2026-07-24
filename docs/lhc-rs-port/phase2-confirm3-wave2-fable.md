# Phase 2 Wave 2 repair-r3 focused Fable confirmation

Resume the Cursor-Fable verifier read-only in
`/srv/work/long-horizon-context`. Do not edit, commit, or push.

Your repair-r2 report `20260724-171653-fdb880` found one residual: fixed-width
numeric timestamp fields accepted a leading `+`. The orchestrator applied the
onboarding's trivial-residue repair directly in only:

- `src/shared_tech/work_queue/mod.rs`
- `src/shared_tech/scheduler.rs`

Both private parsers now call a digits-only helper before integer conversion.
Confirm the exact changed diff and rerun your Node/Rust matrix:

- `+` and `-` in year, month, day, hour, minute, second, and millis;
- a non-ASCII byte and an ASCII letter in each field;
- all valid boundary controls for both supported UTC forms;
- every fixed separator mutation, calendar rules, invalid/empty behavior,
  exact expiry edge, and scheduler timing oracle.

Mutation-proof both producer paths independently: weaken/remove the
digits-only guard in each parser and show its corresponding probe turns red.
Confirm no public/API/test/oracle/count change and no collateral behavior.

Run fmt/check, focused work-queue/scheduler evidence, and the exact gate:

```text
classified=494 cargo-reported=494
passed=81 suspicious=0 notimpl=398 wrong=0 ignored=15
GATE PASS
```

Return explicit PASS/FAIL with exact mutation results, gate, diff scope,
coverage, and cleanup. Remove only your disposable artifacts.
