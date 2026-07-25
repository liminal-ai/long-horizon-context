# Phase 2 Wave 7 repair round 2 — runner containment and evidence residue

Resume Cursor session `0080ea30-39bd-48b7-a3e4-99738b18037e` with mandatory
`cursor-grok-4.5-high-fast` on the same uncommitted Wave 7 tree, baseline
Wave 6 `a0434bc`. Do not commit/push. Preserve the four root
`cc-lhc-*.txt` files and clean only this round's artifacts.

This is a focused follow-up before dual Wave 7 review. Keep all repair-r1
behavior and the exact `481/0/15` gate. Do not edit counted tests/assertions,
manifests, TS, goldens, or oracle fixtures.

## 1. Make drain-runner containment real and file-private

Repair-r1 left two confirmed mismatches in
`tests/fixtures/drain_runner.rs`:

- `run_protocol` and `process_main` are `pub`, although the TS module's
  `RunnerConfig`, `sleep`, and `main`/outer catch are file-private and the
  governing prompt explicitly forbids an invented public runner API.
- `run_protocol` catches only the `Result` returned by parse/stringify.
  `init_lhc`, handler registration, drain polling, callbacks, and transaction
  code can panic, and those panics currently bypass the claimed
  `drain-runner failed: ...` containment.

Make all runner entry/decomposition helpers private. Wrap polling of the whole
`run_protocol_inner` future with async `catch_unwind` (and construction if
separate) so both returned errors and Rust panic payloads reach the one outer
failure formatter, stderr prefix, and exit code 1. Preserve normal
`DRAIN_DONE` output and `report.ok ? 0 : 1`. Do not catch process termination
or invent a library surface.

In disposable same-module/process probes, prove:

- missing/invalid config failure prefix + code 1;
- a panic from SDK construction or from polling the inner async path is
  contained with `drain-runner failed: <detail>` + code 1, not an unlabelled
  panic;
- normal success output/order;
- the optional claim order remains
  `ran,stoppedBecause,remaining,claimExpiresAt`.

The probe may temporarily live beside the fixture only while running; remove
it before handoff.

## 2. Supply the missing public logging-write proof

Repair-r1 proved `query` and `query_derivation_log` through the public SDK but
described only an “identical boundary” for `write`. The required claim covers
all three public operations.

In an isolated disposable copy, inject a unique panic inside the future polled
by the real `LoggingSurface::write` transaction callback, then call the public
`sdk.logging.write`. Require:

```text
error_class=storage
code=storage_failure
reason="log write failed: <unique payload>"
```

This must go red if the `AssertUnwindSafe(...).catch_unwind().await` wrapper is
removed. Also show an ordinary non-panic `OpResult` error still passes through
without the prefix. Do not leave the mutation or add a counted test. Correct
the report/ledger from “identical boundary” to the exact public mutation proof.

## 3. Correct documentation residue and census wording

- `packages/lhc-rs/README.md` names a nonexistent
  `fixtures/derivation-order-cases.jsonl`; correct it to the committed
  `fixtures/derivation-json-order-cases.jsonl`.
- The repair report currently offers a generic Rust scanner's “227 both
  sides” as the export result while referring to the frozen shared-tech
  126-name census. Do not use 227 as a substitute for the certified
  methodology. Re-run/document the Phase 1 TS-aligned 126-name comparison, or
  state narrowly that the Wave 6→Wave 7 public delta is empty and leave the
  126-name proof to the independent verifier. Keep the factual conclusions:
  sync helper is not public and `Scheduler` has no public `Clone`.
- Correct report/ledger runner containment and logging evidence claims to the
  exact probes from this round. Keep **NOT CERTIFIED**.

## Evidence

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

Confirm the allowlist remains deleted, immutable hashes unchanged, no
non-fixture test/manifests changed, no disposable probe remains, and the root
files are untouched. Append repair-r2 to the existing Wave 7 report and
ledger. End with no commit/push and Wave 7 **NOT CERTIFIED**.
