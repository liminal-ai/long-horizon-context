# Phase 2 Wave 2 repair-r2 targeted re-verification

Read-only verification in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Do not edit, commit, or push. Read `phase2-fix2-wave2.md`, the
complete repair-r2 diff, both prior re-verifier envelopes, TypeScript
authority, and the Phase-gate addendum.

This is not a broad fresh audit. Confirm every repair-r2 finding with the
specific adversarial paths that caused the Sol/Fable disagreement:

1. Barrier-control fired timer handoff so no observer can see a false-settled
   clear→schedule gap; race an old fired callback against a newer timer; force
   fire-before-handle-publication; check cancellation-at-deadline and epilogue
   poke. Verify callbacks/SQLite/clock/await remain outside the scheduler lock.
2. On a closed WAL-mode thread DB in a filesystem-read-only directory,
   `peek_thread_id` returns the ID and creates/modifies no main, WAL, SHM,
   journal, directory entry, size, bytes, or mtime. Also probe absent/malformed
   files. The binding repair brief's no-sidecar requirement wins over the
   prior claim that node:sqlite sidecars are acceptable.
3. Pin Node and Rust behavior for ordered, unvalidated migration payloads:
   minimal/incomplete derivations, null element, non-array derivations,
   fractional/default/string/unsupported `sourceVersion`, string/object
   operation, unknown-key and derivations-key order, rollback, and idempotence.
   Amendment B makes malformed runtime parity material.
4. Mutate each separator in both supported UTC timestamp forms and prove the
   parser rejects it while retaining valid-form, calendar, expiry-edge, and
   invalid/empty behavior.
5. Force success and panic through every Wave 2 fixture opener, especially
   `work_handlers` completion, and prove explicit close/finally behavior
   without assertion/data/callback-order changes.
6. Confirm the ledger no longer claims nonexistent persistent scheduler unit
   tests and reports only evidence actually produced. Confirm no new test
   changed the frozen 494 inventory.

Recheck the amendment invariants: borrowed transaction bags and no
`ptr::read`/`mem::forget`/duplicate ownership; ordered JS-JSON persisted bytes;
direct `.changes` consumers with no production `SELECT changes()`; no new
public API or rusqlite import outside storage.

Run fmt/check/clippy, affected focused suites, prompt and JS-JSON conformance,
and the full gate. Expected:

```text
classified=494 cargo-reported=494
passed=81 suspicious=0 notimpl=398 wrong=0 ignored=15
GATE PASS
```

Return PASS/FAIL with numbered file:line findings, TS/Node and mutation
evidence, exact gate output, coverage, immutable-test/oracle audit, scope, and
cleanup. PASS requires every listed adversarial path—not a proxy stress test—
to be green.
