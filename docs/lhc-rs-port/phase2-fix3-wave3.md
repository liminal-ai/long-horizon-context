# Phase 2 Wave 3 repair-r3 — focused confirmation residue

Resume Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`
with mandatory `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, on the current
uncommitted Wave 3 tree. Read the repair-r2 brief/report and focused Fable
confirmation `20260724-225434-38f854` (session
`f87ae00c-0643-43c4-a130-de37646e5215`, `claude-fable-5` medium).

Do not commit or push. Preserve the four unrelated root `cc-lhc-*.txt` files.
Own and remove only the exact artifacts named below. This repair does not move
inventory, gate arithmetic, wave plan, scope, or deliverable; do not stop for
authorization or broaden into cleanup.

The verifier **confirmed both repair-r2 races fixed**: exclusive temp roots
and stable main/WAL epoch copying pass adversarial checkpoint/collision
probes. Keep that algorithm unchanged except for removing its orphaned probe
seam.

## 1. Remove exact leaked implementor probe roots

The repair-r2 32-way barrier left exactly these empty directories:

```text
/tmp/lhc-thread-validate-2960379-0
...
/tmp/lhc-thread-validate-2960379-31
```

Resolve and verify that exact PID/prefix set, then remove only those 32
directories. Do not glob or remove any other process's validation directories.
Report the pre/post count and recoverability (disposable empty probe roots).
Correct the ledger's prior false “zero leaks / cleaned” statement.

## 2. Remove orphaned cfg(test) seam

Delete the unconsumed repair probe infrastructure from
`src/shared_tech/storage.rs`:

- the `validation_between_main_and_wal_seam()` call in the copy loop;
- `VALIDATION_BETWEEN_MAIN_AND_WAL`;
- `set_validation_between_main_and_wal_seam`;
- `validation_between_main_and_wal_seam`;
- related comments claiming the seam is retained.

Repo-wide search must find no consumer or definition. Do not add a permanent
test or alter the frozen 496 inventory; the deterministic disposable mutation
evidence is already recorded.

## 3. Map writable-open panic to TS storage failure

Fable reproduced a valid thread file chmod `0444` in a `0555` directory:
validation succeeds, then `open_thread_database` calls `open_database`;
`PRAGMA journal_mode = WAL` panics with “attempt to write a readonly
database,” escaping the public operation.

TS `openThreadDatabase` catches writable open/pragma failure and returns
`storageFailure("could not open thread file: …")`. Wrap the entire
`open_database(file_path)` invocation—including panic from its pragma
initialization—in `catch_unwind` and map it to the same existing
`storage_failure` prefix and underlying platform detail. Preserve an ordinary
`OpResult::Err` from `open_database` under the same prefix. Ensure any
partially created connection closes/drops; no panic escapes.

Use disposable probes for:

- valid read-only file/directory → structured SystemError/storage failure,
  exact code/prefix, no unwind;
- nonexistent/foreign/malformed/unsupported candidates retain their existing
  classifications;
- normal writable thread still opens/migrates/touches;
- mutation removing the new catch restores the panic and turns the probe red.

Do not invent a Node errno emulator and do not change validation-copy
taxonomy.

## Checks and report

Run fmt/check/clippy, direct Wave 3 suites, thread migration, fixture proof,
JS-JSON/prompt checks, and full gate. Expected:

```text
classified=496 cargo-reported=496
passed=145 suspicious=0 notimpl=336 wrong=0 ignored=15
GATE PASS
```

Append a repair-r3 ledger note with Fable evidence, the corrected cleanup
record, seam removal, read-only writable-open mutation evidence, exact gate,
assertion/fixture/oracle audit, and no commit/push. Keep Wave 3 **not
certified** pending final focused confirmation.
