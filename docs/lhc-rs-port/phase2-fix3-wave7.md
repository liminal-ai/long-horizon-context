# Phase 2 Wave 7 repair round 3 — deliver the spawnable drain runner

Resume Cursor session `0080ea30-39bd-48b7-a3e4-99738b18037e` with mandatory
`cursor-grok-4.5-high-fast` on the current uncommitted Wave 7 tree, baseline
Wave 6 `a0434bc`. Do not commit/push. Preserve the four root
`cc-lhc-*.txt` files and clean only this round's artifacts.

This is a single forced repair from dual independent review:

- Sol full audit `20260725-054823-a112a9`: FAIL, because the implemented
  drain-runner module had no committed executable target.
- Copilot-Fable full audit `20260725-054823-f951dd`: initially PASS, then
  focused adjudication `20260725-061935-a4dcca` changed that item to
  **FORCED REPAIR** after independently reproducing Sol's evidence and proving
  the narrow wrapper below in an isolated copy.

All other full-review scope passed. Keep repair-r1/r2 behavior and the exact
`481/0/15` gate. Do not edit counted tests/assertions, manifests, TS,
goldens, or oracle fixtures.

## Forced repair

The TS authority `packages/lhc/test/fixtures/drain-runner.ts:53` invokes
`main().catch(...)` at module top-level and is intrinsically spawnable.
Current Rust `tests/fixtures/drain_runner.rs` contains faithful logic but
`process_main()` has no committed caller; Cargo metadata exposes no executable
target. Disposable same-module probes do not deliver the fixture.

Apply the exact Rust-native shape already feasibility-proven by Fable:

1. Add auto-discovered example target
   `packages/lhc-rs/examples/drain_runner.rs`:

   ```rust
   #[path = "../tests/fixtures/mod.rs"]
   mod fixtures;

   fn main() {
       fixtures::drain_runner::process_main();
   }
   ```

   A short module comment may explain that this is the spawnable counterpart
   of the TS test fixture. Do not add Cargo manifest entries or include the
   target in the library surface.

2. Change only `tests/fixtures/drain_runner.rs::process_main` visibility from
   private to `pub(crate)`. This remains non-library-visible because fixtures
   are outside `src`; it is visible only to the example crate that path-includes
   the fixture module. Keep every other helper private. Do not re-export it
   from the fixture barrel.

3. Keep the already repaired runtime construction/async panic containment,
   ordered report value, stdout/stderr protocol, and exit arithmetic exactly
   intact.

## Record the forced shape

Append **Amendment J** to `PORT_STATUS.md`'s Phase-gate addendum:

- prior frozen representation compiled `drain_runner.rs` only as a private
  fixture module, leaving its `main` behavior unreachable;
- TS line 53 plus Cargo metadata uniquely require a spawnable counterpart;
- exact repair is an auto-discovered example wrapper + fixture-crate-only
  `pub(crate) process_main`;
- no library export, manifest, counted test, ignore, certification
  denominator, persisted/serialized shape, or Phase 3 surface changes;
- cite Sol `20260725-054823-a112a9` and Fable adjudication
  `20260725-061935-a4dcca`.

State that Amendment J must be named in the Wave 7 commit body. This is not a
persisted-byte amendment: it makes already verified bytes reachable but does
not change their producer/shape, so no new oracle fixture is warranted.

Update the Wave 7 report and ledger from NOT-CERTIFIED dual-review results:
both reviewers agree on this forced repair; Fable's original PASS changed to
FAIL-pending-repair on this item. Keep Wave 7 **NOT CERTIFIED** pending actual
changed-scope confirmation. Do not claim the example is verified merely from
the earlier disposable feasibility copy.

## Required real-target evidence

Build and spawn the committed example itself, not an in-module test harness:

```bash
cargo build --example drain_runner
```

Using unique disposable thread files/config, exercise the built executable
and record:

- missing config and invalid JSON: stderr `drain-runner failed: ...`, exit 1;
- real `leaseMs: 0` SDK-construction panic: same outer prefix, exit 1;
- polling-time panic injected only in an isolated/disposable copy: same outer
  prefix, exit 1;
- real empty-thread success: exact `DRAIN_DONE` stdout, exit 0;
- real in-flight/claim report: byte order
  `ran,stoppedBecause,remaining,claimExpiresAt`;
- no unlabelled panic output.

Show `cargo metadata` contains the example target and the committed wrapper is
its source path. Show the library/root/shared-tech export censuses are
unchanged and the fixture barrel adds no re-export.

Run:

```bash
cargo fmt --check
cargo check --tests
cargo clippy --all-targets
python3 -B scripts/check_prompt_bytes.py
cargo test --test js_json_conformance
python3 scripts/check_gate.py
RUST_TEST_THREADS=1 python3 scripts/check_gate.py
git diff --check
```

Required twice:

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
GATE PASS
```

Confirm allowlist remains absent, immutable hashes unchanged, no
non-fixture counted test/manifests changed, no disposable probe remains, and
root files are untouched. Append repair-r3 evidence to the report and ledger.
End with no commit/push and Wave 7 **NOT CERTIFIED**, ready for dual
changed-scope confirmation.
