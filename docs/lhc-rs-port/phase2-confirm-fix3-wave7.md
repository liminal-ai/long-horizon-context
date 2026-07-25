# Wave 7 Amendment J changed-scope confirmation

READ-ONLY. Do not edit/commit/push. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, after Cursor
repair-r3. Baseline remains certified Wave 6 `a0434bc`.

Full Wave 7 audits:

- Sol `20260725-054823-a112a9`: FAIL only because drain-runner had no
  executable Cargo target; all other scope passed.
- Copilot-Fable `20260725-054823-f951dd`: initially PASS; focused
  adjudication `20260725-061935-a4dcca` independently reproduced the missing
  target and changed the item to **FORCED REPAIR**, while proving the exact
  example-wrapper shape in isolation.

Verify the actual shared-tree repair, not the prior disposable feasibility
copy. Read repair-r3 prompt/report, Amendment J ledger entry, TS/Rust
drain-runner, new example wrapper, Cargo metadata, and the diff since
repair-r2. Do not reopen already-passed Wave 7 scope except to ensure repair-r3
did not alter it.

## Required checks

1. `packages/lhc-rs/examples/drain_runner.rs` is the auto-discovered example
   target and contains only the narrow fixture-module include + entry call.
   No Cargo manifest entry, library export, host/Phase3 code, duplicated
   runner behavior, or alternate serializer.
2. `tests/fixtures/drain_runner.rs::process_main` is only `pub(crate)` (or
   equivalently fixture-crate-only), not a library or fixture-barrel export;
   every other helper remains private.
3. Build and spawn the committed example itself. Prove real-process:
   missing/invalid config, `leaseMs:0` construction panic, polling-time panic
   in isolated mutation, success `DRAIN_DONE`, and in-flight
   `claimExpiresAt` order. Require the common stderr prefix/exit 1 and no
   unlabelled panic.
4. Remove/rename the wrapper in an isolated copy and prove the executable
   target/process check turns RED. Restore and clean scratch.
5. `cargo metadata` identifies the exact example path. The library/root/shared
   exports and fixture barrel are unchanged.
6. Amendment J accurately records the forced TS top-level execution evidence,
   both verifier run IDs, exact narrow repair, unchanged 481/15/496
   denominator, and why no persisted-byte oracle is added.
7. No counted tests/assertions, manifests, TS, goldens, or oracles changed;
   allowlist remains absent; no probe residue/root-file drift.

Run fmt/check/clippy-all-targets, prompt bytes, JS-JSON, the default and serial
full gates. Required twice:

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
GATE PASS
```

Return numbered findings, exact process evidence, metadata path, gates,
immutable/cleanup audit, and exactly `PASS` or `FAIL`. A PASS confirms only
Wave 7 changed scope; Phase 2 still awaits orchestrator certification and the
separate completion audit. Phase 3 remains the user-facing work.
