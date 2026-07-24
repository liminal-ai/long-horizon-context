# Phase 2 Wave 3 repair-r2 — validation-copy races

Resume Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`
with mandatory `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, on the current
uncommitted Wave 3 tree. Read the onboarding, Phase 2 brief, ledger, repair-r1
brief/report, and changed-scope confirmation brief. Do not commit or push.
Preserve the four unrelated root `cc-lhc-*.txt` files. Own and remove only
artifacts you create.

Repair-r1 confirmation is **FAIL** on two races in the new private validation
copy. This is an ordinary in-scope repair: it does not move the 496 inventory,
`145/336/0/15` Wave 3 gate, final `481/0/15`, wave plan, scope, or deliverable.
Do not stop for authorization. Do not broaden beyond the private validation
opener, its exact consumers/probes, and ledger report.

## Finding 1 — production temp-root collision

Copilot-Fable `20260724-221744-2866bc`, session
`0e18e4f5-d4cd-43c0-ab09-1eb7bc7f12c5`, model `claude-fable-5` medium,
reproduced duplicate `SystemTime::now().as_nanos()` values and false
`storage_failure("... File exists ...")` results from concurrent calls to
`open_database_for_thread_validation`.

Replace the timestamp-only name with PID plus a process-local atomic sequence
and exclusive `create_dir`, retrying only `AlreadyExists`, exactly at the
correctness boundary established by Amendment F. Other creation errors remain
storage failures. Cleanup remains scoped to the successfully owned directory.

Prove with a deterministic pre-existing-candidate collision and a high-
concurrency barrier: no valid thread is rejected, no two calls own one temp
root, and no temp root leaks on success or every error path. Do not rely on
clock resolution or probability.

## Finding 2 — torn main/WAL epoch

Sol `20260724-221837-e6fe2b`, session
`019f9635-8635-72e3-86f3-0da0157f1fc1`, reproduced a material false rejection:
while validation copied a 256 MiB main file, a live writer checkpointed the
valid schema from WAL into the original main and emptied/reset the WAL. The
private copy combined the old main with the post-checkpoint empty WAL, so
Rust returned caller-error/thread-not-found, `no lhc schema version`, although
the source was continuously a valid thread and direct Node read-only behavior
succeeds.

Make the private snapshot coherent across WAL/checkpoint epochs without
mutating the original main, WAL, SHM, journal, mode, mtime, or directory
entries and without weakening Wave 2's immutable `peek_thread_id` opener.
The implementation must be faithful under a live writer/checkpointer, not
merely reorder code until the current happy-path suite passes.

Choose the narrowest storage-private strategy supported by SQLite semantics.
Document the invariant that makes the snapshot coherent. In particular:

- do not claim independent main/WAL/SHM copies are atomic;
- do not silently accept a changed epoch;
- if stability detection/retry is used, retry a bounded or otherwise
  well-defined way and preserve TS-equivalent success under ordinary
  contention; exhaustion must not misclassify a valid stable source as
  thread-not-found;
- if file ordering is material, prove it across checkpoint-before, checkpoint-
  during, checkpoint-after, WAL append, WAL reset/truncate, and closed-WAL
  cases;
- do not copy or trust stale SHM state unless SQLite requires it; explain and
  prove the choice;
- malformed/foreign/unsupported files and genuine I/O failures retain the
  repair-r1 taxonomy.

Turn Sol's checkpoint schedule into a deterministic disposable regression
probe (scale the file only as needed to force the interleaving). Also probe
concurrent WAL append/checkpoint loops for repeated validation:

- zero false `thread_not_found` / `storage_failure` for a continuously valid
  source;
- valid schema/metadata always visible;
- original-byte/size/mtime/mode/directory-entry snapshot unchanged by each
  validation;
- no copied temp roots survive.

Mutate the coherence mechanism back to repair-r1 main-then-WAL independent
copy and show the deterministic probe fails, then restore byte-exactly.

## Required checks and report

Keep every other repair-r1 behavior unchanged. Run fmt/check/clippy, thread
and intake owning suites, thread migration, fixture proof, JS-JSON/prompt
checks, and full gate. Expected:

```text
classified=496 cargo-reported=496
passed=145 suspicious=0 notimpl=336 wrong=0 ignored=15
GATE PASS
```

Append a repair-r2 ledger note with both verifier run/session/model evidence,
exact coherence design and mutation evidence, collision evidence, source
immutability and cleanup evidence, exact gate, assertion/fixture/oracle audit,
and no commit/push. Keep Wave 3 **not certified** pending focused confirmation
of `open_database_for_thread_validation` and its validation consumer.
